// locate-quote.test.ts — the quote ladder and its canonical form (issue #760; design D2, D3, D6).
//
// The lease fixture (`fixtures/lease-public.txt`) is Realm's own text: a stand-in Irish office lease
// written in-house for the quote pilot on the owner's word of 2026-10-08 ("write a realistic
// stand-in"), with fictional parties (Harbourside Estates Limited, Northwind Analytics Ltd,
// Quayside House). It is not a client's document and not derived from one. Its street addresses,
// Eircodes and company numbers were made fictional before it was committed (the owner's call,
// 2026-10-17: one was a real building), and the quotes below carry the same substitution.
//
// The lease table: the pilot's quotes, copied whole from its run payloads (model run · field), with
// each one's state as the ladder derives it. What a failing cell prints: the row's tag, its state
// and the lease lines its parts fall on — never a span of the source.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { locateQuote, canonicalForm, QUOTE_STATES, type QuoteCheck } from './locate-quote.js';

const LEASE = readFileSync(
  fileURLToPath(new URL('../fixtures/lease-public.txt', import.meta.url)),
  'utf8',
);

/** The lease line (1-based) an offset falls on. */
const lineAt = (offset: number): number => LEASE.slice(0, offset).split('\n').length;

/** The canonical quote, with spaces dropped, equals its parts' canonical slices joined: every
 *  offset maps back to the original source. */
function partsSpellTheQuote(quote: string, check: QuoteCheck, source: string): boolean {
  const squeeze = (t: string): string => canonicalForm(t).replace(/ /g, '');
  const joined = check.parts.map((p) => squeeze(source.slice(p.start, p.end))).join('');
  return joined === squeeze(quote);
}

interface LeaseRow {
  tag: string;
  from: string;
  quote: string;
  state: QuoteCheck['state'];
  lines?: number[];
  nearestLine?: number;
}

