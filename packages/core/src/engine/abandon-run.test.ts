// Tests for abandonRun — the shared run-abandonment primitive (#92 follow-up / 0.10.0).
import { declared } from '../test-support/declared.js';
import { doubleClock, snap } from '../test-support/snapshot-double.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { ABANDON_KILL_ADVISORY, abandonRun } from './abandon-run.js';
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

describe('abandonRun (InMemoryStore)', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  async function freshRunning(): Promise<RunRecord> {
    const { record: run } = await store.create({
      workflowId: 'wf',
      workflowVersion: 1,
      params: {},
    });
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
    const { record: reloaded } = await store.get(run.id);
    expect(reloaded.run_phase).toBe('abandoned');
    expect(reloaded.abandoned_at).toBe(result.abandoned_at);
  });

  it('running WITH failed_steps → abandoned (NOT failed) — the key correctness case', async () => {
    const run = await freshRunning();
    // Drive the run to carry a failed step while still running (terminal_state stays false).
    const { record: withFailed } = await store.update({ ...run, failed_steps: ['step_a'] });
    expect(withFailed.run_phase).toBe('running'); // not terminal yet
    const result = await abandonRun(store, run.id);
    expect(result.run_phase).toBe('abandoned'); // authoritative marker beats failed_steps
    expect(result.failed_steps).toEqual(['step_a']); // failed_steps preserved, not the phase driver
  });

  it('default reason when none supplied', async () => {
    const run = await freshRunning();
    const result = await abandonRun(store, run.id);
    // issue #558 PR-C: core's default is the NEUTRAL fallback — each surface supplies its own
    // reason naming the verb the operator used (`Abandoned via realm run abandon` /
    // `Abandoned via abandon_run`). A CLI kill must never be attributed to the MCP tool.
    expect(result.terminal_reason).toBe('Abandoned');
  });

  // ── issue #558 PR-C ─────────────────────────────────────────────────────────────────────────
  it('releases every claim in the seal write (in_progress_steps + claims both emptied)', async () => {
    const run = await freshRunning();
    const { record: claimed } = await store.update({
      ...run,
      in_progress_steps: ['analyze'],
      claims: {
        analyze: {
          deadline: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
    });
    expect(claimed.in_progress_steps).toEqual(['analyze']);

    const abandoned = await abandonRun(store, run.id, 'kill it');

    expect(abandoned.in_progress_steps).toEqual([]);
    expect(abandoned.claims).toEqual({});
    expect(abandoned.sealed_by?.arm).toBe('abandon_requested');
    // …and it is PERSISTED, not just returned.
    const { record: reloaded } = await store.get(run.id);
    expect(reloaded.in_progress_steps).toEqual([]);
    expect(reloaded.claims).toEqual({});
  });

  it('the LIVE gate refusal names the gate, carries the answer as its remedy (#729 PR-0, D-C), and names no surface verb', async () => {
    const run = await freshRunning();
    await store.update({
      ...run,
      pending_gate: {
        gate_id: 'g-approve-1',
        step_name: 'review_changes',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: new Date().toISOString(),
      },
    });
    await expect(abandonRun(store, run.id)).rejects.toThrow(
      `Run '${run.id}' is waiting on human gate 'review_changes' (gate 'g-approve-1'); it cannot be abandoned while its question is open.`,
    );
    try {
      await abandonRun(store, run.id);
      expect.unreachable('abandonRun must refuse a gate-waiting run');
    } catch (err) {
      const e = err as WorkflowError;
      expect(e.code).toBe('STATE_TRANSITION_DENIED');
      expect(e.details).toEqual({
        runId: run.id,
        run_phase: 'gate_waiting',
        // Disclosed on BOTH arms (the terminal arm's own unconditional precedent). Here the two
        // agree; on a record whose persisted label is stale they do not, and a reader must be able
        // to tell which number the refusal was computed from.
        persisted_run_phase: 'gate_waiting',
      });
      // #729 PR-0 (D-C, Amendment 11): the gate, its step and its choices moved from `details` to
      // the typed remedy — the respond way the doors word as their answer command.
      expect(
        (e.remedy ?? []).map((w) =>
          w.verb === 'respond' ? [w.verb, w.run_id, w.gate_id, w.step, w.choice.one_of] : [w.verb],
        ),
      ).toEqual([['respond', run.id, 'g-approve-1', 'review_changes', ['approve', 'reject']]]);
      // Core names NEITHER surface's verb — the three-walk finding.
      expect(e.message).not.toContain('submit_human_response');
      expect(e.message).not.toContain('realm run respond');
    }
  });

  it('the DIVERGENT (#432-class) record — persisted gate_waiting with no pending_gate — ABANDONS (nothing to answer)', async () => {
    const run = await freshRunning();
    // The divergent record CANNOT be produced through `store.update()` — every write tail
    // re-derives `run_phase` (PHASE_IS_GENERATED), so a planted 'gate_waiting' is erased on the
    // way in. It exists only as a record a legacy/foreign writer left, so it is planted here with
    // the store's `seed` fixture, which keeps it as given (past the store's own derivation).
    store.seed({
      ...run,
      run_phase: 'gate_waiting',
      in_progress_steps: ['analyze'],
      claims: { analyze: { deadline: null } },
    });
    // walk 3: refusing this record stranded the operator — `inspect` shows no gate, `respond`
    // has nothing to answer, and the refusal's own "answer it" could never be obeyed. The gate
    // refusal keys on `pending_gate`; the label alone is not a gate.
    const after = await abandonRun(store, run.id);
    expect(after.run_phase).toBe('abandoned');
    expect(after.abandoned_at).toBeDefined();
    expect(after.in_progress_steps).toEqual([]);
    expect(after.claims).toEqual({});
  });

  it('ABANDON_KILL_ADVISORY is minted exactly once and says what it says', async () => {
    expect(ABANDON_KILL_ADVISORY).toBe(
      'abandon is a kill — declared finalizers (if any) did NOT run and will not for this run. ' +
        "The graceful path is the workflow's own guard step (abort_unless), which runs them; " +
        'there is no operator abort command.',
    );
    // There is no operator `abort` verb — the retired sentence must not come back anywhere.
    expect(ABANDON_KILL_ADVISORY).not.toContain("'abort' is the graceful path");
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
    const { record: reloaded } = await store.get(run.id);
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
    const stub: Partial<RunStore> = declared({
      clock: doubleClock,
      get: async () => {
        getCalls++;
        return snap(getCalls === 1 ? runningRecord() : reloaded); // 1st: running; reload: abandoned
      },
      // #715 (b) (D-21): the seal is a `seal_run` settle — a moved run is thrown, as update() threw.
      settleStep: async () => {
        throw snapshotMismatch(); // a competing writer bumped the version
      },
    });
    const result = await abandonRun(stub as RunStore, 'r1');
    expect(result.abandoned_at).toBe('2026-06-26T00:00:00.000Z');
    expect(getCalls).toBe(2); // read once + reload once, no further retry
  });

  it('update mismatch then reload shows a non-abandoned (live) run → propagates STATE_SNAPSHOT_MISMATCH', async () => {
    let getCalls = 0;
    const stub: Partial<RunStore> = declared({
      clock: doubleClock,
      get: async () => {
        getCalls++;
        // 1st: running; reload: still running but advanced by a live writer (version bumped).
        return snap(
          getCalls === 1 ? runningRecord() : runningRecord({ version: 1, failed_steps: ['x'] }),
        );
      },
      settleStep: async () => {
        throw snapshotMismatch();
      },
    });
    await expect(abandonRun(stub as RunStore, 'r1')).rejects.toMatchObject({
      code: 'STATE_SNAPSHOT_MISMATCH',
    });
    expect(getCalls).toBe(2); // reloaded exactly once, then propagated (no loop)
  });
});

