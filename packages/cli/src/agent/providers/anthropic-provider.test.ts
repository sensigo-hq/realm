// anthropic-provider.test.ts — Tests for AnthropicProvider callStep and callStepWithTools.
// All tests mock the @anthropic-ai/sdk package — no real API calls are made.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';
import { WorkflowError } from '@sensigo/realm';
import { CLASS_B_NO_TEXT_MARKER } from './agent-utils.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // The braces are load-bearing. `mockReset()` RETURNS the mock for chaining, so an arrow with
  // an implicit return (`() => mockCreate.mockReset()`) hands vitest a function — and vitest
  // treats a function returned from `beforeEach` as the TEARDOWN callback, so it CALLS the mock
  // after every test in the block. That is inert while the last implementation installed merely
  // resolves, and it is not inert the moment one throws or records: the throw is reported as the
  // test's own failure, and a recording implementation logs one invocation nobody made. The
  // tree-wide source-text witness at the bottom of this file keeps the braces here.
  beforeEach(() => {
    mockCreate.mockReset();
  });

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
  beforeEach(() => {
    mockCreate.mockReset();
  });

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
  beforeEach(() => {
    mockCreate.mockReset();
  });

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
  beforeEach(() => {
    mockCreate.mockReset();
  });

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
  // 13. jsonMode stays false; toolArgsStrict is DECLARED (issue #311 capability guard)
  // -----------------------------------------------------------------------
  // Exact-match, so it doubles as the declaration pin: run-agent only marks tools and records
  // `strict_sent` for a provider declaring `toolArgsStrict` — dropping it here would silently
  // disable per-tool strict on the one provider that implements it.
  it('capabilities() returns jsonMode: false and declares toolArgsStrict', () => {
    const provider = new AnthropicProvider('claude-sonnet-4-5');
    expect(provider.capabilities()).toEqual({
      jsonMode: false,
      toolArgsStrict: true,
      providerId: 'anthropic',
    });
  });
});

// =========================================================================
// issue #345 — Class-B tool failures (a call that RETURNS `isError: true`)
//
// MCP gives a tool two ways to fail. It can make the transport reject — Class A, an exception,
// which the catch branch has always recorded honestly. Or it can RETURN normally carrying
// `isError: true`: Class B, the polite failure the spec defines for a tool reporting its own
// error back to the model. Class B used to mint a SUCCESS-shaped record — no `error` field, the
// failure text buried in `result` — which made ToolCallRecord's own doc contract false and made
// every tool-reliability count read those failures as successes.
//
// The twin of this block lives in the OTHER provider's test file. Both mints are structural
// twins, so a cell on one proves nothing about the other.
// =========================================================================

/**
 * THE CAPTURED CLASS-B SHAPE — not hand-authored.
 *
 * Provenance: realm's OWN MCP server (dogfood, no external service), tool
 * `get_workflow_protocol`, arguments `{ workflow_id: 'no-such-workflow-345' }`, captured
 * 2026-08-21 over the real SDK stdio client against `packages/mcp-server/dist/server.js`. That is
 * realm's one genuine `isError` site (get-workflow-protocol.ts:62-68).
 *
 * REDACTION-INERT by construction: no `$HOME` path, no environment value, so it passes through
 * `sanitizeError` unchanged and the probe red-sets stay exact. Redaction has its own cell with a
 * purpose-built token fixture.
 *
 * A THIRD CLASS EXISTS AND IS NOT THIS ONE. Most realm MCP tools report failure as an in-band
 * SUCCESS-shaped envelope — `status: 'error'` inside the text, no `isError` key — which is realm's
 * designed agent-legible protocol, and incidentally the same invisibility shape this PR fixes one
 * level up. Nobody should "fix" that envelope into `isError` without a design decision.
 */
const CLASS_B_CAPTURED = {
  content: [{ type: 'text', text: 'Error: Workflow not found: no-such-workflow-345' }],
  isError: true,
};
const CLASS_B_TEXT = 'Error: Workflow not found: no-such-workflow-345';

