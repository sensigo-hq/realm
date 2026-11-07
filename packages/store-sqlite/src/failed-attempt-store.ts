// failed-attempt-store.ts — issue #616 PR-1b B7 (page `PAGE-pr1b-cut.md`, unit B7): core's
// `FailedAttemptStore` on a SQLite home, with the JSON store's contract (`failed-attempt-store.ts` in
// core). `openRealmHome` builds the one store of a handle over the home's primitive; the package's
// entry does not export the class.
//
// A run's records are rows of `failed_attempts`, one caller-serialized line per row under the run's
// next `seq`, read back in `seq` order (the engine ranks a run's attempts by that order). A run's
// STORED SIZE is the sum, over its lines, of each line's UTF-8 length plus one: the JSON sidecar's size,
// each line with its newline. It decides the ceiling and is what `statAllForRun` and `deleteAllForRun`
// report, so a preview equals its receipt.
//
// The store reads no clock: a line carries the caller's own times. Every statement goes through the
// primitive: `append` and `deleteAllForRun` in one `immediate` each (with a `verify` that reads the
// rows back by content), `read` and `statAllForRun` in one `snapshot` each. One difference from the
// JSON store, stated: its append takes no lock, and this one takes the write lock like every write,
// on the awaited path of a step's failure. Under contention it waits up to the busy budget (5 s) and
// then gives up silently, as a failure to record does today.
import {
  artifactDeleteFailedError,
  brandClass,
  FAILED_ATTEMPT_SIDECAR_MAX_BYTES,
  WorkflowError,
  type ArtifactDeletionReport,
  type FailedAttemptReadResult,
  type FailedAttemptRecord,
  type FailedAttemptStore,
} from '@sensigo/realm';
import { REALM_STORE_SQLITE_BRAND } from './brand.js';
import type { RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';

/** The store's name in a delete failure, and the artifact it names. */
const STORE = 'SqliteFailedAttemptStore';
const ARTIFACT = 'failed_attempts';

/**
 * The refusals the primitive makes itself, which `deleteAllForRun` passes through unchanged: a busy
 * store after the busy budget (purge files it as blocked), writes fenced after a write of unknown
 * outcome, and a file a newer Realm migrated.
 */
const PRIMITIVE_REFUSALS: ReadonlySet<string> = new Set([
  'STATE_RUN_BUSY',
  'STATE_STORE_WRITES_FENCED',
  'STATE_STORE_VERSION_NEWER',
]);

/** SQLite's primary result codes by number (`errcode & 0xff`), the names SQLite gives them. */
const PRIMARY_RESULT_CODES: Readonly<Record<number, string>> = {
  1: 'SQLITE_ERROR',
  2: 'SQLITE_INTERNAL',
  3: 'SQLITE_PERM',
  4: 'SQLITE_ABORT',
  5: 'SQLITE_BUSY',
  6: 'SQLITE_LOCKED',
  7: 'SQLITE_NOMEM',
  8: 'SQLITE_READONLY',
  9: 'SQLITE_INTERRUPT',
  10: 'SQLITE_IOERR',
  11: 'SQLITE_CORRUPT',
  12: 'SQLITE_NOTFOUND',
  13: 'SQLITE_FULL',
  14: 'SQLITE_CANTOPEN',
  15: 'SQLITE_PROTOCOL',
  16: 'SQLITE_EMPTY',
  17: 'SQLITE_SCHEMA',
  18: 'SQLITE_TOOBIG',
  19: 'SQLITE_CONSTRAINT',
  20: 'SQLITE_MISMATCH',
  21: 'SQLITE_MISUSE',
  22: 'SQLITE_NOLFS',
  23: 'SQLITE_AUTH',
  24: 'SQLITE_FORMAT',
  25: 'SQLITE_RANGE',
  26: 'SQLITE_NOTADB',
  27: 'SQLITE_NOTICE',
  28: 'SQLITE_WARNING',
};

/** A run's stored size: each line's UTF-8 length plus one, summed (0 for a run with no rows). */
function storedSize(db: DatabaseLike, runId: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(octet_length(line) + 1), 0) AS size FROM failed_attempts WHERE run_id = ?',
    )
    .get(runId);
  return Number(row?.['size'] ?? 0);
}

/** One row of a run, by its `seq` and its line. */
interface Row {
  readonly seq: number;
  readonly line: string;
}

/** What one delete saw and removed: the rows by content, and their stored size. */
interface Deleted {
  readonly rows: readonly Row[];
  readonly bytes: number;
}

/** True when `runId` holds a row with this `seq` and this exact line. */
function holds(db: DatabaseLike, runId: string, row: Row): boolean {
  const stored = db
    .prepare('SELECT line FROM failed_attempts WHERE run_id = ? AND seq = ?')
    .get(runId, row.seq);
  return stored !== undefined && stored['line'] === row.line;
}

/**
 * The code a delete failure names: the mapped error's code when it is a `WorkflowError`, else the
 * name of SQLite's primary result code for the error's `errcode` (or its COMMIT outcome's).
 */
function failureCode(err: unknown): string {
  if (err instanceof WorkflowError) return err.code;
  const carried = err as { errcode?: unknown; commitOutcome?: { errcode?: unknown } } | null;
  const errcode = carried?.errcode ?? carried?.commitOutcome?.errcode;
  if (typeof errcode !== 'number') return 'UNKNOWN';
  return PRIMARY_RESULT_CODES[errcode & 0xff] ?? `SQLITE_${String(errcode & 0xff)}`;
}

