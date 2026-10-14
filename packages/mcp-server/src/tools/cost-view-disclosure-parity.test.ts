// cost-view-disclosure-parity.test.ts — the get_run_state half of issue #600 PR 1b (D4). The
// sibling of the CLI guard, same trigger: add a field to `CostView`/`CostFigure`/`AttemptView`/
// `StepView`/`CostUnrecordedCause` and BOTH surface packages stop compiling until someone routes
// it. This surface carries the composed view as DATA (`include_steps: true`), so every probe reads
// the field off the JSON-round-tripped response rather than out of prose — one probe per row,
// never one shared deep-equal probe (which every row would satisfy identically and nothing would
// notice a dropped field).
//
// Issue #625 (the holder slice, PR-H) adds the claim's `ClaimRecord`, the name's `Attributed`, the
// answer's `AnswerView`, `AttemptView.driven_by` and `StepView.answers`: `step_claims` and
// `steps[].answers` carry them as data, and a field added to any of them stops BOTH surface
// packages compiling until it is routed or waived with a reason.
//
// Issue #600 PR 2 adds four `CostView` rows (`models`, `cache_requested`, `cache_write_5m`,
// `cache_write_1h`) and the `CacheRequestedEntry` registry on both contexts, with no waiver, and one
// cell for the typed absence by cause, which this surface carries as data (inspect withholds it).
//
// Issue #600 caching PR P adds two `CostView` rows (`money`, `endpoints`), `StepView.total`, and the
// `Money` and `RunCost` registries, as data with no waiver. Money exists only when a price source is
// given, so those rows read a second response over a priced fixture (`pricedSummary`, the named
// fake `PRICES`, the CLI twin's figures).
//
// Waivers are allowed only for `basis`/`state` on context 4 (`drive_failure_costs`) — a drive
// failure's usage carries no classification, `composeDriveFailureCosts` never sets either. Every
// other row here renders; `only_request_index` is NOT waived on this context (unlike the CLI's
// context 2) — the failure line always sums so the field has no place there, but a machine
// consumer of `drive_failure_costs` gets the raw figure and can decide for itself.
import { declared } from '../test-support/declared.js';
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
  ClaimRecord,
  Attributed,
  AnswerView,
  CacheRequestedEntry,
  Money,
  PriceSource,
  RunCost,
  WorkflowDefinition,
  JsonWorkflowStore,
} from '@sensigo/realm';
import { handleGetRunState, type RunStateSummary } from './get-run-state.js';

type DisclosureRoute =
  { surface: 'rendered'; probe: () => void } | { surface: 'waived'; reason: string };

function makeStore(run: RunRecord): RunStore {
  return declared({
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
  } as unknown as RunStore);
}

// ---------------------------------------------------------------------------------------------
// CONTEXT 3 — `steps`.
// ---------------------------------------------------------------------------------------------

// issue #600 caching PR P: a named fake — `gpt-*` from the list, every other model from the runner's
// file ('dated' for `claude-x*`, matched without its date suffix and the provider named).
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
// The gateway fixture (asked for 1h on a custom endpoint, nothing written or read), and one request
// per source plus one with no model.
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
const pricedAttempt = (
  stepId: string,
  status: 'error' | 'success',
  requests: readonly Record<string, unknown>[],
) => ({
  step_id: stepId,
  kind: 'execution' as const,
  status,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 1,
  input_summary: {},
  output_summary: {},
  evidence_hash: `p-${stepId}-${status}`,
  diagnostics: {
    input_token_estimate: 1,
    precondition_trace: [],
    cache: { state: 'engaged' as const, basis: 'provider_reported' as const, requests },
  },
});
const pricedDefinition = {
  id: 'wf',
  name: 'wf',
  version: 1,
  steps: {
    gateway_step: { description: 'x', execution: 'auto' },
    mixed_step: { description: 'x', execution: 'auto' },
  },
} as unknown as WorkflowDefinition;

