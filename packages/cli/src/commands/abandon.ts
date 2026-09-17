// abandon command — explicitly abandons a non-terminal run via the shared core primitive.
import { Command } from 'commander';

export const abandonCommand = new Command('abandon')
  .description('Abandon a non-terminal run (marks it terminal with phase "abandoned")')
  .argument('<run-id>', 'ID of the run to abandon')
  .option('--reason <text>', 'Human-readable reason recorded as terminal_reason')
  .action(async (runId: string, opts: { reason?: string }) => {
    const { JsonFileStore, JsonWorkflowStore, abandonRun, WorkflowError, ABANDON_KILL_ADVISORY } =
      await import('@sensigo/realm');
    const runStore = new JsonFileStore();
    try {
      // issue #367: read first, so the output can say whether THIS call changed anything —
      // abandoning an already-abandoned run is an idempotent no-op and used to print exactly the
      // same line as a real kill.
      const before = await runStore.get(runId);
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
          ? ` --params '${JSON.stringify(run.params).replace(/'/g, "'\\''")}'`
          : '';
      let runAgain = `realm workflow run <the workflow.yaml you registered '${run.workflow_id}' from>${paramsClause}`;
      try {
        const copy = await new JsonWorkflowStore().get(run.workflow_id);
        if (copy.source_dir !== undefined) {
          runAgain = `realm workflow run ${copy.source_dir}${paramsClause} (the directory it was registered from)`;
        }
      } catch {
        // the blank form above is the honest sentence for a copy realm cannot read
      }
      console.log(
        `Run '${runId}' abandoned (phase: '${run.run_phase}').` +
          (alreadyAbandoned ? ' Already abandoned (no change this call).' : '') +
          ` Reason: ${run.terminal_reason}.\n` +
          // issue #558 PR-C: the rerun path a CLI operator can actually execute. `start_run` is an
          // MCP tool — naming it here handed a CLI operator a command that does not exist.
          `To run the same work again: ${runAgain} — a fresh run; this run's evidence stays at realm run inspect ${runId}.\n` +
          // issue #222 — the documented/advised abandon contract, minted ONCE in core
          // (`ABANDON_KILL_ADVISORY`) and shared byte-identically with the abandon_run MCP tool's
          // `note`. There is no operator `abort` verb (issue #558 PR-C).
          ABANDON_KILL_ADVISORY,
      );
    } catch (err) {
      // issue #558 PR-C: core's gate refusal is surface-neutral and carries the gate in `details`;
      // THIS surface appends the command a CLI operator can run. `instanceof` narrowing, never a
      // duck-typed cast.
      if (
        err instanceof WorkflowError &&
        err.code === 'STATE_TRANSITION_DENIED' &&
        typeof err.details['gate_id'] === 'string'
      ) {
        const gateId = err.details['gate_id'];
        const rawChoices = err.details['choices'];
        const choices = Array.isArray(rawChoices)
          ? rawChoices.filter((c): c is string => typeof c === 'string')
          : [];
        console.error(
          `${err.message} Answer it: realm run respond ${runId} --gate ${gateId} --choice <one of: ${choices.join(', ')}>.`,
        );
        process.exit(1);
        return;
      }
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
