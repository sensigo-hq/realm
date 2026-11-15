// leased-claim-in-memory-cw2a.test.ts — issue #729, the claim window, unit CW-2a: the published
// leased-claim contract (`leasedClaimContract`) run against `InMemoryStore` given the lease double as its
// lease port (`new InMemoryStore({ leases })`), every law.
//
// The second describe holds the store's own cell: built without a port, it keeps no leases, so a hold
// passed to it is ignored, as `JsonFileStore` ignores one (Realm never passes one to such a store).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { describe, expect, it } from 'vitest';
import type { LeaseHold } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { createLeaseDouble } from './lease-double.js';
import {
  LEASED_CLAIM_LAWS,
  leasedClaimContract,
  type LeasedClaimContractAdapter,
  type LeasedClaimLaw,
} from './leased-claim-contract.js';

/** The laws this file does not run, each with its reason. None: the double answers every one. */
const NOT_RUN: Partial<Record<LeasedClaimLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly LeasedClaimLaw[] = LEASED_CLAIM_LAWS.filter((law) => !(law in NOT_RUN));

const ADAPTER: LeasedClaimContractAdapter = {
  storeName: 'InMemoryStore with the lease double',
  makeStore: async () => ({
    store: new InMemoryStore({ leases: createLeaseDouble() }),
    dispose: async () => {},
  }),
};

describe('#729 CW-2a — InMemoryStore with the lease double runs the leased-claim contract', () => {
  it('runs every law: NOT_RUN is empty', () => {
    // (1) red when a law is put in NOT_RUN (it then never runs here); (2) prints the laws named there.
    expect(NOT_RUN).toEqual({});
  });

  const cases = leasedClaimContract(ADAPTER);
  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const target = cases.find((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs; (2) prints the
      //     law. The case itself throws, naming the law and what the store did, when it fails.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
});

describe('#729 CW-2a — InMemoryStore without a lease port', () => {
  it('ignores a hold: the claim names no lease, and the same hold can be passed again', async () => {
    const store = new InMemoryStore();
    const { record } = await store.create({ workflowId: 'w', workflowVersion: 1, params: {} });
    const def = {
      id: 'w',
      name: 'w',
      version: 1,
      steps: {
        a: { description: 'a', execution: 'agent' as const, depends_on: [] },
        b: { description: 'b', execution: 'agent' as const, depends_on: [] },
      },
    };
    const { held: hold } = (await createLeaseDouble().hold()) as { held: LeaseHold };
    const first = await store.claimStep(record.id, 'a', def, undefined, hold);
    const second = await store.claimStep(record.id, 'b', def, undefined, hold);
    // (1) red when a store without leases writes the lease or spends the hold (the second call then
    //     throws); (2) prints whether each claim names a lease, and the steps in progress.
    expect({
      leased: [first.record.claims?.['a']?.lease, second.record.claims?.['b']?.lease],
      inProgress: second.record.in_progress_steps,
    }).toEqual({ leased: [undefined, undefined], inProgress: ['a', 'b'] });
  });
});
