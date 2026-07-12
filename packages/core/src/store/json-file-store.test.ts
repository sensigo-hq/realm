// Tests for JsonFileStore: create, get, update, list, and claimStep operations.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from './json-file-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

/** Recompute the pointer-file path the store uses (sha256 of workflowId\0key). */
function keyPointerPath(dir: string, workflowId: string, key: string): string {
  const hash = createHash('sha256').update(`${workflowId}\0${key}`).digest('hex');
  return join(dir, 'keys', `${hash}.json`);
}

/** Build a complete RunRecord for direct on-disk seeding (bypassing create()). */
function makeRunRecord(over: Partial<RunRecord> & { id: string; workflow_id: string }): RunRecord {
  return {
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 0,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    ...over,
  };
}

/** Count top-level run files (excludes the keys/ subdir). */
async function countRunFiles(dir: string): Promise<number> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.json')).length;
}

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
    const { run: record } = await store.create({
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
    const { run: record } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(dir, `${record.id}.json`))).toBe(true);
  });

  it('get() returns the created record', async () => {
    const { run: created } = await store.create({
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
    const { run: created } = await store.create({
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
    const { run: created } = await store.create({
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
    const { run: run } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });

    const claimed = await store.claimStep(run.id, 'step-one', minimalDef);
    expect(claimed.in_progress_steps).toContain('step-one');
    expect(claimed.version).toBeGreaterThan(run.version);
  });

  it('claimStep() throws STATE_STEP_ALREADY_CLAIMED when step already in progress', async () => {
    const { run: run } = await store.create({
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

    const { run: run } = await store.create({
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
    const { run: record } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });
    // Delete it and re-save as an import.
    const newRecord = { ...record, id: 'imported-run-1' };
    await store.save(newRecord);
    const fetched = await store.get('imported-run-1');
    expect(fetched.id).toBe('imported-run-1');
    expect(fetched.version).toBe(record.version);
  });

  it('is a no-op when called twice with the same record (same version)', async () => {
    const { run: record } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });
    const importRecord = { ...record, id: 'import-idempotent' };
    await store.save(importRecord);
    // Second call with same version — must not throw.
    await expect(store.save(importRecord)).resolves.toBeUndefined();
  });

  it('throws STATE_RUN_DIVERGED when same ID exists with a different version', async () => {
    const { run: record } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
    });
    const importRecord = { ...record, id: 'import-diverged' };
    await store.save(importRecord);
    // Same ID, different version.
    const conflicting = { ...importRecord, version: importRecord.version + 5 };
    await expect(store.save(conflicting)).rejects.toMatchObject({
      code: 'STATE_RUN_DIVERGED',
    });
  });

  it('issue #131 AC#4: two concurrent save() calls on the same absent id cannot interleave to a partial/duplicate write', async () => {
    // Two racing imports of the same run id, DIFFERING versions (a genuine divergence) — the
    // id does not exist on disk yet, so both calls race the create-if-absent path. Without the
    // #131 lock, both could pass existsSync() seeing "absent" and both write, silently masking
    // the divergence (whichever write lands last wins with no error). With the lock, the two
    // read-check-write critical sections are fully serialized: exactly one call observes "absent"
    // and writes; the other, now serialized behind it, observes the just-written file under the
    // SAME lock and correctly throws STATE_RUN_DIVERGED — never both succeeding, never a torn file.
    const recordA = makeRunRecord({
      id: 'concurrent-save-race',
      workflow_id: 'wf-race',
      version: 1,
      params: { source: 'A' },
    });
    const recordB = makeRunRecord({
      id: 'concurrent-save-race',
      workflow_id: 'wf-race',
      version: 2,
      params: { source: 'B' },
    });

    const results = await Promise.allSettled([store.save(recordA), store.save(recordB)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'STATE_RUN_DIVERGED',
    });

    // The on-disk file is a complete, valid record matching EXACTLY one of the two inputs —
    // never a torn/mixed write.
    const finalRun = await store.get('concurrent-save-race');
    expect([1, 2]).toContain(finalRun.version);
    const winner = finalRun.version === 1 ? recordA : recordB;
    expect(finalRun.params).toEqual(winner.params);
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
    const { run: r1 } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
    const { run: r2 } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
    expect(r1.id).not.toBe(r2.id);
  });

  it('create() with idempotencyKey returns the same run on second call', async () => {
    const { run: r1 } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    const { run: r2 } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(r1.id).toBe(r2.id);
  });

  it('create() stores idempotency_key on the record', async () => {
    const { run: record } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(record.idempotency_key).toBe('k1');
  });

  it('create() with parentRunId stores parent_run_id on the record', async () => {
    const { run: record } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      parentRunId: 'parent-123',
    });
    expect(record.parent_run_id).toBe('parent-123');
  });

  it('idempotency is scoped per workflow — same key on different workflowId creates a new run', async () => {
    const { run: r1 } = await store.create({
      workflowId: 'wf-a',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    const { run: r2 } = await store.create({
      workflowId: 'wf-b',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(r1.id).not.toBe(r2.id);
  });
});

// ── pointer-index identity (#92 PR 1) ──────────────────────────────────────────

describe('JsonFileStore pointer index', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports created:true then created:false for the same key', async () => {
    const first = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(first.created).toBe(true);
    const second = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
  });

  it('writes a pointer file under keys/ and keeps it invisible to list()', async () => {
    const { run } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: { a: 1 },
      idempotencyKey: 'k1',
    });
    const ptrPath = keyPointerPath(dir, 'wf-1', 'k1');
    expect(existsSync(ptrPath)).toBe(true);
    const ptr = JSON.parse(await readFile(ptrPath, 'utf8'));
    expect(ptr.run_id).toBe(run.id);
    expect(ptr.params_hash).toMatch(/^[0-9a-f]{64}$/);
    // The keys/ subdir must not surface in list().
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(run.id);
  });

  it('atomic claim: concurrent same-key creates yield one created:true and one run', async () => {
    const opts = {
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: { x: 1 },
      idempotencyKey: 'race',
    } as const;
    const [a, b] = await Promise.all([store.create({ ...opts }), store.create({ ...opts })]);
    const createdFlags = [a.created, b.created].sort();
    expect(createdFlags).toEqual([false, true]);
    expect(a.run.id).toBe(b.run.id);
    // Exactly one run file for the key.
    const matches = (await store.list('wf-1')).filter((r) => r.idempotency_key === 'race');
    expect(matches).toHaveLength(1);
    expect(await countRunFiles(dir)).toBe(1);
  });

  it('deterministic resolution: repeated create returns the same run regardless of other runs', async () => {
    const { run: owner } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    // Add unrelated runs to perturb readdir order.
    await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
    await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
    for (let i = 0; i < 3; i++) {
      const { run, created } = await store.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k1',
      });
      expect(created).toBe(false);
      expect(run.id).toBe(owner.id);
    }
  });

  it('self-heal: a pointer to a deleted run reclaims (created:true, repoints)', async () => {
    const { run: first } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    // Simulate a crash-orphan: delete the run file but leave the pointer.
    await unlink(join(dir, `${first.id}.json`));
    const { run: second, created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(created).toBe(true);
    expect(second.id).not.toBe(first.id);
    // Pointer now points at the reclaimed run.
    const ptr = JSON.parse(await readFile(keyPointerPath(dir, 'wf-1', 'k1'), 'utf8'));
    expect(ptr.run_id).toBe(second.id);
  });

  it('lazy legacy migration: adopts a pre-existing keyed run with no pointer and writes the pointer', async () => {
    // Seed a legacy run directly on disk (has the field, no pointer).
    const legacy = makeRunRecord({ id: 'legacy-1', workflow_id: 'wf-1', idempotency_key: 'k1' });
    await writeFile(join(dir, 'legacy-1.json'), JSON.stringify(legacy, null, 2), 'utf8');
    expect(existsSync(keyPointerPath(dir, 'wf-1', 'k1'))).toBe(false);

    const { run, created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(created).toBe(false);
    expect(run.id).toBe('legacy-1');
    expect(existsSync(keyPointerPath(dir, 'wf-1', 'k1'))).toBe(true);
  });

  it('lazy legacy migration: a duplicated-key group adopts the canonical (single live) run', async () => {
    // One terminal + one live run sharing the same key.
    const terminal = makeRunRecord({
      id: 'dup-terminal',
      workflow_id: 'wf-1',
      idempotency_key: 'k1',
      run_phase: 'completed',
      terminal_state: true,
      created_at: '2026-01-02T00:00:00.000Z',
    });
    const live = makeRunRecord({
      id: 'dup-live',
      workflow_id: 'wf-1',
      idempotency_key: 'k1',
      created_at: '2026-01-01T00:00:00.000Z', // older, but the only live one
    });
    await writeFile(join(dir, 'dup-terminal.json'), JSON.stringify(terminal, null, 2), 'utf8');
    await writeFile(join(dir, 'dup-live.json'), JSON.stringify(live, null, 2), 'utf8');

    const { run, created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(created).toBe(false);
    expect(run.id).toBe('dup-live'); // single live run wins regardless of created_at
  });

  it('param mismatch is detectable: matched run keeps its original params', async () => {
    const { run: owner } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: { a: 1 },
      idempotencyKey: 'k1',
    });
    const { run, created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: { a: 2 }, // different payload, same key
      idempotencyKey: 'k1',
    });
    expect(created).toBe(false);
    expect(run.id).toBe(owner.id);
    expect(run.params).toEqual({ a: 1 }); // original payload preserved
  });
});

