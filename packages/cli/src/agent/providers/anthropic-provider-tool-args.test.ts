// anthropic-provider-tool-args.test.ts — issue #311, the provider half of strict MCP tool-call
// arguments: what reaches the wire per tool, and the per-turn 400/503 ladder that drops strict.
//
// The SELECTION decision (which tools get strict) belongs to run-agent and is pinned in
// run-agent-tool-args.test.ts; here the `strict` marker on a ToolDefinition is taken as given.
// All tests mock the @anthropic-ai/sdk package — no real API calls are made.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

function makeTextResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

function makeToolUseResponse(calls: Array<{ id: string; name: string }>) {
  return {
    content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: {} })),
  };
}

/** A tool definition; `strict` is opt-in exactly as run-agent sets it. */
function tool(id: string, opts?: { strict?: boolean }): ToolDefinition {
  const colonIdx = id.indexOf(':');
  return {
    id,
    serverId: id.slice(0, colonIdx),
    name: id.slice(colonIdx + 1),
    description: 'A tool',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    ...(opts?.strict === true ? { strict: true } : {}),
  };
}

/** The SDK's public APIError contract as the provider duck-types it (status + message). */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const NOOP_EXECUTOR = async () => ({});
const GRAMMAR_TEXT = 'Grammar compilation is temporarily unavailable';

/** The tools array as it reached the wire on call N. */
function wireTools(callIndex: number): Array<{ name: string; strict?: boolean }> {
  return (mockCreate.mock.calls[callIndex]![0].tools ?? []) as Array<{
    name: string;
    strict?: boolean;
  }>;
}

