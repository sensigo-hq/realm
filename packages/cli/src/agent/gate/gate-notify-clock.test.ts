// gate-notify-clock.test.ts — issue #291, Deliverable 6: the authored notify clock — repeating
// reminders, record-keyed precedence, the final-occurrence wording switch, and the
// dead-notification advisory.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startGateReminderTimers, checkDeadNotificationAdvisory } from './slack-gate-notifier.js';
import type { PendingGate } from '@sensigo/realm';

function makeGate(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    gate_id: 'gate-1',
    step_name: 'review_step',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('startGateReminderTimers — the authored notify clock (issue #291)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubFetch(): string[] {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { text: string };
        calls.push(body.text);
        return Promise.resolve({ json: async () => ({ ok: true }) });
      }),
    );
    return calls;
  }

  it('an authored reminder_seconds REPEATS up to reminder_max occurrences, ignoring operator config entirely [F-A2-2 precedence]', async () => {
    vi.useFakeTimers();
    const calls = stubFetch();
    const gate = makeGate({ reminder_seconds: 1, reminder_max: 3 }); // 1s authored, no expiry
    const clear = startGateReminderTimers(
      'xoxb-test',
      'C123',
      '111.000',
      gate,
      999_999_000, // operator config — must be IGNORED (record-keyed precedence)
      999_999_000,
    );

    await vi.advanceTimersByTimeAsync(1000); // occurrence 1
    await vi.advanceTimersByTimeAsync(1000); // occurrence 2
    await vi.advanceTimersByTimeAsync(1000); // occurrence 3 (== reminder_max, last one)
    await vi.advanceTimersByTimeAsync(1000); // would be occurrence 4 — must NOT fire
    clear();

    const reminderCalls = calls.filter((c) => c.includes('Reminder'));
    expect(reminderCalls.length).toBe(3);
  });

  it('the FINAL occurrence (landing at/after expires_at) switches to the enforcement wording — settle_default', async () => {
    vi.useFakeTimers();
    const calls = stubFetch();
    const gate = makeGate({
      reminder_seconds: 1,
      reminder_max: 10,
      expires_at: new Date(Date.now() + 1500).toISOString(),
      on_expiry: 'settle_default',
    });
    const clear = startGateReminderTimers(
      'xoxb-test',
      'C123',
      '111.000',
      gate,
      999_999_000,
      999_999_000,
    );

    // t=1000: occurrence 1, plain (next-fire was computed at t=0 as 1000ms, < 1500ms expiry).
    await vi.advanceTimersByTimeAsync(1000);
    // t=2000: occurrence 2 — its OWN next-fire was computed at t=1000 as 2000ms, >= 1500ms
    // expiry ⇒ FINAL.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(5000); // nothing further should fire (cycle stopped at final)
    clear();

    expect(calls.filter((c) => c.includes('Reminder') && !c.includes('will enact')).length).toBe(1);
    const finalCalls = calls.filter((c) => c.includes('will enact settle_default'));
    expect(finalCalls.length).toBe(1);
    expect(finalCalls[0]).toContain('realm run drain --expired');
  });

  it('the FINAL occurrence for an abort disposition names "will enact abort"', async () => {
    vi.useFakeTimers();
    const calls = stubFetch();
    const gate = makeGate({
      reminder_seconds: 1,
      reminder_max: 10,
      expires_at: new Date(Date.now() + 500).toISOString(),
      on_expiry: 'abort',
    });
    const clear = startGateReminderTimers(
      'xoxb-test',
      'C123',
      '111.000',
      gate,
      999_999_000,
      999_999_000,
    );
    await vi.advanceTimersByTimeAsync(1000); // first (and only) occurrence is already >= expiry
    clear();
    expect(calls.some((c) => c.includes('will enact abort'))).toBe(true);
  });

  it('finding-only (no on_expiry) FINAL occurrence never claims "will enact"', async () => {
    vi.useFakeTimers();
    const calls = stubFetch();
    const gate = makeGate({
      reminder_seconds: 1,
      reminder_max: 10,
      expires_at: new Date(Date.now() + 500).toISOString(),
      // on_expiry deliberately absent
    });
    const clear = startGateReminderTimers(
      'xoxb-test',
      'C123',
      '111.000',
      gate,
      999_999_000,
      999_999_000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    clear();
    expect(calls.some((c) => c.includes('will enact'))).toBe(false);
    expect(calls.some((c) => c.includes('finding-only'))).toBe(true);
  });

  it('a PURE-notify gate (reminder_seconds, no expires_at) repeats plainly, bounded ONLY by reminder_max', async () => {
    vi.useFakeTimers();
    const calls = stubFetch();
    const gate = makeGate({ reminder_seconds: 1, reminder_max: 2 }); // no expires_at at all
    const clear = startGateReminderTimers(
      'xoxb-test',
      'C123',
      '111.000',
      gate,
      999_999_000,
      999_999_000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000); // would be 3rd — must not fire
    clear();
    expect(calls.filter((c) => c.includes('Reminder')).length).toBe(2);
    expect(calls.some((c) => c.includes('will enact') || c.includes('finding-only'))).toBe(false);
  });

  it('NO authored reminder_seconds: the operator fallback stays SINGLE-SHOT — unchanged from pre-#291 [F-A2-3]', async () => {
    vi.useFakeTimers();
    const calls = stubFetch();
    const gate = makeGate(); // no reminder_seconds at all
    const clear = startGateReminderTimers('xoxb-test', 'C123', '111.000', gate, 500, 999_999_000);
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(600); // would be a 2nd occurrence under the old bug — must not fire
    clear();
    expect(calls.filter((c) => c.includes('Reminder')).length).toBe(1);
  });

  it('cancelling via the returned function stops the repeat cycle mid-flight', async () => {
    vi.useFakeTimers();
    const calls = stubFetch();
    const gate = makeGate({ reminder_seconds: 1, reminder_max: 10 });
    const clear = startGateReminderTimers(
      'xoxb-test',
      'C123',
      '111.000',
      gate,
      999_999_000,
      999_999_000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    clear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.filter((c) => c.includes('Reminder')).length).toBe(1);
  });
});

