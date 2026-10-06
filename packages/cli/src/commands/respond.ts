// respond command — submits a human gate response for a gate-waiting run.
import { Command } from 'commander';
import type { RunStore } from '@sensigo/realm';
import type { WorkflowRegistrar } from '@sensigo/realm';
import type { ExtensionRegistry, Attributed } from '@sensigo/realm';
import {
  WorkflowError,
  boundStatedName,
  identityRefusalLine,
  submitHumanResponse,
  getWorkflowForRun,
  describeAnswerEnding,
  describeEndedBy,
  lateAnswerOutcome,
  deriveRunPhase,
  describePending,
  owedList,
  owedWords,
  cannotGoOnLines,
} from '@sensigo/realm';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';
import { resolveProgramIdentity } from '../lib/program-identity.js';
import {
  agentReadyReason,
  laterAdvanceCodeWhere,
  projectNotUsedLine,
  PROJECT_OPTION_HELP,
} from './run-advance.js';

/**
 * issue #625: the last line for an answer the gate's expiry beat — never `Responded:`. The choice
 * and the phase come from the run record (`lateAnswerOutcome`), never from the reply's text.
 */
function notRecordedLine(runId: string, late: { choice: string; phase: string }): string {
  return `Not recorded: ${runId} | gate settled by timeout with choice '${late.choice}' | state '${late.phase}'`;
}

/** What `respondToGate` hands the command to print (issue #625). */
export interface RespondOutcome {
  choice: string;
  newState: string;
  /**
   * `false` when the gate's expiry had already settled it, so this answer was NOT recorded even
   * though the call succeeded (its choice matched the one the expiry enacted). The command then
   * prints `Not recorded:` as its last line, never `Responded:`.
   */
  recorded: boolean;
  /**
   * What the answer's write settled, one line each, printed BEFORE the last line: the guard that
   * ended the run (its sentence, `Reason:`, each finalizer's outcome), or one passed line per
   * guard; for a late answer the expiry sentence comes first. Empty when the write settled no
   * guard and the answer was recorded.
   */
  lines: string[];
  /** The last line to print: `Responded: …` or `Not recorded: …`. */
  lastLine: string;
}

/**
 * Submits a human choice response for a gate-waiting run.
 * @param runId         The run awaiting a gate response.
 * @param options       `gate` is the gate_id; `choice` is the selected option.
 * @param runStore      Store holding run records.
 * @param workflowStore Registrar for workflow definitions.
 * @param registry      Project registry (the command passes the one it resolved).
 * @param driver        The program making this call (issue #625) — named on the cleanup steps the
 *                      answer drains, never as the answerer.
 * @returns The choice submitted, the new run state after the gate advances, and the lines the
 *          command prints (issue #625). A refused answer THROWS; its message is every line the
 *          command prints on stderr, one per line.
 */
