// take-reading.test.ts — issue #715 (a) Part A.2 (D5 §2.1, D6-3, D6-4, D6-14, D6-35, D6-60, D6-68):
// `takeReading` (one reading, MONOTONE capped) and `floorAtHolder` (the per-key floor, pure). Each cell
// names (a) the change that turns it red and (b) what it prints when it fails: inputs and ISO results.
import { describe, expect, it } from 'vitest';
import { CLOCK_SKEW_EPSILON_MS as EPS } from '../engine/instants.js';
import type { Clock } from '../utils/clock.js';
import { floorAtHolder, takeReading } from './take-reading.js';

const R = Date.parse('2030-06-01T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function counting(now: () => Date): Clock & { calls: number } {
  const clock = {
    calls: 0,
    now(): Date {
      clock.calls += 1;
      return now();
    },
    at(): () => void {
      throw new Error('not used');
    },
  };
  return clock;
}

describe('#715 (a) A.2 — takeReading', () => {
  it('A7 MONOTONE capped: no record, behind, lifted, at ε, far ahead (capped), unparseable (ignored)', () => {
    // (a) red when the min(…, r+ε) cap is dropped (the 1 h row), the max is dropped (the lift row), or
    // NaN leaks (the garbage row); (b) prints each case's input and the ISO result.
    const cases: Array<[string, string | undefined, number]> = [
      ['no record', undefined, R],
      ['updated_at behind', iso(R - 60_000), R],
      ['updated_at = r', iso(R), R],
      ['updated_at = r+3 s', iso(R + 3_000), R + 3_000],
      ['updated_at = r+ε', iso(R + EPS), R + EPS],
      ['updated_at = r+1 h', iso(R + 3_600_000), R + EPS],
      ['updated_at unparseable', 'garbage', R],
    ];
    for (const [label, updatedAt, expected] of cases) {
      const clock = counting(() => new Date(R));
      const at = takeReading(
        clock,
        updatedAt === undefined ? undefined : { updated_at: updatedAt },
      );
      expect(Number.isFinite(at.getTime()), `${label}: finite`).toBe(true);
      expect(at.toISOString(), `${label}: updated_at=${String(updatedAt)}`).toBe(iso(expected));
    }
  });

  it('A8 the clock is read exactly once per call, with and without a record', () => {
    // (a) red when a second now() is added; (b) prints the call count.
    const plain = counting(() => new Date(R));
    takeReading(plain);
    expect(plain.calls, 'without a record').toBe(1);
    const withRecord = counting(() => new Date(R));
    takeReading(withRecord, { updated_at: iso(R + 1_000) });
    expect(withRecord.calls, 'with a record').toBe(1);
  });

  it('A9 a throw from clock.now() propagates unchanged, having spent one reading', () => {
    // (a) red when the error is wrapped or swallowed; (b) prints the message.
    const boom = new Error('the clock refused');
    const clock = counting(() => {
      throw boom;
    });
    let caught: unknown;
    try {
      takeReading(clock, { updated_at: iso(R) });
    } catch (err) {
      caught = err;
    }
    expect(caught, `caught: ${String((caught as Error | undefined)?.message)}`).toBe(boom);
    expect(clock.calls, 'one reading spent').toBe(1);
  });

  it('A9b a clock returning an invalid Date fails loud with a message naming clock.now()', () => {
    // (a) red when NaN leaks to toISOString(); (b) prints the message.
    const clock = counting(() => new Date(Number.NaN));
    let message = '';
    try {
      takeReading(clock);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message, `the message: ${message}`).toMatch(/clock\.now\(\)/);
    expect(clock.calls, 'one reading spent').toBe(1);
  });
});

describe('#715 (a) A.2 — floorAtHolder', () => {
  it('A10 the floor: none, behind, equal, ahead, a 4 s backward step, the ε boundary, capped, unparseable', () => {
    // (a) red when the +1 ms, the cap, or the unparseable guard is dropped; (b) prints inputs and result.
    // No clock is read: floorAtHolder takes no clock at all (a throwing clock is not even passed).
    const r = new Date(R);
    const cases: Array<[string, string | undefined, number]> = [
      ['no holder', undefined, R],
      ['holder = r−5 s', iso(R - 5_000), R],
      ['holder = r', iso(R), R + 1],
      ['holder = r+3 s', iso(R + 3_000), R + 3_001],
      ['holder = r+4 s (a 4 s backward step)', iso(R + 4_000), R + 4_001],
      ['holder = r+ε (the boundary: equal to the holder)', iso(R + EPS), R + EPS],
      ['holder = r+1 h (capped)', iso(R + 3_600_000), R + EPS],
      ['holder unparseable', 'garbage', R],
    ];
    for (const [label, holder, expected] of cases) {
      const at = floorAtHolder(r, holder);
      expect(at.toISOString(), `${label}: holder=${String(holder)} r=${iso(R)}`).toBe(
        iso(expected),
      );
    }
    expect(r.toISOString(), 'the reading is not mutated').toBe(iso(R));
  });
});
