// run-store-delete-616.test.ts — issue #616 PR-1a unit 14: a run's deletion and its stored size
// (`SqliteRunStore.deleteAllForRun` and `statAllForRun`, core's `PerRunArtifactStore`), on real homes
// in a temp directory, through `openRealmHome`. The real cases: `realm run purge` deleting a finished
// run as the last store (the anchor), at the version it selected the run at, after the other stores
// deleted theirs; purge's dry run showing the bytes it would delete; a run resumed, changed or given a
// pending finalizer since purge looked; a run already gone; a busy store; a COMMIT that fails before
// or after its rows reached the file; SQLite refusing one of the deletion's statements; and a caller
// that holds several deletions in one transaction and goes on after one failed (purge's batches).
//
// Since unit 16 the per-run artifact contract and the clock law's deletion leg also run against
// this store (`contract-artifact-616.test.ts`: `L1_ABSENCE_RESOLVES` to `L6_PREVIEW_EQUALS_RECEIPT`
// and `STORE_RELEASE_LINE_TRUE`; `contract-clock-616.test.ts`: `READS_ONE_READING` with
// `recordsDeletionTime`). These cells stay for what no shared law sees: the rows and text a write
// leaves, the exact refusals and their words, and the COMMIT protocol. Unit 15b carries the key
// read after a deletion (check 9).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkflowError,
  type Clock,
  type CreateRunOptions,
  type EvidenceSnapshot,
  type RunRecord,
  type WorkflowContextSnapshot,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseLike } from './driver.js';
import { openRealmHome } from './index.js';
import type { OpenSeams } from './open-file.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { deleteRunRows } from './run-rows.js';
import { faultyFiles, SQLITE, type FaultyFiles } from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

/** The instant the cells' clocks start at: years from the machine's, so SQLite's own time differs. */
const T = '2030-05-06T07:08:09.000Z';

/** The instant a deletion is stamped at: the clock is set to it just before the delete. */
const AT = '2030-05-09T10:11:12.345Z';

const dirs: string[] = [];
const handles: RealmHome[] = [];
const connections: DatabaseLike[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u14-'));
  dirs.push(dir);
  return dir;
}

/** A test clock: it answers the instant it is set to and counts its readings. */
function testClock(start: string): { clock: Clock; set(iso: string): void; reads(): number } {
  let now = Date.parse(start);
  let reads = 0;
  return {
    clock: {
      now: () => {
        reads += 1;
        return new Date(now);
      },
      at: () => () => undefined,
    },
    set: (iso) => {
      now = Date.parse(iso);
    },
    reads: () => reads,
  };
}

/** An open home: its folder and its run store. */
interface Opened {
  readonly home: string;
  readonly runStore: RealmHome['runStore'];
}

/** Opens a home on `clock` (with the open's seams when given). */
async function open(clock: Clock, seams?: OpenSeams): Promise<Opened> {
  const home = join(tmp(), '.realm');
  const handle = await (seams === undefined
    ? openRealmHome({ home, clock })
    : openHome({ home, clock }, seams));
  handles.push(handle);
  return { home, runStore: handle.runStore };
}

/** Another connection on the home's file (the other stores' writer, the reader of what is stored). */
async function foreign(home: string): Promise<DatabaseLike> {
  const c = await openForeignConnection(home);
  connections.push(c);
  return c;
}

/** A refusal as a host sees it: a typed refusal's fields, or a plain error's name and message. */
function refusal(err: unknown): unknown {
  return err instanceof WorkflowError
    ? {
        code: err.code,
        message: err.message,
        category: err.category,
        agentAction: err.agentAction,
        retryable: err.retryable,
        details: err.details,
      }
    : `${(err as Error).name}: ${(err as Error).message}`;
}

/** What a synchronous call did: `'ok'`, or its error's name and message. */
function settleSync(call: () => unknown): string {
  try {
    call();
    return 'ok';
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  }
}

/** What a deletion did: its receipt, or its refusal. */
const deletion = (call: Promise<{ bytes_deleted: number }>): Promise<unknown> =>
  call.then((receipt) => ({ receipt }), refusal);

