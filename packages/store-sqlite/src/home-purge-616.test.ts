// home-purge-616.test.ts — issue #616 PR-2c c9: the home's purge (`RealmHome.purge`, `home-purge.ts`), on
// real homes in a temp directory, through `openRealmHome`. The real cases: `realm run purge --force`
// deleting finished runs with every store's rows of them (evidence, a write-once value, trace lines and
// a seal, failed attempts); a run that changed, was given a pending finalizer, or is not finished by
// the time its batch reads it; a selection larger than one batch while another process writes; a run
// whose text must not stay readable in the store file or its log after the purge; the bytes the
// stores deleted and the bytes the file shrank by; a COMMIT that SQLite rolled back; another process
// reading the file during the purge, so its checkpoint cannot complete; a file a newer Realm migrated
// mid-purge; an empty selection; a closed handle.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveRunPhase,
  REALM_STORE_PAGE_SIZE,
  REALM_STORE_SCHEMA_VERSION,
  WorkflowError,
  type Clock,
  type CreateRunOptions,
  type EvidenceSnapshot,
  type RunRecord,
  type WorkflowContextSnapshot,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseLike, type StatementLike } from './driver.js';
import { DATABASE_FILE } from './home.js';
import { PURGE_BATCH_RUNS, VACUUM_STEP_PAGES, type PurgeReport } from './home-purge.js';
import { openRealmHome } from './index.js';
import type { OpenSeams } from './open-file.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { insertRunRecord } from './run-rows.js';
import { faultyFiles, SQLITE } from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

/** The instant the cells' clocks start at: years from the machine's, so SQLite's own time differs. */
const T = '2030-05-06T07:08:09.000Z';

const dirs: string[] = [];
const handles: RealmHome[] = [];
const connections: DatabaseLike[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) {
    try {
      c.close();
    } catch {
      // closed by its cell
    }
  }
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-c9-'));
  dirs.push(dir);
  return dir;
}

/** A clock whose every reading is one second after the last, so each reading stamps its own instant. */
function tickingClock(): { clock: Clock; reads(): number } {
  let reads = 0;
  return {
    clock: {
      now: () => new Date(Date.parse(T) + 1000 * reads++),
      at: () => () => undefined,
    },
    reads: () => reads,
  };
}

/** An open home: its folder and its handle. */
interface Opened {
  readonly home: string;
  readonly handle: RealmHome;
}

/** Opens a fresh home (through the open's seams when given). */
async function open(seams?: OpenSeams): Promise<Opened> {
  const home = join(tmp(), '.realm');
  const { clock } = tickingClock();
  const handle = await (seams === undefined
    ? openRealmHome({ home, clock })
    : openHome({ home, clock }, seams));
  handles.push(handle);
  return { home, handle };
}

/** Another connection on the home's file: another process's reader or writer. */
async function foreign(home: string): Promise<DatabaseLike> {
  const c = await openForeignConnection(home);
  connections.push(c);
  return c;
}

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

/** The workflow's context files as the engine snapshots them (the write-once field: a blob row). */
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
 * A finished run as the engine leaves one, with a row in every store that keeps rows of a run: two
 * evidence entries and its context files (the run store), two trace lines sealed on step `a` and one
 * live line on step `b` (the trace buffer), two failed attempts. `fields` adds to the sealing write.
 */
async function finished(
  handle: RealmHome,
  fields: Partial<RunRecord> = {},
  options: CreateRunOptions = BARE,
): Promise<RunRecord> {
  const { record } = await handle.runStore.create(options);
  await handle.traceBufferStore.append(record.id, 'a', [{ event: 'drafting the reply' }]);
  await handle.traceBufferStore.append(record.id, 'a', [{ event: 'the reply is drafted' }]);
  await handle.failedAttemptStore.append(record.id, '{"attempt":1,"error":"timeout"}');
  await handle.failedAttemptStore.append(record.id, '{"attempt":2,"error":"rate limit"}');
  const sealed = await handle.runStore.update({
    ...record,
    evidence: [entry(0, 'the first answer'), entry(1, 'the second answer')],
    workflow_context_snapshots: contextFiles('The guide.'),
    ...fields,
    terminal_state: true,
    sealed_by: { arm: 'complete' },
    terminal_reason: 'Workflow completed.',
  });
  if (sealed.record.finalizer_ledger === undefined) {
    const store = handle.traceBufferStore as Required<RealmHome['traceBufferStore']>;
    await store.sealFenced(record.id, 'a', { kind: 'run_absent_or_terminal' });
  }
  await handle.traceBufferStore.append(record.id, 'b', [{ event: 'a line after the seal' }]);
  return sealed.record;
}

