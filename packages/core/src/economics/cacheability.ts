// cacheability.ts — issue #600 caching PR 5 (C1): at admission, from a workflow definition alone, how
// big each agent step's fixed part is, which steps share it and where they part, and — when a floor
// is given — whether it is long enough to be cached at all. Pure: no I/O, no provider name, no model
// table. The host (the CLI) describes each provider's request layout as blocks and segments and says
// what it adds; core does the arithmetic and the comparison.
//
// The token count is an INTERVAL, never one number, and the verdict is given only when every whole
// token count in it is on one side of the floor:
// - by default `lo = chars / 5` and `hi = asciiChars / 2.5 + nonAsciiCodeUnits` (the two constants
//   below). They were set by a measurement (PR5M-02, 2026-10-27): realm's own bytes ran 2.60–4.83
//   chars/token over the 19 example agent steps on claude-sonnet-4-6 and claude-sonnet-5-5, and
//   OpenAI's tokenizer 3.88–4.67 on repository files. Text outside ASCII can run near one token a
//   character, so the upper bound counts each such UTF-16 code unit as a token (an approximation, not
//   a strict bound); the lower bound needs no such term: more tokens per character only raises the
//   true count;
// - with an author's `ratio` r (their own count of one step), taken as ±15% on characters per token:
//   `lo = chars / (r × 1.15)`, `hi = chars / (r × 0.85)`;
// - plus, when the host gives one, a step's `extraTokens` band (text the provider adds that counts
//   toward its minimum — the host passes it only where it is measured, and never with a ratio, which
//   already counts it).
// The printed interval is `[ceil(lo), floor(hi)]`: exactly the whole token counts in `[lo, hi]`.
// So `below_floor` iff `floor(hi) < F`, `above_floor` iff `ceil(lo) ≥ F`, else `near_floor`. This
// differs from a real-number reading only when `lo` falls in `(F − 1, F)`: at 5,116 chars and a
// floor of 1,024, `lo` is 1,023.2, so every whole count in the interval is at least 1,024 — above.

/** A named piece of a block's text, `[start, end)` in that text. */
export interface CacheBlockSegment {
  name: string;
  start: number;
  end: number;
}

/** One part of a request in wire order: a stable block is the same on every call of its step. */
export interface CacheBlock {
  name: string;
  text: string;
  stable: boolean;
  segments: CacheBlockSegment[];
}

/** The default characters per token at the low end of the token count (`lo = chars / 5`). */
export const DEFAULT_CHARS_PER_TOKEN_HIGH = 5;
/** The default characters per token at the high end of the token count (`hi = asciiChars / 2.5 + …`). */
export const DEFAULT_CHARS_PER_TOKEN_LOW = 2.5;
/** An author's `--ratio` r is taken as ±15% on characters per token: the low end of the token count
 *  divides by `r × 1.15`, the high end by `r × 0.85`. */
const RATIO_PLUS = 1.15;
const RATIO_MINUS = 0.85;
/** Floating-point slack for the rounding: `chars / (r × 1.15)` can land a hair off a whole number. */
const EPSILON = 1e-9;

export type CacheVerdict = 'below_floor' | 'above_floor' | 'near_floor' | 'not_judged';

/** Why a layout carries no verdict (the host's decision table names all but `near_floor`). */
export type CacheNotJudgedCause =
  | 'no_model'
  | 'tools_step'
  | 'no_economics_file'
  | 'economics_not_checked'
  | 'economics_unreachable'
  | 'economics_unreadable'
  | 'model_unknown'
  | 'no_minimum_stated'
  | 'near_floor'
  | 'profile_unavailable';

/** One step's blocks on one layout, and the tokens the host adds to its count. */
export interface CacheabilityStepInput {
  step: string;
  blocks: CacheBlock[];
  extraTokens?: { low: number; high: number };
}

export interface CacheabilityOptions {
  /** The minimum to judge against. Without it, no verdict is given. */
  floor?: { tokens: number };
  /** The author's characters per token, in place of the default range. */
  ratio?: { chars_per_token: number };
}

/** Another step whose fixed part begins the same way: `chars` shared, and the segment they part in. */
export interface CacheShare {
  step: string;
  chars: number;
  /** The token range of the shared start. For a whole shared fixed part (`divergence_at` `null`) it
   *  is the step's own `prefix.tokens`, host extra tokens included (caching PR 5 correction 2, F-2);
   *  for a partial start, `cacheTokenInterval` of its first `chars` characters, with the same `ratio`
   *  and no host extra tokens (correction 1, C-7). */
  tokens: { low: number; high: number };
  /** The segment the two texts part in; `null` when they are equal. */
  divergence_at: string | null;
}

export interface CacheabilityStep {
  step: string;
  prefix: {
    chars: number;
    tokens: { low: number; high: number };
    basis: 'default' | 'ratio';
  };
  /** Every other step whose fixed part shares at least one character, in input order. */
  shares_with: CacheShare[];
  verdict: CacheVerdict;
  not_judged_cause?: 'near_floor';
}

