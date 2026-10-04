// settlement.ts — the atomic-settlement pure transform (issue #279, increment 1, PR-A).
//
/* eslint-disable no-restricted-syntax --
 * issue #367 (part 2), AUTHORIZED per-file suppression. This layer stamps through the
 * `applyTerminalPostconditions` CHOKEPOINT, which is two-stage BY DESIGN: each arm builds its
 * draft (carrying `terminal_state`), and the chokepoint applies the seal. The same-object rule
 * cannot see that architecture, so the eight drafts below would trip it while being compliant.
 *
 * What still binds this file: the terminal-writer census pins its writer COUNT, so a ninth writer
 * that bypasses the chokepoint fails the guard; and the store boundary binds the fact itself at
 * runtime, everywhere, unconditionally.
 */
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
import type { RunRecord, SealArm, EvidenceSnapshot } from '../types/run-record.js';
import type { WorkflowDefinition, FinalizerTrigger } from '../types/workflow-definition.js';
import type {
  SettlementDelta,
  SettlementResult,
  SettleStepDelta,
  SettleStepOutcome,
  LeaseFinalizerDelta,
  MarkFinalizerDelta,
  OpenGateDelta,
  SettleGateDelta,
  SettleGuardDelta,
  ReleaseStepDelta,
  ExpireGateDelta,
} from '../types/settlement.js';
import {
  assertSealMarkersAgree,
  assertSealOutcomeCoherent,
  deriveRunPhase,
  isWorkflowComplete,
  findEligibleSteps,
  findEligibleGuardSteps,
  propagateSkips,
  buildEvidenceByStep,
  evaluateWhenCondition,
} from './eligibility.js';
import { deriveDefaultedSteps } from './defaulted-steps.js';
import { captureEvidence } from '../evidence/snapshot.js';
import { omitClaim } from './claim-liveness.js';
import { judgeGateProof, type GateClaimVerdict } from './holder.js';
import { DRAIN_LEASE_MAX } from './lifecycle.js';
import { evaluateGuardConditions } from './precondition.js';

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

/** `M := {complete: completed_steps, fail: failed_steps, skip: skipped_steps, gate:
 *  completed_steps}` — the membership array a settled-map entry's `outcome` maps to. `gate`
 *  (issue #279, increment 2, PR-C — design record §2) joined alongside `completed_steps`: a
 *  resolved gate's step physically lands there, same as a `complete` settle_step outcome. */
