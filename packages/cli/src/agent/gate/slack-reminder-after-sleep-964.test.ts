// slack-reminder-after-sleep-964.test.ts — issue #964: a Slack reminder after the machine slept says
// the true age. The reminders and the escalation wait on the store's clock; a firing at most 60 s late
// is composed as when on time (at its scheduled instant), a later one at the clock's reading; of what
// is due together only the latest occurrence posts (the escalation is its own post); the occurrences
// not yet due stay on their instants; a question its expiry closes (`on_expiry`) gets nothing at or
// after `expires_at` but the final reminder.
//
// A sleep is rehearsed with `wakeClock` (test-support): every waiter due by the wake runs, each
// reading the wake, as the store's system clock delivers them after a sleep. The instants are in 2033.
// Each cell carries (a) the change that turns it red and (b) what it prints on failure (the posts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writtenSnapshot, type PendingGate, type RunRecord } from '@sensigo/realm';
import { startGateReminderTimers } from './slack-gate-notifier.js';
import { slackResponse } from '../test-support/slack-response.js';
import { wakeClock, type WakeClock } from '../test-support/wake-clock.js';

const OPENED = '2033-01-01T00:00:00.000Z';
const OPENED_MS = Date.parse(OPENED);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** The instant `ms` after the question opened. */
const plus = (ms: number): Date => new Date(OPENED_MS + ms);
const FAR = 999_999_999;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Captures every posted text, in the order the posts were made. */
function posts(): string[] {
  const texts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      texts.push((JSON.parse(init.body as string) as { text: string }).text);
      return Promise.resolve(slackResponse({ json: { ok: true } }));
    }),
  );
  return texts;
}

/** Lets the posts the waiters started reach the stubbed fetch. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/**
 * Starts the reminders of a question opened at OPENED and read then, on a fresh wake clock. `fields`
 * are the gate's own (reminder_seconds, reminder_max, expires_at, on_expiry, owner).
 */
function started(
  fields: Record<string, unknown>,
  reminderIntervalMs = FAR,
  escalationMs = FAR,
): { clock: WakeClock; texts: string[]; clear: () => void } {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const texts = posts();
  const gate = {
    gate_id: 'g-964',
    step_name: 'review_step',
    preview: { headline: 'Deploy' },
    choices: ['approve', 'reject'],
    opened_at: OPENED,
    ...fields,
  } as unknown as PendingGate;
  const clock = wakeClock(plus(0));
  const opened = writtenSnapshot({ pending_gate: gate } as unknown as RunRecord, plus(0));
  const clear = startGateReminderTimers(
    'xoxb-test',
    'C123',
    '1234567890.000',
    opened,
    reminderIntervalMs,
    escalationMs,
    clock,
  );
  return { clock, texts, clear };
}

const open = (age: string): string =>
  `⏰ gate \`review_step\` has been open for ${age} (since 2033-01-01T00:00:00Z). Please respond.`;

