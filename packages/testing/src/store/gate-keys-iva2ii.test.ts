// gate-keys-iva2ii.test.ts — gap 2, unit (iv-a2-ii), check 9: the settlement contract's case in L11
// TRANSFORM_FIDELITY, "opening a gate keeps every key of the gate it was given". It runs for a store
// that declares `'pending_gate'` (`InMemoryStore` here; the SQLite store in its own package), is
// registered as skipped, by name, for one that does not, and fails against a declaring store that
// drops a gate key it does not know. Every assertion carries (a) the break that turns it red and (b)
// what it prints.
import { describe, it, expect } from 'vitest';
import type { LoadBearingRunRecordField, PendingGate } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import {
  settlementContract,
  defaultSettlementFixture,
  type SettlementContractCase,
} from './settlement-contract.js';

/** The case under test, for `store`. */
function gateKeysCase(store: InMemoryStore): SettlementContractCase[] {
  return settlementContract({
    store,
    storeName: 'TestStore',
    settlementFixture: defaultSettlementFixture,
    route: { kind: 'clock', makeStore: ({ clock }) => new InMemoryStore({ clock }) },
  }).filter((c) => c.law === 'TRANSFORM_FIDELITY' && c.name.includes('keeps every key'));
}

/** `store` with its declared fields set to `fields` (undefined: it declares nothing). */
function declaring<T extends InMemoryStore>(
  store: T,
  fields: LoadBearingRunRecordField[] | undefined,
): T {
  Object.defineProperty(store, 'persistedRunRecordFields', {
    value: fields === undefined ? undefined : new Set(fields),
  });
  return store;
}

/** A store that declares `'pending_gate'` but rebuilds a stored gate from the keys it knows. */
class DropsUnknownGateKeys extends InMemoryStore {
  override async get(...args: Parameters<InMemoryStore['get']>): ReturnType<InMemoryStore['get']> {
    const snap = await super.get(...args);
    const gate = snap.record.pending_gate;
    if (gate === undefined) return snap;
    const { tck_unknown_key: _dropped, ...known } = gate as unknown as Record<string, unknown>;
    return {
      ...snap,
      record: { ...snap.record, pending_gate: known as unknown as PendingGate },
    } as Awaited<ReturnType<InMemoryStore['get']>>;
  }
}

describe("gap 2 (iv-a2-ii), check 9 — opening a gate keeps every key, on a store that declares 'pending_gate'", () => {
  it('InMemoryStore: the case is registered, not skipped, and passes', async () => {
    const cases = gateKeysCase(new InMemoryStore());
    // (a) red when the case is not registered, is skipped for a declaring store, or the in-memory
    //     store drops a gate key; (b) prints the cases' names and skip flags.
    expect(cases.map((c) => ({ name: c.name, skipped: c.skipped }))).toEqual([
      {
        name: '[TestStore] opening a gate keeps every key of the gate it was given, its twin and a key Realm does not know included — returned and re-read',
        skipped: undefined,
      },
    ]);
    await cases[0]!.run();
  });

  it("a store that does not declare 'pending_gate': the case is skipped, by name", () => {
    const declared = [...(new InMemoryStore().persistedRunRecordFields ?? [])].filter(
      (f) => f !== 'pending_gate',
    );
    const cases = [
      ...gateKeysCase(declaring(new InMemoryStore(), declared)),
      ...gateKeysCase(declaring(new InMemoryStore(), undefined)),
    ];
    // (a) red when the case runs for a store that does not declare the field, or its name does not
    //     say why it is skipped; (b) prints the names and flags.
    expect(cases.map((c) => ({ name: c.name, skipped: c.skipped }))).toEqual(
      [0, 1].map(() => ({
        name: "SKIPPED — store does not declare 'pending_gate' in persistedRunRecordFields: [TestStore] opening a gate keeps every key of the gate it was given, its twin and a key Realm does not know included — returned and re-read",
        skipped: true,
      })),
    );
  });

  it('a declaring store that drops a gate key it does not know: the case fails, naming the key', async () => {
    const [c] = gateKeysCase(new DropsUnknownGateKeys() as unknown as InMemoryStore);
    // (a) red when the case compares only the keys this Realm knows, or only the returned gate (the
    //     re-read's loss passes); (b) prints the case's message.
    await expect(c!.run()).rejects.toThrow(
      "a store declaring 'pending_gate' must keep every key of the gate it opened (gap 2, unit (iv-a2-ii)): the re-read gate's 'tck_unknown_key' is absent, it was given {\"kept\":true}",
    );
  });
});
