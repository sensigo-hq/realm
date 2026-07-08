// Part A behavioral tests for recoverable incapability (issue #134).
//
// The pre-existing not-registered tests in execution-loop.test.ts assert only `status:'error'` + the
// message — which the RECOVERABLE envelope preserves, so they cannot distinguish terminal-burn from
// recoverable-settle. These tests assert the SETTLE behavior directly (not in failed_steps, run stays
// running, a capability_blocks marker is written, error_code discriminates, and a fixed registry
// RECOVERS the step) plus the genuine-failure path staying terminal. They use the REAL empty-registry
// path, never the testing mocks (which throw the generic *_FAILED codes = terminal).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep } from './execution-loop.js';
import { findCapabilityBlockedSteps } from './capability.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';
import type { StepHandler } from '../extensions/step-handler.js';
import type { ServiceAdapter } from '../extensions/service-adapter.js';

const echo: StepDispatcher = async (_s, input) => ({ ...input });

const handlerDef: WorkflowDefinition = {
  id: 'handler-wf',
  name: 'Handler Workflow',
  version: 1,
  steps: {
    validate: { description: 'Validate', execution: 'auto', depends_on: [], handler: 'my_handler' },
  },
};

const adapterDef: WorkflowDefinition = {
  id: 'adapter-wf',
  name: 'Adapter Workflow',
  version: 1,
  services: { my_service: { adapter: 'mock_adapter', trust: 'engine_delivered' } },
  steps: {
    fetch_data: {
      description: 'Fetch',
      execution: 'auto',
      depends_on: [],
      uses_service: 'my_service',
    },
  },
};

function goodHandler(): StepHandler {
  return { id: 'my_handler', execute: async () => ({ data: { ok: true } }) };
}
function goodAdapter(): ServiceAdapter {
  return {
    id: 'mock_adapter',
    fetch: async () => ({ status: 200, data: { fetched: true } }),
    create: async () => ({ status: 200, data: {} }),
    update: async () => ({ status: 200, data: {} }),
  };
}

