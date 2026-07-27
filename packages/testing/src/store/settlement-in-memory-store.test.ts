// settlement-in-memory-store.test.ts — settlement-law TCK conformance for InMemoryStore (issue
// #279, increment 1, PR-A). See settlement-json-file-store.test.ts's own header for why both
// stores' settlement conformance lives here rather than @sensigo/realm-cli (the #183/#188
// precedent location) — that constraint doesn't apply to this package.
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from './in-memory-store.js';
import {
  settlementContract,
  defaultSettlementFixture,
  type SettlementLaw,
} from './settlement-contract.js';

const LAWS: SettlementLaw[] = [
  'FRESH_APPLICATION',
  'CONDITIONAL_NOOP',
  'CONDITIONAL_NOOP_GRANDFATHERED',
  'OWNERSHIP_REFUSAL',
  'LEDGER_MINT_ATOMICITY',
  'DRAIN_MARK_DEDUP',
  'TERMINAL_REFUSAL',
  'TERMINAL_STATE_ONLY',
  'CS_PURITY',
  'NEVER_DOWNGRADE',
  'SETTLE_OUTCOME_INTEGRITY',
  'SETTLED_ORPHAN_OVERWRITE',
  'TRANSFORM_FIDELITY',
  'RESULT_AS_APPLIED',
  'MARK_MEMBERSHIP',
  'REFUSAL_SWEEP',
  'MINT_FRESH',
  'SELF_IMAGE_IDEMPOTENCE',
  'TERMINAL_GATE_EXCLUSION',
  'COMPLETE_SEAL_PHASE',
  'WHEN_ROUTED_TERMINALIZATION',
  'G1_GATE_COEXISTENCE',
  // issue #279, increment 2 (PR-C).
  'GATE_OPEN_IDEMPOTENT',
  'GATE_RESOLUTION_CONFLICT',
  'GATE_MISMATCH',
  'GUARD_OUTCOME_DIVERGENCE',
  'GUARD_WAITS_ON_OPEN_GATE',
  'GUARD_PASS_COMPLETE_OUTCOME',
  'GUARD_ABORT_CASCADE',
  'GUARD_NO_ENTRY',
  'RELEASE_IDEMPOTENT',
  'PHASE_IS_GENERATED',
];

describe('InMemoryStore — settlement TCK conformance (issue #279, increment 1 + 2)', () => {
  it('declares settleStep and the two new LoadBearingRunRecordFields (settled/finalizer_ledger)', () => {
    const store = new InMemoryStore();
    expect(store.settleStep).toBeDefined();
    expect(store.persistedRunRecordFields?.has('settled')).toBe(true);
    expect(store.persistedRunRecordFields?.has('finalizer_ledger')).toBe(true);
  });

  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const store = new InMemoryStore();
      const cases = settlementContract({
        store,
        storeName: 'InMemoryStore',
        settlementFixture: defaultSettlementFixture,
      });
      const matching = cases.filter((c) => c.law === law);
      expect(matching.length).toBeGreaterThan(0);
      for (const c of matching) {
        await c.run();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// InMemoryStore no-await pin (issue #279 design record §8) — the behavioral overlap test.
// ---------------------------------------------------------------------------
//
// InMemoryStore.settleStep documents (see in-memory-store.ts) that it performs NO `await`
// between its fresh read (`this.runs.get`) and its committing write (`this.runs.set`) — the same
// discipline claimStep already relies on (issue #188's single-owner guarantee). This test proves
// that discipline directly and by name, independent of L1 FRESH_APPLICATION's own (store-generic)
// fan-out case, which exercises the same shape but is not specifically about this store's
// no-await implementation detail. Mutation probe (e) in the hand-off prompt's verification list
// targets exactly this test: inserting an `await` between the read and the write in
// InMemoryStore.settleStep must red this test (an interleaving window would let both concurrent
// settles observe the SAME pre-write fresh state and race on `this.runs.set`, though because
// `Map.set` itself is synchronous the more likely observable failure is a lost update — one of
// the two disjoint step outcomes silently missing from the final record).
describe('InMemoryStore — no-await single-owner discipline for settleStep (issue #279)', () => {
  it('two disjoint concurrent settleStep calls (same run, different steps) both land — no interleaving window', async () => {
    const store = new InMemoryStore();
    const def = defaultSettlementFixture.minimalDefinition(['a', 'b']);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const claimedA = await store.claimStep(run.id, 'a', def);
    const tokenA = claimedA.claims!['a']!.token!;
    const claimedB = await store.claimStep(run.id, 'b', def);
    const tokenB = claimedB.claims!['b']!.token!;

    const [resultA, resultB] = await Promise.all([
      store.settleStep!(
        run.id,
        { kind: 'settle_step', step: 'a', outcome: 'complete', claimToken: tokenA, evidence: [] },
        def,
      ),
      store.settleStep!(
        run.id,
        { kind: 'settle_step', step: 'b', outcome: 'complete', claimToken: tokenB, evidence: [] },
        def,
      ),
    ]);
    expect(resultA.applied).toBe(true);
    expect(resultB.applied).toBe(true);

    const final = await store.get(run.id);
    expect(final.completed_steps).toContain('a');
    expect(final.completed_steps).toContain('b');
    expect(final.terminal_state).toBe(true);
  });
});
