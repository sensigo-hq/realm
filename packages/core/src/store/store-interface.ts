// Interface for run record persistence — implemented by JsonFileStore (local) and future Postgres store.
import type { RunPhase, RunRecord, SealedBy } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { SealRunDelta, SettlementDelta, SettlementResult } from '../types/settlement.js';
import type { Attributed } from '../engine/holder.js';
import type { ExtensionIdentityEntry } from '../types/extension-identity.js';
import type { Snapshot } from '../engine/snapshot.js';
import type { Clock } from '../utils/clock.js';

/**
 * The load-bearing `RunRecord` fields the engine treats specially enough that a store must
 * DECLARE which it round-trips (issue #188). This is a CLOSED set — a field qualifies via EITHER
 * (a) a real, verified READ-SITE consumer whose absence corrupts control flow (see
 * `RunStore.persistedRunRecordFields`'s own doc for the consumer list) — the first four below —
 * OR (b) a WRITE-SITE disclosure-integrity advisory, whose non-durability is surfaced LOUDLY
 * (a runtime warning) rather than silently dropped — `defaulted_steps` (issue #220 PR-2), which
 * has no read-site consumer in-repo today (reading it is PR-3's `$settlement` namespace) but whose
 * silent loss on a non-declaring store would misrepresent a run's true defaultedness to any
 * external consumer inspecting the persisted record directly. Not an open-ended "everything
 * RunRecord might ever carry":
 *  - `capability_blocks` — read by `findCapabilityBlockedSteps` (capability.ts), which returns
 *    `[]` on `undefined`; a store that drops it makes a genuinely-blocked step silently look
 *    unblocked to `get_run_state` / `list` / `run-agent`.
 *  - `workflow_context_snapshots` — read by the execution loop's `=== undefined` branch, which
 *    re-snapshots when absent; a store that drops it loses snapshot HISTORY (current context
 *    self-heals via re-snapshot, but prior snapshots are gone).
 *  - `extension_identity` — read by the execution loop's drift-evidence append (issue #119) and
 *    `realm inspect --check-drift`; a store that drops it resets the drift baseline every
 *    execution, so drift can never accumulate or be detected.
 *  - `validation_rejections` — read by `countRejection`'s exhaustion-threshold gate (issue #220,
 *    execution-loop.ts) on every counted rejection; a store that drops it resets the count to
 *    zero every write, so a persistently-invalid agent step never reaches the threshold and the
 *    exhaustion terminalization this field exists for silently never fires (the wedge #220 kills
 *    quietly resurrects on such a store).
 *  - `defaulted_steps` — a run-level convenience aggregate of steps that settled via their
 *    declared `validation_exhaustion.default_output` (issue #220 PR-2). No read-site consumer
 *    in-repo (PR-3's `$settlement` namespace reads per-step evidence instead); a store that drops
 *    it loses only the run-level convenience marker — the per-step evidence truth is unaffected —
 *    but the engine surfaces that loss as an explicit envelope warning rather than staying silent.
 *  - `settled` / `finalizer_ledger` (issue #279, increment 1) — read by `applySettlement`'s own
 *    predicate (`entryOf`/`leaseFinalizerArms`/`markFinalizerArms`) on every `settleStep` call; a
 *    store that drops either one makes its OWN next settle/lease/mark blind to prior settlement
 *    history, corrupting the idempotence/fencing guarantees `settleStep` exists to provide.
 *    DECLARATION-COHERENCE (TCK-asserted): a store that declares `settleStep` MUST declare BOTH
 *    of these fields — declaring the operation without the fields it depends on is a dishonest
 *    declaration, not merely an incomplete one. Dormant in this PR: nothing writes either field
 *    until PR-B migrates the seal sites, so a store declaring them today gains a dormant gate,
 *    never a behavior change. Joining this CLOSED set (rather than an open one) is deliberate:
 *    bumping it forces every full-set-declaring store's own fidelity TCK to grow two new cases at
 *    the SAME compile, so a store cannot silently drift out of sync with what settleStep needs.
 */
export type LoadBearingRunRecordField =
  | 'capability_blocks'
  | 'workflow_context_snapshots'
  | 'extension_identity'
  | 'validation_rejections'
  | 'defaulted_steps'
  | 'settled'
  | 'finalizer_ledger'
  // issue #367: the recorded seal fact. Its consumer profile is the strongest in this set — it is
  // `deriveRunPhase`'s FIRST input, so a store that drops it silently changes what every reader
  // believes the run's outcome was. A `settleStep`-declaring store MUST declare it.
  | 'sealed_by';

