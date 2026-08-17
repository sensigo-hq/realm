// Unit tests for findEligibleSteps, triggerRuleSatisfied, evaluateWhenCondition,
// and deriveRunPhase — the DAG eligibility predicates.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findEligibleSteps,
  findEligibleGuardSteps,
  triggerRuleSatisfied,
  evaluateWhenCondition,
  evaluateWhen,
  deriveRunPhase,
  propagateSkips,
  isWorkflowComplete,
  buildEvidenceByStep,
  buildSettlementNamespace,
} from './eligibility.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import type { RunRecord, PendingGate, EvidenceSnapshot } from '../types/run-record.js';

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    workflow_id: 'test-wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 0,
    params: {},
    evidence: [],
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    terminal_state: false,
    ...overrides,
  };
}

function makeStep(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return { description: 'Test step', execution: 'agent', ...overrides };
}

function makeWorkflow(steps: Record<string, Partial<StepDefinition>>): WorkflowDefinition {
  return {
    id: 'test-wf',
    name: 'Test Workflow',
    version: 1,
    steps: Object.fromEntries(
      Object.entries(steps).map(([name, overrides]) => [name, makeStep(overrides)]),
    ),
  };
}

// ---------------------------------------------------------------------------
// deriveRunPhase
// ---------------------------------------------------------------------------

describe('deriveRunPhase', () => {
  it('returns gate_waiting when pending_gate is set', () => {
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'step-a',
      choices: ['approve'],
      opened_at: new Date().toISOString(),
      preview: {},
    };
    expect(
      deriveRunPhase({
        pending_gate: gate,
        terminal_state: false,
        failed_steps: [],
      }),
    ).toBe('gate_waiting');
  });

  it('returns running when not terminal', () => {
    expect(
      deriveRunPhase({
        terminal_state: false,
        failed_steps: [],
      }),
    ).toBe('running');
  });

  it('returns completed when terminal_reason is Workflow completed.', () => {
    expect(
      deriveRunPhase({
        terminal_state: true,
        failed_steps: [],
        terminal_reason: 'Workflow completed.',
      }),
    ).toBe('completed');
  });

  it('returns completed even when failed_steps is non-empty if terminal_reason is Workflow completed. (recovery workflow)', () => {
    expect(
      deriveRunPhase({
        terminal_state: true,
        failed_steps: ['main_step'],
        terminal_reason: 'Workflow completed.',
      }),
    ).toBe('completed');
  });

  it('returns failed when terminal and failed_steps is non-empty without Workflow completed. reason', () => {
    expect(
      deriveRunPhase({
        terminal_state: true,
        failed_steps: ['step-a'],
        terminal_reason: "Step 'step-a' failed: error",
      }),
    ).toBe('failed');
  });

  it('returns abandoned when terminal, no failed steps, and reason is not Workflow completed.', () => {
    expect(
      deriveRunPhase({
        terminal_state: true,
        failed_steps: [],
        terminal_reason: 'Marked abandoned by realm cleanup',
      }),
    ).toBe('abandoned');
  });

  it('returns aborted when aborted_at is set', () => {
    expect(
      deriveRunPhase({
        terminal_state: true,
        failed_steps: [],
        terminal_reason: 'Guard step aborted run.',
        aborted_at: {
          step_id: 'guard_step',
          conditions: [
            { condition: "step_a.status == 'open'", resolved_value: 'closed', passed: false },
          ],
        },
      }),
    ).toBe('aborted');
  });

  it('returns aborted even when failed_steps is non-empty if aborted_at is set', () => {
    expect(
      deriveRunPhase({
        terminal_state: true,
        failed_steps: ['some_step'],
        terminal_reason: 'Guard aborted.',
        aborted_at: {
          step_id: 'guard_step',
          conditions: [{ condition: 'step_a.enabled', resolved_value: false, passed: false }],
        },
      }),
    ).toBe('aborted');
  });

  it('returns abandoned when abandoned_at is set (authoritative), even with failed_steps + a non-completed reason', () => {
    expect(
      deriveRunPhase({
        terminal_state: true,
        failed_steps: ['main_step'],
        terminal_reason: 'Abandoned via abandon_run',
        abandoned_at: '2026-06-26T00:00:00.000Z',
      }),
    ).toBe('abandoned');
  });

  it('abandoned_at outranks a Workflow completed. reason (authoritative marker wins)', () => {
    expect(
      deriveRunPhase({
        terminal_state: true,
        failed_steps: [],
        terminal_reason: 'Workflow completed.',
        abandoned_at: '2026-06-26T00:00:00.000Z',
      }),
    ).toBe('abandoned');
  });
});

// ---------------------------------------------------------------------------
// trigger_rule variants
// ---------------------------------------------------------------------------

