// run-store-616.test.ts — issue #616 PR-1a unit 12a: the run store a SQLite home's handle carries
// (`SqliteRunStore`: create unkeyed, get, list), on real homes in a temp directory, through
// `openRealmHome`. The real cases: the engine creating a run and reading it back, `realm run list`
// over many runs and one workflow, a test that counts its clock's readings, a record stamped ahead of a
// clock that then stepped back, params too deep for the store, a COMMIT that fails after or before its
// rows reached the file, a caller passing an idempotency key before unit 15, and the engine's
// release-line check of a store and its errors.
//
// These cells stand in for the create, get and list ground of core's shared store laws until unit 16
// wires the contract (`packages/testing/src/store/store-clock-contract.ts` and
// `run-store-fidelity-contract.ts`): `WRITE_ONE_READING` (its unkeyed-create row), `READS_ONE_READING`,
// `READ_AT_CAPPED` and `STORE_RELEASE_LINE_TRUE`.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertReleaseLine,
  JsonFileStore,
  releaseLineOf,
  WorkflowError,
  type Clock,
  type CreateRunOptions,
  type EvidenceSnapshot,
  type ExtensionIdentityEntry,
  type Snapshot,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import type { WithCommitOutcome } from './connection.js';
import { openDatabase, type DatabaseLike } from './driver.js';
import { openRealmHome } from './index.js';
import type { OpenSeams } from './open-file.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { insertRunRecord } from './run-rows.js';
import { faultyFiles, SQLITE } from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';
import { VERSION } from './version.js';

/** The instant the cells' clocks start at. */
const T = '2030-05-06T07:08:09.000Z';

