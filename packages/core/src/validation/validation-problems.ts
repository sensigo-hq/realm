// validation-problems.ts — issue #759: a refused answer names EVERY problem, not only the first.
//
// ONE list (the validator's rows, Ajv's own order — never re-sorted, never de-duplicated), ONE cap
// (`VALIDATION_PROBLEMS_SHOWN`), ONE count (counted once at the validator and carried — never
// recounted by a renderer, r1.10), and TWO renderings of that list: the SENTENCE (a refusal's
// `message` / `refusal`) and the LINES (the repair prompt, the providers' trailer, `realm run
// attempts`). Pure: no I/O, no clock (R19).
//
// C42 — the redaction rule: every rendered word comes from a whitelisted field of a row —
// `keyword`, `instancePath`, `schemaPath` (the SCHEMA's pointer), `message`,
// `params.missingProperty`, `params.additionalProperty`, `params.allowedValues` (`enum`) and
// `params.allowedValue` (`const`, singular) — never `data`, never `schema`, never `parentSchema`,
// never another `params` member. Allowed values are the SCHEMA's (the author's), and only the LINES
// carry them (r1.4); the sentence never does.
import type { ErrorObject } from 'ajv';
import type { ValidationErrorSummaryEntry } from '../observability/failed-attempt-record.js';
import type { EngineReply } from '../types/response-envelope.js';
import type { ValidationErrorFacts, WorkflowError } from '../types/workflow-error.js';

/**
 * How many problems a refusal shows (#759) — the failed-attempt sidecar's entry cap since #217.
 * The field caps nothing and states no number (D4), so the one existing cap is kept: past it, a
 * refusal says how many more there are.
 */
export const VALIDATION_PROBLEMS_SHOWN = 10;

/** A whitelisted field is cut to this many characters (the sidecar's rule since #217). */
const MAX_FIELD_CHARS = 200;

/** The keywords that only wrap other rules (r1.1): a row of theirs is skipped when a rule's own row
 *  stands at the same path, and is a problem in its own words otherwise. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'anyOf',
  'oneOf',
  'allOf',
  'if',
  'then',
  'else',
  'not',
]);

/** One problem: the row's whitelisted fields, the schema's allowed values (LINES only), and the
 *  row's words in the site's dialect. */
export type ValidationProblem = ValidationErrorSummaryEntry & {
  allowedValues?: readonly unknown[];
  clause: string;
};

/** The composer's result: the problems shown (at most the cap), and the true total. */
export interface ValidationProblems {
  problems: ValidationProblem[];
  shown: number;
  total: number;
  more: number;
}

/**
 * The field words of a refusal's site (r1.2): `c37` — the words of a refused step answer
 * (`'<a.b>' <message>`, `the input <message>` at the root, `'<a.b>.<extra>' is not allowed`);
 * `pointer` — the words of a refused run's params (`(root) <message>` / `<instancePath> <message>`).
 */
export type FieldWords = 'c37' | 'pointer';

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function cut(value: string): string {
  return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
}

/**
 * The whitelist (C42), applied to one row: `undefined` for a row that is not an object. The sidecar's
 * record keeps every field but `allowedValues` (#217/#224's choice: a record carries no values).
 */
