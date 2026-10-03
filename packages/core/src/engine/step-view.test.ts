// step-view.test.ts — issue #600 PR 1b (D7): the one place "how do you sum a per-request counter
// honestly" lives, and the one place a step's cost is classified when there is none to sum.
import { describe, it, expect } from 'vitest';
import { composeCostView, composeStepViews, composeDriveFailureCosts } from './step-view.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

function req(overrides: Record<string, unknown> = {}, index = 0): Record<string, unknown> {
  return { request_index: index, request_start: '2026-01-01T00:00:00.000Z', ...overrides };
}

function makeRun(evidence: unknown, overrides: Partial<RunRecord> = {}): RunRecord {
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
    evidence,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    ...overrides,
  } as unknown as RunRecord;
}

describe('composeCostView — rule 1: totality', () => {
  it('a non-array requests value returns undefined', () => {
    expect(composeCostView(undefined)).toBeUndefined();
    expect(composeCostView(null)).toBeUndefined();
    expect(composeCostView('not an array')).toBeUndefined();
    expect(composeCostView(42)).toBeUndefined();
  });

  it('null and non-object entries in the array never throw and contribute nothing', () => {
    const view = composeCostView([null, 'garbage', 42, req({ prompt_tokens: 100 })]);
    expect(view).toBeDefined();
    expect(view!.requests).toBe(4);
    expect(view!.prompt).toEqual({ value: 100, reported: 1, of: 4, only_request_index: 3 });
  });

  it('an empty array yields { requests: 0 }, distinct from absent', () => {
    expect(composeCostView([])).toEqual({ requests: 0 });
  });
});

describe('composeCostView — rule 2: the summation rule', () => {
  it('a null counter is an absence, never a reported zero', () => {
    const view = composeCostView([req({ prompt_tokens: null, cache_read_input_tokens: 500 })]);
    expect(view!.prompt).toBeUndefined();
    expect(view!.cache_read).toEqual({ value: 500, reported: 1, of: 1, only_request_index: 0 });
  });

  it('the two write spellings are never summed — the first present wins', () => {
    const view = composeCostView([
      req({ cache_creation_input_tokens: 500, cache_write_tokens: 500 }),
    ]);
    expect(view!.cache_write!.value).toBe(500);
  });

  it('the OpenAI spelling is read when the Anthropic one is absent', () => {
    const view = composeCostView([req({ cache_write_tokens: 77 })]);
    expect(view!.cache_write).toEqual({ value: 77, reported: 1, of: 1, only_request_index: 0 });
  });

  it('only_request_index is present iff exactly one request reported the figure', () => {
    const two = composeCostView([req({ output_tokens: 10 }, 0), req({ output_tokens: 20 }, 1)]);
    expect(two!.output!.only_request_index).toBeUndefined();
    expect(two!.output).toEqual({ value: 30, reported: 2, of: 2 });
    const one = composeCostView([req({}, 0), req({ output_tokens: 20 }, 1)]);
    expect(one!.output).toEqual({ value: 20, reported: 1, of: 2, only_request_index: 1 });
  });

  it('basis and state are copied verbatim when strings, absent when absent or null', () => {
    expect(composeCostView([], { basis: 'provider_reported', state: 'engaged' })).toEqual({
      requests: 0,
      basis: 'provider_reported',
      state: 'engaged',
    });
    expect(composeCostView([], { basis: null, state: undefined })).toEqual({ requests: 0 });
    expect(composeCostView([], {})).toEqual({ requests: 0 });
  });
});

const basicDef: WorkflowDefinition = {
  id: 'wf',
  name: 'wf',
  version: 1,
  steps: {
    agent_step: { description: 'x', execution: 'agent' },
    auto_step: { description: 'x', execution: 'auto' },
  },
} as WorkflowDefinition;

