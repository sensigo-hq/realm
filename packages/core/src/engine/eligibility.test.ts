// Unit tests for findEligibleSteps, triggerRuleSatisfied, evaluateWhenCondition,
// and deriveRunPhase — the DAG eligibility predicates.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
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
} from './eligibility.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import type { RunRecord, PendingGate } from '../types/run-record.js';

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
        terminal_reason: undefined,
      }),
    ).toBe('gate_waiting');
  });

  it('returns running when not terminal', () => {
    expect(
      deriveRunPhase({
        pending_gate: undefined,
        terminal_state: false,
        failed_steps: [],
        terminal_reason: undefined,
      }),
    ).toBe('running');
  });

  it('returns completed when terminal_reason is Workflow completed.', () => {
    expect(
      deriveRunPhase({
        pending_gate: undefined,
        terminal_state: true,
        failed_steps: [],
        terminal_reason: 'Workflow completed.',
      }),
    ).toBe('completed');
  });

  it('returns completed even when failed_steps is non-empty if terminal_reason is Workflow completed. (recovery workflow)', () => {
    expect(
      deriveRunPhase({
        pending_gate: undefined,
        terminal_state: true,
        failed_steps: ['main_step'],
        terminal_reason: 'Workflow completed.',
      }),
    ).toBe('completed');
  });

  it('returns failed when terminal and failed_steps is non-empty without Workflow completed. reason', () => {
    expect(
      deriveRunPhase({
        pending_gate: undefined,
        terminal_state: true,
        failed_steps: ['step-a'],
        terminal_reason: "Step 'step-a' failed: error",
      }),
    ).toBe('failed');
  });

  it('returns abandoned when terminal, no failed steps, and reason is not Workflow completed.', () => {
    expect(
      deriveRunPhase({
        pending_gate: undefined,
        terminal_state: true,
        failed_steps: [],
        terminal_reason: 'Marked abandoned by realm cleanup',
      }),
    ).toBe('abandoned');
  });

  it('returns aborted when aborted_at is set', () => {
    expect(
      deriveRunPhase({
        pending_gate: undefined,
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
        pending_gate: undefined,
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
        pending_gate: undefined,
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
        pending_gate: undefined,
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
  it('marks a downstream all_success step as skipped when its dep fails', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_success' },
    });
    const run = makeRun({ failed_steps: ['a'] });
    expect(propagateSkips(run, definition)).toContain('b');
  });

  it('marks a downstream none_failed step as skipped when its dep fails', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'none_failed' },
    });
    const run = makeRun({ failed_steps: ['a'] });
    expect(propagateSkips(run, definition)).toContain('b');
  });

  it('marks a downstream all_failed step as skipped when its dep completes', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_failed' },
    });
    const run = makeRun({ completed_steps: ['a'] });
    expect(propagateSkips(run, definition)).toContain('b');
  });

  it('marks a downstream one_failed step as skipped when all deps complete', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: [] },
      c: { depends_on: ['a', 'b'], trigger_rule: 'one_failed' },
    });
    const run = makeRun({ completed_steps: ['a', 'b'] });
    expect(propagateSkips(run, definition)).toContain('c');
  });

  it('marks a downstream one_success step as skipped when all deps fail', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: [] },
      c: { depends_on: ['a', 'b'], trigger_rule: 'one_success' },
    });
    const run = makeRun({ failed_steps: ['a', 'b'] });
    expect(propagateSkips(run, definition)).toContain('c');
  });

  it('does not skip an all_done step — all_done is always eventually satisfiable', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_done' },
    });
    const run = makeRun({ failed_steps: ['a'] });
    expect(propagateSkips(run, definition)).not.toContain('b');
  });

  it('cascades: skipping B causes C (all_success on [B]) to also be skipped', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_success' },
      c: { depends_on: ['b'], trigger_rule: 'all_success' },
    });
    const run = makeRun({ failed_steps: ['a'] });
    const result = propagateSkips(run, definition);
    expect(result).toContain('b');
    expect(result).toContain('c');
  });

  it('does not duplicate an already-skipped step', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_success' },
    });
    const run = makeRun({ failed_steps: ['a'], skipped_steps: ['b'] });
    const result = propagateSkips(run, definition);
    expect(result.filter((s) => s === 'b')).toHaveLength(1);
  });

  it('does not skip completed or failed steps', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: [] },
    });
    const run = makeRun({ completed_steps: ['a'], failed_steps: ['b'] });
    const result = propagateSkips(run, definition);
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
    expect(propagateSkips(run, definition)).not.toContain('c');
  });

  it('preserves existing skipped_steps in the returned array', () => {
    const definition = makeWorkflow({
      a: { depends_on: [] },
      b: { depends_on: ['a'], trigger_rule: 'all_success' },
      c: { depends_on: [] },
    });
    const run = makeRun({ failed_steps: ['a'], skipped_steps: ['c'] });
    const result = propagateSkips(run, definition);
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
    expect(propagateSkips(run, definition)).not.toContain('c');
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
    expect(propagateSkips(run, definition)).toContain('route_billing');
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
    expect(propagateSkips(run, definition)).not.toContain('route_billing');
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
    expect(propagateSkips(run, definition)).not.toContain('route_billing');
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
    const result = propagateSkips(run, definition);
    expect(result).toContain('route_billing');
    expect(result).toContain('notify_billing');
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
  it('gate_waiting outranks everything', () => {
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'review',
      preview: {},
      choices: ['approve', 'reject'],
      opened_at: '2024-01-01T00:00:00.000Z',
    };
    expect(
      deriveRunPhase(makeRun({ pending_gate: gate, terminal_state: false, aborted_at: aborted })),
    ).toBe('gate_waiting');
  });
});
