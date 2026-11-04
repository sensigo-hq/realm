// redaction-redos.test.ts — CodeQL #28: `scrubEmail` (the e-mail scrub of a stored error body) is a
// linear scan, not the regular expression it replaced. Two cells: the scan redacts exactly what the
// old pattern redacted on every short string over the characters that matter (a redaction line is
// always tested), and it stays fast on the analyser's own pump string.
import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { scrubEmail } from './redaction.js';

// The pattern of `scrubEmail` at 941bc877, kept here only to prove the scan matches it — never to be
// used by code.
const LEGACY_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

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

describe('CodeQL #28: scrubEmail is a linear scan with the old pattern as its language', () => {
  it('scrubEmail redacts what the old pattern redacted on all 299,592 strings over eight characters up to length 6, and on the probes', () => {
    const alphabet = ['a', '1', '_', '@', '.', '+', '-', ' '];
    const probes = [
      'a@b.c+d@e.f', // both redacted: a match's domain ends at the `+`, and a new local part starts there
      'a@b.c.+x@y.z',
      '+a@b.c',
      '-a@b.c',
      '.a@b.c',
      'a@b',
      'a@.c',
      '@b.c',
      'a@b.c@d.e',
      'a.b@c-d.e.f',
      'aaaa@bbbb',
      'x+y@z.w-v',
    ];
    let checked = 0;
    let first: { index: number; input: string; scan: string; legacy: string } | null = null;
    for (const s of [...everyString(alphabet, 6), ...probes]) {
      const scan = scrubEmail(s);
      const legacy = s.replace(LEGACY_EMAIL, '[REDACTED_EMAIL]');
      if (first === null && scan !== legacy) {
        first = {
          index: checked,
          input: JSON.stringify(s),
          scan: JSON.stringify(scan),
          legacy: JSON.stringify(legacy),
        };
      }
      checked += 1;
    }
    // (1) Can it fail: red when the scan's run rule, domain rule or resume point differs from the old
    //     pattern on any string here — the named break: `domainEnd` accepts an empty tail (`return
    //     r;` without the `r === q + 1` check), so `'a@a.'` becomes `[REDACTED_EMAIL]`; also red when
    //     the corpus is not 299,592 + 12 strings.
    // (2) Prints: the strings checked, and the first differing string (its index, the input, both
    //     outputs) — synthetic text over eight characters, no address or secret of anyone's.
    expect({ checked, first }).toEqual({ checked: 299_592 + probes.length, first: null });
  });

  it('scrubEmail on 80,000 `+` characters returns in under 500 ms, unchanged', () => {
    const text = '+'.repeat(80_000);
    const t0 = performance.now();
    const out = scrubEmail(text);
    const ms = performance.now() - t0;
    // (1) Can it fail: red when `scrubEmail` is the old pattern again (the named break: its body back
    //     to `s.replace(LEGACY_EMAIL, '[REDACTED_EMAIL]')`), which takes 10–16 s on this input here.
    // (2) Prints: the milliseconds measured and the bound.
    expect(ms).toBeLessThan(500);
    // (1) Can it fail: red when the scrub changes a text with no `@` (nothing can be an address);
    //     none of the named breaks turns it red (see the report).
    // (2) Prints: the output's length and whether it equals the input — never the 80,000 characters.
    expect({ length: out.length, unchanged: out === text }).toEqual({
      length: 80_000,
      unchanged: true,
    });
  });
});
