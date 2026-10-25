// locate-quote-language-0480.test.ts — the language unit before 0.48.0 (#845's part; MA 2's prompt
// `fix-quote-language-0480.md`, the owner's yes of 2026-10-24): `check_quotes` reads marked letters and
// characters outside the Basic Multilingual Plane as written.
//
// - §1: the canonical map holds one entry per UTF-16 code unit, so a kept astral character shifts no
//   offset.
// - §2: a visible mark whose base is a letter stays with it: a quote that leaves it out says another
//   word.
// - §3: a match never splits a letter from its visible mark, and its edges are read by code point,
//   past marks.
// - §4: an Arabic or Hebrew vowel mark a quote leaves out is optional; one it writes must be on the
//   source's letter.
// - The docs: each new sentence quoted, then its examples run.
// - The review's correction (#866 correction 1, C1): `nearest` finds a whole word by code point, past
//   marks, as the word edges do.
//
// What a failing cell prints: states, counts and code points as `U+XXXX`, never a document's text.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalMap, locateQuote } from './locate-quote.js';

const ch = String.fromCodePoint;
const hex = (c: number): string => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
const state = (quote: string, source: string): string => locateQuote(quote, source).state;
/** Every code point in `from`–`to` (surrogates skipped) that `re` matches. */
const codePoints = (re: RegExp, from = 0, to = 0x10ffff): number[] => {
  const out: number[] = [];
  for (let c = from; c <= to; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (re.test(ch(c))) out.push(c);
  }
  return out;
};
/** The rows whose state differs from the one expected, each as `label=state`. */
const misses = (rows: ReadonlyArray<readonly [string, string, string]>): string[] =>
  rows.filter(([, got, want]) => got !== want).map(([label, got]) => `${label}=${got}`);

/** The visible marks (`\p{M}`, not default-ignorable), computed as the running Node reads Unicode
 *  (2,280 on Unicode 17: 1,343 in the BMP, 937 outside it). */
const VISIBLE = codePoints(/^(?!\p{Default_Ignorable_Code_Point})\p{M}$/u);
/** The invisible marks (`\p{M}` and default-ignorable: CGJ, the variation selectors; 263). */
const INVISIBLE = codePoints(/^(?=\p{Default_Ignorable_Code_Point})\p{M}$/u);
const F = 'The Landlord shall insure the Building';

describe('the language unit §1: one map entry per code unit, so offsets hold past an astral character', () => {
  it('an invariant over 5,000 seeded random texts: `from` and `to` as long as the canonical text, every entry a code-point boundary of the original', () => {
    const pool = [
      0x20000, // CJK Extension B, a letter kept
      0x20b9f, // 𠮟
      0x104a0, // Osmanya digit zero, a digit kept
      0x1e2ff, // Wancho ngun sign, a currency sign kept
      0x1f600, // 😀, set aside
      0x1d400, // 𝐀, read as `A`
      0x10d6e, // an astral hyphen
      0x0301, // a combining acute
      0x0e49, // Thai tone mark
      0x1d167, // musical combining tremolo, an astral mark
      0xfe0f, // VS16
      0x200b, // zero-width space (Cf)
      0x00ad, // soft hyphen (Cf)
      0xe0001, // language tag (Cf, astral)
      0x61, // a
      0x41, // A
      0x35, // 5
      0x20, // space
      0x2e, // .
      0x2c, // ,
      0x2d, // -
    ];
    let seed = 845;
    const next = (): number => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    const isBoundary = (text: string, at: number): boolean => {
      const c = text.charCodeAt(at);
      const b = text.charCodeAt(at - 1);
      return !(c >= 0xdc00 && c <= 0xdfff && b >= 0xd800 && b <= 0xdbff);
    };
    let bad = 0;
    let first: number | undefined;
    for (let n = 0; n < 5_000; n++) {
      let text = '';
      const length = 1 + (next() % 24);
      for (let k = 0; k < length; k++) text += ch(pool[next() % pool.length]!);
      const map = canonicalMap(text);
      const holds =
        map.from.length === map.text.length &&
        map.to.length === map.text.length &&
        map.from.every((o, k) => isBoundary(text, o) && isBoundary(text, map.to[k]!));
      if (!holds) {
        bad++;
        first ??= n;
      }
    }
    // (a) red when an emitted character pushes one map entry for both of its code units (an astral
    //     character kept: the map is shorter than the text); (b) prints how many texts fail, and the
    //     first one's number.
    expect({ bad, first }).toEqual({ bad: 0, first: undefined });
  });

  it('`the rent is 48,000 a year` after U+20000 is `reformatted`, its span on the quoted words; an honest stitched quote next to `陳𠮟明` is `stitched`', () => {
    const source = `${ch(0x20000)} The rent is "48,000" a year.`;
    const rent = locateQuote('the rent is 48,000 a year', source);
    const doc = (name: string) =>
      `Landlord: ${name}. ${F} for its full reinstatement cost. The Tenant shall pay the insurance rent at the end of each year.`;
    const hk = locateQuote(
      `${F} … The Tenant shall pay the insurance rent`,
      doc(`陳${ch(0x20b9f)}明`),
    );
    // (a) red when the map holds one entry per code point (the span starts one character late, and the
    //     stitch reads `not_found`); (b) prints the states and whether each span covers its words.
    expect({
      rent: [
        rent.state,
        source.slice(rent.parts[0]?.start, rent.parts[0]?.end) === 'The rent is "48,000" a year',
      ],
      hk: [
        hk.state,
        hk.parts.map((p) => doc(`陳${ch(0x20b9f)}明`).slice(p.start, p.end)).join(' | ') ===
          `${F} | The Tenant shall pay the insurance rent`,
      ],
    }).toEqual({ rent: ['reformatted', true], hk: ['stitched', true] });
  });

  it('a skip landing mid-sentence, with 3 or 4 astral letters before it, is `not_found`; 😀 U+1F600 and 𝐀 U+1D400 before a quote read as before (control)', () => {
    const skip = (n: number) =>
      state(
        `${F} … and the Tenant shall pay the insurance rent`,
        `${ch(0x20000).repeat(n)} ${F} for its full reinstatement cost, and; the Tenant shall pay the insurance rent at the end of each year.`,
      );
    const span = (prefix: number) => {
      const source = `${ch(prefix)} The rent is "48,000" a year.`;
      const c = locateQuote('the rent is 48,000 a year', source);
      return [
        c.state,
        source.slice(c.parts[0]?.start, c.parts[0]?.end) === 'The rent is "48,000" a year',
      ];
    };
    // (a) red, the skip rows: when the map holds one entry per code point (the part's start is read
    //     3 or 4 characters late, after the `;`: `stitched`); the controls: red under no break of
    //     this unit (emoji are set aside, `𝐀` becomes `A`); (b) prints the states.
    expect({ skip3: skip(3), skip4: skip(4), emoji: span(0x1f600), bold: span(0x1d400) }).toEqual({
      skip3: 'not_found',
      skip4: 'not_found',
      emoji: ['reformatted', true],
      bold: ['reformatted', true],
    });
  });
});

