// settlement.ts — the atomic-settlement pure transform (issue #279, increment 1, PR-A).
//
// Normative spec: plans/issue-279/design-d4-increment1.md (read in full before touching this file
// — it is the specification; the JSDoc below cross-references it by section/line but does not
// restate the predicate/transform pseudocode verbatim). This file implements §2-§4 EXACTLY,
// including `selectFinalizers`/`finalizerTriggers`, extracted here from execution-loop.ts's
// `buildFinalizedSeal` (the ONE engine-file touch this PR makes — see that file's own comment at
// the call site). Any deviation implementation forced is surfaced as a design question in the
// hand-off report, never improvised.
//
// PR-A scope: this module is CORE-OWNED, pure, and completely dormant — nothing in
// packages/core/src/engine (outside this file) or packages/mcp-server calls `applySettlement` or
// a store's `settleStep`. PR-B migrates the three legacy seal sites to construct `SettlementDelta`
// values and call `store.settleStep` instead of `store.update` directly.
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition, FinalizerTrigger } from '../types/workflow-definition.js';
import type {
  SettlementDelta,
  SettlementResult,
  SettleStepDelta,
  SettleStepOutcome,
  LeaseFinalizerDelta,
  MarkFinalizerDelta,
} from '../types/settlement.js';
import {
  deriveRunPhase,
  isWorkflowComplete,
  findEligibleSteps,
  findEligibleGuardSteps,
  propagateSkips,
} from './eligibility.js';
import { deriveDefaultedSteps } from './defaulted-steps.js';
import { captureEvidence } from '../evidence/snapshot.js';
import { omitClaim } from './claim-liveness.js';
import { DRAIN_LEASE_MAX } from './lifecycle.js';

/** Projects the per-step settled-map entry shape directly off `RunRecord` — avoids a second,
 *  independently-maintained type that could drift from the field it describes. */
type SettledEntry = NonNullable<RunRecord['settled']>[string];
/** Same projection for the whole finalizer ledger. */
type FinalizerLedger = NonNullable<RunRecord['finalizer_ledger']>;

// ---------------------------------------------------------------------------
// §2 normative helpers
// ---------------------------------------------------------------------------

/** `isTerminal(fresh) := fresh.terminal_state === true` — BU-blocking adjudication; F1 preserved
 *  (abandon/abort SET terminal_state, so this reads correctly for both). */
function isTerminal(fresh: RunRecord): boolean {
  return fresh.terminal_state === true;
}

/** `norm(t) := t ?? null` — absent≡absent normalization (issue #197's grandfathered-claims
 *  precedent), so a token-less claim/entry is never spuriously distinguished from a `null` one. */
function norm(t: string | null | undefined): string | null {
  return t ?? null;
}

/** `tokensEqual(a,b) := norm(a) === norm(b)`. */
function tokensEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return norm(a) === norm(b);
}

/** `M := {complete: completed_steps, fail: failed_steps, skip: skipped_steps}` — the membership
 *  array a settled-map entry's `outcome` maps to. */
function membershipFor(fresh: RunRecord, outcome: SettledEntry['outcome']): readonly string[] {
  switch (outcome) {
    case 'complete':
      return fresh.completed_steps;
    case 'fail':
      return fresh.failed_steps;
    case 'skip':
      return fresh.skipped_steps;
  }
}

/**
 * `entryOf(fresh, s) := e = fresh.settled?.[s]; e !== undefined && s ∈ M[e.outcome](fresh) ? e :
 * undefined` — the ORPHAN RULE: an entry without matching membership is treated as absent (the
 * `claimStep` :512 overwrite-self-heal precedent, generalized). Never occurs through `settleStep`
 * itself (APPLY always writes both atomically) — guards a hand-authored fixture or an external
 * store's divergent history from wedging the predicate.
 */
function entryOf(fresh: RunRecord, step: string): SettledEntry | undefined {
  const e = fresh.settled?.[step];
  if (e === undefined) return undefined;
  return membershipFor(fresh, e.outcome).includes(step) ? e : undefined;
}

/** `toSettledOutcome := {complete↦'complete', fail↦'fail', abort↦'skip'}`. */
function toSettledOutcome(outcome: SettleStepOutcome): SettledEntry['outcome'] {
  switch (outcome) {
    case 'complete':
      return 'complete';
    case 'fail':
      return 'fail';
    case 'abort':
      return 'skip';
  }
}

/** The pending subset of a finalizer ledger, ascending by `rank` — the order the drain loop (§6)
 *  consumes. A convenience snapshot for {@link SettlementResult}'s `pendingFinalizers` field. */
