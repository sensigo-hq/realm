// cache-choice-per-call-3m.test.ts — caching 3-M piece D-1: one provider call can carry its own cache
// choice. The real case, for every cell: a drive whose two steps run at different rhythms, so each
// step's call asks for its own lifetime. Nothing passes the option yet (D-2 will), so these cells
// drive the adapters directly, typed as a caller will type them.
//
// The SDKs are mocked with the shapes `provider-conformance.test.ts` and the adapters' own tests use;
// each body is deep-copied when it is sent. On a failure a cell prints the choice, the marks and the
// recorded facts, never prompt text or a key. Each assertion carries (1) the break that turns it red
// and (2) what it prints.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheAuto, UsageRecord } from '@sensigo/realm';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import type {
  CallCacheChoice,
  LlmProvider,
  PromptCacheRequest,
  ToolCapableLlmProvider,
} from './llm-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

const anthropicCreate = vi.fn();
const openaiCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: anthropicCreate } };
  }),
}));
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: openaiCreate } } };
  }),
}));

type Body = Record<string, unknown>;
/** What each request carried, deep-copied at call time. */
let sent: Body[] = [];
/** The answers the model gives, in order; an Error entry is thrown instead. */
let script: unknown[] = [];

const USAGE = {
  input_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 1,
};
const msgId = (n: number): string => `msg_01${String(n).padStart(22, 'A')}`;
const textAnswer = (text = '{"x":"a"}', id = msgId(1)) => ({
  id,
  model: 'claude-test-1',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: USAGE,
});
const toolCall = (n: number) => ({
  id: msgId(n),
  model: 'claude-test-1',
  content: [{ type: 'tool_use', id: `toolu_${n}`, name: 'lookup', input: {} }],
  stop_reason: 'tool_use',
  usage: USAGE,
});
const submit = () => ({
  id: msgId(9),
  model: 'claude-test-1',
  content: [{ type: 'tool_use', id: 'submit1', name: '__realm_submit__', input: { x: 'a' } }],
  stop_reason: 'tool_use',
  usage: USAGE,
});
const openaiAnswer = (content = '{"x":"a"}') => ({
  id: 'chatcmpl-fake',
  model: 'gpt-5.6-luna',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 10, completion_tokens: 1 },
});
const httpError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { status });

beforeEach(() => {
  sent = [];
  script = [];
  for (const [create, fallback] of [
    [anthropicCreate, textAnswer()],
    [openaiCreate, openaiAnswer()],
  ] as const) {
    create.mockReset();
    create.mockImplementation(async (body: Body) => {
      sent.push(structuredClone(body));
      const next = script.length > 0 ? script.shift() : fallback;
      if (next instanceof Error) throw next;
      return next;
    });
  }
});

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x'],
  properties: { x: { type: 'string' } },
};
const HEAD = 'You classify support tickets.\nTicket: ';
const PROMPT = `${HEAD}my parcel never came`;
const LOOKUP: ToolDefinition = {
  id: 'srv:lookup',
  serverId: 'srv',
  name: 'lookup',
  description: 'Look a thing up',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
};
const EXECUTOR = async () => ({ content: [{ type: 'text', text: 'ok' }] });

const SHORT = { type: 'ephemeral' };
const LONG = { type: 'ephemeral', ttl: '1h' };
const NO_MEASUREMENT: CacheAuto = { basis: 'no_measurement' };
const GAPS_900: CacheAuto = { basis: 'listen_trigger_gaps', gaps_s: [900] };

/** `auto` with no measurement: Anthropic settles it at short, OpenAI's set at its 30 minutes. */
const autoAgent = (): PromptCacheRequest => ({
  value: 'auto',
  source: 'runner_default',
  by: 'realm agent',
  auto: NO_MEASUREMENT,
});
/** `auto` on a listen basis: with no gaps Anthropic settles it at long; with gaps it is pending. */
const autoListen = (gaps_s: number[]): PromptCacheRequest => ({
  value: 'auto',
  source: 'runner_default',
  by: 'realm listen',
  auto: { basis: 'listen_trigger_gaps', gaps_s },
});
type AnthropicOptions = NonNullable<ConstructorParameters<typeof AnthropicProvider>[1]>;
const anthropic = (promptCache: PromptCacheRequest, over: AnthropicOptions = {}) =>
  new AnthropicProvider('claude-x', { endpoint: 'default', promptCache, ...over });