describe('AnthropicProvider.callStepWithTools — Class-B tool failures (issue #345)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  /** Runs one tool call whose executor resolves `value`, and returns its ToolCallRecord. */
  async function recordFor(value: unknown) {
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 't1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"result":"ok"}'));
    const result = await new AnthropicProvider('claude-sonnet-4-5').callStepWithTools(
      'prompt',
      [oneTool()],
      vi.fn().mockResolvedValue(value),
      {},
    );
    return result.toolCalls[0]!;
  }

  it('a Class-B result is recorded as a FAILURE, carrying the tool own text', async () => {
    expect((await recordFor(CLASS_B_CAPTURED)).error).toBe(CLASS_B_TEXT);
  });

  it('`result` still carries the full serialized payload — evidence is never discarded', async () => {
    const record = await recordFor(CLASS_B_CAPTURED);
    expect(record.result).toBe(JSON.stringify(CLASS_B_CAPTURED));
    // The Class A / Class B distinction as an assertion: a call that RETURNED has a result; a
    // call that THREW does not.
    expect(record.result).not.toBeNull();
  });

  it('CONTROL — a plain success is untouched: no error, result verbatim', async () => {
    const ok = { content: [{ type: 'text', text: 'fine' }] };
    const record = await recordFor(ok);
    expect(record.error).toBeUndefined();
    expect(record.result).toBe(JSON.stringify(ok));
  });

  it('CONTROL — the CONVERSATION payload is byte-untouched by this fix', async () => {
    // What the MODEL sees is a conversation decision this fix has no business changing. The
    // natural drift is to route Class B through the catch branch's `'Error: ' + text` shape,
    // which would silently change what every agent reads mid-tool-loop.
    await recordFor(CLASS_B_CAPTURED);
    const followUp = JSON.stringify(mockCreate.mock.calls[1]![0]);
    // The serialized payload as it appears EMBEDDED in the request — JSON-escaped, since it is a
    // string inside a string. Asserted whole rather than by prefix: a partial match would pass on
    // a payload that had been rewritten after the first forty characters.
    const embedded = JSON.stringify(JSON.stringify(CLASS_B_CAPTURED)).slice(1, -1);
    expect(followUp).toContain(embedded);
    // And specifically NOT the catch branch's shape, which is where this would drift to.
    expect(followUp).not.toContain('Error: Error: Workflow not found');
  });

  it('MARKER — no text blocks at all', async () => {
    expect((await recordFor({ content: [], isError: true })).error).toBe(CLASS_B_NO_TEXT_MARKER);
  });

  it('MARKER — non-text blocks only', async () => {
    const record = await recordFor({
      content: [{ type: 'image', data: 'x', mimeType: 'image/png' }],
      isError: true,
    });
    expect(record.error).toBe(CLASS_B_NO_TEXT_MARKER);
  });

  it('MARKER — text blocks present but ALL EMPTY (the one that would render as unfailed)', async () => {
    // `text: ''` is transport-legal. An empty `error` would be falsy, so inspect's truthiness
    // check would hide it and a politely-failed call would render as a success — the exact defect,
    // reconstituted. The marker fires on the JOINED text being empty, not on blocks being absent.
    const record = await recordFor({
      content: [
        { type: 'text', text: '' },
        { type: 'text', text: '' },
      ],
      isError: true,
    });
    expect(record.error).toBe(CLASS_B_NO_TEXT_MARKER);
    expect(record.error!.length).toBeGreaterThan(0);
  });

  it('STRICT BOOLEAN — a non-boolean `isError` is recorded as a SUCCESS', async () => {
    // FIXTURE-ONLY: this wire state cannot occur. The SDK zod-validates every callTool response
    // (`CallToolResultSchema`, `isError: z.boolean().optional()`), so a non-boolean value fails
    // the parse, the promise rejects, and the call lands in the catch branch as Class A — recorded
    // WITH an error either way. The strict check therefore cannot swallow a real failure. This
    // pins the choice, not a reachable case; the premise breaks only if realm moves to
    // `CompatibilityCallToolResultSchema` or a transport that skips validation.
    const record = await recordFor({ ...CLASS_B_CAPTURED, isError: 'yes' });
    expect(record.error).toBeUndefined();
  });

  it('SANITIZE — Class-B text goes through the same redaction pass as a thrown error', async () => {
    // The two failure classes must not differ in what they leak.
    const record = await recordFor({
      content: [{ type: 'text', text: 'auth failed for Bearer sk-live-abcdef123456' }],
      isError: true,
    });
    expect(record.error).toBe('auth failed for Bearer [REDACTED]');
    expect(record.error).not.toContain('sk-live-abcdef123456');
  });
});

// =================================================================================================
// issue #600 PR 1a — D1 (Anthropic's mapper): input_tokens is the REMAINDER, not the total
// =================================================================================================
function makeTextResponseWithUsage(
  text: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_creation?: {
      ephemeral_5m_input_tokens?: number;
      ephemeral_1h_input_tokens?: number;
    } | null;
  },
) {
  return { content: [{ type: 'text' as const, text }], usage };
}

