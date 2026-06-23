// Issue-2 headline regression: re-encountering a TERMINAL aborted run through a permanent
// idempotency key must be a clean no-op — start_run / start_run_batch must NOT re-drive or un-abort it.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition, RunRecord } from '@sensigo/realm';
import { handleStartRun } from './start-run.js';
import { handleStartRunBatch } from './start-run-batch.js';

// guard_step aborts → its downstream `process` (auto, none_failed) has only a *skipped* dependency,
// so pre-fix start_run found it eligible and re-executed it on the terminal run.
const workflow: WorkflowDefinition = {
  id: 'cs1',
  name: 'CS1',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    guard_step: { description: 'Guard', execution: 'agent', depends_on: [] },
    process: {
      description: 'Process',
      execution: 'auto',
      depends_on: ['guard_step'],
      trigger_rule: 'none_failed',
    },
  },
};

const IDEMPOTENCY_KEY = 'cs1-live-12345';

describe('start_run / start_run_batch on a terminal aborted run (idempotency no-op)', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'cs1-run-'));
    const wfDir = await mkdtemp(join(tmpdir(), 'cs1-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(wfDir);
    await workflowStore.register(workflow);
  });

  /** Seeds a terminal aborted run carrying the permanent idempotency key. */
  async function seedAbortedRun(): Promise<RunRecord> {
    const { run: run } = await runStore.create({
      workflowId: 'cs1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await runStore.update({
      ...run,
      run_phase: 'aborted',
      terminal_state: true,
      terminal_reason: "Guard 'guard_step' aborted the run",
      aborted_at: { step_id: 'guard_step' },
      skipped_steps: ['guard_step'], // aborting step skipped, NOT failed
    });
    return runStore.get(run.id);
  }

  it('start_run re-encountering the key leaves the run byte-unchanged (no re-drive, no un-abort)', async () => {
    const before = await seedAbortedRun();

    await handleStartRun(
      { workflow_id: 'cs1', idempotency_key: IDEMPOTENCY_KEY },
      { runStore, workflowStore },
    );

    const after = await runStore.get(before.id);
    // The invariant (not a specific corrupted phase): the record is untouched.
    expect(after).toEqual(before);
    expect(after.run_phase).toBe('aborted');
    expect(after.terminal_state).toBe(true);
    expect(after.failed_steps).not.toContain('process'); // downstream NOT re-driven into failed_steps
    expect(after.version).toBe(before.version); // no write
  });

  it('start_run_batch re-encountering the key leaves the run byte-unchanged', async () => {
    const before = await seedAbortedRun();

    const result = await handleStartRunBatch(
      { workflow_id: 'cs1', items: [{ params: {}, idempotency_key: IDEMPOTENCY_KEY }] },
      { runStore, workflowStore },
    );

    // Batch returns the existing run id (deduped) and never drives it.
    expect(result.started[0]?.run_id).toBe(before.id);
    const after = await runStore.get(before.id);
    expect(after).toEqual(before);
    expect(after.run_phase).toBe('aborted');
    expect(after.terminal_state).toBe(true);
    expect(after.version).toBe(before.version);
  });
});
