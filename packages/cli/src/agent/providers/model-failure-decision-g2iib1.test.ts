// model-failure-decision-g2iib1.test.ts — gap 2, unit (ii-b1): `decideModelFailure`, the drive's one
// rule that turns a failed model request into the facts `executeChain`'s `modelFailure` takes, or
// "give the step back". Checks 1 (one cell per row, the order, 1c against 1d), 2 (the hazards: a
// workspace refusal and a used-up quota on a step without `retry`), 3 (core admits every fact set the
// rule passes) and 4 (the four unusable-answer throws carry Realm's code and land on row 7).
//
// Every case is built from its real inputs: the error a send throws, sent through `driveCreate` (and
// its retry loop, `tryModelRequest`) or a provider with its SDK mocked; its tries as the drive's
// `triesOf` closes them; the drive-failure entry `buildEntry` makes; the step's `retry`; who sends.
// The SDK errors are each SDK's own classes (`APIError.generate`). Fake keys and messages only.
//
// Every assertion names (a) the change that turns it red and (b) what it prints when it fails.
import { describe, expect, it, vi } from 'vitest';
import { APIError as AnthropicAPIError, APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import { APIError as OpenAIAPIError } from 'openai';
import {
  WorkflowError,
  closeModelAttempts,
  executeChain,
  type ModelAttempt,
  type RetryConfig,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { buildEntry } from '../drive-failure.js';
import {
  decideModelFailure,
  driveCreate,
  makeModelRetryPolicy,
  modelAttemptsOf,
  tryModelRequest,
  type DriveCreateOptions,
  type FailedModelRequest,
  type LlmClock,
  type ModelFailureDecision,
  type ModelRetryPolicy,
  type WireCounters,
} from './agent-utils.js';
import { AnthropicProvider, workspaceRefusal } from './anthropic-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { OpenAIReasoningProvider } from './openai-reasoning-provider.js';

const anthropicCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/sdk')>()),
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: anthropicCreate } };
  }),
}));
const openaiCreate = vi.fn();
vi.mock('openai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('openai')>()),
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: openaiCreate } } };
  }),
}));

// ---------- the inputs, as the drive meets them --------------------------------------------------

const headers = (): Headers => new Headers({ 'request-id': 'req_fake_g2iib1' });

/** An Anthropic API error, as its SDK builds it from an answer's status and body. */
const anthropicError = (status: number, type: string, message = 'fake'): unknown =>
  AnthropicAPIError.generate(
    status,
    { type: 'error', error: { type, message } },
    undefined,
    headers(),
  );

/** An OpenAI API error, as its SDK builds it from an answer's status and body. */
const openaiError = (
  status: number,
  type: string,
  code: string | null,
  message = 'fake',
): unknown =>
  OpenAIAPIError.generate(
    status,
    { error: { type, code, message, param: null } },
    undefined,
    headers(),
  );

/** One wire attempt as the counting fetch counts it, then the send's outcome. */
interface Send {
  status?: number;
  /** A fresh error for each send (an error carries its own send's payload), or an answer. */
  fail?: () => unknown;
  ok?: unknown;
  /** The model client's own tries inside this send (a step without `retry`); default 1. */
  wire?: number;
}

/** Sends through `driveCreate` as a provider does, and returns what it throws. */
async function thrownBy(
  clock: LlmClock,
  sends: Send[],
  options: DriveCreateOptions = {},
): Promise<unknown> {
  const counters: WireCounters = { attempts: 0 };
  let n = 0;
  const raw = async (): Promise<unknown> => {
    const send = sends[Math.min(n++, sends.length - 1)]!;
    counters.attempts += send.wire ?? 1;
    if (send.status !== undefined) counters.lastStatus = send.status;
    if (send.fail !== undefined) throw send.fail();
    return send.ok;
  };
  return driveCreate(raw, {}, clock, counters, options).then(
    () => new Error('fixture: the send did not throw'),
    (err: unknown) => err,
  );
}

