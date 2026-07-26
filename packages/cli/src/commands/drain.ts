// drain command — post-commit finalizer recovery + operator void (issue #279, increment 1, PR-B).
//
// `realm run drain <run-id> [--force]` / `--all [--force]` / `--void <finalizer>`: dry-run is the
// DEFAULT (draining executes extension/handler code — the same reclaim posture as `realm run
// reclaim`'s own per-step/--force split). Loads project extensions (the respond.ts precedent) so
// a real drain fires REAL handlers, not the built-in default registry alone.
import { Command } from 'commander';
import type {
  RunRecord,
  RunStore,
  WorkflowRegistrar,
  WorkflowDefinition,
  ExtensionRegistry,
  EvidenceSnapshot,
  CaptureEvidenceParams,
} from '@sensigo/realm';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';

// issue #279 (increment 1, PR-B): NO top-level VALUE import from `@sensigo/realm` in THIS file —
// but that alone is NOT sufficient, and this comment corrects an earlier (wrong) assumption to
// that effect. `loadProjectExtensions` (above) itself has a top-level VALUE import of
// `@sensigo/realm` (adapters, createDefaultRegistry, etc.) — so merely *statically* importing
// anything from this module (e.g. a test file's `import { drainCommand } from './drain.js'`)
// ALREADY evaluates `@sensigo/realm`'s module graph, including JsonFileStore's module-load-time
// `DEFAULT_RUNS_DIR = join(homedir(), ...)` capture — BEFORE any test's `beforeEach` can override
// `$HOME`. Confirmed by direct observation: an isolated `vitest run` of a $HOME-override test
// exercising `drainCommand.parseAsync(...)` silently read/wrote the REAL `~/.realm/runs`, not the
// test's temp dir (both the seeding store and drainCommand's internal store resolved to the same
// frozen-wrong default — internally consistent, so the test still "passed" while polluting real
// user data). The FIX is architectural, not import-ordering: `runDrainAction` below takes
// `runStore`/`workflowStore`/the three `@sensigo/realm` runtime values it needs as EXPLICIT
// parameters (mirrors resume.ts's `resumeRun`) — tests call it directly with an explicitly-dired
// store, never through `drainCommand.parseAsync`'s default-store construction. Only
// `drainCommand`'s own `.action()` (real CLI use) still does the dynamic `@sensigo/realm` import
// and constructs the real defaults.

/** One pending finalizer's classification at the RANK-PASS level (design record §6) — what the
 *  NEXT real drain pass would do with it, in rank order. `no_pendings` is a whole-run summary
 *  (never a per-entry class) emitted only when the ledger has zero pending entries. */
export type DrainRankPassClass =
  'actionable' | 'lease_held' | 'rank_blocked_behind_held_lease' | 'no_pendings';

export interface DrainRankPassEntry {
  name: string;
  rank: number;
  class: Exclude<DrainRankPassClass, 'no_pendings'>;
  lease_deadline?: string;
}

/**
 * Classifies every PENDING finalizer_ledger entry, in rank order, mirroring exactly what a real
 * `drainFinalizers` pass would encounter: the first entry whose lease is absent-or-expired is
 * `actionable`; the first entry with an UNEXPIRED lease is `lease_held` and HALTS the simulated
 * pass — every pending entry ranked after it is `rank_blocked_behind_held_lease` (R11:
 * rank-monotonic HALT withholds every higher-ranked deliverable finalizer behind it). Returns `[]`
 * when there are no pending entries (the caller renders `no_pendings`).
 */
export function classifyDrainRankPass(
  ledger: RunRecord['finalizer_ledger'],
  now: Date,
): DrainRankPassEntry[] {
  const pending = Object.entries(ledger ?? {})
    .filter(([, e]) => e.status === 'pending')
    .sort(([, a], [, b]) => a.rank - b.rank);

  const result: DrainRankPassEntry[] = [];
  let halted = false;
  for (const [name, entry] of pending) {
    if (halted) {
      result.push({ name, rank: entry.rank, class: 'rank_blocked_behind_held_lease' });
      continue;
    }
    const isHeld =
      entry.lease_token !== undefined &&
      entry.lease_deadline !== undefined &&
      new Date(entry.lease_deadline).getTime() > now.getTime();
    if (isHeld) {
      result.push({
        name,
        rank: entry.rank,
        class: 'lease_held',
        ...(entry.lease_deadline !== undefined ? { lease_deadline: entry.lease_deadline } : {}),
      });
      halted = true;
    } else {
      result.push({ name, rank: entry.rank, class: 'actionable' });
    }
  }
  return result;
}

