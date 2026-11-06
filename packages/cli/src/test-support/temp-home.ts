// temp-home.ts — test support (issue #616 PR-2b, b1): a CLI test opens its stores through the CLI's
// own door (`openCliHome`, lib/home.ts) on a temp folder, never by constructing the store classes by
// hand. The door is the one place the CLI builds its stores, so unit 2c swaps its body (SQLite) and
// every test that uses this helper follows without an edit. Not published: the package's `files`
// leaves out `dist/**/test-support/**`. It constructs no store itself, so the source scan
// (lib/store-door-616.test.ts), which reads this folder as source, stays green.
//
// - `makeTempHome()`: a fresh temp folder `root` of its own, and the door on `<root>/.realm`. A child
//   process given `HOME: root` opens the same home (core's `realmHomePath`), so a test seeds a run
//   through the handle and drives a command that reads it.
// - `makeTempHome({ home })`: the door on the given folder as it is — a test location, or a second,
//   independent handle on a folder a handle opened earlier. It creates nothing and removes nothing.
//
// The door creates nothing at the open (the run store reads the folder's clock file; the registry's
// folder is made at its first use), and neither does this helper beyond its own `root`: a test that
// writes into a folder before a store's first write makes that folder first.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { openCliHome, type CliHome } from '../lib/home.js';

/** A realm home opened through the CLI's door for one test. */
export interface TempHome {
  /** The folder a child process takes as HOME: the helper's own, or the parent of a given `.realm`
   *  path; undefined for a home opened by a path not named `.realm` (a test location made at a
   *  folder not named `.realm`, as check 3's; the six files' locations are all `.realm`-named). */
  readonly root: string | undefined;
  /** The folder the door opened: `<root>/.realm`, or the given `home`. */
  readonly path: string;
  /** The door's handle: the six stores, `dedupStoreFor`, `close()`. */
  readonly home: CliHome;
  /** Closes the handle, then removes the helper's own root (retrying while a child still writes:
   *  `rmSync` recursive, force, `maxRetries: 10`, `retryDelay: 100`); on a given `home` it removes
   *  nothing. Idempotent. */
  cleanup(): Promise<void>;
}

/** A fresh temp folder of the helper's own, and the CLI's door on `<root>/.realm`. */
export function makeTempHome(): Promise<TempHome & { readonly root: string }>;
/** The CLI's door on the given folder, as given; the helper owns nothing. */
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
  const home = await openCliHome({ home: path });
  return {
    root,
    path,
    home,
    async cleanup(): Promise<void> {
      // The handle first: unit 2c's SQLite handle must be closed before its folder goes.
      await home.close();
      if (owned !== undefined) {
        rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
  };
}
