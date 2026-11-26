/**
 * How a quote was found in its source, rung by rung: `exact`, `reformatted`, `stitched`,
 * `stitched_out_of_order` or `not_found`, and the handler's `unquoted`.
 *
 * locateQuote — whether, and how, a quote appears in a source text (issue #760; design D2, D3, D6;
 * correction 1: the locating rule A1–A9, the stitching rule S, the leftovers L1–L4).
 *
 * The ONE implementation of the quote ladder and of the canonical form; the `check_quotes` handler
 * calls it and composes nothing of its own. It never judges whether a value is correct — only
 * whether, and how, its quote is in the source.
 *
 * The ladder, first hit wins:
 * - `exact`: the quote is a literal substring of the source.
 * - `reformatted`: the quote's canonical form is a substring of the source's canonical form.
 * - `stitched`: the quote breaks — at `…` / `...`, a sentence end, `;`, a `:` not between two digits,
 *   a double quotation mark or a line break — and every piece between its breaks is found whole, at
 *   word and number edges, in the order quoted. Pieces that sit next to each other in the source
 *   count as one part, and every part is at least `minPartChars` canonical characters. Text is
 *   skipped only between parts, never inside a piece (the owner's yes, 2026-10-18).
 * - `stitched_out_of_order`: the same, with the parts in another order.
 * - `not_found`: otherwise; `nearest` is the longest piece of the quote found in the source, when it
 *   covers at least one whole word. A quote placed in order only by joining text across a blank line
 *   inside a sentence carries `cause` and `join_at` instead (#845, Q-C).
 * (`unquoted` is the handler's, for a candidate with no quote and no value; this never returns it.)
 *
 * A quote that ends a sentence where the source's sentence goes on is marked `cut_short` (L2). Every
 * offset is a UTF-16 code-unit offset into the ORIGINAL source.
 * @public
 */

export const QUOTE_STATES = [
  'exact',
  'reformatted',
  'stitched',
  'stitched_out_of_order',
  'not_found',
  'unquoted',
] as const;

/**
 * How a quote was found in its source: whole, reformatted, stitched from parts in order or out of
 * order, or not found; `unquoted` is for a value given with no quote.
 * @public
 */
export type QuoteState = (typeof QUOTE_STATES)[number];

/**
 * A span of the original source: `source.slice(start, end)`.
 * @public
 */
export interface QuoteSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * What `locateQuote` returns for a quote: how it was found, where each part is, how often it
 * occurs, and the nearest piece when it was not found.
 * @public
 */
export interface QuoteCheck {
  readonly state: QuoteState;
  /** Where each part was found: one span for `exact` / `reformatted`, one per part when stitched,
   *  none for `not_found`. */
  readonly parts: readonly QuoteSpan[];
  /** How many times the whole quote occurs (canonically); 0 unless `exact` or `reformatted`. */
  readonly occurrences: number;
  /** For `not_found` only: the longest piece of the quote that IS in the source, when it covers at
   *  least one whole word. */
  readonly nearest?: QuoteSpan;
  /** L2: the quote ends a sentence where the source's sentence goes on. Absent otherwise. */
  readonly cut_short?: true;
  /** L2: the source offset of each such end. Present with `cut_short`. */
  readonly cut_short_at?: readonly number[];
  /** #845 (Q-C): on a `not_found` quote refused only for joining text across a blank line inside a
   *  sentence; each part, quoted on its own, may still be found. Absent otherwise. */
  readonly cause?: 'blank_line_join';
  /** #845 (Q-C): the QUOTE's offsets where each refused join sits: the first code unit after the
   *  break the join replaces (after `…`, usually the space before the next piece), in quote order.
   *  Present with `cause`. */
  readonly join_at?: readonly number[];
}

/** The shortest part a stitch may rest on, in canonical characters (Eve's floor). */
export const DEFAULT_MIN_PART_CHARS = 20;
/** The least `minPartChars` a caller may ask for. */
export const MIN_PART_CHARS_LEAST = 4;
/** A8: the substring searches (`includes`, `indexOf`, `startsWith` alike) one quote may cost. When
 *  they run out, the quote is `not_found`, with the best `nearest` found so far. */
export const QUOTE_SEARCH_BUDGET = 1000;
/** L1: a `.` ending one of these (any case) is never a sentence end; neither is a single capital
 *  letter's (an initial). */
export const NOT_SENTENCE_ENDS = [
  'e.g.',
  'i.e.',
  'etc.',
  'No.',
  'Nos.',
  'cl.',
  'para.',
  'Sch.',
  'Ltd.',
  'Co.',
  'Inc.',
  'St.',
  'Mr.',
  'Mrs.',
  'Ms.',
  'Dr.',
] as const;

/** A8: the longest run of combining marks normalised with its base (UAX #15's stream-safe limit). */
const MAX_MARKS = 30;
/** A8: how many times a tile may be shortened to find it with its edges holding. */
const MAX_TILE_RETREATS = 3;

/** N4, #845 (R-A2): a dash or hyphen, read as `-`: every `\p{Pd}` character, in every plane (the
 *  two outside the BMP are U+10D6E and U+10EAD), the minus sign U+2212, the heavy minus sign U+2796
 *  and the modifier letter minus sign U+02D7. The canonical form writes each as `-`; the literal
 *  layer's dash-mapped copy keeps an astral one as itself (one code unit cannot stand for two), and
 *  its edge reads take it as `-` through this test. Read by code point. */
const DASH = /^\p{Pd}$/u;
const isDash = (c: string | undefined): boolean =>
  c !== undefined && (DASH.test(c) || c === '\u2212' || c === '\u2796' || c === '\u02d7');
/** `%` `‰` `°`; N5: `‱`, the primes `′` `″` `‴` `‵` `‶` `‷` (U+2031–U+2037), the ballot boxes
 *  `☐` `☑` `☒` (U+2610–U+2612), the check and cross marks `✓` `✔` `✕` `✖` `✗` `✘` (U+2713–U+2718),
 *  `✅` `❌` `❎`. Every other `\p{So}` (bullets, emoji) stays set aside. `+` and the comparison signs are
 *  `\p{Sm}`, kept by MATH below. */
const KEPT_SYMBOLS: ReadonlySet<string> = new Set([
  '%',
  '‰',
  '°',
  '\u2031',
  '\u2032',
  '\u2033',
  '\u2034',
  '\u2035',
  '\u2036',
  '\u2037',
  '\u2610',
  '\u2611',
  '\u2612',
  '\u2713',
  '\u2714',
  '\u2715',
  '\u2716',
  '\u2717',
  '\u2718',
  '\u2705',
  '\u274c',
  '\u274e',
]);
/** N5: NFKC folds `″` `‴` `‶` `‷` into repeated primes, so `5′` would sit inside `5″`; like `\p{No}`,
 *  a unit with one of these bases is not NFKC-normalised. */
const UNFOLDED_PRIMES: ReadonlySet<string> = new Set(['\u2033', '\u2034', '\u2036', '\u2037']);
/** N2, #845 (R-B): a space that may group the thousands of one number: U+0020, U+00A0, U+2009 and
 *  U+202F, and every other `\p{Zs}` (U+2007 FIGURE SPACE, U+2008, U+3000 …). */
const GROUP_SPACES: ReadonlySet<string> = new Set([' ', '\u00a0', '\u2009', '\u202f']);
const SPACE_SEPARATOR = /^\p{Zs}$/u;
/** A1, #845 (R-B): the characters that join the digits of one number — `,` `.` `/` `:` and every dash
 *  (`isDash`), and UAX #29's MidNum and MidNumLet between digits: `'` U+0027, `’` U+2019, `‘` U+2018,
 *  `٬` U+066C, `٫` U+066B. Each is read by its NFKC form, so the full-width and small forms
 *  (`．` `，` `․` `﹒` `﹐` `＇`) join too. */
const NUMBER_JOINERS: ReadonlySet<string> = new Set([
  ',',
  '.',
  '/',
  ':',
  "'",
  '\u2019',
  '\u2018',
  '\u066c',
  '\u066b',
]);
/** #845 (R-D3): a spacing accent — a character whose NFKC form is a space and one or more marks
 *  (`´` U+00B4, `¸` U+00B8, `˚` U+02DA, `゛` U+309B …; 50 on Unicode 17), computed at run time.
 *  Between two digits it is kept as itself and joins them; none lies below U+00A8. */
const SPACING_ACCENT_FORM = /^ \p{M}+$/u;
const isSpacingAccent = (c: string | undefined): boolean =>
  c !== undefined && c.charCodeAt(0) >= 0xa8 && SPACING_ACCENT_FORM.test(c.normalize('NFKC'));
const LETTER = /^\p{L}$/u;
const DIGIT = /^\p{Nd}$/u;
const OTHER_NUMBER = /^\p{No}$/u;
/** #845 (R-C1): whitespace is Unicode's White_Space property. JavaScript's `\s` also holds U+FEFF,
 *  which is invisible (`isInvisible`), never a space; and it leaves out U+0085 NEXT LINE. */
const SPACE = /^\p{White_Space}$/u;
const CURRENCY = /^\p{Sc}$/u;
const MATH = /^\p{Sm}$/u;
const MARK = /^\p{M}$/u;
const WORD_CHAR = /[\p{L}\p{Nd}]/u;
/** #845 (R-B): a lowercase letter — Unicode's Lowercase property (UAX #29 SB8's Lower): every
 *  `\p{Ll}`, and `ª`, `º`, small Roman numerals (`ⅳ`) …, in every plane. */
const LOWERCASE = /^\p{Lowercase}$/u;
/** §4: a code point whose script extensions hold Arabic or Hebrew — read by property, never a range
 *  list. */
const ARABIC_OR_HEBREW = /^[\p{scx=Arabic}\p{scx=Hebrew}]$/u;

/** #845 (R-C1): UAX #29's Prepend format characters — the Arabic, Syriac and Kaithi number signs
 *  U+0600–U+0605, U+06DD, U+070F, U+0890, U+0891, U+08E2, U+110BD and U+110CD (the `\p{Cf}`
 *  members of Grapheme_Cluster_Break=Prepend, auxiliary/GraphemeBreakProperty.txt). They are
 *  visible signs that bind the number after them, so they are number symbols, never invisible. One
 *  named list: JavaScript has no Grapheme_Cluster_Break property escape. */
const PREPEND_SIGNS: ReadonlySet<string> = new Set([
  '\u0600',
  '\u0601',
  '\u0602',
  '\u0603',
  '\u0604',
  '\u0605',
  '\u06dd',
  '\u070f',
  '\u0890',
  '\u0891',
  '\u08e2',
  '\u{110bd}',
  '\u{110cd}',
]);
const FORMAT_OR_IGNORABLE = /^[\p{Cf}\p{Default_Ignorable_Code_Point}]$/u;
/** #845 (R-C1): an invisible character — a format character (`\p{Cf}`) or one Unicode marks as
 *  default-ignorable (`\p{Default_Ignorable_Code_Point}`: the soft hyphen, U+200B, U+FEFF, CGJ
 *  U+034F, the variation selectors, the Hangul fillers …), except `PREPEND_SIGNS`. Read by code
 *  point; none lies below U+00AD, so most characters are answered without the regex. */
const isInvisible = (c: string | undefined): boolean =>
  c !== undefined &&
  c.charCodeAt(0) >= 0xad &&
  FORMAT_OR_IGNORABLE.test(c) &&
  !PREPEND_SIGNS.has(c);

const isLetter = (c: string | undefined): boolean => c !== undefined && LETTER.test(c);
/** A mark (`\p{M}`); none lies below U+0300, so most characters are answered without the regex. */
const isMark = (c: string | undefined): boolean =>
  c !== undefined && c.charCodeAt(0) >= 0x300 && MARK.test(c);
/** §2: a visible mark — a `\p{M}` that is not invisible (an accent, a vowel sign, a tone mark; never
 *  CGJ or a variation selector). */
const isVisibleMark = (c: string | undefined): boolean => isMark(c) && !isInvisible(c);
/** §4: an Arabic or Hebrew mark (`\p{M}` with either script extension: 175 code points on Unicode 17),
 *  which a quote may leave out when it sits on an Arabic or Hebrew letter. */
