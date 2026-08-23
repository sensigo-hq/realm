// openai-provider-budget.test.ts — issue #401: the ceiling reaches every OpenAI consumption hop.
//
// PER MEMBER, not per provider. A clock that arrives at one method region and evaporates at
// another leaves a whole class of steps unbounded, and nothing about that is visible: no error,
// no warning, just a request with no ceiling. A source rail proves the CALL is wrapped; only a
// behavioural cell proves the CLOCK got there. Both hop counts here — OpenAI's three regions
// plus its two delegations, and the reasoning provider's one — have their own cell below.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './openai-provider.js';
import { OpenAIReasoningProvider } from './openai-reasoning-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

const payloadOf = (err: unknown): Record<string, unknown> | undefined =>
  (err as { driveCall?: Record<string, unknown> } | null)?.driveCall;
const TINY = { ceilingMs: 40, declaredPerAttemptMs: 15 };
const jsonResponse = (obj: unknown) => ({
  choices: [{ message: { role: 'assistant', content: JSON.stringify(obj) } }],
});

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockImplementation(() => new Promise(() => undefined)); // hangs, by default
});

describe('OpenAIProvider — every hop the clock has to survive', () => {
  it('(a) callStep', async () => {
    const err = await new OpenAIProvider('gpt-x')
      .callStep('go', undefined, undefined, { llmClock: TINY })
      .catch((e: unknown) => e);
    expect(payloadOf(err)?.['error_class']).toBe('aborted_by_budget');
  });

  it('(b) the strict-ladder create helper — one hang covers both of its legs', async () => {
    // The first leg hangs, so the ceiling fires there. An abort carries no HTTP status, and the
    // ladder's downgrade arm is gated on a 400, so the abort propagates untouched rather than
    // being re-attributed to structured output.
    const err = await new OpenAIProvider('gpt-x')
      .callStepWithMeta('go', { type: 'object' }, undefined, {
        structuredOutputStrict: true,
        llmClock: TINY,
      })
      .catch((e: unknown) => e);
    expect(payloadOf(err)?.['error_class']).toBe('aborted_by_budget');
  });

  it('(c) the no-strict callStepWithMeta → callStep delegation', async () => {
    // This provider's own delegation, distinct from the base class's. Every step that never
    // opted into strict structured output lands here.
    const err = await new OpenAIProvider('gpt-x')
      .callStepWithMeta('go', undefined, undefined, { llmClock: TINY })
      .catch((e: unknown) => e);
    expect(payloadOf(err)?.['error_class']).toBe('aborted_by_budget');
  });

  it('(d) callStepWithTools', async () => {
    const tools: ToolDefinition[] = [
      {
        id: 'gh:get',
        serverId: 'gh',
        name: 'get',
        description: 'd',
        inputSchema: { type: 'object' },
      },
    ];
    const err = await new OpenAIProvider('gpt-x')
      .callStepWithTools('go', tools, async () => ({}), { llmClock: TINY })
      .catch((e: unknown) => e);
    expect(payloadOf(err)?.['error_class']).toBe('aborted_by_budget');
  });

  it('(e) OpenAIReasoningProvider.callStep', async () => {
    const err = await new OpenAIReasoningProvider('o1')
      .callStep('go', undefined, undefined, { llmClock: TINY })
      .catch((e: unknown) => e);
    expect(payloadOf(err)?.['error_class']).toBe('aborted_by_budget');
  });

  it('(f) NEGATIVE CONTROL — no clock, no bound, no abort-signal opinion', async () => {
    // Record R-14's boundary, on this provider too: a caller that threads no clock gets the
    // failure RECORD like everyone else, but not the ceiling.
    mockCreate.mockResolvedValue(jsonResponse({ ok: true }));
    await expect(new OpenAIProvider('gpt-x').callStep('go')).resolves.toEqual({ ok: true });
    expect(mockCreate.mock.calls[0]?.[1]).toEqual({});
  });
});
