// openai-provider.test.ts — Tests for OpenAIProvider callStep and callStepWithTools.
// All tests mock the openai package — no real API calls are made.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './openai-provider.js';
import { WorkflowError } from '@sensigo/realm';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

// ---------- shared mock for the openai package ----------------------------
// mockCreate is captured here so each test can configure it via mockResolvedValueOnce.
const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

// ---------- response builders ---------------------------------------------

function makeToolCallResponse(
  calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>,
) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          })),
        },
      },
    ],
  };
}

function makeTextResponse(content: string) {
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: undefined } }],
  };
}

// ---------- helpers -------------------------------------------------------

const NOOP_EXECUTOR = async () => ({});

function oneTool(id = 'srv:op'): ToolDefinition {
  const colonIdx = id.indexOf(':');
  return {
    id,
    serverId: id.slice(0, colonIdx),
    name: id.slice(colonIdx + 1),
    description: 'A tool',
    inputSchema: {},
  };
}

// =========================================================================
// callStep tests
// =========================================================================
describe('OpenAIProvider.callStep', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns parsed JSON from the model response', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"result":"ok"}'));
    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStep('step prompt');
    expect(result).toEqual({ result: 'ok' });
  });

  it('retries once on non-JSON response and returns valid JSON on retry', async () => {
    mockCreate
      .mockResolvedValueOnce(makeTextResponse('not JSON'))
      .mockResolvedValueOnce(makeTextResponse('{"result":"ok"}'));
    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStep('step prompt');
    expect(result).toEqual({ result: 'ok' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('uses response_format json_object (no regression from callStepWithTools changes)', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new OpenAIProvider('gpt-4o');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      response_format: { type: 'json_object' },
    });
  });

  it('callStep with --base-url: response_format is NOT sent to compat endpoints', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new OpenAIProvider('gpt-4o', 'https://compat.endpoint.com');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('response_format');
  });

  // -----------------------------------------------------------------------
  // Correction D2: redaction symmetry — mirrors the AnthropicProvider redaction test.
  // -----------------------------------------------------------------------
  it('redaction: a failure-path model string containing a secret is redacted in the thrown error', async () => {
    vi.stubEnv('OPENAI_TEST_SECRET', 'super-secret-value-123');
    mockCreate
      .mockResolvedValueOnce(makeTextResponse('leak super-secret-value-123 here, not JSON'))
      .mockResolvedValueOnce(makeTextResponse('leak super-secret-value-123 here again, not JSON'));
    const provider = new OpenAIProvider('gpt-4o');
    const err = await provider.callStep('prompt').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toContain('super-secret-value-123');
    expect(message).toContain('[REDACTED]');
    vi.unstubAllEnvs();
  });
});

