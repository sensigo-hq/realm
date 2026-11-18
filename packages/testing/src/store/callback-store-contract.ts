// callback-store-contract.ts — R1.3 the callback, callback A1a (prompt `feat-callback-a1-delivery-port.md`
// and its split amendment): the laws of a store's callback store (`RunStore.callbacks`), the door
// side: registration inside `create`, `read`, `countPending` and the purge pair. The sender's laws
// (`due`, `claim`, `freezeBody`, `mark`) join this family in callback A1b. The store is ALSO a
// `PerRunArtifactStore`: a file wiring this family runs `perRunArtifactStoreContract` on
// `store.callbacks` too, naming in its `NOT_RUN` what its store cannot run there.
//
// Pure case descriptors (no test framework is imported). Each case builds its own stores through the
// adapter, on a clock the case moves and counts. A failing case throws an error that names the law,
// the step and what it got.
import { isDeepStrictEqual } from 'node:util';
import {
  markTestClock,
  WorkflowError,
  type CallbackRegistration,
  type CallbackStore,
  type Clock,
  type RunStore,
} from '@sensigo/realm';
import { settableClock } from '../clock/settable-clock.js';

/**
 * The laws, by name (each name says what a failure means):
 * - `CB_CREATE_BOTH_OR_NEITHER` — a create with a `callback` leaves the run and its `pending` row (the
 *   run's workflow, the host, `attempts` 0, `created_at` and `next_attempt_at` the run's `created_at`);
 *   a `webhook_id` another row holds throws and leaves no new run and no row; an idempotent match
 *   (`created: false`) writes no row and does not throw; a `countPending` beside a create sees the
 *   count before it or after it, never a run without its row.
 * - `CB_NO_PORT_REFUSES` — a store built without a callback store refuses a `callback` with
 *   `VALIDATION_OPTION_INVALID` and leaves no run, on an idempotent match too; a malformed `callback`
 *   throws its own error first.
 * - `CB_MALFORMED_THROWS` — an empty or 2,049-character `url`, an empty or 256-character `host`, a
 *   `webhook_id` that is not a uuid, a missing field: each create throws, takes no reading and leaves
 *   no run and no row; a 1- and a 2,048-character `url` and a 255-character `host` are accepted.
 * - `CB_VIEW_HIDES` — `read` of a `pending` row carries none of `url`, `body`, the claim token,
 *   `webhook_id` or `run_id`, and no unset field; a run without a row reads nothing.
 * - `CB_PURGE_PAIR` — `statAllForRun` counts the bytes of the row's address and equals what
 *   `deleteAllForRun` reports; the row is then gone and the pair reports zero again; another run's row
 *   stays; a run without a row is zero, never an error.
 * - `CB_CLOCK_READINGS` — a create with a `callback` takes the readings the same create without one
 *   takes, keyed and unkeyed, and the row is stamped with the create's own reading; `read`,
 *   `countPending` and the purge pair take none.
 */
export const CALLBACK_STORE_LAWS = [
  'CB_CREATE_BOTH_OR_NEITHER',
  'CB_NO_PORT_REFUSES',
  'CB_MALFORMED_THROWS',
  'CB_VIEW_HIDES',
  'CB_PURGE_PAIR',
  'CB_CLOCK_READINGS',
] as const;

export type CallbackStoreLaw = (typeof CALLBACK_STORE_LAWS)[number];

/** Adapter a calling test file supplies to run the family against one kind of store. */
export interface CallbackStoreContractAdapter {
  /** A name for the store, at the start of each case's `name`. */
  storeName: string;
  /** Builds a fresh store on `clock`, with a callback store (`store.callbacks`). */
  makeStore(o: { clock: Clock }): Promise<{ store: RunStore; dispose?(): Promise<void> }>;
  /**
   * Builds a fresh store on `clock` WITHOUT a callback store, for `CB_NO_PORT_REFUSES`. A store that
   * always keeps one leaves this out and lists the law in its `NOT_RUN`.
   */
  makeStoreWithoutPort?(o: {
    clock: Clock;
  }): Promise<{ store: RunStore; dispose?(): Promise<void> }>;
}

export interface CallbackStoreContractCase {
  law: CallbackStoreLaw;
  name: string;
  run: () => Promise<void>;
}

const MIN = 60_000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const WORKFLOW = 'wf-callback-law';
const HOST = 'hooks.example:443';
const iso = (ms: number): string => new Date(ms).toISOString();

