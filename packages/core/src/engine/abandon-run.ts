// abandonRun — the single mutation primitive for explicitly abandoning a run.
// Used by both the abandon_run MCP tool and the `realm run abandon` CLI command.
// Run-mutation primitives live in core; command/tool wiring lives in cli/mcp.
import type { RunStore } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import { WorkflowError } from '../types/workflow-error.js';
import {
  definitionAbsentWords,
  questionNeverAnswerable,
  respondWayOfGate,
  type AbandonWay,
  type DefinitionAbsent,
} from './ways.js';
import { admitEntry } from '../admission.js';
import { deriveRunPhase, sealRunLevel } from './eligibility.js';

/**
 * The unconditional abandon advisory (issue #222's documented kill contract), minted ONCE here and
 * imported by all THREE operator surfaces that print it — `realm run abandon`'s third line, the
 * `abandon_run` tool's `note`, and `realm run cleanup`'s sweep footer. Both packages depend on
 * `@sensigo/realm`, so there is no second hand-typed copy to drift (the #444/#508 one-mint rule; a
 * cross-package literal-count cell would only have detected drift, this makes it unconstructible).
 *
 * There is no operator `abort` verb — the graceful path is a workflow's OWN guard abort
 * (`abort_unless`), which runs finalizers. Abandon runs none, ever, for this run.
 */
export const ABANDON_KILL_ADVISORY =
  'abandon is a kill — declared finalizers (if any) did NOT run and will not for this run. ' +
  "The graceful path is the workflow's own guard step (abort_unless), which runs them; " +
  'there is no operator abort command.';

/**
 * Explicitly abandon a run by stamping the authoritative `abandoned_at` marker. The run's phase
 * derives to `abandoned` (via {@link deriveRunPhase}) regardless of `failed_steps`/`terminal_reason`.
 *
 * Behavior:
 * - Missing run → propagates `STATE_RUN_NOT_FOUND` (from `store.get`).
 * - Already abandoned (`abandoned_at` set) → idempotent no-op, returns the existing run.
 * - A LIVE gate (`pending_gate` set) → throws `STATE_TRANSITION_DENIED` carrying
 *   `gate_id`/`step_name`/`choices` in `details`; each surface names its own answer verb. Keyed on
 *   the gate, never the persisted label: a #432-class record (label `gate_waiting`, no
 *   `pending_gate`) has nothing to answer and abandons like the `running` run it derives to.
 * - Terminal (`completed`/`failed`/`aborted`) → throws `STATE_RUN_TERMINAL` (do not clobber a finished run).
 * - Otherwise (`running`) → stamps `abandoned_at`, sets `terminal_state:true` + `terminal_reason`.
 * - Releases every claim in the same write (`in_progress_steps: []`, `claims: {}`) — the shape
 *   {@link applyResume} already performs unconditionally. A terminal run cannot progress:
 *   `claimStep` finds no eligible step (`findEligibleSteps` returns `[]` for `terminal_state`) and
 *   refuses `STATE_STEP_NOT_ELIGIBLE`; `reclaimStep` and `append_trace` refuse terminal by name.
 *   So a kept claim only ever blocked `purge`. The brake on purging a just-abandoned run is
 *   `--older-than`, never a fossil claim.
 *
 * - #819 (U1): an open question that can NEVER be answered ({@link questionNeverAnswerable}, from the
 *   `absence` the caller read) is ended when `gate` names its gate: the reason gains what made it
 *   unanswerable, and the same write clears `pending_gate`. Without `gate`, the refusal names the
 *   gate-named abandon as its way on. Every other open question keeps the refusal and its answer.
 *
 * Concurrency: if `update()` raises `STATE_SNAPSHOT_MISMATCH`, the run is reloaded once — if it is now
 * abandoned, that is idempotent success; otherwise the mismatch is propagated (the run changed under
 * us — likely a live runner — and abandon should lose). No retry loop beyond the single reload.
 */
