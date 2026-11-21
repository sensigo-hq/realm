// retries-provider-g2ib.test.ts — gap 2, unit (i-b): an agent step that declares `retry`, at the one
// function every request site calls (`driveCreate`), driven through Realm's REAL providers and the
// real SDKs at the locked versions (@anthropic-ai/sdk 0.137.0, openai 6.48.0). The wire is a scripted
// `fetch` the provider's counting fetch wraps, so each wire try is counted and each body seen; no
// real provider, fake keys only. `Math.random` is pinned to 0, so neither the SDK's jitter nor
// Realm's shortens a wait, and each recorded wait is exact.
//
// Every cell carries (a) the break that turns it red and (b) what it prints.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelAttempt, RetryConfig } from '@sensigo/realm';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import {
  deriveRetryCap,
  makeModelRetryPolicy,
  modelAttemptsOf,
  type LlmClock,
  type ModelRetryPolicy,
} from './agent-utils.js';

type Wire = (init: RequestInit | undefined) => Response | Promise<Response>;
let script: Wire[] = [];
let bodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  script = [];
  bodies = [];
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-fake-g2ib-0000');
  vi.stubEnv('OPENAI_API_KEY', 'sk-fake-g2ib-0000');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      const next = script.shift();
      if (next === undefined) throw new Error('the test scripted no further answer');
      return next(init);
    }),
  );
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const JSONH = { 'content-type': 'application/json' };
const anthropicAnswer =
  (text = '{"answer":"ok"}'): Wire =>
  () =>
    new Response(
      JSON.stringify({
        id: 'msg_fake_g2ib',
        type: 'message',
        role: 'assistant',
        model: 'claude-test-1',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: JSONH },
    );
const anthropicFail =
  (status: number, type: string, message: string, headers: Record<string, string> = {}): Wire =>
  () =>
    new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
      status,
      headers: { ...JSONH, ...headers },
    });
const openaiFail =
  (status: number, error: { type: string; code: string | null; message: string }): Wire =>
  () =>
    new Response(JSON.stringify({ error: { ...error, param: null } }), {
      status,
      headers: JSONH,
    });
/** A send that never answers until its signal aborts it. */
const hang: Wire = (init) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted (fake)'), { name: 'AbortError' })),
    );
  });

const FAST: RetryConfig = { max_attempts: 2, backoff: 'fixed', base_delay_ms: 1 };

function policyOf(
  retry: RetryConfig,
  options: { mayResend?: () => Promise<boolean>; capMs?: number } = {},
): ModelRetryPolicy {
  return makeModelRetryPolicy({
    retry,
    ...(options.capMs !== undefined
      ? { capMs: options.capMs, capSource: 'declared' as const }
      : deriveRetryCap(retry, 600_000)),
    mayResend: options.mayResend ?? (async () => true),
  });
}
const clockOf = (retry?: ModelRetryPolicy, extra: Partial<LlmClock> = {}): LlmClock => ({
  ceilingMs: 120_000,
  perAttemptSource: 'step',
  ...(retry !== undefined ? { retry } : {}),
  ...extra,
});

