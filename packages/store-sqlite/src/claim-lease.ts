// claim-lease.ts — issue #729, the claim window, unit CW-1 (design record C5 §4.1): the SQLite store's
// claim leases. A lease is a small SQLite file in `<home>/claim-leases/` on which the holding program
// keeps a write transaction open; the operating system keeps that lock for exactly as long as the
// program runs and lets go of it the moment the program ends, however it ends. Any program can ask,
// in a few milliseconds and without waiting on the holder, whether a lease is held: it tries the same
// lock once (and once more after about 2 ms), and only a lock it took itself proves `not_held`.
//
// This module is the only code that opens a lease file, and it makes `claim-leases/` itself (the
// home's preparation never does). It reads no clock: the retry is a timer, not a clock read. Its
// databases share nothing with `realm.db`: their own connections through the one loader, their own
// `application_id`, the rollback journal. It never sweeps a lease file: only the program that made one
// deletes it, in `close()`.
//
// Load-bearing, each measured (the design's probes):
//   - a hold stays referenced in a module-level registry until `close()`: a connection the garbage
//     collector frees lets go of its lock (CW-PR-09);
//   - in the holding program, nothing but this module opens a lease file, and the module never opens
//     its own held file: a plain open and close of the file in that program lets go of the lock
//     (CW-PR-02). A probe of an id this program holds answers from the registry, opening nothing;
//   - the creating descriptor and the initialising connection are closed before the holding
//     connection opens, for the same reason;
//   - a probe opens read-write and never creates: a read-only connection cannot see a hold, and a
//     plain open creates a missing file (CW-PR-06, CW-PR-07); an unwritable file is never opened at
//     all, since SQLite opens it read-only without saying so (CW-CC-02, CW-P2I2-12);
//   - the probe's URL is built by `pathToFileURL`, never by joining strings: a `#` or `?` in the home's
//     path breaks a joined one (CW-AU1-03).
import {
  accessSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  LeaseFact,
  LeaseHold,
  LeaseHoldResult,
  LeasePort,
  LeaseProbeReason,
  LeaseUnavailableReason,
  RunRecord,
} from '@sensigo/realm';
import { openDatabase, type DatabaseLike } from './driver.js';

/** The folder in a Realm home that holds the claim leases (framework row 25: one of Realm's own names). */
export const CLAIM_LEASES_FOLDER = 'claim-leases';

/** A lease file's name ends with this; what comes before it is the lease's id. */
export const LEASE_FILE_SUFFIX = '.lease';

/** `PRAGMA application_id` of a lease file: ASCII "LEAS" (a `realm.db` is "REAL"). */
export const LEASE_APPLICATION_ID = 0x4c454153;

/** The wait before a probe's one retry of a busy lock, in milliseconds (a timer, not a clock read). */
const RETRY_MS = 2;

/** How many ids `hold()` mints before it gives up on finding one whose file does not exist yet. */
const MINT_ATTEMPTS = 3;

/** SQLite's primary result codes the module reads. */
const SQLITE_PERM = 3;
const SQLITE_BUSY = 5;
const SQLITE_READONLY = 8;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;
const SQLITE_AUTH = 23;

/** The open holds of this process, by their file's path: the connection that keeps each lock. */
const HOLDS = new Map<string, DatabaseLike>();

/**
 * The store's test seams (package-internal; the package's entry does not export this module's port
 * factory with them). `mintId` replaces the id minting; `initialise` replaces the write that makes a
 * new file a lease, so a test can make it fail after the file was created.
 */
export interface LeaseSeams {
  mintId?: () => string;
  initialise?: (db: DatabaseLike) => void;
}

const HELD: LeaseFact = { state: 'held', basis: 'kernel_lock' };
const NOT_HELD: LeaseFact = { state: 'not_held', basis: 'kernel_lock' };
const ABSENT: LeaseFact = { state: 'absent', basis: 'kernel_lock' };

function unknown(reason: LeaseProbeReason): LeaseFact {
  return { state: 'unknown', basis: 'kernel_lock', reason };
}

