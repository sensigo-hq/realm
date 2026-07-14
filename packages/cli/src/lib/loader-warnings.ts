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

/** Prints every warning via the single renderLoaderWarning format source. */
export function printLoaderWarnings(warnings: LoaderWarning[]): void {
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
