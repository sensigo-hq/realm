// run-store-keyed-616.test.ts — issue #616 PR-1a unit 15a: the run store's KEYED create, on real
// homes in a temp directory. The real cases: MCP `start_run` and `start_run_batch` creating with an
// idempotency key and every policy; `realm listen` creating with a webhook's dedup id as the key
// under the default policies; eight processes starting one keyed run at once; a holder stamped ahead
// of a clock that then stepped back; a COMMIT that fails after SQLite rolled the write back.
//
// Finished holders, and several runs under one key, are written the way another program would write
// them: through a second connection on the home's file (`openForeignConnection`) and the store's own
// row writer, in that connection's own transaction (`runs` has no seal trigger on insert).
//
// These cells stand in for the keyed rows of core's shared clock laws until unit 16 wires the
// contract (`packages/testing/src/store/store-clock-contract.ts`): `KEYED_FIRST_CREATE_ONE_READING`,
// `WRITE_ONE_READING`'s keyed rows, `KEYED_CREATE_ORDERS_AFTER_HOLDER` and `KEYED_CREATE_FLOOR_CAPPED`.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  JsonFileStore,
  WorkflowError,
  type Clock,
  type CreateRunOptions,
  type ExtensionIdentityEntry,
  type RunRecord,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import type { WithCommitOutcome } from './connection.js';
import { openDatabase, type DatabaseLike } from './driver.js';
import { DATABASE_FILE } from './home.js';
import type { OpenSeams } from './open-file.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { findKeyHolder, insertRunRecord } from './run-rows.js';
import { faultyFiles, SQLITE } from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The instant the cells' clocks start at, and the stamps around it. */
const T = '2030-05-06T07:08:09.000Z';
const at = (offsetMs: number): string => new Date(Date.parse(T) + offsetMs).toISOString();
const HOUR = 3_600_000;
/** Core's clock skew tolerance, ε (`CLOCK_SKEW_EPSILON_MS`). */
const EPS = 5_000;

const WF = 'support-reply';
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
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u15a-'));
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

interface Home {
  readonly handle: RealmHome;
  readonly path: string;
}

/** Opens a fresh home on `clock` (through the open's seams when given); the cleanup closes it. */
async function open(clock: Clock, seams: OpenSeams = {}): Promise<Home> {
  const path = join(tmp(), '.realm');
  const handle = await openHome({ home: path, clock }, seams);
  handles.push(handle);
  return { handle, path };
}

/** A run record as another program would store it under `KEY`, live unless `over` says otherwise. */
function record(id: string, createdAt: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    workflow_id: WF,
    workflow_version: 1,
    idempotency_key: KEY,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 0,
    params: {},
    evidence: [],
    created_at: createdAt,
    updated_at: createdAt,
    terminal_state: false,
    ...over,
  };
}

/** A finished run (completed, or failed when `failed`), as `record`. */
function finished(
  id: string,
  createdAt: string,
  over: Partial<RunRecord> = {},
  failed = false,
): RunRecord {
  return record(id, createdAt, {
    run_phase: failed ? 'failed' : 'completed',
    terminal_state: true,
    sealed_by: { arm: failed ? 'spawn_failure' : 'complete' },
    ...over,
  });
}

/** Writes `records` through a second connection on the home's file, in its own transaction. */
async function seed(home: Home, ...records: RunRecord[]): Promise<DatabaseLike> {
  const c = await openForeignConnection(home.path);
  connections.push(c);
  c.exec('BEGIN IMMEDIATE');
  for (const r of records) insertRunRecord(c, r);
  c.exec('COMMIT');
  return c;
}

/** A plain connection's view of the runs stored: each run's stored row, by id. */
function rows(home: Home): Array<Record<string, unknown>> {
  const c = openDatabase(join(home.path, DATABASE_FILE));
  try {
    return c.prepare('SELECT id, record, key_hash FROM runs ORDER BY id').all();
  } finally {
    c.close();
  }
}

