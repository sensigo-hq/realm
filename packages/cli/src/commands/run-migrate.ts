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
  /**
   * Already had an arm. `verified` says whether the audit could actually CHECK it: the classifier
   * abstains on a record whose own prose and markers place it nowhere, and an abstention is not a
   * finding of coherence. Reporting those as "coherent" would be the same false-confidence class
   * this program exists to remove.
   *
   * `ruled` means a HUMAN checked it — an operator's adjudication, which outranks the classifier.
   * Those records are short-circuited before classification: without that, a lawfully ruled record
   * whose prose still disagrees re-parks as `incoherent` on every future sweep, and the loop the
   * ruling exists to close never closes.
   */
  already_stamped: Array<{ id: string; verified: boolean; ruled?: true }>;
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
 * The exit taxonomy, aligned with the house rule every other sweep command follows (`gc`'s own,
 * gc.ts): **exit 1 means THIS COMMAND failed to do its job.** A write that errored is that. A
 * record nobody can classify is not — the command did exactly what it should, and said so loudly.
 *
 * That distinction matters more here than usual, because residue is CHRONIC: an unclassifiable
 * record stays unclassifiable, so a nonzero exit on residue would make every scheduled run of this
 * command fail forever, and the first thing an operator does with a chronic alarm is silence it.
 *
 * Automation that genuinely wants to gate on residue opts in with `--detailed-exitcode`, which
 * turns the two outcomes into a three-way: 0 clean · 1 the command failed · 2 succeeded, residue
 * remains. Same shape as `grep`, `git diff --exit-code` and Terraform's `-detailed-exitcode` — a
 * machine-readable answer that needs no prose parsing, and that naive pipelines never inherit.
 */
