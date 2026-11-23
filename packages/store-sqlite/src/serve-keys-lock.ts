// serve-keys-lock.ts — #625 PR-2b, named keys unit 1: the lock a `realm serve key` command holds for
// the whole read–change–write of a Realm home's `serve-keys.json`, so two commands at once never lose
// a change (a lost remove would leave a cut-off key working).
//
// The lock works as the claim leases do (`claim-lease.ts`): a SQLite write transaction kept open on a
// small file in the home, `serve-keys.lock`. The operating system keeps that lock for exactly as long
// as the holding program runs and lets go of it the moment the program ends, however it ends, so a
// killed command never leaves a lock behind. It is not a lease and opens no lease file. The file holds
// nothing: no row is ever written, so no journal file is made beside it.
//
// Load-bearing, as measured for the leases (plans/facts-claim-window.md):
//   - a held lock's connection stays referenced in a module-level set until it is released: a
//     connection the garbage collector frees lets go of its lock (CW-PR-09);
//   - nothing in the holding program opens `serve-keys.lock` with plain `fs`: a plain open and close of
//     the file in that program lets go of the lock (CW-PR-02). Only this module opens it.
// The wait is a count of timer ticks, never a clock read.
import { join } from 'node:path';
import { openDatabase, type DatabaseLike } from './driver.js';

/** The lock file's name in a Realm home. */
export const SERVE_KEYS_LOCK_FILE = 'serve-keys.lock';

/** SQLite's primary result code for a lock another connection holds. */
const SQLITE_BUSY = 5;

/** How long a command waits for the lock, as ticks of a timer: 100 × 50 ms, about 5 seconds. */
const WAIT_TICKS = 100;
const TICK_MS = 50;

/** The held locks of this process: each connection stays referenced while it holds its lock. */
const HELD = new Set<DatabaseLike>();

/** A taken lock. `release()` lets go of it; a second call does nothing. */
export interface ServeKeysLock {
  release(): void;
}

/**
 * What {@link takeServeKeysLock} found: the lock, taken; `busy` when another command still held it
 * after the wait; or `failed` with the cause (the system's error code, such as `EACCES`, or
 * SQLite's result code by name, such as `SQLITE_CANTOPEN`, when it gives no system code).
 */
export type ServeKeysLockResult =
  { readonly taken: ServeKeysLock } | { readonly busy: true } | { readonly failed: string };

/** Options for tests: how many ticks to wait, and how long each is. */
export interface ServeKeysLockWait {
  readonly ticks?: number;
  readonly tickMs?: number;
}

/** SQLite's primary result codes by number (sqlite.org/rescode.html), for the cause word. */
const SQLITE_NAMES = [
  'OK',
  'ERROR',
  'INTERNAL',
  'PERM',
  'ABORT',
  'BUSY',
  'LOCKED',
  'NOMEM',
  'READONLY',
  'INTERRUPT',
  'IOERR',
  'CORRUPT',
  'NOTFOUND',
  'FULL',
  'CANTOPEN',
  'PROTOCOL',
  'EMPTY',
  'SCHEMA',
  'TOOBIG',
  'CONSTRAINT',
  'MISMATCH',
  'MISUSE',
  'NOLFS',
  'AUTH',
  'FORMAT',
  'RANGE',
  'NOTADB',
  'NOTICE',
  'WARNING',
];

/** The cause word: the system's error code (`EACCES`), else SQLite's result code by name. */
function causeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) return code;
  const errcode = (err as { errcode?: unknown } | null | undefined)?.errcode;
  if (typeof errcode !== 'number') return 'unknown error';
  const name = SQLITE_NAMES[errcode & 0xff];
  return name !== undefined ? `SQLITE_${name}` : `SQLITE_${errcode & 0xff}`;
}

function isBusy(err: unknown): boolean {
  const errcode = (err as { errcode?: unknown } | null | undefined)?.errcode;
  return typeof errcode === 'number' && (errcode & 0xff) === SQLITE_BUSY;
}

function closeQuietly(db: DatabaseLike): void {
  try {
    db.close();
  } catch {
    // Already closed, or closing failed: the lock ends with the connection either way.
  }
}

/**
 * Takes the lock of the Realm home `home` (an absolute folder that exists), waiting about 5 seconds
 * while another command holds it. Never rejects.
 */
export async function takeServeKeysLock(
  home: string,
  wait: ServeKeysLockWait = {},
): Promise<ServeKeysLockResult> {
  const ticks = wait.ticks ?? WAIT_TICKS;
  const tickMs = wait.tickMs ?? TICK_MS;
  let db: DatabaseLike;
  try {
    db = openDatabase(join(home, SERVE_KEYS_LOCK_FILE));
    db.exec('PRAGMA busy_timeout = 0');
  } catch (err) {
    return { failed: causeOf(err) };
  }
  for (let tick = 0; ; tick += 1) {
    try {
      db.exec('BEGIN IMMEDIATE');
      break;
    } catch (err) {
      if (!isBusy(err)) {
        closeQuietly(db);
        return { failed: causeOf(err) };
      }
      if (tick >= ticks) {
        closeQuietly(db);
        return { busy: true };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, tickMs));
    }
  }
  HELD.add(db);
  let held = true;
  return {
    taken: {
      release(): void {
        if (!held) return;
        held = false;
        try {
          db.exec('ROLLBACK');
        } catch {
          // Closing the connection ends the transaction too.
        }
        closeQuietly(db);
        HELD.delete(db);
      },
    },
  };
}