const ASKING = { cacheDiagnostics: true } as const;
/** An `auto` instance settled `off` (a long gap, no price file). */
const anthropicSettledOff = (over: AnthropicOptions = {}): AnthropicProvider => {
  const provider = anthropic(autoListen([7200]), over);
  provider.settleAutoChoice({ cause: 'no_file' });
  return provider;
};

/** Every `cache_control` in the body, in order. */
function marks(body: Body): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    for (const [k, x] of Object.entries(v)) {
      if (k === 'cache_control') out.push(x);
      else walk(x);
    }
  };
  walk(body);
  return out;
}
/** What a request recorded of its ask. */
const asked = (u: UsageRecord) => ({
  cache_requested: u.cache_requested,
  cache_lifetime_s: u.cache_lifetime_s,
  cache_ttl_sent: u.cache_ttl_sent,
  cache_auto: u.cache_auto,
});
const singleShot = (provider: LlmProvider, cacheChoice?: CallCacheChoice) =>
  provider.callStepWithMeta(PROMPT, SCHEMA, undefined, {
    cachePrefixChars: HEAD.length,
    ...(cacheChoice !== undefined ? { cacheChoice } : {}),
  });
const toolTurns = (provider: ToolCapableLlmProvider, cacheChoice?: CallCacheChoice) =>
  provider.callStepWithTools('prompt', [LOOKUP], EXECUTOR, {
    ...(cacheChoice !== undefined ? { cacheChoice } : {}),
  });

