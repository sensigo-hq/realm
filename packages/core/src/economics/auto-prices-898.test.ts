// auto-prices-898.test.ts — issue #898: `--prompt-cache auto` reads its prices from the runner's price
// file. S1 the one row selector; S2 `chooseAutoLifetime`, one cell per row of its table (rows 2–5
// first, then 6, then 1); S3 the fallback's numbers; S4 an input price of 0; S5 `normalizeCacheAuto`
// keeping `prices`. Beside each: (a) the change that turns it red; (b) what it prints when it fails —
// the gaps, the rates given, the choice, never an environment or a key.
import { describe, expect, it } from 'vitest';
import {
  selectEconomicsRates,
  type CacheEconomics,
  type CacheEconomicsRates,
} from './cache-economics.js';
import {
  chooseAutoLifetime,
  chooseCacheLifetime,
  normalizeCacheAuto,
  type AutoPriceInput,
  type CacheChoice,
} from './cache-lifetime.js';

// ─── S1: the row selector ────────────────────────────────────────────────────────────────────────

const rates = (input: number): CacheEconomicsRates => ({ input, output: input * 5 });
const ECONOMICS: CacheEconomics = {
  version: 1,
  currency: 'USD',
  models: {
    'claude-x': {
      prices: [
        {
          per_million_tokens: rates(1),
          tiers: [{ above_prompt_tokens: 200_000, per_million_tokens: rates(9) }],
        },
        { start_date: '2026-10-01', per_million_tokens: rates(2) },
      ],
    },
  },
};
/** What a selection names, for a failing cell: the matched key and the row's input rate. */
const picked = (model: string, at: string, promptTokens?: number) => {
  const r = selectEconomicsRates(ECONOMICS, model, at, promptTokens);
  return 'not_priced' in r
    ? { model, at, not_priced: r.not_priced }
    : { model, at, matched: r.matched_model, input: r.rates.input, date_basis: r.date_basis };
};

describe('#898 S1 — selectEconomicsRates: the one row selection (model, day, tier)', () => {
  // (a) red when the first price is returned whatever its `start_date` (both boundary rows read the
  //     base), the dated id finds no key, or the tier applies without a prompt size; (b) prints the
  //     model, the time and the row selected (its input rate stands for its `start_date`).
  it('the exact id; a dated id finds its undated key; an id whose tail is not a day is unknown; the start_date boundary at UTC midnight; a tier only with a prompt size; an unreadable time', () => {
    expect([
      picked('claude-x', '2026-09-30T23:59:59Z'),
      picked('claude-x', '2026-10-01T00:00:00Z'),
      picked('claude-x-20261001', '2026-10-02T00:00:00Z'),
      picked('claude-x-20261399', '2026-10-02T00:00:00Z'),
      picked('claude-x', '2026-09-01T00:00:00Z'),
      picked('claude-x', '2026-09-01T00:00:00Z', 300_000),
      picked('claude-x', 'not a date'),
    ]).toEqual([
      {
        model: 'claude-x',
        at: '2026-09-30T23:59:59Z',
        matched: 'claude-x',
        input: 1,
        date_basis: 'dated',
      },
      {
        model: 'claude-x',
        at: '2026-10-01T00:00:00Z',
        matched: 'claude-x',
        input: 2,
        date_basis: 'dated',
      },
      {
        model: 'claude-x-20261001',
        at: '2026-10-02T00:00:00Z',
        matched: 'claude-x',
        input: 2,
        date_basis: 'dated',
      },
      { model: 'claude-x-20261399', at: '2026-10-02T00:00:00Z', not_priced: 'model_unknown' },
      {
        model: 'claude-x',
        at: '2026-09-01T00:00:00Z',
        matched: 'claude-x',
        input: 1,
        date_basis: 'dated',
      },
      {
        model: 'claude-x',
        at: '2026-09-01T00:00:00Z',
        matched: 'claude-x',
        input: 9,
        date_basis: 'dated',
      },
      { model: 'claude-x', at: 'not a date', not_priced: 'date_unreadable' },
    ]);
  });
});

// ─── S2–S4: chooseAutoLifetime ───────────────────────────────────────────────────────────────────

const LIFETIMES = { short_s: 300, long_s: 3600 };
/** A row of the price file: input 3 and the given cache rates (USD per million tokens). */
const row = (cache: Partial<CacheEconomicsRates>, input = 3): AutoPriceInput => ({
  rates: { input, output: 15, ...cache },
});
/** Today's Anthropic ratios on a 3-dollar input: read 0.1×, 5-minute write 1.25×, 1-hour write 2×. */
const FULL = { cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 };
const choose = (gapsS: number[] | undefined, prices: AutoPriceInput) => ({
  gaps: gapsS,
  given: 'rates' in prices ? prices.rates : prices,
  ...chooseAutoLifetime({ gapsS, lifetimes: LIFETIMES, prior: 'long', prices }),
});

