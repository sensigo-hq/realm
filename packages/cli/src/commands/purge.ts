// purge command — the operator-invoked, IRREVERSIBLE run-deletion primitive (issue #107).
//
// Deletes a terminal/abandoned run and ALL its co-located on-disk artifacts (run file + the
// idempotency-key pointer when owned, the failed-attempt sidecar, orphaned WAL trace-buffer files)
// via the PerRunArtifactStore marker — no store or command hard-codes another store's filename
// layout; each store deletes only its own artifacts. Dry-run by default; `--force` to actually
// delete (a single <id> ALSO requires `--force` — naming a run is selection, not consent).
//
// Non-negotiable invariants (do not weaken): terminal-only (never a non-terminal or `gate_waiting`
// run). Claim posture (issue #107 correction) is mode-aware: a `healthy` (future-deadline) claim is
// NEVER purged, in either mode — there is no override, because a live runner is provably still
// working it. A `claim_unknown_age` (null-deadline) claim — load-bearing for `abandoned` runs, which
// do not clear `claims` (see cleanup.ts) — is skipped+warned in BATCH mode (a cron sweep cannot prove
// the runner is dead and must not guess), but IS purgeable via an explicit single-id
// `realm run purge <id> --force` — the operator named this exact run, a deliberate judgment call
// `reclaim`'s own batch mode also refuses to make automatically. A `claim_stale` (past-deadline)
// claim, or no in-progress claim at all, is purgeable in both modes.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import type { RunRecord, RunStore, PerRunArtifactStore } from '@sensigo/realm';
import {
  WorkflowError,
  TERMINAL_PHASES,
  RESUMABLE_PHASES,
  classifyInProgressClaims,
} from '@sensigo/realm';
import { parseDuration } from '../lib/parse-duration.js';

export type PurgeEligibility =
  | { eligible: true; overriddenClaimStep?: string | undefined }
  | { eligible: false; reason: string };

/**
 * The safety-critical selection predicate (mirrors `isAutoReclaimable` in reclaim.ts) — mode-aware
 * (issue #107 correction): the caller MUST state whether this is an explicit single-id purge
 * (`explicit: true` — the operator named this exact run) or a batch/cron sweep (`explicit: false`).
 * There is no default; a future call site is forced to pick a mode rather than silently inheriting
 * the more permissive one.
 *
 * Worst-claim-wins ordering across every in-progress claim on the run:
 *  1. `healthy` (future deadline) → REFUSE in both modes. No override — the runner is provably
 *     still alive; this is the one hard line purge will never cross.
 *  2. `claim_unknown_age` (no deadline — agent step / finalizer-bearing / pre-#101 run) → refuse in
 *     batch (a cron sweep cannot prove the runner is dead and must not guess — mirrors
 *     `reclaim.isAutoReclaimable`'s own refusal of this exact state), but ELIGIBLE when explicit —
 *     the operator named this run directly, which is deliberate judgment a batch sweep can't make.
 *  3. `claim_stale` (past deadline) or no in-progress claim at all → eligible in both modes.
 *
 * A run this predicate rejects can never enter `selected`; an explicit-mode acceptance of case 2
 * carries `overriddenClaimStep` so the report can surface that the override fired.
 */
export function isPurgeEligible(
  run: RunRecord,
  opts: { explicit: boolean; now?: Date },
): PurgeEligibility {
  if (!TERMINAL_PHASES.has(run.run_phase)) {
    return { eligible: false, reason: `not terminal (phase: '${run.run_phase}')` };
  }

  const now = opts.now ?? new Date();
  const claims = classifyInProgressClaims(run, now);

  const healthyClaim = claims.find((c) => c.state === 'healthy');
  if (healthyClaim !== undefined) {
    return {
      eligible: false,
      reason:
        `run carries a future-deadline claim on step '${healthyClaim.step}' ` +
        `(deadline: ${healthyClaim.deadline}) — a live runner may still be working it`,
    };
  }

  const unknownAgeClaim = claims.find((c) => c.state === 'claim_unknown_age');
  if (unknownAgeClaim !== undefined) {
    if (!opts.explicit) {
      return {
        eligible: false,
        reason:
          `run carries an indeterminate-age claim on step '${unknownAgeClaim.step}' ` +
          `(no deadline recorded — a runner may or may not still be working it); skipped in batch; ` +
          `run 'realm run purge ${run.id} --force' to purge it explicitly.`,
      };
    }
    return { eligible: true, overriddenClaimStep: unknownAgeClaim.step };
  }

  return { eligible: true };
}

