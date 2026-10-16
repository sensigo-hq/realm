// attempts command — prints the durable failed agent-attempt sidecar for a run (observability P3).
import chalk from 'chalk';
import { Command } from 'commander';
import type { FailedAttemptRecord } from '@sensigo/realm';

/** The two core renderers this command needs, loaded lazily with the rest of core (see the test's
 *  header for the idiom). */
type Renderers = Pick<typeof import('@sensigo/realm'), 'moreOf' | 'renderProblemsLines'>;

/**
 * issue #759: a record's problems — the count on the row (`13 problems`; a FLOOR for a record written
 * by 0.47.0 or earlier, whose validator stopped at the first problem — `≥1 problem`, `≥3 problems`,
 * the `≥N×` convention of `realm run list`), then every entry it holds as LINES and `and N more` as
 * read (`error_count − entries`) — never an invented count.
 */
function summarize(rec: FailedAttemptRecord, core: Renderers): { label: string; lines: string[] } {
  const entries = Array.isArray(rec.validation_error_summary) ? rec.validation_error_summary : [];
  const more = core.moreOf(rec);
  const total = entries.length + (more ?? 0);
  if (total === 0) return { label: '', lines: [] };
  const counted = (n: number): string => `${n} ${n === 1 ? 'problem' : 'problems'}`;
  const label = more === undefined ? `≥${counted(entries.length)}` : counted(total);
  return { label, lines: core.renderProblemsLines(entries, more ?? 0) };
}

export const attemptsCommand = new Command('attempts')
  .description('Show failed agent-step validation attempts recorded for a run')
  .argument('<run-id>', 'ID of the run to inspect')
  .option('--json', 'Print the raw records as JSON instead of a table')
  .action(async (runId: string, opts: { json?: boolean }) => {
    const { JsonFileStore, FailedAttemptStore, moreOf, renderProblemsLines } =
      await import('@sensigo/realm');
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
        const { label, lines } = summarize(rec, { moreOf, renderProblemsLines });
        console.log(
          `${chalk.dim(ts)}  ${chalk.bold(rec.step_id)}  ${chalk.red(rec.error_code)}  ` +
            `${keyCount} key(s)${label !== '' ? `  ${label}` : ''}`,
        );
        for (const line of lines) console.log(`    ${line}`);
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
