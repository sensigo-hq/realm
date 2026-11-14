// slack-reminder-late-fire-715b.test.ts — issue #715 (b) Amendment 12 (c) (02 §D.3, D-29): a reminder,
// an escalation and an expiry reminder are each composed at the instant they were SCHEDULED for, never
// at the host's clock. #964: that holds for a firing at most 60 s late; a later one (the machine
// slept) is composed at the store clock's reading. The fixture's instants are years after the real
// clock; the notifier waits on a test clock (`wakeClock`, over `settableClock`), so a firing composed at
// `new Date()` would speak of a question opened years in its future. Verify-first: the texts below are
// what the built notifier posts (run first, then pinned).
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure (the posted texts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writtenSnapshot, type PendingGate, type RunRecord } from '@sensigo/realm';
import { startGateReminderTimers } from './slack-gate-notifier.js';
import { slackResponse } from '../test-support/slack-response.js';
import { wakeClock } from '../test-support/wake-clock.js';

const OPENED = '2033-01-01T00:00:00.000Z';
const at = (minutes: number): string =>
  new Date(Date.parse(OPENED) + minutes * 60_000).toISOString();

afterEach(() => {
  vi.unstubAllGlobals();
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

/** Lets the posts the waiters started reach the stubbed fetch. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/** The question of both cells: an authored cycle of 10 minutes, ending at its 30-minute expiry. */
function gateOf(): PendingGate {
  return {
    gate_id: 'g-late-fire',
    step_name: 'review_step',
    preview: { headline: 'Deploy' },
    choices: ['approve', 'reject'],
    opened_at: OPENED,
    expires_at: at(30),
    on_expiry: 'abort',
    reminder_seconds: 600,
    reminder_max: 3,
  } as unknown as PendingGate;
}

describe('#715 (b) Amendment 12 (c) — a late firing speaks at its scheduled instant', () => {
  it('the authored reminders (k = 1, 2) and the final expiry reminder, and the escalation: each text is judged at its own scheduled instant', async () => {
    // (a) red when a firing is composed at the host's clock (`now = new Date()` in reminderFiring, or
    //     the escalation's): its words then speak of a 2033 question from 2026; (b) prints the texts.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const texts = posts();
    const gate = {
      gate_id: 'g-late-fire',
      step_name: 'review_step',
      preview: { headline: 'Deploy' },
      choices: ['approve', 'reject'],
      opened_at: OPENED,
      expires_at: at(30),
      on_expiry: 'abort',
      reminder_seconds: 600,
      reminder_max: 3,
    } as unknown as PendingGate;
    // The notifier read the run 30 s after the question opened.
    const opened = writtenSnapshot(
      { pending_gate: gate } as unknown as RunRecord,
      new Date(Date.parse(OPENED) + 30_000),
    );
    const clock = wakeClock(opened.at);
    const clear = startGateReminderTimers(
      'xoxb-test',
      'C123',
      '1234567890.000',
      opened,
      999_999_999,
      15 * 60_000,
      clock,
    );
    await clock.set(new Date(at(31)));
    await settle();
    clear();
    // In firing order: reminder k = 1 (+10 m), the escalation (the reading + 15 m = +15 m 30 s), reminder
    // k = 2 (+20 m), the final expiry reminder (k = 3, +30 m = expires_at). Real `Date` is 2026.
    expect(texts).toEqual([
      '⏰ gate `review_step` has been open for 10m (since 2033-01-01T00:00:00Z). Please respond.',
      '⏰ gate `review_step` has been open for 15m (since 2033-01-01T00:00:00Z). Please respond.',
      '⏰ gate `review_step` has been open for 20m (since 2033-01-01T00:00:00Z). Please respond.',
      '⏰ gate `review_step` expired 0s ago (2033-01-01T00:30:00Z) — the run will be stopped.',
    ]);
  });

  it('#964: inside the grace a firing speaks at its scheduled instant, past it at the reading (the second side)', async () => {
    // (a) red when a firing past the 60 s grace keeps its scheduled age (the escalation and k = 2 read
    //     "15m" and "20m" at a 22-minute wake), or a firing inside it is composed at the reading ("expired
    //     30s ago"); (b) prints the texts. The gate names an owner, so the escalation's line differs
    //     from k = 2's (#964 correction 1: a line that would repeat the other's is posted once).
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const texts = posts();
    const opened = writtenSnapshot(
      { pending_gate: { ...gateOf(), owner: '<@U0OWNER>' } } as unknown as RunRecord,
      new Date(Date.parse(OPENED) + 30_000),
    );
    const clock = wakeClock(opened.at);
    const clear = startGateReminderTimers(
      'xoxb-test',
      'C123',
      '1234567890.000',
      opened,
      999_999_999,
      15 * 60_000,
      clock,
    );
    // A wake at 22 m: k = 1 (10 m) is replaced by k = 2 (20 m), 2 m late; the escalation (15 m 30 s)
    // is its own post, 6 m 30 s late. Then a wake 30 s after the final reminder's instant (30 m).
    await clock.wake(new Date(at(22)));
    await settle();
    await clock.wake(new Date(Date.parse(at(30)) + 30_000));
    await settle();
    clear();
    expect(texts).toEqual([
      '<@U0OWNER> — ⏰ gate `review_step` has been open for 22m (since 2033-01-01T00:00:00Z). Please respond.',
      '⏰ gate `review_step` has been open for 22m (since 2033-01-01T00:00:00Z). Please respond.',
      '⏰ gate `review_step` expired 0s ago (2033-01-01T00:30:00Z) — the run will be stopped.',
    ]);
  });
});
