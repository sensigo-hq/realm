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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '@sensigo/realm';
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
];

describe('JsonFileStore — settlement TCK conformance (issue #279, increment 1, PR-A)', () => {
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
