// callback-store-in-memory-a1.test.ts — R1.3 the callback, callback A1a: the published callback-store
// contract (`callbackStoreContract`) run against `InMemoryStore`'s callback store, every law it can
// run; the per-run artifact contract on `store.callbacks` (L1, L2, L5, L6: an in-memory store can
// neither fail nor declare a release line, so L3, L4 and `STORE_RELEASE_LINE_TRUE` run on SQLite's
// store, unit B); and the store's own cells (built with `callbacks: null` it keeps none).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it:
// (a) what turns it red, (b) what it prints then.
import { describe, expect, it } from 'vitest';
import { callbackRowOf } from '@sensigo/realm';
import { InMemoryCallbackStore, InMemoryStore } from './in-memory-store.js';
import {
  CALLBACK_STORE_LAWS,
  callbackStoreContract,
  type CallbackStoreContractAdapter,
  type CallbackStoreLaw,
} from './callback-store-contract.js';
import {
  ARTIFACT_STORE_LAWS,
  perRunArtifactStoreContract,
  type ArtifactStoreLaw,
} from './per-run-artifact-store-contract.js';

/** The callback laws this file does not run, each with its reason. None: the in-memory store runs every one. */
const NOT_RUN: Partial<Record<CallbackStoreLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly CallbackStoreLaw[] = CALLBACK_STORE_LAWS.filter((law) => !(law in NOT_RUN));

const ADAPTER: CallbackStoreContractAdapter = {
  storeName: 'InMemoryStore',
  makeStore: async ({ clock }) => ({ store: new InMemoryStore({ clock }) }),
  makeStoreWithoutPort: async ({ clock }) => ({
    store: new InMemoryStore({ clock, callbacks: null }),
  }),
};

describe('R1.3 callback A1a — InMemoryStore runs the callback-store contract', () => {
  const cases = callbackStoreContract(ADAPTER);
  it('the contract has one case per exported law, in order', () => {
    // (a) red when a law is exported without a case, or a case is registered under another law;
    //     (b) prints both lists.
    expect(cases.map((c) => c.law)).toEqual([...CALLBACK_STORE_LAWS]);
  });
  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const target = cases.find((c) => c.law === law);
      // (a) red when the contract stops registering a case for a law this file runs; (b) prints the
      //     law. The case itself throws, naming the law, the step and what the store returned.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
});

/** The per-run artifact laws an in-memory callback store cannot run, each with its reason. */
const ARTIFACT_NOT_RUN: Partial<Record<ArtifactStoreLaw, string>> = {
  L3_FAILURE_REJECTS:
    'an in-memory store cannot be made to fail (`injectFailure`): SQLite’s store runs it (B)',
  L4_TYPED_REJECTION:
    'an in-memory store cannot be made to fail (`injectFailure`): SQLite’s store runs it (B)',
  STORE_RELEASE_LINE_TRUE:
    'an in-memory store declares no release line: SQLite’s store runs it (B)',
};

const WITH = 'run-callback-artifact';
const ABSENT = 'run-callback-absent';

describe('R1.3 callback A1a — the per-run artifact contract on store.callbacks', () => {
  const callbacks = new InMemoryCallbackStore();
  const cases = perRunArtifactStoreContract({
    store: callbacks,
    runIdWithArtifact: WITH,
    runIdAbsent: ABSENT,
    injectFailure: () => {
      throw new Error('an in-memory callback store cannot be made to fail');
    },
    reseed: () => {
      callbacks.register(
        callbackRowOf(
          WITH,
          'wf-callback-artifact',
          {
            url: 'https://hooks.example/callback/artifact',
            host: 'hooks.example:443',
            webhook_id: '00000000-0000-4000-8000-0000000000aa',
          },
          new Date('2026-01-01T00:00:00.000Z'),
        ),
      );
    },
  });
  for (const law of ARTIFACT_STORE_LAWS.filter((l) => !(l in ARTIFACT_NOT_RUN))) {
    it(`conforms to ${law}`, async () => {
      const target = cases.find((c) => c.law === law);
      // (a) red when the purge pair breaks a per-run artifact law; (b) prints the law's own failure.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
});

describe('R1.3 callback A1a — InMemoryStore’s own callback store', () => {
  it('keeps one by default, and none when built with callbacks: null', () => {
    // (a) red when the default store has no callback store, or `callbacks: null` still builds one;
    //     (b) prints what each store holds.
    expect({
      byDefault: new InMemoryStore().callbacks instanceof InMemoryCallbackStore,
      withNull: new InMemoryStore({ callbacks: null }).callbacks,
    }).toEqual({ byDefault: true, withNull: null });
  });

  it('a run created without a callback has no row, and the store writes nothing to the run', async () => {
    const store = new InMemoryStore();
    const { record } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    const withRow = await store.create({
      workflowId: 'wf',
      workflowVersion: 1,
      params: {},
      callback: {
        url: 'https://hooks.example/callback/own',
        host: 'hooks.example:443',
        webhook_id: '00000000-0000-4000-8000-0000000000bb',
      },
    });
    // (a) red when a create without a callback writes a row, or a callback lands on the run record;
    //     (b) prints the two reads and the record's keys.
    expect({
      without: await store.callbacks!.read(record.id),
      recordKeys: Object.keys((await store.get(withRow.record.id)).record).includes('callback'),
    }).toEqual({ without: undefined, recordKeys: false });
  });
});
