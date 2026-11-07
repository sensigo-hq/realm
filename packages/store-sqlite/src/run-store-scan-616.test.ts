// run-store-scan-616.test.ts — issue #616 PR-2c unit c3: the SQLite run store's paged read (`scan`),
// its tombstone horizon (`tombstonesSince`) and the key's three-way answer (`resolveKey`), on real
// homes in a temp directory. The real cases: `realm run list` paging a store another process writes to;
// caching 3-M's read of one workflow's recently updated runs as rows (DELTAS row 22); the listings of
// recently created runs, of finished or live runs, of runs in one phase (before and after a
// derivation change, L-PHASE), of one key's runs, and of runs beside their tombstones; the plans of
// every offered filter (L-READ-COLD); a caller asking for a page with no bound (DELTAS row 33); and a
// late answerer told who holds a key (axis 7).
//
// Runs with chosen ids are put by a second connection (`insertRunRecord` inside `BEGIN IMMEDIATE`, as
// `run-store-616.test.ts` does). Each assertion carries (a) the break that turns it red and (b) what it
// prints when it fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runPhaseDerivationFingerprint,
  type Clock,
  type CreateRunOptions,
  type RunPhase,
  type RunRecord,
  type RunRow,
  type ScanFilter,
  type ScanItem,
  type ScanPage,
  type Snapshot,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseLike } from './driver.js';
import type { OpenSeams } from './open-file.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { insertRunRecord, KEY_ROWS } from './run-rows.js';
import { KEY_TOMBSTONES, scanWalks, STAMP_PROBE } from './run-scan.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

/** The instant the cells' clocks start at: the store's creation reading, so its tombstone horizon. */
const T = '2030-05-06T07:08:09.000Z';
const at = (offsetMs: number): string => new Date(Date.parse(T) + offsetMs).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WF = 'support-reply';
const OTHER = 'triage';
const KEY = 'ticket-42';

const dirs: string[] = [];
const handles: RealmHome[] = [];
const connections: DatabaseLike[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) {
    try {
      if (c.isTransaction) c.exec('ROLLBACK');
      c.close();
    } catch {
      // closed by its cell
    }
  }
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-c3-'));
  dirs.push(dir);
  return dir;
}

/** A test clock: it answers the instant it is set to. */
function testClock(start: string): { clock: Clock; set(iso: string): void } {
  let now = Date.parse(start);
  return {
    clock: { now: () => new Date(now), at: () => () => undefined },
    set: (iso) => {
      now = Date.parse(iso);
    },
  };
}

interface Home {
  readonly handle: RealmHome;
  readonly path: string;
}

/** Opens a fresh home on `clock` (through the open's seams when given); the cleanup closes it. */
async function open(clock: Clock = testClock(T).clock, seams: OpenSeams = {}): Promise<Home> {
  const path = join(tmp(), '.realm');
  const handle = await openHome({ home: path, clock }, seams);
  handles.push(handle);
  return { handle, path };
}

/** A second connection on the home's file; the cleanup closes it. */
async function foreign(home: Home): Promise<DatabaseLike> {
  const c = await openForeignConnection(home.path);
  connections.push(c);
  return c;
}

/** A live run record of `workflow` as another program would store it, created and updated a day before T. */
function record(id: string, workflow: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    workflow_id: workflow,
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 0,
    params: {},
    evidence: [],
    created_at: at(-DAY),
    updated_at: at(-DAY),
    terminal_state: false,
    ...over,
  };
}

/** A finished run (completed), as `record`. */
function finished(id: string, workflow: string, over: Partial<RunRecord> = {}): RunRecord {
  return record(id, workflow, {
    run_phase: 'completed',
    terminal_state: true,
    sealed_by: { arm: 'complete' },
    ...over,
  });
}

/** Writes `records` on connection `c`, in one transaction of its own. */
function put(c: DatabaseLike, ...records: RunRecord[]): void {
  c.exec('BEGIN IMMEDIATE');
  for (const r of records) insertRunRecord(c, r);
  c.exec('COMMIT');
}

