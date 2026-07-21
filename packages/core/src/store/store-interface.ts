// Interface for run record persistence — implemented by JsonFileStore (local) and future Postgres store.
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

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
 */
export type LoadBearingRunRecordField =
  | 'capability_blocks'
  | 'workflow_context_snapshots'
  | 'extension_identity'
  | 'validation_rejections'
  | 'defaulted_steps';

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
}

export interface RunStore {
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
   * Returns `{ run, created }`:
   * - `created: true`  — a new run record was written.
   * - `created: false` — an existing run matched the idempotency key and is returned unchanged
   *   (nothing is re-driven; callers inspect `run.run_phase` to decide what to surface).
   *
   * NOTE (breaking, 0.8.0): this previously returned `Promise<RunRecord>`. External store
   * implementations (e.g. the cloud Postgres store) must update to the `{ run, created }` shape.
   */
  create(options: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }>;

  /** Get a run record by ID. Throws WorkflowError(STATE_RUN_NOT_FOUND) if not found. */
  get(runId: string): Promise<RunRecord>;

  /**
   * Update a run record. Checks that record.version matches the stored version
   * before writing. Throws WorkflowError(STATE_SNAPSHOT_MISMATCH) on version conflict.
   * Increments version on successful write.
   */
  update(record: RunRecord): Promise<RunRecord>;

  /** List all run records, optionally filtered by workflowId. */
  list(workflowId?: string): Promise<RunRecord[]>;

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
   */
  claimStep(runId: string, stepName: string, definition: WorkflowDefinition): Promise<RunRecord>;
}
