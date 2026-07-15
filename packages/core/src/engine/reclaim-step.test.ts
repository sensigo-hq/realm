// Tests for reclaimStep — deliberate per-claim wedge recovery (issue #101, Phase 1).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reclaimStep } from './reclaim-step.js';
import { findEligibleSteps } from './eligibility.js';
import { classifyInProgressClaims } from './claim-liveness.js';
import { executeStep } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { InMemoryTraceBufferStore } from '../store/trace-buffer-store.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunStore } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { TraceBufferStore } from '../store/trace-buffer-store.js';
import type { StepHandler } from '../extensions/step-handler.js';

const autoWf: WorkflowDefinition = {
  id: 'reclaim-wf',
  name: 'Reclaim WF',
  version: 1,
  steps: {
    work: { description: 'w', execution: 'auto', depends_on: [], handler: 'h_work' },
    after: { description: 'a', execution: 'auto', depends_on: ['work'], handler: 'h_after' },
  },
};

const pastIso = () => new Date(Date.now() - 60_000).toISOString();

describe('reclaimStep — guards and action (JsonFileStore)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-reclaim-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes a stale claim → the step is eligible again; appends audit evidence; not left settled', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    const claimed = await store.claimStep(run.id, 'work', autoWf);
    expect(claimed.in_progress_steps).toContain('work');
    expect(findEligibleSteps(autoWf, claimed)).not.toContain('work'); // in_progress → excluded
    // Force staleness (claimStep set a future deadline; overwrite to the past).
    await store.update({ ...claimed, claims: { work: { deadline: pastIso() } } });

    const result = await reclaimStep(store, run.id, 'work');
    expect(result.outcome).toBe('reclaimed');
    expect(result.priorState).toBe('claim_stale');

    const after = await store.get(run.id);
    expect(after.in_progress_steps).not.toContain('work');
    expect(after.claims?.['work']).toBeUndefined();
    expect(findEligibleSteps(autoWf, after)).toContain('work'); // eligible again
    // Not left looking settled.
    expect(after.completed_steps).not.toContain('work');
    expect(after.failed_steps).not.toContain('work');
    expect(after.skipped_steps).not.toContain('work');
    // Audit evidence entry recorded.
    const audit = after.evidence.find((e) => e.step_id === 'work');
    expect(audit?.output_summary['reclaimed']).toBe(true);
    expect(audit?.output_summary['reason']).toBe('manual reclaim');
  });

  it('reclaims an unknown-age (deadline: null) claim too', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    const claimed = await store.claimStep(run.id, 'work', autoWf);
    await store.update({ ...claimed, claims: { work: { deadline: null } } });
    const result = await reclaimStep(store, run.id, 'work');
    expect(result.outcome).toBe('reclaimed');
    expect(result.priorState).toBe('claim_unknown_age');
  });

  it('refuses a terminal run', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run,
      in_progress_steps: ['work'],
      claims: { work: { deadline: null } },
      completed_steps: ['other'],
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
    });
    await expect(reclaimStep(store, run.id, 'work')).rejects.toThrow(/terminal/i);
  });

  it('refuses the pending_gate step but ALLOWS a non-gated in_progress sibling', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run,
      in_progress_steps: ['gated', 'sibling'],
      claims: { gated: { deadline: null }, sibling: { deadline: pastIso() } },
      pending_gate: {
        gate_id: 'g1',
        step_name: 'gated',
        choices: ['approve'],
        opened_at: new Date().toISOString(),
        preview: {},
      },
    });
    await expect(reclaimStep(store, run.id, 'gated')).rejects.toThrow(/gate/i);
    const res = await reclaimStep(store, run.id, 'sibling');
    expect(res.outcome).toBe('reclaimed');
    const after = await store.get(run.id);
    expect(after.in_progress_steps).toContain('gated'); // gated claim untouched
    expect(after.in_progress_steps).not.toContain('sibling');
  });

  it('is idempotent on a step that is not in_progress (already settled/reclaimed)', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    const result = await reclaimStep(store, run.id, 'work');
    expect(result.outcome).toBe('already_settled');
    const after = await store.get(run.id);
    expect(after.version).toBe(run.version); // no mutation
  });

  it('loud-fails when the store does not persist claims', async () => {
    const fake = {
      persistsClaims: false,
      get: async () => {
        throw new Error('should not be called');
      },
    } as unknown as RunStore;
    await expect(reclaimStep(fake, 'r1', 'work')).rejects.toThrow(/does not persist claims/i);
  });
});

// ---------------------------------------------------------------------------
// CAS re-evaluation on STATE_SNAPSHOT_MISMATCH (reviewer Sig-6) — first-class tests.
// A scripted store: get() returns `initial` first, then `reloaded`; update() throws a mismatch on
// the scripted call number, else records + succeeds.
// ---------------------------------------------------------------------------

