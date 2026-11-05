// gateway-rule-3b.test.ts — caching 3-B, Part E (E2, E3, E5; owner, 2026-11-03: "Claude Code's way,
// on gateways only"): on a custom endpoint, a 400 that names a cache field Realm added drops that
// field, retries once, and — once that worked — the drive sends no cache fields again and says so on
// every record. Each error below is a constructed body in the shape the SDKs throw (`status`,
// `message`, and OpenAI's `param`/`code`; `@anthropic-ai/sdk` and `openai` APIError), with the gateway
// wording from lane HB7 (HB7-02…10). A failing cell prints the message and the verdict, or the bodies'
// cache fields and the recorded refusal. Each cell names (a) the change that turns it red.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheFieldRefusal } from './agent-utils.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIProvider } from './openai-provider.js';

const err400 = (message: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(message), { status: 400, ...extra });

describe('caching 3-B E2 — the decider, one cell per message form', () => {
  const verdict = (e: unknown) => cacheFieldRefusal(e, 'custom') ?? 'falls through';
  it('Anthropic forms that refuse cache_control match', () => {
    const forms = [
      'capability_rejected: cache_control_field',
      'system.0.cache_control: Extra inputs are not permitted',
      'messages.0.content.0.cache_control: Extra inputs are not permitted',
      '2 validation errors for MessagesRequest\nsystem.0.cache_control\n  Extra inputs are not permitted\nmessages.0.content.0.cache_control\n  Extra inputs are not permitted',
      'system.0.cache_control.ttl: Extra inputs are not permitted',
      'messages.2.content.0.tool_result.cache_control: Extra inputs are not permitted',
      'Invalid JSON payload received. Unknown name "cache_control" at \'system[0]\': Cannot find field.',
      'Malformed input request: extraneous key [cache_control] is not permitted',
      // Constructed (red-first): each phrase with a form that only it matches, so removing any one
      // phrase turns this cell red; the forms above carry `not permitted` and `extra inputs` together.
      'system.0.cache_control: extra inputs are forbidden',
      'messages.0.content.0: Unrecognized field "cache_control"',
      'system.0: unrecognised property cache_control',
      '/system/0 must NOT have additional properties (cache_control)',
      'cache_control cannot be set on system. It will be ignored.',
    ];
    // (a) red when any one phrase, or the token, is removed: each has a form only it matches;
    //     (b) prints each message beside its verdict.
    expect(forms.map((m) => [m, verdict(err400(m))])).toEqual(
      forms.map((m) => [m, ['cache_control']]),
    );
  });

  it('Realm’s own faults fall through', () => {
    // Each form carries a refusal phrase, so only its own exclusion keeps it from matching; the
    // marker-count message as Anthropic sends it has no phrase and falls through either way.
    const forms = [
      'messages.0.content.0.text: cache_control cannot be set for empty text blocks',
      'system.0.text: cache_control cannot be set: non-whitespace text required',
      'A maximum of 4 blocks with cache_control may be provided. Found 5.',
      'A maximum of 4 blocks with cache_control may be provided; a fifth is not permitted.',
    ];
    // (a) red when any one exclusion is removed (Realm's own fault would drop the markers);
    //     (b) prints each message beside its verdict.
    expect(forms.map((m) => [m, verdict(err400(m))])).toEqual(
      forms.map((m) => [m, 'falls through']),
    );
  });

  it('OpenAI forms that refuse prompt_cache_key match', () => {
    const forms: Array<[string, Error]> = [
      ['param', err400('Unrecognized request argument supplied', { param: 'prompt_cache_key' })],
      [
        'vLLM body.<path>',
        err400('Extra inputs are not permitted', { param: 'body.prompt_cache_key' }),
      ],
      [
        'Azure code',
        err400('Unrecognized request argument supplied: prompt_cache_key', {
          param: null,
          code: 'unrecognized_request_argument',
        }),
      ],
      [
        'Azure code alone (constructed: no phrase in the message)',
        err400('Invalid request argument supplied: prompt_cache_key', {
          param: null,
          code: 'unrecognized_request_argument',
        }),
      ],
      [
        'DeepSeek',
        err400(
          'Failed to deserialize the JSON body into the target type: unknown field "prompt_cache_key"',
        ),
      ],
      [
        'pydantic',
        err400(
          "[{'type': 'extra_forbidden', 'loc': ('body', 'prompt_cache_key'), 'msg': 'Extra inputs are not permitted'}]",
        ),
      ],
    ];
    // (a) red when the `.prompt_cache_key` suffix rule, the code rule or a phrase is removed;
    //     (b) prints each form beside its verdict.
    expect(forms.map(([n, e]) => [n, verdict(e)])).toEqual(
      forms.map(([n]) => [n, ['prompt_cache_key']]),
    );
  });

  it('another 400 falls through verbatim, and nothing matches on a provider’s own endpoint', () => {
    // (a) red when the decider matches any 400, or reads the default endpoint; (b) prints both.
    expect({
      temperature: verdict(err400("Unsupported value: 'temperature'", { param: 'temperature' })),
      ownEndpoint:
        cacheFieldRefusal(
          err400('system.0.cache_control: Extra inputs are not permitted'),
          'default',
        ) ?? 'falls through',
      notA400:
        cacheFieldRefusal(
          Object.assign(new Error('system.0.cache_control: Extra inputs are not permitted'), {
            status: 422,
          }),
          'custom',
        ) ?? 'falls through',
    }).toEqual({
      temperature: 'falls through',
      ownEndpoint: 'falls through',
      notA400: 'falls through',
    });
  });
});

