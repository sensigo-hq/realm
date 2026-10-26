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
// Issue #625 (the holder slice, PR-H) adds three more registries and two more rows — the claim's
// `ClaimRecord`, the name's `Attributed`, the answer's `AnswerView`, `AttemptView.driven_by` and
// `StepView.answers` — probed against the real `inspect` output, so a field added to any of them
// fails to COMPILE here until it is routed to a screen or waived with a reason.
//
// Issue #600 PR 2 adds four `CostView` rows (`models`, `cache_requested`, `cache_write_5m`,
// `cache_write_1h`) and the `CacheRequestedEntry` registry, rendered on both contexts with no waiver;
// the two lifetime splits are probed on a fixture where the written lifetime differs from the one
// asked, the only place their text appears. Issue #600's lifetime unit adds the entry's `auto` (the
// evidence `--prompt-cache auto` chose by), probed on the fixture listen's default asked for.
//
// Issue #600 caching PR P adds two `CostView` rows (`money`, `endpoints`), `StepView.total`, and the
// `Money` and `RunCost` registries, rendered with no waiver. Money exists only when a price source is
// given, so its rows probe a second render (`PRICED`) of a priced fixture through `inspectRun`'s
// `priceSource`; `endpoints` reads only as the nothing-cached clause's gateway reason, so its fixture
// asks for a lifetime on a custom endpoint and caches nothing.
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
  ClaimRecord,
  Attributed,
  AnswerView,
  CacheRequestedEntry,
  Money,
  PriceSource,
  RunCost,
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

// issue #600 caching PR P: a named fake — `gpt-*` from the list, every other model from the runner's
// file ('dated' for `claude-x*`, matched without its date suffix and the provider named). Exact
// binary fractions, so every sum and every floor prints its own figure.
const PRICES: PriceSource = {
  price(input) {
    if (input.model.startsWith('gpt-')) {
      return {
        priced: { total: 0.125, uncached_counterfactual: 0.125 },
        priced_by: {
          source_class: 'price_list',
          source_ref: '@pydantic/genai-prices',
          version: '0.1.12',
          matched_model: input.model,
          date_basis: 'current',
        },
      };
    }
    const dated = input.model.startsWith('claude-x');
    return {
      priced: { total: 0.25, uncached_counterfactual: 0.5 },
      priced_by: {
        source_class: 'economics',
        source_ref: '/srv/economics.yaml',
        matched_model: dated ? 'claude-x' : input.model,
        ...(dated ? { matched_provider: 'anthropic' } : {}),
        date_basis: dated ? 'dated' : 'current',
      },
    };
  },
};

