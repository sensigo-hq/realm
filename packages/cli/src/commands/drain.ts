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
  SettlementResult,
} from '@sensigo/realm';
import { applySettlement } from '@sensigo/realm';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';

/**
 * Issue #291 ([F5] `drain --expired` opt-in flag): classifies a run's `pending_gate` against the
 * frozen enforce clock — pure, `now`-injectable. `'none'`/`'not_expired'` mean nothing to show;
 * `'finding_only'` (expires_at present, on_expiry absent) is listed but never acted on;
 * `'enactable'` carries the frozen disposition drain would enact under `--force`.
 */
export type GateExpiryClass =
  | { kind: 'none' }
  | { kind: 'not_expired' }
  | { kind: 'finding_only'; overdueMs: number }
  | { kind: 'enactable'; disposition: 'settle_default' | 'abort'; overdueMs: number };

export function classifyGateExpiry(run: RunRecord, now: Date): GateExpiryClass {
  const gate = run.pending_gate;
  if (gate === undefined || gate.expires_at === undefined) return { kind: 'none' };
  const overdueMs = now.getTime() - new Date(gate.expires_at).getTime();
  if (overdueMs < 0) return { kind: 'not_expired' };
  if (gate.on_expiry === undefined) return { kind: 'finding_only', overdueMs };
  return { kind: 'enactable', disposition: gate.on_expiry, overdueMs };
}

/** Local duration formatter (issue #291) — CLI-side, mirrors core's own `formatOverdueDuration`
 *  shape independently (no cross-package import for a two-branch formatter). */
function formatOverdueDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
  return `${totalDays}d ${totalHours % 24}h`;
}

/**
 * Issue #291 ([F5]/[F4]): enacts an expired, enactable gate via the SAME dormancy-discriminated
 * pattern `submitHumanResponse`/`enactExpiredGateIfDue` use — `store.settleStep` when declared,
 * else the pure `applySettlement` transform + `store.update`'s CAS write. Returns the resulting
 * run (unchanged on a benign refusal/race) and whether it actually applied.
 */
async function enactGateExpiry(
  runStore: RunStore,
  definition: WorkflowDefinition,
  run: RunRecord,
  now: Date,
): Promise<{ run: RunRecord; applied: boolean }> {
  const gateId = run.pending_gate!.gate_id;
  const delta = { kind: 'expire_gate' as const, gateId };
  let outcome: SettlementResult;
  if (runStore.settleStep !== undefined) {
    outcome = await runStore.settleStep(run.id, delta, definition, { now });
  } else {
    const pure = applySettlement(run, delta, definition, { now });
    if (!pure.applied) return { run: pure.run, applied: false };
    const persisted = await runStore.update(pure.run);
    outcome = { ...pure, run: persisted };
  }
  return { run: outcome.run, applied: outcome.applied };
}

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
//
// issue #285 (2026-08-13): the paragraph above is now HISTORICAL, not current — this comment adds
// a layer rather than flattening the ones before it, per its own established style. The capture
// mechanism itself is FIXED AT THE ROOT: `JsonFileStore`'s default `runsDir` (and
// `JsonFileReplayStore`'s default `replaysDir`) now resolve `homedir()` INSIDE their constructors,
// exactly like `JsonWorkflowStore` (`registrar.ts:26`) always has — never at module load. A static
// top-level VALUE import of `@sensigo/realm` anywhere in the transitive closure no longer freezes
// anything; `$HOME` is read fresh at the moment a store is actually constructed. Concretely: `:18`
// below (`import { applySettlement } from '@sensigo/realm'`, added by #317, after this header's
// "NO top-level VALUE import" claim was written) no longer contradicts anything — the invariant
// this paragraph enforced is RETIRED, and #317's import was always harmless post-#285, just
// pre-#285-inconsistent with a rule that has now been dissolved rather than followed. The
// explicit-params architecture (`runDrainAction` taking `runStore`/`workflowStore` etc.) REMAINS
// the preferred test idiom regardless — it was never solely a workaround for this hazard (it also
// avoids constructing REAL default stores in tests at all, keeps call sites explicit about what
// they depend on, and is the same shape `resumeRun` already uses) — so it is NOT being unwound;
// only the "must never top-level-import @sensigo/realm" prohibition is. `drain.test.ts`/
// `drain-purge-integration.test.ts`'s own lazy-import workarounds are similarly left in place
// (still correct, no longer load-bearing against this specific hazard — not worth the churn to
// simplify) — see their own headers' #285 addenda.

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

/** Issue #291 ([F5]): prints the gate-expiry dry-run line when `--expired` is set and this run
 *  carries an expired gate — the EXACT pinned strings ("would enact <disposition>" /
 *  "expired — finding-only"). Returns `true` when an enactable gate was reported (the caller
 *  uses this to decide whether the run still counts as "nothing to drain" when it has neither a
 *  gate nor pending finalizers). No-op (returns `false`) when `--expired` is unset or nothing
 *  gate-related applies — bare `drain` stays byte-stable. */
function renderGateExpiryDryRun(
  runId: string,
  run: RunRecord,
  now: Date,
  expiredFlag: boolean,
): boolean {
  if (!expiredFlag) return false;
  const cls = classifyGateExpiry(run, now);
  if (cls.kind === 'enactable') {
    const overdue = formatOverdueDuration(cls.overdueMs);
    console.log(
      `Run '${runId}': gate expired ${overdue} ago — would enact ${cls.disposition} on --force.`,
    );
    return true;
  }
  if (cls.kind === 'finding_only') {
    const overdue = formatOverdueDuration(cls.overdueMs);
    console.log(
      `Run '${runId}': gate expired ${overdue} ago — finding-only (no on_expiry declared, nothing to enact).`,
    );
    return false;
  }
  return false;
}

