// openai-reasoning-provider.test.ts — Tests for OpenAIReasoningProvider.
// All tests mock the openai package — no real API calls are made.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { OpenAIReasoningProvider } from './openai-reasoning-provider.js';
import { OPENAI_DEFAULT_BASE_URL } from './openai-provider.js';
import { ToolCapableLlmProvider, resolveProvider } from './llm-provider.js';
import { setAdditionalRedactionValues } from './agent-utils.js';
import { leakedForms } from '../test-support/redaction-oracle.js';

// issue #600 PR 2: resolveProvider takes an options object; the caching setting is required.
const TEST_PROMPT_CACHE = { value: 'short', source: 'runner_default', by: 'realm agent' } as const;

// ---------- shared mock for the openai package ----------------------------
const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
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
  beforeEach(() => {
    mockCreate.mockReset();
  });

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
    expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty('response_format');
  });

  // -----------------------------------------------------------------------
  // 4b. Does NOT send max_tokens (uses max_completion_tokens instead)
  // -----------------------------------------------------------------------
  it('callStep does NOT send max_tokens (only max_completion_tokens)', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new OpenAIReasoningProvider('o1-mini');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty('max_tokens');
    expect(mockCreate.mock.calls[0]![0]).toHaveProperty('max_completion_tokens');
  });

  // -----------------------------------------------------------------------
  // 4c. max_completion_tokens: 65536 for o1-mini
  // -----------------------------------------------------------------------
  it('callStep sends max_completion_tokens: 65536 for o1-mini', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new OpenAIReasoningProvider('o1-mini');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0]![0].max_completion_tokens).toBe(65536);
  });

  // -----------------------------------------------------------------------
  // 4d. max_completion_tokens: 32768 for o1
  // -----------------------------------------------------------------------
  it('callStep sends max_completion_tokens: 32768 for o1', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new OpenAIReasoningProvider('o1');
    await provider.callStep('prompt');
    expect(mockCreate.mock.calls[0]![0].max_completion_tokens).toBe(32768);
  });

  // -----------------------------------------------------------------------
  // 5. System prompt folded into user message (no system role)
  // -----------------------------------------------------------------------
  it('callStep folds system prompt into the user message (no system role)', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":1}'));
    const provider = new OpenAIReasoningProvider('o1-mini');
    await provider.callStep('do something');
    const msgs = mockCreate.mock.calls[0]![0].messages as Array<{ role: string; content: string }>;
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
    const msgs = mockCreate.mock.calls[0]![0].messages as Array<{ role: string; content: string }>;
    const firstMsg = msgs[0]!;
    expect(firstMsg.content).toContain(JSON.stringify(schema));
  });

  // -----------------------------------------------------------------------
  // 7. capabilities() returns jsonMode: false
  // -----------------------------------------------------------------------
  it('capabilities() returns jsonMode: false', () => {
    const provider = new OpenAIReasoningProvider('o1-mini');
    expect(provider.capabilities()).toEqual({ jsonMode: false, providerId: 'openai-reasoning' });
  });

  // -----------------------------------------------------------------------
  // Correction D2: redaction symmetry — mirrors the AnthropicProvider redaction test.
  // -----------------------------------------------------------------------
  it('redaction: a failure-path model string containing a secret is redacted in the thrown error', async () => {
    vi.stubEnv('OPENAI_REASONING_TEST_SECRET', 'super-secret-value-123');
    mockCreate
      .mockResolvedValueOnce(makeTextResponse('leak super-secret-value-123 here, not JSON'))
      .mockResolvedValueOnce(makeTextResponse('leak super-secret-value-123 here again, not JSON'));
    const provider = new OpenAIReasoningProvider('o1-mini');
    const err = await provider.callStep('prompt').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toContain('super-secret-value-123');
    expect(message).toContain('[REDACTED]');
    vi.unstubAllEnvs();
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
    const provider = await resolveProvider({
      provider: 'openai',
      model: 'o1-mini',
      promptCache: TEST_PROMPT_CACHE,
    });
    expect(provider).toBeInstanceOf(OpenAIReasoningProvider);
    expect(provider).not.toBeInstanceOf(ToolCapableLlmProvider);
  });

  // -----------------------------------------------------------------------
  // 9. o3 routes to OpenAIProvider (NOT OpenAIReasoningProvider)
  // -----------------------------------------------------------------------
  it('resolveProvider routes o3 to OpenAIProvider, not OpenAIReasoningProvider', async () => {
    const { OpenAIProvider } = await import('./openai-provider.js');
    const provider = await resolveProvider({
      provider: 'openai',
      model: 'o3',
      promptCache: TEST_PROMPT_CACHE,
    });
    expect(provider).not.toBeInstanceOf(OpenAIReasoningProvider);
    expect(provider).toBeInstanceOf(ToolCapableLlmProvider);
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  // -----------------------------------------------------------------------
  // 10. o3-mini routes to OpenAIProvider
  // -----------------------------------------------------------------------
  it('resolveProvider routes o3-mini to OpenAIProvider, not OpenAIReasoningProvider', async () => {
    const { OpenAIProvider } = await import('./openai-provider.js');
    const provider = await resolveProvider({
      provider: 'openai',
      model: 'o3-mini',
      promptCache: TEST_PROMPT_CACHE,
    });
    expect(provider).not.toBeInstanceOf(OpenAIReasoningProvider);
    expect(provider).toBeInstanceOf(ToolCapableLlmProvider);
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  // -----------------------------------------------------------------------
  // 11. o4-mini routes to OpenAIProvider
  // -----------------------------------------------------------------------
  it('resolveProvider routes o4-mini to OpenAIProvider, not OpenAIReasoningProvider', async () => {
    const { OpenAIProvider } = await import('./openai-provider.js');
    const provider = await resolveProvider({
      provider: 'openai',
      model: 'o4-mini',
      promptCache: TEST_PROMPT_CACHE,
    });
    expect(provider).not.toBeInstanceOf(OpenAIReasoningProvider);
    expect(provider).toBeInstanceOf(ToolCapableLlmProvider);
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  // -----------------------------------------------------------------------
  // 12. gpt-4o routes to OpenAIProvider (regression guard)
  // -----------------------------------------------------------------------
  it('resolveProvider routes gpt-4o to OpenAIProvider (regression guard)', async () => {
    const { OpenAIProvider } = await import('./openai-provider.js');
    const provider = await resolveProvider({
      provider: 'openai',
      model: 'gpt-4o',
      promptCache: TEST_PROMPT_CACHE,
    });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider).not.toBeInstanceOf(OpenAIReasoningProvider);
  });
});

// =================================================================================================
// issue #600 PR 1a — D1 (openai-reasoning's mapper, same OpenAI semantics) + D1a (the NEW
// callStepWithMeta override this provider had NONE of before this PR — #351 means it never honors
// strict, so this override is ALWAYS the bare-delegation shape) + D2 (count-agnostic)
// =================================================================================================
function makeTextResponseWithUsage(
  content: string,
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  },
) {
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: undefined } }],
    usage,
  };
}

