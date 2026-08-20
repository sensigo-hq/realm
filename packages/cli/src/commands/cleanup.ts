// cleanup command — marks idle non-terminal runs as abandoned.
import { Command } from 'commander';
import type { RunStore, RunRecord } from '@sensigo/realm';
import { WAITING_PHASES, deriveRunPhase, sealRunLevel } from '@sensigo/realm';
import { parseDuration } from '../lib/parse-duration.js';

/**
 * List all non-terminal runs idle for longer than `olderThan` and mark them abandoned.
 * @param options  `olderThan` is a duration string; `dryRun` skips writes.
 * @param runStore Store holding run records.
 * @returns The list of affected runs.
 */
export async function cleanupRuns(
  options: { olderThan: string; dryRun?: boolean },
  runStore: RunStore,
): Promise<{ affected: RunRecord[] }> {
  const threshold = parseDuration(options.olderThan);
  const now = Date.now();
  const all = await runStore.list();

  const affected: RunRecord[] = [];
  for (const run of all) {
    if (run.terminal_state) {
      continue;
    }
    // issue #367: DERIVE the phase, and check the gate directly. Keying the waiting-skip on the
    // PERSISTED `run_phase` is the disposal-rule violation #282 exists to close — and it is not
    // theoretical here: a record whose persisted phase is stale while a human is genuinely waiting
    // on a live gate was being sealed `cleanup_sweep` with `pending_gate` still on the record, i.e.
    // this command was freshly minting the very zombie shape #282 closed, and killing a run
    // somebody was answering. The stale-phase population is exactly what `gc --heal` exists for,
    // so cleanup-before-heal is an ordinary ordering. `abandonRun` already checks the gate; this
    // brings its sweeping sibling in line.
    if (run.pending_gate !== undefined || WAITING_PHASES.has(deriveRunPhase(run))) {
      continue;
    }
    const idleMs = now - new Date(run.updated_at).getTime();
    if (idleMs >= threshold) {
      affected.push(run);
    }
  }

  if (!(options.dryRun ?? false)) {
    for (const run of affected) {
      // issue #367: run-level seal through the ONE bypass-writer chokepoint — it stamps
      // sealed_by {arm: 'cleanup_sweep'} alongside abandoned_at, and the fossil hand-written
      // run_phase is retired (the store write tail derives it — the #282 class).
      await runStore.update(
        sealRunLevel(run, 'cleanup_sweep', 'Marked abandoned by realm cleanup'),
      );
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
    const { JsonFileStore } = await import('@sensigo/realm');
    const runStore = new JsonFileStore();
    try {
      const { affected } = await cleanupRuns(opts, runStore);
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
      console.log(
        `abandon is a kill — declared finalizers (if any) did NOT run; 'abort' is the graceful path.`,
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
