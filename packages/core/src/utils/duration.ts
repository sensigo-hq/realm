import { overdueOf, parseStamp, readInstant, type InstantClass } from '../engine/instants.js';

/**
 * The ONE duration formatter for the lines that say how long ago, or how late, something was
 * (issue #625 PR-2a, F1): under one minute `<n>s` — never `0m`, which reads as "no time at all" —;
 * then `<m>m`, `<h>h <m>m` and `<d>d <h>h`. A negative duration reads as `0s`. The expiry line
 * (`expiryCarriedOutLine`) and `realm run drain` use it, and — through `durationWords` (#729 PR-4) —
 * the Slack reminder's and expiry reminder's spans, and {@link formatInstantWords} (every age and
 * time-to-deadline people read, #715 (b)).
 */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return `${Math.floor(clamped / 1000)}s`;
  const totalMinutes = Math.floor(clamped / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
  return `${totalDays}d ${totalHours % 24}h`;
}

/**
 * #715 (b) (03 §B.1, D-27): a stored instant as UTC text with seconds and no milliseconds,
 * `2026-10-27T14:03:07Z`. The ONE place that text is built (core-internal; the person notice's
 * Slack lines take it too).
 */
export function instantText(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * #715 (b) (03 §B.1, D-27; D6-63, D6-70, D6-72): the ONE formatter of an age or a time-to-deadline that
 * people and scripts read, with its instant beside it, judged at `at` (the reading of the snapshot the
 * line describes — never a clock read here):
 * - a past event: `4h 12m ago (2026-10-27T14:03:07Z)`;
 * - a past event stamped more than ε after `at`: the instant alone, `2026-10-27T14:03:07Z (stamped
 *   7 s after this reply's instant)` — never a negative age, never `0s` (D6-63);
 * - a deadline still ahead: `in 5m (2026-10-27T14:08:07Z)`;
 * - a deadline reached or passed (`at ≥ deadline`, the engine's one due test): `EXPIRED 2m ago
 *   (2026-10-27T13:58:07Z)`;
 * - a stamp that does not parse: `undefined` — the caller prints no age and keeps its other text.
 */
export function formatInstantWords(stamp: string, cls: InstantClass, at: Date): string | undefined {
  const read = readInstant(stamp, cls, at);
  if ('absent' in read) return undefined;
  const instant = instantText(read.ms);
  if (cls === 'past_event') {
    if (read.ahead_ms !== undefined) {
      return `${instant} (stamped ${Math.round(read.ahead_ms / 1000)} s after this reply's instant)`;
    }
    return `${formatDuration(at.getTime() - read.ms)} ago (${instant})`;
  }
  const overdue = overdueOf(stamp, at);
  if (overdue !== undefined && !('absent' in overdue)) {
    return `EXPIRED ${formatDuration(overdue.ms)} ago (${instant})`;
  }
  return `in ${formatDuration(read.ms - at.getTime())} (${instant})`;
}

/**
 * #715 (b) (03 §B.1, D6-72 (c)): the "before this call" lag of an expiry a call carried out, with its
 * deadline: `had expired 5m before this call (deadline 2026-10-27T14:03:07Z)`. `lagMs` is the
 * receipt's (`at − deadline`, never negative there); a deadline that does not parse is `undefined`.
 */
export function formatLagWords(deadline: string, lagMs: number): string | undefined {
  const ms = parseStamp(deadline);
  if (ms === undefined) return undefined;
  return `had expired ${formatDuration(lagMs)} before this call (deadline ${instantText(ms)})`;
}
