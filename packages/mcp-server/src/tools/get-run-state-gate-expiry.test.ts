// get-run-state-gate-expiry.test.ts — issue #291, Deliverable 7: confirms get_run_state needs
// NO new code for gate-expiry disclosure — the frozen PendingGate fields (expires_at/on_expiry/
// default_choice/reminder_seconds/reminder_max) flow through the existing `pending_gate`
// passthrough verbatim, and the `gate_expired_awaiting_drive` run-health finding surfaces
// automatically through the existing `classifyRunHealth` call already wired into `run_health`.
import { describe, it, expect } from 'vitest';
import type { RunRecord, RunStore, PendingGate } from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';

function makeGate(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    gate_id: 'gate-1',
    step_name: 'approve',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: ['approve'],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'gate_waiting',
    version: 1,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    claims: { approve: { deadline: null } },
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
      throw new Error('not exercised');
    },
    async update() {
      throw new Error('not exercised');
    },
    async list() {
      throw new Error('not exercised');
    },
    async claimStep() {
      throw new Error('not exercised');
    },
  };
}

describe('get_run_state — gate expiry (issue #291)', () => {
  it('pending_gate carries every frozen enforce/notify field verbatim', async () => {
    const gate = makeGate({
      expires_at: '2026-01-01T00:10:00.000Z',
      on_expiry: 'settle_default',
      default_choice: 'approve',
      reminder_seconds: 300,
      reminder_max: 5,
    });
    const run = makeRun({ pending_gate: gate });
    const result = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });
    expect(result.pending_gate).toEqual(gate);
  });

  it('an expired gate surfaces gate_expired_awaiting_drive via run_health with no extra wiring', async () => {
    const gate = makeGate({ expires_at: '2026-01-01T00:00:01.000Z', on_expiry: 'abort' });
    const run = makeRun({ pending_gate: gate });
    const result = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });
    const finding = result.run_health?.find((f) => f.kind === 'gate_expired_awaiting_drive');
    expect(finding).toBeDefined();
    expect(finding?.evidence).toMatchObject({ disposition: 'abort' });
  });

  it('a healthy (unexpired) gate carries NO gate_expired_awaiting_drive finding, even with an overdue reminder [B1]', async () => {
    const gate = makeGate({
      reminder_seconds: 1, // overdue by any real clock
      expires_at: '2099-01-01T00:00:00.000Z', // far future — never expired
      on_expiry: 'abort',
    });
    const run = makeRun({ pending_gate: gate });
    const result = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });
    expect(result.run_health ?? []).toEqual([]);
  });
});