type Outcome = { output?: unknown; err?: unknown };
async function anthropicCall(
  clock: LlmClock,
  opts: { strict?: boolean; cacheQuestion?: boolean } = {},
): Promise<Outcome> {
  const provider = new AnthropicProvider(
    'claude-test-1',
    // At Anthropic's own address, asking to cache, told to ask (as the 3-M cells build it).
    opts.cacheQuestion === true
      ? { endpoint: 'default', promptCache: { value: 'short' }, cacheDiagnostics: true }
      : undefined,
  );
  return provider
    .callStepWithMeta(
      'Answer with JSON.',
      opts.strict === true
        ? { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
        : undefined,
      undefined,
      { llmClock: clock, ...(opts.strict === true ? { structuredOutputStrict: true } : {}) },
    )
    .then(
      (r) => ({ output: r.output }),
      (err: unknown) => ({ err }),
    );
}
async function openaiCall(clock: LlmClock): Promise<Outcome> {
  return new OpenAIProvider('gpt-test')
    .callStepWithMeta('Answer with JSON.', undefined, undefined, { llmClock: clock })
    .then(
      (r) => ({ output: r.output }),
      (err: unknown) => ({ err }),
    );
}
const statusOf = (o: Outcome) => (o.err as { status?: unknown } | undefined)?.status;
const briefTries = (tries: ModelAttempt[]) =>
  tries.map((t) => ({
    kind: t.kind,
    status: t.status,
    wait_ms: t.wait_ms,
    ...(t.exhausted_by !== undefined ? { exhausted_by: t.exhausted_by } : {}),
    ...(t.then !== undefined ? { then: t.then } : {}),
  }));

describe('gap 2, unit (i-b) — check 1: a step without retry is as before', () => {
  it("a 503 makes the model client's own 3 wire tries, with its own waits, and nothing is recorded", async () => {
    script = [1, 2, 3].map(() => anthropicFail(503, 'api_error', 'overloaded (fake)'));
    const started = performance.now();
    const out = await anthropicCall(clockOf());
    // (a) red when the client's retries are off for every step (the "declares retry" condition
    //     dropped): 1 wire try; (b) prints the tries, the status and the time the client waited.
    expect({
      wire: bodies.length,
      status: statusOf(out),
      waitedAtLeastOneAndAHalfSeconds: performance.now() - started >= 1400,
    }).toEqual({ wire: 3, status: 503, waitedAtLeastOneAndAHalfSeconds: true });
  }, 20_000);
});

describe('gap 2, unit (i-b) — check 2: a transient failure, then success', () => {
  it('max_attempts 2, a 503 then a 200: 2 wire tries, the answer, and one failed try recorded', async () => {
    const policy = policyOf(FAST);
    script = [anthropicFail(503, 'api_error', 'overloaded (fake)'), anthropicAnswer()];
    const out = await anthropicCall(clockOf(policy));
    // (a) red when the client's retries stay on (the loop then sees no failure: no entry);
    //     (b) prints the wire count, the output and the tries.
    expect({ wire: bodies.length, output: out.output, tries: modelAttemptsOf(policy) }).toEqual({
      wire: 2,
      output: { answer: 'ok' },
      tries: [
        {
          request: 0,
          kind: 'transient',
          error_class: 'api_status',
          status: 503,
          wait_ms: 1,
          retry_after_ms: null,
        },
      ],
    });
  });
});

describe('gap 2, unit (i-b) — check 3: a Retry-After above the backoff', () => {
  it('the wait is the Retry-After, as recorded', async () => {
    const policy = policyOf(FAST);
    script = [
      anthropicFail(429, 'rate_limit_error', 'slow down (fake)', { 'retry-after-ms': '60' }),
      anthropicAnswer(),
    ];
    const started = performance.now();
    const out = await anthropicCall(clockOf(policy));
    // (a) red when the wait is the backoff alone (1 ms); (b) prints the tries and the time.
    expect({
      output: out.output,
      tries: briefTries(modelAttemptsOf(policy)),
      retryAfter: modelAttemptsOf(policy)[0]?.retry_after_ms,
      waited: performance.now() - started >= 55,
    }).toEqual({
      output: { answer: 'ok' },
      tries: [{ kind: 'transient', status: 429, wait_ms: 60 }],
      retryAfter: 60,
      waited: true,
    });
  });
});

describe('gap 2, unit (i-b) — check 4: a failure no try can fix is never tried again', () => {
  const RETRY3: RetryConfig = { max_attempts: 3, backoff: 'fixed', base_delay_ms: 1 };
  const arms: Array<[string, () => Promise<Outcome>, Wire, ModelAttempt['kind'], number]> = [
    [
      'a 503 with x-should-retry: false',
      () => anthropicCall(clockOf(arm.policy)),
      anthropicFail(503, 'api_error', 'overloaded (fake)', { 'x-should-retry': 'false' }),
      'permanent',
      503,
    ],
    [
      'a 401',
      () => anthropicCall(clockOf(arm.policy)),
      anthropicFail(401, 'authentication_error', 'invalid x-api-key (fake)'),
      'setup',
      401,
    ],
    [
      'a 400',
      () => anthropicCall(clockOf(arm.policy)),
      anthropicFail(400, 'invalid_request_error', 'bad request (fake)'),
      'permanent',
      400,
    ],
    [
      "OpenAI's credit_balance_exhausted",
      () => openaiCall(clockOf(arm.policy)),
      openaiFail(429, {
        type: 'insufficient_quota',
        code: 'credit_balance_exhausted',
        message: 'no credits (fake)',
      }),
      'setup',
      429,
    ],
    [
      "OpenAI's type insufficient_quota, with no code",
      () => openaiCall(clockOf(arm.policy)),
      openaiFail(429, { type: 'insufficient_quota', code: null, message: 'quota (fake)' }),
      'setup',
      429,
    ],
  ];
  const arm: { policy: ModelRetryPolicy } = { policy: policyOf(RETRY3) };
  for (const [what, call, wire, kind, status] of arms) {
    it(`${what}: one try, and the error is the provider's`, async () => {
      arm.policy = policyOf(RETRY3);
      script = [wire, wire, wire];
      const out = await call();
      // (a) red when every failure is filed transient (3 wire tries); (b) prints the wire count,
      //     the status and the try.
      expect({
        wire: bodies.length,
        status: statusOf(out),
        tries: briefTries(modelAttemptsOf(arm.policy)),
      }).toEqual({ wire: 1, status, tries: [{ kind, status, wait_ms: null }] });
    });
  }
});

describe('gap 2, unit (i-b) — check 5: the cap', () => {
  it('total_timeout_seconds 1 with Retry-After 30: one try, no wait started, the 429 kept, exhausted by the cap', async () => {
    const policy = policyOf({ max_attempts: 3 }, { capMs: 1000 });
    script = [
      anthropicFail(429, 'rate_limit_error', 'slow down (fake)', { 'retry-after': '30' }),
      anthropicAnswer(),
    ];
    const started = performance.now();
    const out = await anthropicCall(clockOf(policy));
    const payload = (out.err as { driveCall?: Record<string, unknown> } | undefined)?.driveCall;
    // (a) red when the guard before a wait is removed (the wait starts and the cap ends it at 1 s,
    //     as a fired ceiling); (b) prints the outcome, the payload and the tries.
    expect({
      wire: bodies.length,
      status: statusOf(out),
      retryAfter: payload?.['retry_after_observed_ms'],
      cls: payload?.['error_class'],
      tries: briefTries(modelAttemptsOf(policy)),
      noWait: performance.now() - started < 500,
    }).toEqual({
      wire: 1,
      status: 429,
      retryAfter: 30000,
      cls: 'api_status',
      tries: [{ kind: 'transient', status: 429, wait_ms: null, exhausted_by: 'total_timeout' }],
      noWait: true,
    });
  });

  it('a declared cap that fires during a try ends it with Words 7: the lever is retry.total_timeout_seconds', async () => {
    const policy = policyOf({ max_attempts: 3 }, { capMs: 300 });
    script = [hang];
    const out = await anthropicCall(clockOf(policy));
    const payload = (out.err as { driveCall?: Record<string, unknown> } | undefined)?.driveCall;
    // (a) red when a declared cap names today's levers; (b) prints the message and the tries.
    expect({
      message: (out.err as Error | undefined)?.message,
      cls: payload?.['error_class'],
      tries: briefTries(modelAttemptsOf(policy)),
    }).toEqual({
      message:
        'LLM create exceeded the per-create ceiling (300ms) — raise retry.total_timeout_seconds on the step',
      cls: 'aborted_by_budget',
      tries: [{ kind: 'transient', status: null, wait_ms: null, exhausted_by: 'total_timeout' }],
    });
  });

  it('without the key, the cap is derived: max_attempts × the per-attempt timeout + the waits + 60 s, and its line is today', async () => {
    // (a) red when the derived cap drops a term or the declared one is not the key's; (b) prints both.
    expect({
      derived: deriveRetryCap({ max_attempts: 2 }, 30_000),
      declared: deriveRetryCap({ max_attempts: 2, total_timeout_seconds: 5 }, 30_000),
      exponential: deriveRetryCap(
        { max_attempts: 3, backoff: 'exponential', base_delay_ms: 100 },
        1000,
      ),
    }).toEqual({
      derived: { capMs: 2 * 30_000 + 500 + 60_000, capSource: 'derived' },
      declared: { capMs: 5000, capSource: 'declared' },
      exponential: { capMs: 3 * 1000 + 100 + 200 + 60_000, capSource: 'derived' },
    });
    const policy = makeModelRetryPolicy({
      retry: { max_attempts: 2 },
      capMs: 300,
      capSource: 'derived',
      mayResend: async () => true,
    });
    script = [hang];
    const out = await anthropicCall(clockOf(policy));
    // (a) red when a derived cap names retry.total_timeout_seconds; (b) prints the message.
    expect((out.err as Error | undefined)?.message).toBe(
      'LLM create exceeded the per-create ceiling (300ms) — raise llm_timeout_seconds on the step',
    );
  });
});

describe('gap 2, unit (i-b) — check 6 at the provider: a "no" before a re-send sends nothing', () => {
  it('the drive says no after the wait: one wire try, the error kept, and nothing followed', async () => {
    const policy = policyOf(FAST, { mayResend: async () => false });
    script = [anthropicFail(503, 'api_error', 'overloaded (fake)'), anthropicAnswer()];
    const out = await anthropicCall(clockOf(policy));
    // (a) red when the check is removed (2 wire tries, the answer); (b) prints the outcome.
    expect({
      wire: bodies.length,
      status: statusOf(out),
      tries: briefTries(modelAttemptsOf(policy)),
    }).toEqual({
      wire: 1,
      status: 503,
      tries: [{ kind: 'transient', status: 503, wait_ms: null }],
    });
  });
});

/** Whether a request body asks for strict structured output. */
const strictBody = (b: Record<string, unknown>): boolean =>
  JSON.stringify(b).includes('"strict":true');

describe('gap 2, unit (i-b) — check 8: the strict ladder, the cache probe', () => {
  it('(i) a grammar-unavailable 503 goes to the ladder at once: one wire try, no wait, then the re-send without strict', async () => {
    const policy = policyOf(FAST);
    script = [
      anthropicFail(503, 'api_error', 'Grammar compilation is temporarily unavailable (fake)'),
      anthropicAnswer(),
    ];
    const out = await anthropicCall(clockOf(policy), { strict: true });
    // (a) red when the loop tries the grammar 503 again with strict first; (b) prints the sends.
    expect({
      output: out.output,
      strict: bodies.map(strictBody),
      tries: briefTries(modelAttemptsOf(policy)),
    }).toEqual({
      output: { answer: 'ok' },
      strict: [true, false],
      tries: [{ kind: 'transient', status: 503, wait_ms: 0, then: 'strict_ladder' }],
    });
  });

  it('(ii) max_attempts 2: a 529, a 400 to the strict body, a 200 without strict — 3 wire tries, 2 tries recorded, the second answered by the ladder', async () => {
    const policy = policyOf(FAST);
    script = [
      anthropicFail(529, 'overloaded_error', 'overloaded (fake)'),
      anthropicFail(400, 'invalid_request_error', 'schema refused (fake)'),
      anthropicAnswer(),
    ];
    const out = await anthropicCall(clockOf(policy), { strict: true });
    // (a) red when the ladder's re-send uses up a try (the drive then stops after the 400, with 2
    //     wire tries); (b) prints the sends and the tries.
    expect({
      output: out.output,
      strict: bodies.map(strictBody),
      tries: briefTries(modelAttemptsOf(policy)),
    }).toEqual({
      output: { answer: 'ok' },
      strict: [true, true, false],
      tries: [
        { kind: 'transient', status: 529, wait_ms: 1 },
        { kind: 'permanent', status: 400, wait_ms: 0, then: 'strict_ladder' },
      ],
    });
  });

  it("(iii) the refused cache question at Anthropic's own address, max_attempts absent: settles as today", async () => {
    const policy = policyOf({} as RetryConfig);
    script = [
      anthropicFail(400, 'invalid_request_error', 'unknown field (fake)'),
      anthropicAnswer(),
    ];
    const out = await anthropicCall(clockOf(policy), { cacheQuestion: true });
    // (a) red when the probe's re-send uses up the one try (the drive stops after the 400);
    //     (b) prints the sends and the tries.
    expect({
      output: out.output,
      asked: bodies.map((b) => 'diagnostics' in b),
      tries: briefTries(modelAttemptsOf(policy)),
    }).toEqual({
      output: { answer: 'ok' },
      asked: [true, false],
      tries: [{ kind: 'permanent', status: 400, wait_ms: 0, then: 'cache_probe' }],
    });
  });
});

describe('gap 2, unit (i-b) — check 9 at the provider: every try fails', () => {
  it('a 503 every time and max_attempts 2: 2 wire tries (6 with the client retrying too), the last exhausted by the tries', async () => {
    const policy = policyOf(FAST);
    script = Array.from({ length: 6 }, () => anthropicFail(503, 'api_error', 'overloaded (fake)'));
    const out = await anthropicCall(clockOf(policy));
    // (a) red when the client's retries stay on (6 wire tries); (b) prints the count and the tries.
    expect({
      wire: bodies.length,
      status: statusOf(out),
      tries: briefTries(modelAttemptsOf(policy)),
    }).toEqual({
      wire: 2,
      status: 503,
      tries: [
        { kind: 'transient', status: 503, wait_ms: 1 },
        { kind: 'transient', status: 503, wait_ms: null, exhausted_by: 'attempts' },
      ],
    });
  });
});

describe('gap 2, unit (i-b) — check 10: on_timeout: false', () => {
  for (const [what, onTimeout, wire] of [
    ['with on_timeout: false, a timed-out try is not sent again', false, 1],
    ['without the key, a timed-out try is sent again', undefined, 2],
  ] as const) {
    it(
      what,
      async () => {
        const policy = policyOf({
          ...FAST,
          ...(onTimeout !== undefined ? { on_timeout: onTimeout } : {}),
        });
        script = [hang, anthropicAnswer()];
        // The SDK's own per-try timeout (`timeout`), from the clock's declared per-attempt value.
        const out = await anthropicCall(clockOf(policy, { declaredPerAttemptMs: 100 }));
        // (a) red when the key is ignored; (b) prints the wire count and the tries.
        expect({
          wire: bodies.length,
          first: modelAttemptsOf(policy)[0]?.error_class,
          settled: out.output !== undefined,
        }).toEqual({ wire, first: 'connection_timeout', settled: wire === 2 });
      },
      10_000,
    );
  }
});
