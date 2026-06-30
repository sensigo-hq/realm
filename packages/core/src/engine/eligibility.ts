// DAG eligibility predicate — determines which workflow steps are eligible to execute
// based on the completed, in-progress, failed, and skipped step sets in the run record.
// Also exports propagateSkips, which marks steps whose trigger_rule can never be satisfied.
import type {
  WorkflowDefinition,
  StepDefinition,
  TriggerRule,
} from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';
import type { RunPhase } from '../types/run-record.js';
import { resolvePath } from './render-template.js';
import { splitComparison, type ComparisonOp } from './comparison-expr.js';

/**
 * Derives the run_phase from the run record fields.
 * Called after every store write to keep run_phase consistent.
 */
export function deriveRunPhase(
  run: Pick<
    RunRecord,
    | 'pending_gate'
    | 'terminal_state'
    | 'failed_steps'
    | 'terminal_reason'
    | 'aborted_at'
    | 'abandoned_at'
  >,
): RunPhase {
  // abandoned_at is authoritative — explicit operator/cleanup abandonment wins over any field
  // (failed_steps, pending_gate, terminal_reason). It is only ever set on a running run
  // (gate_waiting abandonment is refused by abandonRun), so it never co-occurs with pending_gate
  // in practice; top placement is future-proof and mirrors the aborted_at promotion rationale below.
  if (run.abandoned_at !== undefined) return 'abandoned';
  if (run.pending_gate !== undefined) return 'gate_waiting';
  // aborted_at is authoritative and is checked before both !terminal_state and the
  // 'Workflow completed.' check. The only records that carry aborted_at are guard/handler-aborted
  // runs (always written terminal_state:true); legitimately resumable runs (failed/abandoned) never
  // carry it. Promoting this branch means an aborted run can never revert to 'running' if a
  // write-path recomputes terminal_state while the record still carries aborted_at, and a stale
  // success reason can never mask an abort — while every normal derivation is unchanged.
  if (run.aborted_at !== undefined) return 'aborted';
  if (!run.terminal_state) return 'running';
  // A terminal run that completed successfully sets terminal_reason to 'Workflow completed.'.
  // Recovery workflows end with failed_steps non-empty but are still considered completed
  // when the final recovery step succeeds, so terminal_reason takes precedence over failed_steps.
  if (run.terminal_reason === 'Workflow completed.') return 'completed';
  if (run.failed_steps.length > 0) return 'failed';
  // terminal_state is true but the run neither completed normally nor failed — it was abandoned.
  return 'abandoned';
}

/**
 * Evaluates whether a step's trigger_rule is satisfied given the current run state.
 * Empty or omitted depends_on means the step has no dependencies and is always eligible
 * at the trigger-rule level.
 */
export function triggerRuleSatisfied(step: StepDefinition, run: RunRecord): boolean {
  const deps = step.depends_on ?? [];
  if (deps.length === 0) return true;

  const rule: TriggerRule = step.trigger_rule ?? 'all_success';

  switch (rule) {
    case 'all_success':
      // All deps in completed_steps, none in failed_steps.
      return (
        deps.every((d) => run.completed_steps.includes(d)) &&
        deps.every((d) => !run.failed_steps.includes(d))
      );

    case 'all_failed':
      // All deps in failed_steps.
      return deps.every((d) => run.failed_steps.includes(d));

    case 'all_done':
      // All deps settled: completed, failed, or skipped (skipped deps are permanently settled).
      return deps.every(
        (d) =>
          run.completed_steps.includes(d) ||
          run.failed_steps.includes(d) ||
          run.skipped_steps.includes(d),
      );

    case 'one_failed':
      // At least one dep in failed_steps.
      return deps.some((d) => run.failed_steps.includes(d));

    case 'one_success':
      // At least one dep in completed_steps.
      return deps.some((d) => run.completed_steps.includes(d));

    case 'none_failed':
      // All deps in completed_steps or skipped_steps — none in failed_steps.
      return (
        deps.every((d) => run.completed_steps.includes(d) || run.skipped_steps.includes(d)) &&
        deps.every((d) => !run.failed_steps.includes(d))
      );
  }
}