/** Batch actionability (design record §6): `status 'pending' ∧ (lease absent ∨ expired)` — a
 *  never-leased pending entry is IN (it has never been attempted), matching `classifyDrainRankPass`
 *  labeling it `actionable` rather than excluding it for lacking a lease at all. */
export function isBatchActionable(run: RunRecord, now: Date): boolean {
  return classifyDrainRankPass(run.finalizer_ledger, now).some((e) => e.class === 'actionable');
}

function renderDryRun(runId: string, run: RunRecord, now: Date): void {
  if (!run.terminal_state) {
    console.log(`Run '${runId}' is not terminal (phase: '${run.run_phase}') — nothing to drain.`);
    return;
  }
  const entries = classifyDrainRankPass(run.finalizer_ledger, now);
  if (entries.length === 0) {
    console.log(`Run '${runId}' has no pending finalizers. Nothing to drain.`);
    return;
  }
  console.log(`Run '${runId}' (${run.run_phase}) — pending finalizers, rank order:`);
  for (const e of entries) {
    const label =
      e.class === 'actionable'
        ? 'actionable — would lease, execute, and mark on --force'
        : e.class === 'lease_held'
          ? `lease held (expires ${e.lease_deadline}) — a drainer is executing NOW`
          : 'rank-blocked — a lower rank holds an active lease, withholding this one';
    console.log(`  • [${e.rank}] ${e.name}: ${label}`);
  }
  console.log(
    `\nRe-run with --force to actually drain. Use --void <finalizer> to void one instead.`,
  );
}

async function resolveRegistry(
  workflowStore: WorkflowRegistrar,
  run: RunRecord,
  opts: { project?: string; extensionsModule?: string },
): Promise<ExtensionRegistry> {
  const workflow = await workflowStore.get(run.workflow_id);
  const { registry } = await loadProjectExtensions(workflow, {
    ...(opts.extensionsModule !== undefined ? { overrideModule: opts.extensionsModule } : {}),
    projectDir: opts.project ?? process.cwd(),
  });
  return registry;
}

export interface DrainCommandOptions {
  force?: boolean;
  all?: boolean;
  void?: string;
  project?: string;
  extensionsModule?: string;
}

/** The three `@sensigo/realm` runtime values `runDrainAction` needs, injected explicitly (never
 *  re-imported internally) — this is what makes the function testable without a `$HOME` override:
 *  see the file-header note on why `$HOME`-override alone is unreliable for this command. */
export interface DrainRuntimeDeps {
  drainFinalizers: (
    store: RunStore,
    definition: WorkflowDefinition,
    registry: ExtensionRegistry,
    runId: string,
  ) => Promise<{ run: RunRecord; warnings: string[] }>;
  captureEvidence: (params: CaptureEvidenceParams) => EvidenceSnapshot;
  drainLeaseMax: number;
  /** Test-only injection point — when absent (the real CLI path), `resolveRegistry` below (the
   *  project-extensions loader) is used. Lets tests supply a hand-built `ExtensionRegistry` with a
   *  real handler registered, without needing an on-disk extensions-module fixture. */
  resolveRegistry?: (
    workflowStore: WorkflowRegistrar,
    run: RunRecord,
    opts: { project?: string; extensionsModule?: string },
  ) => Promise<ExtensionRegistry>;
}

/**
 * The full `realm run drain` behaviour (--void / --all / per-run dry-run/--force), factored out of
 * the Commander `.action()` so tests can drive it directly against an explicitly-constructed store
 * (bypassing JsonFileStore's `$HOME`-derived default entirely) rather than through
 * `drainCommand.parseAsync(...)`, whose own default-store construction cannot be relied on to
 * respect a test's `$HOME` override (see the file-header note).
 */