const policyOf = (
  retry: RetryConfig,
  over: { capMs?: number; mayResend?: () => Promise<boolean> } = {},
): ModelRetryPolicy =>
  makeModelRetryPolicy(
    {
      retry,
      capMs: over.capMs ?? 60_000,
      capSource: 'declared',
      mayResend: over.mayResend ?? (async () => true),
    },
    () => 0,
  );

/** The step's tries as the drive's `triesOf` keeps them on an entry. */
const triesOf = (policy: ModelRetryPolicy): ModelAttempt[] | undefined => {
  const tries = modelAttemptsOf(policy);
  return tries.length > 0 ? closeModelAttempts(tries) : undefined;
};

/** What the drive holds at its catch for `err`. */
const requestOf = (err: unknown, over: Partial<FailedModelRequest> = {}): FailedModelRequest => ({
  err,
  entry: buildEntry(err, 'classify', 'anthropic', performance.now(), new Date(0)),
  providerCalled: true,
  retry: undefined,
  tries: undefined,
  provider: 'realm',
  hasTools: false,
  ...over,
});

/** A step with `retry`, sent by Realm's own provider: the failure and the step's tries. */
async function retried(
  retry: RetryConfig,
  sends: Send[],
  over: { capMs?: number; mayResend?: () => Promise<boolean> } = {},
): Promise<FailedModelRequest> {
  const policy = policyOf(retry, over);
  const err = await thrownBy({ ceilingMs: 60_000, retry: policy }, sends, {
    workspaceRefusal: (e) => workspaceRefusal(e) !== undefined,
  });
  return requestOf(err, { retry, tries: triesOf(policy) });
}

/** A step without `retry`, sent by Realm's own provider (the model client's own tries ran). */
async function unretried(
  sends: Send[],
  options: DriveCreateOptions = {},
): Promise<FailedModelRequest> {
  return requestOf(await thrownBy({ ceilingMs: 60_000 }, sends, options));
}

/** A provider module's own error: its status on the error, as an SDK puts it. */
const moduleError = (status: number, payload?: Record<string, unknown>): Error =>
  Object.assign(new Error(`module call failed with ${String(status)} (fake)`), {
    status,
    ...(payload !== undefined ? { driveCall: payload } : {}),
  });

const RETRY2: RetryConfig = {
  max_attempts: 2,
  backoff: 'fixed',
  base_delay_ms: 1,
  max_delay_ms: 1,
};
const RETRY3: RetryConfig = {
  max_attempts: 3,
  backoff: 'fixed',
  base_delay_ms: 1,
  max_delay_ms: 1,
};
const fail529 = (): unknown => anthropicError(529, 'overloaded_error', 'Overloaded (fake)');
const fail400 = (): unknown => anthropicError(400, 'invalid_request_error', 'messages: bad (fake)');
const fail401 = (): unknown =>
  anthropicError(401, 'authentication_error', 'invalid x-api-key (fake)');
const timeout = (): unknown => new APIConnectionTimeoutError();
/** Anthropic's answer it could not use, as the provider throws it (anthropic-provider.ts). */
const truncated = (): WorkflowError => {
  const err = new WorkflowError(
    'Anthropic response was truncated (max_tokens) before a usable JSON object was produced.',
    { code: 'ENGINE_STEP_FAILED', category: 'ENGINE', agentAction: 'stop', retryable: false },
  );
  (err as unknown as { driveCall: unknown }).driveCall = { usage: [] };
  return err;
};
const text = (content: string): unknown => ({
  choices: [{ message: { role: 'assistant', content, tool_calls: undefined } }],
});

const GIVE_BACK: ModelFailureDecision = { outcome: 'give_back' };
const fails = (
  kind: 'transient' | 'permanent',
  stop_reason: 'attempts' | 'total_timeout' | 'non_retryable' | 'no_retry_policy',
  attempt: number,
  rest: { message: string; error_class: string; status: number | null; attempts_sdk?: number },
): ModelFailureDecision =>
  ({
    outcome: 'fail',
    modelFailure: { kind, stop_reason, attempt, ...rest },
  }) as ModelFailureDecision;

