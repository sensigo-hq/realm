// test-clock-file.ts — issue #715 (a) (D6-1, D6-53, D6-54; the file's name is #715's D-4): the clock
// file of a TEST LOCATION. A test location is a store directory that only `@sensigo/realm-testing`
// creates (`createTestLocation`); it carries its own settable clock in a small file beside the store's
// `runs/` folder, and every process that opens that location reads its time from the file. A store
// on an ordinary directory has no such file and uses the host's system clock. Nothing in production
// writes this file, and a lint rule (static imports) and a source scan (the names as text, in any
// import form; `lint-test-location-715.test.ts`) keep the helpers that create a test location, or read
// its clock file outside the store, out of production code (D6-52): `resolveRootClock` below is the
// one reader (the file store's `resolveStoreClock` calls it). The scan reads the `.ts` and `.mjs`
// files of the four packages' `src` folders (no `.sh` or `.json`) and skips `*.test.ts`, whose tests
// create test locations.
import { accessSync, constants, readFileSync, realpathSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { WorkflowError } from '../types/workflow-error.js';
import { markTestClock, reportWaiterError, systemClock, type Clock } from '../utils/clock.js';
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

/** Whether this user can search `dir` (and so see what is in it). */
function searchable(dir: string): boolean {
  try {
    accessSync(dir, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a clock file (synchronously). Absent ⇒ `undefined`, and so is a file in a folder this user
 * cannot search (#715 (a) correction 1, C-10: as before this unit, a store there opens on the system
 * clock, and its first use refuses the unreadable runs folder with its typed line and remedy), and a
 * path through a regular file (#616 PR-1a unit 11, `ENOTDIR`: a root that is a file, or under one,
 * holds no clock file; the store's own open then refuses that root with its own typed line). A file
 * that exists but cannot be read throws a plain `Error` naming the file and the two ways out; one that
 * is not this format throws naming the file — never its content. For `@sensigo/realm-testing`, not
 * for hosts.
 */
export function readTestClockFile(path: string): TestClockFile | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    if ((code === 'EACCES' || code === 'EPERM') && !searchable(dirname(path))) return undefined;
    throw new Error(
      `The test clock file ${path} cannot be read (${code ?? 'no error code'}). To use this folder as an ordinary store, delete its clock file (${path}); to keep it as a test location, give this user read access to the file.`,
      { cause: err },
    );
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
 * #715 (b) (02 §C.1, D6-53): the clocks of test LOCATIONS alone (a file clock) — private to core, a
 * `WeakSet` beside the set of all test clocks (`markTestClock`). A process opening a store whose clock
 * is in it says so once on stderr (the hosts' notice).
 */
const FILE_CLOCKS = new WeakSet<Clock>();

function markFileClock(clock: Clock): Clock {
  FILE_CLOCKS.add(clock);
  return markTestClock(clock);
}

/** #715 (b) (02 §C.1): whether `clock` is a test location's file clock. */
export function isTestLocationClock(clock: Clock): boolean {
  return FILE_CLOCKS.has(clock);
}

/** #715 (b) (03 §A.2): the real-time poll of a test location's clock while a waiter exists. */
export const FILE_CLOCK_POLL_MS = 100;

/**
 * #715 (b) (03 §A.2, D-23): how many polls in a row may find the clock file unreadable (or gone)
 * before its waiters fail into the sink — one unreadable tick (a rename in flight, a busy disk) is no
 * change; a file that stays unreadable for this long (5 s at the poll's pace) is gone.
 */
export const FILE_CLOCK_UNREADABLE_TICKS = 50;

/** The `fs.watch` shape the file clock uses; a test passes one that fails (03 §A.2's seam). */
export type FolderWatch = (
  folder: string,
  options: { persistent: false },
  listener: () => void,
) => {
  close(): void;
  on(event: 'error', listener: (err: unknown) => void): unknown;
  unref?(): unknown;
};

interface FileWaiter {
  readonly whenMs: number;
  readonly fn: () => void | Promise<void>;
}

/** One watcher and one poll per clock FILE per process, alive only while it has waiters (D-23). */
interface FileWatch {
  readonly waiters: Set<FileWaiter>;
  watcher: { close(): void } | undefined;
  poll: ReturnType<typeof setInterval> | undefined;
  unreadable: number;
}

const FILE_WATCHES = new Map<string, FileWatch>();

/** Runs `fn` once; a throw or rejection goes to the process's sink (never unhandled). */
function runWaiter(fn: () => void | Promise<void>): void {
  try {
    const out = fn();
    if (out !== undefined && typeof (out as PromiseLike<void>).then === 'function') {
      Promise.resolve(out).catch(reportWaiterError);
    }
  } catch (err) {
    reportWaiterError(err);
  }
}

function stopWatch(path: string, w: FileWatch): void {
  if (w.watcher !== undefined) {
    try {
      w.watcher.close();
    } catch {
      // Closing a watcher that already failed changes nothing.
    }
    w.watcher = undefined;
  }
  if (w.poll !== undefined) clearInterval(w.poll);
  w.poll = undefined;
  FILE_WATCHES.delete(path);
}

/**
 * One invalidation (a watch event or a poll tick): re-reads the clock file and runs every waiter whose
 * instant it has reached, once. A read that fails (or finds the file gone) is no change this tick;
 * {@link FILE_CLOCK_UNREADABLE_TICKS} in a row fail every waiter into the sink with that error.
 */
function checkFile(path: string, now: () => Date): void {
  const w = FILE_WATCHES.get(path);
  if (w === undefined) return;
  let nowMs: number;
  try {
    nowMs = now().getTime();
    w.unreadable = 0;
  } catch (err) {
    w.unreadable += 1;
    if (w.unreadable < FILE_CLOCK_UNREADABLE_TICKS) return;
    const failed = [...w.waiters];
    w.waiters.clear();
    stopWatch(path, w);
    for (let i = 0; i < failed.length; i += 1) reportWaiterError(err);
    return;
  }
  for (const waiter of [...w.waiters]) {
    if (nowMs >= waiter.whenMs && w.waiters.delete(waiter)) runWaiter(waiter.fn);
  }
  if (w.waiters.size === 0) stopWatch(path, w);
}

/**
 * Registers a waiter on the clock file at `path` (D-23): the first waiter of a file starts its watch
 * of the FOLDER (a rename-over replaces the file's inode, which a watch of the file itself misses) and
 * its {@link FILE_CLOCK_POLL_MS} poll, both unref'd; a watch that cannot start, or that reports an
 * error, leaves the poll alone. A `when` already past runs on the next tick.
 */
function registerFileWaiter(
  path: string,
  now: () => Date,
  watchFolder: FolderWatch,
  waiter: FileWaiter,
): () => void {
  let w = FILE_WATCHES.get(path);
  if (w === undefined) {
    const created: FileWatch = {
      waiters: new Set(),
      watcher: undefined,
      poll: undefined,
      unreadable: 0,
    };
    w = created;
    FILE_WATCHES.set(path, created);
    const tick = (): void => checkFile(path, now);
    created.poll = setInterval(tick, FILE_CLOCK_POLL_MS);
    created.poll.unref?.();
    try {
      const watcher = watchFolder(dirname(path), { persistent: false }, tick);
      watcher.on('error', () => {
        // The watch failed after it started (ENOSPC, a removed folder): the poll alone stays.
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
        if (created.watcher === watcher) created.watcher = undefined;
      });
      watcher.unref?.();
      created.watcher = watcher;
    } catch {
      // The watch could not start (ENOSPC, a file system with no events): the poll alone stays.
    }
  }
  const held = w;
  held.waiters.add(waiter);
  return (): void => {
    if (held.waiters.delete(waiter) && held.waiters.size === 0 && FILE_WATCHES.get(path) === held) {
      stopWatch(path, held);
    }
  };
}

/**
 * The clock of a test location (D6-54): `now()` re-reads the file at `path` on EVERY call, so a store
 * in another process sees the current instant, and returns a fresh `Date`. A file that can no longer
 * be read (or is gone) makes `now()` throw, so a write fails loud. `at(when, fn)` runs `fn` once when
 * the file's instant reaches `when` (03 §A.2, D-23): the folder is watched and polled every
 * {@link FILE_CLOCK_POLL_MS} while a waiter exists; a `when` already past runs on the next tick; the
 * cancel stops it; a waiter's failure, and a clock file that stays unreadable, go to the process's
 * waiter-error sink. Its latency limit: on a file system that delivers no change events (a network
 * mount; `/mnt/c` written from Windows under WSL2, microsoft/WSL#4739) the poll alone wakes it, within
 * {@link FILE_CLOCK_POLL_MS}. For `@sensigo/realm-testing`, not for hosts; a test never depends on a
 * test location's waiter firing (D6-1) — the in-process route is `settableClock` over an
 * `InMemoryStore`.
 */
export function fileClock(path: string): Clock {
  return fileClockWatchedBy(path, watch as unknown as FolderWatch);
}

/** {@link fileClock} with the folder watch given (03 §A.2's test seam). Private to core. */
export function fileClockWatchedBy(path: string, watchFolder: FolderWatch): Clock {
  const now = (): Date => {
    const file = readTestClockFile(path);
    if (file === undefined) throw new Error(`the test clock file ${path} is gone`);
    return new Date(file.instant);
  };
  return markFileClock({
    now,
    at(when: Date, fn: () => void | Promise<void>): () => void {
      const whenMs = when instanceof Date ? when.getTime() : Number.NaN;
      if (!Number.isFinite(whenMs)) throw new Error('Clock.at needs a valid Date for `when`');
      return registerFileWaiter(path, now, watchFolder, { whenMs, fn });
    },
  });
}

/**
 * The clock a store whose ROOT folder is `root` holds (D6-1, D6-53; #616 PR-1a unit 2): the root is the
 * folder that holds the clock file (a JSON store's is the parent of its `runs/`; a SQLite home's is the
 * folder of its database). No clock file in `root` ⇒ the shared system clock; a clock file created for
 * this location (its `location` equals the realpath of `root`, so a symlink to the location opens it)
 * ⇒ that file's clock; a clock file created for another location (a copied location) ⇒
 * `STATE_TEST_CLOCK_FOREIGN`; a file that cannot be read or is not a clock file ⇒
 * {@link readTestClockFile}'s refusal. A store's own reader: the lint rule and the source scan keep
 * it out of production code, as they keep the other readers.
 */
export function resolveRootClock(root: string): Clock {
  const path = join(root, TEST_CLOCK_FILE_NAME);
  const file = readTestClockFile(path);
  if (file === undefined) return systemClock;
  const here = realpathSync(root);
  if (file.location !== here) {
    throw new WorkflowError(
      // #715 (a) correction 1 (C-6): the way out that works in place comes first; the old first remedy
      // ("create a test location here") is refused on this very folder, which holds a clock file.
      `This store's clock file was created for ${file.location}, not ${here}. A store opened here would run on another location's test clock. To use this folder as an ordinary store, delete its clock file (${join(here, TEST_CLOCK_FILE_NAME)}); to keep the test location it came from, open the store at ${file.location}; to make a new test location, use createTestLocation on a folder that has none.`,
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

/**
 * The clock a `JsonFileStore` on `runsDir` holds: {@link resolveRootClock} of the parent of `runsDir`,
 * where the clock file sits beside `runs/`. Private to core.
 */
export function resolveStoreClock(runsDir: string): Clock {
  return resolveRootClock(dirname(runsDir));
}
