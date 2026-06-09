// Types for an active or historical workflow run record stored on disk.
import type { ToolCallRecord } from './mcp-types.js';

/**
 * A single trace entry submitted by the agent. Submitted as-is; the engine
 * canonicalizes and assigns seq before persisting.
 */
export interface AgentTraceEntry {
  event: string;
  timestamp?: string | undefined;
  data?: Record<string, string | number | boolean | null> | undefined;
}

/**
 * A single stored trace entry after canonicalization.
 * seq is engine-assigned: 1-based, monotonically increasing in stored order.
 */
export interface TraceEntry {
  seq: number;
  event: string;
  timestamp?: string;
  data?: Record<string, string | number | boolean | null>;
}

/** Discard and truncation accounting produced by the trace normalizer. */
export interface TraceNormalizationSummary {
  submitted_entries: number;
  stored_entries: number;
  discarded_entries: number;
  discarded_reserved_event_entries: number;
  discarded_overflow_entries: number;
  truncated: boolean;
  truncation_reason?: 'count_limit' | 'byte_limit';
  /** Whether trace_schema validation was applied to the canonical entries. */
  schema_applied?: boolean;
  /** Validation mode that was applied ('warn' or 'enforce'). Present when schema_applied is true. */
  validation_mode?: 'warn' | 'enforce';
  /** Number of Ajv validation errors found. Zero means schema-conformant. Present when schema_applied is true. */
  validation_errors?: number;
}

/** Diagnostic metadata captured during step execution. Written once; read by inspect. */
export interface StepDiagnostics {
  /** Rough token count estimate: Math.ceil(JSON.stringify(input).length / 4) */
  input_token_estimate: number;
  /** Ordered list of precondition evaluations for this step. Empty array if no preconditions. */
  precondition_trace: Array<{
    expression: string;
    passed: boolean;
    resolved_value: unknown;
  }>;
}

export interface EvidenceSnapshot {
  step_id: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  input_summary: Record<string, unknown>;
  output_summary: Record<string, unknown>;
  status: 'success' | 'error' | 'skipped' | 'abandoned';
  error?: string;
  evidence_hash: string;
  attempt?: number;
  /** Distinguishes computation records from human decision records. Absent on pre-existing entries. */
  kind?: 'execution' | 'gate_response';
  /**
   * Verbatim message presented to the human reviewer when they made this gate choice.
   * Present only on gate_response evidence entries when gate.message was configured.
   * This is an evidence integrity field: it records exactly what the human read.
   */
  gate_message?: string;
  /** Diagnostic metadata. Present on snapshots captured after Week 7. */
  diagnostics?: StepDiagnostics;
  /** Name of the agent profile active at this step, if any. */
  agent_profile?: string;
  /** SHA-256 hash of the profile content at register time. Auditable even if the file changes. */
  agent_profile_hash?: string;
  /** MCP tool calls made during this step, if any. */
  tool_calls?: ToolCallRecord[];
  /**
   * Present only when the step used input_map. Records the concrete params the engine
   * derived from run state and passed to the service adapter. Absent for all other step types.
   */
  resolved_params?: Record<string, unknown>;
  /**
   * Warning message emitted by the step handler. Present when the handler returned
   * a warn result. The step completed normally; this is advisory only.
   * Never included in evidence_hash.
   */
  warn?: string;
  /**
   * Canonical stored trace entries for this step. Present only on agent execution steps
   * when the agent submitted a non-empty trace that survived normalization.
   * Excludes evidence_hash computation — integrity is tracked separately via trace_digest.
   */
  trace?: TraceEntry[];
  /**
   * SHA-256 hex digest of JSON.stringify(trace). Present when trace is non-empty.
   * Separate from evidence_hash, which covers output_summary only.
   */
  trace_digest?: string;
  /**
   * Discard and truncation accounting from the trace normalizer.
   * Present whenever the agent submitted a trace (even if all entries were dropped).
   * Absent when no trace was submitted.
   */
  trace_summary?: TraceNormalizationSummary;
  /**
   * Optional agent-submitted reasoning or diagnostic notes.
   * Extracted from params._debug before schema validation — never validated, never hashed.
   * Present only when the agent included _debug in their execute_step params.
   * Treat as engineering aid; do not rely on its structure.
   */
  debug_output?: unknown;
}

export interface PendingGate {
  gate_id: string;
  step_name: string;
  /** Output produced by the step dispatcher; presented to the human for review. */
  preview: Record<string, unknown>;
  choices: string[];
  opened_at: string;
  /**
   * Slack user ID or handle declared on the step's gate config.
   * Optional — absent when the workflow step has no owner field.
   */
  owner?: string;
  /**
   * Developer-authored gate message resolved from run data at gate-open time.
   * Present only when gate.message is configured on the step. Never derived from step.prompt.
   * Preserved into EvidenceSnapshot.gate_message at gate resolution for audit purposes.
   */
  resolved_message?: string;
  /**
   * Per-choice messages for Slack thread resolution confirmation.
   * Copied verbatim from gate.resolution_messages on the step definition.
   * The CLI reads the message for the chosen key and posts it to the thread.
   */
  resolution_messages?: Record<string, string>;
}

/**
 * Derived phase of a workflow run. Always computed from the four step sets and run state;
 * never set directly by callers outside the engine.
 */
export type RunPhase =
  | 'running'
  | 'gate_waiting'
  | 'completed'
  | 'failed'
  | 'abandoned'
  | 'aborted';

/** Snapshot of a single workflow context entry taken at run start. */
export interface WorkflowContextSnapshot {
  /** Absolute path the content was read from. */
  source_path: string;
  /** Raw file content. Empty string if the file could not be read. */
  content: string;
  /** SHA-256 hex hash of content. Empty string if the file could not be read. */
  content_hash: string;
  /** ISO timestamp when the snapshot was taken. */
  loaded_at: string;
  /** Set when the file could not be read. Content and hash will be empty strings. */
  error?: string;
}

export interface RunRecord {
  id: string;
  workflow_id: string;
  workflow_version: number;
  /**
   * Run ID of the parent run that spawned this run via start_run_batch.
   * Absent for top-level runs.
   */
  parent_run_id?: string;
  /**
   * Caller-supplied deduplication key. When provided at creation time,
   * the store returns the existing run if one with the same (workflow_id, idempotency_key)
   * already exists instead of creating a new one.
   */
  idempotency_key?: string;

  // DAG execution state — replaces the single `state: string` field.
  completed_steps: string[];
  in_progress_steps: string[];
  failed_steps: string[];
  /** Steps whose trigger_rule can no longer be satisfied; recorded for auditability. */
  skipped_steps: string[];

  /**
   * Derived convenience field — set by the engine on every write, read by CLI and get_run_state.
   * Always computable from the four step sets, terminal_state, and pending_gate.
   */
  run_phase: RunPhase;

  version: number;
  params: Record<string, unknown>;
  evidence: EvidenceSnapshot[];
  /**
   * Snapshots of workflow context files loaded at run start.
   * Keyed by entry name. Separate from step evidence — not in evidence[].
   */
  workflow_context_snapshots?: Record<string, WorkflowContextSnapshot>;
  created_at: string;
  updated_at: string;
  terminal_state: boolean;
  terminal_reason?: string;
  pending_gate?: PendingGate;
  /**
   * Set by the engine when a guard step fires. Contains the name of the guard step
   * that caused the abort and its evaluated conditions. Used by deriveRunPhase
   * and surfaced by get_run_state.
   */
  aborted_at?: {
    step_id: string;
    conditions?: Array<{ condition: string; resolved_value: unknown; passed: boolean }>;
    abort_message?: string;
  };
}
