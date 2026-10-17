// cache-lifetime.test.ts — issue #600 (the lifetime unit), cell 1: which lifetime `auto` asks for
// (`chooseCacheLifetime`) and the shape the record keeps (`normalizeCacheAuto`). The tiers are written
// here — Anthropic's published numbers as of the unit — not imported from the adapter, so a change to
// the adapter's numbers cannot move these cells. On a failing host each cell prints the vectors and
// the choices (numbers only).
import { describe, expect, it } from 'vitest';
import {
  AUTO_GAPS_KEPT,
  CACHE_GAP_MAX_S,
  chooseCacheLifetime,
  normalizeCacheAuto,
  type CacheTiers,
} from './cache-lifetime.js';

const TIERS: CacheTiers = {
  read: 0.1,
  short: { lifetime_s: 300, write: 1.25 },
  long: { lifetime_s: 3600, write: 2 },
};

describe('chooseCacheLifetime (issue #600, the lifetime unit)', () => {
  // (a) red when the rule's arithmetic, its margin, its tie order, its window or its filter changes;
  // (b) prints every vector beside the choice it got.
  it('one choice per vector — the arithmetic of each is in registry AUDL-17/19', () => {
    const vectors: Array<[number[], 'off' | 'short' | 'long', string]> = [
      // off 1; short (0.1×3 + 1.25×2)/5 = 0.56; long 0.1
      [[60, 120, 200, 900, 1500], 'long', 'mixed, all under 54 minutes'],
      [[10, 10, 10, 1800, 1800], 'long', 'short 0.56, long 0.1'],
      [[10, 20, 30], 'long', 'the tie: both 0.1, long first'],
      // short (0.3 + 2.5)/5 = 0.56; long (0.3 + 4)/5 = 0.86
      [[10, 10, 10, 7200, 7200], 'short', 'the two-hour gaps cost long its write'],
      [[7200, 7200, 7200], 'off', 'off 1 < short 1.25 < long 2'],
      [[3600, 3600], 'off', 'an exactly hourly workflow is not read under 1 hour'],
      [[3239], 'long', 'just under 90% of 1 hour'],
      [[3240], 'off', 'at 90% of 1 hour'],
      // without the short margin (gap < 300), short reads 3 gaps: (0.3 + 2.5)/5 = 0.56 < long's
      // (0.3 + 4)/5 = 0.86; with it (gap < 270), short writes all five: 1.25 > long's 0.86
      [[280, 280, 280, 7200, 7200], 'long', 'the short margin'],
      // all ten: short 0.675, long 1.05 → short; the first five: long 0.1; the last five: off
      [[10, 10, 10, 10, 10, 7200, 7200, 7200, 7200, 7200], 'off', 'only the last five are read'],
      [[-5, 7200], 'off', 'a negative gap is dropped (kept, it gives short)'],
      [[1.5, 7200], 'off', 'a fractional gap is dropped (kept, it gives short)'],
      [[604801, 10], 'long', 'a gap over 7 days is dropped'],
    ];
    expect(
      vectors.map(([gaps, , why]) => [why, chooseCacheLifetime(gaps, TIERS, 'short')]),
    ).toEqual(vectors.map(([, choice, why]) => [why, choice]));
  });

  // (a) red when no gaps choose anything but the prior; (b) prints the four choices.
  it('no gaps: the prior, for undefined and [] and both priors', () => {
    expect([
      chooseCacheLifetime(undefined, TIERS, 'short'),
      chooseCacheLifetime([], TIERS, 'short'),
      chooseCacheLifetime(undefined, TIERS, 'long'),
      chooseCacheLifetime([], TIERS, 'long'),
    ]).toEqual(['short', 'short', 'long', 'long']);
  });

  // (a) red when only unreadable gaps reach the cost (instead of the prior); (b) prints the choices.
  it('gaps that are all dropped: the prior', () => {
    expect([
      chooseCacheLifetime([-1, 1.5, CACHE_GAP_MAX_S + 1], TIERS, 'short'),
      chooseCacheLifetime([Number.NaN, Number.POSITIVE_INFINITY], TIERS, 'long'),
    ]).toEqual(['short', 'long']);
  });

  // (a) red when the constants change; (b) prints them.
  it('the constants: five gaps, seven days', () => {
    expect({ kept: AUTO_GAPS_KEPT, max: CACHE_GAP_MAX_S }).toEqual({ kept: 5, max: 604_800 });
  });
});

describe('normalizeCacheAuto (issue #600, the lifetime unit)', () => {
  // (a) red when a valid shape is refused or changed; (b) prints each result.
  it('each valid shape comes back equal, as a new object', () => {
    const shapes = [
      { basis: 'no_measurement' },
      { basis: 'listen_gaps_unreadable' },
      { basis: 'listen_trigger_gaps', gaps_s: [] },
      { basis: 'listen_trigger_gaps', gaps_s: [0, 420, 720, 7200, CACHE_GAP_MAX_S] },
    ];
    const out = shapes.map((s) => normalizeCacheAuto(s));
    expect(out).toEqual(shapes);
    expect(out.map((o, i) => o !== shapes[i])).toEqual([true, true, true, true]);
    expect(out[3]!.gaps_s !== shapes[3]!.gaps_s).toBe(true);
  });

  // (a) red when any of these is kept; (b) prints each result.
  it('dropped: an unknown basis, gaps on a basis without them, missing gaps, six gaps, a non-integer gap, a gap over 7 days, not an object', () => {
    expect(
      [
        { basis: 'guessed' },
        { basis: 'no_measurement', gaps_s: [] },
        { basis: 'listen_gaps_unreadable', gaps_s: [1] },
        { basis: 'listen_trigger_gaps' },
        { basis: 'listen_trigger_gaps', gaps_s: [1, 2, 3, 4, 5, 6] },
        { basis: 'listen_trigger_gaps', gaps_s: [1.5] },
        { basis: 'listen_trigger_gaps', gaps_s: [CACHE_GAP_MAX_S + 1] },
        { basis: 'listen_trigger_gaps', gaps_s: [-1] },
        { basis: 'listen_trigger_gaps', gaps_s: '420' },
        null,
        'no_measurement',
        [{ basis: 'no_measurement' }],
        new (class {
          basis = 'no_measurement';
        })(),
      ].map((v) => normalizeCacheAuto(v)),
    ).toEqual(Array(13).fill(undefined));
  });

  // (a) red when the keys come back in the input's order, or an extra key is kept (`toEqual`
  // ignores key order, so the keys are asserted); (b) prints the keys.
  it("an input with its keys reversed and an extra key → the keys ['basis', 'gaps_s']", () => {
    const out = normalizeCacheAuto({ extra: 1, gaps_s: [420], basis: 'listen_trigger_gaps' });
    expect(Object.keys(out ?? {})).toEqual(['basis', 'gaps_s']);
  });
});
