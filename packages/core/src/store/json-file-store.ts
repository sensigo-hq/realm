// Local file-backed run store. Stores each run as a JSON file in ~/.realm/runs/.
// Uses proper-lockfile to prevent concurrent writes.
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import lockfile from 'proper-lockfile';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunStore, CreateRunOptions } from './store-interface.js';
import { findEligibleSteps, deriveRunPhase } from '../engine/eligibility.js';
import { hashParams } from './params-hash.js';
import { decideIdempotencyPolicy } from './idempotency-policy.js';

const DEFAULT_RUNS_DIR = join(homedir(), '.realm', 'runs');

/** Bounded per-key lock retry policy — used for the resolve-or-claim critical section. */
const KEY_LOCK_RETRIES = { retries: 10, minTimeout: 50 } as const;

/**
 * A pointer file: the authoritative, deterministic index entry for one idempotency key.
 * Stored at `<runsDir>/keys/<sha256(workflowId\0key)>.json`.
 */
interface KeyPointer {
  run_id: string;
  workflow_id: string;
  key: string;
  /** sha256 of the canonical params of the run this pointer owns. */
  params_hash: string;
  updated_at: string;
}

/** Summary returned by {@link JsonFileStore.reconcileKeys}. */
export interface ReconcileSummary {
  /** Number of distinct (workflow_id, idempotency_key) groups encountered. */
  groups: number;
  /** Number of pointers written (or, in dry-run, that would be written). */
  keysWritten: number;
  /** Pointers already pointing at the canonical run (no write needed). */
  keysUnchanged: number;
  /** True when no files were written. */
  dryRun: boolean;
  /** Groups that had more than one run sharing the same key. */
  duplicateGroups: Array<{
    workflow_id: string;
    key: string;
    canonical_run_id: string;
    other_run_ids: string[];
  }>;
  /** Data-integrity finding: groups with more than one *live* (non-terminal) run. */
  multipleLiveGroups: Array<{
    workflow_id: string;
    key: string;
    canonical_run_id: string;
    extra_live_run_ids: string[];
  }>;
}

/**
 * Newest-first comparator: by `created_at` descending, tie-broken by lexicographically
 * greatest `id`. Used to deterministically pick a canonical run for a key.
 */
function compareCanonical(a: RunRecord, b: RunRecord): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/**
 * Canonical-pick rule (decision on record): exactly one live (non-terminal) run → it;
 * multiple live → newest live by created_at (the rest are reported as extraLive); else
 * the newest terminal by created_at (tie-break: greatest id).
 */
