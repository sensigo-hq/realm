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

  // -----------------------------------------------------------------------
  // P0: schema present → offers __realm_submit__ at tool_choice:'auto'; tool_use.input returned
  // directly (no parse step).
  // -----------------------------------------------------------------------
  it('schema present: offers __realm_submit__ at tool_choice:auto; tool_use.input returned directly', async () => {
    const schema = { type: 'object', properties: { category: { type: 'string' } } };
    mockCreate.mockResolvedValueOnce(
      makeToolUseResponse([
        { id: 'submit1', name: '__realm_submit__', input: { category: 'billing' } },
      ]),
    );
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStep('prompt', schema);

    expect(result).toEqual({ category: 'billing' });
    expect(mockCreate.mock.calls[0][0].tool_choice).toEqual({ type: 'auto' }); // never forced
    expect(mockCreate.mock.calls[0][0].tools).toEqual([
      expect.objectContaining({ name: '__realm_submit__', input_schema: schema }),
    ]);
  });

  it('schema present, no tool offered without a schema: absent schema sends no tools/tool_choice', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    await provider.callStep('prompt'); // no schema
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('tools');
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('tool_choice');
  });

  // -----------------------------------------------------------------------
  // Mandate test 6: no-tool_use / truncation guard.
  // -----------------------------------------------------------------------
  it('a text block with no tool_use (schema present) falls back to the extractor cleanly (no raw TypeError)', async () => {
    const schema = { type: 'object', properties: { x: { type: 'string' } } };
    mockCreate.mockResolvedValueOnce(makeTextResponse('```json\n{"x":"ok"}\n```'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStep('prompt', schema);
    expect(result).toEqual({ x: 'ok' });
  });

  it('stop_reason: max_tokens with no usable object → sanitized truncation error (never a silent partial)', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'incomplete respo' }],
        stop_reason: 'max_tokens',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'still incomplete' }],
        stop_reason: 'max_tokens',
      });
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const err = await provider.callStep('prompt').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowError);
    expect((err as WorkflowError).code).toBe('ENGINE_STEP_FAILED');
    expect((err as WorkflowError).message).toContain('truncated');
    expect((err as WorkflowError).message).toContain('max_tokens');
  });

  it('a non-max_tokens failure (e.g. end_turn) still gets the generic non-JSON error, not the truncation one', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'not JSON' }],
        stop_reason: 'end_turn',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'still not JSON' }],
        stop_reason: 'end_turn',
      });
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const err = await provider.callStep('prompt').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowError);
    expect((err as WorkflowError).message).not.toContain('truncated');
    expect((err as WorkflowError).message).toContain('non-JSON content after retry');
  });

  // -----------------------------------------------------------------------
  // Mandate test 7: redaction — closes the historical :94 gap (a plain, unredacted Error).
  // -----------------------------------------------------------------------
  it('redaction: a failure-path model string containing a secret is redacted in the thrown error', async () => {
    vi.stubEnv('ANTHROPIC_TEST_SECRET', 'super-secret-value-123');
    mockCreate
      .mockResolvedValueOnce(makeTextResponse('leak super-secret-value-123 here, not JSON'))
      .mockResolvedValueOnce(makeTextResponse('leak super-secret-value-123 here again, not JSON'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const err = await provider.callStep('prompt').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorkflowError);
    const message = (err as WorkflowError).message;
    expect(message).not.toContain('super-secret-value-123');
    expect(message).toContain('[REDACTED]');
    vi.unstubAllEnvs();
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
  it('max_tool_calls reached, schema present → final extraction offers __realm_submit__ at tool_choice:auto', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { id: 'submit1', name: '__realm_submit__', input: { answer: 'done' } },
        ]),
      );

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      maxToolCalls: 1,
      inputSchema: schema,
    });

    // tool_use.input arrives pre-parsed — no parse step.
    expect(result.output).toEqual({ answer: 'done' });
    const finalCallOpts = mockCreate.mock.calls[1][0];
    expect(finalCallOpts.tool_choice).toEqual({ type: 'auto' }); // never forced — preserves reasoning
    expect(finalCallOpts.tools).toEqual([
      expect.objectContaining({ name: '__realm_submit__', input_schema: schema }),
    ]);
    expect(finalCallOpts).not.toHaveProperty('response_format');
  });

  it('max_tool_calls reached, NO schema → final extraction still forces text (tool_choice:none, no tools)', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      maxToolCalls: 1,
    });

    // No schema → can't type a tool → falls straight to the extractor on plain text.
    expect(result.output).toEqual({ answer: 'done' });
    const finalCallOpts = mockCreate.mock.calls[1][0];
    expect(finalCallOpts.tool_choice).toEqual({ type: 'none' });
    expect(finalCallOpts).not.toHaveProperty('tools');
    expect(finalCallOpts).not.toHaveProperty('response_format');
  });

  // -----------------------------------------------------------------------
  // Mandate test 4: synthetic-tool-not-in-trace — __realm_submit__ is an extraction mechanism,
  // never an agent-chosen tool, so it must never pollute stepMeta.toolCalls (run-agent.ts:487).
  // -----------------------------------------------------------------------
  it('__realm_submit__ is excluded from result.toolCalls even though it resolved the final extraction', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    const schema = { type: 'object', properties: { answer: { type: 'string' } } };
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { id: 'submit1', name: '__realm_submit__', input: { answer: 'done' } },
        ]),
      );

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      maxToolCalls: 1,
      inputSchema: schema,
    });

    expect(result.output).toEqual({ answer: 'done' });
    expect(result.toolCalls).toHaveLength(1); // only the real 'op' call — not __realm_submit__
    expect(result.toolCalls.map((c) => c.tool)).not.toContain('__realm_submit__');
  });

  // -----------------------------------------------------------------------
  // Mandate test 5: tools-path degradation — a fenced natural-completion answer is caught on
  // the FIRST such turn via extractJsonObject, proving the :320 fix (previously tryParseJson
  // would fail on a fenced answer and nudge the model up to maxCalls).
  // -----------------------------------------------------------------------
  it('a fenced natural-completion answer is caught immediately (≤2 API calls, not maxCalls)', async () => {
    const executor = vi.fn().mockResolvedValue('file data');
    const schema = {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    };
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'get_file' }]))
      .mockResolvedValueOnce(makeTextResponse('```json\n{"summary":"ok"}\n```'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools(
      'prompt',
      [oneTool('github:get_file')],
      executor,
      { inputSchema: schema, maxToolCalls: 20 }, // generous budget — proves this isn't exhaustion
    );

    expect(result.output).toEqual({ summary: 'ok' });
    expect(mockCreate).toHaveBeenCalledTimes(2); // tool call + fenced natural completion — done
  });

  // -----------------------------------------------------------------------
  // 3. max_tool_calls reached → final extraction fails schema → throws ENGINE_STEP_FAILED
  // -----------------------------------------------------------------------
  // Note: performFinalExtraction no longer gates on validateSchema (schema conformance is the
  // engine Ajv validators' job) — a tool_use.input or an extractable object is now accepted
  // directly. This test is rewritten to a GENUINE total-failure: no tool_use match AND no
  // extractable JSON object anywhere in the text.
  it('max_tool_calls reached → final extraction produces no usable object → throws ENGINE_STEP_FAILED', async () => {
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('I was unable to determine a final answer.'));

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
      .mockResolvedValueOnce(
        makeToolUseResponse([{ id: 'submit1', name: '__realm_submit__', input: { done: true } }]),
      );

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('p', [oneTool()], hangingExecutor, {
      toolTimeoutMs: 1, // 1ms real timer
      maxToolCalls: 1, // ensures final extraction fires
      inputSchema: { type: 'object', properties: { done: { type: 'boolean' } } },
    });

    // Final extraction resolved via tool_use.input this time — no parse step.
    expect(result.output).toEqual({ done: true });
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

    // Final extraction call offers the submit tool at tool_choice:'auto' (schema present).
    expect(mockCreate.mock.calls[1][0].tool_choice).toEqual({ type: 'auto' });
    expect(mockCreate.mock.calls[1][0].tools).toEqual([
      expect.objectContaining({ name: '__realm_submit__' }),
    ]);
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
    const schema = { type: 'object', properties: { final: { type: 'boolean' } } };
    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { id: 'x1', name: 't1' }, // executes, fills the 1-slot budget
          { id: 'x2', name: 't2' }, // budget exhausted
          { id: 'x3', name: 't3' }, // budget exhausted
        ]),
      )
      // Fenced text this time — proves the P1 extractor works inside performFinalExtraction too.
      .mockResolvedValueOnce(makeTextResponse('```json\n{"final":true}\n```'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools(
      'prompt',
      [oneTool('srv:t1'), oneTool('srv:t2'), oneTool('srv:t3')],
      executor,
      { maxToolCalls: 1, inputSchema: schema },
    );

    expect(result.toolCalls).toHaveLength(1); // only x1 was actually executed
    expect(result.output).toEqual({ final: true }); // extracted from the fenced text block

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

    // Final extraction call now offers __realm_submit__ at tool_choice:'auto' (schema present).
    expect(mockCreate.mock.calls[1][0].tool_choice).toEqual({ type: 'auto' });
    expect(mockCreate.mock.calls[1][0].tools).toEqual([
      expect.objectContaining({ name: '__realm_submit__', input_schema: schema }),
    ]);
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
    const schema = { type: 'object', properties: { done: { type: 'boolean' } } };
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
      { maxFanOut: 1, inputSchema: schema },
    );

    expect(result.output).toEqual({ done: true });
    // Only the first start_run should have been executed; second was budget-blocked
    expect(executor).toHaveBeenCalledTimes(1);
    // Final extraction offers __realm_submit__ at tool_choice:'auto' (schema present).
    expect(mockCreate.mock.calls[1][0].tool_choice).toEqual({ type: 'auto' });
    expect(mockCreate.mock.calls[1][0].tools).toEqual([
      expect.objectContaining({ name: '__realm_submit__' }),
    ]);
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
