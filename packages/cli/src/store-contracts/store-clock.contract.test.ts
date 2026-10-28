// The store-clock contract family (issue #715 (a), D6-36) on JsonFileStore, through the LOCATION route:
// each case opens a fresh store on a test location (`createTestLocation`), whose clock is the
// location's file. Lives here for the reason `json-file-store.contract.test.ts` gives: the CLI is
// the package that depends on both @sensigo/realm and @sensigo/realm-testing.
import { describe, expect, it } from 'vitest';
import { JsonFileStore } from '@sensigo/realm';
import { STORE_CLOCK_LAWS, storeClockContract, type StoreClockLaw } from '@sensigo/realm-testing';

/**
 * The laws of this family that THIS file deliberately does not run, each with its reason.
 */
const NOT_RUN: Partial<Record<StoreClockLaw, string>> = {
  READS_SPEND_NO_READING:
    'a location store’s clock is internal (resolved from the clock file at construction), so its readings cannot be counted from outside; core’s json-file-store-clock-715.test.ts counts them (cell B1, J11–J15)',
};

/** Every exported law, minus the ones named in NOT_RUN above. */
const LAWS: readonly StoreClockLaw[] = STORE_CLOCK_LAWS.filter((law) => !(law in NOT_RUN));

describe('#715 (a) C16 — the store-clock contract on JsonFileStore (location route)', () => {
  const cases = storeClockContract({
    storeName: 'JsonFileStore',
    route: { kind: 'location', makeStore: ({ location }) => new JsonFileStore(location.runsDir) },
  });
  for (const law of LAWS) {
    it(law, async () => {
      const target = cases.find((c) => c.law === law);
      expect(target, `no case registered for law ${law}`).toBeDefined();
      await target!.run();
    });
  }
});
