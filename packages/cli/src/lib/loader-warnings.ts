// loader-warnings.ts — shared CLI surfacing for the structured loader-warning channel (issue
// #169). Every CLI command that prints loader warnings funnels through printLoaderWarnings (the
// only caller of renderLoaderWarning — no command hand-rolls a `⚠ ` string), and the dormant
// #170 boundary-reject is factored into ONE shared helper so validate/register/watch can't drift.
import {
  renderLoaderWarning,
  resolveSeverity,
  DEFAULT_POLICY,
  type LoaderWarning,
  type WarningCode,
} from '@sensigo/realm';

/**
 * The unknown-key warning is minted with "— ignored", which is true of the LENIENT loader
 * (run/agent/listen really do ignore the key and carry on) and false here: the only callers of
 * this function are validate/register/watch, and post-#170 those three REFUSE a workflow whose
 * warning resolves to 'error'. Printing "— ignored" one line above "escalated to an error" tells
 * the author the opposite of what is about to happen to them.
 *
 * Substituted at the RENDER, not the mint, precisely because the mint is shared with the lenient
 * path — where the original wording is true and worth keeping. The did-you-mean fragment is
 * untouched: it is the most useful half of the line and the reason the author can fix this in one
 * edit.
 */
const IGNORED_CLAUSE = '— ignored';
const REFUSED_CLAUSE = '— REFUSED below';

/**
 * Prints every warning via the single renderLoaderWarning format source, correcting the
 * "— ignored" claim for any warning this boundary will actually refuse.
 *
 * Resolved against DEFAULT_POLICY, which is the policy the boundary-reject itself uses. A warning
 * that only fails under `--strict` still renders "— ignored" — see the report's design note; the
 * `--strict` path prints its own "failing due to --strict" line, so the author is not left
 * without an explanation.
 */
export function printLoaderWarnings(warnings: readonly LoaderWarning[]): void {
  for (const w of warnings) {
    const line = renderLoaderWarning(w);
    console.warn(
      resolveSeverity(w.code, DEFAULT_POLICY) === 'error'
        ? line.replace(IGNORED_CLAUSE, REFUSED_CLAUSE)
        : line,
    );
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
export function renderLoadFailure(message: string): string {
  return message.startsWith('Invalid workflow:') ? message : `Invalid: ${message}`;
}