const isOptionalMark = (c: string | undefined): boolean => isMark(c) && ARABIC_OR_HEBREW.test(c!);
/** §4: an Arabic or Hebrew letter (`\p{L}` with either script extension: 1,227 on Unicode 17, tatweel
 *  U+0640 among them), the only base on which a mark is optional. */
const isOptionalBase = (c: string | undefined): boolean => isLetter(c) && ARABIC_OR_HEBREW.test(c!);
/** A digit for numbers and edges: `\p{Nd}`, and superscripts and fractions (`\p{No}`, A1/A4). */
const isNum = (c: string | undefined): boolean =>
  c !== undefined && (DIGIT.test(c) || OTHER_NUMBER.test(c));
const isDigit = (c: string | undefined): boolean => c !== undefined && DIGIT.test(c);
const isAlnum = (c: string | undefined): boolean => isLetter(c) || isNum(c);
const isGroupSpace = (c: string | undefined): boolean =>
  c !== undefined && (GROUP_SPACES.has(c) || SPACE_SEPARATOR.test(c));
const isJoiner = (c: string | undefined): boolean =>
  c !== undefined &&
  (NUMBER_JOINERS.has(c) ||
    isDash(c) ||
    (c.charCodeAt(0) >= 0x80 && (NUMBER_JOINERS.has(c.normalize('NFKC')) || isSpacingAccent(c))));
const isLowercase = (c: string | undefined): boolean => c !== undefined && LOWERCASE.test(c);
/** A1: a symbol that belongs to the number it touches: `%` `‰` `°`, currency, comparison and math
 *  signs (`\p{Sm}`: `<` `>` `≤` `≥` `+` …). */
const isNumberSymbol = (c: string | undefined): boolean =>
  c !== undefined &&
  (KEPT_SYMBOLS.has(c) || CURRENCY.test(c) || MATH.test(c) || PREPEND_SIGNS.has(c));

/** A8: the substring searches left for one quote. */
class Budget {
  left: number;
  constructor(searches: number) {
    this.left = searches;
  }
  spend(): void {
    this.left--;
    if (this.left < 0) throw OUT_OF_BUDGET;
  }
  includes(hay: string, needle: string): boolean {
    this.spend();
    return hay.includes(needle);
  }
  indexOf(hay: string, needle: string, from: number): number {
    this.spend();
    return hay.indexOf(needle, from);
  }
  startsWith(hay: string, needle: string, at: number): boolean {
    this.spend();
    return hay.startsWith(needle, at);
  }
}
const OUT_OF_BUDGET = { outOfBudget: true } as const;

/** A text in canonical form, and for each canonical character the original span it came from. */
interface Canonical {
  readonly text: string;
  readonly from: readonly number[];
  readonly to: readonly number[];
}

/**
 * The canonical form (design D3; correction A3, A4, A8). NFKC (ligatures and full-width digits come
 * from PDFs) — except superscripts and fractions (`\p{No}`), which keep their shape so `9¹` never
 * reads `91` — then lower case (`toLowerCase`, never the locale's), then the dashes `–` `—` `−` as
 * `-`. Letters, digits and the number symbols (`%` `‰` `°`, currency, comparison signs and `+`) are
 * kept; every other punctuation mark, quotation mark and apostrophe is dropped, and whitespace runs
 * become one space after the drops — EXCEPT that digits are load-bearing: (i) a run of separators
 * BETWEEN two digits is kept as itself (`9.1` ≠ `91`, `2,000` ≠ `2.000`, `1.5` ≠ `1 5`); (ii) a `-`
 * directly before a digit is kept (`-5` ≠ `5`). Each base character is normalised with at most 30
 * combining marks that follow it, so every canonical character maps back to one span of the
 * original, and a long run of marks costs no more than its length.
 *
 * The language unit (§2): on the NFKC form and before lower-casing, a visible mark (`isVisibleMark`)
 * whose base — the nearest earlier character that is not a mark — is a letter is kept, with its
 * letter: `काम` is not `कम`, and `q́uote` is not `quote`. The base is carried forward in one pass —
 * the nearest character that is not a mark, asked once, at its first mark, whether it is a letter —
 * so a run of marks costs no more than its length.
 * Every other mark is dropped as before (a default-ignorable one, and one on a digit, a sign or
 * punctuation, unless a digit run keeps it); so is a mark lower-casing adds (`İ` lower-cases to `i` and
 * U+0307). §1: `from`/`to` hold one entry per UTF-16 code unit of `text`, so every canonical offset is
 * a code-unit offset, as the search's offsets are.
 */
function canonicalize(text: string): Canonical {
  const chars: string[] = [];
  /** §2: the character is a visible mark kept with its letter. */
  const kept: boolean[] = [];
  const from: number[] = [];
  const to: number[] = [];
  /** §2: the nearest earlier character that is not a mark, and (asked once, at its first mark)
   *  whether it is a letter. */
  let base: string | undefined;
  let onLetter: boolean | undefined;
  // #845 1a-i correction 1: the decision for the run of spacing accents being read. Every member of
  // one unbroken run (its accents, with invisible characters and marks among them) has the same
  // nearest characters on both sides, so the run is decided once, at its first accent, and the
  // decision holds up to `runEnd`, where the run stops: reading stays linear in the run's length.
  let runEnd = -1;
  let runBefore = false;
  let runAfter = false;
  let i = 0;
  while (i < text.length) {
    const first = cpAt(text, i)!;
    // #845 (R-C1): an invisible character leaves before NFKC, so it never splits a word or a number
    if (isInvisible(first)) {
      i += first.length;
      continue;
    }
    // the marks that follow the base, past invisible characters: `e`+U+034F+U+0301 composes to `é`
    let unit = first;
    let j = i + first.length;
    let marks = 0;
    for (let k = j; k < text.length && marks < MAX_MARKS;) {
      const c = cpAt(text, k)!;
      if (isInvisible(c)) {
        k += c.length;
        continue;
      }
      if (!MARK.test(c)) break;
      unit += c;
      k += c.length;
      j = k;
      marks++;
    }
    // #845 (R-D3): a spacing accent between two digits is kept as itself, a separator (`1´000` is not
    // `1 000`); next to one digit it reads as NFKC's space, as before (`25˚C`); anywhere else it leaves
    // before NFKC, like punctuation (`can´t` reads `cant`). Marks on it have no letter under them.
    if (isSpacingAccent(first)) {
      if (i >= runEnd) {
        runBefore = isNum(cpBefore(text, accentRunEdge(text, i, -1)));
        runEnd = accentRunEdge(text, i + first.length, 1);
        runAfter = isNum(cpAt(text, runEnd));
      }
      const nextToBefore = runBefore;
      const nextToAfter = runAfter;
      if (nextToBefore !== nextToAfter) {
        // next to one digit: the NFKC form below, as before
      } else {
        if (nextToBefore) {
          chars.push(first);
          kept.push(false);
          from.push(i);
          to.push(j);
        }
        base = first;
        onLetter = undefined;
        i = j;
        continue;
      }
    }
    const normal =
      OTHER_NUMBER.test(first) || UNFOLDED_PRIMES.has(first) ? unit : unit.normalize('NFKC');
    for (const c of normal) {
      if (isMark(c)) {
        onLetter ??= isLetter(base);
        // #845 (R-D): a mark whose base is not a letter leaves before the number rules, so no rule
        // ever sees a mark between two digits (`5` is not found in `-́5`)
        if (!(onLetter && isVisibleMark(c))) continue;
        chars.push(c);
        kept.push(true);
        from.push(i);
        to.push(j);
        continue;
      }
      base = c;
      onLetter = undefined;
      // lower-cased one code point at a time: a mark that lower-casing adds leaves (`İ` → `i`)
      for (const ch of c.toLowerCase()) {
        if (isMark(ch)) continue;
        chars.push(isDash(ch) ? '-' : ch);
        kept.push(false);
        from.push(i);
        to.push(j);
      }
    }
    i = j;
  }

  const kind: Array<'keep' | 'space' | 'drop'> = chars.map((c, k) =>
    isAlnum(c) || isNumberSymbol(c) || kept[k] ? 'keep' : SPACE.test(c) ? 'space' : 'drop',
  );
  // (i) a run of non-letter, non-digit characters between two digits is kept as itself.
  for (let k = 0; k < chars.length;) {
    if (!isNum(chars[k])) {
      k++;
      continue;
    }
    let r = k + 1;
    while (r < chars.length && !isLetter(chars[r]) && !isNum(chars[r])) r++;
    if (r > k + 1 && isNum(chars[r])) {
      for (let t = k + 1; t < r; t++) if (kind[t] === 'drop') kind[t] = 'keep';
    }
    k = r;
  }
  // (ii) a `-` directly before a digit is kept.
  for (let k = 0; k + 1 < chars.length; k++) {
    if (chars[k] === '-' && isNum(chars[k + 1])) kind[k] = 'keep';
  }
  // (iii) N3: a `.` or `,` directly before a digit and after a character that is not a letter or
  //     digit (or at the text's start) is kept: a leading decimal, `.75%` ≠ `75%`.
  for (let k = 0; k + 1 < chars.length; k++) {
    if ((chars[k] === '.' || chars[k] === ',') && isNum(chars[k + 1]) && !isAlnum(chars[k - 1])) {
      kind[k] = 'keep';
    }
  }

  // Emit; a whitespace run becomes one space (mapped to its first character), none at either end.
  let out = '';
  const outFrom: number[] = [];
  const outTo: number[] = [];
  let pendingSpace = -1;
  for (let k = 0; k < chars.length; k++) {
    if (kind[k] === 'drop') continue;
    if (kind[k] === 'space') {
      if (pendingSpace < 0) pendingSpace = k;
      continue;
    }
    if (pendingSpace >= 0 && out.length > 0) {
      out += ' ';
      outFrom.push(from[pendingSpace]!);
      outTo.push(to[pendingSpace]!);
    }
    pendingSpace = -1;
    out += chars[k];
    // §1: one entry per code unit of the character (two for one outside the BMP)
    for (let u = 0; u < chars[k]!.length; u++) {
      outFrom.push(from[k]!);
      outTo.push(to[k]!);
    }
  }
  return { text: out, from: outFrom, to: outTo };
}

/** #845 (R-D3): where a run of spacing accents stops on one side, walking from `at` (`dir` -1
 *  backwards, 1 forwards) past invisible characters, marks and other spacing accents: the character
 *  before that offset (backwards) or at it (forwards) is the run's neighbour on that side, and the
 *  text's start or end gives none. Correction 1: asked once per run, at its first accent. */
function accentRunEdge(text: string, at: number, dir: -1 | 1): number {
  let k = at;
  for (;;) {
    const c = dir < 0 ? cpBefore(text, k) : cpAt(text, k);
    if (c === undefined || !(isInvisible(c) || isMark(c) || isSpacingAccent(c))) return k;
    k += dir * c.length;
  }
}

/** The canonical text alone — what two texts are compared as (for this module's tests; not part
 *  of core's exports). */
export function canonicalForm(text: string): string {
  return canonicalize(text).text;
}

/** The canonical text with its map back to the original, one entry per code unit (the language
 *  unit's §1 cells; not part of core's exports). */
export function canonicalMap(text: string): {
  readonly text: string;
  readonly from: readonly number[];
  readonly to: readonly number[];
} {
  return canonicalize(text);
}

// ─── The language unit (§4): an Arabic or Hebrew vowel mark a quote leaves out is optional ─────

/** §4: the optional marks a text carries, per letter — the offset of the letter's first code unit in
 *  its `Bare` text → the marks on it. */
type Marks = ReadonlyMap<number, string>;
const NO_MARKS: Marks = new Map();
const HAS_MARK = /\p{M}/u;

/** §4: a canonical text with its optional marks left out — an Arabic or Hebrew mark
 *  (`isOptionalMark`) whose base is an Arabic or Hebrew letter (`isOptionalBase`) — with its map back
 *  to the original (`from`/`to`, per code unit), the offset in the full canonical text of each of its
 *  code units (`at`, one past the end too), the full text itself, and the marks left out, per letter.
 *  One pass over the code units, the base carried forward, so an astral character before a vowelled
 *  word shifts nothing and a run of marks costs its length. */