export async function abandonRun(
  store: RunStore,
  runId: string,
  reason?: string,
  options?: AbandonRunOptions,
): Promise<RunRecord> {
  admitEntry('abandonRun', {
    store,
    storeKind: 'run store',
    parts: { runId, reason, ...(options !== undefined ? { options } : {}) },
  });
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
    // #729 PR-0 (Table row 40): `abandon`'s `run_ended` — reading the run is the one way on.
    throw new WorkflowError(
      `Run '${runId}' is already terminal (${derivedPhase}); cannot abandon a finished run.`,
      {
        code: 'STATE_RUN_TERMINAL',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId, run_phase: derivedPhase, persisted_run_phase: run.run_phase },
        remedy: [{ verb: 'inspect', conditions: [], run_id: runId }],
      },
    );
  }

  // Gate abandonment is deliberately out of scope — reached only for a run carrying a LIVE gate
  // (the terminal check above already caught a stale/grandfathered one). Keyed on the GATE, never
  // on the persisted `run_phase` label (PHASE_IS_GENERATED): a record whose label says
  // `gate_waiting` but carries no `pending_gate` (the #432 class) has nothing anyone can answer —
  // refusing it stranded the operator behind commands that all fail (walk 3) — so it derives
  // `running` and abandons like one.
  const gate = run.pending_gate;
  // #819 (U1): the caller's read of why the definition is absent decides whether the question can
  // ever be answered; it only relaxes the refusal, and only for the gate it names.
  const never =
    gate !== undefined && options?.absence !== undefined && questionNeverAnswerable(options.absence)
      ? options.absence
      : undefined;
  const ending = never !== undefined && options?.gate === gate?.gate_id;
  if (gate !== undefined && !ending) {
    if (never !== undefined) {
      const named: AbandonWay = {
        verb: 'abandon',
        conditions: [],
        run_id: runId,
        gate_id: gate.gate_id,
      };
      throw new WorkflowError(
        `Run '${runId}' is waiting on human gate '${gate.step_name}' (gate '${gate.gate_id}'), whose question can never be answered: ${definitionAbsentWords(never)}.`,
        {
          code: 'STATE_TRANSITION_DENIED',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
          details: {
            runId,
            run_phase: deriveRunPhase(run),
            persisted_run_phase: run.run_phase,
          },
          remedy: [named],
        },
      );
    }
    // #819 (U1): a question that waits on a copy the caller could not read keeps the refusal, with
    // the copy's repair as its way on (the answer waits on it, as the listing says).
    const repairable = options?.absence;
    // The refusal is SURFACE-NEUTRAL: it states the fact; #729 PR-0 (Table row 39): the way on —
    // answering the open question — is its remedy, a typed `respond` way each door words
    // (`realm run respond` on the CLI, the answer tool over MCP); the details re-parse is gone.
    throw new WorkflowError(
      `Run '${runId}' is waiting on human gate '${gate.step_name}' (gate '${gate.gate_id}'); it cannot be abandoned while its question is open.${
        repairable !== undefined
          ? ` It can be answered once its workflow can be read: ${definitionAbsentWords(repairable)}.`
          : ''
      }`,
      {
        code: 'STATE_TRANSITION_DENIED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: {
          runId,
          run_phase: deriveRunPhase(run),
          // The terminal arm's own `persisted_run_phase` precedent (`:73`): the two agree on a live
          // gate and the key is the disclosure, not a correction.
          persisted_run_phase: run.run_phase,
        },
        remedy: [
          repairable !== undefined
            ? {
                verb: 'register',
                conditions: [],
                workflow_id: repairable.workflow_id,
                run_id: runId,
                ...(repairable.path !== undefined ? { path: repairable.path } : {}),
              }
            : respondWayOfGate(runId, gate),
        ],
      },
    );
  }

  // The neutral fallback: each SURFACE supplies its own reason naming the verb the operator used
  // (`Abandoned via realm run abandon` / `Abandoned via abandon_run`). A reason that names the MCP
  // tool for a CLI kill is a false statement about who killed the run (issue #558 PR-C).
  const abandonedReason =
    never !== undefined
      ? `${reason ?? 'Abandoned'} (its question could not be answered: ${definitionAbsentWords(never)})`
      : (reason ?? 'Abandoned');
  try {
    // issue #367: run-level seal through the ONE bypass-writer chokepoint — it stamps
    // sealed_by {arm: 'abandon_requested'} alongside abandoned_at and terminal_state in the same
    // object literal.
    // issue #558 PR-C: release every claim in the SAME write (see the JSDoc bullet above).
    // #819 (U1): ending an unanswerable question clears it in the same write — no terminal record
    // keeps an open question (the #282 class; `sealRunLevel` keeps the rest of the record).
    const sealed = sealRunLevel(run, 'abandon_requested', abandonedReason);
    const { pending_gate: _cleared, ...withoutQuestion } = sealed;
    return await store.update({
      ...(ending ? withoutQuestion : sealed),
      in_progress_steps: [],
      claims: {},
    });
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

/** #819 (U1): what `realm run abandon --gate` passes — the gate it names and why the run's
 *  definition is absent, read before the seal. */
export interface AbandonRunOptions {
  /** The open gate the operator names. */
  gate?: string;
  /** Why the run's definition is absent, as the caller read it (with `source_gone` when the
   *  folder the copy records is gone). */
  absence?: DefinitionAbsent;
}