function membershipFor(fresh: RunRecord, outcome: SettledEntry['outcome']): readonly string[] {
  switch (outcome) {
    case 'complete':
    case 'gate':
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
 * Selects the finalizer steps that fire for a terminal outcome, in the drain order (design
 * record §4/§6, widened by #302's S2 fold; extracted from `buildFinalizedSeal`'s selection,
 * execution-loop.ts :3117-3126): Group A (rank precedence) — the finalizer's OWN declared
 * `on_outcome` set intersects the EFFECTIVE trigger set non-emptily; Group B — `on_outcome`
 * contains `'always'` but the finalizer missed Group A (a finalizer listing both runs once, in
 * Group A). Each group in `Object.entries` declaration order; Group A then Group B.
 * `settledStepNames` excludes any finalizer already at-most-once settled (resume/re-drive safety)
 * — pass `completed_steps ∪ failed_steps`, NEVER the `RunRecord.settled` map (a different,
 * per-step-outcome-keyed structure this selection does not consult).
 *
 * `outcome` accepts EITHER shape (issue #302, S2 — `selectFinalizers` is a PUBLIC export,
 * `index.ts`, so widening the param rather than replacing it is an API-compat requirement, not a
 * style choice):
 *  - a bare `SettleStepOutcome` string — every pre-#302 caller's shape, normalized internally to
 *    a singleton set; BYTE-IDENTICAL selection to the pre-widening behavior (pinned by the
 *    string-form compat test) and supported INDEFINITELY — this is not a deprecated compat shim.
 *  - a pre-derived `ReadonlySet<FinalizerTrigger>` (via {@link deriveEffectiveTriggers}) — the
 *    #302 call shape both engine chokepoints (`mintFresh`, `buildFinalizedSeal`) now use, letting
 *    a seal satisfy more than one trigger at once (e.g. `{'complete', 'completed_with_failed_steps'}`).
 * Semver: additive or (minor) — no existing call site's behavior changes.
 */
export function selectFinalizers(
  definition: WorkflowDefinition,
  settledStepNames: ReadonlySet<string>,
  outcome: SettleStepOutcome | ReadonlySet<FinalizerTrigger>,
): string[] {
  const effective: ReadonlySet<FinalizerTrigger> =
    typeof outcome === 'string' ? new Set([outcome]) : outcome;
  const groupA: string[] = [];
  const groupB: string[] = [];
  for (const [name, step] of Object.entries(definition.steps)) {
    if (step.execution !== 'finalizer') continue;
    if (settledStepNames.has(name)) continue; // at-most-once per run (resume / re-drive safety)
    const triggers = finalizerTriggers(step);
    let inGroupA = false;
    for (const t of triggers) {
      if (effective.has(t)) {
        inGroupA = true;
        break;
      }
    }
    if (inGroupA) groupA.push(name);
    else if (triggers.has('always')) groupB.push(name);
  }
  return [...groupA, ...groupB];
}

/**
 * Derives the full set of finalizer triggers a terminal `outcome` satisfies for `record` (issue
 * #302, design record §Mechanics-1): `{outcome}` — always — plus `'completed_with_failed_steps'`
 * when `outcome === 'complete' ∧ record.failed_steps.length > 0` (a "mixed complete" seal).
 *
 * TWO SURFACES, ONE SHAPE, TWO MOMENTS. #304's `completed_with_failed_steps` run-health finding
 * tests the same SHAPE (completed ∧ non-empty `failed_steps`), but it tests it at READ time on
 * the final record, whereas this function is evaluated at MINT time, inside
 * `applyTerminalPostconditions`, before any finalizer has run. There is no shared function and no
 * shared evaluation point — only a shared shape.
 *
 * The moment is what separates them, on a real population: a finalizer's OWN failure joins
 * `failed_steps` after the seal minted (see the failed arm below, where `delta.finalizer` is
 * appended), so a run that completes CLEAN and whose finalizer then fails is seen by the
 * read-time finding and was never seen by this trigger — the record it read had an empty
 * `failed_steps`. The divergence runs one way only: `failed_steps` only grows, so everything this
 * trigger fires on the finding also reports, and the finding additionally reports post-mint
 * finalizer self-failures. Tracked at #374 (P5); this comment describes what the code does today
 * and does not prejudge what that issue decides.
 *
 * Uniform across epochs (design record M1, deliberate): a second-epoch complete seal whose ONLY
 * `failed_steps` scar is a PRIOR epoch's finalizer self-failure (unresumable, so it never leaves
 * `failed_steps`) still fires this trigger — no exclusion of finalizer-declared step names. The
 * alternative (excluding finalizer names from the predicate) buys mint-time purity at the cost of
 * making the two surfaces disagree about a shape they can both see, which is a second divergence
 * on top of the one above.
 *
 * Pure; this ONE function is the seam a future authorable tolerance threshold (SFN-style: fire
 * only when `failed_steps.length` exceeds some declared N) would extend — banked, not built
 * (design record R2).
 */
export function deriveEffectiveTriggers(
  outcome: SettleStepOutcome,
  record: Pick<RunRecord, 'failed_steps'>,
): ReadonlySet<FinalizerTrigger> {
  const triggers = new Set<FinalizerTrigger>([outcome]);
  if (outcome === 'complete' && record.failed_steps.length > 0) {
    triggers.add('completed_with_failed_steps');
  }
  return triggers;
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
  // issue #302: derive the FULL effective trigger set (chokepoint 1 of 2) — record already
  // reflects this settlement's own membership effects (a 'complete' outcome's failed_steps here
  // is PRIOR failures only), so this is the correct read point for the mixed-complete predicate.
  const selected = selectFinalizers(
    definition,
    settledStepNames,
    deriveEffectiveTriggers(outcome, record),
  );
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
// §4 shared APPLY postconditions (design record design-d5-increment2.md §4, hoisted — lens-2 F4:
// "one implementation, every kind routes through it"). Every kind whose APPLY can terminalize
// (settle_step complete/fail/abort [shipped]; settle_gate resolution-complete; settle_guard
// pass/resolution_error/abort [increment 2, PR-C]) calls this ONE function to (1) mint fresh
// finalizers on a genuine terminal false→true edge (§4.1), (2) stamp `defaulted_steps` on a
// COMPLETE-terminal edge only (§4.2), and (3) derive `run_phase` uniformly (§4.5) — regardless of
// whether this particular APPLY actually transitioned.
// ---------------------------------------------------------------------------

/**
 * `record.terminal_state` must already reflect the kind-specific terminal decision (each arm
 * computes its own `isComplete`/unconditional-abort logic BEFORE calling this) — every in-contract
 * caller has already refused `run_terminal` earlier in its own arm, so `record.terminal_state` can
 * only be transitioning `false → true` here, never `true → true`; `transitioned` is therefore
 * simply the post-write value, read back explicitly (not assumed) so a future caller that ever
 * violates that precondition fails loudly via a wrong `transitioned` value rather than silently.
 */
function applyTerminalPostconditions(
  record: RunRecord,
  definition: WorkflowDefinition,
  mintOutcome: SettleStepOutcome,
  stampDefaulted: boolean,
  /**
   * issue #367: the ARM this settlement branch seals with — per-branch knowledge that exists
   * exactly once, at the seal site, at seal time (re-inferring it later is lossy in principle:
   * `guard_abort` and `handler_abort` differ only by writer-owned prose). Stamped IFF this apply
   * TRANSITIONED; the eight call sites in this file are the whole settlement-transform writer
   * census. A stale prior seal never survives a non-terminal fork — see the strip below.
   */
  seal: { arm: SealArm; step?: string },
): { run: RunRecord; transitioned: boolean } {
  const transitioned = record.terminal_state === true;
  // issue #367: strip any stale prior seal FIRST, so a non-terminal fork can never carry one out.
  const { sealed_by: _priorSeal, ...base } = record;
  let sealed: RunRecord = transitioned
    ? {
        ...base,
        sealed_by: { arm: seal.arm, ...(seal.step !== undefined ? { step: seal.step } : {}) },
      }
    : base;
  if (transitioned) {
    // On terminal false→true edge: mintFresh (§4.1), same atomic write.
    const ledger = mintFresh(sealed, definition, mintOutcome);
    sealed = { ...sealed, ...(ledger !== undefined ? { finalizer_ledger: ledger } : {}) };
    // defaulted_steps stamped IFF a COMPLETE-terminal edge (§4.2; the FM-5/#232 guard) — never on
    // a fail/abort seal, even one that terminalizes.
    if (stampDefaulted) {
      const defaultedSteps = deriveDefaultedSteps(sealed.evidence);
      if (defaultedSteps.length > 0) sealed = { ...sealed, defaulted_steps: defaultedSteps };
    }
    // issue #367: the two transform-scoped congruence assertions, on the record THIS function
    // produces — never universal (a universal marker law reds the published TERMINAL_STATE_ONLY
    // fixture by construction).
    assertSealMarkersAgree(sealed);
    assertSealOutcomeCoherent(sealed);
  }
  const withPhase: RunRecord = { ...sealed, run_phase: deriveRunPhase(sealed) };
  return { run: withPhase, transitioned };
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
    const cancelledGateId = fresh.pending_gate.gate_id;
    const { pending_gate: _droppedGate, ...withoutGate } = aborted;
    aborted = {
      ...withoutGate,
      in_progress_steps: withoutGate.in_progress_steps.filter((s) => s !== gateStepName),
      claims: omitClaim(withoutGate.claims, gateStepName),
      skipped_steps: [...withoutGate.skipped_steps, gateStepName],
      skip_details: {
        ...withoutGate.skip_details,
        // gate_id additive (design record §5 D-4) — the settle_gate run_terminal envelope's
        // cancelled-variant discriminator binds by this once populated.
        [gateStepName]: { kind: 'gate_cancelled_by_abort', gate_id: cancelledGateId },
      },
      evidence: [
        ...withoutGate.evidence,
        captureEvidence({
          stepId: gateStepName,
          startedAt: now,
          completedAt: now,
          input: {},
          output: { gate_cancelled_by_abort: true, aborted_by: step, gate_id: cancelledGateId },
        }),
      ],
    };
  }

  // §4 shared postconditions: abort NEVER stamps defaulted_steps (the FM-5/#232 guard — only the
  // complete edge does); `transitioned` is always true here (isTerminal(fresh) was already
  // refused above, and `aborted.terminal_state` is unconditionally true).
  const { run, transitioned } = applyTerminalPostconditions(aborted, definition, 'abort', false, {
    arm: 'handler_abort',
    step,
  });
  return {
    applied: true,
    run,
    transitioned,
    pendingFinalizers: pendingFinalizerNames(run.finalizer_ledger),
  };
}

// ---------------------------------------------------------------------------
// The run's one-line fail cause (issue #373)
// ---------------------------------------------------------------------------

/** Per-message cap before the truncation marker — sized from a real-corpus measurement
 *  (2026-08-20, n=31 evidence error messages from a live runsDir: p50=21, p95=248, max=254 — 19%
 *  of real messages were truncated at the previous unanchored 120; 256 keeps the whole observed
 *  distribution verbatim). Re-measure before changing; the 1024 sentence cap remains the global
 *  bound. */
const FAIL_CAUSE_MESSAGE_CAP = 256;
/** Hard cap on the WHOLE sentence, marker included — the returned string is never longer than
 *  this. (Tekton caps its joined validation detail at 1024 + `"..."`, i.e. 1027 out; realm's cap
 *  is inclusive, so an overflowing sentence lands at exactly 1024.) */
const FAIL_CAUSE_SENTENCE_CAP = 1024;
/** ASCII, not `…` — the marker travels through logs, terminals and a Postgres text column. */
const FAIL_CAUSE_TRUNCATION = '...';

/**
 * Renders the run-level cause for a run with MORE THAN ONE distinct failed step (issue #373).
 *
 * PRECONDITION — callers gate on `new Set(failedSteps).size > 1`. That gate is about which
 * sentence SHAPE a call site wants, not about grammar safety: the single-failure sentence is each
 * call site's own template (`Step 'a' failed: …`, `Guard step 'g' failed: …`), left where it is so
 * there is exactly one spelling of each. Output below is grammatical at any count.
 *
 * The defect it fixes: `failed_steps` is append-ordered by settlement commit, so naming one step
 * as THE cause named whichever failure settled LAST — and under true concurrency the lock race
 * decided the culprit. The sentence below is order-independent by construction:
 *
 * - **dedup, then sort lexically.** A domain step cannot appear twice today, but the post-seal
 *   finalizer append across resume epochs has never been executed for duplication — dedup makes
 *   the count honest either way. Sorting is the order rule (Tekton `sort.Strings`, rustc
 *   `error_codes.sort()`); array order IS settle order, the instability this fix exists to kill.
 * - **count first, no culprit, terminating verb.** The count is the one fact true regardless of
 *   order.
 * - **a missing message yields a bare step name.** Never fabricated — the string `undefined` must
 *   not be constructible here.
 */
export function renderFailCause(
  failedSteps: readonly string[],
  messages: ReadonlyMap<string, string>,
): string {
  const distinct = [...new Set(failedSteps)].sort();
  const rendered = distinct.map((step) => {
    const message = messages.get(step);
    if (message === undefined) return step;
    const capped =
      message.length > FAIL_CAUSE_MESSAGE_CAP
        ? message.slice(0, FAIL_CAUSE_MESSAGE_CAP) + FAIL_CAUSE_TRUNCATION
        : message;
    return `${step} ("${capped}")`;
  });
  // Grammatical across the WHOLE input domain, not just the domain the call sites use — a public
  // export that can emit "1 steps failed" is wrong output, precondition or no precondition
  // (ninja's own discipline: "subcommand failed" / "subcommands failed").
  const sentence = `${distinct.length} step${distinct.length === 1 ? '' : 's'} failed: ${rendered.join(', ')}.`;
  return sentence.length > FAIL_CAUSE_SENTENCE_CAP
    ? sentence.slice(0, FAIL_CAUSE_SENTENCE_CAP - FAIL_CAUSE_TRUNCATION.length) +
        FAIL_CAUSE_TRUNCATION
    : sentence;
}

/**
 * Last-`error`-snapshot-per-step, in one linear pass — the same last-per-step idiom
 * `buildSettlementNamespace` already ships. `EvidenceSnapshot.error` is stored VERBATIM by
 * `captureEvidence`, so these are the real per-step messages, not a reconstruction.
 *
 * A step can hold several error snapshots (retries, resume epochs); the LAST one is the message
 * that describes the failure the record currently carries.
 */
export function failureMessagesFromEvidence(
  evidence: readonly EvidenceSnapshot[],
): Map<string, string> {
  const messages = new Map<string, string>();
  for (const snapshot of evidence) {
    if (snapshot.error !== undefined) messages.set(snapshot.step_id, snapshot.error);
  }
  return messages;
}

/**
 * The evidence walk plus the call site's OWN in-hand message for its own step.
 *
 * At the guard sites the overlay is now DEFENSIVE, not load-bearing (issue #373 correction): the
 * guard's evidence `error` carries the unresolvable path itself, so the path survives the evidence
 * walk and the post-drain re-render alike. It is kept against caller-shaped evidence that might
 * arrive without it.
 *
 * `undefined` never clobbers an evidence message.
 */
export function failureMessagesWithOverlay(
  evidence: readonly EvidenceSnapshot[],
  step: string,
  inHand: string | undefined,
): Map<string, string> {
  const messages = failureMessagesFromEvidence(evidence);
  if (inHand !== undefined) messages.set(step, inHand);
  return messages;
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

  // issue #373: with MORE THAN ONE distinct failure the run has no single culprit, and naming one
  // named whichever settled last. At exactly one failure the sentence is unchanged — including the
  // `?? 'unknown error'` fallback, which is this site's shape and stays this site's shape.
  const failCause =
    new Set(withSkipped.failed_steps).size > 1
      ? renderFailCause(
          withSkipped.failed_steps,
          failureMessagesWithOverlay(withSkipped.evidence, step, failureMessage),
        )
      : `Step '${step}' failed: ${failureMessage ?? 'unknown error'}`;
  const draft: RunRecord = {
    ...withSkipped,
    terminal_state: isComplete,
    ...(isComplete
      ? {
          terminal_reason:
            outcome === 'complete'
              ? 'Workflow completed.' // the legacy-classifier leg keys 'completed' on this (#367)
              : failCause,
        }
      : {}),
  };

  // §4 shared postconditions: defaulted_steps stamps IFF this is a COMPLETE-terminal edge — never
  // on a fail seal, even one that terminalizes.
  const { run, transitioned } = applyTerminalPostconditions(
    draft,
    definition,
    outcome,
    outcome === 'complete' && isComplete,
    // issue #367: validation exhaustion is deliberately NOT a distinct arm — a VALIDATION_EXHAUSTED
    // fail seals 'step_failure' like any other; the distinction lives in defaulted_steps and the
    // step diagnostics. Never re-introduce a failure-code ternary here.
    { arm: outcome === 'complete' ? 'complete' : 'step_failure', step },
  );
  return {
    applied: true,
    run,
    transitioned,
    pendingFinalizers: pendingFinalizerNames(run.finalizer_ledger),
  };
}

// ---------------------------------------------------------------------------
// §3 openGateArms (issue #279, increment 2, PR-C) — fence = claimToken; entry lookup FIRST
// (design record lens-2 F1).
// ---------------------------------------------------------------------------

function applyOpenGate(fresh: RunRecord, delta: OpenGateDelta): SettlementResult {
  const { step, claimToken, pendingGate, evidence } = delta;

  // Idempotence arm BEFORE terminal/claim (mirrors settleStepArms's own ordering, L21 ii).
  const existing = entryOf(fresh, step);
  if (existing !== undefined) {
    if (existing.outcome === 'gate' && existing.token === pendingGate.gate_id) {
      // Exact-delta replay AFTER the gate already resolved (BU F6) — the gate this delta is
      // trying to open is the SAME one already committed as resolved.
      return { applied: false, reason: 'already_settled', run: fresh };
    }
    // Envelope text stays neutral (N1 — no "by_other" amplification) at the caller (PR-D).
    return { applied: false, reason: 'already_settled_by_other', run: fresh };
  }

  if (isTerminal(fresh)) {
    return { applied: false, reason: 'run_terminal', run: fresh };
  }

  if (fresh.pending_gate !== undefined) {
    if (fresh.pending_gate.step_name === step) {
      if (fresh.pending_gate.gate_id === pendingGate.gate_id) {
        // Exact-delta replay, gate still open (e.g. a retried gate-open write).
        return { applied: false, reason: 'already_settled', run: fresh };
      }
      const claim = fresh.claims?.[step];
      if (claim !== undefined && tokensEqual(claim.token, claimToken)) {
        // D-1: the LIVE gate wins, rendered VERBATIM. In-contract UNREACHABLE (claimStep's
        // in-flight guard + reclaim's own open-gate refusal both prevent a second open_gate
        // attempt from ever reaching here with a live claim) — defensive.
        return { applied: false, reason: 'already_open', run: fresh, gate: fresh.pending_gate };
      }
      // Same step, different claimant — defensive (a claim can't be re-acquired under an open
      // gate; findEligibleSteps returns [] while a gate is open).
      return { applied: false, reason: 'claim_lost', run: fresh };
    }
    // A gate open on ANOTHER step — serialization; the step named here STAYS claimed (L13
    // asserts this — the caller's recovery path is to wait for the live gate to resolve).
    return { applied: false, reason: 'gate_mismatch', run: fresh };
  }

  const claim = fresh.claims?.[step];
  if (claim === undefined || !tokensEqual(claim.token, claimToken)) {
    return { applied: false, reason: 'claim_lost', run: fresh };
  }

  // APPLY OPEN: pending_gate set (delta-carried verbatim); evidence append; CLAIM RETAINED + step
  // stays in_progress (execution-loop.ts:2958 — retention keeps isComplete sound, G-1). Never
  // terminalizes (design record §4.1) — run_phase still derives (§4.5: transform-owned uniformly).
  const withGate: RunRecord = {
    ...fresh,
    evidence: [...fresh.evidence, ...evidence],
    pending_gate: pendingGate,
  };
  const run: RunRecord = { ...withGate, run_phase: deriveRunPhase(withGate) };
  return {
    applied: true,
    run,
    transitioned: false,
    pendingFinalizers: pendingFinalizerNames(run.finalizer_ledger),
  };
}

// ---------------------------------------------------------------------------
// §3 settleGateArms (issue #279, increment 2, PR-C) — fence = gateId ONLY (L20). ZERO claim arms.
// ---------------------------------------------------------------------------

/**
 * Finds the (at most one, per G-2) `settled` entry recording a resolved gate matching `gateId` —
 * searched by gateId (the settle_gate fence), not by a known step name, since a gate submission
 * carries only the gate_id. `first` (design record §3): lookup runs FIRST for fail-safety under
 * corruption (D3 §0.2) — soundness of both the lookup and the "first" quantifier rests on G-2
 * (TERMINAL_GATE_EXCLUSION) plus per-attempt gate_id uniqueness plus the membership conjunct (the
 * orphan rule, generalized): a G-2-violating corrupt both-match record makes iteration order
 * store-dependent, which is exactly why the fail-safe direction (NOOP, never RESOLVE) is pinned
 * at the CALLER (this function returns whichever match Object.entries visits first — a real store
 * never produces two, so this never matters in-contract).
 */
function findSettledGateEntry(
  fresh: RunRecord,
  gateId: string,
): { step: string; choice: string | undefined; resolvedBy: 'timeout' | undefined } | undefined {
  for (const [step, entry] of Object.entries(fresh.settled ?? {})) {
    if (entry.outcome !== 'gate' || entry.token !== gateId) continue;
    if (!membershipFor(fresh, entry.outcome).includes(step)) continue; // orphan rule
    return { step, choice: entry.choice, resolvedBy: entry.resolved_by };
  }
  return undefined;
}

/**
 * issue #625 (the holder slice): the verdict of an answer that finds its question ALREADY settled —
 * `spent`, cause = how it was settled (`timeout` on the settled entry ⇒ the gate's expiry; any
 * other ⇒ an answer). The claim is gone by then (the settling write deleted it), so none is copied.
 */
function spentGateClaim(hit: { resolvedBy: 'timeout' | undefined }): GateClaimVerdictWithClaim {
  return judgeGateProof({
    claim: undefined,
    presented: undefined,
    settledBefore: hit.resolvedBy === 'timeout' ? 'expired' : 'answered',
    storeKeepsClaims: true,
  });
}

/** A verdict as a settlement result carries it: the verdict plus, when the gate step had a claim
 *  at the read, that claim's `holder` and `since` as stored — NEVER its token. */
export type GateClaimVerdictWithClaim = NonNullable<
  Extract<SettlementResult, { applied: true }>['gateClaim']
>;

/** The verdict alone — what the answer's entry records (never the claim's holder or since). */
export function verdictOnly(g: GateClaimVerdictWithClaim): GateClaimVerdict {
  const { claim: _claim, ...verdict } = g;
  return verdict;
}

export function judgeOpenGateClaim(
  fresh: RunRecord,
  stepName: string,
  presented: string | undefined,
  storeKeepsClaims: boolean,
): GateClaimVerdictWithClaim {
  const claim = fresh.claims?.[stepName];
  const verdict: GateClaimVerdict = judgeGateProof({
    claim,
    presented,
    settledBefore: undefined,
    storeKeepsClaims,
  });
  if (claim === undefined) return verdict;
  return {
    ...verdict,
    claim: {
      ...(claim.holder !== undefined ? { holder: claim.holder } : {}),
      ...(claim.since !== undefined ? { since: claim.since } : {}),
    },
  };
}

function applySettleGate(
  fresh: RunRecord,
  delta: SettleGateDelta,
  definition: WorkflowDefinition,
  // issue #291 ([F3] shape c, lane-1 authorized): injectable `now` threaded through, mirroring
  // every other `now`-consuming arm (`applySettleStep`'s abort branch, `applyExpireGate` below).
  // The ONE authorized addition to this function — every other line is byte-unchanged from PR-C.
  now: Date,
  // issue #625 (holder slice): whether the store keeping this record keeps claims at all — the
  // verdict's `store_keeps_no_claims` cause is minted here, once, from this input.
  storeKeepsClaims: boolean,
): SettlementResult {
  const { gateId, choice, evidence } = delta;

  // Lookup FIRST (D3 §0.2 fail-safer-under-corruption; L21 ii: the own-commit may have already
  // flipped terminal).
  const hit = findSettledGateEntry(fresh, gateId);
  if (hit !== undefined) {
    if (hit.choice === choice) {
      // Double-submit / two-gates delayed retry (TD F1) — same choice, idempotent no-op.
      return {
        applied: false,
        reason: 'already_settled',
        run: fresh,
        gateClaim: spentGateClaim(hit),
      };
    }
    return {
      applied: false,
      reason: 'gate_choice_conflict',
      run: fresh,
      ...(hit.choice !== undefined ? { winningChoice: hit.choice } : {}),
    };
  }

  // Zombie / stale submit — BEFORE the live-gate arm (matches the shipped `applySettleStep`
  // terminal-first order `:215-217`, AND the live `submitHumanResponse` site's own terminal-first
  // check `:3431`): a grandfathered terminal∧pending_gate record refuses run_terminal instead of
  // resurrecting the run or falsely completing it.
  if (isTerminal(fresh)) {
    return { applied: false, reason: 'run_terminal', run: fresh };
  }

  if (fresh.pending_gate !== undefined && fresh.pending_gate.gate_id === gateId) {
    // issue #625 (holder slice): the proof is judged ONCE, here, once the open gate's id has
    // matched and before anything else is decided — it is attached to whichever result follows
    // and decides NOTHING (the answer is decided by the gate id alone).
    const gateClaim = judgeOpenGateClaim(
      fresh,
      fresh.pending_gate.step_name,
      delta.claimToken,
      storeKeepsClaims,
    );
    // issue #291 ([F3] shape c, the expiry-WINS mechanism): a WRITE-FREE refusal when the live
    // gate has expired unresolved AND has an enactable disposition (`on_expiry` frozen) —
    // checked under the lock, with the injectable `now`, BEFORE choice_not_eligible. The caller
    // (submitHumanResponse) reacts to this refusal by issuing its OWN `expire_gate` settleStep
    // (this function never enacts anything itself — that stays applyExpireGate's job) and
    // composing the honest envelope from the enactment result. This is exact-at-the-
    // serialization-point-once-observed, uniform-fleet-only: a gate minted by an old binary (no
    // `expires_at` frozen) can never trip this arm. The `on_expiry !== undefined` conjunct is
    // load-bearing: a FINDING-ONLY gate (expires_at present, on_expiry absent) has NOTHING that
    // could ever win this race — refusing the human here with no enactable disposition to
    // compose an envelope from would strand the human's response forever (the exact
    // undisposable dead-end this feature exists to cure), since expire_gate would just refuse
    // `no_disposition` right back. A finding-only gate's human response always resolves
    // normally, however overdue.
    if (
      fresh.pending_gate.expires_at !== undefined &&
      fresh.pending_gate.on_expiry !== undefined &&
      now.getTime() >= new Date(fresh.pending_gate.expires_at).getTime()
    ) {
      return { applied: false, reason: 'gate_expired_pending', run: fresh, gateClaim };
    }
    if (!fresh.pending_gate.choices.includes(choice)) {
      return {
        applied: false,
        reason: 'choice_not_eligible',
        run: fresh,
        choices: fresh.pending_gate.choices,
      };
    }

    // APPLY RESOLVE: clear pending_gate; completed_steps += step_name; release claim +
    // in_progress (execution-loop.ts:3519-3520 parity); settled[step] = {token: gateId,
    // outcome:'gate', choice} — 'gate' LITERAL here, toSettledOutcome's own SettleStepOutcome
    // domain stays untouched (§2).
    const stepName = fresh.pending_gate.step_name;
    const { pending_gate: _pg, ...rest } = fresh;
    const withMembership: RunRecord = {
      ...rest,
      in_progress_steps: rest.in_progress_steps.filter((s) => s !== stepName),
      claims: omitClaim(rest.claims, stepName),
      completed_steps: [...rest.completed_steps, stepName],
      // issue #625 (holder slice): the verdict is judged inside this write, so it is stamped on the
      // answer's own entry here (the entry was built before the write, from the pre-read).
      evidence: [
        ...rest.evidence,
        ...evidence.map((e) =>
          e.kind === 'gate_response' ? { ...e, claim_proof: verdictOnly(gateClaim) } : e,
        ),
      ],
      settled: { ...rest.settled, [stepName]: { token: gateId, outcome: 'gate', choice } },
    };
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
      // The legacy-classifier leg of deriveRunPhase keys 'completed' on this exact string —
      // for the LEGACY population only; on a stamped record the arm derives (issue #367).
      ...(isComplete ? { terminal_reason: 'Workflow completed.' } : {}),
    };
    const { run, transitioned } = applyTerminalPostconditions(
      draft,
      definition,
      'complete',
      isComplete,
      { arm: 'gate_resolution_complete', step: stepName },
    );
    return {
      applied: true,
      run,
      transitioned,
      pendingFinalizers: pendingFinalizerNames(run.finalizer_ledger),
      gateClaim,
    };
  }

  // Superseded/unknown gateId on a live run.
  return { applied: false, reason: 'gate_mismatch', run: fresh };
}

// ---------------------------------------------------------------------------
// §3 expireGateArms (issue #291; design record `plans/issue-291/design-d2.md` [F1]/[F2]/[F3]/[F9])
// — fence = gateId ONLY (mirrors settleGateArms — L20). Enacts a gate's FROZEN enforce-clock
// disposition once expired-unresolved. Reads the RECORD only, never the workflow definition
// (F2's whole point — kills the definition-drift livelock: a re-registered workflow's changed
// `choices`/`default_choice` can never make an already-open gate's expiry refuse forever).
// ---------------------------------------------------------------------------

function applyExpireGate(
  fresh: RunRecord,
  delta: ExpireGateDelta,
  definition: WorkflowDefinition,
  now: Date,
): SettlementResult {
  const { gateId } = delta;

  // Lookup FIRST ([F1] i; D3 §0.2 fail-safer-under-corruption — same order as settleGateArms).
  const hit = findSettledGateEntry(fresh, gateId);
  if (hit !== undefined) {
    return {
      applied: false,
      reason: 'already_settled',
      run: fresh,
      gateClaim: spentGateClaim(hit),
    };
  }

  // Terminal split ([F1] iv, the replay/crash-recovery arm): a prior expire-abort enactment for
  // THIS gateId already sealed the run — NOOP (idempotent replay). Any OTHER terminal cause
  // (a different disposition, a concurrent human resolve that raced ahead, a handler-abort on a
  // sibling) REFUSES run_terminal — never silently resurrect or re-terminalize.
  if (isTerminal(fresh)) {
    const expiredEntry = Object.entries(fresh.skip_details ?? {}).find(
      ([, d]) => d.kind === 'gate_expired' && d.gate_id === gateId,
    );
    if (expiredEntry !== undefined) {
      return { applied: false, reason: 'already_settled', run: fresh };
    }
    return { applied: false, reason: 'run_terminal', run: fresh };
  }

  // No/other pending_gate ([F1] iii) — superseded or unknown gateId on a live run. Mirrors
  // settleGateArms's own final fallthrough exactly.
  if (fresh.pending_gate === undefined || fresh.pending_gate.gate_id !== gateId) {
    return { applied: false, reason: 'gate_mismatch', run: fresh };
  }

  const gate = fresh.pending_gate;

  // now < expires_at ([F1] the new arm-verified refusal, NEVER trusting the caller's own clock):
  // premature enactment attempt. Absent expires_at (a grandfathered/old-binary-minted gate, R-d)
  // falls into this same refusal — it can never legitimately expire, so no in-contract caller
  // should ever construct this delta for one; defensive rather than a crash either way.
  if (gate.expires_at === undefined || now.getTime() < new Date(gate.expires_at).getTime()) {
    return { applied: false, reason: 'not_expired', run: fresh };
  }

  // Finding-only mode (the prompt's own addendum, MA-ratified): timeout_seconds is present
  // (expires_at exists) but on_expiry is absent — REFUSE no_disposition, arm-level, BEFORE APPLY.
  // Never enacted; disclosed only via the run-health finding + the notifier's finding-only wording.
  if (gate.on_expiry === undefined) {
    return { applied: false, reason: 'no_disposition', run: fresh };
  }

  const respondedAt = now;
  const stepName = gate.step_name;

  if (gate.on_expiry === 'settle_default') {
    // APPLY settle_default: reuses settleGateArms' own RESOLVE shape end-to-end (choice =
    // FROZEN default_choice, clear gate, complete step, release claim, isComplete/terminalize) —
    // written as its OWN independent implementation (settleGateArms itself stays byte-untouched
    // beyond the F3 addition above), attributed `resolved_by: 'timeout'`.
    const choice = gate.default_choice!; // E2/[F10]-enforced at load: required-iff-settle_default.
    const evidence = captureEvidence({
      stepId: stepName,
      startedAt: new Date(gate.opened_at),
      completedAt: respondedAt,
      input: { choice },
      output: { ...gate.preview, choice },
    });
    const gateResponseSnapshot: EvidenceSnapshot = {
      ...evidence,
      kind: 'gate_response' as const,
      ...(gate.resolved_message !== undefined ? { gate_message: gate.resolved_message } : {}),
      responded_by: 'timeout',
      resolution: 'expired_default',
    };
    const { pending_gate: _pg, ...rest } = fresh;
    const withMembership: RunRecord = {
      ...rest,
      in_progress_steps: rest.in_progress_steps.filter((s) => s !== stepName),
      claims: omitClaim(rest.claims, stepName),
      completed_steps: [...rest.completed_steps, stepName],
      evidence: [...rest.evidence, gateResponseSnapshot],
      settled: {
        ...rest.settled,
        [stepName]: { token: gateId, outcome: 'gate', choice, resolved_by: 'timeout' },
      },
    };
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
      ...(isComplete ? { terminal_reason: 'Workflow completed.' } : {}),
    };
    const { run, transitioned } = applyTerminalPostconditions(
      draft,
      definition,
      'complete',
      isComplete,
      { arm: 'gate_expiry_default', step: stepName },
    );
    return {
      applied: true,
      run,
      transitioned,
      pendingFinalizers: pendingFinalizerNames(run.finalizer_ledger),
    };
  }

  // APPLY abort (on_expiry === 'abort'): a NEW own-step arm — applyAbortEdge is sibling-only
  // (its cancel-gate branch only fires for `pending_gate.step_name !== step`), so aborting the
  // GATE'S OWN step needs its own shape: clear pending_gate + aborted_at + skip_details
  // {kind:'gate_expired', gate_id} (day-one, F9) + mintFresh — in ONE write (TERMINAL_GATE_
  // EXCLUSION: never leave BOTH a live pending_gate AND a settled 'gate' entry — this branch
  // writes NEITHER a settled entry NOR a completed_steps membership; the step lands in
  // skipped_steps instead, mirroring every other abort disposition in this file).
  const evidence = captureEvidence({
    stepId: stepName,
    startedAt: new Date(gate.opened_at),
    completedAt: respondedAt,
    input: {},
    output: { gate_expired: true, disposition: 'abort' },
  });
  const gateResponseSnapshot: EvidenceSnapshot = {
    ...evidence,
    kind: 'gate_response' as const,
    ...(gate.resolved_message !== undefined ? { gate_message: gate.resolved_message } : {}),
    responded_by: 'timeout',
    resolution: 'expired_abort',
  };
  const { pending_gate: _pg2, ...withoutGate } = fresh;
  const withSkippedSelf: RunRecord = {
    ...withoutGate,
    in_progress_steps: withoutGate.in_progress_steps.filter((s) => s !== stepName),
    claims: omitClaim(withoutGate.claims, stepName),
    skipped_steps: [...withoutGate.skipped_steps, stepName],
    skip_details: {
      ...withoutGate.skip_details,
      [stepName]: { kind: 'gate_expired', gate_id: gateId },
    },
    evidence: [...withoutGate.evidence, gateResponseSnapshot],
  };
  const propagated = propagateSkips(withSkippedSelf, definition);
  const withSkipped: RunRecord = {
    ...withSkippedSelf,
    skipped_steps: propagated.skipped,
    skip_details: { ...propagated.details, [stepName]: { kind: 'gate_expired', gate_id: gateId } },
  };
  const aborted: RunRecord = {
    ...withSkipped,
    terminal_state: true,
    terminal_reason: `Gate '${stepName}' expired and the run aborted per the workflow's declared on_expiry.`,
    aborted_at: {
      step_id: stepName,
      abort_message: `Gate expired (timeout_seconds elapsed with no human response); on_expiry: 'abort'.`,
    },
  };
  // §4 shared postconditions: abort NEVER stamps defaulted_steps (the FM-5/#232 guard);
  // `transitioned` is always true (isTerminal(fresh) already refused above).
  const { run, transitioned } = applyTerminalPostconditions(aborted, definition, 'abort', false, {
    arm: 'gate_expiry_abort',
    step: stepName,
  });
  return {
    applied: true,
    run,
    transitioned,
    pendingFinalizers: pendingFinalizerNames(run.finalizer_ledger),
  };
}

