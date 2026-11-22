// locate-quote-rules-845.test.ts — #845 unit 1a's reading rules (`prompts/fix-845-1a-character-reading.md`),
// one cell per acceptance check, each shown red once by its named break. This file holds unit 1a-i's
// half: check 1 (invisible characters leave first), check 2 (a mark stays with its letter, never with
// a number), check 6 (the sets, read in the Basic Multilingual Plane) and check 7 (the spacing
// accent). Unit 1a-ii adds checks 3, 4, 5 and 8 and the sets' reads outside the BMP. Every input is
// written as code points.
import { describe, it, expect } from 'vitest';
import { canonicalForm, locateQuote, releaseQuoteCache, segmentsOf } from './locate-quote.js';

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
