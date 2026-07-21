// run-health.ts — typed run-health classification with honest per-surface reporting (issue #221).
//
// classifyRunHealth is the SINGLE shared predicate the three READ surfaces — get_run_state,
// `realm run list --stuck`, and `realm run inspect` — derive from, so none of them can silently
// drift from another about what "wedged" or "idle" means (the issue's own AC-4: "all... surfaces
// derive from ONE shared predicate — no drift"). Pure, read-only, definition-optional,
// `now`-injectable (deterministic tests, no fake timers, no real sleeps).
//
// `realm run reclaim` is NOT a fourth consumer of this function (record §2, fold B2) — it answers
// a different question (settled vs. no-active-claim on an already-touched step, not health
// findings on an in-progress/parked run) via its own independent discriminator,
// `classifyNoActiveClaim` in reclaim-step.ts, which reads the same underlying record facts
// (settle-set membership, capability_blocks, reclaim-audit evidence) without calling this
// function at all.
//
// Branch-conditioning table (design record §1, fold B1 — the detectors are CALL-SITE-conditioned,
// not internal to any one detector):
//   1. `run.terminal_state === true` ⇒ [] — unconditional FIRST guard. A terminal run (including a
//      terminal+claimed guard-abort record — a claim can still be `in_progress_steps` at the
//      instant a guard aborts the run) has nothing further to report.
//   2. Claim findings: `classifyInProgressClaims(run, now)` entries with `state !== 'healthy' &&
//      step !== run.pending_gate?.step_name`. The open-gate claim is always `{deadline: null}` ⇒
//      `claim_unknown_age` — excluding it is what keeps a healthy gate_waiting run at ZERO
//      findings (the B1 negative pin); without the exclusion EVERY healthy gated run would flag.
//      `kind` is keyed by PHASE, not by the claim's own state: `run_phase === 'gate_waiting'` ⇒
//      `wedged_gate_sibling`, else `stale_claim` — so a `claim_unknown_age` claim on a `running`
//      run still gets `kind: 'stale_claim'` per this table (the more precise distinction survives
//      in `reason`, which mirrors the claim's own state string verbatim — single-sourced, never
//      reinvented). Subsumes list.ts's pre-#221 `wedgedNonGatedClaims` (deleted there; see the
//      source-text negative pin in list.test.ts).
//   3. Capability findings: `findCapabilityBlockedSteps(run)` ⇒ `capability_block`. That function's
//      own eligibility cross-check already self-suppresses a stale marker whose step has since
//      settled, so no extra suppression is needed here.
//   4. `never_claimed_idle` (the #221 class): `run_phase === 'running' && in_progress_steps.length
//      === 0 && (now − updated_at) >= idleThresholdMs`. Age-gated by DEFAULT_IDLE_THRESHOLD_MS
//      (24h, engine-minted per the K8s/Prometheus convention that detection never REQUIRES an
//      operator-supplied threshold) unless the caller overrides. `since`, `idle_ms`, and
//      `evidence.idle_threshold_ms` are REQUIRED on this finding (pinned by the boundary +
//      invariant tests) — the threshold rides the finding's own evidence so a reader never has to
//      go find it elsewhere. `opts.definition`, when supplied, additionally adds
//      `evidence.eligible_steps` (Temporal's list-cheap/describe-rich split); a definition-free
//      caller still classifies correctly on age alone.
//
// Honest-admission rule (Celery-corrected, record §1): `never_claimed_idle`'s reason text NEVER
// claims rejection — "parked with no claimed step, idle", never "rejected" or "stuck". Rescoped
// (issue #220): the two COUNTED validation-rejection codes (VALIDATION_INPUT_SCHEMA/
// VALIDATION_OUTPUT_SCHEMA) are now record-carried since #220 (`RunRecord.validation_rejections`)
// — but this function still does not render that count; surfacing it is #219's future enrichment
// slot, not this one's. A TRACE-rejection count (VALIDATION_TRACE_SCHEMA, uncounted v1 — see
// execution-loop.ts's countRejection doc) still requires sidecar evidence this function
// structurally cannot see (classification here is write-free by construction).
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { classifyInProgressClaims } from './claim-liveness.js';
import { findCapabilityBlockedSteps } from './capability.js';
import { findEligibleSteps } from './eligibility.js';