/** Parse a `when` RHS literal, flagging the bare `null` token (drives the 1c presence-test). */
function parseWhenRhs(rhs: string): { value: unknown; isBareNull: boolean } {
  if ((rhs.startsWith("'") && rhs.endsWith("'")) || (rhs.startsWith('"') && rhs.endsWith('"'))) {
    return { value: rhs.slice(1, -1), isBareNull: false };
  }
  if (rhs === 'true') return { value: true, isBareNull: false };
  if (rhs === 'false') return { value: false, isBareNull: false };
  if (rhs === 'null') return { value: null, isBareNull: true };
  const n = Number(rhs);
  return { value: Number.isNaN(n) ? rhs : n, isBareNull: false };
}

/** Relational comparison requiring both operands numeric (no JS null→0 coercion). */
function compareNumeric(op: ComparisonOp, lhs: unknown, rhs: unknown): boolean {
  if (typeof lhs !== 'number' || typeof rhs !== 'number') return false;
  switch (op) {
    case '>':
      return lhs > rhs;
    case '<':
      return lhs < rhs;
    case '>=':
      return lhs >= rhs;
    case '<=':
      return lhs <= rhs;
    default:
      return false;
  }
}

/**
 * Evaluates a single `when`-condition LEAF against prior step evidence (per-leaf; the array-AND
 * folding lives in {@link evaluateWhen}). Splitting is quote-aware via the shared splitter, so the
 * leaf is split the same way at load and at runtime (no validate/eval divergence).
 *
 * Absent-LHS semantics (unique to `when`):
 * - `== null` / `!= null` (bare null RHS) → loose presence test (`lhs == null` / `lhs != null`),
 *   covering both a missing path and a present-`null` value uniformly.
 * - relational `> < >= <=` → both operands must be numeric, else false (no `null→0` coercion).
 * - any other operator with an undefined LHS → false (symmetric `undefined → false`).
 * - bare path → `Boolean(resolved)`.
 * A resolved LHS uses strict `===`/`!==` (equality) or numeric-guarded relational comparison.
 */
export function evaluateWhenCondition(
  expr: string,
  evidenceByStep: Record<string, Record<string, unknown>>,
  runParams: Record<string, unknown> = {},
): boolean {
  // when-condition paths are relative to step outputs: "step_id.field" resolves directly against
  // evidenceByStep; "run.params.field" resolves against run start params.
  const root: Record<string, unknown> = { ...evidenceByStep, run: { params: runParams } };

  const split = splitComparison(expr);

  // A compound/malformed leaf is rejected at load; if one reaches runtime it is never eligible.
  if (split.kind === 'invalid') return false;

  if (split.kind === 'path') {
    try {
      return Boolean(resolvePath(split.path, root));
    } catch {
      return false;
    }
  }

  const { lhsPath, op, rhsRaw } = split;
  let lhs: unknown;
  try {
    lhs = resolvePath(lhsPath, root);
  } catch {
    return false;
  }
  const { value: rhs, isBareNull } = parseWhenRhs(rhsRaw);

  if (lhs === undefined) {
    // Presence test first (covers missing + present-null uniformly via loose null).
    if ((op === '==' || op === '!=') && isBareNull) {
      return op === '==' ? lhs == null : lhs != null;
    }
    // Relational on an absent LHS → false (numeric guard); any other op on absent → false.
    return false;
  }

  switch (op) {
    case '==':
      return lhs === rhs;
    case '!=':
      return lhs !== rhs;
    case '>':
    case '<':
    case '>=':
    case '<=':
      return compareNumeric(op, lhs, rhs);
    default:
      return false;
  }
}

/**
 * AND-folds a `when` clause (`string | string[]`) over the per-leaf {@link evaluateWhenCondition}.
 * A bare string is a single leaf; an array is the implicit AND of its leaves. An array NEVER reaches
 * the single-string evaluator — normalization happens here, in one place.
 */
export function evaluateWhen(
  clause: string | string[],
  evidenceByStep: Record<string, Record<string, unknown>>,
  runParams: Record<string, unknown> = {},
): boolean {
  const leaves = Array.isArray(clause) ? clause : [clause];
  return leaves.every((leaf) => evaluateWhenCondition(leaf, evidenceByStep, runParams));
}