describe('composeStepViews — rule 3: shape and totality', () => {
  it('an entry that is not an object is skipped', () => {
    expect(composeStepViews(makeRun([null, 42, 'x']))).toEqual({});
  });

  it('an entry with no string step_id is skipped', () => {
    expect(
      composeStepViews(makeRun([{ status: 'success' }, { step_id: 7, status: 'success' }])),
    ).toEqual({});
  });

  // issue #625 (holder slice): a gate_response entry is still never an attempt, but it is an ANSWER —
  // a fact the step's view must carry — so it creates the step's view with `attempts: []`. This cell
  // was `toEqual({})` ("... alone, mint no StepView") before the holder slice.
  it('gate_response entries are never attempts and, alone, mint a StepView with attempts: [] and one answer', () => {
    const run = makeRun([{ step_id: 'gate_step', kind: 'gate_response', status: 'success' }]);
    expect(composeStepViews(run)).toEqual({
      gate_step: {
        attempts: [],
        answers: [
          {
            answered_by: { by: null, absent_cause: 'not_stated' },
            claim_proof_absent: 'proof_not_recorded',
          },
        ],
      },
    });
  });

  it('gate_response entries are excluded even when the step also has an execution entry', () => {
    const run = makeRun([
      { step_id: 's', kind: 'execution', status: 'success' },
      { step_id: 's', kind: 'gate_response', status: 'success' },
    ]);
    expect(composeStepViews(run)['s']!.attempts).toHaveLength(1);
  });

  it('attempts are numbered 1..n in evidence order, per step_id, kind absent counts as execution', () => {
    const run = makeRun([
      { step_id: 'a', status: 'error' },
      { step_id: 'b', kind: 'execution', status: 'success' },
      { step_id: 'a', kind: 'execution', status: 'success' },
    ]);
    const views = composeStepViews(run);
    expect(views['a']!.attempts.map((a) => [a.attempt, a.status])).toEqual([
      [1, 'error'],
      [2, 'success'],
    ]);
    expect(views['b']!.attempts.map((a) => [a.attempt, a.status])).toEqual([[1, 'success']]);
  });

  it('a non-string status renders as "unknown"', () => {
    const run = makeRun([{ step_id: 's', status: 7 }]);
    expect(composeStepViews(run)['s']!.attempts[0]!.status).toBe('unknown');
  });

  it('an entry not shaped as an array for evidence never throws — empty result', () => {
    expect(composeStepViews(makeRun('not an array' as unknown))).toEqual({});
  });
});

describe('composeStepViews — rule 4: cost comes from cache alone', () => {
  it('cost present on a step the definition calls auto (over classification)', () => {
    const run = makeRun([
      {
        step_id: 'auto_step',
        status: 'success',
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: {
            state: 'engaged',
            basis: 'provider_reported',
            requests: [req({ prompt_tokens: 500 })],
          },
        },
      },
    ]);
    const view = composeStepViews(run, { definition: basicDef });
    expect(view['auto_step']!.attempts[0]!.cost?.prompt?.value).toBe(500);
    expect(view['auto_step']!.attempts[0]!.cost_unrecorded).toBeUndefined();
  });

  it('cache present with a non-array requests: cost_unreadable, never a throw', () => {
    const run = makeRun([
      {
        step_id: 's',
        status: 'success',
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: { requests: 'nope' },
        },
      },
    ]);
    const attempt = composeStepViews(run)['s']!.attempts[0]!;
    expect(attempt.cost_unreadable).toBe(true);
    expect(attempt.cost).toBeUndefined();
  });
});

describe('composeStepViews — rule 5: classification only for an entry without cache', () => {
  it('an entry with tool_calls classifies tool_calling_step, whatever the definition says', () => {
    const run = makeRun([{ step_id: 'agent_step', status: 'success', tool_calls: [] }]);
    const view = composeStepViews(run, { definition: basicDef });
    expect(view['agent_step']!.attempts[0]!.cost_unrecorded).toBe('tool_calling_step');
  });

  it('an agent step by definition, no cache, no tool_calls: not_driven_by_realm', () => {
    const run = makeRun([{ step_id: 'agent_step', status: 'success' }]);
    const view = composeStepViews(run, { definition: basicDef });
    expect(view['agent_step']!.attempts[0]!.cost_unrecorded).toBe('not_driven_by_realm');
  });

  it('the agent_profile fallback fires with NO definition at all', () => {
    const run = makeRun([{ step_id: 's', status: 'success', agent_profile: 'reviewer' }]);
    expect(composeStepViews(run).s!.attempts[0]!.cost_unrecorded).toBe('not_driven_by_realm');
  });

  it('the agent_profile fallback fires when the definition no longer names the step', () => {
    const run = makeRun([
      { step_id: 'removed_step', status: 'success', agent_profile: 'reviewer' },
    ]);
    expect(
      composeStepViews(run, { definition: basicDef }).removed_step!.attempts[0]!.cost_unrecorded,
    ).toBe('not_driven_by_realm');
  });

  it('a handler step (no cache, no tool_calls, no agent signal) gets no annotation at all', () => {
    const run = makeRun([{ step_id: 'auto_step', status: 'success' }]);
    const attempt = composeStepViews(run, { definition: basicDef }).auto_step!.attempts[0]!;
    expect(attempt.cost).toBeUndefined();
    expect(attempt.cost_unrecorded).toBeUndefined();
    expect(attempt.cost_unreadable).toBeUndefined();
  });
});

