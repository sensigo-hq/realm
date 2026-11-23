// locate-quote-rules-845.test.ts — #845 unit 1a's reading rules (`prompts/fix-845-1a-character-reading.md`),
// one cell per acceptance check, each shown red once by its named break. This file holds unit 1a-i's
// half: check 1 (invisible characters leave first), check 2 (a mark stays with its letter, never with
// a number), check 6 (the sets, read in the Basic Multilingual Plane) and check 7 (the spacing
// accent). Unit 1a-ii adds checks 3, 4 and 5 and the sets' reads outside the BMP (check 6's other
// half) here; check 8 is in locate-quote.test.ts. Every input is written as code points.
import { describe, it, expect } from 'vitest';
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

  it('E4, the class that turns until 1b: a list mark directly before a word after `:` and a line break, with no blank or only invisible characters between, reads `stitched`; `2.`+U+200B+`Send` does not', () => {
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
        [`${hex(m)}the`, skipOver(` for its full reinstatement cost:\n${ch(m)}`, lc), 'stitched'],
        [
          `${hex(m)}+U+200B+the (extra2 row 123's class)`,
          skipOver(` for its full reinstatement cost:\n${ch(m)}\u{200b}`, lc),
          'stitched',
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
    // (1) red when E4's class changes before 1b closes it (a mark glued to its word is refused, or
    //     `2.`+U+200B+`Send` opens a part); (2) prints the count and each differing row.
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
