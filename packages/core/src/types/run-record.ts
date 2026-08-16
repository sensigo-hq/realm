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

/**
 * Issue #236 (L0 prevention layer) — the observables-only disclosure vocabulary for a
 * `structured_output: 'strict'`-declared step's attempt. Deliberately carries NO `applied`
 * field (unwitnessable — a silently-stripping proxy could accept `strict` on the wire and never
 * honor it; `sent` only ever claims "realm placed strict on the request handed to the SDK", never
 * that the API enforced it). Per-attempt: a retry-configured step's evidence array can carry a
 * different value per attempt. `requested` is always `true` when this object is present at all —
 * it exists ONLY on a step that declared `structured_output: 'strict'`.
 *
 * SCOPE (issue #311 truth pass): every field on this object EXCEPT `tool_args` describes ONE
 * dimension — the step's own OUTPUT request (the submit tool realm sends for the step's answer).
 * That was the only dimension #236 shipped, so the original wording did not need to say so;
 * it does now. `tool_args` describes the independent TOOL-ARGUMENTS dimension, and the two
 * legitimately disagree on the same attempt: a tools-bearing step is permanently
 * `sent: false` / `unsupported_context_tools` at the OUTPUT level while simultaneously carrying
 * genuine per-tool `strict_sent: true` entries under `tool_args`. When reading a single field,
 * check which dimension it belongs to before concluding "strict was off".
 */
