// outbound-ledger-contract.ts — issue #597, D1a (design record `DESIGN-D1-rev5.md` §2 and §7): the
// laws of a store's outbound ledger (`RunStore.outbound`), as their own family, beside the lease and
// per-run-artifact contracts. The ledger's purge pair is ALSO a `PerRunArtifactStore`: a file wiring
// this family runs `perRunArtifactStoreContract` on `store.outbound` too, naming in its `NOT_RUN` what
// its store cannot run there.
//
// Pure case descriptors (no test framework is imported). Each case builds its own stores through the
// adapter, on a clock the case moves and counts, and plants each run as given (`seedRun`): a run with
// an open question, or without one. Every instant is pinned at its boundary: exactly at it, and 1 ms
// before. A failing case throws an error that names the law, the step and what it got.
import { isDeepStrictEqual } from 'node:util';
import {
  markTestClock,
  OUTBOUND_LEASE_MAX,
  type Clock,
  type OutboundEntryView,
  type OutboundLeaseRequest,
  type OutboundLedger,
  type OutboundMarkRequest,
  type OutboundResult,
  type PendingGate,
  type RunRecord,
  type RunStore,
} from '@sensigo/realm';
import { settableClock } from '../clock/settable-clock.js';

/**
 * The laws, by name (each name says what a failure means):
 * - `OL_LEASE_CREATES` — a lease creates a `pending` row: the key derived from the request, the deadline
 *   at the reading plus the seconds, `attempts` 1, `created_at` the reading, `of_max` 3 for an authored
 *   `reminder_max` of 3 (and for an authored schedule with none), 1 with no authored schedule; an
 *   escalation row has no `occurrence` or `of_max`; no unset field is present, as `null` or otherwise.
 * - `OL_SECONDS_CLAMP` — `leaseSeconds` above `OUTBOUND_LEASE_MAX` (300) gives a deadline 300 s after
 *   the reading: another token is refused 1 ms before it and takes the lease over at it.
 * - `OL_MALFORMED_THROWS` — an empty or 201-character token, `leaseSeconds` 0, negative, `NaN` or
 *   `Infinity`, an occurrence 0 or 1.5: each lease throws, writes nothing and takes no reading (200
 *   characters is accepted).
 * - `OL_OWN_RETRY` — the same token again answers `already_leased` with the row unchanged.
 * - `OL_CONTENTION` — another token answers `lease_held`, with the row as a view (no `lease_token`).
 * - `OL_TAKEOVER` — 1 ms before the deadline another token is `lease_held`; exactly at it, it takes the
 *   lease over (`attempts` 2, the token replaced); the first token's mark is then `lease_lost`.
 * - `OL_LATE_MARK` — with no takeover, the holder's mark 1 ms before, exactly at and after the deadline
 *   applies.
 * - `OL_GATE_NOT_OPEN` — no open question, another question's id, a question answered since, a run
 *   that does not exist: `gate_not_open`, no row written, nothing thrown.
 * - `OL_TWO_GATES` — a later question's reminder 2 is not superseded by an earlier question's sent 3.
 * - `OL_CAP` — occurrence `reminder_max` applies; `reminder_max` + 1 is `not_eligible`.
 * - `OL_EXPIRY_CLOSES` — on an `on_expiry` question, a non-final reminder and the escalation apply
 *   1 ms before `expires_at` and are `not_eligible` exactly at it.
 * - `OL_FINAL_ELIGIBLE` — the final reminder (the first occurrence at or after `expires_at`) of an
 *   `on_expiry` question applies 1 ms before, exactly at and after `expires_at`.
 * - `OL_FINDING_ONLY` — on a question with `timeout_seconds` and no `on_expiry`, a reminder and the
 *   escalation apply 1 ms before, exactly at and after `expires_at`.
 * - `OL_UNREADABLE_EXPIRY` — an `expires_at` that cannot be read reads as unset: reminder 2 and the
 *   escalation apply.
 * - `OL_DEFAULT_SCHEDULE` — with no authored schedule, occurrence 1 applies, occurrence 2 is
 *   `not_eligible`, the escalation applies; exactly at an `on_expiry` question's expiry, occurrence 1
 *   still applies and the escalation does not (1 ms before, it does).
 * - `OL_DONE` — after `sent` and after `failed`, a lease answers `outbound_done` with the row.
 * - `OL_ORDER_ELIGIBILITY_BEFORE_DONE` — a sent non-final reminder, leased again exactly at an
 *   `on_expiry` question's expiry, is `not_eligible`, never `outbound_done` (1 ms before, it is
 *   `outbound_done`).
 * - `OL_ORDER_DONE_BEFORE_SUPERSEDED` — with reminders 2 and 3 sent, a lease on 2 is `outbound_done`.
 * - `OL_ORDER_SUPERSEDED_BEFORE_LEASED` — A holds 2 and B holds 3, both live: A's retry on 2 is
 *   `superseded`, not `already_leased`.
 * - `OL_SUPERSEDED` — a larger occurrence `sent`, or holding a live lease, supersedes a smaller one; a
 *   larger one `failed`, or whose lease passed, does not; the escalation neither supersedes nor is
 *   superseded.
 * - `OL_MARK` — the holder's `sent` sets `sent_at`, `last_at` and `last_outcome` `ok`, the lease's
 *   columns unchanged; `failed` sets `refused:<code>` and no `sent_at`; the same mark again is
 *   `already_marked`; another result or another token on a finished row is `outbound_done`; another
 *   token on a pending row is `lease_lost` with the row; a mark with no row is `lease_lost` and
 *   creates nothing.
 * - `OL_OUTCOME_CLOSED` — `ok` with `failed`, `refused:` with `sent`, an unknown word, an empty code, a
 *   65-character code, a capital letter: each mark throws, changes nothing and takes no reading (a
 *   64-character code is accepted).
 * - `OL_CLOCK_ONE_READING` — `lease` and `mark` each take one reading, applied or refused (an absent
 *   run included), and stamp the RAW reading (a run stamped ahead of the clock does not lift it);
 *   `read`, `statAllForRun` and `deleteAllForRun` take none; with a throwing clock, `lease` and `mark`
 *   throw and write nothing.
 * - `OL_NO_RUN_WRITE` — leases and marks, applied and refused, leave the run's `version` and
 *   `updated_at` unchanged.
 * - `OL_VIEW` — no entry `read` or a result returns carries `lease_token`; `read` orders the rows by
 *   `created_at`, then `entry_key`.
 * - `OL_PURGE` — `statAllForRun` of a run with a sent, a failed, a pending and an escalation row is
 *   positive and equals what `deleteAllForRun` reports; the run then reads no rows and zero bytes,
 *   another run's rows stay, and a run that does not exist reports zero.
 */
