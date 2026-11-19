// Gap 1, unit A2a: the one rule a store's `update` applies to the model calls' texts its run's drive
// failures hold (`DriveFailureRecord.model_text`). A failure's text is written once: a write that
// would change it, or lose it while the ring did not move on, is refused. Both of Realm's stores call
// it (SQLite's `update` and the in-memory store's), so the two cannot drift apart.
import type { DriveFailuresField } from '../types/run-record.js';
import { canonicalJson } from './params-hash.js';

/** A stored drive failure whose `model_text` a write would lose or change: its number, and how. */
export interface DriveFailureTextLoss {
  /** The failure's number, counted from 0: `total − length + index` in the stored ring. */
  readonly number: number;
  /** `removed`: the write has no entry with that number, or the entry has no `model_text`. */
  readonly kind: 'removed' | 'changed';
}

/** Whether `entry` holds a `model_text` (a key set to `undefined` is not one: JSON drops it). */
function holdsText(entry: unknown): entry is { model_text: unknown } {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    Object.prototype.hasOwnProperty.call(entry, 'model_text') &&
    (entry as { model_text?: unknown }).model_text !== undefined
  );
}

/** A ring's entries and its `total`; a missing ring is `total` 0, a `total` that is no number its length. */
function ringOf(field: DriveFailuresField | undefined): {
  total: number;
  entries: readonly unknown[];
} {
  const entries = field !== undefined && Array.isArray(field.entries) ? field.entries : [];
  const total =
    field !== undefined && typeof field.total === 'number' && Number.isFinite(field.total)
      ? field.total
      : entries.length;
  return { total, entries };
}

/**
 * The first stored drive failure whose `model_text` the write of `next` would lose or change, or
 * `undefined` when it keeps every one. Each entry is numbered `total − length + index`, so an entry
 * keeps its number as the ring moves on. A stored entry is still covered by the new ring when its
 * number is at least the new ring's `total − length`:
 * - a covered stored entry with a text must be in the new ring at its number, with a deep-equal text
 *   (equal as JSON: key order aside);
 * - a stored text that is not covered is lost, and may be only when the new `total` is greater,
 *   because failures were appended and the oldest fell off the front. With `total` the same or
 *   smaller, a ring cut at either end, or removed, loses it.
 * A ring-size limit is the writer's business: this rule holds for a ring of any length.
 * @internal
 */
export function driveFailureTextLoss(
  stored: DriveFailuresField | undefined,
  next: DriveFailuresField | undefined,
): DriveFailureTextLoss | undefined {
  const before = ringOf(stored);
  const after = ringOf(next);
  const firstCovered = after.total - after.entries.length;
  const appended = after.total > before.total;
  for (let index = 0; index < before.entries.length; index++) {
    const entry = before.entries[index];
    if (!holdsText(entry)) continue;
    const number = before.total - before.entries.length + index;
    if (number < firstCovered) {
      if (appended) continue;
      return { number, kind: 'removed' };
    }
    const kept = after.entries[number - firstCovered];
    if (!holdsText(kept)) return { number, kind: 'removed' };
    if (canonicalJson(kept.model_text) !== canonicalJson(entry.model_text)) {
      return { number, kind: 'changed' };
    }
  }
  return undefined;
}
