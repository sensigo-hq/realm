// load-616.test.ts — issue #616 PR-1a unit 17 (design d4-frozen-r3 §8 and §9, L-THROUGHPUT): what the
// store does when several PROCESSES write one home at once. Writer processes settle steps (the run
// store's `settleStep`) or append trace lines (the trace buffer's `append`) against one home, and
// each run prints one line, `L-THROUGHPUT ...`, with the commits per second, the busy refusals and
// the latency it saw. The figures are RECORDED, never asserted: a millisecond bound failed on the
// macOS runner with the count right (`connection.test.ts`), and a rate is a fact about a machine.
// What IS asserted is that nothing was lost: every child exits cleanly, every call is applied or
// refused with `STATE_RUN_BUSY` (any other code fails the cell), applied plus refused is the number
// attempted, and the home, reopened, holds exactly the applied writes.
//
// Shape: a FIXED TOTAL of commits per run (so runs at 1, 4, 8 and 16 writers compare), split over
// the writers. Each child opens its own connection, says READY, waits for one line on its standard
// input (no spin barrier, no wall-clock window: it costs no CPU while it waits) and times its own
// calls on `performance.now()`. The settle legs settle a fresh run with ONE evidence entry per call
// (the cheapest case: a settle reads a run's whole evidence). SQLite writes whole 16 KiB pages to its
// log, so even these small commits fill the log toward the 16 MiB (`wal_autocheckpoint` 1000 pages)
// at which it attempts an automatic checkpoint: each line prints the final `wal_bytes`. The wide leg
// settles runs whose evidence entry is 64 KiB so the log passes that threshold for certain, and the
// tail of the commit that carries a checkpoint shows in the line's maximum. The trace buffer cannot
// carry that volume (its per-step budget is 100 KB),
// so the wide leg is a settle leg. Not measured, with the trigger: a settle on a long run (the first
// report of a slow settle on one); `claimStep`, the other half of a step's commits; a mixed leg.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WorkflowDefinition } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUSY_BUDGET_MS } from './connection.js';
import { openRealmHome, type RealmHome } from './index.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'index.js')).href;

/** The commits one run makes, split over its writers: 240 divides by 1, 4, 8 and 16. */
const TOTAL = 240;
const WRITERS = [1, 4, 8, 16] as const;
/** The wide leg: 4 writers, 320 settles of a 64 KiB evidence entry, about 20 MB of log. */
const WIDE = { writers: 4, total: 320, padBytes: 64 * 1024 } as const;

const DEFINITION: WorkflowDefinition = {
  id: 'wf-load',
  name: 'load',
  version: 1,
  steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
};

/** What a child prints at the end: its calls, what happened to them, and its own elapsed time. */
interface ChildResult {
  readonly applied: number;
  readonly busy: number;
  readonly other: Record<string, number>;
  readonly lat: number[];
  readonly total: number;
}

/** One writer. It prints `READY`, waits for a line, makes its calls and prints `RESULT <json>`. */
const WRITER =
  `import { openRealmHome } from ${JSON.stringify(INDEX)};` +
  'import { createInterface } from "node:readline";' +
  'const p = JSON.parse(process.env.U17_PLAN);' +
  'const home = await openRealmHome({ home: p.home });' +
  'const rl = createInterface({ input: process.stdin });' +
  'const go = new Promise((resolve) => rl.once("line", resolve));' +
  'console.log("READY");' +
  'await go;' +
  'const lat = []; let applied = 0; let busy = 0; const other = {};' +
  'const t0 = performance.now();' +
  'for (let i = 0; i < p.calls; i += 1) {' +
  ' const s = performance.now();' +
  ' try {' +
  '  if (p.kind === "settle") {' +
  '   const item = p.items[i];' +
  '   const r = await home.runStore.settleStep(item.runId, {' +
  '    kind: "settle_step", step: "a", outcome: "complete", claimToken: item.token,' +
  '    evidence: [{ step_id: "a", started_at: "2020-01-01T00:00:00.000Z", completed_at: "2020-01-01T00:00:01.000Z",' +
  '     duration_ms: 1000, input_summary: {}, output_summary: { answer: "x".repeat(p.padBytes) }, status: "success",' +
  '     evidence_hash: "e".repeat(64) }],' +
  '   }, p.definition);' +
  '   if (r.applied) applied += 1; else other["returned " + r.reason] = (other["returned " + r.reason] ?? 0) + 1;' +
  '  } else {' +
  '   await home.traceBufferStore.append("load-run", "w" + p.writer + "-" + Math.floor(i / 10), [{ event: "progress" }]);' +
  '   applied += 1;' +
  '  }' +
  ' } catch (e) {' +
  '  const code = String(e.code ?? e.message);' +
  '  if (code === "STATE_RUN_BUSY") busy += 1; else other[code] = (other[code] ?? 0) + 1;' +
  ' }' +
  ' lat.push(performance.now() - s);' +
  '}' +
  'const total = performance.now() - t0;' +
  'console.log("RESULT " + JSON.stringify({ applied, busy, other, lat, total }));' +
  'rl.close(); home.close(); process.exit(0);';