/** A keyed create of `WF` under `KEY`, with `over`'s options. */
const keyed = (over: Partial<CreateRunOptions> = {}): CreateRunOptions => ({
  workflowId: WF,
  workflowVersion: 1,
  params: {},
  idempotencyKey: KEY,
  ...over,
});

/** A refusal as a reader sees it (store errors carry no credential). */
function refusal(err: unknown): Record<string, unknown> {
  if (!(err instanceof WorkflowError)) return { notWorkflowError: String(err) };
  return {
    code: err.code,
    message: err.message,
    agentAction: err.agentAction,
    retryable: err.retryable,
    details: err.details,
  };
}

/** What a create settled with: `created` and the run's id, or the refusal. */
async function outcome(
  store: RealmHome['runStore'],
  options: CreateRunOptions,
): Promise<Record<string, unknown>> {
  try {
    const r = await store.create(options);
    return { created: r.created, id: r.record.id, rerun_of: r.record.rerun_of };
  } catch (err) {
    return refusal(err);
  }
}

describe('#616 unit 15a — a keyed create, one cell per outcome of the policy', () => {
  it('check 1: a fresh key writes a run carrying the key and no rerun_of', async () => {
    const { handle } = await open(testClock(T).clock);
    const r = await handle.runStore.create(keyed());
    // (1) red when the key is left out of the run's record; (2) prints created, the key and whether
    //     rerun_of is there.
    expect({
      created: r.created,
      key: r.record.idempotency_key,
      hasRerunOf: 'rerun_of' in r.record,
    }).toEqual({ created: true, key: KEY, hasRerunOf: false });
  });

  it('check 1: use_existing on a running holder returns it, created: false', async () => {
    const { handle } = await open(testClock(T).clock);
    const first = await handle.runStore.create(keyed());
    // (1) red when the policy is skipped (a second run is written); (2) prints the second create.
    expect(await outcome(handle.runStore, keyed({ onLiveMatch: 'use_existing' }))).toEqual({
      created: false,
      id: first.record.id,
      rerun_of: undefined,
    });
  });

  it('check 1: fail on a running holder is refused STATE_RUN_ALREADY_ACTIVE, naming it', async () => {
    const { handle } = await open(testClock(T).clock);
    const first = await handle.runStore.create(keyed());
    // (1) red when the policy is skipped (a second run is written); (2) prints the refusal.
    expect(await outcome(handle.runStore, keyed({ onLiveMatch: 'fail' }))).toEqual({
      code: 'STATE_RUN_ALREADY_ACTIVE',
      message: `Idempotency key for workflow '${WF}' is owned by an active run '${first.record.id}' (phase 'running').`,
      agentAction: 'report_to_user',
      retryable: false,
      details: { existingRunId: first.record.id, run_phase: 'running' },
    });
  });

  it('check 1: the default on a finished holder reuses it', async () => {
    const home = await open(testClock(T).clock);
    await seed(home, finished('run-done', at(-HOUR)));
    // (1) red when the policy is skipped (a fresh run); (2) prints the create.
    expect(await outcome(home.handle.runStore, keyed())).toEqual({
      created: false,
      id: 'run-done',
      rerun_of: undefined,
    });
  });

  it('check 1: reject on a finished holder is refused STATE_IDEMPOTENCY_KEY_USED, naming it', async () => {
    const home = await open(testClock(T).clock);
    await seed(home, finished('run-done', at(-HOUR)));
    // (1) red when the policy is skipped (a fresh run); (2) prints the refusal.
    expect(await outcome(home.handle.runStore, keyed({ onTerminalMatch: 'reject' }))).toEqual({
      code: 'STATE_IDEMPOTENCY_KEY_USED',
      message: `Idempotency key for workflow '${WF}' was already used by run 'run-done' (terminal phase 'completed').`,
      agentAction: 'report_to_user',
      retryable: false,
      details: { existingRunId: 'run-done', run_phase: 'completed' },
    });
  });

  it("check 1: rerun on a finished holder writes a new run naming it in rerun_of; the old run's row is byte for byte unchanged", async () => {
    const home = await open(testClock(T).clock);
    await seed(home, finished('run-done', at(-HOUR)));
    const before = rows(home).find((r) => r['id'] === 'run-done');
    const created = await outcome(home.handle.runStore, keyed({ onTerminalMatch: 'rerun' }));
    // (1) red when the policy is skipped (a fresh run without rerun_of), or the old run is written;
    //     (2) prints the create and the old run's stored row against the row before.
    expect({
      created: created['created'],
      rerun_of: created['rerun_of'],
      old: rows(home).find((r) => r['id'] === 'run-done'),
    }).toEqual({ created: true, rerun_of: 'run-done', old: before });
  });

  it('check 1: rerun_if_failed on a failed holder writes a rerun', async () => {
    const home = await open(testClock(T).clock);
    await seed(home, finished('run-failed', at(-HOUR), {}, true));
    const created = await outcome(
      home.handle.runStore,
      keyed({ onTerminalMatch: 'rerun_if_failed' }),
    );
    // (1) red when the policy is skipped (a fresh run without rerun_of); (2) prints the create.
    expect({ created: created['created'], rerun_of: created['rerun_of'] }).toEqual({
      created: true,
      rerun_of: 'run-failed',
    });
  });

  it('check 1: the same key in another workflow is another key: a fresh run', async () => {
    const home = await open(testClock(T).clock);
    await seed(home, record('run-other', at(-HOUR), { workflow_id: 'other-workflow' }));
    const created = await outcome(home.handle.runStore, keyed());
    // (1) red when the key is scoped by neither its hash nor the lookup (the other workflow's run is
    //     reused); (2) prints the create.
    expect({ created: created['created'], same: created['id'] === 'run-other' }).toEqual({
      created: true,
      same: false,
    });
  });

  it('check 1: an empty key is a key: a second create with it reuses the first run', async () => {
    const { handle } = await open(testClock(T).clock);
    const first = await handle.runStore.create(keyed({ idempotencyKey: '' }));
    // (1) red when the policy is skipped, or an empty key is taken as no key (a second run); (2)
    //     prints the second create.
    expect(await outcome(handle.runStore, keyed({ idempotencyKey: '' }))).toEqual({
      created: false,
      id: first.record.id,
      rerun_of: undefined,
    });
  });
});

