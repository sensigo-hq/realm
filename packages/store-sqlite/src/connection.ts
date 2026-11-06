// connection.ts — issue #616 PR-1a unit 8: THE WRITE PATH. `RealmDb` is the one class every statement
// Realm sends to a store file goes through, in one of three forms (design §2, "Every statement that
// touches the file goes through one primitive"):
//   - `autocommit(body)`: no transaction (the open's pragmas, checkpoints, a copy of the file);
//   - `snapshot(body)`: a read transaction, `query_only` on for the body;
//   - `immediate(body, verify)`: a write transaction, `BEGIN IMMEDIATE`.
// It is built over a connection it is GIVEN, with a `reopen` function for that connection's file
// (opening a home is unit 7's; the COMMIT outcome protocol, which uses `verify` and the in-process
// lock, is unit 9's: until then a COMMIT error rolls back and throws the mapped error).
//
// The rules all three forms share:
//   - a body is synchronous, so a transaction never spans an await: a body whose type returns a
//     promise (or any thenable) does not compile, and a returned promise is refused at run time;
//   - on ANY error the transaction is rolled back, swallowing only "no transaction is active" (after
//     a full disk SQLite has rolled back by itself, and an unguarded ROLLBACK would hide the real
//     error behind its own);
//   - a busy store (`errcode & 0xff == 5`) is waited for ASYNCHRONOUSLY, a flat 5-50 ms at a time, up
//     to the busy budget, then refused with `STATE_RUN_BUSY`; the event loop is blocked at most for
//     the connection's own busy timeout per attempt ({@link BUSY_SLICE_MS}, set by the open). The
//     budget counts from the call, so time spent queued behind this process's other calls counts
//     too; a call whose budget passed in the queue still makes one attempt before it is refused;
//   - every SQLite error leaves the class mapped ({@link mapSqliteError}), none raw;
//   - a call that starts while a transaction is open on the connection (only possible from code that
//     runs inside it: a clock's `now()` under the lock, or a body) is refused, and so is the
//     transaction it was made in;
//   - one in-process lock (a flag and a first-in-first-out queue) keeps two calls of one process from
//     interleaving on the one connection; when it is free it is taken synchronously, so an
//     uncontended `immediate` reaches its COMMIT before the call returns its promise.
//
// The reading: each call takes ONE raw reading of the clock it is given (`takeRawReading`), and the
// body floors it itself with core's pure functions. `snapshot` takes it BEFORE its BEGIN and before
// the in-process lock (so a clock whose `now()` writes to the store lands that write before the
// snapshot starts); `immediate` takes it right after `BEGIN IMMEDIATE` and the `user_version` re-read,
// unless the call opted out with `{ takesReading: false }`.
import { REALM_STORE_SCHEMA_VERSION, takeRawReading, WorkflowError } from '@sensigo/realm';
import type { Clock } from '@sensigo/realm';
import type { DatabaseLike } from './driver.js';

/** How long a call waits for a busy store before it is refused (parity with the JSON store's wait). */
export const DEFAULT_BUSY_BUDGET_MS = 5_000;

/**
 * The connection's own busy timeout, in milliseconds: the longest one attempt blocks the event loop
 * while SQLite waits for another writer. The open sets it on every connection (unit 7b).
 */
export const BUSY_SLICE_MS = 20;

/** The flat jitter of one asynchronous wait between two attempts on a busy store. */
const BUSY_WAIT_MIN_MS = 5;
const BUSY_WAIT_MAX_MS = 50;

/** The write's own content check, kept for the COMMIT outcome protocol (unit 9). */
export type Verify<T> = (db: DatabaseLike, result: T) => boolean;

/** Anything with a callable `then`: a promise, or any other thenable. */
type Thenable = { readonly then: (...args: never) => unknown };

/**
 * A body's result: anything but a thenable. A body typed to return a promise (an `async` arrow, a
 * `Promise.resolve`, a union that may be one) does not compile, because the code after its first
 * `await` would run outside the transaction and the lock; every synchronous result keeps its type.
 */
type SyncResult<T> = T extends Thenable ? never : T;

/** What a `RealmDb` is built over, besides its connection. */
export interface RealmDbOptions {
  /** The clock every reading is taken from. */
  readonly clock: Clock;
  /** Opens a fresh connection to the same file, with its pragmas applied (unit 7 supplies it). */
  readonly reopen: () => DatabaseLike;
  /** How long a call waits for a busy store, in milliseconds; {@link DEFAULT_BUSY_BUDGET_MS} if left out. */
  readonly budgetMs?: number;
}