// ---------------------------------------------------------------------------
// §3 settleGuardArms (issue #279, increment 2, PR-C) — fence = ⊥ (guards are never claimed,
// eligibility.ts:418); writes NO settled entry (SE-4).
// ---------------------------------------------------------------------------

function ownMembershipFor(
  fresh: RunRecord,
  outcome: SettleGuardDelta['outcome'],
): readonly string[] {
  switch (outcome) {
    case 'pass':
      return fresh.completed_steps;
    case 'resolution_error':
      return fresh.failed_steps;
    case 'abort':
      return fresh.skipped_steps;
  }
}

function applySettleGuard(
  fresh: RunRecord,
  delta: SettleGuardDelta,
  definition: WorkflowDefinition,
): SettlementResult {
  const { step, outcome, evidence, resolutionError, abort } = delta;

  if (outcome === 'resolution_error' && resolutionError === undefined) {
    // Caller-programming-error, not a predicate outcome (the SettleStepDelta abort precedent).
    throw new Error(
      `applySettlement contract violation: settle_guard delta for step '${step}' has ` +
        `outcome:'resolution_error' but no 'resolutionError' payload`,
    );
  }
  if (outcome === 'abort' && abort === undefined) {
    throw new Error(
      `applySettlement contract violation: settle_guard delta for step '${step}' has ` +
        `outcome:'abort' but no 'abort' payload`,
    );
  }

  // A := {pass: completed_steps, resolution_error: failed_steps, abort: skipped_steps} (lens-1 F8).
  if (ownMembershipFor(fresh, outcome).includes(step)) {
    if (outcome === 'abort' && fresh.skip_details?.[step]?.kind !== 'guard_abort') {
      // In skipped_steps, but NOT via a prior guard_abort (e.g. when_false/trigger_rule_
      // unsatisfiable instead) — a genuine divergence, not this guard's own convergent retry.
      return {
        applied: false,
        reason: 'settled_outcome_divergence',
        run: fresh,
        persisted: 'skip-non-abort',
      };
    }
    // Convergence on own-APPLY coordinates (L21) — idempotent retry.
    return { applied: false, reason: 'already_settled', run: fresh };
  }

  // Any OTHER membership array already containing this step is a genuine divergence — a
  // different settle already committed a DIFFERENT outcome for the same guard.
  if (fresh.completed_steps.includes(step)) {
    return {
      applied: false,
      reason: 'settled_outcome_divergence',
      run: fresh,
      persisted: 'complete',
    };
  }
  if (fresh.failed_steps.includes(step)) {
    return { applied: false, reason: 'settled_outcome_divergence', run: fresh, persisted: 'fail' };
  }
  if (fresh.skipped_steps.includes(step)) {
    return { applied: false, reason: 'settled_outcome_divergence', run: fresh, persisted: 'skip' };
  }

  if (isTerminal(fresh)) {
    return { applied: false, reason: 'run_terminal', run: fresh }; // terminal by OTHER
  }

  if (fresh.pending_gate !== undefined && outcome !== 'pass') {
    // D-2: the GATE WINS; quiet end-of-pass — nothing is decided here. The guard is decided by the
    // write that settles the gate (issue #625: an answer or an expiry settles the guards it makes
    // eligible in that same write).
    return { applied: false, reason: 'gate_open_wait', run: fresh };
  }

  // APPLY GUARD.
  if (outcome === 'resolution_error') {
    const withFailed: RunRecord = {
      ...fresh,
      evidence: [...fresh.evidence, evidence],
      failed_steps: [...fresh.failed_steps, step],
    };
    const propagated = propagateSkips(withFailed, definition);
    const withSkipped: RunRecord = {
      ...withFailed,
      skipped_steps: propagated.skipped,
      skip_details: propagated.details,
    };
    // issue #373: this site names the guard alone even when other steps had already failed
    // (executed with failed_steps=["fail_a","g"]). At >1 distinct failure it renders the whole
    // set; at exactly one the sentence below is byte-unchanged.
    // issue #625: a guard that could not be evaluated at all carries its own `cause` — there is no
    // path to name. This line stays the ONE mint of the sentence either way.
    const guardPath =
      resolutionError!.cause ?? `unresolvable path '${resolutionError!.unresolvable_path}'`;
    const draft: RunRecord = {
      ...withSkipped,
      terminal_state: true,
      // execution-loop.ts:4812 parity.
      terminal_reason:
        new Set(withSkipped.failed_steps).size > 1
          ? renderFailCause(
              withSkipped.failed_steps,
              // Defensive once evidence carries the path (issue #373 correction); kept against
              // caller-shaped evidence that arrives without it.
              failureMessagesWithOverlay(withSkipped.evidence, step, guardPath),
            )
          : `Guard step '${step}' failed: ${guardPath}`,
    };
    const { run, transitioned } = applyTerminalPostconditions(draft, definition, 'fail', false, {
      arm: 'guard_resolution_error',
      step,
    });
    return {
      applied: true,
      run,
      transitioned,
      pendingFinalizers: pendingFinalizerNames(run.finalizer_ledger),
    };
  }

  if (outcome === 'abort') {
    const withSkippedSelf: RunRecord = {
      ...fresh,
      evidence: [...fresh.evidence, evidence],
      skipped_steps: [...fresh.skipped_steps, step],
    };
    const propagated = propagateSkips(withSkippedSelf, definition);
    const withSkipped: RunRecord = {
      ...withSkippedSelf,
      skipped_steps: propagated.skipped,
      // #111: the merge preserves any cascade details for OTHER now-unreachable steps alongside
      // this guard's own guard_abort tag (execution-loop.ts:3728-3735 parity).
      skip_details: { ...propagated.details, [step]: { kind: 'guard_abort' } },
    };
    const draft: RunRecord = {
      ...withSkipped,
      terminal_state: true,
      // terminal_reason ABSENT — phase 'aborted' derives from aborted_at (§4 table).
      aborted_at: {
        step_id: step,
        conditions: abort!.conditions,
        ...(abort!.abort_message !== undefined ? { abort_message: abort!.abort_message } : {}),
      },
    };
    const { run, transitioned } = applyTerminalPostconditions(draft, definition, 'abort', false, {
      arm: 'guard_abort',
      step,
    });
    return {
      applied: true,
      run,
      transitioned,
      pendingFinalizers: pendingFinalizerNames(run.finalizer_ledger),
    };
  }

  // pass: two-disjunct isComplete predicate (same shape as settleStepArms's own).
  const withCompleted: RunRecord = {
    ...fresh,
    evidence: [...fresh.evidence, evidence],
    completed_steps: [...fresh.completed_steps, step],
  };
  const propagated = propagateSkips(withCompleted, definition);
  const withSkipped: RunRecord = {
    ...withCompleted,
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
    // execution-loop.ts:3675-3705 parity; the legacy-classifier leg keys 'completed' on
    // this exact string.
    ...(isComplete ? { terminal_reason: 'Workflow completed.' } : {}),
  };
  const { run, transitioned } = applyTerminalPostconditions(
    draft,
    definition,
    'complete',
    isComplete,
    { arm: 'guard_pass_complete', step },
  );
  return {
    applied: true,
    run,
    transitioned,
    pendingFinalizers: pendingFinalizerNames(run.finalizer_ledger),
  };
}