interface Bare extends Canonical {
  readonly at: readonly number[];
  readonly full: string;
  readonly marks: Marks;
}
function bareOf(canonical: Canonical): Bare {
  const full = canonical.text;
  // a text with no mark at all has none to leave out
  if (!HAS_MARK.test(full)) {
    return {
      ...canonical,
      at: Array.from({ length: full.length + 1 }, (_, k) => k),
      full,
      marks: NO_MARKS,
    };
  }
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  const at: number[] = [];
  const marks = new Map<number, string>();
  /** The bare offset of the nearest earlier character that is not a mark, when it is an Arabic or
   *  Hebrew letter; -1 otherwise. */
  let base = -1;
  for (let i = 0; i < full.length;) {
    const c = cpAt(full, i)!;
    if (base >= 0 && isOptionalMark(c)) {
      marks.set(base, (marks.get(base) ?? '') + c);
    } else {
      if (!isMark(c)) base = isOptionalBase(c) ? text.length : -1;
      text += c;
      for (let u = 0; u < c.length; u++) {
        from.push(canonical.from[i + u]!);
        to.push(canonical.to[i + u]!);
        at.push(i + u);
      }
    }
    i += c.length;
  }
  at.push(full.length);
  return { text, from, to, at, full, marks };
}

/** §4, per letter: every optional mark `marks` puts on a letter of a match at `at` of `source`'s bare
 *  text is on that letter in the source's full text — which may carry more. */
function marksHold(source: Bare, at: number, marks: Marks): boolean {
  if (marks.size === 0) return true;
  for (const [k, wanted] of marks) {
    const f = source.at[at + k]!;
    let q = f + cpAt(source.full, f)!.length;
    let carried = '';
    for (let c = cpAt(source.full, q); isMark(c); c = cpAt(source.full, q)) {
      carried += c;
      q += c!.length;
    }
    for (const m of wanted) if (!carried.includes(m)) return false;
  }
  return true;
}

// ─── The language unit (§3): neighbours read by code point, past marks ──────────────────────────

/** The code point that ends at `i` (a whole surrogate pair), or `undefined` at the start. */
function cpBefore(s: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const low = s.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = s.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/** The code point that starts at `i`, or `undefined` at the end. */
function cpAt(s: string, i: number): string | undefined {
  if (i >= s.length) return undefined;
  const c = s.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff ? String.fromCodePoint(s.codePointAt(i)!) : s[i];
}

/** From `i` back past every mark (`\p{M}`, visible or not), to just after the base character. */
function pastMarks(s: string, i: number): number {
  let k = i;
  for (let c = cpBefore(s, k); isMark(c); c = cpBefore(s, k)) k -= c!.length;
  return k;
}

/** From `i` forward past every mark (`\p{M}`, visible or not). */
function pastMarksAfter(s: string, i: number): number {
  let k = i;
  for (let c = cpAt(s, k); isMark(c); c = cpAt(s, k)) k += c!.length;
  return k;
}

/** #845 (R-C2): from `i` back past every invisible character (`isInvisible`), as if it were absent. */
function pastInvisibleBefore(s: string, i: number): number {
  let k = i;
  for (let c = cpBefore(s, k); isInvisible(c); c = cpBefore(s, k)) k -= c!.length;
  return k;
}

/** #845 (R-C2): from `i` forward past every invisible character. */
function pastInvisibleAfter(s: string, i: number): number {
  let k = i;
  for (let c = cpAt(s, k); isInvisible(c); c = cpAt(s, k)) k += c!.length;
  return k;
}

/** #845 (R-C2, R-A2): a raw-text walk's step — the code point before `at` (`dir` -1) or from `at`
 *  (`dir` 1), past invisible characters, and the offset past it in that direction (`undefined`, and
 *  the offset reached, at an end). */
interface Step {
  readonly c: string | undefined;
  readonly at: number;
}
function stepBack(s: string, at: number): Step {
  const k = pastInvisibleBefore(s, at);
  const c = cpBefore(s, k);
  return { c, at: c === undefined ? k : k - c.length };
}
function stepOn(s: string, at: number): Step {
  const k = pastInvisibleAfter(s, at);
  const c = cpAt(s, k);
  return { c, at: c === undefined ? k : k + c.length };
}

/** UAX #29 GB9: whether a visible mark stands at `i`, past invisible characters — a span starting
 *  or ending there would split a letter from its mark. */
function visibleMarkAt(s: string, i: number): boolean {
  let k = i;
  for (let c = cpAt(s, k); isInvisible(c); c = cpAt(s, k)) k += c!.length;
  return isVisibleMark(cpAt(s, k));
}

/** The source as the literal layer's edge rule reads it: each dash or hyphen (N4's `isDash`) as
 *  `-`, one code unit for one, so every offset is the source's own (A1, audit finding 4). */
function dashMapped(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += isDash(text[i]) ? '-' : text[i];
  return out;
}

/** 02 B, #845 (R-C1): the source as the literal layer's edges read it — every invisible character
 *  (`isInvisible`) left out, so it never makes a word or number edge; the literal search itself
 *  stays character for character on the raw texts. `raw` keeps the dashes (the word edges'
 *  hyphen test); `mapped` is `dashMapped` of it (the number edges); `at[k]` is the view offset of
 *  source offset `k`. */
interface LiteralView {
  readonly raw: string;
  readonly mapped: string;
  readonly at: readonly number[];
}
function literalView(text: string): LiteralView {
  let raw = '';
  const at: number[] = [];
  for (let i = 0; i < text.length;) {
    const unit = cpAt(text, i)!;
    for (let u = 0; u < unit.length; u++) at.push(raw.length);
    if (!isInvisible(unit)) raw += unit;
    i += unit.length;
  }
  at.push(raw.length);
  return { raw, mapped: dashMapped(raw), at };
}

/** One cached source: a handler checks many quotes against one document (L4: it lets it go). */
let lastSource: string | undefined;
let lastPrepared: Prepared | undefined;
interface Prepared {
  /** §4: the canonical form with its optional marks left out — what the canonical layer searches —
   *  cached beside the full form it reads them from. */
  readonly canonical: Bare;
  readonly view: LiteralView;
}
function prepared(source: string): Prepared {
  if (lastSource !== source || lastPrepared === undefined) {
    lastPrepared = { canonical: bareOf(canonicalize(source)), view: literalView(source) };
    lastSource = source;
  }
  return lastPrepared;
}

/** L4: lets the cached document go (the `check_quotes` handler calls it when it finishes). Not part
 *  of core's exports. */
export function releaseQuoteCache(): void {
  lastSource = undefined;
  lastPrepared = undefined;
}

/** L4: whether a document is cached (for this module's and the handler's tests). */
export function quoteCacheHolds(): boolean {
  return lastSource !== undefined;
}

/**
 * The number edges (design D3; correction A1): at a matched span's edges, a quote's digit never
 * continues a number of the source. A clash when, in the source:
 * - a quote-edge digit has a letter or digit beside it, or a quote-edge letter a digit;
 * - a quote-edge digit has one joiner (`,` `.` `/` `:` `-`) and then a digit beside it;
 * - the quote's first digit has a `-`, a comparison sign, a currency or a number symbol before it,
 *   or its last digit such a symbol after it (the symbol belongs to the number);
 * - a quote that opens with `-` and a digit sits right after a letter or a digit.
 * `hay` is canonical, or the dash-mapped raw source for the literal layer.
 */
function numberEdgesHold(hay: string, at: number, needle: string): boolean {
  return leftNumberEdgeHolds(hay, at, needle) && rightNumberEdgeHolds(hay, at, needle);
}

/** #845 (R-A2): the first `n` characters of `s` from `from`, read by code point, each past the marks
 *  on it (UAX #29 WB4: a mark is part of the character before it). */
function codePoints(s: string, from: number, n: number): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  for (let k = pastMarksAfter(s, from); out.length < n;) {
    const c = cpAt(s, k);
    out.push(c);
    if (c !== undefined) k = pastMarksAfter(s, k + c.length);
  }
  return out;
}

/** #845 (R-A2): how many digits (`\p{Nd}`, by code point) end at `at`, and where they start. */
function digitsBack(s: string, at: number): { n: number; start: number } {
  let k = at;
  let n = 0;
  for (let c = cpBefore(s, k); isDigit(c); c = cpBefore(s, k)) {
    k -= c!.length;
    n++;
  }
  return { n, start: k };
}

function leftNumberEdgeHolds(hay: string, at: number, needle: string): boolean {
  // the language unit (§3, UAX #29 WB4): the characters before read by code point, each past its
  // marks; #845 (R-A2): the needle's own characters by code point too
  const [first, second, third, fourth] = codePoints(needle, 0, 4);
  const p1 = pastMarks(hay, at);
  const b1 = cpBefore(hay, p1);
  const b2 = b1 === undefined ? undefined : cpBefore(hay, pastMarks(hay, p1 - b1.length));
  if (isNum(first)) {
    if (isAlnum(b1)) return false;
    if (isJoiner(b1) && isNum(b2)) return false;
    if (isDash(b1) || isNumberSymbol(b1)) return false;
    // N3: a leading decimal — a `.` or `,` before the digit that follows no letter or digit.
    if ((b1 === '.' || b1 === ',') && !isAlnum(b2)) return false;
  } else if (isLetter(first) && isNum(b1)) return false;
  if (isDash(first) && isNum(second) && isAlnum(b1)) return false;
  // N1: a quote that opens on a number's separator (`.5%` in `4.5%`).
  if (isJoiner(first) && isNum(second) && isNum(b1)) return false;
  // N2: a quote that opens with a group of exactly three digits after one group space and a run of
  //     1–3 digits that follows no letter (`200 000` in `1 200 000`; never `500` in `2024 500`).
  if (
    isDigit(first) &&
    isDigit(second) &&
    isDigit(third) &&
    !isDigit(fourth) &&
    isGroupSpace(b1) &&
    isDigit(b2)
  ) {
    const run = digitsBack(hay, p1 - b1!.length);
    if (run.n <= 3 && !isLetter(cpBefore(hay, run.start))) return false;
  }
  return true;
}

function rightNumberEdgeHolds(hay: string, at: number, needle: string): boolean {
  const end = at + needle.length;
  // the language unit (§3): the characters after read by code point, past marks; #845 (R-A2): the
  // needle's own last characters by code point too
  const lastAt = pastMarks(needle, needle.length);
  const last = cpBefore(needle, lastAt);
  const beforeLast =
    last === undefined ? undefined : cpBefore(needle, pastMarks(needle, lastAt - last.length));
  const q1 = pastMarksAfter(hay, end);
  const a1 = cpAt(hay, q1);
  const a2 = a1 === undefined ? undefined : cpAt(hay, pastMarksAfter(hay, q1 + a1.length));
  if (isNum(last)) {
    if (isAlnum(a1)) return false;
    if (isJoiner(a1) && isNum(a2)) return false;
    if (isNumberSymbol(a1)) return false;
  } else if (isLetter(last) && isNum(a1)) return false;
  // N1: a quote that ends on a number's separator (`18.` in `18.5`).
  if (isJoiner(last) && isNum(beforeLast) && isNum(a1)) return false;
  // N2: a quote whose last digit ends a run of 1–3 digits that follows no letter, where the source
  //     goes on with one group space, exactly three digits and then no digit (`1 200` in
  //     `1 200 000`; never `Q1` in `Q1 120`).
  if (isDigit(last) && isGroupSpace(a1)) {
    const run = digitsBack(hay, end);
    const [d1, d2, d3, d4] = codePoints(hay, q1 + a1!.length, 4);
    if (
      run.n <= 3 &&
      !isLetter(cpBefore(hay, run.start)) &&
      isDigit(d1) &&
      isDigit(d2) &&
      isDigit(d3) &&
      !isDigit(d4)
    ) {
      return false;
    }
  }
  return true;
}

