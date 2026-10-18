/**
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
 *   covers at least one whole word.
 * (`unquoted` is the handler's, for a candidate with no quote and no value; this never returns it.)
 *
 * A quote that ends a sentence where the source's sentence goes on is marked `cut_short` (L2). Every
 * offset is a UTF-16 code-unit offset into the ORIGINAL source.
 */

export const QUOTE_STATES = [
  'exact',
  'reformatted',
  'stitched',
  'stitched_out_of_order',
  'not_found',
  'unquoted',
] as const;

export type QuoteState = (typeof QUOTE_STATES)[number];

/** A span of the original source: `source.slice(start, end)`. */
export interface QuoteSpan {
  readonly start: number;
  readonly end: number;
}

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

/** N4: a dash or hyphen, read as `-`: every BMP `\p{Pd}` character (25 of them), the minus sign
 *  U+2212, the heavy minus sign U+2796 and the modifier letter minus sign U+02D7 — 28 in all. One code
 *  unit maps to one, so every offset stays the source's own. The two `\p{Pd}` characters outside the
 *  BMP (U+10D6E, U+10EAD) are left out: each is two code units, and reading one as a one-unit `-`
 *  would shift every later offset of the dash-mapped copy. */
const DASH = /^\p{Pd}$/u;
const isDash = (c: string | undefined): boolean =>
  c !== undefined &&
  c.length === 1 &&
  (DASH.test(c) || c === '\u2212' || c === '\u2796' || c === '\u02d7');
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
/** N2: a space that may group the thousands of one number. */
const GROUP_SPACES: ReadonlySet<string> = new Set([' ', '\u00a0', '\u2009', '\u202f']);
/** A1: the characters that join the digits of one number (after the dash mapping). */
const NUMBER_JOINERS: ReadonlySet<string> = new Set([',', '.', '/', ':', '-']);
const LETTER = /^\p{L}$/u;
const DIGIT = /^\p{Nd}$/u;
const OTHER_NUMBER = /^\p{No}$/u;
const SPACE = /^\s$/u;
const CURRENCY = /^\p{Sc}$/u;
const MATH = /^\p{Sm}$/u;
const MARK = /^\p{M}$/u;
const WORD_CHAR = /[\p{L}\p{Nd}]/u;
const LOWERCASE = /^\p{Ll}$/u;

const isLetter = (c: string | undefined): boolean => c !== undefined && LETTER.test(c);
/** A digit for numbers and edges: `\p{Nd}`, and superscripts and fractions (`\p{No}`, A1/A4). */
const isNum = (c: string | undefined): boolean =>
  c !== undefined && (DIGIT.test(c) || OTHER_NUMBER.test(c));
const isDigit = (c: string | undefined): boolean => c !== undefined && DIGIT.test(c);
const isAlnum = (c: string | undefined): boolean => isLetter(c) || isNum(c);
const isGroupSpace = (c: string | undefined): boolean => c !== undefined && GROUP_SPACES.has(c);
const isJoiner = (c: string | undefined): boolean => c !== undefined && NUMBER_JOINERS.has(c);
/** A1: a symbol that belongs to the number it touches: `%` `‰` `°`, currency, comparison and math
 *  signs (`\p{Sm}`: `<` `>` `≤` `≥` `+` …). */
const isNumberSymbol = (c: string | undefined): boolean =>
  c !== undefined && (KEPT_SYMBOLS.has(c) || CURRENCY.test(c) || MATH.test(c));

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
 */
function canonicalize(text: string): Canonical {
  const chars: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  while (i < text.length) {
    const base = String.fromCodePoint(text.codePointAt(i)!);
    let j = i + base.length;
    let marks = 0;
    while (
      j < text.length &&
      marks < MAX_MARKS &&
      MARK.test(String.fromCodePoint(text.codePointAt(j)!))
    ) {
      j += codePointLength(text, j);
      marks++;
    }
    const unit = text.slice(i, j);
    const normal =
      OTHER_NUMBER.test(base) || UNFOLDED_PRIMES.has(base) ? unit : unit.normalize('NFKC');
    for (const ch of normal.toLowerCase()) {
      chars.push(isDash(ch) ? '-' : ch);
      from.push(i);
      to.push(j);
    }
    i = j;
  }

  const kind: Array<'keep' | 'space' | 'drop'> = chars.map((c) =>
    isAlnum(c) || isNumberSymbol(c) ? 'keep' : SPACE.test(c) ? 'space' : 'drop',
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
    outFrom.push(from[k]!);
    outTo.push(to[k]!);
  }
  return { text: out, from: outFrom, to: outTo };
}

