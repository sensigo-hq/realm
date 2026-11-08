// openai-cache-key-3b.test.ts — caching 3-B, Part D (D1, D2; B2, B3, D4.6-8…11): the OpenAI cache
// key. The SDK is a fake whose `chat.completions.create` records each body; its client carries the
// `baseURL` it was given (as the real SDK's client does), and its replies copy a Chat Completions
// response's fields (`choices[].message`, `usage.prompt_tokens(_details)`, `model`). Each cell names
// (a) the change that turns it red and (b) what it prints: the keys and facts sent, from fake prompts.
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './openai-provider.js';
import { OpenAIReasoningProvider } from './openai-reasoning-provider.js';
import { buildSystemPrompt } from './agent-utils.js';
import type { PromptCacheRequest } from './llm-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function (opts: { baseURL?: string }) {
    return {
      baseURL: opts.baseURL ?? 'https://api.openai.com/v1',
      chat: { completions: { create: mockCreate } },
    };
  }),
}));

type Body = Record<string, unknown> & { prompt_cache_key?: string };
let sent: Body[] = [];
let script: Array<Record<string, unknown> | Error> = [];
const answer = (content: string) => ({
  model: 'gpt-test-1',
  choices: [{ message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } },
});
const toolCall = (n: number) => ({
  model: 'gpt-test-1',
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 't', arguments: '{}' } }],
      },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 3 },
});
beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockImplementation(async (body: Body) => {
    sent.push(structuredClone(body));
    const next = script.shift() ?? answer('{"x":"a"}');
    if (next instanceof Error) throw next;
    return next;
  });
  sent = [];
  script = [];
});

const sha256 = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const HEAD = 'Classify the ticket below into one queue.\nTicket: ';
const PROMPT = `${HEAD}FAKE-TICKET-3 asks for a refund.`;
const KEY = sha256(HEAD);
const setting = (
  value: PromptCacheRequest['value'],
  source: PromptCacheRequest['source'] = 'stated',
): PromptCacheRequest => ({ value, source, by: 'realm agent' });
const openai = (
  endpoint: 'default' | 'custom',
  promptCache: PromptCacheRequest,
  baseUrl = endpoint === 'custom'
    ? 'https://example-resource.openai.azure.com/openai/v1'
    : undefined,
) => new OpenAIProvider('gpt-x', baseUrl, false, { endpoint, promptCache });
const SCHEMA = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] };
const apiError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { status });

describe('caching 3-B D2 — when the key is sent', () => {
  it('on OpenAI’s own endpoint: the 64-character SHA-256 of the head, the record’s prefix_sha256', async () => {
    const { usage } = await openai('default', setting('auto', 'runner_default')).callStepWithMeta(
      PROMPT,
      undefined,
      undefined,
      { cachePrefixChars: HEAD.length },
    );
    const r = usage![0]!;
    // (a) red when the key is not sent, carries a `sha256:` prefix, or differs from the record's
    //     digest; (b) prints the key, its length and the facts.
    expect({
      key: sent[0]!.prompt_cache_key,
      length: sent[0]!.prompt_cache_key?.length,
      sameAsRecord: sent[0]!.prompt_cache_key === r.prefix_sha256,
      key_sent: r.cache_key_sent,
      marked: r.cache_marked,
      requested: r.cache_requested,
      prompt: sent[0]!['messages'],
    }).toEqual({
      key: KEY,
      length: 64,
      sameAsRecord: true,
      key_sent: true,
      marked: ['key'],
      requested: 'provider_rules',
      prompt: [
        { role: 'system', content: expect.any(String) },
        { role: 'user', content: PROMPT },
      ],
    });
  });

  it('`off` is honoured: no key, on OpenAI’s own endpoint', async () => {
    const { usage } = await openai('default', setting('off')).callStepWithMeta(
      PROMPT,
      undefined,
      undefined,
      {
        cachePrefixChars: HEAD.length,
      },
    );
    // (a) red when the key is sent under `off`; (b) prints the body's key and the facts.
    expect({
      key: sent[0]!.prompt_cache_key,
      key_sent: usage![0]!.cache_key_sent,
      marked: usage![0]!.cache_marked,
    }).toEqual({
      key: undefined,
      key_sent: undefined,
      marked: undefined,
    });
  });

  it('a custom endpoint: no key for the runner’s default; the key for a stated setting other than off', async () => {
    await openai('custom', setting('auto', 'runner_default')).callStepWithMeta(
      PROMPT,
      undefined,
      undefined,
      {
        cachePrefixChars: HEAD.length,
      },
    );
    await openai('custom', setting('short')).callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    await openai('custom', setting('off')).callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    // (a) red when the source rule or `off` is dropped on a custom endpoint; (b) prints the keys.
    expect(sent.map((b) => b.prompt_cache_key)).toEqual([undefined, KEY, undefined]);
  });

  it('no key without a split, and none for a head with no non-space character', async () => {
    await openai('default', setting('long')).callStepWithMeta(PROMPT);
    await openai('default', setting('long')).callStepWithMeta(
      '   \nFAKE only',
      undefined,
      undefined,
      {
        cachePrefixChars: 4,
      },
    );
    // (a) red when an empty-head key is sent (every such step would share it); (b) prints them.
    expect(sent.map((b) => b.prompt_cache_key)).toEqual([undefined, undefined]);
  });
});