/** The token interval of `text`, as whole counts, with the host's extra tokens added. */
export function cacheTokenInterval(
  text: string,
  opts: { ratio?: { chars_per_token: number }; extraTokens?: { low: number; high: number } } = {},
): { low: number; high: number } {
  const chars = text.length;
  let lo: number;
  let hi: number;
  if (opts.ratio !== undefined) {
    lo = chars / (opts.ratio.chars_per_token * RATIO_PLUS);
    hi = chars / (opts.ratio.chars_per_token * RATIO_MINUS);
  } else {
    let ascii = 0;
    for (let i = 0; i < chars; i += 1) if (text.charCodeAt(i) < 0x80) ascii += 1;
    lo = chars / DEFAULT_CHARS_PER_TOKEN_HIGH;
    hi = ascii / DEFAULT_CHARS_PER_TOKEN_LOW + (chars - ascii);
  }
  if (opts.extraTokens !== undefined) {
    lo += opts.extraTokens.low;
    hi += opts.extraTokens.high;
  }
  return { low: Math.ceil(lo - EPSILON), high: Math.floor(hi + EPSILON) };
}

/** The verdict of a whole-count interval against a floor. */
export function cacheVerdict(
  tokens: { low: number; high: number },
  floor: number,
): 'below_floor' | 'above_floor' | 'near_floor' {
  if (tokens.high < floor) return 'below_floor';
  if (tokens.low >= floor) return 'above_floor';
  return 'near_floor';
}

/** The concatenated text of a step's stable blocks, with every segment placed in it. */
function stableText(blocks: CacheBlock[]): { text: string; segments: CacheBlockSegment[] } {
  let text = '';
  const segments: CacheBlockSegment[] = [];
  for (const block of blocks) {
    if (!block.stable) continue;
    const offset = text.length;
    for (const s of block.segments) {
      segments.push({ name: s.name, start: offset + s.start, end: offset + s.end });
    }
    text += block.text;
  }
  return { text, segments };
}

/** The segment holding character `at`, or `null` (past the end, or in no named segment). */
function segmentAt(segments: CacheBlockSegment[], at: number): string | null {
  for (const s of segments) if (at >= s.start && at < s.end) return s.name;
  return null;
}

/**
 * Where two texts that share their first `p` characters part. Read from both sides: the same
 * segment on both is that segment; a strict flag on either side is the strict flag (the other side's
 * closing characters belong to no segment); one side ended (or in no segment) is the other's.
 */
function divergenceAt(
  a: { text: string; segments: CacheBlockSegment[] },
  b: { text: string; segments: CacheBlockSegment[] },
  p: number,
): string | null {
  if (p === a.text.length && p === b.text.length) return null;
  const sa = segmentAt(a.segments, p);
  const sb = segmentAt(b.segments, p);
  if (sa === sb) return sa;
  if (sa === 'tool_strict' || sb === 'tool_strict') return 'tool_strict';
  return sa ?? sb;
}

/** The length of the longest common prefix of two strings. */
function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/**
 * Describes each step's fixed part on one layout: its size, its token interval, the steps it shares
 * a beginning with, and — when a floor is given — its verdict. A step with no stable block gets size
 * 0 and shares nothing. The print filter and the grouping of the sharing are the host's.
 */
export function describeCacheability(
  steps: CacheabilityStepInput[],
  opts: CacheabilityOptions = {},
): CacheabilityStep[] {
  const texts = steps.map((s) => stableText(s.blocks));
  return steps.map((s, i) => {
    const own = texts[i]!;
    const tokens = cacheTokenInterval(own.text, {
      ...(opts.ratio !== undefined ? { ratio: opts.ratio } : {}),
      ...(s.extraTokens !== undefined ? { extraTokens: s.extraTokens } : {}),
    });
    const shares: CacheShare[] = [];
    if (own.text.length > 0) {
      steps.forEach((other, j) => {
        if (j === i) return;
        const theirs = texts[j]!;
        if (theirs.text.length === 0) return;
        const p = commonPrefix(own.text, theirs.text);
        if (p === 0) return;
        const divergence = divergenceAt(own, theirs, p);
        shares.push({
          step: other.step,
          chars: p,
          // A whole shared fixed part IS the step's fixed part: the same interval, band included.
          tokens:
            divergence === null
              ? { ...tokens }
              : cacheTokenInterval(
                  own.text.slice(0, p),
                  opts.ratio !== undefined ? { ratio: opts.ratio } : {},
                ),
          divergence_at: divergence,
        });
      });
    }
    const verdict = opts.floor !== undefined ? cacheVerdict(tokens, opts.floor.tokens) : undefined;
    return {
      step: s.step,
      prefix: {
        chars: own.text.length,
        tokens,
        basis: opts.ratio !== undefined ? 'ratio' : 'default',
      },
      shares_with: shares,
      verdict: verdict ?? 'not_judged',
      ...(verdict === 'near_floor' ? { not_judged_cause: 'near_floor' as const } : {}),
    };
  });
}
