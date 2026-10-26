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
  preconditionHint,
  preconditionRefusal,
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

  // #729 PR-3: the first-failure resolved_value is returned RAW — the double bound is deleted, and
  // its one renderer (`escapedBoundedValue` in `pending.ts`, pinned by the refusal's cells) bounds
  // and scrubs it once. (a) red when `checkPreconditions` bounds again; (b) prints the value, an
  // ordinary fake address or 600 `x`.
  it('returns an email-bearing LHS raw in the first-failure result (its renderer scrubs it)', () => {
    const evidence = { step_a: { text: 'contact jane.doe@example.com' } };
    const result = checkPreconditions(["step_a.text == 'irrelevant'"], evidence);
    expect(result!.resolved_value).toBe('contact jane.doe@example.com');
  });

  it('returns an oversized LHS whole in the first-failure result (its renderer bounds it)', () => {
    const long = 'x'.repeat(600);
    const evidence = { step_a: { text: long } };
    const result = checkPreconditions(["step_a.text == 'irrelevant'"], evidence);
    expect(result!.resolved_value).toBe(long);
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
    // #729 PR-0 (D-L, E1 (b)): the failed precondition is the refusal's facts — the doors word it
    // ("Precondition failed: '<expression>'. Resolved value: <value>.").
    expect(envelope.context_hint).toContain('Precondition failed');
    const failed =
      envelope.refusal?.code === 'refused_before_claim'
        ? envelope.refusal.facts.precondition
        : undefined;
    expect(failed?.expression).toBe('step-a.result.count > 0');
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
    // #729 PR-0: the value the refusal carries is the bounded, scrubbed one — and nothing on the
    // reply carries the address.
    const failed =
      envelope.refusal?.code === 'refused_before_claim'
        ? envelope.refusal.facts.precondition
        : undefined;
    expect(failed?.value).toContain('[REDACTED_EMAIL]');
    expect(JSON.stringify(envelope)).not.toContain('jane.doe@example.com');
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
  // #729 PR-3 B0: (a) red when the cut returns; (b) prints the marker or a run of `x`.
  it('replaces an oversized string LHS whole with its marker (B0)', () => {
    const long = 'x'.repeat(600);
    const evidence = { step_a: { text: long } };
    const results = evaluateAllPreconditions(["step_a.text == 'irrelevant'"], evidence);
    expect(results[0]!.resolved_value).toBe('‹600 characters, not kept›');
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

  it('abort path: replaces an oversized LHS whole with its marker (B0)', () => {
    const long = 'x'.repeat(600);
    const evidenceByStep = { step_a: { text: long } };
    const result = evaluateGuardConditions(["step_a.text == 'never-matches'"], evidenceByStep);
    expect(result.kind).toBe('abort');
    if (result.kind === 'abort') {
      expect(result.conditions[0]!.resolved_value).toBe('‹600 characters, not kept›');
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

  it('pass path: replaces an oversized LHS whole with its marker (B0)', () => {
    const long = 'x'.repeat(600);
    const evidenceByStep = { step_a: { text: long } };
    const result = evaluateGuardConditions([`step_a.text == '${long}'`], evidenceByStep);
    expect(result.kind).toBe('pass');
    if (result.kind === 'pass') {
      expect(result.conditions[0]!.resolved_value).toBe('‹600 characters, not kept›');
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

// #729 PR-3 (RECORD 01 #17; D1 D12): a guard's evaluated conditions leave its `output_summary` for
// its step's diagnostics; `{aborted, abort_message}` stay, and so does `aborted_at.conditions`.
describe("#729 PR-3 — a guard's conditions live in its diagnostics", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-guard-diag-'));
  });

  const def = (expected: string): WorkflowDefinition => ({
    id: 'guard-diag-wf',
    name: 'Guard Diagnostics',
    version: 1,
    steps: {
      'step-a': { description: 'Agent step', execution: 'agent', depends_on: [] },
      'guard-b': {
        description: 'Guard step',
        execution: 'guard',
        depends_on: ['step-a'],
        abort_unless: [`step-a.text == '${expected}'`],
        abort_message: 'stopped by the guard',
      },
    },
  });

  for (const [arm, expected, aborted] of [
    ['abort', 'never-matches', true],
    ['pass', 'ok', false],
  ] as const) {
    it(`${arm}: output_summary holds {aborted, abort_message?} only; diagnostics.guard_conditions holds the conditions`, async () => {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({
        workflowId: 'guard-diag-wf',
        workflowVersion: 1,
        params: {},
      });
      await executeChain(store, def(expected), {
        runId: run.id,
        command: 'step-a',
        input: {},
        dispatcher: async () => ({ text: 'ok' }),
      });
      const saved = await store.get(run.id);
      const guard = saved.evidence.filter((e) => e.step_id === 'guard-b').at(-1)!;
      // (a) red when `conditions` return to the output, or leave the diagnostics; (b) prints the
      //     output's key list and the conditions' text and verdicts (no value: the LHS is 'ok').
      expect(Object.keys(guard.output_summary)).toEqual(
        aborted ? ['aborted', 'abort_message'] : ['aborted'],
      );
      expect(guard.diagnostics?.guard_conditions).toEqual([
        { condition: `step-a.text == '${expected}'`, resolved_value: 'ok', passed: !aborted },
      ]);
      // (a) red when the run's own abort record loses its conditions; (b) prints the count.
      expect(saved.aborted_at?.conditions?.length ?? 0).toBe(aborted ? 1 : 0);
    });
  }
});

// #729 PR-3 (RECORD 01 #8; D3/08 S1): core composes the precondition refusal once; each door passes
// the value as its renderer drew it.
describe('#729 PR-3 — preconditionRefusal', () => {
  it("the hint is core's own first clause, the one pending.ts stores", () => {
    // (a) red when the hint's words change (the stored refusal and the CLI's line would part); (b)
    //     prints the hint.
    expect(preconditionHint('s')).toBe("Precondition failed for step 's'.");
  });

  it('one sentence, the value as passed', () => {
    // (a) red when the sentence changes (the stored `facts.refusal` would change with it); (b)
    //     prints the sentence, made of the fake expression and value.
    expect(preconditionRefusal("Precondition failed for step 's'.", 'a.n > 1', '0')).toBe(
      "Precondition failed for step 's'. Precondition failed: 'a.n > 1'. Resolved value: 0.",
    );
  });
});
