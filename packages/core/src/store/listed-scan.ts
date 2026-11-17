// listed-scan.ts — gap 1, unit A0: the one way Realm lists runs without their model calls' texts.
//
// A store with `scanListed` reads its runs without the texts; a store without it (one written before
// it, or a test double) is listed through its `'record'` scan, and the texts are left out of copies
// (`listedSnapshotOf`). Either way the caller gets `ListedScanPage`s, whose records `update` refuses.
import { listedSnapshotOf } from '../engine/snapshot.js';
import type { ListedScanPage, RunStore, ScanFilter, ScanOptions } from './store-interface.js';

/**
 * Gap 1, unit A0: every page of `store`'s runs that `filter` selects, each run without its model
 * calls' texts: through the store's `scanListed` when it has one, otherwise through its `'record'`
 * scan with the texts left out of copies. The pages, readings and lease facts are the store's.
 * @internal
 */
export async function* scanListedRuns(
  store: Pick<RunStore, 'scan' | 'scanListed'>,
  filter: ScanFilter,
  options: Omit<ScanOptions, 'projection'>,
): AsyncGenerator<ListedScanPage, void, undefined> {
  if (store.scanListed !== undefined) {
    yield* store.scanListed(filter, options);
    return;
  }
  for await (const page of store.scan(filter, { ...options, projection: 'record' })) {
    yield {
      ...page,
      items: page.items.map((item) =>
        item.kind === 'run' ? { kind: 'run', run: listedSnapshotOf(item.run) } : item,
      ),
    };
  }
}
