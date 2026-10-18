// abandon command — explicitly abandons a non-terminal run via the shared core primitive.
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import type { DefinitionAbsent, RunRecord } from '@sensigo/realm';
import { cliCommandOf } from './ways-renderer.js';

/**
 * #819 (U1): the one read before the seal, for a run waiting on a question — whether its workflow
 * can be read, and, when its copy cannot be, why (core's `definitionAbsenceOf`), with the folder the
 * copy records it was registered from (`source_dir`) when that folder is gone. It only relaxes the
 * refusal: any failure of its own reads nothing (`undefined`), and the kill goes on as before.
 */
async function absenceBeforeSeal(run: RunRecord): Promise<DefinitionAbsent | undefined> {
  try {
    const { JsonWorkflowStore, definitionAbsenceOf, getWorkflowForRun } =
      await import('@sensigo/realm');
    try {
      await getWorkflowForRun(new JsonWorkflowStore(), run, {
        retryVerb: 'abandon again',
        verb: 'abandon',
      });
      return undefined;
    } catch (err) {
      const absence = definitionAbsenceOf(err, run);
      if (absence === undefined) return undefined;
      const source = recordedSource(absence.path);
      return source !== undefined && !existsSync(source)
        ? { ...absence, source_gone: source }
        : absence;
    }
  } catch {
    return undefined;
  }
}

/** The folder a registered copy records it was registered from, when the copy is a JSON object
 *  that records one. */
function recordedSource(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try {
    const copy = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) return undefined;
    const dir = (copy as Record<string, unknown>)['source_dir'];
    return typeof dir === 'string' && dir !== '' ? dir : undefined;
  } catch {
    return undefined;
  }
}

export const abandonCommand = new Command('abandon')
  .description('Abandon a non-terminal run (marks it terminal with phase "abandoned")')
  .argument('<run-id>', 'ID of the run to abandon')
  .option('--reason <text>', 'Human-readable reason recorded as terminal_reason')
  .option(
    '--gate <gate_id>',
    'End a run waiting on this gate whose question can never be answered: its workflow was created by an agent and its copy is gone, or its copy cannot be read and the folder it was registered from is gone',
  )
  .action(async (runId: string, opts: { reason?: string; gate?: string }) => {
    const {
      JsonFileStore,
      JsonWorkflowStore,
      abandonRun,
      WorkflowError,
      ABANDON_KILL_ADVISORY,
      shellWord,
      withFullStop,
    } = await import('@sensigo/realm');
    const runStore = new JsonFileStore();
    try {
      // issue #367: read first, so the output can say whether THIS call changed anything —
      // abandoning an already-abandoned run is an idempotent no-op and used to print exactly the
      // same line as a real kill.
      const before = await runStore.get(runId);
      const alreadyAbandoned = before.abandoned_at !== undefined;
      // #819 (U1): at a live question, the one read before the seal — whether it can ever be
      // answered; core decides, and only for the gate `--gate` names.
      const live =
        !before.terminal_state &&
        before.abandoned_at === undefined &&
        before.pending_gate !== undefined;
      const absence = live ? await absenceBeforeSeal(before) : undefined;
      // issue #558 PR-C: the reason names THIS surface's verb. Core's neutral default
      // ('Abandoned') would leave a CLI kill unattributed; the MCP tool supplies its own.
      const run = await abandonRun(
        runStore,
        runId,
        opts.reason ?? 'Abandoned via realm run abandon',
        {
          ...(opts.gate !== undefined ? { gate: opts.gate } : {}),
          ...(absence !== undefined ? { absence } : {}),
        },
      );
      // issue #558 PR-C (walk 2): the rerun command must be executable from THIS screen. The
      // registered copy records the directory it was registered from (`source_dir`, since v0.14);
      // `realm workflow run` takes a directory. Read it AFTER the seal — the kill never depends on
      // the copy (PR-T's point) — and fall back to the honest blank when the copy is absent,
      // unreadable, or predates the stamp.
      // walk 3: `realm workflow run` never prompts for params (`--params` defaults to `{}`), so a
      // workflow that requires them refuses the printed command. The record carries this run's
      // params verbatim — print them, shell-quoted, so the command starts a run AS PRINTED.
      const paramsClause =
        Object.keys(run.params).length > 0
          ? ` --params ${shellWord(JSON.stringify(run.params))}`
          : '';
      let runAgain = `realm workflow run <the workflow.yaml you registered '${run.workflow_id}' from>${paramsClause}`;
      try {
        const copy = await new JsonWorkflowStore().get(run.workflow_id);
        if (copy.source_dir !== undefined) {
          runAgain = `realm workflow run ${shellWord(copy.source_dir)}${paramsClause} (the directory it was registered from)`;
        }
      } catch {
        // the blank form above is the honest sentence for a copy realm cannot read
      }
      console.log(
        `Run '${runId}' abandoned (phase: '${run.run_phase}').` +
          (alreadyAbandoned ? ' Already abandoned (no change this call).' : '') +
          // E1 (decision C37): one mark after the reason; no clause when the record carries none,
          // as `realm run inspect` prints `Cause:` only then.
          (run.terminal_reason !== undefined
            ? ` Reason: ${withFullStop(run.terminal_reason)}`
            : '') +
          '\n' +
          // issue #558 PR-C: the rerun path a CLI operator can actually execute. `start_run` is an
          // MCP tool — naming it here handed a CLI operator a command that does not exist.
          `To run the same work again: ${runAgain} — a fresh run; this run's evidence stays at realm run inspect ${runId}.\n` +
          // issue #222 — the documented/advised abandon contract, minted ONCE in core
          // (`ABANDON_KILL_ADVISORY`) and shared byte-identically with the abandon_run MCP tool's
          // `note`. There is no operator `abort` verb (issue #558 PR-C).
          ABANDON_KILL_ADVISORY,
      );
    } catch (err) {
      // issue #558 PR-C: core's gate refusal is surface-neutral. #729 PR-0 (Table row 39): its way
      // on is the error's typed remedy (the open question's `respond` way), which THIS surface renders
      // through the CLI's one renderer — no command is read out of `details`. C212: the command ends
      // the line, with no stop after it.
      if (err instanceof WorkflowError && err.code === 'STATE_TRANSITION_DENIED') {
        // #819 (U1): a question that can never be answered names the gate-named abandon; one whose
        // workflow cannot be read yet names its repair; any other names its answer.
        const way = (err.remedy ?? []).find(
          (w) => w.verb === 'abandon' || w.verb === 'register' || w.verb === 'respond',
        );
        const lead =
          way?.verb === 'abandon'
            ? 'To end it'
            : way?.verb === 'register'
              ? 'Repair it'
              : 'Answer it';
        if (way !== undefined) {
          console.error(`${err.message} ${lead}: ${cliCommandOf(way)}`);
          process.exit(1);
          return;
        }
      }
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