/** One evidence entry of step `a`, as the engine writes it. */
function entry(i: number, answer: string): EvidenceSnapshot {
  return {
    step_id: 'a',
    started_at: '2030-05-06T07:00:00.000Z',
    completed_at: '2030-05-06T07:00:01.000Z',
    duration_ms: 1000,
    input_summary: { i },
    output_summary: { answer },
    status: 'success',
    evidence_hash: `${i}`.padStart(64, '0'),
  };
}

/** The workflow's context files as the engine snapshots them (the write-once field). */
function contextFiles(content: string): Record<string, WorkflowContextSnapshot> {
  return {
    'guide.md': {
      source_path: '/work/guide.md',
      content,
      content_hash: 'cd'.repeat(32),
      loaded_at: '2030-05-06T07:00:00.000Z',
    },
  };
}

const BARE: CreateRunOptions = { workflowId: 'wf', workflowVersion: 1, params: {} };

/**
 * A finished run as the engine leaves one: two evidence entries, its context files, sealed by the
 * `complete` arm; `fields` adds to the sealing write (a finalizer, a gate).
 */
async function finished(
  runStore: Opened['runStore'],
  fields: Partial<RunRecord> = {},
  options: CreateRunOptions = BARE,
): Promise<RunRecord> {
  const { record } = await runStore.create(options);
  const sealed = await runStore.update({
    ...record,
    evidence: [entry(0, 'the first answer'), entry(1, 'the second answer')],
    workflow_context_snapshots: contextFiles('The guide.'),
    ...fields,
    terminal_state: true,
    sealed_by: { arm: 'complete' },
    terminal_reason: 'Workflow completed.',
  });
  return sealed.record;
}

/** How many rows of `table` hold `id` in `column`, as a second connection sees them. */
function count(c: DatabaseLike, table: string, column: string, id: string): number {
  return Number(c.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(id)?.['n']);
}

/** What the store keeps of a run, as a second connection sees it: its rows in the run store's tables. */
function kept(c: DatabaseLike, id: string): Record<string, number> {
  return {
    runs: count(c, 'runs', 'id', id),
    evidence: count(c, 'evidence', 'run_id', id),
    run_blobs: count(c, 'run_blobs', 'run_id', id),
  };
}

/** A run's tombstone rows, as a second connection sees them: each row's `purged_at`. */
function tombstones(
  c: DatabaseLike,
  id: string,
): { purged_ids: unknown[]; purged_runs: unknown[] } {
  const stamps = (table: string): unknown[] =>
    c
      .prepare(`SELECT purged_at FROM ${table} WHERE id = ?`)
      .all(id)
      .map((r) => r['purged_at']);
  return { purged_ids: stamps('purged_ids'), purged_runs: stamps('purged_runs') };
}

/** The `write_clock` rows, as a second connection sees them. */
const writeClock = (c: DatabaseLike): unknown[] =>
  c
    .prepare('SELECT one, at FROM write_clock')
    .all()
    .map((r) => [r['one'], r['at']]);

