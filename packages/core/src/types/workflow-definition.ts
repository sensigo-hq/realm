// Typed representation of a parsed workflow YAML definition.
import type { McpServerConfig } from './mcp-types.js';

export type ExecutionMode = 'auto' | 'agent' | 'guard';

export interface ProtocolConfig {
  /** Override for the generated quick-start paragraph. */
  quick_start?: string;
  /** Behavioral rules injected verbatim into the agent protocol. */
  rules?: string[];
}

export type TrustLevel = 'auto' | 'human_notified' | 'human_confirmed' | 'human_reviewed';

export type ServiceTrust = 'engine_delivered' | 'engine_managed' | 'agent_provided';

export interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  [key: string]: unknown;
}

export interface RateLimitConfig {
  /** Maximum number of requests per second. Used as the token refill rate. */
  requests_per_second?: number;
  /** Initial token capacity (burst). Defaults to requests_per_second if omitted. */
  burst?: number;
  /**
   * Fallback retry-after delay (seconds) when the service returns HTTP 429 with no header.
   * Overrides adapter.defaultRetryAfterSeconds when set.
   */
  fallback_retry_seconds?: number;
  /**
   * Minimum retry-after floor (seconds). When set, the resolved retry_after is
   * Math.max(header_or_fallback, min_retry_seconds) — prevents short Retry-After
   * header values from causing retries before the rate limit window has cleared.
   */
  min_retry_seconds?: number;
  /**
   * Maximum retry-after window (seconds). When the resolved retry_after exceeds this value,
   * the step fails immediately with agentAction: 'report_to_user' instead of waiting.
   */
  max_retry_seconds?: number;
}

export interface ServiceDefinition {
  adapter: string;
  auth?: { token_from: string };
  trust: ServiceTrust;
  rate_limit?: RateLimitConfig;
}

/** A single parameter declaration in a template. */
export interface TemplateParam {
  required?: boolean;
  default?: string;
}

/** A named reusable step group with parameter placeholders. */
export interface TemplateDefinition {
  params?: Record<string, TemplateParam>;
  steps: Record<string, StepDefinition>;
}

export interface RetryConfig {
  max_attempts: number;
  backoff?: 'linear' | 'exponential' | 'fixed';
  base_delay_ms?: number;
  /** Cap on the computed backoff delay. When set, no single delay exceeds this value. */
  max_delay_ms?: number;
}

/**
 * Controls when a step becomes eligible based on its dependencies' outcomes.
 * Default: 'all_success'.
 */
export type TriggerRule =
  | 'all_success'
  | 'all_failed'
  | 'all_done'
  | 'one_failed'
  | 'one_success'
  | 'none_failed';

/**
 * A node in an input_map tree. One of:
 * - string: a dot-path reference resolved against run state
 * - { $literal: value }: a static constant value (any JSON value: scalar, array, or object) —
 *   passed through verbatim by the runtime, never path-resolved or recursed into
 * - { [key: string]: InputMapNode }: a nested object (recursive)
 *
 * The $literal sentinel must appear alone — no sibling keys are permitted.
 */
export type LiteralNode = { $literal: unknown };
export type InputMapNode = string | LiteralNode | { [key: string]: InputMapNode };

