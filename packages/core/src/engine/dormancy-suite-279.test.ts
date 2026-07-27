// dormancy-suite-279.test.ts — verification item 5 (issue #279, increment 1 PR-B + increment 2
// PR-D). A NAMED representative set (re-parameterizing every pre-existing seal-path test file
// across a declaring/non-declaring axis is out of proportion for this increment) covering ALL
// EIGHT migrated sites (PR-B's three + PR-D's five) against a non-declaring store double:
// `store.settleStep === undefined` by construction (own-property masking — never implemented, not
// merely set to undefined, matching the RunStore.settleStep OPTIONAL contract). Each site is
// proven byte-identical-SHAPED to legacy behavior (same membership/terminal outcomes the migrated
// path also produces) PLUS the ONE dormancy advisory (I16) every legacy-path envelope now carries.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep, executeChain, submitHumanResponse } from './execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type {
  RunStore,
  CreateRunOptions,
  LoadBearingRunRecordField,
} from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { TraceBufferStore, BufferedEntry, AppendResult } from '../store/trace-buffer-store.js';
import type { StepHandler } from '../extensions/step-handler.js';

/**
 * Delegates every RunStore method to a real, functional JsonFileStore — EXCEPT `settleStep`,
 * which is never implemented at all (not set to `undefined`; simply absent), so
 * `store.settleStep === undefined` holds by construction and every migrated seal site takes its
 * dormancy-fallback branch. Mirrors execution-loop-fidelity-gate.test.ts's own
 * `DeclaredFieldsOverrideStore` precedent (issue #188), narrowed to this PR's one concern.
 */
class NonDeclaringStoreDouble implements RunStore {
  readonly persistsClaims: boolean;
  readonly persistedRunRecordFields?: ReadonlySet<LoadBearingRunRecordField>;

  constructor(private readonly inner: JsonFileStore) {
    this.persistsClaims = inner.persistsClaims;
    this.persistedRunRecordFields = inner.persistedRunRecordFields;
  }

  create(options: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }> {
    return this.inner.create(options);
  }
  get(runId: string): Promise<RunRecord> {
    return this.inner.get(runId);
  }
  update(record: RunRecord): Promise<RunRecord> {
    return this.inner.update(record);
  }
  list(workflowId?: string): Promise<RunRecord[]> {
    return this.inner.list(workflowId);
  }
  claimStep(runId: string, stepName: string, definition: WorkflowDefinition): Promise<RunRecord> {
    return this.inner.claimStep(runId, stepName, definition);
  }
  // settleStep intentionally OMITTED.
}

const DORMANCY_ADVISORY_SUBSTRING = 'settled via the legacy compatibility path';

