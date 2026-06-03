// Tests for JsonFileStore: create, get, update, list, and claimStep operations.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from './json-file-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

async function makeTmpStore(): Promise<{ store: JsonFileStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'realm-test-'));
  return { store: new JsonFileStore(dir), dir };
}

const minimalDef: WorkflowDefinition = {
  id: 'wf-1',
  name: 'Test Workflow',
  version: 1,
  steps: {
    'step-one': { description: 'First step', execution: 'auto', depends_on: [] },
  },
};

describe('JsonFileStore', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  it('create() produces a record with correct fields', async () => {
    const record = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: { key: 'value' },
    });

    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.workflow_id).toBe('wf-1');
    expect(record.workflow_version).toBe(1);
    expect(record.run_phase).toBe('running');
    expect(record.version).toBe(0);
    expect(record.params).toEqual({ key: 'value' });
    expect(record.evidence).toHaveLength(0);
    expect(record.terminal_state).toBe(false);
    expect(record.completed_steps).toEqual([]);
    expect(record.in_progress_steps).toEqual([]);
    expect(record.failed_steps).toEqual([]);
    expect(record.skipped_steps).toEqual([]);
  });

  it('create() writes file to disk', async () => {
    const record = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(dir, `${record.id}.json`))).toBe(true);
  });

  it('get() returns the created record', async () => {
    const created = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });
    const fetched = await store.get(created.id);
    expect(fetched).toEqual(created);
  });

  it('get() throws STATE_RUN_NOT_FOUND for unknown ID', async () => {
    await expect(store.get('non-existent')).rejects.toMatchObject({
      code: 'STATE_RUN_NOT_FOUND',
    });
    await expect(store.get('non-existent')).rejects.toBeInstanceOf(WorkflowError);
  });

  it('update() increments version and updates updated_at', async () => {
    const created = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });

    const updated = await store.update({
      ...created,
      completed_steps: ['step-one'],
    });
    expect(updated.version).toBe(1);
    expect(updated.completed_steps).toContain('step-one');
    expect(updated.updated_at >= created.updated_at).toBe(true);

    const fetched = await store.get(created.id);
    expect(fetched.version).toBe(1);
    expect(fetched.completed_steps).toContain('step-one');
  });

  it('update() throws STATE_SNAPSHOT_MISMATCH on version conflict', async () => {
    const created = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });

    // First update succeeds
    await store.update({ ...created, completed_steps: ['step-one'] });

    // Second update with old version should fail
    await expect(
      store.update({ ...created, completed_steps: ['other-step'] }),
    ).rejects.toMatchObject({
      code: 'STATE_SNAPSHOT_MISMATCH',
    });
  });

  it('list() returns all created runs', async () => {
    await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
    await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
    await store.create({ workflowId: 'wf-2', workflowVersion: 1, params: {} });

    const all = await store.list();
    expect(all).toHaveLength(3);
  });

  it('list() filters by workflowId', async () => {
    await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
    await store.create({ workflowId: 'wf-2', workflowVersion: 1, params: {} });

    const filtered = await store.list('wf-1');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.workflow_id).toBe('wf-1');
  });

  it('claimStep() returns run with step in in_progress_steps', async () => {
    const run = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });

    const claimed = await store.claimStep(run.id, 'step-one', minimalDef);
    expect(claimed.in_progress_steps).toContain('step-one');
    expect(claimed.version).toBeGreaterThan(run.version);
  });

  it('claimStep() throws STATE_STEP_ALREADY_CLAIMED when step already in progress', async () => {
    const run = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });

    await store.claimStep(run.id, 'step-one', minimalDef);

    await expect(store.claimStep(run.id, 'step-one', minimalDef)).rejects.toMatchObject({
      code: 'STATE_STEP_ALREADY_CLAIMED',
    });
  });

  it('claimStep() throws STATE_STEP_NOT_ELIGIBLE when step is not eligible', async () => {
    const twoStepDef: WorkflowDefinition = {
      id: 'wf-1',
      name: 'Test',
      version: 1,
      steps: {
        'step-one': { description: 'First', execution: 'auto', depends_on: [] },
        'step-two': { description: 'Second', execution: 'auto', depends_on: ['step-one'] },
      },
    };

    const run = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });

    // step-two depends on step-one which hasn't run
    await expect(store.claimStep(run.id, 'step-two', twoStepDef)).rejects.toMatchObject({
      code: 'STATE_STEP_NOT_ELIGIBLE',
    });
  });

  // Cleanup temp dir after each test.
  it('temp dir cleanup works', async () => {
    await rm(dir, { recursive: true, force: true });
  });
});

// ── save() ────────────────────────────────────────────────────────────────────

describe('JsonFileStore.save()', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  it('writes a new record to disk', async () => {
    const record = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
    // Delete it and re-save as an import.
    const newRecord = { ...record, id: 'imported-run-1' };
    await store.save(newRecord);
    const fetched = await store.get('imported-run-1');
    expect(fetched.id).toBe('imported-run-1');
    expect(fetched.version).toBe(record.version);
  });

  it('is a no-op when called twice with the same record (same version)', async () => {
    const record = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
    const importRecord = { ...record, id: 'import-idempotent' };
    await store.save(importRecord);
    // Second call with same version — must not throw.
    await expect(store.save(importRecord)).resolves.toBeUndefined();
  });

  it('throws STATE_RUN_DIVERGED when same ID exists with a different version', async () => {
    const record = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
    const importRecord = { ...record, id: 'import-diverged' };
    await store.save(importRecord);
    // Same ID, different version.
    const conflicting = { ...importRecord, version: importRecord.version + 5 };
    await expect(store.save(conflicting)).rejects.toMatchObject({
      code: 'STATE_RUN_DIVERGED',
    });
  });

  it('cleanup', async () => {
    await rm(dir, { recursive: true, force: true });
  });
});

// ── idempotency ───────────────────────────────────────────────────────────────

describe('JsonFileStore idempotency', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('create() without idempotencyKey always creates a new run', async () => {
    const r1 = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
    const r2 = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
    expect(r1.id).not.toBe(r2.id);
  });

  it('create() with idempotencyKey returns the same run on second call', async () => {
    const r1 = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    const r2 = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(r1.id).toBe(r2.id);
  });

  it('create() stores idempotency_key on the record', async () => {
    const record = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(record.idempotency_key).toBe('k1');
  });

  it('create() with parentRunId stores parent_run_id on the record', async () => {
    const record = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      parentRunId: 'parent-123',
    });
    expect(record.parent_run_id).toBe('parent-123');
  });

  it('idempotency is scoped per workflow — same key on different workflowId creates a new run', async () => {
    const r1 = await store.create({
      workflowId: 'wf-a',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    const r2 = await store.create({
      workflowId: 'wf-b',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(r1.id).not.toBe(r2.id);
  });
});
