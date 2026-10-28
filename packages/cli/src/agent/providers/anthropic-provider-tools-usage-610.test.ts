// anthropic-provider-tools-usage-610.test.ts — issue #610: a tool-using step records what its model
// requests cost. Every request the tool loop sends goes through one local `bounded`, which records
// it the instant its answer arrives; the public `callStepWithTools` owns the list and attaches it to
// any throw. The SDK is mocked; each mocked answer carries DISTINCT usage, so order is checked.
// Each assertion names (a) the change that turns it red and (b) what it prints when it fails:
// counts, indexes, token numbers and key lists only.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';
import type { LlmClock } from './agent-utils.js';

const mockCreate = vi.fn();
let baseURL: string | undefined;
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { ...(baseURL !== undefined ? { baseURL } : {}), messages: { create: mockCreate } };
  }),
}));

/** One answer's usage: the three input counters (so `prompt_tokens` is derived) and the output. */
const usage = (n: number) => ({
  input_tokens: 100 * n,
  cache_read_input_tokens: 10 * n,
  cache_creation_input_tokens: n,
  output_tokens: 7 * n,
});
/** `prompt_tokens` as the record derives it from `usage(n)`. */
const promptOf = (n: number) => 111 * n;
const toolUse = (name: string, n: number, input: Record<string, unknown> = {}) => ({
  model: 'claude-test-1',
  content: [{ type: 'tool_use', id: `toolu_${n}`, name, input }],
  usage: usage(n),
});
const text = (t: string, n: number) => ({
  model: 'claude-test-1',
  content: [{ type: 'text', text: t }],
  usage: usage(n),
});
const tool = (strict = false): ToolDefinition => ({
  id: 'srv:t',
  serverId: 'srv',
  name: 't',
  description: 'A tool',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  ...(strict ? { strict: true } : {}),
});
const httpError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { status });
const EXECUTOR = async () => ({ content: [{ type: 'text', text: 'ok' }] });
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
} as const;
type Usage = Array<{ request_index: number; prompt_tokens?: number }>;
const billedOf = (err: unknown): Usage =>
  ((err as { driveCall?: { usage?: Usage } }).driveCall?.usage ?? []) as Usage;

beforeEach(() => {
  mockCreate.mockReset();
  baseURL = undefined;
});