const dirs: string[] = [];
const handles: RealmHome[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The value at percentile `p` of an ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

/** What one leg measured. */
interface Leg {
  readonly line: string;
  readonly failed: readonly { status: number | null; stderr: string }[];
  readonly other: Record<string, number>;
  readonly attempted: number;
  readonly applied: number;
  readonly busy: number;
  readonly stored: number;
}

/**
 * Runs `writers` child processes, `total / writers` calls each, against one fresh home, and
 * measures them. `kind` 'settle' settles a pre-claimed fresh run per call (setup, outside the
 * timing); 'append' appends one trace line per call.
 */
async function runLeg(
  name: string,
  kind: 'settle' | 'append',
  writers: number,
  total: number,
  padBytes: number,
): Promise<Leg> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u17-'));
  dirs.push(dir);
  const home = join(dir, '.realm');
  const handle = await openRealmHome({ home });
  handles.push(handle);
  const calls = total / writers;
  const items: { runId: string; token: string }[][] = [];
  if (kind === 'settle') {
    for (let w = 0; w < writers; w += 1) {
      const mine: { runId: string; token: string }[] = [];
      for (let i = 0; i < calls; i += 1) {
        const { record } = await handle.runStore.create({
          workflowId: DEFINITION.id,
          workflowVersion: 1,
          params: {},
        });
        const claimed = await handle.runStore.claimStep(record.id, 'a', DEFINITION);
        mine.push({ runId: record.id, token: String(claimed.record.claims?.['a']?.token) });
      }
      items.push(mine);
    }
  }
  const children = Array.from({ length: writers }, (_, w) => {
    const plan = JSON.stringify({
      home,
      kind,
      writer: w,
      calls,
      padBytes,
      definition: DEFINITION,
      items: items[w] ?? [],
    });
    const child = spawn(process.execPath, ['--input-type=module', '-e', WRITER], {
      env: { ...process.env, U17_PLAN: plan },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 240_000,
    });
    let stdout = '';
    let stderr = '';
    let announce: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => (announce = resolve));
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.includes('READY')) announce();
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const closed = new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        child.on('close', (status) => {
          announce();
          resolve({ status, stdout, stderr });
        });
      },
    );
    return { child, ready, closed };
  });
  await Promise.all(children.map((c) => c.ready));
  for (const c of children) c.child.stdin.write('go\n');
  const results = await Promise.all(children.map((c) => c.closed));
  const parsed: ChildResult[] = [];
  const failed: { status: number | null; stderr: string }[] = [];
  for (const r of results) {
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    if (r.status !== 0 || line === undefined) {
      failed.push({ status: r.status, stderr: r.stderr.slice(0, 300) });
    } else {
      parsed.push(JSON.parse(line.slice('RESULT '.length)) as ChildResult);
    }
  }
  const applied = parsed.reduce((n, p) => n + p.applied, 0);
  const busy = parsed.reduce((n, p) => n + p.busy, 0);
  const other: Record<string, number> = {};
  for (const p of parsed)
    for (const [k, v] of Object.entries(p.other)) other[k] = (other[k] ?? 0) + v;
  const lat = parsed.flatMap((p) => p.lat).sort((a, b) => a - b);
  const seconds = Math.max(...parsed.map((p) => p.total), 1) / 1000;
  // What the home holds afterwards, counted by a second connection: the writes that landed.
  const c = await openForeignConnection(home);
  let stored: number;
  let sqlite: string;
  let walBytes: number;
  try {
    const table = kind === 'settle' ? 'evidence' : 'trace_buffer';
    stored = Number(c.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
    sqlite = String(c.prepare('SELECT sqlite_version() AS v').get()?.['v']);
  } finally {
    c.close();
  }
  try {
    walBytes = statSync(join(home, 'realm.db-wal')).size;
  } catch {
    walBytes = 0;
  }
  const line =
    `L-THROUGHPUT leg=${name} writers=${writers} total=${total} applied=${applied} busy=${busy} ` +
    `commits_per_s=${(applied / seconds).toFixed(1)} p50_ms=${percentile(lat, 50).toFixed(1)} ` +
    `p99_ms=${percentile(lat, 99).toFixed(1)} max_ms=${percentile(lat, 100).toFixed(1)} ` +
    `evidence=1 pad_bytes=${padBytes} wal_bytes=${walBytes} platform=${process.platform} ` +
    `node=${process.version} sqlite=${sqlite}`;
  // Written to the process's standard output, not through `console.log`: under GITHUB_ACTIONS vitest's
  // reporters print what a passing cell writes there and not what it logs (checked), and the line is
  // the record.
  process.stdout.write(`${line}\n`);
  return { line, failed, other, attempted: parsed.length * calls, applied, busy, stored };
}

