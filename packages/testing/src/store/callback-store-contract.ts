// callback-store-contract.ts — R1.3 the callback, callback A1a and A1b (prompt
// `feat-callback-a1-delivery-port.md` and its split amendment): the laws of a store's callback store
// (`RunStore.callbacks`). The door side (A1a): registration inside `create`, `read`, `countPending`
// and the purge pair. The sender side (A1b): `due` and `claim`, the only methods that return the
// address, then `freezeBody` and `mark`. The store is ALSO a `PerRunArtifactStore`: a file wiring
// this family runs `perRunArtifactStoreContract` on `store.callbacks` too, naming in its `NOT_RUN`
// what its store cannot run there.
//
// Pure case descriptors (no test framework is imported). Each case builds its own stores through the
// adapter, on a clock the case moves and counts. A failing case throws an error that names the law,
// the step and what it got.
import { isDeepStrictEqual } from 'node:util';
import {
  abandonRun,
  markTestClock,
  WorkflowError,
  type CallbackClaimResult,
  type CallbackMarkRequest,
  type CallbackRegistration,
  type CallbackStore,
  type Clock,
  type RunRecord,
  type RunStore,
} from '@sensigo/realm';
import { settableClock } from '../clock/settable-clock.js';

/**
 * The laws, by name (each name says what a failure means):
 * - `CB_CREATE_BOTH_OR_NEITHER` — a create with a `callback` leaves the run and its `pending` row (the
 *   run's workflow, the host, `attempts` 0, `created_at` and `next_attempt_at` the run's `created_at`);
 *   a `webhook_id` another row holds throws and leaves no new run and no row; an idempotent match
 *   (`created: false`) writes no row and does not throw. "No run" is read two ways: the store's count
 *   of the workflow's runs (a scan) and the refused create's key.
 * - `CB_NO_PORT_REFUSES` — a store built without a callback store refuses a `callback` with
 *   `VALIDATION_OPTION_INVALID` and leaves no run, on an idempotent match too; a malformed `callback`
 *   throws its own error first.
 * - `CB_MALFORMED_THROWS` — an empty or 2,049-character `url`, an empty or 256-character `host`, a
 *   `webhook_id` that is not a uuid, a missing field: each create throws, takes no reading and leaves
 *   no run and no row; a 1- and a 2,048-character `url` and a 255-character `host` are accepted.
 *   Callback A1b: a claim, freeze or mark token that is empty or 201 characters, a `limit` of 0, 1,001,
 *   1.5 or `NaN`, an empty body, a `delivered` status outside 200–299, an `afterSeconds` of 0, -1,
 *   `NaN`, `Infinity` or 86,401, a `lastStatus` outside 100–599 and the closed words (`unsigned`
 *   included), a mark of another kind: each throws, takes no reading and changes no row; a 200-character
 *   token, a `limit` of 1,000 and an `afterSeconds` of 86,400 are accepted.
 * - `CB_DUE_CONJUNCTS` — a row is due only when `pending`, its `next_attempt_at` at or before the reading
 *   (exactly at it; not 1 ms before) and its run finished; each conjunct alone keeps it out.
 * - `CB_DUE_RUN_GONE` — a row whose run is gone is not due, and its claim answers `run_not_finished`
 *   (an adapter hook removes the run; a store that cannot lists the law in its `NOT_RUN`).
 * - `CB_DUE_FAIRNESS_AND_ORDER` — 60 rows of one host and the newest row of another, `limit` 50: the
 *   first host's oldest, the other host's row, then the first host's next 48; ties are broken by `host`
 *   between hosts and by `run_id` within one, in code-unit order.
 * - `CB_CLAIM_ONE_WINNER` — two claims at once: one applies, the other is `stale`; the claim answers
 *   the item with `attempts` 1, `next_attempt_at` 60 s after the reading, `first_attempt_at` the reading
 *   and `finished_at` the run's `updated_at`, and the reading as `at`; the next claim keeps both
 *   instants; a run without a row is `no_row`, a delivered row `not_pending`.
 * - `CB_CLAIM_NEEDS_TERMINAL` — a run un-finished after `due` answers `run_not_finished` and the row is
 *   unchanged.
 * - `CB_FREEZE_ONCE` — the claim's token freezes the body once; a second freeze is `body_set`, another
 *   token `lost_claim`, a finished row `not_pending`, a run without a row `no_row`; `due` carries the
 *   first body.
 * - `CB_MARK_CONDITIONAL` — another token is `lost_claim` and changes nothing; after `delivered` or
 *   `failed`, every mark is `not_pending` and the row stays finished; a run without a row is `no_row`.
 * - `CB_NULLING_ONE_WRITE` — `retry` keeps the address and body and `due` sends them; `delivered` and
 *   `failed` clear them in the same write (zero bytes), keep the host, and record the ending's own
 *   status; a `due` beside a mark sees the row with its address or not at all.
 * - `CB_VIEW_HIDES` — `read` of a `pending` row carries none of `url`, `body`, `claim_token`,
 *   `webhook_id` or `run_id`, and no unset field; a run without a row reads nothing. Callback A1b: nor
 *   in a claimed, frozen, retried, delivered or failed row.
 * - `CB_PURGE_PAIR` — `statAllForRun` counts the bytes of the row's address and equals what
 *   `deleteAllForRun` reports; the row is then gone and the pair reports zero again; another run's row
 *   stays; a run without a row is zero, never an error.
 * - `CB_CLOCK_READINGS` — a create with a `callback` takes the readings the same create without one
 *   takes, keyed and unkeyed, and the row is stamped with the create's own reading; `read`,
 *   `countPending` and the purge pair take none. Callback A1b: `due`, `claim` and a `retry` mark take
 *   one, applied or refused; `freezeBody` and the other marks take none.
 */