export interface CreateRunOptions {
  workflowId: string;
  workflowVersion: number;
  params: Record<string, unknown>;
  /** When provided, the store deduplicates: returns the existing run if one with the same (workflowId, idempotencyKey) exists. */
  idempotencyKey?: string;
  /** ID of the parent run that spawned this run via start_run_batch. */
  parentRunId?: string;
  /**
   * Policy when the idempotency key matches a **terminal** run (`completed`/`failed`/`aborted`/`abandoned`).
   * - `reuse` *(default)* — return the existing run (`created:false`).
   * - `reject` — throw `STATE_IDEMPOTENCY_KEY_USED`.
   * - `rerun_if_failed` — supersede a `failed`/`aborted`/`abandoned` match (mint a fresh run, `created:true`);
   *   a `completed` match is reused (benign skip).
   * - `rerun` — always supersede the matched run and mint a fresh run (`created:true`).
   */
  onTerminalMatch?: 'reuse' | 'reject' | 'rerun_if_failed' | 'rerun';
  /**
   * Policy when the idempotency key matches a **non-terminal** run (`running`/`gate_waiting`).
   * - `use_existing` *(default)* — return the live run (`created:false`).
   * - `fail` — throw `STATE_RUN_ALREADY_ACTIVE`.
   */
  onLiveMatch?: 'use_existing' | 'fail';
  /**
   * #729 PR-3 correction 5 (J-5, R48): the run's first `extension_identity` entries, written with
   * the new record (the creator's start entry, `origin: 'start'`). A run the call does not create
   * (an idempotent reuse) is not changed. A store that does not persist `extension_identity`
   * leaves them out.
   */
  extensionIdentity?: ExtensionIdentityEntry[];
}

/**
 * What `JsonFileStore.listWithDiagnostics` returns beside its diagnostics (the shape `list` returned
 * until #616 c4): every record with the reading it is judged at, and the listing's own reading.
 *
 * - `read_at` is the RAW reading, taken ONCE before the first record was read (D6-16).
 * - each snapshot's `at` is `read_at` floored by that record's own `updated_at` (`floorAtRecord`):
 *   every statement about a record holds at its own `at`.
 * - `consistent_snapshot` says whether the records were read as ONE cut: `true` for a store that reads
 *   them in one synchronous pass (the in-memory store), `false` for one that reads them one by one
 *   (the JSON-file store reads each file in turn, so two rows may come from different moments).
 */
export interface Listing {
  snapshots: Snapshot[];
  read_at: Date;
  consistent_snapshot: boolean;
}

/**
 * What a run store's `create` returns (#715 (b), D-15): the record with the reading the create
 * used, and whether it was written. A keyed create that returns an existing run (`created: false`)
 * has spent its reading too, and returns it.
 */
export type CreateResult = Snapshot & { created: boolean };

/**
 * What a run store's `settleStep` returns (#715 (b), D-19): the transform's result plus the write's
 * one reading `at` — returned on an applied write AND on a predicate refusal (both took it, after the
 * lock). A throw before the lock (a missing run) spends none.
 */
export type StoreSettlement = SettlementResult & { at: Date };

export interface RunStore {
  /**
   * The clock this store reads the time from (#715, D5 §1.1, D6-1, D6-5; required from #715 (b)).
   *
   * What it governs (B5′, D6-32): every instant a store call reads or mints — the WRITE class (a
   * write's `created_at`, `updated_at`, `opened_at`, `abandoned_at`, a claim's `since` and every
   * deadline minted from a frozen duration), the READ class (the reading a `get` or a page of `scan`
   * judges its records at, returned as `at` / `read_at`) and the EVENT class (a step's `completed_at`,
   * folded into the settle that records it). What it does NOT govern: instants minted outside a store
   * (the OUTSIDE class — a log line, a signature window, an export stamp) and durations (monotonic).
   * Each call that returns spends exactly one reading: the four writes after their lock, the reads
   * BEFORE they load; `stampSeal`, `save`, `reconcileKeys` and the store's own internal reads spend
   * none. `scan` spends one reading per page; `resolveKey` and `tombstonesSince` spend what their
   * store's one read spends — one on the SQLite store, none on a store that never purges, whose
   * horizon is a constant.
   *
   * A JSON-file or SQLite store holds no clock of its own but the authority its LOCATION has: it
   * takes no clock option and resolves its clock itself (the host's system clock, or a test
   * location's clock file). An in-memory store may hold any clock. The engine's admission refuses a
   * store without a callable `clock.now` and `clock.at` (`store_clock`).
   */
  readonly clock: Clock;

