// model-failure.ts — gap 2, unit (i-a): what a failed model request needs before it can succeed, and
// the closed shape of one failed try on the record.
//
// `classifyModelFailure` files a failure into one of `MODEL_FAILURE_KINDS` from the values it is given,
// and from nothing else: pure, no clock, no I/O, no provider imports (framework §0 rule 9). Its rules
// run in one order, and the first that applies wins. Realm calls it nowhere yet: unit (i-b) does.
//
// `closeModelAttempts` is the write's own closure: an entry passed in `StepMeta.modelAttempts` is
// stored with its eight members only, each a number, a closed word or `null`. A program can pass any
// value there, so the type is not the guarantee; this is.
import type { DriveFailureRecord, ModelAttempt, ModelFailureKind } from '../types/run-record.js';
import { ERROR_CLASSES, EXHAUSTED_BY, MODEL_FAILURE_KINDS } from '../types/run-record.js';

/**
 * The values `classifyModelFailure` reads from one failed model request. A value that is absent,
 * `null` or of another type counts as none (gap 2, unit i-a).
 * @public
 */
export interface ModelFailureFacts {
  /** The failure's class, in a drive-failure entry's words. */
  error_class: DriveFailureRecord['error_class'];
  /** The HTTP status the request got, or none. */
  status?: number | null;
  /** The provider's error type (Anthropic's `error.type`, OpenAI's `error.type`), or none. */
  provider_error_type?: string | null;
  /** The provider's error code (OpenAI's `error.code`), or none. */
  provider_error_code?: string | null;
  /** The value of the answer's `x-should-retry` header, or none. Only `'true'` and `'false'` count. */
  should_retry?: string | null;
  /** Whether the provider named a refusal of the request's workspace. */
  workspace_refusal?: boolean;
  /** Realm's error code on the thrown error (`WorkflowError.code`), or none. */
  realm_code?: string | null;
  /**
   * Where the failure happened: `model_request` (sending a request or waiting for its answer, for
   * every request of the step), `after_response` (an answer arrived and Realm could not use it), or
   * `mcp_discovery` (listing the step's MCP tools, before any model request).
   */
  phase: 'model_request' | 'after_response' | 'mcp_discovery';
}

/** Realm's codes for an MCP tool the step names that the server does not offer, or offers twice. */
const MCP_TOOL_CODES: readonly string[] = ['MCP_TOOL_NOT_FOUND', 'MCP_TOOL_NAME_COLLISION'];

/** The statuses an operator must act on first: the key, payment, a permission, a missing resource. */
const SETUP_STATUSES: readonly number[] = [401, 402, 403, 404];

/**
 * Gap 2 (i-a), Amendment 1: a used-up quota, credit or spend limit, as the providers document it
 * (OpenAI: developers.openai.com/api/docs/guides/error-codes, 429 rows, and "The broader `error.type`
 * can still be `insufficient_quota`"; Anthropic: platform.claude.com/docs/en/api/errors, "402 -
 * `billing_error`"). Another try cannot restore access, so each is `setup`. OpenAI's `slow_down`
 * (type `rate_limit_error`) is not here: it stays a 429, `transient`.
 */
const USED_UP_CODES: readonly string[] = [
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
];
const USED_UP_TYPES: readonly string[] = ['insufficient_quota', 'billing_error'];

/** The statuses another try can fix, besides every 5xx: a request timeout, a conflict, a rate limit. */
const TRANSIENT_STATUSES: readonly number[] = [408, 409, 429];

/** The classes another try can fix: a dropped connection, a timeout, Realm's own cap on the call. */
const TRANSIENT_CLASSES: readonly string[] = [
  'connection_error',
  'connection_timeout',
  'aborted_by_budget',
];

/** The statuses that say this request will fail the same way again. */
const PERMANENT_STATUSES: readonly number[] = [400, 413, 422];

function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Says what a failed model request needs before it can succeed, from the request's own values only.
 * It returns `transient` (another try can fix it), `setup` (an operator must fix something first),
 * `permanent` (it will fail the same way again), or `null` when it cannot place the failure (gap 2,
 * unit i-a). The rules run in this order, and the first that applies wins:
 * 1. Realm code `MCP_TOOL_NOT_FOUND` or `MCP_TOOL_NAME_COLLISION`: `setup`, in any phase.
 * 2. Phase `mcp_discovery`: `null` (not a model call).
 * 3. Phase `after_response`: `permanent`.
 * 4. Class `validation_rejected`: `null` (it stays on the schema-retry path).
 * 5. `x-should-retry: true`: `transient`, at any status.
 * 6. A workspace refusal, 401, 402, 403, 404, class `sdk_missing`, or a used-up quota, credit or spend
 *    limit (OpenAI's codes `insufficient_quota`, `credit_balance_exhausted`,
 *    `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`,
 *    `organization_usage_limit_exceeded`, or the type `insufficient_quota`; Anthropic's type
 *    `billing_error`): `setup`.
 * 7. `x-should-retry: false`: `permanent`, at any status.
 * 8. 408, 409, 429 or 5xx, or class `connection_error`, `connection_timeout` or `aborted_by_budget`:
 *    `transient`.
 * 9. 400, 413 or 422: `permanent`.
 * 10. Anything else: `null`.
 * A phase outside the three is not placed (`null`).
 * @public
 */
