// The disclosure law's class guard (E-1''): no change to the law hides less of a planted credential
// value than the frozen references hid. The references are round 1's law (a3bf69b1), correction 2's
// law frozen at its delivery commit (6ec70b57), correction 3's frozen at its working commit
// (019f310d), correction 4's (7a8b3154), correction 5's (c26ee972), correction 6's (e9cc21ae) and
// correction 7's (39f345f8, re-frozen at its correction 1), each frozen at the working-branch commit
// that last changed the law.
//
// Red first, on correction 1's law: R2-L1-07 (`${NAME:default}`), R2-L1-08 (a member spelling part
// of the name), R2-L1-09 (tails after a quote) and the `==` half of R2-L1-10. NOT red on R2-L1-03
// (round 1 had no flag rule, so it never hid that value), on R2-L1-04's canaries (both laws hide
// them; the current law over-hides there) or on the ODBC half of R2-L1-10 (round 1 showed it too):
// those have their own cells in redaction.test.ts. R2-L1-04's first shape IS red on I11, which this
// cell asserts on every text.
//
// Red first, on correction 2's law (H-3''): R3-L1-08 (a value opened by an escaped quote while that
// quote's token is open earlier on its line: `\'` after `can\'t` or a non-apostrophe `\'`, `\\"`,
// `\\\"`), R3-L1-10 (a credential name right after a backslash: `C:\app\token:`, `\\token==`),
// R3-L1-12 (`it\'s`, then `ab\'cd` in a value) and PR3-C3AUD2-05 (two `\"`-quoted values glued, raw
// and in a JSON log), named and generated. NOT red on R3-L1-08's flag shape (round 1 had no flag
// rule; correction 2's reference is that law) or on the glued `\'` pair (correction 2 hides both
// when no quote is open): their cells are in redaction.test.ts.
//
// Red first, on correction 3's law (S3, per reference): round 4's I-1 shapes (an escaped-quote-opened
// value with a leading blank or tab and no closer on its line) against correction 2 only — it hid
// them by over-hiding; round 1 and correction 3 show them — and the generator's one I-1 template
// (66 of 20,000, against correction 2 only); I-2's `'` glued pairs against round 1 only. I-2's `"`
// pairs are red against no reference (every one shows the second half): their red is the unit
// cell's in redaction.test.ts.
//
// Red first, on correction 4's law (S2, per reference): correction 5's J-1 `\"` shape (a value whose
// closer stands on the next line) against correction 2 only — it hid the second line by over-hiding;
// round 1, correction 3 and correction 4 show it — and the generator's next-line template (194 of
// 20,000, against correction 2 only). The `\'` shape is red against no reference (every one shows
// its second line): its red is the unit cell's. The level-0 shapes are red against none (every
// reference hides them); after the fix the canaries on the lines after an unclosed level-0 quote
// show — `l0-bound`, the fourth allowed difference, on the owner's word.
//
// What it reaches is what the generator produces (problem 3 of the correction's ledger): a shape a
// review finds joins the generator.
import { describe, expect, it } from 'vitest';
import * as round1 from '../test-support/disclosure-law/round-1/redaction.js';
import * as correction2 from '../test-support/disclosure-law/correction-2/redaction.js';
import * as correction3 from '../test-support/disclosure-law/correction-3/redaction.js';
import * as correction4 from '../test-support/disclosure-law/correction-4/redaction.js';
import * as correction5 from '../test-support/disclosure-law/correction-5/redaction.js';
import * as correction6 from '../test-support/disclosure-law/correction-6/redaction.js';
import * as correction7 from '../test-support/disclosure-law/correction-7/redaction.js';
import {
  ALLOWED_DIFFERENCES,
  NAMED_SHAPES,
  compareLaws,
  generateTexts,
  lawOf,
  type DifferentialFinding,
} from '../test-support/disclosure-law/generator.js';
import * as current from './redaction.js';

const CURRENT = lawOf(current);
// Round 1's law, for the leaks it hid; correction 2's, frozen at its delivery, for what both
// corrections added (the flag rule, PEM bodies, the new names, `.` segments, the A1 forms, the URL
// userinfo forms); correction 3's, for its escaped-quote values and names read through an escape's
// letter; correction 4's, for the blank before an unclosed escaped value and the same-quote tail.
// At correction 4's delivery the fourth is the current law itself.
const REFERENCES = [
  lawOf(round1),
  lawOf(correction2),
  lawOf(correction3),
  lawOf(correction4),
  lawOf(correction5),
  lawOf(correction6),
  lawOf(correction7),
];

/** A finding as one line: the rule the canary was planted under, then the text (canaries only). */
const describeFindings = (fs: readonly DifferentialFinding[]): string =>
  fs
    .slice(0, 12)
    .map((f) => `${f.kind} ${f.shape ?? f.rule ?? ''}: ${JSON.stringify(f.text)}`)
    .join('\n');

describe('the disclosure differential (E-1)', () => {
  it('the allowed differences are exactly R30’s quote in a URL userinfo, R29’s third escape level and correction 5’s level-0 bound (E-2’s tail left at correction 7)', () => {
    // (a) red when a kind is added or dropped without its record (`e2-tail` back: a glued tail the
    //     law showed again would be exempt); (b) prints the kinds.
    expect([...ALLOWED_DIFFERENCES].sort()).toEqual(['l0-bound', 'r29-level3', 'r30-url-quote']);
  });

  it('the named round-2, round-3, round-4, correction-5, correction-6 and correction-7 shapes: every canary a reference hid stays hidden, and I11 holds', () => {
    const findings = compareLaws(CURRENT, REFERENCES, NAMED_SHAPES);
    // (a) red when the law shows a named shape's canary that a reference hid, or a second pass
    //     changes the first's output (correction 5's law shows the CRLF continuation's parts);
    //     (b) prints the count and up to 12 findings (the rule or shape, the text: fake canaries).
    expect(findings.length, describeFindings(findings)).toBe(0);
  });

  it('20,000 generated texts (seed 20261018): every planted canary a reference hid stays hidden, and I11 holds', () => {
    const texts = generateTexts(20261018, 20000);
    // The generator plants under every rule, the allowed ones included.
    const rules = new Set(texts.flatMap((t) => t.planted.map((p) => p.rule)));
    expect([...rules].sort()).toEqual(
      [
        // Correction 7: `e2-tail` left the kinds — every glued tail is planted `tail` and guarded.
        'flag',
        // Correction 5 (J-1): the next-line template's later-line canaries.
        'l0-bound',
        'member',
        'name',
        'pem',
        'quoted-tail',
        'r29-level3',
        'r30-url-quote',
        'scheme',
        'tail',
        'token-run',
        'url',
      ].sort(),
    );
    const findings = compareLaws(CURRENT, REFERENCES, texts);
    // (a) the rules list is red when the generator stops planting a rule (`l0-bound` named under
    //     `name`); the count is red when a planted canary a reference hid shows, or I11 breaks
    //     (`l0-bound` dropped from the allowed kinds); (b) prints the rules and up to 12 findings.
    expect(findings.length, describeFindings(findings)).toBe(0);
  }, 120_000);
});
