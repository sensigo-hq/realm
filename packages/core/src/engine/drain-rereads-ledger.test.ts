// drain-rereads-ledger.test.ts — verification item 6, mutation probe (b) (issue #279, increment 1,
// PR-B): pins the DRAIN_REREADS_LEDGER property — `drainFinalizers` must select the NEXT
// lowest-ranked finalizer to attempt from a FRESH re-derivation (`pendingByRank(run)` against the
// latest known record) on every loop iteration, never from a list of names captured once at pass
// start.
//
// Why this needs its own test (this property was previously UNPINNED — discovered while running
// verification 6's mutation probe (b), which the existing suite did not catch): membership and
// rank are fixed at mint time (all applicable finalizers mint together, synchronously, at the
// single terminal transition, before any drain pass begins) and a store's `settleStep` gracefully
// no-ops (`applied:false, reason:'ledger_not_pending'`) on a stale lease attempt — so a pass-start
// snapshot converges to the SAME final ledger state as a fresh-derivation implementation in every
// scenario this increment's design permits. The only OBSERVABLE difference is in the number of
// `settleStep` calls made for an entry that a concurrent actor (here: the fin0 handler itself,
// standing in for a concurrent operator `--void`) resolves out from under a still-in-flight drain
// pass: fresh re-derivation sees the resolution immediately (via the SAME store's latest state) and
// never attempts to lease it; a pass-start snapshot still tries — a wasted (harmless, but real)
// round-trip a snapshot implementation would make that a re-reading one would not.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep } from './execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { RunStore, CreateRunOptions } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { SettlementDelta, SettlementResult } from '../types/settlement.js';
import type { StepHandler } from '../extensions/step-handler.js';

/** Delegates everything to a real JsonFileStore, counting `settleStep` calls per finalizer name
 *  (lease + mark both count) — the observable proxy for "did drainFinalizers even ATTEMPT this
 *  entry", independent of its outcome. */
class CountingStore implements RunStore {
  readonly settleStepCallsByFinalizer = new Map<string, number>();
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
  settleStep(
    runId: string,
    delta: SettlementDelta,
    definition: WorkflowDefinition,
    options?: { now?: Date },
  ): Promise<SettlementResult> {
    if (delta.kind === 'lease_finalizer' || delta.kind === 'mark_finalizer') {
      this.settleStepCallsByFinalizer.set(
        delta.finalizer,
        (this.settleStepCallsByFinalizer.get(delta.finalizer) ?? 0) + 1,
      );
    }
    return this.inner.settleStep(runId, delta, definition, options);
  }
}

describe('drainFinalizers re-derives pending-by-rank from fresh state every iteration (issue #279, increment 1, PR-B, verification item 6, probe b — DRAIN_REREADS_LEDGER)', () => {
  it('a finalizer resolved by a concurrent actor DURING the pass is never leased — zero settleStep calls for it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-drain-reread-'));
    try {
      const inner = new JsonFileStore(dir);
      const store = new CountingStore(inner);

      const def: WorkflowDefinition = {
        id: 'drain-reread-wf',
        name: 'Drain reread WF',
        version: 1,
        steps: {
          work: { description: 'w', execution: 'agent', depends_on: [] },
          // Declaration order fixes mint rank: fin0 → rank 0, fin1 → rank 1.
          fin0: {
            description: 'f0',
            execution: 'finalizer',
            on_outcome: 'always',
            handler: 'fin0-handler',
          },
          fin1: {
            description: 'f1',
            execution: 'finalizer',
            on_outcome: 'always',
            handler: 'fin1-handler',
          },
        },
      };
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const registry = new ExtensionRegistry();
      // fin0's handler stands in for a CONCURRENT operator: while fin0 is executing (after this
      // drain pass has already leased it, but before fin1 has been looked at), it directly voids
      // fin1 on the SAME store — exactly what an external `--void fin1` would do mid-pass.
      const fin0Handler: StepHandler = {
        id: 'fin0-handler',
        execute: async () => {
          const mid = await inner.get(run.id);
          await inner.update({
            ...mid,
            finalizer_ledger: {
              ...mid.finalizer_ledger,
              fin1: { status: 'voided', rank: mid.finalizer_ledger?.['fin1']?.rank ?? 1 },
            },
          });
          return { data: {} };
        },
      };
      const fin1Handler: StepHandler = {
        id: 'fin1-handler',
        execute: async () => ({ data: {} }),
      };
      registry.register('handler', 'fin0-handler', fin0Handler);
      registry.register('handler', 'fin1-handler', fin1Handler);

      // Settle 'work' — mints BOTH fin0 (rank 0) and fin1 (rank 1) as pending, transitions the run
      // terminal, and (per D1) auto-drains post-commit.
      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => ({}),
        registry,
      });
      expect(result.status).toBe('ok');

      const finalRun = await inner.get(run.id);
      // fin0 genuinely ran (leased + marked): exactly one lease + one mark = 2 calls.
      expect(store.settleStepCallsByFinalizer.get('fin0')).toBe(2);
      // fin1 was voided DURING fin0's execution — a fresh-derivation drain never attempts to
      // lease it at all (pendingByRank, re-read after fin0's mark, no longer lists it as pending).
      // Under a pass-start-snapshot mutation this would instead be >=1 (a wasted lease attempt
      // refused as `ledger_not_pending`).
      expect(store.settleStepCallsByFinalizer.get('fin1')).toBeUndefined();
      expect(finalRun.finalizer_ledger?.['fin1']?.status).toBe('voided'); // never overwritten back
      expect(finalRun.finalizer_ledger?.['fin0']?.status).toBe('completed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
