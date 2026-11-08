// home.ts — issue #616 PR-2a, unit (iii): the one door every `realm` command opens its stores through.
// A command opens its home ONCE and hands the stores on; `realm serve` shares the one home's stores
// with every per-request server. The file stores live behind this one function, so unit 2c swaps
// one body (SQLite) instead of a construction in every command. Private to the CLI: it is exported
// from no published entry, and it is not core's `openRealmHome` (the design's name for 2c's opener).
// A source scan (store-door-616.test.ts) keeps every other construction of the six store classes
// out of the CLI's source.
import { join } from 'node:path';
import {
  JsonFileFailedAttemptStore,
  JsonFileStore,
  JsonWorkflowStore,
  realmHomePath,
  withTestClockNotice,
  type RealmWorkflowRegistrar,
} from '@sensigo/realm';
import { JsonTraceBufferStore } from '@sensigo/realm-mcp';
import { JsonFileReplayStore } from '../store/replay-store.js';
import { FileDedupStore } from './dedup-store.js';

/** The stores of one realm home, opened once by a command. */
export interface CliHome {
  /** The home's folder: `~/.realm`, or the absolute folder a program passed. */
  readonly path: string;
  /** The runs, under `<path>/runs`. At a test location it says so once per process on stderr, at
   *  its first read (`this store runs on a test clock, now <instant>`, #715 (b)). */
  readonly runStore: JsonFileStore;
  /** The workflow registry, under `<path>/workflows`: built on its first use, never at the open
   *  (its constructor creates that folder). #616 PR-2c c5b: typed as core's registrar with every
   *  optional member (the listing with diagnostics, the capped read), as Realm's own registries are:
   *  `--stuck` needs no fallback, and its size cap can never be silently absent. */
  readonly workflowStore: RealmWorkflowRegistrar;
  /** The trace buffer, under `<path>/runs`; its fence reader is THIS home's run store. */
  readonly traceBufferStore: JsonTraceBufferStore;
  /** The failed-attempt records, under `<path>/runs` (the #188 co-location contract). The one place
   *  in the CLI that builds this class. */
  readonly failedAttemptStore: JsonFileFailedAttemptStore;
  /** The replay records, under `<path>/replays`. */
  readonly replayStore: JsonFileReplayStore;
  /** `realm listen`'s dedup marks for one workflow, under `<path>/dedup/<workflowId>`. */
  dedupStoreFor(workflowId: string): FileDedupStore;
  /** Closes the home. Idempotent; on the file stores there is nothing to close. */
  close(): Promise<void>;
}

/**
 * Opens realm's home and returns its stores.
 *
 * The contract (unit 2c changes this function's body, never these laws):
 * - The home is core's `realmHomePath(home)`, read at this call: `~/.realm` from the user's home,
 *   or the absolute `home` a program passes. An unusable home rejects with `STATE_HOME_UNUSABLE`.
 * - The open's one side effect is the run store's read of the home's test-clock file: a copied test
 *   location rejects with `STATE_TEST_CLOCK_FOREIGN`, as the run store's construction always has.
 *   Every refusal is a rejected promise.
 * - The registry's folder is created only when a command first uses the registry, as before this
 *   door: no command creates a folder it did not create before.
 * - A second open in one process returns a second, independent handle (realm's hosts open once).
 * - `close()` is idempotent.
 */
export async function openCliHome(options: { home?: string } = {}): Promise<CliHome> {
  const path = realmHomePath(options.home);
  const runsDir = join(path, 'runs');
  // The run store first: its constructor reads the home's clock file and refuses a copied test
  // location with its own code.
  const runStore = withTestClockNotice(new JsonFileStore(runsDir), (line) => {
    process.stderr.write(`${line}\n`);
  });
  // None of these touches the disk at construction.
  const traceBufferStore = new JsonTraceBufferStore(runsDir, runStore);
  const failedAttemptStore = new JsonFileFailedAttemptStore(runsDir);
  const replayStore = new JsonFileReplayStore(join(path, 'replays'));
  const dedupDir = join(path, 'dedup');
  let workflowStore: JsonWorkflowStore | undefined;
  return {
    path,
    runStore,
    get workflowStore(): RealmWorkflowRegistrar {
      workflowStore ??= new JsonWorkflowStore(join(path, 'workflows'));
      return workflowStore;
    },
    traceBufferStore,
    failedAttemptStore,
    replayStore,
    dedupStoreFor: (workflowId) => new FileDedupStore(dedupDir, workflowId),
    // The file stores hold nothing open; a second call does the same nothing.
    close: () => Promise.resolve(),
  };
}