/**
 * Builds the evidenceByStep map from a run record's evidence array.
 * Merges gate_response snapshots on top of execution snapshots so that
 * the human's choice is accessible via context.resources.<step>.choice in when expressions.
 */
export function buildEvidenceByStep(run: RunRecord): Record<string, Record<string, unknown>> {
  const evidenceByStep: Record<string, Record<string, unknown>> = {};
  for (const snap of run.evidence) {
    if (snap.kind === 'gate_response') {
      // Merge gate response (including choice) into step evidence so downstream
      // when-conditions can reference context.resources.<step>.choice.
      evidenceByStep[snap.step_id] = {
        ...(evidenceByStep[snap.step_id] ?? {}),
        ...snap.output_summary,
      };
    } else {
      evidenceByStep[snap.step_id] = snap.output_summary;
    }
  }
  return evidenceByStep;
}

/**
 * Returns the names of all steps currently eligible for execution.
 * Gate serialization: if any gate is open, no steps are eligible.
 * A step is eligible if:
 *   - not already completed, in-progress, failed, or skipped
 *   - trigger_rule is satisfied
 *   - when-condition (if present) is truthy
 */
export function findEligibleSteps(definition: WorkflowDefinition, run: RunRecord): string[] {
  // A terminal run has no eligible steps — never re-drive a completed/failed/aborted/abandoned run
  // (e.g. when re-encountered through an idempotency-key match on start_run/start_run_batch).
  if (run.terminal_state) return [];
  // Gate serialization: if a gate is open, no new steps are eligible.
  if (run.pending_gate !== undefined) return [];

  const evidenceByStep = buildEvidenceByStep(run);
  const eligible: string[] = [];

  for (const [stepName, step] of Object.entries(definition.steps)) {
    // Guard steps are executed inline by the engine, not by the agent.
    // They never appear as eligible steps returned to callers.
    if (step.execution === 'guard') continue;

    // Already done or in-flight.
    if (
      run.completed_steps.includes(stepName) ||
      run.in_progress_steps.includes(stepName) ||
      run.failed_steps.includes(stepName) ||
      run.skipped_steps.includes(stepName)
    ) {
      continue;
    }

    // Trigger rule evaluation.
    if (!triggerRuleSatisfied(step, run)) continue;

    // when-condition evaluation (string | string[] implicit-AND).
    if (step.when !== undefined) {
      if (!evaluateWhen(step.when, evidenceByStep, run.params)) continue;
    }

    eligible.push(stepName);
  }

  return eligible;
}

/**
 * Returns the names of all guard steps currently eligible for inline engine execution.
 * A guard step is eligible when its trigger_rule is satisfied and it is not yet settled.
 * Guard steps are never returned by findEligibleSteps (they execute inside the engine,
 * not via agent execute_step calls).
 */
export function findEligibleGuardSteps(definition: WorkflowDefinition, run: RunRecord): string[] {
  // A terminal run has no eligible guard steps either — symmetric with findEligibleSteps so a
  // terminal run is never re-driven through the guard surface.
  if (run.terminal_state) return [];
  if (run.pending_gate !== undefined) return [];

  const eligible: string[] = [];

  for (const [stepName, step] of Object.entries(definition.steps)) {
    if (step.execution !== 'guard') continue;

    // Already settled.
    if (
      run.completed_steps.includes(stepName) ||
      run.in_progress_steps.includes(stepName) ||
      run.failed_steps.includes(stepName) ||
      run.skipped_steps.includes(stepName)
    ) {
      continue;
    }

    // Trigger rule evaluation.
    if (!triggerRuleSatisfied(step, run)) continue;

    // when-condition evaluation (string | string[] implicit-AND).
    if (step.when !== undefined) {
      const evidenceByStep = buildEvidenceByStep(run);
      if (!evaluateWhen(step.when, evidenceByStep, run.params)) continue;
    }

    eligible.push(stepName);
  }

  return eligible;
}

/**
 * Returns true when every step in the workflow has been completed, failed, or skipped,
 * and no steps are in-progress. Used to detect run completion after each step write.
 */