describe('OpenAIReasoningProvider — issue #600 PR 1a D1: same OpenAI mapper semantics (prompt_tokens is the total)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('prompt_tokens read VERBATIM, cached_tokens a SUBSET never re-added', async () => {
    mockCreate.mockResolvedValueOnce(
      makeTextResponseWithUsage('{"result":"ok"}', {
        prompt_tokens: 800,
        completion_tokens: 60,
        prompt_tokens_details: { cached_tokens: 700 },
      }),
    );
    const provider = new OpenAIReasoningProvider('o1-mini');
    const result = await provider.callStepWithMeta('prompt');
    const [entry] = result.usage!;
    expect(entry!.prompt_tokens).toBe(800);
    expect(entry!.cache_read_input_tokens).toBe(700);
    expect(entry!.uncached_input_tokens).toBe(100);
    expect(entry!.output_tokens).toBe(60);
  });
});

describe('OpenAIReasoningProvider — issue #600 PR 1a D1a: this provider had NO callStepWithMeta override before this PR', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('BEFORE this PR (the base default): callStepWithMeta returned only { output } — the class this PR fixes. Verified by pinning the NEW override instead: usage is present.', async () => {
    // Red-first, structurally: `OpenAIReasoningProvider extends ToolCapableLlmProvider`, which did
    // not override callStepWithMeta at all, so it inherited `LlmProvider`'s base default —
    // `{ output }`, no usage field, by construction (constraint 2). This cell pins the GREEN side
    // (the new override exists and reports usage); the base class's own contract test already pins
    // the RED side generically (constraint 2 note above — "the base default keeps returning
    // { output }" is itself a pinned fact of the base class, not of this provider).
    mockCreate.mockResolvedValueOnce(
      makeTextResponseWithUsage('{"result":"ok"}', { prompt_tokens: 10, completion_tokens: 2 }),
    );
    const result = await new OpenAIReasoningProvider('o1-mini').callStepWithMeta('prompt');
    expect(result.usage).toBeDefined();
    expect(result.usage).toHaveLength(1);
  });

  it('callStep (public, untouched signature) DISCARDS usage by construction', async () => {
    mockCreate.mockResolvedValueOnce(
      makeTextResponseWithUsage('{"result":"ok"}', { prompt_tokens: 10, completion_tokens: 2 }),
    );
    const result = await new OpenAIReasoningProvider('o1-mini').callStep('prompt');
    expect(result).toEqual({ result: 'ok' });
    expect(Object.keys(result)).not.toContain('usage');
  });

  it('BYTE-IDENTITY — callStep and callStepWithMeta send the identical request body (constraint 1)', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"a":1}'));
    await new OpenAIReasoningProvider('o1-mini').callStep('same prompt');
    const viaCallStep = JSON.stringify(mockCreate.mock.calls[0]![0]);

    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"a":1}'));
    await new OpenAIReasoningProvider('o1-mini').callStepWithMeta('same prompt');
    const viaCallStepWithMeta = JSON.stringify(mockCreate.mock.calls[0]![0]);

    expect(viaCallStepWithMeta).toBe(viaCallStep);
  });

  it('this provider NEVER honors strict (#351) — callStepWithMeta never returns a structured_output meta, even when strict is requested', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"result":"ok"}'));
    const result = await new OpenAIReasoningProvider('o1-mini').callStepWithMeta(
      'prompt',
      { type: 'object' },
      undefined,
      { structuredOutputStrict: true },
    );
    expect(result.meta).toBeUndefined();
  });

  it('two billed requests (the non-JSON retry) yield TWO usage entries, in wire order — count-agnostic', async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeTextResponseWithUsage('not JSON', { prompt_tokens: 300, completion_tokens: 5 }),
      )
      .mockResolvedValueOnce(
        makeTextResponseWithUsage('{"result":"ok"}', { prompt_tokens: 310, completion_tokens: 6 }),
      );
    const result = await new OpenAIReasoningProvider('o1-mini').callStepWithMeta('prompt');
    expect(result.usage).toHaveLength(2);
    expect(result.usage![0]!.request_index).toBe(0);
    expect(result.usage![1]!.request_index).toBe(1);
  });
});