// =========================================================================
// callStepWithTools tests
// =========================================================================
describe('OpenAIProvider.callStepWithTools', () => {
  beforeEach(() => mockCreate.mockReset());

  // -----------------------------------------------------------------------
  // 1. Basic tool call loop
  // -----------------------------------------------------------------------
  it('tool call loop: executor called → result appended → LLM returns final JSON', async () => {
    const executor = vi.fn().mockResolvedValue({ content: 'file data' });
    mockCreate
      .mockResolvedValueOnce(
        makeToolCallResponse([{ id: 'call_abc', name: 'get_file', args: { path: 'README.md' } }]),
      )
      .mockResolvedValueOnce(makeTextResponse('{"summary":"ok"}'));

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools(
      'prompt',
      [oneTool('github:get_file')],
      executor,
      {},
    );

    expect(result.output).toEqual({ summary: 'ok' });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe('get_file');
    expect(result.toolCalls[0].server_id).toBe('github');
    expect(executor).toHaveBeenCalledWith('github:get_file', { path: 'README.md' });
  });

  // -----------------------------------------------------------------------
  // 2. max_tool_calls reached → final extraction fires → valid JSON returned
  // -----------------------------------------------------------------------
  it('max_tool_calls reached → final extraction prompt sent → returns output', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      maxToolCalls: 1,
    });

    expect(result.output).toEqual({ answer: 'done' });
    // Verify the final extraction user message was appended before the second API call
    const secondCallMsgs = mockCreate.mock.calls[1][0].messages as Array<{
      role: string;
      content: string;
    }>;
    const userMsgs = secondCallMsgs.filter((m) => m.role === 'user');
    expect(userMsgs.at(-1)?.content).toContain('maximum number of tool calls');
  });

  // -----------------------------------------------------------------------
  // 3. max_tool_calls reached → final extraction fails schema → throws ENGINE_STEP_FAILED
  // -----------------------------------------------------------------------
  it('max_tool_calls reached → final extraction fails schema → throws ENGINE_STEP_FAILED', async () => {
    const schema = { required: ['answer', 'confidence'] };
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"answer":"yes"}')); // 'confidence' missing

    const provider = new OpenAIProvider('gpt-4o');
    const err = await provider
      .callStepWithTools('prompt', [oneTool()], executor, {
        maxToolCalls: 1,
        inputSchema: schema,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorkflowError);
    expect((err as WorkflowError).code).toBe('ENGINE_STEP_FAILED');
  });

  // -----------------------------------------------------------------------
  // 4. Tool timeout → error as tool result with tool_call_id echoed → slot consumed
  // -----------------------------------------------------------------------
  it('tool timeout fires → error result with tool_call_id echoed → slot consumed → loop completes', async () => {
    // Use a very short real timeout (1ms) rather than fake timers to avoid complexity.
    const hangingExecutor = vi.fn().mockReturnValue(new Promise<unknown>(() => {}));
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'tc_timeout', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"done":true}'));

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools('p', [oneTool()], hangingExecutor, {
      toolTimeoutMs: 1, // fires after 1ms real time
      maxToolCalls: 1,
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].error).toBeDefined();

    const msgs = mockCreate.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const toolMsg = msgs.find((m) => m['role'] === 'tool') as Record<string, unknown>;
    expect(toolMsg['tool_call_id']).toBe('tc_timeout');
    expect(String(toolMsg['content'])).toMatch(/Error:/);
  });

  // -----------------------------------------------------------------------
  // 5. Errored tool call → error appended as tool result → loop continues (not thrown)
  // -----------------------------------------------------------------------
  it('errored tool call: executor throws → error appended as tool result → loop continues', async () => {
    const failExecutor = vi.fn().mockRejectedValue(new Error('upstream failure'));
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"result":"ok"}'));

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools('prompt', [oneTool()], failExecutor, {});

    expect(result.output).toEqual({ result: 'ok' });
    expect(result.toolCalls[0].error).toBe('upstream failure');
    expect(result.toolCalls[0].result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 6. tool_call_id round-trip — captured verbatim, echoed in tool response
  // -----------------------------------------------------------------------
  it('tool_call_id is captured verbatim and echoed in the tool response message', async () => {
    const verbatimId = 'call_xyz_very_specific_12345';
    const executor = vi.fn().mockResolvedValue('result');
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse([{ id: verbatimId, name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"ok":true}'));

    const provider = new OpenAIProvider('gpt-4o');
    await provider.callStepWithTools('prompt', [oneTool()], executor, {});

    const msgs = mockCreate.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const toolMsg = msgs.find((m) => m['role'] === 'tool') as Record<string, unknown>;
    expect(toolMsg['tool_call_id']).toBe(verbatimId);
  });

  // -----------------------------------------------------------------------
  // 7. Non-string MCP result → JSON.stringify applied
  // -----------------------------------------------------------------------
  it('non-string MCP result is JSON.stringified before appending as tool content', async () => {
    const objResult = { data: [1, 2, 3] };
    const executor = vi.fn().mockResolvedValue(objResult);
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"ok":true}'));

    const provider = new OpenAIProvider('gpt-4o');
    await provider.callStepWithTools('prompt', [oneTool()], executor, {});

    const msgs = mockCreate.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const toolMsg = msgs.find((m) => m['role'] === 'tool') as Record<string, unknown>;
    expect(toolMsg['content']).toBe(JSON.stringify(objResult));
  });

  // -----------------------------------------------------------------------
  // 8. Sanitization — Bearer token in tool result is stripped
  // -----------------------------------------------------------------------
  it('sanitization: bearer token in tool result content is stripped before appending', async () => {
    const tokenResult = 'Fetched data. Bearer secrettoken123 is the auth.';
    const executor = vi.fn().mockResolvedValue(tokenResult);
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"ok":true}'));

    const provider = new OpenAIProvider('gpt-4o');
    await provider.callStepWithTools('prompt', [oneTool()], executor, {});

    const msgs = mockCreate.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const toolMsg = msgs.find((m) => m['role'] === 'tool') as Record<string, unknown>;
    expect(String(toolMsg['content'])).not.toContain('secrettoken123');
    expect(String(toolMsg['content'])).toContain('[REDACTED]');
  });

  // -----------------------------------------------------------------------
  // 9. Error content: when sanitized error is empty → 'Error: (redacted)'
  // -----------------------------------------------------------------------
  it('when sanitized error string is empty, tool result content is "Error: (redacted)"', async () => {
    // An error with an empty message produces sanitizeError('') === '' → fallback fires.
    const failExecutor = vi.fn().mockRejectedValue(new Error(''));
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"ok":true}'));

    const provider = new OpenAIProvider('gpt-4o');
    await provider.callStepWithTools('prompt', [oneTool()], failExecutor, {});

    const msgs = mockCreate.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const toolMsg = msgs.find((m) => m['role'] === 'tool') as Record<string, unknown>;
    expect(toolMsg['content']).toBe('Error: (redacted)');
  });

  // -----------------------------------------------------------------------
  // 10. Batch of N tool calls → N records + N tool messages
  // -----------------------------------------------------------------------
  it('batch of N tool calls: tool_call_count increments N times; N tool messages appended', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    mockCreate
      .mockResolvedValueOnce(
        makeToolCallResponse([
          { id: 'b1', name: 't1' },
          { id: 'b2', name: 't2' },
          { id: 'b3', name: 't3' },
        ]),
      )
      .mockResolvedValueOnce(makeTextResponse('{"done":true}'));

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools(
      'prompt',
      [oneTool('srv:t1'), oneTool('srv:t2'), oneTool('srv:t3')],
      executor,
      {},
    );

    expect(result.toolCalls).toHaveLength(3);
    const msgs = mockCreate.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const toolMsgs = msgs.filter((m) => m['role'] === 'tool');
    expect(toolMsgs).toHaveLength(3);
  });

  // -----------------------------------------------------------------------
  // 11. Mid-batch budget exhaustion
  // -----------------------------------------------------------------------
  it('mid-batch budget exhaustion: first K execute, remaining get budget error, final extraction fires', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    mockCreate
      .mockResolvedValueOnce(
        makeToolCallResponse([
          { id: 'x1', name: 't1' },
          { id: 'x2', name: 't2' }, // budget exhausted here
          { id: 'x3', name: 't3' }, // budget exhausted here
        ]),
      )
      .mockResolvedValueOnce(makeTextResponse('{"final":true}'));

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools(
      'prompt',
      [oneTool('srv:t1'), oneTool('srv:t2'), oneTool('srv:t3')],
      executor,
      { maxToolCalls: 1 },
    );

    // Only x1 was actually executed
    expect(result.toolCalls).toHaveLength(1);
    expect(result.output).toEqual({ final: true });

    const msgs = mockCreate.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    const toolMsgs = msgs.filter((m) => m['role'] === 'tool');
    // All 3 must have tool responses (no orphaned tool_call_ids)
    expect(toolMsgs).toHaveLength(3);
    expect(toolMsgs[1]['tool_call_id']).toBe('x2');
    expect(toolMsgs[1]['content']).toBe('Error: tool call budget exhausted');
    expect(toolMsgs[2]['tool_call_id']).toBe('x3');
    expect(toolMsgs[2]['content']).toBe('Error: tool call budget exhausted');

    // Final extraction user message was appended
    const userMsgs = msgs.filter((m) => m['role'] === 'user') as Array<{ content: string }>;
    expect(userMsgs.at(-1)?.content).toContain('maximum number of tool calls');
  });

  // -----------------------------------------------------------------------
  // 12. inputSchema present → response_format is json_object (schema enforced via system prompt + validation loop)
  // -----------------------------------------------------------------------
  it('inputSchema present → response_format is json_object', async () => {
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"answer":"yes"}'));

    const provider = new OpenAIProvider('gpt-4o');
    await provider.callStepWithTools('prompt', [], NOOP_EXECUTOR, { inputSchema: schema });

    expect(mockCreate.mock.calls[0][0].response_format).toEqual({ type: 'json_object' });
  });

  // -----------------------------------------------------------------------
  // 13. compat endpoint (--base-url), inputSchema absent → response_format is NOT present
  // -----------------------------------------------------------------------
  it('compat endpoint (--base-url), inputSchema absent → response_format is NOT present', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));

    const provider = new OpenAIProvider('gpt-4o', 'https://compat.endpoint.com');
    await provider.callStepWithTools('prompt', [], NOOP_EXECUTOR, {});

    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('response_format');
  });

  // -----------------------------------------------------------------------
  // 13b. native endpoint, inputSchema absent → response_format IS present
  // -----------------------------------------------------------------------
  it('native endpoint, inputSchema absent → response_format IS present', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));

    const provider = new OpenAIProvider('gpt-4o');
    await provider.callStepWithTools('prompt', [], NOOP_EXECUTOR, {});

    expect(mockCreate.mock.calls[0][0].response_format).toEqual({ type: 'json_object' });
  });

  // -----------------------------------------------------------------------
  // 14. callStep still uses json_object (no regression)
  // -----------------------------------------------------------------------
  it('callStep still uses json_object response_format after the provider was modified', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"stable":true}'));

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStep('verify callStep unchanged');

    expect(result).toEqual({ stable: true });
    expect(mockCreate.mock.calls[0][0].response_format).toEqual({ type: 'json_object' });
    // callStepWithTools-style fields must NOT be present in callStep requests
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('tools');
  });

  // -----------------------------------------------------------------------
  // 15. max_fan_out: 1 — second start_run call triggers final extraction
  // -----------------------------------------------------------------------
  it('max_fan_out: 1 — second start_run call triggers final extraction', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    mockCreate
      .mockResolvedValueOnce(
        makeToolCallResponse([
          { id: 'c1', name: 'start_run' },
          { id: 'c2', name: 'start_run' },
        ]),
      )
      .mockResolvedValueOnce(makeTextResponse('{"done":true}'));

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools(
      'prompt',
      [oneTool('realm:start_run')],
      executor,
      { maxFanOut: 1 },
    );

    expect(result.output).toEqual({ done: true });
    // Only the first start_run should have been executed; second was budget-blocked
    expect(executor).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 16. max_fan_out: undefined — start_run calls are not capped
  // -----------------------------------------------------------------------
  it('max_fan_out: undefined — start_run calls are not capped', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    mockCreate
      .mockResolvedValueOnce(
        makeToolCallResponse([
          { id: 'c1', name: 'start_run' },
          { id: 'c2', name: 'start_run' },
        ]),
      )
      .mockResolvedValueOnce(makeTextResponse('{"done":true}'));

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools(
      'prompt',
      [oneTool('realm:start_run')],
      executor,
      {},
    );

    expect(result.output).toEqual({ done: true });
    expect(executor).toHaveBeenCalledTimes(2);
  });
});

