// trace-buffer-store-racers-616.test.ts — issue #616 PR-1b B6 (the frozen design's L-FENCE-DATA: "a
// racer that flips the predicate never lands between the evaluation and the write"; the page's Build:
// "a second process changes the run mid-write"). The real case: an agent's late progress line, a
// reclaim's delete, a settle's seal or a purge reaches the trace buffer at the moment another Realm
// process is changing the run (claiming the step, resuming the run). The store checks the fence inside
// its own write, so the write waits for that change and then judges the run as it now stands. The
// published fenced contract skips these six racers on an in-transaction store (its racer parks an
// injected run read, which this store has none of); these cells run them against a real second writer.
//
// The second writer is a separate PROCESS on its own connection to the home's `realm.db`, one for the
// whole file. On a line from this file it begins a write transaction, writes the run's next state
// with the run store's own raw write (`writeRunUpdate`, at exactly the next version: the file's guard
// refuses any other) or writes a trace line, and holds the transaction until told to commit or roll
// back. It loads the built `dist` (turbo's test task builds this package first). It exits when its
// standard input closes: at the end of the file (`afterAll`), and when this process dies; `afterEach`
// rolls back anything a failed cell left held. Every home here opens with a busy budget far above the
// longest hold, so a slow machine never turns the wait into a busy refusal. Each assertion carries
// (1) the break that turns it red and (2) what it prints when it fails.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyResume,
  deriveRunPhase,
  WorkflowError,
  type Clock,
  type FencePredicate,
  type RunRecord,
  type RunScopedFencePredicate,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';
import { insertRunRecord } from './run-rows.js';
import { openForeignConnection } from './test-support/foreign-connection.js';
import { SqliteTraceBufferStore } from './trace-buffer-store.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (file: string): string => pathToFileURL(join(PACKAGE_ROOT, 'dist', file)).href;

const AT = Date.parse('2026-11-07T09:00:00.000Z');
const fixed: Clock = { now: () => new Date(AT), at: () => () => undefined };
const RUN = '0b4e7c1a-3f5d-4c2e-9a8b-7d6c5e4f3a21';
/** How long a cell holds the second writer's change before it ends it. */
const HOLD_MS = 250;
/** Every home's busy budget: far above the hold, so the wait is never cut short. */
const BUDGET_MS = 60_000;

/**
 * The second writer. It prints `{"ready":true}`, then answers each line: `hold` (open a connection on
 * `home`, BEGIN IMMEDIATE, write `record` as the run's next state or `line` as a trace row, keep the
 * transaction open), `end` (COMMIT or ROLLBACK it) and `release` (roll back whatever is held).
 */
const SECOND_WRITER =
  'import { createInterface } from "node:readline";' +
  `import { splitRunRecord, writeRunUpdate } from ${JSON.stringify(dist('run-rows.js'))};` +
  `import { openForeignConnection } from ${JSON.stringify(dist('test-support/foreign-connection.js'))};` +
  'let held;' +
  'const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");' +
  'const release = () => {' +
  ' const c = held; held = undefined; if (c === undefined) return;' +
  ' try { if (c.isTransaction) c.exec("ROLLBACK"); } finally { c.close(); }' +
  '};' +
  'let chain = Promise.resolve();' +
  'const rl = createInterface({ input: process.stdin });' +
  'rl.on("line", (text) => { chain = chain.then(async () => {' +
  ' const m = JSON.parse(text);' +
  ' try {' +
  '  if (m.op === "hold") {' +
  '   release();' +
  '   held = await openForeignConnection(m.home);' +
  '   held.exec("BEGIN IMMEDIATE");' +
  '   if (m.record !== undefined) {' +
  '    const split = splitRunRecord(m.record);' +
  '    writeRunUpdate(held, m.record.id, split.core, { prepared: split });' +
  '   } else {' +
  '    held.prepare("INSERT INTO trace_buffer (run_id, step_id, line_seq, ts, nonce, entries, entry_count, bytes) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)")' +
  '     .run(m.line.runId, m.line.stepId, m.line.seq, m.line.ts, m.line.entries, m.line.count, m.line.bytes);' +
  '   }' +
  '   say({ held: true });' +
  '  } else if (m.op === "end") {' +
  '   const c = held; held = undefined; c.exec(m.how); c.close(); say({ ended: m.how });' +
  '  } else { release(); say({ released: true }); }' +
  ' } catch (e) {' +
  '  try { release(); } catch {}' +
  '  say({ error: String(e?.code ?? "") + " " + String(e?.message ?? e) });' +
  ' }' +
  '}); });' +
  'rl.on("close", () => { try { release(); } catch {} process.exit(0); });' +
  'say({ ready: true });';

