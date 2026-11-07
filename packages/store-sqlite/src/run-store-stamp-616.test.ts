// run-store-stamp-616.test.ts — issue #616 PR-1a unit 13b: `SqliteRunStore.stampSeal`, the write
// `realm run migrate --stamp-seals` makes onto a run that finished before runs carried a seal (#367),
// on real homes in a temp directory, through `openRealmHome`. The real cases: the migration stamping
// an old finished run, whose activity clock must not move and whose derived phase may; a writer that
// read the run before the stamp and writes after it; the migration run twice, or racing itself in
// several processes; a run that changed, or is not finished, or already holds a seal; a stamp that
// contradicts the run's own record; and a COMMIT that fails after or before the stamp reached the file.
//
// The seed is an old finished run with no seal, which the store's own `update` refuses to write
// (`STATE_SEAL_UNSTAMPED`): a foreign connection writes it with `insertRunRecord` inside its own
// `BEGIN IMMEDIATE`, as a JSON store migrated before #367 would hold it.
//
// Since unit 16 the stamp laws of core's shared settlement contract also run against this store
// (`contract-settlement-616.test.ts`: `STAMP_PRESERVES_UPDATED_AT`, `STAMP_BUMPS_VERSION_ONCE`,
// `STAMP_CLASSIFIED_ROUNDTRIP`, `STAMP_RETURNS_NOT_THROWS_PREDICATES`,
// `STAMP_REFUSES_ON_VERSION_MOVE` and `STAMP_IDEMPOTENT`, with the seed hook `seedLegacyTerminal`
// written the way this file's seed is; `contract-clock-616.test.ts`: the stamp clause of
// `READS_ONE_READING`). Those laws judge what a stamp STORES; they do not compare the run a stamp
// returns with the stored one (issue #897). These cells stay for what no shared law sees: the rows
// and text a write leaves, the exact refusals and their words, and the COMMIT protocol.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  deriveRunPhase,
  runPhaseDerivationFingerprint,
  WorkflowError,
  type Clock,
  type EvidenceSnapshot,
  type RunRecord,
  type SealedBy,
  type StampSealResult,
  type WorkflowContextSnapshot,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import type { WithCommitOutcome } from './connection.js';
import { openDatabase, type DatabaseLike } from './driver.js';
import { openRealmHome } from './index.js';
import type { OpenSeams } from './open-file.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { insertRunRecord } from './run-rows.js';
import { faultyFiles, SQLITE, type FaultyConnection } from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The instant the cells' clocks are set to: later than every stamp the seed carries. */
const T = '2030-05-06T07:08:09.000Z';

/** The seed's own stamps: an old run, finished long before the migration. */
const CREATED = '2026-01-02T03:04:05.000Z';
const UPDATED = '2026-01-02T03:09:59.123Z';

/** The stamp the migration writes onto a run that completed. */
const COMPLETE: SealedBy = { arm: 'complete', classified: true };

const dirs: string[] = [];
const handles: RealmHome[] = [];
const connections: DatabaseLike[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u13b-'));
  dirs.push(dir);
  return dir;
}

/** A test clock: it answers the instant it is set to and counts its readings. */
function testClock(start: string): { clock: Clock; reads(): number } {
  const now = Date.parse(start);
  let reads = 0;
  return {
    clock: {
      now: () => {
        reads += 1;
        return new Date(now);
      },
      at: () => () => undefined,
    },
    reads: () => reads,
  };
}

/** An open home: its folder and its run store. */
interface Opened {
  readonly home: string;
  readonly runStore: RealmHome['runStore'];
}

/** Opens a home on `clock` (the system clock when left out; the open's seams when given). */
async function open(clock?: Clock, seams?: OpenSeams): Promise<Opened> {
  const home = join(tmp(), '.realm');
  const options = clock === undefined ? { home } : { home, clock };
  const handle = await (seams === undefined ? openRealmHome(options) : openHome(options, seams));
  handles.push(handle);
  return { home, runStore: handle.runStore };
}

/** Another connection on the home's file (the seeding writer, or a second reader). */
async function foreign(home: string): Promise<DatabaseLike> {
  const c = await openForeignConnection(home);
  connections.push(c);
  return c;
}

