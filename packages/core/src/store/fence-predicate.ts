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
 * from every fenced call site on `60a21eb` — one member per former guard.
 *
 * A member is a condition on the fenced method's OWN target and never names a target of its own:
 * the run is always the method's `runId`, and the two step members (`step_open_for_trace`,
 * `step_not_in_progress`) are evaluated against the method's `stepId`. A fence therefore cannot
 * condition one step while the write lands on another, and only the per-step methods accept a step
 * member (`StepScopedFencePredicate`); the run-wide `deleteAllForRunFenced` takes a
 * `RunScopedFencePredicate`. The per-step methods accept every member: a run-scoped member
 * conditions the run the step belongs to. A member carries only its own fields:
 * `assertFencePredicate` refuses any other own, enumerable, string-keyed property — every field
 * an object literal or parsed JSON can carry.
 *
 * - `step_open_for_trace` — `append_trace`'s write-time re-check (`appendFenced`): the run exists,
 *   is not terminal, and the method's step is in none of `completed_steps`/`failed_steps`/
 *   `skipped_steps`/`in_progress_steps`. `run_version` is the version the CALLER observed on its
 *   own pre-lock read:
 *   it is the `run_version` the `run_not_found` refusal reports (there is no run to read a version
 *   from once the run is gone) — the former guard closed over the same value.
 * - `run_absent` — `realm run gc`'s resurrect fence (`deleteAllForRunFenced`): the run no longer
 *   exists.
 * - `run_absent_or_terminal` — `realm run purge`'s trace-buffer fence (`deleteAllForRunFenced`): the
 *   run no longer exists, or its DERIVED phase is terminal.
 * - `run_at_version` — reclaim's version fence (`deleteFenced`, `sealFenced`): the run's `version`
 *   equals the one reclaim decided on. The run must EXIST: an absent run is refused with the run
 *   store's own `STATE_RUN_NOT_FOUND` (see `FENCE_REQUIRES_RUN`).
 * - `step_not_in_progress` — the settle-time seal fence (`sealFenced`): the method's step has left
 *   `in_progress_steps`. The run must EXIST (same as `run_at_version`).
 */
export type FencePredicate =
  | { kind: 'step_open_for_trace'; run_version: number }
  | { kind: 'run_absent' }
  | { kind: 'run_absent_or_terminal' }
  | { kind: 'run_at_version'; version: number }
  | { kind: 'step_not_in_progress' };

export type FencePredicateKind = FencePredicate['kind'];

/** Whether a member conditions one step — evaluated against the fenced method's own `stepId`.
 *  Keyed by every kind, so a new member cannot be added without deciding it; the two types below
 *  and `isStepScopedFence` are derived from it. */
export const FENCE_TARGETS_STEP = {
  step_open_for_trace: true,
  run_absent: false,
  run_absent_or_terminal: false,
  run_at_version: false,
  step_not_in_progress: true,
} as const satisfies Record<FencePredicateKind, boolean>;

type StepScopedKind = {
  [K in FencePredicateKind]: (typeof FENCE_TARGETS_STEP)[K] extends true ? K : never;
}[FencePredicateKind];

/** The members that condition one step — evaluated against the fenced method's own `stepId`.
 *  Only the per-step methods (`appendFenced`, `deleteFenced`, `sealFenced`) accept them. */
export type StepScopedFencePredicate = Extract<FencePredicate, { kind: StepScopedKind }>;

/** The members that condition only the run — the only ones the run-wide `deleteAllForRunFenced`
 *  accepts. The per-step methods accept them too: a run-scoped member conditions the run the step
 *  belongs to. */
export type RunScopedFencePredicate = Exclude<FencePredicate, StepScopedFencePredicate>;

/** Whether `fence` conditions one step (`FENCE_TARGETS_STEP`). */
export function isStepScopedFence(fence: FencePredicate): fence is StepScopedFencePredicate {
  return FENCE_TARGETS_STEP[fence.kind];
}

/** Every member's kind, in declaration order. A law ranges over this list, so it must name every
 *  member: the object below `satisfies` a record keyed by EVERY kind, so leaving a kind out (or
 *  naming one that does not exist) fails to compile. */
