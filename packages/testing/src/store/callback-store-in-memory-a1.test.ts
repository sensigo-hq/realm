// callback-store-in-memory-a1.test.ts — R1.3 the callback, callback A1a and A1b: the published callback-store
// contract (`callbackStoreContract`) run against `InMemoryStore`'s callback store, every law it can run, and the
// store's own cells (built with `callbacks: null` it keeps none). The per-run artifact contract runs on
// SQLite's callbacks in B, every law; in memory CB_PURGE_PAIR pins the purge pair (a store with no
// release line cannot run STORE_RELEASE_LINE_TRUE).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it:
// (a) what turns it red, (b) what it prints then.
import { describe, expect, it } from 'vitest';
import {
  callbackKeyFingerprint,
  callbackPreviousIsLive,
  decideCallbackKeyRotate,
  type CallbackKeySlot,
} from '@sensigo/realm';
import { InMemoryCallbackStore, InMemoryStore } from './in-memory-store.js';
import {
  CALLBACK_STORE_LAWS,
  callbackStoreContract,
  type CallbackStoreContractAdapter,
  type CallbackStoreLaw,
} from './callback-store-contract.js';

/** The callback laws this file does not run, each with its reason. */
const NOT_RUN: Partial<Record<CallbackStoreLaw, string>> = {
  CB_DUE_RUN_GONE:
    'the in-memory store cannot remove a run (it has no purge): SQLite’s store runs it (B)',
};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly CallbackStoreLaw[] = CALLBACK_STORE_LAWS.filter((law) => !(law in NOT_RUN));

const ADAPTER: CallbackStoreContractAdapter = {
  storeName: 'InMemoryStore',
  makeStore: async ({ clock }) => {
    const store = new InMemoryStore({ clock });
    return { store, seedRun: async (record) => store.seed(record) };
  },
  makeStoreWithoutPort: async ({ clock }) => ({
    store: new InMemoryStore({ clock, callbacks: null }),
  }),
  makeUnreadable: async (store, workflowId, host, slot, masterFp) =>
    (store as InMemoryStore).callbacks!.keys.makeUnreadable(workflowId, host, slot, masterFp),
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

describe('R1.3 callback A2 — the key fingerprint and a previous with no end', () => {
  it('a key’s fingerprint is the first 8 lowercase hex characters of SHA-256 of its text', () => {
    // Computed apart, both ways, for 64 × `a`: node:crypto and `printf %s <text> | sha256sum`.
    // (a) red when the fingerprint hashes other bytes, takes other characters or another length;
    //     (b) prints the fingerprint, its length and whether it is lowercase.
    const fp = callbackKeyFingerprint('a'.repeat(64));
    expect({ fp, length: fp.length, lowercase: fp === fp.toLowerCase() }).toEqual({
      fp: 'ffe054fe',
      length: 8,
      lowercase: true,
    });
  });

  it('a previous without expires_at is never live, so a rotate drops it without the flag', () => {
    // The port never writes such a slot (rotate always sets `expires_at`), so no contract case can
    // build one: this pins the liveness function and a decider directly.
    const at = new Date('2026-01-01T00:00:00.000Z');
    const current: CallbackKeySlot = {
      slot: 'current',
      state: 'readable',
      key: '1'.repeat(64),
      key_fp: callbackKeyFingerprint('1'.repeat(64)),
      created_at: '2025-12-31T00:00:00.000Z',
    };
    const endless: CallbackKeySlot = {
      slot: 'previous',
      state: 'readable',
      key: '2'.repeat(64),
      key_fp: callbackKeyFingerprint('2'.repeat(64)),
      created_at: '2025-12-30T00:00:00.000Z',
    };
    // (a) red when a previous with no `expires_at` counts as live: the liveness answers true and the
    //     rotate answers previous_live; (b) prints both answers.
    expect({
      live: callbackPreviousIsLive(endless, at),
      rotate: decideCallbackKeyRotate(
        { current, previous: endless },
        { candidate: '3'.repeat(64), keepSeconds: 60 },
        at,
      ).result.applied,
    }).toEqual({ live: false, rotate: true });
  });
});
