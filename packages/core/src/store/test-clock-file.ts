// test-clock-file.ts — issue #715 (a) (D6-1, D6-53, D6-54; the file's name is #715's D-4): the clock
// file of a TEST LOCATION. A test location is a store directory that only `@sensigo/realm-testing`
// creates (`createTestLocation`); it carries its own settable clock in a small file beside the store's
// `runs/` folder, and every process that opens that location reads its time from the file. A store
// on an ordinary directory has no such file and uses the host's system clock. Nothing in production
// writes this file, and a lint rule keeps the helpers that create or read it out of production code
// (D6-52).
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WorkflowError } from '../types/workflow-error.js';
import { systemClock, type Clock } from '../utils/clock.js';
import { atomicWriteFile } from './atomic-write.js';

/**
 * The clock file's name (D-4). It sits in the location's root, beside `runs/`, never inside it
 * (D6-54); it has no `.json` suffix, so nothing that reads a folder's `.json` files reads it.
 * For `@sensigo/realm-testing`, not for hosts.
 */
export const TEST_CLOCK_FILE_NAME = '.realm-test-clock';

/** The clock file's content: the format, the realpath of the location it was created for, the instant. */
export interface TestClockFile {
  readonly format: 1;
  readonly location: string;
  readonly instant: string;
}

/**
 * Where the clock file of the store whose runs directory is `runsDir` sits: in the parent of
 * `runsDir`, beside it. For `@sensigo/realm-testing`, not for hosts.
 */
export function testClockFilePath(runsDir: string): string {
  return join(dirname(runsDir), TEST_CLOCK_FILE_NAME);
}

/**
 * Writes the clock file of the location `root` (written by rename): `location` is the realpath of
 * `root`, `instant` the given instant with milliseconds. For `@sensigo/realm-testing`, not for hosts.
 */
export async function writeTestClockFile(root: string, instant: Date): Promise<void> {
  const file: TestClockFile = {
    format: 1,
    location: realpathSync(root),
    instant: instant.toISOString(),
  };
  await atomicWriteFile(join(root, TEST_CLOCK_FILE_NAME), JSON.stringify(file, null, 2));
}

/**
 * Reads a clock file (synchronously). Absent ⇒ `undefined`. A file that exists but cannot be read,
 * or is not this format, throws a plain `Error` naming the file — never its content. For
 * `@sensigo/realm-testing`, not for hosts.
 */
export function readTestClockFile(path: string): TestClockFile | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`the test clock file ${path} cannot be read`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`the test clock file ${path} is not a test clock file`);
  }
  const value = parsed as Partial<TestClockFile> | null;
  if (
    value === null ||
    typeof value !== 'object' ||
    value.format !== 1 ||
    typeof value.location !== 'string' ||
    typeof value.instant !== 'string' ||
    !Number.isFinite(Date.parse(value.instant))
  ) {
    throw new Error(`the test clock file ${path} is not a test clock file`);
  }
  return { format: 1, location: value.location, instant: value.instant };
}

/**
 * The clock of a test location (D6-54): `now()` re-reads the file at `path` on EVERY call, so a store
 * in another process sees the current instant, and returns a fresh `Date`. A file that can no longer
 * be read (or is gone) makes `now()` throw, so a write fails loud. `at()` throws: no code registers a
 * waiter on a store's clock until #715 (b), which gives this clock its watch with its first consumer
 * (the gate timer). For `@sensigo/realm-testing`, not for hosts.
 */
export function fileClock(path: string): Clock {
  return {
    now(): Date {
      const file = readTestClockFile(path);
      if (file === undefined) throw new Error(`the test clock file ${path} is gone`);
      return new Date(file.instant);
    },
    at(): () => void {
      throw new Error(
        "a test location's clock cannot run waiters until the unit that registers them (#715 (b)) is built",
      );
    },
  };
}

/**
 * The clock a `JsonFileStore` on `runsDir` holds (D6-1, D6-53): no clock file beside `runsDir` ⇒ the
 * shared system clock; a clock file created for this location (its `location` equals the realpath of
 * the parent of `runsDir`, so a symlink to the location opens it) ⇒ that file's clock; a clock file
 * created for another location (a copied location) ⇒ `STATE_TEST_CLOCK_FOREIGN`. Private to core.
 */
export function resolveStoreClock(runsDir: string): Clock {
  const path = testClockFilePath(runsDir);
  const file = readTestClockFile(path);
  if (file === undefined) return systemClock;
  const here = realpathSync(dirname(runsDir));
  if (file.location !== here) {
    throw new WorkflowError(
      `This store's clock file was created for ${file.location}, not ${here}. A store opened here would run on another location's test clock. Create a test location here with \`createTestLocation\`, or open the store at ${file.location}.`,
      {
        code: 'STATE_TEST_CLOCK_FOREIGN',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      },
    );
  }
  return fileClock(path);
}