/** The lease file of `id` in `folder`. */
export function leaseFile(folder: string, id: string): string {
  return join(folder, `${id}${LEASE_FILE_SUFFIX}`);
}

/** A read-write, never-creating SQLite URL for `path`: SQLite refuses a missing file instead of making it. */
function readWriteUrl(path: string): string {
  const url = pathToFileURL(path);
  url.searchParams.set('mode', 'rw');
  return url.href;
}

/** The operating system's error name (`EACCES`), when the error carries one. */
function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** SQLite's primary result code of a database error: its `errcode` is the extended code (1544 is 8). */
function sqlitePrimary(err: unknown): number | undefined {
  const errcode = (err as { errcode?: unknown } | null | undefined)?.errcode;
  return typeof errcode === 'number' ? errcode & 0xff : undefined;
}

function isPermissionErrno(code: string | undefined): boolean {
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

/** Why `hold()` failed, from the error a step gave. */
function unavailableReason(err: unknown): LeaseUnavailableReason {
  const primary = sqlitePrimary(err);
  if (primary !== undefined) {
    if (primary === SQLITE_PERM || primary === SQLITE_READONLY || primary === SQLITE_AUTH)
      return 'permission';
    return primary === SQLITE_FULL ? 'no_space' : 'io_error';
  }
  const code = errnoOf(err);
  if (isPermissionErrno(code)) return 'permission';
  if (code === 'ENOSPC') return 'no_space';
  if (code === 'EMFILE' || code === 'ENFILE') return 'too_many_files';
  return 'io_error';
}

/** A probe's reason for an error from a file-system check: `permission` or `io_error`. */
function checkReason(err: unknown): LeaseProbeReason {
  return isPermissionErrno(errnoOf(err)) ? 'permission' : 'io_error';
}

function rollbackQuietly(db: DatabaseLike): void {
  try {
    if (db.isTransaction) db.exec('ROLLBACK');
  } catch {
    // The connection is closed next; a failed rollback leaves nothing a close does not end.
  }
}

function closeQuietly(db: DatabaseLike): void {
  try {
    db.close();
  } catch {
    // Already closed, or closing failed: nothing more this module can do with it.
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Gone already counts as deleted; any other failure is skipped.
  }
}

/** The write that makes a new, empty file a lease: its `application_id`, in its own short transaction. */
function initialiseLease(db: DatabaseLike): void {
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('BEGIN IMMEDIATE');
  db.exec(`PRAGMA application_id = ${LEASE_APPLICATION_ID}`);
  db.exec('COMMIT');
}

/** Whether a step's claim in `record` names the lease `id`. */
function recordNamesLease(record: RunRecord, id: string): boolean {
  return Object.values(record.claims ?? {}).some((claim) => claim?.lease?.id === id);
}

/** One try at the lease's write lock on a probe's connection: taken (and given back at once), busy, or failed. */
function tryLock(db: DatabaseLike): 'taken' | 'busy' | 'failed' {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    return sqlitePrimary(err) === SQLITE_BUSY ? 'busy' : 'failed';
  }
  rollbackQuietly(db);
  return 'taken';
}

function makeHold(id: string, path: string, db: DatabaseLike): LeaseHold {
  let open = true;
  return {
    id,
    close(newestRecord?: RunRecord): void {
      if (!open) return;
      open = false;
      try {
        rollbackQuietly(db);
        closeQuietly(db);
      } finally {
        if (HOLDS.get(path) === db) HOLDS.delete(path);
      }
      try {
        if (newestRecord !== undefined && !recordNamesLease(newestRecord, id)) unlinkQuietly(path);
      } catch {
        // A record this module cannot read keeps the file: it stays, and reads `not_held`.
      }
    },
  };
}

