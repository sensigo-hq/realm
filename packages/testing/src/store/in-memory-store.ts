// InMemoryStore — in-memory implementation of RunStore for use in tests.
import {
  WorkflowError,
  findEligibleSteps,
  deriveRunPhase,
  decideIdempotencyPolicy,
  computeClaimDeadline,
  isStepSettledOrInFlight,
  type RunStore,
  type RunRecord,
  type CreateRunOptions,
  type WorkflowDefinition,
  type LoadBearingRunRecordField,
} from '@sensigo/realm';

/** In-memory implementation of RunStore. Uses a Map keyed by run ID. No I/O, no locking. */
export class InMemoryStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();
  /** Idempotency-key pointer equivalent: `${workflowId}\0${key}` → runId. Parity with JsonFileStore. */
  private readonly keyIndex = new Map<string, string>();

  /** Parity with JsonFileStore: round-trips the per-claim `claims` liveness clock (issue #101). */
  readonly persistsClaims = true;

  /** Parity with JsonFileStore (issue #188): every `create`/`update` stores the whole `RunRecord`
   *  object as-is (no field-by-field mapping), so nothing is ever dropped — declares the full set. */
  readonly persistedRunRecordFields: ReadonlySet<LoadBearingRunRecordField> = new Set([
    'capability_blocks',
    'workflow_context_snapshots',
    'extension_identity',
    'validation_rejections',
    'defaulted_steps',
  ]);

  async create(options: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }> {
    // Idempotency: a key match applies the re-encounter policy, like JsonFileStore.
    if (options.idempotencyKey !== undefined) {
      const gk = `${options.workflowId}\0${options.idempotencyKey}`;
      const existingId = this.keyIndex.get(gk);
      if (existingId !== undefined) {
        const existing = this.runs.get(existingId);
        if (existing !== undefined) {
          // `reuse` → return the existing run; `supersede` → fall through to a fresh create
          // (which overwrites the keyIndex entry below). `fail`/`reject` throw.
          if (decideIdempotencyPolicy(existing, options) === 'reuse') {
            return { run: existing, created: false };
          }
        }
        // mapped run vanished (or superseded) → fall through to a fresh create.
      }
    }

    const now = new Date().toISOString();
    const record: RunRecord = {
      id: crypto.randomUUID(),
      workflow_id: options.workflowId,
      workflow_version: options.workflowVersion,
      ...(options.parentRunId !== undefined ? { parent_run_id: options.parentRunId } : {}),
      ...(options.idempotencyKey !== undefined ? { idempotency_key: options.idempotencyKey } : {}),
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
    this.runs.set(record.id, record);
    if (options.idempotencyKey !== undefined) {
      this.keyIndex.set(`${options.workflowId}\0${options.idempotencyKey}`, record.id);
    }
    return { run: record, created: true };
  }

  async get(runId: string): Promise<RunRecord> {
    const record = this.runs.get(runId);
    if (record === undefined) {
      throw new WorkflowError(`Run '${runId}' not found`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    return record;
  }

  async update(record: RunRecord): Promise<RunRecord> {
    const existing = this.runs.get(record.id);
    if (existing === undefined) {
      throw new WorkflowError(`Run '${record.id}' not found`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    if (existing.version !== record.version) {
      throw new WorkflowError('Version conflict — run was modified by another process', {
        code: 'STATE_SNAPSHOT_MISMATCH',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: true,
        details: { runId: record.id, expected: record.version, actual: existing.version },
      });
    }
    const updated: RunRecord = {
      ...record,
      run_phase: deriveRunPhase(record),
      version: record.version + 1,
      updated_at: new Date().toISOString(),
    };
    this.runs.set(updated.id, updated);
    return updated;
  }

  async claimStep(
    runId: string,
    stepName: string,
    definition: WorkflowDefinition,
  ): Promise<RunRecord> {
    // issue #188: read the record SYNCHRONOUSLY (a direct Map.get, not `await this.get(...)`) so
    // the read → eligibility-check → write below is one indivisible synchronous stretch. This is
    // what makes claimStep single-owner for concurrent same-process calls (the cross-cutting
    // obligation on RunStore.claimStep; the TCK's concurrent-claimStep case exercises exactly
    // this against this store). `await this.get(runId)` would NOT be safe here even though the
    // lookup itself has no I/O: unwrapping an already-resolved promise still costs one microtask
    // tick, during which a second `Promise.all`'d claimStep call's own (equally synchronous) read
    // can run BEFORE either call has written — verified empirically: two concurrent claimStep
    // calls for the same (runId, step) both resolved successfully before this fix.
    // issue #207: `isStepSettledOrInFlight` (below) is pure/synchronous by design — it performs no
    // I/O and awaits nothing, so calling it here does not reintroduce the microtask-yield point
    // this fix removes; the no-await constraint above still holds.
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new WorkflowError(`Run '${runId}' not found`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    if (isStepSettledOrInFlight(run, stepName)) {
      throw new WorkflowError(`Step '${stepName}' is already claimed or done`, {
        code: 'STATE_STEP_ALREADY_CLAIMED',
        category: 'STATE',
        agentAction: 'resolve_precondition',
        retryable: false,
      });
    }
    const eligible = findEligibleSteps(definition, run);
    if (!eligible.includes(stepName)) {
      throw new WorkflowError(`Step '${stepName}' is not eligible`, {
        code: 'STATE_STEP_NOT_ELIGIBLE',
        category: 'STATE',
        agentAction: 'resolve_precondition',
        retryable: false,
      });
    }
    // Per-claim liveness clock (issue #101) — mirrors JsonFileStore.claimStep: stamp claims[S]
    // atomically with the in_progress add (OVERWRITE, so a missed settle-site delete self-heals).
    const deadline = computeClaimDeadline(definition, stepName, new Date());
    const updated: RunRecord = {
      ...run,
      in_progress_steps: [...run.in_progress_steps, stepName],
      claims: { ...run.claims, [stepName]: { deadline } },
      run_phase: 'running',
      version: run.version + 1,
      updated_at: new Date().toISOString(),
    };
    this.runs.set(updated.id, updated);
    return updated;
  }

  async list(workflowId?: string): Promise<RunRecord[]> {
    const all = [...this.runs.values()];
    if (workflowId !== undefined) {
      return all.filter((r) => r.workflow_id === workflowId);
    }
    return all;
  }
}
