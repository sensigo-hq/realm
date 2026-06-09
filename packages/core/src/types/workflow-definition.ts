// Typed representation of a parsed workflow YAML definition.

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

export interface ServiceDefinition {
  adapter: string;
  auth?: { token_from: string };
  trust: ServiceTrust;
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

export interface RateLimitConfig {
  /** Maximum number of requests per second. */
  requests_per_second?: number;
  /** Initial token capacity (burst). Defaults to requests_per_second if omitted. */
  burst?: number;
  /** Fallback retry-after delay (seconds) when service returns 429 with no header. */
  fallback_retry_seconds?: number;
  /** Maximum retry-after window (seconds). Exceeding it fails the step immediately. */
  max_retry_seconds?: number;
}

export interface RetryConfig {
  max_attempts: number;
  backoff: 'linear' | 'exponential' | 'fixed';
  base_delay_ms: number;
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
   * Optional condition expression evaluated against prior step evidence and run params.
   * Step is ineligible until this expression is truthy.
   * Path forms:
   *   step_id.field           — resolves against prior step output (e.g. "classify.category == 'billing'")
   *   run.params.field        — resolves against the run's start params (e.g. "run.params.mode == 'live'")
   * Supports: ==, !=, >, <, >=, <=, and bare truthy/falsy path.
   * Single expression only — compound conditions (AND/OR) are not supported.
   */
  when?: string;
  uses_service?: string;
  /**
   * Which adapter method to invoke for this service step.
   * Defaults to 'fetch' if omitted.
   */
  service_method?: 'fetch' | 'create' | 'update';
  /**
   * Operation name passed as the first argument to the adapter method.
   * Defaults to the step name if omitted.
   */
  operation?: string;
  /**
   * Static path-mapping that assembles this step's adapter or handler params from run state.
   * Each key is the param name; each value is either:
   *   - a dot-path string: run.params.FIELD or context.resources.STEP.FIELD
   *   - a { $literal: <scalar> } object: a static string, number, boolean, or null
   * Only valid on execution: 'auto' steps.
   */
  input_map?: Record<string, string | { $literal: unknown }>;
  handler?: string;
  /**
   * Static key-value configuration passed to the step handler via context.config.
   * Only meaningful on execution: auto steps with a handler declaration.
   */
  config?: Record<string, unknown>;
  input_schema?: JsonSchema;
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
   * When present, this entry is a template instantiation rather than a concrete step.
   * Resolved by loadWorkflowFromString before validation — never present in a
   * WorkflowDefinition returned to callers.
   */
  use_template?: string;
  /**
   * Array of condition expressions. Run aborts if any is false.
   * Only valid on execution: 'guard' steps.
   */
  abort_unless?: string | string[];
  /** Human-readable message recorded when the run aborts. Only valid on execution: 'guard' steps. */
  abort_message?: string;
  /**
   * JSON Schema validated against the agent's submitted output (execute_step params) pre-claim.
   * Only valid on execution: 'agent' steps.
   */
  output_schema?: JsonSchema;
  /**
   * JSON Schema validated against canonical stored trace entries for this step.
   * Only valid on execution: 'agent' steps.
   */
  trace_schema?: JsonSchema;
  /**
   * Controls how trace_schema failures are handled. Default: 'warn'.
   * Ignored when no trace_schema is declared.
   */
  trace_validation_mode?: 'warn' | 'enforce';
  /** Gate configuration — choices available to the human reviewer. */
  gate?: {
    choices?: string[];
    /** Slack user ID or handle of the person responsible for resolving this gate. */
    owner?: string;
    /**
     * Template string presented to the human reviewer when this gate opens.
     * Supports {{ context.resources.STEP.FIELD }} and {{ run.params.FIELD }} references.
     * Fail-fast: unresolvable references cause a stop error rather than opening a broken gate.
     */
    message?: string;
    /** Per-choice messages posted when the gate resolves. */
    resolution_messages?: Record<string, string>;
  };
  /** Name of the agent profile for this step. Only valid on execution: 'agent' steps. */
  agent_profile?: string;
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
