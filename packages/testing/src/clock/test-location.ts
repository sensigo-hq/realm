// test-location.ts — issue #715 (a) (D6-1, D6-54): a TEST LOCATION — a store directory whose clock is
// a file beside its `runs/` folder, so every process that opens a store there (this one, a spawned
// `realm` command, a spawned MCP server) reads the same time, which the test moves.
//
// Production code never creates one: a lint rule and a source scan keep `createTestLocation` out of
// every production module (D6-52; #715 (a) correction 1, C-2).
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TEST_CLOCK_FILE_NAME, fileClock, writeTestClockFile } from '@sensigo/realm';
import { settableClockOver, type SettableClock } from './settable-clock.js';

/** What {@link createTestLocation} makes. */
export interface TestLocation {
  /** The location's root, an absolute path: it holds `runs/` and the clock file. */
  readonly root: string;
  /** The runs folder a `JsonFileStore` is opened on: `<root>/runs`. */
  readonly runsDir: string;
  /** The location's clock. Its instant IS the clock file: moving it writes the file. */
  readonly clock: SettableClock;
  /**
   * Deletes what the location made, and nothing else (#715 (a) correction 2, R-1): the clock file
   * always; `runs/` (with the location's run files) only if the location created it; then each folder
   * it created between the first one and the root, deepest first, each only if it is then empty — it
   * stops at the first one that is not, quietly. A root you gave keeps everything else in it. A
   * folder the location makes itself, when no `root` is given, is deleted whole.
   */
  remove(): Promise<void>;
}

/**
 * Makes a test location (D6-1, D6-54): `root` (a fresh folder under the system temp folder unless
 * given), `<root>/runs/`, and the clock file `.realm-test-clock` beside it, created for this root and
 * holding `start`. A given root is made absolute at once (a later `chdir` cannot redirect
 * `remove()`); an empty one, the working directory or a folder above it is refused, and so is a root
 * that already holds a clock file. Its `clock` is a {@link SettableClock} whose instant is the file:
 * `now()` re-reads the file, and the instant is written back (by rename) before each waiter runs and
 * when an advance ends — so a store opened on `runsDir`, in this process or another, reads the same
 * time.
 *
 * `remove()` deletes only what this call made (#715 (a) correction 2, R-1): the clock file; `runs/`
 * only if this call made it; each folder this call made from the root up to the first one, deepest
 * first, with a non-recursive `rmdir`, stopping quietly at the first that is not empty or cannot be
 * removed (as CPython's `os.removedirs` and GNU `rmdir -p` do: what is left is litter, never data
 * loss); and the fresh folder made when no `root` is given, whole (its name is unique; as Python's
 * `TemporaryDirectory` and Rust's `tempfile::TempDir` do). What this call made is read from `mkdir`'s
 * own answer: the first folder a recursive `mkdir` created (`undefined` when every folder existed).
 */
export async function createTestLocation(options: {
  start: Date | string;
  root?: string;
}): Promise<TestLocation> {
  let root: string;
  // The first folder this call created for the root (a chain: it holds the rest), if any.
  let createdRoot: string | undefined;
  // Whether the root is a fresh `mkdtemp` folder this call made (no `root` given).
  let fresh = false;
  if (options.root !== undefined) {
    if (options.root === '') {
      throw new Error('a test location needs a root folder: the given root is empty');
    }
    root = resolve(options.root);
    const up = relative(root, process.cwd());
    if (up === '' || (!up.startsWith('..') && !isAbsolute(up))) {
      throw new Error(
        `${root} is the working directory or a folder above it: a test location cannot be made there`,
      );
    }
    if (existsSync(join(root, TEST_CLOCK_FILE_NAME))) {
      throw new Error(`${root} already holds a test location's clock file`);
    }
    createdRoot = await mkdir(root, { recursive: true });
  } else {
    root = await mkdtemp(join(tmpdir(), 'realm-test-location-'));
    createdRoot = root;
    fresh = true;
  }
  // The folders this call made for the root, deepest first: the root, its parent, … up to the first
  // folder `mkdir` created (empty when the root already existed).
  const made: string[] = [];
  if (createdRoot !== undefined && !fresh) {
    let dir = createdRoot;
    made.push(dir);
    for (const segment of relative(createdRoot, root)
      .split(sep)
      .filter((s) => s !== '')) {
      dir = join(dir, segment);
      made.push(dir);
    }
    made.reverse();
  }
  const runsDir = join(root, 'runs');
  const createdRuns = await mkdir(runsDir, { recursive: true });
  const start = options.start instanceof Date ? options.start : new Date(options.start);
  if (!Number.isFinite(start.getTime()))
    throw new RangeError('a test location needs a valid start');
  await writeTestClockFile(root, start);
  const clockFile = join(root, TEST_CLOCK_FILE_NAME);
  const file = fileClock(clockFile);
  const clock = settableClockOver({
    read: () => file.now().getTime(),
    write: (ms) => writeTestClockFile(root, new Date(ms)),
  });
  return {
    root,
    runsDir,
    clock,
    remove: async () => {
      await rm(clockFile, { force: true });
      if (createdRuns !== undefined) await rm(createdRuns, { recursive: true, force: true });
      if (fresh) {
        await rm(root, { recursive: true, force: true });
        return;
      }
      for (const dir of made) {
        try {
          await rmdir(dir);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          // Already gone, or a file now stands there: nothing of ours to remove; go on up.
          if (code === 'ENOENT' || code === 'ENOTDIR') continue;
          // Not empty (it holds something that is not ours, so every folder above it does too), or
          // any other error: leave it and stop, without throwing.
          return;
        }
      }
    },
  };
}
