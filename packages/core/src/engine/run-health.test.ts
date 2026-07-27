// Tests for classifyRunHealth — typed run-health classification (issue #221).
import { describe, it, expect } from 'vitest';
import { classifyRunHealth, DEFAULT_IDLE_THRESHOLD_MS } from './run-health.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');

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

describe('classifyRunHealth', () => {
  // ---------------------------------------------------------------------
  // Branch 1 — terminal guard, NARROWED by issue #279 (increment 1, PR-B, design record §6):
  // `terminal ∧ no pending finalizer_ledger entries ⇒ []` — no longer literally unconditional on
  // terminal_state alone (pendings are checked first; see the finding tests further below).
  // ---------------------------------------------------------------------
  it('terminal_state with NO pending finalizer_ledger entries ⇒ [] (byte-identical to pre-#279 behavior)', () => {
    const run = makeRun({
      terminal_state: true,
      run_phase: 'completed',
      updated_at: new Date(NOW.getTime() - 100 * 86_400_000).toISOString(),
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  it('terminal_state with a finalizer_ledger that has ZERO pending entries (all completed/failed/voided) ⇒ []', () => {
    const run = makeRun({
      terminal_state: true,
      run_phase: 'completed',
      finalizer_ledger: {
        done: { status: 'completed', rank: 0 },
        gone: { status: 'voided', rank: 1 },
      },
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  it('a terminal+claimed guard-abort record (a claim still in in_progress_steps at abort) ⇒ []', () => {
    const run = makeRun({
      terminal_state: true,
      run_phase: 'failed',
      in_progress_steps: ['work'],
      claims: { work: { deadline: new Date(NOW.getTime() - 60_000).toISOString() } },
      aborted_at: { step_id: 'guard_check' },
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Branch 1 (narrowed) — the NEW terminal_pending_finalizer finding (issue #279, increment 1,
  // PR-B). POSITIVE pin: terminal + pending ⇒ EXACTLY the new finding and ONLY it — no
  // claim/capability/idle finding may leak through (the narrowed guard must still suppress them).
  // ---------------------------------------------------------------------
  it('terminal + a never-leased pending finalizer ⇒ exactly ONE terminal_pending_finalizer finding, reason never_leased', () => {
    const run = makeRun({
      terminal_state: true,
      run_phase: 'completed',
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([
      {
        kind: 'terminal_pending_finalizer',
        step: 'fin',
        reason: 'never_leased',
        evidence: { rank: 0 },
      },
    ]);
  });

  it('terminal + a pending finalizer with an EXPIRED lease ⇒ reason lease_expired', () => {
    const run = makeRun({
      terminal_state: true,
      run_phase: 'completed',
      finalizer_ledger: {
        fin: {
          status: 'pending',
          rank: 0,
          lease_token: 'dead-drainer',
          lease_deadline: new Date(NOW.getTime() - 60_000).toISOString(),
        },
      },
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toBe('lease_expired');
  });

  it('terminal + a pending finalizer with an UNEXPIRED (active) lease ⇒ reason lease_held', () => {
    const run = makeRun({
      terminal_state: true,
      run_phase: 'completed',
      finalizer_ledger: {
        fin: {
          status: 'pending',
          rank: 0,
          lease_token: 'live-drainer',
          lease_deadline: new Date(NOW.getTime() + 60_000).toISOString(),
        },
      },
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toBe('lease_held');
  });

  it('POSITIVE PIN: a terminal run with BOTH a pending finalizer AND a stale in-progress claim shows ONLY the finalizer finding (no claim finding leaks through)', () => {
    const run = makeRun({
      terminal_state: true,
      run_phase: 'failed',
      in_progress_steps: ['work'],
      claims: { work: { deadline: new Date(NOW.getTime() - 60_000).toISOString() } },
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toEqual([
      {
        kind: 'terminal_pending_finalizer',
        step: 'fin',
        reason: 'never_leased',
        evidence: { rank: 0 },
      },
    ]);
    expect(findings.some((f) => f.kind === 'stale_claim')).toBe(false);
  });

  it('multiple pending finalizers each produce their own finding, in ledger order', () => {
    const run = makeRun({
      terminal_state: true,
      run_phase: 'completed',
      finalizer_ledger: {
        first: { status: 'pending', rank: 0 },
        second: { status: 'pending', rank: 1 },
      },
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings.map((f) => f.step)).toEqual(['first', 'second']);
  });

  // ---------------------------------------------------------------------
  // Branch 2 — claim findings (stale_claim / wedged_gate_sibling).
  // ---------------------------------------------------------------------
  it('a stale claim on a running run fires kind stale_claim, reason mirrors the claim state', () => {
    const run = makeRun({
      in_progress_steps: ['work'],
      claims: { work: { deadline: new Date(NOW.getTime() - 60_000).toISOString() } },
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'stale_claim', step: 'work', reason: 'claim_stale' });
  });

  it('a HEALTHY claim never fires (holds)', () => {
    const run = makeRun({
      in_progress_steps: ['work'],
      claims: { work: { deadline: new Date(NOW.getTime() + 3_600_000).toISOString() } },
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  it('healthy gate_waiting ⇒ zero findings (the B1 negative pin — the open-gate claim is {deadline:null} and must never self-flag)', () => {
    const run = makeRun({
      run_phase: 'gate_waiting',
      in_progress_steps: ['gated'],
      claims: { gated: { deadline: null } },
      pending_gate: {
        gate_id: 'g1',
        step_name: 'gated',
        choices: ['approve'],
        opened_at: NOW.toISOString(),
        preview: {},
      },
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  it('pending-gate-step exclusion with a wedged NON-gated sibling ⇒ exactly the sibling flagged as wedged_gate_sibling', () => {
    const run = makeRun({
      run_phase: 'gate_waiting',
      in_progress_steps: ['gated', 'branch_b'],
      claims: {
        gated: { deadline: null },
        branch_b: { deadline: new Date(NOW.getTime() - 60_000).toISOString() },
      },
      pending_gate: {
        gate_id: 'g1',
        step_name: 'gated',
        choices: ['approve'],
        opened_at: NOW.toISOString(),
        preview: {},
      },
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'wedged_gate_sibling',
      step: 'branch_b',
      reason: 'claim_stale',
    });
  });

  it('a claim_unknown_age claim on a RUNNING (non-gated) run still gets kind stale_claim per the B1 table (reason carries the finer distinction)', () => {
    const run = makeRun({
      in_progress_steps: ['work'],
      claims: { work: { deadline: null } },
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'stale_claim',
      step: 'work',
      reason: 'claim_unknown_age',
    });
  });

  // ---------------------------------------------------------------------
  // Branch 3 — capability findings.
  // ---------------------------------------------------------------------
  it('a capability-blocked eligible step fires kind capability_block', () => {
    const run = makeRun({
      updated_at: NOW.toISOString(), // recent — isolates this test from the idle branch
      capability_blocks: {
        enrich: {
          requirement: { kind: 'adapter', name: 'shopify' },
          code: 'ENGINE_ADAPTER_NOT_REGISTERED',
          at: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'capability_block',
      step: 'enrich',
      reason: 'ENGINE_ADAPTER_NOT_REGISTERED',
      since: '2026-07-01T00:00:00.000Z',
    });
    expect(findings[0]?.evidence).toMatchObject({
      requirement: { kind: 'adapter', name: 'shopify' },
    });
  });

  it('a capability block whose step has since settled does not fire (findCapabilityBlockedSteps self-suppresses)', () => {
    const run = makeRun({
      updated_at: NOW.toISOString(), // recent — isolates this test from the idle branch
      completed_steps: ['enrich'],
      capability_blocks: {
        enrich: {
          requirement: { kind: 'adapter', name: 'shopify' },
          code: 'ENGINE_ADAPTER_NOT_REGISTERED',
          at: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Branch 4 — never_claimed_idle + threshold boundary + invariants.
  // ---------------------------------------------------------------------
  it('never_claimed_idle fires at exactly the threshold boundary (idle === threshold)', () => {
    const run = makeRun({
      updated_at: new Date(NOW.getTime() - DEFAULT_IDLE_THRESHOLD_MS).toISOString(),
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('never_claimed_idle');
  });

  it('never_claimed_idle HOLDS at threshold − 1ms', () => {
    const run = makeRun({
      updated_at: new Date(NOW.getTime() - DEFAULT_IDLE_THRESHOLD_MS + 1).toISOString(),
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  it('a young (well under threshold) claimless running run holds', () => {
    const run = makeRun({ updated_at: new Date(NOW.getTime() - 60_000).toISOString() });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  it('never_claimed_idle carries since + idle_ms + evidence.idle_threshold_ms (the required invariant)', () => {
    const updatedAt = new Date(NOW.getTime() - 2 * DEFAULT_IDLE_THRESHOLD_MS).toISOString();
    const run = makeRun({ updated_at: updatedAt });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.kind).toBe('never_claimed_idle');
    expect(f.since).toBe(updatedAt);
    expect(f.idle_ms).toBe(2 * DEFAULT_IDLE_THRESHOLD_MS);
    expect(f.evidence?.['idle_threshold_ms']).toBe(DEFAULT_IDLE_THRESHOLD_MS);
  });

  it("an explicit idleThresholdMs override is honored (0 restores today's breadth)", () => {
    const run = makeRun({ updated_at: NOW.toISOString() }); // zero idle time
    const findings = classifyRunHealth(run, { now: NOW, idleThresholdMs: 0 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('never_claimed_idle');
    expect(findings[0]?.evidence?.['idle_threshold_ms']).toBe(0);
  });

  it('definition present ⇒ evidence.eligible_steps; definition-free ⇒ absent', () => {
    const def: WorkflowDefinition = {
      id: 'wf',
      name: 'WF',
      version: 1,
      steps: {
        draft: { description: 'd', execution: 'agent' },
      },
    };
    const run = makeRun({
      updated_at: new Date(NOW.getTime() - 2 * DEFAULT_IDLE_THRESHOLD_MS).toISOString(),
    });

    const withDef = classifyRunHealth(run, { now: NOW, definition: def });
    expect(withDef[0]?.evidence?.['eligible_steps']).toEqual(['draft']);

    const withoutDef = classifyRunHealth(run, { now: NOW });
    expect(withoutDef[0]?.evidence).not.toHaveProperty('eligible_steps');
  });

  it('never_claimed_idle does NOT fire when in_progress_steps is non-empty, even if idle past threshold', () => {
    const run = makeRun({
      in_progress_steps: ['work'],
      claims: { work: { deadline: new Date(NOW.getTime() + 3_600_000).toISOString() } }, // healthy
      updated_at: new Date(NOW.getTime() - 2 * DEFAULT_IDLE_THRESHOLD_MS).toISOString(),
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  it('never_claimed_idle does NOT fire on a gate_waiting run', () => {
    const run = makeRun({
      run_phase: 'gate_waiting',
      updated_at: new Date(NOW.getTime() - 2 * DEFAULT_IDLE_THRESHOLD_MS).toISOString(),
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Honest-admission rule.
  // ---------------------------------------------------------------------
  it('honesty pin: no finding\'s reason text ever says "rejected" or "stuck"', () => {
    const idleRun = makeRun({
      updated_at: new Date(NOW.getTime() - 2 * DEFAULT_IDLE_THRESHOLD_MS).toISOString(),
    });
    const claimRun = makeRun({
      in_progress_steps: ['work'],
      claims: { work: { deadline: new Date(NOW.getTime() - 60_000).toISOString() } },
    });
    const capRun = makeRun({
      capability_blocks: {
        enrich: {
          requirement: { kind: 'adapter', name: 'shopify' },
          code: 'ENGINE_ADAPTER_NOT_REGISTERED',
          at: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    const allFindings = [
      ...classifyRunHealth(idleRun, { now: NOW }),
      ...classifyRunHealth(claimRun, { now: NOW }),
      ...classifyRunHealth(capRun, { now: NOW }),
    ];
    expect(allFindings.length).toBeGreaterThan(0);
    for (const f of allFindings) {
      expect(f.reason.toLowerCase()).not.toContain('rejected');
      expect(f.reason.toLowerCase()).not.toContain('stuck');
    }
  });

  // ---------------------------------------------------------------------
  // issue #279 (increment 2, PR-D, design record §9) — the three NEW finding classes.
  // ---------------------------------------------------------------------

  it('terminal_with_stale_gate: a terminal record still carrying a pending_gate gets exactly this finding, pointing at purge', () => {
    const run = makeRun({
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      run_phase: 'gate_waiting', // stale — the #282 class's own persisted-phase symptom
      pending_gate: {
        gate_id: 'stale-gate',
        step_name: 'gated_step',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: '2026-01-01T00:00:00.000Z',
      },
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('terminal_with_stale_gate');
    expect(findings[0]?.step).toBe('gated_step');
    expect(findings[0]?.evidence?.['gate_id']).toBe('stale-gate');
  });

  it('gate_corruption (G-2): a settled gate entry sharing the SAME gate_id as the live pending_gate is flagged, on BOTH the terminal and non-terminal paths', () => {
    const corruptGate = {
      gate_id: 'corrupt-gate',
      step_name: 'gated_step',
      preview: {},
      choices: ['approve', 'reject'],
      opened_at: '2026-01-01T00:00:00.000Z',
    };
    const nonTerminalRun = makeRun({
      pending_gate: corruptGate,
      run_phase: 'gate_waiting',
      settled: { gated_step: { token: 'corrupt-gate', outcome: 'gate', choice: 'approve' } },
    });
    const nonTerminalFindings = classifyRunHealth(nonTerminalRun, { now: NOW });
    expect(nonTerminalFindings.some((f) => f.kind === 'gate_corruption')).toBe(true);
    const corruptionFinding = nonTerminalFindings.find((f) => f.kind === 'gate_corruption');
    expect(corruptionFinding?.step).toBe('gated_step');
    expect(corruptionFinding?.evidence?.['gate_id']).toBe('corrupt-gate');

    const terminalRun = makeRun({
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      pending_gate: corruptGate,
      settled: { gated_step: { token: 'corrupt-gate', outcome: 'gate', choice: 'approve' } },
    });
    const terminalFindings = classifyRunHealth(terminalRun, { now: NOW });
    expect(terminalFindings.some((f) => f.kind === 'gate_corruption')).toBe(true);
  });

  it('resolved_gate_with_eligible_guard: a resolved gate with a NOW-eligible guard names it, ONLY when a definition is supplied', () => {
    const run = makeRun({
      completed_steps: ['gated_step'],
      run_phase: 'running',
    });
    const definition: WorkflowDefinition = {
      id: 'wf',
      name: 'wf',
      version: 1,
      steps: {
        gated_step: { description: 'g', execution: 'agent', depends_on: [] },
        guard_after: {
          description: 'guard',
          execution: 'guard',
          depends_on: ['gated_step'],
          abort_unless: ['gated_step.status == "open"'],
        },
      },
    };
    const withDefinition = classifyRunHealth(run, { now: NOW, definition });
    expect(withDefinition.some((f) => f.kind === 'resolved_gate_with_eligible_guard')).toBe(true);
    const finding = withDefinition.find((f) => f.kind === 'resolved_gate_with_eligible_guard');
    expect(finding?.step).toBe('guard_after');
    expect(finding?.reason).toContain('guard_after');
    expect(finding?.reason).toContain('next drive');

    // Definition-free: the finding never surfaces (findEligibleGuardSteps needs a definition) —
    // matches list.ts's own disclosed, accepted limitation (design record §9).
    const withoutDefinition = classifyRunHealth(run, { now: NOW });
    expect(withoutDefinition.some((f) => f.kind === 'resolved_gate_with_eligible_guard')).toBe(
      false,
    );
  });
});
