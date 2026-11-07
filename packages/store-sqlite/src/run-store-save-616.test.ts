// run-store-save-616.test.ts — issue #616 PR-1a unit 13c: the run store imports a run another store
// exported (`SqliteRunStore.save`), on real homes in a temp directory, through `openRealmHome`. The
// real cases: realm-cloud's pull and sync, and the coming `realm run import`, handing the store an
// exported run: one not here yet; one here already; one here at another version, or at the same
// version with other content (two copies that each went on from one ancestor); one whose id was
// deleted on purpose; a record of an older format, or with a malformed instant, or past the store's
// limits; a live run whose idempotency key another live run holds; a finished run with no seal stamp;
// a COMMIT that fails after or before its rows reached the file, or after another writer changed the
// run; five processes importing one run at once; a store that changes what it keeps.
//
// These cells stand in for the design's L-SAVE and the import half of L-TIME and L-AMBIG (design
// d4-frozen-r3 §6); no shared law drives `save` (it is not on core's `RunStore`).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  deriveRunPhase,
  WorkflowError,
  type Clock,
  type EvidenceSnapshot,
  type RunRecord,
  type WorkflowContextSnapshot,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import type { WithCommitOutcome } from './connection.js';
import { openDatabase, type DatabaseLike } from './driver.js';
import { openRealmHome } from './index.js';
import type { OpenSeams } from './open-file.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { faultyFiles, SQLITE, type FaultyConnection } from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The instant the cells' clocks answer: after every instant an exported record carries. */
const T = '2030-05-06T07:08:09.000Z';
/** The exported runs' own instants: when they were created, and last written, in their store. */
const CREATED = '2030-01-02T03:04:05.006Z';
const UPDATED = '2030-01-02T03:14:05.006Z';

const dirs: string[] = [];
const handles: RealmHome[] = [];
const connections: DatabaseLike[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u13c-'));
  dirs.push(dir);
  return dir;
}

