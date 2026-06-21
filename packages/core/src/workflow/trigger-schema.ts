// Declarative trigger-block validation (minimal, Gorgias-anchored).
//
// The webhook `trigger:` block is validated against a single small JSON Schema (draft-07) using the
// same Ajv pattern the loader already uses for params_schema and adapter config_schema. The surface
// is intentionally small: `auth` carries a verification *mode* (shared_secret | github | stripe |
// hmac | none), an optional `filter`, optional `dedup`, and `params_map`.
//
// Patterns carried over from the earlier (closed) rich design: per-mode CLOSED sets (each mode's
// `then` has its own additionalProperties:false + properties + required, with property stubs on the
// combinators so the schema is `strictRequired`-clean under Ajv strict:true), the `formatAjvErrors`
// wrapper-noise pruning, and the `normalizeTriggerFilter` shorthand→{all:[…]} step.
import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';

/**
 * JSON Schema (draft-07) for the minimal webhook trigger block.
 *
 * `auth` is discriminated on `mode`. Each mode's `then` is a closed set: a field belonging to a
 * different mode (e.g. `mode: github` + `algorithm`) is rejected as unknown rather than silently
 * ignored. Every `if` includes `required: ['mode']` so the condition only matches when `mode` is
 * present and equal to the const (avoids the draft-07 "absent property in `if` is vacuously true"
 * trap). The combinators (filter `oneOf`, value `anyOf`) carry property stubs to satisfy
 * strictRequired.
 */
export const TRIGGER_JSON_SCHEMA = {
  type: 'object',
  required: ['type', 'auth'],
  additionalProperties: false,
  properties: {
    type: { const: 'webhook' },
    path: { type: 'string', minLength: 1 },
    auth: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { enum: ['shared_secret', 'github', 'stripe', 'hmac', 'none'] },
      },
      allOf: [
        {
          if: { properties: { mode: { const: 'shared_secret' } }, required: ['mode'] },
          then: {
            additionalProperties: false,
            required: ['header', 'secret_from'],
            properties: {
              mode: {},
              header: { type: 'string', minLength: 1 },
              secret_from: { type: 'string', minLength: 1 },
            },
          },
        },
        {
          if: { properties: { mode: { const: 'github' } }, required: ['mode'] },
          then: {
            additionalProperties: false,
            required: ['secret_from'],
            properties: { mode: {}, secret_from: { type: 'string', minLength: 1 } },
          },
        },
        {
          if: { properties: { mode: { const: 'stripe' } }, required: ['mode'] },
          then: {
            additionalProperties: false,
            required: ['secret_from'],
            properties: {
              mode: {},
              secret_from: { type: 'string', minLength: 1 },
              max_age_seconds: { type: 'integer', minimum: 1 },
            },
          },
        },
        {
          if: { properties: { mode: { const: 'hmac' } }, required: ['mode'] },
          then: {
            additionalProperties: false,
            required: ['secret_from', 'header'],
            properties: {
              mode: {},
              secret_from: { type: 'string', minLength: 1 },
              header: { type: 'string', minLength: 1 },
              algorithm: { enum: ['sha1', 'sha256', 'sha512'] },
              encoding: { enum: ['hex', 'base64'] },
              timestamp_header: { type: 'string', minLength: 1 },
              max_age_seconds: { type: 'integer', minimum: 1 },
            },
          },
        },
        {
          if: { properties: { mode: { const: 'none' } }, required: ['mode'] },
          then: {
            additionalProperties: false,
            properties: { mode: {} },
          },
        },
      ],
    },
    filter: {
      type: 'object',
      required: ['all'],
      additionalProperties: false,
      properties: {
        all: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['value'],
            properties: {
              header: { type: 'string', minLength: 1 },
              path: { type: 'string', minLength: 1 },
              // non-empty string OR non-empty array of non-empty strings (an empty / empty-element
              // allow-list is an unsatisfiable, dead-on-arrival condition).
              value: {
                anyOf: [
                  { type: 'string', minLength: 1 },
                  { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
                ],
              },
            },
            // exactly one of header / path. Property stubs satisfy strictRequired.
            oneOf: [
              { required: ['header'], properties: { header: {} } },
              { required: ['path'], properties: { path: {} } },
            ],
          },
        },
      },
    },
    dedup: {
      oneOf: [
        { const: false },
        {
          type: 'object',
          required: ['id_from'],
          additionalProperties: false,
          properties: {
            id_from: { type: 'string', minLength: 1 },
            ttl_minutes: { type: 'integer', minimum: 1, maximum: 10080 },
            on_missing_id: { enum: ['skip', 'reject'] },
          },
        },
      ],
    },
    params_map: {
      type: 'object',
      additionalProperties: { type: 'string', minLength: 1 },
    },
  },
} as const;

// Compile once. allErrors:true so anyOf/oneOf subschema failures surface field-naming errors and a
// misconfiguration reports every problem at load. strict:true is safe AND enforced — the per-mode
// `then`s declare every property they require and the combinators carry property stubs, so any
// future edit that reintroduces a strictRequired violation fails loudly at module import / in tests.
const ajv = new Ajv({ allErrors: true, strict: true });
const validateFn = ajv.compile(TRIGGER_JSON_SCHEMA);

