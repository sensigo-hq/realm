// connection.ts — issue #616 PR-1a unit 8: THE WRITE PATH. `RealmDb` is the one class every statement
// Realm sends to a store file goes through, in one of three forms (design §2, "Every statement that
// touches the file goes through one primitive"):
//   - `autocommit(body)`: no transaction (the open's pragmas, checkpoints, a copy of the file);
//   - `snapshot(body)`: a read transaction, `query_only` on for the body;
//   - `immediate(body, verify)`: a write transaction, `BEGIN IMMEDIATE`.
// It is built over a connection it is GIVEN, with a `reopen` function for that connection's file;
// `RealmDb.open` (unit 7b, `open-file.ts`) opens a home and builds one.
//
// The COMMIT outcome protocol (unit 9; design §2). Any error at an `immediate`'s COMMIT is answered
// here, never by the busy wait's retry, while the call still holds the in-process lock, so no other
// transaction of the process lands before the answer:
//   1. the CONNECTION still reports a transaction open: nothing was committed (a pending statement,
//      or a deferred constraint, 787, which the schema does not declare: a programming error); it is
//      rolled back → `not_landed`;
//   2. else the write's own `verify` reads its rows back by content, in a read transaction with no
//      `user_version` gate (a newer Realm upgrading the file meanwhile must not make a landed write
//      unanswerable), through the busy wait → `landed`; a read-back that cannot answer (still busy,
//      or a verify that throws: `VerifyInconclusive` for a newer stored version) → `unknown`;
//   3. else a resolving commit (`UPDATE store_meta SET commit_epoch = commit_epoch + 1`) through the
//      busy wait → `not_landed`;
//   4. else `unknown`: the next call of any form reopens the connection first; until a resolving
//      commit succeeds, writes are refused with `STATE_STORE_WRITES_FENCED` (each `immediate` tries
//      one, through the busy wait, before its write); reads and autocommit statements are served.
// A landed write resolves the call with the body's result; the others reject it, carrying the
// answer as `commitOutcome` ({@link CommitOutcome}). Each wait of the protocol has a fresh busy
// budget, counted from its own start. It proves crash behaviour, not power loss.
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
import { openRealmDb, type OpenOptions, type OpenSeams } from './open-file.js';

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

/**
 * The write's own content check, which the COMMIT outcome protocol runs after an error at COMMIT:
 * it reads the rows the write made back by their CONTENT, never by position or version alone.
 * Return true when the write is there. Return false only when you read the rows and the write is
 * not there; throw {@link VerifyInconclusive} when you cannot tell (a newer version is stored).
 */
export type Verify<T> = (db: DatabaseLike, result: T) => boolean;

/**
 * Thrown by a write's `verify` when it cannot tell whether the write is there: a newer version of
 * the record is stored, so the write may have landed and been superseded. The outcome is `unknown`.
 */
export class VerifyInconclusive extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyInconclusive';
  }
}

/**
 * How a write whose COMMIT reported an error was answered: `landed` (its rows are in the file),
 * `not_landed` (they are not) or `unknown` (it cannot be told). `cause` is the typed code the COMMIT
 * error mapped to (`STATE_STORE_FULL`), when it mapped to one; `errcode` is SQLite's code for it;
 * `programmingError` marks a deferred constraint (787), which the schema does not declare.
 */
export interface CommitOutcome {
  outcome: 'landed' | 'not_landed' | 'unknown';
  cause?: string;
  errcode?: number;
  programmingError?: boolean;
}

/** An error that carries the answer for the write whose COMMIT failed (the first caller only). */
export type WithCommitOutcome = Error & { readonly commitOutcome: CommitOutcome };

/** A COMMIT that failed, carried from the synchronous attempt to the protocol under the lock. */
class CommitFailed<T> extends Error {
  constructor(
    /** The COMMIT error, mapped. */
    readonly mapped: Error,
    /** The body's result. */
    readonly result: T,
    /** What every answer carries: the mapped code as `cause`, SQLite's code. */
    readonly base: Omit<CommitOutcome, 'outcome'>,
    /** The answer, when step 1 decided it synchronously. */
    readonly decided: CommitOutcome | undefined,
  ) {
    super('A COMMIT failed; the COMMIT outcome protocol answers it.');
  }
}

