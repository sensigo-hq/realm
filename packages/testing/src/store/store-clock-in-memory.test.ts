// store-clock-in-memory.test.ts — issue #715 (a) Part C.3: the store-clock contract family's clock
// route on the in-memory store (cell C16), and the family's test of itself (cell C17): a
// `LossyClockStore` wrapper with five modes, one hand break per law — each law must FAIL on the mode
// that violates it, naming the law. Prints on failure: the law name and instants only.
import { describe, expect, it } from 'vitest';
import type {
  ArtifactDeletionReport,
  Attributed,
  Clock,
  CreateRunOptions,
  RunRecord,
  RunStore,
  SealedBy,
  StampSealResult,
  WorkflowDefinition,
} from '@sensigo/realm';
import { WorkflowError, writtenSnapshot } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import {
  STORE_CLOCK_LAWS,
  storeClockContract,
  type StoreClockLaw,
} from './store-clock-contract.js';
import type { Snapshot, Listing, CreateResult, SettlementDelta } from '@sensigo/realm';

/** None: the clock route runs every law of the family. */
const NOT_RUN: Partial<Record<StoreClockLaw, string>> = {};
const LAWS: readonly StoreClockLaw[] = STORE_CLOCK_LAWS.filter((law) => !(law in NOT_RUN));

/**
 * #715 (a) correction 1 (C-4): this store's sanctioned channel past its boundary — a direct map
 * insert, as `settlement-in-memory-store.test.ts` does: a terminal, UNSEALED run at its real version.
 */
