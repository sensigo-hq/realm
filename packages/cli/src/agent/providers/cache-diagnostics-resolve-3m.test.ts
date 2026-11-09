// cache-diagnostics-resolve-3m.test.ts — caching 3-M piece B2b, check 2: what `resolveProvider` does
// with `--cache-diagnostics`. The real case: Realm asks Anthropic by default (the owner's "keep it"),
// and an operator who stated `off` must leave no fingerprint there. The SDK is mocked; its client has
// no `baseURL`, so the address reads as Anthropic's own and no request leaves the machine. On a
// failure a cell prints the setting and the body's keys, never a prompt or a key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProvider } from './llm-provider.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x'],
  properties: { x: { type: 'string' } },
};
const ANSWER = {
  id: 'msg_01AAAAAAAAAAAAAAAAAAAAAAAA',
  model: 'claude-x',
  content: [{ type: 'text', text: '{"x":"a"}' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 10,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

describe('caching 3-M B2b — resolveProvider and --cache-diagnostics', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'k-3m';
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(ANSWER);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = saved;
  });

  // (a) red when `off` is ignored (its row sends the key), or the default is off (the unstated row
  // sends none); (b) prints the setting, whether the key went, and the body's keys.
  it.each([
    ['unstated', undefined, true],
    ['stated on', 'on', true],
    ['stated off', 'off', false],
  ] as const)('%s: the question goes out? the body says', async (label, cacheDiagnostics, sent) => {
    const { provider } = await resolveProvider({
      provider: 'anthropic',
      model: 'claude-x',
      promptCache: { value: 'short', source: 'stated', by: 'realm agent' },
      ...(cacheDiagnostics !== undefined ? { cacheDiagnostics } : {}),
    });
    await provider.callStepWithMeta('prompt', SCHEMA);
    const body = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect({ label, sent: 'diagnostics' in body }, Object.keys(body).join(',')).toEqual({
      label,
      sent,
    });
  });
});