/** MA2-898-FALLBACKS' 55 gap patterns: every multiset of 1 to 5 gaps of 10 s, 600 s and 7,200 s. */
const PATTERNS: number[][] = [];
for (let n = 1; n <= 5; n += 1) {
  for (let a = 0; a <= n; a += 1) {
    for (let b = 0; a + b <= n; b += 1) {
      PATTERNS.push([
        ...Array<number>(a).fill(10),
        ...Array<number>(b).fill(600),
        ...Array<number>(n - a - b).fill(7200),
      ]);
    }
  }
}
/** The choice the shipped multiples gave before #898 (read 0.1, writes 1.25 and 2): the baseline. */
const shipped = (gaps: number[]): CacheChoice =>
  chooseCacheLifetime(
    gaps,
    { read: 0.1, short: { lifetime_s: 300, write: 1.25 }, long: { lifetime_s: 3600, write: 2 } },
    'long',
  );

describe('#898 S2 — chooseAutoLifetime, one cell per row of its table (the at-stake rows first)', () => {
  // Row 2. (a) red when a cause is priced instead of falling back, or its word is lost; (b) prints
  //     the gaps, the cause and the choice.
  it('row 2: the file gave no rates — FALLBACK, { from: none, cause }, for each of the four causes', () => {
    const causes = [
      'no_file',
      'economics_unreachable',
      'economics_unreadable',
      'model_unknown',
    ] as const;
    expect(causes.map((cause) => choose([420, 720], { cause }))).toEqual(
      causes.map((cause) => ({
        gaps: [420, 720],
        given: { cause },
        choice: 'long',
        prices: { from: 'none', cause },
      })),
    );
  });

  // Row 3 is S4's (input 0).

  // Row 4, once per member of its condition. (a) red when a missing rate is filled from another
  //     (the read from the input, a write from the other write), or the single `cache_write` is read
  //     as a lifetime's write; (b) prints the gaps, the rates given and the choice.
  it('row 4: no cache_read; no write for either lifetime; a single cache_write only — FALLBACK, rate_missing, the absent rates named in order', () => {
    expect([
      choose([420, 720], row({ cache_write_5m: 3.75, cache_write_1h: 6 })),
      choose([420, 720], row({ cache_read: 0.3 })),
      choose([420, 720], row({ cache_read: 0.3, cache_write: 3.75 })),
      choose([420, 720], row({})),
    ]).toEqual([
      {
        gaps: [420, 720],
        given: { input: 3, output: 15, cache_write_5m: 3.75, cache_write_1h: 6 },
        choice: 'long',
        prices: { from: 'none', cause: 'rate_missing', missing: ['cache_read'] },
      },
      {
        gaps: [420, 720],
        given: { input: 3, output: 15, cache_read: 0.3 },
        choice: 'long',
        prices: {
          from: 'none',
          cause: 'rate_missing',
          missing: ['cache_write_5m', 'cache_write_1h'],
        },
      },
      {
        gaps: [420, 720],
        given: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        choice: 'long',
        prices: {
          from: 'none',
          cause: 'rate_missing',
          missing: ['cache_write_5m', 'cache_write_1h'],
        },
      },
      {
        gaps: [420, 720],
        given: { input: 3, output: 15 },
        choice: 'long',
        prices: {
          from: 'none',
          cause: 'rate_missing',
          missing: ['cache_read', 'cache_write_5m', 'cache_write_1h'],
        },
      },
    ]);
  });

  // Row 5. (a) red when the absent write is filled from the other (the excluded lifetime is then
  //     chosen on some pattern); (b) prints each pattern whose choice is the excluded lifetime, and
  //     the patterns where the shipped `long` did not become `short` or `off`.
  it('row 5: a file with no cache_write_1h never asks 1 hour, and one with no cache_write_5m never asks 5 minutes, over the 55 patterns', () => {
    const no1h = PATTERNS.map((gaps) => ({
      ...choose(gaps, row({ cache_read: 0.3, cache_write_5m: 3.75 })),
      gaps,
    }));
    const no5m = PATTERNS.map((gaps) => ({
      ...choose(gaps, row({ cache_read: 0.3, cache_write_1h: 6 })),
      gaps,
    }));
    expect({
      longWithout1h: no1h.filter((r) => r.choice === 'long').map((r) => r.gaps),
      shortWithout5m: no5m.filter((r) => r.choice === 'short').map((r) => r.gaps),
      shippedLongNowElse: no1h
        .filter((r) => shipped(r.gaps) === 'long' && !['short', 'off'].includes(r.choice))
        .map((r) => r.gaps),
      prices: [no1h[0]!.prices, no5m[0]!.prices],
    }).toEqual({
      longWithout1h: [],
      shortWithout5m: [],
      shippedLongNowElse: [],
      prices: [
        { from: 'economics', excluded: ['long'], missing: ['cache_write_1h'] },
        { from: 'economics', excluded: ['short'], missing: ['cache_write_5m'] },
      ],
    });
  });

  // Row 6, made-up row: the file steers the choice. (a) red when the 1-hour write is not read from
  //     the file (a shipped multiple would keep `long`); (b) prints the gaps, the rates and the choice.
  it('row 6: a 1-hour write at 4× turns the shipped long into short (gaps 10, 600, 7200)', () => {
    const gaps = [10, 600, 7200];
    expect({
      shipped: shipped(gaps),
      at2x: choose(gaps, row(FULL)).choice,
      at4x: choose(gaps, row({ ...FULL, cache_write_1h: 12 })),
    }).toEqual({
      shipped: 'long',
      at2x: 'long',
      at4x: {
        gaps,
        given: { input: 3, output: 15, ...FULL, cache_write_1h: 12 },
        choice: 'short',
        prices: { from: 'economics' },
      },
    });
  });

  // Row 6, real ratios, both directions (under- and over-choosing). (a) red when a multiple is not
  //     the rate ÷ input (any ratio set then moves a pattern); (b) prints each ratio set's patterns
  //     whose choice differs from the shipped one.
  it("row 6: at today's Anthropic ratios the choice equals the shipped one on each of the 55 patterns", () => {
    const sets: Array<[string, Partial<CacheEconomicsRates>, number]> = [
      ['3 / 0.3 / 3.75 / 6', { cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 }, 3],
      ['1 / 0.1 / 1.25 / 2', { cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2 }, 1],
      ['15 / 1.5 / 18.75 / 30', { cache_read: 1.5, cache_write_5m: 18.75, cache_write_1h: 30 }, 15],
      ['0.8 / 0.08 / 1 / 1.6', { cache_read: 0.08, cache_write_5m: 1, cache_write_1h: 1.6 }, 0.8],
      ['5 / 0.5 / 6.25 / 10', { cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 }, 5],
      ['4 / 0.1 (0.025×) / 5 / 8', { cache_read: 0.1, cache_write_5m: 5, cache_write_1h: 8 }, 4],
    ];
    const differ = Object.fromEntries(
      sets.map(([name, cache, input]) => [
        name,
        PATTERNS.filter((gaps) => choose(gaps, row(cache, input)).choice !== shipped(gaps)),
      ]),
    );
    expect({ patterns: PATTERNS.length, differ }).toEqual({
      patterns: 55,
      differ: Object.fromEntries(sets.map(([name]) => [name, []])),
    });
  });

  // Row 1. (a) red when a price is read, or `prices` written, before any gap is kept; (b) prints
  //     the gaps and the outcome.
  it('row 1: no kept gap — the prior, with no prices (none needed), whatever the file says', () => {
    expect([
      chooseAutoLifetime({
        gapsS: undefined,
        lifetimes: LIFETIMES,
        prior: 'short',
        prices: { cause: 'no_file' },
      }),
      chooseAutoLifetime({ gapsS: [], lifetimes: LIFETIMES, prior: 'long', prices: row({}) }),
      chooseAutoLifetime({
        gapsS: [-1, 1.5, 700_000],
        lifetimes: LIFETIMES,
        prior: 'long',
        prices: row(FULL),
      }),
    ]).toEqual([{ choice: 'short' }, { choice: 'long' }, { choice: 'long' }]);
  });
});