describe('AnthropicProvider — issue #600 PR 1a D1: the disjoint three-term sum, never the raw remainder alone', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('prompt_tokens is input_tokens + cache_read + cache_creation — the DISJOINT sum, not input_tokens alone', async () => {
    mockCreate.mockResolvedValueOnce(
      makeTextResponseWithUsage('{"result":"ok"}', {
        input_tokens: 50,
        output_tokens: 40,
        cache_read_input_tokens: 1150,
        cache_creation_input_tokens: 0,
      }),
    );
    const provider = new AnthropicProvider('claude-x');
    const result = await provider.callStepWithMeta('prompt');
    const [entry] = result.usage!;
    // The falsity this cell exists to reject: reading input_tokens alone would report 50 as "the
    // prompt", which SHRINKS to near-zero on a fully warm call — the exact defect D6's render
    // guards against, pinned here at its SOURCE.
    expect(entry!.prompt_tokens).toBe(1200); // 50 + 1150 + 0
    expect(entry!.uncached_input_tokens).toBe(50); // the raw remainder, kept under its OWN name
    expect(entry!.cache_read_input_tokens).toBe(1150);
    expect(entry!.output_tokens).toBe(40);
  });

  it('a NULL cache counter is an ABSENCE — it is neither STORED as a 0 nor summed as one, so the three-term total is withheld', async () => {
    mockCreate.mockResolvedValueOnce(
      makeTextResponseWithUsage('{"result":"ok"}', {
        input_tokens: 1200,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
    );
    const result = await new AnthropicProvider('claude-x').callStepWithMeta('prompt');
    const [entry] = result.usage!;
    // This cell used to assert `prompt_tokens === 1200` — "null contributes 0 to the sum" — which is
    // the rule broken one level down from where it was honoured: the counters were correctly not
    // STORED as zeros, and then summed as zeros anyway, and every surface labelled the result
    // `measured`. With two of the three terms unreported the whole prompt is not knowable, so it is
    // withheld; the uncached remainder the provider DID report is still here.
    expect(entry!.prompt_tokens).toBeUndefined();
    expect(entry!.uncached_input_tokens).toBe(1200);
    expect(entry).not.toHaveProperty('cache_read_input_tokens'); // absent, not stored as 0
    expect(entry).not.toHaveProperty('cache_creation_input_tokens');
  });

  it('the ephemeral 5m/1h split rides beside the aggregate — BOTH counters, never a discriminator', async () => {
    mockCreate.mockResolvedValueOnce(
      makeTextResponseWithUsage('{"result":"ok"}', {
        input_tokens: 10,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
      }),
    );
    const result = await new AnthropicProvider('claude-x').callStepWithMeta('prompt');
    const [entry] = result.usage!;
    expect(entry!.cache_creation_input_tokens).toBe(300);
    // The documented invariant (vendored at anthropic-prompt-caching.md:841): the aggregate IS the
    // sum of the split.
    expect(
      entry!.cache_creation!.ephemeral_5m_input_tokens! +
        entry!.cache_creation!.ephemeral_1h_input_tokens!,
    ).toBe(entry!.cache_creation_input_tokens);
  });
});

describe('AnthropicProvider — issue #600 PR 1a D1a/D2: usage travels through callStepWithMeta, count-agnostic', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('callStep (public, untouched signature) DISCARDS usage by construction', async () => {
    mockCreate.mockResolvedValueOnce(
      makeTextResponseWithUsage('{"result":"ok"}', { input_tokens: 10, output_tokens: 4 }),
    );
    const result = await new AnthropicProvider('claude-x').callStep('prompt');
    expect(result).toEqual({ result: 'ok' });
    expect(Object.keys(result)).not.toContain('usage');
  });

  it('BYTE-IDENTITY — the request body callStep sends is IDENTICAL to what callStepWithMeta sends for the same bare arm (constraint 1)', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"a":1}'));
    await new AnthropicProvider('claude-x').callStep('same prompt', undefined, 'profile text');
    const viaCallStep = JSON.stringify(mockCreate.mock.calls[0]![0]);

    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"a":1}'));
    await new AnthropicProvider('claude-x').callStepWithMeta(
      'same prompt',
      undefined,
      'profile text',
    );
    const viaCallStepWithMeta = JSON.stringify(mockCreate.mock.calls[0]![0]);

    expect(viaCallStepWithMeta).toBe(viaCallStep);
  });

  it('two billed requests (the non-JSON retry) yield TWO usage entries, in wire order — count-agnostic', async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeTextResponseWithUsage('not JSON', {
          input_tokens: 900,
          output_tokens: 12,
          // Both cache counters reported (as 0) — the realistic Anthropic shape, and what makes the
          // three-term total knowable. The partial-report shapes have their own lattice below.
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
      )
      .mockResolvedValueOnce(
        makeTextResponseWithUsage('{"result":"ok"}', {
          input_tokens: 950,
          output_tokens: 8,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
      );
    const result = await new AnthropicProvider('claude-x').callStepWithMeta('prompt');
    expect(result.usage).toHaveLength(2);
    expect(result.usage![0]!.request_index).toBe(0);
    expect(result.usage![0]!.prompt_tokens).toBe(900);
    expect(result.usage![1]!.request_index).toBe(1);
    expect(result.usage![1]!.prompt_tokens).toBe(950);
  });

  it('a response with no usage block at all yields no measured fields — never a fabricated 0', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"result":"ok"}'));
    const result = await new AnthropicProvider('claude-x').callStepWithMeta('prompt');
    expect(result.usage).toHaveLength(1);
    expect(result.usage![0]!.prompt_tokens).toBeUndefined();
  });
});

