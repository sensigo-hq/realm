// Deterministic tests for execution-loop.ts's attributed-adoption call sites (issue #197 PR-2,
// design record `plans/issue-197-design.md`). Mirrors execution-loop-fenced-trio-adoption.test.ts's
// style: each test targets exactly one deliverable — the activation-gate floor law, the
// enforce-gate/adoption congruence, the three-way honest split, and the settle-time seal decision
// table (ordering, each outcome branch, detection-counts-only attestation).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import {
  InMemoryTraceBufferStore,
  SEALED_ARTIFACTS_LIMIT_PER_STEP,
} from '../store/trace-buffer-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { TraceBufferStore } from '../store/trace-buffer-store.js';

const agentDef: WorkflowDefinition = {
  id: 'attributed-adoption-agent-wf',
  name: 'Attributed Adoption Agent WF',
  version: 1,
  steps: {
    'step-agent': { description: 'Agent step', execution: 'agent', depends_on: [] },
  },
};

const congruenceDef: WorkflowDefinition = {
  id: 'attributed-adoption-congruence-wf',
  name: 'Attributed Adoption Congruence WF',
  version: 1,
  steps: {
    'step-agent': {
      description: 'Agent step with an enforce-mode trace_schema',
      execution: 'agent',
      depends_on: [],
      trace_schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: { event: { const: 'expected_event' } },
          required: ['event'],
        },
      },
      trace_validation_mode: 'enforce',
    },
  },
};

/**
 * A trio-only `TraceBufferStore` wrapper (issue #197 PR-2): forwards every call to a REAL
 * `InMemoryTraceBufferStore` (so the fenced trio genuinely works), but exposes NEITHER
 * `traceCapabilities` NOR `sealFenced`/`listSealedForRun` — `storeDeclaresSeal`/
 * `storeDeclaresNonceCarriage` both correctly evaluate `false` against this shape, exactly
 * modeling "a store declaring the fenced trio alone" (the shipped realm-cloud Postgres state,
 * design §3) for the floor-law test below.
 */
function trioOnlyStore(): { store: TraceBufferStore; inner: InMemoryTraceBufferStore } {
  const inner = new InMemoryTraceBufferStore();
  const store: TraceBufferStore = {
    append: (runId, stepId, entries, options) => inner.append(runId, stepId, entries, options),
    read: (runId, stepId) => inner.read(runId, stepId),
    delete: (runId, stepId) => inner.delete(runId, stepId),
    deleteAllForRun: (runId, dirEntries) => inner.deleteAllForRun(runId, dirEntries),
    readAllForRun: (runId) => inner.readAllForRun(runId),
    appendFenced: (runId, stepId, entries, guard, options) =>
      inner.appendFenced(runId, stepId, entries, guard, options),
    deleteFenced: (runId, stepId, guard) => inner.deleteFenced(runId, stepId, guard),
    deleteAllForRunFenced: (runId, guard, dirEntries) =>
      inner.deleteAllForRunFenced(runId, guard, dirEntries),
  };
  return { store, inner };
}

describe('execution-loop.ts — activation-gate floor law (issue #197 PR-2, design §3)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-adoption-floor-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a trio-only store (no seal, no carriage) + a nonced claimant ⇒ adopt-all floor + the missing-leg warning fires', async () => {
    const { run } = await store.create({
      workflowId: 'attributed-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const { store: traceBufferStore } = trioOnlyStore();
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'a' }, { event: 'b' }]);

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
      writerNonce: 'my-nonce',
    });

    expect(envelope.status).toBe('ok');
    // Floor: everything adopted under ⊥ (the store can't carry the nonce at all).
    const summary = envelope.evidence[0]?.trace_summary;
    expect(summary?.buffered_lines_adopted).toBe(2);
    expect(summary?.attributed_lines_adopted).toBeUndefined();
    expect(summary?.foreign_lines_preserved).toBeUndefined();
    // The missing-leg advisory fires exactly once.
    expect(
      envelope.warnings.some(
        (w) => w.includes('writer_nonce ignored') && w.includes('writer_nonce_carriage'),
      ),
    ).toBe(true);
    // Envelope adoption counts are ABSENT entirely — "bare-floor store", not merely zeroed.
    expect(envelope.adopted_own).toBeUndefined();
    expect(envelope.adopted_anonymous).toBeUndefined();
    expect(envelope.preserved_foreign).toBeUndefined();
  });

  it('the full store (seal + carriage) + a nonced claimant ⇒ selective adoption (no missing-leg warning, envelope counts present)', async () => {
    const { run } = await store.create({
      workflowId: 'attributed-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'own' }], {
      writerNonce: 'my-nonce',
    });
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'foreign' }], {
      writerNonce: 'other-writer',
    });

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
      writerNonce: 'my-nonce',
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.warnings.some((w) => w.includes('writer_nonce ignored'))).toBe(false);
    expect(envelope.adopted_own).toBe(1);
    expect(envelope.adopted_anonymous).toBe(0);
    expect(envelope.preserved_foreign).toBe(1);
  });
});

