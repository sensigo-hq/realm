// separation.ts — #627 W (§5.9, F26 step 1): the separation check's evidence, typed ONCE here as a
// closed vocabulary. The CLI MEASURES it (`realm mcp|serve --check`, R19); later surfaces cite it,
// never re-derive it. Pure: data in, words out — no file, process or clock is read here.
import type { Source } from './ways.js';
import type { GateAnswers } from './ways.js';

/**
 * The mode a login's reach puts the deployment in: the agent's login IS Realm's (`same_account`);
 * the agent runs inside a sandbox its app configured (`sandbox_configured`); Realm's store belongs to
 * another OS user (`separate_user`); or the check could not tell (`not_measured`, correction 1 D1:
 * condition 1 not measured "yes" and the separate-user conditions not met — never guessed as the
 * same login). `container` enters with the image unit, its producer.
 */
export const SEPARATION_MODES = [
  'same_account',
  'sandbox_configured',
  'separate_user',
  'not_measured',
] as const;
export type SeparationMode = (typeof SEPARATION_MODES)[number];

/**
 * How a condition is known: measured by the check itself; configured somewhere Realm does not
 * enforce (a sandbox setting, a sudoers rule read from a file); or not known, with its cause.
 */
export const SEPARATION_BASES = ['measured', 'configured_not_enforced', 'unknown'] as const;
export type SeparationBasis = (typeof SEPARATION_BASES)[number];

/** The conditions the check reads (§5.9), in its order. */
export const SEPARATION_CONDITIONS = [
  'store_reach',
  'become_service_user',
  'docker',
  'trust_root_writable',
  'other_answer_host',
  'time_basis',
  'agent_sandbox',
  'economics_writable',
] as const;
export type SeparationCondition = (typeof SEPARATION_CONDITIONS)[number];

/** One condition, read: measured `yes` / `no` (or a fact, for the informational ones), or why not. */
export type ConditionReading =
  | { basis: 'measured'; answer: 'yes' | 'no'; detail?: string }
  | { basis: 'measured'; answer: 'fact'; detail: string }
  | { basis: 'configured_not_enforced'; detail: string }
  | { basis: 'unknown'; cause: string };

/** Everything the check measured for one login. */
export interface SeparationEvidence {
  /** The login the check ran as (the docs say: the agent's own shell). */
  login: string;
  /** The OS user that owns Realm's store, when it is not this login. */
  service_user?: string;
  /** Whether the store's folder belongs to another OS user (measured). */
  store_owned_by_other: boolean;
  conditions: Record<SeparationCondition, ConditionReading>;
  /** The gate-answers value the check judged, with its WINNING source (restrictive wins). */
  value: { value: GateAnswers; source: Source };
}

/** Whether a condition was measured "no". */
const measuredNo = (r: ConditionReading): boolean => r.basis === 'measured' && r.answer === 'no';

/** Whether a condition was measured "yes". */
const measuredYes = (r: ConditionReading): boolean => r.basis === 'measured' && r.answer === 'yes';

/**
 * The mode, derived — never guessed (§5.9; correction 1 D1): `separate_user` only when condition 1
 * is measured "no" AND the store belongs to another OS user; when condition 1 is measured "yes", the
 * same login — `sandbox_configured` if the agent's app configures a sandbox (the "no" would come only
 * through it), else `same_account`; otherwise `not_measured`.
 */
export function separationModeOf(e: SeparationEvidence): SeparationMode {
  const reach = e.conditions.store_reach;
  if (measuredNo(reach) && e.store_owned_by_other) return 'separate_user';
  if (measuredYes(reach)) {
    return e.conditions.agent_sandbox.basis === 'configured_not_enforced'
      ? 'sandbox_configured'
      : 'same_account';
  }
  return 'not_measured';
}

/**
 * Whether the gate-answers value is MEASURED `withheld` (F36): given on the `--check` line's own
 * `--gate-answers` flag — the one source the check reads directly. An environment or option value is
 * configured, not enforced: the running server's value is not read.
 */
export function valueMeasuredWithheld(e: SeparationEvidence): boolean {
  return e.value.value === 'withheld' && e.value.source.kind === 'flag';
}

/** The four "prevents" conditions (§5.9): each must be measured "no". */
export const PREVENTS_CONDITIONS = [
  'store_reach',
  'become_service_user',
  'docker',
  'trust_root_writable',
] as const satisfies readonly SeparationCondition[];

/**
 * The "cannot record" claim's predicate (W-x3, its proviso included): the mode is `separate_user`,
 * conditions 1–4 are each measured "no", AND the value is measured `withheld`. Nothing else prints
 * the claim — it never exceeds what was measured (guardrail 7(f)).
 */
export function separationPrevents(e: SeparationEvidence): boolean {
  return (
    separationModeOf(e) === 'separate_user' &&
    PREVENTS_CONDITIONS.every((c) => measuredNo(e.conditions[c])) &&
    valueMeasuredWithheld(e)
  );
}

/**
 * One gap of a "may still be able to answer" claim: a prevents condition not measured "no", with its
 * reading (correction 1 D1: an `unknown` reads "not measured", never "it can"), or the value.
 */
export type SeparationGap =
  { gap: (typeof PREVENTS_CONDITIONS)[number]; reading: ConditionReading } | { gap: 'value' };

/** The gaps a "may still be able to answer" claim names: the prevents conditions not met. */
export function separationGaps(e: SeparationEvidence): SeparationGap[] {
  return [
    ...PREVENTS_CONDITIONS.filter((c) => !measuredNo(e.conditions[c])).map((c) => ({
      gap: c,
      reading: e.conditions[c],
    })),
    ...(valueMeasuredWithheld(e) ? [] : [{ gap: 'value' as const }]),
  ];
}