export function whitelistValidationRow(
  row: unknown,
): (ValidationErrorSummaryEntry & { allowedValues?: readonly unknown[] }) | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const e = row as Record<string, unknown>;
  const keyword = cut(asString(e['keyword']));
  const params =
    e['params'] !== null && typeof e['params'] === 'object'
      ? (e['params'] as Record<string, unknown>)
      : undefined;
  const additionalProperty =
    keyword === 'additionalProperties' && typeof params?.['additionalProperty'] === 'string'
      ? params['additionalProperty']
      : undefined;
  const missingProperty =
    keyword === 'required' && typeof params?.['missingProperty'] === 'string'
      ? params['missingProperty']
      : undefined;
  // `enum` → `params.allowedValues`; `const` → `params.allowedValue` (singular), as one value.
  const allowedValues =
    keyword === 'enum' && Array.isArray(params?.['allowedValues'])
      ? (params['allowedValues'] as unknown[])
      : keyword === 'const' && params !== undefined && 'allowedValue' in params
        ? [params['allowedValue']]
        : undefined;
  return {
    instancePath: cut(asString(e['instancePath'])),
    schemaPath: cut(asString(e['schemaPath'])),
    keyword,
    message: cut(asString(e['message'])),
    ...(additionalProperty !== undefined ? { additional_property: cut(additionalProperty) } : {}),
    ...(missingProperty !== undefined ? { missing_property: cut(missingProperty) } : {}),
    ...(allowedValues !== undefined ? { allowedValues } : {}),
  };
}

/** A row's words in the site's dialect, from its whitelisted fields only (C42). */
function clauseOf(row: Record<string, unknown>, fieldWords: FieldWords): string {
  const path = asString(row['instancePath']);
  const message = asString(row['message']);
  if (fieldWords === 'pointer') return `${path === '' ? '(root)' : path} ${message}`;
  const segments = path === '' ? [] : path.slice(1).split('/');
  const params =
    row['params'] !== null && typeof row['params'] === 'object'
      ? (row['params'] as Record<string, unknown>)
      : undefined;
  const extra = params?.['additionalProperty'];
  if (row['keyword'] === 'additionalProperties' && typeof extra === 'string') {
    return `'${[...segments, extra].join('.')}' is not allowed`;
  }
  const field = segments.length === 0 ? 'the input' : `'${segments.join('.')}'`;
  return `${field} ${message}`;
}

/**
 * The problems a refusal names (#759), from the validator's rows: in Ajv's own order (no re-sort,
 * no de-duplication — r1.10), the whitelist applied once per row, each row's words in the site's
 * dialect. A row with no message names nothing (as before #759). A wrapper row (`anyOf`, `oneOf`,
 * `allOf`, `if`, `then`, `else`, `not`) is skipped ONLY when a rule's own row stands at the same path
 * (an `anyOf` cascade); alone, it is a problem in its own words (r1.1). `total` is the post-skip
 * count; when `rows` is a capped prefix, `errorCount` — the count the validator carried — adds the
 * rows past the cap (never recounted here).
 */
export function describeValidationProblems(
  rows: readonly unknown[],
  fieldWords: FieldWords,
  errorCount?: number,
): ValidationProblems {
  const usable = rows.filter(
    (r): r is Record<string, unknown> =>
      r !== null &&
      typeof r === 'object' &&
      typeof (r as Record<string, unknown>)['message'] === 'string',
  );
  const ruleAt = new Set(
    usable
      .filter((r) => !WRAPPERS.has(asString(r['keyword'])))
      .map((r) => asString(r['instancePath'])),
  );
  const kept = usable.filter(
    (r) => !(WRAPPERS.has(asString(r['keyword'])) && ruleAt.has(asString(r['instancePath']))),
  );
  const pastCap = errorCount !== undefined ? Math.max(0, errorCount - rows.length) : 0;
  const total = kept.length + pastCap;
  const shown = Math.min(kept.length, VALIDATION_PROBLEMS_SHOWN);
  const problems = kept.slice(0, shown).map((row) => ({
    ...whitelistValidationRow(row)!,
    clause: clauseOf(row, fieldWords),
  }));
  return { problems, shown, total, more: total - shown };
}

/** The remainder phrase (#759; #760's `check_quotes` warning imports it): `and N more`, or `''`. */
export function renderMore(total: number, shown: number): string {
  return total <= shown ? '' : `and ${total - shown} more`;
}

/**
 * The SENTENCE: the problems' clauses joined by `; `, then `; and N more` when there are more (no
 * count otherwise). Empty when no row named a problem — the caller keeps its own message alone.
 */
