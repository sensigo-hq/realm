// reclaimStep — deliberate per-claim recovery of an after-claim wedge (issue #101, Phase 1).
//
// Sibling of abandon-run.ts: a version-CAS mutation via store.get/store.update (NOT a new RunStore
// CRUD method). It moves a stale / unknown-age / force-overridden claim out of `in_progress_steps`
// so the step returns to eligible (findEligibleSteps re-includes it) and the next driver re-drives
// it. This is AT-LEAST-ONCE (the re-driven step's side effects may repeat) — the deliberate
// per-step act (`realm run reclaim <step> --force`) + a loud warning is the safety gate; the
// handler author owns idempotency. reclaim is PER-CLAIM (unlike abandon, which is per-run): a dead
// non-gated sibling on a gate_waiting run is reclaimable.
import type { RunStore } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { TraceBufferStore } from '../store/trace-buffer-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import { captureEvidence } from '../evidence/snapshot.js';
import { classifyClaim, omitClaim, type ClaimState } from './claim-liveness.js';

export type ReclaimOutcome =
  /** The claim was moved out of `in_progress_steps` this call → the step is eligible again. */
  | 'reclaimed'
  /** The step already left `in_progress_steps` (settled, or reclaimed elsewhere) → idempotent no-op. */
  | 'already_settled'
  /** A live driver re-claimed the step FRESH under a CAS race (now healthy) → not stomped (Sig-6). */
  | 'taken_over';

export interface ReclaimResult {
  run: RunRecord;
  step: string;
  outcome: ReclaimOutcome;
  /** The claim state observed at the initial read (for the caller's warning/audit output). */
  priorState: ClaimState;
  priorDeadline: string | null;
}

export interface ReclaimStepOptions {
  /**
   * Trace-buffer WAL store. The stale `(runId, stepName)` buffer is cleared best-effort so a
   * re-drive does not fold duplicated pre-crash trace spans. Optional: the only in-repo buffer is
   * in-memory (it dies with a crashed process, so nothing persists cross-process); clearing is
   * meaningful in-process and for any future file-backed WAL.
   */
  traceBufferStore?: TraceBufferStore;
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

/** Pure mutation: remove the claim from in_progress + claims and append a reclaim audit entry.
 *  The step is NOT added to completed/failed/skipped (it returns to eligible); terminal marks,
 *  aborted_at, and pending_gate are untouched. */
function applyReclaim(run: RunRecord, stepName: string, now: Date): RunRecord {
  const priorClaim = run.claims?.[stepName];
  const auditEvidence = captureEvidence({
    stepId: stepName,
    startedAt: now,
    completedAt: now,
    input: {},
    output: {
      reclaimed: true,
      reason: 'manual reclaim',
      prior_state: classifyClaim(priorClaim, now),
      prior_deadline: priorClaim?.deadline ?? null,
      reclaimed_at: now.toISOString(),
    },
  });
  return {
    ...run,
    in_progress_steps: run.in_progress_steps.filter((s) => s !== stepName),
    claims: omitClaim(run.claims, stepName),
    evidence: [...run.evidence, auditEvidence],
  };
}

/**
 * Clears the reclaimed step's stale trace buffer (issue #198). This is correct, not merely
 * tidy: reclaim IS the recovery boundary for a dead claim — the buffer being cleared here was
 * never adopted into any settled evidence (the claim wedged before `execute_step` ever reached
 * its post-claim adoption read — see #185's execution-loop.ts), so nothing is being discarded
 * that any consumer has seen or could ever see. #185 already discards a losing attempt's WAL
 * lines at the WINNER's settlement time (whoever claims the step next adopts them, then they're
 * unlinked); #198 simply does the same discard EARLIER — at the moment the dead attempt is
 * declared dead, rather than leaving it on disk for the next attempt to silently adopt and then
 * have to caveat as "may include a prior writer" (`buffered_lines_adopted`). No SETTLED evidence
 * is ever touched by this function — only pre-claim, never-adopted buffer content.
 *
 * Best-effort and non-blocking by design: a failed clear must never fail the reclaim itself (the
 * claim recovery is the important, safety-gated act; WAL hygiene is secondary) — but per the
 * #183 contract (a real I/O failure must be loud, never silently swallowed), a genuine delete
 * failure now warns instead of vanishing into an empty catch.
 */
async function clearStaleWal(
  traceBufferStore: TraceBufferStore | undefined,
  runId: string,
  stepName: string,
): Promise<void> {
  if (traceBufferStore === undefined) return;
  try {
    await traceBufferStore.delete(runId, stepName);
  } catch (err) {
    console.warn(
      `⚠ realm: failed to clear stale trace buffer for run '${runId}' step '${stepName}' during ` +
        `reclaim (${err instanceof Error ? err.message : String(err)}) — the reclaim itself ` +
        `still succeeded; the next attempt may adopt this buffer's lines.`,
    );
  }
}

/**
 * Reclaims a single in-progress claim on a run. Guards (in order): store capability → terminal
 * run → the open-gate step → membership. Returns idempotent success when the step is already
 * settled. On a CAS mismatch it RE-EVALUATES the predicate (never a blind abandon-style re-remove).
 */
export async function reclaimStep(
  store: RunStore,
  runId: string,
  stepName: string,
  options?: ReclaimStepOptions,
): Promise<ReclaimResult> {
  const now = options?.now ?? new Date();

  // Guard — store capability: a store that drops `claims` cannot detect or recover a wedge.
  if (!store.persistsClaims) {
    throw new WorkflowError(
      `Store does not persist claims; liveness recovery is unavailable on this store.`,
      {
        code: 'STATE_TRANSITION_DENIED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId, stepName },
      },
    );
  }

  const run = await store.get(runId);

  // Guard — terminal: a wedge is non-terminal (a terminal+claimed guard-abort record is left alone).
  if (run.terminal_state) {
    throw new WorkflowError(
      `Run '${runId}' is terminal (${run.run_phase}); a terminal run has no reclaimable claim.`,
      {
        code: 'STATE_RUN_TERMINAL',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId, stepName, run_phase: run.run_phase },
      },
    );
  }

