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
  // 3. issue #224 (D4 §4): performFinalExtraction no longer gates on schema conformance — that's
  // the engine Ajv validators' job (and the in-conversation correction loop's, before this point
  // is ever reached). A parseable-but-schema-invalid final answer is now RETURNED as best-effort,
  // never thrown — this UNIFIES OpenAI onto Anthropic's pre-existing posture (see the twin test
  // in anthropic-provider.test.ts, "final extraction produces no usable object"). Only a genuine
  // PARSE failure (no usable object at all) still throws — see test 3b below.
  // -----------------------------------------------------------------------
  it('max_tool_calls reached, parseable-but-schema-invalid final answer → RETURNS best-effort, never throws', async () => {
    const schema = { required: ['answer', 'confidence'] };
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"answer":"yes"}')); // 'confidence' missing

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      maxToolCalls: 1,
      inputSchema: schema,
    });

    expect(result.output).toEqual({ answer: 'yes' });
  });

  // -----------------------------------------------------------------------
  // 3b. The one remaining throw class — a genuinely unparseable final answer.
  // -----------------------------------------------------------------------
  it('max_tool_calls reached, no usable JSON object at all → throws ENGINE_STEP_FAILED', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('I was unable to determine a final answer.'));

    const provider = new OpenAIProvider('gpt-4o');
    const err = await provider
      .callStepWithTools('prompt', [oneTool()], executor, { maxToolCalls: 1 })
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
// issue #224 — in-conversation full-AJV correction (OpenAI-chat is IN SCOPE)
// =========================================================================
describe('OpenAIProvider.callStepWithTools — issue #224 in-conversation AJV correction', () => {
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
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'call_1', name: 'get_file' }]))
      // Right key, WRONG TYPE (number instead of the required string/enum).
      .mockResolvedValueOnce(makeTextResponse('{"category": 42}'))
      // Corrected — valid.
      .mockResolvedValueOnce(makeTextResponse('{"category": "billing"}'));

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools(
      'prompt',
      [oneTool('github:get_file')],
      executor,
      { validationOutputSchema: strictSchema },
    );

    expect(result.output).toEqual({ category: 'billing' });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.correctionCount).toBe(1);
  });

  it("probe-equivalent control: a wrong-type output with NO validation*Schema configured is accepted as-is (today's pre-#224 behavior for a plugin that ignores the new fields)", async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"category": 42}'));

    const provider = new OpenAIProvider('gpt-4o');
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
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"category": "OFFENDING_SENTINEL_XYZ"}'))
      .mockResolvedValueOnce(makeTextResponse('{"category": "billing"}'));

    const provider = new OpenAIProvider('gpt-4o');
    await provider.callStepWithTools('prompt', [oneTool()], executor, {
      validationOutputSchema: strictSchema,
    });

    // Third call's messages: [system, user:prompt, assistant:tool_calls, tool:result,
    // assistant:wrong-type-text, user:correction] — the FIRST string-content user message is the
    // original prompt, not the correction; take the LAST match.
    const thirdCallMsgs = mockCreate.mock.calls[2][0].messages as Array<{
      role: string;
      content: unknown;
    }>;
    const stringUserMsgs = thirdCallMsgs.filter(
      (m) => m.role === 'user' && typeof m.content === 'string',
    );
    const text = String(stringUserMsgs.at(-1)?.content ?? '');
    expect(text).toContain('did not match the required JSON schema');
    expect(text).toContain('billing');
    expect(text).toContain('support');
    expect(text).not.toContain('OFFENDING_SENTINEL_XYZ');
  });

  // -----------------------------------------------------------------------
  // Observability (D6): one breadcrumb per correction; correctionCount reflects the total.
  // -----------------------------------------------------------------------
  it('observability (D6): emits one stderr breadcrumb per correction and surfaces correctionCount', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"category": 1}'))
      .mockResolvedValueOnce(makeTextResponse('{"category": 2}'))
      .mockResolvedValueOnce(makeTextResponse('{"category": "billing"}'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const provider = new OpenAIProvider('gpt-4o');
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
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"category": "billing"}'))
      .mockResolvedValueOnce(makeTextResponse('{"category": "billing", "confirmed": true}'));

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      validationInputSchema: localInputSchema,
      validationOutputSchema: localOutputSchema,
    });

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
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(
        makeTextResponse('{"category": "billing", "_debug": "model reasoning trace"}'),
      );

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      validationOutputSchema: strictSchema,
    });

    expect(result.output).toEqual({ category: 'billing', _debug: 'model reasoning trace' });
    expect(result.correctionCount).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Budget-exhaustion terminal (D4 §4) — pinned again here explicitly under the #224 describe
  // block (already covered by the rewritten test 3/3b above).
  // -----------------------------------------------------------------------
  it('budget-exhaustion terminal: a still schema-invalid final answer is RETURNED, never thrown', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse([{ id: 'c1', name: 'op' }]))
      .mockResolvedValueOnce(makeTextResponse('{"category": 999}'));

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools('prompt', [oneTool()], executor, {
      maxToolCalls: 1,
      validationOutputSchema: strictSchema,
    });

    expect(result.output).toEqual({ category: 999 });
  });

  // -----------------------------------------------------------------------
  // Contract (D7): every executor invocation — success, error, AND timeout — yields a toolCalls
  // entry (llm-provider.ts's shipped JSDoc clause, now enforced by a test).
  // -----------------------------------------------------------------------
  it('contract (D7): every executor invocation (success, error, timeout) yields a toolCalls entry', async () => {
    const hangingExecutor = vi
      .fn()
      .mockResolvedValueOnce('ok')
      .mockRejectedValueOnce(new Error('boom'))
      .mockReturnValueOnce(new Promise<unknown>(() => {}));
    mockCreate
      .mockResolvedValueOnce(
        makeToolCallResponse([
          { id: 't1', name: 'op' },
          { id: 't2', name: 'op' },
          { id: 't3', name: 'op' },
        ]),
      )
      .mockResolvedValueOnce(makeTextResponse('{"done":true}'));

    const provider = new OpenAIProvider('gpt-4o');
    const result = await provider.callStepWithTools('prompt', [oneTool()], hangingExecutor, {
      toolTimeoutMs: 1,
    });

    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls[0]?.error).toBeUndefined();
    expect(result.toolCalls[1]?.error).toBe('boom');
    expect(result.toolCalls[2]?.error).toBeDefined();
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
