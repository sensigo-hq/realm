// home-purge.ts — issue #616 PR-2c c9 (design d4 §7 and §8 `purge`; the page's row c9; SEAMS S15 and
// MA 4's point 5): the home's purge. Package-internal: `openRealmHome`'s handle carries it as
// `purge`; the package's entry exports its types only.
//
// The caller selects the runs (purge's policy is the CLI's) and hands each with the version it was
// selected at. The purge deletes them in batches of {@link PURGE_BATCH_RUNS}, each ONE write
// transaction through the primitive (`immediate`, with a check by content for the COMMIT outcome
// protocol), so the write lock is held for one batch at a time and another process's write lands
// between two batches. Inside a batch every run is judged under the write lock, in unit 14's words,
// before any of its rows go ({@link deleteRunIfDeletable}); a refused run writes nothing and leaves the
// batch's other runs deleted. A deletable run's rows go by each store's own code: the run's rows
// (stamped with the batch's one reading, the primitive's), then its trace lines and seals, then its
// failed attempts. The replay store keeps nothing per run, and the duplicate-webhook memory clears
// its own expired ids.
//
// After the batches, when at least one run was deleted: the free pages go back in steps of
// {@link VACUUM_STEP_PAGES} (`incremental_vacuum` through `exec()`: `run()` and `get()` free one page),
// each step checking that the free-page count fell by its size or to zero; then one TRUNCATE
// checkpoint. Both run with no transaction (a checkpoint cannot run inside one). With `secure_delete`
// FAST (the open sets it), the vacuum and a checkpoint that completes leave no text of a deleted run
// readable in `realm.db` or `realm.db-wal`. A checkpoint another process blocks answers `busy: 1`;
// it is tried once and carried, the deletes stand.
//
// Failures: a failure of a batch's own statements, or a COMMIT that did not land, fails that batch's
// runs with the per-run delete-failure rule's error and the next batch runs. A refusal of the
// primitive (a store busy past its budget, writes fenced, a file a newer Realm migrated, a COMMIT
// whose outcome is unknown) stops the purge: it resolves with the refusal and the runs not attempted,
// and the batches already committed stand. A vacuum or a checkpoint that fails is carried in the
// report; it never hides the deletes.
//
// The figures: each deleted run's bytes are the three stores' own measures (unit 14's
// `storedBytesOfRun`, the trace rows' bytes, the failed attempts' stored size), so a preview of an
// unchanged run equals its receipt; `stored_bytes_deleted` sums them. `file_bytes_reclaimed` is the
// store file's size on disk before the first batch minus its size after the checkpoint, never
// negative. Pages of a deleted run still in the log, never checkpointed, do not show in it: it is a
// floor.
import { statSync } from 'node:fs';
import type { WorkflowError } from '@sensigo/realm';
import {
  deleteFailure,
  isOwnStatementFailure,
  type RowsDeleted,
} from './artifact-delete-failure.js';
import type { RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';
import {
  ARTIFACT as FAILED_ATTEMPTS,
  deleteFailedAttemptRowsOfRun,
} from './failed-attempt-store.js';
import { ARTIFACT as RUNS, deleteRunIfDeletable } from './run-store.js';
import { ARTIFACT as TRACE_BUFFER, deleteTraceRowsOfRun } from './trace-buffer-store.js';

/** How many runs one batch deletes, in one write transaction (design §8: ≤ 39.7 ms per 100 runs). */
export const PURGE_BATCH_RUNS = 100;

/** How many free pages one vacuum step returns to the file system (4 MiB at the store's 16 KiB pages). */
export const VACUUM_STEP_PAGES = 256;

/** The name a purge's delete failure gives as its store. */
const STORE = 'RealmHome.purge';

/** One run the caller selected, with the version it was selected at. */
export interface PurgeSelection {
  readonly runId: string;
  readonly version: number;
}

/** What the purge did with one run it attempted. */
export type PurgeRunOutcome =
  /** Deleted: its bytes, the three stores' receipts. */
  | { readonly runId: string; readonly outcome: 'purged'; readonly bytes_deleted: number }
  /** Not there when its batch read it (something else deleted it first): nothing written. */
  | { readonly runId: string; readonly outcome: 'already_gone' }
  /**
   * Refused in unit 14's words, nothing of it deleted: `STATE_SNAPSHOT_MISMATCH` (its version moved
   * since it was selected) or `STATE_RUN_BUSY` (`no_longer_terminal`, `drain_pending`).
   */
  | { readonly runId: string; readonly outcome: 'blocked'; readonly error: WorkflowError }
  /** Its batch failed (core's `ENGINE_ARTIFACT_DELETE_FAILED`, naming the run): nothing of it deleted. */
  | { readonly runId: string; readonly outcome: 'failed'; readonly error: unknown };

/** The free pages' return: its steps, the pages returned, and its error when a step failed. */
export interface PurgeVacuum {
  readonly steps: number;
  readonly pages_returned: number;
  readonly error?: unknown;
}

/** The TRUNCATE checkpoint's answer (`busy: 1` when another process kept it from completing), or its error. */
export type PurgeCheckpoint =
  | { readonly busy: number; readonly log: number; readonly checkpointed: number }
  | { readonly error: unknown };

/** What the home's purge did. */
export interface PurgeReport {
  /** Each run attempted, in the order given (a stopped purge's refused and later runs are not here). */
  readonly runs: readonly PurgeRunOutcome[];
  /** The bytes the stores deleted, summed over the purged runs. */
  readonly stored_bytes_deleted: number;
  /** The store file's size on disk before the first batch minus after the checkpoint; never negative. */
  readonly file_bytes_reclaimed: number;
  /** The free pages' return; absent when no run was deleted. */
  readonly vacuum?: PurgeVacuum;
  /** The checkpoint's answer; absent when no run was deleted. */
  readonly checkpoint?: PurgeCheckpoint;
  /** A refusal that stopped the purge, and the runs not attempted (its batch's and every later one). */
  readonly stopped?: { readonly error: unknown; readonly not_attempted: readonly string[] };
}

/** One committed batch: its runs' outcomes and every deletion's check by content. */
interface BatchDone {
  readonly outcomes: PurgeRunOutcome[];
  readonly checks: RowsDeleted[];
}

/** A batch the primitive refused: the purge stops. */
class Stopped {
  constructor(readonly error: unknown) {}
}

/**
 * Deletes the selected runs on the home's primitive `db`, whose store file is `file` (see the module
 * comment). An empty selection writes nothing and runs no vacuum and no checkpoint.
 */
export async function purgeHome(
  db: RealmDb,
  file: string,
  selection: readonly PurgeSelection[],
): Promise<PurgeReport> {
  const runs: PurgeRunOutcome[] = [];
  if (selection.length === 0) return { runs, stored_bytes_deleted: 0, file_bytes_reclaimed: 0 };
  const sizeBefore = statSync(file).size;
  let stopped: PurgeReport['stopped'];
  for (let first = 0; first < selection.length; first += PURGE_BATCH_RUNS) {
    const batch = selection.slice(first, first + PURGE_BATCH_RUNS);
    const done = await purgeBatch(db, batch);
    if (done instanceof Stopped) {
      stopped = { error: done.error, not_attempted: selection.slice(first).map((s) => s.runId) };
      break;
    }
    runs.push(...done);
  }
  let deleted = 0;
  let any = false;
  for (const run of runs) {
    if (run.outcome !== 'purged') continue;
    deleted += run.bytes_deleted;
    any = true;
  }
  const after = { ...(stopped === undefined ? {} : { stopped }) };
  if (!any) return { runs, stored_bytes_deleted: 0, file_bytes_reclaimed: 0, ...after };
  const vacuum = await returnFreePages(db);
  const checkpoint = await resetLog(db);
  let sizeAfter: number;
  try {
    sizeAfter = statSync(file).size;
  } catch {
    // The file was there before the batches; a size that cannot be read now reports no shrink.
    sizeAfter = sizeBefore;
  }
  return {
    runs,
    stored_bytes_deleted: deleted,
    file_bytes_reclaimed: Math.max(0, sizeBefore - sizeAfter),
    vacuum,
    checkpoint,
    ...after,
  };
}

/**
 * One batch in ONE write transaction (see the module comment): its runs' outcomes once it committed;
 * every run `failed` when its own statements failed or its COMMIT did not land; {@link Stopped} when
 * the primitive refused it.
 */
async function purgeBatch(
  db: RealmDb,
  batch: readonly PurgeSelection[],
): Promise<PurgeRunOutcome[] | Stopped> {
  /** The artifact whose statement failed in the last attempt; a busy answer is the primitive's. */
  let failedArtifact: string | undefined;
  const own =
    (artifact: string) =>
    <R>(run: () => R): R => {
      try {
        return run();
      } catch (err) {
        if (isOwnStatementFailure(err)) failedArtifact = artifact;
        throw err;
      }
    };
  const runStatement = own(RUNS);
  try {
    const done = await db.immediate(
      (tx, reading): BatchDone => {
        failedArtifact = undefined;
        // The batch's one reading, the primitive's: every run it deletes is stamped with it.
        const at = reading.toISOString();
        const outcomes: PurgeRunOutcome[] = [];
        const checks: RowsDeleted[] = [];
        for (const { runId, version } of batch) {
          const judged = deleteRunIfDeletable(tx, runId, {
            expectVersion: version,
            stamp: () => at,
            statement: runStatement,
          });
          if (judged.kind === 'absent') {
            outcomes.push({ runId, outcome: 'already_gone' });
            continue;
          }
          if (judged.kind === 'refused') {
            outcomes.push({ runId, outcome: 'blocked', error: judged.error });
            continue;
          }
          const trace = own(TRACE_BUFFER)(() => deleteTraceRowsOfRun(tx, runId));
          const attempts = own(FAILED_ATTEMPTS)(() => deleteFailedAttemptRowsOfRun(tx, runId));
          outcomes.push({
            runId,
            outcome: 'purged',
            bytes_deleted: judged.bytes + trace.bytes + attempts.bytes,
          });
          checks.push(judged, trace, attempts);
        }
        return { outcomes, checks };
      },
      // Landed when every deletion's rows are gone: the runs' tombstones carry this batch's stamp.
      (tx, done) => done.checks.every((check) => check.gone(tx)),
    );
    return done.outcomes;
  } catch (err) {
    const ownFailed = failedArtifact !== undefined;
    const notLanded =
      (err as { commitOutcome?: { outcome?: unknown } } | null)?.commitOutcome?.outcome ===
      'not_landed';
    if (!ownFailed && !notLanded) return new Stopped(err);
    const artifact = failedArtifact ?? RUNS;
    return batch.map(({ runId }) => ({
      runId,
      outcome: 'failed',
      error: deleteFailure(err, ownFailed, { runId, store: STORE, artifact }),
    }));
  }
}

/** The connection's free-page count. */
function freePages(db: DatabaseLike): number {
  return Number(db.prepare('PRAGMA freelist_count').get()?.['freelist_count'] ?? 0);
}

/**
 * Returns the free pages to the file system in steps of {@link VACUUM_STEP_PAGES}, each with no
 * transaction, until none is left; a step whose free-page count did not fall by its size (or to zero)
 * ends the return with an error, carried.
 */
async function returnFreePages(db: RealmDb): Promise<PurgeVacuum> {
  let steps = 0;
  let returned = 0;
  try {
    for (;;) {
      const step = await db.autocommit((tx): number => {
        const before = freePages(tx);
        if (before === 0) return 0;
        // Through `exec()`: `run()` and `get()` free one page (the design's executed probe).
        tx.exec(`PRAGMA incremental_vacuum(${VACUUM_STEP_PAGES})`);
        const fell = before - freePages(tx);
        const expected = Math.min(VACUUM_STEP_PAGES, before);
        if (fell !== expected) {
          throw new Error(
            `A vacuum step returned ${fell} of ${expected} free pages (${before} were free).`,
          );
        }
        return fell;
      });
      if (step === 0) break;
      steps += 1;
      returned += step;
    }
    return { steps, pages_returned: returned };
  } catch (error) {
    return { steps, pages_returned: returned, error };
  }
}

/** One TRUNCATE checkpoint, with no transaction: its answer, or its error. Tried once. */
async function resetLog(db: RealmDb): Promise<PurgeCheckpoint> {
  try {
    const row = await db.autocommit((tx) => tx.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get());
    return {
      busy: Number(row?.['busy']),
      log: Number(row?.['log']),
      checkpointed: Number(row?.['checkpointed']),
    };
  } catch (error) {
    return { error };
  }
}