// issue #600 caching PR P: the priced fixtures' requests. `GATEWAY` asked for 1 hour on a custom endpoint
// and nothing was written or read; `MIXED` holds one request per source and one with no model.
const GATEWAY_REQUEST = {
  request_index: 0,
  request_start: '2026-01-01T00:00:00.000Z',
  model: 'claude-x-20260101',
  provider: 'anthropic',
  endpoint: 'custom',
  cache_requested: 'lifetime',
  cache_lifetime_s: 3600,
  cache_ttl_sent: true,
  cache_requested_source: 'stated',
  cache_requested_by: 'realm agent',
  prompt_tokens: 5000,
  output_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const MIXED_REQUESTS = [
  {
    request_index: 0,
    request_start: '2026-01-01T00:00:00.000Z',
    model: 'claude-y-20260101',
    prompt_tokens: 100,
    output_tokens: 1,
  },
  {
    request_index: 1,
    request_start: '2026-01-01T00:00:00.100Z',
    model: 'gpt-5',
    prompt_tokens: 100,
    output_tokens: 1,
  },
  {
    request_index: 2,
    request_start: '2026-01-01T00:00:00.200Z',
    prompt_tokens: 100,
    output_tokens: 1,
  },
];

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
  // PR-H: the program whose code did this attempt — read by the one reader every stored name goes
  // through; `derived` renders as "from the OS user".
  driven_by: { by: 'prog@host', by_source: 'derived' as const, channel: 'agent' },
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

// PR-H: `gate_step` — the common gate step: ONE execution entry (the program that opened the
// question, named through REALM_OPERATOR) then ONE answer (a stated name, no claim_token passed).
const gateStepExecution = {
  step_id: 'gate_step',
  kind: 'execution' as const,
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 20,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'g1',
  driven_by: { by: 'asker@host', by_source: 'ambient' as const, channel: 'run' },
};
const gateStepAnswer = {
  step_id: 'gate_step',
  kind: 'gate_response' as const,
  status: 'success' as const,
  started_at: '2026-01-01T00:00:02.000Z',
  completed_at: '2026-01-01T00:00:02.000Z',
  duration_ms: 1,
  input_summary: { choice: 'approve' },
  output_summary: { choice: 'approve' },
  evidence_hash: 'g2',
  responded_by: 'alice',
  claim_proof: { proof: 'absent' as const },
};
// An answer written before the proof existed, naming nobody: both absence words print.
const oldGateExecution = {
  step_id: 'old_gate_step',
  kind: 'execution' as const,
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 20,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'g3',
};
const oldGateAnswer = {
  step_id: 'old_gate_step',
  kind: 'gate_response' as const,
  status: 'success' as const,
  started_at: '2026-01-01T00:00:02.000Z',
  completed_at: '2026-01-01T00:00:02.000Z',
  duration_ms: 1,
  input_summary: { choice: 'reject' },
  output_summary: { choice: 'reject' },
  evidence_hash: 'g4',
};

// issue #600 PR 2: three steps whose one request carries the request facts. `asked_1h_step` asked
// for 1 hour and its write was kept for 5 minutes; `asked_5m_step` asked for 5 minutes — by listen's
// default `auto`, whose gaps chose the short lifetime — and its write was kept for 1 hour: the two
// mismatch fixtures, where the splits' text appears. `asked_off_step` asked for nothing.
const askedStep = (stepId: string, request: Record<string, unknown>) => ({
  step_id: stepId,
  kind: 'execution' as const,
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 10,
  input_summary: {},
  output_summary: {},
  evidence_hash: `h-${stepId}`,
  diagnostics: {
    input_token_estimate: 1,
    precondition_trace: [],
    cache: {
      state: 'write_only' as const,
      basis: 'provider_reported' as const,
      requests: [{ request_index: 0, request_start: '2026-01-01T00:00:00.000Z', ...request }],
    },
  },
});
const asked1hStep = askedStep('asked_1h_step', {
  model: 'claude-x-20260101',
  cache_requested: 'lifetime',
  cache_lifetime_s: 3600,
  cache_ttl_sent: true,
  cache_requested_source: 'stated',
  cache_requested_by: 'realm agent',
  provider: 'anthropic',
  cache_creation_input_tokens: 70,
  cache_creation: { ephemeral_5m_input_tokens: 70 },
});
const asked5mStep = askedStep('asked_5m_step', {
  model: 'claude-y-20260101',
  cache_requested: 'lifetime',
  cache_lifetime_s: 300,
  cache_ttl_sent: false,
  cache_requested_source: 'runner_default',
  cache_requested_by: 'realm listen',
  cache_auto: { basis: 'listen_trigger_gaps', gaps_s: [10, 10, 10, 7200, 7200] },
  provider: 'anthropic',
  cache_creation_input_tokens: 30,
  cache_creation: { ephemeral_1h_input_tokens: 30 },
});
const askedOffStep = askedStep('asked_off_step', {
  cache_requested: 'off',
  cache_requested_source: 'stated',
  cache_requested_by: 'realm agent',
  provider: 'anthropic',
});

const contextOneRun = {
  id: 'run_ctx1',
  workflow_id: 'wf',
  workflow_version: 1,
  completed_steps: [],
  // PR-H: a step taken by a program that stated its own name — the claim line.
  in_progress_steps: ['claimed_step'],
  claims: {
    claimed_step: {
      deadline: null,
      token: 'claim-token-that-must-never-print',
      holder: { by: 'claimer@host', by_source: 'stated', channel: 'mcp-http' },
      since: '2026-01-01T00:00:00.000Z',
    },
  },
  failed_steps: [],
  skipped_steps: [],
  run_phase: 'completed',
  version: 1,
  params: {},
  evidence: [
    moneyStepEarly,
    moneyStepLast,
    uncachedStep,
    toolsStep,
    externalStep,
    corruptStep,
    gateStepExecution,
    gateStepAnswer,
    oldGateExecution,
    oldGateAnswer,
    asked1hStep,
    asked5mStep,
    askedOffStep,
  ],
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
  // issue #600 PR 2.
  models: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('| model claude-x-20260101 |'),
  },
  cache_requested: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain('request); asked for 1 hour (sent as 1 hour; stated on realm agent)'),
  },
  cache_write_5m: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain(
        '; 70 of the tokens written were kept for 5 minutes, not the 1 hour asked',
      ),
  },
  cache_write_1h: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain(
        '; 30 of the tokens written were kept for 1 hour, not the 5 minutes asked',
      ),
  },
  // issue #600 caching PR P: on the priced render.
  money: {
    surface: 'rendered',
    probe: () =>
      expect(PRICED.stepLine).toContain(
        "| $0.25 (your economics file; at the call's date; priced as anthropic's claude-x)",
      ),
  },
  endpoints: {
    surface: 'rendered',
    probe: () =>
      expect(PRICED.stepLine).toContain(
        "nothing was written or read: the cached part may be shorter than the model's minimum, " +
          'or the endpoint dropped the request to cache',
      ),
  },
} satisfies Record<keyof CostView, DisclosureRoute>;