export const FENCE_PREDICATE_KINDS = Object.keys({
  step_open_for_trace: true,
  run_absent: true,
  run_absent_or_terminal: true,
  run_at_version: true,
  step_not_in_progress: true,
} satisfies Record<FencePredicateKind, true>) as readonly FencePredicateKind[];

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
 * The step states an `append_trace` refusal names (issue #207 PR-2): every refusal that carries a
 * `details.step_state` — from the pre-lock check or from inside the store's critical section —
 * carries one of these six, always with code `STATE_STEP_NOT_ELIGIBLE`. (`append_trace` refuses
 * for other reasons too, with other codes or without a step state.) `in_progress` is the only
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

/** Each member's own fields besides `kind` — every one a non-negative integer. A fence with any
 *  other field is refused (`assertFencePredicate`): a member never names its target. The
 *  `satisfies` checks each listed field exists on its member. */
const FENCE_FIELDS = {
  step_open_for_trace: ['run_version'],
  run_absent: [],
  run_absent_or_terminal: [],
  run_at_version: ['version'],
  step_not_in_progress: [],
} as const satisfies {
  readonly [K in FencePredicateKind]: readonly Exclude<
    keyof Extract<FencePredicate, { kind: K }>,
    'kind'
  >[];
};

const FENCE_KINDS: ReadonlySet<unknown> = new Set<unknown>(FENCE_PREDICATE_KINDS);

/** How a refusal names a value that is not a fence predicate. Never throws. */
function describeNonFence(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'function') return 'a function';
  if (typeof value !== 'object') return `a ${typeof value}`;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === undefined) return 'an object with no kind';
  return typeof kind === 'string'
    ? `an object with kind '${kind}'`
    : 'an object with a non-string kind';
}

/** The refusal for a value outside the five members — a plain-JavaScript caller's, or one
 *  still passing the guard callback these methods took before issue #616. */
function notAFencePredicateError(value: unknown): WorkflowError {
  return new WorkflowError(
    `Not a fence predicate: got ${describeNonFence(value)}. A fenced trace-buffer method takes a ` +
      `FencePredicate — an object whose kind is one of ${FENCE_PREDICATE_KINDS.join(', ')}.`,
    {
      code: 'ENGINE_INTERNAL',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    },
  );
}

/** How a refusal names a member field's value. Never throws. */
function describeFieldValue(value: unknown): string {
  if (value === undefined) return 'none';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'number') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** The refusal for a member with a wrong or extra field. */
function invalidFenceError(kind: FencePredicateKind, problem: string): WorkflowError {
  return new WorkflowError(`Invalid '${kind}' fence: ${problem}.`, {
    code: 'ENGINE_INTERNAL',
    category: 'ENGINE',
    agentAction: 'stop',
    retryable: false,
  });
}

/** The refusal for a step member evaluated without a step — passed to the run-wide method, or to a
 *  per-step method with no `stepId`. */
function fenceNeedsStepError(kind: FencePredicateKind): WorkflowError {
  return new WorkflowError(
    `A '${kind}' fence conditions one step, and no step was given: pass it to a per-step ` +
      "operation (appendFenced, deleteFenced, sealFenced) with that step's id — the run-wide " +
      'deleteAllForRunFenced takes no step.',
    {
      code: 'ENGINE_INTERNAL',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    },
  );
}

/** The step a step member is evaluated against: the fenced method's own `stepId`. */
function stepFor(kind: FencePredicateKind, stepId: string | undefined): string {
  if (stepId === undefined) throw fenceNeedsStepError(kind);
  return stepId;
}

/**
 * Refuses, with `ENGINE_INTERNAL`, anything a fenced method must not act on: a value that is not a
 * fence predicate, a member with a wrong or extra field, and a step member given no `stepId` (the
 * run-wide method passes none). A store calls it as the first act of every fenced method — before
 * any lock, scan, read or write — so a caller's mistake is reported as one, at once, never as a
 * busy, contention or filesystem error. `evaluateFence` and `checkFenceWithReader` call it too.
 */
export function assertFencePredicate(
  fence: unknown,
  stepId?: string,
): asserts fence is FencePredicate {
  if (
    typeof fence !== 'object' ||
    fence === null ||
    !FENCE_KINDS.has((fence as { kind?: unknown }).kind)
  ) {
    throw notAFencePredicateError(fence);
  }
  const kind = (fence as FencePredicate).kind;
  const fields: readonly string[] = FENCE_FIELDS[kind];
  for (const key of Object.keys(fence)) {
    if (key !== 'kind' && !fields.includes(key)) {
      throw invalidFenceError(
        kind,
        key === 'step_id'
          ? "it has a 'step_id' field — a fence never names its target; the step is the fenced method's own"
          : `it has an unexpected '${key}' field`,
      );
    }
  }
  for (const field of fields) {
    const value = (fence as unknown as Record<string, unknown>)[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw invalidFenceError(
        kind,
        `${field} must be a non-negative integer (got ${describeFieldValue(value)})`,
      );
    }
  }
  if (FENCE_TARGETS_STEP[kind]) stepFor(kind, stepId);
}

