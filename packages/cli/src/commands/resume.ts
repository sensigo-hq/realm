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
  const { terminal_reason: _terminalReason, ...rest } = run;
  const failedSteps = rest.failed_steps.filter((s) => s !== stepName);
  const skippedSteps = propagateSkips(
    { ...rest, failed_steps: failedSteps, skipped_steps: [] as string[] },
    workflow,
  );
  await runStore.update({
    ...rest,
    failed_steps: failedSteps,
    skipped_steps: skippedSteps,
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
