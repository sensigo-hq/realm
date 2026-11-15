// reminder-due.test.ts — issue #597 D3a: core's one grid of an open question's reminder items
// (`dueReminderWork`) and the question post's anchor (`reminderAnchorOf`), as pure functions. What the
// notifier does with them is `slack-reminder-due-d3a.test.ts` (CLI) and the #964 and D1b cells (the
// net). Each assertion names (a) the change that turns it red and (b) what it prints when it fails.
import { describe, it, expect } from 'vitest';
import { dueReminderWork, reminderAnchorOf } from './reminder-due.js';
import type { PendingGate } from '../types/run-record.js';

const OPENED_MS = Date.parse('2033-01-01T00:00:00.000Z');
const MIN = 60_000;
const at = (ms: number): Date => new Date(OPENED_MS + ms);
const gate = (fields: Partial<PendingGate> = {}): PendingGate =>
  ({
    gate_id: 'g1',
    step_name: 'review',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: '2033-01-01T00:00:00.000Z',
    ...fields,
  }) as PendingGate;
const settings = { reminderIntervalMs: 10 * MIN, escalationThresholdMs: 30 * MIN };
const states = (items: ReturnType<typeof dueReminderWork>): string[] =>
  items.map(
    (i) =>
      `${i.kind}${i.what.type === 'reminder' ? i.what.occurrence : ''}@${(i.atMs - OPENED_MS) / MIN}m:${i.state}`,
  );

describe('#597 D3a — dueReminderWork, the whole grid', () => {
  it('the authored cycle, its final and the nudge, in order; on equal instants the nudge is the later; one due at most', () => {
    const g = gate({
      reminder_seconds: 600,
      reminder_max: 3,
      expires_at: '2033-01-01T00:30:00.000Z',
    });
    // (a) red when an item is missing, the order differs (the nudge before occurrence 3's final at
    //     the same instant), or two items are due; (b) prints the states.
    expect({
      at0: states(dueReminderWork(g, settings, OPENED_MS, [], at(0))),
      at25: states(dueReminderWork(g, settings, OPENED_MS, [], at(25 * MIN))),
      at30: states(dueReminderWork(g, settings, OPENED_MS, [], at(30 * MIN))),
    }).toEqual({
      at0: [
        'occurrence1@10m:future',
        'occurrence2@20m:future',
        'final3@30m:future',
        'nudge@30m:future',
      ],
      at25: [
        'occurrence1@10m:passed',
        'occurrence2@20m:due',
        'final3@30m:future',
        'nudge@30m:future',
      ],
      at30: [
        'occurrence1@10m:passed',
        'occurrence2@20m:passed',
        'final3@30m:passed',
        'nudge@30m:due',
      ],
    });
  });

  it('with no authored schedule: the one-shot and the nudge from the anchor; an unreadable `opened_at` gives no authored item and does not throw', () => {
    // (a) red when the one-shot or the nudge ignores the anchor, or an unreadable stamp throws or
    //     yields an occurrence; (b) prints the states.
    expect({
      oneShot: states(dueReminderWork(gate(), settings, OPENED_MS + 5 * MIN, [], at(0))),
      unreadable: states(
        dueReminderWork(
          gate({ opened_at: 'not a time', reminder_seconds: 600 }),
          settings,
          OPENED_MS,
          [],
          at(0),
        ),
      ),
    }).toEqual({
      oneShot: ['one_shot1@15m:future', 'nudge@35m:future'],
      unreadable: ['nudge@30m:future'],
    });
  });
});

