// price-source-list.test.ts — issue #600 caching PR P (G9): the list adapter against the installed
// `@pydantic/genai-prices` 0.1.12, pinned EXACTLY as a devDependency (its model data changes from
// release to release; these figures are the design review's and the audit's probes). On a failing
// CI host each cell prints the priced figure and what the list matched: test figures only.
import { describe, expect, it } from 'vitest';
import * as list from '@pydantic/genai-prices';
import { priceRequest, type PriceInput, type PriceResult } from '@sensigo/realm';
import { listPriceSource, readPriceListVersion, LIST_ENDPOINT_NOTE } from './price-source-list.js';

const source = listPriceSource(list, readPriceListVersion());
const input = (
  model: string,
  extra: Partial<PriceInput> = {},
  usage: Partial<PriceInput['usage']> = {},
): PriceInput => ({
  model,
  at: '2026-10-01T00:00:00.000Z',
  usage: {
    prompt_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ...usage,
  },
  ...extra,
});
const total = (r: PriceResult): number | string =>
  'priced' in r ? Number(r.priced.total.toFixed(9)) : r.not_priced;

describe('the price list adapter on genai-prices 0.1.12 (issue #600 caching PR P, G9)', () => {
  // (a) red when the split keys are dropped (the total alone prices the 1-hour write at the
  // 5-minute rate: $0.022); (b) prints the figure.
  it('a recorded 1-hour split prices at the 1-hour rate: claude-sonnet-5-5 10k prompt / 4k 1h write = $0.028', () => {
    const r = source.price(
      input(
        'claude-sonnet-5-5',
        {},
        {
          prompt_tokens: 10000,
          cache_write_tokens: 4000,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 4000,
        },
      ),
    );
    expect(total(r)).toBe(0.028);
  });

  it('the list subtracts reads from the whole prompt: 10k prompt with 4k read = $0.0124; 6k with 4k = $0.0044', () => {
    expect([
      total(
        source.price(
          input('claude-sonnet-5-5', {}, { prompt_tokens: 10000, cache_read_tokens: 4000 }),
        ),
      ),
      total(
        source.price(
          input('claude-sonnet-5-5', {}, { prompt_tokens: 6000, cache_read_tokens: 4000 }),
        ),
      ),
    ]).toEqual([0.0124, 0.0044]);
  });

  // (a) red when the provider hint is always passed (a gateway's deepseek-chat is then not priced);
  // (b) prints both results.
  it('the provider hint only on the default endpoint: deepseek-chat through a custom endpoint is priced', () => {
    const custom = source.price(
      input(
        'deepseek-chat',
        { provider: 'openai', endpoint: 'custom' },
        { prompt_tokens: 1000, output_tokens: 10 },
      ),
    );
    const hinted = source.price(
      input(
        'deepseek-chat',
        { provider: 'openai', endpoint: 'default' },
        { prompt_tokens: 1000, output_tokens: 10 },
      ),
    );
    expect([
      'priced' in custom && [custom.priced_by.matched_provider, custom.priced_by.endpoint_note],
      total(hinted),
    ]).toEqual([['deepseek', LIST_ENDPOINT_NOTE], 'model_unknown']);
  });

  // (a) red when `equals_ids` is empty (gpt-5.6 is then refused by core's postcondition); (b) prints
  // the core result.
  it("the matched model's equals names are returned: gpt-5.6 is priced as gpt-5.6-sol through core's postcondition", () => {
    const r = priceRequest(
      {
        model: 'gpt-5.6',
        request_start: '2026-10-01T00:00:00.000Z',
        prompt_tokens: 10000,
        output_tokens: 100,
        cache_write_tokens: 4000,
        cache_split_offered: false,
        provider: 'openai',
        endpoint: 'default',
      },
      source,
    );
    expect(
      'priced' in r && [
        r.priced_by.matched_model,
        r.priced_by.equals_ids?.includes('gpt-5.6'),
        total(r),
      ],
    ).toEqual(['gpt-5.6-sol', true, 0.046]);
  });

  it('the version read from the installed package (its entry resolved, then the package.json above it)', () => {
    expect(readPriceListVersion()).toBe('0.1.12');
  });

  // (a) red when the note is set on the default endpoint; (b) prints the notes.
  it('the endpoint note on a custom endpoint only', () => {
    const at = (endpoint: 'default' | 'custom'): string | undefined => {
      const r = source.price(input('claude-sonnet-5-5', { endpoint }, { prompt_tokens: 1000 }));
      return 'priced' in r ? (r.priced_by.endpoint_note ?? 'none') : 'not priced';
    };
    expect([at('custom'), at('default')]).toEqual([LIST_ENDPOINT_NOTE, 'none']);
  });

  // (a) red when date_basis means "a dated entry applied" (the 2020 call priced at the undated base
  // would read current); (b) prints the figures and bases.
  it("date_basis: claude-sonnet-4-6 300k is $1.80 in 2020 and $0.90 in 2026, both 'dated'; claude-sonnet-5-5 (one price) 'current'", () => {
    const at = (when: string, model = 'claude-sonnet-4-6'): unknown => {
      const r = source.price(input(model, { at: when }, { prompt_tokens: 300000 }));
      return 'priced' in r ? [total(r), r.priced_by.date_basis] : r.not_priced;
    };
    expect([
      at('2020-01-01T00:00:00.000Z'),
      at('2026-10-01T00:00:00.000Z'),
      at('2026-10-01T00:00:00.000Z', 'claude-sonnet-5-5'),
    ]).toEqual([
      [1.8, 'dated'],
      [0.9, 'dated'],
      [0.6, 'current'],
    ]);
  });

  it('the counterfactual is the prompt and output alone', () => {
    const r = source.price(
      input('claude-sonnet-5-5', {}, { prompt_tokens: 10000, cache_read_tokens: 4000 }),
    );
    // 10k prompt at the full input rate ($2 per million on 0.1.12), against $0.0124 with the read.
    expect('priced' in r && Number(r.priced.uncached_counterfactual.toFixed(9))).toBe(0.02);
  });
});
