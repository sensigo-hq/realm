// Integration tests for the per-claim liveness clock in the store (issue #101):
// claimStep writes claims[S] ATOMICALLY with the in_progress add; settle sites delete claims[S].
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from './json-file-store.js';
import { executeStep } from '../engine/execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepHandler } from '../extensions/step-handler.js';

const autoFree: WorkflowDefinition = {
  id: 'clock-auto',
  name: 'Auto (finalizer-free)',
  version: 1,
  steps: { work: { description: 'w', execution: 'auto', depends_on: [], handler: 'h' } },
};
const agentWf: WorkflowDefinition = {
  id: 'clock-agent',
  name: 'Agent',
  version: 1,
  steps: { work: { description: 'w', execution: 'agent', depends_on: [] } },
};
const finalizerBearing: WorkflowDefinition = {
  id: 'clock-fin',
  name: 'Finalizer-bearing',
  version: 1,
  steps: {
    work: { description: 'w', execution: 'auto', depends_on: [], handler: 'h' },
    cleanup: { description: 'c', execution: 'finalizer', on_outcome: 'always', handler: 'hc' },
  },
};

describe('claimStep writes the liveness clock atomically (JsonFileStore)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-clock-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('an auto step in a finalizer-free workflow gets a concrete deadline, atomic with in_progress', async () => {
    const { run } = await store.create({
      workflowId: 'clock-auto',
      workflowVersion: 1,
      params: {},
    });
    const claimed = await store.claimStep(run.id, 'work', autoFree);
    // Both the in_progress add AND the claim clock are present in the SAME persisted record.
    expect(claimed.in_progress_steps).toContain('work');
    expect(claimed.claims?.['work']?.deadline).toEqual(expect.any(String));
    expect(new Date(claimed.claims!['work']!.deadline!).getTime()).toBeGreaterThan(Date.now());
    // Re-read confirms it was persisted (not just returned).
    const reread = await store.get(run.id);
    expect(reread.claims?.['work']?.deadline).toEqual(claimed.claims!['work']!.deadline);
  });

  it('an agent step gets deadline: null (unknown age)', async () => {
    const { run } = await store.create({
      workflowId: 'clock-agent',
      workflowVersion: 1,
      params: {},
    });
    const claimed = await store.claimStep(run.id, 'work', agentWf);
    expect(claimed.in_progress_steps).toContain('work');
    expect(claimed.claims?.['work']?.deadline).toBeNull();
  });

  it('an auto step in a finalizer-BEARING workflow gets deadline: null', async () => {
    const { run } = await store.create({ workflowId: 'clock-fin', workflowVersion: 1, params: {} });
    const claimed = await store.claimStep(run.id, 'work', finalizerBearing);
    expect(claimed.claims?.['work']?.deadline).toBeNull();
  });

  // issue #279 (increment 1, PR-A): claimStep now mints a fencing token alongside the deadline —
  // dormant until PR-B, but real/present in every claim record starting with this PR. Verified
  // both in-memory (returned value) and on the re-read (actually persisted, not just returned).
  it('claimStep mints a token alongside the deadline, persisted (issue #279, dormant until PR-B)', async () => {
    const { run } = await store.create({
      workflowId: 'clock-agent',
      workflowVersion: 1,
      params: {},
    });
    const claimed = await store.claimStep(run.id, 'work', agentWf);
    expect(claimed.claims?.['work']?.token).toEqual(expect.any(String));
    expect(claimed.claims!['work']!.token!.length).toBeGreaterThan(0);
    const reread = await store.get(run.id);
    expect(reread.claims?.['work']?.token).toEqual(claimed.claims!['work']!.token);
  });
});

describe('settle sites delete the claim clock (JsonFileStore)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-clock-settle-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('complete → claims[S] deleted', async () => {
    const registry = new ExtensionRegistry();
    const handler: StepHandler = { id: 'h', execute: async () => ({ data: {} }) };
    registry.register('handler', 'h', handler);
    const { run } = await store.create({
      workflowId: 'clock-auto',
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, autoFree, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => ({}),
      registry,
    });
    const after = await store.get(run.id);
    expect(after.completed_steps).toContain('work');
    expect(after.claims?.['work']).toBeUndefined();
  });

  it('fail → claims[S] deleted', async () => {
    const registry = new ExtensionRegistry();
    const handler: StepHandler = {
      id: 'h',
      execute: async () => {
        throw new WorkflowError('boom', {
          code: 'ENGINE_HANDLER_FAILED',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: false,
        });
      },
    };
    registry.register('handler', 'h', handler);
    const { run } = await store.create({
      workflowId: 'clock-auto',
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, autoFree, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => ({}),
      registry,
    });
    const after = await store.get(run.id);
    expect(after.failed_steps).toContain('work');
    expect(after.claims?.['work']).toBeUndefined();
  });
});
