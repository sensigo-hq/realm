// step-view.test.ts — issue #600 PR 1b (D7): the one place "how do you sum a per-request counter
// honestly" lives, and the one place a step's cost is classified when there is none to sum.
import { describe, it, expect } from 'vitest';
import {
  composeCostView,
  composeStepViews,
  composeDriveFailureCosts,
  composeRunCost,
  isAnswerEntry,
} from './step-view.js';
import type { PriceSource } from '../economics/price-source.js';
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

  it('an agent step by definition, no cache, no tool_calls: not_measured_by_realm', () => {
    const run = makeRun([{ step_id: 'agent_step', status: 'success' }]);
    const view = composeStepViews(run, { definition: basicDef });
    expect(view['agent_step']!.attempts[0]!.cost_unrecorded).toBe('not_measured_by_realm');
  });

  it('the agent_profile fallback fires with NO definition at all', () => {
    const run = makeRun([{ step_id: 's', status: 'success', agent_profile: 'reviewer' }]);
    expect(composeStepViews(run).s!.attempts[0]!.cost_unrecorded).toBe('not_measured_by_realm');
  });

  it('the agent_profile fallback fires when the definition no longer names the step', () => {
    const run = makeRun([
      { step_id: 'removed_step', status: 'success', agent_profile: 'reviewer' },
    ]);
    expect(
      composeStepViews(run, { definition: basicDef }).removed_step!.attempts[0]!.cost_unrecorded,
    ).toBe('not_measured_by_realm');
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
      // issue #600 PR 2 (A5): the request carries no `provider`, so both facts predate PR 2.
      models: { absent_cause: 'predates_request_facts' },
      cache_requested: { absent_cause: 'predates_request_facts' },
      // issue #600 caching PR P (A4): no request records an endpoint, and none carries `provider`.
      endpoints: { absent_cause: 'predates_request_facts' },
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

  it("F6: a responded_by stored with spaces at either end (an embedding program's own call) reads without them", () => {
    const run = makeRun([answer({ responded_by: '  bob  ' })]);
    // (a) red when readAnswerer hands the stored value through untrimmed; (b) prints the view.
    expect(composeStepViews(run)['gate_step']!.answers![0]!.answered_by).toEqual({
      by: 'bob',
      by_source: 'stated',
    });
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
  // Issue #625, PR-H review correction C2: the settlement writes `responded_by: 'timeout'` on the
  // entry its expiry makes; no answer was recorded in time. Keyed on `resolution`, never on the literal.
  it.each([['expired_default', { choice: 'hold' }, { choice: 'hold' }, 'hold']] as const)(
    'C2: an entry the gate’s expiry wrote (%s) reads no answerer: settled_by_expiry, whatever responded_by holds',
    (resolution, input_summary, output_summary, choice) => {
      const run = makeRun([
        { step_id: 'gate_step', kind: 'execution', status: 'success' },
        answer({ responded_by: 'timeout', resolution, input_summary, output_summary }),
      ]);
      // (a) red when the expiry's literal is read as a caller-stated name, or the reading keys on
      //     something other than `resolution`; (b) prints the view.
      expect(composeStepViews(run)['gate_step']!.answers).toEqual([
        {
          ...(choice !== undefined ? { choice } : {}),
          answered_by: { by: null, absent_cause: 'settled_by_expiry' },
          claim_proof_absent: 'settled_by_expiry',
        },
      ]);
    },
  );

  // An `on_expiry: abort` expiry writes a `gate_response` entry (`resolution: 'expired_abort'`, no
  // choice) but answers nothing and settles nothing — the run ends, the step is skipped. Not an answer.
  const abortEntry = {
    responded_by: 'timeout',
    resolution: 'expired_abort',
    input_summary: {},
    output_summary: { gate_expired: true, disposition: 'abort' },
  };
  it('an abort expiry’s entry is not an answer: the step keeps its attempts and has no `answers` key', () => {
    const run = makeRun([
      { step_id: 'gate_step', kind: 'execution', status: 'success' },
      answer(abortEntry),
    ]);
    const view = composeStepViews(run)['gate_step']!;
    // (a) red when the abort expiry is composed as an answer (the walk's RED: "settled by the gate's
    //     expiry" for a gate nothing settled); (b) prints the view.
    expect(view.attempts).toHaveLength(1);
    expect('answers' in view).toBe(false);
  });
  it('an abort expiry’s entry alone creates no step view', () => {
    expect(composeStepViews(makeRun([answer(abortEntry)]))).toEqual({});
  });
  it('isAnswerEntry, per member', () => {
    expect(isAnswerEntry({ kind: 'gate_response' })).toBe(true);
    expect(isAnswerEntry({ kind: 'gate_response', resolution: 'expired_default' })).toBe(true);
    expect(isAnswerEntry({ kind: 'gate_response', resolution: 'expired_abort' })).toBe(false);
    expect(isAnswerEntry({ kind: 'execution' })).toBe(false);
    expect(isAnswerEntry({})).toBe(false);
    expect(isAnswerEntry(null)).toBe(false);
    expect(isAnswerEntry('gate_response')).toBe(false);
  });

  it('C2 (control): a caller who STATES `timeout` as its name (no resolution) is a stated name', () => {
    const run = makeRun([answer({ responded_by: 'timeout' })]);
    // (a) red when the reading keys on `responded_by === 'timeout'`; (b) prints the view.
    expect(composeStepViews(run)['gate_step']!.answers![0]!.answered_by).toEqual({
      by: 'timeout',
      by_source: 'stated',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// issue #600 PR 2 (A4, A5): the request facts on the composed `CostView`. On a failing CI host each
// cell prints the composed fields: test values only.
// ---------------------------------------------------------------------------------------------
describe('composeCostView — the request facts (issue #600 PR 2)', () => {
  const ESC_MODEL = 'claude-\u001b[31mx';

  // G13. (a) red when composeCostView reads `model` without `readStoredName`; (b) prints `models`.
  it('a stored model that readStoredName refuses is not named, and not counted as reported', () => {
    const view = composeCostView([
      req({ model: 'claude-x-20260101' }, 0),
      req({ model: ESC_MODEL }, 1),
      req({ model: 'claude-x-20260101\n' }, 2),
    ]);
    expect(view!.models).toEqual({ names: ['claude-x-20260101'], reported: 2, of: 3 });
  });

  // G13, through the run record: a record written by hand (or an older build) is read the same way.
  it('a run record written directly with a bad model renders none through composeStepViews', () => {
    const run = makeRun([
      {
        step_id: 's',
        status: 'success',
        attempt: 1,
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: {
            state: 'unobservable',
            basis: 'unobservable',
            requests: [req({ model: ESC_MODEL, provider: 'anthropic', cache_requested: 'off' })],
          },
        },
      },
    ]);
    const cost = composeStepViews(run)['s']?.attempts[0]?.cost;
    expect({ models: cost?.models, asked: cost?.cache_requested }).toEqual({
      models: { absent_cause: 'none_readable' },
      asked: { entries: [{ value: 'off' }], reported: 1, of: 1 },
    });
  });

  // G26. (a) red when the two causes are swapped; (b) prints the two absences.
  it("A5: 'predates_request_facts' without provider, 'none_readable' with it (a refused model included)", () => {
    const old = composeCostView([req({ prompt_tokens: 5 })]);
    const driven = composeCostView([req({ prompt_tokens: 5, provider: 'module:p.mjs' })]);
    const refused = composeCostView([req({ model: ESC_MODEL, provider: 'anthropic' })]);
    expect({
      old: [old!.models, old!.cache_requested],
      driven: [driven!.models, driven!.cache_requested],
      refused: refused!.models,
    }).toEqual({
      old: [{ absent_cause: 'predates_request_facts' }, { absent_cause: 'predates_request_facts' }],
      driven: [{ absent_cause: 'none_readable' }, { absent_cause: 'none_readable' }],
      refused: { absent_cause: 'none_readable' },
    });
    // No requests: no request facts at all.
    expect(composeCostView([])).toEqual({ requests: 0 });
  });

  // A4. (a) red when entries are not distinct, lose their order, or keep a refused `by`; (b) prints
  // `cache_requested`.
  it('cache_requested: the distinct asks in request order, each field kept by its own rule', () => {
    const view = composeCostView([
      req(
        {
          cache_requested: 'lifetime',
          cache_lifetime_s: 3600,
          cache_ttl_sent: true,
          cache_requested_source: 'runner_default',
          cache_requested_by: 'realm listen',
        },
        0,
      ),
      req(
        {
          cache_requested: 'lifetime',
          cache_lifetime_s: 300,
          cache_ttl_sent: false,
          cache_requested_source: 'stated',
          cache_requested_by: 'realm agent',
        },
        1,
      ),
      req(
        {
          cache_requested: 'lifetime',
          cache_lifetime_s: 3600,
          cache_ttl_sent: true,
          cache_requested_source: 'runner_default',
          cache_requested_by: 'realm listen',
        },
        2,
      ),
      req(
        {
          cache_requested: 'lifetime',
          cache_lifetime_s: -5,
          cache_ttl_sent: 'yes',
          cache_requested_source: 7,
          cache_requested_by: 'x\u001by',
        },
        3,
      ),
      req({ prompt_tokens: 1 }, 4),
    ]);
    expect(view!.cache_requested).toEqual({
      entries: [
        {
          value: 'lifetime',
          lifetime_s: 3600,
          ttl_sent: true,
          source: 'runner_default',
          by: 'realm listen',
        },
        {
          value: 'lifetime',
          lifetime_s: 300,
          ttl_sent: false,
          source: 'stated',
          by: 'realm agent',
        },
        { value: 'lifetime', lifetime_s: -5 },
      ],
      reported: 4,
      of: 5,
    });
  });

  // A4. (a) red when the split is not summed from `cache_creation`; (b) prints the two figures.
  it('cache_write_5m and cache_write_1h are summed from the cache_creation split, as CostFigures', () => {
    const view = composeCostView([
      req({ cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 } }, 0),
      req({ cache_creation: { ephemeral_5m_input_tokens: 2 } }, 1),
      req({ prompt_tokens: 1 }, 2),
    ]);
    expect({ m5: view!.cache_write_5m, h1: view!.cache_write_1h }).toEqual({
      m5: { value: 42, reported: 2, of: 3 },
      h1: { value: 0, reported: 1, of: 3, only_request_index: 0 },
    });
  });
});

// ---------------------------------------------------------------------------------------------
// issue #600 caching PR P (G4, G5): money, derived at read. A fake source prices each request at
// its prompt in dollars (total) against twice that with no caching, so every sum is checkable by
// eye; a request whose model is `unknown-model` is not priced. On a failing CI host each cell prints
// the composed money: test figures only.
// ---------------------------------------------------------------------------------------------
const FAKE: PriceSource = {
  price(input) {
    if (input.model === 'unknown-model') return { not_priced: 'model_unknown' };
    return {
      priced: {
        total: input.usage.prompt_tokens,
        uncached_counterfactual: input.usage.prompt_tokens * 2,
      },
      priced_by: {
        source_class: 'economics',
        source_ref: '/srv/economics.yaml',
        matched_model: input.model,
        date_basis: input.model === 'dated-model' ? 'dated' : 'current',
      },
    };
  },
};
const priced = (prompt: number, model = 'm', index = 0): Record<string, unknown> =>
  req({ model, prompt_tokens: prompt, output_tokens: 0 }, index);

describe('composeCostView — money (issue #600 caching PR P, G4)', () => {
  // (a) red when money is minted without a source (the seven `requests` pins redden too, by
  // design); (b) prints the view.
  it('no source: no money key', () => {
    expect('money' in composeCostView([priced(1)])!).toBe(false);
  });

  // (a) red when net's sign is flipped, or not-priced requests are summed, or one source's two
  // models are two source totals; (b) prints the money.
  it('with a source: priced of of, the sums over priced requests only, net, sources, source totals and not_priced counts', () => {
    const view = composeCostView(
      [
        priced(1, 'm', 0),
        priced(2, 'dated-model', 1),
        priced(4, 'unknown-model', 2),
        req({ prompt_tokens: 3 }, 3),
      ],
      undefined,
      { priceSource: FAKE },
    );
    expect(view!.money).toEqual({
      total: 3,
      uncached_counterfactual: 6,
      net: 3,
      priced: 2,
      of: 4,
      dated: 1,
      sources: [
        {
          source_class: 'economics',
          source_ref: '/srv/economics.yaml',
          matched_model: 'm',
          count: 1,
          dated: 0,
        },
        {
          source_class: 'economics',
          source_ref: '/srv/economics.yaml',
          matched_model: 'dated-model',
          count: 1,
          dated: 1,
        },
      ],
      source_totals: [
        { source_class: 'economics', source_ref: '/srv/economics.yaml', count: 2, dated: 1 },
      ],
      not_priced: [
        { cause: 'model_unknown', count: 1 },
        { cause: 'model_not_recorded', count: 1 },
      ],
    });
  });

  // (a) red when the requests are summed before pricing (the tier of a summed prompt); (b) prints
  // the total. Each request priced singly at Haiku 5.5's list rates (input 0.1, output 0.5 per
  // million; 0.5 and 2.5 above 100,000 prompt tokens): three 40k requests with 1,000 out each.
  it('each request is priced on its own, never their sum', () => {
    const haiku: PriceSource = {
      price(input) {
        const tier = input.usage.prompt_tokens > 100000;
        const total =
          (input.usage.prompt_tokens * (tier ? 0.5 : 0.1) +
            input.usage.output_tokens * (tier ? 2.5 : 0.5)) /
          1e6;
        return {
          priced: { total, uncached_counterfactual: total },
          priced_by: {
            source_class: 'economics',
            source_ref: 'x',
            matched_model: input.model,
            date_basis: 'current',
          },
        };
      },
    };
    const three = [0, 1, 2].map((i) =>
      req({ model: 'claude-haiku-5-5', prompt_tokens: 40000, output_tokens: 1000 }, i),
    );
    const money = composeCostView(three, undefined, { priceSource: haiku })!.money!;
    expect(Number(money.total.toFixed(9))).toBe(0.0135);
  });

  // (a) red when the endpoints count is not derived, or its absence is not by cause; (b) prints it.
  it('endpoints: the custom count of all requests; the typed absence when none records one', () => {
    expect([
      composeCostView([
        req({ endpoint: 'custom' }, 0),
        req({ endpoint: 'default' }, 1),
        req({}, 2),
      ])!.endpoints,
      composeCostView([req({ provider: 'anthropic' })])!.endpoints,
      composeCostView([])!.endpoints,
    ]).toEqual([{ custom: 1, of: 3 }, { absent_cause: 'none_readable' }, undefined]);
  });
});

describe('composeRunCost and StepView.total (issue #600 caching PR P, G5)', () => {
  const run = makeRun(
    [
      { step_id: 'a', status: 'error', diagnostics: { cache: { requests: [priced(1)] } } },
      { step_id: 'a', status: 'success', diagnostics: { cache: { requests: [priced(2)] } } },
      { step_id: 'b', status: 'success', tool_calls: [] },
      { step_id: 'c', status: 'success', agent_profile: 'p' },
      { step_id: 'd', status: 'success', diagnostics: { cache: { requests: 'not-a-list' } } },
    ],
    {
      drive_failures: {
        first_failed_at: '2026-01-01T00:00:00.000Z',
        total: 8,
        entries: [
          { at: 'x', step: 'a', usage: [priced(4)] },
          // No usage figures: a request that failed on the wire may have billed.
          { at: 'y', step: 'a' },
        ],
      },
    } as never,
  );

  // (a) red when a step's total is not across its attempts; (b) prints the total.
  it('a step total is across its attempts, only with a source', () => {
    expect([
      composeStepViews(run, { priceSource: FAKE })['a']!.total?.total,
      composeStepViews(run)['a']!.total,
    ]).toEqual([3, undefined]);
  });

  // (a) red when a drive failure's billed requests are dropped, `total − entries` is not computed,
  // a failed drive with no usage figures is not counted, or an unmeasured cause is not counted;
  // (b) prints the run cost.
  it('the run: every step plus the failed drives on the record; failed drives not on the record; the three unmeasured counts', () => {
    const cost = composeRunCost(run, { priceSource: FAKE })!;
    expect({
      total: cost.total.total,
      priced: cost.total.priced,
      of: cost.total.of,
      failed_drives_not_on_record: cost.failed_drives_not_on_record,
      failed_drives_without_usage: cost.failed_drives_without_usage,
      unmeasured: cost.unmeasured,
    }).toEqual({
      total: 7,
      priced: 3,
      of: 3,
      failed_drives_not_on_record: 6,
      failed_drives_without_usage: 1,
      unmeasured: { tool_calling_step: 1, not_measured_by_realm: 1, cost_unreadable: 1 },
    });
    expect(composeRunCost(run)).toBeUndefined();
  });
});
