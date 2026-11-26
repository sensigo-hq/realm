// locate-quote-rules-845.test.ts — #845 unit 1a's reading rules (`prompts/fix-845-1a-character-reading.md`),
// one cell per acceptance check, each shown red once by its named break. This file holds unit 1a-i's
// half: check 1 (invisible characters leave first), check 2 (a mark stays with its letter, never with
// a number), check 6 (the sets, read in the Basic Multilingual Plane) and check 7 (the spacing
// accent). Unit 1a-ii adds checks 3, 4 and 5 and the sets' reads outside the BMP (check 6's other
// half) here; check 8 is in locate-quote.test.ts. Every input is written as code points.
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  canonicalForm,
  canonicalMap,
  locateQuote,
  releaseQuoteCache,
  segmentsOf,
} from './locate-quote.js';

const ch = String.fromCodePoint;
const hex = (c: number): string => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
/** Every code point from `from` to `to` that `re` matches, computed as the running Node reads
 *  Unicode (surrogates skipped). */
const codePoints = (re: RegExp, from = 0, to = 0x10ffff): number[] => {
  const out: number[] = [];
  for (let c = from; c <= to; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (re.test(ch(c))) out.push(c);
  }
  return out;
};
const BMP = 0xffff;
const state = (quote: string, source: string): string => {
  releaseQuoteCache();
  const r = locateQuote(quote, source);
  return r.state + (r.cut_short === true ? '+cut_short' : '');
};
type Row = readonly [member: string, got: string, want: string];
/** Each row that reads otherwise, as `member: got (want …)`. */
const misses = (rows: readonly Row[]): string[] =>
  rows
    .filter(([, got, want]) => got !== want)
    .map(([m, got, want]) => `${m}: ${got} (want ${want})`);
/** A guard prints the count it checks when it fails, never `true` or `false`. */
const atLeast = (members: readonly unknown[], floor: number): number | string =>
  members.length >= floor ? `at least ${floor}` : members.length;

const F = 'The Landlord shall insure the Building';
/** UAX #29's Prepend format characters (`PREPEND_SIGNS`, copied: the module does not export it). */
const PREPEND = [
  0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x110bd,
  0x110cd,
];
/** The invisible set, computed: `\p{Cf}` ∪ `\p{Default_Ignorable_Code_Point}`, the 13 Prepend out. */
const INVISIBLE = codePoints(/^[\p{Cf}\p{Default_Ignorable_Code_Point}]$/u).filter(
  (c) => !PREPEND.includes(c),
);
/** The 50 spacing accents (NFKC = U+0020 and one or more marks). */
const ACCENTS = codePoints(/^[^]$/u).filter((c) => /^ \p{M}+$/u.test(ch(c).normalize('NFKC')));

describe('#845 check 1: invisible characters leave first', () => {
  it('the cases: S3, items 1, 6 and 7, the Prepend signs, `é` across U+034F and U+200B', () => {
    const rows: Row[] = [
      // S3: an invisible character inside a number never splits it
      ['S3 12 / 12+U+00AD+500', state('the fee is 12', 'the fee is 12\u{ad}500 euro'), 'not_found'],
      [
        'S3 1 2 / 1 2+U+00AD+00 000',
        state('the rent is 1 2', 'the rent is 1 2\u{ad}00 000 euro'),
        'not_found',
      ],
      ['S3 5 / -+U+200B+5', state('5 degrees', '-\u{200b}5 degrees'), 'not_found'],
      [
        'S3 200 000 / 1+U+200B+ 200 000',
        state('200 000 euro', '1\u{200b} 200 000 euro'),
        'not_found',
      ],
      ['S3 9 / 9:+U+200B+30', state('at 9', 'at 9:\u{200b}30 the Tenant arrives'), 'not_found'],
      // item 1: a whole word across U+FEFF is the word; a quote that ends at it is not
      [
        'item 1 unlawful across U+FEFF',
        state('unlawful use of the Premises', 'any un\u{feff}lawful use of the Premises'),
        'reformatted',
      ],
      [
        'item 1 lawful use after U+FEFF',
        state('lawful use of the Premises', 'any un\u{feff}lawful use of the Premises'),
        'not_found',
      ],
      // items 6 and 7: a leading decimal, and a sign, across an invisible character
      [
        'item 6 75% / .+U+200B+75%',
        state('75% of the cost', 'pays .\u{200b}75% of the cost'),
        'not_found',
      ],
      [
        'item 6 75% / ,+U+200B+75%',
        state('75% of the cost', 'pays ,\u{200b}75% of the cost'),
        'not_found',
      ],
      [
        'item 7 48,000 / €+U+FEFF+48,000',
        state('48,000 a year', 'The rent is €\u{feff}48,000 a year.'),
        'not_found',
      ],
      // a composition across an invisible character forms (the canonical form leaves it out first)
      [
        'é / e+U+034F+U+0301',
        state('the café is open', 'the cafe\u{34f}\u{301} is open'),
        'reformatted',
      ],
      [
        'é / e+U+200B+U+0301',
        state('the café is open', 'the cafe\u{200b}\u{301} is open'),
        'reformatted',
      ],
      // the Prepend signs are visible number signs: one binds the number after it
      ...PREPEND.map((p): Row => [
        `5 rupees after ${hex(p)}`,
        state('5 rupees', `The fee is ${ch(p)}5 rupees.`),
        'not_found',
      ]),
      ['15 rupees / 1+U+0600+5', state('15 rupees', 'The fee is 1\u{600}5 rupees.'), 'not_found'],
    ];
    // (1) red when an invisible character is left in until after NFKC (the two `é` rows), a Prepend
    //     sign is read as invisible (its rows), or one splits a number or a word (S3, items 1, 6, 7);
    //     (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('the sweep: every invisible code point inside `unlawful`: the whole word reads `reformatted`, the cut quote `not_found`', () => {
    const doc = (x: number) =>
      `The Tenant shall not permit any un${ch(x)}lawful use of the Premises.`;
    const rows: Row[] = INVISIBLE.flatMap((x): Row[] => [
      [`${hex(x)} whole`, state('unlawful use of the Premises', doc(x)), 'reformatted'],
      [`${hex(x)} cut`, state('lawful use of the Premises', doc(x)), 'not_found'],
    ]);
    // (1) red when an invisible character makes a word edge, or a Prepend sign is counted with them;
    //     (2) prints the count swept and each differing member.
    expect({
      swept: atLeast(INVISIBLE, 4_000),
      prependOut: PREPEND.filter((p) => INVISIBLE.includes(p)).map(hex),
      misses: misses(rows),
    }).toEqual({ swept: 'at least 4000', prependOut: [], misses: [] });
  });

  it('whitespace is `\\p{White_Space}`: a stop before U+0085 ends a sentence in a quote, a stop before U+FEFF does not', () => {
    // (1) red when `SPACE` is JavaScript's `\s` again (U+FEFF a space, U+0085 none); (2) prints the
    //     two readings.
    expect({
      nel: segmentsOf('Alpha beta.\u{85}gamma delta')[0]?.endsSentence,
      feff: segmentsOf('Alpha beta.\u{feff}gamma delta')[0]?.endsSentence,
    }).toEqual({ nel: true, feff: false });
  });
});

describe('#845 check 2: a mark stays with its letter, never with a number', () => {
  it("the cases: NEW-3, the stray marks (MA 2's call C1 (a)), the Turkish İ", () => {
    const rows: Row[] = [
      ['NEW-3 5 / -+U+0301+5', state('5 degrees', 'It is -\u{301}5 degrees.'), 'not_found'],
      ['NEW-3 75% / .+U+0301+75%', state('75%', 'rate .\u{301}75% a year'), 'not_found'],
      // a mark on no letter: at a quote's start or after a space it is set aside
      [
        'stray [0] quote opens U+0301',
        state(
          '\u{301}lawful use of the Premises',
          'The Tenant shall make lawful use of the Premises.',
        ),
        'reformatted',
      ],
      [
        'stray [1] the+U+0020+U+0301+cafe',
        state('the cafe', 'the \u{301}cafe here'),
        'reformatted',
      ],
      // after an invisible character it lands on the letter before (rule 1 removes the invisible first)
      [
        'stray [2] source cafe+U+200B+U+0301',
        state('cafe', 'the cafe\u{200b}\u{301} here'),
        'not_found',
      ],
      [
        'stray [3] quote cafe+U+200B+U+0301',
        state('cafe\u{200b}\u{301}', 'the cafe here'),
        'not_found',
      ],
      // a mark lower-casing adds (U+0130 → i + U+0307) leaves
      [
        'İ Istanbul / U+0130+stanbul',
        state('Istanbul office', '\u{130}stanbul office'),
        'reformatted',
      ],
      [
        'İ istanbul / U+0130+STANBUL',
        state('istanbul office', '\u{130}STANBUL OFFICE'),
        'reformatted',
      ],
      ['İ U+0130+zmir / IZMIR', state('\u{130}zmir office', 'IZMIR OFFICE'), 'reformatted'],
    ];
    // (1) red when a mark on a digit or a sign is kept (the NEW-3 rows), or the mark decision is taken
    //     after lower-casing (the İ rows); (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('the sweep: every `\\p{M}` between `-` and its digit, and between two digits: no part of the number reads found', () => {
    const marks = codePoints(/^\p{M}$/u);
    const rows: Row[] = marks.flatMap((m): Row[] => [
      [`${hex(m)} after -`, state('5 degrees', `It is -${ch(m)}5 degrees.`), 'not_found'],
      [`${hex(m)} between digits`, state('5 euro', `the fee 3${ch(m)}5 euro`), 'not_found'],
    ]);
    // (1) red when a mark is kept after a digit or a sign, or the canonical form keeps one between two
    //     digits; (2) prints the count swept and each differing member.
    expect({ swept: atLeast(marks, 2_500), misses: misses(rows) }).toEqual({
      swept: 'at least 2500',
      misses: [],
    });
  });
});