export interface StepDefinition {
  description: string;
  execution: ExecutionMode;
  /**
   * Step IDs this step waits for. Empty array or omitted = eligible from run start
   * (first tier of the DAG).
   */
  depends_on?: string[];
  /**
   * When to evaluate dependency satisfaction. Default: 'all_success'.
   */
  trigger_rule?: TriggerRule;
  /**
   * Optional condition expression evaluated against prior step evidence or run params.
   * Step is ineligible until this expression is truthy.
   * Path forms:
   *   step_id.field        — prior step output (e.g. "classify.category == 'billing'")
   *   run.params.field     — run start params (e.g. "run.params.mode == 'live'")
   * Single expression only — compound conditions (AND/OR) are not supported.
   */
  when?: string;
  /**
   * Array of condition expressions evaluated against prior step evidence.
   * All conditions are evaluated; the run aborts (run_phase: 'aborted') if any is false.
   * A single string is normalised to a single-element array internally.
   * Only valid on execution: 'guard' steps.
   * Expression syntax: "step_id.field op value" — same path syntax as preconditions and when.
   * Supported operators: ==, !=, >, >=, <, <=
   * Bare path resolves as truthy/falsy.
   * Absent path → GUARD_RESOLUTION_ERROR (run_phase: 'failed', not 'aborted').
   */
  abort_unless?: string | string[];
  /**
   * Human-readable message recorded in the guard step's evidence entry when the run aborts.
   * Only valid on execution: 'guard' steps.
   */
  abort_message?: string;
  uses_service?: string;
  /**
   * Which adapter method to invoke for this service step.
   * Defaults to 'fetch' if omitted.
   */
  service_method?: 'fetch' | 'create' | 'update' | 'delete';
  /**
   * Operation name passed as the first argument to the adapter method.
   * Defaults to the step name if omitted.
   */
  operation?: string;
  /**
   * Static path-mapping that assembles this step's adapter params from run state.
   * Each key is the param name passed to the adapter; each value is either a dot-path string:
   *   run.params.FIELD            — from the run's initial params
   *   context.resources.STEP.FIELD — from a prior step's evidence output
   * or a nested object of the same shape (InputMapNode), enabling the construction of
   * arbitrarily nested param objects for adapter steps.
   * Only valid on execution: 'auto' steps with uses_service.
   */
  input_map?: Record<string, InputMapNode>;
  handler?: string;
  /**
   * Static key-value configuration passed to the step handler via context.config,
   * or merged into the adapter config object for execution: auto steps with uses_service.
   * Only valid on execution: 'auto' steps with a handler or uses_service declaration.
   */
  config?: Record<string, unknown>;
  input_schema?: JsonSchema;
  /**
   * Validates the agent's submitted output (the params passed to `execute_step`)
   * against this JSON Schema before the engine claims the step.
   * Only valid on `execution: 'agent'` steps. Declaring `output_schema` on an
   * `execution: 'auto'` step is a loader error.
   *
   * Validation runs pre-claim. If it fails the engine returns
   * `agent_action: 'provide_input'` and the step remains unclaimed —
   * the agent can correct its output and re-submit without side effects.
   *
   * For gate steps (`trust: 'human_confirmed'` or `trust: 'human_reviewed'`),
   * the schema validates before the gate opens. `submitHumanResponse` commits
   * the previewed payload unchanged — the human always sees a schema-conformant
   * payload.
   */
  output_schema?: JsonSchema;
  /**
   * JSON Schema validated against the canonical stored trace entries for this step.
   * Only valid on `execution: 'agent'` steps.
   * When `trace_validation_mode` is `'enforce'`, invalid trace fails pre-claim and the
   * step remains unclaimed. When `'warn'` (default), a warning is added to the envelope.
   */
  trace_schema?: JsonSchema;
  /**
   * Controls how `trace_schema` failures are handled.
   * Default when `trace_schema` is set and mode is omitted: `'warn'`.
   * Ignored when no `trace_schema` is declared.
   */
  trace_validation_mode?: 'warn' | 'enforce';
  preconditions?: string[];
  trust?: TrustLevel;
  timeout_seconds?: number;
  retry?: RetryConfig;
  /** Plain-English instructions for the agent at this step. */
  instructions?: string;
  /**
   * Template-resolved task prompt delivered to the agent at step entry via next_actions[].prompt.
   * Supports {{ context.resources.STEP.FIELD }} and {{ run.params.FIELD }} references.
   * For human_confirmed steps, delivered as gate.prompt when the gate opens.
   */
  prompt?: string;
  /**
   * Optional Jinja-style display template rendered by the CLI against this step's
   * output_summary for human-readable terminal output. Uses {{ field }} syntax where
   * field is a dot-path into the step's output object. When absent, the CLI falls
   * back to the existing headline/message and JSON rendering behaviour.
   * No engine evaluation — rendered client-side at run completion.
   */
  display?: string;
  /**
   * When present, this entry is a template instantiation rather than a concrete step.
   * Resolved by loadWorkflowFromString before validation — never present in a
   * WorkflowDefinition returned to callers.
   */
  use_template?: string;
  /** Gate configuration — choices available to the human reviewer. */
  gate?: {
    choices?: string[];
    /**
     * Slack user ID or handle of the person responsible for resolving this gate.
     * Used for notification targeting and escalation.
     * Optional — notifications work without it.
     * Example: '@mihai.lupu' or 'U012AB3CD'
     */
    owner?: string;
    /**
     * Developer-authored template string presented to the human reviewer when this gate opens.
     * Supports {{ context.resources.STEP.FIELD }} and {{ run.params.FIELD }} references.
     * Resolved from run data at gate-open time. Fail-fast: unresolvable references cause
     * a stop error rather than opening a gate with broken placeholder text.
     * When absent, the Slack path falls back to formatGatePreviewForSlack(preview)
     * and the MCP path falls back to step.prompt resolution (existing behavior).
     */
    message?: string;
    /**
     * Per-choice messages posted to the Slack thread when the gate resolves via Slack.
     * Keys must match entries in `choices`. Values are plain text (not mrkdwn templates).
     * Optional — when absent or when a choice has no entry, the generic fallback is used.
     * Example:
     *   resolution_messages:
     *     send: "✅ Incident report sent to #incidents."
     *     reject: "❌ Draft discarded. Run will not continue."
     */
    resolution_messages?: Record<string, string>;
  };
  /** Name of the agent profile for this step. Only valid on execution: 'agent' steps. */
  agent_profile?: string;
  /**
   * Allow-list of tools this step may invoke, in 'server_id:tool_name' format.
   * Only valid on execution: 'agent' steps without a handler. Requires input_schema.
   */
  tools?: string[];
  /**
   * Maximum number of tool-call iterations before the agentic loop terminates.
   * Default: 20 (applied at runtime).
   */
  max_tool_calls?: number;
  /**
   * Maximum number of fan-out tool calls (`start_run` / `start_run_batch`) allowed within
   * a single agentic loop execution. Applies only to steps with `tools` declared.
   * When the count reaches this value the loop is terminated early (equivalent to the
   * existing `max_tool_calls` early-termination path).
   * Default: unlimited.
   */
  max_fan_out?: number;
  /**
   * Timeout in seconds for each individual tool call.
   * Default: 30 (applied at runtime).
   */
  tool_timeout?: number;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: number;
  /** JSON Schema describing the params accepted by start_run. */
  params_schema?: JsonSchema;
  /** Optional protocol customizations — overrides generated sections. */
  protocol?: ProtocolConfig;
  services?: Record<string, ServiceDefinition>;
  /** MCP server configurations available to tool-enabled steps in this workflow. */
  mcp_servers?: McpServerConfig[];
  /** Optional named step groups with {{ param }} placeholders; resolved at load time. */
  templates?: Record<string, TemplateDefinition>;
  steps: Record<string, StepDefinition>;
  /** Optional: directory containing shared profile markdown files.
   *  Resolved relative to the workflow YAML file at load time.
   *  Falls back to <workflow-dir>/profiles/ if omitted. */
  profiles_dir?: string;
  /**
   * Map of resolved profile content keyed by profile name.
   * Populated by loadWorkflowFromFile — absent when loaded from string.
   * Do not serialize/write to workflow YAML — this is a runtime-only field.
   */
  resolved_profiles?: Record<string, { content: string; content_hash: string }>;
  /**
   * Schema version stamped by the loader at registration time.
   * Used by JsonWorkflowStore.get() to reject stale registrations.
   * Runtime-only — not a user-facing YAML field.
   */
  schema_version?: number;
  /**
   * Named context entries available in all step prompts via {{ workflow.context.NAME }}.
   * Loaded once at run start. Separate from step evidence.
   * Paths are resolved to absolute at registration time by the YAML loader.
   */
  workflow_context?: Record<string, WorkflowContextEntry>;
  /**
   * Wrapper format applied to {{ workflow.context.NAME }} template references.
   * Does not affect {{ workflow.context.NAME.raw }}.
   * Default: 'xml'
   */
  context_wrapper?: ContextWrapperFormat;
  /**
   * How the workflow was originally created. Stamped at registration time — runtime-only.
   * Never write to workflow YAML.
   * 'human' — registered via YAML file (CLI register / watch).
   * 'agent'  — created at runtime via the create_workflow MCP tool.
   */
  origin?: 'human' | 'agent';
  /**
   * LLM model identifier used to create this workflow (e.g. "claude-sonnet-4-6", "gpt-4o").
   * Only meaningful when origin is 'agent'. Self-reported — not verified.
   * Runtime-only — do not write to workflow YAML.
   */
  model?: string;
  /**
   * Orchestrating tool or framework that called create_workflow
   * (e.g. "cursor", "github-copilot"). Only meaningful when origin is 'agent'.
   * Self-reported — not verified.
   * Runtime-only — do not write to workflow YAML.
   */
  agent?: string;
  /**
   * Optional automated trigger for this workflow.
   * When set, 'realm listen' routes incoming webhook requests to this workflow.
   * Runtime-only field on the listening process — not enforced by the engine itself.
   */
  trigger?: TriggerDefinition;
}

