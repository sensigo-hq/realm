// purge-sqlite-616.test.ts — issue #616 PR-2c c9: `realm run purge`'s orchestrator (`purgeRuns`,
// `printPurgeReport`) on a SQLite home, opened through the store package's entry, with the home's
// purge as its deleter — the argument `realm run purge`'s action passes once c10a switches its door.
// The real cases: an operator's dry run; `--force` deleting finished runs, with runs another process
// deleted, changed, resumed or left a finalizer on since the selection; a store that refuses one run's
// rows; another process reading the file during the purge; a file a newer Realm migrated mid-purge.
// The JSON stores' path keeps today's lines.
//
// The last three need another process on the store file, which only the store package's own cells
// have (the one-loader law: no source outside the loader names the built-in SQLite). So those cells
// hand `purgeRuns` a stub of the home's purge that returns the report the store's cells G, G-busy and
// G2 (`home-purge-616.test.ts`) produce on real SQLite; the routing and the words are theirs
// (correction 1).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  artifactDeleteFailedError,
  CALLBACK_DELIVERY_WINDOW_SECONDS,
  CALLBACK_PURGE_GRACE_SECONDS,
  REALM_STORE_SCHEMA_VERSION,
  WorkflowError,
  type Clock,
  type CreateRunOptions,
  type RunRecord,
} from '@sensigo/realm';
import { openRealmHome, type PurgeReport, type RealmHome } from '@sensigo/realm-store-sqlite';
import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';
import { printPurgeReport, purgeRuns, type HomePurge, type PurgeRunsResult } from './purge.js';

const T = '2030-05-06T07:08:09.000Z';
const clock: Clock = { now: () => new Date(T), at: () => () => undefined };
const BARE: CreateRunOptions = { workflowId: 'wf', workflowVersion: 1, params: {} };

const dirs: string[] = [];
const handles: RealmHome[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh SQLite home, opened through the store package's entry. */
async function sqliteHome(): Promise<{ home: string; handle: RealmHome }> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-c9-cli-'));
  dirs.push(dir);
  const home = join(dir, '.realm');
  const handle = await openRealmHome({ home, clock });
  handles.push(handle);
  return { home, handle };
}

/**
 * A stub of the home's purge: it deletes nothing and answers `report(selection)`, the shape a store cell
 * of `home-purge-616.test.ts` produces on real SQLite.
 */
function stubPurge(
  report: (selection: readonly { runId: string; version: number }[]) => PurgeReport,
): HomePurge {
  return async (selection) => report(selection);
}

/** A finished run with a trace line and a failed attempt beside its record. */
async function finished(handle: RealmHome, fields: Partial<RunRecord> = {}): Promise<RunRecord> {
  const { record } = await handle.runStore.create(BARE);
  await handle.traceBufferStore.append(record.id, 'a', [{ event: 'drafting the reply' }]);
  await handle.failedAttemptStore.append(record.id, '{"attempt":1,"error":"timeout"}');
  return (
    await handle.runStore.update({
      ...record,
      ...fields,
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
    })
  ).record;
}

/** The three stores' stats of a run, summed: what the dry run shows for it. */
async function statOf(handle: RealmHome, runId: string): Promise<number> {
  const parts = await Promise.all([
    handle.runStore.statAllForRun(runId),
    handle.traceBufferStore.statAllForRun(runId),
    handle.failedAttemptStore.statAllForRun(runId),
  ]);
  return parts.reduce((sum, part) => sum + part.bytes, 0);
}

/** A byte figure as the purge prints its figures (today's form: B under 1 KiB, else KB with one decimal). */
function printed(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** The runs in the order the purge selected them (the store's listing order), which its lines follow. */
const inSelectionOrder = (result: PurgeRunsResult, runs: readonly RunRecord[]): RunRecord[] =>
  result.selected.flatMap((c) => runs.filter((r) => r.id === c.run.id));

/** What `printPurgeReport` prints for `result`, stdout and stderr, line by line. */
function render(result: PurgeRunsResult, dryRun: boolean): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
    out.push(...String(m).split('\n'));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
    err.push(String(m));
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
    err.push(String(m));
  });
  try {
    printPurgeReport(result, dryRun);
  } finally {
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  }
  return { out, err };
}

