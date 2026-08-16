// Structured, categorized error class used throughout the engine.

export type ErrorCategory = 'NETWORK' | 'SERVICE' | 'STATE' | 'VALIDATION' | 'ENGINE' | 'RESOURCE';

export type AgentAction =
  | 'report_to_user'
  | 'provide_input'
  | 'resolve_precondition'
  | 'stop'
  | 'wait_for_human'
  | 'wait_and_proceed';

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
  // a 3xx redirect where a direct response was required (e.g. on a write) — non-retryable
  | 'SERVICE_UNEXPECTED_REDIRECT'
  // STATE
  | 'STATE_BLOCKED'
  | 'STATE_PRECONDITION_FAILED'
  | 'STATE_RUN_NOT_FOUND'
  | 'STATE_WORKFLOW_NOT_FOUND'
  | 'STATE_RUN_TERMINAL'
  | 'STATE_SNAPSHOT_MISMATCH'
  | 'STATE_RUN_LOCKED'
  // a deleteAllForRun-owning store could not acquire its run-file (or key) lock (ELOCKED), or —
  // under that lock — found the run is no longer terminal (a concurrent resume raced the purge).
  // Retryable: a live writer self-heals, and a stale lock is eventually stolen (issue #184).
  | 'STATE_RUN_BUSY'
  | 'STATE_TRANSITION_DENIED'
  // gc's orphan-artifact sweep (issue #207 PR-2): a fenced destroy-guard's fresh read found the
  // run EXISTS AGAIN — a JsonFileStore.save() re-import landed between the sweep's snapshot and
  // the reap. Purely an internal signal between that guard and gc's own catch (routes it to the
  // `resurrected` bucket, never `failed`/an aborted sweep) — not expected to surface in any
  // envelope.
  | 'STATE_RUN_RESURRECTED'
  | 'STATE_LEGACY_FORMAT'
  | 'STATE_STEP_ALREADY_CLAIMED'
  | 'STATE_STEP_NOT_ELIGIBLE'
  // issue #279 (increment 1, PR-B): a settle_step delta refused because the step's settled entry
  // already carries a DIFFERENT token (already_settled_by_other) or a DIFFERENT outcome
  // (settled_outcome_divergence) — the persisted outcome is disclosed in `details`. Never thrown
  // for the SAME-token/SAME-outcome retry, which is an ok-shaped no-op (design record §7).
  | 'STATE_STEP_ALREADY_SETTLED'
  // issue #279 (increment 1, PR-B): a settle_step delta refused `claim_lost` — this attempt's
  // outcome was NOT recorded (the claim was lost to a concurrent settle, or the run advanced).
  | 'STATE_CLAIM_LOST'
  | 'STATE_RUN_DIVERGED'
  | 'STATE_RUN_ALREADY_ACTIVE'
  | 'STATE_IDEMPOTENCY_KEY_USED'
  | 'RUN_ABORTING'
  // VALIDATION
  | 'VALIDATION_INPUT_SCHEMA'
  | 'VALIDATION_OUTPUT_SCHEMA'
  | 'VALIDATION_TRACE_SCHEMA'
  // issue #220: a persistently-rejected agent step's bounded rejection count reached its
  // threshold — a REAL terminal step failure (kept separate from #140's `exhausted_by` taxonomy:
  // disjoint lifecycles — this is a validation-rejection count, not a retry/timeout budget).
  | 'VALIDATION_EXHAUSTED'
  | 'VALIDATION_WORKFLOW_SCHEMA'
  | 'VALIDATION_HASH_MISMATCH'
  | 'VALIDATION_QUOTE_NOT_FOUND'
  | 'VALIDATION_FIELD_UNKNOWN'
  | 'VALIDATION_FIELD_EXCLUDED'
  | 'VALIDATION_EMPTY_VALUE'
  | 'VALIDATION_BATCH_TOO_LARGE'
  | 'VALIDATION_BATCH_ITEMS'
  | 'STEP_HANDLER_ERROR'
  // ENGINE
  | 'ENGINE_INTERNAL'
  | 'ENGINE_STORE_FAILED'
  // a PerRunArtifactStore.deleteAllForRun implementation could not delete (or could not even
  // confirm the presence/absence of) an artifact it owns for a run — a genuine non-ENOENT I/O
  // failure, never used for a plain "already gone" (issue #183)
  | 'ENGINE_ARTIFACT_DELETE_FAILED'
  | 'ENGINE_ADAPTER_FAILED'
  | 'ENGINE_ADAPTER_NOT_REGISTERED'
  | 'ENGINE_PROCESSOR_FAILED'
  | 'ENGINE_HANDLER_FAILED'
  | 'ENGINE_HANDLER_NOT_REGISTERED'
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
  | 'GUARD_RESOLUTION_ERROR'
  | 'INPUT_MAP_DEPTH_EXCEEDED'
  // Issue #287: an input_map node carries a `$`-prefixed key that is not a supported directive,
  // or `$literal` with sibling keys. The loader rejects both at authoring; this code is the
  // RUNTIME mirror, which is what catches an ALREADY-REGISTERED workflow (a stored definition
  // re-executes its corruption on every run) and any raw-parse path that bypasses the loader.
  | 'INPUT_MAP_UNKNOWN_DIRECTIVE'
  // RESOURCE
  | 'RESOURCE_FETCH_FAILED'
  | 'RESOURCE_TOO_LARGE'
  | 'RESOURCE_FORMAT_INVALID'
  | 'RESOURCE_NOT_ACCESSIBLE'
  // TRACE BUFFER
  | 'BUFFER_FULL'
  // issue #197 PR-1: validateTraceCapabilities' typed fail-loud when a TraceBufferStore declares
  // a capability-ladder rung ('seal'/'writer_nonce_carriage') whose required methods are NOT
  // actually all present (declared-but-inconsistent) — a construction-time wiring defect, never
  // a runtime condition. Undeclared is always silent success (the honest floor); this code is
  // reserved for the declared-but-lying case only.
  | 'TRACE_CAPABILITY_INCONSISTENT'
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
  retry_after?: number; // seconds; set only for SERVICE_RATE_LIMITED errors
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
  readonly retry_after?: number;

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
    if (options.retry_after !== undefined) this.retry_after = options.retry_after;
  }
}
