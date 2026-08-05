// get_run_state's terminal_reason field (issue #302, disclosure gaps) — a single additive,
// verbatim echo of RunRecord.terminal_reason, present only when the underlying field is set.
//
// A minimal hand-rolled RunStore double (get-run-state-defaulted-steps.test.ts's own precedent) —
// handleGetRunState only ever calls `.get()`.
import { describe, it, expect } from 'vitest';
import type { RunRecord, RunStore } from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 1,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    ...over,
  };
}

function makeStore(run: RunRecord): RunStore {
  return {
    persistsClaims: true,
    async get() {
      return run;
    },
    async create() {
      throw new Error('not exercised by get_run_state');
    },
    async update() {
      throw new Error('not exercised by get_run_state');
    },
    async list() {
      throw new Error('not exercised by get_run_state');
    },
    async claimStep() {
      throw new Error('not exercised by get_run_state');
    },
  };
}

describe('get_run_state — terminal_reason (issue #302)', () => {
  it('present: a completed run echoes terminal_reason verbatim', async () => {
    const run = makeRun({
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      completed_steps: ['work'],
    });
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });

    expect(summary.terminal_reason).toBe('Workflow completed.');
  });

  it('present: a failed run echoes its OWN distinct terminal_reason string verbatim (no rewriting)', async () => {
    const run = makeRun({
      terminal_state: true,
      terminal_reason: "Guard step 'check' failed: unresolvable path 'foo.bar'.",
      failed_steps: ['check'],
    });
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });

    expect(summary.terminal_reason).toBe("Guard step 'check' failed: unresolvable path 'foo.bar'.");
  });

  it('absent: a LIVE (non-terminal) run never carries terminal_reason', async () => {
    const run = makeRun({ terminal_state: false });
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });

    expect(summary.terminal_reason).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(summary, 'terminal_reason')).toBe(false);
  });

  it('absent: a terminal run whose OWN terminal_reason field is unset (e.g. a guard-abort, which never sets it) never synthesizes one', async () => {
    const run = makeRun({
      terminal_state: true,
      aborted_at: { step_id: 'guard' },
      // terminal_reason deliberately absent — aborted_at's own record never sets it
      // (eligibility.ts's deriveRunPhase comment: aborted_at wins before terminal_reason is ever
      // consulted for phase derivation; the field itself is simply never written on this path).
    });
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });

    expect(summary.terminal_reason).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(summary, 'terminal_reason')).toBe(false);
  });
});