describe('#616 unit 14 — deleteAllForRun: what a deletion removes and how it is stamped', () => {
  it("check 1: a deletion removes the run's rows from the run store's tables and keeps the other stores' rows of it; the tables holding a run id are exactly the five classified", async () => {
    const { home, runStore } = await open(testClock(T).clock);
    const run = await finished(runStore);
    const c = await foreign(home);
    // The other three stores' rows of the run, as their stores write them (plain rows, no triggers).
    c.prepare('INSERT INTO failed_attempts (run_id, seq, line) VALUES (?, 1, ?)').run(
      run.id,
      '{"ts":0}',
    );
    c.prepare(
      'INSERT INTO trace_buffer (run_id, step_id, line_seq, ts, nonce, entries, entry_count, bytes) ' +
        "VALUES (?, 'a', 1, 0, NULL, '[]', 0, 2)",
    ).run(run.id);
    c.prepare(
      "INSERT INTO trace_sealed (run_id, step_id, seal_seq, lines, bytes) VALUES (?, 'a', 1, '[]', 2)",
    ).run(run.id);
    // From the file's own schema, not typed by hand: every table with a `run_id` column.
    const runIdTables = c
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => String(r['name']))
      .filter(
        (t) =>
          c.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = 'run_id'").get(t) !==
          undefined,
      );
    const rowsOf = (): Record<string, number> => ({
      runs: count(c, 'runs', 'id', run.id),
      ...Object.fromEntries(runIdTables.map((t) => [t, count(c, t, 'run_id', run.id)])),
    });
    const before = rowsOf();
    await runStore.deleteAllForRun(run.id);
    // (1) red when a table holding a run id is added and not classified here (a sixth name), when
    //     the deletion skips one of the run store's tables (its evidence rows left behind, the
    //     Temporal #11233 class), or when it deletes another store's rows of the run (a DELETE over
    //     every `run_id` table); (2) prints the tables found and each table's rows before and after.
    expect({ runIdTables, before, after: rowsOf() }).toEqual({
      runIdTables: ['evidence', 'failed_attempts', 'run_blobs', 'trace_buffer', 'trace_sealed'],
      before: {
        runs: 1,
        evidence: 2,
        run_blobs: 1,
        failed_attempts: 1,
        trace_buffer: 1,
        trace_sealed: 1,
      },
      after: {
        runs: 0,
        evidence: 0,
        run_blobs: 0,
        failed_attempts: 1,
        trace_buffer: 1,
        trace_sealed: 1,
      },
    });
    // (1) red when the deletion writes no tombstone or two, or leaves its stamp in `write_clock`
    //     (a later foreign deletion would then be stamped with it); (2) prints the tombstone rows
    //     and `write_clock`.
    expect({
      tombstones: {
        purged_ids: tombstones(c, run.id).purged_ids.length,
        purged_runs: tombstones(c, run.id).purged_runs.length,
      },
      writeClock: writeClock(c),
    }).toEqual({ tombstones: { purged_ids: 1, purged_runs: 1 }, writeClock: [[1, null]] });
  });

  it("check 2: the tombstone is stamped with the deletion's reading of the home's clock, not SQLite's time", async () => {
    const t = testClock(T);
    const { home, runStore } = await open(t.clock);
    const run = await finished(runStore);
    t.set(AT);
    await runStore.deleteAllForRun(run.id);
    const c = await foreign(home);
    // (1) red when `write_clock` is not set before the run's row is deleted (the trigger then
    //     stamps SQLite's own time, years from the home's clock); (2) prints both rows' stamps.
    expect(tombstones(c, run.id)).toEqual({ purged_ids: [AT], purged_runs: [AT] });
  });

  it('check 3: the stat before a deletion equals its receipt, and both are the UTF-8 bytes of the stored record, evidence entries and write-once values', async () => {
    const { home, runStore } = await open(testClock(T).clock);
    const run = await finished(
      runStore,
      {
        evidence: [entry(0, 'Zürich — 東京 ✓'), entry(1, 'Grüße, señor')],
        workflow_context_snapshots: contextFiles('Ελληνικά and 日本語: the guide.'),
      },
      { ...BARE, params: { city: 'São Paulo' } },
    );
    const c = await foreign(home);
    const texts = [
      ...c.prepare('SELECT record AS t FROM runs WHERE id = ?').all(run.id),
      ...c.prepare('SELECT entry AS t FROM evidence WHERE run_id = ?').all(run.id),
      ...c.prepare('SELECT value AS t FROM run_blobs WHERE run_id = ?').all(run.id),
    ].map((r) => String(r['t']));
    const utf8 = texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
    const chars = texts.reduce((sum, text) => sum + text.length, 0);
    const stat = await runStore.statAllForRun(run.id);
    const receipt = await runStore.deleteAllForRun(run.id);
    // (1) red when the measure counts characters (`length`, n8n's legacy bug: the figure falls
    //     short of the bytes), leaves the write-once values or the evidence out, or when the stat
    //     and the delete measure differently (L6); (2) prints the stat, the receipt, the UTF-8 sum
    //     and the character sum (they must differ, or the cell cannot tell bytes from characters).
    expect({
      stat: stat.bytes,
      receipt: receipt.bytes_deleted,
      pieces: texts.length,
      charsDiffer: chars !== utf8,
    }).toEqual({ stat: utf8, receipt: utf8, pieces: 4, charsDiffer: true });
  });
});

