// defaulted-steps.ts — the SHARED, pure derivation for default-settled step names (issue #232).
//
// Extracted from stampDefaultedSteps (execution-loop.ts, issue #220 PR-2, D6) so the exact same
// scan feeds BOTH the persisted-record stamp (complete-only, unchanged) and the READ-time surfaces
// (get_run_state, inspect) that need the same answer for a run regardless of how it sealed. A
// single shared derivation is what makes AC-2 (read surface matches evidence exactly) and AC-4
// (a complete run's derived set == its persisted defaulted_steps) hold BY CONSTRUCTION — there is
// no second, parallel scan anywhere that could silently drift from this one.
import type { RunRecord } from '../types/run-record.js';

/**
 * Scans `evidence` for entries stamped `diagnostics.settled_by_default === true` and returns their
 * distinct `step_id`s, deduped in first-occurrence (declaration) order — identical to
 * `stampDefaultedSteps`'s own loop, now shared. Pure, no I/O, and safe to call on ANY evidence
 * array regardless of the run's terminal state or how it sealed (complete/failed/aborted/still
 * running) — the derivation itself carries no seal-outcome assumption; callers decide what to do
 * with an empty result (e.g. `stampDefaultedSteps` still applies it ONLY at the `'complete'` seal;
 * the read surfaces call it unconditionally and simply omit the field when empty).
 *
 * `gate_response` evidence snapshots carry no `diagnostics.settled_by_default` (that diagnostic is
 * only ever stamped on the ONE synthesized SUCCESS execution snapshot a declared default-settle
 * mints — see `StepDiagnostics.settled_by_default`'s own doc) — no special-casing needed here
 * beyond reusing the same `=== true` predicate every other consumer of this diagnostic uses.
 */
export function deriveDefaultedSteps(evidence: RunRecord['evidence']): string[] {
  const steps: string[] = [];
  const seen = new Set<string>();
  for (const snap of evidence) {
    if (snap.diagnostics?.settled_by_default === true && !seen.has(snap.step_id)) {
      seen.add(snap.step_id);
      steps.push(snap.step_id);
    }
  }
  return steps;
}
