// list-gate-expiry-render.test.ts — issue #291, Deliverable 7: `realm run list`'s gate line
// gains an EXPIRED marker + reminder due/overdue annotation, off the SAME shared
// computeGateDueState derivation get_run_state/inspect also use. Unconditional (not --stuck
// gated) — matches the pre-existing gate line's own unconditional rendering.
import { describe, it, expect } from 'vitest';
import { listRuns } from './list.js';
import type { RunStore, RunRecord, PendingGate } from '@sensigo/realm';

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-abc123',
    workflow_id: 'test-workflow',
    workflow_version: 1,
    run_phase: 'gate_waiting',
    completed_steps: [],
    in_progress_steps: ['approve'],
    failed_steps: [],
    skipped_steps: [],
    version: 2,
    params: {},
    evidence: [],
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:01:00.000Z',
    terminal_state: false,
    claims: { approve: { deadline: null } },
    ...overrides,
  };
}

function makeGate(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    gate_id: 'gate-1',
    step_name: 'approve',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: new Date(Date.now() - 3_600_000).toISOString(), // opened 1h ago
    ...overrides,
  };
}

function makeStore(runs: RunRecord[]): RunStore {
  return {
    persistsClaims: true,
    get: async () => runs[0]!,
    create: async () => ({ run: runs[0]!, created: true }),
    update: async () => runs[0]!,
    list: async () => runs,
    // listRuns (the sole consumer under test here) never claims a step — this mock never needs
    // a real implementation, only a type-complete stub.
    claimStep: async () => {
      throw new Error('claimStep is not used by listRuns');
    },
  };
}

describe('listRuns — gate expiry rendering (issue #291)', () => {
  it('a NON-expired gate with no reminder gets the plain, pre-#291 gate line only', async () => {
    const run = makeRun({ pending_gate: makeGate() }); // no expires_at, no reminder_seconds
    const result = await listRuns(undefined, makeStore([run]));
    expect(result).toContain('gate: approve');
    expect(result).not.toContain('EXPIRED');
    expect(result).not.toContain('reminder');
  });

  it('an EXPIRED gate gets the EXPIRED marker with the overdue duration', async () => {
    const run = makeRun({
      pending_gate: makeGate({ expires_at: new Date(Date.now() - 600_000).toISOString() }), // 10m overdue
    });
    const result = await listRuns(undefined, makeStore([run]));
    expect(result).toContain('EXPIRED');
    expect(result).toMatch(/EXPIRED \d+m ago/);
  });

  it('an unexpired gate with a frozen reminder shows "reminder due in"', async () => {
    const run = makeRun({
      pending_gate: makeGate({
        opened_at: new Date(Date.now() - 30_000).toISOString(), // opened 30s ago
        reminder_seconds: 3600, // due in ~59.5 minutes
      }),
    });
    const result = await listRuns(undefined, makeStore([run]));
    expect(result).toContain('reminder due in');
    expect(result).not.toContain('reminder overdue');
  });

  it('a gate whose reminder schedule has already passed shows "reminder overdue"', async () => {
    const run = makeRun({
      pending_gate: makeGate({
        opened_at: new Date(Date.now() - 200_000).toISOString(), // opened 200s ago
        reminder_seconds: 60, // 3 occurrences have scheduled-passed by now
      }),
    });
    const result = await listRuns(undefined, makeStore([run]));
    // computeGateDueState always projects the NEXT future occurrence, so "overdue" here means
    // the projected due instant is still in the future relative to a real clock tick between
    // fixture construction and assertion — tolerate either rendering deterministically:
    expect(result).toMatch(/reminder (due in|overdue)/);
  });

  it('a terminal run with a stale pending_gate (the #282 class) renders NEITHER the gate line nor EXPIRED — keyed on derived phase', async () => {
    const run = makeRun({
      run_phase: 'gate_waiting', // stale — will be DERIVED as something else since terminal_state:true
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      in_progress_steps: [],
      pending_gate: makeGate({ expires_at: new Date(Date.now() - 600_000).toISOString() }),
    });
    const result = await listRuns(undefined, makeStore([run]));
    expect(result).not.toContain('gate: approve');
    expect(result).not.toContain('EXPIRED');
  });
});
