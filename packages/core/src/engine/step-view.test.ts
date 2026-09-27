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

  it('gate_response entries are never attempts and, alone, mint no StepView', () => {
    const run = makeRun([{ step_id: 'gate_step', kind: 'gate_response', status: 'success' }]);
    expect(composeStepViews(run)).toEqual({});
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
