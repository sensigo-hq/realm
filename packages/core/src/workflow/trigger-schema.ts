// Declarative trigger-block validation.
//
// The webhook `trigger:` block is validated against a single JSON Schema (draft-07)
// using the same Ajv instance pattern the loader already uses for params_schema and
// adapter config_schema. This closes the entire class of "loads cleanly, fails at
// first webhook" gaps at once and keeps adding a trigger field to a single declarative
// artifact rather than a hand-written check.
//
// A thin code layer handles the few things JSON Schema cannot express with a
// test-asserted message (the shopify secret_map `.myshopify.com` key suffix) and the
// advisory warnings (retry-window, fallback, registration debug).
import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';

/**
 * JSON Schema (draft-07) for the webhook trigger block.
 *
 * Footguns handled inline:
 *  - signature.additionalProperties:false requires the UNION of all providers' fields to be
 *    declared at the signature level, because the if/then `then` subschemas only add
 *    `required`, not new property declarations. Declaring an hmac-only field on a github
 *    signature is therefore permitted (declared-but-irrelevant) — an accepted, documented
 *    minor over-permissiveness. The security-critical wins (required fields, enums, types,
 *    no-unknown-keys) are all enforced.
 *  - every `if` includes `required: ['provider']` so the condition only matches when provider
 *    is present and equal to the const — avoiding the draft-07 "absent property in `if` is
 *    vacuously true" trap that would fire `then` spuriously.
 */
