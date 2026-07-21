// Types for an active or historical workflow run record stored on disk.
import type { ToolCallRecord } from './mcp-types.js';
import type { ExtensionIdentityEntry } from './extension-identity.js';
import type { TriggerRule } from './workflow-definition.js';

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
  /**
   * Issue #185 (honest seal); issue #197 PR-2 (narrowed): the count of buffer/WAL lines adopted
   * into this canonical trace THAT CANNOT BE ATTRIBUTED to this claimant — i.e., adopted under
   * the ⊥ (bare/anonymous) writer class. Present ONLY when > 0. The agent trace buffer is not
   * owned by any one writer, so a bare-adopted line may have been appended by a PRIOR execution
   * attempt (e.g. a crashed run this one resumed) or by a CONCURRENT one racing on the same
   * (run, step). The engine records this as an honest fact rather than silently asserting single
   * authorship over content it cannot verify the provenance of. Absent (never `0` or `false`)
   * when canonical trace was built entirely from this execution's own `execute_step` submission,
   * or entirely from own-nonce-attributed lines (see `attributed_lines_adopted` below) — no
   * caveat is warranted there. For all-bare traffic (no client ever mints a `writer_nonce`) this
   * field is numerically IDENTICAL to its pre-#197 meaning — every buffered line was, and still
   * is, bare-adopted. Faithful per-writer separation shipped in #197: see
   * `attributed_lines_adopted` (own-nonce adoption, no caveat) and `foreign_lines_preserved`
   * (a different writer's lines, preserved not adopted) below.
   */
  buffered_lines_adopted?: number;
  /**
   * Issue #197 PR-2 (design §2/§6): count of buffer/WAL lines adopted under the SAME nonce this
   * claimant presented at claim time. Present ONLY when > 0. Unlike `buffered_lines_adopted`,
   * this carries NO caveat — wording (verbatim, never varied): "writer continuity verified (same
   * nonce as presented at claim); strength conditional on nonce secrecy." NEVER worded as
   * "attribution is faithful" — a leaked/guessed nonce lets a different writer's lines pass this
   * same check, so the guarantee is conditional on the nonce actually staying secret to its
   * minter, not an unconditional identity proof.
   */
  attributed_lines_adopted?: number;
  /**
   * Issue #197 PR-2 (design §2/§4): count of buffer/WAL lines found at this claimant's read that
   * belong to a DIFFERENT writer (nonce mismatch, including a bare claimant seeing nonced lines
   * or vice versa) — PRESERVED (sealed, on a store that supports it), never adopted into
   * canonical evidence, never merged, never gating this claimant's `trace_schema` enforce check.
   * Present ONLY when > 0. Retrieve the preserved content via `realm run export`. Foreign nonce
   * VALUES never appear anywhere in this record or any envelope — only this count.
   */
  foreign_lines_preserved?: number;
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
  /**
   * Issue #220: stamped on a SUCCESS settle evidence snapshot when the step's accrued
   * `RunRecord.validation_rejections` count was > 0 at settle time ("succeeded after N
   * rejections") — free diagnostic, never gates anything. Also present on the synthesized
   * evidence snapshot a `VALIDATION_EXHAUSTED` terminalization mints (the just-persisted count),
   * and on the synthesized SUCCESS snapshot a declared default-settle mints (issue #220 PR-2 —
   * see `settled_by_default` below). Optional-additive: absent on every pre-#220 snapshot and on
   * any snapshot for a step that was never rejected.
   */
  validation_rejections?: number;
  /**
   * Issue #220 PR-2 (declared fail-open): `true` on the ONE synthesized SUCCESS evidence snapshot
   * minted when a step's exhausted schema-rejection budget is settled via its declared
   * `validation_exhaustion.default_output` rather than by the agent's own submission. Never present
   * on any other snapshot (absent, never `false`) — a step that succeeded on its own submission,
   * even one that previously accrued rejections, carries only `validation_rejections` here.
   */
  settled_by_default?: boolean;
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
   * Optional agent-submitted reasoning or diagnostic notes.
   * Extracted from params._debug before schema validation — never validated, never hashed.
   * Present only when the agent included _debug in their execute_step params.
   */
  debug_output?: unknown;
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
   * The timeout (in seconds) actually enforced on THIS ATTEMPT's dispatch (issue A3; issue #140
   * amends the semantics — see below): the authored timeout_seconds if declared, else
   * DEFAULT_EXECUTION_TIMEOUT_SECONDS. Present ONLY when shouldEnforceTimeout(step) was true
   * (execution: auto) — additive-optional, so absent on every pre-existing snapshot and on
   * agent/guard/finalizer steps, which are never bounded by withTimeout.
   *
   * Issue #140: on a retry-configured step this is now a PER-ATTEMPT value, not a single
   * step-wide constant — a later attempt's value can be SMALLER than an earlier attempt's once
   * the step's total-time cap (`clipped_to_ms` below) starts biting. On a step with no `retry:`
   * block (or one whose cap hasn't bitten yet) every attempt's value is identical to the
   * step's own declared/default timeout, byte-unchanged from pre-#140 behavior.
   */
  effective_timeout_seconds?: number;
  /**
   * Issue #140: present ONLY on an attempt whose effective timeout was CLIPPED below the step's
   * own declared/default `timeout_seconds` by its total-time cap (`retry.total_timeout_seconds`,
   * explicit or the amended default) — the actual millisecond bound this attempt was clipped to.
   * Absent on an uncapped attempt or one the cap hasn't started biting on yet.
   */
  clipped_to_ms?: number;
  /**
   * Issue #140: present ONLY on the FINAL attempt's snapshot of a step that stopped retrying
   * because either its attempt budget or its total-time cap ran out — `'attempts'` when
   * `attemptsUsed === maxAttempts` drove the stop, `'total_timeout'` when the cap did (wins the
   * both-true tie). Durable even when the settle path does NOT wrap the error into
   * `STEP_RETRY_EXHAUSTED` (the issue #134 recoverable-incapability carve-out never wraps) — this
   * evidence stamp is then the only record of *why* the step stopped.
   */
  exhausted_by?: 'attempts' | 'total_timeout';
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

/**
 * Per-claim liveness record (issue #101). Written atomically when a step is claimed.
 */
export interface ClaimRecord {
  /**
   * ISO-8601 timestamp after which the claim is presumed stale (a likely-dead runner), or
   * `null` when the claim has no reliable wall-clock bound — an `execution: agent` step (its
   * dispatcher returns instantly; `timeout_seconds` is advisory), or ANY step in a
   * finalizer-bearing workflow (its claim can legitimately span the terminal finalizer drain).
   * A `null` deadline surfaces as `claim_unknown_age`: detect-only, human-judged, never
   * auto-reclaimed. A concrete deadline is set only for reliably time-boundable claims.
   */
  deadline: string | null;
}

/**
 * A recoverable-incapability marker (issue #134), keyed by step name in {@link RunRecord.capability_blocks}.
 * Written when an auto step's handler/adapter is NOT REGISTERED in the executing runner's registry: the
 * step settles RECOVERABLY (removed from `in_progress_steps`, claim omitted, NOT added to `failed_steps`,
 * run NOT terminal-sealed) so a correctly-provisioned runner can reclaim it. Advisory metadata for
 * DETECTION and operator diagnostics ONLY — the four step sets stay authoritative for eligibility, so a
 * stale marker (step since completed on another runner) self-suppresses via the eligibility cross-check in
 * `findCapabilityBlockedSteps`. Clearing it on recovery is hygiene, not correctness. Additive-optional (the
 * `claims` / `extension_identity` precedent): legacy records lack it; JSON-file-store-only until external
 * stores round-trip unknown optional RunRecord fields through update().
 */
export interface CapabilityBlock {
  requirement: { kind: 'handler' | 'adapter'; name: string };
  /** The minted discriminator: `ENGINE_HANDLER_NOT_REGISTERED` | `ENGINE_ADAPTER_NOT_REGISTERED`. */
  code: string;
  /** ISO-8601 timestamp of the block. */
  at: string;
}

/**
 * Reason a step landed in `skipped_steps` (issue #111), keyed by step name in
 * {@link RunRecord.skip_details}. Additive-optional, definition-free surfacing metadata —
 * `skipped_steps` stays the authoritative set; this only explains *why*.
 */
export type SkipDetail =
  | {
      kind: 'when_false';
      /** The step's `when` clause, verbatim (a single leaf or the joined array). */
      expression: string;
      /** Every leaf's evaluation, in declaration order — not just the first false one. */
      leaves: Array<{
        leaf: string;
        /** False when the LHS path resolved to `undefined` (a miss — commonly a field-name typo). */
        lhs_present: boolean;
        /** Omitted (not `undefined`) when `lhs_present` is false, so absence survives a JSON round-trip. */
        resolved_value?: unknown;
        passed: boolean;
      }>;
    }
  | {
      kind: 'trigger_rule_unsatisfiable';
      rule: TriggerRule;
      /** The deps whose settled state makes the rule provably unsatisfiable. */
      blocking_deps: Array<{ dep: string; state: 'completed' | 'failed' | 'skipped' }>;
    }
  | { kind: 'handler_abort' }
  | { kind: 'guard_abort' };

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
   * Reason detail for each skipped step (issue #111), keyed by step name. Additive-optional
   * (the `claims`/`capability_blocks` precedent): absent on legacy records. `skipped_steps`
   * stays authoritative — `Object.keys(skip_details) ⊆ skipped_steps` always, but a skipped step
   * MAY lack a detail entry (surfacing renders "reason unavailable" for those). Never gate DAG
   * logic on this field.
   */
  skip_details?: Record<string, SkipDetail>;

  /**
   * Per-claim liveness clock (issue #101), keyed by step name. Written ATOMICALLY in
   * `claimStep` (the same write that adds the step to `in_progress_steps`) and deleted when the
   * step settles. Advisory metadata for wedge DETECTION and reclaim ONLY — `in_progress_steps`
   * stays authoritative for eligibility. Additive-optional (the `extension_identity` precedent):
   * legacy records lack it, so their in-progress claims classify as `claim_unknown_age`. A store
   * that drops this field must declare `persistsClaims: false` so liveness recovery loud-fails
   * rather than silently no-opping.
   */
  claims?: Record<string, ClaimRecord>;

  /**
   * Recoverable-incapability markers (issue #134), keyed by step name. Written when an auto step's
   * handler/adapter is not registered in the executing runner's registry — see {@link CapabilityBlock}.
   * Advisory DETECTION metadata only; the four step sets stay authoritative for eligibility.
   * Additive-optional (the `claims` precedent): absent on legacy records and capability-clean runs.
   */
  capability_blocks?: Record<string, CapabilityBlock>;

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
  /**
   * Append-on-change history of the project-extension code identity that executed this run
   * (issue #119). Each entry is captured at module-LOAD time by the CLI and appended lazily
   * by the execution loop when it differs from the last recorded entry. Advisory evidence —
   * WARN-never-gate. Absent for extension-free runs. JSON-file-store-only until external
   * stores round-trip unknown optional RunRecord fields through update().
   */
  extension_identity?: ExtensionIdentityEntry[];
  /**
   * PID of the agent process spawned by 'realm listen' for this run.
   * Set after a successful spawn. Absent for runs not started by a webhook trigger.
   * May be stale if the agent has exited — use for diagnostic purposes only.
   */
  agent_pid?: number;
  /**
   * ISO-8601 timestamp when the agent process was spawned.
   * Set by 'realm listen' after a successful spawn.
   */
  agent_started_at?: string;
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
  /**
   * ISO timestamp set when a run is explicitly abandoned via `abandon_run` / `realm run abandon` /
   * `realm run cleanup`. Authoritative for `deriveRunPhase`: its presence makes `abandoned` the
   * derived phase regardless of `failed_steps` / `terminal_reason` (mirrors `aborted_at`).
   */
  abandoned_at?: string;
  /**
   * Issue #220 (bounded validation exhaustion): per-step count of COUNTED validation rejections
   * — the closed set `{VALIDATION_INPUT_SCHEMA, VALIDATION_OUTPUT_SCHEMA}` on `execution: 'agent'`
   * steps only (`VALIDATION_TRACE_SCHEMA` and any non-agent rejection are never counted here; see
   * `countRejection` in execution-loop.ts for the full mechanism). Keyed by step name, POOLED
   * across concurrent writers/nonces (deliberate — the wedge-cure goal is run-level, not
   * per-writer fairness). NEVER reset: a settled step's count is a permanent, structurally-costless
   * fact about this run (settled steps simply leave the eligible set — see the #221 derivation
   * note, TD-R12, for the reader-side "meaningful only against unsettled state" caveat).
   * Additive-optional (the `claims`/`capability_blocks` precedent): absent on legacy records and
   * on any run with zero counted rejections so far.
   */
  validation_rejections?: Record<string, number>;
  /**
   * Issue #220 PR-2 (run-level disclosure, pin r): names of steps that settled via their declared
   * `validation_exhaustion.default_output` substitution rather than the agent's own submission —
   * a run-level convenience aggregate over the per-step `EvidenceSnapshot.diagnostics
   * .settled_by_default` truth. Present only when non-empty; stamped ONLY on the terminal
   * `'complete'`-sealed record by `stampDefaultedSteps` (see execution-loop.ts) — a run that later
   * FAILS after a mid-workflow default-settle does NOT carry this field (the per-step evidence
   * snapshot remains the durable per-step truth regardless; this is a named residual, not a false
   * statement — see the design record). Additive-optional (the `validation_rejections` precedent).
   */
  defaulted_steps?: string[];
}