async function withStore<T>(fn: (store: NonDeclaringStoreDouble) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'realm-dormancy-'));
  try {
    return await fn(new NonDeclaringStoreDouble(new JsonFileStore(dir)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('dormancy suite — the legacy path is byte-identical-shaped + the ONE advisory (issue #279, increment 1, PR-B, verification item 5)', () => {
  it('COMPLETE site: a non-declaring store settles via the legacy path — completes the run, and the envelope carries the dormancy advisory', async () => {
    await withStore(async (store) => {
      const def: WorkflowDefinition = {
        id: 'dormancy-complete-wf',
        name: 'Dormancy complete',
        version: 1,
        steps: { work: { description: 'w', execution: 'agent', depends_on: [] } },
      };
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => ({ ok: true }),
      });
      expect(result.status).toBe('ok');
      expect(result.errors).toEqual([]);
      const finalRun = await store.get(run.id);
      expect(finalRun.completed_steps).toContain('work');
      expect(finalRun.terminal_state).toBe(true);
      expect(finalRun.run_phase).toBe('completed');
      expect(result.warnings.some((w) => w.includes(DORMANCY_ADVISORY_SUBSTRING))).toBe(true);
    });
  });

  it('FAIL site: a non-declaring store settles via the legacy path — fails the run, and the envelope carries the dormancy advisory', async () => {
    await withStore(async (store) => {
      const def: WorkflowDefinition = {
        id: 'dormancy-fail-wf',
        name: 'Dormancy fail',
        version: 1,
        steps: { work: { description: 'w', execution: 'agent', depends_on: [] } },
      };
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => {
          throw new Error('boom');
        },
      });
      expect(result.status).toBe('error');
      const finalRun = await store.get(run.id);
      expect(finalRun.failed_steps).toContain('work');
      expect(finalRun.terminal_state).toBe(true);
      expect(finalRun.run_phase).toBe('failed');
      expect(result.warnings.some((w) => w.includes(DORMANCY_ADVISORY_SUBSTRING))).toBe(true);
    });
  });

  it('HANDLER-ABORT site: a non-declaring store settles via the legacy path — aborts the run, and the envelope carries the dormancy advisory', async () => {
    await withStore(async (store) => {
      const def: WorkflowDefinition = {
        id: 'dormancy-abort-wf',
        name: 'Dormancy abort',
        version: 1,
        steps: {
          work: { description: 'w', execution: 'auto', depends_on: [], handler: 'abort-handler' },
        },
      };
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const abortHandler: StepHandler = {
        id: 'abort-handler',
        execute: async () => ({ abort: { message: 'graceful stop' } }),
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'abort-handler', abortHandler);

      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => ({}),
        registry,
      });
      expect(result.status).toBe('ok'); // handler-abort is a recorded 'ok' outcome, not an error
      const finalRun = await store.get(run.id);
      expect(finalRun.terminal_state).toBe(true);
      expect(finalRun.aborted_at?.step_id).toBe('work');
      expect(result.warnings.some((w) => w.includes(DORMANCY_ADVISORY_SUBSTRING))).toBe(true);
    });
  });

  it('the claim-time drain advisory: a non-declaring store never mints a finalizer_ledger at all (mintFresh only runs inside applySettlement), so the claim-refusal path has nothing to disclose', async () => {
    await withStore(async (store) => {
      const def: WorkflowDefinition = {
        id: 'dormancy-claim-advisory-wf',
        name: 'Dormancy claim advisory',
        version: 1,
        steps: {
          work: { description: 'w', execution: 'agent', depends_on: [] },
          fin: {
            description: 'f',
            execution: 'finalizer',
            on_outcome: 'always',
            handler: 'fin-handler',
          },
        },
      };
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const registry = new ExtensionRegistry();
      registry.register('handler', 'fin-handler', {
        id: 'fin-handler',
        execute: async () => ({ data: {} }),
      });
      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => ({}),
        registry,
      });
      expect(result.status).toBe('ok');
      const finalRun = await store.get(run.id);
      // The LEGACY buildFinalizedSeal path drains the finalizer pre-commit, in-band — no ledger
      // is ever minted on the dormancy path (mintFresh lives exclusively inside applySettlement).
      expect(finalRun.finalizer_ledger).toBeUndefined();
      expect(finalRun.completed_steps).toContain('fin');
    });
  });

  // -------------------------------------------------------------------------
  // issue #279, increment 2, PR-D — the five NEWLY migrated sites, same discipline.
  // -------------------------------------------------------------------------

  it('GATE-OPEN site: a non-declaring store settles via the legacy path — opens the gate, and the envelope carries the dormancy advisory', async () => {
    await withStore(async (store) => {
      const def: WorkflowDefinition = {
        id: 'dormancy-gate-open-wf',
        name: 'Dormancy gate open',
        version: 1,
        steps: {
          work: {
            description: 'w',
            execution: 'agent',
            depends_on: [],
            trust: 'human_confirmed',
            gate: { choices: ['approve', 'reject'] },
          },
        },
      };
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => ({ preview: true }),
      });
      expect(result.status).toBe('confirm_required');
      expect(result.gate?.step_name).toBe('work');
      expect(result.warnings.some((w) => w.includes(DORMANCY_ADVISORY_SUBSTRING))).toBe(true);
      const finalRun = await store.get(run.id);
      expect(finalRun.pending_gate?.step_name).toBe('work');
    });
  });

  it('GATE-RESOLUTION site: a non-declaring store settles via the legacy path — resolves the gate, and the envelope carries the dormancy advisory', async () => {
    await withStore(async (store) => {
      const def: WorkflowDefinition = {
        id: 'dormancy-gate-resolve-wf',
        name: 'Dormancy gate resolve',
        version: 1,
        steps: {
          work: {
            description: 'w',
            execution: 'agent',
            depends_on: [],
            trust: 'human_confirmed',
            gate: { choices: ['approve', 'reject'] },
          },
        },
      };
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const opened = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => ({ preview: true }),
      });
      expect(opened.status).toBe('confirm_required');
      const result = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: opened.gate!.gate_id,
        choice: 'approve',
      });
      expect(result.status).toBe('ok');
      expect(result.warnings.some((w) => w.includes(DORMANCY_ADVISORY_SUBSTRING))).toBe(true);
      const finalRun = await store.get(run.id);
      expect(finalRun.completed_steps).toContain('work');
      expect(finalRun.terminal_state).toBe(true);
    });
  });

  it('GUARD-CHAIN site: a non-declaring store settles via the legacy path — the guard aborts the run, and the envelope carries the dormancy advisory', async () => {
    await withStore(async (store) => {
      const def: WorkflowDefinition = {
        id: 'dormancy-guard-abort-wf',
        name: 'Dormancy guard abort',
        version: 1,
        steps: {
          step_a: { description: 'a', execution: 'agent', depends_on: [] },
          guard_b: {
            description: 'g',
            execution: 'guard',
            depends_on: ['step_a'],
            abort_unless: ["step_a.status == 'open'"],
          },
        },
      };
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      // ONE executeChain call settles step_a (via the same non-declaring dormancy fallback) AND
      // then drives the guard chain inline — 'closed' ⇒ the guard condition fails ⇒ aborts.
      const result = await executeChain(store, def, {
        runId: run.id,
        command: 'step_a',
        input: {},
        dispatcher: async () => ({ status: 'closed' }),
      });
      expect(result.status).toBe('ok');
      const finalRun = await store.get(run.id);
      expect(finalRun.terminal_state).toBe(true);
      expect(finalRun.aborted_at?.step_id).toBe('guard_b');
      // The guard's own terminal-return envelope (returned directly by executeChainInternal) —
      // this IS the envelope that reaches the caller.
      expect(result.warnings.some((w) => w.includes(DORMANCY_ADVISORY_SUBSTRING))).toBe(true);
    });
  });

  it('CAPABILITY-RELEASE site: a non-declaring store settles via the legacy path — records the capability block, and the envelope carries the dormancy advisory', async () => {
    await withStore(async (store) => {
      const def: WorkflowDefinition = {
        id: 'dormancy-capability-release-wf',
        name: 'Dormancy capability release',
        version: 1,
        steps: {
          work: {
            description: 'w',
            execution: 'auto',
            depends_on: [],
            handler: 'not-registered-handler',
          },
        },
      };
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      // Empty registry — 'not-registered-handler' is never provided, forcing the
      // ENGINE_HANDLER_NOT_REGISTERED recoverable-incapability leg.
      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => ({}),
        registry: new ExtensionRegistry(),
      });
      expect(result.status).toBe('error');
      expect(result.error_code).toBe('ENGINE_HANDLER_NOT_REGISTERED');
      expect(result.warnings.some((w) => w.includes(DORMANCY_ADVISORY_SUBSTRING))).toBe(true);
      const finalRun = await store.get(run.id);
      expect(finalRun.capability_blocks?.['work']).toBeDefined();
      expect(finalRun.in_progress_steps).not.toContain('work');
      expect(finalRun.terminal_state).toBe(false); // recoverable — never terminal-burned
    });
  });

  /** Succeeds on its FIRST `read()` call (the pre-claim enforce-gate read); throws on every
   *  subsequent call (the post-claim re-read) — simulates the exact race the compensating
   *  un-claim path exists to recover from (issue #207 PR-2, D3 §5). */
  class ThrowsOnSecondReadTraceBufferStore implements TraceBufferStore {
    private readCount = 0;
    append(): Promise<AppendResult> {
      throw new Error('append not used by this double');
    }
    async read(): Promise<BufferedEntry[]> {
      this.readCount += 1;
      if (this.readCount >= 2) throw new Error('simulated post-claim WAL read failure');
      return [];
    }
    async delete(): Promise<void> {}
    async deleteAllForRun(): Promise<void> {}
    async readAllForRun(): Promise<Record<string, unknown[]>> {
      return {};
    }
  }

  it('COMPENSATING-UNCLAIM site: a non-declaring store logs-only via the legacy path — the ENGINE_STORE_FAILED envelope is the disclosure, carrying the dormancy advisory', async () => {
    await withStore(async (store) => {
      const def: WorkflowDefinition = {
        id: 'dormancy-unclaim-wf',
        name: 'Dormancy compensating unclaim',
        version: 1,
        steps: { work: { description: 'w', execution: 'agent', depends_on: [] } },
      };
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => ({ ok: true }),
        traceBufferStore: new ThrowsOnSecondReadTraceBufferStore(),
      });
      expect(result.status).toBe('error');
      expect(result.error_code).toBe('ENGINE_STORE_FAILED');
      expect(result.warnings.some((w) => w.includes(DORMANCY_ADVISORY_SUBSTRING))).toBe(true);
      // The claim was compensated (released) — log-only, but the step IS eligible again.
      const finalRun = await store.get(run.id);
      expect(finalRun.in_progress_steps).not.toContain('work');
      expect(finalRun.claims?.['work']).toBeUndefined();
    });
  });
});
