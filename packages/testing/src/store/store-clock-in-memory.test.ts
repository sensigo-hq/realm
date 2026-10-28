// store-clock-in-memory.test.ts — issue #715 (a) Part C.3: the store-clock contract family's clock
// route on the in-memory store (cell C16), and the family's test of itself (cell C17): a
// `LossyClockStore` wrapper with five modes, one hand break per law — each law must FAIL on the mode
// that violates it, naming the law. Prints on failure: the law name and instants only.
import { describe, expect, it } from 'vitest';
import type {
  Attributed,
  Clock,
  CreateRunOptions,
  RunRecord,
  RunStore,
  SealedBy,
  StampSealResult,
  WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import {
  STORE_CLOCK_LAWS,
  storeClockContract,
  type StoreClockLaw,
} from './store-clock-contract.js';

/** None: the clock route runs every law of the family. */
const NOT_RUN: Partial<Record<StoreClockLaw, string>> = {};
const LAWS: readonly StoreClockLaw[] = STORE_CLOCK_LAWS.filter((law) => !(law in NOT_RUN));

/**
 * #715 (a) correction 1 (C-4): this store's sanctioned channel past its boundary — a direct map
 * insert, as `settlement-in-memory-store.test.ts` does: a terminal, UNSEALED run at its real version.
 */
async function seedUnsealedInto(store: InMemoryStore, id: string): Promise<RunRecord> {
  const { run } = await store.create({ workflowId: `seed-${id}`, workflowVersion: 1, params: {} });
  const legacy: RunRecord = {
    ...run,
    id,
    completed_steps: ['a'],
    terminal_state: true,
    terminal_reason: 'Workflow completed.',
    run_phase: 'completed',
  };
  (store as unknown as { runs: Map<string, RunRecord> }).runs.set(id, legacy);
  return legacy;
}

describe('#715 (a) C16 — the store-clock contract on InMemoryStore (clock route)', () => {
  let built: InMemoryStore | undefined;
  const cases = storeClockContract({
    storeName: 'InMemoryStore',
    route: { kind: 'clock', makeStore: ({ clock }) => (built = new InMemoryStore({ clock })) },
    seedLegacyTerminal: (id) => seedUnsealedInto(built!, id),
  });
  for (const law of LAWS) {
    it(law, async () => {
      const target = cases.find((c) => c.law === law);
      expect(target, `no case registered for law ${law}`).toBeDefined();
      await target!.run();
    });
  }
});

type LossyMode = 'own-new-date' | 'no-cap' | 'no-floor' | 'reads-twice' | 'reads-on-get';

/**
 * An in-memory store with ONE time defect (C17). Each mode breaks one law (`no-cap` breaks two):
 * `own-new-date` stamps `new Date()` itself; `no-cap` lifts a write by a stamp ahead without the ε
 * cap; `no-floor` stamps a superseding create with the raw clock; `reads-twice` reads the clock a
 * second time per write; `reads-on-get` reads it on every `get`.
 */
class LossyClockStore implements RunStore {
  readonly persistsClaims = true;
  readonly persistedRunRecordFields;
  constructor(
    private readonly inner: InMemoryStore,
    private readonly mode: LossyMode,
    private readonly clock: Clock,
  ) {
    this.persistedRunRecordFields = inner.persistedRunRecordFields;
  }

  private stamp(run: RunRecord, fields: Array<'created_at' | 'updated_at'>, at: string): RunRecord {
    const out = { ...run };
    for (const f of fields) out[f] = at;
    return out;
  }

  async create(options: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }> {
    if (this.mode === 'reads-twice') this.clock.now();
    const res = await this.inner.create(options);
    if (this.mode === 'own-new-date' && res.created) {
      const now = new Date().toISOString();
      return { ...res, run: this.stamp(res.run, ['created_at', 'updated_at'], now) };
    }
    if (res.run.rerun_of !== undefined && res.created) {
      const holder = await this.inner.get(res.run.rerun_of);
      if (this.mode === 'no-cap') {
        const at = Math.max(Date.parse(res.run.created_at), Date.parse(holder.created_at) + 1);
        const s = new Date(at).toISOString();
        return { ...res, run: this.stamp(res.run, ['created_at', 'updated_at'], s) };
      }
      if (this.mode === 'no-floor') {
        const raw = this.clock.now().toISOString();
        return { ...res, run: this.stamp(res.run, ['created_at', 'updated_at'], raw) };
      }
    }
    return res;
  }

  async get(runId: string): Promise<RunRecord> {
    if (this.mode === 'reads-on-get') this.clock.now();
    return this.inner.get(runId);
  }

  async update(record: RunRecord): Promise<RunRecord> {
    if (this.mode === 'reads-twice') this.clock.now();
    const stored = await this.inner.get(record.id).catch(() => undefined);
    const res = await this.inner.update(record);
    if (this.mode === 'own-new-date')
      return this.stamp(res, ['updated_at'], new Date().toISOString());
    if (this.mode === 'no-cap' && stored !== undefined) {
      const at = Math.max(Date.parse(res.updated_at), Date.parse(stored.updated_at));
      return this.stamp(res, ['updated_at'], new Date(at).toISOString());
    }
    return res;
  }

  list(workflowId?: string): Promise<RunRecord[]> {
    return this.inner.list(workflowId);
  }

  async claimStep(
    runId: string,
    stepName: string,
    definition: WorkflowDefinition,
    claimant?: Attributed,
  ): Promise<RunRecord> {
    if (this.mode === 'reads-twice') this.clock.now();
    const res = await this.inner.claimStep(runId, stepName, definition, claimant);
    if (this.mode === 'own-new-date')
      return this.stamp(res, ['updated_at'], new Date().toISOString());
    return res;
  }

  stampSeal(runId: string, sealedBy: SealedBy, expectedVersion: number): Promise<StampSealResult> {
    return this.inner.stampSeal(runId, sealedBy, expectedVersion);
  }
}

const VIOLATES: ReadonlyArray<[LossyMode, StoreClockLaw]> = [
  ['own-new-date', 'WRITE_ONE_READING'],
  ['no-cap', 'MONOTONE_CAPPED'],
  ['no-cap', 'KEYED_CREATE_FLOOR_CAPPED'],
  ['no-floor', 'KEYED_CREATE_ORDERS_AFTER_HOLDER'],
  ['reads-twice', 'WRITE_ONE_READING'],
  ['reads-on-get', 'READS_SPEND_NO_READING'],
];

describe('#715 (a) C17 — each law fails on the store that breaks it, naming the law', () => {
  for (const [mode, law] of VIOLATES) {
    it(`${law} fails on the '${mode}' store`, async () => {
      let inner: InMemoryStore | undefined;
      const cases = storeClockContract({
        storeName: `LossyClockStore(${mode})`,
        route: {
          kind: 'clock',
          makeStore: ({ clock }) =>
            new LossyClockStore((inner = new InMemoryStore({ clock })), mode, clock),
        },
        seedLegacyTerminal: (id) => seedUnsealedInto(inner!, id),
      });
      const target = cases.find((c) => c.law === law)!;
      let message = '';
      await target.run().catch((err: Error) => {
        message = err.message;
      });
      expect(message, `the failure of ${law} on '${mode}'`).toMatch(new RegExp(`^${law}: `));
      // Correction 1 (C-4): the law failed on the store's defect, never on the adapter's wiring.
      expect(message, `the failure of ${law} on '${mode}'`).not.toContain('ADAPTER_WIRING');
    });
  }

  it('READS_SPEND_NO_READING fails with the adapter-wiring message when a stampSeal store’s adapter has no seedLegacyTerminal (correction 1, C-4)', async () => {
    // (a) red when the clause is skipped for an adapter without the hook (the law passes);
    // (b) prints the failure message.
    const cases = storeClockContract({
      storeName: 'InMemoryStore (no seed hook)',
      route: { kind: 'clock', makeStore: ({ clock }) => new InMemoryStore({ clock }) },
    });
    let message = 'passed';
    await cases
      .find((c) => c.law === 'READS_SPEND_NO_READING')!
      .run()
      .catch((err: Error) => {
        message = err.message;
      });
    expect(message, message).toMatch(/^READS_SPEND_NO_READING: ADAPTER_WIRING: /);
  });
});
