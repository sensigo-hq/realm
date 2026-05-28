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
} from '../types/workflow-definition.js';
import type { RunStore } from '../store/store-interface.js';
import { captureEvidence } from '../evidence/snapshot.js';
import {
  validateInputSchema,
  validateOutputSchema,
  validateTraceSchema,
} from '../validation/input-schema.js';
import { normalizeTrace } from './trace-normalizer.js';
import type { NormalizeTraceResult } from './trace-normalizer.js';
import { TERMINAL_PHASES } from './lifecycle.js';
import { checkPreconditions, evaluateAllPreconditions } from './precondition.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import type { ServiceResponse } from '../extensions/service-adapter.js';
import { resolveSecret } from '../config/secrets.js';
import { renderTemplate, resolvePath, UnknownFilterError } from './render-template.js';
import { generateSchemaSkeleton } from '../utils/schema-skeleton.js';
import { loadWorkflowContext } from './workflow-context-loader.js';
import {
  findEligibleSteps,
  isWorkflowComplete,
  buildEvidenceByStep,
  propagateSkips,
} from './eligibility.js';

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

/**
 * Resolves an input_map declaration into a concrete params object.
 * Falls back to options.input when input_map is absent.
 */
function resolveInputMap(
  inputMap: Record<string, string> | undefined,
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
  for (const [key, path] of Object.entries(inputMap)) {
    result[key] = resolvePath(path, root);
  }
  return result;
}

/** Computes the delay (ms) before a retry attempt based on the configured backoff strategy. */
function computeBackoff(config: RetryConfig, attemptNum: number): number {
  switch (config.backoff) {
    case 'fixed':
      return config.base_delay_ms;
    case 'linear':
      return config.base_delay_ms * attemptNum;
    case 'exponential':
      return config.base_delay_ms * Math.pow(2, attemptNum - 1);
  }
}

/**
 * Resolves and calls the service adapter for an auto step with `uses_service`.
 */