// #715 (b) A.8 (ii) (D-21): abandon seals through the `seal_run` delta on a REAL store — the store's
// transform refuses a moved run (`moved`) and the store throws it exactly as `update()` threw.
describe('#715 (b) D-21 — abandon’s seal_run on an in-memory store', () => {
  async function storeAt(t: Date): Promise<InMemoryStore> {
    return new InMemoryStore({ clock: settableClock(t) });
  }

  it('a run that moves between abandon’s read and its seal: abandon reloads once and loses with the STATE_SNAPSHOT_MISMATCH update() threw; the run stays live', async () => {
    // (a) red when the seal ignores expected_version (it seals over the other writer's write and
    //     abandon resolves); (b) prints the code, the message and the run's state afterwards.
    const store = await storeAt(new Date());
    const { record: run } = await store.create({
      workflowId: 'wf',
      workflowVersion: 1,
      params: {},
    });
    // Another writer lands between abandon's read and its seal.
    const moving = new Proxy(store, {
      get(target, prop) {
        if (prop === 'settleStep') {
          return async (...a: Parameters<InMemoryStore['settleStep']>) => {
            const { record } = await target.get(run.id);
            await target.update(record);
            return target.settleStep(...a);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    let caught: { code?: string; message?: string } | undefined;
    await abandonRun(moving, run.id).catch((e: WorkflowError) => {
      caught = { code: e.code, message: e.message };
    });
    const { record: after } = await store.get(run.id);
    expect({ caught, terminal: after.terminal_state, version: after.version }).toEqual({
      caught: {
        code: 'STATE_SNAPSHOT_MISMATCH',
        message: 'Version conflict — run was modified by another process',
      },
      terminal: false,
      version: run.version + 1,
    });
  });

  it('a seal at a test location a year behind the wall stamps abandoned_at (and updated_at) from the store’s reading', async () => {
    // (a) red when the seal's instant comes from the host's clock (a year later); (b) prints both.
    const T = new Date(Math.floor(Date.now() / 1000) * 1000 - 365 * 86_400_000);
    const store = await storeAt(T);
    const { record: run } = await store.create({
      workflowId: 'wf',
      workflowVersion: 1,
      params: {},
    });
    const sealed = await abandonRun(store, run.id);
    expect({ abandoned_at: sealed.abandoned_at, updated_at: sealed.updated_at }).toEqual({
      abandoned_at: T.toISOString(),
      updated_at: T.toISOString(),
    });
  });
});