/** The shape of an error Node's SQLite throws: `code` is always `ERR_SQLITE_ERROR`. */
interface SqliteError extends Error {
  code: 'ERR_SQLITE_ERROR';
  errcode: number;
  errstr?: string;
}

function isSqliteError(err: unknown): err is SqliteError {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === 'ERR_SQLITE_ERROR' &&
    typeof (err as { errcode?: unknown }).errcode === 'number'
  );
}

/** The busy family: 5 and its extended codes (261 recovery, 517 snapshot, 773 timeout). */
function isBusy(err: unknown): boolean {
  return isSqliteError(err) && (err.errcode & 0xff) === 5;
}

/** SQLite's answer to a BEGIN on a connection that already has a transaction open. */
function isNestedBegin(err: unknown): boolean {
  return isSqliteError(err) && err.message === 'cannot start a transaction within a transaction';
}

/** SQLite's answer to a ROLLBACK when no transaction is open (it already rolled back by itself). */
function isNoActiveTransaction(err: unknown): boolean {
  return isSqliteError(err) && err.message.includes('no transaction is active');
}

/** A plain error that carries SQLite's own code and text (the unmapped remainder, a programming error). */
function plainSqliteError(err: SqliteError, message: string): Error {
  return Object.assign(new Error(message, { cause: err }), {
    errcode: err.errcode,
    errstr: err.errstr,
  });
}

function storeFullError(): WorkflowError {
  return new WorkflowError(
    "The Realm store could not be written: its disk, or the database's size limit, is full. " +
      'Nothing was written. Free space, then try again.',
    {
      code: 'STATE_STORE_FULL',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
    },
  );
}

function versionNewerError(file: number): WorkflowError {
  return new WorkflowError(
    `This store was migrated by a newer Realm: its schema is version ${file} and this Realm writes ` +
      `version ${REALM_STORE_SCHEMA_VERSION}. Upgrade Realm to read or write it.`,
    {
      code: 'STATE_STORE_VERSION_NEWER',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { file, realm: REALM_STORE_SCHEMA_VERSION },
    },
  );
}

function busyError(budgetMs: number): WorkflowError {
  return new WorkflowError(
    `The store was busy for ${budgetMs / 1000} s: another writer held it. Nothing was written. ` +
      'Try again.',
    {
      code: 'STATE_RUN_BUSY',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: true,
      details: { budget_ms: budgetMs },
    },
  );
}

function nestedCallError(): Error {
  return new Error(
    'A store call was made while a store transaction was open on this connection (a clock or a ' +
      'transaction body called back into the store). This is a bug in the caller. Nothing was written.',
  );
}

/** A body's result that is a promise (or any thenable): bodies are synchronous. */
function refuseThenable(result: unknown): void {
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    throw new Error(
      'A store body returned a promise: a body is synchronous, so that a transaction never spans ' +
        'an await. This is a bug in the caller.',
    );
  }
}

/**
 * Maps an error to what leaves the package. A SQLite error never leaves raw:
 *   - a full disk or database size limit (13) → `STATE_STORE_FULL`;
 *   - every other SQLite error (a read-only file or folder, an unknown code) → a plain `Error` with
 *     SQLite's own text and its `errcode`. (A write attempted inside a read transaction is made a
 *     programming error by `RealmDb` before it gets here; a busy store is waited for, then refused
 *     by `RealmDb` with the budget it waited.)
 * Anything that is not a SQLite error (a body's own refusal, an error already mapped) passes
 * through unchanged.
 */
export function mapSqliteError(err: unknown): unknown {
  if (!isSqliteError(err)) return err;
  if ((err.errcode & 0xff) === 13) return storeFullError();
  return plainSqliteError(err, `${err.message} (SQLite error ${err.errcode})`);
}

/**
 * The in-process lock (one per connection): a flag and a first-in-first-out queue of waiters. It is
 * taken synchronously when free, held across busy waits and released in a `finally`; a release hands
 * it straight to the first waiter. Unit 9's COMMIT outcome protocol holds the same object.
 */
export class InProcessLock {
  #held = false;
  readonly #waiters: Array<() => void> = [];