/** The SDK's own message: the status, then the answer's body. */
const bodyMessage = (status: number, type: string, message: string): string =>
  `${String(status)} ${JSON.stringify({ type: 'error', error: { type, message } })}`;
const OVERLOADED = {
  message: bodyMessage(529, 'overloaded_error', 'Overloaded (fake)'),
  error_class: 'api_status',
  status: 529,
};
const BAD = {
  message: bodyMessage(400, 'invalid_request_error', 'messages: bad (fake)'),
  error_class: 'api_status',
  status: 400,
};

// ---------- the rows ------------------------------------------------------------------------------

interface Case {
  row: string;
  name: string;
  build: () => Promise<FailedModelRequest>;
  want: ModelFailureDecision;
}

const CASES: Case[] = [
  {
    row: '0',
    name: "Realm's MCP refusal of a tool the server does not offer, before the first send",
    build: async () =>
      requestOf(
        new WorkflowError(
          "Step 'classify' declares tool 'kb:find' which is not exposed by MCP server 'kb'.",
          {
            code: 'MCP_TOOL_NOT_FOUND',
            category: 'ENGINE',
            agentAction: 'stop',
            retryable: false,
          },
        ),
        { providerCalled: false, hasTools: true },
      ),
    want: GIVE_BACK,
  },
  {
    row: '0',
    // With Realm's own MCP client no throw before the first send carries a status (the MCP SDK's
    // errors put theirs in a numeric `code`), so this is the one input row 0 alone decides: an MCP
    // client whose transport puts the HTTP status on its error, under a provider module.
    name: 'listing the MCP tools failed with a 503 on the error, under a module with no retry',
    build: async () =>
      requestOf(moduleError(503), { providerCalled: false, provider: 'module', hasTools: true }),
    want: GIVE_BACK,
  },
  {
    row: '7',
    name: "an answer Realm could not use (Anthropic's max_tokens cut), on a step with retry",
    build: async () => requestOf(truncated(), { retry: RETRY2 }),
    want: fails('permanent', 'non_retryable', 1, {
      message:
        'Anthropic response was truncated (max_tokens) before a usable JSON object was produced.',
      error_class: 'other',
      status: null,
    }),
  },
  {
    row: '1a',
    name: 'retry used up its tries: two 529s',
    build: () => retried(RETRY2, [{ status: 529, fail: fail529 }]),
    want: fails('transient', 'attempts', 2, { ...OVERLOADED, attempts_sdk: 1 }),
  },
  {
    row: '1b',
    name: 'the cap fired: the wait after a 529 would cross it',
    build: () =>
      retried(
        { ...RETRY3, base_delay_ms: 10_000, max_delay_ms: 10_000 },
        [{ status: 529, fail: fail529 }],
        {
          capMs: 1_000,
        },
      ),
    want: fails('transient', 'total_timeout', 1, { ...OVERLOADED, attempts_sdk: 1 }),
  },
  {
    row: '1b',
    // The cap runs out while the drive checks before re-sending: the request ends as a fired
    // ceiling, whose error the model client never counted (`attempts_sdk` 0, left out).
    name: 'the cap fired during the check before a re-send (attempts_sdk 0)',
    build: () =>
      retried(
        { ...RETRY3, base_delay_ms: 50, max_delay_ms: 50 },
        [{ status: 529, fail: fail529 }],
        {
          capMs: 300,
          mayResend: () => new Promise<boolean>(() => {}),
        },
      ),
    want: fails('transient', 'total_timeout', 1, {
      message:
        'LLM create exceeded the per-create ceiling (300ms) — raise retry.total_timeout_seconds on the step',
      error_class: 'aborted_by_budget',
      status: null,
    }),
  },
  {
    row: '1c',
    name: 'a timeout under retry.on_timeout: false',
    build: () => retried({ ...RETRY3, on_timeout: false }, [{ fail: timeout }]),
    want: fails('transient', 'non_retryable', 1, {
      message: 'Request timed out.',
      error_class: 'connection_timeout',
      status: null,
      attempts_sdk: 1,
    }),
  },
  {
    row: '1d',
    name: 'the same timeout with on_timeout absent, and the drive stopped resending',
    build: () => retried(RETRY3, [{ fail: timeout }], { mayResend: async () => false }),
    want: GIVE_BACK,
  },
  {
    row: '1d',
    // The class conjunct of 1c: a transient try that is no timeout, on a step with on_timeout: false.
    name: 'a 529 on a step with on_timeout: false, and the drive stopped resending',
    build: () =>
      retried({ ...RETRY3, on_timeout: false }, [{ status: 529, fail: fail529 }], {
        mayResend: async () => false,
      }),
    want: GIVE_BACK,
  },
  {
    row: '1e',
    name: 'a permanent failure: a 400 that is no workspace refusal',
    build: () => retried(RETRY2, [{ status: 400, fail: fail400 }]),
    want: fails('permanent', 'non_retryable', 1, {
      ...BAD,
      attempts_sdk: 1,
    }),
  },
  {
    row: '1f',
    name: 'a setup failure: a 401',
    build: () => retried(RETRY2, [{ status: 401, fail: fail401 }]),
    want: GIVE_BACK,
  },
  {
    row: '1f',
    name: 'no kind: a TypeError from the send',
    build: () => retried(RETRY2, [{ fail: () => new TypeError('fetch failed (fake)') }]),
    want: GIVE_BACK,
  },
  {
    row: '2',
    name: "no retry: the model client's own three tries of a 529 ran out",
    build: () => unretried([{ status: 529, fail: fail529, wire: 3 }]),
    want: fails('transient', 'no_retry_policy', 3, { ...OVERLOADED, attempts_sdk: 3 }),
  },
  {
    row: '2',
    name: 'no retry: a 400',
    build: () => unretried([{ status: 400, fail: fail400 }]),
    want: fails('permanent', 'non_retryable', 1, {
      ...BAD,
      attempts_sdk: 1,
    }),
  },
  {
    row: '2',
    name: 'no retry: a 401 (setup)',
    build: () => unretried([{ status: 401, fail: fail401 }]),
    want: GIVE_BACK,
  },
  {
    row: '3',
    name: 'a module with retry, no tools, not handling retries: Realm tried its whole call twice',
    build: async () => {
      const policy = policyOf(RETRY2);
      const err = await tryModelRequest(policy, {}, undefined, async () => {
        throw moduleError(503);
      }).then(
        () => new Error('fixture: no throw'),
        (e: unknown) => e,
      );
      return requestOf(err, { retry: RETRY2, tries: triesOf(policy), provider: 'module' });
    },
    want: fails('transient', 'attempts', 2, {
      message: 'module call failed with 503 (fake)',
      error_class: 'api_status',
      status: 503,
    }),
  },
  {
    row: '4',
    name: 'a module with retry and tools (Realm does not apply the retry): a 503',
    build: async () =>
      requestOf(moduleError(503), { retry: RETRY2, provider: 'module', hasTools: true }),
    want: fails('transient', 'non_retryable', 1, {
      message: 'module call failed with 503 (fake)',
      error_class: 'api_status',
      status: 503,
    }),
  },
  {
    row: '4',
    name: 'a module with retry and tools: a 400',
    build: async () =>
      requestOf(moduleError(400), { retry: RETRY2, provider: 'module', hasTools: true }),
    want: fails('permanent', 'non_retryable', 1, {
      message: 'module call failed with 400 (fake)',
      error_class: 'api_status',
      status: 400,
    }),
  },
  {
    row: '5',
    name: 'a module that handles its own retries, with retry: its three tries of a 429 ran out',
    build: async () =>
      requestOf(
        moduleError(429, { error_class: 'api_status', attempts_sdk: 3, last_observed_status: 429 }),
        { retry: RETRY3, provider: 'module_handles_retries' },
      ),
    want: fails('transient', 'non_retryable', 3, {
      message: 'module call failed with 429 (fake)',
      error_class: 'api_status',
      status: 429,
      attempts_sdk: 3,
    }),
  },
  {
    row: '6',
    name: 'a module without retry: a 503',
    build: async () => requestOf(moduleError(503), { provider: 'module' }),
    want: fails('transient', 'no_retry_policy', 1, {
      message: 'module call failed with 503 (fake)',
      error_class: 'api_status',
      status: 503,
    }),
  },
  {
    row: '6',
    name: 'a module without retry: a 404 (setup)',
    build: async () => requestOf(moduleError(404), { provider: 'module' }),
    want: GIVE_BACK,
  },
  {
    row: 'anything else',
    name: "Realm's provider, no retry: a TypeError after the answer (no send failed)",
    build: async () =>
      requestOf(new TypeError("Cannot read properties of undefined (reading 'x')")),
    want: GIVE_BACK,
  },
];

