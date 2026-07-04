// Tests for resolveRunAttach — the `realm agent --run-id` pre-attach semantics (v4):
// extensions_load_failed written ONLY pre-execution, re-attach clears exactly that reason,
// every other terminal reason keeps today's refusal.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import type { WorkflowDefinition, EvidenceSnapshot } from '@sensigo/realm';
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
