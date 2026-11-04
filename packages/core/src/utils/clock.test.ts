// clock.test.ts — issue #715 (a) Part A.1 (D5 §1.1, D6-6, D6-7): `systemClock`, `createSystemClock`.
// This file builds no store, so fake timers are allowed in it (D6-24's file rule). Each cell names
// (a) the change that turns it red and (b) what it prints when it fails: instants, a message, never an
// environment.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clockErrorSink,
  createSystemClock,
  MAX_HOP_MS,
  resetClockErrorSinkForTest,
  setClockErrorSink,
  systemClock,
} from './clock.js';

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

  it('A6 #715 (b) 03 §A.1: systemClock.at runs a waiter (it no longer throws), once, at its instant', () => {
    // (a) red when systemClock.at throws or runs the waiter before its instant or twice; (b) prints
    // the fake-time instants it ran at.
    vi.useFakeTimers();
    const start = new Date('2030-01-01T00:00:00.000Z').getTime();
    vi.setSystemTime(start);
    const ranAt: string[] = [];
    systemClock.at(new Date(start + 90_000), () => {
      ranAt.push(new Date().toISOString());
    });
    vi.advanceTimersByTime(60_000);
    expect(ranAt, 'not yet at +60 s').toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(ranAt, `ran at ${JSON.stringify(ranAt)}`).toEqual([
      new Date(start + 90_000).toISOString(),
    ]);
  });
});

describe('#715 (b) 03 §A.1 (D-22) — the process’s waiter-error sink', () => {
  let previous: ((err: unknown) => void) | undefined;
  beforeEach(() => {
    previous = clockErrorSink();
  });
  afterEach(() => {
    if (previous !== undefined) setClockErrorSink(previous);
    else resetClockErrorSinkForTest();
  });

  it('S1 a waiter that throws, one that rejects, one that returns a rejected promise — each reaches the sink set at FIRE time, once, never unhandled', async () => {
    // (a) red when the sink is read at registration (the waiters were registered before it was
    //     set), when an error is lost, or when one reaches the sink twice or as an unhandled
    //     rejection; (b) prints the messages the sink got and the unhandled ones.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      resetClockErrorSinkForTest();
      systemClock.at(new Date(Date.now() - 1), () => {
        throw new Error('threw');
      });
      systemClock.at(new Date(Date.now() - 1), async () => {
        throw new Error('rejected');
      });
      systemClock.at(new Date(Date.now() - 1), () =>
        Promise.reject(new Error('returned a rejection')),
      );
      const sunk: string[] = [];
      setClockErrorSink((err) => sunk.push((err as Error).message));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect({
        sunk: [...sunk].sort(),
        unhandled: unhandled.map((e) => (e as Error).message),
      }).toEqual({
        sunk: ['rejected', 'returned a rejection', 'threw'],
        unhandled: [],
      });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('S2 with no sink set, a waiter’s failure is re-thrown from a microtask — loud, never swallowed', async () => {
    // (a) red when the no-sink path swallows the error (`catch {}`) or writes it to the console; (b)
    //     prints what the microtask threw (or that nothing was thrown).
    resetClockErrorSinkForTest();
    const thrown: unknown[] = [];
    const real = globalThis.queueMicrotask;
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb: () => void) => {
      real(() => {
        try {
          cb();
        } catch (err) {
          thrown.push(err);
        }
      });
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    systemClock.at(new Date(Date.now() - 1), () => {
      throw new Error('no sink: loud');
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect({
      thrown: thrown.map((e) => (e as Error).message),
      microtasks: spy.mock.calls.length > 0,
      console: consoleError.mock.calls.length,
    }).toEqual({ thrown: ['no sink: loud'], microtasks: true, console: 0 });
  });

  it('S3 a sink that throws is swallowed: the next waiter’s failure still reaches it', async () => {
    // (a) red when a throwing sink escapes (an uncaught exception) or stops later reports; (b) prints
    //     the reports the sink saw and the uncaught errors.
    const uncaught: string[] = [];
    const onUncaught = (err: unknown): void => {
      uncaught.push((err as Error).message);
    };
    process.on('uncaughtException', onUncaught);
    try {
      const seen: string[] = [];
      setClockErrorSink((err) => {
        seen.push((err as Error).message);
        throw new Error('sink threw');
      });
      systemClock.at(new Date(Date.now() - 1), () => {
        throw new Error('first');
      });
      systemClock.at(new Date(Date.now() - 1), () => {
        throw new Error('second');
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect({ seen: [...seen].sort(), uncaught }).toEqual({
        seen: ['first', 'second'],
        uncaught: [],
      });
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});