// =========================================================================
// capabilities() tests
// =========================================================================
describe('OpenAIProvider.capabilities', () => {
  beforeEach(() => mockCreate.mockReset());

  // -----------------------------------------------------------------------
  // 15. jsonMode: true for native OpenAI (no baseUrl)
  // -----------------------------------------------------------------------
  it('capabilities() returns jsonMode: true for native OpenAI (no baseUrl)', () => {
    const provider = new OpenAIProvider('gpt-4o');
    expect(provider.capabilities()).toEqual({ jsonMode: true });
  });

  // -----------------------------------------------------------------------
  // 16. jsonMode: false when baseUrl is set
  // -----------------------------------------------------------------------
  it('capabilities() returns jsonMode: false when baseUrl is set', () => {
    const provider = new OpenAIProvider('gpt-4o', 'https://compat.example.com');
    expect(provider.capabilities()).toEqual({ jsonMode: false });
  });

  // -----------------------------------------------------------------------
  // 17. callStep with baseUrl — response_format is NOT in request
  // -----------------------------------------------------------------------
  it('callStep with baseUrl — response_format is NOT in request', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new OpenAIProvider('some-model', 'https://compat.example.com');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('response_format');
  });

  // -----------------------------------------------------------------------
  // 18. callStepWithTools with baseUrl and inputSchema — response_format is NOT in request
  // -----------------------------------------------------------------------
  it('callStepWithTools with baseUrl and inputSchema — response_format is NOT in request', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new OpenAIProvider('some-model', 'https://compat.example.com');
    await provider.callStepWithTools('prompt', [], NOOP_EXECUTOR, {
      inputSchema: { required: ['x'] },
    });
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('response_format');
  });
});