  /** Takes the lock if it is free, synchronously; false when it is held. */
  tryTake(): boolean {
    if (this.#held) return false;
    this.#held = true;
    return true;
  }

  /** Resolves when the lock is this caller's, after every earlier waiter. */
  take(): Promise<void> {
    if (this.tryTake()) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Gives the lock to the first waiter, or frees it when nobody waits. */
  release(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) next();
    else this.#held = false;
  }
}

/**
 * The one primitive every statement on a store file goes through (see the module comment). Exported
 * to the package's own modules; the package's entry does not export it. An `autocommit` body must be
 * ONE statement or safe to run again: it is re-run whole on a busy store, and when a later statement
 * in it fails, the earlier ones stay.
 */
export class RealmDb {
  /** The clock every reading is taken from. */
  readonly clock: Clock;
  /** The in-process lock, shared with the COMMIT outcome protocol (unit 9). */
  readonly lock = new InProcessLock();
  #db: DatabaseLike;
  readonly #reopen: () => DatabaseLike;
  readonly #budgetMs: number;
  /** Set when BEGIN returns, cleared after COMMIT or ROLLBACK, with no await in between. */
  #txOpen = false;
  /** A call refused because it started inside the open transaction: that transaction fails with it. */
  #nested: Error | undefined;

  constructor(connection: DatabaseLike, options: RealmDbOptions) {
    this.#db = connection;
    this.clock = options.clock;
    this.#reopen = options.reopen;
    this.#budgetMs = options.budgetMs ?? DEFAULT_BUSY_BUDGET_MS;
  }

