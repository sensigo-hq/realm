// settlement-in-memory-store.test.ts — settlement-law TCK conformance for InMemoryStore (issue
// #279, increment 1, PR-A). See settlement-json-file-store.test.ts's own header for why both
// stores' settlement conformance lives here rather than @sensigo/realm-cli (the #183/#188
// precedent location) — that constraint doesn't apply to this package.
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from './in-memory-store.js';
import {
  settlementContract,
  defaultSettlementFixture,
  SETTLEMENT_LAWS,
  type SettlementLaw,
} from './settlement-contract.js';

/**
 * The laws of this contract that THIS file deliberately does not run, each with its reason
 * (issue #625). Before this list existed, this file kept its own hand-written array of laws and a
 * law added to the contract ran here only if somebody remembered to add it.
 */
const NOT_RUN: Partial<Record<SettlementLaw, string>> = {
  ADAPTER_WIRING:
    'a wiring-gap sentinel: it has a case ONLY when the adapter is mis-wired (no settlementFixture), and this file supplies one — so it has no case here by design',
};

/** The laws this file runs: every exported law, minus the ones named in NOT_RUN above. */
const LAWS: readonly SettlementLaw[] = SETTLEMENT_LAWS.filter((law) => !(law in NOT_RUN));

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
        // issue #367 (part 3): this store's own sanctioned channel — a direct map insert, which
        // is the in-memory equivalent of writing the file behind the boundary's back.
        seedLegacyTerminal: async (id) => {
          const { run } = await store.create({
            workflowId: `tck-seed-${id}`,
            workflowVersion: 1,
            params: {},
          });
          const legacy = {
            ...run,
            id,
            completed_steps: ['a'],
            terminal_state: true,
            terminal_reason: 'Workflow completed.',
            run_phase: 'completed' as const,
          };
          (store as unknown as { runs: Map<string, typeof legacy> }).runs.set(id, legacy);
          return legacy;
        },
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

describe('InMemoryStore settlement wiring — the run list is derived from the contract', () => {
  // (a) red when a law is dropped from the run list WITHOUT being named in NOT_RUN, or NOT_RUN
  //     names a law the contract no longer exports; (b) prints the unaccounted / unknown laws.
  it('every exported law is either run or named in NOT_RUN, and NOT_RUN names only exported laws (issue #625)', () => {
    const exported: readonly string[] = SETTLEMENT_LAWS;
    const named = Object.keys(NOT_RUN);
    expect(named.filter((law) => !exported.includes(law))).toEqual([]);
    expect([...LAWS, ...named].sort()).toEqual([...exported].sort());
    for (const reason of Object.values(NOT_RUN)) expect(reason).not.toBe('');
  });
});