/** A refusal as a reader sees it: a typed refusal's code, or a plain error's name and message. */
function describeError(err: unknown): string {
  return err instanceof WorkflowError
    ? err.code
    : `${(err as Error).name}: ${(err as Error).message}`;
}

/** A typed refusal's code, sentence and details (what a host prints), or a plain error's text. */
function refusal(err: unknown): unknown {
  return err instanceof WorkflowError
    ? { code: err.code, message: err.message, details: err.details }
    : describeError(err);
}

/** What a stamp answered: `stamped`, a refusal's reason, or a thrown refusal's code. */
const answer = (call: Promise<StampSealResult>): Promise<string> =>
  call.then((r) => (r.stamped ? 'stamped' : r.reason), describeError);

/** One evidence entry of step `a`, as the engine writes it. */
function entry(i: number): EvidenceSnapshot {
  return {
    step_id: 'a',
    started_at: '2026-01-02T03:05:00.000Z',
    completed_at: '2026-01-02T03:05:01.000Z',
    duration_ms: 1000,
    input_summary: { i },
    output_summary: { answer: `answer ${i}` },
    status: 'success',
    evidence_hash: `${i}`.padStart(64, '0'),
  };
}

/** The workflow's context files as the engine snapshots them at the run's first step. */
const CONTEXT: Record<string, WorkflowContextSnapshot> = {
  'guide.md': {
    source_path: '/work/guide.md',
    content: '# Guide',
    content_hash: 'cd'.repeat(32),
    loaded_at: '2026-01-02T03:04:06.000Z',
  },
};

/**
 * An old finished run with no seal, as a store written before #367 holds it: its evidence and its
 * write-once field sit in the middle of its keys (so the store's split is what reads it back), and
 * its phase is the derived one. `over` changes or adds keys; a key set to `undefined` is left out.
 */
function legacy(id: string, over: Record<string, unknown> = {}): RunRecord {
  const record = {
    id,
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: ['a'],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 3,
    params: { ticket: 7 },
    evidence: [entry(0), entry(1)],
    workflow_context_snapshots: CONTEXT,
    created_at: CREATED,
    updated_at: UPDATED,
    terminal_state: true,
    terminal_reason: 'Workflow completed.',
    ...over,
  } as Record<string, unknown>;
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  const run = record as unknown as RunRecord;
  return { ...run, run_phase: deriveRunPhase(run) };
}

/** Writes `record` on the foreign connection `c`, in its own write transaction. */
function seed(c: DatabaseLike, record: RunRecord): void {
  c.exec('BEGIN IMMEDIATE');
  try {
    insertRunRecord(c, record);
    c.exec('COMMIT');
  } catch (err) {
    c.exec('ROLLBACK');
    throw err;
  }
}

/** What a second connection sees of a run: its row's columns and text, its evidence and its fields. */
function stored(c: DatabaseLike, id: string): Record<string, unknown> {
  const row = c
    .prepare(
      'SELECT record, version, run_phase, phase_version, updated_at, sealed_by_arm FROM runs WHERE id = ?',
    )
    .get(id);
  return {
    record: row?.['record'],
    version: row?.['version'],
    run_phase: row?.['run_phase'],
    phase_version: row?.['phase_version'],
    updated_at: row?.['updated_at'],
    sealed_by_arm: row?.['sealed_by_arm'],
    evidence: c
      .prepare('SELECT seq, entry, entry_sha256 FROM evidence WHERE run_id = ? ORDER BY seq')
      .all(id)
      .map((r) => [Number(r['seq']), String(r['entry']), String(r['entry_sha256'])]),
    fields: c
      .prepare('SELECT name, value FROM run_blobs WHERE run_id = ? ORDER BY name')
      .all(id)
      .map((r) => [String(r['name']), String(r['value'])]),
  };
}