/** One answer of the second writer. */
interface Reply {
  readonly ready?: true;
  readonly held?: true;
  readonly ended?: string;
  readonly released?: true;
  readonly error?: string;
}

let writer: ChildProcessWithoutNullStreams | undefined;
let writerExited: Promise<void> = Promise.resolve();
let writerStderr = '';
const waiting: Array<{ resolve(reply: Reply): void; reject(err: Error): void }> = [];

/** The next answer of the second writer; rejects at once if it has exited. */
function nextReply(): Promise<Reply> {
  if (writer === undefined) return Promise.reject(new Error('the second writer is not running'));
  return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
}

/** Sends one line to the second writer and resolves with its answer. */
function ask(message: Record<string, unknown>): Promise<Reply> {
  const answer = nextReply();
  writer?.stdin.write(`${JSON.stringify(message)}\n`);
  return answer;
}

beforeAll(async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', SECOND_WRITER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // A backstop only: the child exits when its standard input closes.
    timeout: 300_000,
  });
  writer = child;
  child.stderr.on('data', (d: Buffer) => (writerStderr += d.toString()));
  createInterface({ input: child.stdout }).on('line', (line) =>
    waiting.shift()?.resolve(JSON.parse(line) as Reply),
  );
  writerExited = new Promise((resolve) => {
    child.on('close', (status, signal) => {
      writer = undefined;
      for (const w of waiting.splice(0)) {
        w.reject(
          new Error(
            `the second writer exited (${status ?? signal}): ${writerStderr.slice(0, 500)}`,
          ),
        );
      }
      resolve();
    });
  });
  const ready = await nextReply();
  if (ready.ready !== true) throw new Error(`the second writer said ${JSON.stringify(ready)}`);
});

afterAll(async () => {
  const child = writer;
  if (child === undefined) return;
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  await writerExited;
  clearTimeout(timer);
});

const dirs: string[] = [];
const closers: Array<{ close(): void }> = [];
afterEach(async () => {
  // A cell that failed while the second writer held its change: roll it back first.
  if (writer !== undefined) await ask({ op: 'release' });
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
  /** A connection of this process's own, for setting up runs and counting rows. */
  readonly f: DatabaseLike;
}

/** A fresh home, its trace buffer on the store's own open with {@link BUDGET_MS}, and a connection. */
async function open(): Promise<Opened> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-b6-'));
  dirs.push(dir);
  const home = join(dir, '.realm');
  const db = await RealmDb.open(home, { clock: fixed, budgetMs: BUDGET_MS });
  closers.push(db);
  const f = await openForeignConnection(home);
  closers.push(f);
  return { home, store: new SqliteTraceBufferStore(db), f };
}

/** Puts a run from this process's connection, committed. */
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

/** How many rows of `table` the file holds for the run. */
function rows(c: DatabaseLike, table: 'trace_buffer' | 'trace_sealed'): number {
  return Number(c.prepare(`SELECT count(*) AS n FROM ${table} WHERE run_id = ?`).get(RUN)?.['n']);
}

const DEFINITION: WorkflowDefinition = {
  id: 'support-reply',
  name: 'support reply',
  version: 3,
  steps: {
    classify: { description: 'classify the ticket', execution: 'agent', depends_on: [] },
    draft: { description: 'draft the reply', execution: 'agent', depends_on: ['classify'] },
  },
};

