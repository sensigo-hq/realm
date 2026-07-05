// Tests for resolveRunAttach — the `realm agent --run-id` pre-attach semantics (v4):
// extensions_load_failed written ONLY pre-execution, re-attach clears exactly that reason,
// every other terminal reason keeps today's refusal.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import type { WorkflowDefinition, EvidenceSnapshot, ExtensionIdentityEntry } from '@sensigo/realm';
import { resolveRunAttach, EXTENSIONS_LOAD_FAILED } from './run-attach.js';
import type { loadProjectExtensions } from '../extensions/load-project-extensions.js';

const DEFINITION: WorkflowDefinition = {
  id: 'attach-wf',
  name: 'Attach WF',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { s1: { description: 'step', execution: 'agent' } },
  origin: 'human',
};

function makeWorkflowStore(): { get: (id: string) => Promise<WorkflowDefinition> } {
  return { get: async () => DEFINITION };
}

function okLoader(): typeof loadProjectExtensions {
  return vi.fn(async () => ({
    registry: createDefaultRegistry(),
    manifest: { modules: [], adapters: [], handlers: [], processors: [] },
  })) as unknown as typeof loadProjectExtensions;
}

function brokenLoader(): typeof loadProjectExtensions {
  return vi.fn(async () => {
    throw new Error('broken extension module');
  }) as unknown as typeof loadProjectExtensions;
}

async function createRun(store: InMemoryStore): Promise<string> {
  const { run } = await store.create({ workflowId: 'attach-wf', workflowVersion: 1, params: {} });
  return run.id;
}

const FAKE_EVIDENCE = {
  step_id: 's1',
  status: 'success',
  kind: 'step',
  evidence_hash: 'abc',
  duration_ms: 1,
  output_summary: {},
} as unknown as EvidenceSnapshot;

describe('resolveRunAttach', () => {
  it('happy path: returns definition + registry and leaves the run untouched', async () => {
    const store = new InMemoryStore();
    const runId = await createRun(store);
    const result = await resolveRunAttach(runId, {
      store,
      workflowStore: makeWorkflowStore(),
      loadExtensions: okLoader(),
    });
    expect(result.definition.id).toBe('attach-wf');
    expect(result.registry.getAdapter('filesystem')).toBeDefined();
    const run = await store.get(runId);
    expect(run.terminal_state).toBe(false);
  });

  it('load failure on a NOT-yet-started run writes terminal_reason extensions_load_failed and rethrows', async () => {
    const store = new InMemoryStore();
    const runId = await createRun(store);
    await expect(
      resolveRunAttach(runId, {
        store,
        workflowStore: makeWorkflowStore(),
        loadExtensions: brokenLoader(),
      }),
    ).rejects.toThrow('broken extension module');
    const run = await store.get(runId);
    expect(run.terminal_state).toBe(true);
    expect(run.terminal_reason).toBe(EXTENSIONS_LOAD_FAILED);
  });

  it('load failure on a run WITH evidence entries rethrows with NO run mutation', async () => {
    const store = new InMemoryStore();
    const runId = await createRun(store);
    const run = await store.get(runId);
    run.evidence = [FAKE_EVIDENCE];
    await store.update(run);
    const before = await store.get(runId);

    await expect(
      resolveRunAttach(runId, {
        store,
        workflowStore: makeWorkflowStore(),
        loadExtensions: brokenLoader(),
      }),
    ).rejects.toThrow('broken extension module');

    const after = await store.get(runId);
    expect(after.terminal_state).toBe(false);
    expect(after.terminal_reason).toBeUndefined();
    expect(after.version).toBe(before.version); // no write happened
  });

  it("re-attach on terminal_reason 'extensions_load_failed' clears exactly that marker and proceeds", async () => {
    const store = new InMemoryStore();
    const runId = await createRun(store);
    const run = await store.get(runId);
    run.terminal_state = true;
    run.terminal_reason = EXTENSIONS_LOAD_FAILED;
    await store.update(run);

    const result = await resolveRunAttach(runId, {
      store,
      workflowStore: makeWorkflowStore(),
      loadExtensions: okLoader(),
    });
    expect(result.definition.id).toBe('attach-wf');
    const cleared = await store.get(runId);
    expect(cleared.terminal_state).toBe(false);
    expect(cleared.terminal_reason).toBeUndefined();
    expect(cleared.run_phase).toBe('running');
  });

  it('every other terminal reason keeps the refusal — thrown BEFORE the loader runs', async () => {
    const store = new InMemoryStore();
    const runId = await createRun(store);
    const run = await store.get(runId);
    run.terminal_state = true;
    run.terminal_reason = 'spawn_failed';
    await store.update(run);

    const loader = okLoader();
    await expect(
      resolveRunAttach(runId, {
        store,
        workflowStore: makeWorkflowStore(),
        loadExtensions: loader,
      }),
    ).rejects.toThrow(`Run ${runId} is already in terminal state: spawn_failed`);
    expect(loader).not.toHaveBeenCalled();
    const untouched = await store.get(runId);
    expect(untouched.terminal_reason).toBe('spawn_failed');
  });

  it('a completed run is refused, not re-attached', async () => {
    const store = new InMemoryStore();
    const runId = await createRun(store);
    const run = await store.get(runId);
    run.terminal_state = true;
    run.terminal_reason = 'Workflow completed.';
    await store.update(run);

    await expect(
      resolveRunAttach(runId, {
        store,
        workflowStore: makeWorkflowStore(),
        loadExtensions: okLoader(),
      }),
    ).rejects.toThrow(/already in terminal state/);
  });
});

