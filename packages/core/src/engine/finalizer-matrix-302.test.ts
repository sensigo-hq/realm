// finalizer-matrix-302.test.ts — issue #302 (finalizer outcome×trigger matrix) core-owned tests.
// The TCK laws (CWFS_FIRES_PER_ARM/CWFS_NEGATIVES/CWFS_SECOND_EPOCH/CWFS_ARRAY_ONCE/
// CURRENT_BEHAVIOR_PINNED) live in packages/testing/src/store/settlement-contract.ts and run
// against both JsonFileStore and InMemoryStore — this file covers what the TCK deliberately does
// NOT: the legacy `buildFinalizedSeal` dormancy path (chokepoint 2, only reachable via a
// non-declaring store double, driven through the real engine's executeStep), the
// `selectFinalizers` string-form/set-form API-compat pin, and a second-epoch witness through the
// REAL `applyResume` (the TCK's own CWFS_SECOND_EPOCH case hand-shapes the post-resume state via
// `update()`, deliberately — this test drives the actual production function instead).
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep } from './execution-loop.js';
import { applyResume } from './apply-resume.js';
import { selectFinalizers } from './settlement.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { RunStore, CreateRunOptions } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepHandler } from '../extensions/step-handler.js';

/**
 * Delegates every RunStore method to a real, functional JsonFileStore — EXCEPT `settleStep`,
 * which is never implemented at all (own-property masking, not merely `undefined`), so
 * `store.settleStep === undefined` holds by construction and the legacy `buildFinalizedSeal`
 * dormancy path is the only reachable seal mechanism. Mirrors dormancy-suite-279.test.ts's own
 * `NonDeclaringStoreDouble` precedent, narrowed to this file's one concern.
 */
class NonDeclaringStoreDouble implements RunStore {
  readonly persistsClaims: boolean;