/**
 * The priced response: the steps and drive failures of the CLI twin's priced fixtures, three
 * unmeasured attempts, and a failed drive no longer on the record, read with `PRICES`.
 */
async function pricedSummary(): Promise<RunStateSummary> {
  const run = {
    ...contextThreeRun,
    id: 'r3p',
    evidence: [
      pricedAttempt('gateway_step', 'success', [GATEWAY_REQUEST]),
      pricedAttempt('mixed_step', 'error', [MIXED_REQUESTS[0]!]),
      pricedAttempt('mixed_step', 'success', MIXED_REQUESTS),
      toolsStep,
      externalStep,
      corruptStep,
    ],
    drive_failures: {
      first_failed_at: '2026-01-01T00:04:00.000Z',
      total: 4,
      entries: [GATEWAY_REQUEST, MIXED_REQUESTS, [MIXED_REQUESTS[0]]].map((usage, i) => ({
        at: `2026-01-01T00:0${4 + i}:00.000Z`,
        step: 'mixed_step',
        provider: 'anthropic',
        error_class: 'other',
        message: 'connection reset',
        elapsed_ms: 1,
        usage: Array.isArray(usage) ? usage : [usage],
      })),
    },
  } as unknown as RunRecord;
  const workflowStore = declared({
    register: async () => {},
    list: async () => [pricedDefinition],
    get: async () => pricedDefinition,
  } as unknown as JsonWorkflowStore);
  return handleGetRunState(
    { run_id: 'r3p', include_steps: true },
    { runStore: makeStore(run), workflowStore, priceSourceProvider: async () => PRICES },
  );
}