// ── The ladder, through the providers ────────────────────────────────────────────────────────────

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
let sent: Body[] = [];
let script: Array<unknown> = [];
const anthropicAnswer = (text: string) => ({
  model: 'claude-test-1',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 1,
  },
});
const openaiAnswer = (content: string) => ({
  model: 'gpt-test-1',
  choices: [{ message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 10, completion_tokens: 1 },
});
beforeEach(() => {
  for (const [create, fallback] of [
    [anthropicCreate, anthropicAnswer('{"x":"a"}')],
    [openaiCreate, openaiAnswer('{"x":"a"}')],
  ] as const) {
    create.mockReset();
    create.mockImplementation(async (body: Body) => {
      sent.push(structuredClone(body));
      const next = script.length > 0 ? script.shift() : fallback;
      if (next instanceof Error) throw next;
      return next;
    });
  }
  sent = [];
  script = [];
});

const HEAD = 'You classify support tickets.\nTicket: ';
const PROMPT = `${HEAD}FAKE-TICKET-5`;
const SCHEMA = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] };
const REFUSAL = 'system.0.cache_control: Extra inputs are not permitted';
const marked = (b: Body) => JSON.stringify(b).includes('cache_control');
const strictOf = (b: Body) =>
  (b['tools'] as Array<{ strict?: boolean }> | undefined)?.[0]?.strict === true;
const anthropic = (endpoint: 'default' | 'custom') =>
  new AnthropicProvider('claude-x', {
    promptCache: { value: 'short', source: 'stated', by: 'realm agent' },
    endpoint,
  });

