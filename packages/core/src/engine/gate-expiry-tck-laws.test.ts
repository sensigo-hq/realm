// gate-expiry-tck-laws.test.ts — issue #291, Deliverable 9 (O7 law families): EXPIRE_ARM_MATRIX,
// EXPIRE_ABORT_CASCADE, EXPIRE_DEFAULT_RESOLVE — organized as named law families per the design
// record's own O7 list, exercising the pure `applySettlement` transform directly.
//
// SCOPE NOTE (amended, gate-timeout-291-correction Leg 2): the same three law families now ALSO
// live in the shared cross-store `settlement-contract.ts` TCK (packages/testing/src/store/), per
// the PR-C precedent — wired into both `settlement-json-file-store.test.ts` and
// `settlement-in-memory-store.test.ts`'s `LAWS` arrays, proving BOTH stores' `settleStep` reach
// the identical, correct `applyExpireGate` behavior through the real store surface. THIS file is
// DELIBERATELY KEPT, not slimmed or deleted: it exercises `applySettlement` directly against
// hand-rolled fixtures (no store, no filesystem, no async I/O) — fast unit-level coverage of the
// pure transform's own arm matrix, complementary to the TCK's store-exercising cases (which incur
// real create/claim/open_gate round-trips per case). Both layers stay, matching how every other
// delta kind in this codebase is proven: a focused engine-level unit file plus the shared
// conformance kit — neither one subsumes the other's failure-isolation value.
import { describe, it, expect } from 'vitest';
import { applySettlement } from './settlement.js';
import type { RunRecord, PendingGate } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { SettlementDelta } from '../types/settlement.js';

function makeDefinition(
  stepNames: string[],
  gateDefaults?: { choices?: string[]; default_choice?: string },
): WorkflowDefinition {
  const steps: Record<string, WorkflowDefinition['steps'][string]> = {};
  for (const name of stepNames) {
    steps[name] = {
      description: name,
      execution: 'agent' as const,
      depends_on: [],
      ...(gateDefaults !== undefined
        ? {
            trust: 'human_confirmed' as const,
            gate: {
              ...(gateDefaults.choices !== undefined ? { choices: gateDefaults.choices } : {}),
              ...(gateDefaults.default_choice !== undefined
                ? {
                    on_expiry: 'settle_default' as const,
                    default_choice: gateDefaults.default_choice,
                  }
                : {}),
            },
          }
        : {}),
    };
  }
  return { id: 'gate-tck-wf', name: 'Gate TCK Fixture', version: 1, steps };
}

function makeGate(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    gate_id: 'gate-1',
    step_name: 'gated',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    workflow_id: 'gate-tck-wf',
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

const PAST_EXPIRY = new Date('2026-01-01T00:10:00.000Z');
const EXPIRES_AT = '2026-01-01T00:05:00.000Z';

describe('EXPIRE_ARM_MATRIX (issue #291, O7)', () => {
  const def = makeDefinition(['gated']);

  it('refuses not_expired with the injectable now, never the caller-implied clock', () => {
    const run = makeRun({ pending_gate: makeGate({ expires_at: EXPIRES_AT, on_expiry: 'abort' }) });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: new Date('2026-01-01T00:00:30.000Z') });
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toBe('not_expired');
  });

  it('replay ×2 (settle_default): the SECOND expire_gate attempt for an already-enacted gate NOOPs already_settled — version-safe idempotence', () => {
    const run = makeRun({
      pending_gate: makeGate({
        expires_at: EXPIRES_AT,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      }),
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const first = applySettlement(run, delta, def, { now: PAST_EXPIRY });
    expect(first.applied).toBe(true);
    if (!first.applied) return;
    const second = applySettlement(first.run, delta, def, { now: PAST_EXPIRY });
    expect(second.applied).toBe(false);
    if (!second.applied) expect(second.reason).toBe('already_settled');
  });

  it('replay ×2 (abort): the SECOND expire_gate attempt for an already-aborted gate NOOPs already_settled (terminal split)', () => {
    const run = makeRun({ pending_gate: makeGate({ expires_at: EXPIRES_AT, on_expiry: 'abort' }) });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const first = applySettlement(run, delta, def, { now: PAST_EXPIRY });
    expect(first.applied).toBe(true);
    if (!first.applied) return;
    const second = applySettlement(first.run, delta, def, { now: PAST_EXPIRY });
    expect(second.applied).toBe(false);
    if (!second.applied) expect(second.reason).toBe('already_settled');
  });

  it('a DIFFERENT terminal cause on the record REFUSES run_terminal, never resurrecting or re-terminalizing', () => {
    const run = makeRun({
      pending_gate: undefined,
      in_progress_steps: [],
      completed_steps: ['gated'],
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: PAST_EXPIRY });
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toBe('run_terminal');
  });

  it('an unknown/superseded gateId REFUSES gate_mismatch', () => {
    const run = makeRun({
      pending_gate: makeGate({ gate_id: 'gate-OTHER', expires_at: EXPIRES_AT, on_expiry: 'abort' }),
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: PAST_EXPIRY });
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toBe('gate_mismatch');
  });

  it('finding-only (expires_at present, on_expiry absent) REFUSES no_disposition, arm-level, before APPLY', () => {
    const run = makeRun({ pending_gate: makeGate({ expires_at: EXPIRES_AT }) });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: PAST_EXPIRY });
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.reason).toBe('no_disposition');
    expect(result.run.pending_gate).toBeDefined(); // never cleared
  });
});