// ---------------------------------------------------------------------------
// §3 releaseStepArms (issue #279, increment 2, PR-C) — fence = claimToken. NEVER terminal, writes
// NO settled entry — the step returns to eligible.
// ---------------------------------------------------------------------------

function applyReleaseStep(fresh: RunRecord, delta: ReleaseStepDelta, now: Date): SettlementResult {
  const { step, claimToken, capabilityBlock, evidence } = delta;

  if (entryOf(fresh, step) !== undefined) {
    return { applied: false, reason: 'already_settled_by_other', run: fresh };
  }

  if (isTerminal(fresh)) {
    return { applied: false, reason: 'run_terminal', run: fresh };
  }

  const claim = fresh.claims?.[step];
  if (claim === undefined) {
    // TD F10: the claim is already gone — the RELEASE intent already holds. Idempotent no-op.
    return { applied: false, reason: 'already_released', run: fresh };
  }
  if (!tokensEqual(claim.token, claimToken)) {
    // Never stomp a successor's claim (execution-loop.ts:660-671 parity).
    return { applied: false, reason: 'claim_lost', run: fresh };
  }
  if (fresh.pending_gate?.step_name === step) {
    // reclaim-step.ts:389 parity — a claim pinned by an open gate is never released this way.
    return { applied: false, reason: 'gate_mismatch', run: fresh };
  }

  // APPLY RELEASE: release claim + in_progress; optional capability_blocks merge
  // (execution-loop.ts:2461-2475 semantics); optional evidence append (execution-loop.ts:679
  // semantics — the compensating un-claim's own audit snapshot). NEVER terminal, NO settled entry.
  const withRelease: RunRecord = {
    ...fresh,
    in_progress_steps: fresh.in_progress_steps.filter((s) => s !== step),
    claims: omitClaim(fresh.claims, step),
    ...(capabilityBlock !== undefined
      ? {
          capability_blocks: {
            ...fresh.capability_blocks,
            [step]: {
              requirement: capabilityBlock.requirement,
              code: capabilityBlock.code,
              at: now.toISOString(),
            },
          },
        }
      : {}),
    ...(evidence !== undefined ? { evidence: [...fresh.evidence, ...evidence] } : {}),
  };
  const run: RunRecord = { ...withRelease, run_phase: deriveRunPhase(withRelease) };
  return {
    applied: true,
    run,
    transitioned: false,
    pendingFinalizers: pendingFinalizerNames(run.finalizer_ledger),
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
  const phase = deriveRunPhase(withLedgerAndEvidence);
  // issue #373: the finalizer's OWN failure joins `failed_steps` here, AFTER the seal minted the
  // sentence — which is how a sealed cause went stale and undercounted the record. Re-render from
  // the grown record, but ONLY on the failed arm: on the completed arm nothing grew, and a
  // re-render there would rebuild without the seal site's in-hand overlay (the guard sites' path
  // text) and silently drop it.
  const failedArmCause =
    delta.result !== 'completed' &&
    phase === 'failed' &&
    new Set(withLedgerAndEvidence.failed_steps).size > 1
      ? renderFailCause(
          withLedgerAndEvidence.failed_steps,
          failureMessagesFromEvidence(withLedgerAndEvidence.evidence),
        )
      : undefined;
  const run: RunRecord = {
    ...withLedgerAndEvidence,
    run_phase: phase,
    ...(failedArmCause !== undefined ? { terminal_reason: failedArmCause } : {}),
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
  options?: { now?: Date; cascadeGuards?: boolean; storeKeepsClaims?: boolean },
): SettlementResult {
  const now = options?.now ?? new Date();
  // issue #625 (holder slice): absent ⇒ false. A store's own `settleStep` passes
  // `this.persistsClaims === true`; the transform mints `store_keeps_no_claims` itself.
  const storeKeepsClaims = options?.storeKeepsClaims === true;
  // issue #625: without the option the transform is exactly what it was — one delta, no guard
  // settled, and every throw it had. Only a store's own `settleStep` sets the option on a write
  // (plus the drain dry run, which predicts and never persists).
  if (options?.cascadeGuards !== true || !CASCADING_KINDS.has(delta.kind)) {
    return applyDelta(fresh, delta, definition, now, storeKeepsClaims);
  }
  // With the option set, a guard whose `when` cannot be evaluated must not make THIS write
  // unrecordable: the base arm, the loop's eligibility read and `applySettleGuard` all get a copy
  // of the definition in which such a guard has no `when`, so it reads as eligible and the loop
  // settles it as a resolution error.
  const total = totalGuardDefinition(definition, fresh);
  const base = applyDelta(fresh, delta, total.definition, now, storeKeepsClaims);
  // Only an APPLIED delta cascades: a refusal or a no-op stays write-free.
  if (!base.applied) return base;
  return settleEligibleGuards(base, total, now, fresh.version);
}

/** The delta kinds after which an applied write settles the guards it made eligible (issue #625).
 *  `open_gate` and `release_step` make no guard eligible (a gate is open, or a step returned to
 *  eligible); the two finalizer kinds need a terminal run, where no guard is eligible. */
const CASCADING_KINDS: ReadonlySet<SettlementDelta['kind']> = new Set<SettlementDelta['kind']>([
  'settle_step',
  'settle_gate',
  'expire_gate',
  'settle_guard',
]);

/**
 * issue #625: a guard's evaluation — its `abort_unless` conditions over the record's evidence, and
 * ONE evidence entry stamped with the caller's `now`. Pure: no await, no registry, no store.
 *
 * The ONE evaluation: the chain's `executeGuardStep` and the settlement cascade both call this, so
 * a guard decided by an answer's write and a guard decided by the chain cannot disagree.
 *
 * Throws when a condition cannot be split (a non-string `abort_unless` entry, e.g. `[42]`). The
 * chain lets that throw, as it always has; the cascade catches it and settles the guard as a
 * resolution error.
 */
export function buildGuardDelta(
  stepName: string,
  definition: WorkflowDefinition,
  run: RunRecord,
  now: Date,
  evaluatedAtVersion: number,
): SettleGuardDelta {
  const stepDef = definition.steps[stepName]!;
  // Normalise abort_unless to string[].
  const conditions = Array.isArray(stepDef.abort_unless)
    ? stepDef.abort_unless
    : [stepDef.abort_unless!];
  // Evaluate all conditions (no short-circuit — record all outcomes).
  const outcome = evaluateGuardConditions(conditions, buildEvidenceByStep(run));

  if (outcome.kind === 'resolution_error') {
    // Authoring error — a path in abort_unless could not be resolved.
    return {
      kind: 'settle_guard',
      step: stepName,
      outcome: 'resolution_error',
      evidence: captureEvidence({
        stepId: stepName,
        startedAt: now,
        completedAt: now,
        input: {},
        output: { error: `Unresolvable path: ${outcome.unresolvable_path}` },
        // issue #373 correction: the path is the DIAGNOSTIC, and it used to live only in
        // `output_summary` + a transient seal-time overlay — so the post-drain re-render, which
        // rebuilds the cause from evidence alone, replaced it with the generic condition text.
        // Carrying it here makes every downstream read of this failure lossless.
        //
        // The path goes FIRST because the per-message cap slices from the head: with the path last,
        // a long enough condition pushed it off the tail and the diagnostic vanished again. Honest
        // bound: a pathological PATH over ~230 chars still truncates itself, which is accepted —
        // head-first truncation keeps its prefix, and the prefix is the orienting part. ASCII
        // parenthetical, not an em dash, for the same reason the truncation marker is ASCII (logs,
        // terminals, a Postgres text column) — and a cut-off parenthetical reads as obviously partial.
        error: `Guard resolution error: unresolvable path '${outcome.unresolvable_path}' (condition: ${outcome.condition})`,
      }),
      resolutionError: {
        condition: outcome.condition,
        unresolvable_path: outcome.unresolvable_path,
      },
      evaluatedAtVersion,
    };
  }

  if (outcome.kind === 'pass') {
    // All conditions true — guard passed, run continues.
    return {
      kind: 'settle_guard',
      step: stepName,
      outcome: 'pass',
      evidence: captureEvidence({
        stepId: stepName,
        startedAt: now,
        completedAt: now,
        input: {},
        output: { conditions: outcome.conditions, aborted: false },
      }),
      evaluatedAtVersion,
    };
  }

  // Guard fired — one or more conditions false; abort the run.
  return {
    kind: 'settle_guard',
    step: stepName,
    outcome: 'abort',
    evidence: captureEvidence({
      stepId: stepName,
      startedAt: now,
      completedAt: now,
      input: {},
      output: {
        conditions: outcome.conditions,
        aborted: true,
        ...(stepDef.abort_message !== undefined ? { abort_message: stepDef.abort_message } : {}),
      },
      error: stepDef.abort_message ?? `Guard step '${stepName}' aborted the run.`,
    }),
    abort: {
      conditions: outcome.conditions,
      ...(stepDef.abort_message !== undefined ? { abort_message: stepDef.abort_message } : {}),
    },
    evaluatedAtVersion,
  };
}

/** A definition whose guards can all have their `when` evaluated, plus what was removed to make
 *  it so (issue #625) — see {@link totalGuardDefinition}. */
interface TotalGuardDefinition {
  definition: WorkflowDefinition;
  /** guard step name → the message its `when` threw and the `when` it declared. Empty when no
   *  guard's `when` throws. */
  whenFailures: ReadonlyMap<string, { thrown: string; declared: unknown }>;
}

/**
 * issue #625 (the cascade never throws, site b): a copy of the definition in which every guard
 * whose `when` THROWS on evaluation has no `when`, plus the thrown message per such guard.
 *
 * Why a copy and not a catch: a guard's `when` is evaluated by `propagateSkips` — which every
 * settling arm calls, `applySettleGuard` included — and again by `findEligibleGuardSteps`. A
 * non-string `when` (`when: 42`) throws there, before any guard loop runs, and made the write that
 * reached it unrecordable. Without its `when` the guard reads as eligible once its trigger rule
 * holds, and the cascade settles it as a resolution error.
 *
 * Each LEAF is evaluated on its own: `evaluateWhen` stops at the first false leaf, so a clause
 * like `['a.x == 1', 42]` would pass this check on a record where `a.x` is not 1 and throw on the
 * record the delta produces.
 *
 * Returns the definition itself (same object) when nothing throws.
 */
function totalGuardDefinition(
  definition: WorkflowDefinition,
  run: RunRecord,
): TotalGuardDefinition {
  const whenFailures = new Map<string, { thrown: string; declared: unknown }>();
  let evidenceByStep: ReturnType<typeof buildEvidenceByStep> | undefined;
  for (const [name, step] of Object.entries(definition.steps)) {
    if (step.execution !== 'guard' || step.when === undefined) continue;
    evidenceByStep ??= buildEvidenceByStep(run);
    const leaves: readonly string[] = Array.isArray(step.when) ? step.when : [step.when];
    for (const leaf of leaves) {
      try {
        evaluateWhenCondition(leaf, evidenceByStep, run.params);
      } catch (err) {
        whenFailures.set(name, {
          thrown: err instanceof Error ? err.message : String(err),
          declared: step.when,
        });
        break;
      }
    }
  }
  if (whenFailures.size === 0) return { definition, whenFailures };
  const steps: WorkflowDefinition['steps'] = {};
  for (const [name, step] of Object.entries(definition.steps)) {
    if (whenFailures.has(name)) {
      const { when: _unevaluable, ...withoutWhen } = step;
      steps[name] = withoutWhen;
    } else {
      steps[name] = step;
    }
  }
  return { definition: { ...definition, steps }, whenFailures };
}

/**
 * The resolution-error delta for a guard that could not be evaluated at all (issue #625): its
 * `when` or its `abort_unless` threw. `cause` is the whole diagnostic — the seal sentence and the
 * evidence entry's `error` both carry it, and neither says "unresolvable path" (no path failed to
 * resolve; the expression itself could not be read).
 */
function unevaluableGuardDelta(
  stepName: string,
  key: 'when' | 'abort_unless',
  declared: unknown,
  thrown: string,
  now: Date,
  evaluatedAtVersion: number,
): SettleGuardDelta {
  const cause = `its '${key}' could not be evaluated: ${thrown}`;
  const rendered = renderDeclared(declared);
  return {
    kind: 'settle_guard',
    step: stepName,
    outcome: 'resolution_error',
    evidence: captureEvidence({
      stepId: stepName,
      startedAt: now,
      completedAt: now,
      input: {},
      output: { error: cause },
      error: cause,
    }),
    resolutionError: { condition: `${key}: ${rendered}`, unresolvable_path: rendered, cause },
    evaluatedAtVersion,
  };
}

/** A declared `when` / `abort_unless` value as text, for a record field. Never throws. */
function renderDeclared(declared: unknown): string {
  try {
    return JSON.stringify(declared) ?? String(declared);
  } catch {
    return String(declared);
  }
}

/**
 * issue #625: after an applied delta, settle every guard that delta made eligible — in THIS apply,
 * so the store persists the delta and its guards in one write. Each guard goes through the shipped
 * `applySettleGuard` arm (evidence entry, skip propagation, and on a run-ending outcome the seal
 * and the finalizer mint); a guard writes no `settled` entry.
 *
 * Bounded by the number of guard steps: one guard settles per pass and a settled guard is never
 * eligible again.
 *
 * Never throws. A guard that cannot be evaluated is settled as a resolution error; if the arm
 * refuses a guard this loop itself found eligible, or anything else goes wrong, the loop stops and
 * what was applied so far stands.
 */
function settleEligibleGuards(
  base: Extract<SettlementResult, { applied: true }>,
  total: TotalGuardDefinition,
  now: Date,
  evaluatedAtVersion: number,
): SettlementResult {
  const { definition, whenFailures } = total;
  const bound = Object.values(definition.steps).filter((s) => s.execution === 'guard').length;
  let run = base.run;
  let transitioned = base.transitioned;
  const guards: Array<{ step: string; outcome: SettleGuardDelta['outcome'] }> = [];
  for (let settledCount = 0; settledCount < bound; settledCount++) {
    let guardDelta: SettleGuardDelta;
    let guardResult: SettlementResult;
    try {
      // Self-filters a terminal run and an open gate ("the gate wins").
      const eligible = findEligibleGuardSteps(definition, run);
      if (eligible.length === 0) break;
      const stepName = eligible[0]!;
      const whenFailure = whenFailures.get(stepName);
      if (whenFailure !== undefined) {
        guardDelta = unevaluableGuardDelta(
          stepName,
          'when',
          whenFailure.declared,
          whenFailure.thrown,
          now,
          evaluatedAtVersion,
        );
      } else {
        try {
          guardDelta = buildGuardDelta(stepName, definition, run, now, evaluatedAtVersion);
        } catch (err) {
          guardDelta = unevaluableGuardDelta(
            stepName,
            'abort_unless',
            definition.steps[stepName]!.abort_unless,
            err instanceof Error ? err.message : String(err),
            now,
            evaluatedAtVersion,
          );
        }
      }
      guardResult = applySettleGuard(run, guardDelta, definition);
    } catch {
      break;
    }
    // The arm refused a guard this loop found eligible: stop; what was applied so far stands.
    if (!guardResult.applied) break;
    guards.push({ step: guardDelta.step, outcome: guardDelta.outcome });
    run = guardResult.run;
    transitioned = transitioned || guardResult.transitioned;
  }
  if (guards.length === 0) return base;
  // issue #625: spread the base so what the base result carried (the answer's `gateClaim`) is not
  // dropped by the rebuild — a guard after a gate is exactly this PR's own case.
  return {
    ...base,
    run,
    transitioned,
    pendingFinalizers: pendingFinalizerNames(run.finalizer_ledger),
    guards,
  };
}

function applyDelta(
  fresh: RunRecord,
  delta: SettlementDelta,
  definition: WorkflowDefinition,
  now: Date,
  storeKeepsClaims: boolean,
): SettlementResult {
  switch (delta.kind) {
    case 'settle_step':
      return applySettleStep(fresh, delta, definition, now);
    case 'lease_finalizer':
      return applyLeaseFinalizer(fresh, delta, now);
    case 'mark_finalizer':
      return applyMarkFinalizer(fresh, delta);
    case 'open_gate':
      return applyOpenGate(fresh, delta);
    case 'settle_gate':
      return applySettleGate(fresh, delta, definition, now, storeKeepsClaims);
    case 'settle_guard':
      return applySettleGuard(fresh, delta, definition);
    case 'release_step':
      return applyReleaseStep(fresh, delta, now);
    case 'expire_gate':
      return applyExpireGate(fresh, delta, definition, now);
  }
}

/**
 * Named constant (issue #279, increment 2, PR-C; design record §4.3) tying reclaim-step.ts's own
 * open-gate refusal (`reclaimStep`, ~line 389: "the claim is legitimately pinned by a human gate")
 * to this design's "unfenced-release soundness rests on reclaim" premise. **Reworded (issue #291,
 * [F6]):** the ORIGINAL text claimed `applyAbortEdge`'s cancel-gate write was "the ONLY path that
 * may release an open gate's claim" — issue #291's `applyExpireGate` (both dispositions) ALSO
 * releases it now, making that literal claim false. The invariant this constant actually protects
 * — `reclaimStep`/`isAutoReclaimable` must NEVER release an open gate's claim, or a concurrent
 * release could race and double-release the same claim — still holds exactly; the closed set of
 * paths that MAY release it is now: `settle_step` abort's cancel-gate write (another step's
 * handler-abort), and `expire_gate`'s settle_default/abort dispositions (the gate's OWN step,
 * enforce-clock-driven) — all three live inside `applySettlement`, under the SAME store lock,
 * which is exactly WHY they can never race `reclaimStep`'s own (separate) CAS write. Referenced
 * (not asserted via) by this invariant's two existing pinning tests (`reclaim-step.test.ts` +
 * the CLI's `reclaim.test.ts`) so a future reader can grep this name to find both, and
 * reclaim-step.ts's own SOURCE stays untouched by this PR.
 */
export const RECLAIM_REFUSES_GATE_STEP =
  'reclaim never releases the open-gate claim (design record design-d5-increment2.md §4.3 + ' +
  'issue #291 design-d2.md [F6], unfenced-release soundness — the closed set: settle_step abort ' +
  "(another step), expire_gate settle_default/abort (the gate's own step), all inside " +
  'applySettlement under the same lock)';
