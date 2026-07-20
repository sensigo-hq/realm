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
import { storeDeclaresSeal } from '../store/trace-buffer-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import { captureEvidence } from '../evidence/snapshot.js';
import { classifyClaim, omitClaim, type ClaimState } from './claim-liveness.js';

export type ReclaimOutcome =
  /** The claim was moved out of `in_progress_steps` this call → the step is eligible again. */
  | 'reclaimed'
  /** The step is in completed/failed/skipped_steps → genuinely settled → idempotent no-op. */
  | 'already_settled'
  /** A live driver re-claimed the step FRESH under a CAS race (now healthy) → not stomped (Sig-6). */
  | 'taken_over'
  /**
   * issue #221, B2-corrected: no active claim on the step AND it is not in the settled set
   * (completed/failed/skipped). Replaces the pre-#221 conflation of this case with
   * `already_settled` — "never claimed" is provably FALSE in general (a previously-reclaimed step,
   * or a capability-blocked step, WAS touched), so this outcome asserts only the narrow, always-
   * true fact for this region: no active claim, not settled. See `detail` below for the two cases
   * where positive evidence narrows it further.
   */
  | 'no_active_claim';

export interface ReclaimResult {
  run: RunRecord;
  step: string;
  outcome: ReclaimOutcome;
  /**
   * issue #221: optional, evidence-EARNED refinement of `no_active_claim` — never inferred from
   * absence. `'previously_reclaimed'` when a reclaim-audit evidence entry for this step is found
   * (`applyReclaim`'s own marker: `output_summary.reclaimed === true`); `'capability_blocked'`
   * when `run.capability_blocks[step]` is present. Omitted when neither positive marker is found
   * (a genuinely never-claimed step). Never set for any outcome other than `no_active_claim`.
   */
  detail?: 'previously_reclaimed' | 'capability_blocked';
  /** The claim state observed at the initial read (for the caller's warning/audit output). */
  priorState: ClaimState;
  priorDeadline: string | null;
}

/**
 * issue #221, B2-corrected discriminator: distinguishes a genuinely-settled step from a step with
 * no active claim that was never provably settled — reused at BOTH membership sites (the direct
 * guard in `reclaimStep` below, and its CAS-retry re-evaluation). `detail` is earned ONLY from
 * positive evidence in `record`, never inferred from absence: a capability block takes precedence
 * over reclaim-audit evidence when (rare) both happen to be present, since it is the more
 * actionable, more-recent-in-time signal. Pure, read-only.
 */