describe('#616 unit 13b — the stamp', () => {
  it('check 1: a stamp writes the seal last in the run, moves the version by one, keeps updated_at byte for byte and the evidence and write-once rows as they were, and re-stamps the phase columns', async () => {
    const { home, runStore } = await open(testClock(T).clock);
    const c = await foreign(home);
    seed(c, legacy('run-1'));
    const before = stored(c, 'run-1');
    const result = await runStore.stampSeal('run-1', COMPLETE, 3);
    const after = stored(c, 'run-1');
    const read = (await runStore.get('run-1')).record;
    expect({
      stamped: result.stamped,
      equalsGet: JSON.stringify(result.run) === JSON.stringify(read),
      lastKey: Object.keys(read).at(-1),
      sealedBy: read.sealed_by,
      version: read.version,
      updatedAt: read.updated_at,
      rows: [after['evidence'], after['fields']],
      columns: [
        after['version'],
        after['updated_at'],
        after['phase_version'],
        after['sealed_by_arm'],
      ],
    }).toEqual({
      // (1) red when the stamp's write is not the stored document patched (a document written with its
      //     evidence or its write-once value inline does not read back: the read refuses it) or the
      //     returned run is not what was written; (2) prints whether the two are equal.
      stamped: true,
      equalsGet: true,
      // (1) red when `sealed_by` is not appended last, as the JSON store's `{ ...fresh, sealed_by }`
      //     does (STAMP_CLASSIFIED_ROUNDTRIP); (2) prints the last key and the stamp read back.
      lastKey: 'sealed_by',
      sealedBy: COMPLETE,
      // (1) red when the version is not moved by one (the file's version fence then refuses the
      //     stamp's own UPDATE) or `updated_at` is stamped from a reading (stamping is not activity:
      //     retention's clock would move); (2) prints the version and `updated_at` read back.
      version: 4,
      updatedAt: UPDATED,
      // (1) red when the stamp writes or rewrites an evidence row or the write-once row; (2) prints
      //     the rows a second connection sees after the stamp.
      rows: [before['evidence'], before['fields']],
      // (1) red when the columns a second connection reads do not follow the document (the version
      //     and `updated_at` columns are generated from it) or the phase fingerprint is not core's;
      //     (2) prints the version, `updated_at`, fingerprint and seal-arm columns.
      columns: [4, UPDATED, runPhaseDerivationFingerprint(), 'complete'],
    });
  });

  it('check 1: a stamp whose derived phase moves (a finished run with no reason and no markers reads abandoned, stamped complete reads completed) re-stamps the phase column', async () => {
    const { home, runStore } = await open(testClock(T).clock);
    const c = await foreign(home);
    seed(c, legacy('run-1', { terminal_reason: undefined }));
    const columnBefore = stored(c, 'run-1')['run_phase'];
    const result = await runStore.stampSeal('run-1', COMPLETE, 3);
    // (1) red when the writer does not re-stamp the phase column from the stamped document (the column
    //     keeps `abandoned`), or the returned run's phase is not the derived one; (2) prints the
    //     column before, the column after and the returned phase.
    expect([columnBefore, stored(c, 'run-1')['run_phase'], result.run.run_phase]).toEqual([
      'abandoned',
      'completed',
      'completed',
    ]);
  });

  it('check 1: a writer holding the run read before the stamp can no longer update it: its write is refused with the version conflict, and the stamp stays', async () => {
    const { home, runStore } = await open(testClock(T).clock);
    seed(await foreign(home), legacy('run-1'));
    const readBefore = (await runStore.get('run-1')).record;
    await runStore.stampSeal('run-1', COMPLETE, 3);
    const stale = await runStore.update(readBefore).then(() => 'updated', refusal);
    // (1) red when the stamp keeps the version (the stale writer then passes its version check and
    //     wipes the stamp: the reason the stamp bumps it); (2) prints the stale update's refusal and
    //     the stamp read back.
    expect({ stale, sealedBy: (await runStore.get('run-1')).record.sealed_by }).toEqual({
      stale: {
        code: 'STATE_SNAPSHOT_MISMATCH',
        message: 'Version conflict — run was modified by another process',
        details: { runId: 'run-1', expected: 3, actual: 4 },
      },
      sealedBy: COMPLETE,
    });
  });
});

