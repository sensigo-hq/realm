// cache-economics.test.ts — issue #600 caching PR P (G1, G2): the economics file's format v1 and its
// evaluator. Fixtures may use the field's model ids and figures (the design review's probes on the
// price list 0.1.12): production carries no price. On a failing CI host each cell prints the refusal
// reason or the computed figure: test values only.
import { describe, expect, it } from 'vitest';
import {
  parseCacheEconomics,
  priceFromEconomics,
  withoutDateSuffix,
  type CacheEconomics,
} from './cache-economics.js';
import type { PriceUsage } from './price-source.js';

const usage = (u: Partial<PriceUsage>): PriceUsage => ({
  prompt_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  ...u,
});

const reasonOf = (text: string): string => {
  const parsed = parseCacheEconomics(text);
  return 'error' in parsed ? parsed.error.reason : 'ACCEPTED';
};

const VALID = [
  'version: 1',
  'currency: USD',
  'models:',
  '  m:',
  '    prices:',
  '      - per_million_tokens: { input: 3, output: 15, cache_read: 0.3 }',
  '',
].join('\n');

describe('the economics file, format v1 (G1)', () => {
  it('a valid file parses', () => {
    expect(reasonOf(VALID)).toBe('ACCEPTED');
  });

  // One cell per refusal. (a) red when the refusal is removed from the schema or the post-check;
  // (b) prints the reason.
  it.each([
    [
      'an unknown key',
      VALID.replace('currency: USD', 'currency: USD\nextra: 1'),
      "economics: unknown key 'extra'",
    ],
    [
      'version 2',
      VALID.replace('version: 1', 'version: 2'),
      'economics/version: must be equal to constant',
    ],
    [
      'currency EUR',
      VALID.replace('currency: USD', 'currency: EUR'),
      'economics/currency: must be equal to one of the allowed values',
    ],
    [
      'a dated first price',
      VALID.replace(
        '      - per_million_tokens',
        '      - start_date: 2026-01-01\n        per_million_tokens',
      ),
      'economics/models/m/prices/0: the first price has no start_date (it applies before every dated one)',
    ],
    [
      'a second undated price',
      VALID + '      - per_million_tokens: { input: 2, output: 10 }\n',
      'economics/models/m/prices/1: every price after the first needs a start_date',
    ],
    [
      'a duplicate date',
      VALID +
        '      - start_date: 2026-02-01\n        per_million_tokens: { input: 2, output: 10 }\n' +
        '      - start_date: 2026-02-01\n        per_million_tokens: { input: 1, output: 5 }\n',
      "economics/models/m/prices/2: start_date '2026-02-01' must come after '2026-02-01' (dates ascending, each once)",
    ],
    [
      'unsorted dates',
      VALID +
        '      - start_date: 2026-03-01\n        per_million_tokens: { input: 2, output: 10 }\n' +
        '      - start_date: 2026-02-01\n        per_million_tokens: { input: 1, output: 5 }\n',
      "economics/models/m/prices/2: start_date '2026-02-01' must come after '2026-03-01' (dates ascending, each once)",
    ],
    [
      'a date not on the calendar',
      VALID +
        '      - start_date: 2026-02-30\n        per_million_tokens: { input: 2, output: 10 }\n',
      "economics/models/m/prices/1: start_date '2026-02-30' is not a date on the calendar",
    ],
    [
      'a negative rate',
      VALID.replace('input: 3,', 'input: -1,'),
      'economics/models/m/prices/0/per_million_tokens/input: must be >= 0',
    ],
    [
      'tier thresholds unsorted',
      VALID.replace(
        '      - per_million_tokens: { input: 3, output: 15, cache_read: 0.3 }',
        '      - per_million_tokens: { input: 3, output: 15 }\n        tiers:\n' +
          '          - { above_prompt_tokens: 200, per_million_tokens: { input: 6, output: 30 } }\n' +
          '          - { above_prompt_tokens: 100, per_million_tokens: { input: 5, output: 25 } }',
      ),
      'economics/models/m/prices/0/tiers/1: above_prompt_tokens must be above 200 (thresholds ascending, each once)',
    ],
    [
      'tier thresholds duplicated',
      VALID.replace(
        '      - per_million_tokens: { input: 3, output: 15, cache_read: 0.3 }',
        '      - per_million_tokens: { input: 3, output: 15 }\n        tiers:\n' +
          '          - { above_prompt_tokens: 100, per_million_tokens: { input: 6, output: 30 } }\n' +
          '          - { above_prompt_tokens: 100, per_million_tokens: { input: 5, output: 25 } }',
      ),
      'economics/models/m/prices/0/tiers/1: above_prompt_tokens must be above 100 (thresholds ascending, each once)',
    ],
    [
      'a tier missing a rate its price has',
      VALID.replace(
        '      - per_million_tokens: { input: 3, output: 15, cache_read: 0.3 }',
        '      - per_million_tokens: { input: 3, output: 15, cache_read: 0.3 }\n        tiers:\n' +
          '          - { above_prompt_tokens: 100, per_million_tokens: { input: 6, output: 30 } }',
      ),
      "economics/models/m/prices/0/tiers/0: the tier has no 'cache_read', which its price has (a tier carries every rate of its price)",
    ],
  ])('refuses %s', (_label, text, reason) => {
    expect(reasonOf(text)).toBe(reason);
  });

  // (a) red when the file is read with js-yaml's default schema (an unquoted date becomes a Date
  // and fails `type: string`); (b) prints the reason.
  it('an unquoted date is accepted, as a string', () => {
    const parsed = parseCacheEconomics(
      VALID +
        '      - start_date: 2026-09-01\n        per_million_tokens: { input: 2, output: 10 }\n',
    );
    expect('economics' in parsed && parsed.economics.models['m']!.prices[1]!.start_date).toBe(
      '2026-09-01',
    );
  });

  it('a YAML error gives its reason, line and column', () => {
    const parsed = parseCacheEconomics('version: 1\ncurrency: [USD\n');
    expect('error' in parsed && typeof parsed.error.line).toBe('number');
  });
});

