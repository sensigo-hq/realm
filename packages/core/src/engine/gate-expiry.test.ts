// gate-expiry.test.ts — issue #291: applyExpireGate's arm matrix ([F1]) + applySettleGate's [F3]
// write-free `gate_expired_pending` refusal. Pure `applySettlement` unit tests — no store needed
// (the transform is pure/synchronous), mirroring how a store-level TCK case would exercise the
// same deltas, but without the store round-trip (faster, and avoids the core→testing circular
// package dependency: @sensigo/realm-testing already depends on @sensigo/realm).
import { describe, it, expect } from 'vitest';
import { applySettlement } from './settlement.js';
import type { RunRecord, PendingGate, EvidenceSnapshot } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { SettlementDelta } from '../types/settlement.js';

function makeDefinition(stepNames: string[]): WorkflowDefinition {
  const steps: Record<string, WorkflowDefinition['steps'][string]> = {};
  for (const name of stepNames) {
    steps[name] = { description: name, execution: 'agent' as const, depends_on: [] };
  }
  return { id: 'gate-expiry-wf', name: 'Gate Expiry Fixture', version: 1, steps };
}

function makeGate(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    gate_id: 'gate-1',
    step_name: 'gated',
    preview: { headline: 'review me' },
    choices: ['approve', 'reject'],
    opened_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    workflow_id: 'gate-expiry-wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: ['gated'],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'gate_waiting',
    version: 3,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    claims: { gated: { deadline: null, token: 'claim-token-1' } },
    ...overrides,
  };
}

const NOW_PAST_EXPIRY = new Date('2026-01-01T00:10:00.000Z'); // 10 minutes after opened_at
const NOW_BEFORE_EXPIRY = new Date('2026-01-01T00:00:30.000Z'); // 30s after opened_at

const EXPIRES_AT = '2026-01-01T00:05:00.000Z'; // opened_at + 5 minutes