describe('execution-loop.ts — ADOPTION_CONGRUENCE (issue #197 PR-2, design §2)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-adoption-congruence-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a foreign-nonce-only WAL under trace_schema enforce mode does NOT gate a nonced claimant', async () => {
    const { run } = await store.create({
      workflowId: 'attributed-adoption-congruence-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    // A foreign line that would FAIL the schema if it were validated (event !== 'expected_event').
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'other_writers_event' }], {
      writerNonce: 'other-writer',
    });

    const envelope = await executeStep(store, congruenceDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
      writerNonce: 'my-nonce',
      // The claimant's OWN conclusion satisfies the schema — congruence means only THIS is
      // validated pre-claim, not the foreign line above.
      trace: [{ event: 'expected_event' }],
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.error_code).toBeUndefined();
    // The foreign line was preserved, not adopted — confirms it genuinely existed and was
    // genuinely excluded, not merely absent from the test setup.
    expect(envelope.preserved_foreign).toBe(1);
  });
});

describe('execution-loop.ts — the three-way honest split (issue #197 PR-2, design §2/§6)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-adoption-threeway-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('⊥ claimant + bare lines ⇒ buffered_lines_adopted, existing caveat, numerically identical to today', async () => {
    const { run } = await store.create({
      workflowId: 'attributed-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'a' }, { event: 'b' }]);

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
      // no writerNonce — the ⊥ claimant
    });

    const summary = envelope.evidence[0]?.trace_summary;
    expect(summary?.buffered_lines_adopted).toBe(2);
    expect(summary?.attributed_lines_adopted).toBeUndefined();
    expect(summary?.foreign_lines_preserved).toBeUndefined();
    expect(envelope.adopted_anonymous).toBe(2);
    expect(envelope.adopted_own).toBe(0);
    expect(envelope.preserved_foreign).toBe(0);
  });

  it('nonced claimant + own lines ⇒ attributed_lines_adopted, NO caveat', async () => {
    const { run } = await store.create({
      workflowId: 'attributed-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'a' }, { event: 'b' }], {
      writerNonce: 'my-nonce',
    });

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
      writerNonce: 'my-nonce',
    });

    const summary = envelope.evidence[0]?.trace_summary;
    expect(summary?.attributed_lines_adopted).toBe(2);
    expect(summary?.buffered_lines_adopted).toBeUndefined();
    expect(summary?.foreign_lines_preserved).toBeUndefined();
    expect(envelope.adopted_own).toBe(2);
    expect(envelope.adopted_anonymous).toBe(0);
    expect(envelope.preserved_foreign).toBe(0);
  });

  it('mixed: own + bare + foreign ⇒ all three counts populated, pointer warning fires, foreign nonce VALUE never appears anywhere', async () => {
    const { run } = await store.create({
      workflowId: 'attributed-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'own' }], {
      writerNonce: 'my-nonce',
    });
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'bare' }]);
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'foreign' }], {
      writerNonce: 'SECRET-OTHER-NONCE',
    });

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
      writerNonce: 'my-nonce',
    });

    const summary = envelope.evidence[0]?.trace_summary;
    expect(summary?.attributed_lines_adopted).toBe(1);
    expect(summary?.foreign_lines_preserved).toBe(2); // bare AND the foreign-nonce line: both foreign to a nonced claimant
    expect(envelope.adopted_own).toBe(1);
    expect(envelope.adopted_anonymous).toBe(0);
    expect(envelope.preserved_foreign).toBe(2);
    expect(
      envelope.warnings.some(
        (w) => w.includes('preserved, not adopted') && w.includes('realm run export'),
      ),
    ).toBe(true);
    // Non-disclosure pin: the foreign nonce VALUE never appears anywhere in the envelope.
    expect(JSON.stringify(envelope)).not.toContain('SECRET-OTHER-NONCE');
  });
});

