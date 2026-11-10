// #715 (b) — test support: what a hand-built store double returns now that every store call returns
// its reading. A double holds the host's clock (`systemClock`) and judges a record exactly as a real
// store on an ordinary directory does: one raw reading, floored by the record's own `updated_at`.
import { systemClock } from '../utils/clock.js';
import { floorAtRecord, takeRawReading } from '../store/take-reading.js';
import { writtenSnapshot, type Snapshot } from '../engine/snapshot.js';
import type {
  RunStore,
  ScanFilter,
  ScanOptions,
  ScanPage,
  StoreSettlement,
} from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';

/** The clock a hand-built double holds (a store's `clock` is required, #715 (b)). */
export const doubleClock = systemClock;

/** A record and the reading a real store on the host clock would judge it at. */
export function snap(record: RunRecord): Snapshot {
  return writtenSnapshot(record, floorAtRecord(takeRawReading(systemClock), record));
}

/** The `settleStep` of a double whose cell never settles (it is required on a store, #715 (b)). */
export async function noSettle(): Promise<StoreSettlement> {
  throw new Error('this store double does not settle');
}

/** The records a {@link scanning} double pages over: a fixed list, or a function read at each page. */
type Records = readonly RunRecord[] | (() => readonly RunRecord[]);

/**
 * #616 PR-2c c4: the `scan` of a double over `records`, paged as a real store pages: ids in UTF-8 byte
 * order, the `workflow` filter, `pageSize` at a time, one raw reading of the host clock a page, each
 * record judged at it floored by its own `updated_at`, `next_after` on a full page. It does not
 * filter by anything else, or give the `'row'` projection: asked to, it throws.
 */
export function scanning(records: Records): RunStore['scan'] {
  function scan(
    filter: ScanFilter,
    options: ScanOptions & { projection: 'row' },
  ): AsyncGenerator<ScanPage<'row'>, void, undefined>;
  function scan(
    filter: ScanFilter,
    options: ScanOptions & { projection?: 'record' },
  ): AsyncGenerator<ScanPage<'record'>, void, undefined>;
  function scan(
    filter: ScanFilter,
    options: ScanOptions,
  ): AsyncGenerator<ScanPage<'record'> | ScanPage<'row'>, void, undefined>;
  async function* scan(
    filter: ScanFilter,
    options: ScanOptions,
  ): AsyncGenerator<ScanPage<'record' | 'row'>, void, undefined> {
    const others = [
      filter.phase,
      filter.terminal,
      filter.key,
      filter.created_since,
      filter.updated_since,
    ];
    if (others.some((v) => v !== undefined) || options.projection === 'row') {
      throw new Error("this store double scans by 'workflow' only, as records");
    }
    let after = Buffer.from(options.after ?? '', 'utf8');
    for (;;) {
      const r = takeRawReading(systemClock);
      const cut = (typeof records === 'function' ? records() : records)
        .filter((rec) => filter.workflow === undefined || rec.workflow_id === filter.workflow)
        .map((rec) => ({ rec, id: Buffer.from(rec.id, 'utf8') }))
        .filter(({ id }) => Buffer.compare(id, after) > 0)
        .sort((a, b) => Buffer.compare(a.id, b.id))
        .slice(0, options.pageSize);
      const page: ScanPage<'record'> = {
        items: cut.map(({ rec }) => ({
          kind: 'run',
          run: writtenSnapshot(rec, floorAtRecord(r, rec)),
        })),
        read_at: r,
        consistent_snapshot: true,
        derived_at_read: 0,
      };
      if (cut.length === options.pageSize) page.next_after = cut[cut.length - 1]!.rec.id;
      yield page;
      if (page.next_after === undefined) return;
      after = Buffer.from(page.next_after, 'utf8');
    }
  }
  return scan;
}

/** #616 PR-2c c4: the `scan` of a double whose cell never reads the store's runs: it throws. */
export const notScanned: RunStore['scan'] = scanning(() => {
  throw new Error('this store double does not scan');
});

/**
 * #616 PR-2c c4: the members a double that never deletes a run spreads in beside its own, with the
 * in-memory store's answers: no tombstones, so every key is unseen since the start of time.
 */
export const neverPurges: Pick<RunStore, 'purgesRuns' | 'resolveKey' | 'tombstonesSince'> = {
  purgesRuns: false,
  resolveKey: async () => ({ state: 'unseen', since: '1970-01-01T00:00:00.000Z' }),
  tombstonesSince: async () => '1970-01-01T00:00:00.000Z',
};
