// take-back-contract.ts — issue #729, the claim window, unit CW-3b (design record C5 §4.4): the laws of
// the engine's automatic take-back of a step whose claim's lease no program holds, as their own family,
// beside `leasedClaimContract`.
//
// Each case builds its own store through the adapter, with the lease double as its lease port, and
// takes its claims' leases from that store's port (`store.leases.hold()`), as a drive does. It sets a
// lease's state through the double and reads what was written from the answer and from a fresh `get`.
import {
  reclaimStep,
  takeBackStep,
  type Attributed,
  type LeaseHold,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import type { LeaseDouble, LeaseDoubleState } from './lease-double.js';

/**
 * The laws, by name:
 * - `TB_TAKES_NOT_HELD` — a claim whose lease no program holds is taken back: the step leaves
 *   `in_progress_steps` and `claims`, and one audit entry is written, by the taker (`driven_by`), with
 *   `reason: 'lease_not_held'`, the prior state `claim_stale`, the prior deadline, when it was taken
 *   back, and the claim as it was without its token (`prior_claim`); no `conditions_discharged`.
 * - `TB_KEEPS_HELD` — a claim whose lease is held is not taken back (`lease_held`); nothing is written.
 * - `TB_KEEPS_ABSENT` — a claim whose lease file is gone is not taken back (`lease_absent`).
 * - `TB_KEEPS_UNKNOWN` — a claim whose lease cannot be checked is not taken back (`lease_unknown`),
 *   with the probe's reason (`not_checked`).
 * - `TB_RACE_OTHER_WRITE` — another step's write lands between the taker's read and its write: the
 *   re-read shows the same claim, still not held and below the cap, so it is taken back, once.
 * - `TB_RACE_TAKEN` — two takers read the same claim and the first takes it back: the second answers
 *   `not_in_progress`; one entry, one removal.
 * - `TB_RACE_RETAKEN` — as `TB_RACE_TAKEN`, but the first then claims the step again under a lease no
 *   program holds: the second answers `changed`, and the first's claim stays.
 * - `TB_CAP` — a step taken back once is not taken back again (`at_cap`) until a person reclaims it.
 * - `TB_KEEPS_UNLEASED` — a claim that names no lease is never taken back (`unleased`).
 * - `TB_OWN_GATE` — the step of the open question is not taken back (`open_gate`), though the gate's
 *   claim keeps its token.
 * - `TB_OTHER_GATE` — a question open on another step does not stop a take-back.
 */
export const TAKE_BACK_LAWS = [
  'TB_TAKES_NOT_HELD',
  'TB_KEEPS_HELD',
  'TB_KEEPS_ABSENT',
  'TB_KEEPS_UNKNOWN',
  'TB_RACE_OTHER_WRITE',
  'TB_RACE_TAKEN',
  'TB_RACE_RETAKEN',
  'TB_CAP',
  'TB_KEEPS_UNLEASED',
  'TB_OWN_GATE',
  'TB_OTHER_GATE',
] as const;

export type TakeBackLaw = (typeof TAKE_BACK_LAWS)[number];

/** One store a case runs against, which the adapter built with the lease double as its lease port. */
export interface TakeBackTestStore {
  /** The store, with the lease double as its lease port (`store.leases`). */
  readonly store: RunStore;
  /** The lease double the store was given: a case sets its leases' states through it. */
  readonly leases: LeaseDouble;
  dispose(): Promise<void>;
}

/** Adapter a calling test file supplies to run the family against one kind of store. */
export interface TakeBackContractAdapter {
  /** A name for the store, at the start of each case's `name`. */
  storeName: string;
  /** Builds a fresh store with the lease double as its lease port. */
  makeStore(): Promise<TakeBackTestStore>;
}

export interface TakeBackContractCase {
  law: TakeBackLaw;
  name: string;
  run: () => Promise<void>;
}

const WF = 'wf-take-back';
/** Two agent steps any run can claim. */
const FIRST = 'first';
const SECOND = 'second';
const DEFINITION: WorkflowDefinition = {
  id: WF,
  name: 'take-back contract',
  version: 1,
  steps: {
    [FIRST]: { description: 'f', execution: 'agent', depends_on: [] },
    [SECOND]: { description: 's', execution: 'agent', depends_on: [] },
  },
};
const PLAIN = { workflowId: WF, workflowVersion: 1, params: {} };
/** The program whose claim is taken back, and the two that take steps back. */
const HOLDER: Attributed = { by: 'holder-program', by_source: 'stated', channel: 'agent' };
const TAKER: Attributed = { by: 'taker-program', by_source: 'stated', channel: 'agent' };
const SECOND_TAKER: Attributed = { by: 'second-taker', by_source: 'stated', channel: 'agent' };

/** Runs one law with a fresh store; any failure names the law. */
function lawCase(
  law: TakeBackLaw,
  name: string,
  adapter: TakeBackContractAdapter,
  body: (t: TakeBackTestStore) => Promise<void>,
): TakeBackContractCase {
  return {
    law,
    name: `${adapter.storeName}: ${name}`,
    run: async () => {
      const t = await adapter.makeStore();
      try {
        await body(t);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw message.startsWith(`${law}: `)
          ? err
          : new Error(`${law}: ${message}`, { cause: err });
      } finally {
        await t.dispose();
      }
    },
  };
}

/** A hold from the store's own port; a store whose port cannot make one fails the case. */
async function holdOf(law: TakeBackLaw, store: RunStore): Promise<LeaseHold> {
  const leases = store.leases;
  if (leases === undefined || leases === null) {
    throw new Error(`${law}: the store has no lease port (store.leases is ${String(leases)})`);
  }
  const made = await leases.hold();
  if (!('held' in made)) {
    throw new Error(`${law}: the store's port could not make a lease (${made.unavailable})`);
  }
  return made.held;
}

/**
 * `step` claimed by HOLDER under a lease from the store's port, set to `state` in the double; the
 * claim's token (a store with leases writes one).
 */
async function leasedClaim(
  law: TakeBackLaw,
  t: TakeBackTestStore,
  runId: string,
  step: string,
  state: LeaseDoubleState,
): Promise<string> {
  const hold = await holdOf(law, t.store);
  const { record } = await t.store.claimStep(runId, step, DEFINITION, HOLDER, hold);
  const token = record.claims?.[step]?.token;
  if (token === undefined || record.claims?.[step]?.lease?.id !== hold.id) {
    throw new Error(
      `${law}: the claim of '${step}' carries no token or does not name the lease (${JSON.stringify(record.claims?.[step])})`,
    );
  }
  t.leases.set(hold.id, state);
  return token;
}

/** A run with FIRST claimed under a lease in `state`: its id and the claim's token. */
async function runWithClaim(
  law: TakeBackLaw,
  t: TakeBackTestStore,
  state: LeaseDoubleState,
): Promise<{ runId: string; token: string }> {
  const { record: run } = await t.store.create(PLAIN);
  return { runId: run.id, token: await leasedClaim(law, t, run.id, FIRST, state) };
}

/** What an answer says, for a law's message: its kind and, when not taken, why. */
function said(answer: { kind: string; reason?: string; unknown?: string }): string {
  if (answer.kind !== 'not_taken') return answer.kind;
  return answer.unknown !== undefined
    ? `not_taken ${answer.reason} (${answer.unknown})`
    : `not_taken ${answer.reason}`;
}

/** The step's automatic take-back entries in the stored run. */
async function takeBackEntriesOf(store: RunStore, runId: string, step: string) {
  return (await store.get(runId)).record.evidence.filter(
    (e) =>
      e.step_id === step &&
      e.output_summary?.['reclaimed'] === true &&
      e.output_summary['reason'] === 'lease_not_held',
  );
}

/** A not-taken law: the answer, and the run's version unmoved. */
async function keeps(
  law: TakeBackLaw,
  t: TakeBackTestStore,
  state: LeaseDoubleState,
  want: string,
): Promise<void> {
  const { runId, token } = await runWithClaim(law, t, state);
  const before = (await t.store.get(runId)).record.version;
  const answer = await takeBackStep(t.store, runId, FIRST, { expectToken: token, drivenBy: TAKER });
  const after = (await t.store.get(runId)).record;
  if (
    said(answer) !== want ||
    after.version !== before ||
    !after.in_progress_steps.includes(FIRST)
  ) {
    throw new Error(
      `${law}: the take-back answered ${said(answer)}, not ${want}; the run's version went ${before} → ${after.version}, and the step is ${after.in_progress_steps.includes(FIRST) ? '' : 'not '}in progress`,
    );
  }
}

/**
 * The store, with its `update` held back by `before`, which runs once, at the first `update`, before
 * the write is handed on. Every other member is the store's own, its methods bound to the store (a
 * store with private fields refuses a method called on anything else).
 */
function withHeldUpdate(store: RunStore, before: () => Promise<void>): RunStore {
  let first = true;
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'update') {
        return async (record: Parameters<RunStore['update']>[0]) => {
          if (first) {
            first = false;
            await before();
          }
          return target.update(record);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * Two takers of FIRST's claim: the second (through `withHeldUpdate`) reads it, and its write waits
 * while the first takes the step back and then runs `between`. The answers, first and second.
 */
async function twoTakers(
  t: TakeBackTestStore,
  runId: string,
  token: string,
  between: () => Promise<void>,
) {
  let reached!: () => void;
  const reachedWrite = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const held = withHeldUpdate(t.store, async () => {
    reached();
    await released;
  });
  const second = takeBackStep(held, runId, FIRST, {
    expectToken: token,
    drivenBy: SECOND_TAKER,
  });
  await reachedWrite;
  const first = await takeBackStep(t.store, runId, FIRST, { expectToken: token, drivenBy: TAKER });
  await between();
  release();
  return { first, second: await second };
}

/** The laws of the automatic take-back, one case per law, for the given adapter. */
export function takeBackContract(adapter: TakeBackContractAdapter): TakeBackContractCase[] {
  const L = (law: TakeBackLaw, name: string, body: (t: TakeBackTestStore) => Promise<void>) =>
    lawCase(law, name, adapter, body);
  return [
    L(
      'TB_TAKES_NOT_HELD',
      'a claim whose lease no program holds is taken back, with one entry written by the taker',
      async (t) => {
        const { runId, token } = await runWithClaim('TB_TAKES_NOT_HELD', t, 'dead');
        const claim = (await t.store.get(runId)).record.claims?.[FIRST];
        const answer = await takeBackStep(t.store, runId, FIRST, {
          expectToken: token,
          drivenBy: TAKER,
        });
        const read = (await t.store.get(runId)).record;
        if (answer.kind !== 'taken_back' || answer.snapshot.record.version !== read.version) {
          throw new Error(
            `TB_TAKES_NOT_HELD: the take-back answered ${said(answer)} at version ${answer.snapshot.record.version}, not taken_back at the stored version ${read.version}`,
          );
        }
        if (read.in_progress_steps.includes(FIRST) || read.claims?.[FIRST] !== undefined) {
          throw new Error(
            `TB_TAKES_NOT_HELD: the step is still in progress or claimed (${JSON.stringify(read.claims?.[FIRST])})`,
          );
        }
        const entries = read.evidence.filter((e) => e.step_id === FIRST);
        const entry = entries[entries.length - 1];
        const { token: _token, ...withoutToken } = claim ?? {};
        const summary = entry?.output_summary ?? {};
        const want = {
          entries: 1,
          reclaimed: true,
          reason: 'lease_not_held',
          prior_state: 'claim_stale',
          prior_deadline: claim?.deadline ?? null,
          reclaimed_at: 'a string',
          prior_claim: JSON.stringify(withoutToken),
          conditions_discharged: 'none',
          driven_by: JSON.stringify(TAKER),
        };
        const got = {
          entries: entries.length,
          reclaimed: summary['reclaimed'],
          reason: summary['reason'],
          prior_state: summary['prior_state'],
          prior_deadline: summary['prior_deadline'],
          reclaimed_at:
            typeof summary['reclaimed_at'] === 'string' ? 'a string' : summary['reclaimed_at'],
          prior_claim: JSON.stringify(summary['prior_claim']),
          conditions_discharged: 'conditions_discharged' in summary ? 'present' : 'none',
          driven_by: JSON.stringify(entry?.driven_by),
        };
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          throw new Error(
            `TB_TAKES_NOT_HELD: the entry written is ${JSON.stringify(got)}, not ${JSON.stringify(want)}`,
          );
        }
      },
    ),
    L('TB_KEEPS_HELD', 'a claim whose lease is held is not taken back', (t) =>
      keeps('TB_KEEPS_HELD', t, 'live', 'not_taken lease_held'),
    ),
    L('TB_KEEPS_ABSENT', 'a claim whose lease file is gone is not taken back', (t) =>
      keeps('TB_KEEPS_ABSENT', t, 'removed', 'not_taken lease_absent'),
    ),
    L(
      'TB_KEEPS_UNKNOWN',
      'a claim whose lease cannot be checked is not taken back, and says why',
      (t) =>
        keeps(
          'TB_KEEPS_UNKNOWN',
          t,
          { forced: { state: 'unknown', basis: 'kernel_lock', reason: 'not_checked' } },
          'not_taken lease_unknown (not_checked)',
        ),
    ),
    L(
      'TB_RACE_OTHER_WRITE',
      'another step’s write between the read and the write: the re-read is judged, and the step is taken back once',
      async (t) => {
        const { runId, token } = await runWithClaim('TB_RACE_OTHER_WRITE', t, 'dead');
        const held = withHeldUpdate(t.store, async () => {
          await t.store.claimStep(runId, SECOND, DEFINITION);
        });
        const answer = await takeBackStep(held, runId, FIRST, {
          expectToken: token,
          drivenBy: TAKER,
        });
        const read = (await t.store.get(runId)).record;
        const entries = await takeBackEntriesOf(t.store, runId, FIRST);
        if (
          answer.kind !== 'taken_back' ||
          entries.length !== 1 ||
          read.in_progress_steps.includes(FIRST) ||
          !read.in_progress_steps.includes(SECOND)
        ) {
          throw new Error(
            `TB_RACE_OTHER_WRITE: the take-back answered ${said(answer)} with ${entries.length} take-back entries; in progress: ${JSON.stringify(read.in_progress_steps)} (want taken_back, 1 entry, only '${SECOND}')`,
          );
        }
      },
    ),
    L(
      'TB_RACE_TAKEN',
      'two takers of one claim: the second finds the step taken back and writes nothing',
      async (t) => {
        const { runId, token } = await runWithClaim('TB_RACE_TAKEN', t, 'dead');
        const { first, second } = await twoTakers(t, runId, token, async () => {});
        const read = (await t.store.get(runId)).record;
        const entries = await takeBackEntriesOf(t.store, runId, FIRST);
        if (
          first.kind !== 'taken_back' ||
          said(second) !== 'not_taken not_in_progress' ||
          entries.length !== 1 ||
          read.in_progress_steps.includes(FIRST)
        ) {
          throw new Error(
            `TB_RACE_TAKEN: the first answered ${said(first)} and the second ${said(second)}, with ${entries.length} take-back entries (want taken_back, not_taken not_in_progress, 1)`,
          );
        }
      },
    ),
    L(
      'TB_RACE_RETAKEN',
      'two takers of one claim, and the first claims the step again: the second answers changed and leaves the new claim',
      async (t) => {
        const { runId, token } = await runWithClaim('TB_RACE_RETAKEN', t, 'dead');
        let retaken = '';
        const { first, second } = await twoTakers(t, runId, token, async () => {
          retaken = await leasedClaim('TB_RACE_RETAKEN', t, runId, FIRST, 'dead');
        });
        const read = (await t.store.get(runId)).record;
        const entries = await takeBackEntriesOf(t.store, runId, FIRST);
        if (
          first.kind !== 'taken_back' ||
          second.kind !== 'changed' ||
          entries.length !== 1 ||
          !read.in_progress_steps.includes(FIRST) ||
          read.claims?.[FIRST]?.token !== retaken
        ) {
          throw new Error(
            `TB_RACE_RETAKEN: the first answered ${said(first)} and the second ${said(second)}, with ${entries.length} take-back entries; the step is ${read.in_progress_steps.includes(FIRST) ? '' : 'not '}in progress, ${read.claims?.[FIRST]?.token === retaken ? 'under' : 'not under'} the first's new claim (want taken_back, changed, 1, the new claim kept)`,
          );
        }
      },
    ),
    L(
      'TB_CAP',
      'a step taken back once is not taken back again until a person reclaims it',
      async (t) => {
        const { runId, token } = await runWithClaim('TB_CAP', t, 'dead');
        const take = async (expectToken: string) =>
          said(await takeBackStep(t.store, runId, FIRST, { expectToken, drivenBy: TAKER }));
        const answers = [await take(token)];
        answers.push(await take(await leasedClaim('TB_CAP', t, runId, FIRST, 'dead')));
        answers.push((await reclaimStep(t.store, runId, FIRST)).outcome);
        answers.push(await take(await leasedClaim('TB_CAP', t, runId, FIRST, 'dead')));
        const want = ['taken_back', 'not_taken at_cap', 'reclaimed', 'taken_back'];
        if (JSON.stringify(answers) !== JSON.stringify(want)) {
          throw new Error(
            `TB_CAP: a take-back, a second, a person's reclaim and a third answered ${JSON.stringify(answers)}, not ${JSON.stringify(want)}`,
          );
        }
      },
    ),
    L('TB_KEEPS_UNLEASED', 'a claim that names no lease is never taken back', async (t) => {
      const { record: run } = await t.store.create(PLAIN);
      const { record } = await t.store.claimStep(run.id, FIRST, DEFINITION, HOLDER);
      const token = record.claims?.[FIRST]?.token;
      if (token === undefined) {
        throw new Error('TB_KEEPS_UNLEASED: the claim carries no token');
      }
      const answer = await takeBackStep(t.store, run.id, FIRST, {
        expectToken: token,
        drivenBy: TAKER,
      });
      const read = (await t.store.get(run.id)).record;
      if (said(answer) !== 'not_taken unleased' || read.version !== record.version) {
        throw new Error(
          `TB_KEEPS_UNLEASED: the take-back answered ${said(answer)}, not not_taken unleased; the run's version went ${record.version} → ${read.version}`,
        );
      }
    }),
    L('TB_OWN_GATE', 'the step of the open question is not taken back', async (t) => {
      const { runId, token } = await runWithClaim('TB_OWN_GATE', t, 'dead');
      const opened = await t.store.settleStep(
        runId,
        {
          kind: 'open_gate',
          step: FIRST,
          claimToken: token,
          pendingGate: {
            gate_id: 'g-take-back',
            step_name: FIRST,
            preview: {},
            choices: ['approve', 'reject'],
          },
          evidence: [],
        },
        DEFINITION,
      );
      if (!opened.applied) {
        throw new Error(`TB_OWN_GATE: the gate did not open (${opened.reason})`);
      }
      const answer = await takeBackStep(t.store, runId, FIRST, {
        expectToken: token,
        drivenBy: TAKER,
      });
      const read = (await t.store.get(runId)).record;
      if (said(answer) !== 'not_taken open_gate' || read.version !== opened.run.version) {
        throw new Error(
          `TB_OWN_GATE: the take-back answered ${said(answer)}, not not_taken open_gate; the run's version went ${opened.run.version} → ${read.version}`,
        );
      }
    }),
    L('TB_OTHER_GATE', 'a question open on another step does not stop a take-back', async (t) => {
      const { runId, token } = await runWithClaim('TB_OTHER_GATE', t, 'dead');
      const { record } = await t.store.claimStep(runId, SECOND, DEFINITION);
      const opened = await t.store.settleStep(
        runId,
        {
          kind: 'open_gate',
          step: SECOND,
          ...(record.claims?.[SECOND]?.token !== undefined
            ? { claimToken: record.claims[SECOND].token }
            : {}),
          pendingGate: {
            gate_id: 'g-other-step',
            step_name: SECOND,
            preview: {},
            choices: ['approve', 'reject'],
          },
          evidence: [],
        },
        DEFINITION,
      );
      if (!opened.applied) {
        throw new Error(`TB_OTHER_GATE: the gate did not open (${opened.reason})`);
      }
      const answer = await takeBackStep(t.store, runId, FIRST, {
        expectToken: token,
        drivenBy: TAKER,
      });
      if (answer.kind !== 'taken_back') {
        throw new Error(
          `TB_OTHER_GATE: with a question open on '${SECOND}', the take-back of '${FIRST}' answered ${said(answer)}, not taken_back`,
        );
      }
    }),
  ];
}
