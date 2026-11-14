// run-store.ts — issue #616 PR-1a units 12a, 12b, 13a, 13b, 13c and 14 (design d4-frozen-r3 §2, §3,
// §5; the censuses `plans/issue-616/u12/census-u12.md` and `u13/census-u13.md`): `SqliteRunStore`,
// core's run store on a SQLite home, for creating runs, reading one, listing them, updating one,
// claiming a step of one, settling one, stamping a seal onto an old finished run and importing one
// another store exported (`save`), and (unit 14) for deleting a finished run and measuring what it
// keeps of one. A keyed create is unit 15a's. `openRealmHome` builds the one store of a handle; the
// package's entry exports the class as a type only, so nothing outside the package constructs one.
//
// Every write goes through `RealmDb.immediate` with a `verify` that reads the run back by its content;
// every read goes through `snapshot`. Each call but a stamp and `save` spends exactly ONE reading of
// the home's clock (core's clock laws, #715), except the two calls of a per-run artifact store (unit
// 14):
//   - `statAllForRun`: none (its snapshot takes none: the size judges nothing by time);
//   - `deleteAllForRun`: one raw reading under the write lock once the run is found deletable, which
//     stamps the run's tombstone; a missing run and a refused deletion spend none.
// The others:
//   - `create`: the reading `immediate` takes right after `BEGIN IMMEDIATE`; the run's id is minted
//     after it. An unkeyed create, or a keyed one whose key no run holds, is stamped with it
//     unfloored; a keyed create that finds the key's holder floors it by that run (unit 15a);
//   - `get`: the reading `snapshot` takes BEFORE its transaction begins, so a missing run has spent
//     its reading too; the record is judged at that reading floored by its own `updated_at`;
//   - `update`, `claimStep` and `settleStep`: the raw reading their write takes itself, under the
//     write lock, once it has found the run (a missing run spends none), folded with the STORED
//     record's `updated_at` (a settle's also with its delta's event instants) before any check, so a
//     refused update, claim or settle has spent it;
//   - `stampSeal`: none, on every branch: it carries `updated_at` through unchanged (stamping is not
//     activity), so it has nothing to stamp;
//   - `save`: none, on every branch, as the interface's text says: an import keeps the record's own
//     instants;
//   - `scan` (unit c3): one per page, the reading that page's `snapshot` takes; `tombstonesSince` and
//     `resolveKey`: the one their `snapshot` takes.
// A page of `scan` is ONE read transaction (n8n's way: a consistent snapshot without the write lock),
// so it never tears across a concurrent write. An update, a claim or a settle reads the run and writes it in ONE
// write transaction, so two of them never both act on one version: of two claims of one step, exactly
// one wins and the other is refused as already claimed. An import, too, looks for the run and writes
// it in one write transaction: of two imports of one new run, one writes it and the other finds it.
import { randomUUID } from 'node:crypto';
import {
  applySettlement,
  assertSealIntegrity,
  brandClass,
  canonicalJson,
  computeClaimDeadline,
  decideIdempotencyPolicy,
  deriveRunPhase,
  findEligibleSteps,
  floorAtHolder,
  floorAtRecord,
  foldReading,
  isRunRecordShape,
  isStepSettledOrInFlight,
  runNotFoundError,
  takeRawReading,
  TERMINAL_PHASES,
  versionConflictError,
  WorkflowError,
  writtenSnapshot,
  type ArtifactDeletionReport,
  type Attributed,
  type Clock,
  type CreateResult,
  type CreateRunOptions,
  type KeyAnswer,
  type LeasePort,
  type LoadBearingRunRecordField,
  type PerRunArtifactStore,
  type RunRecord,
  type RunStore,
  type ScanFilter,
  type ScanOptions,
  type ScanPage,
  type SealedBy,
  type SealRunDelta,
  type SettlementDelta,
  type Snapshot,
  type StampSealResult,
  type StoreSettlement,
  type WorkflowDefinition,
} from '@sensigo/realm';
import {
  deleteFailure,
  isOwnStatementFailure,
  type RowsDeleted,
} from './artifact-delete-failure.js';
import { REALM_STORE_SQLITE_BRAND } from './brand.js';
import { VerifyInconclusive, type RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';
import {
  assertRunRecordWithinLimits,
  deleteRunRows,
  findKeyHolder,
  insertRunRecord,
  prepareSettlementWrite,
  readRunInTransaction,
  splitRunRecord,
  storedBytesOfRun,
  writeRunUpdate,
  type CoreDocument,
} from './run-rows.js';
import { assertScanArguments, readHorizon, readKeyAnswer, readScanPage } from './run-scan.js';

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
 * A create's or an import's own check after an error at its COMMIT (unit 9's protocol), by content:
 * true when the stored run is the record written (as `get()` reads it), false when no run has its id.
 * A run with its id that holds something else was written and then changed by another writer:
 * whether this write landed cannot be told from it, so the check throws {@link VerifyInconclusive}.
 */
function verifyCreated(db: DatabaseLike, record: RunRecord): boolean {
  const stored = readRunInTransaction(db, record.id);
  if (stored === null) return false;
  if (JSON.stringify(stored) === JSON.stringify(record)) return true;
  throw new VerifyInconclusive(
    `The stored run ${record.id} is not the record its write stored: another writer changed it.`,
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

/** The fields of a run record that hold an instant, as {@link SqliteRunStore.save} checks them. */
const RECORD_STAMPS = ['created_at', 'updated_at'] as const;

/** The id `value` names, when it is an object whose `id` is a string. */
function idOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const id: unknown = (value as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : undefined;
}

/** The store's name in a delete failure, and the artifact it names (the shared rule). */
const STORE = 'SqliteRunStore';
export const ARTIFACT = 'runs';

/** What a deletion's body did: its receipt, and the instant it stamped (none when it deleted nothing). */
interface Deletion {
  readonly bytes_deleted: number;
  readonly at?: string;
}

/**
 * A refusal to delete a run, in the JSON store's words and shape (`JsonFileStore.runBusyError`, word
 * for word; MA 3's D6): retryable, for the operator, with the run and the reason in `details`.
 */
function deleteRefusal(
  runId: string,
  reason: 'no_longer_terminal' | 'drain_pending',
): WorkflowError {
  const message =
    reason === 'no_longer_terminal'
      ? `Run '${runId}' is no longer terminal — refusing to delete (it may have been resumed)`
      : `Run '${runId}' has a pending finalizer — refusing to delete until it is drained or ` +
        `voided (realm run drain ${runId} / --void <finalizer>)`;
  return new WorkflowError(message, {
    code: 'STATE_RUN_BUSY',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: true,
    details: { runId, reason },
  });
}

/**
 * A deletion's own check after an error at its COMMIT (unit 9's protocol; MA 3's D5), by content. A
 * call that deleted nothing answers true without reading: nothing was to land. Otherwise true when
 * `purged_ids` holds the id stamped with THIS call's instant, and false when it does not: the run row
 * is still there (the deletion did not land), or the id is gone under another stamp (another writer
 * deleted it, so this call's deletion did not land). The answer is definite: a purged id is kept
 * forever and its run is never created again (unit 9's ruling 2).
 */
function verifyDeleted(db: DatabaseLike, runId: string, deletion: Deletion): boolean {
  if (deletion.at === undefined) return true;
  const row = db.prepare('SELECT purged_at FROM purged_ids WHERE id = ?').get(runId);
  return row !== undefined && String(row['purged_at']) === deletion.at;
}

/** What {@link deleteRunIfDeletable} found and did. */
export type RunDeletionOutcome =
  /** No run by that id: nothing written. */
  | { readonly kind: 'absent' }
  /** A refusal in unit 14's words: nothing written. */
  | { readonly kind: 'refused'; readonly error: WorkflowError }
  /** Deleted, stamped `at`: its receipt, and its check by content. */
  | ({ readonly kind: 'deleted'; readonly at: string } & RowsDeleted);

/** What {@link deleteRunIfDeletable} is given besides the run. */
export interface RunDeletionOptions {
  /** The version the caller selected the run at: a run at another version is refused. */
  readonly expectVersion?: number | undefined;
  /** The deletion's stamp, as ISO text: asked for only once the run is found deletable. */
  readonly stamp: () => string;
  /** Runs one of the deletion's own statements (the run's read, the measure and the deletion). */
  readonly statement: <R>(run: () => R) => R;
}

/**
 * Unit 14's deletion of run `runId` inside the caller's `BEGIN IMMEDIATE` (#616 PR-2c c9: this
 * store's `deleteAllForRun` and the home's purge both call it). The run is read under the write lock
 * and judged in unit 14's order, BEFORE any of its rows go: absent; `expectVersion` given and the
 * stored version not it (core's `STATE_SNAPSHOT_MISMATCH`); a derived phase that is not terminal, or
 * a `terminal_state` that is not true (`STATE_RUN_BUSY`, `no_longer_terminal`); a finalizer still
 * `pending` (`STATE_RUN_BUSY`, `drain_pending`). A refusal is returned, not thrown, and writes nothing.
 * Otherwise `stamp()` is called once, and the run's rows go ({@link deleteRunRows}, its tombstone
 * stamped with it); the receipt is {@link storedBytesOfRun} of the run before. Synchronous; reads no
 * clock of its own; a failure of its statements is thrown unmapped, through `statement`.
 */
export function deleteRunIfDeletable(
  db: DatabaseLike,
  runId: string,
  options: RunDeletionOptions,
): RunDeletionOutcome {
  const run = options.statement(() => readRunInTransaction(db, runId));
  if (run === null) return { kind: 'absent' };
  const { expectVersion } = options;
  if (expectVersion !== undefined && run.version !== expectVersion) {
    return { kind: 'refused', error: versionConflictError(runId, expectVersion, run.version) };
  }
  if (!TERMINAL_PHASES.has(deriveRunPhase(run)) || run.terminal_state !== true) {
    return { kind: 'refused', error: deleteRefusal(runId, 'no_longer_terminal') };
  }
  const pendingFinalizer = Object.entries(run.finalizer_ledger ?? {}).find(
    ([, entry]) => entry.status === 'pending',
  );
  if (pendingFinalizer !== undefined) {
    return { kind: 'refused', error: deleteRefusal(runId, 'drain_pending') };
  }
  const at = options.stamp();
  const bytes = options.statement(() => {
    const measured = storedBytesOfRun(db, runId);
    deleteRunRows(db, runId, at);
    return measured;
  });
  return {
    kind: 'deleted',
    at,
    bytes,
    gone: (check) => verifyDeleted(check, runId, { bytes_deleted: bytes, at }),
  };
}

/**
 * Whether `text` is an instant in the one form the store keeps, `toISOString()`'s
 * (`YYYY-MM-DDTHH:MM:SS.sssZ`): the text an instant read from it prints back. A text that names no
 * instant (`toISOString` would throw on it) is not one either.
 */
function isStoredInstant(text: string): boolean {
  const instant = new Date(text);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === text;
}

/** An import of something that is not a run record in the current format (`save`). */
function notCurrentRecordError(runId: string | undefined): WorkflowError {
  return new WorkflowError(
    'This is not a run record in the current format, so it cannot be imported. Nothing was imported.',
    {
      code: 'STATE_LEGACY_FORMAT',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      ...(runId !== undefined ? { details: { runId } } : {}),
    },
  );
}

/** An import of a run whose `field` is not an instant in the stored form (`save`). */
function timestampInvalidError(runId: string, field: string): WorkflowError {
  return new WorkflowError(
    `Run '${runId}' has a ${field} that is not a timestamp of the form 2026-11-05T12:00:00.000Z. Nothing was imported.`,
    {
      code: 'STATE_RUN_TIMESTAMP_INVALID',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { runId, field },
    },
  );
}

/** An import of a run whose id was deleted on purpose at `purgedAt` (`save`). */
function purgedError(runId: string, purgedAt: string): WorkflowError {
  return new WorkflowError(
    `Run '${runId}' was deleted on ${purgedAt} and its id cannot be used again. Nothing was imported.`,
    {
      code: 'STATE_RUN_PURGED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { runId, purged_at: purgedAt },
    },
  );
}

/** An import of a run stored here at another version (`save`; the JSON store's words). */
function divergedVersionError(
  runId: string,
  localVersion: number,
  incomingVersion: number,
): WorkflowError {
  return new WorkflowError(
    `Run '${runId}' exists locally with a different version (local: ${localVersion}, incoming: ${incomingVersion}). Manual resolution required.`,
    {
      code: 'STATE_RUN_DIVERGED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { runId, localVersion, incomingVersion },
    },
  );
}

/** An import of a run stored here at the same version with other content (`save`). */
function divergedContentError(runId: string, version: number): WorkflowError {
  return new WorkflowError(
    `Run '${runId}' exists locally at version ${version} with different content from the incoming run. Manual resolution required.`,
    {
      code: 'STATE_RUN_DIVERGED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { runId, localVersion: version, incomingVersion: version },
    },
  );
}

/** An import of a live run whose idempotency key another live run holds (`save`). */
function keyHeldError(record: RunRecord, ownerId: string): WorkflowError {
  return new WorkflowError(
    `Idempotency key for workflow '${record.workflow_id}' is already held by a different live run '${ownerId}'; the imported run '${record.id}' was not imported.`,
    {
      code: 'STATE_RUN_DIVERGED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { runId: record.id, existingOwnerRunId: ownerId },
    },
  );
}

/**
 * When run `runId` was deleted, from its tombstone in `purged_ids` (kept forever: a purged id is
 * refused even after `purged_runs`' detail of it is compacted), or `undefined` when it never was;
 * in the caller's transaction.
 */
function purgedAtOf(db: DatabaseLike, runId: string): string | undefined {
  const row = db.prepare('SELECT purged_at FROM purged_ids WHERE id = ?').get(runId);
  return row === undefined ? undefined : String(row['purged_at']);
}

/**
 * Core's run store on a SQLite home: create (keyed or not), get, update, claimStep, settleStep,
 * stampSeal, scan, resolveKey and tombstonesSince (see the module comment), and `save`, the import
 * verb, which is not on the interface. It implements core's `RunStore`, its optional `stampSeal`
 * included. It is a per-run artifact store (unit 14): purge deletes a run's rows through it, as the
 * anchor, once PR-2c wires purge.
 */
export class SqliteRunStore implements RunStore, PerRunArtifactStore {
  /** Claims round-trip: the stored record is the record written, `claims` included. */
  readonly persistsClaims = true;

  /** This store deletes runs (`deleteAllForRun`), and each deletion leaves a tombstone (#616 PR-2c c4-i). */
  readonly purgesRuns = true;

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

  /**
   * The home's claim leases (#729, the claim window, CW-1): files in `claim-leases/` beside
   * `realm.db`, each a lock the operating system keeps while its program runs (`claim-lease.ts`).
   * Nothing in Realm takes one yet.
   */
  readonly leases: LeasePort;

  readonly #db: RealmDb;

  /**
   * Package-internal: `openRealmHome` builds the one store of a handle over the home's primitive and
   * the home's lease port.
   */
  constructor(db: RealmDb, leases: LeasePort) {
    this.#db = db;
    this.clock = db.clock;
    this.leases = leases;
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
   * Reads the store's runs in pages, by id (unit c3; design §6): an async iterator whose every page is
   * its own read transaction, taken at that page's one reading (`read_at`), so every run present for
   * the whole scan is returned exactly once. `filter` narrows it (`run-scan.ts` names the index each
   * filter walks); `options.pageSize` is required, a whole number from 1 to `SCAN_MAX_PAGE_SIZE`;
   * `options.after` starts after that id. In the `'record'` projection (the default) each run is as
   * `get()` returns it, judged at the page's reading floored by its own `updated_at`; in the `'row'`
   * projection it is its facts row, read without reassembling the record. With `include_purged` the
   * matching tombstones come beside the runs, in id order, and count toward the page. The iterator
   * ends after a page that is not full. A page size out of range, or a `key` with no `workflow`, is
   * refused before any read: the first `next()` rejects with a plain error.
   */
  scan(
    filter: ScanFilter,
    options: ScanOptions & { projection: 'row' },
  ): AsyncGenerator<ScanPage<'row'>, void, undefined>;
  scan(
    filter: ScanFilter,
    options: ScanOptions & { projection?: 'record' },
  ): AsyncGenerator<ScanPage<'record'>, void, undefined>;
  scan(
    filter: ScanFilter,
    options: ScanOptions,
  ): AsyncGenerator<ScanPage<'record'> | ScanPage<'row'>, void, undefined>;
  async *scan(
    filter: ScanFilter,
    options: ScanOptions,
  ): AsyncGenerator<ScanPage<'record' | 'row'>, void, undefined> {
    assertScanArguments(filter, options);
    // The caller's objects are copied, so a change to them mid-scan does not change the walks.
    const scanned: ScanFilter = { ...filter };
    const { pageSize } = options;
    const projection = options.projection === 'row' ? 'row' : 'record';
    let after = options.after ?? '';
    for (;;) {
      const request = { pageSize, projection, after } as const;
      const page = await this.#db.snapshot((db, reading) =>
        readScanPage(db, reading, scanned, request, (runId) => readSnapshot(db, runId, reading)),
      );
      yield page;
      if (page.next_after === undefined) return;
      after = page.next_after;
    }
  }

  /** The tombstone horizon, `store_meta.tombstones_since` (unit c3): one read. */
  async tombstonesSince(): Promise<string> {
    return this.#db.snapshot((db) => readHorizon(db));
  }

  /**
   * Who holds `workflowId`'s idempotency key `key` (unit c3; design §3, axis 7), in ONE snapshot: the
   * holder `findKeyHolder` derives → `held`; else the key's tombstones → `purged`, listing each run's
   * id and `purged_at`, with the horizon; else `unseen`, with the horizon. Never another run's record.
   */
  async resolveKey(workflowId: string, key: string): Promise<KeyAnswer> {
    return this.#db.snapshot((db) => readKeyAnswer(db, workflowId, key));
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
   * Imports `record`, a run another store exported (realm-cloud's pull and sync; `realm run import`),
   * as a stored run: written with its own id, version, instants, evidence, write-once fields and key
   * when no run has its id (`imported`), nothing done when the run is here with the same content
   * (`unchanged`). Not on core's `RunStore` (an import verb only this store has). It spends no reading
   * and never runs the seal boundary: a finished record with no seal stamp imports as it is.
   *
   * Refused, before `BEGIN` and with nothing spent, in this order: a value that is not a run record in
   * the current format (core's `isRunRecordShape`; `STATE_LEGACY_FORMAT`); a `created_at` or
   * `updated_at` that is not an instant in the stored form (`STATE_RUN_TIMESTAMP_INVALID`, naming
   * the field); a record past the store's limits (`STATE_STORE_LIMIT_EXCEEDED`). Then, in ONE write
   * transaction: an id deleted on purpose (`STATE_RUN_PURGED`, naming when, from `purged_ids`); a
   * run stored with the id at another version, or at the same version with other content (core's
   * canonical JSON of both, the phase derived on both: key order does not count), `STATE_RUN_DIVERGED`;
   * a LIVE record whose idempotency key (a string; `null` or absent is none) another live run holds
   * (15a's {@link findKeyHolder}), `STATE_RUN_DIVERGED`. A refusal writes nothing.
   *
   * The write is {@link insertRunRecord}, then the run is read back in the same transaction and must
   * be the record given, its phase the derived one, by strict `JSON.stringify` equality: any other
   * difference fails the import with a plain error, and nothing is written. After an error at
   * COMMIT the run is looked for by that content; a run found here wrote nothing, so it is there.
   */
  async save(record: RunRecord): Promise<{ readonly outcome: 'imported' | 'unchanged' }> {
    if (!isRunRecordShape(record)) throw notCurrentRecordError(idOf(record));
    for (const field of RECORD_STAMPS) {
      if (!isStoredInstant(record[field])) throw timestampInvalidError(record.id, field);
    }
    assertRunRecordWithinLimits(record);
    // The record as `get()` reads it back: its phase the derivation's, at the key's own position.
    const written: RunRecord = { ...record, run_phase: deriveRunPhase(record) };
    const outcome = await this.#db.immediate(
      (db): 'imported' | 'unchanged' => {
        const purgedAt = purgedAtOf(db, record.id);
        if (purgedAt !== undefined) throw purgedError(record.id, purgedAt);
        const stored = readRunInTransaction(db, record.id);
        if (stored !== null) {
          if (stored.version !== record.version) {
            throw divergedVersionError(record.id, stored.version, record.version);
          }
          if (canonicalJson(stored) !== canonicalJson(written)) {
            throw divergedContentError(record.id, stored.version);
          }
          return 'unchanged';
        }
        const key: unknown = record.idempotency_key;
        if (record.terminal_state !== true && typeof key === 'string') {
          const holder = findKeyHolder(db, record.workflow_id, key);
          if (holder !== undefined && !holder.terminal_state) throw keyHeldError(record, holder.id);
        }
        insertRunRecord(db, record);
        const back = readRunInTransaction(db, record.id);
        if (back === null || JSON.stringify(back) !== JSON.stringify(written)) {
          throw new Error(
            `The imported run ${record.id} does not read back as the record it was given, so it was not imported.`,
          );
        }
        return 'imported';
      },
      // A run found here wrote nothing, so there is nothing to look for.
      (db, done) => done === 'unchanged' || verifyCreated(db, written),
      { takesReading: false },
    );
    return { outcome };
  }

  /**
   * What the store keeps of run `runId`, in bytes ({@link storedBytesOfRun}): the figure
   * {@link deleteAllForRun} would report for it now, `0` for a run that is not there. ONE read
   * transaction that takes no reading of the clock and no write lock, and refuses nothing (the
   * interface: a dry run never fails with `STATE_RUN_BUSY` for a run being written); a store that
   * cannot be read rejects. `dirEntries` is the file stores' and is ignored.
   */
  async statAllForRun(runId: string, _dirEntries?: readonly string[]): Promise<{ bytes: number }> {
    return this.#db.snapshot((db) => ({ bytes: storedBytesOfRun(db, runId) }), {
      takesReading: false,
    });
  }

  /**
   * Deletes run `runId`'s rows, as the JSON store deletes a run (its order, its refusals and their
   * words), in ONE write transaction, so the run is deleted whole or not at all:
   *   - a run that is not there: `{ bytes_deleted: 0 }`, nothing written, no reading (absence is
   *     success, interface #183);
   *   - `options.expectVersion` given and the stored version not it: core's `STATE_SNAPSHOT_MISMATCH`,
   *     checked first (purge passes the version it selected the run at);
   *   - a run whose derived phase is not terminal, or whose `terminal_state` is not true:
   *     `STATE_RUN_BUSY` (`no_longer_terminal`);
   *   - a run with a finalizer still `pending`: `STATE_RUN_BUSY` (`drain_pending`);
   *   - otherwise ONE raw reading, then the run's rows go ({@link deleteRunRows}), the tombstone
   *     stamped with that reading; the receipt is {@link storedBytesOfRun} of the run before.
   * Nothing is deleted on a refusal, and a refusal spends no reading. `dirEntries` is the file stores'
   * and is ignored.
   *
   * Failures follow the rule the package's per-run deletes share (`artifact-delete-failure.ts`; MA 3,
   * 2026-11-07): a failure of the body's own SQL statements (the run's read, the measure, the deletion's
   * writes), or a COMMIT that did not land, rejects with core's `ENGINE_ARTIFACT_DELETE_FAILED` naming
   * this store, the artifact `runs` and SQLite's name for the code. The store's own refusals above, the
   * primitive's (a busy store after its budget, writes fenced, a newer file) and a COMMIT whose outcome
   * is unknown pass unchanged.
   */
  async deleteAllForRun(
    runId: string,
    _dirEntries?: readonly string[],
    options?: { expectVersion?: number },
  ): Promise<ArtifactDeletionReport> {
    let ownStatementFailed = false;
    /** Runs one of the body's own statements; a failure of it (busy aside) is this delete's failure. */
    const statement = <R>(run: () => R): R => {
      try {
        return run();
      } catch (err) {
        // A busy answer is the primitive's to wait for and retry, not this delete's failure.
        ownStatementFailed = isOwnStatementFailure(err);
        throw err;
      }
    };
    try {
      const deletion = await this.#db.immediate(
        (db): Deletion => {
          ownStatementFailed = false;
          const judged = deleteRunIfDeletable(db, runId, {
            expectVersion: options?.expectVersion,
            // The one reading, under the write lock, once the run is found deletable.
            stamp: () => takeRawReading(this.clock).toISOString(),
            statement,
          });
          if (judged.kind === 'absent') return { bytes_deleted: 0 };
          if (judged.kind === 'refused') throw judged.error;
          return { bytes_deleted: judged.bytes, at: judged.at };
        },
        (db, deletion) => verifyDeleted(db, runId, deletion),
        { takesReading: false },
      );
      return { bytes_deleted: deletion.bytes_deleted };
    } catch (err) {
      throw deleteFailure(err, ownStatementFailed, { runId, store: STORE, artifact: ARTIFACT });
    }
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
