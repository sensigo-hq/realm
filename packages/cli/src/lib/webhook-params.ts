// Webhook payload helpers — dot-path resolution and param/dedup extraction.
// Pure functions (extractParams takes an injected logger for warn side-effects).
import type { DedupConfig } from '@sensigo/realm';

export interface WebhookPayload {
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Resolves a dot-notation path into an object.
 * Numeric segments (all-digit strings) index into arrays (zero-based).
 * Returns undefined on any resolution failure. Never throws.
 *
 * Rules:
 *  - Empty path returns the root object.
 *  - On an array, an all-digit in-bounds segment descends by index; any other
 *    segment (non-numeric or out-of-bounds index) resolves to undefined.
 *  - On a plain object, the segment is always a property key — even all-digit
 *    segments are string keys, not array indices.
 *  - On null/undefined/primitive, resolution stops with undefined.
 */
export function resolveDotPath(obj: unknown, path: string): unknown {
  if (path === '') {
    return obj;
  }

  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (Array.isArray(current)) {
      if (/^\d+$/.test(segment)) {
        const index = Number(segment);
        if (index >= 0 && index < current.length) {
          current = current[index];
          continue;
        }
      }
      return undefined;
    }

    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }

    // primitive — cannot descend further
    return undefined;
  }

  return current;
}

/**
 * Extracts run params from a webhook payload using params_map.
 * Logs a warn via the injected logger for each undefined result.
 * Returns a partial record — missing keys are absent, not null.
 */
export function extractParams(
  payload: WebhookPayload,
  paramsMap: Record<string, string>,
  logger: { warn: (msg: string, data?: unknown) => void },
): Record<string, unknown> {
  const root = { headers: payload.headers, body: payload.body };
  const result: Record<string, unknown> = {};

  for (const [paramName, dotPath] of Object.entries(paramsMap)) {
    const value = resolveDotPath(root, dotPath);
    if (value === undefined) {
      logger.warn('webhook params: could not resolve path', { path: dotPath });
    } else {
      result[paramName] = value;
    }
  }

  return result;
}

/**
 * Extracts the dedup ID from a webhook payload.
 * Returns the value coerced to string, or undefined if absent/null.
 * Numeric values are valid dedup IDs (stringified).
 */
export function extractDedupId(
  payload: WebhookPayload,
  dedupConfig: DedupConfig,
): string | undefined {
  const root = { headers: payload.headers, body: payload.body };
  const value = resolveDotPath(root, dedupConfig.id_from);
  if (value === null || value === undefined) {
    return undefined;
  }
  return String(value);
}