/** N6: the hyphens that join two letters into one word; never an en or em dash (`the Tenant—not`). */
const WORD_HYPHENS: ReadonlySet<string> = new Set(['-', '\u2010', '\u2011', '\ufe63', '\uff0d']);
const isWordHyphen = (c: string | undefined): boolean => c !== undefined && WORD_HYPHENS.has(c);

/** A2, N6: a match starts and ends at a word edge — never with a letter or digit on both sides of the
 *  boundary (`whole o|r`; a "not" cut out of "notify"; `can|t`; `in|solvent`), and never right after
 *  or before a hyphen between two letters (`non-|refundable`). Pieces read the canonical source; the
 *  literal layer reads the raw one. The language unit (§3): a match never starts on a visible mark
 *  nor ends right before one (UAX #29 GB9, past default-ignorable code points: `ไม` is not cut from
 *  `ไม้`); and each side is read by code point, past every mark to its base character (UAX #29 WB4),
 *  the needle's first and last characters past their own marks (`ताब` is not cut from `किताब`). */
function wordEdgesHold(hay: string, at: number, needle: string): boolean {
  const end = at + needle.length;
  if (visibleMarkAt(hay, at) || visibleMarkAt(hay, end)) return false;
  const first = cpAt(needle, pastMarksAfter(needle, 0));
  if (isAlnum(cpBefore(hay, pastMarks(hay, at))) && isAlnum(first)) return false;
  const last = cpBefore(needle, pastMarks(needle, needle.length));
  if (isAlnum(cpAt(hay, pastMarksAfter(hay, end))) && isAlnum(last)) return false;
  // #845 (R-A2): the hyphen reads by code point, each letter past its marks
  const hyphenBefore = cpBefore(hay, at);
  if (
    isLetter(first) &&
    isWordHyphen(hyphenBefore) &&
    isLetter(cpBefore(hay, pastMarks(hay, at - hyphenBefore!.length)))
  ) {
    return false;
  }
  const hyphenAfter = cpAt(hay, end);
  if (
    isLetter(last) &&
    isWordHyphen(hyphenAfter) &&
    isLetter(cpAt(hay, end + hyphenAfter!.length))
  ) {
    return false;
  }
  return contractionEdgesHold(hay, at, needle);
}

/** #845 (R-F): the marks a contraction ending in `'t` or `'nt` is written with — `'` `’` `‘` `` ` ``
 *  `′` `＇`, and the spacing accents R-D3 reads as apostrophes (`isSpacingAccent`), `´` U+00B4 among
 *  them. The canonical form drops every one of them but the prime `′` (U+2032). */
const CONTRACTION_MARKS: ReadonlySet<string> = new Set(["'", '’', '‘', '`', '′', '＇']);
const isContractionMark = (c: string | undefined): boolean =>
  c !== undefined && (CONTRACTION_MARKS.has(c) || isSpacingAccent(c));
const isTee = (c: string | undefined): boolean => c === 't' || c === 'T';

/** #845 (R-F): whether `s` has a contraction's ending at `at` — `t`/`T`, or `n`/`N` then `t`/`T`
 *  (in any case) — with no letter or digit after it. */
function contractionEndingAt(s: string, at: number): boolean {
  const c = cpAt(s, at);
  if (isTee(c)) return !isAlnum(cpAt(s, at + 1));
  return (c === 'n' || c === 'N') && isTee(cpAt(s, at + 1)) && !isAlnum(cpAt(s, at + 2));
}

/** #845 (R-F): a match at `at` cuts no contraction ending in `'t` or `'nt`. Its end is no edge when
 *  its last character is a letter and `hay` goes on with one contraction mark and that ending
 *  (`CAN` in `CAN'T`, `did` in `did'nt`); its start is none when it opens with that ending and
 *  `hay` has one mark right before it and a letter before that (`t make` in `won't make`). A match
 *  that carries the mark is refused too: one that ends with a mark right after a letter, where
 *  `hay` goes on with a letter (`THE TENANT'` in `THE TENANT'S`, `CAN´` in `CAN´T`), and one that
 *  opens with a mark and the ending right after a letter (`´T REFUSE` in `CAN´T REFUSE`).
 *  Possessives (`'S`), other contractions (`you'll`), names (`O'Toole`) and a mark then a letter
 *  (`‘The…`) keep their edge, and so does a space beside the mark (`can' t`). */
function contractionEdgesHold(hay: string, at: number, needle: string): boolean {
  const end = at + needle.length;
  const last = cpBefore(needle, needle.length);
  const after = cpAt(hay, end);
  if (
    isLetter(cpBefore(needle, pastMarks(needle, needle.length))) &&
    isContractionMark(after) &&
    contractionEndingAt(hay, end + after!.length)
  ) {
    return false;
  }
  if (
    isContractionMark(last) &&
    isLetter(cpBefore(needle, pastMarks(needle, needle.length - last!.length))) &&
    isLetter(after)
  ) {
    return false;
  }
  const before = cpBefore(hay, at);
  if (
    contractionEndingAt(needle, 0) &&
    isContractionMark(before) &&
    isLetter(cpBefore(hay, pastMarks(hay, at - before!.length)))
  ) {
    return false;
  }
  const open = cpAt(needle, 0);
  return !(
    isContractionMark(open) &&
    contractionEndingAt(needle, open!.length) &&
    isLetter(cpBefore(hay, pastMarks(hay, at)))
  );
}

/** The first occurrence at or after `fromIndex` whose number edges hold — read from `edgeHay` and
 *  `edgeNeedle` (the dash-mapped source and quote, for the literal layer; the same offsets) — and,
 *  when `words` is set, whose word edges hold in `hay` itself (N6: the literal and canonical layers),
 *  and which `accept` takes (§4: the canonical layer's optional marks, per letter); or -1. */
function findWithEdges(
  budget: Budget,
  hay: string,
  needle: string,
  fromIndex: number,
  edgeHay: string = hay,
  edgeNeedle: string = needle,
  words = false,
  accept: (at: number) => boolean = () => true,
): number {
  if (needle === '') return -1;
  let at = budget.indexOf(hay, needle, fromIndex);
  while (
    at >= 0 &&
    !(
      numberEdgesHold(edgeHay, at, edgeNeedle) &&
      (!words || wordEdgesHold(hay, at, needle)) &&
      accept(at)
    )
  ) {
    at = budget.indexOf(hay, needle, at + 1);
  }
  return at;
}

/** The literal layer's edges (N1–N6, and 02 B): the number and word edges of the match at `at`,
 *  read in the literal view, so past every `\p{Cf}` character (a contraction is one word there too,
 *  #845 R-F: `contractionEdgesHold`); and, read in the source text itself, no edge inside a word a
 *  hyphen breaks across a line (#845 S1/F1: `lineBreakHyphenEdgesHold`). */
function literalEdgesHold(view: LiteralView, source: string, at: number, end: number): boolean {
  const from = view.at[at]!;
  const to = view.at[end]!;
  const needle = view.raw.slice(from, to);
  if (needle === '') return false;
  if (!numberEdgesHold(view.mapped, from, view.mapped.slice(from, to))) return false;
  if (!wordEdgesHold(view.raw, from, needle)) return false;
  return lineBreakHyphenEdgesHold(source, at, end);
}

/** The first literal occurrence of `quote` whose edges hold (`literalEdgesHold`), or -1. 02 C: the
 *  edges are tested at the quote's first and last characters that are not whitespace, so a space
 *  the quote carries at an end cannot stand in for a word or number edge (`1 200 ` in `1 200 000`);
 *  the occurrence returned is the whole quote's. */
function findLiteral(budget: Budget, source: string, quote: string, view: LiteralView): number {
  const lead = quote.length - quote.trimStart().length;
  const trail = quote.length - quote.trimEnd().length;
  if (lead + trail >= quote.length) return -1;
  let at = budget.indexOf(source, quote, 0);
  while (at >= 0 && !literalEdgesHold(view, source, at + lead, at + quote.length - trail)) {
    at = budget.indexOf(source, quote, at + 1);
  }
  return at;
}

/** #845 (S1/F1): where the letter after a word's line-end hyphen at `h` starts, or -1 — a letter
 *  (past its marks), then directly a word hyphen (`isWordHyphen`) or U+00AD at `h`, then, past
 *  blanks and invisible characters, one line break (CR LF as one), then, past blanks and invisible
 *  characters, a letter. Read in the source text itself, where U+00AD is the hyphen. A hyphen after
 *  anything but a letter (`payable -`), or before a blank line, breaks no word. */
function lineBreakHyphenAt(source: string, h: number): number {
  const c = cpAt(source, h);
  if (!(isWordHyphen(c) || c === '­')) return -1;
  if (!isLetter(cpBefore(source, pastMarks(source, h)))) return -1;
  let k = h + c!.length;
  for (let d = cpAt(source, k); isBlank(d) || isInvisible(d); d = cpAt(source, k)) k += d!.length;
  const lineBreak = cpAt(source, k);
  if (!isLineBreak(lineBreak)) return -1;
  k += lineBreak === '\r' && source[k + 1] === '\n' ? 2 : 1;
  for (let d = cpAt(source, k); isBlank(d) || isInvisible(d); d = cpAt(source, k)) k += d!.length;
  return isLetter(cpAt(source, k)) ? k : -1;
}

/** #845 (S1/F1): whether `p` of the source falls inside a word a hyphen breaks across a line, so it
 *  is no word edge: right before the hyphen, right after it, or at the letter after the line break
 *  (`paid` after `un-` ending a line). */
function insideLineBreakHyphen(source: string, p: number): boolean {
  if (lineBreakHyphenAt(source, p) >= 0) return true;
  const before = cpBefore(source, p);
  if (before !== undefined && lineBreakHyphenAt(source, p - before.length) >= 0) return true;
  // back to the hyphen: past blanks and invisible characters (never U+00AD, the hyphen itself), one
  // line break, and blanks and invisible characters again
  let k = p;
  const back = (): void => {
    let d = cpBefore(source, k);
    while (d !== '­' && (isBlank(d) || isInvisible(d))) {
      k -= d!.length;
      d = cpBefore(source, k);
    }
  };
  back();
  const lineBreak = cpBefore(source, k);
  if (!isLineBreak(lineBreak)) return false;
  k -= lineBreak === '\n' && source[k - 2] === '\r' ? 2 : 1;
  back();
  const hyphen = cpBefore(source, k);
  return hyphen !== undefined && lineBreakHyphenAt(source, k - hyphen.length) >= 0;
}

/** #845 (S1/F1): a match from `start` to `end` of the source (raw offsets) starts and ends at a
 *  word edge as far as a line-end hyphen goes: neither end falls inside a word it breaks. */
function lineBreakHyphenEdgesHold(source: string, start: number, end: number): boolean {
  return !insideLineBreakHyphen(source, start) && !insideLineBreakHyphen(source, end);
}

/** Non-overlapping occurrences whose number and word edges hold (N6), whose optional marks hold
 *  (§4: the quote's own), and (#845 S1/F1) neither of whose ends falls inside a word a hyphen breaks
 *  across a line of `raw`, the source text. */
function countWithEdges(
  budget: Budget,
  source: Bare,
  raw: string,
  needle: string,
  marks: Marks,
): number {
  const accept = (at: number): boolean =>
    marksHold(source, at, marks) &&
    lineBreakHyphenEdgesHold(raw, source.from[at]!, source.to[at + needle.length - 1]!);
  const hay = source.text;
  let count = 0;
  for (let at = findWithEdges(budget, hay, needle, 0, hay, needle, true, accept); at >= 0;) {
    count++;
    at = findWithEdges(budget, hay, needle, at + needle.length, hay, needle, true, accept);
  }
  return count;
}

function spanOf(canonical: Canonical, at: number, length: number): QuoteSpan {
  return { start: canonical.from[at]!, end: canonical.to[at + length - 1]! };
}

// ─── Part S: the quote's breaks and its pieces ──────────────────────────────────────────────────

/** One piece of a quote between two breaks (Part S): its raw offsets in the quote, its canonical
 *  text with the map back — its optional marks left out (§4) — the marks it carries (§4: each piece
 *  its own, never looked up by its text), and whether the break after it ends a sentence (L2). */
