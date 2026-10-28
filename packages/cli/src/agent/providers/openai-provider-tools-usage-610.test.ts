// openai-provider-tools-usage-610.test.ts — issue #610: a tool-using step records what its model
// requests cost. Every request the tool loop sends goes through one local `bounded`, which records
// it the instant its answer arrives; the public `callStepWithTools` owns the list and attaches it to
// any throw. The SDK is mocked; each mocked answer carries DISTINCT usage, so order is checked.
// Each assertion names (a) the change that turns it red and (b) what it prints when it fails:
// counts, indexes, token numbers and key lists only.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './openai-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';
import type { LlmClock } from './agent-utils.js';

const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

const usage = (n: number) => ({
  prompt_tokens: 100 * n,
  completion_tokens: 7 * n,
  prompt_tokens_details: { cached_tokens: 10 * n },
});
const answer = (content: string, n: number) => ({
  model: 'gpt-test-1',
  choices: [{ message: { role: 'assistant', content } }],
  usage: usage(n),
});
const toolCall = (name: string, n: number, args = '{}') => ({
  model: 'gpt-test-1',
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `c${n}`, type: 'function', function: { name, arguments: args } }],
      },
    },
  ],
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
const apiError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { status });
const EXECUTOR = async () => ({ content: [{ type: 'text', text: 'ok' }] });
type Usage = Array<{ request_index: number; prompt_tokens?: number }>;
const billedOf = (err: unknown): Usage =>
  ((err as { driveCall?: { usage?: Usage } }).driveCall?.usage ?? []) as Usage;
const provider = () => new OpenAIProvider('gpt-x');

beforeEach(() => {
  mockCreate.mockReset();
});

describe('#610 — OpenAIProvider.callStepWithTools records each answered request', () => {
  it('P1, wire order: the main turn, a tool-result turn, a correction turn, the final extraction — one record each, in order', async () => {
    mockCreate
      .mockResolvedValueOnce(toolCall('t', 1))
      .mockResolvedValueOnce(answer('not json', 2))
      .mockResolvedValueOnce(toolCall('t', 3))
      .mockResolvedValueOnce(answer('{"answer":"done"}', 4));
    const result = await provider().callStepWithTools('prompt', [tool()], EXECUTOR, {
      maxToolCalls: 3,
    });
    const records = (result.usage ?? []) as Usage;
    // (a) red when `bounded` stops recording; (b) prints the count, the indexes and the prompt
    //     tokens, each against the expected.
    expect({
      creates: mockCreate.mock.calls.length,
      indexes: records.map((r) => r.request_index),
      prompt: records.map((r) => r.prompt_tokens),
      output: result.output,
    }).toEqual({
      creates: 4,
      indexes: [0, 1, 2, 3],
      prompt: [100, 200, 300, 400],
      output: { answer: 'done' },
    });
  });

  it('P2, the strict retry: a strict-carrying turn answered 400 then retried — one record, the retry’s', async () => {
    mockCreate
      .mockRejectedValueOnce(apiError(400, 'Invalid schema for function'))
      .mockResolvedValueOnce(answer('{"answer":"x"}', 5));
    const result = await provider().callStepWithTools('prompt', [tool(true)], EXECUTOR, {});
    const records = (result.usage ?? []) as Usage;
    // (a) red when the rejected attempt is recorded too (the push moved into a `finally`); (b)
    //     prints the counts and the recorded prompt tokens.
    expect({
      creates: mockCreate.mock.calls.length,
      records: records.length,
      prompt: records.map((r) => r.prompt_tokens),
    }).toEqual({ creates: 2, records: 1, prompt: [500] });
  });

  it('P3, an unknown tool name throws after two billed requests: the error carries both, in order', async () => {
    mockCreate.mockResolvedValueOnce(toolCall('t', 1)).mockResolvedValueOnce(toolCall('nope', 2));
    const err = await provider()
      .callStepWithTools('prompt', [tool()], EXECUTOR, { maxToolCalls: 5 })
      .catch((e: unknown) => e);
    // (a) red when the entry's catch does not attach what was billed; (b) prints whether it threw
    //     and the usage it carries.
    expect({
      threw: err instanceof Error,
      indexes: billedOf(err).map((r) => r.request_index),
      prompt: billedOf(err).map((r) => r.prompt_tokens),
    }).toEqual({ threw: true, indexes: [0, 1], prompt: [100, 200] });
  });

  it('P3, tool arguments that do not parse (`JSON.parse` throws): the error carries the billed request', async () => {
    mockCreate.mockResolvedValueOnce(toolCall('t', 1, '{not json'));
    const err = await provider()
      .callStepWithTools('prompt', [tool()], EXECUTOR, { maxToolCalls: 5 })
      .catch((e: unknown) => e);
    // (a) red when the entry's catch does not attach what was billed; (b) prints the error's class
    //     and the usage indexes.
    expect({
      name: (err as Error).name,
      indexes: billedOf(err).map((r) => r.request_index),
    }).toEqual({ name: 'SyntaxError', indexes: [0] });
  });

  it('P3, the final extraction does not parse: the error carries every request, the final one included', async () => {
    mockCreate.mockResolvedValueOnce(toolCall('t', 1)).mockResolvedValueOnce(answer('no json', 2));
    const err = await provider()
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
      .mockResolvedValueOnce(toolCall('t', 1))
      .mockRejectedValueOnce(apiError(500, 'server error'));
    const clock: LlmClock = { ceilingMs: 60_000 };
    const err = await provider()
      .callStepWithTools('prompt', [tool()], EXECUTOR, { maxToolCalls: 5, llmClock: clock })
      .catch((e: unknown) => e);
    const payload = (err as { driveCall?: Record<string, unknown> }).driveCall ?? {};
    // (a) red when the catch is removed or skips a payload that is there; (b) prints whether the
    //     class is kept and the usage indexes.
    expect({
      hasClass: typeof payload['error_class'] === 'string',
      indexes: billedOf(err).map((r) => r.request_index),
    }).toEqual({ hasClass: true, indexes: [0] });
  });

  it('P6, the facts: `provider_rules` and no lifetime split, as on the single-shot path', async () => {
    mockCreate.mockResolvedValueOnce(answer('{"answer":"x"}', 1));
    const result = await provider().callStepWithTools('prompt', [tool()], EXECUTOR, {});
    const r = (result.usage ?? [])[0] as unknown as Record<string, unknown>;
    // (a) red when the facts argument is dropped from `bounded`; (b) prints the two facts.
    expect({
      requested: r['cache_requested'],
      split: r['cache_split_offered'],
      model: r['model'],
    }).toEqual({ requested: 'provider_rules', split: false, model: 'gpt-test-1' });
  });
});
