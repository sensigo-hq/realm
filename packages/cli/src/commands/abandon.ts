// abandon command — explicitly abandons a non-terminal run via the shared core primitive.
import { Command } from 'commander';
import type { RunRecord } from '@sensigo/realm';
import { cliCommandOf } from './ways-renderer.js';

/**
 * #819 correction 1 (02 C2): an empty or blank `--reason` is refused. #819 follow-up 2 (R1, the
 * audit's S5): in the words of `realm run respond --by ""`'s refusal (`holder.ts`'s
 * `identityRefusalLine`), with no claim about the run — at a gate, for a run that does not exist and
 * for one already abandoned, a reason alone changes nothing. A second rule beside `holder.ts:133`
 * (04 §3's exception; #604 adds the reason kind to that helper).
 */
export function emptyReasonRefusal(): string {
  return "--reason: empty; nothing was recorded. Give a reason, or leave it out: the default reason is 'Abandoned via realm run abandon'.";
}

/**
 * #819 correction 1 (01): the way on from a run whose question is open but whose workflow cannot be
 * read — the one read, made only after core refused the kill. #819 follow-up 2 (R2): worded by core's
 * one composer (`gateRepairOf`): the copy's repair act, never `rm` and never `validate`; a copy an
 * older or a later Realm registered gets its own remedy. `undefined` only when the workflow reads:
 * the refusal then names the answer.
 */
async function repairOf(run: RunRecord): Promise<string | undefined> {
  const { JsonWorkflowStore, getWorkflowForRun, gateRepairOf } = await import('@sensigo/realm');
  try {
    await getWorkflowForRun(new JsonWorkflowStore(), run, {
      retryVerb: 'answer the gate',
      verb: 'abandon',
    });
    return undefined;
  } catch (err) {
    return gateRepairOf(err);
  }
}

export const abandonCommand = new Command('abandon')
  .description('Abandon a non-terminal run (marks it terminal with phase "abandoned")')
  .argument('<run-id>', 'ID of the run to abandon')
  .option('--reason <text>', 'Human-readable reason recorded as terminal_reason')
  .action(async (runId: string, opts: { reason?: string }) => {
    const {
      JsonFileStore,
      JsonWorkflowStore,
      abandonRun,
      WorkflowError,
      ABANDON_KILL_ADVISORY,
      shellWord,
      withFullStop,
    } = await import('@sensigo/realm');
    if (opts.reason !== undefined && opts.reason.trim() === '') {
      console.error(emptyReasonRefusal());
      process.exit(1);
      return;
    }
    const runStore = new JsonFileStore();
    let before: RunRecord | undefined;
    try {
      // issue #367: read first, so the output can say whether THIS call changed anything —
      // abandoning an already-abandoned run is an idempotent no-op and used to print exactly the
      // same line as a real kill.
      before = await runStore.get(runId);
      const alreadyAbandoned = before.abandoned_at !== undefined;
      // issue #558 PR-C: the reason names THIS surface's verb. Core's neutral default
      // ('Abandoned') would leave a CLI kill unattributed; the MCP tool supplies its own.
      const run = await abandonRun(
        runStore,
        runId,
        opts.reason ?? 'Abandoned via realm run abandon',
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
        const answer = (err.remedy ?? []).find((w) => w.verb === 'respond');
        if (answer !== undefined) {
          // #819 correction 1 (01): the answer waits on a workflow that cannot be read — then the
          // way on is its repair, read once here (the record is not touched: core refused). #819
          // follow-up 2 (R2): once the read has failed, the answer is never offered.
          const repair = before !== undefined ? await repairOf(before) : undefined;
          console.error(
            repair !== undefined
              ? `${err.message} ${repair}`
              : `${err.message} Answer it: ${cliCommandOf(answer)}`,
          );
          process.exit(1);
          return;
        }
      }
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
