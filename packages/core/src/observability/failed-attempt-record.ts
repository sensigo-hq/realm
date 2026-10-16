// Pure, I/O-free builder + serializer for failed agent-step validation telemetry.
//
// When an agent's execute_step output fails pre-claim schema validation, the engine returns an
// error envelope on a WRITE-FREE path (nothing persisted, nothing logged). These helpers turn that
// ephemeral rejection into a structured, METADATA-ONLY record for stderr emission (P2) and a durable
// sidecar (P3, which reuses this exact builder/serializer).
//
// PII guard: the record never contains raw model output values — only Ajv error metadata (whitelisted
// fields, with offending-value echoes dropped), submitted key NAMES (capped), counts, and byte size.
//
// Determinism: no Date.now()/Math.random()/I/O here — the timestamp is supplied by the caller — so
// these functions are deterministic and unit-testable.
import {
  VALIDATION_PROBLEMS_SHOWN,
  whitelistValidationRow,
} from '../validation/validation-problems.js';

/** Input to {@link buildFailedAttemptRecord}. */
export interface BuildFailedAttemptInput {
  run_id: string;
  workflow_id: string;
  step_id: string;
  /** ISO timestamp; supplied by the caller (e.g. `new Date().toISOString()`). */
  ts: string;
  /** One of the three VALIDATION_* error codes. */
  error_code: string;
  /** The raw `error_details.errors` array (may be anything — coerced defensively). */
  ajv_errors: unknown[];
  /**
   * issue #759: the TOTAL number of problems the validator found, as the refusal carried it
   * (`error_count`) — never recounted from `ajv_errors`, which is already capped. Absent when the
   * caller has none.
   */
  error_count?: number;
  /** The agent's submitted output (`args.params`). */
  params: Record<string, unknown>;
  /** `args.trace?.length ?? 0`. */
  trace_entry_count: number;
}

/** A single whitelisted Ajv error — value echoes (`params`/`data`) are intentionally excluded. */
export interface ValidationErrorSummaryEntry {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
  /**
   * issue #217: present ONLY for `additionalProperties` keyword errors — the offending key NAME
   * from `params.additionalProperty` (never a value). Truncated to MAX_FIELD_CHARS like every
   * other field here.
   */
  additional_property?: string;
  /**
   * issue #217: present ONLY for `required` keyword errors — the missing key NAME (schema-
   * derived, from `params.missingProperty`; never a submitted value). Truncated to
   * MAX_FIELD_CHARS like every other field here.
   */
  missing_property?: string;
}

/** Metadata-only record describing a failed agent-step validation attempt. */
export interface FailedAttemptRecord {
  run_id: string;
  workflow_id: string;
  step_id: string;
  ts: string;
  error_code: string;
  validation_error_summary: ValidationErrorSummaryEntry[];
  submitted_key_count: number;
  submitted_keys: string[];
  submitted_bytes: number;
  trace_entry_count: number;
  /**
   * issue #759: the TOTAL number of problems before the cap — so a reader says how many more there
   * were than the entries it holds (`error_count − validation_error_summary.length`, as read).
   * Absent on records written before #759 and when the writer had no count.
   */
  error_count?: number;
  /**
   * The serializer reduced this record to fit its line (`serializeFailedAttemptLine`): entries were
   * dropped from the END of `validation_error_summary`. Persisted by the MCP sidecar writer since
   * P3; declared by #759, whose floor rule reads it.
   */
  truncated?: true;
}

const MAX_KEYS = 50;
const MAX_KEY_CHARS = 100;
const DEFAULT_MAX_BYTES = 3072;

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Byte length of a string, guarded so it never throws. */
function byteLength(value: string): number {
  try {
    return Buffer.byteLength(value, 'utf8');
  } catch {
    return value.length;
  }
}

/** JSON.stringify guarded against circular refs / throwers; returns '{}' on failure. */
function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s : '{}';
  } catch {
    return '{}';
  }
}

/**
 * Map raw Ajv errors to the whitelisted summary. Drops `params`/`data` WHOLESALE — Ajv's `data`
 * echoes the SUBMITTED value (the genuine leak vector: it can carry arbitrary caller/model
 * content) EXCEPT for two keyword-conditional KEY-NAME-ONLY fields (issue #217) that carry no
 * value: `additional_property` (from `params.additionalProperty` on an `additionalProperties`
 * error) and `missing_property` (from `params.missingProperty` on a `required` error) — both
 * gated on keyword AND a string-typed params field, so no other keyword's `params` is ever
 * touched. issue #224 correction: a prior version of this comment mis-framed `params.allowedValues`
 * (the `enum` keyword's own value) as a leak vector alongside `data` — it is NOT: `allowedValues`
 * is a SCHEMA constant (author-controlled, already present in the system prompt the model was
 * given), never submitted/user data, so dropping it here is conservative-but-unnecessary rather
 * than a leak fix. This distinction is why the LINES the providers' correction trailer renders may
 * carry `allowedValues` (issue #759: the one whitelist, `whitelistValidationRow`, keeps them; this
 * record drops them). Skips non-object entries, caps at `VALIDATION_PROBLEMS_SHOWN`, truncates
 * path/message/the two new fields to 200 chars. Never throws.
 */