async function seedUnsealedInto(store: InMemoryStore, id: string): Promise<RunRecord> {
  const { record: run } = await store.create({
    workflowId: `seed-${id}`,
    workflowVersion: 1,
    params: {},
  });
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

type LossyMode =
  'own-new-date' | 'no-cap' | 'no-floor' | 'reads-twice' | 'reads-on-get' | 'refuses-unread';

/**
 * An in-memory store with ONE time defect (C17). Each mode breaks one law (`no-cap` breaks two):
 * `own-new-date` stamps `new Date()` itself; `no-cap` lifts a write by a stamp ahead without the ε
 * cap; `no-floor` stamps a superseding create with the raw clock; `reads-twice` reads the clock a
 * second time per write; `reads-on-get` reads it on every `get`; `refuses-unread` (#715 (a)
 * correction 1, C-7) refuses a version-stale `update` before it reads the clock.
 */
class LossyClockStore implements RunStore {
  readonly persistsClaims = true;
  readonly persistedRunRecordFields;
  constructor(
    private readonly inner: InMemoryStore,
    private readonly mode: LossyMode,
    readonly clock: Clock,
  ) {
    this.persistedRunRecordFields = inner.persistedRunRecordFields;
  }

  /** #715 (b): reads the inner store's record WITHOUT a reading (a `get` spends one,
   *  READS_ONE_READING) — the channel `seedUnsealedInto` writes through. */
  private peek(id: string): RunRecord | undefined {
    return (this.inner as unknown as { runs: Map<string, RunRecord> }).runs.get(id);
  }

  private stamp(run: RunRecord, fields: Array<'created_at' | 'updated_at'>, at: string): RunRecord {
    const out = { ...run };
    for (const f of fields) out[f] = at;
    return out;
  }

  async create(options: CreateRunOptions): Promise<CreateResult> {
    if (this.mode === 'reads-twice') this.clock.now();
    const res = await this.inner.create(options);
    if (this.mode === 'own-new-date' && res.created) {
      const now = new Date().toISOString();
      return { ...res, record: this.stamp(res.record, ['created_at', 'updated_at'], now) };
    }
    if (res.record.rerun_of !== undefined && res.created) {
      const holder = this.peek(res.record.rerun_of)!;
      if (this.mode === 'no-cap') {
        const at = Math.max(Date.parse(res.record.created_at), Date.parse(holder.created_at) + 1);
        const s = new Date(at).toISOString();
        return { ...res, record: this.stamp(res.record, ['created_at', 'updated_at'], s) };
      }
      if (this.mode === 'no-floor') {
        const raw = this.clock.now().toISOString();
        return { ...res, record: this.stamp(res.record, ['created_at', 'updated_at'], raw) };
      }
    }
    return res;
  }

  async get(runId: string): Promise<Snapshot> {
    if (this.mode === 'reads-on-get') this.clock.now();
    return this.inner.get(runId);
  }

  async update(record: RunRecord): Promise<Snapshot> {
    if (this.mode === 'reads-twice') this.clock.now();
    const stored = this.peek(record.id);
    if (
      this.mode === 'refuses-unread' &&
      stored !== undefined &&
      stored.version !== record.version
    ) {
      throw new WorkflowError('Version conflict — run was modified by another process', {
        code: 'STATE_SNAPSHOT_MISMATCH',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: true,
        details: { runId: record.id, expected: record.version, actual: stored.version },
      });
    }
    const { record: res, at: written } = await this.inner.update(record);
    if (this.mode === 'own-new-date')
      return writtenSnapshot(this.stamp(res, ['updated_at'], new Date().toISOString()), written);
    if (this.mode === 'no-cap' && stored !== undefined) {
      const at = Math.max(Date.parse(res.updated_at), Date.parse(stored.updated_at));
      return writtenSnapshot(this.stamp(res, ['updated_at'], new Date(at).toISOString()), written);
    }
    return writtenSnapshot(res, written);
  }

  list(workflowId?: string): Promise<Listing> {
    return this.inner.list(workflowId);
  }

  async claimStep(
    runId: string,
    stepName: string,
    definition: WorkflowDefinition,
    claimant?: Attributed,
  ): Promise<Snapshot> {
    if (this.mode === 'reads-twice') this.clock.now();
    const { record: res, at } = await this.inner.claimStep(runId, stepName, definition, claimant);
    if (this.mode === 'own-new-date')
      return writtenSnapshot(this.stamp(res, ['updated_at'], new Date().toISOString()), at);
    return writtenSnapshot(res, at);
  }

  settleStep(runId: string, delta: SettlementDelta, definition?: WorkflowDefinition) {
    if (this.mode === 'reads-twice') this.clock.now();
    return this.inner.settleStep(runId, delta, definition);
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
  ['reads-on-get', 'READS_ONE_READING'],
  ['reads-twice', 'SETTLE_ONE_READING'],
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

  it('WRITE_ONE_READING fails at its refusal clause on a store that refuses a stale update before reading the clock (correction 1, C-7)', async () => {
    // (a) red when the law's refused-update count is dropped (the law passes on this store); (b)
    // prints the failure message.
    let inner: InMemoryStore | undefined;
    const cases = storeClockContract({
      storeName: 'LossyClockStore(refuses-unread)',
      route: {
        kind: 'clock',
        makeStore: ({ clock }) =>
          new LossyClockStore((inner = new InMemoryStore({ clock })), 'refuses-unread', clock),
      },
      seedLegacyTerminal: (id) => seedUnsealedInto(inner!, id),
    });
    let message = 'passed';
    await cases
      .find((c) => c.law === 'WRITE_ONE_READING')!
      .run()
      .catch((err: Error) => {
        message = err.message;
      });
    expect(message, message).toBe(
      'WRITE_ONE_READING: a version-stale update (refused) spent 0 readings, not 1',
    );
  });

  it('READS_ONE_READING fails with the adapter-wiring message when a stampSeal store’s adapter has no seedLegacyTerminal (correction 1, C-4)', async () => {
    // (a) red when the clause is skipped for an adapter without the hook (the law passes);
    // (b) prints the failure message.
    const cases = storeClockContract({
      storeName: 'InMemoryStore (no seed hook)',
      route: { kind: 'clock', makeStore: ({ clock }) => new InMemoryStore({ clock }) },
    });
    let message = 'passed';
    await cases
      .find((c) => c.law === 'READS_ONE_READING')!
      .run()
      .catch((err: Error) => {
        message = err.message;
      });
    expect(message, message).toMatch(/^READS_ONE_READING: ADAPTER_WIRING: /);
  });
});

type DeletionMode =
  | 'delete-reads'
  | 'delete-unread'
  | 'delete-rejects'
  | 'stamp-reads'
  | 'list-ids-reads'
  | 'stat-reads';

/**
 * #616 PR-1a unit 16a: InMemoryStore with the delete verbs a store that deletes has
 * (`deleteAllForRun`, `statAllForRun`, `listRunIds`, in their interface's shapes). Its delete stamps
 * the time of the deletion — one reading — except in `delete-unread` (it reads none) and
 * `delete-rejects` (it throws, as a store that cannot reach a run's artifacts must). The last three
 * modes each add one reading to one verb that must spend none.
 */
class DeletingClockStore extends InMemoryStore {
  constructor(
    clock: Clock,
    private readonly mode: DeletionMode,
  ) {
    super({ clock });
  }

  private get runMap(): Map<string, RunRecord> {
    return (this as unknown as { runs: Map<string, RunRecord> }).runs;
  }

  async deleteAllForRun(runId: string): Promise<ArtifactDeletionReport> {
    if (this.mode === 'delete-rejects') {
      throw new Error(`EACCES: the artifacts of run ${runId} cannot be reached`);
    }
    if (this.mode !== 'delete-unread') this.clock.now(); // the time of the deletion
    this.runMap.delete(runId);
    return { bytes_deleted: 0 };
  }

  async statAllForRun(_runId: string): Promise<{ bytes: number }> {
    if (this.mode === 'stat-reads') this.clock.now();
    return { bytes: 0 };
  }

  async listRunIds(): Promise<ReadonlySet<string>> {
    if (this.mode === 'list-ids-reads') this.clock.now();
    return new Set(this.runMap.keys());
  }

  override stampSeal(
    runId: string,
    sealedBy: SealedBy,
    expectedVersion: number,
  ): Promise<StampSealResult> {
    if (this.mode === 'stamp-reads') this.clock.now();
    return super.stampSeal(runId, sealedBy, expectedVersion);
  }
}

/** READS_ONE_READING run once on the store `make` builds: `passed`, or its failure message. */
async function readsOutcome(
  make: (clock: Clock) => InMemoryStore,
  recordsDeletionTime: boolean | undefined,
): Promise<string> {
  let built: InMemoryStore | undefined;
  const cases = storeClockContract({
    storeName: 'S',
    route: { kind: 'clock', makeStore: ({ clock }) => (built = make(clock)) },
    seedLegacyTerminal: (id) => seedUnsealedInto(built!, id),
    ...(recordsDeletionTime !== undefined ? { recordsDeletionTime } : {}),
  });
  return cases
    .find((c) => c.law === 'READS_ONE_READING')!
    .run()
    .then(
      () => 'passed',
      (err: Error) => err.message,
    );
}

const deleting =
  (mode: DeletionMode) =>
  (clock: Clock): InMemoryStore =>
    new DeletingClockStore(clock, mode);

describe('#616 PR-1a unit 16a — READS_ONE_READING counts the delete on its own, by the adapter’s recordsDeletionTime', () => {
  it('(a) a store whose delete stamps its time passes with recordsDeletionTime: true', async () => {
    // (1) red when the delete stays in the span that must spend none (it then spent 1); (2) prints
    //     the law's message.
    expect(await readsOutcome(deleting('delete-reads'), true)).toBe('passed');
  });

  it.each([false, undefined])(
    '(b) the same store with recordsDeletionTime %s fails, saying the delete spent a reading',
    async (flag) => {
      // (1) red when the law reads the flag as true by default, or ignores it and allows the
      //     reading; (2) prints the law's message.
      expect(await readsOutcome(deleting('delete-reads'), flag)).toBe(
        'READS_ONE_READING: deleteAllForRun spent 1 readings, not 0: the adapter does not set recordsDeletionTime; a store whose delete reads the clock, to stamp the time of the deletion, sets it',
      );
    },
  );

  it('(c) a store whose delete reads no clock fails with recordsDeletionTime: true', async () => {
    // (1) red when the law ignores the flag and allows none; (2) prints the law's message.
    expect(await readsOutcome(deleting('delete-unread'), true)).toBe(
      'READS_ONE_READING: deleteAllForRun spent 0 readings, not 1: the adapter sets recordsDeletionTime, so the store stamps the time of the deletion, and that time is one reading',
    );
  });

  it('(d) recordsDeletionTime: true for a store with no deleteAllForRun is an adapter-wiring failure', async () => {
    // (1) red when the flag is read only where the store deletes (the case then passes); (2) prints
    //     the law's message.
    expect(await readsOutcome((clock) => new InMemoryStore({ clock }), true)).toBe(
      'READS_ONE_READING: ADAPTER_WIRING: the adapter sets recordsDeletionTime, but this store has no deleteAllForRun, so no deletion can take the reading the flag claims. Remove the flag, or wire the store that deletes.',
    );
  });

  it.each(['stamp-reads', 'list-ids-reads', 'stat-reads'] as const)(
    '(e) the %s store fails the span that must spend none, though its delete is flagged',
    async (mode) => {
      // (1) red when that verb leaves the span, or the delete's reading is counted in it (it then
      //     spent 2); (2) prints the law's message.
      expect(await readsOutcome(deleting(mode), true)).toBe(
        'READS_ONE_READING: stampSeal, listRunIds and statAllForRun spent 1 readings, not 0',
      );
    },
  );

  it('(f) a delete that rejects fails the law, naming the delete and its error', async () => {
    // (1) red when the delete's rejection is not checked (the law then counts 0 readings of 1);
    //     (2) prints the law's message, which carries the store's own error.
    expect(await readsOutcome(deleting('delete-rejects'), true)).toMatch(
      /^READS_ONE_READING: deleteAllForRun failed: Error: EACCES: the artifacts of run [0-9a-f-]{36} cannot be reached$/,
    );
  });
});