describe('triggerRuleSatisfied', () => {
  it('all_success (default): eligible when all deps are completed and none failed', () => {
    const step = makeStep({ depends_on: ['a', 'b'] });
    const run = makeRun({ completed_steps: ['a', 'b'] });
    expect(triggerRuleSatisfied(step, run)).toBe(true);
  });

  it('all_success: not eligible when any dep is in failed_steps', () => {
    const step = makeStep({ depends_on: ['a', 'b'] });
    const run = makeRun({ completed_steps: ['a'], failed_steps: ['b'] });
    expect(triggerRuleSatisfied(step, run)).toBe(false);
  });

  it('all_success: not eligible when a dep is still pending', () => {
    const step = makeStep({ depends_on: ['a', 'b'] });
    const run = makeRun({ completed_steps: ['a'] }); // b neither completed nor failed
    expect(triggerRuleSatisfied(step, run)).toBe(false);
  });

  it('all_failed: eligible when all deps are in failed_steps', () => {
    const step = makeStep({ depends_on: ['a', 'b'], trigger_rule: 'all_failed' });
    const run = makeRun({ failed_steps: ['a', 'b'] });
    expect(triggerRuleSatisfied(step, run)).toBe(true);
  });

  it('all_failed: not eligible when only one dep failed', () => {
    const step = makeStep({ depends_on: ['a', 'b'], trigger_rule: 'all_failed' });
    const run = makeRun({ completed_steps: ['a'], failed_steps: ['b'] });
    expect(triggerRuleSatisfied(step, run)).toBe(false);
  });

  it('all_done: eligible when all deps are completed or failed', () => {
    const step = makeStep({ depends_on: ['a', 'b'], trigger_rule: 'all_done' });
    const run = makeRun({ completed_steps: ['a'], failed_steps: ['b'] });
    expect(triggerRuleSatisfied(step, run)).toBe(true);
  });

  it('all_done: eligible when all deps are completed, failed, or skipped', () => {
    const step = makeStep({ depends_on: ['a', 'b', 'c'], trigger_rule: 'all_done' });
    const run = makeRun({ completed_steps: ['a'], failed_steps: ['b'], skipped_steps: ['c'] });
    expect(triggerRuleSatisfied(step, run)).toBe(true);
  });

  it('all_done: not eligible when a dep is still pending', () => {
    const step = makeStep({ depends_on: ['a', 'b'], trigger_rule: 'all_done' });
    const run = makeRun({ completed_steps: ['a'] }); // b still pending
    expect(triggerRuleSatisfied(step, run)).toBe(false);
  });

  it('one_failed: eligible when at least one dep is in failed_steps', () => {
    const step = makeStep({ depends_on: ['a', 'b'], trigger_rule: 'one_failed' });
    const run = makeRun({ completed_steps: ['a'], failed_steps: ['b'] });
    expect(triggerRuleSatisfied(step, run)).toBe(true);
  });

  it('one_failed: not eligible when no dep has failed', () => {
    const step = makeStep({ depends_on: ['a', 'b'], trigger_rule: 'one_failed' });
    const run = makeRun({ completed_steps: ['a'] }); // b still pending, none failed
    expect(triggerRuleSatisfied(step, run)).toBe(false);
  });

  it('one_success: eligible when at least one dep is in completed_steps', () => {
    const step = makeStep({ depends_on: ['a', 'b'], trigger_rule: 'one_success' });
    const run = makeRun({ completed_steps: ['a'], failed_steps: ['b'] });
    expect(triggerRuleSatisfied(step, run)).toBe(true);
  });

  it('one_success: not eligible when no dep has completed', () => {
    const step = makeStep({ depends_on: ['a', 'b'], trigger_rule: 'one_success' });
    const run = makeRun({ failed_steps: ['a'] }); // none completed
    expect(triggerRuleSatisfied(step, run)).toBe(false);
  });

  it('none_failed: eligible when all deps are completed or skipped and none failed', () => {
    const step = makeStep({ depends_on: ['a', 'b'], trigger_rule: 'none_failed' });
    const run = makeRun({ completed_steps: ['a'], skipped_steps: ['b'] });
    expect(triggerRuleSatisfied(step, run)).toBe(true);
  });

  it('none_failed: not eligible when any dep is in failed_steps', () => {
    const step = makeStep({ depends_on: ['a', 'b'], trigger_rule: 'none_failed' });
    const run = makeRun({ completed_steps: ['a'], failed_steps: ['b'] });
    expect(triggerRuleSatisfied(step, run)).toBe(false);
  });

  it('step with no depends_on is always eligible at the trigger-rule level', () => {
    const step = makeStep({ depends_on: [] });
    expect(triggerRuleSatisfied(step, makeRun())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// when-condition evaluation
// ---------------------------------------------------------------------------

describe('evaluateWhenCondition', () => {
  it('equality: truthy when step output matches expected string', () => {
    const evidence = { classify: { category: 'billing' } };
    expect(evaluateWhenCondition("classify.category == 'billing'", evidence)).toBe(true);
  });

  it('equality: falsy when step output does not match', () => {
    const evidence = { classify: { category: 'technical' } };
    expect(evaluateWhenCondition("classify.category == 'billing'", evidence)).toBe(false);
  });

  it('numeric comparison: truthy when value exceeds threshold', () => {
    const evidence = { classify: { confidence: 0.9 } };
    expect(evaluateWhenCondition('classify.confidence > 0.8', evidence)).toBe(true);
  });

  it('numeric comparison: falsy when value is below threshold', () => {
    const evidence = { classify: { confidence: 0.5 } };
    expect(evaluateWhenCondition('classify.confidence > 0.8', evidence)).toBe(false);
  });

  it('inequality operator', () => {
    const evidence = { step_a: { status: 'error' } };
    expect(evaluateWhenCondition("step_a.status != 'success'", evidence)).toBe(true);
    expect(evaluateWhenCondition("step_a.status != 'error'", evidence)).toBe(false);
  });

  it('returns false when path is missing from evidence', () => {
    const evidence = { classify: {} };
    expect(evaluateWhenCondition("classify.missing_field == 'billing'", evidence)).toBe(false);
  });

  it('unquoted string rhs treated as bareword for equality', () => {
    const evidence = { step_a: { confidence: 'high' } };
    expect(evaluateWhenCondition('step_a.confidence == high', evidence)).toBe(true);
  });

  it('quote-aware: an operator inside the quoted RHS does not mis-split', () => {
    const evidence = { step_a: { subject: 'a >= b' } };
    expect(evaluateWhenCondition("step_a.subject == 'a >= b'", evidence)).toBe(true);
    expect(evaluateWhenCondition("step_a.subject == 'a >= c'", evidence)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateWhenCondition — 1c absent/present-null truth-table (the corrected semantics)
// ---------------------------------------------------------------------------

describe('evaluateWhenCondition — 1c absent-LHS / present-null semantics', () => {
  const absent = { step_a: {} }; // step_a.missing is absent
  const presentNull = { step_a: { v: null } }; // step_a.v is present and null

  // CHANGED rows (were untested; load-bearing)
  it('absent == null → true (was false)', () => {
    expect(evaluateWhenCondition('step_a.missing == null', absent)).toBe(true);
  });
  it('absent != null → false (was true — the incident)', () => {
    expect(evaluateWhenCondition('step_a.missing != null', absent)).toBe(false);
  });
  it("absent != '<non-null literal>' → false (was true)", () => {
    expect(evaluateWhenCondition("step_a.missing != 'shadow'", absent)).toBe(false);
  });
  it('present-null >= 0 / <= 0 / > / < → false (numeric guard; was true via null→0)', () => {
    expect(evaluateWhenCondition('step_a.v >= 0', presentNull)).toBe(false);
    expect(evaluateWhenCondition('step_a.v <= 0', presentNull)).toBe(false);
    expect(evaluateWhenCondition('step_a.v > -1', presentNull)).toBe(false);
    expect(evaluateWhenCondition('step_a.v < 1', presentNull)).toBe(false);
  });

  // UNCHANGED rows (regression guards)
  it("absent == '<non-null literal>' → false (unchanged)", () => {
    expect(evaluateWhenCondition("step_a.missing == 'shadow'", absent)).toBe(false);
  });
  it('absent relational (>= n etc.) → false (unchanged)', () => {
    expect(evaluateWhenCondition('step_a.missing >= 1', absent)).toBe(false);
    expect(evaluateWhenCondition('step_a.missing < 1', absent)).toBe(false);
  });
  it('present-null == null → true, != null → false (unchanged)', () => {
    expect(evaluateWhenCondition('step_a.v == null', presentNull)).toBe(true);
    expect(evaluateWhenCondition('step_a.v != null', presentNull)).toBe(false);
  });
  it("present-null == '<non-null>' → false, != '<non-null>' → true (unchanged)", () => {
    expect(evaluateWhenCondition("step_a.v == 'x'", presentNull)).toBe(false);
    expect(evaluateWhenCondition("step_a.v != 'x'", presentNull)).toBe(true);
  });
  it('resolved relational still works (present number)', () => {
    expect(evaluateWhenCondition('step_a.n >= 3', { step_a: { n: 3 } })).toBe(true);
    expect(evaluateWhenCondition('step_a.n >= 3', { step_a: { n: 2 } })).toBe(false);
  });
  it('bare path → Boolean(value), unchanged', () => {
    expect(evaluateWhenCondition('step_a.flag', { step_a: { flag: true } })).toBe(true);
    expect(evaluateWhenCondition('step_a.flag', { step_a: { flag: false } })).toBe(false);
    expect(evaluateWhenCondition('step_a.flag', { step_a: {} })).toBe(false);
  });

  it("run.params.mode != 'shadow' SKIPS (false) when mode is absent (deliberate flip)", () => {
    expect(evaluateWhenCondition("run.params.mode != 'shadow'", {}, {})).toBe(false);
    // and still fires when mode is present and not 'shadow'
    expect(evaluateWhenCondition("run.params.mode != 'shadow'", {}, { mode: 'live' })).toBe(true);
  });

  it('a compound string reaching runtime (load normally rejects it) → false', () => {
    expect(
      evaluateWhenCondition('step_a.x == 1 and step_a.y == 2', { step_a: { x: 1, y: 2 } }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateWhen — string[] implicit AND folding (Change 3)
// ---------------------------------------------------------------------------

describe('evaluateWhen — implicit AND folding', () => {
  const evidence = { a: { ok: true }, b: { key: 'x' } };

  it('a single string behaves as one leaf', () => {
    expect(evaluateWhen('a.ok == true', evidence)).toBe(true);
    expect(evaluateWhen('a.ok == false', evidence)).toBe(false);
  });

  it('an array ANDs its leaves (all true → true)', () => {
    expect(evaluateWhen(['a.ok == true', 'b.key != null'], evidence)).toBe(true);
  });

  it('an array is false if any leaf is false', () => {
    expect(evaluateWhen(['a.ok == true', "b.key == 'nope'"], evidence)).toBe(false);
  });

  it('a bare-path leaf inside an array is preserved', () => {
    expect(evaluateWhen(['a.ok', 'b.key != null'], evidence)).toBe(true);
    expect(evaluateWhen(['a.ok', 'b.missing'], evidence)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateWhenCondition — run.params
// ---------------------------------------------------------------------------

describe('evaluateWhenCondition — run.params', () => {
  it("run.params.mode == 'live' is true when runParams = { mode: 'live' }", () => {
    expect(evaluateWhenCondition("run.params.mode == 'live'", {}, { mode: 'live' })).toBe(true);
  });

  it("run.params.mode == 'live' is false when runParams = { mode: 'shadow' }", () => {
    expect(evaluateWhenCondition("run.params.mode == 'live'", {}, { mode: 'shadow' })).toBe(false);
  });

  it('run.params.threshold >= 3 is true when threshold is 3', () => {
    expect(evaluateWhenCondition('run.params.threshold >= 3', {}, { threshold: 3 })).toBe(true);
  });

  it('run.params.threshold >= 3 is false when threshold is 2', () => {
    expect(evaluateWhenCondition('run.params.threshold >= 3', {}, { threshold: 2 })).toBe(false);
  });

  it('existing step evidence tests still pass when runParams = {}', () => {
    const evidence = { classify: { category: 'billing' } };
    expect(evaluateWhenCondition("classify.category == 'billing'", evidence, {})).toBe(true);
    expect(
      evaluateWhenCondition(
        "classify.category == 'billing'",
        { classify: { category: 'other' } },
        {},
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findEligibleSteps — gate serialization
// ---------------------------------------------------------------------------

describe('findEligibleSteps — gate serialization', () => {
  it('returns empty array when a gate is open, even if steps would otherwise be eligible', () => {
    const definition = makeWorkflow({ 'step-a': {} });
    const run = makeRun({
      pending_gate: {
        gate_id: 'gate-1',
        step_name: 'step-a',
        choices: ['approve'],
        opened_at: new Date().toISOString(),
        preview: {},
      },
    });
    expect(findEligibleSteps(definition, run)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findEligibleSteps — fan-out: multiple eligible steps
// ---------------------------------------------------------------------------

describe('findEligibleSteps — fan-out', () => {
  it('returns all root steps when none have depends_on and none are settled', () => {
    const definition = makeWorkflow({
      'step-a': { depends_on: [] },
      'step-b': { depends_on: [] },
      'step-c': { depends_on: [] },
    });
    const result = findEligibleSteps(definition, makeRun());
    expect(result).toHaveLength(3);
    expect(result).toContain('step-a');
    expect(result).toContain('step-b');
    expect(result).toContain('step-c');
  });

  it('returns parallel fan-out steps when their shared upstream dep is completed', () => {
    const definition = makeWorkflow({
      'step-a': { depends_on: [] },
      'step-b': { depends_on: ['step-a'] },
      'step-c': { depends_on: ['step-a'] },
    });
    const run = makeRun({ completed_steps: ['step-a'] });
    const result = findEligibleSteps(definition, run);
    expect(result).toHaveLength(2);
    expect(result).toContain('step-b');
    expect(result).toContain('step-c');
  });
});

// ---------------------------------------------------------------------------
// findEligibleSteps — convergence
// ---------------------------------------------------------------------------

describe('findEligibleSteps — convergence', () => {
  it('convergence step is not eligible until all upstream deps are completed', () => {
    const definition = makeWorkflow({
      'step-a': { depends_on: [] },
      'step-b': { depends_on: [] },
      'step-c': { depends_on: ['step-a', 'step-b'] },
    });

    // Only step-a done — step-c not yet eligible.
    const partial = makeRun({ completed_steps: ['step-a'] });
    const result1 = findEligibleSteps(definition, partial);
    expect(result1).not.toContain('step-c');
    expect(result1).toContain('step-b'); // step-b still eligible

    // Both done — step-c is now eligible.
    const full = makeRun({ completed_steps: ['step-a', 'step-b'] });
    const result2 = findEligibleSteps(definition, full);
    expect(result2).toContain('step-c');
    expect(result2).not.toContain('step-a'); // already completed
    expect(result2).not.toContain('step-b'); // already completed
  });
});

// ---------------------------------------------------------------------------
// findEligibleSteps — skip propagation
// ---------------------------------------------------------------------------

describe('findEligibleSteps — skip propagation', () => {
  it('downstream step with all_success is not eligible when its dep fails', () => {
    const definition = makeWorkflow({
      'main-step': { depends_on: [] },
      'success-path': { depends_on: ['main-step'], trigger_rule: 'all_success' },
    });
    const run = makeRun({ failed_steps: ['main-step'] });
    const result = findEligibleSteps(definition, run);
    expect(result).not.toContain('success-path');
  });

  it('recovery step with one_failed IS eligible when its dep fails', () => {
    const definition = makeWorkflow({
      'main-step': { depends_on: [] },
      'recovery-step': { depends_on: ['main-step'], trigger_rule: 'one_failed' },
    });
    const run = makeRun({ failed_steps: ['main-step'] });
    const result = findEligibleSteps(definition, run);
    expect(result).toContain('recovery-step');
  });

  it('when-condition prevents step eligibility when evidence does not match', () => {
    const definition = makeWorkflow({
      classify: { depends_on: [] },
      'billing-handler': {
        depends_on: ['classify'],
        when: "classify.category == 'billing'",
      },
      'tech-handler': {
        depends_on: ['classify'],
        when: "classify.category == 'technical'",
      },
    });
    const run = makeRun({
      completed_steps: ['classify'],
      evidence: [
        {
          step_id: 'classify',
          started_at: '',
          completed_at: '',
          duration_ms: 0,
          input_summary: {},
          output_summary: { category: 'billing' },
          status: 'success',
          evidence_hash: 'abc',
        },
      ],
    });
    const result = findEligibleSteps(definition, run);
    expect(result).toContain('billing-handler');
    expect(result).not.toContain('tech-handler');
  });
});

// ---------------------------------------------------------------------------
// propagateSkips
// ---------------------------------------------------------------------------

describe('propagateSkips', () => {
  // NOTE (issue #111): propagateSkips' return shape changed from string[] to
  // { skipped, details } — every assertion below reads `.skipped` now. This is a stale-not-
  // regression update to the RETURN-SHAPE ONLY; the underlying skip-computation behavior these
  // tests pin is unchanged (confirmed: every test below still passes with the same semantics).
  it('marks a downstream all_success step as skipped when its dep fails', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_success' },
    });
    const run = makeRun({ failed_steps: ['a'] });
    expect(propagateSkips(run, definition).skipped).toContain('b');
  });

  it('marks a downstream none_failed step as skipped when its dep fails', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'none_failed' },
    });
    const run = makeRun({ failed_steps: ['a'] });
    expect(propagateSkips(run, definition).skipped).toContain('b');
  });

  it('marks a downstream all_failed step as skipped when its dep completes', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_failed' },
    });
    const run = makeRun({ completed_steps: ['a'] });
    expect(propagateSkips(run, definition).skipped).toContain('b');
  });

  it('marks a downstream one_failed step as skipped when all deps complete', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: [] },
      c: { depends_on: ['a', 'b'], trigger_rule: 'one_failed' },
    });
    const run = makeRun({ completed_steps: ['a', 'b'] });
    expect(propagateSkips(run, definition).skipped).toContain('c');
  });

  it('marks a downstream one_success step as skipped when all deps fail', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: [] },
      c: { depends_on: ['a', 'b'], trigger_rule: 'one_success' },
    });
    const run = makeRun({ failed_steps: ['a', 'b'] });
    expect(propagateSkips(run, definition).skipped).toContain('c');
  });

  it('does not skip an all_done step — all_done is always eventually satisfiable', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_done' },
    });
    const run = makeRun({ failed_steps: ['a'] });
    expect(propagateSkips(run, definition).skipped).not.toContain('b');
  });

  it('cascades: skipping B causes C (all_success on [B]) to also be skipped', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_success' },
      c: { depends_on: ['b'], trigger_rule: 'all_success' },
    });
    const run = makeRun({ failed_steps: ['a'] });
    const result = propagateSkips(run, definition).skipped;
    expect(result).toContain('b');
    expect(result).toContain('c');
  });

  it('does not duplicate an already-skipped step', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_success' },
    });
    const run = makeRun({ failed_steps: ['a'], skipped_steps: ['b'] });
    const result = propagateSkips(run, definition).skipped;
    expect(result.filter((s) => s === 'b')).toHaveLength(1);
  });

  it('does not skip completed or failed steps', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: [] },
    });
    const run = makeRun({ completed_steps: ['a'], failed_steps: ['b'] });
    const result = propagateSkips(run, definition).skipped;
    expect(result).not.toContain('a');
    expect(result).not.toContain('b');
  });

  it('does not skip a one_failed step when some deps are still unsettled', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: [] },
      c: { depends_on: ['a', 'b'], trigger_rule: 'one_failed' },
    });
    // a completed, b is still pending and might yet fail
    const run = makeRun({ completed_steps: ['a'] });
    expect(propagateSkips(run, definition).skipped).not.toContain('c');
  });

  it('preserves existing skipped_steps in the returned array', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_success' },
      c: { depends_on: [] },
    });
    const run = makeRun({ failed_steps: ['a'], skipped_steps: ['c'] });
    const result = propagateSkips(run, definition).skipped;
    expect(result).toContain('b');
    expect(result).toContain('c');
  });

  it('does not skip a step whose one_success dep has already completed', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: [] },
      c: { depends_on: ['a', 'b'], trigger_rule: 'one_success' },
    });
    // a completed — one_success is already satisfiable
    const run = makeRun({ completed_steps: ['a'], failed_steps: ['b'] });
    expect(propagateSkips(run, definition).skipped).not.toContain('c');
  });

  it('skips a routing step when its dep completes and the when-condition is false', () => {
    const definition = makeWorkflow({
      classify: { depends_on: [] },
      route_billing: {
        depends_on: ['classify'],
        when: 'classify.category == billing',
      },
    });
    const run = makeRun({
      completed_steps: ['classify'],
      evidence: [
        {
          step_id: 'classify',
          started_at: '',
          completed_at: '',
          duration_ms: 0,
          input_summary: {},
          output_summary: { category: 'bug' },
          status: 'success',
          evidence_hash: 'abc',
        },
      ],
    });
    expect(propagateSkips(run, definition).skipped).toContain('route_billing');
  });

  it('does not skip a routing step when the when-condition is true', () => {
    const definition = makeWorkflow({
      classify: { depends_on: [] },
      route_billing: {
        depends_on: ['classify'],
        when: 'classify.category == billing',
      },
    });
    const run = makeRun({
      completed_steps: ['classify'],
      evidence: [
        {
          step_id: 'classify',
          started_at: '',
          completed_at: '',
          duration_ms: 0,
          input_summary: {},
          output_summary: { category: 'billing' },
          status: 'success',
          evidence_hash: 'abc',
        },
      ],
    });
    expect(propagateSkips(run, definition).skipped).not.toContain('route_billing');
  });

  it('does not skip a routing step when its dep is still in-progress', () => {
    const definition = makeWorkflow({
      classify: { depends_on: [] },
      route_billing: {
        depends_on: ['classify'],
        when: 'classify.category == billing',
      },
    });
    // classify is in-progress — deps are not settled, condition cannot be evaluated yet
    const run = makeRun({ in_progress_steps: ['classify'] });
    expect(propagateSkips(run, definition).skipped).not.toContain('route_billing');
  });

  it('cascade: skipping a when-condition step causes its downstream all_success step to also skip', () => {
    const definition = makeWorkflow({
      classify: { depends_on: [] },
      route_billing: {
        depends_on: ['classify'],
        when: 'classify.category == billing',
      },
      notify_billing: {
        depends_on: ['route_billing'],
        trigger_rule: 'all_success',
      },
    });
    const run = makeRun({
      completed_steps: ['classify'],
      evidence: [
        {
          step_id: 'classify',
          started_at: '',
          completed_at: '',
          duration_ms: 0,
          input_summary: {},
          output_summary: { category: 'bug' },
          status: 'success',
          evidence_hash: 'abc',
        },
      ],
    });
    const result = propagateSkips(run, definition).skipped;
    expect(result).toContain('route_billing');
    expect(result).toContain('notify_billing');
  });
});