/**
 * Evaluates `fence` against `run` — the run as the store read it inside its own critical section,
 * `null` when it does not exist. Returns when the fenced write may proceed; throws the member's
 * refusal otherwise. Pure and synchronous: no I/O, no await, so a store can call it inside a
 * transaction. `runId` and `stepId` are the fenced method's own arguments: the refusals name them,
 * `runId` is the only identity available when `run` is `null`, and `stepId` is the step a step
 * member (`StepScopedFencePredicate`) is evaluated against — so a step member needs one, and the
 * run-wide method passes none. `assertFencePredicate` runs first.
 */
export function evaluateFence(
  fence: RunScopedFencePredicate,
  run: RunRecord | null,
  runId: string,
  stepId?: string,
): void;
export function evaluateFence(
  fence: FencePredicate,
  run: RunRecord | null,
  runId: string,
  stepId: string,
): void;
export function evaluateFence(
  fence: FencePredicate,
  run: RunRecord | null,
  runId: string,
  stepId?: string,
): void {
  assertFencePredicate(fence, stepId);
  evaluateChecked(fence, run, runId, stepId);
}

/** `evaluateFence`'s body, for a fence `assertFencePredicate` has already accepted. */
function evaluateChecked(
  fence: FencePredicate,
  run: RunRecord | null,
  runId: string,
  stepId: string | undefined,
): void {
  switch (fence.kind) {
    case 'step_open_for_trace': {
      const step = stepFor(fence.kind, stepId);
      if (run === null) {
        throw stepNotEligibleError(step, fence.run_version, 'run_not_found');
      }
      // issue #279 (increment 2, PR-C — D-3 leg v): keyed on terminal_state; the phase in the
      // details is DERIVED, never the possibly-stale persisted one.
      if (run.terminal_state === true) {
        throw stepNotEligibleError(step, run.version, 'run_terminal', {
          run_phase: deriveRunPhase(run),
          persisted_run_phase: run.run_phase,
        });
      }
      const state = stepStateOf(run, step);
      if (state !== undefined) {
        throw stepNotEligibleError(step, run.version, state);
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
      const step = stepFor(fence.kind, stepId);
      if (run === null) throw runNotFoundError(runId);
      if (run.in_progress_steps.includes(step)) {
        throw stepStillInProgressError(runId, step);
      }
      return;
    }
    default: {
      // Unreachable once `assertFencePredicate` has run; kept so the switch stays exhaustive.
      const unreachable: never = fence;
      throw notAFencePredicateError(unreachable);
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

/** The refusal both reader-backed stores (`JsonTraceBufferStore`, `InMemoryTraceBufferStore`) throw
 *  at construction when the reader slot holds nothing with a `get` method (`isFenceRunReader`).
 *  Loud, never a silently unfenced write. */
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

/** Whether `value` has a run reader's shape — a `get` method (structural only: any object with a
 *  `get` method passes, a `Map` included). The one test both of realm's reader-backed stores apply
 *  at construction: a JavaScript caller can pass nothing or `null`, or — to `JsonTraceBufferStore`
 *  — the previous release's `(runsDir, lockProfile)` shape, which puts a lock profile where the
 *  reader now goes; each is refused as a missing reader there, never discovered as a bare
 *  `TypeError` at the first fenced call. */
export function isFenceRunReader(value: unknown): value is FenceRunReader {
  return typeof (value as { get?: unknown } | null | undefined)?.get === 'function';
}

/** Reads the run through `reader` and evaluates `fence` against it — the one call a reader-backed
 *  store makes inside its critical section where the guard call used to be. `stepId` is the fenced
 *  method's own step (the run-wide method passes none). The fence is checked before the read, so a
 *  malformed fence never costs one. `reader` must already have passed `isFenceRunReader`: a store
 *  checks its reader once, at construction, and this helper does not check it again. */
export function checkFenceWithReader(
  reader: FenceRunReader,
  runId: string,
  fence: RunScopedFencePredicate,
  stepId?: string,
): Promise<void>;
export function checkFenceWithReader(
  reader: FenceRunReader,
  runId: string,
  fence: FencePredicate,
  stepId: string,
): Promise<void>;
export async function checkFenceWithReader(
  reader: FenceRunReader,
  runId: string,
  fence: FencePredicate,
  stepId?: string,
): Promise<void> {
  assertFencePredicate(fence, stepId);
  evaluateChecked(fence, await readRunForFence(reader, runId, fence), runId, stepId);
}
