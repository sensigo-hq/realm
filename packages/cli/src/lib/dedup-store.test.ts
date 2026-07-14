// Tests for dedup stores. The shared suite runs against both implementations.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDedupStore, InMemoryDedupStore } from './dedup-store.js';
import type { DedupStore } from './dedup-store.js';

const cases: Array<[string, () => DedupStore]> = [
  ['FileDedupStore', () => new FileDedupStore(mkdtempSync(join(tmpdir(), 'dedup-')), 'wf')],
  ['InMemoryDedupStore', () => new InMemoryDedupStore()],
];

describe.each(cases)('%s', (_name, factory) => {
  // Belt-and-suspenders alongside the per-test try/finally below (issue #177):
  // guarantees fake timers can't leak into sibling tests/files even if a test throws
  // before reaching its own `finally`.
  afterEach(() => vi.useRealTimers());

  it('check returns false for unseen key', () => {
    const store = factory();
    expect(store.check('unseen', 60_000)).toBe(false);
  });

  it('record + check within TTL → true', () => {
    const store = factory();
    store.record('k', 60_000);
    expect(store.check('k', 60_000)).toBe(true);
  });

  it('record + check after TTL expires → false', async () => {
    // issue #177: was a real `sleep(150)` racing a real 100ms TTL — flaky under CPU
    // contention. Fake timers instead, with a causal before/after assertion so the
    // clock — not a race — is what proves expiry.
    //
    // FileDedupStore's expiry mixes a mockable Date.now() with a REAL file mtime, so:
    //  (a) fake timers must be installed BEFORE record() so the fake clock and the
    //      file's real mtime start aligned;
    //  (b) the advance must be generous (≫ the 100ms TTL, so any install/mtime skew
    //      is dwarfed) yet stay under 1 hour (FileDedupStore.check only scans
    //      floor(ttlMs/3_600_000)+2 hour-buckets from Date.now() — advancing by hours
    //      would move the record out of the scanned range and `check` would return
    //      false because the record was NOT FOUND, not because it expired).
    vi.useFakeTimers();
    try {
      const store = factory();
      store.record('k', 100);
      expect(store.check('k', 100)).toBe(true); // live BEFORE the TTL — the causal half
      await vi.advanceTimersByTimeAsync(60_000); // ≫ TTL, ≪ 1 hour
      expect(store.check('k', 100)).toBe(false); // expired AFTER — driven by the clock, not a race
    } finally {
      vi.useRealTimers();
    }
  });

  it('double record for the same key → no throw', () => {
    const store = factory();
    store.record('k', 60_000);
    expect(() => store.record('k', 60_000)).not.toThrow();
  });
});

describe('FileDedupStore cleanup', () => {
  it('removes bucket dirs older than maxAgeMs, keeps recent records', () => {
    const base = mkdtempSync(join(tmpdir(), 'dedup-'));
    const store = new FileDedupStore(base, 'wf');
    const oldBucket = join(base, 'wf', '2000010100'); // 2000-01-01 01:00 UTC
    mkdirSync(oldBucket, { recursive: true });
    store.record('recent', 60_000); // creates the current-hour bucket

    store.cleanup(60_000); // maxAge 1 min → ancient bucket dropped, recent kept

    expect(existsSync(oldBucket)).toBe(false);
    expect(store.check('recent', 60_000)).toBe(true);
  });

  it('never throws when the base dir is absent', () => {
    const base = join(mkdtempSync(join(tmpdir(), 'dedup-')), 'missing');
    const store = new FileDedupStore(base, 'wf');
    expect(() => store.cleanup(1000)).not.toThrow();
  });
});

describe('InMemoryDedupStore cleanup', () => {
  // Belt-and-suspenders alongside the try/finally below (issue #177) — guarantees fake
  // timers can't leak into sibling tests/files even if the test throws early.
  afterEach(() => vi.useRealTimers());

  it('evicts expired entries', async () => {
    // issue #177: was a real sleep(150) racing a real 100ms TTL. InMemoryDedupStore's
    // expiry is pure Date.now() (no filesystem mtime involved), so this one is a
    // straightforward fake-timers conversion — no bucket/mtime trap to worry about.
    vi.useFakeTimers();
    try {
      const store = new InMemoryDedupStore();
      store.record('k', 100);
      expect(store.check('k')).toBe(true); // live BEFORE the TTL — the causal half
      await vi.advanceTimersByTimeAsync(60_000); // ≫ TTL
      store.cleanup(0);
      expect(store.check('k')).toBe(false); // expired AFTER — driven by the clock, not a race
    } finally {
      vi.useRealTimers();
    }
  });
});
