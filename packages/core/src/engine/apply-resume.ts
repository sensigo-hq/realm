// apply-resume.ts — the core-owned pure resume transform (issue #279, increment 1, PR-B).
// Normative spec: plans/issue-279/design-d4-increment1.md §5. "snapshot" naming is deliberate: this
// function's own atomicity claim is ZERO — the caller's single `store.update()` version-CAS on the
// RETURNED record is what makes the whole resume atomic; `snapshot` is read pre-lock, the payload
// simply carries the version it was read at (lens-1 F14).
//
// The CLI's OWN refusals (packages/cli/src/commands/resume.ts) — aborted_at / a finalizer `--from`
// target / an unexpired pending-ledger lease / a healthy-or-unknown-age claim — ALL run BEFORE this
// is ever called. By the time control reaches here, every remaining in-progress claim is provably
// stale-or-absent (no live work is being interrupted), so this function releases ALL of them
// unconditionally — do NOT widen this signature with claim-classification inputs; that would
// re-litigate a decision the CLI refusals already made.
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { propagateSkips } from './eligibility.js';

/** One finalizer voided by a resume, with its lease-discriminated disclosure message (design
 *  record §5: "never executed, superseded by resume" vs "may have executed without a recorded
 *  mark — may re-execute at the next terminal edge"). */
export interface ApplyResumeVoidedFinalizer {
  name: string;
  disclosure: string;
}

export interface ApplyResumeResult {
  /** The fully-mutated record — pass directly to `store.update()` for the atomic write. */
  run: RunRecord;
  /** Every pending finalizer ledger entry this resume voided, in `Object.entries` order. Empty
   *  when the run carried no pending finalizers (the common case). */
  voided: ApplyResumeVoidedFinalizer[];
  /** Issue #279 (increment 2, PR-C — the #282 class closure, D-3 leg ii): one disclosure line per
   *  carried `pending_gate` this resume stripped — a grandfathered/zombie gate on a run that
   *  somehow reached `RESUMABLE_PHASES` (`failed`/`abandoned`) while still carrying a leftover
   *  `pending_gate` (the #282 class). Empty (never populated) on the overwhelming common case — a
   *  genuinely resumable run has no gate open at all. Printed by the CLI through the same `⚠` loop
   *  the voided-finalizer disclosures already use, AFTER them.
   */
  disclosures: string[];
}

/**
 * Resumes `stepName` (design record §5) — filters it out of `failed_steps`, wipes and re-derives
 * `skipped_steps`/`skip_details` from scratch (NOTE — final-gate F9 cross-reference: this
 * wipe+re-derive relies on the premise that handler/guard-abort runs are never resumable; the
 * CLI's own `aborted_at` refusal, run BEFORE this function, is what makes that premise
 * STRUCTURALLY true rather than merely conventional), resets `terminal_state:false`, strips
 * `terminal_reason` AND `abandoned_at` (issue #281 — the load-bearing fix for the `aborted_at`
 * mask: leaving a stale `abandoned_at` on a resumed-and-re-terminalized run would let a future
 * PR-A-vintage `isTerminal` reader mis-read it as abandoned again), projects `settled` down to
 * still-live membership (L17: `settled′ = {s ∈ settled | s ∈ completed′∪failed′∪skipped′}`), VOIDS
 * every pending finalizer ledger entry (leases dropped, each disclosed), strips a carried
 * `pending_gate` (issue #279, increment 2, PR-C — D-3 leg ii: the #282 class closure's resume-side
 * leg, disclosed when it fires), and releases every remaining claim unconditionally.
 *
 * Pure — no I/O, no `Date.now()`/randomness. Returns the mutated record; the caller performs the
 * single atomic `store.update()`.
 */
export function applyResume(
  snapshot: RunRecord,
  stepName: string,
  definition: WorkflowDefinition,
): ApplyResumeResult {
  const failedSteps = snapshot.failed_steps.filter((s) => s !== stepName);
  const { skipped: skippedSteps, details: skipDetails } = propagateSkips(
    {
      ...snapshot,
      failed_steps: failedSteps,
      skipped_steps: [] as string[],
      skip_details: {},
    },
    definition,
  );

  // settled L17 PROJECTION.
  const liveMembership = new Set([...snapshot.completed_steps, ...failedSteps, ...skippedSteps]);
  const settled: RunRecord['settled'] =
    snapshot.settled !== undefined
      ? Object.fromEntries(Object.entries(snapshot.settled).filter(([s]) => liveMembership.has(s)))
      : undefined;

  // VOID every pending finalizer ledger entry, loudly, with lease discrimination.
  const voided: ApplyResumeVoidedFinalizer[] = [];
  let finalizerLedger: RunRecord['finalizer_ledger'] = snapshot.finalizer_ledger;
  if (finalizerLedger !== undefined) {
    const nextLedger: NonNullable<RunRecord['finalizer_ledger']> = {};
    for (const [name, entry] of Object.entries(finalizerLedger)) {
      if (entry.status !== 'pending') {
        nextLedger[name] = entry;
        continue;
      }
      const neverLeased = entry.lease_token === undefined;
      nextLedger[name] = { status: 'voided', rank: entry.rank };
      voided.push({
        name,
        disclosure: neverLeased
          ? `finalizer '${name}' voided by resume — never executed, superseded by resume`
          : `finalizer '${name}' voided by resume — may have executed without a recorded mark; ` +
            `may re-execute at the next terminal edge`,
      });
    }
    finalizerLedger = nextLedger;
  }

  // Issue #279 (increment 2, PR-C — D-3 leg ii): strip a carried `pending_gate` in the SAME
  // atomic payload — the #282 class closure's own resume-side leg. A genuinely resumable run
  // (RESUMABLE_PHASES: failed/abandoned) never legitimately has a LIVE open gate (the CLI's own
  // aborted_at/lease/claim refusals run before this, but none of them check pending_gate — a
  // grandfathered/mixed-fleet record could still carry one), so this is defensive: it can never
  // silently strip a live decision out from under a human, only a stale, zombie one.
  const disclosures: string[] = [];
  // issue #367: `sealed_by` joins the strip list — the resumed run is live again, so the seal fact
  // must leave in the SAME write that flips terminal_state:false. The store boundary's ORPHANED
  // clause is what catches a future regression of this line.
  const {
    terminal_reason: _tr,
    abandoned_at: _aa,
    sealed_by: _sb,
    pending_gate: strippedGate,
    ...rest
  } = snapshot;
  if (strippedGate !== undefined) {
    disclosures.push(
      `zombie gate '${strippedGate.gate_id}' on '${strippedGate.step_name}' cleared by resume — step will re-drive`,
    );
  }

  // Strip terminal_reason + abandoned_at (issue #281); release ALL remaining claims
  // unconditionally (the CLI refusals guarantee none are healthy by the time this runs).
  const run: RunRecord = {
    ...rest,
    failed_steps: failedSteps,
    skipped_steps: skippedSteps,
    skip_details: skipDetails,
    terminal_state: false,
    in_progress_steps: [],
    claims: {},
    ...(settled !== undefined ? { settled } : {}),
    ...(finalizerLedger !== undefined ? { finalizer_ledger: finalizerLedger } : {}),
  };

  return { run, voided, disclosures };
}
