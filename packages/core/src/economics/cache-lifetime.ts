// cache-lifetime.ts — issue #600 (the lifetime unit): which cache lifetime `--prompt-cache auto` asks
// for, chosen from measured gaps and the caller's own prices. Pure: no I/O, no clock.
//
// The rule. For each option — no caching (`off`), the provider's short lifetime, its long lifetime —
// compute the expected cost of one request's cached part, as a multiple of its input price: `off`
// costs 1; a lifetime costs, averaged over the measured gaps, the read price when the gap would be
// read under that lifetime, else that lifetime's write price. Return the cheapest; on a tie, the
// longer lifetime, then the shorter, then `off`. This is the cost-aware fan-out design's test (Q4,
// `plans/cost-aware-fanout/design-d3.md:236`: a start-to-start inter-arrival below the lifetime,
// priced) applied to the gaps between a workflow's recent triggers as `realm listen` sees them. Q4
// PR-2's cadence report and #675 will call this same function; they are not built here.
//
// The two constants:
// - `AUTO_GAPS_KEPT` — only the most recent gaps are read, so a workflow's cadence change shows in a
//   few triggers;
// - `AUTO_LIFETIME_MARGIN` — a gap is read under a lifetime only when it is below 90% of it: the gap
//   is measured trigger to trigger, while a provider counts a lifetime from the previous request's
//   start, which a run's own duration shifts.
//
// The prices and lifetimes are the caller's (an adapter's `CacheTiers`): core names no provider and
// holds no price. Issue #898: `chooseAutoLifetime` takes the multiples from the runner's price file
// (`runner.cache.economics`) and, when that file cannot price the choice, applies the owner's
// fallback, which reads the provider's lifetimes and never a price.
import {
  CACHE_AUTO_BASES,
  CACHE_AUTO_PRICE_CAUSES,
  CACHE_AUTO_RATES,
  type CacheAuto,
  type CacheAutoBasis,
  type CacheAutoPriceCause,
  type CacheAutoPrices,
  type CacheAutoRate,
} from '../types/run-record.js';
import type { CacheEconomicsRates } from './cache-economics.js';

/** The most recent gaps one choice reads. */
export const AUTO_GAPS_KEPT = 5;
/** A gap is read under a lifetime only below this share of it. */
export const AUTO_LIFETIME_MARGIN = 0.9;
/** The longest gap a choice reads, in seconds (7 days); a longer one is dropped. */
export const CACHE_GAP_MAX_S = 604_800;

/** One cache lifetime and its write price, as a multiple of the input price. */
export interface CacheTier {
  lifetime_s: number;
  write: number;
}

/**
 * Cache prices and lifetimes, as multiples of the input price — never declared in core. Issue #898:
 * an absent option is never chosen (the price file could not cost it).
 */
export interface CacheTiers {
  read: number;
  short?: CacheTier;
  long?: CacheTier;
}

/** Issue #898 — a provider's two cache lifetimes, in seconds. */
export interface CacheLifetimes {
  short_s: number;
  long_s: number;
}

/**
 * Issue #898 — what `auto`'s choice is priced from: the base rates of the row the runner's price
 * file holds for the requested model, or the cause the file could not give one.
 */
export type AutoPriceInput =
  | { rates: CacheEconomicsRates }
  | { cause: 'no_file' | 'economics_unreachable' | 'economics_unreadable' | 'model_unknown' };

/** What `auto` asks for. */
export type CacheChoice = 'off' | 'short' | 'long';

/** A gap a choice reads: a whole number of seconds from 0 to {@link CACHE_GAP_MAX_S}. */
function readableGap(gap: unknown): gap is number {
  return Number.isInteger(gap) && (gap as number) >= 0 && (gap as number) <= CACHE_GAP_MAX_S;
}

/**
 * Issue #898 — the gaps one choice reads: the readable ones (whole numbers from 0 to
 * {@link CACHE_GAP_MAX_S}), the last {@link AUTO_GAPS_KEPT} of them. The one home of "which gaps
 * count".
 */
export function keptCacheGaps(gapsS: readonly number[] | undefined): number[] {
  return (gapsS ?? []).filter(readableGap).slice(-AUTO_GAPS_KEPT);
}

/**
 * The cheapest of off / short / long for the given gaps (the rule above). Gaps are kept by
 * {@link keptCacheGaps}; with none left, the `prior` is returned. Issue #898: an option absent from
 * `tiers` is never chosen; the tie order is unchanged (longer, then shorter, then `off`).
 */
