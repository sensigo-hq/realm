// settlement-json-file-store.test.ts — settlement-law TCK conformance for JsonFileStore (issue
// #279, increment 1, PR-A).
//
// Wiring note (divergence from the issue #183/#188 precedent — see settlement-contract.ts's own
// header for the full rationale): those contracts' JsonFileStore conformance tests live in
// @sensigo/realm-cli because packages/core (@sensigo/realm) cannot depend on
// @sensigo/realm-testing without creating a circular PACKAGE dependency. That constraint is about
// CORE's test suite, not this one — @sensigo/realm-testing already depends on @sensigo/realm (see
// in-memory-store.ts's own imports), and JsonFileStore is exported directly from @sensigo/realm's
// core index, so wiring it here creates no new, let alone circular, dependency. This file and its
// InMemoryStore sibling therefore live together in this package, per the hand-off prompt's D4.
import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '@sensigo/realm';
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

describe('JsonFileStore — settlement TCK conformance (issue #279, increment 1 + 2)', () => {
  it('declares settleStep and the two new LoadBearingRunRecordFields (settled/finalizer_ledger)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'json-file-store-settlement-tck-'));
    try {
      const store = new JsonFileStore(dir);
      expect(store.settleStep).toBeDefined();
      expect(store.persistedRunRecordFields?.has('settled')).toBe(true);
      expect(store.persistedRunRecordFields?.has('finalizer_ledger')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'json-file-store-settlement-tck-'));
      try {
        const store = new JsonFileStore(dir);
        const cases = settlementContract({
          store,
          storeName: 'JsonFileStore',
          settlementFixture: defaultSettlementFixture,
          // issue #367 (part 3): the sanctioned channel for seeding a pre-#367 shape past the
          // store's own boundary — a direct file write. The stamp laws' SUCCESS legs need a
          // record the boundary would refuse if it were written through it.
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
            await writeFile(join(dir, `${id}.json`), JSON.stringify(legacy, null, 2));
            return legacy;
          },
        });
        const matching = cases.filter((c) => c.law === law);
        expect(matching.length).toBeGreaterThan(0);
        for (const c of matching) {
          await c.run();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('JsonFileStore settlement wiring — the run list is derived from the contract', () => {
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
