// pending-redos-22.test.ts — CodeQL #22: `endsWithCommand`'s tokenizer (`commandTokens`) is a one-pass
// scan, not the regular expression it replaced. Three cells: the scan gives the old pattern's tokens on
// every short string over the characters that matter and on the shapes that break it; it gives them on
// long random strings over a wider alphabet (line terminators and Unicode spaces); and the slow shape
// is fast.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { commandTokens, endsWithCommand } from './pending.js';

// The pattern of `endsWithCommand`'s tokenizer at 8b5e8940, kept here only to prove the scan matches
// it — never to be used by code.
const LEGACY_TOKENS = /<(?:[^>'\\]|\\.|'[^']*')*>|(?:[^\s'\\]|\\.|'[^']*')+/g;
const legacy = (s: string): string[] => s.match(LEGACY_TOKENS) ?? [];

/** A string as a failure prints it: printable ASCII kept, every other character `<U+XXXX>`, JSON-quoted. */
const spelled = (s: string): string =>
  JSON.stringify(
    [...s]
      .map((c) => {
        const p = c.codePointAt(0)!;
        return p >= 0x20 && p <= 0x7e ? c : `<U+${p.toString(16).toUpperCase().padStart(4, '0')}>`;
      })
      .join(''),
  );

/** The first input whose scan tokens differ from the pattern's, and how many inputs were checked. */
function firstDifference(inputs: Iterable<string>): {
  checked: number;
  first: { index: number; input: string; scan: string[]; legacy: string[] } | null;
} {
  let checked = 0;
  let first: { index: number; input: string; scan: string[]; legacy: string[] } | null = null;
  for (const s of inputs) {
    if (first === null) {
      const scan = commandTokens(s);
      const old = legacy(s);
      if (scan.length !== old.length || scan.some((t, k) => t !== old[k])) {
        first = {
          index: checked,
          input: spelled(s),
          scan: scan.map(spelled),
          legacy: old.map(spelled),
        };
      }
    }
    checked += 1;
  }
  return { checked, first };
}

/** Every string over `alphabet` of length 1..`maxLength`, shortest first: a counter, no recursion. */
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

/** `count` strings of 8 to 47 symbols from `alphabet`, from a seeded xorshift (the same every run). */
function* seeded(alphabet: readonly string[], count: number, seed: number): Generator<string> {
  let x = seed >>> 0;
  const next = (): number => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
  for (let k = 0; k < count; k += 1) {
    const length = 8 + (next() % 40);
    let s = '';
    for (let j = 0; j < length; j += 1) s += alphabet[next() % alphabet.length]!;
    yield s;
  }
}

describe('CodeQL #22: the command tokenizer is a one-pass scan with the old pattern as its language', () => {
  it('commandTokens gives the old pattern tokens on all 960,799 strings over seven characters up to length 7, and on the probes', () => {
    const alphabet = ['<', '>', "'", '\\', 'a', ' ', '\n'];
    const probes = [
      "<'>'", // a `>` inside a closed quote does not close the placeholder
      '<\\>',
      '<>',
      'x <', // `<` at the end
      'a\\', // a trailing backslash
      'a\\\nb', // a backslash before a newline
      "'a 'b 'c",
      "<'a'b'>",
      "realm run x <one of: 'yes>' 'no'>",
      "a'b", // no closing quote
      '<<<<',
      '<a <a <a',
    ];
    const { checked, first } = firstDifference([...everyString(alphabet, 7), ...probes]);
    // (1) Can it fail: red when the scan's placeholder, word, quote or escape rule differs from the
    //     old pattern on any string here — the named break: inside a closed quoted span, a `>` closes
    //     the placeholder (the first difference is then `<'>'`); also red when the corpus is not
    //     960,799 + 12 strings (a counter that skips strings checks less than it says).
    // (2) Prints: the strings checked, and the first differing string (its index, the input and both
    //     token lists, non-ASCII spelled `<U+XXXX>`): synthetic text, no secret in it.
    expect({ checked, first }).toEqual({ checked: 960_799 + probes.length, first: null });
  });

  it('commandTokens gives the old pattern tokens on 40,000 seeded random strings with line terminators and Unicode spaces', () => {
    const alphabet = [
      '<',
      '>',
      "'",
      '\\',
      'a',
      ' ',
      '\n',
      '\r',
      '\u2028',
      '\u2029',
      '\u00A0',
      '\uFEFF',
      '\u00E9',
      'realm',
      '--',
      '\t',
    ];
    const { checked, first } = firstDifference(seeded(alphabet, 40_000, 616));
    // (1) Can it fail: red when the scan differs on a shape the seven-character corpus cannot hold —
    //     the named break: U+2028 dropped from the line terminators (a backslash before it then
    //     escapes it; the exhaustive cell stays green); also red when the corpus is not 40,000 strings.
    // (2) Prints: as the cell above — the strings checked and the first difference, spelled.
    expect({ checked, first }).toEqual({ checked: 40_000, first: null });
  });

  it("endsWithCommand on 'realm ' and 27,000 `<a ` pairs with no `>` returns false in under 2,000 ms", () => {
    const text = 'realm ' + '<a '.repeat(27_000);
    const t0 = performance.now();
    const ends = endsWithCommand(text);
    const ms = performance.now() - t0;
    // (1) Can it fail: red when the tokenizer is the old pattern again (the named break: restore the
    //     `match` line), which takes 7.8 s on this input here (8.4–10.6 s on a loaded machine).
    // (2) Prints: the milliseconds measured and the bound (`expected <ms> to be less than 2000`).
    expect(ms).toBeLessThan(2_000);
    // (1) Can it fail: red when this text is taken for a command (its tokens are `realm`, then `<a`
    //     repeated: no command shape); none of the named breaks turns it red (see the report).
    // (2) Prints: the boolean.
    expect(ends).toBe(false);
  });
});
