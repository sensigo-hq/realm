// commit-protocol-616.test.ts — issue #616 PR-1a unit 9: THE COMMIT OUTCOME PROTOCOL. When a write's
// COMMIT reports an error, its caller learns one of three things — the write landed, it did not, or
// it cannot be known — and the store stays usable. Every cell opens a real Realm home through
// `RealmDb.open` (the one loader, the real schema, the open's own reopen) and writes a synthetic
// write: the meta row's `tomb_seq` set to a value, read back by its content.
//
// Faults: real SQLite cannot be made to fail at COMMIT here, so each cell's COMMIT error is injected
// at the driver seam (`test-support/commit-faults.ts`: a wrapper over the real connection that throws
// SQLite's own error shape, captured on both SQLite floors). What is real in each cell is named in
// its comment: the read-back, the resolving commit, another connection's lock, a full database in a
// body, the reopen.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REALM_STORE_SCHEMA_VERSION, WorkflowError } from '@sensigo/realm';
import type { Clock } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { RealmDb, VerifyInconclusive, type Verify } from './connection.js';
import { openDatabase, type DatabaseLike } from './driver.js';
import { DATABASE_FILE } from './home.js';
import { faultyFiles, SQLITE, type Fault, type FaultyFiles } from './test-support/commit-faults.js';

const clock: Clock = { now: () => new Date('2026-11-06T09:00:00.000Z'), at: () => () => undefined };