export function migrateExitCode(
  buckets: MigrateBuckets,
  options: { detailed?: boolean } = {},
): number {
  if (buckets.failed.length > 0) return 1;
  if (
    options.detailed === true &&
    (buckets.unclassifiable.length > 0 || buckets.incoherent.length > 0)
  ) {
    return 2;
  }
  return 0;
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
        'recovers a legacy arm wherever one is recoverable, and the rest still derive correctly from ' +
        'the legacy ladder. To materialise the arms, use the tooling that owns ' +
        'this store.',
    );
  }
  const buckets = emptyBuckets();
  const all = await runStore.list();

  for (const run of all) {
    if (!run.terminal_state) continue;

    // ARM 2 — already stamped: audit the arm against the record's own evidence.
    if (run.sealed_by !== undefined) {
      // A ruled record is done. An operator looked at it and said what it is, which outranks
      // anything the classifier can infer from prose — and re-examining it every sweep is exactly
      // the loop the ruling was made to end.
      if (run.sealed_by.adjudicated !== undefined) {
        buckets.already_stamped.push({ id: run.id, verified: true, ruled: true });
        continue;
      }
      // The FULL markers-first classifier, deliberately: the store boundary's comparator abstains
      // on abandon-marker records, and those are exactly the stale arms nothing else observes.
      const classified = classifyLegacySeal(run);
      // PHASE level, not arm level. The classifier can only ever recover `complete` from a
      // completed run's prose, so comparing arms would report every `gate_resolution_complete` and
      // `guard_pass_complete` stamp as a disagreement.
      if (classified === undefined) {
        // Abstained: nothing to compare against. The arm stands, unverified.
        buckets.already_stamped.push({ id: run.id, verified: false });
      } else if (armToPhase(classified) === armToPhase(run.sealed_by.arm)) {
        buckets.already_stamped.push({ id: run.id, verified: true });
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
        // The record gained an arm between the sweep's read and this write; nothing to verify.
        buckets.already_stamped.push({ id: run.id, verified: false });
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

/**
 * `armToPhase` is total over `SEAL_ARMS`, and returns JS `undefined` for anything else — so an arm
 * written by a NEWER binary interpolated straight into a report line as "phase undefined", which
 * reads like a bug in this command rather than a record it cannot interpret.
 */
function phaseLabel(phase: string | undefined): string {
  return phase === undefined
    ? 'phase unknown to this binary (written by a newer version?)'
    : `phase ${phase}`;
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

  // "every terminal run already carries its seal arm" is a UNIVERSAL claim, and four different
  // buckets can each falsify it: a record nobody could classify, one whose write failed, one whose
  // arm contradicts itself, and one a concurrent writer moved. It may only be appended when all
  // four are empty. It shipped appended unconditionally, printed directly above the very records
  // that disprove it.
  const everyRunArmed =
    buckets.unclassifiable.length === 0 &&
    buckets.incoherent.length === 0 &&
    buckets.failed.length === 0 &&
    buckets.skipped_conflict.length === 0;

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
    lines.push(
      everyRunArmed
        ? 'Nothing to stamp — every terminal run already carries its seal arm.'
        : 'Nothing was stamped.',
    );
  } else {
    lines.push(
      everyRunArmed
        ? 'Nothing would be stamped — every terminal run already carries its seal arm.'
        : 'Nothing would be stamped.',
    );
  }

  if (buckets.already_stamped.length > 0) {
    // "Coherent" is a finding, and the audit cannot make it when the classifier abstains — a
    // record whose own evidence places it nowhere has an arm that stands UNVERIFIED, not one that
    // has been checked and agreed with.
    // Three disjoint groups, and the arithmetic is pinned by a cell: X + R + U = N.
    const ruled = buckets.already_stamped.filter((e) => e.ruled === true).length;
    const checked = buckets.already_stamped.filter((e) => e.verified && e.ruled !== true).length;
    const unverified = buckets.already_stamped.filter((e) => !e.verified).length;
    if (ruled === 0 && unverified === 0) {
      lines.push(
        `${buckets.already_stamped.length} run(s) already stamped, and their arms agree with the record.`,
      );
    } else {
      // "Their arms agree with the record" would be FALSE for a ruled record whose prose still
      // disagrees — the ruling stands over that disagreement rather than resolving it. So any
      // ruled record forces the split form, and the ruled segment always shows when there is one.
      const segments: string[] = [];
      if (checked > 0) segments.push(`${checked} checked against the record`);
      if (ruled > 0) segments.push(`${ruled} ruled by an operator — the ruling stands`);
      if (unverified > 0) {
        segments.push(
          `${unverified} unverifiable — nothing in the record to check the arm against`,
        );
      }
      lines.push(
        `${buckets.already_stamped.length} run(s) already stamped (${segments.join(', ')}).`,
      );
    }
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
        `  • ${e.id}: recorded arm '${e.arm}' (${phaseLabel(e.arm_phase)}), but the record's own ` +
          `markers/prose read as '${e.classified}' (${phaseLabel(e.classified_phase)})`,
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
  if (buckets.failed.length > 0) {
    lines.push(`${buckets.failed.length} run(s) FAILED to stamp and still have no seal arm:`);
    for (const f of buckets.failed) lines.push(`  ✗ ${f.id}: ${f.error}`);
  }

  // Only offer the next step when there IS one: on a corpus of nothing but unclassifiable records,
  // `--force` stamps exactly nothing, and inviting the operator to run it is a wasted round trip.
  if (!force && buckets.stamped.length > 0) lines.push('Re-run with --force to actually stamp.');

  // RESIDUE = terminal runs that will still have no recorded arm when this run ends. A failed
  // write leaves the record armless just as surely as an unclassifiable one does — omitting it
  // printed "Residue: 0" directly above a record that had failed to stamp. In a dry run nothing is
  // written, so the would-be-stamped records still count.
  const residue =
    buckets.unclassifiable.length + buckets.failed.length + (force ? 0 : buckets.stamped.length);
  const skipped =
    buckets.skipped_conflict.length > 0
      ? ` (+${buckets.skipped_conflict.length} skipped — arm state unknown until their own writer settles)`
      : '';
  lines.push(`Residue: ${residue} terminal run(s) still without a recorded seal arm.${skipped}`);
  lines.push(ORDERING_LINE);
  return lines;
}

export const runMigrateCommand = new Command('migrate')
  .description('Materialise recorded seal arms on legacy terminal runs (issue #367)')
  .requiredOption('--stamp-seals', 'Stamp each terminal run with the seal arm it has always meant')
  .option('--force', 'Actually write the stamps (without this, the sweep is a dry run)')
  .option(
    '--detailed-exitcode',
    'Three-way exit for automation: 0 clean, 1 the command failed, 2 succeeded but residue ' +
      'remains (the shape grep, `git diff --exit-code` and Terraform use). Opt-in, so a naive ' +
      'pipeline never inherits a chronic alarm from records that can never be classified.',
  )
  .action(async (opts: { force?: boolean; detailedExitcode?: boolean }) => {
    const { JsonFileStore } = await import('@sensigo/realm');
    const runStore = new JsonFileStore();
    try {
      const buckets = await migrateStampSeals(runStore, { force: opts.force ?? false });
      for (const line of renderMigrateReport(buckets, { force: opts.force ?? false })) {
        console.log(line);
      }
      process.exitCode = migrateExitCode(buckets, { detailed: opts.detailedExitcode ?? false });
    } catch (err) {
      // The batch never started, or stopped before writing — say so, rather than emitting a bare
      // errno an operator has to guess the scope of.
      console.error(
        `migrate ABORTED before writing anything: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });
