// temp-home.ts — test support (issue #616 PR-2a, unit ii-a; PR-2b, b3): every test that builds the MCP
// server, or calls a tool's handler, takes its stores from the program's own opener (`home.ts`) on a
// temp folder, never the library's defaults on the developer's real `~/.realm` and never the store
// classes constructed by hand. The opener is the one place this package builds its stores, so unit 2c
// swaps its body (SQLite) and every test that uses this helper follows without an edit. Not
// published: the package's `files` leaves out `dist/**/test-support/**`.
//
// - `makeTempHome()`: a fresh temp folder `root` of its own, and the opener on `<root>/.realm`. A child
//   process given `HOME: root` opens the same home (core's `realmHomePath`), so a test seeds a run
//   through the handle and drives a program that reads it.
// - `makeTempHome({ home })`: the opener on the given folder as it is — a test location, or a second,
//   independent handle on a folder a handle opened earlier. It removes nothing.
// - `withArtifactStores(runStore)`: for a test that builds its own run store and registry, that run
//   store and the two artifact stores on its own folder, exactly what the library derived (the run
//   store as the trace buffer's reader). Unit b3 routes its last users and deletes it.
//
// Unlike the CLI's door, this opener builds the registry at the open, and the registry's constructor
// creates `<path>/workflows`; nothing else is created at the open (the run store reads the folder's
// clock file; the trace buffer and the failed-attempt store touch no disk). A test that writes into
// the runs folder before a store's first write makes that folder first.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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

/** A realm home opened through the program's opener for one test. */
export interface TempHome {
  /** The folder a child process takes as HOME: the helper's own, or the parent of a given `.realm`
   *  path; undefined for a home opened by a path not named `.realm` (a test location). */
  readonly root: string | undefined;
  /** The folder the opener opened: `<root>/.realm`, or the given `home`. */
  readonly path: string;
  /** The four stores, as `createRealmMcpServer` takes them: spread `...home.stores`. */
  readonly stores: {
    readonly runStore: JsonFileStore;
    readonly workflowStore: JsonWorkflowStore;
    readonly traceBufferStore: JsonTraceBufferStore;
    readonly failedAttemptStore: JsonFileFailedAttemptStore;
  };
  /** Closes the handle, then removes the helper's own root (retrying while a child still writes:
   *  `rmSync` recursive, force, `maxRetries: 10`, `retryDelay: 100`); on a given `home` it removes
   *  nothing. Idempotent. */
  cleanup(): Promise<void>;
}

/** A fresh temp folder of the helper's own, and the program's opener on `<root>/.realm`. */
export function makeTempHome(): Promise<TempHome & { readonly root: string }>;
/** The program's opener on the given folder, as given; the helper owns nothing. */
export function makeTempHome(options: { home: string }): Promise<TempHome>;
export async function makeTempHome(options?: { home: string }): Promise<TempHome> {
  // The helper owns a root only when it made one.
  let owned: string | undefined;
  let path: string;
  if (options === undefined) {
    owned = mkdtempSync(join(tmpdir(), 'realm-temp-home-'));
    path = join(owned, '.realm');
  } else {
    path = options.home;
  }
  const root = owned ?? (basename(path) === '.realm' ? dirname(path) : undefined);
  const home = await openMcpHome({ home: path });
  return {
    root,
    path,
    stores: {
      runStore: home.runStore,
      workflowStore: home.workflowStore,
      traceBufferStore: home.traceBufferStore,
      failedAttemptStore: home.failedAttemptStore,
    },
    async cleanup(): Promise<void> {
      // The handle first: unit 2c's SQLite handle must be closed before its folder goes.
      await home.close();
      if (owned !== undefined) {
        rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
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
