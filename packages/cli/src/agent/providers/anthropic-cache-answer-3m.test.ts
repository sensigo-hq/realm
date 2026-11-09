// anthropic-cache-answer-3m.test.ts — caching 3-M piece B3a: a request records what it asked
// Anthropic about a cache miss and what Anthropic answered. The real cases: an operator reading
// later why a step's cache read fell short; an account that may not ask (a HIPAA organisation),
// whose every later request must say it did not ask; a request that was never going to ask, which
// must say nothing.
//
// The SDK is mocked, as in B2a's `anthropic-cache-ask-3m.test.ts`: a per-send 400 cannot be scripted
// on the stub. No live answer is captured: each answer here is built from the SDK's types
// (`BetaDiagnostics`, `BetaCacheMiss*`, 0.120.0). On a failure a cell prints each request's
// `cache_diagnostics` (test values and closed words), never prompt text. There are two send paths,
// single-shot and tool turns: one left unwired turns its rows red. Each assertion carries (1) the
// break that turns it red and (2) what it prints.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

type Options = NonNullable<ConstructorParameters<typeof AnthropicProvider>[1]>;

/** A real-shaped answer id: `msg_01` and 22 base62 characters (A3MB1-10). */
const msgId = (n: number): string => `msg_01${String(n).padStart(22, 'A')}`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x'],
  properties: { x: { type: 'string' } },
};
const tool = (strict = false): ToolDefinition => ({
  id: 'srv:lookup',
  serverId: 'srv',
  name: 'lookup',
  description: 'A tool',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  ...(strict ? { strict: true } : {}),
});
const EXECUTOR = async () => ({ content: [{ type: 'text', text: 'ok' }] });

const httpError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { status });
/** A captured 400 for a refused strict schema (premise-probe-raw.md), verbatim. */
const CAPTURED_400_SCHEMA =
  "tools.0.custom: For 'object' type, 'additionalProperties' must be explicitly set to false";
const REFUSED = 'a 400 that says nothing of the question';

const textAnswer = (id: unknown, text = '{"x":"a"}') => ({
  id,
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
});
const toolCallAnswer = (id: unknown) => ({
  id,
  content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }],
  stop_reason: 'tool_use',
});
const submitAnswer = (id: unknown) => ({
  id,
  content: [{ type: 'tool_use', id: 'submit1', name: '__realm_submit__', input: { x: 'a' } }],
  stop_reason: 'tool_use',
});

const asking = (over: Options = {}): AnthropicProvider =>
  new AnthropicProvider('claude-x', {
    endpoint: 'default',
    promptCache: { value: 'short' },
    cacheDiagnostics: true,
    ...over,
  });

type Usage = { usage?: readonly object[] };
/** Per request: its `cache_diagnostics`, or `none` when the key is not there at all. */
const recorded = (result: Usage): unknown[] =>
  (result.usage ?? []).map((r) =>
    Object.hasOwn(r, 'cache_diagnostics')
      ? (r as { cache_diagnostics: unknown }).cache_diagnostics
      : 'none',
  );

/** One of the two send paths: a provider call, an answer that goes on, and one that ends it. */
interface Path {
  readonly name: string;
  run(provider: AnthropicProvider): Promise<Usage>;
  strict(provider: AnthropicProvider): Promise<Usage>;
  goesOn(id: unknown): object;
  ends(id: unknown): object;
}
const PATHS: Path[] = [
  {
    name: 'single-shot',
    run: (provider) => provider.callStepWithMeta('prompt', SCHEMA),
    strict: (provider) =>
      provider.callStepWithMeta('prompt', SCHEMA, undefined, { structuredOutputStrict: true }),
    goesOn: (id) => textAnswer(id, 'not json'), // the JSON retry follows
    ends: (id) => textAnswer(id),
  },
  {
    name: 'tool turns',
    run: (provider) => provider.callStepWithTools('prompt', [tool()], EXECUTOR, {}),
    strict: (provider) => provider.callStepWithTools('prompt', [tool(true)], EXECUTOR, {}),
    goesOn: (id) => toolCallAnswer(id), // the next turn follows
    ends: (id) => textAnswer(id),
  },
];

/** A tool step with a budget of one tool call: its main turn, then the final extraction. */
const lastCallUsedUp = (provider: AnthropicProvider): Promise<Usage> =>
  provider.callStepWithTools('prompt', [tool()], EXECUTOR, {
    maxToolCalls: 1,
    inputSchema: SCHEMA,
  });

const REJECTED = { asked: false, cause: 'rejected' };

beforeEach(() => {
  mockCreate.mockReset();
});