describe('#898 S3 — the fallback: 1 hour when a kept gap is under 54 minutes (3,240 s), else no caching', () => {
  // (a) red when `<` becomes `<=` ([3240] then asks 1 hour), or the guard is dropped (the plain
  //     prior then asks 1 hour for [3240] and [7200 ×3]); (b) prints the gaps and the choice.
  it('[3239] → 1 hour; [3240] → off; [7200, 7200, 7200] → off; [420, 720] → 1 hour', () => {
    const fallback = (gaps: number[]) => choose(gaps, { cause: 'no_file' }).choice;
    expect({
      g3239: fallback([3239]),
      g3240: fallback([3240]),
      g7200x3: fallback([7200, 7200, 7200]),
      g420_720: fallback([420, 720]),
    }).toEqual({ g3239: 'long', g3240: 'off', g7200x3: 'off', g420_720: 'long' });
  });
});

describe('#898 S4 — an input price of 0 falls back, named input_zero (today NaN multiples pick long)', () => {
  // (a) red when row 3 is removed (the multiples are then NaN or Infinity and a choice is made from
  //     them); (b) prints the rates, the gaps and the outcome.
  it('gaps [7200] → off; gaps [420] → 1 hour; both { from: none, cause: input_zero }', () => {
    const zero = row(FULL, 0);
    expect([choose([7200], zero), choose([420], zero)]).toEqual([
      {
        gaps: [7200],
        given: { input: 0, output: 15, ...FULL },
        choice: 'off',
        prices: { from: 'none', cause: 'input_zero' },
      },
      {
        gaps: [420],
        given: { input: 0, output: 15, ...FULL },
        choice: 'long',
        prices: { from: 'none', cause: 'input_zero' },
      },
    ]);
  });
});

