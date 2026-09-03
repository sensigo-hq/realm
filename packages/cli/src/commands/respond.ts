// respond command — submits a human gate response for a gate-waiting run.
import { Command } from 'commander';
import type { RunStore } from '@sensigo/realm';
import type { WorkflowRegistrar } from '@sensigo/realm';
import type { ExtensionRegistry } from '@sensigo/realm';
import { WorkflowError, submitHumanResponse, getWorkflowForRun } from '@sensigo/realm';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';

/**
 * Submits a human choice response for a gate-waiting run.
 * @param runId         The run awaiting a gate response.
 * @param options       `gate` is the gate_id; `choice` is the selected option.
 * @param runStore      Store holding run records.
 * @param workflowStore Registrar for workflow definitions.
 * @returns The choice submitted and the new run state after the gate advances.
 */
export async function respondToGate(
  runId: string,
  options: { gate: string; choice: string; project?: string; extensionsModule?: string },
  runStore: RunStore,
  workflowStore: WorkflowRegistrar,
  registry?: ExtensionRegistry,
): Promise<{ choice: string; newState: string }> {
  const run = await runStore.get(runId);
  // issue #456: code-keyed one-time-register remedy, shared with every other run-context site.
  const workflow = await getWorkflowForRun(workflowStore, run, { retryVerb: 'respond again' });

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
  });

  if (result.status !== 'ok') {
    throw new WorkflowError(result.errors[0] ?? 'Gate response failed', {
      code: 'STATE_BLOCKED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  const updatedRun = await runStore.get(runId);
  return { choice: options.choice, newState: updatedRun.run_phase };
}

export const respondCommand = new Command('respond')
  .description('Submit a human gate response to advance a gate-waiting run')
  .argument('<run-id>', 'ID of the run waiting at a gate')
  .requiredOption('--gate <gate-id>', 'Gate ID from the confirm_required response')
  .requiredOption('--choice <choice>', 'The choice to submit (e.g. approve, reject)')
  .option(
    '--project <dir>',
    'CONFIG anchor: deployment root whose realm.yaml applies to definitions without a stored trust_root (default: current directory)',
  )
  .option(
    '--extensions-module <path>',
    "CODE override: module that REPLACES the workflow's declared 'extensions' modules (repair tool)",
  )
  .action(
    async (
      runId: string,
      opts: { gate: string; choice: string; project?: string; extensionsModule?: string },
    ) => {
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
        const { choice, newState } = await respondToGate(
          runId,
          opts,
          runStore,
          workflowStore,
          registry,
        );
        console.log(`Responded: ${runId} | choice '${choice}' | new state '${newState}'`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    },
  );
