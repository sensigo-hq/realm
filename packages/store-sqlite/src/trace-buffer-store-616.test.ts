// trace-buffer-store-616.test.ts — issue #616 PR-1b B4: the trace buffer on SQLite. The real cases: an
// agent writes progress lines while its step runs, and a settle reads them (and must see one being
// written that moment) before it seals or deletes them; an agent that lost its claim, or a run that
// ended, must be refused inside the write itself; reclaim and purge delete by fence and read what they
// cleared; export reads every line and must tell a live writer's line from an ordinary one; a store
// failure must reach purge in the contract's typed shape.
//
// Every cell works on a real home through the store's own open. A second writer is a second connection
// on the file (`openForeignConnection`, rows written by plain SQL or `insertRunRecord`); a failure SQLite
// cannot be made to produce here is unit 9's driver-seam fault (`commit-faults.ts`), named at each
// cell. Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUFFER_LIMIT_BYTES,
  BUFFER_LIMIT_COUNT,
  ReclaimVersionChanged,
  SEALED_ARTIFACTS_LIMIT_PER_STEP,
  WorkflowError,
  deriveRunPhase,
  storeDeclaresNonceCarriage,
  storeDeclaresSeal,
  validateTraceCapabilities,
  type AgentTraceEntry,
  type Clock,
  type RunRecord,
  type RunScopedFencePredicate,
} from '@sensigo/realm';
import { steppingClock } from '@sensigo/realm-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { RealmDb } from './connection.js';
import { openDatabase, type DatabaseLike } from './driver.js';
import { openRealmHome } from './open-realm-home.js';
import { insertRunRecord } from './run-rows.js';
import {
  faultyFiles,
  SQLITE,
  type FaultyConnection,
  type FaultyFiles,
} from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';
import { SqliteTraceBufferStore } from './trace-buffer-store.js';

const AT = Date.parse('2026-11-07T09:00:00.000Z');
const fixed: Clock = { now: () => new Date(AT), at: () => () => undefined };
const RUN = '0b4e7c1a-3f5d-4c2e-9a8b-7d6c5e4f3a21';
const OTHER_RUN = '1c5f8d2b-4a6e-4d3f-8b9c-8e7d6f5a4b32';

