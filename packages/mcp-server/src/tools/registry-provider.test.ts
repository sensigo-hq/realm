// Tests for registryProvider (project extensions injection) and the create_workflow
// `extensions` rejection. The provider must be awaited BEFORE runStore.create in
// start_run / start_run_batch (throwing provider → no run created) and before execution
// in execute_step; it wins over the construction-time registry when both are supplied.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { WorkflowDefinition, ServiceAdapter } from '@sensigo/realm';
import { handleStartRun } from './start-run.js';
import { handleStartRunBatch } from './start-run-batch.js';
import { handleExecuteStep } from './execute-step.js';
import { handleCreateWorkflow, type CreateWorkflowArgs } from './create-workflow.js';

function makeAdapterDef(): WorkflowDefinition {
  return {
    id: 'svc-wf',
    name: 'Service WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    services: { custom_svc: { adapter: 'custom_adapter', trust: 'engine_managed' } },
    steps: {
      fetch_data: { description: 'fetch', execution: 'auto', uses_service: 'custom_svc' },
    },
  };
}

function makeRecordingAdapter(calls: string[]): ServiceAdapter {
  return {
    id: 'custom_adapter',
    fetch: async (operation) => {
      calls.push(operation);
      return { status: 200, data: { fetched: true } };
    },
    create: async () => ({ status: 201, data: {} }),
    update: async () => ({ status: 200, data: {} }),
  };
}

describe('registryProvider', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-rp-runs-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-rp-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeAdapterDef());
  });

  async function runFileCount(): Promise<number> {
    const entries = await readdir(runDir);
    return entries.filter((f) => f.endsWith('.json')).length;
  }

  it('start_run: a throwing provider fails the call with NO run created', async () => {
    const registryProvider = vi.fn(async () => {
      throw new Error('broken extensions module');
    });
    await expect(
      handleStartRun({ workflow_id: 'svc-wf' }, { runStore, workflowStore, registryProvider }),
    ).rejects.toThrow('broken extensions module');
    expect(registryProvider).toHaveBeenCalledTimes(1);
    expect(await runFileCount()).toBe(0);
  });

  it('start_run: the provider registry is used for step execution and wins over `registry`', async () => {
    const calls: string[] = [];
    const providerRegistry = createDefaultRegistry();
    providerRegistry.register('adapter', 'custom_adapter', makeRecordingAdapter(calls));
    const registryProvider = vi.fn(async (definition: WorkflowDefinition) => {
      expect(definition.id).toBe('svc-wf');
      return providerRegistry;
    });
    // Construction-time registry deliberately lacks the adapter — provider must win.
    const emptyRegistry = new ExtensionRegistry();

    const result = await handleStartRun(
      { workflow_id: 'svc-wf' },
      { runStore, workflowStore, registry: emptyRegistry, registryProvider },
    );
    expect(result.status).toBe('ok');
    expect(calls).toEqual(['fetch_data']);
  });

  it('start_run_batch: a throwing provider fails the batch with NO runs created', async () => {
    const registryProvider = vi.fn(async () => {
      throw new Error('broken extensions module');
    });
    await expect(
      handleStartRunBatch(
        { workflow_id: 'svc-wf', items: [{ params: {} }, { params: {} }] },
        { runStore, workflowStore, registryProvider },
      ),
    ).rejects.toThrow('broken extensions module');
    expect(await runFileCount()).toBe(0);
  });

  it('execute_step: a throwing provider fails before execution', async () => {
    // Create the run without a provider, then attach a broken one for execution.
    const okRegistry = createDefaultRegistry();
    okRegistry.register('adapter', 'custom_adapter', makeRecordingAdapter([]));
    const started = await handleStartRun(
      { workflow_id: 'svc-wf' },
      { runStore, workflowStore, registry: okRegistry },
    );
    const registryProvider = vi.fn(async () => {
      throw new Error('broken extensions module');
    });
    await expect(
      handleExecuteStep(
        { run_id: started.run_id, command: 'fetch_data' },
        { runStore, workflowStore, registryProvider },
      ),
    ).rejects.toThrow('broken extensions module');
  });
});

describe('create_workflow extensions rejection', () => {
  let runDir: string;
  let workflowDir: string;
  let stores: { runStore: JsonFileStore; workflowStore: JsonWorkflowStore };

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-cwext-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-cwext-wf-'));
    stores = {
      runStore: new JsonFileStore(runDir),
      workflowStore: new JsonWorkflowStore(workflowDir),
    };
  });

  it('rejects a top-level extensions key with the register-time/operator-only error', async () => {
    const args = {
      steps: [{ id: 'step-a', description: 'Do something' }],
      extensions: './registry.js',
    } as CreateWorkflowArgs;
    const result = await handleCreateWorkflow(args, stores);
    expect(result.status).toBe('error');
    expect(result.errors.join(' ')).toContain('register-time and operator-only');
    // Nothing was registered.
    expect(await stores.workflowStore.list()).toHaveLength(0);
  });

  it('rejects a per-step extensions key (mirrors the agent_profile rejection)', async () => {
    const args = {
      steps: [{ id: 'step-a', description: 'Do something', extensions: './x.js' } as never],
    } as CreateWorkflowArgs;
    const result = await handleCreateWorkflow(args, stores);
    expect(result.status).toBe('error');
    expect(result.errors.join(' ')).toContain("Step 'step-a': extensions is not supported");
  });
});
