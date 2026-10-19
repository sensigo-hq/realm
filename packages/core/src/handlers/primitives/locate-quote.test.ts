// locate-quote.test.ts — the quote ladder and its canonical form (issue #760; design D2, D3, D6).
//
// The lease fixture (`fixtures/lease-public.txt`) is Realm's own text: a stand-in Irish office lease
// written in-house for the quote pilot on the owner's word of 2026-10-08 ("write a realistic
// stand-in"), with fictional parties (Tallowmere Estates Limited, Northwind Analytics Ltd,
// Quayside House). It is not a client's document and not derived from one. Its street addresses,
// Eircodes and company numbers were made fictional before it was committed (the owner's call,
// 2026-10-17: one was a real building), and the quotes below carry the same substitution. Its
// landlord's name and the two company numbers were changed again on 2026-10-18 (correction 1, L6:
// the earlier fictional name matched a registered company; the numbers sat in the Irish register's
// series): no register has the name, and the numbers are FICT-0001 and FICT-0002.
//
// The lease table: the pilot's quotes, copied whole from its run payloads (model run · field), with
// each one's state as the ladder derives it. What a failing cell prints: the row's tag, its state
// and the lease lines its parts fall on — never a span of the source.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  locateQuote,
  canonicalForm,
  segmentsOf,
  QUOTE_STATES,
  QUOTE_SEARCH_BUDGET,
  type QuoteCheck,
} from './locate-quote.js';

const LEASE = readFileSync(
  fileURLToPath(new URL('../fixtures/lease-public.txt', import.meta.url)),
  'utf8',
);

/** The lease line (1-based) an offset falls on. */
const lineAt = (offset: number): number => LEASE.slice(0, offset).split('\n').length;

/** The canonical quote equals its parts' canonical slices joined by one space, and no slice starts
 *  or ends with a space (correction A9: spaces kept, so a span off by one space shows): every offset
 *  maps back to the original source. */