describe('caching 3-M D-1 — Anthropic, a single-shot call that carries its own choice', () => {
  const LIFETIME_1H = { cache_requested: 'lifetime', cache_lifetime_s: 3600, cache_ttl_sent: true };
  const LIFETIME_5M = { cache_requested: 'lifetime', cache_lifetime_s: 300, cache_ttl_sent: false };
  const OFF = { cache_requested: 'off', cache_lifetime_s: undefined, cache_ttl_sent: undefined };

  // Check 1. Real case: a step `auto` chose differently from what the drive's instance settled on.
  // (1) red when the instance's choice is read for the markers (every row), for the record only, or
  // `cache_auto` is taken from the instance. (2) prints the marks and the recorded ask.
  it.each<[string, () => AnthropicProvider, CallCacheChoice, unknown[], object]>([
    [
      'settled short, option long',
      () => anthropic(autoAgent()),
      { choice: 'long', auto: GAPS_900 },
      [LONG, LONG],
      { ...LIFETIME_1H, cache_auto: GAPS_900 },
    ],
    [
      'settled long, option short',
      () => anthropic(autoListen([])),
      { choice: 'short', auto: NO_MEASUREMENT },
      [SHORT, SHORT],
      { ...LIFETIME_5M, cache_auto: NO_MEASUREMENT },
    ],
    [
      'settled short, option off',
      () => anthropic(autoAgent()),
      { choice: 'off', auto: GAPS_900 },
      [],
      { ...OFF, cache_auto: GAPS_900 },
    ],
  ])('%s: the markers and the record follow the option', async (_n, make, call, wire, record) => {
    const r = await singleShot(make(), call);
    expect({ marks: marks(sent[0]!), record: asked(r.usage![0]!) }).toEqual({
      marks: wire,
      record,
    });
  });

  // Check 1. Real case: the instance holds prices from the runner's file, which belong to its own
  // choice. (1) red when the instance's `prices` are kept (the normaliser drops the whole field on
  // the first row; they replace the option's on the second), or the option's are dropped (the second
  // row). (2) prints the recorded `cache_auto`.
  it.each<[string, CacheAuto, 'short' | 'long']>([
    ['no prices of its own', NO_MEASUREMENT, 'short'],
    [
      'its own prices',
      {
        basis: 'listen_trigger_gaps',
        gaps_s: [900],
        prices: { from: 'none', cause: 'input_zero' },
      },
      'long',
    ],
  ])('the record holds the option’s cache_auto: %s', async (_n, auto, choice) => {
    const provider = anthropic(autoListen([420]));
    provider.settleAutoChoice({
      rates: { input: 3, output: 15, cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 },
    });
    const r = await singleShot(provider, { choice, auto });
    expect(r.usage![0]!.cache_auto).toEqual(auto);
  });

  // The source and the runner are the setting's, not the call's. (1) red when the option replaces
  // them. (2) prints both.
  it('the setting’s source and runner stay the instance’s', async () => {
    const r = await singleShot(anthropic(autoListen([])), {
      choice: 'short',
      auto: NO_MEASUREMENT,
    });
    expect({
      source: r.usage![0]!.cache_requested_source,
      by: r.usage![0]!.cache_requested_by,
    }).toEqual({ source: 'runner_default', by: 'realm listen' });
  });

  // Check 2. Real case: a step whose first answer is not JSON is asked again in the same call.
  // (1) red when the retry reads the instance's choice. (2) prints each request's marks and ask.
  it('every request of the call: the JSON retry carries the same markers and record', async () => {
    script = [textAnswer('not json'), textAnswer()];
    const r = await singleShot(anthropic(autoAgent()), { choice: 'long', auto: GAPS_900 });
    expect({
      marks: sent.map(marks),
      records: r.usage!.map(asked),
    }).toEqual({
      marks: [
        [LONG, LONG],
        [LONG, LONG],
      ],
      records: [
        { ...LIFETIME_1H, cache_auto: GAPS_900 },
        { ...LIFETIME_1H, cache_auto: GAPS_900 },
      ],
    });
  });

  // Check 4. Real case: D-2 does not pass the option on every call. (1) red when the option is
  // stored on the instance and left there (the third call). (2) prints each call's marks and ask.
  it('the calls of one drive differ: each sends and records its own, and no option means the instance', async () => {
    const provider = anthropic(autoListen([]));
    const first = await singleShot(provider, { choice: 'long', auto: GAPS_900 });
    const second = await singleShot(provider, { choice: 'short', auto: NO_MEASUREMENT });
    const third = await singleShot(provider);
    expect({
      marks: sent.map(marks),
      lifetimes: [first, second, third].map((r) => r.usage![0]!.cache_lifetime_s),
    }).toEqual({
      marks: [
        [LONG, LONG],
        [SHORT, SHORT],
        [LONG, LONG],
      ],
      lifetimes: [3600, 300, 3600],
    });
  });

  // Check 6. Real case: a gateway refused Realm's cache fields earlier in the drive, so a later
  // step's choice must not put them back. (1) red when the option overrides the drop. (2) prints the
  // marks and the recorded ask.
  it('after a gateway refused the cache fields, a call under its own choice sends none and records no ask', async () => {
    const provider = anthropic(autoListen([]), { endpoint: 'custom' });
    script = [
      httpError(400, 'system.0.cache_control: Extra inputs are not permitted'),
      textAnswer(),
    ];
    await singleShot(provider);
    const r = await singleShot(provider, { choice: 'long', auto: GAPS_900 });
    expect({
      marks: marks(sent[sent.length - 1]!),
      requested: r.usage![0]!.cache_requested,
      rejected: r.usage![0]!.cache_controls_rejected?.dropped,
    }).toEqual({ marks: [], requested: undefined, rejected: ['cache_fields'] });
  });
});

describe('caching 3-M D-1 — Anthropic, a tool call that carries its own choice', () => {
  // Check 3. Real case: a tool step's turns under a choice other than the drive's. (1) red when the
  // tool path reads the instance's choice. (2) prints each request's kind, marks and ask.
  it('every main turn follows the option; the final extraction has no marker and no ask', async () => {
    script = [toolCall(1), toolCall(2), submit()];
    const r = await anthropic(autoListen([])).callStepWithTools('prompt', [LOOKUP], EXECUTOR, {
      inputSchema: SCHEMA,
      maxToolCalls: 2,
      cacheChoice: { choice: 'short', auto: NO_MEASUREMENT },
    });
    expect(
      sent.map((body, i) => ({
        kind: body['tool_choice'] !== undefined ? 'final' : 'main',
        marks: marks(body),
        requested: r.usage![i]!.cache_requested,
        lifetime: r.usage![i]!.cache_lifetime_s,
        ttl: r.usage![i]!.cache_ttl_sent,
        auto: r.usage![i]!.cache_auto,
      })),
    ).toEqual([
      ...[0, 1].map(() => ({
        kind: 'main',
        marks: [SHORT, SHORT],
        requested: 'lifetime',
        lifetime: 300,
        ttl: false,
        auto: NO_MEASUREMENT,
      })),
      {
        kind: 'final',
        marks: [],
        requested: undefined,
        lifetime: undefined,
        ttl: undefined,
        auto: undefined,
      },
    ]);
  });
});