describe("#616 unit 15a — the key's holder is core's pick over the key's own rows", () => {
  it('check 2: one live run that is the OLDEST among finished ones holds the key', async () => {
    const home = await open(testClock(T).clock);
    await seed(
      home,
      record('run-live', at(-3 * HOUR)),
      finished('run-f1', at(-2 * HOUR)),
      finished('run-f2', at(-HOUR)),
    );
    // (1) red when the newest run holds whatever its liveness (run-f2 is reused); (2) prints the
    //     create.
    expect(await outcome(home.handle.runStore, keyed())).toEqual({
      created: false,
      id: 'run-live',
      rerun_of: undefined,
    });
  });

  it('check 2: with none live, the newest finished run holds the key', async () => {
    const home = await open(testClock(T).clock);
    await seed(home, finished('run-f2', at(-HOUR)), finished('run-f1', at(-2 * HOUR)));
    // (1) red when the oldest holds; (2) prints the create.
    expect(await outcome(home.handle.runStore, keyed())).toEqual({
      created: false,
      id: 'run-f2',
      rerun_of: undefined,
    });
  });

  it('check 2: with two live runs, the newer live run holds the key over a newer finished one', async () => {
    const home = await open(testClock(T).clock);
    await seed(
      home,
      record('run-l1', at(-3 * HOUR)),
      record('run-l2', at(-2 * HOUR)),
      finished('run-f', at(-HOUR)),
    );
    // (1) red when the newest run holds whatever its liveness (run-f is reused); (2) prints the
    //     create.
    expect(await outcome(home.handle.runStore, keyed())).toEqual({
      created: false,
      id: 'run-l2',
      rerun_of: undefined,
    });
  });

  it("check 2: a fresh claim after the key's only run was deleted by SQL outside Realm is a fresh run, with no rerun_of", async () => {
    const home = await open(testClock(T).clock);
    const c = await seed(home, finished('run-gone', at(-HOUR)));
    c.prepare('DELETE FROM runs WHERE id = ?').run('run-gone');
    const created = await outcome(home.handle.runStore, keyed({ onTerminalMatch: 'rerun' }));
    // (1) red when the holder is looked for among the key's tombstones too (the deleted run is
    //     superseded); (2) prints the create.
    expect({ created: created['created'], rerun_of: created['rerun_of'] }).toEqual({
      created: true,
      rerun_of: undefined,
    });
  });

  it('findKeyHolder refuses a call with no transaction open, naming the call', async () => {
    const home = await open(testClock(T).clock);
    const c = await seed(home, finished('run-done', at(-HOUR)));
    let got: string;
    try {
      got = JSON.stringify(findKeyHolder(c, WF, KEY));
    } catch (err) {
      got = (err as Error).message;
    }
    // (1) red when the check is removed (the holder is read outside the caller's write lock); (2)
    //     prints what the call gave.
    expect(got).toBe(
      "findKeyHolder reads a key's runs in one snapshot, so it needs a transaction open on its connection, and none is open.",
    );
  });
});

