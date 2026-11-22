// inspect-line-c3b1.test.ts — R1.3 callback C3b1: the `Callback:` line of a row whose time limit ended
// says so (`expired at attempt <n>`) instead of "failed after <n> attempts, last answer expired"; a row
// that failed with any other answer keeps its line. Pure cells on `callbackLine`; the built
// `realm run inspect` prints the same line (`commands/inspect-callback-c3b1.test.ts`).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { describe, expect, it } from 'vitest';
import type { CallbackView } from '@sensigo/realm';
import { callbackLine } from './inspect-line.js';

const AT = new Date('2026-11-21T12:00:00.000Z');
const failed = (attempts: number, last_status: CallbackView['last_status']): CallbackView => ({
  workflow_id: 'refunds',
  host: 'hooks.example.com:443',
  status: 'failed',
  attempts,
  created_at: '2026-11-18T12:00:00.000Z',
  next_attempt_at: '2026-11-21T11:00:00.000Z',
  first_attempt_at: '2026-11-18T12:00:00.000Z',
  last_attempt_at: '2026-11-21T11:00:00.000Z',
  ...(last_status !== undefined ? { last_status } : {}),
});

describe('C3b1 — the inspect line of an expired callback', () => {
  it('expired at 1 and at 3 attempts; a 410 after 2 attempts keeps its line', () => {
    // (1) red when the new line is chosen on `failed` alone (the 410 line changes), the attempt count
    //     is not the view's, or a word changes; (2) prints each line.
    expect({
      one: callbackLine(failed(1, 'expired'), true, AT),
      three: callbackLine(failed(3, 'expired'), true, AT),
      gone: callbackLine(failed(2, 410), true, AT),
    }).toEqual({
      one: 'Callback: expired at attempt 1, not delivered within its time limit',
      three: 'Callback: expired at attempt 3, not delivered within its time limit',
      gone: 'Callback: failed after 2 attempts, last answer 410',
    });
  });
});
