// Tests for the execution loop's extension-identity lazy append-on-change site (issue #119):
// first execution appends exactly one entry; unchanged identity never duplicates; changed
// identity appends + surfaces an envelope advisory warn; CAS losers retry once then
// log-and-drop; extension-free runs never gain the field.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { ExtensionIdentityEntry } from '../types/extension-identity.js';
import type { RunRecord } from '../types/run-record.js';
import type { StepDispatcher } from './execution-loop.js';

const definition: WorkflowDefinition = {
  id: 'ident-wf',
  name: 'Identity WF',
  version: 1,
  steps: {
    'step-one': { description: 'First step', execution: 'agent', depends_on: [] },
    'step-two': { description: 'Second step', execution: 'agent', depends_on: ['step-one'] },
  },
};

const echoDispatcher: StepDispatcher = async (_step, input) => ({ ...input });

function makeIdentity(
  treeHash: string,
  overrides: Partial<ExtensionIdentityEntry> = {},
): ExtensionIdentityEntry {
  return {
    captured_at: '2026-07-05T00:00:00.000Z',
    pid: 4242,
    modules: [
      {
        declared: '../../dist/registry.js',
        resolved: '/proj/dist/registry.js',
        entry_hash: `entry-${treeHash}`,
        format: 'esm',
      },
    ],
    tree: {
      roots: ['/proj/dist'],
      rules: 'dir_tree_v1: test',
      file_count: 1,
      total_bytes: 10,
      tree_hash: treeHash,
      truncated: false,
    },
    coverage: 'dir_tree_v1',
    ...overrides,
  };
}

function registryWithIdentity(entry: ExtensionIdentityEntry): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.setIdentity(entry);
  return registry;
}

describe('execution loop — extension identity lazy append-on-change', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-ident-append-'));
    store = new JsonFileStore(dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createRun(): Promise<string> {
    const { run } = await store.create({ workflowId: 'ident-wf', workflowVersion: 1, params: {} });
    return run.id;
  }

  it('first execution appends exactly one entry (equal to the registry identity)', async () => {
    const runId = await createRun();
    const identity = makeIdentity('hash-a');
    const envelope = await executeStep(store, definition, {
      runId,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
      registry: registryWithIdentity(identity),
    });
    expect(envelope.status).toBe('ok');
    expect(envelope.warnings).toEqual([]); // first record is not a CHANGE — no advisory
    const run = await store.get(runId);
    expect(run.extension_identity).toEqual([identity]);
  });

  it('re-execution with the same identity appends NO duplicate (append-on-change)', async () => {
    const runId = await createRun();
    const registry = registryWithIdentity(makeIdentity('hash-a'));
    await executeStep(store, definition, {
      runId,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });
    await executeStep(store, definition, {
      runId,
      command: 'step-two',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });
    const run = await store.get(runId);
    expect(run.extension_identity).toHaveLength(1);
  });

  it('a CHANGED identity appends a second entry AND surfaces the envelope advisory warn', async () => {
    const runId = await createRun();
    await executeStep(store, definition, {
      runId,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
      registry: registryWithIdentity(makeIdentity('hash-a')),
    });
    const envelope = await executeStep(store, definition, {
      runId,
      command: 'step-two',
      input: {},
      dispatcher: echoDispatcher,
      registry: registryWithIdentity(makeIdentity('hash-b')),
    });
    expect(envelope.status).toBe('ok');
    expect(envelope.warnings).toContain(
      "extension code identity changed since this run's last recorded identity",
    );
    const run = await store.get(runId);
    expect(run.extension_identity).toHaveLength(2);
    expect(run.extension_identity![1]!.tree.tree_hash).toBe('hash-b');
  });

  it('an override-flag flip alone counts as a change', async () => {
    const runId = await createRun();
    await executeStep(store, definition, {
      runId,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
      registry: registryWithIdentity(makeIdentity('hash-a')),
    });
    await executeStep(store, definition, {
      runId,
      command: 'step-two',
      input: {},
      dispatcher: echoDispatcher,
      registry: registryWithIdentity(makeIdentity('hash-a', { override_active: true })),
    });
    const run = await store.get(runId);
    expect(run.extension_identity).toHaveLength(2);
  });

  it('idempotent create (created:false) reuses the run — same-identity execution still appends no dupes', async () => {
    const first = await store.create({
      workflowId: 'ident-wf',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'ident-key',
    });
    const second = await store.create({
      workflowId: 'ident-wf',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'ident-key',
    });
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);

    const registry = registryWithIdentity(makeIdentity('hash-a'));
    await executeStep(store, definition, {
      runId: first.run.id,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });
    await executeStep(store, definition, {
      runId: second.run.id,
      command: 'step-two',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });
    const run = await store.get(first.run.id);
    expect(run.extension_identity).toHaveLength(1);
  });

  it('extension-free run (no registry identity) → field absent entirely', async () => {
    const runId = await createRun();
    await executeStep(store, definition, {
      runId,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
      registry: new ExtensionRegistry(), // no identity attached
    });
    const run = await store.get(runId);
    expect(run.extension_identity).toBeUndefined();
    expect('extension_identity' in run).toBe(false);
  });

  it('CAS loser retries once and lands the append (simulated version bump between read and update)', async () => {
    const runId = await createRun();
    // Wrap the store: the FIRST update that grows extension_identity fails with the
    // version-conflict error; the retry (get → update) passes through.
    let failedOnce = false;
    const wrapped = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          return async (record: RunRecord) => {
            if (!failedOnce && record.extension_identity !== undefined) {
              failedOnce = true;
              throw new WorkflowError('Version conflict — run was modified by another process', {
                code: 'STATE_SNAPSHOT_MISMATCH',
                category: 'STATE',
                agentAction: 'report_to_user',
                retryable: true,
              });
            }
            return target.update(record);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const envelope = await executeStep(wrapped, definition, {
      runId,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
      registry: registryWithIdentity(makeIdentity('hash-a')),
    });
    expect(envelope.status).toBe('ok');
    expect(failedOnce).toBe(true);
    const run = await store.get(runId);
    expect(run.extension_identity).toHaveLength(1);
  });

  it('persistent CAS conflict → log-and-drop: step succeeds, no entry, stderr not silent', async () => {
    const runId = await createRun();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapped = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          return async (record: RunRecord) => {
            if (record.extension_identity !== undefined) {
              throw new WorkflowError('Version conflict — run was modified by another process', {
                code: 'STATE_SNAPSHOT_MISMATCH',
                category: 'STATE',
                agentAction: 'report_to_user',
                retryable: true,
              });
            }
            return target.update(record);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const envelope = await executeStep(wrapped, definition, {
      runId,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
      registry: registryWithIdentity(makeIdentity('hash-a')),
    });
    expect(envelope.status).toBe('ok'); // never fails the step
    const run = await store.get(runId);
    expect(run.extension_identity).toBeUndefined(); // dropped...
    const logged = errSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('extension identity append dropped'); // ...but never silently
  });
});
