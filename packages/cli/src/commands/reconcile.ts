// reconcile command — builds the idempotency-key pointer index from existing run records.
// Lets operators front-load the index (e.g. pausing the producer) so no lazy O(n) fallback
// hits occur at runtime. Skipping it is safe: the store self-migrates lazily on first touch.
import { Command } from 'commander';

export const reconcileCommand = new Command('reconcile')
  .description('Build the idempotency-key pointer index from existing runs')
  .option('--workflow <id>', 'Reconcile only runs of this workflow')
  .option('--dry-run', 'Report what would be written without writing anything')
  .action(async (opts: { workflow?: string; dryRun?: boolean }) => {
    const { JsonFileStore } = await import('@sensigo/realm');
    const store = new JsonFileStore();
    try {
      const summary = await store.reconcileKeys(opts.workflow, opts.dryRun ?? false);
      const verb = summary.dryRun ? 'Would write' : 'Wrote';
      console.log(
        `${verb} ${summary.keysWritten} pointer(s) across ${summary.groups} key group(s); ${summary.keysUnchanged} already current.`,
      );
      if (summary.duplicateGroups.length > 0) {
        console.log(`Duplicate-key groups: ${summary.duplicateGroups.length}`);
        for (const g of summary.duplicateGroups) {
          console.log(
            `  - workflow '${g.workflow_id}' → canonical ${g.canonical_run_id}; other runs: ${g.other_run_ids.join(', ')}`,
          );
        }
      }
      if (summary.multipleLiveGroups.length > 0) {
        console.log(
          `WARNING: ${summary.multipleLiveGroups.length} key group(s) have more than one live run (data-integrity finding):`,
        );
        for (const g of summary.multipleLiveGroups) {
          console.log(
            `  - workflow '${g.workflow_id}' → canonical ${g.canonical_run_id}; extra live runs: ${g.extra_live_run_ids.join(', ')}`,
          );
        }
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