// issue #600 PR 2: each field of one ask, on the step line.
const STEP_LINE_CACHE_REQUESTED_ENTRY = {
  value: {
    surface: 'rendered',
    // `off` reads as its own words; `lifetime` and `provider_rules` read otherwise.
    probe: (out) => expect(out).toContain('; asked for no caching (stated on realm agent)'),
  },
  lifetime_s: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('; asked for 5 minutes ('),
  },
  ttl_sent: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain("(the provider's default lifetime; realm listen's default; auto: "),
  },
  source: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain("; realm listen's default; auto: "),
  },
  by: { surface: 'rendered', probe: (out) => expect(out).toContain('stated on realm agent') },
  // issue #600 (the lifetime unit): the evidence `auto` chose by, inside the ask's parentheses.
  auto: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain(
        "; auto: the last 5 gaps between this workflow's triggers were about 10 seconds, 10 seconds, 10 seconds, 2 hours and 2 hours)",
      ),
  },
} satisfies Record<keyof CacheRequestedEntry, DisclosureRoute>;

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
  driven_by: {
    surface: 'rendered',
    // The PROGRAM, how its name is known (words, not the class token), the door.
    probe: (out) => expect(out).toContain('Taken by: prog@host (from the OS user, via agent)'),
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
  answers: {
    surface: 'rendered',
    // The common gate step has ONE execution entry then ONE answer — its answer used to be dropped.
    probe: (out) => expect(out).toContain('Answer: approve · answered by alice'),
  },
  // issue #600 caching PR P: the step's money across its attempts, in its header.
  total: {
    surface: 'rendered',
    probe: () =>
      expect(PRICED.stepLine).toContain(
        ' — ≥ $0.625 across 2 attempts (your economics file, genai-prices 0.1.12)',
      ),
  },
} satisfies Record<keyof StepView, DisclosureRoute>;

/** issue #600 caching PR P: the priced renders, filled by each context's runner before its probes. */
const PRICED = { stepLine: '', failureLine: '' };

