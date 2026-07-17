// gc command — sweep orphaned atomic-write temps (issue #160) AND run-less orphaned WAL/sidecar
// artifacts (issue #163). One operator command, two independent sweeps, same flags.
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
import { readdir, lstat, unlink, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Command } from 'commander';
import { WorkflowError, deleteIfExists } from '@sensigo/realm';
import type { OrphanSweepableStore, OrphanArtifact, RunStore } from '@sensigo/realm';
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
  result: SweepOrphansResult,
  previewBytes: number,
  dryRun: boolean,
  artifactResult: OrphanArtifactSweepResult | undefined,
  artifactSweepError: string | undefined,
): void {
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

  console.log(`\n${NOT_REAPED_FOOTER}`);
}

/** gc's exit code: non-zero iff gc could not complete a sweep it attempted (issue #163
 *  exit-code correction). A failed unlink in EITHER sweep, OR an aborted orphan sweep
 *  (enumeration failed — `artifactSweepError` set), is a failure. Merely *finding* reapable
 *  residue is NOT — that holds in both dry-run and `--force`, so this one helper decides both
 *  branches' exit code instead of each re-deriving its own (inline) predicate. */
export function gcExitCode(
  tempResult: SweepOrphansResult,
  artifactResult: OrphanArtifactSweepResult | undefined,
  artifactSweepError: string | undefined,
): number {
  const anyFailure =
    tempResult.failed.length > 0 ||
    (artifactResult?.failed.length ?? 0) > 0 ||
    artifactSweepError !== undefined;
  return anyFailure ? 1 : 0;
}

export const gcCommand = new Command('gc')
  .description(
    'Sweep orphaned atomic-write .tmp files and run-less orphaned WAL/sidecar artifacts (dry-run by default)',
  )
  .requiredOption(
    '--older-than <duration>',
    'Reap residue idle at least this long (minimum 1h; e.g. 1h, 6h, 30d)',
  )
  .option('--force', 'Actually delete (without this, gc only reports what WOULD be reaped)')
  .action(async (opts: { olderThan: string; force?: boolean }) => {
    let olderThanMs: number;
    try {
      olderThanMs = parseDuration(opts.olderThan);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
      return;
    }

    // Defense-in-depth over sweepOrphans's/sweepOrphanArtifacts's own floor checks — reject
    // before touching the filesystem at all, with a CLI-friendly message naming the flag the
    // operator just typed.
    if (olderThanMs < FLOOR_MS) {
      console.error(
        `--older-than must be at least 1h (got '${opts.olderThan}'). gc refuses to reap crash ` +
          `residue younger than that, even with --force.`,
      );
      process.exit(1);
      return;
    }

    const { JsonFileStore, FailedAttemptStore } = await import('@sensigo/realm');
    const { JsonTraceBufferStore } = await import('@sensigo/realm-mcp');
    const runStore = new JsonFileStore();
    const runsDir = runStore.runsDirPath;
    const failedAttemptStore = new FailedAttemptStore(runsDir);
    const traceBufferStore = new JsonTraceBufferStore(runsDir);
    const orphanSweepableStores: OrphanSweepableStore[] = [traceBufferStore, failedAttemptStore];
    const now = new Date();

    try {
      // Always preview first — this NEVER mutates, in either mode — because it is the only
      // reliable moment to `stat()` the candidates for the report's byte total: a force-mode
      // reap deletes the files before sweepOrphans returns, so statting them afterward is
      // impossible. The preview and the (optional) real pass share the same olderThanMs/now, so
      // the candidate set is consistent bar a narrow, benign concurrent-activity window — which
      // already_gone exists to absorb.
      const preview = await sweepOrphans(runsDir, { olderThanMs, dryRun: true, now });
      const bytes = await statPathBytes(preview.reaped);

      // issue #163: FAIL-CLOSED. A `listRunIds()` (or a store's `listOrphans()`) failure aborts
      // ONLY the orphan-artifact sweep, loudly — it must NEVER fabricate an empty `liveRunIds`,
      // which would make every live run's artifacts look orphaned and reap them. The temp sweep
      // above is fully independent of this and is completely unaffected either way.
      let artifactPreview: OrphanArtifactSweepResult | undefined;
      let artifactSweepError: string | undefined;
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

      if (opts.force !== true) {
        printGcReport(preview, bytes, true, artifactPreview, artifactSweepError);
        if (gcExitCode(preview, artifactPreview, artifactSweepError) !== 0) {
          process.exit(1);
        }
        return;
      }

      const result = await sweepOrphans(runsDir, { olderThanMs, dryRun: false, now });

      let artifactResult: OrphanArtifactSweepResult | undefined;
      if (artifactSweepError === undefined) {
        // The preview above already proved listRunIds()/listOrphans() succeed — re-read for the
        // real pass (a fresh liveRunIds, since force mode is a separate call; a run created or
        // completed between the preview and here is a benign, narrow race — exactly the same
        // shape the temp sweep's own preview/force split already accepts).
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

      printGcReport(result, bytes, false, artifactResult, artifactSweepError);
      if (gcExitCode(result, artifactResult, artifactSweepError) !== 0) {
        process.exit(1);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