const LEASE_ROWS: LeaseRow[] = [
  {
    tag: 'b+1',
    from: 'haiku/R-4 term_commencement_date',
    quote: 'Term Commencement Date means 1 May 2025',
    state: 'reformatted',
    lines: [49],
  },
  {
    tag: 'b+2',
    from: 'haiku/R-4 rent_review_date',
    quote: 'Review Date means 1 May 2030',
    state: 'reformatted',
    lines: [45],
  },
  {
    tag: 'b+3',
    from: 'haiku/R-4 permitted_use',
    quote:
      'Permitted Use means use as offices within the meaning of Class 2 of Part 4 of Schedule 2 to the Planning and Development Regulations 2001, together with ancillary meeting and training rooms',
    state: 'reformatted',
    lines: [37],
  },
  {
    tag: 'c1',
    from: 'haiku/P-0 late_payment_interest',
    quote:
      'Interest at the rate of four per cent (4%) per annum above the Base Rate, calculated on a daily basis',
    state: 'reformatted',
    lines: [33],
  },
  {
    tag: 'd1',
    from: 'haiku/P-0 floor_area_sqm',
    quote:
      'Lettable Area" means the net internal area of the Premises... agreed between the parties at 412 square metres',
    state: 'stitched',
    lines: [35, 35],
  },
  {
    tag: 'd2',
    from: 'opus/P-0 insurance_responsibility',
    quote:
      "The Landlord shall insure the Building (excluding any tenant's fixtures and fittings) against the Insured Risks for its full reinstatement cost... The Tenant shall pay to the Landlord on demand, as insurance rent, a fair proportion of the cost of the insurance effected under clause 6.1",
    state: 'stitched',
    lines: [89, 91],
  },
  {
    tag: 'd3',
    from: 'haiku/P-4 insurance_responsibility',
    quote:
      'The Landlord shall insure the Building... The Tenant shall pay to the Landlord... as insurance rent... The Tenant shall insure its own fixtures, fittings and contents',
    state: 'not_found',
    nearestLine: 93,
  },
  {
    tag: 'd+1',
    from: 'sonnet/R-3 rent_free_period_months',
    quote:
      '"Rent Commencement Date" means the date which is three (3) months after the Term Commencement Date. No Rent shall be payable in respect of the period from the Term Commencement Date to the Rent Commencement Date.',
    state: 'stitched',
    lines: [43, 71],
  },
  {
    tag: 'd+2',
    from: 'haiku/R-1 insurance_responsibility',
    quote:
      'The Landlord shall insure the Building (excluding any tenant\'s fixtures and fittings) against the Insured Risks for its full reinstatement cost" and "The Tenant shall pay to the Landlord on demand, as insurance rent, a fair proportion of the cost of the insurance',
    state: 'stitched',
    lines: [89, 91],
  },
  {
    tag: 'd+3',
    from: 'haiku/R-4 insurance_responsibility',
    quote:
      "The Landlord shall insure the Building (excluding any tenant's fixtures and fittings) against the Insured Risks for its full reinstatement cost. The Tenant shall pay to the Landlord on demand, as insurance rent, a fair proportion of the cost of the insurance. The Tenant shall insure its own fixtures, fittings and contents and shall maintain public liability insurance in respect of its use of the Premises",
    state: 'stitched',
    lines: [89, 91, 93],
  },
  {
    tag: 'e1a',
    from: 'sonnet/R-5 late_payment_interest',
    quote:
      '"Interest" means interest at the rate of four per cent (4%) per annum above the Base Rate ... "Base Rate" means the main refinancing operations rate of the European Central Bank from time to time.',
    state: 'stitched_out_of_order',
    lines: [33, 23],
  },
  {
    tag: 'e1b',
    from: 'haiku/R-2 premises_address',
    quote:
      'the whole of the third (3rd) floor of the Building, as shown edged red on Plan 1... The Landlord is the owner of the building known as Quayside House, 3 Saltwater Quay, Dublin 2, D02 QT44, Ireland',
    state: 'stitched_out_of_order',
    lines: [39, 13],
  },
  {
    tag: 'e1c',
    from: 'haiku/R-5 premises_address',
    quote:
      'Premises" means the whole of the third (3rd) floor of the Building, as shown edged red on Plan 1... "Building" has the meaning given in Recital (A). The Landlord is the owner of the building known as Quayside House, 3 Saltwater Quay, Dublin 2, D02 QT44, Ireland',
    state: 'not_found',
    nearestLine: 13,
  },
  {
    tag: 'e2',
    from: 'haiku/P-0 break_notice_months',
    quote:
      "The Tenant may terminate this Lease on 30 April 2031... by giving the Landlord not less than six (6) months' prior written notice",
    state: 'not_found',
    nearestLine: 119,
  },
  {
    tag: 'g1',
    from: 'haiku/R-4 break_notice_months',
    quote:
      "The Tenant may terminate this Lease on 30 April 2030 by giving the Landlord not less than six (6) months' prior written notice",
    state: 'stitched',
    lines: [119, 119],
  },
  {
    tag: 'g2',
    from: 'haiku/R-4 floor_area_sqm',
    quote:
      'Lettable Area of the Premises measured in accordance with the RICS Code of Measuring Practice (6th edition), agreed between the parties at 412 square metres',
    state: 'stitched_out_of_order',
    lines: [165, 35],
  },
  {
    tag: 'g3',
    from: 'sonnet/R-4 insurance_responsibility',
    quote:
      "The Landlord shall insure the Building (excluding any tenant's fixtures and fittings) against the Insured Risks for its full reinstatement cost, and shall use reasonable endeavours to procure that the insurer waives its rights of subrogation against the Tenant. The Tenant shall pay to the Landlord on demand, as insurance rent, a fair proportion of the cost of the insurance effected under clause 6.1, together with the cost of a professional valuation of the Building for insurance purposes once every three years.",
    state: 'stitched',
    lines: [89, 91],
  },
];

