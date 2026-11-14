// lease-double.ts — issue #729, the claim window, unit CW-1: a lease port in memory, for the tests and
// laws that need a store with claim leases but no real lock. Its leases have the states a real lease
// can be in, and a test sets them:
//   - `live`: the program that holds it runs — a probe reads `held`;
//   - `closed_kept`: closed, its file kept (a claim named it, or the release returned no record) —
//     `not_held`;
//   - `removed`: closed and its file deleted (no claim named it) — `absent`;
//   - `dead`: the holding program ended without closing it — `not_held`;
//   - `{ forced: fact }`: whatever fact the test sets (an `unknown` with its reason, for example).
// An id it never made reads `absent`. It holds no lock and opens no file, so the laws about the lock
// itself (another process, the garbage collector, the file's mode) cannot run on it; the laws it can
// answer from its states are run in `lease-port-double.test.ts`.
import type { LeaseFact, LeaseHold, LeaseHoldResult, LeasePort, RunRecord } from '@sensigo/realm';

/** A lease's state in the double. */
export type LeaseDoubleState = 'live' | 'closed_kept' | 'removed' | 'dead' | { forced: LeaseFact };

/** A lease port in memory whose leases a test sets. */
export interface LeaseDouble extends LeasePort {
  /** The state of a lease the double made or a test set; `undefined` for an id it never saw. */
  state(id: string): LeaseDoubleState | undefined;
  /** Sets a lease's state (an id the double never made is added). */
  set(id: string, state: LeaseDoubleState): void;
}

const BASIS = 'kernel_lock';

function factOf(state: LeaseDoubleState | undefined): LeaseFact {
  if (state === undefined || state === 'removed') return { state: 'absent', basis: BASIS };
  if (state === 'live') return { state: 'held', basis: BASIS };
  if (state === 'closed_kept' || state === 'dead') return { state: 'not_held', basis: BASIS };
  return state.forced;
}

/** Whether a step's claim in `record` names the lease `id` (the SQLite store's rule for `close`). */
function namesLease(record: RunRecord, id: string): boolean {
  return Object.values(record.claims ?? {}).some((claim) => claim?.lease?.id === id);
}

/**
 * A lease port in memory. `hold()` makes a `live` lease with a fresh id (`lease-double-1`, …; an id is
 * never made twice); `close(record)` leaves it `removed` when no claim in the record names it and
 * `closed_kept` otherwise, or with no record; a second `close()` does nothing. `probe` answers from
 * the state, and never rejects.
 */
export function createLeaseDouble(): LeaseDouble {
  const states = new Map<string, LeaseDoubleState>();
  let minted = 0;
  return {
    hold(): Promise<LeaseHoldResult> {
      minted += 1;
      const id = `lease-double-${minted}`;
      states.set(id, 'live');
      let open = true;
      const held: LeaseHold = {
        id,
        close(newestRecord?: RunRecord): void {
          if (!open) return;
          open = false;
          states.set(
            id,
            newestRecord !== undefined && !namesLease(newestRecord, id) ? 'removed' : 'closed_kept',
          );
        },
      };
      return Promise.resolve({ held });
    },
    probe(id: string): Promise<LeaseFact> {
      return Promise.resolve(factOf(states.get(id)));
    },
    state: (id) => states.get(id),
    set: (id, state) => {
      states.set(id, state);
    },
  };
}
