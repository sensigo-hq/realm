// openai-provider-tool-args.test.ts — issue #313, the OpenAI TOOLS wire and its 400 ladder.
//
// The SELECTION decision (which tools get marked, under which profile) belongs to run-agent and
// is pinned in run-agent-tool-args.test.ts; here the marker is taken as given.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './openai-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

function tool(name: string, opts?: { strict?: boolean }): ToolDefinition {
  return {
    id: `srv:${name}`,
    serverId: 'srv',
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    ...(opts?.strict === true ? { strict: true } : {}),
  };
}

function textAnswer(obj: Record<string, unknown>) {
  return { choices: [{ message: { role: 'assistant', content: JSON.stringify(obj) } }] };
}

function toolCallTurn(name: string) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: '{}' } }],
        },
      },
    ],
  };
}

function apiError(
  status: number,
  message: string,
  extra: { param?: string | null; code?: string | null } = {},
) {
  return Object.assign(new Error(message), { status, ...extra });
}

/** The tools array as it reached the wire on call N. */
function wireTools(n = 0): Array<{ function: { name: string; strict?: boolean } }> {
  return (mockCreate.mock.calls[n]![0].tools ?? []) as Array<{
    function: { name: string; strict?: boolean };
  }>;
}

const NOOP_EXECUTOR = async () => ({});

describe('OpenAIProvider.callStepWithTools — strict tool arguments (issue #313)', () => {
  beforeEach(() => mockCreate.mockReset());

  // (h) the wire spread + the mixing cell (executed: mixed strict/non-strict is legal)
  it('(h) strict goes INSIDE `function`, on the marked tool only — mixing with an unmarked sibling is legal', async () => {
    mockCreate.mockResolvedValueOnce(textAnswer({ answer: 'done' }));
    const provider = new OpenAIProvider('gpt-4o');

    await provider.callStepWithTools(
      'prompt',
      [tool('marked', { strict: true }), tool('unmarked')],
      NOOP_EXECUTOR,
      {},
    );

    const sent = wireTools(0);
    expect(sent[0]!.function).toMatchObject({ name: 'marked', strict: true });
    // Absent, not `strict: false` — an unmarked tool's wire entry is byte-identical to pre-#313.
    expect(sent[1]!.function).not.toHaveProperty('strict');
  });

  it('a step with no marked tools sends no strict anywhere', async () => {
    mockCreate.mockResolvedValueOnce(textAnswer({ answer: 'done' }));
    const provider = new OpenAIProvider('gpt-4o');

    await provider.callStepWithTools('prompt', [tool('a'), tool('b')], NOOP_EXECUTOR, {});

    for (const t of wireTools(0)) expect(t.function).not.toHaveProperty('strict');
  });

  // (f) the 400 arm
  it('(f) 400 on a strict-carrying tools request: strips strict, retries once, reports the drop with param/code', async () => {
    mockCreate
      .mockRejectedValueOnce(
        apiError(400, "Invalid schema for function 'marked'", {
          param: 'tools[0].function.parameters',
          code: 'invalid_function_parameters',
        }),
      )
      .mockResolvedValueOnce(textAnswer({ answer: 'done' }));
    const provider = new OpenAIProvider('gpt-4o');

    const result = await provider.callStepWithTools(
      'prompt',
      [tool('marked', { strict: true })],
      NOOP_EXECUTOR,
      {},
    );

    expect(result.toolArgsStrictDrop).toEqual({
      reason: 'api_rejected_schema',
      api_message: "Invalid schema for function 'marked'",
      strict_turns_before_drop: 0,
      api_param: 'tools[0].function.parameters',
      api_code: 'invalid_function_parameters',
    });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(wireTools(1)[0]!.function).not.toHaveProperty('strict');
  });

  it('(f-aliasing) the drop sends STRIPPED COPIES — turn 1 as the SDK received it still carries strict', async () => {
    mockCreate
      .mockRejectedValueOnce(apiError(400, 'rejected'))
      .mockResolvedValueOnce(textAnswer({ answer: 'done' }));
    const provider = new OpenAIProvider('gpt-4o');

    await provider.callStepWithTools(
      'prompt',
      [tool('marked', { strict: true })],
      NOOP_EXECUTOR,
      {},
    );

    // The pin lives on the MOCK'S CAPTURED REQUEST, not on the ToolDefinition: OpenAI's wire
    // objects are fresh copies of the definitions, so a recorded-definition assertion would be
    // vacuous-green here. Mutating the wire objects in place would retroactively rewrite what
    // turn 1 appears to have sent.
    expect(wireTools(0)[0]!.function).toHaveProperty('strict', true);
    expect(wireTools(1)[0]!.function).not.toHaveProperty('strict');
  });

  it('counts strict-decorated 200 turns before the drop', async () => {
    mockCreate
      .mockResolvedValueOnce(toolCallTurn('marked'))
      .mockRejectedValueOnce(apiError(400, 'rejected on turn 2'))
      .mockResolvedValueOnce(textAnswer({ answer: 'done' }));
    const provider = new OpenAIProvider('gpt-4o');

    const result = await provider.callStepWithTools(
      'prompt',
      [tool('marked', { strict: true })],
      NOOP_EXECUTOR,
      {},
    );

    expect(result.toolArgsStrictDrop?.strict_turns_before_drop).toBe(1);
  });

  it('a SECOND 400 after the drop propagates PLAINLY (the tools fork has no meta-carrying error device)', async () => {
    mockCreate
      .mockRejectedValueOnce(apiError(400, 'first'))
      .mockRejectedValueOnce(apiError(400, 'second failure'));
    const provider = new OpenAIProvider('gpt-4o');

    await expect(
      provider.callStepWithTools('prompt', [tool('marked', { strict: true })], NOOP_EXECUTOR, {}),
    ).rejects.toThrow('second failure');
  });

  // (g) 5xx / transport
  it('(g) 5xx propagates untouched — no drop, no retry', async () => {
    mockCreate.mockRejectedValueOnce(apiError(503, 'service unavailable'));
    const provider = new OpenAIProvider('gpt-4o');

    await expect(
      provider.callStepWithTools('prompt', [tool('marked', { strict: true })], NOOP_EXECUTOR, {}),
    ).rejects.toThrow('service unavailable');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('(g) a timeout (no status) propagates untouched — schema-compile latency is a transport event', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Request timed out'));
    const provider = new OpenAIProvider('gpt-4o');

    await expect(
      provider.callStepWithTools('prompt', [tool('marked', { strict: true })], NOOP_EXECUTOR, {}),
    ).rejects.toThrow('Request timed out');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('a 400 on a turn that carried NO strict propagates untouched — never re-attributed', async () => {
    mockCreate.mockRejectedValueOnce(apiError(400, 'invalid_request_error: bad prompt'));
    const provider = new OpenAIProvider('gpt-4o');

    await expect(
      provider.callStepWithTools('prompt', [tool('a')], NOOP_EXECUTOR, {}),
    ).rejects.toThrow('invalid_request_error: bad prompt');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('a clean run reports no drop at all', async () => {
    mockCreate.mockResolvedValueOnce(textAnswer({ answer: 'done' }));
    const provider = new OpenAIProvider('gpt-4o');

    const result = await provider.callStepWithTools(
      'prompt',
      [tool('marked', { strict: true })],
      NOOP_EXECUTOR,
      {},
    );

    expect(result.toolArgsStrictDrop).toBeUndefined();
  });
});