function pendingFinalizerNames(ledger: FinalizerLedger | undefined): string[] {
  if (ledger === undefined) return [];
  return Object.entries(ledger)
    .filter(([, e]) => e.status === 'pending')
    .sort(([, a], [, b]) => a.rank - b.rank)
    .map(([name]) => name);
}

// ---------------------------------------------------------------------------
// Finalizer selection — extracted from execution-loop.ts's buildFinalizedSeal (the ONE
// engine-file touch this PR makes). Behavior-preserving by construction: the legacy caller passes
// the SAME (definition, settled-step-names, outcome) inputs and gets the SAME ordered name list
// back that its own inline grouping loop used to compute.
// ---------------------------------------------------------------------------

/** Normalizes a finalizer's `on_outcome` to a set of triggers (moved verbatim from
 *  execution-loop.ts:3079 as part of the extraction). */
function finalizerTriggers(stepDef: {
  on_outcome?: FinalizerTrigger | FinalizerTrigger[];
}): Set<FinalizerTrigger> {
  const raw = stepDef.on_outcome;
  if (raw === undefined) return new Set();
  return new Set(Array.isArray(raw) ? raw : [raw]);
}

/**
 * Selects the finalizer steps that fire for a terminal `outcome`, in the drain order (design
 * record §4/§6; extracted from `buildFinalizedSeal`'s selection, execution-loop.ts :3117-3126):
 * Group A (rank precedence) — `on_outcome` contains `outcome` (the specific catch/complete arm);
 * Group B — `on_outcome` contains `'always'` but NOT `outcome` (a finalizer listing both runs
 * once, in Group A). Each group in `Object.entries` declaration order; Group A then Group B.
 * `settledStepNames` excludes any finalizer already at-most-once settled (resume/re-drive safety)
 * — pass `completed_steps ∪ failed_steps`, NEVER the `RunRecord.settled` map (a different,
 * per-step-outcome-keyed structure this selection does not consult).
 */
export function selectFinalizers(
  definition: WorkflowDefinition,
  settledStepNames: ReadonlySet<string>,
  outcome: SettleStepOutcome,
): string[] {
  const groupA: string[] = [];
  const groupB: string[] = [];
  for (const [name, step] of Object.entries(definition.steps)) {
    if (step.execution !== 'finalizer') continue;
    if (settledStepNames.has(name)) continue; // at-most-once per run (resume / re-drive safety)
    const triggers = finalizerTriggers(step);
    if (triggers.has(outcome)) groupA.push(name);
    else if (triggers.has('always')) groupB.push(name);
  }
  return [...groupA, ...groupB];
}

// ---------------------------------------------------------------------------
// §4 mintFresh (terminal false→true edge only; same atomic write)
// ---------------------------------------------------------------------------

/**
 * `mintFresh` (design record §4): on a terminal false→true edge, selects the matching finalizers
 * and seeds a CLEAN `'pending'` entry for each one not already `completed`/`failed` (the
 * never-downgrade guard — defensive; membership-skip in `selectFinalizers` should already exclude
 * these). Rank totally orders the freshly-minted PENDING set only, starting at 0 for THIS mint
 * pass — collisions with terminal-status entries are legal and inert (§1's "Resume VOIDS
 * pendings, loudly" means no OTHER pending entry can coexist with a fresh mint in this
 * increment's design). Non-selected entries keep their status verbatim (history:
 * completed/failed/voided). Returns `record.finalizer_ledger` UNCHANGED (by reference) when
 * nothing is selected — the zero-finalizer / no-matching-trigger case falls out of this naturally,
 * without needing `buildFinalizedSeal`'s own explicit fast-path.
 */
function mintFresh(
  record: RunRecord,
  definition: WorkflowDefinition,
  outcome: SettleStepOutcome,
): FinalizerLedger | undefined {
  const settledStepNames = new Set([...record.completed_steps, ...record.failed_steps]);
  const selected = selectFinalizers(definition, settledStepNames, outcome);
  if (selected.length === 0) return record.finalizer_ledger;

  const ledger: FinalizerLedger = { ...record.finalizer_ledger };
  let rank = 0;
  for (const name of selected) {
    const prior = record.finalizer_ledger?.[name];
    if (prior?.status === 'completed' || prior?.status === 'failed') continue; // never-downgrade
    ledger[name] = { status: 'pending', rank: rank++ }; // CLEAN mint — no lease fields cross an edge
  }
  return ledger;
}

// ---------------------------------------------------------------------------
// §3 settleStepArms
// ---------------------------------------------------------------------------