/** What a failing cell prints: the row, the facts the rule was given, and what it decided. */
function seen(c: Case, request: FailedModelRequest, decision: ModelFailureDecision) {
  return {
    row: c.row,
    given: {
      class: request.entry.error_class,
      status: request.entry.last_observed_status ?? null,
      attempts_sdk: request.entry.attempts_sdk ?? null,
      code: request.err instanceof WorkflowError ? request.err.code : null,
      tries: request.tries?.map((t) => [
        t.request,
        t.kind,
        t.error_class,
        t.wait_ms,
        t.exhausted_by ?? null,
      ]),
      provider: request.provider,
      retry: request.retry !== undefined,
    },
    decision,
  };
}

describe('gap 2 (ii-b1), check 1 — one cell per row of the rule', () => {
  for (const c of CASES) {
    it(`row ${c.row}: ${c.name}`, async () => {
      const request = await c.build();
      const decision = decideModelFailure(request);
      // (a) red when the row's branch is removed (the case falls to a later row), or the rows run out
      //     of order; (b) prints the facts given and the decision.
      expect(seen(c, request, decision)).toEqual(seen(c, request, c.want));
    });
  }

  it("the order: a step with retry whose first send failed and waited, then got an answer Realm could not use (OpenAI's non-JSON after its JSON retry) → row 7, not rows 1a-1f", async () => {
    openaiCreate.mockReset();
    openaiCreate
      .mockRejectedValueOnce(openaiError(503, 'server_error', null, 'upstream busy (fake)'))
      .mockResolvedValueOnce(text('not JSON'))
      .mockResolvedValueOnce(text('still not'));
    const policy = policyOf(RETRY2);
    const err = await new OpenAIProvider('gpt-4o')
      .callStep('x', undefined, undefined, { llmClock: { ceilingMs: 60_000, retry: policy } })
      .catch((e: unknown) => e);
    const request = requestOf(err, { retry: RETRY2, tries: triesOf(policy) });
    const decision = decideModelFailure(request);
    const c: Case = { row: '7 (order)', name: '', build: async () => request, want: GIVE_BACK };
    // (a) red when rows 1a-1f run before row 7 (the waited try ended no request: give back); (b)
    //     prints the tries and the decision.
    expect(seen(c, request, decision)).toEqual(
      seen(
        c,
        request,
        fails('permanent', 'non_retryable', 1, {
          message: 'OpenAI returned non-JSON content after retry: still not',
          error_class: 'other',
          status: null,
        }),
      ),
    );
    expect(
      request.tries?.map((t) => [t.kind, t.wait_ms]),
      'fixture: one waited try',
    ).toEqual([['transient', 1]]);
  });
});