describe('checkDeadNotificationAdvisory (issue #291)', () => {
  it('warns when the operator reminder interval would never fire before the frozen expiry', () => {
    const gate = makeGate({
      expires_at: new Date(Date.parse(makeGate().opened_at) + 60_000).toISOString(),
    });
    const advisory = checkDeadNotificationAdvisory(gate, 120_000, 999_999_000);
    expect(advisory).toBeDefined();
    expect(advisory).toContain('reminder');
  });

  it('warns when the operator escalation threshold would never fire before the frozen expiry', () => {
    const gate = makeGate({
      expires_at: new Date(Date.parse(makeGate().opened_at) + 60_000).toISOString(),
    });
    const advisory = checkDeadNotificationAdvisory(gate, 1000, 120_000);
    expect(advisory).toBeDefined();
    expect(advisory).toContain('escalation');
  });

  it('no advisory when both operator timers comfortably precede expiry', () => {
    const gate = makeGate({
      expires_at: new Date(Date.parse(makeGate().opened_at) + 600_000).toISOString(),
    });
    expect(checkDeadNotificationAdvisory(gate, 1000, 2000)).toBeUndefined();
  });

  it("no advisory when an AUTHORED reminder_seconds is present — that case is the loader's own [Amendment 2] check, not this one", () => {
    const gate = makeGate({
      reminder_seconds: 999_999,
      expires_at: new Date(Date.parse(makeGate().opened_at) + 60_000).toISOString(),
    });
    expect(checkDeadNotificationAdvisory(gate, 1000, 1000)).toBeUndefined();
  });

  it('no advisory when the gate has no frozen expires_at at all (nothing to be dead against)', () => {
    const gate = makeGate();
    expect(checkDeadNotificationAdvisory(gate, 999_999_000, 999_999_000)).toBeUndefined();
  });
});