describe('caching 3-M D-1 — whether the request asks Anthropic why it missed follows the call', () => {
  const REFUSED = 'a 400 that says nothing of the question';
  const OPTION_SHORT: CallCacheChoice = { choice: 'short', auto: NO_MEASUREMENT };
  const OPTION_OFF: CallCacheChoice = { choice: 'off', auto: NO_MEASUREMENT };
  type Run = (p: AnthropicProvider, call?: CallCacheChoice) => Promise<{ usage?: UsageRecord[] }>;
  const SINGLE: Run = (p, call) => singleShot(p, call);
  const TOOLS: Run = (p, call) => toolTurns(p, call);
  const PATHS: Array<[string, Run]> = [
    ['single-shot', SINGLE],
    ['tool turns', TOOLS],
  ];
  const question = (i: number): unknown =>
    'diagnostics' in sent[i]! ? sent[i]!['diagnostics'] : 'none';

  // Row 1. Real case: a step `auto` chose `off` asks to cache nothing, so it leaves no fingerprint.
  // (1) red when `asksWhy` reads the instance. (2) prints the question and the record.
  it('1 settled short, option off: no question', async () => {
    const r = await singleShot(anthropic(autoAgent(), ASKING), OPTION_OFF);
    expect({ question: question(0), facts: r.usage![0]!.cache_diagnostics }).toEqual({
      question: 'none',
      facts: undefined,
    });
  });

  // Row 2. Real case: the drive settled `off`, but this step's rhythm is worth caching. (1) red when
  // `asksWhy` reads the instance. (2) prints the question.
  it.each(PATHS)('2 settled off, option short (%s): the question goes out', async (_n, run) => {
    await run(anthropicSettledOff(ASKING), OPTION_SHORT);
    expect(question(0)).toEqual({ previous_message_id: null });
  });

  // Row 3. Real case: a gateway address, which may not accept the field. (1) red when the option
  // replaces the `asking` test. (2) prints the question.
  it.each(PATHS)('3 a custom address, option short (%s): no question', async (_n, run) => {
    await run(anthropic(autoAgent(), { ...ASKING, endpoint: 'custom' }), OPTION_SHORT);
    expect(question(0)).toBe('none');
  });

  // Row 4. Real case: an account that may not ask; the drive stopped asking in an earlier call.
  // (1) red when the option replaces the `asking` test. (2) prints the question and the record.
  it.each(PATHS)(
    '4 a refusal in an earlier call, option short (%s): no question, recorded as refused',
    async (_n, run) => {
      const provider = anthropic(autoAgent(), ASKING);
      script = [httpError(400, REFUSED), textAnswer()];
      await run(provider, OPTION_SHORT);
      const r = await run(provider, OPTION_SHORT);
      expect({
        question: question(sent.length - 1),
        facts: r.usage![0]!.cache_diagnostics,
      }).toEqual({ question: 'none', facts: { asked: false, cause: 'rejected' } });
    },
  );

  // Row 5. Real case: step A asked and Anthropic refused; step B's choice is `off`, so it never would
  // have asked and must not say it was refused. (1) red when B3a's helper reads the memory alone.
  // (2) prints the question and the record.
  it('5 a refusal in an earlier call, option off: no question and nothing on the record', async () => {
    const provider = anthropic(autoAgent(), ASKING);
    script = [httpError(400, REFUSED), textAnswer()];
    await singleShot(provider, OPTION_SHORT);
    const r = await singleShot(provider, OPTION_OFF);
    expect({
      question: question(sent.length - 1),
      facts: r.usage![0]!.cache_diagnostics,
    }).toEqual({ question: 'none', facts: undefined });
  });

  // Row 6. Real case: a drive settled `off`, where one step under its own choice was refused; a
  // later step with no option never would have asked. (1) red when the helper's test reads the
  // option alone. (2) prints the record.
  it('6 settled off, a refusal under option short, then no option: nothing on the record', async () => {
    const provider = anthropicSettledOff(ASKING);
    script = [httpError(400, REFUSED), textAnswer()];
    await singleShot(provider, OPTION_SHORT);
    const r = await singleShot(provider);
    expect(r.usage![0]!.cache_diagnostics).toBeUndefined();
  });
});

