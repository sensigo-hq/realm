// anthropic-provider.test.ts — Tests for AnthropicProvider callStep and callStepWithTools.
// All tests mock the @anthropic-ai/sdk package — no real API calls are made.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';
import { WorkflowError } from '@sensigo/realm';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

// ---------- shared mock for the @anthropic-ai/sdk package -----------------
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

// ---------- response builders ---------------------------------------------

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

function makeToolUseResponse(
  calls: Array<{ id: string; name: string; input?: Record<string, unknown> }>,
) {
  return {
    content: calls.map(
      (c): ContentBlock => ({
        type: 'tool_use',
        id: c.id,
        name: c.name,
        input: c.input ?? {},
      }),
    ),
  };
}

function makeTextResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

// ---------- helpers -------------------------------------------------------

const _NOOP_EXECUTOR = async () => ({});

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
describe('AnthropicProvider.callStep', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns parsed JSON from the first text block', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"result":"ok"}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStep('step prompt');
    expect(result).toEqual({ result: 'ok' });
  });

  it('retries once on non-JSON response', async () => {
    mockCreate
      .mockResolvedValueOnce(makeTextResponse('not JSON'))
      .mockResolvedValueOnce(makeTextResponse('{"result":"ok"}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStep('prompt');
    expect(result).toEqual({ result: 'ok' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('callStep does not include response_format (Anthropic does not support it)', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('response_format');
  });

  it('callStep sends max_tokens: 8192 for claude-sonnet-4-5', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0][0].max_tokens).toBe(8192);
  });

  it('callStep sends max_tokens: 4096 for claude-3-opus-20240229', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new AnthropicProvider('claude-3-opus-20240229');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0][0].max_tokens).toBe(4096);
  });
});