export const CALLBACK_STORE_LAWS = [
  'CB_CREATE_BOTH_OR_NEITHER',
  'CB_NO_PORT_REFUSES',
  'CB_MALFORMED_THROWS',
  'CB_DUE_CONJUNCTS',
  'CB_DUE_RUN_GONE',
  'CB_DUE_FAIRNESS_AND_ORDER',
  'CB_CLAIM_ONE_WINNER',
  'CB_CLAIM_NEEDS_TERMINAL',
  'CB_FREEZE_ONCE',
  'CB_MARK_CONDITIONAL',
  'CB_NULLING_ONE_WRITE',
  'CB_VIEW_HIDES',
  'CB_PURGE_PAIR',
  'CB_CLOCK_READINGS',
] as const;

export type CallbackStoreLaw = (typeof CALLBACK_STORE_LAWS)[number];

/** Adapter a calling test file supplies to run the family against one kind of store. */
export interface CallbackStoreContractAdapter {
  /** A name for the store, at the start of each case's `name`. */
  storeName: string;
  /**
   * Builds a fresh store on `clock`, with a callback store (`store.callbacks`). `seedRun` writes a run
   * into it AS GIVEN, past the store's boundary (the in-memory store's `seed`), replacing the run with
   * the same id; it reads no clock (callback A1b: a case un-finishes a run with it).
   */
  makeStore(o: { clock: Clock }): Promise<{
    store: RunStore;
    seedRun(record: RunRecord): Promise<void>;
    dispose?(): Promise<void>;
  }>;
  /**
   * Removes a run and leaves its callback row, for `CB_DUE_RUN_GONE` (callback A1b). A store that
   * cannot remove a run leaves this out and lists the law in its `NOT_RUN`.
   */
  removeRun?(store: RunStore, runId: string): Promise<void>;
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
  /** The run's record as the store reads it. */
  record(runId: string): Promise<RunRecord>;
  /** Finishes the run (`abandonRun`, which seals it through `settleStep`). */
  finish(runId: string): Promise<void>;
  /** Writes `record` into the store as given (the adapter's `seedRun`). */
  plant(record: RunRecord): Promise<void>;
  dispose(): Promise<void>;
}