export function chooseCacheLifetime(
  gapsS: readonly number[] | undefined,
  tiers: CacheTiers,
  prior: 'short' | 'long',
): CacheChoice {
  const kept = keptCacheGaps(gapsS);
  if (kept.length === 0) return prior;
  const cost = (tier: CacheTier): number =>
    kept.reduce(
      (sum, gap) => sum + (gap < AUTO_LIFETIME_MARGIN * tier.lifetime_s ? tiers.read : tier.write),
      0,
    ) / kept.length;
  let choice: CacheChoice = 'off';
  let best: number | undefined;
  if (tiers.long !== undefined) {
    choice = 'long';
    best = cost(tiers.long);
  }
  if (tiers.short !== undefined) {
    const short = cost(tiers.short);
    if (best === undefined || short < best) {
      choice = 'short';
      best = short;
    }
  }
  if (best === undefined || 1 < best) choice = 'off';
  return choice;
}

/**
 * Issue #898 — `--prompt-cache auto`'s choice, priced from the runner's price file. In order:
 * 1. no kept gap ({@link keptCacheGaps}) — the `prior`, with no `prices` (none was needed);
 * 2. the file gave no rates (`cause`) — FALLBACK, `{ from: 'none', cause }`;
 * 3. `input` is not a finite number above 0 — FALLBACK, `input_zero`;
 * 4. no `cache_read`, or neither write — FALLBACK, `rate_missing` with the absent rates named in
 *    {@link CACHE_AUTO_RATES}' order;
 * 5. exactly one write absent — the rule over `off` and the option the file can cost, that option
 *    named as excluded;
 * 6. every rate present — the rule over all three, `{ from: 'economics' }`.
 * Each multiple is the row's rate ÷ its `input`. A single `cache_write` is never read as either
 * lifetime's write, and no rate is filled from another. FALLBACK is the owner's rule: the prior,
 * unless no kept gap is below {@link AUTO_LIFETIME_MARGIN} × the prior's lifetime — then `off`. It
 * reads the provider's lifetimes, never a price. Pure.
 */
export function chooseAutoLifetime(input: {
  gapsS: readonly number[] | undefined;
  lifetimes: CacheLifetimes;
  prior: 'short' | 'long';
  prices: AutoPriceInput;
}): { choice: CacheChoice; prices?: CacheAutoPrices } {
  const kept = keptCacheGaps(input.gapsS);
  if (kept.length === 0) return { choice: input.prior };
  const fallback = (prices: CacheAutoPrices): { choice: CacheChoice; prices: CacheAutoPrices } => {
    const lifetime = input.prior === 'long' ? input.lifetimes.long_s : input.lifetimes.short_s;
    const fits = kept.some((gap) => gap < AUTO_LIFETIME_MARGIN * lifetime);
    return { choice: fits ? input.prior : 'off', prices };
  };
  if ('cause' in input.prices) return fallback({ from: 'none', cause: input.prices.cause });
  const rates = input.prices.rates;
  const unit = rates.input;
  if (typeof unit !== 'number' || !Number.isFinite(unit) || unit <= 0) {
    return fallback({ from: 'none', cause: 'input_zero' });
  }
  const read = rates.cache_read;
  const w5m = rates.cache_write_5m;
  const w1h = rates.cache_write_1h;
  if (read === undefined || (w5m === undefined && w1h === undefined)) {
    const missing = CACHE_AUTO_RATES.filter((rate) => rates[rate] === undefined);
    return fallback({ from: 'none', cause: 'rate_missing', missing });
  }
  const tiers: CacheTiers = {
    read: read / unit,
    ...(w5m !== undefined
      ? { short: { lifetime_s: input.lifetimes.short_s, write: w5m / unit } }
      : {}),
    ...(w1h !== undefined
      ? { long: { lifetime_s: input.lifetimes.long_s, write: w1h / unit } }
      : {}),
  };
  const choice = chooseCacheLifetime(kept, tiers, input.prior);
  if (w5m === undefined) {
    return {
      choice,
      prices: { from: 'economics', excluded: ['short'], missing: ['cache_write_5m'] },
    };
  }
  if (w1h === undefined) {
    return {
      choice,
      prices: { from: 'economics', excluded: ['long'], missing: ['cache_write_1h'] },
    };
  }
  return { choice, prices: { from: 'economics' } };
}

/** A plain object (`{}` or `Object.create(null)`), never an array or a class instance. */
function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** An array equal, item by item, to `expected`. */
function sameList(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, i) => item === expected[i])
  );
}

