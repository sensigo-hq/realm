// finalizer-matrix-302.test.ts — issue #302 (finalizer outcome×trigger matrix) core-owned tests.
// The TCK laws (CWFS_FIRES_PER_ARM/CWFS_NEGATIVES/CWFS_SECOND_EPOCH/CWFS_ARRAY_ONCE/
// CURRENT_BEHAVIOR_PINNED) live in packages/testing/src/store/settlement-contract.ts and run
// against both JsonFileStore and InMemoryStore — this file covers what the TCK deliberately does
// NOT: the `selectFinalizers` string-form/set-form API-compat pin, and a second-epoch witness through the
// REAL `applyResume` (the TCK's own CWFS_SECOND_EPOCH case hand-shapes the post-resume state via
// `update()`, deliberately — this test drives the actual production function instead). #715 (b): the
// legacy `buildFinalizedSeal` dormancy-path cell is gone with the path (`settleStep` is required).
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { applyResume } from './apply-resume.js';
import { selectFinalizers } from './settlement.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

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
      const { record: run } = await store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      const { record: claimed } = await store.claimStep(run.id, 'a', def);
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
      const { record: snapshot } = await store.get(run.id);
      const { run: resumedDraft, voided } = applyResume(snapshot, 'a', def);
      expect(voided).toEqual([]); // onFail was already 'failed', not 'pending' — nothing to void
      expect(resumedDraft.failed_steps).toEqual(['onFail']);
      expect(resumedDraft.terminal_state).toBe(false);
      const { record: resumed } = await store.update(resumedDraft);
      expect(resumed.finalizer_ledger?.['onFail']?.status).toBe('failed'); // untouched by resume

      // Second epoch: re-claim + complete 'a'. This epoch's OWN failed_steps contribution is
      // NOTHING — the only scar is onFail's prior-epoch self-failure.
      const { record: reclaimed } = await store.claimStep(run.id, 'a', def);
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
