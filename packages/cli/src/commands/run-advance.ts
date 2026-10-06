// run advance command — runs the guards and automatic steps a run owes, from this shell (issue #625 PR-2a).
import { Command } from 'commander';
import type {
  RunStore,
  RunRecord,
  WorkflowRegistrar,
  ExtensionRegistry,
  Attributed,
} from '@sensigo/realm';
import {
  advanceRun,
  describePending,
  stepsThatCannotRun,
  describeRunDriver,
  judgeProgramFit,
  owedList,
  getWorkflowForRun,
  deriveRunPhase,
  describeEndedBy,
  describeClaimHolder,
  guardPassedLine,
  guardEndingOfRun,
  cannotRunClause,
  cannotRunWayOut,
  cannotRunWayOutApplies,
  withFullStop,
  type PendingView,
  type ProgramFit,
} from '@sensigo/realm';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';
import { resolveProgramIdentity } from '../lib/program-identity.js';
import { BY_SOURCE_WORDS, describeProgram, takenLine, takenPhrase } from '../lib/holder-render.js';

/** How the project code of this program compares with the run's last record, in words. */
export const FIT_WORDS: Record<ProgramFit, string> = {
  same: "same as the run's last record",
  differs: "differs from the run's last record",
  not_comparable: "not comparable with the run's last record",
  none: 'neither side records project code',
};

/**
 * The fit words for the preview. `not_comparable` on a run that has recorded no project code yet
 * says why (decision C56): a fresh run from the same project is not a mismatch. Otherwise
 * {@link FIT_WORDS}.
 */
export function fitWords(fit: ProgramFit, run: Pick<RunRecord, 'extension_identity'>): string {
  if (fit === 'not_comparable' && run.extension_identity?.at(-1) === undefined) {
    return 'not comparable — the run has recorded no project code yet';
  }
  return FIT_WORDS[fit];
}

/** `<by> (<class words>)` — this program's name in the house words. */
function identityWords(driver: Attributed | undefined): string {
  return driver === undefined
    ? 'no name could be recorded'
    : `${driver.by} (${BY_SOURCE_WORDS[driver.by_source]})`;
}

/** The last recorded driver, in words (D8). */
function driverWords(
  run: Parameters<typeof describeRunDriver>[0],
  workflow: Parameters<typeof describeRunDriver>[1],
): string {
  const d = describeRunDriver(run, workflow);
  if (d.driver.by === null) return 'none recorded';
  const n = d.newer_without_driver;
  const newer =
    n === 1
      ? '; 1 newer entry records no driver'
      : n > 1
        ? `; ${n} newer entries record no driver`
        : '';
  return `${describeProgram(d.driver)} at step '${d.step}', ${d.at}${newer}`;
}

type RunForReasons = Parameters<typeof deriveRunPhase>[0] &
  Pick<RunRecord, 'in_progress_steps' | 'claims'>;

/** The steps in flight (the open gate's own step holds a claim while it waits and is not in flight). */
function inFlightSteps(run: RunForReasons): string[] {
  return run.in_progress_steps.filter((step) => step !== run.pending_gate?.step_name);
}

/**
 * The steps in flight elsewhere, each as `'<s>', <taken phrase>[ since <since>]` (decision C37) —
 * the preview's `In flight:` line, the one place the holder and the time are printed (decision C43).
 */
export function inFlightItems(run: RunForReasons, keepsClaims: boolean): string[] {
  return inFlightSteps(run).map((step) => {
    const described = describeClaimHolder(run.claims?.[step], keepsClaims);
    const since = described.since !== undefined ? ` since ${described.since}` : '';
    return `'${step}' is in flight, ${takenPhrase(described)}${since}`;
  });
}

/**
 * Every reason that holds for the run to stop where it is, in D4.4's order (a failed step is the
 * caller's to add, first): the run ended · a question is open · each step that cannot run · agent
 * steps ready · each step in flight elsewhere, with what to do (decision C43; the holder and the
 * time are on the preview's `In flight:` line) · and, when none of these holds, `nothing is ready
 * to run now`.
 */