describe('OpenAIReasoningProvider — issue #600 PR 1a (D9): both entry points carry what was billed', () => {
  // Both of this provider's `attachBilledUsage` sites were unpinned: a per-member sweep commented
  // each out and the whole cli suite stayed green.
  beforeEach(() => {
    mockCreate.mockReset();
  });

  const billThenThrow = (): void => {
    mockCreate
      .mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'not JSON' } }],
        usage: {
          prompt_tokens: 700,
          completion_tokens: 9,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      })
      .mockImplementation(async () => {
        throw new Error('500 upstream exploded');
      });
  };
  const billedOn = async (call: () => Promise<unknown>): Promise<unknown> => {
    try {
      await call();
      expect.unreachable('the call must throw');
    } catch (err) {
      return (err as { driveCall?: { usage?: unknown[] } }).driveCall?.usage;
    }
  };

  it('callStep — the public single-shot path', async () => {
    billThenThrow();
    const usage = await billedOn(() => new OpenAIReasoningProvider('o1-mini').callStep('prompt'));
    expect(usage).toHaveLength(1);
    expect((usage as Array<{ prompt_tokens?: number }>)[0]).toMatchObject({ prompt_tokens: 700 });
  });

  it('callStepWithMeta, CLOCKED — the shape of every real drive keeps the usage', async () => {
    // The other cells run clockless, which skips driveCreate — the wrapper every real drive goes
    // through, and which attaches its own payload before this entry point's catch ever runs.
    billThenThrow();
    const usage = await billedOn(() =>
      new OpenAIReasoningProvider('o1-mini').callStepWithMeta('prompt', undefined, undefined, {
        llmClock: { ceilingMs: 60_000 },
      }),
    );
    expect(usage).toHaveLength(1);
    expect((usage as Array<{ prompt_tokens?: number }>)[0]).toMatchObject({ prompt_tokens: 700 });
  });

  it('callStepWithMeta — the override this PR added, which previously inherited the base default', async () => {
    billThenThrow();
    const usage = await billedOn(() =>
      new OpenAIReasoningProvider('o1-mini').callStepWithMeta('prompt'),
    );
    expect(usage).toHaveLength(1);
    expect((usage as Array<{ prompt_tokens?: number }>)[0]).toMatchObject({ prompt_tokens: 700 });
  });
});