/** What the three stores report a run keeps, summed: the dry run's preview of it. */
async function statOf(handle: RealmHome, runId: string): Promise<number> {
  const parts = await Promise.all([
    handle.runStore.statAllForRun(runId),
    handle.traceBufferStore.statAllForRun(runId),
    handle.failedAttemptStore.statAllForRun(runId),
  ]);
  return parts.reduce((sum, part) => sum + part.bytes, 0);
}

/** Every table of the file with a `run_id` column, read from its own schema (not typed by hand). */
function runIdTables(c: DatabaseLike): string[] {
  return c
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => String(r['name']))
    .filter(
      (t) =>
        c.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = 'run_id'").get(t) !== undefined,
    );
}

/** A run's rows in `runs` and in every table with a `run_id` column, as a second connection sees them. */
function rowsOf(c: DatabaseLike, id: string): Record<string, number> {
  const n = (sql: string): number => Number(c.prepare(sql).get(id)?.['n']);
  return {
    runs: n('SELECT count(*) AS n FROM runs WHERE id = ?'),
    ...Object.fromEntries(
      runIdTables(c).map((t) => [t, n(`SELECT count(*) AS n FROM ${t} WHERE run_id = ?`)]),
    ),
  };
}

/** A run's tombstone stamps, as a second connection sees them. */
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

/** A refusal as a host sees it: its code, its reason and its sentence. */
function refusal(err: unknown): unknown {
  return err instanceof WorkflowError
    ? { code: err.code, reason: err.details['reason'], message: err.message }
    : `${(err as Error).name}: ${(err as Error).message}`;
}

/** The report's runs, each as its outcome and its bytes or its refusal. */
function outcomes(report: PurgeReport): Record<string, unknown> {
  return Object.fromEntries(
    report.runs.map((r) => [
      r.runId,
      r.outcome === 'purged'
        ? { purged: r.bytes_deleted }
        : r.outcome === 'already_gone'
          ? 'already gone'
          : { [r.outcome]: refusal(r.error) },
    ]),
  );
}

/** How many times `marker` occurs in a file of the home (0 when the file is not there). */
function copies(home: string, file: string, marker: string): number {
  const path = join(home, file);
  return existsSync(path) ? readFileSync(path).toString('latin1').split(marker).length - 1 : 0;
}

/** A file's size on disk, 0 when it is not there. */
function size(home: string, file: string): number {
  const path = join(home, file);
  return existsSync(path) ? statSync(path).size : 0;
}

/**
 * The open's `openFile` seam over the real driver, with a hook at each `BEGIN IMMEDIATE` the home's
 * connection is sent once counting starts: the hook runs BEFORE the statement is forwarded, so a
 * foreign write made there lands before that transaction begins. The open's own set-up and the
 * fixture's writes begin transactions too, so counting starts at the purge's call.
 */
function beginHooks(): {
  seams: OpenSeams;
  start(at: Record<number, () => void>): void;
  begins(): number;
} {
  let counting = false;
  let begins = 0;
  let hooks: Record<number, () => void> = {};
  const wrap = (real: DatabaseLike): DatabaseLike => ({
    exec(sql: string): void {
      if (counting && sql === 'BEGIN IMMEDIATE') {
        begins += 1;
        hooks[begins]?.();
      }
      real.exec(sql);
    },
    prepare: (sql: string): StatementLike => real.prepare(sql),
    close: () => real.close(),
    get isTransaction() {
      return real.isTransaction;
    },
  });
  return {
    seams: { openFile: (path) => wrap(openDatabase(path)) },
    start(at) {
      hooks = at;
      begins = 0;
      counting = true;
    },
    begins: () => begins,
  };
}