export function stoppedReasons(runId: string, run: RunForReasons, pending: PendingView): string[] {
  if (run.terminal_state) return [`the run has ended (${deriveRunPhase(run)})`];
  const gate = run.pending_gate;
  if (gate !== undefined) {
    return [
      `a question is open — realm run respond ${runId} --gate ${gate.gate_id} --choice <one of: ${gate.choices.join(', ')}>`,
    ];
  }
  const reasons = stepsThatCannotRun(pending).map((e) => cannotRunClause(e));
  if (pending.agent_steps.length > 0) {
    // decisions C55, C59: the subject and the count word agree with how many agent steps are ready.
    const ready =
      pending.agent_steps.length === 1
        ? `an agent step is ready: '${pending.agent_steps[0]}' — drive it`
        : `agent steps are ready: ${pending.agent_steps.map((s) => `'${s}'`).join(', ')} — drive them`;
    // decision C89: the drive command a person can run as printed — since #676 `realm agent` refuses
    // to start without a model, so the line carries the placeholders the other printers use
    // (run-agent.ts's re-attach line, resume.ts, run.ts's detach map).
    reasons.push(
      `${ready} with realm agent --run-id ${runId} --provider <provider> --model <model>`,
    );
  }
  reasons.push(
    ...inFlightSteps(run).map(
      (step) =>
        `'${step}' is in flight in another program — wait for it, or see realm run inspect ${runId}`,
    ),
  );
  return reasons.length > 0 ? reasons : ['nothing is ready to run now'];
}

/**
 * Whether the run still owes the engine work, though none of it can run now (decision C43): an
 * `auto` step the view refuses, or an `auto` step or guard in flight in another program. With no
 * act, every entry in `engine_runnable` is refused.
 */
function engineWorkOwed(
  run: RunForReasons,
  pending: PendingView,
  workflow: { steps: Record<string, { execution?: string } | undefined> },
): boolean {
  if (run.terminal_state || run.pending_gate !== undefined) return false;
  return (
    pending.engine_runnable.length > 0 ||
    pending.pending_guards.length > 0 ||
    inFlightSteps(run).some((step) => {
      const kind = workflow.steps[step]?.execution;
      return kind === 'auto' || kind === 'guard';
    })
  );
}

/** What `advanceRunCommand` returns to the action (and to tests). */
export interface AdvanceOutcome {
  lines: string[];
  exitCode: 0 | 1;
}

/**
 * Advances the run: prints the preview, runs what the engine owes, then says where it stopped.
 * Every line goes to stdout through `print` as it is produced (so `→ <step>` appears as it starts).
 */
