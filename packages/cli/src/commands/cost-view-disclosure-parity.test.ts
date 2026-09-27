// cost-view-disclosure-parity.test.ts — issue #600 PR 1b (D4): every field of the composed cost
// view (`CostView`, `CostFigure`, `AttemptView`, `StepView`, `CostUnrecordedCause`) must reach an
// operator through `realm run inspect`, on BOTH surfaces it renders on (the step line, context 1;
// the failure block, context 2), or carry a written reason why it does not.
//
// Same guard, same reasoning, as the `StepDiagnostics`/`DriveFailureRecord`/`SealedBy` siblings:
// nothing but a compile-forced registry can see "we added a field and forgot to show it". The
// `satisfies Record<keyof X, DisclosureRoute>` below is the trigger for each of the five
// vocabularies this PR mints.
//
// Waivers are allowed only here and on the mcp `drive_failure_costs` twin (context 4), for
// `basis`/`state` (a drive failure's usage carries no classification — `composeDriveFailureCosts`
// never sets either) and, on THIS context only, `CostFigure.only_request_index` (the failure line
// always sums: it reports spend, so one request's figure is shown as a floor of the sum, never as
// that request's size).
import { describe, it, expect } from 'vitest';
import { inspectRun } from './inspect.js';
import type {
  RunRecord,
  RunStore,
  WorkflowRegistrar,
  CostView,
  CostFigure,
  AttemptView,
  StepView,
  CostUnrecordedCause,
} from '@sensigo/realm';

type DisclosureRoute =
  { surface: 'rendered'; probe: (out: string) => void } | { surface: 'waived'; reason: string };

const workflowStore: WorkflowRegistrar = {
  register: async () => {},
  get: async () => {
    throw new Error('not registered');
  },
  list: async () => [],
};

function makeStore(run: RunRecord): RunStore {
  return {
    persistsClaims: true,
    get: async () => run,
    create: async () => ({ run, created: true }),
    update: async () => run,
    list: async () => [run],
    claimStep: async () => {
      throw new Error('claimStep is not used by inspect');
    },
  };
}

// ---------------------------------------------------------------------------------------------
// CONTEXT 1 — the step line.
// ---------------------------------------------------------------------------------------------

// `money_step`: two execution entries. The FIRST carries a full-shaped cost (read on both
// requests, write on one, a prompt on one, an output on one) — one figure with `reported < of`
// AND `only_request_index` present, discriminating every `CostFigure` key at once. The SECOND
// (the last entry) carries a simple full cost, so the Diagnostics line and the attempt-list both
// have something to show.
const moneyStepEarly = {
  step_id: 'money_step',
  kind: 'execution' as const,
  status: 'error' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 500,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'h1',
  diagnostics: {
    input_token_estimate: 5,
    precondition_trace: [],
    cache: {
      // A FOREIGN state word — discriminates `state` at all (an `engaged` record prints no state
      // word of its own; a probe on that text would be vacuous — a step reporting no cache
      // direction at all reaches the SAME "not reported" sentence through a different branch).
      state: 'foo_state' as unknown as 'engaged',
      basis: 'provider_reported' as const,
      requests: [
        {
          request_index: 0,
          request_start: '2026-01-01T00:00:00.000Z',
          cache_read_input_tokens: 300,
        },
        {
          request_index: 1,
          request_start: '2026-01-01T00:00:00.500Z',
          prompt_tokens: 700,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 88,
          output_tokens: 42,
        },
      ],
    },
  },
};
const moneyStepLast = {
  step_id: 'money_step',
  kind: 'execution' as const,
  status: 'success' as const,
  started_at: '2026-01-01T00:00:02.000Z',
  completed_at: '2026-01-01T00:00:03.000Z',
  duration_ms: 700,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'h2',
  diagnostics: {
    input_token_estimate: 5,
    precondition_trace: [],
    cache: {
      state: 'engaged' as const,
      basis: 'provider_reported' as const,
      requests: [
        {
          request_index: 0,
          request_start: '2026-01-01T00:00:02.000Z',
          prompt_tokens: 100,
          cache_read_input_tokens: 20,
        },
      ],
    },
  },
};
// `uncached_step`: no prompt was ever reported, but the uncached portion was — the fallback arm.
const uncachedStep = {
  step_id: 'uncached_step',
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 10,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'h3',
  diagnostics: {
    input_token_estimate: 1,
    precondition_trace: [],
    cache: {
      state: 'partially_observed' as const,
      basis: 'provider_reported' as const,
      requests: [
        { request_index: 0, request_start: '2026-01-01T00:00:00.000Z', uncached_input_tokens: 60 },
      ],
    },
  },
};
// `tools_step`: declares tools (an empty `tool_calls`), no `cache` — `tool_calling_step`.
const toolsStep = {
  step_id: 'tools_step',
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 10,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'h4',
  tool_calls: [],
  diagnostics: { input_token_estimate: 1, precondition_trace: [] },
};
// `external_step`: no `cache`, no `tool_calls`, no definition — the `agent_profile` fallback.
const externalStep = {
  step_id: 'external_step',
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 10,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'h5',
  agent_profile: 'reviewer',
  diagnostics: { input_token_estimate: 1, precondition_trace: [] },
};
// `corrupt_step`: `cache` is an object, but `requests` is not an array — `cost_unreadable`.
const corruptStep = {
  step_id: 'corrupt_step',
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 10,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'h6',
  diagnostics: {
    input_token_estimate: 1,
    precondition_trace: [],
    cache: { state: 'unobservable', basis: 'unobservable', requests: 'not-an-array' },
  },
};

