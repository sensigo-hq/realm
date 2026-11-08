// contract-settlement-616.test.ts — issue #616 PR-1a unit 16b: the published settlement contract
// (`settlementContract`, @sensigo/realm-testing) run against `SqliteRunStore`, every law: what
// `settleStep` and `stampSeal` write, what they refuse, and what they leave alone (issue #279, the
// laws of the seal boundary, the gate and drain families). The real case: the engine settles a step
// through whichever store it is given, and every store must settle it the same way.
//
// One fresh home per law, and a fresh one for each case that moves time: the `clock` route opens a
// home on the clock the case sets. `seedLegacyTerminal` writes a terminal run with no seal past the
// store's own boundary (unit 13a's channel) into the home the law's store is open on, so the
// `STAMP_*` laws drive a real stamp.
import type { RunRecord } from '@sensigo/realm';
import {
  defaultSettlementFixture,
  SETTLEMENT_LAWS,
  settlementContract,
  type SettlementLaw,
} from '@sensigo/realm-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ContractHomes } from './test-support/contract-homes.js';

/**
 * The laws this file does not run, each with its reason (issue #625). `ADAPTER_WIRING` has a case
 * only when the adapter is mis-wired (no `settlementFixture`), and this file supplies one.
 */
const NOT_RUN: Partial<Record<SettlementLaw, string>> = {
  ADAPTER_WIRING:
    'a wiring-gap sentinel: it has a case ONLY when the adapter is mis-wired (no settlementFixture), and this file supplies one — so it has no case here by design',
};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly SettlementLaw[] = SETTLEMENT_LAWS.filter((law) => !(law in NOT_RUN));

/** A run as an older Realm left it: finished, with no seal (`stampSeal` stamps it). */
const LEGACY_TERMINAL: Partial<RunRecord> = {
  completed_steps: ['a'],
  terminal_state: true,
  terminal_reason: 'Workflow completed.',
  run_phase: 'completed',
};

const homes = new ContractHomes();
afterEach(() => homes.dispose());

describe('#616 unit 16b — SqliteRunStore runs the settlement contract', () => {
  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const primary = await homes.open();
      const cases = settlementContract({
        store: primary.store,
        storeName: 'SqliteRunStore',
        settlementFixture: defaultSettlementFixture,
        route: {
          kind: 'clock',
          makeStore: async ({ clock }) => (await homes.open({ clock })).store,
        },
        seedLegacyTerminal: (id) => homes.seedLegacy(primary, id, LEGACY_TERMINAL),
      }).filter((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs, or when the
      //     store stops declaring `stampSeal` (the six `STAMP_*` laws then have no case); (2)
      //     prints the law.
      expect(cases.length, `no case registered for law ${law}`).toBeGreaterThan(0);
      // (1) red when the store breaks the law (each law's own break: see the contract; the
      //     shipped red-first records name one per family); (2) prints the contract's own
      //     sentence for the law that failed.
      for (const c of cases) await c.run();
    });
  }
});
