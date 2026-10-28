// clock.ts — issue #715 (a) (D5 §1.1, D6-6, D6-7, D6-8, D6-45): the clock a run store holds. A
// store reads the time ONLY through its clock, once per write (`takeReading`,
// `store/take-reading.ts`). `createSystemClock` is the one place in core that reads the wall clock
// for a store; a test clock (`@sensigo/realm-testing`'s `settableClock`, a test location's file
// clock) is another `Clock`.

/**
 * The time a run store holds (D5 §1.1).
 *
 * `now()` returns the current instant as a FRESH `Date` on every call: mutating a returned `Date`
 * changes nothing else.
 *
 * `at(when, fn)` runs `fn` once when the clock reaches `when` and returns a cancel; after the cancel
 * `fn` never runs. A `when` already past runs at the next opportunity (on a system clock the next
 * tick; on a test clock the next `advance`). Its scope (D6-8, D6-45): it serves waits for an instant
 * STORED on a record or derived from stored fields alone (an expiry; reminder occurrence
 * k = `opened_at + k·R`). It never drives the default ceiling (`gate_unanswered` is a fact derived at
 * read, with no writer and no timer) and never replaces a poll or a duration timer: those stay on
 * real timers.
 */
export interface Clock {
  /** The current instant. Returns a FRESH Date on every call: mutating a returned Date changes nothing else. */
  now(): Date;
  /** Runs fn ONCE when the clock reaches `when`; returns a cancel. A `when` already past runs at the next opportunity. */
  at(when: Date, fn: () => void | Promise<void>): () => void;
}

/**
 * The longest single timer a system clock's waiter arms (D6-7). When the timer fires the clock
 * re-reads `now()` and re-arms if `when` is not reached yet, so a forward wall-clock step is noticed
 * within one hop: Node timers run on monotonic loop time, and this re-check is the only way a wall
 * step reaches a waiter.
 */
export const MAX_HOP_MS = 60_000;

/**
 * Builds a system clock (D6-6, D6-7): `now()` is `new Date()`; `at()` arms an `unref`'d timer of at
 * most {@link MAX_HOP_MS} and re-checks `now()` each time it fires. A waiter's synchronous throw or
 * rejection is caught and passed to `options.onWaiterError` — never an unhandled rejection. The sink
 * must not throw; if it does, that throw is swallowed. Core never writes to `console` here: the sink
 * is the only channel.
 */
export function createSystemClock(options: { onWaiterError: (err: unknown) => void }): Clock {
  const report = (err: unknown): void => {
    try {
      options.onWaiterError(err);
    } catch {
      // A sink must not throw (its doc says so); a throw from it is swallowed here.
    }
  };
  return {
    now: (): Date => new Date(),
    at(when: Date, fn: () => void | Promise<void>): () => void {
      const whenMs = when instanceof Date ? when.getTime() : Number.NaN;
      if (!Number.isFinite(whenMs)) {
        // A `when` that is not a valid Date can never be reached: re-checking it would re-arm a
        // zero-length timer forever.
        throw new Error('Clock.at needs a valid Date for `when`');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const run = (): void => {
        done = true;
        try {
          const out = fn();
          if (out !== undefined && typeof (out as PromiseLike<void>).then === 'function') {
            Promise.resolve(out).catch(report);
          }
        } catch (err) {
          report(err);
        }
      };
      const tick = (): void => {
        timer = undefined;
        if (done) return;
        if (new Date().getTime() >= whenMs) run();
        else arm();
      };
      const arm = (): void => {
        const remaining = Math.max(0, whenMs - new Date().getTime());
        timer = setTimeout(tick, Math.min(remaining, MAX_HOP_MS));
        timer.unref?.();
      };
      arm();
      return (): void => {
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };
    },
  };
}

/**
 * The shared system clock a store uses when nothing else is said (a `JsonFileStore` on an ordinary
 * directory, an `InMemoryStore` built without a clock). `now()` is `new Date()`. `at()` THROWS: this
 * clock has no error sink, and a waiter whose failure is silently swallowed is what D6-6 exists to
 * prevent — a waiter needs a clock built with `createSystemClock({ onWaiterError })`.
 */
export const systemClock: Clock = {
  now: (): Date => new Date(),
  at(): () => void {
    throw new Error(
      'systemClock.at cannot run a waiter: a waiter needs a clock built with createSystemClock({ onWaiterError }), so its failures reach a host channel',
    );
  },
};
