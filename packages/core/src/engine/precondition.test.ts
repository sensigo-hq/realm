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
import { executeStep } from './execution-loop.js';
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
    const run = await store.create({
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
});