/** A test clock: it answers `T` and counts its readings. */
function testClock(): { clock: Clock; reads(): number } {
  let reads = 0;
  return {
    clock: {
      now: () => {
        reads += 1;
        return new Date(T);
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

/** Another connection on the home's file (a hostile writer, or a second reader). */
async function foreign(home: string): Promise<DatabaseLike> {
  const c = await openForeignConnection(home);
  connections.push(c);
  return c;
}

/** A connection that records every statement sent through it. */
function recording(real: DatabaseLike, sent: string[]): DatabaseLike {
  return {
    exec: (sql) => {
      sent.push(sql);
      real.exec(sql);
    },
    prepare: (sql) => {
      sent.push(sql);
      return real.prepare(sql);
    },
    close: () => real.close(),
    get isTransaction() {
      return real.isTransaction;
    },
  };
}

/** A refusal as a reader sees it: its code, message and details (a plain error: name and message). */
function refusal(err: unknown): unknown {
  return err instanceof WorkflowError
    ? { code: err.code, message: err.message, details: err.details }
    : `${(err as Error).name}: ${(err as Error).message}`;
}

/** What an import did: its outcome, or its refusal as a reader sees it. */
const saving = (call: Promise<{ outcome: string }>): Promise<unknown> =>
  call.then((r) => r.outcome, refusal);

/** A record as `JSON.stringify` holds it: key order included. */
const text = (record: unknown): string => JSON.stringify(record);

/** The record as the store reads it back: its phase the derivation's. */
const asRead = (record: RunRecord): RunRecord => ({ ...record, run_phase: deriveRunPhase(record) });

/** One evidence entry of `step`. */
function evidenceOf(step: string, answer: string): EvidenceSnapshot {
  return {
    step_id: step,
    started_at: CREATED,
    completed_at: UPDATED,
    duration_ms: 600_000,
    input_summary: { ticket: 'T-1' },
    output_summary: { answer },
    status: 'success',
    evidence_hash: 'e'.repeat(64),
  };
}

/** The workflow's context files as the engine snapshots them at the run's first step. */
function contextFiles(): Record<string, WorkflowContextSnapshot> {
  return {
    'guide.md': {
      source_path: '/work/guide.md',
      content: 'the guide',
      content_hash: 'cd'.repeat(32),
      loaded_at: CREATED,
    },
  };
}

/** A live run another store exported, in the JSON store's shape and key order, with `extra` laid over. */
function exported(extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id: randomUUID(),
    workflow_id: 'wf-import',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 3,
    params: { ticket: 'T-1', priority: 2 },
    evidence: [],
    created_at: CREATED,
    updated_at: UPDATED,
    terminal_state: false,
    ...extra,
  };
}

/** The same run having completed step `a` with `answer`: one step on from `exported()`. */
function completedA(id: string, answer: string): RunRecord {
  return exported({
    id,
    completed_steps: ['a'],
    version: 4,
    evidence: [evidenceOf('a', answer)],
  });
}

/** What the store holds of run `id`, as a second connection reads it: every row of every table. */
function rows(c: DatabaseLike, id: string): Record<string, unknown> {
  return {
    runs: c
      .prepare('SELECT record, run_phase, phase_version, key_hash FROM runs WHERE id = ?')
      .all(id),
    evidence: c.prepare('SELECT seq, entry FROM evidence WHERE run_id = ? ORDER BY seq').all(id),
    blobs: c.prepare('SELECT name, value FROM run_blobs WHERE run_id = ? ORDER BY name').all(id),
  };
}

/** How many rows run `id` has in each table (all 0: nothing of it is stored). */
function counts(c: DatabaseLike, id: string): Record<string, number> {
  const n = (sql: string): number => Number(c.prepare(sql).get(id)!['n']);
  return {
    runs: n('SELECT count(*) AS n FROM runs WHERE id = ?'),
    evidence: n('SELECT count(*) AS n FROM evidence WHERE run_id = ?'),
    blobs: n('SELECT count(*) AS n FROM run_blobs WHERE run_id = ?'),
  };
}

/** Nothing of a run stored. */
const NOTHING = { runs: 0, evidence: 0, blobs: 0 };

describe('#616 unit 13c — an exported run is imported as it is', () => {
  it('check 1: a run with evidence, a write-once value, a key and a rerun link imports as imported, and get() returns the record given: its own instants and version, nothing minted', async () => {
    const o = await open(testClock().clock);
    const id = randomUUID();
    // In the JSON store's key order: the key and the rerun link after the workflow's version.
    const record: RunRecord = {
      id,
      workflow_id: 'wf-import',
      workflow_version: 1,
      idempotency_key: 'order-77',
      rerun_of: randomUUID(),
      completed_steps: ['a'],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      run_phase: 'running',
      version: 4,
      params: { ticket: 'T-1', priority: 2 },
      evidence: [evidenceOf('a', 'the first answer'), evidenceOf('a', 'the second answer')],
      workflow_context_snapshots: contextFiles(),
      created_at: CREATED,
      updated_at: UPDATED,
      terminal_state: false,
    };
    const result = await saving(o.runStore.save(record));
    const back = (await o.runStore.get(id)).record;
    // (1) red when the import stamps an instant or the version from the store (a reading, a version
    //     moved), or stores the record otherwise than given; (2) prints the outcome and, when they
    //     differ, both records.
    expect({ result, back: text(back) === text(record) ? 'equal' : { back, record } }).toEqual({
      result: 'imported',
      back: 'equal',
    });
  });

  it('check 1: a finished run whose stored phase had gone stale imports, and get() returns it with the derived phase', async () => {
    const o = await open(testClock().clock);
    const stale = exported({
      completed_steps: ['a'],
      run_phase: 'running',
      evidence: [evidenceOf('a', 'done')],
      terminal_state: true,
      terminal_reason: 'All steps completed',
      sealed_by: { arm: 'complete', step: 'a' },
    });
    const result = await saving(o.runStore.save(stale));
    const back = (await o.runStore.get(stale.id)).record;
    // (1) red when the read-back compares the record as given (its stale phase) with the run read
    //     back (the derived one): the import then fails; (2) prints the outcome, the phase read back,
    //     and whether the rest is the record given.
    expect({
      result,
      phase: back.run_phase,
      rest: text(back) === text({ ...stale, run_phase: back.run_phase }),
    }).toEqual({ result: 'imported', phase: 'completed', rest: true });
  });
});

describe('#616 unit 13c — an import spends no reading', () => {
  it('check 2: every outcome of an import spends none: written, found here, and each refusal', async () => {
    const t = testClock();
    const o = await open(t.clock);
    const c = await foreign(o.home);
    // The live run holding key `K`, for the key's refusal.
    await o.runStore.create({
      workflowId: 'wf-import',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'K',
    });
    const first = exported();
    await o.runStore.save(first);
    const purged = randomUUID();
    c.prepare('INSERT INTO purged_ids (id, purged_at) VALUES (?, ?)').run(
      purged,
      '2030-04-01T00:00:00.000Z',
    );
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) deep = { level: deep };
    const branches: Record<string, RunRecord> = {
      imported: exported(),
      unchanged: first,
      legacy: { id: randomUUID(), state: 'running' } as unknown as RunRecord,
      timestamp: exported({ updated_at: '2030-01-02' }),
      limit: exported({ params: deep }),
      purged: exported({ id: purged }),
      version: { ...first, version: 9 },
      content: { ...first, params: { ticket: 'T-2' } },
      key: exported({ idempotency_key: 'K', created_at: T, updated_at: T }),
    };
    const spent: Record<string, [unknown, number]> = {};
    for (const [branch, record] of Object.entries(branches)) {
      const before = t.reads();
      const result = await saving(o.runStore.save(record));
      spent[branch] = [
        typeof result === 'string' ? result : (result as { code: string }).code,
        t.reads() - before,
      ];
    }
    // (1) red when an import takes a reading on any branch (the write's own reading after BEGIN, or
    //     one taken before the checks); (2) prints each branch's outcome and the readings it spent.
    expect(spent).toEqual({
      imported: ['imported', 0],
      unchanged: ['unchanged', 0],
      legacy: ['STATE_LEGACY_FORMAT', 0],
      timestamp: ['STATE_RUN_TIMESTAMP_INVALID', 0],
      limit: ['STATE_STORE_LIMIT_EXCEEDED', 0],
      purged: ['STATE_RUN_PURGED', 0],
      version: ['STATE_RUN_DIVERGED', 0],
      content: ['STATE_RUN_DIVERGED', 0],
      key: ['STATE_RUN_DIVERGED', 0],
    });
  });
});

describe('#616 unit 13c — a run that is here already', () => {
  it('check 3: a second import of the same record is unchanged, and the store is as the first left it', async () => {
    const o = await open(testClock().clock);
    const c = await foreign(o.home);
    const record = completedA(randomUUID(), 'the answer');
    await o.runStore.save(record);
    const before = rows(c, record.id);
    const result = await saving(o.runStore.save(record));
    // (1) red when the second import writes again (the schema's insert guard then refuses it with
    //     its plain error), or changes a row; (2) prints the outcome and whether the rows changed.
    expect({ result, rows: text(rows(c, record.id)) === text(before) }).toEqual({
      result: 'unchanged',
      rows: true,
    });
  });

  it('check 4: an import of a run stored here at another version is refused with the JSON store’s words, and nothing is written', async () => {
    const o = await open(testClock().clock);
    const c = await foreign(o.home);
    const id = randomUUID();
    await o.runStore.save(exported({ id }));
    const before = rows(c, id);
    const result = await saving(o.runStore.save(completedA(id, 'the answer')));
    // (1) red when the import of another version writes (the insert guard's plain error, or the
    //     rows change) or is reported unchanged; (2) prints the refusal and whether the rows changed.
    expect({ result, rows: text(rows(c, id)) === text(before) }).toEqual({
      result: {
        code: 'STATE_RUN_DIVERGED',
        message: `Run '${id}' exists locally with a different version (local: 3, incoming: 4). Manual resolution required.`,
        details: { runId: id, localVersion: 3, incomingVersion: 4 },
      },
      rows: true,
    });
  });

  it('check 5: two copies that each went one step on from one ancestor carry the same version: the second import is refused, and the stored run is the first', async () => {
    const o = await open(testClock().clock);
    const c = await foreign(o.home);
    const id = randomUUID();
    const mine = completedA(id, 'the answer here');
    const theirs = completedA(id, 'the answer there');
    await o.runStore.save(mine);
    const before = rows(c, id);
    const result = await saving(o.runStore.save(theirs));
    // (1) red when the import compares the version alone (the old rule: the second copy is then
    //     reported unchanged and its content is lost); (2) prints the refusal and whether the stored
    //     run is still the first copy.
    expect({ result, rows: text(rows(c, id)) === text(before) }).toEqual({
      result: {
        code: 'STATE_RUN_DIVERGED',
        message: `Run '${id}' exists locally at version 4 with different content from the incoming run. Manual resolution required.`,
        details: { runId: id, localVersion: 4, incomingVersion: 4 },
      },
      rows: true,
    });
  });

  it('check 5: a copy at the same version whose keys are in another order is unchanged', async () => {
    const o = await open(testClock().clock);
    const record = completedA(randomUUID(), 'the answer');
    await o.runStore.save(record);
    // Another exporter: the same run, its keys (and its params' keys) in the reverse order.
    const reordered = Object.fromEntries(
      Object.entries({ ...record, params: { priority: 2, ticket: 'T-1' } }).reverse(),
    ) as unknown as RunRecord;
    const result = await saving(o.runStore.save(reordered));
    // (1) red when the same-version comparison counts key order (a strict JSON compare): the copy is
    //     then refused as diverged; (2) prints the outcome.
    expect(result).toBe('unchanged');
  });
});

describe('#616 unit 13c — an id deleted on purpose', () => {
  it('check 6: an import of an id whose tombstone outlived its detail is refused with the time it was deleted, and nothing is written', async () => {
    const o = await open(testClock().clock);
    const c = await foreign(o.home);
    const id = randomUUID();
    // The compacted state: the id kept forever in `purged_ids`, no detail left in `purged_runs`.
    c.prepare('INSERT INTO purged_ids (id, purged_at) VALUES (?, ?)').run(
      id,
      '2030-04-01T09:30:00.000Z',
    );
    const result = await saving(o.runStore.save(exported({ id })));
    // (1) red when the import does not read the tombstone (the schema's insert guard then refuses it
    //     with its generic sentence, which names no time) or reads the compactable detail instead (not
    //     found: the same generic sentence); (2) prints the refusal and the rows stored.
    expect({ result, stored: counts(c, id) }).toEqual({
      result: {
        code: 'STATE_RUN_PURGED',
        message: `Run '${id}' was deleted on 2030-04-01T09:30:00.000Z and its id cannot be used again. Nothing was imported.`,
        details: { runId: id, purged_at: '2030-04-01T09:30:00.000Z' },
      },
      stored: NOTHING,
    });
  });
});

describe('#616 unit 13c — refused before the write begins', () => {
  /** A home whose store connection records every statement; `sent` is cleared after the open. */
  async function recorded(): Promise<{ o: Opened; sent: string[] }> {
    const sent: string[] = [];
    const o = await open(testClock().clock, {
      openFile: (path) => recording(openDatabase(path), sent),
    });
    sent.length = 0;
    return { o, sent };
  }

  it('check 7: a record with no run_phase is refused as not a run record in the current format, before any statement', async () => {
    const { o, sent } = await recorded();
    const noPhase: Record<string, unknown> = { ...exported() };
    delete noPhase['run_phase'];
    const result = await saving(o.runStore.save(noPhase as unknown as RunRecord));
    // (1) red when the shape is checked inside the write (a BEGIN IMMEDIATE is then sent), or not at
    //     all (the record is imported with a derived phase); (2) prints the refusal and the
    //     statements sent.
    expect({ result, sent }).toEqual({
      result: {
        code: 'STATE_LEGACY_FORMAT',
        message:
          'This is not a run record in the current format, so it cannot be imported. Nothing was imported.',
        details: { runId: noPhase.id },
      },
      sent: [],
    });
  });

  it('check 7: a record in the old `state` shape is refused as not a run record in the current format, before any statement', async () => {
    const { o, sent } = await recorded();
    const id = randomUUID();
    const old = {
      id,
      workflow_id: 'wf-import',
      workflow_version: 1,
      state: 'running',
      version: 3,
      params: {},
      evidence: [],
      created_at: CREATED,
      updated_at: UPDATED,
    };
    const result = await saving(o.runStore.save(old as unknown as RunRecord));
    // (1) red when the shape is checked inside the write, or not at all (the import then reaches the
    //     evidence split or the schema); (2) prints the refusal and the statements sent.
    expect({ result, sent }).toEqual({
      result: {
        code: 'STATE_LEGACY_FORMAT',
        message:
          'This is not a run record in the current format, so it cannot be imported. Nothing was imported.',
        details: { runId: id },
      },
      sent: [],
    });
  });

  const MALFORMED: ReadonlyArray<[string, string]> = [
    ['a date only', '2030-01-02'],
    ['no Z', '2030-01-02T03:04:05.006'],
    ['two fractional digits', '2030-01-02T03:04:05.00Z'],
    ['not a date', 'yesterday'],
    ['a day the month does not have', '2026-02-30T00:00:00.000Z'],
  ];
  const CELLS = (['created_at', 'updated_at'] as const).flatMap((field) =>
    MALFORMED.map(([what, value]) => ({ field, what, value })),
  );
  it.each(CELLS)(
    'check 7: $field as $what ($value) is refused, naming the field, before any statement',
    async ({ field, value }) => {
      const { o, sent } = await recorded();
      const record =
        field === 'created_at' ? exported({ created_at: value }) : exported({ updated_at: value });
      const result = await saving(o.runStore.save(record));
      // (1) red when the instant is checked inside the write (a BEGIN IMMEDIATE is then sent), by a
      //     looser rule (a text JavaScript parses but does not print back is then imported), or when
      //     a text that names no instant throws instead (the plain RangeError of `toISOString`);
      //     (2) prints the refusal and the statements sent.
      expect({ result, sent }).toEqual({
        result: {
          code: 'STATE_RUN_TIMESTAMP_INVALID',
          message: `Run '${record.id}' has a ${field} that is not a timestamp of the form 2026-11-05T12:00:00.000Z. Nothing was imported.`,
          details: { runId: record.id, field },
        },
        sent: [],
      });
    },
  );

  it('check 7: a record nested past the store’s depth limit is refused with STATE_STORE_LIMIT_EXCEEDED, before any statement', async () => {
    const { o, sent } = await recorded();
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) deep = { level: deep };
    const result = await o.runStore.save(exported({ params: deep })).then(
      () => 'imported',
      (err: WorkflowError) => [err.code, err.details['limit']],
    );
    // (1) red when the limits are checked inside the write (a BEGIN IMMEDIATE is then sent), or not
    //     at all (SQLite's "malformed JSON" from a generated column); (2) prints the refusal and the
    //     statements sent.
    expect({ result, sent }).toEqual({
      result: ['STATE_STORE_LIMIT_EXCEEDED', 'nesting depth'],
      sent: [],
    });
  });
});

describe('#616 unit 13c — the idempotency key', () => {
  /** A home with a live run holding key `K` of `wf-import`, created at the clock's `T`. */
  async function withLiveHolder(): Promise<{ o: Opened; c: DatabaseLike; holder: RunRecord }> {
    const o = await open(testClock().clock);
    const c = await foreign(o.home);
    const { record } = await o.runStore.create({
      workflowId: 'wf-import',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'K',
    });
    return { o, c, holder: record };
  }

  /** The run a keyed create of `K` is given back: the key's holder. */
  async function holderOfK(o: Opened): Promise<string> {
    const r = await o.runStore.create({
      workflowId: 'wf-import',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'K',
    });
    return r.created ? `a new run ${r.record.id}` : r.record.id;
  }

  const LATER = '2030-05-06T08:00:00.000Z';

  it('check 8: a live run whose key a live run holds, newer than that holder, is refused, and nothing is written', async () => {
    const { o, c, holder } = await withLiveHolder();
    const incoming = exported({ idempotency_key: 'K', created_at: LATER, updated_at: LATER });
    const result = await saving(o.runStore.save(incoming));
    // (1) red when the import skips the key check (the newer live run is then imported, and the key
    //     has two live runs); (2) prints the refusal, the rows stored of the incoming run and the
    //     key's holder after.
    expect({ result, stored: counts(c, incoming.id), holder: await holderOfK(o) }).toEqual({
      result: {
        code: 'STATE_RUN_DIVERGED',
        message: `Idempotency key for workflow 'wf-import' is already held by a different live run '${holder.id}'; the imported run '${incoming.id}' was not imported.`,
        details: { runId: incoming.id, existingOwnerRunId: holder.id },
      },
      stored: NOTHING,
      holder: holder.id,
    });
  });

  it('check 8: a finished run whose key a live run holds imports, and the live run stays the holder', async () => {
    const { o, holder } = await withLiveHolder();
    const finished = exported({
      idempotency_key: 'K',
      created_at: LATER,
      updated_at: LATER,
      completed_steps: ['a'],
      evidence: [evidenceOf('a', 'done')],
      terminal_state: true,
      terminal_reason: 'All steps completed',
      sealed_by: { arm: 'complete', step: 'a' },
    });
    const result = await saving(o.runStore.save(finished));
    // (1) red when a finished run is refused for its key too (the JSON store's old rule); (2) prints
    //     the outcome and the key's holder after.
    expect({ result, holder: await holderOfK(o) }).toEqual({
      result: 'imported',
      holder: holder.id,
    });
  });

  it('check 8: a live run whose key only a finished run holds imports', async () => {
    const o = await open(testClock().clock);
    const { record } = await o.runStore.create({
      workflowId: 'wf-import',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'K',
    });
    await o.runStore.settleStep(record.id, {
      kind: 'seal_run',
      arm: 'abandon_requested',
      reason: 'the operator abandoned it',
      expected_version: record.version,
      release_claims: true,
    });
    const incoming = exported({ idempotency_key: 'K', created_at: LATER, updated_at: LATER });
    const result = await saving(o.runStore.save(incoming));
    // (1) red when the import refuses a key whose holder is finished; (2) prints the outcome and the
    //     key's holder after (the imported live run).
    expect({ result, holder: await holderOfK(o) }).toEqual({
      result: 'imported',
      holder: incoming.id,
    });
  });

  it('check 8: a run whose key is null imports as a run with no key', async () => {
    const o = await open(testClock().clock);
    const c = await foreign(o.home);
    const incoming = exported({ idempotency_key: null } as unknown as Partial<RunRecord>);
    const result = await saving(o.runStore.save(incoming));
    const keyHash = c.prepare('SELECT key_hash FROM runs WHERE id = ?').get(incoming.id)?.[
      'key_hash'
    ];
    // (1) red when a null key is taken for a key (the key's hash of null then throws a plain
    //     TypeError); (2) prints the outcome and the key hash stored.
    expect({ result, keyHash }).toEqual({ result: 'imported', keyHash: null });
  });
});

describe('#616 unit 13c — no seal boundary', () => {
  it('check 9: a finished run with no seal stamp imports as it is, and get() returns it unstamped', async () => {
    const o = await open(testClock().clock);
    const unstamped = exported({
      completed_steps: ['a'],
      evidence: [evidenceOf('a', 'done')],
      terminal_state: true,
      terminal_reason: 'All steps completed',
    });
    const result = await saving(o.runStore.save(unstamped));
    const back = (await o.runStore.get(unstamped.id)).record;
    // (1) red when the import runs the seal boundary (a finished write with no stamp is then refused
    //     STATE_SEAL_UNSTAMPED) or stamps it; (2) prints the outcome, the stamp read back and whether
    //     the rest is the record given.
    expect({
      result,
      sealed_by: back.sealed_by,
      rest: text(back) === text(asRead(unstamped)),
    }).toEqual({ result: 'imported', sealed_by: undefined, rest: true });
  });
});

describe('#616 unit 13c — the COMMIT outcome of an import', () => {
  /** A home whose store connection fails its next COMMIT (after `first`), and a record to import. */
  async function armed(
    first: 'run' | 'rollback',
    { alsoChange = false }: { alsoChange?: boolean } = {},
  ): Promise<{ o: Opened; record: RunRecord; fired(): number }> {
    const files = faultyFiles(openDatabase);
    const o = await open(testClock().clock, { openFile: files.openFile });
    const other = await foreign(o.home);
    const record = completedA(randomUUID(), 'the answer');
    const connection: FaultyConnection = files.opened.at(-1)!;
    connection.arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first,
      // Another writer changes the run before the store can read its write back.
      ...(alsoChange
        ? {
            also: () => {
              other
                .prepare(
                  "UPDATE runs SET record = json_set(record, '$.version', json_extract(record, '$.version') + 1) WHERE id = ?",
                )
                .run(record.id);
            },
          }
        : {}),
      error: SQLITE.ioError,
    });
    return { o, record, fired: () => connection.hits() };
  }

  it('check 10: a COMMIT that reports an error after the import’s rows reached the file answers landed: the import resolves, and the run reads back', async () => {
    const { o, record, fired } = await armed('run');
    const result = await saving(o.runStore.save(record));
    // (1) red when the import's check does not find the run it wrote (the protocol then answers
    //     not_landed and the import rejects); (2) prints the outcome, whether it reads back as the
    //     record given and the fault's firings.
    expect([
      result,
      text((await o.runStore.get(record.id)).record) === text(record),
      fired(),
    ]).toEqual(['imported', true, 1]);
  });

  it('check 10: a COMMIT that reports an error after SQLite rolled the import back answers not_landed: the import rejects, and nothing is stored', async () => {
    const { o, record, fired } = await armed('rollback');
    const c = await foreign(o.home);
    const result = await o.runStore.save(record).then(
      (r) => r.outcome,
      (err: WithCommitOutcome) => [err.message, err.commitOutcome],
    );
    // (1) red when the import's check answers that the run is there without finding it (the
    //     protocol then answers landed and the import resolves); (2) prints the outcome, the rows
    //     stored and the fault's firings.
    expect([result, counts(c, record.id), fired()]).toEqual([
      ['disk I/O error (SQLite error 10)', { outcome: 'not_landed', errcode: 10 }],
      NOTHING,
      1,
    ]);
  });

  it('check 10: a COMMIT that reports an error after the import’s rows reached the file, when another writer has changed the run, answers unknown: the import rejects, and writes are fenced', async () => {
    const { o, record, fired } = await armed('run', { alsoChange: true });
    const result = await o.runStore.save(record).then(
      (r) => r.outcome,
      (err: WithCommitOutcome) => [(err as unknown as WorkflowError).code, err.commitOutcome],
    );
    // (1) red when the import's check reads another writer's run as its own (landed) or as no run
    //     (not_landed); (2) prints the outcome, the stored version (the import's plus the other
    //     writer's) and the fault's firings.
    expect([result, (await o.runStore.get(record.id)).record.version, fired()]).toEqual([
      ['STATE_STORE_WRITES_FENCED', { outcome: 'unknown', errcode: 10 }],
      5,
      1,
    ]);
  });
});

