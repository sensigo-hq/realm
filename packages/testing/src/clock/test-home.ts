// test-home.ts — issue #616 PR-2c, unit c10a-0 (DELTAS row 55 (1), the design owner's ruling): a TEST
// HOME — a folder holding only the clock file `.realm-test-clock`, so a SQLite home opened there
// (`openRealmHome({ home: root })`) reads its time from the file, which the test moves. It makes no
// `runs/` folder: the SQLite home's legacy guard refuses a home holding one (the JSON store's), so a
// test location (`createTestLocation`, which makes `runs/` for the JSON store) cannot be one.
//
// No module outside `@sensigo/realm-testing` and tests creates one: the lint rule and the source scan
// that keep `createTestLocation` out of every other module (D6-52) name `createTestHome` too.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TEST_CLOCK_FILE_NAME, fileClock, writeTestClockFile } from '@sensigo/realm';
import { settableClockOver, type SettableClock } from './settable-clock.js';

/** What {@link createTestHome} makes. */
export interface TestHome {
  /** The home's root, an absolute path: it holds the clock file, and what a store opened there puts. */
  readonly root: string;
  /** The home's clock. Its instant IS the clock file: moving it writes the file. */
  readonly clock: SettableClock;
  /**
   * Deletes what the call made, and nothing else: the clock file always; on a root you gave, each
   * folder the call made from the root up to the first one, deepest first, each only if it is then
   * empty, stopping quietly at the first that is not, so `realm.db`, its side files and the fences a
   * store put there stay; a folder the call makes itself, when no `root` is given, whole, its contents
   * included (close a store opened there first).
   */
  remove(): Promise<void>;
}

/**
 * Makes a test home: `root` (a fresh folder under the system temp folder unless given) and the clock
 * file `.realm-test-clock` in it, created for this root and holding `start`; nothing else. A given root
 * is made absolute at once (a later `chdir` cannot redirect `remove()`); an empty one, the working
 * directory or a folder above it is refused, and so is a root that already holds a clock file, and an
 * invalid `start`, each before any folder is made. Its `clock` is a {@link SettableClock} whose instant
 * is the file: `now()` re-reads the file, and the instant is written back (by rename) before each
 * waiter runs and when an advance ends — so a store opened on `root`, in this process or another,
 * reads the same time.
 *
 * The root checks, the chain of folders this call made, and `remove()`'s loop are
 * `createTestLocation`'s (`test-location.ts`), written here again so that file stays as it is until
 * PR-3 deletes it with the JSON store; the refusals keep its sentences.
 */
export async function createTestHome(options: {
  start: Date | string;
  root?: string;
}): Promise<TestHome> {
  const start = options.start instanceof Date ? options.start : new Date(options.start);
  if (!Number.isFinite(start.getTime()))
    throw new RangeError('a test location needs a valid start');
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
    root = await mkdtemp(join(tmpdir(), 'realm-test-home-'));
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
  await writeTestClockFile(root, start);
  const clockFile = join(root, TEST_CLOCK_FILE_NAME);
  const file = fileClock(clockFile);
  const clock = settableClockOver({
    read: () => file.now().getTime(),
    write: (ms) => writeTestClockFile(root, new Date(ms)),
  });
  return {
    root,
    clock,
    remove: async () => {
      await rm(clockFile, { force: true });
      if (fresh) {
        await rm(root, { recursive: true, force: true });
        return;
      }
      for (const dir of made) {
        try {
          await rmdir(dir);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          // Already gone (ENOENT), or a symlink now stands where a folder we made was (ENOTDIR):
          // nothing of ours to remove; go on up.
          if (code === 'ENOENT' || code === 'ENOTDIR') continue;
          // Not empty (it holds something that is not ours: a store's file, so every folder above it
          // does too), or any other error: leave it and stop, without throwing.
          return;
        }
      }
    },
  };
}
