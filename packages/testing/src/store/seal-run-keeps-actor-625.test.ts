// seal-run-keeps-actor-625.test.ts — #625 PR-2b, the actor unit: the store-kit law
// SEAL_RUN_KEEPS_ACTOR, held against stores that break it.
//
// Who ended a run is written inside `sealed_by` by a `seal_run` change (`by`, the program; `door`,
// the command or tool). A store that keeps a column per member, or copies a known shape, can drop
// either, or write `null` where the change carried none — and every screen would then say who ended
// a run wrongly or not at all. The law makes keeping both, byte for byte, a promise. Each cell here
// runs the law's two cases against one broken double and requires the case that sees the break to
// fail, and the in-repo store to pass both. Every assertion carries (a) the change that turns it
// red and (b) what it prints.
import { describe, it, expect } from 'vitest';
import type {
  RunRecord,
  SettlementDelta,
  StoreSettlement,
  WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { settlementContract, defaultSettlementFixture } from './settlement-contract.js';

/** The law's cases for `store`, wired as the in-repo runner wires them. */
function lawCases(store: InMemoryStore) {
  return settlementContract({
    store,
    storeName: store.constructor.name,
    settlementFixture: defaultSettlementFixture,
    route: {
      kind: 'clock',
      makeStore: ({ clock }) =>
        new (store.constructor as new (o: { clock: typeof clock }) => InMemoryStore)({ clock }),
    },
  }).filter((c) => c.law === 'SEAL_RUN_KEEPS_ACTOR');
}

/** Each case's outcome: `pass`, or the start of the message it failed with. */
async function outcomes(store: InMemoryStore): Promise<string[]> {
  const out: string[] = [];
  for (const c of lawCases(store)) {
    try {
      await c.run();
      out.push('pass');
    } catch (err) {
      out.push(`fail: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Leaves `member` out of every `seal_run` change before the store applies it. */
function dropping(member: 'by' | 'door') {
  return class extends InMemoryStore {
    override async settleStep(
      runId: string,
      delta: SettlementDelta,
      def?: WorkflowDefinition,
    ): Promise<StoreSettlement> {
      if (delta.kind !== 'seal_run') return super.settleStep(runId, delta, def);
      const { [member]: _gone, ...rest } = delta;
      return super.settleStep(runId, rest as SettlementDelta, def);
    }
  };
}

/** Returns both on the write's result, but a fresh read loses `by` (a column it never stored). */
class LosesByOnRead extends InMemoryStore {
  override async get(runId: string) {
    const got = await super.get(runId);
    const seal = got.record.sealed_by as Record<string, unknown> | undefined;
    if (seal === undefined || !('by' in seal)) return got;
    const { by: _gone, ...rest } = seal;
    return { ...got, record: { ...got.record, sealed_by: rest } as RunRecord };
  }
}

/** Writes `by: null` and `door: null` on a `seal_run` change that carried neither, as a column store would. */
class WritesNulls extends InMemoryStore {
  override async settleStep(
    runId: string,
    delta: SettlementDelta,
    def?: WorkflowDefinition,
  ): Promise<StoreSettlement> {
    const result = await super.settleStep(runId, delta, def);
    if (delta.kind !== 'seal_run' || !result.applied || 'by' in delta || 'door' in delta)
      return result;
    const stored = (this as unknown as { runs: Map<string, RunRecord> }).runs.get(runId)!;
    const nulled = {
      ...stored.sealed_by!,
      by: null,
      door: null,
    } as unknown as RunRecord['sealed_by'];
    stored.sealed_by = nulled;
    return { ...result, run: { ...result.run, sealed_by: nulled } };
  }
}

describe('#625 the actor unit, check 7 — SEAL_RUN_KEEPS_ACTOR against stores that break it', () => {
  it('check 7 — the in-repo store keeps both: each case passes', async () => {
    // (a) red when InMemoryStore drops a member or the cases are not registered; (b) prints them.
    expect(await outcomes(new InMemoryStore())).toEqual(['pass', 'pass']);
  });

  it('check 7 — a store that drops `by`, or `door`, fails the with-both case', async () => {
    const byGone = await outcomes(new (dropping('by'))());
    const doorGone = await outcomes(new (dropping('door'))());
    // (a) red when the law checks only one member, or only that something came back; (b) prints
    //     each case's outcome.
    expect({
      byGone: [
        byGone[0]?.startsWith(
          'fail: seal_run with by and door: the result reads back by undefined',
        ),
        byGone[1],
      ],
      doorGone: [
        doorGone[0]?.startsWith('fail: seal_run with by and door: the result reads back by {'),
        doorGone[1],
      ],
    }).toEqual({ byGone: [true, 'pass'], doorGone: [true, 'pass'] });
  });

  it('check 7 — a store whose fresh read loses `by` fails, though its result kept it', async () => {
    const out = await outcomes(new LosesByOnRead());
    // (a) red when the law reads back the write's result only; (b) prints the outcomes.
    expect([
      out[0]?.startsWith('fail: seal_run with by and door: a fresh read reads back by undefined'),
      out[1],
    ]).toEqual([true, 'pass']);
  });

  it('check 7 — a store that writes nulls for members the change did not carry fails the without case', async () => {
    const out = await outcomes(new WritesNulls());
    // (a) red when the law accepts a `null` stand-in as "neither"; (b) prints the outcomes.
    expect([out[0], out[1]]).toEqual([
      'pass',
      'fail: seal_run without by or door: the result reads back by: null, door: null (wrote neither)',
    ]);
  });
});