describe('#616 unit 15a — a superseded finished run does not hold the key (one cell per member)', () => {
  it('check 2b (i): a finished holder stamped 1 h ahead and its finished rerun stamped before it: the rerun holds, and a default create reuses it', async () => {
    const home = await open(testClock(T).clock);
    await seed(
      home,
      finished('run-ahead', at(HOUR)),
      finished('run-rerun', at(0), { rerun_of: 'run-ahead' }),
    );
    // (1) red when superseded runs are not dropped (the replaced run, newest by its stamp, holds);
    //     (2) prints the create.
    expect(await outcome(home.handle.runStore, keyed())).toEqual({
      created: false,
      id: 'run-rerun',
      rerun_of: 'run-ahead',
    });
  });

  it('check 2b (ii): a finished run naming itself in rerun_of, the newest of its key, holds it', async () => {
    const home = await open(testClock(T).clock);
    await seed(
      home,
      finished('run-older', at(-2 * HOUR)),
      finished('run-self', at(-HOUR), { rerun_of: 'run-self' }),
    );
    // (1) red when a run's own id counts as another's rerun_of (run-self is dropped and the older
    //     run holds); (2) prints the create.
    expect(await outcome(home.handle.runStore, keyed())).toEqual({
      created: false,
      id: 'run-self',
      rerun_of: 'run-self',
    });
  });

  it('check 2b (iii): two finished runs naming each other: every run is a candidate, and the newer holds', async () => {
    const home = await open(testClock(T).clock);
    await seed(
      home,
      finished('run-a', at(-2 * HOUR), { rerun_of: 'run-b' }),
      finished('run-b', at(-HOUR), { rerun_of: 'run-a' }),
    );
    // (1) red when a key whose every run is dropped answers no holder (a fresh run is written); (2)
    //     prints the create.
    expect(await outcome(home.handle.runStore, keyed())).toEqual({
      created: false,
      id: 'run-b',
      rerun_of: 'run-a',
    });
  });
});

