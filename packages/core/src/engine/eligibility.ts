// DAG eligibility predicate — determines which workflow steps are eligible to execute
// based on the completed, in-progress, failed, and skipped step sets in the run record.
// Also exports propagateSkips, which marks steps whose trigger_rule can never be satisfied.
import type {
  WorkflowDefinition,
  StepDefinition,
  TriggerRule,
} from '../types/workflow-definition.js';
import type { RunRecord, SkipDetail } from '../types/run-record.js';
import type { RunPhase } from '../types/run-record.js';
import { resolvePath } from './render-template.js';
import { splitComparison, type ComparisonOp } from './comparison-expr.js';
import { boundResolvedValue } from '../utils/redaction.js';

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
 * Builds the root object `when`-condition paths resolve against: step outputs directly
 * (`"step_id.field"`), plus `run.params.field` for run start params. Extracted (issue #111) so
 * both {@link evaluateWhenCondition} and the traced evaluator ({@link traceWhenCondition}) resolve
 * against the exact same shape — a pure extraction, byte-identical to the previous inline object.
 *
 * Scoped to the when-root ONLY — do NOT reuse this for the input_map root (`execution-loop.ts`)
 * or the template root (`render-template.ts`); those are a different nested `context.resources`
 * shape and unifying them would corrupt path resolution.
 */
function buildWhenRoot(
  evidenceByStep: Record<string, Record<string, unknown>>,
  runParams: Record<string, unknown>,
): Record<string, unknown> {
  return { ...evidenceByStep, run: { params: runParams } };
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
  const root = buildWhenRoot(evidenceByStep, runParams);

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
 * Traced `when`-evaluator (issue #111) — used ONLY at propagateSkips' when-branch, built once at
 * the moment a step is pushed to `skipped_steps`. Unlike {@link evaluateWhen} (which short-circuits
 * via `.every` at the first false leaf), this iterates EVERY leaf and records its resolved LHS —
 * the signal that catches a field-name typo (a mistyped `when` leaf resolves to `undefined` → false
 * → the step silently skips; recording `lhs_present: false` makes that visible).
 *
 * Each leaf's `passed` REUSES {@link evaluateWhenCondition} — never re-implemented — so the trace
 * can never drift from the actual verdict that caused the skip. By construction,
 * `evaluateWhen(clause, ...) === trace.every((l) => l.passed)` for the same inputs.
 */
function traceWhenCondition(
  clause: string | string[],
  evidenceByStep: Record<string, Record<string, unknown>>,
  runParams: Record<string, unknown>,
): Array<{ leaf: string; lhs_present: boolean; resolved_value?: unknown; passed: boolean }> {
  const leaves = Array.isArray(clause) ? clause : [clause];
  const root = buildWhenRoot(evidenceByStep, runParams);

  return leaves.map((leaf) => {
    // Reuse the real evaluator for `passed` — the trace must never compute a second, divergent
    // boolean path.
    const passed = evaluateWhenCondition(leaf, evidenceByStep, runParams);

    const split = splitComparison(leaf);
    // A compound/malformed leaf reaching runtime (load-time validation normally rejects it):
    // no LHS to resolve. `passed` is already false here (evaluateWhenCondition returns false for
    // `kind: 'invalid'`), consistent with the reused-verdict rule above.
    if (split.kind === 'invalid') {
      return { leaf, lhs_present: false, passed };
    }

    const lhsPath = split.kind === 'path' ? split.path : split.lhsPath;
    let value: unknown;
    try {
      value = resolvePath(lhsPath, root);
    } catch {
      return { leaf, lhs_present: false, passed };
    }

    // A path miss (commonly a field-name typo) resolves to undefined — omit resolved_value
    // entirely (not `undefined`) so its ABSENCE is the JSON-durable typo signal.
    if (value === undefined) {
      return { leaf, lhs_present: false, passed };
    }

    return { leaf, lhs_present: true, resolved_value: boundResolvedValue(value), passed };
  });
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
 * True iff `stepId` is a member of `completed_steps ∪ failed_steps ∪ skipped_steps ∪
 * in_progress_steps` on `run` — the shared "already settled or currently claimed" membership
 * test, factored out (issue #207) from four inline four-array checks that had drifted apart in
 * shape at their call sites. `append_trace.ts` has its own, separate `skipped_steps` omission
 * (D3 §2) — NOT fixed by this PR (append_trace.ts is untouched here; adopting this helper there
 * is PR-2's job). This chokepoint is what makes that fix, once made, a one-line call instead of a
 * fifth hand-copied four-array check. Pure and synchronous by design — every call site that
 * depends on running with no `await` between a check and a mutation (e.g. `InMemoryStore
 * .claimStep`'s issue #188 no-await-between-check-and-mutate fix) can call this helper without
 * reintroducing a microtask-yield point.
 */
export function isStepSettledOrInFlight(run: RunRecord, stepId: string): boolean {
  return (
    run.completed_steps.includes(stepId) ||
    run.failed_steps.includes(stepId) ||
    run.skipped_steps.includes(stepId) ||
    run.in_progress_steps.includes(stepId)
  );
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
    // Guard and finalizer steps are executed inline by the engine, not by the agent.
    // They never appear as eligible steps returned to callers, and must never be
    // claimStep-able (finalizers run only in the terminal drain, held out of the DAG).
    if (step.execution === 'guard' || step.execution === 'finalizer') continue;

    // Already done or in-flight.
    if (isStepSettledOrInFlight(run, stepName)) {
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
    if (isStepSettledOrInFlight(run, stepName)) {
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
  // Finalizers are held out of the DAG and run only in the terminal drain — DAG completion
  // resolves on domain (non-finalizer) steps alone. Including finalizers here would deadlock
  // the seal (they never enter completed/failed/skipped before the drain that seals).
  const allSteps = Object.entries(definition.steps)
    .filter(([, step]) => step.execution !== 'finalizer')
    .map(([name]) => name);
  return (
    allSteps.every(
      (name) =>
        run.completed_steps.includes(name) ||
        run.failed_steps.includes(name) ||
        run.skipped_steps.includes(name),
    ) && run.in_progress_steps.length === 0
  );
}

/** A dep's settled state, as witnessed by {@link canTriggerRuleEverBeSatisfied}. */
type DepState = 'completed' | 'failed' | 'skipped';

/** The result of {@link canTriggerRuleEverBeSatisfied}: a verdict plus, when unsatisfiable, a witness. */
interface SatisfiabilityResult {
  satisfiable: boolean;
  /** The deps whose settled state makes the rule provably unsatisfiable. Only present when unsatisfiable. */
  blocking_deps?: Array<{ dep: string; state: DepState }>;
}

/**
 * Returns false (plus a witness — issue #111) if a step's trigger_rule can provably never be
 * satisfied given the current settled state. Called by propagateSkips to determine which steps
 * to skip. Verdict and witness are computed together at the SAME membership tests, per rule arm,
 * so they cannot drift from each other.
 *
 * "Settled" means the step is in completed_steps, failed_steps, or skipped_steps.
 * In-progress and unsettled steps are treated as potentially resolving either way.
 *
 * Only caller: propagateSkips.
 */
function canTriggerRuleEverBeSatisfied(step: StepDefinition, run: RunRecord): SatisfiabilityResult {
  const deps = step.depends_on ?? [];
  if (deps.length === 0) return { satisfiable: true };

  const rule: TriggerRule = step.trigger_rule ?? 'all_success';

  switch (rule) {
    case 'all_success': {
      // Needs every dep to succeed — impossible if any dep already failed or is skipped.
      const blocking_deps = deps
        .filter((d) => run.failed_steps.includes(d) || run.skipped_steps.includes(d))
        .map((d) => ({
          dep: d,
          state: (run.failed_steps.includes(d) ? 'failed' : 'skipped') as DepState,
        }));
      return blocking_deps.length === 0
        ? { satisfiable: true }
        : { satisfiable: false, blocking_deps };
    }

    case 'all_failed': {
      // Needs every dep to fail — impossible if any dep already completed or is skipped.
      const blocking_deps = deps
        .filter((d) => run.completed_steps.includes(d) || run.skipped_steps.includes(d))
        .map((d) => ({
          dep: d,
          state: (run.completed_steps.includes(d) ? 'completed' : 'skipped') as DepState,
        }));
      return blocking_deps.length === 0
        ? { satisfiable: true }
        : { satisfiable: false, blocking_deps };
    }

    case 'all_done':
      // Always eventually satisfiable — all deps will settle (complete, fail, or be skipped)
      // and all_done treats skipped as settled, so this can always fire.
      return { satisfiable: true };

    case 'one_failed': {
      // Needs at least one dep to fail — impossible if all deps are completed or skipped
      // (none can ever fail). A dep that is still unsettled might yet fail.
      const satisfiable = deps.some(
        (d) =>
          run.failed_steps.includes(d) || // already satisfied
          (!run.completed_steps.includes(d) && !run.skipped_steps.includes(d)), // might still fail
      );
      if (satisfiable) return { satisfiable: true };
      // Unsatisfiable here means EVERY dep is provably completed or skipped (none failed, none
      // unsettled) — collective exhaustion, so the witness names ALL deps; a subset would
      // misattribute cause.
      return {
        satisfiable: false,
        blocking_deps: deps.map((d) => ({
          dep: d,
          state: (run.completed_steps.includes(d) ? 'completed' : 'skipped') as DepState,
        })),
      };
    }

    case 'one_success': {
      // Needs at least one dep to succeed — impossible if all deps are failed or skipped
      // (none can ever succeed). A dep that is still unsettled might yet succeed.
      const satisfiable = deps.some(
        (d) =>
          run.completed_steps.includes(d) || // already satisfied
          (!run.failed_steps.includes(d) && !run.skipped_steps.includes(d)), // might still succeed
      );
      if (satisfiable) return { satisfiable: true };
      // Unsatisfiable here means EVERY dep is provably failed or skipped — collective exhaustion,
      // same rationale as one_failed above.
      return {
        satisfiable: false,
        blocking_deps: deps.map((d) => ({
          dep: d,
          state: (run.failed_steps.includes(d) ? 'failed' : 'skipped') as DepState,
        })),
      };
    }

    case 'none_failed': {
      // Needs no dep to fail — impossible if any dep already failed.
      const blocking_deps = deps
        .filter((d) => run.failed_steps.includes(d))
        .map((d) => ({ dep: d, state: 'failed' as DepState }));
      return blocking_deps.length === 0
        ? { satisfiable: true }
        : { satisfiable: false, blocking_deps };
    }
  }
}

/** Return shape of {@link propagateSkips} — the skip set plus a reason for each newly-added entry. */
export interface PropagateSkipsResult {
  skipped: string[];
  /** Reason detail per skipped step (issue #111). Carries forward `run.skip_details`; grows only. */
  details: Record<string, SkipDetail>;
}

/**
 * After a step settles (completes, fails, or is already skipped), some downstream steps
 * may have trigger_rules that can never be satisfied. This function marks those steps
 * as skipped and iterates until no new skips can be derived (fixed-point).
 *
 * Returns the updated skipped_steps array (which may be larger than run.skipped_steps) plus a
 * `details` map explaining why each step was added (issue #111) — `details` seeds from
 * `run.skip_details` (mirroring how `skipped` seeds from `run.skipped_steps`) and grows only for
 * steps this call itself adds; already-settled steps are skipped via the continue above and never
 * touch `details`. Does not mutate the run record — callers apply the result before writing.
 */
export function propagateSkips(
  run: RunRecord,
  definition: WorkflowDefinition,
): PropagateSkipsResult {
  const skipped = [...run.skipped_steps];
  const details: Record<string, SkipDetail> = { ...run.skip_details };
  let changed = true;

  while (changed) {
    changed = false;
    for (const [stepName, step] of Object.entries(definition.steps)) {
      // Finalizers are held out of the DAG (no depends_on/when) and settle only in the
      // terminal drain — never mark them skipped here (defensive: keep them out of
      // skipped_steps so the seal and deriveRunPhase see only domain-step skips).
      if (step.execution === 'finalizer') continue;

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
      const satisfiability = canTriggerRuleEverBeSatisfied(step, tempRun);
      if (!satisfiability.satisfiable) {
        skipped.push(stepName);
        details[stepName] = {
          kind: 'trigger_rule_unsatisfiable',
          rule: step.trigger_rule ?? 'all_success',
          blocking_deps: satisfiability.blocking_deps ?? [],
        };
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
          // Build the trace once, at the moment the step is pushed to skipped — not per
          // fixed-point iteration.
          const evidenceByStep = buildEvidenceByStep(run);
          details[stepName] = {
            kind: 'when_false',
            expression: Array.isArray(step.when) ? step.when.join(' && ') : step.when,
            leaves: traceWhenCondition(step.when, evidenceByStep, run.params),
          };
          changed = true;
        }
      }
    }
  }

  return { skipped, details };
}
