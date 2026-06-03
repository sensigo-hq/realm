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
}

export interface RunStore {
  /** Create a new run record. Returns the created record. */
  create(options: CreateRunOptions): Promise<RunRecord>;

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
