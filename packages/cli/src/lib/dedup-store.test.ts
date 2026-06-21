// Tests for dedup stores. The shared suite runs against both implementations.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDedupStore, InMemoryDedupStore } from './dedup-store.js';
import type { DedupStore } from './dedup-store.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const cases: Array<[string, () => DedupStore]> = [
  ['FileDedupStore', () => new FileDedupStore(mkdtempSync(join(tmpdir(), 'dedup-')), 'wf')],
  ['InMemoryDedupStore', () => new InMemoryDedupStore()],
];

describe.each(cases)('%s', (_name, factory) => {
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
    const store = factory();
    store.record('k', 100);
    await sleep(150);
    expect(store.check('k', 100)).toBe(false);
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
  it('evicts expired entries', async () => {
    const store = new InMemoryDedupStore();
    store.record('k', 100);
    await sleep(150);
    store.cleanup(0);
    expect(store.check('k')).toBe(false);
  });
});
