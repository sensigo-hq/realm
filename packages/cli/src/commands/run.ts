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
} from '@sensigo/realm';
import { renderLoadFailure } from '../lib/loader-warnings.js';
import type { WorkflowDefinition, StepDefinition, ExtensionRegistry } from '@sensigo/realm';
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
            const raw = await rl.question('  Agent output JSON (Enter for {}): ');
            userOutput = raw.trim() === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
          } else {
            // auto step
            const hint =
              stepDef.handler !== undefined
                ? `handler: ${stepDef.handler}`
                : stepDef.uses_service !== undefined
                  ? `service: ${stepDef.uses_service}`
                  : 'auto';
            const raw = await rl.question(`  Mock output (${hint}) — JSON (Enter for {}): `);
            userOutput = raw.trim() === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
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
      } finally {
        rl.close();
      }
    },
  );
