// Tests for precondition evaluator — evaluatePrecondition, checkPreconditions, and evaluateAllPreconditions.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluatePrecondition,
  checkPreconditions,
  evaluateAllPreconditions,
  evaluateGuardConditions,
} from './precondition.js';
import { executeStep, executeChain } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

describe('evaluatePrecondition', () => {
  it('numeric greater-than passes when condition holds', () => {
    const evidence = { validate: { result: { accepted_count: 5 } } };
    expect(evaluatePrecondition('validate.result.accepted_count > 0', evidence)).toBe(true);
  });

  it('numeric greater-than fails when condition does not hold', () => {
    const evidence = { validate: { result: { accepted_count: 0 } } };
    expect(evaluatePrecondition('validate.result.accepted_count > 0', evidence)).toBe(false);
  });

  it('equality check matches string values', () => {
    const evidence = { step: { result: { status: 'done' } } };
    expect(evaluatePrecondition('step.result.status == done', evidence)).toBe(true);
  });

  it('returns false when the step is not in the evidence map', () => {
    expect(evaluatePrecondition('missing_step.result.count > 0', {})).toBe(false);
  });
});

describe('checkPreconditions', () => {
  it('returns null when all preconditions pass', () => {
    const evidence = { step_a: { count: 3 } };
    const result = checkPreconditions(['step_a.count > 0'], evidence);
    expect(result).toBeNull();
  });

  it('returns the first failing precondition', () => {
    const evidence = { step_a: { count: 0 } };
    // First fails, second would pass.
    const result = checkPreconditions(['step_a.count > 0', 'step_a.count >= 0'], evidence);
    expect(result).not.toBeNull();
    expect(result!.expression).toBe('step_a.count > 0');
    expect(result!.passed).toBe(false);
  });

  // issue #154: the first-failure resolved_value (feeding the blocked-step suggestion string
  // in execution-loop.ts) is now bounded/scrubbed too.
  it('scrubs an email-bearing LHS in the first-failure result', () => {
    const evidence = { step_a: { text: 'contact jane.doe@example.com' } };
    const result = checkPreconditions(["step_a.text == 'irrelevant'"], evidence);
    expect(result!.resolved_value).toBe('contact [REDACTED_EMAIL]');
  });

  it('caps an oversized LHS in the first-failure result', () => {
    const long = 'x'.repeat(600);
    const evidence = { step_a: { text: long } };
    const result = checkPreconditions(["step_a.text == 'irrelevant'"], evidence);
    expect(result!.resolved_value).toBe(`${'x'.repeat(500)}…[truncated]`);
  });

  it('leaves a scalar first-failure resolved_value byte-unchanged', () => {
    const evidence = { step_a: { count: 0 } };
    const result = checkPreconditions(['step_a.count > 5'], evidence);
    expect(result!.resolved_value).toBe(0);
  });
});

