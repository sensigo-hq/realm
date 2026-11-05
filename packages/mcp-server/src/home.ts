// home.ts — issue #616 PR-2a, unit (ii-a): the `realm-mcp` program's opener. The program opens realm's
// home once, at its edge, and hands the library the four stores it takes; the library selects
// nothing. Private: the package's index does not export it, and its `exports` map does not reach it.
// `bin.ts` (the program) and the test helper (`test-support/temp-home.ts`) import it. It is not core's
// `openRealmHome` (the design's name for 2c's opener), and not the CLI's door (`lib/home.ts` in
// `@sensigo/realm-cli`): one opener per host package, each with a body unit 2c swaps.
import { join } from 'node:path';
import {
  JsonFileFailedAttemptStore,
  JsonFileStore,
  JsonWorkflowStore,
  realmHomePath,
} from '@sensigo/realm';
import { JsonTraceBufferStore } from './json-trace-buffer-store.js';

/** The four stores of one realm home, as `createRealmMcpServer` takes them. */
export interface McpHome {
  /** The home's folder: `~/.realm`, or the absolute folder a program passed. */
  readonly path: string;
  /** The runs, under `<path>/runs`. */
  readonly runStore: JsonFileStore;
  /** The workflow registry, under `<path>/workflows`. */
  readonly workflowStore: JsonWorkflowStore;
  /** The trace buffer, under `<path>/runs`; its fence reader is THIS home's run store. */
  readonly traceBufferStore: JsonTraceBufferStore;
  /** The failed-attempt records, under `<path>/runs` (the #188 co-location contract). */
  readonly failedAttemptStore: JsonFileFailedAttemptStore;
  /** Closes the home. Idempotent; on the file stores there is nothing to close. */
  close(): Promise<void>;
}

/**
 * Opens realm's home and returns its four stores.
 *
 * - The home is core's `realmHomePath(home)`, read at this call: `~/.realm` from the user's home,
 *   or the absolute `home` a program passes. An unusable home rejects with `STATE_HOME_UNUSABLE`.
 * - The run store first: its constructor reads the home's test-clock file, and a copied test
 *   location rejects with `STATE_TEST_CLOCK_FOREIGN`. Every refusal is a rejected promise.
 * - The registry is built here, after the run store, not on first use as the CLI's door builds it:
 *   the library takes the registry object when the server is built (it checks its release line), so
 *   a lazy one would be built at the same moment. Its constructor creates `<path>/workflows`.
 * - `close()` is idempotent.
 */
export async function openMcpHome(options: { home?: string } = {}): Promise<McpHome> {
  const path = realmHomePath(options.home);
  const runsDir = join(path, 'runs');
  const runStore = new JsonFileStore(runsDir);
  // These two touch no disk at construction.
  const traceBufferStore = new JsonTraceBufferStore(runsDir, runStore);
  const failedAttemptStore = new JsonFileFailedAttemptStore(runsDir);
  const workflowStore = new JsonWorkflowStore(join(path, 'workflows'));
  return {
    path,
    runStore,
    workflowStore,
    traceBufferStore,
    failedAttemptStore,
    // The file stores hold nothing open; a second call does the same nothing.
    close: () => Promise.resolve(),
  };
}
