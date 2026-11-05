// request-facts.ts — issue #600 PR 2 (A3): the free-text fields a request record carries are bounded
// where the record is written. `model` is the provider's text; `cache_requested` and
// `cache_requested_source` are an adapter's or a provider module's (a module may write any string);
// `cache_requested_by` and `provider` a runner's. Each passes through the one rule a stored name
// obeys (`readStoredName`: trimmed, no control character, at most 200 characters with the house
// marker). Issue #600 (the lifetime unit): `cache_auto`, an object, is normalised to its one shape
// (`normalizeCacheAuto`) or dropped.
//
// Caching 3-B (A6): the split's facts are each normalised to their one shape or dropped — a digest is
// 64 lowercase hex characters, a count a non-negative integer, a word one of its closed set — so a
// provider module's record cannot put its own text under a `fact` row.
import { readStoredName } from './holder.js';
import { normalizeCacheAuto } from '../economics/cache-lifetime.js';
import {
  CACHE_CONTROL_FIELDS,
  CACHE_MARKED_PARTS,
  type CacheControlsRejected,
  type PrefixParts,
} from '../types/run-record.js';

/** The request fields that hold free text, bounded at the write. */
const NAME_FIELDS = [
  'model',
  'cache_requested',
  'cache_requested_source',
  'cache_requested_by',
  'provider',
] as const;

/**
 * Bounds the free text on each request record: for each entry that is a plain object, `model`,
 * `cache_requested`, `cache_requested_source`, `cache_requested_by` and `provider` go through
 * `readStoredName`, and a field it refuses is dropped. A valid word (`lifetime`, `stated`) is
 * unchanged. An entry's own `cache_auto` is replaced by its normalised form (`normalizeCacheAuto`:
 * `{ basis }`, `{ basis, gaps_s }` or (#898) `{ basis, gaps_s, prices }` with `prices` in one of its
 * five shapes, other keys gone) or deleted when that is `undefined`. Caching 3-B: each split fact
 * (`prefix_sha256`, `prefix_chars`, `prefix_parts`, `cache_marked`, `request_strict_sent`,
 * `cache_controls_rejected`, `cache_key_sent`) is kept in its one shape or deleted.
 * Every other field, and every entry that is not an object (a `null`, a number), passes through
 * unchanged. Total: it never throws, because it runs inside `recordDriveFailure`'s fence, where a
 * throw loses the record. It returns new objects; the input is not changed.
 */
export function boundRequestFacts(requests: readonly unknown[]): unknown[] {
  return requests.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const out: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
    for (const field of NAME_FIELDS) {
      if (!Object.hasOwn(out, field)) continue;
      const read = readStoredName(out[field]);
      if (read === undefined) delete out[field];
      else out[field] = read;
    }
    if (Object.hasOwn(out, 'cache_auto')) {
      const auto = normalizeCacheAuto(out['cache_auto']);
      if (auto === undefined) delete out['cache_auto'];
      else out['cache_auto'] = auto;
    }
    for (const [field, normalize] of SPLIT_FACT_NORMALIZERS) {
      if (!Object.hasOwn(out, field)) continue;
      const kept = normalize(out[field]);
      if (kept === undefined) delete out[field];
      else out[field] = kept;
    }
    return out;
  });
}

/** A SHA-256 as Realm writes it: 64 lowercase hex characters, no prefix. */
function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `prefix_parts`: `system` required, the others optional, each a digest; other keys gone. */
function normalizePrefixParts(value: unknown): PrefixParts | undefined {
  if (!plainObject(value) || !isSha256Hex(value['system'])) return undefined;
  const parts: PrefixParts = { system: value['system'] };
  for (const key of ['tools', 'prompt', 'format'] as const) {
    if (value[key] === undefined) continue;
    if (!isSha256Hex(value[key])) return undefined;
    parts[key] = value[key];
  }
  return parts;
}

/** `cache_marked`: a non-empty list of distinct words from `CACHE_MARKED_PARTS`. */
function normalizeCacheMarked(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((w) => (CACHE_MARKED_PARTS as readonly unknown[]).includes(w))) return undefined;
  return new Set(value).size === value.length ? [...(value as string[])] : undefined;
}

/** `cache_controls_rejected`: its one shape — status 400, `['cache_fields']`, a `proven` word, and a
 *  non-empty list of distinct names from `CACHE_CONTROL_FIELDS`. */
function normalizeCacheControlsRejected(value: unknown): CacheControlsRejected | undefined {
  if (!plainObject(value) || value['status'] !== 400) return undefined;
  const dropped = value['dropped'];
  if (!Array.isArray(dropped) || dropped.length !== 1 || dropped[0] !== 'cache_fields') {
    return undefined;
  }
  const proven = value['proven'];
  if (proven !== 'cache_fields' && proven !== 'none') return undefined;
  const fields = value['fields'];
  if (
    !Array.isArray(fields) ||
    fields.length === 0 ||
    !fields.every((f) => (CACHE_CONTROL_FIELDS as readonly unknown[]).includes(f)) ||
    new Set(fields).size !== fields.length
  ) {
    return undefined;
  }
  return {
    status: 400,
    dropped: ['cache_fields'],
    proven,
    fields: [...(fields as CacheControlsRejected['fields'])],
  };
}

/** Caching 3-B (A6): each split fact and the one shape it is kept in (or `undefined`: dropped). */
const SPLIT_FACT_NORMALIZERS: readonly [string, (value: unknown) => unknown][] = [
  ['prefix_sha256', (v) => (isSha256Hex(v) ? v : undefined)],
  [
    'prefix_chars',
    (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined),
  ],
  ['prefix_parts', normalizePrefixParts],
  ['cache_marked', normalizeCacheMarked],
  ['request_strict_sent', (v) => (typeof v === 'boolean' ? v : undefined)],
  ['cache_controls_rejected', normalizeCacheControlsRejected],
  ['cache_key_sent', (v) => (v === true ? true : undefined)],
];