// ─── S5: normalizeCacheAuto keeps prices ─────────────────────────────────────────────────────────

describe('#898 S5 — normalizeCacheAuto keeps prices in its five shapes, and drops the whole value otherwise', () => {
  const withPrices = (prices: unknown) => ({
    basis: 'listen_trigger_gaps',
    gaps_s: [61, 3599],
    prices,
  });
  /** The key order of a value, nested `prices` included. */
  const keyOrder = (v: unknown): unknown =>
    v === undefined
      ? undefined
      : [Object.keys(v as object), Object.keys((v as { prices?: object }).prices ?? {})];

  // (a) red when a legal shape loses `prices` or its key order; (b) prints each input and output.
  it('each legal shape round-trips, keys in the order basis, gaps_s, prices and from, cause, excluded, missing', () => {
    const legal = [
      { from: 'economics' },
      { from: 'economics', excluded: ['short'], missing: ['cache_write_5m'] },
      { from: 'economics', excluded: ['long'], missing: ['cache_write_1h'] },
      ...(
        [
          'no_file',
          'economics_unreachable',
          'economics_unreadable',
          'model_unknown',
          'input_zero',
        ] as const
      ).map((cause) => ({ from: 'none', cause })),
      { from: 'none', cause: 'rate_missing', missing: ['cache_read'] },
      { from: 'none', cause: 'rate_missing', missing: ['cache_write_5m', 'cache_write_1h'] },
      {
        from: 'none',
        cause: 'rate_missing',
        missing: ['cache_read', 'cache_write_5m', 'cache_write_1h'],
      },
    ];
    // The input's keys reversed: the output's order is the normalizer's own.
    const reversed = (o: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(o).reverse());
    expect(
      legal.map((prices) => {
        const out = normalizeCacheAuto(reversed(withPrices(reversed(prices))));
        return { in: prices, out, keys: keyOrder(out) };
      }),
    ).toEqual(
      legal.map((prices) => ({
        in: prices,
        out: withPrices(prices),
        keys: [['basis', 'gaps_s', 'prices'], Object.keys(prices)],
      })),
    );
  });

  // (a) red when `prices` is returned unchecked (each value below then keeps its prices); (b)
  //     prints each input and output.
  it('each illegal shape drops the whole value; a prices of undefined counts as absent', () => {
    const illegal: Array<[string, unknown]> = [
      ['an unknown cause', withPrices({ from: 'none', cause: 'tired' })],
      [
        'excluded long with missing cache_read',
        withPrices({ from: 'economics', excluded: ['long'], missing: ['cache_read'] }),
      ],
      ['excluded on none', withPrices({ from: 'none', cause: 'no_file', excluded: ['long'] })],
      [
        'missing out of order',
        withPrices({
          from: 'none',
          cause: 'rate_missing',
          missing: ['cache_write_1h', 'cache_read'],
        }),
      ],
      [
        'missing repeated',
        withPrices({ from: 'none', cause: 'rate_missing', missing: ['cache_read', 'cache_read'] }),
      ],
      ['rate_missing with no missing', withPrices({ from: 'none', cause: 'rate_missing' })],
      [
        'missing on another cause',
        withPrices({ from: 'none', cause: 'no_file', missing: ['cache_read'] }),
      ],
      [
        'prices with no gaps',
        { basis: 'listen_trigger_gaps', gaps_s: [], prices: { from: 'economics' } },
      ],
      ['prices on another basis', { basis: 'no_measurement', prices: { from: 'economics' } }],
      ['the view word not_recorded', withPrices({ from: 'not_recorded' })],
      ['a model id key', withPrices({ from: 'economics', model: 'claude-x' })],
      ['prices not an object', withPrices('economics')],
    ];
    expect([
      ...illegal.map(([name, value]) => [name, normalizeCacheAuto(value)]),
      ['prices: undefined', normalizeCacheAuto(withPrices(undefined))],
    ]).toEqual([
      ...illegal.map(([name]) => [name, undefined]),
      ['prices: undefined', { basis: 'listen_trigger_gaps', gaps_s: [61, 3599] }],
    ]);
  });
});
