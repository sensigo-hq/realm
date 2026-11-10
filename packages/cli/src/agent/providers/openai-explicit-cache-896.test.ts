// openai-explicit-cache-896.test.ts — #896 unit A: OpenAI's explicit cache controls on GPT-5.6 and
// later at OpenAI's own address. Every body is captured at the HTTP request the SDK sends: the global
// `fetch` is stubbed and the `openai` package is the real one, so a field the SDK drops is caught.
// Fakes copy captured shapes: a success's usage `details` from
// plans/issue-896/live-checks/results-gpt-5.6-luna.json (`cached_tokens`, `cache_write_tokens`,
// `audio_tokens`), a refused field's 400 from results-gpt-5.5.json (`{message, param, code:
// 'invalid_parameter'}`); the rest of a chat completion follows the openai SDK's `ChatCompletion`
// type (openai 6.48.0, `resources/chat/completions`). Each assertion names (a) the break that turns it
// red and (b) what it prints: the bodies' cache fields and the record's ask (fake prompts; the API
// key is a fake and never printed).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheAuto, RunRecord, UsageRecord } from '@sensigo/realm';
import { OpenAIProvider } from './openai-provider.js';
import type { PromptCacheRequest } from './llm-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';
import { promptCacheStartLine, type ResolvedPromptCache } from '../prompt-cache.js';
import { listenCachingFacts } from '../../commands/listen.js';
import { inspectRun } from '../../commands/inspect.js';
import { listing, snap } from '../../test-support/snapshot-double.js';

type Body = Record<string, unknown>;
type Message = { role: string; content: unknown };
let sent: Body[] = [];
let script: Array<{ status: number; json: unknown }> = [];

/** A success's usage, as gpt-5.6-luna answered C1's first run (results-gpt-5.6-luna.json). */
const LUNA_USAGE = {
  prompt_tokens: 4015,
  completion_tokens: 6,
  total_tokens: 4021,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 3930, audio_tokens: 0 },
};
const reply = (content: string | null, extra: Record<string, unknown> = {}) => ({
  status: 200,
  json: {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-5.6-luna',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, refusal: null, ...extra },
        finish_reason: extra['tool_calls'] !== undefined ? 'tool_calls' : 'stop',
        logprobs: null,
      },
    ],
    usage: LUNA_USAGE,
  },
});
const answer = (json = '{"queue":"billing"}') => reply(json);
const toolCall = () =>
  reply(null, {
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 't', arguments: '{}' } }],
  });
/** gpt-5.5's 400 for a mark it cannot take (results-gpt-5.5.json, C8 `breakpoint_only`). */
const REFUSED_MARK = {
  status: 400,
  json: {
    error: {
      message: 'prompt_cache_breakpoint is not supported on this model',
      param: 'prompt_cache_breakpoint',
      code: 'invalid_parameter',
    },
  },
};
const REFUSED_SCHEMA = {
  status: 400,
  json: {
    error: {
      message: "Invalid schema for response_format 'realm_step_output'",
      param: 'response_format',
      code: 'invalid_value',
    },
  },
};