/** Writes a new run on a foreign connection in a write transaction of its own: another process's write. */
function foreignRun(c: DatabaseLike, id: string): void {
  const record: Record<string, unknown> = {
    id,
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 0,
    params: {},
    evidence: [],
    created_at: T,
    updated_at: T,
  };
  record['run_phase'] = deriveRunPhase(record as unknown as RunRecord);
  c.exec('BEGIN IMMEDIATE');
  insertRunRecord(c, record as unknown as RunRecord);
  c.exec('COMMIT');
}

/** The selection a caller hands the purge: each run with the version it was selected at. */
const select = (runs: readonly RunRecord[]): Array<{ runId: string; version: number }> =>
  runs.map((r) => ({ runId: r.id, version: r.version }));

describe('#616 PR-2c c9 — the home’s purge: what one batch deletes, and how it is judged', () => {
  it('A: one batch deletes every store’s rows of its runs, stamps them with one reading, and reports the bytes the stores reported before', async () => {
    const { home, handle } = await open();
    const runs = [await finished(handle), await finished(handle), await finished(handle)];
    const c = await foreign(home);
    const before = Object.fromEntries(runs.map((r) => [r.id, rowsOf(c, r.id)]));
    const stats = Object.fromEntries(
      await Promise.all(runs.map(async (r) => [r.id, await statOf(handle, r.id)] as const)),
    );
    const report = await handle.purge(select(runs));
    const stamps = runs.map((r) => tombstones(c, r.id));
    const nothingLeft = Object.fromEntries(
      Object.keys(before[runs[0]!.id]!).map((table) => [table, 0]),
    );
    // (1) red when a store's rows of a deleted run are left behind (the trace buffer's or the failed
    //     attempts' delete left out of the batch), when the fixture stops writing a row in a table
    //     (its "before" count falls to 0, so the cell cannot see that table emptied), when a run is
    //     stamped with a reading of its own (three stamps instead of one), or when a run's bytes
    //     differ from what the three stores' stats reported before (L6); (2) prints each run's rows
    //     before and after, the stamps, and each run's outcome beside its stat.
    expect({
      before: before[runs[0]!.id],
      after: runs.map((r) => rowsOf(c, r.id)),
      stamps: new Set(stamps.flatMap((s) => [...s.purged_ids, ...s.purged_runs])).size,
      tombstoneRows: stamps.map((s) => [s.purged_ids.length, s.purged_runs.length]),
      outcomes: outcomes(report),
      stored: report.stored_bytes_deleted,
    }).toEqual({
      before: {
        runs: 1,
        evidence: 2,
        failed_attempts: 2,
        run_blobs: 1,
        trace_buffer: 1,
        trace_sealed: 1,
      },
      after: [nothingLeft, nothingLeft, nothingLeft],
      stamps: 1,
      tombstoneRows: [
        [1, 1],
        [1, 1],
        [1, 1],
      ],
      outcomes: Object.fromEntries(runs.map((r) => [r.id, { purged: stats[r.id] }])),
      stored: runs.reduce((sum, r) => sum + stats[r.id]!, 0),
    });
  });

  it('B: each run is judged inside its batch — a run changed since selection, one with a pending finalizer and one not finished are refused in unit 14’s words and kept whole, and the deletable run goes', async () => {
    const { home, handle } = await open();
    const changed = await finished(handle);
    const draining = await finished(handle, {
      finalizer_ledger: { notify: { status: 'pending', rank: 0 } },
    });
    const { record: live } = await handle.runStore.create(BARE);
    const deletable = await finished(handle);
    const selection = select([changed, draining, live, deletable]);
    // After selection, another writer changes the finished run (its version moves; it stays finished).
    await handle.runStore.update({ ...changed, params: { note: 'changed since selection' } });
    const c = await foreign(home);
    const kept = [changed, draining, live].map((r) => r.id);
    const before = await Promise.all(
      kept.map(async (id) => [rowsOf(c, id), await statOf(handle, id)]),
    );
    const report = await handle.purge(selection);
    const after = await Promise.all(
      kept.map(async (id) => [rowsOf(c, id), await statOf(handle, id)]),
    );
    // (1) red when the selected version is not compared (the changed run is deleted), when a
    //     refusal rolls the batch back (the deletable run is kept), when a refused run loses a row
    //     (a store deletes before the run is judged), or when a refusal's words are not unit 14's;
    //     (2) prints every outcome, and the kept runs' rows and bytes before and after.
    expect({
      outcomes: outcomes(report),
      keptWhole: after,
      deletable: rowsOf(c, deletable.id).runs,
    }).toEqual({
      outcomes: {
        [changed.id]: {
          blocked: {
            code: 'STATE_SNAPSHOT_MISMATCH',
            reason: undefined,
            message: 'Version conflict — run was modified by another process',
          },
        },
        [draining.id]: {
          blocked: {
            code: 'STATE_RUN_BUSY',
            reason: 'drain_pending',
            message:
              `Run '${draining.id}' has a pending finalizer — refusing to delete until it is drained ` +
              `or voided (realm run drain ${draining.id} / --void <finalizer>)`,
          },
        },
        [live.id]: {
          blocked: {
            code: 'STATE_RUN_BUSY',
            reason: 'no_longer_terminal',
            message: `Run '${live.id}' is no longer terminal — refusing to delete (it may have been resumed)`,
          },
        },
        [deletable.id]: { purged: expect.any(Number) as number },
      },
      keptWhole: before,
      deletable: 0,
    });
  });

  it('C: a selection larger than one batch takes the write lock once per batch, so another process’s write lands between two batches', async () => {
    const hooks = beginHooks();
    const { home, handle } = await open(hooks.seams);
    const runs: RunRecord[] = [];
    for (let i = 0; i < 2 * PURGE_BATCH_RUNS + 1; i++) {
      const { record } = await handle.runStore.create(BARE);
      runs.push(
        (
          await handle.runStore.update({
            ...record,
            terminal_state: true,
            sealed_by: { arm: 'complete' },
            terminal_reason: 'Workflow completed.',
          })
        ).record,
      );
    }
    const c = await foreign(home);
    let landed = 'not made';
    hooks.start({
      // At the second batch's BEGIN IMMEDIATE, before it is sent: the first batch has committed.
      2: () => {
        try {
          foreignRun(c, 'written-between-batches');
          landed = 'landed';
        } catch (err) {
          landed = `refused: ${(err as Error).message}`;
        }
      },
    });
    const report = await handle.purge(select(runs));
    // (1) red when the whole selection is one transaction (one BEGIN IMMEDIATE: the write between
    //     batches is never made, or waits for the whole purge), when a batch holds more than
    //     PURGE_BATCH_RUNS runs (two BEGINs), or when a run is left; (2) prints the BEGINs counted,
    //     what the foreign write did, whether its row is there, and how many runs were purged.
    expect({
      begins: hooks.begins(),
      landed,
      present: rowsOf(c, 'written-between-batches').runs,
      purged: report.runs.filter((r) => r.outcome === 'purged').length,
    }).toEqual({ begins: 3, landed: 'landed', present: 1, purged: 2 * PURGE_BATCH_RUNS + 1 });
  });
});

