// Local file-backed run store. Stores each run as a JSON file in ~/.realm/runs/.
// Uses proper-lockfile to prevent concurrent writes.
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import lockfile from 'proper-lockfile';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunStore, CreateRunOptions, LoadBearingRunRecordField } from './store-interface.js';
import type { PerRunArtifactStore } from './per-run-artifact-store.js';
import {
  findEligibleSteps,
  deriveRunPhase,
  isStepSettledOrInFlight,
} from '../engine/eligibility.js';
import { computeClaimDeadline } from '../engine/claim-liveness.js';
import { TERMINAL_PHASES } from '../engine/lifecycle.js';
import { hashParams } from './params-hash.js';
import { decideIdempotencyPolicy } from './idempotency-policy.js';
import { atomicWriteFile } from './atomic-write.js';
import { readIfExists, deleteIfExists, toArtifactDeleteFailedError } from './fs-io.js';

const DEFAULT_RUNS_DIR = join(homedir(), '.realm', 'runs');

/**
 * Shared `proper-lockfile` retry policy for EVERY lock this store takes — the 4 run-file
 * critical-section locks (`update`/`claimStep`/`save`/`deleteAllForRun`) and the 3 per-key locks
 * (`create`'s resolve-or-claim section, `registerImportedKey`, `deleteAllForRun`'s pointer delete)
 * (issue #191).
 *
 * `proper-lockfile` forwards this object VERBATIM to the `retry` package
 * (`retry.operation(options.retries)` — see `node_modules/proper-lockfile/lib/lockfile.js`), which
 * reads every field below itself (`node_modules/retry/lib/retry.js` + `retry_operation.js`) — no
 * filtering at either layer.
 *
 * - `randomize: true` — the LOAD-BEARING fix: without it (the `retry` package's own default),
 *   every contender computes the IDENTICAL deterministic backoff schedule and re-collides in
 *   lockstep under fan-out (a thundering herd). With it, `retry`'s `createTimeout` multiplies each
 *   attempt's delay by a fresh `Math.random() + 1` draw — contenders de-synchronize.
 * - `maxTimeout: 1000` — caps any SINGLE attempt's sleep (also closes the OLD per-key retry
 *   policy's latent worst-case: uncapped, its 10th attempt alone could sleep up to 25.6s).
 * - `maxRetryTime: 5000` — a TOTAL-TIME budget (the SQLite `busy_timeout` model): `retry`'s
 *   `RetryOperation.retry()` checks elapsed wall-time against this on every failed attempt and
 *   gives up once exceeded, REGARDLESS of `retries` remaining — so contention degrades gracefully
 *   into one retryable `STATE_RUN_BUSY` (Fix C) at a bounded ~5s, rather than either a hard count
 *   bound (~6.5s+ worst case with 10 retries × up to 1s each, uncapped further by jitter) or (pre-
 *   #191) failing fatally. Confirmed forwarding (not just by the source read above): a live check
 *   in this file's test suite holds a lock and asserts a SMALL-scale `maxRetryTime` cuts off well
 *   before the count-bound worst case would.
 */
// Exported ONLY for this file's own test (issue #191) — a direct assertion, against the REAL
// `retry` package proper-lockfile itself delegates to, that `randomize`/`maxTimeout` genuinely
// reach it (not re-exported from `index.ts`, so this stays off the `@sensigo/realm` public API).
export const LOCK_RETRIES = {
  retries: 10,
  minTimeout: 50,
  maxTimeout: 1000,
  randomize: true,
  maxRetryTime: 5000,
} as const;

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

/**
 * GLOBAL LOCK ORDER (issue #184): run-file lock BEFORE key lock, never the reverse.
 * `deleteAllForRun` is the only site that nests them (run-file lock held, key lock acquired
 * inside it, key lock released, then the run file is deleted and the run-file lock released).
 * Every other method that touches both takes them SEQUENTIALLY, never nested: `save()` releases
 * its run-file lock before `registerImportedKey()` acquires the key lock; `create()` only ever
 * takes the key lock (the run file it writes under that lock is a fresh path, not yet lockable
 * meaningfully — no run-file lock is held during `create()`). Violating this order (acquiring a
 * key lock and THEN a run-file lock while still holding the key lock) is the classic two-lock
 * deadlock shape and must never be introduced.
 */