describe('caching 3-B E3 — the ladder’s paths', () => {
  it('a match: retried once without the markers; the record says so; the drive remembers', async () => {
    const p = anthropic('custom');
    script = [err400(REFUSAL), anthropicAnswer('{"x":"a"}')];
    const first = await p.callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    const second = await p.callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    // (a) red when the retry keeps the markers, the record is not written, or the memory is not
    //     kept (the drive cell: the next request would carry markers again); (b) prints them.
    expect({
      marked: sent.map(marked),
      first: first.usage!.map((r) => [r.cache_controls_rejected, r.cache_marked, r.prefix_chars]),
      second: second.usage!.map((r) => [r.cache_controls_rejected?.proven, r.cache_marked]),
    }).toEqual({
      marked: [true, false, false],
      first: [
        [
          {
            status: 400,
            dropped: ['cache_fields'],
            proven: 'cache_fields',
            fields: ['cache_control'],
          },
          undefined,
          HEAD.length,
        ],
      ],
      second: [['cache_fields', undefined]],
    });
  });

  it('on a provider’s own endpoint nothing changes: the 400 surfaces as before', async () => {
    script = [err400(REFUSAL)];
    // (a) red when the rule runs on Anthropic's own endpoint; (b) prints the error and the count.
    await expect(
      anthropic('default').callStepWithMeta(PROMPT, undefined, undefined, {
        cachePrefixChars: HEAD.length,
      }),
    ).rejects.toThrow(REFUSAL);
    expect(sent).toHaveLength(1);
  });

  it('a match whose retry fails: nothing recorded or remembered, the retry’s error propagates', async () => {
    const p = anthropic('custom');
    script = [err400(REFUSAL), Object.assign(new Error('connection reset'), { status: 502 })];
    await expect(
      p.callStepWithMeta(PROMPT, undefined, undefined, { cachePrefixChars: HEAD.length }),
    ).rejects.toThrow('connection reset');
    // The next request of the drive still carries the markers: nothing was remembered.
    const next = await p.callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    // (a) red when the drop is recorded or remembered before the retry worked; (b) prints them.
    expect({ marked: sent.map(marked), rejected: next.usage![0]!.cache_controls_rejected }).toEqual(
      {
        marked: [true, false, true],
        rejected: undefined,
      },
    );
  });

  it('a strict turn whose 400 names the cache field: strict kept, the markers dropped', async () => {
    script = [err400(REFUSAL), anthropicAnswer('{"x":"a"}')];
    const r = await anthropic('custom').callStepWithMeta(PROMPT, SCHEMA, undefined, {
      structuredOutputStrict: true,
      cachePrefixChars: HEAD.length,
    });
    // (a) red when the cache decider runs after #311 (strict would be dropped); (b) prints them.
    expect({
      strict: sent.map(strictOf),
      marked: sent.map(marked),
      meta: r.meta?.sent,
      proven: r.usage![0]!.cache_controls_rejected?.proven,
    }).toEqual({ strict: [true, true], marked: [true, false], meta: true, proven: 'cache_fields' });
  });

  it('a strict turn whose cache retry answers 400: #311 runs on it, then proven none', async () => {
    script = [
      err400(REFUSAL),
      err400('tools.0.input_schema: strict mode does not support this schema'),
      anthropicAnswer('{"x":"a"}'),
    ];
    const r = await anthropic('custom').callStepWithMeta(PROMPT, SCHEMA, undefined, {
      structuredOutputStrict: true,
      cachePrefixChars: HEAD.length,
    });
    // (a) red when #311 does not run on the retry's answer, or the drop is recorded as proven by
    //     the cache fields alone; (b) prints the three bodies' flags and the record.
    expect({
      strict: sent.map(strictOf),
      marked: sent.map(marked),
      downgrade: r.meta?.downgrade_reason,
      proven: r.usage![0]!.cache_controls_rejected?.proven,
    }).toEqual({
      strict: [true, true, false],
      marked: [true, false, false],
      downgrade: 'api_rejected_schema',
      proven: 'none',
    });
  });

  it('a strict turn whose 400 names nothing: #311 unchanged (strict dropped, the markers kept)', async () => {
    script = [
      err400('tools.0.input_schema: strict mode does not support this schema'),
      anthropicAnswer('{"x":"a"}'),
    ];
    const r = await anthropic('custom').callStepWithMeta(PROMPT, SCHEMA, undefined, {
      structuredOutputStrict: true,
      cachePrefixChars: HEAD.length,
    });
    // (a) red when the decider takes a 400 that names no cache field; (b) prints them.
    expect({
      strict: sent.map(strictOf),
      marked: sent.map(marked),
      rejected: r.usage![0]!.cache_controls_rejected,
    }).toEqual({ strict: [true, false], marked: [true, true], rejected: undefined });
  });

  it('OpenAI on a custom endpoint: a 400 naming prompt_cache_key drops the key, and the drive remembers', async () => {
    const p = new OpenAIProvider('gpt-x', 'https://gateway.example.test/v1', false, {
      endpoint: 'custom',
      promptCache: { value: 'short', source: 'stated', by: 'realm agent' },
    });
    script = [
      err400('Extra inputs are not permitted', { param: 'body.prompt_cache_key' }),
      openaiAnswer('{"x":"a"}'),
    ];
    const first = await p.callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    const second = await p.callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    // (a) red when the key is not dropped, or not remembered; (b) prints the keys and the records.
    expect({
      keys: sent.map((b) => typeof b['prompt_cache_key']),
      first: first.usage!.map((r) => [r.cache_controls_rejected?.fields, r.cache_key_sent]),
      second: second.usage!.map((r) => r.cache_controls_rejected?.proven),
    }).toEqual({
      keys: ['string', 'undefined', 'undefined'],
      first: [[['prompt_cache_key'], undefined]],
      second: ['cache_fields'],
    });
  });

  it('Anthropic’s tool loop: a main turn refused for its markers is retried without them, and recorded', async () => {
    const tool = {
      id: 'srv:t',
      serverId: 'srv',
      name: 't',
      description: 'A tool',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    };
    script = [
      err400('messages.0.content.0.cache_control: Extra inputs are not permitted'),
      anthropicAnswer('{"x":"a"}'),
    ];
    const r = await anthropic('custom').callStepWithTools(
      PROMPT,
      [tool],
      (async () => ({ content: [{ type: 'text', text: 'ok' }] })) as never,
      {},
    );
    // (a) red when the tool loop's main turn is not under the rule; (b) prints the flags and record.
    expect({
      marked: sent.map(marked),
      proven: r.usage?.[0]?.cache_controls_rejected?.proven,
    }).toEqual({
      marked: [true, false],
      proven: 'cache_fields',
    });
  });
});