/** A single named entry in the workflow_context section. */
export interface WorkflowContextEntry {
  /** Absolute file path — resolved from the YAML-relative path at registration time. */
  source: { path: string };
  /** Optional human-readable description of what this context contains. */
  description?: string;
}

/** Wrapper format applied to {{ workflow.context.NAME }} template references. */
export type ContextWrapperFormat = 'xml' | 'brackets' | 'none';

// ─── Webhook Trigger ───────────────────────────────────────────────────────────
// Minimal, Gorgias-anchored trigger config. `auth` carries a verification *mode* (these are
// auth modes, not all signatures) — `shared_secret` (header token; primary) plus the HMAC
// presets github/stripe/hmac, and a documented `none` escape hatch.

/** Header-token auth — the request carries a user-configured header equal to a shared secret. */
export interface AuthSharedSecret {
  mode: 'shared_secret';
  /** Request header carrying the token (matched case-insensitively), e.g. 'Authorization'. */
  header: string;
  /** Env var name holding the EXACT expected header value (e.g. 'Bearer abc123'). */
  secret_from: string;
}

/** GitHub HMAC-SHA256 hex body signature (header 'X-Hub-Signature-256'). */
export interface AuthGithub {
  mode: 'github';
  secret_from: string;
}

/** Stripe timestamped HMAC body signature (header 'Stripe-Signature'). */
export interface AuthStripe {
  mode: 'stripe';
  secret_from: string;
  /** Maximum age of the signature timestamp in seconds. */
  max_age_seconds?: number;
}

