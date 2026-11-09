// step-view.test.ts — issue #600 PR 1b (D7): the one place "how do you sum a per-request counter
// honestly" lives, and the one place a step's cost is classified when there is none to sum.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  composeCostView,
  composeStepViews,
  composeDriveFailureCosts,
  composeRunCost,
  isAnswerEntry,
} from './step-view.js';
import {
  priceFromEconomics,
  type CacheEconomics,
  type CacheEconomicsPrice,
  type CacheEconomicsRates,
} from '../economics/cache-economics.js';
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
      asked: { entries: [{ value: 'off', provider: 'anthropic' }], reported: 1, of: 1 },
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

  // Cell 3 (the lifetime unit): an ask carries the evidence `auto` chose by. Two requests whose
  // `cache_auto` differ only in key order are ONE ask; a different `cache_auto` is another ask; a
  // malformed one is not carried. (a) red when `auto` is not carried, when the dedup key is built
  // from the stored key order, or when `auto` is left out of the dedup key; (b) prints
  // `cache_requested`.
  it('cache_requested carries auto: equal auto in any key order is one ask, a different auto another', () => {
    const asked = {
      cache_requested: 'lifetime',
      cache_lifetime_s: 3600,
      cache_ttl_sent: true,
      cache_requested_source: 'runner_default',
      cache_requested_by: 'realm listen',
    };
    const view = composeCostView([
      req({ ...asked, cache_auto: { basis: 'listen_trigger_gaps', gaps_s: [420, 720] } }, 0),
      req({ ...asked, cache_auto: { gaps_s: [420, 720], basis: 'listen_trigger_gaps' } }, 1),
      req({ ...asked, cache_auto: { basis: 'listen_trigger_gaps', gaps_s: [] } }, 2),
      req({ ...asked, cache_auto: { basis: 'guessed' } }, 3),
    ]);
    expect(view!.cache_requested).toEqual({
      entries: [
        {
          value: 'lifetime',
          lifetime_s: 3600,
          ttl_sent: true,
          source: 'runner_default',
          by: 'realm listen',
          // #898 (A.6): a record with kept gaps and no `prices` predates priced auto; the view says
          // so, deterministically, so the two key orders still make one ask.
          auto: {
            basis: 'listen_trigger_gaps',
            gaps_s: [420, 720],
            prices: { from: 'not_recorded' },
          },
        },
        {
          value: 'lifetime',
          lifetime_s: 3600,
          ttl_sent: true,
          source: 'runner_default',
          by: 'realm listen',
          auto: { basis: 'listen_trigger_gaps', gaps_s: [] },
        },
        {
          value: 'lifetime',
          lifetime_s: 3600,
          ttl_sent: true,
          source: 'runner_default',
          by: 'realm listen',
        },
      ],
      reported: 4,
      of: 4,
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

// Caching 3-M A-2b1: the cost view carries the requests that missed the cache.
describe('caching 3-M A-2b1 — CostView.misses', () => {
  const sha = (c: string): string => c.repeat(64);
  /** The parts every turn of one call sends (A-0's facts; digests, never text). */
  const TOOL_PARTS = { tools: sha('a'), system: sha('b'), prompt: sha('c') };
  /**
   * live-899's drive_a: the six Anthropic tool turns of one call, counts and stamps as captured
   * (`plans/llm-prompt-caching/tools-path/live-899/usage.txt` and its run record 48c5e609…). Each
   * turn reads what the turn before read plus wrote. The capture predates A-0 and A-1b, so each
   * turn gains its place in the call, the same parts and marks, and `request_strict_sent`.
   */
  const LIVE_899 = [
    { start: '2026-10-29T16:07:28.795Z', prompt: 6901, uncached: 4, read: 0, write: 6897, out: 47 },
    {
      start: '2026-10-29T16:07:30.900Z',
      prompt: 6995,
      uncached: 2,
      read: 6897,
      write: 96,
      out: 47,
    },
    {
      start: '2026-10-29T16:07:32.286Z',
      prompt: 7089,
      uncached: 2,
      read: 6993,
      write: 94,
      out: 47,
    },
    {
      start: '2026-10-29T16:07:33.595Z',
      prompt: 7183,
      uncached: 2,
      read: 7087,
      write: 94,
      out: 47,
    },
    {
      start: '2026-10-29T16:07:34.969Z',
      prompt: 7277,
      uncached: 2,
      read: 7181,
      write: 94,
      out: 47,
    },
    {
      start: '2026-10-29T16:07:36.282Z',
      prompt: 7363,
      uncached: 2,
      read: 7275,
      write: 86,
      out: 11,
    },
  ];
  type Turn = (typeof LIVE_899)[number];
  const toolTurns = (turns: readonly Turn[]): Record<string, unknown>[] =>
    turns.map((t, i) => ({
      request_start: t.start,
      request_index: i,
      request_in_call: i,
      model: 'claude-sonnet-5-5',
      endpoint: 'default',
      provider: 'anthropic',
      prompt_tokens: t.prompt,
      uncached_input_tokens: t.uncached,
      output_tokens: t.out,
      cache_read_input_tokens: t.read,
      cache_creation_input_tokens: t.write,
      cache_creation: { ephemeral_5m_input_tokens: t.write, ephemeral_1h_input_tokens: 0 },
      cache_requested: 'lifetime',
      cache_lifetime_s: 300,
      request_strict_sent: false,
      prefix_parts: TOOL_PARTS,
      cache_marked: ['system', 'conversation'],
    }));
  /**
   * (b)'s list, constructed from the capture: turn 4 starts 420 s after turn 3, reads 0 and writes
   * 7275 (its prompt, 7277, less its 2 uncached tokens). The capture's own turns are seconds apart
   * and ask for one tool call each; 420 s is what a slow round of tools would leave (the tool step
   * in cache-misses.test.ts). Turn 5 follows 1.313 s later as captured and reads 7275 = 0 + 7275:
   * it holds.
   */
  const pausedTurns = (): Turn[] =>
    LIVE_899.map((t, i) =>
      i === 4
        ? { ...t, start: '2026-10-29T16:14:33.595Z', read: 0, write: 7275 }
        : i === 5
          ? { ...t, start: '2026-10-29T16:14:34.908Z' }
          : t,
    );
  /** What a failing cell prints: each entry's place, start and counts. */
  const show = (list: readonly Record<string, unknown>[]): string =>
    list
      .map(
        (r, i) =>
          `#${i} in_call=${String(r['request_in_call'])} start=${String(r['request_start'])} ` +
          `read=${String(r['cache_read_input_tokens'])} ` +
          `write=${String(r['cache_creation_input_tokens'] ?? r['cache_write_tokens'])} ` +
          `reference=${r['reference'] === undefined ? 'none' : 'yes'}`,
      )
      .join('\n');

  // 1 (a) The captured six turns all held. Can fail: `misses` always present, empty. Prints the list.
  it('a list whose every request held has no misses key', () => {
    const list = toolTurns(LIVE_899);
    const view = composeCostView(list);
    expect(view !== undefined && 'misses' in view, show(list)).toBe(false);
  });

  // 1 (b) Turn 4, 420 s after turn 3's 5-minute write. Can fail: the cause taken from the next
  // position, or `position` counted from 1. Prints the list.
  it('a turn after a pause longer than the lifetime: one entry, possibly_expired, at position 4', () => {
    const list = toolTurns(pausedTurns());
    expect(composeCostView(list)?.misses, show(list)).toEqual([
      {
        position: 4,
        derived: {
          cause: 'possibly_expired',
          rule: 'exact',
          expected_tokens: 7181,
          shortfall_tokens: 7181,
          predecessor: { from: 'list', at: 3 },
          gap_s: 420,
          lifetime_s: 300,
          lifetime_from: 'written',
        },
      },
    ]);
  });

  // 1 (c) A GPT-5.6 tool step (`provider_rules`, so no lifetime recorded). The reference holds C9's
  // first captured answer (read 0, wrote 4012; plans/issue-896/live-checks/
  // results-gpt-5.6-luna-C9.json); drive 2, the next day, reads 0 and writes 4012, then its second
  // request is C9's second answer (read 4012, wrote 19). Can fail: `rule` hard-coded to `exact`, the
  // predecessor hard-coded to the list, or the lifetime keys always present. Prints the list.
  it('a request against an earlier drive under the tolerance: unexplained, the gap and no lifetime', () => {
    const facts = {
      provider: 'openai',
      model: 'gpt-5.6-luna',
      endpoint: 'default',
      cache_requested: 'provider_rules',
      request_strict_sent: false,
      prefix_parts: TOOL_PARTS,
    };
    const list = [
      {
        request_start: '2026-11-08T05:00:00.000Z',
        request_index: 0,
        request_in_call: 0,
        ...facts,
        prompt_tokens: 4015,
        cache_read_input_tokens: 0,
        cache_write_tokens: 4012,
        reference: {
          from: 'run',
          request_start: '2026-11-07T05:00:00.000Z',
          ...facts,
          cache_read_input_tokens: 0,
          cache_write_tokens: 4012,
        },
      },
      {
        request_start: '2026-11-08T05:00:02.000Z',
        request_index: 1,
        request_in_call: 1,
        ...facts,
        prompt_tokens: 4034,
        cache_read_input_tokens: 4012,
        cache_write_tokens: 19,
      },
    ];
    expect(composeCostView(list)?.misses, show(list)).toEqual([
      {
        position: 0,
        derived: {
          cause: 'unexplained',
          rule: 'tolerance',
          expected_tokens: 4012,
          shortfall_tokens: 4012,
          predecessor: { from: 'reference' },
          gap_s: 86400,
        },
      },
    ]);
  });

  // 1 (d) (b)'s list where turn 2 also read only 1000 and wrote 6087 (constructed: a turn whose
  // cache lookback reached only an earlier breakpoint, as Anthropic's docs describe, #946); its
  // prompt stays 7089, so turn 3 holds as captured. Can fail: the entries reversed, or only the
  // first miss kept. Prints the list.
  it('two misses in one list: two entries, in list order', () => {
    const list = toolTurns(
      pausedTurns().map((t, i) => (i === 2 ? { ...t, read: 1000, write: 6087 } : t)),
    );
    expect(composeCostView(list)?.misses, show(list)).toEqual([
      {
        position: 2,
        derived: {
          cause: 'unexplained',
          rule: 'exact',
          expected_tokens: 6993,
          shortfall_tokens: 5993,
          predecessor: { from: 'list', at: 1 },
          gap_s: 1.386,
          lifetime_s: 300,
          lifetime_from: 'written',
        },
      },
      {
        position: 4,
        derived: {
          cause: 'possibly_expired',
          rule: 'exact',
          expected_tokens: 7181,
          shortfall_tokens: 7181,
          predecessor: { from: 'list', at: 3 },
          gap_s: 420,
          lifetime_s: 300,
          lifetime_from: 'written',
        },
      },
    ]);
  });

  // 4 The import cycle is gone: the miss rule takes nothing from step-view.ts, which takes the
  // rule from it (#910's precedent, cannot-run-summary-872.test.ts). Can fail: the helpers' move
  // reverted. Prints the import statements found.
  it('cache-misses.ts imports nothing from step-view.ts — no import cycle in core', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./cache-misses.ts', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // Whole statements, so a wrapped import is caught; a type-only import is refused too.
    const fromStepView = source.match(/import\s[^;]*?from\s*'\.\/step-view\.js'/g) ?? [];
    expect(fromStepView).toEqual([]);
  });

  // Caching 3-M A-2b3: what a miss cost, at the runner's own file's rates, through the real rule
  // (`priceFromEconomics`). The rates are the documented example's
  // (docs/reference/cache-economics.md). A failing cell prints the list's places and counts and the
  // figure, never prompt text.
  describe('caching 3-M A-2b3 — what a miss cost', () => {
    const RATES: CacheEconomicsRates = {
      input: 2,
      output: 10,
      cache_read: 0.1,
      cache_write_5m: 2.5,
      cache_write_1h: 4,
    };
    const fileOf = (model: string, price: CacheEconomicsPrice): CacheEconomics => ({
      version: 1,
      currency: 'USD',
      models: { [model]: { prices: [price] } },
    });
    const sourceOf = (file: CacheEconomics): PriceSource => ({
      price: (q) => priceFromEconomics(file, q.model, q.at, q.usage),
    });
    const SONNET = 'claude-sonnet-5-5';
    const FILE = sourceOf(fileOf(SONNET, { per_million_tokens: RATES }));
    /** The miss at `position`, composed with `source`. */
    const missAt = (
      list: readonly unknown[],
      source: PriceSource,
      position: number,
    ): NonNullable<NonNullable<ReturnType<typeof composeCostView>>['misses']>[number] | undefined =>
      composeCostView(list, undefined, { priceSource: source })?.misses?.find(
        (m) => m.position === position,
      );
    /** Turn 4 of (a)'s list with its counts replaced. */
    const withTurn4 = (counts: Partial<Turn>): Record<string, unknown>[] =>
      toolTurns(pausedTurns().map((t, i) => (i === 4 ? { ...t, ...counts } : t)));
    /** `false` when the miss is there and has no figure; a miss that is gone reads differently. */
    const hasFigure = (m: ReturnType<typeof missAt>): boolean | string =>
      m === undefined ? 'no miss at this place' : 'extra_usd' in m;

    // (a) A-2b1's cell 1 (b) list: a tool turn after a pause re-wrote the whole entry at the
    // 5-minute rate. Can fail: M12's first sketch, shortfall × (input − read) (0.0136439); or the
    // full read leaving the write unchanged (a negative difference, so no figure).
    it('(a) a miss that re-wrote the entry: the shortfall at the write rate less the read rate', () => {
      const list = toolTurns(pausedTurns());
      expect(missAt(list, FILE, 4)?.extra_usd, show(list)).toBeCloseTo(0.0172344, 10);
    });

    // (b) The same on a 1-hour write, so the entry had not expired after 420 s. Can fail: the write
    // always priced at the 5-minute rate (0.0172344), or the 1-hour write left standing.
    it('(b) a miss that re-wrote at the 1-hour rate: the figure is at that rate', () => {
      const list = toolTurns(pausedTurns()).map((r) => ({
        ...r,
        cache_lifetime_s: 3600,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: r['cache_creation_input_tokens'],
        },
      }));
      const miss = missAt(list, FILE, 4);
      expect(miss?.derived.cause, show(list)).toBe('unexplained');
      expect(miss?.extra_usd, show(list)).toBeCloseTo(0.0280059, 10);
    });

    // (c) A miss that wrote nothing: the provider sent the whole prompt uncached. Can fail: the
    // shortfall taken only from the writes (the full read keeps its uncached part).
    it('(c) a miss that wrote nothing: the shortfall at the input rate less the read rate', () => {
      const list = withTurn4({ uncached: 7277, write: 0 });
      expect(missAt(list, FILE, 4)?.extra_usd, show(list)).toBeCloseTo(0.0136439, 10);
    });

    // (d) A partial write: 1000 tokens went to the cache, 6181 of the shortfall stayed uncached.
    // Can fail: the part the writes cannot cover dropped (0.0024).
    it('(d) a partial write: each part of the shortfall at its own rate, less the read rate', () => {
      const list = withTurn4({ uncached: 6277, write: 1000 });
      expect(missAt(list, FILE, 4)?.extra_usd, show(list)).toBeCloseTo(0.0141439, 10);
    });

    // (e) A long prompt: 120,000 tokens is above claude-haiku-5-5's tier, and the shortfall alone
    // (89,996) is not. Can fail: a stand-in whose `prompt_tokens` is the shortfall (base rates,
    // 0.01034954).
    it("(e) a prompt above the model's tier: both sides at the tier's rates", () => {
      const list = toolTurns([
        {
          start: '2026-11-08T05:00:00.000Z',
          prompt: 90000,
          uncached: 4,
          read: 0,
          write: 89996,
          out: 47,
        },
        {
          start: '2026-11-08T05:00:01.000Z',
          prompt: 120000,
          uncached: 4,
          read: 0,
          write: 119996,
          out: 47,
        },
      ]).map((r) => ({ ...r, model: 'claude-haiku-5-5' }));
      const source = sourceOf(
        fileOf('claude-haiku-5-5', {
          per_million_tokens: {
            input: 0.1,
            output: 0.5,
            cache_read: 0.01,
            cache_write_5m: 0.125,
            cache_write_1h: 0.2,
          },
          tiers: [
            {
              above_prompt_tokens: 100000,
              per_million_tokens: {
                input: 0.5,
                output: 2.5,
                cache_read: 0.05,
                cache_write_5m: 0.625,
                cache_write_1h: 1,
              },
            },
          ],
        }),
      );
      expect(missAt(list, source, 1)?.extra_usd, show(list)).toBeCloseTo(0.0517477, 10);
    });

    /**
     * An OpenAI GPT-5.6 explicit request against a reference: C1's first answer (read 0, wrote 3930;
     * plans/issue-896/live-checks/results-gpt-5.6-luna.json). It records `cache_write_tokens`, no
     * split and `cache_split_offered: false`. The capture holds no output count, and the figure
     * does not depend on one. The rates are example rates: these cells test the route.
     */
    const GPT = 'gpt-5.6-luna';
    const GPT_FILE = sourceOf(
      fileOf(GPT, {
        per_million_tokens: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
      }),
    );
    const gptRequest = (read: number, write: number): Record<string, unknown>[] => {
      const facts = {
        provider: 'openai',
        model: GPT,
        endpoint: 'default',
        cache_requested: 'lifetime',
        cache_lifetime_s: 1800,
        cache_split_offered: false,
        request_strict_sent: false,
        prefix_parts: TOOL_PARTS,
      };
      return [
        {
          request_start: '2026-11-08T05:01:00.000Z',
          request_index: 0,
          request_in_call: 0,
          ...facts,
          prompt_tokens: 4015,
          output_tokens: 40,
          cache_read_input_tokens: read,
          cache_write_tokens: write,
          reference: {
            from: 'run',
            request_start: '2026-11-08T05:00:00.000Z',
            ...facts,
            cache_read_input_tokens: 0,
            cache_write_tokens: 3930,
          },
        },
      ];
    };

    // (f) The whole write falls. Can fail: a split assumed on a request that records none
    // (`usage_incomplete`, so no figure).
    it('(f) an OpenAI request with no split: the shortfall at its one write rate less the read rate', () => {
      const list = gptRequest(0, 3930);
      expect(missAt(list, GPT_FILE, 0)?.extra_usd, show(list)).toBeCloseTo(0.009039, 10);
    });

    // Added to the prompt's list: (f) empties the write, so it cannot tell a write reduced from a
    // write emptied. Here 50 written tokens remain (constructed: read 930, wrote 3050). Can fail:
    // the write counter emptied rather than reduced (0.006925), or a split written when the request
    // has none (`usage_incomplete`, so no figure).
    it('(f2) an OpenAI request whose write only partly falls: it still records no split', () => {
      const list = gptRequest(930, 3050);
      expect(missAt(list, GPT_FILE, 0)?.extra_usd, show(list)).toBeCloseTo(0.0069, 10);
    });

    // (g) No figure. Only the runner's own file counts: here a price list. Each side is the real
    // rule's answer relabelled, so the two totals differ. Can fail: the `economics` test removed.
    it('(g) a price that is not from the economics file: no figure', () => {
      const file = fileOf(SONNET, { per_million_tokens: RATES });
      const relabelled: PriceSource = {
        price: (q) => {
          const r = priceFromEconomics(file, q.model, q.at, q.usage);
          return 'priced' in r
            ? { ...r, priced_by: { ...r.priced_by, source_class: 'price_list' } }
            : r;
        },
      };
      const list = toolTurns(pausedTurns());
      expect(hasFigure(missAt(list, relabelled, 4)), show(list)).toBe(false);
    });

    // (g) A file with no `cache_read` rate: the request read nothing, so it is priced; its full read
    // is `rate_missing`. Can fail: a side not priced counted as 0 (the figure would be the total).
    it('(g) a file with no cache_read rate: the request is priced, the full read is not, no figure', () => {
      const { cache_read: _unused, ...withoutRead } = RATES;
      const source = sourceOf(fileOf(SONNET, { per_million_tokens: withoutRead }));
      const list = toolTurns(pausedTurns());
      expect(hasFigure(missAt(list, source, 4)), show(list)).toBe(false);
    });

    // (g) A prompt edit shrank the prompt below what was expected: the full read would read more
    // than the prompt holds (`usage_incomplete`). Can fail: a side not priced counted as 0.
    it('(g) a full read that would exceed the prompt: no figure', () => {
      const list = withTurn4({ prompt: 5000, uncached: 4, write: 4996 });
      expect(hasFigure(missAt(list, FILE, 4)), show(list)).toBe(false);
    });

    const allRates = (rate: number): CacheEconomicsRates => ({
      input: rate,
      output: rate,
      cache_read: rate,
      cache_write_5m: rate,
      cache_write_1h: rate,
    });

    // (g) A file whose rates are all 0 (the docs allow it): the two sides are equal. Can fail: the
    // floor removed (`extra_usd` 0).
    it('(g) rates all 0: no figure', () => {
      const list = toolTurns(pausedTurns());
      const source = sourceOf(fileOf(SONNET, { per_million_tokens: allRates(0) }));
      expect(hasFigure(missAt(list, source, 4)), show(list)).toBe(false);
    });

    // (g) Equal rates leave float noise of 1.39e-17, above 0 and not a cost (the audit's case,
    // A3MA2B3-12). Can fail: the floor loosened to `> 0`, or removed.
    it('(g) equal rates that leave float noise above 0: no figure', () => {
      const list = toolTurns([
        {
          start: '2026-11-08T05:00:00.000Z',
          prompt: 56421,
          uncached: 4,
          read: 0,
          write: 56417,
          out: 47,
        },
        {
          start: '2026-11-08T05:00:01.000Z',
          prompt: 91706,
          uncached: 17,
          read: 776,
          write: 90913,
          out: 47,
        },
      ]);
      const source = sourceOf(fileOf(SONNET, { per_million_tokens: allRates(1.169) }));
      expect(hasFigure(missAt(list, source, 1)), show(list)).toBe(false);
    });

    // Added: the docs say `cost.misses` is absent "including when none could be compared". A list
    // recorded before each request said its place in its call (read as not recorded, never
    // compared), with a price source. Can fail: an empty list composed instead of no key.
    it('a list none of whose requests could be compared has no misses key', () => {
      const list = toolTurns(pausedTurns()).map(({ request_in_call: _gone, ...rest }) => rest);
      const view = composeCostView(list, undefined, { priceSource: FILE });
      expect(view !== undefined && 'misses' in view, show(list)).toBe(false);
    });

    // (h) Pricing a miss changes nothing stored, and the step's own money still prices every
    // request. Can fail: the full read a shallow copy whose `cache_creation` is edited in place.
    it('(h) the stored list is unchanged and the money still prices all six requests', () => {
      const list = toolTurns(pausedTurns());
      const before = structuredClone(list);
      const view = composeCostView(list, undefined, { priceSource: FILE });
      expect(list, show(list)).toEqual(before);
      expect([view?.money?.priced, view?.money?.of], show(list)).toEqual([6, 6]);
    });
  });

  // Caching 3-M B3b: what Anthropic said about a miss, read from the missed request's own record.
  // The answers are built from the SDK's types (`BetaCacheMiss*`): no live answer is captured.
  describe('caching 3-M B3b — what Anthropic said', () => {
    const ID = 'msg_01ABCDEFGHJKMNPQRSTVWXYZ';
    /** (b)'s list: the turn that missed (position 4) carries `diagnostics`, or nothing. */
    const answered = (diagnostics?: unknown): Record<string, unknown>[] =>
      toolTurns(pausedTurns()).map((r, i) =>
        i === 4 && diagnostics !== undefined ? { ...r, cache_diagnostics: diagnostics } : r,
      );
    const named = (result: unknown): unknown => ({ asked: true, reference_id: ID, result });
    const missOf = (
      list: readonly Record<string, unknown>[],
    ): NonNullable<NonNullable<ReturnType<typeof composeCostView>>['misses']>[number] | undefined =>
      composeCostView(list)?.misses?.find((m) => m.position === 4);

    // Can fail: a reason mapped to another; `no_divergence` dropped; the count required for every
    // reason (the rows with none); the count dropped. Prints the list and the difference.
    it.each<[string, unknown, unknown]>([
      // The conversation Realm sent differs from the answer it named, and Anthropic says how much.
      [
        'the messages changed, with a count',
        named({ type: 'messages_changed', cache_missed_input_tokens: 1200 }),
        { reason: 'messages_changed', cache_missed_input_tokens: 1200 },
      ],
      // The agent profile or the step's schema moved the system text between two turns.
      [
        'the system text changed, with a count',
        named({ type: 'system_changed', cache_missed_input_tokens: 6900 }),
        { reason: 'system_changed', cache_missed_input_tokens: 6900 },
      ],
      // The MCP server listed different tools between two turns.
      [
        'the tools changed, with a count',
        named({ type: 'tools_changed', cache_missed_input_tokens: 900 }),
        { reason: 'tools_changed', cache_missed_input_tokens: 900 },
      ],
      // A gateway's fallback model answered the earlier turn.
      [
        'the model changed, with a count',
        named({ type: 'model_changed', cache_missed_input_tokens: 7181 }),
        { reason: 'model_changed', cache_missed_input_tokens: 7181 },
      ],
      // Anthropic names the difference and gives no count.
      [
        'the messages changed, no count',
        named({ type: 'messages_changed' }),
        { reason: 'messages_changed' },
      ],
      // The named answer has aged out at Anthropic, so it has nothing to compare with.
      [
        'the earlier request not found',
        named({ type: 'previous_message_not_found' }),
        { reason: 'previous_message_not_found' },
      ],
      // A difference Anthropic does not compare, such as a beta header.
      ['the comparison unavailable', named({ type: 'unavailable' }), { reason: 'unavailable' }],
      // A reason this Realm recorded as `unknown` at the write.
      ['a reason Realm did not know', named({ type: 'unknown' }), { reason: 'unknown' }],
      // The same, with a count: composition keeps what Anthropic gave; the words decide what prints.
      [
        'a reason Realm did not know, with a count',
        named({ type: 'unknown', cache_missed_input_tokens: 40 }),
        { reason: 'unknown', cache_missed_input_tokens: 40 },
      ],
      // Anthropic compared and the requests match: the miss is not about what was sent.
      ['no difference found', named('no_divergence'), { reason: 'no_divergence' }],
      // `realm run import` takes a file's values as they are: a reason from a later Realm's file.
      ['a type outside the list', named({ type: 'new' }), { reason: 'unknown' }],
      // The same route: a count that is no counter goes alone, and the reason stays.
      [
        'a count that is no counter',
        named({ type: 'messages_changed', cache_missed_input_tokens: 'many' }),
        { reason: 'messages_changed' },
      ],
    ])('%s', (_name, diagnostics, provider) => {
      const list = answered(diagnostics);
      expect(missOf(list)?.provider, show(list)).toEqual(provider);
    });

    // Can fail: `pending` given a reason; an absent `result` read as `no_divergence` (the null
    // reference); a `type` that is not a string kept. Prints the list and the entry.
    it.each<[string, unknown]>([
      // Anthropic has not finished comparing yet: it said nothing.
      ['the comparison pending', named('pending')],
      // The answer carried nothing Realm can read.
      ['nothing returned', named('not_returned')],
      // Anthropic refused the question earlier in this drive, so this request did not ask.
      ['the question refused', { asked: false, cause: 'rejected' }],
      // A call's first request names no earlier answer: nothing to compare with.
      ["a call's first request", { asked: true, reference_id: null }],
      // Asking off, a custom address, another provider.
      ['a request that never asked', undefined],
      // `realm run import` takes a file's values as they are.
      ['a type that is not a string', named({ type: 5 })],
    ])('%s: no provider key', (_name, diagnostics) => {
      const list = answered(diagnostics);
      const miss = missOf(list);
      expect([miss?.position, miss !== undefined && 'provider' in miss], show(list)).toEqual([
        4,
        false,
      ]);
    });

    // The record says the pause was too long; Anthropic says the messages changed. Both are
    // evidence and both are kept. Can fail: `provider` merged into `derived`, or either rewritten.
    // Prints the list and the difference.
    it("Realm's cause and Anthropic's reason disagree: both kept, untouched", () => {
      const list = answered(named({ type: 'messages_changed', cache_missed_input_tokens: 1200 }));
      expect(missOf(list), show(list)).toEqual({
        position: 4,
        derived: {
          cause: 'possibly_expired',
          rule: 'exact',
          expected_tokens: 7181,
          shortfall_tokens: 7181,
          predecessor: { from: 'list', at: 3 },
          gap_s: 420,
          lifetime_s: 300,
          lifetime_from: 'written',
        },
        provider: { reason: 'messages_changed', cache_missed_input_tokens: 1200 },
      });
    });
  });
});
