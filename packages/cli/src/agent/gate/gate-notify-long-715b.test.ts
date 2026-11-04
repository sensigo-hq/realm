// gate-notify-long-715b.test.ts — issue #715 (b) correction 1 (C-2): a Slack reminder schedule that
// reaches further than Node's longest timer. Node runs a `setTimeout` longer than 2^31−1 ms (24.8 days)
// after 1 ms; since #715 (b) every reminder of an authored cycle is armed at once, from the reading,
// at `opened_at + k·reminder_seconds`, so a 10-day cycle's third reminder (30 days away) and every
// later one would post in the first millisecond, each with an age the question does not have. The
// notifier arms such a timer in hops of at most 2^31−1 ms. The real case: a workflow author writes
// `reminder_seconds: 864000` (10 days) and `reminder_max: 9` on a question with no deadline; the
// loader puts no upper limit on either.
//
// Only `setTimeout` / `clearTimeout` are faked (vitest's fake timers turn a delay above 2^31−1 ms into
// 1 ms, as Node does); `Date` stays real, as in `slack-reminder-late-fire-715b.test.ts`. The instants
// are in 2033, so a text composed at the host's clock would show it.
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writtenSnapshot, type PendingGate, type RunRecord } from '@sensigo/realm';
import { startGateReminderTimers } from './slack-gate-notifier.js';
import { slackResponse } from '../test-support/slack-response.js';

const OPENED = '2033-01-01T00:00:00.000Z';
const DAY = 86_400_000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Captures every posted text. */
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

/**
 * Starts the notifier's timers for a question with an authored cycle and no deadline, read 1 s after
 * it opened; the operator's own reminder never applies (the author's cycle wins).
 */
function started(reminderSeconds: number, reminderMax: number, escalationMs: number): () => void {
  const gate = {
    gate_id: 'g-long',
    step_name: 'review_step',
    preview: { headline: 'Deploy' },
    choices: ['approve', 'reject'],
    opened_at: OPENED,
    reminder_seconds: reminderSeconds,
    reminder_max: reminderMax,
  } as unknown as PendingGate;
  const opened = writtenSnapshot(
    { pending_gate: gate } as unknown as RunRecord,
    new Date(Date.parse(OPENED) + 1000),
  );
  return startGateReminderTimers(
    'xoxb-test',
    'C123',
    '1234567890.000',
    opened,
    999_999_999,
    escalationMs,
  );
}

describe('#715 (b) correction 1 (C-2) — a reminder further away than 24.8 days waits for its instant', () => {
  it('a 10-day cycle of nine reminders posts one every 10 days, never several at once', async () => {
    // (a) red when a timer is armed with its whole delay (`setTimeout(fire, delay)`, no hops): every
    //     reminder from the third on (30 days and more) posts in the first millisecond; (b) prints the
    //     post counts at each instant and the first text.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const texts = posts();
    // The escalation is 100 days away, after the last reminder: the counts are the reminders' alone.
    const clear = started(864_000, 9, 100 * DAY);
    const counts: Record<string, number> = {};
    let elapsed = 0;
    for (const [label, ms] of [
      ['60 s', 60_000],
      ['10 d', 10 * DAY],
      ['20 d', 20 * DAY],
      ['29 d', 29 * DAY],
      ['30 d', 30 * DAY],
      ['31 d', 31 * DAY],
      ['90 d', 90 * DAY],
    ] as const) {
      await vi.advanceTimersByTimeAsync(ms - elapsed);
      elapsed = ms;
      counts[label] = texts.length;
    }
    clear();
    expect({ counts, first: texts[0] }).toEqual({
      counts: { '60 s': 0, '10 d': 1, '20 d': 2, '29 d': 2, '30 d': 3, '31 d': 3, '90 d': 9 },
      first:
        '⏰ gate `review_step` has been open for 10d 0h (since 2033-01-01T00:00:00Z). Please respond.',
    });
  });

  it('the cleanup during a later hop stops the chain: nothing posts and no timer is left', async () => {
    // (a) red when the cleanup clears only a chain's FIRST hop (the hop it is waiting in is not the
    //     handle the cleanup holds): the 40-day reminder and the 50-day escalation still post; (b)
    //     prints the timers left and the posts.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const texts = posts();
    // One reminder 40 days away and the escalation 50 days away: at 30 days both wait in their second
    // hop (the first is 24.8 days).
    const clear = started(40 * 86_400, 1, 50 * DAY);
    await vi.advanceTimersByTimeAsync(30 * DAY);
    const beforeCleanup = { posts: texts.length, timers: vi.getTimerCount() };
    clear();
    const afterCleanup = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(60 * DAY);
    expect({
      beforeCleanup,
      afterCleanup,
      postsAtTheEnd: texts.length,
      timersAtTheEnd: vi.getTimerCount(),
    }).toEqual({
      beforeCleanup: { posts: 0, timers: 2 },
      afterCleanup: 0,
      postsAtTheEnd: 0,
      timersAtTheEnd: 0,
    });
  });
});
