// abandon command — explicitly abandons a non-terminal run via the shared core primitive.
import { Command } from 'commander';

export const abandonCommand = new Command('abandon')
  .description('Abandon a non-terminal run (marks it terminal with phase "abandoned")')
  .argument('<run-id>', 'ID of the run to abandon')
  .option('--reason <text>', 'Human-readable reason recorded as terminal_reason')
  .action(async (runId: string, opts: { reason?: string }) => {
    const { JsonFileStore, abandonRun } = await import('@sensigo/realm');
    const runStore = new JsonFileStore();
    try {
      const run = await abandonRun(runStore, runId, opts.reason);
      console.log(
        `Run '${runId}' abandoned (phase: '${run.run_phase}'). Reason: ${run.terminal_reason}.\n` +
          `To re-run the same idempotency key, use start_run with on_terminal_match: 'rerun' (default 'reuse' returns this abandoned run).`,
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
