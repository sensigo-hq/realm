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
/** The language unit (§2): a code point that is default-ignorable (CGJ U+034F and the variation
 *  selectors are such marks). */
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
/** §4: a code point whose script extensions hold Arabic or Hebrew — read by property, never a range
 *  list. */
const ARABIC_OR_HEBREW = /^[\p{scx=Arabic}\p{scx=Hebrew}]$/u;

const isLetter = (c: string | undefined): boolean => c !== undefined && LETTER.test(c);
/** A mark (`\p{M}`); none lies below U+0300, so most characters are answered without the regex. */
const isMark = (c: string | undefined): boolean =>
  c !== undefined && c.charCodeAt(0) >= 0x300 && MARK.test(c);
/** §2: a visible mark — a `\p{M}` that is not default-ignorable (an accent, a vowel sign, a tone
 *  mark; never CGJ or a variation selector). */
const isVisibleMark = (c: string | undefined): boolean => isMark(c) && !DEFAULT_IGNORABLE.test(c!);
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
  let i = 0;
  while (i < text.length) {
    const first = String.fromCodePoint(text.codePointAt(i)!);
    let j = i + first.length;
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
      OTHER_NUMBER.test(first) || UNFOLDED_PRIMES.has(first) ? unit : unit.normalize('NFKC');
    for (const c of normal) {
      if (isMark(c)) {
        onLetter ??= isLetter(base);
        chars.push(c);
        kept.push(onLetter && isVisibleMark(c));
        from.push(i);
        to.push(j);
        continue;
      }
      base = c;
      onLetter = undefined;
      // lower-cased one code point at a time: a mark that lower-casing adds is not kept
      for (const ch of c.toLowerCase()) {
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

function codePointLength(text: string, at: number): number {
  return text.codePointAt(at)! > 0xffff ? 2 : 1;
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

/** UAX #29 GB9: whether a visible mark stands at `i`, past default-ignorable code points — a span
 *  starting or ending there would split a letter from its mark. */
function visibleMarkAt(s: string, i: number): boolean {
  let k = i;
  // no default-ignorable code point lies below U+00AD
  for (
    let c = cpAt(s, k);
    c !== undefined && c.charCodeAt(0) >= 0xad && DEFAULT_IGNORABLE.test(c);
    c = cpAt(s, k)
  ) {
    k += c.length;
  }
  return isVisibleMark(cpAt(s, k));
}

/** The source as the literal layer's edge rule reads it: each dash or hyphen (N4's `isDash`) as
 *  `-`, one code unit for one, so every offset is the source's own (A1, audit finding 4). */
function dashMapped(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += isDash(text[i]) ? '-' : text[i];
  return out;
}

/** 02 B: an invisible format character (`\p{Cf}`: the soft hyphen U+00AD, the zero-width characters
 *  U+200B–U+200D, U+2060, U+FEFF, and the rest of the category), read by code point. */
const FORMAT = /^\p{Cf}$/u;

/** 02 B: the source as the literal layer's edges read it — every `\p{Cf}` code point left out, so an
 *  invisible character never makes a word or number edge. `raw` keeps the dashes (the word edges'
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
    const unit = String.fromCodePoint(text.codePointAt(i)!);
    for (let u = 0; u < unit.length; u++) at.push(raw.length);
    if (!FORMAT.test(unit)) raw += unit;
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

function leftNumberEdgeHolds(hay: string, at: number, needle: string): boolean {
  const first = needle[0];
  // the language unit (§3, UAX #29 WB4): the characters before read by code point, each past its
  // marks (the needle's own reads stay code-unit until #845's R-A2)
  const p1 = pastMarks(hay, at);
  const b1 = cpBefore(hay, p1);
  const b2 = b1 === undefined ? undefined : cpBefore(hay, pastMarks(hay, p1 - b1.length));
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
  // the language unit (§3): the characters after read by code point, past marks (the needle's last
  // character stays as today until #845's R-A2)
  const q1 = pastMarksAfter(hay, end);
  const a1 = cpAt(hay, q1);
  const a2 = a1 === undefined ? undefined : cpAt(hay, pastMarksAfter(hay, q1 + a1.length));
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
  if (isLetter(needle[0]) && isWordHyphen(hay[at - 1]) && isLetter(hay[at - 2])) return false;
  if (isLetter(needle[needle.length - 1]) && isWordHyphen(hay[end]) && isLetter(hay[end + 1])) {
    return false;
  }
  return true;
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
 *  read in the literal view, so past every `\p{Cf}` character; and a word the source goes on with
 *  as a contraction is the same word — a quote ending with a letter before `'t` or `’t` and then no
 *  letter or digit (`The Tenant can` in `can't`), or ending with a letter and `'` or `’` before a
 *  letter (`The Tenant can'` in `can't`), ends inside it. */
function literalEdgesHold(view: LiteralView, at: number, end: number): boolean {
  const from = view.at[at]!;
  const to = view.at[end]!;
  const needle = view.raw.slice(from, to);
  if (needle === '') return false;
  if (!numberEdgesHold(view.mapped, from, view.mapped.slice(from, to))) return false;
  if (!wordEdgesHold(view.raw, from, needle)) return false;
  const last = needle[needle.length - 1];
  const [a1, a2, a3] = [view.raw[to], view.raw[to + 1], view.raw[to + 2]];
  if (isLetter(last) && (a1 === "'" || a1 === '’') && a2 === 't' && !isAlnum(a3)) return false;
  if ((last === "'" || last === '’') && isLetter(needle[needle.length - 2]) && isLetter(a1)) {
    return false;
  }
  return true;
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
  while (at >= 0 && !literalEdgesHold(view, at + lead, at + quote.length - trail)) {
    at = budget.indexOf(source, quote, at + 1);
  }
  return at;
}

/** Non-overlapping occurrences whose number and word edges hold (N6), and whose optional marks hold
 *  (§4: the quote's own). */
function countWithEdges(budget: Budget, source: Bare, needle: string, marks: Marks): number {
  const accept = (at: number): boolean => marksHold(source, at, marks);
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

/** The opening marks a part may sit after (a quotation mark or a bracket). */
const START_OPENING: ReadonlySet<string> = new Set(['"', '“', '„', '«', "'", '‘', '(', '[']);
/** The closing marks walked past before an accepted character. */
const START_CLOSING: ReadonlySet<string> = new Set(['"', '”', '’', "'", ')', ']', '»']);
/** Read 3's list marks (a run of `#` too), only at a line start that counts. */
const LIST_MARKS: ReadonlySet<string> = new Set(['-', '*', '•', '◦', '▪', '‣', '·', '–', '—', '|']);
const CAPITAL = /^[\p{Lu}\p{Lt}]$/u;

const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t';
const isCapital = (c: string | undefined): boolean => c !== undefined && CAPITAL.test(c);
/** A capital letter or an opening mark: what a sentence may begin with after a full stop. */
const isSentenceOpening = (c: string | undefined): boolean =>
  isCapital(c) || (c !== undefined && START_OPENING.has(c));

function blanksBack(source: string, at: number): number {
  let i = at;
  while (i > 0 && isBlank(source[i - 1])) i--;
  return i;
}

/** Read 2: the start of one clause number that ends at `at`, or -1. A clause number is digits joined
 *  by `.` with at least one joiner (`6.2`, `3.4.1`), digits closed by `.` or `)` (`12.`, `12)`), or a
 *  bracketed group of 1–4 letters or digits (`(a)`, `(iv)`). Never bare digits (`12`, `2`). */
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
  let closed = false;
  if ((source[j - 1] === '.' || source[j - 1] === ')') && isDigit(source[j - 2])) {
    j--;
    closed = true;
  }
  if (!isDigit(source[j - 1])) return -1;
  let dotted = false;
  for (;;) {
    while (isDigit(source[j - 1])) j--;
    if (source[j - 1] === '.' && isDigit(source[j - 2])) {
      j--;
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
  let j = start;
  if (!isDigit(source[j])) return false;
  let dotted = false;
  for (;;) {
    while (isDigit(source[j])) j++;
    if (source[j] === '.' && isDigit(source[j + 1])) {
      j++;
      dotted = true;
      continue;
    }
    break;
  }
  let closed = false;
  if (source[j] === '.' || source[j] === ')') {
    j++;
    closed = true;
  }
  if ((!dotted && !closed) || !isBlank(source[j])) return false;
  while (isBlank(source[j])) j++;
  return isSentenceOpening(source[j]);
}

/** Read 3: the start of one list mark (or a run of `#`) that ends at `at`, or -1. */
function listMarkBack(source: string, at: number): number {
  if (source[at - 1] === '#') {
    let j = at - 1;
    while (j > 0 && source[j - 1] === '#') j--;
    return j;
  }
  return at > 0 && LIST_MARKS.has(source[at - 1]!) ? at - 1 : -1;
}

/** How the line break at `lineBreak` counts as a line start: `free` when the line before it is blank,
 *  or ends (past spaces, `\r` and closing marks) with `;`, `:` or `|` (a table row's end);
 *  `sentence` when it ends with `.` `!` `?` under L1's test (read 1's capital condition then
 *  applies); `undefined` when it does not count. What the new line opens with never exempts it. */
function lineStart(source: string, lineBreak: number): 'free' | 'sentence' | undefined {
  let i = lineBreak;
  while (i > 0 && (isBlank(source[i - 1]) || source[i - 1] === '\r')) i--;
  if (i === 0 || LINE_BREAKS.has(source[i - 1]!)) return 'free';
  while (i > 0 && START_CLOSING.has(source[i - 1]!)) i--;
  const c = source[i - 1];
  if (c === ';' || c === ':' || c === '|') return 'free';
  if ((c === '.' && !endsAbbreviation(source, i - 1)) || c === '!' || c === '?') return 'sentence';
  return undefined;
}

/** Reads 2 and 3: past spaces and tabs, `at` is the source's start or a line start that counts. */
function atCountedLineStart(source: string, at: number): boolean {
  const i = blanksBack(source, at);
  if (i === 0) return true;
  return LINE_BREAKS.has(source[i - 1]!) && lineStart(source, i - 1) !== undefined;
}

/** Read 1's accepted character before `at`, past spaces, tabs and closing marks: the source's start;
 *  `;`; a `:` not between two digits; a line break that counts; a `.` `!` `?` that ends a sentence
 *  (L1's test for `.`) only when `opening` (the part, or its opening mark, begins with a capital
 *  letter or an opening mark). At a line break that counts only because the line before ends a
 *  sentence, the same capital condition holds, or `numbered` (the part opens with a clause number
 *  and a capital). */
function acceptedBefore(source: string, at: number, opening: boolean, numbered: boolean): boolean {
  let i = blanksBack(source, at);
  while (i > 0 && START_CLOSING.has(source[i - 1]!)) i--;
  if (i === 0) return true;
  const c = source[i - 1]!;
  if (LINE_BREAKS.has(c)) {
    const kind = lineStart(source, i - 1);
    return kind === 'free' || (kind === 'sentence' && (opening || numbered));
  }
  if (c === ';') return true;
  if (c === ':') return !(isNum(source[i - 2]) && isNum(source[i]));
  if (c === '.') return opening && !endsAbbreviation(source, i - 1);
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
 * 3. A list mark, then spaces, then an optional opening mark and spaces, right before the part,
 *    sitting at a line start that counts.
 */
function partStartHolds(source: string, start: number): boolean {
  const first = blanksBack(source, start);
  const opening = isSentenceOpening(source[start]);
  const numbered = opensWithClauseNumber(source, start);
  // Where the part's own opening mark (and the spaces before it) ends, when it has one.
  const beforeMark =
    first > 0 && START_OPENING.has(source[first - 1]!) ? blanksBack(source, first - 1) : -1;
  // Read 1.
  if (acceptedBefore(source, first, opening, numbered)) return true;
  if (beforeMark >= 0 && acceptedBefore(source, beforeMark, true, numbered)) return true;
  // Reads 2 and 3, the label ending right before the part, or before its opening mark.
  for (const end of beforeMark >= 0 ? [first, beforeMark] : [first]) {
    const after = end === first ? source[start] : source[first - 1];
    if (isSentenceOpening(after)) {
      const label = clauseNumberBack(source, end);
      if (label >= 0 && atCountedLineStart(source, label)) return true;
    }
    const mark = listMarkBack(source, end);
    if (mark >= 0 && atCountedLineStart(source, mark)) return true;
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
  source: Bare,
  segments: readonly Segment[],
  inOrder: boolean,
  startHolds: (at: number) => boolean,
): Part[] | undefined {
  const hay = source.text;
  const parts: Part[] = [];
  let after = 0;
  for (let k = 0; k < segments.length;) {
    const piece = segments[k]!.canonical.text;
    let best: Part | undefined;
    for (let at = budget.indexOf(hay, piece, inOrder ? after : 0); at >= 0;) {
      if (
        wordEdgesHold(hay, at, piece) &&
        numberEdgesHold(hay, at, piece) &&
        marksHold(source, at, segments[k]!.marks) &&
        (k === 0 || startHolds(at))
      ) {
        const part = extend(budget, source, segments, k, at);
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
      countWithEdges(budget, canonical, canonicalQuote, quoteCanonical.marks),
    );
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
    (at) => marksHold(canonical, at, quoteCanonical.marks),
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
      occurrences: countWithEdges(budget, canonical, canonicalQuote, quoteCanonical.marks),
      ...cutShort(cut),
    };
  }

  if (segments.length > 1) {
    const startHolds = (at: number): boolean => partStartHolds(source, canonical.from[at]!);
    const inOrder = placeParts(budget, canonical, segments, true, startHolds);
    const parts =
      inOrder !== undefined && inOrder.every((p) => p.end - p.at >= minPartChars)
        ? inOrder
        : placeParts(budget, canonical, segments, false, startHolds);
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
