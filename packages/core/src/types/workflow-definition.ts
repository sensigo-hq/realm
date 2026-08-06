// Typed representation of a parsed workflow YAML definition.
import type { McpServerConfig } from './mcp-types.js';

export type ExecutionMode = 'auto' | 'agent' | 'guard' | 'finalizer';

/**
 * Terminal outcome(s) a finalizer step matches. `execution: finalizer` steps run at the
 * run's terminal transition (a workflow-level try/catch/finally): `complete` = success,
 * `fail`/`abort` = catch, `always` = finally, `completed_with_failed_steps` = a `complete`
 * seal that still carries `failed_steps` (issue #302 — author-opt-in; fires IN ADDITION to
 * `complete`/`always` on that specific seal shape; never fires on a clean complete or on a pure
 * fail/abort seal — see `docs/reference/yaml-schema.md`'s `execution: finalizer` trigger table).
 * OR-membership when given as an array.
 */
export type FinalizerTrigger =
  'complete' | 'fail' | 'abort' | 'always' | 'completed_with_failed_steps';

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
  /**
   * Opt in to retrying this step's own `STEP_TIMEOUT` in place, consuming a normal retry attempt
   * (issue #140). Legal ONLY when the step also declares `idempotent: true` (E1 — hard error at
   * load otherwise; the engine independently re-checks the same conjunct at dispatch time). A
   * timeout-retry can run CONCURRENTLY with the still-in-flight original attempt (the aborted
   * transport request may still be executing remotely) — `on_timeout: true` is the author's
   * explicit attestation that any number of concurrent executions, including a PARTIAL PRIOR
   * APPLICATION (a committed prefix left by that still-in-flight attempt), are harmless. This
   * claims MORE than `idempotent`'s base (sequential re-apply) guarantee — declare both
   * explicitly; the engine infers neither from the other. Absent/false ⇒ a timeout stays
   * terminal (`retryable: false`), byte-identical to pre-#140 behavior.
   */
  on_timeout?: boolean;
  /**
   * Total wall-clock budget, in seconds, across every attempt of this step (issue #140,
   * Temporal-ScheduleToClose-style) — bounds `max_attempts × per-attempt-timeout` (plus the
   * declared backoffs and any runtime rate-limit `retry_after` sleep) from growing unbounded.
   * Standalone-legal: does NOT require `on_timeout`. **AMENDED default:** when absent, every
   * retry-configured `execution: 'auto'` step is capped at the shared worst-case-schedule
   * formula (`max_attempts × the step's own per-attempt timeout + the declared backoffs between
   * attempts` — the same formula the claim horizon uses) — so the default cap always equals the
   * step's own declared schedule and binds only when a runtime wait pushes an attempt's actual
   * wall-clock MATERIALLY past that schedule (event-loop scheduling overhead is charged to the
   * budget too — negligible at production scales; a step with no `retry:` block has no cap, as
   * there is nothing to bound). When the cap is reached mid-schedule, the step settles as
   * `STEP_RETRY_EXHAUSTED` with `exhausted_by: 'total_timeout'` instead of sleeping past it.
   * Positive integer (E2) — same convention as `timeout_seconds`. Inert on a non-`execution:
   * 'auto'` step (W5 warns) — the cap only bounds `auto` dispatch, which is the only dispatch
   * ever wrapped in a timeout.
   */
  total_timeout_seconds?: number;
}

/**
 * Every key RetryConfig declares. Used by the YAML loader (issue #140) to warn when a `retry:`
 * block declares a key that isn't recognized (misspelling, or a stale field) — same non-breaking
 * posture as KNOWN_STEP_KEYS/KNOWN_WORKFLOW_KEYS (issue #144/#169).
 */
export const KNOWN_RETRY_KEYS = [
  'max_attempts',
  'backoff',
  'base_delay_ms',
  'max_delay_ms',
  'on_timeout',
  'total_timeout_seconds',
] as const;

// Compile-time drift guard: KNOWN_RETRY_KEYS must be an exact partition of RetryConfig's keys —
// see the KNOWN_STEP_KEYS guard above for why this has to be a type-level check.
type _RetryKeysMissing = Exclude<keyof RetryConfig, (typeof KNOWN_RETRY_KEYS)[number]>;
type _RetryKeysExtra = Exclude<(typeof KNOWN_RETRY_KEYS)[number], keyof RetryConfig>;
const _retryKeysMissingCheck: _RetryKeysMissing extends never
  ? true
  : ['KNOWN_RETRY_KEYS is missing a RetryConfig key', _RetryKeysMissing] = true;
