// slack-reminder-late-fire-715b.test.ts — issue #715 (b) Amendment 12 (c) (02 §D.3, D-29): a reminder,
// an escalation and an expiry reminder are each composed at the instant they were SCHEDULED for, never
// at the host's clock. The fixture's instants are years after the real clock, and only `setTimeout` /
// `clearTimeout` are faked: `Date` stays real, so a firing composed at `new Date()` would speak of a
// question opened years in its future. Verify-first: the texts below are what the built notifier
// posts (run first, then pinned).
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure (the posted texts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writtenSnapshot, type PendingGate, type RunRecord } from '@sensigo/realm';
import { startGateReminderTimers } from './slack-gate-notifier.js';
import { slackResponse } from '../test-support/slack-response.js';

const OPENED = '2033-01-01T00:00:00.000Z';
const at = (minutes: number): string =>
  new Date(Date.parse(OPENED) + minutes * 60_000).toISOString();

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

describe('#715 (b) Amendment 12 (c) — a late firing speaks at its scheduled instant', () => {
  it('the authored reminders (k = 1, 2) and the final expiry reminder, and the escalation: each text is judged at its own scheduled instant', async () => {
    // (a) red when a firing is composed at the host's clock (`now = new Date()` in reminderFiring, or
    //     the escalation's): its words then speak of a 2033 question from 2026; (b) prints the texts.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    const clear = startGateReminderTimers(
      'xoxb-test',
      'C123',
      '1234567890.000',
      opened,
      999_999_999,
      15 * 60_000,
    );
    await vi.advanceTimersByTimeAsync(31 * 60_000);
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
});
