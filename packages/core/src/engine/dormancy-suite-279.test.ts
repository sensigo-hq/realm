// dormancy-suite-279.test.ts — verification item 5 (issue #279, increment 1, PR-B). A NAMED
// representative set (re-parameterizing every pre-existing seal-path test file across a
// declaring/non-declaring axis is out of proportion for this increment) covering all THREE
// migrated sites against a non-declaring store double: `store.settleStep === undefined` by
// construction (own-property masking — never implemented, not merely set to undefined, matching
// the RunStore.settleStep OPTIONAL contract). Each site is proven byte-identical-SHAPED to legacy
// behavior (same membership/terminal outcomes the migrated path also produces) PLUS the ONE
// dormancy advisory (I16) every legacy-path envelope now carries.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep } from './execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type {
  RunStore,
  CreateRunOptions,
  LoadBearingRunRecordField,
} from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
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
});
