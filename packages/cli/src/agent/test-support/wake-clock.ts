// Test support (#964): a settable clock that can rehearse a machine waking from sleep. After a sleep
// the store's system clock delivers every instant that came due together, each waiter reading the
// same instant (the wake); `settableClock.advance` instead fires due waiters one at a time, each at
// its own instant. `wake(t)` pins `now()` to `t` while the inner clock moves there, so the waiters
// due by `t` run in their order and each reads `t`. `set(t)` moves as on time. It also counts the
// waiters registered and not yet fired or cancelled. Not shipped.
import { settableClock, type SettableClock } from '@sensigo/realm-testing';
import type { Clock } from '@sensigo/realm';

export interface WakeClock extends Clock {
  /** Moves to `t` as after a sleep: every waiter due by `t` runs, in order, each reading `t`. */
  wake(t: Date): Promise<void>;
  /** Moves to `t` as on time: every waiter due by `t` runs at its own instant. */
  set(t: Date): Promise<void>;
  /** The waiters registered and neither run nor cancelled. */
  waiting(): number;
}

export function wakeClock(start: Date): WakeClock {
  const inner: SettableClock = settableClock(start);
  let pinned: number | undefined;
  let waiting = 0;
  return {
    now: (): Date => (pinned !== undefined ? new Date(pinned) : inner.now()),
    at(when: Date, fn: () => void | Promise<void>): () => void {
      let open = true;
      waiting += 1;
      const close = (): void => {
        if (open) waiting -= 1;
        open = false;
      };
      const cancel = inner.at(when, () => {
        close();
        return fn();
      });
      return (): void => {
        close();
        cancel();
      };
    },
    async wake(t: Date): Promise<void> {
      pinned = t.getTime();
      try {
        await inner.set(t);
      } finally {
        pinned = undefined;
      }
    },
    set: (t: Date): Promise<void> => inner.set(t),
    waiting: (): number => waiting,
  };
}