describe('#616 unit 15a — one reading on every outcome, and the floors', () => {
  it('check 2b (iv): a LIVE run that a finished run names in rerun_of still holds the key: only a finished run is superseded', async () => {
    const home = await open(testClock(T).clock);
    await seed(
      home,
      record('run-live', at(-HOUR)),
      finished('run-done', at(-1_000), { rerun_of: 'run-live' }),
    );
    // (1) red when a run named in rerun_of is dropped whatever its state (the finished run, newer by
    //     its stamp, then holds and a default create reuses it instead of the live one); (2) prints
    //     the create.
    expect(await outcome(home.handle.runStore, keyed())).toEqual({
      created: false,
      id: 'run-live',
      rerun_of: undefined,
    });
  });

  it("check 4b: a rerun is floored by its holder's created_at, not by its updated_at: a holder that ran for 10 s", async () => {
    const t = testClock(T);
    const home = await open(t.clock);
    await seed(
      home,
      finished('run-long', T, { idempotency_key: 'k-long', updated_at: at(10_000) }),
    );
    t.set(at(-3_000));
    const r = await home.handle.runStore.create(
      keyed({ idempotencyKey: 'k-long', onTerminalMatch: 'rerun' }),
    );
    // (1) red when the floor reads the holder's updated_at: the rerun is then stamped at the
    //     reading plus ε (2 s after T), not 1 ms after the holder's created_at; (2) prints the
    //     stamps.
    expect({ created: r.created, created_at: r.record.created_at, at: r.at.toISOString() }).toEqual(
      {
        created: true,
        created_at: at(1),
        at: at(1),
      },
    );
  });

  it('check 3: fresh, reuse, rerun and both refusals each spend exactly one reading; a busy refusal spends none', async () => {
    const t = testClock(T);
    const home = await open(t.clock);
    const store = home.handle.runStore;
    const readings = async (options: CreateRunOptions): Promise<[number, unknown]> => {
      const before = t.reads();
      const got = await outcome(store, options);
      return [t.reads() - before, got['code'] ?? got['created']];
    };
    const fresh = await readings(keyed({ idempotencyKey: 'k-fresh' }));
    const reuse = await readings(keyed({ idempotencyKey: 'k-fresh' }));
    const active = await readings(keyed({ idempotencyKey: 'k-fresh', onLiveMatch: 'fail' }));
    await seed(home, finished('run-done', at(-HOUR), { idempotency_key: 'k-done' }));
    const used = await readings(keyed({ idempotencyKey: 'k-done', onTerminalMatch: 'reject' }));
    const rerun = await readings(keyed({ idempotencyKey: 'k-done', onTerminalMatch: 'rerun' }));
    // Another program holds the write lock for longer than the store's busy budget (5 s).
    const holder = await openForeignConnection(home.path);
    connections.push(holder);
    holder.exec('BEGIN IMMEDIATE');
    const busy = await readings(keyed({ idempotencyKey: 'k-busy' }));
    holder.exec('ROLLBACK');
    // (1) red when the holder is read in a snapshot before the write (two readings); (2) prints each
    //     outcome's readings and result.
    expect({ fresh, reuse, active, used, rerun, busy }).toEqual({
      fresh: [1, true],
      reuse: [1, false],
      active: [1, 'STATE_RUN_ALREADY_ACTIVE'],
      used: [1, 'STATE_IDEMPOTENCY_KEY_USED'],
      rerun: [1, true],
      busy: [0, 'STATE_RUN_BUSY'],
    });
  }, 30_000); // its busy refusal waits out the store's 5 s budget

  it("check 4: a rerun is floored by its holder's stamp (a 4 s step back, a forward step, exactly ε back, a holder 1 h ahead), and a reuse by the run's own", async () => {
    const t = testClock(T);
    const home = await open(t.clock);
    const store = home.handle.runStore;
    await seed(
      home,
      finished('h-back', T, { idempotency_key: 'k-back' }),
      finished('h-forward', T, { idempotency_key: 'k-forward' }),
      finished('h-eps', T, { idempotency_key: 'k-eps' }),
      finished('h-ahead', at(HOUR), { idempotency_key: 'k-ahead' }),
      finished('h-reuse', T, { idempotency_key: 'k-reuse', updated_at: at(3_000) }),
    );
    const rerunAt = async (key: string, clock: string): Promise<string> => {
      t.set(clock);
      const r = await store.create(keyed({ idempotencyKey: key, onTerminalMatch: 'rerun' }));
      return r.record.created_at === r.at.toISOString() ? r.record.created_at : 'at differs';
    };
    const back = await rerunAt('k-back', at(-4_000));
    const forward = await rerunAt('k-forward', at(10_000));
    const eps = await rerunAt('k-eps', at(-EPS));
    const ahead = await rerunAt('k-ahead', T);
    t.set(T);
    const reuse = (await store.create(keyed({ idempotencyKey: 'k-reuse' }))).at.toISOString();
    // (1) red when the reading is used unfloored (a rerun stamped before its holder, a reuse judged
    //     before the run's own stamp); (2) prints each stamp.
    expect({ back, forward, eps, ahead, reuse }).toEqual({
      back: at(1),
      forward: at(10_000),
      eps: T,
      ahead: at(EPS),
      reuse: at(3_000),
    });
  });
});