// issue #600 caching PR P: a second run, rendered with `PRICES`. `gateway_step` is the gateway
// fixture; `mixed_step` has two attempts (the second with a request per source and one with no
// model); the three unmeasured attempts and a failed drive no longer on the record feed the run's
// `Cost:` line.
const pricedAttempt = (
  stepId: string,
  status: 'error' | 'success',
  state: 'engaged' | 'never_engaged',
  requests: readonly Record<string, unknown>[],
) => ({
  step_id: stepId,
  kind: 'execution' as const,
  status,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 10,
  input_summary: {},
  output_summary: {},
  evidence_hash: `p-${stepId}-${status}`,
  diagnostics: {
    input_token_estimate: 1,
    precondition_trace: [],
    cache: { state, basis: 'provider_reported' as const, requests },
  },
});
const pricedStepRun = {
  ...contextOneRun,
  id: 'run_ctx1p',
  in_progress_steps: [],
  claims: undefined,
  evidence: [
    pricedAttempt('gateway_step', 'success', 'never_engaged', [GATEWAY_REQUEST]),
    pricedAttempt('mixed_step', 'error', 'engaged', [MIXED_REQUESTS[0]!]),
    pricedAttempt('mixed_step', 'success', 'engaged', MIXED_REQUESTS),
    toolsStep,
    externalStep,
    corruptStep,
  ],
  drive_failures: {
    first_failed_at: '2026-01-01T00:04:00.000Z',
    total: 3,
    entries: [
      {
        at: '2026-01-01T00:04:00.000Z',
        step: 'mixed_step',
        provider: 'anthropic',
        error_class: 'other' as const,
        message: 'connection reset',
        elapsed_ms: 300,
        usage: [MIXED_REQUESTS[0]],
      },
      // A failed drive with no usage figures (a request that failed on the wire): it may have billed.
      {
        at: '2026-01-01T00:05:00.000Z',
        step: 'mixed_step',
        provider: 'anthropic',
        error_class: 'other' as const,
        message: 'connection reset',
        elapsed_ms: 300,
      },
    ],
  },
} as unknown as RunRecord;

const STEP_LINE_MONEY = {
  total: {
    surface: 'rendered',
    probe: () => expect(PRICED.stepLine).toContain('| $0.25 (your economics file; current price)'),
  },
  uncached_counterfactual: {
    surface: 'rendered',
    // Read through net: the counterfactual is what the saving is measured against.
    probe: () =>
      expect(PRICED.stepLine).toContain("priced as anthropic's claude-x); caching saved $0.25"),
  },
  net: {
    surface: 'rendered',
    probe: () =>
      expect(PRICED.stepLine).toContain(
        '(your economics file; current price); caching saved $0.25',
      ),
  },
  priced: {
    surface: 'rendered',
    probe: () => expect(PRICED.stepLine).toContain('; 2 of 3 requests priced;'),
  },
  of: { surface: 'rendered', probe: () => expect(PRICED.stepLine).toContain('2 of 3 requests') },
  dated: {
    surface: 'rendered',
    probe: () => expect(PRICED.stepLine).toContain("(your economics file; at the call's date;"),
  },
  sources: {
    surface: 'rendered',
    // What priced the request, when it differs from the recorded model.
    probe: () => expect(PRICED.stepLine).toContain("; priced as anthropic's claude-x)"),
  },
  source_totals: {
    surface: 'rendered',
    probe: () =>
      expect(PRICED.stepLine).toContain(
        '| ≥ $0.375 (prices from: your economics file (1), genai-prices 0.1.12 (1);',
      ),
  },
  not_priced: {
    surface: 'rendered',
    probe: () => expect(PRICED.stepLine).toContain('; 1 not priced: model not recorded)'),
  },
} satisfies Record<keyof Money, DisclosureRoute>;

const RUN_LINE_RUN_COST = {
  total: {
    surface: 'rendered',
    probe: () =>
      expect(PRICED.stepLine).toContain(
        'Cost: ≥ $1.12 (prices from: your economics file (4), genai-prices 0.1.12 (1); ' +
          "1 at the call's date, 4 current; 5 of 6 requests priced; 1 not priced: model not recorded;",
      ),
  },
  failed_drives_not_on_record: {
    surface: 'rendered',
    probe: () => expect(PRICED.stepLine).toContain('; 1 failed drive not on the record)'),
  },
  failed_drives_without_usage: {
    surface: 'rendered',
    probe: () => expect(PRICED.stepLine).toContain('; 1 failed drive without usage figures'),
  },
  unmeasured: {
    surface: 'rendered',
    probe: () =>
      expect(PRICED.stepLine).toContain(
        '; 1 tool-calling attempt not measured; 1 attempt with unreadable usage; ' +
          '1 attempt realm has no usage figures for;',
      ),
  },
} satisfies Record<keyof RunCost, DisclosureRoute>;