describe('caching 3-M B3a — the mapping of Anthropic’s answer', () => {
  const NO_KEY = Symbol('no diagnostics key');
  // Real case: a later request of a step, which named the answer before it. (1) red when `null` is
  // read as pending, a missing key as no divergence, `cache_miss_reason` with `== null` (the `{}`
  // row), or one path is not wired (its rows). (2) prints each request's field.
  describe.each(PATHS)('$name', (path) => {
    it.each([
      ['null: no divergence found', null, 'no_divergence'],
      ['a null reason: still pending', { cache_miss_reason: null }, 'pending'],
      ['no key at all', NO_KEY, 'not_returned'],
      ['an empty object', {}, 'not_returned'],
      [
        'a reason with its count',
        { cache_miss_reason: { type: 'messages_changed', cache_missed_input_tokens: 1200 } },
        { type: 'messages_changed', cache_missed_input_tokens: 1200 },
      ],
      [
        'a reason with no count',
        { cache_miss_reason: { type: 'previous_message_not_found' } },
        { type: 'previous_message_not_found' },
      ],
    ] as const)('%s', async (_name, diagnostics, result) => {
      mockCreate.mockResolvedValueOnce(path.goesOn(msgId(1))).mockResolvedValueOnce({
        ...path.ends(msgId(2)),
        ...(diagnostics === NO_KEY ? {} : { diagnostics }),
      });
      expect(recorded(await path.run(asking()))).toEqual([
        { asked: true, reference_id: null },
        { asked: true, reference_id: msgId(1), result },
      ]);
    });
  });
});

describe('caching 3-M B3a — a refused question', () => {
  // Real case: an account that may not ask. The refused send has no record of its own. (1) red when
  // only the re-send is marked (the later step), or "still asking" is read in place of "the re-send
  // was made" (the tool path's re-send, pushed before `asking` clears). (2) prints each field.
  it.each(PATHS)(
    '(a) $name: the re-send, a later request of the call and a later step each say so',
    async (path) => {
      mockCreate
        .mockRejectedValueOnce(httpError(400, REFUSED))
        .mockResolvedValueOnce(path.goesOn(msgId(1)))
        .mockResolvedValueOnce(path.ends(msgId(2)))
        .mockResolvedValueOnce(path.ends(msgId(3)));
      const provider = asking();
      const first = await path.run(provider);
      const later = await path.run(provider);
      expect({ first: recorded(first), later: recorded(later) }).toEqual({
        first: [REJECTED, REJECTED],
        later: [REJECTED],
      });
    },
  );

  // Real case: a tool step that spent its calls, after the refusal. Its final extraction never asks,
  // and would not have. (1) red when the helper is written in `bounded`, which the final extraction
  // also goes through. (2) prints each field.
  it('(b) tool turns: after the refusal the final extraction records no field', async () => {
    mockCreate
      .mockRejectedValueOnce(httpError(400, REFUSED))
      .mockResolvedValueOnce(toolCallAnswer(msgId(1)))
      .mockResolvedValueOnce(submitAnswer(msgId(2)));
    expect(recorded(await lastCallUsedUp(asking()))).toEqual([REJECTED, 'none']);
  });

  // Real case: a strict schema Anthropic really refuses: the probe fails the same way and the strict
  // ladder's retry still asks. (1) red when the memory is read before the body's key (a retry that
  // asked would say it did not). (2) prints each field.
  it.each(PATHS)(
    '(c) $name: the ladder’s retry carries the key and says it asked',
    async (path) => {
      mockCreate
        .mockRejectedValueOnce(httpError(400, CAPTURED_400_SCHEMA))
        .mockRejectedValueOnce(httpError(400, CAPTURED_400_SCHEMA))
        .mockResolvedValueOnce(path.ends(msgId(1)));
      expect(recorded(await path.strict(asking()))).toEqual([{ asked: true, reference_id: null }]);
    },
  );
});

describe('caching 3-M B3a — a request that was never going to ask records nothing', () => {
  // Real cases: a drive told not to ask, a gateway at a custom address, a drive that caches nothing.
  // (1) red when a missing key is read as `rejected` without the memory. (2) prints each field.
  describe.each(PATHS)('$name', (path) => {
    it.each([
      ['the option off', () => asking({ cacheDiagnostics: false })],
      ['a custom address', () => asking({ endpoint: 'custom' })],
      ['a settled off', () => asking({ promptCache: { value: 'off' } })],
    ] as const)('%s', async (_name, make) => {
      mockCreate.mockResolvedValueOnce(path.ends(msgId(1)));
      expect(recorded(await path.run(make()))).toEqual(['none']);
    });
  });

  // Real case: a tool step's last request, which carries no question. (1) red when the helper is
  // written in `bounded` with that read. (2) prints each field.
  it('the final extraction', async () => {
    mockCreate
      .mockResolvedValueOnce(toolCallAnswer(msgId(1)))
      .mockResolvedValueOnce(submitAnswer(msgId(2)));
    expect(recorded(await lastCallUsedUp(asking()))).toEqual([
      { asked: true, reference_id: null },
      'none',
    ]);
  });
});
