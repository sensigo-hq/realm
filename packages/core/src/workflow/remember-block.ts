// remember-block.ts — gap 3, unit 1a: the `remember:` block's schema and its words.
//
// One code-declared JSON Schema, compiled once with its own Ajv in strict mode (the `trigger:`
// precedent, trigger-schema.ts). The loader refuses a breach with the words below; the stamp
// (`engine/remember-stamp.ts`) checks a block again with the same compiled schema, so a definition
// built without the loader never reaches a stamp it cannot make. `value`'s form is `input_map`'s,
// checked by the loader's own `validateInputMapNode`, never here.
import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';
import type { InputMapNode, RememberConfig } from '../types/workflow-definition.js';

/**
 * A memory's name and each key part's name: a letter, then letters, digits and `_`, 64 at most. The
 * schema's pattern, and `memoryRowsOf`'s check of a stamp it did not write (gap 3, unit 2a).
 * @internal
 */
export const NAME_PATTERN = '^[A-Za-z][A-Za-z0-9_]{0,63}$';

/** The longest `keep_days`: ten years, as AWS AgentCore's `eventExpiryDuration` allows. */
export const REMEMBER_KEEP_DAYS_MAX = 3650;

/** JSON Schema (draft-07) for a step's `remember:` block. */
export const REMEMBER_JSON_SCHEMA = {
  type: 'object',
  required: ['as', 'key', 'keep_days'],
  additionalProperties: false,
  properties: {
    as: { type: 'string', pattern: NAME_PATTERN },
    key: {
      type: 'object',
      minProperties: 1,
      propertyNames: { type: 'string', pattern: NAME_PATTERN },
      // A non-empty path: at least one character that is not whitespace (input_map's leaf rule).
      additionalProperties: { type: 'string', pattern: '\\S' },
    },
    value: { type: 'object' },
    keep_days: { type: 'integer', minimum: 1, maximum: REMEMBER_KEEP_DAYS_MAX },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });
const validateBlock = ajv.compile(REMEMBER_JSON_SCHEMA);

/** Whether `block` fits the schema (the stamp's check; the loader's is {@link rememberBlockProblems}). */
export function isRememberBlock(block: unknown): block is RememberConfig {
  return validateBlock(block) === true;
}

/** A value as Words 4 prints it: JSON, and a number JSON cannot hold as its own text. */
function printed(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value) ?? String(value);
}

/** What a `value` that is not a map is, in the words of its refusal. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'true or false';
  return `a ${typeof value}`;
}

const FIELD_NAME_RULE =
  'must be a name of letters, digits and underscores that starts with a letter, at most 64 characters.';
const KEY_PARTS_RULE =
  "'remember.key' must name at least one part, each a path such as context.resources.<step>.<field>.";

/** One schema breach in its words (Words 3–7), after `Step '<step>': `; `undefined` for the inner
 *  `pattern` error Ajv adds at `/key` beside a key name's own `propertyNames` error. */
function wordsOf(err: ErrorObject, block: unknown): string | undefined {
  const params = (err.params ?? {}) as Record<string, unknown>;
  const at = err.instancePath;
  const field = at.split('/')[1];
  if (at === '/key' && err.keyword === 'pattern') return undefined;
  if (at === '') {
    if (err.keyword === 'required') {
      const missing = String(params['missingProperty']);
      return missing === 'keep_days'
        ? "'remember' needs 'keep_days': how many days to keep each entry, a whole number from 1 to 3650."
        : `'remember' needs '${missing}'.`;
    }
    if (err.keyword === 'additionalProperties') {
      return `'remember' has no '${String(params['additionalProperty'])}'. It takes as, key, value and keep_days.`;
    }
    return "'remember' must be a map of as, key, value and keep_days.";
  }
  if (field === 'as') return `'remember.as' ${FIELD_NAME_RULE}`;
  if (field === 'key') {
    if (err.keyword === 'propertyNames') {
      return `'remember.key.${String(params['propertyName'])}' ${FIELD_NAME_RULE}`;
    }
    return KEY_PARTS_RULE;
  }
  if (field === 'value') {
    const value = (block as Record<string, unknown>)['value'];
    return `'remember.value' must be a map of names to paths, not ${kindOf(value)}.`;
  }
  const days = (block as Record<string, unknown>)['keep_days'];
  return `'remember.keep_days' is ${printed(days)}; it must be a whole number from 1 to ${REMEMBER_KEEP_DAYS_MAX}.`;
}

/**
 * The loader's refusals for a step's `remember:` block that breaks the schema, each
 * `Step '<step>': …` (Words 3–7 and the value-is-not-a-map words); empty when it fits. Never throws.
 */
export function rememberBlockProblems(stepName: string, block: unknown): string[] {
  if (validateBlock(block) === true) return [];
  const words = (validateBlock.errors ?? [])
    .map((err) => wordsOf(err, block))
    .filter((tail): tail is string => tail !== undefined);
  return [...new Set(words)].map((tail) => `Step '${stepName}': ${tail}`);
}

/**
 * Every path a `remember:` block reads, in the order written: each key part's, then each of
 * `value`'s string leaves (a `$literal` is a value, never a path). Only for a block whose `key` and
 * `value` are maps; any other part is skipped.
 */
export function rememberReadPaths(block: unknown): string[] {
  if (typeof block !== 'object' || block === null) return [];
  const { key, value } = block as { key?: unknown; value?: unknown };
  const paths: string[] = [];
  if (typeof key === 'object' && key !== null && !Array.isArray(key)) {
    for (const leaf of Object.values(key)) if (typeof leaf === 'string') paths.push(leaf);
  }
  const visit = (node: unknown, depth: number): void => {
    if (typeof node === 'string') {
      paths.push(node);
      return;
    }
    if (typeof node !== 'object' || node === null || Array.isArray(node) || depth > 10) return;
    if ('$literal' in node) return;
    for (const child of Object.values(node as Record<string, InputMapNode>))
      visit(child, depth + 1);
  };
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) visit(value, 0);
  return paths;
}
