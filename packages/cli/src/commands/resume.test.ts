// Tests for the resumeRun function — CLI resume command logic.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRun } from './resume.js';
import {
  JsonFileStore,
  JsonWorkflowStore,
  WorkflowError,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  findEligibleSteps,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';

/** Two-step workflow (step-a → step-b) — used to prove skipped_steps re-derivation on resume. */
const redriveWorkflow: WorkflowDefinition = {
  id: 'resume-redrive-wf',
  name: 'Resume Re-drive Workflow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    'step-a': { description: 'First step', execution: 'agent' },
    'step-b': { description: 'Second step', execution: 'agent', depends_on: ['step-a'] },
  },
};

const testWorkflow: WorkflowDefinition = {
  id: 'resume-test-wf',
  name: 'Resume Test Workflow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    'step-one': {
      description: 'First step',
      execution: 'auto',
    },
  },
};

describe('resumeRun', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-resume-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-resume-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(testWorkflow);
  });

  it('removes the step from failed_steps, re-enabling it for execution', async () => {
    const run = await runStore.create({
      workflowId: 'resume-test-wf',
      workflowVersion: 1,
      params: {},
    });
    // Simulate a failed run
    await runStore.update({
      ...run,
      run_phase: 'failed',
      failed_steps: ['step-one'],
      terminal_state: true,
      terminal_reason: 'Something went wrong',
    });

    await resumeRun(run.id, 'step-one', runStore, workflowStore);

    const updated = await runStore.get(run.id);
    expect(updated.failed_steps).not.toContain('step-one');
  });

  it('throws when the run is in a non-resumable state (completed)', async () => {
    const run = await runStore.create({
      workflowId: 'resume-test-wf',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
    });

    await expect(resumeRun(run.id, 'step-one', runStore, workflowStore)).rejects.toThrow(
      WorkflowError,
    );

    await expect(resumeRun(run.id, 'step-one', runStore, workflowStore)).rejects.toThrow(
      'is not resumable',
    );
  });

  it('throws when the step name does not exist in the workflow', async () => {
    const run = await runStore.create({
      workflowId: 'resume-test-wf',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      run_phase: 'failed',
      failed_steps: ['step-one'],
      terminal_state: true,
      terminal_reason: 'Something went wrong',
    });

    await expect(resumeRun(run.id, 'nonexistent-step', runStore, workflowStore)).rejects.toThrow(
      WorkflowError,
    );

    await expect(resumeRun(run.id, 'nonexistent-step', runStore, workflowStore)).rejects.toThrow(
      'not found',
    );
  });

  it('re-drives a failed run: resets to running, clears terminal_reason, re-derives skipped_steps, re-enables the step', async () => {
    await workflowStore.register(redriveWorkflow);
    const run = await runStore.create({
      workflowId: 'resume-redrive-wf',
      workflowVersion: 1,
      params: {},
    });
    // step-a failed → step-b was skipped (all_success can no longer be satisfied) → run terminal failed.
    await runStore.update({
      ...run,
      run_phase: 'failed',
      failed_steps: ['step-a'],
      skipped_steps: ['step-b'],
      terminal_state: true,
      terminal_reason: 'step-a failed',
    });

    await resumeRun(run.id, 'step-a', runStore, workflowStore);

    const resumed = await runStore.get(run.id);
    expect(resumed.terminal_state).toBe(false);
    expect(resumed.run_phase).toBe('running');
    expect(resumed.failed_steps).not.toContain('step-a');
    expect(resumed.terminal_reason).toBeUndefined();
    // step-b was skipped only because step-a failed — re-derived away now that step-a is re-enabled.
    expect(resumed.skipped_steps).not.toContain('step-b');
    // The re-enabled step is now eligible (proving the run is genuinely runnable again).
    expect(findEligibleSteps(redriveWorkflow, resumed)).toContain('step-a');
  });
});
