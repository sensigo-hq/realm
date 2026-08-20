// gc command — sweep orphaned atomic-write temps (issue #160), run-less orphaned WAL/sidecar
// artifacts (issue #163), AND (--heal, opt-in) grandfathered stale run_phase records (issue #293).
// One operator command, three independent, composable passes.
//
// --- Sweep 1: atomic-write temps (issue #160, Phase 1: .tmp only) ---
// atomicWriteFile (packages/core/src/store/atomic-write.ts) writes a unique sibling temp
// (`${path}.<pid>.<counter>.tmp`) then POSIX-renames it over the target. A process dying between
// the write and the rename orphans that temp forever — it is not runId-keyed for the key-pointer
// case (`keys/<hash>.json.<pid>.*.tmp`), so `realm run purge` (#107), which acts by runId, can
// never reach it. Temps are invisible to `list()` (no `.json` suffix) but accumulate on disk
// regardless. Windows never produces a temp at all (`atomicWriteFile` falls back to plain
// `writeFile` on win32) — this sweep is a documented no-op there, not a design driver.
//
// Reaping a `.tmp` is unconditionally safe: if the sweep unlinks a temp mid-rename, the pending
// `rename` gets ENOENT, `atomicWriteFile`'s own catch best-effort-unlinks its temp + rethrows — the
// TARGET file is never touched (worst case: a spurious write error surfaces to the writer, never a
// torn file). Combined with the 1h floor below, an in-flight write's temp (age ≪ floor) is never
// even selected.
//
// --- Sweep 2: run-less orphaned WAL/sidecar artifacts (issue #163) ---
// #163 was ORIGINALLY filed on a premise that does not hold: it claimed a WAL could orphan
// "between WAL-create and run-file-create." That path does not exist — `append_trace` calls
// `runStore.get(runId)` FIRST, so a WAL's `<runId>.json` provably existed at WAL-creation time and
// exists for the run's ENTIRE life. "Artifact present, run file absent" is therefore only true
// AFTER the run file has been deleted (a pre-#183 purge, a manual `rm`, disk corruption) or DURING
// the sub-second atomic-write temp-rename window (the run file is a `<id>.json.<pid>.tmp`, not yet
// renamed). This is remediation for the rare/residual case, not a rescue for an ongoing leak — the
// git history shows the pre-#183/#184 orphan-manufacturing window was ~48h and opt-in.
//
// `.lock` reaping is deliberately split to #164 (deferred — proper-lockfile self-heals a live-path
// lock; only a purged-target's lock lingers, which is negligible). Neither is this command's job
// yet — see the report footer.
//
// --- Pass 3: grandfathered stale-phase heal (issue #293, opt-in via --heal) ---
// `run_phase` is a DERIVED, render-only field (issue #279 increment 2, PR-C's disposal rule) —
// every store write (`update()`, `save()`) re-derives it from the record's own authoritative
// fields and persists the FRESH value as a side effect, discarding whatever the caller passed.
// The #282 fix (a reordering of `deriveRunPhase` itself) corrected what a NEW write derives, but
// never touched records that were written by an OLDER binary and have sat untouched since — their
// on-disk `run_phase` can still disagree with what `deriveRunPhase` would compute for them today.
// Correctness never depended on this: every live read path derives fresh (`get_run_state`, `list
// --status`, the engine's own eligibility checks) — a stale PERSISTED value is cosmetic residue,
// visible only to someone reading the raw JSON file directly. `--heal` is a one-shot population
// shrink, not a correctness fix: for each mismatched record, it writes the record back UNMODIFIED
// through `RunStore.update()` — the store's own write tail heals `run_phase` (plus `version` and
// `updated_at`, its other two side effects) as an ordinary consequence of a normal write, exactly
// as it would if any other legitimate writer touched that record next. Canon: kube's
// storage-version-migrator does the identical read-then-write-back-unmodified trick to migrate
// encryption-at-rest/API versions across a whole etcd population with zero bespoke migration code.
import { readdir, lstat, unlink, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Command } from 'commander';
import { WorkflowError, deleteIfExists } from '@sensigo/realm';
import type {
  OrphanSweepableStore,
  OrphanArtifact,
  RunStore,
  RunRecord,
  RunPhase,
} from '@sensigo/realm';
import { parseDuration } from '../lib/parse-duration.js';

/**
 * Minimum `--older-than` EITHER sweep will ever honor (1 hour) — a conservative floor for hygiene
 * of non-urgent crash residue, and, forward-consistency-wise, the safety guard the deferred
 * `.lock` reaping (#164) will also require; enforcing it here means #164 inherits an
 * already-tested guard. Temps themselves are safe to reap at any age past a few seconds (see the
 * module doc above); a run-less WAL/sidecar past this floor is genuinely orphaned, not merely
 * in-flight (see `sweepOrphanArtifacts`'s own doc for why the floor is exactly the create-window
 * guard there) — either way this floor is conservatism, not the per-sweep safety mechanism.
 * Module-private: the only way to reach a delete in EITHER sweep is through `assertOlderThanFloor`,
 * checked FIRST, before any filesystem access.
 */
const FLOOR_MS = 3_600_000;

