// fence-predicate.ts — the trace buffer's fence as DATA (issue #616, PR-0; design D4 §3).
//
// Until #616 PR-0 the trace buffer's fenced methods took `guard: () => Promise<void>`: a callback
// each caller built to re-read the run and throw when the fenced write must not happen, run by the
// store inside its critical section (#207). A store whose critical section is a database
// transaction cannot run an arbitrary awaited callback inside it, and a guard run outside the
// transaction is exactly the gap #207 closed. Every guard realm ever built reads the run ONCE and
// tests ONE fact about it — so the check is now data: a `FencePredicate` the store evaluates, with
// `evaluateFence`, against the run it reads inside its own critical section.
//
// Each member mirrors its former guard EXACTLY — the same fact, the same refusal (code, message,
// details, `retryable`, `agentAction`), the same treatment of an absent run. The refusal builders
// moved here from their call sites (`append-trace.ts`, `gc.ts`, `purge.ts`, `reclaim-step.ts`,
// `execution-loop.ts`) so no caller mints a fence verdict of its own.
import type { RunRecord } from '../types/run-record.js';
import type { RunStore } from './store-interface.js';
import { WorkflowError } from '../types/workflow-error.js';
import { deriveRunPhase } from '../engine/eligibility.js';
import { TERMINAL_PHASES } from '../engine/lifecycle.js';

/**
 * The five facts a fenced trace-buffer operation can be conditioned on (issue #616 PR-0). Derived
 * from every fenced call site on `60a21eb` — one member per former guard:
 *
 * - `step_open_for_trace` — `append_trace`'s write-time re-check (`appendFenced`): the run exists,
 *   is not terminal, and the step is in none of `completed_steps`/`failed_steps`/`skipped_steps`/
 *   `in_progress_steps`. `run_version` is the version the CALLER observed on its own pre-lock read:
 *   it is the `run_version` the `run_not_found` refusal reports (there is no run to read a version
 *   from once the run is gone) — the former guard closed over the same value.
 * - `run_absent` — `realm run gc`'s resurrect fence (`deleteAllForRunFenced`): the run no longer
 *   exists.
 * - `run_absent_or_terminal` — `realm run purge`'s trace-buffer fence (`deleteAllForRunFenced`): the
 *   run no longer exists, or its DERIVED phase is terminal.
 * - `run_at_version` — reclaim's version fence (`deleteFenced`, `sealFenced`): the run's `version`
 *   equals the one reclaim decided on. The run must EXIST: an absent run is refused with the run
 *   store's own `STATE_RUN_NOT_FOUND` (see `FENCE_REQUIRES_RUN`).
 * - `step_not_in_progress` — the settle-time seal fence (`sealFenced`): the step has left
 *   `in_progress_steps`. The run must EXIST (same as `run_at_version`).
 */
export type FencePredicate =
  | { kind: 'step_open_for_trace'; step_id: string; run_version: number }
  | { kind: 'run_absent' }
  | { kind: 'run_absent_or_terminal' }
  | { kind: 'run_at_version'; version: number }
  | { kind: 'step_not_in_progress'; step_id: string };

export type FencePredicateKind = FencePredicate['kind'];

/** Every member's kind, in declaration order — a law ranges over this list, so a sixth member
 *  cannot be added without a law cell for it (the `satisfies` below breaks the build first). */
export const FENCE_PREDICATE_KINDS = [
  'step_open_for_trace',
  'run_absent',
  'run_absent_or_terminal',
  'run_at_version',
  'step_not_in_progress',
] as const satisfies readonly FencePredicateKind[];

/**
 * Whether a member requires the run to EXIST. `true` ⇔ the former guard did NOT catch the run
 * store's `STATE_RUN_NOT_FOUND`: that error propagated from the guard unchanged. `readRunForFence`
 * therefore lets the reader's own not-found error through for these members (exactly today's
 * error, whatever `RunStore` the reader is), and `evaluateFence` answers an absent run for them
 * with `runNotFoundError` — the one path a store that reads its runs directly (no `get()` of its
 * own to throw) takes.
 */
export const FENCE_REQUIRES_RUN: Readonly<Record<FencePredicateKind, boolean>> = {
  step_open_for_trace: false,
  run_absent: false,
  run_absent_or_terminal: false,
  run_at_version: true,
  step_not_in_progress: true,
};

/** The read a fence is evaluated against: the lock-free `RunStore.get` the former guards used
 *  (#132's atomic-rename-safe read). */