const moneyStepEarly = {
  step_id: 'money_step',
  kind: 'execution' as const,
  status: 'error' as const,
  // PR-H: the program whose code did this attempt.
  driven_by: { by: 'prog@host', by_source: 'derived' as const, channel: 'agent' },
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

// PR-H: the common gate step — ONE execution entry, then ONE answer (a stated name, no token).
const gateStepExecution = {
  step_id: 'gate_step',
  kind: 'execution' as const,
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 1,
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
// An answer written before the proof existed, naming nobody.
const oldGateExecution = {
  step_id: 'old_gate_step',
  kind: 'execution' as const,
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 1,
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

// issue #600 PR 2: one request carrying every request fact, asked for 1h with part of the write
// kept for 5m (the mismatch fixture, where both splits are non-zero).
const askedStep = {
  step_id: 'asked_step',
  kind: 'execution' as const,
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 1,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'h-asked',
  diagnostics: {
    input_token_estimate: 1,
    precondition_trace: [],
    cache: {
      state: 'write_only' as const,
      basis: 'provider_reported' as const,
      requests: [
        {
          request_index: 0,
          request_start: 't0',
          model: 'claude-x-20260101',
          cache_requested: 'lifetime',
          cache_lifetime_s: 3600,
          cache_ttl_sent: true,
          cache_requested_source: 'stated',
          cache_requested_by: 'realm agent',
          provider: 'anthropic',
          cache_creation_input_tokens: 75,
          cache_creation: { ephemeral_5m_input_tokens: 70, ephemeral_1h_input_tokens: 5 },
        },
      ],
    },
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
  evidence: [
    moneyStepEarly,
    moneyStepLast,
    toolsStep,
    externalStep,
    corruptStep,
    gateStepExecution,
    gateStepAnswer,
    oldGateExecution,
    oldGateAnswer,
    askedStep,
  ],
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
    const asked = summary.steps!['asked_step']!.attempts[0]!.cost!;
    // issue #600 caching PR P: the priced response.
    const priced = await pricedSummary();
    const gateway = priced.steps!['gateway_step']!.attempts[0]!.cost!;
    const mixed = priced.steps!['mixed_step']!;
    const mixedMoney = mixed.attempts[1]!.cost!.money!;

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
      // issue #600 PR 2.
      models: {
        surface: 'rendered',
        probe: () =>
          expect(asked.models).toEqual({ names: ['claude-x-20260101'], reported: 1, of: 1 }),
      },
      cache_requested: {
        surface: 'rendered',
        probe: () =>
          expect(asked.cache_requested).toEqual({
            entries: [
              {
                value: 'lifetime',
                lifetime_s: 3600,
                ttl_sent: true,
                source: 'stated',
                by: 'realm agent',
              },
            ],
            reported: 1,
            of: 1,
          }),
      },
      cache_write_5m: {
        surface: 'rendered',
        probe: () =>
          expect(asked.cache_write_5m).toEqual({
            value: 70,
            reported: 1,
            of: 1,
            only_request_index: 0,
          }),
      },
      cache_write_1h: {
        surface: 'rendered',
        probe: () =>
          expect(asked.cache_write_1h).toEqual({
            value: 5,
            reported: 1,
            of: 1,
            only_request_index: 0,
          }),
      },
      // issue #600 caching PR P.
      money: {
        surface: 'rendered',
        probe: () =>
          expect(gateway.money).toEqual({
            total: 0.25,
            uncached_counterfactual: 0.5,
            net: 0.25,
            priced: 1,
            of: 1,
            dated: 1,
            sources: [
              {
                source_class: 'economics',
                source_ref: '/srv/economics.yaml',
                matched_provider: 'anthropic',
                matched_model: 'claude-x',
                count: 1,
                dated: 1,
              },
            ],
            source_totals: [
              { source_class: 'economics', source_ref: '/srv/economics.yaml', count: 1, dated: 1 },
            ],
          }),
      },
      endpoints: {
        surface: 'rendered',
        // Both arms: a custom endpoint counted, and a record from before the request facts.
        probe: () =>
          expect([gateway.endpoints, last.endpoints]).toEqual([
            { custom: 1, of: 1 },
            { absent_cause: 'predates_request_facts' },
          ]),
      },
    } satisfies Record<keyof CostView, DisclosureRoute>;

    // issue #600 caching PR P: each field of one money figure, as data (unrounded).
    const MONEY = {
      total: { surface: 'rendered', probe: () => expect(mixedMoney.total).toBe(0.375) },
      uncached_counterfactual: {
        surface: 'rendered',
        probe: () => expect(mixedMoney.uncached_counterfactual).toBe(0.625),
      },
      net: { surface: 'rendered', probe: () => expect(mixedMoney.net).toBe(0.25) },
      priced: { surface: 'rendered', probe: () => expect(mixedMoney.priced).toBe(2) },
      of: { surface: 'rendered', probe: () => expect(mixedMoney.of).toBe(3) },
      dated: {
        surface: 'rendered',
        probe: () => expect([gateway.money!.dated, mixedMoney.dated]).toEqual([1, 0]),
      },
      sources: {
        surface: 'rendered',
        probe: () =>
          expect(mixedMoney.sources.map((x) => [x.source_class, x.matched_model, x.count])).toEqual(
            [
              ['economics', 'claude-y-20260101', 1],
              ['price_list', 'gpt-5', 1],
            ],
          ),
      },
      source_totals: {
        surface: 'rendered',
        probe: () =>
          expect(mixedMoney.source_totals).toEqual([
            { source_class: 'economics', source_ref: '/srv/economics.yaml', count: 1, dated: 0 },
            {
              source_class: 'price_list',
              source_ref: '@pydantic/genai-prices',
              version: '0.1.12',
              count: 1,
              dated: 0,
            },
          ]),
      },
      not_priced: {
        surface: 'rendered',
        probe: () =>
          expect(mixedMoney.not_priced).toEqual([{ cause: 'model_not_recorded', count: 1 }]),
      },
    } satisfies Record<keyof Money, DisclosureRoute>;

    // issue #600 caching PR P: the run's cost, as data.
    const RUN_COST = {
      total: {
        surface: 'rendered',
        probe: () =>
          expect([
            priced.run_cost!.total.total,
            priced.run_cost!.total.priced,
            priced.run_cost!.total.of,
          ]).toEqual([1.75, 8, 10]),
      },
      failed_drives_not_on_record: {
        surface: 'rendered',
        probe: () => expect(priced.run_cost!.failed_drives_not_on_record).toBe(1),
      },
      unmeasured: {
        surface: 'rendered',
        probe: () =>
          expect(priced.run_cost!.unmeasured).toEqual({
            tool_calling_step: 1,
            not_measured_by_realm: 1,
            cost_unreadable: 1,
          }),
      },
    } satisfies Record<keyof RunCost, DisclosureRoute>;

    // issue #600 PR 2: each field of one ask, as data.
    const entry = (asked.cache_requested as { entries: CacheRequestedEntry[] }).entries[0]!;
    const CACHE_REQUESTED_ENTRY = {
      value: { surface: 'rendered', probe: () => expect(entry.value).toBe('lifetime') },
      lifetime_s: { surface: 'rendered', probe: () => expect(entry.lifetime_s).toBe(3600) },
      ttl_sent: { surface: 'rendered', probe: () => expect(entry.ttl_sent).toBe(true) },
      source: { surface: 'rendered', probe: () => expect(entry.source).toBe('stated') },
      by: { surface: 'rendered', probe: () => expect(entry.by).toBe('realm agent') },
    } satisfies Record<keyof CacheRequestedEntry, DisclosureRoute>;

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
      driven_by: {
        surface: 'rendered',
        // Data, so the CLASS stays a token here (the screen words it).
        probe: () =>
          expect(money.attempts[0]!.driven_by).toEqual({
            by: 'prog@host',
            by_source: 'derived',
            channel: 'agent',
          }),
      },
    } satisfies Record<keyof AttemptView, DisclosureRoute>;

    const STEP_VIEW = {
      attempts: { surface: 'rendered', probe: () => expect(money.attempts).toHaveLength(2) },
      answers: {
        surface: 'rendered',
        probe: () =>
          expect(summary.steps!['gate_step']!.answers).toEqual([
            {
              choice: 'approve',
              answered_by: { by: 'alice', by_source: 'stated' },
              claim_proof: { proof: 'absent' },
            },
          ]),
      },
      // issue #600 caching PR P: the step's money across its attempts.
      total: {
        surface: 'rendered',
        probe: () =>
          expect([mixed.total?.total, mixed.total?.priced, mixed.total?.of]).toEqual([0.625, 3, 4]),
      },
    } satisfies Record<keyof StepView, DisclosureRoute>;

    const UNRECORDED_CAUSE = {
      tool_calling_step: {
        surface: 'rendered',
        probe: () =>
          expect(summary.steps!['tools_step']!.attempts[0]!.cost_unrecorded).toBe(
            'tool_calling_step',
          ),
      },
      not_measured_by_realm: {
        surface: 'rendered',
        probe: () =>
          expect(summary.steps!['external_step']!.attempts[0]!.cost_unrecorded).toBe(
            'not_measured_by_realm',
          ),
      },
    } satisfies Record<CostUnrecordedCause, DisclosureRoute>;

    for (const registry of [
      COST_VIEW,
      CACHE_REQUESTED_ENTRY,
      COST_FIGURE,
      ATTEMPT_VIEW,
      STEP_VIEW,
      UNRECORDED_CAUSE,
      MONEY,
      RUN_COST,
    ]) {
      for (const [field, route] of Object.entries(registry)) {
        if (route.surface === 'rendered') route.probe();
        else throw new Error(`unexpected waiver for '${field}'`);
      }
    }
  });

  // issue #600 PR 2 (A5, G26): a fact with no readable value is carried as DATA, by cause: a request
  // realm drove (it carries `provider`) whose model was refused at read is `none_readable`; a request
  // written before PR 2 is `predates_request_facts`. (a) red when the two causes are swapped, or the
  // absence is not carried; (b) prints the two `models`.
  it('carries the typed absence by cause (inspect withholds it)', async () => {
    const summary = await handleGetRunState(
      { run_id: 'r3', include_steps: true },
      { runStore: makeStore(contextThreeRun) },
    );
    const refused = {
      ...askedStep,
      step_id: 'refused_step',
      diagnostics: {
        ...askedStep.diagnostics,
        cache: {
          ...askedStep.diagnostics.cache,
          requests: [
            { request_index: 0, request_start: 't0', provider: 'anthropic', model: 'x\u001by' },
          ],
        },
      },
    };
    const withRefused = await handleGetRunState(
      { run_id: 'r3', include_steps: true },
      { runStore: makeStore({ ...contextThreeRun, evidence: [refused] } as unknown as RunRecord) },
    );
    expect({
      old: summary.steps!['money_step']!.attempts[1]!.cost!.models,
      refused: withRefused.steps!['refused_step']!.attempts[0]!.cost!.models,
    }).toEqual({
      old: { absent_cause: 'predates_request_facts' },
      refused: { absent_cause: 'none_readable' },
    });
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
// CONTEXT 3b — the holder slice (issue #625, PR-H): `step_claims` and `steps[].answers`.
// ---------------------------------------------------------------------------------------------

// A LIVE run: `step_claims` is withheld on a sealed one (the R3 terminal guard).
const contextHolderRun = {
  ...contextThreeRun,
  id: 'r3b',
  run_phase: 'running',
  terminal_state: false,
  in_progress_steps: ['claimed_step'],
  claims: {
    claimed_step: {
      deadline: null,
      token: 'claim-token-that-must-never-leave',
      holder: { by: 'claimer@host', by_source: 'stated', channel: 'mcp-http' },
      since: '2026-01-01T00:00:00.000Z',
    },
  },
} as unknown as RunRecord;

describe('#625 PR-H — context 3b, get_run_state.step_claims and the answer', () => {
  it('runs every registry against the real JSON-round-tripped response', async () => {
    const summary = await handleGetRunState(
      { run_id: 'r3b', include_steps: true },
      { runStore: makeStore(contextHolderRun) },
    );
    const claim = summary.step_claims![0]!;
    const answer = summary.steps!['gate_step']!.answers![0]!;
    const oldAnswer = summary.steps!['old_gate_step']!.answers![0]!;

    const CLAIM_RECORD = {
      deadline: {
        surface: 'waived',
        reason:
          'not a holder-slice field: a stale or unknown-age claim reaches a runner as stuck_claims ' +
          '(its state), never as the deadline itself',
      },
      token: {
        surface: 'waived',
        reason:
          "the claim's token leaves the engine on the opening reply only (CLAIM_TOKEN_ONE_DOOR) — " +
          'get_run_state never carries it',
      },
      holder: {
        surface: 'rendered',
        probe: () =>
          expect(claim.holder).toEqual({
            by: 'claimer@host',
            by_source: 'stated',
            channel: 'mcp-http',
          }),
      },
      since: {
        surface: 'rendered',
        probe: () => expect(claim.since).toBe('2026-01-01T00:00:00.000Z'),
      },
    } satisfies Record<keyof ClaimRecord, DisclosureRoute>;

    const ATTRIBUTED = {
      by: {
        surface: 'rendered',
        probe: () => expect((claim.holder as Attributed).by).toBe('claimer@host'),
      },
      by_source: {
        surface: 'rendered',
        probe: () => expect((claim.holder as Attributed).by_source).toBe('stated'),
      },
      channel: {
        surface: 'rendered',
        probe: () => expect((claim.holder as Attributed).channel).toBe('mcp-http'),
      },
    } satisfies Record<keyof Attributed, DisclosureRoute>;

    const ANSWER_VIEW = {
      choice: { surface: 'rendered', probe: () => expect(answer.choice).toBe('approve') },
      answered_by: {
        surface: 'rendered',
        probe: () => expect(answer.answered_by).toEqual({ by: 'alice', by_source: 'stated' }),
      },
      claim_proof: {
        surface: 'rendered',
        probe: () => expect(answer.claim_proof).toEqual({ proof: 'absent' }),
      },
      claim_proof_absent: {
        surface: 'rendered',
        // Data: the WORD (`proof_not_recorded`), not a phrase — the CLI words it.
        probe: () => expect(oldAnswer.claim_proof_absent).toBe('proof_not_recorded'),
      },
    } satisfies Record<keyof AnswerView, DisclosureRoute>;

    for (const registry of [CLAIM_RECORD, ATTRIBUTED, ANSWER_VIEW] as Array<
      Record<string, DisclosureRoute>
    >) {
      for (const [field, route] of Object.entries(registry)) {
        if (route.surface === 'rendered') route.probe();
        else
          expect(
            route.reason.trim().length,
            `waiver for '${field}' has an empty reason`,
          ).toBeGreaterThan(0);
      }
    }
    expect(
      Object.entries(CLAIM_RECORD)
        .filter(([, r]) => r.surface === 'waived')
        .map(([f]) => f)
        .sort(),
    ).toEqual(['deadline', 'token']);
    for (const registry of [ATTRIBUTED, ANSWER_VIEW] as Array<Record<string, DisclosureRoute>>) {
      expect(Object.values(registry).filter((r) => r.surface === 'waived')).toEqual([]);
    }
  });

  it('the claim token never appears anywhere in the response (one door)', async () => {
    const summary = await handleGetRunState(
      { run_id: 'r3b', include_steps: true },
      { runStore: makeStore(contextHolderRun) },
    );
    // (a) red when step_claims (or any field) starts carrying the token; (b) prints the response.
    expect(JSON.stringify(summary)).not.toContain('claim-token-that-must-never-leave');
  });

  it('step_claims is withheld on a sealed run (the R3 terminal guard is untouched)', async () => {
    const sealed = {
      ...contextHolderRun,
      run_phase: 'completed',
      terminal_state: true,
    } as unknown as RunRecord;
    const summary = await handleGetRunState({ run_id: 'r3b' }, { runStore: makeStore(sealed) });
    expect('step_claims' in summary).toBe(false);
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
  usage: [
    {
      request_index: 0,
      request_start: 't0',
      uncached_input_tokens: 60,
      // issue #600 PR 2: the request facts, asked for 1h, part of the write kept for 5m.
      model: 'claude-x-20260101',
      cache_requested: 'lifetime',
      cache_lifetime_s: 3600,
      cache_ttl_sent: true,
      cache_requested_source: 'stated',
      cache_requested_by: 'realm agent',
      provider: 'anthropic',
      cache_creation: { ephemeral_5m_input_tokens: 70, ephemeral_1h_input_tokens: 5 },
    },
  ],
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
    // issue #600 caching PR P: the priced response's drive failures.
    const pricedCosts = (await pricedSummary()).drive_failure_costs!;
    const gatewayCost = pricedCosts[0]!.cost!;
    const mixedMoney = pricedCosts[1]!.cost!.money!;

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
      // issue #600 PR 2.
      models: {
        surface: 'rendered',
        probe: () =>
          expect(b.cost!.models).toEqual({ names: ['claude-x-20260101'], reported: 1, of: 1 }),
      },
      cache_requested: {
        surface: 'rendered',
        probe: () =>
          expect(b.cost!.cache_requested).toEqual({
            entries: [
              {
                value: 'lifetime',
                lifetime_s: 3600,
                ttl_sent: true,
                source: 'stated',
                by: 'realm agent',
              },
            ],
            reported: 1,
            of: 1,
          }),
      },
      cache_write_5m: {
        surface: 'rendered',
        probe: () =>
          expect(b.cost!.cache_write_5m).toEqual({
            value: 70,
            reported: 1,
            of: 1,
            only_request_index: 0,
          }),
      },
      cache_write_1h: {
        surface: 'rendered',
        probe: () =>
          expect(b.cost!.cache_write_1h).toEqual({
            value: 5,
            reported: 1,
            of: 1,
            only_request_index: 0,
          }),
      },
      // issue #600 caching PR P.
      money: {
        surface: 'rendered',
        probe: () =>
          expect([
            gatewayCost.money?.total,
            gatewayCost.money?.net,
            gatewayCost.money?.sources.map((x) => x.matched_model),
          ]).toEqual([0.25, 0.25, ['claude-x']]),
      },
      endpoints: {
        surface: 'rendered',
        probe: () =>
          expect([gatewayCost.endpoints, a.cost!.endpoints]).toEqual([
            { custom: 1, of: 1 },
            { absent_cause: 'predates_request_facts' },
          ]),
      },
    } satisfies Record<keyof CostView, DisclosureRoute>;

    // issue #600 caching PR P: each field of one money figure, as data (unrounded).
    const MONEY = {
      total: { surface: 'rendered', probe: () => expect(mixedMoney.total).toBe(0.375) },
      uncached_counterfactual: {
        surface: 'rendered',
        probe: () => expect(mixedMoney.uncached_counterfactual).toBe(0.625),
      },
      net: { surface: 'rendered', probe: () => expect(mixedMoney.net).toBe(0.25) },
      priced: { surface: 'rendered', probe: () => expect(mixedMoney.priced).toBe(2) },
      of: { surface: 'rendered', probe: () => expect(mixedMoney.of).toBe(3) },
      dated: {
        surface: 'rendered',
        probe: () => expect([gatewayCost.money!.dated, mixedMoney.dated]).toEqual([1, 0]),
      },
      sources: {
        surface: 'rendered',
        probe: () =>
          expect(mixedMoney.sources.map((x) => [x.source_class, x.matched_model, x.count])).toEqual(
            [
              ['economics', 'claude-y-20260101', 1],
              ['price_list', 'gpt-5', 1],
            ],
          ),
      },
      source_totals: {
        surface: 'rendered',
        probe: () =>
          expect(mixedMoney.source_totals.map((x) => [x.source_class, x.count])).toEqual([
            ['economics', 1],
            ['price_list', 1],
          ]),
      },
      not_priced: {
        surface: 'rendered',
        probe: () =>
          expect(mixedMoney.not_priced).toEqual([{ cause: 'model_not_recorded', count: 1 }]),
      },
    } satisfies Record<keyof Money, DisclosureRoute>;

    // issue #600 PR 2: each field of one ask, as data.
    const entry = (b.cost!.cache_requested as { entries: CacheRequestedEntry[] }).entries[0]!;
    const CACHE_REQUESTED_ENTRY = {
      value: { surface: 'rendered', probe: () => expect(entry.value).toBe('lifetime') },
      lifetime_s: { surface: 'rendered', probe: () => expect(entry.lifetime_s).toBe(3600) },
      ttl_sent: { surface: 'rendered', probe: () => expect(entry.ttl_sent).toBe(true) },
      source: { surface: 'rendered', probe: () => expect(entry.source).toBe('stated') },
      by: { surface: 'rendered', probe: () => expect(entry.by).toBe('realm agent') },
    } satisfies Record<keyof CacheRequestedEntry, DisclosureRoute>;

    const COST_FIGURE = {
      value: { surface: 'rendered', probe: () => expect(a.cost!.prompt!.value).toBe(900) },
      reported: { surface: 'rendered', probe: () => expect(a.cost!.prompt!.reported).toBe(1) },
      of: { surface: 'rendered', probe: () => expect(a.cost!.prompt!.of).toBe(2) },
      only_request_index: {
        surface: 'rendered',
        probe: () => expect(a.cost!.prompt!.only_request_index).toBe(0),
      },
    } satisfies Record<keyof CostFigure, DisclosureRoute>;

    for (const registry of [ELEMENT, COST_VIEW, CACHE_REQUESTED_ENTRY, COST_FIGURE, MONEY]) {
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
