// Types for the ResponseEnvelope returned by every step execution.
import type { EvidenceSnapshot, RunPhase } from './run-record.js';
import type { AgentAction, ErrorCode } from './workflow-error.js';

export interface NextAction {
  instruction: {
    tool: string;
    params: Record<string, unknown>;
    /**
     * Ready-to-use flat argument object for calling the tool.
     * Agent-supplied params appear as placeholder strings (e.g. "<YOUR_PARAMS>", "<approve|reject>").
     * Copy this object, replace the placeholder(s), and call the tool.
     */
    call_with: Record<string, unknown>;
  } | null;
  human_readable: string;
  /** Current state orientation — describes what state the run is in and what just happened. */
  orientation: string;
  expected_timeout?: string;
  /** The step's declared input schema — use this to structure the params argument of your execute_step call. */
  input_schema?: Record<string, unknown>;
  /** Template-resolved step prompt, delivered to the agent at step entry. */
  prompt?: string;
}

export type RunStatus = 'ok' | 'error' | 'blocked' | 'confirm_required';

export interface BlockedReason {
  /** Step names currently eligible for execution. */
  eligible_steps: string[];
  suggestion?: string;
}

export interface GateInfo {
  gate_id: string;
  step_name: string;
  preview: Record<string, unknown>;
  choices: string[];
  /** Template-resolved display content for this gate step — present to the human verbatim before asking for their choice. */
  display?: string;
  /** Agent-facing instructions for this gate step — how the agent should present the gate to the human. */
  agent_hint?: string;
  /** Structured response specification — the choices the human may select. */
  response_spec?: { choices: string[] };
}

export interface ResponseEnvelope {
  command: string;
  run_id: string;
  /** Integer version of the run record at time of response. For observability only — not required as input to any tool. */
  run_version: number;
  /**
   * Chain progress status.
   * - 'ok': the chain made forward progress; follow next_actions for what to do next.
   *   Does NOT imply the original requested step succeeded — a recovery path also returns 'ok' with a warning.
   * - 'error': unrecoverable failure; agent_action tells you how to respond.
   * - 'blocked': wrong step for current state; next_actions redirects.
   * - 'confirm_required': a human gate is open; gate carries the display content.
   */
  status: RunStatus;
  data: Record<string, unknown>;
  /** Audit trail of step executions in this response. For debugging and CLI inspection only. */
  evidence: EvidenceSnapshot[];
  warnings: string[];
  errors: string[];
  /**
   * The canonical error code from the WorkflowError that produced this envelope.
   * Only present when status === 'error'.
   */
  error_code?: ErrorCode;
  /**
   * Additional structured context from the WorkflowError. Only present when
   * error_code is set and the error carries non-empty details.
   */
  error_details?: Record<string, unknown>;
  agent_action?: AgentAction;
  /**
   * When present and agent_action is 'wait_and_proceed', the number of seconds
   * the consumer should wait before following next_actions. Not set for other
   * agent_action values.
   */
  retry_after?: number;
  /** Current state orientation. Always populated — describes what just happened and what state the run is in. */
  context_hint: string;
  /**
   * Derived phase of the run at the time of this response. Present whenever a run is loaded
   * (sourced from `run.run_phase`); absent only on pre-execution error envelopes where no run
   * could be loaded (`buildPreExecutionErrorEnvelope` / `errorEnvelope`).
   */
  run_phase?: RunPhase;
  /** Steps available for execution. Empty array means terminal or blocked — check status and run_phase. */
  next_actions: NextAction[];
  blocked_reason?: BlockedReason;
  gate?: GateInfo;
  /**
   * Names and run_phase values of auto steps that ran silently as part of an executeChain call.
   * Only present when at least one auto step was chained. Useful for debugging and orientation
   * after start_run or after an agent step that triggers subsequent auto steps.
   */
  chained_auto_steps?: Array<{ step: string; run_phase: string; branched_via?: string }>;
}
