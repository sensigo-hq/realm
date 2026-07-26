// Deterministic stub tests for execution-loop.ts's engine call-site adoption of the fenced trio
// (issue #207 PR-2, D3 §5 — the unified deletion contract). Each test targets exactly one of the
// five call sites the design enumerates: the success-settle WAL-delete wrap, the failure-settle
// persist-gate, the removed capability-block delete, the pre-claim read envelope, and the
// post-claim read's compensating un-claim (including its version-mismatch stop branch and audit
// entry).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { InMemoryTraceBufferStore } from '../store/trace-buffer-store.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { TraceBufferStore } from '../store/trace-buffer-store.js';
import type { StepDispatcher } from './execution-loop.js';

const agentDef: WorkflowDefinition = {
  id: 'fenced-adoption-agent-wf',
  name: 'Fenced Adoption Agent WF',
  version: 1,
  steps: {
    'step-agent': { description: 'Agent step', execution: 'agent', depends_on: [] },
  },
};

const handlerDef: WorkflowDefinition = {
  id: 'fenced-adoption-handler-wf',
  name: 'Fenced Adoption Handler WF',
  version: 1,
  steps: {
    validate: { description: 'Validate', execution: 'auto', depends_on: [], handler: 'my_handler' },
  },
};

const echo: StepDispatcher = async (_s, input) => ({ ...input });

/** A minimal legacy-only TraceBufferStore double — no fenced trio (execution-loop.ts never calls
 *  the fenced methods; only the legacy read/delete). Each field is overridable per test. */
function stubTraceBufferStore(overrides: Partial<TraceBufferStore>): TraceBufferStore {
  return {
    append: async () => {
      throw new Error('not used in this test');
    },
    read: async () => [],
    delete: async () => {},
    deleteAllForRun: async () => {},
    readAllForRun: async () => ({}),
    ...overrides,
  };
}

