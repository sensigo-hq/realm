// error-resolution.ts — Context-sensitive translation of WorkflowError.agentAction.
import type { WorkflowError, AgentAction } from '../types/workflow-error.js';

/**
 * Resolves the agent action for errors that occur before claimStep runs —
 * outer MCP catch blocks, store pre-flight failures, and makeErrorEnvelope(run=null)
 * paths inside the execution loop.
 *
 * `provide_input` and `resolve_precondition` cannot apply at this stage: the
 * failure came from infrastructure, never from the agent's submitted arguments.
 */
export function resolvePreExecutionAgentAction(err: WorkflowError): AgentAction {
  if (err.agentAction === 'provide_input' || err.agentAction === 'resolve_precondition') {
    return 'report_to_user';
  }
  return err.agentAction;
}

/**
 * Resolves the agent action for errors that occur after claimStep has completed
 * successfully and the step is in `in_progress_steps`. Call this only in that
 * context. `isTerminalRun` must be `run.terminal_state` from the persisted or
 * failed run record after dispatch — do not pass a derived or assumed value.
 */
export function resolvePostDispatchAgentAction(
  err: WorkflowError,
  isTerminalRun: boolean,
): AgentAction {
  if (isTerminalRun) return 'stop';
  const raw = err.agentAction;
  if (raw === 'stop' || raw === 'provide_input' || raw === 'resolve_precondition') {
    return 'report_to_user';
  }
  return raw;
}
