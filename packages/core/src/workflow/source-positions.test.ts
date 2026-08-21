// source-positions.test.ts — issue #392: the position map, and the invariant that governs it.
//
// The invariant is absent-never-wrong. A missing line number costs an author a few seconds of
// scrolling; a WRONG one sends them to the wrong place with total confidence, because a machine
// printed it. So the cells below spend most of their attention on the shapes where a position
// COULD be guessed and must not be.
import { describe, it, expect } from 'vitest';
import { load } from 'js-yaml';
import { createSourcePositionCollector, emptySourcePositionMap } from './source-positions.js';
import type { SourcePositionMap } from './source-positions.js';

/** Parses `src` and returns the position map it produced. */
function mapOf(src: string): SourcePositionMap {
  const collector = createSourcePositionCollector();
  load(src, { listener: collector.listener });
  return collector.finish();
}

describe('source positions — the coordinates are exact and 1-based', () => {
  // Written WITHOUT a leading newline so the line numbers below are the numbers a reader counts.
  const SRC = `id: positions
name: Positions
version: 1
steps:
  step_one:
    description: First step
    execution: auto
    retry:
      max_attempts: 2
`;

  it('places a top-level key at line 1, column 1', () => {
    expect(mapOf(SRC).posOf(['id'])).toEqual({ line: 1, column: 1, endLine: 1, endColumn: 3 });
  });

  it('places a nested key at its own indentation, not its line start', () => {
    // The token-START nuance. The close event reports where a token ENDS, so a naive
    // implementation lands the column past the key. `execution` is indented four spaces, so its
    // column is 5 — one-based, pointing AT the 'e'.
    expect(mapOf(SRC).posOf(['steps', 'step_one', 'execution'])).toEqual({
      line: 7,
      column: 5,
      endLine: 7,
      endColumn: 14,
    });
    // And the line genuinely holds that key, so this cannot pass on an off-by-one that happens
    // to land on another key.
    expect(SRC.split('\n')[7 - 1]).toContain('execution:');
  });

  it('places a step key, and a key nested two levels deep', () => {
    const map = mapOf(SRC);
    expect(map.posOf(['steps', 'step_one'])).toEqual({
      line: 5,
      column: 3,
      endLine: 5,
      endColumn: 11,
    });
    expect(map.posOf(['steps', 'step_one', 'retry', 'max_attempts'])?.line).toBe(9);
  });

  it('returns undefined for a path that is not in the document', () => {
    const map = mapOf(SRC);
    expect(map.posOf(['nope'])).toBeUndefined();
    expect(map.posOf(['steps', 'step_two'])).toBeUndefined();
    expect(map.posOf(['steps', 'step_one', 'description', 'deeper'])).toBeUndefined();
  });

  it('the empty map resolves nothing — for callers with no source text', () => {
    expect(emptySourcePositionMap().posOf(['id'])).toBeUndefined();
  });
});

describe('source positions — a dotted path would ALIAS, so paths are segments', () => {
  // The one shape that produced a WRONG position rather than a missing one, which is the single
  // outcome this module exists to prevent. A step literally named `a.b`, and a step named `a`
  // carrying a field `b`, are different places in the file — and under a dotted path they were the
  // same string. Last write won, so asking for the step handed you the field's line: lawful YAML,
  // confidently wrong answer.
  //
  // Fixed by encoding, not by escaping. No separator character is safe — js-yaml will happily parse
  // a key containing a NUL — so the distinction has to live in the structure.
  const COLLIDING = `id: t
name: T
version: 1
steps:
  a.b:
    description: d1
    execution: agent
  a:
    description: d2
    execution: agent
    b: whatever
`;

  it('the step named "a.b" and the field "b" of step "a" resolve to their OWN lines', () => {
    const map = mapOf(COLLIDING);
    const step = map.posOf(['steps', 'a.b']);
    const field = map.posOf(['steps', 'a', 'b']);

    // Both asserted, both exact. Under a flattening mutant the two collapse to one key and one of
    // these two lines is wrong whichever order the document happens to be in — so the pair reds
    // regardless of which write wins.
    expect(step?.line).toBe(5);
    expect(field?.line).toBe(11);

    // Self-proving: the lines named really do hold what is claimed, so this cannot pass by
    // agreeing with numbers I counted wrong.
    expect(COLLIDING.split('\n')[5 - 1]).toContain('a.b:');
    expect(COLLIDING.split('\n')[11 - 1]).toContain('b: whatever');
  });
});

describe('source positions — the absent-never-wrong invariant', () => {
  it('a merge key makes the mapping unpairable, so the WHOLE mapping records nothing', () => {
    // `<<:` expands into the result object without a matching pair of key/value child events, so
    // the children no longer line up with the keys. Every key in this mapping is therefore
    // refused a position — including `execution`, which sits right there in the source and could
    // have been placed. That bluntness is the design: partial trust in a shape we cannot model is
    // how a wrong line number gets shipped.
    const src = `defaults: &d
  execution: auto
steps:
  step_one:
    <<: *d
    description: First
`;
    const map = mapOf(src);
    expect(map.posOf(['steps', 'step_one', 'description'])).toBeUndefined();
    expect(map.posOf(['steps', 'step_one', 'execution'])).toBeUndefined();
    // The mappings ABOVE the degenerate one are unaffected — the refusal is per-mapping, not
    // global, so one exotic step does not blind the whole file.
    expect(map.posOf(['steps', 'step_one'])).toEqual({
      line: 4,
      column: 3,
      endLine: 4,
      endColumn: 11,
    });
    expect(map.posOf(['defaults'])?.line).toBe(1);
  });

  it('a flow mapping still pairs correctly, and its keys are placed', () => {
    // Not every unusual shape is degenerate — flow mappings pair normally, so they get positions.
    // Asserted so the pairing rule is not quietly over-refusing.
    const src = `steps:
  step_one: { description: First, execution: auto }
`;
    const map = mapOf(src);
    expect(map.posOf(['steps', 'step_one', 'description'])?.line).toBe(2);
    const pos = map.posOf(['steps', 'step_one', 'execution']);
    expect(pos?.column).toBe(35);
    // Self-proving: the column really lands on the 'e' of `execution`, so a miscount here cannot
    // pass by agreeing with a wrong number I wrote down.
    expect(src.split('\n')[(pos?.line ?? 1) - 1]?.slice((pos?.column ?? 1) - 1)).toMatch(
      /^execution:/,
    );
  });

  it('an anchored+aliased VALUE is placed at its own key, not its anchor', () => {
    const src = `a: &anchor hello
b: *anchor
`;
    const map = mapOf(src);
    expect(map.posOf(['a'])?.line).toBe(1);
    expect(map.posOf(['b'])?.line).toBe(2);
  });

  it('a sequence of mappings does not produce bogus paths', () => {
    // Sequence items have no keys of their own to name, so nothing under them is addressable by
    // the `a.b.c` path shape. The map must not invent index-shaped paths.
    const src = `mcp_servers:
  - id: github
    command: npx
`;
    const map = mapOf(src);
    expect(map.posOf(['mcp_servers'])?.line).toBe(1);
    expect(map.posOf(['mcp_servers', 'id'])).toBeUndefined();
    expect(map.posOf(['mcp_servers', '0', 'id'])).toBeUndefined();
  });

  it('an empty document resolves nothing and does not throw', () => {
    expect(mapOf('').posOf(['anything'])).toBeUndefined();
    expect(mapOf('# just a comment\n').posOf(['anything'])).toBeUndefined();
  });
});