function applySettleStep(
  fresh: RunRecord,
  delta: SettleStepDelta,
  definition: WorkflowDefinition,
  now: Date,
): SettlementResult {
  const { step, outcome, claimToken, evidence, failureMessage, abort } = delta;

  // Idempotence arms BEFORE terminal/claim (L21 ii).
  const existing = entryOf(fresh, step);
  if (existing !== undefined) {
    if (!tokensEqual(existing.token, claimToken)) {
      return { applied: false, reason: 'already_settled_by_other', run: fresh };
    }
    if (toSettledOutcome(outcome) === existing.outcome) {
      return { applied: false, reason: 'already_settled', run: fresh }; // drain-aware (§6)
    }
    return { applied: false, reason: 'settled_outcome_divergence', run: fresh };
  }

  if (isTerminal(fresh)) {
    return { applied: false, reason: 'run_terminal', run: fresh };
  }

  const claim = fresh.claims?.[step];
  if (claim === undefined || !tokensEqual(claim.token, claimToken)) {
    return { applied: false, reason: 'claim_lost', run: fresh };
  }

  if (fresh.pending_gate?.step_name === step) {
    return { applied: false, reason: 'gate_mismatch', run: fresh }; // legacy gates coexist in inc-1
  }

  if (outcome === 'abort' && abort === undefined) {
    // Caller-programming-error, not a predicate outcome — see SettleStepDelta's own doc.
    throw new Error(
      `applySettlement contract violation: settle_step delta for step '${step}' has ` +
        `outcome:'abort' but no 'abort' payload`,
    );
  }

  // APPLY (total; bound to source semantics by line — design record §3).
  const settledOutcome = toSettledOutcome(outcome);
  const withMembership: RunRecord = {
    ...fresh,
    in_progress_steps: fresh.in_progress_steps.filter((s) => s !== step),
    claims: omitClaim(fresh.claims, step),
    evidence: [...fresh.evidence, ...evidence],
    settled: { ...fresh.settled, [step]: { token: norm(claimToken), outcome: settledOutcome } },
    ...(outcome === 'complete' ? { completed_steps: [...fresh.completed_steps, step] } : {}),
    ...(outcome === 'fail' ? { failed_steps: [...fresh.failed_steps, step] } : {}),
    ...(outcome === 'abort' ? { skipped_steps: [...fresh.skipped_steps, step] } : {}),
  };

  if (outcome === 'abort') {
    return applyAbortEdge(fresh, withMembership, step, abort!, definition, now);
  }
  return applyCompleteOrFailEdge(withMembership, step, outcome, failureMessage, definition);
}

/**
 * Handler-abort (execution-loop.ts :1784-1811 semantics): UNCONDITIONALLY terminal — never gated
 * by the two-disjunct `isComplete` predicate (that predicate governs complete/fail only; an abort
 * always ends the run immediately, mirroring `executeGuardStep`'s own guard-abort branch).
 */
function applyAbortEdge(
  fresh: RunRecord,
  withMembership: RunRecord,
  step: string,
  abort: NonNullable<SettleStepDelta['abort']>,
  definition: WorkflowDefinition,
  now: Date,
): SettlementResult {
  const propagated = propagateSkips(withMembership, definition);
  const withSkipped: RunRecord = {
    ...withMembership,
    skipped_steps: propagated.skipped,
    skip_details: { ...propagated.details, [step]: { kind: 'handler_abort' } },
  };
  let aborted: RunRecord = {
    ...withSkipped,
    terminal_state: true,
    terminal_reason: `Handler '${step}' aborted the run: ${abort.abortMessage}`,
    aborted_at: { step_id: abort.stepId, abort_message: abort.abortMessage },
  };

  // Cancel an open gate on ANOTHER step in the SAME write (design record §3) — a genuinely NEW
  // capability the legacy handler-abort path lacks today (it preserves pending_gate untouched,
  // which is exactly the class of inconsistent state #279 exists to close). `fresh.pending_gate`
  // is read (not `aborted.pending_gate`) only for clarity — both are identical at this point since
  // nothing above has touched it.
  if (fresh.pending_gate !== undefined && fresh.pending_gate.step_name !== step) {
    const gateStepName = fresh.pending_gate.step_name;
    const { pending_gate: _droppedGate, ...withoutGate } = aborted;
    aborted = {
      ...withoutGate,
      in_progress_steps: withoutGate.in_progress_steps.filter((s) => s !== gateStepName),
      claims: omitClaim(withoutGate.claims, gateStepName),
      skipped_steps: [...withoutGate.skipped_steps, gateStepName],
      skip_details: {
        ...withoutGate.skip_details,
        [gateStepName]: { kind: 'gate_cancelled_by_abort' },
      },
      evidence: [
        ...withoutGate.evidence,
        captureEvidence({
          stepId: gateStepName,
          startedAt: now,
          completedAt: now,
          input: {},
          output: { gate_cancelled_by_abort: true, aborted_by: step },
        }),
      ],
    };
  }

  // On terminal false→true edge: mintFresh (§4), same atomic write. abort NEVER stamps
  // defaulted_steps (the FM-5/#232 guard — only the complete edge does).
  const ledger = mintFresh(aborted, definition, 'abort');
  const finalRun: RunRecord = {
    ...aborted,
    ...(ledger !== undefined ? { finalizer_ledger: ledger } : {}),
  };
  const withPhase: RunRecord = { ...finalRun, run_phase: deriveRunPhase(finalRun) };
  return {
    applied: true,
    run: withPhase,
    transitioned: true, // isTerminal(fresh) was already refused above — abort is always false→true
    pendingFinalizers: pendingFinalizerNames(withPhase.finalizer_ledger),
  };
}

