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

describe('C3d-B — what a due callback waits for, and one that expired before a try', () => {
  const pending = (over: Partial<CallbackView>): CallbackView => ({
    workflow_id: 'refunds',
    host: 'hooks.example.com:443',
    status: 'pending',
    attempts: 0,
    created_at: '2026-11-21T11:00:00.000Z',
    next_attempt_at: '2026-11-21T11:59:56.000Z',
    ...over,
  });
  it('due never tried; due after tries with and without a last answer; expired at attempt 0 and at 2; the other forms unchanged', () => {
    // (1) red when the due line keeps the old words ("sent only while …"), promises a send ("sends
    //     it", "tries again"), leaves out the attempt or the answer after a try, shows them for a row
    //     never tried, or an expired row with no try says "expired at attempt 0"; (2) prints each line.
    expect({
      dueNeverTried: callbackLine(pending({}), true, AT),
      dueAfterTries: callbackLine(pending({ attempts: 2, last_status: 503 }), true, AT),
      dueAfterACutTry: callbackLine(pending({ attempts: 1 }), true, AT),
      expiredNoTry: callbackLine(failed(0, 'expired'), true, AT),
      expiredAfterTwo: callbackLine(failed(2, 'expired'), true, AT),
      pendingAfterATry: callbackLine(
        pending({ attempts: 1, last_status: 503, next_attempt_at: '2026-11-21T12:05:00.000Z' }),
        true,
        AT,
      ),
      waiting: callbackLine(pending({}), false, AT),
    }).toEqual({
      dueNeverTried:
        'Callback: due since 4s ago (2026-11-21T11:59:56Z); it waits for the next pass of a realm listen that can send it',
      dueAfterTries:
        'Callback: due since 4s ago (2026-11-21T11:59:56Z), attempt 2, last answer 503; it waits for the next pass of a realm listen that can send it',
      dueAfterACutTry:
        'Callback: due since 4s ago (2026-11-21T11:59:56Z), attempt 1; it waits for the next pass of a realm listen that can send it',
      expiredNoTry: 'Callback: expired before its first try, not delivered within its time limit',
      expiredAfterTwo: 'Callback: expired at attempt 2, not delivered within its time limit',
      pendingAfterATry:
        'Callback: pending, attempt 1, last answer 503, next try in 5m (2026-11-21T12:05:00Z)',
      waiting: 'Callback: waiting for the run to finish',
    });
  });
});
