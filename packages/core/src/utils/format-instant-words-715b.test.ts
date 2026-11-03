// format-instant-words-715b.test.ts — issue #715 (b) 03 §B.1 (D-27; D6-63, D6-70, D6-72): the ONE
// formatter of an age or a time-to-deadline, with its instant beside it, judged at the caller's `at`.
// UTC fixtures (no daylight-saving edge). The stamped-ahead row first: it is the field's worst
// repeated bug (a negative age, or "0s ago").
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { formatDuration, formatInstantWords, formatLagWords } from './duration.js';

const AT = new Date('2026-10-27T14:03:07.000Z');
const plus = (ms: number) => new Date(AT.getTime() + ms).toISOString();

describe('#715 (b) 03 §B.1 — formatInstantWords', () => {
  it('a past event stamped more than ε after the reading: the instant alone, then how far after — never a negative age, never 0s', () => {
    // (a) red when an ahead stamp reaches formatDuration (it clamps to "0s ago") or prints a negative
    //     age; (b) prints the text.
    expect(formatInstantWords(plus(7_000), 'past_event', AT)).toBe(
      "2026-10-27T14:03:14Z (stamped 7 s after this reply's instant)",
    );
  });

  it('a past event: words, then the instant to the second, UTC', () => {
    // (a) red when the instant is missing, carries milliseconds or a local zone, or the words are not
    //     formatDuration's; (b) prints the text.
    expect(formatInstantWords('2026-10-27T09:51:07.123Z', 'past_event', AT)).toBe(
      '4h 11m ago (2026-10-27T09:51:07Z)',
    );
  });

  it('a deadline still ahead: in <duration> (instant)', () => {
    // (a) red when a future deadline is said as past, or its instant is missing; (b) prints the text.
    expect(formatInstantWords(plus(300_000), 'deadline', AT)).toBe('in 5m (2026-10-27T14:08:07Z)');
  });

  it('a deadline already past: EXPIRED <duration> ago (instant); exactly at the reading it has passed (the engine’s one due test)', () => {
    // (a) red when a past deadline reads "in …", or the boundary disagrees with isPastDeadline
    //     (at ≥ deadline); (b) prints both texts.
    expect({
      past: formatInstantWords(plus(-120_000), 'deadline', AT),
      exactly: formatInstantWords(plus(0), 'deadline', AT),
    }).toEqual({
      past: 'EXPIRED 2m ago (2026-10-27T14:01:07Z)',
      exactly: 'EXPIRED 0s ago (2026-10-27T14:03:07Z)',
    });
  });

  it('a stamp that does not parse: undefined — before formatDuration is ever given a non-finite number', () => {
    // (a) red when an unparseable stamp yields "NaNd NaNh" or any text; (b) prints what it returned.
    expect({
      past: formatInstantWords('not a time', 'past_event', AT),
      deadline: formatInstantWords('', 'deadline', AT),
    }).toEqual({ past: undefined, deadline: undefined });
  });

  it('the lag line: had expired <duration> before this call (deadline <instant>)', () => {
    // (a) red when the deadline's instant is missing or not to the second; (b) prints the text.
    expect({
      lag: formatLagWords('2026-10-27T13:58:07.456Z', 300_000),
      unparseable: formatLagWords('nope', 300_000),
    }).toEqual({
      lag: 'had expired 5m before this call (deadline 2026-10-27T13:58:07Z)',
      unparseable: undefined,
    });
  });
});

describe('#715 (b) 03 §B.1 — formatDuration as it behaves (its boundaries; unchanged by this unit)', () => {
  it('59 s, 60 s, 270 s, 3,599 s, 3,600 s, 24 h, −5 s', () => {
    // (a) red when this unit changes formatDuration's own forms; (b) prints each text.
    expect([59, 60, 270, 3_599, 3_600, 86_400, -5].map((s) => formatDuration(s * 1000))).toEqual([
      '59s',
      '1m',
      '4m',
      '59m',
      '1h 0m',
      '1d 0h',
      '0s',
    ]);
  });
});