export async function runDrainAction(
  runId: string | undefined,
  opts: DrainCommandOptions,
  runStore: RunStore,
  workflowStore: WorkflowRegistrar,
  deps: DrainRuntimeDeps,
): Promise<void> {
  const now = new Date();

  // ============================ --void <finalizer> ============================
  if (opts.void !== undefined) {
    if (runId === undefined) {
      console.error('Provide a <run-id> when using --void.');
      process.exit(1);
    }
    if (opts.all === true) {
      console.error('Cannot combine --void with --all.');
      process.exit(1);
    }
    try {
      const run = await runStore.get(runId);
      const entry = run.finalizer_ledger?.[opts.void];
      if (entry === undefined) {
        console.error(`No finalizer ledger entry named '${opts.void}' on run '${runId}'.`);
        process.exit(1);
      }
      if (entry.status !== 'pending') {
        console.error(
          `Finalizer '${opts.void}' is '${entry.status}', not 'pending' — nothing to void.`,
        );
        process.exit(1);
      }
      const isHeld =
        entry.lease_token !== undefined &&
        entry.lease_deadline !== undefined &&
        new Date(entry.lease_deadline).getTime() > now.getTime();
      if (isHeld) {
        console.error(
          `Finalizer '${opts.void}' has an active drain lease (expires ` +
            `${entry.lease_deadline}) — a drainer is executing NOW. Wait for the lease to ` +
            `expire (bounded — leases are clamped to ${deps.drainLeaseMax}s) and retry. Not ` +
            `force-bypassable.`,
        );
        process.exit(1);
      }
      const neverLeased = entry.lease_token === undefined;
      const disclosure = neverLeased
        ? `finalizer '${opts.void}' voided by operator — never executed`
        : `finalizer '${opts.void}' voided by operator — may have executed without a ` +
          `recorded mark (its lease had already expired)`;
      const voidEvidence = deps.captureEvidence({
        stepId: opts.void,
        startedAt: now,
        completedAt: now,
        input: {},
        output: { voided: true, provenance: 'operator', never_leased: neverLeased },
      });
      await runStore.update({
        ...run,
        finalizer_ledger: {
          ...run.finalizer_ledger,
          [opts.void]: { status: 'voided', rank: entry.rank },
        },
        evidence: [...run.evidence, voidEvidence],
      });
      console.log(disclosure);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  // ============================ Batch mode (--all) ============================
  if (opts.all === true) {
    if (runId !== undefined) {
      console.error('Cannot combine a <run-id> with --all. Use one or the other.');
      process.exit(1);
    }
    const runs = await runStore.list();
    const actionable = runs.filter((r) => r.terminal_state && isBatchActionable(r, now));

    if (actionable.length === 0) {
      console.log('No runs with an actionable pending finalizer.');
      return;
    }

    if (opts.force !== true) {
      console.log(`${actionable.length} run(s) WOULD be drained:`);
      for (const r of actionable) {
        console.log(`  • ${r.id}`);
      }
      console.log(`\nRe-run with --force to actually drain them.`);
      return;
    }

    let drained = 0;
    for (const r of actionable) {
      try {
        const registry = await (deps.resolveRegistry ?? resolveRegistry)(workflowStore, r, opts);
        const workflow = await workflowStore.get(r.workflow_id);
        const outcome = await deps.drainFinalizers(runStore, workflow, registry, r.id);
        drained += 1;
        for (const w of outcome.warnings) console.log(`  ⚠ ${r.id}: ${w}`);
        console.log(`  ✓ ${r.id}: drained`);
      } catch (err) {
        console.error(`  ✗ ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`Drained ${drained}/${actionable.length} run(s).`);
    return;
  }

  // ============================ Per-run mode ============================
  if (runId === undefined) {
    console.error('Provide a <run-id>, or use --all for batch mode.');
    process.exit(1);
  }

  try {
    const run = await runStore.get(runId);

    if (opts.force !== true) {
      renderDryRun(runId, run, now);
      return;
    }

    if (!run.terminal_state) {
      console.error(
        `Run '${runId}' is not terminal (phase: '${run.run_phase}') — nothing to drain.`,
      );
      process.exit(1);
    }

    const registry = await (deps.resolveRegistry ?? resolveRegistry)(workflowStore, run, opts);
    const workflow = await workflowStore.get(run.workflow_id);
    const outcome = await deps.drainFinalizers(runStore, workflow, registry, runId);
    for (const w of outcome.warnings) console.log(`  ⚠ ${w}`);
    console.log(`Drained run '${runId}'.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export const drainCommand = new Command('drain')
  .description(
    'Drain post-commit finalizers for a terminal run (recovery for issue #279 crash windows)',
  )
  .argument('[run-id]', 'ID of the run to drain; omit when using --all')
  .option('--force', 'Actually drain (without this, drain only reports what WOULD run)')
  .option('--all', 'Batch mode: drain every run with an actionable pending finalizer')
  .option('--void <finalizer>', 'Void a specific pending finalizer instead of draining it')
  .option(
    '--project <dir>',
    'CONFIG anchor: deployment root whose realm.yaml applies to definitions without a stored trust_root (default: current directory)',
  )
  .option(
    '--extensions-module <path>',
    "CODE override: module that REPLACES the workflow's declared 'extensions' modules (repair tool)",
  )
  .action(async (runId: string | undefined, opts: DrainCommandOptions) => {
    const { JsonFileStore, JsonWorkflowStore, drainFinalizers, captureEvidence, DRAIN_LEASE_MAX } =
      await import('@sensigo/realm');
    const runStore = new JsonFileStore();
    const workflowStore = new JsonWorkflowStore();
    await runDrainAction(runId, opts, runStore, workflowStore, {
      drainFinalizers,
      captureEvidence,
      drainLeaseMax: DRAIN_LEASE_MAX,
    });
  });
