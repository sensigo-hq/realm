// leased-claim-contract.ts — issue #729, the claim window, unit CW-2a (design record C5 §4.3): the laws
// of a store with claim leases about a claim taken under a lease its caller holds, as their own
// family, beside `leasePortContract` and `leaseFactsContract`.
//
// Each case builds its own store through the adapter and takes its holds from that store's own lease
// port (`store.leases.hold()`), as a drive does. It reads what the store wrote from the record the
// store returns and from a fresh `get`.
import {
  WorkflowError,
  type LeaseHold,
  type RunRecord,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';

/**
 * The laws, by name:
 * - `LC_CLAIM_NAMES_HOLD` — `claimStep` given a hold writes `lease: { id }` in the claim it takes,
 *   with the hold's id, in the same write.
 * - `LC_NO_HOLD_NO_LEASE` — `claimStep` given no hold writes a claim that names no lease.
 * - `LC_ONE_CLAIM_PER_HOLD` — a hold names at most one claim: after a call with it wrote a claim, a
 *   second call with it — for another step of the run, or for a step of another run — throws
 *   `ENGINE_INTERNAL`, and neither run changes.
 * - `LC_REFUSED_CLAIM_USES_HOLD` — a call refused for its step (already claimed) still uses its hold:
 *   a later call with it, for a step that could be claimed, throws `ENGINE_INTERNAL` and writes
 *   nothing.
 * - `LC_GATE_KEEPS_NO_LEASE` — a gate opened on a claim taken under a lease keeps that claim with no
 *   `lease`, in the same write; its token and the rest of the claim stay, and the step stays in
 *   progress.
 */
export const LEASED_CLAIM_LAWS = [
  'LC_CLAIM_NAMES_HOLD',
  'LC_NO_HOLD_NO_LEASE',
  'LC_ONE_CLAIM_PER_HOLD',
  'LC_REFUSED_CLAIM_USES_HOLD',
  'LC_GATE_KEEPS_NO_LEASE',
] as const;

export type LeasedClaimLaw = (typeof LEASED_CLAIM_LAWS)[number];

/** One store a case runs against, which the adapter built with a lease port. */
export interface LeasedClaimTestStore {
  /** The store, with its lease port (`store.leases`), which the cases take their holds from. */
  readonly store: RunStore;
  dispose(): Promise<void>;
}

/** Adapter a calling test file supplies to run the family against one kind of store. */
export interface LeasedClaimContractAdapter {
  /** A name for the store, at the start of each case's `name`. */
  storeName: string;
  /** Builds a fresh store with a lease port. */
  makeStore(): Promise<LeasedClaimTestStore>;
}

export interface LeasedClaimContractCase {
  law: LeasedClaimLaw;
  name: string;
  run: () => Promise<void>;
}

const WF = 'wf-leased-claim';
/** Two steps any run can claim, one after the other. */
const FIRST = 'first';
const SECOND = 'second';
const DEFINITION: WorkflowDefinition = {
  id: WF,
  name: 'leased claim contract',
  version: 1,
  steps: {
    [FIRST]: { description: 'f', execution: 'agent', depends_on: [] },
    [SECOND]: { description: 's', execution: 'agent', depends_on: [] },
  },
};
const PLAIN = { workflowId: WF, workflowVersion: 1, params: {} };

/** A hold from the store's own port; a store whose port cannot make one fails the case. */
async function holdOf(law: LeasedClaimLaw, store: RunStore): Promise<LeaseHold> {
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

/** What a call threw, as the law's message names it. */
function thrownBy(call: () => Promise<unknown>): Promise<string> {
  return call().then(
    () => 'nothing (the call resolved)',
    (err: unknown) =>
      err instanceof WorkflowError ? (err.code ?? 'a WorkflowError with no code') : String(err),
  );
}

/** Runs one law with a fresh store; any failure names the law. */
function lawCase(
  law: LeasedClaimLaw,
  name: string,
  adapter: LeasedClaimContractAdapter,
  body: (store: RunStore) => Promise<void>,
): LeasedClaimContractCase {
  return {
    law,
    name: `${adapter.storeName}: ${name}`,
    run: async () => {
      const t = await adapter.makeStore();
      try {
        await body(t.store);
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

/** The versions of `runs`, read afresh. */
async function versionsOf(store: RunStore, runs: readonly RunRecord[]): Promise<number[]> {
  return Promise.all(runs.map(async (r) => (await store.get(r.id)).record.version));
}

/** The laws of a claim taken under a lease, one case per law, for the given adapter. */
export function leasedClaimContract(
  adapter: LeasedClaimContractAdapter,
): LeasedClaimContractCase[] {
  const L = (law: LeasedClaimLaw, name: string, body: (store: RunStore) => Promise<void>) =>
    lawCase(law, name, adapter, body);
  return [
    L(
      'LC_CLAIM_NAMES_HOLD',
      'claimStep given a hold writes the hold’s id in the claim',
      async (store) => {
        const { record: run } = await store.create(PLAIN);
        const hold = await holdOf('LC_CLAIM_NAMES_HOLD', store);
        const { record: returned } = await store.claimStep(
          run.id,
          FIRST,
          DEFINITION,
          undefined,
          hold,
        );
        const { record: read } = await store.get(run.id);
        const seen = [returned, read].map((r) => JSON.stringify(r.claims?.[FIRST]?.lease));
        const want = JSON.stringify({ id: hold.id });
        if (seen[0] !== want || seen[1] !== want) {
          throw new Error(
            `LC_CLAIM_NAMES_HOLD: the claim names ${seen[0] ?? 'no lease'} in the record claimStep ` +
              `returned and ${seen[1] ?? 'no lease'} in a fresh get, not ${want}`,
          );
        }
      },
    ),
    L(
      'LC_NO_HOLD_NO_LEASE',
      'claimStep given no hold writes a claim that names no lease',
      async (store) => {
        const { record: run } = await store.create(PLAIN);
        await store.claimStep(run.id, FIRST, DEFINITION);
        const claim = (await store.get(run.id)).record.claims?.[FIRST];
        if (claim === undefined || Object.hasOwn(claim, 'lease')) {
          throw new Error(
            `LC_NO_HOLD_NO_LEASE: ${claim === undefined ? 'no claim was written' : `the claim names a lease (${JSON.stringify(claim.lease)})`}`,
          );
        }
      },
    ),
    L(
      'LC_ONE_CLAIM_PER_HOLD',
      'a second claimStep with a hold already used throws, for another step or another run, and writes nothing',
      async (store) => {
        const { record: one } = await store.create(PLAIN);
        const { record: two } = await store.create(PLAIN);
        const hold = await holdOf('LC_ONE_CLAIM_PER_HOLD', store);
        await store.claimStep(one.id, FIRST, DEFINITION, undefined, hold);
        const before = await versionsOf(store, [one, two]);
        const otherStep = await thrownBy(() =>
          store.claimStep(one.id, SECOND, DEFINITION, undefined, hold),
        );
        const otherRun = await thrownBy(() =>
          store.claimStep(two.id, FIRST, DEFINITION, undefined, hold),
        );
        const after = await versionsOf(store, [one, two]);
        if (
          otherStep !== 'ENGINE_INTERNAL' ||
          otherRun !== 'ENGINE_INTERNAL' ||
          JSON.stringify(after) !== JSON.stringify(before)
        ) {
          throw new Error(
            `LC_ONE_CLAIM_PER_HOLD: a second use for another step threw ${otherStep}, for another run ` +
              `threw ${otherRun}, not ENGINE_INTERNAL each; the runs' versions went from ` +
              `${before.join(', ')} to ${after.join(', ')}`,
          );
        }
      },
    ),
    L(
      'LC_REFUSED_CLAIM_USES_HOLD',
      'a claimStep refused for its step uses its hold: a later call with it throws and writes nothing',
      async (store) => {
        const { record: run } = await store.create(PLAIN);
        await store.claimStep(run.id, FIRST, DEFINITION);
        const hold = await holdOf('LC_REFUSED_CLAIM_USES_HOLD', store);
        const refused = await thrownBy(() =>
          store.claimStep(run.id, FIRST, DEFINITION, undefined, hold),
        );
        const [before] = await versionsOf(store, [run]);
        const later = await thrownBy(() =>
          store.claimStep(run.id, SECOND, DEFINITION, undefined, hold),
        );
        const after = (await store.get(run.id)).record;
        if (
          refused !== 'STATE_STEP_ALREADY_CLAIMED' ||
          later !== 'ENGINE_INTERNAL' ||
          after.version !== before ||
          after.in_progress_steps.includes(SECOND)
        ) {
          throw new Error(
            `LC_REFUSED_CLAIM_USES_HOLD: the refused call threw ${refused} (not ` +
              `STATE_STEP_ALREADY_CLAIMED); the later call threw ${later} (not ENGINE_INTERNAL); the ` +
              `version went from ${String(before)} to ${after.version}, and ${SECOND} is ` +
              `${after.in_progress_steps.includes(SECOND) ? '' : 'not '}in progress`,
          );
        }
      },
    ),
    L(
      'LC_GATE_KEEPS_NO_LEASE',
      'a gate opened on a leased claim keeps the claim with no lease, its token and the rest unchanged',
      async (store) => {
        const { record: run } = await store.create(PLAIN);
        const hold = await holdOf('LC_GATE_KEEPS_NO_LEASE', store);
        const { record: claimed } = await store.claimStep(
          run.id,
          FIRST,
          DEFINITION,
          undefined,
          hold,
        );
        const before = claimed.claims?.[FIRST];
        if (before?.lease?.id !== hold.id) {
          throw new Error(
            `LC_GATE_KEEPS_NO_LEASE: the claim did not name the hold before the gate (it names ${JSON.stringify(before?.lease)})`,
          );
        }
        const opened = await store.settleStep(
          run.id,
          {
            kind: 'open_gate',
            step: FIRST,
            ...(before.token !== undefined ? { claimToken: before.token } : {}),
            pendingGate: {
              gate_id: 'g-leased-claim',
              step_name: FIRST,
              preview: {},
              choices: ['approve', 'reject'],
            },
            evidence: [],
          },
          DEFINITION,
        );
        if (!opened.applied) {
          throw new Error(`LC_GATE_KEEPS_NO_LEASE: the gate did not open (${opened.reason})`);
        }
        const { lease: _lease, ...rest } = before;
        const want = JSON.stringify(rest);
        const read = (await store.get(run.id)).record;
        const kept = [opened.run, read].map((r) => JSON.stringify(r.claims?.[FIRST]));
        if (kept[0] !== want || kept[1] !== want || !read.in_progress_steps.includes(FIRST)) {
          throw new Error(
            `LC_GATE_KEEPS_NO_LEASE: the gate kept ${kept[0]} in the record it returned and ` +
              `${kept[1]} in a fresh get, not ${want} (the claim without its lease); the step is ` +
              `${read.in_progress_steps.includes(FIRST) ? '' : 'not '}in progress`,
          );
        }
      },
    ),
  ];
}
