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
    content: calls.map((c): ContentBlock => ({
      type: 'tool_use',
      id: c.id,
      name: c.name,
      input: c.input ?? {},
    })),
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
    expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty('response_format');
  });

  // issue #309 fix: the pre-#309 regex gave the claude-3.5 family's OWN hard cap (8192) to every
  // 4.x model too — claude-sonnet-4-5 now correctly gets the fail-forward 16384 bucket.
  it('callStep sends max_tokens: 16384 for claude-sonnet-4-5 (a 4.x model — the fail-forward bucket)', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(16384);
  });

  it('callStep sends max_tokens: 4096 for claude-3-opus-20240229', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new AnthropicProvider('claude-3-opus-20240229');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(4096);
  });

  // issue #309: the four resolveMaxTokens buckets, pinned explicitly (design record's own
  // required pin — Deliverable 3).
  describe('resolveMaxTokens buckets (issue #309)', () => {
    it('claude-3.5 family ⇒ 8192 (its own hard output cap)', async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
      await new AnthropicProvider('claude-3-5-sonnet-20241022').callStep('prompt');
      expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(8192);
    });

    it('bare legacy claude-3 (non-3.5) ⇒ 4096', async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
      await new AnthropicProvider('claude-3-opus-20240229').callStep('prompt');
      expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(4096);
    });

    it.each(['claude-3-7-sonnet-20250219', 'claude-sonnet-4-6', 'claude-opus-5'])(
      '%s ⇒ 16384 (fail-forward)',
      async (model) => {
        mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
        await new AnthropicProvider(model).callStep('prompt');
        expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(16384);
      },
    );

    it('an invented future model id ⇒ 16384 (fail-forward, never under-budgeted)', async () => {
      mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
      await new AnthropicProvider('claude-turbo-9000-preview').callStep('prompt');
      expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(16384);
    });
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
    expect(mockCreate.mock.calls[0]![0].tool_choice).toEqual({ type: 'auto' }); // never forced
    expect(mockCreate.mock.calls[0]![0].tools).toEqual([
      expect.objectContaining({ name: '__realm_submit__', input_schema: schema }),
    ]);
  });

  it('schema present, no tool offered without a schema: absent schema sends no tools/tool_choice', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    await provider.callStep('prompt'); // no schema
    expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty('tools');
    expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty('tool_choice');
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
  it('callStepWithTools main loop sends max_tokens: 16384 for claude-sonnet-4-5 (issue #309)', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    await provider.callStepWithTools('prompt', [], _NOOP_EXECUTOR, {
      inputSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
    });
    expect(mockCreate.mock.calls[0]![0].max_tokens).toBe(16384);
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
    expect(result.toolCalls[0]!.tool).toBe('get_file');
    expect(result.toolCalls[0]!.server_id).toBe('github');
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
    const finalCallOpts = mockCreate.mock.calls[1]![0];
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
    const finalCallOpts = mockCreate.mock.calls[1]![0];
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
    expect(result.toolCalls[0]!.error).toBeDefined();

    // The tool_result block in the user message must echo the tool_use_id
    const secondCallMsgs = mockCreate.mock.calls[1]![0].messages as Array<{
      role: string;
      content: unknown;
    }>;
    const userMsg = secondCallMsgs.find((m) => m.role === 'user' && Array.isArray(m.content));
    const toolResultBlocks =
      (userMsg?.content as Array<{ type?: string; tool_use_id?: string }> | undefined) ?? [];
    const toolResult = toolResultBlocks.find((b) => b.type === 'tool_result');
    expect(toolResult?.tool_use_id).toBe('toolu_timeout');

    // Final extraction call offers the submit tool at tool_choice:'auto' (schema present).
    expect(mockCreate.mock.calls[1]![0].tool_choice).toEqual({ type: 'auto' });
    expect(mockCreate.mock.calls[1]![0].tools).toEqual([
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
    expect(result.toolCalls[0]!.error).toBe('upstream failure');
    expect(result.toolCalls[0]!.result).toBeNull();
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

    const msgs = mockCreate.mock.calls[1]![0].messages as Array<{ role: string; content: unknown }>;
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

    const msgs = mockCreate.mock.calls[1]![0].messages as Array<{ role: string; content: unknown }>;
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

    const msgs = mockCreate.mock.calls[1]![0].messages as Array<{ role: string; content: unknown }>;
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

    const msgs = mockCreate.mock.calls[1]![0].messages as Array<{ role: string; content: unknown }>;
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
    const secondCallMsgs = mockCreate.mock.calls[1]![0].messages as Array<{
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
    const secondCallMsgs = mockCreate.mock.calls[1]![0].messages as Array<{
      role: string;
      content: unknown;
    }>;
    const userMsg = secondCallMsgs.find((m) => m.role === 'user' && Array.isArray(m.content));
    const blocks = userMsg?.content as
      Array<{ type?: string; tool_use_id?: string; text?: string; content?: string }> | undefined;
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
    expect(mockCreate.mock.calls[1]![0].tool_choice).toEqual({ type: 'auto' });
    expect(mockCreate.mock.calls[1]![0].tools).toEqual([
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
    expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty('tools');
    expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty('tool_choice');
    expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty('response_format');
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
    expect(mockCreate.mock.calls[1]![0].tool_choice).toEqual({ type: 'auto' });
    expect(mockCreate.mock.calls[1]![0].tools).toEqual([
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
// issue #224 — in-conversation full-AJV correction
// =========================================================================
describe('AnthropicProvider.callStepWithTools — issue #224 in-conversation AJV correction', () => {
  beforeEach(() => mockCreate.mockReset());

  const strictSchema = {
    type: 'object',
    required: ['category'],
    properties: { category: { type: 'string', enum: ['billing', 'support'] } },
    additionalProperties: false,
  };

  // -----------------------------------------------------------------------
  // Primary (D4): right keys, WRONG TYPE — corrected in-conversation, tool results retained,
  // ZERO re-execution, settles without ever reaching a drive error branch.
  // -----------------------------------------------------------------------
  it('primary: right-keys-wrong-type output is corrected IN-CONVERSATION — tool executes exactly once, no re-execution', async () => {
    const executor = vi.fn().mockResolvedValue({ content: 'file data' });
    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([{ id: 'toolu_01', name: 'get_file', input: { path: 'x' } }]),
      )
      // Right key, WRONG TYPE (number instead of the required string/enum).
      .mockResolvedValueOnce(makeTextResponse('{"category": 42}'))
      // Corrected — valid.
      .mockResolvedValueOnce(makeTextResponse('{"category": "billing"}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools(
      'prompt',
      [oneTool('github:get_file')],
      executor,
      {
        validationOutputSchema: strictSchema,
      },
    );

    expect(result.output).toEqual({ category: 'billing' });
    // Tool results retained, NOTHING re-executed — exactly one executor call, one record.
    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.correctionCount).toBe(1);
  });

  it("probe-equivalent control: a wrong-type output with NO validation*Schema configured is accepted as-is (today's pre-#224 behavior for a plugin that ignores the new fields)", async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"category": 42}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {});

    expect(result.output).toEqual({ category: 42 });
    expect(result.correctionCount).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Leak pin (D5, AC-2): the correction message contains the whitelisted summary + enum
  // allowedValues, and NEVER the offending value.
  // -----------------------------------------------------------------------
  it('leak pin (AC-2): the correction message contains the enum allowedValues but NEVER the offending sentinel value', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"category": "OFFENDING_SENTINEL_XYZ"}'))
      .mockResolvedValueOnce(makeTextResponse('{"category": "billing"}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    await provider.callStepWithTools('prompt', [oneTool()], executor, {
      validationOutputSchema: strictSchema,
    });

    // The correction message is the LAST 'user' turn in the THIRD call's history (call index 2:
    // [user:prompt(string), assistant:[tool_use], user:[tool_result], assistant:response.content,
    // user:correctionMessage(string)]) — the FIRST string-content user message is the original
    // prompt itself, not the correction, so take the last match, not the first.
    const thirdCallMsgs = mockCreate.mock.calls[2]![0].messages as Array<{
      role: string;
      content: unknown;
    }>;
    const stringUserMsgs = thirdCallMsgs.filter(
      (m) => m.role === 'user' && typeof m.content === 'string',
    );
    const correctionMsg = stringUserMsgs.at(-1);
    const text = String(correctionMsg?.content ?? '');
    expect(text).toContain('did not match the required JSON schema');
    expect(text).toContain('billing'); // allowedValues (schema constant) present
    expect(text).toContain('support'); // allowedValues (schema constant) present
    expect(text).not.toContain('OFFENDING_SENTINEL_XYZ'); // the submitted value — NEVER leaked
  });

  // -----------------------------------------------------------------------
  // Observability (D6): one breadcrumb per correction; correctionCount reflects the total.
  // -----------------------------------------------------------------------
  it('observability (D6): emits one stderr breadcrumb per correction and surfaces correctionCount', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"category": 1}'))
      .mockResolvedValueOnce(makeTextResponse('{"category": 2}'))
      .mockResolvedValueOnce(makeTextResponse('{"category": "billing"}'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      validationOutputSchema: strictSchema,
    });

    expect(result.correctionCount).toBe(2);
    const breadcrumbs = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('output rejected (in-conversation)'));
    expect(breadcrumbs).toHaveLength(2);
    expect(breadcrumbs[0]).toContain('correcting (1)');
    expect(breadcrumbs[1]).toContain('correcting (2)');
    errorSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Both-schemas (D2): sequential AND, never allOf-combine.
  // -----------------------------------------------------------------------
  it('both-schemas (D2): valid under output_schema but INVALID under input_schema is rejected in-conversation (sequential AND)', async () => {
    // Deliberately NO additionalProperties:false anywhere in THIS test's schemas (unlike the
    // shared `strictSchema` used elsewhere in this file) — a submission can satisfy BOTH
    // simultaneously (an extra 'confirmed' field is harmless under output_schema; an extra
    // 'category' field is harmless under input_schema), so this test can drive the loop to a
    // genuine successful completion without constructing an unsatisfiable schema pair.
    const localOutputSchema = {
      type: 'object',
      required: ['category'],
      properties: { category: { type: 'string' } },
    };
    const localInputSchema = {
      type: 'object',
      required: ['category', 'confirmed'],
      properties: { category: { type: 'string' }, confirmed: { type: 'boolean' } },
    };
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      // Valid under output_schema (has 'category', a string) but missing the input_schema-
      // required 'confirmed' — rejected by the input-first check.
      .mockResolvedValueOnce(makeTextResponse('{"category": "billing"}'))
      // Satisfies BOTH schemas.
      .mockResolvedValueOnce(makeTextResponse('{"category": "billing", "confirmed": true}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      validationInputSchema: localInputSchema,
      validationOutputSchema: localOutputSchema,
    });

    // Corrected once — proves the first (output-valid/input-invalid) submission was REJECTED.
    expect(result.correctionCount).toBe(1);
    expect(result.output).toEqual({ category: 'billing', confirmed: true });
  });

  // -----------------------------------------------------------------------
  // _debug strip (D3): a _debug-bearing output that is valid-after-strip passes with ZERO
  // corrections.
  // -----------------------------------------------------------------------
  it('_debug strip (D3): a _debug-bearing output valid-after-strip passes with ZERO corrections', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(
        makeTextResponse('{"category": "billing", "_debug": "model reasoning trace"}'),
      );

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      validationOutputSchema: strictSchema,
    });

    expect(result.output).toEqual({ category: 'billing', _debug: 'model reasoning trace' });
    expect(result.correctionCount).toBeUndefined();
  });

  it('_debug strip (D3) negative control: dropping the strip would over-reject (genuinely invalid without _debug still rejects with it present)', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"category": 42, "_debug": "trace"}'))
      .mockResolvedValueOnce(makeTextResponse('{"category": "billing"}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      validationOutputSchema: strictSchema,
    });

    expect(result.correctionCount).toBe(1); // genuinely invalid (wrong type) — still corrected
  });

  // -----------------------------------------------------------------------
  // Budget-exhaustion terminal (D4 §4): performFinalExtraction RETURNS best-effort on
  // schema-invalid, never throws (already covered by test 3's rewrite above) — pinned again here
  // explicitly under the #224 describe block for discoverability.
  // -----------------------------------------------------------------------
  it('budget-exhaustion terminal: a still schema-invalid final answer is RETURNED, never thrown', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"category": 999}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      maxToolCalls: 1,
      validationOutputSchema: strictSchema,
    });

    expect(result.output).toEqual({ category: 999 }); // best-effort, still invalid — NOT thrown
  });

  // -----------------------------------------------------------------------
  // Contract (D7): every executor invocation — success, error, AND timeout — yields a toolCalls
  // entry (llm-provider.ts's shipped JSDoc clause, now enforced by a test).
  // -----------------------------------------------------------------------
  it('contract (D7): every executor invocation (success, error, timeout) yields a toolCalls entry', async () => {
    const hangingExecutor = vi
      .fn()
      .mockResolvedValueOnce('ok') // success
      .mockRejectedValueOnce(new Error('boom')) // error
      .mockReturnValueOnce(new Promise<unknown>(() => {})); // hangs → timeout
    mockCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { id: 't1', name: 'op' },
          { id: 't2', name: 'op' },
          { id: 't3', name: 'op' },
        ]),
      )
      .mockResolvedValueOnce(makeTextResponse('{"done":true}'));

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], hangingExecutor, {
      toolTimeoutMs: 1,
    });

    expect(result.toolCalls).toHaveLength(3); // one entry per invocation, regardless of outcome
    expect(result.toolCalls[0]?.error).toBeUndefined();
    expect(result.toolCalls[1]?.error).toBe('boom');
    expect(result.toolCalls[2]?.error).toBeDefined(); // timeout error
  });
});

