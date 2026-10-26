// attempts command — prints the durable failed agent-attempt sidecar for a run (observability P3).
import chalk from 'chalk';
import { Command } from 'commander';
import type { FailedAttemptRecord, RunRecord } from '@sensigo/realm';
import {
  noteDeclaredStanding,
  noteRunManifest,
  printJsonByTable,
  valuesShownFor,
  valuesShownLine,
  valuesWithheldFor,
  valuesWithheldLine,
  withholdUnlessAccepted,
  writerCtx,
} from '../output/writer.js';
import type { ClassTable } from '@sensigo/realm';

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

/** #729 PR-3 (L-5): the attempts' class table — ids, codes, times and counts are facts; the
 *  validation summary and the submitted keys are diagnostic copies. */
const ATTEMPTS_JSON_TABLE: ClassTable = {
  records: {
    nested: {
      run_id: 'fact',
      workflow_id: 'fact',
      step_id: 'fact',
      ts: 'fact',
      error_code: 'fact',
      validation_error_summary: 'bounded',
      submitted_key_count: 'fact',
      submitted_keys: 'bounded',
      submitted_bytes: 'fact',
      trace_entry_count: 'fact',
      error_count: 'fact',
    },
  },
  capped: 'fact',
};

export const attemptsCommand = new Command('attempts')
  .description('Show failed agent-step validation attempts recorded for a run')
  .argument('<run-id>', 'ID of the run to inspect')
  .option('--json', 'Print the raw records as JSON instead of a table')
  .option(
    '--accept-partial-disclosure',
    "Print the attempts' stored values even when Realm cannot read every declared secret of the run (masked with what is known)",
  )
  .action(async (runId: string, opts: { json?: boolean; acceptPartialDisclosure?: boolean }) => {
    const {
      JsonFileStore,
      JsonWorkflowStore,
      FailedAttemptStore,
      getWorkflowForRun,
      moreOf,
      renderProblemsLines,
      WorkflowError,
    } = await import('@sensigo/realm');
    const runs = new JsonFileStore();
    const store = new FailedAttemptStore(runs.runsDirPath);
    try {
      // #729 PR-3 correction 3 (H-7''): the run's declared values are read as `inspect` reads them,
      // so its stored values are masked with them — and withheld under a failed or changed manifest
      // unless the flag is given. A run this store does not hold reads nothing.
      let run: RunRecord | undefined;
      try {
        run = await runs.get(runId);
      } catch (err) {
        // Correction 4 (I-4): a record this store holds and cannot read is a failed read — its
        // declared values could not be read, so the attempts' values are withheld as for a failed
        // manifest. Only "not found" reads nothing.
        if (!(err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND'))
          noteDeclaredStanding(`run ${runId}`, {
            declared: 'unknown',
            declaredCause: 'load_failed',
          });
      }
      if (run !== undefined) {
        const definition = await getWorkflowForRun(new JsonWorkflowStore(), run, {
          retryVerb: 'read the attempts again',
          verb: 'read the attempts',
          terminalOk: true,
        }).catch(() => undefined);
        await noteRunManifest(definition, run);
      }
      withholdUnlessAccepted(opts.acceptPartialDisclosure === true);
      const { records, capped } = await store.read(runId);
      // Correction 4 (I-5, I-6): the first line only when there are attempts to show — that they are
      // withheld, or shown on the flag where they would have been.
      if (records.length > 0) {
        const withheld = valuesWithheldFor();
        const shown = valuesShownFor();
        if (withheld !== undefined) console.error(valuesWithheldLine(withheld));
        else if (shown !== undefined) console.error(valuesShownLine(shown));
      }

      if (opts.json === true) {
        // #729 PR-3 (L-5): built by table, printed as one data span.
        printJsonByTable({ records, capped }, ATTEMPTS_JSON_TABLE);
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
        // H-7'': a stored validation summary goes through the value span (its shape when withheld).
        for (const line of lines) console.log(`    ${writerCtx().value(line)}`);
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
