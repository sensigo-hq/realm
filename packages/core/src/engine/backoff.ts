// backoff.ts — pure retry-backoff computation, extracted from execution-loop.ts (issue #101
// follow-up) so claim-liveness.ts can share it without an import cycle: execution-loop.ts already
// imports from claim-liveness.ts, so claim-liveness.ts → execution-loop.ts would cycle back.
// This module imports only the RetryConfig type (no engine runtime) — a neutral leaf both
// execution-loop.ts and claim-liveness.ts can import acyclically.
import type { RetryConfig } from '../types/workflow-definition.js';

/** Computes the delay (ms) before a retry attempt based on the configured backoff strategy. */
export function computeBackoff(config: RetryConfig, attemptNum: number): number {
  const backoff = config.backoff ?? 'fixed';
  const base = config.base_delay_ms ?? 0;
  let delay: number;
  switch (backoff) {
    case 'linear':
      delay = base * attemptNum;
      break;
    case 'exponential':
      delay = base * Math.pow(2, attemptNum - 1);
      break;
    default: // 'fixed'
      delay = base;
  }
  return config.max_delay_ms !== undefined ? Math.min(delay, config.max_delay_ms) : delay;
}

/**
 * Gap 2, unit (i-b): the model client's own wait schedule, which a step's `retry` follows when it
 * declares none of `backoff`, `base_delay_ms` and `max_delay_ms`: 500 ms after the first failed try,
 * doubling, at most 8 s (the Anthropic and OpenAI SDKs' schedule, without its jitter).
 */
function clientScheduleMs(attemptNum: number): number {
  return Math.min(500 * Math.pow(2, attemptNum - 1), 8000);
}

/** Whether a `retry` block declares any of the three keys that shape its wait. */
function declaresWait(config: RetryConfig): boolean {
  return (
    config.backoff !== undefined ||
    config.base_delay_ms !== undefined ||
    config.max_delay_ms !== undefined
  );
}

/**
 * Gap 2, unit (i-b): the wait, in milliseconds, after try `attemptNum` (from 1) of an agent step's
 * model request failed, before its next try. With none of `backoff`, `base_delay_ms` and
 * `max_delay_ms` declared it follows the model client's schedule; with any declared, the others
 * take their auto-step defaults and {@link computeBackoff} computes it, as on an auto step. Either
 * way it carries the SDKs' jitter: × (1 − U(0, 0.25)), `random` giving U(0, 1).
 */
export function modelRetryWaitMs(
  config: RetryConfig,
  attemptNum: number,
  random: () => number = Math.random,
): number {
  const base = declaresWait(config)
    ? computeBackoff(config, attemptNum)
    : clientScheduleMs(attemptNum);
  return base * (1 - random() * 0.25);
}

/**
 * Gap 2, unit (i-b): the sum of the waits between an agent step's `max_attempts` tries of one model
 * request, without jitter (an upper bound: jitter only shortens a wait). Its derived cap is
 * `max_attempts` × the per-attempt timeout, plus this, plus the download allowance.
 */
export function modelRetryScheduleMs(config: RetryConfig): number {
  // An absent `max_attempts` (the loader admits one) means 1, as on an auto step.
  const attempts = config.max_attempts ?? 1;
  let total = 0;
  for (let n = 1; n < attempts; n++) {
    total += declaresWait(config) ? computeBackoff(config, n) : clientScheduleMs(n);
  }
  return total;
}