export async function advanceRunFromShell(
  runId: string,
  opts: { project?: string; extensionsModule?: string },
  runStore: RunStore,
  workflowStore: WorkflowRegistrar,
  driver: Attributed | undefined,
  print: (line: string) => void,
  registryOverride?: ExtensionRegistry,
): Promise<0 | 1> {
  const run = await runStore.get(runId);
  const workflow = await getWorkflowForRun(workflowStore, run, {
    retryVerb: 'advance again',
    verb: 'advance',
  });
  const projectDir = opts.project ?? process.cwd();
  const registry =
    registryOverride ??
    (
      await loadProjectExtensions(workflow, {
        ...(opts.extensionsModule !== undefined ? { overrideModule: opts.extensionsModule } : {}),
        projectDir,
      })
    ).registry;

  const pending = describePending(workflow, run, registry);
  const keepsClaims = runStore.persistsClaims === true;
  print(`Advancing run ${runId} (workflow '${workflow.id}') from ${projectDir}.`);
  print(
    `This program: ${identityWords(driver)} · project code: ${fitWords(judgeProgramFit(run, registry.identity), run)}.`,
  );
  print(`Last recorded driver: ${driverWords(run, workflow)}.`);
  // decision C37: a step another process holds is named before anything runs — so a second program
  // is told why it may find nothing to run.
  const inFlight = run.terminal_state ? [] : inFlightItems(run, keepsClaims);
  if (inFlight.length > 0) print(`In flight: ${withFullStop(inFlight.join('; '))}`);
  if (pending.act === undefined) {
    // decision C43: "Nothing is owed" only when nothing is; owed work none of which can run now
    // opens with what the engine can do.
    const opening = engineWorkOwed(run, pending, workflow)
      ? 'The engine can run nothing now'
      : 'Nothing is owed to the engine';
    print(`${opening}: ${withFullStop(stoppedReasons(runId, run, pending).join('; '))}`);
    if (cannotRunWayOutApplies(run, pending)) print(cannotRunWayOut(run));
    // decision C23 with D4.4: a step that cannot run here (refused before its claim, or
    // capability-blocked) exits 1 whether or not anything else was owed — the same code as after a
    // call that ran other steps.
    return !run.terminal_state && stepsThatCannotRun(pending).length > 0 ? 1 : 0;
  }
  print(`Owed to the engine: ${owedList(pending)}.`);

  let lastStep: string | undefined;
  const result = await advanceRun(runStore, workflow, {
    runId,
    command: 'advance',
    registry,
    ...(driver !== undefined ? { driver } : {}),
    onStep: (step) => {
      lastStep = step;
      print(`→ ${step}`);
    },
    // D6.1: a step another process took is said as a past-tense fact — never "cannot run here".
    onTaken: (step, record) => {
      print(takenLine(step, describeClaimHolder(record.claims?.[step], keepsClaims)));
    },
  });

  // decision C28: PR-1's lines for the guards this call settled. A reply carrying `ended_by` (a
  // guard a step's own write settled) gives the ending and its reason. Otherwise one passed line
  // per guard the loop settled — and, for a guard that ended the run, the reply's sentence, then
  // PR-1's `Reason:` line read off the record the call left (the loop's own guard replies carry no
  // `ended_by`).
  const endingLines = describeEndedBy(result);
  const chainedGuards = (result.chained_auto_steps ?? [])
    .map((c) => c.step)
    .filter((step) => workflow.steps[step]?.execution === 'guard');
  const after = await runStore.get(runId);
  if (endingLines.length > 0) {
    for (const line of endingLines) print(line);
  } else {
    chainedGuards.forEach((guard, index) => {
      const endedTheRun = index === chainedGuards.length - 1 && after.terminal_state;
      if (!endedTheRun) {
        print(guardPassedLine(guard));
        return;
      }
      print(result.context_hint);
      const ending = guardEndingOfRun(after);
      if (ending?.step === guard && ending.reason !== undefined) print(`Reason: ${ending.reason}`);
    });
  }

  const afterView = describePending(workflow, after, registry);
  const isCapabilityBlock =
    result.error_code === 'ENGINE_HANDLER_NOT_REGISTERED' ||
    result.error_code === 'ENGINE_ADAPTER_NOT_REGISTERED';
  const reasons: string[] = [];
  // A failed step is first. A capability block is not a failure (the run is NOT failed): the step
  // is named below as a step that cannot run here, from the view after the call.
  if (result.status === 'error' && !isCapabilityBlock) {
    reasons.push(`'${lastStep ?? result.command}' failed: ${result.errors.join(', ')}`);
  }
  reasons.push(...stoppedReasons(runId, after, afterView));
  if (reasons.length > 1) {
    const none = reasons.indexOf('nothing is ready to run now');
    if (none >= 0) reasons.splice(none, 1);
  }
  // decision C37: a run that completed is not a stop — the phase line below says it, so its ending
  // gets no `Stopped:` line (any other reason that holds still does).
  const completedEnding = 'the run has ended (completed)';
  for (const reason of reasons.filter((r) => r !== completedEnding)) print(`Stopped: ${reason}`);
  // decision C44: when the run stops on a step refused before its claim with nothing else ready, the
  // last line is the way out (it carries the phase); otherwise the phase line.
  print(
    cannotRunWayOutApplies(after, afterView)
      ? cannotRunWayOut(after)
      : `Run ${runId}: phase '${deriveRunPhase(after)}'`,
  );
  const refused = !after.terminal_state && stepsThatCannotRun(afterView).length > 0;
  return (result.status === 'error' && !isCapabilityBlock) || refused ? 1 : 0;
}

export const runAdvanceCommand = new Command('advance')
  .description(
    'Run the guards and automatic steps a run owes, from this shell — no model provider, no key',
  )
  .argument('<run-id>', 'ID of the run to advance')
  .option(
    '--project <dir>',
    'CONFIG anchor: deployment root whose realm.yaml applies to definitions without a stored trust_root (default: current directory)',
  )
  .option(
    '--extensions-module <path>',
    "CODE override: module that REPLACES the workflow's declared 'extensions' modules (repair tool)",
  )
  .action(async (runId: string, opts: { project?: string; extensionsModule?: string }) => {
    // The program's name is checked first: a name that cannot be used prints one line and exits 1
    // before any work.
    const driver = resolveProgramIdentity(
      'advance',
      'it is written as the program that ran the steps, and advance checks it before reading the run, so nothing was run',
    );
    const { JsonFileStore, JsonWorkflowStore } = await import('@sensigo/realm');
    const runStore = new JsonFileStore();
    const workflowStore = new JsonWorkflowStore();
    try {
      const code = await advanceRunFromShell(runId, opts, runStore, workflowStore, driver, (l) =>
        console.log(l),
      );
      process.exit(code);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