/** Shared floor guard for both sweeps — checked before any filesystem access in either. */
function assertOlderThanFloor(olderThanMs: number, subject: string): void {
  if (olderThanMs < FLOOR_MS) {
    throw new WorkflowError(
      `--older-than must resolve to at least 1h (got ${olderThanMs}ms) — gc refuses to reap ` +
        `${subject} younger than that, even with --force.`,
      {
        code: 'VALIDATION_INPUT_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'provide_input',
        retryable: false,
        details: { olderThanMs, floorMs: FLOOR_MS },
      },
    );
  }
}

export interface SweepOrphansOptions {
  /** Minimum age (ms) a `.tmp` must have to be reaped. Rejected below `FLOOR_MS` — see above. */
  olderThanMs: number;
  /** true (default caller behavior): report only, never unlink. */
  dryRun: boolean;
  /** Injected clock for deterministic age math in tests; defaults to `new Date()`. */
  now?: Date;
}

export interface SweepOrphansResult {
  /** Reaped (force mode) or would-be-reaped (dry-run) `.tmp` paths. */
  reaped: string[];
  /** A candidate vanished on its own (lstat or unlink hit ENOENT) — benign, never a failure. */
  already_gone: string[];
  /** A candidate lstat'd to something other than ENOENT/regular-file/symlink (e.g. a directory
   *  unexpectedly named `*.tmp`), or a genuine unlink error (permissions, I/O). Loud on purpose —
   *  a type mismatch is never silently swallowed, in either dry-run or force mode. */
  failed: Array<{ path: string; error: string }>;
}

/**
 * Every top-level `*.tmp` in `runsDir`, plus one level of recursion into `runsDir/keys/*.tmp` —
 * `keys/` is the ONLY subdirectory any store ever creates in `runsDir` (verified: `JsonFileStore`'s
 * `keysDir()`/`mkdir` calls are the only subdirectory creation anywhere in this codebase's
 * `runsDir` usage). A plain `readdir(runsDir)` sees the `keys` entry itself (no `.json`/`.tmp`
 * suffix, so it's filtered out) but NOT what's inside it — hence the explicit second `readdir`.
 * Nothing else is recursed into; nothing else is globbed (no `*.lock` — that's #164).
 * Tolerates a missing `runsDir` or a missing `keys/` (a fresh install, or one that never wrote a
 * keyed run, legitimately lacks either) — a missing directory yields zero candidates, not a throw.
 */
async function findTempCandidates(runsDir: string): Promise<string[]> {
  const topLevel = await readdir(runsDir).catch(() => [] as string[]);
  const paths = topLevel.filter((f) => f.endsWith('.tmp')).map((f) => join(runsDir, f));

  const keysDir = join(runsDir, 'keys');
  const keysEntries = await readdir(keysDir).catch(() => [] as string[]);
  paths.push(...keysEntries.filter((f) => f.endsWith('.tmp')).map((f) => join(keysDir, f)));

  return paths;
}

/**
 * Reaps orphaned atomic-write `.tmp` files older than `options.olderThanMs`. `FLOOR_MS` is
 * checked FIRST, before any filesystem access, so no caller — CLI action, test, or future
 * consumer — can reach a delete without crossing it.
 *
 * Per-candidate rule (uses `lstat`, never `readdir({ withFileTypes: true })` — on WSL/9p
 * `Dirent.d_type` can be `DT_UNKNOWN`, which would make every type check false and the sweep
 * reap nothing):
 *  - `lstat` ENOENT (vanished before we could even examine it, or during the later `unlink`) →
 *    `already_gone`, in either mode — a benign race, never a failure.
 *  - a **symlink** → skipped silently (appears in no bucket). Never `unlink`ed, never followed.
 *  - anything else that is **not a regular file** (a directory unexpectedly named `*.tmp`, a
 *    socket, …) → `failed`, loud, in either mode — a type mismatch is never an ENOENT-style
 *    silent swallow, because it signals something anomalous in `runsDir` worth surfacing even
 *    from a dry-run.
 *  - a **future mtime** (negative age — clock skew) → skipped silently, never reaped.
 *  - a regular file younger than `olderThanMs` → skipped silently (almost certainly an in-flight
 *    write's temp).
 *  - a regular file older than `olderThanMs` → a reap candidate: in dry-run, its path lands in
 *    `reaped` (interpreted as "would reap") without any filesystem mutation; in force mode, it is
 *    `unlink`ed — success → `reaped`; ENOENT → `already_gone`; anything else → `failed`.
 */