/** The orchestrator on the home, as `realm run purge` runs it after c10a: the home's purge as its deleter. */
function purgeOn(handle: RealmHome, dryRun: boolean, purge: HomePurge = handle.purge) {
  return purgeRuns(
    { dryRun, workflows: handle.workflowStore },
    handle.runStore,
    [handle.traceBufferStore, handle.failedAttemptStore],
    purge,
  );
}

const FORCE_TAIL = "None of the 1 selected run(s) were resumable via 'realm run resume'.";

describe('#616 PR-2c c9 — realm run purge on a SQLite home', () => {
  it('J: the dry run lists the selected runs with the SQLite stores’ byte sums, in today’s words, and deletes nothing', async () => {
    const { handle } = await sqliteHome();
    const runs = [await finished(handle), await finished(handle)];
    const stats = await Promise.all(runs.map((r) => statOf(handle, r.id)));
    const result = await purgeOn(handle, true);
    const { out } = render(result, true);
    const left = await Promise.all(runs.map((r) => handle.runStore.get(r.id).then(() => 'kept')));
    const [one, two] = inSelectionOrder(result, runs).map((r) => [r.id, stats[runs.indexOf(r)]!]);
    // (1) red when a run's preview figure is not the three stores' stats (a store's stat left out of
    //     the sum), when the dry run deletes, or when the preview's words change on this path;
    //     (2) prints the printed lines and whether each run is still there.
    expect({ out, left }).toEqual({
      out: [
        `2 run(s) WOULD be purged (${printed(stats[0]! + stats[1]!)} to free):`,
        `  • ${one![0]}  (completed, ${printed(one![1] as number)})`,
        `  • ${two![0]}  (completed, ${printed(two![1] as number)})`,
        '',
        "None of the 2 selected run(s) are resumable via 'realm run resume'.",
        'Re-run with --force to actually delete.',
      ],
      left: ['kept', 'kept'],
    });
  });

  it('callback B1b: a run with a callback row — the dry run’s figure counts the row, and --force frees exactly that figure', async () => {
    const { handle } = await sqliteHome();
    const url = 'https://hooks.example/callback/ünïcode';
    const { record } = await handle.runStore.create({
      ...BARE,
      callback: {
        url,
        host: 'hooks.example:443',
        webhook_id: '00000000-0000-4000-8000-000000000001',
      },
    });
    await handle.runStore.update({
      ...record,
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
    });
    // The stores `realm run purge` previews, in its order (purge-guard pins the command's list).
    const stores = [
      handle.traceBufferStore,
      handle.failedAttemptStore,
      handle.runStore.outbound,
      handle.runStore.callbacks,
    ];
    // Measured before the purge: the run's own rows, and the row's address (no body yet).
    const expected = printed(
      (await handle.runStore.statAllForRun(record.id)).bytes + Buffer.byteLength(url, 'utf8'),
    );
    const run = (dryRun: boolean) =>
      purgeRuns(
        { dryRun, runId: record.id, workflows: handle.workflowStore },
        handle.runStore,
        stores,
        handle.purge,
      );
    const preview = render(await run(true), true).out[0];
    const freed = render(await run(false), false).out[0];
    // (1) red when the preview leaves the callback store out (its figure lacks the address's UTF-8
    //     bytes) or the purge frees another figure than it previewed; (2) prints both lines.
    expect({ preview, freed: freed?.split(' freed,')[0] }).toEqual({
      preview: `1 run(s) WOULD be purged (${expected} to free):`,
      freed: `Purged 1/1 run(s) (${expected}`,
    });
  });

  it('K: --force purges through the home’s purge and prints the freed bytes, the file’s shrink and the backups sentence; gone, changed, resumed and draining runs are worded as today, with no partial-free suffix', async () => {
    const { handle } = await sqliteHome();
    const purged = await finished(handle);
    const gone = await finished(handle);
    const changed = await finished(handle);
    const resumed = await finished(handle);
    const draining = await finished(handle, {
      finalizer_ledger: { notify: { status: 'pending', rank: 0 } },
    });
    const purgedStat = await statOf(handle, purged.id);
    // After the selection, before the purge: another process deletes one run, changes one (it stays
    // finished) and resumes one.
    const purge: HomePurge = async (selection) => {
      await handle.runStore.deleteAllForRun(gone.id);
      await handle.runStore.update({ ...changed, params: { note: 'changed since selection' } });
      // A resume, as core's `applyResume` writes it: the seal and the terminal reason stripped.
      const { sealed_by: _seal, terminal_reason: _reason, ...live } = resumed;
      await handle.runStore.update({ ...live, terminal_state: false });
      return handle.purge(selection);
    };
    const result = await purgeOn(handle, false, purge);
    const { out, err } = render(result, false);
    // (1) red when the SQLite path prints the JSON line (no shrink clause) or no backups sentence,
    //     when the freed figure is not the stores' receipts, when a run's outcome is not routed as
    //     today (gone → already gone; changed → `changed_since_selected`; resumed → today's
    //     no-longer-terminal sentence; a pending finalizer → `drain_pending`), when a refused run
    //     shows a partial-free suffix, or when the busy line is printed though the checkpoint
    //     completed; (2) prints every line the report printed and the result's store-file figures.
    expect({ out, err, file: result.store_file }).toEqual({
      out: [
        `Purged 1/5 run(s) (${printed(purgedStat)} freed, store-reported; realm.db shrank by ${printed(result.store_file?.reclaimed_bytes ?? NaN)}). 1 already gone, 3 blocked, 0 failed.`,
        'Copies of the deleted runs in backups made before this purge are not touched.',
        "None of the 5 selected run(s) were resumable via 'realm run resume'.",
      ],
      err: inSelectionOrder(result, [changed, resumed, draining]).map(
        (r) =>
          ({
            [changed.id]: `  ⚠ ${changed.id}: changed_since_selected`,
            [resumed.id]: `  ⚠ ${resumed.id}: run '${resumed.id}' is no longer terminal (resumed since selection) — refusing to purge its trace buffer`,
            [draining.id]: `  ⚠ ${draining.id}: drain_pending`,
          })[r.id],
      ),
      file: { reclaimed_bytes: expect.any(Number) as number, checkpoint_busy: false },
    });
  });

  it('K: a failed batch (the report shape is the store cell G’s) files every run of the batch under failed with the delete failure’s message; this cell proves the routing and the words', async () => {
    const { handle } = await sqliteHome();
    const runs = [await finished(handle), await finished(handle)];
    // Cell G's shape: a batch whose own statement failed (here a store refusing one run's trace rows).
    const purge = stubPurge((selection) => ({
      runs: selection.map(({ runId }) => ({
        runId,
        outcome: 'failed' as const,
        error: artifactDeleteFailedError(
          runId,
          'RealmHome.purge',
          [],
          [
            {
              artifact: 'trace_buffer',
              code: 'SQLITE_CONSTRAINT',
              message: 'c9: this trace may not be deleted (SQLite error 1811)',
            },
          ],
        ),
      })),
      stored_bytes_deleted: 0,
      file_bytes_reclaimed: 0,
    }));
    const result = await purgeOn(handle, false, purge);
    const { out, err } = render(result, false);
    // (1) red when a failed batch's runs are filed as purged or blocked (`routeRefusal`'s `failed`
    //     branch removed), or the failure's message loses the store, the artifact or the code;
    //     (2) prints every line.
    expect({ out, err }).toEqual({
      out: [
        'Purged 0/2 run(s) (0 B freed, store-reported; realm.db shrank by 0 B). 0 already gone, 0 blocked, 2 failed.',
        "None of the 2 selected run(s) were resumable via 'realm run resume'.",
      ],
      err: inSelectionOrder(result, runs).map(
        (r) =>
          `  ✗ ${r.id}: RealmHome.purge failed to delete artifact(s) for run '${r.id}': trace_buffer (SQLITE_CONSTRAINT)`,
      ),
    });
  });

  it('K: a blocked checkpoint (the report shape is the store cell G-busy’s) prints no shrink and the busy line after the backups sentence; this cell proves the routing and the words', async () => {
    const { handle } = await sqliteHome();
    const run = await finished(handle);
    const stat = await statOf(handle, run.id);
    // Cell G-busy's shape: the run purged, the checkpoint answering busy, nothing reclaimed.
    const purge = stubPurge((selection) => ({
      runs: selection.map(({ runId }) => ({
        runId,
        outcome: 'purged' as const,
        bytes_deleted: stat,
      })),
      stored_bytes_deleted: stat,
      file_bytes_reclaimed: 0,
      vacuum: { steps: 1, pages_returned: 3 },
      checkpoint: { busy: 1, log: 196, checkpointed: 0 },
    }));
    const result = await purgeOn(handle, false, purge);
    const { out, err } = render(result, false);
    // (1) red when the busy answer is not carried to the operator (no busy line: `store_file`'s
    //     `checkpoint_busy` not set, or the line removed from `printPurgeReport`); (2) prints every
    //     line.
    expect({ out, err }).toEqual({
      out: [
        `Purged 1/1 run(s) (${printed(stat)} freed, store-reported; realm.db shrank by 0 B). 0 already gone, 0 blocked, 0 failed.`,
        'Copies of the deleted runs in backups made before this purge are not touched.',
        "realm.db's log was not reset: another process was using it. The space is returned at a later checkpoint; the deleted text may stay readable in realm.db-wal until a later purge resets the log.",
        FORCE_TAIL,
      ],
      err: [],
    });
  });

  it('K: a stopped purge (the report shape is the store cell G2’s: a first batch purged, then a file a newer Realm migrated) files every run it did not attempt under failed with the refusal’s message, so the command exits 1; this cell proves the routing and the words', async () => {
    const { handle } = await sqliteHome();
    const runs = [await finished(handle), await finished(handle), await finished(handle)];
    const newer =
      `This store was migrated by a newer Realm: its schema is version ${REALM_STORE_SCHEMA_VERSION + 1} ` +
      `and this Realm writes version ${REALM_STORE_SCHEMA_VERSION}. Upgrade Realm to read or write it.`;
    const RECLAIMED = 49_152;
    // Cell G2's shape: the first run's batch committed, the refusal and the runs not attempted after it.
    const purge = stubPurge(([first, ...rest]) => ({
      runs: [{ runId: first!.runId, outcome: 'purged' as const, bytes_deleted: 700 }],
      stored_bytes_deleted: 700,
      file_bytes_reclaimed: RECLAIMED,
      vacuum: { steps: 1, pages_returned: 3 },
      checkpoint: { busy: 0, log: 0, checkpointed: 0 },
      stopped: {
        error: new WorkflowError(newer, {
          code: 'STATE_STORE_VERSION_NEWER',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
          details: { file: REALM_STORE_SCHEMA_VERSION + 1, realm: REALM_STORE_SCHEMA_VERSION },
        }),
        not_attempted: rest.map((r) => r.runId),
      },
    }));
    const result = await purgeOn(handle, false, purge);
    const { out, err } = render(result, false);
    const [, ...notAttempted] = inSelectionOrder(result, runs);
    // (1) red when a stopped purge's runs are dropped from the report (the `not_attempted` loop
    //     removed) or filed as blocked, or when the first batch's purge is lost; (2) prints every
    //     line and the failed count the action's exit code reads.
    expect({ out, err, failed: result.failed.length }).toEqual({
      out: [
        `Purged 1/3 run(s) (700 B freed, store-reported; realm.db shrank by ${printed(RECLAIMED)}). 0 already gone, 0 blocked, 2 failed.`,
        'Copies of the deleted runs in backups made before this purge are not touched.',
        "None of the 3 selected run(s) were resumable via 'realm run resume'.",
      ],
      err: notAttempted.map((r) => `  ✗ ${r.id}: ${newer}`),
      failed: 2,
    });
  });

  it('the JSON stores’ path prints today’s force line, with no shrink clause and no backups sentence', () => {
    const run = { id: 'json-run', run_phase: 'completed' } as RunRecord;
    const result: PurgeRunsResult = {
      selected: [{ run, bytes: 300, resumable: false }],
      skipped: [],
      purged: ['json-run'],
      freed_bytes: { 'json-run': 300 },
      partial_frees: {},
      already_purged: [],
      blocked: [],
      failed: [],
    };
    // (1) red when the shrink clause or the backups sentence leaks onto the JSON path (they belong to
    //     a store file, which the JSON stores do not have); (2) prints every line.
    expect(render(result, false)).toEqual({
      out: [
        'Purged 1/1 run(s) (300 B freed, store-reported). 0 already gone, 0 blocked, 0 failed.',
        FORCE_TAIL,
      ],
      err: [],
    });
  });
});