/** The nothing-was-lost checks of one leg (no figure is judged). */
function sane(leg: Leg, total: number): unknown {
  return {
    failedChildren: leg.failed,
    otherOutcomes: leg.other,
    attemptedIsTheTotal: leg.attempted === total,
    appliedPlusRefusedIsAttempted: leg.applied + leg.busy === leg.attempted,
    lostWrites: leg.applied - leg.stored,
  };
}

const NOTHING_LOST = {
  failedChildren: [],
  otherOutcomes: {},
  attemptedIsTheTotal: true,
  appliedPlusRefusedIsAttempted: true,
  lostWrites: 0,
};

/** The shape of a recorded line: a reader greps for `L-THROUGHPUT` and finds these fields. */
const LINE_SHAPE =
  /^L-THROUGHPUT leg=(settle|append|settle-wide) writers=\d+ total=\d+ applied=\d+ busy=\d+ commits_per_s=\d+\.\d p50_ms=\d+\.\d p99_ms=\d+\.\d max_ms=\d+\.\d evidence=1 pad_bytes=\d+ wal_bytes=\d+ platform=\w+ node=v\S+ sqlite=\S+$/;

describe('#616 unit 17 — L-THROUGHPUT: writer processes on one home', () => {
  for (const kind of ['settle', 'append'] as const) {
    for (const writers of WRITERS) {
      it(`${kind} at ${writers} writer${writers === 1 ? '' : 's'}: every write lands or is refused STATE_RUN_BUSY, none is lost`, async () => {
        const leg = await runLeg(kind, kind, writers, TOTAL, 0);
        // (1) red when a child dies or prints no result, a call ends in any code but a landed write
        //     or STATE_RUN_BUSY, a write is reported applied that the reopened home does not hold
        //     (a lost write), or the calls made are not the total; no figure is judged, so a slow
        //     machine cannot turn it red; (2) prints which of these failed, the children's exit
        //     codes and error text, and the recorded line.
        expect({ ...(sane(leg, TOTAL) as object), line: LINE_SHAPE.test(leg.line) }).toEqual({
          ...NOTHING_LOST,
          line: true,
        });
      }, 300_000); // it starts up to 16 Node processes, and its setup commits a run per call
    }
  }

  it(`settle-wide at ${WIDE.writers} writers: a 64 KiB entry per settle crosses the checkpoint threshold, and nothing is lost`, async () => {
    const leg = await runLeg('settle-wide', 'settle', WIDE.writers, WIDE.total, WIDE.padBytes);
    // (1) as above; the log passes 16 MiB, so an automatic checkpoint is attempted during the run
    //     and its cost is in `max_ms`; (2) prints the same fields and the recorded line.
    expect({ ...(sane(leg, WIDE.total) as object), line: LINE_SHAPE.test(leg.line) }).toEqual({
      ...NOTHING_LOST,
      line: true,
    });
  }, 300_000);
});

describe('#616 unit 17 — the README states the busy wait, and states no number but its budget', () => {
  it('names the 5 s budget, STATE_RUN_BUSY, that nothing is written and a retry is safe, and the L-THROUGHPUT lines', () => {
    const readme = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
    // (1) red when the budget constant moves (the README then states the wrong wait), or the
    //     README loses a clause; (2) prints the missing clause.
    const clauses = [
      `${DEFAULT_BUSY_BUDGET_MS / 1000} seconds`,
      '`STATE_RUN_BUSY`',
      'nothing is written',
      'trying again is safe',
      'lines that start with `L-THROUGHPUT`',
    ];
    expect(clauses.filter((c) => !readme.includes(c))).toEqual([]);
  });
});
