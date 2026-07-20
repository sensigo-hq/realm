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

  it('is idempotent on a step that was never claimed (issue #221: this IS the never-claimed case — no active claim, not settled, no positive evidence of any prior touch)', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    const result = await reclaimStep(store, run.id, 'work');
    expect(result.outcome).toBe('no_active_claim');
    expect(result.detail).toBeUndefined();
    const after = await store.get(run.id);
    expect(after.version).toBe(run.version); // no mutation
  });

  it('a step already in completed_steps ⇒ already_settled (issue #221, direct path — genuinely settled)', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    await store.update({ ...run, completed_steps: ['work'] });
    const result = await reclaimStep(store, run.id, 'work');
    expect(result.outcome).toBe('already_settled');
    expect(result.detail).toBeUndefined();
  });

  // issue #221 correction — novel probe N2: the other two settle-set disjuncts (failed_steps,
  // skipped_steps) were never independently witnessed — only completed_steps was. Deleting either
  // disjunct survives the whole suite otherwise, and the consequence is a real honesty regression:
  // the CLI's no_active_claim message ("it is not settled") would be asserted about a step that
  // genuinely IS settled (failed or skipped).
  it('a step already in failed_steps ⇒ already_settled (issue #221, settle-arm witness)', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    await store.update({ ...run, failed_steps: ['work'] });
    const result = await reclaimStep(store, run.id, 'work');
    expect(result.outcome).toBe('already_settled');
    expect(result.detail).toBeUndefined();
  });

  it('a step already in skipped_steps ⇒ already_settled (issue #221, settle-arm witness)', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    await store.update({ ...run, skipped_steps: ['work'] });
    const result = await reclaimStep(store, run.id, 'work');
    expect(result.outcome).toBe('already_settled');
    expect(result.detail).toBeUndefined();
  });

  it('a step reclaimed once, then reclaimed again ⇒ no_active_claim + detail previously_reclaimed (issue #221 — exercises the RE-reclaim flow)', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    const claimed = await store.claimStep(run.id, 'work', autoWf);
    await store.update({ ...claimed, claims: { work: { deadline: pastIso() } } });

    const first = await reclaimStep(store, run.id, 'work');
    expect(first.outcome).toBe('reclaimed');

    // Reclaimed once, never re-claimed since — a second reclaim call finds no active claim, but
    // the audit evidence from the FIRST reclaim is positive proof this step WAS touched.
    const second = await reclaimStep(store, run.id, 'work');
    expect(second.outcome).toBe('no_active_claim');
    expect(second.detail).toBe('previously_reclaimed');
  });

  it('a capability-blocked step ⇒ no_active_claim + detail capability_blocked (issue #221)', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run,
      capability_blocks: {
        work: {
          requirement: { kind: 'handler', name: 'h_work' },
          code: 'ENGINE_HANDLER_NOT_REGISTERED',
          at: new Date().toISOString(),
        },
      },
    });
    const result = await reclaimStep(store, run.id, 'work');
    expect(result.outcome).toBe('no_active_claim');
    expect(result.detail).toBe('capability_blocked');
  });

  // issue #221 correction: the both-markers precedence was an undisclosed judgment call in the
  // original round (classifyNoActiveClaim checks capability_blocks BEFORE reclaim-audit evidence)
  // — now explicitly pinned. Direct-guard path: both a reclaim-audit evidence entry (from a prior
  // genuine reclaim) AND a capability_blocks marker are present on the SAME step simultaneously
  // (a plausible real sequence: reclaimed once, re-driven, then hit a capability block) ⇒
  // capability_blocked wins as the more specific, more-actionable-now signal.
  it('both markers present (reclaim-audit evidence AND capability_blocks) ⇒ no_active_claim + detail capability_blocked (capability wins — MA-ratified precedence)', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-wf',
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run,
      evidence: [
        {
          step_id: 'work',
          started_at: pastIso(),
          completed_at: pastIso(),
          duration_ms: 0,
          input_summary: {},
          output_summary: { reclaimed: true, reason: 'manual reclaim' },
          status: 'success',
          evidence_hash: 'x',
        },
      ],
      capability_blocks: {
        work: {
          requirement: { kind: 'handler', name: 'h_work' },
          code: 'ENGINE_HANDLER_NOT_REGISTERED',
          at: new Date().toISOString(),
        },
      },
    });
    const result = await reclaimStep(store, run.id, 'work');
    expect(result.outcome).toBe('no_active_claim');
    expect(result.detail).toBe('capability_blocked');
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

  it('CAS-retry path (issue #221): reloaded lacks the step but carries reclaim-audit evidence ⇒ no_active_claim + previously_reclaimed (discriminated against `reloaded`, never `run`)', async () => {
    const initial = makeRun({ in_progress_steps: ['work'], claims: { work: staleClaim } });
    const reloaded = makeRun({
      in_progress_steps: [], // a concurrent reclaim already removed the claim
      evidence: [
        {
          step_id: 'work',
          started_at: pastIso(),
          completed_at: pastIso(),
          duration_ms: 0,
          input_summary: {},
          output_summary: { reclaimed: true, reason: 'manual reclaim' },
          status: 'success',
          evidence_hash: 'x',
        },
      ],
      version: 6,
    });
    const { store, updateCalls } = scriptedStore([initial, reloaded], [1]);

    const result = await reclaimStep(store, 'r1', 'work');
    expect(result.outcome).toBe('no_active_claim');
    expect(result.detail).toBe('previously_reclaimed');
    expect(updateCalls).toHaveLength(0); // idempotent — no re-remove
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

// ---------------------------------------------------------------------------
// Fenced pre-update clear (issue #207 PR-2): a declaring store's WAL clear moves BEFORE the
// un-claiming update, version-fenced against the decision read that made the reclaim call.
// ---------------------------------------------------------------------------

describe('reclaimStep — fenced pre-update clear (issue #207 PR-2)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-reclaim-fenced-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('call-order recorder: sealFenced fires BEFORE the update on BOTH the primary and the CAS-retry path (forced first-update STATE_SNAPSHOT_MISMATCH), and warns with the seal outcome (issue #197 PR-2: InMemoryTraceBufferStore now declares seal, so reclaim PRESERVES rather than destroys — see the sibling non-seal-fallback test below for the deleteFenced-drain path this test exercised before #197 PR-1 shipped seal capability)', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const claimed = await store.claimStep(run.id, 'step-agent', agentReclaimWf);
    await store.update({ ...claimed, claims: { 'step-agent': { deadline: pastIso() } } });

    const traceBufferStore = new InMemoryTraceBufferStore();
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'dead_attempt_line' }]);

    const calls: string[] = [];
    const originalUpdate = store.update.bind(store);
    let updateCallNum = 0;
    vi.spyOn(store, 'update').mockImplementation(async (rec) => {
      updateCallNum += 1;
      if (updateCallNum === 1) {
        calls.push('update#1(forced-reject)');
        throw new WorkflowError('Version conflict — simulated', {
          code: 'STATE_SNAPSHOT_MISMATCH',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: true,
        });
      }
      calls.push(`update#${updateCallNum}`);
      return originalUpdate(rec);
    });
    const originalSealFenced = traceBufferStore.sealFenced!.bind(traceBufferStore);
    vi.spyOn(traceBufferStore, 'sealFenced').mockImplementation(async (...args) => {
      calls.push('sealFenced');
      return originalSealFenced(...args);
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await reclaimStep(store, run.id, 'step-agent', { traceBufferStore });
      expect(result.outcome).toBe('reclaimed');
      // Strict seal-before-update ordering, independently on EACH attempt.
      expect(calls).toEqual(['sealFenced', 'update#1(forced-reject)', 'sealFenced', 'update#2']);
      // The live WAL is gone — sealed on the FIRST call (before the forced-reject update); the
      // second call's own attempt finds the live WAL already absent (nothing left to re-seal).
      expect(await traceBufferStore.read(run.id, 'step-agent')).toHaveLength(0);
      const sealedArtifacts = await traceBufferStore.listSealedForRun!(run.id);
      expect(sealedArtifacts).toHaveLength(1);
      expect(sealedArtifacts[0]?.lines.flatMap((l) => l.entries.map((e) => e.event))).toEqual([
        'dead_attempt_line',
      ]);
      // Seal-outcome warn (issue #197 PR-2: NO fabricated entry count — contents unparsed).
      expect(
        warnSpy.mock.calls.some(([msg]) =>
          String(msg).includes('stale WAL sealed (contents unparsed)'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      vi.restoreAllMocks();
    }
  });

  it('non-seal fallback stays byte-frozen: a store declaring the fenced trio WITHOUT seal still drains via deleteFenced exactly as before #197 PR-1 shipped seal capability', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const claimed = await store.claimStep(run.id, 'step-agent', agentReclaimWf);
    await store.update({ ...claimed, claims: { 'step-agent': { deadline: pastIso() } } });

    // Trio-only stub — deliberately WITHOUT sealFenced/listSealedForRun/traceCapabilities, so
    // storeDeclaresSeal is false and reclaim must keep taking the deleteFenced drain path.
    const buffers = new Map<string, { event: string }[]>();
    const key = `${run.id}:step-agent`;
    buffers.set(key, [{ event: 'dead_attempt_line' }]);
    const traceBufferStore: TraceBufferStore = {
      append: async () => {
        throw new Error('not used');
      },
      read: async () => [],
      delete: async () => {
        throw new Error('not used — this store declares the trio');
      },
      deleteAllForRun: async () => {},
      readAllForRun: async () => ({}),
      deleteFenced: async (_runId, _stepId, guard) => {
        await guard();
        const existing = buffers.get(key) ?? [];
        buffers.delete(key);
        return existing.length;
      },
    };

    const calls: string[] = [];
    const originalDeleteFenced = traceBufferStore.deleteFenced!.bind(traceBufferStore);
    vi.spyOn(traceBufferStore, 'deleteFenced').mockImplementation(async (...args) => {
      calls.push('deleteFenced');
      return originalDeleteFenced(...args);
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await reclaimStep(store, run.id, 'step-agent', { traceBufferStore });
      expect(result.outcome).toBe('reclaimed');
      expect(calls).toEqual(['deleteFenced']);
      expect(buffers.has(key)).toBe(false);
      expect(
        warnSpy.mock.calls.some(([msg]) =>
          String(msg).includes('reclaim cleared 1 buffered trace entries'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      vi.restoreAllMocks();
    }
  });

  it('version-fence refusal: a concurrent bump detected at EITHER clear-guard skips the clear (WAL intact) and warns — the state reclaim itself still proceeds via the existing CAS-retry machinery', async () => {
    // A fully scripted store (mirrors the CAS-mismatch describe block above) — four DISTINCT
    // get() calls occur in order: (1) the initial decision read, (2) the primary clear-guard's
    // fresh get, (3) the CAS-retry's own reloaded re-evaluation read, (4) the retry clear-guard's
    // fresh get. Scripting all four independently (rather than relying on the 2-record clamping
    // shape the CAS-mismatch tests above use) lets this test force a version mismatch at BOTH
    // clear-guard checkpoints deterministically, without also being forced through by the
    // update() calls' own (separately scripted) CAS behavior.
    const staleClaim = { deadline: pastIso() };
    const decisionRead = makeRun({
      in_progress_steps: ['work'],
      claims: { work: staleClaim },
      version: 5,
    });
    const primaryGuardSees = makeRun({
      in_progress_steps: ['work'],
      claims: { work: staleClaim },
      version: 6,
    });
    const retryDecisionRead = makeRun({
      in_progress_steps: ['work'],
      claims: { work: staleClaim },
      version: 6,
    });
    const retryGuardSees = makeRun({
      in_progress_steps: ['work'],
      claims: { work: staleClaim },
      version: 9,
    });
    const records = [decisionRead, primaryGuardSees, retryDecisionRead, retryGuardSees];
    let getIdx = 0;
    const updateCalls: RunRecord[] = [];
    let updateCallNum = 0;
    const deleteFencedCalls: string[] = [];
    const traceBufferStore: TraceBufferStore = {
      append: async () => {
        throw new Error('not used');
      },
      read: async () => [],
      delete: async () => {
        throw new Error('not used');
      },
      deleteAllForRun: async () => {},
      readAllForRun: async () => ({}),
      deleteFenced: async (_runId, _stepId, guard) => {
        await guard(); // throws (refuses) at both checkpoints in this test — never reached below
        deleteFencedCalls.push('cleared');
        return 4;
      },
    };
    const scriptedRunStore = {
      persistsClaims: true,
      get: async () => records[Math.min(getIdx++, records.length - 1)]!,
      update: async (rec: RunRecord) => {
        updateCallNum += 1;
        if (updateCallNum === 1) {
          throw new WorkflowError('Version conflict — simulated', {
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

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await reclaimStep(scriptedRunStore, 'r1', 'work', { traceBufferStore });
      // The state reclaim itself still proceeds — unaffected by either clear-guard refusal.
      expect(result.outcome).toBe('reclaimed');
      expect(updateCalls).toHaveLength(1); // re-applied once, on the reloaded record
      // The WAL was NEVER cleared: both clear-guards refused.
      expect(deleteFencedCalls).toHaveLength(0);
      expect(
        warnSpy.mock.calls.filter(([msg]) => String(msg).includes('version fence refused')),
      ).toHaveLength(2); // once per refused attempt (primary + retry)
    } finally {
      warnSpy.mockRestore();
    }
  });
});
