// question-deadline-715b.test.ts — issue #715 (b) 03 §B.2 E (D6-72 (b), the owner 2026-10-27:
// "agreed, we should do it like this"): the terminal question shows its deadline, through the one
// formatter, at the reading of the snapshot the question was read from.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import type { PendingGate } from '@sensigo/realm';
import { questionDeadlineLine } from './holder-render.js';

const AT = new Date('2026-10-27T14:03:07.000Z');

const gate = (expires_at?: string): PendingGate => ({
  gate_id: 'g1',
  step_name: 'q',
  preview: {},
  choices: ['approve', 'reject'],
  opened_at: '2026-10-27T14:00:00.000Z',
  ...(expires_at !== undefined ? { expires_at } : {}),
});

describe('#715 (b) 03 §B.2 E — the terminal question’s deadline', () => {
  it('a question with a deadline ahead: Deadline: in <duration> (<instant>)', () => {
    // (a) red when the line is missing or judged at another instant; (b) prints the line.
    expect(questionDeadlineLine(gate('2026-10-27T14:08:07.000Z'), AT)).toBe(
      '   Deadline: in 5m (2026-10-27T14:08:07Z)',
    );
  });

  it('a question whose deadline has passed: Deadline: EXPIRED <duration> ago (<instant>)', () => {
    // (a) red when a passed deadline reads "in …"; (b) prints the line.
    expect(questionDeadlineLine(gate('2026-10-27T14:01:07.000Z'), AT)).toBe(
      '   Deadline: EXPIRED 2m ago (2026-10-27T14:01:07Z)',
    );
  });

  it('a question with no deadline prints nothing new; nor does one whose deadline does not parse', () => {
    // (a) red when a line is printed with no deadline to state; (b) prints what came back.
    expect({
      none: questionDeadlineLine(gate(), AT),
      unreadable: questionDeadlineLine(gate('soon'), AT),
    }).toEqual({ none: undefined, unreadable: undefined });
  });
});