// =================================================================================================
// issue #600 PR 1a — THE ABSENCE LATTICE AT THE MAPPER, and the billed-usage attach.
//
// The class these blocks exist to prevent: "an absence is never a zero" honoured for the stored
// field and broken for the number DERIVED from it. `prompt_tokens` is the disjoint three-term sum
// the provider's own SDK documents, so it is knowable only when all three terms were reported;
// summing an unreported counter as a 0 contribution made the total a LOWER BOUND that every surface
// still labelled `measured`. The instrument is a lattice over all 2^3 presence combinations, under
// BOTH spellings of absence the vendor's types allow (omitted, and explicit `null`).
// =================================================================================================
describe('AnthropicProvider — issue #600 PR 1a: the mapper absence lattice (prompt_tokens iff all three terms)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  for (const absent of [undefined, null] as const) {
    const spelling = absent === undefined ? 'omitted' : 'null';
    for (const inp of [false, true]) {
      for (const read of [false, true]) {
        for (const creation of [false, true]) {
          const all = inp && read && creation;
          it(`${spelling}: input=${String(inp)} read=${String(read)} creation=${String(creation)} => prompt_tokens ${all ? 'present (the sum)' : 'ABSENT'}`, async () => {
            mockCreate.mockResolvedValueOnce(
              makeTextResponseWithUsage('{"result":"ok"}', {
                // `input_tokens` is REQUIRED and non-nullable in the vendor type, so its only
                // lawful absence is OMISSION — a `null` there would be a shape the API cannot
                // send, and casting one to `undefined` to satisfy the builder would make the cell
                // assert against a fiction. The two cache fields ARE `number | null`, so both
                // spellings of absence are exercised for them.
                ...(inp ? { input_tokens: 40 } : {}),
                output_tokens: 12,
                ...(read
                  ? { cache_read_input_tokens: 1000 }
                  : absent === null
                    ? { cache_read_input_tokens: null }
                    : {}),
                ...(creation
                  ? { cache_creation_input_tokens: 100 }
                  : absent === null
                    ? { cache_creation_input_tokens: null }
                    : {}),
              }),
            );
            const provider = new AnthropicProvider('claude-x');
            const result = await provider.callStepWithMeta('prompt');
            const [entry] = result.usage!;
            if (all) {
              expect(entry!.prompt_tokens).toBe(1140);
            } else {
              expect(entry!.prompt_tokens).toBeUndefined();
            }
            // Whatever the provider DID report is still stored, unchanged — withholding the derived
            // total never costs a measured fact.
            expect(entry!.uncached_input_tokens).toBe(inp ? 40 : undefined);
            expect(entry!.cache_read_input_tokens).toBe(read ? 1000 : undefined);
            expect(entry!.cache_creation_input_tokens).toBe(creation ? 100 : undefined);
          });
        }
      }
    }
  }
});