  /** Runs `body` with no transaction: the open's pragmas, checkpoints, a copy of the file. */
  autocommit<T>(body: (db: DatabaseLike) => SyncResult<T>): Promise<T> {
    this.#refuseIfNested();
    return this.#withLockAndBusyWait(() => {
      const db = this.#db;
      try {
        const result = body(db);
        refuseThenable(result);
        return result;
      } catch (err) {
        this.#rollbackQuietly();
        throw err;
      }
    });
  }

  /**
   * Runs `body` in a read transaction (deferred BEGIN, `query_only` on for the body), with the raw
   * reading taken before the BEGIN and before the in-process lock.
   */
  snapshot<T>(body: (db: DatabaseLike, reading: Date) => SyncResult<T>): Promise<T> {
    this.#refuseIfNested();
    let reading: Date;
    try {
      reading = takeRawReading(this.clock);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.#withLockAndBusyWait(() => this.#snapshotOnce(body, reading));
  }

  /**
   * Runs `body` in a write transaction (`BEGIN IMMEDIATE`, the `user_version` re-read first), with
   * the raw reading taken after the lock. `verify` is the write's own content check: required, and
   * used by the COMMIT outcome protocol (unit 9).
   */
  immediate<T>(
    body: (db: DatabaseLike, reading: Date) => SyncResult<T>,
    verify: Verify<T>,
  ): Promise<T>;
  /** The same, but the body receives no reading: it takes its own, or none. */
  immediate<T>(
    body: (db: DatabaseLike) => SyncResult<T>,
    verify: Verify<T>,
    options: { takesReading: false },
  ): Promise<T>;
  immediate<T>(
    body: (db: DatabaseLike, reading: Date) => T,
    verify: Verify<T>,
    options?: { takesReading: false },
  ): Promise<T> {
    this.#refuseIfNested();
    // `verify` is unit 9's: the COMMIT outcome protocol reads the write back with it. Until then a
    // COMMIT error rolls back and throws the mapped error.
    void verify;
    const takesReading = options?.takesReading !== false;
    return this.#withLockAndBusyWait(() => this.#immediateOnce(body, takesReading));
  }

  /** Closes the connection. */
  close(): void {
    this.#db.close();
  }

  /** A call that starts inside an open transaction is refused, and so is that transaction. */
  #refuseIfNested(): void {
    if (!this.#txOpen) return;
    const err = nestedCallError();
    this.#nested ??= err;
    throw err;
  }

  /**
   * Takes the in-process lock (synchronously when it is free) and runs `attempt`, waiting
   * asynchronously and running it again while the store is busy, up to the budget. The budget
   * counts from the call, the time queued for the lock included; the first attempt always runs, so
   * a call whose budget passed in the queue still gets one try.
   */
  async #withLockAndBusyWait<T>(attempt: () => T): Promise<T> {
    let calledAt: number | undefined;
    let held = false;
    try {
      for (;;) {
        // The one clock read: at the call, then after each busy answer.
        const now = performance.now();
        if (calledAt === undefined) {
          calledAt = now;
          held = this.lock.tryTake();
          if (!held) {
            await this.lock.take();
            held = true;
          }
        } else {
          const left = this.#budgetMs - (now - calledAt);
          if (left <= 0) throw busyError(this.#budgetMs);
          const jitter = BUSY_WAIT_MIN_MS + Math.random() * (BUSY_WAIT_MAX_MS - BUSY_WAIT_MIN_MS);
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(jitter, left)));
        }
        try {
          return attempt();
        } catch (err) {
          if (!isBusy(err)) throw mapSqliteError(err);
        }
      }
    } finally {
      if (held) this.lock.release();
    }
  }

  #snapshotOnce<T>(body: (db: DatabaseLike, reading: Date) => T, reading: Date): T {
    this.#begin('BEGIN');
    const db = this.#db;
    try {
      this.#refuseNewerSchema(db);
      db.exec('PRAGMA query_only = ON');
      let result: T;
      try {
        result = body(db, reading);
      } catch (err) {
        // 6 and 8 inside a read transaction: a write was attempted where none may be.
        if (isSqliteError(err) && [6, 8].includes(err.errcode & 0xff)) {
          throw plainSqliteError(
            err,
            `A write was attempted inside a read transaction: ${err.message} (SQLite error ` +
              `${err.errcode}). This is a bug in the caller. Nothing was written.`,
          );
        }
        throw err;
      } finally {
        db.exec('PRAGMA query_only = OFF');
      }
      refuseThenable(result);
      this.#failIfNested();
      this.#commit();
      return result;
    } catch (err) {
      this.#rollbackQuietly();
      throw err;
    }
  }

  #immediateOnce<T>(body: (db: DatabaseLike, reading: Date) => T, takesReading: boolean): T {
    // Before BEGIN IMMEDIATE: while `query_only` is on, BEGIN IMMEDIATE itself fails (8).
    if (Number(this.#db.prepare('PRAGMA query_only').get()?.['query_only']) !== 0) {
      throw new Error(
        "A store write found the connection still read-only: a read transaction's reset did not run. " +
          'This is a bug in the store. Nothing was written.',
      );
    }
    this.#begin('BEGIN IMMEDIATE');
    const db = this.#db;
    try {
      this.#refuseNewerSchema(db);
      const result = takesReading
        ? body(db, takeRawReading(this.clock))
        : (body as (db: DatabaseLike) => T)(db);
      refuseThenable(result);
      this.#failIfNested();
      this.#commit();
      return result;
    } catch (err) {
      this.#rollbackQuietly();
      throw err;
    }
  }

  /**
   * BEGINs a transaction. When SQLite answers that a transaction is already open (the connection is
   * poisoned: this class believes none is), rolls it back, reopens the connection and BEGINs once
   * more.
   */
  #begin(sql: 'BEGIN' | 'BEGIN IMMEDIATE'): void {
    try {
      this.#db.exec(sql);
    } catch (err) {
      if (!isNestedBegin(err)) throw err;
      this.#rollbackQuietly();
      const poisoned = this.#db;
      this.#db = this.#reopen();
      try {
        poisoned.close();
      } catch {
        // The poisoned connection is dropped either way; its close has nothing to tell the caller.
      }
      this.#db.exec(sql);
    }
    this.#txOpen = true;
    this.#nested = undefined;
  }

  /** The first statement of every transaction: a file a newer Realm migrated is refused. */
  #refuseNewerSchema(db: DatabaseLike): void {
    const version = Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
    if (version > REALM_STORE_SCHEMA_VERSION) throw versionNewerError(version);
  }

  /** A call that was refused inside this transaction fails the transaction too. */
  #failIfNested(): void {
    if (this.#nested !== undefined) throw this.#nested;
  }

  /** COMMITs; on an error rolls back and throws it mapped (never waited on: unit 9 decides there). */
  #commit(): void {
    try {
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#rollbackQuietly();
      throw mapSqliteError(err);
    }
    this.#txOpen = false;
  }

  /** ROLLBACK, swallowing only "no transaction is active"; the transaction flag is cleared either way. */
  #rollbackQuietly(): void {
    try {
      this.#db.exec('ROLLBACK');
    } catch (err) {
      if (!isNoActiveTransaction(err)) throw mapSqliteError(err);
    } finally {
      this.#txOpen = false;
    }
  }
}
