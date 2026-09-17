// Pure decision logic for the idempotency re-encounter policy (#92 PR 2).
// Shared by JsonFileStore and InMemoryStore so the terminal/live axes behave identically.
import type { RunRecord } from '../types/run-record.js';
import type { CreateRunOptions } from './store-interface.js';
import { WorkflowError } from '../types/workflow-error.js';

/** The action a store should take for a matched run. */
export type IdempotencyDecision = 'reuse' | 'supersede';

/**
 * Decide what to do when an idempotency key matches an existing run, per the caller's policy.
 * Returns `'reuse'` (return the existing run, `created:false`) or `'supersede'` (mint a fresh run,
 * `created:true`); throws a `WorkflowError` for the `fail` / `reject` policies. Pure — no I/O.
 *
 * Defaults (`reuse` / `use_existing`) reproduce PR 1 behavior exactly.
 *
 * CONTRACT (issue #558 PR-C): this function TRUSTS the `run_phase` it is given — it is pure and
 * has no record to derive from beyond the `Pick<>` it receives, whose shape is public API and stays
 * untouched (#279 D-3 leg v). Every caller MUST pass `run_phase: deriveRunPhase(record)` (the
 * `PHASE_IS_GENERATED` doctrine); a caller that forwards a stale persisted label gets a decision
 * computed against that label — e.g. a record persisted `completed` that DERIVES `failed` yields
 * `reuse` under `rerun_if_failed`, silently reusing a failed run. `idempotency-policy.test.ts`'s
 * witness fails any in-tree call site that does not derive.
 */
export function decideIdempotencyPolicy(
  matched: Pick<RunRecord, 'id' | 'workflow_id' | 'run_phase' | 'terminal_state'>,
  options: Pick<CreateRunOptions, 'onTerminalMatch' | 'onLiveMatch'>,
): IdempotencyDecision {
  const onTerminalMatch = options.onTerminalMatch ?? 'reuse';
  const onLiveMatch = options.onLiveMatch ?? 'use_existing';

  if (!matched.terminal_state) {
    // Live match (running / gate_waiting).
    if (onLiveMatch === 'fail') {
      throw new WorkflowError(
        `Idempotency key for workflow '${matched.workflow_id}' is owned by an active run '${matched.id}' (phase '${matched.run_phase}').`,
        {
          code: 'STATE_RUN_ALREADY_ACTIVE',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
          details: { existingRunId: matched.id, run_phase: matched.run_phase },
        },
      );
    }
    return 'reuse'; // use_existing
  }

  // Terminal match.
  switch (onTerminalMatch) {
    case 'reject':
      throw new WorkflowError(
        `Idempotency key for workflow '${matched.workflow_id}' was already used by run '${matched.id}' (terminal phase '${matched.run_phase}').`,
        {
          code: 'STATE_IDEMPOTENCY_KEY_USED',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
          details: { existingRunId: matched.id, run_phase: matched.run_phase },
        },
      );
    case 'rerun':
      return 'supersede';
    case 'rerun_if_failed':
      // completed ⇒ reuse (benign skip — closed-ticket re-run use case); else supersede.
      return matched.run_phase === 'completed' ? 'reuse' : 'supersede';
    case 'reuse':
    default:
      return 'reuse';
  }
}
