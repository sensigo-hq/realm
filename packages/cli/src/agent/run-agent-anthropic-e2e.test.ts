// run-agent-anthropic-e2e.test.ts — End-to-end P0 coverage (Group A, robust-anthropic-provider,
// mandate test 1, load-bearing): an execution:agent step declaring ONLY output_schema, driven
// through runAgent() with a REAL AnthropicProvider (the @anthropic-ai/sdk package mocked — no real
// API calls). This is the exact scenario the FR names: output_schema (never input_schema) is what
// the ENGINE validates the agent's submission against, and until Part 1 the provider was never fed
// it at all.
//
// RED-before (verified manually by stashing the Part 1/3 source changes and re-running this file):
// callStep received `undefined` for its schema (Part 1 not yet routing output_schema), offered no
// __realm_submit__ tool, and its naive `JSON.parse` threw on the fenced ```json answer below → one
// nudge-retry → threw again → runAgent() returned 'failed'. GREEN (this file, current code): the
// model can either call __realm_submit__ (tool_use.input arrives pre-parsed) or answer in fenced
// text (caught by the extractJsonObject fallback) — both succeed and the step completes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgent } from './run-agent.js';
import type { AgentDeps } from './run-agent.js';
import type { WorkflowDefinition } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { AnthropicProvider } from './providers/anthropic-provider.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

function makeToolUseResponse(input: Record<string, unknown>) {
  return {
    content: [{ type: 'tool_use', id: 'submit1', name: '__realm_submit__', input }],
  };
}
function makeTextResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

function makeWorkflowStore(def: WorkflowDefinition) {
  return {
    async register() {},
    async get() {
      return def;
    },
    async list() {
      return [def];
    },
  };
}

// Mirrors assess_message_actionability / classify_intent (the flagship consumer workflow,
// cs1-ticket-classifier): an agent step declaring ONLY output_schema, no input_schema.
const outputSchemaOnlyWorkflow: WorkflowDefinition = {
  id: 'classify-wf',
  name: 'Classify',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    classify_intent: {
      description: 'Classify the message intent',
      execution: 'agent',
      output_schema: {
        type: 'object',
        properties: { category: { type: 'string' } },
        required: ['category'],
      },
    },
  },
};

function makeDeps(): AgentDeps {
  return {
    store: new InMemoryStore(),
    workflowStore: makeWorkflowStore(outputSchemaOnlyWorkflow),
    provider: new AnthropicProvider('claude-sonnet-4-5'),
    registry: createDefaultRegistry(),
  };
}

describe('runAgent + AnthropicProvider — P0 output_schema-only agent step (GREEN)', () => {
  beforeEach(() => mockCreate.mockReset());

  it('model calls __realm_submit__ (tool_use.input arrives pre-parsed) → step completes', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));

    const result = await runAgent(makeDeps(), {
      definition: outputSchemaOnlyWorkflow,
      params: {},
    });

    expect(result).toBe('completed');
    // Confirms Part 1 routed output_schema to the provider: the tool was actually offered.
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      tools: [expect.objectContaining({ name: '__realm_submit__' })],
      tool_choice: { type: 'auto' },
    });
  });

  it('model answers in fenced markdown JSON (extractor fallback) → step completes', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('```json\n{"category":"billing"}\n```'));

    const result = await runAgent(makeDeps(), {
      definition: outputSchemaOnlyWorkflow,
      params: {},
    });

    expect(result).toBe('completed');
  });
});