// ---------------------------------------------------------------------------
// propagateSkips — trigger_rule_unsatisfiable witness (issue #111)
// canTriggerRuleEverBeSatisfied is module-private; its witness is exercised through
// propagateSkips' returned `details[stepName].blocking_deps`, its only caller.
// ---------------------------------------------------------------------------

describe('propagateSkips — trigger_rule_unsatisfiable witness (issue #111)', () => {
  it('all_success: blocking_deps names exactly the failed-or-skipped deps, not the completed one', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: [] },
      c: { depends_on: [] },
      d: { depends_on: ['a', 'b', 'c'], trigger_rule: 'all_success' },
    });
    const run = makeRun({ failed_steps: ['a'], skipped_steps: ['b'], completed_steps: ['c'] });
    const { details } = propagateSkips(run, definition);
    const detail = details['d'];
    if (detail?.kind !== 'trigger_rule_unsatisfiable')
      throw new Error('expected trigger_rule_unsatisfiable');
    expect(detail.rule).toBe('all_success');
    expect(detail.blocking_deps).toEqual(
      expect.arrayContaining([
        { dep: 'a', state: 'failed' },
        { dep: 'b', state: 'skipped' },
      ]),
    );
    expect(detail.blocking_deps).toHaveLength(2);
  });

  it('all_failed: blocking_deps names the completed-or-skipped deps', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: [] },
      c: { depends_on: ['a', 'b'], trigger_rule: 'all_failed' },
    });
    const run = makeRun({ completed_steps: ['a'], skipped_steps: ['b'] });
    const { details } = propagateSkips(run, definition);
    const detail = details['c'];
    if (detail?.kind !== 'trigger_rule_unsatisfiable')
      throw new Error('expected trigger_rule_unsatisfiable');
    expect(detail.rule).toBe('all_failed');
    expect(detail.blocking_deps).toEqual(
      expect.arrayContaining([
        { dep: 'a', state: 'completed' },
        { dep: 'b', state: 'skipped' },
      ]),
    );
    expect(detail.blocking_deps).toHaveLength(2);
  });

  it('all_done: never unsatisfiable — no skip_details entry is ever created for it', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_done' },
    });
    const run = makeRun({ failed_steps: ['a'] });
    const { details } = propagateSkips(run, definition);
    expect(details['b']).toBeUndefined();
  });

  it('one_failed: unsatisfiable witness names ALL deps (collective exhaustion), never a subset', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: [] },
      c: { depends_on: ['a', 'b'], trigger_rule: 'one_failed' },
    });
    const run = makeRun({ completed_steps: ['a'], skipped_steps: ['b'] });
    const { details } = propagateSkips(run, definition);
    const detail = details['c'];
    if (detail?.kind !== 'trigger_rule_unsatisfiable')
      throw new Error('expected trigger_rule_unsatisfiable');
    expect(detail.rule).toBe('one_failed');
    expect(detail.blocking_deps).toEqual(
      expect.arrayContaining([
        { dep: 'a', state: 'completed' },
        { dep: 'b', state: 'skipped' },
      ]),
    );
    expect(detail.blocking_deps).toHaveLength(2); // ALL deps, not a subset
  });

  it('one_success: unsatisfiable witness names ALL deps (collective exhaustion), never a subset', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: [] },
      c: { depends_on: ['a', 'b'], trigger_rule: 'one_success' },
    });
    const run = makeRun({ failed_steps: ['a'], skipped_steps: ['b'] });
    const { details } = propagateSkips(run, definition);
    const detail = details['c'];
    if (detail?.kind !== 'trigger_rule_unsatisfiable')
      throw new Error('expected trigger_rule_unsatisfiable');
    expect(detail.rule).toBe('one_success');
    expect(detail.blocking_deps).toEqual(
      expect.arrayContaining([
        { dep: 'a', state: 'failed' },
        { dep: 'b', state: 'skipped' },
      ]),
    );
    expect(detail.blocking_deps).toHaveLength(2);
  });

  it('none_failed: blocking_deps names only the failed dep, not an unsettled one', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: [] },
      c: { depends_on: ['a', 'b'], trigger_rule: 'none_failed' },
    });
    // a failed (blocks it); b is still unsettled — none_failed only cares about failures.
    const run = makeRun({ failed_steps: ['a'] });
    const { details } = propagateSkips(run, definition);
    const detail = details['c'];
    if (detail?.kind !== 'trigger_rule_unsatisfiable')
      throw new Error('expected trigger_rule_unsatisfiable');
    expect(detail.rule).toBe('none_failed');
    expect(detail.blocking_deps).toEqual([{ dep: 'a', state: 'failed' }]);
  });
});