const _retryKeysExtraCheck: _RetryKeysExtra extends never
  ? true
  : ['KNOWN_RETRY_KEYS has a key RetryConfig does not declare', _RetryKeysExtra] = true;

/**
 * Controls when a step becomes eligible based on its dependencies' outcomes.
 * Default: 'all_success'.
 */
export type TriggerRule =
  'all_success' | 'all_failed' | 'all_done' | 'one_failed' | 'one_success' | 'none_failed';

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
   * Optional condition controlling step eligibility — the step is ineligible until it is truthy.
   * A single string is one comparison/bare-path leaf; a `string[]` is the **implicit AND** of its
   * leaves (every leaf must hold). Compound `and`/`or` *inside a string* is rejected at load — use
   * the array form instead. An empty array is rejected.
   *
   * Leaf grammar: `<path> <op> <literal>` (`op` ∈ `== != > >= < <=`) or a bare `<path>` (truthy test).
   * Path forms:
   *   step_id.field    — prior step output; the step must be in this step's `depends_on` (one-hop)
   *   run.params.field — run start params (`when` only)
   *
   * Unresolved-LHS semantics: `== null` / `!= null` are presence tests (loose null, covering missing
   * and present-null); relational ops require both operands numeric (else false); any other op on an
   * absent LHS is false. A resolved LHS uses strict equality / numeric-guarded relational comparison.
   */
  when?: string | string[];
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
  /**
   * Terminal outcome(s) this finalizer matches (a workflow-level try/catch/finally). The
   * engine runs matching `execution: finalizer` steps at the run's terminal transition —
   * outcome-specific first, then `always` — each at most once, via the injected registry.
   * Required on (and only valid on) execution: 'finalizer' steps.
   */
  on_outcome?: FinalizerTrigger | FinalizerTrigger[];
  /**
   * Advisory hint (issue #101 Phase 2) that this step's handler is safe to re-execute
   * SEQUENTIALLY. It is READ-ONLY and WIDEN-ONLY: declared alone it does nothing to normal
   * execution and never forces an outcome — it only *permits* two separate opt-in mechanisms,
   * each gated by its OWN explicit declaration:
   *   1. The bounded-time auto-reclaim allow-list (`realm run reclaim --all`). A concrete
   *      `claims[S].deadline` is still required, so this function is inert on a step in a
   *      workflow WITH finalizer steps (those write `deadline: null` → `claim_unknown_age` →
   *      never cron-reclaimable; use `realm run reclaim --step <id> --force` there instead).
   *   2. Since issue #140, `retry.on_timeout: true` — required there (E1, hard error otherwise)
   *      before a timed-out attempt may be retried in place. A timeout-retry can run
   *      CONCURRENTLY with the still-in-flight original attempt, so `on_timeout` claims MORE than
   *      this hint's base sequential-reapply guarantee — declare both explicitly. Unlike function
   *      1, this GATE function is live in every workflow, finalizer-bearing or not.
   * Absent ⇒ false. Deliberately NOT `orphan_policy` (which would force a fail-seal); `idempotent`
   * only ever *permits*, never forces, either mechanism.
   */
  idempotent?: boolean;
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
  /**
   * Issue #220 (PR-1 counting/terminalization + PR-2 declared fail-open): bounds the run of
   * persistent schema-rejections on this step. Only valid on `execution: 'agent'` steps (the
   * countable set — VALIDATION_INPUT_SCHEMA/VALIDATION_OUTPUT_SCHEMA — is agent-only).
   * `threshold` overrides `DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD` (6) for THIS step; must be a
   * positive integer (`1` is legal and documented as disabling in-drive schema-repair, since the
   * very first rejection then already meets the threshold). Absent ⇒ every countable agent step
   * is auto-enrolled at the default threshold — there is no reachable per-step opt-out.
   *
   * `mode` (PR-2): `'fail'` (default when absent) terminalizes the step with `VALIDATION_EXHAUSTED`
   * on exhaustion, byte-unchanged from PR-1. `'default'` instead SETTLES the step successfully with
   * `default_output` once the threshold is reached — bounded, declared, and disclosed (never a
   * silent fallback): the run proceeds as if the agent had submitted `default_output` itself.
   *
   * `default_output` (PR-2): REQUIRED when `mode: 'default'`; ignored (and warned as dead config)
   * otherwise. Only legal when the step also declares `output_schema` (an undeclared schema makes
   * the substitute unvalidatable — refused at load) — `default_output` is then AJV-validated
   * against that `output_schema` AT LOAD TIME, so a fallback that would itself fail runtime
   * validation is refused before the workflow ever registers. Typed `unknown` here; every runtime
   * sink narrows it via `default_output as Record<string, unknown>` — provably safe because the
   * load-time proof already rejected any value that doesn't validate against the (object-typed)
   * `output_schema`.
   */
  validation_exhaustion?: {
    threshold?: number;
    mode?: 'fail' | 'default';
    default_output?: unknown;
  };
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
  /**
   * Issue #236 (L0 prevention layer) — author opt-in to Anthropic grammar-constrained
   * ("strict") decoding for this step's submit tool. Only valid on `execution: 'agent'` steps
   * (mirrors `output_schema`'s agent-only rule). The literal `'strict'` is the only accepted
   * value (a union of one, kept as a string rather than boolean so a future non-Anthropic
   * strict mode can add a sibling literal without a breaking type change).
   *
   * Governed by `assessStructuredOutputEligibility` (core) against the step's EFFECTIVE schema
   * (`output_schema ?? input_schema`): an `ineligible` verdict is a LOADER ERROR at authoring
   * time (`loadWorkflowFrom*`, `validate`, `register`, `create_workflow`) — the API provably
   * rejects some legal schemas (a 400) and silently weakens others (an unsupported keyword is
   * dropped from the grammar with no error), so realm never lets an author ship a schema the
   * gate already knows is unsafe. At runtime the SAME verdict is re-derived (never persisted —
   * self-healing under API drift) and a fallback ladder additionally degrades loudly on a live
   * 400/503 the gate could not have predicted. See `docs/reference/yaml-schema.md`'s
   * `structured_output` section for the full gate table and the runtime disclosure vocabulary.
   */
  structured_output?: 'strict';
}

