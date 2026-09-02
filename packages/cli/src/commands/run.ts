// realm run <path> — interactive workflow runner (development driver).
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import {
  loadWorkflowFromFile,
  JsonFileStore,
  findEligibleSteps,
  executeChain,
  submitHumanResponse,
  unmetCapabilities,
  capabilityWarning,
  WorkflowError,
  deriveRunPhase,
} from '@sensigo/realm';
import { renderLoadFailure } from '../lib/loader-warnings.js';
import type {
  WorkflowDefinition,
  StepDefinition,
  ExtensionRegistry,
  RunRecord,
} from '@sensigo/realm';
import type { StepDispatcher } from '@sensigo/realm';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';
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
 * An authored-empty `choices: []` renders an empty alternation — that run is already
 * human-unresolvable, which is issue #433's to make unmintable at the loader; not special-cased
 * here.
 *
 * @internal Exported for testing only.
 */
export function renderDetachMap(record: RunRecord, promptStep: string | undefined): string {
  // DERIVED, never the persisted field: a record can carry a stale `run_phase` that disagrees
  // with what its own seal says (issue #432's class), and a map that names the wrong phase sends
  // an operator to the wrong remedy.
  const phase = deriveRunPhase(record);
  const step = promptStep ?? record.pending_gate?.step_name ?? '(step unknown)';
  const lines = [
    `Prompt cancelled — detached from run '${record.id}' at step '${step}' (phase: ${phase}). The run is saved.`,
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

  lines.push(`  Drive it:  realm agent --run-id ${record.id}`);
  lines.push(`  Inspect:   realm run inspect ${record.id}`);
  lines.push(`  Discard:   realm run abandon ${record.id}`);
  return lines.join('\n');
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
      // issue #197 PR-2 (design §8): the strict-flip force-enables minting even without the flag.
      const mintWriterNonce = options.mintWriterNonce === true || isWriterNonceRequired();
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
      // member up. The placement is load → extensions → params → HERE, and each boundary is
      // pinned: earlier than the load and the loader-voice cells lose their messages; earlier
      // than extensions and the spawned orphan-manifest case loses its refusal; earlier than
      // params and `--params '{'` reports the wrong problem.
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

      // 3. Create store and initial run record
      const store = new JsonFileStore();
      // issue #207 PR-2 (D3 §5, mixed-wiring gap): construct a JsonTraceBufferStore beside the
      // run store (same runsDir) and thread it into executeChain below — without this, `realm
      // run`'s own dev-mode driver never adopted/fenced a step's streamed WAL trace at all.
      const { JsonTraceBufferStore } = await import('@sensigo/realm-mcp');
      const traceBufferStore = new JsonTraceBufferStore(store.runsDirPath);

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
      const rl = createInterface({ input: process.stdin, output: process.stdout });

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
            const clearExpiryTimer = scheduleGateExpiryTimer(runId, g, {
              store,
              definition,
              registry,
            });
            promptStep = g.step_name;
            const raw = await rl.question(`  Choice [${g.choices.join('/')}]: `).finally(() => {
              clearExpiryTimer();
            });
            const choice = raw.trim();
            const respondResult = await submitHumanResponse(store, definition, {
              runId,
              gateId: g.gate_id,
              choice,
              // Thread the resolved project registry so a gate-completed run fires its
              // finalizers with project handlers (same registry passed to executeChain below).
              registry,
            });
            if (respondResult.status === 'ok') {
              run = await store.get(runId);
              console.log(`  ✓ → ${run.run_phase}\n`);
            } else {
              console.error(`  ✗ ${respondResult.errors.join(', ')}\n`);
              break;
            }
            continue;
          }

          const eligibleSteps = findEligibleSteps(definition, run);

          if (eligibleSteps.length === 0) {
            console.error(`\nNo eligible steps in phase '${run.run_phase}'. Workflow stalled.`);
            break;
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
            input: userOutput,
            dispatcher,
            registry,
            traceBufferStore,
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
          } else {
            console.error(`  ✗ ${result.status}: ${result.errors.join(', ')}\n`);
            break;
          }
        }

        if (run.terminal_state) {
          console.log(`Run complete. Phase: ${run.run_phase}`);
        }
      } catch (err) {
        // issue #447 — the operator cancelled the prompt. Ctrl-D at a pending `rl.question`
        // rejects with an AbortError carrying `code: 'ABORT_ERR'`. Nothing awaits
        // `program.parse()`, so today that surfaces as an unhandled-rejection stack: a saved run
        // that looks like a crash.
        //
        // BOTH Ctrl-D and Ctrl-C land here on a real terminal — measured on this build: ^C at a
        // live prompt printed the full map and exited 1. What decides it is the WIRING, not the
        // key: readline enables raw mode only in terminal mode, which requires `output.isTTY`.
        // With stdout PIPED, readline never takes the terminal path and ^C takes the
        // signal/inert route instead (measured: the process died at 130) — out of this catch's
        // reach, and outside anything the map claims.
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
        // out-throws is re-coded ENGINE_HANDLER_FAILED (execution-loop.ts), every engine throw
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
          console.error(renderDetachMap(record, promptStep));
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
    },
  );
