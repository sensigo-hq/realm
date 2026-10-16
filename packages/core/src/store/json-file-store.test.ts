// Tests for JsonFileStore: create, get, update, list, and claimStep operations.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readdir, writeFile, readFile, unlink, chmod } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import retry from 'retry';
import { JsonFileStore, LOCK_RETRIES } from './json-file-store.js';
import { unreadableFactsOf, unreadableRunFilesOf } from './run-file.js';
import { abandonRun } from '../engine/abandon-run.js';
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
      sealed_by: { arm: 'complete' },
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
      sealed_by: { arm: 'complete' },
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const b = makeRunRecord({
      id: 'bbb',
      workflow_id: 'wf-1',
      idempotency_key: 'k1',
      run_phase: 'failed',
      terminal_state: true,
      sealed_by: { arm: 'step_failure' },
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
      sealed_by: { arm: 'complete' },
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
            sealed_by: { arm: 'complete' as const },
            terminal_reason: 'Workflow completed.',
          }
        : phase === 'aborted'
          ? {
              run_phase: 'aborted' as const,
              terminal_state: true,
              sealed_by: { arm: 'guard_abort' as const },
              aborted_at: { step_id: 's' },
            }
          : phase === 'failed'
            ? {
                run_phase: 'failed' as const,
                terminal_state: true,
                sealed_by: { arm: 'step_failure' as const },
                failed_steps: ['s'],
              }
            : {
                run_phase: 'abandoned' as const,
                terminal_state: true,
                sealed_by: { arm: 'abandon_requested' as const },
              };
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
      pending_gate: {
        gate_id: 'g',
        step_name: 's',
        preview: {},
        choices: ['ok'],
        opened_at: '2026-01-01T00:00:00.000Z',
      },
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
      sealed_by: { arm: 'step_failure' },
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

    // 7 occurrences of atomicWriteFile( = the 7 write paths (writePointer, writeFreshRun,
    // update, claimStep, save, settleStep [issue #279, increment 1 — a genuinely NEW write site],
    // stampSeal [issue #367, part 3 — likewise: the migration vehicle's only write verb]).
    // The import statement itself has no trailing '(' so it doesn't inflate this count.
    const atomicIdx = [...src.matchAll(/\batomicWriteFile\(/g)];
    expect(atomicIdx).toHaveLength(7);
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
      // issue #184: deleteAllForRun now re-verifies terminal state under its lock — a fresh
      // store.create() run is 'running' by default, so mark it terminal before purging it.
      await store.update({
        ...run,
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
      });

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
      // issue #184: mark terminal before purging (see the sibling test above for why).
      await store.update({
        ...run,
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
      });

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
        sealed_by: { arm: 'complete' },
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
      // issue #184: mark terminal before purging (see the first test in this describe for why).
      await store.update({
        ...run,
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
      });

      await store.deleteAllForRun(run.id);

      // issue #189: idempotent AND honest — a second delete frees nothing and reports zero.
      await expect(store.deleteAllForRun(run.id)).resolves.toEqual({ bytes_deleted: 0 });
      await expect(store.deleteAllForRun('never-existed-at-all')).resolves.toEqual({
        bytes_deleted: 0,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores dirEntries (exact-path store — the batch hint is for glob-based stores only)', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      // issue #184: mark terminal before purging (see the first test in this describe for why).
      await store.update({
        ...run,
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
      });

      // A dirEntries hint that does NOT mention the run file at all — deleteAllForRun must still
      // find and delete it via its own exact path, proving the hint really is ignored.
      await store.deleteAllForRun(run.id, ['completely-unrelated.json']);

      expect(existsSync(join(dir, `${run.id}.json`))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('JsonFileStore.deleteAllForRun — purge correctness (issue #184)', () => {
  it('resurrect-race fix: refuses (STATE_RUN_BUSY, reason no_longer_terminal) when the on-disk record is no longer terminal at delete time, and the run file survives intact', async () => {
    // Deterministic proof of the actual bug: a run selected as terminal can be "resumed" (flipped
    // back to a live state) BEFORE deleteAllForRun's lock is acquired — simulating exactly what a
    // concurrent `realm run resume` racing a batch purge does (resume.ts sets terminal_state: false;
    // RESUMABLE_PHASES ⊂ TERMINAL_PHASES). deleteAllForRun must re-verify UNDER ITS OWN LOCK, not
    // trust a caller's earlier selection-time snapshot.
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      await store.update({
        ...run,
        run_phase: 'abandoned',
        terminal_state: true,
        sealed_by: { arm: 'abandon_requested' },
      });

      // The "concurrent resume" — mirrors resume.ts's own field flip exactly, which since #367
      // includes STRIPPING `sealed_by` in the same write (a live run carrying a seal is an
      // orphan, and the store boundary refuses it).
      const resumed = await store.get(run.id);
      const { sealed_by: _sb, ...resumedBase } = resumed;
      await store.update({ ...resumedBase, run_phase: 'running', terminal_state: false });

      await expect(store.deleteAllForRun(run.id)).rejects.toMatchObject({
        code: 'STATE_RUN_BUSY',
        details: { runId: run.id, reason: 'no_longer_terminal' },
      });

      // The run file MUST survive, completely intact — not partially deleted.
      expect(existsSync(join(dir, `${run.id}.json`))).toBe(true);
      const survivor = await store.get(run.id);
      expect(survivor.terminal_state).toBe(false);
      expect(survivor.run_phase).toBe('running');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // issue #279 (increment 1, PR-B), R11: drain_pending — a terminal run with an undrained
  // finalizer must never be deleted, since that would destroy the record a later `realm run
  // drain`/`--void` needs. Unconditional — no store-level force bypass exists (purge.ts's
  // single-id --force path inherits this same under-lock throw automatically).
  it('drain_pending: refuses (STATE_RUN_BUSY, reason drain_pending) when a finalizer ledger entry is still pending, and the run file survives intact', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      await store.update({
        ...run,
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
        terminal_reason: 'Workflow completed.',
        finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
      });

      await expect(store.deleteAllForRun(run.id)).rejects.toMatchObject({
        code: 'STATE_RUN_BUSY',
        details: { runId: run.id, reason: 'drain_pending' },
      });

      expect(existsSync(join(dir, `${run.id}.json`))).toBe(true);
      const survivor = await store.get(run.id);
      expect(survivor.finalizer_ledger?.['fin']?.status).toBe('pending');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drain_pending: a run whose finalizer ledger has NO pending entries (completed/failed/voided only) deletes normally', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      await store.update({
        ...run,
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
        terminal_reason: 'Workflow completed.',
        finalizer_ledger: {
          done: { status: 'completed', rank: 0 },
          gone: { status: 'voided', rank: 1 },
        },
      });

      // issue #189: a real delete frees real bytes — the receipt is positive, not merely defined.
      const report = await store.deleteAllForRun(run.id);
      expect(report.bytes_deleted).toBeGreaterThan(0);
      expect(existsSync(join(dir, `${run.id}.json`))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // issue #191: deleteAllForRun's OWN lock acquisition now retries against LOCK_RETRIES'
  // maxRetryTime:5000 total-time budget before giving up (this test holds the external lock for
  // the ENTIRE duration, so it now genuinely waits out that full budget, up from the pre-#191
  // ~350ms count-bound) — override vitest's global 5000ms testTimeout (the same value as the
  // production budget itself), mirroring this file's own precedent of per-test timeout overrides
  // for genuinely slow, real-timing tests. 20s (4× the ~5s nominal budget), not 10s: measured
  // flaky at 10s under `npm run test`'s full-monorepo concurrent load (turbo running all 4
  // packages' vitest suites at once — this repo's OWN documented "nested-parallelism CPU
  // starvation" concern, vitest.config.mts) — a real-timer budget needs headroom against
  // scheduling jitter under load, not just against its own nominal value.
  it('ELOCKED: refuses (STATE_RUN_BUSY, reason locked) when another writer holds the run-file lock, and the run file survives untouched', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      await store.update({
        ...run,
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
      });

      const path = join(dir, `${run.id}.json`);
      const contentBefore = await readFile(path, 'utf8');

      // Hold the SAME run-file lock deleteAllForRun will try to acquire — proper-lockfile's lock
      // is a real on-disk directory (`<path>.lock`), so this is genuine cross-caller contention
      // within the same process, not a mock.
      const externalRelease = await lockfile.lock(path, {
        realpath: false,
        retries: { retries: 3, minTimeout: 50 },
      });
      try {
        await expect(store.deleteAllForRun(run.id)).rejects.toMatchObject({
          code: 'STATE_RUN_BUSY',
          details: { runId: run.id, reason: 'locked' },
        });
      } finally {
        await externalRelease();
      }

      // Untouched: not just present, but byte-identical to before the attempt.
      expect(existsSync(path)).toBe(true);
      expect(await readFile(path, 'utf8')).toBe(contentBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('key-lock TOCTOU: the pointer delete happens under the key lock — held briefly by another writer, deleteAllForRun retries and succeeds once it frees up', async () => {
    // Proves the pointer read→check→delete critical section genuinely goes through the SAME key
    // lock create()/writePointer() use (nested inside the run-file lock — see the class's GLOBAL
    // LOCK ORDER doc). Held only briefly (well inside KEY_LOCK_RETRIES' budget) rather than to
    // full exhaustion — KEY_LOCK_RETRIES is 10 retries with exponential backoff off a 50ms floor
    // (the `retry` package's default factor is 2), so fully exhausting it takes upwards of 50
    // SECONDS — this test instead confirms deleteAllForRun genuinely WAITS for the lock (a timing
    // floor, not just an eventual-success check — an unlocked implementation would sail through in
    // a few ms regardless of this external hold) and then succeeds once it's free.
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k1',
      });
      await store.update({
        ...run,
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
      });
      const ptrPath = keyPointerPath(dir, 'wf-1', 'k1');
      expect(existsSync(ptrPath)).toBe(true);

      const HOLD_MS = 150;
      const externalKeyRelease = await lockfile.lock(ptrPath, { realpath: false });
      setTimeout(() => {
        void externalKeyRelease();
      }, HOLD_MS);

      const before = Date.now();
      await store.deleteAllForRun(run.id);
      const elapsed = Date.now() - before;

      expect(elapsed).toBeGreaterThanOrEqual(HOLD_MS - 20); // waited for the external hold — not a race
      expect(existsSync(join(dir, `${run.id}.json`))).toBe(false);
      expect(existsSync(ptrPath)).toBe(false);
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
        // issue #184: mark terminal before purging (deleteAllForRun now re-verifies terminal
        // state under its lock).
        await store.update({
          ...run,
          run_phase: 'completed',
          terminal_state: true,
          sealed_by: { arm: 'complete' },
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
  }, 20_000); // per-test: a concurrency hammer (40 creates+updates + 8 concurrent list() readers) — see :1049

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
      // issue #184: mark the victim terminal before purging it (deleteAllForRun now re-verifies
      // terminal state under its lock).
      await store.update({
        ...victim,
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
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

describe('JsonFileStore.listRunIds (issue #163)', () => {
  it('returns the raw <id>.json basename set — no record parse', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run: a } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      const { run: b } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });

      const ids = await store.listRunIds();

      expect(ids).toEqual(new Set([a.id, b.id]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a corrupt-but-present <id>.json still counts as LIVE (proves this is basename-only, not list())', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const corruptId = 'deadbeef-dead-4eef-8eef-deadbeefdead';
      await writeFile(join(dir, `${corruptId}.json`), '{ this is not valid json', 'utf8');

      // Sanity: list() would choke on this exact file (JSON.parse with no try/catch) — confirming
      // listRunIds() is NOT built on top of list() for exactly this reason.
      await expect(store.list()).rejects.toThrow();

      const ids = await store.listRunIds();
      expect(ids.has(corruptId)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores the keys/ subdirectory and any non-.json entries', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k1',
      });
      // keys/ now exists (create() with an idempotencyKey makes it) — must not appear in the set.

      const ids = await store.listRunIds();

      expect(ids).toEqual(new Set([run.id]));
      expect(ids.has('keys')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a missing runsDir (ENOENT) resolves to an empty set — not a throw', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'realm-test-')), 'does', 'not', 'exist');
    const store = new JsonFileStore(dir);
    await expect(store.listRunIds()).resolves.toEqual(new Set());
  });

  it('fail-closed: a non-ENOENT readdir error THROWS — never a fabricated empty set', async () => {
    const { dir } = await makeTmpStore();
    try {
      // A file (not a directory) in place of runsDir's own path — readdir on it fails ENOTDIR.
      const notADirPath = join(dir, 'poison');
      await writeFile(notADirPath, 'x');
      const brokenStore = new JsonFileStore(notADirPath);

      await expect(brokenStore.listRunIds()).rejects.toMatchObject({ code: 'ENOTDIR' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('JsonFileStore lock retry policy — jittered bounded backoff (issue #191, Fix A)', () => {
  it('LOCK_RETRIES carries randomize:true, a bounded maxTimeout, and a maxRetryTime total-time budget', () => {
    expect(LOCK_RETRIES.randomize).toBe(true);
    expect(LOCK_RETRIES.maxTimeout).toBe(1000);
    expect(LOCK_RETRIES.maxRetryTime).toBe(5000);
    expect(LOCK_RETRIES.retries).toBe(10);
    expect(LOCK_RETRIES.minTimeout).toBe(50);
  });

  it('randomize genuinely reaches the REAL `retry` package proper-lockfile itself delegates to — two independently-computed schedules from the SAME config differ; the identical config with randomize:false is fully deterministic (the pre-#191 lockstep shape)', () => {
    // proper-lockfile/lib/lockfile.js:230 passes our config object VERBATIM into
    // `retry.operation(options.retries)` — this test calls the exact same real dependency function
    // (`retry.timeouts`, which `retry.operation` uses internally to build its schedule) with our
    // exact LOCK_RETRIES literal, so this is a direct integration proof, not a reimplementation.
    const scheduleA = retry.timeouts(LOCK_RETRIES);
    const scheduleB = retry.timeouts(LOCK_RETRIES);
    expect(scheduleA).not.toEqual(scheduleB); // jitter — a fresh Math.random() draw per attempt

    const unjittered = { ...LOCK_RETRIES, randomize: false };
    const deterministicA = retry.timeouts(unjittered);
    const deterministicB = retry.timeouts(unjittered);
    expect(deterministicA).toEqual(deterministicB); // the contrast case: randomize is what flips it

    // maxTimeout also reaches retry: no computed per-attempt delay exceeds the cap.
    for (const t of scheduleA) expect(t).toBeLessThanOrEqual(LOCK_RETRIES.maxTimeout);
  });

  it('maxRetryTime forwards through proper-lockfile end-to-end — a direct assertion the option reaches the REAL RetryOperation instance proper-lockfile constructs', () => {
    // Source-confirmed chain (file:line, both read directly — no mock stands in for either):
    //  - proper-lockfile/lib/lockfile.js:230 — `const operation = retry.operation(options.retries);`
    //    forwards our WHOLE config object unfiltered.
    //  - retry/lib/retry.js's `exports.operation` reads `options.maxRetryTime` off that SAME object
    //    into RetryOperation's 2nd constructor arg.
    //  - retry/lib/retry_operation.js:10 — `this._maxRetryTime = options && options.maxRetryTime || Infinity;`
    //  - retry/lib/retry_operation.js:48 — `.retry(err)` compares elapsed wall-time against it on
    //    every failed attempt and gives up once exceeded, REGARDLESS of retries remaining — the
    //    total-time-budget mechanism itself.
    // This test constructs a REAL RetryOperation from our REAL LOCK_RETRIES (the exact call
    // proper-lockfile itself makes) and asserts the value round-tripped onto the live instance —
    // VERDICT: maxRetryTime DOES forward. (The mechanism is additionally exercised for real, not
    // just structurally, by the deleteAllForRun ELOCKED test above — now measured at ~5.08s
    // wall-clock, bounded near maxRetryTime:5000 rather than the ~6.5s+ count-bound alternative;
    // its `it()` timeout was raised to 10s specifically to accommodate this.)
    const operation = retry.operation(LOCK_RETRIES);
    expect((operation as unknown as { _maxRetryTime: number })._maxRetryTime).toBe(5000);
  });

  it('the 6 run-file lock sites and 3 key-lock sites all reference the ONE shared LOCK_RETRIES const — no remaining bare {retries:3,minTimeout:50} or KEY_LOCK_RETRIES anywhere in the source', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./json-file-store.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('KEY_LOCK_RETRIES');
    expect(source).not.toContain('retries: 3, minTimeout: 50');
    // 8 = the original 4 run-file sites (update/claimStep/save/deleteAllForRun) + 3 key-lock sites
    // (issue #191) + 1 (settleStep, issue #279 increment 1 — a genuinely NEW run-file lock site).
    // 9 since issue #367 part 3: stampSeal takes the run-file lock like every other write path.
    expect(source.match(/retries: LOCK_RETRIES/g)?.length).toBe(9);
  });
});

describe('JsonFileStore — exhausted ELOCKED reclassified as STATE_RUN_BUSY (issue #191, Fix C)', () => {
  const elockedErr = (): NodeJS.ErrnoException =>
    Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('update(): a mocked exhausted lock acquisition throws STATE_RUN_BUSY (retryable:true, reason:locked) — not a fatal error', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      vi.spyOn(lockfile, 'lock').mockRejectedValueOnce(elockedErr());

      await expect(store.update({ ...run, run_phase: 'running' })).rejects.toMatchObject({
        code: 'STATE_RUN_BUSY',
        retryable: true,
        details: { runId: run.id, reason: 'locked' },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('claimStep(): a mocked exhausted lock acquisition throws STATE_RUN_BUSY (retryable:true, reason:locked) — the release()/finally shape for the SUCCESS path is untouched', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      vi.spyOn(lockfile, 'lock').mockRejectedValueOnce(elockedErr());

      await expect(store.claimStep(run.id, 'step-one', minimalDef)).rejects.toMatchObject({
        code: 'STATE_RUN_BUSY',
        retryable: true,
        details: { runId: run.id, reason: 'locked' },
      });

      // The mock was one-shot (mockRejectedValueOnce) — a genuine, unmocked claimStep still
      // succeeds afterward, proving the try/catch wrap didn't disturb the success path at all.
      const claimed = await store.claimStep(run.id, 'step-one', minimalDef);
      expect(claimed.in_progress_steps).toContain('step-one');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('save(): a mocked exhausted lock acquisition throws STATE_RUN_BUSY (retryable:true, reason:locked)', async () => {
    const { dir } = await makeTmpStore();
    try {
      const store = new JsonFileStore(dir);
      const run = makeRunRecord({ id: 'run-save-elocked', workflow_id: 'wf-1' });
      vi.spyOn(lockfile, 'lock').mockRejectedValueOnce(elockedErr());

      await expect(store.save(run)).rejects.toMatchObject({
        code: 'STATE_RUN_BUSY',
        retryable: true,
        details: { runId: run.id, reason: 'locked' },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('update(): ENOENT is STILL mapped to STATE_RUN_NOT_FOUND — the new ELOCKED branch does not clobber the pre-existing TOCTOU mapping (a file present at the existsSync guard but gone by the time the lock is attempted)', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      // The file genuinely exists (existsSync passes) — mock ONLY the lock call itself to
      // reproduce the documented TOCTOU race (issue #107's own comment on this catch block).
      vi.spyOn(lockfile, 'lock').mockRejectedValueOnce(
        Object.assign(new Error('no such file or directory'), { code: 'ENOENT' }),
      );

      await expect(store.update({ ...run, run_phase: 'running' })).rejects.toMatchObject({
        code: 'STATE_RUN_NOT_FOUND',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('update(): an unrecognized lock-acquisition errno is neither swallowed nor reclassified — it propagates as-is', async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const { run } = await store.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      vi.spyOn(lockfile, 'lock').mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );

      await expect(store.update({ ...run, run_phase: 'running' })).rejects.toMatchObject({
        code: 'EACCES',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// issue #558 PR-C (C-6): the rerun is LINKED. `supersede()` is the ONE place both ids are in hand,
// so it is the one place `rerun_of` is stamped — never caller-settable (`CreateRunOptions` does not
// carry it), never rewritten. Absent for a first run and for a `reuse`.
describe('JsonFileStore — rerun_of, the supersede link (issue #558 PR-C)', () => {
  let dir: string;
  let store: JsonFileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-rerunof-'));
    store = new JsonFileStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const opts = { workflowId: 'wf-1', workflowVersion: 1, params: {}, idempotencyKey: 'k4' };

  it('the pointer-target path: abandon then `rerun` stamps rerun_of and leaves the old record untouched', async () => {
    const first = await store.create({ ...opts });
    expect(first.created).toBe(true);
    expect(first.run.rerun_of).toBeUndefined();
    const abandoned = await abandonRun(store, first.run.id, 'Abandoned via realm run abandon');
    const versionAfterAbandon = abandoned.version;

    const second = await store.create({ ...opts, onTerminalMatch: 'rerun' });

    expect(second.created).toBe(true);
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.run.rerun_of).toBe(first.run.id);
    // The superseded run stays on disk, byte-for-byte as the abandon left it.
    const old = await store.get(first.run.id);
    expect(old.version).toBe(versionAfterAbandon);
    expect(old.run_phase).toBe('abandoned');
    expect(old.rerun_of).toBeUndefined();
  });

  it('a `reuse` re-encounter returns the SAME run and stamps nothing', async () => {
    const first = await store.create({ ...opts });
    await abandonRun(store, first.run.id, 'Abandoned via realm run abandon');

    const second = await store.create({ ...opts, onTerminalMatch: 'reuse' });

    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(second.run.rerun_of).toBeUndefined();
  });

  it('a fresh key carries no link at all (the field is absent, not null)', async () => {
    const { run } = await store.create({ ...opts, idempotencyKey: 'never-seen' });

    expect(run.rerun_of).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(run, 'rerun_of')).toBe(false);
  });

  it('the LEGACY-CANONICAL path (pointer gone, run adopted by scan) stamps it too', async () => {
    const first = await store.create({ ...opts });
    await abandonRun(store, first.run.id, 'Abandoned via realm run abandon');
    // Delete the pointer: the next create falls through to the canonical scan (`:339`), the second
    // supersede call site. Without its own `supersededId` argument this path stamped nothing.
    await unlink(keyPointerPath(dir, 'wf-1', 'k4'));

    const second = await store.create({ ...opts, onTerminalMatch: 'rerun' });

    expect(second.created).toBe(true);
    expect(second.run.rerun_of).toBe(first.run.id);
  });
});

// ─── issue #719 — a damaged run file, on a real store in a temp folder ─────────────────────────
describe('issue #719 — a damaged run file through every reader of the JSON store', () => {
  let d: string;
  let st: JsonFileStore;
  beforeEach(async () => {
    d = await mkdtemp(join(tmpdir(), 'realm-719-jfs-'));
    st = new JsonFileStore(d);
    await st.list();
  });
  afterEach(async () => {
    for (const f of await readdir(d)) {
      if (f.endsWith('.json')) await chmod(join(d, f), 0o600).catch(() => undefined);
    }
    await rm(d, { recursive: true, force: true });
  });

  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const full = (id: string, over: Partial<RunRecord> = {}) =>
    makeRunRecord({ id, workflow_id: 'wa', ...over });
  /** Each class, as written to `x.json`, and the code reading it must give. */
  const CLASSES: Array<[string, () => Promise<void>, string]> = [
    ['empty', () => writeFile(join(d, 'x.json'), ''), 'RESOURCE_FORMAT_INVALID'],
    ['parse', () => writeFile(join(d, 'x.json'), '{not json'), 'RESOURCE_FORMAT_INVALID'],
    [
      'not_a_run',
      () => writeFile(join(d, 'x.json'), JSON.stringify({ id: 'x' })),
      'RESOURCE_FORMAT_INVALID',
    ],
    [
      'mismatched',
      () => writeFile(join(d, 'x.json'), JSON.stringify(full('other'))),
      'RESOURCE_FORMAT_INVALID',
    ],
    [
      'legacy',
      () => writeFile(join(d, 'x.json'), JSON.stringify({ id: 'x', state: 'running' })),
      'STATE_LEGACY_FORMAT',
    ],
    ...(asRoot
      ? []
      : ([
          [
            'unreadable',
            async () => {
              await writeFile(join(d, 'x.json'), JSON.stringify(full('x')));
              await chmod(join(d, 'x.json'), 0o000);
            },
            'ENGINE_STORE_FAILED',
          ],
        ] as Array<[string, () => Promise<void>, string]>)),
  ];
  const def = {
    id: 'wa',
    name: 'wa',
    version: 1,
    steps: { a: { description: 'A.', execution: 'agent' } },
  } as unknown as WorkflowDefinition;
  const READERS: Array<[string, () => Promise<unknown>]> = [
    ['get', () => st.get('x')],
    ['update', () => st.update(full('x'))],
    ['claimStep', () => st.claimStep('x', 'a', def)],
    ['settleStep', () => st.settleStep('x', { kind: 'expire_gate', gateId: 'g' }, def)],
    ['stampSeal', () => st.stampSeal('x', { arm: 'run_abandoned' } as never, 0)],
    ['save', () => st.save(full('x'))],
    ['list', () => st.list()],
  ];

  it.each(
    CLASSES.flatMap(([cls, seed, code]) =>
      READERS.map(([r, call]) => [r, cls, seed, code, call] as const),
    ),
  )('%s on a %s file throws its typed error', async (_reader, cls, seed, code, call) => {
    await seed();
    const err = await call().then(
      () => undefined,
      (e: unknown) => e,
    );
    // (a) red when a reader parses past the reader (a raw SyntaxError, a cast record, no legacy
    //     check), or names another class; (b) prints the code and the class.
    expect({
      code: (err as WorkflowError | undefined)?.code,
      class: unreadableFactsOf(err)?.class,
    }).toEqual({ code, class: cls });
  });

  it('list() throws the FIRST damaged file’s typed error, by name', async () => {
    await writeFile(join(d, 'b.json'), '');
    await writeFile(join(d, 'a.json'), '{not json');
    const err = await st.list().then(
      () => undefined,
      (e: unknown) => e,
    );
    // (a) red when it lists past a damaged file, or names another; (b) prints the facts.
    expect(unreadableFactsOf(err)).toEqual({
      resource: 'run_file',
      class: 'parse',
      path: join(d, 'a.json'),
    });
  });

  it('guard: the record shapes Realm writes stay readable, params of every JSON kind included', async () => {
    const kinds: unknown[] = [{}, null, [1, 'a'], 'text', 42];
    for (const [i, params] of kinds.entries()) {
      await writeFile(join(d, `p${i}.json`), JSON.stringify(full(`p${i}`, { params } as never)));
    }
    const read = await Promise.all(kinds.map((_, i) => st.get(`p${i}`)));
    // (b) prints the params read back.
    expect(read.map((r) => r.params)).toEqual(kinds);
  });

  it('listWithDiagnostics: the readable run in records; each damaged file named, sorted, with its class and path', async () => {
    await writeFile(join(d, 'good.json'), JSON.stringify(full('good')));
    const files: Array<[string, string, string]> = [
      ['a-empty.json', '', 'empty'],
      ['b-parse.json', '{not json', 'parse'],
      ['c-not.json', JSON.stringify({ id: 'c-not' }), 'not_a_run'],
      ['d-mis.json', JSON.stringify(full('elsewhere')), 'mismatched'],
      ['e-leg.json', JSON.stringify({ state: 'x' }), 'legacy'],
    ];
    for (const [f, bytes] of files) await writeFile(join(d, f), bytes);
    if (!asRoot) {
      await writeFile(join(d, 'f-locked.json'), JSON.stringify(full('f-locked')));
      await chmod(join(d, 'f-locked.json'), 0o000);
    }
    const listing = await st.listWithDiagnostics();
    // (a) red when a damaged file hides the run, a file is missed, or a class is wrong; (b) prints
    //     the ids read and each entry's file, class and path.
    expect({
      records: listing.records.map((r) => r.id),
      unreadable: listing.unreadable.map((u) => [u.file, u.class, u.path]),
    }).toEqual({
      records: ['good'],
      unreadable: [
        ...files.map(([f, , cls]) => [f, cls, join(d, f)]),
        ...(asRoot ? [] : [['f-locked.json', 'unreadable', join(d, 'f-locked.json')]]),
      ],
    });
  });

  describe('keyed create (B4, C1): a damaged file refuses a key only when it can affect the create', () => {
    const create = (workflowId = 'wb') =>
      st.create({ workflowId, workflowVersion: 1, params: {}, idempotencyKey: 'k-719' });
    const EVERY =
      'A run with a new idempotency key cannot be created on this store until the file is repaired or moved out.';
    const THIS =
      'A run with this idempotency key cannot be created until the file is repaired or moved out.';
    /** issue #719 (F6.2): a file that cannot be read is made readable, not repaired. */
    const EVERY_READ =
      'A run with a new idempotency key cannot be created on this store until the file can be read or is moved out.';
    /** What the create gave: created, or the refusal's code, its `refused` fact and which sentence
     *  it says (never the key: it is not echoed). */
    const outcome = async (workflowId = 'wb') =>
      create(workflowId).then(
        (v) => ({ created: v.created }),
        (e: unknown) => ({
          code: (e as WorkflowError).code,
          refused: unreadableFactsOf(e)?.refused,
          sentence: (e as Error).message.includes(EVERY)
            ? 'every_new_key'
            : (e as Error).message.includes(EVERY_READ)
              ? 'every_new_key (can be read)'
              : (e as Error).message.includes(THIS)
                ? 'this_key'
                : 'none',
        }),
      );

    it.each([
      ['an array', '[1,2]'],
      ['a string', '"x"'],
      ['a number', '42'],
      ['a boolean', 'true'],
      ['null', 'null'],
    ])(
      'a run file holding JSON that is %s (no workflow, no key): the create goes on, as 0.46.0 did',
      async (_c, bytes) => {
        await writeFile(join(d, 'x.json'), bytes);
        // (a) red when a file that can hold no key refuses every new key (`b53cee02`); (b) prints
        //     the outcome.
        expect(await outcome()).toEqual({ created: true });
      },
    );

    it.each([
      ['empty', ''],
      ['not JSON', '{not json'],
    ])(
      'guard: a file that is %s: what it holds cannot be read — every new key refused',
      async (_c, bytes) => {
        await writeFile(join(d, 'x.json'), bytes);
        // (b) prints the code, the `refused` fact and the sentence.
        expect(await outcome()).toEqual({
          code: 'RESOURCE_FORMAT_INVALID',
          refused: 'every_new_key',
          sentence: 'every_new_key',
        });
      },
    );

    it.skipIf(asRoot)(
      'an unreadable file: every new key refused, with its `refused` fact',
      async () => {
        await writeFile(join(d, 'x.json'), JSON.stringify(full('x')));
        await chmod(join(d, 'x.json'), 0o000);
        // (a) red when the fact is not the store-wide one, or the sentence says "repaired" for a
        //     file that only has to be made readable (F6.2); (b) prints them.
        expect(await outcome()).toEqual({
          code: 'ENGINE_STORE_FAILED',
          refused: 'every_new_key',
          sentence: 'every_new_key (can be read)',
        });
      },
    );

    /** A readable damaged object, each class, naming workflow `workflowId` (or none). */
    const OBJECTS: Array<[string, (w: string | undefined) => Record<string, unknown>, string]> = [
      [
        'not_a_run',
        (w) => ({ id: 'x', ...(w !== undefined ? { workflow_id: w } : {}) }),
        'RESOURCE_FORMAT_INVALID',
      ],
      [
        'mismatched',
        (w) => ({ ...full('other'), ...(w !== undefined ? { workflow_id: w } : {}) }),
        'RESOURCE_FORMAT_INVALID',
      ],
      [
        'legacy',
        (w) => ({ id: 'x', state: 'running', ...(w !== undefined ? { workflow_id: w } : {}) }),
        'STATE_LEGACY_FORMAT',
      ],
    ];
    it.each(OBJECTS)(
      'a %s file naming ANOTHER workflow and carrying the key: the create goes on',
      async (_c, obj) => {
        await writeFile(
          join(d, 'x.json'),
          JSON.stringify({ ...obj('wa'), idempotency_key: 'k-719' }),
        );
        // (a) red when a file of workflow `wa` refuses a key of workflow `wb` (a Realm key belongs
        //     to one workflow); (b) prints the outcome.
        expect(await outcome()).toEqual({ created: true });
      },
    );
    it.each(OBJECTS)(
      'a %s file naming THIS workflow and carrying the key: this key refused',
      async (_c, obj, code) => {
        await writeFile(
          join(d, 'x.json'),
          JSON.stringify({ ...obj('wb'), idempotency_key: 'k-719' }),
        );
        // (a) red when a file that may hold this key is skipped, or refuses every key; (b) prints
        //     the code, the fact and the sentence.
        expect(await outcome()).toEqual({ code, refused: 'this_key', sentence: 'this_key' });
      },
    );
    it.each(OBJECTS.filter(([c]) => c !== 'mismatched'))(
      'a %s file naming NO workflow and carrying the key: this key refused',
      async (_c, obj, code) => {
        await writeFile(
          join(d, 'x.json'),
          JSON.stringify({ ...obj(undefined), idempotency_key: 'k-719' }),
        );
        // (a) red when a file whose workflow cannot be known is treated as another workflow's;
        //     (b) prints the code, the fact and the sentence.
        expect(await outcome()).toEqual({ code, refused: 'this_key', sentence: 'this_key' });
      },
    );
    it.each(OBJECTS)(
      'guard: a %s file of this workflow WITHOUT the key does not stop the create',
      async (_c, obj) => {
        await writeFile(join(d, 'x.json'), JSON.stringify(obj('wb')));
        expect(await outcome()).toEqual({ created: true });
      },
    );

    it('a mismatched copy of a run whose own file reads, both carrying the key: the run is reused, as 0.46.0 did', async () => {
      // No pointer (a store from before pointers): the scan runs.
      const run = full('r1', {
        workflow_id: 'wb',
        idempotency_key: 'k-719',
        terminal_state: false,
      } as never);
      await writeFile(join(d, 'r1.json'), JSON.stringify(run));
      await writeFile(join(d, 'r1.bak.json'), JSON.stringify(run));
      const r = await create();
      // (a) red when the copy refuses the key the real run answers; (b) prints created and the id.
      expect([r.created, r.run.id]).toEqual([false, 'r1']);
    });

    it('a copy holding an id text may not show, carrying the key: never looked up, so not a copy — this key refused (fail-closed, F5)', async () => {
      // The held run's own file reads (`two words.json`), but its id is not one text may show, so
      // `held_file` stays unset and the copy predicate does not hold.
      const run = full('two words', { workflow_id: 'wb', idempotency_key: 'k-719' } as never);
      await writeFile(join(d, 'two words.json'), JSON.stringify(run));
      await writeFile(join(d, 'x.json'), JSON.stringify(run));
      // (a) red when the scan skips a file whose held run was never judged (the old readable-ids
      //     set did); (b) prints the code, the fact and the sentence.
      expect(await outcome()).toEqual({
        code: 'RESOURCE_FORMAT_INVALID',
        refused: 'this_key',
        sentence: 'this_key',
      });
    });

    it('a folder named like a run file holds no key: the create goes on (F6.3)', async () => {
      await mkdir(join(d, 'x.json'));
      // (a) red when a folder refuses every new key; (b) prints the outcome.
      expect(await outcome()).toEqual({ created: true });
    });

    it('guard: an unkeyed create is never stopped', async () => {
      await writeFile(join(d, 'x.json'), '{not json');
      const r = await st.create({ workflowId: 'wb', workflowVersion: 1, params: {} });
      expect(r.created).toBe(true);
    });

    it('guard: a key whose pointer names a readable run is not stopped', async () => {
      const first = await create();
      await writeFile(join(d, 'x.json'), '{not json');
      const again = await create();
      expect([again.created, again.run.id]).toEqual([false, first.run.id]);
    });
  });

  describe('workflow-scoped reads (C1): only a damaged file that concerns the workflow stops them', () => {
    beforeEach(async () => {
      await writeFile(
        join(d, 'b1.json'),
        JSON.stringify(full('b1', { workflow_id: 'wb' } as never)),
      );
      await writeFile(join(d, 'x.json'), JSON.stringify({ id: 'x', workflow_id: 'wa' }));
    });

    it("list('wb') and reconcileKeys('wb') read past a damaged object naming workflow 'wa'", async () => {
      const listed = await st.list('wb').then(
        (rs) => rs.map((r) => r.id),
        (e: unknown) => (e as WorkflowError).code,
      );
      const reconciled = await st.reconcileKeys('wb').then(
        (s) => s.groups,
        (e: unknown) => (e as WorkflowError).code,
      );
      // (a) red when a file of another workflow stops this workflow's read; (b) prints the ids
      //     listed and the groups reconciled (or the code).
      expect({ listed, reconciled }).toEqual({ listed: ['b1'], reconciled: 0 });
    });

    it("a folder named like a run file stops neither list('wb') nor reconcileKeys('wb') (F6.3)", async () => {
      await rm(join(d, 'x.json'));
      await mkdir(join(d, 'x.json'));
      const listed = await st.list('wb').then(
        (rs) => rs.map((r) => r.id),
        (e: unknown) => (e as WorkflowError).code,
      );
      const reconciled = await st.reconcileKeys('wb').then(
        (r) => r.groups,
        (e: unknown) => (e as WorkflowError).code,
      );
      // (a) red when a folder (it holds no run and no key) stops a scoped read; (b) prints them.
      expect({ listed, reconciled }).toEqual({ listed: ['b1'], reconciled: 0 });
    });

    it("guard: list('wa'), reconcileKeys('wa') and the unfiltered list() still refuse it", async () => {
      const code = (p: Promise<unknown>) =>
        p.then(
          () => 'ok',
          (e: unknown) => (e as WorkflowError).code,
        );
      // (b) prints the three codes.
      expect({
        listA: await code(st.list('wa')),
        reconcileA: await code(st.reconcileKeys('wa')),
        listAll: await code(st.list()),
      }).toEqual({
        listA: 'RESOURCE_FORMAT_INVALID',
        reconcileA: 'RESOURCE_FORMAT_INVALID',
        listAll: 'RESOURCE_FORMAT_INVALID',
      });
    });

    it('guard: listWithDiagnostics(workflowId) filters the records only, and reports every damaged file', async () => {
      const listing = await st.listWithDiagnostics('wb');
      // (b) prints the ids and the damaged files.
      expect({
        records: listing.records.map((r) => r.id),
        unreadable: listing.unreadable.map((u) => u.file),
      }).toEqual({ records: ['b1'], unreadable: ['x.json'] });
    });
  });

  describe('reconcileKeys (R10, C3, C6): fails closed, naming every damaged file, writing nothing', () => {
    it('two format faults: RESOURCE_FORMAT_INVALID, both named through the one helper, the caller’s command, no pointer written', async () => {
      await writeFile(
        join(d, 'good.json'),
        JSON.stringify(full('good', { idempotency_key: 'k' } as never)),
      );
      await writeFile(join(d, 'a.json'), '');
      await writeFile(join(d, 'b.json'), '{not json');
      const err = (await st
        .reconcileKeys(undefined, false, { command: 'realm run reconcile --dry-run' })
        .catch((e: unknown) => e)) as WorkflowError;
      const facts = unreadableRunFilesOf(err);
      // (a) red when it reconciles past them, names only one, loses the command or the folder from
      //     its facts, or names a command of its own; (b) prints the code, the facts' command,
      //     folder and files, the message and whether a pointer was written.
      expect({
        code: err.code,
        command: facts?.command,
        folder: facts?.folder,
        files: facts?.files.map((f) => [f.path, f.class]),
        message: err.message,
        keysWritten: existsSync(join(d, 'keys')),
      }).toEqual({
        code: 'RESOURCE_FORMAT_INVALID',
        command: 'realm run reconcile --dry-run',
        folder: d,
        files: [
          [join(d, 'a.json'), 'empty'],
          [join(d, 'b.json'), 'parse'],
        ],
        message:
          `realm run reconcile --dry-run did not run: 2 run file(s) in '${d}' could not be read:\n` +
          `  ${join(d, 'a.json')}: is empty\n` +
          `  ${join(d, 'b.json')}: is not JSON\n` +
          "Repair, restore or move each one out ('realm run list' shows each file's way out), then run 'realm run reconcile --dry-run' again.",
        keysWritten: false,
      });
    });

    it('without a command from its caller, core names no CLI command', async () => {
      await writeFile(join(d, 'a.json'), '');
      const err = await st.reconcileKeys().catch((e: unknown) => e);
      // (a) red when core hardcodes `realm run reconcile`; (b) prints the command fact.
      expect(unreadableRunFilesOf(err)?.command).toBe('reconcileKeys');
    });

    it.skipIf(asRoot)('any unreadable file: ENGINE_STORE_FAILED', async () => {
      await writeFile(join(d, 'a.json'), '');
      await writeFile(join(d, 'b.json'), JSON.stringify(full('b')));
      await chmod(join(d, 'b.json'), 0o000);
      const err = (await st.reconcileKeys().catch((e: unknown) => e)) as WorkflowError;
      expect(err.code).toBe('ENGINE_STORE_FAILED');
    });
  });

  describe('deleteAllForRun (C6): a damaged run file’s typed error comes through as it is', () => {
    it('a file that is not JSON: RESOURCE_FORMAT_INVALID with its facts, not a delete failure', async () => {
      await writeFile(join(d, 'x.json'), '{not json');
      const err = (await st.deleteAllForRun('x').catch((e: unknown) => e)) as WorkflowError;
      // (a) red when the typed error is wrapped (its class lost, errno `UNKNOWN`); (b) prints the
      //     code and the facts.
      expect({ code: err.code, facts: unreadableFactsOf(err) }).toEqual({
        code: 'RESOURCE_FORMAT_INVALID',
        facts: { resource: 'run_file', class: 'parse', path: join(d, 'x.json') },
      });
    });

    it.skipIf(asRoot)(
      'guard: a file this user cannot read keeps the delete-failure wrap, its errno from the facts',
      async () => {
        await writeFile(
          join(d, 'x.json'),
          JSON.stringify(full('x', { terminal_state: true } as never)),
        );
        await chmod(join(d, 'x.json'), 0o000);
        const err = (await st.deleteAllForRun('x').catch((e: unknown) => e)) as WorkflowError;
        // (b) prints the code and the failure's errno (the per-run artifact contract's L4 shape).
        expect({
          code: err.code,
          errno: (err.details['failures'] as Array<{ code: string }>)[0]?.code,
        }).toEqual({ code: 'ENGINE_ARTIFACT_DELETE_FAILED', errno: 'EACCES' });
      },
    );
  });

  describe('a copy of a run whose own file reads is not a damaged run (F5)', () => {
    const seedCopy = async () => {
      await writeFile(join(d, 'r1.json'), JSON.stringify(full('r1')));
      await writeFile(join(d, 'r1.bak.json'), JSON.stringify(full('r1')));
    };

    it('listWithDiagnostics puts it in copies; list() and reconcileKeys() read past it', async () => {
      await seedCopy();
      const listing = await st.listWithDiagnostics();
      const listed = await st.list().then(
        (rs) => rs.map((r) => r.id),
        (e: unknown) => (e as WorkflowError).code,
      );
      const reconciled = await st.reconcileKeys().then(
        () => 'ran',
        (e: unknown) => (e as WorkflowError).code,
      );
      // (a) red when a copy is counted as damaged, or stops list() or reconcile; (b) prints them.
      expect({
        copies: listing.copies.map((c) => c.file),
        unreadable: listing.unreadable.map((u) => u.file),
        listed,
        reconciled,
      }).toEqual({ copies: ['r1.bak.json'], unreadable: [], listed: ['r1'], reconciled: 'ran' });
    });

    it.each([
      ['absent', async (): Promise<void> => undefined],
      ['damaged', async (): Promise<void> => writeFile(join(d, 'r1.json'), '{not json')],
    ] as const)(
      'per-conjunct: a file holding run r1 whose own file is %s is still counted and refused',
      async (_label, held) => {
        await writeFile(join(d, 'r1.bak.json'), JSON.stringify(full('r1')));
        await held();
        const listing = await st.listWithDiagnostics();
        const refused = await st.list().then(
          () => 'listed',
          (e: unknown) => unreadableFactsOf(e)?.path ?? (e as WorkflowError).code,
        );
        // (a) red when a copy whose held run does not read is treated as a copy; (b) prints the
        //     listing's files and the file list() refused (r1.bak.json sorts before r1.json).
        expect({
          copies: listing.copies.map((c) => c.file),
          copyCounted: listing.unreadable.some((u) => u.file === 'r1.bak.json'),
          refused,
        }).toEqual({ copies: [], copyCounted: true, refused: join(d, 'r1.bak.json') });
      },
    );
  });

  describe('save() (C6): a key is never repointed away from an owner whose file is damaged', () => {
    it('the import refuses, naming the owner’s file; the pointer still names the owner', async () => {
      const owner = await st.create({
        workflowId: 'wa',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k-import',
      });
      await writeFile(join(d, `${owner.run.id}.json`), '{not json');
      const imported = full('imp', { idempotency_key: 'k-import' } as never);
      const err = await st.save(imported).then(
        () => undefined,
        (e: unknown) => e,
      );
      const again = await st
        .create({ workflowId: 'wa', workflowVersion: 1, params: {}, idempotencyKey: 'k-import' })
        .then(
          () => 'created or reused',
          (e: unknown) => unreadableFactsOf(e)?.path,
        );
      // (a) red when the owner's read failure is taken for a missing owner and the key repointed to
      //     the import; (b) prints the refusal's code and class, and what the key's pointer reads.
      expect({
        code: (err as WorkflowError | undefined)?.code,
        class: unreadableFactsOf(err)?.class,
        pointerReads: again,
      }).toEqual({
        code: 'RESOURCE_FORMAT_INVALID',
        class: 'parse',
        pointerReads: join(d, `${owner.run.id}.json`),
      });
    });
  });
});