// ---------------------------------------------------------------------------
// propagateSkips — when_false trace (issue #111)
// traceWhenCondition is module-private; exercised through propagateSkips' returned
// `details[stepName].leaves`, its only call site.
// ---------------------------------------------------------------------------

describe('propagateSkips — when_false trace (issue #111)', () => {
  const classifyEvidence = (output: Record<string, unknown>) => [
    {
      step_id: 'classify',
      started_at: '',
      completed_at: '',
      duration_ms: 0,
      input_summary: {},
      output_summary: output,
      status: 'success' as const,
      evidence_hash: 'abc',
    },
  ];

  it('multi-leaf AND: records EVERY leaf, not just the first false one (false leaf is in the MIDDLE, proving no short-circuit)', () => {
    const definition = makeWorkflow({
      classify: { depends_on: [] },
      route: {
        depends_on: ['classify'],
        when: [
          'classify.category == billing',
          'classify.priority == high', // the false leaf — NOT the last one
          'classify.region == us',
        ],
      },
    });
    const run = makeRun({
      completed_steps: ['classify'],
      evidence: classifyEvidence({ category: 'billing', priority: 'low', region: 'us' }),
    });
    const { details } = propagateSkips(run, definition);
    const detail = details['route'];
    if (detail?.kind !== 'when_false') throw new Error('expected when_false');
    // A short-circuit-at-first-false implementation would stop after leaf[1] and never
    // record leaf[2] — asserting length 3 (and leaf[2]'s content) is what catches that.
    expect(detail.leaves).toHaveLength(3);
    expect(detail.leaves[0]).toEqual({
      leaf: 'classify.category == billing',
      lhs_present: true,
      resolved_value: 'billing',
      passed: true,
    });
    expect(detail.leaves[1]).toEqual({
      leaf: 'classify.priority == high',
      lhs_present: true,
      resolved_value: 'low',
      passed: false,
    });
    expect(detail.leaves[2]).toEqual({
      leaf: 'classify.region == us',
      lhs_present: true,
      resolved_value: 'us',
      passed: true,
    });
  });

  it('a field-name typo (path miss) records lhs_present:false with resolved_value OMITTED, not undefined', () => {
    const definition = makeWorkflow({
      classify: { depends_on: [] },
      route: { depends_on: ['classify'], when: 'classify.tcuont >= 0.8' }, // typo'd field
    });
    const run = makeRun({
      completed_steps: ['classify'],
      evidence: classifyEvidence({ count: 0.9 }),
    });
    const { details } = propagateSkips(run, definition);
    const detail = details['route'];
    if (detail?.kind !== 'when_false') throw new Error('expected when_false');
    expect(detail.leaves).toHaveLength(1);
    const leaf = detail.leaves[0]!;
    expect(leaf.lhs_present).toBe(false);
    expect(leaf.passed).toBe(false);
    expect('resolved_value' in leaf).toBe(false);
    // The absence must survive a JSON round-trip — this is the durable typo signal.
    expect(JSON.parse(JSON.stringify(leaf))).not.toHaveProperty('resolved_value');
  });

  it('a present scalar LHS records lhs_present:true with the resolved value', () => {
    const definition = makeWorkflow({
      classify: { depends_on: [] },
      route: { depends_on: ['classify'], when: 'classify.category == billing' },
    });
    const run = makeRun({
      completed_steps: ['classify'],
      evidence: classifyEvidence({ category: 'bug' }),
    });
    const { details } = propagateSkips(run, definition);
    const detail = details['route'];
    if (detail?.kind !== 'when_false') throw new Error('expected when_false');
    expect(detail.leaves[0]).toEqual({
      leaf: 'classify.category == billing',
      lhs_present: true,
      resolved_value: 'bug',
      passed: false,
    });
  });

  it('a compound leaf reaching runtime (kind: invalid) records lhs_present:false, passed:false, no resolved_value', () => {
    // Bypasses load-time rejection (makeWorkflow builds a raw definition, no yaml-loader pass).
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], when: 'a.x == 1 and a.y == 2' },
    });
    const run = makeRun({
      completed_steps: ['a'],
      evidence: [
        {
          step_id: 'a',
          started_at: '',
          completed_at: '',
          duration_ms: 0,
          input_summary: {},
          output_summary: { x: 1, y: 2 },
          status: 'success',
          evidence_hash: 'x',
        },
      ],
    });
    const { details } = propagateSkips(run, definition);
    const detail = details['b'];
    if (detail?.kind !== 'when_false') throw new Error('expected when_false');
    expect(detail.leaves[0]).toMatchObject({ lhs_present: false, passed: false });
    expect('resolved_value' in detail.leaves[0]!).toBe(false);
  });

  it("every leaf's traced passed equals evaluateWhenCondition's own verdict for the same leaf", () => {
    const definition = makeWorkflow({
      classify: { depends_on: [] },
      route: {
        depends_on: ['classify'],
        when: ['classify.category == billing', 'classify.amount > 100'],
      },
    });
    const run = makeRun({
      completed_steps: ['classify'],
      evidence: classifyEvidence({ category: 'billing', amount: 50 }),
    });
    const { details } = propagateSkips(run, definition);
    const detail = details['route'];
    if (detail?.kind !== 'when_false') throw new Error('expected when_false');
    const evidenceByStep = buildEvidenceByStep(run);
    for (const leaf of detail.leaves) {
      expect(leaf.passed).toBe(evaluateWhenCondition(leaf.leaf, evidenceByStep, run.params));
    }
  });
});

