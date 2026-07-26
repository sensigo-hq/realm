// re-arm-disclosure.test.ts — final-gate F10b (design record §6, issue #279 increment 1 PR-B):
// the settling caller (NOT the frozen applySettlement transform) compares
// pendingRun.finalizer_ledger against result.run.finalizer_ledger post-commit; any entry
// voided-before/pending-after (an operator-voided finalizer that mintFresh just re-armed on a
// LATER terminal edge) emits "finalizer '<F>' was operator-voided; re-armed by this terminal edge".
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep } from './execution-loop.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const def: WorkflowDefinition = {
  id: 're-arm-wf',
  name: 'Re-arm disclosure fixture',
  version: 1,
  steps: {
    work: { description: 'w', execution: 'agent', depends_on: [] },
    fin: { description: 'f', execution: 'finalizer', on_outcome: 'always' },
  },
};

describe('re-arm disclosure (issue #279, increment 1, PR-B, final-gate F10b)', () => {
  it('an operator-voided finalizer re-armed by a later terminal edge emits the re-arm warning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-re-arm-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      // 1. Fail 'work' — terminalizes (single step), mints 'fin' pending (on_outcome: 'always').
      // executeStep claims the step itself (Step 3) — no manual pre-claim needed/allowed.
      const firstFail = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => {
          throw new Error('boom');
        },
      });
      expect(firstFail.status).toBe('error');
      const afterFirstFail = await store.get(run.id);
      expect(afterFirstFail.finalizer_ledger?.['fin']?.status).toBe('pending');

      // 2. Operator --void's it directly (mirrors drain.ts's --void action).
      await store.update({
        ...afterFirstFail,
        finalizer_ledger: { fin: { status: 'voided', rank: 0 } },
      });

      // 3. Resume 'work' (applyResume never touches an already-voided entry — it stays voided).
      const { applyResume } = await import('./apply-resume.js');
      const beforeResume = await store.get(run.id);
      const { run: resumed } = applyResume(beforeResume, 'work', def);
      await store.update(resumed);
      const afterResume = await store.get(run.id);
      expect(afterResume.finalizer_ledger?.['fin']?.status).toBe('voided'); // untouched by resume

      // 4. Re-fail 'work' — a NEW terminal false→true edge. selectFinalizers re-selects 'fin'
      // (on_outcome 'always'); mintFresh's never-downgrade guard only skips 'completed'/'failed',
      // NOT 'voided' — so 'fin' is re-armed to a clean pending entry. THIS is the re-arm moment.
      const secondFail = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => {
          throw new Error('boom again');
        },
      });

      expect(secondFail.status).toBe('error');
      expect(
        secondFail.warnings.some(
          (w) => w.includes("finalizer 'fin' was operator-voided") && w.includes('re-armed'),
        ),
      ).toBe(true);
      const finalRun = await store.get(run.id);
      expect(finalRun.finalizer_ledger?.['fin']?.status).toBe('pending');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a finalizer that was NEVER voided produces no re-arm warning on a normal terminal edge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-re-arm-clean-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => {
          throw new Error('boom');
        },
      });
      expect(result.warnings.some((w) => w.includes('re-armed'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
