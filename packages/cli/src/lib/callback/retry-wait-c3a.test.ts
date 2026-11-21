// retry-wait-c3a.test.ts — callback C3a (R1.3): the wait before a callback's next try, as a pure cell
// on the schedule (1 s doubling to 1 h, ±20 % jitter, `Retry-After` as a floor, 1 h at most).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { describe, expect, it } from 'vitest';
import { CALLBACK_RETRY_WAIT_MAX_SECONDS, callbackRetryWaitSeconds } from './retry-wait.js';

const LOW = (): number => 0;
const HIGH = (): number => 1;

describe('callback C3a — the wait before the next try', () => {
  it('1 s, 2 s, 4 s for tries 1 to 3, the 1 h cap by try 13, each at 0.8× and 1.2×', () => {
    const at = (attempt: number) => [
      callbackRetryWaitSeconds(attempt, LOW),
      callbackRetryWaitSeconds(attempt, HIGH),
    ];
    // (1) red when the wait does not double, starts at another wait, has no jitter or other jitter,
    //     or passes 1 h (try 13's 4,096 s, or 1.2× of the capped 3,600 s); (2) prints each pair.
    expect({ 1: at(1), 2: at(2), 3: at(3), 13: at(13) }).toEqual({
      1: [0.8, 1.2],
      2: [1.6, 2.4],
      3: [3.2, 4.8],
      13: [2880, CALLBACK_RETRY_WAIT_MAX_SECONDS],
    });
  });

  it('a Retry-After lifts the wait to at least itself, and never past 1 h', () => {
    // (1) red when Retry-After is ignored, lowers the wait, or lifts it past 1 h; (2) prints each.
    expect({
      lifted: callbackRetryWaitSeconds(1, HIGH, 7),
      belowSchedule: callbackRetryWaitSeconds(3, LOW, 1),
      capped: callbackRetryWaitSeconds(1, LOW, 99_999),
      cap: CALLBACK_RETRY_WAIT_MAX_SECONDS,
    }).toEqual({ lifted: 7, belowSchedule: 3.2, capped: 3600, cap: 3600 });
  });
});