// =========================================================================
// issue #224 — shared-budget characterization (named residual: corrections and tool calls draw
// on the SAME `tool_call_count`, incremented per tool call AND per correction, no reset/decrement)
// =========================================================================
describe('AnthropicProvider.callStepWithTools — issue #224 shared-budget characterization', () => {
  beforeEach(() => mockCreate.mockReset());

  const budgetSchema = {
    type: 'object',
    required: ['category'],
    properties: { category: { type: 'string', enum: ['billing', 'support'] } },
    additionalProperties: false,
  };

  it('corrections ALONE exhaust the shared maxToolCalls budget: 2 corrections, ZERO tool calls → performFinalExtraction, correctionCount===2', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeTextResponse('{"category": 42}')) // correction #1 (count 0→1)
      .mockResolvedValueOnce(makeTextResponse('{"category": 43}')) // correction #2 (count 1→2 === maxCalls)
      .mockResolvedValueOnce(makeTextResponse('{"category": "billing"}')); // performFinalExtraction
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      maxToolCalls: 2,
      validationOutputSchema: budgetSchema,
    });

    expect(executor).not.toHaveBeenCalled();
    expect(result.toolCalls).toHaveLength(0);
    expect(result.correctionCount).toBe(2);
    // Exactly 3 API calls: 2 correction turns + 1 performFinalExtraction. If corrections did NOT
    // consume the shared budget, the loop would NOT exhaust at 2 — this is the pin.
    expect(mockCreate).toHaveBeenCalledTimes(3);
    // performFinalExtraction is the ONLY call carrying `tool_choice` (the main loop never sets it —
    // it only sets `tools` when tools are offered, and lets the API default `tool_choice`).
    expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty('tool_choice');
    expect(mockCreate.mock.calls[1]![0]).not.toHaveProperty('tool_choice');
    expect(mockCreate.mock.calls[2]![0]).toHaveProperty('tool_choice');
    expect(result.output).toEqual({ category: 'billing' });

    const breadcrumbs = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('output rejected (in-conversation)'));
    expect(breadcrumbs).toHaveLength(2);
    errorSpy.mockRestore();
  });

  it('MIXED: 1 tool call + 1 correction exhausts a maxToolCalls:2 budget (both draw on ONE counter)', async () => {
    const executor = vi.fn().mockResolvedValue('file data');
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 'c1', name: 'op' }])) // tool call (count 0→1)
      .mockResolvedValueOnce(makeTextResponse('{"category": 42}')) // correction #1 (count 1→2 === maxCalls)
      .mockResolvedValueOnce(makeTextResponse('{"category": "billing"}')); // performFinalExtraction
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const provider = new AnthropicProvider('claude-sonnet-4-5');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      maxToolCalls: 2,
      validationOutputSchema: budgetSchema,
    });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.correctionCount).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockCreate.mock.calls[2]![0]).toHaveProperty('tool_choice'); // performFinalExtraction
    expect(result.output).toEqual({ category: 'billing' });

    const breadcrumbs = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('output rejected (in-conversation)'));
    expect(breadcrumbs).toHaveLength(1);
    errorSpy.mockRestore();
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