export async function sweepOrphans(
  runsDir: string,
  options: SweepOrphansOptions,
): Promise<SweepOrphansResult> {
  assertOlderThanFloor(options.olderThanMs, 'crash residue');

  const now = options.now ?? new Date();
  const candidatePaths = await findTempCandidates(runsDir);

  const result: SweepOrphansResult = { reaped: [], already_gone: [], failed: [] };
  const toReap: string[] = [];

  for (const path of candidatePaths) {
    let info;
    try {
      info = await lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        result.already_gone.push(path); // vanished between readdir and lstat
      } else {
        result.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }

    if (info.isSymbolicLink()) continue; // never unlink or follow a symlink — silent skip

    if (!info.isFile()) {
      result.failed.push({
        path,
        error: 'expected a regular file but found a different type (unexpected for a *.tmp name)',
      });
      continue;
    }

    const ageMs = now.getTime() - info.mtime.getTime();
    if (ageMs < 0) continue; // future mtime (clock skew) — skip, never reap
    if (ageMs <= options.olderThanMs) continue; // too fresh — most likely an in-flight write's temp

    toReap.push(path);
  }

  if (options.dryRun) {
    result.reaped = toReap;
    return result;
  }

  for (const path of toReap) {
    try {
      await unlink(path);
      result.reaped.push(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        result.already_gone.push(path); // vanished between lstat and unlink
      } else {
        result.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return result;
}

/** One orphan artifact's outcome in a sweep report — carries the runId alongside the path so an
 *  operator can correlate a reaped file back to which run it belonged to. */
export interface OrphanArtifactEntry {
  path: string;
  runId: string;
}

export interface OrphanArtifactSweepResult {
  /** Reaped (force mode) or would-be-reaped (dry-run) artifacts. */
  reaped: OrphanArtifactEntry[];
  /** A candidate vanished on its own (unlink hit ENOENT) — benign, never a failure. */
  already_gone: OrphanArtifactEntry[];
  /** A genuine delete failure (permissions, I/O) — loud, never silently swallowed. */
  failed: Array<{ path: string; runId: string; error: string }>;
  /**
   * A fenced candidate's guard refused because the run EXISTS AGAIN at destruction time — a
   * `JsonFileStore.save()` re-import landing between this sweep's snapshot and the reap (issue
   * #207 PR-2, D3 §5: the resurrect race gc's absent-guard closes, symmetric with purge's
   * terminal-re-verify). Benign: these files are no longer orphans by definition, so this is
   * NEVER an `artifactSweepError` and never affects `gcExitCode`. Only ever populated for a
   * store that declares the fenced trio AND was reaped with a `runStore` reference — the legacy
   * (non-declaring-store or no-runStore) fallback path can't detect this race at all and simply
   * leaves such a file for the next sweep to re-evaluate.
   */
  resurrected: OrphanArtifactEntry[];
}

/**
 * Reaps run-less orphaned WAL/sidecar artifacts (issue #163) — the second sweep behind
 * `realm run gc`. `stores` is every `OrphanSweepableStore` gc knows about (today:
 * `JsonTraceBufferStore`, `FailedAttemptStore`); `liveRunIds` is the caller's ALREADY-COMPUTED
 * `JsonFileStore.listRunIds()` result (computed once, shared across every store, and — this is
 * load-bearing — the caller's responsibility to have fail-closed on: see the CLI action for why
 * this function never calls `listRunIds()` itself).
 *
 * **The floor is the create-temp-window guard.** `append_trace` calls `runStore.get(runId)`
 * BEFORE ever writing a WAL entry, so a WAL's `<runId>.json` provably existed at WAL-creation
 * time and exists for the run's entire life (see this module's own header for the full
 * correctness backbone). The ONLY way "artifact present, run file absent" can be true for a
 * FRESH run is the sub-second window between the run file being written as a temp
 * (`<id>.json.<pid>.tmp`) and its atomic rename to `<id>.json` — during which `listRunIds()`
 * would not yet see it. `FLOOR_MS` (1h) dwarfs that window by many orders of magnitude, so a
 * fresh in-flight run's WAL is always younger than the floor and never selected; a WAL/sidecar
 * OLDER than the floor with no matching run file is genuinely run-less.
 *
 * Each `OrphanSweepableStore.listOrphans()` call is fail-closed BY THE STORE'S OWN CONTRACT (see
 * `orphan-sweepable-store.ts`) — a non-ENOENT enumeration/stat failure throws, propagating out of
 * THIS function too (uncaught here, deliberately): this sweep has nothing safe to report if it
 * cannot trust what "orphaned" even means for that store, so it aborts entirely rather than
 * reaping a partial, possibly-wrong candidate set.
 *
 * `runStore` (issue #207 PR-2, D3 §5): when supplied AND a given store declares
 * `deleteAllForRunFenced`, force-mode reaping for that store routes through the fenced path —
 * floor-passing candidates are grouped by `runId`, and one `deleteAllForRunFenced(runId, guard,
 * dirEntries)` call is made per group, `dirEntries` scoped to EXACTLY that group's floor-passing
 * basenames (never the whole directory). The guard is a lock-free `runStore.get(runId)`: absence
 * (`STATE_RUN_NOT_FOUND`) means proceed; the run EXISTING again means a `JsonFileStore.save()`
 * re-import raced this sweep (the resurrect race this closes, symmetric with purge's own
 * terminal-re-verify) — the guard refuses, and that runId's files land in `resurrected`, never
 * `failed` (benign, exit-code-neutral). A store that does NOT declare the fenced trio, or a call
 * that omits `runStore`, keeps the original per-file `deleteIfExists` path unchanged — this is
 * also why the per-file `already_gone` granularity is preserved for that path only: an aggregate
 * `deleteAllForRunFenced` call reports its whole runId-group as `reaped` on success (the store's
 * own absence-is-success contract already covers "some files in the group were already gone").
 */
export async function sweepOrphanArtifacts(
  stores: readonly OrphanSweepableStore[],
  liveRunIds: ReadonlySet<string>,
  options: SweepOrphansOptions,
  runStore?: Pick<RunStore, 'get'>,
): Promise<OrphanArtifactSweepResult> {
  assertOlderThanFloor(options.olderThanMs, 'orphaned artifacts');

  const now = options.now ?? new Date();

  // Per-store candidate lists (issue #207 PR-2) — kept associated with their originating store so
  // the reap dispatch below can pick the fenced or legacy path per store, not globally.
  const perStore: Array<{ store: OrphanSweepableStore; artifacts: OrphanArtifact[] }> = [];
  for (const store of stores) {
    perStore.push({ store, artifacts: await store.listOrphans(liveRunIds) });
  }

  const passesFloor = (artifact: OrphanArtifact): boolean => {
    const ageMs = now.getTime() - artifact.mtimeMs;
    if (ageMs < 0) return false; // future mtime (clock skew) — skip, never reap
    return ageMs > options.olderThanMs; // too fresh — the create-temp-window guard above
  };

  const result: OrphanArtifactSweepResult = {
    reaped: [],
    already_gone: [],
    failed: [],
    resurrected: [],
  };

  const toReapByStore = perStore
    .map(({ store, artifacts }) => ({ store, artifacts: artifacts.filter(passesFloor) }))
    .filter(({ artifacts }) => artifacts.length > 0);

  if (options.dryRun) {
    result.reaped = toReapByStore.flatMap(({ artifacts }) =>
      artifacts.map((a) => ({ path: a.path, runId: a.runId })),
    );
    return result;
  }

  for (const { store, artifacts } of toReapByStore) {
    if (runStore !== undefined && hasDeleteAllForRunFenced(store)) {
      const byRunId = new Map<string, OrphanArtifact[]>();
      for (const artifact of artifacts) {
        const group = byRunId.get(artifact.runId) ?? [];
        group.push(artifact);
        byRunId.set(artifact.runId, group);
      }
      for (const [runId, group] of byRunId) {
        const dirEntries = group.map((a) => basename(a.path));
        const guard = buildGcResurrectGuard(runStore, runId);
        try {
          await store.deleteAllForRunFenced(runId, guard, dirEntries);
          for (const a of group) result.reaped.push({ path: a.path, runId: a.runId });
        } catch (err) {
          if (err instanceof WorkflowError && err.code === 'STATE_RUN_RESURRECTED') {
            for (const a of group) result.resurrected.push({ path: a.path, runId: a.runId });
          } else {
            for (const a of group) {
              result.failed.push({
                path: a.path,
                runId: a.runId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }
      continue;
    }

    // Non-declaring store (or no runStore supplied) — today's per-file deleteIfExists path,
    // unchanged.
    for (const artifact of artifacts) {
      const entry = { path: artifact.path, runId: artifact.runId };
      try {
        // #183 discipline: deleteIfExists resolves false (not an error) on ENOENT — already gone
        // is success, never a failure; any other errno throws.
        const didDelete = await deleteIfExists(artifact.path);
        if (didDelete) {
          result.reaped.push(entry);
        } else {
          result.already_gone.push(entry);
        }
      } catch (err) {
        result.failed.push({ ...entry, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return result;
}

/** The subset of the fenced trio gc actually calls (issue #207 PR-2) — a store-shape check, not
 *  an import from `@sensigo/realm`'s `TraceBufferStore`, since `OrphanSweepableStore` only
 *  guarantees `listOrphans`; a concrete store (e.g. `JsonTraceBufferStore`) may additionally
 *  implement this. */
interface DeleteAllForRunFencedCapable {
  deleteAllForRunFenced(
    runId: string,
    guard: () => Promise<void>,
    dirEntries?: readonly string[],
  ): Promise<void>;
}

function hasDeleteAllForRunFenced(
  store: OrphanSweepableStore,
): store is OrphanSweepableStore & DeleteAllForRunFencedCapable {
  return (
    typeof (store as Partial<DeleteAllForRunFencedCapable>).deleteAllForRunFenced === 'function'
  );
}

/**
 * The resurrect-race guard (issue #207 PR-2, D3 §5): a lock-free `runStore.get(runId)`,
 * re-verified inside the artifact store's own critical section immediately before its delete.
 * Proceeds (resolves) iff the run is still absent (`STATE_RUN_NOT_FOUND`); throws a typed,
 * locally-recognized `STATE_RUN_RESURRECTED` refusal if the run EXISTS again (a `save()`
 * re-import landed between this sweep's snapshot and the reap) — the sweep's own catch (above)
 * routes that specific code to the `resurrected` bucket, never `failed`. Any OTHER read failure
 * propagates unwrapped, landing in `failed` (fail-closed — same posture `listOrphans` itself
 * already requires).
 */
function buildGcResurrectGuard(
  runStore: Pick<RunStore, 'get'>,
  runId: string,
): () => Promise<void> {
  return async () => {
    try {
      await runStore.get(runId);
    } catch (err) {
      if (err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND') {
        return; // still absent — proceed
      }
      throw err;
    }
    throw new WorkflowError(`Run '${runId}' exists again — no longer an orphan`, {
      code: 'STATE_RUN_RESURRECTED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { runId },
    });
  };
}

// ---------------------------------------------------------------------------
// Pass 3: stale-phase heal (issue #293)
// ---------------------------------------------------------------------------

export interface SweepStalePhasesOptions {
  /** false (default caller behavior): report mismatches only, never write. */
  force: boolean;
  /**
   * Injected, never imported directly by this module (gc.ts's own top-level `@sensigo/realm`
   * VALUE import must not widen — see the module header). The caller destructures this from its
   * existing dynamic `await import('@sensigo/realm')`.
   */
  deriveRunPhase: (
    run: Pick<
      RunRecord,
      | 'pending_gate'
      | 'terminal_state'
      | 'failed_steps'
      | 'terminal_reason'
      | 'aborted_at'
      | 'abandoned_at'
      // issue #367: widened to match deriveRunPhase's own Pick — runtime unchanged (the real
      // records passed here already carry the field when stamped).
      | 'sealed_by'
    >,
  ) => RunPhase;
}

/** One mismatched record's before/after phase — carried through every bucket below so a report
 *  (dry-run or force) can always say WHAT was wrong, not just WHICH id. */
export interface StalePhaseEntry {
  id: string;
  persisted_phase: RunPhase;
  derived_phase: RunPhase;
}

export interface SweepStalePhasesResult {
  /** force mode: rewritten via `store.update()` — persisted now matches derived. */
  healed: StalePhaseEntry[];
  /** dry-run mode: mismatches found, nothing written. */
  would_heal: StalePhaseEntry[];
  /**
   * force mode only: a concurrent writer touched this record between our `list()` snapshot and
   * our `update()` call (`STATE_SNAPSHOT_MISMATCH`, a genuine version conflict) or the record was
   * lock-contended at write time (`STATE_RUN_BUSY`, ELOCKED). Either way the live writer's own
   * write ALSO heals `run_phase` as the same side effect this sweep would have produced — retrying
   * here is pointless, so this is a skip-and-count bucket, never a crash and never `failed`.
   */
  skipped_conflict: StalePhaseEntry[];
  /** A genuine write failure (permissions, I/O, an unrecognized store error) — loud, never
   *  silently swallowed, in either mode. */
  failed: Array<{ id: string; error: string }>;
}

/**
 * For every run record whose persisted `run_phase` disagrees with `deriveRunPhase(record)`,
 * writes the record back UNMODIFIED through `store.update()` — the store's own versioned write
 * tail heals the phase (plus `version`/`updated_at`) as its ordinary side effect; this function
 * never constructs or mutates a single field itself (the store-literal forensics stance: the only
 * thing that ever changes a persisted record is the store's own write path, never a bespoke gc
 * rewrite). Records already matching are never even passed to `update()` — untouched, byte-for-
 * byte, verified in tests.
 *
 * `store.list()`'s fail-closed contract (issue #132/#183: `JSON.parse` uncaught on a corrupt
 * file) is INHERITED here deliberately, uncaught — a single unparseable run file aborts the
 * WHOLE heal pass rather than silently healing a partial, possibly-wrong population. No
 * per-file try/catch salvage: see the module's own report footer / CHANGELOG for why this is
 * accepted, not worked around.
 *
 * No age gate (unlike the other two sweeps): healing is a no-op rewrite of a record already on
 * disk, safe at any age — there is no in-flight-write window to guard against the way there is
 * for a `.tmp` or a fresh WAL.
 */
export async function sweepStalePhases(
  store: Pick<RunStore, 'list' | 'update'>,
  options: SweepStalePhasesOptions,
): Promise<SweepStalePhasesResult> {
  const records = await store.list();

  const result: SweepStalePhasesResult = {
    healed: [],
    would_heal: [],
    skipped_conflict: [],
    failed: [],
  };

  for (const record of records) {
    const derivedPhase = options.deriveRunPhase(record);
    if (record.run_phase === derivedPhase) continue; // matching — never touched, not even read-only.

    const entry: StalePhaseEntry = {
      id: record.id,
      persisted_phase: record.run_phase,
      derived_phase: derivedPhase,
    };

    if (!options.force) {
      result.would_heal.push(entry);
      continue;
    }

    try {
      await store.update(record); // UNMODIFIED — the write tail is the entire mechanism.
      result.healed.push(entry);
    } catch (err) {
      if (
        err instanceof WorkflowError &&
        (err.code === 'STATE_SNAPSHOT_MISMATCH' || err.code === 'STATE_RUN_BUSY')
      ) {
        result.skipped_conflict.push(entry);
      } else {
        result.failed.push({
          id: record.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

/** Best-effort total bytes for a known list of paths — reporting-only, never gates reaping.
 *  Called against a fresh dry-run preview, so the paths are still on disk when stat'd. */
async function statPathBytes(paths: readonly string[]): Promise<number> {
  let total = 0;
  await Promise.all(
    paths.map(async (p) => {
      try {
        const info = await stat(p);
        total += info.size;
      } catch {
        // vanished between the preview pass and this stat — best-effort, ignore.
      }
    }),
  );
  return total;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** So an operator doesn't distrust the tool when `runsDir` still holds residue gc deliberately
 *  does not touch — printed on every report, dry-run or force, empty or not. issue #163: WALs and
 *  failed-attempt sidecars are now reaped (the second sweep above) — only `.lock` dirs remain
 *  deferred (issue #164). */
const NOT_REAPED_FOOTER =
  'gc does NOT yet reap orphaned .lock dirs (deferred — issue #164). Their presence in runsDir ' +
  'is expected and not a sign gc is broken.';

/** Prints the dry-run / force report shared by both code paths. `previewBytes` always comes from
 *  the initial (always non-destructive) preview pass — see the action below for why.
 *
 * `artifactResult`/`artifactSweepError` are mutually exclusive (issue #163): a defined
 * `artifactSweepError` means `listRunIds()` or a store's `listOrphans()` threw — the orphan
 * sweep aborted loudly, reaping NOTHING, and there is no `artifactResult` to report. Both may be
 * `undefined` only if the temp-only sweep somehow bypassed the orphan sweep entirely (never
 * happens in the real CLI action — always one or the other).
 */
function printGcReport(
  result: SweepOrphansResult | undefined,
  previewBytes: number,
  dryRun: boolean,
  artifactResult: OrphanArtifactSweepResult | undefined,
  artifactSweepError: string | undefined,
  healResult: SweepStalePhasesResult | undefined,
  healSweepError: string | undefined,
): void {
  // --- temp-file section (issue #160) — only when the --older-than pass actually ran; a
  // --heal-only invocation never touches this section at all (never even "nothing found"). ---
  if (result !== undefined) {
    const nothingToReport =
      result.reaped.length === 0 && result.already_gone.length === 0 && result.failed.length === 0;

    if (nothingToReport) {
      console.log('No orphaned .tmp files found to reap.');
    } else if (dryRun) {
      console.log(
        `${result.reaped.length} orphaned .tmp file(s) WOULD be reaped (${formatBytes(previewBytes)} to free):`,
      );
      for (const p of result.reaped) console.log(`  • ${p}`);
      if (result.already_gone.length > 0) {
        console.log(`(${result.already_gone.length} candidate(s) already vanished on their own.)`);
      }
    } else {
      console.log(
        `Reaped ${result.reaped.length} orphaned .tmp file(s) (${formatBytes(previewBytes)} freed). ` +
          `${result.already_gone.length} already gone, ${result.failed.length} failed.`,
      );
    }

    for (const f of result.failed) {
      console.error(`  ✗ ${f.path}: ${f.error}`);
    }
    if (dryRun && !nothingToReport) {
      console.log('\nRe-run with --force to actually delete.');
    }
  }

  // --- orphan-artifacts section (issue #163) ---
  if (artifactSweepError !== undefined) {
    console.error(
      `\n✗ orphan-artifact sweep ABORTED (reaped nothing from it): ${artifactSweepError}`,
    );
  } else if (artifactResult !== undefined) {
    const nothingToReportArtifacts =
      artifactResult.reaped.length === 0 &&
      artifactResult.already_gone.length === 0 &&
      artifactResult.failed.length === 0 &&
      artifactResult.resurrected.length === 0;

    if (nothingToReportArtifacts) {
      console.log('\nNo run-less orphaned WAL/sidecar artifacts found to reap.');
    } else if (dryRun) {
      console.log(
        `\n${artifactResult.reaped.length} run-less orphaned artifact(s) WOULD be reaped:`,
      );
      for (const a of artifactResult.reaped) console.log(`  • ${a.path}  (run ${a.runId})`);
      if (artifactResult.already_gone.length > 0) {
        console.log(
          `(${artifactResult.already_gone.length} candidate(s) already vanished on their own.)`,
        );
      }
    } else {
      console.log(
        `\nReaped ${artifactResult.reaped.length} run-less orphaned artifact(s). ` +
          `${artifactResult.already_gone.length} already gone, ${artifactResult.failed.length} failed.`,
      );
      for (const a of artifactResult.reaped) console.log(`  • ${a.path}  (run ${a.runId})`);
    }
    // issue #207 PR-2: benign, exit-code-neutral — these files are no longer orphans (the run
    // exists again), reported for operator visibility only, never as a failure.
    if (artifactResult.resurrected.length > 0) {
      console.log(
        `(${artifactResult.resurrected.length} candidate(s) skipped — their run exists again, no longer orphaned.)`,
      );
      for (const a of artifactResult.resurrected) {
        console.log(`  • ${a.path}  (run ${a.runId}, resurrected)`);
      }
    }
    for (const f of artifactResult.failed) {
      console.error(`  ✗ ${f.path} (run ${f.runId}): ${f.error}`);
    }
    if (dryRun && !nothingToReportArtifacts) {
      console.log('Re-run with --force to actually delete.');
    }
  }

  // --- stale-phase heal section (issue #293) — only when --heal was requested. ---
  if (healSweepError !== undefined) {
    console.error(`\n✗ stale-phase heal sweep ABORTED (healed nothing from it): ${healSweepError}`);
  } else if (healResult !== undefined) {
    const nothingToReportHeal =
      healResult.healed.length === 0 &&
      healResult.would_heal.length === 0 &&
      healResult.skipped_conflict.length === 0 &&
      healResult.failed.length === 0;

    // issue #367: the retention-clock note belongs on EVERY heal branch, and most of all on the
    // ones that actually rewrite records. It first shipped inside the nothing-to-heal branch —
    // i.e. printed only when nothing was at stake, and silent in the --force branch that
    // measurably resets updated_at on every healed record.
    const printRetentionClockNote = (): void => {
      console.log(
        '\nNote (issue #367): after upgrading across the seal substrate, a first heal rewrites every\n' +
          'legacy record whose derived phase moved — and each rewrite resets updated_at, the clock\n' +
          'retention reads. Run `realm run migrate --stamp-seals` FIRST if those clocks matter: it\n' +
          'materialises the same phases and preserves updated_at.',
      );
    };

    if (nothingToReportHeal) {
      console.log('\nNo stale-phase records found to heal.');
      printRetentionClockNote();
    } else if (dryRun) {
      console.log(`\n${healResult.would_heal.length} stale-phase record(s) WOULD be healed:`);
      for (const e of healResult.would_heal) {
        console.log(`  • ${e.id}: persisted '${e.persisted_phase}' → derived '${e.derived_phase}'`);
      }
      printRetentionClockNote();
    } else {
      console.log(
        `\nHealed ${healResult.healed.length} stale-phase record(s). ` +
          `${healResult.skipped_conflict.length} skipped (concurrent writer), ${healResult.failed.length} failed.`,
      );
      for (const e of healResult.healed) {
        console.log(`  • ${e.id}: persisted '${e.persisted_phase}' → derived '${e.derived_phase}'`);
      }
      printRetentionClockNote();
    }
    // Benign, exit-code-neutral, never `failed` (mirrors the orphan-artifact sweep's own
    // `resurrected` bucket precedent above). The wording covers BOTH legs honestly: a
    // SNAPSHOT_MISMATCH skip means someone else's write already moved the record (and healed the
    // phase with it), while a RUN_BUSY skip means a lock is HELD and nothing was written — the
    // record is still stale, and it heals on that writer's own next write, not on this one.
    if (healResult.skipped_conflict.length > 0) {
      console.log(
        `(${healResult.skipped_conflict.length} record(s) skipped — a concurrent writer holds or ` +
          `just moved them; their own next write heals them.)`,
      );
      for (const e of healResult.skipped_conflict) {
        console.log(`  • ${e.id}  (skipped — concurrent write)`);
      }
    }
    for (const f of healResult.failed) {
      console.error(`  ✗ ${f.id}: ${f.error}`);
    }
    if (dryRun && !nothingToReportHeal) {
      console.log('Re-run with --force to actually heal.');
    }
  }

  console.log(`\n${NOT_REAPED_FOOTER}`);
}

/** gc's exit code: non-zero iff gc could not complete a sweep it attempted (issue #163
 *  exit-code correction; extended, issue #293, for the opt-in heal pass). A failed unlink/write in
 *  ANY attempted pass, OR an aborted orphan/heal sweep (enumeration/`list()` failed —
 *  `artifactSweepError`/`healSweepError` set), is a failure. Merely *finding* reapable or
 *  healable residue is NOT — that holds in both dry-run and `--force`, so this one helper decides
 *  every branch's exit code instead of each re-deriving its own (inline) predicate. A pass that
 *  never ran (its result param is `undefined`, its error param is `undefined`) contributes no
 *  failure — exactly the same "absence is not a failure" reading `artifactResult: undefined`
 *  already relies on. */
export function gcExitCode(
  tempResult: SweepOrphansResult | undefined,
  artifactResult: OrphanArtifactSweepResult | undefined,
  artifactSweepError: string | undefined,
  healResult?: SweepStalePhasesResult,
  healSweepError?: string,
): number {
  const anyFailure =
    (tempResult?.failed.length ?? 0) > 0 ||
    (artifactResult?.failed.length ?? 0) > 0 ||
    artifactSweepError !== undefined ||
    (healResult?.failed.length ?? 0) > 0 ||
    healSweepError !== undefined;
  return anyFailure ? 1 : 0;
}

export const gcCommand = new Command('gc')
  .description(
    'Sweep orphaned atomic-write .tmp files, run-less orphaned WAL/sidecar artifacts, and ' +
      '(--heal) grandfathered stale-phase records (dry-run by default)',
  )
  .option(
    '--older-than <duration>',
    'Reap residue idle at least this long (minimum 1h; e.g. 1h, 6h, 30d) — required unless ' +
      '--heal is the only pass requested',
  )
  .option('--force', 'Actually delete/rewrite (without this, gc only reports what WOULD change)')
  .option(
    '--heal',
    'One-shot pass (issue #293): rewrite records whose persisted run_phase disagrees with the ' +
      'derived phase — safe at any age, no --older-than floor applies to this pass',
  )
  .action(async (opts: { olderThan?: string; force?: boolean; heal?: boolean }) => {
    // [issue #293] --older-than demoted from a Commander requiredOption to a plain option so
    // `gc --heal` alone can run without it — but it is STILL required unless --heal is the only
    // pass requested, so bare `gc` (neither flag) must still refuse exactly as it always has.
    // Commander's own requiredOption error text ("error: required option '--older-than
    // <duration>' not specified") is reproduced verbatim here since demoting the flag loses its
    // automatic enforcement.
    if (opts.heal !== true && opts.olderThan === undefined) {
      console.error("error: required option '--older-than <duration>' not specified");
      process.exit(1);
      return;
    }

    let olderThanMs: number | undefined;
    if (opts.olderThan !== undefined) {
      try {
        olderThanMs = parseDuration(opts.olderThan);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
        return;
      }

      // Defense-in-depth over sweepOrphans's/sweepOrphanArtifacts's own floor checks — reject
      // before touching the filesystem at all, with a CLI-friendly message naming the flag the
      // operator just typed. Does NOT apply to --heal (see sweepStalePhases's own doc: healing a
      // record already on disk is safe at any age).
      if (olderThanMs < FLOOR_MS) {
        console.error(
          `--older-than must be at least 1h (got '${opts.olderThan}'). gc refuses to reap crash ` +
            `residue younger than that, even with --force.`,
        );
        process.exit(1);
        return;
      }
    }

    // deriveRunPhase destructured from the SAME existing dynamic import as JsonFileStore/
    // FailedAttemptStore — gc.ts's top-level `@sensigo/realm` VALUE import (line 36) stays
    // byte-unchanged; only this dynamic import widens.
    const { JsonFileStore, FailedAttemptStore, deriveRunPhase } = await import('@sensigo/realm');
    const { JsonTraceBufferStore } = await import('@sensigo/realm-mcp');
    const runStore = new JsonFileStore();
    const runsDir = runStore.runsDirPath;
    const failedAttemptStore = new FailedAttemptStore(runsDir);
    const traceBufferStore = new JsonTraceBufferStore(runsDir);
    const orphanSweepableStores: OrphanSweepableStore[] = [traceBufferStore, failedAttemptStore];
    const now = new Date();

    try {
      // --- Pass 1+2 preview (temp files + orphan artifacts) — only when --older-than was given.
      // Composition rule: --older-than gates passes 1+2; --heal gates pass 3; either, both, or
      // (checked above) neither-is-an-error. Byte-identical to the pre-#293 behavior whenever
      // --heal is absent. ---
      let preview: SweepOrphansResult | undefined;
      let bytes = 0;
      let artifactPreview: OrphanArtifactSweepResult | undefined;
      let artifactSweepError: string | undefined;

      if (olderThanMs !== undefined) {
        // Always preview first — this NEVER mutates, in either mode — because it is the only
        // reliable moment to `stat()` the candidates for the report's byte total: a force-mode
        // reap deletes the files before sweepOrphans returns, so statting them afterward is
        // impossible. The preview and the (optional) real pass share the same olderThanMs/now, so
        // the candidate set is consistent bar a narrow, benign concurrent-activity window — which
        // already_gone exists to absorb.
        preview = await sweepOrphans(runsDir, { olderThanMs, dryRun: true, now });
        bytes = await statPathBytes(preview.reaped);

        // issue #163: FAIL-CLOSED. A `listRunIds()` (or a store's `listOrphans()`) failure
        // aborts ONLY the orphan-artifact sweep, loudly — it must NEVER fabricate an empty
        // `liveRunIds`, which would make every live run's artifacts look orphaned and reap them.
        // The temp sweep above is fully independent of this and is completely unaffected either
        // way.
        try {
          const liveRunIds = await runStore.listRunIds();
          artifactPreview = await sweepOrphanArtifacts(
            orphanSweepableStores,
            liveRunIds,
            {
              olderThanMs,
              dryRun: true,
              now,
            },
            runStore,
          );
        } catch (err) {
          artifactSweepError = err instanceof Error ? err.message : String(err);
        }
      }

      // --- Pass 3 (issue #293) — only when --heal was given. No preview/force double-call the
      // way passes 1+2 need (that split exists purely for the byte-total report, which heal has
      // no equivalent of) — one call per invocation, dry-run or force. This dry-run-only preview
      // call is gated on `opts.force !== true` specifically SO IT NEVER RUNS in force mode — the
      // force branch below (a) already makes its OWN call with `force: true`, and (b) is the one
      // that actually matters for a real heal, so a discarded `force: false` call here would be
      // pure waste (an extra `list()` I/O pass, correction-291-293). Reaching the force branch's
      // own `healSweepError === undefined` guard, `healSweepError` is vacuously undefined —
      // nothing above can have set it once this call never runs.
      let healPreview: SweepStalePhasesResult | undefined;
      let healSweepError: string | undefined;
      if (opts.heal === true && opts.force !== true) {
        try {
          healPreview = await sweepStalePhases(runStore, { force: false, deriveRunPhase });
        } catch (err) {
          healSweepError = err instanceof Error ? err.message : String(err);
        }
      }

      if (opts.force !== true) {
        printGcReport(
          preview,
          bytes,
          true,
          artifactPreview,
          artifactSweepError,
          healPreview,
          healSweepError,
        );
        if (
          gcExitCode(preview, artifactPreview, artifactSweepError, healPreview, healSweepError) !==
          0
        ) {
          process.exit(1);
        }
        return;
      }

      let result: SweepOrphansResult | undefined;
      let artifactResult: OrphanArtifactSweepResult | undefined;
      if (olderThanMs !== undefined) {
        result = await sweepOrphans(runsDir, { olderThanMs, dryRun: false, now });

        if (artifactSweepError === undefined) {
          // The preview above already proved listRunIds()/listOrphans() succeed — re-read for
          // the real pass (a fresh liveRunIds, since force mode is a separate call; a run
          // created or completed between the preview and here is a benign, narrow race — exactly
          // the same shape the temp sweep's own preview/force split already accepts).
          try {
            const liveRunIds = await runStore.listRunIds();
            artifactResult = await sweepOrphanArtifacts(
              orphanSweepableStores,
              liveRunIds,
              {
                olderThanMs,
                dryRun: false,
                now,
              },
              runStore,
            );
          } catch (err) {
            artifactSweepError = err instanceof Error ? err.message : String(err);
          }
        }
      }

      let healResult: SweepStalePhasesResult | undefined;
      // `healSweepError === undefined` is vacuously true on entry here (force mode never runs the
      // dry-run-only preview call above) — kept as the guard anyway: it's still the correct
      // condition in spirit (never attempt the real heal if an earlier heal-pass error is already
      // known) and costs nothing to leave in place.
      if (opts.heal === true && healSweepError === undefined) {
        try {
          healResult = await sweepStalePhases(runStore, { force: true, deriveRunPhase });
        } catch (err) {
          healSweepError = err instanceof Error ? err.message : String(err);
        }
      }

      printGcReport(
        result,
        bytes,
        false,
        artifactResult,
        artifactSweepError,
        healResult,
        healSweepError,
      );
      if (
        gcExitCode(result, artifactResult, artifactSweepError, healResult, healSweepError) !== 0
      ) {
        process.exit(1);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