interface Segment {
  readonly start: number;
  readonly end: number;
  readonly canonical: Canonical;
  readonly marks: Marks;
  readonly endsSentence: boolean;
}

const DOUBLE_QUOTES: ReadonlySet<string> = new Set(['"', '“', '”']);
/** #845 (R-B): a line break — UAX #14's mandatory breaks: LF, CR, VT U+000B, FF U+000C, NEL U+0085,
 *  U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR. */
const LINE_BREAKS: ReadonlySet<string> = new Set([
  '\n',
  '\r',
  '\u000b',
  '\u000c',
  '\u0085',
  '\u2028',
  '\u2029',
]);
const isLineBreak = (c: string | undefined): boolean => c !== undefined && LINE_BREAKS.has(c);
const ABBREVIATIONS: ReadonlySet<string> = new Set(NOT_SENTENCE_ENDS.map((a) => a.toLowerCase()));

/** L1, #845 (R-A3, R-B): the `.` at `at` ends an abbreviation, an initial or an initialism, never a
 *  sentence. The word before it — letters with their marks, and `.` — is read back by code point,
 *  past invisible characters. An initial is, after NFC, one capital (`\p{Lu}` or `\p{Lt}`, any
 *  plane) followed only by visible marks (`Q́.`, `ℝ.`); an initialism is two or more of them, each
 *  followed by `.` (`U.S.`, `J.R.R.`). Lowercase initialisms (`a.m.`) are not.
 *  #845 (item 14): nor is a `.` after a word — back to whitespace — that holds no letter (`\p{L}`,
 *  read past its marks; a spacing accent is no letter here) and no `\p{Nd}` digit (`². Keep`,
 *  `§. Keep`, `ͺ. Keep`, `20 °. The`); `5%.`, `m².`, `2024.` and `(see above).` end one. */
function endsAbbreviation(text: string, at: number): boolean {
  if (!wordHoldsLetterOrDigit(text, at)) return true;
  let s = at;
  for (
    let p = stepBack(text, s);
    isLetter(p.c) || isMark(p.c) || p.c === '.';
    p = stepBack(text, s)
  ) {
    s = p.at;
  }
  let token = '';
  for (let k = s; k < at;) {
    const c = cpAt(text, k)!;
    if (!isInvisible(c)) token += c;
    k += c.length;
  }
  if (token === '') return false;
  if (ABBREVIATIONS.has(`${token}.`.toLowerCase())) return true;
  return token.split('.').every(isInitial);
}

/** #845 (item 14): whether the word before `at` — back to whitespace, read by code point past
 *  invisible characters — holds a letter (a spacing accent is none here) or a `\p{Nd}` digit. */
function wordHoldsLetterOrDigit(text: string, at: number): boolean {
  for (
    let p = stepBack(text, at);
    p.c !== undefined && !SPACE.test(p.c);
    p = stepBack(text, p.at)
  ) {
    if ((isLetter(p.c) && !isSpacingAccent(p.c)) || isDigit(p.c)) return true;
  }
  return false;
}

/** #845 (R-A3): one capital letter with only visible marks on it, after NFC. */
function isInitial(piece: string): boolean {
  const [head, ...rest] = [...piece.normalize('NFC')];
  return isCapital(head) && rest.every(isVisibleMark);
}

/**
 * Part S: the quote's pieces, split at its breaks — `…` or `...`; a sentence end (`.` `!` `?`
 * followed by whitespace or the end of the quote, never an abbreviation or an initial, L1); `;`; a
 * `:` not between two digits; a double quotation mark (`"` `“` `”`; a single mark never breaks); a
 * line break. Pieces with no letter or digit are left out. For this module's tests; not part of
 * core's exports.
 */
export function segmentsOf(quote: string): Array<{ text: string; endsSentence: boolean }> {
  return segmentsWithin(quote).map((s) => ({
    text: quote.slice(s.start, s.end),
    endsSentence: s.endsSentence,
  }));
}

function segmentsWithin(quote: string): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  const close = (end: number, endsSentence: boolean): void => {
    const canonical = bareOf(canonicalize(quote.slice(start, end)));
    if (WORD_CHAR.test(canonical.text)) {
      segments.push({
        start,
        end,
        canonical: {
          text: canonical.text,
          from: canonical.from.map((o) => o + start),
          to: canonical.to.map((o) => o + start),
        },
        marks: canonical.marks,
        endsSentence,
      });
    }
  };
  for (let i = 0; i < quote.length;) {
    const c = quote[i]!;
    if (c === '…' || (c === '.' && quote[i + 1] === '.' && quote[i + 2] === '.')) {
      let j = i + 1;
      while (j < quote.length && (quote[j] === '.' || quote[j] === '…')) j++;
      close(i, false);
      start = i = j;
      continue;
    }
    // #845 (R-C2, R-A2): the neighbours by code point, past invisible characters. Read only at a
    // stop or a `:`, the two breaks that look at them, so a run of invisible characters is crossed
    // once, from the character before it, never from each of its own characters (1a-ii correction 1).
    const stop = c === '.' || c === '!' || c === '?';
    const next = stop || c === ':' ? stepOn(quote, i + 1).c : undefined;
    const sentenceEnd =
      stop &&
      (next === undefined || SPACE.test(next)) &&
      !(c === '.' && endsAbbreviation(quote, i));
    const clauseBreak = c === ';' || (c === ':' && !(isNum(stepBack(quote, i).c) && isNum(next)));
    if (sentenceEnd || clauseBreak || DOUBLE_QUOTES.has(c) || LINE_BREAKS.has(c)) {
      close(i, sentenceEnd);
      start = i = i + 1;
      continue;
    }
    i++;
  }
  close(quote.length, false);
  return segments;
}

/** A piece placed in the canonical source. */
interface Placed {
  readonly at: number;
  readonly length: number;
}

/** A part: pieces that sit next to each other in the source, from `first` to `last` (inclusive). */
interface Part {
  readonly first: number;
  readonly last: number;
  readonly at: number;
  readonly end: number;
  readonly pieces: readonly Placed[];
}

/** Whether a piece fits at `at` of the canonical source: found there, at word and number edges, its
 *  optional marks on the source's letters (§4). */
function fitsAt(budget: Budget, source: Bare, piece: Segment, at: number): boolean {
  const hay = source.text;
  const text = piece.canonical.text;
  return (
    at >= 0 &&
    budget.startsWith(hay, text, at) &&
    wordEdgesHold(hay, at, text) &&
    numberEdgesHold(hay, at, text) &&
    marksHold(source, at, piece.marks)
  );
}

/** From piece `first` placed at `at`, the pieces that follow it right after (at its end, or one
 *  space after it) join it into one part (Part S, rule 3). */
function extend(
  budget: Budget,
  source: Bare,
  segments: readonly Segment[],
  first: number,
  at: number,
): Part {
  const hay = source.text;
  const pieces: Placed[] = [{ at, length: segments[first]!.canonical.text.length }];
  let end = at + segments[first]!.canonical.text.length;
  let last = first;
  for (let k = first + 1; k < segments.length; k++) {
    const piece = segments[k]!;
    const next = hay[end] === ' ' ? end + 1 : end;
    if (!fitsAt(budget, source, piece, next)) break;
    pieces.push({ at: next, length: piece.canonical.text.length });
    end = next + piece.canonical.text.length;
    last = k;
  }
  return { first, last, at, end, pieces };
}

// ─── Correction 2, tightened by correction 3: after a skip, the next part starts where the document
//     starts a sentence, a clause or a line (the owner's yes, 2026-10-18) ─────────────────────────

/** #845 (R-B): an opening mark a part may sit after — an opening bracket or quotation mark
 *  (`\p{Ps}`, `\p{Pi}`), `"` or `'` — except `{`, a template brace, which must never read found. */
const OPENING_PUNCTUATION = /^[\p{Ps}\p{Pi}]$/u;
const isOpeningMark = (c: string | undefined): boolean =>
  c !== undefined && c !== '{' && (c === '"' || c === "'" || OPENING_PUNCTUATION.test(c));
/** #845 (R-B): a closing mark, walked past before an accepted character and in the `cut_short`
 *  reads — a closing bracket or quotation mark (`\p{Pe}`, `\p{Pf}`), `"` or `'`. */
const CLOSING_PUNCTUATION = /^[\p{Pe}\p{Pf}]$/u;
const isClosingMark = (c: string | undefined): boolean =>
  c !== undefined && (c === '"' || c === "'" || CLOSING_PUNCTUATION.test(c));
/** #845 (R-B): read 3's list marks, only at a line start that counts (a run of `#` too, read apart):
 *  every dash (`isDash`: `\p{Pd}`, U+2212, U+2796, U+02D7); `*` `+` `>` `|`; the characters whose
 *  Unicode name holds BULLET (UnicodeData 17.0; U+1F685, an emoji, left out): U+2022, U+2023,
 *  U+2043, U+204C, U+204D, U+2219, U+25D8, U+25E6, U+29BE, U+29BF, U+2619, U+2765, U+2767; the
 *  shapes Word and PDFs use for bullets, `○` U+25CB, `●` U+25CF, `■` U+25A0, `▪` U+25AA, `·` U+00B7;
 *  and U+F0B7, the bullet Word exports from the Symbol font. JavaScript has no character names, so
 *  the bullets are a named list. */
const LIST_MARKS: ReadonlySet<string> = new Set([
  '*',
  '+',
  '>',
  '|',
  '\u2022',
  '\u2023',
  '\u2043',
  '\u204c',
  '\u204d',
  '\u2219',
  '\u25d8',
  '\u25e6',
  '\u29be',
  '\u29bf',
  '\u2619',
  '\u2765',
  '\u2767',
  '\u25cb',
  '\u25cf',
  '\u25a0',
  '\u25aa',
  '\u00b7',
  '\uf0b7',
]);
const isListMark = (c: string | undefined): boolean =>
  c !== undefined && (isDash(c) || LIST_MARKS.has(c));
/** #845 (R-B): a capital letter, `\p{Lu}` or `\p{Lt}`, in every plane (read by code point). */
const CAPITAL = /^[\p{Lu}\p{Lt}]$/u;

/** #845 (R-B): a blank — whitespace (`\p{White_Space}`) other than a line break. */
const isBlank = (c: string | undefined): boolean =>
  c !== undefined && SPACE.test(c) && !LINE_BREAKS.has(c);
const isCapital = (c: string | undefined): boolean => c !== undefined && CAPITAL.test(c);
/** A capital letter or an opening mark: what a sentence may begin with after a full stop. */
const isSentenceOpening = (c: string | undefined): boolean => isCapital(c) || isOpeningMark(c);

/** From `at` back past blanks, and (#845, R-C2) past invisible characters. */
function blanksBack(source: string, at: number): number {
  let i = pastInvisibleBefore(source, at);
  for (let p = stepBack(source, i); isBlank(p.c); p = stepBack(source, i)) {
    i = pastInvisibleBefore(source, p.at);
  }
  return i;
}

/** Read 2: the start of one clause number that ends at `at`, or -1. A clause number is digits joined
 *  by `.` with at least one joiner (`6.2`, `3.4.1`), digits closed by `.` or `)` (`12.`, `12)`), or a
 *  bracketed group of 1–4 letters or digits (`(a)`, `(iv)`). Never bare digits (`12`, `2`). */
function clauseNumberBack(source: string, at: number): number {
  // #845 (R-C2, R-A2): read back by code point, past invisible characters
  const last = stepBack(source, at);
  if (last.c === ')') {
    let n = 0;
    let p = stepBack(source, last.at);
    while (n < 5 && (isLetter(p.c) || isDigit(p.c))) {
      n++;
      p = stepBack(source, p.at);
    }
    if (n >= 1 && n <= 4 && p.c === '(') return p.at;
  }
  let j = at;
  let closed = false;
  if ((last.c === '.' || last.c === ')') && isDigit(stepBack(source, last.at).c)) {
    j = last.at;
    closed = true;
  }
  if (!isDigit(stepBack(source, j).c)) return -1;
  let dotted = false;
  for (;;) {
    for (let p = stepBack(source, j); isDigit(p.c); p = stepBack(source, j)) j = p.at;
    const dot = stepBack(source, j);
    if (dot.c === '.' && isDigit(stepBack(source, dot.at).c)) {
      j = dot.at;
      dotted = true;
      continue;
    }
    return dotted || closed ? j : -1;
  }
}

