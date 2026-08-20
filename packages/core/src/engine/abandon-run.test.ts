// Tests for abandonRun — the shared run-abandonment primitive (#92 follow-up / 0.10.0).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abandonRun } from './abandon-run.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunStore } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { PendingGate } from '../types/run-record.js';

/** Minimal running RunRecord for stub-store tests. */
function runningRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 0,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    ...over,
  };
}

function snapshotMismatch(): WorkflowError {
  return new WorkflowError('Version conflict', {
    code: 'STATE_SNAPSHOT_MISMATCH',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: true,
  });
}

describe('abandonRun (JsonFileStore)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-abandon-'));
    store = new JsonFileStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function freshRunning(): Promise<RunRecord> {
    const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    return run;
  }

  it('running → abandoned: sets abandoned_at, bumps version, derives phase abandoned', async () => {
    const run = await freshRunning();
    const result = await abandonRun(store, run.id, 'operator cleanup');
    expect(result.abandoned_at).toBeDefined();
    expect(result.terminal_state).toBe(true);
    expect(result.run_phase).toBe('abandoned');
    expect(result.terminal_reason).toBe('operator cleanup');
    expect(result.version).toBe(run.version + 1);
    // Persisted.
    const reloaded = await store.get(run.id);
    expect(reloaded.run_phase).toBe('abandoned');
    expect(reloaded.abandoned_at).toBe(result.abandoned_at);
  });

  it('running WITH failed_steps → abandoned (NOT failed) — the key correctness case', async () => {
    const run = await freshRunning();
    // Drive the run to carry a failed step while still running (terminal_state stays false).
    const withFailed = await store.update({ ...run, failed_steps: ['step_a'] });
    expect(withFailed.run_phase).toBe('running'); // not terminal yet
    const result = await abandonRun(store, run.id);
    expect(result.run_phase).toBe('abandoned'); // authoritative marker beats failed_steps
    expect(result.failed_steps).toEqual(['step_a']); // failed_steps preserved, not the phase driver
  });

  it('default reason when none supplied', async () => {
    const run = await freshRunning();
    const result = await abandonRun(store, run.id);
    expect(result.terminal_reason).toBe('Abandoned via abandon_run');
  });

  it('already abandoned → idempotent no-op (same record, version unchanged)', async () => {
    const run = await freshRunning();
    const first = await abandonRun(store, run.id, 'first');
    const second = await abandonRun(store, run.id, 'second');
    expect(second.version).toBe(first.version); // no second write
    expect(second.abandoned_at).toBe(first.abandoned_at);
    expect(second.terminal_reason).toBe('first'); // reason not overwritten
  });

  it('completed → STATE_RUN_TERMINAL', async () => {
    const run = await freshRunning();
    await store.update({
      ...run,
      completed_steps: ['s'],
      terminal_state: true,
      sealed_by: { arm: 'complete' as const },
      terminal_reason: 'Workflow completed.',
    });
    await expect(abandonRun(store, run.id)).rejects.toMatchObject({ code: 'STATE_RUN_TERMINAL' });
  });

  it('failed → STATE_RUN_TERMINAL', async () => {
    const run = await freshRunning();
    await store.update({
      ...run,
      failed_steps: ['s'],
      terminal_state: true,
      sealed_by: { arm: 'step_failure' as const },
      terminal_reason: "Step 's' failed",
    });
    await expect(abandonRun(store, run.id)).rejects.toMatchObject({ code: 'STATE_RUN_TERMINAL' });
  });

  it('aborted → STATE_RUN_TERMINAL', async () => {
    const run = await freshRunning();
    await store.update({
      ...run,
      terminal_state: true,
      sealed_by: { arm: 'guard_abort' as const },
      aborted_at: { step_id: 'g' },
    });
    await expect(abandonRun(store, run.id)).rejects.toMatchObject({ code: 'STATE_RUN_TERMINAL' });
  });

  it('gate_waiting → STATE_TRANSITION_DENIED (gate abandonment refused)', async () => {
    const run = await freshRunning();
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'review',
      choices: ['approve', 'reject'],
      opened_at: new Date().toISOString(),
      preview: {},
    };
    await store.update({ ...run, pending_gate: gate });
    await expect(abandonRun(store, run.id)).rejects.toMatchObject({
      code: 'STATE_TRANSITION_DENIED',
    });
  });

  it('missing run → STATE_RUN_NOT_FOUND', async () => {
    await expect(abandonRun(store, 'no-such-run')).rejects.toMatchObject({
      code: 'STATE_RUN_NOT_FOUND',
    });
  });

  it('real-store concurrent abandons are idempotent-safe (no corruption)', async () => {
    const run = await freshRunning();
    const results = await Promise.allSettled([
      abandonRun(store, run.id),
      abandonRun(store, run.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    const reloaded = await store.get(run.id);
    expect(reloaded.run_phase).toBe('abandoned');
    expect(reloaded.abandoned_at).toBeDefined();
  });
});

describe('abandonRun — CAS concurrency branch (deterministic stub store)', () => {
  it('update mismatch then reload shows abandoned → idempotent success (returns reloaded)', async () => {
    const reloaded = runningRecord({
      version: 1,
      terminal_state: true,
      sealed_by: { arm: 'abandon_requested' },
      abandoned_at: '2026-06-26T00:00:00.000Z',
      run_phase: 'abandoned',
    });
    let getCalls = 0;
    const stub: Partial<RunStore> = {
      get: async () => {
        getCalls++;
        return getCalls === 1 ? runningRecord() : reloaded; // 1st: running; reload: abandoned
      },
      update: async () => {
        throw snapshotMismatch(); // a competing writer bumped the version
      },
    };
    const result = await abandonRun(stub as RunStore, 'r1');
    expect(result.abandoned_at).toBe('2026-06-26T00:00:00.000Z');
    expect(getCalls).toBe(2); // read once + reload once, no further retry
  });

  it('update mismatch then reload shows a non-abandoned (live) run → propagates STATE_SNAPSHOT_MISMATCH', async () => {
    let getCalls = 0;
    const stub: Partial<RunStore> = {
      get: async () => {
        getCalls++;
        // 1st: running; reload: still running but advanced by a live writer (version bumped).
        return getCalls === 1
          ? runningRecord()
          : runningRecord({ version: 1, failed_steps: ['x'] });
      },
      update: async () => {
        throw snapshotMismatch();
      },
    };
    await expect(abandonRun(stub as RunStore, 'r1')).rejects.toMatchObject({
      code: 'STATE_SNAPSHOT_MISMATCH',
    });
    expect(getCalls).toBe(2); // reloaded exactly once, then propagated (no loop)
  });
});