describe('caching 3-B D2 — the five body sites, every request of a step with the same key', () => {
  it('1, single-shot: the request and its JSON retry', async () => {
    script = [answer('not json'), answer('{"x":"b"}')];
    await openai('default', setting('long')).callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    // (a) red when site 1 or its retry goes without the key; (b) prints the keys.
    expect(sent.map((b) => b.prompt_cache_key)).toEqual([KEY, KEY]);
  });

  it('2, strict: the strict request and its drop retry', async () => {
    script = [apiError(400, 'Invalid schema for response_format'), answer('{"x":"a"}')];
    const { usage } = await openai('default', setting('long')).callStepWithMeta(
      PROMPT,
      SCHEMA,
      undefined,
      {
        structuredOutputStrict: true,
        cachePrefixChars: HEAD.length,
      },
    );
    // (a) red when the strict body or its drop retry goes without the key; (b) prints the keys and
    //     what the record says strict was.
    expect({
      keys: sent.map((b) => b.prompt_cache_key),
      strictFirst: (sent[0]!['response_format'] as { type: string }).type,
      strictSent: usage!.map((r) => r.request_strict_sent),
    }).toEqual({ keys: [KEY, KEY], strictFirst: 'json_schema', strictSent: [false] });
  });

  const tool: ToolDefinition = {
    id: 'srv:t',
    serverId: 'srv',
    name: 't',
    description: 'A tool',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  };
  const EXECUTOR = async () => ({ content: [{ type: 'text', text: 'ok' }] });

  it('3, the tool loop’s main turns', async () => {
    script = [toolCall(1), answer('{"x":"a"}')];
    await openai('default', setting('long')).callStepWithTools(PROMPT, [tool], EXECUTOR as never, {
      cachePrefixChars: HEAD.length,
    });
    // (a) red when a main turn goes without the key; (b) prints the keys.
    expect(sent.map((b) => b.prompt_cache_key)).toEqual([KEY, KEY]);
  });

  it('4, the tool loop’s final request', async () => {
    script = [toolCall(1), answer('{"x":"a"}')];
    await openai('default', setting('long')).callStepWithTools(PROMPT, [tool], EXECUTOR as never, {
      maxToolCalls: 1,
      cachePrefixChars: HEAD.length,
    });
    // (a) red when the final request (no tools offered) goes without the key; (b) prints them.
    expect({
      keys: sent.map((b) => b.prompt_cache_key),
      finalHasTools: 'tools' in sent.at(-1)!,
    }).toEqual({
      keys: [KEY, KEY],
      finalHasTools: false,
    });
  });

  it('5, the o1 route', async () => {
    const { usage } = await new OpenAIReasoningProvider('o1-mini', {
      endpoint: 'default',
      promptCache: setting('long'),
    }).callStepWithMeta(PROMPT, undefined, undefined, { cachePrefixChars: HEAD.length });
    // (a) red when the o1 body goes without the key; (b) prints the key and the facts.
    expect({
      key: sent[0]!.prompt_cache_key,
      prefix: usage![0]!.prefix_sha256,
      marked: usage![0]!.cache_marked,
    }).toEqual({
      key: KEY,
      prefix: KEY,
      marked: ['key'],
    });
  });
});

