// lease-port-double.test.ts — issue #729, the claim window, unit CW-1: the lease-port contract run
// against the lease double (`createLeaseDouble()`, holder kind `simulated`). The double holds no lock
// and opens no file, so it runs only the laws whose answer it computes from its states — L1, L2, L3 and
// L5 — and names every other law below with its reason. The real locks run every law in store-sqlite's
// `contract-leases-cw1.test.ts`.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { describe, expect, it } from 'vitest';
import type { LeaseHold } from '@sensigo/realm';
import { createLeaseDouble } from './lease-double.js';
import {
  LEASE_PORT_LAWS,
  leasePortContract,
  type LeaseHolder,
  type LeasePortLaw,
  type LeaseTestHome,
} from './lease-port-contract.js';

/** The laws this file does not run, each with its reason. */
const NOT_RUN: Partial<Record<LeasePortLaw, string>> = {
  L4_MISSING_ID_ABSENT_NOTHING_CREATED:
    'the double makes no file, so "nothing created" has nothing to check; its answer for an id it never made is set by its own rule',
  L4B_NOT_A_LEASE_UNKNOWN: 'the double has no file at a lease’s name to be anything else',
  L4C_UNWRITABLE_NEVER_NOT_HELD: 'the double has no file whose mode can deny a write',
  L4D_MODES_AND_CONTENTS: 'the double has no file and no folder with a mode',
  LGC_UNREFERENCED_HOLD_STAYS_HELD:
    'the double’s leases are not tied to a resource the garbage collector frees',
  LSELF_OWN_ID_OPENS_NOTHING:
    'the double opens nothing, so there is no file to delete under a hold',
};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly LeasePortLaw[] = LEASE_PORT_LAWS.filter((law) => !(law in NOT_RUN));

/** A home is one double; a holder is this process holding leases in it; its kill marks them dead. */
function makeHome(): Promise<LeaseTestHome> {
  const double = createLeaseDouble();
  return Promise.resolve({
    port: double,
    spawnHolder: async ({ count = 1 } = {}): Promise<LeaseHolder> => {
      const holds: LeaseHold[] = [];
      for (let i = 0; i < count; i += 1) {
        const result = await double.hold();
        if (!('held' in result)) throw new Error(`the double made no lease: ${result.unavailable}`);
        holds.push(result.held);
      }
      return {
        pid: process.pid,
        ids: holds.map((h) => h.id),
        close: async (index, newestRecord) => holds[index]!.close(newestRecord),
        selfProbe: (id) => double.probe(id),
        dropAndCollect: async () => undefined,
        kill: async () => {
          for (const h of holds) if (double.state(h.id) === 'live') double.set(h.id, 'dead');
          return { signal: 'SIGKILL' };
        },
      };
    },
    dispose: async () => undefined,
  });
}

describe('#729 CW-1 — the lease double runs the lease-port laws it can answer', () => {
  it('names exactly the laws that need a real lock or a file, each with its reason', () => {
    // (1) red when a law the double can answer is put in NOT_RUN, or one it cannot is taken out
    //     (it would then run, and fail); (2) prints the laws it runs.
    expect(LAWS).toEqual([
      'L1_HELD_ACROSS_PROCESSES',
      'L2_NOT_HELD_AFTER_DEATH',
      'L3_DEAD_LEASE_NEVER_HELD_AGAIN',
      'L5_CLOSE_BY_RECORD',
    ]);
  });

  it('reads each state as the testing page says: live held, closed_kept and dead not_held, removed and an id it never made absent, forced the fact given', async () => {
    const double = createLeaseDouble();
    double.set('a', 'live');
    double.set('b', 'closed_kept');
    double.set('c', 'dead');
    double.set('d', 'removed');
    double.set('e', { forced: { state: 'unknown', basis: 'kernel_lock', reason: 'permission' } });
    const read = async (id: string): Promise<string> => {
      const fact = await double.probe(id);
      return fact.state === 'unknown' ? `unknown(${fact.reason})` : fact.state;
    };
    // (1) red when a state reads otherwise than testing-package.md's `createLeaseDouble()` paragraph
    //     says; (2) prints each state's answer.
    expect({
      live: await read('a'),
      closed_kept: await read('b'),
      dead: await read('c'),
      removed: await read('d'),
      forced: await read('e'),
      never_made: await read('never-made'),
    }).toEqual({
      live: 'held',
      closed_kept: 'not_held',
      dead: 'not_held',
      removed: 'absent',
      forced: 'unknown(permission)',
      never_made: 'absent',
    });
  });

  const cases = leasePortContract({
    storeName: 'createLeaseDouble()',
    holderKind: 'simulated',
    makeHome,
  });
  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const target = cases.find((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs; (2) prints the law.
      expect(target, `no case registered for law ${law}`).toBeDefined();
      // (1) red when the double's states give another answer than the law's (a dead lease read as
      //     held, a close by record that deletes or keeps the wrong file, an id handed out twice);
      //     (2) prints the contract's own sentence.
      await target!.run();
    });
  }
});
