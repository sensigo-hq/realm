// replay-store.ts — #616 B1: the store `realm run replay` saves its results in and `realm run diff`
// reads them from. The interface and its record live in the core so a store in another package
// (SQLite) implements them; the CLI's file store implements them.

/** One step of a replay: whether its preconditions held in the run, and with the overrides. */
export interface ReplayStepResult {
  step_id: string;
  /** All preconditions passed in the original run? */
  preconditions_original: boolean;
  /** All preconditions pass with overridden evidence? */
  preconditions_replay: boolean;
  changed: boolean;
  /** True when the step has at least one precondition defined. */
  has_preconditions: boolean;
}

/** A persisted replay snapshot: the result of replayRun() + the metadata that produced it. */
export interface ReplayRecord {
  /** Unique ID, always starts with "rpl_". */
  id: string;
  /** The run ID that was replayed. */
  origin_run_id: string;
  /** The workflow ID of the origin run. */
  workflow_id: string;
  /** The overrides that were applied: ["step.field=value", ...] — raw string form. */
  overrides: string[];
  /** The step-level results from replayRun(). */
  results: ReplayStepResult[];
  /** ISO 8601 creation timestamp. */
  created_at: string;
}

export interface ReplayStore {
  /** Persist a replay record. Returns the stored record with its assigned ID. */
  save(record: Omit<ReplayRecord, 'id' | 'created_at'>): Promise<ReplayRecord>;
  /** Get a replay record by ID. Throws a plain Error if not found (not a WorkflowError). */
  get(replayId: string): Promise<ReplayRecord>;
}