function pickCanonical(runs: RunRecord[]): { canonical: RunRecord; extraLive: RunRecord[] } {
  const live = runs.filter((r) => !r.terminal_state);
  if (live.length === 1) return { canonical: live[0]!, extraLive: [] };
  if (live.length > 1) {
    const sorted = [...live].sort(compareCanonical);
    return { canonical: sorted[0]!, extraLive: sorted.slice(1) };
  }
  const sorted = [...runs].sort(compareCanonical);
  return { canonical: sorted[0]!, extraLive: [] };
}

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

  /** Directory holding the idempotency-key pointer index. Invisible to `list()` (no `.json` suffix). */
  private keysDir(): string {
    return join(this.runsDir, 'keys');
  }

  /** Pointer file path for one (workflowId, key) pair. */
  private keyPath(workflowId: string, key: string): string {
    const hash = createHash('sha256').update(`${workflowId}\0${key}`).digest('hex');
    return join(this.keysDir(), `${hash}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
  }

  private async ensureKeysDir(): Promise<void> {
    await mkdir(this.keysDir(), { recursive: true });
  }

  /** Read a pointer file; returns undefined if absent or unparseable (self-heals via reclaim/fallback). */
  private async readPointer(keyPath: string): Promise<KeyPointer | undefined> {
    if (!existsSync(keyPath)) return undefined;
    try {
      return JSON.parse(await readFile(keyPath, 'utf8')) as KeyPointer;
    } catch {
      return undefined;
    }
  }

  /** Write (or overwrite) a pointer file for `run` under `key`. params_hash is derived from the owned run. */
  private async writePointer(keyPath: string, run: RunRecord, key: string): Promise<void> {
    const pointer: KeyPointer = {
      run_id: run.id,
      workflow_id: run.workflow_id,
      key,
      params_hash: hashParams(run.params),
      updated_at: new Date().toISOString(),
    };
    await writeFile(keyPath, JSON.stringify(pointer, null, 2), 'utf8');
  }

  /** Build and persist a brand-new run record (today's path, factored out). */
  private async writeFreshRun(options: CreateRunOptions): Promise<RunRecord> {
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

  /** Find the canonical pre-existing run for (workflowId, key) via the legacy `idempotency_key` field. */
  private async findCanonicalLegacyRun(
    workflowId: string,
    key: string,
  ): Promise<RunRecord | undefined> {
    const matches = (await this.list(workflowId)).filter((r) => r.idempotency_key === key);
    if (matches.length === 0) return undefined;
    return pickCanonical(matches).canonical;
  }

  async create(options: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }> {
    await this.ensureDir();

    // No idempotency key → always a fresh run.
    if (options.idempotencyKey === undefined) {
      const run = await this.writeFreshRun(options);
      return { run, created: true };
    }

    await this.ensureKeysDir();
    const key = options.idempotencyKey;
    const keyPath = this.keyPath(options.workflowId, key);

    // Per-key mutual exclusion for the whole resolve-or-claim critical section.
    // realpath:false lets us lock a key path whose pointer file does not exist yet.
    const release = await lockfile.lock(keyPath, {
      realpath: false,
      retries: KEY_LOCK_RETRIES,
    });
    try {
      const pointer = await this.readPointer(keyPath);
      if (pointer !== undefined) {
        // (b) Pointer present → load the target run.
        const target = await this.get(pointer.run_id).catch((err: unknown) => {
          if (err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND') return undefined;
          throw err;
        });
        if (target !== undefined) {
          // (b') Apply the re-encounter policy to the matched run (PR 2). decideIdempotencyPolicy
          // is called directly here (not inside a nested async helper) so a `reject`/`fail` throw
          // is synchronous within this try — avoiding a transiently-orphaned rejected promise.
          if (decideIdempotencyPolicy(target, options) === 'reuse') {
            return { run: target, created: false };
          }
          return await this.supersede(options, keyPath, key);
        }
        // target missing → crash-orphan pointer; fall through to reclaim (d).
      } else {
        // (c) Pointer absent → lazy legacy fallback (self-migrates pre-existing data and
        // recovers run-written-but-pointer-not crash orphans, which still carry the field).
        const canonical = await this.findCanonicalLegacyRun(options.workflowId, key);
        if (canonical !== undefined) {
          // A legacy match runs through the same policy.
          if (decideIdempotencyPolicy(canonical, options) === 'reuse') {
            // Migrate the adopted run into the pointer index (PR 1 behavior).
            await this.writePointer(keyPath, canonical, key);
            return { run: canonical, created: false };
          }
          return await this.supersede(options, keyPath, key);
        }
      }

      // (d) Fresh claim / reclaim: run file FIRST, then pointer (overwrite on reclaim).
      const run = await this.writeFreshRun(options);
      await this.writePointer(keyPath, run, key);
      return { run, created: true };
    } finally {
      await release();
    }
  }

  /**
   * Supersede the current key owner with a fresh run (must be called under the per-key lock):
   * run file FIRST, then an atomic pointer overwrite to the successor (PR 1 ordering). The
   * superseded run stays on disk by id (auditable); `pickCanonical` prefers the newer successor,
   * so a lost pointer self-heals to the new run.
   */
  private async supersede(
    options: CreateRunOptions,
    keyPath: string,
    key: string,
  ): Promise<{ run: RunRecord; created: boolean }> {
    const run = await this.writeFreshRun(options);
    await this.writePointer(keyPath, run, key);
    return { run, created: true };
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
   * When the record carries an idempotency_key, the key pointer is registered/repointed
   * (closing the import back door): a conflict with a different *live* owner throws.
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
    // Run file FIRST (consistent with create()), then register the key pointer.
    await writeFile(path, JSON.stringify(record, null, 2), 'utf8');
    await this.registerImportedKey(record);
  }

  /**
   * Register (or repoint) the idempotency-key pointer for an imported record, under the
   * per-key lock. If the key is already owned by a DIFFERENT live run, refuse and throw
   * (a missing or terminal prior owner is safely repointed).
   */
  private async registerImportedKey(record: RunRecord): Promise<void> {
    if (record.idempotency_key === undefined) return;
    await this.ensureKeysDir();
    const key = record.idempotency_key;
    const keyPath = this.keyPath(record.workflow_id, key);
    const release = await lockfile.lock(keyPath, { realpath: false, retries: KEY_LOCK_RETRIES });
    try {
      const pointer = await this.readPointer(keyPath);
      if (pointer !== undefined && pointer.run_id !== record.id) {
        const owner = await this.get(pointer.run_id).catch(() => undefined);
        if (owner !== undefined && !owner.terminal_state) {
          throw new WorkflowError(
            `Idempotency key for workflow '${record.workflow_id}' is already owned by a different live run '${owner.id}'; refusing to repoint to imported run '${record.id}'.`,
            {
              code: 'STATE_RUN_DIVERGED',
              category: 'STATE',
              agentAction: 'report_to_user',
              retryable: false,
              details: { runId: record.id, existingOwnerRunId: owner.id },
            },
          );
        }
        // owner missing or terminal → safe to repoint to the imported record.
      }
      await this.writePointer(keyPath, record, key);
    } finally {
      await release();
    }
  }

  /**
   * Eager migration: build the key pointer index from the legacy `idempotency_key` field on
   * existing runs. Groups runs by (workflow_id, key), writes the pointer to the canonical run
   * (see {@link pickCanonical}). Idempotent (re-running writes nothing new), reversible (only
   * touches `keys/`; never mutates or deletes run files).
   */
  async reconcileKeys(workflowId?: string, dryRun = false): Promise<ReconcileSummary> {
    await this.ensureDir();
    if (!dryRun) await this.ensureKeysDir();

    const groups = new Map<string, RunRecord[]>();
    for (const run of await this.list(workflowId)) {
      if (run.idempotency_key === undefined) continue;
      const gk = `${run.workflow_id}\0${run.idempotency_key}`;
      const arr = groups.get(gk);
      if (arr === undefined) groups.set(gk, [run]);
      else arr.push(run);
    }

    const summary: ReconcileSummary = {
      groups: groups.size,
      keysWritten: 0,
      keysUnchanged: 0,
      dryRun,
      duplicateGroups: [],
      multipleLiveGroups: [],
    };

    for (const runs of groups.values()) {
      const { canonical, extraLive } = pickCanonical(runs);
      const key = canonical.idempotency_key!;
      const keyPath = this.keyPath(canonical.workflow_id, key);

      if (runs.length > 1) {
        summary.duplicateGroups.push({
          workflow_id: canonical.workflow_id,
          key,
          canonical_run_id: canonical.id,
          other_run_ids: runs.filter((r) => r.id !== canonical.id).map((r) => r.id),
        });
      }
      if (extraLive.length > 0) {
        summary.multipleLiveGroups.push({
          workflow_id: canonical.workflow_id,
          key,
          canonical_run_id: canonical.id,
          extra_live_run_ids: extraLive.map((r) => r.id),
        });
      }

      const existing = await this.readPointer(keyPath);
      const unchanged =
        existing !== undefined &&
        existing.run_id === canonical.id &&
        existing.params_hash === hashParams(canonical.params);
      if (unchanged) {
        summary.keysUnchanged++;
        continue;
      }
      summary.keysWritten++;
      if (!dryRun) await this.writePointer(keyPath, canonical, key);
    }

    return summary;
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