describe('#616 unit 13b — no reading', () => {
  it('check 2: a stamp reads no clock on any branch: stamped, already stamped, not finished, a version move, a missing run, a stamp the boundary refuses', async () => {
    const t = testClock(T);
    const { home, runStore } = await open(t.clock);
    const c = await foreign(home);
    seed(c, legacy('run-1'));
    seed(c, legacy('run-2'));
    const { record: live } = await runStore.create({
      workflowId: 'wf',
      workflowVersion: 1,
      params: {},
    });
    const spent = async (call: () => Promise<StampSealResult>): Promise<[number, string]> => {
      const before = t.reads();
      const result = await answer(call());
      return [t.reads() - before, result];
    };
    // (1) red when the stamp takes a reading anywhere (the write's own, or one of its body's), on any
    //     branch; (2) prints each call's readings and answer.
    expect({
      stamped: await spent(() => runStore.stampSeal('run-1', COMPLETE, 3)),
      alreadyStamped: await spent(() => runStore.stampSeal('run-1', COMPLETE, 4)),
      notTerminal: await spent(() => runStore.stampSeal(live.id, COMPLETE, 0)),
      versionMoved: await spent(() => runStore.stampSeal('run-2', COMPLETE, 2)),
      missing: await spent(() => runStore.stampSeal('no-such-run', COMPLETE, 0)),
      boundary: await spent(() =>
        runStore.stampSeal('run-2', { arm: 'step_failure', classified: true }, 3),
      ),
    }).toEqual({
      stamped: [0, 'stamped'],
      alreadyStamped: [0, 'already_stamped'],
      notTerminal: [0, 'not_terminal'],
      versionMoved: [0, 'STATE_SNAPSHOT_MISMATCH'],
      missing: [0, 'STATE_RUN_NOT_FOUND'],
      boundary: [0, 'STATE_SEAL_INCOHERENT'],
    });
  });
});

describe('#616 unit 13b — the four checks and their order', () => {
  it('check 3: a version move is thrown with core’s words, also on a run already stamped; a stamped run and a live run that holds a seal answer already_stamped; a live run with none answers not_terminal; none of them writes, and each refusal carries the run as it stands', async () => {
    const { home, runStore } = await open(testClock(T).clock);
    const c = await foreign(home);
    seed(c, legacy('stamped'));
    await runStore.stampSeal('stamped', COMPLETE, 3);
    // A live run that holds a seal: the store's own update refuses to write one (STATE_SEAL_ORPHANED).
    seed(
      c,
      legacy('live-sealed', {
        terminal_state: false,
        terminal_reason: undefined,
        sealed_by: { arm: 'complete' },
      }),
    );
    const { record: live } = await runStore.create({
      workflowId: 'wf',
      workflowVersion: 1,
      params: {},
    });
    const ids = ['stamped', 'live-sealed', live.id];
    const rowsBefore = ids.map((id) => stored(c, id));
    const asItStands = async (call: Promise<StampSealResult>): Promise<unknown> => {
      const result = await call;
      return [
        result.stamped ? 'stamped' : result.reason,
        JSON.stringify(result.run) === JSON.stringify((await runStore.get(result.run.id)).record),
      ];
    };
    const outcomes = {
      movedOnStamped: await runStore
        .stampSeal('stamped', COMPLETE, 3)
        .then(() => 'answered', refusal),
      alreadyStamped: await asItStands(runStore.stampSeal('stamped', COMPLETE, 4)),
      liveSealed: await asItStands(runStore.stampSeal('live-sealed', COMPLETE, 3)),
      notTerminal: await asItStands(runStore.stampSeal(live.id, COMPLETE, 0)),
    };
    expect({ ...outcomes, rowsUnchanged: ids.map((id) => stored(c, id)) }).toEqual({
      // (1) red when the version check comes after the seal check (the stamped run then answers
      //     already_stamped at a stale version), or the store leaves it to the file's version guard
      //     (the same code, but no details); (2) prints the refusal.
      movedOnStamped: {
        code: 'STATE_SNAPSHOT_MISMATCH',
        message: 'Version conflict — run was modified by another process',
        details: { runId: 'stamped', expected: 3, actual: 4 },
      },
      // (1) red when the not-finished check comes before the seal check (the live run that holds a
      //     seal then answers not_terminal), or a refusal is thrown instead of returned, or its run is
      //     not the record as it stands; (2) prints each answer and whether its run equals get().
      alreadyStamped: ['already_stamped', true],
      liveSealed: ['already_stamped', true],
      notTerminal: ['not_terminal', true],
      // (1) red when a refusal writes anything; (2) prints what a second connection sees.
      rowsUnchanged: rowsBefore,
    });
  });
});

