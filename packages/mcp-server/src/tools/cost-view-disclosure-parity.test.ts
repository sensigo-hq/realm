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
} from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';

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
