// price-source.test.ts — issue #600 caching PR P (G3): core's checks around every price — the
// preconditions before a source is asked (one cell per member) and the postcondition after (the
// model the source matched must be the one the request named). On a failing CI host each cell
// prints the result: causes and test figures only.
import { describe, expect, it } from 'vitest';
import { priceRequest, type PriceInput, type PriceSource } from './price-source.js';

/** A source that prices everything at $1 as `matched`, and records what it was asked. */
function fakeSource(matched: { model?: string; equals?: string[] } = {}): PriceSource & {
  asked: PriceInput[];
} {
  const asked: PriceInput[] = [];
  return {
    asked,
    price(input) {
      asked.push(input);
      return {
        priced: { total: 1, uncached_counterfactual: 2 },
        priced_by: {
          source_class: 'price_list',
          source_ref: 'fake',
          matched_model: matched.model ?? input.model,
          ...(matched.equals !== undefined ? { equals_ids: matched.equals } : {}),
          date_basis: 'current',
        },
      };
    },
  };
}

const request = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  request_index: 0,
  request_start: '2026-10-01T00:00:00.000Z',
  model: 'claude-x',
  prompt_tokens: 100,
  output_tokens: 10,
  ...extra,
});
const cause = (r: ReturnType<typeof priceRequest>): string =>
  'not_priced' in r ? r.not_priced : 'priced';

describe('the preconditions, one per member (G3)', () => {
  // Each: (a) red when that check is removed (the source prices the request); (b) prints the cause.
  it.each([
    ['no model', { model: undefined }, 'model_not_recorded'],
    ['a model with a control character', { model: 'x\u001by' }, 'model_not_recorded'],
    ['an unreadable date', { request_start: 'not a date' }, 'date_unreadable'],
    ['no prompt_tokens', { prompt_tokens: undefined }, 'usage_incomplete'],
    ['no output_tokens', { output_tokens: undefined }, 'usage_incomplete'],
    ['a negative counter', { cache_read_input_tokens: -1 }, 'usage_incomplete'],
    ['a counter that is not a number', { cache_read_input_tokens: '5' }, 'usage_incomplete'],
    [
      'reads and writes above the prompt',
      // An unsplit write from a provider that never splits, so only the sum check refuses it.
      { cache_read_input_tokens: 60, cache_creation_input_tokens: 50, cache_split_offered: false },
      'usage_incomplete',
    ],
    [
      'a split that does not add up to the write',
      {
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 10 },
      },
      'usage_incomplete',
    ],
    [
      'writes with no split from a provider that splits',
      { cache_creation_input_tokens: 50, cache_split_offered: true },
      'usage_incomplete',
    ],
    [
      'writes with no split, the provider not stated',
      { cache_creation_input_tokens: 50 },
      'usage_incomplete',
    ],
  ])('%s → %s', (_label, extra, expected) => {
    const source = fakeSource();
    expect([cause(priceRequest(request(extra), source)), source.asked.length]).toEqual([
      expected,
      0,
    ]);
  });

  it('a request that passes every check reaches the source with the usage in its own keys', () => {
    const source = fakeSource();
    const r = priceRequest(
      request({
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
        provider: 'anthropic',
        endpoint: 'custom',
        uncached_input_tokens: 999,
      }),
      source,
    );
    expect([cause(r), source.asked[0]]).toEqual([
      'priced',
      {
        model: 'claude-x',
        at: '2026-10-01T00:00:00.000Z',
        provider: 'anthropic',
        endpoint: 'custom',
        usage: {
          prompt_tokens: 100,
          output_tokens: 10,
          cache_read_tokens: 20,
          cache_write_tokens: 30,
          cache_write_5m_tokens: 10,
          cache_write_1h_tokens: 20,
        },
      },
    ]);
  });

  it('unsplit writes from a provider that never splits (OpenAI) are priced', () => {
    expect(
      cause(
        priceRequest(request({ cache_write_tokens: 50, cache_split_offered: false }), fakeSource()),
      ),
    ).toBe('priced');
  });
});

describe('the postcondition (G3)', () => {
  // (a) red when the postcondition is removed (a prefix match is priced); (b) prints the causes.
  it('the recorded model must be the matched model or one of its equals names, or either with a date suffix', () => {
    const priced = (model: string, matched: { model?: string; equals?: string[] }): string =>
      cause(priceRequest(request({ model }), fakeSource(matched)));
    expect([
      priced('gpt-5.6', { model: 'gpt-5.6-sol', equals: ['gpt-5.6-sol', 'gpt-5.6'] }),
      priced('claude-sonnet-4-5-v2', { model: 'claude-sonnet-4-5' }),
      priced('claude-3-5-haiku-20241022', { model: 'claude-3-5-haiku-latest' }),
      priced('claude-sonnet-5-5-20260101', { model: 'claude-sonnet-5-5' }),
      priced('gpt-4o-2024-08-06', { model: 'gpt-4o-2024-08-06' }),
    ]).toEqual(['priced', 'model_unknown', 'model_unknown', 'priced', 'priced']);
  });

  // (a) red when a throw or a malformed answer is passed on; (b) prints the causes.
  it('a source that throws, or answers in another shape, is price_list_error', () => {
    const throwing: PriceSource = {
      price: () => {
        throw new Error('boom');
      },
    };
    const malformed = { price: () => ({ priced: { total: 'x' } }) } as unknown as PriceSource;
    const badCause = { price: () => ({ not_priced: 'nope' }) } as unknown as PriceSource;
    expect([
      cause(priceRequest(request(), throwing)),
      cause(priceRequest(request(), malformed)),
      cause(priceRequest(request(), badCause)),
    ]).toEqual(['price_list_error', 'price_list_error', 'price_list_error']);
  });
});