describe('#616 unit 13b — the seal boundary', () => {
  it('check 4: a stamp that contradicts the run’s own record (a completed run stamped step_failure) is refused with core’s seal refusal, and nothing is written', async () => {
    const { home, runStore } = await open(testClock(T).clock);
    const c = await foreign(home);
    seed(c, legacy('run-1'));
    const before = stored(c, 'run-1');
    const result = await runStore
      .stampSeal('run-1', { arm: 'step_failure', classified: true }, 3)
      .then(() => 'stamped', refusal);
    // (1) red when the stamp skips core's seal boundary (the contradicting arm is then written);
    //     (2) prints the refusal (its details are core's) and what a second connection sees.
    expect({ result, rows: stored(c, 'run-1') }).toEqual({
      result: {
        code: 'STATE_SEAL_INCOHERENT',
        message:
          "Run 'run-1' seal arm 'step_failure' (phase 'failed') disagrees with the record's own markers/prose (classify: 'complete', phase 'completed') — stale or mis-stamped arm",
        details: { runId: 'run-1', arm: 'step_failure', classified_arm: 'complete' },
      },
      rows: before,
    });
  });
});

describe('#616 unit 13b — the COMMIT outcome of a stamp', () => {
  /** A home whose store connection can fail its next COMMIT, and the seeded run. */
  async function armed(
    first: 'run' | 'rollback',
    alsoBump = false,
  ): Promise<{ runStore: Opened['runStore']; c: DatabaseLike; connection: FaultyConnection }> {
    const files = faultyFiles(openDatabase);
    const { home, runStore } = await open(testClock(T).clock, { openFile: files.openFile });
    const c = await foreign(home);
    seed(c, legacy('run-1'));
    const connection = files.opened.at(-1)!;
    connection.arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first,
      // Another writer moves the run on before the store can read its write back.
      ...(alsoBump
        ? {
            also: () => {
              c.prepare(
                "UPDATE runs SET record = json_set(record, '$.version', json_extract(record, '$.version') + 1) WHERE id = ?",
              ).run('run-1');
            },
          }
        : {}),
      error: SQLITE.ioError,
    });
    return { runStore, c, connection };
  }

  it('check 5: a COMMIT that reports an error after the stamp reached the file answers landed: the stamp resolves and reads back', async () => {
    const { runStore, connection } = await armed('run');
    const result = await runStore.stampSeal('run-1', COMPLETE, 3);
    const read = (await runStore.get('run-1')).record;
    // (1) red when the stamp's check does not find the stored text it wrote (the protocol then
    //     answers not_landed and the stamp rejects); (2) prints whether it read back equal, and the
    //     fault's firings.
    expect([
      result.stamped,
      JSON.stringify(result.run) === JSON.stringify(read),
      connection.hits(),
    ]).toEqual([true, true, 1]);
  });

  it('check 5: a COMMIT that reports an error after SQLite rolled it back answers not_landed: the stamp rejects and the run is as it was', async () => {
    const { runStore, c, connection } = await armed('rollback');
    const before = stored(c, 'run-1');
    const result = await runStore.stampSeal('run-1', COMPLETE, 3).then(
      () => 'stamped',
      (err: WithCommitOutcome) => [err.message, err.commitOutcome],
    );
    // (1) red when the stamp's check answers that the stamp is there without finding it (the protocol
    //     then answers landed and the stamp resolves); (2) prints the outcome, whether the rows are
    //     as they were, and the fault's firings.
    expect([result, stored(c, 'run-1'), connection.hits()]).toEqual([
      ['disk I/O error (SQLite error 10)', { outcome: 'not_landed', errcode: 10 }],
      before,
      1,
    ]);
  });

  it('check 5: a COMMIT that reports an error after the stamp reached the file, when another writer has moved the run on, answers unknown: the stamp rejects and writes are fenced', async () => {
    const { runStore, c, connection } = await armed('run', true);
    const result = await runStore.stampSeal('run-1', COMPLETE, 3).then(
      () => 'stamped',
      (err: WithCommitOutcome) => [describeError(err), err.commitOutcome],
    );
    // (1) red when the stamp's check answers by the version alone (a newer version is then read as
    //     "not there", not_landed) or says landed; (2) prints the outcome, the stored version (the
    //     stamp's plus the other writer's) and the fault's firings.
    expect([result, stored(c, 'run-1')['version'], connection.hits()]).toEqual([
      ['STATE_STORE_WRITES_FENCED', { outcome: 'unknown', errcode: 10 }],
      5,
      1,
    ]);
  });

  it('check 5: a refusal that met an error at its COMMIT answers landed without reading the run back: no SELECT runs after the stamp’s body', async () => {
    const { runStore, connection } = await armed('run');
    await runStore.stampSeal('run-1', COMPLETE, 3);
    // The run now holds a seal: the next stamp is a refusal, and its COMMIT fails once more. A fault
    // that never fires, armed first, sees every statement the connection runs.
    const statements: string[] = [];
    connection.arm({
      at: (sql) => {
        statements.push(sql);
        return false;
      },
      times: Infinity,
      first: 'nothing',
      error: SQLITE.ioError,
    });
    connection.arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'run',
      error: SQLITE.ioError,
    });
    const result = await answer(runStore.stampSeal('run-1', COMPLETE, 4));
    const afterCommit = statements.slice(statements.indexOf('COMMIT') + 1);
    // (1) red when the check of a write that wrote nothing reads the run back (a SELECT then runs in
    //     the protocol's read transaction, which this cell sees open); (2) prints the answer, whether
    //     the read transaction ran, and every SELECT after the failed COMMIT.
    expect({
      result,
      readBackRan: afterCommit.includes('PRAGMA query_only = ON'),
      selects: afterCommit.filter((sql) => sql.trimStart().toUpperCase().startsWith('SELECT')),
      fired: connection.hits(),
    }).toEqual({ result: 'already_stamped', readBackRan: true, selects: [], fired: 2 });
  });
});

