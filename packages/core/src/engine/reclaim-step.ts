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
 * Clears the reclaimed step's stale trace buffer — the NON-declaring-store fallback (issue #198;
 * superseded by `clearStaleWalFenced` below for any store declaring the fenced trio, issue #207
 * PR-2). Order and behavior here are BYTE-FROZEN (called only after the un-claiming update,
 * best-effort, warned-on-failure) — this is the normative fallback D3 §5 requires for a store
 * that cannot fence the clear at all.
 *
 * Honest disposition (issue #207 PR-2 — this doc previously overclaimed a stronger guarantee than
 * is actually true). It used to read: "nothing is being discarded that any consumer has seen or
 * could ever see" — that is FALSE as of #207 PR-2's persist-gated failure-settle delete
 * (execution-loop.ts: the WAL delete there now only fires once `store.update` has already
 * SUCCEEDED). When that persist instead FAILS, the step is left in_progress with its trace
 * ALREADY READ INTO an evidence write that never landed anywhere durable — reclaim is exactly the
 * recovery path for that wedge, and this clear (fenced or not) destroys that adopted-but-
 * unpersisted content too, same as it always destroyed pre-claim, never-adopted content. This is
 * a DELIBERATE, WARNED policy (the #198 delta: reclaim always warns with the count it destroys),
 * not a silent loss, and it is bounded: the destroyed content was never durable anywhere a future
 * reader could find it (the failed `store.update` never committed), so this never destroys any
 * consumer's already-durable view — only a write attempt that never took effect. Full
 * preservation (a sidecar copy taken before this destructive clear) is #197's filed follow-up,
 * not this function's job.
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

/** Internal control-flow signal (issue #207 PR-2): thrown by `clearStaleWalFenced`'s own guard
 *  when the run's version no longer matches the version captured at reclaim's decision read —
 *  caught ONLY inside `clearStaleWalFenced`, immediately below; never propagates past this file.
 *  A plain `Error` (deliberately NOT a `WorkflowError`) so no store's own error-classification
 *  logic (e.g. a fenced fs store's `instanceof FsIoError` wrap-scoping) could ever mistake it for
 *  something else — it exists purely as a private signal between the guard and its caller. */
class ReclaimVersionChanged extends Error {}

/** Outcome of `clearStaleWalFenced` (issue #207 PR-2) — what `reclaimStep` needs to decide what
 *  to log; never surfaced to reclaim's own caller beyond the console.warn it drives. */
interface FencedClearResult {
  /** `true` iff the version fence refused (the clear was skipped, buffer left intact). */
  skipped: boolean;
  /** Entries actually cleared — meaningful only when `skipped` is `false`. */
  count: number;
}

/**
 * Fenced pre-update clear (issue #207 PR-2, D3 §5): clears the reclaimed step's trace buffer
 * BEFORE the un-claiming `store.update`, guarded by a run-VERSION fence re-verified inside the
 * SAME per-(runId, stepName) critical section `deleteFenced` uses. `expectedVersion` is the
 * version captured at THIS call's own reclaim-decision read (the primary path's `run` at :133 —
 * now above; the CAS-retry path's `reloaded` — never a fresh get taken here). Every `RunStore`
 * mutation (claimStep, settle, reclaim) bumps `version`, so ANY intervening write on this run is
 * detected — a concurrent claim/settle/reclaim of this exact step since the decision read means
 * reclaim's premise ("this is a dead, still-in-progress claim") may no longer hold, and the guard
 * refuses rather than risk destroying content a live/newer actor already adopted or is
 * mid-adopting.
 *
 * A separate `step ∈ in_progress_steps` re-check is deliberately NOT added: since ANY store
 * mutation bumps version, an unchanged version already implies a byte-identical record — the
 * membership fact cannot have changed without the version changing too. D3 §5 states this
 * explicitly: every agent `ClaimRecord` is `{deadline: null}`, so record identity/classification
 * cannot discriminate further — the version fence alone is the whole guard.
 *
 * Returns `{skipped: true}` when the guard refused (the caller must skip-and-warn, never treat
 * this as an error). Any OTHER thrown error (lock contention, genuine I/O failure) propagates to
 * the caller UNCHANGED and must abort the reclaim entirely, BEFORE the un-claiming update — the
 * decision table is total (guard-pass ⇒ drain-with-warned-count; guard-refusal ⇒ skip+warn;
 * genuine throw ⇒ propagate, claim intact, retryable).
 */
async function clearStaleWalFenced(
  store: RunStore,
  traceBufferStore: TraceBufferStore,
  runId: string,
  stepName: string,
  expectedVersion: number,
): Promise<FencedClearResult> {
  const guard = async (): Promise<void> => {
    // Fresh lock-free read — never the record already in hand (`run`/`reloaded`), which is
    // exactly what this guard exists to re-verify against.
    const fresh = await store.get(runId);
    if (fresh.version !== expectedVersion) {
      throw new ReclaimVersionChanged(
        `reclaim's version fence refused: run '${runId}' changed since the reclaim decision ` +
          `(expected version ${expectedVersion}, observed ${fresh.version})`,
      );
    }
  };
  try {
    const count = await traceBufferStore.deleteFenced!(runId, stepName, guard);
    return { skipped: false, count };
  } catch (err) {
    if (err instanceof ReclaimVersionChanged) {
      return { skipped: true, count: 0 };
    }
    throw err;
  }
}

/** Logs the fenced clear's decision-table outcome (issue #207 PR-2) — the sole place this
 *  console.warn is emitted, called from both reclaimStep call sites. */
function warnFencedClearOutcome(runId: string, stepName: string, result: FencedClearResult): void {
  if (result.skipped) {
    console.warn(
      `⚠ realm: skipped clearing the trace buffer for run '${runId}' step '${stepName}' during ` +
        'reclaim — the run changed since the reclaim decision (version fence refused); the ' +
        'buffer is left intact.',
    );
  } else if (result.count > 0) {
    console.warn(
      `reclaim cleared ${result.count} buffered trace entries for run '${runId}' step '${stepName}'.`,
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

  // issue #207 PR-2: a declaring store's clear moves BEFORE the un-claiming update, version-fenced
  // against the decision read's own version (`run.version`, just above) — a non-declaring store
  // falls back to the byte-frozen legacy order (after the update, best-effort). `fenced` decides
  // which branch each call site below takes; a `deleteFenced`/lock/I-O throw from the fenced path
  // propagates BEFORE any update runs (claim intact, reclaim aborts loudly, retryable).
  const traceBufferStore = options?.traceBufferStore;
  const fenced =
    traceBufferStore !== undefined && typeof traceBufferStore.deleteFenced === 'function';

  try {
    if (fenced) {
      const clearResult = await clearStaleWalFenced(
        store,
        traceBufferStore,
        runId,
        stepName,
        run.version,
      );
      warnFencedClearOutcome(runId, stepName, clearResult);
    }
    const updated = await store.update(applyReclaim(run, stepName, now));
    if (!fenced) {
      await clearStaleWal(traceBufferStore, runId, stepName);
    }
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
    // issue #207 PR-2: same fenced-clear-before-update shape as the primary path above, but
    // version-fenced against THIS path's own decision read (`reloaded.version`) — never `run`'s.
    if (fenced) {
      const clearResult = await clearStaleWalFenced(
        store,
        traceBufferStore,
        runId,
        stepName,
        reloaded.version,
      );
      warnFencedClearOutcome(runId, stepName, clearResult);
    }
    const updated = await store.update(applyReclaim(reloaded, stepName, now));
    if (!fenced) {
      await clearStaleWal(traceBufferStore, runId, stepName);
    }
    return { run: updated, step: stepName, outcome: 'reclaimed', priorState, priorDeadline };
  }
}
