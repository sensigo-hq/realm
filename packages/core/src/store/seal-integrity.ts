// seal-integrity.ts — issue #367's L2 store-boundary enforcement: the ONE shared function both
// in-repo stores (JsonFileStore here, InMemoryStore in @sensigo/realm-testing) install in their
// update AND settle write tails. The boundary is the only layer that observes the persisted FACT
// and its TRANSITION — `stored` (the fresh pre-write read the CAS already holds) against `next`
// (the record about to be written).
//
// DETECTS, never stamps: `save()`'s create branch stays the only import channel and it never
// classifies-and-stamps either — heal and detect must never share a chokepoint, and no silent
// write path stamps at all. Materialisation is the explicit migrate vehicle's job (a later PR).
//
// All clauses THROW typed, retryable:false. An advisory would persist the violating record into
// the permanent legacy population and report success on a write that violated its own invariant
// (the #183 fsync-gate sin). #119's WARN-never-gate governs advisory findings, not store
// integrity: this store already throws on STATE_SNAPSHOT_MISMATCH / STATE_RUN_DIVERGED.
import type { RunRecord } from '../types/run-record.js';
import { SEAL_ARMS } from '../types/run-record.js';
import { WorkflowError } from '../types/workflow-error.js';
import { armToPhase, classifyForCoherence } from '../engine/eligibility.js';

/**
 * The four seal-integrity clauses plus the `SEAL_COHERENT` check (issue #367, design rev 3 §6-L2).
 * Call from every store write tail that persists `next` over `stored`. Throws on violation;
 * returns on every honest write — including the entire pre-#367 legacy population within a
 * single-version fleet (the mixed-fleet caveat is a named residual, not a solved case).
 */
export function assertSealIntegrity(stored: RunRecord, next: RunRecord): void {
  // Clause 1 — STATE_SEAL_UNSTAMPED (forward, TRANSITION-scoped): a fresh seal must name its arm.
  // Legacy terminal records re-written while terminal are exempt (stored is already terminal).
  if (
    stored.terminal_state !== true &&
    next.terminal_state === true &&
    next.sealed_by === undefined
  ) {
    throw new WorkflowError(
      `Run '${next.id}' sealed without sealed_by — every fresh seal (non-terminal → terminal ` +
        `write) must name its seal arm`,
      {
        code: 'STATE_SEAL_UNSTAMPED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId: next.id },
      },
    );
  }
  // Clause 2 — STATE_SEAL_ORPHANED (reverse, TRANSITION-scoped): a terminal -> live transition
  // that RETAINS the stamp is an in-version stripper bug, caught the moment it happens. The
  // unconditional form is rejected: it would wedge every old-binary-resume orphan on every
  // subsequent write; those orphans instead derive live and self-heal at the next settle.
  if (
    stored.terminal_state === true &&
    next.terminal_state !== true &&
    next.sealed_by !== undefined
  ) {
    throw new WorkflowError(
      `Run '${next.id}' carries sealed_by on a non-terminal write — a resume/strip path failed ` +
        `to remove it in the same write`,
      {
        code: 'STATE_SEAL_ORPHANED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId: next.id, arm: next.sealed_by.arm },
      },
    );
  }
  // Clause 3 — STATE_SEAL_ERASED (cross-time): a stored stamp must survive every terminal
  // rewrite, or a field-enumerating rewriter drains the stamped population back to prose
  // silently. Zero legacy cost by construction — no pre-#367 stored record carries sealed_by.
  if (
    stored.sealed_by !== undefined &&
    next.terminal_state === true &&
    next.sealed_by === undefined
  ) {
    throw new WorkflowError(
      `Run '${next.id}' terminal rewrite drops sealed_by (was '${stored.sealed_by.arm}') — ` +
        `stamps are erase-proof while terminal`,
      {
        code: 'STATE_SEAL_ERASED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId: next.id, erased_arm: stored.sealed_by.arm },
      },
    );
  }
  // Clause 4 — STATE_SEAL_UNKNOWN_ARM: an arm outside SEAL_ARMS never persists through this
  // store (the read side falls through to the classifier; the write side is loud).
  if (
    next.sealed_by !== undefined &&
    !(SEAL_ARMS as readonly string[]).includes(next.sealed_by.arm)
  ) {
    throw new WorkflowError(
      `Run '${next.id}' carries unknown seal arm '${next.sealed_by.arm}' — not in SEAL_ARMS`,
      {
        code: 'STATE_SEAL_UNKNOWN_ARM',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId: next.id, arm: next.sealed_by.arm },
      },
    );
  }
  // Clause 6 — STATE_SEAL_REWRITTEN: a stored arm may not be CHANGED while the run stays
  // terminal. Executed before this clause existed: a plain `update()` flipped `complete` to
  // `gate_resolution_complete`, dropped the `classified` provenance marker and reset the retention
  // clock, all silently — the re-attribution this design exists to end, live at its own boundary.
  // Both arms must be present for this to fire, so the legacy population cannot trip it.
  if (
    stored.terminal_state === true &&
    next.terminal_state === true &&
    stored.sealed_by !== undefined &&
    next.sealed_by !== undefined &&
    next.sealed_by.arm !== stored.sealed_by.arm
  ) {
    throw new WorkflowError(
      `Run '${next.id}' rewrites its seal arm ('${stored.sealed_by.arm}' -> ` +
        `'${next.sealed_by.arm}') — a recorded seal is immutable while the run is terminal`,
      {
        code: 'STATE_SEAL_REWRITTEN',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId: next.id, stored_arm: stored.sealed_by.arm, next_arm: next.sealed_by.arm },
      },
    );
  }
  // SEAL_COHERENT — on any terminal write carrying a stamp: the record's OWN markers/prose,
  // classified as if unstamped, must agree with the arm AT PHASE LEVEL (the classifier
  // legitimately cannot tell `complete` from `gate_resolution_complete` — that granularity is
  // exactly what the arm adds). This catches the old-binary re-seal channel, where a stale arm is
  // preserved by spread over a record whose prose now says otherwise, at the next new-binary
  // write. An unclassifiable record passes — never guess.
  //
  // The comparator is `classifyForCoherence`, NOT the full classifier: it omits the
  // abandoned-marker branch, the sole measured false-positive source (a record legitimately
  // carrying `abandoned_at` from an earlier life would contradict an honest arm). The
  // aborted-marker branch stays live, because the reason-less `guard_abort` re-seal is
  // marker-only-visible and would otherwise go uncaught. Named blindness: a stale arm on a record
  // carrying `abandoned_at` is invisible here — that is BOTH abandon-class arms,
  // `abandon_requested` AND `cleanup_sweep`. Their observer is the migrate sweep's incoherent
  // bucket in a later PR, which uses the FULL classifier.
  if (next.terminal_state === true && next.sealed_by !== undefined) {
    const { sealed_by: _stamp, ...sansStamp } = next;
    const classified = classifyForCoherence(sansStamp);
    if (classified !== undefined && armToPhase(classified) !== armToPhase(next.sealed_by.arm)) {
      throw new WorkflowError(
        `Run '${next.id}' seal arm '${next.sealed_by.arm}' (phase ` +
          `'${armToPhase(next.sealed_by.arm)}') disagrees with the record's own markers/prose ` +
          `(classify: '${classified}', phase '${armToPhase(classified)}') — stale or mis-stamped arm`,
        {
          code: 'STATE_SEAL_INCOHERENT',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
          details: { runId: next.id, arm: next.sealed_by.arm, classified_arm: classified },
        },
      );
    }
  }
}
