// Run phase constants and derived helpers for the DAG execution model.
// run_phase replaces the old state string for callers that need a single status word.
import type { RunPhase } from '../types/run-record.js';

/** Phases that mark a run as finished — no further steps will execute. */
export const TERMINAL_PHASES = new Set<RunPhase>(['completed', 'failed', 'abandoned', 'aborted']);

/** Phases from which a run can be resumed by removing steps from failed_steps. */
export const RESUMABLE_PHASES = new Set<RunPhase>(['failed', 'abandoned']);

/** Phases in which a run is waiting for a human gate response. */
export const WAITING_PHASES = new Set<RunPhase>(['gate_waiting']);

/**
 * Maximum seconds the engine waits for in-flight steps to settle after a guard fires.
 * In v1 this is a documentation constant — the drain is handled by STATE_RUN_TERMINAL
 * rejections on terminal runs. Will bound a runtime drain window if per-run timeouts
 * are added in a future phase.
 */
export const DRAIN_CEILING_SECONDS = 30;

/**
 * Issue #279 (increment 1): the clamp ceiling `applySettlement`'s `lease_finalizer` arm applies to
 * a caller-requested `leaseSeconds` (design record `plans/issue-279/design-d4-increment1.md` §3's
 * `clamp(leaseSeconds, DRAIN_LEASE_MAX)`). A finalizer's own author-declared `timeout_seconds` can
 * be arbitrarily long (it bounds `withTimeout`'s handler-execution wait, same as any other step),
 * but the SEPARATE bound this constant enforces is operator-facing: `realm run resume`'s pending-
 * lease refusal (design record §5.3) and `drain --void`'s own unexpired-lease refusal (§6) both
 * wait AT MOST this long before an operator can act — "the wait bound must stay short" (§3),
 * independent of whatever a workflow author declared. 300s (5 minutes) is chosen as generous
 * enough to cover the overwhelming majority of real finalizer handlers (webhooks, notifications,
 * short-lived side effects) while keeping an operator's worst-case wait on the order of minutes,
 * not whatever a long-`timeout_seconds` author might declare.
 */
export const DRAIN_LEASE_MAX = 300;

/** Returns true when a run in the given phase will not execute any more steps. */
export function isTerminalPhase(phase: RunPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

// Legacy aliases — kept for backward compatibility with existing imports.
// New code should use TERMINAL_PHASES, RESUMABLE_PHASES, WAITING_PHASES, isTerminalPhase.
export const TERMINAL_STATES = TERMINAL_PHASES;
export const RESUMABLE_STATES = RESUMABLE_PHASES;
export const WAITING_STATES = WAITING_PHASES;
export const isTerminalState = isTerminalPhase;
