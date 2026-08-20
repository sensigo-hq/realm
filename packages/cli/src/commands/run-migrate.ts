// run-migrate.ts — `realm run migrate --stamp-seals` (issue #367, part 3).
//
// The vehicle the shipped `gc --heal` note promises operators. It walks every terminal run and
// gives each one the seal arm it has always meant, WITHOUT touching the retention clock — which is
// the whole reason it exists rather than letting `--heal` rewrite the same population and reset
// `updated_at` on all of it.
//
// The sweep is TWO-ARMED, and that is load-bearing. An unstamped-only filter would leave the
// `incoherent` bucket with no population at all: the records it exists to surface are precisely
// the STAMPED ones whose arm disagrees with their own prose or markers, and the store boundary
// deliberately abstains on the abandon-marker case, so nothing else in the system can see them.
//
// It writes only through `RunStore.stampSeal`. It never rewrites a record it cannot classify, and
// never auto-corrects one it finds incoherent — an operator adjudicates those.
import { Command } from 'commander';
import type { RunRecord, RunStore, SealArm } from '@sensigo/realm';
import { classifyLegacySeal, armToPhase } from '@sensigo/realm';

/** One record's disposition. Every reachable state has exactly one home here. */
export interface MigrateBuckets {
  /** Newly given its arm. */
  stamped: Array<{ id: string; arm: SealArm; phase_before: string; phase_after: string }>;
  /** Already had an arm, and it agrees with the record. */
  already_stamped: string[];
  /** No arm, and the classifier refuses to guess one. Printed, never written. */
  unclassifiable: Array<{ id: string; why: string }>;
  /** Has an arm that DISAGREES with its own evidence. Printed, never auto-rewritten. */
  incoherent: Array<{
    id: string;
    arm: SealArm;
    classified: SealArm;
    arm_phase: string;
    classified_phase: string;
  }>;
  /** Version moved between read and write — someone else is writing this run. */
  skipped_conflict: string[];
  /** An infrastructure failure on one record; the sweep continues. */
  failed: Array<{ id: string; error: string }>;
}

export interface MigrateOptions {
  /** Dry-run is the DEFAULT; `--force` executes. */
  force?: boolean;
}

function emptyBuckets(): MigrateBuckets {
  return {
    stamped: [],
    already_stamped: [],
    unclassifiable: [],
    incoherent: [],
    skipped_conflict: [],
    failed: [],
  };
}

/**
 * Why a record could not be classified — phrased for an operator, and deliberately phrased to
 * avoid the terminal-writer census's own token: a printed diagnostic must never look like source
 * code that writes a seal.
 */
function whyUnclassifiable(run: RunRecord): string {
  if (run.terminal_reason === undefined) {
    return 'no terminal reason recorded and no marker to read';
  }
  return `terminal reason "${run.terminal_reason.slice(0, 80)}" matches no known seal shape`;
}

/**
 * Exit 1 when the sweep found something an operator must act on: a record nobody can classify, a
 * record whose arm contradicts itself, or a write that failed. Merely finding records to stamp is
 * not a failure, and neither is a conflict — the other writer owns that record's next write.
 */
export function migrateExitCode(buckets: MigrateBuckets): number {
  return buckets.unclassifiable.length > 0 ||
    buckets.incoherent.length > 0 ||
    buckets.failed.length > 0
    ? 1
    : 0;
}

/**
 * The sweep. Pure over its injected store, so the acceptance suite drives it directly.
 *
 * `not_terminal` refusals from `stampSeal` are STATED-UNREACHABLE here rather than bucketed: this
 * loop only offers terminal records, and any terminal→live flip bumps `version`, so the CAS
 * refuses first and the record lands in `skipped_conflict`.
 */