/**
 * Deletes the finished run `runId` on connection `c`, as a purge does: the deleting write's instant set
 * in `write_clock` first and cleared after, so the tombstone's `purged_at` is `purgedAt`.
 */
function purge(c: DatabaseLike, runId: string, purgedAt: string): void {
  c.exec('BEGIN IMMEDIATE');
  c.prepare(
    'INSERT INTO write_clock (one, at) VALUES (1, ?) ON CONFLICT (one) DO UPDATE SET at = excluded.at',
  ).run(purgedAt);
  c.prepare('DELETE FROM runs WHERE id = ?').run(runId);
  c.exec('UPDATE write_clock SET at = NULL WHERE one = 1');
  c.exec('COMMIT');
}

/** Restamps run `runId`'s phase index on connection `c`, as another derivation's writer would. */
function restamp(c: DatabaseLike, runId: string, phase: RunPhase, stamp: string): void {
  c.prepare('UPDATE runs SET run_phase = ?, phase_version = ? WHERE id = ?').run(
    phase,
    stamp,
    runId,
  );
}

/**
 * Every page of `scan`, running `between(n)` after page n and before the next is asked for. A scan
 * that does not end (a cursor that does not move) is cut at 20 pages, so its cell fails, not hangs.
 */
async function collect<P extends 'record' | 'row'>(
  scan: AsyncGenerator<ScanPage<P>, void, undefined>,
  between: (pageNumber: number) => void = () => undefined,
): Promise<ScanPage<P>[]> {
  const pages: ScanPage<P>[] = [];
  for (let n = 1; n <= 20; n++) {
    const next = await scan.next();
    if (next.done === true) return pages;
    pages.push(next.value);
    between(n);
  }
  return pages;
}

/** An item's id as a cell prints it: a run's id, or `purged <id>` for a tombstone. */
function idOf(item: ScanItem<'record'> | ScanItem<'row'>): string {
  if (item.kind === 'purged') return `purged ${item.run_id}`;
  const run: Snapshot | RunRow = item.run;
  return 'record' in run ? run.record.id : run.id;
}

/** The ids of every page. */
const idsOf = (pages: ReadonlyArray<ScanPage<'record'> | ScanPage<'row'>>): string[][] =>
  pages.map((page) => page.items.map(idOf));

/** How a scan's `next()` ends: `'no error'`, or the error's message. */
async function refusal(scan: AsyncGenerator<unknown, void, undefined>): Promise<string> {
  return scan.next().then(
    () => 'no error',
    (err: unknown) => (err as Error).message,
  );
}

/** A create with nothing optional. */
const BARE: CreateRunOptions = {
  workflowId: WF,
  workflowVersion: 1,
  params: {},
  extensionIdentity: [],
};