describe('#964 — a reminder after a sleep says the true age', () => {
  it('1: inside the 60 s grace a firing is composed as when on time (the final reminder 30 s late; R = 45 s fired 20 s late)', async () => {
    // (a) red when a firing inside the grace is composed at the reading: "expired 30s ago" and "1m";
    //     (b) prints the posts.
    const final = started({
      reminder_seconds: 600,
      reminder_max: 3,
      expires_at: plus(30 * MIN).toISOString(),
      on_expiry: 'abort',
    });
    await final.clock.set(plus(20 * MIN)); // k = 1 and 2, on time
    await final.clock.wake(plus(30 * MIN + 30 * SEC)); // the final (k = 3, at expires_at), 30 s late
    await settle();
    final.clear();
    expect(final.texts.slice(2)).toEqual([
      '⏰ gate `review_step` expired 0s ago (2033-01-01T00:30:00Z) — the run will be stopped.',
    ]);
    const plain = started({ reminder_seconds: 45, reminder_max: 1 });
    await plain.clock.wake(plus(65 * SEC)); // k = 1 (at 45 s), 20 s late
    await settle();
    plain.clear();
    expect(plain.texts).toEqual([open('45s')]);
  });

  it('2: the grace boundary: exactly 60 000 ms late is composed at the scheduled instant, 60 001 ms at the reading', async () => {
    // (a) red when the boundary is `<` for `<=` ("11m" at 60 000) or when a firing past the grace keeps
    //     its scheduled age ("10m" at 60 001); (b) prints the two posts.
    const atBoundary = started({ reminder_seconds: 600, reminder_max: 1 });
    await atBoundary.clock.wake(plus(10 * MIN + 60_000));
    await settle();
    atBoundary.clear();
    const past = started({ reminder_seconds: 600, reminder_max: 1 });
    await past.clock.wake(plus(10 * MIN + 60_001));
    await settle();
    past.clear();
    expect({ at60000: atBoundary.texts, at60001: past.texts }).toEqual({
      at60000: [open('10m')],
      at60001: [open('11m')],
    });
  });

  it('3 and 4: after a sleep ONE reminder (the latest due) says the true age; the rest of the series stays on its instants (a journey)', async () => {
    // (a) red for a burst (k = 1..18 each posted), for the scheduled-age text ("3h 0m"), and when the
    //     skip cancels or consumes later waiters (k = 19 and 20 missing) or counts a not-yet-due one;
    //     (b) prints the posts at each step and the waiters left.
    const s = started({ reminder_seconds: 600, reminder_max: 20 });
    // The wake at 3 h 5 m: more than 60 s past k = 18's instant (3 h), before k = 19's (3 h 10 m).
    await s.clock.wake(plus(3 * HOUR + 5 * MIN));
    await settle();
    const afterWake = [...s.texts];
    await s.clock.set(plus(3 * HOUR + 10 * MIN)); // k = 19, on time
    await settle();
    await s.clock.set(plus(3 * HOUR + 20 * MIN)); // k = 20, on time: the last
    await settle();
    await s.clock.set(plus(10 * HOUR));
    await settle();
    const waitersLeft = s.clock.waiting(); // the escalation's, far away
    s.clear();
    expect({ afterWake, all: s.texts, waitersLeft }).toEqual({
      afterWake: [open('3h 5m')],
      all: [open('3h 5m'), open('3h 10m'), open('3h 20m')],
      waitersLeft: 1,
    });
  });

  it('5: the escalation is its own post: one reminder and the escalation, each with its true age', async () => {
    // (a) red when the escalation is merged into the reminder or dropped; (b) prints the posts.
    const s = started(
      { reminder_seconds: 600, reminder_max: 20, owner: '<@U0OWNER>' },
      FAR,
      45 * MIN,
    );
    await s.clock.wake(plus(65 * MIN)); // past k = 1..6 (60 m) and the escalation (45 m)
    await settle();
    s.clear();
    expect(s.texts).toEqual([`<@U0OWNER> — ${open('1h 5m')}`, open('1h 5m')]);
  });

  it('6: a sleep across the expiry of a gate with `on_expiry`: no plain reminder and no escalation; the final reminder alone, at the reading', async () => {
    // (a) red when a plain reminder or the escalation is posted to a question its expiry has closed;
    //     (b) prints the posts of each half.
    const noFinal = started(
      {
        reminder_seconds: 600,
        reminder_max: 3, // k = 4 would be the final: over reminder_max, so there is none
        expires_at: plus(3 * HOUR).toISOString(),
        on_expiry: 'abort',
      },
      FAR,
      15 * MIN,
    );
    await noFinal.clock.wake(plus(22 * HOUR));
    await settle();
    noFinal.clear();
    const withFinal = started(
      {
        reminder_seconds: 600,
        reminder_max: 20, // k = 1..17 plain, k = 18 the final at exactly expires_at
        expires_at: plus(3 * HOUR).toISOString(),
        on_expiry: 'abort',
      },
      FAR,
      15 * MIN,
    );
    await withFinal.clock.wake(plus(22 * HOUR));
    await settle();
    withFinal.clear();
    expect({ noFinal: noFinal.texts, withFinal: withFinal.texts }).toEqual({
      noFinal: [],
      withFinal: [
        '⏰ gate `review_step` expired 19h 0m ago (2033-01-01T03:00:00Z) — the run will be stopped.',
      ],
    });
  });

  it('6b: a gate with no `on_expiry` is not closed at its time: after a sleep past expires_at the latest reminder and the escalation post; an escalation due after expires_at posts on time', async () => {
    // (a) red when the expiry rule is applied without its `on_expiry` condition; (b) prints the posts.
    const asleep = started(
      { reminder_seconds: 600, reminder_max: 3, expires_at: plus(3 * HOUR).toISOString() },
      FAR,
      15 * MIN,
    );
    await asleep.clock.wake(plus(22 * HOUR));
    await settle();
    asleep.clear();
    const onTime = started(
      { reminder_seconds: 600, reminder_max: 3, expires_at: plus(3 * HOUR).toISOString() },
      FAR,
      4 * HOUR,
    );
    await onTime.clock.set(plus(5 * HOUR));
    await settle();
    onTime.clear();
    expect({
      asleep: asleep.texts,
      onTime: onTime.texts,
    }).toEqual({
      asleep: [open('22h 0m'), open('22h 0m')], // the escalation (15 m), then k = 3 (30 m)
      onTime: [open('10m'), open('20m'), open('30m'), open('4h 0m')],
    });
  });

  it('8: every wait is a clock waiter, never a host timer: an occurrence 30 days away; the cleanup leaves none', async () => {
    // (a) red when a waiter is armed as a host `setTimeout` (a hop timer), or when the cleanup leaves a
    //     waiter behind (it still posts at 60 days); (b) prints the setTimeout calls and the counts.
    const setTimeoutCalls = vi.spyOn(globalThis, 'setTimeout');
    const s = started(
      {
        reminder_seconds: 10 * 86_400,
        reminder_max: 4, // k = 1 (10 d), k = 2 (20 d); the final k = 3 at 30 d = expires_at
        expires_at: plus(30 * 24 * HOUR).toISOString(),
        on_expiry: 'abort',
      },
      FAR,
      45 * 24 * HOUR,
    );
    const armed = { setTimeout: setTimeoutCalls.mock.calls.length, waiting: s.clock.waiting() };
    s.clear();
    const afterCleanup = s.clock.waiting();
    await s.clock.set(plus(60 * 24 * HOUR));
    await settle();
    expect({ armed, afterCleanup, posts: s.texts }).toEqual({
      armed: { setTimeout: 0, waiting: 4 }, // two occurrences, the final reminder, the escalation
      afterCleanup: 0,
      posts: [],
    });
  });

  it('9: the operator-fallback single reminder follows the same lateness rule', async () => {
    // (a) red when the fallback reminder is composed at its scheduled instant past the grace ("10m");
    //     (b) prints the post.
    const s = started({}, 10 * MIN, FAR);
    await s.clock.wake(plus(3 * HOUR));
    await settle();
    s.clear();
    expect(s.texts).toEqual([open('3h 0m')]);
  });
});