const dirs: string[] = [];
const stores: RealmDb[] = [];
const others: DatabaseLike[] = [];
const timers: NodeJS.Timeout[] = [];
afterEach(() => {
  for (const t of timers.splice(0)) clearTimeout(t);
  for (const c of others.splice(0)) {
    try {
      if (c.isTransaction) c.exec('ROLLBACK');
      c.close();
    } catch {
      // closed by its cell
    }
  }
  for (const db of stores.splice(0)) {
    try {
      db.close();
    } catch {
      // closed by its cell, or left closed by a failed reopen
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Store {
  readonly db: RealmDb;
  readonly file: string;
  readonly files: FaultyFiles;
}

/** A fresh Realm home, opened through the open's `openFile` seam so faults can be armed. */
async function store(budgetMs?: number): Promise<Store> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u09-'));
  dirs.push(dir);
  const home = join(dir, '.realm');
  const files = faultyFiles((path) => openDatabase(path));
  const db = await RealmDb.open(
    home,
    { clock, ...(budgetMs === undefined ? {} : { budgetMs }) },
    { openFile: files.openFile },
  );
  stores.push(db);
  return { db, file: join(home, DATABASE_FILE), files };
}

/** Arms `fault` on the connection the store uses now (the last one the open or a reopen made). */
function arm(s: Store, fault: Fault): void {
  s.files.opened[s.files.opened.length - 1]!.arm(fault);
}

/** The write's own COMMIT fails, the first time, in the way `first` says; `also` runs at that moment. */
function failCommit(s: Store, first: Fault['first'], error: () => Error, also?: () => void): void {
  arm(s, { at: (sql) => sql === 'COMMIT', times: 1, first, error, ...(also ? { also } : {}) });
}

/** Every resolving commit on the store's present connection fails with an I/O error. */
function failResolvingCommits(s: Store): void {
  arm(s, {
    at: (sql) => sql.startsWith('UPDATE store_meta SET commit_epoch'),
    times: Infinity,
    first: 'nothing',
    error: SQLITE.ioError,
  });
}

/** Another program's connection on the store file (the open's busy timeout). */
function other(file: string): DatabaseLike {
  const c = openDatabase(file);
  c.exec('PRAGMA busy_timeout = 20');
  others.push(c);
  return c;
}

/** The meta row's two counters, read on a connection of their own. */
function meta(file: string): { tombSeq: number; commitEpoch: number } {
  const row = other(file).prepare('SELECT tomb_seq, commit_epoch FROM store_meta').get();
  return { tombSeq: Number(row?.['tomb_seq']), commitEpoch: Number(row?.['commit_epoch']) };
}

/** The synthetic write's check: the meta row's `tomb_seq` is what the write set (by content). */
const tombSeqIsThere: Verify<number> = (c, to) => {
  const stored = Number(c.prepare('SELECT tomb_seq FROM store_meta').get()?.['tomb_seq']);
  if (stored > to) throw new VerifyInconclusive(`tomb_seq ${stored} is above the written ${to}`);
  return stored === to;
};

/** The synthetic write: sets the meta row's `tomb_seq` to `to`, and returns it. */
function write(s: Store, to: number): Promise<number> {
  return s.db.immediate(
    (c) => {
      c.prepare('UPDATE store_meta SET tomb_seq = ?').run(to);
      return to;
    },
    tombSeqIsThere,
    { takesReading: false },
  );
}

/** What a call settled with: its value, or its error. */
async function settle<T>(p: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await p };
  } catch (error) {
    return { error };
  }
}

/** The parts of an error a cell compares (store errors: no credential in any of them). */
function summary(err: unknown): Record<string, unknown> {
  if (err === undefined) return { none: true };
  const e = err as { code?: unknown; message?: unknown; commitOutcome?: unknown };
  return {
    workflowError: err instanceof WorkflowError,
    code: err instanceof WorkflowError ? err.code : undefined,
    message: e.message,
    ...(err instanceof WorkflowError ? { details: err.details } : {}),
    commitOutcome: e.commitOutcome,
  };
}

/** Whether the in-process lock is free (taken and given back at once when it is). */
function lockFree(db: RealmDb): boolean {
  const free = db.lock.tryTake();
  if (free) db.lock.release();
  return free;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The fenced refusal, as a caller reads it. */
function fenced(cause: string | undefined, commitOutcome?: unknown): Record<string, unknown> {
  return {
    workflowError: true,
    code: 'STATE_STORE_WRITES_FENCED',
    message:
      `The store cannot confirm whether its last write was saved${cause === undefined ? '' : ` (${cause})`}, ` +
      'so it refuses new writes until it can. Read back what you wrote to see what was saved, then ' +
      'try again.',
    details: cause === undefined ? {} : { cause },
    commitOutcome,
  };
}

const FULL_SENTENCE =
  "The Realm store could not be written: its disk, or the database's size limit, is full. " +
  'Nothing was written. Free space, then try again.';

describe('#616 unit 9 — the COMMIT outcome protocol', () => {
  it('check 1: a COMMIT that fails with a statement pending answers not_landed, and nothing was written', async () => {
    const s = await store();
    // Driver seam: SQLite's own answer to a COMMIT with a statement in progress (error 5, the
    // transaction left open: both real, `ia2-u09/probes/pending.out`).
    failCommit(s, 'nothing', SQLITE.pending);
    const out = await settle(write(s, 7));
    const next = await settle(write(s, 8));
    // (1) red when a COMMIT error with the transaction still open is answered as unknown (fenced:
    //     the next write is refused), or as landed, or the row landed. (2) prints both calls'
    //     outcomes and the meta row.
    expect({ out: summary(out.error), next: next.value, meta: meta(s.file) }).toEqual({
      out: {
        workflowError: false,
        code: undefined,
        message: 'cannot commit transaction - SQL statements in progress (SQLite error 5)',
        commitOutcome: { outcome: 'not_landed', errcode: 5 },
      },
      next: 8,
      meta: { tombSeq: 8, commitEpoch: 0 },
    });
  });

  it('check 1: a deferred constraint at COMMIT answers not_landed with the programming-error flag', async () => {
    const s = await store();
    // Driver seam: SQLite's own answer to a deferred constraint at COMMIT (787, the transaction left
    // open: both real). The schema declares no deferred constraint, so a 787 is a programming error.
    failCommit(s, 'nothing', SQLITE.deferredConstraint);
    const out = await settle(write(s, 7));
    // (1) red when the 787 is answered without the programming-error flag, or as anything but
    //     not_landed, or the row landed. (2) prints the outcome and the meta row.
    expect({ out: summary(out.error), meta: meta(s.file) }).toEqual({
      out: {
        workflowError: false,
        code: undefined,
        message: 'FOREIGN KEY constraint failed (SQLite error 787)',
        commitOutcome: { outcome: 'not_landed', errcode: 787, programmingError: true },
      },
      meta: { tombSeq: 0, commitEpoch: 0 },
    });
  });

  it('check 2: a COMMIT that reports an I/O error after the data reached the file answers landed (the synthetic write)', async () => {
    const s = await store();
    // Driver seam: the COMMIT runs, then the error (the connection reports no open transaction).
    // Real: the read-back by content.
    failCommit(s, 'run', SQLITE.ioError);
    const out = await settle(write(s, 7));
    const next = await settle(write(s, 8));
    // (1) red when the answer comes from the class's own transaction flag (set after every failed
    //     COMMIT: the landed write is called not_landed), or the read-back is skipped. (2) prints
    //     the call's value or error, the next write and the meta row.
    expect({
      value: out.value,
      error: summary(out.error),
      next: next.value,
      meta: meta(s.file),
    }).toEqual({
      value: 7,
      error: { none: true },
      next: 8,
      meta: { tombSeq: 8, commitEpoch: 0 },
    });
  });

  it('check 3: a read-back that meets a recovery-busy is retried and answers; one that never answers is unknown', async () => {
    const answers = async (times: number) => {
      const s = await store(300);
      failCommit(s, 'run', SQLITE.ioError);
      // Driver seam: the read-back's own statement answers 261 (`BUSY_RECOVERY`, the first read
      // after a crash), `times` times.
      arm(s, {
        at: (sql) => sql === 'SELECT tomb_seq FROM store_meta',
        times,
        first: 'nothing',
        error: SQLITE.busyRecovery,
      });
      const out = await settle(write(s, 7));
      return { value: out.value, error: summary(out.error), meta: meta(s.file) };
    };
    const once = await answers(1);
    const always = await answers(Infinity);
    // (1) red when a throwing read-back is taken as "not seen" (the resolving commit then answers
    //     not_landed for a write that landed: the first case), or a read-back that never answers
    //     is anything but unknown. (2) prints both outcomes and the meta rows.
    expect({ once, always }).toEqual({
      once: { value: 7, error: { none: true }, meta: { tombSeq: 7, commitEpoch: 0 } },
      always: {
        value: undefined,
        error: fenced(undefined, { outcome: 'unknown', errcode: 10 }),
        meta: { tombSeq: 7, commitEpoch: 0 },
      },
    });
  });

  it('check 3b: a read-back that finds a newer version stored answers unknown', async () => {
    const s = await store();
    // Driver seam: the COMMIT runs, then the error; meanwhile another connection (real) stores a
    // newer value, so the write may have landed and been superseded.
    failCommit(s, 'run', SQLITE.ioError, () => {
      other(s.file).prepare('UPDATE store_meta SET tomb_seq = 9').run();
    });
    const out = await settle(write(s, 7));
    // (1) red when a verify that throws `VerifyInconclusive` is answered landed (or not_landed).
    //     (2) prints the outcome and the meta row.
    expect({ out: summary(out.error), meta: meta(s.file) }).toEqual({
      out: fenced(undefined, { outcome: 'unknown', errcode: 10 }),
      meta: { tombSeq: 9, commitEpoch: 0 },
    });
  });

  it('check 4: the resolving commit waits out another writer that holds the lock for 1.5 s, and answers not_landed', async () => {
    const s = await store(3_000);
    const holder = other(s.file);
    // Driver seam: SQLite rolled the write back, then the error. Real: another connection takes the
    // write lock at that moment and holds it for 1.5 s; the read-back; the resolving commit.
    failCommit(s, 'rollback', SQLITE.ioError, () => {
      holder.exec('BEGIN IMMEDIATE');
      timers.push(setTimeout(() => holder.exec('ROLLBACK'), 1_500));
    });
    const started = performance.now();
    const out = await settle(write(s, 7));
    const elapsed = performance.now() - started;
    const next = await settle(write(s, 8));
    // (1) red when the resolving commit is a single short attempt (it answers unknown and fences:
    //     the next write is refused), or the answer comes before the holder let go. (2) prints the
    //     outcome, the elapsed time, the next write and the meta row.
    expect(
      {
        out: summary(out.error),
        waitedForTheHolder: elapsed >= 1_400,
        next: next.value,
        meta: meta(s.file),
      },
      `elapsed ${elapsed.toFixed(0)} ms`,
    ).toEqual({
      out: {
        workflowError: false,
        code: undefined,
        message: 'disk I/O error (SQLite error 10)',
        commitOutcome: { outcome: 'not_landed', errcode: 10 },
      },
      waitedForTheHolder: true,
      next: 8,
      meta: { tombSeq: 8, commitEpoch: 1 },
    });
  });

  it('check 4: a call whose busy budget passed in the queue still gets a fresh budget for its resolving commit', async () => {
    const budgetMs = 2_000;
    const s = await store(budgetMs);
    const holder = other(s.file);
    failCommit(s, 'rollback', SQLITE.ioError, () => {
      holder.exec('BEGIN IMMEDIATE');
      timers.push(setTimeout(() => holder.exec('ROLLBACK'), 1_500));
    });
    // The in-process lock held past the call's budget, as a long call of the process holds it.
    // (1) red when the lock is not free at the start. (2) prints what tryTake returned.
    expect(s.db.lock.tryTake()).toBe(true);
    const pending = settle(write(s, 7));
    await sleep(budgetMs + 100);
    s.db.lock.release();
    const out = await pending;
    // (1) red when the resolving commit's budget counts from the call (it is spent in the queue:
    //     one attempt, unknown, fenced). (2) prints the outcome and the meta row.
    expect({ out: summary(out.error), meta: meta(s.file) }).toEqual({
      out: {
        workflowError: false,
        code: undefined,
        message: 'disk I/O error (SQLite error 10)',
        commitOutcome: { outcome: 'not_landed', errcode: 10 },
      },
      meta: { tombSeq: 0, commitEpoch: 1 },
    });
  });

  it('check 5: an unknown outcome fences writes, with its cause; reads are served; once a resolving commit succeeds the store writes again', async () => {
    const budgetMs = 300;
    const s = await store(budgetMs);
    // Driver seam: a full disk at COMMIT after SQLite rolled back, and every resolving commit on
    // that connection fails. Real: the reopen, another writer's lock, the reads.
    failCommit(s, 'rollback', SQLITE.full);
    failResolvingCommits(s);
    const unknown = await settle(write(s, 7));
    const holder = other(s.file);
    holder.exec('BEGIN IMMEDIATE');
    const refused = await settle(write(s, 8));
    const read = await settle(
      s.db.snapshot((c) =>
        Number(c.prepare('SELECT tomb_seq FROM store_meta').get()?.['tomb_seq']),
      ),
    );
    const opensWhileFenced = s.files.opened.length;
    holder.exec('ROLLBACK');
    const landed = await settle(write(s, 9));
    // (1) red when an unknown outcome does not fence (the second write waits for the holder and is
    //     refused busy instead), the cause is lost, a read is refused while fenced, the connection
    //     is not reopened before the next call (one connection only), or the store never writes
    //     again. (2) prints every call's outcome, the opens and the meta row.
    expect({
      unknown: summary(unknown.error),
      refused: summary(refused.error),
      read: read.value,
      opensWhileFenced,
      landed: landed.value,
      meta: meta(s.file),
    }).toEqual({
      unknown: fenced('STATE_STORE_FULL', {
        outcome: 'unknown',
        cause: 'STATE_STORE_FULL',
        errcode: 13,
      }),
      refused: fenced('STATE_STORE_FULL', undefined),
      read: 0,
      opensWhileFenced: 2,
      landed: 9,
      meta: { tombSeq: 9, commitEpoch: 1 },
    });
  });

  it('check 6: a concurrent schema bump between the error and the read-back does not turn landed into a refusal', async () => {
    const s = await store();
    // Driver seam: the COMMIT runs, then the error; meanwhile another connection (real) bumps the
    // file's `user_version`, as a newer Realm upgrading it would.
    failCommit(s, 'run', SQLITE.ioError, () => {
      other(s.file).exec(`PRAGMA user_version = ${REALM_STORE_SCHEMA_VERSION + 1}`);
    });
    const out = await settle(write(s, 7));
    // (1) red when the read-back re-reads `user_version` (the landed write is then answered
    //     unknown with the newer-version refusal). (2) prints the outcome and the meta row.
    expect({ value: out.value, error: summary(out.error), meta: meta(s.file) }).toEqual({
      value: 7,
      error: { none: true },
      meta: { tombSeq: 7, commitEpoch: 0 },
    });
  });

  it('check 7: a reopen that fails once releases the lock, and the next call opens afresh and writes', async () => {
    const s = await store(300);
    failCommit(s, 'rollback', SQLITE.ioError);
    failResolvingCommits(s);
    const unknown = await settle(write(s, 7));
    // Real: the open's own reopen; it fails once (the file cannot be opened: SQLite's 14 at the
    // driver seam), then works.
    s.files.failNextOpen(SQLITE.cantOpen);
    const failed = await settle(write(s, 8));
    const freeAfterTheFailure = lockFree(s.db);
    const next = await Promise.race([
      settle(write(s, 9)),
      sleep(2_000).then(() => ({ value: 'still waiting after 2 s', error: undefined })),
    ]);
    // (1) red when a failed reopen keeps the lock (the next call waits for ever) or is taken as
    //     done (the next call runs on the old connection: one open only). (2) prints each call's
    //     outcome, the lock, the opens and the meta row.
    expect({
      unknown: (summary(unknown.error).commitOutcome as { outcome?: string })?.outcome,
      failed: summary(failed.error),
      freeAfterTheFailure,
      next: next.value,
      opens: s.files.opened.length,
      meta: meta(s.file),
    }).toEqual({
      unknown: 'unknown',
      failed: {
        workflowError: true,
        code: 'STATE_STORE_READONLY',
        message: `Realm cannot write to ${s.file}: unable to open database file. The store needs a home that Realm can write to.`,
        details: { path: s.file, reason: 'unable to open database file' },
        commitOutcome: undefined,
      },
      freeAfterTheFailure: true,
      next: 9,
      opens: 2,
      meta: { tombSeq: 9, commitEpoch: 1 },
    });
  });

  it('check 8: a full database, in a body (real) or at COMMIT (driver seam), surfaces as STATE_STORE_FULL; the store is usable once space is freed', async () => {
    const s = await store();
    // Real: the database's size limit at its present size, so a write that needs a page is full.
    await s.db.autocommit((c) => {
      const pages = Number(c.prepare('PRAGMA page_count').get()?.['page_count']);
      c.exec(`PRAGMA max_page_count = ${pages}`);
    });
    const bigStamp = (c: DatabaseLike): boolean => {
      c.prepare(
        'INSERT INTO write_clock (one, at) VALUES (1, ?) ON CONFLICT(one) DO UPDATE SET at = excluded.at',
      ).run('x'.repeat(200_000));
      c.prepare('UPDATE write_clock SET at = NULL').run();
      return true;
    };
    const stampCleared: Verify<boolean> = (c) =>
      c.prepare('SELECT 1 AS one FROM write_clock WHERE one = 1 AND at IS NULL').get() !==
      undefined;
    const inTheBody = await settle(s.db.immediate(bigStamp, stampCleared, { takesReading: false }));
    // Driver seam: a full disk at COMMIT, after SQLite rolled the transaction back.
    failCommit(s, 'rollback', SQLITE.full);
    const atCommit = await settle(write(s, 7));
    const freed = await settle(s.db.autocommit((c) => c.exec('PRAGMA max_page_count = 1000000')));
    const afterFreeing = await settle(
      s.db.immediate(bigStamp, stampCleared, { takesReading: false }),
    );
    const next = await settle(write(s, 8));
    // (1) red when the rollback after a failed COMMIT throws its own error ("no transaction is
    //     active") over the full one, the full error is not STATE_STORE_FULL, or the store does
    //     not write once space is freed. (2) prints both refusals, the later writes and the row.
    expect({
      inTheBody: summary(inTheBody.error),
      atCommit: summary(atCommit.error),
      freed: summary(freed.error),
      afterFreeing: afterFreeing.value,
      next: next.value,
      meta: meta(s.file),
    }).toEqual({
      inTheBody: {
        workflowError: true,
        code: 'STATE_STORE_FULL',
        message: FULL_SENTENCE,
        details: {},
        commitOutcome: undefined,
      },
      atCommit: {
        workflowError: true,
        code: 'STATE_STORE_FULL',
        message: FULL_SENTENCE,
        details: {},
        commitOutcome: { outcome: 'not_landed', cause: 'STATE_STORE_FULL', errcode: 13 },
      },
      freed: { none: true },
      afterFreeing: true,
      next: 8,
      meta: { tombSeq: 8, commitEpoch: 1 },
    });
  });

  it('the lock: three calls queued behind a busy store run in call order', async () => {
    const s = await store(3_000);
    const holder = other(s.file);
    holder.exec('BEGIN IMMEDIATE');
    const next = (): Promise<number> =>
      s.db.immediate(
        (c) => {
          c.exec('UPDATE store_meta SET tomb_seq = tomb_seq + 1');
          return Number(c.prepare('SELECT tomb_seq FROM store_meta').get()?.['tomb_seq']);
        },
        tombSeqIsThere,
        { takesReading: false },
      );
    const calls = [next(), next(), next()];
    await sleep(200);
    holder.exec('ROLLBACK');
    const got = await Promise.all(calls);
    // (1) red when the lock hands itself on out of call order (a last-in-first-out queue: 1, 3,
    //     2). (2) prints the value each call wrote, in call order.
    expect(got).toEqual([1, 2, 3]);
  });

  it('the lock: it is free after every error path', async () => {
    const s = await store(200);
    // After each path: whether the lock was free. A lock left held is recorded, then let go, so the
    // later paths still run and the cell names every path that held it.
    const after = async (call: () => Promise<unknown>): Promise<boolean> => {
      await settle(call());
      const free = lockFree(s.db);
      if (!free) s.db.lock.release();
      return free;
    };
    const free: Record<string, boolean> = {};
    free['a body that throws'] = await after(() =>
      s.db.immediate(
        () => {
          throw new Error('the body refused');
        },
        () => true,
        { takesReading: false },
      ),
    );
    const holder = other(s.file);
    holder.exec('BEGIN IMMEDIATE');
    free['a busy refusal'] = await after(() => write(s, 1));
    holder.exec('ROLLBACK');
    failCommit(s, 'nothing', SQLITE.pending);
    free['not_landed'] = await after(() => write(s, 2));
    failCommit(s, 'run', SQLITE.ioError);
    free['landed after an error'] = await after(() => write(s, 3));
    failCommit(s, 'rollback', SQLITE.ioError);
    failResolvingCommits(s);
    free['unknown'] = await after(() => write(s, 4));
    s.files.failNextOpen(SQLITE.cantOpen);
    free['a failed reopen'] = await after(() => write(s, 5));
    holder.exec('BEGIN IMMEDIATE');
    free['a fenced refusal'] = await after(() => write(s, 6));
    holder.exec('ROLLBACK');
    // (1) red when any error path leaves the lock held (the next call would wait for ever).
    //     (2) prints each path and whether the lock was free after it.
    expect(free).toEqual({
      'a body that throws': true,
      'a busy refusal': true,
      not_landed: true,
      'landed after an error': true,
      unknown: true,
      'a failed reopen': true,
      'a fenced refusal': true,
    });
  });
});