export type FenceRunReader = Pick<RunStore, 'get'>;

/** The four step-membership states, checked in a fixed priority order (issue #207 PR-2). */
export type StepMembershipState = 'completed' | 'failed' | 'skipped' | 'in_progress';

/**
 * The full `append_trace` refusal taxonomy (issue #207 PR-2): every reason a trace append can be
 * refused, before the store's critical section or from inside it, is one of these six — always
 * code `STATE_STEP_NOT_ELIGIBLE`, distinguished by `details.step_state`. `in_progress` is the only
 * RESOLVABLE state (the claim will eventually settle) so it alone gets `agentAction:
 * 'resolve_precondition'` — matching `claimStep`'s own `STATE_STEP_ALREADY_CLAIMED` precedent. The
 * other five are permanent from the caller's perspective and stay `report_to_user`.
 */
export type StepEligibilityState = StepMembershipState | 'run_terminal' | 'run_not_found';

/**
 * The specific settled/in-flight state of a step, or `undefined` if none applies — the granular
 * counterpart to `isStepSettledOrInFlight` (issue #207 PR-2). Checked in a fixed priority order,
 * shared by `append_trace`'s pre-lock check and the `step_open_for_trace` fence so both agree on
 * one taxonomy.
 */
export function stepStateOf(
  run: Pick<RunRecord, 'completed_steps' | 'failed_steps' | 'skipped_steps' | 'in_progress_steps'>,
  stepId: string,
): StepMembershipState | undefined {
  if (run.completed_steps.includes(stepId)) return 'completed';
  if (run.failed_steps.includes(stepId)) return 'failed';
  if (run.skipped_steps.includes(stepId)) return 'skipped';
  if (run.in_progress_steps.includes(stepId)) return 'in_progress';
  return undefined;
}

/** `append_trace`'s refusal (issue #207 PR-2) — see `StepEligibilityState`. */
export function stepNotEligibleError(
  stepId: string,
  runVersion: number,
  stepState: StepEligibilityState,
  extraDetails?: Record<string, unknown>,
): WorkflowError {
  const messages: Record<StepEligibilityState, string> = {
    completed: `Step '${stepId}' has already completed.`,
    failed: `Step '${stepId}' has already failed.`,
    skipped: `Step '${stepId}' was skipped.`,
    in_progress: `Step '${stepId}' is currently being executed by execute_step.`,
    run_terminal: `Run is terminal — trace entries can no longer be adopted by any step.`,
    run_not_found: `Run not found at write time — trace entries can no longer be adopted.`,
  };
  return new WorkflowError(messages[stepState], {
    code: 'STATE_STEP_NOT_ELIGIBLE',
    category: 'STATE',
    agentAction: stepState === 'in_progress' ? 'resolve_precondition' : 'report_to_user',
    retryable: false,
    details: { step_id: stepId, step_state: stepState, run_version: runVersion, ...extraDetails },
  });
}

/**
 * Reclaim's version-fence refusal (issue #207 PR-2): a plain `Error` (deliberately NOT a
 * `WorkflowError`) so no store's own error classification could ever mistake it for something
 * else. `reclaimStep` catches it (by `instanceof`) and skips-and-warns; it never propagates past
 * reclaim.
 */
export class ReclaimVersionChanged extends Error {}

/** The run store's `STATE_RUN_NOT_FOUND` shape (`JsonFileStore`'s, which delegates here) — what a
 *  `FENCE_REQUIRES_RUN` member answers for an absent run when the store reads runs directly. */
export function runNotFoundError(runId: string): WorkflowError {
  return new WorkflowError(`Run not found: ${runId}`, {
    code: 'STATE_RUN_NOT_FOUND',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: false,
    details: { runId },
  });
}

function runResurrectedError(runId: string): WorkflowError {
  return new WorkflowError(`Run '${runId}' exists again — no longer an orphan`, {
    code: 'STATE_RUN_RESURRECTED',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: false,
    details: { runId },
  });
}

function runNoLongerTerminalError(runId: string): WorkflowError {
  return new WorkflowError(
    `Run '${runId}' is no longer terminal — refusing to purge its trace buffer`,
    {
      code: 'STATE_RUN_BUSY',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: true,
      details: {
        runId,
        reason: `run '${runId}' is no longer terminal (resumed since selection) — refusing to purge its trace buffer`,
      },
    },
  );
}

