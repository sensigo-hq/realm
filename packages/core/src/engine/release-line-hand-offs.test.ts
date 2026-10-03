// issue #620 PR-C — the hand-offs (H2 + H3): every exported function that takes a store, and the
// two reader-backed trace buffers, refuse a store from another release (MISMATCH) or with no line
// (UNDECLARED) before any work, and accept this release's and a host class it declared.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeChain,
  executeStep,
  advanceRun,
  submitHumanResponse,
  drainFinalizers,
} from './execution-loop.js';
import { abandonRun } from './abandon-run.js';
import { reclaimStep } from './reclaim-step.js';
import { getWorkflowForRun } from '../workflow/registrar.js';
import { readRunForFence } from '../store/fence-predicate.js';
import { InMemoryTraceBufferStore } from '../store/trace-buffer-store.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { REALM_BRAND, RELEASE_LINE_KEY, createRealmBrand } from '../brand.js';
import { declareReleaseLine } from '../release-line.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';

const OTHER = createRealmBrand('@sensigo/realm', '9.9.9', 'file:///tmp/other-realm/');
const V = REALM_BRAND.version;
const LOCAL_PATH = fileURLToPath(REALM_BRAND.url!).replace(/\/$/, '');
/** The noun a hand-off refusal's remedy takes from its role (issue #620 PR-C round 3). */
function nounOf(role: string): string {
  return /\bregistry\b/.test(role) ? 'registry' : /\breader\b/.test(role) ? 'reader' : 'store';
}

const def: WorkflowDefinition = {
  id: 'h-wf',
  name: 'H',
  version: 1,
  steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
};
const run = { id: 'r', workflow_id: 'h-wf' } as unknown as RunRecord;
const noop = async (): Promise<Record<string, unknown>> => ({});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-h-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A store whose methods all fail with a non-release-line error: proves the call got past the check. */
function storeLike(): Record<string, unknown> {
  const fail = async (): Promise<never> => {
    throw new Error('reached the store');
  };
  return { get: fail, create: fail, update: fail, claimStep: fail, settleStep: fail, list: fail };
}
function otherLine(): Record<string, unknown> {
  const s = storeLike();
  Object.defineProperty(s, RELEASE_LINE_KEY, { value: OTHER });
  return s;
}
function hostClass(): Record<string, unknown> {
  class TenantScopedRunStore {}
  declareReleaseLine(TenantScopedRunStore);
  return Object.assign(new TenantScopedRunStore(), storeLike());
}

// [name, the call, the role its refusal names]
const CALLS: Array<[string, (store: never) => Promise<unknown>, string]> = [
  ['abandonRun', (s) => abandonRun(s, 'r'), 'The run store handed to abandonRun'],
  ['reclaimStep', (s) => reclaimStep(s, 'r', 'a'), 'The run store handed to reclaimStep'],
  [
    'executeStep',
    (s) => executeStep(s, def, { runId: 'r', command: 'a', input: {}, dispatcher: noop }),
    'The run store handed to executeStep',
  ],
  [
    'submitHumanResponse',
    (s) => submitHumanResponse(s, def, { runId: 'r', gateId: 'g', choice: 'approve' } as never),
    'The run store handed to submitHumanResponse',
  ],
  [
    'drainFinalizers',
    (s) => drainFinalizers(s, def, undefined, 'r'),
    'The run store handed to drainFinalizers',
  ],
  [
    'advanceRun',
    (s) => advanceRun(s, def, { runId: 'r', command: 'a', input: {}, dispatcher: noop }),
    'The run store handed to advanceRun',
  ],
  [
    'executeChain',
    (s) => executeChain(s, def, { runId: 'r', command: 'a', input: {}, dispatcher: noop }),
    'The run store handed to executeChain',
  ],
  [
    'getWorkflowForRun',
    (s) => getWorkflowForRun(s, run, { retryVerb: 'retry', verb: 'retry' }),
    'The workflow store handed to getWorkflowForRun',
  ],
  [
    'readRunForFence',
    (s) => readRunForFence(s, 'r', { kind: 'run_absent' } as never),
    'The run reader handed to readRunForFence',
  ],
  [
    'InMemoryTraceBufferStore',
    async (s) => new InMemoryTraceBufferStore(s),
    'The run reader handed to InMemoryTraceBufferStore',
  ],
];

async function messageOf(p: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await p();
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

async function codeOf(p: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await p();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code ?? (err as Error).message;
  }
}

