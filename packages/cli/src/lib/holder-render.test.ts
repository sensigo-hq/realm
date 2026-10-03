// holder-render.test.ts — issue #625 (the holder slice, PR-H): the words a name's absence is printed
// with. Every cause is pinned at the function — including the two that `realm run inspect` cannot
// reach today (an attempt with no recorded name prints NO line; the answer line has its own
// `(not stated)` text), so the map cannot lose a word without a cell turning red.
//
// Each assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { ACTOR_ABSENT_CAUSES } from '@sensigo/realm';
import type { ActorAbsentCause, AnswerView } from '@sensigo/realm';
import { UNSHOWABLE_NAME, describeAbsence, renderAnswerLine } from './holder-render.js';

const WORDS: Record<ActorAbsentCause, string> = {
  holder_not_recorded: 'no program name was recorded on this claim',
  pre_lease_claim: 'claimed before program names were recorded',
  no_claim: 'no claim is recorded for this step',
  store_keeps_no_claims: 'this run store keeps no claims',
  driver_not_recorded: 'no program name was recorded on this step',
  name_unreadable: UNSHOWABLE_NAME,
  not_stated: '(not stated)',
};

describe('describeAbsence — one word per cause', () => {
  it.each(ACTOR_ABSENT_CAUSES.map((cause) => [cause, WORDS[cause]] as const))(
    '%s ⇒ %s',
    (cause, word) => {
      // (a) red when a word changes or a cause is added without one; (b) prints the cause.
      expect(describeAbsence({ by: null, absent_cause: cause })).toBe(word);
    },
  );

  it('the table above covers every cause the vocabulary has (a new cause fails here first)', () => {
    expect(Object.keys(WORDS).sort()).toEqual([...ACTOR_ABSENT_CAUSES].sort());
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