export function isWorkflowComplete(run: RunRecord, definition: WorkflowDefinition): boolean {
  const allSteps = Object.keys(definition.steps);
  return (
    allSteps.every(
      (name) =>
        run.completed_steps.includes(name) ||
        run.failed_steps.includes(name) ||
        run.skipped_steps.includes(name),
    ) && run.in_progress_steps.length === 0
  );
}

/**
 * Returns false if a step's trigger_rule can provably never be satisfied given the
 * current settled state. Called by propagateSkips to determine which steps to skip.
 *
 * "Settled" means the step is in completed_steps, failed_steps, or skipped_steps.
 * In-progress and unsettled steps are treated as potentially resolving either way.
 */
function canTriggerRuleEverBeSatisfied(step: StepDefinition, run: RunRecord): boolean {
  const deps = step.depends_on ?? [];
  if (deps.length === 0) return true;

  const rule: TriggerRule = step.trigger_rule ?? 'all_success';

  switch (rule) {
    case 'all_success':
      // Needs every dep to succeed — impossible if any dep already failed or is skipped.
      return deps.every((d) => !run.failed_steps.includes(d) && !run.skipped_steps.includes(d));

    case 'all_failed':
      // Needs every dep to fail — impossible if any dep already completed or is skipped.
      return deps.every((d) => !run.completed_steps.includes(d) && !run.skipped_steps.includes(d));

    case 'all_done':
      // Always eventually satisfiable — all deps will settle (complete, fail, or be skipped)
      // and all_done treats skipped as settled, so this can always fire.
      return true;

    case 'one_failed':
      // Needs at least one dep to fail — impossible if all deps are completed or skipped
      // (none can ever fail). A dep that is still unsettled might yet fail.
      return deps.some(
        (d) =>
          run.failed_steps.includes(d) || // already satisfied
          (!run.completed_steps.includes(d) && !run.skipped_steps.includes(d)), // might still fail
      );

    case 'one_success':
      // Needs at least one dep to succeed — impossible if all deps are failed or skipped
      // (none can ever succeed). A dep that is still unsettled might yet succeed.
      return deps.some(
        (d) =>
          run.completed_steps.includes(d) || // already satisfied
          (!run.failed_steps.includes(d) && !run.skipped_steps.includes(d)), // might still succeed
      );

    case 'none_failed':
      // Needs no dep to fail — impossible if any dep already failed.
      return deps.every((d) => !run.failed_steps.includes(d));
  }
}

/**
 * After a step settles (completes, fails, or is already skipped), some downstream steps
 * may have trigger_rules that can never be satisfied. This function marks those steps
 * as skipped and iterates until no new skips can be derived (fixed-point).
 *
 * Returns the updated skipped_steps array, which may be larger than run.skipped_steps.
 * Does not mutate the run record — callers apply the result before writing.
 */
export function propagateSkips(run: RunRecord, definition: WorkflowDefinition): string[] {
  const skipped = [...run.skipped_steps];
  let changed = true;

  while (changed) {
    changed = false;
    for (const [stepName, step] of Object.entries(definition.steps)) {
      // Only evaluate steps that are not yet settled.
      if (
        run.completed_steps.includes(stepName) ||
        run.in_progress_steps.includes(stepName) ||
        run.failed_steps.includes(stepName) ||
        skipped.includes(stepName)
      ) {
        continue;
      }

      // Use the growing skipped set so cascading skips are detected in one pass.
      const tempRun: RunRecord = { ...run, skipped_steps: skipped };
      if (!canTriggerRuleEverBeSatisfied(step, tempRun)) {
        skipped.push(stepName);
        changed = true;
        continue;
      }

      // A step whose when-condition evaluates to false once all its deps are settled
      // can never become eligible — mark it skipped so isWorkflowComplete can fire.
      if (step.when !== undefined) {
        const deps = step.depends_on ?? [];
        const allDepsSettled = deps.every(
          (d) =>
            tempRun.completed_steps.includes(d) ||
            tempRun.failed_steps.includes(d) ||
            skipped.includes(d),
        );
        if (allDepsSettled && !evaluateWhen(step.when, buildEvidenceByStep(run), run.params)) {
          skipped.push(stepName);
          changed = true;
        }
      }
    }
  }

  return skipped;
}
