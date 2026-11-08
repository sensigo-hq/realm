// cache-misses.ts — caching #600, 3-M piece A-2a1: whether each request of one stored list read
// what the request before it left in the provider's cache, worked out when the record is read
// (n8n's way), from what the records hold. Why a request missed is piece A-2a2; showing it is A-2b.
//
// Pure: no clock, no I/O, no store. Total: it never throws on a stored list, whatever another
// writer or an older version put in it. Not exported from core's index: it has no public shape
// until A-2b.
import { counter } from '../economics/price-source.js';
import type { CacheRequest } from '../types/run-record.js';
import { cacheWriteField } from './step-view.js';

/** What `cacheReadVerdicts` says of one request. */
export const CACHE_READ_OUTCOMES = [
  /** The request asked for no caching, so it is never judged and is never anyone's predecessor. */
  'not_asked',
  /** The request asked for caching but cannot be judged; its `cause` says why. */
  'not_compared',
  /** The request read what its predecessor left, under its rule. */
  'held',
  /** The request read less than its predecessor left, under its rule. */
  'missed',
] as const;
export type CacheReadOutcome = (typeof CACHE_READ_OUTCOMES)[number];

/** Why a request that asked for caching was not compared, in the order they are checked. */
export const CACHE_NOT_COMPARED_CAUSES = [
  /** The record does not say where the request's provider call began (written before Realm
   *  recorded `request_in_call`). */
  'not_recorded',
  /** The record holds no earlier request that asked for caching to compare this one with. */
  'no_earlier_request',
  /** A count the comparison needs was not reported: the request's read, its predecessor's read,
   *  or on Anthropic its predecessor's write. */
  'counts_not_reported',
  /** The predecessor left nothing to read: it read nothing, and wrote nothing or reported no
   *  write. */
  'nothing_expected',
] as const;
export type CacheNotComparedCause = (typeof CACHE_NOT_COMPARED_CAUSES)[number];

/** The rule a request is judged by, chosen by its own `provider`. */
export const CACHE_MISS_RULES = [
  /** Anthropic: the request must read exactly what its predecessor read and wrote. */
  'exact',
  /** Every other provider, Claude Code's tolerance: a miss reads under 95% of the expected count
   *  and at least 2,000 tokens less. */
  'tolerance',
] as const;
export type CacheMissRule = (typeof CACHE_MISS_RULES)[number];

/**
 * Where a request's predecessor is: an earlier entry of the same list (`at`, its position), or the
 * `reference` the request carries. The reference's own `from` says where it was found; this answer
 * does not repeat it.
 */
export type CachePredecessorPlace = { from: 'list'; at: number } | { from: 'reference' };

/** The answer for one request (Behaviour 6). */
export type CacheReadVerdict =
  | { outcome: Extract<CacheReadOutcome, 'not_asked'> }
  | { outcome: Extract<CacheReadOutcome, 'not_compared'>; cause: CacheNotComparedCause }
  | { outcome: Extract<CacheReadOutcome, 'held'>; predecessor: CachePredecessorPlace }
  | {
      outcome: Extract<CacheReadOutcome, 'missed'>;
      predecessor: CachePredecessorPlace;
      expected_tokens: number;
      shortfall_tokens: number;
      rule: CacheMissRule;
    };

/** A stored request, or the reference it carries, read field by field. */
type Entry = Readonly<Record<string, unknown>>;

/** The `CACHE_REQUESTS` words that ask for caching (Behaviour 2); `off` asks nothing. */
const ASKING = ['lifetime', 'provider_rules'] as const satisfies readonly CacheRequest[];

/** Claude Code's tolerance (Behaviour 5): a miss reads under 95% of the expected count… */
const TOLERANCE_PERCENT = 95;
/** …and at least this many tokens less. */
const TOLERANCE_MIN_SHORTFALL = 2000;

