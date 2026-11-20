// Q1 (#592) unit a: a failed attempt's words, written on its evidence entry at the moment of
// failure by the code that has them in hand — the error's code, category and action word, and on
// the last entry of a step that failed, why retrying stopped.
import type { EvidenceSnapshot, StopReason } from '../types/run-record.js';
import type { WorkflowError } from '../types/workflow-error.js';

/** The three words an error carries, as an evidence entry records them. */
export type FailureWords = Required<
  Pick<EvidenceSnapshot, 'error_code' | 'error_category' | 'agent_action'>
>;

/** The error's own code, category and action word. */
export function failureWordsOf(error: WorkflowError): FailureWords {
  return {
    error_code: error.code,
    error_category: error.category,
    agent_action: error.agentAction,
  };
}

/**
 * The facts the dispatch loop's retry decision read when it stopped, as the stop word needs them.
 * `optedInTimeout`: the last error is a time-out the step opted to retry in place — the three the
 * decision requires (`retry.on_timeout`, `idempotent`, a total-time cap) and the `STEP_TIMEOUT` code.
 */
export interface StopFacts {
  hasRetryBlock: boolean;
  capExhausted: boolean;
  retryable: boolean;
  optedInTimeout: boolean;
}

/**
 * Why retrying stopped, judged in this order (the cap before the error's retryability, as
 * `exhausted_by` already does): no `retry` block; the total-time cap spent; an error the decision
 * would not retry; otherwise the attempts were used up (the loop leaves a retried error only on its
 * last slot). It reads only what the decision read, and decides nothing.
 */
export function stopReasonOf(facts: StopFacts): StopReason {
  if (!facts.hasRetryBlock) return 'no_retry_policy';
  if (facts.capExhausted) return 'total_timeout';
  if (!facts.retryable && !facts.optedInTimeout) return 'non_retryable';
  return 'attempts';
}
