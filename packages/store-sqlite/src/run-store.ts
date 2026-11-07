// run-store.ts — issue #616 PR-1a unit 12a (design d4-frozen-r3 §2, §3; the census of core's run store,
// `plans/issue-616/u12/census-u12.md`): `SqliteRunStore`, core's run store on a SQLite home, for
// creating runs, reading one and listing them. Updating and claiming are unit 12b's. `openRealmHome`
// builds the one store of a handle; the package's entry exports the class as a type only, so nothing
// outside the package constructs one.
//
// Every write goes through `RealmDb.immediate` with a `verify` that reads the run back by its content;
// every read goes through `snapshot`. Each call spends exactly ONE reading of the home's clock, the
// one the primitive takes (core's clock laws, #715):
//   - `create`: the reading `immediate` takes right after `BEGIN IMMEDIATE`; the run's id is minted
//     after it. An unkeyed create, or a keyed one whose key no run holds, is stamped with it
//     unfloored; a keyed create that finds the key's holder floors it by that run (unit 15a);
//   - `get` and `list`: the reading `snapshot` takes BEFORE its transaction begins, so a missing run
//     and an empty store have spent theirs too; each record is judged at that reading floored by its
//     own `updated_at`.
// A list is ONE read transaction (n8n's way: a consistent snapshot without the write lock), so it never
// tears across a concurrent write.
import { randomUUID } from 'node:crypto';
import {
  brandClass,
  decideIdempotencyPolicy,
  deriveRunPhase,
  floorAtHolder,
  floorAtRecord,
  runNotFoundError,
  writtenSnapshot,
  type Clock,
  type CreateResult,
  type CreateRunOptions,
  type Listing,
  type LoadBearingRunRecordField,
  type RunRecord,
  type Snapshot,
} from '@sensigo/realm';
import { REALM_STORE_SQLITE_BRAND } from './brand.js';
import { VerifyInconclusive, type RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';
import {
  assertRunRecordWithinLimits,
  findKeyHolder,
  insertRunRecord,
  readRunInTransaction,
} from './run-rows.js';

/** A run id's length (a version 4 uuid): the provisional record's id takes as many bytes. */
const PROVISIONAL_ID = '00000000-0000-0000-0000-000000000000';

/** A stamp's length (`toISOString()`): the provisional record's stamps take as many bytes. */
const PROVISIONAL_STAMP = '0000-00-00T00:00:00.000Z';

/**
 * A new run's record, in the shape and key order of the JSON store's (`json-file-store.ts`,
 * `writeFreshRun`): `parent_run_id` only when given, then `idempotency_key` when the create has one
 * and `rerun_of` when it supersedes a run, `extension_identity` only when given and not empty;
 * `params` by reference. Pure: the id, the stamp and the run superseded are the caller's.
 */
function freshRecord(
  options: CreateRunOptions,
  id: string,
  now: string,
  rerunOf?: string,
): RunRecord {
  return {
    id,
    workflow_id: options.workflowId,
    workflow_version: options.workflowVersion,
    ...(options.parentRunId !== undefined ? { parent_run_id: options.parentRunId } : {}),
    ...(options.idempotencyKey !== undefined ? { idempotency_key: options.idempotencyKey } : {}),
    ...(rerunOf !== undefined ? { rerun_of: rerunOf } : {}),
    ...(options.extensionIdentity !== undefined && options.extensionIdentity.length > 0
      ? { extension_identity: options.extensionIdentity }
      : {}),
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 0,
    params: options.params,
    evidence: [],
    created_at: now,
    updated_at: now,
    terminal_state: false,
  };
}

/**
 * A create's own check after an error at its COMMIT (unit 9's protocol), by content: true when the
 * stored run is the record written, false when no run has its id. A run with its id that holds
 * something else was written and then changed by another writer: whether this write landed cannot
 * be told from it, so the check throws {@link VerifyInconclusive}.
 */
function verifyCreated(db: DatabaseLike, record: RunRecord): boolean {
  const stored = readRunInTransaction(db, record.id);
  if (stored === null) return false;
  if (JSON.stringify(stored) === JSON.stringify(record)) return true;
  throw new VerifyInconclusive(
    `The stored run ${record.id} is not the record its create wrote: another writer changed it.`,
  );
}

/**
 * One run read in the caller's snapshot, judged at `reading` floored by its own `updated_at`; a run
 * that does not exist is core's not-found refusal. A stored run that cannot be read back throws the
 * reader's plain error naming it.
 */
function readSnapshot(db: DatabaseLike, runId: string, reading: Date): Snapshot {
  const record = readRunInTransaction(db, runId);
  if (record === null) throw runNotFoundError(runId);
  return writtenSnapshot(record, floorAtRecord(reading, record));
}

/**
 * Core's run store on a SQLite home: create (unkeyed), get and list (see the module comment). It
 * declares no `implements RunStore` yet: the interface requires `settleStep` (unit 13), and the
 * engine's admission refuses a store without it until then.
 */
export class SqliteRunStore {
  /** Claims round-trip: the stored record is the record written, `claims` included. */
  readonly persistsClaims = true;

  /** The fields this store round-trips: all eight, as the JSON store declares them. */
  readonly persistedRunRecordFields: ReadonlySet<LoadBearingRunRecordField> = new Set([
    'capability_blocks',
    'workflow_context_snapshots',
    'extension_identity',
    'validation_rejections',
    'defaulted_steps',
    'settled',
    'finalizer_ledger',
    'sealed_by',
  ]);

  /** The home's clock: every reading the store takes is the primitive's, of this clock. */
  readonly clock: Clock;

  readonly #db: RealmDb;

  /** Package-internal: `openRealmHome` builds the one store of a handle over the home's primitive. */
  constructor(db: RealmDb) {
    this.#db = db;
    this.clock = db.clock;
  }

  /**
   * Creates a run. An unkeyed create (`idempotencyKey` undefined) writes a fresh run stamped with the
   * call's one reading and returns it with `created: true`. Its limits are checked before `BEGIN`, on
   * a provisional record with the real one's bytes and depth (a 36-character id, 24-character
   * stamps), so a record too large is refused with `STATE_STORE_LIMIT_EXCEEDED` before the write lock
   * is taken. A keyed create (an empty key is a key) is {@link #createKeyed}.
   */
  async create(options: CreateRunOptions): Promise<CreateResult> {
    if (options.idempotencyKey !== undefined)
      return this.#createKeyed(options, options.idempotencyKey);
    assertRunRecordWithinLimits(freshRecord(options, PROVISIONAL_ID, PROVISIONAL_STAMP));
    const written = await this.#db.immediate(
      (db, reading) => {
        const record = freshRecord(options, randomUUID(), reading.toISOString());
        insertRunRecord(db, record);
        return writtenSnapshot(record, reading);
      },
      (db, snapshot) => verifyCreated(db, snapshot.record),
    );
    return { ...written, created: true };
  }

  /**
   * Reads one run, judged at the call's one reading (taken before the read) floored by the run's own
   * `updated_at`. A run that does not exist is refused with core's `STATE_RUN_NOT_FOUND`.
   */
  async get(runId: string): Promise<Snapshot> {
    return this.#db.snapshot((db, reading) => readSnapshot(db, runId, reading));
  }

  /**
   * Lists every run, or the runs of `workflowId` (an empty id is given), by id, in ONE read
   * transaction (`consistent_snapshot: true`): the call's one reading is `read_at`, taken before the
   * first read, and each run is judged at it floored by its own `updated_at`. A run that cannot be
   * read back throws; none is skipped.
   */
  async list(workflowId?: string): Promise<Listing> {
    return this.#db.snapshot((db, reading) => {
      const rows =
        workflowId === undefined
          ? db.prepare('SELECT id FROM runs ORDER BY id').all()
          : db.prepare('SELECT id FROM runs WHERE workflow_id = ? ORDER BY id').all(workflowId);
      const snapshots = rows.map((row) => readSnapshot(db, String(row['id']), reading));
      return { snapshots, read_at: reading, consistent_snapshot: true };
    });
  }

  /**
   * A keyed create (unit 15a; the JSON store's keyed create, with the holder derived from the runs'
   * rows instead of a pointer): ONE write transaction finds the key's holder ({@link findKeyHolder})
   * after the call's one reading, and core's policy decides:
   *   - no holder: a fresh run with the key, stamped with the reading, `created: true`;
   *   - `reuse`: the holder, judged at the reading floored by its own stamp, `created: false`;
   *     nothing is written;
   *   - `supersede`: a new run with the key and `rerun_of` naming the holder, stamped with the reading
   *     floored by the holder's `created_at`, `created: true`; the holder is never written;
   *   - a refusal (`STATE_RUN_ALREADY_ACTIVE`, `STATE_IDEMPOTENCY_KEY_USED`) is thrown in the body:
   *     the transaction rolls back and nothing is written.
   * Every outcome spends the one reading; a busy store is refused before it. The limits are checked
   * before `BEGIN` on the largest record the call can write: the key, and a 36-character `rerun_of`.
   * After an error at COMMIT, a new run is looked for by its content; a reuse wrote nothing, so it
   * is there.
   */
  async #createKeyed(options: CreateRunOptions, key: string): Promise<CreateResult> {
    assertRunRecordWithinLimits(
      freshRecord(options, PROVISIONAL_ID, PROVISIONAL_STAMP, PROVISIONAL_ID),
    );
    return this.#db.immediate(
      (db, reading): CreateResult => {
        const holder = findKeyHolder(db, options.workflowId, key);
        if (holder === undefined) {
          const record = freshRecord(options, randomUUID(), reading.toISOString());
          insertRunRecord(db, record);
          return { ...writtenSnapshot(record, reading), created: true };
        }
        const held = readRunInTransaction(db, holder.id);
        // The holder's row was read in this transaction, so its run is there.
        if (held === null) throw new Error(`The run ${holder.id} holds a key and cannot be read.`);
        if (
          decideIdempotencyPolicy({ ...held, run_phase: deriveRunPhase(held) }, options) === 'reuse'
        ) {
          return { ...writtenSnapshot(held, floorAtRecord(reading, held)), created: false };
        }
        const at = floorAtHolder(reading, held.created_at);
        const record = freshRecord(options, randomUUID(), at.toISOString(), held.id);
        insertRunRecord(db, record);
        return { ...writtenSnapshot(record, at), created: true };
      },
      (db, result) => (result.created ? verifyCreated(db, result.record) : true),
    );
  }
}

brandClass(
  SqliteRunStore,
  Symbol.for('@sensigo/realm-store-sqlite/SqliteRunStore'),
  REALM_STORE_SQLITE_BRAND,
);