describe('recoverable incapability (#134) — Part A', () => {
  let store: JsonFileStore;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-cap-test-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Test 1a — handler-not-registered settles recoverably and RECOVERS on a fixed registry.
  it('handler-not-registered settles recoverably (not terminal-burned) and recovers', async () => {
    const { run } = await store.create({
      workflowId: 'handler-wf',
      workflowVersion: 1,
      params: {},
    });
    const env = await executeStep(store, handlerDef, {
      runId: run.id,
      command: 'validate',
      input: {},
      dispatcher: echo,
      registry: new ExtensionRegistry(), // empty — the REAL not-registered path
    });

    expect(env.status).toBe('error');
    expect(env.error_code).toBe('ENGINE_HANDLER_NOT_REGISTERED');
    expect(env.agent_action).toBe('report_to_user'); // non-terminal mapping, not 'stop'

    const after = await store.get(run.id);
    expect(after.failed_steps).not.toContain('validate'); // NOT terminal-burned
    expect(after.in_progress_steps).not.toContain('validate'); // claim released
    expect(after.claims?.['validate']).toBeUndefined();
    expect(after.terminal_state).toBe(false);
    expect(after.run_phase).toBe('running');
    expect(after.capability_blocks?.['validate']).toBeDefined();
    expect(after.capability_blocks?.['validate']?.requirement).toEqual({
      kind: 'handler',
      name: 'my_handler',
    });
    expect(after.capability_blocks?.['validate']?.code).toBe('ENGINE_HANDLER_NOT_REGISTERED');

    // Recovery: a runner that now provides the handler re-executes the SAME eligible step to completion.
    const good = new ExtensionRegistry();
    good.register('handler', 'my_handler', goodHandler());
    const recovered = await executeStep(store, handlerDef, {
      runId: run.id,
      command: 'validate',
      input: {},
      dispatcher: echo,
      registry: good,
    });
    expect(recovered.status).toBe('ok');
    const done = await store.get(run.id);
    expect(done.completed_steps).toContain('validate');
    expect(done.terminal_state).toBe(true); // only step → run completes
    // Self-suppression: the lingering marker no longer surfaces once the step is settled.
    expect(findCapabilityBlockedSteps(done)).toHaveLength(0);
  });

  // Test 1b — adapter-not-registered settles recoverably and RECOVERS on a fixed registry.
  it('adapter-not-registered settles recoverably (not terminal-burned) and recovers', async () => {
    const { run } = await store.create({
      workflowId: 'adapter-wf',
      workflowVersion: 1,
      params: {},
    });
    const env = await executeStep(store, adapterDef, {
      runId: run.id,
      command: 'fetch_data',
      input: {},
      dispatcher: echo,
      registry: new ExtensionRegistry(), // empty
    });

    expect(env.status).toBe('error');
    expect(env.error_code).toBe('ENGINE_ADAPTER_NOT_REGISTERED');

    const after = await store.get(run.id);
    expect(after.failed_steps).not.toContain('fetch_data');
    expect(after.terminal_state).toBe(false);
    expect(after.run_phase).toBe('running');
    expect(after.capability_blocks?.['fetch_data']?.requirement).toEqual({
      kind: 'adapter',
      name: 'mock_adapter',
    });

    const good = new ExtensionRegistry();
    good.register('adapter', 'mock_adapter', goodAdapter());
    const recovered = await executeStep(store, adapterDef, {
      runId: run.id,
      command: 'fetch_data',
      input: {},
      dispatcher: echo,
      registry: good,
    });
    expect(recovered.status).toBe('ok');
    expect((await store.get(run.id)).completed_steps).toContain('fetch_data');
  });

  // Test 2 — retry-wrap seam: max_attempts:1 + empty registry stays recoverable, NOT STEP_RETRY_EXHAUSTED.
  it('retry max_attempts:1 + not-registered stays recoverable (not STEP_RETRY_EXHAUSTED)', async () => {
    const retryDef: WorkflowDefinition = {
      ...handlerDef,
      steps: {
        validate: { ...handlerDef.steps['validate']!, retry: { max_attempts: 1 } },
      },
    };
    const { run } = await store.create({
      workflowId: 'handler-wf',
      workflowVersion: 1,
      params: {},
    });
    const env = await executeStep(store, retryDef, {
      runId: run.id,
      command: 'validate',
      input: {},
      dispatcher: echo,
      registry: new ExtensionRegistry(),
    });

    expect(env.error_code).toBe('ENGINE_HANDLER_NOT_REGISTERED'); // NOT wrapped to STEP_RETRY_EXHAUSTED
    expect(env.errors[0]).not.toContain('after 1 attempts');
    const after = await store.get(run.id);
    expect(after.failed_steps).not.toContain('validate');
    expect(after.terminal_state).toBe(false);
    expect(after.capability_blocks?.['validate']).toBeDefined();
  });

  // Test 3 — genuine failures stay TERMINAL (the mutation guard: widening the Step-5 predicate to
  // include ENGINE_HANDLER_FAILED / ADAPTER_* would redden these).
  it('handler ran-and-threw stays terminal (ENGINE_HANDLER_FAILED)', async () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'my_handler', {
      id: 'my_handler',
      execute: async () => {
        throw new Error('boom');
      },
    });
    const { run } = await store.create({
      workflowId: 'handler-wf',
      workflowVersion: 1,
      params: {},
    });
    const env = await executeStep(store, handlerDef, {
      runId: run.id,
      command: 'validate',
      input: {},
      dispatcher: echo,
      registry,
    });
    expect(env.status).toBe('error');
    const after = await store.get(run.id);
    expect(after.failed_steps).toContain('validate'); // terminal-burned
    expect(after.terminal_state).toBe(true);
    expect(after.capability_blocks).toBeUndefined(); // no recoverable marker
  });

  it('service-not-found stays terminal (ENGINE_ADAPTER_FAILED, not the not-registered code)', async () => {
    const badDef: WorkflowDefinition = {
      id: 'adapter-wf',
      name: 'Adapter Workflow',
      version: 1,
      // No services declared → uses_service resolves to undefined → service-not-found (terminal).
      steps: {
        fetch_data: {
          description: 'Fetch',
          execution: 'auto',
          depends_on: [],
          uses_service: 'missing_service',
        },
      },
    };
    const { run } = await store.create({
      workflowId: 'adapter-wf',
      workflowVersion: 1,
      params: {},
    });
    const env = await executeStep(store, badDef, {
      runId: run.id,
      command: 'fetch_data',
      input: {},
      dispatcher: echo,
      registry: new ExtensionRegistry(),
    });
    expect(env.status).toBe('error');
    expect(env.error_code).not.toBe('ENGINE_ADAPTER_NOT_REGISTERED');
    const after = await store.get(run.id);
    expect(after.failed_steps).toContain('fetch_data');
    expect(after.terminal_state).toBe(true);
    expect(after.capability_blocks).toBeUndefined();
  });

  it('ADAPTER_OP_UNSUPPORTED stays terminal', async () => {
    const registry = new ExtensionRegistry();
    // Registered, but the requested service_method is absent → ADAPTER_OP_UNSUPPORTED (terminal).
    registry.register('adapter', 'mock_adapter', {
      id: 'mock_adapter',
      fetch: async () => ({ status: 200, data: {} }),
      create: async () => ({ status: 200, data: {} }),
      update: async () => ({ status: 200, data: {} }),
    });
    const opDef: WorkflowDefinition = {
      ...adapterDef,
      steps: {
        fetch_data: { ...adapterDef.steps['fetch_data']!, service_method: 'delete' },
      },
    };
    const { run } = await store.create({
      workflowId: 'adapter-wf',
      workflowVersion: 1,
      params: {},
    });
    const env = await executeStep(store, opDef, {
      runId: run.id,
      command: 'fetch_data',
      input: {},
      dispatcher: echo,
      registry,
    });
    expect(env.status).toBe('error');
    expect(env.error_code).not.toBe('ENGINE_ADAPTER_NOT_REGISTERED');
    const after = await store.get(run.id);
    expect(after.failed_steps).toContain('fetch_data');
    expect(after.terminal_state).toBe(true);
  });
});
