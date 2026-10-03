// holder-render.test.ts — issue #625 (the holder slice, PR-H): the words a name's absence is printed
// with on a CLAIM line. Every cause `describeClaimHolder` can return is pinned at the map, so the map
// cannot lose a word without a cell turning red — and, typed over exactly those causes, it cannot
// carry a word nothing shows (a stray key is a compile error).
//
// Each assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import type { AnswerView, ClaimHolderAbsentCause } from '@sensigo/realm';
import { ABSENCE_WORDS, UNSHOWABLE_NAME, renderAnswerLine } from './holder-render.js';

const WORDS: Record<ClaimHolderAbsentCause, string> = {
  holder_not_recorded: 'no program name was recorded on this claim',
  pre_lease_claim: 'claimed before program names were recorded',
  no_claim: 'no claim is recorded for this step',
  store_keeps_no_claims: 'this run store keeps no claims',
  name_unreadable: UNSHOWABLE_NAME,
};

describe('ABSENCE_WORDS — one word per cause a claim line can show', () => {
  it.each(Object.entries(WORDS))('%s ⇒ %s', (cause, word) => {
    // (a) red when a word changes; (b) prints the cause.
    expect(ABSENCE_WORDS[cause as ClaimHolderAbsentCause]).toBe(word);
  });

  it('the map has exactly the causes a claim line can show — no word nothing can reach', () => {
    // (a) red when a cause is added to or dropped from the map; (b) prints the keys.
    expect(Object.keys(ABSENCE_WORDS).sort()).toEqual(Object.keys(WORDS).sort());
  });
});

describe('renderAnswerLine — an answer with no choice on the record', () => {
  it('reads "(no choice recorded)" — never an empty slot', () => {
    const answer: AnswerView = {
      answered_by: { by: null, absent_cause: 'not_stated' },
      claim_proof_absent: 'proof_not_recorded',
    };
    expect(renderAnswerLine(answer)).toBe(
      'Answer: (no choice recorded) · answered by (not stated) · proof: none recorded',
    );
  });
});