// =================================================================================================
// GHSA-gxfq cell 17: model text is hidden BEFORE it is cut to 200 characters. A FAKE secret starts
// 5 characters before the cut; cut first, its first 5 characters reach the thrown message, where no
// pass can recognise them. Each case asserts the message is the site's own (a witness), that the
// oracle finds no form of the secret, and that no 4-character prefix of it is left.
// =================================================================================================
describe('cut after hiding (GHSA-gxfq cell 17)', () => {
  /** A FAKE secret written here: a `"`, a `\` and a newline. */
  const SECRET = 'fk"1\\2\n3z';
  /** Model text whose secret starts 5 characters before the 200-character cut. */
  const STRADDLING = `${'x'.repeat(195)}${SECRET} tail`;

  beforeEach(() => {
    mockCreate.mockReset();
    setAdditionalRedactionValues([SECRET]);
  });
  afterEach(() => {
    setAdditionalRedactionValues([]);
  });

  /**
   * (b) What a failing case prints: whether the message is the site's own, the oracle's
   * `{ path, decoders }` pairs, and whether a 4-character prefix of the secret is left — never the
   * message or the secret.
   */
  const facts = (err: unknown, site: string) => {
    const message = err instanceof Error ? err.message : String(err);
    return {
      site: message.includes(site),
      found: leakedForms(message, SECRET),
      prefixLeft: message.includes(SECRET.slice(0, 4)),
    };
  };
  const HIDDEN = { site: true, found: [], prefixLeft: false };

  it('openai-reasoning-provider.ts — non-JSON content after retry', async () => {
    mockCreate
      .mockResolvedValueOnce(makeTextResponse('not JSON'))
      .mockResolvedValueOnce(makeTextResponse(STRADDLING));
    const err = await new OpenAIReasoningProvider('o1-mini')
      .callStep('prompt')
      .catch((e: unknown) => e);
    // (a) red when this site cuts the model text before hiding it.
    expect(facts(err, 'OpenAI returned non-JSON content after retry: ')).toEqual(HIDDEN);
  });
});

// =========================================================================
// issue #600 PR 2 — what each o1 request records (B3, B4). Realm sends o1 no cache field. On a
// failing CI host each cell prints the recorded request facts: field values, never an
// environment, header or key.
// =========================================================================
describe('OpenAIReasoningProvider — the request facts (issue #600 PR 2)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  // G7 (o1). (a) red when o1 does not write provider_rules; (b) prints the facts.
  it('G7 — provider_rules and cache_split_offered false; no lifetime fields', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":"a"}'));
    const { usage } = await new OpenAIReasoningProvider('o1-mini').callStepWithMeta('prompt');
    const { request_index: _i, request_start: _s, ...rest } = usage![0]!;
    expect(rest).toEqual({ cache_requested: 'provider_rules', cache_split_offered: false });
    expect(JSON.stringify(mockCreate.mock.calls[0]![0])).not.toContain('cache');
  });

  // G8 (o1). (a) red when `model` is read from the requested model; (b) prints the model.
  it("G8 — model is the response's own (a dated id), never the requested one; none without one", async () => {
    mockCreate.mockResolvedValueOnce({
      ...makeTextResponse('{"x":"a"}'),
      model: 'o1-mini-2026-01-01',
    });
    const answered = await new OpenAIReasoningProvider('o1-mini').callStepWithMeta('prompt');
    expect(answered.usage![0]!.model).toBe('o1-mini-2026-01-01');
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":"a"}'));
    const unnamed = await new OpenAIReasoningProvider('o1-mini').callStepWithMeta('prompt');
    expect(unnamed.usage![0]).not.toHaveProperty('model');
  });

  // G10 (o1, the SDK mocked), against OpenAI's one constant. (a) red when endpoint is always
  // 'default'; (b) prints the endpoint.
  it("G10 — endpoint: 'default' at OpenAI's address, 'custom' elsewhere, absent without baseURL", async () => {
    const withBase = (baseURL: string) =>
      vi.mocked(OpenAI).mockImplementationOnce(function () {
        return { chat: { completions: { create: mockCreate } }, baseURL };
      } as never);
    withBase(OPENAI_DEFAULT_BASE_URL);
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":"a"}'));
    const native = await new OpenAIReasoningProvider('o1-mini').callStepWithMeta('prompt');
    expect(native.usage![0]!.endpoint).toBe('default');
    withBase('https://compat.example/v1');
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":"a"}'));
    const compat = await new OpenAIReasoningProvider('o1-mini').callStepWithMeta('prompt');
    expect(compat.usage![0]!.endpoint).toBe('custom');
    expect(JSON.stringify(compat.usage)).not.toContain('compat.example');
    mockCreate.mockResolvedValueOnce(makeTextResponse('{"x":"a"}'));
    const mocked = await new OpenAIReasoningProvider('o1-mini').callStepWithMeta('prompt');
    expect(mocked.usage![0]).not.toHaveProperty('endpoint');
  });
});