  // Guard — the OPEN-GATE step only (per-claim, not per-run): its claim is legitimately pinned by a
  // human gate; reclaiming it would re-drive a step awaiting a decision. A dead NON-gated sibling on
  // a gate_waiting run is still reclaimable (findEligibleSteps returns [] under a gate, so the
  // re-eligible step waits inertly until the gate resolves).
  if (run.pending_gate?.step_name === stepName) {
    throw new WorkflowError(
      `Step '${stepName}' is the open gate on run '${runId}'; resolve or reject the gate via ` +
        `submit_human_response instead of reclaiming it.`,
      {
        code: 'STATE_TRANSITION_DENIED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId, stepName },
      },
    );
  }

  const priorClaim = run.claims?.[stepName];
  const priorState = classifyClaim(priorClaim, now);
  const priorDeadline = priorClaim?.deadline ?? null;

  // Guard — membership: not in_progress → already settled/reclaimed → idempotent success.
  if (!run.in_progress_steps.includes(stepName)) {
    return { run, step: stepName, outcome: 'already_settled', priorState, priorDeadline };
  }

  try {
    const updated = await store.update(applyReclaim(run, stepName, now));
    await clearStaleWal(options?.traceBufferStore, runId, stepName);
    return { run: updated, step: stepName, outcome: 'reclaimed', priorState, priorDeadline };
  } catch (err) {
    if (!(err instanceof WorkflowError) || err.code !== 'STATE_SNAPSHOT_MISMATCH') throw err;

    // CAS mismatch — the run changed under us. Unlike abandon (whose `abandoned_at` key is
    // permanent), reclaim's condition can FLIP BACK: a reclaimed step can be re-claimed FRESH by a
    // live driver. A blind abandon-style re-remove would double-remove that live claim and
    // double-drive live work (reviewer Sig-6). So RE-EVALUATE the predicate on the reloaded record.
    const reloaded = await store.get(runId);

    if (!reloaded.in_progress_steps.includes(stepName)) {
      // A live driver settled it, or another reclaim already removed it → idempotent, no re-remove.
      return {
        run: reloaded,
        step: stepName,
        outcome: 'already_settled',
        priorState,
        priorDeadline,
      };
    }
    if (classifyClaim(reloaded.claims?.[stepName], now) === 'healthy') {
      // Re-claimed FRESH (a future deadline) → a live driver took over. Never stomp live work.
      return { run: reloaded, step: stepName, outcome: 'taken_over', priorState, priorDeadline };
    }
    // Still a stale / unknown-age wedge after the concurrent write → re-apply ONCE on the fresh
    // record. A second mismatch propagates (reclaim loses, abandon-style — no retry loop).
    const updated = await store.update(applyReclaim(reloaded, stepName, now));
    await clearStaleWal(options?.traceBufferStore, runId, stepName);
    return { run: updated, step: stepName, outcome: 'reclaimed', priorState, priorDeadline };
  }
}
