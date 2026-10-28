// test-location.ts — issue #715 (a) (D6-1, D6-54): a TEST LOCATION — a store directory whose clock is
// a file beside its `runs/` folder, so every process that opens a store there (this one, a spawned
// `realm` command, a spawned MCP server) reads the same time, which the test moves.
//
// Production code never creates one: a lint rule and a source scan keep `createTestLocation` out of
// every production module (D6-52; #715 (a) correction 1, C-2).
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
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
   * Deletes the folders and the clock file the location made: the clock file always; `runs/` only
   * if the location created it; the root only if the location created it. A root you gave keeps
   * everything else.
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
 * `remove()` deletes only what this call made (#715 (a) correction 1, C-3; as Rust `tempfile`,
 * node-tmp and Go's `t.TempDir` do): what it made is read from `mkdir`'s own answer, the first folder
 * a recursive `mkdir` created (`undefined` when every folder already existed).
 */
export async function createTestLocation(options: {
  start: Date | string;
  root?: string;
}): Promise<TestLocation> {
  let root: string;
  // The first folder this call created for the root (a chain: it holds the rest), if any.
  let createdRoot: string | undefined;
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
      if (createdRoot !== undefined) await rm(createdRoot, { recursive: true, force: true });
    },
  };
}
