// Structured, categorized error class used throughout the engine.

export type ErrorCategory = 'NETWORK' | 'SERVICE' | 'STATE' | 'VALIDATION' | 'ENGINE' | 'RESOURCE';

export type AgentAction =
  | 'report_to_user'
  | 'provide_input'
  | 'resolve_precondition'
  | 'stop'
  | 'wait_for_human';

export type ErrorCode =
  // NETWORK
  | 'NETWORK_TIMEOUT'
  | 'NETWORK_UNREACHABLE'
  | 'NETWORK_DNS_FAILED'
  | 'NETWORK_CONNECTION_RESET'
  // SERVICE
  | 'SERVICE_HTTP_4XX'
  | 'SERVICE_HTTP_5XX'
  | 'SERVICE_RATE_LIMITED'
  | 'SERVICE_AUTH_FAILED'
  | 'SERVICE_NOT_FOUND'
  | 'SERVICE_RESPONSE_INVALID'
  // STATE
  | 'STATE_BLOCKED'
  | 'STATE_PRECONDITION_FAILED'
  | 'STATE_RUN_NOT_FOUND'
  | 'STATE_RUN_TERMINAL'
  | 'STATE_SNAPSHOT_MISMATCH'
  | 'STATE_RUN_LOCKED'
  | 'STATE_TRANSITION_DENIED'
  | 'STATE_LEGACY_FORMAT'
  | 'STATE_STEP_ALREADY_CLAIMED'
  | 'STATE_STEP_NOT_ELIGIBLE'
  | 'STATE_RUN_DIVERGED'
  // VALIDATION
  | 'VALIDATION_INPUT_SCHEMA'
  | 'VALIDATION_OUTPUT_SCHEMA'
  | 'VALIDATION_TRACE_SCHEMA'
  | 'VALIDATION_WORKFLOW_SCHEMA'
  | 'VALIDATION_HASH_MISMATCH'
  | 'VALIDATION_QUOTE_NOT_FOUND'
  | 'VALIDATION_FIELD_UNKNOWN'
  | 'VALIDATION_FIELD_EXCLUDED'
  | 'VALIDATION_EMPTY_VALUE'
  | 'STEP_HANDLER_ERROR'
  // ENGINE
  | 'ENGINE_INTERNAL'
  | 'ENGINE_STORE_FAILED'
  | 'ENGINE_ADAPTER_FAILED'
  | 'ENGINE_PROCESSOR_FAILED'
  | 'ENGINE_HANDLER_FAILED'
  | 'ENGINE_STEP_FAILED'
  | 'ENGINE_GATE_OPEN_FAILED'
  | 'GATE_MESSAGE_UNRESOLVABLE'
  | 'FILTER_UNKNOWN'
  | 'ADAPTER_OP_UNSUPPORTED'
  | 'ADAPTER_VALIDATION_FAILED'
  | 'ADAPTER_REQUEST_FAILED'
  | 'STEP_TIMEOUT'
  | 'STEP_ABORTED'
  | 'STEP_RETRY_EXHAUSTED'
  | 'STATE_STEP_PENDING'
  | 'STEP_NOT_FOUND'
  // RESOURCE
  | 'RESOURCE_FETCH_FAILED'
  | 'RESOURCE_TOO_LARGE'
  | 'RESOURCE_FORMAT_INVALID'
  | 'RESOURCE_NOT_ACCESSIBLE'
  // MCP
  | 'MCP_CONNECTION_FAILED'
  | 'MCP_TOOL_NOT_FOUND'
  | 'MCP_TOOL_NAME_COLLISION';

export interface WorkflowErrorOptions {
  code: ErrorCode;
  category: ErrorCategory;
  agentAction: AgentAction;
  retryable: boolean;
  details?: Record<string, unknown>;
  stepId?: string;
  attempt?: number;
}

export class WorkflowError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly agentAction: AgentAction;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  readonly stepId?: string;
  readonly timestamp: string;
  readonly attempt: number;

  constructor(message: string, options: WorkflowErrorOptions) {
    super(message);
    this.name = 'WorkflowError';
    this.code = options.code;
    this.category = options.category;
    this.agentAction = options.agentAction;
    this.retryable = options.retryable;
    this.details = options.details ?? {};
    if (options.stepId !== undefined) this.stepId = options.stepId;
    this.timestamp = new Date().toISOString();
    this.attempt = options.attempt ?? 1;
  }
}
