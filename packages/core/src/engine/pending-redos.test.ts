// pending-redos.test.ts — CodeQL #27: `visibleText` (the text as a reader sees it, read by every
// sentence rule) is a linear scan, not the regular expression it replaced. Two cells: the scan
// returns what the old pattern returned on every short string over the characters that matter, and
// it stays fast on the analyser's own pump string.
import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { visibleText, withFullStop } from './pending.js';

// The pattern of `visibleText` at 941bc877, kept here only to prove the scan matches it — never to
// be used by code.
const LEGACY_VISIBLE = /\uE000[^\uE001\uE002]*\uE001|\uE002/g;

/** Every string over `alphabet` of length 1..`maxLength`, shortest first: a counter in base
 *  `alphabet.length`, no recursion. */
function* everyString(alphabet: readonly string[], maxLength: number): Generator<string> {
  const k = alphabet.length;
  for (let length = 1; length <= maxLength; length += 1) {
    const digits = new Array<number>(length).fill(0);
    for (;;) {
      yield digits.map((d) => alphabet[d]!).join('');
      let p = length - 1;
      while (p >= 0 && digits[p] === k - 1) {
        digits[p] = 0;
        p -= 1;
      }
      if (p < 0) break;
      digits[p] = digits[p]! + 1;
    }
  }
}

/** A string as a failure message prints it: printable ASCII kept, every other character spelled
 *  `<U+XXXX>`, then JSON-quoted (the private-use marks print as nothing in a terminal). */
const spelled = (s: string): string =>
  JSON.stringify(
    [...s]
      .map((c) => {
        const p = c.codePointAt(0)!;
        return p >= 0x20 && p <= 0x7e ? c : `<U+${p.toString(16).toUpperCase().padStart(4, '0')}>`;
      })
      .join(''),
  );

describe('CodeQL #27: visibleText is a linear scan with the old pattern as its language', () => {
  it('visibleText returns what the old pattern returned on all 335,922 strings over six characters up to length 7, and on the probes', () => {
    const alphabet = ['a', ' ', '.', '\uE000', '\uE001', '\uE002'];
    const probes = [
      '\uE000a\uE000b\uE001', // two openers before one closer
      '\uE000a\uE002\uE000b\uE001',
      '\uE000\uE000\uE000',
      'plain',
      '\uE000x\uE001\uE000y\uE001',
      '\uE002\uE000a\uE001',
      '\uE001', // a lone closer is kept
    ];
    let checked = 0;
    let first: { index: number; input: string; scan: string; legacy: string } | null = null;
    for (const s of [...everyString(alphabet, 7), ...probes]) {
      const scan = visibleText(s);
      const legacy = s.replace(LEGACY_VISIBLE, '');
      if (first === null && scan !== legacy) {
        first = { index: checked, input: spelled(s), scan: spelled(scan), legacy: spelled(legacy) };
      }
      checked += 1;
    }
    // (1) Can it fail: red when the scan's resume point, terminator rule or drop rule differs from
    //     the old pattern on any string here — the named break: after a match, resume at `t`
    //     instead of `t + 1` (`'<U+E000><U+E001>'` then keeps its closer); also red when the corpus
    //     is not 335,922 + 7 strings (a counter that skips strings checks less than it says).
    // (2) Prints: the strings checked, and the first differing string (its index, the input, both
    //     outputs), synthetic text with the marks spelled — no secret can be in it.
    expect({ checked, first }).toEqual({ checked: 335_922 + probes.length, first: null });
  });

  it('withFullStop on 80,000 U+E000 characters returns in under 500 ms, with a full stop added', () => {
    const text = '\uE000'.repeat(80_000);
    const t0 = performance.now();
    const out = withFullStop(text);
    const ms = performance.now() - t0;
    // (1) Can it fail: red when `visibleText` is the old pattern again (the named break: its body
    //     back to `text.replace(LEGACY_VISIBLE, '')`), which takes 7–14 s on this input here.
    // (2) Prints: the milliseconds measured and the bound (`expected <ms> to be less than 500`).
    expect(ms).toBeLessThan(500);
    // (1) Can it fail: red when withFullStop stops returning the input with one full stop for a
    //     text with no closer (no U+E001, so nothing is hidden and the visible text ends in U+E000,
    //     no sentence terminal); none of the named breaks turns it red (see the report).
    // (2) Prints: the output's length and whether it starts with the input and ends `<U+E000>.` —
    //     never the 80,000 characters.
    expect({
      length: out.length,
      startsWithInput: out.startsWith(text),
      endsWithStop: out.endsWith('\uE000.'),
    }).toEqual({ length: 80_001, startsWithInput: true, endsWithStop: true });
  });
});
