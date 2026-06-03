// Precondition evaluator — evaluates step precondition expressions against
// the run's collected evidence map before allowing a step to execute.

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
  const match = /^([\w-]+)\.([\w.]+)\s*(>=|<=|!=|>|<|==)\s*(\S.*)$/.exec(expression);
  if (match === null) return false;

  const stepName = match[1]!;
  const fieldPath = match[2]!;
  const op = match[3]!;
  const literalRaw = match[4]!;

  const stepEvidence = evidenceByStep[stepName];
  if (stepEvidence === undefined) return false;

  const lhs = resolvePath(stepEvidence, fieldPath);
  if (lhs === undefined) return false;

  const rhs = parseLiteral(literalRaw);
  return compare(lhs, op, rhs);
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
      // Resolve the LHS value for the failure message.
      const match = /^([\w-]+)\.([\w.]+)/.exec(expression);
      let resolvedValue: unknown = undefined;
      if (match !== null) {
        const stepEvidence = evidenceByStep[match[1]!];
        if (stepEvidence !== undefined) {
          resolvedValue = resolvePath(stepEvidence, match[2]!);
        }
      }
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
    const match = /^([\w-]+)\.([\w.]+)/.exec(expression);
    let resolvedValue: unknown = undefined;
    if (match !== null) {
      const stepEvidence = evidenceByStep[match[1]!];
      if (stepEvidence !== undefined) {
        resolvedValue = resolvePath(stepEvidence, match[2]!);
      }
    }
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
    const operators = ['>=', '<=', '!=', '==', '>', '<'] as const;
    let matched = false;

    for (const op of operators) {
      const opWithSpaces = ` ${op} `;
      const idx = condition.indexOf(opWithSpaces);
      if (idx === -1) continue;

      matched = true;
      const lhsPath = condition.slice(0, idx).trim();
      const rhs = condition.slice(idx + opWithSpaces.length).trim();

      // Resolve LHS.
      const lhsValue = resolvePath(root, lhsPath);
      if (lhsValue === undefined) {
        return { kind: 'resolution_error', condition, unresolvable_path: lhsPath };
      }

      // Parse RHS literal.
      const rhsValue = parseLiteral(rhs);

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
      break;
    }

    if (!matched) {
      // Bare path — truthy/falsy check.
      const path = condition.trim();
      const value = resolvePath(root, path);
      if (value === undefined) {
        return { kind: 'resolution_error', condition, unresolvable_path: path };
      }
      results.push({ condition, resolved_value: value, passed: Boolean(value) });
    }
  }

  const anyFailed = results.some((r) => !r.passed);
  if (anyFailed) {
    return { kind: 'abort', conditions: results };
  }
  return { kind: 'pass', conditions: results };
}