/** A finished run whose record carries `marker` repeated `times` (overflow pages, which a delete frees). */
async function markedRun(handle: RealmHome, marker: string, times: number): Promise<RunRecord> {
  return finished(handle, {}, { ...BARE, params: { text: marker.repeat(times) } });
}

/** Moves the fixture's writes from the log into `realm.db`, so the purge measures from the file. */
function checkpointFixture(c: DatabaseLike): unknown {
  return c.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
}

describe('#616 PR-2c c9 — the home’s purge: the free pages, the log, and the figures', () => {
  it('D (L-PURGE): after the purge no text of a deleted run is readable in realm.db or realm.db-wal, the log is empty, and the file shrank', async () => {
    const { home, handle } = await open();
    const MARK = 'RUN-TEXT-616-C9 ';
    const run = await markedRun(handle, MARK, 12_000);
    const c = await foreign(home);
    const fixture = checkpointFixture(c);
    c.close();
    const inFileBefore = copies(home, DATABASE_FILE, MARK);
    const report = await handle.purge(select([run]));
    // (1) red when the vacuum is skipped or run through `stmt.run()` (one page freed: the run's
    //     other overflow pages keep their text in realm.db), when the checkpoint is skipped (the
    //     text stays in the log, which is not 0 bytes), or when the fixture's checkpoint did not
    //     move the text into the file first (the "before" count is 0: the cell would prove
    //     nothing); (2) prints the fixture's checkpoint, the copies before and after in each file,
    //     the log's size, and the report's vacuum, checkpoint and shrink.
    expect({
      fixture,
      inFileBefore: inFileBefore > 0,
      after: {
        file: copies(home, DATABASE_FILE, MARK),
        wal: copies(home, 'realm.db-wal', MARK),
        walBytes: size(home, 'realm.db-wal'),
      },
      checkpoint: report.checkpoint,
      vacuumed: report.vacuum !== undefined && report.vacuum.pages_returned > 1,
      shrank: report.file_bytes_reclaimed > 0,
    }).toEqual({
      fixture: { busy: 0, log: 0, checkpointed: 0 },
      inFileBefore: true,
      after: { file: 0, wal: 0, walBytes: 0 },
      checkpoint: { busy: 0, log: 0, checkpointed: expect.any(Number) as number },
      vacuumed: true,
      shrank: true,
    });
  });

  it('E: stored_bytes_deleted sums the receipts; file_bytes_reclaimed is the file’s shrink on disk, the pages returned times the page size, and 0, never negative, when the pages were still in the log', async () => {
    const checkpointed = await open();
    const runs = [
      await markedRun(checkpointed.handle, 'E-ONE ', 20_000),
      await markedRun(checkpointed.handle, 'E-TWO ', 20_000),
    ];
    const stats = await Promise.all(runs.map((r) => statOf(checkpointed.handle, r.id)));
    const c = await foreign(checkpointed.home);
    checkpointFixture(c);
    c.close();
    const fileBefore = size(checkpointed.home, DATABASE_FILE);
    const report = await checkpointed.handle.purge(select(runs));
    const fileAfter = size(checkpointed.home, DATABASE_FILE);

    const inLog = await open();
    const unflushed = await markedRun(inLog.handle, 'E-LOG ', 20_000);
    const logBefore = size(inLog.home, DATABASE_FILE);
    const fromLog = await inLog.handle.purge(select([unflushed]));
    // (1) red when the shrink is measured before the checkpoint (the vacuum's truncation is still
    //     in the log: 0), when it is not the file's size on disk, when the receipts are not summed,
    //     or when a purge whose deleted pages never left the log reports the file's growth as a
    //     negative figure; (2) prints both purges' figures beside the measured sizes.
    expect({
      stored: report.stored_bytes_deleted,
      reclaimed: report.file_bytes_reclaimed,
      measured: fileBefore - fileAfter,
      pages: (report.vacuum?.pages_returned ?? 0) * REALM_STORE_PAGE_SIZE,
      fromLog: {
        reclaimed: fromLog.file_bytes_reclaimed,
        grew: size(inLog.home, DATABASE_FILE) > logBefore,
      },
    }).toEqual({
      stored: stats[0]! + stats[1]!,
      reclaimed: fileBefore - fileAfter,
      measured: fileBefore - fileAfter,
      pages: fileBefore - fileAfter,
      fromLog: { reclaimed: 0, grew: true },
    });
  });

  it('F: more free pages than one step are returned in several bounded steps, to none', async () => {
    const { home, handle } = await open();
    const run = await markedRun(handle, 'F-PAGES ', 400_000);
    const c = await foreign(home);
    checkpointFixture(c);
    const report = await handle.purge(select([run]));
    const vacuum = report.vacuum ?? { steps: 0, pages_returned: 0 };
    // (1) red when the free pages go back in one unbounded `incremental_vacuum` (one step), when a
    //     step returns more or fewer than its size, or when free pages are left; (2) prints the
    //     steps, the pages returned, the step size and the free pages left.
    expect({
      moreThanOneStep: vacuum.pages_returned > VACUUM_STEP_PAGES,
      steps: vacuum.steps,
      error: 'error' in vacuum ? vacuum.error : undefined,
      freeAfter: Number(c.prepare('PRAGMA freelist_count').get()?.['freelist_count']),
    }).toEqual({
      moreThanOneStep: true,
      steps: Math.ceil(vacuum.pages_returned / VACUUM_STEP_PAGES),
      error: undefined,
      freeAfter: 0,
    });
  });
});