// ── reconcileKeys (#92 PR 1) ───────────────────────────────────────────────────

describe('JsonFileStore.reconcileKeys()', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedDuplicateGroup(): Promise<void> {
    // Same key, all terminal → canonical is newest by created_at, tie-break greatest id.
    const a = makeRunRecord({
      id: 'aaa',
      workflow_id: 'wf-1',
      idempotency_key: 'k1',
      run_phase: 'completed',
      terminal_state: true,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const b = makeRunRecord({
      id: 'bbb',
      workflow_id: 'wf-1',
      idempotency_key: 'k1',
      run_phase: 'failed',
      terminal_state: true,
      created_at: '2026-01-03T00:00:00.000Z', // newest → canonical
    });
    await writeFile(join(dir, 'aaa.json'), JSON.stringify(a, null, 2), 'utf8');
    await writeFile(join(dir, 'bbb.json'), JSON.stringify(b, null, 2), 'utf8');
  }

  it('picks the canonical run and reports duplicate groups', async () => {
    await seedDuplicateGroup();
    const summary = await store.reconcileKeys();
    expect(summary.groups).toBe(1);
    expect(summary.keysWritten).toBe(1);
    expect(summary.duplicateGroups).toHaveLength(1);
    expect(summary.duplicateGroups[0]!.canonical_run_id).toBe('bbb'); // newest terminal
    const ptr = JSON.parse(await readFile(keyPointerPath(dir, 'wf-1', 'k1'), 'utf8'));
    expect(ptr.run_id).toBe('bbb');
  });

  it('is idempotent — a second run writes nothing new', async () => {
    await seedDuplicateGroup();
    await store.reconcileKeys();
    const second = await store.reconcileKeys();
    expect(second.keysWritten).toBe(0);
    expect(second.keysUnchanged).toBe(1);
  });

  it('--dry-run writes no files', async () => {
    await seedDuplicateGroup();
    const summary = await store.reconcileKeys(undefined, true);
    expect(summary.dryRun).toBe(true);
    expect(summary.keysWritten).toBe(1); // would-write count
    expect(existsSync(keyPointerPath(dir, 'wf-1', 'k1'))).toBe(false);
    expect(existsSync(join(dir, 'keys'))).toBe(false);
  });

  it('reports multiple live runs as a data-integrity finding', async () => {
    const live1 = makeRunRecord({
      id: 'live1',
      workflow_id: 'wf-1',
      idempotency_key: 'k1',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const live2 = makeRunRecord({
      id: 'live2',
      workflow_id: 'wf-1',
      idempotency_key: 'k1',
      created_at: '2026-01-02T00:00:00.000Z', // newest live → canonical
    });
    await writeFile(join(dir, 'live1.json'), JSON.stringify(live1, null, 2), 'utf8');
    await writeFile(join(dir, 'live2.json'), JSON.stringify(live2, null, 2), 'utf8');
    const summary = await store.reconcileKeys();
    expect(summary.multipleLiveGroups).toHaveLength(1);
    expect(summary.multipleLiveGroups[0]!.canonical_run_id).toBe('live2');
    expect(summary.multipleLiveGroups[0]!.extra_live_run_ids).toEqual(['live1']);
  });
});

// ── save() index routing (#92 PR 1) ────────────────────────────────────────────

describe('JsonFileStore.save() index routing', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('registers a key pointer for an imported keyed run', async () => {
    const imported = makeRunRecord({ id: 'imp-1', workflow_id: 'wf-1', idempotency_key: 'k1' });
    await store.save(imported);
    const ptr = JSON.parse(await readFile(keyPointerPath(dir, 'wf-1', 'k1'), 'utf8'));
    expect(ptr.run_id).toBe('imp-1');
    // A later create() with the same key resolves to the imported run.
    const { run, created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(created).toBe(false);
    expect(run.id).toBe('imp-1');
  });

  it('throws when the key is already owned by a different live run', async () => {
    // create() establishes a live owner for k1.
    const { run: owner } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(owner.terminal_state).toBe(false);
    const conflicting = makeRunRecord({ id: 'imp-2', workflow_id: 'wf-1', idempotency_key: 'k1' });
    await expect(store.save(conflicting)).rejects.toMatchObject({ code: 'STATE_RUN_DIVERGED' });
  });

  it('repoints when the prior owner is terminal', async () => {
    const terminalOwner = makeRunRecord({
      id: 'old-owner',
      workflow_id: 'wf-1',
      idempotency_key: 'k1',
      run_phase: 'completed',
      terminal_state: true,
    });
    await store.save(terminalOwner);
    const replacement = makeRunRecord({
      id: 'new-owner',
      workflow_id: 'wf-1',
      idempotency_key: 'k1',
    });
    await store.save(replacement); // prior owner terminal → safe to repoint
    const ptr = JSON.parse(await readFile(keyPointerPath(dir, 'wf-1', 'k1'), 'utf8'));
    expect(ptr.run_id).toBe('new-owner');
  });
});

// ── re-encounter policy (#92 PR 2) ─────────────────────────────────────────────

describe('JsonFileStore re-encounter policy', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    ({ store, dir } = await makeTmpStore());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Create a keyed run and drive it to a terminal phase. */
  async function seedTerminal(
    key: string,
    phase: 'completed' | 'failed' | 'aborted' | 'abandoned',
  ): Promise<string> {
    const { run } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: key,
    });
    const patch =
      phase === 'completed'
        ? {
            run_phase: 'completed' as const,
            terminal_state: true,
            terminal_reason: 'Workflow completed.',
          }
        : phase === 'aborted'
          ? { run_phase: 'aborted' as const, terminal_state: true, aborted_at: { step_id: 's' } }
          : phase === 'failed'
            ? { run_phase: 'failed' as const, terminal_state: true, failed_steps: ['s'] }
            : { run_phase: 'abandoned' as const, terminal_state: true };
    await store.update({ ...run, ...patch });
    return run.id;
  }

  // --- Terminal axis ---

  it('terminal reuse (default) returns the existing run', async () => {
    const id = await seedTerminal('k1', 'failed');
    const { run, created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(created).toBe(false);
    expect(run.id).toBe(id);
  });

  it('terminal reject throws STATE_IDEMPOTENCY_KEY_USED', async () => {
    await seedTerminal('k1', 'completed');
    await expect(
      store.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k1',
        onTerminalMatch: 'reject',
      }),
    ).rejects.toMatchObject({ code: 'STATE_IDEMPOTENCY_KEY_USED' });
  });

  it('rerun_if_failed supersedes a failed match (new run + repoint + old still gettable)', async () => {
    const oldId = await seedTerminal('k1', 'failed');
    const { run, created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
      onTerminalMatch: 'rerun_if_failed',
    });
    expect(created).toBe(true);
    expect(run.id).not.toBe(oldId);
    const ptr = JSON.parse(await readFile(keyPointerPath(dir, 'wf-1', 'k1'), 'utf8'));
    expect(ptr.run_id).toBe(run.id);
    // Old run remains on disk (auditable).
    expect((await store.get(oldId)).id).toBe(oldId);
  });

  it('rerun_if_failed reuses a completed match (no new run)', async () => {
    const id = await seedTerminal('k1', 'completed');
    const { run, created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
      onTerminalMatch: 'rerun_if_failed',
    });
    expect(created).toBe(false);
    expect(run.id).toBe(id);
  });

  it('rerun supersedes a completed match (new run + repoint)', async () => {
    const oldId = await seedTerminal('k1', 'completed');
    const { run, created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
      onTerminalMatch: 'rerun',
    });
    expect(created).toBe(true);
    expect(run.id).not.toBe(oldId);
    const ptr = JSON.parse(await readFile(keyPointerPath(dir, 'wf-1', 'k1'), 'utf8'));
    expect(ptr.run_id).toBe(run.id);
  });

  // --- Live axis ---

  it('live use_existing (default) returns the running run', async () => {
    const { run: owner } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    const { run, created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(created).toBe(false);
    expect(run.id).toBe(owner.id);
  });

  it('live fail throws STATE_RUN_ALREADY_ACTIVE on a running match', async () => {
    await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    await expect(
      store.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k1',
        onLiveMatch: 'fail',
      }),
    ).rejects.toMatchObject({ code: 'STATE_RUN_ALREADY_ACTIVE' });
  });

  it('live fail throws on a gate_waiting match too', async () => {
    const { run } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    await store.update({
      ...run,
      pending_gate: { gate_id: 'g', step_name: 's', preview: {}, choices: ['ok'] },
    });
    await expect(
      store.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k1',
        onLiveMatch: 'fail',
      }),
    ).rejects.toMatchObject({ code: 'STATE_RUN_ALREADY_ACTIVE' });
  });

  // --- Supersede soundness + crash-safety ---

  it('after rerun, deleting the pointer self-heals to the NEW run (not the superseded one)', async () => {
    const oldId = await seedTerminal('k1', 'completed');
    const { run: newRun } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
      onTerminalMatch: 'rerun',
    });
    // Delete the pointer → force the lazy-legacy fallback to re-pick the canonical run.
    await unlink(keyPointerPath(dir, 'wf-1', 'k1'));
    const { run: healed, created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(created).toBe(false);
    expect(healed.id).toBe(newRun.id); // newer live successor wins, not oldId
    expect(healed.id).not.toBe(oldId);
  });

  it('supersede writes the run file before repointing (both run files on disk, pointer at new)', async () => {
    const oldId = await seedTerminal('k1', 'failed');
    const { run: newRun } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
      onTerminalMatch: 'rerun',
    });
    expect(existsSync(join(dir, `${oldId}.json`))).toBe(true);
    expect(existsSync(join(dir, `${newRun.id}.json`))).toBe(true);
    const ptr = JSON.parse(await readFile(keyPointerPath(dir, 'wf-1', 'k1'), 'utf8'));
    expect(ptr.run_id).toBe(newRun.id);
  });

  // --- Legacy-adopt + policy ---

  it('rerun against an adopted legacy failed run supersedes it', async () => {
    // Seed a legacy failed run directly (field set, no pointer).
    const legacy = makeRunRecord({
      id: 'legacy-failed',
      workflow_id: 'wf-1',
      idempotency_key: 'k1',
      run_phase: 'failed',
      terminal_state: true,
      failed_steps: ['s'],
    });
    await writeFile(join(dir, 'legacy-failed.json'), JSON.stringify(legacy, null, 2), 'utf8');
    const { run, created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
      onTerminalMatch: 'rerun',
    });
    expect(created).toBe(true);
    expect(run.id).not.toBe('legacy-failed');
    const ptr = JSON.parse(await readFile(keyPointerPath(dir, 'wf-1', 'k1'), 'utf8'));
    expect(ptr.run_id).toBe(run.id);
  });

  // --- Defaults reproduce PR 1 ---

  it('omitting both policy params reproduces PR 1 behavior (terminal match → reuse)', async () => {
    const id = await seedTerminal('k1', 'aborted');
    const { run, created } = await store.create({
      workflowId: 'wf-1',
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k1',
    });
    expect(created).toBe(false);
    expect(run.id).toBe(id);
    expect(run.run_phase).toBe('aborted'); // byte-unchanged, not re-driven
  });
});

