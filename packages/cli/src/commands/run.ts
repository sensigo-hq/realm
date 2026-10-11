// realm run <path> — interactive workflow runner (development driver).
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { constants as osConstants } from 'node:os';
import {
  validateRunParams,
  loadWorkflowFromFile,
  JsonFileStore,
  findEligibleSteps,
  executeChain,
  submitHumanResponse,
  describeAnswerEnding,
  lateAnswerOutcome,
  unmetCapabilities,
  capabilityWarning,
  WorkflowError,
  deriveRunPhase,
  describePending,
  stepsThatCannotRun,
  cannotGoOnLines,
  cannotGoOnHere,
  resumeWay,
  owedList,
  owedRunsClause,
  pendingCleanupLine,
  respondCommand,
  describeClaimHolder,
  classifyInProgressClaims,
  pendingGateQuestion,
  classifyStop,
  isRaceStop,
  type NotRecordedKind,
} from '@sensigo/realm';
import {
  recordedAnswer,
  renderAnswerLine,
  questionLines,
  takenPhrase,
  takenLine,
  inFlightLine,
  waitingLine,
  ranElsewherePhrase,
  goOnLine,
  resumeLine,
  outcomeNotRecordedLine,
} from '../lib/holder-render.js';
import { IN_FLIGHT_WATCH_MS } from '../agent/run-agent.js';
import { renderLoadFailure } from '../lib/loader-warnings.js';
import { resolveProgramIdentity } from '../lib/program-identity.js';
import type {
  WorkflowDefinition,
  StepDefinition,
  ExtensionRegistry,
  RunRecord,
  RunStore,
  Attributed,
} from '@sensigo/realm';
import type { ResponseEnvelope, StepDispatcher, PendingView } from '@sensigo/realm';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';
import { buildReattachFlags } from './agent.js';
import { attendingLine } from './run-advance.js';
import { scheduleGateExpiryTimer } from '../agent/gate/gate-expiry-timer.js';

/**
 * Dormant strict posture (issue #197 PR-2, design §6 — the #169→#170 template): read PER CALL,
 * never cached at module load. "on" = set to any non-empty value other than `'0'`/`'false'`. A
 * strict-flip force-enables minting even without `--mint-writer-nonce` (design §8).
 */