describe('#616 unit 14 — deleteAllForRun: the refusals, as the JSON store refuses', () => {
  it('check 4: a live run is refused as no longer terminal, deleting nothing and spending no reading', async () => {
    const t = testClock(T);
    const { home, runStore } = await open(t.clock);
    const { record: run } = await runStore.create(BARE);
    const c = await foreign(home);
    const reads = t.reads();
    const outcome = await deletion(runStore.deleteAllForRun(run.id));
    // (1) red when a live run is deleted (the terminal check dropped), when the refusal's words or
    //     fields are not the JSON store's (`runBusyError`), when the refusal comes back wrapped as a
    //     delete failure (the failure flag set around the store's own refusals), or when it spends a
    //     reading; (2) prints the outcome, the run's rows and the readings spent.
    expect({ outcome, kept: kept(c, run.id), readings: t.reads() - reads }).toEqual({
      outcome: {
        code: 'STATE_RUN_BUSY',
        message: `Run '${run.id}' is no longer terminal — refusing to delete (it may have been resumed)`,
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: true,
        details: { runId: run.id, reason: 'no_longer_terminal' },
      },
      kept: { runs: 1, evidence: 0, run_blobs: 0 },
      readings: 0,
    });
  });

  it('check 4: a run resumed by a Realm from before #281 (not terminal, still carrying abandoned_at, so its derived phase is abandoned) is refused as no longer terminal', async () => {
    const t = testClock(T);
    const { home, runStore } = await open(t.clock);
    const { record } = await runStore.create(BARE);
    const resumed = (await runStore.update({ ...record, abandoned_at: T })).record;
    const c = await foreign(home);
    const reads = t.reads();
    const outcome = await deletion(runStore.deleteAllForRun(resumed.id));
    // (1) red when the `terminal_state` half of the check is dropped (the derived phase alone calls
    //     this run finished); (2) prints the run's phase, the outcome, its rows and the readings.
    expect({
      phase: resumed.run_phase,
      outcome,
      kept: kept(c, resumed.id),
      readings: t.reads() - reads,
    }).toEqual({
      phase: 'abandoned',
      outcome: {
        code: 'STATE_RUN_BUSY',
        message: `Run '${resumed.id}' is no longer terminal — refusing to delete (it may have been resumed)`,
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: true,
        details: { runId: resumed.id, reason: 'no_longer_terminal' },
      },
      kept: { runs: 1, evidence: 0, run_blobs: 0 },
      readings: 0,
    });
  });

  it('check 4: a finished run with a finalizer still pending is refused until it is drained or voided', async () => {
    const t = testClock(T);
    const { home, runStore } = await open(t.clock);
    const run = await finished(runStore, {
      finalizer_ledger: { notify: { status: 'pending', rank: 0 } },
    });
    const c = await foreign(home);
    const reads = t.reads();
    const outcome = await deletion(runStore.deleteAllForRun(run.id));
    // (1) red when the finalizer check is dropped (the run is deleted under its undrained
    //     finalizer), or its words or fields are not the JSON store's; (2) prints the outcome, the
    //     run's rows and the readings spent.
    expect({ outcome, kept: kept(c, run.id), readings: t.reads() - reads }).toEqual({
      outcome: {
        code: 'STATE_RUN_BUSY',
        message:
          `Run '${run.id}' has a pending finalizer — refusing to delete until it is drained or ` +
          `voided (realm run drain ${run.id} / --void <finalizer>)`,
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: true,
        details: { runId: run.id, reason: 'drain_pending' },
      },
      kept: { runs: 1, evidence: 2, run_blobs: 1 },
      readings: 0,
    });
  });

  it('check 4: a run changed since the caller selected it is refused with the version conflict, checked before the terminal check; at the stored version it is deleted', async () => {
    const t = testClock(T);
    const { home, runStore } = await open(t.clock);
    const run = await finished(runStore);
    const { record: created } = await runStore.create(BARE);
    const live = (await runStore.update({ ...created, evidence: [entry(0, 'one')] })).record;
    const c = await foreign(home);
    const reads = t.reads();
    const stale = await deletion(
      runStore.deleteAllForRun(run.id, undefined, { expectVersion: run.version - 1 }),
    );
    const staleLive = await deletion(
      runStore.deleteAllForRun(live.id, undefined, { expectVersion: live.version - 1 }),
    );
    const refusedReadings = t.reads() - reads;
    const keptAfterRefusals = { finished: kept(c, run.id), live: kept(c, live.id) };
    const current = await deletion(
      runStore.deleteAllForRun(run.id, undefined, { expectVersion: run.version }),
    );
    const conflict = (id: string, expected: number, actual: number): unknown => ({
      code: 'STATE_SNAPSHOT_MISMATCH',
      details: { runId: id, expected, actual },
    });
    const brief = (o: unknown): unknown => {
      if (typeof o !== 'object' || o === null || !('code' in o)) return o;
      const refused = o as { code: unknown; details?: unknown };
      return { code: refused.code, details: refused.details };
    };
    // (1) red when `expectVersion` is ignored (the stale call deletes the run), when the version is
    //     checked after the terminal check (the live run answers busy instead of the conflict), or
    //     when a refusal spends a reading or deletes; (2) prints each outcome's code and details,
    //     the rows kept and the readings spent.
    expect({
      stale: brief(stale),
      staleLive: brief(staleLive),
      refusedReadings,
      keptAfterRefusals,
      current: brief(current),
      after: kept(c, run.id),
    }).toEqual({
      stale: conflict(run.id, run.version - 1, run.version),
      staleLive: conflict(live.id, live.version - 1, live.version),
      refusedReadings: 0,
      keptAfterRefusals: {
        finished: { runs: 1, evidence: 2, run_blobs: 1 },
        live: { runs: 1, evidence: 1, run_blobs: 0 },
      },
      current: { receipt: { bytes_deleted: expect.any(Number) as number } },
      after: { runs: 0, evidence: 0, run_blobs: 0 },
    });
  });

  it('check 4: a finished run that still carries a pending gate, whose phase column a foreign write set to gate_waiting (the #282 class), is deleted: the phase is derived, never read from the column', async () => {
    const { home, runStore } = await open(testClock(T).clock);
    const run = await finished(runStore, {
      pending_gate: {
        gate_id: 'g1',
        step_name: 'a',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: T,
      },
    });
    const c = await foreign(home);
    c.prepare("UPDATE runs SET run_phase = 'gate_waiting' WHERE id = ?").run(run.id);
    const column = c.prepare('SELECT run_phase FROM runs WHERE id = ?').get(run.id)?.['run_phase'];
    const outcome = await deletion(runStore.deleteAllForRun(run.id));
    // (1) red when the deletion decides from the stored `run_phase` column (this run is then
    //     refused as no longer terminal); (2) prints the column, the run's derived phase, the
    //     outcome and the rows kept.
    expect({ column, derived: run.run_phase, outcome, after: kept(c, run.id) }).toEqual({
      column: 'gate_waiting',
      derived: 'completed',
      outcome: { receipt: { bytes_deleted: expect.any(Number) as number } },
      after: { runs: 0, evidence: 0, run_blobs: 0 },
    });
  });
});