const STEP_LINE_UNRECORDED_CAUSE = {
  tool_calling_step: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain('cost: not recorded — tool-calling steps do not record usage yet'),
  },
  not_measured_by_realm: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain(
        'cost: not recorded — realm has no usage figures for this attempt (for example: an ' +
          'outside agent over MCP made it, a person typed its answer at a realm workflow run ' +
          'prompt, or realm 0.45.0 or earlier recorded it)',
      ),
  },
} satisfies Record<CostUnrecordedCause, DisclosureRoute>;

describe('#600 PR 1b (D4) — context 1, the step line', () => {
  it('every registry waives nothing', () => {
    const registries: Record<string, DisclosureRoute>[] = [
      STEP_LINE_COST_VIEW,
      STEP_LINE_CACHE_REQUESTED_ENTRY,
      STEP_LINE_COST_FIGURE,
      STEP_LINE_ATTEMPT_VIEW,
      STEP_LINE_STEP_VIEW,
      STEP_LINE_UNRECORDED_CAUSE,
      STEP_LINE_MONEY,
      RUN_LINE_RUN_COST,
    ];
    for (const registry of registries) {
      expect(Object.values(registry).filter((r) => r.surface === 'waived')).toEqual([]);
    }
  });

  it('runs every registry against the real rendered output', async () => {
    const out = await inspectRun('run_ctx1', makeStore(contextOneRun), workflowStore);
    PRICED.stepLine = await inspectRun('run_ctx1p', makeStore(pricedStepRun), workflowStore, {
      priceSource: PRICES,
    });
    for (const registry of [
      STEP_LINE_COST_VIEW,
      STEP_LINE_CACHE_REQUESTED_ENTRY,
      STEP_LINE_COST_FIGURE,
      STEP_LINE_ATTEMPT_VIEW,
      STEP_LINE_STEP_VIEW,
      STEP_LINE_UNRECORDED_CAUSE,
      STEP_LINE_MONEY,
      RUN_LINE_RUN_COST,
    ]) {
      for (const [field, route] of Object.entries(registry)) {
        if (route.surface === 'rendered') route.probe(out);
        else throw new Error(`unexpected waiver for '${field}'`);
      }
    }
  });

  // issue #600 PR 2 (A5, G26): a fact with no readable value is carried as data by get_run_state
  // (the mcp twin's cell) and WITHHELD here — the `driven_by` precedent: an absence word on every
  // older step would be a line of noise. (a) red when inspect prints the cause; (b) prints the two
  // step lines.
  it("guard: the request facts' absence by cause is WITHHELD on this surface", async () => {
    const run = {
      ...contextOneRun,
      evidence: [
        // Written by 0.47.0: no provider, so the cause is predates_request_facts.
        askedStep('old_step', { prompt_tokens: 5 }),
        // Driven by realm, the model refused at read: none_readable.
        askedStep('refused_step', { prompt_tokens: 5, provider: 'anthropic', model: 'x\u001by' }),
      ],
    } as unknown as RunRecord;
    const out = await inspectRun('run_ctx1', makeStore(run), workflowStore);
    const lines = out.split('\n').filter((l) => l.includes('Diagnostics: '));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/\| cache: [^;|]*\)$/);
      expect(line).not.toMatch(/predates|none_readable|model|asked/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// CONTEXT 1b — the holder slice (issue #625, PR-H): the claim line, the program's name, the answer.
// ---------------------------------------------------------------------------------------------

const CLAIM_LINE = 'claimed_step: taken by claimer@host (as stated, via mcp-http)';

const HOLDER_CLAIM_RECORD = {
  deadline: {
    surface: 'waived',
    reason:
      'not a holder-slice field and not printed on the claim line: a stale or unknown-age claim ' +
      'reaches an operator as a run-health finding (stale_claim / claim_unknown_age) computed from it',
  },
  token: {
    surface: 'waived',
    reason:
      "the claim's token leaves the engine on the opening reply only (CLAIM_TOKEN_ONE_DOOR) — " +
      'inspect, list and get_run_state never print it',
  },
  holder: { surface: 'rendered', probe: (out) => expect(out).toContain(CLAIM_LINE) },
  since: {
    surface: 'rendered',
    // How long ago — the age is the claim's own `since`, never a guess.
    probe: (out) =>
      expect(out).toMatch(/claimed_step: taken by claimer@host \([^)]*\), \d+[dhm][^\n]* ago/),
  },
} satisfies Record<keyof ClaimRecord, DisclosureRoute>;

const HOLDER_ATTRIBUTED = {
  by: { surface: 'rendered', probe: (out) => expect(out).toContain('taken by claimer@host') },
  by_source: { surface: 'rendered', probe: (out) => expect(out).toContain('(as stated, via') },
  channel: { surface: 'rendered', probe: (out) => expect(out).toContain('via mcp-http)') },
} satisfies Record<keyof Attributed, DisclosureRoute>;

const HOLDER_ANSWER_VIEW = {
  choice: { surface: 'rendered', probe: (out) => expect(out).toContain('Answer: approve ·') },
  answered_by: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('answered by alice (as stated)'),
  },
  claim_proof: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain(
        "no claim token passed (a token is passed only by Realm's MCP answer tool, from the " +
          'conversation that opened the question, or by a program that calls the library with it)',
      ),
  },
  claim_proof_absent: {
    surface: 'rendered',
    // `proof_not_recorded` — an answer with neither a verdict nor an expiry.
    probe: (out) =>
      expect(out).toContain(
        'Answer: reject · answered by (not stated) · how it arrived was not recorded · no claim token recorded',
      ),
  },
} satisfies Record<keyof AnswerView, DisclosureRoute>;