function isWriterNonceRequired(): boolean {
  const v = process.env['REALM_REQUIRE_WRITER_NONCE'];
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

/**
 * The line `realm workflow run` prints when a step's call does not return `ok`. It sits under the
 * prompt for `stepName`, so when the reply is the own reply of another step — one the engine ran
 * AFTER it (`stopped_step`, issue #676 review) — the line names that step; otherwise it would read
 * as `stepName`'s own.
 *
 * @internal Exported for testing only.
 */
export function renderStepFailureLine(
  result: Pick<ResponseEnvelope, 'status' | 'errors' | 'stopped_step'>,
  stepName: string,
): string {
  const stoppedAfter =
    result.stopped_step !== undefined && result.stopped_step !== stepName
      ? ` (step '${result.stopped_step}', run by the engine after '${stepName}' finished)`
      : '';
  return `  ✗ ${result.status}${stoppedAfter}: ${result.errors.join(', ')}`;
}

/**
 * The detach map (issue #447): what to do next, for THIS run's state.
 *
 * Cancelling a dev-run prompt used to dump a raw Node stack over an unhandled AbortError, which
 * reads like a crash. The run was always saved — every settled step persists before the next
 * prompt — so the exit should say so, and then hand over the exact commands that work from here.
 *
 * The fork is on the RECORD, not on a guess, because two of the three states REFUSE most of the
 * remedies and printing a command that will be rejected is worse than printing nothing:
 *
 *  - TERMINAL — reachable for real: an external `realm run respond`, or a gate-expiry enactment,
 *    can terminalize this run while this process sits blocked on the prompt (the #291 race the
 *    fresh get below exists to catch). Inspect ONLY, because both other remedies refuse a
 *    terminal run, by two DIFFERENT mechanisms: `realm run abandon` throws STATE_RUN_TERMINAL
 *    (abandon-run.ts), while `realm agent --run-id` refuses through a separate uncoded check in
 *    resolveRunAttach (run-attach.ts) — a plain Error, not that code.
 *    Decisions C202, C204: a run an engine failure ended with a failed step `realm run resume`
 *    takes (core's `offeredResumeWay`, F2) gets that command first (`Resume:`); a run an operator
 *    ended gets its ending and reason in that place (`Ended:`), never the undo.
 *  - PENDING GATE — respond and inspect, and deliberately NO Discard line: `realm run abandon`
 *    REFUSES a run with a pending gate (STATE_TRANSITION_DENIED, abandon-run.ts) and tells you to
 *    resolve the gate first. The gate_id and choices come from the FROZEN record, the same source
 *    `respond` validates against, so what is printed is what will be accepted. Decision C202: a
 *    question whose time is up and that declares `on_expiry` gets the owed call in place of respond.
 *  - OTHERWISE — decision C202: the ways on the run's view (`describePending`, read by the caller on
 *    the same record) gives: the owed call (`Advance: realm run advance`) when the engine owes work,
 *    the drive (`Drive it: realm agent`) only when an agent step is ready — then the line `realm run
 *    respond` prints after its commands; when neither, the steps that cannot run and the way out
 *    (`cannotGoOnLines`) when the run cannot go on from here, or C188's `Go on:` line for a step in
 *    flight in another program (no Discard: the run is in that program's hands); then inspect, and
 *    discard. A run with nothing ready gets inspect and discard alone: no command goes on with it.
 *
 * The choices are joined with `|` deliberately: this is a usage template showing alternation, not
 * a list. (inspect renders them `', '` and the prompt `'/'`; three renderings, three purposes.)
 * An empty `choices: []` renders an empty alternation — that run is already human-unresolvable.
 * The authored form is a load error since issue #433; a GRANDFATHERED registered copy (one
 * registered before #433 shipped) can still carry it and keeps running — not special-cased here
 * either way.
 *
 * @internal Exported for testing only.
 */
export function renderDetachMap(
  record: RunRecord,
  promptStep: string | undefined,
  /**
   * Decision C202: what the run owes and what is ready — `describePending` on `record` — and the
   * workflow (which failed steps `realm run resume` takes).
   */
  ways: {
    pending: PendingView;
    workflow: Parameters<typeof resumeWay>[1] & Parameters<typeof cannotGoOnLines>[2];
  },
  opts?: {
    headline?: string;
    /**
     * Issue #676 (review walk): the flags this `realm workflow run` was given that `realm agent`
     * takes too (`--extensions-module`, `--project`, `--mint-writer-nonce`), built by
     * `buildReattachFlags`. The `Drive it` line repeats them; the model flags stay placeholders,
     * because a dev run is never driven by a model.
     */
    driveFlags?: string;
  },
): string {
  // DERIVED, never the persisted field: a record can carry a stale `run_phase` that disagrees
  // with what its own seal says (issue #432's class), and a map that names the wrong phase sends
  // an operator to the wrong remedy.
  const phase = deriveRunPhase(record);
  const step = promptStep ?? record.pending_gate?.step_name ?? '(step unknown)';
  // issue #468 — the default is the #447 cancel route's own claim, byte-identical. The stall
  // route (below, in the loop) passes 'Workflow stalled', or 'Engine work owed' when the engine owes
  // work this command does not run (F16): no prompt was ever cancelled there, and the hardcoded
  // word would be a false statement about what just happened.
  const headline = opts?.headline ?? 'Prompt cancelled';
  const lines = [
    `${headline} — detached from run '${record.id}' at step '${step}' (phase: ${phase}). The run is saved.`,
  ];

  if (record.terminal_state) {
    // decisions C202, C205: the way on from a failed step `realm run resume` takes.
    const resume = resumeLine(record, ways.workflow);
    if (resume !== undefined) lines.push(resume);
    // decision C211: cleanup steps the ending left pending — the command that runs them.
    const cleanup = pendingCleanupLine(record, new Date());
    if (cleanup !== undefined) lines.push(`  ${cleanup}`);
    lines.push(`  Inspect:   realm run inspect ${record.id}`);
    return lines.join('\n');
  }

  const gate = record.pending_gate;
  const { pending } = ways;
  // decision C202: the owed call — for what the engine owes, an expired question's declared
  // `on_expiry` included (the view's act); decision C207: with several owed, where the call stops.
  const advanceLine = `  Advance:   realm run advance ${record.id} — for what the engine owes (${owedList(pending)}), with no model${owedRunsClause(pending)}`;
  if (gate !== undefined) {
    // decision C202: a question whose time is up and that declares `on_expiry` can no longer be
    // answered — the owed call carries its expiry out.
    lines.push(
      pending.act !== undefined
        ? advanceLine
        : // decision C206: the one answer command (`--choice <one of: a, b>`), never `a|b` — a
          // shell runs that as a pipe, and records the first choice.
          `  Respond:   ${respondCommand(record.id, gate.gate_id, gate.choices)}`,
    );
    lines.push(`  Inspect:   realm run inspect ${record.id}`);
    return lines.join('\n');
  }

  // decision C202: the ways on the run's view gives — the owed call where the engine owes work, the
  // drive only where an agent step is ready.
  const commands: string[] = [];
  if (pending.act !== undefined) commands.push(advanceLine);
  if (pending.agent_steps.length > 0) {
    const driveFlags =
      opts?.driveFlags !== undefined && opts.driveFlags !== '' ? ` ${opts.driveFlags}` : '';
    commands.push(
      `  Drive it:  realm agent --run-id ${record.id} --provider <provider> --model <model>${driveFlags}`,
    );
  }
  if (commands.length > 0) {
    // decision C196: a `realm workflow run` or `realm agent` waiting on this run goes on by itself —
    // the line `realm run respond` and `realm run advance` print after theirs, from the same
    // composer, under the commands.
    lines.push(...commands, `             ${attendingLine(commands.length)}`);
  } else if (cannotGoOnHere(record, pending)) {
    // decision C202: the run cannot go on from here — core's lines: each step that cannot run, then
    // the way out (which ends with `realm run abandon`).
    lines.push(...cannotGoOnLines(record, pending, ways.workflow).map((line) => `  ${line}`));
    lines.push(`  Inspect:   realm run inspect ${record.id}`);
    return lines.join('\n');
  } else {
    // decision C202: a step another program holds — C188's way on, and no Discard line.
    const inFlight = record.in_progress_steps.filter((s) => s !== record.pending_gate?.step_name);
    if (inFlight.length > 0) {
      lines.push(goOnLine(inFlight, `realm run advance ${record.id}`));
      lines.push(`  Inspect:   realm run inspect ${record.id}`);
      return lines.join('\n');
    }
  }
  lines.push(`  Inspect:   realm run inspect ${record.id}`);
  lines.push(`  Discard:   realm run abandon ${record.id}`);
  return lines.join('\n');
}

/**
 * decision C188: how `realm workflow run` hands the run back when its watch on a step another process
 * holds (decision C173) ends with the record unchanged. It stops waiting — the run is not stalled: the
 * other program may still be running the step — so it names the held step, not the last step it
 * prompted, and offers the ways on that fit a run in that state: `realm run advance`, once the held
 * step is no longer in flight (it runs what the engine then owes, and names an agent step or a question
 * that is ready), and `realm run inspect`. No `Drive it` line: an agent step that is ready is asked for
 * at this command's own prompt, so the loop never reaches this hand-back with one. No `Discard` line:
 * the run is in another program's hands. The record is the one the watch found unchanged (no gate,
 * not ended).
 *
 * @internal Exported for testing only.
 */
export function renderInFlightHandBack(record: RunRecord, held: readonly string[]): string {
  const names = held.map((s) => `'${s}'`).join(', ');
  const steps = held.length === 1 ? `step ${names}` : `steps ${names}`;
  return [
    `Stopped waiting — detached from run '${record.id}' at ${steps} (phase: ${deriveRunPhase(record)}). The run is saved.`,
    goOnLine(held, `realm run advance ${record.id}`),
    `  Inspect:   realm run inspect ${record.id}`,
  ].join('\n');
}

/** How often the open prompt reads the run to see its question settled elsewhere (decision C158). */
export const QUESTION_WATCH_MS = 500;
let questionWatchMs = QUESTION_WATCH_MS;

/**
 * A test seam, not a user option (the architect's review of round 20, finding 10): sets the interval
 * the prompt's watch reads the run at, and returns the restore. A cell sets it past its own length to
 * neutralise the watch, so that only the attending timer's `onApplied` can close the prompt.
 */
export function setQuestionWatchIntervalForTests(ms: number): () => void {
  const before = questionWatchMs;
  questionWatchMs = ms;
  return (): void => {
    questionWatchMs = before;
  };
}

/**
 * decision C173: how long the loop watches an unchanged record while a step is in flight in another
 * process before it names the step — `realm agent`'s {@link IN_FLIGHT_WATCH_MS}. A test seam, not an
 * option: a cell sets it short and restores it with the returned function.
 */
let inFlightWatchMs = IN_FLIGHT_WATCH_MS;
export function setInFlightWatchForTests(ms: number): () => void {
  const before = inFlightWatchMs;
  inFlightWatchMs = ms;
  return (): void => {
    inFlightWatchMs = before;
  };
}

/**
 * decision C173: reads the run every {@link QUESTION_WATCH_MS} until its record changes (another
 * `version`) or `withinMs` passes; the changed record, or `undefined`. A read that fails is tried
 * again at the next tick.
 */
async function recordChange(
  store: Pick<RunStore, 'get'>,
  runId: string,
  version: number,
  withinMs: number,
): Promise<RunRecord | undefined> {
  const end = Date.now() + withinMs;
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, questionWatchMs));
    const fresh = await store.get(runId).catch(() => undefined);
    if (fresh !== undefined && fresh.version !== version) return fresh;
  }
  return undefined;
}

