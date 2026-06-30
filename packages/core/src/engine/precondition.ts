// Precondition evaluator — evaluates step precondition expressions against
// the run's collected evidence map before allowing a step to execute.
import { splitComparison } from './comparison-expr.js';

/**
 * Resolves a dot-separated path into a nested object.
 * Returns `undefined` if any segment is missing.
 */
function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Parses a literal string into a typed value.
 * Handles numbers, booleans, and strings (strips surrounding quotes).
 */
function parseLiteral(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const num = Number(trimmed);
  if (!Number.isNaN(num) && trimmed !== '') return num;
  // Strip surrounding single or double quotes.
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Compares lhs to rhs using the given operator. Returns false if types are incompatible. */
function compare(lhs: unknown, op: string, rhs: unknown): boolean {
  switch (op) {
    case '==':
      return lhs === rhs;
    case '!=':
      return lhs !== rhs;
    case '>':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs > rhs;
    case '<':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs < rhs;
    case '>=':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs >= rhs;
    case '<=':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs <= rhs;
    default:
      return false;
  }
}

/**
 * Evaluates a precondition expression against collected step outputs.
 *
 * Syntax: "<step_name>.<field_path> <op> <literal>"
 *   step_name  — name of a previously executed step
 *   field_path — dot-separated path into that step's output_summary
 *                (e.g. result.accepted_count)
 *   op         — one of: > < >= <= == !=
 *   literal    — number, true, false, or a string (quoted or unquoted)
 *
 * Example: "validate_candidates.result.accepted_count > 0"
 */
export function evaluatePrecondition(
  expression: string,
  evidenceByStep: Record<string, Record<string, unknown>>,
): boolean {
  // Split via the shared quote-aware splitter (same split used at load) — see comparison-expr.ts.
  // A precondition is a comparison only; a bare path / compound / malformed leaf → false (the old
  // regex's no-match behavior). Absent LHS → false. Coercion is unchanged (compare/parseLiteral).
  const split = splitComparison(expression);
  if (split.kind !== 'comparison') return false;

  // resolvePath(evidenceByStep, "step.field") walks the dotted path — equivalent to the old
  // two-step (evidenceByStep[step] then resolvePath of the field path).
  const lhs = resolvePath(evidenceByStep, split.lhsPath);
  if (lhs === undefined) return false;

  const rhs = parseLiteral(split.rhsRaw);
  return compare(lhs, split.op, rhs);
}

export interface PreconditionResult {
  expression: string;
  passed: boolean;
  /** LHS value as resolved from evidence, or undefined if not resolved. */
  resolved_value: unknown;
}

/**
 * Evaluates all preconditions in order. Returns the first failure, or null if all pass.
 */
export function checkPreconditions(
  preconditions: string[],
  evidenceByStep: Record<string, Record<string, unknown>>,
): PreconditionResult | null {
  for (const expression of preconditions) {
    const passed = evaluatePrecondition(expression, evidenceByStep);
    if (!passed) {
      // Resolve the LHS value for the failure message (shared splitter — see comparison-expr.ts).
      const split = splitComparison(expression);
      const resolvedValue: unknown =
        split.kind === 'comparison' ? resolvePath(evidenceByStep, split.lhsPath) : undefined;
      return { expression, passed: false, resolved_value: resolvedValue };
    }
  }
  return null;
}

/**
 * Evaluates all preconditions and returns results for every expression.
 * Unlike checkPreconditions, does not stop at the first failure.
 * Used to build precondition_trace for StepDiagnostics.
 */
export function evaluateAllPreconditions(
  preconditions: string[],
  evidenceByStep: Record<string, Record<string, unknown>>,
): PreconditionResult[] {
  return preconditions.map((expression) => {
    const passed = evaluatePrecondition(expression, evidenceByStep);
    const split = splitComparison(expression);
    const resolvedValue: unknown =
      split.kind === 'comparison' ? resolvePath(evidenceByStep, split.lhsPath) : undefined;
    return { expression, passed, resolved_value: resolvedValue };
  });
}

// ---------------------------------------------------------------------------
// Guard condition evaluator
// ---------------------------------------------------------------------------

export interface GuardConditionResult {
  condition: string;
  resolved_value: unknown;
  passed: boolean;
}

export type GuardEvaluationOutcome =
  | { kind: 'pass'; conditions: GuardConditionResult[] }
  | { kind: 'abort'; conditions: GuardConditionResult[] }
  | { kind: 'resolution_error'; condition: string; unresolvable_path: string };

/**
 * Evaluates all abort_unless conditions against prior step evidence.
 *
 * All conditions are evaluated before deciding — no short-circuit on first failure.
 * This ensures the evidence record is complete regardless of outcome.
 *
 * Returns:
 * - { kind: 'pass' }  — all conditions true; run continues
 * - { kind: 'abort' } — one or more conditions false; run aborts
 * - { kind: 'resolution_error' } — a path could not be resolved; run fails (not aborted)
 *
 * Resolution errors (absent path) always cause run_phase: 'failed', not 'aborted'.
 * Type mismatches on comparison operators (e.g. > applied to a non-number) also cause
 * resolution_error, not abort.
 */
export function evaluateGuardConditions(
  conditions: string[],
  evidenceByStep: Record<string, Record<string, unknown>>,
): GuardEvaluationOutcome {
  const root = evidenceByStep as Record<string, unknown>;
  const results: GuardConditionResult[] = [];

  for (const condition of conditions) {
    // Split via the shared quote-aware splitter (same split used at load) — see comparison-expr.ts.
    // Absent-policy and type-coercion are UNCHANGED from the original indexOf-scan: an unresolved
    // LHS or a non-numeric relational comparison is a resolution_error; a bare path is a truthy test.
    const split = splitComparison(condition);

    if (split.kind === 'comparison') {
      const { lhsPath, op, rhsRaw } = split;

      const lhsValue = resolvePath(root, lhsPath);
      if (lhsValue === undefined) {
        return { kind: 'resolution_error', condition, unresolvable_path: lhsPath };
      }

      const rhsValue = parseLiteral(rhsRaw);

      // Numeric operators require both sides to be numbers.
      if (
        op !== '==' &&
        op !== '!=' &&
        (typeof lhsValue !== 'number' || typeof rhsValue !== 'number')
      ) {
        return { kind: 'resolution_error', condition, unresolvable_path: lhsPath };
      }

      const passed = compare(lhsValue, op, rhsValue);
      results.push({ condition, resolved_value: lhsValue, passed });
    } else if (split.kind === 'path') {
      // Bare path — truthy/falsy check.
      const value = resolvePath(root, split.path);
      if (value === undefined) {
        return { kind: 'resolution_error', condition, unresolvable_path: split.path };
      }
      results.push({ condition, resolved_value: value, passed: Boolean(value) });
    } else {
      // Compound/malformed leaf is rejected at load; if one reaches runtime, treat as unresolvable.
      return { kind: 'resolution_error', condition, unresolvable_path: condition };
    }
  }

  const anyFailed = results.some((r) => !r.passed);
  if (anyFailed) {
    return { kind: 'abort', conditions: results };
  }
  return { kind: 'pass', conditions: results };
}