describe('execution-loop.ts — settle-time seal decision (issue #197 PR-2, deliverable 1f)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-adoption-seal-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sealed:true ⇒ the live WAL is retired to a sealed artifact (not deleted), warns "preserved (sealed)", and the seal happens AFTER store.update (ordering)', async () => {
    const { run } = await store.create({
      workflowId: 'attributed-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'foreign' }], {
      writerNonce: 'other-writer',
    });

    const calls: string[] = [];
    const originalUpdate = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementation(async (rec) => {
      calls.push('update');
      return originalUpdate(rec);
    });
    const originalSeal = traceBufferStore.sealFenced.bind(traceBufferStore);
    vi.spyOn(traceBufferStore, 'sealFenced').mockImplementation(async (...args) => {
      calls.push('sealFenced');
      return originalSeal(...args);
    });

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
      // ⊥ claimant sees the foreign-nonced line as foreign — preserved, not adopted.
    });

    expect(envelope.status).toBe('ok');
    expect(calls).toEqual(['update', 'sealFenced']); // seal strictly AFTER the settling update
    expect(
      envelope.warnings.some(
        (w) => w.includes('foreign line(s) preserved (sealed)') && w.includes('realm run export'),
      ),
    ).toBe(true);
    // The live WAL is gone, but the content is PRESERVED (sealed), not destroyed.
    expect(await traceBufferStore.read(run.id, 'step-agent')).toHaveLength(0);
    const sealedArtifacts = await traceBufferStore.listSealedForRun(run.id);
    expect(sealedArtifacts).toHaveLength(1);

    // Detection-counts-only attestation (post-R3 B1): the PERSISTED run record's trace_summary
    // carries counts only — never the seal OUTCOME. The seal outcome exists only in this
    // envelope's warnings (already asserted above), never written back to the run record.
    const persisted = await store.get(run.id);
    const summaryJson = JSON.stringify(persisted.evidence[0]?.trace_summary ?? {});
    expect(summaryJson).not.toMatch(/sealed/i);
    expect(persisted.evidence[0]?.trace_summary?.foreign_lines_preserved).toBe(1);
  });

  it('capped ⇒ falls back to the existing delete() + a loud "cap reached" warning (no silent eviction of an already-sealed artifact)', async () => {
    const { run } = await store.create({
      workflowId: 'attributed-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    // Fill the per-key seal budget completely BEFORE this step ever settles.
    for (let i = 0; i < SEALED_ARTIFACTS_LIMIT_PER_STEP; i++) {
      await traceBufferStore.append(run.id, 'step-agent', [{ event: `filler-${i}` }]);
      const result = await traceBufferStore.sealFenced(run.id, 'step-agent', async () => {});
      expect(result).toEqual({ sealed: true });
    }
    // Now the step's OWN settle-time seal attempt will find the budget exhausted.
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'foreign' }], {
      writerNonce: 'other-writer',
    });

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
    });

    expect(envelope.status).toBe('ok');
    expect(
      envelope.warnings.some(
        (w) => w.includes('preservation cap reached') && w.includes('destroyed, not preserved'),
      ),
    ).toBe(true);
    // The live WAL was DESTROYED (fell back to delete), not left behind — and the sealed count
    // stayed at exactly the cap (no silent eviction to squeeze in a 9th).
    expect(await traceBufferStore.read(run.id, 'step-agent')).toHaveLength(0);
    expect(await traceBufferStore.listSealedForRun(run.id)).toHaveLength(
      SEALED_ARTIFACTS_LIMIT_PER_STEP,
    );
  });

  it('a THROW from sealFenced ⇒ warn + SKIP the delete (residue-not-loss) — the live WAL survives intact', async () => {
    const { run } = await store.create({
      workflowId: 'attributed-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'foreign' }], {
      writerNonce: 'other-writer',
    });
    vi.spyOn(traceBufferStore, 'sealFenced').mockRejectedValue(
      new Error('simulated lock-contention seal failure'),
    );
    const deleteSpy = vi.spyOn(traceBufferStore, 'delete');

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
    });

    expect(envelope.status).toBe('ok'); // the STEP still completed
    expect(
      envelope.warnings.some((w) =>
        w.includes('Failed to seal trace buffer after step completion'),
      ),
    ).toBe(true);
    expect(deleteSpy).not.toHaveBeenCalled(); // never fell back to delete — residue-not-loss
    expect(await traceBufferStore.read(run.id, 'step-agent')).toHaveLength(1); // WAL intact
  });

  it('absent ⇒ nothing happens (no delete, no warning) — the live WAL vanished before the seal attempt', async () => {
    const { run } = await store.create({
      workflowId: 'attributed-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'foreign' }], {
      writerNonce: 'other-writer',
    });
    vi.spyOn(traceBufferStore, 'sealFenced').mockResolvedValue({ sealed: false, reason: 'absent' });
    const deleteSpy = vi.spyOn(traceBufferStore, 'delete');

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
    });

    expect(envelope.status).toBe('ok');
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(
      envelope.warnings.some((w) => w.includes('preserved (sealed)') || w.includes('cap reached')),
    ).toBe(false);
  });

  it('preserved_foreign === 0 ⇒ plain delete() exactly as today (zero behavior change) — sealFenced is never even called', async () => {
    const { run } = await store.create({
      workflowId: 'attributed-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'a' }]); // bare only — all-bare traffic
    const sealSpy = vi.spyOn(traceBufferStore, 'sealFenced');
    const deleteSpy = vi.spyOn(traceBufferStore, 'delete');

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
    });

    expect(envelope.status).toBe('ok');
    expect(sealSpy).not.toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });
});
