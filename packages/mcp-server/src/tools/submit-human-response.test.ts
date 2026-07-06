// Tests for handleSubmitHumanResponse — the submit_human_response MCP tool.
// Focus: a gate resolution that COMPLETES the run must fire the run's finalizers using the
// project registry threaded via stores.registry / stores.registryProvider (mirrors execute_step).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { WorkflowDefinition, StepHandler } from '@sensigo/realm';
import { handleStartRun } from './start-run.js';
import { handleSubmitHumanResponse } from './submit-human-response.js';

// A gated workflow whose on_outcome: complete finalizer uses a PROJECT handler — never in the
// default filesystem-only registry.
function gateFinalizerDef(): WorkflowDefinition {
  return {
    id: 'mcp-gate-fin-wf',
    name: 'MCP Gate Finalizer WF',
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
}

function recordingHandler(): { handler: StepHandler; ran: () => number } {
  const calls: string[] = [];
  const handler: StepHandler = {
    id: 'record_outcome',
    execute: vi.fn(async () => {
      calls.push('record_outcome');
      return { data: { recorded: true } };
    }),
  };
  return { handler, ran: () => calls.length };
}

describe('handleSubmitHumanResponse — fires finalizers on gate completion', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-mcp-shr-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-mcp-shr-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(gateFinalizerDef());
  });

  async function startAndOpenGate(
    stores: Parameters<typeof handleStartRun>[1],
  ): Promise<{ runId: string; gateId: string }> {
    const started = await handleStartRun({ workflow_id: 'mcp-gate-fin-wf' }, stores);
    const run = await runStore.get(started.run_id);
    expect(run.pending_gate).toBeDefined();
    return { runId: started.run_id, gateId: run.pending_gate!.gate_id };
  }

  it('runs the complete finalizer with a project handler supplied via stores.registry', async () => {
    const { handler, ran } = recordingHandler();
    const registry = new ExtensionRegistry();
    registry.register('handler', 'record_outcome', handler);

    const { runId, gateId } = await startAndOpenGate({ runStore, workflowStore, registry });
    const result = await handleSubmitHumanResponse(
      { run_id: runId, gate_id: gateId, choice: 'approve' },
      { runStore, workflowStore, registry },
    );

    expect(result.run_phase).toBe('completed');
    expect(ran()).toBe(1);
    const updated = await runStore.get(runId);
    expect(updated.completed_steps).toContain('record_outcome');
    expect(updated.evidence.some((e) => e.step_id === 'record_outcome')).toBe(true);
  });

  it('runs the complete finalizer with a project handler supplied via stores.registryProvider (provider wins)', async () => {
    const { handler, ran } = recordingHandler();
    const providerRegistry = new ExtensionRegistry();
    providerRegistry.register('handler', 'record_outcome', handler);
    const registryProvider = vi.fn(async (definition: WorkflowDefinition) => {
      expect(definition.id).toBe('mcp-gate-fin-wf');
      return providerRegistry;
    });
    // Construction-time registry deliberately lacks the handler — the provider must win.
    const emptyRegistry = new ExtensionRegistry();

    const { runId, gateId } = await startAndOpenGate({
      runStore,
      workflowStore,
      registry: emptyRegistry,
      registryProvider,
    });
    const result = await handleSubmitHumanResponse(
      { run_id: runId, gate_id: gateId, choice: 'approve' },
      { runStore, workflowStore, registry: emptyRegistry, registryProvider },
    );

    expect(result.run_phase).toBe('completed');
    expect(registryProvider).toHaveBeenCalled();
    expect(ran()).toBe(1);
    const updated = await runStore.get(runId);
    expect(updated.completed_steps).toContain('record_outcome');
  });

  it('records the finalizer as a NON-FATAL failure when no registry supplies its handler (run still completes)', async () => {
    // Control: neither registry nor provider carries the project handler → handler-not-found is
    // recorded, but the gate still completes the run (finalizer failure is non-fatal).
    const emptyRegistry = new ExtensionRegistry();
    const { runId, gateId } = await startAndOpenGate({
      runStore,
      workflowStore,
      registry: emptyRegistry,
    });
    const result = await handleSubmitHumanResponse(
      { run_id: runId, gate_id: gateId, choice: 'approve' },
      { runStore, workflowStore, registry: emptyRegistry },
    );

    expect(result.run_phase).toBe('completed');
    const updated = await runStore.get(runId);
    expect(updated.failed_steps).toContain('record_outcome');
    expect(updated.completed_steps).not.toContain('record_outcome');
  });
});