  constructor(private readonly inner: JsonFileStore) {
    this.persistsClaims = inner.persistsClaims;
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

describe('the legacy buildFinalizedSeal dormancy path fires completed_with_failed_steps (issue #302, chokepoint 2)', () => {
  it('a non-declaring store double drives a mixed-complete seal via the LEGACY path — the declared literal fires, proving chokepoint 2', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-cwfs-dormancy-'));
    try {
      const def: WorkflowDefinition = {
        id: 'cwfs-dormancy-wf',
        name: 'CWFS dormancy fixture',
        version: 1,
        steps: {
          fail_step: { description: 'f', execution: 'agent', depends_on: [] },
          complete_step: { description: 'c', execution: 'agent', depends_on: [] },
          fin: {
            description: 'fin',
            execution: 'finalizer',
            on_outcome: 'completed_with_failed_steps',
            handler: 'fin-handler',
          },
        },
      };
      const store = new NonDeclaringStoreDouble(new JsonFileStore(dir));
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      let handlerCallCount = 0;
      const finHandler: StepHandler = {
        id: 'fin-handler',
        execute: async () => {
          handlerCallCount += 1;
          return { data: {} };
        },
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'fin-handler', finHandler);

      const failed = await executeStep(store, def, {
        runId: run.id,
        command: 'fail_step',
        input: {},
        dispatcher: async () => {
          throw new Error('deliberate failure');
        },
      });
      expect(failed.status).toBe('error');

      const completed = await executeStep(store, def, {
        runId: run.id,
        command: 'complete_step',
        input: {},
        dispatcher: async () => ({ ok: true }),
        registry,
      });
      expect(completed.status).toBe('ok');

      const finalRun = await store.get(run.id);
      expect(finalRun.terminal_state).toBe(true);
      expect(finalRun.run_phase).toBe('completed');
      expect(finalRun.failed_steps).toContain('fail_step');
      // The LEGACY path drains in-band (no ledger is ever minted on this path — mintFresh lives
      // exclusively inside applySettlement); 'fin' lands directly in completed_steps.
      expect(finalRun.finalizer_ledger).toBeUndefined();
      expect(finalRun.completed_steps).toContain('fin');
      expect(handlerCallCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('selectFinalizers string-form / set-form API compat (issue #302, S2 pin)', () => {
  it('a bare SettleStepOutcome string and a singleton ReadonlySet produce IDENTICAL selection, across complete/fail/abort', () => {
    const def: WorkflowDefinition = {
      id: 'cwfs-compat-wf',
      name: 'CWFS compat fixture',
      version: 1,
      steps: {
        a: { description: 'a', execution: 'agent', depends_on: [] },
        onComplete: {
          description: 'oc',
          execution: 'finalizer',
          on_outcome: 'complete',
          handler: 'h',
        },
        onFail: { description: 'of', execution: 'finalizer', on_outcome: 'fail', handler: 'h' },
        onAlways: {
          description: 'oa',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'h',
        },
        onArray: {
          description: 'oar',
          execution: 'finalizer',
          on_outcome: ['fail', 'abort'],
          handler: 'h',
        },
      },
    };
    const settledStepNames = new Set(['a']);

    for (const outcome of ['complete', 'fail', 'abort'] as const) {
      const viaString = selectFinalizers(def, settledStepNames, outcome);
      const viaSet = selectFinalizers(def, settledStepNames, new Set([outcome]));
      expect(viaSet).toEqual(viaString);
      expect(viaString.length).toBeGreaterThan(0); // sanity: this outcome actually selects something
    }
  });
});

describe('second-epoch witness through the REAL applyResume (issue #302, M1 pin, end-to-end)', () => {
  it('resuming step "a" (via the production applyResume) leaves a DIFFERENT finalizer\'s own prior self-failure in failed_steps — the second complete seal still fires completed_with_failed_steps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-cwfs-resume-'));
    try {
      const store = new JsonFileStore(dir);
      const def: WorkflowDefinition = {
        id: 'cwfs-resume-wf',
        name: 'CWFS resume fixture',
        version: 1,
        steps: {
          a: { description: 'a', execution: 'agent', depends_on: [] },
          onFail: { description: 'of', execution: 'finalizer', on_outcome: 'fail' },
          fin: {
            description: 'fin',
            execution: 'finalizer',
            on_outcome: 'completed_with_failed_steps',
          },
        },
      };
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const claimed = await store.claimStep(run.id, 'a', def);
      const token = claimed.claims!['a']!.token!;

      const failedA = await store.settleStep!(
        run.id,
        {
          kind: 'settle_step',
          step: 'a',
          outcome: 'fail',
          claimToken: token,
          evidence: [],
          failureMessage: 'x',
        },
        def,
      );
      if (!failedA.applied) throw new Error('fixture setup: expected fail(a) to apply');
      expect(failedA.run.finalizer_ledger?.['onFail']?.status).toBe('pending');

      // The prior epoch's finalizer self-failure: onFail itself fails (unresumable).
      const leaseToken = 'lease-1';
      const leased = await store.settleStep!(
        run.id,
        { kind: 'lease_finalizer', finalizer: 'onFail', leaseToken, leaseSeconds: 60 },
        def,
      );
      if (!leased.applied) throw new Error('fixture setup: expected lease(onFail) to apply');
      const marked = await store.settleStep!(
        run.id,
        {
          kind: 'mark_finalizer',
          finalizer: 'onFail',
          leaseToken,
          result: 'failed',
          evidence: {
            step_id: 'onFail',
            started_at: '2026-01-01T00:00:00.000Z',
            completed_at: '2026-01-01T00:00:01.000Z',
            duration_ms: 1,
            input_summary: {},
            output_summary: {},
            status: 'error',
            evidence_hash: 'x',
          },
        },
        def,
      );
      if (!marked.applied) throw new Error('fixture setup: expected mark(onFail, failed) to apply');
      expect(marked.run.failed_steps.sort()).toEqual(['a', 'onFail']);

      // REAL applyResume — resumes ONLY 'a'. 'onFail' is a DIFFERENT step name, so applyResume's
      // own `failed_steps.filter((s) => s !== stepName)` leaves it in place, verbatim — no
      // hand-shaping, this is the actual production filter.
      const snapshot = await store.get(run.id);
      const { run: resumedDraft, voided } = applyResume(snapshot, 'a', def);
      expect(voided).toEqual([]); // onFail was already 'failed', not 'pending' — nothing to void
      expect(resumedDraft.failed_steps).toEqual(['onFail']);
      expect(resumedDraft.terminal_state).toBe(false);
      const resumed = await store.update(resumedDraft);
      expect(resumed.finalizer_ledger?.['onFail']?.status).toBe('failed'); // untouched by resume

      // Second epoch: re-claim + complete 'a'. This epoch's OWN failed_steps contribution is
      // NOTHING — the only scar is onFail's prior-epoch self-failure.
      const reclaimed = await store.claimStep(run.id, 'a', def);
      const reToken = reclaimed.claims!['a']!.token!;
      const reCompleted = await store.settleStep!(
        run.id,
        {
          kind: 'settle_step',
          step: 'a',
          outcome: 'complete',
          claimToken: reToken,
          evidence: [
            {
              step_id: 'a',
              started_at: '2026-01-01T00:00:02.000Z',
              completed_at: '2026-01-01T00:00:03.000Z',
              duration_ms: 1,
              input_summary: {},
              output_summary: {},
              status: 'success',
              evidence_hash: 'y',
            },
          ],
        },
        def,
      );
      if (!reCompleted.applied) throw new Error('expected re-complete(a) to apply');
      expect(reCompleted.run.finalizer_ledger?.['fin']?.status).toBe('pending');
      expect(reCompleted.run.finalizer_ledger?.['onFail']?.status).toBe('failed'); // never re-selected
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