/**
 * Best-effort on-disk bytes for `runId`: stat every `runsDir` entry whose name CONTAINS the runId
 * (the run file `<id>.json`, `trace-buffer-<id>-*.jsonl`, `<id>.attempts.jsonl`). Reporting-only —
 * this never gates or drives deletion (that stays exclusively behind each store's own
 * `deleteAllForRun`) — and may under-count by the idempotency-key pointer's few dozen bytes: that
 * file is content-addressed by `sha256(workflow_id\0key)`, not the runId, so a runId-substring scan
 * structurally cannot find it (by design — that hash is JsonFileStore-private, and this function
 * must not replicate another store's filename layout to go looking for it).
 */
async function statMatchedBytes(
  runsDir: string,
  runId: string,
  dirEntries: readonly string[],
): Promise<number> {
  const matched = dirEntries.filter((f) => f.includes(runId));
  let total = 0;
  await Promise.all(
    matched.map(async (f) => {
      try {
        const info = await stat(join(runsDir, f));
        total += info.size;
      } catch {
        // vanished between the scan and this stat — best-effort, ignore.
      }
    }),
  );
  return total;
}

export interface PurgeCandidate {
  run: RunRecord;
  bytes: number;
  resumable: boolean;
  /**
   * Set (to the step name) when this run was selected ONLY because an explicit single-id purge
   * accepted a `claim_unknown_age` (indeterminate-age) claim that batch mode would have skipped
   * (issue #107 correction). Always undefined for a batch-mode selection.
   */
  overriddenClaimStep?: string | undefined;
}

export interface PurgeRunsResult {
  /** Runs selected for purge (eligible, and — in batch mode — past the age threshold). */
  selected: PurgeCandidate[];
  /** Runs considered but rejected by `isPurgeEligible`, with the reason. */
  skipped: Array<{ runId: string; reason: string }>;
  /** Populated only when `dryRun` is false: runs actually deleted. */
  purged: string[];
  /** Populated only when `dryRun` is false: a concurrent/prior purge had already removed it — never a failure. */
  already_purged: string[];
  /**
   * Populated only when `dryRun` is false (issue #184): the run could not be deleted right now
   * because another writer holds its lock (`ELOCKED`), or because it is no longer terminal (a
   * concurrent `realm resume` raced the purge) — `STATE_RUN_BUSY` from the anchor store. NEVER a
   * failure: a live writer self-heals, and a stale lock is eventually stolen.
   */
  blocked: Array<{ runId: string; reason: string }>;
  /** Populated only when `dryRun` is false: deletion genuinely failed. */
  failed: Array<{ runId: string; error: string }>;
}

export interface PurgeRunsOptions {
  /** Single-run mode: the run to purge. Mutually exclusive with `olderThan`. */
  runId?: string | undefined;
  /** Batch mode: purge every eligible run idle at least this long (e.g. "30d", "6h"). */
  olderThan?: string | undefined;
  /** Batch mode: restrict to runs of this workflow. */
  workflow?: string | undefined;
  /** Default true (safe). Only when explicitly false does this function delete anything. */
  dryRun?: boolean | undefined;
}

/**
 * Selects eligible run(s) (single `runId` or a batch aged past `olderThan`), reports bytes and
 * resumability, and — when `dryRun` is false — deletes them. Deletion is anchor-structural (issue
 * #184): every `artifactStores` entry (non-anchor stores only) must succeed BEFORE
 * `anchorStore.deleteAllForRun` — the `JsonFileStore` run file — is ever called, and only on
 * total success. Any throw before that point leaves the anchor (and therefore the run) intact —
 * the crash-anchor property is now structural (guaranteed by this function's control flow), not
 * merely positional (an array-ordering convention a future edit could silently break — see
 * `purge-guard.test.ts`'s ANCHOR checks for the source-text half of this guarantee).
 *
 * Continue-on-error across the batch: a `STATE_RUN_NOT_FOUND` hit while deleting (a concurrent
 * purge already removed it) is bucketed as `already_purged`; a `STATE_RUN_BUSY` hit (another
 * writer holds the lock, or the run was resumed since selection — issue #184) is bucketed as
 * `blocked`; neither is ever a `failed`.
 */
