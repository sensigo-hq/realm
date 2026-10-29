// settable-clock.test.ts — issue #715 (a) Part C.2 (D5 §6, D6-20, D6-24): `settableClock`,
// `steppingClock`, `countingClock`. This file builds no JSON store, so fake timers are allowed in it.
// Each cell names (a) the change that turns it red and (b) what it prints when it fails: the order
// log, instants, messages — never an environment.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countingClock, settableClock, steppingClock } from './settable-clock.js';

const T = Date.parse('2033-05-06T07:08:09.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
afterEach(() => {
  vi.useRealTimers();
});

describe('#715 (a) C.2 — settableClock', () => {
  it('C7 now() is the set instant, a fresh Date; advance runs due waiters in (when, registration) order, awaiting each, with now() never behind its when; a waiter registered during the advance runs in it', async () => {
    // (a) red when any of the four is dropped; (b) prints the order log.
    const clock = settableClock(new Date(T));
    const first = clock.now();
    first.setTime(0);
    expect(clock.now().toISOString(), 'a fresh Date at the set instant').toBe(iso(T));
    const log: string[] = [];
    clock.at(new Date(T + 2_000), () => {
      log.push(`b@${clock.now().toISOString()}`);
    });
    clock.at(new Date(T + 1_000), async () => {
      log.push(`a-start@${clock.now().toISOString()}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      log.push('a-end');
      clock.at(new Date(T + 1_500), () => {
        log.push(`nested@${clock.now().toISOString()}`);
      });
    });
    clock.at(new Date(T + 2_000), () => {
      log.push(`c@${clock.now().toISOString()}`);
    });
    clock.at(new Date(T + 10_000), () => {
      log.push('late');
    });
    await clock.advance(5_000);
    expect(log, log.join(' | ')).toEqual([
      `a-start@${iso(T + 1_000)}`,
      'a-end',
      `nested@${iso(T + 1_500)}`,
      `b@${iso(T + 2_000)}`,
      `c@${iso(T + 2_000)}`,
    ]);
    expect(clock.now().toISOString(), 'ends at the target').toBe(iso(T + 5_000));
  });

  it('C7b a waiter whose when is already past sees the clock’s instant, not its when (never backward)', async () => {
    // (a) red when now() inside a waiter goes back to its when; (b) prints the instant seen.
    const clock = settableClock(new Date(T));
    let seen = '';
    clock.at(new Date(T - 60_000), () => {
      seen = clock.now().toISOString();
    });
    await clock.advance(0);
    expect(seen, 'the instant the overdue waiter saw').toBe(iso(T));
  });

  it('C8 advance collects errors: the rest still run, now() reaches the target, then it rejects', async () => {
    // (a) red when the first error aborts the rest; (b) prints the messages.
    const clock = settableClock(new Date(T));
    const ran: string[] = [];
    clock.at(new Date(T + 1), () => {
      throw new Error('one');
    });
    clock.at(new Date(T + 2), () => {
      ran.push('fine');
    });
    clock.at(new Date(T + 3), () => Promise.reject(new Error('two')));
    let caught: unknown;
    await clock.advance(10).catch((err: unknown) => {
      caught = err;
    });
    expect(ran, 'the fine waiter ran').toEqual(['fine']);
    expect(clock.now().toISOString(), 'at the target').toBe(iso(T + 10));
    expect(caught, 'an AggregateError').toBeInstanceOf(AggregateError);
    expect(
      (caught as AggregateError).errors.map((e: Error) => e.message),
      'its errors',
    ).toEqual(['one', 'two']);

    const single = settableClock(new Date(T));
    const alone = new Error('alone');
    single.at(new Date(T + 1), () => {
      throw alone;
    });
    let caughtAlone: unknown;
    await single.advance(5).catch((err: unknown) => {
      caughtAlone = err;
    });
    expect(caughtAlone, `caught: ${String((caughtAlone as Error)?.message)}`).toBe(alone);
  });

  it('C9 set(later) runs waiters as advance does; set(earlier) runs none, moves back, and keeps them pending', async () => {
    // (a) red when set into the past runs or drops waiters; (b) prints the instants.
    const clock = settableClock(new Date(T));
    const ran: string[] = [];
    clock.at(new Date(T + 1_000), () => {
      ran.push(`one@${clock.now().toISOString()}`);
    });
    await clock.set(new Date(T + 2_000));
    expect(ran, 'set forward ran the due waiter').toEqual([`one@${iso(T + 1_000)}`]);
    clock.at(new Date(T + 1_500), () => {
      ran.push(`between@${clock.now().toISOString()}`);
    });
    await clock.set(new Date(T));
    expect(clock.now().toISOString(), 'moved back').toBe(iso(T));
    expect(ran.length, 'set back ran nothing').toBe(1);
    await clock.advance(1_500);
    expect(ran, 'the in-between waiter ran on the next forward advance').toEqual([
      `one@${iso(T + 1_000)}`,
      `between@${iso(T + 1_500)}`,
    ]);
  });

  it('C10 a nested advance throws; advance(−1) throws a RangeError', async () => {
    // (a) red when either passes.
    const clock = settableClock(new Date(T));
    clock.at(new Date(T + 1), () => clock.advance(1));
    const nested = await clock.advance(5).then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    expect(nested, 'the nested advance').toMatch(/another advance/);
    await expect(clock.advance(-1)).rejects.toBeInstanceOf(RangeError);
  });

  it('C11 the watchdog names a waiter that never settles, and still fires under fake timers', async () => {
    // (a) red when the watchdog uses the live globalThis.setTimeout; (b) prints the message.
    for (const fake of [false, true]) {
      if (fake) vi.useFakeTimers();
      const clock = settableClock(new Date(T), { waiterTimeoutMs: 30 });
      clock.at(new Date(T + 1_000), () => new Promise<void>(() => {}));
      let message = '';
      await clock.advance(2_000).catch((err: Error) => {
        message = err.message;
      });
      expect(message, `fake timers ${fake}: ${message}`).toContain(iso(T + 1_000));
      expect(message, `fake timers ${fake}: ${message}`).toContain('#0');
      vi.useRealTimers();
    }
  });

  it('C12 maxFiresPerAdvance ends an advance whose waiter keeps re-registering', async () => {
    // (a) red when this is an infinite loop; (b) prints the message.
    const clock = settableClock(new Date(T), { maxFiresPerAdvance: 3 });
    const again = (): void => {
      clock.at(new Date(T + 1), again);
    };
    clock.at(new Date(T + 1), again);
    let message = '';
    await clock.advance(10).catch((err: Error) => {
      message = err.message;
    });
    expect(message, message).toMatch(/ran 3 waiters/);
  });
});

describe('#715 (a) C.2 — steppingClock and countingClock', () => {
  it('C13 the k-th now() is start + k·step and `reads` counts; at() throws; countingClock delegates and counts', () => {
    // (a) red on an off-by-one, or when at() registers; (b) prints the values.
    const stepping = steppingClock(new Date(T), 250);
    const values = [stepping.now(), stepping.now(), stepping.now()].map((d) => d.toISOString());
    expect(values, values.join(', ')).toEqual([iso(T), iso(T + 250), iso(T + 500)]);
    expect(stepping.reads, 'reads').toBe(3);
    expect(() => stepping.at(new Date(T), () => {})).toThrow('steppingClock.at is unsupported');
    const inner = settableClock(new Date(T));
    const counting = countingClock(inner);
    expect(counting.now().toISOString(), 'delegates').toBe(iso(T));
    counting.now();
    expect(counting.reads, 'counts').toBe(2);
  });
});
