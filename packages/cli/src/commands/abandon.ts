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
      // issue #367: read first, so the output can say whether THIS call changed anything —
      // abandoning an already-abandoned run is an idempotent no-op and used to print exactly the
      // same line as a real kill.
      const before = await runStore.get(runId);
      const alreadyAbandoned = before.abandoned_at !== undefined;
      const run = await abandonRun(runStore, runId, opts.reason);
      console.log(
        `Run '${runId}' abandoned (phase: '${run.run_phase}').` +
          (alreadyAbandoned ? ' Already abandoned (no change this call).' : '') +
          ` Reason: ${run.terminal_reason}.\n` +
          `To re-run the same idempotency key, use start_run with on_terminal_match: 'rerun' (default 'reuse' returns this abandoned run).\n` +
          // issue #222 — the documented/advised abandon contract: unconditional, same wording as
          // the abandon_run MCP tool's `note` field (abandon-run.ts).
          `abandon is a kill — declared finalizers (if any) did NOT run; 'abort' is the graceful path.`,
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