describe('#616 unit 14 — absent runs and readings', () => {
  it('check 5: a run never stored and a run already deleted resolve with zero bytes, write no tombstone and spend no reading; their stat is zero', async () => {
    const t = testClock(T);
    const { home, runStore } = await open(t.clock);
    const run = await finished(runStore);
    await runStore.deleteAllForRun(run.id);
    const c = await foreign(home);
    const tombs = (): unknown[] => [
      Number(c.prepare('SELECT count(*) AS n FROM purged_runs').get()?.['n']),
      Number(c.prepare('SELECT tomb_seq FROM store_meta').get()?.['tomb_seq']),
    ];
    const tombsBefore = tombs();
    const reads = t.reads();
    const never = randomUUID();
    const outcomes = {
      never: await deletion(runStore.deleteAllForRun(never)),
      again: await deletion(runStore.deleteAllForRun(run.id)),
      statNever: await runStore.statAllForRun(never),
      statAgain: await runStore.statAllForRun(run.id),
    };
    // (1) red when an absent run is refused (it must resolve: absence is success, #183), when it
    //     writes a tombstone or spends a reading, or when its stat is not zero; (2) prints each
    //     outcome, the tombstone count and counter before and after, and the readings spent.
    expect({ outcomes, tombs: [tombsBefore, tombs()], readings: t.reads() - reads }).toEqual({
      outcomes: {
        never: { receipt: { bytes_deleted: 0 } },
        again: { receipt: { bytes_deleted: 0 } },
        statNever: { bytes: 0 },
        statAgain: { bytes: 0 },
      },
      tombs: [
        [1, 1],
        [1, 1],
      ],
      readings: 0,
    });
  });

  it("check 6: a deletion spends one reading of the home's clock; the stat spends none", async () => {
    const t = testClock(T);
    const { runStore } = await open(t.clock);
    const run = await finished(runStore);
    const beforeStat = t.reads();
    await runStore.statAllForRun(run.id);
    const stat = t.reads() - beforeStat;
    const beforeDelete = t.reads();
    await runStore.deleteAllForRun(run.id);
    // (1) red when the stat takes a reading (its snapshot without `{ takesReading: false }`), or
    //     when the deletion takes none or more than one; (2) prints both counts.
    expect({ stat, deletion: t.reads() - beforeDelete }).toEqual({ stat: 0, deletion: 1 });
  });
});