describe('executeStep blocks when precondition fails', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-precond-'));
  });

  it('returns status: blocked with suggestion when precondition is unmet', async () => {
    const preconditionDef: WorkflowDefinition = {
      id: 'precond-wf',
      name: 'Precondition Workflow',
      version: 1,
      steps: {
        'step-a': {
          description: 'Produces some output',
          execution: 'auto',
          depends_on: [],
        },
        'step-b': {
          description: 'Requires step-a to have run with count > 0',
          execution: 'auto',
          depends_on: ['step-a'],
          preconditions: ['step-a.result.count > 0'],
        },
      },
    };

    const store = new JsonFileStore(dir);
    const { run: run } = await store.create({
      workflowId: 'precond-wf',
      workflowVersion: 1,
      params: {},
    });

    // Execute step-a with count: 0 — satisfies depends_on but NOT the precondition.
    await executeStep(store, preconditionDef, {
      runId: run.id,
      command: 'step-a',
      input: {},
      dispatcher: async () => ({ result: { count: 0 } }),
    });

    const envelope = await executeStep(store, preconditionDef, {
      runId: run.id,
      command: 'step-b',
      input: {},
      dispatcher: async () => ({}),
    });

    expect(envelope.status).toBe('blocked');
    expect(envelope.blocked_reason?.suggestion).toContain('Precondition failed');
    expect(envelope.blocked_reason?.suggestion).toContain('step-a.result.count > 0');
  });

  // issue #154: the suggestion string (execution-loop.ts, String(failed.resolved_value)) now
  // reflects the bounded/scrubbed value end-to-end, since checkPreconditions produces it already
  // bounded — no change needed in execution-loop.ts itself.
  it('suggestion reflects a scrubbed email when the precondition LHS is email-bearing', async () => {
    const preconditionDef: WorkflowDefinition = {
      id: 'precond-email-wf',
      name: 'Precondition Email Workflow',
      version: 1,
      steps: {
        'step-a': {
          description: 'Produces some output',
          execution: 'auto',
          depends_on: [],
        },
        'step-b': {
          description: 'Requires step-a text to equal a literal it will not match',
          execution: 'auto',
          depends_on: ['step-a'],
          preconditions: ["step-a.result.text == 'never-matches'"],
        },
      },
    };

    const store = new JsonFileStore(dir);
    const { run: run } = await store.create({
      workflowId: 'precond-email-wf',
      workflowVersion: 1,
      params: {},
    });

    await executeStep(store, preconditionDef, {
      runId: run.id,
      command: 'step-a',
      input: {},
      dispatcher: async () => ({ result: { text: 'contact jane.doe@example.com' } }),
    });

    const envelope = await executeStep(store, preconditionDef, {
      runId: run.id,
      command: 'step-b',
      input: {},
      dispatcher: async () => ({}),
    });

    expect(envelope.status).toBe('blocked');
    expect(envelope.blocked_reason?.suggestion).toContain('[REDACTED_EMAIL]');
    expect(envelope.blocked_reason?.suggestion).not.toContain('jane.doe@example.com');
  });
});

describe('evaluateAllPreconditions', () => {
  it('returns all results with passed: true when all preconditions pass', () => {
    const evidence = { step_a: { count: 5 } };
    const results = evaluateAllPreconditions(['step_a.count > 0', 'step_a.count >= 5'], evidence);
    expect(results).toHaveLength(2);
    expect(results[0]!.passed).toBe(true);
    expect(results[1]!.passed).toBe(true);
  });

  it('returns results for both passing and failing expressions in order', () => {
    const evidence = { step_a: { count: 0 } };
    const results = evaluateAllPreconditions(['step_a.count > 0', 'step_a.count >= 0'], evidence);
    expect(results).toHaveLength(2);
    expect(results[0]!.expression).toBe('step_a.count > 0');
    expect(results[0]!.passed).toBe(false);
    expect(results[1]!.expression).toBe('step_a.count >= 0');
    expect(results[1]!.passed).toBe(true);
  });

  // issue #154: precondition_trace's resolved_value is now bounded/scrubbed via
  // boundResolvedValue — the same helper #111 introduced for the when-skip trace.
  it('caps an oversized string LHS with the truncation marker', () => {
    const long = 'x'.repeat(600);
    const evidence = { step_a: { text: long } };
    const results = evaluateAllPreconditions(["step_a.text == 'irrelevant'"], evidence);
    expect(results[0]!.resolved_value).toBe(`${'x'.repeat(500)}…[truncated]`);
  });

  it('scrubs an email-bearing string LHS', () => {
    const evidence = { step_a: { text: 'contact jane.doe@example.com for help' } };
    const results = evaluateAllPreconditions(["step_a.text == 'irrelevant'"], evidence);
    expect(results[0]!.resolved_value).toBe('contact [REDACTED_EMAIL] for help');
  });

  it('JSON-stringifies and caps an object LHS', () => {
    const evidence = { step_a: { obj: { email: 'jane.doe@example.com', ok: true } } };
    const results = evaluateAllPreconditions(["step_a.obj == 'irrelevant'"], evidence);
    const value = results[0]!.resolved_value as string;
    expect(value).toContain('[REDACTED_EMAIL]');
    expect(value).not.toContain('jane.doe@example.com');
    expect(value).toContain('"ok":true');
  });

  it('leaves a scalar LHS byte-unchanged (type-faithful)', () => {
    const evidence = { step_a: { count: 5, flag: true, short: 'ok' } };
    expect(evaluateAllPreconditions(['step_a.count > 0'], evidence)[0]!.resolved_value).toBe(5);
    expect(evaluateAllPreconditions(['step_a.flag == true'], evidence)[0]!.resolved_value).toBe(
      true,
    );
    expect(evaluateAllPreconditions(["step_a.short == 'ok'"], evidence)[0]!.resolved_value).toBe(
      'ok',
    );
  });
});