function summarizeAjvErrors(ajvErrors: unknown[]): ValidationErrorSummaryEntry[] {
  if (!Array.isArray(ajvErrors)) return [];
  const out: ValidationErrorSummaryEntry[] = [];
  for (const entry of ajvErrors) {
    if (out.length >= VALIDATION_PROBLEMS_SHOWN) break;
    // issue #759: the ONE whitelist (validation-problems.ts) — the record keeps every field of it
    // but the schema's allowed values (#217/#224's choice: a record carries no values).
    const row = whitelistValidationRow(entry);
    if (row === undefined) continue;
    const { allowedValues: _allowedValues, ...kept } = row;
    out.push(kept);
  }
  return out;
}

/**
 * issue #759 (r1.5): how many problems a record holds BEYOND its listed entries, AS READ —
 * `error_count − validation_error_summary.length` (the serializer pops entries from the end, so a
 * trimmed record says `and 10 more` for 3 entries of 13, never `− 10`). A record with no
 * `error_count` (written before #759) is exact only when it holds fewer than
 * `VALIDATION_PROBLEMS_SHOWN` entries and was not trimmed (`0` more); otherwise it cannot say, and
 * this returns `undefined` — a reader renders a FLOOR (`≥<entries>`, the `≥N×` convention of
 * `realm run list`), never an invented "and N more".
 */
export function moreOf(
  record: Pick<FailedAttemptRecord, 'validation_error_summary' | 'error_count' | 'truncated'>,
): number | undefined {
  const listed = Array.isArray(record.validation_error_summary)
    ? record.validation_error_summary.length
    : 0;
  if (typeof record.error_count === 'number') return Math.max(0, record.error_count - listed);
  return listed < VALIDATION_PROBLEMS_SHOWN && record.truncated !== true ? 0 : undefined;
}

/**
 * Build a metadata-only {@link FailedAttemptRecord}. Pure and deterministic — no timestamps or I/O
 * generated here. Never throws on malformed input.
 */
export function buildFailedAttemptRecord(input: BuildFailedAttemptInput): FailedAttemptRecord {
  const params = input.params !== null && typeof input.params === 'object' ? input.params : {};
  const allKeys = Object.keys(params);

  let submittedBytes = 0;
  try {
    const s = JSON.stringify(params);
    if (typeof s === 'string') submittedBytes = byteLength(s);
  } catch {
    submittedBytes = 0;
  }

  return {
    run_id: input.run_id,
    workflow_id: input.workflow_id,
    step_id: input.step_id,
    ts: input.ts,
    error_code: input.error_code,
    validation_error_summary: summarizeAjvErrors(input.ajv_errors),
    submitted_key_count: allKeys.length,
    submitted_keys: allKeys.slice(0, MAX_KEYS).map((k) => truncate(k, MAX_KEY_CHARS)),
    submitted_bytes: submittedBytes,
    trace_entry_count: typeof input.trace_entry_count === 'number' ? input.trace_entry_count : 0,
    // issue #759: the total as the caller carried it — never recounted here.
    ...(typeof input.error_count === 'number' ? { error_count: input.error_count } : {}),
  };
}

/** Byte-safe truncation: returns the longest prefix of `value` whose UTF-8 length is ≤ maxBytes. */
function byteTruncate(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(value.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return value.slice(0, lo);
}

/**
 * Serialize a failed-attempt record (optionally wrapped with extra keys like `event`) to a single
 * JSON line guaranteed to be ≤ `maxBytes`. When the serialized form (plus a 1-byte newline budget)
 * exceeds the limit, reduce progressively and set `truncated: true`:
 *   1. drop `validation_error_summary` entries from the end (down to empty);
 *   2. if still over, replace `submitted_keys` with `[]` (keeping `submitted_key_count`);
 *   3. if still over, hard byte-truncate the JSON string to `maxBytes` as a final guarantee.
 * Wrapper keys (e.g. `event`, `dropped_attempts`) are preserved; only the known record fields are
 * reduced. The returned `line` is ALWAYS ≤ `maxBytes` (verified on the serialized string).
 *
 * This is the single source of truth for line size — P3's atomic append reuses it verbatim (where
 * ≤PIPE_BUF matters for lock-free atomicity).
 */
export function serializeFailedAttemptLine(
  obj: Record<string, unknown>,
  maxBytes: number = DEFAULT_MAX_BYTES,
): { line: string; truncated: boolean } {
  // Fits if the serialized bytes plus a 1-byte newline budget stay within the limit.
  const fits = (s: string): boolean => byteLength(s) + 1 <= maxBytes;

  let line = safeStringify(obj);
  if (fits(line)) return { line, truncated: false };

  let work: Record<string, unknown> = { ...obj };

  // Step 1: drop validation_error_summary entries from the end.
  if (Array.isArray(work['validation_error_summary'])) {
    const arr = [...(work['validation_error_summary'] as unknown[])];
    while (arr.length > 0 && !fits(safeStringify({ ...work, validation_error_summary: arr }))) {
      arr.pop();
    }
    work = { ...work, validation_error_summary: arr };
    line = safeStringify(work);
    if (fits(line)) return { line, truncated: true };
  }

  // Step 2: drop submitted_keys (keep submitted_key_count).
  if ('submitted_keys' in work) {
    work = { ...work, submitted_keys: [] };
    line = safeStringify(work);
    if (fits(line)) return { line, truncated: true };
  }

  // Step 3: hard byte-truncate as a final guarantee.
  line = byteTruncate(line, maxBytes);
  return { line, truncated: true };
}