/** The canonical text alone — what two texts are compared as (for this module's tests; not part
 *  of core's exports). */
export function canonicalForm(text: string): string {
  return canonicalize(text).text;
}

function codePointLength(text: string, at: number): number {
  return text.codePointAt(at)! > 0xffff ? 2 : 1;
}

/** The source as the literal layer's edge rule reads it: each dash or hyphen (N4's `isDash`) as
 *  `-`, one code unit for one, so every offset is the source's own (A1, audit finding 4). */
function dashMapped(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += isDash(text[i]) ? '-' : text[i];
  return out;
}

/** One cached source: a handler checks many quotes against one document (L4: it lets it go). */
let lastSource: string | undefined;
let lastPrepared: Prepared | undefined;
interface Prepared {
  readonly canonical: Canonical;
  readonly mapped: string;
}
function prepared(source: string): Prepared {
  if (lastSource !== source || lastPrepared === undefined) {
    lastPrepared = { canonical: canonicalize(source), mapped: dashMapped(source) };
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

function leftNumberEdgeHolds(hay: string, at: number, needle: string): boolean {
  const first = needle[0];
  const b1 = at > 0 ? hay[at - 1] : undefined;
  const b2 = at > 1 ? hay[at - 2] : undefined;
  if (isNum(first)) {
    if (isAlnum(b1)) return false;
    if (isJoiner(b1) && isNum(b2)) return false;
    if (b1 === '-' || isNumberSymbol(b1)) return false;
    // N3: a leading decimal — a `.` or `,` before the digit that follows no letter or digit.
    if ((b1 === '.' || b1 === ',') && !isAlnum(b2)) return false;
  } else if (isLetter(first) && isNum(b1)) return false;
  if (first === '-' && isNum(needle[1]) && isAlnum(b1)) return false;
  // N1: a quote that opens on a number's separator (`.5%` in `4.5%`).
  if (isJoiner(first) && isNum(needle[1]) && isNum(b1)) return false;
  // N2: a quote that opens with a group of exactly three digits after one group space and a run of
  //     1–3 digits that follows no letter (`200 000` in `1 200 000`; never `500` in `2024 500`).
  if (
    isDigit(first) &&
    isDigit(needle[1]) &&
    isDigit(needle[2]) &&
    !isDigit(needle[3]) &&
    isGroupSpace(b1) &&
    isDigit(b2)
  ) {
    let s = at - 1;
    while (s > 0 && isDigit(hay[s - 1])) s--;
    if (at - 1 - s <= 3 && !isLetter(hay[s - 1])) return false;
  }
  return true;
}

function rightNumberEdgeHolds(hay: string, at: number, needle: string): boolean {
  const last = needle[needle.length - 1];
  const end = at + needle.length;
  const a1 = hay[end];
  const a2 = hay[end + 1];
  if (isNum(last)) {
    if (isAlnum(a1)) return false;
    if (isJoiner(a1) && isNum(a2)) return false;
    if (isNumberSymbol(a1)) return false;
  } else if (isLetter(last) && isNum(a1)) return false;
  // N1: a quote that ends on a number's separator (`18.` in `18.5`).
  if (isJoiner(last) && isNum(needle[needle.length - 2]) && isNum(a1)) return false;
  // N2: a quote whose last digit ends a run of 1–3 digits that follows no letter, where the source
  //     goes on with one group space, exactly three digits and then no digit (`1 200` in
  //     `1 200 000`; never `Q1` in `Q1 120`).
  if (isDigit(last) && isGroupSpace(a1)) {
    let s = end;
    while (s > 0 && isDigit(hay[s - 1])) s--;
    if (
      end - s <= 3 &&
      !isLetter(hay[s - 1]) &&
      isDigit(hay[end + 1]) &&
      isDigit(hay[end + 2]) &&
      isDigit(hay[end + 3]) &&
      !isDigit(hay[end + 4])
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
 *  literal layer reads the raw one. */
function wordEdgesHold(hay: string, at: number, needle: string): boolean {
  const end = at + needle.length;
  if (at > 0 && isAlnum(hay[at - 1]) && isAlnum(needle[0])) return false;
  if (end < hay.length && isAlnum(hay[end]) && isAlnum(needle[needle.length - 1])) return false;
  if (isLetter(needle[0]) && isWordHyphen(hay[at - 1]) && isLetter(hay[at - 2])) return false;
  if (isLetter(needle[needle.length - 1]) && isWordHyphen(hay[end]) && isLetter(hay[end + 1])) {
    return false;
  }
  return true;
}

/** The first occurrence at or after `fromIndex` whose number edges hold — read from `edgeHay` and
 *  `edgeNeedle` (the dash-mapped source and quote, for the literal layer; the same offsets) — and,
 *  when `words` is set, whose word edges hold in `hay` itself (N6: the literal and canonical layers);
 *  or -1. */
function findWithEdges(
  budget: Budget,
  hay: string,
  needle: string,
  fromIndex: number,
  edgeHay: string = hay,
  edgeNeedle: string = needle,
  words = false,
): number {
  if (needle === '') return -1;
  let at = budget.indexOf(hay, needle, fromIndex);
  while (
    at >= 0 &&
    !(numberEdgesHold(edgeHay, at, edgeNeedle) && (!words || wordEdgesHold(hay, at, needle)))
  ) {
    at = budget.indexOf(hay, needle, at + 1);
  }
  return at;
}

/** Non-overlapping occurrences whose number and word edges hold (N6). */
function countWithEdges(budget: Budget, hay: string, needle: string): number {
  let count = 0;
  for (let at = findWithEdges(budget, hay, needle, 0, hay, needle, true); at >= 0;) {
    count++;
    at = findWithEdges(budget, hay, needle, at + needle.length, hay, needle, true);
  }
  return count;
}

function spanOf(canonical: Canonical, at: number, length: number): QuoteSpan {
  return { start: canonical.from[at]!, end: canonical.to[at + length - 1]! };
}

// ─── Part S: the quote's breaks and its pieces ──────────────────────────────────────────────────

/** One piece of a quote between two breaks (Part S): its raw offsets in the quote, its canonical
 *  text with the map back, and whether the break after it ends a sentence (L2). */
interface Segment {
  readonly start: number;
  readonly end: number;
  readonly canonical: Canonical;
  readonly endsSentence: boolean;
}

const DOUBLE_QUOTES: ReadonlySet<string> = new Set(['"', '“', '”']);
const LINE_BREAKS: ReadonlySet<string> = new Set(['\n', '\r', ' ', ' ']);
const ABBREVIATIONS: ReadonlySet<string> = new Set(NOT_SENTENCE_ENDS.map((a) => a.toLowerCase()));

/** L1: the `.` at `at` ends an abbreviation or an initial, never a sentence. */
function endsAbbreviation(quote: string, at: number): boolean {
  let s = at;
  while (s > 0 && (isLetter(quote[s - 1]) || quote[s - 1] === '.')) s--;
  const token = quote.slice(s, at);
  if (token === '') return false;
  if (ABBREVIATIONS.has(`${token}.`.toLowerCase())) return true;
  return token.length === 1 && token !== token.toLowerCase();
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
    const canonical = canonicalize(quote.slice(start, end));
    if (WORD_CHAR.test(canonical.text)) {
      segments.push({
        start,
        end,
        canonical: {
          text: canonical.text,
          from: canonical.from.map((o) => o + start),
          to: canonical.to.map((o) => o + start),
        },
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
    const next = quote[i + 1];
    const sentenceEnd =
      (c === '.' || c === '!' || c === '?') &&
      (next === undefined || SPACE.test(next)) &&
      !(c === '.' && endsAbbreviation(quote, i));
    const clauseBreak = c === ';' || (c === ':' && !(isNum(quote[i - 1]) && isNum(next)));
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

/** Whether a piece fits at `at` of the canonical source: found there, at word and number edges. */
function fitsAt(budget: Budget, hay: string, piece: string, at: number): boolean {
  return (
    at >= 0 &&
    budget.startsWith(hay, piece, at) &&
    wordEdgesHold(hay, at, piece) &&
    numberEdgesHold(hay, at, piece)
  );
}

/** From piece `first` placed at `at`, the pieces that follow it right after (at its end, or one
 *  space after it) join it into one part (Part S, rule 3). */
function extend(
  budget: Budget,
  hay: string,
  segments: readonly Segment[],
  first: number,
  at: number,
): Part {
  const pieces: Placed[] = [{ at, length: segments[first]!.canonical.text.length }];
  let end = at + segments[first]!.canonical.text.length;
  let last = first;
  for (let k = first + 1; k < segments.length; k++) {
    const piece = segments[k]!.canonical.text;
    const next = hay[end] === ' ' ? end + 1 : end;
    if (!fitsAt(budget, hay, piece, next)) break;
    pieces.push({ at: next, length: piece.length });
    end = next + piece.length;
    last = k;
  }
  return { first, last, at, end, pieces };
}

// ─── Correction 2: after a skip, the next part starts where the document starts a sentence, a
//     clause or a line (the owner's yes, 2026-10-18) ──────────────────────────────────────────────

/** Step 2's opening marks; the quotation marks among them make a line break a line start. */
const START_OPENING: ReadonlySet<string> = new Set(['"', '“', '„', '«', "'", '‘', '(', '[']);
const START_QUOTE_OPENING: ReadonlySet<string> = new Set(['"', '“', '„', '«', "'", '‘']);
/** Step 4's closing marks. */
const START_CLOSING: ReadonlySet<string> = new Set(['"', '”', '’', "'", ')', ']', '»']);
/** Step 3's list marks (a run of `#` too), only at the start of a line. */
const LIST_MARKS: ReadonlySet<string> = new Set(['-', '*', '•', '◦', '▪', '‣', '·', '–', '—', '|']);

const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t';

function blanksBack(source: string, at: number): number {
  let i = at;
  while (i > 0 && isBlank(source[i - 1])) i--;
  return i;
}

/** Step 3: the start of one clause number that ends at `at` — a bracketed group of at most four
 *  letters or digits (`(a)`, `(iv)`, `(3)`), or digits joined by `.` (`6.2`, `3.4.1`, `12`) with an
 *  optional closing `.` or `)` — or -1. */
function clauseNumberBack(source: string, at: number): number {
  if (source[at - 1] === ')') {
    let j = at - 2;
    let n = 0;
    while (j >= 0 && n < 5 && (isLetter(source[j]) || isDigit(source[j]))) {
      j--;
      n++;
    }
    if (n >= 1 && n <= 4 && source[j] === '(') return j;
  }
  let j = at;
  if ((source[j - 1] === '.' || source[j - 1] === ')') && isDigit(source[j - 2])) j--;
  if (!isDigit(source[j - 1])) return -1;
  for (;;) {
    while (isDigit(source[j - 1])) j--;
    if (source[j - 1] === '.' && isDigit(source[j - 2])) {
      j--;
      continue;
    }
    return j;
  }
}

/** Step 3: the start of one list mark that ends at `at`, where a line break or the source's start
 *  comes right before it (past spaces and tabs), or -1. */
function listMarkBack(source: string, at: number): number {
  let j = -1;
  if (source[at - 1] === '#') {
    j = at - 1;
    while (j > 0 && source[j - 1] === '#') j--;
  } else if (at > 0 && LIST_MARKS.has(source[at - 1]!)) j = at - 1;
  if (j < 0) return -1;
  const k = blanksBack(source, j);
  return k === 0 || LINE_BREAKS.has(source[k - 1]!) ? j : -1;
}

/** The accepted characters other than a line break, the one right before `at`: a `.` `!` `?` that
 *  ends a sentence (L1's test: never an abbreviation or an initial), `;`, a `:` not between two
 *  digits. */
function endsSentenceOrClause(source: string, at: number): boolean {
  const c = source[at - 1];
  if (c === '.') return !endsAbbreviation(source, at - 1);
  if (c === '!' || c === '?' || c === ';') return true;
  if (c === ':') return !(isNum(source[at - 2]) && isNum(source[at]));
  return false;
}

/** Whether the document starts a line at the line break `lineBreak`: the line before it is blank,
 *  or ends (past spaces and closing marks) a sentence or a clause. Hard-wrapped text breaks its
 *  lines inside sentences, so a bare line break is not a line start. */
function lineBeforeEnds(source: string, lineBreak: number): boolean {
  let i = lineBreak;
  while (i > 0 && (isBlank(source[i - 1]) || source[i - 1] === '\r')) i--;
  if (i === 0 || LINE_BREAKS.has(source[i - 1]!)) return true;
  while (i > 0 && START_CLOSING.has(source[i - 1]!)) i--;
  return endsSentenceOrClause(source, i);
}

/** Step 4 and the accepted character: past spaces and closing marks, the source starts at `at`, or
 *  a sentence or clause ends there, or a line starts there (`opened`: steps 2–3 skipped a clause
 *  number, a list mark or an opening quotation mark on the new line). */
function startAccepted(source: string, at: number, opened: boolean): boolean {
  let i = blanksBack(source, at);
  while (i > 0 && START_CLOSING.has(source[i - 1]!)) i--;
  if (i === 0) return true;
  const c = source[i - 1]!;
  if (LINE_BREAKS.has(c)) return opened || lineBeforeEnds(source, i - 1);
  return endsSentenceOrClause(source, i);
}

/**
 * Correction 2: whether a part placed at raw offset `start` starts where the document starts a
 * sentence, a clause or a line — read in the RAW source (the canonical form drops `.` `;` `:` and
 * turns line breaks into spaces). Walking back: (1) spaces and tabs; (2) optionally one opening
 * quotation mark or bracket, then spaces and tabs; (3) optionally one clause number, or one list mark
 * at a line's start; (4) spaces, tabs and closing marks; then an accepted character. Each optional
 * step is tried with and without it, and the start holds if ANY reading reaches an accepted
 * character (read greedily, `2031.` in `…30 April 2031. The notice…` would be a clause number).
 */
function partStartHolds(source: string, start: number): boolean {
  const first = blanksBack(source, start);
  const afterStep2 = [{ at: first, opened: false }];
  if (first > 0 && START_OPENING.has(source[first - 1]!)) {
    afterStep2.push({
      at: blanksBack(source, first - 1),
      opened: START_QUOTE_OPENING.has(source[first - 1]!),
    });
  }
  for (const reading of afterStep2) {
    if (startAccepted(source, reading.at, reading.opened)) return true;
    const clause = clauseNumberBack(source, reading.at);
    if (clause >= 0 && startAccepted(source, clause, true)) return true;
    const mark = listMarkBack(source, reading.at);
    if (mark >= 0 && startAccepted(source, mark, true)) return true;
  }
  return false;
}

/** Places the pieces as parts: each part's first piece at the occurrence (at or after `after` when
 *  `inOrder`) that joins the most pieces after it, the earliest of those. Every part after the first
 *  follows a skip, so an occurrence of its first piece is a candidate only where `startHolds` (the
 *  canonical offset) says the document starts a sentence, a clause or a line there (correction 2).
 *  `undefined` when a piece is found nowhere it may be. */
function placeParts(
  budget: Budget,
  hay: string,
  segments: readonly Segment[],
  inOrder: boolean,
  startHolds: (at: number) => boolean,
): Part[] | undefined {
  const parts: Part[] = [];
  let after = 0;
  for (let k = 0; k < segments.length;) {
    const piece = segments[k]!.canonical.text;
    let best: Part | undefined;
    for (let at = budget.indexOf(hay, piece, inOrder ? after : 0); at >= 0;) {
      if (
        wordEdgesHold(hay, at, piece) &&
        numberEdgesHold(hay, at, piece) &&
        (k === 0 || startHolds(at))
      ) {
        const part = extend(budget, hay, segments, k, at);
        if (best === undefined || part.last > best.last) best = part;
        if (part.last === segments.length - 1) break;
      }
      at = budget.indexOf(hay, piece, at + 1);
    }
    if (best === undefined) return undefined;
    parts.push(best);
    after = best.end;
    k = best.last + 1;
  }
  return parts;
}

// ─── The tiles, for `nearest` only ──────────────────────────────────────────────────────────────

/** A1: the start of the number that a cut at `end` would split, so a cut never falls inside one. */
function retreatFromNumber(quote: string, start: number, end: number): number {
  if (end <= start || end >= quote.length) return end;
  const joins = (k: number): boolean =>
    (isNum(quote[k - 1]) && isNum(quote[k])) ||
    (isJoiner(quote[k]) && isNum(quote[k - 1]) && isNum(quote[k + 1])) ||
    (isJoiner(quote[k - 1]) && isNum(quote[k - 2]) && isNum(quote[k]));
  let s = end;
  while (s > start && joins(s)) s--;
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
    let end = retreatFromNumber(quote, i, i + lo);
    let at = -1;
    for (let retreats = 0; end > i; retreats++) {
      const text = quote.slice(i, end).trimEnd();
      at = findWithEdges(budget, source, text, 0);
      if (at >= 0 || retreats >= MAX_TILE_RETREATS) break;
      const first = budget.indexOf(source, text, 0);
      if (first >= 0 && !leftNumberEdgeHolds(source, first, text)) break;
      end = retreatFromNumber(quote, i, end - 1);
    }
    if (at < 0) {
      let unfoundEnd = i + 1;
      if (isNum(quote[i]))
        while (unfoundEnd < quote.length && isNum(quote[unfoundEnd])) unfoundEnd++;
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
 *  word edge at both ends inside the tile's span). */
function nearestOf(tiles: readonly Tile[], canonical: Canonical): QuoteSpan | undefined {
  let best: Tile | undefined;
  for (const t of tiles) {
    if (t.at >= 0 && (best === undefined || t.text.length > best.text.length)) best = t;
  }
  if (best === undefined) return undefined;
  const hay = canonical.text;
  const end = best.at + best.text.length;
  for (let k = best.at; k < end; k++) {
    if (!isAlnum(hay[k]) || (k > 0 && isAlnum(hay[k - 1]))) continue;
    let w = k;
    while (w < hay.length && isAlnum(hay[w])) w++;
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
 *  quotation marks, brackets and full stops the quote has at that edge and the source has there. */
function edgeMarks(quote: string, qAt: number, source: string, sAt: number, dir: -1 | 1): number {
  const marks = dir < 0 ? OPENING : CLOSING;
  let n = 0;
  for (;;) {
    const q = dir < 0 ? quote[qAt - 1 - n] : quote[qAt + n];
    const s = dir < 0 ? source[sAt - 1 - n] : source[sAt + n];
    if (q === undefined || s === undefined || !marks.has(q) || !marks.has(s)) return n;
    if (edgeClass(q) !== edgeClass(s)) return n;
    n++;
  }
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

/** L2: whether the source's sentence goes on after `at` (past closing marks and spaces it reaches
 *  no sentence end, line break or end of text). */
function sentenceGoesOn(source: string, at: number): boolean {
  let k = at;
  while (k < source.length && CLOSING.has(source[k]!) && source[k] !== '.') k++;
  if (source[k] === '.' || source[k] === '!' || source[k] === '?') return false;
  while (k < source.length && (source[k] === ' ' || source[k] === '\t')) k++;
  const c = source[k];
  return c !== undefined && !LINE_BREAKS.has(c);
}

/** N7: whether the source's sentence goes on after an exact quote's own closing `.` `!` `?` at `at`:
 *  past closing marks, spaces and tabs, the next character is a lowercase letter or a digit
 *  (`approx. 412`). */
function exactGoesOn(source: string, at: number): boolean {
  let k = at;
  while (
    k < source.length &&
    ((CLOSING.has(source[k]!) && source[k] !== '.') || isBlank(source[k]))
  ) {
    k++;
  }
  const c = source[k];
  return c !== undefined && (LOWERCASE.test(c) || isDigit(c));
}

// ─── The ladder ─────────────────────────────────────────────────────────────────────────────────

/**
 * Locates `quote` in `source` (the ladder above). `minPartChars` (default 20, at least 4) is the
 * floor every stitched part must reach, in canonical characters. An empty source, an empty quote, or
 * a quote with no letter or digit is `not_found` with no parts.
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
  const { canonical, mapped } = prepared(source);
  const budget = new Budget(QUOTE_SEARCH_BUDGET);
  const tiles: Tile[] = [];
  try {
    return ladder(quote, quoteCanonical, source, canonical, mapped, budget, minPartChars, tiles);
  } catch (err) {
    if (err !== OUT_OF_BUDGET) throw err;
    const nearest = nearestOf(tiles, canonical);
    return nearest === undefined ? notFound : { ...notFound, nearest };
  }
}

function ladder(
  quote: string,
  quoteCanonical: Canonical,
  source: string,
  canonical: Canonical,
  mapped: string,
  budget: Budget,
  minPartChars: number,
  tiles: Tile[],
): QuoteCheck {
  const notFound: QuoteCheck = { state: 'not_found', parts: [], occurrences: 0 };
  const canonicalQuote = quoteCanonical.text;

  const literal = findWithEdges(budget, source, quote, 0, mapped, dashMapped(quote), true);
  if (literal >= 0) {
    // The whole quote occurs at least once (the literal match), whatever the canonical count says.
    const occurrences = Math.max(1, countWithEdges(budget, canonical.text, canonicalQuote));
    const end = literal + quote.length;
    // N7: the source has the quote's own closing `.` `!` `?`, so L2's test reads the character after.
    const last = quote[quote.length - 1];
    const cut = (last === '.' || last === '!' || last === '?') && exactGoesOn(source, end);
    return {
      state: 'exact',
      parts: [{ start: literal, end }],
      occurrences,
      ...cutShort(cut ? [end] : []),
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
  );
  if (whole >= 0) {
    const span = trimmed(
      spanOf(canonical, whole, canonicalQuote.length),
      quote,
      quoteCanonical.from[0]!,
      quoteCanonical.to[canonicalQuote.length - 1]!,
      source,
    );
    const cut = segments
      .filter((s) => s.endsSentence)
      .map((s) => {
        const k = quoteCanonical.from.findIndex((o) => o >= s.end);
        const last = (k < 0 ? canonicalQuote.length : k) - 1;
        return canonical.to[whole + last]!;
      })
      .filter((at) => sentenceGoesOn(source, at));
    return {
      state: 'reformatted',
      parts: [span],
      occurrences: countWithEdges(budget, canonical.text, canonicalQuote),
      ...cutShort(cut),
    };
  }

  if (segments.length > 1) {
    const hay = canonical.text;
    const startHolds = (at: number): boolean => partStartHolds(source, canonical.from[at]!);
    const inOrder = placeParts(budget, hay, segments, true, startHolds);
    const parts =
      inOrder !== undefined && inOrder.every((p) => p.end - p.at >= minPartChars)
        ? inOrder
        : placeParts(budget, hay, segments, false, startHolds);
    if (parts !== undefined && parts.every((p) => p.end - p.at >= minPartChars)) {
      const ordered = parts.every((p, i) => i === 0 || p.at >= parts[i - 1]!.end);
      const spans = parts.map((p) => {
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
      const cut: number[] = [];
      for (const p of parts) {
        p.pieces.forEach((placed, n) => {
          if (!segments[p.first + n]!.endsSentence) return;
          const at = canonical.to[placed.at + placed.length - 1]!;
          if (sentenceGoesOn(source, at)) cut.push(at);
        });
      }
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
