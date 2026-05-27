// Unit tests for the trace normalizer — deterministic canonicalization of agent trace entries.
import { describe, it, expect } from 'vitest';
import { normalizeTrace } from './trace-normalizer.js';

describe('normalizeTrace', () => {
  // ─── basic operation ──────────────────────────────────────────────────────

  it('assigns seq numbers starting from 1', () => {
    const { entries } = normalizeTrace([{ event: 'alpha' }, { event: 'beta' }, { event: 'gamma' }]);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('passes through timestamp and data when present', () => {
    const { entries } = normalizeTrace([
      { event: 'step', timestamp: '2024-01-01T00:00:00Z', data: { key: 'val' } },
    ]);
    expect(entries[0]).toMatchObject({
      seq: 1,
      event: 'step',
      timestamp: '2024-01-01T00:00:00Z',
      data: { key: 'val' },
    });
  });

  it('omits timestamp and data when absent', () => {
    const { entries } = normalizeTrace([{ event: 'bare' }]);
    expect(entries[0]).not.toHaveProperty('timestamp');
    expect(entries[0]).not.toHaveProperty('data');
  });

  it('returns empty entries and undefined digest for empty input', () => {
    const { entries, digest, summary } = normalizeTrace([]);
    expect(entries).toHaveLength(0);
    expect(digest).toBeUndefined();
    expect(summary.submitted_entries).toBe(0);
    expect(summary.stored_entries).toBe(0);
  });

  // ─── event normalization ──────────────────────────────────────────────────

  it('trims whitespace from event strings', () => {
    const { entries } = normalizeTrace([{ event: '  leading_space  ' }]);
    expect(entries[0]!.event).toBe('leading_space');
  });

  it('replaces empty (post-trim) event with "unknown_event"', () => {
    const { entries } = normalizeTrace([{ event: '' }, { event: '   ' }]);
    expect(entries[0]!.event).toBe('unknown_event');
    expect(entries[1]!.event).toBe('unknown_event');
  });

  it('caps event length to 100 characters', () => {
    const long = 'x'.repeat(200);
    const { entries } = normalizeTrace([{ event: long }]);
    expect(entries[0]!.event).toHaveLength(100);
  });

  // ─── data normalization ───────────────────────────────────────────────────

  it('keeps string, number, boolean, null values', () => {
    const { entries } = normalizeTrace([
      { event: 'types', data: { s: 'hello', n: 42, b: true, nil: null } },
    ]);
    expect(entries[0]!.data).toEqual({ s: 'hello', n: 42, b: true, nil: null });
  });

  it('drops object and array values silently', () => {
    const { entries } = normalizeTrace([
      // Cast to any to bypass TS type since we test runtime robustness
      { event: 'mixed', data: { good: 'ok', bad: { nested: true } as unknown as string } },
    ]);
    expect(entries[0]!.data).toEqual({ good: 'ok' });
  });

  it('caps string values to 500 characters', () => {
    const long = 'y'.repeat(600);
    const { entries } = normalizeTrace([{ event: 'ev', data: { long } }]);
    expect(entries[0]!.data!['long']).toHaveLength(500);
  });

  it('caps data keys to the first 20', () => {
    const data: Record<string, string> = {};
    for (let i = 0; i < 30; i++) data[`key${i}`] = 'v';
    const { entries } = normalizeTrace([{ event: 'many_keys', data }]);
    expect(Object.keys(entries[0]!.data!)).toHaveLength(20);
  });

  it('omits data field when all values are dropped', () => {
    const { entries } = normalizeTrace([
      { event: 'ev', data: { bad: { obj: 1 } as unknown as string } },
    ]);
    expect(entries[0]).not.toHaveProperty('data');
  });

  it('omits data field when data is undefined', () => {
    const { entries } = normalizeTrace([{ event: 'ev' }]);
    expect(entries[0]).not.toHaveProperty('data');
  });

  // ─── reserved prefix ──────────────────────────────────────────────────────

  it('drops entries whose event starts with "trace."', () => {
    const { entries, summary } = normalizeTrace([
      { event: 'trace.internal' },
      { event: 'trace.other' },
      { event: 'legit' },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.event).toBe('legit');
    expect(summary.discarded_reserved_event_entries).toBe(2);
    expect(summary.discarded_entries).toBe(2);
  });

  it('does not drop entries whose event merely contains "trace." in the middle', () => {
    const { entries } = normalizeTrace([{ event: 'my.trace.info' }]);
    expect(entries[0]!.event).toBe('my.trace.info');
  });

  // ─── count limit ──────────────────────────────────────────────────────────

  it('stores at most 100 entries, then appends sentinel', () => {
    const input = Array.from({ length: 101 }, (_, i) => ({ event: `ev${i}` }));
    const { entries, summary } = normalizeTrace(input);
    // 100 real entries + 1 sentinel
    expect(entries).toHaveLength(101);
    expect(entries[100]!.event).toBe('trace.truncated');
    expect(entries[100]!.seq).toBe(101);
    expect(summary.truncated).toBe(true);
    expect(summary.truncation_reason).toBe('count_limit');
    expect(summary.discarded_overflow_entries).toBe(1);
    expect(summary.stored_entries).toBe(101);
  });

  it('sets sentinel data accurately on count limit', () => {
    const input = Array.from({ length: 105 }, (_, i) => ({ event: `ev${i}` }));
    const { entries } = normalizeTrace(input);
    const sentinel = entries[entries.length - 1]!;
    expect(sentinel.data!['submitted']).toBe(105);
    expect(sentinel.data!['stored_before_sentinel']).toBe(100);
    expect(sentinel.data!['discarded']).toBe(5);
    expect(sentinel.data!['reason']).toBe('count_limit');
  });

  it('entries after count limit count as discarded_overflow, not discarded_reserved', () => {
    const input = Array.from({ length: 103 }, (_, i) => ({ event: `ev${i}` }));
    const { summary } = normalizeTrace(input);
    expect(summary.discarded_overflow_entries).toBe(3);
    expect(summary.discarded_reserved_event_entries).toBe(0);
  });

  // ─── byte limit ───────────────────────────────────────────────────────────

  it('triggers byte_limit when serialized trace exceeds 50 KB', () => {
    // Each entry: event + 500-char data value. Around 65-70 entries will hit 50 KB.
    const bigVal = 'z'.repeat(500);
    const input = Array.from({ length: 120 }, (_, i) => ({
      event: `event_${i}`,
      data: { payload: bigVal },
    }));
    const { entries, summary } = normalizeTrace(input);
    const sentinel = entries[entries.length - 1]!;
    expect(sentinel.event).toBe('trace.truncated');
    expect(summary.truncation_reason).toBe('byte_limit');
    expect(summary.truncated).toBe(true);
    // Sentinel is always appended even if that pushes slightly over 50 KB
    expect(entries.length).toBeLessThan(120);
  });

  // ─── byte-budget boundary correctness ────────────────────────────────────
  //
  // Fixtures are engineered to exact known byte sizes.
  //
  // 96 entries with event='x' and data={k:'A'.repeat(490)} — all ASCII:
  //   seq 1-9  → {"seq":N,"event":"x","data":{"k":"..."}} = 527 bytes each
  //   seq 10-96 → 528 bytes each
  //   Array total: 2 + 9×527 + 87×528 + 95 commas = 50776 bytes
  //
  // Entry 97 (seq=97, 2-digit): fixed overhead = {"seq":97,"event":"x","data":{"k":""}} + value
  //   prefix ("{"seq":97,"event":"x","data":{"k":"") = 35 bytes
  //   suffix ("}}") = 3 bytes
  //   fixed overhead = 38 bytes
  //
  //   With 385-char value: 423 bytes → prospective = 50776 + 1 + 423 = 51200 = MAX_BYTES → fits
  //   With 386-char value: 424 bytes → prospective = 50776 + 1 + 424 = 51201 > MAX_BYTES → rejected

  it('boundary: candidate that exactly fills the byte budget is stored (no truncation)', () => {
    const PRELUDE_VAL = 'A'.repeat(490);
    const prelude = Array.from({ length: 96 }, () => ({ event: 'x', data: { k: PRELUDE_VAL } }));
    // Entry 97 sized to exactly fill remaining budget.
    const exactFit = { event: 'x', data: { k: 'B'.repeat(385) } };

    const { entries, summary } = normalizeTrace([...prelude, exactFit]);

    expect(summary.truncated).toBe(false);
    expect(entries).toHaveLength(97);
    expect(entries[96]!.data!['k']).toHaveLength(385);
    // Parity: the stored array serializes to exactly MAX_BYTES.
    expect(Buffer.byteLength(JSON.stringify(entries), 'utf8')).toBe(50 * 1024);
  });

  it('boundary: candidate that exceeds byte budget by 1 byte triggers byte_limit', () => {
    const PRELUDE_VAL = 'A'.repeat(490);
    const prelude = Array.from({ length: 96 }, () => ({ event: 'x', data: { k: PRELUDE_VAL } }));
    // Entry 97 sized to exceed by exactly 1 byte.
    const overBy1 = { event: 'x', data: { k: 'B'.repeat(386) } };

    const { entries, summary } = normalizeTrace([...prelude, overBy1]);

    expect(summary.truncated).toBe(true);
    expect(summary.truncation_reason).toBe('byte_limit');
    // 96 prelude entries stored + 1 sentinel = 97 total; entry 97 was rejected.
    expect(entries).toHaveLength(97);
    expect(entries[96]!.event).toBe('trace.truncated');
    expect(summary.discarded_overflow_entries).toBe(1);
    // The stored payload (without sentinel) is within budget.
    const payload = entries.slice(0, 96);
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBe(50776);
  });

  it('parity: stored payload entries are within budget after byte_limit truncation', () => {
    const bigVal = 'A'.repeat(490);
    const input = Array.from({ length: 100 }, () => ({ event: 'x', data: { k: bigVal } }));
    const { entries, summary } = normalizeTrace(input);

    expect(summary.truncated).toBe(true);
    expect(summary.truncation_reason).toBe('byte_limit');

    // All stored entries excluding the sentinel must fit within 50 KB.
    const payload = entries.filter((e) => e.event !== 'trace.truncated');
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(50 * 1024);
  });

  // ─── first-trigger semantics ──────────────────────────────────────────────

  it('count_limit fires before byte_limit when entry count reaches 100 first', () => {
    // Small entries: will hit count limit before byte limit.
    const input = Array.from({ length: 120 }, (_, i) => ({ event: `s${i}` }));
    const { summary } = normalizeTrace(input);
    expect(summary.truncation_reason).toBe('count_limit');
  });

  // ─── summary fields ───────────────────────────────────────────────────────

  it('summary reflects submitted, stored, discarded counts when no truncation', () => {
    const { summary } = normalizeTrace([
      { event: 'trace.dropped' }, // reserved — dropped
      { event: 'good1' },
      { event: 'good2' },
    ]);
    expect(summary.submitted_entries).toBe(3);
    expect(summary.stored_entries).toBe(2);
    expect(summary.discarded_entries).toBe(1);
    expect(summary.discarded_reserved_event_entries).toBe(1);
    expect(summary.discarded_overflow_entries).toBe(0);
    expect(summary.truncated).toBe(false);
    expect(summary.truncation_reason).toBeUndefined();
  });

  // ─── digest ───────────────────────────────────────────────────────────────

  it('returns a 64-char hex digest for non-empty stored trace', () => {
    const { digest } = normalizeTrace([{ event: 'ev' }]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns undefined digest for empty stored trace', () => {
    const { digest } = normalizeTrace([{ event: 'trace.only_reserved' }]);
    expect(digest).toBeUndefined();
  });

  it('digest is deterministic for identical input', () => {
    const input = [{ event: 'alpha', data: { k: 'v' } }];
    const { digest: d1 } = normalizeTrace(input);
    const { digest: d2 } = normalizeTrace(input);
    expect(d1).toBe(d2);
    expect(d1).toBeDefined();
  });

  it('digest differs when trace content differs', () => {
    const { digest: d1 } = normalizeTrace([{ event: 'alpha' }]);
    const { digest: d2 } = normalizeTrace([{ event: 'beta' }]);
    expect(d1).not.toBe(d2);
  });

  // ─── correction 1: normalize-before-prefix-check ─────────────────────────

  it('drops whitespace-padded reserved-prefix event after normalization', () => {
    // "  trace.internal  " normalizes to "trace.internal" → reserved → dropped.
    const { entries, summary } = normalizeTrace([
      { event: '  trace.internal  ' },
      { event: '  trace.engine_event' },
      { event: '\ttrace.tab_padded\t' },
      { event: 'legit' },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.event).toBe('legit');
    expect(summary.discarded_reserved_event_entries).toBe(3);
  });

  // ─── correction 2: UTF-8 byte limit ──────────────────────────────────────

  it('byte limit is enforced using UTF-8 byte count, not JS string length', () => {
    // U+1F600 (😀) is 1 JS char in some representations but takes 4 UTF-8 bytes.
    // A string of 200 emoji repeated 5 times per entry should trigger byte_limit
    // well before count_limit (100 entries) because UTF-8 size > JS string length.
    const emojiPayload = '😀'.repeat(200); // 200 * 4 bytes = 800 bytes per entry (UTF-8)
    const input = Array.from({ length: 80 }, (_, i) => ({
      event: `ev_${i}`,
      data: { payload: emojiPayload },
    }));
    const { summary } = normalizeTrace(input);
    // Should hit byte_limit before count_limit (count_limit = 100 > 80 entries).
    expect(summary.truncation_reason).toBe('byte_limit');
    expect(summary.truncated).toBe(true);
    // Fewer entries should be stored when measured by UTF-8 bytes vs JS length.
    // With UTF-8, 800+ bytes per entry, max is ~62 entries before 50KB is hit.
    expect(summary.stored_entries).toBeLessThan(80);
  });
});