const dirs: string[] = [];
const closers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const c of closers.splice(0)) {
    try {
      c.close();
    } catch {
      // closed by its cell
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Opened {
  readonly home: string;
  readonly store: SqliteTraceBufferStore;
  readonly files: FaultyFiles;
}

/** A fresh home and its trace buffer, opened through the fault wrapper (no fault armed). */
async function open(options: { clock?: Clock; budgetMs?: number } = {}): Promise<Opened> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-b4-'));
  dirs.push(dir);
  const home = join(dir, '.realm');
  const files = faultyFiles(openDatabase);
  const db = await RealmDb.open(
    home,
    {
      clock: options.clock ?? fixed,
      ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    },
    { openFile: files.openFile },
  );
  closers.push(db);
  return { home, store: new SqliteTraceBufferStore(db), files };
}

/** The store's own connection, to arm a fault on. */
function faults(o: Opened): FaultyConnection {
  const connection = o.files.opened.at(-1);
  if (connection === undefined) throw new Error('the store opened no connection');
  return connection;
}

async function foreign(home: string): Promise<DatabaseLike> {
  const c = await openForeignConnection(home);
  closers.push(c);
  return c;
}

/** Puts a run from a second connection, as PR-1b's fence adapter will. */
function putRun(c: DatabaseLike, record: RunRecord): void {
  c.exec('BEGIN IMMEDIATE');
  try {
    insertRunRecord(c, record);
    c.exec('COMMIT');
  } catch (err) {
    if (c.isTransaction) c.exec('ROLLBACK');
    throw err;
  }
}

/** A run record with the keys a real one carries; `draft` is in progress. */
function run(id: string, fields: Record<string, unknown> = {}): RunRecord {
  const record: Record<string, unknown> = {
    id,
    workflow_id: 'support-reply',
    workflow_version: 3,
    completed_steps: ['classify'],
    in_progress_steps: ['draft'],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 4,
    params: { ticket: 'T-1042' },
    evidence: [],
    created_at: '2026-11-07T08:59:00.000Z',
    updated_at: '2026-11-07T08:59:30.000Z',
    terminal_state: false,
    claims: {},
    extension_identity: [],
    skip_details: {},
    ...fields,
  };
  record['run_phase'] = deriveRunPhase(record as unknown as RunRecord);
  return record as unknown as RunRecord;
}

/** A finished run: every step settled, the run terminal. */
function finished(id: string): RunRecord {
  return run(id, {
    completed_steps: ['classify', 'draft'],
    in_progress_steps: [],
    terminal_state: true,
  });
}

/** How many rows of `table` the file holds for `runId`, read on a second connection. */
function rows(c: DatabaseLike, table: 'trace_buffer' | 'trace_sealed', runId = RUN): number {
  return Number(c.prepare(`SELECT count(*) AS n FROM ${table} WHERE run_id = ?`).get(runId)?.['n']);
}

/** A line written by a second writer, by plain SQL. */
function insertLine(
  c: DatabaseLike,
  line: { step: string; seq: number; ts: number; nonce: string | null; event: string },
): void {
  const entries = JSON.stringify([{ event: line.event }]);
  c.prepare(
    `INSERT INTO trace_buffer (run_id, step_id, line_seq, ts, nonce, entries, entry_count, bytes)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(RUN, line.step, line.seq, line.ts, line.nonce, entries, entries.length);
}

/** What a call rejected with, or `'resolved'`. */
async function refusal(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
    return 'resolved';
  } catch (err) {
    return err;
  }
}

/** A rejection's facts, for printing: a typed refusal's code and message, else its class and message. */
function facts(err: unknown): unknown {
  if (err instanceof WorkflowError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { class: err.constructor.name, message: err.message };
  return err;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('#616 B4 — the lock rule and the order of lines', () => {
  it('check 1: a settle reading while an agent append is in flight waits for its COMMIT and returns that line (NO_SILENT_LOSS)', async () => {
    const o = await open();
    const f = await foreign(o.home);
    f.exec('BEGIN IMMEDIATE');
    insertLine(f, { step: 'draft', seq: 0, ts: AT, nonce: null, event: 'in flight' });
    let settled = false;
    const reading = o.store.read(RUN, 'draft');
    void reading.then(
      () => (settled = true),
      () => (settled = true),
    );
    await sleep(200);
    const settledBeforeCommit = settled;
    f.exec('COMMIT');
    const got = await reading;
    // (1) red when `read` runs in `snapshot`: it resolves at once with nothing, and the settle would
    //     delete the line unread; (2) prints whether the read settled before the COMMIT and its events.
    expect({ settledBeforeCommit, events: got.map((e) => e.event) }).toEqual({
      settledBeforeCommit: false,
      events: ['in flight'],
    });
  });

  it("check 2: with the clock stepping back, each step's read is in append order across two interleaved steps", async () => {
    const o = await open({ clock: steppingClock('2026-11-07T09:00:00.000Z', -1000) });
    for (const [step, event] of [
      ['a', 'a1'],
      ['b', 'b1'],
      ['a', 'a2'],
      ['b', 'b2'],
      ['a', 'a3'],
    ] as const) {
      await o.store.append(RUN, step, [{ event }]);
    }
    const a = await o.store.read(RUN, 'a');
    const b = await o.store.read(RUN, 'b');
    // (1) red when a step's lines are ordered by `ts`: the later lines carry the earlier readings, so
    //     they come back reversed; (2) prints each step's events and whether the readings fell.
    expect({
      a: a.map((e) => e.event),
      b: b.map((e) => e.event),
      readingsFell: a[0]!._internalTs > a[2]!._internalTs,
    }).toEqual({ a: ['a1', 'a2', 'a3'], b: ['b1', 'b2'], readingsFell: true });
  });

  it('check 11: each line carries its write’s one reading of the clock (framework rule 10)', async () => {
    const clock = steppingClock('2026-11-07T09:00:00.000Z', 1000);
    const o = await open({ clock });
    const before = clock.reads;
    for (const event of ['one', 'two', 'three']) await o.store.append(RUN, 'draft', [{ event }]);
    const got = await o.store.read(RUN, 'draft');
    const base = Date.parse('2026-11-07T09:00:00.000Z');
    // (1) red when a write reads the clock a second time (its line carries the later reading, and
    //     the clock is read six times); (2) prints each line's `ts` and the number of readings.
    expect({ ts: got.map((e) => e._internalTs), readings: clock.reads - before }).toEqual({
      ts: [0, 1, 2].map((k) => base + (before + k) * 1000),
      readings: 3,
    });
  });
});

/** Entries whose one line, at the fixed clock's `ts`, measures exactly `bytes` (newline included). */
function lineOfSize(bytes: number): AgentTraceEntry[] {
  const size = (entries: AgentTraceEntry[]): number =>
    Buffer.byteLength(JSON.stringify({ ts: AT, entries }) + '\n');
  const full: AgentTraceEntry = {
    event: 'progress',
    data: Object.fromEntries(Array.from({ length: 20 }, (_, k) => [`k${k}`, 'x'.repeat(500)])),
  };
  const entries: AgentTraceEntry[] = [];
  while (size([...entries, full]) < bytes - 600) entries.push(full);
  for (;;) {
    const gap = bytes - size([...entries, { event: 'pad', data: { s: '' } }]);
    if (gap <= 499) {
      entries.push({ event: 'pad', data: { s: 'x'.repeat(gap) } });
      return entries;
    }
    entries.push({ event: 'pad', data: { s: 'x'.repeat(499) } });
  }
}

describe('#616 B4 — appends and the budgets', () => {
  it('check 3: a line exactly at the per-writer byte limit is accepted; one byte more is refused with BUFFER_FULL and nothing is written', async () => {
    const o = await open();
    const exact = lineOfSize(BUFFER_LIMIT_BYTES);
    const oneMore = lineOfSize(BUFFER_LIMIT_BYTES + 1);
    const accepted = await o.store.append(RUN, 'at-limit', exact);
    const over = await refusal(() => o.store.append(RUN, 'over-limit', oneMore));
    const details = over instanceof WorkflowError ? (over.details as Record<string, unknown>) : {};
    // (1) red when a line is measured without its trailing newline: the exact line counts one byte
    //     short and the longer one is accepted; (2) prints the accepted figure, the refusal's code,
    //     scope and figures, and how many entries the refused step holds.
    expect({
      acceptedBytes: accepted.buffer_bytes,
      refusal: (over as WorkflowError).code,
      scope: details['scope'],
      bytes: details['bytes'],
      written: (await o.store.read(RUN, 'over-limit')).length,
    }).toEqual({
      acceptedBytes: BUFFER_LIMIT_BYTES,
      refusal: 'BUFFER_FULL',
      scope: 'writer',
      bytes: { requested: BUFFER_LIMIT_BYTES + 1, used: 0, limit: BUFFER_LIMIT_BYTES },
      written: 0,
    });
  });

  it('check 4: an append whose entries all normalise away writes no row and returns the current figures', async () => {
    const o = await open();
    const f = await foreign(o.home);
    const first = await o.store.append(RUN, 'draft', [{ event: 'kept' }]);
    const none = await o.store.append(RUN, 'draft', [
      { event: 'trace.internal' },
      { event: '  trace.step' },
    ]);
    // (1) red when the empty line is inserted: a second row, and the figures grow by its bytes;
    //     (2) prints both results and the row count.
    expect({ result: none, rows: rows(f, 'trace_buffer') }).toEqual({ result: first, rows: 1 });
  });

  it('ported (core, JSON): an append past the per-writer ENTRY limit is refused with BUFFER_FULL, nothing written', async () => {
    const o = await open();
    await o.store.append(
      RUN,
      'draft',
      Array.from({ length: BUFFER_LIMIT_COUNT }, (_, i) => ({ event: `e${i}` })),
    );
    const over = await refusal(() => o.store.append(RUN, 'draft', [{ event: 'one more' }]));
    const details = over instanceof WorkflowError ? (over.details as Record<string, unknown>) : {};
    // (1) red when the count is taken in lines rather than entries (the step holds one line);
    //     (2) prints the refusal's code, its binding dimension and figures, and the entries kept.
    expect({
      refusal: (over as WorkflowError).code,
      binding: details['binding_dimension'],
      count: details['count'],
      kept: (await o.store.read(RUN, 'draft')).length,
    }).toEqual({
      refusal: 'BUFFER_FULL',
      binding: 'count',
      count: {
        requested: BUFFER_LIMIT_COUNT + 1,
        used: BUFFER_LIMIT_COUNT,
        limit: BUFFER_LIMIT_COUNT,
      },
      kept: BUFFER_LIMIT_COUNT,
    });
  });

  it("ported (JSON): the figures are this writer's share and the whole step's, and a lone bare writer's two are equal", async () => {
    const o = await open();
    const bare = await o.store.append(RUN, 'draft', [{ event: 'bare' }]);
    const nonced = await o.store.append(RUN, 'draft', [{ event: 'mine' }, { event: 'mine too' }], {
      writerNonce: 'attempt-2',
    });
    // (1) red when the writer's share is taken over every line of the step (the nonced writer would
    //     count the bare line too); (2) prints both results' writer and step figures.
    expect({
      bare: [bare.buffer_count, bare.buffer_bytes === bare.file_bytes, bare.file_count],
      nonced: [
        nonced.buffer_count,
        nonced.file_count,
        (nonced.file_bytes ?? 0) - nonced.buffer_bytes,
      ],
    }).toEqual({
      bare: [1, true, 1],
      nonced: [2, 3, bare.buffer_bytes],
    });
  });
});

describe('#616 B4 — the fenced methods', () => {
  it('check 5c: sealFenced whose fence refuses (the run came back) is refused with its own error, nothing sealed', async () => {
    const o = await open();
    const f = await foreign(o.home);
    putRun(f, run(RUN));
    await o.store.append(RUN, 'draft', [{ event: 'progress' }]);
    const err = await refusal(() => o.store.sealFenced(RUN, 'draft', { kind: 'run_absent' }));
    // (1) red when sealFenced skips its fence: it seals and deletes the lines; (2) prints the
    //     rejection and both row counts.
    expect({
      code: (err as WorkflowError).code,
      live: rows(f, 'trace_buffer'),
      sealed: rows(f, 'trace_sealed'),
    }).toEqual({ code: 'STATE_RUN_RESURRECTED', live: 1, sealed: 0 });
  });

  it('check 5d: deleteAllForRunFenced of a run that is live again is refused with its own error, nothing deleted', async () => {
    const o = await open();
    const f = await foreign(o.home);
    await o.store.append(RUN, 'classify', [{ event: 'sealed later' }]);
    await o.store.sealFenced(RUN, 'classify', { kind: 'run_absent' });
    await o.store.append(RUN, 'draft', [{ event: 'progress' }]);
    putRun(f, run(RUN));
    const err = await refusal(() =>
      o.store.deleteAllForRunFenced(RUN, { kind: 'run_absent_or_terminal' }),
    );
    // (1) red when deleteAllForRunFenced skips its fence: it deletes the live run's lines and seals;
    //     (2) prints the rejection and both row counts.
    expect({
      refusal: facts(err),
      live: rows(f, 'trace_buffer'),
      sealed: rows(f, 'trace_sealed'),
    }).toEqual({
      refusal: { code: 'STATE_RUN_BUSY', message: expect.stringContaining(RUN) },
      live: 1,
      sealed: 1,
    });
  });

  it("check 5e: an ended run's refusal names its phase as a word (PF-1)", async () => {
    const o = await open();
    const f = await foreign(o.home);
    const record = finished(RUN);
    putRun(f, record);
    const err = await refusal(() =>
      o.store.appendFenced(RUN, 'draft', [{ event: 'late' }], {
        kind: 'step_open_for_trace',
        run_version: 4,
      }),
    );
    const details = (err as WorkflowError).details as Record<string, unknown> | undefined;
    // (1) red when the fence is evaluated against the stored row rather than the reassembled run: the
    //     stored phase is a placeholder object; (2) prints the details' two phases.
    expect({
      step_state: details?.['step_state'],
      persisted_run_phase: details?.['persisted_run_phase'],
    }).toEqual({ step_state: 'run_terminal', persisted_run_phase: deriveRunPhase(record) });
  });

  it("check 5f: reclaim's version fence reaches the caller as ReclaimVersionChanged from deleteFenced, sealFenced and deleteAllForRunFenced", async () => {
    const o = await open();
    const f = await foreign(o.home);
    putRun(f, run(RUN));
    await o.store.append(RUN, 'draft', [{ event: 'progress' }]);
    const stale: RunScopedFencePredicate = { kind: 'run_at_version', version: 3 };
    const got = {
      deleteFenced: await refusal(() => o.store.deleteFenced(RUN, 'draft', stale)),
      sealFenced: await refusal(() => o.store.sealFenced(RUN, 'draft', stale)),
      deleteAllForRunFenced: await refusal(() => o.store.deleteAllForRunFenced(RUN, stale)),
    };
    // (1) red when a method wraps every error that is not a WorkflowError (reclaim and purge catch
    //     this one by class); (2) prints each method's rejection class and message, and the rows.
    expect({
      classes: Object.fromEntries(
        Object.entries(got).map(([k, v]) => [k, v instanceof ReclaimVersionChanged]),
      ),
      live: rows(f, 'trace_buffer'),
      sealed: rows(f, 'trace_sealed'),
    }).toEqual({
      classes: { deleteFenced: true, sealFenced: true, deleteAllForRunFenced: true },
      live: 1,
      sealed: 0,
    });
  });

  it('check 5g: a fenced delete of a step holding two lines of three entries each returns 6', async () => {
    const o = await open();
    const f = await foreign(o.home);
    putRun(f, run(RUN));
    const three = [{ event: 'a' }, { event: 'b' }, { event: 'c' }];
    await o.store.append(RUN, 'draft', three);
    await o.store.append(RUN, 'draft', three);
    const cleared = await o.store.deleteFenced(RUN, 'draft', {
      kind: 'run_at_version',
      version: 4,
    });
    // (1) red when the count is of rows (2), not entries: reclaim prints "cleared N buffered trace
    //     entries"; (2) prints the count and the rows left.
    expect({ cleared, rows: rows(f, 'trace_buffer') }).toEqual({ cleared: 6, rows: 0 });
  });

  it('check 6a: while another writer holds the lock, a malformed fence is refused with ENGINE_INTERNAL at once by each fenced method (PF-9)', async () => {
    const o = await open({ budgetMs: 1000 });
    const f = await foreign(o.home);
    f.exec('BEGIN IMMEDIATE');
    const malformed = { kind: 'run_at_version' } as unknown as RunScopedFencePredicate;
    const started = performance.now();
    const codes = {
      appendFenced: (
        (await refusal(() =>
          o.store.appendFenced(RUN, 'draft', [{ event: 'x' }], malformed),
        )) as WorkflowError
      ).code,
      deleteFenced: (
        (await refusal(() => o.store.deleteFenced(RUN, 'draft', malformed))) as WorkflowError
      ).code,
      sealFenced: (
        (await refusal(() => o.store.sealFenced(RUN, 'draft', malformed))) as WorkflowError
      ).code,
      deleteAllForRunFenced: (
        (await refusal(() => o.store.deleteAllForRunFenced(RUN, malformed))) as WorkflowError
      ).code,
    };
    const elapsed = performance.now() - started;
    f.exec('ROLLBACK');
    // (1) red when the predicate is checked inside the body: each call waits out the busy budget and
    //     is refused STATE_RUN_BUSY; (2) prints each method's code and the time taken.
    expect({ codes, withinOneBudget: elapsed < 1000 }).toEqual({
      codes: {
        appendFenced: 'ENGINE_INTERNAL',
        deleteFenced: 'ENGINE_INTERNAL',
        sealFenced: 'ENGINE_INTERNAL',
        deleteAllForRunFenced: 'ENGINE_INTERNAL',
      },
      withinOneBudget: true,
    });
  });

  it('check 6b: while another writer holds the lock, a valid fence is refused STATE_RUN_BUSY after the budget, unwrapped', async () => {
    const o = await open({ budgetMs: 300 });
    const f = await foreign(o.home);
    f.exec('BEGIN IMMEDIATE');
    const fence: RunScopedFencePredicate = { kind: 'run_absent' };
    const got = {
      appendFenced: await refusal(() =>
        o.store.appendFenced(RUN, 'draft', [{ event: 'x' }], fence),
      ),
      deleteFenced: await refusal(() => o.store.deleteFenced(RUN, 'draft', fence)),
      sealFenced: await refusal(() => o.store.sealFenced(RUN, 'draft', fence)),
      deleteAllForRunFenced: await refusal(() => o.store.deleteAllForRunFenced(RUN, fence)),
    };
    f.exec('ROLLBACK');
    // (1) red when the per-run delete wraps the busy refusal (purge files STATE_RUN_BUSY as blocked,
    //     anything else as failed); (2) prints each method's code.
    expect(
      Object.fromEntries(Object.entries(got).map(([k, v]) => [k, (v as WorkflowError).code])),
    ).toEqual({
      appendFenced: 'STATE_RUN_BUSY',
      deleteFenced: 'STATE_RUN_BUSY',
      sealFenced: 'STATE_RUN_BUSY',
      deleteAllForRunFenced: 'STATE_RUN_BUSY',
    });
  });

  it('check 7: a failed read of the run inside the transaction rejects deleteAllForRunFenced with that error, unwrapped, and nothing is deleted', async () => {
    const o = await open();
    const f = await foreign(o.home);
    await o.store.append(RUN, 'classify', [{ event: 'to seal' }]);
    await o.store.sealFenced(RUN, 'classify', { kind: 'run_absent' });
    await o.store.append(RUN, 'draft', [{ event: 'progress' }]);
    // Driver-seam fault: the run read's statement fails with SQLite's I/O error and does not run.
    faults(o).arm({
      at: (sql) => sql === 'SELECT record FROM runs WHERE id = ?',
      times: 1,
      first: 'nothing',
      error: SQLITE.ioError,
    });
    const err = await refusal(() => o.store.deleteAllForRunFenced(RUN, { kind: 'run_absent' }));
    // (1) red when a failed read is taken for an absent run (the run_absent fence passes and the rows
    //     go), and when the read failure is wrapped as ENGINE_ARTIFACT_DELETE_FAILED; (2) prints the
    //     rejection and both row counts.
    expect({
      refusal: facts(err),
      live: rows(f, 'trace_buffer'),
      sealed: rows(f, 'trace_sealed'),
    }).toEqual({
      refusal: { class: 'Error', message: 'disk I/O error (SQLite error 10)' },
      live: 1,
      sealed: 1,
    });
  });
});

describe('#616 B4 — sealing', () => {
  it('check 8a: sealing a step with no line answers absent and stores nothing', async () => {
    const o = await open();
    const f = await foreign(o.home);
    const result = await o.store.sealFenced(RUN, 'draft', { kind: 'run_absent' });
    // (1) red when an empty artifact is sealed; (2) prints the answer and the sealed rows.
    expect({ result, sealed: rows(f, 'trace_sealed') }).toEqual({
      result: { sealed: false, reason: 'absent' },
      sealed: 0,
    });
  });

  it('check 8b: a step already holding the per-step seal limit answers capped and keeps its lines', async () => {
    const o = await open();
    const f = await foreign(o.home);
    for (let i = 0; i < SEALED_ARTIFACTS_LIMIT_PER_STEP; i++) {
      await o.store.append(RUN, 'draft', [{ event: `round ${i}` }]);
      await o.store.sealFenced(RUN, 'draft', { kind: 'run_absent' });
    }
    await o.store.append(RUN, 'draft', [{ event: 'one too many' }]);
    const result = await o.store.sealFenced(RUN, 'draft', { kind: 'run_absent' });
    // (1) red when the limit is skipped: a ninth artifact is sealed and the line goes; (2) prints the
    //     answer, the seqs sealed and the live rows.
    expect({
      result,
      seqs: (await o.store.listSealedForRun(RUN)).map((a) => a.seq),
      live: rows(f, 'trace_buffer'),
    }).toEqual({
      result: { sealed: false, reason: 'capped' },
      seqs: [0, 1, 2, 3, 4, 5, 6, 7],
      live: 1,
    });
  });

  it('check 8c: sealing a step keeps its lines in order as one artifact and removes them from the buffer', async () => {
    const o = await open();
    const f = await foreign(o.home);
    await o.store.append(RUN, 'draft', [{ event: 'first' }]);
    await o.store.append(RUN, 'draft', [{ event: 'second' }], { writerNonce: 'attempt-1' });
    const result = await o.store.sealFenced(RUN, 'draft', { kind: 'run_absent' });
    // (1) red when the sealed lines are left live, or a sealed line loses its writer's nonce or its
    //     `ts` (the fenced contract's SEAL case checks the events only, and its byte-for-byte
    //     VERBATIM case is skipped on this store; #616 PR-1b B5); (2) prints the answer, the
    //     artifact and the rows.
    expect({
      result,
      artifacts: await o.store.listSealedForRun(RUN),
      live: rows(f, 'trace_buffer'),
    }).toEqual({
      result: { sealed: true },
      artifacts: [
        {
          step_id: 'draft',
          seq: 0,
          lines: [
            { ts: AT, entries: [{ event: 'first' }] },
            { ts: AT, entries: [{ event: 'second' }], nonce: 'attempt-1' },
          ],
        },
      ],
      live: 0,
    });
  });
});

describe('#616 B4 — a COMMIT that reports an error (the outcome protocol, through each write’s verify)', () => {
  it("check 9: an append whose COMMIT did not land, while another writer's line took its number before the read-back, answers not landed (review R5)", async () => {
    const o = await open();
    const f = await foreign(o.home);
    // Driver-seam fault: the COMMIT rolls the transaction back (as SQLite does after an I/O error), a
    // second writer then commits its own line at the same number, and the COMMIT throws the I/O error.
    faults(o).arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'rollback',
      also: () => {
        f.exec('BEGIN IMMEDIATE');
        insertLine(f, { step: 'draft', seq: 0, ts: AT + 5, nonce: 'other', event: 'theirs' });
        f.exec('COMMIT');
      },
      error: SQLITE.ioError,
    });
    const err = await refusal(() => o.store.append(RUN, 'draft', [{ event: 'mine' }]));
    // (1) red when the verify reads the line's number only: it finds a row there and answers landed;
    //     (2) prints the answer and the step's events.
    expect({
      outcome: (err as { commitOutcome?: { outcome: string } }).commitOutcome?.outcome,
      events: (await o.store.read(RUN, 'draft')).map((e) => e.event),
    }).toEqual({ outcome: 'not_landed', events: ['theirs'] });
  });

  /** One write, its setup, and what the file holds after it landed. */
  interface LandedWrite {
    readonly name: string;
    readonly setup: (o: Opened, f: DatabaseLike) => Promise<void>;
    readonly call: (s: SqliteTraceBufferStore) => Promise<unknown>;
    readonly result: unknown;
    readonly after: { live: number; sealed: number };
  }
  const withLineAndSeal = async (o: Opened, f: DatabaseLike): Promise<void> => {
    putRun(f, finished(RUN));
    await o.store.append(RUN, 'classify', [{ event: 'to seal' }]);
    await o.store.sealFenced(RUN, 'classify', { kind: 'run_at_version', version: 4 });
    await o.store.append(RUN, 'draft', [{ event: 'progress' }]);
  };
  const fence: RunScopedFencePredicate = { kind: 'run_at_version', version: 4 };
  const LANDED: readonly LandedWrite[] = [
    {
      name: 'append',
      setup: async () => undefined,
      call: (s) => s.append(RUN, 'draft', [{ event: 'x' }]).then((r) => r.buffer_count),
      result: 1,
      after: { live: 1, sealed: 0 },
    },
    {
      name: 'appendFenced',
      setup: async (_o, f) => putRun(f, run(RUN)),
      call: (s) =>
        s.appendFenced(RUN, 'draft', [{ event: 'x' }], fence).then((r) => r.buffer_count),
      result: 1,
      after: { live: 1, sealed: 0 },
    },
    {
      name: 'sealFenced',
      setup: withLineAndSeal,
      call: (s) => s.sealFenced(RUN, 'draft', fence),
      result: { sealed: true },
      after: { live: 0, sealed: 2 },
    },
    {
      name: 'delete',
      setup: withLineAndSeal,
      call: (s) => s.delete(RUN, 'draft'),
      result: undefined,
      after: { live: 0, sealed: 1 },
    },
    {
      name: 'deleteFenced',
      setup: withLineAndSeal,
      call: (s) => s.deleteFenced(RUN, 'draft', fence),
      result: 1,
      after: { live: 0, sealed: 1 },
    },
    {
      name: 'deleteAllForRun',
      setup: withLineAndSeal,
      call: (s) => s.deleteAllForRun(RUN).then((r) => r.bytes_deleted > 0),
      result: true,
      after: { live: 0, sealed: 0 },
    },
    {
      name: 'deleteAllForRunFenced',
      setup: withLineAndSeal,
      call: (s) => s.deleteAllForRunFenced(RUN, fence).then((r) => r.bytes_deleted > 0),
      result: true,
      after: { live: 0, sealed: 0 },
    },
  ];
  for (const write of LANDED) {
    it(`check 10: ${write.name} that landed and then reported an error at COMMIT answers landed (review R4)`, async () => {
      const o = await open();
      const f = await foreign(o.home);
      await write.setup(o, f);
      // Driver-seam fault: the COMMIT runs (the data reached the file), then throws the I/O error.
      faults(o).arm({
        at: (sql) => sql === 'COMMIT',
        times: 1,
        first: 'run',
        error: SQLITE.ioError,
      });
      let outcome: unknown;
      try {
        outcome = { resolved: await write.call(o.store) };
      } catch (err) {
        outcome = { rejected: facts(err) };
      }
      // (1) red when this write's verify answers false: the protocol answers not landed and the call
      //     rejects; (2) prints the call's answer and the rows the file holds.
      expect({
        outcome,
        live: rows(f, 'trace_buffer'),
        sealed: rows(f, 'trace_sealed'),
      }).toEqual({ outcome: { resolved: write.result }, ...write.after });
    });
  }
});

describe('#616 B4 — a per-run delete that fails', () => {
  it('check 12b: an operator reads which store failed to delete which artifact, and SQLite’s code', async () => {
    const o = await open();
    await o.store.append(RUN, 'draft', [{ event: 'progress' }]);
    // Driver-seam fault, as in the artifact contract's injection: the delete fails with SQLite's I/O
    // error and does not run.
    faults(o).arm({
      at: (sql) => sql.startsWith('DELETE FROM trace_buffer WHERE run_id = ?'),
      times: 1,
      first: 'nothing',
      error: SQLITE.ioError,
    });
    const err = (await refusal(() => o.store.deleteAllForRun(RUN))) as WorkflowError;
    // (1) red when the failure names the JSON class, or the bare mapped code instead of SQLite's
    //     primary-code name; (2) prints the message and the details.
    expect({ code: err.code, message: err.message, details: err.details }).toEqual({
      code: 'ENGINE_ARTIFACT_DELETE_FAILED',
      message: `SqliteTraceBufferStore failed to delete artifact(s) for run '${RUN}': trace_buffer (SQLITE_IOERR)`,
      details: {
        runId: RUN,
        store: 'SqliteTraceBufferStore',
        deleted: [],
        failures: [
          {
            artifact: 'trace_buffer',
            code: 'SQLITE_IOERR',
            message: 'disk I/O error (SQLite error 10)',
          },
        ],
      },
    });
  });

  it('a per-run delete whose read of the rows to delete fails is a delete failure, and nothing is deleted (MA 4, 2026-11-07)', async () => {
    const o = await open();
    const f = await foreign(o.home);
    await o.store.append(RUN, 'classify', [{ event: 'to seal' }]);
    await o.store.sealFenced(RUN, 'classify', { kind: 'run_absent' });
    await o.store.append(RUN, 'draft', [{ event: 'progress' }]);
    // Driver-seam fault: the read of the run's lines (an unreadable page is met there first) fails with
    // SQLite's I/O error and does not run.
    faults(o).arm({
      at: (sql) =>
        sql.startsWith('SELECT step_id, line_seq') && sql.includes('WHERE run_id = ? ORDER BY'),
      times: 1,
      first: 'nothing',
      error: SQLITE.ioError,
    });
    const err = (await refusal(() => o.store.deleteAllForRun(RUN))) as WorkflowError;
    // (1) red when the reads sit outside the delete's own statements: a plain error reaches purge, not
    //     the contract's typed rejection; (2) prints the rejection's code and failures, and the rows.
    expect({
      code: err.code,
      failures: (err.details as { failures?: unknown } | undefined)?.failures,
      live: rows(f, 'trace_buffer'),
      sealed: rows(f, 'trace_sealed'),
    }).toEqual({
      code: 'ENGINE_ARTIFACT_DELETE_FAILED',
      failures: [
        {
          artifact: 'trace_buffer',
          code: 'SQLITE_IOERR',
          message: 'disk I/O error (SQLite error 10)',
        },
      ],
      live: 1,
      sealed: 1,
    });
  });

  it('a per-run delete whose COMMIT did not land is a delete failure, with the COMMIT’s typed code', async () => {
    const o = await open();
    const f = await foreign(o.home);
    await o.store.append(RUN, 'draft', [{ event: 'progress' }]);
    // Driver-seam fault: the COMMIT does not run (the transaction stays open, so the protocol answers
    // not landed at once) and throws SQLite's full-disk error.
    faults(o).arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'nothing',
      error: SQLITE.full,
    });
    const err = (await refusal(() => o.store.deleteAllForRun(RUN))) as WorkflowError;
    const failures = (err.details as { failures?: Array<{ code: string }> } | undefined)?.failures;
    // (1) red when every COMMIT failure passes through unwrapped (purge would read a full disk as no
    //     store failure of its artifacts); (2) prints the code, the failure's code and the rows.
    expect({ code: err.code, failure: failures?.[0]?.code, live: rows(f, 'trace_buffer') }).toEqual(
      {
        code: 'ENGINE_ARTIFACT_DELETE_FAILED',
        failure: 'STATE_STORE_FULL',
        live: 1,
      },
    );
  });

  it("a per-run delete whose COMMIT outcome is unknown passes the primitive's fence through, with its answer (MA 4, 2026-11-07)", async () => {
    const o = await open();
    await o.store.append(RUN, 'draft', [{ event: 'progress' }]);
    // Driver-seam faults: the COMMIT rolls back and throws the I/O error, and the read-back that would
    // answer it then fails too, so the outcome cannot be told.
    faults(o).arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'rollback',
      error: SQLITE.ioError,
    });
    faults(o).arm({
      at: (sql) => sql === 'BEGIN',
      times: 1,
      first: 'nothing',
      error: SQLITE.ioError,
    });
    const err = (await refusal(() => o.store.deleteAllForRun(RUN))) as WorkflowError & {
      commitOutcome?: { outcome: string };
    };
    // (1) red when every COMMIT failure is wrapped as a delete failure (it may have landed, and the
    //     fence on later writes would be hidden); (2) prints the code and the answer.
    expect({ code: err.code, outcome: err.commitOutcome?.outcome }).toEqual({
      code: 'STATE_STORE_WRITES_FENCED',
      outcome: 'unknown',
    });
  });

  it("ported (core, JSON): deleteAllForRun removes the run's lines and sealed artifacts across steps and leaves another run's", async () => {
    const o = await open();
    const f = await foreign(o.home);
    for (const runId of [RUN, OTHER_RUN]) {
      await o.store.append(runId, 'classify', [{ event: 'to seal' }]);
      await o.store.sealFenced(runId, 'classify', { kind: 'run_absent' });
      await o.store.append(runId, 'draft', [{ event: 'progress' }]);
      await o.store.append(runId, 'review', [{ event: 'progress' }]);
    }
    await o.store.deleteAllForRun(RUN);
    // (1) red when the sealed artifacts are left, or another run's rows go too; (2) prints each run's
    //     row counts.
    expect({
      run: [rows(f, 'trace_buffer', RUN), rows(f, 'trace_sealed', RUN)],
      other: [rows(f, 'trace_buffer', OTHER_RUN), rows(f, 'trace_sealed', OTHER_RUN)],
    }).toEqual({ run: [0, 0], other: [2, 1] });
  });
});

describe('#616 B4 — what export reads', () => {
  it("check 13a: readAllForRun returns each step's line objects with a live writer's nonce at line level", async () => {
    const o = await open();
    await o.store.append(RUN, 'draft', [{ event: 'live writer' }], { writerNonce: 'attempt-2' });
    await o.store.append(RUN, 'draft', [{ event: 'plain' }]);
    // (1) red when the nonce is folded into the entries (export's redaction keys on the line's
    //     `nonce`); (2) prints the result.
    expect(await o.store.readAllForRun(RUN)).toEqual({
      draft: [
        { ts: AT, entries: [{ event: 'live writer' }], nonce: 'attempt-2' },
        { ts: AT, entries: [{ event: 'plain' }] },
      ],
    });
  });

  it('check 13b: a line written without a nonce has no nonce key in readAllForRun or in a sealed line', async () => {
    const o = await open();
    await o.store.append(RUN, 'draft', [{ event: 'plain' }]);
    const live = (await o.store.readAllForRun(RUN))['draft']?.[0] as object;
    await o.store.sealFenced(RUN, 'draft', { kind: 'run_absent' });
    const sealed = (await o.store.listSealedForRun(RUN))[0]?.lines[0] as object;
    // (1) red when a NULL column becomes `nonce: null`, which export reads as a live writer's nonce;
    //     (2) prints both lines' keys.
    expect({ live: Object.keys(live), sealed: Object.keys(sealed) }).toEqual({
      live: ['ts', 'entries'],
      sealed: ['ts', 'entries'],
    });
  });

  it('ported (core, JSON): readAllForRun keys every step of the run and leaves other runs out; a run with none is {}', async () => {
    const o = await open();
    await o.store.append(RUN, 'classify', [{ event: 'one' }]);
    await o.store.append(RUN, 'draft', [{ event: 'two' }]);
    await o.store.append(OTHER_RUN, 'review', [{ event: 'elsewhere' }]);
    const all = await o.store.readAllForRun(RUN);
    // (1) red when the read is not scoped to the run, or drops a step; (2) prints the step keys and
    //     the empty run's answer.
    expect({
      steps: Object.keys(all).sort(),
      none: await o.store.readAllForRun('2d6a9e3c-5b7f-4e4a-9cad-9f8e7a6b5c43'),
    }).toEqual({ steps: ['classify', 'draft'], none: {} });
  });
});

describe('#616 B4 — the store as the engine and a home see it', () => {
  it('ported (JSON): declares the seal and nonce-carriage rungs, and both predicates hold', async () => {
    const o = await open();
    // (1) red when a rung is declared without a method it needs (the engine checks the rung with
    //     these predicates before it seals); (2) prints the three answers.
    expect({
      seal: storeDeclaresSeal(o.store),
      carriage: storeDeclaresNonceCarriage(o.store),
      valid: (() => {
        try {
          validateTraceCapabilities(o.store);
          return true;
        } catch (err) {
          return facts(err);
        }
      })(),
    }).toEqual({ seal: true, carriage: true, valid: true });
  });

  it("check 14: the home's trace buffer is on the home's one connection: after close() its calls reject", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-616-b4-home-'));
    dirs.push(dir);
    const home = await openRealmHome({ home: join(dir, '.realm'), clock: fixed });
    await home.traceBufferStore.append(RUN, 'draft', [{ event: 'before close' }]);
    home.close();
    const err = await refusal(() => home.traceBufferStore.read(RUN, 'draft'));
    // (1) red when the store is built on a connection of its own: the read still resolves after the
    //     home is closed; (2) prints the read's answer.
    expect(facts(err)).toEqual({ class: 'Error', message: 'database is not open' });
  });
});