function makeRun(over: Partial<RunRecord>): RunRecord {
  return {
    id: 'r1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 5,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    ...over,
  };
}

function scriptedStore(
  records: RunRecord[],
  mismatchOnUpdateCall: number[],
): { store: RunStore; updateCalls: RunRecord[] } {
  let getIdx = 0;
  let updateCall = 0;
  const updateCalls: RunRecord[] = [];
  const store = {
    persistsClaims: true,
    get: async () => records[Math.min(getIdx++, records.length - 1)]!,
    update: async (rec: RunRecord) => {
      updateCall += 1;
      if (mismatchOnUpdateCall.includes(updateCall)) {
        throw new WorkflowError('Version conflict', {
          code: 'STATE_SNAPSHOT_MISMATCH',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: true,
        });
      }
      updateCalls.push(rec);
      return { ...rec, version: rec.version + 1 };
    },
  } as unknown as RunStore;
  return { store, updateCalls };
}

describe('reclaimStep — CAS mismatch re-evaluation (Sig-6)', () => {
  const staleClaim = { deadline: pastIso() };
  const freshClaim = { deadline: new Date(Date.now() + 3_600_000).toISOString() };

  it('a racing live driver COMPLETED the step → idempotent success, no re-remove', async () => {
    const initial = makeRun({ in_progress_steps: ['work'], claims: { work: staleClaim } });
    const reloaded = makeRun({ completed_steps: ['work'], in_progress_steps: [], version: 6 });
    const { store, updateCalls } = scriptedStore([initial, reloaded], [1]);

    const result = await reclaimStep(store, 'r1', 'work');
    expect(result.outcome).toBe('already_settled');
    expect(updateCalls).toHaveLength(0); // never re-applied the removal
  });

  it('a racing live driver RE-CLAIMED the step fresh (healthy) → taken_over, NOT stomped', async () => {
    const initial = makeRun({ in_progress_steps: ['work'], claims: { work: staleClaim } });
    // Reclaimed then re-claimed fresh by a new driver: still in_progress, now a FUTURE deadline.
    const reloaded = makeRun({
      in_progress_steps: ['work'],
      claims: { work: freshClaim },
      version: 7,
    });
    const { store, updateCalls } = scriptedStore([initial, reloaded], [1]);

    const result = await reclaimStep(store, 'r1', 'work');
    expect(result.outcome).toBe('taken_over');
    expect(updateCalls).toHaveLength(0); // the live re-claim was NOT double-removed
  });

  it('still a stale wedge after the concurrent write → re-apply ONCE on the fresh record', async () => {
    const initial = makeRun({
      in_progress_steps: ['work'],
      claims: { work: staleClaim },
      version: 5,
    });
    const reloaded = makeRun({
      in_progress_steps: ['work', 'sibling'], // some unrelated concurrent write; work still stale
      claims: { work: staleClaim, sibling: { deadline: null } },
      version: 6,
    });
    const { store, updateCalls } = scriptedStore([initial, reloaded], [1]);

    const result = await reclaimStep(store, 'r1', 'work');
    expect(result.outcome).toBe('reclaimed');
    expect(updateCalls).toHaveLength(1); // re-applied once on the reloaded record
    expect(updateCalls[0]!.in_progress_steps).not.toContain('work');
    expect(updateCalls[0]!.in_progress_steps).toContain('sibling'); // sibling preserved
  });
});

// ---------------------------------------------------------------------------
// THE HEADLINE — finalizer-wedge recovery (proves the #101 ↔ finalizer link closes).
// ---------------------------------------------------------------------------

describe('reclaimStep — finalizer-wedge recovery (headline)', () => {
  let store: JsonFileStore;
  let dir: string;

  const finalizerWf: WorkflowDefinition = {
    id: 'wedge-fin-wf',
    name: 'Wedge Finalizer WF',
    version: 1,
    steps: {
      work: { description: 'domain', execution: 'auto', depends_on: [], handler: 'h_work' },
      cleanup: {
        description: 'finally',
        execution: 'finalizer',
        on_outcome: 'always',
        handler: 'h_cleanup',
      },
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-reclaim-fin-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a run crashed mid-buildFinalizedSeal (domain pinned, claim_unknown_age) recovers and fires finalizers', async () => {
    const { run } = await store.create({
      workflowId: 'wedge-fin-wf',
      workflowVersion: 1,
      params: {},
    });

    // Simulate the crash: the domain step is claimed (finalizer-bearing wf → deadline null) but
    // never settled — the buildFinalizedSeal crash-wedge. It is a claim_unknown_age wedge.
    const claimed = await store.claimStep(run.id, 'work', finalizerWf);
    expect(claimed.in_progress_steps).toContain('work');
    expect(classifyInProgressClaims(claimed)[0]).toMatchObject({
      step: 'work',
      state: 'claim_unknown_age',
    });
    // The run is non-terminal and wedged: finalizers have NOT run.
    expect(claimed.terminal_state).toBe(false);

    // Recover: reclaim the domain step → it becomes eligible again.
    const result = await reclaimStep(store, run.id, 'work');
    expect(result.outcome).toBe('reclaimed');
    expect(findEligibleSteps(finalizerWf, await store.get(run.id))).toContain('work');

    // Re-drive the domain step → it re-reaches the seal → the finalizer runs.
    const cleanupRan = vi.fn();
    const registry = new ExtensionRegistry();
    const hWork: StepHandler = { id: 'h_work', execute: vi.fn(async () => ({ data: {} })) };
    const hCleanup: StepHandler = {
      id: 'h_cleanup',
      execute: vi.fn(async () => {
        cleanupRan();
        return { data: { cleaned: true } };
      }),
    };
    registry.register('handler', 'h_work', hWork);
    registry.register('handler', 'h_cleanup', hCleanup);

    await executeStep(store, finalizerWf, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => ({}),
      registry,
    });

    const final = await store.get(run.id);
    expect(final.run_phase).toBe('completed');
    expect(final.terminal_state).toBe(true);
    expect(cleanupRan).toHaveBeenCalledTimes(1);
    expect(final.completed_steps).toContain('cleanup'); // the finalizer ran on recovery
  });
});

