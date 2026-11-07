// run-store.ts — issue #616 PR-1a units 12a and 12b (design d4-frozen-r3 §2, §3; the census of core's
// run store, `plans/issue-616/u12/census-u12.md`): `SqliteRunStore`, core's run store on a SQLite
// home, for creating runs (unkeyed), reading one, listing them, updating one and claiming a step of
// one. A keyed create is unit 15's; settling, sealing and saving are unit 13's. `openRealmHome` builds
// the one store of a handle; the package's entry exports the class as a type only, so nothing outside
// the package constructs one.
//
// Every write goes through `RealmDb.immediate` with a `verify` that reads the run back by its content;
// every read goes through `snapshot`. Each call spends exactly ONE reading of the home's clock (core's
// clock laws, #715):
//   - `create`: the reading `immediate` takes right after `BEGIN IMMEDIATE`, unfloored (an unkeyed
//     create has no holder to floor by); the run's id is minted after it;
//   - `get` and `list`: the reading `snapshot` takes BEFORE its transaction begins, so a missing run
//     and an empty store have spent theirs too; each record is judged at that reading floored by its
//     own `updated_at`;
//   - `update` and `claimStep`: the raw reading their write takes itself, under the write lock, once
//     it has found the run (a missing run spends none), folded with the STORED record's `updated_at`
//     before any check, so a refused update or claim has spent it.
// A list is ONE read transaction (n8n's way: a consistent snapshot without the write lock), so it never
// tears across a concurrent write. An update or a claim reads the run and writes it in ONE write
// transaction, so two of them never both act on one version: of two claims of one step, exactly one
// wins and the other is refused as already claimed.
import { randomUUID } from 'node:crypto';
import {
  assertSealIntegrity,
  brandClass,
  computeClaimDeadline,
  deriveRunPhase,
  findEligibleSteps,
  floorAtRecord,
  foldReading,
  isStepSettledOrInFlight,
  runNotFoundError,
  takeRawReading,
  versionConflictError,
  WorkflowError,
  writtenSnapshot,
  type Attributed,
  type Clock,
  type CreateResult,
  type CreateRunOptions,
  type Listing,
  type LoadBearingRunRecordField,
  type RunRecord,
  type Snapshot,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { REALM_STORE_SQLITE_BRAND } from './brand.js';
import { VerifyInconclusive, type RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';
import {
  assertRunRecordWithinLimits,
  insertRunRecord,
  readRunInTransaction,
  splitRunRecord,
  writeRunUpdate,
  type CoreDocument,
} from './run-rows.js';

/** A run id's length (a version 4 uuid): the provisional record's id takes as many bytes. */
const PROVISIONAL_ID = '00000000-0000-0000-0000-000000000000';

/** A stamp's length (`toISOString()`): the provisional record's stamps take as many bytes. */
const PROVISIONAL_STAMP = '0000-00-00T00:00:00.000Z';

/** The refusal of a keyed create until unit 15 brings the key holder. */
const KEYED_CREATE_REFUSED =
  'A keyed create arrives with the key holder, unit 15 of the SQLite store; this store creates unkeyed runs only.';

/**
 * A new run's record, in the shape and key order of the JSON store's (`json-file-store.ts`,
 * `writeFreshRun`): `parent_run_id` only when given, `extension_identity` only when given and not
 * empty; `params` by reference. Pure: the id and the stamp are the caller's.
 */
function freshRecord(options: CreateRunOptions, id: string, now: string): RunRecord {
  return {
    id,
    workflow_id: options.workflowId,
    workflow_version: options.workflowVersion,
    ...(options.parentRunId !== undefined ? { parent_run_id: options.parentRunId } : {}),
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
 * The stored core document of run `runId`, in the caller's transaction, or `undefined` when no run has
 * that id. Its evidence, its write-once fields and its phase are placeholders: only the core fields
 * are read from it (the version, `updated_at`, and the seal boundary's `terminal_state` and
 * `sealed_by`).
 */
function readStoredCore(db: DatabaseLike, runId: string): RunRecord | undefined {
  const row = db.prepare('SELECT record FROM runs WHERE id = ?').get(runId);
  return row === undefined ? undefined : (JSON.parse(String(row['record'])) as RunRecord);
}

/** What an update or a claim wrote: the record returned, and the core document's text as stored. */
interface Written {
  readonly snapshot: Snapshot;
  readonly text: string;
}

/**
 * An update's or a claim's own check after an error at its COMMIT (unit 9's protocol), by content:
 * true when the stored core document is the text written; a stored version above the written one
 * throws {@link VerifyInconclusive} (the write may have landed and been superseded); otherwise false
 * (another writer's text at the same or a lower version, or no run at all).
 */
function verifyWritten(db: DatabaseLike, runId: string, written: Written): boolean {
  const row = db.prepare('SELECT record, version FROM runs WHERE id = ?').get(runId);
  // A run deleted between the failed COMMIT and this read: the write is not there (MA 3, 2026-11-07).
  if (row === undefined) return false;
  if (String(row['record']) === written.text) return true;
  if (Number(row['version']) > written.snapshot.record.version) {
    throw new VerifyInconclusive(
      `Run ${runId} is stored at version ${String(row['version'])}, above the written ` +
        `${written.snapshot.record.version}: the write may have landed and been superseded.`,
    );
  }
  return false;
}

/** A claim of a step that is already in flight or settled (the JSON store's words). */
function alreadyClaimedError(runId: string, stepName: string): WorkflowError {
  return new WorkflowError(
    `Step '${stepName}' is already claimed or completed on run '${runId}'.`,
    {
      code: 'STATE_STEP_ALREADY_CLAIMED',
      category: 'STATE',
      agentAction: 'resolve_precondition',
      retryable: false,
      details: { runId, stepName },
    },
  );
}

/** A claim of a step the run's state does not make eligible (the JSON store's words). */
function notEligibleError(runId: string, stepName: string, eligible: string[]): WorkflowError {
  return new WorkflowError(`Step '${stepName}' is not eligible for execution on run '${runId}'.`, {
    code: 'STATE_STEP_NOT_ELIGIBLE',
    category: 'STATE',
    agentAction: 'resolve_precondition',
    retryable: false,
    details: { runId, stepName, eligible },
  });
}

/**
 * Core's run store on a SQLite home: create (unkeyed), get, list, update and claimStep (see the module
 * comment). It declares no `implements RunStore` yet: the interface requires `settleStep` (unit 13),
 * and the engine's admission refuses a store without it until then.
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
   * is taken. A keyed create (an empty key is a key) is refused until unit 15.
   */
  async create(options: CreateRunOptions): Promise<CreateResult> {
    if (options.idempotencyKey !== undefined) return this.#createKeyed(options);
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
   * Writes `record` as the run's next version, as the JSON store does: refused when no run has its id
   * (core's `STATE_RUN_NOT_FOUND`, no reading spent), when the stored version is not the record's
   * (core's `STATE_SNAPSHOT_MISMATCH`), when the write would cross the seal boundary (core's
   * `assertSealIntegrity`), or when it would change or remove stored evidence or a stored write-once
   * field (the file's guards' `STATE_EVIDENCE_REWRITTEN` and `STATE_WRITE_ONCE_REWRITTEN`, raised by
   * the store before any write). Otherwise the run is stored with the version moved by one,
   * `updated_at` the call's reading and the derived phase; the new evidence entries and write-once
   * fields are added. Returns the record as `get()` returns it, with the reading.
   *
   * Before `BEGIN`: the limits ({@link assertRunRecordWithinLimits}) and the record's split into the
   * texts and hashes the store keeps, so no text is made or hashed under the write lock. No `await`
   * comes before the write, so with the lock free the write lands before the call returns.
   */
  async update(record: RunRecord): Promise<Snapshot> {
    assertRunRecordWithinLimits(record);
    const split = splitRunRecord(record);
    const written = await this.#db.immediate(
      (db): Written => {
        const stored = readStoredCore(db, record.id);
        if (stored === undefined) throw runNotFoundError(record.id);
        const at = foldReading(takeRawReading(this.clock), stored);
        if (stored.version !== record.version) {
          throw versionConflictError(record.id, record.version, stored.version);
        }
        assertSealIntegrity(stored, record);
        const version = record.version + 1;
        const updatedAt = at.toISOString();
        const text = writeRunUpdate(
          db,
          record.id,
          { ...split.core, version, updated_at: updatedAt },
          { prepared: split },
        );
        const updated: RunRecord = {
          ...record,
          run_phase: deriveRunPhase(record),
          version,
          updated_at: updatedAt,
        };
        return { snapshot: writtenSnapshot(updated, at), text };
      },
      (db, written) => verifyWritten(db, record.id, written),
      { takesReading: false },
    );
    return written.snapshot;
  }

  /**
   * Claims step `stepName` of run `runId` for its next attempt, as the JSON store does: the run is
   * read in the write's own transaction; refused when no run has the id (core's `STATE_RUN_NOT_FOUND`,
   * no reading spent), when the step is already in flight or settled (`STATE_STEP_ALREADY_CLAIMED`),
   * or when the definition does not make it eligible now (`STATE_STEP_NOT_ELIGIBLE`, a step the
   * definition lacks included). Otherwise the step is added to `in_progress_steps` and its claim
   * stamped from the call's one reading (`deadline` from the definition, possibly `null`; a fresh
   * `token`; `since`; `holder` only when a claimant is given), with the version moved by one and
   * `updated_at` = `since`. Only the core document changes. Returns the claimed record as `get()`
   * returns it, with the reading.
   */
  async claimStep(
    runId: string,
    stepName: string,
    definition: WorkflowDefinition,
    claimant?: Attributed,
  ): Promise<Snapshot> {
    const written = await this.#db.immediate(
      (db): Written => {
        const stored = readStoredCore(db, runId);
        const run = stored === undefined ? null : readRunInTransaction(db, runId);
        if (stored === undefined || run === null) throw runNotFoundError(runId);
        const at = foldReading(takeRawReading(this.clock), run);
        if (isStepSettledOrInFlight(run, stepName)) throw alreadyClaimedError(runId, stepName);
        const eligible = findEligibleSteps(definition, run);
        if (!eligible.includes(stepName)) throw notEligibleError(runId, stepName, eligible);
        const since = at.toISOString();
        const claim = {
          deadline: computeClaimDeadline(definition, stepName, at),
          token: randomUUID(),
          since,
          ...(claimant !== undefined ? { holder: claimant } : {}),
        };
        // The same four keys replaced in place, in the stored document and in the run as read, so
        // the claimed run keeps the stored key order.
        const claimed = (from: RunRecord): RunRecord => ({
          ...from,
          in_progress_steps: [...from.in_progress_steps, stepName],
          claims: { ...from.claims, [stepName]: claim },
          version: from.version + 1,
          updated_at: since,
        });
        const text = writeRunUpdate(db, runId, claimed(stored) as unknown as CoreDocument, {
          unchanged: true,
        });
        return { snapshot: writtenSnapshot(claimed(run), at), text };
      },
      (db, written) => verifyWritten(db, runId, written),
      { takesReading: false },
    );
    return written.snapshot;
  }

  /** A keyed create: refused, writing nothing and reading no clock. Unit 15 replaces this method. */
  #createKeyed(_options: CreateRunOptions): Promise<CreateResult> {
    return Promise.reject(new Error(KEYED_CREATE_REFUSED));
  }
}

brandClass(
  SqliteRunStore,
  Symbol.for('@sensigo/realm-store-sqlite/SqliteRunStore'),
  REALM_STORE_SQLITE_BRAND,
);