const contextOneRun = {
  id: 'run_ctx1',
  workflow_id: 'wf',
  workflow_version: 1,
  completed_steps: [],
  in_progress_steps: [],
  failed_steps: [],
  skipped_steps: [],
  run_phase: 'completed',
  version: 1,
  params: {},
  evidence: [moneyStepEarly, moneyStepLast, uncachedStep, toolsStep, externalStep, corruptStep],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:01.000Z',
  terminal_state: true,
} as unknown as RunRecord;

const STEP_LINE_COST_VIEW = {
  requests: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('totals across 2 requests'),
  },
  basis: { surface: 'rendered', probe: (out) => expect(out).toContain('provider-reported') },
  state: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain("unrecognized state 'foo_state'"),
  },
  prompt: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('700 prompt tokens (measured, request 2 of 2)'),
  },
  uncached_input: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain(
        '60 uncached input tokens (measured, first request; whole prompt not reported)',
      ),
  },
  cache_read: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('read 800'),
  },
  cache_write: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('wrote at least 88 (1 of 2 requests reported a write)'),
  },
  output: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain('at least 42 output tokens (1 of 2 requests reported output)'),
  },
} satisfies Record<keyof CostView, DisclosureRoute>;

const STEP_LINE_COST_FIGURE = {
  value: { surface: 'rendered', probe: (out) => expect(out).toContain('700 prompt tokens') },
  reported: {
    surface: 'rendered',
    // `1 of 2` — proves the FIGURE's own `reported` count, distinct from `of`.
    probe: (out) => expect(out).toContain('1 of 2 requests reported output'),
  },
  of: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('request 2 of 2'),
  },
  only_request_index: {
    surface: 'rendered',
    // idx === 1 renders "request 2 of 2" rather than "first request" — the field IS the index.
    probe: (out) => expect(out).toContain('request 2 of 2'),
  },
} satisfies Record<keyof CostFigure, DisclosureRoute>;

const STEP_LINE_ATTEMPT_VIEW = {
  attempt: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('(attempt 1/2)'),
  },
  status: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('(attempt 1/2)  error'),
  },
  cost: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('attempt 1/2: 700 prompt tokens'),
  },
  cost_unrecorded: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain('cost: not recorded — tool-calling steps do not record usage yet'),
  },
  cost_unreadable: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('cost: unreadable — the recorded usage is not a list'),
  },
} satisfies Record<keyof AttemptView, DisclosureRoute>;

const STEP_LINE_STEP_VIEW = {
  attempts: {
    surface: 'rendered',
    // The array itself: BOTH attempts of `money_step` render, not just one.
    probe: (out) => {
      expect(out).toContain('(attempt 1/2)');
      expect(out).toContain('(attempt 2/2)');
    },
  },
} satisfies Record<keyof StepView, DisclosureRoute>;

const STEP_LINE_UNRECORDED_CAUSE = {
  tool_calling_step: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain('cost: not recorded — tool-calling steps do not record usage yet'),
  },
  not_driven_by_realm: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain(
        'cost: not recorded — realm did not drive this step (an outside agent over MCP, an ' +
          'answer typed at a realm workflow run prompt, or a record written before usage was ' +
          'measured)',
      ),
  },
} satisfies Record<CostUnrecordedCause, DisclosureRoute>;

