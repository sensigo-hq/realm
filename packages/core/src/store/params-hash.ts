// Canonical, dependency-free hashing of a params object for idempotency identity.
// Used by the run store's pointer index and by the MCP tools to detect a key↔payload
// mismatch on an idempotency re-encounter.
import { createHash } from 'node:crypto';

/**
 * Produce a canonical JSON string: object keys sorted recursively so that two
 * params objects that are deeply equal (regardless of key insertion order) yield
 * the same string. `undefined` is treated as `null` in arrays and omitted in
 * objects, matching `JSON.stringify` semantics.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** sha256 hex of the canonical JSON of a params object. Stable across key ordering. */
export function hashParams(params: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(params)).digest('hex');
}
