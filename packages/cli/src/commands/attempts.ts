// attempts command — prints the durable failed agent-attempt sidecar for a run (observability P3).
import chalk from 'chalk';
import { Command } from 'commander';
import type { FailedAttemptRecord } from '@sensigo/realm';

/** One-line validation summary: "<keyword> <instancePath>" of the first entry, plus a +N suffix. */
function summarize(rec: FailedAttemptRecord): string {
  const entries = Array.isArray(rec.validation_error_summary) ? rec.validation_error_summary : [];
  if (entries.length === 0) return '';
  const first = entries[0]!;
  const head = `${first.keyword}${first.instancePath ? ` ${first.instancePath}` : ''}`.trim();
  return entries.length > 1 ? `${head} (+${entries.length - 1} more)` : head;
}

export const attemptsCommand = new Command('attempts')
  .description('Show failed agent-step validation attempts recorded for a run')
  .argument('<run-id>', 'ID of the run to inspect')
  .option('--json', 'Print the raw records as JSON instead of a table')
  .action(async (runId: string, opts: { json?: boolean }) => {
    const { JsonFileStore, FailedAttemptStore } = await import('@sensigo/realm');
    const store = new FailedAttemptStore(new JsonFileStore().runsDirPath);
    try {
      const { records, capped } = await store.read(runId);

      if (opts.json === true) {
        console.log(JSON.stringify({ records, capped }, null, 2));
        return;
      }

      if (records.length === 0) {
        console.log(`No failed attempts recorded for run ${runId}.`);
        if (capped) {
          console.log(
            chalk.yellow(
              'Note: the attempts sidecar reached its size ceiling; later attempts were dropped.',
            ),
          );
        }
        return;
      }

      console.log(`Failed attempts for run ${chalk.bold(runId)} (${records.length}):\n`);
      for (const rec of records) {
        const ts = typeof rec.ts === 'string' ? rec.ts : '';
        const keyCount = typeof rec.submitted_key_count === 'number' ? rec.submitted_key_count : 0;
        console.log(
          `${chalk.dim(ts)}  ${chalk.bold(rec.step_id)}  ${chalk.red(rec.error_code)}  ` +
            `${keyCount} key(s)  ${summarize(rec)}`,
        );
      }
      if (capped) {
        console.log(
          '\n' +
            chalk.yellow(
              'Note: the attempts sidecar reached its size ceiling; later attempts were dropped (append-and-stop keeps the first N).',
            ),
        );
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
