// home.ts — issue #616 PR-2a, unit (ii-a); PR-2c c10b-2: this package's door to realm's home. It opens
// the home once, at the package's edge, and returns the four stores the server takes; the server
// selects nothing. Private: the package's index does not export it, and its `exports` map does not
// reach it. It opens the SQLite home through the STORE package's `openRealmHome`, and it is the one
// place this package opens a store: the library's home entry (`home-server.ts`, which the `realm-mcp`
// program uses) and the test helper (`test-support/temp-home.ts`) go through it. It is not the CLI's
// door (`lib/home.ts` in `@sensigo/realm-cli`): one door per host package.
import { realmHomePath } from '@sensigo/realm';
import { openRealmHome } from '@sensigo/realm-store-sqlite';
import type { RealmMcpServerOptions } from './server.js';

/** The four stores of one realm home, as `createRealmMcpServer` takes them. */
export interface McpHome {
  /** The home's folder: `~/.realm`, or the absolute folder a program passed. */
  readonly path: string;
  /** The runs. */
  readonly runStore: RealmMcpServerOptions['runStore'];
  /** The workflow registry. */
  readonly workflowStore: RealmMcpServerOptions['workflowStore'];
  /** The trace buffer; its fence is the run's row in the same store. */
  readonly traceBufferStore: RealmMcpServerOptions['traceBufferStore'];
  /** The failed-attempt records, kept per run. */
  readonly failedAttemptStore: RealmMcpServerOptions['failedAttemptStore'];
  /**
   * Closes the home. The handle is SHARED by every caller in this process that opened the same home,
   * so a close ends it for all of them. A second close does nothing.
   */
  close(): void;
}

/**
 * Opens realm's home and returns its four stores.
 *
 * - The home is core's `realmHomePath(home)`, read at this call: `~/.realm` from the user's home,
 *   or the absolute `home` a program passes. An unusable home rejects with `STATE_HOME_UNUSABLE`.
 * - The open CREATES the home: the folder, the fence files `runs`, `workflows`, `replays` and
 *   `dedup`, and `realm.db`. An empty home becomes a store.
 * - The clock is the home's test-clock file when one is there, which the store reads itself: a copied
 *   test home rejects with `STATE_TEST_CLOCK_FOREIGN` before anything is created.
 * - A home holding a DIRECTORY at any of the four names (the old JSON store's folders) rejects with
 *   `STATE_HOME_HOLDS_LEGACY_STORE`, and nothing is created.
 * - ONE handle per home per process: a second call hands back the same four stores.
 *
 * Every refusal is a rejected promise.
 */
export async function openMcpHome(options: { home?: string } = {}): Promise<McpHome> {
  const path = realmHomePath(options.home);
  const realmHome = await openRealmHome({ home: path });
  return {
    path,
    runStore: realmHome.runStore,
    workflowStore: realmHome.workflowStore,
    traceBufferStore: realmHome.traceBufferStore,
    failedAttemptStore: realmHome.failedAttemptStore,
    close: () => realmHome.close(),
  };
}