export class JsonFileStore implements RunStore, PerRunArtifactStore {
  private readonly runsDir: string;

  /** This store round-trips the per-claim `claims` liveness clock (issue #101). */
  readonly persistsClaims = true;

  /**
   * Round-trips every `RunRecord` field it's given (issue #188) — `create`/`update` serialize the
   * whole record to JSON and `get` parses it back verbatim, so nothing is dropped field-by-field.
   * Declaring the full set keeps every field-fidelity gate dormant on the local default.
   */
  readonly persistedRunRecordFields: ReadonlySet<LoadBearingRunRecordField> = new Set([
    'capability_blocks',
    'workflow_context_snapshots',
    'extension_identity',
    'validation_rejections',
    'defaulted_steps',
  ]);

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

  /**
   * Read a pointer file. Absence (ENOENT) → undefined. A genuine I/O failure (permissions, a
   * torn mount, …) THROWS — issue #183: previously any error here, I/O or parse alike, silently
   * self-healed to "absent," which let a real read failure masquerade as a missing pointer. Parse
   * corruption (a torn/garbage pointer file) still self-heals to undefined — `create()` and
   * `reconcileKeys()` both depend on that recovery — but is no longer SILENT: a loud, structured
   * warning is emitted so an operator/log consumer can see the corruption happened.
   */
  private async readPointer(keyPath: string): Promise<KeyPointer | undefined> {
    const raw = await readIfExists(keyPath);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as KeyPointer;
    } catch (err) {
      console.warn(
        `⚠ realm: corrupt idempotency-key pointer at '${keyPath}' — treating as absent and ` +
          `self-healing (${err instanceof Error ? err.message : String(err)}).`,
      );
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
    await atomicWriteFile(keyPath, JSON.stringify(pointer, null, 2));
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
    await atomicWriteFile(this.filePath(record.id), JSON.stringify(record, null, 2));
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
      retries: LOCK_RETRIES,
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

  /** Shared STATE_RUN_NOT_FOUND — used both by the pre-check and the ENOENT-hardening catch (issue #107). */
  private runNotFoundError(runId: string): WorkflowError {
    return new WorkflowError(`Run not found: ${runId}`, {
      code: 'STATE_RUN_NOT_FOUND',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { runId },
    });
  }

  async get(runId: string): Promise<RunRecord> {
    const path = this.filePath(runId);
    // issue #183: readIfExists collapses the old existsSync-then-readFile TOCTOU pair into one
    // ENOENT-discriminating read — ENOENT (whether the file was never there, or a concurrent
    // purge removed it between calls) maps to the SAME STATE_RUN_NOT_FOUND; any OTHER errno
    // PROPAGATES rather than being mapped to STATE_RUN_NOT_FOUND — mapping a real I/O failure to
    // "not found" is exactly the already_purged false-attestation bug #183 exists to close.
    // #132's torn-read loudness is preserved throughout.
    const raw = await readIfExists(path);
    if (raw === undefined) throw this.runNotFoundError(runId);
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
      throw this.runNotFoundError(record.id);
    }

    // issue #107: defensive ENOENT mapping, symmetric with get()'s TOCTOU close — a concurrent
    // purge (terminal-only, so this only matters for an abandon-then-purge overlap) can remove
    // the file between the existsSync check above and the lock/read below.
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(path, { retries: LOCK_RETRIES });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw this.runNotFoundError(record.id);
      // issue #191 (Fix C): an exhausted lock acquisition is contention, not corruption — the SAME
      // classification deleteAllForRun already uses (see runBusyError's own doc). Retryable: the
      // other writer's lock is released eventually, or a genuinely stale lock is stolen by the
      // next contender.
      if ((err as NodeJS.ErrnoException).code === 'ELOCKED')
        throw this.runBusyError(record.id, 'locked');
      throw err;
    }
    try {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          throw this.runNotFoundError(record.id);
        throw err;
      }
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
      await atomicWriteFile(path, JSON.stringify(updated, null, 2));
      return updated;
    } finally {
      await release();
    }
  }

  // issue #184: the #107 comment that used to sit here ("no ENOENT-hardening needed — purge is
  // terminal-only") is now FALSE — a single-id `realm run purge <id> --force` has no age gate and
  // can race a claimStep (the resurrect-race class of bug this issue fixes generally), so the
  // post-lock read below is now ENOENT-hardened like update()'s already was.
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

    // issue #191 (Fix C): the lock acquisition itself now has its own try/catch (mirroring
    // update()'s shape) — an exhausted acquisition is contention, not a fatal stop.
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(path, { retries: LOCK_RETRIES });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ELOCKED')
        throw this.runBusyError(runId, 'locked');
      throw err;
    }
    try {
      // Re-read the freshest version under lock.
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw this.runNotFoundError(runId);
        throw err;
      }
      const run = JSON.parse(raw) as RunRecord;

      // Guard: step must not already be claimed.
      if (isStepSettledOrInFlight(run, stepName)) {
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

      // Per-claim liveness clock (issue #101): stamp claims[stepName] ATOMICALLY in the SAME
      // write that adds the step to in_progress_steps. There must be no second write — a torn
      // `S ∈ in_progress` with no claims[S] would silently re-create the permanent wedge.
      // OVERWRITE (not add-if-absent) so a missed settle-site delete self-heals on re-claim.
      const deadline = computeClaimDeadline(definition, stepName, new Date());
      const claimed: RunRecord = {
        ...run,
        in_progress_steps: [...run.in_progress_steps, stepName],
        claims: { ...run.claims, [stepName]: { deadline } },
        run_phase: deriveRunPhase(run),
        version: run.version + 1,
        updated_at: new Date().toISOString(),
      };
      await atomicWriteFile(path, JSON.stringify(claimed, null, 2));
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
  // issue #107: no ENOENT-hardening needed here — save() is create-if-absent (the existsSync
  // branch below is an optional divergence check, not a not-found guard), so it never depends on
  // the target already existing and can never race a purge unlinking it out from under this call.
  async save(record: RunRecord): Promise<void> {
    await this.ensureDir();
    const path = this.filePath(record.id);

    // #131: the read-check-write critical section now holds the same per-path lock
    // update()/claimStep() use, closing the one run-writer that previously raced unlocked.
    // realpath: false (like create()'s key lock) — save()'s whole point is create-if-absent,
    // so the target file legitimately may not exist yet; the default realpath resolution
    // would throw ENOENT locking a path with nothing there.
    // issue #191 (Fix C): same ELOCKED→runBusyError mapping as update()/claimStep() — an exhausted
    // acquisition here is contention on the read-check-write section, not a fatal stop.
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(path, {
        realpath: false,
        retries: LOCK_RETRIES,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ELOCKED')
        throw this.runBusyError(record.id, 'locked');
      throw err;
    }
    try {
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
      await atomicWriteFile(path, JSON.stringify(record, null, 2));
    } finally {
      await release();
    }
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
    const release = await lockfile.lock(keyPath, { realpath: false, retries: LOCK_RETRIES });
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
    // Torn-read-safe: every run file here is written atomically via atomicWriteFile (temp +
    // rename), so this unlocked read never sees a truncated file. Temps end in '.tmp' → excluded
    // by the '.json' filter. A raw non-atomic writeFile of a '.json' into runsDir would reintroduce
    // the torn read here.
    const jsonFiles: string[] = entries.filter((f: string) => f.endsWith('.json'));

    // issue #107: a concurrent purge can unlink a run file between the readdir above and the
    // per-file readFile below. Skip a vanished file rather than fail the whole list() — ENOENT
    // here means "no longer exists," not "corrupt" or "torn" (#132's torn-read loudness is
    // preserved: any OTHER error still rethrows and fails the call).
    const maybeRecords: Array<RunRecord | undefined> = await Promise.all(
      jsonFiles.map(async (file: string) => {
        let raw: string;
        try {
          raw = await readFile(join(this.runsDir, file), 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw err;
        }
        return JSON.parse(raw) as RunRecord;
      }),
    );
    const records: RunRecord[] = maybeRecords.filter((r): r is RunRecord => r !== undefined);

    if (workflowId !== undefined) {
      return records.filter((r: RunRecord) => r.workflow_id === workflowId);
    }
    return records;
  }

  /**
   * The raw set of run IDs present in `runsDir` (issue #163) — every `<id>.json` BASENAME, with
   * NO record parse. Deliberately NOT `list()`: `list()` parses each file as a `RunRecord`
   * (`JSON.parse(raw) as RunRecord`, uncaught) — a syntactically corrupt-but-PRESENT `<id>.json`
   * would throw there, whereas here it correctly still counts as a live run (the file exists on
   * disk; whatever reads it later is a separate concern from whether `realm run gc`'s orphan
   * sweep should treat this run's WAL/sidecar as run-less). Using `list()` for the orphan sweep's
   * `liveRunIds` would wrongly orphan — and reap — a live-but-corrupt run's artifacts.
   *
   * Concrete method, NOT on the `RunStore` interface (issue #163) — `gc` constructs a concrete
   * `JsonFileStore` directly (as it already does for `runsDirPath`), so no external `RunStore`
   * implementer is forced to add this.
   *
   * FAIL-CLOSED, load-bearing: `ENOENT` (no `runsDir` at all — nothing has ever been created) is
   * the ONLY tolerated case, yielding an empty set (no runs exist, so nothing is "wrongly" live or
   * orphaned). Any OTHER `readdir` error (permissions, a torn mount) THROWS — a fabricated empty
   * set here would make the orphan sweep believe NO runs exist, and reap every live run's
   * artifacts as "run-less." This is the single most dangerous failure mode in the whole feature;
   * see `orphan-sweepable-store.ts`'s own doc for the matching contract on the artifact-store side.
   */
  async listRunIds(): Promise<ReadonlySet<string>> {
    let entries: string[];
    try {
      entries = await readdir(this.runsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      throw err;
    }
    const ids = entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
    return new Set(ids);
  }

  /**
   * Builds the `STATE_RUN_BUSY` error thrown when `deleteAllForRun` cannot proceed because
   * another writer holds the run-file (or key) lock, or because the run is no longer terminal
   * (issue #184). Retryable: a live writer self-heals (the lock is released), and a genuinely
   * stale lock is eventually stolen by the next contender.
   */
  private runBusyError(runId: string, reason: 'locked' | 'no_longer_terminal'): WorkflowError {
    const message =
      reason === 'locked'
        ? `Run '${runId}' is locked by another writer`
        : `Run '${runId}' is no longer terminal — refusing to delete (it may have been resumed)`;
    return new WorkflowError(message, {
      code: 'STATE_RUN_BUSY',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: true,
      details: { runId, reason },
    });
  }

  /**
   * Deletes every artifact this store owns for `runId` (issue #107): the idempotency-key
   * pointer (conditionally) and the run file itself. Exact-path — ignores `dirEntries` (this
   * store never needs a directory listing to locate its own artifacts).
   *
   * Idempotent: if the run file is already gone (a concurrent purge, or a double-invocation),
   * this is a no-op, not an error.
   *
   * issue #184 — the resurrect-race fix: the WHOLE body runs under the run-file lock (matching
   * `update()`/`claimStep()`), and the run's terminal state is RE-VERIFIED under that lock, not
   * just at selection time. `RESUMABLE_PHASES ⊂ TERMINAL_PHASES` and `resume.ts` sets
   * `terminal_state: false`, and `atomicWriteFile` (a temp write + `rename`) recreates a
   * deleted target on `rename` — so, unlocked, a concurrent `realm resume` racing a batch purge
   * could resurrect the run file as a LIVE run with its WAL/sidecar/pointer already gone, while
   * purge still reported `purged`. Re-checking terminal state under the SAME lock `update()`
   * uses closes that window: `deleteAllForRun` now unconditionally refuses a non-terminal run.
   */
  async deleteAllForRun(runId: string, _dirEntries?: readonly string[]): Promise<void> {
    const path = this.filePath(runId);
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(path, {
        realpath: false,
        retries: LOCK_RETRIES,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ELOCKED') {
        throw this.runBusyError(runId, 'locked');
      }
      throw err;
    }

    try {
      let record: RunRecord;
      try {
        record = await this.get(runId);
      } catch (err) {
        if (err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND') return; // already gone
        // issue #183: any OTHER failure here means deleteAllForRun cannot even determine what to
        // delete (or confirm the run file itself is reachable) — wrap it into the SAME aggregate
        // shape the unlink failures below use, so a caller (e.g. purge) always observes ONE
        // consistent, typed failure contract regardless of which internal step actually failed.
        throw toArtifactDeleteFailedError(runId, 'JsonFileStore', [], path, err);
      }

      // issue #184 — the resurrect-race fix: re-verify terminal UNDER THE LOCK. A run selected as
      // terminal at purge-selection time may have been resumed since — `deleteAllForRun` must
      // refuse to delete a run that is (now) live, regardless of what the caller believed at
      // selection. This is a sound store-level invariant, not just a purge-specific patch:
      // `deleteAllForRun` never deletes a non-terminal run, full stop.
      if (!TERMINAL_PHASES.has(record.run_phase) || record.terminal_state !== true) {
        throw this.runBusyError(runId, 'no_longer_terminal');
      }

      const deleted: string[] = [];

      // Conditional pointer delete: only when this run actually owns an idempotency key. A
      // `rerun`/supersede may have repointed the key to a NEWER run since this run was minted —
      // deleting the pointer unconditionally would destroy the successor's LIVE pointer out from
      // under it. Only unlink when the pointer still points back at THIS run; reconcileKeys()
      // self-heals a dangling pointer regardless, so skipping a repointed one here is always safe.
      //
      // issue #184 — the pointer TOCTOU fix: the whole read→check→delete critical section is now
      // KEY-LOCKED (matching `create()`/`writePointer()`), nested INSIDE the run-file lock already
      // held above — see the GLOBAL LOCK ORDER invariant on the class docstring. Without this, a
      // concurrent supersede could repoint the key to a live successor between the read and the
      // unlink, and purge would delete a LIVE pointer out from under it.
      if (record.idempotency_key !== undefined) {
        const keyPath = this.keyPath(record.workflow_id, record.idempotency_key);
        let keyRelease: () => Promise<void>;
        try {
          keyRelease = await lockfile.lock(keyPath, { realpath: false, retries: LOCK_RETRIES });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ELOCKED') {
            throw this.runBusyError(runId, 'locked');
          }
          throw err;
        }
        try {
          let pointer: KeyPointer | undefined;
          try {
            pointer = await this.readPointer(keyPath);
          } catch (err) {
            throw toArtifactDeleteFailedError(runId, 'JsonFileStore', deleted, keyPath, err);
          }
          if (pointer !== undefined && pointer.run_id === runId) {
            try {
              const didDelete = await deleteIfExists(keyPath);
              if (didDelete) deleted.push(keyPath);
            } catch (err) {
              // Sequential stop-on-first-hard-error: a pointer we cannot delete means we STOP
              // here — do NOT proceed to the run-file delete below. Leaving the run file in place
              // on a partial failure is the safe outcome (issue #107's crash-anchor invariant):
              // the run is re-enumerated and the whole purge retried on the next pass.
              throw toArtifactDeleteFailedError(runId, 'JsonFileStore', deleted, keyPath, err);
            }
          }
        } finally {
          await keyRelease();
        }
      }

      // The run file LAST — it is the crash re-enumeration anchor: a crash mid-purge leaves this
      // file in place, so the run is found again on the next purge/list pass and retried
      // idempotently (the pointer, if any, is already gone by then).
      try {
        const didDelete = await deleteIfExists(path);
        if (didDelete) deleted.push(path);
      } catch (err) {
        throw toArtifactDeleteFailedError(runId, 'JsonFileStore', deleted, path, err);
      }
    } finally {
      await release();
    }
  }
}
