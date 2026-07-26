// latent-bug-claim-lost-no-fire.test.ts — verification item 2 (issue #279, increment 1, PR-B): a
// seal whose settle REFUSES (claim_lost, via a forced token mismatch) fires NO finalizers. Today's
// (pre-migration) legacy path computes its in-memory draft and drains finalizers BEFORE the
// persist even attempts — a losing concurrent writer's draft could already have fired finalizers
// before discovering (via a CAS failure) that it lost the race. On the migrated path, the fresh
// read + refusal happen INSIDE applySettlement, atomically, before any finalizer selection ever
// runs — a claim_lost refusal can never reach mintFresh/drainFinalizers at all.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep } from './execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepHandler } from '../extensions/step-handler.js';

const def: WorkflowDefinition = {
  id: 'claim-lost-no-fire-wf',
  name: 'claim_lost no-fire fixture',
  version: 1,
  steps: {
    a: { description: 'a', execution: 'agent', depends_on: [] },
    fin: {
      description: 'finalizer',
      execution: 'finalizer',
      on_outcome: 'always',
      handler: 'fin-handler',
    },
  },
};

describe('a claim_lost refusal fires ZERO finalizers (issue #279, increment 1, PR-B, verification item 2)', () => {
  it('a settle that refuses claim_lost never reaches mintFresh/drainFinalizers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-claim-lost-no-fire-'));
    try {
      const store = new JsonFileStore(dir);
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

      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'a',
        input: {},
        // The dispatcher fires WHILE this call holds its own claim — simulate a concurrent
        // writer stealing the claim (a DIFFERENT token) mid-dispatch, forcing claim_lost the
        // instant this call's own settle attempt reads fresh state.
        dispatcher: async () => {
          const mid = await store.get(run.id);
          await store.update({
            ...mid,
            claims: { ...mid.claims, a: { deadline: null, token: 'a-different-writers-token' } },
          });
          return {};
        },
        registry,
      });

      expect(result.status).toBe('error');
      expect(result.error_code).toBe('STATE_CLAIM_LOST');
      // ZERO finalizer calls — the refusal never reached mintFresh/drainFinalizers.
      expect(handlerCallCount).toBe(0);

      const finalRun = await store.get(run.id);
      expect(finalRun.completed_steps).not.toContain('fin');
      expect(finalRun.finalizer_ledger).toBeUndefined(); // never minted
      expect(finalRun.terminal_state).toBe(false); // the run never terminalized either
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