describe('#616 unit 15a — the COMMIT outcome of a rerun, and many processes on one key', () => {
  it('check 5: a rerun whose COMMIT SQLite rolled back answers not_landed and stores no run', async () => {
    const files = faultyFiles(openDatabase);
    const home = await open(testClock(T).clock, { openFile: files.openFile });
    await seed(home, finished('run-done', at(-HOUR)));
    const connection = files.opened.at(-1)!;
    connection.arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'rollback',
      error: SQLITE.ioError,
    });
    const got = await home.handle.runStore.create(keyed({ onTerminalMatch: 'rerun' })).then(
      () => 'created',
      (err: WithCommitOutcome) => [err.message, err.commitOutcome],
    );
    // (1) red when the check answers that a new run is there without finding it (the protocol then
    //     answers landed and the create resolves); (2) prints the create's outcome, the runs stored
    //     and the fault's firings.
    expect({
      got,
      runs: rows(home).map((r) => r['id']),
      fired: connection.hits(),
    }).toEqual({
      got: ['disk I/O error (SQLite error 10)', { outcome: 'not_landed', errcode: 10 }],
      runs: ['run-done'],
      fired: 1,
    });
  });

  /** Eight processes released together, each creating `WF` under one key; what each printed. */
  async function race(
    home: Home,
    onLiveMatch?: 'fail',
  ): Promise<Array<{ status: number | null; out: Record<string, unknown> }>> {
    const index = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'index.js')).href;
    const plan = JSON.stringify({ home: home.path, start: Date.now() + 3_000, onLiveMatch });
    const creator =
      `import { openRealmHome } from ${JSON.stringify(index)};` +
      'const { home, start, onLiveMatch } = JSON.parse(process.env.U15A_RACE);' +
      'const handle = await openRealmHome({ home }); while (Date.now() < start) {}' +
      `const options = { workflowId: ${JSON.stringify(WF)}, workflowVersion: 1, params: {}, idempotencyKey: ${JSON.stringify(KEY)}, ...(onLiveMatch ? { onLiveMatch } : {}) };` +
      'try { const r = await handle.runStore.create(options);' +
      ' console.log(JSON.stringify({ created: r.created, id: r.record.id })); }' +
      ' catch (e) { console.log(JSON.stringify({ code: e.code ?? e.message, existing: e.details?.existingRunId })); }' +
      'handle.close();';
    const run = (): Promise<{ status: number | null; out: Record<string, unknown> }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', creator], {
          env: { ...process.env, U15A_RACE: plan },
          timeout: 60_000,
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (status) => {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(out.trim()) as Record<string, unknown>;
          } catch {
            parsed = { unreadable: out.trim() };
          }
          resolve({ status, out: parsed });
        });
      });
    return Promise.all(Array.from({ length: 8 }, run));
  }

  it('check 6: eight processes released together create with one key: one run, created once; the other seven get it with created: false', async () => {
    const home = await open(testClock(T).clock);
    const results = await race(home);
    const winners = results.filter((r) => r.out['created'] === true);
    const id = winners[0]?.out['id'];
    // (1) red when the holder is read in a snapshot of its own before the write (several runs are
    //     written); (2) prints the winners, every process that did not get the winner's run, and
    //     the runs stored.
    expect({
      winners: winners.length,
      others: results.filter(
        (r) => r.status !== 0 || (r.out['created'] !== true && r.out['id'] !== id),
      ),
      stored: rows(home).length,
    }).toEqual({ winners: 1, others: [], stored: 1 });
  }, 120_000); // it starts eight Node processes

  it("check 6: under onLiveMatch 'fail' the other seven are refused STATE_RUN_ALREADY_ACTIVE naming the one run (or STATE_RUN_BUSY)", async () => {
    const home = await open(testClock(T).clock);
    const results = await race(home, 'fail');
    const winners = results.filter((r) => r.out['created'] === true);
    const id = winners[0]?.out['id'];
    // (1) red when the holder is read in a snapshot of its own before the write (several runs are
    //     written); (2) prints the winners, every process refused otherwise, and the runs stored.
    expect({
      winners: winners.length,
      others: results.filter(
        (r) =>
          r.status !== 0 ||
          (r.out['created'] !== true &&
            !(r.out['code'] === 'STATE_RUN_ALREADY_ACTIVE' && r.out['existing'] === id) &&
            r.out['code'] !== 'STATE_RUN_BUSY'),
      ),
      stored: rows(home).length,
    }).toEqual({ winners: 1, others: [], stored: 1 });
  }, 120_000); // it starts eight Node processes
});