describe('the language unit §2: a visible mark stays with its letter', () => {
  it('NEW-7, the minimal pairs: each a different word, each `not_found`', () => {
    const rows: Array<[string, string, string]> = [
      ['Hindi काम / कम', state('काम', 'यह कम है'), 'not_found'],
      ['Hindi दिन / दीन', state('दिन', 'एक दीन आदमी'), 'not_found'],
      ['Hindi मेल / मिल', state('मेल', 'वह मिल गया'), 'not_found'],
      ['Bengali আম বই / আমি বই পড়ি', state('আম বই', 'আমি বই পড়ি'), 'not_found'],
      ['Tamil பால் / பல', state('பால்', 'பல நாள்'), 'not_found'],
      ['Thai ไม่ / ไม้', state('ไม่', 'ไม้'), 'not_found'],
      ['Hindi कताब in …किताब…', state('कताब', 'मेरी किताब है'), 'not_found'],
      [
        'the quote here / the q\u0301uote here',
        state('the quote here', 'the q\u0301uote here'),
        'not_found',
      ],
    ];
    // (a) red when the canonical form drops a mark after a letter (each row reads `reformatted`, today's
    //     defect); (b) prints each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it('honest controls read as before: Hindi, Bengali and Thai exact or with other punctuation, a nukta, ZWJ and ZWNJ, a virama, `é`, Greek tonos, VS16', () => {
    const rows: Array<[string, string, string]> = [
      ['Hindi exact', state('मेरी किताब', 'यह मेरी किताब है।'), 'exact'],
      ['Hindi, another stop', state('यह मेरी किताब है.', 'यह मेरी किताब है।'), 'reformatted'],
      ['Bengali exact', state('আমি বই পড়ি', 'আমি বই পড়ি।'), 'exact'],
      ['Thai exact', state('ไม้ไผ่', 'นี่คือ ไม้ไผ่ ครับ'), 'exact'],
      ['Thai, another punctuation', state('"ไม้ไผ่"', 'นี่คือ «ไม้ไผ่» ครับ'), 'reformatted'],
      ['nukta, precomposed / decomposed', state('\u0958र', 'यह \u0915\u093cर है'), 'reformatted'],
      ['nukta, decomposed / precomposed', state('\u0915\u093cर', 'यह \u0958र है'), 'reformatted'],
      ['ZWJ conjunct / none', state('क्\u200dष', 'यह क्ष है'), 'reformatted'],
      ['ZWNJ / none', state('क्\u200cष', 'यह क्ष है'), 'reformatted'],
      ['a virama', state('विद्या', 'यह विद्या है'), 'exact'],
      [
        'é precomposed / decomposed',
        state('caf\u00e9 latte', 'the cafe\u0301 latte'),
        'reformatted',
      ],
      [
        'é decomposed / precomposed',
        state('cafe\u0301 latte', 'the caf\u00e9 latte'),
        'reformatted',
      ],
      [
        'Greek tonos, precomposed / decomposed',
        state('\u03ac\u03bb\u03bb\u03b1', 'και \u03b1\u0301\u03bb\u03bb\u03b1 εδώ'),
        'reformatted',
      ],
      ['emoji with VS16', state('I ❤\ufe0f it', 'I ❤\ufe0f it a lot'), 'exact'],
      ['❤\ufe0f against ❤', state('I ❤\ufe0f it', 'I ❤ it a lot'), 'reformatted'],
    ];
    // (a) red under no break of this unit's (a control: each reads as it did before it); (b) prints
    //     each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it('Turkish: `İ` and `I` in either case read `reformatted` — the mark lower-casing adds to `İ` (`i` + U+0307) is not kept', () => {
    const rows: Array<[string, string, string]> = [
      ['Istanbul / İstanbul', state('Istanbul', 'İstanbul'), 'reformatted'],
      ['istanbul / İSTANBUL', state('istanbul', 'İSTANBUL'), 'reformatted'],
      ['İzmir / IZMIR', state('İzmir', 'IZMIR'), 'reformatted'],
      [
        'istanbul office / İSTANBUL OFFICE',
        state('istanbul office', 'İSTANBUL OFFICE'),
        'reformatted',
      ],
    ];
    // (a) red when the mark is decided after lower-casing (U+0307 kept: each row `not_found`); (b)
    //     prints each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it('the sweep, every visible mark (BMP and astral) after a letter: a quote missing it is `not_found`; the quote carrying it in another case is `reformatted` (control)', () => {
    const found: string[] = [];
    const notFound: string[] = [];
    for (const m of VISIBLE) {
      const source = `the q${ch(m)}uote here`;
      if (state('the quote here', source) !== 'not_found') found.push(hex(m));
      if (state(`THE Q${ch(m)}UOTE HERE`, source) !== 'reformatted') notFound.push(hex(m));
    }
    // (a) red, `missing`: when marks after a letter are dropped; `carried`: under no break of this
    //     unit (a control); (b) prints the count swept and each mark that reads otherwise.
    expect({ swept: VISIBLE.length > 2_200, missing: found, carried: notFound }).toEqual({
      swept: true,
      missing: [],
      carried: [],
    });
  });

  it('the cost of a run of marks: 30,000 × U+0301 after a Latin letter and 30,000 × U+064E after an Arabic one, each located in under a second', () => {
    const timed = (mark: number, letter: string) => {
      const source = `${letter}${ch(mark).repeat(30_000)} and the rent is due on each quarter day.`;
      const began = performance.now();
      const c = locateQuote('the rent is due on each quarter day', source);
      return [c.state, performance.now() - began < 1_000];
    };
    // (a) red when the base of a mark is found by walking back over the marks before it (seconds:
    //     33 s for 32,000 marks measured, LU-AUD2-03); (b) prints each state and whether it was
    //     under a second.
    expect({ acute: timed(0x0301, 'a'), fatha: timed(0x064e, 'ب') }).toEqual({
      acute: ['exact', true],
      fatha: ['exact', true],
    });
  });
});