/** complete / fail: the TWO-DISJUNCT `isComplete` predicate (execution-loop.ts :2579-2583 /
 *  :2237-2241 — named, not implied). */
function applyCompleteOrFailEdge(
  withMembership: RunRecord,
  step: string,
  outcome: 'complete' | 'fail',
  failureMessage: string | undefined,
  definition: WorkflowDefinition,
): SettlementResult {
  const propagated = propagateSkips(withMembership, definition);
  const withSkipped: RunRecord = {
    ...withMembership,
    skipped_steps: propagated.skipped,
    skip_details: propagated.details,
  };
  const isComplete =
    isWorkflowComplete(withSkipped, definition) ||
    (withSkipped.in_progress_steps.length === 0 &&
      findEligibleSteps(definition, withSkipped).length === 0 &&
      findEligibleGuardSteps(definition, withSkipped).length === 0);

  const draft: RunRecord = {
    ...withSkipped,
    terminal_state: isComplete,
    ...(isComplete
      ? {
          terminal_reason:
            outcome === 'complete'
              ? 'Workflow completed.' // eligibility.ts:47 keys deriveRunPhase's 'completed' on this
              : `Step '${step}' failed: ${failureMessage ?? 'unknown error'}`,
        }
      : {}),
  };

  let sealed = draft;
  if (isComplete) {
    // On terminal edge: mintFresh (§4), same atomic write.
    const ledger = mintFresh(draft, definition, outcome);
    sealed = { ...draft, ...(ledger !== undefined ? { finalizer_ledger: ledger } : {}) };
    // defaulted_steps stamped IFF complete-terminal edge (FM-5/#232 guard) — never on a fail seal,
    // even one that terminalizes.
    if (outcome === 'complete') {
      const defaultedSteps = deriveDefaultedSteps(sealed.evidence);
      if (defaultedSteps.length > 0) sealed = { ...sealed, defaulted_steps: defaultedSteps };
    }
  }

  const withPhase: RunRecord = { ...sealed, run_phase: deriveRunPhase(sealed) };
  return {
    applied: true,
    run: withPhase,
    transitioned: isComplete,
    pendingFinalizers: pendingFinalizerNames(withPhase.finalizer_ledger),
  };
}

// ---------------------------------------------------------------------------
// §3 leaseFinalizerArms — CALLER-MINTED token (lens-1 F3a)
// ---------------------------------------------------------------------------

