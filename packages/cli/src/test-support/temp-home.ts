// temp-home.ts — test support (issue #616 PR-2b, b1): a CLI test opens its stores through the CLI's
// own door (`openCliHome`, lib/home.ts) on a temp folder, never by constructing the store classes by
// hand. The door is the one place the CLI opens its stores (#616 PR-2c c10a-3a: the SQLite home), and
// every test that uses this helper follows it. Not published: the package's `files` leaves out
// `dist/**/test-support/**`. It constructs no store itself, so the source scan
// (lib/store-door-616.test.ts), which reads this folder as source, stays green.
//
// - `makeTempHome()`: a fresh temp folder `root` of its own, and the door on `<root>/.realm`: a fresh
//   SQLite home. A child process given `HOME: root` opens the same home (core's `realmHomePath`), so a
//   test seeds a run through the handle and drives a command that reads it.
// - `makeTempHome({ home })`: the door on the given folder — a test home from the testing package, or
//   a folder a handle in this process already holds open, whose stores it then returns (one handle
//   per home per process). It removes nothing.
// - `clock`: passed to the door, for a test that must give the home its own clock object.
//
// The door's open creates the home: the folder, the fence files `runs`, `workflows`, `replays` and
// `dedup`, and `realm.db`. `cleanup()` closes the handle first, for every caller that shares it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Clock, RunStore, Snapshot } from '@sensigo/realm';
import { openCliHome, type CliHome } from '../lib/home.js';

/** A realm home opened through the CLI's door for one test. */
export interface TempHome {
  /** The folder a child process takes as HOME: the helper's own, or the parent of a given `.realm`
   *  path; undefined for a home opened by a path not named `.realm` (a test location made at a
   *  folder not named `.realm`, as check 3's; the six files' locations are all `.realm`-named). */
  readonly root: string | undefined;
  /** The folder the door opened: `<root>/.realm`, or the given `home`. */
  readonly path: string;
  /** The door's handle: the stores, `dedupStoreFor`, `purge`, `close()`. */
  readonly home: CliHome;
  /** Closes the handle (for every caller that shares it), then removes the helper's own root
   *  (retrying while a child still writes: `rmSync` recursive, force, `maxRetries: 10`,
   *  `retryDelay: 100`); on a given `home` it removes nothing. Idempotent. */
  cleanup(): Promise<void>;
}

/** A fresh temp folder of the helper's own, and the CLI's door on `<root>/.realm`. */
export function makeTempHome(options?: {
  readonly clock?: Clock;
}): Promise<TempHome & { readonly root: string }>;
/** The CLI's door on the given folder, as given; the helper owns nothing. */
export function makeTempHome(options: {
  readonly home: string;
  readonly clock?: Clock;
}): Promise<TempHome>;
export async function makeTempHome(
  options: { readonly home?: string; readonly clock?: Clock } = {},
): Promise<TempHome> {
  // The helper owns a root only when it made one.
  let owned: string | undefined;
  let path: string;
  if (options.home === undefined) {
    owned = mkdtempSync(join(tmpdir(), 'realm-temp-home-'));
    path = join(owned, '.realm');
  } else {
    path = options.home;
  }
  const root = owned ?? (basename(path) === '.realm' ? dirname(path) : undefined);
  const home = await openCliHome({
    home: path,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  return {
    root,
    path,
    home,
    async cleanup(): Promise<void> {
      // The handle first: the SQLite handle is closed before its folder goes.
      await home.close();
      if (owned !== undefined) {
        rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
  };
}

/** #616 PR-2c (c4): every run `store` holds, each as `get()` returns it, read through every page of
 *  its scan — the one helper a test reads all of a store's runs through. */
export async function runsOf(store: Pick<RunStore, 'scan'>): Promise<Snapshot[]> {
  const snapshots: Snapshot[] = [];
  for await (const page of store.scan({}, { pageSize: 1000, projection: 'record' })) {
    for (const item of page.items) if (item.kind === 'run') snapshots.push(item.run);
  }
  return snapshots;
}

/** #616 PR-2c (c0): how many runs `store` holds, read through the store — never by counting files in
 *  its folder. The one place a test counts runs; since c4 it reads every page of `scan()`. */
export async function runCount(store: Pick<RunStore, 'scan'>): Promise<number> {
  return (await runsOf(store)).length;
}

/** #616 PR-2c (c0): the ids of the runs `store` holds, ascending, read through the store. Sorted here,
 *  so a store whose listing comes back in another order changes no caller. */
export async function runIds(store: Pick<RunStore, 'scan'>): Promise<string[]> {
  return (await runsOf(store)).map((s) => s.record.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