describe('priceFromEconomics (G2)', () => {
  // The list's own rates for `gpt-5.6-sol` on its dated entry (input 4, cache_write 5, cache_read
  // 0.4, output 20 per million; the audit's probe M7), and a tier above 272,000 prompt tokens.
  const GPT: CacheEconomics = {
    version: 1,
    currency: 'USD',
    models: {
      'gpt-5.6': {
        prices: [
          {
            per_million_tokens: { input: 4, cache_write: 5, cache_read: 0.4, output: 20 },
            tiers: [
              {
                above_prompt_tokens: 272000,
                per_million_tokens: { input: 8, cache_write: 10, cache_read: 0.8, output: 40 },
              },
            ],
          },
        ],
      },
    },
  };
  const total = (r: ReturnType<typeof priceFromEconomics>): number | string =>
    'priced' in r ? Number(r.priced.total.toFixed(9)) : r.not_priced;

  // (a) red when uncached input is read as prompt − read (the record's OpenAI `uncached_input`,
  // which still holds the writes): $0.062; (b) prints the figure.
  it('uncached input = prompt − read − write: gpt-5.6 10k / 4k write / 100 out is the list’s $0.046', () => {
    const r = priceFromEconomics(
      GPT,
      'gpt-5.6',
      '2026-10-01T00:00:00Z',
      usage({ prompt_tokens: 10000, cache_write_tokens: 4000, output_tokens: 100 }),
    );
    expect(total(r)).toBe(0.046);
  });

  // (a) red when the tier prices only the tokens above the threshold, or is ignored; (b) prints both.
  it('the tier: 272,000 at the base, 272,001 at the tier — the whole request, output included; the counterfactual at the same tier', () => {
    const at = '2026-10-01T00:00:00Z';
    const base = priceFromEconomics(
      GPT,
      'gpt-5.6',
      at,
      usage({ prompt_tokens: 272000, output_tokens: 100 }),
    );
    const tier = priceFromEconomics(
      GPT,
      'gpt-5.6',
      at,
      usage({ prompt_tokens: 272001, output_tokens: 100 }),
    );
    expect([total(base), total(tier)]).toEqual([1.09, 2.180008]);
    expect('priced' in tier && Number(tier.priced.uncached_counterfactual.toFixed(9))).toBe(
      2.180008,
    );
  });

  const SONNET: CacheEconomics = {
    version: 1,
    currency: 'USD',
    models: {
      'claude-sonnet-5-5': {
        prices: [
          {
            per_million_tokens: {
              input: 3,
              output: 15,
              cache_read: 0.3,
              cache_write_5m: 3.75,
              cache_write_1h: 6,
            },
          },
        ],
      },
      'claude-sonnet-4-6': {
        prices: [
          { per_million_tokens: { input: 6, output: 30 } },
          { start_date: '2026-03-13', per_million_tokens: { input: 3, output: 15 } },
        ],
      },
    },
  };

  // (a) red when the split is ignored (every write at one rate) or a missing split rate is priced at
  // 0; (b) prints the figure.
  it('split rates when the usage is split; rate_missing naming the rate when the file lacks it', () => {
    const at = '2026-10-01T00:00:00Z';
    const split = priceFromEconomics(
      SONNET,
      'claude-sonnet-5-5',
      at,
      usage({
        prompt_tokens: 10000,
        cache_write_tokens: 4000,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 4000,
      }),
    );
    expect(total(split)).toBe(0.042);
    const unsplitFile: CacheEconomics = {
      version: 1,
      currency: 'USD',
      models: {
        m: { prices: [{ per_million_tokens: { input: 1, output: 2, cache_write: 1.25 } }] },
      },
    };
    const missing = priceFromEconomics(
      unsplitFile,
      'm',
      at,
      usage({
        prompt_tokens: 10,
        cache_write_tokens: 4,
        cache_write_5m_tokens: 4,
        cache_write_1h_tokens: 0,
      }),
    );
    expect(missing).toEqual({
      not_priced: 'rate_missing',
      detail: "has no 'cache_write_5m' rate for 'm'",
    });
  });

  // (a) red when the single write rate is not used for an unsplit write; (b) prints the figure.
  it('a single rate when the usage is not split', () => {
    const r = priceFromEconomics(
      GPT,
      'gpt-5.6',
      '2026-10-01T00:00:00Z',
      usage({ prompt_tokens: 4000, cache_write_tokens: 4000 }),
    );
    expect(total(r)).toBe(0.02);
  });

  // (a) red when the split sum check is removed; (b) prints the cause.
  it('usage_incomplete when 5m + 1h is not the write', () => {
    const r = priceFromEconomics(
      SONNET,
      'claude-sonnet-5-5',
      '2026-10-01T00:00:00Z',
      usage({
        prompt_tokens: 10000,
        cache_write_tokens: 4000,
        cache_write_5m_tokens: 1000,
        cache_write_1h_tokens: 1000,
      }),
    );
    expect(r).toEqual({ not_priced: 'usage_incomplete' });
  });

  // (a) red when the first price is always used, or `date_basis` is a constant; (b) prints the figure
  // and its basis.
  it('the price at the call’s date; date_basis current for one undated price, dated for the base of a model with dated prices', () => {
    const before = priceFromEconomics(
      SONNET,
      'claude-sonnet-4-6',
      '2020-01-01T00:00:00Z',
      usage({ prompt_tokens: 300000 }),
    );
    const after = priceFromEconomics(
      SONNET,
      'claude-sonnet-4-6',
      '2026-10-01T00:00:00Z',
      usage({ prompt_tokens: 300000 }),
    );
    const single = priceFromEconomics(
      SONNET,
      'claude-sonnet-5-5',
      '2020-01-01T00:00:00Z',
      usage({ prompt_tokens: 1000 }),
    );
    expect([
      [total(before), 'priced' in before && before.priced_by.date_basis],
      [total(after), 'priced' in after && after.priced_by.date_basis],
      'priced' in single && single.priced_by.date_basis,
    ]).toEqual([[1.8, 'dated'], [0.9, 'dated'], 'current']);
  });

  // (a) red when the dated-suffix entry is preferred over an exact one; (b) prints the matched id.
  it('an exact entry wins over the dated-suffix match; a dated id matches its undated entry', () => {
    const file: CacheEconomics = {
      version: 1,
      currency: 'USD',
      models: {
        'gpt-4o': { prices: [{ per_million_tokens: { input: 2.5, output: 10 } }] },
        'gpt-4o-2024-05-13': { prices: [{ per_million_tokens: { input: 5, output: 15 } }] },
      },
    };
    const at = '2026-10-01T00:00:00Z';
    const exact = priceFromEconomics(
      file,
      'gpt-4o-2024-05-13',
      at,
      usage({ prompt_tokens: 10000, output_tokens: 1000 }),
    );
    const dated = priceFromEconomics(
      file,
      'gpt-4o-2024-08-06',
      at,
      usage({ prompt_tokens: 10000, output_tokens: 1000 }),
    );
    expect([
      'priced' in exact && [exact.priced_by.matched_model, total(exact)],
      'priced' in dated && [dated.priced_by.matched_model, total(dated)],
      priceFromEconomics(file, 'gpt-5', at, usage({ prompt_tokens: 1 })),
    ]).toEqual([['gpt-4o-2024-05-13', 0.065], ['gpt-4o', 0.035], { not_priced: 'model_unknown' }]);
  });

  // issue #600 caching PR P, the last correction (L2): a date suffix is a day on the calendar, not
  // eight digits. A leap day is accepted, a non-leap 29 February refused: a calendar check, not a
  // digit-range check. (a) red when a tail that is not a day is stripped; (b) prints each answer.
  it('a date suffix is a day on the calendar', () => {
    expect(
      [
        'm-20260101',
        'm-2026-01-01',
        'claude-3-opus-20240229',
        'm-12345678',
        'm-2026-02-30',
        'm-2025-02-29',
        'm-2026-1-1',
        'm',
      ].map(withoutDateSuffix),
    ).toEqual(['m', 'm', 'claude-3-opus', undefined, undefined, undefined, undefined, undefined]);
  });

  // (a) red when a model id ending in eight digits that are not a day is priced as its stem;
  // (b) prints both answers (the matched model, or the reason).
  it('a model id whose tail is not a day is not priced as its stem', () => {
    const file: CacheEconomics = {
      version: 1,
      currency: 'USD',
      models: { m: { prices: [{ per_million_tokens: { input: 1, output: 1 } }] } },
    };
    const at = '2026-10-01T00:00:00Z';
    const notADay = priceFromEconomics(file, 'm-12345678', at, usage({ prompt_tokens: 1 }));
    const aDay = priceFromEconomics(file, 'm-20260101', at, usage({ prompt_tokens: 1 }));
    expect([notADay, 'priced' in aDay ? aDay.priced_by.matched_model : aDay]).toEqual([
      { not_priced: 'model_unknown' },
      'm',
    ]);
  });
});