export async function respondToGate(
  runId: string,
  options: {
    gate: string;
    choice: string;
    project?: string;
    extensionsModule?: string;
    /** Who made the choice, as the caller states it (issue #625) — recorded as `responded_by`. */
    by?: string;
  },
  runStore: RunStore,
  workflowStore: WorkflowRegistrar,
  registry?: ExtensionRegistry,
  driver?: Attributed,
): Promise<RespondOutcome> {
  const run = await runStore.get(runId);
  // issue #456: code-keyed one-time-register remedy, shared with every other run-context site.
  const workflow = await getWorkflowForRun(workflowStore, run, {
    retryVerb: 'respond again',
    verb: 'respond',
  });

  // Resolve the project registry (unless a caller/test injected one) so that resolving a gate
  // which COMPLETES the run fires its finalizers with project handlers — consistent with
  // `realm run`. Same options/cwd handling as run.ts; reuses loadProjectExtensions so the
  // orphan-manifest topology guard is honoured (no hand-rolled registry).
  // Production always passes `registry` now (issue #466's action hoist) — this fallback is the
  // test/direct-caller seam, kept for callers that resolve their own (none in production today).
  const effectiveRegistry =
    registry ??
    (
      await loadProjectExtensions(workflow, {
        ...(options.extensionsModule !== undefined
          ? { overrideModule: options.extensionsModule }
          : {}),
        projectDir: options.project ?? process.cwd(),
      })
    ).registry;

  const result = await submitHumanResponse(runStore, workflow, {
    runId,
    gateId: options.gate,
    choice: options.choice,
    registry: effectiveRegistry,
    // issue #625: a PERSON's name is never derived (an OS account and REALM_OPERATOR name a
    // PROGRAM): the answer names its answerer only when `--by` is given. No `claimToken` — the
    // CLI never passes one, by design.
    ...(options.by !== undefined ? { respondedBy: options.by } : {}),
    ...(driver !== undefined ? { driver } : {}),
  });

  if (result.status !== 'ok') {
    // issue #625: a refusal says everything the refused answer's own call did. A late answer on a
    // gate whose expiry settled a choice enacts that expiry itself, and the expiry's write may
    // have settled guards — passed, or ended the run. A person who wanted the other choice must
    // learn what the run is doing now: refusal → guard lines → `Not recorded:`. Every other
    // refusal prints exactly what it printed before (plus the ending, should the reply carry one).
    const refusal = result.errors[0] ?? 'Gate response failed';
    let lines = [refusal, ...describeEndedBy(result)];
    if (result.answer_recorded === false) {
      const lateRun = await runStore.get(runId);
      const late = lateAnswerOutcome(result, lateRun);
      if (late !== undefined) {
        lines = [...describeAnswerEnding(result, lateRun), notRecordedLine(runId, late)];
      }
    }
    throw new WorkflowError(lines.join('\n'), {
      code: 'STATE_BLOCKED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  const updatedRun = await runStore.get(runId);
  const lines = describeAnswerEnding(result, updatedRun);
  // issue #625: an `ok` reply is not always a recorded answer — when the gate's expiry had
  // already settled it with the same choice, the call succeeds and the answer was NOT recorded.
  // The typed fact decides the last line; the reply's prose is never matched.
  const late = lateAnswerOutcome(result, updatedRun);
  if (late !== undefined) {
    return {
      choice: options.choice,
      newState: late.phase,
      recorded: false,
      lines,
      lastLine: notRecordedLine(runId, late),
    };
  }
  // issue #625 PR-2a (decision C11): the recorded answerer when `--by` was given, the DERIVED
  // phase, and — when the answer left engine work owed — the one command that runs it, with where
  // its project code comes from and that its environment is its shell's (decision C98); when it
  // left an agent step ready, the same ready line `realm run advance` prints (decision C96).
  const phase = deriveRunPhase(updatedRun);
  const answeredBy = options.by !== undefined ? ` | answered by ${options.by} (as stated)` : '';
  const pending = describePending(workflow, updatedRun, effectiveRegistry, new Date());
  // decisions C62, C64: when the answer leaves nothing that can run from here, each engine step
  // that cannot run and the way out — core's lines, never a copy.
  const cannotGoOn = cannotGoOnLines(updatedRun, pending);
  const ready = agentReadyReason(runId, pending.agent_steps);
  // decision C107: whether the project the later advance loads holds any code — the registry this
  // answer loaded from it carries a code identity only when a realm.yaml or a module was found.
  const hasCode =
    options.extensionsModule !== undefined || effectiveRegistry.identity !== undefined;
  return {
    choice: options.choice,
    newState: phase,
    recorded: true,
    lines,
    lastLine:
      `Responded: ${runId} | choice '${options.choice}'${answeredBy} | new state '${phase}'` +
      (pending.act !== undefined
        ? `\nOwed to the engine: ${owedList(pending)} — realm run advance ${runId} runs ${owedWords(pending).them}, with ${laterAdvanceCodeWhere(workflow, hasCode)}, in the environment of the shell it runs in.`
        : '') +
      (ready !== undefined ? `\n${ready.charAt(0).toUpperCase()}${ready.slice(1)}.` : '') +
      cannotGoOn.map((line) => `\n${line}`).join(''),
  };
}

export const respondCommand = new Command('respond')
  .description('Submit a human gate response to advance a gate-waiting run')
  .argument('<run-id>', 'ID of the run waiting at a gate')
  .requiredOption('--gate <gate-id>', 'Gate ID from the confirm_required response')
  .requiredOption('--choice <choice>', 'The choice to submit (e.g. approve, reject)')
  .option('--project <dir>', PROJECT_OPTION_HELP)
  .option(
    '--extensions-module <path>',
    "CODE override: module that REPLACES the workflow's declared 'extensions' modules (repair tool)",
  )
  .option(
    '--by <name>',
    'Who made the choice, as you state it — recorded with the answer, not verified. At most 200 ' +
      'characters, no control characters. Optional: the answer names its answerer only when this is given.',
  )
  .action(
    async (
      runId: string,
      opts: {
        gate: string;
        choice: string;
        project?: string;
        extensionsModule?: string;
        by?: string;
      },
    ) => {
      // issue #625 (holder slice): both names are checked at the START, before the run is read, and
      // a name that cannot be used prints ONE line and exits 1 with nothing recorded.
      // The checked name (spaces at either end removed) is what is passed on and stored.
      let by: string | undefined;
      if (opts.by !== undefined) {
        try {
          by = boundStatedName(opts.by, '--by');
        } catch (err) {
          console.error(identityRefusalLine('--by', err, 'nothing was recorded'));
          process.exit(1);
          return;
        }
      }
      // `REALM_OPERATOR` here names the PROGRAM on the cleanup steps this answer drains — never
      // the person who answered; the answer itself never carries it. It is checked before the run
      // is read, so it refuses on a workflow with no cleanup steps too — the refusal says both, so
      // its sentence is true for every workflow.
      const driver = resolveProgramIdentity(
        'respond',
        "it is written as the program's name on any cleanup steps the answer lets run, and respond checks it before reading the run, so nothing was recorded",
      );
      const { JsonFileStore, JsonWorkflowStore } = await import('@sensigo/realm');
      const runStore = new JsonFileStore();
      const workflowStore = new JsonWorkflowStore();
      try {
        // issue #466 — the run/workflow fetches stay OUTSIDE the sentence-try: a bad run-id is
        // respond's most common operator error, and it must never wear the extensions sentence
        // (the naked catch below is its home, #477). Only the extension resolution itself is
        // wrapped, in place, mirroring run.ts's exact arm.
        const run = await runStore.get(runId);
        // issue #456: code-keyed one-time-register remedy, shared with every other run-context
        // site.
        const workflow = await getWorkflowForRun(workflowStore, run, {
          retryVerb: 'respond again',
          verb: 'respond',
        });
        let registry: ExtensionRegistry;
        try {
          ({ registry } = await loadProjectExtensions(workflow, {
            ...(opts.extensionsModule !== undefined
              ? { overrideModule: opts.extensionsModule }
              : {}),
            projectDir: opts.project ?? process.cwd(),
          }));
        } catch (err) {
          console.error(
            `Error loading extensions: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
          return;
        }
        // decisions C108, C121: a `--project` the workflow's own project overrides is said, first —
        // with whether that project holds code (the registry loaded from it carries a code identity
        // only when a realm.yaml or a module was found).
        const notUsed = projectNotUsedLine(
          workflow,
          opts,
          opts.extensionsModule !== undefined || registry.identity !== undefined,
        );
        if (notUsed !== undefined) console.log(notUsed);
        const { by: _rawBy, ...rest } = opts;
        const outcome = await respondToGate(
          runId,
          { ...rest, ...(by !== undefined ? { by } : {}) },
          runStore,
          workflowStore,
          registry,
          driver,
        );
        // issue #625: what the answer's write settled is said FIRST — the guard that ended the
        // run (with its reason and each finalizer's outcome), or each guard that passed — then
        // the one line that says whether the answer was recorded. Exit 0: the call succeeded.
        for (const line of outcome.lines) console.log(line);
        console.log(outcome.lastLine);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    },
  );
