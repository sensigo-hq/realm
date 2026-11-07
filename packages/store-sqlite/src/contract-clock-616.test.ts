// contract-clock-616.test.ts — issue #616 PR-1a unit 16b: the published store-clock contract
// (`storeClockContract`, @sensigo/realm-testing) run against `SqliteRunStore`, every law, on the
// `clock` route: the contract hands each case a clock it counts and sets, the route opens a fresh
// home on it, and the laws judge how many readings each verb takes and what instants it stamps (#715).
//
// `seedLegacyTerminal` is the store's own channel past its seal boundary (unit 13a's: a second
// connection and `insertRunRecord`), so `READS_ONE_READING` can drive a REAL `stampSeal`.
// `recordsDeletionTime` is true: `deleteAllForRun` stamps the time of the deletion into the run's
// tombstone, so it takes one reading (unit 14); the cell below shows the law refuses the wiring
// without the flag.
import type { RunRecord } from '@sensigo/realm';
import { STORE_CLOCK_LAWS, storeClockContract, type StoreClockLaw } from '@sensigo/realm-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ContractHomes } from './test-support/contract-homes.js';

/** The laws this file does not run, each with its reason. None: the `clock` route runs all twelve. */
const NOT_RUN: Partial<Record<StoreClockLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly StoreClockLaw[] = STORE_CLOCK_LAWS.filter((law) => !(law in NOT_RUN));

/** A run as an older Realm left it: finished, with no seal (`stampSeal` stamps it). */
const LEGACY_TERMINAL: Partial<RunRecord> = {
  completed_steps: ['a'],
  terminal_state: true,
  terminal_reason: 'Workflow completed.',
  run_phase: 'completed',
};

const homes = new ContractHomes();
afterEach(() => homes.dispose());

/** The adapter of this wiring; `recordsDeletionTime` is left out for the cell that shows why it is set. */
function adapter(recordsDeletionTime: boolean): Parameters<typeof storeClockContract>[0] {
  return {
    storeName: 'SqliteRunStore',
    route: {
      kind: 'clock',
      makeStore: async ({ clock }) => (await homes.open({ clock })).store,
    },
    seedLegacyTerminal: (id) => homes.seedLegacy(homes.last!, id, LEGACY_TERMINAL),
    ...(recordsDeletionTime ? { recordsDeletionTime: true } : {}),
  };
}

describe('#616 unit 16b — SqliteRunStore runs the store-clock contract (clock route)', () => {
  const cases = storeClockContract(adapter(true));
  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const target = cases.find((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs; (2) prints
      //     the law.
      expect(target, `no case registered for law ${law}`).toBeDefined();
      // (1) red when the store breaks the law (a verb that takes two readings, a stamp that
      //     ignores the floor, a read that mints an instant, ...); (2) prints the contract's own
      //     sentence: the verb, the readings it took and the readings the law allows.
      await target!.run();
    });
  }

  it('without `recordsDeletionTime` the law refuses the wiring: the delete takes one reading', async () => {
    const target = storeClockContract(adapter(false)).find((c) => c.law === 'READS_ONE_READING');
    // (1) red when `deleteAllForRun` stops stamping the deletion from a reading (it then takes
    //     none and the law, with the flag unset, passes: this cell goes red, and so must the
    //     flag of the cells above); (2) prints the contract's sentence for the clause.
    await expect(target!.run()).rejects.toThrow(
      /deleteAllForRun spent 1 readings, not 0: the adapter does not set recordsDeletionTime/,
    );
  });
});
