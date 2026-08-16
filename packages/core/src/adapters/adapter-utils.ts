import { scrubEmail, capText } from '../utils/redaction.js';
import { WorkflowError } from '../types/workflow-error.js';

/**
 * Bounds and redacts an adapter error body before it is attached to a WorkflowError's
 * `details` (which surfaces in the user-facing envelope as error_details). Caps length and
 * scrubs email addresses — the realistic PII an API error body echoes back from a request.
 */
export function redactErrorBody(body: unknown): string {
  let text: string;
  if (typeof body === 'string') {
    text = body;
  } else {
    try {
      text = JSON.stringify(body);
    } catch {
      text = String(body);
    }
  }
  return scrubEmail(capText(text));
}

/**
 * Parses the Retry-After HTTP header value into a delay in seconds.
 * Handles both integer-seconds form (e.g. "30") and HTTP-date form
 * (e.g. "Sat, 31 May 2026 12:00:00 GMT").
 *
 * Known limitation: clock skew between client and server is not corrected.
 * Math.max(0, ...) prevents negative values when the date is in the past.
 *
 * @param raw  The raw header value from response.headers.get('Retry-After').
 * @param fallback  Conservative default to use when the header is absent or unparseable.
 */
export function parseRetryAfterHeader(raw: string | null, fallback: number): number;
export function parseRetryAfterHeader(raw: string | null, fallback?: undefined): number | undefined;
export function parseRetryAfterHeader(raw: string | null, fallback?: number): number | undefined {
  if (raw !== null) {
    // Integer-seconds form (e.g. "30"). parseInt handles potential decimal inputs
    // from non-conformant servers (e.g. "30.5" → 30).
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return Math.max(0, n);
    // HTTP-date form (e.g. "Sat, 31 May 2026 12:00:00 GMT").
    // Known limitation: clock skew between client and server is not corrected.
    // Math.max(0, ...) prevents negative values when the date is in the past.
    const date = new Date(raw);
    if (Number.isFinite(date.getTime())) {
      return Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
    }
  }
  return fallback;
}

/**
 * Issue #287 — reads one scalar param, failing LOUDLY when it is present but mistyped.
 *
 * Generalizes the gorgias A6 discipline (which already shipped these exact semantics for its
 * list params) to every adapter, because the alternative was worse than "unvalidated": ten sites
 * type-guarded a param and SILENTLY OMITTED it when the guard failed, so a structurally broken
 * value degraded into "the caller didn't pass this". For a filter param that means a query runs
 * UNFILTERED and looks successful — the shape that corrupted 907 records over five weeks before
 * anyone noticed.
 *
 * Semantics, in the order they matter:
 * - missing, `null`, or `undefined` ⇒ `undefined` ("not set"). This arm must NEVER throw:
 *   unresolved optional input_map paths arrive as present-`undefined` as a matter of routine, and
 *   `$literal: null` is legal. A nullish-throwing helper would break working workflows.
 * - present with the expected type ⇒ the typed value.
 * - present, non-nullish, wrong type ⇒ throws. The message follows the compiler grammar (param,
 *   expected, found) with adapter/operation provenance, and deliberately carries NO did-you-mean:
 *   suggestions are the canon for name confusion, and a type error already names both types.
 */
export function takeParam(
  params: Record<string, unknown>,
  key: string,
  expected: 'string',
  ctx: { adapter: string; operation: string },
): string | undefined;
export function takeParam(
  params: Record<string, unknown>,
  key: string,
  expected: 'number',
  ctx: { adapter: string; operation: string },
): number | undefined;
export function takeParam(
  params: Record<string, unknown>,
  key: string,
  expected: 'boolean',
  ctx: { adapter: string; operation: string },
): boolean | undefined;
export function takeParam(
  params: Record<string, unknown>,
  key: string,
  expected: 'string' | 'number' | 'boolean',
  ctx: { adapter: string; operation: string },
): string | number | boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === expected) return value as string | number | boolean;
  const found = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  throw new WorkflowError(
    `adapter '${ctx.adapter}' operation '${ctx.operation}': param '${key}' — expected ${expected}, found ${found}`,
    {
      code: 'ADAPTER_VALIDATION_FAILED',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { adapter: ctx.adapter, operation: ctx.operation, param: key, expected, found },
    },
  );
}
