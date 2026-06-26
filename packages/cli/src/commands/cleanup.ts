// cleanup command — marks idle non-terminal runs as abandoned.
import { Command } from 'commander';
import type { RunStore, RunRecord } from '@sensigo/realm';
import { WorkflowError, WAITING_PHASES } from '@sensigo/realm';

/**
 * Parses a duration string such as "30d", "6h", or "10m" into milliseconds.
 */
function parseDuration(s: string): number {
  const match = /^(\d+)(d|h|m)$/.exec(s);
  if (match === null) {
    throw new WorkflowError(
      `Invalid duration '${s}'. Use format: <number>(d|h|m), e.g. 30d, 6h, 10m`,
      {
        code: 'VALIDATION_INPUT_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'provide_input',
        retryable: false,
      },
    );
  }
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multipliers: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };
  return value * multipliers[unit]!;
}

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
    if (WAITING_PHASES.has(run.run_phase)) {
      continue;
    }
    const idleMs = now - new Date(run.updated_at).getTime();
    if (idleMs >= threshold) {
      affected.push(run);
    }
  }

  if (!(options.dryRun ?? false)) {
    for (const run of affected) {
      await runStore.update({
        ...run,
        abandoned_at: new Date().toISOString(),
        run_phase: 'abandoned',
        terminal_state: true,
        terminal_reason: 'Marked abandoned by realm cleanup',
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
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