describe('execution-loop.ts — fenced-trio call-site adoption (issue #207 PR-2)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-fenced-adoption-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── :1857-equivalent — success-settle WAL cleanup wrap ──────────────────────────────────────
  it('success-settle: a WAL cleanup failure degrades to a warning, never an error envelope', async () => {
    const { run } = await store.create({
      workflowId: 'fenced-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = stubTraceBufferStore({
      delete: async () => {
        throw new Error('simulated lock-contention cleanup failure');
      },
    });

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
    });

    expect(envelope.status).toBe('ok'); // NOT an error envelope — the step genuinely completed
    expect(
      envelope.warnings.some((w) =>
        w.includes('Failed to clean up trace buffer after step completion'),
      ),
    ).toBe(true);
    const after = await store.get(run.id);
    expect(after.completed_steps).toContain('step-agent');
  });

  // ── :1566-equivalent — failure-settle persist-gate ──────────────────────────────────────────
  it('failure-settle: WAL delete never fires when the migrated settleStep itself fails (persist-gate)', async () => {
    const { run } = await store.create({
      workflowId: 'fenced-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    await traceBufferStore.append(run.id, 'step-agent', [{ event: 'pre_failure_line' }]);
    const deleteSpy = vi.spyOn(traceBufferStore, 'delete');

    // issue #279 (increment 1, PR-B): JsonFileStore declares settleStep — the fail site's
    // MIGRATED path settles via settleStep, not store.update. A settleStep throw returns an
    // error envelope BEFORE the WAL-cleanup section is ever reached (it lives inside the
    // applied:true branch only), so the same persist-gate invariant holds under the new
    // mechanism: WAL cleanup never fires when the settle itself never committed.
    const settleStepSpy = vi
      .spyOn(store, 'settleStep' as never)
      .mockRejectedValue(new Error('simulated persist failure') as never);

    try {
      const envelope = await executeStep(store, agentDef, {
        runId: run.id,
        command: 'step-agent',
        input: {},
        dispatcher: async () => {
          throw new Error('handler boom');
        },
        traceBufferStore,
      });

      expect(envelope.status).toBe('error');
      expect(envelope.error_code).toBe('ENGINE_STORE_FAILED');
      expect(deleteSpy).not.toHaveBeenCalled();
      // The WAL survives — it is the sole remaining evidence copy until reclaim (#186 posture).
      expect(await traceBufferStore.read(run.id, 'step-agent')).toHaveLength(1);
    } finally {
      settleStepSpy.mockRestore();
    }
  });

  // ── :1478-equivalent — capability-block delete removed entirely ─────────────────────────────
  it('capability-block settle: WAL delete is never invoked at all (removed entirely — disjoint auto/agent populations)', async () => {
    const { run } = await store.create({
      workflowId: 'fenced-adoption-handler-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    const deleteSpy = vi.spyOn(traceBufferStore, 'delete');
    // issue #207 correction (item 4a): also spy on deleteFenced — InMemoryTraceBufferStore
    // declares the fenced trio, so a hypothetically REINTRODUCED capability-block delete that
    // used deleteFenced instead of the legacy delete would evade both the legacy-delete spy above
    // AND Guard 4's regex (which deliberately does not match `deleteFenced(`, only `delete(`/
    // `deleteAllForRun(`) — this assertion is the only thing that would catch that specific
    // regression.
    const deleteFencedSpy = vi.spyOn(traceBufferStore, 'deleteFenced');

    const env = await executeStep(store, handlerDef, {
      runId: run.id,
      command: 'validate',
      input: {},
      dispatcher: echo,
      registry: new ExtensionRegistry(), // empty registry → ENGINE_HANDLER_NOT_REGISTERED
      traceBufferStore,
    });

    expect(env.error_code).toBe('ENGINE_HANDLER_NOT_REGISTERED');
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(deleteFencedSpy).not.toHaveBeenCalled();
  });

  // ── :925-equivalent — pre-claim read envelope ────────────────────────────────────────────────
  it('pre-claim WAL read failure returns a typed retryable ENGINE_STORE_FAILED envelope, no claim consumed', async () => {
    const { run } = await store.create({
      workflowId: 'fenced-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = stubTraceBufferStore({
      read: async () => {
        throw new Error('simulated pre-claim lock contention');
      },
    });

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error_code).toBe('ENGINE_STORE_FAILED');
    expect(envelope.agent_action).toBe('stop');

    const after = await store.get(run.id);
    expect(after.in_progress_steps).not.toContain('step-agent'); // no claim consumed
    expect(after.claims?.['step-agent']).toBeUndefined();
    // issue #207 correction (item 4b): sharper than the membership checks above — those alone
    // cannot distinguish "no claim was ever consumed" from "a claim was consumed and then
    // compensated" (both leave in_progress_steps/claims looking identical afterward). The
    // version being byte-identical to the pre-claim snapshot, plus the total absence of a
    // compensating_unclaim audit entry, is what actually proves NO store mutation happened at
    // all on this path (this is the pre-claim read failure — no claimStep ever ran).
    expect(after.version).toBe(run.version);
    expect(after.evidence.some((e) => e.output_summary['compensating_unclaim'] === true)).toBe(
      false,
    );
  });

  // ── :1041-equivalent — post-claim compensating un-claim ─────────────────────────────────────
  it('post-claim WAL read failure performs a compensating un-claim (claim released, audit entry recorded), returns a typed retryable envelope', async () => {
    const { run } = await store.create({
      workflowId: 'fenced-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    let readCallNum = 0;
    const traceBufferStore = stubTraceBufferStore({
      read: async () => {
        readCallNum++;
        if (readCallNum === 1) return []; // pre-claim read succeeds (nothing buffered)
        throw new Error('simulated post-claim read failure');
      },
    });

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error_code).toBe('ENGINE_STORE_FAILED');
    expect(envelope.agent_action).toBe('stop');

    const after = await store.get(run.id);
    expect(after.in_progress_steps).not.toContain('step-agent'); // claim released
    expect(after.claims?.['step-agent']).toBeUndefined();
    const audit = after.evidence.find((e) => e.output_summary['compensating_unclaim'] === true);
    expect(audit).toBeDefined();
    expect(audit?.step_id).toBe('step-agent');
  });

  it('post-claim compensating un-claim CAS-mismatch: a concurrent actor already resolved the claim → left AS-IS, still returns the typed retryable envelope (never stomped)', async () => {
    const { run } = await store.create({
      workflowId: 'fenced-adoption-agent-wf',
      workflowVersion: 1,
      params: {},
    });
    let readCallNum = 0;
    const traceBufferStore = stubTraceBufferStore({
      read: async () => {
        readCallNum++;
        if (readCallNum === 1) return [];
        // Simulate a concurrent actor (e.g. a parallel reclaim) resolving this exact claim
        // between our own claimStep and this post-claim read failing — a REAL version bump via
        // a genuine store.update, out from under our own compensating un-claim's CAS baseline.
        const current = await store.get(run.id);
        await store.update({
          ...current,
          in_progress_steps: current.in_progress_steps.filter((s) => s !== 'step-agent'),
          claims: {},
          completed_steps: [...current.completed_steps, 'step-agent'],
        });
        throw new Error('simulated post-claim read failure');
      },
    });

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error_code).toBe('ENGINE_STORE_FAILED');

    const after = await store.get(run.id);
    // The concurrent actor's own resolution survives EXACTLY as it made it — our compensating
    // un-claim's CAS mismatch stopped us immediately rather than stomping it.
    expect(after.completed_steps).toContain('step-agent');
    expect(after.in_progress_steps).not.toContain('step-agent');
  });
});
