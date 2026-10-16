// instants.ts — issue #729 PR-0 (D4 P-8, A-15): the ONE parser of the instants a run record stores,
// and the ONE due test of a stored deadline. Every reading of a stored instant that PR-0 owns goes
// through `readInstant`; every "is this deadline past?" question PR-0 owns goes through
// `isPastDeadline`. Pure: the reading `r` is always passed in (the before-load reading a snapshot was
// taken at), never a clock read here.
//
// The other three copies of the deadline comparison belong to later units and are allow-listed by
// them: `run-health.ts` (#729 PR-4), `reclaim-step.ts` (#729 PR-2), the CLI's `drain.ts` (#729 PR-1).
// The cleanup lease's read (`pendingCleanupWay`) moves with `JUDGE.drain` in PR-1 (D4 T-4).

/**
 * ε, in milliseconds (D4 P-8; #715 D5 §1.4, MONOTONE's cap): how far a recorded past event may lie
 * ahead of the reading before the record is said to be stamped ahead. It decides presence only — the
 * full lead is what {@link readInstant} reports. One core constant; #715 reuses it.
 */
export const CLOCK_SKEW_EPSILON_MS = 5_000;

/**
 * What a stored instant is (D4 P-8): a `past_event` (`created_at`, `updated_at`, `opened_at`, a
 * claim's `since`) was true when it was written, so a value ahead of the reading says one of the two
 * clocks is off; a `deadline` (`expires_at`, a claim's deadline) is future by design, so a value ahead
 * of the reading is simply not due yet.
 */
export const INSTANT_CLASSES = ['past_event', 'deadline'] as const;
export type InstantClass = (typeof INSTANT_CLASSES)[number];

/**
 * A stored instant, read (D4 P-8). `ms` is the stamp's own value (epoch milliseconds) — never
 * replaced, so a caller that sorts by it sorts an ahead stamp where it belongs (#715 D6-58). `ahead_ms`
 * is an EXTRA fact, present only for a `past_event` whose value lies more than
 * {@link CLOCK_SKEW_EPSILON_MS} after the reading: the full lead `stamp − r` (#715 D6-34's `delta_ms`).
 * A stamp `Date.parse` cannot read is `{ absent: 'unparseable_stamp' }` — never `NaN`, never "0 s".
 */
export type InstantReading = { ms: number; ahead_ms?: number } | { absent: 'unparseable_stamp' };

/**
 * Reads one stored instant (D4 P-8). `r` is the RAW reading — the clock reading a snapshot was taken
 * at, before its load (`loadSnapshot`) — and is required: the parser never reads a clock.
 */
export function readInstant(stamp: string, cls: InstantClass, r: Date): InstantReading {
  const ms = Date.parse(stamp);
  if (!Number.isFinite(ms)) return { absent: 'unparseable_stamp' };
  const lead = ms - r.getTime();
  return cls === 'past_event' && lead > CLOCK_SKEW_EPSILON_MS ? { ms, ahead_ms: lead } : { ms };
}

/**
 * The sentence for a past event stamped ahead of the reading (D4 P-8; #715 D6-34): which of the two
 * clocks is off cannot be told, so neither is named. `ahead_ms` as {@link readInstant} reports it.
 */
export function recordStampedAheadSentence(aheadMs: number): string {
  return `one of the two clocks is off by ${Math.round(aheadMs / 1000)} s`;
}

/**
 * Whether a stored deadline has passed at `at` (D4 P-8, A-15): `at ≥ deadline`, the form every due
 * test in the engine used (`!(at < expires_at)`). An unparseable deadline is never past: nothing is
 * carried out on a deadline the record does not state readably (the settlement's own due test refused
 * such a stamp before this function existed; the run's view offered it — that disagreement ends here).
 */
export function isPastDeadline(deadline: string, at: Date): boolean {
  const read = readInstant(deadline, 'deadline', at);
  return !('absent' in read) && at.getTime() >= read.ms;
}

/**
 * How far past its deadline a stored deadline is at `at`, in milliseconds (D4 T-2; AIP-142's offset
 * rule: `overdue = at − deadline`). `undefined` when it is not past — a negative offset is "not yet
 * due" and never reaches an expiry receipt (never "0 s"); `{ absent: 'unparseable_stamp' }` when the
 * stamp cannot be read.
 */
export function overdueOf(
  deadline: string,
  at: Date,
): { ms: number } | { absent: 'unparseable_stamp' } | undefined {
  const read = readInstant(deadline, 'deadline', at);
  if ('absent' in read) return read;
  const overdue = at.getTime() - read.ms;
  return overdue >= 0 ? { ms: overdue } : undefined;
}
