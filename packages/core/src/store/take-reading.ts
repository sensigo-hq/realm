// take-reading.ts — issue #715 (a) (D5 §2.1, D6-3, D6-4, D6-14, D6-35, D6-60, D6-68) and (b) (D-17,
// D6-16): the ONE place a run store takes its reading of the time, and the floors it applies to it.
// Every store write calls `takeReading` exactly once, after it holds its lock; a keyed create then
// floors the reading by the run it supersedes with `floorAtHolder`, which reads no clock (the create
// learns its holder only after reading the key's pointer under the lock). Every store read takes
// `takeRawReading` once, BEFORE it loads, and floors each record it loaded with `floorAtRecord`.
import { CLOCK_SKEW_EPSILON_MS, parseStamp } from '../engine/instants.js';
import { eventInstantsOf } from '../engine/settlement-instants.js';
import type { SettlementDelta } from '../types/settlement.js';
import type { Clock } from '../utils/clock.js';

/**
 * Takes the RAW reading of `clock` (#715 (b), D-17): exactly ONE `clock.now()` call, validated, as a
 * fresh `Date`. A throw from `clock.now()` propagates unchanged, having spent the one reading (D6-4).
 * A `clock.now()` that returns an invalid `Date` fails here, loud, instead of as a `RangeError` from
 * `toISOString()` later. A READ takes it BEFORE it loads (D6-16): every statement about what it then
 * loads holds at the reading; a listing's `read_at` is this raw value.
 */
export function takeRawReading(clock: Clock): Date {
  const r = clock.now();
  const rMs = r instanceof Date ? r.getTime() : Number.NaN;
  if (!Number.isFinite(rMs)) throw new Error('clock.now() returned an invalid Date');
  return new Date(rMs);
}

/**
 * Floors a reading by a record's own stamp (#715 (b), D-17; D5 §2.1, D6-3): when the record's
 * `updated_at` parses (`u`), returns `max(r, min(u, r + ε))` — MONOTONE, capped: a record stamped far
 * ahead lifts the reading by at most ε ({@link CLOCK_SKEW_EPSILON_MS}), so no deadline is minted more
 * than ε late. An `updated_at` that does not parse is ignored (D6-68), never `NaN`. PURE: reads no
 * clock. Returns a fresh `Date`.
 */
export function floorAtRecord(r: Date, record: { updated_at: string }): Date {
  const rMs = r.getTime();
  const u = parseStamp(record.updated_at);
  if (u !== undefined) return new Date(Math.max(rMs, Math.min(u, rMs + CLOCK_SKEW_EPSILON_MS)));
  return new Date(rMs);
}

/**
 * Takes a write's reading (D5 §2.1, D6-3, D6-4): {@link takeRawReading} — exactly ONE `clock.now()`
 * call, no other time source — floored by `record` when it is given ({@link floorAtRecord}). When
 * `delta` is given (a `settleStep`), the delta's EVENT instants — the `started_at` / `completed_at`
 * of the evidence it carries ({@link eventInstantsOf}) — are folded in: `at = max(floored reading,
 * ...events)`. Event instants are this process's own readings, taken when the work ended, so they
 * are NOT capped by ε; an identity entry's `captured_at` is outside class and never folded (D6-67).
 * Returns a fresh `Date`.
 */
export function takeReading(
  clock: Clock,
  record?: { updated_at: string },
  delta?: SettlementDelta,
): Date {
  const r = takeRawReading(clock);
  let atMs = (record !== undefined ? floorAtRecord(r, record) : r).getTime();
  if (delta !== undefined) {
    for (const event of eventInstantsOf(delta)) atMs = Math.max(atMs, event.getTime());
  }
  return new Date(atMs);
}

/**
 * The per-key floor (D6-14, D6-35, D6-60, D6-68). PURE: the reading was already taken, once, by
 * {@link takeReading}. When `holderCreatedAt` (the `created_at` of the run a keyed create supersedes,
 * or the newest among the key's runs) parses to `h`, returns `max(reading, min(h + 1 ms, reading + ε))`;
 * otherwise the reading. So a successor under a key is stamped strictly after the run it supersedes
 * whenever the clock stepped back by LESS than ε. At a backward step of exactly ε the result EQUALS
 * the holder's `created_at` (not `h + 1 ms`) and the canonical order is decided by the id — a known
 * boundary of D6-60's "up to ε". Beyond ε the cap wins and the successor may sort before its holder
 * (a named residual, D6-29(b)). A `created_at` that does not parse floors nothing (D6-68).
 */
export function floorAtHolder(reading: Date, holderCreatedAt?: string): Date {
  const rMs = reading.getTime();
  if (holderCreatedAt !== undefined) {
    const h = parseStamp(holderCreatedAt);
    if (h !== undefined) {
      return new Date(Math.max(rMs, Math.min(h + 1, rMs + CLOCK_SKEW_EPSILON_MS)));
    }
  }
  return new Date(rMs);
}