describe('the language unit §3: a match never splits a character, and its edges are read by code point, past marks', () => {
  it('a match never starts on a visible mark nor ends right before one (UAX #29 GB9): Thai `ไม` inside `ไม้` is `not_found`; `approved ✔` before ✔+VS16 stays `exact`', () => {
    // (a) red when the grapheme edge is removed (`ไม` reads `exact`); `approved` red under no break of
    //     this unit's (VS16 is no visible mark); (b) prints both states.
    expect([state('ไม', 'ไม้'), state('approved ✔', 'it is approved ✔\ufe0f')]).toEqual([
      'not_found',
      'exact',
    ]);
  });

  it('the read before a match steps past every mark to its base, by code point: a word cut from inside another word is `not_found`', () => {
    const rows: Array<[string, string, string]> = [
      ['ताब मेरी in किताब मेरी', state('ताब मेरी', 'यह किताब मेरी है'), 'not_found'],
      ['paid in un\u0336paid', state('paid', 'the un\u0336paid rent'), 'not_found'],
      [
        'lawful use after un+U+0300',
        state('lawful use', 'any un\u0300lawful use here'),
        'not_found',
      ],
      [
        'Brahmi \u{11022}\u{11038}\u{11029} in \u{11013}\u{1103a}\u{11022}\u{11038}\u{11029}',
        state('\u{11022}\u{11038}\u{11029}', 'x \u{11013}\u{1103a}\u{11022}\u{11038}\u{11029} y'),
        'not_found',
      ],
      [
        '𠀀cd cut from ab𠀀cd',
        state(`${ch(0x20000)}cd here`, `the ab${ch(0x20000)}cd here`),
        'not_found',
      ],
    ];
    // (a) red when the read before a match no longer steps past marks, or reads code units (the
    //     Brahmi and `𠀀` rows), or the needle's first character is read by code unit; (b) prints each
    //     differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it('a quote that starts with an invisible mark, cut from inside a word (`un`, the mark, `lawful use…`), is `not_found` for each of the 263', () => {
    const open = INVISIBLE.filter(
      (m) =>
        state(
          `${ch(m)}lawful use of the Premises`,
          `The Tenant shall not permit any un${ch(m)}lawful use of the Premises.`,
        ) !== 'not_found',
    ).map(hex);
    // (a) red when the needle's first character is not read past its own leading marks (each reads
    //     `exact`); (b) prints the count and each mark that reads otherwise.
    expect({ count: INVISIBLE.length > 250, open }).toEqual({ count: true, open: [] });
  });

  it('the read after a match steps past every mark, the needle’s last character past its own: a quote ending inside a word is `not_found`; `The fee is 1\u0336` in `1\u0336,000` stays `exact` (#845’s R-A2)', () => {
    const rows: Array<[string, string, string]> = [
      [
        'If any Rent is un, U+034F, paid',
        state('If any Rent is un', 'If any Rent is un\u034fpaid it accrues.'),
        'not_found',
      ],
      ['the fee is 3, CGJ, 5', state('the fee is 3', 'the fee is 3\u034f5 a year'), 'not_found'],
      ['Thai ไม้ in ไม้ไผ่', state('ไม้', 'ไม้ไผ่'), 'not_found'],
      [
        'The fee is 1\u0336 in 1\u0336,000',
        state('The fee is 1\u0336', 'The fee is 1\u0336,000 a year'),
        'exact',
      ],
    ];
    // (a) red when the read after a match no longer steps past marks (the first three read `exact`);
    //     the `1\u0336,000` row is the stated limit (`rightNumberEdgeHolds` reads the needle's last
    //     character as before); (b) prints each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it('the sweeps: every visible mark inside a word, a quote ending right before it and one starting on it; a quote ending right before each of the 263 invisible marks', () => {
    const open: Record<string, string[]> = {
      cutAfter: [],
      endsBefore: [],
      endsBeforeAtWordEnd: [],
      startsOn: [],
      invisible: [],
    };
    for (const m of VISIBLE) {
      const word = `the un${ch(m)}lawful use here`;
      if (state('lawful use here', word) !== 'not_found') open.cutAfter!.push(hex(m));
      if (state('the un', word) !== 'not_found') open.endsBefore!.push(hex(m));
      // the mark ends its word: past it the read after finds a space, so only the grapheme edge
      // refuses `the qu`
      if (state('the qu', `the qu${ch(m)} here`) !== 'not_found')
        open.endsBeforeAtWordEnd!.push(hex(m));
      if (state(`${ch(m)}lawful use here`, word) !== 'not_found') open.startsOn!.push(hex(m));
    }
    for (const m of INVISIBLE) {
      if (state('If any Rent is un', `If any Rent is un${ch(m)}paid it accrues.`) !== 'not_found')
        open.invisible!.push(hex(m));
    }
    // (a) red when the grapheme edge is removed (`endsBeforeAtWordEnd`; inside a word, `endsBefore`
    //     and `startsOn` are held twice — by the grapheme edge and by the step past marks to the
    //     letter beside it — so they turn red only with both removed), the read before reads code
    //     units (`cutAfter` holds only the BMP marks), or the read after does not step past marks
    //     (`invisible`); (b) prints each mark that reads otherwise.
    expect(open).toEqual({
      cutAfter: [],
      endsBefore: [],
      endsBeforeAtWordEnd: [],
      startsOn: [],
      invisible: [],
    });
  });

  it('the stated side effects: the invisible-mark cut quotes, `3⫝̸5`, NEW-3’s marked numbers and NEW-2’s astral letters before a digit are `not_found`; a mark-led source and `option 1` before `1\ufe0f\u20e3` are `reformatted`; an exact quote’s count can fall', () => {
    const cut = [0x034f, 0xfe00, 0xfe0f, 0x17b4, 0x180b, 0xe0100].flatMap(
      (m): Array<[string, string, string]> => [
        [
          `${hex(m)} at the start`,
          state('lawful use of the Premises', `any un${ch(m)}lawful use of the Premises.`),
          'not_found',
        ],
        [
          `${hex(m)} at the end`,
          state('If any Rent is un', `If any Rent is un${ch(m)}paid it accrues.`),
          'not_found',
        ],
      ],
    );
    const vowelled = 'كَتَبَ';
    const counts = locateQuote(vowelled, `قال ${vowelled} ثم كُتُب ثم كتب في الدرس`);
    const rows: Array<[string, string, string]> = [
      ...cut,
      // item 10: U+2ADC, which NFKC writes as U+2ADD and a combining U+0338
      ['5 in 3⫝̸5', state('5', 'x 3\u2adc5 y'), 'not_found'],
      ['5 in 3 ⫝̸5', state('5', 'x 3 \u2adc5 y'), 'not_found'],
      ['1\u03362', state('the fee is 1', 'the fee is 1\u03362 euro'), 'not_found'],
      ['€\u03385', state('5 rupees', 'The fee is €\u03385 rupees.'), 'not_found'],
      ['3\u034f5', state('5 euro', 'fee 3\u034f5 euro'), 'not_found'],
      ['€\ufe0f5', state('5 rupees', 'The fee is €\ufe0f5 rupees.'), 'not_found'],
      ['U+104A0 then 5', state('5 rupees', `The fee is ${ch(0x104a0)}5 rupees.`), 'not_found'],
      ['U+1D7CE then 5', state('5 rupees', `The fee is ${ch(0x1d7ce)}5 rupees.`), 'not_found'],
      [
        'a source that starts with a mark',
        state('\u0301The rent is due', '\u0301The rent is due on each quarter day.'),
        'reformatted',
      ],
      [
        'option 1 before 1\ufe0f\u20e3',
        state('option 1', 'take option 1\ufe0f\u20e3 now'),
        'reformatted',
      ],
      ['a vowelled exact quote', counts.state, 'exact'],
      ['its occurrences', String(counts.occurrences), '1'],
    ];
    // (a) red, the `not_found` rows: when a read stops stepping past marks or reads code units; the
    //     `reformatted` rows and the count: when the edges or the count stop holding as stated (a
    //     source opening on a mark is no `exact`; the count keeps the quote's vowels: 3 before);
    //     (b) prints each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it('honest controls read as before: `the Tenant` before VS16 and a space; a whole Thai or Hindi word; an emoji ZWJ family', () => {
    const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
    const rows: Array<[string, string, string]> = [
      ['the Tenant, VS16, a space', state('the Tenant', 'pay the Tenant\ufe0f now'), 'exact'],
      ['a whole Thai word', state('ไม้ไผ่', 'มี ไม้ไผ่ ที่นี่'), 'exact'],
      ['a whole Hindi word', state('किताब', 'यह किताब है'), 'exact'],
      [
        'an emoji ZWJ family',
        state(`the ${family} is here`, `look, the ${family} is here.`),
        'exact',
      ],
    ];
    // (a) red under no break of this unit's (a control); (b) prints each differing row's label and
    //     state.
    expect(misses(rows)).toEqual([]);
  });
});