  /**
   * Whether this store round-trips the optional per-claim `claims` liveness clock (issue #101)
   * through `create`/`update`/`claimStep`. In-repo stores (`JsonFileStore`, `InMemoryStore`)
   * return `true`. An external store that drops unknown optional `RunRecord` fields must return
   * `false` — reclaim then loud-fails ("liveness recovery unavailable") rather than silently
   * no-opping, and a legacy/claims-less state on such a store is distinguishable from a genuine
   * `claim_unknown_age` claim on a claims-persisting store.
   */
  persistsClaims: boolean;

  /**
   * `true` when the store can delete a run and keeps a tombstone for each deleted run, so
   * `resolveKey` can answer `purged` and `scan` with `include_purged` can list them; `false` for a
   * store that never deletes a run (#616 PR-2c c4).
   */
  readonly purgesRuns: boolean;

  /**
   * Which {@link LoadBearingRunRecordField}s this store guarantees to round-trip through
   * `create`/`update`/`get` (issue #188). OPTIONAL and FAIL-CLOSED: `undefined` (or a field
   * absent from the declared set) means the engine must NOT assume the field's absence on a
   * read is authoritative — it surfaces the gap honestly instead (see the runtime gates in
   * `execution-loop.ts` and `get-run-state.ts`). A store that persists every `RunRecord` field
   * it's given (the common case — `JsonFileStore` and the `@sensigo/realm-testing` in-memory
   * store both do, by generic serialize/deserialize or by never dropping anything on write)
   * declares the FULL set, which makes every gate dormant: zero behavior change.
   *
   * This is intentionally the inverse of a REQUIRED capability: the default (absent) is the
   * CONSERVATIVE reading (assume nothing is persisted, warn accordingly), so adding this field
   * cannot retroactively break an external implementer that predates it (cf. issue #169's
   * "never make a capability required" precedent) — it only makes such a store's pre-existing
   * silent field-drop finally visible.
   */
  readonly persistedRunRecordFields?: ReadonlySet<LoadBearingRunRecordField>;

  /**
   * Create a new run record, or — when an `idempotencyKey` is supplied and a run with the
   * same `(workflowId, idempotencyKey)` already exists — return that existing run instead.
   *
   * Returns a {@link CreateResult} `{ record, at, created }` — `at` is the create's one reading
   * (taken after the key lock on a keyed create; floored by the run it supersedes):
   * - `created: true`  — a new run record was written, stamped with `at`.
   * - `created: false` — an existing run matched the idempotency key and is returned unchanged
   *   (nothing is re-driven); the reading it spent is still returned as `at`.
   *
   * NOTE (breaking, #715 (b)): this returned `{ run, created }`. External store implementations
   * (e.g. the cloud Postgres store) must return `{ record, at, created }`.
   */
  create(options: CreateRunOptions): Promise<CreateResult>;

  /**
   * Get a run by ID, with the reading it is judged at (#715 (b), D-15, D-16): ONE raw reading taken
   * BEFORE the record is loaded (D6-16), floored by the record's own `updated_at`, so every statement
   * about the loaded copy holds at `at`. A run that does not exist has spent its reading and throws
   * `WorkflowError(STATE_RUN_NOT_FOUND)`.
   */
  get(runId: string): Promise<Snapshot>;

  /**
   * Update a run record. Checks that record.version matches the stored version
   * before writing. Throws WorkflowError(STATE_SNAPSHOT_MISMATCH) on version conflict.
   * Increments version on successful write. Returns the written record with the write's one reading
   * (taken with the lock held, before the version check; a refused update has spent it).
   */
  update(record: RunRecord): Promise<Snapshot>;

  /**
   * Read the clock once per page, then the records the filter selects, in id order, `pageSize` at a
   * time (1 to 1,000), and return each page as `{ items, read_at, consistent_snapshot,
   * derived_at_read, next_after? }`; with `include_purged` the deleted runs' tombstones come as
   * `{ kind: 'purged', … }` items beside the `{ kind: 'run', run }` items (#616 PR-2c c4; it replaces
   * `list`).
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

  /**
   * Say who holds an idempotency key: `{ state: 'held', run_id }` when a run carries it;
   * `{ state: 'purged', runs, since }` when only deleted runs did; `{ state: 'unseen', since }` when
   * none has, as far as the store's tombstones reach (#616 PR-2c c4).
   */
  resolveKey(workflowId: string, key: string): Promise<KeyAnswer>;