function holdLease(folder: string, seams: LeaseSeams): LeaseHoldResult {
  let created: string | undefined;
  let db: DatabaseLike | undefined;
  try {
    try {
      mkdirSync(folder, { mode: 0o700 });
    } catch (err) {
      if (errnoOf(err) !== 'EEXIST') throw err;
    }
    let id = '';
    let path = '';
    let fd: number | undefined;
    for (let attempt = 1; fd === undefined; attempt += 1) {
      id = (seams.mintId ?? randomUUID)();
      path = leaseFile(folder, id);
      try {
        fd = openSync(path, 'wx', 0o600);
      } catch (err) {
        // An id whose file exists is never reused, and that file is never written.
        if (errnoOf(err) !== 'EEXIST' || attempt >= MINT_ATTEMPTS) throw err;
      }
    }
    created = path;
    try {
      db = openDatabase(readWriteUrl(path));
      (seams.initialise ?? initialiseLease)(db);
      closeQuietly(db);
      db = undefined;
    } finally {
      closeSync(fd);
    }
    db = openDatabase(readWriteUrl(path));
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
    HOLDS.set(path, db);
    return { held: makeHold(id, path, db) };
  } catch (err) {
    if (db !== undefined) {
      rollbackQuietly(db);
      closeQuietly(db);
    }
    if (created !== undefined) {
      unlinkQuietly(created);
      unlinkQuietly(`${created}-journal`);
    }
    return { unavailable: unavailableReason(err) };
  }
}

/**
 * Whether `id` can name a lease: not empty, not `.` or `..`, and holding no `/`, `\` or NUL. Any
 * other id would point the probe at a path outside `claim-leases/` (an id comes from a stored claim,
 * which an imported or damaged record can hold). `hold()` mints its own ids and never checks them.
 */
function isLeaseName(id: string): boolean {
  return id !== '' && id !== '.' && id !== '..' && !/[/\\\0]/.test(id);
}

async function probeLease(folder: string, id: string): Promise<LeaseFact> {
  // An id that is not a plain name: the probe opens and checks nothing.
  if (!isLeaseName(id)) return unknown('not_a_lease');
  const path = leaseFile(folder, id);
  // An id this program holds: the answer is the registry's, and the file is never opened here.
  if (HOLDS.has(path)) return HELD;
  try {
    statSync(path);
  } catch (err) {
    return errnoOf(err) === 'ENOENT' ? ABSENT : unknown(checkReason(err));
  }
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
  } catch (err) {
    // ENOENT here: the file vanished between the two checks (only the stat answers `absent`).
    return unknown(checkReason(err));
  }
  let db: DatabaseLike;
  try {
    db = openDatabase(readWriteUrl(path));
  } catch (err) {
    return unknown(sqlitePrimary(err) === SQLITE_CANTOPEN ? 'cannot_open' : 'io_error');
  }
  try {
    let applicationId: number;
    try {
      applicationId = Number(db.prepare('PRAGMA application_id').get()?.['application_id']);
    } catch {
      return unknown('not_a_lease');
    }
    if (applicationId !== LEASE_APPLICATION_ID) return unknown('not_a_lease');
    db.exec('PRAGMA busy_timeout = 0');
    const first = tryLock(db);
    if (first !== 'busy') return first === 'taken' ? NOT_HELD : unknown('io_error');
    await new Promise<void>((resolve) => setTimeout(resolve, RETRY_MS));
    const second = tryLock(db);
    if (second === 'failed') return unknown('io_error');
    return second === 'busy' ? HELD : NOT_HELD;
  } finally {
    closeQuietly(db);
  }
}

/**
 * The claim leases of the Realm home `home` (an absolute path; the home `openRealmHome` opened).
 * `hold()` and `probe()` never reject.
 */
export function createLeasePort(home: string, seams: LeaseSeams = {}): LeasePort {
  const folder = join(home, CLAIM_LEASES_FOLDER);
  return {
    hold: () => {
      try {
        return Promise.resolve(holdLease(folder, seams));
      } catch {
        return Promise.resolve({ unavailable: 'io_error' });
      }
    },
    probe: (id: string) => probeLease(folder, id).catch(() => unknown('io_error')),
  };
}
