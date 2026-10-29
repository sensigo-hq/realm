// take-reading.ts — issue #715 (a) (D5 §2.1, D6-3, D6-4, D6-14, D6-35, D6-60, D6-68): the ONE place a
// run store takes its reading of the time for a write, and the per-key floor it applies to that
// reading. Every store write calls `takeReading` exactly once, after it holds its lock; a keyed
// create then floors the reading by the run it supersedes with `floorAtHolder`, which reads no clock
// (the create learns its holder only after reading the key's pointer under the lock).
import { CLOCK_SKEW_EPSILON_MS } from '../engine/instants.js';
import type { Clock } from '../utils/clock.js';

/**
 * Takes a write's reading (D5 §2.1, D6-3, D6-4): `r = clock.now()` — exactly ONE call, no other time
 * source. When `record` is given and its `updated_at` parses (`u`), the reading is
 * `max(r, min(u, r + ε))` — MONOTONE, capped: a record stamped far ahead lifts the write by at most
 * ε ({@link CLOCK_SKEW_EPSILON_MS}), so no deadline is minted more than ε late. An `updated_at` that
 * does not parse is ignored (D6-68), never `NaN`. Returns a fresh `Date`.
 *
 * A throw from `clock.now()` propagates unchanged, having spent the one reading (D6-4). A
 * `clock.now()` that returns an invalid `Date` fails here, loud, instead of as a `RangeError` from
 * `toISOString()` later.
 *
 * D6-4's third parameter — a settlement delta's event instants, folded into the reading — is not
 * here yet: it is additive and arrives with `settleStep` in #715 (b).
 */
export function takeReading(clock: Clock, record?: { updated_at: string }): Date {
  const r = clock.now();
  const rMs = r instanceof Date ? r.getTime() : Number.NaN;
  if (!Number.isFinite(rMs)) throw new Error('clock.now() returned an invalid Date');
  if (record !== undefined) {
    const u = Date.parse(record.updated_at);
    if (Number.isFinite(u))
      return new Date(Math.max(rMs, Math.min(u, rMs + CLOCK_SKEW_EPSILON_MS)));
  }
  return new Date(rMs);
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
    const h = Date.parse(holderCreatedAt);
    if (Number.isFinite(h)) {
      return new Date(Math.max(rMs, Math.min(h + 1, rMs + CLOCK_SKEW_EPSILON_MS)));
    }
  }
  return new Date(rMs);
}