describe('locateQuote — the lease table: the pilot quotes, one state each', () => {
  for (const row of LEASE_ROWS) {
    it(`${row.tag} (${row.from}) → ${row.state}`, () => {
      const check = locateQuote(row.quote, LEASE);
      // (a) red when a ladder layer, a canonical rule or the floor changes this row's state or
      //     where its parts land; (b) prints the tag, the state, the lines and the nearest line.
      expect({
        tag: row.tag,
        state: check.state,
        lines: check.parts.map((p) => lineAt(p.start)),
        nearestLine: check.nearest === undefined ? undefined : lineAt(check.nearest.start),
        spelled: check.parts.length === 0 || partsSpellTheQuote(row.quote, check, LEASE),
      }).toEqual({
        tag: row.tag,
        state: row.state,
        lines: row.lines ?? [],
        nearestLine: row.nearestLine,
        spelled: true,
      });
    });
  }
});

describe('locateQuote — every state on constructed inputs', () => {
  const SOURCE =
    'The Tenant shall pay the rent quarterly in advance. The Landlord shall repair the roof and ' +
    'the structure of the building at its own cost. Either party may end this agreement early.';

  it('exact: a literal substring, its span and its count', () => {
    const c = locateQuote('shall repair the roof', SOURCE);
    // (a) red when the literal layer is skipped or its span is off; (b) prints the state and span.
    expect({ state: c.state, span: SOURCE.slice(c.parts[0]!.start, c.parts[0]!.end) }).toEqual({
      state: 'exact',
      span: 'shall repair the roof',
    });
  });

  it('reformatted: case and punctuation differ, the canonical text is the same', () => {
    const c = locateQuote('"THE LANDLORD shall repair the roof, and the structure"', SOURCE);
    // (a) red when the canonical layer is removed (the quote falls to the stitched layers); (b)
    //     prints the state and whether the parts spell the quote.
    expect({
      state: c.state,
      spelled: partsSpellTheQuote(
        c.parts.length ? '"THE LANDLORD shall repair the roof, and the structure"' : '',
        c,
        SOURCE,
      ),
    }).toEqual({
      state: 'reformatted',
      spelled: true,
    });
  });

  it('stitched: two marked parts in order; and an unmarked drop between two parts above the floor', () => {
    const marked = locateQuote(
      'The Tenant shall pay the rent quarterly … at its own cost. Either party may end',
      SOURCE,
    );
    const unmarked = locateQuote(
      'The Tenant shall pay the rent in advance. The Landlord shall repair the roof',
      SOURCE,
    );
    // (a) red when the stitched layer is removed (both fall to not_found); (b) prints the states and
    //     the part counts.
    expect({
      marked: [marked.state, marked.parts.length],
      unmarked: [unmarked.state, unmarked.parts.length],
    }).toEqual({ marked: ['stitched', 2], unmarked: ['stitched', 2] });
  });

  it('stitched_out_of_order: every part found, but not in the order quoted', () => {
    const c = locateQuote(
      'Either party may end this agreement … The Tenant shall pay the rent',
      SOURCE,
    );
    // (a) red when the out-of-order layer is removed (the quote falls to not_found); (b) prints the
    //     state and the parts' order in the source.
    expect({ state: c.state, laterFirst: c.parts[0]!.start > c.parts[1]!.start }).toEqual({
      state: 'stitched_out_of_order',
      laterFirst: true,
    });
  });

  it('not_found: with `nearest` where part of the quote is in the source, without it where none is', () => {
    const near = locateQuote('The Landlord shall repaint every window each spring', SOURCE);
    const none = locateQuote('xyz', 'abc');
    // (a) red when an invented sentence is found, or `nearest` is dropped or invented; (b) prints
    //     the states, the parts and whether `nearest` exists.
    expect({
      near: [near.state, near.parts.length, near.nearest !== undefined],
      none: [none.state, none.parts.length, none.nearest !== undefined],
    }).toEqual({ near: ['not_found', 0, true], none: ['not_found', 0, false] });
  });

  it('the six states are one list, in the documented order', () => {
    // (a) red when a state is renamed, added or dropped; (b) prints the list.
    expect(QUOTE_STATES).toEqual([
      'exact',
      'reformatted',
      'stitched',
      'stitched_out_of_order',
      'not_found',
      'unquoted',
    ]);
  });
});

