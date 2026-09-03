import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonWorkflowStore, getWorkflowForRun } from './registrar.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { WorkflowRegistrar } from './registrar.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from './yaml-loader.js';

function makeDefinition(id: string, version = 1): WorkflowDefinition {
  return {
    id,
    name: `Workflow ${id}`,
    version,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      'step-one': {
        description: 'Only step',
        execution: 'auto',
      },
    },
  };
}

describe('JsonWorkflowStore', () => {
  let dir: string;
  let store: JsonWorkflowStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-wf-test-'));
    store = new JsonWorkflowStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('register + get by id returns the same definition', async () => {
    const def = makeDefinition('wf-one');
    await store.register(def);
    const retrieved = await store.get('wf-one');
    expect(retrieved.id).toBe('wf-one');
    expect(retrieved.version).toBe(1);
    expect(Object.keys(retrieved.steps)).toHaveLength(1);
  });

  it('get on unknown id throws WorkflowError', async () => {
    await expect(store.get('nonexistent')).rejects.toThrow(WorkflowError);
  });

  it('list returns all registered workflows', async () => {
    await store.register(makeDefinition('wf-a'));
    await store.register(makeDefinition('wf-b'));
    await store.register(makeDefinition('wf-c'));
    const all = await store.list();
    expect(all).toHaveLength(3);
    const ids = all.map((d) => d.id).sort();
    expect(ids).toEqual(['wf-a', 'wf-b', 'wf-c']);
  });

  it('re-registering same id overwrites previous', async () => {
    await store.register(makeDefinition('wf-one', 1));
    await store.register(makeDefinition('wf-one', 2));
    const retrieved = await store.get('wf-one');
    expect(retrieved.version).toBe(2);
  });

  it('get throws STATE_LEGACY_FORMAT when schema_version is missing', async () => {
    const stale = JSON.stringify({ id: 'wf-stale', name: 'Stale', version: 1, steps: {} });
    await writeFile(join(dir, 'wf-stale.json'), stale, 'utf8');
    await expect(store.get('wf-stale')).rejects.toMatchObject({
      code: 'STATE_LEGACY_FORMAT',
    });
  });

  it('get throws STATE_LEGACY_FORMAT when schema_version is outdated', async () => {
    const stale = JSON.stringify({
      id: 'wf-old',
      name: 'Old',
      version: 1,
      schema_version: 0,
      steps: {},
    });
    await writeFile(join(dir, 'wf-old.json'), stale, 'utf8');
    await expect(store.get('wf-old')).rejects.toMatchObject({
      code: 'STATE_LEGACY_FORMAT',
    });
  });

  it('T3 — structural guard: no raw writeFileSync of a registry file outside atomicWriteFile (issue #130)', async () => {
    // Anti-recurrence, same class as json-file-store.ts's T3: register() must route through the
    // shared atomicWriteFile helper, not a raw sync writer — a raw writeFileSync reintroduces a
    // torn read for a concurrent unlocked reader (get()/list()).
    const src = await readFile(new URL('./registrar.ts', import.meta.url), 'utf8');

    expect(src).not.toMatch(/writeFileSync\(/);
    expect(src).not.toMatch(/\bwriteFile\(/);
    expect(src).toContain("import { atomicWriteFile } from '../store/atomic-write.js';");

    const atomicIdx = [...src.matchAll(/\batomicWriteFile\(/g)];
    expect(atomicIdx).toHaveLength(1); // the one write path: register()
  });
});

describe('getWorkflowForRun (issue #456)', () => {
  let dir: string;
  let store: JsonWorkflowStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-wf-remedy-test-'));
    store = new JsonWorkflowStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('C14 happy path returns the definition (deep equality — a fresh parse per get, never the same object)', async () => {
    const def = makeDefinition('wf-one');
    await store.register(def);
    const result = await getWorkflowForRun(
      store,
      { workflow_id: 'wf-one' },
      { retryVerb: 're-attach' },
    );
    expect(result).toEqual(def);
  });

  it('C15 the wrapped throw preserves the CONTRACT — code, agentAction, retryable', async () => {
    await expect(
      getWorkflowForRun(store, { workflow_id: 'nonexistent' }, { retryVerb: 're-attach' }),
    ).rejects.toMatchObject({
      code: 'STATE_WORKFLOW_NOT_FOUND',
      agentAction: 'report_to_user',
      retryable: false,
    });
  });

  it('C13 a STATE_LEGACY_FORMAT throw passes through by IDENTITY, untouched (toBe, not message-only)', async () => {
    // A message-only check would pass under a rewrap-preserving-message mutant. Identity requires
    // HOLDING the exact thrown instance — the real store (this file's :68-88 legacy-FILE idiom)
    // mints its error internally and can't support toBe; that idiom stays below for the store's
    // OWN cells. Here: a get-only mock throwing a CAPTURED sentinel (the run-attach :403/:429
    // idiom).
    const legacy = new WorkflowError('This workflow was registered with an older version', {
      code: 'STATE_LEGACY_FORMAT',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
    });
    const mockStore: Pick<WorkflowRegistrar, 'get'> = {
      get: async () => {
        throw legacy;
      },
    };
    const err = await getWorkflowForRun(
      mockStore,
      { workflow_id: 'wf-one' },
      { retryVerb: 're-attach' },
    ).catch((e: unknown) => e);

    expect(err).toBe(legacy);
    expect((err as WorkflowError).message).not.toContain('most often');
  });
});