describe('evaluateGuardConditions', () => {
  it('returns pass when all conditions are true', () => {
    const evidenceByStep = { step_a: { status: 'open', count: 5 } };
    const result = evaluateGuardConditions(
      ["step_a.status == 'open'", 'step_a.count > 0'],
      evidenceByStep,
    );
    expect(result.kind).toBe('pass');
    if (result.kind === 'pass') {
      expect(result.conditions).toHaveLength(2);
      expect(result.conditions[0]!.passed).toBe(true);
      expect(result.conditions[1]!.passed).toBe(true);
    }
  });

  it('returns abort when any condition is false, evaluating all conditions', () => {
    const evidenceByStep = { step_a: { status: 'closed', count: 5 } };
    const result = evaluateGuardConditions(
      ["step_a.status == 'open'", 'step_a.count > 0'],
      evidenceByStep,
    );
    expect(result.kind).toBe('abort');
    if (result.kind === 'abort') {
      // All conditions evaluated — not short-circuited
      expect(result.conditions).toHaveLength(2);
      expect(result.conditions[0]!.passed).toBe(false);
      expect(result.conditions[1]!.passed).toBe(true);
    }
  });

  it('returns abort with all conditions false when all fail', () => {
    const evidenceByStep = { step_a: { status: 'closed', count: 0 } };
    const result = evaluateGuardConditions(
      ["step_a.status == 'open'", 'step_a.count > 0'],
      evidenceByStep,
    );
    expect(result.kind).toBe('abort');
    if (result.kind === 'abort') {
      expect(result.conditions).toHaveLength(2);
      expect(result.conditions[0]!.passed).toBe(false);
      expect(result.conditions[1]!.passed).toBe(false);
    }
  });

  it('returns resolution_error when a path cannot be resolved', () => {
    const evidenceByStep = { step_a: { count: 5 } };
    const result = evaluateGuardConditions(["step_a.missing_field == 'open'"], evidenceByStep);
    expect(result.kind).toBe('resolution_error');
    if (result.kind === 'resolution_error') {
      expect(result.condition).toBe("step_a.missing_field == 'open'");
      expect(result.unresolvable_path).toBe('step_a.missing_field');
    }
  });

  it('returns resolution_error when the step has no evidence', () => {
    const evidenceByStep: Record<string, Record<string, unknown>> = {};
    const result = evaluateGuardConditions(["step_a.status == 'open'"], evidenceByStep);
    expect(result.kind).toBe('resolution_error');
  });

  it('handles bare path truthy check — true when field is truthy', () => {
    const evidenceByStep = { step_a: { enabled: true } };
    const result = evaluateGuardConditions(['step_a.enabled'], evidenceByStep);
    expect(result.kind).toBe('pass');
  });

  it('handles bare path truthy check — abort when field is falsy', () => {
    const evidenceByStep = { step_a: { enabled: false } };
    const result = evaluateGuardConditions(['step_a.enabled'], evidenceByStep);
    expect(result.kind).toBe('abort');
    if (result.kind === 'abort') {
      expect(result.conditions[0]!.passed).toBe(false);
    }
  });

  it('returns pass with all conditions recorded for single passing condition', () => {
    const evidenceByStep = { step_a: { count: 10 } };
    const result = evaluateGuardConditions(['step_a.count >= 10'], evidenceByStep);
    expect(result.kind).toBe('pass');
    if (result.kind === 'pass') {
      expect(result.conditions[0]!.condition).toBe('step_a.count >= 10');
      expect(result.conditions[0]!.resolved_value).toBe(10);
      expect(result.conditions[0]!.passed).toBe(true);
    }
  });

  it('records resolved_value in abort result for each condition', () => {
    const evidenceByStep = { step_a: { count: 0 } };
    const result = evaluateGuardConditions(['step_a.count > 5'], evidenceByStep);
    expect(result.kind).toBe('abort');
    if (result.kind === 'abort') {
      expect(result.conditions[0]!.resolved_value).toBe(0);
    }
  });

  // issue #154: GuardConditionResult.resolved_value is now bounded/scrubbed at the SAME two
  // production sites (comparison-leaf L198, bare-path L205) regardless of outcome — the abort
  // path and the pass path both flow through evaluateGuardConditions, so bounding here covers
  // aborted_at.conditions AND the passing guard's recorded evidence uniformly.
  it('abort path: scrubs an email-bearing LHS on a false comparison condition', () => {
    const evidenceByStep = { step_a: { text: 'contact jane.doe@example.com' } };
    const result = evaluateGuardConditions(["step_a.text == 'never-matches'"], evidenceByStep);
    expect(result.kind).toBe('abort');
    if (result.kind === 'abort') {
      expect(result.conditions[0]!.resolved_value).toBe('contact [REDACTED_EMAIL]');
    }
  });

  it('abort path: caps an oversized LHS on a false comparison condition', () => {
    const long = 'x'.repeat(600);
    const evidenceByStep = { step_a: { text: long } };
    const result = evaluateGuardConditions(["step_a.text == 'never-matches'"], evidenceByStep);
    expect(result.kind).toBe('abort');
    if (result.kind === 'abort') {
      expect(result.conditions[0]!.resolved_value).toBe(`${'x'.repeat(500)}…[truncated]`);
    }
  });

  it('pass path: scrubs an email-bearing LHS on a bare-path truthy condition that passes', () => {
    const evidenceByStep = { step_a: { text: 'contact jane.doe@example.com' } };
    const result = evaluateGuardConditions(['step_a.text'], evidenceByStep);
    expect(result.kind).toBe('pass');
    if (result.kind === 'pass') {
      expect(result.conditions[0]!.resolved_value).toBe('contact [REDACTED_EMAIL]');
    }
  });

  it('pass path: caps an oversized LHS on a passing comparison condition', () => {
    const long = 'x'.repeat(600);
    const evidenceByStep = { step_a: { text: long } };
    const result = evaluateGuardConditions([`step_a.text == '${long}'`], evidenceByStep);
    expect(result.kind).toBe('pass');
    if (result.kind === 'pass') {
      expect(result.conditions[0]!.resolved_value).toBe(`${'x'.repeat(500)}…[truncated]`);
    }
  });

  it('leaves a scalar guard-condition resolved_value byte-unchanged (pass and abort)', () => {
    const passResult = evaluateGuardConditions(['step_a.count >= 10'], { step_a: { count: 10 } });
    expect(passResult.kind).toBe('pass');
    if (passResult.kind === 'pass') {
      expect(passResult.conditions[0]!.resolved_value).toBe(10);
    }

    const abortResult = evaluateGuardConditions(['step_a.count > 5'], { step_a: { count: 0 } });
    expect(abortResult.kind).toBe('abort');
    if (abortResult.kind === 'abort') {
      expect(abortResult.conditions[0]!.resolved_value).toBe(0);
    }
  });
});