describe('#616 unit 14 — deleteAllForRun: failures', () => {
  /** A home whose store connection can be given faults, with a finished run in it. */
  async function faultyHome(): Promise<{
    home: string;
    runStore: Opened['runStore'];
    files: FaultyFiles;
    run: RunRecord;
  }> {
    const files = faultyFiles((path) => openDatabase(path));
    const { home, runStore } = await open(testClock(T).clock, { openFile: files.openFile });
    const run = await finished(runStore);
    return { home, runStore, files, run };
  }

  /** A delete failure as purge files it: its code, its sentence and its failures. */
  const failure = (o: unknown): unknown => {
    if (typeof o !== 'object' || o === null || !('code' in o)) return o;
    const refused = o as { code: unknown; message: unknown; details?: { failures?: unknown } };
    return { code: refused.code, message: refused.message, failures: refused.details?.failures };
  };

  it('check 7: a COMMIT that SQLite rolled back is a delete failure naming the runs, and the run stays; a COMMIT that errs after its rows reached the file resolves with the receipt', async () => {
    const rolledBack = await faultyHome();
    rolledBack.files.opened.at(-1)!.arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'rollback',
      error: SQLITE.ioError,
    });
    const notLanded = await deletion(rolledBack.runStore.deleteAllForRun(rolledBack.run.id));
    const c1 = await foreign(rolledBack.home);
    // (1) red when the deletion's check answers true without looking (the rolled-back deletion
    //     then resolves as a success), or when a COMMIT that did not land passes unwrapped;
    //     (2) prints the failure, the run's rows and its tombstones.
    expect({
      outcome: failure(notLanded),
      kept: kept(c1, rolledBack.run.id),
      tombstones: tombstones(c1, rolledBack.run.id),
    }).toEqual({
      outcome: {
        code: 'ENGINE_ARTIFACT_DELETE_FAILED',
        message: `SqliteRunStore failed to delete artifact(s) for run '${rolledBack.run.id}': runs (SQLITE_IOERR)`,
        failures: [
          { artifact: 'runs', code: 'SQLITE_IOERR', message: 'disk I/O error (SQLite error 10)' },
        ],
      },
      kept: { runs: 1, evidence: 2, run_blobs: 1 },
      tombstones: { purged_ids: [], purged_runs: [] },
    });

    const landed = await faultyHome();
    landed.files.opened.at(-1)!.arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'run',
      error: SQLITE.ioError,
    });
    const outcome = await deletion(landed.runStore.deleteAllForRun(landed.run.id));
    const c2 = await foreign(landed.home);
    // (1) red when the deletion's check cannot see its own landed deletion (the call then rejects
    //     though the run is gone); (2) prints the outcome, the run's rows and its tombstone count.
    expect({
      outcome,
      kept: kept(c2, landed.run.id),
      tombstones: tombstones(c2, landed.run.id).purged_ids.length,
    }).toEqual({
      outcome: { receipt: { bytes_deleted: expect.any(Number) as number } },
      kept: { runs: 0, evidence: 0, run_blobs: 0 },
      tombstones: 1,
    });
  });

  it("check 8: a statement SQLite refuses inside the deletion is a delete failure with SQLite's name for the code and its own text; nothing is deleted and no stamp is left", async () => {
    const { home, runStore, files, run } = await faultyHome();
    // A trigger on the store's own connection that refuses the evidence delete, with a text that
    // is none of the file's mapped guard messages (so the mapper leaves it SQLite's plain error).
    files.opened
      .at(-1)!
      .connection.exec(
        'CREATE TEMP TRIGGER refuse_evidence_delete BEFORE DELETE ON main.evidence ' +
          "BEGIN SELECT RAISE(ABORT, 'unit 14: this evidence may not be deleted'); END",
      );
    const outcome = await deletion(runStore.deleteAllForRun(run.id));
    const c = await foreign(home);
    // (1) red when the failure passes unwrapped, names the raw code (`SQLITE_1811`) instead of
    //     SQLite's name for it, or loses SQLite's text, or when the deletion's rows or its stamp
    //     survive the failure; (2) prints the failure, the run's rows, its tombstones and
    //     `write_clock`.
    expect({
      outcome: failure(outcome),
      kept: kept(c, run.id),
      tombstones: tombstones(c, run.id),
      writeClock: writeClock(c),
    }).toEqual({
      outcome: {
        code: 'ENGINE_ARTIFACT_DELETE_FAILED',
        message: `SqliteRunStore failed to delete artifact(s) for run '${run.id}': runs (SQLITE_CONSTRAINT)`,
        failures: [
          {
            artifact: 'runs',
            code: 'SQLITE_CONSTRAINT',
            message: 'unit 14: this evidence may not be deleted (SQLite error 1811)',
          },
        ],
      },
      kept: { runs: 1, evidence: 2, run_blobs: 1 },
      tombstones: { purged_ids: [], purged_runs: [] },
      writeClock: [],
    });
  });

  it("check 8: a store another program holds past the busy budget is the primitive's busy refusal, unwrapped, and the deletion spends no reading", async () => {
    const t = testClock(T);
    const { home, runStore } = await open(t.clock);
    const run = await finished(runStore);
    const holder = await foreign(home);
    holder.exec('BEGIN IMMEDIATE');
    const reads = t.reads();
    const outcome = await deletion(runStore.deleteAllForRun(run.id));
    holder.exec('ROLLBACK');
    // (1) red when the busy refusal comes back wrapped as a delete failure (every error wrapped),
    //     or when the deletion spends a reading before it has the lock; (2) prints the outcome's
    //     code and details, and the readings spent.
    expect({
      code: (outcome as { code?: unknown }).code,
      details: (outcome as { details?: unknown }).details,
      readings: t.reads() - reads,
      kept: kept(holder, run.id),
    }).toEqual({
      code: 'STATE_RUN_BUSY',
      details: { budget_ms: 5000 },
      readings: 0,
      kept: { runs: 1, evidence: 2, run_blobs: 1 },
    });
  }, 30_000); // its busy refusal waits out the store's 5 s budget

  it("the deletion's writer is all or nothing by its own savepoint: when SQLite refuses its evidence delete inside a transaction its caller holds and goes on with, the run, its rows and write_clock are as before (authorized by MA 3)", async () => {
    const { home, runStore } = await open(testClock(T).clock);
    const run = await finished(runStore);
    const c = await foreign(home);
    // A trigger of this connection only, refusing the evidence delete (after the run row went).
    c.exec(
      'CREATE TEMP TRIGGER refuse_evidence_delete BEFORE DELETE ON main.evidence ' +
        "BEGIN SELECT RAISE(ABORT, 'unit 14: this evidence may not be deleted'); END",
    );
    const before = { kept: kept(c, run.id), writeClock: writeClock(c) };
    c.exec('BEGIN IMMEDIATE');
    const failed = settleSync(() => deleteRunRows(c, run.id, AT));
    const inTransaction = {
      kept: kept(c, run.id),
      tombstones: tombstones(c, run.id),
      writeClock: writeClock(c),
      open: c.isTransaction,
    };
    c.exec('ROLLBACK');
    // (1) red when the writer has no savepoint of its own (the run row's delete, its tombstone and
    //     the `write_clock` stamp then stay in the caller's transaction, and a caller that goes on
    //     commits them), or when `write_clock` is set before the savepoint (the stamp then
    //     survives the rollback); (2) prints the error, the rows before, and what the caller's
    //     transaction holds after it.
    expect({ failed, before, inTransaction }).toEqual({
      failed: 'Error: unit 14: this evidence may not be deleted',
      before: { kept: { runs: 1, evidence: 2, run_blobs: 1 }, writeClock: [] },
      inTransaction: {
        kept: { runs: 1, evidence: 2, run_blobs: 1 },
        tombstones: { purged_ids: [], purged_runs: [] },
        writeClock: [],
        open: true,
      },
    });
  });
});