/** Whether the part at `start` opens with a clause number (dotted, or closed by `.` or `)`; never
 *  bare digits) followed by spaces and a capital letter or an opening mark (`2. Send…`,
 *  `6.2 The Tenant…`, quoted with their number). */
function opensWithClauseNumber(source: string, start: number): boolean {
  // #845 (R-C2, R-A2): read on by code point, past invisible characters
  let j = start;
  if (!isDigit(stepOn(source, j).c)) return false;
  let dotted = false;
  for (;;) {
    for (let p = stepOn(source, j); isDigit(p.c); p = stepOn(source, j)) j = p.at;
    const dot = stepOn(source, j);
    if (dot.c === '.' && isDigit(stepOn(source, dot.at).c)) {
      j = dot.at;
      dotted = true;
      continue;
    }
    break;
  }
  let closed = false;
  const close = stepOn(source, j);
  if (close.c === '.' || close.c === ')') {
    j = close.at;
    closed = true;
  }
  if ((!dotted && !closed) || !isBlank(stepOn(source, j).c)) return false;
  for (let p = stepOn(source, j); isBlank(p.c); p = stepOn(source, j)) j = p.at;
  return isSentenceOpening(stepOn(source, j).c);
}

/** #845 (M8r): whether a blank sits between the list mark (or run of `#`) that starts at `mark` and
 *  `to`, where the part or its opening mark begins — a no-break space is one; an invisible character
 *  alone is not (`-the`, `-`+U+200B+`the` are no list items). */
function blankAfterMark(source: string, mark: number, to: number): boolean {
  let p = stepOn(source, mark);
  if (p.c === '#') while (stepOn(source, p.at).c === '#') p = stepOn(source, p.at);
  for (let q = stepOn(source, p.at); q.c !== undefined && q.at <= to; q = stepOn(source, q.at)) {
    if (isBlank(q.c)) return true;
  }
  return false;
}

/** Read 3: the start of one list mark (or a run of `#`) that ends at `at`, or -1. */
function listMarkBack(source: string, at: number): number {
  // #845 (R-C2, R-A2): read back by code point, past invisible characters
  const mark = stepBack(source, at);
  if (mark.c === '#') {
    let j = mark.at;
    for (let p = stepBack(source, j); p.c === '#'; p = stepBack(source, j)) j = p.at;
    return j;
  }
  return isListMark(mark.c) ? mark.at : -1;
}

/** #845 (1b-i-n): a sign the canonical form keeps (`+`, `>`, `|`, `=`, `£`, `%` …; never a dash,
 *  which it writes as `-` and drops): a piece may start on one, so it begins the first word. */
const isKeptSign = (c: string | undefined): boolean => !isDash(c) && isNumberSymbol(c);

/** #845 (1b-i-n): where the label at `at` ends, or -1. A clause number as read 2 reads one: `(` with
 *  1–4 letters or digits and `)` (`(a)`, `(iv)`), or digits joined by `.` or closed by `.` or `)`
 *  with a blank after them (`6.2`, `12.`, never bare digits); or a list mark with a blank after it
 *  (a run of `#` too; #845, M8r). A list mark that is also a kept sign (`+`, `>`, `|` …) is a label
 *  only when it ends by `start`, where the part begins: the quote skipped it (correction 1). */
function headLabelEnd(source: string, at: number, start: number): number {
  const first = stepOn(source, at);
  if (first.c === '(') {
    let n = 0;
    let p = stepOn(source, first.at);
    while (n < 5 && (isLetter(p.c) || isDigit(p.c))) {
      n++;
      p = stepOn(source, p.at);
    }
    return n >= 1 && n <= 4 && p.c === ')' ? p.at : -1;
  }
  if (isDigit(first.c)) {
    let j = first.at;
    let dotted = false;
    for (;;) {
      for (let p = stepOn(source, j); isDigit(p.c); p = stepOn(source, j)) j = p.at;
      const dot = stepOn(source, j);
      if (dot.c !== '.' || !isDigit(stepOn(source, dot.at).c)) break;
      j = dot.at;
      dotted = true;
    }
    const close = stepOn(source, j);
    const closed = close.c === '.' || close.c === ')';
    if (closed) j = close.at;
    return (dotted || closed) && isBlank(stepOn(source, j).c) ? j : -1;
  }
  if (first.c === '#' || (isListMark(first.c) && (!isKeptSign(first.c) || first.at <= start))) {
    let j = first.at;
    if (first.c === '#')
      for (let p = stepOn(source, j); p.c === '#'; p = stepOn(source, j)) j = p.at;
    return isBlank(stepOn(source, j).c) ? j : -1;
  }
  return -1;
}

/** #845 (1b-i-n): at a `blank` line start, whether the line's first word begins with a capital
 *  letter (`isCapital`, past invisible characters). From `from`, where the line begins, the walk
 *  passes blanks and invisible characters anywhere, opening marks, and at most one label
 *  (`headLabelEnd`). A `(` that opens a clause number is part of it, never an opening mark; a kept
 *  sign (`isKeptSign`) begins the first word, unless it is a list mark the quote skipped (the part
 *  begins at `start`, after it). A second label, or a first word that begins with a lowercase
 *  letter, a digit, a kept sign or an uncased letter, does not hold. */
function blankHeadHolds(source: string, from: number, start: number): boolean {
  let labels = 0;
  let at = from;
  for (;;) {
    const p = stepOn(source, at);
    if (isBlank(p.c)) {
      at = p.at;
      continue;
    }
    const label = headLabelEnd(source, at, start);
    if (label >= 0) {
      labels++;
      at = label;
      continue;
    }
    if (isOpeningMark(p.c)) {
      at = p.at;
      continue;
    }
    return labels <= 1 && isCapital(p.c);
  }
}

/** #845 (1b-i-n): whether the `.` at `dot` closes the first word of a line past its indentation,
 *  that word being a clause number (`2`, `12`, `6.2`) or 1–4 letters (`b`, `IV`), at a `blank` line
 *  start: there it ends a sentence only before a capital letter, past blanks and opening marks. */
function stopsBlankLineWord(source: string, dot: number): boolean {
  let start = dot;
  let letters = 0;
  let digits = false;
  for (let p = stepBack(source, start); ; p = stepBack(source, start)) {
    if (isLetter(p.c)) letters++;
    else if (isDigit(p.c)) digits = true;
    else if (!(p.c === '.' && digits && isDigit(stepBack(source, p.at).c))) break;
    start = p.at;
  }
  if (letters > 0 ? digits || letters > 4 : !digits) return false;
  const before = stepBack(source, blanksBack(source, start));
  return isLineBreak(before.c) && lineStart(source, before.at, true) === 'blank';
}

/** From `at` on, past blanks and opening marks, whether a capital letter follows. */
function capitalPastMarks(source: string, at: number): boolean {
  let p = stepOn(source, at);
  while (isBlank(p.c) || isOpeningMark(p.c)) p = stepOn(source, p.at);
  return isCapital(p.c);
}

/** How a line counts as a line start, by its kind (`lineStart`). */
type LineStart = 'free' | 'sentence' | 'blank';

/** #845 (M6w): whether the line whose `|` sits at `bar` holds another `|` before it — a table
 *  row's end, never a prose line that happens to end with one. */
function holdsAnotherBar(source: string, bar: number): boolean {
  for (let k = bar - 1; k >= 0; k--) {
    const c = source[k]!;
    if (c === '|') return true;
    if (LINE_BREAKS.has(c)) return false;
  }
  return false;
}

/** #845 (Outside-b): whether the `:` at `colon`, ending a line, sits between two digits — the one
 *  before it, and the first character of the next line that is not blank, past blank lines. */
function colonBetweenDigits(source: string, colon: number): boolean {
  if (!isNum(stepBack(source, colon).c)) return false;
  let p = stepOn(source, colon + 1);
  while (isBlank(p.c) || isLineBreak(p.c)) p = stepOn(source, p.at);
  return isNum(p.c);
}

/** How a line ends, read back from `p`, its last character past spaces and invisible characters:
 *  `clause` with `;`, `:` (not between two digits, #845 Outside-b) or `|` (a table row's end: the
 *  line holds another `|`, #845 M6w), `sentence` with `.` `!` `?` under L1's test, `undefined` with
 *  anything else. Closing marks before the end are walked past. */
function lineEnding(source: string, p: Step): 'clause' | 'sentence' | undefined {
  while (isClosingMark(p.c)) p = stepBack(source, p.at);
  const c = p.c;
  if (
    c === ';' ||
    (c === ':' && !colonBetweenDigits(source, p.at)) ||
    (c === '|' && holdsAnotherBar(source, p.at))
  ) {
    return 'clause';
  }
  if ((c === '.' && !endsAbbreviation(source, p.at)) || c === '!' || c === '?') return 'sentence';
  return undefined;
}

/** How the line break at `lineBreak` counts as a line start: `free` when the line before it ends
 *  (past spaces, `\r` and closing marks) with `;`, `:` or `|` (a table row's end); `sentence` when it
 *  ends with `.` `!` `?` under L1's test (read 1's capital condition then applies); `undefined` when it
 *  does not count. What the new line opens with never exempts it.
 *  #845 (B3): when the line before is blank (it holds only blanks and invisible characters), the walk
 *  passes every blank line to the last line holding anything else. After a line that ends a sentence,
 *  a clause or a table row, or at the text's start, the blank line changes nothing (`free`); after a
 *  line that ends none of those, it is `blank`: the line's first word, past opening marks and one
 *  clause number or list mark, begins with a capital letter (#845 1b-i-n, `blankHeadHolds`). With
 *  `strict` false — rule 1 left out, for a held-back candidate (Q-C) — a blank line counts `free`. */
function lineStart(source: string, lineBreak: number, strict: boolean): LineStart | undefined {
  // #845 (R-C2, R-A2): read back by code point, past invisible characters
  let p = stepBack(source, lineBreak);
  while (isBlank(p.c) || p.c === '\r') p = stepBack(source, p.at);
  if (p.c === undefined) return 'free';
  if (isLineBreak(p.c)) {
    if (!strict) return 'free';
    while (isBlank(p.c) || isLineBreak(p.c)) p = stepBack(source, p.at);
    return p.c === undefined || lineEnding(source, p) !== undefined ? 'free' : 'blank';
  }
  const ending = lineEnding(source, p);
  return ending === 'clause' ? 'free' : ending;
}

/** Reads 2 and 3: past blanks, how `at` sits at the source's start (`free`) or at a line start that
 *  counts (its kind); `undefined` when it does not. */
function countedLineStart(source: string, at: number, strict: boolean): LineStart | undefined {
  const p = stepBack(source, blanksBack(source, at));
  if (p.c === undefined) return 'free';
  return isLineBreak(p.c) ? lineStart(source, p.at, strict) : undefined;
}

/** Read 1's accepted character before `at`, past spaces, tabs and closing marks: the source's start;
 *  `;`; a `:` not between two digits; a line break that counts; a `.` `!` `?` that ends a sentence
 *  (L1's test for `.`) only when `opening` (the part, or its opening mark, begins with a capital
 *  letter or an opening mark). At a line break that counts only because the line before ends a
 *  sentence, the same capital condition holds, or `numbered` (the part opens with a clause number
 *  and a capital). After a blank line under a line that ends nothing (#845, B3), the line's first
 *  word decides (#845 1b-i-n, `blankHeadHolds`, the part beginning at `start`); there the `.` that
 *  closes a short first word ends a sentence only before a capital letter (`stopsBlankLineWord`). */
