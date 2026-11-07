// run-store.ts — issue #616 PR-1a units 12a, 12b, 13a and 13b (design d4-frozen-r3 §2, §3; the
// censuses `plans/issue-616/u12/census-u12.md` and `u13/census-u13.md`): `SqliteRunStore`, core's run
// store on a SQLite home, for creating runs, reading one, listing them, updating one, claiming a step
// of one, settling one and stamping a seal onto an old finished run. A keyed create is unit 15a's;
// saving is 13c's. `openRealmHome` builds the one store of a handle; the package's entry exports the
// class as a type only, so nothing outside the package constructs one.
//
// Every write goes through `RealmDb.immediate` with a `verify` that reads the run back by its content;
// every read goes through `snapshot`. Each call but a stamp spends exactly ONE reading of the home's
// clock (core's clock laws, #715):
//   - `create`: the reading `immediate` takes right after `BEGIN IMMEDIATE`; the run's id is minted
//     after it. An unkeyed create, or a keyed one whose key no run holds, is stamped with it
//     unfloored; a keyed create that finds the key's holder floors it by that run (unit 15a);
//   - `get` and `list`: the reading `snapshot` takes BEFORE its transaction begins, so a missing run
//     and an empty store have spent theirs too; each record is judged at that reading floored by its
//     own `updated_at`;
//   - `update`, `claimStep` and `settleStep`: the raw reading their write takes itself, under the
//     write lock, once it has found the run (a missing run spends none), folded with the STORED
//     record's `updated_at` (a settle's also with its delta's event instants) before any check, so a
//     refused update, claim or settle has spent it;
//   - `stampSeal`: none, on every branch: it carries `updated_at` through unchanged (stamping is not
//     activity), so it has nothing to stamp.
// A list is ONE read transaction (n8n's way: a consistent snapshot without the write lock), so it never
// tears across a concurrent write. An update, a claim or a settle reads the run and writes it in ONE
// write transaction, so two of them never both act on one version: of two claims of one step, exactly
// one wins and the other is refused as already claimed.
import { randomUUID } from 'node:crypto';
import {
  applySettlement,
  assertSealIntegrity,
  brandClass,
  computeClaimDeadline,
  decideIdempotencyPolicy,
  deriveRunPhase,
  findEligibleSteps,
  floorAtHolder,
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
  type RunStore,
  type SealedBy,
  type SealRunDelta,
  type SettlementDelta,
  type Snapshot,
  type StampSealResult,
  type StoreSettlement,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { REALM_STORE_SQLITE_BRAND } from './brand.js';
import { VerifyInconclusive, type RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';
import {
  assertRunRecordWithinLimits,
  findKeyHolder,
  insertRunRecord,
  prepareSettlementWrite,
  readRunInTransaction,
  splitRunRecord,
  writeRunUpdate,
  type CoreDocument,
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
 * What a settle returns, and what it wrote: the core document's text and the version written, or
 * `undefined` when it wrote nothing (a refusal or a noop, returned).
 */
interface Settled {
  readonly result: StoreSettlement;
  readonly written: { readonly text: string; readonly version: number } | undefined;
}

/**
 * An update's, a claim's, a settle's or a stamp's own check after an error at its COMMIT (unit 9's
 * protocol), by content: true when the stored core document is the text written; a stored version
 * above the written `version` throws {@link VerifyInconclusive} (the write may have landed and been
 * superseded); otherwise false (another writer's text at the same or a lower version, or no run at
 * all). The evidence rows and the core document are one transaction, so the text landing is the
 * whole record landing.
 */
function verifyWritten(db: DatabaseLike, runId: string, text: string, version: number): boolean {
  const row = db.prepare('SELECT record, version FROM runs WHERE id = ?').get(runId);
  // A run deleted between the failed COMMIT and this read: the write is not there (MA 3, 2026-11-07).
  if (row === undefined) return false;
  if (String(row['record']) === text) return true;
  if (Number(row['version']) > version) {
    throw new VerifyInconclusive(
      `Run ${runId} is stored at version ${String(row['version'])}, above the written ` +
        `${version}: the write may have landed and been superseded.`,
    );
  }
  return false;
}

/** What a stamp did: its answer, and, when it wrote, the core document's text as stored. */
interface Stamping {
  readonly result: StampSealResult;
  readonly text?: string;
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
 * Core's run store on a SQLite home: create (keyed or not), get, list, update, claimStep and
 * settleStep and stampSeal (see the module comment). It implements core's `RunStore`, its optional
 * `stampSeal` included.
 */
export class SqliteRunStore implements RunStore {
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
      (db, written) => verifyWritten(db, record.id, written.text, written.snapshot.record.version),
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
      (db, written) => verifyWritten(db, runId, written.text, written.snapshot.record.version),
      { takesReading: false },
    );
    return written.snapshot;
  }

  /**
   * Settles one change of run `runId` (core's {@link SettlementDelta}, all nine kinds), as the JSON
   * store does, in ONE write transaction: the step's settlement, every guard it makes eligible
   * (`cascadeGuards: true`, #616 comment 5954803518), its evidence and its phase. `seal_run` takes no
   * definition; every other kind takes one.
   *
   * Before `BEGIN`: the delta is held to the store's limits ({@link assertRunRecordWithinLimits}), so
   * a delta too large is refused with `STATE_STORE_LIMIT_EXCEEDED` before the write lock is taken. In
   * the lock: the run is read (a missing run is core's `STATE_RUN_NOT_FOUND`, no reading spent); then
   * the call's ONE reading, floored by the run's `updated_at` with the delta's event instants folded in
   * (core's `foldReading`); then core's `applySettlement`, which mints every instant of its output from
   * it. Not applied: `moved` (a stale `seal_run`) is thrown as core's version conflict; every other
   * refusal or noop is returned with the run as read and the reading, and nothing is written. Applied:
   * the seal boundary (`assertSealIntegrity`), then the transform's record with its phase derived and
   * the version moved by one is written ({@link prepareSettlementWrite}, {@link writeRunUpdate}) and
   * returned as the transform made it, with the reading. No `await` comes before the write.
   */
  settleStep(runId: string, delta: SealRunDelta): Promise<StoreSettlement>;
  settleStep(
    runId: string,
    delta: Exclude<SettlementDelta, SealRunDelta>,
    definition: WorkflowDefinition,
  ): Promise<StoreSettlement>;
  async settleStep(
    runId: string,
    delta: SettlementDelta,
    definition?: WorkflowDefinition,
  ): Promise<StoreSettlement> {
    assertRunRecordWithinLimits(delta);
    const settled = await this.#db.immediate(
      (db): Settled => {
        const fresh = readRunInTransaction(db, runId);
        if (fresh === null) throw runNotFoundError(runId);
        const at = foldReading(takeRawReading(this.clock), fresh, delta);
        const outcome = applySettlement(fresh, delta, definition, {
          at,
          cascadeGuards: true,
          storeKeepsClaims: this.persistsClaims,
        });
        if (!outcome.applied) {
          if (outcome.reason === 'moved') {
            throw versionConflictError(runId, outcome.expected!, outcome.stored!);
          }
          return { result: { ...outcome, at }, written: undefined };
        }
        assertSealIntegrity(fresh, outcome.run);
        // The store does not set `updated_at`: the transform did, from `at`.
        const updated: RunRecord = {
          ...outcome.run,
          run_phase: deriveRunPhase(outcome.run),
          version: fresh.version + 1,
        };
        const { core, evidence } = prepareSettlementWrite(fresh, updated);
        const text = writeRunUpdate(db, runId, core, evidence);
        return {
          result: { ...outcome, run: updated, at },
          written: { text, version: updated.version },
        };
      },
      // A settle that wrote nothing has nothing to land.
      (db, settled) =>
        settled.written === undefined ||
        verifyWritten(db, runId, settled.written.text, settled.written.version),
      { takesReading: false },
    );
    return settled.result;
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

  /**
   * Stamps `sealedBy` onto run `runId`, a run that finished before runs carried a seal (#367; the one
   * write of `realm run migrate --stamp-seals`), as the JSON store does. ONE write transaction reads
   * the run, then four checks, in this order:
   *   1. a stored version that is not `expectedVersion` THROWS core's `STATE_SNAPSHOT_MISMATCH`;
   *   2. a run that already holds a seal RETURNS `already_stamped`;
   *   3. a run that is not finished RETURNS `not_terminal`; both refusals carry the run as it stands;
   *   4. otherwise core's seal boundary judges the stamp (`assertSealIntegrity`, which throws), and
   *      the run is written with `sealed_by` appended last, the version moved by one and `updated_at`
   *      kept byte for byte: stamping is not activity, so retention's clock does not move, and a
   *      writer holding the run read before the stamp fails its version check instead of wiping it.
   * The write patches the stored core document, as a claim does (MA 3, 2026-11-07): no evidence entry
   * or write-once value is made into text or hashed, and the writer re-stamps the phase columns from
   * it. A run that does not exist is core's `STATE_RUN_NOT_FOUND`. No branch reads the clock.
   */
  async stampSeal(
    runId: string,
    sealedBy: SealedBy,
    expectedVersion: number,
  ): Promise<StampSealResult> {
    const stamping = await this.#db.immediate(
      (db): Stamping => {
        const stored = readStoredCore(db, runId);
        const fresh = stored === undefined ? null : readRunInTransaction(db, runId);
        if (stored === undefined || fresh === null) throw runNotFoundError(runId);
        if (fresh.version !== expectedVersion) {
          throw versionConflictError(runId, expectedVersion, fresh.version);
        }
        if (fresh.sealed_by !== undefined) {
          return { result: { stamped: false, reason: 'already_stamped', run: fresh } };
        }
        if (fresh.terminal_state !== true) {
          return { result: { stamped: false, reason: 'not_terminal', run: fresh } };
        }
        const stamped: RunRecord = { ...fresh, sealed_by: sealedBy };
        assertSealIntegrity(fresh, stamped);
        const version = fresh.version + 1;
        // The stored document with its placeholders in place: `sealed_by` appended last, as in
        // `stamped`, the version replaced in place and `updated_at` the stored text.
        const text = writeRunUpdate(
          db,
          runId,
          {
            ...stored,
            sealed_by: sealedBy,
            version,
            updated_at: stored.updated_at,
          } as unknown as CoreDocument,
          { unchanged: true },
        );
        const run: RunRecord = {
          ...stamped,
          run_phase: deriveRunPhase(stamped),
          version,
          updated_at: fresh.updated_at,
        };
        return { result: { stamped: true, run }, text };
      },
      // A refusal wrote nothing, so there is nothing to look for (SEAMS, the unit 13 rulings, Q3).
      (db, stamping) =>
        stamping.text === undefined ||
        verifyWritten(db, runId, stamping.text, stamping.result.run.version),
      { takesReading: false },
    );
    return stamping.result;
  }
}

brandClass(
  SqliteRunStore,
  Symbol.for('@sensigo/realm-store-sqlite/SqliteRunStore'),
  REALM_STORE_SQLITE_BRAND,
);
