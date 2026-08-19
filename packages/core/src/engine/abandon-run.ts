// abandonRun — the single mutation primitive for explicitly abandoning a run.
// Used by both the abandon_run MCP tool and the `realm run abandon` CLI command.
// Run-mutation primitives live in core; command/tool wiring lives in cli/mcp.
import type { RunStore } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import { WorkflowError } from '../types/workflow-error.js';
import { deriveRunPhase, sealRunLevel } from './eligibility.js';

/**
 * Explicitly abandon a run by stamping the authoritative `abandoned_at` marker. The run's phase
 * derives to `abandoned` (via {@link deriveRunPhase}) regardless of `failed_steps`/`terminal_reason`.
 *
 * Behavior:
 * - Missing run → propagates `STATE_RUN_NOT_FOUND` (from `store.get`).
 * - Already abandoned (`abandoned_at` set) → idempotent no-op, returns the existing run.
 * - `gate_waiting` (or `pending_gate` set) → throws `STATE_TRANSITION_DENIED` (gate abandonment is
 *   out of scope — resolve/reject the gate via `submit_human_response` first).
 * - Terminal (`completed`/`failed`/`aborted`) → throws `STATE_RUN_TERMINAL` (do not clobber a finished run).
 * - Otherwise (`running`) → stamps `abandoned_at`, sets `terminal_state:true` + `terminal_reason`.
 *
 * Concurrency: if `update()` raises `STATE_SNAPSHOT_MISMATCH`, the run is reloaded once — if it is now
 * abandoned, that is idempotent success; otherwise the mismatch is propagated (the run changed under
 * us — likely a live runner — and abandon should lose). No retry loop beyond the single reload.
 */
export async function abandonRun(
  store: RunStore,
  runId: string,
  reason?: string,
): Promise<RunRecord> {
  const run = await store.get(runId);

  // Already abandoned → idempotent no-op.
  if (run.abandoned_at !== undefined) {
    return run;
  }

  // issue #279 (increment 2, PR-C — D-3 leg v): the terminal arm is HOISTED ABOVE the gate arm —
  // a terminal run carrying a leftover/stale pending_gate (the #282 class) must report "already
  // terminal" here, not "waiting on a human gate" (a grandfathered record can be terminal AND
  // still carry a stale pending_gate; only a genuinely LIVE gate should ever reach the gate arm
  // below). Do not clobber a finished run.
  if (run.terminal_state) {
    // Derive-for-message: render the TRUE (derived) phase, never the possibly-stale persisted one.
    const derivedPhase = deriveRunPhase(run);
    throw new WorkflowError(
      `Run '${runId}' is already terminal (${derivedPhase}); cannot abandon a finished run.`,
      {
        code: 'STATE_RUN_TERMINAL',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId, run_phase: derivedPhase, persisted_run_phase: run.run_phase },
      },
    );
  }

  // Gate abandonment is deliberately out of scope — reached only for a genuinely LIVE gate now
  // (the terminal check above already caught a stale/grandfathered one).
  if (run.run_phase === 'gate_waiting' || run.pending_gate !== undefined) {
    throw new WorkflowError(
      `Run '${runId}' is waiting on a human gate; resolve or reject the gate via submit_human_response before abandoning.`,
      {
        code: 'STATE_TRANSITION_DENIED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId, run_phase: run.run_phase },
      },
    );
  }

  const abandonedReason = reason ?? 'Abandoned via abandon_run';
  try {
    // issue #367: run-level seal through the ONE bypass-writer chokepoint — it stamps
    // sealed_by {arm: 'abandon_requested'} alongside abandoned_at and terminal_state in the same
    // object literal.
    return await store.update(sealRunLevel(run, 'abandon_requested', abandonedReason));
  } catch (err) {
    if (err instanceof WorkflowError && err.code === 'STATE_SNAPSHOT_MISMATCH') {
      // The run changed under us — reload once.
      const reloaded = await store.get(runId);
      if (reloaded.abandoned_at !== undefined) {
        return reloaded; // someone else abandoned it concurrently → idempotent success
      }
      throw err; // a live writer advanced the run — abandon loses; do not retry
    }
    throw err;
  }
}
