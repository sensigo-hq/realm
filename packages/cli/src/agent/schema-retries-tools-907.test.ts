// schema-retries-tools-907.test.ts — issue #907 (riding on #899): `--schema-retries 0` does not stop
// a step that uses tools from being corrected inside its conversation. The tool loop of each
// provider answers a schema-invalid reply with a correction and asks again, up to the step's
// `max_tool_calls`; `--schema-retries` counts the driver's repairs after a step returns, a
// different loop. Driven through the real `runAgent` (`schemaRetries: 0`) with the REAL
// `AnthropicProvider` and `OpenAIProvider` over a mocked SDK client; the MCP client is a double.
// Every value is a fake. Each assertion names (a) the change that turns it red and (b) what it
// prints when it fails: the provider and the request count.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgent } from './run-agent.js';
import type { WorkflowDefinition } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import type { McpClient, McpTool } from './mcp/mcp-extensions.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import type { LlmProvider } from './providers/llm-provider.js';

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

/** Parses as JSON, fails the step's schema (`category` must be a string). */
const INVALID = '{"category":5}';

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

const def = {
  id: 'schema-retries-907',
  name: 'schema retries 907',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-srv'] }],
  steps: {
    classify: {
      description: 'Classify',
      execution: 'agent',
      tools: ['srv:t'],
      max_tool_calls: 4,
      output_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['category'],
        properties: { category: { type: 'string' } },
      },
    },
  },
} as unknown as WorkflowDefinition;

async function driveWithNoRetries(provider: LlmProvider): Promise<void> {
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
        schemaRetries: 0,
      },
      { definition: def, params: {} },
    );
  } finally {
    vi.restoreAllMocks();
  }
}

describe('#907 — --schema-retries 0 does not stop the in-conversation correction of a tools step', () => {
  // (a) red under a hand-made break that replaces the provider's #224 correction push with a throw
  // (the drive then stops at 2 requests); (b) prints the provider and the request count.
  it('R1 Anthropic: a tool call, then only schema-invalid text → more than 2 requests', async () => {
    anthropicCreate
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'toolu_1', name: 't', input: {} }],
      })
      .mockResolvedValue({ content: [{ type: 'text', text: INVALID }] });
    await driveWithNoRetries(new AnthropicProvider('claude-x'));
    const requests = anthropicCreate.mock.calls.length;
    expect({ provider: 'anthropic', requests, moreThanTwo: requests > 2 }).toEqual({
      provider: 'anthropic',
      requests,
      moreThanTwo: true,
    });
  });

  // The OpenAI half was a hypothesis (the audit read OP's loop, INFERRED); run first. (a) red under
  // the same break in the OpenAI tool loop; (b) prints the provider and the request count.
  it('R1 OpenAI: a tool call, then only schema-invalid text → more than 2 requests', async () => {
    openaiCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 't', arguments: '{}' } },
              ],
            },
          },
        ],
      })
      .mockResolvedValue({ choices: [{ message: { role: 'assistant', content: INVALID } }] });
    await driveWithNoRetries(new OpenAIProvider('gpt-test'));
    const requests = openaiCreate.mock.calls.length;
    expect({ provider: 'openai', requests, moreThanTwo: requests > 2 }).toEqual({
      provider: 'openai',
      requests,
      moreThanTwo: true,
    });
  });
});