/** A live run at version 4: `classify` completed, `draft` in no set yet (eligible, unclaimed). */
function run(fields: Record<string, unknown> = {}): RunRecord {
  const record: Record<string, unknown> = {
    id: RUN,
    workflow_id: DEFINITION.id,
    workflow_version: DEFINITION.version,
    completed_steps: ['classify'],
    in_progress_steps: [],
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

/**
 * `from` with `draft` claimed, as the run store's `claimStep` writes it: the step added to
 * `in_progress_steps`, its claim (an agent step's deadline is `null`), the version moved by one and
 * `updated_at` the claim's instant.
 */
function claimed(from: RunRecord): RunRecord {
  const since = new Date(AT).toISOString();
  return run({
    ...from,
    in_progress_steps: [...from.in_progress_steps, 'draft'],
    claims: {
      ...from.claims,
      draft: { deadline: null, token: '5e0f9a7b-2c4d-4e6f-8a1b-3c5d7e9f0a12', since },
    },
    version: from.version + 1,
    updated_at: since,
  });
}

/** The run ended failed at `draft` (a run `realm run resume` can reopen). */
function failed(): RunRecord {
  return run({
    failed_steps: ['draft'],
    terminal_state: true,
    sealed_by: { arm: 'step_failure', step: 'draft' },
    terminal_reason: "Step 'draft' failed: the reply did not match the step's output schema.",
  });
}

/** `failed()` resumed at `draft` as `realm run resume` writes it: core's `applyResume`, then update. */
function resumed(): RunRecord {
  const before = failed();
  const { run: next } = applyResume(before, 'draft', DEFINITION);
  return run({
    ...next,
    version: before.version + 1,
    updated_at: new Date(AT).toISOString(),
  });
}

type Method = 'appendFenced' | 'deleteAllForRunFenced' | 'deleteFenced' | 'sealFenced';

/** One of the six racers: the fenced write, its fence, and the run before and after the change. */
interface Racer {
  readonly row: number;
  readonly method: Method;
  readonly fence: FencePredicate;
  /** What the second writer's change is, for the cell's name. */
  readonly change: string;
  readonly before: () => RunRecord;
  readonly after: () => RunRecord;
  /** The fence's own error: its class, and its code when it has one. */
  readonly refusedWith: { class: string; code?: string };
}

const RACERS: readonly Racer[] = [
  {
    row: 1,
    method: 'appendFenced',
    fence: { kind: 'step_open_for_trace', run_version: 4 },
    change: "the step's claim",
    before: () => run(),
    after: () => claimed(run()),
    refusedWith: { class: 'WorkflowError', code: 'STATE_STEP_NOT_ELIGIBLE' },
  },
  {
    row: 2,
    method: 'deleteAllForRunFenced',
    fence: { kind: 'run_absent_or_terminal' },
    change: "the failed run's resume",
    before: failed,
    after: resumed,
    refusedWith: { class: 'WorkflowError', code: 'STATE_RUN_BUSY' },
  },
  {
    row: 3,
    method: 'deleteFenced',
    fence: { kind: 'run_at_version', version: 4 },
    change: "the step's claim",
    before: () => run(),
    after: () => claimed(run()),
    refusedWith: { class: 'ReclaimVersionChanged' },
  },
  {
    row: 4,
    method: 'sealFenced',
    fence: { kind: 'run_at_version', version: 4 },
    change: "the step's claim",
    before: () => run(),
    after: () => claimed(run()),
    refusedWith: { class: 'ReclaimVersionChanged' },
  },
  {
    row: 5,
    method: 'sealFenced',
    fence: { kind: 'step_not_in_progress' },
    change: "the step's claim",
    before: () => run(),
    after: () => claimed(run()),
    refusedWith: { class: 'WorkflowError', code: 'STATE_STEP_PENDING' },
  },
  {
    row: 6,
    method: 'deleteFenced',
    fence: { kind: 'step_not_in_progress' },
    change: "the step's claim",
    before: () => run(),
    after: () => claimed(run()),
    refusedWith: { class: 'WorkflowError', code: 'STATE_STEP_PENDING' },
  },
];

/** The racer's fenced call on `draft` of the run. */
function call(store: SqliteTraceBufferStore, r: Racer): Promise<unknown> {
  switch (r.method) {
    case 'appendFenced':
      return store.appendFenced(RUN, 'draft', [{ event: 'late progress' }], r.fence);
    case 'deleteAllForRunFenced':
      return store.deleteAllForRunFenced(RUN, r.fence as RunScopedFencePredicate);
    case 'deleteFenced':
      return store.deleteFenced(RUN, 'draft', r.fence);
    case 'sealFenced':
      return store.sealFenced(RUN, 'draft', r.fence);
  }
}

/** What a call came to: its rejection's class, code, message and details, or that it resolved. */
async function outcome(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
    return 'resolved';
  } catch (err) {
    if (!(err instanceof Error)) return { thrown: String(err) };
    const typed = err instanceof WorkflowError ? err : undefined;
    return {
      class: err.constructor.name,
      code: typed?.code,
      message: err.message,
      details: typed?.details,
    };
  }
}

/** The class and code of an outcome, to hold against the fence's own error. */
function kindOf(got: unknown): unknown {
  if (typeof got !== 'object' || got === null) return got;
  const { class: cls, code } = got as { class?: string; code?: string };
  return code === undefined ? { class: cls } : { class: cls, code };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A home whose run is `r.before()`, with one live line on `draft` and one sealed artifact on
 * `classify`, and the call started while the second writer holds `r.after()` uncommitted. Resolves
 * once the call has waited {@link HOLD_MS}, with whether it had settled by then.
 */
async function raced(
  r: Racer,
): Promise<{ o: Opened; pending: Promise<unknown>; settledWhileHeld: boolean }> {
  const o = await open();
  await o.store.append(RUN, 'classify', [{ event: 'classified' }]);
  await o.store.sealFenced(RUN, 'classify', { kind: 'run_absent_or_terminal' });
  await o.store.append(RUN, 'draft', [{ event: 'seed' }]);
  putRun(o.f, r.before());
  const held = await ask({ op: 'hold', home: o.home, record: r.after() });
  if (held.held !== true) throw new Error(`the second writer could not hold: ${held.error}`);
  let settled = false;
  const pending = call(o.store, r);
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  await sleep(HOLD_MS);
  return { o, pending, settledWhileHeld: settled };
}

describe('#616 B6 — a fenced write while a second process changes the run (L-FENCE-DATA)', () => {
  for (const r of RACERS) {
    it(`row ${r.row}: ${r.method} under ${r.fence.kind}, while a second process holds ${r.change} uncommitted, waits, and once it commits is refused with the fence's own error and writes nothing`, async () => {
      const { o, pending, settledWhileHeld } = await raced(r);
      const ended = await ask({ op: 'end', how: 'COMMIT' });
      const inFlight = await outcome(pending);
      const after = { live: rows(o.f, 'trace_buffer'), sealed: rows(o.f, 'trace_sealed') };
      // The same call now that the change is committed: the contract's FALSE case for this pair.
      const committedFirst = await outcome(call(o.store, r));
      // (1) red when the method reads its fence before its write transaction begins (the write
      //     then lands on the run as it was: an append adds a line, a seal or a delete takes the
      //     draft line, a per-run delete takes every row), and when the store refuses a call that
      //     had to wait (it settles while the change is held, refused STATE_RUN_BUSY by the busy
      //     wait, not by the fence); (2) prints the row, the ordering, whether the call had settled
      //     while held, the refusal's class, code, message and details against the committed-first
      //     one, and the rows left.
      expect({
        row: r.row,
        ordering: 'change held, call started, change committed',
        ended: ended.ended,
        settledWhileHeld,
        refusal: inFlight,
        fenceError: kindOf(inFlight),
        rows: after,
      }).toEqual({
        row: r.row,
        ordering: 'change held, call started, change committed',
        ended: 'COMMIT',
        settledWhileHeld: false,
        refusal: committedFirst,
        fenceError: r.refusedWith,
        rows: { live: 1, sealed: 1 },
      });
    });
  }

  it("row 1: appendFenced under step_open_for_trace, while a second process holds the step's claim uncommitted, waits, and once it rolls back lands its line", async () => {
    const r = RACERS[0]!;
    const { o, pending, settledWhileHeld } = await raced(r);
    const ended = await ask({ op: 'end', how: 'ROLLBACK' });
    const got = await outcome(pending);
    const events = (await o.store.read(RUN, 'draft')).map((e) => e.event);
    // (1) red when the store refuses a call that had to wait (it settles while the change is held,
    //     refused STATE_RUN_BUSY, and the line is never written); (2) prints the ordering, whether
    //     the call had settled while held, its outcome and the step's lines read back.
    expect({
      row: r.row,
      ordering: 'change held, call started, change rolled back',
      ended: ended.ended,
      settledWhileHeld,
      outcome: got,
      events,
    }).toEqual({
      row: r.row,
      ordering: 'change held, call started, change rolled back',
      ended: 'ROLLBACK',
      settledWhileHeld: false,
      outcome: 'resolved',
      events: ['seed', 'late progress'],
    });
  });
});

describe('#616 B6 — an unfenced per-run delete while a second process is writing a line (CS_OCCUPANCY)', () => {
  it('deleteAllForRun, while a second process holds a line of the run uncommitted, waits, and once it commits deletes that line and counts its bytes', async () => {
    const o = await open();
    const seed = await o.store.append(RUN, 'draft', [{ event: 'seed' }]);
    const entries = [{ event: 'in flight' }];
    // The line's bytes as the store measures one: its JSON line, newline included.
    const bytes = Buffer.byteLength(`${JSON.stringify({ ts: AT, entries })}\n`);
    const line = { runId: RUN, stepId: 'draft', seq: 1, ts: AT, entries: JSON.stringify(entries) };
    const held = await ask({ op: 'hold', home: o.home, line: { ...line, count: 1, bytes } });
    if (held.held !== true) throw new Error(`the second writer could not hold: ${held.error}`);
    let settled = false;
    const pending = o.store.deleteAllForRun(RUN);
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await sleep(HOLD_MS);
    const settledWhileHeld = settled;
    const ended = await ask({ op: 'end', how: 'COMMIT' });
    const report = await pending;
    // (1) red when the delete reads the rows it deletes before its write transaction begins: the
    //     line in flight is deleted but not counted, so `bytes_deleted` is short by its bytes;
    //     (2) prints whether the delete had settled while the line was held, the bytes it reported
    //     against the two lines' bytes, and the lines left.
    expect({
      ended: ended.ended,
      settledWhileHeld,
      bytes_deleted: report.bytes_deleted,
      left: rows(o.f, 'trace_buffer'),
    }).toEqual({
      ended: 'COMMIT',
      settledWhileHeld: false,
      bytes_deleted: seed.buffer_bytes + bytes,
      left: 0,
    });
  });
});

/** The README's sentence on fenced writes, which the cells above pin. */
const FENCE_SENTENCE =
  'A fenced write checks the run inside its own write: when another writer is changing the run at ' +
  'that moment, the write waits for that change, then checks the run as it now stands, so it is ' +
  "refused with the fence's own error and writes nothing when the run no longer passes, and goes " +
  'ahead when it does.';

describe('#616 B6 — the README states what the racer cells pin', () => {
  it("the trace buffer's section carries the fenced-write sentence after its lock sentence", () => {
    const readme = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
    const lock =
      "The trace buffer keeps one row per line, in append order, and a step's read waits for a write in flight.";
    // What the sentence says is pinned by the cells above: "waits", "refused with the fence's own
    // error" and "writes nothing" by rows 1 to 6 ("… once it commits is refused …"), "goes ahead
    // when it does" by row 1's rollback cell ("… once it rolls back lands its line").
    // (1) red when the sentence is changed, dropped or moved out of the trace buffer's section;
    //     (2) prints the sentence and whether the README holds it in its place.
    expect({
      sentence: FENCE_SENTENCE,
      inPlace: readme.includes(`${lock} ${FENCE_SENTENCE}`),
    }).toEqual({ sentence: FENCE_SENTENCE, inPlace: true });
  });
});
