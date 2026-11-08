// purge-sqlite-616.test.ts — issue #616 PR-2c c9: `realm run purge`'s orchestrator (`purgeRuns`,
// `printPurgeReport`) on a SQLite home, opened through the store package's entry, with the home's
// purge as its deleter — the argument `realm run purge`'s action passes once c10a switches its door.
// The real cases: an operator's dry run; `--force` deleting finished runs, with runs another process
// deleted, changed, resumed or left a finalizer on since the selection; a store that refuses one run's
// rows; another process reading the file during the purge; a file a newer Realm migrated after the
// selection. The JSON stores' path keeps today's lines.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REALM_STORE_SCHEMA_VERSION,
  type Clock,
  type CreateRunOptions,
  type RunRecord,
} from '@sensigo/realm';
import { openRealmHome, type RealmHome } from '@sensigo/realm-store-sqlite';
import { DatabaseSync } from 'node:sqlite';
import { printPurgeReport, purgeRuns, type HomePurge, type PurgeRunsResult } from './purge.js';

const T = '2030-05-06T07:08:09.000Z';
const clock: Clock = { now: () => new Date(T), at: () => () => undefined };
const BARE: CreateRunOptions = { workflowId: 'wf', workflowVersion: 1, params: {} };

const dirs: string[] = [];
const handles: RealmHome[] = [];
const connections: DatabaseSync[] = [];
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

/** A fresh SQLite home, opened through the store package's entry. */
async function sqliteHome(): Promise<{ home: string; handle: RealmHome }> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-c9-cli-'));
  dirs.push(dir);
  const home = join(dir, '.realm');
  const handle = await openRealmHome({ home, clock });
  handles.push(handle);
  return { home, handle };
}

/** Another process's connection on the home's file. */
function foreign(home: string): DatabaseSync {
  const c = new DatabaseSync(join(home, 'realm.db'));
  c.exec('PRAGMA busy_timeout = 5000');
  connections.push(c);
  return c;
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

  it('K: a batch whose store refuses one run’s rows files every run of the batch under failed with the delete failure’s message, and nothing is purged', async () => {
    const { home, handle } = await sqliteHome();
    const kept = await finished(handle);
    const refused = await finished(handle);
    const c = foreign(home);
    // Another process's trigger refuses the delete of one run's trace rows: the batch's own
    // statement fails, so the batch rolls back whole.
    c.exec(
      `CREATE TRIGGER c9_refuse BEFORE DELETE ON trace_buffer WHEN old.run_id = '${refused.id}' ` +
        "BEGIN SELECT RAISE(ABORT, 'c9: this trace may not be deleted'); END",
    );
    const result = await purgeOn(handle, false);
    const { out, err } = render(result, false);
    const left = await Promise.all(
      [kept, refused].map((r) => handle.runStore.get(r.id).then(() => 'kept')),
    );
    // (1) red when a failed batch's runs are filed as purged or blocked, when the failure's message
    //     loses the store, the artifact or SQLite's name for the code, or when part of the batch is
    //     deleted; (2) prints every line and whether each run is still there.
    expect({ out, err, left }).toEqual({
      out: [
        'Purged 0/2 run(s) (0 B freed, store-reported; realm.db shrank by 0 B). 0 already gone, 0 blocked, 2 failed.',
        "None of the 2 selected run(s) were resumable via 'realm run resume'.",
      ],
      err: inSelectionOrder(result, [kept, refused]).map(
        (r) =>
          `  ✗ ${r.id}: RealmHome.purge failed to delete artifact(s) for run '${r.id}': trace_buffer (SQLITE_CONSTRAINT)`,
      ),
      left: ['kept', 'kept'],
    });
  });

  it('K: another process reading the file during the purge keeps its log from being reset: the force line shows no shrink and the busy line follows', async () => {
    const { home, handle } = await sqliteHome();
    const run = await finished(handle);
    const stat = await statOf(handle, run.id);
    const reader = foreign(home);
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) AS n FROM runs').get();
    const result = await purgeOn(handle, false);
    reader.exec('COMMIT');
    const { out, err } = render(result, false);
    // (1) red when the busy answer is not carried to the operator (no busy line), or the force line
    //     reports the vacuum's pages still in the log as a shrink; (2) prints every line.
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

  it('K: a purge stopped by a file a newer Realm migrated after the selection files every run it did not attempt under failed, with the refusal’s message, so the command exits 1', async () => {
    const { home, handle } = await sqliteHome();
    const runs = [await finished(handle), await finished(handle)];
    const c = foreign(home);
    const purge: HomePurge = async (selection) => {
      c.exec(`PRAGMA user_version = ${REALM_STORE_SCHEMA_VERSION + 1}`);
      return handle.purge(selection);
    };
    const result = await purgeOn(handle, false, purge);
    const { out, err } = render(result, false);
    const newer =
      `This store was migrated by a newer Realm: its schema is version ${REALM_STORE_SCHEMA_VERSION + 1} ` +
      `and this Realm writes version ${REALM_STORE_SCHEMA_VERSION}. Upgrade Realm to read or write it.`;
    // (1) red when the stop is thrown past the report (no line at all), when its runs are dropped
    //     from the report or filed as blocked, or when the backups sentence is printed though nothing
    //     was purged; (2) prints every line and the failed count the action's exit code reads.
    expect({ out, err, failed: result.failed.length }).toEqual({
      out: [
        'Purged 0/2 run(s) (0 B freed, store-reported; realm.db shrank by 0 B). 0 already gone, 0 blocked, 2 failed.',
        "None of the 2 selected run(s) were resumable via 'realm run resume'.",
      ],
      err: inSelectionOrder(result, runs).map((r) => `  ✗ ${r.id}: ${newer}`),
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
