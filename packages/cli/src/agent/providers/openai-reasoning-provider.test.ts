// openai-reasoning-provider.test.ts — Tests for OpenAIReasoningProvider.
// All tests mock the openai package — no real API calls are made.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIReasoningProvider } from './openai-reasoning-provider.js';
import { ToolCapableLlmProvider, resolveProvider } from './llm-provider.js';

// ---------- shared mock for the openai package ----------------------------
const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

// ---------- response builder ----------------------------------------------

function makeTextResponse(content: string) {
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: undefined } }],
  };
}

// =========================================================================
// callStep tests
// =========================================================================
describe('OpenAIReasoningProvider.callStep', () => {
  beforeEach(() => mockCreate.mockReset());

  // -----------------------------------------------------------------------
  // 1. Basic happy path
  // -----------------------------------------------------------------------
  it('callStep returns parsed JSON', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"result":"ok"}'));
    const provider = new OpenAIReasoningProvider('o1-mini');
    const result = await provider.callStep('step prompt');
    expect(result).toEqual({ result: 'ok' });
  });

  // -----------------------------------------------------------------------
  // 2. Retries once on non-JSON response
  // -----------------------------------------------------------------------
  it('callStep retries once on non-JSON response', async () => {
    mockCreate
      .mockResolvedValueOnce(makeTextResponse('not JSON'))
      .mockResolvedValueOnce(makeTextResponse('{"result":"ok"}'));
    const provider = new OpenAIReasoningProvider('o1-mini');
    const result = await provider.callStep('step prompt');
    expect(result).toEqual({ result: 'ok' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // 3. Throws after two failed attempts
  // -----------------------------------------------------------------------
  it('callStep throws after two failed attempts', async () => {
    mockCreate
      .mockResolvedValueOnce(makeTextResponse('not JSON'))
      .mockResolvedValueOnce(makeTextResponse('also not JSON'));
    const provider = new OpenAIReasoningProvider('o1-mini');
    await expect(provider.callStep('step prompt')).rejects.toThrow(
      'OpenAI returned non-JSON content after retry',
    );
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // 4. Does NOT send response_format
  // -----------------------------------------------------------------------
  it('callStep does NOT send response_format', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new OpenAIReasoningProvider('o1-mini');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('response_format');
  });

  // -----------------------------------------------------------------------
  // 4b. Does NOT send max_tokens (uses max_completion_tokens instead)
  // -----------------------------------------------------------------------
  it('callStep does NOT send max_tokens (only max_completion_tokens)', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new OpenAIReasoningProvider('o1-mini');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('max_tokens');
    expect(mockCreate.mock.calls[0][0]).toHaveProperty('max_completion_tokens');
  });

  // -----------------------------------------------------------------------
  // 4c. max_completion_tokens: 65536 for o1-mini
  // -----------------------------------------------------------------------
  it('callStep sends max_completion_tokens: 65536 for o1-mini', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new OpenAIReasoningProvider('o1-mini');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0][0].max_completion_tokens).toBe(65536);
  });

  // -----------------------------------------------------------------------
  // 4d. max_completion_tokens: 32768 for o1
  // -----------------------------------------------------------------------
  it('callStep sends max_completion_tokens: 32768 for o1', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new OpenAIReasoningProvider('o1');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0][0].max_completion_tokens).toBe(32768);
  });

  // -----------------------------------------------------------------------
  // 5. System prompt folded into user message (no system role)
  // -----------------------------------------------------------------------
  it('callStep folds system prompt into the user message (no system role)', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new OpenAIReasoningProvider('o1-mini');
    await provider.callStep('do something');
    const msgs = mockCreate.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(msgs.every((m) => m.role !== 'system')).toBe(true);
    const firstMsg = msgs[0]!;
    expect(firstMsg.role).toBe('user');
    expect(firstMsg.content).toContain('AI agent executing a step');
  });

  // -----------------------------------------------------------------------
  // 6. inputSchema included in user message content
  // -----------------------------------------------------------------------
  it('callStep with inputSchema — schema is in the user message content', async () => {
    const schema = { required: ['answer'] };
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"answer":"yes"}'));
    const provider = new OpenAIReasoningProvider('o1-mini');
    await provider.callStep('prompt', schema);
    const msgs = mockCreate.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    const firstMsg = msgs[0]!;
    expect(firstMsg.content).toContain(JSON.stringify(schema));
  });

  // -----------------------------------------------------------------------
  // 7. capabilities() returns jsonMode: false
  // -----------------------------------------------------------------------
  it('capabilities() returns jsonMode: false', () => {
    const provider = new OpenAIReasoningProvider('o1-mini');
    expect(provider.capabilities()).toEqual({ jsonMode: false });
  });
});

// =========================================================================
// resolveProvider routing tests
// =========================================================================
describe('resolveProvider routing for reasoning models', () => {
  let savedOpenAI: string | undefined;

  beforeEach(() => {
    savedOpenAI = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'test-key';
  });

  afterEach(() => {
    if (savedOpenAI === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = savedOpenAI;
    }
  });

  // -----------------------------------------------------------------------
  // 8. o1-mini routes to OpenAIReasoningProvider
  // -----------------------------------------------------------------------
  it('resolveProvider routes o1-mini to OpenAIReasoningProvider', async () => {
    const provider = await resolveProvider('openai', 'o1-mini');
    expect(provider).toBeInstanceOf(OpenAIReasoningProvider);
    expect(provider).not.toBeInstanceOf(ToolCapableLlmProvider);
  });

  // -----------------------------------------------------------------------
  // 9. o3 routes to OpenAIProvider (NOT OpenAIReasoningProvider)
  // -----------------------------------------------------------------------
  it('resolveProvider routes o3 to OpenAIProvider, not OpenAIReasoningProvider', async () => {
    const { OpenAIProvider } = await import('./openai-provider.js');
    const provider = await resolveProvider('openai', 'o3');
    expect(provider).not.toBeInstanceOf(OpenAIReasoningProvider);
    expect(provider).toBeInstanceOf(ToolCapableLlmProvider);
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  // -----------------------------------------------------------------------
  // 10. o3-mini routes to OpenAIProvider
  // -----------------------------------------------------------------------
  it('resolveProvider routes o3-mini to OpenAIProvider, not OpenAIReasoningProvider', async () => {
    const { OpenAIProvider } = await import('./openai-provider.js');
    const provider = await resolveProvider('openai', 'o3-mini');
    expect(provider).not.toBeInstanceOf(OpenAIReasoningProvider);
    expect(provider).toBeInstanceOf(ToolCapableLlmProvider);
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  // -----------------------------------------------------------------------
  // 11. o4-mini routes to OpenAIProvider
  // -----------------------------------------------------------------------
  it('resolveProvider routes o4-mini to OpenAIProvider, not OpenAIReasoningProvider', async () => {
    const { OpenAIProvider } = await import('./openai-provider.js');
    const provider = await resolveProvider('openai', 'o4-mini');
    expect(provider).not.toBeInstanceOf(OpenAIReasoningProvider);
    expect(provider).toBeInstanceOf(ToolCapableLlmProvider);
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  // -----------------------------------------------------------------------
  // 12. gpt-4o routes to OpenAIProvider (regression guard)
  // -----------------------------------------------------------------------
  it('resolveProvider routes gpt-4o to OpenAIProvider (regression guard)', async () => {
    const { OpenAIProvider } = await import('./openai-provider.js');
    const provider = await resolveProvider('openai', 'gpt-4o');
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider).not.toBeInstanceOf(OpenAIReasoningProvider);
  });
});