describe('locateQuote — digits, their separators and their symbols are load-bearing', () => {
  // Each pair: the changed text is refused, and the same text unchanged is found (the control), so a
  // cell can only fail for its rule. Two pairs are held by two rules at once, because a dash between
  // two digits is both a separator between digits (rule i) and a dash before a digit (rule ii):
  // `9.5 ≠ 9-5` and `3-4 ≠ 34` go red only with both rules removed.
  const PAIRS: Array<[string, string, string, string]> = [
    ['9.5 ≠ 9-5', 'the rate is 9.5 here', 'so the rate is 9-5 here', 'so the rate is 9.5 here'],
    ['2,000 ≠ 2.000', 'they pay 2,000 now', 'so they pay 2.000 now', 'so they pay 2,000 now'],
    ['5% ≠ 5', 'rises by 5% each year', 'rent rises by 5 each year', 'rent rises by 5% each year'],
    [
      '$1,200 ≠ £1,200',
      'a fee of $1,200 applies',
      'a fee of £1,200 applies',
      'a fee of $1,200 applies',
    ],
    [
      'clause 9 ⊄ clause 9a',
      'see clause 9',
      'please see clause 9a below',
      'please see clause 9 below',
    ],
    ['-5 ≠ 5', 'a balance of -5 units', 'a balance of 5 units', 'a balance of -5 units'],
    ['3-4 ≠ 34', 'pages 3-4 of it', 'read pages 34 of it', 'read pages 3-4 of it'],
    ['9,20 ⊄ 9,200', 'a cap of €9,20', 'a cap of €9,200 a year', 'a cap of €9,20 a year'],
  ];
  for (const [rule, quote, changed, same] of PAIRS) {
    it(rule, () => {
      // (a) red when the rule is dropped (the changed text is found) or over-reaches (the same text
      //     is not); (b) prints the two states.
      expect([locateQuote(quote, changed).state, locateQuote(quote, same).state]).toEqual([
        'not_found',
        'exact',
      ]);
    });
  }

  it('3–4 ≡ 3-4: the dash variants are one dash', () => {
    // (a) red when an en dash is dropped instead of mapped; (b) prints the state.
    expect(locateQuote('pages 3–4 of it', 'read pages 3-4 of it').state).toBe('reformatted');
  });

  it('the edges: a quote digit never touches a source letter or digit (Schedule 2 ⊄ Schedule 2A; 031 ⊄ 2031)', () => {
    // (a) red when the edge rule is removed (both are found); (b) prints the two states.
    expect([
      locateQuote('as in Schedule 2', 'as in Schedule 2A').state,
      locateQuote('031 the break', 'in 2031 the break').state,
    ]).toEqual(['not_found', 'not_found']);
  });
});

