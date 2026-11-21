// retry-wait.ts — callback C3a (R1.3): how long a callback waits before its next try. Pure: the
// random source is passed in. 1 s after the first try's failure, doubling for each next, never over
// 1 h; then ±20 % jitter; a `Retry-After` the receiver sent raises the wait to at least that; and the
// wait never exceeds 1 h. The result is the `afterSeconds` of a `retry` mark (a fraction is allowed).

/** The longest wait before a callback's next try, in seconds (1 h). */
export const CALLBACK_RETRY_WAIT_MAX_SECONDS = 3_600;
/** The jitter around the schedule's wait: ±20 %. */
const JITTER = 0.2;

/**
 * The wait in seconds after try `attempt` (1 for the first) failed. `random` answers a number from 0
 * to 1 (0 gives the shortest wait, 0.8×; 1 the longest, 1.2×); `retryAfterSeconds` is the receiver's
 * `Retry-After`, when it sent one.
 */
export function callbackRetryWaitSeconds(
  attempt: number,
  random: () => number,
  retryAfterSeconds?: number,
): number {
  const step = Math.max(1, Math.floor(attempt));
  // 2^(step − 1) passes 3,600 at step 13: the exponent is bounded so the power stays finite.
  const schedule = Math.min(2 ** Math.min(step - 1, 32), CALLBACK_RETRY_WAIT_MAX_SECONDS);
  const jittered = schedule * (1 + JITTER * (2 * random() - 1));
  const floored =
    retryAfterSeconds === undefined ? jittered : Math.max(jittered, retryAfterSeconds);
  return Math.min(floored, CALLBACK_RETRY_WAIT_MAX_SECONDS);
}