describe('#616 unit 13c — racers in separate processes', () => {
  const INDEX = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'index.js')).href;
  /** One racer: opens the home, waits for the start instant, imports once, and prints what it did. */
  const RACER =
    `import { openRealmHome } from ${JSON.stringify(INDEX)};` +
    'const p = JSON.parse(process.env.U13C_RACE);' +
    'const home = await openRealmHome({ home: p.home });' +
    'while (Date.now() < p.start) {}' +
    'try {' +
    ' const r = await home.runStore.save(p.record);' +
    ' console.log(r.outcome);' +
    '} catch (e) {' +
    ' console.log("threw " + String(e.code ?? e.message));' +
    '} finally { home.close(); }';
  const RACERS = 5;

  it('check 11: five processes import one new run at once: exactly one imports it, the other four find it unchanged, none throws', async () => {
    const o = await open();
    const c = await foreign(o.home);
    const record = completedA(randomUUID(), 'the answer');
    const env = JSON.stringify({ home: o.home, record, start: Date.now() + 4_000 });
    const one = (): Promise<{ status: number | null; out: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', RACER], {
          env: { ...process.env, U13C_RACE: env },
          timeout: 60_000,
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (status) => resolve({ status, out: out.trim() }));
      });
    const results = await Promise.all(Array.from({ length: RACERS }, one));
    const outcomes: Record<string, number> = {};
    for (const r of results) outcomes[r.out] = (outcomes[r.out] ?? 0) + 1;
    // (1) red when the import looks for the run outside its write transaction (the losers then reach
    //     the schema's insert guard: "threw" with its plain error), or two write; (2) prints how many
    //     racers printed each outcome, any racer that did not exit cleanly, the rows stored and
    //     whether the run reads back as the record.
    expect({
      outcomes,
      failed: results.filter((r) => r.status !== 0),
      stored: counts(c, record.id).runs,
      back: text((await o.runStore.get(record.id)).record) === text(record),
    }).toEqual({ outcomes: { imported: 1, unchanged: 4 }, failed: [], stored: 1, back: true });
  }, 120_000); // it starts 5 Node processes
});

describe('#616 unit 13c — the read-back', () => {
  it('check 12: a store that changes the run it keeps as it is written fails the import with the read-back’s error, and nothing of the run remains', async () => {
    const files = faultyFiles(openDatabase);
    const o = await open(testClock().clock, { openFile: files.openFile });
    const c = await foreign(o.home);
    // On the store's own connection: rewrite the new run's params, moving its version by one so the
    // schema's version fence and identity guard let the rewrite through.
    files.opened
      .at(-1)!
      .connection.exec(
        "CREATE TEMP TRIGGER u13c_rewrite AFTER INSERT ON main.runs BEGIN UPDATE runs SET record = json_set(record, '$.params', json('{\"ticket\":\"rewritten\"}'), '$.version', json_extract(record, '$.version') + 1) WHERE id = new.id; END",
      );
    const record = completedA(randomUUID(), 'the answer');
    const result = await saving(o.runStore.save(record));
    // (1) red when the import does not read the run back (it then resolves imported, and the store
    //     keeps other content than the record given); (2) prints the outcome and the rows stored.
    expect({ result, stored: counts(c, record.id) }).toEqual({
      result: `Error: The imported run ${record.id} does not read back as the record it was given, so it was not imported.`,
      stored: NOTHING,
    });
  });
});
