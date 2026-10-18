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

/** The conditions the check reads (§5.9), in its order. #790 (D12): condition 3 is `root_engine`,
 *  every engine that runs containers or machines as root (W's `docker`, unreleased, renamed). */
export const SEPARATION_CONDITIONS = [
  'store_reach',
  'become_service_user',
  'root_engine',
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

/** #790 (D14): the ways this login might become Realm's service user, each read without acting. */
export const SWITCH_PATHS = ['root', 'sudo', 'su', 'doas', 'polkit', 'ssh'] as const;
export type SwitchPath = (typeof SWITCH_PATHS)[number];

/** What one way reads: open, closed behind a credential, closed, or not known (fail closed, P0). */
export const SWITCH_OUTCOMES = ['yes', 'needs_credential', 'not_allowed', 'unknown'] as const;
export type SwitchOutcome = (typeof SWITCH_OUTCOMES)[number];

/** Whose credential a closed way needs (D3, D5, D6, D9; `person` = a touch or a security key). */
export const SWITCH_WHOSE = ['this_login', 'svc', 'root', 'administrator', 'person'] as const;
export type SwitchWhose = (typeof SWITCH_WHOSE)[number];

/** A credential cache that waives the password for some minutes once someone authenticates (D11 b). */
export const SWITCH_CACHES = ['sudo_timestamp', 'doas_persist', 'polkit_keep'] as const;
export type SwitchCache = (typeof SWITCH_CACHES)[number];

/**
 * #790 (D14): one way, read. `how` names the read-only call or file it came from (R14); `cause` says
 * why an `unknown` is unknown. `or_not_allowed`: classic sudo's refusal "a password is required",
 * which does not say whether a rule exists (D4) — the reading is then "needs this login's password,
 * or not allowed".
 */
export interface SwitchPathReading {
  path: SwitchPath;
  tool?: string;
  outcome: SwitchOutcome;
  whose?: SwitchWhose;
  cache?: SwitchCache;
  how: string;
  cause?: string;
  or_not_allowed?: true;
  /** #790 correction (W §5, W §8): what polkit's clause (d) can say — the entry points present and
   *  each rules folder as `stat` read it. */
  polkit?: { tools: string[]; admin: 'unreadable' | 'unread'; vendor: 'unreadable' | 'unread' };
}

/** #790 (01b #6): when readings meet, the most permissive wins, and an `unknown` outranks a
 *  credential (fail closed): yes > unknown > needs a credential > not allowed. */
const OUTCOME_RANK: Record<SwitchOutcome, number> = {
  yes: 3,
  unknown: 2,
  needs_credential: 1,
  not_allowed: 0,
};

/** The most permissive outcome among `readings` (01b #6), or `undefined` for none. */
export function mostPermissive(readings: readonly SwitchPathReading[]): SwitchOutcome | undefined {
  let best: SwitchOutcome | undefined;
  for (const r of readings) {
    if (best === undefined || OUTCOME_RANK[r.outcome] > OUTCOME_RANK[best]) best = r.outcome;
  }
  return best;
}

/**
 * #790 (D13): condition 2 from the ways read. Measured "no" only when every way present reads "needs
 * a credential" or "not allowed"; any "yes" is measured "yes"; any `unknown` is unknown (fail
 * closed). No way present is measured "no". `describe` renders one way's entry in the CLI's words
 * (01b #2: `⟨path⟩: ⟨outcome⟩ (⟨how⟩)`); the entries are joined by "; ".
 */
export function switchPathsCondition(
  readings: readonly SwitchPathReading[],
  describe: (r: SwitchPathReading) => string,
  where: string,
): ConditionReading {
  const entries = readings.map(describe).join('; ');
  const best = mostPermissive(readings);
  if (best === undefined) {
    // A §F15, B §14: the line names where the check looked (`where`, the CLI's folders)
    return {
      basis: 'measured',
      answer: 'no',
      detail: `no sudo, su, doas, polkit or ssh way was found ${where}`,
    };
  }
  if (best === 'yes') return { basis: 'measured', answer: 'yes', detail: entries };
  if (best === 'unknown') return { basis: 'unknown', cause: entries };
  return { basis: 'measured', answer: 'no', detail: entries };
}

/**
 * #790 (D11): a clause the strong sentence adds, each fired by what the ways read — never printed for
 * a way that is absent. (a) a credential the agent must not be able to obtain; (b) a credential cache
 * someone could warm; (c) classic sudo's refusal, which hides `Defaults` it cannot show; (d) polkit
 * present, whose rules cannot be read here; (e) a person's touch or key; (f) an sshd present while
 * this login holds a key.
 */
export type SwitchClause =
  | { clause: 'a'; whose: Exclude<SwitchWhose, 'person'> }
  | { clause: 'b'; tools: ('sudo' | 'doas' | 'polkit')[] }
  | { clause: 'c' }
  | ({ clause: 'd' } & NonNullable<SwitchPathReading['polkit']>)
  | { clause: 'e' }
  | { clause: 'f' };

/** Which tool each credential cache belongs to (B §10: clause (b) names only those that fired). */
const CACHE_TOOL = { sudo_timestamp: 'sudo', doas_persist: 'doas', polkit_keep: 'polkit' } as const;

/** #790 (D11): the clauses `readings` fire, in the order (a)–(f); (a) once per whose. */
export function switchClausesOf(readings: readonly SwitchPathReading[]): SwitchClause[] {
  const closed = readings.filter((r) => r.outcome === 'needs_credential');
  const clauses: SwitchClause[] = [];
  for (const whose of ['this_login', 'svc', 'root', 'administrator'] as const) {
    if (closed.some((r) => r.whose === whose)) clauses.push({ clause: 'a', whose });
  }
  const caches = (['sudo_timestamp', 'doas_persist', 'polkit_keep'] as const).filter((c) =>
    readings.some((r) => r.cache === c),
  );
  if (caches.length > 0) clauses.push({ clause: 'b', tools: caches.map((c) => CACHE_TOOL[c]) });
  if (closed.some((r) => r.path === 'sudo' && r.or_not_allowed === true))
    clauses.push({ clause: 'c' });
  const polkit = readings.find((r) => r.path === 'polkit');
  if (polkit !== undefined) {
    const shown = polkit.polkit ?? { tools: [], admin: 'unread', vendor: 'unread' };
    clauses.push({ clause: 'd', ...shown });
  }
  if (closed.some((r) => r.whose === 'person')) clauses.push({ clause: 'e' });
  if (readings.some((r) => r.path === 'ssh')) clauses.push({ clause: 'f' });
  return clauses;
}

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
  /** #790 (01b #1): the ways read for condition 2 — present whenever they were measured (a service
   *  user was named); the strong sentence's clauses come from them (D11). */
  switch_paths?: SwitchPathReading[];
}

/** Whether a condition was measured "no". */
const measuredNo = (r: ConditionReading): boolean => r.basis === 'measured' && r.answer === 'no';

/** Whether a condition was measured "yes". */
const measuredYes = (r: ConditionReading): boolean => r.basis === 'measured' && r.answer === 'yes';

/**
 * The mode, derived — never guessed (§5.9; correction 1 D1; correction 2, 5.4): the store belongs to
 * another OS user → `separate_user`, whatever condition 1 reads (the "cannot record" claim still
 * needs condition 1 measured "no": {@link separationPrevents}); else condition 1 measured "yes" —
 * this login owns the store — `sandbox_configured` if the agent's app configures a sandbox (the "no"
 * would come only through it), else `same_account`; otherwise `not_measured`.
 */
export function separationModeOf(e: SeparationEvidence): SeparationMode {
  const reach = e.conditions.store_reach;
  if (e.store_owned_by_other) return 'separate_user';
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
  'root_engine',
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