describe('#616 PR-2c c9 — the home’s purge: failures, a busy log, a stopped purge, nothing to do, a closed home', () => {
  it('G: a batch whose COMMIT SQLite rolled back fails its runs with the delete-failure rule’s error, its bytes are not counted, and the next batch runs', async () => {
    const files = faultyFiles((path) => openDatabase(path));
    const { home, handle } = await open({ openFile: files.openFile });
    const runs: RunRecord[] = [];
    for (let i = 0; i < PURGE_BATCH_RUNS + 1; i++) {
      const { record } = await handle.runStore.create(BARE);
      runs.push(
        (
          await handle.runStore.update({
            ...record,
            terminal_state: true,
            sealed_by: { arm: 'complete' },
            terminal_reason: 'Workflow completed.',
          })
        ).record,
      );
    }
    const last = runs.at(-1)!;
    const lastStat = await statOf(handle, last.id);
    files.opened.at(-1)!.arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'rollback',
      error: SQLITE.ioError,
    });
    const report = await handle.purge(select(runs));
    const c = await foreign(home);
    const first = report.runs[0]!;
    const failedRuns = report.runs.filter((r) => r.outcome === 'failed').length;
    const firstError = first.outcome === 'failed' ? (first.error as WorkflowError) : undefined;
    // (1) red when the failed batch's runs are reported purged (the protocol's answer ignored), when
    //     the failure is thrown past the report (the second batch never runs), when its error is
    //     not the shared rule's (store `RealmHome.purge`, artifact `runs`, SQLite's name for the
    //     code), or when the failed batch's bytes are counted; (2) prints the first run's outcome and
    //     error, the failed count, the last run's outcome, the bytes counted and the rows kept.
    expect({
      failedRuns,
      error:
        firstError === undefined
          ? first
          : {
              code: firstError.code,
              message: firstError.message,
              failures: firstError.details['failures'],
            },
      last: report.runs.at(-1),
      stored: report.stored_bytes_deleted,
      firstKept: rowsOf(c, runs[0]!.id).runs,
    }).toEqual({
      failedRuns: PURGE_BATCH_RUNS,
      error: {
        code: 'ENGINE_ARTIFACT_DELETE_FAILED',
        message: `RealmHome.purge failed to delete artifact(s) for run '${runs[0]!.id}': runs (SQLITE_IOERR)`,
        failures: [
          { artifact: 'runs', code: 'SQLITE_IOERR', message: 'disk I/O error (SQLite error 10)' },
        ],
      },
      last: { runId: last.id, outcome: 'purged', bytes_deleted: lastStat },
      stored: lastStat,
      firstKept: 1,
    });
  });

  it('G: a checkpoint another process blocks answers busy: the deletes stand, nothing is thrown, the text stays readable and nothing is reclaimed; a later PASSIVE checkpoint clears realm.db only, a TRUNCATE both files', async () => {
    const { home, handle } = await open();
    const MARK = 'G-BUSY-TEXT ';
    const run = await markedRun(handle, MARK, 12_000);
    const reader = await foreign(home);
    reader.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    // Another process mid-read: its read transaction holds the log's frames.
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) AS n FROM runs').get();
    const report = await handle.purge(select([run]));
    const during = {
      file: copies(home, DATABASE_FILE, MARK) + copies(home, 'realm.db-wal', MARK) > 0,
      walBytes: size(home, 'realm.db-wal') > 0,
    };
    reader.exec('COMMIT');
    const later = await foreign(home);
    const passive = later.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    const afterPassive = {
      file: copies(home, DATABASE_FILE, MARK),
      wal: copies(home, 'realm.db-wal', MARK) > 0,
    };
    later.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const afterTruncate = {
      file: copies(home, DATABASE_FILE, MARK),
      wal: copies(home, 'realm.db-wal', MARK),
    };
    // (1) red when the busy answer is reported as a reset (`busy: 0`), when the failure is thrown
    //     past the report (the deletes invisible), when the shrink reports the vacuum's pages that
    //     are still in the log, or when the busy line's account of a later checkpoint is wrong (a
    //     PASSIVE one leaves the log's copies, a TRUNCATE clears both); (2) prints the report's
    //     checkpoint, the run's outcome, the shrink and the copies at each moment.
    expect({
      checkpoint: report.checkpoint,
      outcome: report.runs[0]?.outcome,
      reclaimed: report.file_bytes_reclaimed,
      during,
      passiveBusy: (passive as { busy?: unknown } | undefined)?.busy,
      afterPassive,
      afterTruncate,
    }).toEqual({
      checkpoint: { busy: 1, log: expect.any(Number) as number, checkpointed: 0 },
      outcome: 'purged',
      reclaimed: 0,
      during: { file: true, walBytes: true },
      passiveBusy: 0,
      afterPassive: { file: 0, wal: true },
      afterTruncate: { file: 0, wal: 0 },
    });
  });

  it('G2: a file a newer Realm migrated before the second batch stops the purge: the first batch stands, the refusal and the runs not attempted are reported', async () => {
    const hooks = beginHooks();
    const { home, handle } = await open(hooks.seams);
    const runs: RunRecord[] = [];
    for (let i = 0; i < 2 * PURGE_BATCH_RUNS; i++) {
      const { record } = await handle.runStore.create(BARE);
      runs.push(
        (
          await handle.runStore.update({
            ...record,
            terminal_state: true,
            sealed_by: { arm: 'complete' },
            terminal_reason: 'Workflow completed.',
          })
        ).record,
      );
    }
    const c = await foreign(home);
    hooks.start({ 2: () => c.exec(`PRAGMA user_version = ${REALM_STORE_SCHEMA_VERSION + 1}`) });
    const report = await handle.purge(select(runs));
    const second = runs.slice(PURGE_BATCH_RUNS).map((r) => r.id);
    // (1) red when the refusal is thrown past the report (the first batch's deletes invisible), when
    //     the refused batch's runs are reported as attempted, or when the first batch is undone;
    //     (2) prints the refusal's code, the runs not attempted, the first batch's outcomes and a
    //     row count of each batch.
    expect({
      stopped: refusal(report.stopped?.error),
      notAttempted: report.stopped?.not_attempted,
      attempted: report.runs.map((r) => r.outcome),
      firstGone: rowsOf(c, runs[0]!.id).runs,
      secondKept: rowsOf(c, second[0]!).runs,
    }).toEqual({
      stopped: {
        code: 'STATE_STORE_VERSION_NEWER',
        reason: undefined,
        message: `This store was migrated by a newer Realm: its schema is version ${REALM_STORE_SCHEMA_VERSION + 1} and this Realm writes version ${REALM_STORE_SCHEMA_VERSION}. Upgrade Realm to read or write it.`,
      },
      notAttempted: second,
      attempted: Array.from({ length: PURGE_BATCH_RUNS }, () => 'purged'),
      firstGone: 0,
      secondKept: 1,
    });
  });

  it('H: an empty selection writes nothing and runs no vacuum and no checkpoint', async () => {
    const { home, handle } = await open();
    const c = await foreign(home);
    // Free pages and a log with frames in it, both of which a vacuum and a checkpoint would change.
    const run = await markedRun(handle, 'H-TEXT ', 12_000);
    c.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    c.exec('BEGIN IMMEDIATE');
    c.prepare('DELETE FROM runs WHERE id = ?').run(run.id);
    c.prepare('DELETE FROM evidence WHERE run_id = ?').run(run.id);
    c.prepare('DELETE FROM run_blobs WHERE run_id = ?').run(run.id);
    c.exec('COMMIT');
    const free = (): number => Number(c.prepare('PRAGMA freelist_count').get()?.['freelist_count']);
    const state = (): unknown => ({
      file: size(home, DATABASE_FILE),
      wal: size(home, 'realm.db-wal'),
      free: free(),
    });
    const before = state();
    const report = await handle.purge([]);
    // (1) red when an empty purge runs the vacuum (the free pages go) or the checkpoint (the log is
    //     reset), or reports a figure; (2) prints the file's and log's sizes and the free pages
    //     before and after, and the report.
    expect({ fixtureHasFreePages: free() > 0, after: state(), report }).toEqual({
      fixtureHasFreePages: true,
      after: before,
      report: { runs: [], stored_bytes_deleted: 0, file_bytes_reclaimed: 0 },
    });
  });

  it('I: after close(), the purge rejects', async () => {
    const { home, handle } = await open();
    handle.close();
    const result = await handle.purge([]).then(
      () => 'resolved',
      (err: unknown) => `${(err as Error).name}: ${(err as Error).message}`,
    );
    // (1) red when a closed handle's purge resolves (an empty selection reaches no statement, so only
    //     the handle's own closed guard can refuse it); (2) prints what the call did.
    expect(result).toBe(`Error: The Realm home ${home} is closed.`);
  });
});
