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
 * #715 (b) (04 §A.4, B5′, D6-32): the five classes of a clock read — what a run store's clock governs
 * (`write`, `read`, `event`) and what it does not (`outside`, `duration`). The clock census test
 * classes every read in the source by them, and the docs table of what the clock governs is generated
 * from them (`docs/reference/core-library.md`).
 */
export const CLOCK_READ_CLASSES = {
  write:
    "An instant a write records on the run (`updated_at`, a claim's deadline, an opened question's `opened_at`): the store's reading, taken once inside the write.",
  read: "The instant every statement about a record a read returns is judged at (`as_of`): the store's reading, taken before the load.",
  event:
    "An instant the engine records with what happened (a step's start and end, a drive failure, a guard's evidence): the store's clock, read where it happens.",
  outside:
    "An instant compared with nothing on a run (a log line, a signature window, `Retry-After`, a price day): the host's clock, each read named in the census with its reason.",
  duration:
    'A duration (elapsed time, a budget, a timeout): the monotonic clock, never compared with an instant.',
} as const;

/** #715 (b): one of {@link CLOCK_READ_CLASSES}. */
export type ClockReadClass = keyof typeof CLOCK_READ_CLASSES;

/**
 * The longest single timer a system clock's waiter arms (D6-7). When the timer fires the clock
 * re-reads `now()` and re-arms if `when` is not reached yet, so a forward wall-clock step is noticed
 * within one hop: Node timers run on monotonic loop time, and this re-check is the only way a wall
 * step reaches a waiter.
 */
export const MAX_HOP_MS = 60_000;

/**
 * #715 (b) (03 §A.1, D-22): the process's waiter-error sink — set ONCE by a host at its start
 * (`setClockErrorSink`), read when a waiter FAILS, never when it is registered. The CLI sets it before
 * it parses its arguments (`installClockErrorSink`), the `realm-mcp` bin in its run-directly block; a
 * library embedding core sets none.
 */
let processSink: ((err: unknown) => void) | undefined;

/**
 * #715 (b) (03 §A.1, D-22): sets the process's waiter-error sink — the channel the shared
 * {@link systemClock} (and a test location's clock) passes a failing waiter's error to. A host calls
 * it once, at its start. The sink must not throw; a throw from it is swallowed.
 */
export function setClockErrorSink(sink: (err: unknown) => void): void {
  processSink = sink;
}

/** #715 (b) (03 §A.1): the process's waiter-error sink, or `undefined` when no host set one. For tests. */
export function clockErrorSink(): ((err: unknown) => void) | undefined {
  return processSink;
}

/** #715 (b) (03 §A.1): un-sets the process's sink — for core's own tests (not exported from core). */
export function resetClockErrorSinkForTest(): void {
  processSink = undefined;
}

/**
 * #715 (b) (03 §A.1, D-22): passes a failing waiter's error to the process's sink, read NOW (at the
 * failure). No sink set ⇒ the error is re-thrown from a microtask: loud (an uncaught exception), never
 * swallowed, never written to `console` by core. A sink that throws is swallowed. Private to core.
 */
export function reportWaiterError(err: unknown): void {
  const sink = processSink;
  if (sink === undefined) {
    queueMicrotask(() => {
      throw err;
    });
    return;
  }
  try {
    sink(err);
  } catch {
    // A sink must not throw (its doc says so); a throw from it is swallowed here.
  }
}

/** A system clock whose waiters' failures go to `report` (which must not throw). */
function systemClockReportingTo(report: (err: unknown) => void): Clock {
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
 * Builds a system clock (D6-6, D6-7) with its OWN waiter-error sink: `now()` is `new Date()`; `at()`
 * arms an `unref`'d timer of at most {@link MAX_HOP_MS} and re-checks `now()` each time it fires. A
 * waiter's synchronous throw or rejection is caught and passed to `options.onWaiterError` — never an
 * unhandled rejection. The sink must not throw; if it does, that throw is swallowed. Core never
 * writes to `console` here: the sink is the only channel. For a host or a test that wants its own
 * sink; the shared {@link systemClock} uses the process's ({@link setClockErrorSink}).
 */
export function createSystemClock(options: { onWaiterError: (err: unknown) => void }): Clock {
  return systemClockReportingTo((err: unknown): void => {
    try {
      options.onWaiterError(err);
    } catch {
      // A sink must not throw (its doc says so); a throw from it is swallowed here.
    }
  });
}

/**
 * The shared system clock a store uses when nothing else is said (a `JsonFileStore` on an ordinary
 * directory, an `InMemoryStore` built without a clock). `now()` is `new Date()`; `at()` works as
 * {@link createSystemClock}'s does (D6-7), and a waiter's failure goes to the process's sink, read
 * when the waiter fails ({@link setClockErrorSink}); with no sink set it is re-thrown from a
 * microtask — loud, never swallowed (03 §A.1, D-22).
 */
export const systemClock: Clock = systemClockReportingTo(reportWaiterError);

/**
 * #715 (b) (02 §C.1, D-24, D6-53): every TEST clock, private to core — a `WeakSet`, so a clock is
 * marked by identity and nothing on the clock object says so. `@sensigo/realm-testing`'s
 * `settableClock` and `steppingClock` mark theirs, a test location's clock is marked where it is
 * built, and `countingClock(inner)` marks its result iff `inner` is marked. A host-built clock
 * (a plain `{ now, at }` object, a realm-cloud port's) is never marked.
 */
const TEST_CLOCKS = new WeakSet<Clock>();

/** #715 (b) (02 §C.1): marks `clock` as a test clock; returns it. For `@sensigo/realm-testing`. */
export function markTestClock<C extends Clock>(clock: C): C {
  TEST_CLOCKS.add(clock);
  return clock;
}

/**
 * #715 (b) (02 §C.1, D6-59): what a reply's instant stands on — `'test_clock'` for a marked test
 * clock, `undefined` for every other clock, a host-built one included. A reply carries it as
 * `as_of_basis` (absent ⇒ the store's ordinary clock).
 */
export function clockBasis(clock: Clock): 'test_clock' | undefined {
  return TEST_CLOCKS.has(clock) ? 'test_clock' : undefined;
}
