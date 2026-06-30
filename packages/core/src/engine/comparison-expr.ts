// comparison-expr.ts — zero-dependency, quote-aware splitting for Realm's condition leaves.
//
// This module is the SINGLE source of truth for how a one-line condition leaf is split into a
// comparison, a bare path, or an "invalid" verdict. It is used by:
//   - load-time validation (yaml-loader) — to reject compound / malformed leaves with a loud error;
//   - runtime evaluation (evaluateWhenCondition, evaluateGuardConditions, evaluatePrecondition) — so
//     the split used to validate a leaf is the SAME split used to evaluate it (no validate/eval drift).
//
// It MUST stay zero-dependency (no import from render-template/eligibility/precondition) to avoid an
// import cycle — those modules import FROM here.

/** The comparison operators Realm understands, longest tokens first for greedy matching. */
export type ComparisonOp = '==' | '!=' | '>=' | '<=' | '>' | '<';

export type ComparisonInvalidReason =
  | 'empty'
  | 'compound_and'
  | 'compound_or'
  | 'multiple_operators';

/** The result of splitting one condition leaf. Never thrown — malformed input returns `invalid`. */
export type ComparisonSplit =
  | { kind: 'comparison'; lhsPath: string; op: ComparisonOp; rhsRaw: string }
  | { kind: 'path'; path: string }
  | { kind: 'invalid'; reason: ComparisonInvalidReason; parts?: string[] };

/**
 * Splits `input` on every occurrence of single-character `delimiter` that is NOT inside a quoted
 * string. Single or double quotes both open/close quote state; the other quote type is ignored while
 * inside a quote. Returns raw substrings — no trimming, no quote stripping.
 *
 * (Moved here from render-template.ts so both template rendering and condition splitting share one
 * quote-aware primitive; render-template imports it from this module.)
 */
export function splitOnUnquotedDelimiter(input: string, delimiter: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of input) {
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === delimiter && !inSingle && !inDouble) {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/**
 * Returns `expr` with every character inside a quoted region (and the quote chars themselves)
 * replaced by a space, preserving length so positions in the mask map 1:1 to the original. Used to
 * find operators/keywords while ignoring quoted content.
 */
function maskQuoted(expr: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of expr) {
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ' ';
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      out += ' ';
      continue;
    }
    out += inSingle || inDouble ? ' ' : ch;
  }
  return out;
}

const TWO_CHAR_OPS: ComparisonOp[] = ['>=', '<=', '==', '!='];

/** Find all unquoted comparison-operator occurrences in `mask` (2-char ops take precedence). */
function findOperators(mask: string): Array<{ pos: number; op: ComparisonOp; len: number }> {
  const found: Array<{ pos: number; op: ComparisonOp; len: number }> = [];
  let i = 0;
  while (i < mask.length) {
    const two = mask.slice(i, i + 2);
    if ((TWO_CHAR_OPS as string[]).includes(two)) {
      found.push({ pos: i, op: two as ComparisonOp, len: 2 });
      i += 2;
      continue;
    }
    const one = mask[i];
    if (one === '>' || one === '<') {
      found.push({ pos: i, op: one, len: 1 });
      i += 1;
      continue;
    }
    i += 1;
  }
  return found;
}

/** Split `expr` on an unquoted whitespace-delimited keyword (e.g. `and`), using the mask. */
function splitOnUnquotedKeyword(expr: string, mask: string, keyword: string): string[] {
  const re = new RegExp(`\\s${keyword}\\s`, 'g');
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mask)) !== null) {
    parts.push(expr.slice(last, m.index).trim());
    last = m.index + m[0].length;
  }
  parts.push(expr.slice(last).trim());
  return parts;
}

/**
 * Split one condition leaf, quote-aware, into a comparison `{ lhsPath, op, rhsRaw }`, a bare
 * `{ path }`, or `{ invalid, reason }`. Operator tokens and `and`/`or` keywords inside quoted
 * regions are ignored. Never throws.
 *
 * - `and`/`or` (unquoted) → `invalid` with `parts` (the split candidates, for an actionable error).
 * - exactly one unquoted operator → `comparison`.
 * - more than one → `invalid` (`multiple_operators`).
 * - none → `path` (a bare path; the caller validates its shape with {@link isPathShaped}).
 */
export function splitComparison(input: string): ComparisonSplit {
  const expr = input.trim();
  if (expr === '') return { kind: 'invalid', reason: 'empty' };

  const mask = maskQuoted(expr);

  // Boolean composition keywords take priority — they produce the most actionable error.
  if (/\sand\s/.test(mask)) {
    return {
      kind: 'invalid',
      reason: 'compound_and',
      parts: splitOnUnquotedKeyword(expr, mask, 'and'),
    };
  }
  if (/\sor\s/.test(mask)) {
    return {
      kind: 'invalid',
      reason: 'compound_or',
      parts: splitOnUnquotedKeyword(expr, mask, 'or'),
    };
  }

  const ops = findOperators(mask);
  if (ops.length === 0) return { kind: 'path', path: expr };
  if (ops.length > 1) return { kind: 'invalid', reason: 'multiple_operators' };

  const { pos, op, len } = ops[0]!;
  return {
    kind: 'comparison',
    lhsPath: expr.slice(0, pos).trim(),
    op,
    rhsRaw: expr.slice(pos + len).trim(),
  };
}

/**
 * True when `s` is a bare dot-path: starts with a letter/underscore and contains only word chars,
 * `.`, or `-` (no spaces, no operators). Used to reject a non-path LHS at load time.
 */
export function isPathShaped(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(s);
}