function stepStillInProgressError(runId: string, stepId: string): WorkflowError {
  return new WorkflowError(
    `Refusing to seal trace buffer for run '${runId}' step '${stepId}': the step is still ` +
      'in_progress (the settling update has not yet landed) — residue-not-loss, the live WAL ' +
      'is left intact.',
    {
      code: 'STATE_STEP_PENDING',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: true,
    },
  );
}

/**
 * Evaluates `fence` against `run` — the run as the store read it inside its own critical section,
 * `null` when it does not exist. Returns when the fenced write may proceed; throws the member's
 * refusal otherwise. Pure and synchronous: no I/O, no await, so a store can call it inside a
 * transaction. `runId` is the id the store read (the fenced method's own argument): the refusals
 * name it, and it is the only identity available when `run` is `null`.
 */
export function evaluateFence(fence: FencePredicate, run: RunRecord | null, runId: string): void {
  switch (fence.kind) {
    case 'step_open_for_trace': {
      if (run === null) {
        throw stepNotEligibleError(fence.step_id, fence.run_version, 'run_not_found');
      }
      // issue #279 (increment 2, PR-C — D-3 leg v): keyed on terminal_state; the phase in the
      // details is DERIVED, never the possibly-stale persisted one.
      if (run.terminal_state === true) {
        throw stepNotEligibleError(fence.step_id, run.version, 'run_terminal', {
          run_phase: deriveRunPhase(run),
          persisted_run_phase: run.run_phase,
        });
      }
      const state = stepStateOf(run, fence.step_id);
      if (state !== undefined) {
        throw stepNotEligibleError(fence.step_id, run.version, state);
      }
      return;
    }
    case 'run_absent': {
      if (run === null) return;
      throw runResurrectedError(runId);
    }
    case 'run_absent_or_terminal': {
      if (run === null) return;
      // issue #279 (increment 2, PR-C — D-3 leg iii): the DERIVED phase.
      if (!TERMINAL_PHASES.has(deriveRunPhase(run))) {
        throw runNoLongerTerminalError(runId);
      }
      return;
    }
    case 'run_at_version': {
      if (run === null) throw runNotFoundError(runId);
      if (run.version !== fence.version) {
        throw new ReclaimVersionChanged(
          `reclaim's version fence refused: run '${runId}' changed since the reclaim decision ` +
            `(expected version ${fence.version}, observed ${run.version})`,
        );
      }
      return;
    }
    case 'step_not_in_progress': {
      if (run === null) throw runNotFoundError(runId);
      if (run.in_progress_steps.includes(fence.step_id)) {
        throw stepStillInProgressError(runId, fence.step_id);
      }
      return;
    }
    default: {
      const unreachable: never = fence;
      throw new Error(`unknown fence predicate: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The read a reader-backed store (the JSON and in-memory trace buffers) performs inside its
 * critical section before `evaluateFence`: ONE lock-free `reader.get(runId)`. The reader's
 * `STATE_RUN_NOT_FOUND` becomes `null` for the members that tolerate absence; for the members that
 * require the run (`FENCE_REQUIRES_RUN`) it propagates as the reader threw it — the former guards'
 * exact behaviour. Every other read failure propagates UNWRAPPED, as it did from every guard.
 */
export async function readRunForFence(
  reader: FenceRunReader,
  runId: string,
  fence: FencePredicate,
): Promise<RunRecord | null> {
  try {
    return await reader.get(runId);
  } catch (err) {
    if (
      err instanceof WorkflowError &&
      err.code === 'STATE_RUN_NOT_FOUND' &&
      !FENCE_REQUIRES_RUN[fence.kind]
    ) {
      return null;
    }
    throw err;
  }
}

/** The refusal a reader-backed store throws when a fenced method is called but the store was
 *  constructed without a run reader — loud, never a silently unfenced write. */
export function fenceReaderMissingError(storeName: string): WorkflowError {
  return new WorkflowError(
    `${storeName} was constructed without a run reader, so it cannot evaluate a fence predicate — ` +
      'construct it with the run store the fenced write must be checked against.',
    {
      code: 'ENGINE_INTERNAL',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    },
  );
}

/** Reads the run through `reader` and evaluates `fence` against it — the one call a reader-backed
 *  store makes inside its critical section where the guard call used to be. */
export async function checkFenceWithReader(
  reader: FenceRunReader | undefined,
  storeName: string,
  runId: string,
  fence: FencePredicate,
): Promise<void> {
  if (reader === undefined) throw fenceReaderMissingError(storeName);
  evaluateFence(fence, await readRunForFence(reader, runId, fence), runId);
}