// ---------------------------------------------------------------------------
// Clearing the stale trace buffer on reclaim (issue #198).
// ---------------------------------------------------------------------------

const agentReclaimWf: WorkflowDefinition = {
  id: 'reclaim-agent-wf',
  name: 'Reclaim Agent WF',
  version: 1,
  steps: {
    'step-agent': { description: 'agent step', execution: 'agent', depends_on: [] },
  },
};

describe('reclaimStep — clearing the stale trace buffer (issue #198)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-reclaim-wal-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("clears the reclaimed step's WAL — a subsequent claim + executeStep adopts NO stale lines (no buffered_lines_adopted caveat)", async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const claimed = await store.claimStep(run.id, 'step-agent', agentReclaimWf);
    await store.update({ ...claimed, claims: { 'step-agent': { deadline: pastIso() } } });

    const traceBufferStore = new InMemoryTraceBufferStore();
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'dead_attempt_line' }]);
    expect(await traceBufferStore.read(run.id, 'step-agent')).toHaveLength(1);

    const result = await reclaimStep(store, run.id, 'step-agent', { traceBufferStore });
    expect(result.outcome).toBe('reclaimed');

    // The WAL is gone — cleared by the reclaim itself, not left for the next attempt to inherit.
    expect(await traceBufferStore.read(run.id, 'step-agent')).toHaveLength(0);

    // A subsequent claim + executeStep starts from a clean buffer: no stale lines adopted, so
    // Fix 3's (#185) caveat never fires — this execution's trace is entirely its own.
    const envelope = await executeStep(store, agentReclaimWf, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
      trace: [{ event: 'fresh_conclusion' }],
    });
    expect(envelope.status).toBe('ok');
    const snap = envelope.evidence[0];
    expect(snap?.trace).toEqual([{ seq: 1, event: 'fresh_conclusion' }]);
    expect(snap?.trace_summary?.buffered_lines_adopted).toBeUndefined();
  });

  it('clearStaleWal warns loudly (never rethrows) on a real I/O failure — the reclaim itself still succeeds', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    const claimed = await store.claimStep(run.id, 'work', autoWf);
    await store.update({ ...claimed, claims: { work: { deadline: pastIso() } } });

    const failingTraceBufferStore: TraceBufferStore = {
      append: async () => {
        throw new Error('should not be called');
      },
      read: async () => [],
      delete: async () => {
        throw new Error('simulated disk failure');
      },
      deleteAllForRun: async () => {},
      readAllForRun: async () => ({}),
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await reclaimStep(store, run.id, 'work', {
        traceBufferStore: failingTraceBufferStore,
      });
      // Not blocked — the reclaim itself succeeded despite the WAL clear failing.
      expect(result.outcome).toBe('reclaimed');
      const after = await store.get(run.id);
      expect(after.in_progress_steps).not.toContain('work');

      // But it was NOT silently swallowed (issue #183 contract) — a warning was emitted naming
      // the run, the step, and the underlying error.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0]!;
      expect(String(message)).toContain(run.id);
      expect(String(message)).toContain('work');
      expect(String(message)).toContain('simulated disk failure');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reclaimStep without a traceBufferStore is unchanged — the undefined early-return still holds (no regression for any caller that omits it)', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    const claimed = await store.claimStep(run.id, 'work', autoWf);
    await store.update({ ...claimed, claims: { work: { deadline: pastIso() } } });

    // No options at all — mirrors every pre-#198 caller.
    const result = await reclaimStep(store, run.id, 'work');
    expect(result.outcome).toBe('reclaimed');
  });
});
