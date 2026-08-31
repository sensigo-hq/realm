// loader-warnings.ts — shared CLI surfacing for the structured loader-warning channel (issue
// #169). Every LoaderWarning a CLI command prints funnels through printLoaderWarnings (the only
// caller of renderLoaderWarning), and the dormant #170 boundary-reject is factored into ONE
// shared helper so validate/register/watch can't drift.
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
