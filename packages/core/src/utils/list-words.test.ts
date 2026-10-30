// list-words.test.ts — #872 (b1) correction 1 (HC1): the ONE producer of a bounded list in words
// (`listWords`, `quotedNames`, `NAMES_SHOWN`). Beside each: (a) the change that turns it red; (b)
// what it prints on failure — the words (the names are fake), lengths and counts.
import { describe, it, expect } from 'vitest';
import { NAMES_SHOWN, listWords, quotedNames } from './list-words.js';
import { cannotRunSummary, type Unavailable } from '../index.js';

const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i}`);

describe('#872 (b1) correction 1 HC1 — listWords and quotedNames', () => {
  it('0, 10, 11 and 1,000 items: every item up to the count shown, then " and <N> more"', () => {
    // (a) red when the bound is removed (1,000 names whole), the count is off, or the joiner
    //     changes; (b) prints the words' lengths and their ends.
    const words = [0, 10, 11, 1000].map((n) => listWords(names(n), NAMES_SHOWN));
    expect({ shown: NAMES_SHOWN, words }).toEqual({
      shown: 10,
      words: [
        '',
        's0, s1, s2, s3, s4, s5, s6, s7, s8, s9',
        's0, s1, s2, s3, s4, s5, s6, s7, s8, s9 and 1 more',
        's0, s1, s2, s3, s4, s5, s6, s7, s8, s9 and 990 more',
      ],
    });
  });

  it('quotedNames: each name quoted and through capText — a 600-character name by its length', () => {
    // (a) red when capText is bypassed (the 600 characters quoted whole) or the quotes change; (b)
    //     prints the words.
    expect([
      quotedNames(['a', 'n'.padEnd(600, 'q'), 'c'], 2),
      quotedNames(names(11), NAMES_SHOWN),
    ]).toEqual([
      "'a', '‹600 characters, not kept›' and 1 more",
      "'s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9' and 1 more",
    ]);
  });

  it('cannotRunSummary’s per-group names go through quotedNames: its output byte-identical to #872 (a)’s at 1, 3, 4 and 600-character names', () => {
    const cap = (step: string, name: string): Unavailable => ({
      verb: 'run_step',
      step,
      code: 'capability_missing',
      facts: { step, requirement: { kind: 'handler', name }, basis: 'registry' },
      remedy: [],
      no_remedy: { cause: 'requires_other_program', requirement: { kind: 'handler', name } },
    });
    // (a) red when the group's names stop at another count or lose capText; (b) prints the summary.
    expect(
      cannotRunSummary([
        cap('a', 'h'),
        cap('b', 'h'),
        cap('c', 'h'),
        cap('d', 'h'),
        cap('e'.padEnd(600, 'x'), 'g'),
        cap('f', 'g'),
      ]),
    ).toBe(
      "6 steps cannot run here (capability): handler 'h' ('a', 'b', 'c' and 1 more); handler 'g' ('‹600 characters, not kept›', 'f') — load the missing extensions, or run these steps on a runner that has them",
    );
  });
});
