// store-clock-contract.ts — issue #715 (a) (D5 §2.1, §6; D6-3, D6-4, D6-14, D6-35, D6-36, D6-60) and
// (b) (D-15…D-21; D6-9, D6-12, D6-16, D6-46, D6-57, D6-61, D6-65…67): the store contract's TIME laws,
// as their own family. A store under these laws is built FRESH per case,
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
  type ExtensionIdentityEntry,
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
 * - `READ_AT_CAPPED` (#715 (b), D6-34, Amendment 7) — a read judges its record at
 *   `max(r, min(updated_at, r + ε))`: a record stamped more than ε ahead of the clock is read at
 *   `clock + ε`, one up to ε ahead at its own stamp, one behind at the clock (`get` and `list`; both
 *   routes: the reading is judged, never counted). Core's `record_stamped_ahead` finding reads the raw reading back from that `at`: a
 *   store whose reads do not cap is not supported by that finding.
 * - `KEYED_CREATE_ORDERS_AFTER_HOLDER` — a superseding keyed create after a backward step below ε, or
 *   at a frozen instant, is stamped at least 1 ms after the run it supersedes.
 * - `KEYED_CREATE_FLOOR_CAPPED` — that floor lifts the stamp by at most ε.
 * - `READS_ONE_READING` (#715 (b), D-16; it REVERSES (a)'s `READS_SPEND_NO_READING`) — `get`, `list`
 *   and, when the store has it, `listWithDiagnostics` spend EXACTLY one reading each (taken before
 *   the load); `stampSeal`, `listRunIds` and `statAllForRun` spend none; `deleteAllForRun`, counted
 *   on its own, spends ONE when the adapter declares `recordsDeletionTime` (the store stamps the time
 *   of the deletion; #616 PR-1a unit 16a) and none when it does not (clock route only). The
 *   `stampSeal` clause stamps a terminal, UNSEALED run the adapter seeds (`seedLegacyTerminal`), so
 *   the stamping code itself runs; a store that declares `stampSeal` under an adapter without the
 *   hook fails the clause with an adapter-wiring message, and so does an adapter that declares
 *   `recordsDeletionTime` for a store with no `deleteAllForRun`.
 * - `SNAPSHOT_AT_SOUND` (#715 (b), D6-16) — a read takes its reading BEFORE it loads: given a clock
 *   whose reading coincides with another writer's write, the snapshot holds that write (clock route
 *   only; the hook writes through the store's own `update`, which must land synchronously — the
 *   in-memory store's does; the JSON store's cell lives with that store, writing the run file).
 * - `SETTLE_ONE_READING` (#715 (b), D-19) — a `settleStep` spends exactly one reading, applied or
 *   refused by its predicate, returns it as `at`, and stamps `updated_at = at`; a settle for a run
 *   that does not exist spends none.
 * - `OPEN_GATE_MINTS_AT_AT` (#715 (b), D-20) — an `open_gate` delta's gate gets `opened_at = at` and
 *   `expires_at = at + timeoutSeconds`; no gate is born expired.
 * - `LATE_ANSWER_ONE_WRITE` (#715 (b), D6-9, D6-61) — an answer to a due gate with a disposition
 *   enacts the expiry in the SAME write: applied, `lateAnswer` set, version + 1 once, one `at` — for a
 *   `settle_default` gate, an `abort` gate and an expiry whose default a guard fails; a finding-only
 *   overdue gate and a gate not yet due resolve the answer with no `lateAnswer`; after an expiry
 *   another writer enacted first: the same choice `already_settled` (spent), another choice
 *   `gate_choice_conflict`, an ended run `run_terminal`.
 * - `SEAL_RUN_ONE_WRITE` (#715 (b), D-21) — a `seal_run` seals with `abandoned_at = at` in one write,
 *   clears `claims` AND `in_progress_steps` together when asked, appends the identity entry with
 *   its `captured_at` verbatim, throws `STATE_SNAPSHOT_MISMATCH` for a moved run and returns
 *   `already_terminal` for an ended one.
 * - `KEYED_FIRST_CREATE_ONE_READING` (#715 (b), D6-57) — a keyed create on a fresh key, and one
 *   that reuses a live run, each spend ONE reading (clock route only).
 */
export const STORE_CLOCK_LAWS = [
  'WRITE_ONE_READING',
  'MONOTONE_CAPPED',
  'READ_AT_CAPPED',
  'KEYED_CREATE_ORDERS_AFTER_HOLDER',
  'KEYED_CREATE_FLOOR_CAPPED',
  'READS_ONE_READING',
  'SNAPSHOT_AT_SOUND',
  'SETTLE_ONE_READING',
  'OPEN_GATE_MINTS_AT_AT',
  'LATE_ANSWER_ONE_WRITE',
  'SEAL_RUN_ONE_WRITE',
  'KEYED_FIRST_CREATE_ONE_READING',
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
  /**
   * #616 PR-1a unit 16a: `true` for a store whose `deleteAllForRun` stamps the time of the deletion,
   * and so takes ONE reading of its clock; absent or `false` for a store whose delete takes none.
   * `READS_ONE_READING` counts that reading (it cannot see the time the store records). Read on the
   * `clock` route only, where that law runs. `true` for a store with no `deleteAllForRun` fails the
   * law with an adapter-wiring message: the flag would claim a verb the store lacks.
   */
  recordsDeletionTime?: boolean;
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
/** #715 (b): an agent step a gate opens on (the transform reads no gate config: the delta carries it). */
const GATED = 'gated';
const GATE_DEF: WorkflowDefinition = {
  id: WF,
  name: 'store clock contract (gate)',
  version: 1,
  steps: { [GATED]: { description: 'g', execution: 'agent', depends_on: [] } },
};
const T = Date.parse('2036-02-03T04:05:06.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const plain = { workflowId: WF, workflowVersion: 1, params: {} };
const keyed = (extra: Record<string, unknown> = {}) => ({
  ...plain,
  idempotencyKey: KEY,
  ...extra,
});

/** A store built on a clock the case sets (exported for the settlement contract's time-moving families, #715 (b)). */
export interface Controllable {
  store: RunStore;
  clock: SettableClock;
  reads: (() => number) | undefined;
  dispose(): Promise<void>;
}

/** Builds a fresh store on a settable clock started at `start`, through `route`. */
export async function controllable(route: StoreRoute, start: number): Promise<Controllable> {
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
  const { record: fresh } = await store.get(run.id);
  const { record: ended } = await store.update({
    ...fresh,
    run_phase: 'abandoned',
    terminal_state: true,
    abandoned_at: fresh.updated_at,
    sealed_by: { arm: 'abandon_requested' },
    terminal_reason: 'Abandoned via realm run abandon',
  });
  return ended;
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
        const u = unkeyed.value!.record;
        stamps('an unkeyed create', [u.created_at, u.updated_at], iso(T));

        await c.clock.set(new Date(T + 1_000));
        const fresh = await spent(c, () => c.store.create(keyed()));
        counted('a keyed create (fresh key)', fresh, 1);
        const k = fresh.value!.record;
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
        const s = sup.value!.record;
        stamps('a superseding keyed create', [s.created_at, s.updated_at], iso(T + 3_000));

        await c.clock.set(new Date(T + 4_000));
        const { record: current } = await c.store.get(u.id);
        const upd = await spent(c, () => c.store.update(current));
        counted('an update', upd, 1);
        stamps('an update', [upd.value!.record.updated_at], iso(T + 4_000));

        await c.clock.set(new Date(T + 5_000));
        const claim = await spent(c, () => c.store.claimStep(u.id, STEP, DEFINITION));
        counted('a claimStep', claim, 1);
        const claimed = claim.value!.record;
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
      'READ_AT_CAPPED',
      'a read judges a record stamped ahead at most ε ahead of the clock: +1 h → clock + ε; exactly +ε and +3 s → its own stamp; −1 h → the clock',
      T,
      async (c) => {
        const got: string[] = [];
        for (const lead of [3_600_000, EPS, 3_000, -3_600_000]) {
          await c.clock.set(new Date(T + lead));
          const { record: run } = await c.store.create(plain);
          await c.clock.set(new Date(T));
          const viaGet = (await c.store.get(run.id)).at.toISOString();
          const row = (await c.store.list()).snapshots.find((x) => x.record.id === run.id);
          got.push(`${viaGet}|${row?.at.toISOString() ?? 'no row'}`);
        }
        const want = [T + EPS, T + EPS, T + 3_000, T].map((ms) => `${iso(ms)}|${iso(ms)}`);
        check(
          'READ_AT_CAPPED',
          got.join() === want.join(),
          `reads (get|list) of records stamped +1 h, +ε, +3 s, −1 h were judged at ${got.join(', ')}, not ${want.join(', ')}`,
        );
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
          const { record: run } = await c.store.create(plain);
          await c.clock.set(new Date(T));
          got.push((await c.store.update(run)).record.updated_at);
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
          const { record: holder } = await c.store.create(keyed({ idempotencyKey: key }));
          await terminalize(c.store, holder);
          await c.clock.set(new Date(clockMs));
          const { record: run } = await c.store.create(
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
      const { record: holder } = await c.store.create(keyed());
      await terminalize(c.store, holder);
      await c.clock.set(new Date(T));
      const { record: s } = await c.store.create(keyed({ onTerminalMatch: 'rerun' }));
      check(
        'KEYED_CREATE_FLOOR_CAPPED',
        Date.parse(s.created_at) <= T + EPS,
        `with its holder stamped ${holder.created_at} and the clock at ${iso(T)}, the successor was stamped ${s.created_at}, beyond ${iso(T + EPS)}`,
      );
    }),
    L(
      'READS_ONE_READING',
      'get, list and listWithDiagnostics spend one reading each; stampSeal (a real stamp of a seeded terminal unsealed run), listRunIds and statAllForRun spend none; deleteAllForRun spends one when the adapter says the store records the time of a deletion, and none when it does not',
      T,
      async (c) => {
        const law = 'READS_ONE_READING';
        check(
          law,
          c.reads !== undefined,
          'this law runs on the clock route only (a location store’s clock is internal)',
        );
        const extra = c.store as RunStore & {
          listWithDiagnostics?: () => Promise<unknown>;
          listRunIds?: () => Promise<unknown>;
          statAllForRun?: (id: string) => Promise<unknown>;
          deleteAllForRun?: (id: string) => Promise<unknown>;
        };
        const deletes = typeof extra.deleteAllForRun === 'function';
        check(
          law,
          deletes || adapter.recordsDeletionTime !== true,
          'ADAPTER_WIRING: the adapter sets recordsDeletionTime, but this store has no deleteAllForRun, so no deletion can take the reading the flag claims. Remove the flag, or wire the store that deletes.',
        );
        const { record: run } = await c.store.create(plain);
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
        const one = async (what: string, read: () => Promise<unknown>): Promise<void> => {
          const r = await spent(c, read);
          check(law, r.error === undefined, `${what} failed: ${String(r.error)}`);
          check(law, r.reads === 1, `${what} spent ${String(r.reads)} readings, not 1`);
        };
        await one('a get', () => c.store.get(run.id));
        await one('a list', () => c.store.list());
        if (typeof extra.listWithDiagnostics === 'function') {
          await one('a listWithDiagnostics', () => extra.listWithDiagnostics!());
        }
        const missing = await spent(c, () => c.store.get('00000000-0000-4000-8000-0000000007a2'));
        check(law, missing.error !== undefined, 'a get of a missing run resolved');
        check(
          law,
          missing.reads === 1,
          `a get of a missing run spent ${String(missing.reads)} readings, not 1 (it reads before it loads)`,
        );
        const before = c.reads!();
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
        if (typeof extra.listRunIds === 'function') await extra.listRunIds();
        if (typeof extra.statAllForRun === 'function') await extra.statAllForRun(run.id);
        check(
          law,
          c.reads!() === before,
          `stampSeal, listRunIds and statAllForRun spent ${c.reads!() - before} readings, not 0`,
        );
        // #616 PR-1a unit 16a: the delete is its own span — one reading for a store that records
        // the time of the deletion (the adapter says so), none for one that does not.
        if (deletes) {
          const records = adapter.recordsDeletionTime === true;
          const deleted = await spent(c, () => extra.deleteAllForRun!(run.id));
          check(
            law,
            deleted.error === undefined,
            `deleteAllForRun failed: ${String(deleted.error)}`,
          );
          check(
            law,
            deleted.reads === (records ? 1 : 0),
            records
              ? `deleteAllForRun spent ${String(deleted.reads)} readings, not 1: the adapter sets recordsDeletionTime, so the store stamps the time of the deletion, and that time is one reading`
              : `deleteAllForRun spent ${String(deleted.reads)} readings, not 0: the adapter does not set recordsDeletionTime; a store whose delete reads the clock, to stamp the time of the deletion, sets it`,
          );
        }
      },
    ),
    {
      law: 'SNAPSHOT_AT_SOUND',
      name: `${adapter.storeName}: a read takes its reading BEFORE it loads — a write that coincides with the reading is in the snapshot`,
      run: async () => {
        const law = 'SNAPSHOT_AT_SOUND';
        try {
          check(
            law,
            adapter.route.kind === 'clock',
            'this law runs on the clock route only (the location store’s cell lives with that store)',
          );
          const route = adapter.route as Extract<StoreRoute, { kind: 'clock' }>;
          const base = settableClock(new Date(T));
          let hook: (() => void) | undefined;
          const hooked: Clock = {
            now: () => {
              const h = hook;
              hook = undefined;
              h?.();
              return base.now();
            },
            at: (when, fn) => base.at(when, fn),
          };
          const store = await route.makeStore({ clock: hooked });
          const { record: run } = await store.create(plain);
          // The other writer's write lands at the reading itself: when the read calls now().
          hook = () => {
            void store.update(run);
          };
          const snap = await store.get(run.id);
          check(
            law,
            hook === undefined,
            'the read took no reading (the hook never fired) — a read spends one',
          );
          check(
            law,
            snap.record.version === run.version + 1,
            `a write at the reading (${snap.at.toISOString()}) left the snapshot at version ${snap.record.version}, not ${run.version + 1} — the reading was taken after the load`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw message.startsWith(`${law}: `)
            ? err
            : new Error(`${law}: ${message}`, { cause: err });
        }
      },
    },
    L(
      'SETTLE_ONE_READING',
      'a settle spends one reading — applied or refused — returns it as at, and stamps updated_at = at; a missing run spends none',
      T,
      async (c) => {
        const law = 'SETTLE_ONE_READING';
        const counted = (what: string, r: { reads?: number }, n: number): void => {
          if (r.reads !== undefined)
            check(law, r.reads === n, `${what} spent ${r.reads} readings, not ${n}`);
        };
        const { record: run } = await c.store.create(plain);
        const { record: claimed } = await c.store.claimStep(run.id, STEP, DEFINITION);
        await c.clock.set(new Date(T + 7_000));
        const applied = await spent(c, () =>
          c.store.settleStep(
            run.id,
            {
              kind: 'settle_step',
              step: STEP,
              outcome: 'complete',
              ...(claimed.claims?.[STEP]?.token !== undefined
                ? { claimToken: claimed.claims[STEP]!.token! }
                : {}),
              evidence: [],
            },
            DEFINITION,
          ),
        );
        check(
          law,
          applied.value?.applied === true,
          `the settle did not apply (${String(applied.error)})`,
        );
        counted('an applied settle', applied, 1);
        const at = applied.value!.at.toISOString();
        check(law, at === iso(T + 7_000), `the settle returned at ${at}, not ${iso(T + 7_000)}`);
        check(
          law,
          applied.value!.run.updated_at === at,
          `the settle stamped updated_at ${applied.value!.run.updated_at}, not its at ${at}`,
        );
        const refused = await spent(c, () =>
          c.store.settleStep(
            run.id,
            { kind: 'settle_step', step: STEP, outcome: 'complete', evidence: [] },
            DEFINITION,
          ),
        );
        check(
          law,
          refused.value?.applied === false,
          `a replayed settle did not refuse (${String(refused.error)})`,
        );
        counted('a settle refused by its predicate', refused, 1);
        check(law, refused.value!.at instanceof Date, 'a refused settle returned no at');
        const missing = await spent(c, () =>
          c.store.settleStep(
            '00000000-0000-4000-8000-0000000007a3',
            { kind: 'settle_step', step: STEP, outcome: 'complete', evidence: [] },
            DEFINITION,
          ),
        );
        check(law, missing.error !== undefined, 'a settle of a missing run resolved');
        counted('a settle of a missing run', missing, 0);
      },
    ),
    L(
      'OPEN_GATE_MINTS_AT_AT',
      'an opening gate gets opened_at = at and expires_at = at + timeoutSeconds',
      T,
      async (c) => {
        const law = 'OPEN_GATE_MINTS_AT_AT';
        const { record: run } = await c.store.create(plain);
        const { record: claimed } = await c.store.claimStep(run.id, GATED, GATE_DEF);
        await c.clock.set(new Date(T + 2 * 3_600_000));
        const result = await c.store.settleStep(
          run.id,
          {
            kind: 'open_gate',
            step: GATED,
            ...(claimed.claims?.[GATED]?.token !== undefined
              ? { claimToken: claimed.claims[GATED]!.token! }
              : {}),
            pendingGate: { gate_id: 'g-mint', step_name: GATED, preview: {}, choices: ['a', 'b'] },
            timeoutSeconds: 300,
            evidence: [],
          },
          GATE_DEF,
        );
        check(law, result.applied, 'the gate did not open');
        const gate = result.run.pending_gate;
        const at = result.at.getTime();
        check(
          law,
          gate?.opened_at === iso(at) && gate.expires_at === iso(at + 300_000),
          `the gate opened at ${String(gate?.opened_at)} expiring ${String(gate?.expires_at)}, not ${iso(at)} / ${iso(at + 300_000)}`,
        );
        check(law, at === T + 2 * 3_600_000, `the write's at is ${iso(at)}, not the clock's`);
      },
    ),
    L(
      'LATE_ANSWER_ONE_WRITE',
      'an answer to a due gate with a disposition enacts the expiry in the same write — one version step, one at — for settle_default, abort and a guard-ending expiry; a finding-only overdue gate and a gate not yet due resolve the answer; an expiry enacted first gives today’s three refusals',
      T,
      async (c) => {
        const law = 'LATE_ANSWER_ONE_WRITE';
        // #715 (b) A.8 (iii): each scenario opens its own gate at its own instant, then answers.
        let base = T;
        const open = async (
          gateId: string,
          gate: Record<string, unknown>,
          def: WorkflowDefinition = GATE_DEF,
        ) => {
          base += 1_000_000;
          await c.clock.set(new Date(base));
          const { record: run } = await c.store.create(plain);
          const { record: claimed } = await c.store.claimStep(run.id, GATED, def);
          const token = claimed.claims?.[GATED]?.token;
          const opened = await c.store.settleStep(
            run.id,
            {
              kind: 'open_gate',
              step: GATED,
              ...(token !== undefined ? { claimToken: token } : {}),
              pendingGate: {
                gate_id: gateId,
                step_name: GATED,
                preview: {},
                choices: ['approve', 'reject'],
                ...gate,
              },
              timeoutSeconds: 60,
              evidence: [],
            },
            def,
          );
          check(law, opened.applied, `the gate ${gateId} did not open`);
          return { runId: run.id, opened };
        };
        const answerAt = async (
          offsetMs: number,
          runId: string,
          gateId: string,
          choice: string,
          def: WorkflowDefinition = GATE_DEF,
        ) => {
          await c.clock.set(new Date(base + offsetMs));
          return c.store.settleStep(
            runId,
            { kind: 'settle_gate', gateId, choice, evidence: [] },
            def,
          );
        };
        const oneWrite = (
          what: string,
          late: Awaited<ReturnType<typeof answerAt>>,
          opened: Awaited<ReturnType<typeof open>>['opened'],
          choice: string,
        ) => {
          check(
            law,
            late.applied,
            `${what}: the late answer did not apply (${late.applied ? '' : late.reason})`,
          );
          if (!late.applied) return;
          const expiresAt = opened.run.pending_gate?.expires_at;
          check(
            law,
            late.lateAnswer !== undefined &&
              late.lateAnswer.choice === choice &&
              late.lateAnswer.expiresAt === expiresAt,
            `${what}: the late answer carried ${JSON.stringify(late.lateAnswer)} (expires_at before the write: ${String(expiresAt)})`,
          );
          check(
            law,
            late.run.version === opened.run.version + 1 &&
              late.run.updated_at === late.at.toISOString(),
            `${what}: the answer and its expiry took ${late.run.version - opened.run.version} version steps (updated_at ${late.run.updated_at}, at ${late.at.toISOString()}), not 1 at one at`,
          );
        };

        // settle_default: the expiry settles the default in the answer's write.
        const sd = await open('g-default', {
          on_expiry: 'settle_default',
          default_choice: 'approve',
        });
        const lateSd = await answerAt(120_000, sd.runId, 'g-default', 'reject');
        oneWrite('settle_default', lateSd, sd.opened, 'reject');
        check(
          law,
          lateSd.run.settled?.[GATED]?.choice === 'approve',
          `settle_default: the expiry settled ${String(lateSd.run.settled?.[GATED]?.choice)}, not the default`,
        );

        // abort: the expiry ends the run in the answer's write.
        const ab = await open('g-abort', { on_expiry: 'abort' });
        const lateAb = await answerAt(120_000, ab.runId, 'g-abort', 'approve');
        oneWrite('abort', lateAb, ab.opened, 'approve');
        check(law, lateAb.run.terminal_state, 'abort: the run did not end');

        // A guard the expiry's default fails ends the run — in the same write (the cascade).
        const guarded: WorkflowDefinition = {
          ...GATE_DEF,
          steps: {
            ...GATE_DEF.steps,
            check: {
              description: 'c',
              execution: 'guard',
              depends_on: [GATED],
              abort_unless: [`${GATED}.choice == 'approve'`],
            },
          },
        };
        const gd = await open(
          'g-guard',
          { on_expiry: 'settle_default', default_choice: 'reject' },
          guarded,
        );
        const lateGd = await answerAt(120_000, gd.runId, 'g-guard', 'approve', guarded);
        oneWrite('guard', lateGd, gd.opened, 'approve');
        check(
          law,
          lateGd.run.terminal_state && lateGd.run.skipped_steps.includes('check'),
          `guard: the guard did not end the run in the same write (terminal ${String(lateGd.run.terminal_state)}, skipped ${JSON.stringify(lateGd.run.skipped_steps)})`,
        );

        // Finding-only (no on_expiry): the overdue answer resolves normally — no lateAnswer.
        const fo = await open('g-finding', {});
        const lateFo = await answerAt(120_000, fo.runId, 'g-finding', 'reject');
        check(
          law,
          lateFo.applied &&
            lateFo.lateAnswer === undefined &&
            lateFo.run.settled?.[GATED]?.choice === 'reject',
          `finding-only: the overdue answer did not resolve as given (${lateFo.applied ? JSON.stringify(lateFo.lateAnswer) : lateFo.reason})`,
        );

        // Not yet due: the answer applies normally — no lateAnswer.
        const nd = await open('g-early', { on_expiry: 'abort' });
        const early = await answerAt(30_000, nd.runId, 'g-early', 'reject');
        check(
          law,
          early.applied &&
            early.lateAnswer === undefined &&
            early.run.settled?.[GATED]?.choice === 'reject',
          `not yet due: the answer did not resolve as given (${early.applied ? JSON.stringify(early.lateAnswer) : early.reason})`,
        );

        // An expiry enacted FIRST (another enactment point held the lock): today's three refusals.
        const expireFirst = async (runId: string, gateId: string) => {
          await c.clock.set(new Date(base + 120_000));
          const enacted = await c.store.settleStep(
            runId,
            { kind: 'expire_gate', gateId },
            GATE_DEF,
          );
          check(law, enacted.applied, `the expiry of ${gateId} did not apply`);
        };
        const same = await open('g-same', {
          on_expiry: 'settle_default',
          default_choice: 'approve',
        });
        await expireFirst(same.runId, 'g-same');
        const sameAnswer = await answerAt(130_000, same.runId, 'g-same', 'approve');
        check(
          law,
          !sameAnswer.applied &&
            sameAnswer.reason === 'already_settled' &&
            sameAnswer.gateClaim?.proof === 'spent',
          `the same choice after the expiry answered ${sameAnswer.applied ? 'applied' : `${sameAnswer.reason} ${JSON.stringify(sameAnswer.gateClaim)}`}, not already_settled with the spent verdict`,
        );
        const other = await open('g-other', {
          on_expiry: 'settle_default',
          default_choice: 'approve',
        });
        await expireFirst(other.runId, 'g-other');
        const otherAnswer = await answerAt(130_000, other.runId, 'g-other', 'reject');
        check(
          law,
          !otherAnswer.applied && otherAnswer.reason === 'gate_choice_conflict',
          `a different choice after the expiry answered ${otherAnswer.applied ? 'applied' : otherAnswer.reason}, not gate_choice_conflict`,
        );
        const ended = await open('g-ended', { on_expiry: 'abort' });
        await expireFirst(ended.runId, 'g-ended');
        const endedAnswer = await answerAt(130_000, ended.runId, 'g-ended', 'approve');
        check(
          law,
          !endedAnswer.applied && endedAnswer.reason === 'run_terminal',
          `an answer after an abort expiry answered ${endedAnswer.applied ? 'applied' : endedAnswer.reason}, not run_terminal`,
        );
      },
    ),
    L(
      'SEAL_RUN_ONE_WRITE',
      'a seal_run seals at its write’s at, clears claims and in_progress together, keeps the identity entry verbatim, throws for a moved run and returns already_terminal for an ended one',
      T,
      async (c) => {
        const law = 'SEAL_RUN_ONE_WRITE';
        const { record: run } = await c.store.create(plain);
        const { record: claimed } = await c.store.claimStep(run.id, STEP, DEFINITION);
        const identity: ExtensionIdentityEntry = {
          captured_at: '2024-01-01T00:00:00.000Z',
          error: 'tck: extension load failed',
        } as unknown as ExtensionIdentityEntry;
        await c.clock.set(new Date(T + 9_000));
        const moved = await c.store
          .settleStep(run.id, {
            kind: 'seal_run',
            arm: 'abandon_requested',
            reason: 'tck',
            expected_version: claimed.version - 1,
            release_claims: true,
          })
          .then(
            () => 'resolved',
            (err: unknown) => codeOf(err),
          );
        check(law, moved === 'STATE_SNAPSHOT_MISMATCH', `a moved run's seal ended ${moved}`);
        const sealed = await c.store.settleStep(run.id, {
          kind: 'seal_run',
          arm: 'abandon_requested',
          reason: 'tck',
          expected_version: claimed.version,
          release_claims: true,
          identity_entry: identity,
        });
        check(law, sealed.applied, 'the seal did not apply');
        const r = sealed.run;
        check(
          law,
          r.terminal_state === true &&
            r.abandoned_at === iso(T + 9_000) &&
            sealed.at.toISOString() === iso(T + 9_000),
          `the seal stamped abandoned_at ${String(r.abandoned_at)} at ${sealed.at.toISOString()}, not ${iso(T + 9_000)}`,
        );
        check(
          law,
          Object.keys(r.claims ?? {}).length === 0 && r.in_progress_steps.length === 0,
          `release_claims left claims ${JSON.stringify(r.claims)} and in_progress ${JSON.stringify(r.in_progress_steps)}`,
        );
        check(
          law,
          r.extension_identity?.at(-1)?.captured_at === identity.captured_at,
          `the identity entry's captured_at became ${String(r.extension_identity?.at(-1)?.captured_at)}`,
        );
        const again = await c.store.settleStep(run.id, {
          kind: 'seal_run',
          arm: 'abandon_requested',
          reason: 'tck',
          expected_version: r.version,
          release_claims: true,
        });
        check(
          law,
          !again.applied && again.reason === 'already_terminal',
          `sealing an ended run answered ${again.applied ? 'applied' : again.reason}`,
        );
      },
    ),
    L(
      'KEYED_FIRST_CREATE_ONE_READING',
      'a keyed create on a fresh key spends one reading, and so does one that reuses a live run',
      T,
      async (c) => {
        const law = 'KEYED_FIRST_CREATE_ONE_READING';
        check(
          law,
          c.reads !== undefined,
          'this law runs on the clock route only (a location store’s clock is internal)',
        );
        const first = await spent(c, () =>
          c.store.create(keyed({ idempotencyKey: `${KEY}-first` })),
        );
        check(law, first.value?.created === true, 'the first keyed create did not create');
        check(
          law,
          first.reads === 1,
          `a first keyed create spent ${String(first.reads)} readings, not 1`,
        );
        const reuse = await spent(c, () =>
          c.store.create(keyed({ idempotencyKey: `${KEY}-first` })),
        );
        check(law, reuse.value?.created === false, 'the second keyed create did not reuse');
        check(
          law,
          reuse.reads === 1,
          `a reusing keyed create spent ${String(reuse.reads)} readings, not 1`,
        );
      },
    ),
  ];
}
