// #92 PR 1: the idempotency re-encounter signal on start_run / start_run_batch
// (deduped, run_phase, accurate context_hint, observational warnings) and run_phase on the envelope.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  buildPreExecutionErrorEnvelope,
  WorkflowError,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { handleStartRun } from './start-run.js';
import { handleStartRunBatch } from './start-run-batch.js';

// Agent-first workflow: a fresh run's only eligible step is an agent step, so start_run takes the
// NON-chained return path (no auto step to chain into) — exercising the deduped hint/warnings.
const agentFirst: WorkflowDefinition = {
  id: 'agentflow',
  name: 'Agent First',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    review: { description: 'Agent step', execution: 'agent', depends_on: [] },
  },
};

// Auto-first workflow: a fresh run chains immediately through an auto step (the chained return path).
const autoFirst: WorkflowDefinition = {
  id: 'autoflow',
  name: 'Auto First',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    compute: { description: 'Auto step', execution: 'auto', depends_on: [] },
  },
};

describe('start_run idempotency signal', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runStore = new JsonFileStore(await mkdtemp(join(tmpdir(), 'sig-run-')));
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'sig-wf-')));
    await workflowStore.register(agentFirst);
    await workflowStore.register(autoFirst);
  });

  it('fresh run → deduped:false, run_phase running, created hint', async () => {
    const env = await handleStartRun({ workflow_id: 'agentflow' }, { runStore, workflowStore });
    expect(env.deduped).toBe(false);
    expect(env.run_phase).toBe('running');
    expect(env.context_hint).toContain('created');
  });

  it('terminal match → deduped:true, run_phase set, accurate hint, run byte-unchanged', async () => {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    const aborted = await runStore.update({
      ...run,
      run_phase: 'aborted',
      terminal_state: true,
      terminal_reason: 'aborted by guard',
      aborted_at: { step_id: 'review' },
    });
    const before = await runStore.get(run.id);

    const env = await handleStartRun(
      { workflow_id: 'agentflow', idempotency_key: 'k1' },
      { runStore, workflowStore },
    );

    expect(env.deduped).toBe(true);
    expect(env.run_phase).toBe('aborted');
    expect(env.context_hint).toContain('Matched existing run');
    expect(env.context_hint).not.toContain('created for workflow');
    // No re-drive: the record is byte-unchanged.
    const after = await runStore.get(run.id);
    expect(after).toEqual(before);
    expect(after.version).toBe(aborted.version);
  });

  it('running match → deduped:true + observational warning naming the phase', async () => {
    await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k2',
    });
    const env = await handleStartRun(
      { workflow_id: 'agentflow', idempotency_key: 'k2' },
      { runStore, workflowStore },
    );
    expect(env.deduped).toBe(true);
    expect(env.run_phase).toBe('running');
    expect(env.warnings.some((w) => w.includes("phase 'running'"))).toBe(true);
  });

  it('param mismatch on a re-encounter → warning, original run returned', async () => {
    const { run: owner } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: { a: 1 },
      idempotencyKey: 'k3',
    });
    const env = await handleStartRun(
      { workflow_id: 'agentflow', params: { a: 2 }, idempotency_key: 'k3' },
      { runStore, workflowStore },
    );
    expect(env.deduped).toBe(true);
    expect(env.run_id).toBe(owner.id);
    expect(env.warnings.some((w) => w.includes('different params'))).toBe(true);
  });

  it('run_phase is present on the chained (auto-first) return path', async () => {
    const env = await handleStartRun({ workflow_id: 'autoflow' }, { runStore, workflowStore });
    expect(env.run_phase).toBeDefined();
    expect(env.deduped).toBe(false);
  });
});