// ---------------------------------------------------------------------------
// Atomic writes — torn-read concurrency (PR-C)
// A ≥32 KB record makes a non-atomic writeFile span multiple page writes, so an unlocked
// reader racing a writer reliably observes a truncated buffer on pre-fix code
// (`SyntaxError: Unexpected end of JSON input`). With atomic temp+rename writes, every
// unlocked reader sees the complete old XOR new file — zero torn reads.
// ---------------------------------------------------------------------------

const PAD_32KB = 'x'.repeat(40_000); // > 32 KB of JSON once serialized

describe('JsonFileStore — atomic writes (torn-read safety)', () => {
  it('T1 — concurrency hammer: K updates × N concurrent reads, zero torn reads', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({
        workflowId: 'hammer-wf',
        workflowVersion: 1,
        params: { pad: PAD_32KB },
      });

      const readErrors: string[] = [];
      let reads = 0;
      let done = false;
      const reader = async (): Promise<void> => {
        while (!done) {
          try {
            await store.get(run.id);
            reads += 1;
            if (reads % 20 === 0) await store.list();
          } catch (err) {
            readErrors.push(err instanceof Error ? err.message : String(err));
          }
        }
      };
      const readers = Array.from({ length: 16 }, () => reader()); // N: 16 loops → thousands of reads

      let rec = run;
      for (let i = 0; i < 120; i++) {
        // K = 120 sequential updates, each writing the ≥32 KB record; version feeds the next.
        rec = await store.update({ ...rec, params: { pad: PAD_32KB, i } });
      }
      done = true;
      await Promise.all(readers);

      expect(readErrors).toEqual([]); // ZERO torn reads (RED on pre-fix code)
      expect(reads).toBeGreaterThan(500); // the readers genuinely raced the writer
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000); // per-test: a concurrency hammer legitimately exceeds the 5s default

  it('T2 — every write path is torn-read-safe (fresh-run, pointer, update, claimStep, save)', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const readErrors: string[] = [];
      let done = false;
      // list() reads EVERY run file, so it races whichever writer is mid-write, whatever the path.
      const reader = async (): Promise<void> => {
        while (!done) {
          try {
            await store.list();
          } catch (err) {
            readErrors.push(err instanceof Error ? err.message : String(err));
          }
        }
      };
      const readers = Array.from({ length: 2 }, () => reader());

      for (let i = 0; i < 12; i++) {
        // fresh-run write
        const { run } = await store.create({
          workflowId: 'wf-1',
          workflowVersion: 1,
          params: { pad: PAD_32KB, i },
        });
        // key-pointer write (idempotencyKey path)
        await store.create({
          workflowId: 'wf-1',
          workflowVersion: 1,
          params: { pad: PAD_32KB, i },
          idempotencyKey: `key-${i}`,
        });
        // update write
        await store.update({ ...run, params: { pad: PAD_32KB, i, updated: true } });
        // claimStep write (step-one is eligible on a fresh wf-1 run)
        await store.claimStep(run.id, 'step-one', minimalDef);
        // save write (create-if-absent import of a fresh record)
        await store.save(
          makeRunRecord({ id: `imported-${i}`, workflow_id: 'wf-1', params: { pad: PAD_32KB } }),
        );
      }
      done = true;
      await Promise.all(readers);

      expect(readErrors).toEqual([]); // ZERO torn reads across all five write paths
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000); // per-test: concurrent list() over a padded corpus legitimately exceeds the 5s default

  it('T3 — structural guard: no raw writeFile of a run/pointer file outside atomicWriteFile', async () => {
    // Anti-recurrence (#123-style): every run/pointer write MUST route through the shared
    // atomicWriteFile helper (issue #130 extracted it to atomic-write.ts, so this file now only
    // IMPORTS it — no local definition). A future dev adding a raw writeFile of a '.json'
    // run/pointer file — reintroducing the torn read — makes this test fail loudly.
    const src = await readFile(new URL('./json-file-store.ts', import.meta.url), 'utf8');

    expect(src).not.toMatch(/writeFileSync\(/); // no sync writer sneaks in either
    expect(src).not.toMatch(/\bwriteFile\(/); // no raw async writer either — the helper moved out
    expect(src).toContain("import { atomicWriteFile } from './atomic-write.js';");
    expect(src).not.toContain('async function atomicWriteFile('); // no local re-definition

    // 5 occurrences of atomicWriteFile( = the 5 write paths (writePointer, writeFreshRun,
    // update, claimStep, save). The import statement itself has no trailing '(' so it doesn't
    // inflate this count.
    const atomicIdx = [...src.matchAll(/\batomicWriteFile\(/g)];
    expect(atomicIdx).toHaveLength(5);
  });

  it('T3b — structural guard: the atomicWriteFile primitive itself has exactly one definition and two raw writeFile( calls', async () => {
    // Sanity-checks the shared primitive's own internal shape (win32 passthrough + the temp
    // write) hasn't drifted since the #130 extraction.
    const src = await readFile(new URL('./atomic-write.ts', import.meta.url), 'utf8');

    expect(src).not.toMatch(/writeFileSync\(/);

    const defIdx = [...src.matchAll(/export async function atomicWriteFile\(/g)];
    expect(defIdx).toHaveLength(1);

    const writeFileIdx = [...src.matchAll(/\bwriteFile\(/g)];
    expect(writeFileIdx).toHaveLength(2); // win32 passthrough + the temp write
  });
});

describe('JsonFileStore.deleteAllForRun (issue #107)', () => {
  it('deletes the run file for a plain (no idempotency key) run', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      expect(existsSync(join(dir, `${run.id}.json`))).toBe(true);

      await store.deleteAllForRun(run.id);

      expect(existsSync(join(dir, `${run.id}.json`))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('deletes the owned idempotency pointer alongside the run file', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k1',
      });
      const ptrPath = keyPointerPath(dir, 'wf-1', 'k1');
      expect(existsSync(ptrPath)).toBe(true);

      await store.deleteAllForRun(run.id);

      expect(existsSync(join(dir, `${run.id}.json`))).toBe(false);
      expect(existsSync(ptrPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does NOT delete a pointer that a rerun/supersede has repointed to a newer run (mutation-probe #2 target)', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run: oldRun } = await store.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k1',
      });
      await store.update({
        ...oldRun,
        run_phase: 'completed',
        terminal_state: true,
        terminal_reason: 'Workflow completed.',
      });
      const { run: newRun } = await store.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k1',
        onTerminalMatch: 'rerun',
      });
      const ptrPath = keyPointerPath(dir, 'wf-1', 'k1');
      expect(JSON.parse(await readFile(ptrPath, 'utf8')).run_id).toBe(newRun.id);

      // Purge the OLD (superseded) run. Its stored record still carries idempotency_key: 'k1',
      // but the pointer has since moved on to newRun — deleteAllForRun must not touch it.
      await store.deleteAllForRun(oldRun.id);

      expect(existsSync(join(dir, `${oldRun.id}.json`))).toBe(false); // old run file gone
      expect(existsSync(ptrPath)).toBe(true); // pointer untouched
      expect(JSON.parse(await readFile(ptrPath, 'utf8')).run_id).toBe(newRun.id); // still the successor
      expect((await store.get(newRun.id)).id).toBe(newRun.id); // successor completely unaffected
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second call, or a call on an already-gone run, is a no-op (never throws)', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });

      await store.deleteAllForRun(run.id);

      await expect(store.deleteAllForRun(run.id)).resolves.toBeUndefined();
      await expect(store.deleteAllForRun('never-existed-at-all')).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores dirEntries (exact-path store — the batch hint is for glob-based stores only)', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });

      // A dirEntries hint that does NOT mention the run file at all — deleteAllForRun must still
      // find and delete it via its own exact path, proving the hint really is ignored.
      await store.deleteAllForRun(run.id, ['completely-unrelated.json']);

      expect(existsSync(join(dir, `${run.id}.json`))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('JsonFileStore ENOENT hardening (issue #107)', () => {
  it('get() throws STATE_RUN_NOT_FOUND for a run that never existed', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      await expect(store.get('never-existed')).rejects.toMatchObject({
        code: 'STATE_RUN_NOT_FOUND',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('update() throws STATE_RUN_NOT_FOUND for a run that never existed', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      await expect(
        store.update(makeRunRecord({ id: 'never-existed', workflow_id: 'wf-1', version: 0 })),
      ).rejects.toMatchObject({ code: 'STATE_RUN_NOT_FOUND' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('list() tolerates a run file vanishing concurrently with the read (skips it, never throws a raw ENOENT)', async () => {
    // The concurrency-hammer style used elsewhere in this file (T1/T2) for exactly this class of
    // hard-to-deterministically-trigger race: real concurrent list() reads racing real concurrent
    // deleteAllForRun deletes, over enough volume to exercise the ENOENT-during-readFile window
    // many times. Any raw (non-STATE_RUN_NOT_FOUND-shaped) error means #132's torn-read loudness
    // regressed into a crash on a benign concurrent purge instead of a skip.
    const { store, dir } = await makeTmpStore();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 40; i++) {
        const { run } = await store.create({
          workflowId: 'wf-1',
          workflowVersion: 1,
          params: { i },
        });
        ids.push(run.id);
      }

      const readErrors: unknown[] = [];
      let done = false;
      const reader = async (): Promise<void> => {
        while (!done) {
          try {
            await store.list();
          } catch (err) {
            readErrors.push(err);
          }
        }
      };
      const readers = Array.from({ length: 8 }, () => reader());

      for (const id of ids) {
        await store.deleteAllForRun(id);
      }
      done = true;
      await Promise.all(readers);

      expect(readErrors).toEqual([]); // zero crashes — every vanished file was skipped, not thrown
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('list() drops a run file whose content vanishes mid-scan without affecting the rest', async () => {
    // A more targeted (non-racy) companion to the volume test above: seed several runs, delete one
    // right before list() is invoked so its readdir()-observed presence is a coin flip depending on
    // ordering — either way, list() must return every OTHER run's record intact.
    const { store, dir } = await makeTmpStore();
    try {
      const { run: keep1 } = await store.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
      });
      const { run: victim } = await store.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
      });
      const { run: keep2 } = await store.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
      });

      const [, all] = await Promise.all([store.deleteAllForRun(victim.id), store.list()]);
      const ids = all.map((r) => r.id);
      expect(ids).toContain(keep1.id);
      expect(ids).toContain(keep2.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
