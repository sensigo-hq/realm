// cost-view-disclosure-parity.test.ts — the get_run_state half of issue #600 PR 1b (D4). The
// sibling of the CLI guard, same trigger: add a field to `CostView`/`CostFigure`/`AttemptView`/
// `StepView`/`CostUnrecordedCause` and BOTH surface packages stop compiling until someone routes
// it. This surface carries the composed view as DATA (`include_steps: true`), so every probe reads
// the field off the JSON-round-tripped response rather than out of prose — one probe per row,
// never one shared deep-equal probe (which every row would satisfy identically and nothing would
// notice a dropped field).
//
// Waivers are allowed only for `basis`/`state` on context 4 (`drive_failure_costs`) — a drive
// failure's usage carries no classification, `composeDriveFailureCosts` never sets either. Every
// other row here renders; `only_request_index` is NOT waived on this context (unlike the CLI's
// context 2) — the failure line always sums so the field has no place there, but a machine
// consumer of `drive_failure_costs` gets the raw figure and can decide for itself.
import { describe, it, expect } from 'vitest';
import type {
  RunRecord,
  RunStore,
  CostView,
  CostFigure,
  AttemptView,
  StepView,
  CostUnrecordedCause,
  DriveFailureCost,
} from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';

type DisclosureRoute =
  { surface: 'rendered'; probe: () => void } | { surface: 'waived'; reason: string };

function makeStore(run: RunRecord): RunStore {
  return {
    persistsClaims: true,
    get: async () => run,
    create: async () => {
      throw new Error('not exercised');
    },
    update: async () => {
      throw new Error('not exercised');
    },
    list: async () => {
      throw new Error('not exercised');
    },
    claimStep: async () => {
      throw new Error('not exercised');
    },
  } as unknown as RunStore;
}

// ---------------------------------------------------------------------------------------------
// CONTEXT 3 — `steps`.
// ---------------------------------------------------------------------------------------------

const moneyStepEarly = {
  step_id: 'money_step',
  kind: 'execution' as const,
  status: 'error' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 1,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'h1',
  diagnostics: {
    input_token_estimate: 1,
    precondition_trace: [],
    cache: {
      state: 'engaged' as const,
      basis: 'provider_reported' as const,
      requests: [{ request_index: 0, request_start: 't0', cache_read_input_tokens: 111 }],
    },
  },
};
const moneyStepLast = {
  step_id: 'money_step',
  kind: 'execution' as const,
  status: 'success' as const,
  started_at: '2026-01-01T00:00:02.000Z',
  completed_at: '2026-01-01T00:00:03.000Z',
  duration_ms: 1,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'h2',
  diagnostics: {
    input_token_estimate: 1,
    precondition_trace: [],
    cache: {
      state: 'engaged' as const,
      basis: 'provider_reported' as const,
      requests: [
        {
          request_index: 0,
          request_start: 't0',
          prompt_tokens: 500,
          cache_read_input_tokens: 200,
          output_tokens: 10,
        },
        {
          request_index: 1,
          request_start: 't1',
          cache_creation_input_tokens: 77,
          uncached_input_tokens: 33,
        },
      ],
    },
  },
};
const toolsStep = {
  step_id: 'tools_step',
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 1,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'h3',
  tool_calls: [],
  diagnostics: { input_token_estimate: 1, precondition_trace: [] },
};
const externalStep = {
  step_id: 'external_step',
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 1,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'h4',
  agent_profile: 'reviewer',
  diagnostics: { input_token_estimate: 1, precondition_trace: [] },
};
const corruptStep = {
  step_id: 'corrupt_step',
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 1,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'h5',
  diagnostics: {
    input_token_estimate: 1,
    precondition_trace: [],
    cache: { state: 'unobservable', basis: 'unobservable', requests: 'not-an-array' },
  },
};

const contextThreeRun = {
  id: 'r3',
  workflow_id: 'wf',
  workflow_version: 1,
  completed_steps: [],
  in_progress_steps: [],
  failed_steps: [],
  skipped_steps: [],
  run_phase: 'completed',
  version: 1,
  params: {},
  evidence: [moneyStepEarly, moneyStepLast, toolsStep, externalStep, corruptStep],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:01.000Z',
  terminal_state: true,
} as unknown as RunRecord;

