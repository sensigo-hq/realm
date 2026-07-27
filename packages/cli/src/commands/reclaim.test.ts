// Tests for the Phase-2 `--all` auto-reclaim SELECTION RULE (issue #101, §3).
// isAutoReclaimable is the safety-critical predicate; these compose the REAL detection
// (classifyInProgressClaims) with the REAL rule on REAL RunRecords, so a claim's state is derived,
// not hand-asserted. The whole point of Phase 2 is that only idempotent ∧ concrete-past-deadline ∧
// non-gated claims are ever auto-reclaimed.
import { describe, it, expect } from 'vitest';
import { isAutoReclaimable, renderReclaimOutcome } from './reclaim.js';
import { classifyInProgressClaims, RECLAIM_REFUSES_GATE_STEP } from '@sensigo/realm';
import type { RunRecord, StepDefinition, PendingGate } from '@sensigo/realm';

const NOW = new Date('2026-07-08T12:00:00.000Z').getTime();
const past = new Date(NOW - 60_000).toISOString(); // 60s past deadline
const future = new Date(NOW + 3_600_000).toISOString();

function makeRun(over: Partial<RunRecord>): RunRecord {
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

const idempotentAuto: StepDefinition = { description: 's', execution: 'auto', idempotent: true };
const plainAuto: StepDefinition = { description: 's', execution: 'auto' };

/** Compose real detection + real rule: classify the run's `step` claim, then apply the predicate. */
function selectable(
  run: RunRecord,
  step: string,
  stepDef: StepDefinition | undefined,
  olderThanMs?: number,
): boolean {
  const claim = classifyInProgressClaims(run, new Date(NOW)).find((c) => c.step === step);
  if (claim === undefined) return false;
  return isAutoReclaimable(
    run,
    claim,
    stepDef,
    olderThanMs !== undefined ? { olderThanMs, now: NOW } : { now: NOW },
  );
}

describe('isAutoReclaimable — the Phase-2 --all selection rule', () => {
  it('SELECTS an idempotent, concrete-past-deadline, non-gated claim', () => {
    const run = makeRun({ in_progress_steps: ['charge'], claims: { charge: { deadline: past } } });
    expect(selectable(run, 'charge', idempotentAuto)).toBe(true);
  });

  it('EXCLUDES a claim_unknown_age claim (null deadline — never past-deadline)', () => {
    const run = makeRun({ in_progress_steps: ['charge'], claims: { charge: { deadline: null } } });
    expect(selectable(run, 'charge', idempotentAuto)).toBe(false);
  });

  it('EXCLUDES a non-idempotent past-deadline claim (the double-charge-prevention headline)', () => {
    const run = makeRun({ in_progress_steps: ['charge'], claims: { charge: { deadline: past } } });
    // A side-effecting handler NOT declared idempotent, wedged past deadline → never auto-reclaimed.
    expect(selectable(run, 'charge', plainAuto)).toBe(false);
  });

  it('EXCLUDES a healthy (within-deadline) claim', () => {
    const run = makeRun({
      in_progress_steps: ['charge'],
      claims: { charge: { deadline: future } },
    });
    expect(selectable(run, 'charge', idempotentAuto)).toBe(false);
  });

  it(`EXCLUDES the open-gate step even when idempotent + past-deadline (${RECLAIM_REFUSES_GATE_STEP})`, () => {
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'charge',
      choices: ['approve'],
      opened_at: past,
      preview: {},
    };
    const run = makeRun({
      in_progress_steps: ['charge'],
      claims: { charge: { deadline: past } },
      pending_gate: gate,
      run_phase: 'gate_waiting',
    });
    expect(selectable(run, 'charge', idempotentAuto)).toBe(false);
  });

  it('EXCLUDES everything on a terminal run', () => {
    const run = makeRun({
      in_progress_steps: ['charge'],
      claims: { charge: { deadline: past } },
      terminal_state: true,
      run_phase: 'completed',
    });
    expect(selectable(run, 'charge', idempotentAuto)).toBe(false);
  });

  it('EXCLUDES when the definition is unresolvable (cannot confirm idempotent)', () => {
    const run = makeRun({ in_progress_steps: ['charge'], claims: { charge: { deadline: past } } });
    expect(selectable(run, 'charge', undefined)).toBe(false);
  });

  it('--older-than adds a grace margin (60s-past claim: ≥30m excludes, ≤30s includes)', () => {
    const run = makeRun({ in_progress_steps: ['charge'], claims: { charge: { deadline: past } } });
    expect(selectable(run, 'charge', idempotentAuto, 30 * 60_000)).toBe(false); // not old enough
    expect(selectable(run, 'charge', idempotentAuto, 30_000)).toBe(true); // 60s ≥ 30s grace
  });

  it('the finalizer crash-wedge (deadline: null ⇒ claim_unknown_age) stays cron-EXCLUDED', () => {
    // A domain step in a finalizer-bearing workflow is written deadline: null by Phase 1, so even
    // if it were somehow idempotent-declared it classifies claim_unknown_age → never auto-reclaimed.
    // It remains recoverable ONLY via per-step `realm run reclaim --step <S> --force`.
    const run = makeRun({ in_progress_steps: ['domain'], claims: { domain: { deadline: null } } });
    expect(selectable(run, 'domain', idempotentAuto)).toBe(false);
  });
});

describe('renderReclaimOutcome — pure outcome→(glyph, message) renderer (issue #221 [M4])', () => {
  it('reclaimed ⇒ the MUTATING glyph ✓', () => {
    const { glyph, message } = renderReclaimOutcome({
      step: 'work',
      outcome: 'reclaimed',
      priorState: 'claim_stale',
    });
    expect(glyph).toBe('✓');
    expect(message).toContain("Reclaimed 'work'");
    expect(message).toContain('claim_stale');
  });

  it('taken_over ⇒ the NEUTRAL glyph •', () => {
    const { glyph, message } = renderReclaimOutcome({
      step: 'work',
      outcome: 'taken_over',
      priorState: 'claim_stale',
    });
    expect(glyph).toBe('•');
    expect(message).toContain("'work'");
    expect(message).toContain('not stomped');
  });

  it('already_settled ⇒ the NEUTRAL glyph •', () => {
    const { glyph, message } = renderReclaimOutcome({
      step: 'work',
      outcome: 'already_settled',
      priorState: 'claim_unknown_age',
    });
    expect(glyph).toBe('•');
    expect(message).toContain("'work'");
    expect(message).toContain('already settled');
  });

  it('no_active_claim ⇒ the NEUTRAL glyph • + the EXACT required message text (never "still eligible")', () => {
    const { glyph, message } = renderReclaimOutcome({
      step: 'work',
      outcome: 'no_active_claim',
      priorState: 'claim_unknown_age',
    });
    expect(glyph).toBe('•');
    expect(message).toBe(
      "no active claim on 'work' and it is not settled — nothing to reclaim. If its dependencies are satisfied, driving the run will execute it.",
    );
    expect(message).not.toContain('still eligible');
  });
});
