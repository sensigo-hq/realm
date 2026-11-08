// cache-misses.ts — caching #600, 3-M piece A-2a1: whether each request of one stored list read
// what the request before it left in the provider's cache, worked out when the record is read
// (n8n's way), from what the records hold. Piece A-2a2: for a request that missed, the first
// difference on the record between it and its predecessor; piece A-2a2r: a change of provider,
// address or model, checked first; piece A-2a2s: Realm's own changes; piece A-2a3: a pause longer
// than the entry's lifetime, and the gap and lifetime behind it. Showing it is A-2b.
//
// Pure: no clock, no I/O, no store. Total: it never throws on a stored list, whatever another
// writer or an older version put in it. Not exported from core's index: it has no public shape
// until A-2b.
import { counter } from '../economics/price-source.js';
import type { CacheRequest, PrefixParts } from '../types/run-record.js';
import { parseStamp } from './instants.js';
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

/**
 * Why a request that missed may have missed (piece A-2a2): the first difference on the record
 * between it and its predecessor, checked in this order. Each names a difference the records hold,
 * never a proven cause.
 */
export const CACHE_MISS_CAUSES = [
  /** The provider differs: drive 2 ran with another `--provider` (inside one list the provider is
   *  stamped once per drive, so it cannot differ there). */
  'provider_changed',
  /** The address differs, between the provider's own and another one: drive 2 ran with or without
   *  `--base-url`, `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` (`endpoint` records only that kind,
   *  never the address itself). */
  'endpoint_changed',
  /** The model the response named differs: drive 2 ran with another `--model`, or an address
   *  answered from another model (a gateway's fallback, which can happen inside one list too). */
  'model_changed',
  /** The request or its predecessor has no `prefix_parts` on the record (another writer's request,
   *  or one written before Realm recorded the parts), so no part could be compared. */
  'parts_not_recorded',
  /** Inside one call, the request sent no tools where the request before it did: Realm's own
   *  final request, which OpenAI is sent once a tool step has used up its tool calls. */
  'final_request',
  /** Inside one list, whether strict output was sent differs, in either direction: Realm's own
   *  strict-output ladder moved it (#236, #311, #313, the sticky drop). */
  'strict_ladder',
  /** Against an earlier drive's request, whether strict output was sent differs; the record cannot
   *  tell whether Realm or the operator changed it (`--strict-base-url`, a workflow edit, or the
   *  earlier drive's ladder). */
  'strict_changed',
  /** The tools part differs: inside one list the MCP server listed different tools between
   *  attempts; against an earlier drive's request also a workflow edit (on Anthropic a schema edit
   *  changes the submit tool). */
  'tools',
  /** The instructions part differs: against an earlier drive's request, an edit of the profile or
   *  of the step's instructions, or another Realm version's base text; Realm never changes it
   *  within a drive. */
  'system',
  /** Inside one list, a later call's first request carries Realm's own repair feedback after the
   *  prompt, where that moves what was cached: the prompt or the conversation is marked on both, or
   *  both are `provider_rules` and the earlier request's write is reported (GPT-5.6 and later). */
  'repair_feedback',
  /** The prompt part differs where both requests had it cached, against an earlier drive's request:
   *  from the step's input, the workflow file (every drive re-loads it), or that drive's repair
   *  feedback (the earlier request can be a repair attempt's first request). */
  'prompt',
  /** The answer-format part differs: against an earlier drive's request, JSON mode moved with
   *  `--base-url` while the client's kind stayed the same (a schema edit also changes the
   *  instructions, so it is named `system`). */
  'format',
  /** What carried a cache marker or the key differs (no `cache_marked` is none): against an
   *  earlier drive's request `--prompt-cache off`, a setting stated on a gateway, or a workflow
   *  edit that moves where the prompt's fixed start ends; inside one list only Realm's gateway rule
   *  dropping OpenAI's key. A lifetime-only change is not one: on Anthropic it reads in full. */
  'cache_settings',
  /** The pause between the two requests' starts was longer than the lifetime the entry was granted
   *  or asked for. "Possibly", because the record cannot see a later read of the entry, a
   *  single-shot request is stamped before its retries, and the provider may keep an entry longer:
   *  never a proven expiry. */
  'possibly_expired',
  /** None of the causes above applies. The record cannot see a split request's cached tail under
   *  `provider_rules` (it has no digest), a move between two custom addresses (`endpoint` is only
   *  a kind), the conversation after the prompt (tool results), or the provider evicting the entry
   *  within its lifetime, or after a pause of any length where the predecessor records no lifetime
   *  (`provider_rules`). */
  'unexplained',
] as const;
export type CacheMissCause = (typeof CACHE_MISS_CAUSES)[number];

