// clock.test.ts — issue #715 (a) Part A.1 (D5 §1.1, D6-6, D6-7): `systemClock`, `createSystemClock`.
// This file builds no store, so fake timers are allowed in it (D6-24's file rule). Each cell names
// (a) the change that turns it red and (b) what it prints when it fails: instants, a message, never an
// environment.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSystemClock, MAX_HOP_MS, systemClock } from './clock.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('#715 (a) A.1 — the system clock', () => {
  it('A1 systemClock.now() returns a new Date each call', () => {
    // (a) red when now() returns a shared object; (b) prints the two ISO strings.
    const first = systemClock.now();
    const before = first.toISOString();
    first.setTime(0);
    const second = systemClock.now();
    expect(first, 'the first reading is a Date').toBeInstanceOf(Date);
    expect(second, 'the second reading is a Date').toBeInstanceOf(Date);
    expect(second.toISOString(), `first was ${before}, mutated to ${first.toISOString()}`).not.toBe(
      first.toISOString(),
    );
    expect(second.getTime(), `second is ${second.toISOString()}`).toBeGreaterThanOrEqual(
      Date.parse(before),
    );
  });

  it('A2 a waiter re-arms in hops of at most 60 s and notices a forward wall step within one hop', () => {
    // (a) red when the hops are not capped at 60 s (first half), or when the clock arms one timer for
    // the whole remaining time (the wall-step half); (b) prints the fake-time instants it ran at.
    vi.useFakeTimers();
    const start = new Date('2030-01-01T00:00:00.000Z').getTime();
    vi.setSystemTime(start);
    const clock = createSystemClock({ onWaiterError: () => {} });
    const ranAt: string[] = [];
    clock.at(new Date(start + 150_000), () => {
      ranAt.push(new Date().toISOString());
    });
    vi.advanceTimersByTime(60_000);
    expect(ranAt, 'not yet at +60 s').toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(ranAt, 'not yet at +120 s').toEqual([]);
    vi.advanceTimersByTime(30_000);
    expect(ranAt, 'ran at +150 s').toEqual([new Date(start + 150_000).toISOString()]);

    // The wall-step half.
    const ranAfterStep: string[] = [];
    const t0 = Date.now();
    clock.at(new Date(t0 + 150_000), () => {
      ranAfterStep.push(new Date().toISOString());
    });
    vi.advanceTimersByTime(60_000);
    expect(ranAfterStep, 'not yet after the first hop').toEqual([]);
    vi.setSystemTime(Date.now() + 200_000);
    vi.advanceTimersByTime(60_000);
    expect(ranAfterStep.length, `ran at ${JSON.stringify(ranAfterStep)}`).toBe(1);
    expect(MAX_HOP_MS).toBe(60_000);
  });

  it('A3 a past `when` fires on the next tick; cancel before it fires stops it; cancel after is harmless', () => {
    // (a) red when a past `when` waits a hop, or cancel does not clear; (b) prints which waiter ran.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const clock = createSystemClock({ onWaiterError: () => {} });
    const ran: string[] = [];
    clock.at(new Date(Date.now() - 1_000), () => {
      ran.push('past');
    });
    const cancel = clock.at(new Date(Date.now() - 1_000), () => {
      ran.push('cancelled');
    });
    cancel();
    vi.advanceTimersByTime(1);
    expect(ran, `ran: ${ran.join(',')}`).toEqual(['past']);
    const cancelAfter = clock.at(new Date(Date.now()), () => {
      ran.push('then-cancelled');
    });
    vi.advanceTimersByTime(1);
    expect(() => cancelAfter(), 'cancel after the run').not.toThrow();
    expect(ran, `ran: ${ran.join(',')}`).toEqual(['past', 'then-cancelled']);
  });

  it('A3b a `when` that is not a valid Date is refused at registration (it could never be reached)', () => {
    // (a) red when an invalid `when` is accepted (it would re-arm a zero-length timer forever);
    // (b) prints the message.
    const clock = createSystemClock({ onWaiterError: () => {} });
    expect(() => clock.at(new Date(Number.NaN), () => {})).toThrow(/valid Date/);
  });

  it('A4 a waiter that rejects or throws reaches the sink once, never as an unhandled rejection; a throwing sink is swallowed', async () => {
    // (a) red when the rejection is left unhandled; (b) prints the error's message only.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const sunk: unknown[] = [];
      const clock = createSystemClock({ onWaiterError: (err) => sunk.push(err) });
      const rejected = new Error('waiter rejected');
      const thrown = new Error('waiter threw');
      clock.at(new Date(Date.now() - 1), () => Promise.reject(rejected));
      clock.at(new Date(Date.now() - 1), () => {
        throw thrown;
      });
      const throwingSink = createSystemClock({
        onWaiterError: () => {
          throw new Error('sink threw');
        },
      });
      throwingSink.at(new Date(Date.now() - 1), () => {
        throw new Error('to a throwing sink');
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        sunk.map((e) => (e as Error).message),
        'the sink got each error once',
      ).toEqual(['waiter rejected', 'waiter threw']);
      expect(
        unhandled.map((e) => (e as Error).message),
        'no unhandled rejection',
      ).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('A5 the waiter timer is unref’d', () => {
    // (a) red when the timer keeps the process alive.
    const unref = vi.fn();
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      const handle = real(fn, ms);
      clearTimeout(handle);
      return { unref } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clock = createSystemClock({ onWaiterError: () => {} });
    clock.at(new Date(Date.now() + 10_000), () => {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('A6 systemClock.at throws a message naming createSystemClock and onWaiterError', () => {
    // (a) red when it silently registers or returns a no-op cancel; (b) prints the message.
    let message = '';
    try {
      systemClock.at(new Date(), () => {});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message, `the message: ${message}`).toMatch(/createSystemClock/);
    expect(message, `the message: ${message}`).toMatch(/onWaiterError/);
  });
});