/** A uuid made from `n`, so every case's ids are fixed. */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A registration: an address on `host`, with the uuid of `n`. */
const reg = (n: number, host = HOST): CallbackRegistration => ({
  url: `https://${host.split(':')[0]}/callback/${n}`,
  host,
  webhook_id: uuid(n),
});

function show(value: unknown): string {
  return JSON.stringify(value);
}

/** One store with a callback store, and its clock (moved and counted). */
interface Bench {
  readonly store: RunStore;
  readonly callbacks: CallbackStore;
  /** Moves the clock to `T0 + ms`. */
  at(ms: number): Promise<void>;
  /** How many readings the store took since the bench was built. */
  reads(): number;
  /** Creates a run, with `callback` when given, and `idempotencyKey` when given; its id. */
  create(callback?: CallbackRegistration, idempotencyKey?: string): Promise<string>;
  dispose(): Promise<void>;
}

function family(adapter: CallbackStoreContractAdapter) {
  async function bench(
    law: CallbackStoreLaw,
    make: CallbackStoreContractAdapter['makeStore'] = adapter.makeStore,
    needsPort = true,
  ): Promise<Bench & { readonly keeps: CallbackStore | null | undefined }> {
    const inner = settableClock(new Date(T0));
    let reads = 0;
    const clock = markTestClock<Clock>({
      now(): Date {
        reads += 1;
        return inner.now();
      },
      at: (when, fn) => inner.at(when, fn),
    });
    const built = await make({ clock });
    const keeps = built.store.callbacks;
    if (needsPort && (keeps === undefined || keeps === null))
      throw new Error(
        `${law}: adapter wiring — the store the adapter built has no callback store.`,
      );
    return {
      store: built.store,
      callbacks: keeps as CallbackStore,
      keeps,
      at: (ms) => inner.set(new Date(T0 + ms)),
      reads: () => reads,
      create: async (callback, idempotencyKey) =>
        (
          await built.store.create({
            workflowId: WORKFLOW,
            workflowVersion: 1,
            params: {},
            ...(callback !== undefined ? { callback } : {}),
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          })
        ).record.id,
      dispose: async () => {
        await built.dispose?.();
      },
    };
  }

  /** Runs `body` on a fresh bench, and disposes of it. */
  async function on(law: CallbackStoreLaw, body: (b: Bench) => Promise<void>): Promise<void> {
    const b = await bench(law);
    try {
      await body(b);
    } finally {
      await b.dispose();
    }
  }

  function same(law: CallbackStoreLaw, step: string, actual: unknown, expected: unknown): void {
    if (!isDeepStrictEqual(actual, expected))
      throw new Error(`${law} — ${step}: expected ${show(expected)}, got ${show(actual)}`);
  }

  /** What `call` threw (`undefined` when it did not throw). */
  async function thrown(call: () => Promise<unknown>): Promise<unknown> {
    try {
      await call();
      return undefined;
    } catch (err) {
      return err ?? new Error('a falsy throw');
    }
  }

  /** Whether a run is left under `key`: a create with the key alone makes a new run when none is. */
  async function noRunUnder(b: Bench, key: string): Promise<boolean> {
    const fresh = await b.store.create({
      workflowId: WORKFLOW,
      workflowVersion: 1,
      params: {},
      idempotencyKey: key,
    });
    return fresh.created;
  }

  const L = (law: CallbackStoreLaw, name: string, run: () => Promise<void>) => ({
    law,
    name: `${adapter.storeName}: ${name}`,
    run,
  });

  return [
    L(
      'CB_CREATE_BOTH_OR_NEITHER',
      'a create with a callback leaves its run and its row, or neither',
      () =>
        on('CB_CREATE_BOTH_OR_NEITHER', async (b) => {
          const law = 'CB_CREATE_BOTH_OR_NEITHER';
          await b.at(5 * MIN);
          const id = await b.create(reg(1));
          const run = (await b.store.get(id)).record;
          const pending = {
            workflow_id: WORKFLOW,
            host: HOST,
            status: 'pending',
            attempts: 0,
            next_attempt_at: run.created_at,
            created_at: run.created_at,
          };
          same(law, 'the row of the new run', await b.callbacks.read(id), pending);
          same(law, 'stamped with the create', run.created_at, iso(T0 + 5 * MIN));
          same(law, 'one pending', await b.callbacks.countPending(), 1);
          const dup = await thrown(() => b.create({ ...reg(2), webhook_id: uuid(1) }, 'dup'));
          same(law, 'a held webhook id throws', dup !== undefined, true);
          same(law, 'and leaves no run', await noRunUnder(b, 'dup'), true);
          same(law, 'nor a row', await b.callbacks.countPending(), 1);
          const first = await b.create(reg(3), 'same');
          const again = await b.store.create({
            workflowId: WORKFLOW,
            workflowVersion: 1,
            params: {},
            idempotencyKey: 'same',
            callback: reg(4),
          });
          same(
            law,
            'an idempotent match: the same run, not created',
            { id: again.record.id, created: again.created },
            { id: first, created: false },
          );
          same(law, 'its row unchanged', (await b.callbacks.read(first))?.host, HOST);
          same(law, 'no row for the ignored callback', await b.callbacks.countPending(), 2);
          same(
            law,
            'its webhook id is not held',
            (await thrown(() => b.create(reg(4)))) === undefined,
            true,
          );
          const before = await b.callbacks.countPending();
          const [made, beside] = await Promise.all([b.create(reg(5)), b.callbacks.countPending()]);
          same(
            law,
            'a count beside a create: before or after',
            [before, before + 1].includes(beside),
            true,
          );
          same(law, 'and the run has its row', (await b.callbacks.read(made))?.status, 'pending');
        }),
    ),
    L(
      'CB_NO_PORT_REFUSES',
      'a store without a callback store refuses a callback, before any run',
      async () => {
        const law = 'CB_NO_PORT_REFUSES';
        if (adapter.makeStoreWithoutPort === undefined)
          throw new Error(
            `${law}: not runnable — the adapter builds no store without a callback store.`,
          );
        const b = await bench(law, adapter.makeStoreWithoutPort, false);
        try {
          same(law, 'the store keeps none', b.keeps ?? null, null);
          const refused = await thrown(() => b.create(reg(1), 'np'));
          same(
            law,
            'refused with VALIDATION_OPTION_INVALID',
            refused instanceof WorkflowError ? refused.code : refused,
            'VALIDATION_OPTION_INVALID',
          );
          same(law, 'and no run', await noRunUnder(b, 'np'), true);
          await b.create(undefined, 'k');
          const onMatch = await thrown(() => b.create(reg(2), 'k'));
          same(
            law,
            'on an idempotent match too',
            onMatch instanceof WorkflowError ? onMatch.code : onMatch,
            'VALIDATION_OPTION_INVALID',
          );
          const reads = b.reads();
          const bad = await thrown(() => b.create({ ...reg(3), url: '' }));
          same(
            law,
            'a malformed callback throws its own error first, with no reading',
            {
              threw: bad !== undefined,
              refusal: bad instanceof WorkflowError && bad.code === 'VALIDATION_OPTION_INVALID',
              reads: b.reads() - reads,
            },
            { threw: true, refusal: false, reads: 0 },
          );
        } finally {
          await b.dispose();
        }
      },
    ),
    L('CB_MALFORMED_THROWS', 'a malformed callback throws, reads no clock and leaves nothing', () =>
      on('CB_MALFORMED_THROWS', async (b) => {
        const law = 'CB_MALFORMED_THROWS';
        const r = reg(1);
        const bad: Array<[string, unknown]> = [
          ['an empty url', { ...r, url: '' }],
          ['a 2,049-character url', { ...r, url: 'u'.repeat(2049) }],
          ['an empty host', { ...r, host: '' }],
          ['a 256-character host', { ...r, host: 'h'.repeat(256) }],
          ['a webhook id that is not a uuid', { ...r, webhook_id: 'not-a-uuid' }],
          ['an empty webhook id', { ...r, webhook_id: '' }],
          ['a missing url', { host: r.host, webhook_id: r.webhook_id }],
        ];
        for (const [step, callback] of bad) {
          const key = `bad-${step}`;
          const reads = b.reads();
          const err = await thrown(() => b.create(callback as CallbackRegistration, key));
          same(
            law,
            step,
            {
              threw: err !== undefined,
              reads: b.reads() - reads,
              pending: await b.callbacks.countPending(),
            },
            { threw: true, reads: 0, pending: 0 },
          );
          same(law, `${step}: no run`, await noRunUnder(b, key), true);
        }
        const good: Array<[string, CallbackRegistration]> = [
          ['a 1-character url', { ...reg(2), url: 'x' }],
          ['a 2,048-character url', { ...reg(3), url: 'u'.repeat(2048) }],
          ['a 255-character host', { ...reg(4), host: 'h'.repeat(255) }],
        ];
        for (const [step, callback] of good) {
          const id = await b.create(callback);
          same(law, `${step} is accepted`, (await b.callbacks.read(id))?.host, callback.host);
        }
      }),
    ),
    L(
      'CB_VIEW_HIDES',
      'a pending row reads without its address, body, token, webhook id or run id',
      () =>
        on('CB_VIEW_HIDES', async (b) => {
          const law = 'CB_VIEW_HIDES';
          const id = await b.create(reg(1));
          const view = await b.callbacks.read(id);
          same(law, 'the keys of a pending row', Object.keys(view ?? {}).sort(), [
            'attempts',
            'created_at',
            'host',
            'next_attempt_at',
            'status',
            'workflow_id',
          ]);
          same(
            law,
            'no address, body, token, webhook id or run id',
            ['url', 'body', 'claim_token', 'webhook_id', 'run_id'].filter((k) =>
              Object.hasOwn(view ?? {}, k),
            ),
            [],
          );
          same(law, 'a run without a row', await b.callbacks.read(await b.create()), undefined);
        }),
    ),
    L('CB_PURGE_PAIR', 'the purge pair counts and deletes the run’s row, and only that one', () =>
      on('CB_PURGE_PAIR', async (b) => {
        const law = 'CB_PURGE_PAIR';
        const r = reg(1);
        const id = await b.create(r);
        const other = await b.create(reg(2));
        const otherView = await b.callbacks.read(other);
        const preview = await b.callbacks.statAllForRun(id);
        const receipt = await b.callbacks.deleteAllForRun(id);
        same(
          law,
          'preview equals receipt, the address’s bytes',
          { preview: preview.bytes, receipt: receipt.bytes_deleted },
          { preview: Buffer.byteLength(r.url, 'utf8'), receipt: Buffer.byteLength(r.url, 'utf8') },
        );
        same(
          law,
          'after the delete',
          {
            read: await b.callbacks.read(id),
            stat: await b.callbacks.statAllForRun(id),
            again: await b.callbacks.deleteAllForRun(id),
            pending: await b.callbacks.countPending(),
          },
          { read: undefined, stat: { bytes: 0 }, again: { bytes_deleted: 0 }, pending: 1 },
        );
        same(law, 'another run’s row stays', await b.callbacks.read(other), otherView);
        same(
          law,
          'a run without a row',
          {
            stat: await b.callbacks.statAllForRun('run-callback-absent'),
            delete: await b.callbacks.deleteAllForRun('run-callback-absent'),
          },
          { stat: { bytes: 0 }, delete: { bytes_deleted: 0 } },
        );
      }),
    ),
    L(
      'CB_CLOCK_READINGS',
      'a create with a callback takes its own readings only; reads take none',
      () =>
        on('CB_CLOCK_READINGS', async (b) => {
          const law = 'CB_CLOCK_READINGS';
          const delta = async (call: () => Promise<unknown>): Promise<number> => {
            const before = b.reads();
            await call();
            return b.reads() - before;
          };
          const plain = await delta(() => b.create());
          const withCallback = await delta(() => b.create(reg(1)));
          const keyedPlain = await delta(() => b.create(undefined, 'k1'));
          const keyedWith = await delta(() => b.create(reg(2), 'k2'));
          same(
            law,
            'a callback adds no reading',
            { unkeyed: withCallback, keyed: keyedWith },
            { unkeyed: plain, keyed: keyedPlain },
          );
          await b.at(7 * MIN);
          const id = await b.create(reg(3));
          same(
            law,
            'the row is stamped with the create’s own reading',
            (await b.callbacks.read(id))?.created_at,
            iso(T0 + 7 * MIN),
          );
          same(
            law,
            'read, countPending and the purge pair take none',
            {
              read: await delta(() => b.callbacks.read(id)),
              count: await delta(() => b.callbacks.countPending()),
              stat: await delta(() => b.callbacks.statAllForRun(id)),
              delete: await delta(() => b.callbacks.deleteAllForRun(id)),
            },
            { read: 0, count: 0, stat: 0, delete: 0 },
          );
        }),
    ),
  ];
}

/** The family's cases, one per law in {@link CALLBACK_STORE_LAWS}, in that order. */
export function callbackStoreContract(
  adapter: CallbackStoreContractAdapter,
): CallbackStoreContractCase[] {
  return family(adapter);
}
