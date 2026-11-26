// gate-keys-iva2ii.test.ts — gap 2, unit (iv-a2-ii), check 9: `SqliteRunStore` declares
// `'pending_gate'`, so the settlement contract's case "opening a gate keeps every key of the gate it
// was given" runs against it (not skipped), and passes: the record is one JSON document, so the
// question's twin and a gate key this Realm does not know both come back. (a) red when the store stops
// declaring the field (the case is then skipped) or drops a gate key; (b) prints the case's name and
// flag.
import { defaultSettlementFixture, settlementContract } from '@sensigo/realm-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ContractHomes } from './test-support/contract-homes.js';

const homes = new ContractHomes();
afterEach(() => homes.dispose());

describe('gap 2 (iv-a2-ii), check 9 — SqliteRunStore keeps every key of a gate it opens', () => {
  it('the case runs, not skipped, and passes', async () => {
    const primary = await homes.open();
    const cases = settlementContract({
      store: primary.store,
      storeName: 'SqliteRunStore',
      settlementFixture: defaultSettlementFixture,
      route: {
        kind: 'clock',
        makeStore: async ({ clock }) => (await homes.open({ clock })).store,
      },
    }).filter((c) => c.law === 'TRANSFORM_FIDELITY' && c.name.includes('keeps every key'));
    expect(cases.map((c) => ({ name: c.name, skipped: c.skipped }))).toEqual([
      {
        name: '[SqliteRunStore] opening a gate keeps every key of the gate it was given, its twin and a key Realm does not know included — returned and re-read',
        skipped: undefined,
      },
    ]);
    await cases[0]!.run();
  });
});
