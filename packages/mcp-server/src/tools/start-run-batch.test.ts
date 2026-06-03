// Integration tests for the start_run_batch tool business logic.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, WorkflowError } from '@sensigo/realm';
import { handleStartRunBatch } from './start-run-batch.js';

function mockWorkflow(id: string, paramsSchema?: Record<string, unknown>) {
  return {
    id,
    version: 1,
    ...(paramsSchema !== undefined ? { params_schema: paramsSchema } : {}),
    steps: {},
  };
}

function mockWorkflowStore(workflows: Record<string, ReturnType<typeof mockWorkflow>>) {
  return {
    get: async (id: string) => {
      const wf = workflows[id];
      if (!wf)
        throw new WorkflowError(`Workflow '${id}' not found`, {
          code: 'STATE_WORKFLOW_NOT_FOUND',
          category: 'STATE',
          agentAction: 'stop',
          retryable: false,
        });
      return wf;
    },
  };
}

describe('handleStartRunBatch', () => {
  let runDir: string;
  let runStore: JsonFileStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-srb-'));
    runStore = new JsonFileStore(runDir);
  });

  // -----------------------------------------------------------------------
  // 1. Happy path — single item
  // -----------------------------------------------------------------------
  it('happy path — single item', async () => {
    const wfStore = mockWorkflowStore({ 'wf-1': mockWorkflow('wf-1') });
    const result = await handleStartRunBatch(
      { workflow_id: 'wf-1', items: [{ params: { key: 'val' } }] },
      {
        runStore,
        workflowStore: wfStore as unknown as import('@sensigo/realm').JsonWorkflowStore,
      },
    );
    expect(result.started).toHaveLength(1);
    expect(typeof result.started[0]!.run_id).toBe('string');
    expect(result.started[0]!.params).toEqual({ key: 'val' });
  });

  // -----------------------------------------------------------------------
  // 2. Happy path — multiple items with distinct IDs
  // -----------------------------------------------------------------------
  it('happy path — multiple items produce distinct run IDs', async () => {
    const wfStore = mockWorkflowStore({ 'wf-1': mockWorkflow('wf-1') });
    const result = await handleStartRunBatch(
      {
        workflow_id: 'wf-1',
        items: [{ params: { n: 1 } }, { params: { n: 2 } }, { params: { n: 3 } }],
      },
      {
        runStore,
        workflowStore: wfStore as unknown as import('@sensigo/realm').JsonWorkflowStore,
      },
    );
    expect(result.started).toHaveLength(3);
    const ids = result.started.map((s) => s.run_id);
    expect(new Set(ids).size).toBe(3);
  });

  // -----------------------------------------------------------------------
  // 3. Idempotency key propagated to result
  // -----------------------------------------------------------------------
  it('idempotency key is propagated to the started item', async () => {
    const wfStore = mockWorkflowStore({ 'wf-1': mockWorkflow('wf-1') });
    const result = await handleStartRunBatch(
      { workflow_id: 'wf-1', items: [{ params: {}, idempotency_key: 'k1' }] },
      {
        runStore,
        workflowStore: wfStore as unknown as import('@sensigo/realm').JsonWorkflowStore,
      },
    );
    expect(result.started[0]!.idempotency_key).toBe('k1');
  });

  // -----------------------------------------------------------------------
  // 4. parent_run_id stored on the run record
  // -----------------------------------------------------------------------
  it('parent_run_id is stored on the run record', async () => {
    const wfStore = mockWorkflowStore({ 'wf-1': mockWorkflow('wf-1') });
    const result = await handleStartRunBatch(
      { workflow_id: 'wf-1', items: [{ params: {} }], parent_run_id: 'parent-abc' },
      {
        runStore,
        workflowStore: wfStore as unknown as import('@sensigo/realm').JsonWorkflowStore,
      },
    );
    const run = await runStore.get(result.started[0]!.run_id);
    expect(run.parent_run_id).toBe('parent-abc');
  });

  // -----------------------------------------------------------------------
  // 5. max_items cap exceeded
  // -----------------------------------------------------------------------
  it('throws VALIDATION_BATCH_TOO_LARGE when max_items is exceeded', async () => {
    const wfStore = mockWorkflowStore({ 'wf-1': mockWorkflow('wf-1') });
    await expect(
      handleStartRunBatch(
        {
          workflow_id: 'wf-1',
          items: [{ params: {} }, { params: {} }, { params: {} }],
          max_items: 2,
        },
        {
          runStore,
          workflowStore: wfStore as unknown as import('@sensigo/realm').JsonWorkflowStore,
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_BATCH_TOO_LARGE' });
  });

  // -----------------------------------------------------------------------
  // 6. Default cap of 100
  // -----------------------------------------------------------------------
  it('throws VALIDATION_BATCH_TOO_LARGE when 101 items are passed with default cap', async () => {
    const wfStore = mockWorkflowStore({ 'wf-1': mockWorkflow('wf-1') });
    const items = Array.from({ length: 101 }, () => ({ params: {} }));
    await expect(
      handleStartRunBatch(
        { workflow_id: 'wf-1', items },
        {
          runStore,
          workflowStore: wfStore as unknown as import('@sensigo/realm').JsonWorkflowStore,
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_BATCH_TOO_LARGE' });
  });

  // -----------------------------------------------------------------------
  // 7. Unknown workflow_id — STATE_WORKFLOW_NOT_FOUND propagates
  // -----------------------------------------------------------------------
  it('unknown workflow_id — STATE_WORKFLOW_NOT_FOUND propagates', async () => {
    const wfStore = mockWorkflowStore({});
    await expect(
      handleStartRunBatch(
        { workflow_id: 'no-such-workflow', items: [{ params: {} }] },
        {
          runStore,
          workflowStore: wfStore as unknown as import('@sensigo/realm').JsonWorkflowStore,
        },
      ),
    ).rejects.toMatchObject({ code: 'STATE_WORKFLOW_NOT_FOUND' });
  });

  // -----------------------------------------------------------------------
  // 8. params_schema validation — one item fails
  // -----------------------------------------------------------------------
  it('params_schema validation — one invalid item throws VALIDATION_BATCH_ITEMS', async () => {
    const schema = { required: ['name'], properties: { name: { type: 'string' } } };
    const wfStore = mockWorkflowStore({ 'wf-schema': mockWorkflow('wf-schema', schema) });
    let thrown: WorkflowError | undefined;
    try {
      await handleStartRunBatch(
        {
          workflow_id: 'wf-schema',
          items: [{ params: { name: 'Alice' } }, { params: {} }],
        },
        {
          runStore,
          workflowStore: wfStore as unknown as import('@sensigo/realm').JsonWorkflowStore,
        },
      );
    } catch (err) {
      thrown = err as WorkflowError;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.code).toBe('VALIDATION_BATCH_ITEMS');
    const failures = (thrown!.details as { failures: Array<{ index: number }> }).failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]!.index).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 9. params_schema validation — all items valid
  // -----------------------------------------------------------------------
  it('params_schema validation — all items valid produces no error', async () => {
    const schema = { required: ['name'], properties: { name: { type: 'string' } } };
    const wfStore = mockWorkflowStore({ 'wf-schema': mockWorkflow('wf-schema', schema) });
    const result = await handleStartRunBatch(
      {
        workflow_id: 'wf-schema',
        items: [{ params: { name: 'Alice' } }, { params: { name: 'Bob' } }],
      },
      {
        runStore,
        workflowStore: wfStore as unknown as import('@sensigo/realm').JsonWorkflowStore,
      },
    );
    expect(result.started).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // 10. No runs created on validation failure
  // -----------------------------------------------------------------------
  it('no runs are created when validation fails', async () => {
    const schema = { required: ['name'], properties: { name: { type: 'string' } } };
    const wfStore = mockWorkflowStore({ 'wf-schema': mockWorkflow('wf-schema', schema) });
    try {
      await handleStartRunBatch(
        {
          workflow_id: 'wf-schema',
          items: [{ params: {} }, { params: {} }],
        },
        {
          runStore,
          workflowStore: wfStore as unknown as import('@sensigo/realm').JsonWorkflowStore,
        },
      );
    } catch {
      // expected
    }
    const runs = await runStore.list('wf-schema');
    expect(runs).toHaveLength(0);
  });
});
