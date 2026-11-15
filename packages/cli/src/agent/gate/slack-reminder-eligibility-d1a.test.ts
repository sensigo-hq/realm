// slack-reminder-eligibility-d1a.test.ts — issue #597, D1a: three rules the Slack notifier hands to
// core's `reminderEligibility` that no #964 cell reaches. (1) The cap: the occurrence after the last
// scheduled one is the final reminder only while it is within `reminder_max`. (2) The expiry closes an
// `on_expiry` question exactly AT `expires_at`: a firing then posts no plain reminder and no escalation
// (1 ms before, each posts). (3) An `expires_at` that cannot be read counts as unset: every scheduled
// reminder posts. The #964 cells cover the rest of what moved (the final, finding-only, sleeps past the
// expiry); these three were shown uncovered by D1a's red-first breaks B14, B15 and B18.
//
// The reminders wait on `wakeClock` (test-support), as in `slack-reminder-after-sleep-964.test.ts`.
// Each cell carries (a) the change that turns it red and (b) what it prints on failure (the posts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writtenSnapshot, type PendingGate, type RunRecord } from '@sensigo/realm';
import { startGateReminderTimers } from './slack-gate-notifier.js';
import { slackResponse } from '../test-support/slack-response.js';
import { wakeClock, type WakeClock } from '../test-support/wake-clock.js';

const OPENED = '2033-01-01T00:00:00.000Z';
const OPENED_MS = Date.parse(OPENED);
const MIN = 60_000;
const FAR = 999_999_999;
/** The instant `ms` after the question opened. */
const plus = (ms: number): Date => new Date(OPENED_MS + ms);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Starts the reminders of a question opened at OPENED and read then; every posted text is kept. */
function started(
  fields: Record<string, unknown>,
  escalationMs = FAR,
): { clock: WakeClock; texts: string[]; clear: () => void } {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const texts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      texts.push((JSON.parse(init.body as string) as { text: string }).text);
      return Promise.resolve(slackResponse({ json: { ok: true } }));
    }),
  );
  const gate = {
    gate_id: 'g-d1a',
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
    FAR,
    escalationMs,
    clock,
  );
  return { clock, texts, clear };
}

/** Lets the posts the waiters started reach the stubbed fetch. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('#597 D1a — the notifier’s rules that core now judges', () => {
  it('the cap: with reminder_max 2 and both reminders before expires_at, no final reminder is posted', async () => {
    // Reminders at +10 and +20 min; the expiry at +25 min; the occurrence after the last (k = 3, at
    // +30 min) is past reminder_max, so it is no final reminder.
    const s = started({
      reminder_seconds: 600,
      reminder_max: 2,
      expires_at: plus(25 * MIN).toISOString(),
      on_expiry: 'abort',
    });
    for (const at of [10, 20, 40]) {
      await s.clock.set(plus(at * MIN));
      await settle();
    }
    s.clear();
    // (a) red when the cap is dropped from the final's registration (D1a break B14: a third post, the
    //     expiry's wording, at +30 min); (b) prints the posts.
    expect({ count: s.texts.length, final: s.texts.filter((t) => t.includes('expired')) }).toEqual({
      count: 2,
      final: [],
    });
  });

  it('the closure: exactly at an on_expiry expiry no plain reminder and no escalation is posted; 1 ms before, each is', async () => {
    // A plain reminder: reminders at +10 and +20 min, the expiry at +25 min, the final at +30 min. The
    // machine wakes at the expiry: reminder 2 is the latest due (the final is not), and the expiry
    // has closed the question.
    const authored = {
      reminder_seconds: 600,
      reminder_max: 3,
      expires_at: plus(25 * MIN).toISOString(),
      on_expiry: 'abort',
    };
    const remindAt = async (ms: number): Promise<string[]> => {
      const s = started(authored);
      await s.clock.wake(plus(ms));
      await settle();
      s.clear();
      return s.texts;
    };
    // The escalation, due exactly at the expiry of a question with no authored schedule.
    const escalateAt = async (ms: number): Promise<string[]> => {
      const s = started({ expires_at: plus(20 * MIN).toISOString(), on_expiry: 'abort' }, ms);
      await s.clock.set(plus(ms));
      await settle();
      s.clear();
      return s.texts;
    };
    const posted = {
      reminder: { exact: await remindAt(25 * MIN), before: (await remindAt(25 * MIN - 1)).length },
      escalation: {
        exact: await escalateAt(20 * MIN),
        before: (await escalateAt(20 * MIN - 1)).length,
      },
    };
    // (a) red when the expiry closes only after `expires_at` (D1a break B15: reminder 2 and the
    //     escalation post at it), or closes before it (a post 1 ms before is missing); (b) prints the
    //     posts.
    expect(posted).toEqual({
      reminder: { exact: [], before: 1 },
      escalation: { exact: [], before: 1 },
    });
  });

  it('an expires_at that cannot be read counts as unset: reminders 1, 2 and 3 are posted', async () => {
    const s = started({ reminder_seconds: 600, reminder_max: 3, expires_at: 'not-an-instant' });
    for (const at of [10, 20, 30, 60]) {
      await s.clock.set(plus(at * MIN));
      await settle();
    }
    s.clear();
    // (a) red when the unreadable instant is compared as a number (D1a break B18: `NaN` refuses
    //     reminders 2 and 3); (b) prints the posts.
    expect(s.texts.length, s.texts.join('\n')).toBe(3);
  });
});