describe('composeDriveFailureCosts', () => {
  it('[] when drive_failures is absent', () => {
    expect(composeDriveFailureCosts(makeRun([]))).toEqual([]);
  });

  it('a malformed drive_failures shape (entries not an array) also yields []', () => {
    expect(
      composeDriveFailureCosts(makeRun([], { drive_failures: { entries: 'nope' } as never })),
    ).toEqual([]);
  });

  it('lines up 1:1, absent at/step/error_class on a malformed entry — never one holding undefined', () => {
    const run = makeRun([], {
      drive_failures: {
        first_failed_at: '2026-01-01T00:00:00.000Z',
        total: 2,
        entries: [null, { at: 5, step: 's' }] as never,
      },
    });
    const costs = composeDriveFailureCosts(run);
    expect(costs).toHaveLength(2);
    expect(costs[0]).toEqual({});
    expect('at' in costs[1]!).toBe(false);
    expect(costs[1]!.step).toBe('s');
  });

  it('{ requests: 0 } vs absent — an empty usage array is distinct from no usage at all', () => {
    const run = makeRun([], {
      drive_failures: {
        first_failed_at: '2026-01-01T00:00:00.000Z',
        total: 2,
        entries: [
          { at: 'a', step: 's', usage: [] },
          { at: 'a', step: 's' },
        ] as never,
      },
    });
    const costs = composeDriveFailureCosts(run);
    expect(costs[0]!.cost).toEqual({ requests: 0 });
    expect(costs[1]!.cost).toBeUndefined();
  });

  it('cost carries no basis/state — a drive failure usage array has no classification', () => {
    const run = makeRun([], {
      drive_failures: {
        first_failed_at: '2026-01-01T00:00:00.000Z',
        total: 1,
        entries: [{ at: 'a', step: 's', usage: [req({ prompt_tokens: 5 })] }] as never,
      },
    });
    expect(composeDriveFailureCosts(run)[0]!.cost).toEqual({
      requests: 1,
      prompt: { value: 5, reported: 1, of: 1, only_request_index: 0 },
    });
  });
});

// ---------------------------------------------------------------------------------------------
// issue #625 (the holder slice): the program that did an attempt's work, and a step's answers.
// ---------------------------------------------------------------------------------------------

describe('composeStepViews — issue #625: driven_by on every attempt', () => {
  const PROGRAM = { by: 'mihai@host', by_source: 'derived', channel: 'agent' };

  it("an attempt reads the entry's driven_by through the one stored-name reader", () => {
    const run = makeRun([{ step_id: 's', status: 'success', driven_by: PROGRAM }]);
    expect(composeStepViews(run)['s']!.attempts[0]!.driven_by).toEqual(PROGRAM);
  });

  it('no driven_by on the entry ⇒ driver_not_recorded (it predates the field, or no host named itself)', () => {
    const run = makeRun([{ step_id: 's', status: 'success' }]);
    expect(composeStepViews(run)['s']!.attempts[0]!.driven_by).toEqual({
      by: null,
      absent_cause: 'driver_not_recorded',
    });
  });

  it('a stored driven_by that is not a readable name ⇒ name_unreadable — no byte of the value survives', () => {
    const run = makeRun([
      { step_id: 's', status: 'success', driven_by: { ...PROGRAM, by: 'x\u001b[2Jy' } },
    ]);
    const view = composeStepViews(run)['s']!.attempts[0]!.driven_by;
    expect(view).toEqual({ by: null, absent_cause: 'name_unreadable' });
    expect(JSON.stringify(view)).not.toContain('\u001b');
  });
});