function acceptedBefore(
  source: string,
  at: number,
  opening: boolean,
  numbered: boolean,
  strict: boolean,
  start: number,
): boolean {
  // #845 (R-C2, R-A2): read back by code point, past invisible characters
  let p = stepBack(source, blanksBack(source, at));
  while (isClosingMark(p.c)) p = stepBack(source, p.at);
  const c = p.c;
  if (c === undefined) return true;
  if (isLineBreak(c)) {
    const kind = lineStart(source, p.at, strict);
    // #845 (1b-i-n): after a blank line inside a sentence, the line's first word decides
    if (kind === 'blank') return blankHeadHolds(source, p.at + c.length, start);
    return kind === 'free' || (kind !== undefined && (opening || numbered));
  }
  if (c === ';') return true;
  if (c === ':') {
    return !(isNum(stepBack(source, p.at).c) && isNum(stepOn(source, p.at + c.length).c));
  }
  if (c === '.') {
    return (
      opening &&
      !endsAbbreviation(source, p.at) &&
      // #845 (1b-i-n, rule 3): the `.` of a blank line's short first word, only before a capital
      (!strict || !stopsBlankLineWord(source, p.at) || capitalPastMarks(source, p.at + c.length))
    );
  }
  if (c === '!' || c === '?') return opening;
  return false;
}

/**
 * Correction 3 (01, rule rev 3): whether a part placed at raw offset `start` starts where the
 * document starts a sentence, a clause or a line — read in the RAW source (the canonical form drops
 * `.` `;` `:` and turns line breaks into spaces). From the part's start, walk back over spaces and
 * tabs; the start holds if ANY read holds:
 * 1. No label: past an optional opening mark and its spaces, then closing marks, an accepted
 *    character (`acceptedBefore`).
 * 2. A clause-number label (never bare digits) right before the part, or before its opening mark and
 *    spaces, sitting at a line start that counts — and the part, or its opening mark, begins with a
 *    capital letter or an opening mark (never `4.5 per cent`).
 * 3. A list mark, then spaces — at least one blank (#845, M8r) — then an optional opening mark and
 *    spaces, right before the part, sitting at a line start that counts.
 * After a blank line under a line that ends nothing (#845, B3), every read holds only when the line's
 * first word, past opening marks and one label, begins with a capital letter (#845 1b-i-n).
 * `strict` false leaves rule 1 (B3) out: the test of a held-back candidate (Q-C).
 */
function partStartHolds(source: string, start: number, strict: boolean): boolean {
  // #845 (R-C2, R-A2): every read by code point, past invisible characters
  const first = blanksBack(source, start);
  const own = stepOn(source, start).c;
  const opening = isSentenceOpening(own);
  const numbered = opensWithClauseNumber(source, start);
  // Where the part's own opening mark (and the spaces before it) ends, when it has one.
  const openingMark = stepBack(source, first);
  const beforeMark = isOpeningMark(openingMark.c) ? blanksBack(source, openingMark.at) : -1;
  // Read 1.
  if (acceptedBefore(source, first, opening, numbered, strict, start)) return true;
  if (beforeMark >= 0 && acceptedBefore(source, beforeMark, true, numbered, strict, start)) {
    return true;
  }
  // Reads 2 and 3, the label ending right before the part, or before its opening mark.
  for (const end of beforeMark >= 0 ? [first, beforeMark] : [first]) {
    const after = end === first ? own : openingMark.c;
    // #845 (1b-i-n): at a `blank` line start, the line's first word decides (`blankHeadHolds`)
    const label = clauseNumberBack(source, end);
    if (label >= 0) {
      const kind = countedLineStart(source, label, strict);
      if (
        kind === 'blank'
          ? blankHeadHolds(source, blanksBack(source, label), start)
          : kind !== undefined && isSentenceOpening(after)
      ) {
        return true;
      }
    }
    const mark = listMarkBack(source, end);
    if (mark >= 0 && blankAfterMark(source, mark, end === first ? start : openingMark.at)) {
      const kind = countedLineStart(source, mark, strict);
      if (
        kind === 'blank'
          ? blankHeadHolds(source, blanksBack(source, mark), start)
          : kind !== undefined
      ) {
        return true;
      }
    }
  }
  return false;
}

/** #845 (Q-C): how an occurrence of a part's first piece may start the part after a skip:
 *  `accepted`; `held` back, when every rule accepts it but rule 1 (B3, a blank line inside a
 *  sentence); `refused`. */
type StartHold = 'accepted' | 'held' | 'refused';

/** A placement of every piece: its parts, and the quote offset of each piece placed only at a
 *  held-back candidate (`segments[k].start`), in quote order. */
interface Placement {
  readonly parts: Part[];
  readonly joins: readonly number[];
}

/** Places the pieces as parts: each part's first piece at the occurrence (at or after `after` when
 *  `inOrder`) that joins the most pieces after it, the earliest of those. Every part after the first
 *  follows a skip, so an occurrence of its first piece is a candidate only where `startHolds` (the
 *  canonical offset) says the document starts a sentence, a clause or a line there (correction 2).
 *  #845 (Q-C): with `heldBack`, a held-back occurrence is a candidate too, compared with the other
 *  held-back ones as above, but an accepted candidate always wins over it, and it never ends the
 *  search for its piece early; it is used only when its piece has no accepted candidate. The same
 *  searches find both kinds. #845 (walk M8): with `uncut`, among accepted candidates that join as
 *  many pieces, one that is not cut short wins, and only such a one ends the search early.
 *  #845 (S1/F1): a candidate whose part, as `extend` joins it, starts or ends inside a word a hyphen
 *  breaks across a line of `raw` (the source text) is no candidate of either kind; the join between
 *  two pieces of one part is never read for it (a quote that keeps the document's `un-`⏎`paid`
 *  joins it). `undefined` when a piece is found nowhere it may be. */
function placeParts(
  budget: Budget,
  source: Bare,
  raw: string,
  segments: readonly Segment[],
  inOrder: boolean,
  startHolds: (at: number) => StartHold,
  heldBack: boolean,
  uncut?: (part: Part) => boolean,
): Placement | undefined {
  const hay = source.text;
  const parts: Part[] = [];
  const joins: number[] = [];
  const edgesHold = (part: Part): boolean =>
    lineBreakHyphenEdgesHold(raw, source.from[part.at]!, source.to[part.end - 1]!);
  let after = 0;
  for (let k = 0; k < segments.length;) {
    const piece = segments[k]!.canonical.text;
    let best: Part | undefined;
    let held: Part | undefined;
    for (let at = budget.indexOf(hay, piece, inOrder ? after : 0); at >= 0;) {
      if (
        wordEdgesHold(hay, at, piece) &&
        numberEdgesHold(hay, at, piece) &&
        marksHold(source, at, segments[k]!.marks)
      ) {
        const hold = k === 0 ? 'accepted' : startHolds(at);
        if (hold === 'accepted') {
          const part = extend(budget, source, segments, k, at);
          if (edgesHold(part)) {
            if (
              best === undefined ||
              part.last > best.last ||
              (uncut !== undefined && part.last === best.last && uncut(part) && !uncut(best))
            ) {
              best = part;
            }
            if (part.last === segments.length - 1 && (uncut === undefined || uncut(best))) break;
          }
        } else if (hold === 'held' && heldBack) {
          const part = extend(budget, source, segments, k, at);
          if (edgesHold(part) && (held === undefined || part.last > held.last)) held = part;
        }
      }
      at = budget.indexOf(hay, piece, at + 1);
    }
    const chosen = best ?? held;
    if (chosen === undefined) return undefined;
    if (best === undefined) joins.push(segments[k]!.start);
    parts.push(chosen);
    after = chosen.end;
    k = chosen.last + 1;
  }
  return { parts, joins };
}

// ─── The tiles, for `nearest` only ──────────────────────────────────────────────────────────────

/** A1: the start of the number that a cut at `end` would split, so a cut never falls inside one. */
function retreatFromNumber(quote: string, start: number, end: number): number {
  if (end <= start || end >= quote.length) return end;
  // #845 (R-A2): by code point, so a cut never splits a surrogate pair
  const joins = (k: number): boolean => {
    const before = cpBefore(quote, k);
    const at = cpAt(quote, k);
    return (
      (isNum(before) && isNum(at)) ||
      (isJoiner(at) && isNum(before) && isNum(cpAt(quote, k + at!.length))) ||
      (isJoiner(before) && isNum(cpBefore(quote, k - before!.length)) && isNum(at))
    );
  };
  let s = end;
  while (s > start && joins(s)) s -= cpBefore(quote, s)!.length;
  return s;
}

interface Tile {
  readonly text: string;
  /** The earliest occurrence in the canonical source whose edges hold, or -1. */
  readonly at: number;
}

/**
 * Cuts the canonical quote into tiles — only to compute `nearest` (Part S, rule 5): from where the
 * quote continues, the longest prefix found anywhere in the canonical source. Being found is
 * monotone in the prefix's length, so the length grows by doubling (1, 2, 4, …) and then halves
 * (A8: never halving from the full length). A cut never falls inside a number; a tile found only
 * where its edges clash is shortened at most three times, and never when its left edge clashes. A
 * position where nothing is found yields an unfound tile of one character, or of one number.
 */
function tilesOf(budget: Budget, quote: string, source: string, tiles: Tile[]): void {
  let i = 0;
  while (i < quote.length) {
    if (quote[i] === ' ') {
      i++;
      continue;
    }
    const room = quote.length - i;
    let lo = 0;
    let hi = room;
    for (let step = 1; ; step *= 2) {
      const len = Math.min(step, room);
      if (budget.includes(source, quote.slice(i, i + len))) {
        lo = len;
        if (len === room) break;
      } else {
        hi = len - 1;
        break;
      }
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (budget.includes(source, quote.slice(i, i + mid))) lo = mid;
      else hi = mid - 1;
    }
    // #845 (R-A2): the longest found prefix, rounded down to a code-point boundary — a high surrogate
    // found alone is no character (one test, never a boundary array per tile: 845-V-44)
    if (lo > 0 && isHighSurrogate(quote.charCodeAt(i + lo - 1))) lo--;
    let end = retreatFromNumber(quote, i, i + lo);
    let at = -1;
    for (let retreats = 0; end > i; retreats++) {
      const text = quote.slice(i, end).trimEnd();
      at = findWithEdges(budget, source, text, 0);
      if (at >= 0 || retreats >= MAX_TILE_RETREATS) break;
      const first = budget.indexOf(source, text, 0);
      if (first >= 0 && !leftNumberEdgeHolds(source, first, text)) break;
      end = retreatFromNumber(quote, i, end - cpBefore(quote, end)!.length);
    }
    if (at < 0) {
      // #845 (R-A2): one character, or one number, by code point
      const own = cpAt(quote, i)!;
      let unfoundEnd = i + own.length;
      if (isNum(own)) {
        for (let c = cpAt(quote, unfoundEnd); isNum(c); c = cpAt(quote, unfoundEnd)) {
          unfoundEnd += c!.length;
        }
      }
      tiles.push({ text: quote.slice(i, unfoundEnd), at: -1 });
      i = unfoundEnd;
      continue;
    }
    const text = quote.slice(i, end).trimEnd();
    tiles.push({ text, at });
    i = end;
  }
}

/** A7: the longest found tile, when it covers at least one whole word of the source (a word with a
 *  word edge at both ends inside the tile's span) — a whole word, read by code point past marks (the
 *  reads `wordEdgesHold` uses: a mark is part of its letter's word, never its edge). */
function nearestOf(tiles: readonly Tile[], canonical: Canonical): QuoteSpan | undefined {
  let best: Tile | undefined;
  for (const t of tiles) {
    if (t.at >= 0 && (best === undefined || t.text.length > best.text.length)) best = t;
  }
  if (best === undefined) return undefined;
  const hay = canonical.text;
  const end = best.at + best.text.length;
  for (let k = best.at; k < end; k += cpAt(hay, k)!.length) {
    // a word starts at a letter or digit whose neighbour before it, read past marks, is not one
    if (!isAlnum(cpAt(hay, k)) || isAlnum(cpBefore(hay, pastMarks(hay, k)))) continue;
    // it runs over letters, digits and marks; it is whole when it ends inside the tile
    let w = k;
    for (let d = cpAt(hay, w); isAlnum(d) || isMark(d); d = cpAt(hay, w)) w += d!.length;
    if (w <= end) return spanOf(canonical, best.at, best.text.length);
  }
  return undefined;
}

// ─── L2, L3: what a found span says at its edges ────────────────────────────────────────────────