export interface StructuredOutputMeta {
  /** Always `true` — this object's mere presence already implies it; kept explicit so a reader
   *  never has to special-case "object present but requested:false". */
  requested: true;
  /** Whether realm actually placed `strict: true` on the request it handed to the SDK for the
   *  attempt THIS diagnostics object describes. Issue #316 correction: a synthesized stamp
   *  (`external_agent`) sets this to `false` explicitly — never absent — since no request was
   *  ever made by realm at all; all three mint sites (execution-loop.ts) construct
   *  `{requested: true, sent: false, downgrade_reason: 'external_agent'}` verbatim. */
  sent?: boolean;
  /** Caveat codes from `assessStructuredOutputEligibility`'s `eligible_with_caveats` verdict —
   *  present whenever the Phase-B eligibility verdict carried them, REGARDLESS of what the live
   *  attempt then did (issue #332 correction: the mint is right, this doc was wrong). The verdict
   *  is computed once, at eligibility time (run-agent.ts:498-502), and its caveats are spread
   *  onto the meta unconditionally (run-agent.ts:690-695) — including onto a `sent: false` meta
   *  when the schema passed eligibility but the LIVE call then downgraded (a 400/503). `caveats`
   *  therefore records an eligibility-time fact about the SCHEMA; `sent`/`downgrade_reason`
   *  record the ATTEMPT's own outcome — the two can legitimately co-occur, and a reader
   *  disambiguates via the co-present fields, never via caveats' mere presence. Never present on
   *  a `gate_ineligible`/`external_agent` attempt (no eligibility verdict with caveats was ever
   *  computed for either). */
  caveats?: string[];
  /**
   * Why `sent` is `false` (absent when `sent` is `true`):
   * - `gate_ineligible` — the Phase-B verdict was `ineligible`; strict was never attempted.
   * - `api_rejected_schema` — a live 400 on a strict-carrying request; realm dropped strict and
   *   retried once.
   * - `grammar_unavailable` — a live 503 whose message matched Anthropic's captured
   *   grammar-compilation-unavailable text.
   * - `service_unavailable` — a live 503 that did NOT match the grammar text (a generic overload
   *   — fail-safe default label for any non-matching 503).
   * - `provider_unsupported` — the configured LLM provider does not implement `callStepWithMeta`
   *   (a third-party `--provider-module` that only implements the base `callStep`). Both in-repo
   *   strict-capable providers override it, so at the STEP level this now names third-party
   *   modules specifically.
   * - `unsupported_context_tools` — the step declares `tools`, so its OUTPUT is produced on the
   *   tools path, where realm sends no grammar-constrained submit call. That is a PER-PROVIDER
   *   DESIGN DECISION, not an API limitation: composing a step-output grammar with strict tool
   *   arguments in one request is unprobed on both providers, and doing it blind would make a
   *   400 impossible to attribute to the right dimension. A future version wanting it starts
   *   with the probe. Issue #311 truth pass: this no
   *   longer means "strict is unsupported on this step" — strict may well have been attached to
   *   that step's TOOL-CALL ARGUMENTS on the very same attempt (see `tool_args`). It means only
   *   that the step's own output was not grammar-constrained.
   * - `external_agent` — the step declared `structured_output: 'strict'` but was driven by
   *   something other than `realm agent` (e.g. an external agent calling `execute_step` over
   *   MCP directly) — no `stepMeta.structuredOutput` was ever attached, so realm cannot know
   *   whether strict was honored at all.
   * - `compat_endpoint` (issue #313) — the provider is pointed at an OpenAI-COMPATIBLE endpoint
   *   via `--base-url`, and the author has not attested that it enforces strict. Realm declines
   *   to send strict rather than send it into an endpoint that may accept and ignore it. The
   *   remedy is `--strict-base-url` (an author attestation) or a native endpoint. Unlike
   *   `external_agent`, this is realm's own CHOICE, which is why the run-health finding
   *   includes it.
   */
  downgrade_reason?:
    | 'gate_ineligible'
    | 'api_rejected_schema'
    | 'grammar_unavailable'
    | 'service_unavailable'
    | 'provider_unsupported'
    | 'unsupported_context_tools'
    | 'external_agent'
    | 'compat_endpoint';
  /** The raw API error message, when a live 400/503 drove a downgrade — attached verbatim,
   *  never rewritten, so an operator can compare against the provider's own documented error text. */
  api_message?: string;
  /**
   * Issue #313 — the provider's own machine-readable error fields, captured VERBATIM alongside
   * `api_message` when a live 400 drove a downgrade. `null` is meaningful and preserved: OpenAI
   * returns `param: null, code: null` for the model-unsupported class (probe P8), where the
   * message is prose-only. Realm never KEYS any decision on these — they are capture-only, for
   * an operator comparing against the provider's documented error taxonomy.
   */
  api_param?: string | null;
  api_code?: string | null;
  /**
   * Issue #313 — which provider produced this attempt. Minted at a single run-agent chokepoint,
   * so every meta run-agent writes carries it.
   *
   * The open `module:${string}` member names a third-party `--provider-module` by its module
   * basename: such providers are assessed under the ANTHROPIC rule profile (realm cannot know a
   * module's strict dialect), and this field is what makes that assumption detectable if the
   * module in fact targets a different API.
   *
   * BY CONSTRUCTION absent on the engine's synthesized `external_agent` stamps: realm did not
   * drive those attempts, so it has no provider to name.
   */
  provider?: 'anthropic' | 'openai' | 'openai-reasoning' | `module:${string}`;
  /** Whether the model's output arrived via the submit tool (`tool_use.input`, pre-parsed) or as
   *  extracted text — the standing dodge detector (design record R-B): a schema shaped to make
   *  the model prefer a text answer over the strict-constrained tool would show up here. */
  submission_channel?: 'tool' | 'text';
  /**
   * Issue #311 — the TOOL-ARGUMENTS dimension. Present only on a `structured_output: 'strict'`
   * step that ran the tools path with at least one declared tool.
   *
   * Read this alongside the step-level fields above, which describe a DIFFERENT question. The
   * step-level `sent`/`downgrade_reason` answer "did realm grammar-constrain this step's own
   * OUTPUT?" — on the tools path that answer is permanently no (`unsupported_context_tools`),
   * because the step's output still arrives through the unconstrained submit/extraction path.
   * `tool_args` answers "did realm grammar-constrain the ARGUMENTS realm's model passes to each
   * MCP tool?", which on the same attempt can be yes for some tools and no for others. The two
   * co-occur by design; neither supersedes the other.
   *
   * Enforcement caveat: a strict grammar constrains what the model can EMIT. There is no Ajv on
   * the tools path — realm does not post-hoc validate tool arguments — so for any tool that
   * rides unconstrained, enforcement falls entirely to the MCP server at call time. Strict's
   * guarantee also covers tool-NAME selection, not arguments alone.
   *
   * One entry per DECLARED tool, in declared order, whether or not strict was attached to it.
   */
  tool_args?: {
    tools: Array<{
      /** The bare tool name as declared by the MCP server (the wire name). */
      name: string;
      /** Always `true` — present iff this entry exists (house style, mirroring `requested`). */
      strict_requested: true;
      /** Whether realm placed `strict: true` on THIS tool in the request it handed to the SDK —
       *  the FINAL posture of the attempt (a mid-attempt drop rewrites this to `false`). Same
       *  observables-only discipline as `sent`: never a claim that the API honored it. */
      strict_sent: boolean;
      /**
       * Why strict was not attached (or was dropped). Plural — codes co-occur. Values are the
       * verdict codes from `assessStructuredOutputEligibility` verbatim
       * (`no_schema` | `missing_additional_properties` | `unsupported_keyword` |
       * `too_many_optionals` | `too_many_unions` | `unsupported_context_tools`), plus these
       * non-verdict literals:
       * - `budget_excluded` — eligible, but the API's per-request limits (≤20 strict tools,
       *   ≤24 summed optional properties) were already spent by earlier declared tools.
       * - `api_rejected_schema` — a live 400 on a strict-carrying request dropped strict for
       *   this step's tools.
       * - `grammar_unavailable` — a live 503 matching the grammar-compilation-unavailable text.
       * - `service_unavailable` — a live 503 that did not match it (fail-safe generic label).
       * - `provider_unsupported` — the configured provider does not place per-tool strict on the
       *   wire at all, so strict was never attached to ANY tool on this attempt and no per-tool
       *   eligibility was assessed. Since issue #313 both in-repo tool-capable providers DO place
       *   it, so at the per-tool level this now names third-party `--provider-module` providers
       *   specifically. Reuses the step-level literal of the same name.
       * - `compat_endpoint` (issue #313) — the provider is pointed at an OpenAI-compatible
       *   endpoint without the `--strict-base-url` attestation, so no tool was sent strict. An
       *   ENDPOINT fact, never conflated with `provider_unsupported`: this provider CAN place the
       *   marker, realm chose not to have it do so here.
       * - `not_all_required` (issue #313) — an OpenAI-profile verdict code: a property outside
       *   `required`. Reached on the tools path whenever an OpenAI-driven step assesses a tool
       *   schema; it is the dominant per-tool ineligibility code on that profile.
       * - `exceeds_provider_limit` (issue #313) — an OpenAI-profile verdict code: the schema
       *   exceeds a documented size limit (nesting depth, property count, total characters, or
       *   enum values). The specific limit and measured value are in the verdict's remediation.
       */
      reasons?: string[];
      /** Caveat codes from this tool's own eligibility verdict (e.g. `unenforced_keyword`,
       *  `optional_emission`) — an eligibility-time fact about the tool's schema, independent of
       *  what the live attempt then did. */
      caveats?: string[];
    }>;
    /**
     * Present only when a live 400/503 dropped strict PART-WAY THROUGH this attempt. Absent on
     * an attempt that never attached strict at all — including every attempt after a sticky 400
     * (there was no drop to describe; the tools simply started unconstrained).
     */
    dropped_mid_attempt?: {
      /** `api_rejected_schema` | `grammar_unavailable` | `service_unavailable`. */
      reason: string;
      /** The raw API error message, verbatim. Lives HERE, never on the step-level
       *  `api_message` — that field describes the step-output dimension only. */
      api_message?: string;
      /** Issue #313 — the provider's machine-readable error fields, captured verbatim beside
       *  `api_message` (same capture-only, never-keyed discipline as the step-level pair).
       *  Minted by the OpenAI tools ladder; `null` is preserved and meaningful. */
      api_param?: string | null;
      api_code?: string | null;
      /** How many strict-decorated requests returned 200 before the drop. `0` means the very
       *  first strict-carrying turn of this attempt was rejected. */
      strict_turns_before_drop: number;
    };
  };
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
  /** Issue #236 — disclosure for a `structured_output: 'strict'`-declared step's attempt. See
   *  {@link StructuredOutputMeta}. Absent on a step that never declared `structured_output`. */
  structured_output?: StructuredOutputMeta;
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
  /**
   * Issue #279 (increment 2, PR-D; design record D-5): unenforced attribution passthrough for a
   * gate resolution — the caller-supplied identity of whoever made this gate choice, when
   * supplied. RECORDED, not enforced (D-5: the bearer-gateId-as-sole-credential model stays the
   * authority; no arm reads this field). Present only on `gate_response` evidence entries whose
   * caller supplied `respondedBy`/`responded_by`.
   */
  responded_by?: string;
  /**
   * Issue #291 (D1 §5 / [F12]): present only on a `gate_response` snapshot minted by
   * `applyExpireGate` — discriminates WHICH enforce-clock disposition produced this snapshot,
   * for the late-response envelope strings to read. `responded_by` on the SAME snapshot is
   * always the literal `'timeout'` when this field is present (never a human identity).
   */
  resolution?: 'expired_default' | 'expired_abort';
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
  /**
   * Issue #291 (mint-time freeze, F2 — the definition-drift-livelock cure): the gate's own
   * `GateConfig` timeout/notify fields, denormalized into the RECORD at mint
   * (execution-loop.ts's gate-open site — the `ClaimRecord.deadline`/#302 uniform-epoch-freeze
   * precedent). Every enactment/notification/read-side surface reads THESE fields, never the
   * workflow definition's `gate:` block — a definition edited after this gate opened (new
   * `choices`, a changed `default_choice`) never applies to an already-open gate. A gate minted
   * before this feature shipped (or by an old binary that silently ignored these `gate:`
   * sub-keys) has NONE of these fields — grandfathered: finding-silent, reminder-silent, never
   * enacted (R-d).
   */
  /** ISO-8601 deadline = `opened_at + gate.timeout_seconds`. Absent = no enforce clock (the gate
   *  never expires — grandfathered or the author declared no `timeout_seconds`). */
  expires_at?: string;
  /** Frozen copy of `gate.on_expiry`. Present only when `expires_at` is (a `timeout_seconds` with
   *  no `on_expiry` is LEGAL finding-only mode: `expires_at` present, this absent). */
  on_expiry?: 'settle_default' | 'abort';
  /** Frozen copy of `gate.default_choice`. Present iff `on_expiry === 'settle_default'`. */
  default_choice?: string;
  /** Frozen copy of `gate.reminder_seconds` — the authored notify clock. Standalone-legal
   *  (present without `expires_at` = a pure-notify gate). Absent = no authored reminder (the
   *  operator's `reminderIntervalMs` config, if any, is the fallback — record-keyed precedence). */
  reminder_seconds?: number;
  /** Frozen copy of `gate.reminder_max`, defaulted to 3 at mint when `reminder_seconds` is
   *  present and the author declared no explicit value. Absent iff `reminder_seconds` is. */
  reminder_max?: number;
}

