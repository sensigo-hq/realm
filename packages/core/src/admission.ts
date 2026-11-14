/**
 * The admission rule (architecture framework v1.27 §4; `plans/holder-slice/rebase-620/admission-decision.md`).
 *
 * Every exported engine function that takes a store, a registry, a driver or a caller admits the
 * call HERE, as its first statement. The checks live in ONE declared, ordered table, so a new check is a row in
 * the table and never a new block at the top of a function — two pieces of work that each add a
 * check cannot collide at the engine's front door (they did: #620 PR-C and #625 PR-H, 2026-10-03).
 *
 * Two tiers:
 * 1. HOST WIRING — the presence and type of what the program that embeds realm handed in (issue
 *    #719): its store, registry, driver and caller, and the parts each entry needs (the definition,
 *    the options, `run`, the dispatcher a step needs). The answer is the same on every call. A
 *    defect THROWS a typed `WorkflowError`: three of the entries (`drainFinalizers`, `abandonRun`,
 *    `getWorkflowForRun`) have no error-reply shape, so a throw is the one channel every entry
 *    shares. The first defective ROW wins; the `required_parts` row names every defect it finds at
 *    once, and a missing container (the options, the definition) is reported alone, without its
 *    members.
 * 2. CALLER INPUT — what this call's caller sent; a defect comes back as the entry's normal error
 *    reply, its way on as the reply's `error.remedy` (#729 PR-0). No row yet: #604's bounded reason
 *    and PR-V's required actor are the first.
 *
 * issue #729 PR-0 (D3 A-6; the framework's admission note): the way a call asks for is admitted at a
 * SECOND declared check-point — `admitWay(verb, snap, ctx, input)` (`engine/ways.ts`), the first
 * judgement after the entry's load, by the same judges that compose the ways it offers (R26: offer =
 * admission over the snapshot codes); the store's own write repeats the write-time checks on the
 * locked copy (`claim_removed`, `question_past_deadline`). D2's "tier (3)" is superseded by it.
 *
 * Order within the host tier: each check runs after the checks its answer depends on, and a likely
 * cause is named before its symptom — a store or registry from another realm release comes first,
 * because a host built against another realm copy builds its driver with that copy's helpers.
 */
import { assertReleaseLine, assertRegistryLine } from './release-line.js';
import { validateDriver } from './engine/holder.js';
import { validateCaller } from './engine/callers.js';
import { checkRequiredParts, givenTypeOf, optionInvalidError } from './engine/required-parts.js';
import { ExtensionRegistry } from './extensions/registry.js';

/** The engine functions that admit their calls here. A source-text witness pins each call. */
export const ENGINE_ENTRIES = [
  'executeStep',
  'executeEngineStep',
  'submitHumanResponse',
  'drainFinalizers',
  'advanceRun',
  'executeChain',
  'abandonRun',
  'reclaimStep',
  'getWorkflowForRun',
] as const;

export type EngineEntry = (typeof ENGINE_ENTRIES)[number];

/** What the host handed to one entry. An entry that takes no registry, driver or caller omits it. */
export interface HostWiring {
  store: unknown;
  storeKind: 'run store' | 'workflow store';
  registry?: unknown;
  driver?: unknown;
  /**
   * The entry's `caller` (decisions C133, C151): a word from the entry's own list
   * (`ENTRY_CALLERS`), never a free label.
   */
  caller?: unknown;
  /**
   * issue #719: the parts the entry was handed, by parameter name (`definition`, `options`, `run`,
   * `runId`, …), checked by the `required_parts` row against `REQUIRED_PARTS`. Absent: that row
   * has nothing to check.
   */
  parts?: Record<string, unknown>;
}

/**
 * The host-wiring rows' ids, in the table's order (D6-26 / framework rule 9: the vocabulary is an
 * `as const` in core, never a free string). #715 (b) adds `store_clock` and `store_settle_step`;
 * #729's claim window (CW-1) adds `store_leases`.
 */
export const HOST_WIRING_CHECK_IDS = [
  'store_release_line',
  'store_clock',
  'store_settle_step',
  'store_leases',
  'registry_release_line',
  'driver_shape',
  'caller',
  'required_parts',
] as const;

export type HostWiringCheckId = (typeof HOST_WIRING_CHECK_IDS)[number];

interface HostWiringCheck {
  readonly id: HostWiringCheckId;
  readonly check: (entry: EngineEntry, wiring: HostWiring) => void;
}