describe("#616 unit 15a — the record is the JSON store's", () => {
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
  const FULL: CreateRunOptions = keyed({
    params: { ticket: 'T-1' },
    parentRunId: 'run-parent',
    extensionIdentity: [ENTRY],
  });

  /** A record's text with its id, its stamps and the run it names replaced by labels. */
  const shape = (r: RunRecord): string =>
    JSON.stringify({
      ...r,
      id: '<id>',
      created_at: '<at>',
      updated_at: '<at>',
      ...(r.rerun_of !== undefined ? { rerun_of: '<holder>' } : {}),
    });

  it("check 7: a fresh keyed run and a rerun with a parent and a start entry equal the JSON store's, key order included", async () => {
    const json = new JsonFileStore(join(tmp(), 'runs'));
    const jsonFresh = await json.create(FULL);
    await json.update({
      ...jsonFresh.record,
      run_phase: 'abandoned',
      terminal_state: true,
      abandoned_at: jsonFresh.record.updated_at,
      sealed_by: { arm: 'abandon_requested' },
      terminal_reason: 'Abandoned via realm run abandon',
    });
    const jsonRerun = await json.create({ ...FULL, onTerminalMatch: 'rerun' });

    const { handle } = await open(testClock(T).clock);
    const sqliteFresh = await handle.runStore.create({ ...FULL, idempotencyKey: 'k-fresh' });
    const home = await open(testClock(T).clock);
    await seed(home, finished('run-done', at(-HOUR), { idempotency_key: KEY }));
    const sqliteRerun = await home.handle.runStore.create({ ...FULL, onTerminalMatch: 'rerun' });
    // (1) red when rerun_of is placed after extension_identity (or the key anywhere but after the
    //     parent); (2) prints both stores' records, ids and stamps aside.
    expect({
      fresh: shape({ ...sqliteFresh.record, idempotency_key: KEY }),
      rerun: shape(sqliteRerun.record),
    }).toEqual({ fresh: shape(jsonFresh.record), rerun: shape(jsonRerun.record) });
  });
});
