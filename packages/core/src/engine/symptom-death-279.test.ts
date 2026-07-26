// symptom-death-279.test.ts — verification item 1, "THE POINT" (issue #279, increment 1, PR-B).
// Two concurrent executeStep calls settling different SIBLING steps of one run, through the REAL
// engine and a REAL JsonFileStore: BOTH outcomes are recorded, ZERO STATE_SNAPSHOT_MISMATCH,
// exactly one terminal transition + one finalizer mint, and the finalizer fires EXACTLY ONCE,
// strictly POST-COMMIT (both siblings already durably completed by the time the handler runs).
//
// The pre-#279 legacy read-then-update seal is THE bug this proves is dead on the migrated path:
// two concurrent settles racing a stale in-memory draft would silently lose one outcome (or throw
// STATE_SNAPSHOT_MISMATCH on the loser). No pre/post contrast is required — this test passing AT
// ALL against the real, unmocked engine + store is the proof (per the hand-off prompt's own
// instruction).
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep } from './execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepHandler } from '../extensions/step-handler.js';
import type { RunRecord } from '../types/run-record.js';

const def: WorkflowDefinition = {
  id: 'symptom-death-279-wf',
  name: 'Symptom-death fan-out fixture',
  version: 1,
  steps: {
    a: { description: 'sibling a', execution: 'agent', depends_on: [] },
    b: { description: 'sibling b', execution: 'agent', depends_on: [] },
    fin: {
      description: 'finalizer',
      execution: 'finalizer',
      on_outcome: 'always',
      handler: 'fin-handler',
    },
  },
};

describe('THE symptom dies end-to-end (issue #279, increment 1, PR-B, verification item 1)', () => {
  it('two sibling steps settling CONCURRENTLY both record, zero STATE_SNAPSHOT_MISMATCH, exactly one terminal transition + one mint, and the finalizer fires exactly once, post-commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-symptom-death-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });

      // executeStep claims each step itself (Step 3) — no manual pre-claim (claimStep's own
      // single-owner guarantee is a separate, already-proven property; this test is about the
      // SETTLE race specifically, which fires once each call's OWN internal claim succeeds).
      let handlerCallCount = 0;
      let membershipAtHandlerCallTime: { completed: string[] } | undefined;
      const finHandler: StepHandler = {
        id: 'fin-handler',
        execute: async () => {
          handlerCallCount += 1;
          // Prove POST-COMMIT: by the time the finalizer's handler runs, BOTH siblings must
          // already be durably recorded — read a FRESH copy from disk, not an in-memory draft.
          const fresh: RunRecord = await store.get(run.id);
          membershipAtHandlerCallTime = { completed: [...fresh.completed_steps].sort() };
          return { data: {} };
        },
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'fin-handler', finHandler);

      // THE race: both siblings settle CONCURRENTLY through the real engine + real store.
      const [resultA, resultB] = await Promise.all([
        executeStep(store, def, {
          runId: run.id,
          command: 'a',
          input: {},
          dispatcher: async () => ({}),
          registry,
        }),
        executeStep(store, def, {
          runId: run.id,
          command: 'b',
          input: {},
          dispatcher: async () => ({}),
          registry,
        }),
      ]);

      // BOTH outcomes recorded — zero STATE_SNAPSHOT_MISMATCH, zero lost settlement.
      expect(resultA.status).toBe('ok');
      expect(resultB.status).toBe('ok');
      expect(resultA.errors).toEqual([]);
      expect(resultB.errors).toEqual([]);

      const finalRun = await store.get(run.id);
      expect(finalRun.completed_steps.sort()).toEqual(['a', 'b', 'fin']);
      expect(finalRun.terminal_state).toBe(true);
      expect(finalRun.run_phase).toBe('completed');

      // Exactly one terminal transition + one mint: the finalizer ran EXACTLY once (not zero,
      // not twice — a lost race under the legacy mechanism could plausibly double-fire or
      // never-fire depending on which draft won).
      expect(handlerCallCount).toBe(1);

      // POST-COMMIT proof: at the instant the handler ran, BOTH siblings were ALREADY durably
      // completed (read fresh from disk) — the finalizer never fired off a stale pre-commit draft.
      expect(membershipAtHandlerCallTime).toEqual({ completed: ['a', 'b'] });

      // Zero STATE_SNAPSHOT_MISMATCH anywhere in either envelope's error surface.
      expect(JSON.stringify(resultA)).not.toContain('STATE_SNAPSHOT_MISMATCH');
      expect(JSON.stringify(resultB)).not.toContain('STATE_SNAPSHOT_MISMATCH');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // NOTE: the "no-await single-owner path" (InMemoryStore) is proven separately by
  // @sensigo/realm-testing's own settlement TCK (L1 FRESH_APPLICATION, run against InMemoryStore)
  // and by that package's dedicated no-await behavioral-overlap pin — packages/core cannot import
  // @sensigo/realm-testing itself (it would be a circular package dependency: testing already
  // depends on core), so this file's own proof is JsonFileStore-only, per the constraint the #183/
  // #188 precedent already established for this exact situation.
});