describe('caching 3-M D-1 — OpenAI', () => {
  const LUNA = 'gpt-5.6-luna';
  const OLD = 'gpt-5.5';
  const openai = (model: string, promptCache: PromptCacheRequest) =>
    new OpenAIProvider(model, undefined, false, { endpoint: 'default', promptCache });
  const openaiSettledOff = (): OpenAIProvider => {
    const provider = openai(LUNA, autoListen([7200]));
    provider.settleAutoChoice({ cause: 'no_file' });
    return provider;
  };
  const PLAIN = (p: OpenAIProvider, cacheChoice: CallCacheChoice) =>
    p.callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
      cacheChoice,
    });
  const STRICT = (p: OpenAIProvider, cacheChoice: CallCacheChoice) =>
    p.callStepWithMeta(PROMPT, SCHEMA, undefined, {
      structuredOutputStrict: true,
      cachePrefixChars: HEAD.length,
      cacheChoice,
    });
  const PATHS = [
    ['the plain path', PLAIN],
    ['the strict path', STRICT],
  ] as const;
  const view = (body: Body) => ({
    options: body['prompt_cache_options'],
    key: 'prompt_cache_key' in body,
    marked: Array.isArray((body['messages'] as Array<{ content: unknown }>)[0]!.content),
  });

  // Check 7. Real case: a step `auto` chose `off`, on a drive settled at 30 minutes. (1) red when `off`
  // is read from the instance on that path. (2) prints the body's cache fields and the ask.
  it.each(PATHS)(
    '%s: settled at 30 minutes, option off: nothing asked, no key',
    async (_n, run) => {
      const r = await run(openai(LUNA, autoAgent()), { choice: 'off', auto: GAPS_900 });
      expect({ body: view(sent[0]!), record: asked(r.usage![0]!) }).toEqual({
        body: { options: { mode: 'explicit' }, key: false, marked: false },
        record: {
          cache_requested: 'off',
          cache_lifetime_s: undefined,
          cache_ttl_sent: undefined,
          cache_auto: GAPS_900,
        },
      });
    },
  );

  // Check 7. Real case: the drive settled `off`, and this step's rhythm is worth caching. (1) red when
  // `off` is read from the instance on that path. (2) prints the body's cache fields and the ask.
  it.each(PATHS)('%s: settled off, option long: its one lifetime and the key', async (_n, run) => {
    const r = await run(openaiSettledOff(), { choice: 'long', auto: GAPS_900 });
    expect({ body: view(sent[0]!), record: asked(r.usage![0]!) }).toEqual({
      body: { options: { mode: 'explicit', ttl: '30m' }, key: true, marked: true },
      record: {
        cache_requested: 'lifetime',
        cache_lifetime_s: 1800,
        cache_ttl_sent: true,
        cache_auto: GAPS_900,
      },
    });
  });

  /** A record without what differs between any two calls. */
  const stable = (u: UsageRecord) => {
    const { request_start: _start, ...rest } = u;
    return rest;
  };
  const OFF: CallCacheChoice = { choice: 'off', auto: GAPS_900 };

  // Check 8. Real case: a provider or path the choice does not apply to sends what it always sent.
  // (1) red when the option is read there. (2) prints the two bodies and records that differ.
  it.each<[string, (call?: CallCacheChoice) => Promise<{ usage?: UsageRecord[] }>]>([
    [
      'OpenAI outside the explicit set',
      (call) => {
        const provider: LlmProvider = openai(OLD, autoAgent());
        return singleShot(provider, call);
      },
    ],
    [
      'an OpenAI tool call',
      (call) => {
        const provider: ToolCapableLlmProvider = openai(LUNA, autoAgent());
        return provider.callStepWithTools(PROMPT, [LOOKUP], EXECUTOR, {
          cachePrefixChars: HEAD.length,
          ...(call !== undefined ? { cacheChoice: call } : {}),
        });
      },
    ],
  ])('%s ignores it: the same body and record as with no option', async (_n, run) => {
    const without = await run();
    const withOption = await run(OFF);
    expect({ body: sent[1], record: stable(withOption.usage![0]!) }).toEqual({
      body: sent[0],
      record: stable(without.usage![0]!),
    });
  });
});
