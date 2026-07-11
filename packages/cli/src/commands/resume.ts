// resume command — removes a step from failed_steps so it can be re-executed.
import { Command } from 'commander';
import type { RunStore } from '@sensigo/realm';
import type { WorkflowRegistrar } from '@sensigo/realm';
import { WorkflowError } from '@sensigo/realm';
import { RESUMABLE_PHASES, propagateSkips } from '@sensigo/realm';

/**
 * Removes `stepName` from `failed_steps` so the DAG engine can re-evaluate its
 * eligibility on the next execute-step call.
 *
 * @param runId         The run to resume.
 * @param stepName      The failed step to re-enable.
 * @param runStore      Store holding run records.
 * @param workflowStore Registrar for workflow definitions.
 */
export async function resumeRun(
  runId: string,
  stepName: string,
  runStore: RunStore,
  workflowStore: WorkflowRegistrar,
): Promise<void> {
  const run = await runStore.get(runId);

  if (!RESUMABLE_PHASES.has(run.run_phase)) {
    throw new WorkflowError(
      `Run ${runId} is in phase '${run.run_phase}', which is not resumable.`,
      {
        code: 'STATE_TRANSITION_DENIED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      },
    );
  }

  const workflow = await workflowStore.get(run.workflow_id);

  if (workflow.steps[stepName] === undefined) {
    throw new WorkflowError(`Step '${stepName}' not found in workflow '${run.workflow_id}'.`, {
      code: 'STEP_NOT_FOUND',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  if (!run.failed_steps.includes(stepName)) {
    throw new WorkflowError(`Step '${stepName}' is not in failed_steps for run '${runId}'.`, {
      code: 'STATE_TRANSITION_DENIED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  // Re-enable the failed step AND make the run runnable again. Filtering failed_steps alone leaves
  // the run terminal (terminal_state:true), so `realm agent --run-id` throws on it and the
  // `while (!terminal_state)` drivers skip it. Mirror the test-harness reference: strip
  // terminal_reason (destructure-and-omit to honour exactOptionalPropertyTypes), re-derive
  // skipped_steps from scratch so steps skipped only because of this failure become eligible again,
  // and reset terminal_state to false. update() recomputes run_phase → 'running'.
  //
  // #111 clean slate: `...rest` still carries the run's stale `skip_details` — it MUST be reset
  // to `{}` alongside `skipped_steps: []`, or an orphaned detail would survive for a step that is
  // now re-eligible (violating `Object.keys(skip_details) ⊆ skipped_steps` isn't the risk here —
  // the risk is a STALE-but-still-valid-looking reason for a step that no longer has one).
  // No handler/guard-abort detail is re-mintable by this propagateSkips-only recompute — that is
  // fine and unreachable: resume is gated to failed/abandoned phases (RESUMABLE_PHASES), never
  // the aborted phase a handler/guard abort produces.
  const { terminal_reason: _terminalReason, ...rest } = run;
  const failedSteps = rest.failed_steps.filter((s) => s !== stepName);
  const { skipped: skippedSteps, details: skipDetails } = propagateSkips(
    { ...rest, failed_steps: failedSteps, skipped_steps: [] as string[], skip_details: {} },
    workflow,
  );
  await runStore.update({
    ...rest,
    failed_steps: failedSteps,
    skipped_steps: skippedSteps,
    skip_details: skipDetails,
    terminal_state: false,
  });
}

export const resumeCommand = new Command('resume')
  .description('Remove a step from failed_steps so it can be re-executed')
  .argument('<run-id>', 'ID of the run to resume')
  .requiredOption('--from <step>', 'Name of the failed step to re-enable')
  .action(async (runId: string, opts: { from: string }) => {
    const { JsonFileStore, JsonWorkflowStore } = await import('@sensigo/realm');
    const runStore = new JsonFileStore();
    const workflowStore = new JsonWorkflowStore();
    try {
      await resumeRun(runId, opts.from, runStore, workflowStore);
      console.log(
        `Resumed run '${runId}': step '${opts.from}' re-enabled and run reset to 'running'.\n` +
          `Drive it with: realm agent --run-id ${runId}`,
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
