// run advance command — runs what a run owes the engine, from this shell (issue #625 PR-2a).
import { resolve } from 'node:path';
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
  owedWords,
  resumeWay,
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
  answerOf,
  type NextAction,
  type PendingView,
  type ProgramFit,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';
import { resolveProgramIdentity } from '../lib/program-identity.js';
import {
  BY_SOURCE_WORDS,
  describeProgram,
  outcomeNotRecordedLine,
  takenLine,
  takenPhrase,
} from '../lib/holder-render.js';

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
 * caller's to add, first): the run ended · a question is open · each step that cannot run · engine
 * work still owed (decision C202) · agent steps ready · each step in flight elsewhere, with what to
 * do (decision C43; the holder and the time are on the preview's `In flight:` line) · and, when none
 * of these holds, `nothing is ready to run now`. The open question's line is rendered from the reply's answer act (decision C103 —
 * `nextActions`, core's one composer), never from this command's own read of the record.
 */
export function stoppedReasons(
  runId: string,
  run: RunForReasons,
  pending: PendingView,
  nextActions: readonly NextAction[] = [],
): string[] {
  if (run.terminal_state) return [`the run has ended (${deriveRunPhase(run)})`];
  if (run.pending_gate !== undefined) {
    const answer = nextActions.map((a) => answerOf(a)).find((a) => a !== undefined);
    return [
      answer !== undefined
        ? `a question is open — realm run respond ${runId} --gate ${answer.gate_id} --choice <one of: ${answer.choices.join(', ')}>`
        : `a question is open — see realm run inspect ${runId}`,
    ];
  }
  const reasons = stepsThatCannotRun(pending).map((e) => cannotRunClause(e));
  // decision C202: engine work owed when the call stops — a refusal ended the loop before it ran, or
  // another program made it owed after the loop's last read — is named with the call that runs it.
  // (The preview never gets here with work owed: it runs it.)
  if (pending.act !== undefined) {
    reasons.push(
      `the engine still owes ${owedList(pending)} — to run ${owedWords(pending).them}: realm run advance ${runId}`,
    );
  }
  const ready = agentReadyReason(runId, pending.agent_steps);
  if (ready !== undefined) reasons.push(ready);
  reasons.push(...inFlightReasons(runId, run));
  return reasons.length > 0 ? reasons : ['nothing is ready to run now'];
}

/**
 * The reason for each step in flight in another program (decisions C37, C205): `'<s>' is in flight
 * in another program — wait for it, or see realm run inspect <id>`. `realm run advance` prints it as
 * a `Stopped:` reason; `realm run respond` and `realm run drain` as their own line — the same words
 * from here. A step whose question is open is not in flight (it waits on the answer).
 */
export function inFlightReasons(runId: string, run: RunForReasons): string[] {
  return inFlightSteps(run).map(
    (step) =>
      `'${step}' is in flight in another program — wait for it, or see realm run inspect ${runId}`,
  );
}

/**
 * The one ready line for agent steps (decisions C55, C59, C89, C96): `an agent step is ready: '<s>' —
 * drive it with realm agent --run-id <id> --provider <provider> --model <model>`, plural for two or
 * more; `undefined` when none is ready. `realm run advance` prints it as a `Stopped:` reason and
 * `realm run respond` as its own line — the same words from here.
 */
export function agentReadyReason(runId: string, agentSteps: readonly string[]): string | undefined {
  if (agentSteps.length === 0) return undefined;
  // decisions C55, C59: the subject and the count word agree with how many agent steps are ready.
  const ready =
    agentSteps.length === 1
      ? `an agent step is ready: '${agentSteps[0]}' — drive it`
      : `agent steps are ready: ${agentSteps.map((s) => `'${s}'`).join(', ')} — drive them`;
  // decision C89: the drive command a person can run as printed — since #676 `realm agent` refuses
  // to start without a model, so the line carries the placeholders the other printers use
  // (run-agent.ts's re-attach line, resume.ts, run.ts's detach map).
  return `${ready} with realm agent --run-id ${runId} --provider <provider> --model <model>`;
}

/**
 * The line after the commands a run's state leaves (decisions C164, C181) — `realm run respond`
 * prints it after its owed lines, `realm run advance` after its ready line for an agent step: true
 * whether or not a process attends the run.
 */
export function attendingLine(commands: number): string {
  return `If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; ${commands === 1 ? 'the line above is' : 'the lines above are'} for when none is.`;
}

/**
 * decisions C202, C204: the reasons, the ended reason of a run that ended with a failed step `realm
 * run resume` takes (core's `resumeWay`) given with the way back in ({@link endedResumeReason}).
 * Every other reason unchanged.
 */
function withResumeWay(
  reasons: string[],
  run: Parameters<typeof resumeWay>[0],
  workflow: Parameters<typeof resumeWay>[1],
): string[] {
  const resumable = endedResumeReason(run, workflow);
  if (resumable === undefined) return reasons;
  const ended = `the run has ended (${deriveRunPhase(run)})`;
  return reasons.map((reason) => (reason === ended ? resumable : reason));
}

/**
 * decisions C202, C205: a run that ended with a failed step `realm run resume` takes, said with the
 * way back in — `the run has ended (<phase>) — to make '<step>' runnable again: realm run resume <id>
 * --from <step>` (`a failed step` and `<one of: …>` for several); `undefined` for any other run.
 */
function endedResumeReason(
  run: Parameters<typeof resumeWay>[0],
  workflow: Parameters<typeof resumeWay>[1],
): string | undefined {
  const resume = resumeWay(run, workflow);
  if (resume === undefined) return undefined;
  const which = resume.steps.length === 1 ? `'${resume.steps[0]}'` : 'a failed step';
  return `the run has ended (${deriveRunPhase(run)}) — to make ${which} runnable again: ${resume.command}`;
}

/**
 * Where the project code of a run's steps is loaded from (decision C98) — the folder
 * `loadProjectExtensions` anchors on: the workflow's own `trust_root` (its declared modules are
 * resolved under it, and its realm.yaml is read there) whatever folder the shell is in; for a
 * definition with none (made by an agent or from a string), the folder given with `--project`, else
 * the shell's own. With `--extensions-module`, that module replaces the declared ones.
 */
export function projectCodeWhere(
  workflow: Pick<WorkflowDefinition, 'trust_root'>,
  opts: { project?: string; extensionsModule?: string },
  cwd: string,
  // decision C107: whether any project code was found there (a realm.yaml or a declared module).
  hasCode = true,
): string {
  return projectWords({ id: '', ...workflow }, opts, cwd, hasCode).where;
}

/**
 * The line for a `--project` the command did not use (decision C108): the workflow has its own
 * project (its `trust_root`), and its code and realm.yaml are loaded from there — or, when that
 * project holds no code, `(no project code there)` (decision C121). `undefined` when `--project`
 * was not given or was used.
 */
export function projectNotUsedLine(
  workflow: Pick<WorkflowDefinition, 'id' | 'trust_root'>,
  opts: { project?: string },
  // decision C121: whether the workflow's own project holds any code — the same fact the header says.
  hasCode = true,
): string | undefined {
  return projectWords(workflow, opts, process.cwd(), hasCode).notUsed;
}

/**
 * The project words, from ONE composer (decisions C98, C107, C108, C121): where a run's project code
 * is loaded from — `the project code under <folder>`, `no project code (nothing to load under
 * <folder>)`, or the `--extensions-module` module — and, for a `--project` the workflow's own
 * project overrides, the line that says it was not used, with the same fact about its code. The
 * folder is the workflow's own `trust_root` whatever folder the shell is in; for a definition with
 * none, the folder given with `--project`, else the shell's.
 */
export function projectWords(
  workflow: Pick<WorkflowDefinition, 'id' | 'trust_root'>,
  opts: { project?: string; extensionsModule?: string },
  cwd: string,
  hasCode: boolean,
): { where: string; notUsed?: string } {
  const root =
    workflow.trust_root ?? (opts.project !== undefined ? resolve(cwd, opts.project) : cwd);
  const where =
    opts.extensionsModule !== undefined
      ? `the module ${resolve(cwd, opts.extensionsModule)} (--extensions-module) and the realm.yaml of ${root}`
      : hasCode
        ? `the project code under ${root}`
        : noProjectCode(root);
  if (opts.project === undefined || workflow.trust_root === undefined) return { where };
  const code = hasCode
    ? `${workflow.trust_root}, and its code is loaded from there`
    : `${workflow.trust_root} (no project code there)`;
  return {
    where,
    notUsed: `--project ${opts.project} was not used: workflow '${workflow.id}' has its own project, ${code}.`,
  };
}

/**
 * The `--project` help of `realm run advance` and `realm run respond` (decision C121): when it is
 * used — a workflow registered without a project folder — and that a workflow registered from a
 * folder loads its code from there.
 */
export const PROJECT_OPTION_HELP =
  'Used only for a workflow registered without a project folder (made by an agent or from a string): the folder whose realm.yaml and code it loads (default: current directory). A workflow registered from a folder loads its code from there, and --project is not used.';

/** `no project code (nothing to load under <folder>)` — a workflow with none (decision C107). */
function noProjectCode(root: string): string {
  return `no project code (nothing to load under ${root})`;
}

/**
 * Where a later `realm run advance` loads the run's project code from (decision C98), said before it
 * runs: under the workflow's own `trust_root` — whatever folder that shell is in — or, for a
 * definition with none, under the folder it runs in (or its `--project`).
 */
export function laterAdvanceCodeWhere(
  workflow: Pick<WorkflowDefinition, 'trust_root'>,
  // decision C107: whether any project code was found under the workflow's own project.
  hasCode = true,
): string {
  if (workflow.trust_root === undefined) {
    return 'the project code under the folder it runs in (or its --project)';
  }
  return hasCode
    ? `the project code under ${workflow.trust_root}`
    : noProjectCode(workflow.trust_root);
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
  // decision C95: the clock the view reads, so an open question whose time is up and that declares
  // `on_expiry` is named as owed — and `advanceRun` carries it out first.
  const now = new Date();
  const registry =
    registryOverride ??
    (
      await loadProjectExtensions(workflow, {
        ...(opts.extensionsModule !== undefined ? { overrideModule: opts.extensionsModule } : {}),
        projectDir,
      })
    ).registry;

  const pending = describePending(workflow, run, registry, now);
  const keepsClaims = runStore.persistsClaims === true;
  // decision C98: what comes from where — the folder the step's project code is loaded from (not
  // the shell's, unless it is), and the environment, which is the shell's. Decision C107: a
  // workflow with no project code is said to have none (the registry loaded no realm.yaml and no
  // module, so it carries no code identity); decision C108: a `--project` not used is said.
  const hasCode = registryOverride !== undefined || registry.identity !== undefined;
  const words = projectWords(workflow, opts, process.cwd(), hasCode);
  print(
    `Advancing run ${runId} (workflow '${workflow.id}') with ${words.where}, in this shell's environment.`,
  );
  if (words.notUsed !== undefined) print(words.notUsed);
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
    // decision C103: at an open question the line is the reply's — `advanceRun` runs nothing there
    // and answers with the question's act (core's one composer), which the line renders.
    const reply =
      !run.terminal_state && run.pending_gate !== undefined
        ? await advanceRun(runStore, workflow, {
            runId,
            caller: 'advance',
            registry,
            now,
            ...(driver !== undefined ? { driver } : {}),
          })
        : undefined;
    const reasons = withResumeWay(
      stoppedReasons(runId, run, pending, reply?.next_actions),
      run,
      workflow,
    );
    print(`${opening}: ${withFullStop(reasons.join('; '))}`);
    // decision C181: the ready line for an agent step is followed by the line `realm run respond`
    // prints after its commands — a `realm workflow run` or `realm agent` waiting on the run goes on
    // by itself.
    const readyPreview = agentReadyReason(runId, pending.agent_steps);
    if (readyPreview !== undefined && reasons.includes(readyPreview)) print(attendingLine(1));
    if (cannotRunWayOutApplies(run, pending)) print(cannotRunWayOut(run));
    // decision C23 with D4.4: a step that cannot run here (refused before its claim, or
    // capability-blocked) exits 1 whether or not anything else was owed — the same code as after a
    // call that ran other steps.
    return !run.terminal_state && stepsThatCannotRun(pending).length > 0 ? 1 : 0;
  }
  print(`Owed to the engine: ${owedList(pending)}.`);

  let lastStep: string | undefined;
  // decision C123: the line that says this call carried out an expired question is printed when it
  // happens — before the steps it led to — and not again with the reply's other warnings.
  let expiryLine: string | undefined;
  // decision C187: the guards decided since the last step started. A step the loop picks after them
  // (it starts, or another process holds it) means each passed — a guard that ended the run lets no
  // step be picked — so their lines are printed before its line, in the order the steps ran. Those
  // left when the call returns are said below.
  let decidedGuards: string[] = [];
  const guardsSaid = new Set<string>();
  const sayDecidedGuards = (): void => {
    for (const guard of decidedGuards) {
      print(guardPassedLine(guard));
      guardsSaid.add(guard);
    }
    decidedGuards = [];
  };
  // One call of the engine's advance, with this command's callbacks — called again after the race
  // below (decision C194).
  async function advanceOnce() {
    const reply = await advanceRun(runStore, workflow, {
      runId,
      caller: 'advance',
      registry,
      now,
      ...(driver !== undefined ? { driver } : {}),
      onExpiry: (line) => {
        expiryLine = line;
        print(`⚠ ${line}`);
      },
      onGuard: (guard) => {
        decidedGuards.push(guard);
      },
      onStep: (step) => {
        sayDecidedGuards();
        lastStep = step;
        print(`→ ${step}`);
      },
      // D6.1: a step another process took is said as a past-tense fact — never "cannot run here".
      onTaken: (step, record) => {
        sayDecidedGuards();
        print(takenLine(step, describeClaimHolder(record.claims?.[step], keepsClaims)));
      },
    });
    return reply;
  }
  let result = await advanceOnce();
  // decisions C194, C199: the step this call ran was settled, or taken over, by another process — or
  // the run was ended — before its own outcome was recorded: that step's own refusal (`stopped_step`).
  // Said from the record, never "failed", and the command goes on with what is left, as for a step
  // another process took before this one ran it. A claim refused because the record changed after
  // this call read it (the run ended, a question opened) ran nothing here: no line of its own — the
  // stop reasons below say what the record shows. The same code from a guard of the chain (a
  // concurrent settle that diverged from its abort) names no step: said below, from the record. The
  // refusals' own warnings are said with the last reply's.
  const raceWarnings: string[] = [];
  while (
    result.status === 'error' &&
    result.stopped_step !== undefined &&
    result.stopped_step === lastStep &&
    (result.error_code === 'STATE_STEP_ALREADY_SETTLED' ||
      result.error_code === 'STATE_CLAIM_LOST' ||
      result.error_code === 'STATE_RUN_TERMINAL' ||
      result.error_code === 'STATE_STEP_NOT_ELIGIBLE')
  ) {
    if (result.error_code !== 'STATE_STEP_NOT_ELIGIBLE') {
      print(outcomeNotRecordedLine(await runStore.get(runId), lastStep, keepsClaims));
    }
    raceWarnings.push(...result.warnings);
    result = await advanceOnce();
  }

  // decision C28: PR-1's lines for the guards this call settled. A reply carrying `ended_by` (a
  // guard a step's own write settled) gives the ending and its reason. Otherwise one passed line
  // per guard the loop settled — and, for a guard that ended the run, the reply's sentence, then
  // PR-1's `Reason:` line read off the record the call left (the loop's own guard replies carry no
  // `ended_by`).
  const endingLines = describeEndedBy(result);
  const chainedGuards = (result.chained_auto_steps ?? [])
    .map((c) => c.step)
    .filter((step) => workflow.steps[step]?.execution === 'guard' && !guardsSaid.has(step));
  const after = await runStore.get(runId);
  if (endingLines.length > 0) {
    for (const line of endingLines) print(line);
  } else {
    // decision C174 (pinning lane A, F2): only the guard the record names as the run's ending ended
    // it — a guard that passed, before a later step completed the run, prints its passed line.
    const guardEnding = guardEndingOfRun(after);
    chainedGuards.forEach((guard) => {
      const endedTheRun = guardEnding?.step === guard;
      if (!endedTheRun) {
        print(guardPassedLine(guard));
        return;
      }
      print(result.context_hint);
      if (guardEnding.reason !== undefined) print(`Reason: ${guardEnding.reason}`);
    });
  }

  // decision C109: the reply's warnings — the expiry line among them (core prints nothing) — are
  // this command's to show; the expiry line was shown before the steps (C123).
  let expirySaid = false;
  for (const warning of [...raceWarnings, ...result.warnings]) {
    if (!expirySaid && warning === expiryLine) {
      expirySaid = true;
      continue;
    }
    print(`⚠ ${warning}`);
  }

  const afterView = describePending(workflow, after, registry, new Date());
  const isCapabilityBlock =
    result.error_code === 'ENGINE_HANDLER_NOT_REGISTERED' ||
    result.error_code === 'ENGINE_ADAPTER_NOT_REGISTERED';
  const reasons: string[] = [];
  // A failed step is first. A capability block is not a failure (the run is NOT failed): the step
  // is named below as a step that cannot run here, from the view after the call. Decision C199:
  // "failed" comes from the record, never from the reply's status — only when the record lists the
  // step the refusal is about (`stopped_step`, or the guard the reply names) as failed. Any other
  // refusal names that step with the engine's words (or gives the words alone when it names none),
  // and names it once: never also as in flight in another program, which a claim this call took and
  // its refusal left on the record would make it read as.
  const about =
    result.stopped_step ??
    (typeof result.error_details?.['step'] === 'string' ? result.error_details['step'] : undefined);
  const refusal = result.status === 'error' && !isCapabilityBlock;
  if (refusal) {
    const words = result.errors.join(', ');
    reasons.push(
      about === undefined
        ? words
        : after.failed_steps.includes(about)
          ? `'${about}' failed: ${words}`
          : `'${about}': ${words}`,
    );
  }
  const heldHere =
    refusal && about !== undefined
      ? { ...after, in_progress_steps: after.in_progress_steps.filter((s) => s !== about) }
      : after;
  reasons.push(
    ...withResumeWay(
      stoppedReasons(runId, heldHere, afterView, result.next_actions),
      after,
      workflow,
    ),
  );
  if (reasons.length > 1) {
    const none = reasons.indexOf('nothing is ready to run now');
    if (none >= 0) reasons.splice(none, 1);
  }
  // decision C37: a run that completed is not a stop — the phase line below says it, so its ending
  // gets no `Stopped:` line (any other reason that holds still does).
  const completedEnding = 'the run has ended (completed)';
  // decision C181: right after the ready line for an agent step, the line `realm run respond` prints
  // after its commands.
  const ready = agentReadyReason(runId, afterView.agent_steps);
  for (const reason of reasons.filter((r) => r !== completedEnding)) {
    print(`Stopped: ${reason}`);
    if (reason === ready) print(attendingLine(1));
  }
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
    "Run what a run owes the engine — an expired question's declared on_expiry, then its guards and automatic steps — from this shell, with no model provider and no key",
  )
  .argument('<run-id>', 'ID of the run to advance')
  .option('--project <dir>', PROJECT_OPTION_HELP)
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
