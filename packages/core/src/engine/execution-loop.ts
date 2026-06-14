// Central execution loop — orchestrates eligibility check, claim, dispatcher, evidence capture,
// run state update, and ResponseEnvelope construction for the DAG execution model.
// Includes: step claiming, step-level retry, step timeouts, human gate mechanics,
// auto-chaining with fan-out, and registry-based dispatch for adapter and handler steps.
import type {
  RunRecord,
  EvidenceSnapshot,
  WorkflowContextSnapshot,
  AgentTraceEntry,
} from '../types/run-record.js';
import type { ToolCallRecord } from '../types/mcp-types.js';
import type { ResponseEnvelope, NextAction } from '../types/response-envelope.js';
import { WorkflowError } from '../types/workflow-error.js';
import type {
  WorkflowDefinition,
  StepDefinition,
  RetryConfig,
  ContextWrapperFormat,
  InputMapNode,
  LiteralNode,
} from '../types/workflow-definition.js';
import type { RunStore } from '../store/store-interface.js';
import type { TraceBufferStore, BufferedEntry } from '../store/trace-buffer-store.js';
import { captureEvidence } from '../evidence/snapshot.js';
import {
  validateInputSchema,
  validateOutputSchema,
  validateTraceSchema,
} from '../validation/input-schema.js';
import { normalizeTrace } from './trace-normalizer.js';
import type { NormalizeTraceResult } from './trace-normalizer.js';
import { TERMINAL_PHASES } from './lifecycle.js';
import {
  checkPreconditions,
  evaluateAllPreconditions,
  evaluateGuardConditions,
} from './precondition.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';
import { resolveSecret } from '../config/secrets.js';
import { renderTemplate, resolvePath, UnknownFilterError } from './render-template.js';
import { generateSchemaSkeleton } from '../utils/schema-skeleton.js';
import { loadWorkflowContext } from './workflow-context-loader.js';
import {
  findEligibleSteps,
  findEligibleGuardSteps,
  isWorkflowComplete,
  buildEvidenceByStep,
  propagateSkips,
} from './eligibility.js';
import {
  resolvePreExecutionAgentAction,
  resolvePostDispatchAgentAction,
} from './error-resolution.js';