export async function migrateStampSeals(
  runStore: RunStore,
  options: MigrateOptions = {},
): Promise<MigrateBuckets> {
  if (runStore.stampSeal === undefined) {
    throw new Error(
      'This store does not implement stampSeal, so `realm run migrate --stamp-seals` cannot ' +
        'write to it. Records stay readable and correct without migrating — the read path ' +
        'recovers a legacy arm on every read. To materialise the arms, use the tooling that owns ' +
        'this store.',
    );
  }
  const buckets = emptyBuckets();
  const all = await runStore.list();

  for (const run of all) {
    if (!run.terminal_state) continue;

    // ARM 2 — already stamped: audit the arm against the record's own evidence.
    if (run.sealed_by !== undefined) {
      // The FULL markers-first classifier, deliberately: the store boundary's comparator abstains
      // on abandon-marker records, and those are exactly the stale arms nothing else observes.
      const classified = classifyLegacySeal(run);
      // PHASE level, not arm level. The classifier can only ever recover `complete` from a
      // completed run's prose, so comparing arms would report every `gate_resolution_complete` and
      // `guard_pass_complete` stamp as a disagreement.
      if (classified === undefined || armToPhase(classified) === armToPhase(run.sealed_by.arm)) {
        buckets.already_stamped.push(run.id);
      } else {
        buckets.incoherent.push({
          id: run.id,
          arm: run.sealed_by.arm,
          classified,
          arm_phase: armToPhase(run.sealed_by.arm),
          classified_phase: armToPhase(classified),
        });
      }
      continue;
    }

    // ARM 1 — unstamped: classify, then stamp.
    const arm = classifyLegacySeal(run);
    if (arm === undefined) {
      buckets.unclassifiable.push({ id: run.id, why: whyUnclassifiable(run) });
      continue;
    }
    const phaseBefore = run.run_phase;
    const phaseAfter = armToPhase(arm);
    if (options.force !== true) {
      buckets.stamped.push({ id: run.id, arm, phase_before: phaseBefore, phase_after: phaseAfter });
      continue;
    }
    try {
      // `classified: true` marks this stamp as CLASSIFIER-minted, forever distinguishable from a
      // writer's own assertion. `step` is never fabricated.
      const result = await runStore.stampSeal(run.id, { arm, classified: true }, run.version);
      if (result.stamped) {
        buckets.stamped.push({
          id: run.id,
          arm,
          phase_before: phaseBefore,
          phase_after: result.run.run_phase,
        });
      } else {
        buckets.already_stamped.push(run.id);
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'STATE_SNAPSHOT_MISMATCH') {
        buckets.skipped_conflict.push(run.id);
      } else {
        buckets.failed.push({
          id: run.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return buckets;
}

/** The ordering instruction, live since the vehicle exists. */
export const ORDERING_LINE =
  'Run `realm run migrate --stamp-seals` BEFORE `realm run gc --heal` after upgrading across ' +
  '#367 if retention clocks matter: heal rewrites the same records and resets updated_at, which ' +
  'this command deliberately preserves.';

/** Renders the report. Returned as lines so the output cells can read it without capturing stdout. */
export function renderMigrateReport(
  buckets: MigrateBuckets,
  options: MigrateOptions = {},
): string[] {
  const force = options.force === true;
  const lines: string[] = [];
  const nothing =
    buckets.stamped.length === 0 &&
    buckets.already_stamped.length === 0 &&
    buckets.unclassifiable.length === 0 &&
    buckets.incoherent.length === 0 &&
    buckets.skipped_conflict.length === 0 &&
    buckets.failed.length === 0;

  if (nothing) {
    lines.push('No terminal runs found to migrate.');
  } else if (buckets.stamped.length > 0) {
    lines.push(
      force
        ? `Stamped ${buckets.stamped.length} run(s) with their seal arm.`
        : `${buckets.stamped.length} run(s) WOULD be stamped:`,
    );
    for (const e of buckets.stamped) {
      const phase =
        e.phase_before === e.phase_after ? e.phase_after : `${e.phase_before} → ${e.phase_after}`;
      lines.push(`  • ${e.id}: ${e.arm} (phase ${phase})`);
    }
  } else if (force) {
    lines.push('Nothing to stamp — every terminal run already carries its seal arm.');
  } else {
    lines.push('Nothing would be stamped — every terminal run already carries its seal arm.');
  }

  if (buckets.already_stamped.length > 0) {
    lines.push(`${buckets.already_stamped.length} run(s) already stamped and coherent.`);
  }
  if (buckets.unclassifiable.length > 0) {
    lines.push(
      `${buckets.unclassifiable.length} run(s) could NOT be classified and were left untouched:`,
    );
    for (const e of buckets.unclassifiable) lines.push(`  • ${e.id}: ${e.why}`);
  }
  if (buckets.incoherent.length > 0) {
    lines.push(
      `${buckets.incoherent.length} run(s) carry an arm that disagrees with their own record — ` +
        `adjudicate these yourself; nothing was rewritten:`,
    );
    for (const e of buckets.incoherent) {
      lines.push(
        `  • ${e.id}: recorded arm '${e.arm}' (phase ${e.arm_phase}), but the record's own ` +
          `markers/prose read as '${e.classified}' (phase ${e.classified_phase})`,
      );
    }
  }
  if (buckets.skipped_conflict.length > 0) {
    lines.push(
      `${buckets.skipped_conflict.length} run(s) skipped — a concurrent writer moved them; ` +
        `their own next write path owns them.`,
    );
    for (const id of buckets.skipped_conflict)
      lines.push(`  • ${id}  (skipped — concurrent write)`);
  }
  for (const f of buckets.failed) lines.push(`  ✗ ${f.id}: ${f.error}`);

  if (!force && !nothing) lines.push('Re-run with --force to actually stamp.');
  // The residue metric — how much of the corpus still has no recorded arm.
  const residue = buckets.unclassifiable.length + (force ? 0 : buckets.stamped.length);
  lines.push(`Residue: ${residue} terminal run(s) still without a recorded seal arm.`);
  lines.push(ORDERING_LINE);
  return lines;
}

export const runMigrateCommand = new Command('migrate')
  .description('Materialise recorded seal arms on legacy terminal runs (issue #367)')
  .requiredOption('--stamp-seals', 'Stamp each terminal run with the seal arm it has always meant')
  .option('--force', 'Actually write the stamps (without this, the sweep is a dry run)')
  .action(async (opts: { force?: boolean }) => {
    const { JsonFileStore } = await import('@sensigo/realm');
    const runStore = new JsonFileStore();
    try {
      const buckets = await migrateStampSeals(runStore, { force: opts.force ?? false });
      for (const line of renderMigrateReport(buckets, { force: opts.force ?? false })) {
        console.log(line);
      }
      process.exitCode = migrateExitCode(buckets);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