// ---------------------------------------------------------------------------
// propagateSkips — skip_details behavioral (issue #111)
// ---------------------------------------------------------------------------

describe('propagateSkips — skip_details behavioral (issue #111)', () => {
  it('Object.keys(details) is always a subset of the returned skipped array', () => {
    const definition = makeWorkflow({
      classify: { depends_on: [] },
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_success' },
      route: { depends_on: ['classify'], when: 'classify.category == billing' },
    });
    const run = makeRun({
      failed_steps: ['a'],
      completed_steps: ['classify'],
      evidence: [
        {
          step_id: 'classify',
          started_at: '',
          completed_at: '',
          duration_ms: 0,
          input_summary: {},
          output_summary: { category: 'bug' },
          status: 'success',
          evidence_hash: 'abc',
        },
      ],
    });
    const { skipped, details } = propagateSkips(run, definition);
    for (const key of Object.keys(details)) {
      expect(skipped).toContain(key);
    }
  });

  it('carries forward run.skip_details across successive calls (does not drop prior detail)', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_success' },
      c: { depends_on: [] },
      d: { depends_on: ['c'], trigger_rule: 'all_success' },
    });
    const run1 = makeRun({ failed_steps: ['a'] });
    const first = propagateSkips(run1, definition);
    expect(first.details['b']?.kind).toBe('trigger_rule_unsatisfiable');

    // A second call, seeded with the FIRST call's skipped_steps/skip_details (mirroring how a
    // caller persists-then-recomputes), now also failing c.
    const run2 = makeRun({
      failed_steps: ['a', 'c'],
      skipped_steps: first.skipped,
      skip_details: first.details,
    });
    const second = propagateSkips(run2, definition);
    expect(second.details['b']).toEqual(first.details['b']); // carried forward, unchanged
    expect(second.details['d']?.kind).toBe('trigger_rule_unsatisfiable'); // newly added
  });

  it('produces a trigger_rule_unsatisfiable detail with the documented shape', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_success' },
    });
    const run = makeRun({ failed_steps: ['a'] });
    const { details } = propagateSkips(run, definition);
    expect(details['b']).toEqual({
      kind: 'trigger_rule_unsatisfiable',
      rule: 'all_success',
      blocking_deps: [{ dep: 'a', state: 'failed' }],
    });
  });

  it('produces a when_false detail with the documented shape', () => {
    const definition = makeWorkflow({
      classify: { depends_on: [] },
      route: { depends_on: ['classify'], when: 'classify.category == billing' },
    });
    const run = makeRun({
      completed_steps: ['classify'],
      evidence: [
        {
          step_id: 'classify',
          started_at: '',
          completed_at: '',
          duration_ms: 0,
          input_summary: {},
          output_summary: { category: 'bug' },
          status: 'success',
          evidence_hash: 'abc',
        },
      ],
    });
    const { details } = propagateSkips(run, definition);
    expect(details['route']).toEqual({
      kind: 'when_false',
      expression: 'classify.category == billing',
      leaves: [
        {
          leaf: 'classify.category == billing',
          lhs_present: true,
          resolved_value: 'bug',
          passed: false,
        },
      ],
    });
  });

  it('5-path completeness (1/5): a freshly-created run (no skips yet) yields empty skipped/details — no detail for a step that never skipped', () => {
    const definition = makeWorkflow({ a: { depends_on: [] } });
    const run = makeRun(); // default: skipped_steps: [], no skip_details key at all
    const { skipped, details } = propagateSkips(run, definition);
    expect(skipped).toEqual([]);
    expect(details).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Structural anti-recurrence guard (issue #111, S2) — models the atomicWriteFile grep-guard
// from #132/#130: the set of source sites that GROW a persisted skipped_steps must equal the
// sanctioned whitelist (2 abort direct-pushes in execution-loop.ts + propagateSkips' own 2
// branches in eligibility.ts). A new grow-site outside this whitelist reddens this test.
// ---------------------------------------------------------------------------

describe('structural guard — skipped_steps grow-sites (issue #111)', () => {
  it('eligibility.ts: exactly 2 skipped.push( grow-sites, both inside propagateSkips', async () => {
    const src = await readFile(new URL('./eligibility.ts', import.meta.url), 'utf8');
    const growSites = [...src.matchAll(/\bskipped\.push\(/g)];
    expect(growSites).toHaveLength(2);
    // The excluded, non-grow sites must remain present (seed + scratch, never appends):
    expect(src).toContain('const skipped = [...run.skipped_steps];');
    expect(src).toContain('const tempRun: RunRecord = { ...run, skipped_steps: skipped };');
  });

  it('execution-loop.ts: exactly 2 skipped_steps spread-append grow-sites — the handler-abort and guard-abort direct pushes', async () => {
    const src = await readFile(new URL('./execution-loop.ts', import.meta.url), 'utf8');
    const growSites = [...src.matchAll(/\[\.\.\.[\w.]+\.skipped_steps,\s*[^\]]+\]/g)];
    expect(growSites).toHaveLength(2);
    expect(src).toContain('skipped_steps: [...pendingRun.skipped_steps, options.command],');
    expect(src).toContain('skipped_steps: [...run.skipped_steps, stepName],');
    // No raw .push( on a skipped_steps-shaped array anywhere in this file — every mutation goes
    // through the sanctioned spread-append above or through propagateSkips.
    expect(src).not.toMatch(/skipped_steps\.push\(/);
  });
});

// ---------------------------------------------------------------------------
// claimStep — double-claim prevention
// ---------------------------------------------------------------------------

describe('claimStep — double-claim prevention', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-eligibility-'));
  });

  it('first claimStep adds the step to in_progress_steps', async () => {
    const store = new JsonFileStore(runDir);
    const definition = makeWorkflow({ 'step-a': { depends_on: [] } });
    const { run: run } = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });

    const claimed = await store.claimStep(run.id, 'step-a', definition);
    expect(claimed.in_progress_steps).toContain('step-a');
  });

  it('second claimStep on the same step throws STATE_STEP_ALREADY_CLAIMED', async () => {
    const store = new JsonFileStore(runDir);
    const definition = makeWorkflow({ 'step-a': { depends_on: [] } });
    const { run: run } = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });

    await store.claimStep(run.id, 'step-a', definition);

    await expect(store.claimStep(run.id, 'step-a', definition)).rejects.toThrow(
      /already claimed|already|in.?progress/i,
    );
  });

  it('claimStep on a completed step throws', async () => {
    const store = new JsonFileStore(runDir);
    const definition = makeWorkflow({ 'step-a': { depends_on: [] } });
    const { run: run } = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });
    const claimed = await store.claimStep(run.id, 'step-a', definition);

    // Move step-a to completed_steps.
    await store.update({
      ...claimed,
      in_progress_steps: [],
      completed_steps: ['step-a'],
    });

    await expect(store.claimStep(run.id, 'step-a', definition)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Issue-2: terminal-run eligibility guard
// ---------------------------------------------------------------------------

describe('findEligibleSteps / findEligibleGuardSteps — terminal-run guard', () => {
  it('returns no eligible steps for a terminal aborted run (none_failed downstream of a skipped dep)', () => {
    // Reproduces the bug shape: a guard aborted the run; its downstream none_failed step has only a
    // *skipped* (not failed) dependency, so pre-fix it was returned eligible and re-executed.
    const wf = makeWorkflow({
      guard_step: { execution: 'agent' },
      downstream: { execution: 'agent', depends_on: ['guard_step'], trigger_rule: 'none_failed' },
    });
    const abortedRun = makeRun({
      terminal_state: true,
      run_phase: 'aborted',
      aborted_at: { step_id: 'guard_step' },
      skipped_steps: ['guard_step'], // aborting step skipped, NOT failed
      // 'downstream' left unsettled — none_failed is satisfied (no failed dep), so pre-fix eligible
    });
    expect(findEligibleSteps(wf, abortedRun)).toEqual([]);
  });

  it('returns no eligible guard steps for a terminal aborted run', () => {
    const wf = makeWorkflow({
      check: { execution: 'guard', abort_unless: ['ctx.ok'] },
    });
    const abortedRun = makeRun({
      terminal_state: true,
      run_phase: 'aborted',
      aborted_at: { step_id: 'other' },
      // 'check' guard unsettled — pre-fix it would be returned eligible
    });
    expect(findEligibleGuardSteps(wf, abortedRun)).toEqual([]);
  });

  it('still returns eligible steps for a non-terminal (running) run (guard does not over-fire)', () => {
    const wf = makeWorkflow({ open_step: { execution: 'agent' } });
    const runningRun = makeRun({ terminal_state: false, run_phase: 'running' });
    expect(findEligibleSteps(wf, runningRun)).toEqual(['open_step']);
  });
});

// ---------------------------------------------------------------------------
// Issue-2: deriveRunPhase — aborted_at is authoritative
// ---------------------------------------------------------------------------

describe('deriveRunPhase — aborted_at precedence (Issue-2)', () => {
  const aborted = { step_id: 'guard_step' };

  it('a record carrying aborted_at with terminal_state:false derives back to aborted (the fix)', () => {
    expect(deriveRunPhase(makeRun({ terminal_state: false, aborted_at: aborted }))).toBe('aborted');
  });

  it("aborted_at outranks a stale 'Workflow completed.' reason", () => {
    expect(
      deriveRunPhase(
        makeRun({
          terminal_state: true,
          aborted_at: aborted,
          terminal_reason: 'Workflow completed.',
        }),
      ),
    ).toBe('aborted');
  });

  // Regression matrix — every normal derivation is unchanged by the reorder.
  it('normal aborted run is unchanged', () => {
    expect(
      deriveRunPhase(
        makeRun({ terminal_state: true, aborted_at: aborted, terminal_reason: 'guard aborted' }),
      ),
    ).toBe('aborted');
  });
  it('completed (no aborted_at) is unchanged', () => {
    expect(
      deriveRunPhase(makeRun({ terminal_state: true, terminal_reason: 'Workflow completed.' })),
    ).toBe('completed');
  });
  it('failed (no aborted_at) is unchanged', () => {
    expect(deriveRunPhase(makeRun({ terminal_state: true, failed_steps: ['s'] }))).toBe('failed');
  });
  it('abandoned (no aborted_at) is unchanged', () => {
    expect(deriveRunPhase(makeRun({ terminal_state: true }))).toBe('abandoned');
  });
  it('running (no aborted_at) is unchanged', () => {
    expect(deriveRunPhase(makeRun({ terminal_state: false }))).toBe('running');
  });
  // issue #279 (increment 2, PR-C — the #282 class closure, D-3 leg i): this test's own title and
  // expectation are UPDATED, not preserved verbatim. Under the pre-#282 order, `pending_gate` was
  // checked BEFORE `aborted_at`, so this synthetic fixture (aborted_at set — a combination that
  // never occurs in practice, since aborted_at is only ever written alongside terminal_state:true
  // — co-occurring with a pending_gate and terminal_state:false) derived 'gate_waiting'. The #282
  // reorder moves the WHOLE terminal-indicating cluster (abandoned_at, aborted_at) above
  // pending_gate — aborted_at is part of that cluster, so it now outranks pending_gate too; only
  // a genuinely non-terminal, non-aborted run can still derive 'gate_waiting'.
  it('aborted_at now outranks pending_gate too (the #282 reorder — the WHOLE terminal cluster sits above pending_gate)', () => {
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'review',
      preview: {},
      choices: ['approve', 'reject'],
      opened_at: '2024-01-01T00:00:00.000Z',
    };
    expect(
      deriveRunPhase(makeRun({ pending_gate: gate, terminal_state: false, aborted_at: aborted })),
    ).toBe('aborted');
  });

  // issue #279 (increment 2, PR-C — the #282 CLASS itself): the fail-marker — terminal_state:true
  // + failed_steps non-empty + NO aborted_at, but STILL carrying a leftover pending_gate. Without
  // the gate, the old and new check orders agree (both derive 'failed') and nothing here would
  // red under a revert — the gate is what makes this fixture DISCRIMINATING.
  it('the #282 fail-marker: terminal ∧ failed_steps ∧ a leftover pending_gate still derives failed, never gate_waiting', () => {
    const gate: PendingGate = {
      gate_id: 'g-fail-marker',
      step_name: 'review',
      preview: {},
      choices: ['approve', 'reject'],
      opened_at: '2024-01-01T00:00:00.000Z',
    };
    expect(
      deriveRunPhase(
        makeRun({
          terminal_state: true,
          failed_steps: ['s'],
          pending_gate: gate,
        }),
      ),
    ).toBe('failed');
  });

  // The abort-marker equivalent — aborted_at ∧ terminal_state ∧ a leftover pending_gate. Already
  // exercised structurally by the 'aborted_at now outranks pending_gate too' test above (same
  // discriminating shape: without the gate, nothing reds); restated here under the #282-marker
  // naming for direct correspondence with the fail-marker pin above.
  it('the #282 abort-marker: aborted_at ∧ terminal_state ∧ a leftover pending_gate still derives aborted, never gate_waiting', () => {
    const gate: PendingGate = {
      gate_id: 'g-abort-marker',
      step_name: 'review',
      preview: {},
      choices: ['approve', 'reject'],
      opened_at: '2024-01-01T00:00:00.000Z',
    };
    expect(
      deriveRunPhase(
        makeRun({
          terminal_state: true,
          aborted_at: aborted,
          pending_gate: gate,
        }),
      ),
    ).toBe('aborted');
  });

  it('pending_gate still outranks plain running when neither abandoned_at nor aborted_at is set', () => {
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'review',
      preview: {},
      choices: ['approve', 'reject'],
      opened_at: '2024-01-01T00:00:00.000Z',
    };
    expect(deriveRunPhase(makeRun({ pending_gate: gate, terminal_state: false }))).toBe(
      'gate_waiting',
    );
  });
});