/** Generic HMAC body signature with a configurable header / algorithm / encoding. */
export interface AuthHmac {
  mode: 'hmac';
  secret_from: string;
  /** Header carrying the computed signature. */
  header: string;
  /** HMAC algorithm. Default: 'sha256'. */
  algorithm?: 'sha1' | 'sha256' | 'sha512';
  /** Signature encoding in the header. Default: 'hex'. */
  encoding?: 'hex' | 'base64';
  /** Optional header carrying the request timestamp for replay prevention. */
  timestamp_header?: string;
  /** Maximum age in seconds when timestamp_header is set. */
  max_age_seconds?: number;
}

/** Documented, discouraged escape hatch — accept without verification (trusted network / localhost only). */
export interface AuthNone {
  mode: 'none';
}

export type WebhookAuth = AuthSharedSecret | AuthGithub | AuthStripe | AuthHmac | AuthNone;

// Dot-notation: each segment is a property name or zero-based numeric array index.
export type FilterCondition =
  | { header: string; value: string | string[] }
  | { path: string; value: string | string[] };

/** Post-normalisation form (loader converts shorthand → { all: [...] }). Max 8 conditions. */
export interface TriggerFilter {
  all: FilterCondition[];
}

export interface DedupConfig {
  /** Dot-path to the unique event ID (e.g. 'body.id' or 'headers.x-gorgias-...').
   *  The dot-path root is { headers, body } (plural 'headers') — matching params_map and the runtime
   *  resolver. A singular 'header.x-...' resolves to undefined and silently disables dedup. */
  id_from: string;
  /** TTL in minutes. Default: 60. Range: 1–10080 (7 days max). */
  ttl_minutes?: number;
  /**
   * Behaviour when the dedup ID cannot be resolved from the payload.
   * 'skip' (default): log warn and proceed without dedup protection.
   * 'reject': return 400.
   */
  on_missing_id?: 'skip' | 'reject';
}

export interface WebhookTrigger {
  type: 'webhook';
  /** URL path for this webhook. Default: /<workflow-id>. */
  path?: string;
  auth: WebhookAuth;
  /** Loader normalises a shorthand FilterCondition → TriggerFilter (all: [...]) at load time. */
  filter?: TriggerFilter;
  /** false = explicit dedup disable. */
  dedup?: DedupConfig | false;
  /** Maps run params from payload: keys = param names, values = dot-paths into { headers, body }. */
  params_map?: Record<string, string>;
}

export type TriggerDefinition = WebhookTrigger;