describe('AnthropicProvider.callStepWithTools — strict tool arguments (issue #311)', () => {
  beforeEach(() => mockCreate.mockReset());

  // -------------------------------------------------------------------------------------------
  // Wire shape: per-tool, opt-in, and absent by default
  // -------------------------------------------------------------------------------------------
  it('places strict:true on ONLY the marked tools — an unmarked tool carries no strict key at all', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');

    await provider.callStepWithTools(
      'prompt',
      [tool('srv:selected', { strict: true }), tool('srv:unselected')],
      NOOP_EXECUTOR,
      {},
    );

    const sent = wireTools(0);
    expect(sent[0]).toMatchObject({ name: 'selected', strict: true });
    // Absent, not `strict: false` — an unselected tool's wire entry is byte-identical to pre-#311.
    expect(sent[1]).not.toHaveProperty('strict');
  });

  it('a step with no marked tools sends no strict anywhere (the non-opted-in path is untouched)', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');

    await provider.callStepWithTools('prompt', [tool('srv:a'), tool('srv:b')], NOOP_EXECUTOR, {});

    for (const t of wireTools(0)) expect(t).not.toHaveProperty('strict');
  });

  // -------------------------------------------------------------------------------------------
  // Pin 1 — a 400 on a turn that carried NO strict propagates untouched
  // -------------------------------------------------------------------------------------------
  it('pin 1: a 400 on a NON-strict-carrying turn propagates untouched — never re-attributed to structured output', async () => {
    mockCreate.mockRejectedValueOnce(httpError(400, 'invalid_request_error: bad prompt'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');

    await expect(
      provider.callStepWithTools('prompt', [tool('srv:a')], NOOP_EXECUTOR, {}),
    ).rejects.toThrow('invalid_request_error: bad prompt');
    // No retry was attempted: the ladder never engaged.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------------------------
  // Pins 6 + 17 — mid-attempt drop: retry once unconstrained, report the drop facts
  // -------------------------------------------------------------------------------------------
  it('pins 6+17: a 400 on the FIRST strict-carrying turn drops strict, retries once unconstrained, and reports strict_turns_before_drop: 0', async () => {
    mockCreate
      .mockRejectedValueOnce(httpError(400, 'tools.0.custom: grammar is not compilable'))
      .mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');

    const result = await provider.callStepWithTools(
      'prompt',
      [tool('srv:a', { strict: true })],
      NOOP_EXECUTOR,
      {},
    );

    expect(result.toolArgsStrictDrop).toEqual({
      reason: 'api_rejected_schema',
      api_message: 'tools.0.custom: grammar is not compilable',
      strict_turns_before_drop: 0, // the very first strict-carrying turn was rejected
    });
    // The retry is the SAME turn, unconstrained.
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(wireTools(0)[0]).toHaveProperty('strict', true);
    expect(wireTools(1)[0]).not.toHaveProperty('strict');
  });

  it('counts only strict-decorated 200s in strict_turns_before_drop (a drop on turn 3 reports 2)', async () => {
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 't1', name: 'a' }]))
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 't2', name: 'a' }]))
      .mockRejectedValueOnce(httpError(400, 'rejected on the third turn'))
      .mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');

    const result = await provider.callStepWithTools(
      'prompt',
      [tool('srv:a', { strict: true })],
      NOOP_EXECUTOR,
      {},
    );

    expect(result.toolArgsStrictDrop?.strict_turns_before_drop).toBe(2);
  });

  it('the drop is invocation-sticky: every turn AFTER a drop is sent unconstrained, with no second retry', async () => {
    mockCreate
      .mockRejectedValueOnce(httpError(400, 'rejected'))
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 't1', name: 'a' }]))
      .mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');

    await provider.callStepWithTools(
      'prompt',
      [tool('srv:a', { strict: true })],
      NOOP_EXECUTOR,
      {},
    );

    expect(mockCreate).toHaveBeenCalledTimes(3);
    for (const idx of [1, 2]) {
      for (const t of wireTools(idx)) expect(t).not.toHaveProperty('strict');
    }
  });

  // -------------------------------------------------------------------------------------------
  // Pin 4 — 503 labels, forked by CAPTURED TEXT only (never parsed for meaning)
  // -------------------------------------------------------------------------------------------
  it('pin 4: a 503 whose message does NOT match the captured grammar text gets the fail-safe generic label', async () => {
    mockCreate
      .mockRejectedValueOnce(httpError(503, 'overloaded_error: server is busy'))
      .mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');

    const result = await provider.callStepWithTools(
      'prompt',
      [tool('srv:a', { strict: true })],
      NOOP_EXECUTOR,
      {},
    );

    expect(result.toolArgsStrictDrop?.reason).toBe('service_unavailable');
  });

  it('a 503 matching the captured grammar text is labelled grammar_unavailable', async () => {
    mockCreate
      .mockRejectedValueOnce(httpError(503, `overloaded_error: ${GRAMMAR_TEXT}`))
      .mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');

    const result = await provider.callStepWithTools(
      'prompt',
      [tool('srv:a', { strict: true })],
      NOOP_EXECUTOR,
      {},
    );

    expect(result.toolArgsStrictDrop?.reason).toBe('grammar_unavailable');
  });

  it('a non-400/503 failure on a strict-carrying turn propagates untouched (the ladder keys on status, not on strict alone)', async () => {
    mockCreate.mockRejectedValueOnce(httpError(500, 'internal server error'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');

    await expect(
      provider.callStepWithTools('prompt', [tool('srv:a', { strict: true })], NOOP_EXECUTOR, {}),
    ).rejects.toThrow('internal server error');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('a clean run reports no drop at all', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');

    const result = await provider.callStepWithTools(
      'prompt',
      [tool('srv:a', { strict: true })],
      NOOP_EXECUTOR,
      {},
    );

    expect(result.toolArgsStrictDrop).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------
  // Pin 15 — the final extraction call is strict-less BY DESIGN
  // -------------------------------------------------------------------------------------------
  it('pin 15: the final extraction call never carries strict, even when every MCP tool did', async () => {
    // Force the extraction path: exhaust maxToolCalls so the loop must ask for a final answer.
    mockCreate
      .mockResolvedValueOnce(makeToolUseResponse([{ id: 't1', name: 'a' }]))
      .mockResolvedValueOnce(makeTextResponse('{"answer":"done"}'));
    const provider = new AnthropicProvider('claude-sonnet-4-5');

    await provider.callStepWithTools('prompt', [tool('srv:a', { strict: true })], NOOP_EXECUTOR, {
      maxToolCalls: 1,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
    });

    // The extraction call is the LAST one. Its tools array is the submit tool only — and that
    // submit tool must carry no strict: the step's OUTPUT stays unconstrained on the tools fork,
    // which is exactly what the step-level `unsupported_context_tools` disclosure claims.
    const extractionOpts = mockCreate.mock.calls.at(-1)![0];
    for (const t of (extractionOpts.tools ?? []) as Array<Record<string, unknown>>) {
      expect(t).not.toHaveProperty('strict');
    }
    expect(JSON.stringify(extractionOpts)).not.toContain('"strict"');
  });
});