/**
 * Every key StepDefinition declares (it has no runtime-only fields — everything on a step is
 * authored in YAML). Used by the YAML loader (issue #144) to warn when a step declares a key
 * that isn't recognized — a misspelled field or a leftover from a removed feature (e.g. the old
 * `allowed_from_states`/`produces_state` scalar state-machine fields) is otherwise silently
 * dropped with no signal to the author.
 */
export const KNOWN_STEP_KEYS = [
  'description',
  'execution',
  'depends_on',
  'trigger_rule',
  'when',
  'abort_unless',
  'abort_message',
  'on_outcome',
  'idempotent',
  'uses_service',
  'service_method',
  'operation',
  'input_map',
  'handler',
  'config',
  'input_schema',
  'output_schema',
  'trace_schema',
  'trace_validation_mode',
  'preconditions',
  'trust',
  'timeout_seconds',
  'retry',
  'validation_exhaustion',
  'instructions',
  'prompt',
  'display',
  'use_template',
  'gate',
  'agent_profile',
  'tools',
  'max_tool_calls',
  'max_fan_out',
  'tool_timeout',
  'structured_output',
] as const;

// Compile-time drift guard: KNOWN_STEP_KEYS must be an exact partition of StepDefinition's keys.
// Types are erased at runtime, so this is the only mechanism that can catch drift — if someone
// adds/removes a StepDefinition field without updating KNOWN_STEP_KEYS, tsc fails the build
// (the assignment below only type-checks when both Exclude<> results are `never`).
type _StepKeysMissing = Exclude<keyof StepDefinition, (typeof KNOWN_STEP_KEYS)[number]>;
type _StepKeysExtra = Exclude<(typeof KNOWN_STEP_KEYS)[number], keyof StepDefinition>;
const _stepKeysMissingCheck: _StepKeysMissing extends never
  ? true
  : ['KNOWN_STEP_KEYS is missing a StepDefinition key', _StepKeysMissing] = true;
const _stepKeysExtraCheck: _StepKeysExtra extends never
  ? true
  : ['KNOWN_STEP_KEYS has a key StepDefinition does not declare', _StepKeysExtra] = true;