describe('#600 PR 1b (D4) — context 1, the step line', () => {
  it('every registry waives nothing', () => {
    const registries: Record<string, DisclosureRoute>[] = [
      STEP_LINE_COST_VIEW,
      STEP_LINE_COST_FIGURE,
      STEP_LINE_ATTEMPT_VIEW,
      STEP_LINE_STEP_VIEW,
      STEP_LINE_UNRECORDED_CAUSE,
    ];
    for (const registry of registries) {
      expect(Object.values(registry).filter((r) => r.surface === 'waived')).toEqual([]);
    }
  });

  it('runs every registry against the real rendered output', async () => {
    const out = await inspectRun('run_ctx1', makeStore(contextOneRun), workflowStore);
    for (const registry of [
      STEP_LINE_COST_VIEW,
      STEP_LINE_COST_FIGURE,
      STEP_LINE_ATTEMPT_VIEW,
      STEP_LINE_STEP_VIEW,
      STEP_LINE_UNRECORDED_CAUSE,
    ]) {
      for (const [field, route] of Object.entries(registry)) {
        if (route.surface === 'rendered') route.probe(out);
        else throw new Error(`unexpected waiver for '${field}'`);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// CONTEXT 2 — the failure block.
// ---------------------------------------------------------------------------------------------

const ENTRY_A = {
  at: '2026-01-01T00:04:00.000Z',
  step: 'classify',
  provider: 'anthropic',
  error_class: 'api_status' as const,
  message: 'rate limited by upstream',
  elapsed_ms: 1200,
  usage: [
    {
      request_index: 0,
      request_start: '2026-01-01T00:03:59.000Z',
      prompt_tokens: 900,
      output_tokens: 15,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 0,
    },
    { request_index: 1, request_start: '2026-01-01T00:03:59.500Z', output_tokens: 25 },
  ],
};
const ENTRY_B = {
  at: '2026-01-01T00:05:00.000Z',
  step: 'classify',
  provider: 'anthropic',
  error_class: 'other' as const,
  message: 'connection reset',
  elapsed_ms: 300,
  usage: [
    { request_index: 0, request_start: '2026-01-01T00:04:59.000Z', uncached_input_tokens: 60 },
  ],
};

const contextTwoRun = {
  id: 'run_ctx2',
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

const FAILURE_COST_VIEW = {
  requests: { surface: 'rendered', probe: (out) => expect(out).toContain('2 requests billed') },
  basis: {
    surface: 'waived',
    reason: "a drive failure's usage carries no classification",
  },
  state: {
    surface: 'waived',
    reason: "a drive failure's usage carries no classification",
  },
  prompt: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain('at least 900 prompt tokens (1 of 2 requests reported a prompt)'),
  },
  uncached_input: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('60 uncached input tokens (whole prompt not reported)'),
  },
  cache_read: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('read at least 400 (1 of 2 requests reported a read)'),
  },
  cache_write: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('wrote at least 0 (1 of 2 requests reported a write)'),
  },
  output: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('40 output tokens (totals across 2 requests)'),
  },
} satisfies Record<keyof CostView, DisclosureRoute>;

const FAILURE_COST_FIGURE = {
  value: { surface: 'rendered', probe: (out) => expect(out).toContain('900 prompt tokens') },
  reported: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('1 of 2 requests reported a prompt'),
  },
  of: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('1 of 2 requests reported a prompt'),
  },
  only_request_index: {
    surface: 'waived',
    reason:
      "the failure line always sums: it reports spend, so one request's figure is shown as a " +
      "floor of the sum, never as that request's size",
  },
} satisfies Record<keyof CostFigure, DisclosureRoute>;

describe('#600 PR 1b (D4) — context 2, the failure block', () => {
  it('the two registries waive exactly what the header says, nothing more', () => {
    const waivedView = Object.entries(FAILURE_COST_VIEW)
      .filter(([, r]) => r.surface === 'waived')
      .map(([f]) => f)
      .sort();
    expect(waivedView).toEqual(['basis', 'state']);
    const waivedFigure = Object.entries(FAILURE_COST_FIGURE)
      .filter(([, r]) => r.surface === 'waived')
      .map(([f]) => f)
      .sort();
    expect(waivedFigure).toEqual(['only_request_index']);
  });

  it('runs every field OWN probe against the real rendered output', async () => {
    const out = await inspectRun('run_ctx2', makeStore(contextTwoRun), workflowStore);
    for (const registry of [FAILURE_COST_VIEW, FAILURE_COST_FIGURE]) {
      for (const [field, route] of Object.entries(registry)) {
        if (route.surface === 'rendered') route.probe(out);
        else
          expect(
            (route as { reason: string }).reason.trim().length,
            `waiver for '${field}' has an empty reason`,
          ).toBeGreaterThan(0);
      }
    }
  });
});
