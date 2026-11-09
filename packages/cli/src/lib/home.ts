// home.ts — issue #616 PR-2a, unit (iii): the one door every `realm` command opens its stores through.
// A command opens its home ONCE and hands the stores on; `realm serve` shares the one home's stores
// with every per-request server. #616 PR-2c c10a-3a: the door's body is the SQLite home
// (`openRealmHome` of `@sensigo/realm-store-sqlite`), one file `realm.db` in the Realm home. Private
// to the CLI: it is exported from no published entry. A source scan (store-door-616.test.ts) keeps
// every construction of a store class out of the CLI's source: the store package builds them.
import {
  realmHomePath,
  withTestClockNotice,
  type Clock,
  type DedupStore,
  type RealmWorkflowRegistrar,
} from '@sensigo/realm';
import {
  openRealmHome,
  type PurgeReport,
  type PurgeSelection,
  type RealmHome,
  type SqliteRunStore,
} from '@sensigo/realm-store-sqlite';

/** The stores of one realm home, opened once by a command. */
export interface CliHome {
  /** The home's folder: `~/.realm`, or the absolute folder a program passed. */
  readonly path: string;
  /** The runs. On a test clock it says so once per process on stderr, at its first read (`this store
   *  runs on a test clock, now <instant>`, #715 (b)). */
  readonly runStore: SqliteRunStore;
  /** The workflow registry, typed as core's registrar with every optional member (the listing with
   *  diagnostics, the capped read: #616 PR-2c c5a, c5b), as Realm's own registries are: `--stuck`
   *  needs no fallback, and its size cap can never be silently absent. */
  readonly workflowStore: RealmWorkflowRegistrar;
  /** The trace buffer; its fence is the run's row in the same store. */
  readonly traceBufferStore: RealmHome['traceBufferStore'];
  /** The failed-attempt records, kept per run. */
  readonly failedAttemptStore: RealmHome['failedAttemptStore'];
  /** The replay records, by id. */
  readonly replayStore: RealmHome['replayStore'];
  /** `realm listen`'s dedup marks for one workflow. */
  dedupStoreFor(workflowId: string): DedupStore;
  /** Deletes the runs the caller selected, each at the version it was selected at (#616 PR-2c c9):
   *  the home's own purge, in batches, then the free pages and the log. */
  purge(selection: readonly PurgeSelection[]): Promise<PurgeReport>;
  /** Closes the home for every caller in this process that opened it. A second call does nothing. */
  close(): Promise<void>;
}

/**
 * Opens realm's home and returns its stores.
 *
 * The contract:
 * - The home is core's `realmHomePath(home)`, read at this call: `~/.realm` from the user's home,
 *   or the absolute `home` a program passes. An unusable home rejects with `STATE_HOME_UNUSABLE`.
 * - The open CREATES the home: the folder, the fence files `runs`, `workflows`, `replays` and
 *   `dedup`, and `realm.db`. An empty home becomes a store.
 * - The clock is the home's test-clock file when one is there: a copied test home rejects with
 *   `STATE_TEST_CLOCK_FOREIGN` before anything is created.
 * - A home holding a DIRECTORY at any of the four names (the old JSON store's folders) rejects with
 *   `STATE_HOME_HOLDS_LEGACY_STORE`, and nothing is created.
 * - ONE handle per home per process: a second call returns the same stores; a second call with
 *   another clock rejects. `close()` ends the handle for every caller; a second `close()` does
 *   nothing.
 * - `clock` is for tests, never a flag or a setting.
 * Every refusal is a rejected promise. This door is the only place the CLI's source opens a store.
 */
export async function openCliHome(
  options: { home?: string; clock?: Clock } = {},
): Promise<CliHome> {
  const path = realmHomePath(options.home);
  const realmHome = await openRealmHome({
    home: path,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  // The store's clock is the home's clock file when one exists; on a test clock the run store says
  // so once on stderr (#715 (b)). On any other clock the wrap returns the store itself.
  const runStore = withTestClockNotice(realmHome.runStore, (line) => {
    process.stderr.write(`${line}\n`);
  });
  return {
    path,
    runStore,
    workflowStore: realmHome.workflowStore,
    traceBufferStore: realmHome.traceBufferStore,
    failedAttemptStore: realmHome.failedAttemptStore,
    replayStore: realmHome.replayStore,
    dedupStoreFor: (workflowId) => realmHome.dedupStoreFor(workflowId),
    purge: (selection) => realmHome.purge(selection),
    close: () => {
      realmHome.close();
      return Promise.resolve();
    },
  };
}
