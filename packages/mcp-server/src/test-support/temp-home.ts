// temp-home.ts — test support (issue #616 PR-2a, unit ii-a; PR-2b, b3; PR-2c c10b-2): every test that
// builds the MCP server, or calls a tool's handler, takes its stores from the program's own door
// (`home.ts`) on a temp folder, never the library's defaults on the developer's real `~/.realm` and
// never the store classes constructed by hand. The door is the one place this package opens a store,
// and a test that uses this helper runs on the SQLite home it opens. Not published: the package's
// `files` leaves out `dist/**/test-support/**`. It constructs no store itself, so the source scan
// (`packages/cli/src/lib/store-door-616.test.ts`), which reads this folder as source, allows it no
// construction.
//
// - `makeTempHome()`: a fresh temp folder `root` of its own, and the door on `<root>/.realm`: a fresh
//   SQLite home. A child process given `HOME: root` opens the same home (core's `realmHomePath`), so a
//   test seeds a run through the handle and drives a program that reads it.
// - `makeTempHome({ home })`: the door on the given folder — a test home from the testing package, or a
//   folder a handle in this process already holds open, whose stores it then returns (one handle per
//   home per process), so a `cleanup()` of such a handle ends it for every holder. It removes nothing.
//
// The door's open creates the home: the folder, the fence files `runs`, `workflows`, `replays` and
// `dedup`, and `realm.db`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { RunRecord, RunStore } from '@sensigo/realm';
import { openMcpHome } from '../home.js';
import type { RealmMcpServerOptions } from '../server.js';

type StoreKey = 'runStore' | 'workflowStore' | 'traceBufferStore' | 'failedAttemptStore';

/** #616 PR-2a (ii-b): the server's options with its four stores optional — what a test helper that
 *  supplies the four itself takes from a cell (which may still hand one of its own). */
export type ServerExtras = Omit<RealmMcpServerOptions, StoreKey> &
  Partial<Pick<RealmMcpServerOptions, StoreKey>>;

/** A realm home opened through the program's door for one test. */
export interface TempHome {
  /** The folder a child process takes as HOME: the helper's own, or the parent of a given `.realm`
   *  path; undefined for a home opened by a path not named `.realm` (a test home). */
  readonly root: string | undefined;
  /** The folder the door opened: `<root>/.realm`, or the given `home`. */
  readonly path: string;
  /** The four stores, as `createRealmMcpServer` takes them: spread `...home.stores`. */
  readonly stores: Readonly<Pick<RealmMcpServerOptions, StoreKey>>;
  /** Closes the handle (for every caller that shares it), then removes the helper's own root
   *  (retrying while a child still writes: `rmSync` recursive, force, `maxRetries: 10`,
   *  `retryDelay: 100`); on a given `home` it removes nothing. Idempotent. */
  cleanup(): Promise<void>;
}

/** A fresh temp folder of the helper's own, and the program's door on `<root>/.realm`. */
export function makeTempHome(): Promise<TempHome & { readonly root: string }>;
/** The program's door on the given folder, as given; the helper owns nothing. */
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
      // The handle first: the SQLite handle is closed before its folder goes.
      home.close();
      if (owned !== undefined) {
        rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
  };
}

/** #616 PR-2c c10b-2: writes `record` as given through the store's `save` (its phase derived): how a
 *  test plants a shape the engine would not write, since stored evidence is append-only. `save` is not
 *  on the `RunStore` interface; the door's run store has it. */
export async function seedRun(store: RunStore, record: RunRecord): Promise<void> {
  await (store as unknown as { save(r: RunRecord): Promise<unknown> }).save(record);
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