describe('#597 D3a — dueReminderWork, the states a sender reads', () => {
  const sent = (key: string, atMs: number) => ({
    entry_key: `gate:g1:${key}`,
    type: key === 'escalation' ? ('escalation' as const) : ('reminder' as const),
    ...(key === 'escalation' ? {} : { occurrence: Number(key.split(':')[1]) }),
    status: 'sent' as const,
    lease_deadline: new Date(atMs + MIN).toISOString(),
    attempts: 1,
    sent_at: new Date(atMs).toISOString(),
    created_at: new Date(atMs).toISOString(),
  });

  it('the latest passed item already sent: nothing is due, and no earlier one is walked back to', () => {
    const g = gate({ reminder_seconds: 600, reminder_max: 3 });
    // (a) red when an earlier unsent occurrence becomes due; (b) prints the states.
    expect(
      states(
        dueReminderWork(
          g,
          { ...settings, escalationThresholdMs: 999 * MIN },
          OPENED_MS,
          [sent('reminder:2', OPENED_MS + 20 * MIN)],
          at(25 * MIN),
        ),
      ),
    ).toEqual([
      'occurrence1@10m:passed',
      'occurrence2@20m:passed',
      'occurrence3@30m:future',
      'nudge@999m:future',
    ]);
  });

  it("an `on_expiry` gate's nudge at or after `expires_at` is not due; a finding-only gate's is", () => {
    const closes = gate({ expires_at: '2033-01-01T00:20:00.000Z', on_expiry: 'abort' });
    const stays = gate({ expires_at: '2033-01-01T00:20:00.000Z' });
    const big = { reminderIntervalMs: 999 * MIN, escalationThresholdMs: 30 * MIN };
    // (a) red when the nudge's closure by the expiry is lost; (b) prints the states.
    expect({
      closes: states(dueReminderWork(closes, big, OPENED_MS, [], at(35 * MIN))),
      stays: states(dueReminderWork(stays, big, OPENED_MS, [], at(35 * MIN))),
    }).toEqual({
      closes: ['nudge@30m:passed', 'one_shot1@999m:future'],
      stays: ['nudge@30m:due', 'one_shot1@999m:future'],
    });
  });

  it('the same-line rule: a sent line of the other leg within the minute consumes; with an owner, or earlier than the minute, it does not', () => {
    const near = [sent('reminder:1', OPENED_MS + 29 * MIN + 30_000)];
    const far = [sent('reminder:1', OPENED_MS + 25 * MIN)];
    const s = { reminderIntervalMs: 25 * MIN, escalationThresholdMs: 30 * MIN };
    // (a) red when the rule ignores the owner, the window, or the leg; (b) prints the states.
    expect({
      near: states(dueReminderWork(gate(), s, OPENED_MS, near, at(35 * MIN))),
      owner: states(dueReminderWork(gate({ owner: '@ana' }), s, OPENED_MS, near, at(35 * MIN))),
      far: states(dueReminderWork(gate(), s, OPENED_MS, far, at(35 * MIN))),
    }).toEqual({
      near: ['one_shot1@25m:passed', 'nudge@30m:consumed'],
      owner: ['one_shot1@25m:passed', 'nudge@30m:due'],
      far: ['one_shot1@25m:passed', 'nudge@30m:due'],
    });
  });
});

describe('#597 D3a — reminderAnchorOf, the post’s time clamped', () => {
  it('between `opened_at` and the reading; the reading when `ts` or `opened_at` cannot be read', () => {
    const g = gate();
    const reading = at(5 * MIN);
    const of = (ts: string, gg: PendingGate = g) => reminderAnchorOf(gg, ts, reading);
    // (a) red when a bound is lost, or an unreadable value is used; (b) prints the anchors.
    expect({
      inside: of(String((OPENED_MS + 2 * MIN) / 1000)),
      before: of('1234567890.000'),
      after: of(String((OPENED_MS + 60 * MIN) / 1000)),
      notATs: of('ts-1'),
      zero: of('0'),
      noOpenedAt: of('1234567890.000', gate({ opened_at: 'not a time' })),
    }).toEqual({
      inside: { anchorMs: OPENED_MS + 2 * MIN, tsUnreadable: false },
      before: { anchorMs: OPENED_MS, tsUnreadable: false },
      after: { anchorMs: reading.getTime(), tsUnreadable: false },
      notATs: { anchorMs: reading.getTime(), tsUnreadable: true },
      zero: { anchorMs: reading.getTime(), tsUnreadable: true },
      noOpenedAt: { anchorMs: reading.getTime(), tsUnreadable: false },
    });
  });
});
