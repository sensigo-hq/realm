// hand-back-625.test.ts — issue #625 PR-2a, decisions C64 and C65: every reply that hands back a run on
// which the call ran nothing says what comes next with ONE composer (`handBackHint`): `start_run`'s
// creation reply, its deduplicated reply (C64: the census — a repeat that matched a run which cannot
// go on carried `next_actions: []` and a hint that named nothing), and each `started` entry of
// `start_run_batch` (C65: the entry carried `next_actions` and no sentence). The way out comes with it
// when the run cannot go on until its workflow is corrected. Whole-message pins.
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

const WAY_OUT =
  'Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.';
const CANNOT =
  "'compute' cannot run (input_schema): Invalid input for step 'compute': the input must have required property 'n'.";

const def = (id: string, withAgent: boolean): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    ...(withAgent
      ? { summarize: { description: 'Summarize.', execution: 'agent' as const, depends_on: [] } }
      : {}),
    compute: {
      description: 'Compute.',
      execution: 'auto',
      depends_on: [],
      input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
    },
  },
});

describe('#625 PR-2a, C64 and C65 — one hint for a run handed back with nothing run', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-hand-back-625-'));
    runStore = new JsonFileStore(join(dir, 'runs'));
    workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    await workflowStore.register(def('hb-stuck', false));
    await workflowStore.register(def('hb-ready', true));
  });

  it('C65: a started entry whose run can only reach a refused engine step — the creation sentence, the step, the way out', async () => {
    const batch = await handleStartRunBatch(
      { workflow_id: 'hb-stuck', items: [{ params: {} }] },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    const entry = batch.started[0]!;
    expect(entry.context_hint).toBe(
      `Run '${entry.run_id}' created for workflow 'hb-stuck'. ${CANNOT} ${WAY_OUT}`,
    );
    expect(entry.next_actions).toEqual([]);
  });

  it('C65: a started entry whose run has a ready agent step — the creation sentence and the step, no way out', async () => {
    const batch = await handleStartRunBatch(
      { workflow_id: 'hb-ready', items: [{ params: {} }] },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    const entry = batch.started[0]!;
    expect(entry.context_hint).toBe(
      `Run '${entry.run_id}' created for workflow 'hb-ready'. Ready for the agent: 'summarize'. ${CANNOT}`,
    );
  });

  it("C65: the entry's hint is the one start_run's reply carries for the same run (one composer); a deduplicated entry says `Matched existing run …`", async () => {
    const first = await handleStartRun(
      { workflow_id: 'hb-stuck', params: {}, idempotency_key: 'k' },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    const batch = await handleStartRunBatch(
      { workflow_id: 'hb-stuck', items: [{ params: {}, idempotency_key: 'k' }] },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    const again = await handleStartRun(
      { workflow_id: 'hb-stuck', params: {}, idempotency_key: 'k' },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    const matched = `Matched existing run '${first.run_id}' (idempotent) in phase 'running'; no new run created. ${CANNOT} ${WAY_OUT}`;
    expect(batch.started[0]!.deduped).toBe(true);
    expect(batch.started[0]!.context_hint).toBe(matched);
    expect(again.context_hint).toBe(matched);
  });

  it('C64: a deduplicated start_run on a run that cannot go on names the step and the way out', async () => {
    await handleStartRun(
      { workflow_id: 'hb-stuck', params: {}, idempotency_key: 'd' },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    const deduped = await handleStartRun(
      { workflow_id: 'hb-stuck', params: {}, idempotency_key: 'd' },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    expect(deduped.deduped).toBe(true);
    expect(deduped.context_hint).toBe(
      `Matched existing run '${deduped.run_id}' (idempotent) in phase 'running'; no new run created. ${CANNOT} ${WAY_OUT}`,
    );
    expect(deduped.next_actions).toEqual([]);
  });
});