// issue #154 — full end-to-end proof: a real guard-triggered abort stores the bounded/scrubbed
// value in the durable RunRecord's aborted_at.conditions (not just in the pure evaluator's return).
describe('guard abort — aborted_at.conditions is bounded end-to-end (issue #154)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-guard-bound-'));
  });

  it('a guard condition with an email-bearing LHS stores the scrubbed value in aborted_at.conditions', async () => {
    const guardDef: WorkflowDefinition = {
      id: 'guard-bound-wf',
      name: 'Guard Bound Workflow',
      version: 1,
      steps: {
        'step-a': {
          description: 'Agent step',
          execution: 'agent',
          depends_on: [],
        },
        'guard-b': {
          description: 'Guard step',
          execution: 'guard',
          depends_on: ['step-a'],
          abort_unless: ["step-a.text == 'never-matches'"],
        },
      },
    };

    const store = new JsonFileStore(dir);
    const { run: run } = await store.create({
      workflowId: 'guard-bound-wf',
      workflowVersion: 1,
      params: {},
    });

    await executeChain(store, guardDef, {
      runId: run.id,
      command: 'step-a',
      input: {},
      dispatcher: async () => ({ text: 'contact jane.doe@example.com' }),
    });

    const savedRun = await store.get(run.id);
    expect(savedRun.run_phase).toBe('aborted');
    const conditions = savedRun.aborted_at?.conditions;
    expect(conditions).toHaveLength(1);
    expect(conditions![0]!.resolved_value).toBe('contact [REDACTED_EMAIL]');
  });
});