/**
 * Derived phase of a workflow run. Always computed from the four step sets and run state;
 * never set directly by callers outside the engine.
 */
export type RunPhase =
  'running' | 'gate_waiting' | 'completed' | 'failed' | 'abandoned' | 'aborted';

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
  /**
   * Issue #279 (increment 1, PR-A): an acquirer-minted fencing token, stamped atomically in the
   * SAME `claimStep` write that creates this claim record (uuid; each store's own existing uuid
   * idiom). Additive-optional — legacy/pre-#279 claim records lack it, and `settleStep`'s
   * `tokensEqual` predicate treats absent as `null` (absent≡absent — the #197 grandfathered-claims
   * precedent), so a token-less claim is never spuriously fenced out. Dormant in this PR: nothing
   * reads or compares it until PR-B migrates the seal sites to `settleStep`.
   */
  token?: string;
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
  | { kind: 'guard_abort' }
  /**
   * Issue #279 (increment 1, PR-A): stamped on a human-gated step whose gate was still open when
   * a DIFFERENT step's handler aborted the run — `applySettlement`'s settle_step abort arm cancels
   * the gate in the SAME atomic write (design record §3) rather than leaving it stranded open on
   * an otherwise-terminal run. A genuinely NEW capability the pre-#279 legacy handler-abort path
   * lacks (it preserves `pending_gate` untouched, which is exactly the class of inconsistent
   * terminal-with-an-open-gate state #279 exists to close). Dormant until PR-B migrates the seal
   * sites — no engine call site can produce this in PR-A.
   */
  | {
      kind: 'gate_cancelled_by_abort';
      /**
       * Issue #279 (increment 2, PR-D; design record §5 D-4): the cancelled gate's `gate_id` —
       * additive, so pre-PR-D cancel records (which lack this field) remain valid; the settle_gate
       * `run_terminal` envelope's cancelled-variant discriminator binds by skip-detail PRESENCE for
       * those (N10), and by `gate_id` equality once this field is populated.
       */
      gate_id?: string;
    }
  /**
   * Issue #291 (F9, day-one gate_id): stamped on a gate's OWN step by `applyExpireGate`'s abort
   * disposition — the enforce clock expired and no human responded, so the run aborted per the
   * workflow's declared `on_expiry: 'abort'`. Distinct from `gate_cancelled_by_abort` (a
   * DIFFERENT step's handler-abort cancelling this gate) — that would falsely claim "cancelled
   * when '<other step>' aborted the run" for what is actually a timeout. `gate_id` is REQUIRED
   * (not optional, unlike the cancelled variant's grandfathered-record allowance) — this kind
   * was born with the field, so the run_terminal envelope's third discriminated variant binds by
   * id equality from birth, never by presence alone.
   */
  | { kind: 'gate_expired'; gate_id: string };

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
  /**
   * Issue #279 (increment 1, PR-A): per-step settlement record, keyed by step name — the durable
   * outcome of an `applySettlement` `settle_step` APPLY (`settlement.ts`; design record
   * `plans/issue-279/design-d4-increment1.md` §2/§3). `token` is the `claimToken` the settling
   * caller presented (`norm`-ed — `null` when the caller had none), used for the
   * `already_settled`/`already_settled_by_other` idempotence discrimination on a retry. `outcome`
   * uses `'skip'` (not `'abort'`) for an aborted step — it mirrors where the step PHYSICALLY
   * lands (`skipped_steps`), per the design record's `toSettledOutcome` mapping
   * (`complete↦'complete'`, `fail↦'fail'`, `abort↦'skip'`).
   *
   * ORPHAN RULE (design record §2 `entryOf`): an entry whose step is NOT (also) present in the
   * matching membership array (`completed_steps`/`failed_steps`/`skipped_steps` per its own
   * `outcome`) is treated as ABSENT by the predicate — the next settle APPLY simply overwrites it
   * (mirrors `claimStep`'s own pre-#279 overwrite-not-add-if-absent self-heal at the claims map).
   * This can never happen through `settleStep` itself (APPLY always writes both the entry and the
   * membership in the SAME atomic write) — it exists so a hand-authored fixture / an external
   * store's own divergent history cannot wedge the predicate.
   *
   * Issue #279 (increment 2, PR-C): `outcome` gains `'gate'` — a resolved human-gate entry
   * (`settleGateArms`'s APPLY writes `outcome: 'gate'` LITERALLY; `toSettledOutcome`'s own
   * `SettleStepOutcome` domain stays untouched — a `settle_step` delta can never produce a
   * `'gate'` entry, only `settle_gate` can). `choice` is set IFF `outcome === 'gate'` — the
   * human's resolved choice, mirrored from `SettleGateDelta.choice`.
   *
   * Shipped in v0.32.0 (PR-B migrated the three seal sites to `settleStep`) — the "dormant until
   * PR-B" framing below is stale for the `'complete'|'fail'|'skip'` outcomes; `'gate'` itself
   * stays dormant until PR-D migrates the gate-resolution site.
   */
  settled?: Record<
    string,
    {
      token: string | null;
      outcome: 'complete' | 'fail' | 'skip' | 'gate';
      choice?: string;
      /**
       * Issue #291 (D1 §5, carried; the module-local `SettledEntry` alias in settlement.ts
       * projects THIS field): present, and only ever `'timeout'`, on a `'gate'` entry written by
       * `applyExpireGate`'s settle_default disposition — attributes the resolution to the enforce
       * clock rather than a human. Absent = a human resolved it (backward-clean: every pre-#291
       * `'gate'` entry lacks this field). Never set by any other arm.
       */
      resolved_by?: 'timeout';
    }
  >;
  /**
   * Issue #279 (increment 1, PR-A): the record-as-outbox finalizer ledger, keyed by finalizer step
   * name — minted by `mintFresh` (settlement.ts) on the terminal false→true edge, drained via
   * `lease_finalizer`/`mark_finalizer` deltas (design record §3/§4/§6). `rank` totally orders the
   * PENDING subset only (the drain loop processes lowest-rank-first; collisions with
   * terminal-status entries are legal and inert). `lease_deadline`/`lease_token` are present only
   * while `status === 'pending'` AND a drainer currently holds the lease — a CLEAN mint (§4) never
   * seeds them, and `applyResume` (PR-B) strips them when voiding a pending entry. `status`:
   * `'pending'` (mint-not-yet-delivered) → `'completed'` | `'failed'` (delivered, terminal,
   * never rewritten — the never-downgrade guard) or `'voided'` (superseded by a resume, §5;
   * permanent unless a later terminal edge re-mints the SAME finalizer if still selected).
   *
   * Dormant in this PR — join `LoadBearingRunRecordField`/`SAMPLE_VALUES`; nothing writes this
   * field until PR-B migrates the seal sites to `settleStep`.
   */
  finalizer_ledger?: Record<
    string,
    {
      status: 'pending' | 'completed' | 'failed' | 'voided';
      rank: number;
      lease_deadline?: string;
      lease_token?: string;
    }
  >;
}