/**
 * Default age threshold for the `never_claimed_idle` finding (issue #221) — 24 hours. Engine-
 * minted so detection never REQUIRES an operator-supplied threshold; callers (surfaces) may
 * override via `opts.idleThresholdMs`. This constant is THE resolution point for every surface —
 * only `realm run list --stuck` exposes an observer override (`--older-than`); get_run_state and
 * inspect take no override by design (agents don't tune detectors).
 */
export const DEFAULT_IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * A single, typed run-health observation (issue #221) — the shared vocabulary every surface
 * renders from.
 */
export interface RunHealthFinding {
  kind: 'never_claimed_idle' | 'stale_claim' | 'wedged_gate_sibling' | 'capability_block';
  /** The affected step, when the finding is step-scoped. Absent for `never_claimed_idle` — a
   *  run-level observation (no step is claimed at all). */
  step?: string;
  /** Programmatic-identifier style, stable, single-sourced from the underlying detector (e.g. the
   *  claim's own liveness state, or the capability block's own error code) — never a freshly
   *  invented sentence per finding. */
  reason: string;
  /** Age anchor (ISO timestamp) — the reader computes human-readable age from this; it is never
   *  pre-formatted here. `updated_at` for `never_claimed_idle`; the capability block's own `at`
   *  for `capability_block`. Absent for claim findings (no reliable claim-start timestamp is
   *  tracked anywhere in the run record — only a deadline, which is carried in `evidence`
   *  instead). REQUIRED for kind `never_claimed_idle`. */
  since?: string;
  /** Milliseconds idle, computed from `opts.now`. REQUIRED (together with `since`) for kind
   *  `never_claimed_idle`; absent otherwise. */
  idle_ms?: number;
  /** Kind-specific supporting data — label-sufficient for every surface to render without
   *  reaching back into the run record: claim findings carry `{state, deadline}`; capability
   *  findings carry `{requirement, code}`; `never_claimed_idle` carries `{idle_threshold_ms}` and,
   *  when `opts.definition` was supplied, `{eligible_steps}`. */
  evidence?: Record<string, unknown>;
}

/**
 * Classifies a run's health into zero or more typed findings. Pure, read-only, definition-
 * optional, `now`-injectable. See the module doc above for the full branch-conditioning table
 * (design record §1, fold B1) and the honest-admission rule.
 */
export function classifyRunHealth(
  run: RunRecord,
  opts?: { now?: Date; idleThresholdMs?: number; definition?: WorkflowDefinition },
): RunHealthFinding[] {
  // Branch 1 — unconditional first guard (record §1, B1).
  if (run.terminal_state) return [];

  const now = opts?.now ?? new Date();
  const idleThresholdMs = opts?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const findings: RunHealthFinding[] = [];

  // Branch 2 — claim findings (subsumes list.ts's pre-#221 wedgedNonGatedClaims).
  for (const c of classifyInProgressClaims(run, now)) {
    if (c.state === 'healthy') continue;
    if (c.step === run.pending_gate?.step_name) continue; // the open-gate claim is never a wedge
    findings.push({
      kind: run.run_phase === 'gate_waiting' ? 'wedged_gate_sibling' : 'stale_claim',
      step: c.step,
      reason: c.state,
      evidence: { state: c.state, deadline: c.deadline },
    });
  }

  // Branch 3 — capability findings (findCapabilityBlockedSteps already self-suppresses a stale
  // marker whose step has since settled, via its own eligibility cross-check).
  for (const b of findCapabilityBlockedSteps(run)) {
    findings.push({
      kind: 'capability_block',
      step: b.step,
      reason: b.code,
      since: b.at,
      evidence: { requirement: b.requirement, code: b.code },
    });
  }

  // Branch 4 — never_claimed_idle (the #221 class). since/idle_ms/evidence.idle_threshold_ms are
  // REQUIRED on this finding.
  if (
    run.run_phase === 'running' &&
    run.in_progress_steps.length === 0 &&
    now.getTime() - new Date(run.updated_at).getTime() >= idleThresholdMs
  ) {
    findings.push({
      kind: 'never_claimed_idle',
      reason: 'parked with no claimed step, idle',
      since: run.updated_at,
      idle_ms: now.getTime() - new Date(run.updated_at).getTime(),
      evidence: {
        idle_threshold_ms: idleThresholdMs,
        ...(opts?.definition !== undefined
          ? { eligible_steps: findEligibleSteps(opts.definition, run) }
          : {}),
      },
    });
  }

  return findings;
}
