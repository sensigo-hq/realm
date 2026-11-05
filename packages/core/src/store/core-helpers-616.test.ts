// core-helpers-616.test.ts — issue #616 PR-1a unit 2: three pure pieces core gains for the SQLite run
// store, with no change to any existing store. The fold of a reading already taken (`foldReading`), the
// clock-file read by a store's ROOT folder (`resolveRootClock`), and the key-holder ordering moved out
// of the JSON store (`compareCanonical`, `pickCanonical`) over plain objects.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOCK_SKEW_EPSILON_MS as EPS } from '../engine/instants.js';
import type { EvidenceSnapshot } from '../types/run-record.js';
import type { ExtensionIdentityEntry } from '../types/extension-identity.js';
import type { SettlementDelta } from '../types/settlement.js';
import { systemClock, type Clock } from '../utils/clock.js';
import { compareCanonical, pickCanonical } from './key-holder.js';
import { foldReading, takeReading } from './take-reading.js';
import {
  readTestClockFile,
  resolveRootClock,
  resolveStoreClock,
  TEST_CLOCK_FILE_NAME,
  writeTestClockFile,
} from './test-clock-file.js';

const R = Date.parse('2030-06-01T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const clockAt = (ms: number): Clock => ({
  now: () => new Date(ms),
  at: () => {
    throw new Error('not used');
  },
});
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

describe('#616 PR-1a unit 2 — the pure fold of a reading', () => {
  it('foldReading gives the instant takeReading gives on a clock returning that reading, in each of its states', () => {
    // The rows of take-reading.test.ts's A7, B4, B5 and B6, with their expected instants.
    const rows: Array<
      [string, { updated_at: string } | undefined, SettlementDelta | undefined, number]
    > = [
      ['no record', undefined, undefined, R],
      ['updated_at behind', { updated_at: iso(R - 60_000) }, undefined, R],
      ['updated_at = r+3 s', { updated_at: iso(R + 3_000) }, undefined, R + 3_000],
      ['updated_at = r+ε', { updated_at: iso(R + EPS) }, undefined, R + EPS],
      ['updated_at = r+1 h (capped)', { updated_at: iso(R + 3_600_000) }, undefined, R + EPS],
      ['updated_at unparseable (ignored)', { updated_at: 'garbage' }, undefined, R],
      ['an event 2 s after', undefined, settle([ev(R, R + 2_000)]), R + 2_000],
      ['an event 1 h after (not capped)', undefined, settle([ev(R, R + 3_600_000)]), R + 3_600_000],
      [
        'a seal_run identity 1 h ahead (not folded)',
        undefined,
        {
          kind: 'seal_run',
          arm: 'abandon_requested',
          reason: 'r',
          expected_version: 1,
          release_claims: true,
          identity_entry: { captured_at: iso(R + 3_600_000) } as unknown as ExtensionIdentityEntry,
        },
        R,
      ],
      [
        'a delta with no evidence',
        { updated_at: iso(R + 1_000) },
        { kind: 'expire_gate', gateId: 'g' },
        R + 1_000,
      ],
    ];
    const reading = new Date(R);
    const got = rows.map(([label, record, delta]) => {
      const fold = foldReading(reading, record, delta);
      return [
        label,
        fold.toISOString(),
        takeReading(clockAt(R), record, delta).toISOString(),
        fold !== reading,
      ];
    });
    // (1) Can it fail: red when the fold drops a state — the named break: the fold ignores the delta's
    //     events (the two event rows give r) — or returns the Date it was given (the last column).
    //     `takeReading` is built on the fold, so the two columns move together; the expected instants
    //     are what holds each of them.
    // (2) Prints: per row, the label, the fold's ISO instant, takeReading's, and whether the fold's
    //     Date is a fresh object.
    expect(got).toEqual(
      rows.map(([label, , , expected]) => [label, iso(expected), iso(expected), true]),
    );
  });
});

describe('#616 PR-1a unit 2 — the clock file read by its root folder', () => {
  it('resolveRootClock(root) answers as resolveStoreClock(<root>/runs): no file, a clock file, a garbage file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'realm-616-root-'));
    const refusal = (f: () => unknown): string => {
      try {
        f();
        return 'no refusal';
      } catch (e) {
        return (e as Error).message;
      }
    };
    try {
      const runs = join(root, 'runs');
      const none = [
        resolveRootClock(root) === systemClock,
        resolveStoreClock(runs) === systemClock,
      ];
      const instant = new Date('2031-02-03T04:05:06.789Z');
      await writeTestClockFile(root, instant);
      const file = [
        resolveRootClock(root).now().toISOString(),
        resolveStoreClock(runs).now().toISOString(),
      ];
      const path = join(root, TEST_CLOCK_FILE_NAME);
      await writeFile(path, 'garbage', 'utf8');
      const garbage = [
        refusal(() => resolveRootClock(root)),
        refusal(() => resolveStoreClock(runs)),
      ];
      // (1) Can it fail: red when the root reader looks for the file anywhere but in `root` — the
      //     named break: one level too high (`join(dirname(root), …)`): the clock file is then not
      //     seen (the system clock instead of the file's instant) and the garbage file is not refused.
      // (2) Prints: per state, the root's answer and the runs folder's (booleans, ISO instants, the
      //     refusal's words: a temporary path and a fixed sentence, no secret).
      expect({ none, file, garbage }).toEqual({
        none: [true, true],
        file: [instant.toISOString(), instant.toISOString()],
        garbage: [refusal(() => readTestClockFile(path)), refusal(() => readTestClockFile(path))],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('#616 PR-1a unit 2 — the key-holder ordering over plain objects', () => {
  it('pickCanonical and compareCanonical order plain { id, created_at, terminal_state }: unparseable oldest, ties by the greatest id, one live run wins', () => {
    const t = (id: string, created_at: string, terminal_state: boolean) => ({
      id,
      created_at,
      terminal_state,
    });
    const ended = [
      t('a', 'garbage', true),
      t('b', '2026-01-01T00:00:00.000Z', true),
      t('c', '2026-01-01T00:00:00.000Z', true),
      t('d', '2025-12-31T23:59:59.999Z', true),
    ];
    const twoLive = pickCanonical([
      t('f', '2026-02-01T00:00:00.000Z', false),
      t('g', 'garbage', false),
      ...ended,
    ]);
    // (1) Can it fail: red when the order changes — the named break: `compareCanonical` compares the
    //     stamps as strings (then 'garbage' sorts newest, ahead of every parseable stamp); also when
    //     the tie stops going to the greatest id or a live run stops winning.
    // (2) Prints: the sorted ids and each pick's ids (letters only).
    expect({
      sorted: [...ended].sort(compareCanonical).map((r) => r.id),
      ended: pickCanonical(ended).canonical.id,
      oneLive: pickCanonical([...ended, t('e', '2020-01-01T00:00:00.000Z', false)]).canonical.id,
      twoLive: [twoLive.canonical.id, twoLive.extraLive.map((r) => r.id)],
    }).toEqual({ sorted: ['c', 'b', 'd', 'a'], ended: 'c', oneLive: 'e', twoLive: ['f', ['g']] });
  });
});
