// run-health-gate-expiry.test.ts — issue #291, Deliverable 7: the gate_expired_awaiting_drive
// run-health finding — record-fields-only, non-terminal, fires for BOTH enactable and
// finding-only expired gates; NEVER fires for a reminder-overdue-but-not-expired gate (the B1
// negative pin: the notify clock has zero settlement authority).
import { describe, it, expect } from 'vitest';
import { classifyRunHealth } from './run-health.js';
import type { RunRecord, PendingGate } from '../types/run-record.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');

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

function makeGate(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    gate_id: 'gate-1',
    step_name: 'approve',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: '2026-07-20T11:00:00.000Z',
    ...overrides,
  };
}

describe('classifyRunHealth — gate_expired_awaiting_drive (issue #291)', () => {
  it('fires for an expired, enactable (settle_default) gate', () => {
    const run = makeRun({
      pending_gate: makeGate({
        expires_at: '2026-07-20T11:30:00.000Z',
        on_expiry: 'settle_default',
        default_choice: 'approve',
      }),
    });
    const findings = classifyRunHealth(run, { now: NOW });
    const f = findings.find((x) => x.kind === 'gate_expired_awaiting_drive');
    expect(f).toBeDefined();
    expect(f?.step).toBe('approve');
    expect(f?.evidence).toMatchObject({
      gate_id: 'gate-1',
      disposition: 'settle_default',
      overdue_ms: 30 * 60 * 1000,
    });
  });

  it('fires for an expired abort gate', () => {
    const run = makeRun({
      pending_gate: makeGate({ expires_at: '2026-07-20T11:30:00.000Z', on_expiry: 'abort' }),
    });
    const findings = classifyRunHealth(run, { now: NOW });
    const f = findings.find((x) => x.kind === 'gate_expired_awaiting_drive');
    expect(f?.evidence).toMatchObject({ disposition: 'abort' });
  });

  it('fires for a FINDING-ONLY expired gate (no on_expiry) — payload names disposition finding_only', () => {
    const run = makeRun({
      pending_gate: makeGate({ expires_at: '2026-07-20T11:30:00.000Z' }), // no on_expiry
    });
    const findings = classifyRunHealth(run, { now: NOW });
    const f = findings.find((x) => x.kind === 'gate_expired_awaiting_drive');
    expect(f).toBeDefined();
    expect(f?.evidence).toMatchObject({ disposition: 'finding_only' });
    expect(f?.reason).toContain('finding-only');
  });

  it('does NOT fire before the gate expires', () => {
    const run = makeRun({
      pending_gate: makeGate({ expires_at: '2026-07-20T13:00:00.000Z', on_expiry: 'abort' }),
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings.some((f) => f.kind === 'gate_expired_awaiting_drive')).toBe(false);
  });

  it('does NOT fire for a gate with no expires_at at all (grandfathered/no timeout)', () => {
    const run = makeRun({ pending_gate: makeGate() });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings.some((f) => f.kind === 'gate_expired_awaiting_drive')).toBe(false);
  });

  it('B1 negative pin: a gate with an overdue REMINDER but NOT expired is still perfectly healthy — the notify clock has zero settlement authority', () => {
    const run = makeRun({
      pending_gate: makeGate({
        reminder_seconds: 60, // way overdue by NOW (11:00 + 60s vs NOW 12:00)
        expires_at: '2026-07-20T14:00:00.000Z', // NOT yet expired
        on_expiry: 'abort',
      }),
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toEqual([]);
  });

  it('unreachable on a terminal record — the terminal branch returns before this check (the #282-class attack that FAILED)', () => {
    const run = makeRun({
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      in_progress_steps: [],
      pending_gate: makeGate({ expires_at: '2026-07-20T11:30:00.000Z', on_expiry: 'abort' }),
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings.some((f) => f.kind === 'gate_expired_awaiting_drive')).toBe(false);
    // It DOES still get terminal_with_stale_gate — a different, pre-existing finding.
    expect(findings.some((f) => f.kind === 'terminal_with_stale_gate')).toBe(true);
  });
});
