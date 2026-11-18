// take-back-in-memory-cw3b.test.ts — issue #729, the claim window, unit CW-3b: the published take-back
// contract (`takeBackContract`) run against `InMemoryStore` given the lease double as its lease port
// (`new InMemoryStore({ leases })`), every law.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { describe, expect, it } from 'vitest';
import { InMemoryStore } from './in-memory-store.js';
import { createLeaseDouble } from './lease-double.js';
import {
  TAKE_BACK_LAWS,
  takeBackContract,
  type TakeBackContractAdapter,
  type TakeBackLaw,
} from './take-back-contract.js';

/** The laws this file does not run, each with its reason. None: the double answers every one. */
const NOT_RUN: Partial<Record<TakeBackLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly TakeBackLaw[] = TAKE_BACK_LAWS.filter((law) => !(law in NOT_RUN));

const ADAPTER: TakeBackContractAdapter = {
  storeName: 'InMemoryStore with the lease double',
  makeStore: async () => {
    const leases = createLeaseDouble();
    return { store: new InMemoryStore({ leases }), leases, dispose: async () => {} };
  },
};

describe('#729 CW-3b — InMemoryStore with the lease double runs the take-back contract', () => {
  it('runs every law: NOT_RUN is empty', () => {
    // (1) red when a law is put in NOT_RUN (it then never runs here); (2) prints the laws named there.
    expect(NOT_RUN).toEqual({});
  });

  const cases = takeBackContract(ADAPTER);
  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const target = cases.find((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs; (2) prints the
      //     law. The case itself throws, naming the law and what the take-back did, when it fails.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
});