describe('applyExpireGate — the [F1] arm matrix (issue #291)', () => {
  const def = makeDefinition(['gated']);

  it('lookup-first: a settled gate entry for gateId NOOPs as already_settled (replay after resolution)', () => {
    const run = makeRun({
      in_progress_steps: [],
      completed_steps: ['gated'],
      settled: { gated: { token: 'gate-1', outcome: 'gate', choice: 'approve' } },
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toBe('already_settled');
  });

  it('terminal split: a prior expire-abort for THIS gateId replays as already_settled (crash-recovery NOOP)', () => {
    const run = makeRun({
      in_progress_steps: [],
      skipped_steps: ['gated'],
      skip_details: { gated: { kind: 'gate_expired', gate_id: 'gate-1' } },
      terminal_state: true,
      terminal_reason:
        "Gate 'gated' expired and the run aborted per the workflow's declared on_expiry.",
      aborted_at: { step_id: 'gated', abort_message: 'expired' },
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toBe('already_settled');
  });

  it('terminal split: a DIFFERENT terminal cause (not this gateId) REFUSES run_terminal — never resurrects', () => {
    const run = makeRun({
      in_progress_steps: [],
      completed_steps: ['gated'],
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toBe('run_terminal');
  });

  it('no/other pending_gate: an unknown or superseded gateId REFUSES gate_mismatch', () => {
    const run = makeRun({
      pending_gate: makeGate({ gate_id: 'gate-2', expires_at: EXPIRES_AT, on_expiry: 'abort' }),
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toBe('gate_mismatch');
  });

  it('not_expired: now < expires_at REFUSES (arm-verified, never trusts the caller)', () => {
    const run = makeRun({
      pending_gate: makeGate({ expires_at: EXPIRES_AT, on_expiry: 'abort' }),
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: NOW_BEFORE_EXPIRY });
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toBe('not_expired');
    // No write on refusal — fresh state returned verbatim.
    expect(result.run).toBe(run);
  });

  it('not_expired: an absent expires_at (grandfathered/no-timeout gate) also REFUSES — defensive, never crashes', () => {
    const run = makeRun({ pending_gate: makeGate({ on_expiry: 'abort' }) });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toBe('not_expired');
  });

  it('finding-only mode: expires_at present but on_expiry absent REFUSES no_disposition — never enacted', () => {
    const run = makeRun({ pending_gate: makeGate({ expires_at: EXPIRES_AT }) });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toBe('no_disposition');
    expect(result.run.pending_gate).toBeDefined(); // never cleared
  });

  it('APPLY settle_default: resolves with the FROZEN default_choice, resolved_by:"timeout", clears the gate, completes the step', () => {
    const run = makeRun({
      pending_gate: makeGate({
        expires_at: EXPIRES_AT,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      }),
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.run.pending_gate).toBeUndefined();
    expect(result.run.in_progress_steps).not.toContain('gated');
    expect(result.run.claims?.['gated']).toBeUndefined();
    expect(result.run.completed_steps).toContain('gated');
    expect(result.run.settled?.['gated']).toEqual({
      token: 'gate-1',
      outcome: 'gate',
      choice: 'approve',
      resolved_by: 'timeout',
    });
    expect(result.run.terminal_state).toBe(true); // sole step — isComplete
    expect(result.run.terminal_reason).toBe('Workflow completed.');
    const snapshot = result.run.evidence.at(-1) as EvidenceSnapshot;
    expect(snapshot.kind).toBe('gate_response');
    expect(snapshot.responded_by).toBe('timeout');
    expect(snapshot.resolution).toBe('expired_default');
    expect(snapshot.output_summary).toMatchObject({ choice: 'approve' });
  });

  it('APPLY abort: aborts the run, clears the gate, skip_details carries gate_expired + gate_id (day-one, F9) — never gate_cancelled_by_abort', () => {
    const run = makeRun({
      pending_gate: makeGate({ expires_at: EXPIRES_AT, on_expiry: 'abort' }),
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.run.pending_gate).toBeUndefined();
    expect(result.run.in_progress_steps).not.toContain('gated');
    expect(result.run.claims?.['gated']).toBeUndefined();
    expect(result.run.skipped_steps).toContain('gated');
    // TERMINAL_GATE_EXCLUSION: never BOTH a settled 'gate' entry AND the abort disposition.
    expect(result.run.settled?.['gated']).toBeUndefined();
    expect(result.run.skip_details?.['gated']).toEqual({ kind: 'gate_expired', gate_id: 'gate-1' });
    expect(result.run.terminal_state).toBe(true);
    expect(result.run.aborted_at).toMatchObject({ step_id: 'gated' });
    const snapshot = result.run.evidence.at(-1) as EvidenceSnapshot;
    expect(snapshot.kind).toBe('gate_response');
    expect(snapshot.responded_by).toBe('timeout');
    expect(snapshot.resolution).toBe('expired_abort');
  });

  it('replay ×2: a second expire_gate for the SAME already-enacted (settle_default) gate NOOPs as already_settled — version-safe idempotence', () => {
    const run = makeRun({
      pending_gate: makeGate({
        expires_at: EXPIRES_AT,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      }),
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const first = applySettlement(run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(first.applied).toBe(true);
    if (!first.applied) return;
    const second = applySettlement(first.run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(second.applied).toBe(false);
    if (!second.applied) expect(second.reason).toBe('already_settled');
  });

  it('replay ×2: a second expire_gate for the SAME already-enacted (abort) gate NOOPs as already_settled', () => {
    const run = makeRun({
      pending_gate: makeGate({ expires_at: EXPIRES_AT, on_expiry: 'abort' }),
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const first = applySettlement(run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(first.applied).toBe(true);
    if (!first.applied) return;
    const second = applySettlement(first.run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(second.applied).toBe(false);
    if (!second.applied) expect(second.reason).toBe('already_settled');
  });
});

describe("applySettleGate's [F3] write-free gate_expired_pending refusal (issue #291)", () => {
  const def = makeDefinition(['gated']);

  it('a live gate past its frozen expires_at REFUSES gate_expired_pending BEFORE choice_not_eligible — write-free, version unchanged', () => {
    const run = makeRun({
      pending_gate: makeGate({ expires_at: EXPIRES_AT, on_expiry: 'abort' }),
    });
    const delta: SettlementDelta = {
      kind: 'settle_gate',
      gateId: 'gate-1',
      choice: 'not-a-real-choice', // would ALSO be choice_not_eligible — expiry must win first
      evidence: [],
    };
    const result = applySettlement(run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toBe('gate_expired_pending');
    expect(result.run).toBe(run); // no write
  });

  it('a live gate BEFORE its frozen expires_at resolves normally — the refusal never fires early', () => {
    const run = makeRun({
      pending_gate: makeGate({ expires_at: EXPIRES_AT, on_expiry: 'abort' }),
    });
    const delta: SettlementDelta = {
      kind: 'settle_gate',
      gateId: 'gate-1',
      choice: 'approve',
      evidence: [],
    };
    const result = applySettlement(run, delta, def, { now: NOW_BEFORE_EXPIRY });
    expect(result.applied).toBe(true);
  });

  it('a FINDING-ONLY gate (expires_at present, on_expiry absent) NEVER trips the refusal — the human always resolves normally, however overdue', () => {
    const run = makeRun({ pending_gate: makeGate({ expires_at: EXPIRES_AT }) });
    const delta: SettlementDelta = {
      kind: 'settle_gate',
      gateId: 'gate-1',
      choice: 'approve',
      evidence: [],
    };
    const result = applySettlement(run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(result.applied).toBe(true);
  });

  it('a gate with NO frozen expires_at (grandfathered) never trips the refusal, however late', () => {
    const run = makeRun({ pending_gate: makeGate() });
    const delta: SettlementDelta = {
      kind: 'settle_gate',
      gateId: 'gate-1',
      choice: 'approve',
      evidence: [],
    };
    const result = applySettlement(run, delta, def, { now: NOW_PAST_EXPIRY });
    expect(result.applied).toBe(true);
  });
});
