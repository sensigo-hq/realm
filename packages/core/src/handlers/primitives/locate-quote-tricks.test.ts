// locate-quote-tricks.test.ts — the permanent test set of crafted tricks (issue #760, correction 3,
// the owner's "with the test set", 2026-10-18).
//
// The owner's bar for "done": the check catches the mistakes real models make, measured on the
// pilots; a trick built on purpose and found after correction 3 is filed and fixed in a follow-up,
// never a merge blocker; and every trick found so far stays here, each asserted, so none can come
// back. The rows are DERIVED from the reviews' classified files (`plans/issue-760/review/testset-c3/`,
// by `plans/issue-760/correction-3-ia/derive-testset.mjs`), never typed by hand. Every quote is
// fictional and runs against the fictional lease (`fixtures/lease-public.txt`), its word-wrapped
// copies, or a short constructed document held in its row.
//
// - T1: every trick found so far, each `not_found`.
// - T2: rows pinned at their present state, each with why it reads found — not tricks the check is
//   meant to refuse; they make a change in that behaviour visible (the docs' "what the check does not
//   catch" names them).
// - T3: the walks' attempts refused since be982455, each `not_found` (a regression guard; some fooled
//   the first build, 8801569d).
//
// What a failing cell prints: the row's id and its state, never a span of the source.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { locateQuote, type QuoteCheck } from './locate-quote.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
const LEASE = fixture('lease-public.txt');

/** The reviews' word-greedy wrap: existing line breaks kept, each line filled with whole words (split
 *  on one space) up to `width` columns. */
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

interface Row {
  readonly group: string;
  readonly id: string;
  readonly quote: string;
  readonly source: { readonly fixture?: true; readonly wrap?: number; readonly doc?: string };
  readonly expect: QuoteCheck['state'];
  readonly why?: string;
  readonly cut_short?: boolean;
}
const SET = JSON.parse(fixture('quote-tricks.json')) as { T1: Row[]; T2: Row[]; T3: Row[] };
const sourceOf = (row: Row): string =>
  row.source.fixture === true
    ? LEASE
    : row.source.wrap !== undefined
      ? wrapAt(LEASE, row.source.wrap)
      : row.source.doc!;

describe('the permanent test set, T1: every trick found so far is not_found', () => {
  it('holds the derived rows: 185 distinct named rows (195 named, 10 exact repeats dropped)', () => {
    // (a) red when a row is lost or added without its derivation; (b) prints the count.
    expect(SET.T1.length).toBe(185);
  });
  for (const row of SET.T1) {
    it(`T1 ${row.group} ${row.id} → not_found`, () => {
      // (a) red when the rule that refuses this trick is removed; (b) prints the state.
      expect(locateQuote(row.quote, sourceOf(row)).state).toBe('not_found');
    });
  }
});

describe('the permanent test set, T1: the drop-number quotes at wrapped line starts (generated)', () => {
  /** The reviews' generator, word for word: at widths 60–80, a line whose line before is not empty
   *  and does not end a sentence or clause, opening with a number or a bracketed label; the quote is
   *  the last 8 words of the line before, the joiner, and the first 8 words after the number. */
  const generated = (joiner: string): Array<[number, string]> => {
    const out: Array<[number, string]> = [];
    for (const width of [60, 65, 70, 72, 75, 80]) {
      const lines = wrapAt(LEASE, width).split('\n');
      for (let i = 1; i < lines.length; i++) {
        const before = lines[i - 1]!.trimEnd();
        if (before === '' || /[.!?;:]["”’')\]»]*$/.test(before)) continue;
        const m = /^(\(?[0-9]+(?:\.[0-9]+)*[.)]?|\([A-Za-z0-9]{1,4}\))\s+(\S.*)$/.exec(lines[i]!);
        if (m === null) continue;
        out.push([
          width,
          `${before.split(' ').slice(-8).join(' ')}${joiner}${m[2]!.split(' ').slice(0, 8).join(' ')}`,
        ]);
      }
    }
    return out;
  };
  for (const [mode, joiner] of [
    ['a line break', '\n'],
    ['` … `', ' … '],
  ] as const) {
    it(`joined with ${mode}: the generator finds exactly 11, and each is not_found`, () => {
      const rows = generated(joiner);
      const found = rows.filter(
        ([width, quote]) => locateQuote(quote, wrapAt(LEASE, width)).state !== 'not_found',
      );
      // (a) red when the generator's instrument drifts (not 11), or a skip lands just past a number
      //     at a wrapped line start; (b) prints the count and how many read found.
      expect({ count: rows.length, found: found.length }).toEqual({ count: 11, found: 0 });
    });
  }
});

describe('the permanent test set, T2: rows pinned at their present state, each with why', () => {
  for (const row of SET.T2) {
    it(`T2 ${row.group} ${row.id} → ${row.expect}${row.cut_short === true ? ', cut_short' : ''}: ${row.why}`, () => {
      const check = locateQuote(row.quote, sourceOf(row));
      // (a) red when this behaviour changes (a gap closed, or a true quote no longer found); (b)
      //     prints the state and the label.
      expect([check.state, check.cut_short === true]).toEqual([row.expect, row.cut_short === true]);
    });
  }
});

describe('the permanent test set, T3: the walks’ attempts refused since be982455', () => {
  for (const row of SET.T3) {
    it(`T3 ${row.id} → not_found`, () => {
      // (a) red when an attempt refused since be982455 reads found again; (b) prints the state.
      expect(locateQuote(row.quote, sourceOf(row)).state).toBe('not_found');
    });
  }
});
