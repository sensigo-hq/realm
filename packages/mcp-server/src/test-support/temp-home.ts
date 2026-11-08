// temp-home.ts — test support (issue #616 PR-2a, unit ii-a; PR-2b, b3): every test that builds the MCP
// server, or calls a tool's handler, takes its stores from the program's own opener (`home.ts`) on a
// temp folder, never the library's defaults on the developer's real `~/.realm` and never the store
// classes constructed by hand. The opener is the one place this package builds its stores, so unit 2c
// swaps its body (SQLite) and every test that uses this helper follows without an edit. Not
// published: the package's `files` leaves out `dist/**/test-support/**`. It constructs no store
// itself, so the source scan (`packages/cli/src/lib/store-door-616.test.ts`), which reads this folder
// as source, allows it no construction.
//
// - `makeTempHome()`: a fresh temp folder `root` of its own, and the opener on `<root>/.realm`. A child
//   process given `HOME: root` opens the same home (core's `realmHomePath`), so a test seeds a run
//   through the handle and drives a program that reads it.
// - `makeTempHome({ home })`: the opener on the given folder as it is — a test location, or a second,
//   independent handle on a folder a handle opened earlier. It removes nothing.
//
// Unlike the CLI's door, this opener builds the registry at the open, and the registry's constructor
// creates `<path>/workflows`; nothing else is created at the open (the run store reads the folder's
// clock file; the trace buffer and the failed-attempt store touch no disk). A test that writes into
// the runs folder before a store's first write makes that folder first.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type {
  JsonFileFailedAttemptStore,
  JsonFileStore,
  JsonWorkflowStore,
  RunStore,
} from '@sensigo/realm';
import { openMcpHome } from '../home.js';
import type { RealmMcpServerOptions } from '../server.js';
import type { JsonTraceBufferStore } from '../json-trace-buffer-store.js';

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

/** #616 PR-2c (c0): how many runs `store` holds, read through the store — never by counting files in
 *  its folder. The one place a test counts runs: c4 rewrites this body to `scan()`, and c10a's SQLite
 *  handle answers it the same way. */
export async function runCount(store: Pick<RunStore, 'list'>): Promise<number> {
  return (await store.list()).snapshots.length;
}

/** #616 PR-2c (c0): the ids of the runs `store` holds, ascending, read through the store. Sorted here,
 *  so a store whose listing comes back in another order (c4's `scan()`, the SQLite rows) changes no
 *  caller. */
export async function runIds(store: Pick<RunStore, 'list'>): Promise<string[]> {
  return (await store.list()).snapshots
    .map((s) => s.record.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
