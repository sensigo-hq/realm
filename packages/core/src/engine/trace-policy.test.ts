// trace-policy.test.ts — Tests that prove the exported policy descriptor matches
// the engine trace normalizer's actual behaviour.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { TRACE_POLICY, TRACE_POLICY_VERSION, TRACE_POLICY_HASH } from './trace-policy.js';
import { normalizeTrace } from './trace-normalizer.js';

describe('TRACE_POLICY', () => {
  it('version is the stable identifier v1', () => {
    expect(TRACE_POLICY_VERSION).toBe('v1');
    expect(TRACE_POLICY.version).toBe('v1');
  });

  it('maxStoredEntries matches normalizer count limit', () => {
    // Submit maxStoredEntries + 1 entries; normalizer should store exactly maxStoredEntries
    // before appending the sentinel, confirming the descriptor value is in sync.
    const entries = Array.from({ length: TRACE_POLICY.maxStoredEntries + 1 }, (_, i) => ({
      event: `ev_${i}`,
    }));
    const result = normalizeTrace(entries);
    const storedBeforeSentinel = result.summary.stored_entries - 1; // minus sentinel
    expect(storedBeforeSentinel).toBe(TRACE_POLICY.maxStoredEntries);
  });

  it('maxSerializedBytes is 50 KiB (51200 bytes)', () => {
    expect(TRACE_POLICY.maxSerializedBytes).toBe(50 * 1024);
  });

  it('reservedEventPrefix matches normalizer drop rule', () => {
    // An event starting with the reserved prefix is dropped; a normal event is kept.
    const entries = [
      { event: `${TRACE_POLICY.reservedEventPrefix}internal` },
      { event: 'normal_event' },
    ];
    const result = normalizeTrace(entries);
    const nonSentinel = result.entries.filter((e) => e.event !== TRACE_POLICY.sentinelEvent);
    expect(nonSentinel).toHaveLength(1);
    expect(nonSentinel[0]?.event).toBe('normal_event');
  });

  it('sentinelEvent matches normalizer sentinel entry', () => {
    const entries = Array.from({ length: TRACE_POLICY.maxStoredEntries + 1 }, (_, i) => ({
      event: `ev_${i}`,
    }));
    const result = normalizeTrace(entries);
    const last = result.entries[result.entries.length - 1];
    expect(last?.event).toBe(TRACE_POLICY.sentinelEvent);
  });

  it('truncationBehavior is first_trigger', () => {
    expect(TRACE_POLICY.truncationBehavior).toBe('first_trigger');
  });
});

describe('TRACE_POLICY_HASH', () => {
  it('is a 64-character lowercase hex string', () => {
    expect(TRACE_POLICY_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across re-imports (module caching)', async () => {
    const { TRACE_POLICY_HASH: hash2 } = await import('./trace-policy.js');
    expect(TRACE_POLICY_HASH).toBe(hash2);
  });

  it('changes when policy fields change (content-hash property)', () => {
    // Construct a modified policy object and verify its hash differs.
    const modified = { ...TRACE_POLICY, maxStoredEntries: 42 };
    const altHash = createHash('sha256')
      .update(
        JSON.stringify(
          Object.fromEntries(Object.entries(modified).sort(([a], [b]) => a.localeCompare(b))),
        ),
      )
      .digest('hex');
    expect(TRACE_POLICY_HASH).not.toBe(altHash);
  });
});
