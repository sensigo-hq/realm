// Interface for run record persistence — implemented by JsonFileStore (local) and future Postgres store.
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

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
   */
  claimStep(runId: string, stepName: string, definition: WorkflowDefinition): Promise<RunRecord>;
}
