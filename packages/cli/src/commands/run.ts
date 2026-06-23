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
} from '@sensigo/realm';
import type { WorkflowDefinition, StepDefinition } from '@sensigo/realm';
import type { StepDispatcher } from '@sensigo/realm';

export const runCommand = new Command('run')
  .argument('<path>', 'Path to workflow directory or workflow.yaml file')
  .option('--params <json>', 'Initial run parameters as JSON string', '{}')
  .description('Run a workflow interactively (development mode)')
  .action(async (inputPath: string, options: { params: string }) => {
    const filePath =
      inputPath.endsWith('.yaml') || inputPath.endsWith('.yml')
        ? inputPath
        : join(inputPath, 'workflow.yaml');

    // 1. Load workflow
    let definition: WorkflowDefinition;
    try {
      definition = loadWorkflowFromFile(filePath);
    } catch (err) {
      console.error(`Error loading workflow: ${err instanceof Error ? err.message : String(err)}`);
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

    // 3. Create store and initial run record
    const store = new JsonFileStore();

    const { run: initialRecord } = await store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params,
    });
    const runId = initialRecord.id;

    console.log(`\nRealm — ${definition.name} v${definition.version}`);
    console.log(`Run ID: ${runId}\n`);

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
          const raw = await rl.question(`  Choice [${g.choices.join('/')}]: `);
          const choice = raw.trim();
          const respondResult = await submitHumanResponse(store, definition, {
            runId,
            gateId: g.gate_id,
            choice,
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
  });