// ---------------------------------------------------------------------------
// execution: finalizer — held out of the DAG (eligibility + completion + skips)
// ---------------------------------------------------------------------------

describe('finalizer steps — held out of the DAG', () => {
  const finalizerWorkflow = makeWorkflow({
    work: { execution: 'agent', depends_on: [] },
    cleanup: { execution: 'finalizer', on_outcome: 'always', handler: 'do_cleanup' },
  });

  it('findEligibleSteps never returns a finalizer (even with its deps trivially satisfied)', () => {
    const run = makeRun();
    expect(findEligibleSteps(finalizerWorkflow, run)).toEqual(['work']);
  });

  it('findEligibleSteps still excludes the finalizer after the domain step completes', () => {
    const run = makeRun({ completed_steps: ['work'] });
    expect(findEligibleSteps(finalizerWorkflow, run)).not.toContain('cleanup');
    expect(findEligibleSteps(finalizerWorkflow, run)).toEqual([]);
  });

  it('findEligibleGuardSteps never returns a finalizer', () => {
    const run = makeRun({ completed_steps: ['work'] });
    expect(findEligibleGuardSteps(finalizerWorkflow, run)).toEqual([]);
  });

  it('isWorkflowComplete is true when only unrun finalizers remain (domain steps all settled)', () => {
    const run = makeRun({ completed_steps: ['work'] });
    expect(isWorkflowComplete(run, finalizerWorkflow)).toBe(true);
  });

  it('isWorkflowComplete is false while a domain step is still unrun', () => {
    const run = makeRun();
    expect(isWorkflowComplete(run, finalizerWorkflow)).toBe(false);
  });

  it('propagateSkips never places a finalizer in skipped_steps', () => {
    const workflow = makeWorkflow({
      a: { execution: 'agent', depends_on: [] },
      b: { execution: 'agent', depends_on: ['a'] }, // all_success — unreachable once a fails
      cleanup: { execution: 'finalizer', on_outcome: 'always', handler: 'do_cleanup' },
    });
    const run = makeRun({ failed_steps: ['a'] });
    const skipped = propagateSkips(run, workflow).skipped;
    expect(skipped).toContain('b');
    expect(skipped).not.toContain('cleanup');
  });

  // deriveRunPhase precedence is UNCHANGED — these pin that a finalizer landing in
  // failed_steps/completed_steps never flips the sealed phase.
  it('deriveRunPhase: a completed run stays completed even with a failed finalizer in failed_steps', () => {
    expect(
      deriveRunPhase(
        makeRun({
          terminal_state: true,
          failed_steps: ['cleanup'], // a finalizer that threw
          terminal_reason: 'Workflow completed.',
        }),
      ),
    ).toBe('completed');
  });

  it('deriveRunPhase: a failed run stays failed even with a completed on_fail finalizer', () => {
    // The on_fail finalizer completed (would be in completed_steps), but deriveRunPhase keys
    // off failed_steps + terminal_reason — the domain failure keeps the phase 'failed'.
    expect(
      deriveRunPhase(
        makeRun({
          terminal_state: true,
          failed_steps: ['work'],
          terminal_reason: "Step 'work' failed: boom",
        }),
      ),
    ).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// buildSettlementNamespace + the `$settlement` mint (issue #220 §4c, PR-3)
// ---------------------------------------------------------------------------

describe('buildSettlementNamespace — the $settlement mint (issue #220 §4c)', () => {
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

  // issue #305 — the discrimination trio in ONE cell. A cleanup handler has to tell three
  // settlement outcomes apart, and the namespace answers all three with two fields plus absence.
  // Keeping them in a single fixture is deliberate: it pins that they are distinguishable from
  // each other, which three separate cells would not.
  it('(#305) failed / completed-defaulted / skipped are discriminable: failed:true · failed:false+settled_by_default:true · NO ENTRY', () => {
    const run = makeRun({
      completed_steps: ['defaulted_step'],
      failed_steps: ['broken_step'],
      skipped_steps: ['skipped_step'],
      evidence: [
        snap({
          step_id: 'defaulted_step',
          diagnostics: {
            input_token_estimate: 1,
            precondition_trace: [],
            settled_by_default: true,
          },
        }),
        snap({ step_id: 'broken_step', status: 'error' }),
        snap({ step_id: 'skipped_step' }),
      ],
    });

    const result = buildSettlementNamespace(run);

    // 1. FAILED — the #305 marker.
    expect(result['broken_step']).toEqual({
      settled_by_default: false,
      validation_rejections: 0,
      failed: true,
    });
    // 2. COMPLETED ON ITS DEFAULT — settled, not failed, and honest about how it settled.
    expect(result['defaulted_step']).toEqual({
      settled_by_default: true,
      validation_rejections: 0,
      failed: false,
    });
    // 3. SKIPPED — absent entirely, even though it HAS evidence. Absence is the signal, and a
    // `when` author tests it with the load-legal `$settlement.skipped_step.failed == null`.
    expect(result).not.toHaveProperty('skipped_step');
    expect(result['skipped_step']?.failed).toBeUndefined();
  });

  it('(ff) membership-gated presence: a clean-settled dep gets a PRESENT entry with settled_by_default === false', () => {
    const run = makeRun({
      completed_steps: ['clean_step'],
      evidence: [snap({ step_id: 'clean_step' })], // no diagnostics at all
    });
    const result = buildSettlementNamespace(run);
    expect(result['clean_step']).toEqual({
      settled_by_default: false,
      validation_rejections: 0,
      failed: false,
    });
  });

  it('(ff) membership-gated presence: an UNSETTLED step with evidence (compensating-unclaim audit / guard-abort) gets NO entry — an evidence-derived-domain mutant would fabricate one', () => {
    const run = makeRun({
      completed_steps: [], // 'audited_step' is NOT here — it never actually settled
      failed_steps: [],
      skipped_steps: ['aborted_guard'], // guard-abort lands in skipped_steps, never completed/failed
      evidence: [
        snap({ step_id: 'audited_step' }), // a compensating-unclaim AUDIT snapshot
        snap({ step_id: 'aborted_guard' }), // guard-abort evidence
      ],
    });
    const result = buildSettlementNamespace(run);
    expect(result['audited_step']).toBeUndefined();
    expect(result['aborted_guard']).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('(ff) a SKIPPED dep (when_false) gets NO entry, even with zero evidence at all', () => {
    const run = makeRun({ skipped_steps: ['skipped_step'], evidence: [] });
    expect(buildSettlementNamespace(run)['skipped_step']).toBeUndefined();
  });

  it('(hh) explicit-false materialization: a settled step whose diagnostics OBJECT exists but omits settled_by_default entirely still gets EXPLICIT false, never undefined (a passthrough mutant reds this — `toBe(false)` fails against `undefined`)', () => {
    const run = makeRun({
      completed_steps: ['normal_step'],
      evidence: [
        snap({
          step_id: 'normal_step',
          diagnostics: { input_token_estimate: 0, precondition_trace: [] }, // no settled_by_default key
        }),
      ],
    });
    const entry = buildSettlementNamespace(run)['normal_step'];
    expect(entry).toBeDefined();
    expect(entry!.settled_by_default).toBe(false);
    expect(entry!.validation_rejections).toBe(0);
  });

  it('(4b) BLOCKING no-throw: a settled GUARD step (pass, no diagnostics object) + a settled guard (resolution_error, no diagnostics) + a settled FINALIZER (no diagnostics) all materialize false/0 without throwing', () => {
    const run = makeRun({
      completed_steps: ['guard_pass', 'finalizer_ok'],
      failed_steps: ['guard_resolution_error'],
      evidence: [
        // Mirrors executeGuardStep's 'pass' captureEvidence call EXACTLY — no diagnostics param.
        snap({ step_id: 'guard_pass', output_summary: { conditions: [], aborted: false } }),
        // Mirrors executeGuardStep's 'resolution_error' captureEvidence call — no diagnostics.
        snap({
          step_id: 'guard_resolution_error',
          status: 'error',
          error: 'Guard resolution error',
          output_summary: { error: 'Unresolvable path: x' },
        }),
        // Mirrors buildFinalizedSeal's success captureEvidence call — no diagnostics.
        snap({ step_id: 'finalizer_ok', output_summary: {} }),
      ],
    });
    expect(() => buildSettlementNamespace(run)).not.toThrow();
    const result = buildSettlementNamespace(run);
    expect(result['guard_pass']).toEqual({
      settled_by_default: false,
      validation_rejections: 0,
      failed: false,
    });
    expect(result['guard_resolution_error']).toEqual({
      settled_by_default: false,
      validation_rejections: 0,
      // This fixture's step is in failed_steps — the polarity is per-cell, never blanket.
      failed: true,
    });
    expect(result['finalizer_ok']).toEqual({
      settled_by_default: false,
      validation_rejections: 0,
      failed: false,
    });
  });

  it('THE gate-response inversion: for a step with an EXECUTION snapshot (settled_by_default: true) followed chronologically by a gate_response snapshot (no diagnostics), the mint reads the EXECUTION snapshot — NOT "the last snapshot"', () => {
    const run = makeRun({
      completed_steps: ['gated_default_step'],
      evidence: [
        snap({
          step_id: 'gated_default_step',
          output_summary: { category: 'fallback' },
          diagnostics: {
            input_token_estimate: 0,
            precondition_trace: [],
            settled_by_default: true,
            validation_rejections: 6,
          },
        }),
        // Chronologically LAST — a gate_response snapshot recording the human's choice, no diagnostics.
        {
          ...snap({ step_id: 'gated_default_step', output_summary: { choice: 'approve' } }),
          kind: 'gate_response' as const,
        },
      ],
    });
    const entry = buildSettlementNamespace(run)['gated_default_step'];
    expect(entry?.settled_by_default).toBe(true);
    expect(entry?.validation_rejections).toBe(6);
  });

  it('(ii) hostile-evidence-id mint-wins: buildEvidenceByStep\'s $settlement key is the MINTED namespace, never a hostile snapshot literally step_id === "$settlement"', () => {
    const run = makeRun({
      completed_steps: ['$settlement', 'real_step'],
      evidence: [
        // A synthetic pre-reservation record carrying a snapshot literally named '$settlement'.
        snap({ step_id: '$settlement', output_summary: { hostile: true } }),
        snap({
          step_id: 'real_step',
          diagnostics: {
            input_token_estimate: 0,
            precondition_trace: [],
            settled_by_default: true,
            validation_rejections: 3,
          },
        }),
      ],
    });
    const evidenceByStep = buildEvidenceByStep(run);
    expect(evidenceByStep['$settlement']).not.toEqual({ hostile: true });
    expect(evidenceByStep['$settlement']).toHaveProperty('real_step');
    expect((evidenceByStep['$settlement'] as Record<string, unknown>)['real_step']).toEqual({
      settled_by_default: true,
      validation_rejections: 3,
      failed: false,
    });
  });

  it('a run with zero settled steps mints an empty $settlement object (never absent, never throws)', () => {
    const run = makeRun({});
    const evidenceByStep = buildEvidenceByStep(run);
    expect(evidenceByStep['$settlement']).toEqual({});
  });
});
