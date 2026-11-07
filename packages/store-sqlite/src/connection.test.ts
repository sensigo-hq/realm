// connection.test.ts — issue #616 PR-1a unit 8: the write path (`RealmDb`'s three forms, the busy
// wait, the nested-call refusal, the error mapper), on a real database file opened through the one
// loader (`driver.ts`). Unit 7 (opening a home) does not exist yet, so each test makes its own file:
// WAL, the connection's busy timeout, one table `t`; and `reopen` is a stub that opens the same file
// again the same way.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
// Faults the real library cannot produce here (the busy codes 261, 517 and 773, a full disk at
// COMMIT, an unknown code) are thrown by a wrapper around a real connection, in the exact shape the
// library throws (`code`, `errcode`, `errstr`, `message`; captured on Node 24.21.0 / SQLite 3.53.4 by
// `plans/issue-616/ia2-u08/probes/shapes.mjs`).
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REALM_STORE_SCHEMA_VERSION, WorkflowError } from '@sensigo/realm';
import type { Clock } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { BUSY_SLICE_MS, RealmDb } from './connection.js';
import { openDatabase } from './driver.js';
import type { DatabaseLike, StatementLike } from './driver.js';

const T0 = Date.parse('2026-11-05T12:00:00.000Z');
const dirs: string[] = [];
const connections: DatabaseLike[] = [];

afterEach(() => {
  for (const c of connections.splice(0)) {
    try {
      c.close();
    } catch {
      // already closed by the test
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A connection to `file` through the one loader, with the busy timeout the open will set. */
function connect(file: string, options?: Record<string, unknown>): DatabaseLike {
  const c = openDatabase(file, options);
  connections.push(c);
  c.exec(`PRAGMA busy_timeout = ${BUSY_SLICE_MS}`);
  return c;
}

/** A fresh store file in WAL mode with one table `t (x)`. */
function freshFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u08-'));
  dirs.push(dir);
  const file = join(dir, 'realm.db');
  const c = connect(file);
  c.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
  return file;
}

/** The values in `t`, read on a connection of their own. */
function values(file: string): unknown[] {
  return connect(file)
    .prepare('SELECT x FROM t ORDER BY rowid')
    .all()
    .map((r) => r['x']);
}

const fixedClock: Clock = { now: () => new Date(T0), at: () => () => undefined };

/** A `RealmDb` over a fresh connection to `file`; `reopens` counts the stub reopen's calls. */
function realmDb(
  file: string,
  options: { budgetMs?: number; clock?: Clock; connection?: DatabaseLike } = {},
): { db: RealmDb; reopens: () => number } {
  let reopens = 0;
  const db = new RealmDb(options.connection ?? connect(file), {
    path: file,
    clock: options.clock ?? fixedClock,
    reopen: () => {
      reopens += 1;
      return connect(file);
    },
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
  });
  return { db, reopens: () => reopens };
}

const insert =
  (x: unknown) =>
  (d: DatabaseLike): void => {
    d.prepare('INSERT INTO t VALUES (?)').run(x);
  };
const verified = (): boolean => true;

/**
 * A body that returns a promise, cast past the compile-time rule (a body's type may not return
 * one), so a cell can reach the run-time refusal: the second line of the same rule.
 */
function pastTheType<A extends unknown[]>(body: (...args: A) => unknown): (...args: A) => string {
  return body as (...args: A) => string;
}

/** Compile-time only: `true` when A and B are the same type, `false` otherwise. */
type Same<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
/** Compile-time check of a call's type: `resultOf(x).is<T>(true)` compiles only when x is a T. */
const resultOf = <A>(actual: A) => ({
  is: <B>(same: Same<A, B>): void => void [actual, same],
});

/** Waits `ms` on the event loop. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What a call settled with: its value, or its error. */
async function settle<T>(p: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await p };
  } catch (error) {
    return { error };
  }
}

/** The parts of an error a test compares (never a credential: these are store errors). */
function summary(err: unknown): Record<string, unknown> {
  const e = err as {
    code?: unknown;
    errcode?: unknown;
    message?: unknown;
    details?: unknown;
  };
  return {
    workflowError: err instanceof WorkflowError,
    code: e?.code,
    errcode: e?.errcode,
    message: e?.message,
    ...(err instanceof WorkflowError ? { details: err.details } : {}),
  };
}

/** An error in the exact shape the built-in SQLite throws (see the header). */
function sqliteShaped(errcode: number, message: string, errstr: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode, errstr });
}

/**
 * A real connection that throws `fault()` instead of running a statement `at` matches, the first
 * `times` times; every other statement runs on the real connection. `begins` records, for each
 * BEGIN it passes on, whether a transaction was open at that moment.
 */
