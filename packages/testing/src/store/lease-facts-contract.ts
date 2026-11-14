// lease-facts-contract.ts — issue #729, the claim window, unit CW-1b part 1 (design record C5 §4.2):
// the laws of a store with claim leases that every run it returns carries the facts about its
// in-progress claims' leases (`lease_facts`), as their own family, beside `leasePortContract`.
//
// Each case builds its own store through the adapter. The adapter gives the store a lease port and a
// lease another program holds (for a store whose leases are kernel locks, a holder in another process),
// and lists every id the store's port was asked about, so a case can say what was probed. Nothing in
// Realm writes a claim's lease yet (CW-2 will), so a case writes its leased claims through the store's
// own `update`. Each case reads the facts through core's one reader, `leaseFactOf`.
import {
  leaseFactOf,
  type ClaimRecord,
  type LeaseFact,
  type RunRecord,
  type RunStore,
  type Snapshot,
  type StoreSettlement,
  type WorkflowDefinition,
} from '@sensigo/realm';

/**
 * The laws, by name. Each returning method of a store with a lease port gives, for every in-progress
 * claim that names a lease, that lease's fact: `held` for the lease another program holds, `absent`
 * for an id no program held. One law per method:
 * - `LF_GET` — `get`.
 * - `LF_SCAN_PAGE` — a record page of `scan`.
 * - `LF_CREATE_KEYED_EXISTING` — a keyed `create` that returns the run already holding the key
 *   (`created: false`).
 * - `LF_UPDATE` — `update`.
 * - `LF_CLAIM_STEP` — `claimStep` of another step.
 * - `LF_SETTLE_APPLIED` — an applied `settleStep` of another step.
 * - `LF_SETTLE_REFUSED` — a `settleStep` refused by its predicate (a replayed settle).
 * - `LF_UNLEASED_PROBES_NOTHING` — a run with no leased claim (the new run a `create` makes, with no
 *   claims) is returned with no `lease_facts`, and the store's port is asked nothing.
 */
export const LEASE_FACTS_LAWS = [
  'LF_GET',
  'LF_SCAN_PAGE',
  'LF_CREATE_KEYED_EXISTING',
  'LF_UPDATE',
  'LF_CLAIM_STEP',
  'LF_SETTLE_APPLIED',
  'LF_SETTLE_REFUSED',
  'LF_UNLEASED_PROBES_NOTHING',
] as const;

export type LeaseFactsLaw = (typeof LEASE_FACTS_LAWS)[number];

/** One store a case runs against, which the adapter built with a lease port. */
export interface LeaseFactsTestStore {
  /** The store, with its lease port (`store.leases`). */
  readonly store: RunStore;
  /**
   * The id of a lease another program holds, in this store's home, until `dispose()`. For a store whose
   * leases are kernel locks, a program in another process; for the lease double, one set `live`.
   */
  heldLease(): Promise<string>;
  /** Every id the store's lease port was asked about since the store was built, in order. */
  probed(): readonly string[];
  dispose(): Promise<void>;
}

/** Adapter a calling test file supplies to run the family against one kind of store. */
export interface LeaseFactsContractAdapter {
  /** A name for the store, at the start of each case's `name`. */
  storeName: string;
  /** Builds a fresh store with a lease port. */
  makeStore(): Promise<LeaseFactsTestStore>;
}

export interface LeaseFactsContractCase {
  law: LeaseFactsLaw;
  name: string;
  run: () => Promise<void>;
}

const WF = 'wf-lease-facts';
const KEY = 'k-lease-facts';
/** The step whose claim names the held lease, the one whose claim names a lease no program held,
 *  and the step the cases claim and settle. */
const LEASED = 'leased';
const SPARE = 'spare';
const OTHER = 'other';
const NEVER_HELD = 'lease-facts-never-held';
const DEFINITION: WorkflowDefinition = {
  id: WF,
  name: 'lease facts contract',
  version: 1,
  steps: {
    [LEASED]: { description: 'l', execution: 'agent', depends_on: [] },
    [SPARE]: { description: 's', execution: 'agent', depends_on: [] },
    [OTHER]: { description: 'o', execution: 'agent', depends_on: [] },
  },
};
const KEYED = { workflowId: WF, workflowVersion: 1, params: {}, idempotencyKey: KEY };

function show(fact: LeaseFact | { absent: 'unleased' }): string {
  if ('absent' in fact) return 'unleased';
  return fact.state === 'unknown' ? `unknown(${fact.reason})` : fact.state;
}

/** What a case holds: its store, and the run whose two in-progress claims name leases. */
interface Leased {
  t: LeaseFactsTestStore;
  run: RunRecord;
  held: string;
}

/** Builds the run: created with the key, then its two leased claims written through `update`. */
async function leasedRun(t: LeaseFactsTestStore): Promise<Leased> {
  const held = await t.heldLease();
  const { record } = await t.store.create(KEYED);
  const claims: Record<string, ClaimRecord> = {
    [LEASED]: { deadline: null, lease: { id: held } },
    [SPARE]: { deadline: null, lease: { id: NEVER_HELD } },
  };
  const { record: run } = await t.store.update({
    ...record,
    in_progress_steps: [LEASED, SPARE],
    claims,
  });
  return { t, run, held };
}

