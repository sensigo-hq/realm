// Tests for dedup stores. The shared suite runs against both implementations. #616 B1: the
// interface is core's and asynchronous, so every call is awaited. Each assertion carries (1) the
// break that turns it red and (2) what it prints when it fails.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DedupStore } from '@sensigo/realm';
import { FileDedupStore, InMemoryDedupStore } from './dedup-store.js';

const cases: Array<[string, () => DedupStore]> = [
  ['FileDedupStore', () => new FileDedupStore(mkdtempSync(join(tmpdir(), 'dedup-')), 'wf')],
  ['InMemoryDedupStore', () => new InMemoryDedupStore()],
];

describe.each(cases)('%s', (_name, factory) => {
  // Belt-and-suspenders alongside the per-test try/finally below (issue #177):
  // guarantees fake timers can't leak into sibling tests/files even if a test throws
  // before reaching its own `finally`.
  afterEach(() => vi.useRealTimers());

  it('check resolves false for unseen key', async () => {
    const store = factory();
    // (1) red when `check` resolves true for a key never recorded (the break: `check` always
    //     resolves true); (2) prints the boolean it resolved to.
    expect(await store.check('unseen', 60_000)).toBe(false);
  });

  it('record + check within TTL → true', async () => {
    const store = factory();
    await store.record('k', 60_000);
    // (1) red when a recorded key is not seen within its TTL (`check` always resolving false, or
    //     `record` writing nothing); (2) prints the boolean it resolved to.
    expect(await store.check('k', 60_000)).toBe(true);
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
      await store.record('k', 100);
      // (1) red when a recorded key is not seen before its TTL; (2) prints the boolean.
      expect(await store.check('k', 100)).toBe(true); // live BEFORE the TTL — the causal half
      await vi.advanceTimersByTimeAsync(60_000); // ≫ TTL, ≪ 1 hour
      // (1) red when an expired key is still seen (the break: `check` always resolves true);
      //     (2) prints the boolean.
      expect(await store.check('k', 100)).toBe(false); // expired AFTER — driven by the clock, not a race
    } finally {
      vi.useRealTimers();
    }
  });

  it('double record for the same key → resolves', async () => {
    const store = factory();
    await store.record('k', 60_000);
    // (1) red when recording a key already recorded rejects (the break: `record` rejects; for the
    //     file store, the EEXIST of two deliveries racing to create the same file no longer
    //     ignored); (2) prints the rejection's error.
    await expect(store.record('k', 60_000)).resolves.toBeUndefined();
  });
});

describe('FileDedupStore cleanup', () => {
  it('removes bucket dirs older than maxAgeMs, keeps recent records', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dedup-'));
    const store = new FileDedupStore(base, 'wf');
    const oldBucket = join(base, 'wf', '2000010100'); // 2000-01-01 01:00 UTC
    mkdirSync(oldBucket, { recursive: true });
    await store.record('recent', 60_000); // creates the current-hour bucket

    await store.cleanup(60_000); // maxAge 1 min → ancient bucket dropped, recent kept

    // (1) red when cleanup keeps a bucket older than maxAgeMs; (2) prints whether it exists.
    expect(existsSync(oldBucket)).toBe(false);
    // (1) red when cleanup removes the current hour's record; (2) prints the boolean.
    expect(await store.check('recent', 60_000)).toBe(true);
  });

  it('resolves when the base dir is absent, and when it cannot be read (the failure is logged, never thrown)', async () => {
    const absent = new FileDedupStore(join(mkdtempSync(join(tmpdir(), 'dedup-')), 'missing'), 'wf');
    // (1) red when an absent folder rejects (its ENOENT is the "nothing recorded yet" answer);
    //     (2) prints the rejection's error.
    await expect(absent.cleanup(1000)).resolves.toBeUndefined();
    // The store's folder is a FILE: readdir fails (ENOTDIR), which reaches cleanup's outer catch.
    const base = mkdtempSync(join(tmpdir(), 'dedup-'));
    writeFileSync(join(base, 'wf'), 'not a folder');
    const unreadable = new FileDedupStore(base, 'wf');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // (1) red when the outer catch rethrows (cleanup then rejects); (2) prints the rejection's
      //     error.
      await expect(unreadable.cleanup(1000)).resolves.toBeUndefined();
    } finally {
      errors.mockRestore();
    }
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
      await store.record('k', 100);
      // (1) red when a recorded key is not seen before its TTL; (2) prints the boolean.
      expect(await store.check('k')).toBe(true); // live BEFORE the TTL — the causal half
      await vi.advanceTimersByTimeAsync(60_000); // ≫ TTL
      await store.cleanup(0);
      // (1) red when an expired key survives cleanup (the break: `check` always resolves true);
      //     (2) prints the boolean.
      expect(await store.check('k')).toBe(false); // expired AFTER — driven by the clock, not a race
    } finally {
      vi.useRealTimers();
    }
  });
});

// issue #715 (a) (D6-23): the cleanup error throttle is a process-local duration on the monotonic
// clock. `performance.now()` is process uptime, so the throttle starts at −∞: the FIRST failure prints
// even in a process younger than 60 s. (a) red when the site still reads `Date.now()`, or the initial
// value is 0; (b) prints the number of error lines.
describe('FileDedupStore cleanup — the error throttle is monotonic (issue #715 (a))', () => {
  it('D12 two failures within 60 s print one line, a third after 60 s prints another; the first prints at 1 s of uptime', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dedup-715a-'));
    // The store's folder is a FILE: every cleanup's readdir fails (ENOTDIR) and reaches the throttle.
    writeFileSync(join(base, 'wf'), 'not a folder');
    const store = new FileDedupStore(base, 'wf');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const now = vi.spyOn(performance, 'now');
    try {
      now.mockReturnValue(1_000);
      await store.cleanup(60_000);
      now.mockReturnValue(30_000);
      await store.cleanup(60_000);
      now.mockReturnValue(70_000);
      await store.cleanup(60_000);
      expect(errors.mock.calls.length, 'error lines').toBe(2);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
