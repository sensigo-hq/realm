// Tests for the shared quote-aware comparison splitter (Change 1a).
import { describe, it, expect } from 'vitest';
import { splitComparison, isPathShaped, splitOnUnquotedDelimiter } from './comparison-expr.js';

describe('splitComparison', () => {
  it('splits a simple comparison', () => {
    expect(splitComparison('a.b == 1')).toEqual({
      kind: 'comparison',
      lhsPath: 'a.b',
      op: '==',
      rhsRaw: '1',
    });
  });

  it('handles all six operators (2-char before 1-char)', () => {
    expect(splitComparison('x >= 1')).toMatchObject({ op: '>=' });
    expect(splitComparison('x <= 1')).toMatchObject({ op: '<=' });
    expect(splitComparison('x != 1')).toMatchObject({ op: '!=' });
    expect(splitComparison('x == 1')).toMatchObject({ op: '==' });
    expect(splitComparison('x > 1')).toMatchObject({ op: '>' });
    expect(splitComparison('x < 1')).toMatchObject({ op: '<' });
  });

  it('is quote-aware: an operator inside the quoted RHS does not mis-split', () => {
    // The first UNQUOTED operator is `==`; `>=` lives inside the quotes → part of the RHS.
    expect(splitComparison("subject == 'a >= b'")).toEqual({
      kind: 'comparison',
      lhsPath: 'subject',
      op: '==',
      rhsRaw: "'a >= b'",
    });
  });

  it('is quote-aware for double quotes too', () => {
    expect(splitComparison('subject != "x == y"')).toEqual({
      kind: 'comparison',
      lhsPath: 'subject',
      op: '!=',
      rhsRaw: '"x == y"',
    });
  });

  it('a bare path → kind path', () => {
    expect(splitComparison('flags.enabled')).toEqual({ kind: 'path', path: 'flags.enabled' });
  });

  it('compound `and` (unquoted) → invalid with split parts', () => {
    const r = splitComparison('a.x == true and b.y != null');
    expect(r).toMatchObject({ kind: 'invalid', reason: 'compound_and' });
    if (r.kind === 'invalid') expect(r.parts).toEqual(['a.x == true', 'b.y != null']);
  });

  it('compound `or` (unquoted) → invalid', () => {
    expect(splitComparison('a == 1 or b == 2')).toMatchObject({
      kind: 'invalid',
      reason: 'compound_or',
    });
  });

  it('`and` INSIDE quotes is not a compound', () => {
    expect(splitComparison("subject == 'cats and dogs'")).toEqual({
      kind: 'comparison',
      lhsPath: 'subject',
      op: '==',
      rhsRaw: "'cats and dogs'",
    });
  });

  it('multiple comparison operators → invalid', () => {
    expect(splitComparison('a == b == c')).toMatchObject({
      kind: 'invalid',
      reason: 'multiple_operators',
    });
  });

  it('empty → invalid', () => {
    expect(splitComparison('   ')).toMatchObject({ kind: 'invalid', reason: 'empty' });
  });

  it('negative-number RHS is not mistaken for an operator', () => {
    expect(splitComparison('score < -5')).toEqual({
      kind: 'comparison',
      lhsPath: 'score',
      op: '<',
      rhsRaw: '-5',
    });
  });

  it('never throws on weird input', () => {
    expect(() => splitComparison('=='.repeat(50))).not.toThrow();
    expect(() => splitComparison("'unterminated")).not.toThrow();
  });
});

describe('isPathShaped', () => {
  it('accepts dot-paths and run.params', () => {
    expect(isPathShaped('step.field')).toBe(true);
    expect(isPathShaped('run.params.mode')).toBe(true);
    expect(isPathShaped('a_b-c.d')).toBe(true);
  });
  it('rejects spaces, operators, quotes, leading digits/dots', () => {
    expect(isPathShaped('a b')).toBe(false);
    expect(isPathShaped('a == b')).toBe(false);
    expect(isPathShaped("'x'")).toBe(false);
    expect(isPathShaped('.a')).toBe(false);
    expect(isPathShaped('')).toBe(false);
  });
});

describe('splitOnUnquotedDelimiter (moved from render-template)', () => {
  it('splits on unquoted delimiter only', () => {
    expect(splitOnUnquotedDelimiter('a|b|c', '|')).toEqual(['a', 'b', 'c']);
    expect(splitOnUnquotedDelimiter("a|'b|c'|d", '|')).toEqual(['a', "'b|c'", 'd']);
  });
});