export async function purgeRuns(
  options: PurgeRunsOptions,
  anchorStore: Pick<RunStore, 'get' | 'list'> &
    PerRunArtifactStore & { readonly runsDirPath: string },
  artifactStores: PerRunArtifactStore[],
): Promise<PurgeRunsResult> {
  const dryRun = options.dryRun ?? true;
  const now = new Date();
  const runsDir = anchorStore.runsDirPath;

  const candidates: Array<{ run: RunRecord; overriddenClaimStep?: string | undefined }> = [];
  const skipped: Array<{ runId: string; reason: string }> = [];

  if (options.runId !== undefined) {
    const run = await anchorStore.get(options.runId);
    // explicit: true — the operator named this exact run, so a claim_unknown_age claim is an
    // eligible override, never a healthy one (issue #107 correction).
    const verdict = isPurgeEligible(run, { explicit: true, now });
    if (verdict.eligible) {
      candidates.push({ run, overriddenClaimStep: verdict.overriddenClaimStep });
    } else {
      skipped.push({ runId: run.id, reason: verdict.reason });
    }
  } else {
    const thresholdMs = options.olderThan !== undefined ? parseDuration(options.olderThan) : 0;
    const all = await anchorStore.list(options.workflow);
    for (const run of all) {
      // explicit: false — a batch/cron sweep cannot prove an indeterminate-age claim's runner is
      // dead, so claim_unknown_age is refused here (skipped+warned below), not overridden.
      const verdict = isPurgeEligible(run, { explicit: false, now });
      if (!verdict.eligible) {
        // Only a terminal-but-blocked run (a future or indeterminate-age claim) is a noteworthy
        // skip+warn — a plain non-terminal run isn't a purge candidate in the first place and
        // needn't be noisy.
        if (TERMINAL_PHASES.has(run.run_phase)) {
          skipped.push({ runId: run.id, reason: verdict.reason });
        }
        continue;
      }
      const idleMs = now.getTime() - new Date(run.updated_at).getTime();
      if (idleMs < thresholdMs) continue;
      candidates.push({ run, overriddenClaimStep: verdict.overriddenClaimStep });
    }
  }

  // One readdir up front (batch or single) → passed as dirEntries to every store, so a batch of N
  // runs costs O(readdir) once, not O(N × readdir) per JsonTraceBufferStore glob scan.
  let dirEntries: string[];
  try {
    dirEntries = await readdir(runsDir);
  } catch {
    dirEntries = [];
  }

  const selected: PurgeCandidate[] = [];
  for (const { run, overriddenClaimStep } of candidates) {
    const bytes = await statMatchedBytes(runsDir, run.id, dirEntries);
    selected.push({
      run,
      bytes,
      resumable: RESUMABLE_PHASES.has(run.run_phase),
      overriddenClaimStep,
    });
  }

  const result: PurgeRunsResult = {
    selected,
    skipped,
    purged: [],
    already_purged: [],
    blocked: [],
    failed: [],
  };
  if (dryRun) return result;

  for (const { run } of selected) {
    try {
      // Re-check the run still exists immediately before deleting — closes the window against a
      // concurrent purge that already removed it between selection and here. A STATE_RUN_NOT_FOUND
      // surfacing here means "already gone," which the catch below routes to already_purged.
      await anchorStore.get(run.id);
      for (const store of artifactStores) {
        if (hasDeleteAllForRunFenced(store)) {
          // issue #207 PR-2 (D3 §5): fenced — re-verifies at destruction time, inside the
          // store's own critical section, that the run is still gone/terminal.
          await store.deleteAllForRunFenced(
            run.id,
            buildPurgeWalGuard(anchorStore, run.id),
            dirEntries,
          );
        } else {
          // Non-declaring artifact store (e.g. FailedAttemptStore — issue #207 PR-2, D3 §5
          // residual 4): the sidecar delete remains UNFENCED, a named residual (telemetry-grade,
          // best-effort by that store's own contract — not run-record evidence, not
          // acknowledged-durable data; the anchor stays #184-protected regardless).
          await store.deleteAllForRun(run.id, dirEntries);
        }
      }
      // The anchor LAST, and only on total success (issue #184) — structural crash-anchor: any
      // throw above (from a non-anchor artifact store) never reaches this line, so the run file
      // is guaranteed intact for re-enumeration on the next pass.
      await anchorStore.deleteAllForRun(run.id, dirEntries);
      result.purged.push(run.id);
    } catch (err) {
      if (err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND') {
        result.already_purged.push(run.id);
      } else if (err instanceof WorkflowError && err.code === 'STATE_RUN_BUSY') {
        const reason = err.details['reason'];
        result.blocked.push({
          runId: run.id,
          reason: typeof reason === 'string' ? reason : err.message,
        });
      } else {
        result.failed.push({
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

/** The subset of the fenced trio purge actually calls (issue #207 PR-2) — a store-shape check,
 *  not an import from `@sensigo/realm`'s `TraceBufferStore`, since `artifactStores` is typed as
 *  `PerRunArtifactStore[]` (narrower) and a concrete store (e.g. `JsonTraceBufferStore`) may
 *  additionally implement this. */
interface DeleteAllForRunFencedCapable {
  deleteAllForRunFenced(
    runId: string,
    guard: () => Promise<void>,
    dirEntries?: readonly string[],
  ): Promise<void>;
}

function hasDeleteAllForRunFenced(
  store: PerRunArtifactStore,
): store is PerRunArtifactStore & DeleteAllForRunFencedCapable {
  return (
    typeof (store as Partial<DeleteAllForRunFencedCapable>).deleteAllForRunFenced === 'function'
  );
}

/**
 * Builds the fenced-delete guard for one run (issue #207 PR-2, D3 §5): a lock-free
 * `anchorStore.get(runId)` re-verified INSIDE the artifact store's own critical section,
 * immediately before its WAL delete. The real routing (issue #207 correction — this doc
 * previously overclaimed that any read failure lands `blocked`, which is not what the code does):
 * run genuinely gone (`STATE_RUN_NOT_FOUND`) → proceeds (resolves) — safe to purge its WAL; run
 * still present but no longer terminal (a concurrent `realm resume` raced the purge) → throws the
 * typed `STATE_RUN_BUSY` shape purge's own bucket mapping already routes to `blocked` (verified by
 * the extended purge-guard test, not rebuilt here); ANY OTHER read failure (a genuine I/O error,
 * not an absence or a resume race) → re-thrown UNWRAPPED, exactly as the guard contract requires —
 * this is neither `STATE_RUN_NOT_FOUND` nor `STATE_RUN_BUSY`, so it falls through purge's own
 * catch to the `failed` bucket, not `blocked`. Extends #184's terminal-re-verify from the anchor
 * layer to the WAL artifact layer, closing the purge/resume resurrect race for WALs too.
 */
function buildPurgeWalGuard(
  anchorStore: Pick<RunStore, 'get'>,
  runId: string,
): () => Promise<void> {
  return async () => {
    let fresh: RunRecord;
    try {
      fresh = await anchorStore.get(runId);
    } catch (err) {
      if (err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND') {
        return; // gone — safe to purge its WAL
      }
      throw err;
    }
    if (!TERMINAL_PHASES.has(fresh.run_phase)) {
      throw new WorkflowError(
        `Run '${runId}' is no longer terminal — refusing to purge its trace buffer`,
        {
          code: 'STATE_RUN_BUSY',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: true,
          details: {
            runId,
            reason: `run '${runId}' is no longer terminal (resumed since selection) — refusing to purge its trace buffer`,
          },
        },
      );
    }
    // Still gone or still terminal, same run — proceed.
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The override-transparency phrase (issue #107 correction): every candidate purged only because an
 * explicit single-id override accepted its indeterminate-age claim must say so, in both dry-run and
 * force output — this can only ever be non-empty for a single-id selection (batch always calls
 * `isPurgeEligible` with `explicit: false`, so a `claim_unknown_age` run there lands in `skipped`,
 * never `selected` — see `purgeRuns`).
 */
function overriddenClaimPhrase(step: string, dryRun: boolean): string {
  const verb = dryRun ? 'would purge' : 'purged';
  return (
    `${verb} despite an indeterminate-age claim on step '${step}' (no deadline recorded — a runner ` +
    `may or may not still be working it; explicit single-run override proceeds anyway)`
  );
}

/** Prints the dry-run / force report shared by both single-run and batch mode. */
function printPurgeReport(result: PurgeRunsResult, dryRun: boolean): void {
  for (const s of result.skipped) {
    console.warn(`⚠ skipping ${s.runId}: ${s.reason}`);
  }

  if (result.selected.length === 0) {
    console.log('No eligible runs found to purge.');
    return;
  }

  const resumableCount = result.selected.filter((c) => c.resumable).length;
  const resumableLine =
    `${resumableCount} of ${result.selected.length} selected run(s) ` +
    `${dryRun ? 'are' : 'were'} resumable via 'realm resume' — ` +
    `purging ${dryRun ? 'would destroy' : 'has destroyed'} that path ${dryRun ? 'permanently' : 'for them'}.`;

  if (dryRun) {
    // Dry-run's "to free" total is a PROJECTION over every selected candidate — nothing has been
    // purged yet, so the full selected total is the correct (and only sensible) figure here.
    const totalBytes = result.selected.reduce((sum, c) => sum + c.bytes, 0);
    console.log(
      `${result.selected.length} run(s) WOULD be purged (${formatBytes(totalBytes)} to free):`,
    );
    for (const c of result.selected) {
      const override =
        c.overriddenClaimStep !== undefined
          ? ` — ${overriddenClaimPhrase(c.overriddenClaimStep, true)}`
          : '';
      console.log(`  • ${c.run.id}  (${c.run.run_phase}, ${formatBytes(c.bytes)})${override}`);
    }
    console.log(`\n${resumableLine}\nRe-run with --force to actually delete.`);
    return;
  }

  // issue #184: sum bytes over ACTUALLY-PURGED runs only — `selected` also includes candidates
  // that ended up already_purged/blocked/failed, whose bytes were never actually freed. Summing
  // over `selected` here would over-report "freed" bytes for anything but a 100%-successful batch.
  const purgedIds = new Set(result.purged);
  const freedBytes = result.selected
    .filter((c) => purgedIds.has(c.run.id))
    .reduce((sum, c) => sum + c.bytes, 0);

  console.log(
    `Purged ${result.purged.length}/${result.selected.length} run(s) (${formatBytes(freedBytes)} freed). ` +
      `${result.already_purged.length} already gone, ${result.blocked.length} blocked, ${result.failed.length} failed.`,
  );
  for (const c of result.selected) {
    if (c.overriddenClaimStep !== undefined) {
      console.log(`  ⚠ ${c.run.id}: ${overriddenClaimPhrase(c.overriddenClaimStep, false)}`);
    }
  }
  for (const b of result.blocked) {
    console.error(`  ⚠ ${b.runId}: ${b.reason}`);
  }
  for (const f of result.failed) {
    console.error(`  ✗ ${f.runId}: ${f.error}`);
  }
  console.log(resumableLine);
}

export const purgeCommand = new Command('purge')
  .description(
    'Permanently delete a terminal run and all its co-located artifacts (IRREVERSIBLE — dry-run by default)',
  )
  .argument('[run-id]', 'ID of the run to purge; omit when using --older-than for batch mode')
  .option('--force', 'Actually delete (without this, purge only reports what WOULD be deleted)')
  .option(
    '--older-than <duration>',
    'Batch mode: purge every eligible run idle at least this long (e.g. 30d, 6h, 10m)',
  )
  .option('--workflow <id>', 'With --older-than: only consider runs of this workflow')
  .action(
    async (
      runId: string | undefined,
      opts: { force?: boolean; olderThan?: string; workflow?: string },
    ) => {
      if (runId !== undefined && opts.olderThan !== undefined) {
        console.error('Cannot combine a <run-id> with --older-than. Use one or the other.');
        process.exit(1);
      }
      if (runId === undefined && opts.olderThan === undefined) {
        console.error('Provide a <run-id> to purge, or use --older-than for batch mode.');
        process.exit(1);
      }
      if (runId !== undefined && opts.workflow !== undefined) {
        console.error('--workflow is only valid with --older-than.');
        process.exit(1);
      }

      const { JsonFileStore, FailedAttemptStore } = await import('@sensigo/realm');
      const { JsonTraceBufferStore } = await import('@sensigo/realm-mcp');
      const runStore = new JsonFileStore();
      const runsDir = runStore.runsDirPath;
      const failedAttemptStore = new FailedAttemptStore(runsDir);
      const traceBufferStore = new JsonTraceBufferStore(runsDir);
      // The crash-anchor is now STRUCTURAL, not positional (issue #184): runStore (JsonFileStore)
      // is passed to purgeRuns as the separate anchorStore argument, and purgeRuns's own control
      // flow guarantees it is only ever deleted after every entry below has succeeded — it is
      // deliberately ABSENT from this array. purge-guard.test.ts's ANCHOR check asserts this
      // absence via source-text; do not re-add it here.
      const artifactStores: PerRunArtifactStore[] = [
        traceBufferStore, // JsonTraceBufferStore
        failedAttemptStore, // FailedAttemptStore
      ];

      const dryRun = opts.force !== true;
      try {
        const result = await purgeRuns(
          { runId, olderThan: opts.olderThan, workflow: opts.workflow, dryRun },
          runStore,
          artifactStores,
        );

        if (runId !== undefined && result.selected.length === 0) {
          // Single-run mode, rejected by isPurgeEligible: a REFUSAL (exit 1), not a quiet skip —
          // mirrors reclaim.ts's explicit per-step refusals.
          const reason = result.skipped[0]?.reason ?? 'not eligible';
          console.error(`Refusing to purge '${runId}': ${reason}.`);
          process.exit(1);
        }

        printPurgeReport(result, dryRun);
        if (result.failed.length > 0) process.exit(1);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    },
  );