export type StepDispatcher = (
  stepName: string,
  input: Record<string, unknown>,
  run: RunRecord,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

export interface ExecuteStepOptions {
  runId: string;
  command: string;
  input: Record<string, unknown>;
  dispatcher: StepDispatcher;
  /**
   * Extension registry for resolving service adapters and step handlers.
   * When omitted, the engine uses the built-in default registry (includes `FileSystemAdapter`).
   */
  registry?: ExtensionRegistry;
  /** Resolved secrets passed to adapter configs (e.g. API tokens). */
  secrets?: Record<string, string>;
  /**
   * Tool calls produced by callStepWithTools for this step.
   * Absent on the callStep path (no tools configured).
   * Present (possibly []) when tools were declared — threads through to captureEvidence.
   */
  stepMeta?: { toolCalls?: ToolCallRecord[] };
  /**
   * Optional agent-submitted trace entries for this step.
   * Silently dropped for non-agent steps. When present on agent steps, the
   * normalizer canonicalizes and persists them in the EvidenceSnapshot.
   */
  trace?: AgentTraceEntry[];
  /**
   * Optional trace buffer store for incremental trace ingestion (B-lite).
   * When provided, WAL entries for (runId, stepId) are merged with any trace
   * submitted on execute_step before canonicalization.
   * When absent, behaviour is identical to the pre-B-lite path.
   */
  traceBufferStore?: TraceBufferStore;
}

export interface SubmitGateOptions {
  runId: string;
  gateId: string;
  choice: string;
}

export interface ExecuteChainOptions {
  runId: string;
  command: string;
  input: Record<string, unknown>;
  dispatcher: StepDispatcher;
  /** @see ExecuteStepOptions.registry */
  registry?: ExtensionRegistry;
  /** @see ExecuteStepOptions.secrets */
  secrets?: Record<string, string>;
  /**
   * Tool calls produced by callStepWithTools for this step.
   * Absent on the callStep path (no tools configured).
   * Present (possibly []) when tools were declared — threads through to captureEvidence.
   */
  stepMeta?: { toolCalls?: ToolCallRecord[] };
  /** @see ExecuteStepOptions.trace */
  trace?: AgentTraceEntry[];
  /** @see ExecuteStepOptions.traceBufferStore */
  traceBufferStore?: TraceBufferStore;
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes `dispatch` with a cancellation signal. If `dispatch` does not complete within `ms`
 * milliseconds, the signal is aborted and a STEP_TIMEOUT WorkflowError is thrown.
 */
function withTimeout<T>(
  dispatch: (signal: AbortSignal) => Promise<T>,
  ms: number,
  stepName: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new WorkflowError(`Step '${stepName}' timed out after ${ms}ms`, {
          code: 'STEP_TIMEOUT',
          category: 'ENGINE',
          agentAction: 'report_to_user',
          retryable: false,
          details: { stepName, timeout_ms: ms },
        }),
      );
    }, ms);
  });

  return Promise.race([dispatch(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/** Maximum nesting depth allowed in an input_map tree. */
const MAX_INPUT_MAP_DEPTH = 10;

/**
 * Resolves an input_map declaration into a concrete params object.
 * Falls back to options.input when input_map is absent.
 */
function resolveInputMap(
  inputMap: Record<string, InputMapNode> | undefined,
  options: ExecuteStepOptions,
  pendingRun: RunRecord,
): Record<string, unknown> {
  if (inputMap === undefined) return options.input;
  const evidenceByStep = buildEvidenceByStep(pendingRun);
  const root: Record<string, unknown> = {
    run: { params: pendingRun.params },
    context: { resources: evidenceByStep },
  };
  const result: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(inputMap)) {
    result[key] = resolveInputMapNode(node, root, key, 0);
  }
  return result;
}

/**
 * Recursively resolves a single InputMapNode. String leaves are resolved via resolvePath;
 * object nodes produce a nested Record by recursing into their entries.
 */
function resolveInputMapNode(
  node: InputMapNode,
  root: Record<string, unknown>,
  keyChain: string,
  depth: number,
): unknown {
  if (depth > MAX_INPUT_MAP_DEPTH) {
    throw new WorkflowError(
      `input_map path "${keyChain}": exceeded maximum nesting depth of ${MAX_INPUT_MAP_DEPTH}`,
      {
        code: 'INPUT_MAP_DEPTH_EXCEEDED',
        category: 'ENGINE',
        agentAction: 'report_to_user',
        retryable: false,
      },
    );
  }
  if (typeof node === 'string') {
    return resolvePath(node, root);
  }

  // Literal node — return the value directly without path resolution.
  if ('$literal' in node && Object.keys(node).length === 1) {
    return (node as LiteralNode).$literal;
  }

  // Nested object — recurse.
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    result[key] = resolveInputMapNode(child as InputMapNode, root, `${keyChain}.${key}`, depth + 1);
  }
  return result;
}

/** Computes the delay (ms) before a retry attempt based on the configured backoff strategy. */
function computeBackoff(config: RetryConfig, attemptNum: number): number {
  const backoff = config.backoff ?? 'fixed';
  const base = config.base_delay_ms ?? 0;
  let delay: number;
  switch (backoff) {
    case 'linear':
      delay = base * attemptNum;
      break;
    case 'exponential':
      delay = base * Math.pow(2, attemptNum - 1);
      break;
    default: // 'fixed'
      delay = base;
  }
  return config.max_delay_ms !== undefined ? Math.min(delay, config.max_delay_ms) : delay;
}

/**
 * Resolves and calls the service adapter for an auto step with `uses_service`.
 *
 * @param rateLimiterRegistry - Stable registry for rate-limiter state. Must be the same
 *   instance across all retry attempts of this step so that pause/resume coordination
 *   is preserved. Created once per executeStep() invocation and shared here.
 */
async function callAdapter(
  stepDef: StepDefinition,
  definition: WorkflowDefinition,
  options: ExecuteStepOptions,
  pendingRun: RunRecord,
  rateLimiterRegistry: ExtensionRegistry,
  signal?: AbortSignal,
): Promise<{
  output: Record<string, unknown>;
  resolvedParams: Record<string, unknown> | undefined;
}> {
  const serviceName = stepDef.uses_service!;
  const serviceDef = definition.services?.[serviceName];
  if (serviceDef === undefined) {
    throw new WorkflowError(`Service '${serviceName}' not found in workflow definition`, {
      code: 'ENGINE_ADAPTER_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
      stepId: options.command,
    });
  }

  // Adapter lookup: use the caller-provided registry for custom adapters; fall back to
  // the built-in default registry (FileSystemAdapter etc.) when none is provided.
  const adapter = (options.registry ?? createDefaultRegistry()).getAdapter(serviceDef.adapter);
  if (adapter === undefined) {
    throw new WorkflowError(
      `Adapter '${serviceDef.adapter}' for service '${serviceName}' is not registered`,
      {
        code: 'ENGINE_ADAPTER_FAILED',
        category: 'ENGINE',
        agentAction: 'stop',
        retryable: false,
        stepId: options.command,
      },
    );
  }

  const secrets = options.secrets ?? {};
  const config: Record<string, unknown> = {
    adapter: serviceDef.adapter,
    trust: serviceDef.trust,
    ...(stepDef.config ?? {}),
  };
  if (serviceDef.auth?.token_from !== undefined) {
    config['auth'] = { token: resolveSecret(serviceDef.auth.token_from, secrets) };
  }

  const method = stepDef.service_method ?? 'fetch';
  const operation = stepDef.operation ?? options.command;

  const adapterParams = resolveInputMap(stepDef.input_map, options, pendingRun);

  // Guard: `delete` is optional on ServiceAdapter. If the adapter omits it, surface
  // ADAPTER_OP_UNSUPPORTED rather than allowing a TypeError from an undefined call.
  const adapterMethod = adapter[method as keyof ServiceAdapter];
  if (typeof adapterMethod !== 'function') {
    throw new WorkflowError(
      `Adapter '${serviceDef.adapter}' does not support service_method '${method}'`,
      {
        code: 'ADAPTER_OP_UNSUPPORTED',
        category: 'ENGINE',
        agentAction: 'report_to_user',
        retryable: false,
      },
    );
  }

  // Proactive rate limiting: acquire a token before calling the service.
  // rateLimiterRegistry is always defined (step-scoped; see executeStep).
  if (serviceDef.rate_limit?.requests_per_second !== undefined) {
    await rateLimiterRegistry
      .getOrCreateRateLimiter(serviceName, serviceDef.rate_limit)
      .acquire(signal);
  }

  let response: ServiceResponse;
  try {
    response = await (adapterMethod as ServiceAdapter['fetch']).call(
      adapter,
      operation,
      adapterParams,
      config,
      signal,
    );
  } catch (err) {
    if (err instanceof WorkflowError) {
      if (err.code === 'SERVICE_RATE_LIMITED') {
        // Resolve retry_after through the three-tier fallback chain:
        //   1. Header value (already on err.retry_after from the adapter)
        //   2. rate_limit.fallback_retry_seconds from YAML
        //   3. adapter.defaultRetryAfterSeconds constant
        // Apply min_retry_seconds as a floor — overrides short Retry-After header values.
        const rawRetryAfter =
          err.retry_after ??
          serviceDef.rate_limit?.fallback_retry_seconds ??
          adapter?.defaultRetryAfterSeconds;
        const minRetry = serviceDef.rate_limit?.min_retry_seconds;
        const resolvedRetryAfter =
          minRetry !== undefined ? Math.max(rawRetryAfter ?? 0, minRetry) : rawRetryAfter;

        // Pause the token bucket for the resolved retry window.
        // The cap (Math.min with max_retry_seconds) is applied before calling pause() so
        // that concurrent callers are never held longer than max_retry_seconds. The pause
        // fires before the fail-fast throw below — this is intentional: even when the
        // current step exits immediately, the bucket is paused to prevent a burst of
        // immediate retries from concurrent steps against an already-overloaded service.
        const maxRetry = serviceDef.rate_limit?.max_retry_seconds;
        if (
          serviceDef.rate_limit?.requests_per_second !== undefined &&
          resolvedRetryAfter !== undefined
        ) {
          const pauseDuration =
            maxRetry !== undefined ? Math.min(resolvedRetryAfter, maxRetry) : resolvedRetryAfter;
          if (pauseDuration > 0) {
            rateLimiterRegistry
              .getOrCreateRateLimiter(serviceName, serviceDef.rate_limit)
              .pause(pauseDuration);
          }
        }

        // Fail fast when the retry window exceeds max_retry_seconds.
        // The pause above has already fired with a capped duration — this throw
        // signals the retry loop to stop rather than wait the full retry window.
        if (
          maxRetry !== undefined &&
          resolvedRetryAfter !== undefined &&
          resolvedRetryAfter > maxRetry
        ) {
          throw new WorkflowError(err.message, {
            code: 'SERVICE_RATE_LIMITED',
            category: 'SERVICE',
            agentAction: 'report_to_user',
            retryable: false,
            retry_after: resolvedRetryAfter,
            ...(Object.keys(err.details).length > 0 ? { details: err.details } : {}),
          });
        }

        // Re-throw with the resolved retry_after (may differ from original).
        if (resolvedRetryAfter !== err.retry_after) {
          throw new WorkflowError(err.message, {
            code: 'SERVICE_RATE_LIMITED',
            category: 'SERVICE',
            agentAction: 'wait_and_proceed',
            retryable: true,
            ...(resolvedRetryAfter !== undefined ? { retry_after: resolvedRetryAfter } : {}),
            ...(Object.keys(err.details).length > 0 ? { details: err.details } : {}),
          });
        }
      }
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(`Adapter '${serviceDef.adapter}' threw: ${message}`, {
      code: 'ENGINE_ADAPTER_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
      stepId: options.command,
    });
  }

  const output =
    typeof response.data === 'object' && response.data !== null
      ? (response.data as Record<string, unknown>)
      : { data: response.data, status: response.status };
  return {
    output,
    resolvedParams: stepDef.input_map !== undefined ? adapterParams : undefined,
  };
}

type HandlerCallResult =
  | { kind: 'data'; output: Record<string, unknown>; resolvedParams?: Record<string, unknown> }
  | {
      kind: 'warn';
      output: Record<string, unknown>;
      message: string;
      resolvedParams?: Record<string, unknown>;
    }
  | { kind: 'abort'; message: string };

/**
 * Resolves and calls the step handler for an auto step with a `handler` reference.
 */
async function callHandler(
  stepDef: StepDefinition,
  options: ExecuteStepOptions,
  pendingRun: RunRecord,
  evidenceByStep: Record<string, Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<HandlerCallResult> {
  const handlerName = stepDef.handler!;
  const handler = (options.registry ?? createDefaultRegistry()).getHandler(handlerName);
  if (handler === undefined) {
    throw new WorkflowError(`Handler '${handlerName}' is not registered`, {
      code: 'ENGINE_HANDLER_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
      stepId: options.command,
    });
  }

  const resolvedInput =
    stepDef.input_map !== undefined
      ? resolveInputMap(stepDef.input_map, options, pendingRun)
      : options.input;
  const handlerResolvedParams = stepDef.input_map !== undefined ? resolvedInput : undefined;

  let result: Awaited<ReturnType<typeof handler.execute>>;
  try {
    result = await handler.execute(
      { params: resolvedInput },
      {
        run_id: options.runId,
        run_params: pendingRun.params,
        config: stepDef.config ?? {},
        resources: evidenceByStep,
      },
      signal,
    );
  } catch (err) {
    if (err instanceof WorkflowError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(`Handler '${handlerName}' threw: ${message}`, {
      code: 'ENGINE_HANDLER_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
      stepId: options.command,
    });
  }

  if (result.abort !== undefined) {
    return { kind: 'abort', message: result.abort.message };
  }
  if (result.warn !== undefined) {
    return {
      kind: 'warn',
      output: result.data ?? {},
      message: result.warn.message,
      ...(handlerResolvedParams !== undefined ? { resolvedParams: handlerResolvedParams } : {}),
    };
  }
  return {
    kind: 'data',
    output: result.data ?? {},
    ...(handlerResolvedParams !== undefined ? { resolvedParams: handlerResolvedParams } : {}),
  };
}

/**
 * Builds a NextAction for a single eligible step, resolving prompt templates.
 */
function stepToNextAction(
  stepName: string,
  step: StepDefinition,
  context: {
    evidenceByStep: Record<string, Record<string, unknown>>;
    runParams: Record<string, unknown>;
    runId: string;
    workflowContext?: {
      snapshots: Record<string, WorkflowContextSnapshot>;
      wrapper: ContextWrapperFormat;
    };
  },
): NextAction {
  const resolvedPrompt =
    step.prompt !== undefined ? renderTemplate(step.prompt, context) : undefined;

  return {
    instruction:
      step.handler !== undefined
        ? { tool: step.handler, params: {}, call_with: {} }
        : step.execution === 'agent'
          ? {
              tool: 'execute_step',
              params: { run_id: context.runId, command: stepName },
              call_with: {
                run_id: context.runId,
                command: stepName,
                params:
                  step.input_schema !== undefined
                    ? generateSchemaSkeleton(step.input_schema as Record<string, unknown>)
                    : {},
              },
            }
          : null,
    ...(step.execution === 'agent' && step.input_schema !== undefined
      ? { input_schema: step.input_schema }
      : {}),
    human_readable: `Execute step '${stepName}': ${step.description}`,
    orientation: `Run is active. Next step ready: '${stepName}'.`,
    ...(step.timeout_seconds !== undefined ? { expected_timeout: `${step.timeout_seconds}s` } : {}),
    ...(resolvedPrompt !== undefined ? { prompt: resolvedPrompt } : {}),
  };
}

/**
 * Returns NextAction objects for all agent-executable eligible steps.
 * Auto steps are excluded — they are executed internally by executeChain.
 */
export function buildNextActions(definition: WorkflowDefinition, run: RunRecord): NextAction[] {
  const eligible = findEligibleSteps(definition, run);
  const evidenceByStep = buildEvidenceByStep(run);
  const context = {
    evidenceByStep,
    runParams: run.params,
    runId: run.id,
    ...(run.workflow_context_snapshots !== undefined
      ? {
          workflowContext: {
            snapshots: run.workflow_context_snapshots,
            wrapper: (definition.context_wrapper ?? 'xml') as ContextWrapperFormat,
          },
        }
      : {}),
  };

  return eligible
    .filter(
      (name) =>
        definition.steps[name]?.execution === 'agent' ||
        definition.steps[name]?.handler !== undefined,
    )
    .map((name) => stepToNextAction(name, definition.steps[name]!, context));
}

/**
 * Merges call-scoped trace-schema warnings with an optional cleanup warning into
 * a single warnings array. Trace warnings are listed first (deterministic order).
 */
function mergeWarnings(traceWarnings: string[], cleanupWarning?: string): string[] {
  if (traceWarnings.length === 0 && cleanupWarning === undefined) return [];
  return cleanupWarning !== undefined ? [...traceWarnings, cleanupWarning] : [...traceWarnings];
}

/** Builds a minimal error ResponseEnvelope from primitive fields. */
function errorEnvelope(
  command: string,
  runId: string,
  runVersion: number,
  err: WorkflowError,
  contextHint?: string,
): ResponseEnvelope {
  return {
    command,
    run_id: runId,
    run_version: runVersion,
    status: 'error',
    data: {},
    evidence: [],
    warnings: [],
    errors: [err.message],
    error_code: err.code,
    ...(Object.keys(err.details).length > 0 ? { error_details: err.details } : {}),
    agent_action: err.agentAction,
    ...(err.retry_after !== undefined ? { retry_after: err.retry_after } : {}),
    context_hint: contextHint ?? `Error during '${command}'.`,
    next_actions: [],
  };
}

/**
 * Builds a ResponseEnvelope for errors caught in an MCP tool's outer catch block,
 * before any step execution has occurred. Translates provide_input and
 * resolve_precondition agent actions to report_to_user (pre-execution context).
 */
export function buildPreExecutionErrorEnvelope(
  command: string,
  runId: string,
  runVersion: number,
  err: WorkflowError,
  contextHint?: string,
): ResponseEnvelope {
  const agentAction = resolvePreExecutionAgentAction(err);
  return {
    command,
    run_id: runId,
    run_version: runVersion,
    status: 'error',
    data: {},
    evidence: [],
    warnings: [],
    errors: [err.message],
    error_code: err.code,
    ...(Object.keys(err.details).length > 0 ? { error_details: err.details } : {}),
    agent_action: agentAction,
    ...(err.retry_after !== undefined ? { retry_after: err.retry_after } : {}),
    context_hint: contextHint ?? `Error during '${command}'.`,
    next_actions: [],
  };
}

function makeErrorEnvelope(
  options: ExecuteStepOptions,
  run: RunRecord | null,
  err: WorkflowError,
  definition?: WorkflowDefinition,
  extraWarnings?: string[],
): ResponseEnvelope {
  const hint =
    run !== null ? `Error during '${options.command}'. Run phase: '${run.run_phase}'.` : undefined;
  const base = errorEnvelope(
    options.command,
    options.runId,
    run !== null ? run.version : 0,
    err,
    hint,
  );
  // Apply pre-execution translation: provide_input / resolve_precondition cannot
  // apply before claimStep — translate them to report_to_user.
  const translatedBase =
    run === null ? { ...base, agent_action: resolvePreExecutionAgentAction(err) } : base;
  const baseWithWarnings =
    extraWarnings !== undefined && extraWarnings.length > 0
      ? { ...translatedBase, warnings: extraWarnings }
      : translatedBase;
  if (run !== null && definition !== undefined && err.agentAction !== 'stop') {
    return { ...baseWithWarnings, next_actions: buildNextActions(definition, run) };
  }
  return baseWithWarnings;
}

/**
 * Validates eligibility, claims the step, executes it through the dispatcher with retry
 * and timeout support, captures evidence, persists the updated run record, and returns
 * a ResponseEnvelope containing the outcome and the next eligible actions.
 */
export async function executeStep(
  store: RunStore,
  definition: WorkflowDefinition,
  options: ExecuteStepOptions,
): Promise<ResponseEnvelope> {
  // Step 1: Load run.
  let run: RunRecord;
  try {
    run = await store.get(options.runId);
  } catch (err) {
    if (err instanceof WorkflowError) {
      return makeErrorEnvelope(options, null, err);
    }
    const internal = new WorkflowError('Failed to load run from store', {
      code: 'ENGINE_STORE_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    });
    return makeErrorEnvelope(options, null, internal);
  }

  // Step 2: Check eligibility.
  const eligible = findEligibleSteps(definition, run);
  if (!eligible.includes(options.command)) {
    const nextActions = buildNextActions(definition, run);
    return {
      command: options.command,
      run_id: options.runId,
      run_version: run.version,
      status: 'blocked',
      data: {},
      evidence: [],
      warnings: [],
      errors: [],
      agent_action: 'resolve_precondition' as const,
      context_hint: `Step '${options.command}' is not eligible in the current run state.`,
      next_actions: nextActions,
      blocked_reason:
        nextActions.length > 0
          ? {
              eligible_steps: eligible,
              suggestion: `Call one of the steps indicated in next_actions instead.`,
            }
          : {
              eligible_steps: eligible,
              suggestion: `No eligible steps available. Check run_phase and completed_steps.`,
            },
    };
  }

  const stepDef = definition.steps[options.command];
  const evidenceByStep = buildEvidenceByStep(run);

  // Step 2a: Evaluate preconditions.
  if (stepDef?.preconditions !== undefined && stepDef.preconditions.length > 0) {
    const failed = checkPreconditions(stepDef.preconditions, evidenceByStep);
    if (failed !== null) {
      return {
        command: options.command,
        run_id: options.runId,
        run_version: run.version,
        status: 'blocked',
        data: {},
        evidence: [],
        warnings: [],
        errors: [],
        agent_action: 'stop' as const,
        context_hint: `Precondition failed for step '${options.command}'.`,
        next_actions: [],
        blocked_reason: {
          eligible_steps: eligible,
          suggestion: `Precondition failed: '${failed.expression}'. Resolved value: ${String(failed.resolved_value)}.`,
        },
      };
    }
  }

  const preconditionTrace = evaluateAllPreconditions(stepDef?.preconditions ?? [], evidenceByStep);

  // Extract _debug before validation — it is never validated, never hashed, never in output_summary.
  let debugOutput: unknown;
  let effectiveInput = options.input;
  if (Object.prototype.hasOwnProperty.call(options.input, '_debug')) {
    const { _debug, ...rest } = options.input;
    debugOutput = _debug;
    effectiveInput = rest;
  }

  // All downstream consumers (handler, adapter, dispatcher, evidence) must see the
  // stripped input. effectiveOptions is identical to options when _debug was absent.
  const effectiveOptions: ExecuteStepOptions = { ...options, input: effectiveInput };

  let inputTokenEstimate = Math.ceil(JSON.stringify(effectiveInput).length / 4);

  // Step 2b: Validate input schema.
  if (stepDef?.input_schema !== undefined) {
    try {
      validateInputSchema(effectiveInput, stepDef.input_schema, options.command);
    } catch (err) {
      return makeErrorEnvelope(options, run, err as WorkflowError, definition);
    }
  }

  // Step 2c: Validate output schema (agent steps only).
  // For agent steps dispatch is a pass-through, so options.input IS the agent's
  // submitted output. Validating here (pre-claim) is equivalent to
  // "post-generation, pre-commit" — the standard output guardrail position.
  if (stepDef?.execution === 'agent' && stepDef.output_schema !== undefined) {
    try {
      validateOutputSchema(effectiveInput, stepDef.output_schema, options.command);
    } catch (err) {
      return makeErrorEnvelope(options, run, err as WorkflowError, definition);
    }
  }

  // Step 2d: Merge WAL buffer + execute_step trace, normalize, validate (agent steps only, pre-claim).
  // walEntries is declared at this scope so it is in scope at the captureEvidence call site below.
  const traceWarnings: string[] = [];
  let preNormalizedTrace: NormalizeTraceResult | undefined;
  let walEntries: BufferedEntry[] = [];

  if (stepDef?.execution === 'agent') {
    // Read WAL buffer if a buffer store is configured.
    walEntries =
      options.traceBufferStore !== undefined
        ? await options.traceBufferStore.read(options.runId, options.command)
        : [];

    const hasAnyTrace =
      walEntries.length > 0 || (options.trace !== undefined && options.trace.length > 0);

    if (hasAnyTrace) {
      // Build merge set: WAL entries carry their _internalTs; execute_step entries
      // receive Date.now() so they sort after all WAL batches (step conclusion ordering).
      const finalTs = Date.now();
      const mergeSet: Array<AgentTraceEntry & { _internalTs: number }> = [
        ...walEntries, // already have _internalTs from buffer store
        ...(options.trace ?? []).map((e) => ({ ...e, _internalTs: finalTs })),
      ];

      // Sort by _internalTs to produce chronological order, then strip the field before
      // passing to normalizeTrace (which operates on plain AgentTraceEntry[]).
      mergeSet.sort((a, b) => a._internalTs - b._internalTs);
      const sortedEntries: AgentTraceEntry[] = mergeSet.map(({ _internalTs: _, ...rest }) => rest);

      // Normalize the merged set once. This is the single canonicalization pass.
      preNormalizedTrace = normalizeTrace(sortedEntries);

      // Validate trace schema if configured (unchanged call site).
      if (stepDef.trace_schema !== undefined) {
        const mode = stepDef.trace_validation_mode ?? 'warn';
        if (mode === 'enforce') {
          try {
            validateTraceSchema(
              preNormalizedTrace.entries,
              stepDef.trace_schema,
              options.command,
              'enforce',
            );
            preNormalizedTrace.summary.schema_applied = true;
            preNormalizedTrace.summary.validation_mode = 'enforce';
            preNormalizedTrace.summary.validation_errors = 0;
          } catch (err) {
            // On enforce rejection: do NOT delete the WAL — agent retries with WAL preserved.
            return makeErrorEnvelope(options, run, err as WorkflowError, definition);
          }
        } else {
          const result = validateTraceSchema(
            preNormalizedTrace.entries,
            stepDef.trace_schema,
            options.command,
            'warn',
          );
          preNormalizedTrace.summary.schema_applied = true;
          preNormalizedTrace.summary.validation_mode = 'warn';
          preNormalizedTrace.summary.validation_errors = result.errorCount;
          if (result.errorCount > 0) {
            traceWarnings.push(result.warning);
          }
        }
      }
    }
  }

  // Step 3: Claim the step — adds to in_progress_steps under file lock.
  let pendingRun: RunRecord;
  try {
    pendingRun = await store.claimStep(options.runId, options.command, definition);
  } catch (err) {
    if (err instanceof WorkflowError) {
      if (err.code === 'STATE_STEP_ALREADY_CLAIMED') {
        const freshRun = await store.get(options.runId).catch(() => run);
        return {
          command: options.command,
          run_id: options.runId,
          run_version: freshRun.version,
          status: 'blocked',
          data: {},
          evidence: [],
          warnings: [],
          errors: [],
          agent_action: 'resolve_precondition' as const,
          context_hint: `Step '${options.command}' was already claimed by another process.`,
          next_actions: buildNextActions(definition, freshRun),
          blocked_reason: {
            eligible_steps: findEligibleSteps(definition, freshRun),
            suggestion: `Step is already in progress. Wait for it to complete.`,
          },
        };
      }
      return makeErrorEnvelope(
        options,
        run,
        err,
        definition,
        traceWarnings.length > 0 ? traceWarnings : undefined,
      );
    }
    return makeErrorEnvelope(
      options,
      run,
      new WorkflowError('Failed to claim step', {
        code: 'ENGINE_STORE_FAILED',
        category: 'ENGINE',
        agentAction: 'stop',
        retryable: false,
      }),
      definition,
      traceWarnings.length > 0 ? traceWarnings : undefined,
    );
  }

  // Load workflow context once at run start — skip if already populated.
  if (
    definition.workflow_context !== undefined &&
    Object.keys(definition.workflow_context).length > 0 &&
    pendingRun.workflow_context_snapshots === undefined
  ) {
    const contextSnapshots = await loadWorkflowContext(definition);
    pendingRun = await store.update({
      ...pendingRun,
      workflow_context_snapshots: contextSnapshots,
    });
  }

  // Step 4: Dispatch with retry and timeout.
  const retryConfig = stepDef?.retry;
  const maxAttempts = retryConfig?.max_attempts ?? 1;
  const timeoutMs =
    stepDef?.timeout_seconds !== undefined ? stepDef.timeout_seconds * 1000 : undefined;

  // Create a stable rate-limiter registry for all retry attempts of this step.
  // Shared state ensures that a pause() triggered on attempt N is still in effect
  // when the proactive acquire() runs on attempt N+1. When the caller provides an
  // explicit registry, it is used directly (also enables cross-step coordination);
  // otherwise a step-scoped fallback is created so rate limiting still works.
  const rateLimiterRegistry: ExtensionRegistry = options.registry ?? new ExtensionRegistry();

  let output: Record<string, unknown> = {};
  let dispatchError: WorkflowError | null = null;
  let attemptsUsed = 0;
  const allEvidence: EvidenceSnapshot[] = [];
  let currentWarn: string | undefined;

  for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
    attemptsUsed = attemptNum;
    const startedAt = new Date();
    let attemptOutput: Record<string, unknown> = {};
    let attemptError: WorkflowError | null = null;
    let resolvedParams: Record<string, unknown> | undefined;

    try {
      const makeCall = (
        signal?: AbortSignal,
      ): Promise<{
        output: Record<string, unknown>;
        resolvedParams: Record<string, unknown> | undefined;
        handlerAbort?: { message: string };
        handlerWarn?: string;
      }> => {
        if (stepDef?.execution === 'auto' && stepDef.uses_service !== undefined) {
          return callAdapter(
            stepDef,
            definition,
            effectiveOptions,
            pendingRun,
            rateLimiterRegistry,
            signal,
          );
        } else if (stepDef?.execution === 'auto' && stepDef.handler !== undefined) {
          return callHandler(stepDef, effectiveOptions, pendingRun, evidenceByStep, signal).then(
            (result) => {
              if (result.kind === 'abort') {
                return {
                  output: {},
                  resolvedParams: undefined,
                  handlerAbort: { message: result.message },
                };
              }
              if (result.kind === 'warn') {
                return {
                  output: result.output,
                  resolvedParams: result.resolvedParams,
                  handlerWarn: result.message,
                };
              }
              return { output: result.output, resolvedParams: result.resolvedParams };
            },
          );
        } else {
          return options
            .dispatcher(options.command, effectiveInput, pendingRun, signal)
            .then((result) => ({ output: result, resolvedParams: undefined }));
        }
      };
      const callResult =
        timeoutMs !== undefined
          ? await withTimeout((signal) => makeCall(signal), timeoutMs, options.command)
          : await makeCall();

      // Handle graceful abort from a handler returning { abort: { message } }.
      if (callResult.handlerAbort !== undefined) {
        const abortMessage = callResult.handlerAbort.message;
        const now = new Date();
        const abortEvidence: EvidenceSnapshot = {
          ...captureEvidence({
            stepId: options.command,
            startedAt: now,
            completedAt: now,
            input: effectiveInput,
            output: { aborted: true, abort_message: abortMessage },
            error: abortMessage,
            ...(debugOutput !== undefined ? { debugOutput } : {}),
          }),
          status: 'skipped',
        };
        const withHandlerSkipped: RunRecord = {
          ...pendingRun,
          in_progress_steps: pendingRun.in_progress_steps.filter((s) => s !== options.command),
          evidence: [...pendingRun.evidence, abortEvidence],
          skipped_steps: [...pendingRun.skipped_steps, options.command],
        };
        const withAllSkipped: RunRecord = {
          ...withHandlerSkipped,
          skipped_steps: propagateSkips(withHandlerSkipped, definition),
        };
        const abortedRun: RunRecord = {
          ...withAllSkipped,
          terminal_state: true,
          terminal_reason: `Handler '${options.command}' aborted the run: ${abortMessage}`,
          aborted_at: {
            step_id: options.command,
            abort_message: abortMessage,
          },
        };
        let persistedAbortRun: RunRecord | undefined;
        try {
          persistedAbortRun = await store.update(abortedRun);
        } catch {
          // Persist failed — return the in-memory run version.
        }
        return {
          command: options.command,
          run_id: options.runId,
          run_version: (persistedAbortRun ?? abortedRun).version,
          status: 'ok',
          data: {},
          evidence: [abortEvidence],
          warnings: [],
          errors: [],
          context_hint: `Handler step '${options.command}' aborted the run: ${abortMessage}`,
          next_actions: [],
        };
      }

      attemptOutput = callResult.output;
      resolvedParams = callResult.resolvedParams;
      currentWarn = callResult.handlerWarn;
      if (resolvedParams !== undefined) {
        inputTokenEstimate = Math.ceil(JSON.stringify(resolvedParams).length / 4);
      }
    } catch (err) {
      if (err instanceof WorkflowError) {
        attemptError = err;
      } else {
        const message = err instanceof Error ? err.message : String(err);
        attemptError = new WorkflowError(`Dispatcher failed: ${message}`, {
          code: 'ENGINE_INTERNAL',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: false,
          stepId: options.command,
        });
      }
    }

    const completedAt = new Date();
    const profile = stepDef?.agent_profile;
    const profileData = profile !== undefined ? definition.resolved_profiles?.[profile] : undefined;
    const baseSnap = captureEvidence({
      stepId: options.command,
      startedAt,
      completedAt,
      input: effectiveInput,
      output: attemptOutput,
      ...(attemptError !== null ? { error: attemptError.message } : {}),
      diagnostics: {
        input_token_estimate: inputTokenEstimate,
        precondition_trace: preconditionTrace,
      },
      ...(profileData !== undefined
        ? { agentProfile: profile!, agentProfileHash: profileData.content_hash }
        : {}),
      ...(resolvedParams !== undefined ? { resolvedParams } : {}),
      ...(currentWarn !== undefined ? { warn: currentWarn } : {}),
      ...(debugOutput !== undefined ? { debugOutput } : {}),
      ...(options.stepMeta?.toolCalls !== undefined
        ? { toolCalls: options.stepMeta.toolCalls }
        : {}),
      // Gate trace to agent steps only — drop silently for auto/adapter/handler steps.
      // When pre-normalized (WAL merge + schema validation ran), pass the pre-normalized
      // result to avoid double normalization. Also handle WAL-only case (options.trace may
      // be undefined while walEntries contributed entries via preNormalizedTrace).
      ...(stepDef?.execution === 'agent' && (options.trace !== undefined || walEntries.length > 0)
        ? preNormalizedTrace !== undefined
          ? { normalizedTrace: preNormalizedTrace }
          : { trace: options.trace ?? [] }
        : {}),
    });
    const snap: EvidenceSnapshot =
      retryConfig !== undefined ? { ...baseSnap, attempt: attemptNum } : baseSnap;
    allEvidence.push(snap);

    if (attemptError === null) {
      output = attemptOutput;
      dispatchError = null;
      break;
    }

    dispatchError = attemptError;
    const willRetry =
      retryConfig !== undefined && attemptError.retryable && attemptNum < maxAttempts;
    if (willRetry) {
      const baseBackoff = computeBackoff(retryConfig, attemptNum);
      const retryAfterMs =
        attemptError instanceof WorkflowError && attemptError.retry_after !== undefined
          ? attemptError.retry_after * 1000
          : 0;
      await delayMs(Math.max(baseBackoff, retryAfterMs));
    } else {
      break;
    }
  }

  if (dispatchError !== null && retryConfig !== undefined && attemptsUsed === maxAttempts) {
    const lastError = dispatchError;
    dispatchError = new WorkflowError(
      `Step '${options.command}' failed after ${attemptsUsed} attempts`,
      {
        code: 'STEP_RETRY_EXHAUSTED',
        category: 'ENGINE',
        agentAction: 'report_to_user',
        retryable: false,
        details: {
          stepName: options.command,
          attempts: attemptsUsed,
          lastError: lastError.message,
          ...(lastError.retry_after !== undefined ? { retry_after: lastError.retry_after } : {}),
        },
      },
    );
  }

  // Step 5: Handle dispatch failure — move step to failed_steps.
  if (dispatchError !== null) {
    // Pure in-memory derivations — no I/O, no try required.
    const afterFail: RunRecord = {
      ...pendingRun,
      in_progress_steps: pendingRun.in_progress_steps.filter((s) => s !== options.command),
      failed_steps: [...pendingRun.failed_steps, options.command],
    };
    // Propagate skips: mark steps whose trigger_rule can never be satisfied after this failure.
    const withSkippedFail: RunRecord = {
      ...afterFail,
      skipped_steps: propagateSkips(afterFail, definition),
    };
    // A run is terminal when all steps are settled OR when no step will ever become
    // eligible again (safety net for when-condition edge cases not covered by propagateSkips).
    // Guard steps are not returned by findEligibleSteps, so check them separately.
    const isComplete =
      isWorkflowComplete(withSkippedFail, definition) ||
      (withSkippedFail.in_progress_steps.length === 0 &&
        findEligibleSteps(definition, withSkippedFail).length === 0 &&
        findEligibleGuardSteps(definition, withSkippedFail).length === 0);
    const failedRun: RunRecord = {
      ...withSkippedFail,
      evidence: [...pendingRun.evidence, ...allEvidence],
      terminal_state: isComplete,
      ...(isComplete
        ? { terminal_reason: `Step '${options.command}' failed: ${dispatchError.message}` }
        : {}),
    };

    // Persist run state and WAL cleanup in separate try/catch blocks so a WAL deletion
    // failure does not mask a successful store.update.
    let persistedRun: RunRecord | undefined;
    let storeCleanupWarning: string | undefined;
    try {
      persistedRun = await store.update(failedRun);
    } catch (storeErr) {
      storeCleanupWarning = `Failed to persist step failure: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`;
    }
    let walCleanupWarning: string | undefined;
    try {
      // Delete WAL after run state is written for failure — entries are now in evidence.
      await options.traceBufferStore?.delete(options.runId, options.command);
    } catch (walErr) {
      walCleanupWarning = `Failed to clean up trace buffer after step failure: ${walErr instanceof Error ? walErr.message : String(walErr)}`;
    }

    // Derive the agent_action from the error semantics and run termination state.
    //
    // Non-terminal 'stop' errors (e.g. auth failure with a recovery branch) are surfaced
    // as 'report_to_user' so the agent knows recovery steps are available. Terminal runs
    // stay 'stop' — no further progress is possible.
    //
    // 'provide_input' and 'resolve_precondition' both imply "retry the same command" which
    // is impossible once a step is in failed_steps; translate both to 'report_to_user'.
    const effectiveAction = resolvePostDispatchAgentAction(
      dispatchError,
      (persistedRun ?? failedRun).terminal_state,
    );

    // Mirror makeErrorEnvelope: populate next_actions for any action other than 'stop',
    // but only when store.update succeeded (inconsistent state → no reliable next_actions).
    let nextActions: NextAction[] = [];
    if (effectiveAction !== 'stop' && storeCleanupWarning === undefined) {
      try {
        nextActions = buildNextActions(definition, persistedRun ?? failedRun);
      } catch {
        // buildNextActions can throw for unresolvable template references; fall back to [].
      }
    }

    const contextHint =
      effectiveAction === 'stop'
        ? `Step '${options.command}' failed. Run is terminated.`
        : effectiveAction === 'wait_and_proceed'
          ? `Step '${options.command}' was rate-limited. Wait ${dispatchError.retry_after !== undefined ? `${dispatchError.retry_after} second(s)` : 'a moment'} then follow next_actions — no human intervention required.`
          : effectiveAction === 'wait_for_human'
            ? `Step '${options.command}' failed due to external service unavailability. Wait for service recovery, then proceed with the steps in next_actions.`
            : `Step '${options.command}' failed. ${isComplete ? 'Run is terminated.' : 'Recovery steps are available in next_actions.'}`;

    return {
      command: options.command,
      run_id: options.runId,
      run_version: (persistedRun ?? failedRun).version,
      status: 'error',
      data: {},
      evidence: allEvidence,
      warnings: mergeWarnings(traceWarnings, storeCleanupWarning ?? walCleanupWarning),
      errors: [dispatchError.message],
      agent_action: effectiveAction,
      ...(dispatchError.retry_after !== undefined
        ? { retry_after: dispatchError.retry_after }
        : {}),
      context_hint: contextHint,
      next_actions: nextActions,
    };
  }

  // Step 5b: Gate check — if trust requires human confirmation, open a gate and halt.
  if (stepDef!.trust === 'human_confirmed' || stepDef!.trust === 'human_reviewed') {
    const gate_id = crypto.randomUUID();
    const choicesRaw =
      stepDef!.gate?.choices ?? stepDef!.input_schema?.properties?.['choice']?.enum;
    const choices = Array.isArray(choicesRaw) ? (choicesRaw as string[]) : ['approve', 'reject'];
    const step_name = options.command;

    // Resolve gate.message if configured — fail-fast on unresolvable references.
    const gateEvidenceCtxEarly = { ...evidenceByStep, [options.command]: output };
    const wfCtxSpreadEarly =
      pendingRun.workflow_context_snapshots !== undefined
        ? {
            workflowContext: {
              snapshots: pendingRun.workflow_context_snapshots,
              wrapper: (definition.context_wrapper ?? 'xml') as ContextWrapperFormat,
            },
          }
        : {};
    let resolvedGateMessage: string | undefined;
    if (stepDef!.gate?.message !== undefined) {
      let raw: string;
      try {
        raw = renderTemplate(
          stepDef!.gate.message,
          {
            evidenceByStep: gateEvidenceCtxEarly,
            runParams: run.params,
            ...wfCtxSpreadEarly,
          },
          { strict: true },
        );
      } catch (err) {
        if (err instanceof UnknownFilterError) {
          return makeErrorEnvelope(
            options,
            pendingRun,
            new WorkflowError(`gate.message uses unknown filter '${err.filterName}'`, {
              code: 'FILTER_UNKNOWN',
              category: 'ENGINE',
              agentAction: 'stop',
              retryable: false,
            }),
            definition,
            traceWarnings.length > 0 ? traceWarnings : undefined,
          );
        }
        throw err;
      }
      const unresolved = [...raw.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]);
      if (unresolved.length > 0) {
        return makeErrorEnvelope(
          options,
          pendingRun,
          new WorkflowError(`gate.message has unresolvable references: ${unresolved.join(', ')}`, {
            code: 'GATE_MESSAGE_UNRESOLVABLE',
            category: 'ENGINE',
            agentAction: 'stop',
            retryable: false,
          }),
          definition,
          traceWarnings.length > 0 ? traceWarnings : undefined,
        );
      }
      resolvedGateMessage = raw;
    }

    const gateConfig = stepDef!.gate;

    let gateRun: RunRecord;
    try {
      gateRun = await store.update({
        ...pendingRun,
        // Step stays in in_progress_steps while gate is open — moved to completed on submit.
        evidence: [...pendingRun.evidence, ...allEvidence],
        pending_gate: {
          gate_id,
          step_name,
          preview: output,
          choices,
          opened_at: new Date().toISOString(),
          ...(gateConfig?.owner !== undefined ? { owner: gateConfig.owner } : {}),
          ...(resolvedGateMessage !== undefined ? { resolved_message: resolvedGateMessage } : {}),
          ...(gateConfig?.resolution_messages !== undefined
            ? { resolution_messages: gateConfig.resolution_messages }
            : {}),
        },
      });
    } catch (err) {
      if (err instanceof WorkflowError) {
        return makeErrorEnvelope(
          options,
          pendingRun,
          err,
          definition,
          traceWarnings.length > 0 ? traceWarnings : undefined,
        );
      }
      return makeErrorEnvelope(
        options,
        pendingRun,
        new WorkflowError('Failed to open gate', {
          code: 'ENGINE_STORE_FAILED',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: false,
        }),
        definition,
        traceWarnings.length > 0 ? traceWarnings : undefined,
      );
    }

    // gate.display fallback chain: gate.message resolved → step.prompt resolved → absent
    const resolvedGateDisplay =
      resolvedGateMessage !== undefined
        ? resolvedGateMessage
        : stepDef!.prompt !== undefined
          ? renderTemplate(stepDef!.prompt, {
              evidenceByStep: gateEvidenceCtxEarly,
              runParams: run.params,
              ...wfCtxSpreadEarly,
            })
          : undefined;
    const resolvedGateInstructions =
      stepDef!.instructions !== undefined
        ? renderTemplate(stepDef!.instructions, {
            evidenceByStep: gateEvidenceCtxEarly,
            runParams: run.params,
            ...wfCtxSpreadEarly,
          })
        : undefined;

    const gateNextAction: NextAction = {
      instruction: {
        tool: 'submit_human_response',
        params: { run_id: options.runId, gate_id },
        call_with: {
          run_id: options.runId,
          gate_id,
          choice: `<${choices.join('|')}>`,
        },
      },
      human_readable: `Human review required for step '${options.command}'. Present gate.display to the user, wait for their choice from gate.response_spec.choices, then call submit_human_response.`,
      orientation: `Run is paused at gate '${gate_id}'. Available choices: ${choices.join(', ')}.`,
    };

    return {
      command: options.command,
      run_id: options.runId,
      run_version: gateRun.version,
      status: 'confirm_required',
      data: output,
      evidence: allEvidence,
      warnings: [...traceWarnings],
      errors: [],
      context_hint: `Run is paused at gate '${gate_id}'. Available choices: ${choices.join(', ')}.`,

      next_actions: [gateNextAction],
      gate: {
        gate_id,
        step_name,
        preview: output,
        choices,
        ...(resolvedGateDisplay !== undefined ? { display: resolvedGateDisplay } : {}),
        ...(resolvedGateInstructions !== undefined ? { agent_hint: resolvedGateInstructions } : {}),
        response_spec: { choices },
      },
    };
  }

  // Step 6: Move step from in_progress to completed, compute terminal state.
  const afterComplete: RunRecord = {
    ...pendingRun,
    in_progress_steps: pendingRun.in_progress_steps.filter((s) => s !== options.command),
    completed_steps: [...pendingRun.completed_steps, options.command],
    evidence: [...pendingRun.evidence, ...allEvidence],
  };
  // Propagate skips: completing this step may make some downstream steps permanently ineligible
  // (e.g. all_failed steps whose dep just succeeded, one_failed steps whose last unfailed dep just completed).
  const withSkippedComplete: RunRecord = {
    ...afterComplete,
    skipped_steps: propagateSkips(afterComplete, definition),
  };
  // A run is terminal when all steps are settled OR when no step will ever become
  // eligible again (safety net for when-condition routing not fully covered by propagateSkips).
  // Guard steps are not returned by findEligibleSteps, so check them separately.
  const isComplete =
    isWorkflowComplete(withSkippedComplete, definition) ||
    (withSkippedComplete.in_progress_steps.length === 0 &&
      findEligibleSteps(definition, withSkippedComplete).length === 0 &&
      findEligibleGuardSteps(definition, withSkippedComplete).length === 0);
  const finalRun: RunRecord = {
    ...withSkippedComplete,
    terminal_state: isComplete,
    ...(isComplete ? { terminal_reason: `Workflow completed.` } : {}),
  };

  let savedRun: RunRecord;
  try {
    savedRun = await store.update(finalRun);
  } catch (err) {
    if (err instanceof WorkflowError) {
      return makeErrorEnvelope(
        options,
        pendingRun,
        err,
        definition,
        traceWarnings.length > 0 ? traceWarnings : undefined,
      );
    }
    const internal = new WorkflowError('Failed to persist run update', {
      code: 'ENGINE_STORE_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    });
    return makeErrorEnvelope(
      options,
      pendingRun,
      internal,
      definition,
      traceWarnings.length > 0 ? traceWarnings : undefined,
    );
  }

  // Delete WAL after successful run update — entries are now in evidence.
  await options.traceBufferStore?.delete(options.runId, options.command);

  // Step 7: Build and return ResponseEnvelope.
  const nextActions = savedRun.terminal_state ? [] : buildNextActions(definition, savedRun);
  const orientation = savedRun.terminal_state
    ? `Run completed (phase: '${savedRun.run_phase}'). Call get_run_state with run_id '${options.runId}' to retrieve the full evidence record.`
    : nextActions.length > 0
      ? `Step '${options.command}' completed. ${nextActions.length} step(s) now available.`
      : `Step '${options.command}' completed. Waiting for other steps to complete.`;

  return {
    command: options.command,
    run_id: options.runId,
    run_version: savedRun.version,
    status: 'ok',
    data: output,
    evidence: allEvidence,
    warnings: mergeWarnings(traceWarnings, currentWarn),
    errors: [],
    context_hint: orientation,
    next_actions: nextActions,
  };
}

/**
 * Submits a human response for a gate-waiting run.
 * Validates the gate_id and choice, then moves the step to completed_steps.
 */
export async function submitHumanResponse(
  store: RunStore,
  definition: WorkflowDefinition,
  options: SubmitGateOptions,
): Promise<ResponseEnvelope> {
  // 1. Load run.
  let run: RunRecord;
  try {
    run = await store.get(options.runId);
  } catch (err) {
    const e =
      err instanceof WorkflowError
        ? err
        : new WorkflowError('Failed to load run from store', {
            code: 'ENGINE_STORE_FAILED',
            category: 'ENGINE',
            agentAction: 'stop',
            retryable: false,
          });
    return errorEnvelope('submit_gate', options.runId, 0, e);
  }

  // 2. Verify a gate is open.
  if (run.pending_gate === undefined) {
    return errorEnvelope(
      'submit_gate',
      options.runId,
      run.version,
      new WorkflowError('Run is not waiting at a gate.', {
        code: 'STATE_BLOCKED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      }),
      `Run '${options.runId}' has no open gate (phase: '${run.run_phase}').`,
    );
  }

  // 3. Verify gate_id.
  if (run.pending_gate.gate_id !== options.gateId) {
    return errorEnvelope(
      'submit_gate',
      options.runId,
      run.version,
      new WorkflowError('Gate ID mismatch.', {
        code: 'STATE_BLOCKED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      }),
      `Gate ID mismatch on run '${options.runId}'.`,
    );
  }

  // 4. Validate choice.
  if (!run.pending_gate.choices.includes(options.choice)) {
    const expected = run.pending_gate.choices.join(', ');
    return errorEnvelope(
      run.pending_gate.step_name,
      options.runId,
      run.version,
      new WorkflowError(`Choice '${options.choice}' is not valid. Expected one of: ${expected}`, {
        code: 'VALIDATION_INPUT_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        retryable: false,
      }),
      `Invalid choice '${options.choice}' for gate '${run.pending_gate.step_name}'.`,
    );
  }

  // 5. Record gate response evidence and move step to completed_steps.
  const gateStepName = run.pending_gate.step_name;
  const respondedAt = new Date();
  const gateEvidence = captureEvidence({
    stepId: gateStepName,
    startedAt: new Date(run.pending_gate.opened_at),
    completedAt: respondedAt,
    input: { choice: options.choice },
    output: { ...run.pending_gate.preview, choice: options.choice },
  });
  const gateSnapshot: EvidenceSnapshot = {
    ...gateEvidence,
    kind: 'gate_response' as const,
    ...(run.pending_gate.resolved_message !== undefined
      ? { gate_message: run.pending_gate.resolved_message }
      : {}),
  };

  const { pending_gate: _pg, terminal_reason: _tr, ...rest } = run;
  const afterGate: RunRecord = {
    ...rest,
    in_progress_steps: rest.in_progress_steps.filter((s) => s !== gateStepName),
    completed_steps: [...rest.completed_steps, gateStepName],
    evidence: [...rest.evidence, gateSnapshot],
  };
  // Propagate skips in case resolving the gate completes a dep that makes
  // some downstream trigger_rules permanently unsatisfiable.
  const withSkippedGate: RunRecord = {
    ...afterGate,
    skipped_steps: propagateSkips(afterGate, definition),
  };
  // A run is terminal when all steps are settled OR when no step will ever become
  // eligible again (safety net for when-condition routing not fully covered by propagateSkips).
  // Guard steps are not returned by findEligibleSteps, so check them separately.
  const isComplete =
    isWorkflowComplete(withSkippedGate, definition) ||
    (withSkippedGate.in_progress_steps.length === 0 &&
      findEligibleSteps(definition, withSkippedGate).length === 0 &&
      findEligibleGuardSteps(definition, withSkippedGate).length === 0);
  const finalRun: RunRecord = {
    ...withSkippedGate,
    terminal_state: isComplete,
    ...(isComplete ? { terminal_reason: `Workflow completed.` } : {}),
  };

  let savedRun: RunRecord;
  try {
    savedRun = await store.update(finalRun);
  } catch (err) {
    const e =
      err instanceof WorkflowError
        ? err
        : new WorkflowError('Failed to persist gate response', {
            code: 'ENGINE_STORE_FAILED',
            category: 'ENGINE',
            agentAction: 'stop',
            retryable: false,
          });
    return errorEnvelope(
      gateStepName,
      options.runId,
      run.version,
      e,
      `Failed to persist gate response.`,
    );
  }

  // 6. Build response.
  const data = { ...run.pending_gate.preview, choice: options.choice };
  const nextActions = savedRun.terminal_state ? [] : buildNextActions(definition, savedRun);
  const orientation = savedRun.terminal_state
    ? `Run completed (phase: '${savedRun.run_phase}'). Call get_run_state with run_id '${options.runId}' to retrieve the full evidence record.`
    : `Gate '${gateStepName}' resolved with choice '${options.choice}'. ${nextActions.length} step(s) now available.`;

  return {
    command: gateStepName,
    run_id: options.runId,
    run_version: savedRun.version,
    status: 'ok',
    data,
    evidence: [],
    warnings: [],
    errors: [],
    context_hint: orientation,
    next_actions: nextActions,
  };
}

const MAX_CHAIN_DEPTH = 50;

/**
 * Executes a guard step inline within the engine's auto-chain.
 *
 * Guard steps are never claimed via claimStep — they execute synchronously as part of
 * the chain, not via agent execute_step calls. This function evaluates all abort_unless
 * conditions and returns an updated RunRecord:
 *
 * - PASS: guard in completed_steps, run continues.
 * - ABORT: guard in skipped_steps, terminal_state=true, aborted_at set.
 * - RESOLUTION_ERROR: guard in failed_steps, terminal_state=true, evidence with error.
 *
 * The caller is responsible for persisting the returned RunRecord via store.update.
 */
async function executeGuardStep(
  stepName: string,
  stepDef: StepDefinition,
  definition: WorkflowDefinition,
  run: RunRecord,
): Promise<RunRecord> {
  // Normalise abort_unless to string[].
  const conditions = Array.isArray(stepDef.abort_unless)
    ? stepDef.abort_unless
    : [stepDef.abort_unless!];

  // Build evidenceByStep from current run.
  const evidenceByStep = buildEvidenceByStep(run);

  // Evaluate all conditions (no short-circuit — record all outcomes).
  const outcome = evaluateGuardConditions(conditions, evidenceByStep);

  const now = new Date();

  if (outcome.kind === 'resolution_error') {
    // Authoring error — a path in abort_unless could not be resolved.
    // Record evidence with error status and place guard in failed_steps.
    const evidenceEntry = captureEvidence({
      stepId: stepName,
      startedAt: now,
      completedAt: now,
      input: {},
      output: { error: `Unresolvable path: ${outcome.unresolvable_path}` },
      error: `Guard resolution error on condition: ${outcome.condition}`,
    });

    const withFailed: RunRecord = {
      ...run,
      evidence: [...run.evidence, evidenceEntry],
      failed_steps: [...run.failed_steps, stepName],
    };
    const withSkipped: RunRecord = {
      ...withFailed,
      skipped_steps: propagateSkips(withFailed, definition),
    };
    return {
      ...withSkipped,
      terminal_state: true,
      terminal_reason: `Guard step '${stepName}' failed: unresolvable path '${outcome.unresolvable_path}'`,
    };
  }

  if (outcome.kind === 'pass') {
    // All conditions true — guard passed, run continues.
    const evidenceEntry = captureEvidence({
      stepId: stepName,
      startedAt: now,
      completedAt: now,
      input: {},
      output: { conditions: outcome.conditions, aborted: false },
    });

    const withCompleted: RunRecord = {
      ...run,
      evidence: [...run.evidence, evidenceEntry],
      completed_steps: [...run.completed_steps, stepName],
    };
    const withSkipped: RunRecord = {
      ...withCompleted,
      skipped_steps: propagateSkips(withCompleted, definition),
    };
    const isComplete =
      isWorkflowComplete(withSkipped, definition) ||
      (withSkipped.in_progress_steps.length === 0 &&
        findEligibleSteps(definition, withSkipped).length === 0 &&
        findEligibleGuardSteps(definition, withSkipped).length === 0);
    return {
      ...withSkipped,
      terminal_state: isComplete,
      ...(isComplete ? { terminal_reason: 'Workflow completed.' } : {}),
    };
  }

  // Guard fired — one or more conditions false; abort the run.
  const evidenceEntry = captureEvidence({
    stepId: stepName,
    startedAt: now,
    completedAt: now,
    input: {},
    output: {
      conditions: outcome.conditions,
      aborted: true,
      ...(stepDef.abort_message !== undefined ? { abort_message: stepDef.abort_message } : {}),
    },
    error: stepDef.abort_message ?? `Guard step '${stepName}' aborted the run.`,
  });

  const withGuardSkipped: RunRecord = {
    ...run,
    evidence: [...run.evidence, evidenceEntry],
    // Guard that aborted goes into skipped_steps (not completed or failed).
    skipped_steps: [...run.skipped_steps, stepName],
  };
  // Propagate skips for any downstream steps that can no longer fire.
  const withAllSkipped: RunRecord = {
    ...withGuardSkipped,
    skipped_steps: propagateSkips(withGuardSkipped, definition),
  };
  return {
    ...withAllSkipped,
    terminal_state: true,
    aborted_at: {
      step_id: stepName,
      conditions: outcome.conditions,
      ...(stepDef.abort_message !== undefined ? { abort_message: stepDef.abort_message } : {}),
    },
  };
}

async function executeChainInternal(
  store: RunStore,
  definition: WorkflowDefinition,
  options: ExecuteChainOptions,
  depth: number,
  chainedSteps: Array<{
    step: string;
    run_phase: string;
    branched_via?: string;
    warnings?: string[];
  }>,
): Promise<ResponseEnvelope> {
  if (depth > MAX_CHAIN_DEPTH) {
    return {
      command: options.command,
      run_id: options.runId,
      run_version: 0,
      status: 'error',
      data: {},
      evidence: [],
      warnings: [],
      errors: [
        'Auto-execution chain exceeded maximum depth (50). Possible cycle in workflow definition.',
      ],
      agent_action: 'stop' as const,
      context_hint: `Auto-step chain exceeded depth limit (50) for run '${options.runId}'.`,
      next_actions: [],
    };
  }

  let result = await executeStep(store, definition, options);

  // Stop chaining on any non-ok result.
  if (result.status !== 'ok') {
    return result;
  }

  // Load the current run to determine what comes next.
  let run: RunRecord;
  try {
    run = await store.get(options.runId);
  } catch {
    return result;
  }

  // Record this auto step in the accumulator.
  if (definition.steps[options.command]?.execution === 'auto') {
    chainedSteps.push({
      step: options.command,
      run_phase: run.run_phase,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    });
  }

  if (run.terminal_state || run.pending_gate !== undefined) {
    return result;
  }

  // Execute any eligible guard steps inline before looking for the next auto step.
  // Guard steps are synchronous engine decisions — not returned to the agent.
  // Loop to handle cascading guards (guard A passes → guard B becomes eligible).
  let guardEligible = findEligibleGuardSteps(definition, run);
  while (guardEligible.length > 0) {
    const guardName = guardEligible[0]!;
    const guardStepDef = definition.steps[guardName]!;

    // Execute inline (pure in-memory; returns updated RunRecord).
    const guardResult = await executeGuardStep(guardName, guardStepDef, definition, run);

    // Persist the guard step result.
    let persistedGuardRun: RunRecord;
    try {
      persistedGuardRun = await store.update(guardResult);
    } catch (storeErr) {
      const msg = storeErr instanceof Error ? storeErr.message : String(storeErr);
      return {
        command: options.command,
        run_id: options.runId,
        run_version: run.version,
        status: 'error',
        data: {},
        evidence: [],
        warnings: [],
        errors: [`Failed to persist guard step '${guardName}': ${msg}`],
        agent_action: 'stop' as const,
        context_hint: `Guard step '${guardName}' could not be persisted. Run state may be inconsistent.`,
        next_actions: [],
      };
    }

    // Record in chained_auto_steps for visibility.
    chainedSteps.push({ step: guardName, run_phase: persistedGuardRun.run_phase });

    if (persistedGuardRun.terminal_state) {
      // Guard aborted or had a resolution error — run is terminal.
      const contextHint =
        persistedGuardRun.aborted_at !== undefined
          ? `Guard step '${guardName}' aborted the run.`
          : `Guard step '${guardName}' failed with a resolution error. Run is terminated.`;
      return {
        command: options.command,
        run_id: options.runId,
        run_version: persistedGuardRun.version,
        status: 'ok',
        data: {},
        evidence: persistedGuardRun.evidence.slice(-1),
        warnings: [],
        errors: [],
        context_hint: contextHint,
        next_actions: [],
      };
    }

    run = persistedGuardRun;
    guardEligible = findEligibleGuardSteps(definition, run);
  }

  // If any guards ran and passed, rebuild result with fresh next_actions and run_version.
  // The original `result` was built before guard execution, so its next_actions and version are stale.
  const guardsRan = chainedSteps.some((s) => definition.steps[s.step]?.execution === 'guard');
  if (guardsRan) {
    const freshNextActions = buildNextActions(definition, run);
    result = {
      ...result,
      run_version: run.version,
      next_actions: freshNextActions,
    };
  }

  if (run.terminal_state || run.pending_gate !== undefined) {
    return result;
  }

  // Find the next eligible auto step and chain into it.
  const eligible = findEligibleSteps(definition, run);
  const nextAutoStep = eligible.find((name) => definition.steps[name]?.execution === 'auto');

  if (nextAutoStep === undefined) {
    // Only agent steps or nothing — stop chain, return with latest next_actions.
    return result;
  }

  return executeChainInternal(
    store,
    definition,
    { ...options, command: nextAutoStep, input: {} },
    depth + 1,
    chainedSteps,
  );
}

/**
 * Executes a step and automatically chains into subsequent `execution: auto` steps.
 * Stops at agent steps, gate steps (returning confirm_required), errors, or terminal state.
 * Returns next_actions containing all eligible agent steps when the auto chain exhausts.
 */
export async function executeChain(
  store: RunStore,
  definition: WorkflowDefinition,
  options: ExecuteChainOptions,
): Promise<ResponseEnvelope> {
  const effectiveOptions: ExecuteChainOptions = {
    ...options,
    registry: options.registry ?? createDefaultRegistry(),
  };
  const chained: Array<{
    step: string;
    run_phase: string;
    branched_via?: string;
    warnings?: string[];
  }> = [];
  const result = await executeChainInternal(store, definition, effectiveOptions, 0, chained);
  const chainWarnings = chained.flatMap((s) => s.warnings ?? []);
  const envelope = {
    ...result,
    command: options.command,
    ...(chainWarnings.length > 0
      ? { warnings: [...(result.warnings ?? []), ...chainWarnings] }
      : {}),
  };
  return chained.length > 0 ? { ...envelope, chained_auto_steps: chained } : envelope;
}

// Re-export TERMINAL_PHASES so existing importers via execution-loop.js still resolve.
export { TERMINAL_PHASES as TERMINAL_STATES };
