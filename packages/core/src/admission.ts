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
 *    reply. No row yet: #604's bounded reason and PR-V's required actor are the first.
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

interface HostWiringCheck {
  readonly id: string;
  readonly check: (entry: EngineEntry, wiring: HostWiring) => void;
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
