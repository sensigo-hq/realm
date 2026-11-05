// anthropic-provider-head-3b.test.ts — caching 3-B, Part C (C2, C3; D3 §2.3.1 with B1): a single-shot
// request whose prompt has a stable head sends it as its own marked text block, in one of three
// shapes, on the plain body and on the strict body, and records the split's facts as sent. The SDK
// is a fake whose `messages.create` records each body (the request shape the Anthropic SDK takes,
// `@anthropic-ai/sdk` `MessageCreateParams`); its replies copy a Messages API response's fields
// (`content`, `usage`, `stop_reason`, `model`). Each cell names (a) the change that turns it red and
// (b) what it prints: the content sent and the recorded facts, from fake prompts.
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

type Body = {
  system?: unknown;
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown;
};
let sent: Body[] = [];
let answers: string[] = [];
beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockImplementation(async (body: Body) => {
    sent.push(structuredClone(body));
    return {
      model: 'claude-test-1',
      content: [{ type: 'text', text: answers.shift() ?? '{"x":"a"}' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      },
    };
  });
  sent = [];
  answers = [];
});

const sha256 = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const SHORT = { type: 'ephemeral' };
const provider = (value: 'short' | 'long' | 'off' = 'short') =>
  new AnthropicProvider('claude-x', {
    promptCache: { value, source: 'stated', by: 'realm agent' },
  });
const HEAD = 'You review support tickets.\nTicket: ';
const PROMPT = `${HEAD}FAKE-TICKET-1 says the parcel is late.`;

describe('caching 3-B C3 — the head block, one cell per shape', () => {
  it('head and tail both hold text: two blocks, the head marked; the record holds the split', async () => {
    const { usage } = await provider().callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    // (a) red when cachePrefixChars is not used (one plain string goes out) or the head is cut
    //     elsewhere; (b) prints the content sent and the recorded facts.
    expect(sent[0]!.messages[0]!.content).toEqual([
      { type: 'text', text: HEAD, cache_control: SHORT },
      { type: 'text', text: PROMPT.slice(HEAD.length) },
    ]);
    // The head block is exactly the prompt's first n characters (C2's adapter cell).
    expect((sent[0]!.messages[0]!.content as Array<{ text: string }>)[0]!.text).toBe(
      PROMPT.slice(0, HEAD.length),
    );
    const r = usage![0]!;
    expect({
      prefix_sha256: r.prefix_sha256,
      prefix_chars: r.prefix_chars,
      prompt: r.prefix_parts?.prompt,
      hasSystem: typeof r.prefix_parts?.system === 'string',
      cache_marked: r.cache_marked,
      request_strict_sent: r.request_strict_sent,
    }).toEqual({
      prefix_sha256: sha256(HEAD),
      prefix_chars: HEAD.length,
      prompt: sha256(HEAD),
      hasSystem: true,
      cache_marked: ['system', 'prompt'],
      request_strict_sent: false,
    });
  });

  it('the tail holds no text: ONE marked block, the whole prompt, recorded as the head', async () => {
    const whole = `${HEAD.trimEnd()}\n   \n`;
    const { usage } = await provider().callStepWithMeta(whole, undefined, undefined, {
      cachePrefixChars: HEAD.length - 1,
    });
    // (a) red when the whitespace branch for the tail is removed (a blank block would go out);
    //     (b) prints the content and the recorded length.
    expect({ content: sent[0]!.messages[0]!.content, chars: usage![0]!.prefix_chars }).toEqual({
      content: [{ type: 'text', text: whole, cache_control: SHORT }],
      chars: whole.length,
    });
  });

  it('the head holds no text: the plain string, the prompt unmarked, only the system text marked', async () => {
    const { usage } = await provider().callStepWithMeta(
      '   \nFAKE-VALUE only',
      undefined,
      undefined,
      {
        cachePrefixChars: 4,
      },
    );
    // (a) red when the whitespace branch for the head is removed (a blank marked block would go
    //     out, which Anthropic refuses); (b) prints the content and what was marked.
    expect({ content: sent[0]!.messages[0]!.content, marked: usage![0]!.cache_marked }).toEqual({
      content: '   \nFAKE-VALUE only',
      marked: ['system'],
    });
  });

  it('under --prompt-cache off: the plain string and nothing marked, the split still recorded', async () => {
    const { usage } = await provider('off').callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    // (a) red when off marks the head; (b) prints the content and the facts.
    expect({
      content: sent[0]!.messages[0]!.content,
      marked: usage![0]!.cache_marked,
      chars: usage![0]!.prefix_chars,
    }).toEqual({ content: PROMPT, marked: undefined, chars: HEAD.length });
  });

  it('with no cachePrefixChars: the plain string and no split facts (a provider module’s path)', async () => {
    const { usage } = await provider().callStepWithMeta(PROMPT);
    // (a) red when a split is invented without a boundary; (b) prints what went out.
    expect({ content: sent[0]!.messages[0]!.content, sha: usage![0]!.prefix_sha256 }).toEqual({
      content: PROMPT,
      sha: undefined,
    });
  });
});

describe('caching 3-B C3 — the re-sends and the strict body', () => {
  it('the JSON retry sends the same head block seconds later, so it reads the cache', async () => {
    answers = ['not json at all', '{"x":"b"}'];
    await provider().callStepWithMeta(PROMPT, undefined, undefined, {
      cachePrefixChars: HEAD.length,
    });
    const heads = sent.map((b) => (b.messages[0]!.content as Array<{ text: string }>)[0]);
    // (a) red when the retry is sent as a plain string or with another head; (b) prints both heads.
    expect(heads).toEqual([
      { type: 'text', text: HEAD, cache_control: SHORT },
      { type: 'text', text: HEAD, cache_control: SHORT },
    ]);
  });

  it('the strict body carries the same head block, and the record says strict went out', async () => {
    const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] };
    answers = ['{"x":"a"}'];
    const { usage } = await provider().callStepWithMeta(PROMPT, schema, undefined, {
      structuredOutputStrict: true,
      cachePrefixChars: HEAD.length,
    });
    const tools = sent[0]!.tools as Array<{ strict?: boolean }>;
    // (a) red when the strict body is built without the head block, or strict is recorded from
    //     the request rather than from the body sent; (b) prints the flags and the facts.
    expect({
      strict: tools[0]!.strict,
      head: (sent[0]!.messages[0]!.content as Array<{ text: string }>)[0]!.text,
      strictSent: usage![0]!.request_strict_sent,
      tools: usage![0]!.prefix_parts?.tools === sha256(JSON.stringify(sent[0]!.tools)),
    }).toEqual({ strict: true, head: HEAD, strictSent: true, tools: true });
  });
});