describe('EXPIRE_ABORT_CASCADE (issue #291, O7)', () => {
  const def = makeDefinition(['gated']);

  it('clears pending_gate + claim, writes aborted_at, skip_details {gate_expired, gate_id} (day-one), and mints finalizers on the terminal edge — all in ONE write', () => {
    const run = makeRun({ pending_gate: makeGate({ expires_at: EXPIRES_AT, on_expiry: 'abort' }) });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: PAST_EXPIRY });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.run.pending_gate).toBeUndefined();
    expect(result.run.claims?.['gated']).toBeUndefined();
    expect(result.run.in_progress_steps).not.toContain('gated');
    expect(result.run.terminal_state).toBe(true);
    expect(result.run.aborted_at).toMatchObject({ step_id: 'gated' });
    expect(result.run.skip_details?.['gated']).toEqual({ kind: 'gate_expired', gate_id: 'gate-1' });
    // TERMINAL_GATE_EXCLUSION: never BOTH a settled 'gate' entry AND the abort disposition.
    expect(result.run.settled?.['gated']).toBeUndefined();
  });

  it('the D-4 discriminator: a THIRD-variant gate_expired skip_detail is NEVER mistaken for gate_cancelled_by_abort', () => {
    const run = makeRun({ pending_gate: makeGate({ expires_at: EXPIRES_AT, on_expiry: 'abort' }) });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: PAST_EXPIRY });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.run.skip_details?.['gated'].kind).toBe('gate_expired');
    expect(result.run.skip_details?.['gated'].kind).not.toBe('gate_cancelled_by_abort');
  });

  it('never stamps defaulted_steps on the abort edge, even though it terminalizes (the FM-5/#232 guard)', () => {
    const run = makeRun({ pending_gate: makeGate({ expires_at: EXPIRES_AT, on_expiry: 'abort' }) });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: PAST_EXPIRY });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.run.defaulted_steps).toBeUndefined();
  });
});

describe("EXPIRE_DEFAULT_RESOLVE (issue #291, O7 — incl. the FROZEN-BEATS-DEFINITION law, probe (b)'s red target)", () => {
  it('resolves with resolved_by:"timeout" attribution + both isComplete legs (terminalizing here — sole step)', () => {
    const def = makeDefinition(['gated']);
    const run = makeRun({
      pending_gate: makeGate({
        expires_at: EXPIRES_AT,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      }),
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: PAST_EXPIRY });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.run.settled?.['gated']).toEqual({
      token: 'gate-1',
      outcome: 'gate',
      choice: 'approve',
      resolved_by: 'timeout',
    });
    expect(result.run.terminal_state).toBe(true); // sole step ⇒ isComplete
  });

  it('the non-terminalizing isComplete leg: a sibling step still pending keeps the run non-terminal after settle_default', () => {
    const def = makeDefinition(['gated', 'sibling']);
    const run = makeRun({
      in_progress_steps: ['gated', 'sibling'],
      claims: {
        gated: { deadline: null, token: 'claim-token-1' },
        sibling: { deadline: null, token: 'claim-token-2' },
      },
      pending_gate: makeGate({
        expires_at: EXPIRES_AT,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      }),
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: PAST_EXPIRY });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.run.terminal_state).toBe(false); // 'sibling' still in_progress
    expect(result.run.completed_steps).toContain('gated');
  });

  it('FROZEN-BEATS-DEFINITION (probe (b) target): enactment reads the RECORD-frozen default_choice, NEVER the (possibly re-registered, changed) definition — a definition with a DIFFERENT default_choice for the same step never influences the outcome', () => {
    // The gate was minted under a definition whose gate.default_choice was 'approve' (captured
    // into the FROZEN pending_gate.default_choice at mint — simulated directly here since this
    // test targets applyExpireGate's own read behavior, not the mint site covered elsewhere).
    const run = makeRun({
      pending_gate: makeGate({
        expires_at: EXPIRES_AT,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      }),
    });
    // The DEFINITION passed to applySettlement at enactment time has been RE-REGISTERED with a
    // DIFFERENT default_choice ('reject') and a DIFFERENT choice set entirely — simulating a
    // workflow edit that landed between gate-open and enactment.
    const driftedDef = makeDefinition(['gated'], {
      choices: ['ship', 'hold'],
      default_choice: 'reject',
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, driftedDef, { now: PAST_EXPIRY });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    // The FROZEN choice ('approve') wins — never the drifted definition's 'reject'.
    expect(result.run.settled?.['gated']?.choice).toBe('approve');
    expect(result.run.settled?.['gated']?.choice).not.toBe('reject');
  });

  it('the evidence gate_response snapshot carries responded_by:"timeout" + resolution:"expired_default"', () => {
    const def = makeDefinition(['gated']);
    const run = makeRun({
      pending_gate: makeGate({
        expires_at: EXPIRES_AT,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      }),
    });
    const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-1' };
    const result = applySettlement(run, delta, def, { now: PAST_EXPIRY });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    const snapshot = result.run.evidence.at(-1);
    expect(snapshot?.kind).toBe('gate_response');
    expect(snapshot?.responded_by).toBe('timeout');
    expect(snapshot?.resolution).toBe('expired_default');
  });
});