describe('#625 PR-H — context 1b, the holder slice', () => {
  it('only the two waivers the header names: the deadline (not printed) and the token (one door)', () => {
    for (const registry of [HOLDER_CLAIM_RECORD, HOLDER_ATTRIBUTED, HOLDER_ANSWER_VIEW]) {
      for (const [field, route] of Object.entries(registry as Record<string, DisclosureRoute>)) {
        if (route.surface === 'waived') {
          expect(
            route.reason.trim().length,
            `waiver for '${field}' has an empty reason`,
          ).toBeGreaterThan(0);
        }
      }
    }
    const waived = Object.entries(HOLDER_CLAIM_RECORD)
      .filter(([, r]) => r.surface === 'waived')
      .map(([f]) => f)
      .sort();
    expect(waived).toEqual(['deadline', 'token']);
    expect(
      [HOLDER_ATTRIBUTED, HOLDER_ANSWER_VIEW].flatMap((r) =>
        Object.values(r as Record<string, DisclosureRoute>).filter((x) => x.surface === 'waived'),
      ),
    ).toEqual([]);
  });

  it('runs every registry against the real rendered output', async () => {
    const out = await inspectRun('run_ctx1', makeStore(contextOneRun), workflowStore);
    for (const registry of [HOLDER_CLAIM_RECORD, HOLDER_ATTRIBUTED, HOLDER_ANSWER_VIEW]) {
      for (const route of Object.values(registry as Record<string, DisclosureRoute>)) {
        if (route.surface === 'rendered') route.probe(out);
      }
    }
  });

  it('the claim token is withheld (one door) — no byte of it prints', async () => {
    const out = await inspectRun('run_ctx1', makeStore(contextOneRun), workflowStore);
    // (a) red when a render starts printing the claim's token; (b) prints the fixture's token.
    expect(out).not.toContain('claim-token-that-must-never-print');
  });

  it('the three classes read as WORDS, never as the class token', async () => {
    const out = await inspectRun('run_ctx1', makeStore(contextOneRun), workflowStore);
    expect(out).toContain('Taken by: prog@host (from the OS user, via agent)'); // derived
    expect(out).toContain('Question opened through: asker@host (from REALM_OPERATOR, via run)'); // ambient
    expect(out).toContain(CLAIM_LINE); // stated
    expect(out).not.toMatch(/\b(derived|ambient)\b/);
  });

  it("a gate step's attempt line says the question was OPENED through the program; every other step says TAKEN by", async () => {
    const out = await inspectRun('run_ctx1', makeStore(contextOneRun), workflowStore);
    // The gate step has an answer, so its verb is the design's other one; money_step is a control.
    expect(out).toContain('Question opened through: asker@host');
    expect(out).not.toContain('Taken by: asker@host');
    expect(out).not.toContain('Question opened through: prog@host');
  });

  it("an attempt's absence word is WITHHELD on this surface (the MCP carriers keep it as data)", async () => {
    const out = await inspectRun('run_ctx1', makeStore(contextOneRun), workflowStore);
    // `old_gate_step` and several money-step siblings carry no `driven_by`: their absence word
    // would be a line of noise under every attempt.
    expect(out).not.toContain('no program name was recorded on this step');
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
    {
      request_index: 0,
      request_start: '2026-01-01T00:04:59.000Z',
      uncached_input_tokens: 60,
      // issue #600 PR 2: the request facts; asked for 1 hour, the write kept for 5 minutes (a
      // mismatch).
      model: 'claude-x-20260101',
      cache_requested: 'lifetime',
      cache_lifetime_s: 3600,
      cache_ttl_sent: true,
      cache_requested_source: 'stated',
      cache_requested_by: 'realm agent',
      provider: 'anthropic',
      cache_creation: { ephemeral_5m_input_tokens: 70 },
    },
  ],
};
// issue #600 PR 2: asked for 5 minutes by listen's default `auto` (its gaps chose the short
// lifetime), the write kept for 1 hour (the other mismatch).
const ENTRY_C = {
  at: '2026-01-01T00:06:00.000Z',
  step: 'classify',
  provider: 'anthropic',
  error_class: 'other' as const,
  message: 'connection reset',
  elapsed_ms: 300,
  usage: [
    {
      request_index: 0,
      request_start: '2026-01-01T00:05:59.000Z',
      prompt_tokens: 12,
      model: 'claude-y-20260101',
      cache_requested: 'lifetime',
      cache_lifetime_s: 300,
      cache_ttl_sent: false,
      cache_requested_source: 'runner_default',
      cache_requested_by: 'realm listen',
      cache_auto: { basis: 'listen_trigger_gaps', gaps_s: [10, 10, 10, 7200, 7200] },
      provider: 'anthropic',
      cache_creation: { ephemeral_1h_input_tokens: 30 },
    },
    {
      request_index: 1,
      request_start: '2026-01-01T00:05:59.500Z',
      cache_requested: 'off',
      cache_requested_source: 'stated',
      cache_requested_by: 'realm agent',
      provider: 'anthropic',
    },
  ],
};
// The second entry of ENTRY_C asks for no caching, so ENTRY_C has two asks and no mismatch clause;
// ENTRY_D asks once, the mismatch fixture for the 1h split.
const ENTRY_D = { ...ENTRY_C, at: '2026-01-01T00:07:00.000Z', usage: [ENTRY_C.usage[0]] };

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
  drive_failures: {
    first_failed_at: ENTRY_A.at,
    total: 4,
    entries: [ENTRY_A, ENTRY_B, ENTRY_C, ENTRY_D],
  },
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
  // issue #600 PR 2.
  models: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('cache not reported; model claude-x-20260101; asked'),
  },
  cache_requested: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain(
        '; model claude-x-20260101; asked for 1 hour (sent as 1 hour; stated on realm agent)',
      ),
  },
  cache_write_5m: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain(
        '; 70 of the tokens written were kept for 5 minutes, not the 1 hour asked',
      ),
  },
  cache_write_1h: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain(
        '; 30 of the tokens written were kept for 1 hour, not the 5 minutes asked',
      ),
  },
  // issue #600 caching PR P: on the priced render.
  money: {
    surface: 'rendered',
    probe: () =>
      expect(PRICED.failureLine).toContain(
        "| $0.25 (your economics file; at the call's date; priced as anthropic's claude-x)",
      ),
  },
  endpoints: {
    surface: 'rendered',
    probe: () =>
      expect(PRICED.failureLine).toContain(
        "nothing was written or read: the cached part may be shorter than the model's minimum, " +
          'or the endpoint dropped the request to cache',
      ),
  },
} satisfies Record<keyof CostView, DisclosureRoute>;