// =========================================================================
// callStepWithTools tests
// =========================================================================
describe('AnthropicProvider.callStepWithTools', () => {
  beforeEach(() => mockCreate.mockReset());

  // -----------------------------------------------------------------------
  // 0. max_tokens is model-aware in the main loop call
  // -----------------------------------------------------------------------
  it('callStepWithTools main loop sends max_tokens: 8192 for claude-sonnet-4-5', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    await provider.callStepWithTools('prompt', [], _NOOP_EXECUTOR, {
      inputSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
    });
    expect(mockCreate.mock.calls[0][0].max_tokens).toBe(8192);
  });

  // -----------------------------------------------------------------------
  // 1. Basic tool call loop
  // -----------------------------------------------------------------------
  it('tool call loop: tool_use block → executor → single user message → text block → returns output', async () => {
    const executor = vi.fn().mockResolvedValue({ content: 'file data' });
    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { id: 'toolu_01abc', name: 'get_file', input: { path: 'README.md' } },
        ]),
      )
      .mockResolvedValueOnce(makeTextResponse('{"summary":"ok"}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
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
  // 2. max_tool_calls reached → final extraction uses tool_choice:none, no tools, no response_format
  // -----------------------------------------------------------------------
  it('max_tool_calls reached → final extraction has tool_choice:none, no tools, no response_format', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      maxToolCalls: 1,
    });

    expect(result.output).toEqual({ answer: 'done' });
    const finalCallOpts = mockCreate.mock.calls[1][0];
    expect(finalCallOpts.tool_choice).toEqual({ type: 'none' });
    expect(finalCallOpts).not.toHaveProperty('tools');
    expect(finalCallOpts).not.toHaveProperty('response_format');
  });

  // -----------------------------------------------------------------------
  // 3. max_tool_calls reached → final extraction fails schema → throws ENGINE_STEP_FAILED
  // -----------------------------------------------------------------------
  it('max_tool_calls reached → final extraction fails schema → throws ENGINE_STEP_FAILED', async () => {
    const schema = { required: ['answer', 'confidence'] };
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"answer":"yes"}')); // 'confidence' missing

    const provider = new AnthropicProvider('claude-sonnet-4-5');
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
  // 4. Tool timeout fires → error in tool_result block with tool_use_id echoed
  // -----------------------------------------------------------------------
  it('tool timeout fires → error accumulated as tool_result with tool_use_id echoed → slot consumed', async () => {
    const hangingExecutor = vi.fn().mockReturnValue(new Promise<unknown>(() => {}));
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'toolu_timeout', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"done":true}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('p', [oneTool()], hangingExecutor, {
      toolTimeoutMs: 1, // 1ms real timer
      maxToolCalls: 1, // ensures final extraction fires
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].error).toBeDefined();

    // The tool_result block in the user message must echo the tool_use_id
    const secondCallMsgs = mockCreate.mock.calls[1][0].messages as Array<{
      role: string;
      content: unknown;
    }>;
    const userMsg = secondCallMsgs.find((m) => m.role === 'user' && Array.isArray(m.content));
    const toolResultBlocks =
      (userMsg?.content as Array<{ type?: string; tool_use_id?: string }> | undefined) ?? [];
    const toolResult = toolResultBlocks.find((b) => b.type === 'tool_result');
    expect(toolResult?.tool_use_id).toBe('toolu_timeout');
  });

  // -----------------------------------------------------------------------
  // 5. Errored tool call → error accumulated, loop continues
  // -----------------------------------------------------------------------
  it('errored tool call: executor throws → error accumulated → loop continues', async () => {
    const failExecutor = vi.fn().mockRejectedValue(new Error('upstream failure'));
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"result":"ok"}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], failExecutor, {});

    expect(result.output).toEqual({ result: 'ok' });
    expect(result.toolCalls[0].error).toBe('upstream failure');
    expect(result.toolCalls[0].result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 6. tool_use_id round-trip — captured from response.content[i].id, echoed in tool_result
  // -----------------------------------------------------------------------
  it('tool_use_id is captured from response.content and echoed in tool_result block', async () => {
    const verbatimId = 'toolu_01XYZveryspecific12345';
    const executor = vi.fn().mockResolvedValue('result');
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: verbatimId, name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"ok":true}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    await provider.callStepWithTools('prompt', [oneTool()], executor, {});

    const msgs = mockCreate.mock.calls[1][0].messages as Array<{ role: string; content: unknown }>;
    const userMsg = msgs.find((m) => m.role === 'user' && Array.isArray(m.content));
    const blocks = userMsg?.content as Array<{ type?: string; tool_use_id?: string }> | undefined;
    const toolResult = blocks?.find((b) => b.type === 'tool_result');
    expect(toolResult?.tool_use_id).toBe(verbatimId);
  });

  // -----------------------------------------------------------------------
  // 7. Non-string MCP result → JSON.stringify'd
  // -----------------------------------------------------------------------
  it('non-string MCP result is JSON.stringified before sending as tool result content', async () => {
    const objResult = { data: [1, 2, 3] };
    const executor = vi.fn().mockResolvedValue(objResult);
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"ok":true}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    await provider.callStepWithTools('prompt', [oneTool()], executor, {});

    const msgs = mockCreate.mock.calls[1][0].messages as Array<{ role: string; content: unknown }>;
    const userMsg = msgs.find((m) => m.role === 'user' && Array.isArray(m.content));
    const blocks = userMsg?.content as Array<{ type?: string; content?: string }> | undefined;
    const toolResult = blocks?.find((b) => b.type === 'tool_result');
    expect(toolResult?.content).toBe(JSON.stringify(objResult));
  });

  // -----------------------------------------------------------------------
  // 8. Sanitization — Bearer token stripped
  // -----------------------------------------------------------------------
  it('sanitization: bearer token in tool result content is stripped before sending', async () => {
    const tokenResult = 'Fetched data. Bearer secrettoken123 is the auth.';
    const executor = vi.fn().mockResolvedValue(tokenResult);
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"ok":true}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    await provider.callStepWithTools('prompt', [oneTool()], executor, {});

    const msgs = mockCreate.mock.calls[1][0].messages as Array<{ role: string; content: unknown }>;
    const userMsg = msgs.find((m) => m.role === 'user' && Array.isArray(m.content));
    const blocks = userMsg?.content as Array<{ type?: string; content?: string }> | undefined;
    const toolResult = blocks?.find((b) => b.type === 'tool_result');
    expect(toolResult?.content).not.toContain('secrettoken123');
    expect(toolResult?.content).toContain('[REDACTED]');
  });

  // -----------------------------------------------------------------------
  // 9. Error content fallback: empty sanitized string → 'Error: (redacted)'
  // -----------------------------------------------------------------------
  it('when sanitized error string is empty, tool result content is "Error: (redacted)"', async () => {
    const failExecutor = vi.fn().mockRejectedValue(new Error(''));
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"ok":true}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    await provider.callStepWithTools('prompt', [oneTool()], failExecutor, {});

    const msgs = mockCreate.mock.calls[1][0].messages as Array<{ role: string; content: unknown }>;
    const userMsg = msgs.find((m) => m.role === 'user' && Array.isArray(m.content));
    const blocks = userMsg?.content as Array<{ type?: string; content?: string }> | undefined;
    const toolResult = blocks?.find((b) => b.type === 'tool_result');
    expect(toolResult?.content).toBe('Error: (redacted)');
  });

  // -----------------------------------------------------------------------
  // 10. Batch of N tool calls produces exactly ONE user message (key Anthropic constraint)
  // -----------------------------------------------------------------------
  it('batch of N tool calls produces exactly ONE user message with N tool_result blocks', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { id: 'b1', name: 't1' },
          { id: 'b2', name: 't2' },
          { id: 'b3', name: 't3' },
        ]),
      )
      .mockResolvedValueOnce(makeTextResponse('{"done":true}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools(
      'prompt',
      [oneTool('srv:t1'), oneTool('srv:t2'), oneTool('srv:t3')],
      executor,
      {},
    );

    expect(result.toolCalls).toHaveLength(3);

    // Second call's messages: [user:prompt, assistant:[3 tool_use], user:[3 tool_result]]
    // Length MUST be 3, not 5 (which interleaved turns would produce).
    const secondCallMsgs = mockCreate.mock.calls[1][0].messages as Array<{
      role: string;
      content: unknown;
    }>;
    expect(secondCallMsgs).toHaveLength(3);

    const userMsg = secondCallMsgs.find((m) => m.role === 'user' && Array.isArray(m.content));
    const blocks = userMsg?.content as Array<{ type?: string }> | undefined;
    const toolResults = blocks?.filter((b) => b.type === 'tool_result');
    expect(toolResults).toHaveLength(3);
  });

  // -----------------------------------------------------------------------
  // 11. Mid-batch budget exhaustion — all tool_use_ids get a response, final extraction fires
  // -----------------------------------------------------------------------
  it('mid-batch budget exhaustion: first K execute, remaining get budget error, single user message', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { id: 'x1', name: 't1' }, // executes, fills the 1-slot budget
          { id: 'x2', name: 't2' }, // budget exhausted
          { id: 'x3', name: 't3' }, // budget exhausted
        ]),
      )
      .mockResolvedValueOnce(makeTextResponse('{"final":true}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools(
      'prompt',
      [oneTool('srv:t1'), oneTool('srv:t2'), oneTool('srv:t3')],
      executor,
      { maxToolCalls: 1 },
    );

    expect(result.toolCalls).toHaveLength(1); // only x1 was actually executed
    expect(result.output).toEqual({ final: true });

    // The second call's messages must contain a user message with 3 tool_result blocks + text
    const secondCallMsgs = mockCreate.mock.calls[1][0].messages as Array<{
      role: string;
      content: unknown;
    }>;
    const userMsg = secondCallMsgs.find((m) => m.role === 'user' && Array.isArray(m.content));
    const blocks = userMsg?.content as
      | Array<{ type?: string; tool_use_id?: string; text?: string; content?: string }>
      | undefined;
    expect(blocks).toBeDefined();

    const toolResults = blocks?.filter((b) => b.type === 'tool_result') ?? [];
    expect(toolResults).toHaveLength(3);
    expect(toolResults.find((b) => b.tool_use_id === 'x2')?.content).toBe(
      'Error: tool call budget exhausted',
    );
    expect(toolResults.find((b) => b.tool_use_id === 'x3')?.content).toBe(
      'Error: tool call budget exhausted',
    );

    // Extraction text block must be present in the same user message
    const textBlock = blocks?.find((b) => b.type === 'text');
    expect(textBlock?.text).toContain('maximum number of tool calls');

    // Final extraction call must use tool_choice: none
    expect(mockCreate.mock.calls[1][0].tool_choice).toEqual({ type: 'none' });
  });

  // -----------------------------------------------------------------------
  // 12. callStep still works (no regression)
  // -----------------------------------------------------------------------
  it('callStep still works correctly after callStepWithTools was added to the class', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"stable":true}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStep('verify callStep unchanged');
    expect(result).toEqual({ stable: true });
    // callStep uses the simple messages API shape — no tools, no tool_choice
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('tools');
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('tool_choice');
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('response_format');
  });

  // -----------------------------------------------------------------------
  // 13. max_fan_out: 1 — second start_run call triggers final extraction
  // -----------------------------------------------------------------------
  it('max_fan_out: 1 — second start_run call triggers final extraction', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { id: 'tu1', name: 'start_run' },
          { id: 'tu2', name: 'start_run' },
        ]),
      )
      .mockResolvedValueOnce(makeTextResponse('{"done":true}'));

    const provider = new AnthropicProvider('claude-3-5-sonnet-20241022');
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
  // 14. max_fan_out: undefined — start_run calls are not capped
  // -----------------------------------------------------------------------
  it('max_fan_out: undefined — start_run calls are not capped', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { id: 'tu1', name: 'start_run' },
          { id: 'tu2', name: 'start_run' },
        ]),
      )
      .mockResolvedValueOnce(makeTextResponse('{"done":true}'));

    const provider = new AnthropicProvider('claude-3-5-sonnet-20241022');
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
describe('AnthropicProvider.capabilities', () => {
  // -----------------------------------------------------------------------
  // 13. AnthropicProvider inherits jsonMode: false (regression guard)
  // -----------------------------------------------------------------------
  it('capabilities() returns jsonMode: false (inherits LlmProvider default)', () => {
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    expect(provider.capabilities()).toEqual({ jsonMode: false });
  });
});