  /**
   * The tombstone horizon: the instant before which a deleted run may no longer be on record (#616
   * PR-2c c4).
   */
  tombstonesSince(): Promise<string>;

  /**
   * Atomically marks a step as in_progress. Under file lock:
   * 1. Re-reads the current record (ignores caller's version).
   * 2. Checks the step is not already in in_progress_steps, completed_steps,
   *    failed_steps, or skipped_steps. If it is, throws STATE_STEP_ALREADY_CLAIMED.
   * 3. Re-evaluates trigger rule and when-condition. If no longer satisfied,
   *    throws STATE_STEP_NOT_ELIGIBLE.
   * 4. Adds step to in_progress_steps, increments version, writes.
   * Returns the updated record.
   *
   * **Cross-cutting single-owner obligation (issue #188):** MUST be atomic and single-owner
   * across ALL processes/hosts sharing this store: two concurrent `claimStep` calls for the
   * same `(runId, step)` MUST NOT both succeed. A store that cannot guarantee this (e.g.
   * without a row-lock/CAS) breaks both the resurrect-race protection (#184) and the
   * trace-buffer epoch minting (#185). This obligation is stated here for any external store
   * implementer; a store's own conformance suite must verify it holds across its actual
   * concurrency model (the in-repo TCK's `claimStep` test only verifies the same-host case —
   * see its own doc for why cross-host cannot be verified generically).
   *
   * **Who took the step (issue #625, the holder slice).** `claimant` is the host PROGRAM taking the
   * step — a name for people to read, never compared and never a reason to refuse. A store that
   * keeps claims writes it as `claims[stepName].holder` when it is passed, and stamps
   * `claims[stepName].since` (ISO) on EVERY claim, inside the one write that creates the claim.
   * `since` is the store's own act, so a claim read back says when it was taken whoever took it.
   *
   * Returns the claimed record with the claim's one reading (#715): the deadline, `since` and
   * `updated_at` are all minted from it.
   */
  claimStep(
    runId: string,
    stepName: string,
    definition: WorkflowDefinition,
    claimant?: Attributed,
  ): Promise<Snapshot>;