/** What the busy wait does around its attempt: take the lock, or run under the caller's. */
type Locking<T> = { readonly verify?: Verify<T> } | 'held';

/** Anything with a callable `then`: a promise, or any other thenable. */
type Thenable = { readonly then: (...args: never) => unknown };

/**
 * A body's result: anything but a thenable. A body whose inferred result type is a thenable (an
 * `async` arrow, a `Promise.resolve`, a union that may be one) does not compile, because the code
 * after its first `await` would run outside the transaction and the lock; every synchronous result
 * keeps its type. Exported for a generic wrapper over a form, which names it for its body's result;
 * the package's entry does not export it.
 */
export type SyncResult<T> = T extends Thenable ? never : T;

/** What a `RealmDb` is built over, besides its connection. */
export interface RealmDbOptions {
  /** The file the connection was opened on (`reopen` reopens the same one); a refusal names it. */
  readonly path: string;
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

/**
 * The home, or the store file in it, cannot be created or written (unit 7a). `reason` is the
 * operating system's text for a filesystem error, or SQLite's own text for a SQLite one.
 */
export function readOnlyError(path: string, reason: string): WorkflowError {
  return new WorkflowError(
    `Realm cannot write to ${path}: ${reason}. The store needs a home that Realm can write to.`,
    {
      code: 'STATE_STORE_READONLY',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { path, reason },
    },
  );
}

/**
 * The file was migrated by a newer Realm (unit 8's sentence; the open raises it too, from its first
 * read). `realm` is the version this Realm writes: core's, unless the open was given another.
 */
export function versionNewerError(
  file: number,
  realm: number = REALM_STORE_SCHEMA_VERSION,
): WorkflowError {
  return new WorkflowError(
    `This store was migrated by a newer Realm: its schema is version ${file} and this Realm writes ` +
      `version ${realm}. Upgrade Realm to read or write it.`,
    {
      code: 'STATE_STORE_VERSION_NEWER',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { file, realm },
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

/**
 * A write refused while the outcome of an earlier one is unknown, and that earlier write's own
 * answer. `cause` is the typed code its COMMIT error mapped to, when it mapped to one.
 */
function fencedError(cause: string | undefined): WorkflowError {
  return new WorkflowError(
    `The store cannot confirm whether its last write was saved${cause === undefined ? '' : ` (${cause})`}, ` +
      'so it refuses new writes until it can. Read back what you wrote to see what was saved, then ' +
      'try again.',
    {
      code: 'STATE_STORE_WRITES_FENCED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: true,
      details: cause === undefined ? {} : { cause },
    },
  );
}

/** `err` with the answer for the write whose COMMIT failed. */
function withCommitOutcome(err: Error, commitOutcome: CommitOutcome): WithCommitOutcome {
  return Object.assign(err, { commitOutcome });
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

/** One guard of the file's schema whose refusal has a typed code: the code, the sentence, retryable. */
function guardRefusal(
  code:
    | 'STATE_SNAPSHOT_MISMATCH'
    | 'STATE_RUN_IDENTITY'
    | 'STATE_RUN_PURGED'
    | 'STATE_EVIDENCE_REWRITTEN'
    | 'STATE_WRITE_ONCE_REWRITTEN',
  message: string,
  retryable: boolean,
): () => WorkflowError {
  return () =>
    new WorkflowError(message, {
      code,
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable,
    });
}

/**
 * The guards of the file's schema (units 6 and 6b) whose refusal has a typed code, by the guard's
 * exact message (final at the first release). Every other guard's refusal leaves as a plain error
 * with SQLite's text. A message carries no run, so none of these names one (and the purged-id
 * refusal no purge time).
 */
const GUARD_REFUSALS: ReadonlyMap<string, () => WorkflowError> = new Map([
  [
    "realm.db: a run's version can only advance by one",
    guardRefusal(
      'STATE_SNAPSHOT_MISMATCH',
      'Version conflict — run was modified by another process',
      true,
    ),
  ],
  [
    "realm.db: a run's identity cannot change",
    guardRefusal(
      'STATE_RUN_IDENTITY',
      "The store refused a write that would change a run's id, idempotency key, workflow or creation time.",
      false,
    ),
  ],
  [
    'realm.db: a purged run id cannot be created again',
    guardRefusal(
      'STATE_RUN_PURGED',
      'The store refused to create a run whose id was deleted earlier: a purged run id is never ' +
        'created again.',
      false,
    ),
  ],
  [
    'realm.db: evidence rows are append-only',
    guardRefusal(
      'STATE_EVIDENCE_REWRITTEN',
      "The store refused a write that would change or remove a run's stored evidence, which is " +
        'append-only.',
      false,
    ),
  ],
  [
    'realm.db: a write-once field cannot change',
    guardRefusal(
      'STATE_WRITE_ONCE_REWRITTEN',
      'The store refused a write that would change a run field that is written once and then never ' +
        'changes.',
      false,
    ),
  ],
]);

/** The guard messages {@link mapSqliteError} maps to a typed code (a source law lists the others). */
export const MAPPED_GUARD_MESSAGES: readonly string[] = [...GUARD_REFUSALS.keys()];

/**
 * Maps an error to what leaves the package. A SQLite error never leaves raw:
 *   - a guard of the file's schema with a typed code (units 6 and 6b): a constraint error (19) with
 *     that guard's exact message → that code ({@link GUARD_REFUSALS});
 *   - a full disk or database size limit (13) → `STATE_STORE_FULL`;
 *   - a file or folder that cannot be written (8, its extended code 1544 for a read-only folder) or
 *     opened (14) → `STATE_STORE_READONLY` naming `path`, the store file, with SQLite's own text
 *     (unit 7a);
 *   - every other SQLite error (an unknown code) → a plain `Error` with SQLite's own text and its
 *     `errcode`. (A write attempted inside a read transaction is made a programming error by
 *     `RealmDb` before it gets here; a busy store is waited for, then refused by `RealmDb` with the
 *     budget it waited.)
 * Anything that is not a SQLite error (a body's own refusal, an error already mapped) passes
 * through unchanged.
 */
export function mapSqliteError(err: unknown, path: string): unknown {
  if (!isSqliteError(err)) return err;
  const primary = err.errcode & 0xff;
  const guard = primary === 19 ? GUARD_REFUSALS.get(err.message) : undefined;
  if (guard !== undefined) return guard();
  if (primary === 13) return storeFullError();
  if (primary === 8 || primary === 14) return readOnlyError(path, err.errstr ?? err.message);
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
  readonly #path: string;
  readonly #reopen: () => DatabaseLike;
  readonly #budgetMs: number;
  /** Set when BEGIN returns, cleared after COMMIT or ROLLBACK, with no await in between. */
  #txOpen = false;
  /** A call refused because it started inside the open transaction: that transaction fails with it. */
  #nested: Error | undefined;
  /** Set when a write's outcome was unknown: the next call reopens the connection first. */
  #reopenOwed = false;
  /** Set while a write's outcome is unknown: writes are refused until a resolving commit succeeds. */
  #fence: { readonly cause: string | undefined } | undefined;

  /**
   * Opens the Realm home at `home` and returns its store's primitive, ready: the one open
   * (`open-file.ts`), and the only code that opens a connection on `realm.db`. `seams` is for the
   * package's own tests.
   */
  static open(home: string, options: OpenOptions, seams?: OpenSeams): Promise<RealmDb> {
    return openRealmDb(home, options, seams);
  }

  constructor(connection: DatabaseLike, options: RealmDbOptions) {
    this.#db = connection;
    this.#path = options.path;
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
   * run by the COMMIT outcome protocol when the COMMIT reports an error (see the module comment).
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
    const takesReading = options?.takesReading !== false;
    return this.#withLockAndBusyWait(() => this.#immediateOnce(body, takesReading), { verify });
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
   * The one busy wait. Runs `attempt`, waiting asynchronously and running it again while the store
   * is busy, until the budget has passed; then refuses with `STATE_RUN_BUSY`. The first attempt
   * always runs.
   *
   * A call (`locking` an object) first takes the in-process lock, synchronously when it is free,
   * and releases it in a `finally`; its budget counts from the call, the time queued for the lock
   * included. A call that got the lock only after its budget passed yields to the event loop once
   * before its one attempt. Under the lock, before the first attempt: the reopen an unknown outcome
   * owes, and, for a write (`verify` given) while writes are fenced, a resolving commit. A failed
   * COMMIT of a write is answered by the COMMIT outcome protocol, still under the lock.
   *
   * A step of the protocol (`'held'`) runs under the lock its call already holds, with a fresh
   * budget counted from the step's own start.
   */
  async #withLockAndBusyWait<T>(attempt: () => T, locking: Locking<T> = {}): Promise<T> {
    const call = locking === 'held' ? undefined : locking;
    let calledAt: number | undefined;
    let held = false;
    let queued = false;
    let prepared = call === undefined;
    try {
      for (;;) {
        // The one clock read: at the start, when the lock comes after a queue, and after each busy
        // answer.
        const now = performance.now();
        if (calledAt === undefined) {
          calledAt = now;
          if (call !== undefined) {
            held = this.lock.tryTake();
            if (!held) {
              await this.lock.take();
              held = true;
              queued = true;
              continue;
            }
          }
        } else if (queued) {
          queued = false;
          // The lock came after the budget passed in the queue: yield to the event loop once
          // before the one attempt. A release hands the lock on without the loop turning, so a
          // burst of such calls would otherwise block the program for all their attempts at once.
          if (now - calledAt >= this.#budgetMs) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        } else {
          const left = this.#budgetMs - (now - calledAt);
          if (left <= 0) throw busyError(this.#budgetMs);
          const jitter = BUSY_WAIT_MIN_MS + Math.random() * (BUSY_WAIT_MAX_MS - BUSY_WAIT_MIN_MS);
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(jitter, left)));
        }
        if (!prepared) {
          prepared = true;
          // Awaited only when there is something to do, so an uncontended call stays synchronous.
          const writes = call?.verify !== undefined;
          if (this.#reopenOwed || (writes && this.#fence !== undefined)) {
            await this.#beforeTheCall(writes);
          }
        }
        try {
          return attempt();
        } catch (err) {
          if (err instanceof CommitFailed && call?.verify !== undefined) {
            return await this.#commitOutcome(err as CommitFailed<T>, call.verify);
          }
          if (!isBusy(err)) throw mapSqliteError(err, this.#path);
        }
      }
    } finally {
      if (held) this.lock.release();
    }
  }

  /**
   * Under the lock, before a call's first attempt: the reopen an unknown outcome owes (a failed
   * reopen fails this call and stays owed, so the next call opens afresh), then, for a write while
   * writes are fenced, a resolving commit (the fence lifts when it succeeds; the write is refused
   * when it does not). Reads and autocommit statements are served fenced or not.
   */
  async #beforeTheCall(writes: boolean): Promise<void> {
    if (this.#reopenOwed) {
      try {
        this.#db.close();
      } catch {
        // The connection is dropped either way (a failed reopen left it closed already).
      }
      this.#db = this.#reopen();
      this.#reopenOwed = false;
    }
    if (writes && this.#fence !== undefined) {
      const { cause } = this.#fence;
      try {
        await this.#withLockAndBusyWait(() => this.#resolvingCommitOnce(), 'held');
      } catch {
        throw fencedError(cause);
      }
      this.#fence = undefined;
    }
  }

  /**
   * Steps 2 to 4 of the COMMIT outcome protocol (step 1 ran in the attempt, synchronously), under
   * the call's lock: see the module comment. A landed write returns the body's result; every other
   * answer is thrown, carrying `commitOutcome`.
   */
  async #commitOutcome<T>(failure: CommitFailed<T>, verify: Verify<T>): Promise<T> {
    if (failure.decided !== undefined) throw withCommitOutcome(failure.mapped, failure.decided);
    // 2. The write's own check, by content, ungated, through the busy wait.
    let seen: boolean | undefined;
    try {
      seen = await this.#withLockAndBusyWait(() => this.#readBack(verify, failure.result), 'held');
    } catch {
      // Still busy after the budget, or the verify cannot tell: the answer is unknown.
      seen = undefined;
    }
    if (seen === true) return failure.result;
    if (seen === false) {
      // 3. A resolving commit: once one commits, the failed write cannot land any more.
      let resolved = true;
      try {
        await this.#withLockAndBusyWait(() => this.#resolvingCommitOnce(), 'held');
      } catch {
        resolved = false;
      }
      if (resolved) {
        throw withCommitOutcome(failure.mapped, { outcome: 'not_landed', ...failure.base });
      }
    }
    // 4. Unknown: the next call reopens first; writes stay fenced until a resolving commit succeeds.
    this.#reopenOwed = true;
    this.#fence = { cause: failure.base.cause };
    throw withCommitOutcome(fencedError(failure.base.cause), {
      outcome: 'unknown',
      ...failure.base,
    });
  }

  /**
   * Step 1, synchronously at the failed COMMIT (no await before it, so the transaction flag is
   * right for every other caller): when the connection still reports a transaction open, nothing
   * was committed; it is rolled back, and the rollback's own error never hides the COMMIT's.
   */
  #commitFailed<T>(err: unknown, result: T): CommitFailed<T> {
    const errcode = isSqliteError(err) ? err.errcode : undefined;
    const mappedErr = mapSqliteError(err, this.#path);
    const mapped = mappedErr instanceof Error ? mappedErr : new Error(String(mappedErr));
    const base: Omit<CommitOutcome, 'outcome'> = {
      ...(mapped instanceof WorkflowError ? { cause: mapped.code } : {}),
      ...(errcode === undefined ? {} : { errcode }),
    };
    let stillOpen: boolean;
    try {
      stillOpen = this.#db.isTransaction;
    } catch {
      stillOpen = false;
    }
    if (!stillOpen) {
      this.#txOpen = false;
      return new CommitFailed(mapped, result, base, undefined);
    }
    try {
      this.#db.exec('ROLLBACK');
    } catch {
      // The COMMIT's error is the answer; a transaction left open is found by the next BEGIN.
    }
    this.#txOpen = false;
    return new CommitFailed(mapped, result, base, {
      outcome: 'not_landed',
      ...base,
      // A deferred constraint: the schema declares none, so the write itself is wrong.
      ...(errcode === 787 ? { programmingError: true } : {}),
    });
  }

  /**
   * Step 2's read: the write's `verify` in a read transaction (`query_only` on, reset in a
   * `finally`), with NO `user_version` gate.
   */
  #readBack<T>(verify: Verify<T>, result: T): boolean {
    this.#begin('BEGIN');
    const db = this.#db;
    try {
      db.exec('PRAGMA query_only = ON');
      let seen: boolean;
      try {
        seen = verify(db, result);
      } finally {
        db.exec('PRAGMA query_only = OFF');
      }
      this.#commit();
      return seen;
    } catch (err) {
      this.#rollbackQuietly();
      throw err;
    }
  }

  /** A resolving commit: one write transaction that moves the store's commit counter. */
  #resolvingCommitOnce(): void {
    this.#begin('BEGIN IMMEDIATE');
    const db = this.#db;
    try {
      this.#refuseNewerSchema(db);
      db.exec('UPDATE store_meta SET commit_epoch = commit_epoch + 1');
    } catch (err) {
      this.#rollbackQuietly();
      throw err;
    }
    this.#commit();
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
    let result: T;
    try {
      this.#refuseNewerSchema(db);
      result = takesReading
        ? body(db, takeRawReading(this.clock))
        : (body as (db: DatabaseLike) => T)(db);
      refuseThenable(result);
      this.#failIfNested();
    } catch (err) {
      this.#rollbackQuietly();
      throw err;
    }
    try {
      db.exec('COMMIT');
    } catch (err) {
      // Any error at COMMIT goes to the COMMIT outcome protocol, never to the busy wait's retry.
      throw this.#commitFailed(err, result);
    }
    this.#txOpen = false;
    return result;
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

  /**
   * COMMITs a read transaction or a step of the COMMIT outcome protocol; on an error rolls back and
   * throws it mapped (never waited on). A write's own COMMIT goes to the protocol instead.
   */
  #commit(): void {
    try {
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#rollbackQuietly();
      throw mapSqliteError(err, this.#path);
    }
    this.#txOpen = false;
  }

  /** ROLLBACK, swallowing only "no transaction is active"; the transaction flag is cleared either way. */
  #rollbackQuietly(): void {
    try {
      this.#db.exec('ROLLBACK');
    } catch (err) {
      if (!isNoActiveTransaction(err)) throw mapSqliteError(err, this.#path);
    } finally {
      this.#txOpen = false;
    }
  }
}
