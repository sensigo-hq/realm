// test-clock-file-watch-715b.test.ts — issue #715 (b) 03 §A.2 (D-23, D6-54): a test location's clock
// runs waiters. A waiter is armed on a watch of the clock file's FOLDER and a 100 ms poll; every
// event and tick re-reads the file. Real timers, generous bounds (a waiter must run within 2 s).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  TEST_CLOCK_FILE_NAME,
  fileClock,
  fileClockWatchedBy,
  writeTestClockFile,
  type FolderWatch,
} from './test-clock-file.js';
import { clockErrorSink, resetClockErrorSinkForTest, setClockErrorSink } from '../utils/clock.js';

const T = Date.parse('2030-01-01T00:00:00.000Z');

let dir: string;
let path: string;
let sunk: string[];
let previous: ((err: unknown) => void) | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-715b-fileclock-'));
  path = join(dir, TEST_CLOCK_FILE_NAME);
  await writeTestClockFile(dir, new Date(T));
  previous = clockErrorSink();
  sunk = [];
  setClockErrorSink((err) => sunk.push((err as Error).message));
});

afterEach(async () => {
  if (previous !== undefined) setClockErrorSink(previous);
  else resetClockErrorSinkForTest();
  await rm(dir, { recursive: true, force: true });
});

/** Resolves when `ran()` is true, or after `ms`; returns whether it became true. */
async function within(ms: number, ran: () => boolean): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ran()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return ran();
}

/** Moves the location's clock to `ms` by writing a new file and renaming it over the old one. */
async function moveTo(ms: number): Promise<void> {
  await writeTestClockFile(dir, new Date(ms));
}

describe('#715 (b) 03 §A.2 — a test location’s clock runs its waiters', () => {
  it('W1 the file renamed past `when` wakes the waiter within 2 s; a second rename-over wakes it too', async () => {
    // (a) red when the waiter is armed on the FILE (a rename-over replaces its inode, and the second
    //     write is missed) and nothing polls; (b) prints whether it ran after each move.
    let ran = 0;
    fileClock(path).at(new Date(T + 60_000), () => {
      ran += 1;
    });
    await moveTo(T + 30_000);
    const early = await within(300, () => ran > 0);
    await moveTo(T + 61_000);
    const late = await within(2_000, () => ran > 0);
    expect({ early, late, ran, sunk }).toEqual({ early: false, late: true, ran: 1, sunk: [] });
  }, 15_000);

  it('W2 a waiter cancelled before its instant never runs', async () => {
    // (a) red when the cancel does not remove the waiter; (b) prints the runs.
    let ran = 0;
    const cancel = fileClock(path).at(new Date(T + 1_000), () => {
      ran += 1;
    });
    cancel();
    await moveTo(T + 2_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect({ ran, sunk }).toEqual({ ran: 0, sunk: [] });
  }, 15_000);

  it('W3 a waiter registered after its instant passed runs on the next tick', async () => {
    // (a) red when a past `when` waits for a file change that never comes; (b) prints whether it ran.
    let ran = 0;
    fileClock(path).at(new Date(T - 1_000), () => {
      ran += 1;
    });
    expect({ ran: await within(1_000, () => ran > 0), sunk }).toEqual({ ran: true, sunk: [] });
  }, 15_000);

  it('W4 with the folder watch failing — it throws ENOSPC, or it emits an error — the poll alone wakes the waiter, and no error escapes', async () => {
    // (a) red when the waiter is woken only by watch events (the poll path does not run), or when
    //     the watcher's 'error' is unhandled; (b) prints whether each waiter ran and what reached
    //     the sink.
    const throwing: FolderWatch = () => {
      const err = new Error('ENOSPC: System limit for number of file watchers reached') as Error & {
        code?: string;
      };
      err.code = 'ENOSPC';
      throw err;
    };
    const emitting: FolderWatch = () => {
      const watcher = Object.assign(new EventEmitter(), { close: () => {} });
      setTimeout(() => watcher.emit('error', new Error('watch failed after it started')), 10);
      return watcher;
    };
    let ranThrowing = 0;
    let ranEmitting = 0;
    fileClockWatchedBy(path, throwing).at(new Date(T + 1_000), () => {
      ranThrowing += 1;
    });
    // A second file in another folder, so each watch function has its own file (one watcher per file).
    const other = await mkdtemp(join(tmpdir(), 'realm-715b-fileclock-b-'));
    try {
      await writeTestClockFile(other, new Date(T));
      fileClockWatchedBy(join(other, TEST_CLOCK_FILE_NAME), emitting).at(
        new Date(T + 1_000),
        () => {
          ranEmitting += 1;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await moveTo(T + 2_000);
      await writeTestClockFile(other, new Date(T + 2_000));
      const ok = await within(2_000, () => ranThrowing > 0 && ranEmitting > 0);
      expect({ ok, ranThrowing, ranEmitting, sunk }).toEqual({
        ok: true,
        ranThrowing: 1,
        ranEmitting: 1,
        sunk: [],
      });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  }, 15_000);

  it('W5 a clock file missing for one tick does not fail the waiter: it runs once the file is back past its instant', async () => {
    // (a) red when one unreadable tick fails the waiter into the sink; (b) prints the runs and the
    //     sink's messages.
    let ran = 0;
    fileClock(path).at(new Date(T + 1_000), () => {
      ran += 1;
    });
    await rm(path);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await moveTo(T + 2_000);
    expect({ ran: await within(2_000, () => ran > 0), sunk }).toEqual({ ran: true, sunk: [] });
  }, 15_000);

  it('W7 a clock file unreadable for 50 polls in a row fails every waiter into the sink, once each; none runs', async () => {
    // (a) red when the waiters wait forever on a file that is gone (the count never reached), or fail
    //     before 50 polls (at 2 s, 20 polls, the sink must still be empty); (b) prints the runs, the
    //     sink's message count at 2 s, and the messages with the folder replaced.
    let ran = 0;
    const clock = fileClock(path);
    clock.at(new Date(T + 1_000), () => {
      ran += 1;
    });
    clock.at(new Date(T + 2_000), () => {
      ran += 1;
    });
    await rm(path);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const early = sunk.length;
    await within(10_000, () => sunk.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect({ ran, early, sunk: sunk.map((m) => m.split(dir).join('<dir>')) }).toEqual({
      ran: 0,
      early: 0,
      sunk: [
        `the test clock file <dir>/${TEST_CLOCK_FILE_NAME} is gone`,
        `the test clock file <dir>/${TEST_CLOCK_FILE_NAME} is gone`,
      ],
    });
  }, 20_000);

  it('W6 a waiter whose `when` is not a valid Date is refused at registration', () => {
    // (a) red when an invalid `when` is accepted; (b) prints the message.
    expect(() => fileClock(path).at(new Date(Number.NaN), () => {})).toThrow(/valid Date/);
  });
});