describe('#616 PR-2c c3 — scan pages every run once, each page its own snapshot', () => {
  it('check 1: `realm run list` over a store another process writes to: every run of the workflow once, ascending, across pages; a run put above the cursor shows on a later page, one put below it never', async () => {
    const home = await open();
    const c = await foreign(home);
    put(
      c,
      record('r-10', WF),
      record('r-15', OTHER),
      record('r-20', WF),
      record('r-30', WF),
      record('r-35', OTHER),
      record('r-40', WF),
      record('r-50', WF),
    );
    const pages = await collect(
      home.handle.runStore.scan({ workflow: WF }, { pageSize: 3 }),
      (n) => {
        if (n === 1) put(c, record('r-25', WF), record('r-45', WF));
      },
    );
    // (a) red when the cursor is applied with `>=` (page 2 repeats r-30) or is not moved (page 1
    //     repeats until the cut), or the workflow is not tested; (b) prints the ids per page and
    //     each page's cursor.
    expect({
      ids: idsOf(pages),
      cursors: pages.map((page) => page.next_after ?? null),
    }).toEqual({
      ids: [['r-10', 'r-20', 'r-30'], ['r-40', 'r-45', 'r-50'], []],
      cursors: ['r-30', 'r-50', null],
    });
  });

  it("check 2 (i): each page is read at its own reading: a clock that steps between pages stamps each page's read_at, and each run is judged at its page's reading", async () => {
    const clock = testClock(T);
    const home = await open(clock.clock);
    const first = await home.handle.runStore.create(BARE);
    const second = await home.handle.runStore.create(BARE);
    let step = 0;
    const pages = await collect(home.handle.runStore.scan({}, { pageSize: 1 }), () => {
      step += 1;
      clock.set(at(step * 1000));
    });
    const [low, high] = [first.record.id, second.record.id].sort();
    // (a) red when a scan takes one reading for all its pages, or a run is judged at another
    //     reading than its page's; (b) prints each page's read_at and its runs' `at`.
    expect({
      readAt: pages.map((page) => page.read_at.toISOString()),
      runAt: pages.map((page) =>
        page.items.map((item) => (item.kind === 'run' ? item.run.at.toISOString() : null)),
      ),
      ids: idsOf(pages),
    }).toEqual({
      readAt: [T, at(1000), at(2000)],
      runAt: [[T], [at(1000)], []],
      ids: [[low], [high], []],
    });
  });

  it('check 2 (ii): a page is ONE snapshot: a write that lands between two of its record reads shows in none of them', async () => {
    const path = join(tmp(), '.realm');
    let recordReads = 0;
    let strike: (() => void) | undefined;
    // Passes everything on; on the third read of a run's record it first runs `strike`.
    const striking = (real: DatabaseLike): DatabaseLike => ({
      exec: (sql) => real.exec(sql),
      prepare: (sql) => {
        const statement = real.prepare(sql);
        if (sql !== 'SELECT record FROM runs WHERE id = ?') return statement;
        return {
          run: (...p) => statement.run(...p),
          all: (...p) => statement.all(...p),
          get: (...p) => {
            recordReads += 1;
            if (recordReads === 3) strike?.();
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
      { home: path, clock: testClock(T).clock },
      { openFile: (file) => striking(openDatabase(file)) },
    );
    handles.push(handle);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await handle.runStore.create(BARE)).record.id);
    const hostile = await foreign({ handle, path });
    strike = () => {
      // A committed whole-store write on another connection: every run's version goes up by one.
      hostile.exec(
        "UPDATE runs SET record = json_set(record, '$.version', json_extract(record, '$.version') + 1)",
      );
    };
    recordReads = 0;
    const [page] = await collect(handle.runStore.scan({}, { pageSize: 6 }));
    strike = undefined;
    const after = await Promise.all(ids.map((id) => handle.runStore.get(id)));
    // (a) red when a page reads its records in transactions of their own (the last ones then show
    //     the write), and when the strike did not land (`after` stays 0), so the cell cannot pass
    //     by striking nothing; (b) prints the versions the page read and the versions read after.
    expect({
      page: page!.items.map((item) => (item.kind === 'run' ? item.run.record.version : null)),
      after: after.map((s) => s.record.version),
      consistent: page!.consistent_snapshot,
    }).toEqual({
      page: [0, 0, 0, 0, 0, 0],
      after: [1, 1, 1, 1, 1, 1],
      consistent: true,
    });
  });
});

describe('#616 PR-2c c3 — the filters', () => {
  it("check 3: caching 3-M's read — one workflow's runs updated in the last seven days, as rows: each row's fourteen fields as typed, no params, no evidence", async () => {
    const home = await open();
    const c = await foreign(home);
    const gate = {
      gate_id: 'gate-1',
      step_name: 'review',
      preview: {},
      choices: ['approve', 'reject'],
      opened_at: at(-DAY),
    };
    put(
      c,
      // Created a month ago, updated yesterday: in by its update, out by its creation.
      record('u-1', WF, {
        created_at: at(-30 * DAY),
        idempotency_key: 'ticket-7',
        completed_steps: ['fetch'],
        in_progress_steps: ['draft'],
        pending_gate: gate,
        params: { ticket: 'T-7' },
      }),
      // Updated ten days ago: out.
      record('u-2', WF, { created_at: at(-30 * DAY), updated_at: at(-10 * DAY) }),
      // Finished two days ago, a rerun of u-2: in.
      finished('u-3', WF, {
        created_at: at(-2 * DAY),
        updated_at: at(-2 * DAY),
        rerun_of: 'u-2',
        completed_steps: ['fetch', 'draft'],
        failed_steps: ['notify'],
      }),
      // Another workflow's run, updated yesterday: out by its workflow.
      record('u-4', OTHER),
    );
    const pages = await collect(
      home.handle.runStore.scan(
        { workflow: WF, updated_since: at(-7 * DAY) },
        { pageSize: 10, projection: 'row' },
      ),
    );
    // (a) red when the range is tested on `created_at` (u-1 drops) or not at all (u-2 joins), the
    //     workflow is not tested (u-4 joins), or a row carries a field it should not or misses one;
    //     (b) prints the rows.
    expect(pages.map((page) => page.items)).toEqual([
      [
        {
          kind: 'run',
          run: {
            id: 'u-1',
            workflow_id: WF,
            run_phase: 'gate_waiting',
            terminal_state: false,
            sealed_by_arm: null,
            created_at: at(-30 * DAY),
            updated_at: at(-DAY),
            idempotency_key: 'ticket-7',
            rerun_of: null,
            run_version: 0,
            pending_gate: 'gate-1',
            completed_steps: ['fetch'],
            in_progress_steps: ['draft'],
            failed_steps: [],
          },
        },
        {
          kind: 'run',
          run: {
            id: 'u-3',
            workflow_id: WF,
            run_phase: 'completed',
            terminal_state: true,
            sealed_by_arm: 'complete',
            created_at: at(-2 * DAY),
            updated_at: at(-2 * DAY),
            idempotency_key: null,
            rerun_of: 'u-2',
            run_version: 0,
            pending_gate: null,
            completed_steps: ['fetch', 'draft'],
            in_progress_steps: [],
            failed_steps: ['notify'],
          },
        },
      ],
    ]);
  });

  it('check 3: the runs created in the last seven days, of every workflow: a run created at the bound itself is in', async () => {
    const home = await open();
    const c = await foreign(home);
    put(
      c,
      // Created a month ago and updated yesterday: out by its creation.
      record('c-1', WF, { created_at: at(-30 * DAY) }),
      record('c-2', WF, { created_at: at(-2 * DAY), updated_at: at(-2 * DAY) }),
      record('c-3', OTHER),
      record('c-4', OTHER, { created_at: at(-7 * DAY), updated_at: at(-7 * DAY) }),
      record('c-5', WF, { created_at: at(-8 * DAY), updated_at: at(-8 * DAY) }),
    );
    const pages = await collect(
      home.handle.runStore.scan({ created_since: at(-7 * DAY) }, { pageSize: 10 }),
    );
    // (a) red when the range is tested on `updated_at` (c-1 joins), not at all (c-1 and c-5 join),
    //     or exclusively (c-4 drops); (b) prints the ids.
    expect(idsOf(pages)).toEqual([['c-2', 'c-3', 'c-4']]);
  });

  it('check 3: the finished runs, and the live ones', async () => {
    const home = await open();
    const c = await foreign(home);
    put(c, record('e-1', WF), finished('e-2', WF), record('e-3', OTHER), finished('e-4', OTHER));
    const scan = (terminal: boolean) =>
      collect(home.handle.runStore.scan({ terminal }, { pageSize: 10 }));
    // (a) red when the terminal state is not tested (every run listed both times) or tested
    //     against the other value; (b) prints the ids of each listing.
    expect({ finished: idsOf(await scan(true)), live: idsOf(await scan(false)) }).toEqual({
      finished: [['e-2', 'e-4']],
      live: [['e-1', 'e-3']],
    });
  });

  it("check 3: one phase's runs, first from the phase index alone, then with a row another derivation stamped: that row is derived at read, matched by its derived phase or not, and counted", async () => {
    const home = await open();
    const c = await foreign(home);
    put(
      c,
      record('f-1', WF),
      finished('f-2', WF),
      finished('f-3', WF),
      finished('f-4', WF, { run_phase: 'failed', sealed_by: { arm: 'spawn_failure' } }),
    );
    const scan = async (phase: RunPhase) => {
      const pages = await collect(home.handle.runStore.scan({ phase }, { pageSize: 10 }));
      return { ids: idsOf(pages), derived: pages.map((page) => page.derived_at_read) };
    };
    const trusted = await scan('completed');
    c.prepare("UPDATE runs SET phase_version = 'other' WHERE id = ?").run('f-3');
    const stale = { completed: await scan('completed'), running: await scan('running') };
    // (a) red when the phase is not tested (every run listed), when a row stamped by another
    //     derivation is left out or listed twice, or when it is not counted on a listing it does
    //     not match; (b) prints each listing's ids and its count of rows derived at read.
    expect({ trusted, stale }).toEqual({
      trusted: { ids: [['f-2', 'f-3']], derived: [0] },
      stale: {
        completed: { ids: [['f-2', 'f-3']], derived: [1] },
        running: { ids: [['f-1']], derived: [1] },
      },
    });
  });

  it("check 3: caching 3-M's rows after a derivation change: a row another derivation stamped carries its derived phase, never its stamp's, and is counted", async () => {
    const home = await open();
    const c = await foreign(home);
    put(c, finished('s-1', WF), record('s-2', WF));
    // s-1 finished completed; another derivation's writer stamped it running.
    restamp(c, 's-1', 'running', 'other');
    const pages = await collect(
      home.handle.runStore.scan({ workflow: WF }, { pageSize: 10, projection: 'row' }),
    );
    // (a) red when a row's phase is read from a stamp another derivation made (s-1 reads
    //     running), or that row is not counted; (b) prints each row's phase and the count.
    expect({
      phases: pages.map((page) =>
        page.items.map((item) => (item.kind === 'run' ? [item.run.id, item.run.run_phase] : null)),
      ),
      derived: pages.map((page) => page.derived_at_read),
    }).toEqual({
      phases: [
        [
          ['s-1', 'completed'],
          ['s-2', 'running'],
        ],
      ],
      derived: [1],
    });
  });

  it("check 3: one key's runs — every run carrying it, the holder and the finished run it superseded — and a key with no workflow is refused, naming `workflow`", async () => {
    const home = await open();
    const c = await foreign(home);
    put(
      c,
      finished('k-a', WF, { idempotency_key: KEY }),
      record('k-b', WF, { idempotency_key: KEY, rerun_of: 'k-a' }),
      record('k-c', WF),
      record('k-d', WF, { idempotency_key: 'ticket-43' }),
      record('k-e', OTHER, { idempotency_key: KEY }),
    );
    const keyed = { workflow: WF, key: KEY };
    const pages = await collect(home.handle.runStore.scan(keyed, { pageSize: 10 }));
    // The key's runs one per page, and resumed after a cursor: the key walk reads every row of the
    // key and cuts them at the cursor in the store (correction 1, MA 1).
    const paged = await collect(home.handle.runStore.scan(keyed, { pageSize: 1 }));
    const resumed = await collect(home.handle.runStore.scan(keyed, { pageSize: 10, after: 'k-a' }));
    const cursorsOf = (scanned: ReadonlyArray<ScanPage<'record'>>): Array<string | null> =>
      scanned.map((page) => page.next_after ?? null);
    // (a) red when the key's hash is not tested (k-c and k-d join), when only the holder is listed
    //     (k-a drops), when a key alone is not refused, when the key walk's cut keeps the cursor's
    //     own id (`>=`: page 2 repeats k-a) or ignores the cursor (k-a returns after 'k-a');
    //     (b) prints the ids per page and the cursors of each scan, the holder and the refusal.
    expect({
      ids: idsOf(pages),
      paged: { ids: idsOf(paged), cursors: cursorsOf(paged) },
      resumed: { ids: idsOf(resumed), cursors: cursorsOf(resumed) },
      holder: await home.handle.runStore.resolveKey(WF, KEY),
      alone: await refusal(home.handle.runStore.scan({ key: KEY }, { pageSize: 10 })),
    }).toEqual({
      ids: [['k-a', 'k-b']],
      paged: { ids: [['k-a'], ['k-b'], []], cursors: ['k-a', 'k-b', null] },
      resumed: { ids: [['k-b']], cursors: [null] },
      holder: { state: 'held', run_id: 'k-b' },
      alone:
        "A scan's key filter needs a workflow: an idempotency key belongs to one workflow, so give `workflow` with `key`.",
    });
  });

  it("check 3: a workflow's runs beside their tombstones: a deleted run's tombstone comes in id order, counts toward the page, and carries its detail; another workflow's tombstone does not", async () => {
    const home = await open();
    const c = await foreign(home);
    put(
      c,
      record('p-1', WF),
      finished('p-2', WF),
      record('p-3', WF),
      record('p-4', WF),
      finished('p-5', OTHER),
    );
    purge(c, 'p-2', at(HOUR));
    purge(c, 'p-5', at(HOUR));
    const pages = await collect(
      home.handle.runStore.scan({ workflow: WF, include_purged: true }, { pageSize: 2 }),
    );
    // (a) red when tombstones are not walked, are walked without the workflow (p-5 joins), do not
    //     count toward the page (page 1 holds three items), or lose a field; (b) prints the ids per
    //     page, the tombstone and the horizon.
    expect({
      ids: idsOf(pages),
      tombstone: pages[0]?.items[1],
      horizon: await home.handle.runStore.tombstonesSince(),
    }).toEqual({
      ids: [['p-1', 'purged p-2'], ['p-3', 'p-4'], []],
      tombstone: {
        kind: 'purged',
        run_id: 'p-2',
        workflow_id: WF,
        purged_at: at(HOUR),
        sealed_by_arm: 'complete',
        run_phase: 'completed',
        phase_version: runPhaseDerivationFingerprint(),
      },
      horizon: T,
    });
  });
});

/** The plan SQLite makes for `sql` on connection `db`, one line per step. */
function plan(db: DatabaseLike, sql: string): string[] {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => String(row['detail']));
}

/** The statements a page of `filter` runs, with one stale stamp found. */
const walksOf = (filter: ScanFilter): string[] =>
  scanWalks(filter, runPhaseDerivationFingerprint(), ['another-derivation']).map((w) => w.sql);

/** L-READ-COLD's offered filters and combinations: each statement the store runs, and its plan. */
const COLD: ReadonlyArray<{ name: string; sql: () => string; plan: string }> = [
  {
    name: 'no filter',
    sql: () => walksOf({})[0]!,
    plan: 'SEARCH runs USING INDEX sqlite_autoindex_runs_1 (id>?)',
  },
  {
    name: 'workflow',
    sql: () => walksOf({ workflow: WF })[0]!,
    plan: 'SEARCH runs USING INDEX runs_by_workflow_updated (workflow_id=? AND id>?)',
  },
  {
    name: 'workflow + updated_since',
    sql: () => walksOf({ workflow: WF, updated_since: T })[0]!,
    plan: 'SEARCH runs USING INDEX runs_by_workflow_updated (workflow_id=? AND id>?)',
  },
  {
    name: 'workflow + created_since',
    sql: () => walksOf({ workflow: WF, created_since: T })[0]!,
    plan: 'SEARCH runs USING INDEX runs_by_workflow_created (workflow_id=? AND id>?)',
  },
  {
    name: 'updated_since',
    sql: () => walksOf({ updated_since: T })[0]!,
    plan: 'SEARCH runs USING INDEX runs_by_updated (id>?)',
  },
  {
    name: 'created_since',
    sql: () => walksOf({ created_since: T })[0]!,
    plan: 'SEARCH runs USING INDEX runs_by_created (id>?)',
  },
  {
    name: 'terminal',
    sql: () => walksOf({ terminal: true })[0]!,
    plan: 'SEARCH runs USING INDEX runs_by_terminal (terminal_state=? AND id>?)',
  },
  {
    name: "phase's trusted walk",
    sql: () => walksOf({ phase: 'completed' })[0]!,
    plan: 'SEARCH runs USING INDEX runs_by_phase (phase_version=? AND run_phase=? AND id>?)',
  },
  {
    name: "phase's stamp probe",
    sql: () => STAMP_PROBE,
    plan: 'SEARCH runs USING COVERING INDEX runs_by_phase_version (phase_version>?)',
  },
  {
    name: "phase's stale sub-walk",
    sql: () => walksOf({ phase: 'completed' })[1]!,
    plan: 'SEARCH runs USING INDEX runs_by_phase_version (phase_version=? AND id>?)',
  },
  {
    name: 'key + workflow',
    sql: () => walksOf({ workflow: WF, key: KEY })[0]!,
    plan: 'SEARCH runs USING INDEX runs_by_key (workflow_id=? AND key_hash=?)',
  },
  {
    name: 'the tombstone walk',
    sql: () => walksOf({ include_purged: true })[1]!,
    plan: 'SEARCH purged_runs USING INDEX sqlite_autoindex_purged_runs_1 (id>?)',
  },
  {
    name: 'the tombstone walk of a workflow',
    sql: () => walksOf({ workflow: WF, include_purged: true })[1]!,
    plan: 'SEARCH purged_runs USING INDEX sqlite_autoindex_purged_runs_1 (id>?)',
  },
  {
    name: 'the tombstone walk of a key',
    sql: () => walksOf({ workflow: WF, key: KEY, include_purged: true })[1]!,
    plan: 'SEARCH purged_runs USING INDEX purged_runs_by_key (workflow_id=? AND key_hash=? AND id>?)',
  },
  {
    name: "resolveKey's holder probe",
    sql: () => KEY_ROWS,
    plan: 'SEARCH runs USING INDEX runs_by_key (workflow_id=? AND key_hash=?)',
  },
  {
    name: "resolveKey's tombstone probe",
    sql: () => KEY_TOMBSTONES,
    plan: 'SEARCH purged_runs USING COVERING INDEX purged_runs_by_key (workflow_id=? AND key_hash=?)',
  },
];

describe('#616 PR-2c c3 — L-READ-COLD: every offered filter walks its index, with no sort', () => {
  it.each(COLD)('check 4: $name', async ({ sql, plan: expected }) => {
    // The plan is read on the store's own connection, caught through the open's seam.
    let connection: DatabaseLike | undefined;
    const home = await open(testClock(T).clock, {
      openFile: (file) => (connection = openDatabase(file)),
    });
    await home.handle.runStore.create(BARE);
    // (a) red when the statement names another index, or none (the planner's own pick), or sorts in
    //     a TEMP B-TREE; after the index is dropped on another connection and one read goes through
    //     the store, a hinted statement throws "no such index"; (b) prints the plan.
    expect(plan(connection!, sql())).toEqual([expected]);
  });
});

describe('#616 PR-2c c3 — L-PHASE', () => {
  it('check 5: a phase listing over three stale stamps and the current one, paged two at a time while another connection re-stamps a row between pages: every matching run once, in id order, no walk sorting', async () => {
    let connection: DatabaseLike | undefined;
    const home = await open(testClock(T).clock, {
      openFile: (file) => (connection = openDatabase(file)),
    });
    const c = await foreign(home);
    put(
      c,
      // Stamp a: two live runs whose stale stamp says completed, then a completed one whose stale
      // stamp says running: a page's worth of rows that do not match, below one that does.
      record('a-1', WF),
      record('a-2', WF),
      finished('a-3', WF),
      // Stamp b: a completed run.
      finished('b-4', WF),
      // Stamp c: a failed run.
      finished('c-8', WF, { run_phase: 'failed', sealed_by: { arm: 'spawn_failure' } }),
      // The current stamp: three completed runs and a live one.
      finished('t-5', WF),
      finished('t-6', WF),
      finished('t-7', WF),
      record('t-9', WF),
    );
    restamp(c, 'a-1', 'completed', 'stamp-a');
    restamp(c, 'a-2', 'completed', 'stamp-a');
    restamp(c, 'a-3', 'running', 'stamp-a');
    restamp(c, 'b-4', 'completed', 'stamp-b');
    restamp(c, 'c-8', 'failed', 'stamp-c');
    const stampsSeen: unknown[][] = [];
    const pages = await collect(
      home.handle.runStore.scan({ phase: 'completed' }, { pageSize: 2 }),
      (n) => {
        // Between pages 1 and 2: t-6 moves to a fourth stale stamp that says running.
        if (n === 1) restamp(c, 't-6', 'running', 'stamp-d');
        stampsSeen.push(
          c
            .prepare('SELECT DISTINCT phase_version FROM runs ORDER BY phase_version')
            .all()
            .map((row) => row['phase_version']),
        );
      },
    );
    const plans = scanWalks({ phase: 'completed' }, runPhaseDerivationFingerprint(), [
      'stamp-a',
      'stamp-b',
      'stamp-c',
      'stamp-d',
    ]).map((walk) => plan(connection!, walk.sql));
    // (a) red when the stale rows are one `phase_version != ?` walk (its plan sorts in a TEMP
    //     B-TREE), when a stale walk stops at one page size of reads (a-3 is skipped, or the scan
    //     ends early), or when a stale row is served from its stamp (a-1 and a-2 join, a-3 and t-6
    //     drop); (b) prints the ids per page, the stamps after each page and every walk's plan.
    expect({
      ids: idsOf(pages),
      plans: plans.flat().filter((line) => line.includes('TEMP B-TREE')),
      stamps: stampsSeen.map((stamps) => stamps.length),
    }).toEqual({
      ids: [['a-3', 'b-4'], ['t-5', 't-6'], ['t-7']],
      plans: [],
      stamps: [5, 5, 5],
    });
  });
});

describe('#616 PR-2c c3 — the page size has a maximum', () => {
  it('check 6: a page size above 1,000, below 1 or not whole is refused before any read, naming the maximum; 1,000 is served', async () => {
    const home = await open();
    await home.handle.runStore.create(BARE);
    const scanOf = (pageSize: number) => home.handle.runStore.scan({}, { pageSize });
    const refused = (pageSize: number) =>
      `A scan's page size must be a whole number from 1 to 1000; it was ${pageSize}.`;
    // (a) red when the bound is missing (1001 is served), off by one (1000 refused), or a
    //     fraction reaches SQLite (its "datatype mismatch" in place of the sentence); (b) prints
    //     each call's outcome.
    expect({
      above: await refusal(scanOf(1001)),
      zero: await refusal(scanOf(0)),
      fraction: await refusal(scanOf(1.5)),
      most: await refusal(scanOf(1000)),
    }).toEqual({
      above: refused(1001),
      zero: refused(0),
      fraction: refused(1.5),
      most: 'no error',
    });
  });
});

describe('#616 PR-2c c3 — resolveKey', () => {
  it("check 7: a late answerer is told who holds a key: the rerun that superseded a finished run; a lone run's tombstone, with its time and the horizon; or nothing seen since the horizon", async () => {
    const home = await open();
    const c = await foreign(home);
    put(
      c,
      finished('h-1', WF, { idempotency_key: KEY }),
      finished('h-2', WF, { idempotency_key: KEY, rerun_of: 'h-1', created_at: at(-HOUR) }),
      finished('g-1', WF, { idempotency_key: 'ticket-purged' }),
    );
    purge(c, 'g-1', at(HOUR));
    const store = home.handle.runStore;
    // (a) red when the purged answer is read from the id-only record (no `purged_at`, no key) or
    //     the tombstones are not read (`unseen`), when the unseen answer misses its horizon, or when
    //     the held answer is not the derived holder; (b) prints each answer.
    expect({
      held: await store.resolveKey(WF, KEY),
      purged: await store.resolveKey(WF, 'ticket-purged'),
      unseen: await store.resolveKey(WF, 'ticket-never'),
    }).toEqual({
      held: { state: 'held', run_id: 'h-2' },
      purged: { state: 'purged', runs: [{ run_id: 'g-1', purged_at: at(HOUR) }], since: T },
      unseen: { state: 'unseen', since: T },
    });
  });
});