  /**
   * Atomically applies one {@link SettlementDelta} to this run's FRESH state, under the store's
   * own serialization (issue #279). REQUIRED (#715 (b), D-19): the engine writes every settlement
   * through it, and admission refuses a store without it (`store_settle_step`).
   *
   * **One reading (#715 (b), D-19).** After the lock, the store takes ONE reading
   * `at = takeReading(clock, fresh, delta)` — floored by the fresh record, with the delta's event
   * instants folded in — and hands it to `applySettlement`, which mints EVERY instant of its output
   * from it (`updated_at` included). The result carries `at`, on an applied write and on a predicate
   * refusal alike; a throw before the lock spends none.
   *
   * **LIVE for every kind.** The engine constructs and passes `settle_step`, `lease_finalizer` and
   * `mark_finalizer` since v0.32.0; `open_gate`, `settle_gate`, `settle_guard` and `release_step`
   * since v0.33.0; `expire_gate` since v0.34.0. Declaring this method commits a store to the FULL,
   * OPEN-ended `SettlementDelta` union (see that type's own doc): a re-implementing store MUST
   * refuse-loud (throw a contract-violation error) on any `kind` it does not recognize, never
   * default-arm it.
   *
   * **Guards in the same write (issue #625).** A store that declares this method MUST pass
   * `cascadeGuards: true` to `applySettlement` and persist the record it returns in ONE write. With
   * that option a delta that makes a guard step eligible also settles that guard, and any guard
   * that one makes eligible; the applied result lists them in `guards`. The engine reads `guards`
   * from what this method returns and does not settle those guards itself on the gate-answer and
   * gate-expiry paths, so a store that omits the option leaves a guard after a gate unsettled.
   * The caller never passes the option. The contract's laws `GUARD_CASCADE_ONE_WRITE` and
   * `GUARD_CASCADE_TOTAL` check this.
   *
   * **`seal_run` moves THROW (#715 (b), D6-65).** The transform returns a `seal_run` whose
   * `expected_version` no longer matches as the refusal `moved`; the store THROWS it as
   * `STATE_SNAPSHOT_MISMATCH`, exactly as `update()` throws a version conflict. Every other refusal
   * returns.
   *
   * **Two overloads (#715 (b), Amendment 1).** A `seal_run` delta takes NO definition — a seal must
   * work when the workflow is gone, and its transform reads none; every other kind takes one. An
   * implementer declares `settleStep(runId, delta, definition?)`; `applySettlement` takes the
   * `seal_run` branch before it touches the definition, and throws a contract-violation `Error` for
   * any other kind that arrives without one.
   *
   * **A WRITE surface, not a read-only helper** — it carries every obligation `update()` already
   * does for this store (e.g. a cloud store's own policy/authorization gate on the write; M1):
   * implementers must NOT skip whatever wrapper logic their `update()` implementation applies.
   *
   * **Atomicity, own-suite proof required (L4 caveat):** for a store whose CS is a single
   * lock + read + write (this repo's `JsonFileStore`/`InMemoryStore`), the existing
   * lock/synchronous-stretch discipline already suffices. A MULTI-STATEMENT backend (e.g. a
   * future Postgres store issuing more than one SQL statement to apply a delta) MUST prove its
   * own atomicity — a version-CAS `UPDATE ... WHERE version = $1` alone is not sufficient once
   * more than one statement is involved — in ITS OWN conformance suite before declaring this
   * method; a green run of the in-repo TCK here does not and cannot verify that for an external
   * backend (mirrors `claimStep`'s own cross-host caveat).
   *
   * **Infra THROWS; predicate outcomes RETURN.** A genuine I/O/lock-acquisition failure
   * (ENOENT/ELOCKED-mapped, or an unmapped store error) throws, exactly like `update()`. Every
   * REFUSE/NOOP arm of `applySettlement`'s predicate is a normal RETURN
   * (`{applied:false, reason, run}`) — never thrown as a `WorkflowError`. Implementations must not
   * invert this: a predicate refusal is not an exceptional condition.
   */
  settleStep(runId: string, delta: SealRunDelta): Promise<StoreSettlement>;
  settleStep(
    runId: string,
    delta: Exclude<SettlementDelta, SealRunDelta>,
    definition: WorkflowDefinition,
  ): Promise<StoreSettlement>;

  /**
   * Issue #367 (part 3): write a `sealed_by` stamp onto an ALREADY-TERMINAL record — the migration
   * vehicle's only write verb. Optional: a store that does not declare it is refused by
   * `realm run migrate --stamp-seals`, with a pointer to its own tooling, rather than silently doing
   * nothing. It spends no reading (#715 (b), D-16): `updated_at` is carried through.
   *
   * Four checks, in this order:
   *
   * 1. `expectedVersion` must match the stored version, or it THROWS `STATE_SNAPSHOT_MISMATCH` —
   *    `update()`-parity. A version move means someone else wrote while the sweep was reading, and
   *    the sweep's classification was made against a record that no longer exists.
   * 2. An already-stamped record RETURNS `{stamped: false, reason: 'already_stamped'}`.
   * 3. A non-terminal record RETURNS `{stamped: false, reason: 'not_terminal'}`.
   * 4. Anything else is a real write, and the store's own seal-integrity boundary runs on it like
   *    on any other tail — so an incoherent stamp is refused there too.
   *
   * **Predicate refusals RETURN; infra THROWS** — the same rule stated for `settleStep` above. A
   * record that is already stamped is not an exceptional condition.
   *
   * **`updated_at` is BYTE-PRESERVED, and `version` is bumped.** That split is the whole reason
   * this verb exists instead of a plain `update()`. The two clocks have disjoint consumers:
   * `version` is read only by the CAS protocol, `updated_at` only by retention, sorting and
   * display. Preserving BOTH makes the stamp silently erasable — a writer holding a pre-stamp
   * snapshot passes the CAS and wipes it (executed). Preserving NEITHER resets the retention
   * clock on every record it touches, which is precisely the harm `gc --heal` caused and this
   * vehicle exists to avoid. Stamping is not activity.
   *
   * `run_phase` is re-derived in the same write, like every other write tail. For the startup-death
   * population whose derived phase MOVED with #367, that is the clock-preserving materialisation
   * `--heal` cannot do.
   */
  stampSeal?(runId: string, sealedBy: SealedBy, expectedVersion: number): Promise<StampSealResult>;
}