describe('the language unit §4: an Arabic or Hebrew vowel mark the quote leaves out is optional, one it writes must match', () => {
  /** The optional marks, by property: `\p{M}` with an Arabic or Hebrew script extension (175 on
   *  Unicode 17). The old ranges: U+064B–U+065F, U+0670, and the `\p{M}` of U+0591–U+05C7. */
  const OPTIONAL = codePoints(/^(?=\p{M})[\p{scx=Arabic}\p{scx=Hebrew}]$/u);
  const OLD = (c: number) =>
    (c >= 0x064b && c <= 0x065f) || c === 0x0670 || (c >= 0x0591 && c <= 0x05c7);
  const OUTSIDE = OPTIONAL.filter((c) => !OLD(c));

  it('found: unvowelled and partly vowelled quotes, the Basmala, Quran 2:2, Genesis 1:1, shadda or dagesh only, stitched pieces plain or vowelled', () => {
    const basmala = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ';
    const genesis = 'בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים אֵ֥ת הַשָּׁמַ֖יִם וְאֵ֥ת הָאָֽרֶץ׃';
    // Arabic has no capital letters, so a skip lands after `;` (one after `.` needs a capital)
    const stitchedDoc = `كَتَبَ الطالب الدرس كله في الصباح الباكر ثم نام; ذهب الطالب إلى المدرسة مع أصدقائه.`;
    const rows: Array<[string, string, string]> = [
      [
        'كتب الطالب / كَتَبَ الطالب',
        state('كتب الطالب', 'قال: كَتَبَ الطالب الدرس'),
        'reformatted',
      ],
      ['שלום עולם / שָׁלוֹם עולם', state('שלום עולם', 'אמר שָׁלוֹם עולם לכולם'), 'reformatted'],
      ['the Basmala, unvowelled', state('بسم الله الرحمن الرحيم', basmala), 'reformatted'],
      [
        'Quran 2:2, the wasla kept',
        // the quote keeps the alef wasla `ٱ`, a letter (a plain alef for it is a stated refusal)
        state('ذلك ٱلكتب لا ريب فيه', 'ذَٰلِكَ ٱلۡكِتَٰبُ لَا رَيۡبَۛ فِيهِۛ هُدًى'),
        'reformatted',
      ],
      [
        'Genesis 1:1, unpointed',
        state('בראשית ברא אלהים את השמים ואת הארץ', genesis),
        'reformatted',
      ],
      ['partly vowelled كَتب', state('كَتب الطالب', 'قال: كَتَبَ الطالب الدرس'), 'reformatted'],
      ['shadda only محمّد', state('محمّد رسول', 'مُحَمَّدٌ رَسُولُ اللَّهِ'), 'reformatted'],
      ['dagesh only', state('שבּת שלום', 'שַׁבָּת שָׁלוֹם לכולם'), 'reformatted'],
      [
        'stitched, plain pieces',
        state('كتب الطالب الدرس كله في الصباح الباكر … ذهب الطالب إلى المدرسة', stitchedDoc),
        'stitched',
      ],
      [
        'stitched, one vowelled piece',
        state('كَتَبَ الطالب الدرس كله في الصباح الباكر … ذهب الطالب إلى المدرسة', stitchedDoc),
        'stitched',
      ],
    ];
    // (a) red when the per-letter check reads the rule per quote instead (the partly vowelled and the
    //     shadda-only rows read `not_found`), or when optional marks are not left out (every row
    //     `not_found`); (b) prints each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it('found also: each of the marks outside the old ranges, on an Arabic and on a Hebrew letter; a haraka on tatweel; a vowelled word after 8 × U+20000, its span right', () => {
    const arabic = OUTSIDE.filter(
      (m) => state('كتب الطالب', `قال: ك${ch(m)}تب الطالب الدرس`) !== 'reformatted',
    ).map(hex);
    const hebrew = OUTSIDE.filter(
      (m) => state('שלום עולם', `אמר ש${ch(m)}לום עולם לכולם`) !== 'reformatted',
    ).map(hex);
    const source = `${ch(0x20000).repeat(8)} كَتَبَ الطالب`;
    const astral = locateQuote('كتب الطالب', source);
    // (a) red when the optional set is a range list (`arabic`, `hebrew`: 102 each), the optional test
    //     reads by code point instead of code unit (`astral`: `not_found`), or tatweel is no base;
    //     (b) prints the count outside the ranges, each mark that reads otherwise, and the states.
    expect({
      outside: OUTSIDE.length > 90,
      arabic,
      hebrew,
      tatweel: state('ومما رزقنـهم ينفقون', 'وَمِمَّا رَزَقۡنَـٰهُمۡ يُنفِقُونَ'),
      astral: [
        astral.state,
        source.slice(astral.parts[0]?.start, astral.parts[0]?.end) === 'كَتَبَ الطالب',
      ],
    }).toEqual({
      outside: true,
      arabic: [],
      hebrew: [],
      tatweel: 'reformatted',
      astral: ['reformatted', true],
    });
  });

  it('refused: wrong vowels, a wrong-vowelled repeated piece, a mark that is not optional (the base limit), a vowelled digit; NEW-7 stays strict', () => {
    // two pieces with the same bare text, the second after `;`
    const stitchedDoc = `كَتَبَ الطالب الدرس كله في البيت; كَتَبَ الطالب الدرس كله في المدرسة.`;
    const rows: Array<[string, string, string]> = [
      ['wrong harakat كُتِبَ', state('كُتِبَ الطالب', 'قال: كَتَبَ الطالب الدرس'), 'not_found'],
      ['wrong points שִׁלּוּם', state('שִׁלּוּם עולם', 'אמר שָׁלוֹם עולם לכולם'), 'not_found'],
      [
        'a repeated piece, its second wrong',
        state('كَتَبَ الطالب الدرس كله … كُتِبَ الطالب الدرس كله', stitchedDoc),
        'not_found',
      ],
      [
        'the same, both right (control)',
        state('كَتَبَ الطالب الدرس كله … كَتَبَ الطالب الدرس كله', stitchedDoc),
        'stitched',
      ],
      ['not / n+U+0651+ot', state('not', 'it is n\u0651ot'), 'not_found'],
      ['not / no+U+05B8+t', state('not', 'it is no\u05b8t'), 'not_found'],
      ['Devanagari + U+0652', state('कम', 'यह क\u0652म है'), 'not_found'],
      ['Thai + U+064E', state('ไม', 'นี่ ไ\u064eม ครับ'), 'not_found'],
      ['Syriac + an Arabic fatha', state('ܡܠܟܐ', 'ܗܢܐ ܡ\u064eܠܟܐ ܗܘ'), 'not_found'],
      ['Thaana + U+07A6', state('ދވ', 'މި ދ\u07a6ވ އެވެ'), 'not_found'],
      ['Thaana + a fatha', state('ދވ', 'މި ދ\u064eވ އެވެ'), 'not_found'],
      ['٣٥ / ٣\u064e٥', state('العدد ٣٥', 'العدد ٣\u064e٥'), 'not_found'],
      ['NEW-7 Hindi', state('काम', 'यह कम है'), 'not_found'],
      ['NEW-7 Thai', state('ไม่', 'ไม้'), 'not_found'],
    ];
    // (a) red when the per-letter check is removed (the wrong vowels read found), the base limit is
    //     removed (the Latin, Devanagari, Thai, Syriac and Thaana rows read found), `\p{L}` leaves the
    //     base test (`٣٥` reads `reformatted`), or marks are looked up by a piece's bare text (the
    //     repeated piece reads `stitched`); (b) prints each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });

  it('a stated cost (documented): a mark is optional only in Arabic and Hebrew, so Russian and Ukrainian stress marks and Syriac pointing the quote leaves out read `not_found`', () => {
    const rows: Array<[string, string, string]> = [
      ['Russian замок / за\u0301мок', state('замок', 'это за\u0301мок'), 'not_found'],
      ['Ukrainian мука / му\u0301ка', state('мука', 'це му\u0301ка'), 'not_found'],
      ['Syriac + U+0730', state('ܡܠܟܐ', 'ܗܢܐ ܡ\u0730ܠܟܐ ܗܘ'), 'not_found'],
      ['Syriac + U+0735', state('ܡܠܟܐ', 'ܗܢܐ ܡ\u0735ܠܟܐ ܗܘ'), 'not_found'],
    ];
    // (a) red when marks outside Arabic and Hebrew become optional (the docs' line would then be
    //     false); (b) prints each differing row's label and state.
    expect(misses(rows)).toEqual([]);
  });
});

describe('the language unit: the docs and the CHANGELOG, each new sentence quoted, then run', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const raw = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const flatten = (t: string) => t.replace(/\\\|/g, '|').replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
  const claimOn = (p: string, sentence: string): void => {
    expect(flatten(raw(p)), `${p} no longer says: ${sentence}`).toContain(flatten(sentence));
  };
  const HANDLERS = 'docs/reference/handlers.md';

  it('"What reads not found although it is honest": a visible mark left out outside Arabic and Hebrew; Chinese, Japanese and Thai word for word only', () => {
    claimOn(
      HANDLERS,
      '- A visible mark the quote leaves out makes another word, in every script but Arabic and Hebrew: `замок` is not found in `за́мок` (a stress mark), nor unpointed Syriac in pointed text.',
    );
    claimOn(
      HANDLERS,
      '- In Chinese, Japanese and Thai text, a quote must be a whole run copied character for character, from punctuation to punctuation: part of a run, or a reformatted quote right after `。`, reads `not_found`; word boundaries for these scripts are designed later.',
    );
    // (a) red when a sentence's example reads otherwise; (b) prints the states.
    expect({
      stress: state('замок', 'это за\u0301мок'),
      syriac: state('ܡܠܟܐ', 'ܗܢܐ ܡ\u0730ܠܟܐ ܗܘ'),
      wholeRun: state('他说明天１日回上海', '他说明天１日回上海。'),
      partOfRun: state('明天１日', '他说明天１日回上海。'),
      afterStop: state('他说明天1日回上海', '是的。他说明天１日回上海。'),
    }).toEqual({
      stress: 'not_found',
      syriac: 'not_found',
      wholeRun: 'exact',
      partOfRun: 'not_found',
      afterStop: 'not_found',
    });
  });

  it('the number paragraph’s next one: an unvowelled Arabic word matches every vowelling of it', () => {
    claimOn(
      HANDLERS,
      'An unvowelled Arabic word matches every vowelling of it: `كتب` is found in `كُتُب` ("books") as in `كَتَبَ` ("he wrote").',
    );
    // (a) red when an example reads otherwise; (b) prints both states.
    expect([state('كتب', 'هذه كُتُب جديدة'), state('كتب', 'هو كَتَبَ الدرس')]).toEqual([
      'reformatted',
      'reformatted',
    ]);
  });

  it('the CHANGELOG’s Fixed bullet, each of its three sentences run', () => {
    claimOn(
      'CHANGELOG.md',
      "- A quote that differs from its source by a vowel sign or tone mark (Hindi, Thai and other scripts that write vowels as marks; an Arabic or Hebrew vowel mark the quote leaves out is optional) no longer reads as found; a character outside the Basic Multilingual Plane (for example a CJK Extension-B letter) no longer shifts a found quote's position or makes an honest quote read not found; a word cut from inside another word, after a combining mark, no longer reads found.",
    );
    const shifted = `${ch(0x20000)} The rent is "48,000" a year.`;
    const rent = locateQuote('the rent is 48,000 a year', shifted);
    // (a) red when a sentence's example reads otherwise; (b) prints the states and whether the span
    //     covers its words.
    expect({
      vowelSign: state('काम', 'यह कम है'),
      toneMark: state('ไม่', 'ไม้'),
      optional: state('كتب الطالب', 'قال: كَتَبَ الطالب الدرس'),
      position: [
        rent.state,
        shifted.slice(rent.parts[0]?.start, rent.parts[0]?.end) === 'The rent is "48,000" a year',
      ],
      honest: state(
        `${F} … The Tenant shall pay the insurance rent`,
        `Landlord: 陳${ch(0x20b9f)}明. ${F} for its full reinstatement cost. The Tenant shall pay the insurance rent at the end of each year.`,
      ),
      cutAfterMark: state('paid', 'the un\u0336paid rent'),
    }).toEqual({
      vowelSign: 'not_found',
      toneMark: 'not_found',
      optional: 'reformatted',
      position: ['reformatted', true],
      honest: 'stitched',
      cutAfterMark: 'not_found',
    });
  });
});

describe('the review’s correction: nearest', () => {
  // C1: `nearest` is the longest piece of the quote found in the document, kept only when it covers
  // a whole word of the document — read by code point, past marks (`wordEdgesHold`'s reads), so a
  // mark is part of its letter's word and never its edge.
  const A = '\u0301';
  /** The state and `nearest` as `start–end`, or `none`. */
  const near = (quote: string, source: string): string => {
    const { state: s, nearest: n } = locateQuote(quote, source);
    return `${s} ${n === undefined ? 'none' : `${n.start}–${n.end}`}`;
  };

  it('absent: no whole word in the longest piece — a piece cut from inside a word, past its marks or next to an astral letter, has no `nearest`', () => {
    // (a) red when a row keeps a `nearest`: the word's start read without stepping back past marks
    //     (`мок`, `замок`, `राया`, `ไผ่`, the Thai near miss), a word that stops at a mark (`काम`),
    //     a word read by code unit (`abc qq`), or a control that moves; (b) prints each row's state
    //     and `nearest` as offsets, or `none`.
    expect({
      mok: near('мок', `Это за${A}мок на горе.`),
      zamok: near('замок', `Это за${A}мок на горе.`),
      raya: near('राया', 'मासिक किराया देय है।'),
      kaam: near('काम', 'किराया कम है।'),
      phai: near('ไผ่', 'บ้านไม้ไผ่ หลังนี้'),
      astralAfter: near('abc qq', `the abc${ch(0x20000)} here`),
      // the stated cost (problem 6): a near miss inside one Thai run loses its pointer
      thaiNearMiss: near('บ้านไม้ไผ่หลังนี่', 'บ้านไม้ไผ่หลังนี้ใหญ่'),
      // controls, unchanged: NFKC composes `e` + U+0301 into `é`; only the longest piece is read
      cafe: near('cafe', `the cafe${A} here`),
      longestOnly: near('abcdefgh rent', 'zabcdefghz and the rent'),
    }).toEqual({
      mok: 'not_found none',
      zamok: 'not_found none',
      raya: 'not_found none',
      kaam: 'not_found none',
      phai: 'not_found none',
      astralAfter: 'not_found none',
      thaiNearMiss: 'not_found none',
      cafe: 'not_found none',
      longestOnly: 'not_found none',
    });
  });

  it('present: a whole word, marks and astral letters inside it — `किराया`, `за\u0301мок`, two CJK Extension-B letters; a longest piece may still start or end inside a word (controls)', () => {
    // (a) red when a word holding a mark is never whole (`किराया`, `за\u0301мок новый`), the start test
    //     reads a code unit (the astral word, the one kind C1 adds), or a control moves; (b) prints
    //     each row's state and `nearest` as offsets, or `none`.
    expect({
      kiraya: near('किराया ज़्यादा है', 'मासिक किराया देय है।'),
      zamokNovy: near(`за${A}мок новый`, `Это за${A}мок и старый дом.`),
      astralWord: near(`${ch(0x20000)}${ch(0x20001)} qq`, `the ${ch(0x20000)}${ch(0x20001)} here`),
      // controls, unchanged: Latin; the bare reading of Arabic (C2); a whole word with no mark; a
      // longest piece that ends, or starts, inside a word (C2's words)
      dueIn: near('due in 60 days', 'payment is due in 30 days'),
      arabicBare: near('كُتِبَ', 'كَتَبَ الطالب'),
      zamokStary: near('замок старый', `Это за${A}мок и старый дом.`),
      staryZamok: near('старый замок', `Это старый за${A}мок.`),
      ndlord: near('qqq ndlord shall repair', 'The Landlord shall repair the roof.'),
    }).toEqual({
      kiraya: 'not_found 6–12',
      zamokNovy: 'not_found 4–10',
      astralWord: 'not_found 4–8',
      dueIn: 'not_found 11–17',
      arabicBare: 'not_found 0–6',
      zamokStary: 'not_found 13–19',
      staryZamok: 'not_found 4–14',
      ndlord: 'not_found 6–25',
    });
  });
});
