// redaction-variants.test.ts — cell 19 (GHSA-gxfq): one pin per kind of form `variantsOf` lists,
// and the 8-character floor on base64 forms.
//
// Each expected form is written BY HAND here (computed with Python's json, base64 and urllib, never
// with the code under test), and checked with `includes`. Every value is a FAKE written in this
// file.
//
// Each pin names (a) its break — run and seen red — and (b) what it prints on failure: which pin,
// and a boolean. Since the correction several members write the same form, so a pin that no single
// break turns red is a preservation guard; it names the P2 rows (`redaction-printers.test.ts`)
// where each of those members is discriminated.
import { describe, expect, it } from 'vitest';
import { variantsOf } from './redaction-variants.js';

/** (b) prints which pin failed and `false`; never the list. */
function lists(value: string, form: string, pin: string): void {
  expect(variantsOf(value).includes(form), `${pin}: variantsOf lists the hand-written form`).toBe(
    true,
  );
}

describe('variantsOf — one pin per kind (GHSA-gxfq cell 19)', () => {
  it('(a) the value itself', () => {
    // (a) preservation guard since the correction: the value comes back through the JSON layers
    //     (a value with nothing to escape is its own JSON form), so no single break turns it red;
    //     each layer's own discrimination is its P2 row: E1, E2.
    lists('plain-secret-1', 'plain-secret-1', '(a)');
  });

  it('(b) the JSON-escaped form', () => {
    // (a) preservation guard since the correction; each member's own discrimination is its P2 row:
    //     E1, J3, J4a, J5–J9, J11, Q6, Q7, Q7b, Q8, Q8L, Q9, Q9b, Q10, Q11, Q14, Q15, R1, S4.
    lists('ab"cd\\ef', 'ab\\"cd\\\\ef', '(b)');
  });

  it('(c) the twice-escaped form', () => {
    // (a) preservation guard since the correction; each member's own discrimination is its P2 row:
    //     E2, and E1 over each of (b)'s members. Red when E1 and E2 are removed together.
    lists('ab"cd\\ef', 'ab\\\\\\"cd\\\\\\\\ef', '(c)');
  });

  it("(d) Go's HTML-safe form, lowercase hex", () => {
    // (a) preservation guard since the correction; each member's own discrimination is its P2 row:
    //     J3, J9.
    lists('x<y>&z\u2028', 'x\\u003cy\\u003e\\u0026z\\u2028', '(d)');
  });

  it('(e) the ASCII-only form, lowercase hex', () => {
    // (a) preservation guard since the correction; each member's own discrimination is its P2 row:
    //     E1, E2, J5, J6, Q7b.
    lists('na\u00efve', 'na\\u00efve', '(e)');
  });

  it("(f) PHP's escaped slash, over the escaped and over the ASCII form", () => {
    // (a) red when J4a is removed (the first half) or J5 (the second).
    lists('\u00e9/x', '\u00e9\\/x', '(f) from the escaped form');
    lists('\u00e9/x', '\\u00e9\\/x', '(f) from the ASCII form');
  });

  it('(g) base64: untrimmed, and trimmed at shifts 0, 1 and 2', () => {
    // (a) red when B1 is removed (its untrimmed form). The trimmed and shifted forms are a
    //     preservation guard since the correction (B1 and B2 write each; P2 rows B1, B2): red when
    //     the trim, the shift-1 or the shift-2 forms are dropped from B1 and B2 together.
    lists('abcdefghij', 'YWJjZGVmZ2hpag==', '(g) untrimmed');
    lists('abcdefghij', 'YWJjZGVmZ2hpa', '(g) shift 0, trimmed');
    lists('abcdefghij', 'YmNkZWZnaGlq', '(g) shift 1');
    lists('abcdefghij', 'Y2RlZmdoaW', '(g) shift 2, trimmed');
  });

  it('(h) the URL-encoded form', () => {
    // (a) preservation guard since the correction; each member's own discrimination is its P2 row:
    //     U1, U2, U3.
    lists('a b&c', 'a%20b%26c', '(h)');
  });

  it('(i) each line of 8 or more characters with no whitespace, with its own forms', () => {
    const value = 'line-one-ok\nshort\n  spaced line here  \r\nlinetwo-xyz';
    // (a) red when LINES is removed; the base64 line also when B1 is removed.
    lists(value, 'line-one-ok', '(i) first line');
    lists(value, 'linetwo-xyz', '(i) line after a CRLF');
    lists(value, 'bGluZS1vbmUtb2s=', '(i) a line through the encoders (base64)');
    // (a) red when the floor or the whitespace rule is removed from the lines.
    expect(variantsOf(value).includes('short'), '(i) a short line is not listed').toBe(false);
    expect(variantsOf(value).includes('spaced line here'), '(i) a spaced line is not listed').toBe(
      false,
    );
  });

  it('the floor: a 4-byte value lists only itself, its untrimmed base64, its base64url alone and its hex', () => {
    // Both hex forms of `pass` are equal; every shifted or prefixed base64 form, and every
    // base64url form but the value's own, is under 8 characters; no empty string is listed.
    // `cGFzcw` is the base64url of the value encoded alone, kept at the floor of its PADDED length
    // (`cGFzcw==`, 8 characters).
    // (a) red when the 8-character floor on base64 forms is removed from B1 and B2 (then the shorter
    //     shifted and prefixed forms join), when B1 is removed, or when the base64url form of
    //     the value alone is floored after its padding is stripped (`cGFzcw` leaves). (b) prints
    //     the list of this fixed fake value — never a redaction set.
    expect(variantsOf('pass')).toEqual(['pass', 'cGFzcw==', 'cGFzcw', '70617373']);
  });
});