describe('AnthropicProvider — issue #600 PR 1a (D9): money already billed survives ANY throw', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('a wire failure AFTER a billed request carries the usage on the error — a 500 no longer discards the money', async () => {
    // The defect this cell exists for: the accumulator was attached only at the provider's own two
    // typed throws (truncation, non-JSON after retry), so the failure an operator actually meets —
    // a wire error from the model — threw the numbers away, and a drive that had already paid for a
    // cache write was indistinguishable on screen from one that spent nothing.
    mockCreate
      .mockResolvedValueOnce(
        makeTextResponseWithUsage('not JSON', {
          input_tokens: 40,
          output_tokens: 12,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 900,
        }),
      )
      // Thrown lazily, per call — a pre-built rejected promise would be flagged unhandled the
      // moment the call path stops consuming it.
      .mockImplementation(async () => {
        throw new Error('500 upstream exploded');
      });
    const provider = new AnthropicProvider('claude-x');
    try {
      await provider.callStepWithMeta('prompt');
      expect.unreachable('the call must throw');
    } catch (err) {
      expect((err as Error).message).toContain('500 upstream exploded');
      const payload = (err as { driveCall?: { usage?: unknown[] } }).driveCall;
      expect(payload?.usage).toBeDefined();
      expect(payload!.usage).toHaveLength(1);
      expect((payload!.usage as Array<{ cache_creation_input_tokens?: number }>)[0]).toMatchObject({
        cache_creation_input_tokens: 900,
        prompt_tokens: 940,
      });
    }
  });

  it('the same on the PUBLIC single-shot path — `callStep`, whose own attach site was unpinned', async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeTextResponseWithUsage('not JSON', {
          input_tokens: 40,
          output_tokens: 12,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 900,
        }),
      )
      .mockImplementation(async () => {
        throw new Error('500 upstream exploded');
      });
    const provider = new AnthropicProvider('claude-x');
    try {
      await provider.callStep('prompt');
      expect.unreachable('the call must throw');
    } catch (err) {
      const payload = (err as { driveCall?: { usage?: unknown[] } }).driveCall;
      expect(payload?.usage).toHaveLength(1);
      expect((payload!.usage as Array<{ cache_creation_input_tokens?: number }>)[0]).toMatchObject({
        cache_creation_input_tokens: 900,
      });
    }
  });

  it('a wire failure with NOTHING billed attaches nothing — `usage: undefined` keeps meaning "no wire request was ever made"', async () => {
    // The discriminating control: without it, attaching an empty array on every failure would make
    // a pre-dispatch failure (`sdk_missing`) indistinguishable from a billed one, which is the same
    // collapse in the other direction.
    mockCreate.mockImplementation(async () => {
      throw new Error('500 upstream exploded');
    });
    const provider = new AnthropicProvider('claude-x');
    try {
      await provider.callStepWithMeta('prompt');
      expect.unreachable('must throw');
    } catch (err) {
      expect((err as { driveCall?: unknown }).driveCall).toBeUndefined();
    }
  });
});

describe('the agent test tree: no hook may hand vitest a mock as its teardown callback', () => {
  it('every mock-resetting hook is braced, and the braced form is findable in the tree', () => {
    // Scoped to the whole `src/agent` test tree, not this file: the idiom was copied across nine
    // provider test files, and a guard that polices only the file it lives in leaves the other
    // eight free to reintroduce what it exists to prevent.
    const tree = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.test.ts')) files.push(full);
      }
    };
    walk(tree);
    // Non-vacuity, leg 1 of 2: the walk must actually find files. A guard that stops matching does
    // not fail, it stops guarding (#189).
    expect(files.length).toBeGreaterThan(8);

    // THE DEFECT. `mockReset()` and its siblings RETURN the mock for chaining, so an arrow with an
    // implicit return hands vitest a function — and vitest treats a function returned from a hook
    // as the TEARDOWN callback, so it CALLS the mock after every test in the block. That is inert
    // while the last implementation installed merely resolves, and it is not inert the moment one
    // throws or records: the throw is reported as the test's own failure (which is how the D9
    // cells above first read), and a recording implementation logs one invocation nobody made.
    const offenders: string[] = [];
    let bracedFound = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(
        /(?:before|after)(?:Each|All)\(\(\) => [A-Za-z_$][\w.$]*\.mock[A-Za-z]+\(/g,
      )) {
        offenders.push(`${f.slice(tree.length + 1)}: ${m[0]}`);
      }
      bracedFound += src.match(/(?:before|after)(?:Each|All)\(\(\) => \{/g)?.length ?? 0;
    }
    expect(offenders).toEqual([]);
    // Non-vacuity, leg 2 of 2: the shape this guard polices is present in the tree it read.
    expect(bracedFound).toBeGreaterThan(0);
  });
});