describe('gap 2 (ii-b1), check 2 — the hazards on a step without retry', () => {
  it("Anthropic's workspace refusal (400 invalid_request_error naming anthropic-workspace-id) gives back", async () => {
    anthropicCreate.mockReset();
    anthropicCreate.mockRejectedValue(
      anthropicError(
        400,
        'invalid_request_error',
        'anthropic-workspace-id header is required (fake)',
      ),
    );
    const err = await new AnthropicProvider('claude-x')
      .callStep('x', undefined, undefined, { llmClock: { ceilingMs: 60_000 } })
      .catch((e: unknown) => e);
    expect(workspaceRefusal(err), 'fixture: the provider reads a refusal').toBe('missing');
    const request = requestOf(err);
    // (a) red when case 2's kind is computed without the provider's rule (a 400 reads permanent and
    //     the step would fail); (b) prints the facts and the decision.
    expect(decideModelFailure(request)).toEqual(GIVE_BACK);
  });

  it("OpenAI's 429 insufficient_quota gives back", async () => {
    openaiCreate.mockReset();
    openaiCreate.mockRejectedValue(openaiError(429, 'insufficient_quota', 'insufficient_quota'));
    const err = await new OpenAIProvider('gpt-4o')
      .callStep('x', undefined, undefined, { llmClock: { ceilingMs: 60_000 } })
      .catch((e: unknown) => e);
    // (a) red when case 2's kind is computed without the error's type and code (a 429 reads
    //     transient); (b) prints the decision.
    expect(decideModelFailure(requestOf(err))).toEqual(GIVE_BACK);
  });

  it("OpenAI's 429 credit_balance_exhausted, whose type is rate_limit_error, gives back", async () => {
    openaiCreate.mockReset();
    openaiCreate.mockRejectedValue(
      openaiError(429, 'rate_limit_error', 'credit_balance_exhausted'),
    );
    const err = await new OpenAIProvider('gpt-4o')
      .callStep('x', undefined, undefined, { llmClock: { ceilingMs: 60_000 } })
      .catch((e: unknown) => e);
    // (a) red when case 2's kind is computed without the error's code (only the code says the
    //     credit is used up; a 429 reads transient); (b) prints the decision.
    expect(decideModelFailure(requestOf(err))).toEqual(GIVE_BACK);
  });
});