export const TRIGGER_JSON_SCHEMA = {
  type: 'object',
  required: ['type', 'signature'],
  additionalProperties: false,
  properties: {
    type: { const: 'webhook' },
    path: { type: 'string', minLength: 1 },
    signature: {
      type: 'object',
      required: ['provider'],
      // No additionalProperties here: each provider's `then` is a closed set, so a field that
      // belongs to a different provider (e.g. github + `algorithm`) is rejected as unknown rather
      // than silently ignored. The per-provider `then`s also declare every property they require,
      // which keeps the schema clean under Ajv strict/strictRequired (see the strict:true Ajv below).
      properties: {
        provider: { enum: ['github', 'shopify', 'stripe', 'hmac'] },
      },
      allOf: [
        {
          if: { properties: { provider: { const: 'github' } }, required: ['provider'] },
          then: {
            additionalProperties: false,
            required: ['secret_from'],
            properties: { provider: {}, secret_from: { type: 'string', minLength: 1 } },
          },
        },
        {
          if: { properties: { provider: { const: 'stripe' } }, required: ['provider'] },
          then: {
            additionalProperties: false,
            required: ['secret_from'],
            properties: {
              provider: {},
              secret_from: { type: 'string', minLength: 1 },
              max_age_seconds: { type: 'integer', minimum: 1 },
            },
          },
        },
        {
          if: { properties: { provider: { const: 'hmac' } }, required: ['provider'] },
          then: {
            additionalProperties: false,
            required: ['secret_from', 'header'],
            properties: {
              provider: {},
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
          if: { properties: { provider: { const: 'shopify' } }, required: ['provider'] },
          then: {
            additionalProperties: false,
            properties: {
              provider: {},
              secret_from: { type: 'string', minLength: 1 },
              secret_map: {
                type: 'object',
                minProperties: 1,
                additionalProperties: { type: 'string', minLength: 1 },
              },
              secret_from_header: { type: 'string', minLength: 1 },
              fallback_secret_from: { type: 'string', minLength: 1 },
            },
            // secret_from OR secret_map. Property stubs in each branch satisfy strictRequired.
            anyOf: [
              { required: ['secret_from'], properties: { secret_from: {} } },
              { required: ['secret_map'], properties: { secret_map: {} } },
            ],
            // secret_map present ⇒ secret_from_header required (draft-07 property dependency).
            dependencies: { secret_map: ['secret_from_header'] },
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
            ttl_minutes: { type: 'integer', minimum: 1, maximum: 44640 },
            on_missing_id: { enum: ['skip', 'reject'] },
          },
        },
      ],
    },
    params_map: {
      type: 'object',
      additionalProperties: { type: 'string', minLength: 1 },
    },
    registration: {
      type: 'object',
      required: ['provider'],
      properties: {
        provider: { enum: ['github', 'shopify', 'stripe'] },
      },
      allOf: [
        {
          if: { properties: { provider: { const: 'github' } }, required: ['provider'] },
          then: {
            additionalProperties: false,
            required: ['scope', 'target', 'events', 'api_key_from'],
            properties: {
              provider: {},
              scope: { enum: ['repo', 'org'] },
              target: { type: 'string', minLength: 1 },
              events: { type: 'array', items: { type: 'string' }, minItems: 1 },
              api_key_from: { type: 'string', minLength: 1 },
            },
          },
        },
        {
          if: { properties: { provider: { const: 'shopify' } }, required: ['provider'] },
          then: {
            additionalProperties: false,
            required: ['store', 'topics', 'api_key_from'],
            properties: {
              provider: {},
              store: { type: 'string', minLength: 1 },
              topics: { type: 'array', items: { type: 'string' }, minItems: 1 },
              api_key_from: { type: 'string', minLength: 1 },
              api_version: { type: 'string', minLength: 1 },
            },
          },
        },
        {
          if: { properties: { provider: { const: 'stripe' } }, required: ['provider'] },
          then: {
            additionalProperties: false,
            required: ['events', 'api_key_from'],
            properties: {
              provider: {},
              events: { type: 'array', items: { type: 'string' }, minItems: 1 },
              api_key_from: { type: 'string', minLength: 1 },
            },
          },
        },
      ],
    },
  },
} as const;

// Compile once. allErrors:true so that anyOf/oneOf subschema failures (e.g. the shopify
// secret_from/secret_map alternatives, the dedup oneOf) surface their field-naming errors,
// and so a misconfiguration reports every problem at load rather than one at a time.
// strict:true is now safe AND enforced: the per-provider `then`s declare every property they
// require, and the combinators (shopify anyOf, filter oneOf) carry property stubs, so strictRequired
// is satisfied. Keeping strict:true means any future schema edit that reintroduces a strictRequired
// violation fails loudly at module import / in tests, instead of silently re-arming the landmine.
const ajv = new Ajv({ allErrors: true, strict: true });
const validateFn = ajv.compile(TRIGGER_JSON_SCHEMA);

/**
 * Formats one Ajv error into a human-readable string that INCLUDES the offending field name,
 * so downstream message regexes keep matching. Ajv 8 exposes `instancePath` as a JSON Pointer
 * (e.g. '/signature/provider') and `params.{missingProperty,additionalProperty}`.
 */
function formatAjvError(err: ErrorObject): string {
  const instancePath = typeof err.instancePath === 'string' ? err.instancePath : '';
  const base = `trigger${instancePath}`;
  const params = (err.params ?? {}) as Record<string, unknown>;

  if (err.keyword === 'required' && typeof params['missingProperty'] === 'string') {
    return `${base}: missing required property '${params['missingProperty']}'`;
  }
  // The shopify secret_map ⇒ secret_from_header rule surfaces as the `dependencies` keyword
  // (draft-07 property dependency), with the missing field in params.missingProperty.
  if (err.keyword === 'dependencies' && typeof params['missingProperty'] === 'string') {
    return `${base}: missing required property '${params['missingProperty']}'`;
  }
  if (err.keyword === 'additionalProperties' && typeof params['additionalProperty'] === 'string') {
    return `${base}: unknown property '${params['additionalProperty']}'`;
  }
  return `${base} ${err.message ?? 'is invalid'}`.trim();
}

/**
 * Normalises a shorthand filter (a single FilterCondition object with no `all` key) into the
 * canonical { all: [condition] } form, IN PLACE. Called BEFORE schema validation so a malformed
 * shorthand is validated rather than silently laundered into canonical form (closes G2).
 * No-op when trigger is not an object, when filter is absent/not an object, or when filter
 * already has an `all` key.
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
 * Validates a trigger block against TRIGGER_JSON_SCHEMA via Ajv, then applies the code-only
 * semantic checks (shopify secret_map `.myshopify.com` key suffix). Returns an array of
 * human-readable error strings (empty = valid). Never throws.
 */
export function validateTriggerStructure(trigger: unknown): string[] {
  const errors: string[] = [];

  const valid = validateFn(trigger);
  if (!valid && validateFn.errors) {
    for (const err of validateFn.errors) {
      errors.push(formatAjvError(err));
    }
  }

  // Code-only semantic check: shopify secret_map keys must end in '.myshopify.com'.
  // (JSON Schema propertyNames.pattern could express this, but the Ajv pattern-error message
  // would not contain the literal '.myshopify.com' substring downstream tests assert on.)
  if (typeof trigger === 'object' && trigger !== null && !Array.isArray(trigger)) {
    const sig = (trigger as Record<string, unknown>)['signature'];
    if (typeof sig === 'object' && sig !== null && !Array.isArray(sig)) {
      const sigObj = sig as Record<string, unknown>;
      if (sigObj['provider'] === 'shopify') {
        const secretMap = sigObj['secret_map'];
        if (typeof secretMap === 'object' && secretMap !== null && !Array.isArray(secretMap)) {
          for (const key of Object.keys(secretMap as Record<string, unknown>)) {
            if (!key.endsWith('.myshopify.com')) {
              errors.push(`trigger.signature.secret_map key '${key}' must end in '.myshopify.com'`);
            }
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Emits advisory logs for a STRUCTURALLY-VALID trigger (call only after validation passed):
 *  - OOS5 retry-window warning: provider shopify|github AND dedup is a present object AND
 *    (dedup.ttl_minutes ?? 10) < 4320.  Interpolates the effective TTL (default 10), never the
 *    raw ttl_minutes, so it can never render `undefinedmin`.
 *  - shopify fallback_secret_from present → console.warn.
 *  - registration present → console.debug.
 * Message wording is identical to the previous hand-written loader checks.
 */
export function emitTriggerWarnings(trigger: unknown, workflowId: string): void {
  if (typeof trigger !== 'object' || trigger === null || Array.isArray(trigger)) {
    return;
  }
  const t = trigger as Record<string, unknown>;

  const sig = t['signature'];
  const sigObj =
    typeof sig === 'object' && sig !== null && !Array.isArray(sig)
      ? (sig as Record<string, unknown>)
      : undefined;
  const provider = sigObj?.['provider'];

  // Retry-window warning.
  const dedup = t['dedup'];
  const dedupObj =
    typeof dedup === 'object' && dedup !== null && !Array.isArray(dedup)
      ? (dedup as Record<string, unknown>)
      : undefined;
  if ((provider === 'shopify' || provider === 'github') && dedupObj !== undefined) {
    const ttlRaw = dedupObj['ttl_minutes'];
    const effectiveTtl = typeof ttlRaw === 'number' ? ttlRaw : 10;
    if (effectiveTtl < 4320) {
      console.warn(
        `realm: workflow '${workflowId}': dedup ttl_minutes is ${effectiveTtl}min; ${provider} retries for 4320min (3d) — duplicate runs will be created if the provider retries after ${effectiveTtl} minutes. Consider setting ttl_minutes: 4320.`,
      );
    }
  }

  // Shopify fallback_secret_from warning.
  if (provider === 'shopify' && sigObj?.['fallback_secret_from'] !== undefined) {
    console.warn(
      `realm: workflow '${workflowId}': trigger.signature.fallback_secret_from is set — this accepts payloads from stores not in secret_map. Verify this is intentional.`,
    );
  }

  // Registration metadata-only debug.
  if (t['registration'] !== undefined) {
    console.debug(
      `realm: workflow '${workflowId}': trigger.registration is metadata-only in this version — runtime behavior is unaffected.`,
    );
  }
}
