// loader-warnings.ts — shared CLI surfacing for the structured loader-warning channel (issue
// #169). The BOUNDARY commands — validate, register, watch — funnel every LoaderWarning through
// printLoaderWarnings, and the dormant #170 boundary-reject is factored into ONE shared helper so
// they can't drift.
//
// issue #540: printLoaderWarnings used to rewrite the mint's "— ignored" clause to
// "— REFUSED below" for any warning the boundary resolves to 'error', on the theory that
// "ignored" is false once a boundary is about to refuse the workflow over it. That substitution
// is gone: "— ignored" is a true statement about what the PARSE did (the key was dropped) on
// EVERY surface, including this one — the refusal is a separate fact, already stated per-key by
// renderEscalationLine below. The substitution could also name the WRONG cause on any arm that
// bypasses renderEscalationLine's own gate (see the "hard-error carry"/orphan-manifest/extensions-
// failure comments in validate.ts and register.ts) and, being a first-occurrence unanchored
// string replace, could corrupt author-controlled text that happened to contain the clause
// (issue #525 item 1). See
// `plans/issue-540/design-d2.md` for the full adjudication between this and issue #170's
// (superseded) legibility argument for the substitution.
//
// One consequence, since `test` was never the exception any more (issue #450): with the
// substitution gone, printLoaderWarnings is now behaviorally identical to
// `renderLoaderWarning`'s plain-render loop that `realm workflow test` already used directly.
// Whether the two call shapes should unify is its own question — filed as #542, not answered here.
//
// Precise as of issue #444: no command hand-rolls a ⚠ prefix for a LOADER WARNING. A few
// adjacent one-off notices — register's sentinel lines, test's sentinel echo — still print their
// own `⚠ ` directly, because they are plain strings rather than LoaderWarnings; they were
// normalized to the same single-space grammar so a mixed block cannot recur.
import {
  renderLoaderWarning,
  resolveSeverity,
  DEFAULT_POLICY,
  type WorkflowError,
  type LoaderWarning,
  type WarningCode,
} from '@sensigo/realm';

/**
 * Prints every warning via the single renderLoaderWarning format source — no substitution (see
 * the module header for why the former "— ignored" → "— REFUSED below" rewrite was deleted,
 * issue #540). The `DEFAULT_POLICY` import above stays: `rejectOnErrorSeverity` and
 * `failsStrict`, both exported from this module, still resolve against it.
 */
export function printLoaderWarnings(warnings: readonly LoaderWarning[]): void {
  for (const w of warnings) {
    console.warn(renderLoaderWarning(w));
  }
}

/**
 * The dormant issue #170 boundary-reject hook, factored ONCE so validate/register/watch can't
 * drift from each other: resolves every warning against `policy` (default DEFAULT_POLICY — inert
 * today, since every entry is 'warn') and returns true if ANY resolves to 'error'. Inert today;
 * #170 flips DEFAULT_POLICY's UNKNOWN_WORKFLOW_KEY/UNKNOWN_STEP_KEY entries to make this live.
 * Never called from the execution loader (run/agent/listen/create_workflow) — those stay lenient
 * forever, grandfathering already-deployed workflows and keeping agents error-tolerant.
 */
export function rejectOnErrorSeverity(
  warnings: LoaderWarning[],
  policy: Record<WarningCode, 'warn' | 'error'> = DEFAULT_POLICY,
): boolean {
  return warnings.some((w) => resolveSeverity(w.code, policy) === 'error');
}

/**
 * `--strict`: every accumulated warning resolved against an all-'error' policy — i.e. any
 * warning at all fails the command. Derived from DEFAULT_POLICY's own key set so it can never
 * drift from the real WarningCode union (no hand-maintained code list here).
 */
const ALL_ERROR_POLICY: Record<WarningCode, 'warn' | 'error'> = Object.fromEntries(
  (Object.keys(DEFAULT_POLICY) as WarningCode[]).map((code) => [code, 'error']),
) as Record<WarningCode, 'warn' | 'error'>;

/** True if `--strict` should fail the command given these accumulated warnings. */
export function failsStrict(warnings: LoaderWarning[]): boolean {
  return rejectOnErrorSeverity(warnings, ALL_ERROR_POLICY);
}

/**
 * Wraps loadProjectExtensions' sentinel-credential warnings as LoaderWarning (issue #169).
 *
 * ONE copy (issue #444): validate.ts and register.ts each carried a byte-identical private one,
 * and both baked a two-space `⚠  ` into the message. The prefix now belongs to
 * `renderLoaderWarning` alone, so the message here is the input string verbatim.
 *
 * register's caller is `loadWorkflowForRegistration`, which `watch` also uses — so the strip
 * reaches watch too, and there is no third caller.
 */
export function wrapSentinelWarnings(sentinelWarnings: string[] | undefined): LoaderWarning[] {
  return (sentinelWarnings ?? []).map((message) => ({
    code: 'EXTENSION_SENTINEL' as const,
    severity: resolveSeverity('EXTENSION_SENTINEL'),
    scope: 'workflow' as const,
    message,
  }));
}

/**
 * Renders a load failure without saying "invalid" twice (issue #417).
 *
 * The loader's own message already begins `Invalid workflow: …`, so wrapping it in `Invalid: `
 * produced `Invalid: Invalid workflow: Step 'x': …` — an author's first three words are the same
 * word twice, before anything they can act on. Where the message announces itself, it is printed
 * verbatim; where it does not (a non-loader error surfacing on the same path), the prefix still
 * earns its place.
 *
 * Applies only to the message-echoing renders. The standalone strict-escalation lines have their
 * own text and are untouched.
 */
export function renderLoadFailure(err: WorkflowError | string): string {
  // The string branch FIRST, and not only for the unit cells that drive it: several call sites
  // pass `err instanceof Error ? err.message : String(err)`, so a plain string is a real caller
  // shape, and an object-first implementation would reach for `.errors` on it.
  if (typeof err === 'string') {
    return err.startsWith('Invalid workflow:') ? err : `Invalid: ${err}`;
  }

  // issue #425: several problems collected into one throw get one line each. The array is the
  // only place the boundaries survive — a loader message can itself contain '; ' (the #413
  // four-clause text does), so splitting the joined message back apart would cut one message in
  // half and call the halves two errors.
  const parts = err.errors;
  if (parts !== undefined && parts.length > 1) {
    return [`Invalid workflow — ${parts.length} errors:`, ...parts.map((e) => `  ${e}`)].join('\n');
  }
  return renderLoadFailure(err.message);
}

/**
 * The escalation line (issue #425). Extracted so the keyless branch below is reachable from a
 * test: every WarningCode that escalates under the default policy happens to carry a key today,
 * so no real fixture can drive it — and a clause nothing can exercise rots into a wrong guess
 * about what a future keyless code would print.
 *
 * Shared by validate, register and watch (issue #451) — three callers earned it this home, per
 * the one-caller rule recorded on validate's exitOnLoadFailure.
 */
export function renderEscalationLine(warnings: readonly LoaderWarning[]): string {
  // Same default policy `rejectOnErrorSeverity` just gated on, so the list can never disagree
  // with the refusal it explains.
  const escalated = warnings.filter((w) => resolveSeverity(w.code) === 'error');
  const list = escalated
    .map((w) => (w.key === undefined ? w.code : `${w.code} '${w.key}'`))
    .join(', ');
  return (
    `Invalid: ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}, ` +
    `${escalated.length} escalated to an error by policy: ${list}`
  );
}