/**
 * Issue #367 (part 3): the outcome of a {@link RunStore.stampSeal} attempt. Both refusal reasons
 * are PREDICATE outcomes, returned rather than thrown, and both carry the record as it stands so
 * the caller can report on it without a second read.
 */
export type StampSealResult =
  | { stamped: true; run: RunRecord }
  | { stamped: false; reason: 'already_stamped' | 'not_terminal'; run: RunRecord };

/**
 * The most runs one page of a store's scan may hold (#616 PR-2c c3; DELTAS 33). A page size above it,
 * below 1 or not a whole number is refused: a listing is never silently unlimited (R12). One page of
 * 1,000 reassembled records costs a synchronous driver about 80–140 ms (PRB-2C-10).
 */
export const SCAN_MAX_PAGE_SIZE = 1000;

/**
 * The filters of a store's scan (design §6, spelled as §6's filter list spells them; §6 writes
 * `includePurged` once for the same filter). Every filter given must hold. `key` needs `workflow`: a
 * key is a key of one workflow. `created_since` and `updated_since` are stamps in the store's one
 * shape (`YYYY-MM-DDTHH:MM:SS.sssZ`), compared as text and inclusive.
 */
export interface ScanFilter {
  workflow?: string;
  phase?: RunPhase;
  terminal?: boolean;
  key?: string;
  created_since?: string;
  updated_since?: string;
  include_purged?: boolean;
}

/**
 * How a scan pages: `pageSize` is required, a whole number from 1 to {@link SCAN_MAX_PAGE_SIZE};
 * `projection` is `'record'` (the default: each run as `get()` returns it) or `'row'` (each run as a
 * {@link RunRow}); `after` starts the scan after that id (the last id of the page before, §6's
 * `--after` cursor).
 */
export interface ScanOptions {
  pageSize: number;
  projection?: 'record' | 'row';
  after?: string;
}

/**
 * One run as a scan's `'row'` projection gives it (design §6's facts row): the record's own fields, but
 * `run_phase` is the derived phase, `terminal_state` is the column's 0/1 as a boolean, `run_version` is
 * the record's `version` (M6's name) and `pending_gate` is the gate's id or `null`. No params, no
 * evidence.
 */
export interface RunRow {
  id: string;
  workflow_id: string;
  run_phase: RunPhase;
  terminal_state: boolean;
  sealed_by_arm: string | null;
  created_at: string;
  updated_at: string;
  idempotency_key: string | null;
  rerun_of: string | null;
  run_version: number;
  pending_gate: string | null;
  completed_steps: string[];
  in_progress_steps: string[];
  failed_steps: string[];
}

/**
 * A deleted run's tombstone as a scan with `include_purged` gives it (design §6): its id, its workflow,
 * when it was purged, its seal's arm, and the phase and derivation stamp it had when purged (its
 * record is gone, so its phase cannot be derived again).
 */
export interface PurgedItem {
  kind: 'purged';
  run_id: string;
  workflow_id: string | null;
  purged_at: string;
  sealed_by_arm: string | null;
  run_phase: RunPhase;
  phase_version: string;
}

/** One item of a scan's page: a run in the scan's projection, or a tombstone. */
export type ScanItem<P extends 'record' | 'row'> =
  { kind: 'run'; run: P extends 'record' ? Snapshot : RunRow } | PurgedItem;

/**
 * One page of a store's scan: its items in id order, the page's one reading (`read_at`), the flag
 * that the page was read in ONE read transaction (`consistent_snapshot`: one transaction per page
 * under WAL), how many rows read for the page carried a phase stamped by another derivation
 * (`derived_at_read`: each was derived at read; 0 when none), and, when the page is full, the cursor
 * the next page starts after (`next_after`, the page's last id).
 */
export interface ScanPage<P extends 'record' | 'row'> {
  items: ScanItem<P>[];
  read_at: Date;
  consistent_snapshot: true;
  derived_at_read: number;
  next_after?: string;
}

/**
 * Who holds an idempotency key, read in one snapshot (design §3, axis 7): `held` names the run that
 * holds it; `purged` lists the deleted runs that carried it, when no run does; `unseen` says no run
 * carries it and no kept tombstone records one. `since` is the tombstone horizon: a run purged at or
 * before it may have left no tombstone.
 */
export type KeyAnswer =
  | { state: 'held'; run_id: string }
  | { state: 'purged'; runs: Array<{ run_id: string; purged_at: string }>; since: string }
  | { state: 'unseen'; since: string };
