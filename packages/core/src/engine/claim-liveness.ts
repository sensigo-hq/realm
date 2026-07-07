// claim-liveness.ts — per-claim liveness clock + 3-state wedge detection (issue #101, Phase 1).
//
// A step pinned in `in_progress_steps` after its runner died (the "after-claim wedge") is
// otherwise invisible and unrecoverable. `claimStep` stamps a per-claim `deadline` (see
// `computeClaimDeadline`); detection classifies each in-progress claim into one of three states
// WITHOUT needing the workflow definition (it reads the stored deadline). Recovery is a
// deliberate per-step act (`reclaimStep` / `realm run reclaim`), never a background sweep.
import type { RunRecord, ClaimRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

// --- Deadline constants (Phase 1: the deadline drives the DETECTION DISPLAY only; it gates no
// action, so a too-large horizon merely delays a `claim_stale` label — bias LARGE). There is no
// pre-existing default-step-timeout constant in the codebase to reuse (verified: withTimeout only
// applies an explicit `timeout_seconds`; DRAIN_CEILING_SECONDS is finalizer-drain-specific).

/** Assumed handler wall-clock bound when a step declares no `timeout_seconds`. Biased large. */
export const DEFAULT_STEP_TIMEOUT_SECONDS = 300; // 5 min
/** Added to a step's `timeout_seconds` to absorb scheduling / clock skew before a claim is stale. */
export const RECLAIM_MARGIN_SECONDS = 60; // 1 min
/**
 * Minimum staleness horizon. A concrete claim is never `claim_stale` sooner than this, even for a
 * fast handler — so a live-but-slow runner is not mislabeled. Biased large: too-large only delays
 * the label (Phase 1 gates no action); too-small risks flagging live work. (Concrete deadlines are
 * set ONLY for finalizer-free auto steps, so the worst-case finalizer-drain span never applies to a
 * deadline-carrying claim — finalizer-bearing steps get `deadline: null` → `claim_unknown_age`.)
 */
export const RECLAIM_FLOOR_SECONDS = 900; // 15 min

/**
 * Computes the claim deadline for `stepName` at claim time. A CONCRETE deadline is returned ONLY
 * for a reliably time-boundable claim: an `execution: 'auto'` (handler-driven) step in a workflow
 * with NO `execution: 'finalizer'` steps (so no finalizer drain can legitimately extend the claim
 * past the seal). Every other claim returns `null` (→ `claim_unknown_age`): agent steps have no
 * reliable wall-clock bound (the dispatcher returns instantly; `timeout_seconds` is advisory), and
 * any step in a finalizer-bearing workflow may hold its claim through the terminal drain.
 */
export function computeClaimDeadline(
  definition: WorkflowDefinition,
  stepName: string,
  now: Date,
): string | null {
  const step = definition.steps[stepName];
  if (step === undefined) return null;
  const hasFinalizers = Object.values(definition.steps).some((s) => s.execution === 'finalizer');
  if (step.execution !== 'auto' || hasFinalizers) return null;
  const horizonSeconds = Math.max(
    RECLAIM_FLOOR_SECONDS,
    (step.timeout_seconds ?? DEFAULT_STEP_TIMEOUT_SECONDS) + RECLAIM_MARGIN_SECONDS,
  );
  return new Date(now.getTime() + horizonSeconds * 1000).toISOString();
}

/**
 * Returns a NEW claims record with `stepName` removed (a fresh object — never mutates the input,
 * so it is safe to use on a value spread from the prior record). Used at the settle/seal sites to
 * delete the claim clock in the SAME record mutation that removes the step from
 * `in_progress_steps`. Returns `{}` when the last claim is removed (harmless; detection ignores a
 * run with no in-progress steps). A missed delete self-heals: `claimStep` overwrites `claims[S]`.
 */
export function omitClaim(
  claims: Record<string, ClaimRecord> | undefined,
  stepName: string,
): Record<string, ClaimRecord> {
  if (claims === undefined) return {};
  const { [stepName]: _removed, ...rest } = claims;
  return rest;
}

/**
 * The 3-state liveness classification of a single in-progress claim (issue #101):
 * - `healthy` — a concrete deadline that has not yet passed (a live runner is presumed on it).
 * - `claim_stale` — a concrete deadline that has passed (the runner is presumed dead).
 * - `claim_unknown_age` — no claim record, or a `null` deadline (agent / finalizer-bearing /
 *   legacy run). Detect-only, human-judged, NEVER auto-reclaimed.
 */
export type ClaimState = 'healthy' | 'claim_stale' | 'claim_unknown_age';

/** Classifies a single claim record against `now`. Definition-free (reads only the stored deadline). */
export function classifyClaim(claim: ClaimRecord | undefined, now: Date): ClaimState {
  if (claim === undefined || claim.deadline === null) return 'claim_unknown_age';
  return now.getTime() > new Date(claim.deadline).getTime() ? 'claim_stale' : 'healthy';
}

/** A classified in-progress claim: the step, its liveness state, and its stored deadline. */
export interface InProgressClaimInfo {
  step: string;
  state: ClaimState;
  deadline: string | null;
}

/**
 * Classifies every in-progress claim on a run. Definition-free — works even when the workflow
 * definition is unresolved (detection reads the stored per-claim deadline, not the definition).
 */
export function classifyInProgressClaims(
  run: RunRecord,
  now: Date = new Date(),
): InProgressClaimInfo[] {
  return run.in_progress_steps.map((step) => {
    const claim = run.claims?.[step];
    return { step, state: classifyClaim(claim, now), deadline: claim?.deadline ?? null };
  });
}