function classifyNoActiveClaim(
  record: RunRecord,
  stepName: string,
): {
  outcome: 'already_settled' | 'no_active_claim';
  detail?: 'previously_reclaimed' | 'capability_blocked';
} {
  if (
    record.completed_steps.includes(stepName) ||
    record.failed_steps.includes(stepName) ||
    record.skipped_steps.includes(stepName)
  ) {
    return { outcome: 'already_settled' };
  }
  if (record.capability_blocks?.[stepName] !== undefined) {
    return { outcome: 'no_active_claim', detail: 'capability_blocked' };
  }
  const reclaimedBefore = record.evidence.some(
    (e) => e.step_id === stepName && e.output_summary?.['reclaimed'] === true,
  );
  if (reclaimedBefore) {
    return { outcome: 'no_active_claim', detail: 'previously_reclaimed' };
  }
  return { outcome: 'no_active_claim' };
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
 * is actually true; issue #197 PR-2 narrows the claim further, now that preservation has
 * shipped). It used to read: "nothing is being discarded that any consumer has seen or could ever
 * see" — that is FALSE as of #207 PR-2's persist-gated failure-settle delete (execution-loop.ts:
 * the WAL delete there now only fires once `store.update` has already SUCCEEDED). When that
 * persist instead FAILS, the step is left in_progress with its trace ALREADY READ INTO an
 * evidence write that never landed anywhere durable — reclaim is exactly the recovery path for
 * that wedge, and THIS function (the non-declaring-store / non-seal fallback ONLY, as of #197
 * PR-2 — see `sealStaleWalFenced` below for the seal-capable path) destroys that adopted-but-
 * unpersisted content too, same as it always destroyed pre-claim, never-adopted content. This is
 * a DELIBERATE, WARNED policy (the #198 delta: reclaim always warns with the count it destroys),
 * not a silent loss, and it is bounded: the destroyed content was never durable anywhere a future
 * reader could find it (the failed `store.update` never committed), so this never destroys any
 * consumer's already-durable view — only a write attempt that never took effect. Full
 * preservation (seal-by-rename, not a sidecar copy) SHIPPED in #197 PR-2: sealed on any
 * seal-declaring store — this function remains only the byte-frozen fallback for a store that
 * cannot seal at all.
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

/** Outcome of `sealStaleWalFenced` (issue #197 PR-2) — what `reclaimStep` needs to decide what to
 *  log; never surfaced to reclaim's own caller beyond the console.warn it drives. */
interface FencedSealResult {
  /** `true` iff the version fence refused (the seal attempt was skipped, buffer left intact). */
  skipped: boolean;
  /** `true` iff the buffer was actually sealed. */
  sealed: boolean;
  /** Set (to the destroyed entry count) iff the per-key seal budget was reached and this call
   *  fell back to the existing destructive drain (`deleteFenced`) instead. */
  cappedFallbackCount?: number;
}

/**
 * Fenced pre-update SEAL (issue #197 PR-2, deliverable 1g): reclaim ALWAYS preserves ALL of a
 * stale step's WAL (no partitioning — zero-cooperation preservation, design §3: "reclaim/settle
 * preservation ⇔ trio ∧ seal, no carriage needed") on any store declaring `seal`, via the exact
 * SAME version-fence guard `clearStaleWalFenced` uses above (re-verified against
 * `expectedVersion`, captured at THIS call's own reclaim-decision read — never a fresh get taken
 * here). `{sealed:false, reason:'capped'}` falls back to the existing destructive drain
 * (`deleteFenced`, reusing the SAME guard closure — a second, independent version-fence
 * re-verification, cheap and safe even if slightly redundant) rather than silently evicting an
 * already-sealed artifact to make room. `{sealed:false, reason:'absent'}` (no live WAL at all) is
 * a no-op — nothing to preserve or destroy. Any OTHER thrown error (lock contention, genuine I/O
 * failure) propagates UNCHANGED, exactly like `clearStaleWalFenced`'s own contract.
 */
async function sealStaleWalFenced(
  store: RunStore,
  traceBufferStore: TraceBufferStore,
  runId: string,
  stepName: string,
  expectedVersion: number,
): Promise<FencedSealResult> {
  const guard = async (): Promise<void> => {
    const fresh = await store.get(runId);
    if (fresh.version !== expectedVersion) {
      throw new ReclaimVersionChanged(
        `reclaim's version fence refused: run '${runId}' changed since the reclaim decision ` +
          `(expected version ${expectedVersion}, observed ${fresh.version})`,
      );
    }
  };
  try {
    const result = await traceBufferStore.sealFenced!(runId, stepName, guard);
    if (result.sealed) {
      return { skipped: false, sealed: true };
    }
    if (result.reason === 'capped') {
      const count = await traceBufferStore.deleteFenced!(runId, stepName, guard);
      return { skipped: false, sealed: false, cappedFallbackCount: count };
    }
    // reason === 'absent' — nothing to seal or drain.
    return { skipped: false, sealed: false };
  } catch (err) {
    if (err instanceof ReclaimVersionChanged) {
      return { skipped: true, sealed: false };
    }
    throw err;
  }
}

/** Logs the fenced seal's decision-table outcome (issue #197 PR-2) — the sole place this
 *  console.warn is emitted, called from both reclaimStep call sites. NO fabricated entry counts
 *  on a successful seal — the sealed artifact's contents are unparsed at reclaim time (design
 *  §7: "sealed, contents unparsed"); only the capped-fallback drain has an honest count to report,
 *  exactly as `warnFencedClearOutcome` already does for the non-seal path. */
function warnFencedSealOutcome(runId: string, stepName: string, result: FencedSealResult): void {
  if (result.skipped) {
    console.warn(
      `⚠ realm: skipped sealing the trace buffer for run '${runId}' step '${stepName}' during ` +
        'reclaim — the run changed since the reclaim decision (version fence refused); the ' +
        'buffer is left intact.',
    );
  } else if (result.sealed) {
    console.warn(
      `stale WAL sealed (contents unparsed) — retrievable via realm run export for run '${runId}' ` +
        `step '${stepName}'.`,
    );
  } else if (result.cappedFallbackCount !== undefined && result.cappedFallbackCount > 0) {
    console.warn(
      `reclaim cleared ${result.cappedFallbackCount} buffered trace entries for run '${runId}' ` +
        `step '${stepName}' (seal budget reached — fell back to the destructive drain).`,
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

  // Guard — membership: not in_progress → discriminate settled vs no-active-claim (issue #221, B2).
  if (!run.in_progress_steps.includes(stepName)) {
    const { outcome, detail } = classifyNoActiveClaim(run, stepName);
    return {
      run,
      step: stepName,
      outcome,
      ...(detail !== undefined ? { detail } : {}),
      priorState,
      priorDeadline,
    };
  }

  // issue #207 PR-2: a declaring store's clear moves BEFORE the un-claiming update, version-fenced
  // against the decision read's own version (`run.version`, just above) — a non-declaring store
  // falls back to the byte-frozen legacy order (after the update, best-effort). `fenced` decides
  // which branch each call site below takes; a `deleteFenced`/lock/I-O throw from the fenced path
  // propagates BEFORE any update runs (claim intact, reclaim aborts loudly, retryable).
  //
  // issue #197 PR-2 (deliverable 1g): `sealCapable` is checked FIRST — a seal-declaring store
  // preserves ALL of a stale step's WAL (zero-cooperation, no partitioning) instead of destroying
  // it; a fenced-trio-only (non-seal) store keeps the #207 destructive drain unchanged; a
  // non-declaring store keeps the byte-frozen legacy fallback unchanged.
  const traceBufferStore = options?.traceBufferStore;
  const fenced =
    traceBufferStore !== undefined && typeof traceBufferStore.deleteFenced === 'function';
  const sealCapable = fenced && storeDeclaresSeal(traceBufferStore!);

  try {
    if (sealCapable) {
      const sealResult = await sealStaleWalFenced(
        store,
        traceBufferStore!,
        runId,
        stepName,
        run.version,
      );
      warnFencedSealOutcome(runId, stepName, sealResult);
    } else if (fenced) {
      const clearResult = await clearStaleWalFenced(
        store,
        traceBufferStore!,
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
      // A live driver settled it, or another reclaim already removed it → idempotent, no
      // re-remove. Discriminate + earn `detail` against `reloaded` — NEVER `run` (issue #221, B2:
      // the settle-set / evidence / capability_blocks facts that matter here are whatever is TRUE
      // NOW, after the concurrent write that caused this CAS mismatch, not at the stale decision
      // read).
      const { outcome, detail } = classifyNoActiveClaim(reloaded, stepName);
      return {
        run: reloaded,
        step: stepName,
        outcome,
        ...(detail !== undefined ? { detail } : {}),
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
    // issue #207 PR-2 / #197 PR-2: same seal-or-clear-before-update shape as the primary path
    // above, but version-fenced against THIS path's own decision read (`reloaded.version`) —
    // never `run`'s.
    if (sealCapable) {
      const sealResult = await sealStaleWalFenced(
        store,
        traceBufferStore!,
        runId,
        stepName,
        reloaded.version,
      );
      warnFencedSealOutcome(runId, stepName, sealResult);
    } else if (fenced) {
      const clearResult = await clearStaleWalFenced(
        store,
        traceBufferStore!,
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
