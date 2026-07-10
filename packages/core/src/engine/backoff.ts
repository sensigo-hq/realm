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