export const OUTBOUND_LEDGER_LAWS = [
  'OL_LEASE_CREATES',
  'OL_SECONDS_CLAMP',
  'OL_MALFORMED_THROWS',
  'OL_OWN_RETRY',
  'OL_CONTENTION',
  'OL_TAKEOVER',
  'OL_LATE_MARK',
  'OL_GATE_NOT_OPEN',
  'OL_TWO_GATES',
  'OL_CAP',
  'OL_EXPIRY_CLOSES',
  'OL_FINAL_ELIGIBLE',
  'OL_FINDING_ONLY',
  'OL_UNREADABLE_EXPIRY',
  'OL_DEFAULT_SCHEDULE',
  'OL_DONE',
  'OL_ORDER_ELIGIBILITY_BEFORE_DONE',
  'OL_ORDER_DONE_BEFORE_SUPERSEDED',
  'OL_ORDER_SUPERSEDED_BEFORE_LEASED',
  'OL_SUPERSEDED',
  'OL_MARK',
  'OL_OUTCOME_CLOSED',
  'OL_CLOCK_ONE_READING',
  'OL_NO_RUN_WRITE',
  'OL_VIEW',
  'OL_PURGE',
] as const;

export type OutboundLedgerLaw = (typeof OUTBOUND_LEDGER_LAWS)[number];

/** Adapter a calling test file supplies to run the family against one kind of store. */
export interface OutboundLedgerContractAdapter {
  /** A name for the store, at the start of each case's `name`. */
  storeName: string;
  /**
   * Builds a fresh store on `clock`, with an outbound ledger (`store.outbound`). `seedRun` writes a run
   * into it AS GIVEN, past the store's boundary (the in-memory store's `seed`), replacing the run with
   * the same id; it reads no clock.
   */
  makeStore(o: { clock: Clock }): Promise<{
    store: RunStore;
    seedRun(record: RunRecord): Promise<void>;
    dispose?(): Promise<void>;
  }>;
}

export interface OutboundLedgerContractCase {
  law: OutboundLedgerLaw;
  name: string;
  run: () => Promise<void>;
}

const MIN = 60_000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const RUN = 'run-outbound-law';
const OTHER_RUN = 'run-outbound-law-2';
const GATE = 'gate-outbound-law';
const iso = (ms: number): string => new Date(ms).toISOString();

/** The question every case opens at `T0`, with its timing fields as the case gives them. */
function gate(timing: Partial<PendingGate> = {}, gateId = GATE): PendingGate {
  return {
    gate_id: gateId,
    step_name: 'review',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: iso(T0),
    ...timing,
  };
}

/** An authored schedule: a reminder every 10 minutes, at most 3. */
const AUTHORED = { reminder_seconds: 600, reminder_max: 3 } as const;
/** It expires at +25 min and the expiry aborts the run: reminders 1 (+10) and 2 (+20); 3 (+30) is the final. */
const CLOSING = { ...AUTHORED, expires_at: iso(T0 + 25 * MIN), on_expiry: 'abort' } as const;
/** It expires at +25 min with no `on_expiry`: the expiry is a finding, never a closure. */
const FINDING_ONLY = { ...AUTHORED, expires_at: iso(T0 + 25 * MIN) } as const;

function runWith(
  open: PendingGate | undefined,
  id = RUN,
  fields: Partial<RunRecord> = {},
): RunRecord {
  return {
    id,
    workflow_id: 'wf-outbound-law',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: open !== undefined ? 'gate_waiting' : 'running',
    version: 3,
    params: {},
    evidence: [],
    created_at: iso(T0),
    updated_at: iso(T0),
    terminal_state: false,
    ...(open !== undefined ? { pending_gate: open } : {}),
    ...fields,
  };
}

type What = OutboundLeaseRequest['what'];
const rem = (occurrence: number, gateId = GATE): What => ({
  type: 'reminder',
  gateId,
  occurrence,
});
const esc = (gateId = GATE): What => ({ type: 'escalation', gateId });
const leaseOf = (what: What, leaseToken = 'A', leaseSeconds = 120): OutboundLeaseRequest => ({
  what,
  leaseToken,
  leaseSeconds,
});
const markOf = (
  what: What,
  leaseToken = 'A',
  result: 'sent' | 'failed' = 'sent',
  outcome: OutboundMarkRequest['outcome'] = result === 'sent' ? 'ok' : 'refused:channel_not_found',
): OutboundMarkRequest => ({ what, leaseToken, result, outcome });

function show(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'number' && !Number.isFinite(v) ? String(v) : v,
  );
}

/** One store with a ledger, its clock (moved, counted, made to throw) and its runs. */
interface Bench {
  readonly store: RunStore;
  readonly ledger: OutboundLedger;
  seed(open: PendingGate | undefined, id?: string, fields?: Partial<RunRecord>): Promise<void>;
  /** Moves the clock to `T0 + ms`. */
  at(ms: number): Promise<void>;
  /** The clock's reading now, in epoch milliseconds. */
  now(): number;
  /** How many readings the store took since the bench was built. */
  reads(): number;
  failClock(on: boolean): void;
  dispose(): Promise<void>;
}