function partsSpellTheQuote(quote: string, check: QuoteCheck, source: string): boolean {
  const slices = check.parts.map((p) => source.slice(p.start, p.end));
  const tight = slices.every((t) => t === t.trim());
  return tight && slices.map((t) => canonicalForm(t)).join(' ') === canonicalForm(quote);
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
    // Correction 2, the skip rule: after `...` the quote resumes at "agreed between", mid-sentence —
    // honest, but a skip must land where the document starts a sentence, a clause or a line.
    state: 'not_found',
    nearestLine: 35,
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
    // Correction 1, Part S: each of its three sentences is found whole (l.39, l.25, l.13), out of
    // order — it was not_found when a marked piece was never split at its own sentence ends.
    state: 'stitched_out_of_order',
    lines: [39, 25, 13],
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
    // Correction 1, Part S: it drops `(the "Break Date")` inside one sentence and has no break, so
    // nothing may be skipped — honest, but no longer `stitched`.
    state: 'not_found',
    nearestLine: 119,
  },
  {
    tag: 'g2',
    from: 'haiku/R-4 floor_area_sqm',
    quote:
      'Lettable Area of the Premises measured in accordance with the RICS Code of Measuring Practice (6th edition), agreed between the parties at 412 square metres',
    // Correction 1, Part S: not a quote (five words dropped inside one sentence, its first piece
    // borrowed from l.165) — rightly not_found, its first hypothesis.
    state: 'not_found',
    nearestLine: 35,
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

  it('stitched: two marked pieces in order; a piece that sits next to the next one in the source joins it into one part (Part S, rule 3)', () => {
    // "The Landlord shall repair the roof" and "and the structure of the building" sit together in the
    // source, so the `;` the quote adds between them joins them into ONE part, which starts a
    // sentence. Correction 2 re-pin: the earlier quote resumed at "at its own cost", mid-sentence,
    // which the skip rule now refuses.
    const marked = locateQuote(
      'The Tenant shall pay the rent quarterly … The Landlord shall repair the roof; and the structure of the building',
      SOURCE,
    );
    // (a) red when pieces next to each other are not merged ("and the structure…" then follows a
    //     skip mid-sentence); (b) prints the state and the part count.
    expect([marked.state, marked.parts.length]).toEqual(['stitched', 2]);
  });

  it('not_found: an unmarked drop inside one sentence — text is never skipped inside a piece (Part S, rules 5 and 6)', () => {
    const unmarked = locateQuote(
      'The Tenant shall pay the rent in advance. The Landlord shall repair the roof',
      SOURCE,
    );
    // (a) red when the prefix tiler makes parts again (the drop of "quarterly" reads stitched);
    //     (b) prints the state and the part count.
    expect([unmarked.state, unmarked.parts.length]).toEqual(['not_found', 0]);
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
  // Correction 3: each second part opens with a capital, since after a full stop a sentence starts
  // with one (01, rule rev 3); the floor alone still decides.
  const B20 = 'Eeee ffff gggg hhhhh'; // 20
  const B19 = 'Eeee ffff gggg hhhh'; // 19

  // Each source holds its pieces as whole words, so the floor alone decides (correction 1, A2: a
  // 19-character piece cut out of `hhhhh` would be refused at its word edge whatever the floor), and
  // the second piece starts a sentence (correction 2: a skip lands only where one starts).
  it('the floor: a 20-character part stitches; a 19-character part does not', () => {
    // (a) red when the floor compares with `>` (20 fails) or is ignored (19 passes); (b) prints the
    //     two states.
    expect([
      locateQuote(`${A20}… ${B20}`, `${A20} then. ${B20} again`).state,
      locateQuote(`${A20}… ${B19}`, `${A20} then. ${B19} again`).state,
    ]).toEqual(['stitched', 'not_found']);
  });

  it('minPartChars: a lower floor admits the shorter part; less than 4 is refused', () => {
    const source = `${A20} then. ${B19} again`;
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

  it('the nearest tiler: a 3,000-character quote with one drop costs about a hundred substring searches, not thousands', () => {
    // Correction 1: under Part S the drop inside one sentence is not_found, so the searches counted
    // are the `nearest` tiler's (A8), `includes`, `indexOf` and `startsWith` alike. (Correction 2:
    // halving from the full length costs 67 here, so this cell pins the cost, not the doubling; the
    // next cell pins the doubling.)
    const window = LEASE.slice(2_000, 5_000);
    const quote = window.slice(0, 1_400) + window.slice(1_440);
    const spies = (['includes', 'indexOf', 'startsWith'] as const).map((m) =>
      vi.spyOn(String.prototype, m),
    );
    const check = locateQuote(quote, LEASE);
    const searches = spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
    for (const spy of spies) spy.mockRestore();
    // (a) red when a tile grows one character at a time (it then spends the whole budget, 1,000);
    //     (b) prints the state, whether `nearest` exists and whether the searches stayed under 150.
    expect({
      state: check.state,
      nearest: check.nearest !== undefined,
      under150: searches < 150,
    }).toEqual({ state: 'not_found', nearest: true, under150: true });
  });

  it('the nearest tiler grows its tiles by doubling: a 600-character made-up quote costs under 800 substring searches', () => {
    // Correction 2 (ride-along): measured 695 searches with doubling, 928 when each tile is found by
    // halving from the full length, both inside the 1,000 budget.
    const words =
      'the landlord tenant shall pay rent quarterly premises building repair insure lease term notice clause schedule party consent assign deposit interest rate annum review service charge cost structure roof window door spring autumn every each'.split(
        ' ',
      );
    let seed = 7;
    const next = (): number =>
      (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    let quote = '';
    while (quote.length < 600) quote += `${words[Math.floor(next() * words.length)]} `;
    quote = quote.slice(0, 600).trim();
    const spies = (['includes', 'indexOf', 'startsWith'] as const).map((m) =>
      vi.spyOn(String.prototype, m),
    );
    const check = locateQuote(quote, LEASE);
    const searches = spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
    for (const spy of spies) spy.mockRestore();
    // (a) red when a tile is found by halving from the full length (928); (b) prints the state and
    //     whether the searches stayed under 800.
    expect({ state: check.state, under800: searches < 800 }).toEqual({
      state: 'not_found',
      under800: true,
    });
  });
});

// ─── correction 1: the locating rule (01), the stitching rule (02), the leftovers (09) ───────────

describe('locateQuote — correction 1, A1: a number is one unit', () => {
  const NOT_FOUND: Array<[string, string, string]> = [
    ['€48 inside €48,000', 'an initial annual rent of forty-eight thousand euro (€48', LEASE],
    ['18 inside 18.5', 'being 18', 'the total area, being 18.5 per cent'],
    ['€9 inside €9,200', 'a cap of €9', 'a cap of €9,200 a year'],
    ['200 a year inside €9,200', '200 a year', 'a cap of €9,200 a year'],
    ['5% above inside 4.5%', '5% above', 'at the rate of 4.5% above base'],
    ['rate of 4 inside 4.5%', 'rate of 4', 'at the rate of 4.5% above base'],
    ['5 degrees inside −5', '5 degrees', 'kept at −5 degrees'],
    ['-5 degrees out of a range dash', '-5 degrees', 'kept between 3-5 degrees'],
    ['5 business days inside 3–5', '5 business days', 'within 3–5 business days'],
    ['5 business days inside 3—5', '5 business days', 'within 3—5 business days'],
    ['a term of 2 inside 2½', 'a term of 2', 'for a term of 2½ years'],
    ['a factor of 10 inside 10⁶', 'a factor of 10', 'by a factor of 10⁶ more'],
    ['5% of the rent after <', '5% of the rent', 'a deposit of <5% of the rent'],
    ['5% of the rent after ≤', '5% of the rent', 'a deposit of ≤5% of the rent'],
  ];
  for (const [name, quote, source] of NOT_FOUND) {
    it(`${name} → not_found`, () => {
      // (a) red when the edge rule reads one neighbouring character only (the shorter number is
      //     found inside the longer); (b) prints the state.
      expect(locateQuote(quote, source).state).toBe('not_found');
    });
  }

  it('a number symbol a piece cuts off: `(4… The Tenant…` and `48,000 is payable… The Tenant…` are not stitched (the sign belongs to its number)', () => {
    // Correction 3 (ride-along): each second piece starts a sentence, so the skip rule lets it
    // through and only the number edge refuses each quote (one rule each). The `€` cut sits in the
    // first piece: a later piece that cuts off a sign before it never starts a sentence, so the skip
    // rule would refuse it too.
    // (a) red when a part may end at a digit the source follows with `%`, or start at one it
    //     precedes with `€` (each then stitches, the sign dropped); (b) prints the two states.
    expect([
      locateQuote(
        'Interest runs at the rate of four per cent (4… The Tenant shall pay it on demand',
        'Interest runs at the rate of four per cent (4%) per annum above the Base Rate. The Tenant shall pay it on demand.',
      ).state,
      locateQuote(
        '48,000 is payable on the first day of the term … The Tenant shall pay it on demand',
        '€48,000 is payable on the first day of the term, in advance. The Tenant shall pay it on demand.',
      ).state,
    ]).toEqual(['not_found', 'not_found']);
  });

  it("the walk's own quotes — (€500,000), (4) per annum, (48,000) — are not_found (held by Part S, rule 6, and A1 together)", () => {
    // (a) red when any of them is found; (b) prints the three states. Their single-rule reds are the
    //     cells above and Part S's.
    expect(
      [
        'a limit of indemnity of not less than five hundred thousand euro (€500,000) for any one occurrence',
        'the rate of four per cent (4) per annum above the Base Rate',
        'an initial annual rent of forty-eight thousand euro (48,000), exclusive of value added tax, subject to review under Schedule 4',
      ].map((q) => locateQuote(q, LEASE).state),
    ).toEqual(['not_found', 'not_found', 'not_found']);
  });

  it('controls, still found: a number before a full stop and a space; one before a comma and a space', () => {
    // (a) red when a separator followed by a space is read as joining a number; (b) prints the two
    //     states.
    expect([
      locateQuote('the rent is 9', 'the rent is 9. The tenant pays').state,
      locateQuote('items 3', 'see items 3, 4 and 5').state,
    ]).toEqual(['exact', 'exact']);
  });
});

describe('locateQuote — correction 1, A2: every piece starts and ends at a word edge', () => {
  it('a piece cut inside a word is not found: `whole o… r any part of the Premises`', () => {
    // (a) red when the boundary is unchecked (the two halves of "or" join into one part); (b)
    //     prints the state.
    expect(
      locateQuote('part with possession of the whole o… r any part of the Premises', LEASE).state,
    ).toBe('not_found');
  });

  it('a "not" cut out of "notify" is not found', () => {
    // A break makes the pieces count: the first ends inside "notify" at l.133.
    const quote =
      'or to such other address as the Landlord may not. Notices to the Tenant shall be sent to the Premises.';
    // (a) red when the boundary is unchecked (it stitches l.133 and l.135); (b) prints the state.
    expect(locateQuote(quote, LEASE).state).toBe('not_found');
  });

  it("the review's own quote, `The Landlord may not draw on the rent deposit to make good…`, is not_found (held by A2 and Part S, rule 6)", () => {
    // The review's table cut it with "…"; whole, it has no break, and before this correction it read
    // stitched_out_of_order: "the Landlord may not" from "may notify" (l.133), then l.79.
    const quote =
      'The Landlord may not draw on the rent deposit to make good any failure by the Tenant to pay the Rent';
    // (a) red when it is found; (b) prints the state. Its single-rule reds are the cell above and
    //     Part S's.
    expect(locateQuote(quote, LEASE).state).toBe('not_found');
  });
});

describe('locateQuote — correction 1, A3–A6: comparison signs, superscripts, the dashes, the kept symbols', () => {
  const PAIRS: Array<[string, string, string]> = [
    ['<5% ≠ >5%', 'the deposit is <5% of the rent', 'the deposit is >5% of the rent'],
    ['≤ 10% ≠ ≥ 10%', 'a discount of ≤ 10%', 'a discount of ≥ 10%'],
    ['+5 ≠ -5', 'a change of +5 units', 'a change of -5 units'],
    ['5‰ ≠ 5', 'a levy of 5‰ applies', 'a levy of 5 applies'],
    ['5° ≠ 5', 'kept at 5° here', 'kept at 5 here'],
    ['clause 91 ⊄ clause 9¹', 'clause 91 applies', 'clause 9¹ applies'],
    // The quote ends at its digit, so folding `½` to `1⁄2` would expose `21` (`a term of 21 years`
    // could never match `21⁄2 years`, so it would test no rule): held by A4 (no fold) and A3 (`⁄` is
    // a comparison sign, a number symbol at the edge) together.
    ['a term of 21 ⊄ 2½', 'a term of 21', 'a term of 2½ years'],
    ['106 ⊄ 10⁶', 'a factor of 106', 'a factor of 10⁶'],
  ];
  for (const [name, quote, source] of PAIRS) {
    it(`${name} → not_found`, () => {
      // (a) red when the sign or the shape is dropped or folded; (b) prints the state.
      expect(locateQuote(quote, source).state).toBe('not_found');
    });
  }

  const SAME: Array<[string, string, string]> = [
    ['a b ≡ a, b (other punctuation still set aside)', 'pay a b now', 'pay a, b now'],
    ['ﬁnal ≡ final (NFKC folds ligatures)', 'the ﬁnal account', 'the final account'],
    ['１２ ≡ 12 (NFKC folds full-width digits)', 'within １２ months', 'within 12 months'],
    ['3−4 ≡ 3-4 (U+2212)', 'pages 3−4 of it', 'read pages 3-4 of it'],
    ['3—4 ≡ 3-4 (U+2014)', 'pages 3—4 of it', 'read pages 3-4 of it'],
    ['3–4 ≡ 3-4 (U+2013)', 'pages 3–4 of it', 'read pages 3-4 of it'],
  ];
  for (const [name, quote, source] of SAME) {
    it(`${name} → reformatted`, () => {
      // (a) red when that member is not mapped or folded (the quote is not found); (b) prints the
      //     state.
      expect(locateQuote(quote, source).state).toBe('reformatted');
    });
  }

  it('A6: a quote with no letter or digit is not_found — `%`, `€`, `°`, `(€)`', () => {
    // (a) red when a symbol-only quote is matched (it read exact); (b) prints the four states.
    expect(
      ['%', '€', '°', '(€)'].map((q) => locateQuote(q, 'a rise of 5% (€) at 20°').state),
    ).toEqual(['not_found', 'not_found', 'not_found', 'not_found']);
  });
});

describe('locateQuote — correction 1, A7–A9: `nearest`, the cost, the gaps', () => {
  it('A7: `nearest` holds a whole word, or is absent — `zzzz qqqq wwww` has none; `due in 60 days` keeps `due in`', () => {
    const none = locateQuote('zzzz qqqq wwww', LEASE);
    const source = 'Payment is due in 30 days.';
    const near = locateQuote('due in 60 days', source);
    // (a) red when a one-letter span is kept as `nearest`, or a whole-word one is dropped; (b)
    //     prints the two `nearest` values.
    expect({
      none: none.nearest,
      near:
        near.nearest === undefined ? undefined : source.slice(near.nearest.start, near.nearest.end),
    }).toEqual({ none: undefined, near: 'due in' });
  });

  it('A8: the 400-character `a1a1…` quote against an 8,000-character `a1…` source stays inside the budget, in under a second', () => {
    const spies = (['includes', 'indexOf', 'startsWith'] as const).map((m) =>
      vi.spyOn(String.prototype, m),
    );
    const began = performance.now();
    const state = locateQuote('a1'.repeat(200), 'a1'.repeat(4_000)).state;
    const elapsed = performance.now() - began;
    const searches = spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
    for (const spy of spies) spy.mockRestore();
    // (a) red under the old tiling (halving from the full length, one-character retreats, no
    //     budget: 58 s measured); (b) prints the state, and whether the searches and the time stayed
    //     inside their bounds.
    expect({
      state,
      withinBudget: searches <= QUOTE_SEARCH_BUDGET + 50,
      underASecond: elapsed < 1_000,
    }).toEqual({ state: 'not_found', withinBudget: true, underASecond: true });
  });

  it(
    'A8: 25 fabricated 3,000-character prose quotes over a 40,000-character source in under a second',
    { timeout: 20_000 },
    () => {
      const words =
        'the landlord tenant shall pay rent quarterly premises building repair insure lease term notice clause schedule party consent assign deposit interest rate annum review service charge cost structure roof window door spring autumn every each'.split(
          ' ',
        );
      let seed = 7;
      const next = (): number =>
        (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
      const prose = (length: number): string => {
        let text = '';
        while (text.length < length)
          text += `${words[Math.floor(next() * words.length)]}${next() < 0.08 ? '. ' : ' '}`;
        return text.slice(0, length);
      };
      const source = [
        LEASE,
        LEASE.replace(/Lease/g, 'Agreement'),
        LEASE.replace(/Tenant/g, 'Lessee'),
      ]
        .join('\n\n')
        .slice(0, 40_000);
      const quotes = Array.from({ length: 25 }, () => prose(3_000));
      const began = performance.now();
      const states = new Set(quotes.map((q) => locateQuote(q, source).state));
      const elapsed = performance.now() - began;
      // (a) red under the old tiling (3.1–3.4 s measured by the review); (b) prints the states seen
      //     and whether it was under a second.
      expect({ states: [...states], underASecond: elapsed < 1_000 }).toEqual({
        states: ['not_found'],
        underASecond: true,
      });
    },
  );

  it('A9: a quote letter beside a source digit, and a quote digit after a source letter, are edge clashes', () => {
    // (a) red when either one-character rule is dropped (each is then found); (b) prints the two
    //     states.
    expect([
      locateQuote('see Plan A', 'see Plan A1 attached').state,
      locateQuote('1 floor', 'the A1 floor').state,
    ]).toEqual(['not_found', 'not_found']);
  });

  it('A9: minPartChars must be whole — 4.5 is refused, and the message says why', () => {
    let message = '';
    try {
      locateQuote('x', 'x', { minPartChars: 4.5 });
    } catch (err) {
      message = err instanceof RangeError ? err.message : '';
    }
    // (a) red when a fraction is accepted, or the text changes; (b) prints the message.
    expect(message).toBe('locateQuote: minPartChars must be an integer of at least 4 (got 4.5)');
  });
});

describe('locateQuote — correction 1, Part S: a quote skips text only where it breaks', () => {
  it('a quote that drops one "not" from a lease sentence is not_found', () => {
    // l.85: "…any service charge year shall not exceed nine thousand two hundred euro (€9,200)…". Its
    // text before "not" passes the floor at a word edge, so Part S alone refuses it (l.97's "The
    // Tenant shall not be…" is refused by the floor too: "the tenant shall" is 16 characters).
    const quote =
      'The Service Charge payable in respect of any service charge year shall exceed nine thousand two hundred euro (€9,200)';
    // (a) red when the prefix tiler makes parts again (the one-word skip stitches, l.85 twice); (b)
    //     prints the state.
    expect(locateQuote(quote, LEASE).state).toBe('not_found');
  });

  it('a "not" added from another clause is not_found: `The Tenant shall not pay the Service Charge…`', () => {
    // (a) red when the prefix tiler makes parts again; (b) prints the state.
    expect(
      locateQuote(
        'The Tenant shall not pay the Service Charge in accordance with Schedule 3.',
        LEASE,
      ).state,
    ).toBe('not_found');
  });

  it('a "not" added from another clause is not_found: `The Tenant shall not comply with all laws…`', () => {
    // (a) red when the prefix tiler makes parts again; (b) prints the state.
    expect(
      locateQuote(
        'The Tenant shall not comply with all laws relating to the Premises and to its use of them',
        LEASE,
      ).state,
    ).toBe('not_found');
  });

  const FIRST =
    '"Interest" means interest at the rate of four per cent (4%) per annum above the Base Rate, calculated on a daily basis from the date on which the relevant payment was due until the date of actual payment, both before and after any judgment.';
  const SECOND =
    'The Tenant shall comply with all laws relating to the Premises and to its use of them, including all requirements of the fire authority.';

  it('two whole sentences, in order, far apart, quoted with `. ` between → stitched', () => {
    const c = locateQuote(`${FIRST} ${SECOND}`, LEASE);
    // (a) red when a sentence end is not a break (the quote is then one piece, not found); (b)
    //     prints the state and the parts' lines.
    expect({ state: c.state, lines: c.parts.map((p) => lineAt(p.start)) }).toEqual({
      state: 'stitched',
      lines: [33, 107],
    });
  });

  it('the same two sentences reversed → stitched_out_of_order', () => {
    const c = locateQuote(`${SECOND} ${FIRST}`, LEASE);
    // (a) red when out-of-order placement is removed (it falls to not_found); (b) prints the state
    //     and the parts' lines.
    expect({ state: c.state, lines: c.parts.map((p) => lineAt(p.start)) }).toEqual({
      state: 'stitched_out_of_order',
      lines: [107, 33],
    });
  });

  it('a marked quote whose two pieces each pass the floor → stitched', () => {
    // Correction 2 re-pin: the second piece starts a sentence (l.99); the earlier one resumed
    // mid-sentence ("… which remain the responsibility…"), which the skip rule now refuses.
    const quote =
      'The Tenant shall keep the Premises in good and substantial repair and condition… The Tenant shall decorate the inside of the Premises in every fifth year';
    // (a) red when `…` is not a break; (b) prints the state and the part count.
    const c = locateQuote(quote, LEASE);
    expect([c.state, c.parts.length]).toEqual(['stitched', 2]);
  });

  it('a quote whose one part is under the floor → not_found', () => {
    const quote = 'The Tenant shall keep the Premises in good and substantial repair… the Landlord';
    // (a) red when the floor is ignored ("the Landlord" is 12 characters and stands alone); (b)
    //     prints the state.
    expect(locateQuote(quote, LEASE).state).toBe('not_found');
  });

  it("the pieces: `tenant's fixtures` is never split at its apostrophe; `at 9:30 on` is one piece", () => {
    // (a) red when a single quotation mark, or a `:` between two digits, is a break; (b) prints the
    //     piece counts.
    expect([
      segmentsOf("excluding any tenant's fixtures and fittings").length,
      segmentsOf('excluding any tenant’s fixtures and fittings').length,
      segmentsOf('the office opens at 9:30 on weekdays').length,
    ]).toEqual([1, 1, 1]);
  });
});

// ─── correction 2, 01: after a skip, the next part starts where the document starts a sentence, a
//     clause or a line ───────────────────────────────────────────────────────────────────────────

/** A plain word-wrap: each line cut before the word that would pass `width` columns (hard-wrapped
 *  text, as PDF and email text is). */
function wrapAt(text: string, width: number): string {
  return text
    .split('\n')
    .map((line) => {
      const out: string[] = [];
      let current = '';
      for (const word of line.split(' ')) {
        if (current !== '' && `${current} ${word}`.length > width) {
          out.push(current);
          current = word;
        } else current = current === '' ? word : `${current} ${word}`;
      }
      out.push(current);
      return out.join('\n');
    })
    .join('\n');
}

describe('locateQuote — correction 2, 01: a skip lands only where the document starts a sentence, a clause or a line', () => {
  const WRAPPED = wrapAt(LEASE, 72);

  // The 30 stitched attacks (the walk's s6new and s6new2, reader A's two, the audit's wrapped one):
  // each was stitched or stitched_out_of_order before this correction, against the fixture and its
  // 72-column wrap. Fictional quotes against the fictional lease.
  const ATTACKS: Array<[string, string]> = [
    [
      'b_nl_drop_not_71',
      '7.1 Repair. The Tenant shall keep the Premises in good and substantial repair and condition, damage by the Insured Risks excepted. The Tenant shall\nbe responsible for repairs to the structure, roof, foundations or exterior of the Building',
    ],
    [
      'b_semi_drop_not_71',
      'damage by the Insured Risks excepted. The Tenant shall; be responsible for repairs to the structure, roof, foundations or exterior of the Building',
    ],
    [
      'b_colon_drop_not_71',
      'damage by the Insured Risks excepted. The Tenant shall: be responsible for repairs to the structure, roof, foundations or exterior of the Building',
    ],
    [
      'b_dq_drop_not_71',
      'damage by the Insured Risks excepted. The Tenant shall "be responsible for repairs to the structure, roof, foundations or exterior of the Building"',
    ],
    [
      'b_period_drop_not_71',
      'damage by the Insured Risks excepted. The Tenant shall. Be responsible for repairs to the structure, roof, foundations or exterior of the Building',
    ],
    [
      'b_nl_drop_not_75',
      "save that the Tenant may assign the whole of the Premises with the Landlord's consent, such consent\nto be unreasonably withheld.",
    ],
    [
      'b_nl_ins_not_sc',
      'the Tenant shall not\npay the Service Charge on account by quarterly instalments on the quarter days.',
    ],
    [
      'b_nl_ins_not_51',
      'The Tenant shall not\npay the Service Charge in accordance with Schedule 3.',
    ],
    [
      'b_nl_ll_not_resp',
      '6.1 The Landlord shall\nnot be responsible for repairs to the structure, roof, foundations or exterior of the Building',
    ],
    [
      'b_nl_ll_not_resp_oo',
      'Subject to payment of the Service Charge, the Landlord shall\nnot be responsible for repairs to the structure, roof, foundations or exterior of the Building',
    ],
    ['b_nl_assign_any_part', 'the Tenant may assign the whole\nor any part of the Premises'],
    ['b_nl_indemnity_500k', 'a limit of indemnity of not less than\nfive hundred thousand euro'],
    [
      'b_nl_regno_swap',
      'NORTHWIND ANALYTICS LTD, a company incorporated in Ireland\n(registered number FICT-0001)',
    ],
    [
      'b_nl_break_2030',
      'is varied so that the Break Date is\n30 April 2030. The notice period in clause 9.1 is not changed.',
    ],
    [
      'b_nl_rent_48k_sideletter',
      'the initial annual rent shall be\nforty-eight thousand euro (€48,000), exclusive of value added tax',
    ],
    [
      'b_nl_sc_cap_48k',
      'The Service Charge payable in respect of any service charge year shall not exceed\nforty-eight thousand euro (€48,000), exclusive of value added tax',
    ],
    [
      'b_nl_deposit_48k',
      'On the date of this Lease the Tenant shall pay to the Landlord the sum of\nforty-eight thousand euro (€48,000)',
    ],
    ['b_dq_expiry_2030', '"Term Expiry Date" means\n30 April 2030 (the "Break Date")'],
    ['b_colon_expiry_2030', '"Term Expiry Date" means: 30 April 2030 (the "Break Date")'],
    [
      'b_nl_interest_14',
      '"Interest" means interest at the rate of\nfourteen (14) days of its due date',
    ],
    [
      'b_ell_cross',
      'The Landlord shall insure the Building…not be responsible for repairs to the structure, roof, foundations or exterior of the Building',
    ],
    [
      'b_ell_drop_not_71',
      'damage by the Insured Risks excepted. The Tenant shall … be responsible for repairs to the structure, roof, foundations or exterior of the Building',
    ],
    [
      'e_ls_drop_not',
      'damage by the Insured Risks excepted. The Tenant shall\u2028be responsible for repairs to the structure, roof, foundations or exterior of the Building',
    ],
    [
      'e_cr_drop_not',
      'damage by the Insured Risks excepted. The Tenant shall\rbe responsible for repairs to the structure, roof, foundations or exterior of the Building',
    ],
    [
      'e_curly_dq_drop_not',
      'damage by the Insured Risks excepted. The Tenant shall “be responsible for repairs to the structure, roof, foundations or exterior of the Building”',
    ],
    [
      'e_q_mark_drop_not',
      'damage by the Insured Risks excepted. The Tenant shall? Be responsible for repairs to the structure, roof, foundations or exterior of the Building',
    ],
    [
      'e_bang_drop_not',
      'damage by the Insured Risks excepted. The Tenant shall! Be responsible for repairs to the structure, roof, foundations or exterior of the Building',
    ],
    [
      'readerA_61_nl',
      '6.1 The Landlord shall\nnot be responsible for repairs to the structure, roof, foundations or exterior of the Building',
    ],
    [
      'readerA_pinned_nl',
      'The Tenant shall not\npay the Service Charge in accordance with Schedule 3.',
    ],
    [
      'audit_wrap_rent',
      'assessed on the assumptions and disregards set out in this Schedule. The Rent shall\nbe reduced on review.',
    ],
  ];
  for (const [name, quote] of ATTACKS) {
    it(`${name} → not_found, in the fixture and in its 72-column wrap`, () => {
      // (a) red when the rule is taken out of placeParts (each one stitches), and, on the wrapped
      //     copy, when any line break counts as a line start; (b) prints the two states.
      expect([locateQuote(quote, LEASE).state, locateQuote(quote, WRAPPED).state]).toEqual([
        'not_found',
        'not_found',
      ]);
    });
  }

  it("control: l.212's sentence after a year, `…30 April 2031. The notice period…`, stays stitched", () => {
    const c = locateQuote(
      'is varied so that the Break Date is 30 April 2031. The notice period in clause 9.1 is not changed.',
      LEASE,
    );
    // (a) red when step 3 is read greedily (`2031.` taken as a clause number, the start refused);
    //     (b) prints the state and the parts' lines.
    expect({ state: c.state, lines: c.parts.map((p) => lineAt(p.start)) }).toEqual({
      state: 'stitched',
      lines: [212, 212],
    });
  });

  it('control: a skip onto a numbered clause after a blank line (`…against the Tenant.⏎⏎6.2 The Tenant shall pay…`) stays stitched', () => {
    const c = locateQuote(
      "The Landlord shall insure the Building (excluding any tenant's fixtures and fittings) against the Insured Risks for its full reinstatement cost, and shall use reasonable endeavours to procure that the insurer waives its rights of subrogation against the Tenant. The Tenant shall pay to the Landlord on demand, as insurance rent, a fair proportion of the cost of the insurance",
      LEASE,
    );
    // (a) red when a clause number is not skipped; (b) prints the state and the parts' lines.
    expect({ state: c.state, lines: c.parts.map((p) => lineAt(p.start)) }).toEqual({
      state: 'stitched',
      lines: [89, 91],
    });
  });

  it('the cost of rule rev 3: a skip onto a definition line under a heading with no stop is not_found (the safe direction)', () => {
    // Correction 3 re-pin (was a correction-2 control, stitched): the line before ends with no stop
    // and is not blank, so the new line does not count, and an opening mark no longer exempts it.
    const source =
      'The following words have these meanings in this Lease\n"Rent" means the rent specified in clause 3.1.';
    // (a) red when an opening quotation mark on a new line makes it count again (it stitches); (b)
    //     prints the state.
    expect(
      locateQuote(
        'The following words have these meanings … "Rent" means the rent specified in clause 3.1',
        source,
      ).state,
    ).toBe('not_found');
  });

  it('control: `(b) "Rent" means…` after a line break stays stitched', () => {
    const source =
      '1.1 In this Lease the following words have these meanings:\n(a) "Act" means the Landlord and Tenant Act 1980;\n(b) "Rent" means the rent specified in clause 3.1.';
    // (a) red when the spaces after step 2's opening mark are not skipped (`(b)` is then not
    //     reached); (b) prints the state.
    expect(
      locateQuote(
        '1.1 In this Lease the following words have these meanings: … "Rent" means the rent specified in clause 3.1',
        source,
      ).state,
    ).toBe('stitched');
  });

  const RULES =
    'The account manager owns the renewal … Escalate any discount above ten per cent to the director';
  const TABLE =
    'Rent | forty-eight thousand euro … Service Charge | nine thousand two hundred euro';
  const MARKS: Array<[string, string, string, string]> = [
    [
      'a `•` bullet line',
      RULES,
      'The account manager owns the renewal.\n\nRules:\n• Never discount in the first call.\n• Escalate any discount above ten per cent to the director.',
      'The account manager owns the renewal. Rules: never discount in the first call, • Escalate any discount above ten per cent to the director.',
    ],
    [
      'a `-` bullet line',
      RULES,
      'The account manager owns the renewal.\n\nRules:\n- Never discount in the first call.\n- Escalate any discount above ten per cent to the director.',
      'The account manager owns the renewal. Rules: never discount in the first call, - Escalate any discount above ten per cent to the director.',
    ],
    [
      'a `|` table row',
      TABLE,
      '| Rent | forty-eight thousand euro |\n| Service Charge | nine thousand two hundred euro |',
      '| Rent | forty-eight thousand euro |, | Service Charge | nine thousand two hundred euro |',
    ],
  ];
  for (const [name, quote, line, midLine] of MARKS) {
    it(`control: a skip onto ${name} stays stitched; its twin, the same mark mid-line after a comma, is not_found`, () => {
      // (a) red when the list mark is not skipped (the line start is refused), or when a mark
      //     counts mid-line; (b) prints the two states.
      expect([locateQuote(quote, line).state, locateQuote(quote, midLine).state]).toEqual([
        'stitched',
        'not_found',
      ]);
    });
  }

  it('control: a skip landing after `;` in a list stays stitched', () => {
    // (a) red when `;` is not a clause end; (b) prints the state.
    expect(
      locateQuote(
        'The Tenant shall pay the Rent … and insure its fixtures',
        'The Tenant shall pay the Rent; keep the Premises clean; and insure its fixtures.',
      ).state,
    ).toBe('stitched');
  });

  // l.83, after "5.1 " at a line start; l.97, after "7.1 Repair. ".
  const SERVICE = 'The Tenant shall pay the Service Charge in accordance with Schedule 3.';
  const REPAIR =
    'The Tenant shall keep the Premises in good and substantial repair and condition, damage by the Insured Risks excepted.';

  it('control: two whole sentences joined by ` … ` stay stitched (the second follows a full stop)', () => {
    const c = locateQuote(`${SERVICE} … ${REPAIR}`, LEASE);
    // (a) red when `.` is not a sentence end; (b) prints the state and the parts' lines.
    expect({ state: c.state, lines: c.parts.map((p) => lineAt(p.start)) }).toEqual({
      state: 'stitched',
      lines: [83, 97],
    });
  });

  it('control: the same two reversed stay stitched_out_of_order (the second follows a clause number at a line start)', () => {
    const c = locateQuote(`${REPAIR} … ${SERVICE}`, LEASE);
    // (a) red when a clause number is not skipped; (b) prints the state and the parts' lines.
    expect({ state: c.state, lines: c.parts.map((p) => lineAt(p.start)) }).toEqual({
      state: 'stitched_out_of_order',
      lines: [97, 83],
    });
  });

  it('control: a skip onto a sentence that starts a wrapped line stays stitched (the fixture wrapped at 74 columns)', () => {
    // At 74 columns l.199's `(the "Lease").` ends a line and "In consideration…" starts the next;
    // the 72-column copy has no sentence that starts a wrapped line.
    const wrapped = wrapAt(LEASE, 74);
    // (a) red when the line before is not read (a bare line break is then never a line start);
    //     (b) prints the state.
    expect(
      locateQuote(`${SERVICE} … In consideration of the Tenant entering into the Lease`, wrapped)
        .state,
    ).toBe('stitched');
  });

  it('the price of the rule: an honest quote that skips mid-sentence after `...` is not_found', () => {
    // In the `Lettable Area` shape (row d1): l.37's definition, then its tail, which resumes after
    // "2001, ", mid-sentence.
    const c = locateQuote(
      'Permitted Use" means use as offices within the meaning of Class 2 of Part 4 of Schedule 2... together with ancillary meeting and training rooms',
      LEASE,
    );
    // (a) red when the rule is taken out of placeParts (it stitches); (b) prints the state.
    expect(c.state).toBe('not_found');
  });

  it('a known gap: the part BEFORE a skip may end mid-sentence, so a clause joins a later sentence (stitched_out_of_order)', () => {
    // The audit's quote (F760-AUD3-06): "Subject to payment of the Service Charge," ends mid-sentence
    // at l.115, and the next part starts l.89's clause. Not covered by this rule (05, problem 1).
    const c = locateQuote(
      "Subject to payment of the Service Charge,\nThe Landlord shall insure the Building (excluding any tenant's fixtures and fittings) against the Insured Risks",
      LEASE,
    );
    // (a) red when the gap closes, or the clause is no longer found; (b) prints the state and the
    //     parts' lines.
    expect({ state: c.state, lines: c.parts.map((p) => lineAt(p.start)) }).toEqual({
      state: 'stitched_out_of_order',
      lines: [115, 89],
    });
  });

  it('an abbreviation is not a sentence end: a skip landing after `e.g. ` or after an initial (`J. `) is not_found', () => {
    // (a) red when L1's test is dropped from the walk-back (each then stitches); (b) prints the two
    //     states.
    expect([
      locateQuote(
        'the Landlord may charge fees … the Tenant shall not pay the Rent',
        'The Landlord may charge fees, e.g. the Tenant shall not pay the Rent late without interest.',
      ).state,
      locateQuote(
        'Signed for the Landlord by … Smith the Tenant shall pay the Rent',
        'Signed for the Landlord by J. Smith the Tenant shall pay the Rent today.',
      ).state,
    ]).toEqual(['not_found', 'not_found']);
  });
});

// ─── correction 2, 02: the number, sign and hyphen family ────────────────────────────────────────

describe('locateQuote — correction 2, N1: a quote never starts or ends on a number’s separator', () => {
  const CUT: Array<[string, string, string]> = [
    ['`being 18.` in `18.5`', 'of the Building, being 18.', LEASE],
    ['`(€48,` in `€48,000`', 'an initial annual rent of forty-eight thousand euro (€48,', LEASE],
    ['`€48.` in `€48.50`', 'The daily rate is €48.', 'The daily rate is €48.50 per day.'],
    ['`€9,` in `€9,200`', 'a cap of €9,', 'a cap of €9,200 a year'],
  ];
  for (const [name, quote, source] of CUT) {
    it(`${name} → not_found (the quote ends on the separator)`, () => {
      // (a) red when the right edge checks a digit only (the quote reads exact); (b) prints the state.
      expect(locateQuote(quote, source).state).toBe('not_found');
    });
  }

  it('`.5% above` in `4.5% above` → not_found (the quote opens on the separator)', () => {
    // (a) red when the left edge checks a digit only; (b) prints the state.
    expect(locateQuote('.5% above', 'the rate of 4.5% above the base rate').state).toBe(
      'not_found',
    );
  });

  it('controls, still exact: `the rent is 9.` before a space; `items 3,` before a space', () => {
    // (a) red when a separator ending the quote clashes whatever follows it; (b) prints the states.
    expect([
      locateQuote('the rent is 9.', 'the rent is 9. The tenant pays').state,
      locateQuote('items 3,', 'see items 3, 4').state,
    ]).toEqual(['exact', 'exact']);
  });
});

describe('locateQuote — correction 2, N2: a group of thousands is part of its number', () => {
  const SPACES: Array<[string, string]> = [
    ['a space', ' '],
    ['a no-break space', '\u00a0'],
    ['a thin space', '\u2009'],
    ['a narrow no-break space', '\u202f'],
  ];
  for (const [name, g] of SPACES) {
    it(`\`1 200\` in \`1 200 000\`, grouped by ${name} → not_found`, () => {
      // (a) red when the right edge lets a group follow; (b) prints the state.
      expect(locateQuote(`the rent is 1${g}200`, `the rent is 1${g}200${g}000 euro`).state).toBe(
        'not_found',
      );
    });
    it(`\`200 000 euro\` in \`1 200 000 euro\`, grouped by ${name} → not_found`, () => {
      // (a) red when the left edge lets a group come before; (b) prints the state.
      expect(locateQuote(`200${g}000 euro`, `1${g}200${g}000 euro`).state).toBe('not_found');
    });
  }

  it('control: `price 1` in `price 1 20 euro` stays exact (two digits after the space)', () => {
    // (a) red when any digits after a group space count as a group; (b) prints the state.
    expect(locateQuote('price 1', 'price 1 20 euro').state).toBe('exact');
  });
  it('control: `price 1` in `price 1 2000 euro` stays exact (four digits after the space)', () => {
    // (a) red when a fourth digit does not end the group; (b) prints the state.
    expect(locateQuote('price 1', 'price 1 2000 euro').state).toBe('exact');
  });
  it('control: `pipeline in Q1` in `pipeline in Q1 120 deals` stays exact (a letter before the run)', () => {
    // (a) red when a run after a letter counts as a number's first group; (b) prints the state.
    expect(locateQuote('pipeline in Q1', 'pipeline in Q1 120 deals').state).toBe('exact');
  });
  it('control: `500 new accounts` in `In 2024 500 new accounts` stays exact (four digits before)', () => {
    // (a) red when a four-digit run counts as a number's first group; (b) prints the state.
    expect(locateQuote('500 new accounts', 'In 2024 500 new accounts').state).toBe('exact');
  });
});

describe('locateQuote — correction 2, N3: a leading decimal is part of its number', () => {
  const SOURCE = 'a margin of .75% above the base rate';
  it('`75% above the base rate` in `.75%` → not_found (the edge)', () => {
    // (a) red when the left edge lets a `.` after no letter or digit come before (it reads exact);
    //     (b) prints the state.
    expect(locateQuote('75% above the base rate', SOURCE).state).toBe('not_found');
  });
  it('`a margin of 75% above the base rate` against `.75%` → not_found (the canonical form)', () => {
    // (a) red when the canonical form drops the leading `.` (it reads reformatted); (b) prints the
    //     state.
    expect(locateQuote('a margin of 75% above the base rate', SOURCE).state).toBe('not_found');
  });
  it('controls, still exact: `5 for the plan` after `B.`; `9.5` in `9.5`', () => {
    // (a) red when a `.` after a letter counts as a leading decimal; (b) prints the states.
    expect([
      locateQuote('5 for the plan', 'see Appendix B.5 for the plan').state,
      locateQuote('9.5', '9.5').state,
    ]).toEqual(['exact', 'exact']);
  });
});

describe('locateQuote — correction 2, N4: every dash and hyphen reads as `-`', () => {
  // The members, enumerated by running the predicate's own definition over U+0000–U+FFFF: every BMP
  // `\p{Pd}` character, and U+2212, U+2796, U+02D7 (28).
  const MEMBERS: string[] = [];
  for (let u = 0; u <= 0xffff; u++) {
    if (u >= 0xd800 && u <= 0xdfff) continue;
    const c = String.fromCharCode(u);
    if (/^\p{Pd}$/u.test(c) || c === '\u2212' || c === '\u2796' || c === '\u02d7') MEMBERS.push(c);
  }
  // The four the set held before this correction: their cells pass on the old set too.
  const CONTROLS = new Set(['-', '\u2013', '\u2014', '\u2212']);
  const hex = (c: string): string => c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');

  it('the members are 28', () => {
    // (a) red when the enumeration changes (a Unicode update); (b) prints the count.
    expect(MEMBERS.length).toBe(28);
  });
  for (const d of MEMBERS) {
    const title = `${CONTROLS.has(d) ? 'control: ' : ''}U+${hex(d)}: \`5 business days\` in \`3${d}5\` and \`a balance of 5 units\` against \`${d}5\` → not_found`;
    it(title, () => {
      // (a) red when this member is not read as `-` (the shorter number is found, or the sign is
      //     dropped); (b) prints the two states.
      expect([
        locateQuote('5 business days', `within 3${d}5 business days`).state,
        locateQuote('a balance of 5 units', `a balance of ${d}5 units`).state,
      ]).toEqual(['not_found', 'not_found']);
    });
  }

  it('offsets: a source holding all 28, quoted exactly, gives the raw span — and so does a quote after them', () => {
    const quoted = MEMBERS.map((d, i) => `item${i}${d}x`).join(' ');
    // A run of letters ends just before the later quote: an edge copy whose length drifted from the
    // source's (a member mapped to two code units) would read a letter beside its first digit there
    // and refuse the literal match.
    const source = `Before it. ${quoted} ${'x'.repeat(40)} 5 business days.`;
    const all = locateQuote(quoted, source);
    const after = locateQuote('5 business days', source);
    const at = source.indexOf('5 business days');
    // (a) red when a member maps to more or fewer code units (the edges then read the wrong
    //     characters); (b) prints the states and the spans.
    expect({
      all: [all.state, all.parts[0]],
      after: [after.state, after.parts[0]],
    }).toEqual({
      all: ['exact', { start: 11, end: 11 + quoted.length }],
      after: ['exact', { start: at, end: at + '5 business days'.length }],
    });
  });
});

describe('locateQuote — correction 2, N5: number signs, ballot boxes and check marks are kept', () => {
  const PAIRS: Array<[string, string, string]> = [
    ['`5′` against `5″`', 'a ceiling of 5′', 'a ceiling of 5″ clear'],
    ['`5″` against `5′`', 'a ceiling of 5″', 'a ceiling of 5′ clear'],
    ['`☒` against `☐`', '☒ The Tenant may keep pets', '☐ The Tenant may keep pets'],
    ['`☐` against `☒`', '☐ The Tenant may keep pets', '☒ The Tenant may keep pets'],
    ['`✓` against `✗`', '✓ Pets allowed', '✗ Pets allowed'],
    ['`✗` against `✓`', '✗ Pets allowed', '✓ Pets allowed'],
  ];
  for (const [name, quote, source] of PAIRS) {
    it(`${name} → not_found`, () => {
      // (a) red when the sign is set aside (or, for `5′` in `5″`, when NFKC folds `″` into `′′`);
      //     (b) prints the state.
      expect(locateQuote(quote, source).state).toBe('not_found');
    });
  }

  it('controls: `5′` against `5′` is exact; a bullet `■` is still set aside (reformatted)', () => {
    // (a) red when a prime no longer matches itself, or every symbol is kept; (b) prints the states.
    expect([
      locateQuote('a ceiling of 5′', 'a ceiling of 5′ clear').state,
      locateQuote(
        'The Tenant shall pay the Rent and keep the Premises',
        'The Tenant shall pay the Rent ■ and keep the Premises',
      ).state,
    ]).toEqual(['exact', 'reformatted']);
  });
});

describe('locateQuote — correction 2, N6: a quote starts and ends at a word edge, in every layer', () => {
  const MIDWORD: Array<[string, string, string]> = [
    ['`solvent…` inside "insolvent"', 'solvent, the Landlord may re-enter the Premises', LEASE],
    ['`…may not` cut out of "notify"', 'or to such other address as the Landlord may not', LEASE],
    [
      '`lawful use` inside "unlawful use"',
      'lawful use of the Premises',
      'The Tenant shall not permit any unlawful use of the Premises.',
    ],
  ];
  for (const [name, quote, source] of MIDWORD) {
    it(`${name} → not_found`, () => {
      // (a) red when the literal layer's word edges are unchecked (it reads exact), or the canonical
      //     layer's (it reads reformatted); (b) prints the state.
      expect(locateQuote(quote, source).state).toBe('not_found');
    });
  }

  it('`refundable deposit` after `non-` → not_found (a hyphen between two letters is inside a word)', () => {
    // (a) red when the hyphen clause is dropped (it reads exact), or the canonical layer's word edges
    //     are unchecked; (b) prints the state.
    expect(locateQuote('refundable deposit', 'a non-refundable deposit').state).toBe('not_found');
  });

  it('controls, still exact: `deposit` after `non-refundable `; a quote opening at a bracket; `the Tenant` before an em dash', () => {
    // (a) red when an edge that is a word edge is refused (an en or em dash read as a hyphen); (b)
    //     prints the three states.
    expect([
      locateQuote('deposit', 'a non-refundable deposit').state,
      locateQuote('(the "Building")', LEASE).state,
      locateQuote('the Tenant', 'Only the Tenant—not the Landlord—shall pay.').state,
    ]).toEqual(['exact', 'exact', 'exact']);
  });

  it('the occurrence count holds word edges: `the rent` occurs once in `the rent and the rental`', () => {
    // (a) red when the count ignores word edges (2); (b) prints the count.
    expect(locateQuote('the rent', 'the rent and the rental').occurrences).toBe(1);
  });
});

describe('locateQuote — correction 3 (ride-along): N2 and N7 condition by condition', () => {
  it('N2 control: `In 2024` in `In 2024 500 new accounts` stays exact (a four-digit run is no first group)', () => {
    // (a) red when the right edge counts a run of four digits as a number's first group; (b) prints
    //     the state.
    expect(locateQuote('In 2024', 'In 2024 500 new accounts').state).toBe('exact');
  });
  it('N2 control: `120 deals` in `pipeline in Q1 120 deals` stays exact (a run after a letter is no first group)', () => {
    // (a) red when the left edge counts a run after a letter as a number's first group; (b) prints the
    //     state.
    expect(locateQuote('120 deals', 'pipeline in Q1 120 deals').state).toBe('exact');
  });
  it('N2 control: `2000 euro` in `price 1 2000 euro` stays exact (four digits are no group of three)', () => {
    // (a) red when the left edge counts four digits as a group; (b) prints the state.
    expect(locateQuote('2000 euro', 'price 1 2000 euro').state).toBe('exact');
  });
  it('N7: `.` before a lowercase word — `The area is approx.` in `…approx. four hundred…` is cut_short', () => {
    const c = locateQuote('The area is approx.', 'The area is approx. four hundred square metres.');
    // (a) red when only a digit after the mark counts; (b) prints the state, the label and where.
    expect([c.state, c.cut_short, c.cut_short_at]).toEqual(['exact', true, [19]]);
  });
  it('N7: `!` — `Do not enter the loading bay!` before `the lift…` is cut_short', () => {
    const c = locateQuote(
      'Do not enter the loading bay!',
      'Do not enter the loading bay! the lift is closed.',
    );
    // (a) red when `!` is not read as the quote's stop; (b) prints the state, the label and where.
    expect([c.state, c.cut_short, c.cut_short_at]).toEqual(['exact', true, [29]]);
  });
  it('N7: `?` — `Is the rent paid?` before `if not…` is cut_short', () => {
    const c = locateQuote('Is the rent paid?', 'Is the rent paid? if not, interest runs.');
    // (a) red when `?` is not read as the quote's stop; (b) prints the state, the label and where.
    expect([c.state, c.cut_short, c.cut_short_at]).toEqual(['exact', true, [17]]);
  });
});

describe('locateQuote — correction 2, N7: `cut_short` on an exact quote', () => {
  it('`The area is approx.` in `…approx. 412 square metres.` is exact and cut_short after `approx.`', () => {
    const c = locateQuote('The area is approx.', 'The area is approx. 412 square metres.');
    // (a) red when the exact branch never sets the label; (b) prints the state, the label and where.
    expect([c.state, c.cut_short, c.cut_short_at]).toEqual(['exact', true, [19]]);
  });

  it('control: `The Tenant shall pay the Rent.` before a new sentence is exact, not cut_short', () => {
    const c = locateQuote(
      'The Tenant shall pay the Rent.',
      'The Tenant shall pay the Rent. The Landlord shall insure.',
    );
    // (a) red when any exact quote ending in `.` is labelled; (b) prints the state and the label.
    expect([c.state, c.cut_short]).toEqual(['exact', undefined]);
  });
});

// ─── correction 3, 01: the start rule, rev 3 ────────────────────────────────────────────────────

describe('locateQuote — correction 3, 01: the start rule, rev 3 (labels, accepted characters, line starts)', () => {
  const FIRST = 'The Landlord shall insure the Building';
  /** A document whose second sentence follows `join`, and the quote that skips to it. */
  const skipTo = (join: string, second: string): [string, string] => [
    `${FIRST} … ${second}`,
    `${FIRST} for its full reinstatement cost${join}${second} at the end of each year.`,
  ];
  const CAPITAL = 'The Tenant shall pay the insurance rent';
  const LOWER = 'the Tenant shall pay the insurance rent';

  const READS: Array<[string, string, string, QuoteCheck['state']]> = [
    // read 1, no label
    ['read 1: after `. ` onto a capital', '. ', CAPITAL, 'stitched'],
    ['read 1, twin: after `. ` onto a lowercase word', '. ', LOWER, 'not_found'],
    [
      'read 1, twin: after `. ` onto a digit',
      '. ',
      '12 Tenants shall pay the insurance rent',
      'not_found',
    ],
    ['read 1: after `! ` onto a capital', '! ', CAPITAL, 'stitched'],
    ['read 1, twin: after `! ` onto a lowercase word', '! ', LOWER, 'not_found'],
    ['read 1: after `? ` onto a capital', '? ', CAPITAL, 'stitched'],
    ['read 1, twin: after `? ` onto a lowercase word', '? ', LOWER, 'not_found'],
    ['read 1: after `; ` onto a lowercase word', '; ', LOWER, 'stitched'],
    ['read 1: after `: ` onto a lowercase word', ': ', LOWER, 'stitched'],
    ['read 1, twin: after `, `', ', ', LOWER, 'not_found'],
    // read 2, a clause-number label at a line start that counts
    ['read 2: `6.2 ` after a blank line', '.\n\n6.2 ', CAPITAL, 'stitched'],
    ['read 2: `(b) ` after a blank line', '.\n\n(b) ', CAPITAL, 'stitched'],
    ['read 2: `12. ` after a line ending `;`', ';\n12. ', CAPITAL, 'stitched'],
    ['read 2, twin: bare digits `12 ` are no label', '.\n\n12 ', CAPITAL, 'not_found'],
    [
      'read 2, twin: a label before a lowercase word (`4.5 per cent`)',
      '.\n\n4.5 ',
      'per cent is added to the insurance rent',
      'not_found',
    ],
    ['read 2, twin: a label mid-line after a sentence end', '. 6.2 ', CAPITAL, 'not_found'],
    [
      'read 2, twin: a label on a line after a line ending a word',
      ' and\n6.2 ',
      CAPITAL,
      'not_found',
    ],
    // read 3, a list mark at a line start that counts
    [
      'read 3: a `-` line after a line ending `.`, onto a lowercase word',
      '.\n- ',
      LOWER,
      'stitched',
    ],
    ['read 3: a `•` line after a line ending `:`', ':\n• ', CAPITAL, 'stitched'],
    ['read 3, twin: a list mark mid-line after `, `', ', - ', CAPITAL, 'not_found'],
    [
      'read 3, twin: a list mark mid-line after a sentence end (`call. • Escalate`)',
      '. • ',
      CAPITAL,
      'not_found',
    ],
    // a line break, read 1
    ['line break: after a blank line, onto a lowercase word', '\n\n', LOWER, 'stitched'],
    ['line break: after a line ending `.`, onto a capital', '.\n', CAPITAL, 'stitched'],
    ['line break, twin: after a line ending `.`, onto a lowercase word', '.\n', LOWER, 'not_found'],
    ['line break: after a line ending `!`, onto a capital', '!\n', CAPITAL, 'stitched'],
    ['line break: after a line ending `?`, onto a capital', '?\n', CAPITAL, 'stitched'],
    ['line break: after a line ending `;`, onto a lowercase word', ';\n', LOWER, 'stitched'],
    ['line break: after a line ending `:`, onto a lowercase word', ':\n', LOWER, 'stitched'],
    ['line break: after a line ending `|`, onto a lowercase word', ' |\n', LOWER, 'stitched'],
    ['line break, twin: after a line ending a word', ' and\n', CAPITAL, 'not_found'],
    ['line break, twin: after a line ending `,`', ',\n', CAPITAL, 'not_found'],
    [
      'line break: a numbered line quoted with its number (`2. Send…`)',
      '.\n',
      '2. Send the Tenant the insurance rent',
      'stitched',
    ],
  ];
  for (const [name, join, second, state] of READS) {
    it(`${name} → ${state}`, () => {
      const [quote, source] = skipTo(join, second);
      // (a) red when that read, accepted character or line rule changes; (b) prints the state.
      expect(locateQuote(quote, source).state).toBe(state);
    });
  }

  it('read 1: a skip onto the source’s start (out of order) → stitched_out_of_order', () => {
    const source = `${CAPITAL}. ${FIRST} for its full reinstatement cost.`;
    // (a) red when the source's start is not accepted; (b) prints the state.
    expect(locateQuote(`${FIRST} … ${CAPITAL}`, source).state).toBe('stitched_out_of_order');
  });

  const ABBREVIATIONS: Array<[string, string, string, string]> = [
    [
      '`a.m.`',
      'The Tenant and its contractors shall not before 9 a.m. use the loading bay or the goods lift.',
      'The Tenant and its contractors shall\nuse the loading bay or the goods lift.',
      'a.m. ',
    ],
    [
      '`approx.`',
      'The Landlord warrants that the Lettable Area is not less than approx. 412 square metres of floor space.',
      'The Landlord warrants that the Lettable Area is\n412 square metres of floor space.',
      'approx. ',
    ],
    [
      '`p.a.`',
      'Interest is payable at 4% p.a. on all arrears from the due date until payment.',
      'Interest is payable at 4%\non all arrears from the due date until payment.',
      'p.a. ',
    ],
    [
      '`in 2024. the`',
      'The Tenant shall pay the rent in 2024. the Landlord shall not raise it before then.',
      'The Tenant shall pay the rent … the Landlord shall not raise it before then.',
      '2024. ',
    ],
  ];
  for (const [name, doc, quote, abbreviation] of ABBREVIATIONS) {
    it(`after ${name}, a lowercase or digit part is mid-sentence → not_found, on one line and with the line broken after it`, () => {
      const broken = doc.replace(abbreviation, `${abbreviation.trimEnd()}\n`);
      // (a) red when a `.` ends a sentence whatever follows it, or a line break after it counts
      //     whatever follows it; (b) prints the two states.
      expect([locateQuote(quote, doc).state, locateQuote(quote, broken).state]).toEqual([
        'not_found',
        'not_found',
      ]);
    });
  }
});

// ─── correction 3, 02 B: the literal layer reads its edges past invisible characters ────────────

describe('locateQuote — correction 3, 02 B: a word cut at an invisible character or a contraction', () => {
  const unlawful = (mark: string): string =>
    `The Tenant shall not permit any un${mark}lawful use of the Premises.`;
  const CUT: Array<[string, string, string]> = [
    ['a soft hyphen (U+00AD) inside "unlawful"', 'lawful use of the Premises', unlawful('\u00ad')],
    [
      'a zero-width space (U+200B) inside "unlawful"',
      'lawful use of the Premises',
      unlawful('\u200b'),
    ],
    [
      'a zero-width non-joiner (U+200C) inside "unlawful"',
      'lawful use of the Premises',
      unlawful('\u200c'),
    ],
    ['a word joiner (U+2060) inside "unlawful"', 'lawful use of the Premises', unlawful('\u2060')],
    ["`The Tenant can` in `can't`", 'The Tenant can', "The Tenant can't assign this Lease."],
    ['`The Tenant can` in `can’t`', 'The Tenant can', 'The Tenant can’t assign this Lease.'],
    ["`The Landlord won` in `won't`", 'The Landlord won', "The Landlord won't object."],
    ["`The Tenant can` in `can't` at the source’s end", 'The Tenant can', "The Tenant can't"],
    ["`The Tenant can'` in `can't`", "The Tenant can'", "The Tenant can't assign this Lease."],
  ];
  for (const [name, quote, source] of CUT) {
    it(`${name} → not_found`, () => {
      // (a) red when the literal layer reads the invisible character as a word edge, or reads a
      //     contraction as two words; (b) prints the state.
      expect(locateQuote(quote, source).state).toBe('not_found');
    });
  }

  it("controls, still exact: a possessive (`the Tenant` in `the Tenant's`); a zero-width space at a word edge", () => {
    // (a) red when every apostrophe after a word joins it, or every invisible character is read as
    //     inside a word; (b) prints the two states.
    expect([
      locateQuote('the Tenant', "the Tenant's covenants").state,
      locateQuote('the Tenant', 'the Tenant\u200b shall').state,
    ]).toEqual(['exact', 'exact']);
  });
});

// ─── correction 3, 02 C: whitespace at a quote's own ends ───────────────────────────────────────

describe("locateQuote — correction 3, 02 C: the literal layer's edges hold at the quote's first and last non-space characters", () => {
  const SPACES: Array<[string, number]> = [
    ['space', 0x20],
    ['no-break space', 0xa0],
    ['thin space', 0x2009],
    ['narrow no-break space', 0x202f],
  ];
  for (const [name, code] of SPACES) {
    const g = String.fromCharCode(code);
    const source = `the rent is 1${g}200${g}000 euro`;
    it(`\`1 200\` with a trailing ${name}, in a source grouped by it → not_found`, () => {
      // (a) red when the edge is tested at the quote's own trailing space; (b) prints the state.
      expect(locateQuote(`the rent is 1${g}200${g}`, source).state).toBe('not_found');
    });
    it(`\`200 000 euro\` with a leading ${name}, in a source grouped by it → not_found`, () => {
      // (a) red when the edge is tested at the quote's own leading space; (b) prints the state.
      expect(locateQuote(`${g}200${g}000 euro`, source).state).toBe('not_found');
    });
  }

  it('control: `the rent is 1 200 000 ` (a trailing space after a whole number) stays exact', () => {
    // (a) red when a trailing space refuses a quote that ends a whole number; (b) prints the state.
    expect(locateQuote('the rent is 1 200 000 ', 'the rent is 1 200 000 euro').state).toBe('exact');
  });
});

describe('locateQuote — correction 1, L1–L3: abbreviations, a sentence cut short, the trim rule', () => {
  it('L1: an abbreviation or an initial does not end a sentence', () => {
    // (a) red when each is split at its `.`; (b) prints the piece counts.
    expect([
      segmentsOf('the Premises (e.g. the third floor) are let').length,
      segmentsOf('under clause No. 4 of this Lease').length,
      segmentsOf('A. Smith signed the deed').length,
    ]).toEqual([1, 1, 1]);
  });

  it('L2: a quote that ends a sentence where the document goes on is marked cut_short, with where', () => {
    const cut = locateQuote(
      'The Tenant shall keep the Premises in good and substantial repair and condition.',
      LEASE,
    );
    const whole = locateQuote(
      'The Tenant shall keep the Premises in good and substantial repair and condition, damage by the Insured Risks excepted.',
      LEASE,
    );
    // (a) red when the label is missing (the cut quote reads like the whole sentence); (b) prints
    //     the states, the labels and the line of the end.
    expect({
      cut: [cut.state, cut.cut_short, cut.cut_short_at?.map(lineAt)],
      whole: [whole.state, whole.cut_short],
    }).toEqual({ cut: ['reformatted', true, [97]], whole: ['exact', undefined] });
  });

  it('L3: a span takes in the quotation marks and the full stop the quote and the document share at its edges', () => {
    const source = 'Definitions. "Term Commencement Date" means 1 May 2025. Other words.';
    const c = locateQuote('“Term Commencement Date” means 1 May 2025.', source);
    // (a) red under the old uneven trim (the span starts after the opening mark and stops before the
    //     full stop); (b) prints the state and the span.
    expect({ state: c.state, span: source.slice(c.parts[0]!.start, c.parts[0]!.end) }).toEqual({
      state: 'reformatted',
      span: '"Term Commencement Date" means 1 May 2025.',
    });
  });

  it('L3: a stitched part ending `(€48,000` takes in the `)` the quote has there', () => {
    const quote =
      'an initial annual rent of forty-eight thousand euro (€48,000). The Tenant shall pay the Service Charge';
    const c = locateQuote(quote, LEASE);
    // (a) red under the old trim (the part stops at the last digit); (b) prints the state and the
    //     first part's last two characters.
    expect({
      state: c.state,
      tail: LEASE.slice(c.parts[0]!.end - 2, c.parts[0]!.end),
    }).toEqual({ state: 'stitched', tail: '0)' });
  });
});

describe('the lease fixture — correction 1, L6: its names are fictional by the registers', () => {
  it('holds neither "Harbourside" nor the company numbers 990612 and 990698', () => {
    // (a) red on the old file (a live UK company's name; two numbers in the Irish register's
    //     series); (b) prints three booleans.
    expect({
      harbourside: /harbourside/i.test(LEASE),
      first: LEASE.includes('990612'),
      second: LEASE.includes('990698'),
    }).toEqual({ harbourside: false, first: false, second: false });
  });
});