describe.each(CALLS)('%s', (_name, call, role) => {
  it('another release: ENGINE_RELEASE_LINE_MISMATCH before any work', async () => {
    expect(await codeOf(() => call(otherLine() as never))).toBe('ENGINE_RELEASE_LINE_MISMATCH');
  });
  it('another release: the whole message names this hand-off', async () => {
    expect(await messageOf(() => call(otherLine() as never))).toBe(
      `${role} (a plain object) belongs to realm 9.9.9 (/tmp/other-realm); this engine runs realm ${V} (${LOCAL_PATH}). Realm objects do not cross versions. Hand realm a ${nounOf(role)} from @sensigo/realm ${V}, or install every @sensigo package at one version (npm ls @sensigo/realm in the project, or npm ls -g @sensigo/realm for a global install, lists the copies).`,
    );
  });
  it('no line: ENGINE_RELEASE_LINE_UNDECLARED before any work', async () => {
    expect(await codeOf(() => call(storeLike() as never))).toBe('ENGINE_RELEASE_LINE_UNDECLARED');
  });
  it('no line: the whole message names this hand-off and the plain-object remedy (no realm-class sentence)', async () => {
    expect(await messageOf(() => call(storeLike() as never))).toBe(
      `${role} (a plain object) declares no realm release line. Realm identifies store errors by class, so every store it runs against must belong to the realm it runs on (${V}). Declare it once: declareReleaseLine(store), imported from the @sensigo/realm your store imports its errors from.`,
    );
  });
  it('a host class declared with declareReleaseLine: accepted', async () => {
    const code = await codeOf(() => call(hostClass() as never));
    expect(code ?? 'resolved').not.toMatch(/^ENGINE_RELEASE_LINE_/);
  });
  it('this release’s own store: accepted', async () => {
    const code = await codeOf(() => call(new JsonFileStore(dir) as never));
    expect(code ?? 'resolved').not.toMatch(/^ENGINE_RELEASE_LINE_/);
  });
});

describe('executeStep with an undeclared store throws instead of returning ENGINE_STORE_FAILED', () => {
  it('throws', async () => {
    await expect(
      executeStep(storeLike() as never, def, {
        runId: 'r',
        command: 'a',
        input: {},
        dispatcher: noop,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_RELEASE_LINE_UNDECLARED' });
  });
});

// [name, the call with a registry, the role its refusal names]
const REGISTRY_CALLS: Array<[string, (registry: never) => Promise<unknown>, string]> = [
  [
    'executeStep',
    (r) =>
      executeStep(new JsonFileStore(dir), def, {
        runId: 'r',
        command: 'a',
        input: {},
        dispatcher: noop,
        registry: r,
      }),
    'The registry handed to executeStep',
  ],
  [
    'submitHumanResponse',
    (r) =>
      submitHumanResponse(new JsonFileStore(dir), def, {
        runId: 'r',
        gateId: 'g',
        choice: 'approve',
        registry: r,
      } as never),
    'The registry handed to submitHumanResponse',
  ],
  [
    'drainFinalizers',
    (r) => drainFinalizers(new JsonFileStore(dir), def, r, 'r'),
    'The registry handed to drainFinalizers',
  ],
  [
    'advanceRun',
    (r) =>
      advanceRun(new JsonFileStore(dir), def, {
        runId: 'r',
        command: 'a',
        input: {},
        dispatcher: noop,
        registry: r,
      }),
    'The registry handed to advanceRun',
  ],
  [
    'executeChain',
    (r) =>
      executeChain(new JsonFileStore(dir), def, {
        runId: 'r',
        command: 'a',
        input: {},
        dispatcher: noop,
        registry: r,
      }),
    'The registry handed to executeChain',
  ],
];

describe.each(REGISTRY_CALLS)('%s: a registry of another release', (_name, call, role) => {
  it('is refused before any work, the whole message naming this hand-off', async () => {
    const reg = {};
    Object.defineProperty(reg, Symbol.for('@sensigo/realm/ExtensionRegistry'), { value: OTHER });
    expect(await messageOf(() => call(reg as never))).toBe(
      `${role} (class ExtensionRegistry) belongs to realm 9.9.9 (/tmp/other-realm); this engine runs realm ${V} (${LOCAL_PATH}). Realm objects do not cross versions. Hand realm a registry from @sensigo/realm ${V}, or install every @sensigo package at one version (npm ls @sensigo/realm in the project, or npm ls -g @sensigo/realm for a global install, lists the copies).`,
    );
  });
});

describe('registries', () => {
  it('a registry of another release is refused at executeChain', async () => {
    const reg = {};
    Object.defineProperty(reg, Symbol.for('@sensigo/realm/ExtensionRegistry'), { value: OTHER });
    const code = await codeOf(() =>
      executeChain(new JsonFileStore(dir), def, {
        runId: 'r',
        command: 'a',
        input: {},
        dispatcher: noop,
        registry: reg as never,
      }),
    );
    expect(code).toBe('ENGINE_RELEASE_LINE_MISMATCH');
  });
  it('a same-named non-realm registry class is accepted', async () => {
    class ExtensionRegistry {
      getHandler(): undefined {
        return undefined;
      }
    }
    const code = await codeOf(() =>
      executeChain(new JsonFileStore(dir), def, {
        runId: 'r',
        command: 'a',
        input: {},
        dispatcher: noop,
        registry: new ExtensionRegistry() as never,
      }),
    );
    expect(code ?? 'resolved').not.toMatch(/^ENGINE_RELEASE_LINE_/);
  });
  it('this release’s registry is accepted', async () => {
    const code = await codeOf(() =>
      executeChain(new JsonFileStore(dir), def, {
        runId: 'r',
        command: 'a',
        input: {},
        dispatcher: noop,
        registry: createDefaultRegistry(),
      }),
    );
    expect(code ?? 'resolved').not.toMatch(/^ENGINE_RELEASE_LINE_/);
  });
});