describe('#600 PR 1b (D4) — context 3, get_run_state.steps', () => {
  it('runs every registry against the real JSON-round-tripped response, no waivers', async () => {
    const summary = await handleGetRunState(
      { run_id: 'r3', include_steps: true },
      { runStore: makeStore(contextThreeRun) },
    );
    const money = summary.steps!['money_step']!;
    const last = money.attempts[1]!.cost!;

    const COST_VIEW = {
      requests: { surface: 'rendered', probe: () => expect(last.requests).toBe(2) },
      basis: { surface: 'rendered', probe: () => expect(last.basis).toBe('provider_reported') },
      state: { surface: 'rendered', probe: () => expect(last.state).toBe('engaged') },
      prompt: {
        surface: 'rendered',
        probe: () =>
          expect(last.prompt).toEqual({ value: 500, reported: 1, of: 2, only_request_index: 0 }),
      },
      uncached_input: {
        surface: 'rendered',
        probe: () =>
          expect(last.uncached_input).toEqual({
            value: 33,
            reported: 1,
            of: 2,
            only_request_index: 1,
          }),
      },
      cache_read: {
        surface: 'rendered',
        probe: () =>
          expect(last.cache_read).toEqual({
            value: 200,
            reported: 1,
            of: 2,
            only_request_index: 0,
          }),
      },
      cache_write: {
        surface: 'rendered',
        probe: () =>
          expect(last.cache_write).toEqual({
            value: 77,
            reported: 1,
            of: 2,
            only_request_index: 1,
          }),
      },
      output: {
        surface: 'rendered',
        probe: () =>
          expect(last.output).toEqual({ value: 10, reported: 1, of: 2, only_request_index: 0 }),
      },
    } satisfies Record<keyof CostView, DisclosureRoute>;

    const COST_FIGURE = {
      value: { surface: 'rendered', probe: () => expect(last.prompt!.value).toBe(500) },
      reported: { surface: 'rendered', probe: () => expect(last.prompt!.reported).toBe(1) },
      of: { surface: 'rendered', probe: () => expect(last.prompt!.of).toBe(2) },
      only_request_index: {
        surface: 'rendered',
        probe: () =>
          expect(
            summary.steps!['money_step']!.attempts[0]!.cost!.cache_read!.only_request_index,
          ).toBe(0),
      },
    } satisfies Record<keyof CostFigure, DisclosureRoute>;

    const ATTEMPT_VIEW = {
      attempt: { surface: 'rendered', probe: () => expect(money.attempts[0]!.attempt).toBe(1) },
      status: { surface: 'rendered', probe: () => expect(money.attempts[0]!.status).toBe('error') },
      cost: { surface: 'rendered', probe: () => expect(money.attempts[0]!.cost).toBeDefined() },
      cost_unrecorded: {
        surface: 'rendered',
        probe: () =>
          expect(summary.steps!['tools_step']!.attempts[0]!.cost_unrecorded).toBe(
            'tool_calling_step',
          ),
      },
      cost_unreadable: {
        surface: 'rendered',
        probe: () =>
          expect(summary.steps!['corrupt_step']!.attempts[0]!.cost_unreadable).toBe(true),
      },
    } satisfies Record<keyof AttemptView, DisclosureRoute>;

    const STEP_VIEW = {
      attempts: { surface: 'rendered', probe: () => expect(money.attempts).toHaveLength(2) },
    } satisfies Record<keyof StepView, DisclosureRoute>;

    const UNRECORDED_CAUSE = {
      tool_calling_step: {
        surface: 'rendered',
        probe: () =>
          expect(summary.steps!['tools_step']!.attempts[0]!.cost_unrecorded).toBe(
            'tool_calling_step',
          ),
      },
      not_driven_by_realm: {
        surface: 'rendered',
        probe: () =>
          expect(summary.steps!['external_step']!.attempts[0]!.cost_unrecorded).toBe(
            'not_driven_by_realm',
          ),
      },
    } satisfies Record<CostUnrecordedCause, DisclosureRoute>;

    for (const registry of [COST_VIEW, COST_FIGURE, ATTEMPT_VIEW, STEP_VIEW, UNRECORDED_CAUSE]) {
      for (const [field, route] of Object.entries(registry)) {
        if (route.surface === 'rendered') route.probe();
        else throw new Error(`unexpected waiver for '${field}'`);
      }
    }
  });

  it('default response has no steps key', async () => {
    const summary = await handleGetRunState(
      { run_id: 'r3' },
      { runStore: makeStore(contextThreeRun) },
    );
    expect('steps' in summary).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// CONTEXT 4 — `drive_failure_costs`.
// ---------------------------------------------------------------------------------------------

const ENTRY_A = {
  at: '2026-01-01T00:04:00.000Z',
  step: 'classify',
  provider: 'anthropic',
  error_class: 'api_status' as const,
  message: 'rate limited',
  elapsed_ms: 1200,
  usage: [
    {
      request_index: 0,
      request_start: 't0',
      prompt_tokens: 900,
      output_tokens: 15,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 0,
    },
    { request_index: 1, request_start: 't1', output_tokens: 25 },
  ],
};
const ENTRY_B = {
  at: '2026-01-01T00:05:00.000Z',
  step: 'classify',
  provider: 'anthropic',
  error_class: 'other' as const,
  message: 'connection reset',
  elapsed_ms: 300,
  usage: [{ request_index: 0, request_start: 't0', uncached_input_tokens: 60 }],
};

const contextFourRun = {
  id: 'r4',
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
  drive_failures: { first_failed_at: ENTRY_A.at, total: 2, entries: [ENTRY_A, ENTRY_B] },
} as unknown as RunRecord;

describe('#600 PR 1b (D4) — context 4, get_run_state.drive_failure_costs', () => {
  it('runs every registry against the real JSON-round-tripped response', async () => {
    const summary = await handleGetRunState(
      { run_id: 'r4', include_steps: true },
      { runStore: makeStore(contextFourRun) },
    );
    const costs = summary.drive_failure_costs!;
    expect(costs).toHaveLength(2);
    const a = costs[0]!;
    const b = costs[1]!;

    const ELEMENT = {
      at: { surface: 'rendered', probe: () => expect(a.at).toBe(ENTRY_A.at) },
      step: { surface: 'rendered', probe: () => expect(a.step).toBe('classify') },
      error_class: { surface: 'rendered', probe: () => expect(a.error_class).toBe('api_status') },
      cost: { surface: 'rendered', probe: () => expect(a.cost).toBeDefined() },
    } satisfies Record<keyof DriveFailureCost, DisclosureRoute>;

    const COST_VIEW = {
      requests: { surface: 'rendered', probe: () => expect(a.cost!.requests).toBe(2) },
      basis: { surface: 'waived', reason: "a drive failure's usage carries no classification" },
      state: { surface: 'waived', reason: "a drive failure's usage carries no classification" },
      prompt: {
        surface: 'rendered',
        probe: () =>
          expect(a.cost!.prompt).toEqual({ value: 900, reported: 1, of: 2, only_request_index: 0 }),
      },
      uncached_input: {
        surface: 'rendered',
        probe: () =>
          expect(b.cost!.uncached_input).toEqual({
            value: 60,
            reported: 1,
            of: 1,
            only_request_index: 0,
          }),
      },
      cache_read: {
        surface: 'rendered',
        probe: () =>
          expect(a.cost!.cache_read).toEqual({
            value: 400,
            reported: 1,
            of: 2,
            only_request_index: 0,
          }),
      },
      cache_write: {
        surface: 'rendered',
        probe: () =>
          expect(a.cost!.cache_write).toEqual({
            value: 0,
            reported: 1,
            of: 2,
            only_request_index: 0,
          }),
      },
      output: {
        surface: 'rendered',
        probe: () => expect(a.cost!.output).toEqual({ value: 40, reported: 2, of: 2 }),
      },
    } satisfies Record<keyof CostView, DisclosureRoute>;

    const COST_FIGURE = {
      value: { surface: 'rendered', probe: () => expect(a.cost!.prompt!.value).toBe(900) },
      reported: { surface: 'rendered', probe: () => expect(a.cost!.prompt!.reported).toBe(1) },
      of: { surface: 'rendered', probe: () => expect(a.cost!.prompt!.of).toBe(2) },
      only_request_index: {
        surface: 'rendered',
        probe: () => expect(a.cost!.prompt!.only_request_index).toBe(0),
      },
    } satisfies Record<keyof CostFigure, DisclosureRoute>;

    for (const registry of [ELEMENT, COST_VIEW, COST_FIGURE]) {
      for (const [field, route] of Object.entries(registry)) {
        if (route.surface === 'rendered') route.probe();
        else
          expect(
            (route as { reason: string }).reason.trim().length,
            `waiver for '${field}' has an empty reason`,
          ).toBeGreaterThan(0);
      }
    }

    const waivedView = Object.entries(COST_VIEW)
      .filter(([, r]) => r.surface === 'waived')
      .map(([f]) => f)
      .sort();
    expect(waivedView).toEqual(['basis', 'state']);
  });

  it('ABSENT — never [] — when include_steps was not asked', async () => {
    const summary = await handleGetRunState(
      { run_id: 'r4' },
      { runStore: makeStore(contextFourRun) },
    );
    expect('drive_failure_costs' in summary).toBe(false);
  });
});
