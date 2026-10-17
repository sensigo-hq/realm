/**
 * locateQuote — whether, and how, a quote appears in a source text (issue #760; design D2, D3, D6).
 *
 * The ONE implementation of the quote ladder and of the canonical form; the `check_quotes` handler
 * calls it and composes nothing of its own. It never judges whether a value is correct — only
 * whether, and how, its quote is in the source.
 *
 * The ladder, first hit wins:
 * - `exact`: the quote is a literal substring of the source.
 * - `reformatted`: the quote's canonical form is a substring of the source's canonical form.
 * - `stitched`: the quote's parts — split on `…` / `...` when it has one, else cut into tiles, each
 *   the longest canonical prefix found anywhere — are each at least `minPartChars` canonical
 *   characters and found in order, each at its earliest occurrence after the previous part's end.
 * - `stitched_out_of_order`: every part is long enough and found somewhere, but not in order.
 * - `not_found`: otherwise; `nearest` is the longest tile found in the source, when there is one.
 * (`unquoted` is the handler's, for a candidate with no quote and no value; this never returns it.)
 *
 * Every offset is a UTF-16 code-unit offset into the ORIGINAL source.
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
  /** For `not_found` only: the longest piece of the quote that IS in the source. */
  readonly nearest?: QuoteSpan;
}

/** The shortest part a stitch may rest on, in canonical characters (Eve's floor). */
export const DEFAULT_MIN_PART_CHARS = 20;
/** The least `minPartChars` a caller may ask for. */
export const MIN_PART_CHARS_LEAST = 4;

const DASHES: ReadonlySet<string> = new Set(['–', '—', '−']); // – — −
const KEPT_SYMBOLS: ReadonlySet<string> = new Set(['%', '‰', '°']); // % ‰ °
const LETTER = /^\p{L}$/u;
const DIGIT = /^\p{Nd}$/u;
const SPACE = /^\s$/u;
const CURRENCY = /^\p{Sc}$/u;
const MARK = /^\p{M}$/u;
const MARKER = /…|\.{3,}/u;

const isLetter = (c: string | undefined): boolean => c !== undefined && LETTER.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && DIGIT.test(c);

/** A text in canonical form, and for each canonical character the original span it came from. */
interface Canonical {
  readonly text: string;
  readonly from: readonly number[];
  readonly to: readonly number[];
}

/**
 * The canonical form (design D3). NFKC (ligatures and full-width digits come from PDFs), then
 * lower case (`toLowerCase`, never the locale's), then the dashes `–` `—` `−` as `-`. Letters
 * (`\p{L}`) and digits (`\p{Nd}`) are kept; every other punctuation mark, quotation mark and
 * apostrophe is dropped, and whitespace runs become one space after the drops — EXCEPT that digits,
 * their separators and their symbols are load-bearing: (i) a run of separators BETWEEN two digits
 * is kept as itself (`9.1` ≠ `91`, `2,000` ≠ `2.000`, `1.5` ≠ `1 5`); (ii) a `-` directly before a
 * digit is kept (`-5` ≠ `5`); (iii) `%`, `‰`, `°` and every currency symbol are kept (`5%` ≠ `5`,
 * `$1,200` ≠ `£1,200`). Each base character is normalised together with the combining marks that
 * follow it, so every canonical character maps back to one span of the original.
 */