export interface WorkflowDefinition {
  id: string;
  name: string;
  /** Optional human-readable statement of what this workflow does / when to use it. Declarative
   *  purpose — distinct from protocol.quick_start (how to begin). Surfaced in the agent protocol
   *  and CLI. */
  description?: string;
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
   * Optional project extension module path(s) — RELATIVE to the workflow directory.
   * Authored as `string | string[]`; loadWorkflowFromFile normalizes to `string[]` and the
   * authored relative paths are stored untouched. Absolute paths and empty strings/arrays
   * are rejected at load time. Requires file-based loading — loadWorkflowFromString rejects
   * a declared `extensions` key (no directory context). Core resolves and stores PATHS only;
   * module loading lives in the CLI composition layer (loadProjectExtensions).
   */
  extensions?: string | string[];
  /**
   * Absolutized workflow directory, stamped by loadWorkflowFromFile when `extensions` is
   * declared (precedent: workflow_context path absolutization). Extension paths resolve
   * against this directory. Runtime-only — never write to workflow YAML.
   */
  source_dir?: string;
  /**
   * Containment root for extension resolution: nearest ancestor of source_dir (inclusive)
   * containing package.json or .git; fallback source_dir itself. Stamped at registration
   * time from an operator-given path — this is NOT execution-time discovery-walking.
   * The loader refuses any extension module resolving outside this root (realpath-compared).
   * Runtime-only — never write to workflow YAML.
   */
  trust_root?: string;
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
   * Optional automated trigger for this workflow, authored in workflow YAML.
   * When set, 'realm listen' routes incoming webhook requests to this workflow.
   * Validated by the loader at registration time (see normalizeTriggerFilter /
   * validateTriggerStructure) — this is an authorable field, not runtime-only.
   */
  trigger?: TriggerDefinition;
}

/**
 * Every WorkflowDefinition key an author may declare in workflow YAML. Paired with
 * RUNTIME_ONLY_WORKFLOW_KEYS below, this is a complete partition of WorkflowDefinition's keys —
 * used by the YAML loader (issue #144) to warn on an unknown top-level key (misspelling, or a
 * leftover from a removed feature such as `initial_state`).
 */
export const KNOWN_WORKFLOW_KEYS = [
  'id',
  'name',
  'description',
  'version',
  'params_schema',
  'protocol',
  'services',
  'mcp_servers',
  'templates',
  'steps',
  'profiles_dir',
  'extensions',
  'workflow_context',
  'context_wrapper',
  'trigger',
] as const;

/**
 * WorkflowDefinition keys stamped by the loader/engine at load or registration time — never
 * authored in workflow YAML. The yaml-loader's unknown-key check treats KNOWN_WORKFLOW_KEYS
 * ALONE as the authorable allow-list (this list is deliberately excluded from it), so hand-
 * authoring one of these in YAML (e.g. `schema_version:` or `model:`) still warns — it is itself
 * a mistake worth surfacing, since the loader silently overwrites/ignores any authored value.
 * This list's own role is completing the compile-time partition below: every WorkflowDefinition
 * key is either authorable (KNOWN_WORKFLOW_KEYS) or stamped (this list) — never both, never
 * neither.
 */
export const RUNTIME_ONLY_WORKFLOW_KEYS = [
  'source_dir',
  'trust_root',
  'resolved_profiles',
  'schema_version',
  'origin',
  'model',
  'agent',
] as const;

// Compile-time drift guard: KNOWN_WORKFLOW_KEYS + RUNTIME_ONLY_WORKFLOW_KEYS together must be an
// exact, non-overlapping partition of WorkflowDefinition's keys. See the StepDefinition guard
// above for why this has to be a type-level check rather than a runtime one.
type _WorkflowKeysAll =
  (typeof KNOWN_WORKFLOW_KEYS)[number] | (typeof RUNTIME_ONLY_WORKFLOW_KEYS)[number];
type _WorkflowKeysMissing = Exclude<keyof WorkflowDefinition, _WorkflowKeysAll>;
type _WorkflowKeysExtra = Exclude<_WorkflowKeysAll, keyof WorkflowDefinition>;
type _WorkflowKeysOverlap = (typeof KNOWN_WORKFLOW_KEYS)[number] &
  (typeof RUNTIME_ONLY_WORKFLOW_KEYS)[number];
const _workflowKeysMissingCheck: _WorkflowKeysMissing extends never
  ? true
  : [
      'KNOWN_WORKFLOW_KEYS + RUNTIME_ONLY_WORKFLOW_KEYS is missing a WorkflowDefinition key',
      _WorkflowKeysMissing,
    ] = true;
const _workflowKeysExtraCheck: _WorkflowKeysExtra extends never
  ? true
  : [
      'KNOWN_WORKFLOW_KEYS + RUNTIME_ONLY_WORKFLOW_KEYS has a key WorkflowDefinition does not declare',
      _WorkflowKeysExtra,
    ] = true;
const _workflowKeysOverlapCheck: _WorkflowKeysOverlap extends never
  ? true
  : ['KNOWN_WORKFLOW_KEYS and RUNTIME_ONLY_WORKFLOW_KEYS overlap', _WorkflowKeysOverlap] = true;

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
  { header: string; value: string | string[] } | { path: string; value: string | string[] };

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
