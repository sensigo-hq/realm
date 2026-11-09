// anthropic-response-id-3m.test.ts — caching 3-M piece B1: each Anthropic request records its own
// answer's id as `response_id`, at both of the provider's push sites (the single-shot request, and
// the tool loop's one sender, which every turn and the final extraction return through). The cells
// drive the REAL SDK against the in-process stub on 127.0.0.1, which answers a distinct real-shaped
// id per request. Each stand-in key is a dummy. On a failing CI host a cell prints each recorded
// request's index, whether it asked to cache, and its `response_id`: test values only.
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';
import { startAnthropicStub, stubAnswerId } from '../test-support/anthropic-stub.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x'],
  properties: { x: { type: 'string' } },
};
const TOOL: ToolDefinition = {
  id: 'srv:lookup',
  serverId: 'srv',
  name: 'lookup',
  description: 'A tool',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
};
const EXECUTOR = async () => ({ content: [{ type: 'text', text: 'ok' }] });

type Recorded = { request_index?: number; cache_requested?: string; response_id?: string };
const show = (usage: readonly Recorded[]): string =>
  usage
    .map(
      (r) =>
        `#${String(r.request_index)} asked=${String(r.cache_requested)} response_id=${String(r.response_id)}`,
    )
    .join('\n');

/** A tool step on the stub with a budget of one tool call: its main turn, then the final extraction. */
async function toolStep(): Promise<Recorded[]> {
  const stub = await startAnthropicStub({
    firstToolCall: { match: /lookup/, arguments: {} },
    finalContent: { x: 'a' },
  });
  try {
    process.env['ANTHROPIC_BASE_URL'] = stub.baseUrl;
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-dummy-3m-b1-0000';
    const result = await new AnthropicProvider('claude-x').callStepWithTools(
      'prompt',
      [TOOL],
      EXECUTOR,
      { maxToolCalls: 1, inputSchema: SCHEMA },
    );
    return (result.usage ?? []) as Recorded[];
  } finally {
    await stub.close();
  }
}

describe('caching 3-M B1 — each Anthropic request records its own answer id', () => {
  // A single-shot step's request. Can fail: the helper left out of the single-shot site, or an
  // earlier answer's id kept. Prints the recorded requests.
  it("the single-shot request records its answer's id", async () => {
    const stub = await startAnthropicStub({ finalContent: { x: 'a' } });
    try {
      process.env['ANTHROPIC_BASE_URL'] = stub.baseUrl;
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-dummy-3m-b1-0000';
      const { usage } = await new AnthropicProvider('claude-x').callStepWithMeta('prompt', SCHEMA);
      const recorded = (usage ?? []) as Recorded[];
      expect(
        recorded.map((r) => r.response_id),
        show(recorded),
      ).toEqual([stubAnswerId(1)]);
    } finally {
      await stub.close();
    }
  });

  // A tool step's main turn, the request that asked to cache. Can fail: the helper called only at
  // the single-shot site, or an earlier answer's id kept. Prints the recorded requests.
  it("a tool step's turn records its own answer's id", async () => {
    const usage = await toolStep();
    const turns = usage.filter((r) => r.cache_requested !== undefined);
    expect(turns.length, show(usage)).toBeGreaterThan(0);
    expect(
      turns.map((r) => r.response_id),
      show(usage),
    ).toEqual(turns.map((r) => stubAnswerId((r.request_index ?? -1) + 1)));
  });

  // The final extraction, reached once the step has used up its one tool call; it asks for no
  // caching. Can fail: the helper moved from the loop's one sender into the main turns' facts, or
  // called only at the single-shot site. Prints the recorded requests.
  it("the final extraction records its own answer's id", async () => {
    const usage = await toolStep();
    const finals = usage.filter((r) => r.cache_requested === undefined);
    expect(finals.length, show(usage)).toBe(1);
    expect(finals[0]?.response_id, show(usage)).toBe(
      stubAnswerId((finals[0]?.request_index ?? -1) + 1),
    );
  });
});