const stepOf = (retry: RetryConfig | undefined): StepDefinition =>
  ({
    description: 'Classify.',
    execution: 'agent',
    depends_on: [],
    ...(retry !== undefined ? { retry } : {}),
  }) as StepDefinition;
const wfOf = (retry: RetryConfig | undefined): WorkflowDefinition =>
  ({
    id: 'wf-g2iib1',
    name: 'g2iib1',
    version: 1,
    steps: { classify: stepOf(retry) },
  }) as WorkflowDefinition;

describe('gap 2 (ii-b1), check 3 — core admits every fact set the rule passes', () => {
  for (const c of CASES.filter((k) => k.want.outcome === 'fail')) {
    it(`row ${c.row}: ${c.name}`, async () => {
      const request = await c.build();
      const decision = decideModelFailure(request);
      if (decision.outcome !== 'fail') throw new Error(`fixture: row ${c.row} gave back`);
      const store = new InMemoryStore();
      const def = wfOf(request.retry);
      const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const reply = await executeChain(store, def, {
        runId: record.id,
        command: 'classify',
        input: {},
        dispatcher: async () => ({}),
        modelFailure: decision.modelFailure,
      }).catch((err: unknown) => ({ thrown: err instanceof Error ? err.message : String(err) }));
      const { record: after } = await store.get(record.id);
      const last = after.evidence[after.evidence.length - 1];
      // (a) red when the rule passes a value core refuses (an attempts_sdk of 0, an attempt below 1,
      //     a class or a pair core does not admit); (b) prints the reply or the refusal and the entry.
      expect({
        thrown: 'thrown' in reply ? reply.thrown : null,
        failed: after.failed_steps,
        kind: last?.diagnostics?.failure_kind ?? null,
        attempt: last?.attempt ?? null,
      }).toEqual({
        thrown: null,
        failed: ['classify'],
        kind: decision.modelFailure.kind,
        attempt: decision.modelFailure.attempt,
      });
    });
  }

  it('an attempts_sdk of 0 is left out, and every attempt is 1 or more', async () => {
    const zero = CASES.find((c) => c.name.includes('attempts_sdk 0'))!;
    const request = await zero.build();
    expect(request.entry.attempts_sdk, 'fixture: the entry carries the client count 0').toBe(0);
    const decision = decideModelFailure(request);
    // (a) red when the raw 0 is passed (core refuses it); (b) prints the facts passed.
    expect(decision.outcome === 'fail' && 'attempts_sdk' in decision.modelFailure).toBe(false);
    for (const c of CASES) {
      const d = decideModelFailure(await c.build());
      if (d.outcome === 'fail') expect(d.modelFailure.attempt, c.name).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('gap 2 (ii-b1), check 4 — the four unusable-answer throws carry ENGINE_STEP_FAILED and land on row 7', () => {
  const STRICT = { type: 'object', properties: {}, additionalProperties: false };
  const THROWS: Array<{ name: string; run: () => Promise<unknown>; message: string }> = [
    {
      name: "OpenAI's non-JSON after its JSON retry",
      run: async () => {
        openaiCreate.mockReset();
        openaiCreate
          .mockResolvedValueOnce(text('not JSON'))
          .mockResolvedValueOnce(text('still not'));
        return new OpenAIProvider('gpt-4o').callStep('x').catch((e: unknown) => e);
      },
      message: 'OpenAI returned non-JSON content after retry: still not',
    },
    {
      name: "OpenAI's refusal under strict decoding",
      run: async () => {
        openaiCreate.mockReset();
        openaiCreate.mockResolvedValueOnce({
          choices: [
            { message: { role: 'assistant', content: null, refusal: 'I cannot help (fake)' } },
          ],
        });
        return new OpenAIProvider('gpt-4o')
          .callStepWithMeta('x', STRICT, undefined, { structuredOutputStrict: true })
          .catch((e: unknown) => e);
      },
      message: 'OpenAI refused the request: I cannot help (fake)',
    },
    {
      name: "OpenAI's non-JSON under strict decoding",
      run: async () => {
        openaiCreate.mockReset();
        openaiCreate.mockResolvedValueOnce(text('not JSON'));
        return new OpenAIProvider('gpt-4o')
          .callStepWithMeta('x', STRICT, undefined, { structuredOutputStrict: true })
          .catch((e: unknown) => e);
      },
      message: 'OpenAI returned non-JSON content under strict decoding: not JSON',
    },
    {
      name: "the o1-family reasoning provider's non-JSON after its JSON retry",
      run: async () => {
        openaiCreate.mockReset();
        openaiCreate
          .mockResolvedValueOnce(text('not JSON'))
          .mockResolvedValueOnce(text('still not'));
        return new OpenAIReasoningProvider('o1-mini').callStep('x').catch((e: unknown) => e);
      },
      message: 'OpenAI returned non-JSON content after retry: still not',
    },
  ];
  for (const t of THROWS) {
    it(t.name, async () => {
      const err = await t.run();
      const request = requestOf(err);
      // (a) red when the throw is a plain Error again (no code: the rule gives back); (b) prints the
      //     error's code, the entry's class and message, and the decision.
      expect({
        code: err instanceof WorkflowError ? err.code : null,
        entry: [request.entry.error_class, request.entry.message],
        decision: decideModelFailure(request),
      }).toEqual({
        code: 'ENGINE_STEP_FAILED',
        entry: ['other', t.message],
        decision: fails('permanent', 'non_retryable', 1, {
          message: t.message,
          error_class: 'other',
          status: null,
        }),
      });
    });
  }
});
