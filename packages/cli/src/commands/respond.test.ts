// Tests for respondToGate — CLI respond command logic.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { respondToGate } from './respond.js';
import {
  JsonFileStore,
  JsonWorkflowStore,
  WorkflowError,
  ExtensionRegistry,
  executeStep,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { WorkflowDefinition, StepHandler } from '@sensigo/realm';

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
      new ExtensionRegistry(), // inject empty registry — keep the test hermetic (no fs loader)
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
      respondToGate(
        run.id,
        { gate: 'wrong-gate-id', choice: 'approve' },
        runStore,
        workflowStore,
        new ExtensionRegistry(), // inject empty registry — keep the test hermetic (no fs loader)
      ),
    ).rejects.toThrow(WorkflowError);
  });
});

// A gated workflow whose on_outcome: complete finalizer uses a PROJECT handler registered
// only in a custom registry (never the default filesystem-only registry).
const gateFinalizerWorkflow: WorkflowDefinition = {
  id: 'respond-finalizer-wf',
  name: 'Respond Finalizer Workflow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    'step-one': {
      description: 'Auto step with gate',
      execution: 'auto',
      trust: 'human_confirmed',
      gate: { choices: ['approve', 'reject'] },
    },
    record_outcome: {
      description: 'Record terminal outcome',
      execution: 'finalizer',
      on_outcome: 'complete',
      handler: 'record_outcome',
    },
  },
};

describe('respondToGate — fires finalizers on gate completion (registry threaded)', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-respond-fin-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-respond-fin-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(gateFinalizerWorkflow);
  });

  async function openGate(): Promise<{ runId: string; gateId: string }> {
    const { run } = await runStore.create({
      workflowId: 'respond-finalizer-wf',
      workflowVersion: 1,
      params: {},
    });
    const gateEnvelope = await executeStep(runStore, gateFinalizerWorkflow, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: async () => ({}),
    });
    expect(gateEnvelope.status).toBe('confirm_required');
    return { runId: run.id, gateId: gateEnvelope.gate!.gate_id };
  }

  it('runs the complete finalizer with a project handler when the injected registry provides it', async () => {
    const ran = vi.fn();
    const handler: StepHandler = {
      id: 'record_outcome',
      execute: vi.fn(async () => {
        ran();
        return { data: { recorded: true } };
      }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'record_outcome', handler);

    const { runId, gateId } = await openGate();
    const { newState } = await respondToGate(
      runId,
      { gate: gateId, choice: 'approve' },
      runStore,
      workflowStore,
      registry,
    );

    expect(newState).toBe('completed');
    expect(ran).toHaveBeenCalledTimes(1);
    const updated = await runStore.get(runId);
    expect(updated.completed_steps).toContain('record_outcome');
    expect(updated.evidence.some((e) => e.step_id === 'record_outcome')).toBe(true);
  });

  it('records the finalizer as a NON-FATAL failure when the registry lacks its handler (run still completes)', async () => {
    // Control: a registry without the project handler → handler-not-found is recorded, but the
    // run outcome is unchanged (finalizer failure never un-completes the run).
    const { runId, gateId } = await openGate();
    const { newState } = await respondToGate(
      runId,
      { gate: gateId, choice: 'approve' },
      runStore,
      workflowStore,
      new ExtensionRegistry(), // empty — no 'record_outcome' handler
    );

    expect(newState).toBe('completed');
    const updated = await runStore.get(runId);
    expect(updated.failed_steps).toContain('record_outcome');
    expect(updated.completed_steps).not.toContain('record_outcome');
  });
});
