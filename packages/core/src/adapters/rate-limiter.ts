// Rate limiter interface — token-bucket-based request gating.

/**
 * Controls the rate at which requests are sent to an external service.
 *
 * The engine calls `acquire()` before each adapter invocation when a service
 * has a `rate_limit` configuration. It calls `pause()` when the service responds
 * with HTTP 429 to hold off concurrent retries for the indicated window.
 */
export interface RateLimiter {
  /**
   * Acquires a token, waiting if none are available.
   * Resolves immediately when a token is available.
   * Rejects with STEP_ABORTED if the signal is aborted while waiting.
   *
   * @param signal  Optional AbortSignal for cancellation.
   */
  acquire(signal?: AbortSignal): Promise<void>;

  /**
   * Pauses token issuance for the given number of seconds.
   * Uses MAX semantics: a shorter pause never overrides a longer pending pause.
   * On resume, exactly 1 token is issued (not burst capacity).
   *
   * @param seconds  Duration in seconds to halt the token bucket.
   */
  pause(seconds: number): void;
}
