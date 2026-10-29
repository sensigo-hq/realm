// settable-clock.ts — issue #715 (a) (D5 §6, D6-20): a test clock that only moves when the test moves
// it, and runs the waiters registered on it as it moves.
import type { Clock } from '@sensigo/realm';

// Captured at MODULE LOAD, so a test's fake timers cannot freeze the watchdog (D6-20).
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** A test clock moved by `set` and `advance`, which run its due waiters (D5 §6, D6-20). */
export interface SettableClock extends Clock {
  /**
   * Moves the clock to `t`. Forward (`t ≥ now()`): the same as `advance(t − now())`. Backward: runs
   * NOTHING and moves the clock back — the only way back; waiters that were pending stay pending.
   */
  set(t: Date): Promise<void>;
  /**
   * Moves the clock forward by `ms` (`ms < 0` throws a `RangeError`), running every waiter whose
   * `when` is at or before the target, ONE AT A TIME in order of (`when`, registration order). While
   * a waiter runs, `now()` is `max(its when, the clock's instant)` — never backward — and the clock
   * awaits the waiter's returned promise before the next. A waiter that registers another due by the
   * target has it run in the same advance. A nested `advance` (called while one runs) throws. A
   * waiter's throw or rejection is collected and the rest still run; `now()` ends at the target, and
   * then `advance` rejects with the one error, or an `AggregateError` of several.
   */
  advance(ms: number): Promise<void>;
}

export interface SettableClockOptions {
  /** A real-time watchdog per awaited waiter, in milliseconds (default 5,000). */
  waiterTimeoutMs?: number;
  /** The most waiter runs one `advance` makes before it ends with an error (default 10,000). */
  maxFiresPerAdvance?: number;
}

/** Where a settable clock keeps its instant: in memory, or in a test location's file. */
export interface InstantStore {
  read(): number;
  write(ms: number): Promise<void> | void;
}

interface Waiter {
  readonly when: number;
  readonly index: number;
  readonly fn: () => void | Promise<void>;
}

/** The error a waiter that never settles ends its `advance` with (D6-20). */
class WaiterTimeoutError extends Error {
  constructor(
    readonly when: string,
    readonly index: number,
    timeoutMs: number,
  ) {
    super(
      `the waiter registered #${index} for ${when} did not settle within ${timeoutMs} ms of real time`,
    );
    this.name = 'WaiterTimeoutError';
  }
}

function toMs(t: Date | string): number {
  const ms = t instanceof Date ? t.getTime() : Date.parse(t);
  if (!Number.isFinite(ms)) throw new RangeError('a test clock needs a valid instant');
  return ms;
}

/** Builds a settable clock over `store` (shared by `settableClock` and `createTestLocation`). */
export function settableClockOver(
  store: InstantStore,
  options: SettableClockOptions = {},
): SettableClock {
  const waiterTimeoutMs = options.waiterTimeoutMs ?? 5_000;
  const maxFires = options.maxFiresPerAdvance ?? 10_000;
  const waiters: Waiter[] = [];
  let registered = 0;
  let advancing = false;

  const nextDue = (target: number): Waiter | undefined => {
    let best: Waiter | undefined;
    for (const w of waiters) {
      if (w.when > target) continue;
      if (
        best === undefined ||
        w.when < best.when ||
        (w.when === best.when && w.index < best.index)
      )
        best = w;
    }
    return best;
  };

  const settle = async (w: Waiter, out: PromiseLike<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = realSetTimeout(
        () =>
          reject(new WaiterTimeoutError(new Date(w.when).toISOString(), w.index, waiterTimeoutMs)),
        waiterTimeoutMs,
      );
    });
    try {
      await Promise.race([Promise.resolve(out), watchdog]);
    } finally {
      realClearTimeout(timer);
    }
  };

  const clock: SettableClock = {
    now: (): Date => new Date(store.read()),
    at(when: Date, fn: () => void | Promise<void>): () => void {
      const waiter: Waiter = { when: toMs(when), index: registered++, fn };
      waiters.push(waiter);
      return (): void => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
      };
    },
    async advance(ms: number): Promise<void> {
      if (!(ms >= 0)) throw new RangeError(`advance needs a duration of 0 ms or more, not ${ms}`);
      if (advancing) throw new Error('advance was called while another advance is running');
      advancing = true;
      const errors: unknown[] = [];
      try {
        const target = store.read() + ms;
        let fires = 0;
        for (let w = nextDue(target); w !== undefined; w = nextDue(target)) {
          if (fires >= maxFires) {
            errors.push(
              new Error(
                `advance ran ${maxFires} waiters and stopped: a waiter keeps registering another at or before the target`,
              ),
            );
            break;
          }
          fires += 1;
          waiters.splice(waiters.indexOf(w), 1);
          await store.write(Math.max(w.when, store.read()));
          try {
            const out = w.fn();
            if (out !== undefined && typeof (out as PromiseLike<void>).then === 'function') {
              await settle(w, out);
            }
          } catch (err) {
            errors.push(err);
          }
        }
        await store.write(target);
      } finally {
        advancing = false;
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, `${errors.length} waiters failed during advance`);
    },
    async set(t: Date): Promise<void> {
      const to = toMs(t);
      const from = store.read();
      if (to >= from) return clock.advance(to - from);
      await store.write(to);
    },
  };
  return clock;
}

/**
 * A settable test clock starting at `start` (D5 §6, D6-20). `now()` returns the current instant as a
 * fresh `Date` and never fires a waiter. `at(when, fn)` registers a waiter and returns its cancel; a
 * waiter whose `when` has passed runs at the NEXT `advance`/`set`, not at once (a test clock has no
 * ticks). See {@link SettableClock} for how `advance` and `set` run waiters. A real-time watchdog of
 * `waiterTimeoutMs` (default 5,000) per awaited waiter, on the `setTimeout` captured when this
 * module loaded (so a test's fake timers cannot freeze it), rejects naming the waiter's `when` and
 * registration index; `maxFiresPerAdvance` (default 10,000) ends an advance whose waiters keep
 * re-registering.
 */
export function settableClock(start: Date | string, options?: SettableClockOptions): SettableClock {
  let instant = toMs(start);
  return settableClockOver(
    {
      read: () => instant,
      write: (ms) => {
        instant = ms;
      },
    },
    options,
  );
}

/**
 * A clock whose k-th `now()` call (k from 0) returns `start + k·stepMs` (D6-20, D6-24); `reads`
 * counts the calls. `at()` throws: it never fires waiters, and never from inside `now()`.
 */
export function steppingClock(
  start: Date | string,
  stepMs: number,
): Clock & { readonly reads: number } {
  const base = toMs(start);
  let reads = 0;
  return {
    now(): Date {
      const value = new Date(base + reads * stepMs);
      reads += 1;
      return value;
    },
    at(): () => void {
      throw new Error('steppingClock.at is unsupported');
    },
    get reads(): number {
      return reads;
    },
  };
}

/** Delegates to `inner` and counts its `now()` calls (D6-4: the TCK counts readings this way). */
export function countingClock(inner: Clock): Clock & { readonly reads: number } {
  let reads = 0;
  return {
    now(): Date {
      reads += 1;
      return inner.now();
    },
    at: (when, fn) => inner.at(when, fn),
    get reads(): number {
      return reads;
    },
  };
}