const OPENING = new Set(['"', '“', '„', '«', "'", '‘', '(', '[', '{']);
const CLOSING = new Set(['"', '”', '»', "'", '’', ')', ']', '}', '.']);
const QUOTATION_MARKS: ReadonlySet<string> = new Set(['"', '“', '”', '„', '«', '»', "'", '‘', '’']);
/** The class an edge mark is compared by: any quotation mark matches any. */
function edgeClass(c: string): string {
  return QUOTATION_MARKS.has(c) ? 'quote' : c;
}

/** L3: how far a span's start moves back (`dir` -1) or its end forward (`dir` 1) to take in the
 *  quotation marks, brackets and full stops the quote has at that edge and the source has there —
 *  #845 (R-C2): each side read past invisible characters, the span ending at the last mark taken. */
function edgeMarks(quote: string, qAt: number, source: string, sAt: number, dir: -1 | 1): number {
  const marks = dir < 0 ? OPENING : CLOSING;
  const step = dir < 0 ? stepBack : stepOn;
  let qk = qAt;
  let sk = sAt;
  for (;;) {
    const q = step(quote, qk);
    const s = step(source, sk);
    if (q.c === undefined || s.c === undefined || !marks.has(q.c) || !marks.has(s.c)) break;
    if (edgeClass(q.c) !== edgeClass(s.c)) break;
    qk = q.at;
    sk = s.at;
  }
  return Math.abs(sk - sAt);
}

/** L3: a span trimmed by one rule — it starts at the first character the quote and the source share
 *  at that edge, and ends after the last. `qStart`/`qEnd` are the quote's offsets of its first and
 *  past its last kept character. */
function trimmed(
  span: QuoteSpan,
  quote: string,
  qStart: number,
  qEnd: number,
  source: string,
): QuoteSpan {
  return {
    start: span.start - edgeMarks(quote, qStart, source, span.start, -1),
    end: span.end + edgeMarks(quote, qEnd, source, span.end, 1),
  };
}

/** L2, #845 (R-G): whether a quote that ends a sentence at `at` of the source stops where the
 *  source's sentence goes on, one read for every state. From `at`, by code point past invisible
 *  characters, past closing marks:
 *  - where the source has its own `.` `!` or `?` there, the quote is cut short only where it stops
 *    there (`stopsHere`: an exact quote's end, the last piece of a part, the last piece of a
 *    reformatted quote), when past that stop, closing marks and blanks in any order, a lowercase
 *    letter or a digit follows (N7, `approx. 412`). Inside the quote the source's own next words
 *    follow, so it cuts nothing there (D1);
 *  - where the source has no stop, its sentence goes on unless blanks, then a line break or the
 *    text's end, follow. */
function sentenceGoesOn(source: string, at: number, stopsHere: boolean): boolean {
  // #845 (R-C2, R-A2, R-B): by code point, past invisible characters; closing marks, blanks and
  // lowercase letters are the property sets
  let p = stepOn(source, at);
  while (isClosingMark(p.c)) p = stepOn(source, p.at);
  if (p.c === '.' || p.c === '!' || p.c === '?') {
    if (!stopsHere) return false;
    p = stepOn(source, p.at);
    while (isClosingMark(p.c) || isBlank(p.c)) p = stepOn(source, p.at);
    return p.c !== undefined && (isLowercase(p.c) || isDigit(p.c));
  }
  while (isBlank(p.c)) p = stepOn(source, p.at);
  return p.c !== undefined && !isLineBreak(p.c);
}

/** L2, #845 (R-G): where an exact quote ends a sentence: the offset of its last character other than
 *  whitespace (`\p{White_Space}`) and invisible characters, when that is `.` `!` or `?`, and a `.`
 *  only where L1 (item 14 inside), read on the quote, finds no abbreviation, initial, initialism or
 *  word with no letter or digit before it (`Clause No.`, `e.g.`, `U.S.`, `20 °.`); -1 otherwise. */
function exactSentenceEnd(quote: string): number {
  let p = stepBack(quote, quote.length);
  while (p.c !== undefined && SPACE.test(p.c)) p = stepBack(quote, p.at);
  if (p.c !== '.' && p.c !== '!' && p.c !== '?') return -1;
  return p.c === '.' && endsAbbreviation(quote, p.at) ? -1 : p.at;
}

// ─── The ladder ─────────────────────────────────────────────────────────────────────────────────

/**
 * Locates `quote` in `source` (the ladder above). `minPartChars` (default 20, at least 4) is the
 * floor every stitched part must reach, in canonical characters. An empty source, an empty quote, or
 * a quote with no letter or digit is `not_found` with no parts.
 * @public
 */
export function locateQuote(
  quote: string,
  source: string,
  options?: { minPartChars?: number },
): QuoteCheck {
  const minPartChars = options?.minPartChars ?? DEFAULT_MIN_PART_CHARS;
  if (!Number.isInteger(minPartChars) || minPartChars < MIN_PART_CHARS_LEAST) {
    throw new RangeError(
      `locateQuote: minPartChars must be an integer of at least ${MIN_PART_CHARS_LEAST} (got ${String(minPartChars)})`,
    );
  }
  const notFound: QuoteCheck = { state: 'not_found', parts: [], occurrences: 0 };
  const quoteCanonical = canonicalize(quote);
  if (!WORD_CHAR.test(quoteCanonical.text) || source === '') return notFound;
  const { canonical, view } = prepared(source);
  const budget = new Budget(QUOTE_SEARCH_BUDGET);
  const tiles: Tile[] = [];
  try {
    // §4: the quote's canonical form with its optional marks left out, and the marks it carries
    const quoteBare = bareOf(quoteCanonical);
    return ladder(quote, quoteBare, source, canonical, view, budget, minPartChars, tiles);
  } catch (err) {
    if (err !== OUT_OF_BUDGET) throw err;
    const nearest = nearestOf(tiles, canonical);
    return nearest === undefined ? notFound : { ...notFound, nearest };
  }
}

/** The ladder. The canonical layer reads both texts with their optional marks left out (§4), and a
 *  match holds only where every optional mark the quote (or the piece) carries is on the source's
 *  letter; the literal layer reads the texts as written. */
function ladder(
  quote: string,
  quoteCanonical: Bare,
  source: string,
  canonical: Bare,
  view: LiteralView,
  budget: Budget,
  minPartChars: number,
  tiles: Tile[],
): QuoteCheck {
  const notFound: QuoteCheck = { state: 'not_found', parts: [], occurrences: 0 };
  const canonicalQuote = quoteCanonical.text;

  const literal = findLiteral(budget, source, quote, view);
  if (literal >= 0) {
    // The whole quote occurs at least once (the literal match), whatever the canonical count says.
    const occurrences = Math.max(
      1,
      countWithEdges(budget, canonical, source, canonicalQuote, quoteCanonical.marks),
    );
    const end = literal + quote.length;
    // N7, #845 (R-G): the source has the quote's own stop, so L2's read starts there; the mark falls
    // right after it, whatever whitespace the quote carries after it
    const stop = exactSentenceEnd(quote);
    const cut = stop >= 0 && sentenceGoesOn(source, literal + stop, true);
    return {
      state: 'exact',
      parts: [{ start: literal, end }],
      occurrences,
      ...cutShort(cut ? [literal + stop + 1] : []),
    };
  }

  const segments = segmentsWithin(quote);
  const whole = findWithEdges(
    budget,
    canonical.text,
    canonicalQuote,
    0,
    canonical.text,
    canonicalQuote,
    true,
    // #845 (S1/F1): neither end inside a word a hyphen breaks across a line
    (at) =>
      marksHold(canonical, at, quoteCanonical.marks) &&
      lineBreakHyphenEdgesHold(
        source,
        canonical.from[at]!,
        canonical.to[at + canonicalQuote.length - 1]!,
      ),
  );
  if (whole >= 0) {
    const span = trimmed(
      spanOf(canonical, whole, canonicalQuote.length),
      quote,
      quoteCanonical.from[0]!,
      quoteCanonical.to[canonicalQuote.length - 1]!,
      source,
    );
    // #845 (R-G, D1): the source's own stop marks only the quote's last piece
    const cut = segments.flatMap((s, n) => {
      if (!s.endsSentence) return [];
      const k = quoteCanonical.from.findIndex((o) => o >= s.end);
      const last = (k < 0 ? canonicalQuote.length : k) - 1;
      const at = canonical.to[whole + last]!;
      return sentenceGoesOn(source, at, n === segments.length - 1) ? [at] : [];
    });
    return {
      state: 'reformatted',
      parts: [span],
      occurrences: countWithEdges(budget, canonical, source, canonicalQuote, quoteCanonical.marks),
      ...cutShort(cut),
    };
  }

  if (segments.length > 1) {
    const startHolds = (at: number): StartHold => {
      const raw = canonical.from[at]!;
      if (partStartHolds(source, raw, true)) return 'accepted';
      return partStartHolds(source, raw, false) ? 'held' : 'refused';
    };
    const long = (ps: readonly Part[]): boolean => ps.every((p) => p.end - p.at >= minPartChars);
    // #845 (Q-C): only the in-order placement takes held-back candidates. When it completes by one,
    // every part long enough, rule 1 alone refused the quote: say why and where, and stop there.
    const inOrder = placeParts(budget, canonical, source, segments, true, startHolds, true);
    if (inOrder !== undefined && inOrder.joins.length > 0 && long(inOrder.parts)) {
      return { ...notFound, cause: 'blank_line_join', join_at: inOrder.joins };
    }
    const parts =
      inOrder !== undefined && inOrder.joins.length === 0 && long(inOrder.parts)
        ? inOrder.parts
        : placeParts(budget, canonical, source, segments, false, startHolds, false)?.parts;
    if (parts !== undefined && long(parts)) {
      /** L2: the source offsets where a part's sentence-ending pieces stop short; #845 (R-G, D1): the
       *  source's own stop marks only each part's last piece. */
      const cutOf = (p: Part): number[] => {
        const at: number[] = [];
        p.pieces.forEach((placed, n) => {
          if (!segments[p.first + n]!.endsSentence) return;
          const end = canonical.to[placed.at + placed.length - 1]!;
          if (sentenceGoesOn(source, end, p.first + n === p.last)) at.push(end);
        });
        return at;
      };
      let chosen = parts;
      let cut = parts.flatMap(cutOf);
      // #845 (walk M8): a result cut short gets a second, in-order placement on the searches left,
      // accepted candidates only, preferring among those that join as many pieces one that is not
      // cut short; it replaces the first only when it places every part, each long enough, with
      // fewer cut-short ends. It never sets `cause`; when the searches run out, the first stands.
      if (cut.length > 0) {
        try {
          const second = placeParts(
            budget,
            canonical,
            source,
            segments,
            true,
            startHolds,
            false,
            (p) => cutOf(p).length === 0,
          );
          if (second !== undefined && long(second.parts)) {
            const secondCut = second.parts.flatMap(cutOf);
            if (secondCut.length < cut.length) {
              chosen = second.parts;
              cut = secondCut;
            }
          }
        } catch (err) {
          if (err !== OUT_OF_BUDGET) throw err;
        }
      }
      const ordered = chosen.every((p, i) => i === 0 || p.at >= chosen[i - 1]!.end);
      const spans = chosen.map((p) => {
        const first = segments[p.first]!;
        const last = segments[p.last]!;
        return trimmed(
          spanOf(canonical, p.at, p.end - p.at),
          quote,
          first.canonical.from[0]!,
          last.canonical.to[last.canonical.text.length - 1]!,
          source,
        );
      });
      return {
        state: ordered ? 'stitched' : 'stitched_out_of_order',
        parts: spans,
        occurrences: 0,
        ...cutShort(cut),
      };
    }
  }

  tilesOf(budget, canonicalQuote, canonical.text, tiles);
  const nearest = nearestOf(tiles, canonical);
  return nearest === undefined ? notFound : { ...notFound, nearest };
}

function cutShort(at: readonly number[]): { cut_short?: true; cut_short_at?: readonly number[] } {
  return at.length > 0 ? { cut_short: true, cut_short_at: at } : {};
}