/** SQLite's busy family (5 and its extended codes), as the primitive judges it. */
function isBusy(err: unknown): boolean {
  const errcode = (err as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === 'number' && (errcode & 0xff) === 5;
}

/** A COMMIT that failed and did not land: the mapped error carries its answer, `not_landed`. */
function isCommitNotLanded(err: unknown): boolean {
  const outcome = (err as { commitOutcome?: { outcome?: unknown } } | null)?.commitOutcome;
  return outcome?.outcome === 'not_landed';
}

/**
 * Core's failed-attempt store on a SQLite home (see the module comment). It is not an
 * `OrphanSweepableStore`: on SQLite, `realm db check` reports a run's rows left without their run.
 */
export class SqliteFailedAttemptStore implements FailedAttemptStore {
  readonly #db: RealmDb;

  /** Package-internal: `openRealmHome` builds the one store of a handle over the home's primitive. */
  constructor(db: RealmDb) {
    this.#db = db;
  }

  /**
   * Appends one already-serialized line for `runId`, at the run's next `seq`, in one write: when the
   * run's stored size is already at or above the ceiling (`FAILED_ATTEMPT_SIDECAR_MAX_BYTES`), it
   * writes nothing (append-and-stop). Best-effort: every error is swallowed, so a failed-attempt
   * record never fails the step it records.
   */
  async append(runId: string, line: string): Promise<void> {
    try {
      await this.#db.immediate(
        (db): Row | undefined => {
          if (storedSize(db, runId) >= FAILED_ATTEMPT_SIDECAR_MAX_BYTES) return undefined;
          const next = db
            .prepare(
              'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM failed_attempts WHERE run_id = ?',
            )
            .get(runId);
          const row: Row = { seq: Number(next?.['seq']), line };
          db.prepare('INSERT INTO failed_attempts (run_id, seq, line) VALUES (?, ?, ?)').run(
            runId,
            row.seq,
            row.line,
          );
          return row;
        },
        // Nothing was to land when the run was at its ceiling.
        (db, row) => row === undefined || holds(db, runId, row),
      );
    } catch {
      // Best-effort: recording a failed attempt never fails the step it records.
    }
  }

  /**
   * The run's records in `seq` order, each line parsed; a blank or unparseable line is skipped.
   * `capped` is true when the run's stored size is at or above the ceiling. A run with no rows reads
   * `{ records: [], capped: false }`; a read that fails rejects, never an empty result (#183).
   */
  async read(runId: string): Promise<FailedAttemptReadResult> {
    return this.#db.snapshot((db) => {
      const rows = db
        .prepare('SELECT line FROM failed_attempts WHERE run_id = ? ORDER BY seq')
        .all(runId);
      if (rows.length === 0) return { records: [], capped: false };
      const records: FailedAttemptRecord[] = [];
      for (const row of rows) {
        const trimmed = String(row['line']).trim();
        if (trimmed.length === 0) continue;
        try {
          records.push(JSON.parse(trimmed) as FailedAttemptRecord);
        } catch {
          // A torn or foreign line is skipped, as the JSON store skips it.
        }
      }
      return { records, capped: storedSize(db, runId) >= FAILED_ATTEMPT_SIDECAR_MAX_BYTES };
    });
  }

  /**
   * Deletes the run's rows in one write and reports their stored size; a run with no rows reports 0.
   * `dirEntries` and `expectVersion` are accepted and ignored (an artifact store; its guard is the
   * caller's). A failure of its own statements, or of its COMMIT, rejects with core's
   * `ENGINE_ARTIFACT_DELETE_FAILED` naming this store and the artifact `failed_attempts`; the
   * primitive's own refusals (`STATE_RUN_BUSY`, `STATE_STORE_WRITES_FENCED`,
   * `STATE_STORE_VERSION_NEWER`) pass through unchanged.
   */
  async deleteAllForRun(
    runId: string,
    _dirEntries?: readonly string[],
    _options?: { expectVersion?: number },
  ): Promise<ArtifactDeletionReport> {
    let ownStatementFailed = false;
    try {
      const deleted = await this.#db.immediate(
        (db): Deleted => {
          ownStatementFailed = false;
          try {
            const rows = db
              .prepare('SELECT seq, line FROM failed_attempts WHERE run_id = ?')
              .all(runId)
              .map((r) => ({ seq: Number(r['seq']), line: String(r['line']) }));
            const bytes = storedSize(db, runId);
            db.prepare('DELETE FROM failed_attempts WHERE run_id = ?').run(runId);
            return { rows, bytes };
          } catch (err) {
            // A busy answer is the primitive's to wait for and retry, not this delete's failure.
            ownStatementFailed = !isBusy(err);
            throw err;
          }
        },
        // Landed when no row it saw remains.
        (db, result) => result.rows.every((row) => !holds(db, runId, row)),
      );
      return { bytes_deleted: deleted.bytes };
    } catch (err) {
      if (err instanceof WorkflowError && PRIMITIVE_REFUSALS.has(err.code)) throw err;
      if (!ownStatementFailed && !isCommitNotLanded(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw artifactDeleteFailedError(
        runId,
        STORE,
        [],
        [{ artifact: ARTIFACT, code: failureCode(err), message }],
      );
    }
  }

  /**
   * The run's stored size, in one read: the bytes a `deleteAllForRun` of the unchanged run reports.
   * A read takes no write lock. A run with no rows is `{ bytes: 0 }`; a read that fails rejects.
   */
  async statAllForRun(runId: string, _dirEntries?: readonly string[]): Promise<{ bytes: number }> {
    return this.#db.snapshot((db) => ({ bytes: storedSize(db, runId) }));
  }
}

brandClass(
  SqliteFailedAttemptStore,
  Symbol.for('@sensigo/realm-store-sqlite/SqliteFailedAttemptStore'),
  REALM_STORE_SQLITE_BRAND,
);