describe('composeStepViews — issue #625: answers', () => {
  function answer(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      step_id: 'gate_step',
      kind: 'gate_response',
      status: 'success',
      input_summary: { choice: 'approve' },
      output_summary: { choice: 'approve' },
      ...extra,
    };
  }

  it('an answer carries the choice, the stated answerer and the recorded verdict', () => {
    const run = makeRun([
      { step_id: 'gate_step', kind: 'execution', status: 'success' },
      answer({ responded_by: 'alice', claim_proof: { proof: 'matched' } }),
    ]);
    const view = composeStepViews(run)['gate_step']!;
    expect(view.attempts).toHaveLength(1);
    expect(view.answers).toEqual([
      {
        choice: 'approve',
        answered_by: { by: 'alice', by_source: 'stated' },
        claim_proof: { proof: 'matched' },
      },
    ]);
  });

  it('answers are in entry order — one per gate_response entry', () => {
    const run = makeRun([
      answer({ responded_by: 'first', input_summary: { choice: 'a' } }),
      answer({ responded_by: 'second', input_summary: { choice: 'b' } }),
    ]);
    expect(
      composeStepViews(run)['gate_step']!.answers!.map((a) => [a.choice, a.answered_by]),
    ).toEqual([
      ['a', { by: 'first', by_source: 'stated' }],
      ['b', { by: 'second', by_source: 'stated' }],
    ]);
  });

  it('the choice falls back to output_summary, and is absent when neither carries one', () => {
    const fromOutput = answer({ input_summary: {}, output_summary: { choice: 'x' } });
    const neither = answer({ input_summary: {}, output_summary: {} });
    expect(composeStepViews(makeRun([fromOutput]))['gate_step']!.answers![0]!.choice).toBe('x');
    expect('choice' in composeStepViews(makeRun([neither]))['gate_step']!.answers![0]!).toBe(false);
  });

  it('no responded_by ⇒ not_stated; an empty or whitespace-only one reads as not_stated too — never a blank name', () => {
    for (const rb of [undefined, null, '', '   ']) {
      const run = makeRun([answer(rb === undefined ? {} : { responded_by: rb })]);
      expect(composeStepViews(run)['gate_step']!.answers![0]!.answered_by).toEqual({
        by: null,
        absent_cause: 'not_stated',
      });
    }
  });

  it('the READ BOUND (mutant p): a responded_by with a control character ⇒ name_unreadable, the string absent', () => {
    const run = makeRun([answer({ responded_by: 'mallory\u001b[2J' })]);
    const view = composeStepViews(run)['gate_step']!.answers![0]!;
    expect(view.answered_by).toEqual({ by: null, absent_cause: 'name_unreadable' });
    expect(JSON.stringify(view)).not.toContain('mallory');
  });

  it('a non-string responded_by ⇒ name_unreadable', () => {
    const run = makeRun([answer({ responded_by: 42 })]);
    expect(composeStepViews(run)['gate_step']!.answers![0]!.answered_by).toEqual({
      by: null,
      absent_cause: 'name_unreadable',
    });
  });

  it('an over-long stored name is SHOWN capped with the house marker — not withheld', () => {
    const run = makeRun([answer({ responded_by: 'n'.repeat(300) })]);
    expect(composeStepViews(run)['gate_step']!.answers![0]!.answered_by).toEqual({
      by: `${'n'.repeat(200)}…[truncated]`,
      by_source: 'stated',
    });
  });

  it('claim_proof_absent — precedence: a readable verdict wins; else unreadable; else expiry; else not recorded', () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [
        { claim_proof: { proof: 'absent' }, resolution: 'expired_default' },
        { claim_proof: { proof: 'absent' } },
      ],
      [
        { claim_proof: { proof: 'bogus' }, resolution: 'expired_default' },
        { claim_proof_absent: 'proof_unreadable' },
      ],
      [{ claim_proof: 'nope' }, { claim_proof_absent: 'proof_unreadable' }],
      [{ resolution: 'expired_default' }, { claim_proof_absent: 'settled_by_expiry' }],
      [{ resolution: 'expired_abort' }, { claim_proof_absent: 'settled_by_expiry' }],
      [{}, { claim_proof_absent: 'proof_not_recorded' }],
    ];
    for (const [entryExtra, expected] of cases) {
      const view = composeStepViews(makeRun([answer(entryExtra)]))['gate_step']!.answers![0]!;
      expect({
        claim_proof: view.claim_proof,
        claim_proof_absent: view.claim_proof_absent,
      }).toEqual({
        claim_proof: undefined,
        claim_proof_absent: undefined,
        ...expected,
      });
    }
  });

  it('a step with no answer carries no `answers` key at all', () => {
    const run = makeRun([{ step_id: 's', status: 'success' }]);
    expect('answers' in composeStepViews(run)['s']!).toBe(false);
  });

  it('totality: a gate_response entry with no string step_id mints nothing and never throws', () => {
    expect(
      composeStepViews(makeRun([{ kind: 'gate_response' }, { step_id: 5, kind: 'gate_response' }])),
    ).toEqual({});
  });
});
