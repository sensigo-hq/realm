// take-reading.test.ts — issue #715 (a) Part A.2 (D5 §2.1, D6-3, D6-4, D6-14, D6-35, D6-60, D6-68):
// `takeReading` (one reading, MONOTONE capped) and `floorAtHolder` (the per-key floor, pure). Each cell
// names (a) the change that turns it red and (b) what it prints when it fails: inputs and ISO results.
import { describe, expect, it } from 'vitest';
import { CLOCK_SKEW_EPSILON_MS as EPS } from '../engine/instants.js';
import type { Clock } from '../utils/clock.js';
import { floorAtHolder, floorAtRecord, takeRawReading, takeReading } from './take-reading.js';
import { eventInstantsOf } from '../engine/settlement-instants.js';
import type { EvidenceSnapshot } from '../types/run-record.js';
import type { SettlementDelta } from '../types/settlement.js';
import type { ExtensionIdentityEntry } from '../types/extension-identity.js';

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

// ---------------------------------------------------------------------------------------------
// #715 (b) A.1 (D-17) — the reads' helpers: `takeRawReading` (one clock.now(), no floor) and the pure
// `floorAtRecord` (a read's `at`: the raw reading floored by the record's own `updated_at`, ε-capped).
// ---------------------------------------------------------------------------------------------
describe('#715 (b) A.1 — takeRawReading and floorAtRecord', () => {
  it('B1 floorAtRecord: within ε lifts to the record’s stamp; beyond ε caps at r + ε; behind or unparseable returns r', () => {
    // (a) red when the min(…, r+ε) cap is dropped (the beyond-ε row), the max is dropped (the within
    //     row), or NaN leaks (the unparseable row); (b) prints each row's label and ISO result.
    const r = new Date(R);
    const rows: Array<[string, string, number]> = [
      ['within ε', iso(R + 3_000), R + 3_000],
      ['beyond ε', iso(R + 3_600_000), R + EPS],
      ['behind', iso(R - 60_000), R],
      ['unparseable', 'garbage', R],
    ];
    expect(
      rows.map(([label, u]) => `${label}: ${floorAtRecord(r, { updated_at: u }).toISOString()}`),
    ).toEqual(rows.map(([label, , want]) => `${label}: ${iso(want)}`));
  });

  it('B2 a returned Date is fresh: mutating it changes neither the reading passed in nor a second call', () => {
    // (a) red when floorAtRecord returns `r` itself, or takeRawReading returns the clock's own Date;
    //     (b) prints the instants after the mutation.
    const r = new Date(R);
    floorAtRecord(r, { updated_at: iso(R - 60_000) }).setTime(0);
    floorAtRecord(r, { updated_at: 'garbage' }).setTime(0);
    const shared = new Date(R);
    const clock = counting(() => shared); // a clock that hands out the SAME Date every call
    takeRawReading(clock).setTime(0);
    expect([r.toISOString(), takeRawReading(clock).toISOString()]).toEqual([iso(R), iso(R)]);
  });

  it('B3 takeRawReading spends exactly one now() and never floors; an invalid Date throws after that one call', () => {
    // (a) red when a second now() is added, or a floor creeps in; (b) prints the count and the instant.
    const clock = counting(() => new Date(R));
    expect([takeRawReading(clock).toISOString(), clock.calls]).toEqual([iso(R), 1]);
    const broken = counting(() => new Date(Number.NaN));
    expect(() => takeRawReading(broken)).toThrow(/clock\.now\(\)/);
    expect(broken.calls, 'calls before the throw').toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// #715 (b) A.3 (D6-3, D6-10, D6-67) — a settle's reading folds the EVENT instants its delta carries
// (`eventInstantsOf`): `at = max(floored reading, …started_at/completed_at)`, never ε-capped; an
// identity entry's `captured_at` is outside class and never folded.
// ---------------------------------------------------------------------------------------------
describe('#715 (b) A.3 — takeReading folds the delta’s event instants', () => {
  const ev = (started: number, completed: number): EvidenceSnapshot =>
    ({
      step_id: 's',
      started_at: iso(started),
      completed_at: iso(completed),
      duration_ms: completed - started,
      input_summary: {},
      output_summary: {},
      status: 'success',
      evidence_hash: 'h',
    }) as EvidenceSnapshot;
  const settle = (evidence: EvidenceSnapshot[]): SettlementDelta => ({
    kind: 'settle_step',
    step: 's',
    outcome: 'complete',
    evidence,
  });

  it('B4 an evidence completed_at after the reading sets at — 2 s, and 1 h (events are not ε-capped)', () => {
    // (a) red when the fold is dropped (both rows give r) or capped by ε (the 1 h row gives r + ε);
    //     (b) prints both results.
    const at2s = takeReading(
      counting(() => new Date(R)),
      undefined,
      settle([ev(R, R + 2_000)]),
    );
    const at1h = takeReading(
      counting(() => new Date(R)),
      undefined,
      settle([ev(R, R + 3_600_000)]),
    );
    expect([at2s.toISOString(), at1h.toISOString()]).toEqual([iso(R + 2_000), iso(R + 3_600_000)]);
  });

  it('B5 a seal_run identity entry captured 1 h ahead does NOT move at (captured_at is outside class)', () => {
    // (a) red when captured_at is folded (at becomes r + 1 h); (b) prints the result.
    const seal: SettlementDelta = {
      kind: 'seal_run',
      arm: 'abandon_requested',
      reason: 'r',
      expected_version: 1,
      release_claims: true,
      identity_entry: { captured_at: iso(R + 3_600_000) } as unknown as ExtensionIdentityEntry,
    };
    expect(eventInstantsOf(seal)).toEqual([]);
    expect(
      takeReading(
        counting(() => new Date(R)),
        undefined,
        seal,
      ).toISOString(),
    ).toBe(iso(R));
  });

  it('B6 a delta with no evidence leaves at = the floored reading', () => {
    // (a) red when an empty delta moves at, or the floor is skipped with a delta; (b) prints it.
    const at = takeReading(
      counting(() => new Date(R)),
      { updated_at: iso(R + 1_000) },
      { kind: 'expire_gate', gateId: 'g' },
    );
    expect(at.toISOString()).toBe(iso(R + 1_000));
  });
});
