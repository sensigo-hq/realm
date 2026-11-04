// cacheability-size-3b.test.ts — caching 3-B, F2 (MA1-3B-01; MA 2's rulings of 2026-11-04): a stable
// block known by its size alone. (d) Its token interval is the one its text gives, through ONE
// formula; and two steps' size blocks are compared by their `group` only. Each cell names (a) the
// change that turns it red and (b) what it prints: the intervals, shares and divergence segments.
import { describe, it, expect } from 'vitest';
import {
  cacheTokenInterval,
  cacheTokenIntervalOfSize,
  describeCacheability,
  type CacheBlock,
  type CacheSizeBlock,
} from './cacheability.js';

const asciiOf = (t: string): number => [...t].filter((c) => c.charCodeAt(0) < 0x80).length;

describe('caching 3-B F2 (d) — a size gives the interval its text gives', () => {
  it('over an ASCII-only, a mixed and an astral head, with and without --ratio', () => {
    const heads = {
      ascii: 'You review support tickets.\nTicket: ',
      mixed: 'Résumé: répondez en français, s’il vous plaît. ',
      astral: 'Escalate 🚨 when the 客户 is upset 😠: ',
    };
    const differ: string[] = [];
    for (const [name, text] of Object.entries(heads)) {
      let ascii = 0;
      for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) < 0x80) ascii += 1;
      for (const opts of [{}, { ratio: { chars_per_token: 4 } }]) {
        const a = cacheTokenInterval(text, opts);
        const b = cacheTokenIntervalOfSize({ chars: text.length, asciiChars: ascii }, opts);
        if (a.low !== b.low || a.high !== b.high) differ.push(`${name} ${JSON.stringify(opts)}`);
      }
    }
    // (a) red when the size path uses another formula (or drops the ASCII count); (b) prints the
    //     heads and options that differ.
    expect(differ).toEqual([]);
    // The astral head has code units outside ASCII that are not single characters: the count is
    // of UTF-16 code units, as the text path counts them.
    expect(heads.astral.length > [...heads.astral].length).toBe(true);
    expect(asciiOf(heads.ascii)).toBe(heads.ascii.length);
  });
});

const text = (name: string, t: string): CacheBlock => ({
  name,
  text: t,
  stable: true,
  segments: [{ name, start: 0, end: t.length }],
});
const head = (chars: number, group: number): CacheSizeBlock => ({
  name: 'prompt-head',
  chars,
  asciiChars: chars,
  stable: true,
  group,
});
const SYSTEM = 'You are Realm. Answer with JSON matching the schema.';

describe('caching 3-B F2 — two size blocks are the same only when their groups are', () => {
  it('equal groups: the whole fixed part is shared; different groups: they part at prompt-head', () => {
    const [a, b, c] = describeCacheability([
      { step: 'a', blocks: [text('system', SYSTEM), head(48, 0)] },
      { step: 'b', blocks: [text('system', SYSTEM), head(48, 0)] },
      { step: 'c', blocks: [text('system', SYSTEM), head(48, 1)] },
    ]);
    // (a) red when size blocks are compared by size alone (c would share whole), or the
    //     comparison does not stop at a different group; (b) prints each share.
    expect({
      a: a!.shares_with.map((s) => [s.step, s.chars, s.divergence_at]),
      size: a!.prefix.chars,
      c: c!.shares_with.map((s) => [s.step, s.chars, s.divergence_at]),
    }).toEqual({
      a: [
        ['b', SYSTEM.length + 48, null],
        ['c', SYSTEM.length, 'prompt-head'],
      ],
      size: SYSTEM.length + 48,
      c: [
        ['a', SYSTEM.length, 'prompt-head'],
        ['b', SYSTEM.length, 'prompt-head'],
      ],
    });
    expect(b!.shares_with[0]!.divergence_at).toBe(null);
  });
});
