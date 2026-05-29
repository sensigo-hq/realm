import { describe, it, expect } from 'vitest';
import { normalizeTrace } from './trace-normalizer.js';
import type { BufferedEntry } from '../store/trace-buffer-store.js';
import type { AgentTraceEntry } from '../types/run-record.js';
import type { NormalizeTraceResult } from './trace-normalizer.js';

/**
 * Helper that runs the WAL merge + sort + normalize logic — mirrors the step 2d
 * implementation in execution-loop.ts.
 */
function mergeAndNormalize(
  walEntries: BufferedEntry[],
  executestepEntries: AgentTraceEntry[],
  finalTs?: number,
): NormalizeTraceResult {
  const ts = finalTs ?? Date.now();
  const mergeSet: Array<AgentTraceEntry & { _internalTs: number }> = [
    ...walEntries,
    ...executestepEntries.map((e) => ({ ...e, _internalTs: ts })),
  ];
  mergeSet.sort((a, b) => a._internalTs - b._internalTs);
  const sortedEntries: AgentTraceEntry[] = mergeSet.map(({ _internalTs: _, ...rest }) => rest);
  return normalizeTrace(sortedEntries);
}

describe('WAL merge and finalization', () => {
  it('WAL empty + execute_step.trace has entries → produces same result as normalizeTrace directly', () => {
    const entries: AgentTraceEntry[] = [{ event: 'search', data: { q: 'test' } }];
    const directResult = normalizeTrace(entries);
    const mergedResult = mergeAndNormalize([], entries, 1000);
    expect(mergedResult.entries).toEqual(directResult.entries);
    expect(mergedResult.summary.stored_entries).toBe(directResult.summary.stored_entries);
    expect(mergedResult.digest).toBe(directResult.digest);
  });

  it('WAL has entries + execute_step.trace is empty → WAL entries are canonicalized', () => {
    const walEntries: BufferedEntry[] = [
      { event: 'wal_event', data: { phase: 'pre' }, _internalTs: 100 },
    ];
    const result = mergeAndNormalize(walEntries, [], 200);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.event).toBe('wal_event');
    expect(result.entries[0]?.seq).toBe(1);
  });

  it('WAL + execute_step.trace both have entries → WAL entries sort before final entries', () => {
    const walEntries: BufferedEntry[] = [
      { event: 'wal_early', _internalTs: 100 },
      { event: 'wal_mid', _internalTs: 200 },
    ];
    const finalEntries: AgentTraceEntry[] = [{ event: 'final_entry' }];
    // finalTs = 300 so final_entry sorts after WAL entries.
    const result = mergeAndNormalize(walEntries, finalEntries, 300);
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]?.event).toBe('wal_early');
    expect(result.entries[1]?.event).toBe('wal_mid');
    expect(result.entries[2]?.event).toBe('final_entry');
  });

  it('WAL + final entries exceed 100 → truncation applied, sentinel appended, truncated=true', () => {
    // Create 95 WAL entries + 20 final entries = 115 total → exceeds MAX_ENTRIES=100.
    const walEntries: BufferedEntry[] = Array.from({ length: 95 }, (_, i) => ({
      event: `wal_${i}`,
      _internalTs: i,
    }));
    const finalEntries: AgentTraceEntry[] = Array.from({ length: 20 }, (_, i) => ({
      event: `final_${i}`,
    }));
    const result = mergeAndNormalize(walEntries, finalEntries, 10000);
    // Should be truncated to 100 + sentinel.
    expect(result.summary.truncated).toBe(true);
    expect(result.entries.length).toBeLessThanOrEqual(101); // 100 + possible sentinel
    expect(result.summary.submitted_entries).toBe(115);
    expect(result.summary.stored_entries).toBeLessThan(115);
  });

  it('WAL entries with reserved-prefix events → normalizeTrace drops them again', () => {
    // Normally normalizeEntryForBuffer prevents reserved events from reaching WAL,
    // but if somehow present, normalizeTrace should drop them.
    const walEntries: BufferedEntry[] = [
      { event: 'trace.internal', _internalTs: 100 },
      { event: 'valid', _internalTs: 200 },
    ];
    const result = mergeAndNormalize(walEntries, [], 300);
    expect(result.entries.every((e) => !e.event.startsWith('trace.'))).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.event).toBe('valid');
  });

  it('WAL timestamp equals finalization timestamp → all entries present, stable by insertion', () => {
    const sameTs = 500;
    const walEntries: BufferedEntry[] = [
      { event: 'wal_a', _internalTs: sameTs },
      { event: 'wal_b', _internalTs: sameTs },
    ];
    const finalEntries: AgentTraceEntry[] = [{ event: 'final_a' }, { event: 'final_b' }];
    // Use the same sameTs as finalTs so all entries get same _internalTs.
    const result = mergeAndNormalize(walEntries, finalEntries, sameTs);
    // All 4 entries should be present (stable sort: WAL first, then final in Array order).
    expect(result.entries).toHaveLength(4);
    expect(result.entries.map((e) => e.event)).toEqual(['wal_a', 'wal_b', 'final_a', 'final_b']);
  });
});