function withFault(
  conn: DatabaseLike,
  at: (sql: string) => boolean,
  fault: () => Error,
  times: number,
): { wrapped: DatabaseLike; begins: boolean[] } {
  let left = times;
  const begins: boolean[] = [];
  const hit = (sql: string): void => {
    if (left > 0 && at(sql)) {
      left -= 1;
      throw fault();
    }
  };
  const wrapped: DatabaseLike = {
    exec(sql) {
      if (sql.startsWith('BEGIN')) begins.push(conn.isTransaction);
      hit(sql);
      conn.exec(sql);
    },
    prepare(sql): StatementLike {
      const s = conn.prepare(sql);
      return {
        run: (...p) => (hit(sql), s.run(...p)),
        get: (...p) => (hit(sql), s.get(...p)),
        all: (...p) => (hit(sql), s.all(...p)),
      };
    },
    close: () => conn.close(),
    get isTransaction() {
      return conn.isTransaction;
    },
  };
  return { wrapped, begins };
}

describe('#616 unit 8 — the write path', () => {
  it('check 1: a busy store is waited for without freezing the event loop, then refused with STATE_RUN_BUSY, nothing written', async () => {
    const file = freshFile();
    const holder = connect(file);
    holder.exec('BEGIN IMMEDIATE');
    const { db } = realmDb(file, { budgetMs: 1_000 });
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    const started = performance.now();
    const out = await settle(db.immediate(insert(1), verified));
    const elapsed = performance.now() - started;
    clearInterval(timer);
    holder.exec('ROLLBACK');
    // (1) red when the wait is synchronous (a busy timeout as long as the budget, or a blocking
    //     loop between attempts): the interval cannot fire while the loop is blocked, so the ticks
    //     stay at 0 or 1; also when the refusal is not STATE_RUN_BUSY with its sentence, or a row
    //     landed. The floor is 3, not a rate: an idle Linux host counts about 60 ticks in this
    //     second (58-64 over five runs), the macOS runner counted 15 both times (CI run 42321890910
    //     and its re-run), so a rate that high fails there with the wait in place. (2) prints the
    //     error's code and message, the ticks and the elapsed time.
    expect(
      { ...summary(out.error), atLeast3Ticks: ticks >= 3, rows: values(file) },
      `ticks ${ticks}, elapsed ${elapsed.toFixed(0)} ms`,
    ).toEqual({
      workflowError: true,
      code: 'STATE_RUN_BUSY',
      errcode: undefined,
      message:
        'The store was busy for 1 s: another writer held it. Nothing was written. Try again.',
      details: { budget_ms: 1000 },
      atLeast3Ticks: true,
      rows: [],
    });
  });

  it('check 2: a file a newer Realm migrated is refused on the first statement of a snapshot and of an immediate', async () => {
    const file = freshFile();
    connect(file).exec(`PRAGMA user_version = ${REALM_STORE_SCHEMA_VERSION + 1}`);
    const { db } = realmDb(file);
    let bodies = 0;
    const snapshot = await settle(db.snapshot(() => (bodies += 1)));
    const immediate = await settle(db.immediate(() => (bodies += 1), verified));
    const newer = {
      workflowError: true,
      code: 'STATE_STORE_VERSION_NEWER',
      errcode: undefined,
      message: `This store was migrated by a newer Realm: its schema is version ${REALM_STORE_SCHEMA_VERSION + 1} and this Realm writes version ${REALM_STORE_SCHEMA_VERSION}. Upgrade Realm to read or write it.`,
      details: { file: REALM_STORE_SCHEMA_VERSION + 1, realm: REALM_STORE_SCHEMA_VERSION },
    };
    // (1) red when the version is re-read only on writes (the snapshot's body runs, and the snapshot
    //     resolves), when it is read after the body (a body runs), or when the refusal's code,
    //     sentence or details differ. (2) prints both outcomes and how many bodies ran.
    expect({
      snapshot: summary(snapshot.error),
      immediate: summary(immediate.error),
      bodies,
    }).toEqual({ snapshot: newer, immediate: newer, bodies: 0 });
  });

  it('check 3: a write inside a snapshot is a programming error, and the next immediate works', async () => {
    const file = freshFile();
    const { db } = realmDb(file);
    const refused = await settle(db.snapshot(insert('in a read')));
    const next = await settle(db.immediate(insert('after'), verified));
    // (1) red when the snapshot does not reset `query_only` (the next immediate is refused as a
    //     read-only connection), when the write inside the snapshot lands or is mapped to a typed
    //     store error, or when its text loses SQLite's own. (2) prints both outcomes and the rows.
    expect({
      refused: summary(refused.error),
      next: summary(next.error),
      rows: values(file),
    }).toEqual({
      refused: {
        workflowError: false,
        code: undefined,
        errcode: 8,
        message:
          'A write was attempted inside a read transaction: attempt to write a readonly database ' +
          '(SQLite error 8). This is a bug in the caller. Nothing was written.',
      },
      next: summary(undefined),
      rows: ['after'],
    });
  });

  it('check 4: a connection left inside a transaction is rolled back, reopened, and the call succeeds', async () => {
    const file = freshFile();
    const poisoned = connect(file);
    poisoned.exec('BEGIN');
    const { db, reopens } = realmDb(file, { connection: poisoned });
    const out = await settle(
      db.immediate((d) => {
        insert('after reopen')(d);
        return 'done';
      }, verified),
    );
    // (1) red when the call does not reopen and BEGIN again (it fails with "cannot start a
    //     transaction within a transaction"), or reopens more than once. (2) prints the outcome,
    //     the reopen count and the rows.
    expect({ ...out, error: summary(out.error), reopens: reopens(), rows: values(file) }).toEqual({
      value: 'done',
      error: summary(undefined),
      reopens: 1,
      rows: ['after reopen'],
    });
  });

  it('check 5: a real full database surfaces as STATE_STORE_FULL, not as the failed ROLLBACK after it', async () => {
    const file = freshFile();
    const conn = connect(file);
    const pages = Number(conn.prepare('PRAGMA page_count').get()?.['page_count']);
    conn.exec(`PRAGMA max_page_count = ${pages + 1}`);
    const { db } = realmDb(file, { connection: conn });
    const out = await settle(db.immediate(insert('x'.repeat(200_000)), verified));
    // (1) red when the ROLLBACK after SQLite's own rollback is not guarded (its "cannot rollback -
    //     no transaction is active" hides the full disk), when 13 is not mapped, or when a row
    //     landed or a transaction stays open. (2) prints the error, the rows and the flag.
    expect({ error: summary(out.error), rows: values(file), open: conn.isTransaction }).toEqual({
      error: {
        workflowError: true,
        code: 'STATE_STORE_FULL',
        errcode: undefined,
        message:
          "The Realm store could not be written: its disk, or the database's size limit, is full. " +
          'Nothing was written. Free space, then try again.',
        details: {},
      },
      rows: [],
      open: false,
    });
  });

  it('check 6: the reading — a snapshot takes it before its BEGIN, an immediate after its lock, an opted-out immediate never; a write fired by the snapshot reading lands before the snapshot starts', async () => {
    const file = freshFile();
    const conn = connect(file);
    const openAtReading: boolean[] = [];
    let hook: (() => void) | undefined;
    const clock: Clock = {
      now: () => {
        openAtReading.push(conn.isTransaction);
        const h = hook;
        hook = undefined;
        h?.();
        return new Date(T0);
      },
      at: () => () => undefined,
    };
    const { db } = realmDb(file, { connection: conn, clock });
    const snapshotReading = await db.snapshot((_d, r) => r.toISOString());
    const snapshot = openAtReading.splice(0);
    const immediateReading = await db.immediate((_d, r) => r.toISOString(), verified);
    const immediate = openAtReading.splice(0);
    await db.immediate(() => undefined, verified, { takesReading: false });
    const optedOut = openAtReading.splice(0);
    // The published law SNAPSHOT_AT_SOUND's shape: the snapshot's reading fires a store write.
    hook = () => void db.immediate(insert('from the clock'), verified);
    const seen = await db.snapshot((d) =>
      d
        .prepare('SELECT x FROM t')
        .all()
        .map((r) => r['x']),
    );
    // (1) red when the snapshot takes its reading inside its transaction (its entry reads true, and
    //     the clock's write is refused as a nested call, so the snapshot fails), when an immediate
    //     takes it before BEGIN IMMEDIATE or not at all, when an opted-out call takes one, or when a
    //     body does not receive the reading. (2) prints each form's transaction flag per reading,
    //     the readings and what the snapshot saw.
    expect({ snapshot, immediate, optedOut, snapshotReading, immediateReading, seen }).toEqual({
      snapshot: [false],
      immediate: [true],
      optedOut: [],
      snapshotReading: '2026-11-05T12:00:00.000Z',
      immediateReading: '2026-11-05T12:00:00.000Z',
      seen: ['from the clock'],
    });
  });

  it('behaviour 9: an uncontended immediate has committed by the time the call returns its promise', async () => {
    const file = freshFile();
    const { db } = realmDb(file);
    const pending = db.immediate(insert('now'), verified);
    const before = values(file);
    await pending;
    // (1) red when the in-process lock is always awaited (or anything else awaits before COMMIT):
    //     the row is not there yet when the call returns. (2) prints the rows seen at the return.
    expect(before).toEqual(['now']);
  });

  it('check 7: a clock that calls back into the store fails the immediate with the nesting error and leaves the connection usable; on a snapshot the same call succeeds', async () => {
    const file = freshFile();
    const conn = connect(file);
    let hook: (() => void) | undefined;
    const clock: Clock = {
      now: () => {
        const h = hook;
        hook = undefined;
        h?.();
        return new Date(T0);
      },
      at: () => () => undefined,
    };
    const { db } = realmDb(file, { connection: conn, clock });
    const nesting =
      'A store call was made while a store transaction was open on this connection (a clock or a ' +
      'transaction body called back into the store). This is a bug in the caller. Nothing was written.';
    // The clock calls the store directly: the refusal is thrown out of `now()`.
    hook = () => void db.immediate(insert('nested'), verified);
    const direct = await settle(db.immediate(insert('outer'), verified));
    // The clock calls the store through an async function and swallows the refusal: the outer
    // transaction must still fail (its sentence says nothing was written).
    hook = () => {
      void (async () => db.immediate(insert('nested, swallowed'), verified))().catch(
        () => undefined,
      );
    };
    const swallowed = await settle(db.immediate(insert('outer, swallowed'), verified));
    const after = await settle(db.immediate(insert('usable'), verified));
    hook = () => void db.immediate(insert('from a snapshot clock'), verified);
    const onSnapshot = await settle(db.snapshot(() => 'ok'));
    // (1) red when there is no transaction flag (the nested call waits for the lock and the outer
    //     commits), when the outer transaction does not fail with a refused call it made (the
    //     swallowed case commits 'outer, swallowed'), when the connection is left in a transaction
    //     (the next call fails), or when the snapshot's pre-BEGIN reading is refused. (2) prints
    //     each outcome, the flag and the rows.
    expect({
      direct: summary(direct.error),
      swallowed: summary(swallowed.error),
      after: summary(after.error),
      onSnapshot,
      open: conn.isTransaction,
      rows: values(file),
    }).toEqual({
      direct: { workflowError: false, code: undefined, errcode: undefined, message: nesting },
      swallowed: { workflowError: false, code: undefined, errcode: undefined, message: nesting },
      after: summary(undefined),
      onSnapshot: { value: 'ok' },
      open: false,
      rows: ['usable', 'from a snapshot clock'],
    });
  });

  it('check 8: a body that returns a promise is refused and its writes rolled back', async () => {
    const file = freshFile();
    const { db } = realmDb(file);
    const out = await settle(
      db.immediate(
        pastTheType((d: DatabaseLike) => {
          insert('before the promise')(d);
          return Promise.resolve(1);
        }),
        verified,
      ),
    );
    // (1) red when a returned promise is accepted (the call resolves and the row stays).
    //     (2) prints the error and the rows.
    expect({ error: summary(out.error), rows: values(file) }).toEqual({
      error: {
        workflowError: false,
        code: undefined,
        errcode: undefined,
        message:
          'A store body returned a promise: a body is synchronous, so that a transaction never ' +
          'spans an await. This is a bug in the caller.',
      },
      rows: [],
    });
  });

  it('check 8: no source in the package reads a statement step by step (a leaked iterator pins the WAL)', () => {
    const self = fileURLToPath(import.meta.url);
    const src = dirname(self);
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(name) && path !== self) files.push(path);
      }
    };
    walk(src);
    const users = files
      .filter((f) => /\.iterate\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f));
    // (1) red when any source file of the package (tests included; not this one, which names the
    //     call) calls a statement's step-by-step reader, or when the scan reads no file.
    //     (2) prints the files that call it and whether any file was read.
    expect({ readSome: files.length > 0, users }).toEqual({ readSome: true, users: [] });
  });

  it('check 9: every error leaves the class mapped, none raw', async () => {
    const file = freshFile();
    const busy = (errcode: number) => async (): Promise<unknown> => {
      const { wrapped } = withFault(
        connect(file),
        (s) => s === 'BEGIN IMMEDIATE',
        () => sqliteShaped(errcode, 'database is locked', 'database is locked'),
        Number.POSITIVE_INFINITY,
      );
      return (
        await settle(
          realmDb(file, { connection: wrapped, budgetMs: 60 }).db.immediate(
            insert(errcode),
            verified,
          ),
        )
      ).error;
    };
    const busyRefusal = {
      workflowError: true,
      code: 'STATE_RUN_BUSY',
      errcode: undefined,
      message:
        'The store was busy for 0.06 s: another writer held it. Nothing was written. Try again.',
      details: { budget_ms: 60 },
    };

    // 517 arrives with the transaction open: rolled back, waited, BEGIN again (no reopen needed).
    const snap517 = withFault(
      connect(file),
      (s) => s === 'INSERT INTO t VALUES (?)',
      () => sqliteShaped(517, 'database is locked', 'database is locked'),
      1,
    );
    const r517 = realmDb(file, { connection: snap517.wrapped });
    const out517 = await settle(r517.db.immediate(insert(517), verified));

    // A full disk at COMMIT: rolled back, mapped (unit 9 replaces this with its protocol).
    const full = withFault(
      connect(file),
      (s) => s === 'COMMIT',
      () => sqliteShaped(13, 'database or disk is full', 'database or disk is full'),
      1,
    );
    const fullAtCommit = (
      await settle(realmDb(file, { connection: full.wrapped }).db.immediate(insert(13), verified))
    ).error;

    // 6 inside a snapshot body, real: a checkpoint inside a read transaction.
    const locked = (
      await settle(
        realmDb(file).db.snapshot((d) => d.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()),
      )
    ).error;

    // 8 outside a snapshot, real: a write on a connection that can only read.
    const readOnly = (
      await settle(
        realmDb(file, { connection: connect(file, { readOnly: true }) }).db.immediate(
          insert(8),
          verified,
        ),
      )
    ).error;

    // An unknown code, in a body.
    const unknown = withFault(
      connect(file),
      (s) => s === 'INSERT INTO t VALUES (?)',
      () =>
        sqliteShaped(11, 'database disk image is malformed', 'database disk image is malformed'),
      1,
    );
    const unknownCode = (
      await settle(
        realmDb(file, { connection: unknown.wrapped }).db.immediate(insert(11), verified),
      )
    ).error;

    // A body's own refusal (a fence's, for example) is not a SQLite error: it passes unchanged.
    const own = new WorkflowError('refused by the body', {
      code: 'STATE_RUN_BUSY',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: true,
    });
    const passedThrough = (
      await settle(
        realmDb(file).db.immediate(() => {
          throw own;
        }, verified),
      )
    ).error;

    // (1) red when any SQLite error leaves raw (a busy code outside the family test, a code the
    //     mapper passes through), when 517's open transaction is not rolled back before the next
    //     BEGIN (its BEGIN sees an open transaction, and a reopen is spent), when a full disk at
    //     COMMIT is not mapped, when 6 inside a snapshot is not a programming error, when 8 outside
    //     one is not the read-only refusal naming the file (unit 7a), when an unknown code loses its
    //     code or SQLite's text, or when a body's own error is replaced. (2) prints each row's
    //     outcome.
    expect({
      busy5: summary(await busy(5)()),
      busy261: summary(await busy(261)()),
      busy773: summary(await busy(773)()),
      busy517: {
        value: out517.value,
        beginsWithOpenTransaction: snap517.begins,
        reopens: r517.reopens(),
      },
      fullAtCommit: summary(fullAtCommit),
      lockedInSnapshot: summary(locked),
      readOnlyOutsideSnapshot: summary(readOnly),
      unknownCode: summary(unknownCode),
      bodysOwnErrorUnchanged: passedThrough === own,
      raw: [fullAtCommit, locked, readOnly, unknownCode].filter(
        (e) => (e as { code?: unknown })?.code === 'ERR_SQLITE_ERROR',
      ).length,
      rows: values(file),
    }).toEqual({
      busy5: busyRefusal,
      busy261: busyRefusal,
      busy773: busyRefusal,
      busy517: { value: undefined, beginsWithOpenTransaction: [false, false], reopens: 0 },
      fullAtCommit: {
        workflowError: true,
        code: 'STATE_STORE_FULL',
        errcode: undefined,
        message:
          "The Realm store could not be written: its disk, or the database's size limit, is full. " +
          'Nothing was written. Free space, then try again.',
        details: {},
      },
      lockedInSnapshot: {
        workflowError: false,
        code: undefined,
        errcode: 6,
        message:
          'A write was attempted inside a read transaction: database table is locked (SQLite error ' +
          '6). This is a bug in the caller. Nothing was written.',
      },
      // Unit 7a: an 8 outside a snapshot is a file or folder Realm cannot write.
      readOnlyOutsideSnapshot: {
        workflowError: true,
        code: 'STATE_STORE_READONLY',
        errcode: undefined,
        message:
          `Realm cannot write to ${file}: attempt to write a readonly database. The store needs a ` +
          'home that Realm can write to.',
        details: { path: file, reason: 'attempt to write a readonly database' },
      },
      unknownCode: {
        workflowError: false,
        code: undefined,
        errcode: 11,
        message: 'database disk image is malformed (SQLite error 11)',
      },
      bodysOwnErrorUnchanged: true,
      raw: 0,
      rows: [517],
    });
  });

  it('correction check 1: a body typed to return a promise does not compile in any form; every synchronous body does, with its own result type', () => {
    const calls = (db: RealmDb): void => {
      // (1) red as a compile error in typecheck:tests (an unused @ts-expect-error) when a form's
      //     body type accepts a promise again. (2) the compiler prints the file and line.
      // @ts-expect-error — an async body in autocommit
      void db.autocommit(async (d) => insert('a')(d));
      // @ts-expect-error — an async body in snapshot
      void db.snapshot(async (_d, r) => r.toISOString());
      // @ts-expect-error — an async body in immediate
      void db.immediate(async (d) => insert('i')(d), verified);
      // @ts-expect-error — an async body in immediate, opted out of the reading
      void db.immediate(async (d) => insert('o')(d), verified, { takesReading: false });
      // @ts-expect-error — a body that returns a promise without being async
      void db.immediate(() => Promise.resolve(1), verified);
      // @ts-expect-error — a body that returns some other thenable
      void db.autocommit(() => ({ then: (): void => undefined }));
      // @ts-expect-error — a body that may return a promise
      void db.snapshot((): number | Promise<number> => 1);

      // (1) red as a compile error when an ordinary synchronous body stops compiling, or when its
      //     call's result type changes (the `is` argument no longer fits). (2) the compiler
      //     prints the file, the line and both types.
      resultOf(
        db.autocommit((d) => {
          d.exec('PRAGMA optimize');
        }),
      ).is<Promise<void>>(true);
      resultOf(db.autocommit(() => undefined)).is<Promise<undefined>>(true);
      resultOf(db.snapshot((_d, r) => r.toISOString())).is<Promise<string>>(true);
      resultOf(db.snapshot((d) => d.prepare('SELECT x FROM t').get())).is<
        Promise<Record<string, unknown> | undefined>
      >(true);
      resultOf(db.immediate((_d, r) => ({ id: 'run-1', at: r }), verified)).is<
        Promise<{ id: string; at: Date }>
      >(true);
      resultOf(db.immediate(() => [1, 2], verified, { takesReading: false })).is<Promise<number[]>>(
        true,
      );
      resultOf(
        db.immediate(
          (_d, r) => r,
          (_d, result) => result instanceof Date,
        ),
      ).is<Promise<Date>>(true);
    };
    // The run-time part only shows the function compiled into the suite.
    expect(typeof calls).toBe('function');
  });

  it('correction check 2: five calls queued behind an outside writer are all refused within about the budget, in call order, nothing written', async () => {
    const file = freshFile();
    const holder = connect(file);
    holder.exec('BEGIN IMMEDIATE');
    const budgetMs = 400;
    const { db } = realmDb(file, { budgetMs });
    const started = performance.now();
    const refused: Array<{ call: number; atMs: number; error: Record<string, unknown> }> = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map(async (call) => {
        const out = await settle(db.immediate(insert(call), verified));
        refused.push({ call, atMs: performance.now() - started, error: summary(out.error) });
      }),
    );
    holder.exec('ROLLBACK');
    const last = Math.max(...refused.map((r) => r.atMs));
    const first = Math.min(...refused.map((r) => r.atMs));
    // (1) red when the budget counts from each call's first busy answer, not from the call (the
    //     queued calls wait a budget each: the last is refused near 5 x 400 ms), when a call is
    //     refused before its budget, out of call order, with another refusal, or a row landed.
    //     The bound is 4 x the budget, not the budget plus one attempt for each call: the broken
    //     count cannot be refused before 5 x the budget, because each call waits its own whole
    //     budget behind the one before; the macOS runner refused the last call at 2.3 x and 2.1 x
    //     (CI run 42321890910 and its re-run), so a bound of 2 x failed there with the count
    //     right. (2) prints every call's refusal time and outcome.
    expect(
      {
        order: refused.map((r) => r.call),
        withinFourTimesTheBudget: last < 4 * budgetMs,
        notBeforeTheBudget: first >= budgetMs,
        errors: refused.map((r) => r.error),
        rows: values(file),
      },
      refused.map((r) => `#${r.call} at ${r.atMs.toFixed(0)} ms`).join(', '),
    ).toEqual({
      order: [1, 2, 3, 4, 5],
      withinFourTimesTheBudget: true,
      notBeforeTheBudget: true,
      errors: Array(5).fill({
        workflowError: true,
        code: 'STATE_RUN_BUSY',
        errcode: undefined,
        message:
          'The store was busy for 0.4 s: another writer held it. Nothing was written. Try again.',
        details: { budget_ms: 400 },
      }),
      rows: [],
    });
  });

  it('correction check 2: a call whose budget passed in the queue still makes one attempt — it lands when the writer let go, and is refused after that one attempt when it did not', async () => {
    const budgetMs = 100;
    // The in-process lock held for longer than the budget: as the COMMIT outcome protocol (unit
    // 9) holds it. The outside writer holds the file meanwhile.
    const queuedPastTheBudget = async (writerLetsGo: boolean) => {
      const file = freshFile();
      const holder = connect(file);
      holder.exec('BEGIN IMMEDIATE');
      const { wrapped, begins } = withFault(
        connect(file),
        () => false,
        () => new Error('never thrown'),
        0,
      );
      const { db } = realmDb(file, { budgetMs, connection: wrapped });
      // The setup's own check: (1) red when the lock is not free at the start (a call left it
      // held); (2) prints the value tryTake returned.
      expect(db.lock.tryTake()).toBe(true);
      const pending = settle(db.immediate(insert('queued'), verified));
      await sleep(budgetMs + 50);
      if (writerLetsGo) holder.exec('ROLLBACK');
      db.lock.release();
      const out = await pending;
      if (!writerLetsGo) holder.exec('ROLLBACK');
      return { error: summary(out.error), attempts: begins.length, rows: values(file) };
    };
    const landed = await queuedPastTheBudget(true);
    const stillHeld = await queuedPastTheBudget(false);
    // (1) red when a call whose budget passed in the queue is refused without an attempt (the
    //     first case's row does not land and its attempts are 0), or, counting from the first busy
    //     answer, waits a fresh budget (the second case makes several attempts). (2) prints both
    //     outcomes, the BEGINs each made and the rows.
    expect({ landed, stillHeld }).toEqual({
      landed: { error: summary(undefined), attempts: 1, rows: ['queued'] },
      stillHeld: {
        error: {
          workflowError: true,
          code: 'STATE_RUN_BUSY',
          errcode: undefined,
          message:
            'The store was busy for 0.1 s: another writer held it. Nothing was written. Try again.',
          details: { budget_ms: 100 },
        },
        attempts: 1,
        rows: [],
      },
    });
  });

  it('unit 9 check 9: fifty calls whose budget passed in the queue do not stop the program: each yields to the event loop before its one attempt', async () => {
    const file = freshFile();
    const holder = connect(file);
    holder.exec('BEGIN IMMEDIATE');
    // Every BEGIN the class sends is stamped with the number of turns the event loop has taken so far
    // (a loop that turns once per setImmediate), on a real connection that passes everything on.
    const { wrapped } = withFault(
      connect(file),
      () => false,
      () => new Error('never thrown'),
      0,
    );
    let turns = 0;
    let spinning = true;
    const spin = (): void => {
      turns += 1;
      if (spinning) setImmediate(spin);
    };
    setImmediate(spin);
    const turnsAtBegin: number[] = [];
    const stamped: DatabaseLike = {
      exec(sql) {
        if (sql.startsWith('BEGIN')) turnsAtBegin.push(turns);
        wrapped.exec(sql);
      },
      prepare: (sql) => wrapped.prepare(sql),
      close: () => wrapped.close(),
      get isTransaction() {
        return wrapped.isTransaction;
      },
    };
    const { db } = realmDb(file, { budgetMs: 100, connection: stamped });
    const outs = await Promise.all(
      Array.from({ length: 50 }, (_, i) => settle(db.immediate(insert(i), verified))),
    );
    spinning = false;
    holder.exec('ROLLBACK');
    // The first call waits out its budget in several attempts; each of the other 49 gets the lock
    // after its budget has passed and makes exactly one attempt, so those are the last 49 BEGINs.
    const queued = turnsAtBegin.slice(-49);
    const distinct = new Set(queued).size;
    // (1) red when a call that got the lock after its budget passed makes its attempt without
    //     yielding: the lock is handed on without the loop turning, so the 49 attempts run back to
    //     back, each blocking for the busy timeout, and the program stops for about a second
    //     (measured: 1,041-1,087 ms idle and under load; with the yield 22-62 ms;
    //     plans/issue-616/ia2-u09/probes/burst-results.md); they then share one turn count. It counts
    //     loop turns, not milliseconds: the check this replaced bounded the longest gap at 300 ms
    //     and failed on the macOS runner at 646 and 459 ms (CI run 42321890910 and its re-run) with
    //     the yield in place. Also red when a call is not refused busy, or a row landed. (2) prints
    //     how many of the 49 attempts began in a turn of their own.
    expect(
      {
        everyAttemptInATurnOfItsOwn: distinct === 49,
        refusals: [...new Set(outs.map((o) => (o.error as { code?: unknown })?.code))],
        rows: values(file),
      },
      `${distinct} of 49 queued attempts began in a turn of their own`,
    ).toEqual({ everyAttemptInATurnOfItsOwn: true, refusals: ['STATE_RUN_BUSY'], rows: [] });
  });

  it('correction check 3: autocommit waits for a busy store, then refuses it with STATE_RUN_BUSY, nothing written', async () => {
    const file = freshFile();
    const holder = connect(file);
    holder.exec('BEGIN IMMEDIATE');
    const { db } = realmDb(file, { budgetMs: 200 });
    const started = performance.now();
    const out = await settle(db.autocommit(insert('while busy')));
    const elapsed = performance.now() - started;
    holder.exec('ROLLBACK');
    // (1) red when autocommit takes no busy wait or no mapping (SQLite's raw "database is locked",
    //     code ERR_SQLITE_ERROR, errcode 5, leaves), when it is refused sooner than the budget (no
    //     wait, the lock and the mapping kept: refused after one attempt), or when a row landed.
    //     (2) prints the error, the rows and the elapsed time.
    expect(
      { error: summary(out.error), notBeforeTheBudget: elapsed >= 200, rows: values(file) },
      `elapsed ${elapsed.toFixed(0)} ms`,
    ).toEqual({
      notBeforeTheBudget: true,
      error: {
        workflowError: true,
        code: 'STATE_RUN_BUSY',
        errcode: undefined,
        message:
          'The store was busy for 0.2 s: another writer held it. Nothing was written. Try again.',
        details: { budget_ms: 200 },
      },
      rows: [],
    });
  });

  it('correction check 3: autocommit maps a real full database to STATE_STORE_FULL', async () => {
    const file = freshFile();
    const conn = connect(file);
    const pages = Number(conn.prepare('PRAGMA page_count').get()?.['page_count']);
    conn.exec(`PRAGMA max_page_count = ${pages + 1}`);
    const { db } = realmDb(file, { connection: conn });
    const out = await settle(db.autocommit(insert('x'.repeat(200_000))));
    // (1) red when autocommit does not map SQLite's error 13 (the raw "database or disk is full"
    //     leaves), or when a row landed. (2) prints the error and the rows.
    expect({ error: summary(out.error), rows: values(file) }).toEqual({
      error: {
        workflowError: true,
        code: 'STATE_STORE_FULL',
        errcode: undefined,
        message:
          "The Realm store could not be written: its disk, or the database's size limit, is full. " +
          'Nothing was written. Free space, then try again.',
        details: {},
      },
      rows: [],
    });
  });

  it('correction check 4: a body that returns a promise is refused in all three forms; the lock is released and the next call works', async () => {
    const file = freshFile();
    const { db } = realmDb(file);
    const promise = (): Promise<string> => Promise.resolve('late');
    const lockFree = (): boolean => {
      const free = db.lock.tryTake();
      if (free) db.lock.release();
      return free;
    };
    const autocommit = {
      refused: summary((await settle(db.autocommit(pastTheType(promise)))).error),
      lockFree: lockFree(),
      next: (await settle(db.autocommit(() => 'next'))).value,
    };
    const snapshot = {
      refused: summary((await settle(db.snapshot(pastTheType(promise)))).error),
      lockFree: lockFree(),
      next: (await settle(db.snapshot(() => 'next'))).value,
    };
    const immediate = {
      refused: summary((await settle(db.immediate(pastTheType(promise), verified))).error),
      lockFree: lockFree(),
      next: (await settle(db.immediate(() => 'next', verified))).value,
    };
    const each = {
      refused: {
        workflowError: false,
        code: undefined,
        errcode: undefined,
        message:
          'A store body returned a promise: a body is synchronous, so that a transaction never ' +
          'spans an await. This is a bug in the caller.',
      },
      lockFree: true,
      next: 'next',
    };
    // (1) red when a form accepts a returned promise (its call resolves with 'late'), when the
    //     refusal leaves the in-process lock held, or when the next call in that form fails.
    //     (2) prints each form's refusal, whether the lock was free and the next call's value.
    expect({ autocommit, snapshot, immediate }).toEqual({
      autocommit: each,
      snapshot: each,
      immediate: each,
    });
  });
});
