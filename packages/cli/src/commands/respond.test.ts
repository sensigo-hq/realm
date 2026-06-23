// Tests for respondToGate — CLI respond command logic.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { respondToGate } from './respond.js';
import {
  JsonFileStore,
  JsonWorkflowStore,
  WorkflowError,
  executeStep,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';

const gateWorkflow: WorkflowDefinition = {
  id: 'respond-test-wf',
  name: 'Respond Test Workflow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    'step-one': {
      description: 'Auto step with gate',
      execution: 'auto',
      trust: 'human_confirmed',
      gate: { choices: ['approve', 'reject'] },
    },
  },
};

describe('respondToGate', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-respond-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-respond-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(gateWorkflow);
  });

  it('advances a gate-waiting run to completed on valid choice', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'respond-test-wf',
      workflowVersion: 1,
      params: {},
    });

    // Open the gate via executeStep.
    const gateEnvelope = await executeStep(runStore, gateWorkflow, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: async () => ({}),
    });
    expect(gateEnvelope.status).toBe('confirm_required');

    const { choice, newState } = await respondToGate(
      run.id,
      { gate: gateEnvelope.gate!.gate_id, choice: 'approve' },
      runStore,
      workflowStore,
    );

    expect(choice).toBe('approve');
    expect(newState).toBe('completed');

    const updated = await runStore.get(run.id);
    expect(updated.run_phase).toBe('completed');
  });

  it('throws WorkflowError when gate_id does not match', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'respond-test-wf',
      workflowVersion: 1,
      params: {},
    });

    await executeStep(runStore, gateWorkflow, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: async () => ({}),
    });

    await expect(
      respondToGate(run.id, { gate: 'wrong-gate-id', choice: 'approve' }, runStore, workflowStore),
    ).rejects.toThrow(WorkflowError);
  });
});