/**
 * Formats one Ajv error into a human-readable string that INCLUDES the offending field name, so
 * downstream message regexes keep matching. Ajv 8 exposes `instancePath` as a JSON Pointer
 * (e.g. '/auth/mode') and `params.{missingProperty,additionalProperty}`.
 */
function formatAjvError(err: ErrorObject): string {
  const instancePath = typeof err.instancePath === 'string' ? err.instancePath : '';
  const base = `trigger${instancePath}`;
  const params = (err.params ?? {}) as Record<string, unknown>;

  if (err.keyword === 'required' && typeof params['missingProperty'] === 'string') {
    return `${base}: missing required property '${params['missingProperty']}'`;
  }
  if (err.keyword === 'additionalProperties' && typeof params['additionalProperty'] === 'string') {
    return `${base}: unknown property '${params['additionalProperty']}'`;
  }
  return `${base} ${err.message ?? 'is invalid'}`.trim();
}

// Structural combinator keywords. Their errors wrap the real (leaf) failures, so they add noise
// without information once a leaf is present.
const WRAPPER_KEYWORDS = new Set(['oneOf', 'anyOf', 'if']);

/**
 * Cleans Ajv's raw error array into a concise, field-named, de-duplicated string list:
 *  - drops the misleading dedup `{ const: false }` line (it implies "dedup must be false"),
 *  - drops structural wrapper noise (`if`, and `anyOf`/`oneOf` when a leaf already explains it),
 *  - replaces the otherwise-cryptic filter header-XOR-path `oneOf` (both branches matched → no leaf)
 *    with a clear message,
 *  - keeps every field-named leaf error, de-duplicates (first-seen order), never returns empty for a
 *    real failure.
 * Pure and string-only — never changes which configs validate.
 */
function formatAjvErrors(errs: ErrorObject[]): string[] {
  const leafPaths = new Set<string>();
  for (const err of errs) {
    if (!WRAPPER_KEYWORDS.has(err.keyword)) {
      leafPaths.add(typeof err.instancePath === 'string' ? err.instancePath : '');
    }
  }
  const hasLeafAtOrUnder = (path: string): boolean => {
    for (const leaf of leafPaths) {
      if (leaf === path || leaf.startsWith(`${path}/`)) {
        return true;
      }
    }
    return false;
  };

  const out: string[] = [];
  for (const err of errs) {
    const instancePath = typeof err.instancePath === 'string' ? err.instancePath : '';
    const params = (err.params ?? {}) as Record<string, unknown>;

    // Misleading dedup `{ const: false }` branch error.
    if (err.keyword === 'const' && instancePath === '/dedup' && params['allowedValue'] === false) {
      continue;
    }
    // `if` is always redundant — the failing `then`'s own leaf error is always present.
    if (err.keyword === 'if') {
      continue;
    }
    // `anyOf` — drop when a leaf exists at the same path or deeper.
    if (err.keyword === 'anyOf') {
      if (hasLeafAtOrUnder(instancePath)) {
        continue;
      }
      out.push(formatAjvError(err));
      continue;
    }
    // `oneOf`.
    if (err.keyword === 'oneOf') {
      const passing = params['passingSchemas'];
      if (Array.isArray(passing) && passing.length >= 2) {
        // More than one branch matched → no leaf error exists. Replace with a clear message.
        if (/^\/filter\/all\/\d+$/.test(instancePath)) {
          out.push(`trigger${instancePath}: must have exactly one of 'header' or 'path'`);
        } else {
          out.push(`trigger${instancePath}: must match exactly one of the allowed shapes`);
        }
        continue;
      }
      if (hasLeafAtOrUnder(instancePath)) {
        continue;
      }
      out.push(formatAjvError(err));
      continue;
    }
    // Leaf error.
    out.push(formatAjvError(err));
  }

  const deduped = [...new Set(out)];
  // Safety net: a failure must never produce zero messages.
  if (deduped.length === 0 && errs.length > 0) {
    return [...new Set(errs.map(formatAjvError))];
  }
  return deduped;
}

/**
 * Normalises a shorthand filter (a single FilterCondition object with no `all` key) into the
 * canonical { all: [condition] } form, IN PLACE. Called BEFORE schema validation so a malformed
 * shorthand is validated rather than silently laundered into canonical form. No-op when trigger is
 * not an object, when filter is absent/not an object, or when filter already has an `all` key.
 */
export function normalizeTriggerFilter(trigger: unknown): void {
  if (typeof trigger !== 'object' || trigger === null || Array.isArray(trigger)) {
    return;
  }
  const t = trigger as Record<string, unknown>;
  const filter = t['filter'];
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    return;
  }
  if ('all' in filter) {
    return;
  }
  t['filter'] = { all: [filter] };
}

/**
 * Validates a trigger block against TRIGGER_JSON_SCHEMA via Ajv. Returns an array of human-readable
 * error strings (empty = valid). Never throws.
 */
export function validateTriggerStructure(trigger: unknown): string[] {
  const valid = validateFn(trigger);
  if (!valid && validateFn.errors) {
    return formatAjvErrors(validateFn.errors);
  }
  return [];
}
