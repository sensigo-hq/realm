// #715 (b) — test support: what a hand-built store double returns now that every store call returns
// its reading. A double holds the host's clock (`systemClock`) and judges a record exactly as a real
// store on an ordinary directory does: one raw reading, floored by the record's own `updated_at`.
import { systemClock } from '../utils/clock.js';
import { floorAtRecord, takeRawReading } from '../store/take-reading.js';
import { writtenSnapshot, type Snapshot } from '../engine/snapshot.js';
import type { Listing, StoreSettlement } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';

/** The clock a hand-built double holds (a store's `clock` is required, #715 (b)). */
export const doubleClock = systemClock;

/** A record and the reading a real store on the host clock would judge it at. */
export function snap(record: RunRecord): Snapshot {
  return writtenSnapshot(record, floorAtRecord(takeRawReading(systemClock), record));
}

/** A listing of records, read in one pass (`consistent_snapshot: true`). */
export function listing(records: readonly RunRecord[]): Listing {
  const r = takeRawReading(systemClock);
  return {
    snapshots: records.map((rec) => writtenSnapshot(rec, floorAtRecord(r, rec))),
    read_at: r,
    consistent_snapshot: true,
  };
}

/** The `settleStep` of a double whose cell never settles (it is required on a store, #715 (b)). */
export async function noSettle(): Promise<StoreSettlement> {
  throw new Error('this store double does not settle');
}
