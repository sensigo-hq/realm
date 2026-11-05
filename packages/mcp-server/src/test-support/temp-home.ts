// temp-home.ts — test support (issue #616 PR-2a, unit ii-a): every test that builds the MCP server
// hands it all four of its stores, never the library's defaults on the developer's real `~/.realm`.
// The library still accepts its stores as optional and derives the two artifact stores from a file
// run store; unit (ii-b) requires all four, and these helpers are how every test already passes them.
// Not published: the package's `files` leaves out `dist/**/test-support/**`.
//
// - `makeTempHome()`: a fresh temp folder with the program's own opener (`home.ts`) on it — the four
//   stores the `realm-mcp` program opens, on a folder no other test reads, and `cleanup()`. Unit 2b's
//   shape: 2b swaps the opener's body (SQLite) and keeps this helper.
// - `withArtifactStores(runStore)`: for a test that builds its own run store and registry, that run
//   store and the two artifact stores on its own folder, exactly what the library derives today
//   (`runsDirPath`, the run store as the trace buffer's reader). Spread in place of `runStore: …`, so
//   the run store the server gets and the trace buffer's reader are one object.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileFailedAttemptStore,
  type JsonFileStore,
  type JsonWorkflowStore,
} from '@sensigo/realm';
import { openMcpHome } from '../home.js';
import type { RealmMcpServerOptions } from '../server.js';
import { JsonTraceBufferStore } from '../json-trace-buffer-store.js';

type StoreKey = 'runStore' | 'workflowStore' | 'traceBufferStore' | 'failedAttemptStore';

/** #616 PR-2a (ii-b): the server's options with its four stores optional — what a test helper that
 *  supplies the four itself takes from a cell (which may still hand one of its own). */
export type ServerExtras = Omit<RealmMcpServerOptions, StoreKey> &
  Partial<Pick<RealmMcpServerOptions, StoreKey>>;

/** A temp realm home and the four stores on it. */
export interface TempHome {
  /** The home's folder (`<temp>/.realm`). */
  readonly path: string;
  /** The four stores, as `createRealmMcpServer` takes them: spread `...home.stores`. */
  readonly stores: {
    readonly runStore: JsonFileStore;
    readonly workflowStore: JsonWorkflowStore;
    readonly traceBufferStore: JsonTraceBufferStore;
    readonly failedAttemptStore: JsonFileFailedAttemptStore;
  };
  /** Removes the temp folder. Idempotent. */
  cleanup(): void;
}

/** A fresh temp folder, the program's opener on `<temp>/.realm`, its four stores and `cleanup()`. */
export async function makeTempHome(): Promise<TempHome> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-temp-home-'));
  const home = await openMcpHome({ home: join(dir, '.realm') });
  return {
    path: home.path,
    stores: {
      runStore: home.runStore,
      workflowStore: home.workflowStore,
      traceBufferStore: home.traceBufferStore,
      failedAttemptStore: home.failedAttemptStore,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A file run store with the two artifact stores on its own folder, as the library derives them. */
export function withArtifactStores<S extends JsonFileStore>(
  runStore: S,
): {
  runStore: S;
  traceBufferStore: JsonTraceBufferStore;
  failedAttemptStore: JsonFileFailedAttemptStore;
} {
  return {
    runStore,
    traceBufferStore: new JsonTraceBufferStore(runStore.runsDirPath, runStore),
    failedAttemptStore: new JsonFileFailedAttemptStore(runStore.runsDirPath),
  };
}
