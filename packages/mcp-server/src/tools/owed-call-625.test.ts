// owed-call-625.test.ts — issue #625 PR-2a, the MCP side of the owed call: decision C1 (a deduped
// start_run runs nothing), C10 (start_run's derived phase), the advance_owed status word and the
// summary's `engine_runnable` / `pending_guards`, C8 (get_run_state judges the capability check with
// the server's registry), and start_run_batch's per-entry next_actions.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleStartRun } from './start-run.js';
import { handleStartRunBatch } from './start-run-batch.js';
import { handleGetRunState } from './get-run-state.js';
import { handleAdvanceRun } from './advance-run.js';

const owedDef: WorkflowDefinition = {
  id: 'owed-wf',
  name: 'owed',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    write: { description: 'Write.', execution: 'agent', depends_on: [] },
    after: { description: 'After.', execution: 'auto', depends_on: ['write'] },
    finish: { description: 'Finish.', execution: 'agent', depends_on: ['after'] },
  },
};

const headDef: WorkflowDefinition = {
  id: 'head-wf',
  name: 'head',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    head: { description: 'Head.', execution: 'auto', depends_on: [] },
    finish: { description: 'Finish.', execution: 'agent', depends_on: ['head'] },
  },
};

const handlerDef: WorkflowDefinition = {
  id: 'handler-wf',
  name: 'handler',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { enrich: { description: 'Enrich.', execution: 'auto', depends_on: [], handler: 'h' } },
};

describe('#625 PR-2a — the owed call over the MCP handlers', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-owed-625-'));
    runStore = new JsonFileStore(join(dir, 'runs'));
    workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    for (const d of [owedDef, headDef, handlerDef]) await workflowStore.register(d);
  });

  it('C1: a deduped start_run runs NOTHING — the owed step stays owed and the reply names the act', async () => {
    const first = await handleStartRun(
      { workflow_id: headDef.id, params: { a: 1 }, idempotency_key: 'k' },
      { runStore, workflowStore },
    );
    expect(first.deduped).toBe(false);
    expect(first.chained_auto_steps?.map((c) => c.step)).toEqual(['head']);
    // Make the run owe engine work again: a run whose head step is still owed.
    const { run } = await runStore.create({
      workflowId: owedDef.id,
      workflowVersion: 1,
      params: { a: 1 },
      idempotencyKey: 'k2',
    });
    const updated = await runStore.update({
      ...run,
      completed_steps: ['write'],
      evidence: [
        {
          step_id: 'write',
          started_at: run.created_at,
          completed_at: run.created_at,
          duration_ms: 0,
          input_summary: {},
          output_summary: {},
          status: 'success',
          evidence_hash: 'x',
        },
      ],
    });
    const deduped = await handleStartRun(
      { workflow_id: owedDef.id, params: { other: 2 }, idempotency_key: 'k2' },
      { runStore, workflowStore },
    );
    expect(deduped.deduped).toBe(true);
    expect(deduped.chained_auto_steps).toBeUndefined();
    expect((await runStore.get(run.id)).version).toBe(updated.version);
    expect((await runStore.get(run.id)).completed_steps).toEqual(['write']);
    expect(deduped.next_actions.map((a) => a.instruction?.tool)).toEqual(['advance_run']);
  });

  it("C10: start_run's chained reply reports the DERIVED phase", async () => {
    const r = await handleStartRun(
      { workflow_id: headDef.id, params: {} },
      { runStore, workflowStore },
    );
    expect(r.run_phase).toBe('running');
    expect(r.context_hint).toBe("Step 'head' completed. Ready for the agent: 'finish'.");
  });

  it('get_run_state: advance_owed, the act alone, and engine_runnable', async () => {
    const { run } = await runStore.create({
      workflowId: headDef.id,
      workflowVersion: 1,
      params: {},
    });
    const state = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('advance_owed');
    expect(state.next_actions.map((a) => a.instruction?.tool)).toEqual(['advance_run']);
    expect(state.engine_runnable).toEqual([{ step: 'head', runnable_here: true }]);
    expect(state.pending_guards).toBeUndefined();
  });

  it('C8: with the server registry, a capability refusal withdraws the act; with none it is unknown', async () => {
    const { run } = await runStore.create({
      workflowId: handlerDef.id,
      workflowVersion: 1,
      params: {},
    });
    const unknown = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    expect(unknown.engine_runnable).toEqual([{ step: 'enrich', runnable_here: 'unknown' }]);
    expect(unknown.next_actions_status).toBe('advance_owed');
    const refused = await handleGetRunState(
      { run_id: run.id },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    expect(refused.engine_runnable).toEqual([
      {
        step: 'enrich',
        runnable_here: false,
        refused_by: 'capability',
        refusal: "handler 'h' is not registered here",
      },
    ]);
    expect(refused.next_actions).toEqual([]);
    expect(refused.next_actions_status).toBe('ok');
    // A registry provider that throws falls back to none — never a new failure on a poll.
    const fallback = await handleGetRunState(
      { run_id: run.id },
      {
        runStore,
        workflowStore,
        registryProvider: async () => {
          throw new Error('extensions broken');
        },
      },
    );
    expect(fallback.engine_runnable?.[0]?.runnable_here).toBe('unknown');
  });

  it('start_run_batch: each started entry carries next_actions; no step runs', async () => {
    const batch = await handleStartRunBatch(
      { workflow_id: headDef.id, items: [{ params: {} }, { params: { b: 1 } }] },
      { runStore, workflowStore },
    );
    for (const entry of batch.started) {
      expect(entry.next_actions.map((a) => a.instruction?.tool)).toEqual(['advance_run']);
      expect((await runStore.get(entry.run_id)).completed_steps).toEqual([]);
    }
  });

  it("C25: advance_run's reply ends with one clause per step another process claimed", async () => {
    const { run } = await runStore.create({
      workflowId: headDef.id,
      workflowVersion: 1,
      params: {},
    });
    const realClaim = runStore.claimStep.bind(runStore);
    let first = true;
    runStore.claimStep = async (...args: Parameters<JsonFileStore['claimStep']>) => {
      if (first) {
        first = false;
        await realClaim(args[0], args[1], args[2], {
          by: 'other@host',
          by_source: 'derived',
          channel: 'agent',
        });
      }
      return realClaim(...args);
    };
    const reply = await handleAdvanceRun({ run_id: run.id }, { runStore, workflowStore });
    expect(reply.chained_auto_steps).toBeUndefined();
    expect(reply.context_hint).toBe(
      `Run '${run.id}': nothing ran. No step is ready. 'head' was claimed by another process, so it did not run here.`,
    );
  });

  it('advance_run: continued_by is the absent form when the host passed no driver', async () => {
    const { run } = await runStore.create({
      workflowId: headDef.id,
      workflowVersion: 1,
      params: {},
    });
    const reply = await handleAdvanceRun({ run_id: run.id }, { runStore, workflowStore });
    expect(reply.continued_by).toEqual({ by: null, absent_cause: 'driver_not_recorded' });
    expect(reply.chained_auto_steps?.map((c) => c.step)).toEqual(['head']);
  });
});
