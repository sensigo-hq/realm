// Tests for classifyRunHealth — typed run-health classification (issue #221).
import { describe, it, expect } from 'vitest';
import { classifyRunHealth, DEFAULT_IDLE_THRESHOLD_MS } from './run-health.js';
import type { RunRecord, EvidenceSnapshot } from '../types/run-record.js';
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
  // Narrowed AGAIN by issue #302 (disclosure gaps): `∧ NOT completed-with-failed-steps` — see the
  // `completed_with_failed_steps` finding tests near the end of this file for that class's own
  // positive/negative pins; this fixture's `failed_steps: []` keeps it green either way.
  // ---------------------------------------------------------------------
  it('terminal_state with NO pending finalizer_ledger entries AND no failed-steps-on-completed ⇒ [] (byte-identical to pre-#279 behavior)', () => {
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

  // ---------------------------------------------------------------------
  // issue #302 (disclosure gaps) — the NEW completed_with_failed_steps finding class. Predicate:
  // terminal_state ∧ deriveRunPhase(run) === 'completed' ∧ failed_steps.length > 0. The hidden
  // hinge (eligibility.ts:65): deriveRunPhase's 'completed' branch requires
  // terminal_reason === 'Workflow completed.' verbatim — the run_phase FIELD is ignored by
  // derivation, so every fixture below sets/omits terminal_reason deliberately, never run_phase.
  // ---------------------------------------------------------------------

  it('completed_with_failed_steps: a completed seal carrying failed_steps gets exactly this finding (issue #316/R7: trigger-aware trailing clause — the leading count/step-list half stays byte-stable, only the trailing clause changed)', () => {
    const run = makeRun({
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      run_phase: 'completed',
      failed_steps: ['retry_step', 'notify_step'],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([
      {
        kind: 'completed_with_failed_steps',
        reason:
          'completed with 2 failed step(s): retry_step, notify_step — fail-triggered ' +
          'finalizers do not run on a completed seal unless the workflow opts into the ' +
          "'completed_with_failed_steps' trigger",
        evidence: { failed_steps: ['retry_step', 'notify_step'] },
      },
    ]);
  });

  it('negative: a CLEAN completed seal (no failed_steps) ⇒ no completed_with_failed_steps finding', () => {
    const run = makeRun({
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      run_phase: 'completed',
      failed_steps: [],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  it('negative: a pure-FAIL terminal seal (terminal_reason absent) with failed_steps ⇒ no completed_with_failed_steps finding (deriveRunPhase is "failed", not "completed")', () => {
    const run = makeRun({
      terminal_state: true,
      // terminal_reason deliberately absent — deriveRunPhase falls through to the
      // failed_steps.length > 0 branch, deriving 'failed', never 'completed'.
      run_phase: 'failed',
      failed_steps: ['work'],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  it('negative: a pure-FAIL terminal seal with a DIFFERENT terminal_reason string ⇒ still no finding (exact-match hinge, not a prefix/substring check)', () => {
    const run = makeRun({
      terminal_state: true,
      terminal_reason: 'Guard step failed: unresolvable path.',
      run_phase: 'failed',
      failed_steps: ['work'],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// issue #316 — structured_output_downgraded: one aggregated finding per run, covering every
// EvidenceSnapshot whose diagnostics.structured_output carries a real (non-external_agent)
// downgrade_reason. Fires on BOTH the live and terminal paths (findStructuredOutputDowngrades is
// called from both branches of classifyRunHealth, mirroring findGateCorruption's own pattern).
// ---------------------------------------------------------------------------
describe('classifyRunHealth — structured_output_downgraded (issue #316)', () => {
  function snap(overrides: { step_id: string } & Partial<EvidenceSnapshot>): EvidenceSnapshot {
    return {
      started_at: '2024-01-01T00:00:00.000Z',
      completed_at: '2024-01-01T00:00:01.000Z',
      duration_ms: 100,
      input_summary: {},
      output_summary: {},
      status: 'success',
      evidence_hash: 'abc',
      ...overrides,
    };
  }

  // (a) downgrade_reason set ⇒ fires (live path).
  it('(a) a live run with one downgraded step (api_rejected_schema) ⇒ exactly one structured_output_downgraded finding', () => {
    const run = makeRun({
      run_phase: 'running',
      updated_at: NOW.toISOString(),
      evidence: [
        snap({
          step_id: 'classify',
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'api_rejected_schema',
            },
          },
        }),
      ],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([
      {
        kind: 'structured_output_downgraded',
        reason:
          '1 step(s) requested strict structured output but ran without it (classify: ' +
          'api_rejected_schema) — outputs were validated post-hoc (L1), not grammar-constrained',
        evidence: { steps: [{ step: 'classify', reasons: ['api_rejected_schema'] }] },
      },
    ]);
  });

  // (b) not-constructible cells: audit-verified (execution-loop.ts + anthropic-provider.ts +
  // run-agent.ts) that `sent: false` NEVER occurs without a `downgrade_reason`, and a
  // `downgrade_reason` NEVER occurs with `sent: true` — every mint site pairs them together or
  // omits both. No fixture is fabricated for these cells; the predicate
  // (`downgrade_reason !== undefined && downgrade_reason !== 'external_agent'`) does not read
  // `sent` at all, so these cells cannot influence its behavior even if they somehow occurred.

  // (c) external_agent ⇒ NEVER fires — the adjudicated, load-bearing exclusion.
  it('(c) external_agent downgrade_reason ⇒ NEVER fires (an MCP-driven run synthesized stamp)', () => {
    const run = makeRun({
      run_phase: 'running',
      updated_at: NOW.toISOString(),
      evidence: [
        snap({
          step_id: 'classify',
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: { requested: true, sent: false, downgrade_reason: 'external_agent' },
          },
        }),
      ],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  // (d) no structured_output diagnostics anywhere ⇒ no finding.
  it('(d) evidence with no structured_output diagnostics at all ⇒ no finding', () => {
    const run = makeRun({
      run_phase: 'running',
      updated_at: NOW.toISOString(),
      evidence: [
        snap({ step_id: 'plain_step' }),
        snap({
          step_id: 'other_step',
          diagnostics: { input_token_estimate: 5, precondition_trace: [] },
        }),
      ],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  // (e) terminal run with a historical downgrade ⇒ fires in the terminal branch.
  it('(e) a terminal run whose evidence records a historical downgrade ⇒ fires via the terminal branch', () => {
    const run = makeRun({
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      run_phase: 'completed',
      evidence: [
        snap({
          step_id: 'classify',
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'grammar_unavailable',
            },
          },
        }),
      ],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([
      {
        kind: 'structured_output_downgraded',
        reason:
          '1 step(s) requested strict structured output but ran without it (classify: ' +
          'grammar_unavailable) — outputs were validated post-hoc (L1), not grammar-constrained',
        evidence: { steps: [{ step: 'classify', reasons: ['grammar_unavailable'] }] },
      },
    ]);
  });

  // issue #316 correction — the terminal CO-FIRE cell (MA novel probe, 2026-08-14): a completed
  // seal carrying BOTH failed_steps AND a historical downgrade must return BOTH findings — the
  // downgrade push sits BEFORE the `pendingFindings.length > 0` early return specifically so a
  // future tidy-up that moves it AFTER cannot silently drop the disclosure. terminal_reason MUST
  // be the verbatim 'Workflow completed.' string (the derivation hinge) — omitting it derives
  // 'failed', not 'completed', and this cell would silently stop exercising the co-fire path at
  // all (the MA's own first probe fixture hit exactly this).
  it('terminal co-fire: completed-with-failed-steps AND a historical downgrade ⇒ BOTH findings, both asserted by content', () => {
    const run = makeRun({
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      run_phase: 'completed',
      failed_steps: ['retry_step'],
      evidence: [
        snap({
          step_id: 'classify',
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'api_rejected_schema',
            },
          },
        }),
      ],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([
      {
        kind: 'completed_with_failed_steps',
        reason:
          'completed with 1 failed step(s): retry_step — fail-triggered finalizers do not run ' +
          "on a completed seal unless the workflow opts into the 'completed_with_failed_steps' " +
          'trigger',
        evidence: { failed_steps: ['retry_step'] },
      },
      {
        kind: 'structured_output_downgraded',
        reason:
          '1 step(s) requested strict structured output but ran without it (classify: ' +
          'api_rejected_schema) — outputs were validated post-hoc (L1), not grammar-constrained',
        evidence: { steps: [{ step: 'classify', reasons: ['api_rejected_schema'] }] },
      },
    ]);
  });

  // (f) aggregation: two steps, distinct reasons ⇒ ONE finding, both named in the reason.
  it('(f) two steps with distinct reasons ⇒ ONE aggregated finding naming both', () => {
    const run = makeRun({
      run_phase: 'running',
      updated_at: NOW.toISOString(),
      evidence: [
        snap({
          step_id: 'classify',
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'api_rejected_schema',
            },
          },
        }),
        snap({
          step_id: 'route',
          diagnostics: {
            input_token_estimate: 8,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'gate_ineligible',
            },
          },
        }),
      ],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([
      {
        kind: 'structured_output_downgraded',
        reason:
          '2 step(s) requested strict structured output but ran without it (classify: ' +
          'api_rejected_schema; route: gate_ineligible) — outputs were validated post-hoc (L1), ' +
          'not grammar-constrained',
        evidence: {
          steps: [
            { step: 'classify', reasons: ['api_rejected_schema'] },
            { step: 'route', reasons: ['gate_ineligible'] },
          ],
        },
      },
    ]);
  });

  // Aggregation, same-step dedup: a step retried with the SAME reason across attempts contributes
  // that reason once, not once per attempt.
  it('a step retried twice with the SAME reason ⇒ that reason is deduped to ONE entry', () => {
    const run = makeRun({
      run_phase: 'running',
      updated_at: NOW.toISOString(),
      evidence: [
        snap({
          step_id: 'classify',
          attempt: 1,
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'service_unavailable',
            },
          },
        }),
        snap({
          step_id: 'classify',
          attempt: 2,
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'service_unavailable',
            },
          },
        }),
      ],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([
      {
        kind: 'structured_output_downgraded',
        reason:
          '1 step(s) requested strict structured output but ran without it (classify: ' +
          'service_unavailable) — outputs were validated post-hoc (L1), not grammar-constrained',
        evidence: { steps: [{ step: 'classify', reasons: ['service_unavailable'] }] },
      },
    ]);
  });

  // Aggregation, same-step DIFFERENT reasons across attempts: every distinct reason the step saw
  // is listed, in first-seen order — never conflated, never silently dropped to "the last one".
  it('a step with DIFFERENT reasons across attempts ⇒ every distinct reason listed, first-seen order', () => {
    const run = makeRun({
      run_phase: 'running',
      updated_at: NOW.toISOString(),
      evidence: [
        snap({
          step_id: 'classify',
          attempt: 1,
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'api_rejected_schema',
            },
          },
        }),
        snap({
          step_id: 'classify',
          attempt: 2,
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'service_unavailable',
            },
          },
        }),
      ],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([
      {
        kind: 'structured_output_downgraded',
        reason:
          '1 step(s) requested strict structured output but ran without it (classify: ' +
          'api_rejected_schema, service_unavailable) — outputs were validated post-hoc (L1), ' +
          'not grammar-constrained',
        evidence: {
          steps: [{ step: 'classify', reasons: ['api_rejected_schema', 'service_unavailable'] }],
        },
      },
    ]);
  });

  it('negative: sent:true with no downgrade_reason ⇒ no finding (the normal successful-strict shape)', () => {
    const run = makeRun({
      run_phase: 'running',
      updated_at: NOW.toISOString(),
      evidence: [
        snap({
          step_id: 'classify',
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: { requested: true, sent: true },
          },
        }),
      ],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([]);
  });

  // issue #332 item 6, pin (iii): the run-agent.ts tools-fork fix mints `unsupported_context_tools`
  // instead of leaving the engine to synthesize `external_agent` for a strict-declared,
  // tools-bearing, realm-driven step. This finding's predicate treats any non-external_agent
  // reason identically (no code change needed here — classifyRunHealth never special-cases
  // individual reason strings), but before the fix such a run's downgrade was INVISIBLE to this
  // finding entirely (external_agent is the load-bearing exclusion) — it now SURFACES. Asserted
  // verbatim (toEqual, not toContain) so the exact reason string a fix regression would corrupt
  // is caught, not just its presence.
  it('a run whose only downgrade is unsupported_context_tools (the #332 item 6 fix) now SURFACES via this finding — previously invisible as external_agent', () => {
    const run = makeRun({
      run_phase: 'running',
      updated_at: NOW.toISOString(),
      evidence: [
        snap({
          step_id: 'classify',
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'unsupported_context_tools',
            },
          },
        }),
      ],
    });
    expect(classifyRunHealth(run, { now: NOW })).toEqual([
      {
        kind: 'structured_output_downgraded',
        reason:
          '1 step(s) requested strict structured output but ran without it (classify: ' +
          'unsupported_context_tools) — outputs were validated post-hoc (L1), not grammar-constrained',
        evidence: { steps: [{ step: 'classify', reasons: ['unsupported_context_tools'] }] },
      },
    ]);
  });

  // -------------------------------------------------------------------------------------------
  // issue #311, pin 14 — the NARROW tool-arguments widening, as TWO discriminating cells.
  //
  // Cell (i) is the permanent baseline: an opted-in tools step fires this finding on EVERY run
  // with `unsupported_context_tools` alone (its OUTPUT is never grammar-constrained). Cell (ii)
  // adds the one tool-args class that is admitted. Both use EXACT array equality: a substring
  // check for `api_rejected_schema` would be satisfied by a mutant that strips the `tool_args:`
  // dimension marker, which is precisely what must not happen — the marker is what keeps the
  // #346 trigger greppable against the permanent baseline.
  // -------------------------------------------------------------------------------------------
  // issue #313 — the compat_endpoint INCLUSION pin. This REPLACES the old exclusion reading:
  // `external_agent` is excluded because realm cannot KNOW what an external driver did, whereas
  // a compat gate is realm's OWN decision not to send strict — epistemically the same footing as
  // `unsupported_context_tools`, which has always been included. The predicate needed no change;
  // this pin is what keeps it that way.
  it('issue #313 INCLUSION: a compat-gated strict-declared run FIRES the finding, with compat_endpoint visible', () => {
    const run = makeRun({
      run_phase: 'running',
      updated_at: NOW.toISOString(),
      evidence: [
        snap({
          step_id: 'classify',
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'compat_endpoint',
              provider: 'openai',
            },
          },
        }),
      ],
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('structured_output_downgraded');
    expect(findings[0]!.evidence).toEqual({
      steps: [{ step: 'classify', reasons: ['compat_endpoint'] }],
    });
    // The literal must be legible in the human-readable reason too — an operator reading the
    // finding needs to know WHICH remedy applies (--strict-base-url vs a native endpoint).
    expect(findings[0]!.reason).toContain('compat_endpoint');
  });

  it('pin 14 (i) BASELINE: an opted-in tools step with NO tool 400 fires with EXACTLY [unsupported_context_tools]', () => {
    const run = makeRun({
      run_phase: 'running',
      updated_at: NOW.toISOString(),
      evidence: [
        snap({
          step_id: 'classify',
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'unsupported_context_tools',
              tool_args: {
                tools: [
                  // A mix of routine outcomes — none of these is admitted to the finding.
                  { name: 'strict_ok', strict_requested: true, strict_sent: true },
                  {
                    name: 'ineligible',
                    strict_requested: true,
                    strict_sent: false,
                    reasons: ['missing_additional_properties'],
                  },
                  {
                    name: 'skipped',
                    strict_requested: true,
                    strict_sent: false,
                    reasons: ['budget_excluded'],
                  },
                  {
                    name: 'overloaded',
                    strict_requested: true,
                    strict_sent: false,
                    reasons: ['service_unavailable'],
                  },
                ],
              },
            },
          },
        }),
      ],
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence).toEqual({
      steps: [{ step: 'classify', reasons: ['unsupported_context_tools'] }],
    });
  });

  it('pin 14 (ii) WITH-400: a tool-args api_rejected_schema adds EXACTLY the dimension-marked literal', () => {
    const run = makeRun({
      run_phase: 'running',
      updated_at: NOW.toISOString(),
      evidence: [
        snap({
          step_id: 'classify',
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'unsupported_context_tools',
              tool_args: {
                tools: [
                  {
                    name: 'rejected',
                    strict_requested: true,
                    strict_sent: false,
                    reasons: ['api_rejected_schema'],
                  },
                  {
                    name: 'ineligible',
                    strict_requested: true,
                    strict_sent: false,
                    reasons: ['missing_additional_properties'],
                  },
                ],
                dropped_mid_attempt: {
                  reason: 'api_rejected_schema',
                  strict_turns_before_drop: 0,
                },
              },
            },
          },
        }),
      ],
    });
    const findings = classifyRunHealth(run, { now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence).toEqual({
      steps: [
        {
          step: 'classify',
          reasons: ['unsupported_context_tools', 'tool_args:api_rejected_schema'],
        },
      ],
    });
  });

  it('pin 14 (iii): two tools rejected in the same attempt contribute the marked literal ONCE', () => {
    const run = makeRun({
      run_phase: 'running',
      updated_at: NOW.toISOString(),
      evidence: [
        snap({
          step_id: 'classify',
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            structured_output: {
              requested: true,
              sent: false,
              downgrade_reason: 'unsupported_context_tools',
              tool_args: {
                tools: [
                  {
                    name: 'a',
                    strict_requested: true,
                    strict_sent: false,
                    reasons: ['api_rejected_schema'],
                  },
                  {
                    name: 'b',
                    strict_requested: true,
                    strict_sent: false,
                    reasons: ['api_rejected_schema'],
                  },
                ],
              },
            },
          },
        }),
      ],
    });
    expect(classifyRunHealth(run, { now: NOW })[0]!.evidence).toEqual({
      steps: [
        {
          step: 'classify',
          reasons: ['unsupported_context_tools', 'tool_args:api_rejected_schema'],
        },
      ],
    });
  });
});
