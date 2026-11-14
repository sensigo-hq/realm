// lease-facts-in-memory-cw1b.test.ts — issue #729, the claim window, unit CW-1b part 1: the published
// lease-facts contract (`leaseFactsContract`) run against `InMemoryStore` given the lease double as its
// lease port (`new InMemoryStore({ leases })`), every law. The held lease is one the double is told is
// `live`; the store's port is the double behind a wrapper that lists every id it is asked about.
//
// The second describe holds the store's own cells: built without a port it keeps none, and takes the
// path it took before CW-1b.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { describe, expect, it } from 'vitest';
import type { LeasePort } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { createLeaseDouble } from './lease-double.js';
import {
  LEASE_FACTS_LAWS,
  leaseFactsContract,
  type LeaseFactsContractAdapter,
  type LeaseFactsLaw,
} from './lease-facts-contract.js';

/** The laws this file does not run, each with its reason. None: the double answers every one. */
const NOT_RUN: Partial<Record<LeaseFactsLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly LeaseFactsLaw[] = LEASE_FACTS_LAWS.filter((law) => !(law in NOT_RUN));

const ADAPTER: LeaseFactsContractAdapter = {
  storeName: 'InMemoryStore with the lease double',
  makeStore: async () => {
    const double = createLeaseDouble();
    const probed: string[] = [];
    const leases: LeasePort = {
      hold: () => double.hold(),
      probe: (id) => {
        probed.push(id);
        return double.probe(id);
      },
    };
    return {
      store: new InMemoryStore({ leases }),
      heldLease: async () => {
        double.set('lease-facts-held', 'live');
        return 'lease-facts-held';
      },
      probed: () => probed,
      dispose: async () => {},
    };
  },
};

describe('#729 CW-1b — InMemoryStore with the lease double runs the lease-facts contract', () => {
  it('runs every law: NOT_RUN is empty', () => {
    // (1) red when a law is put in NOT_RUN (it then never runs here); (2) prints the laws named there.
    expect(NOT_RUN).toEqual({});
  });

  const cases = leaseFactsContract(ADAPTER);
  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const target = cases.find((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs; (2) prints the
      //     law. The case itself throws, naming the law and what the store returned, when it fails.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
});

describe('#729 CW-1b — InMemoryStore without a lease port', () => {
  it('keeps no claim leases: leases is unset, and a leased claim it holds reads no facts', async () => {
    const store = new InMemoryStore();
    const { record } = await store.create({ workflowId: 'w', workflowVersion: 1, params: {} });
    const written = await store.update({
      ...record,
      in_progress_steps: ['a'],
      claims: { a: { deadline: null, lease: { id: 'lease-1' } } },
    });
    const read = await store.get(record.id);
    // (1) red when a store built without a port gets one, or its results carry lease_facts; (2) prints
    //     the property and the keys of what update and get returned.
    expect({
      leases: store.leases,
      written: Object.keys(written),
      read: Object.keys(read),
    }).toEqual({
      leases: undefined,
      written: ['record', 'at'],
      read: ['record', 'at'],
    });
  });
});