describe('#610 — AnthropicProvider.callStepWithTools records each answered request', () => {
  it('P1, wire order: the main turn, a tool-result turn, a correction turn, the final extraction — one record each, in order', async () => {
    mockCreate
      .mockResolvedValueOnce(toolUse('t', 1))
      .mockResolvedValueOnce(text('not json', 2))
      .mockResolvedValueOnce(toolUse('t', 3))
      .mockResolvedValueOnce(toolUse('__realm_submit__', 4, { answer: 'done' }));
    const result = await new AnthropicProvider('claude-x').callStepWithTools(
      'prompt',
      [tool()],
      EXECUTOR,
      { maxToolCalls: 3, inputSchema: SCHEMA as unknown as Record<string, unknown> },
    );
    const records = (result.usage ?? []) as Usage;
    // (a) red when `bounded` stops recording (no list); (b) prints the count, the indexes and the
    //     prompt tokens, each against the expected.
    expect({
      creates: mockCreate.mock.calls.length,
      indexes: records.map((r) => r.request_index),
      prompt: records.map((r) => r.prompt_tokens),
      output: result.output,
    }).toEqual({
      creates: 4,
      indexes: [0, 1, 2, 3],
      prompt: [promptOf(1), promptOf(2), promptOf(3), promptOf(4)],
      output: { answer: 'done' },
    });
  });

  it('P2, the strict retry: a strict-carrying turn answered 400 then retried — one record, the retry’s', async () => {
    mockCreate
      .mockRejectedValueOnce(httpError(400, 'tools.0.custom.strict: invalid'))
      .mockResolvedValueOnce(text('{"answer":"x"}', 5));
    const result = await new AnthropicProvider('claude-x').callStepWithTools(
      'prompt',
      [tool(true)],
      EXECUTOR,
      {},
    );
    const records = (result.usage ?? []) as Usage;
    // (a) red when the rejected attempt is recorded too (the push moved into a `finally`); (b)
    //     prints the counts and the recorded prompt tokens.
    expect({
      creates: mockCreate.mock.calls.length,
      records: records.length,
      prompt: records.map((r) => r.prompt_tokens),
    }).toEqual({ creates: 2, records: 1, prompt: [promptOf(5)] });
  });

  it('P3, an unknown tool name throws after two billed requests: the error carries both, in order', async () => {
    mockCreate.mockResolvedValueOnce(toolUse('t', 1)).mockResolvedValueOnce(toolUse('nope', 2));
    const err = await new AnthropicProvider('claude-x')
      .callStepWithTools('prompt', [tool()], EXECUTOR, { maxToolCalls: 5 })
      .catch((e: unknown) => e);
    // (a) red when the entry's catch does not attach what was billed; (b) prints the error's class
    //     and the usage it carries.
    expect({
      threw: err instanceof Error,
      indexes: billedOf(err).map((r) => r.request_index),
      prompt: billedOf(err).map((r) => r.prompt_tokens),
    }).toEqual({ threw: true, indexes: [0, 1], prompt: [promptOf(1), promptOf(2)] });
  });

  it('P3, the final extraction does not parse: the error carries every request, the final one included', async () => {
    mockCreate.mockResolvedValueOnce(toolUse('t', 1)).mockResolvedValueOnce(text('no json', 2));
    const err = await new AnthropicProvider('claude-x')
      .callStepWithTools('prompt', [tool()], EXECUTOR, { maxToolCalls: 1 })
      .catch((e: unknown) => e);
    // (a) red when the entry's catch does not attach what was billed; (b) prints the error's class
    //     and the usage count.
    expect({
      name: (err as Error).name,
      message: /final extraction failed/.test((err as Error).message),
      indexes: billedOf(err).map((r) => r.request_index),
    }).toEqual({ name: 'WorkflowError', message: true, indexes: [0, 1] });
  });

  it('P4, a wire error after a billed request, WITH a clock: the payload keeps its class and gains the usage', async () => {
    mockCreate
      .mockResolvedValueOnce(toolUse('t', 1))
      .mockRejectedValueOnce(httpError(500, 'overloaded'));
    const clock: LlmClock = { ceilingMs: 60_000 };
    const err = await new AnthropicProvider('claude-x')
      .callStepWithTools('prompt', [tool()], EXECUTOR, { maxToolCalls: 5, llmClock: clock })
      .catch((e: unknown) => e);
    const payload = (err as { driveCall?: Record<string, unknown> }).driveCall ?? {};
    // (a) red when the catch is removed (no usage beside the class) or skips a payload that is
    //     there (the #607 lesson); (b) prints the payload's keys and the usage indexes.
    expect({
      hasClass: typeof payload['error_class'] === 'string',
      indexes: billedOf(err).map((r) => r.request_index),
    }).toEqual({ hasClass: true, indexes: [0] });
  });

  describe('P5, a tools record’s facts, per conjunct (the settings where `requestFacts` would write an ask)', () => {
    const recordFor = async (
      promptCache: ConstructorParameters<typeof AnthropicProvider>[1],
      url?: string,
    ): Promise<Record<string, unknown>> => {
      baseURL = url;
      mockCreate.mockResolvedValueOnce(text('{"answer":"x"}', 1));
      const result = await new AnthropicProvider('claude-x', promptCache).callStepWithTools(
        'prompt',
        [tool()],
        EXECUTOR,
        {},
      );
      return (result.usage ?? [])[0] as unknown as Record<string, unknown>;
    };

    it('(a) `long`: the model, the endpoint, the split offered — and no ask', async () => {
      const custom = await recordFor({ promptCache: { value: 'long' } }, 'http://127.0.0.1:9');
      const viaDefault = await recordFor(
        { promptCache: { value: 'long' } },
        'https://api.anthropic.com',
      );
      const keys = JSON.stringify(Object.keys(custom));
      // Each fact has its own assertion. (a) red: `model` dropped; (b) prints the record's keys.
      expect(custom['model'], keys).toBe('claude-test-1');
      // (a) red: `endpoint` dropped; (b) prints the record's keys.
      expect(custom['endpoint'], keys).toBe('custom');
      // (a) red: `endpoint` dropped; (b) prints the default-address record's keys.
      expect(viaDefault['endpoint'], JSON.stringify(Object.keys(viaDefault))).toBe('default');
      // (a) red: `cache_split_offered` dropped; (b) prints the record's keys.
      expect(custom['cache_split_offered'], keys).toBe(true);
      // (a) red when `requestFacts` is used (each ask key appears); (b) prints the record's keys.
      expect('cache_requested' in custom, keys).toBe(false);
      expect('cache_lifetime_s' in custom, keys).toBe(false);
      expect('cache_ttl_sent' in custom, keys).toBe(false);
    });

    it('(b) `long` stated by a runner: no source and no runner on the record', async () => {
      const r = await recordFor({
        promptCache: { value: 'long', source: 'stated', by: 'realm agent' },
      });
      const keys = JSON.stringify(Object.keys(r));
      // (a) red when `requestFacts` is used (each key appears); (b) prints the record's keys.
      expect('cache_requested_source' in r, keys).toBe(false);
      expect('cache_requested_by' in r, keys).toBe(false);
    });

    it('(c) `auto` with gaps given: no `cache_auto` on the record', async () => {
      const r = await recordFor({
        promptCache: { value: 'auto', auto: { basis: 'listen_trigger_gaps', gaps_s: [420] } },
      });
      // (a) red when `requestFacts` is used; (b) prints the record's keys.
      expect('cache_auto' in r, JSON.stringify(Object.keys(r))).toBe(false);
    });
  });
});
