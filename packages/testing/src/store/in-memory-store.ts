// InMemoryStore — in-memory implementation of RunStore for use in tests.
import {
  WorkflowError,
  findEligibleSteps,
  deriveRunPhase,
  type RunStore,
  type RunRecord,
  type CreateRunOptions,
  type WorkflowDefinition,
} from '@sensigo/realm';

/** In-memory implementation of RunStore. Uses a Map keyed by run ID. No I/O, no locking. */
export class InMemoryStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();
  /** Idempotency-key pointer equivalent: `${workflowId}\0${key}` → runId. Parity with JsonFileStore. */
  private readonly keyIndex = new Map<string, string>();

  async create(options: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }> {
    // Idempotency: a key match returns the existing run (any phase), like JsonFileStore.
    if (options.idempotencyKey !== undefined) {
      const gk = `${options.workflowId}\0${options.idempotencyKey}`;
      const existingId = this.keyIndex.get(gk);
      if (existingId !== undefined) {
        const existing = this.runs.get(existingId);
        if (existing !== undefined) {
          return { run: existing, created: false };
        }
        // mapped run vanished → reclaim by falling through to a fresh create.
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
    const run = await this.get(runId);
    const alreadyDone = [
      ...run.completed_steps,
      ...run.in_progress_steps,
      ...run.failed_steps,
      ...run.skipped_steps,
    ];
    if (alreadyDone.includes(stepName)) {
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
    const updated: RunRecord = {
      ...run,
      in_progress_steps: [...run.in_progress_steps, stepName],
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