/** One part's digest on one side, or `undefined` where that side has none. */
function digest(parts: Entry, part: keyof PrefixParts): string | undefined {
  const value = parts[part];
  return typeof value === 'string' ? value : undefined;
}

/** What carried a cache marker or the key on one side; no `cache_marked` is none. */
function marks(side: Entry): ReadonlySet<unknown> {
  const marked = side['cache_marked'];
  return new Set<unknown>(Array.isArray(marked) ? marked : []);
}

function sameSet(a: ReadonlySet<unknown>, b: ReadonlySet<unknown>): boolean {
  return a.size === b.size && [...a].every((member) => b.has(member));
}

/** Behaviour 2: whether the prompt lies inside what this side asked to be cached. */
function promptInside(side: Entry): boolean {
  const marked = marks(side);
  return (
    marked.has('prompt') ||
    marked.has('conversation') ||
    side['cache_requested'] === 'provider_rules'
  );
}

/** A split request's `prompt` digests the head, any other the whole prompt; a blank head is 0. */
function split(side: Entry): boolean {
  return typeof side['prefix_chars'] === 'number';
}

/**
 * Piece A-2a2s: whether repair feedback, appended after the prompt, moves what was cached. It does
 * where both sides mark the prompt or the conversation, or where both are `provider_rules` and the
 * earlier request's write is reported: GPT-5.6 and later cache to the end of the latest message,
 * which the feedback extends, while earlier models place their breakpoints from the start.
 */
function feedbackMoves(now: Entry, before: Entry): boolean {
  const marksPrompt = (side: Entry): boolean => {
    const marked = marks(side);
    return marked.has('prompt') || marked.has('conversation');
  };
  return (
    (marksPrompt(now) && marksPrompt(before)) ||
    (now['cache_requested'] === 'provider_rules' &&
      before['cache_requested'] === 'provider_rules' &&
      reported(cacheWriteField(before)) !== undefined)
  );
}

/** Where the lifetime a gap is judged on came from (piece A-2a3): the predecessor's granted
 *  split, or the lifetime it asked for. */
export const CACHE_LIFETIME_SOURCES = ['written', 'asked'] as const;
export type CacheLifetimeSource = (typeof CACHE_LIFETIME_SOURCES)[number];

/**
 * The gap before a missed request and the lifetime it is judged on (piece A-2a3): `gap_s` is the
 * seconds between the predecessor's start and the request's, not rounded; the lifetime fields are
 * present only when the predecessor records a lifetime.
 */
export type CacheMissGap =
  { gap_s: number } | { gap_s: number; lifetime_s: number; lifetime_from: CacheLifetimeSource };

/**
 * The lifetime the predecessor's entry was granted or asked for: a 5-minute write above 0 first (when
 * a request writes both, the entry ending at its last marker lives 5 minutes), then a 1-hour write
 * above 0, then its `cache_lifetime_s` above 0 (a request that only read, or a write with no
 * split); else none, as for every `provider_rules` request.
 */
function lifetimeOf(
  before: Entry,
): { lifetime_s: number; lifetime_from: CacheLifetimeSource } | undefined {
  const split = before['cache_creation'];
  if (plainObject(split)) {
    const fiveMinutes = reported(split['ephemeral_5m_input_tokens']);
    if (fiveMinutes !== undefined && fiveMinutes > 0) {
      return { lifetime_s: 300, lifetime_from: 'written' };
    }
    const oneHour = reported(split['ephemeral_1h_input_tokens']);
    if (oneHour !== undefined && oneHour > 0) {
      return { lifetime_s: 3600, lifetime_from: 'written' };
    }
  }
  const asked = before['cache_lifetime_s'];
  if (typeof asked === 'number' && Number.isFinite(asked) && asked > 0) {
    return { lifetime_s: asked, lifetime_from: 'asked' };
  }
  return undefined;
}

/**
 * The gap between the predecessor's start and the request's, with the predecessor's lifetime:
 * known only when both stamps parse and the difference is above 0. The one rule behind both
 * `possibly_expired` and `cacheMissGaps`.
 */
function missGap(now: Entry, before: Entry): CacheMissGap | undefined {
  const nowStart = now['request_start'];
  const beforeStart = before['request_start'];
  if (typeof nowStart !== 'string' || typeof beforeStart !== 'string') return undefined;
  const nowMs = parseStamp(nowStart);
  const beforeMs = parseStamp(beforeStart);
  if (nowMs === undefined || beforeMs === undefined) return undefined;
  const gap_s = (nowMs - beforeMs) / 1000;
  if (!(gap_s > 0)) return undefined;
  const lifetime = lifetimeOf(before);
  return lifetime === undefined ? { gap_s } : { gap_s, ...lifetime };
}