/** Checks that `result` carries `held` for the held lease and `absent` for the other. */
function checkFacts(
  law: LeaseFactsLaw,
  what: string,
  result: Pick<Snapshot, 'lease_facts'> & { record?: RunRecord; run?: RunRecord },
): void {
  const record = result.record ?? result.run;
  if (record === undefined) throw new Error(`${law}: ${what} returned no run`);
  const seen = [LEASED, SPARE].map((step) => show(leaseFactOf(result, record.claims?.[step])));
  if (seen[0] !== 'held' || seen[1] !== 'absent') {
    throw new Error(
      `${law}: ${what} returned ${seen[0]} for the claim on the held lease and ${seen[1]} for the ` +
        `claim on a lease no program held, not held and absent` +
        (result.lease_facts === undefined ? ' (it carries no lease_facts)' : ''),
    );
  }
}

/** Runs one law with a fresh store; any failure names the law. */
function lawCase(
  law: LeaseFactsLaw,
  name: string,
  adapter: LeaseFactsContractAdapter,
  body: (t: LeaseFactsTestStore) => Promise<void>,
): LeaseFactsContractCase {
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

/** The laws of a store's lease facts, one case per law, for the given adapter. */
export function leaseFactsContract(adapter: LeaseFactsContractAdapter): LeaseFactsContractCase[] {
  const L = (law: LeaseFactsLaw, name: string, body: (t: LeaseFactsTestStore) => Promise<void>) =>
    lawCase(law, name, adapter, body);
  /** Claims `OTHER` on the leased run and settles it; returns the settlement. */
  const claimAndSettle = async ({ t, run }: Leased): Promise<StoreSettlement> => {
    const { record: claimed } = await t.store.claimStep(run.id, OTHER, DEFINITION);
    const token = claimed.claims?.[OTHER]?.token;
    return t.store.settleStep(
      run.id,
      {
        kind: 'settle_step',
        step: OTHER,
        outcome: 'complete',
        ...(token !== undefined ? { claimToken: token } : {}),
        evidence: [],
      },
      DEFINITION,
    );
  };
  return [
    L('LF_GET', 'get returns a fact for every leased in-progress claim', async (t) => {
      const { run } = await leasedRun(t);
      checkFacts('LF_GET', 'get', await t.store.get(run.id));
    }),
    L(
      'LF_SCAN_PAGE',
      'a record page of scan returns a fact for every leased in-progress claim',
      async (t) => {
        const { run } = await leasedRun(t);
        const pages = t.store.scan({}, { pageSize: 10 });
        const first = await pages.next();
        await pages.return(undefined);
        const item = first.done
          ? undefined
          : first.value.items.find((i) => i.kind === 'run' && i.run.record.id === run.id);
        if (item === undefined || item.kind !== 'run')
          throw new Error(`LF_SCAN_PAGE: the scan's first page did not list run ${run.id}`);
        checkFacts('LF_SCAN_PAGE', 'a page of scan', item.run);
      },
    ),
    L(
      'LF_CREATE_KEYED_EXISTING',
      'a keyed create that returns the run holding the key returns a fact for every leased in-progress claim',
      async (t) => {
        const { run } = await leasedRun(t);
        const again = await t.store.create(KEYED);
        if (again.created || again.record.id !== run.id) {
          throw new Error(
            `LF_CREATE_KEYED_EXISTING: the keyed create made run ${again.record.id} (created: ${String(again.created)}), not returned run ${run.id}`,
          );
        }
        checkFacts('LF_CREATE_KEYED_EXISTING', 'the keyed create', again);
      },
    ),
    L('LF_UPDATE', 'update returns a fact for every leased in-progress claim', async (t) => {
      const { run } = await leasedRun(t);
      checkFacts('LF_UPDATE', 'update', await t.store.update(run));
    }),
    L(
      'LF_CLAIM_STEP',
      'claimStep of another step returns a fact for every leased in-progress claim',
      async (t) => {
        const { run } = await leasedRun(t);
        checkFacts(
          'LF_CLAIM_STEP',
          'claimStep',
          await t.store.claimStep(run.id, OTHER, DEFINITION),
        );
      },
    ),
    L(
      'LF_SETTLE_APPLIED',
      'an applied settleStep of another step returns a fact for every leased in-progress claim',
      async (t) => {
        const settled = await claimAndSettle(await leasedRun(t));
        if (!settled.applied)
          throw new Error(`LF_SETTLE_APPLIED: the settle was refused (${settled.reason})`);
        checkFacts('LF_SETTLE_APPLIED', 'an applied settleStep', settled);
      },
    ),
    L(
      'LF_SETTLE_REFUSED',
      'a settleStep refused by its predicate returns a fact for every leased in-progress claim',
      async (t) => {
        const leased = await leasedRun(t);
        await claimAndSettle(leased);
        const replayed = await leased.t.store.settleStep(
          leased.run.id,
          { kind: 'settle_step', step: OTHER, outcome: 'complete', evidence: [] },
          DEFINITION,
        );
        if (replayed.applied) throw new Error('LF_SETTLE_REFUSED: the replayed settle applied');
        checkFacts('LF_SETTLE_REFUSED', `a settleStep refused (${replayed.reason})`, replayed);
      },
    ),
    L(
      'LF_UNLEASED_PROBES_NOTHING',
      'a run with no leased claim is returned with no lease_facts, and nothing is probed',
      async (t) => {
        const before = t.probed().length;
        const created = await t.store.create({ workflowId: WF, workflowVersion: 1, params: {} });
        const asked = t.probed().slice(before);
        if (asked.length > 0 || created.lease_facts !== undefined) {
          throw new Error(
            `LF_UNLEASED_PROBES_NOTHING: creating a run with no claims asked the lease port about ` +
              `${asked.length === 0 ? 'nothing' : asked.join(', ')} and returned ` +
              `${created.lease_facts === undefined ? 'no lease_facts' : 'lease_facts'}`,
          );
        }
      },
    ),
  ];
}