describe('#616 PR-2c c10a-3b-ii — the purge says when the free pages were not all returned', () => {
  const line = (reason: string) =>
    `realm.db's free pages were not all returned: ${reason}. The next purge that deletes a run returns them.`;
  const refused = (code: string, message: string) =>
    new WorkflowError(message, {
      code: code as 'STATE_RUN_BUSY',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  const busy = refused(
    'STATE_RUN_BUSY',
    'The store was busy for 5 s: another writer held it. Nothing was written. Try again.',
  );
  const full = refused(
    'STATE_STORE_FULL',
    "The Realm store could not be written: its disk, or the database's size limit, is full. Nothing was written. Free space, then try again.",
  );
  const fenced = refused(
    'STATE_STORE_WRITES_FENCED',
    'The store cannot confirm whether its last write was saved, so it refuses new writes until it can. Read back what you wrote to see what was saved, then try again.',
  );

  it.each([
    {
      name: 'the store busy',
      error: busy as unknown,
      reason: 'another process was using the store',
    },
    { name: 'a full disk', error: full as unknown, reason: 'the disk is full' },
    { name: 'another refusal', error: fenced as unknown, reason: 'STATE_STORE_WRITES_FENCED' },
    {
      name: "SQLite's own message",
      error: new Error('disk I/O error (SQLite error 10).') as unknown,
      reason: 'disk I/O error (SQLite error 10)',
    },
  ])(
    '$name: one line after the force line, in the purge\u2019s own words',
    async ({ error, reason }) => {
      const { handle } = await sqliteHome();
      const run = await finished(handle);
      const stat = await statOf(handle, run.id);
      // The report shape of a failed vacuum step (`returnFreePages`): the run purged, the error carried.
      const purge = stubPurge((selection) => ({
        runs: selection.map(({ runId }) => ({
          runId,
          outcome: 'purged' as const,
          bytes_deleted: stat,
        })),
        stored_bytes_deleted: stat,
        file_bytes_reclaimed: 0,
        vacuum: { steps: 0, pages_returned: 0, error },
        checkpoint: { busy: 0, log: 0, checkpointed: 0 },
      }));
      const result = await purgeOn(handle, false, purge);
      const { out, err } = render(result, false);
      // (1) red when the line is dropped, printed elsewhere than after the force line, or the raw
      //     message is printed (the store's own sentence, its path or "Nothing was written", or a
      //     trailing period kept); (2) prints every line.
      expect({ out, err }).toEqual({
        out: [
          `Purged 1/1 run(s) (${printed(stat)} freed, store-reported; realm.db shrank by 0 B). 0 already gone, 0 blocked, 0 failed.`,
          line(reason),
          'Copies of the deleted runs in backups made before this purge are not touched.',
          FORCE_TAIL,
        ],
        err: [],
      });
    },
  );

  it('the docs quote the line the purge prints', () => {
    const page = readFileSync(
      new URL('../../../../docs/reference/cli/realm-run-acting.md', import.meta.url),
      'utf8',
    );
    const sentence = `When the store's free pages could not all be returned, one more line says so: \`${line('<reason>')}\``;
    // (1) red when the page's sentence or the printed line changes without the other; (2) prints
    //     whether the page holds it.
    expect({ onThePage: page.includes(sentence) }, sentence).toEqual({ onThePage: true });
  });
});

// ---- callback B2: a run whose callback is still pending is held from a batch purge ----

const T0 = Date.parse('2030-05-06T07:00:00.000Z');
const HOLD_MS = (CALLBACK_DELIVERY_WINDOW_SECONDS + CALLBACK_PURGE_GRACE_SECONDS) * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
const CB_HOST = 'hooks.example:443';

/** A fresh SQLite home on a clock the cell moves, and how many readings the home took. */
async function movableHome(): Promise<{
  home: string;
  handle: RealmHome;
  at: (ms: number) => void;
  reads: () => number;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-b2-purge-'));
  dirs.push(dir);
  const home = join(dir, '.realm');
  let now = T0;
  let reads = 0;
  const moving: Clock = {
    now: () => {
      reads += 1;
      return new Date(now);
    },
    at: () => () => undefined,
  };
  const handle = await openRealmHome({ home, clock: moving });
  handles.push(handle);
  return { home, handle, at: (ms) => (now = ms), reads: () => reads };
}

/** Writes run `runId`'s callback row on a foreign connection (a pending row keeps its address). */
async function plantCallback(
  home: string,
  runId: string,
  row: { status: string; finished_at?: string },
): Promise<void> {
  const c = await openForeignConnection(home);
  try {
    c.prepare(
      'INSERT INTO callbacks (run_id, workflow_id, host, webhook_id, status, attempts, created_at, ' +
        'next_attempt_at, finished_at, url) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
    ).run(
      runId,
      'wf',
      CB_HOST,
      randomUUID(),
      row.status,
      iso(T0),
      iso(T0),
      row.finished_at ?? null,
      row.status === 'pending' ? 'https://hooks.example/callback/b2' : null,
    );
  } finally {
    c.close();
  }
}

/** How many callback rows the runs have, read on a foreign connection. */
async function callbackRows(home: string, ids: readonly string[]): Promise<number> {
  const c = await openForeignConnection(home);
  try {
    return ids.reduce(
      (n, id) =>
        n +
        Number(c.prepare('SELECT count(*) AS n FROM callbacks WHERE run_id = ?').get(id)?.['n']),
      0,
    );
  } finally {
    c.close();
  }
}

/** The stores `realm run purge` previews, in its order. */
const storesOf = (handle: RealmHome) => [
  handle.traceBufferStore,
  handle.failedAttemptStore,
  handle.runStore.outbound,
  handle.runStore.callbacks,
];

/** A batch sweep, as `realm run purge --older-than 1m` runs it (a duration is d, h or m). */
const sweep = (handle: RealmHome, dryRun: boolean, olderThan = '1m') =>
  purgeRuns(
    { dryRun, olderThan, workflows: handle.workflowStore },
    handle.runStore,
    storesOf(handle),
    handle.purge,
  );

/** A single-id purge, as `realm run purge <id>` runs it. */
const single = (handle: RealmHome, runId: string, dryRun: boolean, purge = handle.purge) =>
  purgeRuns(
    { dryRun, runId, workflows: handle.workflowStore },
    handle.runStore,
    storesOf(handle),
    purge,
  );

const held = (id: string, release: string): string =>
  `⚠ skipping ${id}: its callback to ${CB_HOST} is still waiting to be delivered; the run is kept until ${release}`;
const wouldDrop = (id: string): string =>
  `  ⚠ ${id}: callback to ${CB_HOST} not delivered; would be dropped with the run`;
const dropped = (id: string): string =>
  `  ⚠ ${id}: callback to ${CB_HOST} not delivered; dropped with the run`;
const NONE = 'No eligible runs found to purge.';

describe('callback B2 — a run whose callback is still pending is held from a batch purge', () => {
  it('a run that finished two minutes ago (the sweep: --older-than 1m): the preview and --force both skip it with the line, keep the run and its row, and print that no run is eligible', async () => {
    const { home, handle, at } = await movableHome();
    const run = await finished(handle);
    await plantCallback(home, run.id, { status: 'pending' });
    at(T0 + 120_000);
    const preview = render(await sweep(handle, true), true);
    const force = render(await sweep(handle, false), false);
    const line = held(run.id, iso(Date.parse(run.updated_at) + HOLD_MS));
    // (1) red when the sweep does not hold the run (it is previewed, then purged with its row), or
    //     the line names another time or the address; (2) prints both outputs and what is left.
    expect({
      preview,
      force,
      run: (await handle.runStore.get(run.id)).record.id,
      row: (await handle.runStore.callbacks.read(run.id))?.status,
    }).toEqual({
      preview: { out: [NONE], err: [line] },
      force: { out: [NONE], err: [line] },
      run: run.id,
      row: 'pending',
    });
  });

  it('a held run is not counted: beside it another run is purged, and the receipt counts that one only', async () => {
    const { home, handle, at } = await movableHome();
    const kept = await finished(handle);
    const gone = await finished(handle);
    await plantCallback(home, kept.id, { status: 'pending' });
    at(T0 + 120_000);
    const { out, err } = render(await sweep(handle, false), false);
    // (1) red when a held run enters the selection or the count; (2) prints the receipt and the
    //     warning.
    expect({ first: out[0]?.split(' (')[0], err }).toEqual({
      first: 'Purged 1/1 run(s)',
      err: [held(kept.id, iso(Date.parse(kept.updated_at) + HOLD_MS))],
    });
    void gone;
  });

  it('a run younger than --older-than prints no line: the age rule keeps it first', async () => {
    const { home, handle, at } = await movableHome();
    const run = await finished(handle);
    await plantCallback(home, run.id, { status: 'pending' });
    at(T0 + 120_000);
    // (1) red when the hold is judged before the age test (a "kept until" line for a run the age
    //     rule keeps anyway); (2) prints the output.
    expect(render(await sweep(handle, true, '30d'), true)).toEqual({ out: [NONE], err: [] });
  });

  it('the boundary: 1 ms before the anchor plus 3 days and 1 hour the run is held; at that instant it is purged', async () => {
    const { home, handle, at } = await movableHome();
    const run = await finished(handle);
    const anchor = T0 + 5_000;
    await plantCallback(home, run.id, { status: 'pending', finished_at: iso(anchor) });
    at(anchor + HOLD_MS - 1);
    const before = render(await sweep(handle, true), true);
    at(anchor + HOLD_MS);
    const atRelease = render(await sweep(handle, true), true);
    // (1) red when the release compares with `>` (held at the instant) or the window is shorter;
    //     (2) prints both outputs.
    expect({ before, atRelease: { first: atRelease.out[0], err: atRelease.err } }).toEqual({
      before: { out: [NONE], err: [held(run.id, iso(anchor + HOLD_MS))] },
      atRelease: { first: expect.stringMatching(/^1 run\(s\) WOULD be purged/), err: [] },
    });
  });

  it('the anchor is the row’s finished_at when set, otherwise the run’s updated_at', async () => {
    const { home, handle, at } = await movableHome();
    const fromRow = await finished(handle);
    const fromRun = await finished(handle);
    const later = T0 + 86_400_000;
    await plantCallback(home, fromRow.id, { status: 'pending', finished_at: iso(later) });
    await plantCallback(home, fromRun.id, { status: 'pending' });
    // Past the run's own release, before the row's.
    at(Date.parse(fromRun.updated_at) + HOLD_MS + 60_000);
    const result = await sweep(handle, true);
    // (1) red when the hold always counts from updated_at (the first run is then purged) or never
    //     falls back to it (the second is then kept); (2) prints the selection and the warning.
    expect({
      selected: result.selected.map((c) => c.run.id),
      err: render(result, true).err,
    }).toEqual({ selected: [fromRun.id], err: [held(fromRow.id, iso(later + HOLD_MS))] });
  });

  it('a finished_at that cannot be read holds the run, and the line names the way out', async () => {
    const { home, handle, at } = await movableHome();
    const run = await finished(handle);
    await plantCallback(home, run.id, { status: 'pending', finished_at: 'garbage' });
    at(T0 + HOLD_MS * 10);
    // (1) red when an unreadable end counts as past (the run is purged); (2) prints the output.
    expect(render(await sweep(handle, true), true)).toEqual({
      out: [NONE],
      err: [
        `⚠ skipping ${run.id}: its callback to ${CB_HOST} is still waiting to be delivered and its end time cannot be read; run 'realm run purge ${run.id} --force' to purge it anyway`,
      ],
    });
  });

  it('a delivered row, a failed row and no row: each run is purged, and its row goes with it', async () => {
    const { home, handle, at } = await movableHome();
    const runs = [await finished(handle), await finished(handle), await finished(handle)];
    await plantCallback(home, runs[0]!.id, { status: 'delivered' });
    await plantCallback(home, runs[1]!.id, { status: 'failed' });
    at(T0 + 120_000);
    const result = await sweep(handle, false);
    // (1) red when a row that is not pending holds its run; (2) prints the purged ids, the warnings
    //     and the rows left.
    expect({
      purged: [...result.purged].sort(),
      skipped: result.skipped,
      rows: await callbackRows(
        home,
        runs.map((r) => r.id),
      ),
    }).toEqual({ purged: runs.map((r) => r.id).sort(), skipped: [], rows: 0 });
  });

  it('single-id on a pending row: the preview says it would be dropped, the receipt that it was; on a delivered row nothing is said', async () => {
    const { home, handle, at } = await movableHome();
    const pending = await finished(handle);
    const delivered = await finished(handle);
    await plantCallback(home, pending.id, { status: 'pending' });
    await plantCallback(home, delivered.id, { status: 'delivered' });
    at(T0 + 120_000);
    const preview = render(await single(handle, pending.id, true), true).out;
    const receipt = render(await single(handle, pending.id, false), false).out;
    const quiet = render(await single(handle, delivered.id, false), false).out;
    // (1) red when the disclosure is missing, worded otherwise, or printed for a delivered row;
    //     (2) prints the three outputs.
    expect({
      preview: preview.slice(1, 3),
      receipt: receipt.filter((l) => l.includes('not delivered')),
      quiet: quiet.filter((l) => l.includes('not delivered')),
    }).toEqual({
      preview: [expect.stringMatching(new RegExp(`^  • ${pending.id}  `)), wouldDrop(pending.id)],
      receipt: [dropped(pending.id)],
      quiet: [],
    });
  });

  it('single-id on a pending row older than the hold: the phrase too; and a blocked single-id purge claims no drop', async () => {
    const { home, handle, at } = await movableHome();
    const old = await finished(handle);
    const blocked = await finished(handle);
    await plantCallback(home, old.id, { status: 'pending' });
    await plantCallback(home, blocked.id, { status: 'pending' });
    at(T0 + HOLD_MS * 2);
    const oldReceipt = render(await single(handle, old.id, false), false).out;
    const refusing = stubPurge((selection) => ({
      runs: selection.map(({ runId }) => ({
        runId,
        outcome: 'blocked' as const,
        error: new WorkflowError('blocked by the stub', {
          code: 'STATE_RUN_BUSY',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: true,
        }),
      })),
      stored_bytes_deleted: 0,
      file_bytes_reclaimed: 0,
    }));
    const blockedReceipt = render(await single(handle, blocked.id, false, refusing), false).out;
    // (1) red when the phrase depends on the row's age, or a run that was not purged claims its
    //     callback was dropped; (2) prints the disclosure lines of both receipts.
    expect({
      old: oldReceipt.filter((l) => l.includes('not delivered')),
      blocked: blockedReceipt.filter((l) => l.includes('not delivered')),
    }).toEqual({ old: [dropped(old.id)], blocked: [] });
  });

  it('a claim override and a pending row show both disclosures; claim-held and callback-held in a sweep shows the claim reason', async () => {
    const { home, handle, at } = await movableHome();
    const claim = { in_progress_steps: ['charge'], claims: { charge: { deadline: null } } };
    const named = await finished(handle, claim as Partial<RunRecord>);
    const swept = await finished(handle, claim as Partial<RunRecord>);
    await plantCallback(home, named.id, { status: 'pending' });
    await plantCallback(home, swept.id, { status: 'pending' });
    at(T0 + 120_000);
    const preview = render(await single(handle, named.id, true), true).out;
    const sweepErr = render(await sweep(handle, true), true).err;
    // (1) red when one disclosure hides the other, or the sweep reports the callback hold before
    //     the claim's; (2) prints the preview's lines and the sweep's warnings.
    expect({
      bullet: preview[1]?.includes('despite an indeterminate-age claim'),
      callback: preview[2],
      sweep: sweepErr.map((l) => l.includes('no deadline recorded')),
    }).toEqual({ bullet: true, callback: wouldDrop(named.id), sweep: [true, true] });
  });

  it('a callback read that throws stops the purge before anything is deleted', async () => {
    const { home, handle, at } = await movableHome();
    const run = await finished(handle);
    await plantCallback(home, run.id, { status: 'pending' });
    at(T0 + 120_000);
    const failing = new Proxy(handle.runStore, {
      get(target, property) {
        if (property === 'callbacks')
          return {
            read: async () => {
              throw new Error('planted read failure');
            },
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const outcome = await purgeRuns(
      { dryRun: false, olderThan: '1m', workflows: handle.workflowStore },
      failing,
      storesOf(handle),
      handle.purge,
    ).then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    // (1) red when a failed read is taken for "no hold" (the run is purged); (2) prints the outcome
    //     and what is left.
    expect({
      outcome,
      run: (await handle.runStore.get(run.id)).record.id,
      rows: await callbackRows(home, [run.id]),
    }).toEqual({ outcome: 'planted read failure', run: run.id, rows: 1 });
  });

  it('the purge takes as many readings with callback rows as without', async () => {
    const plain = await movableHome();
    const withRows = await movableHome();
    for (const h of [plain, withRows]) {
      for (let i = 0; i < 3; i++) {
        const run = await finished(h.handle);
        if (h === withRows) await plantCallback(h.home, run.id, { status: 'pending' });
      }
      // Past the hold: every run is judged by it and selected, so both sweeps select the same runs.
      h.at(T0 + HOLD_MS * 2);
    }
    const readings = async (h: typeof plain): Promise<number> => {
      const before = h.reads();
      await sweep(h.handle, true);
      return h.reads() - before;
    };
    // (1) red when the hold takes a reading of its own per run; (2) prints both counts.
    expect({
      withRows: await readings(withRows),
      selected: (await sweep(withRows.handle, true)).selected.length,
    }).toEqual({
      withRows: await readings(plain),
      selected: 3,
    });
  });
});
