// Tests for createGateResponder — the @sensigo/realm-testing gate auto-responder.
// Focus: an optional project registry is threaded into submitHumanResponse so that resolving a
// gate which COMPLETES the run fires the run's finalizers with project handlers (mirrors the
// production gate-resolution drivers). Backward-compatible: the registry param is optional.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExtensionRegistry, executeStep, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition, StepHandler } from '@sensigo/realm';
import { InMemoryStore } from '../store/in-memory-store.js';
import { createGateResponder } from './mock-gate.js';

// A gated workflow whose on_outcome: complete finalizer uses a PROJECT handler — never present
// in the default filesystem-only registry.
function gateFinalizerDef(): WorkflowDefinition {
  return {
    id: 'mock-gate-fin-wf',
    name: 'Mock Gate Finalizer WF',
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

// A plain gated workflow with no finalizers — the backward-compat baseline.
function gateOnlyDef(): WorkflowDefinition {
  return {
    id: 'mock-gate-only-wf',
    name: 'Mock Gate Only WF',
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
}

describe('createGateResponder — registry threading fires finalizers', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  async function openGate(def: WorkflowDefinition): Promise<string> {
    const { run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    const gateEnvelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: async () => ({}),
    });
    expect(gateEnvelope.status).toBe('confirm_required');
    return run.id;
  }

  it('runs the complete finalizer with a project handler when a registry is passed', async () => {
    const def = gateFinalizerDef();
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

    const runId = await openGate(def);
    const result = await createGateResponder(store, def, runId, {}, registry);

    expect(result.status).toBe('ok');
    expect(ran).toHaveBeenCalledTimes(1);
    const updated = await store.get(runId);
    expect(updated.run_phase).toBe('completed');
    expect(updated.completed_steps).toContain('record_outcome');
    expect(updated.evidence.some((e) => e.step_id === 'record_outcome')).toBe(true);
  });

  it('records the finalizer as a NON-FATAL failure when no registry is passed (run still completes)', async () => {
    // Control: without the registry the project handler is unresolvable → handler-not-found is
    // recorded, but the gate still completes the run (finalizer failure is non-fatal).
    const def = gateFinalizerDef();
    const runId = await openGate(def);
    const result = await createGateResponder(store, def, runId, {});

    expect(result.status).toBe('ok');
    const updated = await store.get(runId);
    expect(updated.run_phase).toBe('completed');
    expect(updated.failed_steps).toContain('record_outcome');
    expect(updated.completed_steps).not.toContain('record_outcome');
  });

  it('backward-compatible: an existing-style call with no registry resolves a gate-only workflow', async () => {
    const def = gateOnlyDef();
    const runId = await openGate(def);
    const result = await createGateResponder(store, def, runId, {});

    expect(result.status).toBe('ok');
    const updated = await store.get(runId);
    expect(updated.run_phase).toBe('completed');
  });

  it('honours an explicit gateResponses choice alongside the registry', async () => {
    const def = gateFinalizerDef();
    const handler: StepHandler = {
      id: 'record_outcome',
      execute: vi.fn(async () => ({ data: {} })),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'record_outcome', handler);

    const runId = await openGate(def);
    // Choose the mapped response for step-one explicitly (still a completing choice).
    const result = await createGateResponder(
      store,
      def,
      runId,
      { 'step-one': 'approve' },
      registry,
    );

    expect(result.status).toBe('ok');
    const updated = await store.get(runId);
    expect(updated.run_phase).toBe('completed');
    expect(updated.completed_steps).toContain('record_outcome');
  });
});
