// store-clock-contract.ts — issue #715 (a) (D5 §2.1, §6; D6-3, D6-4, D6-14, D6-35, D6-36, D6-60): the
// store contract's TIME laws, as their own family. A store under these laws is built FRESH per case,
// on a clock the case moves — through one of two routes:
//   - `clock`: the store is built with an injected clock (an in-memory store, a database store's
//     test route), and the family counts the store's readings through a counting wrapper;
//   - `location`: the store is opened on a test location (`createTestLocation`), whose clock is the
//     location's file; a location store's clock is internal, so readings are not counted there.
// The family owns its workflow definition: one `auto` step with `timeout_seconds` and no finalizer,
// so the claim deadline is a real value (`computeClaimDeadline` returns `null` for an `agent` step or
// a workflow with a finalizer step) and the deadline check cannot pass vacuously.
import {
  CLOCK_SKEW_EPSILON_MS,
  computeClaimDeadline,
  type Clock,
  type RunRecord,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { countingClock, settableClock, type SettableClock } from '../clock/settable-clock.js';
import { createTestLocation, type TestLocation } from '../clock/test-location.js';

/**
 * The laws, by name (each law's name says what a failure means):
 * - `WRITE_ONE_READING` — every instant a `create`, `update` or `claimStep` records equals the
 *   clock's instant for that write (the claim's deadline: that instant plus the step's frozen
 *   duration), and the write spends EXACTLY one reading — applied or refused after its lock; a call
 *   for a run that does not exist spends none (the counts on the clock route only).
 * - `MONOTONE_CAPPED` — after the clock stepped back behind a record's `updated_at`, the next write
 *   is stamped `min(updated_at, clock + ε)`; behind the clock, the clock.
 * - `KEYED_CREATE_ORDERS_AFTER_HOLDER` — a superseding keyed create after a backward step below ε, or
 *   at a frozen instant, is stamped at least 1 ms after the run it supersedes.
 * - `KEYED_CREATE_FLOOR_CAPPED` — that floor lifts the stamp by at most ε.
 * - `READS_SPEND_NO_READING` — `get`, `list` and `stampSeal` spend no reading (clock route only).
 *   The `stampSeal` clause stamps a terminal, UNSEALED run the adapter seeds
 *   (`seedLegacyTerminal`), so the stamping code itself runs; a store that declares `stampSeal`
 *   under an adapter without the hook fails the clause with an adapter-wiring message.
 */
export const STORE_CLOCK_LAWS = [
  'WRITE_ONE_READING',
  'MONOTONE_CAPPED',
  'KEYED_CREATE_ORDERS_AFTER_HOLDER',
  'KEYED_CREATE_FLOOR_CAPPED',
  'READS_SPEND_NO_READING',
] as const;

export type StoreClockLaw = (typeof STORE_CLOCK_LAWS)[number];

/** How the family builds a fresh store for each case. */
export type StoreRoute =
  | { kind: 'clock'; makeStore(o: { clock: Clock }): RunStore | Promise<RunStore> }
  | { kind: 'location'; makeStore(o: { location: TestLocation }): RunStore | Promise<RunStore> };

/** Adapter a calling test file supplies to run the family against one kind of store. */
export interface StoreClockContractAdapter {
  storeName: string;
  route: StoreRoute;
  /**
   * #715 (a) correction 1 (C-4): writes a terminal, UNSEALED run into the store the route built for
   * the running case, past the store's own boundary, and returns it at its real version — a run
   * `stampSeal` really stamps. Modelled on `SettlementContractAdapter.seedLegacyTerminal`: each store
   * supplies its sanctioned channel (a direct file write, a direct map insert); the adapter keeps
   * the store its `makeStore` built last. `READS_SPEND_NO_READING` needs it for its `stampSeal`
   * clause: a SEALED run answers `already_stamped` before any stamping code runs, so a reading taken
   * in the stamp itself would pass. A store that declares `stampSeal` under an adapter that omits it
   * fails that clause with an adapter-wiring message (the settlement contract's idiom); it is never
   * skipped.
   */
  seedLegacyTerminal?: (id: string) => Promise<RunRecord>;
}

export interface StoreClockContractCase {
  law: StoreClockLaw;
  name: string;
  run: () => Promise<void>;
}

const EPS = CLOCK_SKEW_EPSILON_MS;
const WF = 'wf-store-clock';
const KEY = 'k-store-clock';
const STEP = 'work';
const DEFINITION: WorkflowDefinition = {
  id: WF,
  name: 'store clock contract',
  version: 1,
  steps: {
    [STEP]: {
      description: 'w',
      execution: 'auto',
      depends_on: [],
      handler: 'h',
      timeout_seconds: 90,
    },
  },
};
const T = Date.parse('2036-02-03T04:05:06.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const plain = { workflowId: WF, workflowVersion: 1, params: {} };
const keyed = (extra: Record<string, unknown> = {}) => ({
  ...plain,
  idempotencyKey: KEY,
  ...extra,
});

interface Controllable {
  store: RunStore;
  clock: SettableClock;
  reads: (() => number) | undefined;
  dispose(): Promise<void>;
}

async function controllable(route: StoreRoute, start: number): Promise<Controllable> {
  if (route.kind === 'clock') {
    const clock = settableClock(new Date(start));
    const counted = countingClock(clock);
    const store = await route.makeStore({ clock: counted });
    return { store, clock, reads: () => counted.reads, dispose: async () => {} };
  }
  const location = await createTestLocation({ start: new Date(start) });
  const store = await route.makeStore({ location });
  return { store, clock: location.clock, reads: undefined, dispose: () => location.remove() };
}

/** Ends a run the way the supersede journey of #558 PR-C (C-6) does. */
async function terminalize(store: RunStore, run: RunRecord): Promise<RunRecord> {
  const fresh = await store.get(run.id);
  return store.update({
    ...fresh,
    run_phase: 'abandoned',
    terminal_state: true,
    abandoned_at: fresh.updated_at,
    sealed_by: { arm: 'abandon_requested' },
    terminal_reason: 'Abandoned via realm run abandon',
  });
}

function check(law: StoreClockLaw, ok: boolean, detail: string): void {
  if (!ok) throw new Error(`${law}: ${detail}`);
}

/** Runs one law with a fresh store; any failure names the law. */
function lawCase(
  law: StoreClockLaw,
  name: string,
  adapter: StoreClockContractAdapter,
  start: number,
  body: (c: Controllable) => Promise<void>,
): StoreClockContractCase {
  return {
    law,
    name: `${adapter.storeName}: ${name}`,
    run: async () => {
      const c = await controllable(adapter.route, start);
      try {
        await body(c);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw message.startsWith(`${law}: `)
          ? err
          : new Error(`${law}: ${message}`, { cause: err });
      } finally {
        await c.dispose();
      }
    },
  };
}

/** The reading count one write spent (`undefined` on the location route). */
async function spent<R>(
  c: Controllable,
  write: () => Promise<R>,
): Promise<{ value?: R; error?: unknown; reads?: number }> {
  const before = c.reads?.();
  try {
    const value = await write();
    return { value, ...(before !== undefined ? { reads: c.reads!() - before } : {}) };
  } catch (error) {
    return { error, ...(before !== undefined ? { reads: c.reads!() - before } : {}) };
  }
}

function codeOf(err: unknown): string {
  return (err as { code?: string } | undefined)?.code ?? 'no error';
}

/** The store's time laws, one case per law, for the given adapter. */
export function storeClockContract(adapter: StoreClockContractAdapter): StoreClockContractCase[] {
  const L = (
    law: StoreClockLaw,
    name: string,
    start: number,
    body: (c: Controllable) => Promise<void>,
  ) => lawCase(law, name, adapter, start, body);
  return [
    L(
      'WRITE_ONE_READING',
      'every write stamps its one reading — applied or refused; a missing run spends none',
      T,
      async (c) => {
        const law = 'WRITE_ONE_READING';
        const counted = (what: string, r: { reads?: number }, n: number): void => {
          if (r.reads !== undefined)
            check(law, r.reads === n, `${what} spent ${r.reads} readings, not ${n}`);
        };
        const stamps = (what: string, got: string[], want: string): void => {
          check(
            law,
            got.every((s) => s === want),
            `${what} recorded ${got.join(', ')}, not ${want}`,
          );
        };
        const unkeyed = await spent(c, () => c.store.create(plain));
        counted('an unkeyed create', unkeyed, 1);
        const u = unkeyed.value!.run;
        stamps('an unkeyed create', [u.created_at, u.updated_at], iso(T));

        await c.clock.set(new Date(T + 1_000));
        const fresh = await spent(c, () => c.store.create(keyed()));
        counted('a keyed create (fresh key)', fresh, 1);
        const k = fresh.value!.run;
        stamps('a keyed create (fresh key)', [k.created_at, k.updated_at], iso(T + 1_000));

        await c.clock.set(new Date(T + 2_000));
        const reuse = await spent(c, () => c.store.create(keyed()));
        check(
          law,
          reuse.value?.created === false,
          'a keyed create on a live key did not reuse the run',
        );
        counted('a keyed create that reuses', reuse, 1);

        await terminalize(c.store, k);
        await c.clock.set(new Date(T + 3_000));
        const sup = await spent(c, () => c.store.create(keyed({ onTerminalMatch: 'rerun' })));
        counted('a superseding keyed create', sup, 1);
        const s = sup.value!.run;
        stamps('a superseding keyed create', [s.created_at, s.updated_at], iso(T + 3_000));

        await c.clock.set(new Date(T + 4_000));
        const current = await c.store.get(u.id);
        const upd = await spent(c, () => c.store.update(current));
        counted('an update', upd, 1);
        stamps('an update', [upd.value!.updated_at], iso(T + 4_000));

        await c.clock.set(new Date(T + 5_000));
        const claim = await spent(c, () => c.store.claimStep(u.id, STEP, DEFINITION));
        counted('a claimStep', claim, 1);
        const claimed = claim.value!;
        const expected = computeClaimDeadline(DEFINITION, STEP, new Date(T + 5_000));
        check(
          law,
          typeof expected === 'string',
          'the auto step has no claim deadline (the check would be vacuous)',
        );
        const entry = claimed.claims?.[STEP];
        stamps('a claimStep', [entry?.since ?? 'none', claimed.updated_at], iso(T + 5_000));
        check(
          law,
          entry?.deadline === expected,
          `a claimStep recorded the deadline ${String(entry?.deadline)}, not ${String(expected)}`,
        );

        const stale = await spent(c, () => c.store.update(current));
        check(
          law,
          codeOf(stale.error) === 'STATE_SNAPSHOT_MISMATCH',
          `a version-stale update ended ${codeOf(stale.error)}`,
        );
        counted('a version-stale update (refused)', stale, 1);
        const twice = await spent(c, () => c.store.claimStep(u.id, STEP, DEFINITION));
        check(
          law,
          codeOf(twice.error) === 'STATE_STEP_ALREADY_CLAIMED',
          `a second claim ended ${codeOf(twice.error)}`,
        );
        counted('an already-claimed claimStep (refused)', twice, 1);
        const gone = '00000000-0000-4000-8000-0000000007a1';
        const missingUpdate = await spent(c, () => c.store.update({ ...current, id: gone }));
        check(law, missingUpdate.error !== undefined, 'an update of a missing run resolved');
        counted('an update of a missing run', missingUpdate, 0);
        const missingClaim = await spent(c, () => c.store.claimStep(gone, STEP, DEFINITION));
        check(law, missingClaim.error !== undefined, 'a claim on a missing run resolved');
        counted('a claimStep on a missing run', missingClaim, 0);
      },
    ),
    L(
      'MONOTONE_CAPPED',
      'after a backward step, a write is stamped min(stored, clock + ε); behind the clock, the clock',
      T,
      async (c) => {
        const got: string[] = [];
        for (const lead of [3_600_000, 3_000, -3_600_000]) {
          await c.clock.set(new Date(T + lead));
          const { run } = await c.store.create(plain);
          await c.clock.set(new Date(T));
          got.push((await c.store.update(run)).updated_at);
        }
        const want = [iso(T + EPS), iso(T + 3_000), iso(T)];
        check(
          'MONOTONE_CAPPED',
          got.join() === want.join(),
          `updates after a record stamped +1 h, +3 s, −1 h were stamped ${got.join(', ')}, not ${want.join(', ')}`,
        );
      },
    ),
    L(
      'KEYED_CREATE_ORDERS_AFTER_HOLDER',
      'a superseding keyed create is stamped after its holder (a 4 s backward step, a frozen clock); a forward step stamps the reading; at exactly ε it equals the holder',
      T,
      async (c) => {
        const law = 'KEYED_CREATE_ORDERS_AFTER_HOLDER';
        const successorAt = async (
          key: string,
          clockMs: number,
        ): Promise<[RunRecord, RunRecord]> => {
          await c.clock.set(new Date(T));
          const { run: holder } = await c.store.create(keyed({ idempotencyKey: key }));
          await terminalize(c.store, holder);
          await c.clock.set(new Date(clockMs));
          const { run } = await c.store.create(
            keyed({ idempotencyKey: key, onTerminalMatch: 'rerun' }),
          );
          return [holder, run];
        };
        for (const [label, ms] of [
          ['a 4 s backward step', T - 4_000],
          ['a frozen clock', T],
        ] as const) {
          const [holder, s] = await successorAt(`${KEY}-${label}`, ms);
          check(
            law,
            Date.parse(s.created_at) >= Date.parse(holder.created_at) + 1,
            `after ${label} the successor was stamped ${s.created_at}, not after its holder ${holder.created_at}`,
          );
        }
        const [, forward] = await successorAt(`${KEY}-forward`, T + 10_000);
        check(
          law,
          forward.created_at === iso(T + 10_000),
          `after a forward step the successor was stamped ${forward.created_at}, not the reading ${iso(T + 10_000)}`,
        );
        const [holder, edge] = await successorAt(`${KEY}-edge`, T - EPS);
        check(
          law,
          edge.created_at === holder.created_at,
          `after a backward step of exactly ε the successor was stamped ${edge.created_at}, not equal to its holder ${holder.created_at}`,
        );
      },
    ),
    L('KEYED_CREATE_FLOOR_CAPPED', 'the floor lifts a successor by at most ε', T, async (c) => {
      await c.clock.set(new Date(T + 3_600_000));
      const { run: holder } = await c.store.create(keyed());
      await terminalize(c.store, holder);
      await c.clock.set(new Date(T));
      const { run: s } = await c.store.create(keyed({ onTerminalMatch: 'rerun' }));
      check(
        'KEYED_CREATE_FLOOR_CAPPED',
        Date.parse(s.created_at) <= T + EPS,
        `with its holder stamped ${holder.created_at} and the clock at ${iso(T)}, the successor was stamped ${s.created_at}, beyond ${iso(T + EPS)}`,
      );
    }),
    L(
      'READS_SPEND_NO_READING',
      'get, list and stampSeal (a real stamp of a seeded terminal unsealed run) spend no reading',
      T,
      async (c) => {
        const law = 'READS_SPEND_NO_READING';
        check(
          law,
          c.reads !== undefined,
          'this law runs on the clock route only (a location store’s clock is internal)',
        );
        const { run } = await c.store.create(plain);
        await terminalize(c.store, run);
        let unsealed: RunRecord | undefined;
        if (c.store.stampSeal !== undefined) {
          check(
            law,
            adapter.seedLegacyTerminal !== undefined,
            'ADAPTER_WIRING: this store declares stampSeal but the adapter has no `seedLegacyTerminal` hook, so the stampSeal clause cannot reach a real stamp (a sealed run answers already_stamped first). Supply the hook.',
          );
          unsealed = await adapter.seedLegacyTerminal!('store-clock-reads-unsealed');
        }
        const before = c.reads!();
        await c.store.get(run.id);
        await c.store.list();
        if (unsealed !== undefined) {
          const result = await c.store.stampSeal!(
            unsealed.id,
            { arm: 'complete', classified: true },
            unsealed.version,
          );
          check(
            law,
            result.stamped,
            `stampSeal did not stamp the seeded terminal unsealed run (${result.stamped ? 'stamped' : result.reason})`,
          );
        }
        check(
          law,
          c.reads!() === before,
          `get, list and stampSeal spent ${c.reads!() - before} readings`,
        );
      },
    ),
  ];
}