function plainObject(value: unknown): value is Entry {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Behaviour 2: a plain object whose `cache_requested` asks (`lifetime` or `provider_rules`) and
 * whose `provider` is a string that is not a module's (`module:`). The same rule serves a
 * `reference`, on its own copied `cache_requested` and `provider`.
 */
function asked(value: unknown): value is Entry {
  if (!plainObject(value)) return false;
  const requested = value['cache_requested'];
  const provider = value['provider'];
  return (
    (ASKING as readonly unknown[]).includes(requested) &&
    typeof provider === 'string' &&
    !provider.startsWith('module:')
  );
}

/** A request's `request_in_call` when it counts (a non-negative safe integer); else `undefined`. */
function placeInCall(value: unknown): number | undefined {
  const place = plainObject(value) ? value['request_in_call'] : undefined;
  return typeof place === 'number' && Number.isSafeInteger(place) && place >= 0 ? place : undefined;
}

/** Behaviour 1: a count `counter` takes as a number; absent, `null` and an invalid value are not
 *  reported. */
function reported(value: unknown): number | undefined {
  const count = counter(value);
  return typeof count === 'number' ? count : undefined;
}

/**
 * Behaviour 3: the predecessor of the entry at `i` and where it is, or `undefined` when the entry
 * did not ask, has no `request_in_call` that counts, or has no predecessor. A later request of a
 * call is judged against the nearest earlier request of the same call that asked; a call's first
 * request against the nearest earlier call's first request that asked (a repair attempt is a new
 * call), else against the `reference` it carries.
 */
function locatePredecessor(
  list: readonly unknown[],
  i: number,
): { place: CachePredecessorPlace; record: Entry } | undefined {
  const entry = list[i];
  if (!asked(entry)) return undefined;
  const place = placeInCall(entry);
  if (place === undefined) return undefined;
  if (place > 0) {
    for (let j = i - 1; j >= 0; j -= 1) {
      const earlier = list[j];
      if (asked(earlier)) return { place: { from: 'list', at: j }, record: earlier };
      if (placeInCall(earlier) === 0) return undefined;
    }
    return undefined;
  }
  for (let j = i - 1; j >= 0; j -= 1) {
    const earlier = list[j];
    if (placeInCall(earlier) === 0 && asked(earlier)) {
      return { place: { from: 'list', at: j }, record: earlier };
    }
  }
  const reference = entry['reference'];
  return asked(reference) ? { place: { from: 'reference' }, record: reference } : undefined;
}

/**
 * The predecessor of the request at position `i` of `requests`: the earlier entry of the same
 * list, or the `reference` it carries, as stored (Behaviour 3). `undefined` for a request that
 * asked for no caching, a request with no predecessor, and an `i` that is not a position in the
 * list.
 */
export function cachePredecessor(requests: unknown, i: number): Entry | undefined {
  if (!Array.isArray(requests) || !Number.isInteger(i) || i < 0 || i >= requests.length) {
    return undefined;
  }
  return locatePredecessor(requests, i)?.record;
}

/** Behaviours 4 and 5 for the entry at `i`. */
function verdictAt(list: readonly unknown[], i: number): CacheReadVerdict {
  const entry = list[i];
  if (!asked(entry)) return { outcome: 'not_asked' };
  if (placeInCall(entry) === undefined) return { outcome: 'not_compared', cause: 'not_recorded' };
  const predecessor = locatePredecessor(list, i);
  if (predecessor === undefined) return { outcome: 'not_compared', cause: 'no_earlier_request' };
  const exact = entry['provider'] === 'anthropic';
  const read = reported(entry['cache_read_input_tokens']);
  const before = reported(predecessor.record['cache_read_input_tokens']);
  const wrote = reported(cacheWriteField(predecessor.record));
  if (read === undefined || before === undefined || (exact && wrote === undefined)) {
    return { outcome: 'not_compared', cause: 'counts_not_reported' };
  }
  // A write not reported is unknown, never 0: under the tolerance rule the read alone is expected.
  const expected = before + (wrote ?? 0);
  if (expected === 0) return { outcome: 'not_compared', cause: 'nothing_expected' };
  const shortfall = expected - read;
  const missed = exact
    ? read < expected
    : 100 * read < TOLERANCE_PERCENT * expected && shortfall >= TOLERANCE_MIN_SHORTFALL;
  if (!missed) return { outcome: 'held', predecessor: predecessor.place };
  return {
    outcome: 'missed',
    predecessor: predecessor.place,
    expected_tokens: expected,
    shortfall_tokens: shortfall,
    rule: exact ? 'exact' : 'tolerance',
  };
}

/**
 * One answer per entry of `requests` (a step's `diagnostics.cache.requests`, or a drive failure's
 * `usage`), in the list's order; `[]` when `requests` is not an array. Each says whether the
 * request asked for caching, and if it did, whether it read what its predecessor left (`held`),
 * read less (`missed`: by how many tokens, against which predecessor, under which rule), or could
 * not be compared and why. Each predecessor is the one `cachePredecessor` returns.
 */
export function cacheReadVerdicts(requests: unknown): CacheReadVerdict[] {
  if (!Array.isArray(requests)) return [];
  return requests.map((_, i) => verdictAt(requests, i));
}
