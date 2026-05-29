// trace-policy.ts — Versioned canonical trace policy descriptor.
// This module is the engine's authoritative contract for trace semantics.
// Cloud adapters MUST consume this descriptor rather than duplicating limits manually.
import { createHash } from 'node:crypto';

/**
 * Monotonic version identifier for the canonical trace policy.
 * Increment when any limit, prefix rule, or truncation behavior changes.
 */
export const TRACE_POLICY_VERSION = 'v1' as const;

export type TracePolicyVersion = typeof TRACE_POLICY_VERSION;

/** Canonical descriptor of the engine's trace normalization policy. */
export interface TracePolicyDescriptor {
  /** Monotonic version string. Increment on any semantic change. */
  version: TracePolicyVersion;
  /**
   * Maximum number of entries accepted into a normalized trace (before the sentinel entry).
   * Matches the MAX_ENTRIES constant in trace-normalizer.ts.
   */
  maxStoredEntries: number;
  /**
   * Maximum UTF-8 byte size of the serialized stored-entries array (brackets + commas included).
   * Matches the MAX_BYTES constant in trace-normalizer.ts.
   */
  maxSerializedBytes: number;
  /**
   * Normalized event prefix reserved for engine use.
   * Entries whose normalized event starts with this prefix are dropped during normalization.
   */
  reservedEventPrefix: string;
  /**
   * Event name used for the sentinel entry appended when truncation occurs.
   * Exempt from the reserved-prefix drop rule.
   */
  sentinelEvent: string;
  /**
   * Describes how truncation is triggered.
   * 'first_trigger': the first limit hit (count or bytes) ends acceptance of further entries.
   */
  truncationBehavior: 'first_trigger';
}

/**
 * Canonical trace policy. These values are the single authoritative source for
 * trace normalization limits. Kept in sync with trace-normalizer.ts constants.
 *
 * When updating any limit in trace-normalizer.ts:
 *   1. Update the matching field here.
 *   2. Bump TRACE_POLICY_VERSION.
 *   3. Update cloud adapters to recognize the new version.
 */
export const TRACE_POLICY: TracePolicyDescriptor = {
  version: TRACE_POLICY_VERSION,
  maxStoredEntries: 100,
  maxSerializedBytes: 50 * 1024, // 50 KB
  reservedEventPrefix: 'trace.',
  sentinelEvent: 'trace.truncated',
  truncationBehavior: 'first_trigger',
};

/**
 * SHA-256 hash of the canonical policy descriptor (deterministically key-sorted JSON).
 * Use as `engine_policy_hash` in cloud audit records.
 * Recomputed on each process start; stable for a given TRACE_POLICY value.
 */
export const TRACE_POLICY_HASH: string = createHash('sha256')
  .update(
    JSON.stringify(
      Object.fromEntries(Object.entries(TRACE_POLICY).sort(([a], [b]) => a.localeCompare(b))),
    ),
  )
  .digest('hex');
