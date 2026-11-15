// outbound-ledger.ts — issue #597, D1c-1 and D1c-2 (design record `DESIGN-D1-rev5.md` §2): the
// `outbound` table of a SQLite home, schema version 2 (`store-schema-versions.ts`), and the ledger
// store over it, core's `OutboundLedger` (`SqliteOutboundLedger`, the run store's `outbound`).
// Package-internal: the package's entry does not export the class. D1c-1 gave the home's purge the
// table's one deleter, so a run's ledger rows go with it; the store's own `deleteAllForRun` calls it
// too.
//
// A run's STORED SIZE is the sum, over its rows, of the UTF-8 byte length of every text column but
// `run_id` (a NULL counts 0): what D1a's in-memory ledger measures (`bytesOf`), whose rows carry no
// run id. It is what the purge reports.
//
// The store re-implements no rule of the ledger: a lease or a mark checks the request (core's
// `checkOutboundRequest`) before its transaction, so a malformed one takes no reading; then ONE
// `immediate` reads the run's open question and the run's rows, calls core's pure `leaseOutbound` or
// `markOutbound` with the transaction's raw reading, and writes the row it returns. It never writes
// the run: no version or `updated_at` moves. `read` and the purge pair take no reading. A row is read
// as core's `OutboundEntry`: a plain object with a NULL column left out, never `null`.
import { isDeepStrictEqual } from 'node:util';
import {
  brandClass,
  checkOutboundRequest,
  leaseOutbound,
  markOutbound,
  openQuestionOf,
  type ArtifactDeletionReport,
  type OutboundEntry,
  type OutboundEntryView,
  type OutboundLeaseRequest,
  type OutboundLedger,
  type OutboundMarkRequest,
  type OutboundResult,
  type PendingGate,
  type RunRecord,
} from '@sensigo/realm';
import {
  deleteFailure,
  isOwnStatementFailure,
  type RowsDeleted,
} from './artifact-delete-failure.js';
import { REALM_STORE_SQLITE_BRAND } from './brand.js';
import type { RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';

/** The store's name in a delete failure. */
const STORE = 'SqliteOutboundLedger';

/** The table, as a delete failure names its artifact. */
export const ARTIFACT = 'outbound';

/** A run's stored size: every text column's UTF-8 length but `run_id`, summed (0 for no rows). */
function storedSize(db: DatabaseLike, runId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(
        COALESCE(octet_length(entry_key), 0) + COALESCE(octet_length(type), 0) +
        COALESCE(octet_length(status), 0) + COALESCE(octet_length(lease_token), 0) +
        COALESCE(octet_length(lease_deadline), 0) + COALESCE(octet_length(last_at), 0) +
        COALESCE(octet_length(last_outcome), 0) + COALESCE(octet_length(sent_at), 0) +
        COALESCE(octet_length(created_at), 0)), 0) AS size FROM outbound WHERE run_id = ?`,
    )
    .get(runId);
  return Number(row?.['size'] ?? 0);
}

/**
 * Deletes run `runId`'s rows in the caller's write transaction (the home's purge calls it): reads
 * their keys, measures their stored size and deletes them; its check is true when no key it saw
 * remains for the run. Synchronous; reads no clock; throws what SQLite throws, unmapped.
 */
export function deleteOutboundRowsOfRun(db: DatabaseLike, runId: string): RowsDeleted {
  const keys = db
    .prepare('SELECT entry_key FROM outbound WHERE run_id = ?')
    .all(runId)
    .map((r) => String(r['entry_key']));
  const bytes = storedSize(db, runId);
  db.prepare('DELETE FROM outbound WHERE run_id = ?').run(runId);
  return {
    bytes,
    gone: (check) =>
      keys.every(
        (key) =>
          check
            .prepare('SELECT 1 FROM outbound WHERE run_id = ? AND entry_key = ?')
            .get(runId, key) === undefined,
      ),
  };
}

/** The table's columns but `run_id`, in the order a row is written: core's `OutboundEntry` fields. */
const COLUMNS = [
  'entry_key',
  'type',
  'occurrence',
  'of_max',
  'status',
  'lease_token',
  'lease_deadline',
  'attempts',
  'last_at',
  'last_outcome',
  'sent_at',
  'created_at',
] as const;

const SELECT_ROWS = `SELECT ${COLUMNS.join(', ')} FROM outbound WHERE run_id = ?`;

/** Writes a row whole: a new key is inserted, a stored one gets every column replaced. */
const UPSERT =
  `INSERT INTO outbound (run_id, ${COLUMNS.join(', ')}) VALUES (?${', ?'.repeat(COLUMNS.length)}) ` +
  `ON CONFLICT (run_id, entry_key) DO UPDATE SET ` +
  COLUMNS.slice(1)
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');

/**
 * A row as core's `OutboundEntry`, the one row mapper: a plain object holding each column that has a
 * value, a NULL (or an unset field of a row core returned) left out. `lease_token` is kept: the pure
 * functions need it, and `read` drops it.
 */
function entryOf(row: object): OutboundEntry {
  const entry: Record<string, unknown> = {};
  for (const column of COLUMNS) {
    const value = (row as Readonly<Record<string, unknown>>)[column];
    if (value !== null && value !== undefined) entry[column] = value;
  }
  return entry as unknown as OutboundEntry;
}

/** The run's rows, in the caller's transaction. */
function rowsOf(db: DatabaseLike, runId: string): OutboundEntry[] {
  return db
    .prepare(SELECT_ROWS)
    .all(runId)
    .map((row) => entryOf(row));
}

/**
 * The run's open question, as core's `openQuestionOf` reads it from the run's stored core document:
 * none for a run that does not exist (or was purged), none for a sealed run. The document is read as
 * `run-store.ts`'s `readStoredCore` reads it; it is not imported from there (that would be a cycle).
 */
function openGateOf(db: DatabaseLike, runId: string): PendingGate | undefined {
  const row = db.prepare('SELECT record FROM runs WHERE id = ?').get(runId);
  if (row === undefined) return undefined;
  const core = JSON.parse(String(row['record'])) as RunRecord;
  return openQuestionOf(core) !== undefined ? core.pending_gate : undefined;
}

/** What core's pure function decided: the answer, and the row to store when it applied. */
interface Decided {
  readonly result: OutboundResult;
  readonly write?: OutboundEntry;
}

/** Stores the decided row, when there is one; an unset field is stored as NULL. */
function store(db: DatabaseLike, runId: string, decided: Decided): Decided {
  const write = decided.write as Readonly<Record<string, unknown>> | undefined;
  if (write !== undefined)
    db.prepare(UPSERT).run(runId, ...COLUMNS.map((column) => write[column] ?? null));
  return decided;
}

/**
 * The write's own check after an error at its COMMIT (the primitive's protocol): true when it wrote
 * nothing, or when the row read back equals the row written by value, through the one row mapper (an
 * unset field equals a NULL column). A check that said false for a row that is there would make the
 * call reject while its lease stands, and the sender would post a second time.
 */
function landed(db: DatabaseLike, runId: string, decided: Decided): boolean {
  if (decided.write === undefined) return true;
  const stored = db.prepare(`${SELECT_ROWS} AND entry_key = ?`).get(runId, decided.write.entry_key);
  return stored !== undefined && isDeepStrictEqual(entryOf(stored), entryOf(decided.write));
}

/**
 * Core's outbound ledger on a SQLite home (see the module comment): the run store's `outbound`, built
 * with it over the home's primitive.
 */
export class SqliteOutboundLedger implements OutboundLedger {
  readonly #db: RealmDb;

  /** Package-internal: the run store builds the one ledger of a handle over the home's primitive. */
  constructor(db: RealmDb) {
    this.#db = db;
  }

  /**
   * Leases one reminder or the escalation of the run's open question: core's `leaseOutbound`, in one
   * write transaction with its one raw reading. A run that does not exist answers `gate_not_open`.
   * A malformed request throws before the transaction; the primitive's refusals pass through.
   */
  async lease(runId: string, request: OutboundLeaseRequest): Promise<OutboundResult> {
    checkOutboundRequest('lease', request);
    const decided = await this.#db.immediate(
      (db, reading) =>
        store(db, runId, leaseOutbound(openGateOf(db, runId), rowsOf(db, runId), request, reading)),
      (db, done) => landed(db, runId, done),
    );
    return decided.result;
  }

  /**
   * Marks a leased reminder or escalation sent or failed: core's `markOutbound`, in one write
   * transaction with its one raw reading. A malformed request throws before the transaction; the
   * primitive's refusals pass through.
   */
  async mark(runId: string, request: OutboundMarkRequest): Promise<OutboundResult> {
    checkOutboundRequest('mark', request);
    const decided = await this.#db.immediate(
      (db, reading) => store(db, runId, markOutbound(rowsOf(db, runId), request, reading)),
      (db, done) => landed(db, runId, done),
    );
    return decided.result;
  }

  /**
   * The run's rows without their lease token, by `created_at` then `entry_key` in byte order, in one
   * read that takes no reading. A run with no rows, or none at all, reads `[]`.
   */
  async read(runId: string): Promise<OutboundEntryView[]> {
    return this.#db.snapshot(
      (db) =>
        db
          .prepare(`${SELECT_ROWS} ORDER BY created_at, entry_key`)
          .all(runId)
          .map((row) => {
            const { lease_token: _token, ...view } = entryOf(row);
            return view;
          }),
      { takesReading: false },
    );
  }

  /**
   * Deletes the run's rows in one write that takes no reading, and reports their stored size; a run
   * with no rows reports 0. `dirEntries` and `expectVersion` are accepted and ignored. A failure of
   * its own statements, or of its COMMIT, rejects with core's `ENGINE_ARTIFACT_DELETE_FAILED` naming
   * this store and the artifact `outbound`; the primitive's own refusals pass through unchanged.
   */
  async deleteAllForRun(
    runId: string,
    _dirEntries?: readonly string[],
    _options?: { expectVersion?: number },
  ): Promise<ArtifactDeletionReport> {
    let ownStatementFailed = false;
    try {
      const deleted = await this.#db.immediate(
        (db): RowsDeleted => {
          ownStatementFailed = false;
          try {
            return deleteOutboundRowsOfRun(db, runId);
          } catch (err) {
            // A busy answer is the primitive's to wait for and retry, not this delete's failure.
            ownStatementFailed = isOwnStatementFailure(err);
            throw err;
          }
        },
        // Landed when no row it saw remains.
        (db, result) => result.gone(db),
        { takesReading: false },
      );
      return { bytes_deleted: deleted.bytes };
    } catch (err) {
      throw deleteFailure(err, ownStatementFailed, { runId, store: STORE, artifact: ARTIFACT });
    }
  }

  /** The run's stored size, in one read that takes no reading: what a delete of it then reports. */
  async statAllForRun(runId: string, _dirEntries?: readonly string[]): Promise<{ bytes: number }> {
    return this.#db.snapshot((db) => ({ bytes: storedSize(db, runId) }), { takesReading: false });
  }
}

brandClass(
  SqliteOutboundLedger,
  Symbol.for('@sensigo/realm-store-sqlite/SqliteOutboundLedger'),
  REALM_STORE_SQLITE_BRAND,
);