function applyLeaseFinalizer(
  fresh: RunRecord,
  delta: LeaseFinalizerDelta,
  now: Date,
): SettlementResult {
  // Defensive; unreachable in-contract under §5 void-at-resume (no pending survives a resume).
  if (!isTerminal(fresh)) {
    return { applied: false, reason: 'run_not_terminal', run: fresh };
  }
  const e = fresh.finalizer_ledger?.[delta.finalizer];
  if (e === undefined) {
    return { applied: false, reason: 'not_eligible', run: fresh }; // unknown id — drain loop ABORTS loud
  }
  if (e.status !== 'pending') {
    return { applied: false, reason: 'ledger_not_pending', run: fresh }; // done/failed/voided — loop ADVANCES
  }

  const nowMs = now.getTime();
  const eDeadlineMs =
    e.lease_deadline !== undefined ? new Date(e.lease_deadline).getTime() : undefined;
  if (
    tokensEqual(e.lease_token, delta.leaseToken) &&
    eDeadlineMs !== undefined &&
    eDeadlineMs > nowMs
  ) {
    return { applied: false, reason: 'already_leased', run: fresh }; // own ambiguous retry — L21
  }
  const blocking = Object.values(fresh.finalizer_ledger ?? {}).find(
    (other) => other.status === 'pending' && other.rank < e.rank,
  );
  if (blocking !== undefined) {
    return { applied: false, reason: 'rank_blocked', run: fresh };
  }
  if (e.lease_token !== undefined && eDeadlineMs !== undefined && eDeadlineMs > nowMs) {
    return { applied: false, reason: 'lease_held', run: fresh };
  }

  // APPLY: lease_token = delta.leaseToken; lease_deadline = now + clamp(leaseSeconds, DRAIN_LEASE_MAX).
  const clampedSeconds = Math.min(delta.leaseSeconds, DRAIN_LEASE_MAX);
  const leaseDeadline = new Date(nowMs + clampedSeconds * 1000).toISOString();
  const ledger: FinalizerLedger = {
    ...fresh.finalizer_ledger,
    [delta.finalizer]: { ...e, lease_token: delta.leaseToken, lease_deadline: leaseDeadline },
  };
  const run: RunRecord = { ...fresh, finalizer_ledger: ledger };
  return {
    applied: true,
    run,
    transitioned: false,
    pendingFinalizers: pendingFinalizerNames(ledger),
  };
}

// ---------------------------------------------------------------------------
// §3 markFinalizerArms
// ---------------------------------------------------------------------------

function applyMarkFinalizer(fresh: RunRecord, delta: MarkFinalizerDelta): SettlementResult {
  const e = fresh.finalizer_ledger?.[delta.finalizer];
  if (e === undefined) {
    return { applied: false, reason: 'not_eligible', run: fresh };
  }
  if (e.status !== 'pending') {
    if (tokensEqual(e.lease_token, delta.leaseToken) && e.status === delta.result) {
      // Own retry — L21 (lens-1 F3b). APPLY does NOT clear lease fields.
      return { applied: false, reason: 'already_marked', run: fresh };
    }
    return { applied: false, reason: 'ledger_not_pending', run: fresh }; // peer marked / voided — benign
  }
  if (!tokensEqual(e.lease_token, delta.leaseToken)) {
    return { applied: false, reason: 'lease_lost', run: fresh };
  }
  // AFTER the token arms: defensive; voided-at-resume makes this unreachable in-contract (no
  // pending survives resume — the §0.4 audit question dissolves).
  if (!isTerminal(fresh)) {
    return { applied: false, reason: 'run_not_terminal', run: fresh };
  }

  // APPLY: status = result; completed_steps/failed_steps += name; evidence — ONE compound
  // atomic write (I14).
  const ledger: FinalizerLedger = {
    ...fresh.finalizer_ledger,
    [delta.finalizer]: { ...e, status: delta.result },
  };
  const withLedgerAndEvidence: RunRecord =
    delta.result === 'completed'
      ? {
          ...fresh,
          finalizer_ledger: ledger,
          completed_steps: [...fresh.completed_steps, delta.finalizer],
          evidence: [...fresh.evidence, delta.evidence],
        }
      : {
          ...fresh,
          finalizer_ledger: ledger,
          failed_steps: [...fresh.failed_steps, delta.finalizer],
          evidence: [...fresh.evidence, delta.evidence],
        };
  const run: RunRecord = {
    ...withLedgerAndEvidence,
    run_phase: deriveRunPhase(withLedgerAndEvidence),
  };
  return {
    applied: true,
    run,
    transitioned: false,
    pendingFinalizers: pendingFinalizerNames(ledger),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Applies one {@link SettlementDelta} against `fresh` — pure, synchronous, no I/O, no registry
 * (design record §7 CS-purity: `options` carries VALUES only). `definition` is passed per call
 * (never cached) — `lease_finalizer`/`mark_finalizer` deltas do not use it (their arms never
 * reference the workflow definition; only `settle_step`'s terminal-edge `mintFresh` does).
 *
 * `result.run` on `applied: true` is the AS-APPLIED transform output — see
 * {@link SettlementResult}'s own doc for the never-a-re-read invariant this carries.
 */
export function applySettlement(
  fresh: RunRecord,
  delta: SettlementDelta,
  definition: WorkflowDefinition,
  options?: { now?: Date },
): SettlementResult {
  const now = options?.now ?? new Date();
  switch (delta.kind) {
    case 'settle_step':
      return applySettleStep(fresh, delta, definition, now);
    case 'lease_finalizer':
      return applyLeaseFinalizer(fresh, delta, now);
    case 'mark_finalizer':
      return applyMarkFinalizer(fresh, delta);
  }
}
