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
  // Clause 6 — STATE_SEAL_REWRITTEN: a stored arm may not be CHANGED while the run stays terminal,
  // EXCEPT by an adjudication write carrying truthful provenance. Executed before this clause
  // existed: a plain `update()` flipped `complete` to `gate_resolution_complete`, dropped the
  // `classified` marker and reset the retention clock, all silently — the re-attribution this
  // design exists to end, live at its own boundary.
  //
  // The adjudication key is published as a day-one contract rather than added later, because the
  // law that ships with the major says arm changes are refused; amending it afterwards would
  // loosen a published guarantee under external implementers.
  //
  // The key opens THIS clause only. `SEAL_COHERENT` below still governs: a truthful CROSS-PHASE
  // ruling on a record whose own prose still classifies elsewhere is refused as incoherent, by
  // design — the operator verb must co-rewrite the prose/markers for a cross-phase ruling, or the
  // record would end up contradicting itself in a new direction.
  // Rule 3 lives OUTSIDE the both-terminal guard below, and that placement is the point: a FRESH
  // seal is a non-terminal -> terminal write, so a rule scoped to both-terminal would never see the
  // fabrication it exists to refuse. (It did not, until the cell for it reddened.)
  if (
    next.terminal_state === true &&
    stored.sealed_by === undefined &&
    next.sealed_by?.adjudicated !== undefined
  ) {
    throw new WorkflowError(
      `Run '${next.id}' carries adjudication provenance on a record that had no seal arm — ` +
        `a first seal cannot have been adjudicated`,
      {
        code: 'STATE_SEAL_REWRITTEN',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: {
          runId: next.id,
          claimed_previous_arm: next.sealed_by.adjudicated.previous_arm,
        },
      },
    );
  }
  if (stored.terminal_state === true && next.terminal_state === true) {
    const storedArm = stored.sealed_by?.arm;
    const nextSeal = next.sealed_by;
    const adjudication = nextSeal?.adjudicated;
    const storedAdjudication = stored.sealed_by?.adjudicated;
    // A ruling is NEW-OR-CHANGED when it is not byte-identical to the stored one; an untouched
    // record spreading its own provenance forward is not making a claim.
    const provenanceIsNew =
      adjudication !== undefined &&
      JSON.stringify(adjudication) !== JSON.stringify(storedAdjudication);

    // (Rule 3 — no fabricated first-seal adjudication — is hoisted above; see its comment.)
    // Rule 2 — truthfulness binds EVERY provenance write, same-arm included. Without this, a
    // same-arm write could mint provenance naming any arm at all, and the "chain is one-step
    // walkable" guarantee that justifies the single slot would be worthless.
    if (storedArm !== undefined && provenanceIsNew && adjudication.previous_arm !== storedArm) {
      throw new WorkflowError(
        `Run '${next.id}' claims adjudication from '${adjudication.previous_arm}' but the stored ` +
          `arm is '${storedArm}' — a seal rewrite is lawful only with TRUTHFUL provenance`,
        {
          code: 'STATE_SEAL_REWRITTEN',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
          details: {
            runId: next.id,
            stored_arm: storedArm,
            claimed_previous_arm: adjudication.previous_arm,
            ...(nextSeal !== undefined ? { next_arm: nextSeal.arm } : {}),
          },
        },
      );
    }
    // Rule 4 — provenance is erase-proof while terminal, for the same reason the arm is: a ruling
    // that can be quietly dropped is a ruling nobody can rely on afterwards.
    if (storedAdjudication !== undefined && nextSeal !== undefined && adjudication === undefined) {
      throw new WorkflowError(
        `Run '${next.id}' drops its adjudication provenance (ruled by ` +
          `'${storedAdjudication.by}') — a recorded ruling is erase-proof while terminal`,
        {
          code: 'STATE_SEAL_REWRITTEN',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
          details: { runId: next.id, erased_ruling_by: storedAdjudication.by },
        },
      );
    }
    // Rule 1 — the arm changed. Lawful only with truthful provenance, which rule 2 has already
    // verified; anything else is the silent rewrite.
    //
    // (Rev 1 of this clause also carried a "stored had none, or differs" conjunct here. It is
    // DELETED deliberately: once rule 2 binds every provenance write, the state it guarded is
    // unreachable in any lawful history, and the conjunct was comparator-ambiguous dead code.
    // Recorded so nobody re-adds it looking at the flip case alone.)
    if (storedArm !== undefined && nextSeal !== undefined && nextSeal.arm !== storedArm) {
      if (adjudication === undefined) {
        throw new WorkflowError(
          `Run '${next.id}' rewrites its seal arm ('${storedArm}' -> '${nextSeal.arm}') — a ` +
            `recorded seal is immutable while the run is terminal, except by an adjudication ` +
            `write carrying truthful provenance`,
          {
            code: 'STATE_SEAL_REWRITTEN',
            category: 'STATE',
            agentAction: 'report_to_user',
            retryable: false,
            details: { runId: next.id, stored_arm: storedArm, next_arm: nextSeal.arm },
          },
        );
      }
    }
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
