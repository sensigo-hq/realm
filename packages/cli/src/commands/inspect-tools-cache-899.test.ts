// inspect-tools-cache-899.test.ts — issue #899 at `realm run inspect`: a tool step that used up its
// tool calls sent its last request (the final extraction) with no cache marker, so that request
// records no ask, and the step's `asked for` words end with `(recorded by N−1 of N requests)`. On
// OpenAI every request records `provider_rules`, so an OpenAI step shows no count.
//
// Driven through the real `runAgent` with the REAL `AnthropicProvider` / `OpenAIProvider` over a
// mocked SDK client, so each record comes from the provider code #899 changes; the MCP client is a
// double. Every value is a fake. Each assertion names (a) the change that turns it red and (b) what
// it prints when it fails: the step's cache line (a test value, no prompt text, no key).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgent } from '../agent/run-agent.js';
import type { RunRecord, WorkflowDefinition } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import type { McpClient, McpTool } from '../agent/mcp/mcp-extensions.js';
import { AnthropicProvider } from '../agent/providers/anthropic-provider.js';
import { OpenAIProvider } from '../agent/providers/openai-provider.js';
import type { LlmProvider } from '../agent/providers/llm-provider.js';
import { inspectRun } from './inspect.js';

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

beforeEach(() => {
  anthropicCreate.mockReset();
  openaiCreate.mockReset();
});

const ANTHROPIC_USAGE = {
  input_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 1,
};
const anthropicToolUse = (n: number) => ({
  model: 'claude-test-1',
  content: [{ type: 'tool_use', id: `toolu_${n}`, name: 't', input: {} }],
  usage: ANTHROPIC_USAGE,
});
const anthropicAnswer = (blocks: unknown[]) => ({
  model: 'claude-test-1',
  content: blocks,
  usage: ANTHROPIC_USAGE,
});
const OPENAI_USAGE = { prompt_tokens: 10, completion_tokens: 1 };
const openaiToolCall = (n: number) => ({
  model: 'gpt-test-1',
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: `call_${n}`, type: 'function', function: { name: 't', arguments: '{}' } },
        ],
      },
    },
  ],
  usage: OPENAI_USAGE,
});
const openaiAnswer = (content: string) => ({
  model: 'gpt-test-1',
  choices: [{ message: { role: 'assistant', content } }],
  usage: OPENAI_USAGE,
});

const client: McpClient = {
  async connect() {},
  async getTools(_serverId: string, allowList: string[]): Promise<McpTool[]> {
    return allowList.map((name) => ({
      name,
      description: 'A tool',
      inputSchema: { type: 'object' },
    }));
  },
  async call() {
    return { result: 'ok' };
  },
  async disconnect() {},
};

/** One tools step `classify` with a budget of two tool calls. */
const def = {
  id: 'tools-cache-899',
  name: 'tools cache',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-srv'] }],
  steps: {
    classify: {
      description: 'Classify',
      execution: 'agent',
      tools: ['srv:t'],
      max_tool_calls: 2,
      output_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['category'],
        properties: { category: { type: 'string' } },
      },
    },
  },
} as unknown as WorkflowDefinition;

/** Drives the workflow with `provider`, then returns the step's `asked for` line from inspect. */
async function cacheLineAfter(provider: LlmProvider): Promise<{ requests: number; line: string }> {
  const store = new InMemoryStore();
  const workflowStore = {
    async register() {},
    async get() {
      return def;
    },
    async list() {
      return [def];
    },
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runAgent(
      {
        store,
        workflowStore,
        provider,
        registry: createDefaultRegistry(),
        mcpClientFactory: () => client,
      },
      { definition: def, params: {} },
    );
  } finally {
    vi.restoreAllMocks();
  }
  const run = (await store.list())[0]! as RunRecord;
  const entry = run.evidence.filter((e) => e.step_id === 'classify').at(-1);
  const requests = entry?.diagnostics?.cache?.requests?.length ?? 0;
  const out = await inspectRun(run.id, store, workflowStore);
  const line = out.split('\n').find((l) => l.includes('asked for')) ?? '(no asked-for line)';
  return { requests, line: line.trim() };
}

