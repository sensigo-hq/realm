// trace-buffer-store.ts — issue #616 PR-1b B4 (design `pr1b/PAGE-1b-T-trace-buffer.md`; SEAMS S3, S4,
// S8, S9 and points 1, 7, 8, 11): the trace buffer on SQLite. Package-internal: `openRealmHome` hands
// it out as `RealmHome.traceBufferStore`; the package's entry exports no class.
//
// While a step runs, an agent writes progress lines into the step's buffer; when the step settles, the
// lines are sealed (kept with the run) or deleted. Each line is one `trace_buffer` row, numbered per
// step (`line_seq`) inside the write that adds it, so a step's lines read back in the order they were
// written whatever the clock said. A sealed artifact is one `trace_sealed` row holding the step's lines.
//
// The lock rule (the interface's own commitments): every method that writes, and `read`, runs in
// `immediate`, so it serialises with the fenced writes: a settle's read waits for an append in flight
// and sees it. `statAllForRun`, `listSealedForRun` and `readAllForRun` run in `snapshot`: the interface
// promises them lock-free, so a purge preview or an export never queues behind writers.
//
// A fenced method checks its fence in two places: the predicate's shape first, before any lock, and
// then the fence itself as the FIRST statement of its own transaction, against the run exactly as
// `readRunInTransaction` reassembles it. Its refusal is thrown unchanged, whatever its class.
//
// No clock: a line's `ts` is the write's one reading, which the primitive takes (`immediate`).
import {
  artifactDeleteFailedError,
  assertFencePredicate,
  brandClass,
  bufferFullError,
  checkBufferBudget,
  evaluateFence,
  flattenWalBatches,
  normalizeEntryForBuffer,
  BUFFER_BACKSTOP_BYTES,
  BUFFER_BACKSTOP_COUNT,
  BUFFER_LIMIT_BYTES,
  BUFFER_LIMIT_COUNT,
  FINAL_LIMIT_BYTES,
  FINAL_LIMIT_ENTRIES,
  SEALED_ARTIFACTS_LIMIT_PER_STEP,
  WorkflowError,
  type AgentTraceEntry,
  type AppendOptions,
  type AppendResult,
  type ArtifactDeletionReport,
  type BufferedEntry,
  type FencePredicate,
  type PerRunArtifactStore,
  type RunScopedFencePredicate,
  type SealedArtifact,
  type SealedWalLine,
  type SealResult,
  type TraceBufferStore,
  type TraceCapability,
} from '@sensigo/realm';
import { REALM_STORE_SQLITE_BRAND } from './brand.js';
import type { CommitOutcome, RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';
import { readRunInTransaction } from './run-rows.js';

/** The class's name in a delete failure: the store `artifactDeleteFailedError` names. */
const STORE_NAME = 'SqliteTraceBufferStore';

/** The artifact a per-run delete failure names. */
const ARTIFACT = 'trace_buffer';

/**
 * SQLite's primary result codes by number (sqlite.org/rescode.html), for a delete failure whose
 * mapped error has no typed code: it is named by its primary code (`errcode & 0xff`).
 */
const SQLITE_PRIMARY_CODES: ReadonlyMap<number, string> = new Map([
  [1, 'SQLITE_ERROR'],
  [2, 'SQLITE_INTERNAL'],
  [3, 'SQLITE_PERM'],
  [4, 'SQLITE_ABORT'],
  [5, 'SQLITE_BUSY'],
  [6, 'SQLITE_LOCKED'],
  [7, 'SQLITE_NOMEM'],
  [8, 'SQLITE_READONLY'],
  [9, 'SQLITE_INTERRUPT'],
  [10, 'SQLITE_IOERR'],
  [11, 'SQLITE_CORRUPT'],
  [12, 'SQLITE_NOTFOUND'],
  [13, 'SQLITE_FULL'],
  [14, 'SQLITE_CANTOPEN'],
  [15, 'SQLITE_PROTOCOL'],
  [16, 'SQLITE_EMPTY'],
  [17, 'SQLITE_SCHEMA'],
  [18, 'SQLITE_TOOBIG'],
  [19, 'SQLITE_CONSTRAINT'],
  [20, 'SQLITE_MISMATCH'],
  [21, 'SQLITE_MISUSE'],
  [22, 'SQLITE_NOLFS'],
  [23, 'SQLITE_AUTH'],
  [24, 'SQLITE_FORMAT'],
  [25, 'SQLITE_RANGE'],
  [26, 'SQLITE_NOTADB'],
  [27, 'SQLITE_NOTICE'],
  [28, 'SQLITE_WARNING'],
]);

const STEP_FIGURES = `SELECT
  COALESCE(SUM(entry_count), 0) AS file_count,
  COALESCE(SUM(bytes), 0) AS file_bytes,
  COALESCE(SUM(CASE WHEN nonce IS ? THEN entry_count END), 0) AS writer_count,
  COALESCE(SUM(CASE WHEN nonce IS ? THEN bytes END), 0) AS writer_bytes,
  COALESCE(MAX(line_seq) + 1, 0) AS next_seq
FROM trace_buffer WHERE run_id = ? AND step_id = ?`;
const INSERT_LINE = `INSERT INTO trace_buffer (run_id, step_id, line_seq, ts, nonce, entries, entry_count, bytes)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const STEP_LINES = `SELECT step_id, line_seq, ts, nonce, entries, entry_count, bytes FROM trace_buffer
WHERE run_id = ? AND step_id = ? ORDER BY line_seq`;
const RUN_LINES = `SELECT step_id, line_seq, ts, nonce, entries, entry_count, bytes FROM trace_buffer
WHERE run_id = ? ORDER BY step_id, line_seq`;
const LINE_AT =
  'SELECT ts, nonce, entries FROM trace_buffer WHERE run_id = ? AND step_id = ? AND line_seq = ?';
const DELETE_STEP_LINES = 'DELETE FROM trace_buffer WHERE run_id = ? AND step_id = ?';
const DELETE_RUN_LINES = 'DELETE FROM trace_buffer WHERE run_id = ?';
const STEP_SEALS = `SELECT COUNT(*) AS seals, COALESCE(MAX(seal_seq) + 1, 0) AS next_seq FROM trace_sealed
WHERE run_id = ? AND step_id = ?`;
const INSERT_SEAL =
  'INSERT INTO trace_sealed (run_id, step_id, seal_seq, lines, bytes) VALUES (?, ?, ?, ?, ?)';
const RUN_SEALS = `SELECT step_id, seal_seq, lines, bytes FROM trace_sealed WHERE run_id = ?
ORDER BY step_id, seal_seq`;
const SEAL_AT =
  'SELECT lines, bytes FROM trace_sealed WHERE run_id = ? AND step_id = ? AND seal_seq = ?';
const DELETE_RUN_SEALS = 'DELETE FROM trace_sealed WHERE run_id = ?';
const RUN_BYTES = `SELECT (SELECT COALESCE(SUM(bytes), 0) FROM trace_buffer WHERE run_id = ?)
  + (SELECT COALESCE(SUM(bytes), 0) FROM trace_sealed WHERE run_id = ?) AS bytes`;

/** One stored line, as its row holds it. */
interface LineRow {
  readonly stepId: string;
  readonly seq: number;
  readonly ts: number;
  readonly nonce: string | null;
  /** The entries' stored JSON text. */
  readonly entries: string;
  readonly entryCount: number;
  readonly bytes: number;
}

/** One sealed artifact, as its row holds it. */
interface SealRow {
  readonly stepId: string;
  readonly seq: number;
  /** The lines' stored JSON text. */
  readonly lines: string;
  readonly bytes: number;
}

/** The rows a delete saw, so its `verify` can tell they are gone. */
interface SeenRows {
  readonly lines: readonly LineRow[];
  readonly seals: readonly SealRow[];
}

function lineRow(row: Record<string, unknown>): LineRow {
  return {
    stepId: String(row['step_id']),
    seq: Number(row['line_seq']),
    ts: Number(row['ts']),
    nonce: row['nonce'] === null ? null : String(row['nonce']),
    entries: String(row['entries']),
    entryCount: Number(row['entry_count']),
    bytes: Number(row['bytes']),
  };
}

function sealRow(row: Record<string, unknown>): SealRow {
  return {
    stepId: String(row['step_id']),
    seq: Number(row['seal_seq']),
    lines: String(row['lines']),
    bytes: Number(row['bytes']),
  };
}

/**
 * A stored line as the JSON store writes it: `{ ts, entries, nonce }`, keys in that order. A line
 * written without a nonce has no `nonce` key: a NULL column never becomes `nonce: null`, which export
 * reads as a live writer's nonce.
 */
function lineOf(row: LineRow): SealedWalLine {
  const entries = JSON.parse(row.entries) as AgentTraceEntry[];
  return row.nonce === null ? { ts: row.ts, entries } : { ts: row.ts, entries, nonce: row.nonce };
}

/** A line's size, measured as the JSON store measures it: its JSON text and the newline after it. */
function lineBytes(line: SealedWalLine): number {
  return Buffer.byteLength(JSON.stringify(line) + '\n');
}

function stepLines(db: DatabaseLike, runId: string, stepId: string): LineRow[] {
  return db.prepare(STEP_LINES).all(runId, stepId).map(lineRow);
}

/** Whether the line at `row`'s place still holds `row`'s content: compared by content, never by place. */
function lineStillThere(db: DatabaseLike, runId: string, row: LineRow): boolean {
  const at = db.prepare(LINE_AT).get(runId, row.stepId, row.seq);
  return (
    at !== undefined &&
    Number(at['ts']) === row.ts &&
    (at['nonce'] === null ? null : String(at['nonce'])) === row.nonce &&
    String(at['entries']) === row.entries
  );
}

function sealStillThere(db: DatabaseLike, runId: string, row: SealRow): boolean {
  const at = db.prepare(SEAL_AT).get(runId, row.stepId, row.seq);
  return at !== undefined && String(at['lines']) === row.lines && Number(at['bytes']) === row.bytes;
}

/** A delete's `verify`: no row it saw remains. */
function noneRemain(db: DatabaseLike, runId: string, seen: SeenRows): boolean {
  return (
    !seen.lines.some((row) => lineStillThere(db, runId, row)) &&
    !seen.seals.some((row) => sealStillThere(db, runId, row))
  );
}

/** Whether `err` is SQLite's busy answer (5 and its extended codes), which the primitive waits out. */
function isBusy(err: unknown): boolean {
  const errcode = (err as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === 'number' && (errcode & 0xff) === 5;
}

/** The rejection a per-run delete answers with when its own COMMIT did not land. */
function commitNotLanded(err: unknown): CommitOutcome | undefined {
  const outcome = (err as { commitOutcome?: CommitOutcome } | null)?.commitOutcome;
  return outcome?.outcome === 'not_landed' ? outcome : undefined;
}

/**
 * The per-run delete's failure, as the artifact contract's typed-rejection law reads it: `code` is the
 * mapped error's code when it is a `WorkflowError`, else the name of SQLite's primary result code;
 * `message` is the mapped message.
 */
function deleteFailed(runId: string, err: unknown, outcome?: CommitOutcome): WorkflowError {
  const errcode = (err as { errcode?: unknown } | null)?.errcode ?? outcome?.errcode;
  const primary =
    typeof errcode === 'number' ? SQLITE_PRIMARY_CODES.get(errcode & 0xff) : undefined;
  const code = err instanceof WorkflowError ? err.code : (primary ?? 'UNKNOWN');
  const message = err instanceof Error ? err.message : String(err);
  return artifactDeleteFailedError(runId, STORE_NAME, [], [{ artifact: ARTIFACT, code, message }]);
}

/**
 * The trace buffer on SQLite: `TraceBufferStore` (every method, the optional ones included, so it
 * declares `seal` and `writer_nonce_carriage`) and `PerRunArtifactStore`, over the home's one
 * `RealmDb`.
 */
export class SqliteTraceBufferStore implements TraceBufferStore, PerRunArtifactStore {
  readonly traceCapabilities: ReadonlySet<TraceCapability> = new Set([
    'seal',
    'writer_nonce_carriage',
  ]);

  readonly #db: RealmDb;

  constructor(db: RealmDb) {
    this.#db = db;
  }

  /**
   * Adds one line for (runId, stepId): the entries after core's buffer normaliser, stamped with the
   * write's one reading, numbered after the step's last line. The per-writer and per-step budgets refuse
   * with `BUFFER_FULL` at the JSON store's byte thresholds; an append whose entries all normalise away
   * writes nothing and returns the current figures.
   */
  append(
    runId: string,
    stepId: string,
    entries: AgentTraceEntry[],
    options?: AppendOptions,
  ): Promise<AppendResult> {
    return this.#append(runId, stepId, entries, options?.writerNonce, undefined);
  }

  /** `append`, with `fence` checked first in the same transaction (see the module comment). */
  appendFenced(
    runId: string,
    stepId: string,
    entries: AgentTraceEntry[],
    fence: FencePredicate,
    options?: AppendOptions,
  ): Promise<AppendResult> {
    try {
      assertFencePredicate(fence, stepId);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.#append(runId, stepId, entries, options?.writerNonce, fence);
  }

  /** The step's entries in the order their lines were written, each with its line's `ts` (and nonce). */
  read(runId: string, stepId: string): Promise<BufferedEntry[]> {
    return this.#db.immediate(
      (db) => flattenWalBatches(stepLines(db, runId, stepId).map(lineOf)),
      () => true,
      { takesReading: false },
    );
  }

  /** Deletes the step's lines (not its sealed artifacts). */
  async delete(runId: string, stepId: string): Promise<void> {
    await this.#deleteStep(runId, stepId, undefined);
  }

  /**
   * Deletes the step's lines (not its sealed artifacts) when `fence` holds, and returns how many
   * ENTRIES they held: reclaim prints it as "cleared N buffered trace entries".
   */
  deleteFenced(runId: string, stepId: string, fence: FencePredicate): Promise<number> {
    try {
      assertFencePredicate(fence, stepId);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.#deleteStep(runId, stepId, fence);
  }

  /**
   * Seals the step's lines when `fence` holds, in the JSON store's order of checks: no line →
   * `absent`; the step already holds the per-step seal limit → `capped`; otherwise the lines are kept
   * as one sealed artifact, in order, and deleted from the buffer, in one transaction.
   */
  sealFenced(runId: string, stepId: string, fence: FencePredicate): Promise<SealResult> {
    try {
      assertFencePredicate(fence, stepId);
    } catch (err) {
      return Promise.reject(err);
    }
    let sealed: { seal: SealRow; lines: readonly LineRow[] } | undefined;
    return this.#db.immediate(
      (db): SealResult => {
        sealed = undefined;
        evaluateFence(fence, readRunInTransaction(db, runId), runId, stepId);
        const lines = stepLines(db, runId, stepId);
        if (lines.length === 0) return { sealed: false, reason: 'absent' };
        const seals = db.prepare(STEP_SEALS).get(runId, stepId);
        if (Number(seals?.['seals']) >= SEALED_ARTIFACTS_LIMIT_PER_STEP) {
          return { sealed: false, reason: 'capped' };
        }
        const seal: SealRow = {
          stepId,
          seq: Number(seals?.['next_seq']),
          lines: JSON.stringify(lines.map(lineOf)),
          bytes: lines.reduce((sum, line) => sum + line.bytes, 0),
        };
        db.prepare(INSERT_SEAL).run(runId, stepId, seal.seq, seal.lines, seal.bytes);
        db.prepare(DELETE_STEP_LINES).run(runId, stepId);
        sealed = { seal, lines };
        return { sealed: true };
      },
      // The sealed row is the one written, and no line it sealed remains (a line another writer
      // appended afterwards does not count).
      (db) =>
        sealed === undefined ||
        (sealStillThere(db, runId, sealed.seal) &&
          !sealed.lines.some((line) => lineStillThere(db, runId, line))),
      { takesReading: false },
    );
  }

  /** Every sealed artifact of the run, by step, then seq. Lock-free. */
  listSealedForRun(runId: string): Promise<SealedArtifact[]> {
    return this.#db.snapshot((db) =>
      db
        .prepare(RUN_SEALS)
        .all(runId)
        .map(sealRow)
        .map((row) => ({
          step_id: row.stepId,
          seq: row.seq,
          lines: JSON.parse(row.lines) as SealedWalLine[],
        })),
    );
  }

  /**
   * Every live line of the run, keyed by step: the line objects `{ ts, entries, nonce }` in the order
   * they were written, the JSON store's shape. A step with no line has no key. Lock-free.
   */
  readAllForRun(runId: string): Promise<Record<string, unknown[]>> {
    return this.#db.snapshot((db) => {
      const result: Record<string, unknown[]> = {};
      for (const row of db.prepare(RUN_LINES).all(runId).map(lineRow)) {
        (result[row.stepId] ??= []).push(lineOf(row));
      }
      return result;
    });
  }

  /** The bytes of the run's live lines and sealed artifacts. Lock-free. */
  statAllForRun(runId: string, _dirEntries?: readonly string[]): Promise<{ bytes: number }> {
    return this.#db.snapshot((db) => ({
      bytes: Number(db.prepare(RUN_BYTES).get(runId, runId)?.['bytes']),
    }));
  }

  /**
   * Deletes the run's lines and sealed artifacts and reports their bytes. `dirEntries` and
   * `expectVersion` are ignored, as the interface says every artifact store does.
   */
  deleteAllForRun(
    runId: string,
    _dirEntries?: readonly string[],
    _options?: { expectVersion?: number },
  ): Promise<ArtifactDeletionReport> {
    return this.#deleteRun(runId, undefined);
  }

  /** `deleteAllForRun`, when `fence` holds: checked once, for the run, first in the transaction. */
  deleteAllForRunFenced(
    runId: string,
    fence: RunScopedFencePredicate,
    _dirEntries?: readonly string[],
  ): Promise<ArtifactDeletionReport> {
    try {
      assertFencePredicate(fence);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.#deleteRun(runId, fence);
  }

  #append(
    runId: string,
    stepId: string,
    entries: AgentTraceEntry[],
    writerNonce: string | undefined,
    fence: FencePredicate | undefined,
  ): Promise<AppendResult> {
    const normalized = entries
      .map((entry) => normalizeEntryForBuffer(entry))
      .filter((entry): entry is AgentTraceEntry => entry !== null);
    const nonce = writerNonce ?? null;
    let written: LineRow | undefined;
    return this.#db.immediate(
      (db, reading): AppendResult => {
        written = undefined;
        if (fence !== undefined) {
          evaluateFence(fence, readRunInTransaction(db, runId), runId, stepId);
        }
        const figures = db.prepare(STEP_FIGURES).get(nonce, nonce, runId, stepId) ?? {};
        const writerCountBefore = Number(figures['writer_count']);
        const writerBytesBefore = Number(figures['writer_bytes']);
        const fileCountBefore = Number(figures['file_count']);
        const fileBytesBefore = Number(figures['file_bytes']);
        if (normalized.length === 0) {
          return appendResult(
            writerCountBefore,
            writerBytesBefore,
            fileCountBefore,
            fileBytesBefore,
          );
        }
        const line: SealedWalLine =
          writerNonce === undefined
            ? { ts: reading.getTime(), entries: normalized }
            : { ts: reading.getTime(), entries: normalized, nonce: writerNonce };
        const bytes = lineBytes(line);
        const after = {
          writerCount: writerCountBefore + normalized.length,
          writerBytes: writerBytesBefore + bytes,
          fileCount: fileCountBefore + normalized.length,
          fileBytes: fileBytesBefore + bytes,
        };
        const overflow = checkBufferBudget({
          writerCountBefore,
          writerBytesBefore,
          writerCountAfter: after.writerCount,
          writerBytesAfter: after.writerBytes,
          fileCountBefore,
          fileBytesBefore,
          fileCountAfter: after.fileCount,
          fileBytesAfter: after.fileBytes,
        });
        if (overflow !== undefined) throw bufferFullError(overflow);
        const row: LineRow = {
          stepId,
          seq: Number(figures['next_seq']),
          ts: line.ts,
          nonce,
          entries: JSON.stringify(normalized),
          entryCount: normalized.length,
          bytes,
        };
        db.prepare(INSERT_LINE).run(
          runId,
          stepId,
          row.seq,
          row.ts,
          row.nonce,
          row.entries,
          row.entryCount,
          row.bytes,
        );
        written = row;
        return appendResult(after.writerCount, after.writerBytes, after.fileCount, after.fileBytes);
      },
      // The line at its number holds this write's content (review R5: never its place alone).
      (db) => written === undefined || lineStillThere(db, runId, written),
    );
  }

  #deleteStep(runId: string, stepId: string, fence: FencePredicate | undefined): Promise<number> {
    let seen: SeenRows = { lines: [], seals: [] };
    return this.#db.immediate(
      (db) => {
        seen = { lines: [], seals: [] };
        if (fence !== undefined) {
          evaluateFence(fence, readRunInTransaction(db, runId), runId, stepId);
        }
        const lines = stepLines(db, runId, stepId);
        db.prepare(DELETE_STEP_LINES).run(runId, stepId);
        seen = { lines, seals: [] };
        return lines.reduce((sum, line) => sum + line.entryCount, 0);
      },
      (db) => noneRemain(db, runId, seen),
      { takesReading: false },
    );
  }

  /**
   * The per-run delete. A failure of its own statements (the reads of the rows it deletes, and the
   * deletes), or a COMMIT that did not land, rejects with `artifactDeleteFailedError`; everything else
   * passes through unchanged: a fence refusal of either class, a failure of the fence's run read, and
   * the primitive's own refusals.
   */
  async #deleteRun(
    runId: string,
    fence: RunScopedFencePredicate | undefined,
  ): Promise<ArtifactDeletionReport> {
    let seen: SeenRows = { lines: [], seals: [] };
    let statementFailed = false;
    try {
      return await this.#db.immediate(
        (db) => {
          seen = { lines: [], seals: [] };
          statementFailed = false;
          if (fence !== undefined) evaluateFence(fence, readRunInTransaction(db, runId), runId);
          let lines: LineRow[];
          let seals: SealRow[];
          try {
            // The reads of the rows it deletes are the delete's own statements too (MA 4, 2026-11-07).
            lines = db.prepare(RUN_LINES).all(runId).map(lineRow);
            seals = db.prepare(RUN_SEALS).all(runId).map(sealRow);
            db.prepare(DELETE_RUN_LINES).run(runId);
            db.prepare(DELETE_RUN_SEALS).run(runId);
          } catch (err) {
            // A busy answer is the primitive's to wait out, not a failed delete.
            statementFailed = !isBusy(err);
            throw err;
          }
          seen = { lines, seals };
          const bytes = [...lines, ...seals].reduce((sum, row) => sum + row.bytes, 0);
          return { bytes_deleted: bytes };
        },
        (db) => noneRemain(db, runId, seen),
        { takesReading: false },
      );
    } catch (err) {
      const notLanded = commitNotLanded(err);
      if (statementFailed || notLanded !== undefined) throw deleteFailed(runId, err, notLanded);
      throw err;
    }
  }
}

function appendResult(
  writerCount: number,
  writerBytes: number,
  fileCount: number,
  fileBytes: number,
): AppendResult {
  return {
    buffer_count: writerCount,
    buffer_bytes: writerBytes,
    limit_count: BUFFER_LIMIT_COUNT,
    limit_bytes: BUFFER_LIMIT_BYTES,
    final_limit_entries: FINAL_LIMIT_ENTRIES,
    final_limit_bytes: FINAL_LIMIT_BYTES,
    file_count: fileCount,
    file_bytes: fileBytes,
    file_limit_count: BUFFER_BACKSTOP_COUNT,
    file_limit_bytes: BUFFER_BACKSTOP_BYTES,
  };
}

brandClass(
  SqliteTraceBufferStore,
  Symbol.for('@sensigo/realm-store-sqlite/SqliteTraceBufferStore'),
  REALM_STORE_SQLITE_BRAND,
);
