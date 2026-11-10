// json-as-run-store.ts — #616 PR-2c c4, test support: a `JsonFileStore` seen as a `RunStore`. Since c4 the
// JSON store has no `scan`, `resolveKey`, `tombstonesSince` or `purgesRuns` (it no longer implements the
// interface), so a test that hands one to a function taking a `RunStore` wraps it here. PR-3 deletes this
// with the class.
import { deriveRunPhase } from '../engine/eligibility.js';
import type { JsonFileStore } from '../store/json-file-store.js';
import type {
  KeyAnswer,
  RunStore,
  ScanFilter,
  ScanOptions,
  ScanPage,
} from '../store/store-interface.js';

/**
 * `json` as a `RunStore`: every member bound to it; `clock` forwarded (the JSON store's own: the host's,
 * or a test location's clock file); `scan` built from `json.list`, one listing (and its `read_at`) a
 * page, the records in UTF-8 byte order of their ids, the filters applied in memory, `next_after` on a
 * full page; `purgesRuns: false`, the start of time as the horizon, and `resolveKey` not exercised. Its
 * prototype is the JSON store, so it carries that store's own release line: the line of the copy of
 * realm that built it, which the engine's admission checks.
 */
export function jsonAsRunStore(json: JsonFileStore): RunStore & { readonly runsDirPath: string } {
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
    if (options.projection === 'row') throw new Error('jsonAsRunStore scans records only');
    let after = Buffer.from(options.after ?? '', 'utf8');
    for (;;) {
      const listing = await json.list(filter.workflow);
      const cut = listing.snapshots
        .filter(
          ({ record: r }) => filter.terminal === undefined || r.terminal_state === filter.terminal,
        )
        .filter(({ record: r }) => filter.key === undefined || r.idempotency_key === filter.key)
        .filter(
          ({ record: r }) =>
            filter.created_since === undefined || r.created_at >= filter.created_since,
        )
        .filter(
          ({ record: r }) =>
            filter.updated_since === undefined || r.updated_at >= filter.updated_since,
        )
        .filter(({ record: r }) => filter.phase === undefined || deriveRunPhase(r) === filter.phase)
        .map((snapshot) => ({ snapshot, id: Buffer.from(snapshot.record.id, 'utf8') }))
        .filter(({ id }) => Buffer.compare(id, after) > 0)
        .sort((a, b) => Buffer.compare(a.id, b.id))
        .slice(0, options.pageSize);
      const page: ScanPage<'record'> = {
        items: cut.map(({ snapshot }) => ({ kind: 'run', run: snapshot })),
        read_at: listing.read_at,
        consistent_snapshot: true,
        derived_at_read: 0,
      };
      if (cut.length === options.pageSize)
        page.next_after = cut[cut.length - 1]!.snapshot.record.id;
      yield page;
      if (page.next_after === undefined) return;
      after = Buffer.from(page.next_after, 'utf8');
    }
  }
  const store = {
    get clock() {
      return json.clock;
    },
    persistsClaims: json.persistsClaims,
    persistedRunRecordFields: json.persistedRunRecordFields,
    purgesRuns: false,
    create: (o: Parameters<RunStore['create']>[0]) => json.create(o),
    get: (id: string) => json.get(id),
    update: (r: Parameters<RunStore['update']>[0]) => json.update(r),
    claimStep: (...a: Parameters<RunStore['claimStep']>) => json.claimStep(...a),
    settleStep: ((...a: unknown[]) =>
      (json.settleStep as (...x: unknown[]) => unknown).apply(json, a)) as RunStore['settleStep'],
    stampSeal: (...a: Parameters<NonNullable<RunStore['stampSeal']>>) => json.stampSeal(...a),
    scan,
    resolveKey: async (): Promise<KeyAnswer> => {
      throw new Error('jsonAsRunStore: resolveKey is not exercised');
    },
    tombstonesSince: async () => '1970-01-01T00:00:00.000Z',
    // The JSON store's folder, for the cells that write a run file past the store.
    runsDirPath: json.runsDirPath,
  };
  // The JSON store under it carries its release line (its class's, of the copy that built it): the
  // engine's admission reads it through this object's prototype.
  Object.setPrototypeOf(store, json);
  return store;
}