describe('start_run_batch idempotency signal (per-item)', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runStore = new JsonFileStore(await mkdtemp(join(tmpdir(), 'sigb-run-')));
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'sigb-wf-')));
    await workflowStore.register(agentFirst);
  });

  it('each started item carries deduped, run_phase, terminal_reason, warnings', async () => {
    // Pre-seed a terminal run for key 'dup'.
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'dup',
    });
    await runStore.update({
      ...run,
      completed_steps: ['review'],
      run_phase: 'completed',
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
    });

    const result = await handleStartRunBatch(
      {
        workflow_id: 'agentflow',
        items: [
          { params: {}, idempotency_key: 'dup' }, // matches the terminal run
          { params: {}, idempotency_key: 'fresh' }, // new
        ],
      },
      { runStore, workflowStore },
    );

    const dup = result.started[0]!;
    expect(dup.deduped).toBe(true);
    expect(dup.run_phase).toBe('completed');
    expect(dup.terminal_reason).toBe('Workflow completed.');
    expect(Array.isArray(dup.warnings)).toBe(true);

    const fresh = result.started[1]!;
    expect(fresh.deduped).toBe(false);
    expect(fresh.run_phase).toBe('running');
    expect(fresh.terminal_reason).toBeUndefined();
    expect(fresh.warnings).toEqual([]);
  });
});

describe('run_phase on the envelope', () => {
  it('is absent on a pre-execution error envelope (no run loaded)', () => {
    const err = new WorkflowError('boom', {
      code: 'STATE_WORKFLOW_NOT_FOUND',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
    });
    const env = buildPreExecutionErrorEnvelope('start_run', '', 0, err, 'not found');
    expect(env.run_phase).toBeUndefined();
  });
});

describe('start_run / start_run_batch re-encounter policy (#92 PR 2)', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runStore = new JsonFileStore(await mkdtemp(join(tmpdir(), 'pol-run-')));
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'pol-wf-')));
    await workflowStore.register(agentFirst);
  });

  async function seedCompleted(key: string): Promise<string> {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
      idempotencyKey: key,
    });
    await runStore.update({
      ...run,
      completed_steps: ['review'],
      run_phase: 'completed',
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
    });
    return run.id;
  }

  it('start_run on_terminal_match:reject throws a WorkflowError with STATE_IDEMPOTENCY_KEY_USED', async () => {
    await seedCompleted('k1');
    let caught: unknown;
    try {
      await handleStartRun(
        { workflow_id: 'agentflow', idempotency_key: 'k1', on_terminal_match: 'reject' },
        { runStore, workflowStore },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'STATE_IDEMPOTENCY_KEY_USED' });
  });

  it('start_run on_terminal_match:rerun supersedes → deduped:false, new run', async () => {
    const oldId = await seedCompleted('k1');
    const env = await handleStartRun(
      { workflow_id: 'agentflow', idempotency_key: 'k1', on_terminal_match: 'rerun' },
      { runStore, workflowStore },
    );
    expect(env.deduped).toBe(false);
    expect(env.run_id).not.toBe(oldId);
    expect(env.context_hint).toContain('created');
  });

  it('start_run on_live_match:fail throws STATE_RUN_ALREADY_ACTIVE on a running match', async () => {
    await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k2',
    });
    let caught: unknown;
    try {
      await handleStartRun(
        { workflow_id: 'agentflow', idempotency_key: 'k2', on_live_match: 'fail' },
        { runStore, workflowStore },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'STATE_RUN_ALREADY_ACTIVE' });
  });

  it('start_run_batch applies batch-level policy; a rejected item does not sink the batch', async () => {
    await seedCompleted('dup'); // terminal match for the first item
    const result = await handleStartRunBatch(
      {
        workflow_id: 'agentflow',
        on_terminal_match: 'reject',
        items: [
          { params: {}, idempotency_key: 'dup' }, // → rejected (terminal + reject)
          { params: {}, idempotency_key: 'fresh' }, // → started
        ],
      },
      { runStore, workflowStore },
    );
    expect(result.started).toHaveLength(1);
    expect(result.started[0]!.idempotency_key).toBe('fresh');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.index).toBe(0);
    expect(result.failed[0]!.idempotency_key).toBe('dup');
    expect(result.failed[0]!.error_code).toBe('STATE_IDEMPOTENCY_KEY_USED');
  });

  it('start_run_batch defaults: omitting policy reproduces PR 1 (terminal match deduped, no failed)', async () => {
    await seedCompleted('dup');
    const result = await handleStartRunBatch(
      {
        workflow_id: 'agentflow',
        items: [{ params: {}, idempotency_key: 'dup' }],
      },
      { runStore, workflowStore },
    );
    expect(result.failed).toHaveLength(0);
    expect(result.started[0]!.deduped).toBe(true);
    expect(result.started[0]!.run_phase).toBe('completed');
  });
});