describe('resolveRunAttach — drift evidence (issue #119)', () => {
  function makeIdentity(treeHash: string): ExtensionIdentityEntry {
    return {
      captured_at: `2026-07-05T00:00:00.000Z`,
      modules: [
        {
          declared: './registry.js',
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
    };
  }

  function loaderWithIdentity(treeHash: string): typeof loadProjectExtensions {
    return vi.fn(async () => {
      const registry = createDefaultRegistry();
      registry.setIdentity(makeIdentity(treeHash));
      return {
        registry,
        manifest: { modules: [], adapters: [], handlers: [], processors: [] },
      };
    }) as unknown as typeof loadProjectExtensions;
  }

  async function seedIdentityHistory(store: InMemoryStore, runId: string, treeHash: string) {
    const run = await store.get(runId);
    run.extension_identity = [makeIdentity(treeHash)];
    await store.update(run);
  }

  it('WARNs on stderr when the fresh identity differs from the last recorded one — with NO pre-claim write', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new InMemoryStore();
    const runId = await createRun(store);
    await seedIdentityHistory(store, runId, 'hash-old');
    const before = await store.get(runId);

    await resolveRunAttach(runId, {
      store,
      workflowStore: makeWorkflowStore(),
      loadExtensions: loaderWithIdentity('hash-new'),
    });

    const logged = errSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('extension code identity differs');
    expect(logged).toContain('hash-old');
    expect(logged).toContain('hash-new');
    // Success path writes NOTHING pre-claim (CAS bystander hazard): version unchanged.
    const after = await store.get(runId);
    expect(after.version).toBe(before.version);
    expect(after.extension_identity).toHaveLength(1);
    errSpy.mockRestore();
  });

  it('no WARN when identities match, and none when the run has no recorded history', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new InMemoryStore();
    const runId = await createRun(store);
    await resolveRunAttach(runId, {
      store,
      workflowStore: makeWorkflowStore(),
      loadExtensions: loaderWithIdentity('hash-a'),
    });
    await seedIdentityHistory(store, runId, 'hash-a');
    await resolveRunAttach(runId, {
      store,
      workflowStore: makeWorkflowStore(),
      loadExtensions: loaderWithIdentity('hash-a'),
    });
    const logged = errSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('extension code identity differs');
    errSpy.mockRestore();
  });

  it('the extensions_load_failed write includes an error identity entry (pre-execution only)', async () => {
    const store = new InMemoryStore();
    const runId = await createRun(store);
    await expect(
      resolveRunAttach(runId, {
        store,
        workflowStore: makeWorkflowStore(),
        loadExtensions: brokenLoader(),
      }),
    ).rejects.toThrow('broken extension module');
    const run = await store.get(runId);
    expect(run.terminal_reason).toBe(EXTENSIONS_LOAD_FAILED);
    expect(run.extension_identity).toHaveLength(1);
    expect(run.extension_identity![0]!.error).toContain(
      'extension load failed: broken extension module',
    );
  });

  it('in-flight load failure mutates nothing — no error identity entry either (deliberate asymmetry)', async () => {
    const store = new InMemoryStore();
    const runId = await createRun(store);
    const run = await store.get(runId);
    run.evidence = [FAKE_EVIDENCE];
    await store.update(run);

    await expect(
      resolveRunAttach(runId, {
        store,
        workflowStore: makeWorkflowStore(),
        loadExtensions: brokenLoader(),
      }),
    ).rejects.toThrow('broken extension module');
    const after = await store.get(runId);
    expect(after.terminal_state).toBe(false);
    expect(after.extension_identity).toBeUndefined();
  });
});