// issue #600 caching PR P: three failed drives, rendered with `PRICES` — the gateway fixture, the
// mixed requests, and one request from the runner's file at its current price.
const pricedFailureRun = {
  ...contextTwoRun,
  id: 'run_ctx2p',
  drive_failures: {
    first_failed_at: ENTRY_A.at,
    total: 3,
    entries: [
      { ...ENTRY_A, usage: [GATEWAY_REQUEST] },
      { ...ENTRY_B, usage: MIXED_REQUESTS },
      { ...ENTRY_C, usage: [MIXED_REQUESTS[0]] },
    ],
  },
} as unknown as RunRecord;

const FAILURE_MONEY = {
  total: {
    surface: 'rendered',
    probe: () =>
      expect(PRICED.failureLine).toContain('| $0.25 (your economics file; current price)'),
  },
  uncached_counterfactual: {
    surface: 'rendered',
    probe: () =>
      expect(PRICED.failureLine).toContain("priced as anthropic's claude-x); caching saved $0.25"),
  },
  net: {
    surface: 'rendered',
    probe: () =>
      expect(PRICED.failureLine).toContain(
        '(your economics file; current price); caching saved $0.25',
      ),
  },
  priced: {
    surface: 'rendered',
    probe: () => expect(PRICED.failureLine).toContain('; 2 of 3 requests priced;'),
  },
  of: { surface: 'rendered', probe: () => expect(PRICED.failureLine).toContain('2 of 3 requests') },
  dated: {
    surface: 'rendered',
    probe: () => expect(PRICED.failureLine).toContain("(your economics file; at the call's date;"),
  },
  sources: {
    surface: 'rendered',
    probe: () => expect(PRICED.failureLine).toContain("; priced as anthropic's claude-x)"),
  },
  source_totals: {
    surface: 'rendered',
    probe: () =>
      expect(PRICED.failureLine).toContain(
        '| ≥ $0.375 (prices from: your economics file (1), genai-prices 0.1.12 (1);',
      ),
  },
  not_priced: {
    surface: 'rendered',
    probe: () => expect(PRICED.failureLine).toContain('; 1 not priced: model not recorded)'),
  },
} satisfies Record<keyof Money, DisclosureRoute>;

