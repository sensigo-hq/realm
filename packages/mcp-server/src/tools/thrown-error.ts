// thrown-error.ts — gap 2, unit (iv-b2b): the one way the six tools whose call loads the project's
// code (execute_step, advance_run, start_run, start_run_batch, submit_human_response,
// present_question) turn what their handler threw into the `WorkflowError` their reply is built
// from: a `WorkflowError` as it is; anything else as `ENGINE_INTERNAL`, with its message. A throw
// marked as a failure's words (the project's code failing to load) keeps its mark on the error it
// becomes, so core's error envelope marks the reply and the door shapes `errors[0]`.
import { WorkflowError, carriesFailureWords, noteFailureWords } from '@sensigo/realm';

/** What a tool's handler threw, as the `WorkflowError` its error reply is built from. */
export function workflowErrorOfThrown(err: unknown): WorkflowError {
  if (err instanceof WorkflowError) return err;
  const converted = new WorkflowError(err instanceof Error ? err.message : String(err), {
    code: 'ENGINE_INTERNAL',
    category: 'ENGINE',
    agentAction: 'stop',
    retryable: false,
  });
  return carriesFailureWords(err) ? noteFailureWords(converted) : converted;
}
