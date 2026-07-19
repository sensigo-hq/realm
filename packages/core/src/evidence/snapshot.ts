// Standalone evidence capture utility — builds an EvidenceSnapshot from step execution data.
import { createHash } from 'node:crypto';
import type { EvidenceSnapshot, StepDiagnostics, AgentTraceEntry } from '../types/run-record.js';
import type { ToolCallRecord } from '../types/mcp-types.js';
import { normalizeTrace } from '../engine/trace-normalizer.js';
import type { NormalizeTraceResult } from '../engine/trace-normalizer.js';

export interface CaptureEvidenceParams {
  stepId: string;
  startedAt: Date;
  completedAt: Date;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error?: string;
  diagnostics?: StepDiagnostics;
  agentProfile?: string;
  agentProfileHash?: string;
  resolvedParams?: Record<string, unknown>;
  /** MCP tool calls made during this step. Absent = callStep path; present = callStepWithTools path. */
  toolCalls?: ToolCallRecord[];
  /**
   * Agent-submitted trace entries. When present (even empty array), the normalizer runs
   * and trace_summary is always recorded. Entries surviving normalization are stored as trace.
   * evidence_hash is unaffected — it covers output_summary only.
   * Ignored when normalizedTrace is provided.
   */
  trace?: AgentTraceEntry[];
  /**
   * Pre-normalized trace result from the execution loop. When provided, used directly
   * in place of calling normalizeTrace on raw trace entries. Allows the execution loop
   * to run schema validation on canonical entries before evidence capture without
   * re-normalizing. Takes precedence over the raw trace field.
   */
  normalizedTrace?: NormalizeTraceResult;
  /** Warning message from the step handler. Stamped onto the snapshot when present. Not hashed. */
  warn?: string;
  /** Agent-submitted reasoning extracted from _debug. Not hashed. */
  debugOutput?: unknown;
  /**
   * The timeout (in seconds) actually enforced on THIS ATTEMPT's dispatch (issue A3). Pass only
   * when shouldEnforceTimeout(step) was true for this step; omit otherwise (additive-optional).
   * Issue #140: on a retry-configured step this is now a PER-ATTEMPT value the caller re-derives
   * every attempt (it may shrink across attempts once the step's total-time cap starts clipping)
   * — see EvidenceSnapshot.effective_timeout_seconds for the full amended contract.
   */
  effectiveTimeoutSeconds?: number;
  /**
   * Issue #140: the millisecond bound THIS attempt was clipped to by the step's total-time cap.
   * Pass only when the cap actually reduced this attempt's bound below the step's own
   * declared/default timeout; omit otherwise (additive-optional) — see
   * EvidenceSnapshot.clipped_to_ms.
   */
  clippedToMs?: number;
}

/** Builds an EvidenceSnapshot from step execution parameters, including a SHA-256 content hash.
 *
 * evidence_hash is computed from output_summary only and is unaffected by trace.
 * trace_digest (when present) covers the canonical trace array separately.
 */
export function captureEvidence(params: CaptureEvidenceParams): EvidenceSnapshot {
  // evidence_hash: hash of output only — behavior unchanged.
  const evidenceHash = createHash('sha256').update(JSON.stringify(params.output)).digest('hex');

  // Trace normalization: prefer pre-normalized result when available (avoids double normalization
  // when the execution loop already normalized for schema validation). Fall back to raw trace.
  let traceEntry: Pick<EvidenceSnapshot, 'trace' | 'trace_digest' | 'trace_summary'> = {};
  if (params.normalizedTrace !== undefined) {
    const { entries, digest, summary } = params.normalizedTrace;
    if (entries.length > 0 && digest !== undefined) {
      traceEntry = { trace: entries, trace_digest: digest, trace_summary: summary };
    } else {
      traceEntry = { trace_summary: summary };
    }
  } else if (params.trace !== undefined) {
    const { entries, digest, summary } = normalizeTrace(params.trace);
    if (entries.length > 0 && digest !== undefined) {
      traceEntry = { trace: entries, trace_digest: digest, trace_summary: summary };
    } else {
      traceEntry = { trace_summary: summary };
    }
  }

  return {
    step_id: params.stepId,
    started_at: params.startedAt.toISOString(),
    completed_at: params.completedAt.toISOString(),
    duration_ms: params.completedAt.getTime() - params.startedAt.getTime(),
    input_summary: params.input,
    output_summary: params.output,
    status: params.error !== undefined ? 'error' : 'success',
    ...(params.error !== undefined ? { error: params.error } : {}),
    evidence_hash: evidenceHash,
    ...(params.diagnostics !== undefined ? { diagnostics: params.diagnostics } : {}),
    ...(params.agentProfile !== undefined ? { agent_profile: params.agentProfile } : {}),
    ...(params.agentProfileHash !== undefined
      ? { agent_profile_hash: params.agentProfileHash }
      : {}),
    ...(params.resolvedParams !== undefined ? { resolved_params: params.resolvedParams } : {}),
    ...(params.warn !== undefined ? { warn: params.warn } : {}),
    ...(params.debugOutput !== undefined ? { debug_output: params.debugOutput } : {}),
    ...(params.toolCalls !== undefined ? { tool_calls: params.toolCalls } : {}),
    ...(params.effectiveTimeoutSeconds !== undefined
      ? { effective_timeout_seconds: params.effectiveTimeoutSeconds }
      : {}),
    ...(params.clippedToMs !== undefined ? { clipped_to_ms: params.clippedToMs } : {}),
    ...traceEntry,
  };
}
