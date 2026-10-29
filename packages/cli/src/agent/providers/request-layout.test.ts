// request-layout.test.ts — issue #600 caching PR 5 (C4): the describer is a mirror of each built-in
// adapter's single-shot request, pinned here. Each row captures the body the adapter actually sends
// (its SDK stubbed), reads its stable part in the PROVIDER's documented prefix order — Anthropic:
// `tools`, then `system` (its prompt-caching page; the body object's key order is not the prefix
// order) — and asserts it equals the describer's stable blocks, text for text. The submit tool is
// built by the one moved function on both sides, so no row can catch a drift inside it: the move is
// what prevents one. On a failing host each row prints block names and texts built from the test's
// own schema and profile: no key, no environment.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { OpenAIReasoningProvider } from './openai-reasoning-provider.js';
import { describeRequestLayout, type RequestParts } from './request-layout.js';
import { chooseAdapter } from './llm-provider.js';

const anthropicCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: anthropicCreate } };
  }),
}));
const openaiCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: openaiCreate } } };
  }),
}));

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category'],
  properties: { category: { type: 'string' } },
};
const PROFILE = 'You are a careful reviewer.\nNever guess.';
const PROMPT = 'Classify this ticket.';
const ANSWER = { category: 'billing' };

/** The rows: every combination of schema, profile and strict the adapter can be asked for. */
function rows(withStrict: boolean): Array<{ label: string; parts: RequestParts }> {
  const out: Array<{ label: string; parts: RequestParts }> = [];
  for (const schema of [undefined, SCHEMA])
    for (const profile of [undefined, PROFILE])
      for (const strict of withStrict ? [false, true] : [false])
        out.push({
          label: `${schema ? 'schema' : 'no schema'} · ${profile ? 'profile' : 'no profile'}${withStrict ? ` · ${strict ? 'strict' : 'not strict'}` : ''}`,
          parts: {
            ...(schema !== undefined ? { schema } : {}),
            ...(profile !== undefined ? { profile } : {}),
            strict,
          },
        });
  return out;
}

/** The describer's stable blocks, as [name, text]. */
function described(adapter: Parameters<typeof describeRequestLayout>[0], parts: RequestParts) {
  return describeRequestLayout(adapter, parts)
    .filter((b) => b.stable)
    .map((b) => [b.name, b.text]);
}

beforeEach(() => {
  anthropicCreate.mockReset();
  openaiCreate.mockReset();
});

describe('the anthropic layout is the body AnthropicProvider sends (C4)', () => {
  // (a) red when the describer puts `system` before `tools`, drops `strict: true` from its tool, or
  //     builds a system text the adapter does not send; (b) prints the stable blocks on both sides.
  it.each(rows(true))('$label', async ({ parts }) => {
    anthropicCreate.mockResolvedValueOnce(
      parts.schema !== undefined
        ? { content: [{ type: 'tool_use', id: 't1', name: '__realm_submit__', input: ANSWER }] }
        : { content: [{ type: 'text', text: JSON.stringify(ANSWER) }] },
    );
    await new AnthropicProvider('claude-sonnet-4-5').callStepWithMeta(
      PROMPT,
      parts.schema,
      parts.profile,
      { structuredOutputStrict: parts.strict },
    );
    const body = anthropicCreate.mock.calls[0]![0] as Record<string, unknown>;
    const system = body['system'];
    const systemText =
      typeof system === 'string' ? system : (system as Array<{ text: string }>)[0]!.text;
    // Anthropic's prefix order: tools, then system.
    const wire = [
      ...(body['tools'] !== undefined ? [['tools', JSON.stringify(body['tools'])]] : []),
      ['system', systemText],
    ];
    expect(wire).toEqual(described('anthropic', parts));
  });
});

describe('the openai layout is the body OpenAIProvider sends (C4)', () => {
  // (a) red when the describer drops the response_format block on the strict rung with a schema,
  //     adds one elsewhere (the plain path's `{ type: 'json_object' }` is a request setting, not a
  //     block), or builds a system text the adapter does not send; (b) prints both sides' blocks.
  it.each(rows(true))('$label', async ({ parts }) => {
    openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(ANSWER) } }],
    });
    await new OpenAIProvider('gpt-4o').callStepWithMeta(PROMPT, parts.schema, parts.profile, {
      structuredOutputStrict: parts.strict,
    });
    const body = openaiCreate.mock.calls[0]![0] as Record<string, unknown>;
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    const format = body['response_format'] as { type?: string } | undefined;
    const wire = [
      ...(format !== undefined && format.type === 'json_schema'
        ? [['response_format', JSON.stringify(format)]]
        : []),
      ['system', messages.find((m) => m.role === 'system')!.content],
    ];
    expect(wire).toEqual(described('openai', parts));
  });
});

describe('the openai-reasoning layout is the body OpenAIReasoningProvider sends (C4)', () => {
  // (a) red when the describer's `messages-head` is not the start of the one user message the o1
  //     adapter sends (its separator before the input changed, or a system text the adapter does not
  //     send), or the rest of that message is not the input; (b) prints the head and the rest.
  it.each(rows(false))('$label', async ({ parts }) => {
    openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(ANSWER) } }],
    });
    await new OpenAIReasoningProvider('o1').callStepWithMeta(PROMPT, parts.schema, parts.profile);
    const body = openaiCreate.mock.calls[0]![0] as Record<string, unknown>;
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    const [head] = described('openai-reasoning', parts);
    const sent = messages[0]!.content;
    expect([
      messages.length,
      sent.slice(0, head![1]!.length),
      sent.slice(head![1]!.length),
    ]).toEqual([1, head![1], PROMPT]);
  });
});

describe('chooseAdapter, the o1 rule in one place (C3.1)', () => {
  // (a) red when the rule loses its `i`, matches o1's successors, or names anthropic otherwise;
  //     (b) prints each adapter.
  it('o1, o1-mini and O1-PREVIEW take the reasoning shape; o3, o4-mini and gpt-4o take openai; anthropic its own', () => {
    expect(
      [
        ['openai', 'o1'],
        ['openai', 'o1-mini'],
        ['openai', 'O1-PREVIEW'],
        ['openai', 'o10'],
        ['openai', 'o3'],
        ['openai', 'o4-mini'],
        ['openai', 'gpt-4o'],
        ['anthropic', 'o1'],
      ].map(([p, m]) => chooseAdapter(p as 'openai' | 'anthropic', m!)),
    ).toEqual([
      'openai-reasoning',
      'openai-reasoning',
      'openai-reasoning',
      'openai',
      'openai',
      'openai',
      'openai',
      'anthropic',
    ]);
  });
});