async function callAdapter(
  stepDef: StepDefinition,
  definition: WorkflowDefinition,
  options: ExecuteStepOptions,
  pendingRun: RunRecord,
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
  const config: Record<string, unknown> = { adapter: serviceDef.adapter, trust: serviceDef.trust };
  if (serviceDef.auth?.token_from !== undefined) {
    config['auth'] = { token: resolveSecret(serviceDef.auth.token_from, secrets) };
  }

  const method = stepDef.service_method ?? 'fetch';
  const operation = stepDef.operation ?? options.command;

  const adapterParams = resolveInputMap(stepDef.input_map, options, pendingRun);
  let response: ServiceResponse;
  try {
    response = await adapter[method](operation, adapterParams, config, signal);
  } catch (err) {
    if (err instanceof WorkflowError) throw err;
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

/**
 * Resolves and calls the step handler for an auto step with a `handler` reference.
 */
async function callHandler(
  stepDef: StepDefinition,
  options: ExecuteStepOptions,
  pendingRun: RunRecord,
  evidenceByStep: Record<string, Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
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

  let result: Awaited<ReturnType<typeof handler.execute>>;
  try {
    result = await handler.execute(
      { params: options.input },
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

  return result.data;
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
    agent_action: err.agentAction,
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
  const baseWithWarnings =
    extraWarnings !== undefined && extraWarnings.length > 0
      ? { ...base, warnings: extraWarnings }
      : base;
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
  let inputTokenEstimate = Math.ceil(JSON.stringify(options.input).length / 4);

  // Step 2b: Validate input schema.
  if (stepDef?.input_schema !== undefined) {
    try {
      validateInputSchema(options.input, stepDef.input_schema, options.command);
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
      validateOutputSchema(options.input, stepDef.output_schema, options.command);
    } catch (err) {
      return makeErrorEnvelope(options, run, err as WorkflowError, definition);
    }
  }

  // Step 2d: Validate trace schema (agent steps only, pre-claim).
  // Normalizes the trace once here so the canonical entries can be validated, and carries
  // the pre-normalized result through to captureEvidence to avoid double normalization.
  const traceWarnings: string[] = [];
  let preNormalizedTrace: NormalizeTraceResult | undefined;
  if (
    stepDef?.execution === 'agent' &&
    stepDef.trace_schema !== undefined &&
    options.trace !== undefined
  ) {
    preNormalizedTrace = normalizeTrace(options.trace);
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
      return makeErrorEnvelope(options, run, err, definition);
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

  let output: Record<string, unknown> = {};
  let dispatchError: WorkflowError | null = null;
  let attemptsUsed = 0;
  const allEvidence: EvidenceSnapshot[] = [];

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
      }> => {
        if (stepDef?.execution === 'auto' && stepDef.uses_service !== undefined) {
          return callAdapter(stepDef, definition, options, pendingRun, signal);
        } else if (stepDef?.execution === 'auto' && stepDef.handler !== undefined) {
          return callHandler(stepDef, options, pendingRun, evidenceByStep, signal).then(
            (result) => ({ output: result, resolvedParams: undefined }),
          );
        } else {
          return options
            .dispatcher(options.command, options.input, pendingRun, signal)
            .then((result) => ({ output: result, resolvedParams: undefined }));
        }
      };
      const callResult =
        timeoutMs !== undefined
          ? await withTimeout((signal) => makeCall(signal), timeoutMs, options.command)
          : await makeCall();
      attemptOutput = callResult.output;
      resolvedParams = callResult.resolvedParams;
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
      input: options.input,
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
      ...(options.stepMeta?.toolCalls !== undefined
        ? { toolCalls: options.stepMeta.toolCalls }
        : {}),
      // Gate trace to agent steps only — drop silently for auto/adapter/handler steps.
      // When pre-normalized (schema validation ran), pass the pre-normalized result to avoid
      // double normalization. Otherwise pass raw trace for lazy normalization in captureEvidence.
      ...(stepDef?.execution === 'agent' && options.trace !== undefined
        ? preNormalizedTrace !== undefined
          ? { normalizedTrace: preNormalizedTrace }
          : { trace: options.trace }
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
      await delayMs(computeBackoff(retryConfig, attemptNum));
    } else {
      break;
    }
  }

  if (dispatchError !== null && retryConfig !== undefined && attemptsUsed === maxAttempts) {
    const lastError = dispatchError;
    dispatchError = new WorkflowError(
      `Step '${options.command}' failed after ${maxAttempts} attempts`,
      {
        code: 'STEP_RETRY_EXHAUSTED',
        category: 'ENGINE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { stepName: options.command, attempts: maxAttempts, lastError: lastError.message },
      },
    );
  }

  // Step 5: Handle dispatch failure — move step to failed_steps.
  if (dispatchError !== null) {
    let cleanupWarning: string | undefined;
    try {
      // Build the hypothetical run state after marking this step as failed.
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
      const isComplete =
        isWorkflowComplete(withSkippedFail, definition) ||
        (withSkippedFail.in_progress_steps.length === 0 &&
          findEligibleSteps(definition, withSkippedFail).length === 0);
      const failedRun: RunRecord = {
        ...withSkippedFail,
        evidence: [...pendingRun.evidence, ...allEvidence],
        terminal_state: isComplete,
        ...(isComplete
          ? { terminal_reason: `Step '${options.command}' failed: ${dispatchError.message}` }
          : {}),
      };
      await store.update(failedRun);
    } catch (cleanupErr) {
      cleanupWarning = `Failed to persist step failure: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`;
    }
    return {
      command: options.command,
      run_id: options.runId,
      run_version: pendingRun.version,
      status: 'error',
      data: {},
      evidence: allEvidence,
      warnings: mergeWarnings(traceWarnings, cleanupWarning),
      errors: [dispatchError.message],
      agent_action: 'stop' as const,
      context_hint: `Step '${options.command}' failed.`,
      next_actions: [],
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
  const isComplete =
    isWorkflowComplete(withSkippedComplete, definition) ||
    (withSkippedComplete.in_progress_steps.length === 0 &&
      findEligibleSteps(definition, withSkippedComplete).length === 0);
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
    warnings: traceWarnings,
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
  const isComplete =
    isWorkflowComplete(withSkippedGate, definition) ||
    (withSkippedGate.in_progress_steps.length === 0 &&
      findEligibleSteps(definition, withSkippedGate).length === 0);
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

async function executeChainInternal(
  store: RunStore,
  definition: WorkflowDefinition,
  options: ExecuteChainOptions,
  depth: number,
  chainedSteps: Array<{ step: string; run_phase: string; branched_via?: string }>,
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

  const result = await executeStep(store, definition, options);

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
    chainedSteps.push({ step: options.command, run_phase: run.run_phase });
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
  const chained: Array<{ step: string; run_phase: string; branched_via?: string }> = [];
  const result = await executeChainInternal(store, definition, effectiveOptions, 0, chained);
  const envelope = { ...result, command: options.command };
  return chained.length > 0 ? { ...envelope, chained_auto_steps: chained } : envelope;
}

// Re-export TERMINAL_PHASES so existing importers via execution-loop.js still resolve.
export { TERMINAL_PHASES as TERMINAL_STATES };
