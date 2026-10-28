// test-location.ts — issue #715 (a) (D6-1, D6-54): a TEST LOCATION — a store directory whose clock is
// a file beside its `runs/` folder, so every process that opens a store there (this one, a spawned
// `realm` command, a spawned MCP server) reads the same time, which the test moves.
//
// Production code never creates one: a lint rule keeps `createTestLocation` out of every production
// module (D6-52).
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_CLOCK_FILE_NAME, fileClock, writeTestClockFile } from '@sensigo/realm';
import { settableClockOver, type SettableClock } from './settable-clock.js';

/** What {@link createTestLocation} makes. */
export interface TestLocation {
  /** The location's root: it holds `runs/` and the clock file. */
  readonly root: string;
  /** The runs folder a `JsonFileStore` is opened on: `<root>/runs`. */
  readonly runsDir: string;
  /** The location's clock. Its instant IS the clock file: moving it writes the file. */
  readonly clock: SettableClock;
  /** Deletes the root and everything in it. */
  remove(): Promise<void>;
}

/**
 * Makes a test location (D6-1, D6-54): `root` (a fresh folder under the system temp folder unless
 * given; a given root that already holds a clock file is refused), `<root>/runs/`, and the clock file
 * `.realm-test-clock` beside it, created for this root and holding `start`. Its `clock` is a
 * {@link SettableClock} whose instant is the file: `now()` re-reads the file, and the instant is
 * written back (by rename) before each waiter runs and when an advance ends — so a store opened on
 * `runsDir`, in this process or another, reads the same time.
 */
export async function createTestLocation(options: {
  start: Date | string;
  root?: string;
}): Promise<TestLocation> {
  let root: string;
  if (options.root !== undefined) {
    root = options.root;
    if (existsSync(join(root, TEST_CLOCK_FILE_NAME))) {
      throw new Error(`${root} already holds a test location's clock file`);
    }
    await mkdir(root, { recursive: true });
  } else {
    root = await mkdtemp(join(tmpdir(), 'realm-test-location-'));
  }
  const runsDir = join(root, 'runs');
  await mkdir(runsDir, { recursive: true });
  const start = options.start instanceof Date ? options.start : new Date(options.start);
  if (!Number.isFinite(start.getTime()))
    throw new RangeError('a test location needs a valid start');
  await writeTestClockFile(root, start);
  const file = fileClock(join(root, TEST_CLOCK_FILE_NAME));
  const clock = settableClockOver({
    read: () => file.now().getTime(),
    write: (ms) => writeTestClockFile(root, new Date(ms)),
  });
  return {
    root,
    runsDir,
    clock,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