function renderDryRun(runId: string, run: RunRecord, now: Date, expiredFlag = false): void {
  const gateReported = renderGateExpiryDryRun(runId, run, now, expiredFlag);
  if (!run.terminal_state) {
    if (!gateReported) {
      console.log(`Run '${runId}' is not terminal (phase: '${run.run_phase}') — nothing to drain.`);
    }
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
  /** Issue #291 ([F5]): opt-in — without it, drain's terminal-only behavior (incl. batch
   *  `--force`) stays byte-stable. With it, drain ALSO reports/enacts expired-and-enactable
   *  gates (never finding-only ones), flowing an abort-disposition's terminalization straight
   *  into drain's native finalizer pass. */
  expired?: boolean;
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
    const finalizerActionable = runs.filter((r) => r.terminal_state && isBatchActionable(r, now));
    // issue #291 ([F5]): OPT-IN — without --expired, batch mode is byte-stable terminal-only
    // (a non-terminal run with an expired gate is invisible to bare `drain --all`, exactly as
    // before). finalizerActionable requires terminal_state; gateActionable/findingOnlyGates
    // require !terminal_state — mutually exclusive by construction, no dedup needed.
    const gateActionable =
      opts.expired === true
        ? runs.filter((r) => !r.terminal_state && classifyGateExpiry(r, now).kind === 'enactable')
        : [];
    const findingOnlyGates =
      opts.expired === true
        ? runs.filter(
            (r) => !r.terminal_state && classifyGateExpiry(r, now).kind === 'finding_only',
          )
        : [];
    const actionable = [...finalizerActionable, ...gateActionable];

    if (actionable.length === 0 && findingOnlyGates.length === 0) {
      console.log('No runs with an actionable pending finalizer.');
      return;
    }

    if (opts.force !== true) {
      if (actionable.length > 0) {
        console.log(`${actionable.length} run(s) WOULD be drained:`);
        for (const r of finalizerActionable) {
          console.log(`  • ${r.id}`);
        }
        for (const r of gateActionable) {
          const cls = classifyGateExpiry(r, now);
          if (cls.kind === 'enactable') {
            console.log(
              `  • ${r.id}: gate expired ${formatOverdueDuration(cls.overdueMs)} ago — would enact ${cls.disposition}`,
            );
          }
        }
      }
      for (const r of findingOnlyGates) {
        console.log(`  • ${r.id}: gate expired — finding-only (no on_expiry, nothing to enact)`);
      }
      console.log(`\nRe-run with --force to actually drain them.`);
      return;
    }

    let drained = 0;
    for (const r of finalizerActionable) {
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
    // issue #291: enact each expired gate, then — per [F5]'s "abort enactment flows into
    // drain's own finalizer pass" — run the native finalizer drain on any run the enactment
    // just terminalized (settle_default may or may not terminalize; abort always does).
    for (const r of gateActionable) {
      try {
        const workflow = await workflowStore.get(r.workflow_id);
        const { run: enactedRun, applied } = await enactGateExpiry(runStore, workflow, r, now);
        if (!applied) {
          console.log(`  • ${r.id}: gate expiry already resolved (race) — skipped`);
          continue;
        }
        drained += 1;
        console.log(`  ✓ ${r.id}: gate enacted`);
        if (enactedRun.terminal_state && isBatchActionable(enactedRun, now)) {
          const registry = await (deps.resolveRegistry ?? resolveRegistry)(
            workflowStore,
            enactedRun,
            opts,
          );
          const outcome = await deps.drainFinalizers(runStore, workflow, registry, r.id);
          for (const w of outcome.warnings) console.log(`  ⚠ ${r.id}: ${w}`);
        }
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
    const gateClass = classifyGateExpiry(run, now);
    const hasEnactableGate = opts.expired === true && gateClass.kind === 'enactable';

    if (opts.force !== true) {
      renderDryRun(runId, run, now, opts.expired === true);
      return;
    }

    if (!run.terminal_state && !hasEnactableGate) {
      console.error(
        `Run '${runId}' is not terminal (phase: '${run.run_phase}') — nothing to drain.`,
      );
      process.exit(1);
    }

    let workingRun = run;
    if (hasEnactableGate) {
      const workflowForGate = await workflowStore.get(run.workflow_id);
      const { run: enactedRun, applied } = await enactGateExpiry(
        runStore,
        workflowForGate,
        run,
        now,
      );
      if (applied) {
        console.log(
          `✓ gate enacted (${gateClass.kind === 'enactable' ? gateClass.disposition : ''}).`,
        );
        workingRun = enactedRun;
      } else {
        console.log(`• gate expiry already resolved (race) — skipped.`);
        workingRun = enactedRun;
      }
    }

    if (!workingRun.terminal_state) {
      // The enactment (settle_default) did not terminalize this run — nothing further to drain.
      console.log(
        `Run '${runId}' is not terminal (phase: '${workingRun.run_phase}') — nothing further to drain.`,
      );
      return;
    }

    const registry = await (deps.resolveRegistry ?? resolveRegistry)(
      workflowStore,
      workingRun,
      opts,
    );
    const workflow = await workflowStore.get(workingRun.workflow_id);
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
    '--expired',
    'OPT-IN (issue #291): also report/enact expired-and-enactable gates (never finding-only ' +
      'ones) — a non-terminal run with an expired gate is invisible without this flag, on both ' +
      "per-run and --all. An abort disposition's terminalization flows into the same drain pass.",
  )
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
