// realm run <path> — interactive workflow runner (development driver).
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
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
  composeStepViews,
} from '@sensigo/realm';
import { renderAnswerLine } from '../lib/holder-render.js';
import { renderLoadFailure } from '../lib/loader-warnings.js';
import { resolveProgramIdentity } from '../lib/program-identity.js';
import type {
  WorkflowDefinition,
  StepDefinition,
  ExtensionRegistry,
  RunRecord,
  RunStore,
} from '@sensigo/realm';
import type { ResponseEnvelope, StepDispatcher } from '@sensigo/realm';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';
import { buildReattachFlags } from './agent.js';
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
 *  - PENDING GATE — respond and inspect, and deliberately NO Discard line: `realm run abandon`
 *    REFUSES a run with a pending gate (STATE_TRANSITION_DENIED, abandon-run.ts) and tells you to
 *    resolve the gate first. The gate_id and choices come from the FROZEN record, the same source
 *    `respond` validates against, so what is printed is what will be accepted.
 *  - OTHERWISE — drive, inspect, or discard, all three of which apply.
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
  // route (below, in the loop) passes 'Workflow stalled': no prompt was ever cancelled there, and
  // the hardcoded word would be a false statement about what just happened.
  const headline = opts?.headline ?? 'Prompt cancelled';
  const lines = [
    `${headline} — detached from run '${record.id}' at step '${step}' (phase: ${phase}). The run is saved.`,
  ];

  if (record.terminal_state) {
    lines.push(`  Inspect:   realm run inspect ${record.id}`);
    return lines.join('\n');
  }

  const gate = record.pending_gate;
  if (gate !== undefined) {
    lines.push(
      `  Respond:   realm run respond ${record.id} --gate ${gate.gate_id} --choice ${gate.choices.join('|')}`,
    );
    lines.push(`  Inspect:   realm run inspect ${record.id}`);
    return lines.join('\n');
  }

  const driveFlags =
    opts?.driveFlags !== undefined && opts.driveFlags !== '' ? ` ${opts.driveFlags}` : '';
  lines.push(
    `  Drive it:  realm agent --run-id ${record.id} --provider <provider> --model <model>${driveFlags}`,
  );
  lines.push(`  Inspect:   realm run inspect ${record.id}`);
  lines.push(`  Discard:   realm run abandon ${record.id}`);
  return lines.join('\n');
}

/** How often the open prompt reads the run to see its question settled elsewhere (decision C158). */
export const QUESTION_WATCH_MS = 500;

/**
 * Reads the run every {@link QUESTION_WATCH_MS} while a prompt waits on the question `gateId`, and
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
  let stopped = false;
  const timer = setInterval(() => {
    void store.get(runId).then(
      (r) => {
        if (stopped) return;
        if (r.terminal_state === true || r.pending_gate?.gate_id !== gateId) {
          stopped = true;
          clearInterval(timer);
          onClosed();
        }
      },
      () => undefined,
    );
  }, QUESTION_WATCH_MS);
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
  const answers = composeStepViews(run)[step]?.answers ?? [];
  const last = answers[answers.length - 1];
  const what =
    last !== undefined
      ? renderAnswerLine(last)
      : `no answer was recorded; the run is '${deriveRunPhase(run)}'`;
  return `This prompt is closed: the question on '${step}' is no longer open — ${what}.`;
}

/**
 * Asks until the answer is usable: empty ⇒ {}, invalid JSON or a non-object ⇒ says why
 * and re-asks (issue #459 — operator input gets a re-prompt, never the #123 rethrow;
 * `42`/`null`/`[1]` are valid JSON that would lie through the object cast, MA-executed).
 * Cancellation is untouched BY CONSTRUCTION: `rl.question` sits OUTSIDE the try, so an
 * ABORT_ERR rejection propagates straight to the #447 catch and its detach map.
 */
