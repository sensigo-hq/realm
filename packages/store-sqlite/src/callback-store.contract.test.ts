// callback-store.contract.test.ts — callback B1a (R1.3): the SQLite signing keys
// (`SqliteCallbackKeys`, a home's `runStore.keys`) held to the published callback-store laws on a
// real file, with a test sealer.
//
// The rows store is callback B1b's, so the home has no `callbacks` port yet. A TEST FAÇADE stands in
// for it: a `RunStore` over the real home whose `callbacks` is `{ keys }`, built only here. Every
// `CBK_*` law reads only `keys`, the readings and the clock, so each runs on the real class. The
// rows laws (`CB_*`) and `CBK_KEYS_APART`, which needs a run's callback row, are named in `NOT_RUN`;
// B1b replaces the façade with the real home and runs them all.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it:
// (1) what turns it red, (2) what it prints then.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallbackStore, RunStore } from '@sensigo/realm';
import {
  CALLBACK_STORE_LAWS,
  callbackStoreContract,
  type CallbackStoreContractAdapter,
  type CallbackStoreLaw,
} from '@sensigo/realm-testing';
import { describe, expect, it } from 'vitest';
import { openHome } from './open-realm-home.js';
import type { SqliteRunStore } from './run-store.js';
import { makeUnreadable, plantRun, testSealer } from './test-support/callbacks.js';

/** The laws this file does not run, each with its reason. */
const NOT_RUN: Partial<Record<CallbackStoreLaw, string>> = {
  ...Object.fromEntries(
    CALLBACK_STORE_LAWS.filter((law) => law.startsWith('CB_')).map((law) => [law, 'rows: B1b']),
  ),
  CBK_KEYS_APART: "it needs a run's callback row: B1b",
};

/** Every exported law but those named above: a key law added to the family runs here untouched. */
const LAWS: readonly CallbackStoreLaw[] = CALLBACK_STORE_LAWS.filter((law) => !(law in NOT_RUN));

/**
 * The façade: the run store as it is, but for `callbacks`, which holds only its keys. Every other
 * member is the run store's own, called on the run store itself.
 */
function withKeys(store: SqliteRunStore): RunStore {
  const callbacks = { keys: store.keys } as unknown as CallbackStore;
  return new Proxy(store, {
    get(target, property) {
      if (property === 'callbacks') return callbacks;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as RunStore;
}

/** The home of each façade a case built, for `makeUnreadable`. */
const homes = new WeakMap<RunStore, string>();

const ADAPTER: CallbackStoreContractAdapter = {
  storeName: 'SqliteCallbackKeys',
  makeStore: async ({ clock }) => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-b1a-keys-'));
    const home = join(dir, '.realm');
    const handle = await openHome({ home, clock, sealer: testSealer() }, {});
    const store = withKeys(handle.runStore);
    homes.set(store, home);
    return {
      store,
      seedRun: (record) => plantRun(home, record),
      dispose: async () => {
        handle.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
  makeUnreadable: async (store, workflowId, host, slot, masterFp) => {
    const home = homes.get(store);
    if (home === undefined) throw new Error('makeUnreadable: a store this adapter did not build');
    await makeUnreadable(home, workflowId, host, slot, masterFp);
  },
};

describe('callback B1a — the SQLite signing keys run the callback-store contract', () => {
  const cases = callbackStoreContract(ADAPTER);
  it('the contract has one case per exported law, in order', () => {
    // (1) red when a law is exported without a case, or a case is registered under another law;
    //     (2) prints both lists.
    expect(cases.map((c) => c.law)).toEqual([...CALLBACK_STORE_LAWS]);
  });
  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const target = cases.find((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs; (2) prints the
      //     law. The case itself throws, naming the law, the step and what the store returned.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
  it('every exported law is run or named in NOT_RUN with a reason, and NOT_RUN names only exported laws', () => {
    const all: readonly string[] = CALLBACK_STORE_LAWS;
    const named = Object.keys(NOT_RUN);
    // (1) red when a law is dropped from the run list without a reason, or NOT_RUN names a law the
    //     contract no longer exports; (2) prints the unaccounted or unknown laws.
    expect(named.filter((name) => !all.includes(name))).toEqual([]);
    expect([...LAWS, ...named].sort()).toEqual([...all].sort());
    for (const reason of Object.values(NOT_RUN)) expect(reason).not.toBe('');
    // (1) red when a key law slips into NOT_RUN beside CBK_KEYS_APART; (2) prints the run list.
    expect(LAWS.filter((law) => law.startsWith('CBK_'))).toHaveLength(9);
  });
});