const dirs: string[] = [];
const handles: RealmHome[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u12a-'));
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

/** Opens a home on `clock` (through the open's seams when given); the cleanup closes it. */
async function open(clock: Clock, seams?: OpenSeams): Promise<RealmHome> {
  const home = join(tmp(), '.realm');
  const handle = await (seams === undefined
    ? openRealmHome({ home, clock })
    : openHome({ home, clock }, seams));
  handles.push(handle);
  return handle;
}

/** A refusal as a reader sees it: a typed refusal's code, or a plain error's message. */
function describeError(err: unknown): string {
  return err instanceof WorkflowError
    ? err.code
    : `${(err as Error).name}: ${(err as Error).message}`;
}

/** What a synchronous call does: `'no error'`, or the error as a reader sees it. */
function settleSync(call: () => void): string {
  try {
    call();
    return 'no error';
  } catch (err) {
    return describeError(err);
  }
}

/** A record as `JSON.stringify` holds it: key order included. */
const text = (snapshot: Snapshot): string => JSON.stringify(snapshot.record);

/** The order a store lists runs in: by id. */
const byId = (a: Snapshot, b: Snapshot): number =>
  a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;

/** A creator's start entry, as the engine passes it to `create`. */
const ENTRY: ExtensionIdentityEntry = {
  captured_at: '2030-05-06T07:00:00.000Z',
  modules: [],
  tree: {
    roots: [],
    rules: 'dir_tree_v1: test',
    file_count: 0,
    total_bytes: 0,
    tree_hash: 'ab'.repeat(32),
    truncated: false,
  },
  coverage: 'dir_tree_v1',
  origin: 'start',
};

/** A create with every optional field an unkeyed create writes. */
const FULL: CreateRunOptions = {
  workflowId: 'support-reply',
  workflowVersion: 3,
  params: { ticket: 'T-1', lines: [1, 'two', { three: null }] },
  parentRunId: 'run-parent',
  extensionIdentity: [ENTRY],
};

/** A create with none: an empty start entry list is left out. */
const BARE: CreateRunOptions = {
  workflowId: 'triage',
  workflowVersion: 1,
  params: {},
  extensionIdentity: [],
};

describe('#616 unit 12a — create, get and list', () => {
  it("check 1: an unkeyed create is stamped with the clock's instant, in the JSON store's key order, and reads back equal through get and list", async () => {
    const { runStore } = await open(testClock(T).clock);
    const json = new JsonFileStore(join(tmp(), 'runs'));
    const full = await runStore.create(FULL);
    const bare = await runStore.create(BARE);
    const listed = await runStore.list();
    expect({
      keys: [Object.keys(full.record), Object.keys(bare.record)],
      stamps: [full, bare].map((c) => [
        c.record.created_at,
        c.record.updated_at,
        c.at.toISOString(),
        c.created,
      ]),
      get: [text(await runStore.get(full.record.id)), text(await runStore.get(bare.record.id))],
      list: listed.snapshots.map(text),
    }).toEqual({
      // (1) red when the record's keys are built in another order than the JSON store's, or an
      //     optional key is written when it should be left out (an empty start entry list) or left
      //     out when given; (2) prints both key lists.
      keys: [
        Object.keys((await json.create(FULL)).record),
        Object.keys((await json.create(BARE)).record),
      ],
      // (1) red when a stamp is not the clock's instant or the two stamps differ; (2) prints each
      //     run's created_at, updated_at, `at` and `created`.
      stamps: [
        [T, T, T, true],
        [T, T, T, true],
      ],
      // (1) red when a run reads back with other content or another key order (a piece put back
      //     out of place); (2) prints the texts read back.
      get: [text(full), text(bare)],
      list: [full, bare].sort(byId).map(text),
    });
  });

  it('check 1: list filters by workflow (an empty id is given), orders by id, is one snapshot, and is empty for an empty store', async () => {
    const t = testClock(T);
    const { runStore } = await open(t.clock);
    const empty = await runStore.list();
    // Eight runs, each a millisecond later than the one before: their creation order is not their
    // id order (it is one chance in 8! that it is), so an order the store does not ask for shows.
    const triage: Snapshot[] = [];
    for (let i = 0; i < 8; i++) {
      t.set(new Date(Date.parse(T) + i).toISOString());
      triage.push(await runStore.create(BARE));
    }
    const support = await runStore.create(FULL);
    t.set(T);
    const all = await runStore.list();
    const one = await runStore.list('triage');
    const none = await runStore.list('');
    const ids = (snapshots: readonly Snapshot[]): string[] => snapshots.map((s) => s.record.id);
    expect({
      empty: {
        runs: empty.snapshots.length,
        read_at: empty.read_at.toISOString(),
        one: empty.consistent_snapshot,
      },
      all: ids(all.snapshots),
      triage: ids(one.snapshots),
      none: none.snapshots.length,
      one: [all.consistent_snapshot, one.consistent_snapshot],
    }).toEqual({
      // (1) red when an empty store fails or lists something, or the listing is not one snapshot;
      //     (2) prints what the empty listing gave.
      empty: { runs: 0, read_at: T, one: true },
      // (1) red when the list is not in id order (no ORDER BY: the filtered read follows the
      //     key index, by creation time), drops a run, or the filter is not applied; an empty
      //     workflow id read as "no filter" lists every run; (2) prints the ids each call listed.
      all: ids([...triage, support].sort(byId)),
      triage: ids([...triage].sort(byId)),
      none: 0,
      one: [true, true],
    });
  });

  it('check 2: create, get and list each spend one reading, a get of a missing run and a list of an empty store included', async () => {
    const t = testClock(T);
    const { runStore } = await open(t.clock);
    const spent = async (call: () => Promise<unknown>): Promise<[number, string]> => {
      const before = t.reads();
      const outcome = await call().then(() => 'ok', describeError);
      return [t.reads() - before, outcome];
    };
    const emptyList = await spent(() => runStore.list());
    let id = '';
    const create = await spent(async () => {
      id = (await runStore.create(BARE)).record.id;
    });
    // (1) red when a call reads the clock twice, or takes its reading only once the run is found
    //     (a missing run then spends none); (2) prints each call's count of readings and outcome.
    expect({
      emptyList,
      create,
      get: await spent(() => runStore.get(id)),
      missing: await spent(() => runStore.get('no-such-run')),
      list: await spent(() => runStore.list()),
    }).toEqual({
      emptyList: [1, 'ok'],
      create: [1, 'ok'],
      get: [1, 'ok'],
      missing: [1, 'STATE_RUN_NOT_FOUND'],
      list: [1, 'ok'],
    });
  });

  it('check 3: get and list judge a run stamped ahead of the clock at its stamp capped at the reading plus five seconds, and never before the reading', async () => {
    const t = testClock(T);
    const { runStore } = await open(t.clock);
    const at = async (instant: string): Promise<string> => {
      t.set(instant);
      return (await runStore.create(BARE)).record.id;
    };
    // Stamped an hour ahead, three seconds ahead and an hour behind; then the clock is back at T.
    const runs = {
      hourAhead: await at('2030-05-06T08:08:09.000Z'),
      threeSecondsAhead: await at('2030-05-06T07:08:12.000Z'),
      hourBehind: await at('2030-05-06T06:08:09.000Z'),
    };
    t.set(T);
    const listing = await runStore.list();
    const listedAt = (id: string): string | undefined =>
      listing.snapshots.find((s) => s.record.id === id)?.at.toISOString();
    const judged = async (id: string): Promise<[string, string | undefined]> => [
      (await runStore.get(id)).at.toISOString(),
      listedAt(id),
    ];
    // (1) red when a read returns its raw reading unfloored (every row T) or floors without the
    //     cap (the hour-ahead row 08:08:09); (2) prints what get and list judged each run at.
    expect({
      hourAhead: await judged(runs.hourAhead),
      threeSecondsAhead: await judged(runs.threeSecondsAhead),
      hourBehind: await judged(runs.hourBehind),
      read_at: listing.read_at.toISOString(),
    }).toEqual({
      hourAhead: ['2030-05-06T07:08:14.000Z', '2030-05-06T07:08:14.000Z'],
      threeSecondsAhead: ['2030-05-06T07:08:12.000Z', '2030-05-06T07:08:12.000Z'],
      hourBehind: [T, T],
      read_at: T,
    });
  });

  it('check 4: params nested past the store’s depth limit are refused with STATE_STORE_LIMIT_EXCEEDED before any statement reaches the file', async () => {
    const sent: string[] = [];
    const recording = (real: DatabaseLike): DatabaseLike => ({
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
    });
    const { runStore } = await open(testClock(T).clock, {
      openFile: (path) => recording(openDatabase(path)),
    });
    // A thousand levels of params under the record: the record is 1,002 deep.
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) deep = { level: deep };
    sent.length = 0;
    const outcome = await runStore
      .create({ workflowId: 'triage', workflowVersion: 1, params: deep })
      .then(
        () => 'created',
        (err: unknown) =>
          err instanceof WorkflowError ? [err.code, err.details?.['limit']] : describeError(err),
      );
    const atRefusal = [...sent];
    // (1) red when the limit is checked inside the write (a BEGIN IMMEDIATE and its ROLLBACK are
    //     sent), or the record is let through; (2) prints the refusal and every statement sent.
    expect({
      outcome,
      sent: atRefusal,
      runs: (await runStore.list()).snapshots.length,
    }).toEqual({
      outcome: ['STATE_STORE_LIMIT_EXCEEDED', 'nesting depth'],
      sent: [],
      runs: 0,
    });
  });

  it('check 5: a create whose COMMIT reports an error after its rows reached the file answers landed: the create resolves and the run reads back', async () => {
    const files = faultyFiles(openDatabase);
    const { runStore } = await open(testClock(T).clock, { openFile: files.openFile });
    const connection = files.opened.at(-1)!;
    connection.arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'run',
      error: SQLITE.ioError,
    });
    const created = await runStore.create(BARE);
    // (1) red when the create's check reads the run back and does not find it by its content
    //     (the protocol then answers not_landed and the create rejects), or the fault did not fire;
    //     (2) prints whether the run read back equal and the fault's firings.
    expect({
      readsBack: text(await runStore.get(created.record.id)) === text(created),
      fired: connection.hits(),
    }).toEqual({ readsBack: true, fired: 1 });
  });

  it('check 5: a create whose COMMIT reports an error after SQLite rolled it back answers not_landed: the create rejects and no run is stored', async () => {
    const files = faultyFiles(openDatabase);
    const { runStore } = await open(testClock(T).clock, { openFile: files.openFile });
    const connection = files.opened.at(-1)!;
    connection.arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'rollback',
      error: SQLITE.ioError,
    });
    const outcome = await runStore.create(BARE).then(
      () => 'created',
      (err: WithCommitOutcome) => [err.message, err.commitOutcome],
    );
    // (1) red when the create's check answers that the run is there without finding it (the
    //     protocol then answers landed and the create resolves); (2) prints the create's outcome,
    //     the runs stored and the fault's firings.
    expect({
      outcome,
      runs: (await runStore.list()).snapshots.length,
      fired: connection.hits(),
    }).toEqual({
      outcome: ['disk I/O error (SQLite error 10)', { outcome: 'not_landed', errcode: 10 }],
      runs: 0,
      fired: 1,
    });
  });

  it('check 6: a keyed create (an empty key too) is refused until unit 15, writing nothing and reading no clock', async () => {
    const t = testClock(T);
    const { runStore } = await open(t.clock);
    const keyed = async (idempotencyKey: string): Promise<[number, string]> => {
      const before = t.reads();
      const outcome = await runStore
        .create({ ...BARE, idempotencyKey })
        .then(() => 'created', describeError);
      return [t.reads() - before, outcome];
    };
    const refused =
      'Error: A keyed create arrives with the key holder, unit 15 of the SQLite store; this store creates unkeyed runs only.';
    // (1) red when a keyed create is let through (a run is written, a reading spent), or an empty
    //     key is read as no key; (2) prints each create's readings and outcome, and the runs stored.
    expect({
      key: await keyed('ticket-42'),
      emptyKey: await keyed(''),
      runs: (await runStore.list()).snapshots.length,
    }).toEqual({ key: [0, refused], emptyKey: [0, refused], runs: 0 });
  });

  it('check 7: the store declares the package’s release line, its not-found refusal comes from the same line, and core’s check admits it', async () => {
    const { runStore } = await open(testClock(T).clock);
    const refusal = await runStore.get('store-release-line-missing-run').then(
      () => undefined,
      (err: unknown) => err,
    );
    const store = releaseLineOf(runStore);
    // (1) red when the class is not branded (no line: core's check refuses it as a plain object),
    //     or the refusal is not a realm error of the same generation; (2) prints the store's line,
    //     whether the refusal's matches, and what core's check said.
    expect({
      store: [store?.package, store?.version],
      sameLine: store !== undefined && releaseLineOf(refusal)?.generation === store.generation,
      admitted: settleSync(() => assertReleaseLine(runStore, 'run store')),
    }).toEqual({
      store: ['@sensigo/realm-store-sqlite', VERSION],
      sameLine: true,
      admitted: 'no error',
    });
  });
  // ---- the review of #1003 (MA 3, 2026-11-07): two cells the unit's own cells left unpinned ----
  it('review of #1003 — list reads every run in ONE snapshot: a write that lands between two of its run reads shows in none of them', async () => {
    const home = join(tmp(), '.realm');
    let runReads = 0;
    let strike: (() => void) | undefined;
    // Passes everything on; on the third read of a run row it first runs `strike`.
    const striking = (real: DatabaseLike): DatabaseLike => ({
      exec: (sql) => real.exec(sql),
      prepare: (sql) => {
        const statement = real.prepare(sql);
        if (sql !== 'SELECT record FROM runs WHERE id = ?') return statement;
        return {
          run: (...p) => statement.run(...p),
          all: (...p) => statement.all(...p),
          get: (...p) => {
            runReads += 1;
            if (runReads === 3) strike?.();
            return statement.get(...p);
          },
        };
      },
      close: () => real.close(),
      get isTransaction() {
        return real.isTransaction;
      },
    });
    const handle = await openHome(
      { home, clock: testClock(T).clock },
      { openFile: (path) => striking(openDatabase(path)) },
    );
    handles.push(handle);
    const { runStore } = handle;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await runStore.create(BARE)).record.id);
    const hostile = await openForeignConnection(home);
    strike = () => {
      // A whole-store write on another connection: every run's version goes up by one.
      hostile.exec(
        "UPDATE runs SET record = json_set(record, '$.version', json_extract(record, '$.version') + 1)",
      );
    };
    runReads = 0;
    const listed = await runStore.list();
    strike = undefined;
    const versions = (snapshots: readonly Snapshot[]): number[] =>
      snapshots.map((s) => s.record.version);
    const after = await Promise.all(ids.map((id) => runStore.get(id)));
    hostile.close();
    // (1) red when the list reads each run in a snapshot of its own (the last runs then show the
    //     write): the flag `consistent_snapshot` is a literal, so only the versions show it; also
    //     red when the foreign write did not land (`after` stays 0), so the cell cannot pass by
    //     striking nothing; (2) prints the versions the list saw and the versions read afterwards.
    expect({
      listed: versions(listed.snapshots),
      after: versions(after),
      consistent: listed.consistent_snapshot,
    }).toEqual({
      listed: [0, 0, 0, 0, 0, 0],
      after: [1, 1, 1, 1, 1, 1],
      consistent: true,
    });
  });

  it('review of #1003 — a stored run that cannot be read back makes get and list throw, naming it; no run is skipped, and the other workflows still list', async () => {
    const home = join(tmp(), '.realm');
    const handle = await openRealmHome({ home, clock: testClock(T).clock });
    handles.push(handle);
    const { runStore } = handle;
    const good = await runStore.create(BARE);
    const other = await runStore.create({ ...BARE, workflowId: 'other' });
    // A third run with three evidence entries, put by a foreign connection, then one entry row
    // deleted behind the store's back (its guard dropped first), as the unit 10 cell does.
    const hostile = await openForeignConnection(home);
    const broken = {
      ...good.record,
      id: 'broken-run',
      evidence: [0, 1, 2].map((n): EvidenceSnapshot => ({
        step_id: `step_${n}`,
        started_at: '2030-05-06T07:08:09.000Z',
        completed_at: '2030-05-06T07:08:10.000Z',
        duration_ms: 1000,
        input_summary: { n },
        output_summary: {},
        status: 'success',
        evidence_hash: 'ab'.repeat(32),
        diagnostics: { input_token_estimate: 1, precondition_trace: [] },
        resolved_params: {},
        effective_timeout_seconds: 300,
        attempt: 1,
      })),
    };
    hostile.exec('BEGIN IMMEDIATE');
    insertRunRecord(hostile, broken);
    hostile.exec('COMMIT');
    hostile.exec('DROP TRIGGER evidence_delete_after_run');
    hostile.prepare('DELETE FROM evidence WHERE run_id = ? AND seq = 2').run('broken-run');
    hostile.close();
    const message = (err: unknown): string => (err as Error).message;
    const failure = (call: () => Promise<unknown>): Promise<string> =>
      call().then(() => 'no error', message);
    // (1) red when `list` leaves out a run it cannot read (it then resolves, with the other runs)
    //     or `get` returns a record short of an entry; (2) prints each call's outcome.
    expect({
      get: await failure(() => runStore.get('broken-run')),
      list: await failure(() => runStore.list()),
      sameWorkflow: await failure(() => runStore.list('triage')),
      otherWorkflow: (await runStore.list('other')).snapshots.map((s) => s.record.id),
      healthy: (await runStore.get(good.record.id)).record.id === good.record.id,
    }).toEqual({
      get: 'The stored run broken-run cannot be read back: its record holds 3 evidence entries and the store has 2 evidence rows.',
      list: 'The stored run broken-run cannot be read back: its record holds 3 evidence entries and the store has 2 evidence rows.',
      sameWorkflow:
        'The stored run broken-run cannot be read back: its record holds 3 evidence entries and the store has 2 evidence rows.',
      otherWorkflow: [other.record.id],
      healthy: true,
    });
  });
});