describe('locateQuote — the floor, the count, the offsets, the empty inputs, the cost', () => {
  const A20 = 'aaaa bbbb cccc ddddd'; // 20 canonical characters
  const B20 = 'eeee ffff gggg hhhhh'; // 20
  const B19 = 'eeee ffff gggg hhhh'; // 19

  it('the floor: a 20-character part stitches; a 19-character part does not', () => {
    const source = `${A20} then ${B20} again`;
    // (a) red when the floor compares with `>` (20 fails) or is ignored (19 passes); (b) prints the
    //     two states.
    expect([
      locateQuote(`${A20}… ${B20}`, source).state,
      locateQuote(`${A20}… ${B19}`, source).state,
    ]).toEqual(['stitched', 'not_found']);
  });

  it('minPartChars: a lower floor admits the shorter part; less than 4 is refused', () => {
    const source = `${A20} then ${B20} again`;
    let refused = false;
    try {
      locateQuote('x', 'x', { minPartChars: 3 });
    } catch (err) {
      refused = err instanceof RangeError;
    }
    // (a) red when the option is ignored or the least floor is not enforced; (b) prints the state
    //     and a boolean.
    expect([locateQuote(`${A20}… ${B19}`, source, { minPartChars: 19 }).state, refused]).toEqual([
      'stitched',
      true,
    ]);
  });

  it('occurrences: a repeated quote records its first span and the count', () => {
    const source = 'the Tenant pays and the Tenant repairs';
    const c = locateQuote('the Tenant', source);
    // (a) red when only the first occurrence is counted; (b) prints the count and the span.
    expect({ occurrences: c.occurrences, first: c.parts[0] }).toEqual({
      occurrences: 2,
      first: { start: 0, end: 10 },
    });
  });

  it('offsets: every part maps back to the original source across dropped characters', () => {
    const source = 'The "Lettable Area" — agreed: 412 square metres, (the “Area”).';
    const c = locateQuote('lettable area agreed 412 square metres the area', source);
    // (a) red when the index map is off at a dropped character (the slice no longer spells the
    //     quote); (b) prints the state and a boolean.
    expect({
      state: c.state,
      spelled: partsSpellTheQuote('lettable area agreed 412 square metres the area', c, source),
      start: c.parts[0]?.start,
      end: c.parts[0]?.end,
    }).toEqual({
      state: 'reformatted',
      spelled: true,
      start: 5,
      end: 59, // the last letter of “Area”, never its closing mark
    });
  });

  it('an empty source finds nothing; an empty or wordless quote is not_found with no parts', () => {
    // (a) red when an empty input is matched; (b) prints the three states and part counts.
    expect(
      [locateQuote('anything', ''), locateQuote('', 'a source'), locateQuote('...', 'a ... b')].map(
        (c) => [c.state, c.parts.length],
      ),
    ).toEqual([
      ['not_found', 0],
      ['not_found', 0],
      ['not_found', 0],
    ]);
  });

  it(
    'the cost: 25 quotes of 3,000 characters over a 40,000-character source in under a second',
    { timeout: 10_000 },
    () => {
      const copies = [
        LEASE,
        LEASE.replace(/Lease/g, 'Agreement'),
        LEASE.replace(/Tenant/g, 'Lessee'),
      ];
      const source = copies.join('\n\n').slice(0, 40_000);
      const quotes = Array.from({ length: 25 }, (_, q) => {
        const start = (q * 1543) % (source.length - 3_100);
        const window = source.slice(start, start + 3_000);
        if (q % 3 === 1) return window.slice(0, 1_400) + window.slice(1_440); // a drop: tiled
        if (q % 3 === 2)
          return `${window.slice(0, 1_500)} Zebra quartz fjords vex. ${window.slice(1_500)}`;
        return window;
      });
      const began = performance.now();
      const states = quotes.map((quote) => locateQuote(quote, source).state);
      const elapsed = performance.now() - began;
      // (a) red when locating grows far slower — a coarse budget: tiling one character at a time
      //     measured 0.44 s here, against 0.08 s, so the next cell carries that break's red; (b)
      //     prints whether it was under a second and how many quotes were located.
      expect({ underASecond: elapsed < 1_000, located: states.length }).toEqual({
        underASecond: true,
        located: 25,
      });
    },
  );

  it('the tiling halves its search: a 3,000-character quote with one drop costs a few dozen substring searches, not thousands', () => {
    const window = LEASE.slice(2_000, 5_000);
    const quote = window.slice(0, 1_400) + window.slice(1_440);
    const includes = vi.spyOn(String.prototype, 'includes');
    const state = locateQuote(quote, LEASE).state;
    const searches = includes.mock.calls.length;
    includes.mockRestore();
    // (a) red when a tile grows one character at a time (measured 2,867 searches, against 22 by
    //     halving); (b) prints the state and whether the searches stayed under 60.
    expect({ state, underSixty: searches < 60 }).toEqual({ state: 'stitched', underSixty: true });
  });
});