async function askJsonObject(
  rl: { question: (q: string) => Promise<string> },
  prompt: string,
): Promise<Record<string, unknown>> {
  for (;;) {
    const raw = await rl.question(prompt);
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

      try {
        while (!run.terminal_state) {
          // Handle open gate
          if (run.pending_gate !== undefined) {
            const g = run.pending_gate;
            console.log(`  ⏸  Gate: ${g.step_name} | gate_id: ${g.gate_id}`);
            console.log(`  Preview: ${JSON.stringify(g.preview, null, 2)}`);
            // issue #291 (Deliverable 4e, Amendment 4): the ATTENDING-PROCESS enactment timer.
            // CAVEAT (lane-1-verified, stated here per the design's own instruction): this
            // process is blocked on `rl.question` below and cannot observe an EXTERNAL
            // resolution (e.g. a different terminal's `realm run respond`) while waiting — but
            // that is SAFE: if this timer fires having lost that race, the [F1] `already_settled`
            // lookup-first arm NOOPs harmlessly, and if the human answers after an unattended
            // enactment already won, `submitHumanResponse` below composes the honest late-response
            // envelope exactly as any other late submit does.
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
            const answered = { gateId: g.gate_id, via: 'run' as const };
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

          if (eligibleSteps.length === 0 && cannotPrompt.size > 0) {
            // The steps that cannot run, and the way out — core's lines (decision C64).
            const record = await store.get(runId);
            const cannotGoOn = cannotGoOnLines(
              record,
              describePending(definition, record, registry, new Date()),
            );
            if (cannotGoOn.length > 0) {
              console.error('\nWorkflow stalled: nothing else can run.');
              for (const line of cannotGoOn) console.error(line);
              rl.close();
              process.exit(1);
            }
          }
          if (eligibleSteps.length === 0) {
            console.error(`\nNo eligible steps in phase '${run.run_phase}'. Workflow stalled.`);
            // issue #468 — hands the run back with a truthful map instead of silently exiting 0.
            // A fresh read: the loop's own snapshot is already current here (nothing awaited
            // since the last read reached this branch in the same iteration), but the fresh read
            // is the doctrine this file already keeps for every detach point (#447) — kept for
            // consistency, not because a staleness gap is constructible in this spot.
            const record = await store.get(runId);
            console.error(
              renderDetachMap(record, promptStep, { headline: 'Workflow stalled', driveFlags }),
            );
            // process.exit SKIPS the finally (the catch's own rule, below), so close explicitly.
            rl.close();
            process.exit(1);
          }

          // Take the first eligible step (linear workflow for dev mode)
          const stepName = eligibleSteps[0]!;
          const stepDef: StepDefinition = definition.steps[stepName]!;

          console.log(`→ [${stepDef.execution}] ${stepName}: ${stepDef.description}`);

          // Build dispatcher output based on execution type
          let userOutput: Record<string, unknown>;

          if (stepDef.execution === 'agent') {
            promptStep = stepName;
            userOutput = await askJsonObject(rl, '  Agent output JSON (Enter for {}): ');
          } else {
            // auto step
            const hint =
              stepDef.handler !== undefined
                ? `handler: ${stepDef.handler}`
                : stepDef.uses_service !== undefined
                  ? `service: ${stepDef.uses_service}`
                  : 'auto';
            promptStep = stepName;
            userOutput = await askJsonObject(rl, `  Mock output (${hint}) — JSON (Enter for {}): `);
          }

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

          if (result.status === 'ok') {
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
            (result.error_code === 'ENGINE_HANDLER_NOT_REGISTERED' ||
              result.error_code === 'ENGINE_ADAPTER_NOT_REGISTERED') &&
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
          console.error(renderDetachMap(record, promptStep, { driveFlags }));
          // process.exit SKIPS the finally, so close explicitly. (rl.close is idempotent, so
          // the double-close on any path that reaches both is harmless — probed.)
          rl.close();
          // Exit 1, not 130: readline consumed the keypress and the process was never signalled,
          // so 130 would claim a death that did not happen.
          process.exit(1);
        }
        throw err;
      } finally {
        rl.close();
      }

      // issue #468 — the exit code tells the truth. `run` is declared outside the try, so by the
      // time control reaches here the finally above has already closed `rl` on every path that
      // gets this far (the catch's ABORT_ERR arm exits directly and never falls through to here).
      // Only the while condition being false gets here — the stall exits from inside the try
      // above — so `run.terminal_state` is always true at this point.
      if (deriveRunPhase(run) === 'completed') {
        console.log(`Run complete. Phase: ${run.run_phase}`);
        // NATURAL RETURN — never process.exit(0): three declared controls (run-detach.test.ts's
        // R1/R2/R3) pin the completed path as an unwrapped, un-exited resolution.
        // completed-with-failed-steps (the #302 world) exits 0 too, here — outcome-keyed,
        // consistent with the engine's own seal ruling; #304's run-health finding +
        // terminal_reason are the disclosure channel, not this exit code.
        return;
      }
      console.log(`Run complete. Phase: ${run.run_phase}`);
      process.exit(1);
    },
  );
