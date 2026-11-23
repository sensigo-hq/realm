// callback-store.ts — callback B1a and B1b (R1.3): the `callbacks` table of a SQLite home (store
// format 3), and the rows store over it, core's `CallbackStore` (`SqliteCallbackStore`, the run store's
// `callbacks`, with B1a's `SqliteCallbackKeys` as its `keys`). Package-internal: the package's entry
// does not export it. B1a gave the home's purge the table's one deleter, so a run's row goes in the
// run's own purge transaction; the store's own `deleteAllForRun` calls it too.
//
// `create` writes a run's row in the same transaction as the run (`run-store.ts`, through
// `callbackRowFor` and `storeCallbackRow`). A run's STORED SIZE is the UTF-8 byte length of its row's
// `url` and `body` (a NULL counts 0), what core's in-memory callback store measures, and what the
// purge reports.
//
// The store re-implements no rule: `claim`, `freezeBody` and `mark` check the request (core's
// `checkCallbackRequest`) before their transaction, so a malformed one takes no reading; then ONE
// write transaction reads the row (and, for a claim, the run), calls core's pure function, and writes
// the row it returns. `due` is one read with its one reading: a single statement that applies core's
// rule (`dueCallbacks`), byte order for text. A row is read as core's `CallbackRow`: a NULL column
// left out, never `null`; `last_status` keeps its type (the column's INTEGER affinity keeps a number a
// number and a word a word).
import { isDeepStrictEqual } from 'node:util';
import {
  brandClass,
  CALLBACK_DELIVERY_WINDOW_SECONDS,
  callbackRowOf,
  callbackViewOf,
  checkCallbackRequest,
  claimCallback,
  endOverdueCallbacks,
  freezeCallbackBody,
  markCallback,
  WorkflowError,
  type ArtifactDeletionReport,
  type CallbackClaimRequest,
  type CallbackClaimResult,
  type CallbackEnded,
  type CallbackFreezeResult,
  type CallbackItem,
  type CallbackKeyStore,
  type CallbackMarkRequest,
  type CallbackMarkResult,
  type CallbackRegistration,
  type CallbackRow,
  type CallbackStore,
  type CallbackView,
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
const STORE = 'SqliteCallbackStore';

/** The table, as a delete failure names its artifact. */
export const ARTIFACT = 'callbacks';

const SIZE =
  'SELECT COALESCE(octet_length(url), 0) + COALESCE(octet_length(body), 0) AS size FROM callbacks WHERE run_id = ?';

/** A run's stored size, in the caller's transaction (0 for no row). */
function storedSize(db: DatabaseLike, runId: string): number {
  return Number(db.prepare(SIZE).get(runId)?.['size'] ?? 0);
}

/**
 * Deletes run `runId`'s callback row in the caller's write transaction (the home's purge calls it,
 * and so does {@link SqliteCallbackStore.deleteAllForRun}), after measuring its stored size; its check
 * is true when the run has no row left. Synchronous; reads no clock; throws what SQLite throws.
 */
export function deleteCallbackRowsOfRun(db: DatabaseLike, runId: string): RowsDeleted {
  const bytes = storedSize(db, runId);
  db.prepare('DELETE FROM callbacks WHERE run_id = ?').run(runId);
  return {
    bytes,
    gone: (check) =>
      check.prepare('SELECT 1 FROM callbacks WHERE run_id = ?').get(runId) === undefined,
  };
}

/** The table's columns, in the order a row is written: core's `CallbackRow` fields. */
const COLUMNS = [
  'run_id',
  'workflow_id',
  'host',
  'webhook_id',
  'status',
  'attempts',
  'created_at',
  'next_attempt_at',
  'first_attempt_at',
  'finished_at',
  'last_attempt_at',
  'last_status',
  'url',
  'body',
  'claim_token',
] as const;

const SELECT_ROW = `SELECT ${COLUMNS.join(', ')} FROM callbacks WHERE run_id = ?`;

/** Writes a row whole: a new run's row is inserted, a stored one gets every column replaced. */
const UPSERT =
  `INSERT INTO callbacks (${COLUMNS.join(', ')}) VALUES (?${', ?'.repeat(COLUMNS.length - 1)}) ` +
  'ON CONFLICT (run_id) DO UPDATE SET ' +
  COLUMNS.slice(1)
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');

/**
 * What is due at the reading (core's `dueCallbacks`, in one statement): pending, `next_attempt_at` at
 * or before the reading, the run there and finished; one row per host per round, within a host by
 * (`next_attempt_at`, `run_id`), within a round by (that row's `next_attempt_at`, `host`).
 */
const DUE = `SELECT run_id, workflow_id, host, url, webhook_id, attempts, next_attempt_at, body FROM (
  SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.host ORDER BY c.next_attempt_at, c.run_id) AS round
  FROM callbacks c JOIN runs r ON r.id = c.run_id
  WHERE c.status = 'pending' AND c.next_attempt_at <= ? AND r.terminal_state IS 1
) ORDER BY round, next_attempt_at, host LIMIT ?`;

/** Callback C3d: how many rows wait to be sent (core's `countWaitingCallbacks`): pending, run finished. */
const WAITING = `SELECT count(*) AS n FROM callbacks c JOIN runs r ON r.id = c.run_id
  WHERE c.status = 'pending' AND r.terminal_state IS 1`;

/**
 * Callback C3d: the rows `endOverdue` may end (core's `endOverdueCallbacks` decides): pending, due at
 * the reading, the run there and finished, and the anchor (`finished_at`, else the run's
 * `updated_at`) at or before the cutoff, 3 days before the reading; oldest anchor first, then
 * `run_id`. Every stamp is `toISOString()` text, so text order is time order.
 */
const OVERDUE = `SELECT ${COLUMNS.map((column) => `c.${column}`).join(', ')},
  r.terminal_state AS run_terminal, r.updated_at AS run_updated_at
  FROM callbacks c JOIN runs r ON r.id = c.run_id
  WHERE c.status = 'pending' AND c.next_attempt_at <= ? AND r.terminal_state IS 1
    AND COALESCE(c.finished_at, r.updated_at) <= ?
  ORDER BY COALESCE(c.finished_at, r.updated_at), c.run_id LIMIT ?`;

/** A row as core's `CallbackRow`: each column that has a value, a NULL left out. */
function rowOf(row: object): CallbackRow {
  const out: Record<string, unknown> = {};
  for (const column of COLUMNS) {
    const value = (row as Readonly<Record<string, unknown>>)[column];
    if (value !== null && value !== undefined) out[column] = value;
  }
  return out as unknown as CallbackRow;
}

/** The run's row, in the caller's transaction. */
function readRow(db: DatabaseLike, runId: string): CallbackRow | undefined {
  const row = db.prepare(SELECT_ROW).get(runId);
  return row === undefined ? undefined : rowOf(row);
}

/** Writes `row` whole, in the caller's transaction; an unset field is stored as NULL. */
export function storeCallbackRow(db: DatabaseLike, row: CallbackRow): void {
  const values = row as unknown as Readonly<Record<string, unknown>>;
  db.prepare(UPSERT).run(...COLUMNS.map((column) => values[column] ?? null));
}

/**
 * The row `create` writes beside `record` in its transaction, stamped `at` (the run's own
 * `created_at`), or none without a callback. Checked first: a `webhook_id` another row holds is
 * refused with `VALIDATION_OPTION_INVALID` before the run or the row is written, as the in-memory
 * store refuses it (the UNIQUE index is the backstop). Writes nothing itself.
 */
export function callbackRowFor(
  db: DatabaseLike,
  record: RunRecord,
  callback: CallbackRegistration | undefined,
  at: Date,
): CallbackRow | undefined {
  if (callback === undefined) return undefined;
  if (db.prepare('SELECT 1 FROM callbacks WHERE webhook_id = ?').get(callback.webhook_id)) {
    throw new WorkflowError(
      'This `callback.webhook_id` is already registered; no run was created.',
      {
        code: 'VALIDATION_OPTION_INVALID',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        retryable: false,
      },
    );
  }
  return callbackRowOf(record.id, record.workflow_id, callback, at);
}

/** Whether `row` is stored as written (the COMMIT-outcome check of `create` and of the writes). */
export function callbackRowLanded(db: DatabaseLike, row: CallbackRow): boolean {
  const stored = readRow(db, row.run_id);
  return stored !== undefined && isDeepStrictEqual(stored, rowOf(row));
}

/** What a pure function decided: the answer, and the row to store when it applied. */
interface Decided<R> {
  readonly result: R;
  readonly write?: CallbackRow;
}

/** Stores the decided row, when there is one. */
function store<R>(db: DatabaseLike, decided: Decided<R>): Decided<R> {
  if (decided.write !== undefined) storeCallbackRow(db, decided.write);
  return decided;
}

/** The write's own check after an error at its COMMIT: nothing written, or the row as written. */
const landed = <R>(db: DatabaseLike, decided: Decided<R>): boolean =>
  decided.write === undefined || callbackRowLanded(db, decided.write);

/** Core's callback store on a SQLite home (see the module comment): the run store's `callbacks`. */
export class SqliteCallbackStore implements CallbackStore {
  readonly #db: RealmDb;
  /** The signing keys (callback A2, B1a): `callback_keys`, on the same primitive. */
  readonly keys: CallbackKeyStore;

  /** Package-internal: the run store builds the one callback store of a handle. */
  constructor(db: RealmDb, keys: CallbackKeyStore) {
    this.#db = db;
    this.keys = keys;
  }

  /** The run's row without its address, body, token or webhook id; none, read with no reading. */
  async read(runId: string): Promise<CallbackView | undefined> {
    return this.#db.snapshot(
      (db) => {
        const row = readRow(db, runId);
        return row === undefined ? undefined : callbackViewOf(row);
      },
      { takesReading: false },
    );
  }

  /** How many rows are pending, read with no reading. */
  async countPending(): Promise<number> {
    return this.#db.snapshot(
      (db) =>
        Number(
          db.prepare("SELECT count(*) AS n FROM callbacks WHERE status = 'pending'").get()?.['n'],
        ),
      { takesReading: false },
    );
  }

  /** How many rows wait to be sent, read with no reading. */
  async countWaiting(): Promise<number> {
    return this.#db.snapshot((db) => Number(db.prepare(WAITING).get()?.['n']), {
      takesReading: false,
    });
  }

  /**
   * Ends the overdue rows: core's `endOverdueCallbacks` over the candidates, in one write
   * transaction with its one reading; landed when every written row reads back as written.
   */
  async endOverdue(limit: number): Promise<CallbackEnded[]> {
    checkCallbackRequest({ kind: 'due', limit });
    const decided = await this.#db.immediate(
      (db, reading) => {
        const cutoff = new Date(reading.getTime() - CALLBACK_DELIVERY_WINDOW_SECONDS * 1000);
        const found = db.prepare(OVERDUE).all(reading.toISOString(), cutoff.toISOString(), limit);
        const facts = new Map(
          found.map((row) => [
            String(row['run_id']),
            { finished: row['run_terminal'] === 1, updatedAt: String(row['run_updated_at']) },
          ]),
        );
        const out = endOverdueCallbacks(found.map(rowOf), (id) => facts.get(id), reading, limit);
        for (const row of out.writes) storeCallbackRow(db, row);
        return out;
      },
      (db, out) => out.writes.every((row) => callbackRowLanded(db, row)),
    );
    return decided.ended;
  }

  /** At most `limit` rows to send now, one per host per round, at the read's one reading. */
  async due(limit: number): Promise<CallbackItem[]> {
    checkCallbackRequest({ kind: 'due', limit });
    return this.#db.snapshot(
      (db, reading) =>
        db
          .prepare(DUE)
          .all(reading.toISOString(), limit)
          .map((row) => {
            const { body, ...item } = rowOf(row);
            return { ...item, url: item.url ?? '', ...(body !== undefined ? { body } : {}) };
          }) as CallbackItem[],
    );
  }

  /** Claims one row: core's `claimCallback`, in one write transaction with its one reading. */
  async claim(runId: string, request: CallbackClaimRequest): Promise<CallbackClaimResult> {
    checkCallbackRequest({ kind: 'claim', token: request.token });
    const decided = await this.#db.immediate((db, reading) => {
      const run = db.prepare('SELECT terminal_state, updated_at FROM runs WHERE id = ?').get(runId);
      const facts =
        run === undefined
          ? undefined
          : { finished: run['terminal_state'] === 1, updatedAt: String(run['updated_at']) };
      return store(db, claimCallback(readRow(db, runId), facts, request, reading));
    }, landed);
    return decided.result;
  }

  /** Sets the body once: core's `freezeCallbackBody`, in one write that takes no reading. */
  async freezeBody(runId: string, token: string, body: string): Promise<CallbackFreezeResult> {
    checkCallbackRequest({ kind: 'freeze', token, body });
    const decided = await this.#db.immediate(
      (db) => store(db, freezeCallbackBody(readRow(db, runId), token, body)),
      landed,
      { takesReading: false },
    );
    return decided.result;
  }

  /** Marks a try: core's `markCallback`, one write; only a `retry` takes a reading. */
  async mark(
    runId: string,
    token: string,
    result: CallbackMarkRequest,
  ): Promise<CallbackMarkResult> {
    checkCallbackRequest({ kind: 'mark', token, result });
    const decided =
      result.kind === 'retry'
        ? await this.#db.immediate(
            (db, reading) => store(db, markCallback(readRow(db, runId), token, result, reading)),
            landed,
          )
        : await this.#db.immediate(
            (db) => store(db, markCallback(readRow(db, runId), token, result, undefined)),
            landed,
            { takesReading: false },
          );
    return decided.result;
  }

  /** The run's stored size, in one read that takes no reading: what a delete of it then reports. */
  async statAllForRun(runId: string, _dirEntries?: readonly string[]): Promise<{ bytes: number }> {
    return this.#db.snapshot((db) => ({ bytes: storedSize(db, runId) }), { takesReading: false });
  }

  /**
   * Deletes the run's row in one write that takes no reading, and reports its stored size; a run
   * with no row reports 0. `dirEntries` and `expectVersion` are accepted and ignored. A failure of its
   * own statements, or of its COMMIT, rejects with core's `ENGINE_ARTIFACT_DELETE_FAILED` naming this
   * store and the artifact `callbacks`; the primitive's own refusals pass through unchanged.
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
            return deleteCallbackRowsOfRun(db, runId);
          } catch (err) {
            // A busy answer is the primitive's to wait for and retry, not this delete's failure.
            ownStatementFailed = isOwnStatementFailure(err);
            throw err;
          }
        },
        // Landed when the run has no row left.
        (db, result) => result.gone(db),
        { takesReading: false },
      );
      return { bytes_deleted: deleted.bytes };
    } catch (err) {
      throw deleteFailure(err, ownStatementFailed, { runId, store: STORE, artifact: ARTIFACT });
    }
  }
}

brandClass(
  SqliteCallbackStore,
  Symbol.for('@sensigo/realm-store-sqlite/SqliteCallbackStore'),
  REALM_STORE_SQLITE_BRAND,
);