/** The store as the #715 (b) rows and the leases row read it: duck-typed, since a host may hand in anything. */
type MaybeStore =
  { clock?: { now?: unknown; at?: unknown }; settleStep?: unknown; leases?: unknown } | undefined;

/**
 * Whether a store's `leases` is what the interface allows: absent (`undefined`) or `null` — the store
 * keeps no leases — or an object with `hold` and `probe` functions.
 */
function isLeasesValue(leases: unknown): boolean {
  if (leases === undefined || leases === null) return true;
  if (typeof leases !== 'object') return false;
  const port = leases as { hold?: unknown; probe?: unknown };
  return typeof port.hold === 'function' && typeof port.probe === 'function';
}

/** Tier 1, in order. Every check passes on an absent value, so an entry that takes none skips it. */
export const HOST_WIRING_CHECKS: readonly HostWiringCheck[] = [
  {
    id: 'store_release_line',
    check: (entry, w) => {
      // issue #719 (C4): no store at all is the host's missing part, named as one — not a store
      // of an undeclared release line.
      if (w.store === undefined || w.store === null) {
        throw optionInvalidError(entry, [
          { option: 'store', expected: `a ${w.storeKind}`, given_type: givenTypeOf(w.store) },
        ]);
      }
      assertReleaseLine(w.store, `the ${w.storeKind} handed to ${entry}`);
    },
  },
  {
    // #715 (b) (D-18, D6-5): a run store reads the time only through its clock — every read and write
    // returns its reading — so a store without a callable `clock.now` and `clock.at` is refused here,
    // in the front door's four clauses, not as a late `TypeError` mid-write (a host that casts its
    // store compiles without it). Run-store entries only: `getWorkflowForRun` admits a workflow store.
    id: 'store_clock',
    check: (entry, w) => {
      if (w.storeKind !== 'run store') return;
      const clock = (w.store as MaybeStore)?.clock;
      if (typeof clock?.now !== 'function' || typeof clock?.at !== 'function') {
        throw optionInvalidError(entry, [
          {
            option: 'store.clock',
            expected: 'a Clock ({ now(), at() })',
            given_type: givenTypeOf(clock),
          },
        ]);
      }
    },
  },
  {
    // #715 (b) (D-18, D-19): `settleStep` is required — the engine writes every settlement through it.
    // A cast store without it would reach `TypeError: settleStep is not a function` mid-write.
    id: 'store_settle_step',
    check: (entry, w) => {
      if (w.storeKind !== 'run store') return;
      const settleStep = (w.store as MaybeStore)?.settleStep;
      if (typeof settleStep !== 'function') {
        throw optionInvalidError(entry, [
          {
            option: 'store.settleStep',
            expected: 'a function (required from #715 (b))',
            given_type: givenTypeOf(settleStep),
          },
        ]);
      }
    },
  },
  {
    // #729, the claim window (CW-1): `leases` is optional — absent or `null`, the store keeps no claim
    // leases (as every store did before it); otherwise its lease port. Anything else there is refused
    // here, so no later unit meets a `leases` it cannot read as a port or as none.
    id: 'store_leases',
    check: (entry, w) => {
      if (w.storeKind !== 'run store') return;
      const leases = (w.store as MaybeStore)?.leases;
      if (!isLeasesValue(leases)) {
        throw optionInvalidError(entry, [
          {
            option: 'store.leases',
            expected: 'null, or a lease port ({ hold(), probe(id) })',
            given_type: givenTypeOf(leases),
          },
        ]);
      }
    },
  },
  {
    id: 'registry_release_line',
    check: (entry, w) =>
      assertRegistryLine(w.registry, `the registry handed to ${entry}`, ExtensionRegistry),
  },
  {
    id: 'driver_shape',
    check: (_entry, w) => validateDriver(w.driver),
  },
  {
    id: 'caller',
    check: (entry, w) => validateCaller(entry, w.caller),
  },
  {
    // issue #719: last — a store, registry, driver or caller defect is the likelier cause.
    id: 'required_parts',
    check: (entry, w) => checkRequiredParts(entry, w.parts),
  },
];

/** Admits one call: runs the host-wiring table in order and throws the first defect. */
export function admitEntry(entry: EngineEntry, wiring: HostWiring): void {
  for (const row of HOST_WIRING_CHECKS) row.check(entry, wiring);
}
