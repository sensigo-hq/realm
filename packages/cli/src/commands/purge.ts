// purge command — the operator-invoked, IRREVERSIBLE run-deletion primitive (issue #107).
//
// Deletes a terminal/abandoned run and ALL its co-located on-disk artifacts (run file + the
// idempotency-key pointer when owned, the failed-attempt sidecar, orphaned WAL trace-buffer files)
// via the PerRunArtifactStore marker — no store or command hard-codes another store's filename
// layout; each store deletes only its own artifacts. Dry-run by default; `--force` to actually
// delete (a single <id> ALSO requires `--force` — naming a run is selection, not consent).
//
// Non-negotiable invariants (do not weaken): terminal-only (never a non-terminal or `gate_waiting`
// run); never a run carrying a non-stale (future-deadline / `healthy`) claim — load-bearing for
// `abandoned` runs, which do not clear `claims` (see cleanup.ts). There is no override flag for
// either check — unlike `reclaim`, purge has no per-run "I know what I'm doing" escape hatch.
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

export type PurgeEligibility = { eligible: true } | { eligible: false; reason: string };

/**
 * The safety-critical selection predicate (mirrors `isAutoReclaimable` in reclaim.ts): a run may be
 * purged IFF it is terminal AND carries no future-deadline ("healthy") in-progress claim. Unlike
 * `reclaim`'s `--force`, there is no override — this predicate is consulted unconditionally by both
 * single-run and batch purge, and a run it rejects can never enter `selected`.
 */
export function isPurgeEligible(run: RunRecord, now: Date = new Date()): PurgeEligibility {
  if (!TERMINAL_PHASES.has(run.run_phase)) {
    return { eligible: false, reason: `not terminal (phase: '${run.run_phase}')` };
  }
  const futureClaim = classifyInProgressClaims(run, now).find((c) => c.state === 'healthy');
  if (futureClaim !== undefined) {
    return {
      eligible: false,
      reason:
        `run carries a future-deadline claim on step '${futureClaim.step}' ` +
        `(deadline: ${futureClaim.deadline}) — a live runner may still be working it`,
    };
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
 * resumability, and — when `dryRun` is false — deletes them via `artifactStores`, in the order
 * given (LOAD-BEARING: `runStore`, the `JsonFileStore` element, must be last — see purge.ts's
 * command wiring and `purge-guard.test.ts`). Continue-on-error across the batch: a
 * `STATE_RUN_NOT_FOUND` hit while deleting (a concurrent purge already removed it) is bucketed as
 * `already_purged`, never `failed` — a benign race must not be reported as a failure.
 */
export async function purgeRuns(
  options: PurgeRunsOptions,
  runStore: Pick<RunStore, 'get' | 'list'> & { readonly runsDirPath: string },
  artifactStores: PerRunArtifactStore[],
): Promise<PurgeRunsResult> {
  const dryRun = options.dryRun ?? true;
  const now = new Date();
  const runsDir = runStore.runsDirPath;

  const candidates: RunRecord[] = [];
  const skipped: Array<{ runId: string; reason: string }> = [];

  if (options.runId !== undefined) {
    const run = await runStore.get(options.runId);
    const verdict = isPurgeEligible(run, now);
    if (verdict.eligible) {
      candidates.push(run);
    } else {
      skipped.push({ runId: run.id, reason: verdict.reason });
    }
  } else {
    const thresholdMs = options.olderThan !== undefined ? parseDuration(options.olderThan) : 0;
    const all = await runStore.list(options.workflow);
    for (const run of all) {
      const verdict = isPurgeEligible(run, now);
      if (!verdict.eligible) {
        // Only a terminal-but-blocked run (the future-claim case) is a noteworthy skip+warn — a
        // plain non-terminal run isn't a purge candidate in the first place and needn't be noisy.
        if (TERMINAL_PHASES.has(run.run_phase)) {
          skipped.push({ runId: run.id, reason: verdict.reason });
        }
        continue;
      }
      const idleMs = now.getTime() - new Date(run.updated_at).getTime();
      if (idleMs < thresholdMs) continue;
      candidates.push(run);
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
  for (const run of candidates) {
    const bytes = await statMatchedBytes(runsDir, run.id, dirEntries);
    selected.push({ run, bytes, resumable: RESUMABLE_PHASES.has(run.run_phase) });
  }

  const result: PurgeRunsResult = { selected, skipped, purged: [], already_purged: [], failed: [] };
  if (dryRun) return result;

  for (const { run } of selected) {
    try {
      // Re-check the run still exists immediately before deleting — closes the window against a
      // concurrent purge that already removed it between selection and here. A STATE_RUN_NOT_FOUND
      // surfacing here means "already gone," which the catch below routes to already_purged.
      await runStore.get(run.id);
      for (const store of artifactStores) {
        await store.deleteAllForRun(run.id, dirEntries);
      }
      result.purged.push(run.id);
    } catch (err) {
      if (err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND') {
        result.already_purged.push(run.id);
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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

  const totalBytes = result.selected.reduce((sum, c) => sum + c.bytes, 0);
  const resumableCount = result.selected.filter((c) => c.resumable).length;
  const resumableLine =
    `${resumableCount} of ${result.selected.length} selected run(s) ` +
    `${dryRun ? 'are' : 'were'} resumable via 'realm resume' — ` +
    `purging ${dryRun ? 'would destroy' : 'has destroyed'} that path ${dryRun ? 'permanently' : 'for them'}.`;

  if (dryRun) {
    console.log(
      `${result.selected.length} run(s) WOULD be purged (${formatBytes(totalBytes)} to free):`,
    );
    for (const c of result.selected) {
      console.log(`  • ${c.run.id}  (${c.run.run_phase}, ${formatBytes(c.bytes)})`);
    }
    console.log(`\n${resumableLine}\nRe-run with --force to actually delete.`);
    return;
  }

  console.log(
    `Purged ${result.purged.length}/${result.selected.length} run(s) (${formatBytes(totalBytes)} freed). ` +
      `${result.already_purged.length} already gone, ${result.failed.length} failed.`,
  );
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
      // Orchestration order is LOAD-BEARING (issue #107): runStore MUST be last — a crash mid-purge
      // leaves the run record in place, so the run is re-enumerated and the purge is retried
      // idempotently. purge-guard.test.ts asserts this exact order via source-text — do not
      // reorder these three lines without updating that test.
      const artifactStores: PerRunArtifactStore[] = [
        traceBufferStore, // JsonTraceBufferStore
        failedAttemptStore, // FailedAttemptStore
        runStore, // JsonFileStore — LAST: crash-anchor (issue #107)
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