const anthropic = (value: 'short' | 'off') =>
  new AnthropicProvider('claude-x', {
    promptCache: { value, source: 'stated', by: 'realm agent' },
  });

describe('#899 — inspect counts the requests that recorded an ask', () => {
  // The at-stake branch. (a) red under a hand-made break that makes the final extraction record
  // `requestFacts` (its ask is then recorded, so all 3 of 3 did and the count goes); (b) prints the
  // request count and the step's cache line.
  it('M13 Anthropic, short: a step that used up its tool calls ends its asked-for words with (recorded by 2 of 3 requests)', async () => {
    anthropicCreate
      .mockResolvedValueOnce(anthropicToolUse(1))
      .mockResolvedValueOnce(anthropicToolUse(2))
      .mockResolvedValueOnce(
        anthropicAnswer([
          {
            type: 'tool_use',
            id: 'toolu_s',
            name: '__realm_submit__',
            input: { category: 'billing' },
          },
        ]),
      );
    const { requests, line } = await cacheLineAfter(anthropic('short'));
    expect({
      requests,
      suffix: /asked for 5 minutes \([^)]*\) \(recorded by 2 of 3 requests\)/.test(line),
      line,
    }).toEqual({
      requests: 3,
      suffix: true,
      line,
    });
  });

  // §3.5's sentence holds under `off` too: the main turns record `off`, the final extraction
  // nothing. (a) red under the same break; (b) prints the request count and the line.
  it('M13 Anthropic, off: the same step reads asked for no caching (…) (recorded by 2 of 3 requests)', async () => {
    anthropicCreate
      .mockResolvedValueOnce(anthropicToolUse(1))
      .mockResolvedValueOnce(anthropicToolUse(2))
      .mockResolvedValueOnce(
        anthropicAnswer([
          {
            type: 'tool_use',
            id: 'toolu_s',
            name: '__realm_submit__',
            input: { category: 'billing' },
          },
        ]),
      );
    const { requests, line } = await cacheLineAfter(anthropic('off'));
    expect({
      requests,
      suffix: /asked for no caching \([^)]*\) \(recorded by 2 of 3 requests\)/.test(line),
      line,
    }).toEqual({
      requests: 3,
      suffix: true,
      line,
    });
  });

  // A step that ends on a main turn: every request asked. (a) red when a main turn records no ask
  // (the count then appears); (b) prints the request count and the line.
  it('M13 Anthropic, short: a tool step that ends on a main turn prints no count', async () => {
    anthropicCreate
      .mockResolvedValueOnce(anthropicToolUse(1))
      .mockResolvedValueOnce(anthropicAnswer([{ type: 'text', text: '{"category":"billing"}' }]));
    const { requests, line } = await cacheLineAfter(anthropic('short'));
    expect({
      requests,
      asked: line.includes('asked for 5 minutes'),
      count: line.includes('recorded by'),
      line,
    }).toEqual({
      requests: 2,
      asked: true,
      count: false,
      line,
    });
  });

  // The OpenAI control: its last request records `provider_rules` (SW899-11), so an OpenAI step
  // that used up its tool calls shows no count — what makes §3.5's "On Anthropic" true. Existing
  // behaviour: (a) red under a hand-made break, run once, that makes the OpenAI tool loop's final
  // call record no `cache_requested`; (b) prints the request count and the line.
  it('M13 OpenAI: the same budget-exhausted step prints no count', async () => {
    openaiCreate
      .mockResolvedValueOnce(openaiToolCall(1))
      .mockResolvedValueOnce(openaiToolCall(2))
      .mockResolvedValueOnce(openaiAnswer('{"category":"billing"}'));
    const { requests, line } = await cacheLineAfter(new OpenAIProvider('gpt-test'));
    expect({
      requests,
      asked: line.includes('asked for nothing'),
      count: line.includes('recorded by'),
      line,
    }).toEqual({
      requests: 3,
      asked: true,
      count: false,
      line,
    });
  });
});