/**
 * Behaviour 3 for the missed request at `i`, whose predecessor came `from` the list or its
 * reference. Both sides asked (A-2a1's predecessor rule returns only a request that asked), so
 * tools, system and format lie inside what both asked to be cached; the prompt is checked per side.
 */
function causeAt(
  list: readonly unknown[],
  i: number,
  from: CachePredecessorPlace['from'],
): CacheMissCause {
  // Called only for a request that missed, which is a plain object that asked: that is what makes
  // this read safe, so it comes first (no later check stands in for it).
  const now = list[i] as Entry;
  const nowParts = now['prefix_parts'];
  const before = cachePredecessor(list, i);
  // A missed request always has a predecessor; without one no part could be compared.
  if (before === undefined) return 'parts_not_recorded';
  // Piece A-2a2r: each differs only where both sides record it; checked before anything else.
  const changed = (field: 'provider' | 'endpoint' | 'model'): boolean =>
    typeof now[field] === 'string' &&
    typeof before[field] === 'string' &&
    now[field] !== before[field];
  if (changed('provider')) return 'provider_changed';
  if (changed('endpoint')) return 'endpoint_changed';
  if (changed('model')) return 'model_changed';
  const beforeParts = before['prefix_parts'];
  if (!plainObject(nowParts) || !plainObject(beforeParts)) return 'parts_not_recorded';
  const differs = (part: keyof PrefixParts): boolean =>
    digest(nowParts, part) !== digest(beforeParts, part);
  // Piece A-2a2s: Realm's own changes are named only inside one list, where the record can tell
  // them from the operator's. A later turn is in the same call as its predecessor; a call's first
  // request is not.
  const laterTurn = (placeInCall(now) ?? 0) > 0;
  if (
    from === 'list' &&
    laterTurn &&
    digest(beforeParts, 'tools') !== undefined &&
    digest(nowParts, 'tools') === undefined
  ) {
    return 'final_request';
  }
  const strictNow = now['request_strict_sent'];
  const strictBefore = before['request_strict_sent'];
  const strictDiffers =
    typeof strictNow === 'boolean' &&
    typeof strictBefore === 'boolean' &&
    strictNow !== strictBefore;
  if (from === 'list' && strictDiffers) return 'strict_ladder';
  if (from === 'reference' && strictDiffers) return 'strict_changed';
  if (differs('tools')) return 'tools';
  if (differs('system')) return 'system';
  const promptCompared = promptInside(now) && promptInside(before) && split(now) === split(before);
  // Inside one list a prompt difference is Realm's repair feedback, named where it moves what was
  // cached; any other prompt difference there names nothing.
  if (
    from === 'list' &&
    !laterTurn &&
    promptCompared &&
    differs('prompt') &&
    feedbackMoves(now, before)
  ) {
    return 'repair_feedback';
  }
  if (from === 'reference' && promptCompared && differs('prompt')) return 'prompt';
  if (differs('format')) return 'format';
  if (!sameSet(marks(now), marks(before))) return 'cache_settings';
  const gap = missGap(now, before);
  if (gap !== undefined && 'lifetime_s' in gap && gap.gap_s > gap.lifetime_s) {
    return 'possibly_expired';
  }
  return 'unexplained';
}

/**
 * One entry per entry of `requests`, in the list's order: for a request `cacheReadVerdicts` calls
 * `missed`, its one cause; for every other, `undefined`. `[]` when `requests` is not an array.
 */
export function cacheMissCauses(requests: unknown): (CacheMissCause | undefined)[] {
  if (!Array.isArray(requests)) return [];
  return cacheReadVerdicts(requests).map((verdict, i) =>
    verdict.outcome === 'missed' ? causeAt(requests, i, verdict.predecessor.from) : undefined,
  );
}

/**
 * One entry per entry of `requests`, in the list's order (piece A-2a3): for a request
 * `cacheReadVerdicts` calls `missed` whose gap is known, the gap and the lifetime it was judged on,
 * whatever its cause; for every other, `undefined`. `[]` when `requests` is not an array.
 *
 * The gap's basis is the verdict's predecessor: inside one list it is one drive's clock; against
 * the reference it is two drives' clocks, possibly two hosts'. Across drives the gap is never a
 * safety fact: nothing destructive or order-bearing gates on it.
 */
export function cacheMissGaps(requests: unknown): (CacheMissGap | undefined)[] {
  if (!Array.isArray(requests)) return [];
  return cacheReadVerdicts(requests).map((verdict, i) => {
    if (verdict.outcome !== 'missed') return undefined;
    const before = cachePredecessor(requests, i);
    return before === undefined ? undefined : missGap(requests[i] as Entry, before);
  });
}