function family(adapter: CallbackStoreContractAdapter) {
  async function bench(
    law: CallbackStoreLaw,
    make: (o: { clock: Clock }) => Promise<{
      store: RunStore;
      seedRun?(record: RunRecord): Promise<void>;
      dispose?(): Promise<void>;
    }> = adapter.makeStore,
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
      record: async (runId) => (await built.store.get(runId)).record,
      finish: async (runId) => {
        await abandonRun(built.store, runId);
      },
      plant: async (record) => {
        if (built.seedRun === undefined) throw new Error(`${law}: the store has no seedRun.`);
        await built.seedRun(record);
      },
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

  /** How many runs of the family's workflow the store holds: a scan, every page. */
  async function runCount(b: Bench): Promise<number> {
    let n = 0;
    for await (const page of b.store.scan({ workflow: WORKFLOW }, { pageSize: 1000 }))
      n += page.items.filter((item) => item.kind === 'run').length;
    return n;
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

  const T = (ms: number): string => iso(T0 + ms);

  /** A finished run with the callback row of `reg(n, host)`; its id. */
  async function finishedRun(b: Bench, n: number, host = HOST): Promise<string> {
    const id = await b.create(reg(n, host));
    await b.finish(id);
    return id;
  }

  /** Claims the run's row at its stored `next_attempt_at`, with `token`. */
  async function claimNow(b: Bench, runId: string, token: string): Promise<CallbackClaimResult> {
    const view = await b.callbacks.read(runId);
    return b.callbacks.claim(runId, { expectedNextAttemptAt: view?.next_attempt_at ?? '', token });
  }

  /** A result's `applied` and `reason`, as one comparable value. */
  const answer = (r: { readonly applied: boolean }): string =>
    r.applied ? 'applied' : String((r as { reason?: unknown }).reason);

  /** The ids `due` returns, in its order. */
  const dueIds = async (b: Bench, limit = 1000): Promise<string[]> =>
    (await b.callbacks.due(limit)).map((item) => item.run_id);

  /** Callback A1b's part of `CB_MALFORMED_THROWS`: the sender's requests. */
  async function malformedSender(b: Bench): Promise<void> {
    const law = 'CB_MALFORMED_THROWS';
    const id = await finishedRun(b, 900);
    same(law, 'the setup claim', (await claimNow(b, id, 'X')).applied, true);
    const view = await b.callbacks.read(id);
    const mark =
      (result: unknown, token = 'X') =>
      () =>
        b.callbacks.mark(id, token, result as CallbackMarkRequest);
    const bad: Array<[string, () => Promise<unknown>]> = [
      [
        'a claim with an empty token',
        () => b.callbacks.claim(id, { expectedNextAttemptAt: '', token: '' }),
      ],
      [
        'a claim with a 201-character token',
        () => b.callbacks.claim(id, { expectedNextAttemptAt: '', token: 't'.repeat(201) }),
      ],
      ['due 0', () => b.callbacks.due(0)],
      ['due 1,001', () => b.callbacks.due(1001)],
      ['due 1.5', () => b.callbacks.due(1.5)],
      ['due NaN', () => b.callbacks.due(Number.NaN)],
      ['a freeze with an empty token', () => b.callbacks.freezeBody(id, '', 'b')],
      ['an empty body', () => b.callbacks.freezeBody(id, 'X', '')],
      ['a mark with an empty token', mark({ kind: 'failed', lastStatus: 500 }, '')],
      ['delivered with 199', mark({ kind: 'delivered', lastStatus: 199 })],
      ['delivered with 300', mark({ kind: 'delivered', lastStatus: 300 })],
      ['delivered with a word', mark({ kind: 'delivered', lastStatus: 'timeout' })],
      ['retry after 0 s', mark({ kind: 'retry', afterSeconds: 0, lastStatus: 503 })],
      ['retry after -1 s', mark({ kind: 'retry', afterSeconds: -1, lastStatus: 503 })],
      ['retry after NaN s', mark({ kind: 'retry', afterSeconds: Number.NaN, lastStatus: 503 })],
      [
        'retry after Infinity s',
        mark({ kind: 'retry', afterSeconds: Number.POSITIVE_INFINITY, lastStatus: 503 }),
      ],
      ['retry after 86,401 s', mark({ kind: 'retry', afterSeconds: 86_401, lastStatus: 503 })],
      ['retry with unsigned', mark({ kind: 'retry', afterSeconds: 1, lastStatus: 'unsigned' })],
      ['retry with 600', mark({ kind: 'retry', afterSeconds: 1, lastStatus: 600 })],
      ['failed with 99', mark({ kind: 'failed', lastStatus: 99 })],
      ['failed with 1.5', mark({ kind: 'failed', lastStatus: 1.5 })],
      ['failed with unsigned', mark({ kind: 'failed', lastStatus: 'unsigned' })],
      ['a mark of another kind', mark({ kind: 'resend', lastStatus: 500 })],
    ];
    for (const [step, call] of bad) {
      const reads = b.reads();
      const err = await thrown(call);
      same(
        law,
        step,
        { threw: err !== undefined, reads: b.reads() - reads, row: await b.callbacks.read(id) },
        { threw: true, reads: 0, row: view },
      );
    }
    same(
      law,
      'a 200-character token is accepted',
      (await thrown(() =>
        b.callbacks.claim(id, { expectedNextAttemptAt: '', token: 't'.repeat(200) }),
      )) === undefined,
      true,
    );
    same(
      law,
      'a limit of 1,000 is accepted',
      (await thrown(() => b.callbacks.due(1000))) === undefined,
      true,
    );
    same(
      law,
      'an afterSeconds of 86,400 is accepted',
      (await b.callbacks.mark(id, 'X', { kind: 'retry', afterSeconds: 86_400, lastStatus: 503 }))
        .applied,
      true,
    );
  }

  /** Callback A1b's part of `CB_VIEW_HIDES`: the rows a sender moves. */
  async function viewHidesSender(b: Bench): Promise<void> {
    const law = 'CB_VIEW_HIDES';
    const leaks = async (step: string, runId: string): Promise<void> => {
      const view = await b.callbacks.read(runId);
      same(
        law,
        `${step}: no address, body, token, webhook id or run id`,
        ['url', 'body', 'claim_token', 'webhook_id', 'run_id'].filter((k) =>
          Object.hasOwn(view ?? {}, k),
        ),
        [],
      );
    };
    const id = await finishedRun(b, 910);
    await claimNow(b, id, 'X');
    await leaks('claimed', id);
    await b.callbacks.freezeBody(id, 'X', 'the body');
    await leaks('frozen', id);
    await b.callbacks.mark(id, 'X', { kind: 'retry', afterSeconds: 1, lastStatus: 503 });
    await leaks('retried', id);
    await b.callbacks.mark(id, 'X', { kind: 'delivered', lastStatus: 200 });
    await leaks('delivered', id);
    same(law, 'the row read is delivered', (await b.callbacks.read(id))?.status, 'delivered');
    same(
      law,
      'the keys of a delivered row',
      Object.keys((await b.callbacks.read(id)) ?? {}).sort(),
      [
        'attempts',
        'created_at',
        'finished_at',
        'first_attempt_at',
        'host',
        'last_attempt_at',
        'last_status',
        'next_attempt_at',
        'status',
        'workflow_id',
      ],
    );
    const other = await finishedRun(b, 911);
    await claimNow(b, other, 'X');
    await b.callbacks.mark(other, 'X', { kind: 'failed', lastStatus: 'connection' });
    await leaks('failed', other);
    same(law, 'the row read is failed', (await b.callbacks.read(other))?.status, 'failed');
  }

  /** Callback A1b's part of `CB_CLOCK_READINGS`: the sender's readings. */
  async function clockSender(b: Bench): Promise<void> {
    const law = 'CB_CLOCK_READINGS';
    const delta = async (call: () => Promise<unknown>): Promise<number> => {
      const before = b.reads();
      await call();
      return b.reads() - before;
    };
    const id = await finishedRun(b, 920);
    const next = (await b.callbacks.read(id))!.next_attempt_at;
    same(
      law,
      'due, claim and a retry mark take one, applied or refused; freeze and the other marks none',
      {
        due: await delta(() => b.callbacks.due(10)),
        claimRefused: await delta(() =>
          b.callbacks.claim('run-callback-absent', { expectedNextAttemptAt: '', token: 'X' }),
        ),
        claim: await delta(() =>
          b.callbacks.claim(id, { expectedNextAttemptAt: next, token: 'X' }),
        ),
        freeze: await delta(() => b.callbacks.freezeBody(id, 'X', 'b')),
        retryRefused: await delta(() =>
          b.callbacks.mark(id, 'Y', { kind: 'retry', afterSeconds: 1, lastStatus: 503 }),
        ),
        retry: await delta(() =>
          b.callbacks.mark(id, 'X', { kind: 'retry', afterSeconds: 1, lastStatus: 503 }),
        ),
        delivered: await delta(() =>
          b.callbacks.mark(id, 'X', { kind: 'delivered', lastStatus: 200 }),
        ),
        failedRefused: await delta(() =>
          b.callbacks.mark(id, 'X', { kind: 'failed', lastStatus: 500 }),
        ),
      },
      {
        due: 1,
        claimRefused: 1,
        claim: 1,
        freeze: 0,
        retryRefused: 1,
        retry: 1,
        delivered: 0,
        failedRefused: 0,
      },
    );
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
          const runs = await runCount(b);
          const dup = await thrown(() => b.create({ ...reg(2), webhook_id: uuid(1) }, 'dup'));
          same(law, 'a held webhook id throws', dup !== undefined, true);
          same(
            law,
            'and leaves no run',
            { count: await runCount(b), key: await noRunUnder(b, 'dup') },
            { count: runs, key: true },
          );
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
          const made = await b.create(reg(5));
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
          const runs = await runCount(b);
          const refused = await thrown(() => b.create(reg(1), 'np'));
          same(
            law,
            'refused with VALIDATION_OPTION_INVALID',
            refused instanceof WorkflowError ? refused.code : refused,
            'VALIDATION_OPTION_INVALID',
          );
          same(
            law,
            'and no run',
            { count: await runCount(b), key: await noRunUnder(b, 'np') },
            { count: runs, key: true },
          );
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
          const runs = await runCount(b);
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
          same(
            law,
            `${step}: no run`,
            { count: await runCount(b), key: await noRunUnder(b, key) },
            { count: runs, key: true },
          );
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
        await malformedSender(b);
      }),
    ),
    L('CB_DUE_CONJUNCTS', 'each conjunct alone keeps a row out of due', () =>
      on('CB_DUE_CONJUNCTS', async (b) => {
        const law = 'CB_DUE_CONJUNCTS';
        const a = await finishedRun(b, 1);
        await b.at(1);
        const later = await finishedRun(b, 2);
        const open = await b.create(reg(3));
        await b.at(-1);
        same(law, '1 ms before next_attempt_at', await dueIds(b), []);
        await b.at(0);
        same(law, 'exactly at it; a row due 1 ms later is not', await dueIds(b), [a]);
        await b.at(1);
        same(law, 'at the later row’s instant', (await dueIds(b)).sort(), [a, later].sort());
        same(law, 'an unfinished run is never due', (await dueIds(b)).includes(open), false);
        await claimNow(b, a, 'X');
        await b.callbacks.mark(a, 'X', { kind: 'delivered', lastStatus: 200 });
        await b.at(10 * MIN);
        same(law, 'a delivered row is not due', (await dueIds(b)).includes(a), false);
      }),
    ),
    L(
      'CB_DUE_RUN_GONE',
      'a row whose run is gone is not due, and its claim is run_not_finished',
      async () => {
        const law = 'CB_DUE_RUN_GONE';
        const remove = adapter.removeRun;
        if (remove === undefined)
          throw new Error(`${law}: not runnable — the adapter cannot remove a run.`);
        await on(law, async (b) => {
          const id = await finishedRun(b, 1);
          const next = (await b.callbacks.read(id))!.next_attempt_at;
          await remove(b.store, id);
          same(law, 'not due', await dueIds(b), []);
          same(
            law,
            'its claim',
            answer(await b.callbacks.claim(id, { expectedNextAttemptAt: next, token: 'X' })),
            'run_not_finished',
          );
        });
      },
    ),
    L('CB_DUE_FAIRNESS_AND_ORDER', 'due goes one row per host per round, in a total order', () =>
      on('CB_DUE_FAIRNESS_AND_ORDER', async (b) => {
        const law = 'CB_DUE_FAIRNESS_AND_ORDER';
        const h1: string[] = [];
        for (let i = 0; i < 60; i++) {
          await b.at(i);
          h1.push(await finishedRun(b, 100 + i, 'h1.example:443'));
        }
        await b.at(60);
        const h2 = await finishedRun(b, 200, 'h2.example:443');
        await b.at(10 * MIN);
        same(
          law,
          '60 rows of one host and the newest row of another, limit 50',
          await dueIds(b, 50),
          [h1[0], h2, ...h1.slice(1, 49)],
        );
        for (const id of [...h1, h2]) await b.callbacks.deleteAllForRun(id);
        await b.at(20 * MIN);
        // The other host's row first, so a missing `host` tie-break keeps it first; six rows of one
        // host, so a missing `run_id` tie-break keeps their creation order, which is sorted 1 in 720.
        const other = await finishedRun(b, 300, 'b.example:443');
        const tied: string[] = [];
        for (let i = 0; i < 6; i++) tied.push(await finishedRun(b, 301 + i, 'a.example:443'));
        const sorted = [...tied].sort();
        same(law, 'ties: hosts by host, rows by run_id', await dueIds(b, 10), [
          sorted[0],
          other,
          ...sorted.slice(1),
        ]);
      }),
    ),
    L(
      'CB_CLAIM_ONE_WINNER',
      'two claims at once: one applies; the claim stamps the instants a sender judges from',
      () =>
        on('CB_CLAIM_ONE_WINNER', async (b) => {
          const law = 'CB_CLAIM_ONE_WINNER';
          const id = await finishedRun(b, 1);
          const finished = await b.record(id);
          const [item] = await b.callbacks.due(1);
          await b.at(5000);
          const both = await Promise.all([
            b.callbacks.claim(id, { expectedNextAttemptAt: T(0), token: 'X' }),
            b.callbacks.claim(id, { expectedNextAttemptAt: T(0), token: 'Y' }),
          ]);
          same(law, 'exactly one applies, the other is stale', both.map(answer).sort(), [
            'applied',
            'stale',
          ]);
          same(
            law,
            'the answer',
            both.find((r) => r.applied),
            {
              applied: true,
              at: T(5000),
              item: {
                ...item,
                attempts: 1,
                next_attempt_at: T(65_000),
                finished_at: finished.updated_at,
                first_attempt_at: T(5000),
              },
            },
          );
          same(law, 'the row', await b.callbacks.read(id), {
            workflow_id: WORKFLOW,
            host: HOST,
            status: 'pending',
            attempts: 1,
            next_attempt_at: T(65_000),
            first_attempt_at: T(5000),
            last_attempt_at: T(5000),
            created_at: T(0),
            finished_at: finished.updated_at,
          });
          same(
            law,
            'a stale expected instant',
            answer(await b.callbacks.claim(id, { expectedNextAttemptAt: T(0), token: 'Z' })),
            'stale',
          );
          await b.plant({ ...finished, updated_at: T(30_000) });
          await b.at(65_000);
          const again = await b.callbacks.claim(id, {
            expectedNextAttemptAt: T(65_000),
            token: 'Z',
          });
          same(
            law,
            'the next claim keeps the first instants',
            again.applied
              ? {
                  attempts: again.item.attempts,
                  first: again.item.first_attempt_at,
                  finished: again.item.finished_at,
                }
              : again,
            { attempts: 2, first: T(5000), finished: finished.updated_at },
          );
          same(
            law,
            'a run without a row',
            answer(
              await b.callbacks.claim(await b.create(), {
                expectedNextAttemptAt: T(0),
                token: 'X',
              }),
            ),
            'no_row',
          );
          await b.callbacks.mark(id, 'Z', { kind: 'delivered', lastStatus: 200 });
          same(
            law,
            'a delivered row',
            answer(await b.callbacks.claim(id, { expectedNextAttemptAt: T(125_000), token: 'W' })),
            'not_pending',
          );
        }),
    ),
    L(
      'CB_CLAIM_NEEDS_TERMINAL',
      'a run un-finished after due is run_not_finished, the row unchanged',
      () =>
        on('CB_CLAIM_NEEDS_TERMINAL', async (b) => {
          const law = 'CB_CLAIM_NEEDS_TERMINAL';
          const id = await b.create(reg(1));
          const open = await b.record(id);
          await b.finish(id);
          same(law, 'due before', await dueIds(b), [id]);
          const before = await b.callbacks.read(id);
          await b.plant(open);
          same(
            law,
            'the claim',
            answer(
              await b.callbacks.claim(id, {
                expectedNextAttemptAt: before!.next_attempt_at,
                token: 'X',
              }),
            ),
            'run_not_finished',
          );
          same(law, 'the row unchanged', await b.callbacks.read(id), before);
          same(law, 'and not due', await dueIds(b), []);
        }),
    ),
    L('CB_FREEZE_ONCE', 'the body is frozen once, by the claim’s token, while pending', () =>
      on('CB_FREEZE_ONCE', async (b) => {
        const law = 'CB_FREEZE_ONCE';
        const id = await finishedRun(b, 1);
        await claimNow(b, id, 'X');
        same(law, 'the first freeze', await b.callbacks.freezeBody(id, 'X', 'body one'), {
          applied: true,
        });
        same(law, 'a second', await b.callbacks.freezeBody(id, 'X', 'body two'), {
          applied: false,
          reason: 'body_set',
        });
        same(law, 'another token', await b.callbacks.freezeBody(id, 'Y', 'body two'), {
          applied: false,
          reason: 'lost_claim',
        });
        await b.at(2 * MIN);
        same(
          law,
          'due carries the first body',
          (await b.callbacks.due(10)).find((i) => i.run_id === id)?.body,
          'body one',
        );
        await b.callbacks.mark(id, 'X', { kind: 'delivered', lastStatus: 200 });
        same(law, 'a delivered row', await b.callbacks.freezeBody(id, 'X', 'body two'), {
          applied: false,
          reason: 'not_pending',
        });
        same(law, 'a run without a row', await b.callbacks.freezeBody(await b.create(), 'X', 'b'), {
          applied: false,
          reason: 'no_row',
        });
      }),
    ),
    L('CB_MARK_CONDITIONAL', 'a mark applies only to a pending row under its own claim', () =>
      on('CB_MARK_CONDITIONAL', async (b) => {
        const law = 'CB_MARK_CONDITIONAL';
        const a = await finishedRun(b, 1);
        await claimNow(b, a, 'X');
        const claimed = await b.callbacks.read(a);
        same(
          law,
          'another token',
          await b.callbacks.mark(a, 'Y', { kind: 'delivered', lastStatus: 200 }),
          {
            applied: false,
            reason: 'lost_claim',
          },
        );
        same(law, 'which changed nothing', await b.callbacks.read(a), claimed);
        same(
          law,
          'the holder delivers',
          await b.callbacks.mark(a, 'X', { kind: 'delivered', lastStatus: 204 }),
          {
            applied: true,
          },
        );
        const after: CallbackMarkRequest[] = [
          { kind: 'failed', lastStatus: 500 },
          { kind: 'retry', afterSeconds: 30, lastStatus: 503 },
          { kind: 'delivered', lastStatus: 200 },
        ];
        for (const result of after)
          same(law, `after delivered, ${result.kind}`, await b.callbacks.mark(a, 'X', result), {
            applied: false,
            reason: 'not_pending',
          });
        same(law, 'still delivered', (await b.callbacks.read(a))?.status, 'delivered');
        const f = await finishedRun(b, 2);
        await claimNow(b, f, 'X');
        same(
          law,
          'the holder fails it',
          await b.callbacks.mark(f, 'X', { kind: 'failed', lastStatus: 410 }),
          {
            applied: true,
          },
        );
        same(
          law,
          'after failed, delivered',
          await b.callbacks.mark(f, 'X', { kind: 'delivered', lastStatus: 200 }),
          {
            applied: false,
            reason: 'not_pending',
          },
        );
        same(law, 'still failed', (await b.callbacks.read(f))?.status, 'failed');
        same(
          law,
          'a run without a row',
          await b.callbacks.mark(await b.create(), 'X', { kind: 'failed', lastStatus: 500 }),
          {
            applied: false,
            reason: 'no_row',
          },
        );
      }),
    ),
    L('CB_NULLING_ONE_WRITE', 'the write that ends a row clears its address and body', () =>
      on('CB_NULLING_ONE_WRITE', async (b) => {
        const law = 'CB_NULLING_ONE_WRITE';
        const a = await finishedRun(b, 1);
        await claimNow(b, a, 'X');
        await b.callbacks.freezeBody(a, 'X', 'body-a');
        await b.at(MIN);
        await b.callbacks.mark(a, 'X', { kind: 'retry', afterSeconds: 30, lastStatus: 503 });
        const retried = await b.callbacks.read(a);
        same(
          law,
          'retry keeps the address and body',
          {
            bytes: (await b.callbacks.statAllForRun(a)).bytes,
            last: retried?.last_status,
            next: retried?.next_attempt_at,
          },
          {
            bytes: Buffer.byteLength(reg(1).url, 'utf8') + Buffer.byteLength('body-a', 'utf8'),
            last: 503,
            next: T(MIN + 30_000),
          },
        );
        await b.at(MIN + 30_000);
        const [item] = await b.callbacks.due(1);
        same(
          law,
          'and due sends them',
          { url: item?.url, body: item?.body },
          { url: reg(1).url, body: 'body-a' },
        );
        await claimNow(b, a, 'Y');
        await b.callbacks.mark(a, 'Y', { kind: 'delivered', lastStatus: 204 });
        const done = await b.callbacks.read(a);
        same(
          law,
          'delivered',
          {
            status: done?.status,
            last: done?.last_status,
            host: done?.host,
            bytes: (await b.callbacks.statAllForRun(a)).bytes,
          },
          { status: 'delivered', last: 204, host: HOST, bytes: 0 },
        );
        same(law, 'never due again', (await dueIds(b)).includes(a), false);
        const f = await finishedRun(b, 2);
        await claimNow(b, f, 'X');
        await b.at(10 * MIN);
        // `read` and `statAllForRun` are called inside the `Promise.all`, not after an `await`, so
        // they run right after the mark's first step: a mark that ends the row in two writes, with
        // an `await` between, is seen half-done.
        const [, beside, seenView, seenBytes] = await Promise.all([
          b.callbacks.mark(f, 'X', { kind: 'failed', lastStatus: 'connection' }),
          b.callbacks.due(1000),
          b.callbacks.read(f),
          b.callbacks.statAllForRun(f),
        ]);
        const seen = { status: seenView?.status, bytes: seenBytes.bytes };
        same(
          law,
          'a due beside the mark sees the row with its address or not at all',
          beside.filter((i) => i.run_id === f).every((i) => i.url === reg(2).url),
          true,
        );
        same(
          law,
          'a read beside the mark never sees a finished row that still holds its address',
          seen.status === 'pending' || seen.bytes === 0,
          true,
        );
        const failed = await b.callbacks.read(f);
        same(
          law,
          'failed',
          {
            status: failed?.status,
            last: failed?.last_status,
            bytes: (await b.callbacks.statAllForRun(f)).bytes,
          },
          { status: 'failed', last: 'connection', bytes: 0 },
        );
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
          await viewHidesSender(b);
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
          await clockSender(b);
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
