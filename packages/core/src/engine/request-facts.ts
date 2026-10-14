// request-facts.ts — issue #600 PR 2 (A3): the free-text fields a request record carries are bounded
// where the record is written. `model` is the provider's text; `cache_requested` and
// `cache_requested_source` are an adapter's or a provider module's (a module may write any string);
// `cache_requested_by` and `provider` a runner's. Each passes through the one rule a stored name
// obeys (`readStoredName`: trimmed, no control character, at most 200 characters with the house
// marker).
import { readStoredName } from './holder.js';

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
 * unchanged.
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
    return out;
  });
}