function canonicalize(text: string): Canonical {
  const chars: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  while (i < text.length) {
    let j = i + codePointLength(text, i);
    while (j < text.length && MARK.test(String.fromCodePoint(text.codePointAt(j)!))) {
      j += codePointLength(text, j);
    }
    for (const ch of text.slice(i, j).normalize('NFKC').toLowerCase()) {
      chars.push(DASHES.has(ch) ? '-' : ch);
      from.push(i);
      to.push(j);
    }
    i = j;
  }

  const kind: Array<'keep' | 'space' | 'drop'> = chars.map((c) =>
    isLetter(c) || isDigit(c) || KEPT_SYMBOLS.has(c) || CURRENCY.test(c)
      ? 'keep'
      : SPACE.test(c)
        ? 'space'
        : 'drop',
  );
  // (i) a run of non-letter, non-digit characters between two digits is kept as itself.
  for (let k = 0; k < chars.length;) {
    if (!isDigit(chars[k])) {
      k++;
      continue;
    }
    let r = k + 1;
    while (r < chars.length && !isLetter(chars[r]) && !isDigit(chars[r])) r++;
    if (r > k + 1 && isDigit(chars[r])) {
      for (let t = k + 1; t < r; t++) if (kind[t] === 'drop') kind[t] = 'keep';
    }
    k = r;
  }
  // (ii) a `-` directly before a digit is kept.
  for (let k = 0; k + 1 < chars.length; k++) {
    if (chars[k] === '-' && isDigit(chars[k + 1])) kind[k] = 'keep';
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

/** One cached source: a handler checks many quotes against one document. */
let lastSource: string | undefined;
let lastCanonical: Canonical | undefined;
function canonicalSource(source: string): Canonical {
  if (lastSource !== source || lastCanonical === undefined) {
    lastCanonical = canonicalize(source);
    lastSource = source;
  }
  return lastCanonical;
}

/**
 * The edge rule (design D3): at a matched span's edges, a quote digit never touches a source letter
 * or digit, and a quote letter never touches a source digit (`9,20` ⊄ `9,200`; `clause 9` ⊄
 * `clause 9a`; `Schedule 2` ⊄ `Schedule 2A`).
 */
function edgesHold(haystack: string, at: number, needle: string): boolean {
  const clashes = (inQuote: string | undefined, beside: string | undefined): boolean =>
    beside !== undefined &&
    ((isDigit(inQuote) && (isDigit(beside) || isLetter(beside))) ||
      (isLetter(inQuote) && isDigit(beside)));
  const before = at > 0 ? haystack[at - 1] : undefined;
  const after = haystack[at + needle.length];
  return !clashes(needle[0], before) && !clashes(needle[needle.length - 1], after);
}

/** The first occurrence at or after `fromIndex` whose edges hold, or -1. */
function findWithEdges(haystack: string, needle: string, fromIndex: number): number {
  if (needle === '') return -1;
  let at = haystack.indexOf(needle, fromIndex);
  while (at >= 0 && !edgesHold(haystack, at, needle)) at = haystack.indexOf(needle, at + 1);
  return at;
}

/** Non-overlapping occurrences whose edges hold. */
function countWithEdges(haystack: string, needle: string): number {
  let count = 0;
  for (let at = findWithEdges(haystack, needle, 0); at >= 0;) {
    count++;
    at = findWithEdges(haystack, needle, at + needle.length);
  }
  return count;
}

function spanOf(canonical: Canonical, at: number, length: number): QuoteSpan {
  return { start: canonical.from[at]!, end: canonical.to[at + length - 1]! };
}

/** The start of the digit run that `end` would split, so a cut never falls inside one. */
function retreatFromDigitRun(quote: string, start: number, end: number): number {
  if (end <= start || end >= quote.length) return end;
  if (!isDigit(quote[end - 1]) || !isDigit(quote[end])) return end;
  let s = end - 1;
  while (s > start && isDigit(quote[s - 1])) s--;
  return s;
}

interface Tile {
  readonly text: string;
  /** The earliest occurrence in the canonical source whose edges hold, or -1. */
  readonly at: number;
}

/**
 * Cuts the canonical quote into tiles: from where the quote continues, the longest prefix found
 * anywhere in the canonical source. Being found is monotone in the prefix's length, so the length
 * is found by binary search (log m searches per tile). A cut never splits a digit run, and a tile
 * found only where its edges clash is shortened until it is found with its edges holding. A
 * position where nothing is found yields an unfound tile of one character, or of one whole digit
 * run.
 */
function tilesOf(quote: string, source: string): Tile[] {
  const tiles: Tile[] = [];
  let i = 0;
  while (i < quote.length) {
    if (quote[i] === ' ') {
      i++;
      continue;
    }
    let lo = 0;
    let hi = quote.length - i;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (source.includes(quote.slice(i, i + mid))) lo = mid;
      else hi = mid - 1;
    }
    let end = retreatFromDigitRun(quote, i, i + lo);
    let at = -1;
    while (end > i) {
      const text = quote.slice(i, end).trimEnd();
      at = findWithEdges(source, text, 0);
      if (at >= 0) break;
      end = retreatFromDigitRun(quote, i, end - 1);
    }
    if (end <= i) {
      let unfoundEnd = i + 1;
      if (isDigit(quote[i])) while (isDigit(quote[unfoundEnd])) unfoundEnd++;
      tiles.push({ text: quote.slice(i, unfoundEnd), at: -1 });
      i = unfoundEnd;
      continue;
    }
    tiles.push({ text: quote.slice(i, end).trimEnd(), at });
    i = end;
  }
  return tiles;
}

/**
 * Locates `quote` in `source` (the ladder above). `minPartChars` (default 20, at least 4) is the
 * floor every stitched part must reach, in canonical characters — marked parts, tiles and the last
 * remainder alike. An empty source, an empty quote, or a quote with no letter or digit is
 * `not_found` with no parts.
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
  const canonicalQuote = canonicalize(quote).text;
  if (canonicalQuote === '' || source === '') return notFound;
  const canonical = canonicalSource(source);

  const literal = findWithEdges(source, quote, 0);
  if (literal >= 0) {
    // The whole quote occurs at least once (the literal match), whatever the canonical count says.
    const occurrences = Math.max(1, countWithEdges(canonical.text, canonicalQuote));
    return {
      state: 'exact',
      parts: [{ start: literal, end: literal + quote.length }],
      occurrences,
    };
  }

  const whole = findWithEdges(canonical.text, canonicalQuote, 0);
  if (whole >= 0) {
    return {
      state: 'reformatted',
      parts: [spanOf(canonical, whole, canonicalQuote.length)],
      occurrences: countWithEdges(canonical.text, canonicalQuote),
    };
  }

  const tiles = tilesOf(canonicalQuote, canonical.text);
  const parts: Tile[] = MARKER.test(quote)
    ? quote
        .split(MARKER)
        .map((piece) => canonicalize(piece).text)
        .filter((text) => text !== '')
        .map((text) => ({ text, at: findWithEdges(canonical.text, text, 0) }))
    : tiles;

  if (parts.length > 0 && parts.every((p) => p.text.length >= minPartChars && p.at >= 0)) {
    const inOrder: QuoteSpan[] = [];
    let after = 0;
    for (const part of parts) {
      const at = findWithEdges(canonical.text, part.text, after);
      if (at < 0) break;
      inOrder.push(spanOf(canonical, at, part.text.length));
      after = at + part.text.length;
    }
    if (inOrder.length === parts.length)
      return { state: 'stitched', parts: inOrder, occurrences: 0 };
    return {
      state: 'stitched_out_of_order',
      parts: parts.map((p) => spanOf(canonical, p.at, p.text.length)),
      occurrences: 0,
    };
  }

  let nearest: Tile | undefined;
  for (const t of tiles) {
    if (t.at >= 0 && (nearest === undefined || t.text.length > nearest.text.length)) nearest = t;
  }
  return nearest === undefined
    ? notFound
    : { ...notFound, nearest: spanOf(canonical, nearest.at, nearest.text.length) };
}
