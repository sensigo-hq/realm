// #715 (b) (03 §B.3, D6-72 (c)) — test support: a stored instant as the one formatter prints it beside
// its words (UTC, to the second, `Z`), so a cell can state the deadline its line names. A string goes
// through core's one stamp parser (`parseStamp`), as every stored stamp does.
import { parseStamp } from '../engine/instants.js';

/** `2026-10-27T14:03:07Z` for an instant (a Date, epoch ms, or an ISO string). */
export function zOf(at: Date | number | string): string {
  const ms =
    typeof at === 'string'
      ? (parseStamp(at) ?? Number.NaN)
      : typeof at === 'number'
        ? at
        : at.getTime();
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** {@link zOf} of the instant `ms` milliseconds before `at` (a deadline a lag before a reading). */
export function zBefore(at: Date, ms: number): string {
  return zOf(at.getTime() - ms);
}