describe('caching 3-B E3 (MA2-3B-IA1-12) — a request sent without the cache fields records no ask', () => {
  /** The ask facts a request records: #899's omission set when it carried no cache field. */
  const askOf = (r: Record<string, unknown>) => ({
    requested: r['cache_requested'],
    lifetime: r['cache_lifetime_s'],
    ttlSent: r['cache_ttl_sent'],
    source: r['cache_requested_source'],
    by: r['cache_requested_by'],
    auto: r['cache_auto'],
  });
  const NO_ASK = {
    requested: undefined,
    lifetime: undefined,
    ttlSent: undefined,
    source: undefined,
    by: undefined,
    auto: undefined,
  };
  const ASKED = {
    requested: 'lifetime',
    lifetime: 300,
    ttlSent: false,
    source: 'stated',
    by: 'realm agent',
    auto: undefined,
  };

  it('single-shot: a gateway that refuses cache_control — the retry and the next request record no ask; with no refusal, the ask', async () => {
    const p = anthropic('custom');
    script = [err400(REFUSAL), anthropicAnswer('{"x":"a"}')];
    const first = await p.callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    const second = await p.callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    const control = await anthropic('custom').callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    const rec = (r: typeof first) => r.usage![0]! as unknown as Record<string, unknown>;
    // (a) red when a request sent without the cache fields records the drive's ask (it would say a
    //     lifetime was sent that was not), or the split facts and the refusal go with it; (b)
    //     prints each record's ask facts, its head length and its refusal.
    expect({
      first: [
        askOf(rec(first)),
        rec(first)['prefix_chars'],
        rec(first)['cache_controls_rejected'] !== undefined,
      ],
      second: [
        askOf(rec(second)),
        rec(second)['prefix_chars'],
        rec(second)['cache_controls_rejected'] !== undefined,
      ],
      control: [askOf(rec(control)), rec(control)['cache_controls_rejected']],
    }).toEqual({
      first: [NO_ASK, HEAD.length, true],
      second: [NO_ASK, HEAD.length, true],
      control: [ASKED, undefined],
    });
  });

  it('the tool step: a gateway that refuses cache_control on a later turn’s tool_result — the turn before keeps its ask, the refused turn records none', async () => {
    const tool = {
      id: 'srv:t',
      serverId: 'srv',
      name: 't',
      description: 'A tool',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    };
    script = [
      {
        model: 'claude-test-1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 't', input: {} }],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 1,
        },
      },
      err400('messages.2.content.0.tool_result.cache_control: Extra inputs are not permitted'),
      anthropicAnswer('{"x":"a"}'),
    ];
    const r = await anthropic('custom').callStepWithTools(
      PROMPT,
      [tool],
      (async () => ({ content: [{ type: 'text', text: 'ok' }] })) as never,
      {},
    );
    const records = r.usage!.map((u) => u as unknown as Record<string, unknown>);
    // (a) red when the refused turn's retry records the ask, or the turn before loses its own; (b)
    //     prints each turn's markers, ask and refusal.
    expect({
      marked: sent.map(marked),
      asks: records.map(askOf),
      refused: records.map((u) => u['cache_controls_rejected'] !== undefined),
    }).toEqual({
      marked: [true, true, false],
      asks: [ASKED, NO_ASK],
      refused: [false, true],
    });
  });
});