describe('#616 unit 13b — racers in separate processes', () => {
  const INDEX = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'index.js')).href;
  /**
   * One racer: opens the home, waits for the start instant, stamps once, and prints `stamped` or the
   * refusal's reason, or a thrown refusal's code and the keys of its details (the store's own
   * refusals carry details; the file's guards' carry none, so the two cannot be mistaken).
   */
  const RACER =
    `import { openRealmHome } from ${JSON.stringify(INDEX)};` +
    'const p = JSON.parse(process.env.U13B_RACE);' +
    'const home = await openRealmHome({ home: p.home });' +
    'while (Date.now() < p.start) {}' +
    'try {' +
    ' const r = await home.runStore.stampSeal(p.runId, p.stamp, p.version);' +
    ' console.log(r.stamped ? "stamped" : r.reason);' +
    '} catch (e) {' +
    ' console.log(String(e.code ?? e.message) + " " + JSON.stringify(Object.keys(e.details ?? {})));' +
    '} finally { home.close(); }';
  const RACERS = 5;

  /** Starts `RACERS` processes on `plan` at once; resolves with each one's exit status and output. */
  function race(
    plan: Record<string, unknown>,
  ): Promise<Array<{ status: number | null; out: string }>> {
    const env = JSON.stringify({ ...plan, start: Date.now() + 4_000 });
    const one = (): Promise<{ status: number | null; out: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', RACER], {
          env: { ...process.env, U13B_RACE: env },
          timeout: 60_000,
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (status) => resolve({ status, out: out.trim() }));
      });
    return Promise.all(Array.from({ length: RACERS }, one));
  }

  it('check 6: five processes stamp one run at one version at once: exactly one stamps, the other four are refused with the store’s version conflict, and the stamp is stored once', async () => {
    const { home, runStore } = await open();
    seed(await foreign(home), legacy('run-1'));
    const results = await race({ home, runId: 'run-1', stamp: COMPLETE, version: 3 });
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.out] = (counts[r.out] ?? 0) + 1;
    const after = (await runStore.get('run-1')).record;
    // (1) red when the losers do not meet the version check (they then return already_stamped), or
    //     the store reads the run outside its write transaction (the losers are then refused by the
    //     file's version guard, whose refusal carries no details), or two stamp; (2) prints how many
    //     racers printed each outcome, any racer that did not exit cleanly, and the run after.
    expect({
      counts,
      failed: results.filter((r) => r.status !== 0),
      after: [after.version, after.sealed_by, after.updated_at],
    }).toEqual({
      counts: { stamped: 1, 'STATE_SNAPSHOT_MISMATCH ["runId","expected","actual"]': 4 },
      failed: [],
      after: [4, COMPLETE, UPDATED],
    });
  }, 120_000); // it starts 5 Node processes
});
