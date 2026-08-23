// anthropic-provider-budget.test.ts — issue #401 PR-2: the ceiling as the provider applies it.
// The SDK module is mocked (the house idiom); what is real is the provider's own routing of every
// create through driveCreate and the clock it was handed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicProvider,
  assertMaxTokensCoherent,
  resolveMaxTokens,
  MAX_NONSTREAMING_TOKENS,
} from './anthropic-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';
import { buildEntry } from '../drive-failure.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

const textResponse = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const payloadOf = (err: unknown): Record<string, unknown> | undefined =>
  (err as { driveCall?: Record<string, unknown> } | null)?.driveCall;

beforeEach(() => {
  mockCreate.mockReset();
});

describe('AnthropicProvider under a clock — the ceiling is PER CREATE', () => {
  it('two slow turns each finish inside the ceiling, so the step succeeds', () => {
    // The bound is per create, not per invocation. A step that legitimately needs more than one
    // turn must not be killed for the SUM of them — 2 x 30ms exceeds this 50ms ceiling, so a
    // wrapper placed around the whole invocation instead of each request reds this cell.
    const slow = async (text: string): Promise<unknown> => {
      await new Promise((r) => setTimeout(r, 30));
      return textResponse(text);
    };
    mockCreate
      .mockImplementationOnce(async () => slow('not json'))
      .mockImplementationOnce(async () => slow('{"answer":"done"}'));

    const provider = new AnthropicProvider('claude-x');
    return expect(
      provider.callStep('go', undefined, undefined, {
        llmClock: { ceilingMs: 50, declaredPerAttemptMs: 20 },
      }),
    ).resolves.toEqual({ answer: 'done' });
  });

  it('ONE create over the ceiling aborts the step, naming the lever', async () => {
    mockCreate.mockImplementation(() => new Promise(() => undefined));
    const provider = new AnthropicProvider('claude-x');
    const err = await provider
      .callStep('go', undefined, undefined, {
        llmClock: { ceilingMs: 40, declaredPerAttemptMs: 15 },
      })
      .catch((e: unknown) => e);

    expect((err as Error).message).toContain('llm_timeout_seconds');
    expect((err as Error).message).toContain('--llm-timeout');
    expect(payloadOf(err)?.['error_class']).toBe('aborted_by_budget');
    expect(payloadOf(err)?.['declared_per_attempt_ms']).toBe(15);
    expect(payloadOf(err)?.['derived_ceiling_ms']).toBe(40);
  });

  it('WITHOUT a clock the provider behaves exactly as before — no bound, no signal opinion', async () => {
    // Record R-14's boundary, executed: a caller that threads no clock gets the record, not the
    // bound. A hang here would hang forever, which is precisely what the CLI never does.
    mockCreate.mockResolvedValue(textResponse('{"ok":true}'));
    const provider = new AnthropicProvider('claude-x');
    await expect(provider.callStep('go')).resolves.toEqual({ ok: true });
    expect(mockCreate.mock.calls[0]?.[1]).toEqual({}); // no abort signal was minted
  });

  it('the ceiling firing during the LADDERs drop-retry is still classified aborted_by_budget', async () => {
    // The strict ladder wraps its second-leg failure in StructuredOutputLadderError. The payload
    // travels on the cause chain, so the abort must survive the wrap — otherwise the one failure
    // realm can attribute precisely arrives as a shapeless 'other'.
    mockCreate
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('bad schema'), { status: 400 });
      })
      .mockImplementationOnce(() => new Promise(() => undefined)); // the drop-retry hangs

    const provider = new AnthropicProvider('claude-x');
    const err = await provider
      .callStepWithMeta('go', { type: 'object' }, undefined, {
        structuredOutputStrict: true,
        llmClock: { ceilingMs: 40, declaredPerAttemptMs: 15 },
      })
      .catch((e: unknown) => e);

    // The wrapper is what run-agent sees; the payload is one cause down, which is exactly the
    // shape drive-failure's payload-first walk was built for.
    const cause = (err as { cause?: unknown }).cause;
    expect(payloadOf(cause)?.['error_class']).toBe('aborted_by_budget');

    // ...and the CHOKEPOINT agrees. The payload being on the cause chain is only half the claim;
    // what matters is that the classifier walks to it, so the wrapped abort is recorded as a
    // budget abort rather than as a shapeless 'other'.
    expect(buildEntry(err, 'classify', 'anthropic', Date.now()).error_class).toBe(
      'aborted_by_budget',
    );
  });

  it('the TOOLS path is bounded too — every turn of the agentic loop', async () => {
    mockCreate.mockImplementation(() => new Promise(() => undefined));
    const provider = new AnthropicProvider('claude-x');
    const tools: ToolDefinition[] = [
      {
        id: 'gh:get',
        serverId: 'gh',
        name: 'get',
        description: 'd',
        inputSchema: { type: 'object' },
      },
    ];
    const err = await provider
      .callStepWithTools('go', tools, async () => ({}), {
        llmClock: { ceilingMs: 40, declaredPerAttemptMs: 15 },
      })
      .catch((e: unknown) => e);
    expect(payloadOf(err)?.['error_class']).toBe('aborted_by_budget');
  });
});

describe('the non-streaming max_tokens rule realm re-imposes (issue #401)', () => {
  it('refuses a request the SDK itself would have refused', () => {
    // Realm's own `timeout` turns the SDK's identical check off (it runs only when no timeout was
    // given), so realm states it here. Driven directly, because no model realm ships today asks
    // for enough tokens to reach it — see the canary below.
    expect(() => {
      assertMaxTokensCoherent(MAX_NONSTREAMING_TOKENS + 1, {
        ceilingMs: 1,
        declaredPerAttemptMs: 1,
      });
    }).toThrow(/must be streamed/);
  });

  it('stays silent with no clock — there the SDKs own guard is still running', () => {
    expect(() => {
      assertMaxTokensCoherent(MAX_NONSTREAMING_TOKENS + 1, undefined);
    }).not.toThrow();
  });

  it('CANARY — every model realm resolves today asks for FEWER tokens than the limit', () => {
    // This is what makes the rule latent rather than live. If someone raises one of the buckets
    // BELOW past the threshold, this cell fails and says what the choice actually is: stream, or
    // ask for less. It covers the buckets named here, not every model id that could ever resolve
    // — a new bucket added without a line here is a new blind spot, which is the one thing this
    // cell cannot tell you about itself.
    for (const model of ['claude-3-5-sonnet', 'claude-3-opus', 'claude-sonnet-4-5', 'unknown-x']) {
      expect(resolveMaxTokens(model)).toBeLessThanOrEqual(MAX_NONSTREAMING_TOKENS);
    }
  });
});
