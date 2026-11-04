// reminder-schedule-715b.test.ts — issue #715 (b) 02 §D.3 (D6-21) with Amendment 9: the ONE pure
// function of a snapshot every view reads an open question's reminder schedule from.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { reminderScheduleOf } from './gate-timing.js';
import { writtenSnapshot } from './snapshot.js';
import type { PendingGate, RunRecord } from '../types/run-record.js';

const OPENED = Date.parse('2031-05-06T07:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const R = 60_000;

const run = (gate: Partial<PendingGate> | undefined): RunRecord =>
  ({
    id: 'r1',
    updated_at: iso(OPENED),
    ...(gate !== undefined
      ? {
          pending_gate: {
            gate_id: 'g1',
            step_name: 'ask',
            preview: {},
            choices: ['a'],
            opened_at: iso(OPENED),
            ...gate,
          },
        }
      : {}),
  }) as unknown as RunRecord;

const schedule = (gate: Partial<PendingGate> | undefined, atMs: number) =>
  reminderScheduleOf(writtenSnapshot(run(gate), new Date(atMs)));

describe('#715 (b) §D.3 — reminderScheduleOf', () => {
  it('stops at reminder_max: occurrence k at opened_at + k·R, k ≤ max', () => {
    // (a) red when the schedule runs past reminder_max; (b) prints the occurrences.
    expect(schedule({ reminder_seconds: 60, reminder_max: 3 }, OPENED)?.occurrences).toEqual([
      { k: 1, at: iso(OPENED + R) },
      { k: 2, at: iso(OPENED + 2 * R) },
      { k: 3, at: iso(OPENED + 3 * R) },
    ]);
  });

  it('stops at expires_at: an occurrence at or after it is the expiry’s message, not a reminder', () => {
    // (a) red when an occurrence at expires_at is scheduled as a reminder; (b) prints the ks.
    const s = schedule(
      { reminder_seconds: 60, reminder_max: 10, expires_at: iso(OPENED + 3 * R) },
      OPENED,
    );
    expect(s?.occurrences.map((o) => o.k)).toEqual([1, 2]);
  });

  it('an unparseable opened_at: no occurrence; no authored reminder (or no question): no schedule', () => {
    // (a) red when an unreadable stamp yields occurrences (or throws), or an unauthored gate gets a
    //     schedule; (b) prints the three results.
    expect([
      schedule({ reminder_seconds: 60, reminder_max: 3, opened_at: 'not-a-time' }, OPENED),
      schedule({}, OPENED),
      schedule(undefined, OPENED),
    ]).toEqual([{ max: 3, occurrences: [] }, undefined, undefined]);
  });

  it('next is judged at the snapshot’s at, through the one due test (`at ≥ deadline`): an occurrence exactly at the reading has passed; past the last, none', () => {
    // (a) red when next is judged at any instant but the snapshot's, or by another boundary than
    //     isPastDeadline's; (b) prints the next k at each reading.
    const g = { reminder_seconds: 60, reminder_max: 3 };
    expect([
      schedule(g, OPENED + R - 1)?.next?.k,
      schedule(g, OPENED + R)?.next?.k,
      schedule(g, OPENED + R + 1)?.next?.k,
      schedule(g, OPENED + 3 * R + 1)?.next,
    ]).toEqual([1, 2, 2, undefined]);
  });
});