export function renderProblemsSentence(result: ValidationProblems): string {
  if (result.shown === 0) return '';
  const clauses = result.problems.map((p) => p.clause).join('; ');
  const more = renderMore(result.total, result.shown);
  return more === '' ? clauses : `${clauses}; ${more}`;
}

/**
 * The LINES: one per entry (`- <path>: <message> [<keyword>]`, then the key named for an extra or a
 * missing property, then the schema's allowed values when the entry has them), then `and N more`
 * when `more > 0`. Takes the composer's problems (raw rows: allowed values present — the providers'
 * trailer) or a record's `validation_error_summary` (no values — the repair prompt, `attempts`),
 * with `more` read from the same list's carried count.
 */
export function renderProblemsLines(
  entries: readonly (ValidationErrorSummaryEntry & { allowedValues?: readonly unknown[] })[],
  more: number,
): string[] {
  const lines = entries.map((entry) => {
    const path = entry.instancePath !== '' ? entry.instancePath : '(root)';
    let line = `- ${path}: ${entry.message} [${entry.keyword}]`;
    if (entry.additional_property !== undefined) {
      line += ` (additional property: '${entry.additional_property}')`;
    }
    if (entry.missing_property !== undefined) {
      line += ` (missing property: '${entry.missing_property}')`;
    }
    if (entry.allowedValues !== undefined) {
      line += ` (allowed values: ${JSON.stringify(entry.allowedValues)})`;
    }
    return line;
  });
  const tail = renderMore(entries.length + Math.max(0, more), entries.length);
  return tail === '' ? lines : [...lines, tail];
}

/**
 * A validation refusal's typed facts (#759, Amendment 11) — the rows (capped) and their total — for
 * the two codes that carry them; `undefined` for any other error. The ONE reader of the error's own
 * list (Part D.4): every site that read `details['errors']` reads it here.
 */
export function validationFactsOfError(err: WorkflowError): ValidationErrorFacts | undefined {
  if (err.code !== 'VALIDATION_INPUT_SCHEMA' && err.code !== 'VALIDATION_OUTPUT_SCHEMA') {
    return undefined;
  }
  return err.facts as ValidationErrorFacts | undefined;
}

/**
 * The core-side reader of a validation refusal's list (#759, Part D) — the equivalent of the MCP
 * wire's one carrier: the typed facts of `VALIDATION_INPUT_SCHEMA` / `VALIDATION_OUTPUT_SCHEMA`
 * (`error.facts`), the untyped bag of `VALIDATION_EXHAUSTED` (`last_ajv_errors`, `last_error_count`)
 * and of `VALIDATION_TRACE_SCHEMA` (`errors`, `error_count`); `undefined` for any other reply.
 */
export function validationListOf(
  reply: Pick<EngineReply, 'error_code' | 'error' | 'error_details'>,
): { errors: readonly unknown[]; error_count?: number } | undefined {
  const count = (value: unknown): { error_count?: number } =>
    typeof value === 'number' ? { error_count: value } : {};
  switch (reply.error_code) {
    case 'VALIDATION_INPUT_SCHEMA':
    case 'VALIDATION_OUTPUT_SCHEMA': {
      const facts = reply.error?.facts as { errors?: unknown; error_count?: unknown } | undefined;
      if (facts === undefined || !Array.isArray(facts.errors)) return undefined;
      return { errors: facts.errors as readonly ErrorObject[], ...count(facts.error_count) };
    }
    case 'VALIDATION_EXHAUSTED': {
      const errors = reply.error_details?.['last_ajv_errors'];
      if (!Array.isArray(errors)) return undefined;
      return { errors, ...count(reply.error_details?.['last_error_count']) };
    }
    case 'VALIDATION_TRACE_SCHEMA': {
      const errors = reply.error_details?.['errors'];
      if (!Array.isArray(errors)) return undefined;
      return { errors, ...count(reply.error_details?.['error_count']) };
    }
    default:
      return undefined;
  }
}