export function classifyModelFailure(facts: ModelFailureFacts): ModelFailureKind | null {
  const realmCode = textOf(facts.realm_code);
  // 1. Rule 1 comes before the phase rules: an MCP tool refusal names a setup fault wherever it shows.
  if (realmCode !== null && MCP_TOOL_CODES.includes(realmCode)) return 'setup';
  // 2.
  if (facts.phase === 'mcp_discovery') return null;
  // 3. An answer arrived and could not be used: sending it again gets the same kind of answer.
  if (facts.phase === 'after_response') return 'permanent';
  if (facts.phase !== 'model_request') return null;
  // 4.
  if (facts.error_class === 'validation_rejected') return null;
  const shouldRetry = textOf(facts.should_retry);
  // 5. The provider's own word first, as the SDKs obey it (CR-G2RC-27).
  if (shouldRetry === 'true') return 'transient';
  const status = Number.isInteger(facts.status) ? (facts.status as number) : null;
  const type = textOf(facts.provider_error_type);
  const code = textOf(facts.provider_error_code);
  // 6. Before rule 7, so a setup fault the provider also marks "do not retry" is still named setup.
  if (
    facts.workspace_refusal === true ||
    (status !== null && SETUP_STATUSES.includes(status)) ||
    facts.error_class === 'sdk_missing' ||
    (code !== null && USED_UP_CODES.includes(code)) ||
    (type !== null && USED_UP_TYPES.includes(type))
  ) {
    return 'setup';
  }
  // 7.
  if (shouldRetry === 'false') return 'permanent';
  // 8.
  if (
    status !== null &&
    (TRANSIENT_STATUSES.includes(status) || (status >= 500 && status <= 599))
  ) {
    return 'transient';
  }
  if (TRANSIENT_CLASSES.includes(facts.error_class)) return 'transient';
  // 9.
  if (status !== null && PERMANENT_STATUSES.includes(status)) return 'permanent';
  // 10.
  return null;
}

/** `then`'s words: where a re-send answered a try. */
const MODEL_ATTEMPT_THEN = [
  'gateway',
  'cache_probe',
  'strict_ladder',
] as const satisfies readonly NonNullable<ModelAttempt['then']>[];
type MissingThen = Exclude<NonNullable<ModelAttempt['then']>, (typeof MODEL_ATTEMPT_THEN)[number]>;
const _everyThenListed: [MissingThen] extends [never] ? true : MissingThen = true;
void _everyThenListed;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function wordOf<W extends string>(words: readonly W[], value: unknown): W | undefined {
  return typeof value === 'string' && (words as readonly string[]).includes(value)
    ? (value as W)
    : undefined;
}

/**
 * Gap 2, unit (i-a): the closed `model_attempts` of a value a program passed in
 * `StepMeta.modelAttempts`, or `undefined` when it is not a list (then nothing is written). Each
 * entry keeps its eight members only: a word outside its set becomes `null` (`kind`, `error_class`)
 * or is left out (`exhausted_by`, `then`); a `status`, `wait_ms` or `retry_after_ms` that is not a
 * whole number of 0 or more becomes `null`; an entry whose `request` is not one is dropped, and so is
 * every other key.
 */
export function closeModelAttempts(value: unknown): ModelAttempt[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const closed: ModelAttempt[] = [];
  for (const raw of value as unknown[]) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (!isCount(entry['request'])) continue;
    const exhaustedBy = wordOf(EXHAUSTED_BY, entry['exhausted_by']);
    const then = wordOf(MODEL_ATTEMPT_THEN, entry['then']);
    closed.push({
      request: entry['request'],
      kind: wordOf(MODEL_FAILURE_KINDS, entry['kind']) ?? null,
      error_class: wordOf(ERROR_CLASSES, entry['error_class']) ?? null,
      status: isCount(entry['status']) ? entry['status'] : null,
      wait_ms: isCount(entry['wait_ms']) ? entry['wait_ms'] : null,
      retry_after_ms: isCount(entry['retry_after_ms']) ? entry['retry_after_ms'] : null,
      ...(exhaustedBy !== undefined ? { exhausted_by: exhaustedBy } : {}),
      ...(then !== undefined ? { then } : {}),
    });
  }
  return closed;
}