/**
 * Reads the run every {@link QUESTION_WATCH_MS} (a cell can change it: {@link setQuestionWatchIntervalForTests}) while a prompt waits on the question `gateId`, and
 * calls `onClosed` once when that question is no longer open: the run ended, or its open question
 * is another one or none (decision C158). A read that fails is tried again at the next tick.
 * Returns the stop.
 */
function watchQuestion(
  store: Pick<RunStore, 'get'>,
  runId: string,
  gateId: string,
  onClosed: () => void,
): () => void {
  return watchRun(
    store,
    runId,
    (r) => r.terminal_state === true || r.pending_gate?.gate_id !== gateId,
    onClosed,
  );
}

/**
 * The one watch behind every prompt (decisions C158, C165): reads the run every
 * {@link QUESTION_WATCH_MS} and calls `onClosed` once `closed(record)` holds. A read that fails is
 * tried again at the next tick. Returns the stop.
 */
function watchRun(
  store: Pick<RunStore, 'get'>,
  runId: string,
  closed: (r: RunRecord) => boolean,
  onClosed: () => void,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    void store.get(runId).then(
      (r) => {
        if (stopped) return;
        if (closed(r)) {
          stopped = true;
          clearInterval(timer);
          onClosed();
        }
      },
      () => undefined,
    );
  }, questionWatchMs);
  return (): void => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * The line the prompt prints when its question was settled while it waited (decision C158): the
 * answer the record holds for the step, as `realm run inspect` prints it (`Answer: <choice> · …`),
 * or — when no answer was recorded (an `on_expiry: abort`, an abandoned run) — the run's phase.
 */
export function questionClosedLine(run: RunRecord, step: string): string {
  const last = recordedAnswer(run, step);
  const what =
    last !== undefined
      ? renderAnswerLine(last)
      : `no answer was recorded; the run is '${deriveRunPhase(run)}'`;
  return `This prompt is closed: the question on '${step}' is no longer open — ${what}.`;
}

/**
 * What the record shows of a step another process took or ran (decisions C165, C179): `was taken by
 * <program>` while its claim is on the record, `was taken by <program>, and completed` (or `failed`)
 * once it settled, the program read off its evidence (`driven_by`). A claim with `ownClaimToken` is
 * this prompt's own (an agent step's prompt holds the step's claim while it waits) and is no other
 * process's. `undefined` when neither holds.
 */
function elsewherePhrase(
  run: RunRecord,
  step: string,
  storeKeepsClaims: boolean,
  ownClaimToken?: string,
): string | undefined {
  const claim = run.claims?.[step];
  if (claim !== undefined && (ownClaimToken === undefined || claim.token !== ownClaimToken)) {
    return `was ${takenPhrase(describeClaimHolder(claim, storeKeepsClaims))}`;
  }
  const ran = ranElsewherePhrase(run, step);
  return ran !== undefined ? `was ${ran}` : undefined;
}

/**
 * The line a step's prompt prints when the step stopped waiting for its answer while the prompt was
 * open (decision C165): another process took it (its claim names the program), or ran it (its
 * evidence names the program, `driven_by`), or the run ended. The same past-tense phrase `realm
 * agent` prints for a step another process took (`takenPhrase`). For an agent step, whose claim the
 * prompt holds (decision C179), `ownClaimToken` is that claim's token: the prompt also closes when
 * another process removed the claim (`realm run reclaim --force`, for one), and the step is asked for
 * again if it is still ready. F7 (f): when another process opened a question, the step waits behind
 * it — said, and the step is asked for again after the answer.
 */
export function stepClosedLine(
  run: RunRecord,
  step: string,
  storeKeepsClaims: boolean,
  ownClaimToken?: string,
): string {
  const elsewhere = elsewherePhrase(run, step, storeKeepsClaims, ownClaimToken);
  if (elsewhere !== undefined) {
    return `This prompt is closed: step '${step}' ${elsewhere}; not run here.`;
  }
  if (ownClaimToken !== undefined && !run.terminal_state && run.claims?.[step] === undefined) {
    return `This prompt is closed: the claim it held on step '${step}' was removed by another process, and the step has not run.`;
  }
  if (!run.terminal_state && run.pending_gate !== undefined) {
    return `This prompt is closed: a question is open on '${run.pending_gate.step_name}', and '${step}' waits for its answer.`;
  }
  return `This prompt is closed: step '${step}' no longer waits for an answer — the run is '${deriveRunPhase(run)}'.`;
}

/**
 * decision C179: the line after a step's typed answer when another process took or ran the step
 * before the engine's own claim for the answer — for an agent step, after the prompt let its claim
 * go. `undefined` when the record shows neither (the reply is then the engine's to explain).
 */
export function answerNotRunLine(
  run: RunRecord,
  step: string,
  storeKeepsClaims: boolean,
): string | undefined {
  const elsewhere = elsewherePhrase(run, step, storeKeepsClaims);
  return elsewhere === undefined
    ? undefined
    : `Not run here: step '${step}' ${elsewhere}; the answer typed here was not recorded.`;
}

/**
 * decision C179: while `realm workflow run` waits for an agent step's typed output it holds the
 * step's claim (holder: this program, via `run`), so another driver — `realm agent`, an
 * `execute_step` call — sees the step taken and does no work for it. The claim is released before
 * the answer goes to the engine (which claims the step again for the answer), when the prompt is
 * cancelled or closed, and when the process is ended by SIGHUP, SIGINT or SIGTERM (it then exits
 * 128 + the signal's number). `undefined` when another process took the step first.
 */
async function holdStepClaim(
  store: RunStore,
  runId: string,
  step: string,
  definition: WorkflowDefinition,
  driver: Attributed | undefined,
): Promise<
  { run: RunRecord; token: string | undefined; release: () => Promise<void> } | undefined
> {
  let claimed: RunRecord;
  try {
    claimed = await store.claimStep(runId, step, definition, driver);
  } catch (err) {
    if (
      err instanceof WorkflowError &&
      (err.code === 'STATE_STEP_ALREADY_CLAIMED' || err.code === 'STATE_STEP_NOT_ELIGIBLE')
    ) {
      return undefined;
    }
    throw err;
  }
  const token = claimed.claims?.[step]?.token;
  let released = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    void release().finally(() => process.exit(128 + (osConstants.signals[signal] ?? 0)));
  };
  const signals: NodeJS.Signals[] = ['SIGHUP', 'SIGINT', 'SIGTERM'];
  for (const signal of signals) process.once(signal, onSignal);
  async function release(): Promise<void> {
    if (released) return;
    released = true;
    for (const signal of signals) process.removeListener(signal, onSignal);
    // A release the record no longer allows (another process settled or took the step, the run
    // ended, the claim is gone) changes nothing: the next read shows what happened.
    await store
      .settleStep?.(
        runId,
        { kind: 'release_step', step, ...(token !== undefined ? { claimToken: token } : {}) },
        definition,
      )
      .catch(() => undefined);
  }
  return { run: claimed, token, release };
}

