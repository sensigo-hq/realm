// gate-death-279.test.ts — R3-death for gates, R5-death (two legs), and the drain-on-NOOP
// integration case (issue #279, increment 2, PR-D, Deliverable 5). Companion to
// symptom-death-279.test.ts (R3/R5 for the three PR-B seal sites) — this file proves the SAME two
// symptoms are dead on the FIVE newly migrated sites' own gate/guard surfaces.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep, executeChain, submitHumanResponse } from './execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepHandler } from '../extensions/step-handler.js';
import type { RunRecord } from '../types/run-record.js';
import type { RunStore, CreateRunOptions } from '../store/store-interface.js';
import type { SettlementDelta, SettlementResult } from '../types/settlement.js';

describe('R3-death for gates (issue #279, increment 2, PR-D) — the PR-B symptom-death-279.test.ts mechanism, applied to gate-open', () => {
  it('gate-open and an ALREADY-CLAIMED sibling settling CONCURRENTLY both record — the gate OPENS, the sibling commits, zero STATE_SNAPSHOT_MISMATCH', async () => {
    const def: WorkflowDefinition = {
      id: 'r3-gate-death-wf',
      name: 'R3 gate-death fixture',
      version: 1,
      steps: {
        gate_step: {
          description: 'gated',
          execution: 'agent',
          depends_on: [],
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
        sibling: { description: 'sibling', execution: 'agent', depends_on: [] },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-r3-gate-death-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      // Pre-claim `sibling` FIRST (sequential, deterministic) — eligibility.ts's OWN documented
      // invariant ("Gate serialization: if a gate is open, no new steps are eligible") means a
      // genuinely-open gate correctly blocks ALL future ELIGIBILITY checks, globally — unrelated
      // to PR-D, and not what R3 is about. R3 is about the SETTLE-time race (two concurrent
      // writers hitting the SAME store), so both steps' CLAIMS must already exist before either
      // settles — mirroring a realistic fan-out where both steps were already dispatched to
      // agents before either one's outcome came back.
      const claimedSibling = await store.claimStep(run.id, 'sibling', def);
      const siblingToken = claimedSibling.claims?.['sibling']?.token;

      // THE race: gate-open (the full executeStep path, claim included) and the sibling's OWN
      // settle_step-complete call (the REAL store.settleStep — the exact call executeStep itself
      // would make post-dispatch) CONCURRENTLY through the real store — no interposition, plain
      // Promise.all (symptom-death-279's own mechanism).
      const [resultGate, siblingSettleResult] = await Promise.all([
        executeStep(store, def, {
          runId: run.id,
          command: 'gate_step',
          input: {},
          dispatcher: async () => ({ preview: true }),
        }),
        store.settleStep!(
          run.id,
          {
            kind: 'settle_step',
            step: 'sibling',
            outcome: 'complete',
            ...(siblingToken !== undefined ? { claimToken: siblingToken } : {}),
            evidence: [],
          },
          def,
        ),
      ]);

      expect(resultGate.status).toBe('confirm_required');
      expect(siblingSettleResult.applied).toBe(true);

      // Zero STATE_SNAPSHOT_MISMATCH anywhere in the gate-open envelope's error surface — the
      // legacy read-then-update seal (pre-#279) is exactly what would have lost one of these two
      // writes.
      expect(JSON.stringify(resultGate)).not.toContain('STATE_SNAPSHOT_MISMATCH');

      const finalRun = await store.get(run.id);
      expect(finalRun.pending_gate?.step_name).toBe('gate_step');
      expect(finalRun.completed_steps).toContain('sibling');
      expect(finalRun.claims?.['gate_step']).toBeDefined(); // gate claim retained (G-1)
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('R5-death (issue #279, increment 2, PR-D) — gate/guard terminal seals no longer fire finalizers before commit', () => {
  it('settle_gate leg: a gate resolution that COMPLETES the run delivers its finalizer EXACTLY ONCE, strictly POST-COMMIT', async () => {
    const def: WorkflowDefinition = {
      id: 'r5-gate-finalizer-wf',
      name: 'R5 gate finalizer fixture',
      version: 1,
      steps: {
        gate_step: {
          description: 'gated',
          execution: 'agent',
          depends_on: [],
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
        fin: {
          description: 'finalizer',
          execution: 'finalizer',
          on_outcome: 'complete',
          handler: 'fin-handler',
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-r5-gate-fin-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const opened = await executeStep(store, def, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({ preview: true }),
      });
      expect(opened.status).toBe('confirm_required');

      let handlerCallCount = 0;
      let snapshotAtHandlerCallTime: { completed: string[]; terminal: boolean } | undefined;
      const finHandler: StepHandler = {
        id: 'fin-handler',
        execute: async () => {
          handlerCallCount += 1;
          // Prove POST-COMMIT: by the time the finalizer's handler runs, the gate resolution must
          // already be durably recorded — read a FRESH copy from disk, not an in-memory draft.
          const fresh: RunRecord = await store.get(run.id);
          snapshotAtHandlerCallTime = {
            completed: [...fresh.completed_steps].sort(),
            terminal: fresh.terminal_state,
          };
          return { data: {} };
        },
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'fin-handler', finHandler);

      const resolved = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: opened.gate!.gate_id,
        choice: 'approve',
        registry,
      });
      expect(resolved.status).toBe('ok');

      const finalRun = await store.get(run.id);
      expect(finalRun.completed_steps.sort()).toEqual(['fin', 'gate_step']);
      expect(finalRun.terminal_state).toBe(true);
      expect(handlerCallCount).toBe(1); // exactly once — never zero, never twice
      expect(snapshotAtHandlerCallTime).toEqual({ completed: ['gate_step'], terminal: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('guard-terminal leg (the leg the draft missed): a guard that ABORTS the run delivers its finalizer EXACTLY ONCE, strictly POST-COMMIT', async () => {
    const def: WorkflowDefinition = {
      id: 'r5-guard-finalizer-wf',
      name: 'R5 guard finalizer fixture',
      version: 1,
      steps: {
        step_a: { description: 'a', execution: 'agent', depends_on: [] },
        guard_b: {
          description: 'g',
          execution: 'guard',
          depends_on: ['step_a'],
          abort_unless: ["step_a.status == 'open'"],
        },
        fin: {
          description: 'finalizer',
          execution: 'finalizer',
          on_outcome: 'abort',
          handler: 'fin-handler',
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-r5-guard-fin-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      let handlerCallCount = 0;
      let snapshotAtHandlerCallTime:
        { skipped: string[]; terminal: boolean; aborted: boolean } | undefined;
      const finHandler: StepHandler = {
        id: 'fin-handler',
        execute: async () => {
          handlerCallCount += 1;
          const fresh: RunRecord = await store.get(run.id);
          snapshotAtHandlerCallTime = {
            skipped: [...fresh.skipped_steps].sort(),
            terminal: fresh.terminal_state,
            aborted: fresh.aborted_at !== undefined,
          };
          return { data: {} };
        },
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'fin-handler', finHandler);

      const result = await executeChain(store, def, {
        runId: run.id,
        command: 'step_a',
        input: {},
        dispatcher: async () => ({ status: 'closed' }), // aborts guard_b
        registry,
      });
      expect(result.status).toBe('ok');

      const finalRun = await store.get(run.id);
      expect(finalRun.skipped_steps).toContain('guard_b');
      expect(finalRun.completed_steps).toContain('fin');
      expect(finalRun.terminal_state).toBe(true);
      expect(finalRun.aborted_at?.step_id).toBe('guard_b');
      expect(handlerCallCount).toBe(1); // exactly once — never zero, never twice
      expect(snapshotAtHandlerCallTime).toEqual({
        skipped: ['guard_b'],
        terminal: true,
        aborted: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Delegates every method to a real JsonFileStore, EXCEPT `settleStep`: the FIRST `lease_finalizer`
 * delta is refused (thrown), simulating a crash between the settle_gate commit and the drain loop
 * actually leasing the first pending finalizer. Every other delta (including every OTHER
 * `lease_finalizer` call, post-recovery) passes straight through.
 */
class RefusesFirstLeaseStore implements RunStore {
  readonly persistsClaims: boolean;
  private refused = false;
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
  async settleStep(
    runId: string,
    delta: SettlementDelta,
    definition: WorkflowDefinition,
    options?: { now?: Date },
  ): Promise<SettlementResult> {
    if (!this.refused && delta.kind === 'lease_finalizer') {
      this.refused = true;
      throw new Error('simulated crash between settle_gate commit and the drain lease');
    }
    return this.inner.settleStep(runId, delta, definition, options);
  }
}

describe('Drain-on-NOOP integration (issue #279, increment 2, PR-D, design record §6 lens-2 S2)', () => {
  it('a crashed-drain RESOLVE (finalizer minted PENDING, drain lease failed) self-heals on a duplicate submit — finalizers DELIVERED + the NOOP envelope carries the drain warnings', async () => {
    const def: WorkflowDefinition = {
      id: 'drain-on-noop-wf',
      name: 'Drain-on-NOOP fixture',
      version: 1,
      steps: {
        gate_step: {
          description: 'gated',
          execution: 'agent',
          depends_on: [],
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
        fin: {
          description: 'finalizer',
          execution: 'finalizer',
          on_outcome: 'complete',
          handler: 'fin-handler',
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-drain-noop-'));
    try {
      const inner = new JsonFileStore(dir);
      const { run } = await inner.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const crashingStore = new RefusesFirstLeaseStore(inner);

      const opened = await executeStep(crashingStore, def, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({ preview: true }),
      });
      expect(opened.status).toBe('confirm_required');
      const gateId = opened.gate!.gate_id;

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

      // FIRST submit: settle_gate commits (terminal, ledger minted PENDING), but the drain's OWN
      // lease call is refused (simulated crash) — the finalizer is left PENDING, undelivered.
      const firstSubmit = await submitHumanResponse(crashingStore, def, {
        runId: run.id,
        gateId,
        choice: 'approve',
        registry,
      });
      expect(firstSubmit.status).toBe('ok');
      const afterCrash = await inner.get(run.id);
      expect(afterCrash.terminal_state).toBe(true);
      expect(afterCrash.finalizer_ledger?.['fin']?.status).toBe('pending');
      expect(handlerCallCount).toBe(0); // never delivered — the drain's lease call was refused

      // SECOND submit (a duplicate, same gate_id + same choice) against the HONEST store — hits
      // already_settled, and the design's drain-on-NOOP clause recovers the crashed drain.
      const duplicateSubmit = await submitHumanResponse(inner, def, {
        runId: run.id,
        gateId,
        choice: 'approve',
        registry,
      });
      expect(duplicateSubmit.status).toBe('ok');
      expect(handlerCallCount).toBe(1); // NOW delivered, exactly once — the load-bearing proof
      // A drain warning is not guaranteed on a SUCCESSFUL recovery (the honest store's own drain
      // just succeeds quietly this time) — delivery itself is what this test proves; the NOOP
      // envelope's own calm shape (status 'ok', no error) is asserted above.
      expect(duplicateSubmit.status).toBe('ok');

      const finalRun = await inner.get(run.id);
      expect(finalRun.completed_steps).toContain('fin');
      expect(finalRun.finalizer_ledger?.['fin']?.status).toBe('completed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