function family(adapter: OutboundLedgerContractAdapter) {
  async function bench(law: OutboundLedgerLaw): Promise<Bench> {
    const inner = settableClock(new Date(T0));
    let reads = 0;
    let failing = false;
    const clock = markTestClock<Clock>({
      now(): Date {
        reads += 1;
        if (failing) throw new Error('the outbound law clock throws');
        return inner.now();
      },
      at: (when, fn) => inner.at(when, fn),
    });
    const built = await adapter.makeStore({ clock });
    const ledger = built.store.outbound;
    if (ledger === undefined || ledger === null)
      throw new Error(
        `${law}: adapter wiring — the store the adapter built has no outbound ledger.`,
      );
    return {
      store: built.store,
      ledger,
      seed: (open, id = RUN, fields = {}) => built.seedRun(runWith(open, id, fields)),
      at: (ms) => inner.set(new Date(T0 + ms)),
      now: () => inner.now().getTime(),
      reads: () => reads,
      failClock: (on) => {
        failing = on;
      },
      dispose: async () => {
        await built.dispose?.();
      },
    };
  }

  /** Runs `body` on a fresh bench (a run with `open`, when given), and disposes of it. */
  async function on(
    law: OutboundLedgerLaw,
    open: PendingGate | undefined,
    body: (b: Bench) => Promise<void>,
  ): Promise<void> {
    const b = await bench(law);
    try {
      await b.seed(open);
      await body(b);
    } finally {
      await b.dispose();
    }
  }

  function same(law: OutboundLedgerLaw, step: string, actual: unknown, expected: unknown): void {
    if (!isDeepStrictEqual(actual, expected))
      throw new Error(`${law} — ${step}: expected ${show(expected)}, got ${show(actual)}`);
  }

  /** A result's `applied` and `reason`, as one comparable value. */
  const outcome = (r: OutboundResult): string => (r.applied ? 'applied' : r.reason);

  function entryOf(law: OutboundLedgerLaw, step: string, r: OutboundResult): OutboundEntryView {
    if (r.entry === undefined) throw new Error(`${law} — ${step}: no entry in ${show(r)}`);
    return r.entry;
  }

  async function rejects(
    law: OutboundLedgerLaw,
    step: string,
    b: Bench,
    call: () => Promise<unknown>,
  ): Promise<void> {
    const before = { rows: await b.ledger.read(RUN), reads: b.reads() };
    let threw = false;
    try {
      await call();
    } catch {
      threw = true;
    }
    same(law, `${step} throws`, threw, true);
    same(
      law,
      `${step} changes nothing and takes no reading`,
      {
        rows: await b.ledger.read(RUN),
        reads: b.reads(),
      },
      before,
    );
  }

  const L = (law: OutboundLedgerLaw, name: string, run: () => Promise<void>) => ({
    law,
    name: `${adapter.storeName}: ${name}`,
    run,
  });

  return [
    L('OL_LEASE_CREATES', 'a lease creates a pending row with every set field and no other', () =>
      on('OL_LEASE_CREATES', gate(AUTHORED), async (b) => {
        const law = 'OL_LEASE_CREATES';
        await b.at(10 * MIN);
        const r = await b.ledger.lease(RUN, leaseOf(rem(1)));
        const created = {
          entry_key: `gate:${GATE}:reminder:1`,
          type: 'reminder',
          occurrence: 1,
          of_max: 3,
          status: 'pending',
          lease_deadline: iso(T0 + 10 * MIN + 120_000),
          attempts: 1,
          created_at: iso(T0 + 10 * MIN),
        };
        same(law, 'reminder 1 of an authored question', r, { applied: true, entry: created });
        same(law, 'read', await b.ledger.read(RUN), [created]);
        same(
          law,
          'the token is the request’s',
          outcome(await b.ledger.lease(RUN, leaseOf(rem(1)))),
          'already_leased',
        );
        const e = await b.ledger.lease(RUN, leaseOf(esc()));
        same(law, 'the escalation', e, {
          applied: true,
          entry: {
            entry_key: `gate:${GATE}:escalation`,
            type: 'escalation',
            status: 'pending',
            lease_deadline: iso(T0 + 10 * MIN + 120_000),
            attempts: 1,
            created_at: iso(T0 + 10 * MIN),
          },
        });
        for (const [label, timing, ofMax] of [
          ['no authored schedule', {}, 1],
          ['an authored schedule with no reminder_max', { reminder_seconds: 600 }, 3],
        ] as const) {
          await b.seed(gate(timing), OTHER_RUN);
          const o = await b.ledger.lease(OTHER_RUN, leaseOf(rem(1)));
          same(law, `of_max, ${label}`, o.entry?.of_max, ofMax);
          await b.ledger.deleteAllForRun(OTHER_RUN);
        }
      }),
    ),
    L('OL_SECONDS_CLAMP', 'leaseSeconds above 300 gives a deadline 300 s after the reading', () =>
      on('OL_SECONDS_CLAMP', gate(AUTHORED), async (b) => {
        const law = 'OL_SECONDS_CLAMP';
        const r = await b.ledger.lease(RUN, leaseOf(rem(1), 'A', 10_000));
        same(law, 'the deadline', r.entry?.lease_deadline, iso(T0 + OUTBOUND_LEASE_MAX * 1000));
        await b.at(OUTBOUND_LEASE_MAX * 1000 - 1);
        same(
          law,
          '1 ms before it',
          outcome(await b.ledger.lease(RUN, leaseOf(rem(1), 'B'))),
          'lease_held',
        );
        await b.at(OUTBOUND_LEASE_MAX * 1000);
        same(
          law,
          'exactly at it',
          outcome(await b.ledger.lease(RUN, leaseOf(rem(1), 'B'))),
          'applied',
        );
      }),
    ),
    L('OL_MALFORMED_THROWS', 'a malformed lease throws, writes nothing and takes no reading', () =>
      on('OL_MALFORMED_THROWS', gate(AUTHORED), async (b) => {
        const law = 'OL_MALFORMED_THROWS';
        const bad: Array<[string, OutboundLeaseRequest]> = [
          ['an empty token', leaseOf(rem(1), '')],
          ['a 201-character token', leaseOf(rem(1), 'x'.repeat(201))],
          ['leaseSeconds 0', leaseOf(rem(1), 'A', 0)],
          ['leaseSeconds -1', leaseOf(rem(1), 'A', -1)],
          ['leaseSeconds NaN', leaseOf(rem(1), 'A', Number.NaN)],
          ['leaseSeconds Infinity', leaseOf(rem(1), 'A', Number.POSITIVE_INFINITY)],
          ['occurrence 0', leaseOf(rem(0))],
          ['occurrence 1.5', leaseOf(rem(1.5))],
        ];
        for (const [label, request] of bad)
          await rejects(law, label, b, () => b.ledger.lease(RUN, request));
        await rejects(law, 'a mark with an empty token', b, () =>
          b.ledger.mark(RUN, markOf(rem(1), '')),
        );
        same(
          law,
          'a 200-character token',
          outcome(await b.ledger.lease(RUN, leaseOf(rem(1), 'x'.repeat(200)))),
          'applied',
        );
      }),
    ),
    L('OL_OWN_RETRY', 'the same token again is already_leased, the row unchanged', () =>
      on('OL_OWN_RETRY', gate(AUTHORED), async (b) => {
        const law = 'OL_OWN_RETRY';
        const first = await b.ledger.lease(RUN, leaseOf(rem(1)));
        await b.at(60_000);
        const again = await b.ledger.lease(RUN, leaseOf(rem(1)));
        same(law, 'the retry', again, {
          applied: false,
          reason: 'already_leased',
          entry: first.entry,
        });
        same(law, 'read', await b.ledger.read(RUN), [first.entry]);
      }),
    ),
    L('OL_CONTENTION', 'another token is lease_held, with the row as a view', () =>
      on('OL_CONTENTION', gate(AUTHORED), async (b) => {
        const law = 'OL_CONTENTION';
        const first = await b.ledger.lease(RUN, leaseOf(rem(1)));
        const other = await b.ledger.lease(RUN, leaseOf(rem(1), 'B'));
        same(law, 'the refusal', other, {
          applied: false,
          reason: 'lease_held',
          entry: first.entry,
        });
        same(
          law,
          'its entry carries no lease_token',
          'lease_token' in entryOf(law, 'lease_held', other),
          false,
        );
        same(law, 'read', await b.ledger.read(RUN), [first.entry]);
      }),
    ),
    L('OL_TAKEOVER', 'exactly at the deadline another token takes an expired lease over', () =>
      on('OL_TAKEOVER', gate(AUTHORED), async (b) => {
        const law = 'OL_TAKEOVER';
        await b.ledger.lease(RUN, leaseOf(rem(1)));
        await b.at(120_000 - 1);
        same(
          law,
          '1 ms before the deadline',
          outcome(await b.ledger.lease(RUN, leaseOf(rem(1), 'B'))),
          'lease_held',
        );
        await b.at(120_000);
        const taken = await b.ledger.lease(RUN, leaseOf(rem(1), 'B'));
        same(
          law,
          'exactly at the deadline',
          {
            outcome: outcome(taken),
            attempts: taken.entry?.attempts,
            deadline: taken.entry?.lease_deadline,
            created_at: taken.entry?.created_at,
          },
          { outcome: 'applied', attempts: 2, deadline: iso(T0 + 240_000), created_at: iso(T0) },
        );
        same(
          law,
          'the new token holds it',
          outcome(await b.ledger.lease(RUN, leaseOf(rem(1), 'B'))),
          'already_leased',
        );
        same(
          law,
          'the first token’s mark',
          outcome(await b.ledger.mark(RUN, markOf(rem(1)))),
          'lease_lost',
        );
        same(
          law,
          'the new token’s mark',
          outcome(await b.ledger.mark(RUN, markOf(rem(1), 'B'))),
          'applied',
        );
      }),
    ),
    L(
      'OL_LATE_MARK',
      'the holder’s mark before, at and after the deadline applies when nobody took over',
      () =>
        on('OL_LATE_MARK', gate(AUTHORED), async (b) => {
          const law = 'OL_LATE_MARK';
          await b.ledger.lease(RUN, leaseOf(rem(1)));
          await b.ledger.lease(RUN, leaseOf(esc()));
          await b.ledger.lease(RUN, leaseOf(rem(2)));
          await b.at(120_000 - 1);
          same(
            law,
            '1 ms before the deadline',
            outcome(await b.ledger.mark(RUN, markOf(rem(2)))),
            'applied',
          );
          await b.at(120_000);
          same(
            law,
            'exactly at the deadline',
            outcome(await b.ledger.mark(RUN, markOf(rem(1)))),
            'applied',
          );
          await b.at(120_000 + 5 * MIN);
          const late = await b.ledger.mark(RUN, markOf(esc()));
          same(
            law,
            'after the deadline',
            { outcome: outcome(late), status: late.entry?.status },
            {
              outcome: 'applied',
              status: 'sent',
            },
          );
        }),
    ),
    L(
      'OL_GATE_NOT_OPEN',
      'no open question, another one, an answered one, an absent run: gate_not_open',
      () =>
        on('OL_GATE_NOT_OPEN', undefined, async (b) => {
          const law = 'OL_GATE_NOT_OPEN';
          const refused = { applied: false, reason: 'gate_not_open' };
          same(law, 'no open question', await b.ledger.lease(RUN, leaseOf(rem(1))), refused);
          await b.seed(gate(AUTHORED, 'gate-other'));
          same(law, 'another question', await b.ledger.lease(RUN, leaseOf(esc())), refused);
          same(law, 'nothing written', await b.ledger.read(RUN), []);
          await b.seed(gate(AUTHORED));
          same(
            law,
            'the open question',
            outcome(await b.ledger.lease(RUN, leaseOf(rem(1)))),
            'applied',
          );
          await b.seed(undefined, RUN, { version: 4, completed_steps: ['review'] });
          same(law, 'answered since', await b.ledger.lease(RUN, leaseOf(esc())), refused);
          same(
            law,
            'only the row leased while it was open',
            (await b.ledger.read(RUN)).map((e) => e.entry_key),
            [`gate:${GATE}:reminder:1`],
          );
          same(
            law,
            'an absent run',
            await b.ledger.lease('run-outbound-absent', leaseOf(rem(1))),
            refused,
          );
          same(law, 'an absent run reads no rows', await b.ledger.read('run-outbound-absent'), []);
        }),
    ),
    L('OL_TWO_GATES', 'an earlier question’s sent 3 does not supersede a later question’s 2', () =>
      on('OL_TWO_GATES', gate(AUTHORED, 'gate-a'), async (b) => {
        const law = 'OL_TWO_GATES';
        await b.ledger.lease(RUN, leaseOf(rem(3, 'gate-a')));
        await b.ledger.mark(RUN, markOf(rem(3, 'gate-a')));
        await b.seed(gate(AUTHORED, 'gate-b'), RUN, { version: 5 });
        same(
          law,
          'gate b’s reminder 2',
          outcome(await b.ledger.lease(RUN, leaseOf(rem(2, 'gate-b')))),
          'applied',
        );
      }),
    ),
    L('OL_CAP', 'occurrence reminder_max applies; reminder_max + 1 is not_eligible', () =>
      on('OL_CAP', gate(AUTHORED), async (b) => {
        const law = 'OL_CAP';
        same(law, 'occurrence 4 of 3', await b.ledger.lease(RUN, leaseOf(rem(4))), {
          applied: false,
          reason: 'not_eligible',
        });
        same(
          law,
          'occurrence 3 of 3',
          outcome(await b.ledger.lease(RUN, leaseOf(rem(3)))),
          'applied',
        );
      }),
    ),
    L(
      'OL_EXPIRY_CLOSES',
      'on an on_expiry question the expiry closes a non-final reminder and the escalation',
      async () => {
        const law = 'OL_EXPIRY_CLOSES';
        await on(law, gate(CLOSING), async (b) => {
          await b.at(25 * MIN - 1);
          same(
            law,
            '1 ms before: reminder 2',
            outcome(await b.ledger.lease(RUN, leaseOf(rem(2)))),
            'applied',
          );
          same(
            law,
            '1 ms before: the escalation',
            outcome(await b.ledger.lease(RUN, leaseOf(esc()))),
            'applied',
          );
        });
        await on(law, gate(CLOSING), async (b) => {
          await b.at(25 * MIN);
          for (const [label, what] of [
            ['reminder 1', rem(1)],
            ['reminder 2', rem(2)],
            ['the escalation', esc()],
          ] as const)
            same(law, `exactly at expires_at: ${label}`, await b.ledger.lease(RUN, leaseOf(what)), {
              applied: false,
              reason: 'not_eligible',
            });
          same(law, 'nothing written', await b.ledger.read(RUN), []);
        });
      },
    ),
    L(
      'OL_FINAL_ELIGIBLE',
      'the final reminder of an on_expiry question applies before, at and after expires_at',
      async () => {
        const law = 'OL_FINAL_ELIGIBLE';
        for (const [label, ms] of [
          ['1 ms before', 25 * MIN - 1],
          ['exactly at', 25 * MIN],
          ['after', 40 * MIN],
        ] as const)
          await on(law, gate(CLOSING), async (b) => {
            await b.at(ms);
            same(
              law,
              `${label} expires_at: reminder 3`,
              outcome(await b.ledger.lease(RUN, leaseOf(rem(3)))),
              'applied',
            );
          });
      },
    ),
    L('OL_FINDING_ONLY', 'a question with no on_expiry is never closed by its expiry', async () => {
      const law = 'OL_FINDING_ONLY';
      for (const [label, ms] of [
        ['1 ms before', 25 * MIN - 1],
        ['exactly at', 25 * MIN],
        ['after', 40 * MIN],
      ] as const)
        await on(law, gate(FINDING_ONLY), async (b) => {
          await b.at(ms);
          same(
            law,
            `${label} expires_at: reminder 2`,
            outcome(await b.ledger.lease(RUN, leaseOf(rem(2)))),
            'applied',
          );
          same(
            law,
            `${label} expires_at: the escalation`,
            outcome(await b.ledger.lease(RUN, leaseOf(esc()))),
            'applied',
          );
        });
    }),
    L('OL_UNREADABLE_EXPIRY', 'an expires_at that cannot be read reads as unset', () =>
      on('OL_UNREADABLE_EXPIRY', gate({ ...CLOSING, expires_at: 'not-an-instant' }), async (b) => {
        const law = 'OL_UNREADABLE_EXPIRY';
        await b.at(40 * MIN);
        same(law, 'reminder 2', outcome(await b.ledger.lease(RUN, leaseOf(rem(2)))), 'applied');
        same(law, 'the escalation', outcome(await b.ledger.lease(RUN, leaseOf(esc()))), 'applied');
      }),
    ),
    L(
      'OL_DEFAULT_SCHEDULE',
      'with no authored schedule, one reminder and the escalation',
      async () => {
        const law = 'OL_DEFAULT_SCHEDULE';
        await on(law, gate(), async (b) => {
          same(law, 'occurrence 2', await b.ledger.lease(RUN, leaseOf(rem(2))), {
            applied: false,
            reason: 'not_eligible',
          });
          same(law, 'occurrence 1', outcome(await b.ledger.lease(RUN, leaseOf(rem(1)))), 'applied');
          same(
            law,
            'the escalation',
            outcome(await b.ledger.lease(RUN, leaseOf(esc()))),
            'applied',
          );
        });
        await on(law, gate({ expires_at: iso(T0 + 25 * MIN), on_expiry: 'abort' }), async (b) => {
          await b.at(25 * MIN - 1);
          same(
            law,
            '1 ms before an on_expiry expiry: the escalation',
            outcome(await b.ledger.lease(RUN, leaseOf(esc()))),
            'applied',
          );
          await b.at(25 * MIN);
          same(
            law,
            'past an on_expiry expiry: occurrence 1',
            outcome(await b.ledger.lease(RUN, leaseOf(rem(1)))),
            'applied',
          );
          same(
            law,
            'past an on_expiry expiry: the escalation',
            outcome(await b.ledger.lease(RUN, leaseOf(esc()))),
            'not_eligible',
          );
        });
      },
    ),
    L('OL_DONE', 'after sent and after failed, a lease is outbound_done with the row', () =>
      on('OL_DONE', gate(AUTHORED), async (b) => {
        const law = 'OL_DONE';
        await b.ledger.lease(RUN, leaseOf(rem(1)));
        const sent = await b.ledger.mark(RUN, markOf(rem(1)));
        await b.ledger.lease(RUN, leaseOf(esc()));
        const failed = await b.ledger.mark(RUN, markOf(esc(), 'A', 'failed'));
        await b.at(10 * MIN);
        same(law, 'after sent', await b.ledger.lease(RUN, leaseOf(rem(1), 'B')), {
          applied: false,
          reason: 'outbound_done',
          entry: sent.entry,
        });
        same(law, 'after failed', await b.ledger.lease(RUN, leaseOf(esc())), {
          applied: false,
          reason: 'outbound_done',
          entry: failed.entry,
        });
      }),
    ),
    L('OL_ORDER_ELIGIBILITY_BEFORE_DONE', 'not_eligible is decided before outbound_done', () =>
      on('OL_ORDER_ELIGIBILITY_BEFORE_DONE', gate(CLOSING), async (b) => {
        const law = 'OL_ORDER_ELIGIBILITY_BEFORE_DONE';
        await b.at(10 * MIN);
        await b.ledger.lease(RUN, leaseOf(rem(1)));
        await b.ledger.mark(RUN, markOf(rem(1)));
        await b.at(25 * MIN - 1);
        same(
          law,
          'a sent reminder 1 leased 1 ms before expires_at',
          outcome(await b.ledger.lease(RUN, leaseOf(rem(1)))),
          'outbound_done',
        );
        await b.at(25 * MIN);
        same(
          law,
          'a sent reminder 1 leased at expires_at',
          outcome(await b.ledger.lease(RUN, leaseOf(rem(1)))),
          'not_eligible',
        );
      }),
    ),
    L('OL_ORDER_DONE_BEFORE_SUPERSEDED', 'outbound_done is decided before superseded', () =>
      on('OL_ORDER_DONE_BEFORE_SUPERSEDED', gate(AUTHORED), async (b) => {
        const law = 'OL_ORDER_DONE_BEFORE_SUPERSEDED';
        for (const k of [2, 3]) {
          await b.ledger.lease(RUN, leaseOf(rem(k)));
          await b.ledger.mark(RUN, markOf(rem(k)));
        }
        same(
          law,
          'a lease on 2 with 2 and 3 sent',
          outcome(await b.ledger.lease(RUN, leaseOf(rem(2)))),
          'outbound_done',
        );
      }),
    ),
    L('OL_ORDER_SUPERSEDED_BEFORE_LEASED', 'superseded is decided before already_leased', () =>
      on('OL_ORDER_SUPERSEDED_BEFORE_LEASED', gate(AUTHORED), async (b) => {
        const law = 'OL_ORDER_SUPERSEDED_BEFORE_LEASED';
        await b.ledger.lease(RUN, leaseOf(rem(2)));
        same(
          law,
          'B leases 3',
          outcome(await b.ledger.lease(RUN, leaseOf(rem(3), 'B'))),
          'applied',
        );
        same(law, 'A’s retry on 2', await b.ledger.lease(RUN, leaseOf(rem(2))), {
          applied: false,
          reason: 'superseded',
        });
      }),
    ),
    L(
      'OL_SUPERSEDED',
      'a larger sent or live occurrence supersedes; failed, passed and the escalation do not',
      async () => {
        const law = 'OL_SUPERSEDED';
        await on(law, gate(AUTHORED), async (b) => {
          await b.ledger.lease(RUN, leaseOf(rem(3)));
          await b.ledger.mark(RUN, markOf(rem(3)));
          same(law, '3 sent: a lease on 2', await b.ledger.lease(RUN, leaseOf(rem(2))), {
            applied: false,
            reason: 'superseded',
          });
          same(
            law,
            '3 sent: a lease on 1',
            outcome(await b.ledger.lease(RUN, leaseOf(rem(1)))),
            'superseded',
          );
          same(
            law,
            '3 sent: the escalation',
            outcome(await b.ledger.lease(RUN, leaseOf(esc()))),
            'applied',
          );
        });
        await on(law, gate(AUTHORED), async (b) => {
          await b.ledger.lease(RUN, leaseOf(rem(3), 'B'));
          await b.at(120_000 - 1);
          same(
            law,
            '3 held 1 ms before its deadline: a lease on 2',
            outcome(await b.ledger.lease(RUN, leaseOf(rem(2)))),
            'superseded',
          );
          await b.at(120_000);
          same(
            law,
            '3’s lease passed: a lease on 2',
            outcome(await b.ledger.lease(RUN, leaseOf(rem(2)))),
            'applied',
          );
        });
        await on(law, gate(AUTHORED), async (b) => {
          await b.ledger.lease(RUN, leaseOf(rem(3)));
          await b.ledger.mark(RUN, markOf(rem(3), 'A', 'failed'));
          same(
            law,
            '3 failed: a lease on 2',
            outcome(await b.ledger.lease(RUN, leaseOf(rem(2)))),
            'applied',
          );
        });
        await on(law, gate(AUTHORED), async (b) => {
          await b.ledger.lease(RUN, leaseOf(esc()));
          await b.ledger.mark(RUN, markOf(esc()));
          same(
            law,
            'the escalation sent: a lease on 1',
            outcome(await b.ledger.lease(RUN, leaseOf(rem(1)))),
            'applied',
          );
        });
      },
    ),
    L('OL_MARK', 'every branch of a mark', async () => {
      const law = 'OL_MARK';
      await on(law, gate(AUTHORED), async (b) => {
        same(law, 'no row', await b.ledger.mark(RUN, markOf(rem(1))), {
          applied: false,
          reason: 'lease_lost',
        });
        same(law, 'no row: nothing created', await b.ledger.read(RUN), []);
        const leased = entryOf(law, 'lease', await b.ledger.lease(RUN, leaseOf(rem(1))));
        same(law, 'another token on a pending row', await b.ledger.mark(RUN, markOf(rem(1), 'B')), {
          applied: false,
          reason: 'lease_lost',
          entry: leased,
        });
        await b.at(30_000);
        const sent = await b.ledger.mark(RUN, markOf(rem(1)));
        same(law, 'sent', sent, {
          applied: true,
          entry: {
            ...leased,
            status: 'sent',
            sent_at: iso(T0 + 30_000),
            last_at: iso(T0 + 30_000),
            last_outcome: 'ok',
          },
        });
        same(law, 'the same mark again', await b.ledger.mark(RUN, markOf(rem(1))), {
          applied: false,
          reason: 'already_marked',
          entry: sent.entry,
        });
        same(
          law,
          'the holder, another result',
          outcome(await b.ledger.mark(RUN, markOf(rem(1), 'A', 'failed'))),
          'outbound_done',
        );
        same(law, 'a peer on a finished row', await b.ledger.mark(RUN, markOf(rem(1), 'B')), {
          applied: false,
          reason: 'outbound_done',
          entry: sent.entry,
        });
        const leasedEsc = entryOf(law, 'lease', await b.ledger.lease(RUN, leaseOf(esc())));
        const failed = await b.ledger.mark(
          RUN,
          markOf(esc(), 'A', 'failed', 'refused:channel_not_found'),
        );
        same(law, 'failed', failed, {
          applied: true,
          entry: {
            ...leasedEsc,
            status: 'failed',
            last_at: iso(T0 + 30_000),
            last_outcome: 'refused:channel_not_found',
          },
        });
        same(
          law,
          'the same failed mark again',
          outcome(await b.ledger.mark(RUN, markOf(esc(), 'A', 'failed'))),
          'already_marked',
        );
      });
    }),
    L('OL_OUTCOME_CLOSED', 'an outcome outside the closed set throws', () =>
      on('OL_OUTCOME_CLOSED', gate(AUTHORED), async (b) => {
        const law = 'OL_OUTCOME_CLOSED';
        await b.ledger.lease(RUN, leaseOf(rem(1)));
        const bad: Array<[string, 'sent' | 'failed', string]> = [
          ['ok with failed', 'failed', 'ok'],
          ['refused: with sent', 'sent', 'refused:channel_not_found'],
          ['an unknown word', 'sent', 'maybe'],
          ['an empty code', 'failed', 'refused:'],
          ['a 65-character code', 'failed', `refused:${'a'.repeat(65)}`],
          ['a capital letter', 'failed', 'refused:Channel_not_found'],
        ];
        for (const [label, result, out] of bad)
          await rejects(law, label, b, () =>
            b.ledger.mark(RUN, markOf(rem(1), 'A', result, out as OutboundMarkRequest['outcome'])),
          );
        const ok = await b.ledger.mark(
          RUN,
          markOf(rem(1), 'A', 'failed', `refused:${'a'.repeat(64)}`),
        );
        same(law, 'a 64-character code', ok.entry?.last_outcome, `refused:${'a'.repeat(64)}`);
      }),
    ),
    L(
      'OL_CLOCK_ONE_READING',
      'lease and mark take one raw reading; read and the purge pair take none',
      () =>
        on('OL_CLOCK_ONE_READING', undefined, async (b) => {
          const law = 'OL_CLOCK_ONE_READING';
          // The run is stamped 3 s ahead of the clock: a reading floored by it would be lifted.
          await b.seed(gate(AUTHORED), RUN, { updated_at: iso(T0 + 3_000) });
          const spent = async <T>(call: () => Promise<T>): Promise<[T, number]> => {
            const before = b.reads();
            const value = await call();
            return [value, b.reads() - before];
          };
          const [leased, l1] = await spent(() => b.ledger.lease(RUN, leaseOf(rem(1))));
          same(
            law,
            'an applied lease',
            {
              reads: l1,
              deadline: leased.entry?.lease_deadline,
              created: leased.entry?.created_at,
            },
            {
              reads: 1,
              deadline: iso(T0 + 120_000),
              created: iso(T0),
            },
          );
          same(
            law,
            'a refused lease',
            (await spent(() => b.ledger.lease(RUN, leaseOf(rem(1), 'B'))))[1],
            1,
          );
          same(
            law,
            'a lease on an absent run',
            (await spent(() => b.ledger.lease('run-outbound-absent', leaseOf(rem(1)))))[1],
            1,
          );
          const [marked, m1] = await spent(() => b.ledger.mark(RUN, markOf(rem(1))));
          same(
            law,
            'an applied mark',
            { reads: m1, last_at: marked.entry?.last_at },
            { reads: 1, last_at: iso(T0) },
          );
          same(
            law,
            'a refused mark',
            (await spent(() => b.ledger.mark(RUN, markOf(rem(2)))))[1],
            1,
          );
          same(law, 'read', (await spent(() => b.ledger.read(RUN)))[1], 0);
          same(law, 'statAllForRun', (await spent(() => b.ledger.statAllForRun(RUN)))[1], 0);
          await b.ledger.lease(RUN, leaseOf(esc()));
          const rows = await b.ledger.read(RUN);
          b.failClock(true);
          let threw = 0;
          for (const call of [
            () => b.ledger.lease(RUN, leaseOf(rem(3))),
            () => b.ledger.mark(RUN, markOf(esc())),
          ])
            await call().catch(() => (threw += 1));
          b.failClock(false);
          same(law, 'a throwing clock: lease and mark throw', threw, 2);
          same(law, 'a throwing clock: nothing written', await b.ledger.read(RUN), rows);
          same(law, 'deleteAllForRun', (await spent(() => b.ledger.deleteAllForRun(RUN)))[1], 0);
        }),
    ),
    L('OL_NO_RUN_WRITE', 'leases and marks leave the run’s version and updated_at unchanged', () =>
      on('OL_NO_RUN_WRITE', gate(AUTHORED), async (b) => {
        const law = 'OL_NO_RUN_WRITE';
        const stamp = async () => {
          const { record } = await b.store.get(RUN);
          return { version: record.version, updated_at: record.updated_at };
        };
        const before = await stamp();
        await b.at(10 * MIN);
        await b.ledger.lease(RUN, leaseOf(rem(1)));
        await b.ledger.lease(RUN, leaseOf(rem(1), 'B'));
        await b.ledger.mark(RUN, markOf(rem(1)));
        await b.ledger.mark(RUN, markOf(rem(1)));
        same(law, 'the run', await stamp(), before);
      }),
    ),
    L('OL_VIEW', 'no entry carries lease_token; read orders by created_at, then entry_key', () =>
      on('OL_VIEW', gate(AUTHORED), async (b) => {
        const law = 'OL_VIEW';
        const results: OutboundResult[] = [];
        results.push(await b.ledger.lease(RUN, leaseOf(rem(2))));
        results.push(await b.ledger.lease(RUN, leaseOf(rem(2))));
        results.push(await b.ledger.lease(RUN, leaseOf(rem(2), 'B')));
        results.push(await b.ledger.mark(RUN, markOf(rem(2), 'B')));
        results.push(await b.ledger.mark(RUN, markOf(rem(2), 'A', 'failed')));
        results.push(await b.ledger.mark(RUN, markOf(rem(2), 'A', 'failed')));
        results.push(await b.ledger.lease(RUN, leaseOf(rem(2))));
        results.push(await b.ledger.lease(RUN, leaseOf(esc())));
        await b.at(MIN);
        results.push(await b.ledger.lease(RUN, leaseOf(rem(1))));
        const read = await b.ledger.read(RUN);
        same(
          law,
          'entries carrying lease_token',
          [...results.map((r) => r.entry), ...read].filter(
            (e) => e !== undefined && 'lease_token' in e,
          ),
          [],
        );
        same(law, 'the entries checked', results.filter((r) => r.entry !== undefined).length, 9);
        same(
          law,
          'the order',
          read.map((e) => [e.created_at, e.entry_key]),
          [
            [iso(T0), `gate:${GATE}:escalation`],
            [iso(T0), `gate:${GATE}:reminder:2`],
            [iso(T0 + MIN), `gate:${GATE}:reminder:1`],
          ],
        );
      }),
    ),
    L('OL_PURGE', 'the purge pair: preview equals receipt, the rows are gone, others stay', () =>
      on('OL_PURGE', gate(AUTHORED), async (b) => {
        const law = 'OL_PURGE';
        await b.seed(gate(AUTHORED), OTHER_RUN);
        for (const run of [RUN, OTHER_RUN]) {
          await b.ledger.lease(run, leaseOf(rem(1)));
          await b.ledger.mark(run, markOf(rem(1)));
          await b.ledger.lease(run, leaseOf(rem(2)));
          await b.ledger.mark(run, markOf(rem(2), 'A', 'failed'));
          await b.ledger.lease(run, leaseOf(rem(3)));
          await b.ledger.lease(run, leaseOf(esc()));
        }
        const other = await b.ledger.read(OTHER_RUN);
        same(
          law,
          'the seeded rows',
          (await b.ledger.read(RUN)).map((e) => [e.entry_key, e.status, e.last_outcome ?? null]),
          [
            [`gate:${GATE}:escalation`, 'pending', null],
            [`gate:${GATE}:reminder:1`, 'sent', 'ok'],
            [`gate:${GATE}:reminder:2`, 'failed', 'refused:channel_not_found'],
            [`gate:${GATE}:reminder:3`, 'pending', null],
          ],
        );
        const preview = await b.ledger.statAllForRun(RUN);
        const receipt = await b.ledger.deleteAllForRun(RUN);
        same(
          law,
          'preview equals receipt, and is positive',
          {
            equal: preview.bytes === receipt.bytes_deleted,
            positive: preview.bytes > 0,
          },
          { equal: true, positive: true },
        );
        same(
          law,
          'after the delete',
          {
            rows: await b.ledger.read(RUN),
            stat: await b.ledger.statAllForRun(RUN),
            again: await b.ledger.deleteAllForRun(RUN),
          },
          { rows: [], stat: { bytes: 0 }, again: { bytes_deleted: 0 } },
        );
        same(law, 'another run’s rows stay', await b.ledger.read(OTHER_RUN), other);
        same(
          law,
          'an absent run',
          {
            stat: await b.ledger.statAllForRun('run-outbound-absent'),
            delete: await b.ledger.deleteAllForRun('run-outbound-absent'),
          },
          { stat: { bytes: 0 }, delete: { bytes_deleted: 0 } },
        );
      }),
    ),
  ];
}

/** The family's cases, one per law in {@link OUTBOUND_LEDGER_LAWS}, in that order. */
export function outboundLedgerContract(
  adapter: OutboundLedgerContractAdapter,
): OutboundLedgerContractCase[] {
  return family(adapter);
}
