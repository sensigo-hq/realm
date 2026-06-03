// Local file-backed run store. Stores each run as a JSON file in ~/.realm/runs/.
// Uses proper-lockfile to prevent concurrent writes.
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import lockfile from 'proper-lockfile';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunStore, CreateRunOptions } from './store-interface.js';
import { findEligibleSteps, deriveRunPhase } from '../engine/eligibility.js';

const DEFAULT_RUNS_DIR = join(homedir(), '.realm', 'runs');

export class JsonFileStore implements RunStore {
  private readonly runsDir: string;

  constructor(runsDir?: string) {
    this.runsDir = runsDir ?? DEFAULT_RUNS_DIR;
  }

  /** The directory where run JSON files are stored. */
  get runsDirPath(): string {
    return this.runsDir;
  }

  private filePath(runId: string): string {
    return join(this.runsDir, `${runId}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
  }

  async create(options: CreateRunOptions): Promise<RunRecord> {
    await this.ensureDir();

    // Idempotency check: if a key is supplied, return the existing run if one matches.
    if (options.idempotencyKey !== undefined) {
      const existing = await this.list(options.workflowId);
      const match = existing.find((r) => r.idempotency_key === options.idempotencyKey);
      if (match !== undefined) return match;
    }

    const now = new Date().toISOString();
    const record: RunRecord = {
      id: uuidv4(),
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
    await writeFile(this.filePath(record.id), JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  async get(runId: string): Promise<RunRecord> {
    const path = this.filePath(runId);
    if (!existsSync(path)) {
      throw new WorkflowError(`Run not found: ${runId}`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId },
      });
    }
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Legacy format detection: runs written before Phase 35 have `state` but no `completed_steps`.
    if ('state' in parsed && !('completed_steps' in parsed)) {
      throw new WorkflowError(
        'This run was created with an older version of Realm that used a state-machine model. ' +
          'Delete ~/.realm/runs/ and start fresh.',
        {
          code: 'STATE_LEGACY_FORMAT',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
          details: { runId },
        },
      );
    }

    return parsed as unknown as RunRecord;
  }

  async update(record: RunRecord): Promise<RunRecord> {
    await this.ensureDir();
    const path = this.filePath(record.id);

    if (!existsSync(path)) {
      throw new WorkflowError(`Run not found: ${record.id}`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId: record.id },
      });
    }

    const release = await lockfile.lock(path, { retries: { retries: 3, minTimeout: 50 } });
    try {
      const raw = await readFile(path, 'utf8');
      const stored = JSON.parse(raw) as RunRecord;

      if (stored.version !== record.version) {
        throw new WorkflowError('Version conflict — run was modified by another process', {
          code: 'STATE_SNAPSHOT_MISMATCH',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: true,
          details: { runId: record.id, expected: record.version, actual: stored.version },
        });
      }

      const updated: RunRecord = {
        ...record,
        run_phase: deriveRunPhase(record),
        version: record.version + 1,
        updated_at: new Date().toISOString(),
      };
      await writeFile(path, JSON.stringify(updated, null, 2), 'utf8');
      return updated;
    } finally {
      await release();
    }
  }

  async claimStep(
    runId: string,
    stepName: string,
    definition: WorkflowDefinition,
  ): Promise<RunRecord> {
    await this.ensureDir();
    const path = this.filePath(runId);

    if (!existsSync(path)) {
      throw new WorkflowError(`Run not found: ${runId}`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId },
      });
    }

    const release = await lockfile.lock(path, { retries: { retries: 3, minTimeout: 50 } });
    try {
      // Re-read the freshest version under lock.
      const raw = await readFile(path, 'utf8');
      const run = JSON.parse(raw) as RunRecord;

      // Guard: step must not already be claimed.
      if (
        run.in_progress_steps.includes(stepName) ||
        run.completed_steps.includes(stepName) ||
        run.failed_steps.includes(stepName) ||
        run.skipped_steps.includes(stepName)
      ) {
        throw new WorkflowError(
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

      // Guard: step must still be eligible under the current run state.
      const eligible = findEligibleSteps(definition, run);
      if (!eligible.includes(stepName)) {
        throw new WorkflowError(
          `Step '${stepName}' is not eligible for execution on run '${runId}'.`,
          {
            code: 'STATE_STEP_NOT_ELIGIBLE',
            category: 'STATE',
            agentAction: 'resolve_precondition',
            retryable: false,
            details: { runId, stepName, eligible },
          },
        );
      }

      const claimed: RunRecord = {
        ...run,
        in_progress_steps: [...run.in_progress_steps, stepName],
        run_phase: deriveRunPhase(run),
        version: run.version + 1,
        updated_at: new Date().toISOString(),
      };
      await writeFile(path, JSON.stringify(claimed, null, 2), 'utf8');
      return claimed;
    } finally {
      await release();
    }
  }

  /**
   * Writes a run record with its existing ID to local storage.
   * Used for importing records fetched from a remote store.
   * Idempotent: if the record already exists with the same version, this is a no-op.
   * Does NOT increment version or apply the optimistic lock — this is an import, not an update.
   */
  async save(record: RunRecord): Promise<void> {
    await this.ensureDir();
    const path = this.filePath(record.id);
    if (existsSync(path)) {
      const raw = await readFile(path, 'utf8');
      const stored = JSON.parse(raw) as RunRecord;
      if (stored.version === record.version) return;
      throw new WorkflowError(
        `Run '${record.id}' exists locally with a different version (local: ${stored.version}, incoming: ${record.version}). Manual resolution required.`,
        {
          code: 'STATE_RUN_DIVERGED',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
          details: {
            runId: record.id,
            localVersion: stored.version,
            incomingVersion: record.version,
          },
        },
      );
    }
    await writeFile(path, JSON.stringify(record, null, 2), 'utf8');
  }

  async list(workflowId?: string): Promise<RunRecord[]> {
    await this.ensureDir();
    const entries: string[] = await readdir(this.runsDir);
    const jsonFiles: string[] = entries.filter((f: string) => f.endsWith('.json'));

    const records: RunRecord[] = await Promise.all(
      jsonFiles.map(async (file: string) => {
        const raw = await readFile(join(this.runsDir, file), 'utf8');
        return JSON.parse(raw) as RunRecord;
      }),
    );

    if (workflowId !== undefined) {
      return records.filter((r: RunRecord) => r.workflow_id === workflowId);
    }
    return records;
  }
}