/**
 * Asks until the answer is usable: empty ⇒ {}, invalid JSON or a non-object ⇒ says why
 * and re-asks (issue #459 — operator input gets a re-prompt, never the #123 rethrow;
 * `42`/`null`/`[1]` are valid JSON that would lie through the object cast, MA-executed).
 * Cancellation is untouched BY CONSTRUCTION: `rl.question` sits OUTSIDE the try, so an
 * ABORT_ERR rejection propagates straight to the #447 catch and its detach map.
 */
async function askJsonObject(
  rl: { question: (q: string, opts?: { signal?: AbortSignal }) => Promise<string> },
  prompt: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  for (;;) {
    const raw = await rl.question(prompt, signal !== undefined ? { signal } : undefined);
    const trimmed = raw.trim();
    if (trimmed === '') return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err; // belt — only JSON.parse is in the try
      console.error(`  Not valid JSON: ${err.message} — try again (Enter for {}).`);
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error(
        '  Not a JSON object — the step\'s output must be an object like {"key": "value"}. Try again (Enter for {}).',
      );
      continue;
    }
    return parsed as Record<string, unknown>;
  }
}

export const runCommand = new Command('run')
  .argument('<path>', 'Path to workflow directory or workflow.yaml file')
  .option('--params <json>', 'Initial run parameters as JSON string', '{}')
  .option(
    '--extensions-module <path>',
    "CODE override: module that REPLACES the workflow's declared 'extensions' modules (repair tool)",
  )
  .option(
    '--project <dir>',
    'CONFIG anchor: deployment root whose realm.yaml applies to definitions without a stored trust_root (default: current directory)',
  )
  .option(
    '--mint-writer-nonce',
    'Mint a fresh writer_nonce (UUIDv4) per step-attempt for faithful trace attribution (issue ' +
      "#197) — opt-in; default OFF (today's behavior). No caller-supplied value is accepted.",
    false,
  )
  .description('Run a workflow interactively (development mode)')
  .action(
    async (
      inputPath: string,
      options: {
        params: string;
        extensionsModule?: string;
        project?: string;
        mintWriterNonce?: boolean;
      },
    ) => {
      // issue #625 (holder slice): this program's name, made once, before any other output. A name
      // that cannot be used prints one line and exits 1 here; nothing has been started.
      const driver = resolveProgramIdentity('run');
      // issue #197 PR-2 (design §8): the strict-flip force-enables minting even without the flag.
      const mintWriterNonce = options.mintWriterNonce === true || isWriterNonceRequired();
      // issue #676 (review walk): the detach map's `Drive it` line repeats the flags `realm agent`
      // shares with this command, as the operator typed them.
      const driveFlags = buildReattachFlags({
        ...(options.extensionsModule !== undefined
          ? { extensionsModule: options.extensionsModule }
          : {}),
        ...(options.project !== undefined ? { project: options.project } : {}),
        mintWriterNonce: options.mintWriterNonce === true,
      });
      const filePath =
        inputPath.endsWith('.yaml') || inputPath.endsWith('.yml')
          ? inputPath
          : join(inputPath, 'workflow.yaml');

      // 1. Load workflow
      let definition: WorkflowDefinition;
      try {
        definition = loadWorkflowFromFile(filePath);
      } catch (err) {
        // issue #425 — this catch wraps loadWorkflowFromFile ALONE, so everything it can see is
        // a loader failure and the family split needs no else-arm here. A structural refusal
        // renders verbatim; an unreadable file rides the helper's `Invalid: ` fallback, which
        // replaces today's `Error loading workflow: ` prefix — a deliberate text change, so that
        // one voice reaches an author from every command.
        //
        // No `err.warnings` render here: surfacing the lenient path's warnings on run/agent/
        // listen stays out of scope (#424's stated non-goal).
        console.error(renderLoadFailure(err instanceof WorkflowError ? err : String(err)));
        process.exit(1);
      }

      // 1b. Load project extensions BEFORE run creation (fail-before-create).
      let registry: ExtensionRegistry;
      try {
        ({ registry } = await loadProjectExtensions(definition, {
          ...(options.extensionsModule !== undefined
            ? { overrideModule: options.extensionsModule }
            : {}),
          projectDir: options.project ?? process.cwd(),
        }));
      } catch (err) {
        console.error(
          `Error loading extensions: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }

      // 2. Parse params
      let params: Record<string, unknown>;
      try {
        params = JSON.parse(options.params) as Record<string, unknown>;
      } catch {
        console.error('Error: --params is not valid JSON');
        process.exit(1);
      }

      // issue #426 — dev mode is interactive BY DESIGN: every step kind and every gate prompts
      // on stdin (agent output, auto mock output, gate choices), so a non-TTY stdin can only
      // ever EOF into ERR_USE_AFTER_CLOSE — and it did so AFTER the run was minted and its id
      // printed, leaving a wedged `running` record behind on every scripted invocation.
      //
      // Refused BEFORE any store work, joining the "1b … BEFORE run creation" doctrine one
      // member up. The placement is load → extensions → params → HERE → params-schema (#586) →
      // create, and each boundary is pinned: earlier than the load and the loader-voice cells
      // lose their messages; earlier than extensions and the spawned orphan-manifest case loses
      // its refusal; earlier than params and `--params '{'` reports the wrong problem; LATER than
      // the params_schema check and a piped invocation is told to fix its params, then told on
      // the next try that the command can never run there at all — two round trips with the
      // fatal fact last (#586 walk J3-a). This refusal is UNCONDITIONAL for this wiring; the
      // params one is conditional on the values, so this one goes first.
      //
      // `!== true` rather than a truthiness test: isTTY is `undefined` on a pipe, never false.
      if (process.stdin.isTTY !== true) {
        console.error(
          'Error: dev-mode run is interactive — it prompts on stdin for every step and gate, ' +
            'and stdin here is not a terminal. No run was created. ' +
            "Scripted flows: 'realm workflow test' drives fixtures; " +
            "'realm listen' / 'realm agent' are the production drives. " +
            'To run this workflow by hand, use a real terminal.',
        );
        process.exit(1);
      }

      // issue #586: a declared `params_schema` is applied AFTER the #426 guard above and before
      // any store work, so a violating invocation creates no run. The voice is `:212`'s
      // (`Error: --params is not valid JSON`) — the same command, the same channel, one grammar.
      if (definition.params_schema !== undefined) {
        try {
          validateRunParams(params, definition.params_schema, definition.id);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      }

      // 3. Create store and initial run record
      const store = new JsonFileStore();
      // issue #207 PR-2 (D3 §5, mixed-wiring gap): construct a JsonTraceBufferStore beside the
      // run store (same runsDir) and thread it into executeChain below — without this, `realm
      // run`'s own dev-mode driver never adopted/fenced a step's streamed WAL trace at all.
      const { JsonTraceBufferStore } = await import('@sensigo/realm-mcp');
      // issue #616 PR-0: the run reader is the run store this driver writes — every fence
      // predicate is evaluated against it inside the trace buffer's own critical section.
      const traceBufferStore = new JsonTraceBufferStore(store.runsDirPath, store);

      const { run: initialRecord } = await store.create({
        workflowId: definition.id,
        workflowVersion: definition.version,
        params,
      });
      const runId = initialRecord.id;

      console.log(`\nRealm — ${definition.name} v${definition.version}`);
      console.log(`Run ID: ${runId}\n`);

      // #134 pre-flight (WARN-only, never refuse): surface capability gaps up front so a dev sees them
      // before a step blocks recoverably. `registry` here is always a real registry (loadProjectExtensions
      // returns one or the CLI has already exited), so the `?? createDefaultRegistry()` invariant holds.
      for (const req of unmetCapabilities(definition, registry)) {
        console.warn(`⚠ ${capabilityWarning(req)}`);
      }

      // 4. Set up readline
      //
      // issue #458 — three load-bearing facts, in order: (a) prompts follow the SCREEN, not the
      // pipe — with stdout redirected, the interactive surface (prompt text + echo) joins the
      // reasons/maps that already print on stderr, and the log keeps the pure narrative (bash
      // `read -p`'s norm, executed against every surveyed tool); (b) `terminal` keys on STDIN —
      // the #426 guard above makes `process.stdin.isTTY` an invariant `true` here, and terminal
      // mode is the only route into node's fixed ^C/^D AbortError path (nodejs/node#54030; the
      // non-terminal path is unfixed and upstream-declined, nodejs/node#60344), which is what
      // keeps cancellation ABORT_ERR-coded and the exit code truthful even with BOTH streams
      // piped; (c) the both-piped corner cost — readline then writes prompts/echo/cursor codes
      // into the stderr pipe and the human types blind — is accepted (matches bash's exact
      // posture; a `/dev/tty` alternative is ecosystem-unprecedented in Node and
      // documentation-discouraged).
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout.isTTY ? process.stdout : process.stderr,
        terminal: process.stdin.isTTY,
      });

      // 5. Execution loop
      let run = await store.get(runId);

      // issue #447: which step the operator was answering for, assigned immediately before each
      // question. The block-scoped names below are not visible from the catch, and the catch is
      // where this is needed.
      let promptStep: string | undefined;
      // decision C179: the claim this process holds while an agent step's prompt waits, if any.
      let heldClaim: Awaited<ReturnType<typeof holdStepClaim>> = undefined;
      // decision C182: the claims the loop has said it waits on (step and claim), each said once.
      const waitingSaid = new Set<string>();
      const releaseHeldClaim = async (): Promise<void> => {
        const held = heldClaim;
        heldClaim = undefined;
        if (held !== undefined) await held.release();
      };

      try {
        while (!run.terminal_state) {
          // Handle open gate
          if (run.pending_gate !== undefined) {
            const g = run.pending_gate;
            console.log(`  ⏸  Gate: ${g.step_name} | gate_id: ${g.gate_id}`);
            // decisions C167, C175, C176: the question the person answers — from every source the
            // gate's text comes from — each line as written.
            const question = pendingGateQuestion(definition, run);
            if (question !== undefined) {
              for (const line of questionLines(question)) console.log(line);
            }
            console.log(`  Preview: ${JSON.stringify(g.preview, null, 2)}`);
            // issue #291 (Deliverable 4e, Amendment 4): the ATTENDING-PROCESS enactment timer.
            // Races with another process are SAFE: if this timer fires having lost a race with
            // another settlement (a different terminal's `realm run respond`, `drain --expired`,
            // `listen`), the [F1] `already_settled` lookup-first arm NOOPs harmlessly; and an answer
            // read here after another enactment already won reaches `submitHumanResponse` below,
            // which composes the honest late-response envelope exactly as any other late submit does.
            //
            // decision C158: the prompt closes when its question is settled by anything else — this
            // timer's write, or another process (`realm run respond` in another terminal, `realm run
            // advance`, `drain --expired`, `listen`), seen by a read of the record every
            // QUESTION_WATCH_MS — and says what settled it; it never waits on a question that can no
            // longer be answered. An answer read before the close is submitted as before.
            const settledElsewhere = new AbortController();
            const clearExpiryTimer = scheduleGateExpiryTimer(runId, g, {
              store,
              definition,
              registry,
              ...(driver !== undefined ? { driver } : {}),
              onApplied: () => settledElsewhere.abort(),
            });
            const stopWatching = watchQuestion(store, runId, g.gate_id, () =>
              settledElsewhere.abort(),
            );
            promptStep = g.step_name;
            let raw: string;
            try {
              raw = await rl.question(`  Choice [${g.choices.join('/')}]: `, {
                signal: settledElsewhere.signal,
              });
            } catch (err) {
              // Not this close: the operator's cancel (#447), handled below as before.
              if (!settledElsewhere.signal.aborted) throw err;
              run = await store.get(runId);
              // readline ends the prompt's line when the question is closed.
              console.log(`  ${questionClosedLine(run, g.step_name)}`);
              continue;
            } finally {
              clearExpiryTimer();
              stopWatching();
            }
            const choice = raw.trim();
            // decision C146: the answer the composer speaks for — this gate, named as this command.
            // decision C211: the workflow — the way back in after a late answer whose expiry ended
            // the run reads resume's rule over it.
            // F9: `before`, the record this prompt read before the answer.
            const answered = {
              gateId: g.gate_id,
              via: 'run' as const,
              workflow: definition,
              before: run,
              now: new Date(),
            };
            const respondResult = await submitHumanResponse(store, definition, {
              runId,
              gateId: g.gate_id,
              choice,
              // decision C151: an expiry this late answer carries out names `realm workflow run`.
              caller: 'run',
              // Thread the resolved project registry so a gate-completed run fires its
              // finalizers with project handlers (same registry passed to executeChain below).
              registry,
              // issue #625: this program, named on the cleanup steps the answer drains. Never a
              // `claim_token`: a dev-mode prompt shows the gate on this terminal, not a reply.
              ...(driver !== undefined ? { driver } : {}),
            });
            if (respondResult.status === 'ok') {
              run = await store.get(runId);
              // issue #625: what the answer's write settled is said BEFORE the state line — the
              // guard that ended the run (its sentence, `Reason:`, each finalizer's outcome) or
              // one passed line per guard; for an answer the gate's expiry beat, the expiry
              // sentence comes first. One composer with `realm run respond` and the Slack notifier.
              for (const line of describeAnswerEnding(respondResult, run, answered)) {
                console.log(`  ${line}`);
              }
              const late = lateAnswerOutcome(respondResult, run);
              if (late !== undefined) {
                // The call succeeded and the answer was NOT recorded (this process's own timer
                // enacted the expiry first, with the same choice): never `✓ →`.
                console.log(
                  `  ✗ not recorded — gate settled by timeout with choice '${late.choice}' → ${late.phase}\n`,
                );
              } else {
                console.log(`  ✓ → ${run.run_phase}\n`);
              }
            } else {
              // issue #468 — a FRESH read, not a break: most of this arm's members are a live
              // gate re-asking (a typo, a stale choice) — rl.question blocks, no hot spin. The
              // members that are NOT retryable (the gate/run moved or terminalized elsewhere) are
              // exactly what this read converges: the next iteration sees the real state and
              // either re-prompts honestly or reaches the stall/tail. Mirrors the ok arm above.
              run = await store.get(runId);
              // issue #625: a refused LATE answer (the expiry settled the other choice, or ended the
              // run) says what the run is doing now — which call carried out the expiry (decision
              // C146), the refusal, what the expiry's guards did, then the state.
              const late = lateAnswerOutcome(respondResult, run);
              if (respondResult.answer_recorded === false) {
                for (const line of describeAnswerEnding(respondResult, run, answered)) {
                  console.error(`  ${line}`);
                }
                console.error(
                  late !== undefined
                    ? `  ✗ not recorded — gate settled by timeout with choice '${late.choice}' → ${late.phase}\n`
                    : `  ✗ not recorded → ${deriveRunPhase(run)}\n`,
                );
              } else {
                console.error(`  ✗ ${respondResult.errors.join(', ')}\n`);
              }
            }
            continue;
          }

          // decision C64 (the census): dev mode answers an `auto` step with the typed output, so an
          // input refusal is the operator's to fix at the prompt. A precondition, trust or capability
          // refusal is not — no typed output changes it, and prompting would loop forever. Such a
          // step is not offered — an agent step refused for trust or precondition included
          // (decision C82); when nothing else is eligible, the run cannot go on from here.
          const cannotPrompt = new Set(
            stepsThatCannotRun(describePending(definition, run, registry, new Date()))
              .filter((e) => e.refused_by !== 'input_schema')
              .map((e) => e.step),
          );
          const eligibleSteps = findEligibleSteps(definition, run).filter(
            (step) => !cannotPrompt.has(step),
          );

          // decision C173: a step another process holds (`realm run advance`, an `execute_step`
          // call) is in flight, not stalled — the loop watches the record and goes on when it
          // changes, as `realm agent` does (D6.2); after the same watch with no change it names the
          // step and the way out, then hands the run back.
          const inFlight =
            eligibleSteps.length === 0
              ? run.in_progress_steps.filter((step) => step !== run.pending_gate?.step_name)
              : [];
          if (inFlight.length > 0) {
            // decision C182: what it waits for and who holds it, said once for each claim it waits on.
            for (const step of inFlight) {
              const claim = run.claims?.[step];
              const key = `${step}\u0000${claim?.token ?? claim?.since ?? ''}`;
              if (waitingSaid.has(key)) continue;
              waitingSaid.add(key);
              console.log(
                `  ${waitingLine(step, describeClaimHolder(claim, store.persistsClaims === true), inFlightWatchMs)}`,
              );
            }
            const fresh = await recordChange(store, runId, run.version, inFlightWatchMs);
            if (fresh !== undefined) {
              run = fresh;
              continue;
            }
            // decision C188: the watch ended with the record unchanged — C173's own hand-back, never
            // the stall branch below (the run is in flight, not stalled). A last read: a record that
            // changed after the watch's last read goes on, as a change inside the watch does.
            const record = await store.get(runId);
            if (record.version !== run.version) {
              run = record;
              continue;
            }
            const states = new Map(classifyInProgressClaims(record).map((c) => [c.step, c.state]));
            for (const step of inFlight) {
              console.error(
                inFlightLine(
                  runId,
                  step,
                  describeClaimHolder(record.claims?.[step], store.persistsClaims === true),
                  states.get(step) === 'claim_stale',
                  inFlightWatchMs,
                ),
              );
            }
            console.error(renderInFlightHandBack(record, inFlight));
            // process.exit SKIPS the finally (the catch's own rule, below), so close explicitly.
            rl.close();
            process.exit(1);
          }

          if (eligibleSteps.length === 0 && cannotPrompt.size > 0) {
            // The steps that cannot run, and the way out — core's lines (decision C64).
            const record = await store.get(runId);
            const cannotGoOn = cannotGoOnLines(
              record,
              describePending(definition, record, registry, new Date()),
              definition,
            );
            if (cannotGoOn.length > 0) {
              console.error('\nWorkflow stalled: nothing else can run.');
              for (const line of cannotGoOn) console.error(line);
              rl.close();
              process.exit(1);
            }
          }
          if (eligibleSteps.length === 0) {
            // decision C188: reached with nothing in flight elsewhere (a step another process holds is
            // waited for above, and handed back there).
            // issue #468 — hands the run back with a truthful map instead of silently exiting 0.
            // A fresh read: the loop's own snapshot is already current here (nothing awaited
            // since the last read reached this branch in the same iteration), but the fresh read
            // is the doctrine this file already keeps for every detach point (#447) — kept for
            // consistency, not because a staleness gap is constructible in this spot.
            const record = await store.get(runId);
            const pending = describePending(definition, record, registry, new Date());
            // F16 (review G1-R1): with engine work owed — a guard, for one: this command runs only the
            // steps it prompts — the run is not stalled. The headline says what the engine owes, which
            // this command does not run; the map below names the call that runs it.
            const owed = pending.act !== undefined;
            console.error(
              owed
                ? `\nThe engine owes ${owedList(pending)}, which this command does not run.`
                : `\nNo eligible steps in phase '${run.run_phase}'. Workflow stalled.`,
            );
            console.error(
              renderDetachMap(
                record,
                promptStep,
                { pending, workflow: definition },
                { headline: owed ? 'Engine work owed' : 'Workflow stalled', driveFlags },
              ),
            );
            // process.exit SKIPS the finally (the catch's own rule, below), so close explicitly.
            rl.close();
            process.exit(1);
          }

          // Take the first eligible step (linear workflow for dev mode)
          const stepName = eligibleSteps[0]!;
          const stepDef: StepDefinition = definition.steps[stepName]!;

          // decision C179: an agent step's claim is held while its prompt waits, so another driver
          // sees it taken and asks no model. Another process that took it first is said as taken.
          if (stepDef.execution === 'agent') {
            const hold = await holdStepClaim(store, runId, stepName, definition, driver);
            if (hold === undefined) {
              // Another process took or ran the step first: said as the house says it. Anything else
              // that made the step not ready (the run ended, a question opened) the next pass shows.
              run = await store.get(runId);
              const keeps = store.persistsClaims === true;
              const ran = ranElsewherePhrase(run, stepName);
              if (run.in_progress_steps.includes(stepName)) {
                console.log(
                  `${takenLine(stepName, describeClaimHolder(run.claims?.[stepName], keeps))}\n`,
                );
              } else if (ran !== undefined) {
                console.log(`• Step '${stepName}' was ${ran}; not run here.\n`);
              }
              continue;
            }
            heldClaim = hold;
            run = hold.run;
          }

          console.log(`→ [${stepDef.execution}] ${stepName}: ${stepDef.description}`);

          // Build dispatcher output based on execution type
          let userOutput: Record<string, unknown>;
          // decision C165: the step's prompt closes, as a question's does (C158), when the step stops
          // waiting for this answer — another process took it or ran it (`realm run advance`, an
          // `execute_step` call), or the run ended — and says what the record shows; never `✓` for
          // work done elsewhere. Any other rejection is the operator's cancel (#447), rethrown.
          // decision C179: for an agent step, whose claim this prompt holds, the step stops waiting
          // when that claim is no longer this prompt's (taken over, or removed), or the run ended.
          const holding = heldClaim !== undefined;
          const ownToken = heldClaim?.token;
          const stepGone = new AbortController();
          const stopStepWatch = watchRun(
            store,
            runId,
            (r) =>
              r.terminal_state === true ||
              (holding
                ? !r.in_progress_steps.includes(stepName) ||
                  (ownToken !== undefined && r.claims?.[stepName]?.token !== ownToken)
                : !findEligibleSteps(definition, r).includes(stepName)),
            () => stepGone.abort(),
          );
          promptStep = stepName;
          try {
            if (stepDef.execution === 'agent') {
              userOutput = await askJsonObject(
                rl,
                '  Agent output JSON (Enter for {}): ',
                stepGone.signal,
              );
            } else {
              // auto step
              const hint =
                stepDef.handler !== undefined
                  ? `handler: ${stepDef.handler}`
                  : stepDef.uses_service !== undefined
                    ? `service: ${stepDef.uses_service}`
                    : 'auto';
              userOutput = await askJsonObject(
                rl,
                `  Mock output (${hint}) — JSON (Enter for {}): `,
                stepGone.signal,
              );
            }
          } catch (err) {
            if (!stepGone.signal.aborted) throw err;
            await releaseHeldClaim();
            run = await store.get(runId);
            console.log(
              `  ${stepClosedLine(run, stepName, store.persistsClaims === true, ownToken)}\n`,
            );
            continue;
          } finally {
            stopStepWatch();
          }
          // decision C179: the answer goes to the engine, which claims the step for it.
          await releaseHeldClaim();

          const dispatcher: StepDispatcher = async () => userOutput;

          const result = await executeChain(store, definition, {
            runId,
            command: stepName,
            // decision C151: an expiry this call carries out names `realm workflow run`.
            caller: 'run',
            input: userOutput,
            dispatcher,
            registry,
            traceBufferStore,
            // issue #625 (holder slice): after `traceBufferStore` — the #207 source-text cell reads
            // this call with a lazy `\}\)` and a spread ending in `{})` ahead of it ends the match.
            ...(driver !== undefined ? { driver } : {}),
            // issue #197 PR-2: a FRESH nonce per step-attempt (never a caller-fixed value —
            // reusing one across attempts converts the honest caveat into false self-attribution).
            ...(mintWriterNonce ? { writerNonce: crypto.randomUUID() } : {}),
          });

          // F7: a reply that is neither `ok` nor a question, read by core's classifier against the
          // record as it is now — the one rule for "another program got there first".
          const keeps = store.persistsClaims === true;
          const replyRecord =
            result.status === 'blocked' || result.status === 'error'
              ? await store.get(runId)
              : undefined;
          const stop =
            replyRecord === undefined ? undefined : classifyStop(result, stepName, replyRecord);
          // decision C179: another process took or ran the step before the engine's own claim for this
          // answer (rows 1–2: `taken`) — the answer typed here was not recorded; `takenLine` when the
          // record names no one to say it of.
          const notRun =
            isRaceStop(stop) && stop.kind === 'taken' && !stop.ran_here
              ? (answerNotRunLine(replyRecord!, stepName, keeps) ??
                takenLine(stepName, describeClaimHolder(replyRecord!.claims?.[stepName], keeps)))
              : undefined;
          if (
            result.status === 'ok' &&
            result.agent_action === 'stop' &&
            result.evidence.length === 0
          ) {
            // decision C165: the run ended before this answer reached the engine (another process
            // finished it) — the call ran nothing, so no `✓`: the engine's own words say why.
            run = await store.get(runId);
            console.log(`  Not run here: ${result.context_hint}\n`);
          } else if (notRun !== undefined) {
            // decision C179: another process took or ran the step before the engine's own claim for
            // the answer (for an agent step, after this prompt let its claim go) — said; never `✗`
            // with no reason, never `✓`.
            run = replyRecord!;
            console.log(`  ${notRun}\n`);
          } else if (isRaceStop(stop)) {
            // F7: the step's own settle of the answer was refused (`ran_here`: another process settled
            // it, took it over, removed its claim, or ended the run) — the line `realm run advance`
            // prints, never `✗`. A claim refused because the run ended, a question opened or the step
            // stopped being eligible ran nothing here: no line of its own — the next pass says what
            // the record shows.
            run = replyRecord!;
            if (stop.ran_here) {
              console.log(
                `  ${outcomeNotRecordedLine(stop.kind as NotRecordedKind, run, stepName, keeps)}\n`,
              );
            }
          } else if (result.status === 'ok') {
            run = await store.get(runId);
            const ev = result.evidence[0];
            const hash = ev !== undefined ? ev.evidence_hash.slice(0, 8) : 'n/a';
            const dur = ev !== undefined ? `${ev.duration_ms}ms` : 'n/a';
            console.log(`  ✓ → ${run.run_phase} | hash: ${hash}... | ${dur}\n`);
          } else if (result.status === 'confirm_required' && result.gate !== undefined) {
            // Gate opened as part of this step — it will be handled at loop top.
            run = await store.get(runId);
            console.log(`  Gate opened for '${result.gate.step_name}'.\n`);
          } else if (
            stop?.kind === 'capability' &&
            result.stopped_step !== undefined &&
            result.stopped_step !== stepName
          ) {
            // decision C64 (the census): this step completed; the chain after it reached a step
            // this runner lacks the code for, and the reply is that step's block. The step is said
            // as completed; the next pass names the blocked step (it is never offered at the prompt).
            // Keyed on `stopped_step` (decision C73): a value other than this step means the engine
            // ran that step after this one, so this one settled — no record is read to guess it.
            run = await store.get(runId);
            const ev = [...run.evidence].reverse().find((e) => e.step_id === stepName);
            const hash = ev !== undefined ? ev.evidence_hash.slice(0, 8) : 'n/a';
            const dur = ev !== undefined ? `${ev.duration_ms}ms` : 'n/a';
            console.log(`  ✓ → ${run.run_phase} | hash: ${hash}... | ${dur}\n`);
          } else {
            console.error(`${renderStepFailureLine(result, stepName)}\n`);
            // issue #468 — a FRESH read, not a break: below the validation-exhaustion threshold
            // the step is still eligible and this re-prompts it honestly; AT the threshold the
            // run just terminalized in the store, and only a fresh read lets the while condition
            // see that and exit to the tail — a bare continue would re-ask a dead run forever
            // (verified: the mock chain exhausts and the answer never lands anywhere real).
            run = await store.get(runId);
          }
        }
        // Loop-head invariant (issue #468): exactly two exits from here — the while condition
        // (terminal) and the stall (mapped + exit 1). Every ✗ arm above re-reads then
        // continues; no `break` remains in this loop.
      } catch (err) {
        // issue #447 — the operator cancelled the prompt. Ctrl-D at a pending `rl.question`
        // rejects with an AbortError carrying `code: 'ABORT_ERR'`. Nothing awaits
        // `program.parse()`, so today that surfaces as an unhandled-rejection stack: a saved run
        // that looks like a crash.
        //
        // BOTH Ctrl-D and Ctrl-C land here in EVERY wiring now (issue #458): readline's raw/
        // terminal mode is keyed on stdin's TTY-ness at the `createInterface` call above — the
        // #426 guard makes that an invariant `true` here, and terminal mode is the only route
        // into node's fixed ABORT_ERR abort path (nodejs/node#54030). Before #458, terminal mode
        // defaulted to `output.isTTY` instead, so a piped stdout left the pty cooked — history,
        // not the present: ^C died on the raw ISIG signal path (measured then: exit 130, no map)
        // and ^D drained the loop silently to a false exit 0 (the non-terminal case node closed
        // not_planned, nodejs/node#60344) — both dead now, in every wiring.
        //
        // One timing caveat, worth recording because it produced a confident wrong answer during
        // this work: the pty is COOKED until readline switches it, so a ^C delivered before that
        // switch takes the cooked ISIG path and kills the process before any JS runs. A scripted
        // `printf '\x03' | …` hits that window; the same harness with the byte delayed a second
        // rejects ABORT_ERR-coded as expected. Cooked-mode ^D persists in the stream as EOF and
        // still ends up ABORT_ERR-coded, which is exactly why it looked like a valid control and
        // was not. No claim here about anyone typing that fast.
        //
        // Keyed on the CODE alone, never the message, which names the trigger and varies.
        //
        // The classification is precise TODAY and the precision is not free: a handler that
        // out-throws something that is not this realm's WorkflowError is re-coded
        // (execution-loop.ts): ENGINE_RELEASE_LINE_MISMATCH for another realm version's
        // WorkflowError, ENGINE_HANDLER_FAILED otherwise (a same-named class with no release
        // mark keeps that code and gains a clause) — never its own code. Every engine throw
        // is WorkflowError-coded and none uses ABORT_ERR, and the gate-expiry timer contains
        // its own errors. So ABORT_ERR reaching here means the prompt, and only the prompt.
        // ADDING ANY AbortSignal-CONSUMING AWAIT TO THIS LOOP REQUIRES RE-ESTABLISHING THAT.
        if ((err as { code?: string })?.code === 'ABORT_ERR') {
          // decision C179: the claim an agent step's prompt held is let go first, so the map's
          // `Drive it` line finds the step ready.
          await releaseHeldClaim();
          // A FRESH read, not the loop's `run`: while this process sat blocked on the prompt,
          // another terminal's `realm run respond` or an expiry enactment may have moved it —
          // the #291 race. The map is only as good as the state it forks on.
          let record: RunRecord;
          try {
            record = await store.get(runId);
          } catch (getErr) {
            // The same concurrent-writer reality that makes the fresh read necessary can also
            // make it FAIL — a record purged from another terminal mid-prompt. Without this arm
            // the new cancel path would crash with exactly the stack this feature exists to
            // remove. `inspect` still earns its line: it is the only read surface, and its own
            // answer for a missing record is a clean not-found rather than a stack.
            const message = getErr instanceof Error ? getErr.message : String(getErr);
            console.error(
              `Prompt cancelled — detached from run '${runId}'. Its record could not be re-read: ${message}. Inspect: realm run inspect ${runId}`,
            );
            rl.close();
            process.exit(1);
          }
          console.error(
            renderDetachMap(
              record,
              promptStep,
              {
                pending: describePending(definition, record, registry, new Date()),
                workflow: definition,
              },
              { driveFlags },
            ),
          );
          // process.exit SKIPS the finally, so close explicitly. (rl.close is idempotent, so
          // the double-close on any path that reaches both is harmless — probed.)
          rl.close();
          // Exit 1, not 130: readline consumed the keypress and the process was never signalled,
          // so 130 would claim a death that did not happen.
          process.exit(1);
        }
        await releaseHeldClaim();
        throw err;
      } finally {
        rl.close();
      }

      // issue #468 — the exit code tells the truth. `run` is declared outside the try, so by the
      // time control reaches here the finally above has already closed `rl` on every path that
      // gets this far (the catch's ABORT_ERR arm exits directly and never falls through to here).
      // Only the while condition being false gets here — the stall exits from inside the try
      // above — so `run.terminal_state` is always true at this point.
      // decision C211 (walk c14 W3-4's class): cleanup steps the ending left pending — the command
      // that runs them, under the last line.
      const cleanup = pendingCleanupLine(run, new Date());
      if (deriveRunPhase(run) === 'completed') {
        console.log(`Run complete. Phase: ${run.run_phase}`);
        if (cleanup !== undefined) console.log(cleanup);
        // NATURAL RETURN — never process.exit(0): three declared controls (run-detach.test.ts's
        // R1/R2/R3) pin the completed path as an unwrapped, un-exited resolution.
        // completed-with-failed-steps (the #302 world) exits 0 too, here — outcome-keyed,
        // consistent with the engine's own seal ruling; #304's run-health finding +
        // terminal_reason are the disclosure channel, not this exit code.
        return;
      }
      console.log(`Run complete. Phase: ${run.run_phase}`);
      // decision C205 (round 27 finding 3): a run that ended with a failed step `realm run resume`
      // takes gets the way back in, as the detach map gives it.
      const resume = resumeLine(run, definition);
      if (resume !== undefined) console.log(resume);
      if (cleanup !== undefined) console.log(cleanup);
      process.exit(1);
    },
  );