beforeEach(() => {
  sent = [];
  script = [];
  vi.stubEnv('OPENAI_API_KEY', 'sk-fake-not-a-key');
  vi.stubEnv('OPENAI_BASE_URL', '');
  delete process.env['OPENAI_BASE_URL'];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      sent.push(JSON.parse(String(init?.body)) as Body);
      const next = script.shift() ?? answer();
      return new Response(JSON.stringify(next.json), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const sha256 = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const HEAD = 'You sort support tickets for a small shop. Pick exactly one queue.\nTicket: ';
const TAIL = 'FAKE-TICKET-1: my parcel never came';
const PROMPT = `${HEAD}${TAIL}`;
const SCHEMA = { type: 'object', properties: { queue: { type: 'string' } }, required: ['queue'] };
const MARK = { mode: 'explicit' };
const setting = (
  value: PromptCacheRequest['value'],
  source: PromptCacheRequest['source'] = 'stated',
  by: 'realm agent' | 'realm listen' = 'realm agent',
): PromptCacheRequest & ResolvedPromptCache => ({ value, source, by });
const RUNNER_DEFAULT = setting('auto', 'runner_default');
const openai = (model: string, promptCache?: PromptCacheRequest, baseUrl?: string) =>
  new OpenAIProvider(model, baseUrl, false, {
    endpoint: baseUrl === undefined ? 'default' : 'custom',
    ...(promptCache !== undefined ? { promptCache } : {}),
  });
const messages = (b: Body): Message[] => b['messages'] as Message[];
/** A body's cache fields, in a form that prints short: the options, each message's shape, the key. */
const cacheView = (b: Body) => ({
  options: b['prompt_cache_options'],
  system: shape(messages(b)[0]!.content),
  user: shape(messages(b)[1]!.content),
  key: typeof b['prompt_cache_key'] === 'string' ? (b['prompt_cache_key'] as string) : undefined,
});
function shape(content: unknown): unknown {
  if (typeof content === 'string') return 'plain';
  return (content as Array<{ text: string; prompt_cache_breakpoint?: unknown }>).map((p) => ({
    chars: p.text.length,
    marked: p.prompt_cache_breakpoint !== undefined,
    ...(p.prompt_cache_breakpoint !== undefined ? { mark: p.prompt_cache_breakpoint } : {}),
  }));
}
const ASK = [
  'cache_requested',
  'cache_lifetime_s',
  'cache_ttl_sent',
  'cache_requested_source',
  'cache_requested_by',
  'cache_auto',
  'cache_marked',
] as const;
const askOf = (r: UsageRecord) =>
  Object.fromEntries(ASK.map((k) => [k, (r as unknown as Record<string, unknown>)[k]]));
const SYSTEM_MARKED = [{ chars: expect.any(Number), marked: true, mark: MARK }];
const tool: ToolDefinition = {
  id: 'srv:t',
  serverId: 'srv',
  name: 't',
  description: 'A tool',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
};
const EXECUTOR = (async () => ({ content: [{ type: 'text', text: 'ok' }] })) as never;

/** `realm run inspect`'s step cache line for one step whose requests are these records. */
async function inspectLine(requests: UsageRecord[]): Promise<string> {
  const run = {
    id: 'run_896',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: ['classify'],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'completed',
    version: 1,
    params: {},
    evidence: [
      {
        step_id: 'classify',
        status: 'success',
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        duration_ms: 1000,
        input_summary: {},
        output_summary: {},
        evidence_hash: 'h',
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: {
            state: 'engaged',
            basis: 'provider_reported',
            requests: requests.map((r) => ({ provider: 'openai', ...r })),
          },
        },
      },
    ],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: true,
  } as unknown as RunRecord;
  const workflowStore = {
    get: async () => {
      throw new Error('not registered');
    },
    register: async () => {},
    list: async () => [],
  } as never;
  const out = await inspectRun(
    'run_896',
    { get: async () => snap(run), list: async () => listing([run]) } as never,
    workflowStore,
  );
  return out.split('\n').find((l) => l.includes('cache:')) ?? '(no cache line)';
}

describe('#896 check 1 — a single-shot step on gpt-5.6-luna, the default setting', () => {
  it('the options, the marked system part, the marked head and the plain tail, and the key; the record and inspect read the 30-minute ask', async () => {
    const r = await openai('gpt-5.6-luna', RUNNER_DEFAULT).callStepWithMeta(
      PROMPT,
      SCHEMA,
      undefined,
      { cachePrefixChars: HEAD.length },
    );
    // (a) red when the model rule admits no model (the body goes out as on the base); (b) prints
    //     the body's cache fields.
    expect(cacheView(sent[0]!)).toEqual({
      options: { mode: 'explicit', ttl: '30m' },
      system: SYSTEM_MARKED,
      user: [
        { chars: HEAD.length, marked: true, mark: MARK },
        { chars: TAIL.length, marked: false },
      ],
      key: sha256(HEAD),
    });
    // The parts carry the exact texts: the head, then the tail.
    expect((messages(sent[0]!)[1]!.content as Array<{ text: string }>).map((p) => p.text)).toEqual([
      HEAD,
      TAIL,
    ]);
    // (a) red when the request records the base's `provider_rules` (no ask); (b) prints the ask.
    // #896 unit B: `auto` records its basis, as Anthropic's does (no `auto` given: no measurement).
    expect(askOf(r.usage![0]!)).toEqual({
      cache_requested: 'lifetime',
      cache_lifetime_s: 1800,
      cache_ttl_sent: true,
      cache_requested_source: 'runner_default',
      cache_requested_by: 'realm agent',
      cache_auto: { basis: 'no_measurement' },
      cache_marked: ['system', 'prompt', 'key'],
    });
    const line = await inspectLine(r.usage!);
    // (a) red when inspect reads another ask or no marked head; (b) prints the line.
    expect(
      [
        line.includes('asked for 30 minutes (sent as 30 minutes;'),
        line.includes(`cached head: ${HEAD.length} characters (marked: system, prompt, key)`),
      ],
      line,
    ).toEqual([true, true]);
  });
});

describe('#896 check 2 — outside the set the step is as on the base', () => {
  it.each(['gpt-5.5', 'o4-mini'])(
    '%s: plain strings and the key, the record provider_rules',
    async (model) => {
      const r = await openai(model, RUNNER_DEFAULT).callStepWithMeta(PROMPT, SCHEMA, undefined, {
        cachePrefixChars: HEAD.length,
      });
      // (a) red when the rule admits every `gpt-5.x` (gpt-5.5) or any model (o4-mini); (b) prints
      //     the body's cache fields and the record's ask.
      expect({ body: cacheView(sent[0]!), ask: askOf(r.usage![0]!) }).toEqual({
        body: { options: undefined, system: 'plain', user: 'plain', key: sha256(HEAD) },
        ask: {
          cache_requested: 'provider_rules',
          cache_lifetime_s: undefined,
          cache_ttl_sent: undefined,
          cache_requested_source: undefined,
          cache_requested_by: undefined,
          cache_auto: undefined,
          cache_marked: ['key'],
        },
      });
    },
  );
});

describe('#896 check 3 — the set’s edges', () => {
  // Each name: (a) red under the break beside it; (b) prints whether the options went out.
  it.each([
    ['gpt-5.6', true, 'the 5.6+ clause removed'],
    ['gpt-6.1-terra', true, 'the major ≥ 6 clause removed'],
    ['GPT-5.6-LUNA', true, 'the name compared with case'],
    ['ft:gpt-5.6-luna:org::x', true, 'the ft: base clause removed'],
    ['gpt-5', false, 'the .minor made optional'],
    ['gpt-5.5-mini', false, 'minor ≥ 5'],
    ['ft:gpt-4o:org::x', false, 'any ft: admitted'],
  ] as const)('%s → %s (break: %s)', async (model, admitted, breakName) => {
    await openai(model, RUNNER_DEFAULT).callStepWithMeta(PROMPT, SCHEMA, undefined, {
      cachePrefixChars: HEAD.length,
    });
    expect('prompt_cache_options' in sent[0]!, `${model} (break: ${breakName})`).toBe(admitted);
  });
});

describe('#896 check 4 — gpt-5.6-luna through --base-url, `long` stated', () => {
  it('no options, no marks; 3-B’s key only', async () => {
    await openai(
      'gpt-5.6-luna',
      setting('long'),
      'https://gateway.example.test/v1',
    ).callStepWithMeta(PROMPT, SCHEMA, undefined, { cachePrefixChars: HEAD.length });
    // (a) red when the rule ignores the address; (b) prints the body's cache fields.
    expect(cacheView(sent[0]!)).toEqual({
      options: undefined,
      system: 'plain',
      user: 'plain',
      key: sha256(HEAD),
    });
  });
});

describe('#896 check 5 — `off` really stops caching', () => {
  it('a single-shot step: explicit mode, no mark, no key; the record says off', async () => {
    const r = await openai('gpt-5.6-luna', setting('off')).callStepWithMeta(
      PROMPT,
      SCHEMA,
      undefined,
      { cachePrefixChars: HEAD.length },
    );
    // (a) red when `off` sends no options (the base); (b) prints the body's cache fields and the ask.
    expect({ body: cacheView(sent[0]!), ask: askOf(r.usage![0]!) }).toEqual({
      body: { options: { mode: 'explicit' }, system: 'plain', user: 'plain', key: undefined },
      ask: {
        cache_requested: 'off',
        cache_lifetime_s: undefined,
        cache_ttl_sent: undefined,
        cache_requested_source: 'stated',
        cache_requested_by: 'realm agent',
        cache_auto: undefined,
        cache_marked: undefined,
      },
    });
  });

  it('a tool step: every request, the last one after the tool calls run out included', async () => {
    script = [toolCall(), answer()];
    const r = await openai('gpt-5.6-luna', setting('off')).callStepWithTools(
      PROMPT,
      [tool],
      EXECUTOR,
      { maxToolCalls: 1, cachePrefixChars: HEAD.length },
    );
    // (a) red when `off` sends no options on a tool step, or the final request goes without; (b)
    //     prints each request's options, whether it offered tools, and its ask.
    expect({
      requests: sent.map((b) => [b['prompt_cache_options'], 'tools' in b, b['prompt_cache_key']]),
      asks: r.usage!.map((u) => u.cache_requested),
    }).toEqual({
      requests: [
        [{ mode: 'explicit' }, true, undefined],
        [{ mode: 'explicit' }, false, undefined],
      ],
      asks: ['off', 'off'],
    });
  });
});

describe('#896 check 6 — a tool step under `long`', () => {
  it('every turn as on the base: no options, no marks, the key; the record provider_rules', async () => {
    script = [toolCall(), answer()];
    const r = await openai('gpt-5.6-luna', setting('long')).callStepWithTools(
      PROMPT,
      [tool],
      EXECUTOR,
      { cachePrefixChars: HEAD.length },
    );
    // (a) red when marks or options go on a tool turn; (b) prints each turn's cache fields and ask.
    expect({
      turns: sent.map((b) => [
        b['prompt_cache_options'],
        JSON.stringify(b).includes('prompt_cache_breakpoint'),
        b['prompt_cache_key'],
      ]),
      asks: r.usage!.map((u) => u.cache_requested),
    }).toEqual({
      turns: [
        [undefined, false, sha256(HEAD)],
        [undefined, false, sha256(HEAD)],
      ],
      asks: ['provider_rules', 'provider_rules'],
    });
  });
});

describe('#896 check 7 — the split shapes', () => {
  it('a blank tail: one marked part, the whole text', async () => {
    await openai('gpt-5.6-luna', setting('long')).callStepWithMeta(
      `${HEAD}   `,
      SCHEMA,
      undefined,
      {
        cachePrefixChars: HEAD.length,
      },
    );
    // (a) red when the blank tail goes as a part of its own; (b) prints the user content's shape.
    expect(cacheView(sent[0]!).user).toEqual([
      { chars: HEAD.length + 3, marked: true, mark: MARK },
    ]);
  });

  it('a blank head: the plain user string, the system text marked only', async () => {
    await openai('gpt-5.6-luna', setting('long')).callStepWithMeta(
      '   \nFAKE-TICKET-2 only',
      SCHEMA,
      undefined,
      { cachePrefixChars: 4 },
    );
    // (a) red when a mark goes on the blank head; (b) prints both messages' shapes.
    expect({ system: cacheView(sent[0]!).system, user: cacheView(sent[0]!).user }).toEqual({
      system: SYSTEM_MARKED,
      user: 'plain',
    });
  });

  it('no split: the system text marked only', async () => {
    await openai('gpt-5.6-luna', setting('long')).callStepWithMeta(PROMPT, SCHEMA);
    // (a) red when the prompt is marked or shaped without a split; (b) prints both shapes.
    expect({ system: cacheView(sent[0]!).system, user: cacheView(sent[0]!).user }).toEqual({
      system: SYSTEM_MARKED,
      user: 'plain',
    });
  });
});

describe('#896 check 8 — every re-send of the step carries the same options and marks', () => {
  const marked = (b: Body) => ({
    options: b['prompt_cache_options'],
    system: cacheView(b).system,
    head: (cacheView(b).user as Array<{ marked: boolean }>)[0]?.marked,
  });
  const SAME = { options: { mode: 'explicit', ttl: '30m' }, system: SYSTEM_MARKED, head: true };

  it('the JSON retry', async () => {
    script = [answer('not json'), answer()];
    await openai('gpt-5.6-luna', setting('long')).callStepWithMeta(PROMPT, SCHEMA, undefined, {
      cachePrefixChars: HEAD.length,
    });
    // (a) red when the retry is built without them; (b) prints both requests' marks.
    expect(sent.map(marked)).toEqual([SAME, SAME]);
  });

  it('the repair attempt (the prompt with feedback after it, the same head)', async () => {
    const p = openai('gpt-5.6-luna', setting('long'));
    await p.callStepWithMeta(PROMPT, SCHEMA, undefined, { cachePrefixChars: HEAD.length });
    await p.callStepWithMeta(
      `${PROMPT}\n\nYour answer was invalid: queue is required.`,
      SCHEMA,
      undefined,
      {
        cachePrefixChars: HEAD.length,
      },
    );
    // (a) red when the repair's request goes without them; (b) prints both requests' marks.
    expect(sent.map(marked)).toEqual([SAME, SAME]);
  });

  it('the strict ladder’s re-send', async () => {
    script = [REFUSED_SCHEMA, answer()];
    await openai('gpt-5.6-luna', setting('long')).callStepWithMeta(PROMPT, SCHEMA, undefined, {
      structuredOutputStrict: true,
      cachePrefixChars: HEAD.length,
    });
    // (a) red when the drop retry is built without them; (b) prints both requests' marks and formats.
    expect(
      sent.map((b) => ({ ...marked(b), format: (b['response_format'] as { type: string }).type })),
    ).toEqual([
      { ...SAME, format: 'json_schema' },
      { ...SAME, format: 'json_object' },
    ]);
  });
});

describe('#896 check 9 — a 400 on OpenAI’s own address naming prompt_cache_breakpoint', () => {
  it('a single-shot step: it fails with OpenAI’s error, after one request, and nothing is re-sent without the fields', async () => {
    script = [REFUSED_MARK];
    const err = await openai('gpt-5.6-luna', setting('long'))
      .callStepWithMeta(PROMPT, SCHEMA, undefined, { cachePrefixChars: HEAD.length })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    // (a) red when a drop-and-retry is added (a second request, without the fields); (b) prints
    //     the error and each request's options.
    expect({
      error: String(err),
      requests: sent.map((b) => b['prompt_cache_options']),
    }).toEqual({
      error: expect.stringContaining('prompt_cache_breakpoint is not supported on this model'),
      requests: [{ mode: 'explicit', ttl: '30m' }],
    });
  });

  it('a strict step: only the existing strict ladder’s two requests, both with the fields', async () => {
    script = [REFUSED_MARK, REFUSED_MARK];
    const err = await openai('gpt-5.6-luna', setting('long'))
      .callStepWithMeta(PROMPT, SCHEMA, undefined, {
        structuredOutputStrict: true,
        cachePrefixChars: HEAD.length,
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    // (a) red when a drop-and-retry is added; (b) prints the error and each request's options.
    expect({
      error: String(err),
      requests: sent.map((b) => [
        b['prompt_cache_options'],
        (b['response_format'] as { type: string }).type,
      ]),
    }).toEqual({
      error: expect.stringContaining('prompt_cache_breakpoint is not supported on this model'),
      requests: [
        [{ mode: 'explicit', ttl: '30m' }, 'json_schema'],
        [{ mode: 'explicit', ttl: '30m' }, 'json_object'],
      ],
    });
  });
});

describe('#896 check 10 — the words', () => {
  const SINGLE = { steps: { classify: { execution: 'agent', description: 'C.' } } };
  const MIXED = {
    steps: {
      classify: { execution: 'agent', description: 'C.' },
      lookup: { execution: 'agent', description: 'L.', tools: ['srv:t'] },
    },
  };
  const TOOLS_ONLY = {
    steps: { lookup: { execution: 'agent', description: 'L.', tools: ['srv:t'] } },
  };
  const NO_AGENT = { steps: { tidy: { execution: 'auto', description: 'T.' } } };
  const startLine = (
    promptCache: ResolvedPromptCache | undefined,
    definition: unknown,
    request: PromptCacheRequest | undefined = promptCache,
  ) =>
    promptCacheStartLine({
      caps: openai('gpt-5.6-luna', request).capabilities(),
      promptCache,
      moduleProviderId: undefined,
      definition: definition as never,
    });
  const ASK =
    "Caching: OpenAI is asked to cache each step's fixed instructions and the stable start of its prompt for 30 minutes, the one lifetime Realm can ask OpenAI for";
  const TOOLS =
    " A step that calls tools is left to OpenAI's own caching, which reuses each turn at the next.";
  // Each: (a) red when the branch's words are put back to 3-B's (or its condition dropped); (b)
  // prints the line.
  it('the start line, not off, a step without tools', () => {
    expect(startLine(setting('long'), SINGLE)).toBe(`${ASK} (set by --prompt-cache long).`);
  });
  it('the start line, not off, with a step that calls tools', () => {
    expect(startLine(setting('long'), MIXED)).toBe(`${ASK} (set by --prompt-cache long).${TOOLS}`);
  });
  it('the start line, every agent step calls tools', () => {
    expect(startLine(setting('long'), TOOLS_ONLY)).toBe(
      "Caching: every agent step calls tools, so each is left to OpenAI's own caching, which reuses each turn at the next; Realm sends a cache key (set by --prompt-cache long).",
    );
  });
  it('the start line, off (whatever the steps)', () => {
    expect([startLine(setting('off'), SINGLE), startLine(setting('off'), NO_AGENT)]).toEqual([
      'Caching: off; OpenAI is asked to cache nothing (set by --prompt-cache off).',
      'Caching: off; OpenAI is asked to cache nothing (set by --prompt-cache off).',
    ]);
  });
  // #896 unit B; caching 3-M D-3: under `auto` the line names no single lifetime, and its reason is
  // only where the setting came from (what each step chose is on its requests).
  const AUTO_ASK =
    "Caching: OpenAI is asked to cache each step's fixed instructions and the stable start of its prompt for 30 minutes or not at all, as auto chooses per step from that step's own earlier runs";
  const ALONE: CacheAuto = { basis: 'no_measurement' };
  it.each([
    [
      { ...setting('auto', 'runner_default'), auto: ALONE },
      "realm agent's default; turn it off with --prompt-cache off",
    ],
    [
      { ...setting('auto', 'runner_default', 'realm listen'), auto: ALONE },
      "realm listen's default; change it with realm listen --prompt-cache",
    ],
    [{ ...setting('auto'), auto: ALONE }, 'set by --prompt-cache auto'],
    [
      { ...setting('auto', 'stated', 'realm listen'), auto: ALONE },
      'set by realm listen --prompt-cache auto',
    ],
  ] as const)('the start line, an auto reason: %j', (promptCache, reason) => {
    expect(startLine(promptCache, SINGLE)).toBe(`${AUTO_ASK} (${reason}).`);
  });
  it('the start line, no setting given (a host calling runAgent): no parenthetical', () => {
    expect(startLine(undefined, SINGLE, undefined)).toBe(`${ASK}.`);
  });
  it('listen’s openai value on GPT-5.6 and later at OpenAI’s own address, off and not off', () => {
    expect([
      listenCachingFacts('openai', 'off', 'default', 'gpt-5.6-luna')['openai'],
      listenCachingFacts('openai', undefined, 'default', 'gpt-5.6-luna')['openai'],
    ]).toEqual([
      'off: OpenAI is asked to cache nothing',
      // #896 unit B: `auto` (here listen's default) chooses.
      "auto: off or 30 minutes for each step without tools, by that step's own earlier runs and the prices in runner.cache.economics; a cache key, except on a step without tools when off",
    ]);
  });

  // The built CLI on examples/03, as the docs page runs it. Two processes, each a cold start.
  const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'index.js');
  const EXAMPLE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    '..',
    'examples',
    '03-incident-response',
  );
  it('validate’s above-the-floor clause: the o1 layout keeps “realm sends no marker”', () => {
    const r = spawnSync(
      process.execPath,
      [
        DIST,
        'workflow',
        'validate',
        EXAMPLE,
        '--provider',
        'openai',
        '--model',
        'o1-mini',
        '--floor',
        '200',
      ],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: process.env['HOME'] ?? '',
          REALM_NO_NUDGE: '1',
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    const line = r.stdout.split('\n').find((l) => l.startsWith('cache: analyze_cause')) ?? r.stderr;
    // (a) red when the o1 layout takes the GPT-5.6 words; (b) prints the line.
    expect(line).toMatch(
      /— above the floor for o1-mini \(200, your --floor\): within the provider's own rules \(realm sends no marker\)$/,
    );
  }, 60_000);
});