describe('#845 check 6: the sets (read in the Basic Multilingual Plane; outside it, unit 1a-ii)', () => {
  const rent = 'The Tenant shall pay the Rent';
  const lc = 'the Tenant shall pay the insurance rent';
  const Cap = 'The Tenant shall pay the insurance rent';

  it('a lowercase letter, `\\p{Lowercase}`: an exact quote ending `approx.` is marked before each (items 12: ª, º, ⅳ)', () => {
    const approx = 'The area is not less than approx.';
    // a mark with the property (U+0345) attaches to the stop, so no exact quote ends before it
    const members = codePoints(/^\p{Lowercase}$/u, 0, BMP).filter((c) => !/^\p{M}$/u.test(ch(c)));
    const rows: Row[] = [
      ...members.map((c): Row => [
        hex(c),
        state(approx, `${approx} ${ch(c)}12 square metres.`),
        'exact+cut_short',
      ]),
      ['control U+0041', state(approx, `${approx} A12 square metres.`), 'exact'],
    ];
    // (1) red when the set is `\p{Ll}` again (ª, º, ⅳ and the other Other_Lowercase rows); (2)
    //     prints each differing member.
    expect({
      named: [0xaa, 0xba, 0x2173].filter((c) => !members.includes(c)).map(hex),
      misses: misses(rows),
    }).toEqual({
      named: [],
      misses: [],
    });
  });

  it("number joiners: `,` `.` `/` `:` `-`, `'` U+2019 U+2018 U+066C U+066B, and their NFKC forms, between two digits refuse part of the number (NEW-4)", () => {
    const joiners = [0x2c, 0x2e, 0x2f, 0x3a, 0x2d, 0x27, 0x2019, 0x2018, 0x66c, 0x66b];
    const forms = [0xff0e, 0xff0c, 0x2024, 0xfe52, 0xfe50, 0xff07];
    const rows: Row[] = [
      ...[...joiners, ...forms].map((j): Row => [
        hex(j),
        state('the price is 1', `the price is 1${ch(j)}000 euro`),
        'not_found',
      ]),
      [
        'CHF 1 / 1+U+0027+000+U+0027+000',
        state('CHF 1', 'Price CHF 1\u{27}000\u{27}000 net.'),
        'not_found',
      ],
      [
        '000+U+2019+000 / 1+U+2019+000+U+2019+000',
        state('000\u{2019}000', '1\u{2019}000\u{2019}000'),
        'not_found',
      ],
      ['control U+003B', state('the price is 1', 'the price is 1;000 euro'), 'exact'],
    ];
    // (1) red when the joiners are main's five again (the `'` U+2019 U+2018 U+066C U+066B rows), or
    //     the literal layer stops reading a joiner's NFKC form (the full-width rows); (2) prints each
    //     differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('group spaces, every `\\p{Zs}`: `1 200` written with that space is not found in `1 200 000` written with it (Outside-a)', () => {
    const spaces = codePoints(/^\p{Zs}$/u);
    const rows: Row[] = [
      ...spaces.map((s): Row => [
        hex(s),
        state(`the rent is 1${ch(s)}200`, `the rent is 1${ch(s)}200${ch(s)}000 euro`),
        'not_found',
      ]),
      [
        'control U+00B7',
        state('the rent is 1\u{b7}200', 'the rent is 1\u{b7}200\u{b7}000 euro'),
        'exact',
      ],
    ];
    // (1) red when the group spaces are main's four again (U+2007, U+2008, U+3000 … read found); (2)
    //     prints each differing row.
    expect({
      named: [0x2007, 0x2008, 0x3000].filter((s) => !spaces.includes(s)).map(hex),
      misses: misses(rows),
    }).toEqual({
      named: [],
      misses: [],
    });
  });

  it('line breaks, UAX #14’s mandatory breaks: each starts a line, so a list item after `:` and it reads `stitched`; a blank does not (FF as a line start)', () => {
    const breaks = [0x0a, 0x0d, 0x0b, 0x0c, 0x85, 0x2028, 0x2029];
    const item = (between: number) =>
      state(`${F} … ${lc}`, `${F} for its cost:${ch(between)}- ${lc} at the end of each year.`);
    const rows: Row[] = [
      ...breaks.map((b): Row => [hex(b), item(b), 'stitched']),
      ['control U+2003 (a blank)', item(0x2003), 'not_found'],
      ['control U+0020 (a blank)', item(0x20), 'not_found'],
    ];
    // (1) red when the line breaks are main's four again (U+000B, U+000C and U+0085 read as blanks);
    //     (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('blanks, `\\p{White_Space}` but the line breaks: a sentence after a stop and a blank is skipped onto (the gap rows: U+2003, U+00A0)', () => {
    const lineBreaks = [0x0a, 0x0d, 0x0b, 0x0c, 0x85, 0x2028, 0x2029];
    const blanks = codePoints(/^\p{White_Space}$/u).filter((c) => !lineBreaks.includes(c));
    const skip = (between: string) =>
      state(
        `${F} … ${Cap}`,
        `${F} for its full reinstatement cost.${between}${Cap} at the end of each year.`,
      );
    const rows: Row[] = [
      ...blanks.map((b): Row => [hex(b), skip(ch(b)), 'stitched']),
      // a line break after the stop counts too, by its own rule (VT, FF, NEL: the gap rows)
      ...[0x0b, 0x0c, 0x85].map((b): Row => [`${hex(b)} (a line break)`, skip(ch(b)), 'stitched']),
      ['control U+005F', skip('_'), 'not_found'],
    ];
    // (1) red when the blanks are a plain space and a tab again (U+00A0, U+2003 … refused); (2)
    //     prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('list marks: every dash, `*` `+` `>` `|`, the BULLET characters, `○` `●` `■` `▪` `·` and U+F0B7 open an item at a counted line start (items 3, 11)', () => {
    const marks = [
      ...codePoints(/^\p{Pd}$/u, 0, BMP),
      0x2212,
      0x2796,
      0x02d7,
      0x2a,
      0x2b,
      0x3e,
      0x7c,
      0x2022,
      0x2023,
      0x2043,
      0x204c,
      0x204d,
      0x2219,
      0x25d8,
      0x25e6,
      0x29be,
      0x29bf,
      0x2619,
      0x2765,
      0x2767,
      0x25cb,
      0x25cf,
      0x25a0,
      0x25aa,
      0xb7,
      0xf0b7,
    ];
    const item = (m: string) =>
      state(
        `${F} … ${lc}`,
        `${F} for its full reinstatement cost.\n${m} ${lc} at the end of each year.`,
      );
    const rows: Row[] = [
      ...marks.map((m): Row => [hex(m), item(ch(m)), 'stitched']),
      ['a run of #', item('##'), 'stitched'],
      ['control U+2605 ★', item('\u{2605}'), 'not_found'],
      ['control U+2053 (not a dash)', item('\u{2053}'), 'not_found'],
    ];
    // (1) red when the list marks are main's ten again (`+`, `○`, `●`, `■`, `>`, U+F0B7, U+2010,
    //     U+2212 … refused); (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('opening marks, `\\p{Ps}` `\\p{Pi}` `"` `\'` but `{`: a part may open right after one after a stop (1.4)', () => {
    const marks = codePoints(/^[\p{Ps}\p{Pi}"']$/u, 0, BMP).filter((c) => c !== 0x7b);
    const after = (o: string) =>
      state(
        `${F} … ${lc}`,
        `${F} for its full reinstatement cost. ${o}${lc} at the end of each year.`,
      );
    const rows: Row[] = [
      ...marks.map((o): Row => [hex(o), after(ch(o)), 'stitched']),
      ['control U+007B {', after('{'), 'not_found'],
      ['control U+0029 )', after(')'), 'not_found'],
    ];
    // (1) red when the opening marks are main's eight again (U+2039, U+27E8, U+300C, U+2045 … refused),
    //     or `{` joins them; (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('closing marks, `\\p{Pe}` `\\p{Pf}` `"` `\'`: an exact quote is marked past each, and a part may follow a stop and one (CLOSING, 1.4)', () => {
    const marks = codePoints(/^[\p{Pe}\p{Pf}"']$/u, 0, BMP);
    const rows: Row[] = [
      ...marks.flatMap((c): Row[] => [
        [
          `${hex(c)} cut_short`,
          state(`${rent}.`, `${rent}.${ch(c)} and more on demand.`),
          'exact+cut_short',
        ],
        [
          `${hex(c)} a part after it`,
          state(
            `${F} … ${Cap}`,
            `${F} for its full reinstatement cost.${ch(c)} ${Cap} at the end of each year.`,
          ),
          'stitched',
        ],
      ]),
      ['control U+0028 ( cut_short', state(`${rent}.`, `${rent}.( and more on demand.`), 'exact'],
    ];
    // (1) red when the closing marks are main's again (U+203A, U+300D, U+FF09, U+27E9 … not walked
    //     past); (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it("E3's two rows: `-`+U+00A0+`the` after `:` is a list item; the stitched `can´t` row is not found", () => {
    // (1) red when U+00A0 stops being a blank, or `´` stops being dropped between letters; (2) prints
    //     the two states.
    expect({
      nbsp: state(
        `${F} … the Tenant shall pay the insurance rent`,
        `${F} for its full reinstatement cost:\n-\u{a0}the Tenant shall pay the insurance rent at the end of each year.`,
      ),
      canAcute: state(
        'The Landlord of the Building can … The Tenant shall pay the rent monthly.',
        'The Landlord of the Building can\u{b4}t insure it. The Tenant shall pay the rent monthly.',
      ),
    }).toEqual({ nbsp: 'stitched', canAcute: 'not_found' });
  });
});

describe('#845 check 7: the spacing accent', () => {
  it("between letters it is dropped like punctuation: `can't` against `can´t` reads `reformatted`, every accent", () => {
    const rows: Row[] = ACCENTS.map((a): Row => [
      hex(a),
      state("the Landlord can't refuse", `the Landlord can${ch(a)}t refuse`),
      'reformatted',
    ]);
    // (1) red when NFKC's space is kept between letters (`can t` is two words); (2) prints the count
    //     and each differing accent.
    expect({ swept: atLeast(ACCENTS, 50), misses: misses(rows) }).toEqual({
      swept: 'at least 50',
      misses: [],
    });
  });

  it('between two digits it is a separator kept as itself: `CHF 1`, `PRICE CHF 1 000 000` and `PRICE CHF 1000000` are none of them found in `Price CHF 1´000´000`, every accent', () => {
    const rows: Row[] = ACCENTS.flatMap((a): Row[] => {
      const doc = `Price CHF 1${ch(a)}000${ch(a)}000 net.`;
      return [
        [`${hex(a)} CHF 1`, state('Price CHF 1', doc), 'not_found'],
        [`${hex(a)} spaced`, state('PRICE CHF 1 000 000', doc), 'not_found'],
        [`${hex(a)} unspaced`, state('PRICE CHF 1000000', doc), 'not_found'],
      ];
    });
    // (1) red when the accent is NFKC-normalised between digits (`1 000 000` reads `reformatted`), or
    //     is no joiner there (`CHF 1` reads found); (2) prints each differing row.
    expect({ canonical: canonicalForm('1\u{b4}000'), misses: misses(rows) }).toEqual({
      canonical: '1\u{b4}000',
      misses: [],
    });
  });

  it('next to one digit it reads as a space: `25` stays found in `25˚C`; a no-break space stays a space', () => {
    // (1) red when the accent is dropped next to one digit (`25c` clashes); (2) prints the states.
    expect({
      degree: state('THE TEMPERATURE IS 25', 'The temperature is 25\u{2da}C at noon.'),
      acute: state('IN THE 1990', 'in the 1990\u{b4}s'),
      noBreakSpace: state('the rent', 'the\u{a0}rent'),
    }).toEqual({ degree: 'reformatted', acute: 'reformatted', noBreakSpace: 'reformatted' });
  });
});

// ---------------------------------------------------------------------------------------------------
// #845 1a-i, correction 1 (`prompts/fix-845-1a-i-correction-1.md`): a run of spacing accents is read
// in time proportional to its length, and its readings do not move.

/** check 1's shapes: a run of `n` characters. */
const COST_SHAPES: Record<string, (n: number) => string> = {
  acute: (n) => '\u{b4}'.repeat(n),
  acute_zwsp: (n) => '\u{b4}\u{200b}'.repeat(n / 2),
  acute_mark: (n) => '\u{b4}\u{301}'.repeat(n / 2),
  double_low_line: (n) => '\u{2017}'.repeat(n),
  macron: (n) => '\u{af}'.repeat(n),
};
/** check 1's places: the document, and the honest quote of the text around and across the run. */
const COST_PLACES: Record<string, (run: string) => { doc: string; drop: string }> = {
  sentence: (run) => ({ doc: `Price ${run} end`, drop: 'Price end' }),
  digits: (run) => ({ doc: `Price 1${run}000 end`, drop: 'Price 1000 end' }),
};

/**
 * The character reads one call makes: each call of `String.prototype.normalize`, `codePointAt`,
 * `charCodeAt` and `slice`, and each step of the string iterator. Plain counting wrappers, no call
 * log (a recording spy runs the worker out of memory here), installed around the call and restored
 * in `finally`.
 */
function readsOf(work: () => void): number {
  const proto = String.prototype as unknown as Record<string | symbol, unknown>;
  const names = ['normalize', 'codePointAt', 'charCodeAt', 'slice'] as const;
  const saved = names.map((n) => proto[n] as (this: string, a?: unknown, b?: unknown) => unknown);
  const savedIterator = proto[Symbol.iterator] as (this: string) => Iterator<string>;
  let reads = 0;
  try {
    names.forEach((n, k) => {
      const original = saved[k]!;
      proto[n] = function (this: string, a?: unknown, b?: unknown) {
        reads++;
        return original.call(this, a, b);
      };
    });
    proto[Symbol.iterator] = function (this: string) {
      const it = savedIterator.call(this);
      return {
        next: () => {
          reads++;
          return it.next();
        },
        [Symbol.iterator]() {
          return this;
        },
      };
    };
    work();
  } finally {
    names.forEach((n, k) => {
      proto[n] = saved[k];
    });
    proto[Symbol.iterator] = savedIterator;
  }
  return reads;
}

describe('#845 1a-i correction 1, check 1: a run of spacing accents is read in time proportional to its length', () => {
  const N = 1000;
  for (const [shape, runOf] of Object.entries(COST_SHAPES)) {
    for (const [place, at] of Object.entries(COST_PLACES)) {
      for (const form of ['drop', 'copy'] as const) {
        it(`${shape}, ${place}, the quote ${form === 'drop' ? 'around the run' : 'holding the run'}: reads at 2N at most 2.5 times those at N`, () => {
          const readsAt = (n: number): number => {
            const { doc, drop } = at(runOf(n));
            releaseQuoteCache();
            return readsOf(() => {
              locateQuote(form === 'drop' ? drop : doc, doc);
            });
          };
          const atN = readsAt(N);
          const at2N = readsAt(2 * N);
          const ratio = Math.round((at2N / atN) * 100) / 100;
          console.log(
            `check 1 ${shape} ${place} ${form}: ${String(atN)} → ${String(at2N)} reads, ×${String(ratio)}`,
          );
          // (1) red when each accent of a run is decided by walking the whole run (about ×4 at
          //     acafed92); (2) prints the reads at N and 2N and the ratio.
          expect({ atN, at2N, ratio, linear: at2N <= 2.5 * atN }).toEqual({
            atN,
            at2N,
            ratio,
            linear: true,
          });
        }, 120_000);
      }
    }
  }
});

describe('#845 1a-i correction 1, check 2 (GROUNDING, not acceptance): the readings do not move', () => {
  it("every spacing accent in runs of 1, 2, 3, 31 and 64, alone or with U+200B or U+0301 between its members, in six places, and check 1's inputs: each canonicalMap (text, from, to) is acafed92's", () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/accent-runs-845.json', import.meta.url), 'utf8'),
    ) as { accents: string[]; groups: Record<string, { in: string; out: string }> };
    const digest = (v: unknown): string =>
      createHash('sha256').update(JSON.stringify(v), 'utf8').digest('hex').slice(0, 32);
    const LENGTHS = [1, 2, 3, 31, 64];
    const SEPARATORS = ['', '\u{200b}', '\u{301}'];
    const PLACES: Record<string, (run: string) => string> = {
      digits: (run) => `Price CHF 1${run}000 net.`,
      after_digit: (run) => `It is 25${run}C at noon.`,
      before_digit: (run) => `Call x${run}5 now.`,
      letters: (run) => `The tenant can${run}t sublet.`,
      start: (run) => `${run}Start of the text.`,
      end: (run) => `End of the text${run}`,
    };
    const groups: Array<[key: string, inputs: string[]]> = [];
    for (const a of ACCENTS) {
      for (const [place, mk] of Object.entries(PLACES)) {
        const run = (n: number, sep: string): string =>
          Array.from({ length: n }, () => ch(a)).join(sep);
        groups.push([
          `${hex(a)} ${place}`,
          SEPARATORS.flatMap((sep) => LENGTHS.map((n) => mk(run(n, sep)))),
        ]);
      }
    }
    for (const [shape, runOf] of Object.entries(COST_SHAPES)) {
      for (const [place, at] of Object.entries(COST_PLACES)) {
        const { doc, drop } = at(runOf(1000));
        groups.push([`cost ${shape} ${place}`, [doc, drop]]);
      }
    }
    const moved = groups
      .filter(
        ([key, inputs]) => fixture.groups[key]?.out !== digest(inputs.map((t) => canonicalMap(t))),
      )
      .map(
        ([key, inputs]) =>
          `${key}: ${inputs
            .slice(0, 3)
            .map((t) => JSON.stringify(canonicalMap(t).text))
            .join(' | ')} …`,
      );
    // The fixture's precondition: the same accents, groups and inputs as at acafed92.
    expect({
      accents: ACCENTS.map(hex),
      groups: groups.map(([key]) => key).sort(),
      inputs: groups
        .filter(([key, inputs]) => fixture.groups[key]?.in !== digest(inputs))
        .map(([key]) => key),
    }).toEqual({
      accents: fixture.accents,
      groups: Object.keys(fixture.groups).sort(),
      inputs: [],
    });
    // (1) red when an accent is decided by the characters right beside it instead of past its run,
    //     or the scan past the run stops after 30 characters; (2) prints each group whose maps moved,
    //     with the first texts it reads now.
    expect(moved).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------
// #845 unit 1a-ii (`prompts/fix-845-1a-ii-code-point-reads.md`): rules 3, 4 and 5, and the sets read
// outside the Basic Multilingual Plane.

/** A skip `F … second` against `F` + `between` + `second` and the rest of a sentence. */
const skipOver = (between: string, second: string): string =>
  state(`${F} … ${second}`, `${F}${between}${second} at the end of each year.`);
const INSURANCE = 'The Tenant shall pay the insurance rent';
const KEEP = 'Keep the Premises in good and substantial repair';

describe('#845 check 3: every walk over raw text steps over invisible characters, in both texts', () => {
  it('the cases: NEW-5, V-25, NEW-6, the honest `cost.`+X+` The` rows, a stop inside the quote, `9:`+U+200B+`30`', () => {
    const rows: Row[] = [
      // the abbreviation read (NEW-5, V-25): `e.`+X+`g.` is still `e.g.`, so no skip lands after it
      ...[0x200b, 0x034f, 0xfe0f, 0x3164].map((x): Row => [
        `e.${hex(x)}g. The`,
        skipOver(` for its cost, e.${ch(x)}g. `, INSURANCE),
        'not_found',
      ]),
      ['control e.g. The', skipOver(' for its cost, e.g. ', INSURANCE), 'not_found'],
      // both cut_short reads (NEW-6, V-25): the stop's next character is read past them
      [
        'approx.+SP+U+200B+412',
        state(
          'The area is not less than approx.',
          'The area is not less than approx. \u{200b}412 square metres.',
        ),
        'exact+cut_short',
      ],
      [
        'approx.+U+200B+SP+412',
        state(
          'The area is not less than approx.',
          'The area is not less than approx.\u{200b} 412 square metres.',
        ),
        'exact+cut_short',
      ],
      [
        'approx.+U+034F+SP+412',
        state(
          'The area is not less than approx.',
          'The area is not less than approx.\u{34f} 412 square metres.',
        ),
        'exact+cut_short',
      ],
      // the blanks before a part (AUD2-07): an honest skip after a stop and an invisible character
      ...[0x034f, 0x3164, 0x200b, 0xfe0f, 0xfeff, 0x2060].map((x): Row => [
        `cost.${hex(x)} The`,
        skipOver(` for its full reinstatement cost.${ch(x)} `, INSURANCE),
        'stitched',
      ]),
      // the sentence end inside a quote: `.`+U+FEFF+`The` has no space after the stop, so it is none
      [
        'a quote with .+U+FEFF+The inside it',
        state(
          `${F} for its cost.\u{feff}The Tenant shall pay the insurance rent`,
          `${F} for its cost. The Landlord agrees. The Tenant shall pay the insurance rent at the end of each year.`,
        ),
        'not_found',
      ],
      [
        'control: the same with . and a space',
        state(
          `${F} for its cost. The Tenant shall pay the insurance rent`,
          `${F} for its cost. The Landlord agrees. The Tenant shall pay the insurance rent at the end of each year.`,
        ),
        'stitched',
      ],
      // the read after `:` (A-12): `9:`+U+200B+`30` is still a time, so no part opens on `30`
      [
        '9 in 9:+U+200B+30',
        state('The meeting is at 9', 'The meeting is at 9:\u{200b}30 each day.'),
        'not_found',
      ],
      [
        'a part opening on 30 after 9:+U+200B',
        state(
          `${F} … 30 minutes later the Tenant shall pay the insurance rent`,
          `${F} for its cost at 9:\u{200b}30 minutes later the Tenant shall pay the insurance rent.`,
        ),
        'not_found',
      ],
    ];
    // (1) red when a walk reads an invisible character as a character (an `e.`+X+`g.` skip lands, the
    //     honest skips are refused, `approx.` is left unmarked); (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('the sweeps: every invisible character in each walk rule 3 lists, each read as the walk reads no character at all', () => {
    const lc = 'the Tenant shall pay the insurance rent';
    const walks: Array<[walk: string, read: (x: string) => string]> = [
      ['the abbreviation read', (x) => skipOver(` for its cost, e.${x}g. `, INSURANCE)],
      [
        "the exact quote's cut_short read",
        (x) =>
          state(
            'The area is not less than approx.',
            `The area is not less than approx.${x} 412 square metres.`,
          ),
      ],
      [
        'the sentence end inside a quote',
        (x) =>
          state(
            `The Tenant shall pay the Rent.${x} and the rates`,
            'THE TENANT SHALL PAY THE RENT AND THE RATES ON THE USUAL QUARTER DAYS.',
          ),
      ],
      [
        'the blanks before a part',
        (x) => skipOver(` for its full reinstatement cost.${x} `, INSURANCE),
      ],
      [
        'the reads over closing marks',
        (x) => skipOver(` for its full reinstatement cost.${x}) `, INSURANCE),
      ],
      [
        'the line-start read',
        (x) => skipOver(` for its full reinstatement cost.${x}\n`, INSURANCE),
      ],
      // the list-mark read back steps over them inside a run of `#` (before the run, `blanksBack` has)
      [
        'the list-mark read back',
        (x) => skipOver(` for its full reinstatement cost.\n#${x}# `, lc),
      ],
      // the clause-number read back, inside the label
      [
        'the clause-number read back',
        (x) => skipOver(` for its full reinstatement cost.\n(b${x}) `, KEEP),
      ],
      // the read of a clause number at a part's start, quoted with the label after `:`
      [
        "the clause number at a part's start",
        (x) =>
          state(
            `${F} … 2) ${lc}`,
            `${F} for its full reinstatement cost:\n2${x}) ${lc} at the end of each year.`,
          ),
      ],
      // the span trim takes the brackets both texts have, past them
      [
        'the span trim',
        (x) => {
          const doc = `Clause 5 says (${x}The Landlord shall insure the Building) today.`;
          releaseQuoteCache();
          const part = locateQuote('(The Landlord shall insure the Building)', doc).parts[0];
          const span = part === undefined ? '' : doc.slice(part.start, part.end);
          return `${span.slice(0, 1)}…${span.slice(-1)}`;
        },
      ],
      [
        'the read after `:`',
        (x) =>
          skipOver(
            ` for its cost at 9:${x}`,
            '30 minutes later the Tenant shall pay the insurance rent',
          ),
      ],
    ];
    const differing = walks.flatMap(([walk, read]) => {
      const want = read('');
      return INVISIBLE.filter((x) => read(ch(x)) !== want).map(
        (x) => `${walk}: ${hex(x)} ${read(ch(x))} (want ${want}, as with none)`,
      );
    });
    // (1) red when a walk stops at an invisible character, or steps only over `\p{Cf}` (U+034F, U+FE0F
    //     and U+3164 then read as characters); (2) prints the count swept and each differing member.
    expect({ swept: atLeast(INVISIBLE, 4000), differing }).toEqual({
      swept: 'at least 4000',
      differing: [],
    });
  }, 60_000);

  it('E4, closed by 1b-i (M8r): a list mark directly before a word after `:` and a line break, with no blank or only invisible characters between, reads `not_found`; so does `2.`+U+200B+`Send`', () => {
    // #845 1b-i (M8r) re-pin: a list mark counts only with a blank after it; 1a's E4 read these
    // `stitched` until 1b-i (check 7 sweeps the class at every counted line start).
    const lc = 'the Tenant shall pay the insurance rent';
    const marks = [
      ...codePoints(/^\p{Pd}$/u),
      0x2212,
      0x2796,
      0x02d7,
      0x2a,
      0x2b,
      0x3e,
      0x7c,
      0x2022,
      0x2023,
      0x2043,
      0x204c,
      0x204d,
      0x2219,
      0x25d8,
      0x25e6,
      0x29be,
      0x29bf,
      0x2619,
      0x2765,
      0x2767,
      0x25cb,
      0x25cf,
      0x25a0,
      0x25aa,
      0xb7,
      0xf0b7,
    ];
    const rows: Row[] = [
      ...marks.flatMap((m): Row[] => [
        [`${hex(m)}the`, skipOver(` for its full reinstatement cost:\n${ch(m)}`, lc), 'not_found'],
        [
          `${hex(m)}+U+200B+the (extra2 row 123's class)`,
          skipOver(` for its full reinstatement cost:\n${ch(m)}\u{200b}`, lc),
          'not_found',
        ],
      ]),
      [
        '2.+U+200B+Send',
        state(
          `${F} … Send the notice to the Tenant`,
          `${F} for its full reinstatement cost:\n2.\u{200b}Send the notice to the Tenant.`,
        ),
        'not_found',
      ],
    ];
    // (1) red when a mark glued to its word, or with only U+200B after it, opens an item again, or
    //     `2.`+U+200B+`Send` opens a part; (2) prints the count and each differing row.
    expect({ marks: marks.length, misses: misses(rows) }).toEqual({
      marks: marks.length,
      misses: [],
    });
  });
});

describe('#845 check 4: every neighbour is read by code point', () => {
  it('the cases: the astral hyphens, U+10400 opening a part, item 13 after `approx. `, NEW-2, A9, and a quote opening or ending inside an astral number', () => {
    const D = '\u{1d7ce}';
    const rows: Row[] = [
      ...[0x10d6e, 0x10ead].map((d): Row => [
        `5 after ${hex(d)}`,
        state('5 degrees', `The reading is ${ch(d)}5 degrees today.`),
        'not_found',
      ]),
      [
        'U+10400 opens a part after ". "',
        skipOver(' for its cost. ', '\u{10400} shall pay the insurance rent'),
        'stitched',
      ],
      [
        'approx. U+1D41A (an astral lowercase letter)',
        state(
          'The area is not less than approx.',
          'The area is not less than approx. \u{1d41a}bout 412 square metres.',
        ),
        'exact+cut_short',
      ],
      [
        'approx. U+1D7CE (an astral digit)',
        state(
          'The area is not less than approx.',
          'The area is not less than approx. \u{1d7ce}412 square metres.',
        ),
        'exact+cut_short',
      ],
      ...[0x1d400, 0x104a0, 0x1d7ce, 0x10107].map((c): Row => [
        `5 after ${hex(c)}`,
        state('5 rupees', `The fee is ${ch(c)}5 rupees.`),
        'not_found',
      ]),
      [
        'lawful in un+U+20000+lawful',
        state(
          'lawful use of the Premises',
          'The Tenant shall not permit any un\u{20000}lawful use of the Premises.',
        ),
        'not_found',
      ],
      [
        'The fee is 1+U+0336 in 1+U+0336+,000',
        state('The fee is 1\u{336}', 'The fee is 1\u{336},000 a year'),
        'not_found',
      ],
      // the number edges read the quote's own first and last characters by code point
      [
        'a quote opening on an astral digit inside a number',
        state(`${D}${D} rupees`, `The fee is 7${D}${D} rupees.`),
        'not_found',
      ],
      [
        'a quote ending on an astral digit inside a number',
        state(`The fee is 7${D}`, `The fee is 7${D}${D} rupees.`),
        'not_found',
      ],
      [
        'control: the whole astral number',
        state(`The fee is 7${D}${D} rupees`, `The fee is 7${D}${D} rupees.`),
        'exact',
      ],
      // the number edge alone decides here: after a number's separator the word edge has no letter
      [
        "a quote opening on an astral digit after a number's separator",
        state(`${D}${D}${D} rupees`, `The fee is 1,${D}${D}${D} rupees.`),
        'not_found',
      ],
      [
        'control: the number with its separator',
        state(`1,${D}${D}${D} rupees`, `The fee is 1,${D}${D}${D} rupees.`),
        'exact',
      ],
    ];
    // (1) red when a neighbour is read as one UTF-16 unit (a hyphen outside the BMP leaves `5` found,
    //     U+10400 opens no part, a quote ends inside an astral number); (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('nearest rounds the longest found piece down to a code-point boundary: `x`+U+20000+U+20001 gives 16–28 (E5)', () => {
    releaseQuoteCache();
    const r = locateQuote(
      'the rent x\u{20000}\u{20001} now due',
      'The Tenant pays the rent x\u{20000}\u{20002} here',
    );
    // (1) red when the round-down is removed (the piece ends inside U+20000); (2) prints the state and
    //     where `nearest` lies.
    expect({
      state: r.state,
      nearest: r.nearest === undefined ? null : [r.nearest.start, r.nearest.end],
    }).toEqual({
      state: 'not_found',
      nearest: [16, 28],
    });
  });
});

describe('#845 check 5: initials and initialisms', () => {
  it('the cases: items 8 and 8b, V-26, `U.S.`, `U.K.`, `U.S.A.`, `J.R.R.`, and the control `J. Smith`', () => {
    const capital = 'Capital rules apply to the Tenant at all times';
    const rows: Row[] = [
      ['E+U+0301. (item 8)', skipOver(' for its cost to E\u{301}. ', capital), 'not_found'],
      ['U+1D400. (item 8)', skipOver(' for its cost to \u{1d400}. ', capital), 'not_found'],
      ['control: É. written whole', skipOver(' for its cost to \u{c9}. ', capital), 'not_found'],
      ['ℝ. (item 8b)', skipOver(' for its cost to \u{211d}. ', capital), 'not_found'],
      ['U+03D2. (item 8b)', skipOver(' for its cost to \u{3d2}. ', capital), 'not_found'],
      ['Q+U+0301. (V-26)', skipOver(' for its cost to Q\u{301}. ', capital), 'not_found'],
      ...['U.S.', 'U.K.', 'U.S.A.', 'J.R.R.'].map((a): Row => [
        a,
        skipOver(` for its cost in the ${a} `, capital),
        'not_found',
      ]),
      [
        'control: J. Smith',
        skipOver(' for its cost to J. ', 'Smith shall pay the costs of entry'),
        'not_found',
      ],
      [
        'control: a.m. (a lowercase initialism) still ends a sentence',
        skipOver(' for its cost before 9 a.m. ', capital),
        'stitched',
      ],
    ];
    // (1) red when an initial is only a letter that changes when lowercased (ℝ, U+03D2, U+1D400 and
    //     the decomposed É then end a sentence), or the initialisms end one; (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('the sweep: every `\\p{Lu}` and `\\p{Lt}` code point, in every plane, followed by `. ` and a capital, ends no sentence', () => {
    const CAPITALS = codePoints(/^[\p{Lu}\p{Lt}]$/u);
    const capital = 'Capital rules apply to the Tenant at all times';
    const ending = CAPITALS.filter(
      (c) => skipOver(` for its cost to ${ch(c)}. `, capital) !== 'not_found',
    ).map(hex);
    // (1) red when a capital, in any plane, is no initial; (2) prints the count swept and each capital
    //     a skip lands after.
    expect({ swept: atLeast(CAPITALS, 1800), ending }).toEqual({
      swept: 'at least 1800',
      ending: [],
    });
  }, 60_000);
});

describe('#845 check 6, outside the Basic Multilingual Plane: lowercase letters, digits, capitals and the two dashes', () => {
  const approx = (c: string) =>
    state(
      'The area is not less than approx.',
      `The area is not less than approx. ${c}412 square metres.`,
    );
  it('lowercase letters: every astral `\\p{Lowercase}` after `approx. ` marks the quote; control U+10400, a capital', () => {
    const members = codePoints(/^\p{Lowercase}$/u, 0x10000);
    const rows: Row[] = [
      ...members.map((c): Row => [hex(c), approx(ch(c)), 'exact+cut_short']),
      ['control U+10400', approx('\u{10400}'), 'exact'],
    ];
    // (1) red when the lowercase read is limited to the BMP; (2) prints the count and each differing row.
    expect({ swept: atLeast(members, 900), misses: misses(rows) }).toEqual({
      swept: 'at least 900',
      misses: [],
    });
  });

  it('digits: every astral `\\p{Nd}` after `approx. ` marks the quote; control U+10107, a number that is no digit', () => {
    const members = codePoints(/^\p{Nd}$/u, 0x10000);
    const rows: Row[] = [
      ...members.map((c): Row => [hex(c), approx(ch(c)), 'exact+cut_short']),
      ['control U+10107', approx('\u{10107}'), 'exact'],
    ];
    // (1) red when the digit read is limited to the BMP; (2) prints the count and each differing row.
    expect({ swept: atLeast(members, 390), misses: misses(rows) }).toEqual({
      swept: 'at least 390',
      misses: [],
    });
  });

  it('capitals: every astral `\\p{Lu}` or `\\p{Lt}` opens a part after `. `; control U+1D41A, a lowercase letter', () => {
    const members = codePoints(/^[\p{Lu}\p{Lt}]$/u, 0x10000);
    const opens = (c: string) => skipOver(' for its cost. ', `${c} shall pay the insurance rent`);
    const rows: Row[] = [
      ...members.map((c): Row => [hex(c), opens(ch(c)), 'stitched']),
      ['control U+1D41A', opens('\u{1d41a}'), 'not_found'],
    ];
    // (1) red when the capital read is limited to the BMP; (2) prints the count and each differing row.
    expect({ swept: atLeast(members, 740), misses: misses(rows) }).toEqual({
      swept: 'at least 740',
      misses: [],
    });
  });

  it('dashes: the two astral `\\p{Pd}` read as `-` and open an item as a list mark; control U+1D400, a letter', () => {
    const members = codePoints(/^\p{Pd}$/u, 0x10000);
    const lc = 'the Tenant shall pay the insurance rent';
    const asMinus = (c: string) => state('-5 degrees', `The reading is ${c}5 degrees today.`);
    const opensItem = (c: string) => skipOver(` for its full reinstatement cost.\n${c} `, lc);
    const rows: Row[] = [
      ...members.flatMap((c): Row[] => [
        [`${hex(c)} as -`, asMinus(ch(c)), 'reformatted'],
        [`${hex(c)} a list mark`, opensItem(ch(c)), 'stitched'],
      ]),
      ['control U+1D400 as -', asMinus('\u{1d400}'), 'not_found'],
      ['control U+1D400 a list mark', opensItem('\u{1d400}'), 'not_found'],
    ];
    // (1) red when the dash read is limited to the BMP; (2) prints the members and each differing row.
    expect({ members: members.map(hex), misses: misses(rows) }).toEqual({
      members: ['U+10D6E', 'U+10EAD'],
      misses: [],
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// #845 1a-ii correction 1 (`prompts/fix-845-1a-ii-correction-1.md`): a quote carrying a run of
// invisible characters is read in time proportional to its length, and its readings do not move.

/** correction 1's runs: the four invisible characters the walk found read in quadratic time. */
const INVISIBLE_RUNS: Record<string, string> = {
  'U+200B': '\u{200b}',
  'U+00AD': '\u{ad}',
  'U+FEFF': '\u{feff}',
  'U+FE0F': '\u{fe0f}',
};
const RENT = 'The Tenant pays the rent monthly in advance.';
/** correction 1's places: a quote and its document, with the run inside the quote. */
const RUN_PLACES: Record<string, (run: string) => readonly [quote: string, doc: string]> = {
  end_after_stop: (run) => [`the tenant pays the rent.${run}`, RENT],
  mid_sentence: (run) => [`the tenant${run} pays the rent`, RENT],
  stitched: (run) => [
    `The Tenant pays the rent monthly in advance. … The Landlord${run} repairs the roof every spring`,
    'The Tenant pays the rent monthly in advance. The deposit is due now. The Landlord repairs the roof every spring.',
  ],
};

describe('#845 1a-ii correction 1, check 1: a quote carrying a run of invisible characters is read in time proportional to its length', () => {
  const N = 1000;
  for (const [name, invisible] of Object.entries(INVISIBLE_RUNS)) {
    for (const [place, at] of Object.entries(RUN_PLACES)) {
      it(`${name}, ${place}: reads at 2N at most 2.5 times those at N`, () => {
        const readsAt = (n: number): number => {
          const [quote, doc] = at(invisible.repeat(n));
          releaseQuoteCache();
          return readsOf(() => {
            locateQuote(quote, doc);
          });
        };
        const atN = readsAt(N);
        const at2N = readsAt(2 * N);
        const ratio = Math.round((at2N / atN) * 100) / 100;
        console.log(
          `correction 1 check 1 ${name} ${place}: ${String(atN)} → ${String(at2N)} reads, ×${String(ratio)}`,
        );
        // (1) red when each character of the run walks the rest of it (about ×4 at dfda322b);
        //     (2) prints the reads at N and 2N and the ratio.
        expect({ atN, at2N, ratio, linear: at2N <= 2.5 * atN }).toEqual({
          atN,
          at2N,
          ratio,
          linear: true,
        });
      }, 120_000);
    }
  }
});

describe('#845 1a-ii correction 1, check 2 (GROUNDING, not acceptance): the readings do not move', () => {
  it("check 1's inputs at N and 2N, and the walk's W3 cells: each locateQuote result is dfda322b's", () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/invisible-runs-845.json', import.meta.url), 'utf8'),
    ) as { cases: Record<string, { in: string; out: unknown }> };
    const digest = (v: unknown): string =>
      createHash('sha256').update(JSON.stringify(v), 'utf8').digest('hex').slice(0, 32);
    const cases: Array<readonly [key: string, quote: string, doc: string]> = [];
    for (const [name, invisible] of Object.entries(INVISIBLE_RUNS)) {
      for (const [place, at] of Object.entries(RUN_PLACES)) {
        for (const n of [1000, 2000])
          cases.push([`run ${name} ${place} ${String(n)}`, ...at(invisible.repeat(n))]);
      }
    }
    // The walk's W3 cells (845-WALK1AII), its inputs as written there.
    const ZW = '\u{200b}';
    const SHY = '\u{ad}';
    const BOM = '\u{feff}';
    const COST = 'The Tenant pays the full yearly … The Landlord repairs the roof every spring';
    const FLAT = 'The flat measures approx.';
    const ITEMS = (pre1: string, pre2: string): string =>
      `During the whole lease term the Tenant shall:\n${pre1}- keep the flat clean and in good order;\n${pre2}- pay the heating costs every quarter;\n- return every key when the lease ends.`;
    const Q1 =
      'During the whole lease term the Tenant shall: … keep the flat clean and in good order';
    const Q2 =
      'During the whole lease term the Tenant shall: … pay the heating costs every quarter';
    const NINE = (between: string): string => `The office opens at 9:${between}30 every weekday.`;
    const SEND =
      'The Tenant pays the rent every month. … Send every notice in writing to the Landlord';
    const SEND2 =
      'The Tenant pays the rent every month. … 2. Send every notice in writing to the Landlord';
    const LABEL = (line: string): string =>
      `The Tenant pays the rent every month.\n${line} Send every notice in writing to the Landlord.`;
    const ITEMS2 = (pre: string): string =>
      `During the whole lease term the Tenant shall, when asked:\n${pre}- keep the flat clean and in good order;\n- pay the heating costs every quarter.`;
    const QF =
      'During the whole lease term the Tenant shall … keep the flat clean and in good order';
    const DEPOSIT = (line: string, word: string): string =>
      `The Tenant pays the rent every month. The deposit is due now.\n${line} ${word} every notice in writing to the Landlord.`;
    cases.push(
      [
        'W3.1a',
        COST,
        `The Tenant pays the full yearly heating cost.${ZW} The Landlord repairs the roof every spring.`,
      ],
      [
        'W3.1b',
        COST,
        `The Tenant pays the full yearly heating cost. ${ZW}The Landlord repairs the roof every spring.`,
      ],
      [
        'W3.1c',
        COST,
        `The Tenant pays the full yearly heating cost.${BOM} The Landlord repairs the roof every spring.`,
      ],
      [
        'W3.1d',
        COST,
        'The Tenant pays the full yearly heating cost. The Landlord repairs the roof every spring.',
      ],
      [
        'W3.1e',
        'The Tenant pays the full yearly … the Landlord repairs the roof every spring',
        `The Tenant pays the full yearly heating cost.${ZW} the Landlord repairs the roof every spring.`,
      ],
      ['W3.2a', FLAT, `The flat measures approx.${SHY} 412 square metres.`],
      ['W3.2b', FLAT, `The flat measures approx.${ZW}412 square metres.`],
      ['W3.2c', FLAT, `The flat measures approx.${SHY}\n412 square metres.`],
      ['W3.2d', FLAT, 'The flat measures approx. 412 square metres.'],
      ['W3.2e', `the tenant pays the rent.${ZW}`, RENT],
      ['W3.3a', Q2, ITEMS('', ZW)],
      ['W3.3b', Q1, ITEMS(ZW, '')],
      ['W3.3c', Q1, ITEMS(SHY, '')],
      ['W3.3d', Q2, ITEMS('', BOM)],
      ['W3.3e', Q2, ITEMS('', '')],
      ['W3.3f', Q2, ITEMS('', '').replace('- pay', `-${ZW} pay`)],
      ['W3.4a', '9', NINE(ZW)],
      ['W3.4b', 'The office opens at 9', NINE(ZW)],
      ['W3.4c', 'the office opens at 9:30 every weekday', NINE(ZW)],
      ['W3.4d', 'The office opens at 9: … 30 every weekday', NINE(ZW)],
      ['W3.4e', '9', NINE('')],
      ['W3.5a', SEND, LABEL(`2.${ZW}`)],
      ['W3.5b', SEND2, LABEL(`2.${ZW}`)],
      ['W3.5c', SEND, LABEL('2.')],
      ['W3.5d', SEND, LABEL(`2${ZW}.`)],
      ['W3.5e', SEND, LABEL(`${ZW}2.`)],
      ['FIX W3.3b', QF, ITEMS2(ZW)],
      ['FIX W3.3c', QF, ITEMS2(SHY)],
      ['FIX W3.3g', QF, ITEMS2(BOM)],
      ['FIX W3.3h', QF, ITEMS2('')],
      ['FIX W3.3i', QF, ITEMS2('').replace(':\n', `:${ZW}\n`)],
      ['FIX W3.5b', SEND2, DEPOSIT(`2.${ZW}`, 'Send')],
      ['FIX W3.5f', SEND2, DEPOSIT('2.', 'Send')],
      [
        'FIX W3.5g',
        'The Tenant pays the rent every month. … send every notice in writing to the Landlord',
        DEPOSIT(`2.${ZW}`, 'send'),
      ],
    );
    // The fixture's precondition: the same cases and inputs as at dfda322b.
    expect({
      keys: cases.map(([key]) => key).sort(),
      inputs: cases
        .filter(([key, quote, doc]) => fixture.cases[key]?.in !== digest([quote, doc]))
        .map(([key]) => key),
    }).toEqual({ keys: Object.keys(fixture.cases).sort(), inputs: [] });
    const moved = cases
      .map(([key, quote, doc]) => {
        releaseQuoteCache();
        const now = JSON.stringify(locateQuote(quote, doc));
        const then = JSON.stringify(fixture.cases[key]?.out);
        return now === then ? '' : `${key}: ${now}, at dfda322b ${then}`;
      })
      .filter((line) => line !== '');
    // (1) red when a run of invisible characters is crossed only part of the way (the walk stopped
    //     after 30 of them); (2) prints each case whose result moved, with dfda322b's beside it.
    expect(moved).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------
// #845 unit 1b-i (`prompts/fix-845-1b-i-lines-and-joins.md`): line starts, list items, and the
// blank-line join the quote check refuses (rules 1–7, checks 1–9).

/** The quote check's result, with its refusal's fields when it has them. */
const lq = (quote: string, source: string, minPartChars?: number) => {
  releaseQuoteCache();
  return locateQuote(quote, source, minPartChars === undefined ? undefined : { minPartChars });
};
const SHALL_F = 'The Landlord shall insure the Building';
const SHALL_REST =
  'not be responsible for repairs to the structure, roof, foundations or exterior of the Building';
/** extra2's document: SHALL_F's sentence, `The Tenant shall`, then `between`, then `rest`. */
const shallDoc = (between: string, rest = SHALL_REST) =>
  `${SHALL_F} for its full reinstatement cost. The Tenant shall${between}${rest}.`;

/** The re-check's extra2 rows 1–31 (Q-C), built as `extra2.mjs` builds them: [row, quote, doc]. */
const QC_ROWS: ReadonlyArray<readonly [row: number, quote: string, doc: string]> = (() => {
  const F = SHALL_F;
  const rest = SHALL_REST;
  const A = `${F} for its full reinstatement cost. The Tenant shall`;
  const r2 = 'not be responsible for repairs to the structure';
  const H = 'Lease of Office Premises — page 4';
  const P = 'The Tenant shall pay the Rent on the usual';
  const before = 'The Tenant shall pay the Rent on the usual quarter days\n\n';
  const keep = 'keep the Premises in good and substantial repair';
  const rows: Array<readonly [string, string]> = [
    [`${F} … ${rest}`, shallDoc('\n\n')],
    [`${F} … ${rest}`, shallDoc(`\n\n${H}\n\n`)],
    [`${F} … ${rest}`, shallDoc('\n\n- ')],
    [`${F} … - ${rest}`, shallDoc('\n\n- ')],
    [`${F}. ${rest}`, shallDoc('\n\n')],
    [
      `As agreed, The Landlord shall insure the Building … ${r2}`,
      `As agreed, The Landlord shall insure the Building\nat its own cost and the Tenant shall\n\n${r2}.`,
    ],
    [
      `As agreed, The Landlord shall insure the Building … ${r2}`,
      `As agreed, The Landlord shall insure the Building\nat its own cost.\n\nThe Tenant shall keep it clean and\n\n${r2}.`,
    ],
    [
      `As agreed, The Landlord shall insure the Building … ${r2}`,
      `As agreed, The Landlord shall insure the Building\n\nThe Tenant shall keep it clean and\n\n${r2}.`,
    ],
    [`${A} … ${r2}`, `${A}\n\n${r2}.`],
    [`${A} … ${r2}`, `${A}\n\n${H}\n\n${r2}.`],
    [`${A}\n${r2}`, `${A}\n\n${H}\n\n${r2}.`],
    [`${A} … ${r2}`, `${A}\n${H}\n\n${r2}.`],
    [`${A}\n${r2}`, `${A}\n${H}\n\n${r2}.`],
    ...['2.', '12.', '2)', '6.2', 'b.', 'a)', '3.4.1'].map(
      (l) => [`${P} … ${l} ${keep}`, `${before}${l} ${keep} at all times.`] as const,
    ),
    ...['b.', 'a)'].map(
      (l) =>
        [
          `${P} … ${l} Keep the Premises in good and substantial repair`,
          `${before}${l} Keep the Premises in good and substantial repair at all times.`,
        ] as const,
    ),
    ...['b.', 'a)'].map(
      (l) =>
        [
          `${P} … ${l} (the Premises) in good and substantial repair`,
          `${before}${l} (the Premises) in good and substantial repair at all times.`,
        ] as const,
    ),
    ...['+', '%', '\u{20ac}', '='].map(
      (m) => [`${P} … ${m} ${keep}`, `${before}${m} ${keep} at all times.`] as const,
    ),
    [`${P} … ${keep}`, `${before}- ${keep} at all times.`],
    [
      `${F} … The Landlord shall insure the Premises against loss`,
      `${F} for its full reinstatement cost.\n\n6. INSURANCE\n\n6.1 The Landlord shall insure the Premises against loss.`,
    ],
    [
      `${F} … The Tenant shall pay the insurance rent`,
      `${F} for its full reinstatement cost.\n\nINSURANCE\n\nThe Tenant shall pay the insurance rent.`,
    ],
  ];
  return rows.map(([q, s], i) => [i + 1, q, s] as const);
})();
/** A quote's one join: the break it replaces (`…`, else a line break, else a stop and a space). */
const breakOf = (quote: string): string => ['…', '\n', '. '].find((b) => quote.includes(b)) ?? '';
/** Where a quote's one join sits: the first code unit after its break. */
const joinOf = (quote: string): number => quote.indexOf(breakOf(quote)) + 1;
/** The two parts of a quote with one join, each quoted alone (a stop before the join kept off). */
const partsOf = (quote: string): string[] => {
  const at = quote.indexOf(breakOf(quote));
  return [quote.slice(0, at).trimEnd(), quote.slice(at + breakOf(quote).length).trimStart()];
};
const FOUND_STATES: readonly string[] = [
  'exact',
  'reformatted',
  'stitched',
  'stitched_out_of_order',
];

describe('#845 1b-i check 1: the refusal (Q-C) — `not_found` with `cause` and `join_at`, only when rule 1 alone refused the quote', () => {
  it('extra2 rows 1–8 and 10–29 read `not_found` with `cause` and `join_at` at the refused join, each part quoted alone found; rows 9, 30 and 31 keep their states, with no field', () => {
    const want = (row: number) =>
      row === 9 ? 'reformatted' : row >= 30 ? 'stitched' : `not_found@${row}`;
    const rows = QC_ROWS.map(([row, quote, doc]) => {
      const c = lq(quote, doc);
      const fields = 'cause' in c || 'join_at' in c;
      const read =
        c.state === 'not_found' && c.cause === 'blank_line_join'
          ? JSON.stringify(c.join_at) === JSON.stringify([joinOf(quote)])
            ? `not_found@${row}`
            : `not_found join_at ${JSON.stringify(c.join_at)}`
          : `${c.state}${fields ? ' with a field' : ''}`;
      const alone =
        row === 9 || row >= 30
          ? []
          : partsOf(quote).filter((p) => !FOUND_STATES.includes(lq(p, doc).state));
      return { row, read, alone };
    });
    // (1) red when a refused row loses `cause`, its `join_at` is not the quote offset after its break,
    //     a part alone is refused, or a kept row gains a field or moves; (2) prints each row's read
    //     and the parts refused alone.
    expect(rows).toEqual(QC_ROWS.map(([row]) => ({ row, read: want(row), alone: [] })));
  });

  it('the probes: a made-up third piece (Q1) and a part under the floor (R3) are ordinary `not_found`; two joins (Q2) give two offsets; no out-of-order placement after the refusal (Q3); an accepted candidate wins (R1); the out-of-order placement takes no held-back one (R2)', () => {
    const F = SHALL_F;
    const rest = SHALL_REST;
    const q1 = `${F} … ${rest} … The Tenant shall pay a deposit of twenty-four thousand euro`;
    const q2 = `${F} … not be responsible for repairs to the structure … keep the Premises insured at all times`;
    const two = `${F} for its full reinstatement cost. The Tenant shall\n\nnot be responsible for repairs to the structure, and the Landlord shall\n\nkeep the Premises insured at all times.`;
    const q3 = `${F} … not be responsible for repairs to the structure`;
    const ooo = `Not be responsible for repairs to the structure is the rule. ${F} for its full reinstatement cost. The Tenant shall\n\nnot be responsible for repairs to the structure.`;
    const r1 = `${F} … not be responsible for repairs; the roof is excluded from the lease`;
    const d1 = `${F} for its cost. Not be responsible for repairs is the rule here. The Tenant shall\n\nnot be responsible for repairs; the roof is excluded from the lease.`;
    const C = 'The Tenant shall keep the Premises in good and substantial repair';
    const d2 = `${C} at all times. ${F} for its full reinstatement cost. The Tenant shall\n\n${rest}.`;
    const read = (quote: string, doc: string) => {
      const c = lq(quote, doc);
      return {
        state: c.state,
        cause: c.cause ?? null,
        join_at: c.join_at ?? null,
        nearest: c.nearest ?? null,
      };
    };
    // (1) red when the refusal is returned before every piece is tried (Q1), names one join only (Q2),
    //     falls through to the out-of-order placement (Q3), prefers a held-back candidate of greater
    //     `last` to an accepted one (R1: refused, or found with the part moved past the blank line),
    //     lets the out-of-order placement take a held-back candidate (R2), or skips the floor on a
    //     held-back completion (R3); (2) prints each record.
    expect({
      Q1: read(q1, shallDoc('\n\n')),
      Q2: read(q2, two),
      Q3: read(q3, ooo),
      R1: ((c) => ({ state: c.state, parts: c.parts.map((p) => p.start) }))(lq(r1, d1)),
      R2: read(`${F} … ${rest} … ${C}`, d2),
      R3: read(`${F} … not be liable`, shallDoc('\n\n', 'not be liable for repairs')),
    }).toEqual({
      Q1: { state: 'not_found', cause: null, join_at: null, nearest: { start: 90, end: 184 } },
      Q2: {
        state: 'not_found',
        cause: 'blank_line_join',
        join_at: [q2.indexOf('…') + 1, q2.lastIndexOf('…') + 1],
        nearest: null,
      },
      Q3: {
        state: 'not_found',
        cause: 'blank_line_join',
        join_at: [q3.indexOf('…') + 1],
        nearest: null,
      },
      // the middle part at the accepted `Not be…`, not at the held-back `not be…` after the blank line
      R1: { state: 'stitched', parts: [0, d1.indexOf('Not be'), d1.indexOf('the roof')] },
      R2: { state: 'not_found', cause: null, join_at: null, nearest: { start: 170, end: 264 } },
      R3: { state: 'not_found', cause: null, join_at: null, nearest: { start: 0, end: 38 } },
    });
  });
});

describe('#845 1b-i check 2: the refusal re-places nothing', () => {
  it('extra2 rows 1–8: the substring searches are at most those for the same quote against the document with a `.` ending the line before the refused blank line (the same canonical text, read `stitched`), plus one', () => {
    const searches = (quote: string, doc: string) => {
      releaseQuoteCache();
      const spies = (['includes', 'indexOf', 'startsWith'] as const).map((m) =>
        vi.spyOn(String.prototype, m),
      );
      let state: string;
      let n: number;
      try {
        state = locateQuote(quote, doc).state;
        // Counted before the spies are restored: restoring one clears its record of calls.
        n = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      return { state, n };
    };
    const rows = QC_ROWS.filter(([row]) => row <= 8).map(([row, quote, doc]) => {
      const at = doc.lastIndexOf('\n\n');
      const legal = `${doc.slice(0, at)}.${doc.slice(at)}`;
      const refused = searches(quote, doc);
      const control = searches(quote, legal);
      return {
        row,
        sameCanonical: canonicalForm(doc) === canonicalForm(legal),
        legal: control.state,
        counted: refused.n > 0 && control.n > 0,
        within: refused.n <= control.n + 1 ? 'within' : `${refused.n} > ${control.n} + 1`,
      };
    });
    // (1) red when the refusal re-places the parts with the rule relaxed (about 2×), or falls through
    //     to the out-of-order placement and the tiling (about 5×), or when the counter saw no search
    //     (a counter that reads 0 makes every bound hold); (2) prints each row's counts.
    expect(rows).toEqual(
      QC_ROWS.filter(([row]) => row <= 8).map(([row]) => ({
        row,
        sameCanonical: true,
        legal: 'stitched',
        counted: true,
        within: 'within',
      })),
    );
  });
});

describe('#845 1b-i check 4: B3, a blank line inside a sentence', () => {
  it('items3 rows 47–50; T1 across every blank-line form; a blank line after a `.`, a `;` or a table row keeps main’s start', () => {
    const F = SHALL_F;
    const rest = SHALL_REST;
    const T1 = `${F} … ${rest}`;
    const tail =
      'not be responsible for repairs to the structure, roof, foundations or exterior of the Building';
    const forms: Record<string, string> = {
      'LF LF': '\n\n',
      'CR LF CR LF': '\r\n\r\n',
      'LF, spaces and a tab, LF': '\n  \t\n',
      'LF, U+00A0, LF': '\n\u{a0}\n',
      'LF, U+200B, LF': '\n\u{200b}\n',
      'four LF': '\n\n\n\n',
      'LF FF': '\n\u{c}',
      'LF FF LF': '\n\u{c}\n',
      'U+2029 U+2029': '\u{2029}\u{2029}',
      'CR LF, spaces, CR LF': '\r\n   \r\n',
    };
    const cause = (quote: string, doc: string) => {
      const c = lq(quote, doc);
      return `${c.state}${c.cause === undefined ? '' : `+${c.cause}`}`;
    };
    const rows: Row[] = [
      ['items3 47', cause(T1, shallDoc('\n\n')), 'not_found+blank_line_join'],
      ['items3 48', cause(T1, shallDoc('\n\n- ')), 'not_found+blank_line_join'],
      [
        'items3 49',
        cause(
          `${F} … The Tenant shall pay the insurance rent`,
          `${F} for its full reinstatement cost.\n\nINSURANCE\n\nThe Tenant shall pay the insurance rent at the end of each year.`,
        ),
        'stitched',
      ],
      [
        'items3 50',
        cause(
          `${F} … The Landlord shall insure the Premises against loss`,
          `${F} for its full reinstatement cost.\n\n6. INSURANCE\n\n6.1 The Landlord shall insure the Premises against loss.`,
        ),
        'stitched',
      ],
      ...Object.entries(forms).map(([name, between]): Row => [
        `T1, ${name}`,
        cause(T1, shallDoc(between)),
        'not_found+blank_line_join',
      ]),
      [
        'K1: a `;` line, a blank line, a lowercase line',
        cause(`${F} … ${tail}`, `${F} for its cost; the Tenant shall pay;\n\n${tail}.`),
        'stitched',
      ],
      [
        'K2: a `.` line, a blank line, a lowercase line',
        cause(`${F} … ${tail}`, `${F} for its full reinstatement cost.\n\n${tail}.`),
        'stitched',
      ],
      [
        'K3: a table row, a blank line, a lowercase line',
        cause(`${F} … ${tail}`, `| ${F} for its cost | x |\n\n${tail}.`),
        'stitched',
      ],
    ];
    // (1) red when rule 1 is removed, the walk back stops after one line or reads only `\n\n`, or the
    //     line before the blank line is read as ending nothing whatever it ends; (2) prints each
    //     differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('the conjunct controls: a list mark with a capital item after such a blank line, skipped onto and quoted with its mark, and an opening mark before a capital word stay `stitched`; an opening mark before a lowercase word is refused with `cause` (#845 1b-i-n)', () => {
    const A = 'The Tenant covenants with the Landlord as set out below';
    const rows: Row[] = [
      [
        'a list mark, a capital item, the mark skipped',
        lq(
          `${A} … To pay the rent on the usual quarter days`,
          `${A} in this clause\n\n- To pay the rent on the usual quarter days.`,
        ).state,
        'stitched',
      ],
      [
        'a list mark, a capital item, the mark quoted',
        lq(
          `${A} … - To pay the rent on the usual quarter days`,
          `${A} in this clause\n\n- To pay the rent on the usual quarter days.`,
        ).state,
        'stitched',
      ],
      [
        'an opening mark before a capital word',
        lq(
          `${A} … \u{201c}The Premises\u{201d} means the whole of the Building`,
          `${A} in this clause\n\n\u{201c}The Premises\u{201d} means the whole of the Building.`,
        ).state,
        'stitched',
      ],
      [
        // #845 1b-i-n re-pin (main: `stitched`): after such a blank line, the first word past the
        // opening mark must begin with a capital letter; refused only by rule 1, so with `cause`
        'an opening mark before a lowercase word',
        ((c) => `${c.state}${c.cause === undefined ? '' : `+${c.cause}`}`)(
          lq(
            `${A} … \u{201c}the Premises\u{201d} means the whole of the Building`,
            `${A} in this clause\n\n\u{201c}the Premises\u{201d} means the whole of the Building.`,
          ),
        ),
        'not_found+blank_line_join',
      ],
    ];
    // (1) red when every list mark is refused after such a blank line, the opening-mark allowance
    //     is removed, or an opening mark alone admits a lowercase word again; (2) prints each
    //     differing row.
    expect(misses(rows)).toEqual([]);
  });
});

describe('#845 1b-i check 5: M6w — a `|` ends a table row only when its line holds another `|`', () => {
  it('items3 rows 62 and 63: a prose line ending a lone `|` is no line start; a table row is', () => {
    const F = SHALL_F;
    const second = 'the Tenant shall pay the insurance rent';
    const rows: Row[] = [
      [
        'items3 62: a prose line ending a lone `|`',
        lq(
          `${F} … ${second}`,
          `${F} for its full reinstatement cost or |\n${second} at the end of each year.`,
        ).state,
        'not_found',
      ],
      [
        'items3 63: a table row `| … | x |`',
        lq(
          `${F} … ${second}`,
          `| ${F} for its full reinstatement cost | x |\n${second} at the end of each year.`,
        ).state,
        'stitched',
      ],
    ];
    // (1) red when the condition is removed (a lone `|` ends a line again) or a table row stops
    //     ending one; (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });
});

describe('#845 1b-i check 6: Outside-b — a `:` at a line’s end ends a clause only when it is not between two digits', () => {
  it('items3 rows 38 and 39; `9:`, a blank line, `30` is refused with the cause; a `:` with a digit on one side only still ends a clause', () => {
    const F = SHALL_F;
    const A = 'The Tenant covenants with the Landlord as set out below';
    const thirty = '30 minutes before the Tenant arrives at the Building';
    const read = (quote: string, doc: string) => {
      const c = lq(quote, doc);
      return `${c.state}${c.cause === undefined ? '' : `+${c.cause}`}`;
    };
    const rows: Row[] = [
      [
        'items3 38: `at 9:`, a line break, `30`',
        read(`${F} … ${thirty}`, `${F} for its cost at 9:\n${thirty}.`),
        'not_found',
      ],
      [
        'items3 39: `:`, a line break, a list (no digits)',
        read(
          `${F} … The Tenant shall pay the insurance rent`,
          `${F} for its full reinstatement cost:\nThe Tenant shall pay the insurance rent at the end of each year.`,
        ),
        'stitched',
      ],
      [
        '`9:`, a blank line, `30` (B3 applies)',
        read(`${F} … ${thirty}`, `${F} for its cost at 9:\n\n${thirty}.`),
        'not_found+blank_line_join',
      ],
      [
        '`as follows:`, a line break, `1. The Tenant…` quoted with its label',
        read(
          `${A} … 1. The Tenant shall pay the rent quarterly`,
          `${A} as follows:\n1. The Tenant shall pay the rent quarterly.`,
        ),
        'stitched',
      ],
      [
        '`as follows:`, a blank line, `1. The Tenant…` quoted with its label',
        read(
          `${A} … 1. The Tenant shall pay the rent quarterly`,
          `${A} as follows:\n\n1. The Tenant shall pay the rent quarterly.`,
        ),
        'stitched',
      ],
      [
        '`under Clause 9:`, a line break, `the Tenant…`',
        read(
          `${A} … the Tenant shall pay the rent quarterly`,
          `${A} under Clause 9:\nthe Tenant shall pay the rent quarterly.`,
        ),
        'stitched',
      ],
    ];
    // (1) red when the condition is removed, or only the digit after (or only the digit before) is
    //     read; (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });
});

describe('#845 1b-i check 1 (with M8r): an occurrence M8r refuses too is no candidate of either kind', () => {
  it('`-` directly before the part after a blank line under a line with no stop reads `not_found` with no `cause`', () => {
    const c = lq(`${SHALL_F} … ${SHALL_REST}`, shallDoc('\n\n-'));
    // (1) red when M8r is left out of the held-back test (the occurrence would be held back, and the
    //     quote refused with the cause); (2) prints the record's state and cause.
    expect({ state: c.state, cause: c.cause ?? null }).toEqual({ state: 'not_found', cause: null });
  });
});

describe('#845 1b-i check 7: M8r — a list mark counts only with at least one blank after it', () => {
  it('every list mark, `#` and `##` included, at four counted line starts: directly before the word or with U+200B between `not_found`; with a space or U+00A0 between `stitched`; `-“the` refused and `- “the` kept', () => {
    const lc = 'the Tenant shall pay the insurance rent';
    const marks = [
      ...codePoints(/^\p{Pd}$/u),
      0x2212,
      0x2796,
      0x02d7,
      0x2a,
      0x2b,
      0x3e,
      0x7c,
      0x2022,
      0x2023,
      0x2043,
      0x204c,
      0x204d,
      0x2219,
      0x25d8,
      0x25e6,
      0x29be,
      0x29bf,
      0x2619,
      0x2765,
      0x2767,
      0x25cb,
      0x25cf,
      0x25a0,
      0x25aa,
      0xb7,
      0xf0b7,
    ].map((m) => ch(m));
    const all = [...marks, '#', '##'];
    const starts: Record<string, string> = {
      'after `:`': ' for its full reinstatement cost:\n',
      'after `;`': ' for its full reinstatement cost;\n',
      'after a sentence': ' for its full reinstatement cost.\n',
      'after a blank line under a sentence': ' for its full reinstatement cost.\n\n',
    };
    const between: Record<string, string> = {
      'no blank': '',
      'U+200B': '\u{200b}',
      'a space': ' ',
      'U+00A0': '\u{a0}',
    };
    const rows: Row[] = [];
    for (const [where, line] of Object.entries(starts)) {
      for (const m of all) {
        for (const [gap, g] of Object.entries(between)) {
          const name = `${[...m].map((c) => hex(c.codePointAt(0)!)).join('')} ${gap} ${where}`;
          const want = gap === 'a space' || gap === 'U+00A0' ? 'stitched' : 'not_found';
          rows.push([name, skipOver(`${line}${m}${g}`, lc), want]);
        }
      }
    }
    rows.push(
      [
        '-“the after `:`',
        skipOver(' for its full reinstatement cost:\n-\u{201c}', `${lc}\u{201d}`),
        'not_found',
      ],
      [
        '- “the after `:`',
        skipOver(' for its full reinstatement cost:\n- \u{201c}', `${lc}\u{201d}`),
        'stitched',
      ],
    );
    // (1) red when M8r is removed (a mark glued to its word, or with only U+200B after it, opens an
    //     item again), or a blank after the mark stops counting; (2) prints the count and each
    //     differing row.
    expect({ marks: all.length, misses: misses(rows) }).toEqual({ marks: 55, misses: [] });
  });
});

describe('#845 1b-i check 8: item 14 — a `.` ends a sentence only when the word before it holds a letter or a digit', () => {
  it('items3 rows 106–113 and extra2 rows 125–128: a stop after `²` `ͺ` `§` `*` `½` `‿` or a sign set apart is no sentence end; after `2024`, `(see above)`, `5%`, `m²` it is', () => {
    const F = SHALL_F;
    const keep = 'Keep the Premises in good and substantial repair';
    const tenant = 'The Tenant shall pay the insurance rent';
    const onKeep = (label: string) =>
      lq(
        `${F} … ${keep}`,
        `${F} for its full reinstatement cost.\n${label}. ${keep} at the end of each year.`,
      ).state;
    const onTenant = (before: string) =>
      lq(`${F} … ${tenant}`, `${F} ${before}${tenant} at the end of each year.`).state;
    const rows: Row[] = [
      ['items3 106: `.`⏎`². Keep`', onKeep('\u{b2}'), 'not_found'],
      [
        'items3 107: `.`⏎U+037A`. Keep` (a spacing accent is no letter)',
        onKeep('\u{37a}'),
        'not_found',
      ],
      ['items3 108: `.`⏎`§. Keep`', onKeep('\u{a7}'), 'not_found'],
      ['items3 109: `.`⏎`*. Keep`', onKeep('*'), 'not_found'],
      ['items3 110: `.`⏎`½. Keep`', onKeep('\u{bd}'), 'not_found'],
      ['items3 111: `.`⏎`‿. Keep`', onKeep('\u{203f}'), 'not_found'],
      ['items3 112: `2024. The`', onTenant('for its cost, signed on 1 May 2024. '), 'stitched'],
      ['items3 113: `(see above). The`', onTenant('for its cost (see above). '), 'stitched'],
      ['extra2 125: `20 °. The` (a stated tightening)', onTenant('at 20 \u{b0}. '), 'not_found'],
      ['extra2 126: `5%. The`', onTenant('at 5%. '), 'stitched'],
      ['extra2 127: `m². The`', onTenant('of 40 m\u{b2}. '), 'stitched'],
      ['extra2 128: `5%.`⏎`The`', onTenant('at 5%.\n'), 'stitched'],
    ];
    // (1) red when the condition is removed, or a spacing accent is counted as a letter (row 107);
    //     (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });
});

describe('#845 1b-i check 9: walk M8 — a part found in two places that fit equally is placed where its sentence ends, if the rest still follows', () => {
  it('items3 row 64 reads `stitched` uncut; probes M1 and R4 keep first-fit’s `stitched+cs[75]`, and so does a second placement with as many cut-short ends or a part under the floor; when the searches run out, first-fit stands', () => {
    const read = (quote: string, doc: string) => {
      const c = lq(quote, doc);
      return `${c.state}${c.cut_short === true ? `+cs${JSON.stringify(c.cut_short_at)}` : ''}${c.cause === undefined ? '' : `+${c.cause}`}`;
    };
    const quote =
      'The Tenant shall pay the rent … The Landlord shall repair the roof. The Tenant may assign the lease';
    const m1 =
      'The Tenant shall pay the rent quarterly. The Landlord shall repair the roof and walls. The Tenant may assign the lease with consent. The Landlord shall repair the roof.';
    const r4 = `${m1} It is agreed that\n\nthe Tenant may assign the lease freely.`;
    // The second placement returns, uncut in the middle, but the last piece is then cut short where
    // first-fit's was not: as many cut-short ends, so first-fit stands.
    const asMany =
      'The Tenant shall pay the rent quarterly. The Landlord shall repair the roof and walls. The Tenant may assign the lease. The Landlord shall repair the roof. It is agreed. The Tenant may assign the lease with consent.';
    // The second placement returns uncut, but `Rent is due` (11 characters) then stands alone, under
    // the floor of 20; first-fit joins it to the next piece, so first-fit stands.
    const floorQuote =
      'The Tenant shall pay the rent … The Landlord shall repair the roof. Rent is due. The Tenant may assign the lease';
    const underFloor =
      'The Tenant shall pay the rent quarterly. The Landlord shall repair the roof and walls. Rent is due. The Tenant may assign the lease. The Landlord shall repair the roof. It is agreed. Rent is due. It is agreed. The Tenant may assign the lease.';
    // The budget: the first piece 200 times over, which both placements walk, then the middle piece
    // cut short 400 times and uncut only at the end. The second placement alone fits in the budget;
    // after the first, the searches run out before the uncut place.
    const P1 = 'The Tenant shall pay the rent quarterly';
    const P2 = 'The Landlord shall repair the roof.';
    const lead = `${P1} and the service charge. `;
    const many = `${lead.repeat(200)}${`${P2.slice(0, -1)}, and more. `.repeat(400)}${P2}`;
    const rows: Row[] = [
      [
        'items3 64: `a.m.` first, the uncut place last',
        read(
          'The Tenant shall pay … Monday rent is waived.',
          'The Tenant shall pay by 9 a.m. Monday rent is waived on holidays only. Monday rent is waived.',
        ),
        'stitched',
      ],
      ['M1: the uncut place sits after the next part', read(quote, m1), 'stitched+cs[75]'],
      [
        'R4: after the uncut place, the next part only at a blank-line join',
        read(quote, r4),
        'stitched+cs[75]',
      ],
      [
        'the second placement with as many cut-short ends',
        read(`${quote}.`, asMany),
        'stitched+cs[75]',
      ],
      [
        'the second placement with a part under the floor',
        read(floorQuote, underFloor),
        'stitched+cs[75]',
      ],
      [
        'the searches run out before the uncut place',
        read(`${P1} … ${P2}`, many),
        `stitched+cs[${200 * lead.length + P2.length - 1}]`,
      ],
    ];
    // (1) red when the preference is removed (row 64), the second placement is adopted whenever it
    //     returns, or without fewer cut-short ends (as many), or with a part under the floor, takes a
    //     held-back candidate (R4), or runs on a budget of its own (the last row); (2) prints each
    //     differing row.
    expect(misses(rows)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// #845 1b-i-n (`prompts/fix-845-1b-i-narrow.md`): after a blank line inside a sentence, the next
// piece's first word, past opening marks and one clause number or list mark, begins with a capital
// letter; there the `.` of the line's short first word ends a sentence only before a capital.

const N_NOEND =
  'The Landlord shall insure the Building against fire for its full reinstatement cost and the Tenant shall';
const N_Q = 'The Landlord shall insure the Building against fire \u{2026} ';
const N_PREV =
  'The Landlord shall insure the Building against fire for its full reinstatement cost.';
/** Under a line that ends mid-sentence, then a blank line. */
const nMid = (line: string): string => `${N_NOEND}\n\n${line} to the roof.`;
/** Under a heading that ends nothing (`4. RENT`), then a blank line. */
const nHead = (line: string, indent = ''): string =>
  `${N_PREV}\n\n4. RENT\n\n${indent}${line} on the usual quarter days.`;
const N_NR = 'not be responsible for structural repairs';
const N_SUB = `(subject to clause 5) ${N_NR}`;
const N_KEEP = 'keep the Premises in good and substantial repair';
const N_TT = 'The Tenant shall pay the insurance rent';
const N_LANDLORD = 'The Landlord shall keep the structure in good repair';
/** A quote's read: its state; on `not_found`, `+cause[join_at]` or `+nearest`. */
const nRead = (quote: string, source: string): string => {
  const c = lq(quote, source);
  if (c.state !== 'not_found') return c.state;
  if (c.cause !== undefined) return `not_found+${c.cause}${JSON.stringify(c.join_at)}`;
  return c.nearest === undefined ? 'not_found' : 'not_found+nearest';
};
/** A refused row's want: `cause`, its join where the first piece after the `…` begins: right after
 *  the `…`, or after a `“` before the first letter or digit (a double quotation mark is a break too,
 *  so the piece between them is empty). */
const nCause = (quote: string): string => {
  const at = quote.indexOf('\u{2026}') + 1;
  const word = at + quote.slice(at).search(/[\p{L}\p{N}]/u);
  const mark = quote.indexOf('\u{201c}', at);
  return `not_found+blank_line_join[${mark >= 0 && mark < word ? mark + 1 : at}]`;
};
type NCase = readonly [member: string, quote: string, source: string];
const nRefused = (cases: readonly NCase[]): Row[] =>
  cases.map(([member, quote, source]) => [member, nRead(quote, source), nCause(quote)]);
const nStitched = (cases: readonly NCase[]): Row[] =>
  cases.map(([member, quote, source]) => [member, nRead(quote, source), 'stitched']);

describe('#845 1b-i-n check 1: after a blank line inside a sentence, a piece whose first word does not begin with a capital letter is refused with `cause`', () => {
  it('read 1, the document’s opening mark: rows 1 to 4, and row 5’s `(a) “not…` with its label', () => {
    const rows = nRefused([
      ['row 1: `(subject…` with the `(`', N_Q + N_SUB, nMid(N_SUB)],
      [
        'row 2: `“not…` with the mark',
        `${N_Q}\u{201c}${N_NR}\u{201d}`,
        nMid(`\u{201c}${N_NR}\u{201d}`),
      ],
      ['row 2: `“not…` without the mark', N_Q + N_NR, nMid(`\u{201c}${N_NR}\u{201d}`)],
      [
        'row 3: `“the Landlord…` quoted from `the`',
        `${N_Q}the Landlord shall keep the structure in good repair`,
        nMid('\u{201c}the Landlord shall keep the structure in good repair'),
      ],
      ...(['(b)', '(a)', '(ii)'] as const).map((l): NCase => [
        `row 4: \`${l} keep…\` with its label`,
        `${N_Q}${l} ${N_KEEP}`,
        nMid(`${l} ${N_KEEP}`),
      ]),
      [
        'row 5: `(a) “not…` with its label',
        `${N_Q}(a) \u{201c}${N_NR}`,
        nMid(`(a) \u{201c}${N_NR}`),
      ],
    ]);
    // (1) red when an opening mark alone is enough again (ce898697's clause), or a `(` that opens a
    //     clause number is read as an opening mark; (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('read 2: row 5’s `6.2 “not…` and `(a) “not…` with the label skipped', () => {
    const rows = nRefused([
      ['row 5: `6.2 “not…`, label skipped', N_Q + N_NR, nMid(`6.2 \u{201c}${N_NR}`)],
      ['row 5: `(a) “not…`, label skipped', N_Q + N_NR, nMid(`(a) \u{201c}${N_NR}`)],
    ]);
    // (1) red when read 2 reads as at ce898697 (an opening mark after the label is enough); (2)
    //     prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('read 3: rows 6 and 7, a list mark before an opening mark and a lowercase word', () => {
    const rows = nRefused([
      ['row 6: `- “not…`, the mark kept', `${N_Q}- \u{201c}${N_NR}`, nMid(`- \u{201c}${N_NR}`)],
      ['row 6: `- “not…`, the mark dropped', N_Q + N_NR, nMid(`- \u{201c}${N_NR}`)],
      [
        'row 7: `• (subject…` with the bullet',
        `${N_Q}\u{2022} ${N_SUB}`,
        nMid(`\u{2022} ${N_SUB}`),
      ],
    ]);
    // (1) red when read 3 reads as at ce898697; (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('the numbered route: row 5’s `6.2 “not…` with its label', () => {
    const rows = nRefused([
      [
        'row 5: `6.2 “not…` with its label',
        `${N_Q}6.2 \u{201c}${N_NR}`,
        nMid(`6.2 \u{201c}${N_NR}`),
      ],
    ]);
    // (1) red when the numbered route reads as at ce898697 (a clause number before an opening mark
    //     is enough); (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('the `.` of the line’s first word: row 8, the label skipped, also on an indented line', () => {
    const rows = nRefused([
      ['row 8: `2. “not…`', N_Q + N_NR, nMid(`2. \u{201c}${N_NR}`)],
      ['row 8: `b. (subject…`', N_Q + N_SUB, nMid(`b. ${N_SUB}`)],
      ['row 8: `IV. (subject…`', N_Q + N_SUB, nMid(`IV. ${N_SUB}`)],
      ['row 8: `12. (subject…`', N_Q + N_SUB, nMid(`12. ${N_SUB}`)],
      ['row 8: `  b. (subject…`, indented', N_Q + N_SUB, nMid(`  b. ${N_SUB}`)],
    ]);
    // (1) red when rule 3 is left out (every row), or read without "past its indentation" (the
    //     indented row); (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('row 9, the stated tightenings: `(B) keep…`, `[b] The…`, two labels, `(a) 30 days…`, `(a) £48,000…`', () => {
    const rows = nRefused([
      ['row 9: `(B) keep…`', `${N_Q}(B) ${N_KEEP}`, nMid(`(B) ${N_KEEP}`)],
      ['row 9: `[b] The…`', `${N_Q}[b] ${N_TT}`, nHead(`[b] ${N_TT}`)],
      ['row 9: `6.1 (a) The…`, two labels', `${N_Q}6.1 (a) ${N_TT}`, nHead(`6.1 (a) ${N_TT}`)],
      ['row 9: `- (a) The…`, two labels', `${N_Q}- (a) ${N_TT}`, nHead(`- (a) ${N_TT}`)],
      [
        'row 9: `(a) 30 days…`',
        `${N_Q}(a) 30 days after the date of the invoice`,
        `${N_PREV}\n\nPayment terms\n\n(a) 30 days after the date of the invoice.`,
      ],
      [
        'row 9: `(a) £48,000…`',
        `${N_Q}(a) \u{a3}48,000 per annum payable quarterly`,
        `${N_PREV}\n\nSCHEDULE 3 Rent\n\n(a) \u{a3}48,000 per annum payable quarterly.`,
      ],
    ]);
    // (1) red when an opening mark alone is enough again (`(B)`, `[b]`, `(a) 30`, `(a) £`), the
    //     numbered route reads as at ce898697 (`6.1 (a)`), read 3 does (`- (a)`), or a second label
    //     is passed (both two-label rows); (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('row 10: `+ Keep…` and `= The…` with the sign, refused as at ce898697', () => {
    const rows = nRefused([
      [
        'row 10: `+ Keep…` with the sign',
        `${N_Q}+ Keep the Premises in good and substantial repair`,
        nMid('+ Keep the Premises in good and substantial repair'),
      ],
      ['row 10: `= The…` with the sign', `${N_Q}= ${N_TT}`, nHead(`= ${N_TT}`)],
    ]);
    // GROUNDING for the routes (both read the same at ce898697). (1) `+ Keep…` is red when a list
    //     mark the canonical form keeps is passed as a label; (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });
});

describe('#845 1b-i-n check 2: after a blank line inside a sentence, a first word that begins with a capital letter, past opening marks and one label, stays `stitched`', () => {
  it('rows 11 to 13: every opening mark passed (`(The…`, `- “The…`, `2. “The…`, `“Rent” means…`)', () => {
    const rows = nStitched([
      ['row 13: `(The Landlord…`', `${N_Q}(${N_LANDLORD}`, nMid(`(${N_LANDLORD}`)],
      ['row 13: `- “The…`', `${N_Q}- \u{201c}${N_LANDLORD}`, nMid(`- \u{201c}${N_LANDLORD}`)],
      ['row 13: `2. “The…`', `${N_Q}2. \u{201c}${N_LANDLORD}`, nMid(`2. \u{201c}${N_LANDLORD}`)],
      [
        'row 13: `“Rent” means…`',
        `${N_Q}\u{201c}Rent\u{201d} means the yearly rent reserved by this Lease`,
        nMid('\u{201c}Rent\u{201d} means the yearly rent reserved by this Lease'),
      ],
    ]);
    // `“The…` alone is the 1b-i conjunct control above. (1) red when every opening mark is refused
    //     at such a line start; (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('row 11: a lettered label read from the line’s start, its `(` part of it (`(a) The…`, `(ii) The…`, `(b) To keep…`)', () => {
    const rows = nStitched(
      (['(a)', '(ii)'] as const)
        .flatMap((l): NCase[] => [
          [`row 11: \`${l} The…\` under a heading`, `${N_Q}${l} ${N_TT}`, nHead(`${l} ${N_TT}`)],
          [
            `row 11: \`${l} The…\` under a line ending mid-sentence`,
            `${N_Q}${l} ${N_TT}`,
            nMid(`${l} ${N_TT}`),
          ],
        ])
        .concat([
          [
            'row 11: `(b) To keep…` under a heading',
            `${N_Q}(b) To ${N_KEEP}`,
            nHead(`(b) To ${N_KEEP}`),
          ],
          [
            'row 11: `(b) To keep…` under a line ending mid-sentence',
            `${N_Q}(b) To ${N_KEEP}`,
            nMid(`(b) To ${N_KEEP}`),
          ],
        ]),
    );
    // (1) red when the rule is read from inside the label (rev 2's reading, where `a)`, `ii)`, `b)`
    //     are no clause numbers); (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('rows 11 to 13: one clause number or list mark passed (`(1) The…`, `(i) The…`, `2. Keep…`, `6.1 The…`, `- Keep…`)', () => {
    const rows = nStitched([
      ['row 11: `(1) The…` under a heading', `${N_Q}(1) ${N_TT}`, nHead(`(1) ${N_TT}`)],
      [
        'row 11: `(1) The…` under a line ending mid-sentence',
        `${N_Q}(1) ${N_TT}`,
        nMid(`(1) ${N_TT}`),
      ],
      ['row 11: `(i) The…` under a heading', `${N_Q}(i) ${N_TT}`, nHead(`(i) ${N_TT}`)],
      [
        'row 13: `2. Keep…`',
        `${N_Q}2. Keep the Premises in good and substantial repair`,
        nMid('2. Keep the Premises in good and substantial repair'),
      ],
      ['row 13: `6.1 The…`', `${N_Q}6.1 ${N_TT}`, nMid(`6.1 ${N_TT}`)],
      [
        'row 13: `- Keep…`',
        `${N_Q}- Keep the Premises in good and substantial repair`,
        nMid('- Keep the Premises in good and substantial repair'),
      ],
    ]);
    // (1) red when no label is passed (the first word read at the line's first letter or digit,
    //     845-V-02's literal reading); (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('row 13: a capital word that is no label stays a word (`A) keep…`, `IV. Keep…`)', () => {
    const rows = nStitched([
      ['row 13: `A) keep…`', `${N_Q}A) ${N_KEEP}`, nMid(`A) ${N_KEEP}`)],
      [
        'row 13: `IV. Keep…`',
        `${N_Q}IV. Keep the Premises in good and substantial repair`,
        nMid('IV. Keep the Premises in good and substantial repair'),
      ],
    ]);
    // (1) red when `A)` or `IV.` is read as a label (handlers.md: `a)`, `A)` and `A.` are no clause
    //     numbers), so the lowercase word after it decides; (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('row 12: an indented line (two spaces, a tab, U+FEFF) under a heading', () => {
    const lines = [
      `(1) ${N_TT}`,
      `(a) ${N_TT}`,
      `(i) ${N_TT}`,
      `(ii) ${N_TT}`,
      `6.1 ${N_TT}`,
      '\u{201c}Rent\u{201d} means the yearly rent reserved by this Lease',
      `- ${N_TT}`,
      N_TT,
    ];
    const rows = nStitched(
      (
        [
          ['two spaces', '  '],
          ['a tab', '\t'],
          ['U+FEFF', '\u{feff}'],
        ] as const
      ).flatMap(([name, indent]) =>
        lines.map((line): NCase => [
          `row 12: \`${line.slice(0, 12)}…\`, ${name}`,
          N_Q + line,
          nHead(line, indent),
        ]),
      ),
    );
    // (1) red when the blanks before the label or mark are not passed; (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('row 12: a blank between marks (`«` + no-break space + `Le Preneur »`, `“ The Landlord…`)', () => {
    const rows = nStitched([
      [
        'row 12: `«` + no-break space + `Le Preneur » désigne…`',
        'The Landlord shall insure the Building against fire \u{2026} \u{ab} Le Preneur \u{bb} d\u{e9}signe la soci\u{e9}t\u{e9}',
        `${N_PREV}\n\n4. RENT\n\n\u{ab}\u{a0}Le Preneur\u{a0}\u{bb} d\u{e9}signe la soci\u{e9}t\u{e9}.`,
      ],
      ['row 12: `“ The Landlord…`', `${N_Q}\u{201c} ${N_LANDLORD}`, nMid(`\u{201c} ${N_LANDLORD}`)],
    ]);
    // (1) red when the blanks between marks are not passed; (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('row 14: `b. “The…` with the label skipped, its `.` a sentence end before a capital past the mark', () => {
    const rows = nStitched([
      ['row 14: `b. “The…`, label skipped', N_Q + N_LANDLORD, nMid(`b. \u{201c}${N_LANDLORD}`)],
    ]);
    // (1) red when rule 3 reads the capital without passing opening marks; (2) prints the row.
    expect(misses(rows)).toEqual([]);
  });
});

describe('#845 1b-i-n check 3: a skip that also passes a label (row 15 and handlers.md :434)', () => {
  it('straight onto the lowercase word: `nearest`, no `cause`; with an opening mark between: refused with `cause`', () => {
    const R = 'The Tenant shall pay the rent on the usual quarter days';
    const doc = (line: string) => `${R}\n\n${line} at all times.`;
    const quote = (tail: string) => `The Tenant shall pay the rent \u{2026} ${tail}`;
    const rows: Row[] = [
      ...(['(b)', '2.', 'b.', 'IV.'] as const).map((l): Row => [
        `row 15: \`${l} keep…\`, label skipped`,
        nRead(
          quote('keep the Premises in good repair'),
          doc(`${l} keep the Premises in good repair`),
        ),
        'not_found+nearest',
      ]),
      [
        ':434: `2. “not be…`, label skipped',
        nRead(
          quote('not be responsible for repairs'),
          doc('2. \u{201c}not be responsible for repairs'),
        ),
        nCause(quote('not be responsible for repairs')),
      ],
      [
        ':434: `b. (subject to clause 5) not…`, label skipped',
        nRead(
          quote('(subject to clause 5) not be responsible for repairs'),
          doc('b. (subject to clause 5) not be responsible for repairs'),
        ),
        nCause(quote('(subject to clause 5) not be responsible for repairs')),
      ],
    ];
    // (1) red when rule 3 is left out (`b. (subject…` reads `stitched`), or read 2 reads as at
    //     ce898697 (`2. “not…` reads `stitched`); (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });
});

describe('#845 1b-i-n check 4: unchanged after a full stop', () => {
  const END =
    'The Landlord shall insure the Building against fire for its full reinstatement cost. The Tenant shall';
  it('after `.` and one line break, the refused pieces read as at ce898697 (`stitched`)', () => {
    const rows = nStitched([
      ['`(subject…`', N_Q + N_SUB, `${END} pay.\n${N_SUB} to the roof.`],
      ['`(b) keep…` with its label', `${N_Q}(b) ${N_KEEP}`, `${END} pay.\n(b) ${N_KEEP}.`],
      ['`2. “not…`, label skipped', N_Q + N_NR, `${END} pay.\n2. \u{201c}${N_NR}.`],
      ['`“not…`', N_Q + N_NR, `${END} pay.\n\u{201c}${N_NR}.`],
      ['`b. (subject…`, label skipped', N_Q + N_SUB, `${END} pay.\nb. ${N_SUB}.`],
    ]);
    // (1) red when rules 1 to 3 apply at every line start; (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });

  it('GROUNDING: after `. ` in mid-line, the same pieces pass by the full-stop test, at no line start', () => {
    const rows = nStitched([
      ['`(subject…`', N_Q + N_SUB, `${END} pay. ${N_SUB} to the roof.`],
      ['`“not…`', N_Q + N_NR, `${END} pay. \u{201c}${N_NR}.`],
    ]);
    // GROUNDING: nothing in this unit can turn these red. (2) prints each differing row.
    expect(misses(rows)).toEqual([]);
  });
});
