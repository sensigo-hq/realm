// trace-normalizer.ts — Deterministic single-pass canonicalization for agent-submitted trace entries.
import { createHash } from 'node:crypto';
import type {
  AgentTraceEntry,
  TraceEntry,
  TraceNormalizationSummary,
} from '../types/run-record.js';

const MAX_ENTRIES = 100;
const MAX_BYTES = 50 * 1024; // 50 KB
const MAX_EVENT_LENGTH = 100;
const MAX_DATA_KEYS = 20;
const MAX_STRING_VALUE = 500;
const RESERVED_PREFIX = 'trace.';
const SENTINEL_EVENT = 'trace.truncated';

function normalizeEvent(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? 'unknown_event' : trimmed.slice(0, MAX_EVENT_LENGTH);
}

type AllowedValue = string | number | boolean | null;

function normalizeData(
  raw: Record<string, unknown> | undefined,
): Record<string, AllowedValue> | undefined {
  if (raw === undefined) return undefined;
  const keys = Object.keys(raw).slice(0, MAX_DATA_KEYS);
  const result: Record<string, AllowedValue> = {};
  for (const key of keys) {
    const v = raw[key];
    if (v === null) {
      result[key] = null;
    } else if (typeof v === 'boolean') {
      result[key] = v;
    } else if (typeof v === 'number') {
      result[key] = v;
    } else if (typeof v === 'string') {
      result[key] = v.slice(0, MAX_STRING_VALUE);
    }
    // Other types (object, array, undefined) are dropped silently.
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export interface NormalizeTraceResult {
  entries: TraceEntry[];
  digest: string | undefined;
  summary: TraceNormalizationSummary;
}

/**
 * Canonicalizes agent-submitted trace entries in a single pass.
 *
 * Rules applied in order:
 *   1. Normalize event: trim whitespace; replace empty with "unknown_event"; cap to 100 chars.
 *   2. Drop entries whose normalized event starts with "trace." (reserved engine namespace).
 *   3. Normalize data: keep first 20 keys; cap string values to 500 chars; drop non-primitive values.
 *   4. Apply hard limits (first-trigger wins): max 100 entries, max 50 KB UTF-8 bytes.
 *   5. Assign seq numbers (1-based, monotonically increasing) after filtering.
 *   6. Append a sentinel entry if truncation occurred.
 *
 * Normalization precedes the reserved-prefix check so that whitespace-padded variants
 * like "  trace.internal" are caught and dropped correctly.
 * Byte limit uses UTF-8 byte count (Buffer.byteLength) rather than JS string length.
 *
 * Sentinel entries are exempt from the reserved-prefix drop rule.
 * The sentinel data contains submitted, stored_before_sentinel, discarded, and reason fields.
 */
export function normalizeTrace(input: AgentTraceEntry[]): NormalizeTraceResult {
  const submittedEntries = input.length;
  let discardedReserved = 0;
  let discardedOverflow = 0;
  let truncated = false;
  let truncationReason: 'count_limit' | 'byte_limit' | undefined;

  const stored: TraceEntry[] = [];

  for (const entry of input) {
    // Normalize event first so whitespace-padded reserved-prefix events are caught below.
    const event = normalizeEvent(entry.event);

    // Drop entries whose normalized event starts with the reserved engine prefix.
    if (event.startsWith(RESERVED_PREFIX)) {
      discardedReserved++;
      continue;
    }

    // First-trigger: once truncated, all remaining valid entries count as overflow.
    if (truncated) {
      discardedOverflow++;
      continue;
    }

    const data = normalizeData(entry.data as Record<string, unknown> | undefined);

    const candidate: TraceEntry = {
      seq: stored.length + 1,
      event,
      ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
      ...(data !== undefined ? { data } : {}),
    };

    // Count limit check (evaluated before byte limit — first-trigger wins).
    if (stored.length >= MAX_ENTRIES) {
      truncated = true;
      truncationReason = 'count_limit';
      discardedOverflow++;
      continue;
    }

    // Byte limit check: measure UTF-8 byte size including seq-assigned candidate.
    if (Buffer.byteLength(JSON.stringify([...stored, candidate]), 'utf8') > MAX_BYTES) {
      truncated = true;
      truncationReason = 'byte_limit';
      discardedOverflow++;
      continue;
    }

    stored.push(candidate);
  }

  // Append engine sentinel if truncation occurred. Sentinel is exempt from reserved-prefix drop.
  if (truncated) {
    const sentinel: TraceEntry = {
      seq: stored.length + 1,
      event: SENTINEL_EVENT,
      data: {
        submitted: submittedEntries,
        stored_before_sentinel: stored.length,
        discarded: discardedReserved + discardedOverflow,
        reason: truncationReason!,
      },
    };
    stored.push(sentinel);
  }

  const discardedEntries = discardedReserved + discardedOverflow;

  const summary: TraceNormalizationSummary = {
    submitted_entries: submittedEntries,
    stored_entries: stored.length,
    discarded_entries: discardedEntries,
    discarded_reserved_event_entries: discardedReserved,
    discarded_overflow_entries: discardedOverflow,
    truncated,
    ...(truncationReason !== undefined ? { truncation_reason: truncationReason } : {}),
  };

  const digest =
    stored.length > 0
      ? createHash('sha256').update(JSON.stringify(stored)).digest('hex')
      : undefined;

  return { entries: stored, digest, summary };
}