/**
 * Issue #898 — a stored or passed `cache_auto.prices` as the record keeps it, a NEW object with its
 * keys in the order `from, cause, excluded, missing`, when it is one of the five shapes:
 * `{ from: 'economics' }`; `{ from: 'economics', excluded: ['short'], missing: ['cache_write_5m'] }`;
 * `{ from: 'economics', excluded: ['long'], missing: ['cache_write_1h'] }`; `{ from: 'none', cause }`
 * with a cause of {@link CACHE_AUTO_PRICE_CAUSES} other than `rate_missing`; `{ from: 'none',
 * cause: 'rate_missing', missing }` with `missing` non-empty, unique and in {@link CACHE_AUTO_RATES}'
 * order. A key whose value is `undefined` counts as absent. Anything else is `undefined`.
 */
function normalizeCacheAutoPrices(value: unknown): CacheAutoPrices | undefined {
  if (!plainObject(value)) return undefined;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined);
  const has = (key: string): boolean => keys.includes(key);
  if (!keys.every((key) => ['from', 'cause', 'excluded', 'missing'].includes(key))) {
    return undefined;
  }
  if (value['from'] === 'economics') {
    if (has('cause')) return undefined;
    if (!has('excluded') && !has('missing')) return { from: 'economics' };
    if (sameList(value['excluded'], ['short']) && sameList(value['missing'], ['cache_write_5m'])) {
      return { from: 'economics', excluded: ['short'], missing: ['cache_write_5m'] };
    }
    if (sameList(value['excluded'], ['long']) && sameList(value['missing'], ['cache_write_1h'])) {
      return { from: 'economics', excluded: ['long'], missing: ['cache_write_1h'] };
    }
    return undefined;
  }
  if (value['from'] !== 'none' || has('excluded')) return undefined;
  const cause = value['cause'];
  if (
    typeof cause !== 'string' ||
    !(CACHE_AUTO_PRICE_CAUSES as readonly string[]).includes(cause)
  ) {
    return undefined;
  }
  if (cause !== 'rate_missing') {
    return has('missing') ? undefined : { from: 'none', cause: cause as CacheAutoPriceCause };
  }
  const missing = value['missing'];
  if (!Array.isArray(missing) || missing.length === 0) return undefined;
  const order = missing.map((rate) => (CACHE_AUTO_RATES as readonly unknown[]).indexOf(rate));
  if (order.some((at, i) => at < 0 || (i > 0 && at <= order[i - 1]!))) return undefined;
  return { from: 'none', cause: 'rate_missing', missing: [...(missing as CacheAutoRate[])] };
}

/**
 * A stored or passed `cache_auto` as the record keeps it: a NEW object `{ basis }`,
 * `{ basis, gaps_s }` or (#898) `{ basis, gaps_s, prices }` (keys in that order) when the value is a
 * plain object whose `basis` is one of {@link CACHE_AUTO_BASES} and `gaps_s` is present exactly
 * when `basis` is `listen_trigger_gaps` — an array of at most {@link AUTO_GAPS_KEPT} whole numbers
 * from 0 to {@link CACHE_GAP_MAX_S}; `prices` only with a non-empty `gaps_s`, and only in one of
 * its five shapes ({@link normalizeCacheAutoPrices}; a `prices` of `undefined` counts as absent);
 * otherwise `undefined`. Other keys are dropped. Total: never throws.
 */
export function normalizeCacheAuto(value: unknown): CacheAuto | undefined {
  if (!plainObject(value)) return undefined;
  const v = value;
  const basis = v['basis'];
  if (typeof basis !== 'string' || !(CACHE_AUTO_BASES as readonly string[]).includes(basis)) {
    return undefined;
  }
  const gaps = v['gaps_s'];
  const prices = v['prices'];
  if (basis !== 'listen_trigger_gaps') {
    return gaps === undefined && prices === undefined
      ? { basis: basis as CacheAutoBasis }
      : undefined;
  }
  if (!Array.isArray(gaps) || gaps.length > AUTO_GAPS_KEPT || !gaps.every(readableGap)) {
    return undefined;
  }
  const kept: CacheAuto = { basis: 'listen_trigger_gaps', gaps_s: [...(gaps as number[])] };
  if (prices === undefined) return kept;
  if (gaps.length === 0) return undefined;
  const normalized = normalizeCacheAutoPrices(prices);
  return normalized === undefined ? undefined : { ...kept, prices: normalized };
}
