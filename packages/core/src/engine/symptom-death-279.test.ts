// symptom-death-279.test.ts — verification item 1, "THE POINT" (issue #279, increment 1, PR-B).
// Two concurrent executeStep calls settling different SIBLING steps of one run, through the REAL
// engine and a REAL InMemoryStore: BOTH outcomes are recorded, ZERO STATE_SNAPSHOT_MISMATCH,
// exactly one terminal transition + one finalizer mint, and the finalizer fires EXACTLY ONCE,
// strictly POST-COMMIT (both siblings already durably completed by the time the handler runs).
//
// The pre-#279 legacy read-then-update seal is THE bug this proves is dead on the migrated path:
// two concurrent settles racing a stale in-memory draft would silently lose one outcome (or throw
// STATE_SNAPSHOT_MISMATCH on the loser). No pre/post contrast is required — this test passing AT
// ALL against the real, unmocked engine + store is the proof (per the hand-off prompt's own
// instruction).
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { executeStep } from './execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepHandler } from '../extensions/step-handler.js';

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
    const store = new InMemoryStore();
    const { record: run } = await store.create({
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
        // already be durably recorded — read a FRESH copy from the store, not the engine's draft.
        const { record: fresh } = await store.get(run.id);
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

    const { record: finalRun } = await store.get(run.id);
    expect(finalRun.completed_steps.sort()).toEqual(['a', 'b', 'fin']);
    expect(finalRun.terminal_state).toBe(true);
    expect(finalRun.run_phase).toBe('completed');

    // Exactly one terminal transition + one mint: the finalizer ran EXACTLY once (not zero,
    // not twice — a lost race under the legacy mechanism could plausibly double-fire or
    // never-fire depending on which draft won).
    expect(handlerCallCount).toBe(1);

    // POST-COMMIT proof: at the instant the handler ran, BOTH siblings were ALREADY durably
    // completed (read fresh from the store) — the finalizer never fired off a stale pre-commit draft.
    expect(membershipAtHandlerCallTime).toEqual({ completed: ['a', 'b'] });

    // Zero STATE_SNAPSHOT_MISMATCH anywhere in either envelope's error surface.
    expect(JSON.stringify(resultA)).not.toContain('STATE_SNAPSHOT_MISMATCH');
    expect(JSON.stringify(resultB)).not.toContain('STATE_SNAPSHOT_MISMATCH');
  });

  // NOTE: the store law beneath this (one settle applied fresh, no await between its read and its
  // write) is proven by @sensigo/realm-testing's own settlement TCK (L1 FRESH_APPLICATION) and by
  // that package's no-await behavioral-overlap pin; this file proves the engine's part (two sibling
  // settles through executeStep, one finalizer mint after the commit) on one InMemoryStore. Core's tests can import @sensigo/realm-testing without declaring it (a
  // declared dependency would be a cycle; turbo builds it before every test task, as turbo.json
  // says).
});
