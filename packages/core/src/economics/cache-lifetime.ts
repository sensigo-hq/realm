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
// holds no price.
import { CACHE_AUTO_BASES, type CacheAutoBasis } from '../types/run-record.js';

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

/** A provider's cache prices and lifetimes, as multiples of its input price — declared by the adapter, never in core. */
export interface CacheTiers {
  read: number;
  short: CacheTier;
  long: CacheTier;
}

/** What `auto` asks for. */
export type CacheChoice = 'off' | 'short' | 'long';

/** A gap a choice reads: a whole number of seconds from 0 to {@link CACHE_GAP_MAX_S}. */
function readableGap(gap: unknown): gap is number {
  return Number.isInteger(gap) && (gap as number) >= 0 && (gap as number) <= CACHE_GAP_MAX_S;
}

/**
 * The cheapest of off / short / long for the given gaps (the rule above). Gaps that are not whole
 * numbers from 0 to {@link CACHE_GAP_MAX_S} are dropped, then the last {@link AUTO_GAPS_KEPT} are
 * read; with none left, the `prior` is returned.
 */
export function chooseCacheLifetime(
  gapsS: readonly number[] | undefined,
  tiers: CacheTiers,
  prior: 'short' | 'long',
): CacheChoice {
  const kept = (gapsS ?? []).filter(readableGap).slice(-AUTO_GAPS_KEPT);
  if (kept.length === 0) return prior;
  const cost = (tier: CacheTier): number =>
    kept.reduce(
      (sum, gap) => sum + (gap < AUTO_LIFETIME_MARGIN * tier.lifetime_s ? tiers.read : tier.write),
      0,
    ) / kept.length;
  let choice: CacheChoice = 'long';
  let best = cost(tiers.long);
  const short = cost(tiers.short);
  if (short < best) {
    choice = 'short';
    best = short;
  }
  if (1 < best) choice = 'off';
  return choice;
}

/**
 * A stored or passed `cache_auto` as the record keeps it: a NEW object `{ basis }` or
 * `{ basis, gaps_s }` (keys in that order) when the value is a plain object whose `basis` is one of
 * {@link CACHE_AUTO_BASES} and `gaps_s` is present exactly when `basis` is `listen_trigger_gaps` —
 * an array of at most {@link AUTO_GAPS_KEPT} whole numbers from 0 to {@link CACHE_GAP_MAX_S};
 * otherwise `undefined`. Extra keys are dropped. Total: never throws.
 */
export function normalizeCacheAuto(
  value: unknown,
): { basis: CacheAutoBasis; gaps_s?: number[] } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const v = value as Record<string, unknown>;
  const basis = v['basis'];
  if (typeof basis !== 'string' || !(CACHE_AUTO_BASES as readonly string[]).includes(basis)) {
    return undefined;
  }
  const gaps = v['gaps_s'];
  if (basis !== 'listen_trigger_gaps') {
    return gaps === undefined ? { basis: basis as CacheAutoBasis } : undefined;
  }
  if (!Array.isArray(gaps) || gaps.length > AUTO_GAPS_KEPT || !gaps.every(readableGap)) {
    return undefined;
  }
  return { basis: 'listen_trigger_gaps', gaps_s: [...(gaps as number[])] };
}