describe('caching 3-B D1 — the endpoint value travels unchanged to the per-call clients', () => {
  it('each per-call client resolves to the endpoint the provider was built with', async () => {
    const custom = openai('custom', setting('short'));
    const plain = openai('default', setting('short'));
    const a = await custom.callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    const b = await plain.callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    // (a) red when a per-call client is built with another base URL than the one resolved; (b)
    //     prints each request's recorded endpoint beside the capability.
    expect([
      [a.usage![0]!.endpoint, custom.capabilities().endpoint],
      [b.usage![0]!.endpoint, plain.capabilities().endpoint],
    ]).toEqual([
      ['custom', 'custom'],
      ['default', 'default'],
    ]);
  });
});

// ── Caching 3-M (A-0): every OpenAI and o1 request records the parts of what it sent ────────────────
// A request of a step with no `prompt:` has no head (no `cachePrefixChars`, so no plan): it records
// `prefix_parts` with the step's prompt as its prompt part, and no `prefix_sha256`/`prefix_chars`. A
// split request's prompt part stays the head's. Each digest is compared with the digest of what the
// fake SDK received (OpenAI's system message, tools and response format) or of the step's text (o1
// folds the system text into its one message, so its system part is the system text it was given).
describe('caching 3-M A-0 — the parts on every OpenAI and o1 request', () => {
  type Facts = {
    prefix_parts?: unknown;
    prefix_sha256?: unknown;
    prefix_chars?: unknown;
    cache_marked?: unknown;
    request_strict_sent?: unknown;
  };
  const systemOf = (b: Body): string => (b['messages'] as Array<{ content: string }>)[0]!.content;
  /** The parts a request sending `b` should record, with `prompt` as its prompt part. */
  const partsSent = (b: Body, prompt: string, system = systemOf(b)): Record<string, string> => ({
    ...(b['tools'] !== undefined ? { tools: sha256(JSON.stringify(b['tools'])) } : {}),
    system: sha256(system),
    prompt: sha256(prompt),
    ...(b['response_format'] !== undefined
      ? { format: sha256(JSON.stringify(b['response_format'])) }
      : {}),
  });
  /** What one record says, beside its index: the parts, the split's two facts, marks and strict. */
  const view = (r: Facts, i: number) => ({
    request: i,
    parts: r.prefix_parts,
    split: [r.prefix_sha256, r.prefix_chars],
    marked: r.cache_marked,
    strict: r.request_strict_sent,
  });
  const o1 = () =>
    new OpenAIReasoningProvider('o1-mini', { endpoint: 'default', promptCache: setting('long') });
  const tool: ToolDefinition = {
    id: 'srv:t',
    serverId: 'srv',
    name: 't',
    description: 'A tool',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  };
  const EXECUTOR = async () => ({ content: [{ type: 'text', text: 'ok' }] });

  it('check 1, OpenAI: a split request’s prompt part is the head’s digest, beside system and format', async () => {
    const { usage } = await openai('default', setting('long')).callStepWithMeta(
      PROMPT,
      undefined,
      undefined,
      { cachePrefixChars: HEAD.length },
    );
    // (a) red when the prompt part is the step prompt's digest while a plan exists (the fixture's
    //     tail makes sha256(PROMPT) differ from sha256(HEAD)); (b) prints the request's index and
    //     facts, and whether a response format went out (so the format part is not vacuous).
    expect({
      ...view(usage![0]!, 0),
      formatSent: sent[0]!['response_format'] !== undefined,
    }).toEqual({
      request: 0,
      parts: {
        system: sha256(systemOf(sent[0]!)),
        prompt: sha256(HEAD),
        format: sha256(JSON.stringify(sent[0]!['response_format'])),
      },
      split: [KEY, HEAD.length],
      marked: ['key'],
      strict: false,
      formatSent: true,
    });
  });

  it('check 1, o1: a split request’s parts are the system text it was given and the head', async () => {
    const { usage } = await o1().callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    // (a) red when the prompt part is the step prompt's digest while a plan exists; (b) prints the
    //     request index and its parts.
    expect({ request: 0, parts: usage![0]!.prefix_parts }).toEqual({
      request: 0,
      parts: { system: sha256(buildSystemPrompt()), prompt: sha256(HEAD) },
    });
  });

  it('check 4, OpenAI JSON mode: a request with no head and its JSON retry record the parts, the prompt part the step’s prompt', async () => {
    script = [answer('not json'), answer('{"x":"b"}')];
    const { usage } = await openai('default', setting('long')).callStepWithMeta(PROMPT);
    // (a) red when this site (the JSON-mode request) still records the parts only with a plan, or
    //     when the retry's prompt part is read off a message it appended; (b) prints each request's
    //     index and facts.
    expect(usage!.map(view)).toEqual(
      sent.map((b, i) => ({
        request: i,
        parts: partsSent(b, PROMPT),
        split: [undefined, undefined],
        marked: undefined,
        strict: false,
      })),
    );
    // (a) red when the run took another path than the JSON request and its retry; (b) prints the
    //     count and whether each sent a response format.
    expect(sent.map((b) => b['response_format'] !== undefined)).toEqual([true, true]);
  });

  it('check 4, OpenAI strict (a schema, structuredOutputStrict): the strict request records the parts and strict', async () => {
    const { usage } = await openai('default', setting('long')).callStepWithMeta(
      PROMPT,
      SCHEMA,
      undefined,
      { structuredOutputStrict: true },
    );
    // (a) red when the strict site still records the parts only with a plan; (b) prints the
    //     request's index and facts, and the response format type it sent (json_schema: the strict
    //     site ran, not the JSON-mode one).
    expect({
      ...view(usage![0]!, 0),
      type: (sent[0]!['response_format'] as { type: string }).type,
    }).toEqual({
      request: 0,
      parts: partsSent(sent[0]!, PROMPT),
      split: [undefined, undefined],
      marked: undefined,
      strict: true,
      type: 'json_schema',
    });
  });

  it('check 4, OpenAI tool step: the main turn and the final request record the parts, the prompt part the step’s prompt', async () => {
    script = [toolCall(1), answer('{"x":"a"}')];
    const { usage } = await openai('default', setting('long')).callStepWithTools(
      PROMPT,
      [tool],
      EXECUTOR as never,
      { maxToolCalls: 1 },
    );
    // (a) red when the tool loop's site still records the parts only with a plan, or when a turn's
    //     prompt part is read off the growing conversation; (b) prints each request's index and
    //     facts, and which requests offered tools (the main turn did, the final request did not).
    expect({
      records: usage!.map(view),
      tools: sent.map((b) => 'tools' in b),
    }).toEqual({
      records: sent.map((b, i) => ({
        request: i,
        parts: partsSent(b, PROMPT),
        split: [undefined, undefined],
        marked: undefined,
        strict: false,
      })),
      tools: [true, false],
    });
  });

  it('check 4, o1: a request with no head and its JSON retry record the system text and the step’s prompt', async () => {
    script = [answer('not json'), answer('{"x":"b"}')];
    const { usage } = await o1().callStepWithMeta(PROMPT);
    // (a) red when the o1 site still records the parts only with a plan, or when the prompt part is
    //     read off a message (the first folds the system text in; the retry's second is the model's
    //     answer); (b) prints each request's index and facts.
    expect(usage!.map(view)).toEqual(
      [0, 1].map((i) => ({
        request: i,
        parts: { system: sha256(buildSystemPrompt()), prompt: sha256(PROMPT) },
        split: [undefined, undefined],
        marked: undefined,
        strict: false,
      })),
    );
  });
});
