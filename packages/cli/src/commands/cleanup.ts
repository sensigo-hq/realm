// cleanup command — marks idle non-terminal runs as abandoned.
import { Command } from 'commander';
import type { Attributed, RunStore } from '@sensigo/realm';
import { isIdleForCleanup } from '@sensigo/realm';
import { parseDuration } from '../lib/parse-duration.js';
import { openCliHome } from '../lib/home.js';
import { endingProgramIdentity } from '../lib/program-identity.js';
// Gap 1, unit A0: the listing that reads no model call's text.
import { scanListedRuns, type ListedRecord, type ListedSnapshot } from '@sensigo/realm';

/**
 * List all non-terminal runs idle for longer than `olderThan` and mark them abandoned.
 * @param options  `olderThan` is a duration string; `dryRun` skips writes. #625 PR-2b, the actor
 *   unit: `actor.by`, the program that runs the cleanup, is recorded on each run it marks, with the
 *   door `realm_run_cleanup`; with no `actor`, neither.
 * @param runStore Store holding run records.
 * @returns The list of affected runs.
 */
export async function cleanupRuns(
  options: { olderThan: string; dryRun?: boolean; actor?: { by: Attributed } },
  runStore: RunStore,
): Promise<{ affected: ListedRecord[] }> {
  const threshold = parseDuration(options.olderThan);
  // #715 (b) (D-26, D6-41): each run is judged at its OWN snapshot's reading.
  // #616 PR-2c c4: every page of the store's scan.
  // Gap 1, unit A0: listed, so no model call's text is read; the seal below writes by run id.
  const all: ListedSnapshot[] = [];
  for await (const page of scanListedRuns(runStore, {}, { pageSize: 1000 })) {
    for (const item of page.items) if (item.kind === 'run') all.push(item.run);
  }

  const affected: ListedRecord[] = [];
  for (const snapshot of all) {
    // #715 (b) (02 §B.3, D6-9, Amendment 11): selected by core's one cleanup judge, at this row's own
    // reading — not ended, no question open (issue #367: a gate is never swept, whatever the persisted
    // phase says), idle for the threshold, and no step held by a live claim.
    if (isIdleForCleanup(snapshot, threshold)) affected.push(snapshot.record);
  }

  if (!(options.dryRun ?? false)) {
    for (const run of affected) {
      // issue #367: run-level seal through the ONE bypass-writer chokepoint — it stamps
      // sealed_by {arm: 'cleanup_sweep'} alongside abandoned_at, and the fossil hand-written
      // run_phase is retired (the store write tail derives it — the #282 class).
      // issue #558 PR-C: the sweep releases every claim in the same write, exactly as
      // `abandonRun` does — a swept run is abandoned, and an abandoned run holds no claim.
      // #715 (b) (D-21): through the `seal_run` settlement delta — `abandoned_at` is the write's own
      // reading, and a run that moved since this sweep read it is thrown as STATE_SNAPSHOT_MISMATCH
      // (the sweep aborts, as it did when update() threw). No definition (Amendment 1).
      await runStore.settleStep(run.id, {
        kind: 'seal_run',
        arm: 'cleanup_sweep',
        reason: 'Marked abandoned by realm cleanup',
        expected_version: run.version,
        release_claims: true,
        ...(options.actor !== undefined
          ? { by: options.actor.by, door: 'realm_run_cleanup' as const }
          : {}),
      });
    }
  }

  return { affected };
}

export const cleanupCommand = new Command('cleanup')
  .description('Mark idle non-terminal runs as abandoned')
  .requiredOption(
    '--older-than <duration>',
    'Abandon runs idle longer than this duration (e.g. 30d, 6h, 10m)',
  )
  .option('--dry-run', 'Preview which runs would be abandoned without modifying them')
  .action(async (opts: { olderThan: string; dryRun?: boolean }) => {
    const { ABANDON_KILL_ADVISORY } = await import('@sensigo/realm');
    // #616 PR-2a (iii): the one door, opened once.
    const runStore = (await openCliHome()).runStore;
    try {
      // #625 PR-2b, the actor unit: this program, recorded on each run the cleanup marks. A
      // REALM_OPERATOR it cannot use records no name (and warns after the write), never a stop.
      const identity = endingProgramIdentity('cleanup');
      const { affected } = await cleanupRuns(
        {
          ...opts,
          ...(identity.driver !== undefined ? { actor: { by: identity.driver } } : {}),
        },
        runStore,
      );
      const n = affected.length;
      if (opts.dryRun ?? false) {
        console.log(`Would mark ${n} run(s) as abandoned.`);
      } else {
        console.log(`Marked ${n} run(s) as abandoned.`);
      }
      // issue #367: name the runs, and say what abandoning them means. Both sibling surfaces ship
      // this advisory unconditionally; the sweeping one printed a bare count, which is the harder
      // case to check afterwards — an operator could not tell WHICH runs a sweep had killed.
      for (const run of affected) {
        console.log(`  • ${run.id}`);
      }
      // issue #558 PR-C: the THIRD surface carrying this advisory — the same ONE core mint
      // (`ABANDON_KILL_ADVISORY`) as `realm run abandon` and the `abandon_run` tool.
      console.log(ABANDON_KILL_ADVISORY);
      // #625 PR-2b, the actor unit: only after a write that ended a run (no dry run, no empty sweep).
      if (identity.warning !== undefined && !(opts.dryRun ?? false) && n > 0) {
        console.error(identity.warning('the runs this cleanup marked abandoned name no program'));
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