// issue #600 PR 2: each field of one ask, on the failure line.
const FAILURE_CACHE_REQUESTED_ENTRY = {
  value: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain(', then asked for no caching (stated on realm agent)'),
  },
  lifetime_s: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('; asked for 5 minutes ('),
  },
  ttl_sent: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain("(the provider's default lifetime; realm listen's default; auto: "),
  },
  source: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain("; realm listen's default; auto: "),
  },
  by: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('(sent as 1 hour; stated on realm agent)'),
  },
  // issue #600 (the lifetime unit): the evidence `auto` chose by, inside the ask's parentheses.
  auto: {
    surface: 'rendered',
    probe: (out) =>
      expect(out).toContain(
        "; auto: the last 5 gaps between this workflow's triggers were about 10 seconds, 10 seconds, 10 seconds, 2 hours and 2 hours)",
      ),
  },
} satisfies Record<keyof CacheRequestedEntry, DisclosureRoute>;

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
    expect(
      [FAILURE_CACHE_REQUESTED_ENTRY, FAILURE_MONEY].flatMap((r) =>
        Object.values(r as Record<string, DisclosureRoute>).filter((x) => x.surface === 'waived'),
      ),
    ).toEqual([]);
  });

  it('runs every field OWN probe against the real rendered output', async () => {
    const out = await inspectRun('run_ctx2', makeStore(contextTwoRun), workflowStore);
    PRICED.failureLine = await inspectRun('run_ctx2p', makeStore(pricedFailureRun), workflowStore, {
      priceSource: PRICES,
    });
    for (const registry of [
      FAILURE_COST_VIEW,
      FAILURE_CACHE_REQUESTED_ENTRY,
      FAILURE_COST_FIGURE,
      FAILURE_MONEY,
    ]) {
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
