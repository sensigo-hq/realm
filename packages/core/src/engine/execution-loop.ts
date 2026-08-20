// Central execution loop — orchestrates eligibility check, claim, dispatcher, evidence capture,
// run state update, and ResponseEnvelope construction for the DAG execution model.
// Includes: step claiming, step-level retry, step timeouts, human gate mechanics,
// auto-chaining with fan-out, and registry-based dispatch for adapter and handler steps.
import type {
  RunRecord,
  RunPhase,
  EvidenceSnapshot,
  WorkflowContextSnapshot,
  AgentTraceEntry,
  TraceNormalizationSummary,
  PendingGate,
  StructuredOutputMeta,
} from '../types/run-record.js';
import type { ToolCallRecord } from '../types/mcp-types.js';
import { extensionIdentityDiffers } from '../types/extension-identity.js';
import type { ResponseEnvelope, NextAction } from '../types/response-envelope.js';
import { WorkflowError } from '../types/workflow-error.js';
import type {
  WorkflowDefinition,
  StepDefinition,
  ContextWrapperFormat,
  InputMapNode,
  LiteralNode,
} from '../types/workflow-definition.js';
import type { RunStore } from '../store/store-interface.js';
import { persistsField } from '../store/store-fidelity.js';
import type { TraceBufferStore, BufferedEntry } from '../store/trace-buffer-store.js';
import { storeDeclaresSeal, storeDeclaresNonceCarriage } from '../store/trace-buffer-store.js';
import { partitionBufferedEntries, type BufferedEntryPartition } from './trace-adoption.js';
import { deriveDefaultedSteps } from './defaulted-steps.js';
import { computeGateDueState } from './gate-timing.js';
import {
  selectFinalizers,
  deriveEffectiveTriggers,
  applySettlement,
  renderFailCause,
  failureMessagesFromEvidence,
  failureMessagesWithOverlay,
} from './settlement.js';
import type {
  SettleStepDelta,
  SettlementResult,
  MarkFinalizerResult,
  OpenGateDelta,
  SettleGateDelta,
  SettleGuardDelta,
  ReleaseStepDelta,
  ExpireGateDelta,
} from '../types/settlement.js';
import { captureEvidence } from '../evidence/snapshot.js';
import {
  validateInputSchema,
  validateOutputSchema,
  validateTraceSchema,
} from '../validation/input-schema.js';
import { normalizeTrace } from './trace-normalizer.js';
import type { NormalizeTraceResult } from './trace-normalizer.js';
import { TERMINAL_PHASES, DRAIN_CEILING_SECONDS } from './lifecycle.js';
import {
  omitClaim,
  shouldEnforceTimeout,
  DEFAULT_EXECUTION_TIMEOUT_SECONDS,
  resolveCapMs,
  sleepWouldExceedCap,
} from './claim-liveness.js';
import { computeBackoff } from './backoff.js';
import {
  checkPreconditions,
  evaluateAllPreconditions,
  evaluateGuardConditions,
} from './precondition.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';
import { renderTemplate, resolvePath, UnknownFilterError } from './render-template.js';
import { generateSchemaSkeleton } from '../utils/schema-skeleton.js';
import { loadWorkflowContext } from './workflow-context-loader.js';
import {
  findEligibleSteps,
  findEligibleGuardSteps,
  isWorkflowComplete,
  buildEvidenceByStep,
  propagateSkips,
  deriveRunPhase,
  armToOutcome,
  assertSealMarkersAgree,
} from './eligibility.js';
import { requirementForStep } from './capability.js';
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
  /**
   * Tool calls produced by callStepWithTools for this step.
   * Absent on the callStep path (no tools configured).
   * Present (possibly []) when tools were declared — threads through to captureEvidence.
   *
   * `structuredOutput` (issue #236): the caller's own `structured_output: 'strict'` attempt
   * disclosure for THIS attempt — threads into the diagnostics literal at every evidence-capture
   * site. Independent of `toolCalls` (either alone must still cause `stepMeta` to be passed).
   */
  stepMeta?: { toolCalls?: ToolCallRecord[]; structuredOutput?: StructuredOutputMeta };
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
  /**
   * Client-minted, opaque per-step-attempt writer identity (issue #197 PR-2, design §2) — pre-
   * validated at the tool/CLI layer (shape, presence-on-non-agent-step); the engine never
   * validates its shape, only uses it as an opaque comparison key. Honored ONLY when the
   * configured `traceBufferStore` declares `writer_nonce_carriage` (the activation gate,
   * design §3) — on a lesser store this is IGNORED entirely (the honest #185 adopt-all floor),
   * since that store's WAL entries are bare too and honoring a real nonce there would self-demote
   * the claimant's own bare evidence to "foreign". Absent ⇒ ⊥ (bare/anonymous writer class),
   * today's byte-identical behavior.
   */
  writerNonce?: string;
  /**
   * Issue #291: injectable clock for deterministic expiry tests (the execute_step pre-refusal
   * enact-then-proceed check reads this). Defaults to `new Date()` — real callers never set it.
   */
  now?: Date;
}

export interface SubmitGateOptions {
  runId: string;
  gateId: string;
  choice: string;
  /**
   * Extension registry for resolving finalizer handlers when resolving this gate completes
   * the run (the gate-completion terminal transition drains `complete`/`always` finalizers).
   * When omitted, the engine uses the default (filesystem-only) registry — a finalizer whose
   * handler is not in that registry is recorded as a non-fatal failure. Callers that resolve
   * gates on workflows with finalizers should thread their run registry here.
   */
  registry?: ExtensionRegistry;
  /**
   * Issue #279 (increment 2, PR-D; design record D-5): unenforced attribution passthrough — flows
   * into the `SettleGateDelta.respondedBy` field AND the gate_response evidence snapshot's own
   * `responded_by` field when supplied. RECORDED, not enforced (the bearer-gateId-as-sole-
   * credential model stays authoritative); no arm ever reads it.
   */
  respondedBy?: string;
  /**
   * Issue #291: injectable clock for deterministic expiry tests (the F3 write-free
   * `gate_expired_pending` refusal + the caller-issued `expire_gate` follow-up both read this).
   * Defaults to `new Date()` — real callers never set it.
   */
  now?: Date;
}

export interface ExecuteChainOptions {
  runId: string;
  command: string;
  input: Record<string, unknown>;
  dispatcher: StepDispatcher;
  /** @see ExecuteStepOptions.registry */
  registry?: ExtensionRegistry;
  /**
   * Tool calls produced by callStepWithTools for this step.
   * Absent on the callStep path (no tools configured).
   * Present (possibly []) when tools were declared — threads through to captureEvidence.
   *
   * `structuredOutput` (issue #236): the caller's own `structured_output: 'strict'` attempt
   * disclosure for THIS attempt — threads into the diagnostics literal at every evidence-capture
   * site. Independent of `toolCalls` (either alone must still cause `stepMeta` to be passed).
   */
  stepMeta?: { toolCalls?: ToolCallRecord[]; structuredOutput?: StructuredOutputMeta };
  /** @see ExecuteStepOptions.trace */
  trace?: AgentTraceEntry[];
  /** @see ExecuteStepOptions.traceBufferStore */
  traceBufferStore?: TraceBufferStore;
  /** @see ExecuteStepOptions.writerNonce */
  writerNonce?: string;
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
          // issue #140: details gain `stepId` alongside the pre-existing `stepName` — additive,
          // never removes stepName (byte-identical shape for any existing consumer of that key).
          details: { stepName, stepId: stepName, timeout_ms: ms },
        }),
      );
    }, ms);
  });

  return Promise.race([dispatch(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/** Maximum nesting depth allowed in an input_map tree. */
const MAX_INPUT_MAP_DEPTH = 10;

/**
 * Issue #220: default per-step threshold for bounded validation-rejection exhaustion — the
 * multiple-of-(schemaRetries+1) alignment formula at k=2 (two full default `realm agent` repair
 * drives, schemaRetries defaulting to 2 ⇒ 3 attempts/drive ⇒ termination lands at drive
 * boundaries at defaults). Exported so `realm agent`'s drive-time coherence warn (run-agent.ts)
 * and a per-step `validation_exhaustion.threshold` override (yaml-loader.ts) share ONE source of
 * truth. Every countable agent step (see `countRejection` below) is auto-enrolled at this
 * threshold — there is no reachable default-off posture in PR-1.
 */
export const DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD = 6;

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

  // issue #287 — the RUNTIME MIRROR of the loader's directive gate. The loader stops new
  // registrations; this stops the ones already stored. That distinction is the whole point: a
  // registered realm workflow RE-EXECUTES its corruption on every run, so validating only at
  // authoring would leave existing definitions quietly producing garbage forever.
  //
  // Two cases, one code:
  //   (a) any `$`-prefixed key that is not a supported directive;
  //   (b) `$literal` WITH sibling keys — which the sole-key conjunct above lets fall through to
  //       nested-map recursion, where the literal's own VALUE gets resolved as a context path
  //       under a result key literally named "$literal". Silent garbage, and reachable today.
  //
  // Failing loudly here costs a step failure; not failing costs plausible-looking success, which
  // is what turned the originating incident into five weeks of corrupted records.
  const REMEDY =
    `To pass literal data containing $-keys, wrap the subtree in $literal. input_map values ` +
    `are context paths, nested maps, or $literal — templated strings are not supported.`;
  const DIRECTIVE_ERROR_OPTS = {
    code: 'INPUT_MAP_UNKNOWN_DIRECTIVE',
    category: 'ENGINE',
    agentAction: 'report_to_user',
    retryable: false,
  } as const;

  // (b) `$literal` with siblings. Named accurately rather than as an "unknown directive" — the
  // directive is fine, its company is not, and that is the mistake the author has to see.
  if ('$literal' in node) {
    const siblings = Object.keys(node).filter((k) => k !== '$literal');
    throw new WorkflowError(
      `input_map path "${keyChain}": $literal node must have exactly one key ($literal); found ` +
        `sibling keys: ${siblings.join(', ')}. ${REMEDY}`,
      DIRECTIVE_ERROR_OPTS,
    );
  }

  // (a) any other reserved-prefix key.
  for (const key of Object.keys(node)) {
    if (!key.startsWith('$')) continue;
    throw new WorkflowError(
      `input_map path "${keyChain}": unknown directive '${key}' — supported directives: $literal. ` +
        REMEDY,
      DIRECTIVE_ERROR_OPTS,
    );
  }

  // Nested object — recurse.
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    result[key] = resolveInputMapNode(child as InputMapNode, root, `${keyChain}.${key}`, depth + 1);
  }
  return result;
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
  const lookupRegistry = options.registry ?? createDefaultRegistry();
  const adapter = lookupRegistry.getAdapter(serviceDef.adapter);
  if (adapter === undefined) {
    // UX hint: when the missing name is not among the registry's current names and the
    // definition declares no `extensions`, point at the deployment manifest.
    const extensionHint =
      !lookupRegistry.has('adapter', serviceDef.adapter) && definition.extensions === undefined
        ? `. Declare this adapter under 'adapters:' in realm.yaml at your deployment root.`
        : '';
    throw new WorkflowError(
      `Adapter '${serviceDef.adapter}' for service '${serviceName}' is not registered${extensionHint}`,
      {
        // #134 discriminator: minted at the NOT-REGISTERED site ONLY (not the service-not-found or
        // adapter-runtime throws), so Step 5 can settle this RECOVERABLY instead of terminal-burning.
        code: 'ENGINE_ADAPTER_NOT_REGISTERED',
        category: 'ENGINE',
        agentAction: 'stop',
        retryable: false,
        stepId: options.command,
      },
    );
  }

  // Credentials are bound at adapter CONSTRUCTION time via the deployment manifest
  // (realm.yaml) — the engine injects no auth. `auth.token_from` was removed in v0.14.0.
  const config: Record<string, unknown> = {
    adapter: serviceDef.adapter,
    trust: serviceDef.trust,
    ...(stepDef.config ?? {}),
  };

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
      // #134 discriminator: minted at the NOT-REGISTERED site ONLY (not the ran-and-threw throw
      // below), so Step 5 can settle this RECOVERABLY instead of terminal-burning the step.
      code: 'ENGINE_HANDLER_NOT_REGISTERED',
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
 * Merges call-scoped trace-schema warnings with any number of optional extra warnings into a
 * single warnings array. Trace warnings are listed first (deterministic order); `extraWarnings`
 * entries are appended in call order, `undefined` entries skipped. Variadic since issue #207
 * PR-2 (the success-settle path now has TWO independent optional warnings to merge — a
 * handler-level warning and a WAL-cleanup warning — where every earlier call site had at most
 * one).
 */
function mergeWarnings(
  traceWarnings: string[],
  ...extraWarnings: (string | undefined)[]
): string[] {
  const defined = extraWarnings.filter((w): w is string => w !== undefined);
  if (traceWarnings.length === 0 && defined.length === 0) return [];
  return [...traceWarnings, ...defined];
}

/**
 * Pure helper (issue #220 PR-2, D6): if `sealDraft`'s evidence has any entries default-settled
 * (per {@link deriveDefaultedSteps}, issue #232 — the SHARED derivation the read surfaces also
 * use), returns the record with `defaulted_steps` set to their distinct step names — else returns
 * the SAME record reference unchanged, so a run with no default-settle anywhere is byte-identical
 * to pre-PR-2 behavior (the damage-rail this preserves). Pure, no I/O.
 *
 * Applied by WRAPPING the `buildFinalizedSeal` call inside the TERMINAL branch of each seal
 * ternary — `buildFinalizedSeal` itself stays byte-untouched (a chokepoint insertion was
 * considered and rejected in the design record: it reaches fail/abort seals too and would be a
 * fragile two-touch above the damage-rail fast-path). Callers must pass ONLY a sealed record from
 * the `'complete'` branch — never a non-terminal draft, and never a fail/abort seal — so
 * `defaulted_steps` never leaks onto a persisted non-terminal record that a later FAIL seal
 * inherits (the FM-5 residual this guards). issue #232 note: this complete-only stamping is
 * UNCHANGED — a run that fails/aborts still carries no persisted `defaulted_steps`; the failure-
 * path disclosure gap is closed by the READ surfaces calling `deriveDefaultedSteps` directly, not
 * by widening what gets persisted here.
 */
function stampDefaultedSteps(sealDraft: RunRecord): RunRecord {
  const steps = deriveDefaultedSteps(sealDraft.evidence);
  if (steps.length === 0) return sealDraft;
  return { ...sealDraft, defaulted_steps: steps };
}

/**
 * The compensating un-claim's own audit-evidence entry (issue #207 PR-2, D3 §5; extracted issue
 * #279, increment 2, PR-D, Deliverable 1e — the `:679` semantics both the legacy
 * `buildCompensatingUnclaim` below AND the migrated `release_step` delta's `evidence` field share
 * verbatim).
 */
function buildCompensatingUnclaimEvidence(stepName: string, now: Date): EvidenceSnapshot {
  return captureEvidence({
    stepId: stepName,
    startedAt: now,
    completedAt: now,
    input: {},
    output: {
      compensating_unclaim: true,
      reason: 'adoption-read failure after claim',
      unclaimed_at: now.toISOString(),
    },
  });
}

/**
 * Compensating un-claim (issue #207 PR-2, D3 §5): built from `pendingRun` — the record OUR OWN
 * `claimStep` call returned, never a fresh get — removing the step from `in_progress_steps` AND
 * `claims[step]` in the SAME mutation (the settle-site invariant every other settle path in this
 * file upholds), plus an audit-evidence entry. The caller CAS's this against `pendingRun.version`
 * (by passing the returned record straight to `store.update`): any intervening write (a
 * concurrent settle, reclaim, or second claim) bumps version, so this compensating un-claim can
 * never stomp it — a CAS mismatch means some other actor already resolved the claim, and the
 * caller must stop immediately rather than retry, leaving the claim exactly as that actor left
 * it. A step already absent from `in_progress_steps` (should not happen here, but the filter is
 * naturally idempotent) is simply a no-op mutation, not a special case.
 */
function buildCompensatingUnclaim(pendingRun: RunRecord, stepName: string, now: Date): RunRecord {
  const auditEvidence = buildCompensatingUnclaimEvidence(stepName, now);
  return {
    ...pendingRun,
    in_progress_steps: pendingRun.in_progress_steps.filter((s) => s !== stepName),
    claims: omitClaim(pendingRun.claims, stepName),
    evidence: [...pendingRun.evidence, auditEvidence],
  };
}

/**
 * Guard for the settle-time seal attempt (issue #197 PR-2, deliverable 1f) — ONE lock-free
 * `store.get` re-verifying the run exists and this step has actually LEFT `in_progress_steps`
 * (i.e. our own settling `store.update` already landed) — the "purge-guard shape" (mirrors
 * #184's terminal-re-verify-under-lock precedent). In the normal case this always passes: by the
 * time either settle site calls `sealFenced`, the settling update has already committed
 * synchronously just above it. A run genuinely gone (e.g. concurrently purged) surfaces as
 * `store.get`'s own typed `STATE_RUN_NOT_FOUND` throw — deliberately NOT special-cased here; it
 * propagates as an ordinary guard THROW, which the caller's uniform "a throw ⇒ warn + skip the
 * delete" handling already covers correctly (residue-not-loss either way).
 */
function buildSettleSealGuard(
  store: RunStore,
  runId: string,
  stepName: string,
): () => Promise<void> {
  return async () => {
    const fresh = await store.get(runId);
    if (fresh.in_progress_steps.includes(stepName)) {
      throw new WorkflowError(
        `Refusing to seal trace buffer for run '${runId}' step '${stepName}': the step is still ` +
          'in_progress (the settling update has not yet landed) — residue-not-loss, the live WAL ' +
          'is left intact.',
        {
          code: 'STATE_STEP_PENDING',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: true,
        },
      );
    }
  };
}

/**
 * Issue #185 Fix 1 (budget-priority): builds the merged, canonicalized trace for an agent step,
 * giving `traceInput` (the `execute_step` conclusion — unambiguously THIS execution's own)
 * priority into the truncation budget over `bufferEntries` (buffer/WAL lines, which may
 * originate from a prior or concurrent writer — see Fix 3 / `buffered_lines_adopted`).
 *
 * Previously the merge sorted `options.trace` last (chronologically) and handed the WHOLE set to
 * `normalizeTrace`, which keeps the FIRST N entries and drops the rest once truncated. When a
 * prior/concurrent attempt left more than the budget's worth of buffer lines, the winner's own
 * conclusion was the first thing dropped — canonical trace became majority-foreign plus a
 * truncation sentinel, with the real conclusion gone. This function establishes the invariant
 * that `traceInput`, when present, always survives, while keeping truncation accounting honest
 * (the OLDEST buffer lines are the ones actually reported as overflow).
 *
 * `normalizeTrace`'s global keep-first truncation semantics are UNCHANGED — every single-input
 * trace still depends on them, and this function calls it unmodified. Instead, THIS function
 * decides the ORDER entries reach `normalizeTrace`:
 *   1. A throwaway DRY pass processes candidates in PRIORITY order (the conclusion first, then
 *      buffer lines newest→oldest, using each entry's chronological RANK — not a timestamp
 *      comparison, so same-batch buffer entries sharing one `_internalTs` still resolve
 *      unambiguously) purely to learn how many entries the budget admits (`acceptedCount`).
 *   2. The REAL call then processes: the first `acceptedCount` priority-order candidates,
 *      re-sorted into TRUE CHRONOLOGICAL order (so `seq` still functions as a chronological
 *      proxy) — followed by the remaining priority-order tail, UNCHANGED. Because a fixed
 *      accepted set's total byte/count cost is order-invariant (see below), this reordered
 *      prefix is guaranteed to be accepted in full, and the tail then reproduces the EXACT SAME
 *      trip point (same running total, same next candidate) the dry pass already found — so the
 *      real call organically, honestly re-derives its own accurate sentinel/summary. No manual
 *      patching of `normalizeTrace`'s output is needed anywhere in this function.
 *
 * Why the reordered prefix can never re-trigger truncation before the tail: `normalizeTrace`
 * assigns `seq` sequentially as entries are accepted, so processing a FIXED accepted set in a
 * different order only relabels which member gets which number 1..N — the total serialized byte
 * cost of that field is therefore order-invariant, as is every other (content-derived) field. A
 * first-trigger scan's running total is a partial sum of non-negative terms, so it never exceeds
 * the set's own final total — and the dry pass already proved that final total fits. This also
 * means a reserved-prefix (`trace.*`) buffer entry landing inside the reordered prefix costs
 * nothing (skipped for free, as always) and is self-correcting: the real call simply accepts one
 * further tail entry to compensate, still preferring the next-newest buffer line — the "prefer
 * newest" invariant holds exactly, not just approximately.
 *
 * Pass-through (byte-identical to pre-#185 behavior) when `bufferEntries` is empty — the
 * regression guard this preserves.
 */
function buildPriorityMergedTrace(
  bufferEntries: BufferedEntry[],
  traceInput: AgentTraceEntry[] | undefined,
): NormalizeTraceResult {
  if (bufferEntries.length === 0) {
    return normalizeTrace(traceInput ?? []);
  }

  // Chronological rank: buffer entries keep their stored (append) order — read() returns them
  // oldest-first, across however many separate append() batches contributed. options.trace
  // entries (the execute_step conclusion) always rank after every buffer entry, mirroring the
  // pre-#185 merge's "conclusion sorts last" intent — a plain integer rank sidesteps same-batch
  // buffer entries sharing one `_internalTs` (a real, common case: one append() call stamps its
  // whole batch with a single timestamp), which a timestamp-only sort cannot resolve stably.
  type Ranked = AgentTraceEntry & { _rank: number };
  const rankedBuffer: Ranked[] = bufferEntries.map((entry, i) => {
    const { _internalTs: _drop, ...rest } = entry;
    return { ...rest, _rank: i };
  });
  const rankedTrace: Ranked[] = (traceInput ?? []).map((entry, i) => ({
    ...entry,
    _rank: bufferEntries.length + i,
  }));

  // Priority order: the conclusion first (always favored), then buffer lines newest→oldest.
  const priorityOrder: Ranked[] = [...rankedTrace, ...[...rankedBuffer].reverse()];

  const dryRun = normalizeTrace(priorityOrder.map(({ _rank: _drop, ...rest }) => rest));
  if (!dryRun.summary.truncated) {
    // Nothing exceeds the budget — chronological merge + a single normalize, byte-identical to
    // the pre-#185 merge shape (no selection needed).
    const chronological = [...priorityOrder]
      .sort((a, b) => a._rank - b._rank)
      .map(({ _rank: _drop, ...rest }) => rest);
    return normalizeTrace(chronological);
  }

  // stored_entries counts the dry pass's own sentinel too — subtract it to get the count of
  // genuinely-submitted candidates the budget actually admits, in priority order.
  const acceptedCount = dryRun.summary.stored_entries - 1;
  const survivorsChronological = priorityOrder
    .slice(0, acceptedCount)
    .sort((a, b) => a._rank - b._rank);
  const tail = priorityOrder.slice(acceptedCount); // unchanged priority-order tail — see doc above
  const reordered: AgentTraceEntry[] = [...survivorsChronological, ...tail].map(
    ({ _rank: _drop, ...rest }) => rest,
  );

  return normalizeTrace(reordered);
}

/** Builds a minimal error ResponseEnvelope from primitive fields. */
function errorEnvelope(
  command: string,
  runId: string,
  runVersion: number,
  err: WorkflowError,
  contextHint?: string,
  runPhase?: RunPhase,
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
    ...(runPhase !== undefined ? { run_phase: runPhase } : {}),
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
    run !== null ? run.run_phase : undefined,
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
 * Design record §6: a claim-time refusal envelope's advisory line when the fresh run carries
 * finalizer_ledger pendings — points the caller at the recovery verb. `undefined` when there is
 * nothing pending (the common case — never emits an empty/placeholder advisory).
 */
function finalizerDrainAdvisory(run: RunRecord): string | undefined {
  const pendingCount = Object.values(run.finalizer_ledger ?? {}).filter(
    (e) => e.status === 'pending',
  ).length;
  if (pendingCount === 0) return undefined;
  return `${pendingCount} finalizer(s) not yet delivered — realm run drain ${run.id}`;
}

/**
 * Re-arm disclosure (final-gate F10b, design record §6) — the settling caller's own comparison,
 * NEVER inside the frozen `applySettlement` transform: any finalizer that was `'voided'` (an
 * operator `--void`) in `before.finalizer_ledger` and is `'pending'` again in
 * `after.finalizer_ledger` was just RE-ARMED by mintFresh on THIS terminal edge (a later
 * fail-then-complete-differently — or any outcome that newly selects it — re-mints a clean pending
 * entry per §4's mint rule; mintFresh has no memory of a prior void, by design). Called only when
 * `result.transitioned === true` (mintFresh only ever runs on the terminal false→true edge).
 */
function computeReArmWarnings(
  before: RunRecord['finalizer_ledger'],
  after: RunRecord['finalizer_ledger'],
): string[] {
  const warnings: string[] = [];
  for (const [name, afterEntry] of Object.entries(after ?? {})) {
    const beforeEntry = before?.[name];
    if (beforeEntry?.status === 'voided' && afterEntry.status === 'pending') {
      warnings.push(`finalizer '${name}' was operator-voided; re-armed by this terminal edge`);
    }
  }
  return warnings;
}

/**
 * Builds the ResponseEnvelope for a `settle_step`/`open_gate` REFUSAL (design record §7's
 * result/code table) — shared by the three migrated `settle_step` seal sites (issue #279,
 * increment 1, PR-B) AND the migrated gate-open site (issue #279, increment 2, PR-D; `kind:
 * 'open_gate'`). `allEvidence` is attached ONLY for `claim_lost`: the dispatch DID run and produce
 * evidence; it just was not recorded, so the caller should still see what happened. The reasons
 * both callers can actually return are enumerated explicitly; every OTHER `SettlementRefusalReason`
 * member is lease/mark/settle_gate/settle_guard/release_step-only and structurally unreachable
 * here (a `default` throws rather than silently mis-rendering one) — `choice_not_eligible` +
 * `gate_choice_conflict` + the settle_gate `gate_mismatch`/`run_terminal` variants are consumed at
 * 1b's own `errorEnvelope` (submitHumanResponse), never here; `gate_open_wait` is chain-consumed
 * (executeChainInternal's guard loop); `already_released` is site-handled at 1d/1e (never routed
 * through this shared builder).
 */
function buildSettlementRefusalEnvelope(
  options: ExecuteStepOptions,
  definition: WorkflowDefinition,
  result: Extract<SettlementResult, { applied: false }>,
  allEvidence: EvidenceSnapshot[],
  traceWarnings: string[],
  kind: 'settle_step' | 'open_gate' = 'settle_step',
): ResponseEnvelope {
  const extraWarnings = traceWarnings.length > 0 ? traceWarnings : undefined;
  switch (result.reason) {
    case 'already_settled_by_other':
    case 'settled_outcome_divergence': {
      const persisted = result.run.settled?.[options.command]?.outcome;
      // N1 (design record §2/§11): neutral wording — never amplify a "by_other" white lie. When
      // the persisted entry's outcome is 'gate', the step was settled by a COMPLETED GATE (a
      // human decision resolved elsewhere), not literally "a different attempt".
      const settledByText = persisted === 'gate' ? 'by a completed gate' : 'by a different attempt';
      const err = new WorkflowError(
        `Step '${options.command}' was already settled` +
          (persisted !== undefined ? ` with outcome '${persisted}'` : '') +
          ` ${settledByText}.`,
        {
          code: 'STATE_STEP_ALREADY_SETTLED',
          category: 'STATE',
          agentAction: 'resolve_precondition',
          retryable: false,
          details: {
            runId: options.runId,
            step: options.command,
            reason: result.reason,
            ...(persisted !== undefined ? { persisted_outcome: persisted } : {}),
          },
        },
      );
      return makeErrorEnvelope(options, result.run, err, definition, extraWarnings);
    }
    case 'claim_lost': {
      const err = new WorkflowError(
        `Step '${options.command}': this attempt's outcome was NOT recorded — the claim was lost ` +
          `(settled by another writer, or the run advanced).`,
        {
          code: 'STATE_CLAIM_LOST',
          category: 'STATE',
          agentAction: 'resolve_precondition',
          retryable: false,
          details: { runId: options.runId, step: options.command },
        },
      );
      return {
        ...makeErrorEnvelope(options, result.run, err, definition, extraWarnings),
        evidence: allEvidence,
      };
    }
    case 'run_terminal': {
      const err = new WorkflowError(
        `Run '${options.runId}' is terminal; cannot settle step '${options.command}'.`,
        {
          code: 'STATE_RUN_TERMINAL',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
          details: { runId: options.runId, run_phase: result.run.run_phase },
        },
      );
      return makeErrorEnvelope(options, result.run, err, definition, extraWarnings);
    }
    case 'gate_mismatch': {
      // kind-discriminated (Deliverable 2): open_gate's gate_mismatch means a DIFFERENT step's
      // gate is open (this step stays claimed — L13); settle_step's means THIS step IS the open
      // gate and must be resolved via submit_human_response instead.
      const message =
        kind === 'open_gate'
          ? `Step '${options.command}': a gate is open on another step — wait for its resolution; ` +
            `this step stays claimed.`
          : `Step '${options.command}' is the currently open gate; resolve it via ` +
            `submit_human_response instead of settling it directly.`;
      const err = new WorkflowError(message, {
        code: 'STATE_BLOCKED',
        category: 'STATE',
        agentAction: 'resolve_precondition',
        retryable: false,
        details: { runId: options.runId, step: options.command },
      });
      return makeErrorEnvelope(options, result.run, err, definition, extraWarnings);
    }
    default:
      // run_not_terminal / ledger_not_pending / lease_held / lease_lost / rank_blocked /
      // not_eligible / already_leased / already_marked / already_open / already_released /
      // gate_choice_conflict / choice_not_eligible / gate_open_wait are all consumed elsewhere
      // (lease_finalizer/mark_finalizer's own drain loop; open_gate's own NOOP arms at the 1a call
      // site; 1b's own errorEnvelope; 1d/1e's own site-handling; the guard chain) — settle_step and
      // open_gate never return them here (design record §7).
      throw new Error(
        `buildSettlementRefusalEnvelope: unreachable '${kind}' refusal reason '${result.reason}'`,
      );
  }
}

/**
 * Ok-shaped envelope for a `settle_step` NOOP (`already_settled`) — the idempotent-retry case
 * (design record §7: ok-shaped, calm context_hint, never `report_to_user`). Drain-aware: when the
 * fresh run still carries pending finalizers, this retry attempts the SAME post-commit drain a
 * fresh apply would have run — recovering an ambiguous-retry crash window (§6). A drain failure
 * degrades to a warning (never an error status) — the settle itself is not in question here.
 */
async function buildAlreadySettledEnvelope(
  store: RunStore,
  definition: WorkflowDefinition,
  options: ExecuteStepOptions,
  result: Extract<SettlementResult, { applied: false }> & { reason: 'already_settled' },
  traceWarnings: string[],
): Promise<ResponseEnvelope> {
  let run = result.run;
  let drainWarnings: string[] = [];
  const hasPending = Object.values(run.finalizer_ledger ?? {}).some((e) => e.status === 'pending');
  if (hasPending) {
    try {
      const drainOutcome = await drainFinalizers(
        store,
        definition,
        options.registry,
        options.runId,
      );
      run = drainOutcome.run;
      drainWarnings = drainOutcome.warnings;
    } catch (err) {
      drainWarnings = [
        `post-commit finalizer drain failed: ${err instanceof Error ? err.message : String(err)}`,
      ];
    }
  }
  const nextActions = run.terminal_state ? [] : buildNextActions(definition, run);
  return {
    command: options.command,
    run_id: options.runId,
    run_version: run.version,
    status: 'ok',
    data: {},
    evidence: [],
    warnings: mergeWarnings(traceWarnings, ...drainWarnings),
    errors: [],
    context_hint: `Step '${options.command}' was already settled (a duplicate/retried attempt) — no action was taken.`,
    run_phase: run.run_phase,
    next_actions: nextActions,
  };
}

/**
 * Design record §10 (I16, fail-closed dormancy): the ONE advisory warning every legacy
 * (dormancy-fallback) seal-site envelope carries when `store.settleStep` is undeclared — never a
 * hard requirement; the legacy read-then-update path remains fully functional. This dual branch
 * persists until a major version (final-gate F4/R13).
 */
const DORMANCY_ADVISORY =
  'settled via the legacy compatibility path — this store does not declare atomic settlement ' +
  '(RunStore.settleStep); upgrade the store to close the fan-out seal race (issue #279)';

/**
 * issue #291 (D1 "execute_step pre-refusal" enactment point — enact-then-proceed): if `run`
 * carries an expired, enactable gate (`expires_at` past, `on_expiry` frozen), enacts it via the
 * SAME dormancy-discriminated pattern `submitHumanResponse` uses (settleStep when declared, else
 * the pure `applySettlement` transform + `store.update`'s CAS write) and returns the resulting
 * (possibly unchanged) run plus any disclosure line for the caller's `warnings` array. A
 * finding-only gate (no `on_expiry`) is a fast no-op — nothing to enact, never touched. Any
 * refusal from the enactment attempt (a benign race: `already_settled`/`not_expired`/
 * `gate_mismatch`/`run_terminal`) is absorbed silently — the caller's own subsequent eligibility
 * re-check against the returned `run` is what actually matters, and a NOOP correctly leaves `run`
 * as the fresh state the refusal matched against. [F4] advisory-not-crash: an external store's
 * OWN `settleStep` throwing on the `expire_gate` kind (a pre-#291 re-implementing store
 * honoring the union-openness contract's refuse-loud mandate) degrades to a console advisory and
 * proceeds with `run` UNCHANGED — never crashes the caller's verb.
 */
async function enactExpiredGateIfDue(
  store: RunStore,
  definition: WorkflowDefinition,
  run: RunRecord,
  registry: ExtensionRegistry | undefined,
  now: Date,
): Promise<{ run: RunRecord; disclosure?: string }> {
  const gate = run.pending_gate;
  if (
    gate === undefined ||
    gate.expires_at === undefined ||
    gate.on_expiry === undefined ||
    now.getTime() < new Date(gate.expires_at).getTime()
  ) {
    return { run };
  }

  const delta = { kind: 'expire_gate' as const, gateId: gate.gate_id };
  let expireOutcome: SettlementResult;
  try {
    if (store.settleStep !== undefined) {
      expireOutcome = await store.settleStep(run.id, delta, definition, { now });
    } else {
      const pure = applySettlement(run, delta, definition, { now });
      if (!pure.applied) {
        return { run: pure.run };
      }
      const persisted = await store.update(pure.run);
      expireOutcome = { ...pure, run: persisted };
    }
  } catch (err) {
    console.warn(
      `⚠ realm: could not enact run '${run.id}''s expired gate '${gate.gate_id}' (${err instanceof Error ? err.message : String(err)}) — proceeding with the pre-enactment state.`,
    );
    return { run };
  }

  if (!expireOutcome.applied) {
    return { run: expireOutcome.run };
  }

  let finalRun = expireOutcome.run;
  const disclosureParts: string[] = [];
  const disposition =
    finalRun.settled?.[gate.step_name]?.resolved_by === 'timeout' ? 'settle_default' : 'abort';
  disclosureParts.push(
    `gate '${gate.gate_id}' on '${gate.step_name}' had expired — enacted declared ${disposition} before this execute_step call (enacted_via: execute_step).`,
  );

  if (expireOutcome.transitioned) {
    try {
      const drainOutcome = await drainFinalizers(store, definition, registry, run.id);
      finalRun = drainOutcome.run;
      disclosureParts.push(...drainOutcome.warnings);
    } catch (err) {
      disclosureParts.push(
        `post-commit finalizer drain failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const disclosure = disclosureParts.join(' ');
  // Printed unconditionally (never silently dropped, regardless of which downstream envelope
  // path the caller's own request takes) — the caller ALSO threads this into whichever
  // response-envelope warnings array is in scope at its own return point.
  console.warn(`⚠ ${disclosure}`);
  return { run: finalRun, disclosure };
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

  // Step 1.5 (issue #291, D1 "execute_step pre-refusal" enactment point): if this run's gate has
  // expired with an enactable disposition, enact it BEFORE the eligibility check below — a
  // finding-only or non-expired gate is an immediate no-op (same `run` reference back). Level-
  // triggering: the requested step may become newly eligible right here (settle_default/abort
  // both clear `pending_gate`, un-blocking `findEligibleSteps`'s gate-serialization exclusion).
  const gateExpiryCheckNow = options.now ?? new Date();
  let gateExpiryDisclosure: string | undefined;
  if (run.pending_gate !== undefined) {
    const enacted = await enactExpiredGateIfDue(
      store,
      definition,
      run,
      options.registry,
      gateExpiryCheckNow,
    );
    run = enacted.run;
    gateExpiryDisclosure = enacted.disclosure;
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
      warnings: gateExpiryDisclosure !== undefined ? [gateExpiryDisclosure] : [],
      errors: [],
      agent_action: 'resolve_precondition' as const,
      context_hint: `Step '${options.command}' is not eligible in the current run state.`,
      run_phase: run.run_phase,
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
        run_phase: run.run_phase,
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

  // issue #220: bounded validation-rejection exhaustion — locals shared by countRejection below
  // and by both its call sites (Step 2b/2c) and the trace enforce-gate further down. `exhaustion`
  // stays null unless/until a counted rejection's JUST-persisted count reaches its threshold;
  // once armed, EVERY subsequent validation return in this call YIELDS instead of returning.
  let exhaustion: WorkflowError | null = null;
  let counted = false; // at-most-once arm per invocation
  let persisted: number | undefined; // the count actually PERSISTED this invocation, if any
  const countWarnings: string[] = [];

  /**
   * issue #220 (design record §2) — the single chokepoint every counted rejection passes through.
   * Counts ONLY `{VALIDATION_INPUT_SCHEMA, VALIDATION_OUTPUT_SCHEMA}` on `execution: 'agent'`
   * steps (CLOSED set: for agent steps, Step 2b/2c validates `options.input`, which is
   * model-authored by construction — every counted rejection is model-attributable bytes.
   * `VALIDATION_TRACE_SCHEMA` is EXCLUDED v1 — a WAL-merged trace may carry preserved foreign
   * lines (#185/#197), so counting it would poison a step on someone else's bytes; the
   * nonce-refusal class is pre-engine today [structurally thrown in the MCP wrapper before this
   * function ever runs] — re-adjudicate this exclusion if that gate ever moves into core).
   * Read-modify-write from the Step-1 `run` through `store.update()`'s CAS, with the write's
   * return value DISCARDED — the envelope keeps building from the stale Step-1 `run`
   * (bump-and-report; this is the #217 repair-gate contract's own ordering guarantee — see
   * run-agent.ts's cross-ref comment at the repair gate). CAS failure retries ONCE on a fresh
   * `get()` (the extension-identity precedent above), re-checking countability on the FRESH
   * record [P-B1]: an unguarded retry could write onto a terminal/claimed/gate-waiting record,
   * worst case CAS-failing a concurrent VALID submission's settle into a human-judged claim
   * wedge. Any further failure — or a failed countability re-check — drops and swallows
   * (undercount-safe); envelope delivery is unconditional regardless of what this function does.
   */
  async function countRejection(err: WorkflowError): Promise<void> {
    if (counted) return; // at-most-once per invocation
    if (stepDef?.execution !== 'agent') return; // non-agent steps are never counted
    if (err.code !== 'VALIDATION_INPUT_SCHEMA' && err.code !== 'VALIDATION_OUTPUT_SCHEMA') return;
    counted = true;

    const threshold =
      stepDef.validation_exhaustion?.threshold ?? DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD;
    const attempted = (run.validation_rejections?.[options.command] ?? 0) + 1;

    try {
      // FIRST CAS — expected version = the Step-1 read. Return value DISCARDED: the envelope
      // built at the call site keeps using the stale `run`, never this write's result.
      await store.update({
        ...run,
        validation_rejections: {
          ...(run.validation_rejections ?? {}),
          [options.command]: attempted,
        },
      });
      persisted = attempted;
    } catch {
      // CAS loser — retry ONCE on fresh state, WITH a countability re-check on the fresh record.
      try {
        const fresh = await store.get(options.runId);
        if (
          !fresh.terminal_state &&
          fresh.pending_gate === undefined &&
          findEligibleSteps(definition, fresh).includes(options.command)
        ) {
          const freshN = (fresh.validation_rejections?.[options.command] ?? 0) + 1;
          // CAS on fresh.version closes the re-check's own TOCTOU: a claim landing after the
          // re-check above but before this write fails THIS write too (caught below).
          await store.update({
            ...fresh,
            validation_rejections: {
              ...(fresh.validation_rejections ?? {}),
              [options.command]: freshN,
            },
          });
          persisted = freshN;
        } else {
          persisted = undefined; // drop-and-swallow (undercount-safe)
        }
      } catch {
        persisted = undefined; // double-CAS-failure swallow
      }
    }

    // [design record §2, P-S4] fires on the drop path AND the double-failure path alike — nothing
    // was persisted THIS invocation either way.
    if (persisted === undefined) {
      countWarnings.push(`rejection count not persisted — record remains at ${attempted - 1}`);
    }
    // [design record §1, softened per the final gate] a store round-tripping everything but not
    // declaring this field yet is not called broken definitively — "MAY be unavailable", not "is".
    if (!persistsField(store, 'validation_rejections')) {
      countWarnings.push(
        'rejection counting not declared durable on this store — exhaustion terminalization MAY ' +
          'be unavailable',
      );
    }
    // Countdown observable (Temporal-style) — `rejections` is the JUST-PERSISTED count when one
    // exists, else the attempted (unpersisted) value, so a caller always sees SOME number.
    err.details['rejections'] = persisted ?? attempted;
    err.details['threshold'] = threshold;

    if (persisted !== undefined && persisted >= threshold) {
      exhaustion = new WorkflowError(
        `Step '${options.command}' exhausted its validation-rejection budget (${persisted}/${threshold})`,
        {
          code: 'VALIDATION_EXHAUSTED',
          category: 'VALIDATION',
          // observationally inert on this path (Step-5 terminal translation supplies 'stop');
          // kept for error-catalog coherence
          agentAction: 'stop',
          retryable: false,
          details: {
            step_id: options.command,
            rejections: persisted,
            threshold,
            last_error: err.message,
            last_ajv_errors: err.details['errors'],
          },
        },
      );
    }
  }

  // Step 2b: Validate input schema.
  if (stepDef?.input_schema !== undefined) {
    try {
      validateInputSchema(effectiveInput, stepDef.input_schema, options.command);
    } catch (err) {
      await countRejection(err as WorkflowError);
      if (exhaustion === null) {
        return makeErrorEnvelope(
          options,
          run,
          err as WorkflowError,
          definition,
          countWarnings.length > 0 ? countWarnings : undefined,
        );
      }
      // FALL THROUGH — exhaustion armed; Step 2c below is gated on `exhaustion === null` (skipped
      // whole), and every downstream gate yields toward terminalization instead of returning.
    }
  }

  // Step 2c: Validate output schema (agent steps only). issue #220: the WHOLE block is gated on
  // `exhaustion === null` — once armed by Step 2b above, 2c does not run at all (no validation,
  // no catch), matching W5's own conjunct set exactly [P-S1]: a both-schemas step must never
  // double-count or report the wrong last_error.
  // For agent steps dispatch is a pass-through, so options.input IS the agent's
  // submitted output. Validating here (pre-claim) is equivalent to
  // "post-generation, pre-commit" — the standard output guardrail position.
  if (
    exhaustion === null &&
    stepDef?.execution === 'agent' &&
    stepDef.output_schema !== undefined
  ) {
    try {
      validateOutputSchema(effectiveInput, stepDef.output_schema, options.command);
    } catch (err) {
      await countRejection(err as WorkflowError);
      if (exhaustion === null) {
        return makeErrorEnvelope(
          options,
          run,
          err as WorkflowError,
          definition,
          countWarnings.length > 0 ? countWarnings : undefined,
        );
      }
      // FALL THROUGH — exhaustion armed.
    }
  }

  // Step 2d: PRE-claim WAL read — issue #185 Fix 2: this read serves the enforce-gate ONLY.
  // Schema validation stays pre-claim so an invalid trace still doesn't consume a claim. The
  // trace actually CAPTURED into evidence is built from a fresh POST-claim re-read further below
  // (once the claim below freezes appends) — see that block's comment for why: a concurrent
  // append_trace landing in the narrow window between this read and the claim would otherwise
  // never be adopted, then be silently destroyed when the WAL is deleted at settlement (issue
  // #185 Finding 2). A rare line landing in exactly that window bypasses THIS enforce check —
  // documented, accepted (see the post-claim block).
  //
  // issue #220 carve-out: the ABOVE "stays pre-claim so an invalid trace doesn't consume a claim"
  // guarantee is for the COMMON case only — when validation exhaustion is already armed by an
  // earlier Step 2b/2c rejection, the enforce-gate below deliberately YIELDS its return instead
  // (still never deletes/consumes the WAL) so a persistently-invalid-trace agent under `enforce`
  // can be terminalized rather than wedging forever purely on this unrelated gate.
  //
  // walEntries is declared at this outer scope because it is REASSIGNED to the post-claim read
  // below and referenced at the captureEvidence call site further down this function.
  const traceWarnings: string[] = [];
  // issue #291: the Step-1.5 gate-expiry disclosure (if any) now rides every downstream envelope
  // this function's own `traceWarnings` threading already reaches.
  if (gateExpiryDisclosure !== undefined) traceWarnings.push(gateExpiryDisclosure);
  let preNormalizedTrace: NormalizeTraceResult | undefined;
  let walEntries: BufferedEntry[] = [];
  let preClaimSchemaResult:
    | {
        schema_applied: NonNullable<TraceNormalizationSummary['schema_applied']>;
        validation_mode: NonNullable<TraceNormalizationSummary['validation_mode']>;
        validation_errors: NonNullable<TraceNormalizationSummary['validation_errors']>;
      }
    | undefined;

  // issue #197 PR-2 (design §3, the activation gate): computed once — options.traceBufferStore
  // is invariant for this whole call. `carriageActive` also gates whether the NEW
  // adopted_own/adopted_anonymous/preserved_foreign fields are surfaced on the 'ok' envelope
  // (absent entirely on a bare-floor store, never just zeroed) — see the settle-site comment.
  const carriageActive =
    options.traceBufferStore !== undefined && storeDeclaresNonceCarriage(options.traceBufferStore);
  const effectiveClaimantNonce = carriageActive ? options.writerNonce : undefined;
  // Post-claim adoption partition (issue #197 PR-2) — lifted to this outer scope because it is
  // read again at the settle sites (seal-vs-delete decision) and at 'ok' envelope build, both far
  // below the post-claim block that computes it. `undefined` for a non-agent step (never computed
  // there) — the settle sites and envelope build both treat that as "nothing to preserve/report".
  let adoptionPartition: BufferedEntryPartition | undefined;

  if (stepDef?.execution === 'agent') {
    // issue #207 PR-2 (D3 §5): wrapped — a rejection here (e.g. lock contention under a fenced
    // trio's serialized reads) happens BEFORE claimStep, so no claim exists to compensate for;
    // return a typed, retryable envelope instead of letting the read throw uncaught.
    try {
      walEntries =
        options.traceBufferStore !== undefined
          ? await options.traceBufferStore.read(options.runId, options.command)
          : [];
    } catch (err) {
      return makeErrorEnvelope(
        options,
        run,
        new WorkflowError('Failed to read trace buffer before claiming step', {
          code: 'ENGINE_STORE_FAILED',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: true,
          details: {
            step_id: options.command,
            cause: err instanceof Error ? err.message : String(err),
          },
        }),
        definition,
      );
    }

    // issue #197 PR-2 (design §3, missing-leg advisory): a caller-supplied nonce this store
    // cannot carry is IGNORED for adoption purposes (carriageActive is false) — loudly, once per
    // call, so a minting client discovers the silent floor rather than assuming attribution.
    if (options.writerNonce !== undefined && !carriageActive) {
      traceWarnings.push(
        'writer_nonce ignored: the trace-buffer store does not declare writer_nonce_carriage — ' +
          'adoption falls back to the honest floor',
      );
    }

    const hasAnyTrace =
      walEntries.length > 0 || (options.trace !== undefined && options.trace.length > 0);

    if (hasAnyTrace) {
      // issue #197 PR-2 (design §2, ADOPTION_CONGRUENCE): the pre-claim enforce-gate validates
      // ONLY the adopted subset — a foreign-nonce-only WAL must never gate a (nonced) claimant.
      // Congruence with the post-claim partition below is mandatory: both call the SAME
      // `partitionBufferedEntries` helper against the SAME `effectiveClaimantNonce`.
      const prClaimPartition = partitionBufferedEntries(walEntries, effectiveClaimantNonce);
      // issue #185 Fix 1: budget-priority merge (see buildPriorityMergedTrace's own doc) — this
      // pre-claim pass exists only to feed validateTraceSchema below; its RESULT is discarded
      // (not stored into the outer preNormalizedTrace) once the enforce-gate decision is made.
      const preClaimNormalized = buildPriorityMergedTrace(prClaimPartition.adopted, options.trace);

      // Validate trace schema if configured (unchanged call site).
      if (stepDef.trace_schema !== undefined) {
        const mode = stepDef.trace_validation_mode ?? 'warn';
        if (mode === 'enforce') {
          try {
            validateTraceSchema(
              preClaimNormalized.entries,
              stepDef.trace_schema,
              options.command,
              'enforce',
            );
            preClaimSchemaResult = {
              schema_applied: true,
              validation_mode: 'enforce',
              validation_errors: 0,
            };
          } catch (err) {
            // On enforce rejection: do NOT delete the WAL — agent retries with WAL preserved.
            if (exhaustion === null) {
              return makeErrorEnvelope(options, run, err as WorkflowError, definition);
            }
            // issue #220: exhaustion is already armed by an earlier Step 2b/2c rejection — the
            // enforce-gate YIELDS its return (rather than returning) so a persistently-invalid
            // trace under `enforce` can still be terminalized instead of wedging forever on this
            // unrelated gate (the exact class #220 exists to kill). Re-run the WARN-shape pass
            // (never enforce) purely so `preClaimSchemaResult`/the summary still reflect what
            // actually happened to the trace; `validateTraceSchema('warn', ...)` never throws.
            const warnResult = validateTraceSchema(
              preClaimNormalized.entries,
              stepDef.trace_schema,
              options.command,
              'warn',
            );
            preClaimSchemaResult = {
              schema_applied: true,
              validation_mode: 'warn',
              validation_errors: warnResult.errorCount,
            };
            if (warnResult.errorCount > 0) {
              traceWarnings.push(warnResult.warning);
            }
          }
        } else {
          const result = validateTraceSchema(
            preClaimNormalized.entries,
            stepDef.trace_schema,
            options.command,
            'warn',
          );
          preClaimSchemaResult = {
            schema_applied: true,
            validation_mode: 'warn',
            validation_errors: result.errorCount,
          };
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
        // Design record §6: append the drain advisory when the fresh run carries pendings.
        const claimedAdvisory = finalizerDrainAdvisory(freshRun);
        return {
          command: options.command,
          run_id: options.runId,
          run_version: freshRun.version,
          status: 'blocked',
          data: {},
          evidence: [],
          warnings: claimedAdvisory !== undefined ? [claimedAdvisory] : [],
          errors: [],
          agent_action: 'resolve_precondition' as const,
          context_hint: `Step '${options.command}' was already claimed by another process.`,
          run_phase: freshRun.run_phase,
          next_actions: buildNextActions(definition, freshRun),
          blocked_reason: {
            eligible_steps: findEligibleSteps(definition, freshRun),
            suggestion: `Step is already in progress. Wait for it to complete.`,
          },
        };
      }
      // Design record §6: STATE_STEP_NOT_ELIGIBLE (a claim-time eligibility re-check race) also
      // gets the drain advisory when the fresh run carries pendings — a fresh re-read since `run`
      // (Step 1's load) may be stale by the time claimStep's own re-check inside its lock raced.
      if (err.code === 'STATE_STEP_NOT_ELIGIBLE') {
        const freshRun = await store.get(options.runId).catch(() => run);
        const notEligibleAdvisory = finalizerDrainAdvisory(freshRun);
        const extraWarnings =
          notEligibleAdvisory !== undefined
            ? [...traceWarnings, notEligibleAdvisory]
            : traceWarnings.length > 0
              ? traceWarnings
              : undefined;
        return makeErrorEnvelope(options, freshRun, err, definition, extraWarnings);
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

  // issue #185 Fix 2: POST-claim WAL re-read. Appends are frozen once a step is in_progress
  // (claimed above) — so THIS read is complete, unlike the pre-claim read further up, which only
  // served the enforce-gate. Re-running unconditionally (whether or not the pre-claim read found
  // anything) is required: Finding 2's race is exactly a concurrent append_trace landing AFTER
  // the pre-claim read but before/at the claim, meaning the pre-claim read alone could show
  // nothing while a line already exists by the time we reach here. This re-read — and the
  // re-normalized result built from it — is what is actually captured into evidence below; the
  // pre-claim result above is discarded once the enforce-gate decision was made.
  //
  // walEntries is REASSIGNED here (declared pre-claim above) — from this point on it denotes the
  // complete, post-claim set, which is also what the captureEvidence call site further below
  // keys its `stepDef?.execution === 'agent' && walEntries.length > 0` check on.
  if (stepDef?.execution === 'agent') {
    // issue #207 PR-2 (D3 §5): wrapped — a rejection here happens AFTER claimStep, so a claim IS
    // outstanding. COMPENSATING UN-CLAIM: built from `pendingRun` (our own claimStep result,
    // never a fresh get) and CAS'd against `pendingRun.version` — an intervening write (someone
    // else already resolved this claim) makes the CAS fail with STATE_SNAPSHOT_MISMATCH, in
    // which case we stop immediately and leave the claim exactly as it is. Either way (compensated
    // or left in place), the caller always gets the same typed retryable envelope — see
    // buildCompensatingUnclaim's own doc for the full contract.
    try {
      walEntries =
        options.traceBufferStore !== undefined
          ? await options.traceBufferStore.read(options.runId, options.command)
          : [];
    } catch (err) {
      // issue #279 (increment 2, PR-D, Deliverable 1e): the migrated path — settles this release
      // atomically against FRESH state via the store's own settleStep, evidence = the SAME
      // compensating_unclaim audit line (:679 semantics). LOG-ONLY for ALL results (applied / NOOP
      // / any refusal / a thrown infra error) — no envelope change on any settle outcome; the
      // ENGINE_STORE_FAILED envelope below is the disclosure regardless. Dormancy: an undeclaring
      // store falls through to the byte-identical legacy path (I16/#169 fail-closed dormancy).
      let unclaimDormancyWarning: string | undefined;
      if (store.settleStep !== undefined) {
        const unclaimToken = pendingRun.claims?.[options.command]?.token;
        const delta: ReleaseStepDelta = {
          kind: 'release_step',
          step: options.command,
          ...(unclaimToken !== undefined ? { claimToken: unclaimToken } : {}),
          evidence: [buildCompensatingUnclaimEvidence(options.command, new Date())],
        };
        try {
          await store.settleStep(options.runId, delta, definition);
        } catch {
          // Log-only — see the comment above; never surfaces as its own error.
        }
      } else {
        // --- Legacy path (dormancy fallback — byte-identical to pre-#279 behavior) ---
        try {
          await store.update(buildCompensatingUnclaim(pendingRun, options.command, new Date()));
        } catch {
          // CAS mismatch (someone else already resolved the claim) or any other failure to even
          // un-claim: stop immediately, leave the claim exactly as it is — never retry here.
        }
        // issue #279 (increment 2, PR-D): + the ONE dormancy advisory (I16) — this IS the legacy
        // path (store.settleStep undeclared); the ENGINE_STORE_FAILED envelope below is its only
        // carrier since this release is log-only.
        unclaimDormancyWarning = DORMANCY_ADVISORY;
      }
      const unclaimEnvelopeWarnings = mergeWarnings(traceWarnings, unclaimDormancyWarning);
      return makeErrorEnvelope(
        options,
        pendingRun,
        new WorkflowError('Failed to read trace buffer after claiming step', {
          code: 'ENGINE_STORE_FAILED',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: true,
          details: {
            step_id: options.command,
            cause: err instanceof Error ? err.message : String(err),
          },
        }),
        definition,
        unclaimEnvelopeWarnings.length > 0 ? unclaimEnvelopeWarnings : undefined,
      );
    }

    // issue #197 PR-2 (design §2): the SAME predicate as the pre-claim pass, now over the
    // complete post-claim set. Lifted to `adoptionPartition` (outer scope) — read again at the
    // settle sites (seal-vs-delete) and at 'ok' envelope build, both below this block.
    adoptionPartition = partitionBufferedEntries(walEntries, effectiveClaimantNonce);

    // issue #197 PR-2 (design §2, the "keying pin"): this condition stays keyed on the FULL
    // post-claim WAL set, NOT the adopted subset — a foreign-only WAL (adoptionPartition.adopted
    // empty) with no options.trace must still enter this block so foreign_lines_preserved below
    // is captured into trace_summary; otherwise that count is silently lost.
    if (walEntries.length > 0 || (options.trace !== undefined && options.trace.length > 0)) {
      // issue #185 Fix 1: same budget-priority merge as the pre-claim pass, now over the
      // complete post-claim ADOPTED subset only — a foreign line never reaches canonical
      // evidence (issue #197 PR-2, design §2).
      preNormalizedTrace = buildPriorityMergedTrace(adoptionPartition.adopted, options.trace);

      // Carry over the enforce-gate's schema-validation result (computed pre-claim against a
      // possibly-incomplete set) rather than re-validating here — Fix 2 deliberately keeps
      // validation pre-claim (see that block's comment); this just republishes its verdict onto
      // the summary that is actually captured.
      if (preClaimSchemaResult !== undefined) {
        preNormalizedTrace.summary.schema_applied = preClaimSchemaResult.schema_applied;
        preNormalizedTrace.summary.validation_mode = preClaimSchemaResult.validation_mode;
        preNormalizedTrace.summary.validation_errors = preClaimSchemaResult.validation_errors;
      }

      // issue #185 Fix 3 / issue #197 PR-2 (design §2/§6): the three-way honest split.
      // buffered_lines_adopted now counts ONLY the adopted-ANONYMOUS entries (bare-adopted by a
      // ⊥ claimant) — for all-bare traffic this is numerically IDENTICAL to before #197 (every
      // adopted line was, and still is, bare). attributed_lines_adopted counts own-nonce
      // adoptions — NO caveat (design §6 wording, verbatim below). foreign_lines_preserved counts
      // lines from a different writer, preserved (sealed where supported) but never adopted —
      // its accompanying pointer warning is the only way an agent learns to retrieve them.
      if (adoptionPartition.adopted_anonymous > 0) {
        preNormalizedTrace.summary.buffered_lines_adopted = adoptionPartition.adopted_anonymous;
      }
      if (adoptionPartition.adopted_own > 0) {
        preNormalizedTrace.summary.attributed_lines_adopted = adoptionPartition.adopted_own;
      }
      if (adoptionPartition.preserved_foreign > 0) {
        preNormalizedTrace.summary.foreign_lines_preserved = adoptionPartition.preserved_foreign;
        traceWarnings.push(
          `${adoptionPartition.preserved_foreign} buffered line(s) from a different writer were ` +
            'preserved, not adopted — retrieve via `realm run export`',
        );
      }

      // issue #197 PR-2 (design §6, the half-minted advisory): signature heuristics over the RAW
      // walEntries/foreign set (never the adopted subset — these two cases are both about
      // content this claimant did NOT adopt), neutral phrasing, values never echoed. Mutually
      // exclusive by claimant type (nonced vs ⊥), so an if/else-if is exact, not a simplification.
      if (
        effectiveClaimantNonce !== undefined &&
        walEntries.length > 0 &&
        walEntries.every((e) => e._nonce === undefined)
      ) {
        // A nonced claimant found nothing but bare lines — if those are this SAME attempt's own
        // earlier append() calls, the client minted inconsistently (nonce on execute_step but not
        // on the preceding append_trace calls, or vice versa).
        traceWarnings.push(
          `the ${walEntries.length} buffered line(s) were bare and were preserved, not adopted — ` +
            'if they are yours from this same attempt, you minted inconsistently (mint on both ' +
            'calls, or neither)',
        );
      } else if (effectiveClaimantNonce === undefined && adoptionPartition.foreign.length > 0) {
        const distinctForeignNonces = new Set(adoptionPartition.foreign.map((e) => e._nonce));
        if (distinctForeignNonces.size === 1) {
          // A bare claimant found every foreign line under exactly ONE other nonce — if that
          // nonce is this SAME attempt's own (minted on append_trace but the execute_step call
          // stayed bare), the client minted inconsistently.
          traceWarnings.push(
            `${adoptionPartition.foreign.length} line(s) under a different writer_nonce were ` +
              'preserved, not adopted — if these are yours from this same attempt, you minted ' +
              'inconsistently',
          );
        }
      }
    }
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
    // issue #188 field-fidelity gate: advisory only, never blocks — the re-snapshot above
    // already self-healed CURRENT context regardless of what the store persists. This warns
    // that the HISTORY of snapshots won't survive on a store that doesn't declare the field
    // (every future execution will re-enter this branch and re-snapshot from scratch).
    if (!persistsField(store, 'workflow_context_snapshots')) {
      traceWarnings.push(
        "this run store does not persist 'workflow_context_snapshots' — snapshot history is " +
          'not durable on this store (re-snapshotting recovers current context each time, but ' +
          'prior snapshots are lost)',
      );
    }
  }

  // Extension-code drift evidence (issue #119): lazy append-on-change, mirroring the
  // workflow-context lazy write above. When the caller's registry carries a CLI-computed
  // identity entry, append it when the run has no history or the last entry denotes
  // DIFFERENT code; on change also surface an advisory envelope warning. WARN-never-gate:
  // a CAS loser retries once then logs-and-drops (an evidence entry may be lost under
  // contention but never silently; step execution is never affected). No registry
  // identity (extension-free runs) → byte-identical behavior, field never written.
  const registryIdentity = options.registry?.identity;
  if (registryIdentity !== undefined) {
    // issue #188 field-fidelity gate: a SEPARATE, unconditional advisory (independent of
    // whether THIS call's append-on-change detects an actual diff below) — if the store can't
    // persist extension_identity at all, the baseline resets every execution, so drift can
    // NEVER accumulate or be detected on this store, not just "not detected this time". Preserves
    // the #119 WARN-never-gate flow exactly: this only ever pushes a warning, never blocks or
    // alters the append-on-change logic that follows.
    if (!persistsField(store, 'extension_identity')) {
      traceWarnings.push(
        "this run store does not persist 'extension_identity' — drift detection is unavailable " +
          '(the baseline resets every execution, so drift can never accumulate or be detected ' +
          'on this store)',
      );
    }
    const identityHistory = pendingRun.extension_identity ?? [];
    const lastIdentity = identityHistory[identityHistory.length - 1];
    if (lastIdentity === undefined || extensionIdentityDiffers(lastIdentity, registryIdentity)) {
      // A differing RULES string means the entries are not comparable fingerprints (a
      // future sweep-rules change must never manufacture phantom drift): append the new
      // entry WITHOUT the advisory warn. Same-rules changes warn as genuine drift.
      if (lastIdentity !== undefined && lastIdentity.tree.rules === registryIdentity.tree.rules) {
        traceWarnings.push(
          "extension code identity changed since this run's last recorded identity",
        );
      }
      try {
        pendingRun = await store.update({
          ...pendingRun,
          extension_identity: [...identityHistory, registryIdentity],
        });
      } catch {
        // CAS loser: another writer bumped the version between our read and update.
        // Retry ONCE on fresh state (re-checking append-on-change), then log-and-drop.
        try {
          const freshRun = await store.get(options.runId);
          const freshHistory = freshRun.extension_identity ?? [];
          const freshLast = freshHistory[freshHistory.length - 1];
          if (freshLast === undefined || extensionIdentityDiffers(freshLast, registryIdentity)) {
            pendingRun = await store.update({
              ...freshRun,
              extension_identity: [...freshHistory, registryIdentity],
            });
          } else {
            pendingRun = freshRun;
          }
        } catch (retryErr) {
          console.error(
            `extension identity append dropped for run '${options.runId}' after CAS retry: ${
              retryErr instanceof Error ? retryErr.message : String(retryErr)
            }`,
          );
        }
      }
    }
  }

  // Step 4: Dispatch with retry and timeout.
  const retryConfig = stepDef?.retry;
  const maxAttempts = retryConfig?.max_attempts ?? 1;
  // A3: every `execution: 'auto'` step is bounded — authored timeout_seconds if declared, else the
  // generous DEFAULT_EXECUTION_TIMEOUT_SECONDS default. Resolved ONCE here (before the retry loop
  // below), not per-attempt. Agent/guard steps (shouldEnforceTimeout false) are untouched: agent
  // dispatch stays the instant-return no-op it always was, never wrapped in withTimeout — this
  // A3 invariant is preserved verbatim by issue #140 below (the finalizer-drain withTimeout at
  // buildFinalizedSeal is a separate, DRAIN_CEILING-bounded wrap, outside this cap's scope).
  // effectiveTimeoutSeconds is the single source of truth for the step's OWN declared/default
  // per-attempt bound; timeoutMs is derived from it so the two can never diverge.
  //
  // Issue #140 (retryable timeout + total-time cap): capMs/capStart/capExhausted resolve ONCE
  // here too (same as timeoutMs), gated on `enforceTimeout && retryConfig !== undefined` — every
  // retry-configured auto step now gets a default total-time cap (resolveCapMs), whether or not it
  // opts into `retry.on_timeout`. What is NOT resolved once anymore is the PER-ATTEMPT bound
  // actually passed to withTimeout: each attempt clips to whatever budget remains (see
  // `effectiveMs` inside the loop below) — a later attempt's evidence `effective_timeout_seconds`
  // can therefore be SMALLER than this outer `effectiveTimeoutSeconds` once the cap starts biting.
  //
  // Zombie-stacking split (A3 caveat, sharpened by #140's `on_timeout` in-place retry): a timeout
  // frees the RUNNER, not the work — `withTimeout` races the dispatch against a timer and moves on
  // the instant the timer wins, but does not stop a handler/adapter that ignores the abort signal
  // (or a remote server still processing an already-aborted request). Whether an abandoned call
  // can STACK behind a subsequent retry attempt splits on the handler's own shape: a SYNCHRONOUS
  // (blocking) handler can never stack one — it monopolizes the event loop, so nothing else
  // (including the next attempt's own dispatch) can even begin until it returns or the process is
  // killed. An ASYNCHRONOUS handler that ignores its abort signal CAN stack: each timed-out-and-
  // retried attempt leaves its own abandoned promise running, so up to `max_attempts − 1` zombies
  // can accumulate behind the one currently-live attempt (attempts 1..max_attempts−1 each
  // potentially zombie-and-retry; the final attempt is the "+1" that is never itself abandoned by
  // this loop). This was always true pre-#140 for a step whose retry consumed a NORMAL retryable
  // error mid-flight of a slow-but-not-yet-timed-out prior attempt; #140 sharpens it because
  // `on_timeout` now lets a STEP_TIMEOUT itself mint a retry, so a maximally adversarial handler
  // can produce the full max_attempts−1 zombie count from timeouts alone. The zombie count stays
  // cap-BOUNDED (the total-time cap bounds how many attempts the ENGINE'S retry loop can mint —
  // it does not, and cannot, reach into an already-abandoned zombie running on a remote server
  // outside realm's control).
  const enforceTimeout = stepDef !== undefined && shouldEnforceTimeout(stepDef);
  const effectiveTimeoutSeconds = enforceTimeout
    ? (stepDef!.timeout_seconds ?? DEFAULT_EXECUTION_TIMEOUT_SECONDS)
    : undefined;
  const timeoutMs =
    effectiveTimeoutSeconds !== undefined ? effectiveTimeoutSeconds * 1000 : undefined;
  const capMs =
    enforceTimeout && retryConfig !== undefined ? resolveCapMs(retryConfig, timeoutMs!) : undefined;
  const capStart = Date.now(); // wall-clock — the SAME clock the claim horizon is measured against
  let capExhausted = false;
  const remainingMs = () => capMs! - (Date.now() - capStart);

  // Programmatic-gate advisory (#119-preserving): the loader refuses `on_timeout: true` without
  // `idempotent: true` at load (E1) — but a hand-built WorkflowDefinition (a custom embedder, or a
  // test) can bypass the loader entirely. Surface the same rule here, at the engine surface, as a
  // pure advisory (never gates, never changes behavior — the willRetry conjunct below already
  // requires `idempotent === true` independently). Threaded through `traceWarnings` so it reaches
  // every settle path this function has, INCLUDING the handler-abort return path below (which
  // otherwise hardcodes `warnings: []`).
  if (stepDef !== undefined && retryConfig?.on_timeout === true && stepDef.idempotent !== true) {
    traceWarnings.push(
      `retry.on_timeout ignored: step '${options.command}' is not declared idempotent — declare ` +
        `both 'idempotent: true' and 'retry.on_timeout: true'; YAML workflows are refused at load.`,
    );
  }

  // Create a stable rate-limiter registry for all retry attempts of this step.
  // Shared state ensures that a pause() triggered on attempt N is still in effect
  // when the proactive acquire() runs on attempt N+1. When the caller provides an
  // explicit registry, it is used directly (also enables cross-step coordination);
  // otherwise a step-scoped fallback is created so rate limiting still works.
  const rateLimiterRegistry: ExtensionRegistry = options.registry ?? new ExtensionRegistry();

  let output: Record<string, unknown> = {};
  let dispatchError: WorkflowError | null = null;
  // issue #220 PR-2: true iff THIS invocation settles the step via its declared default_output
  // substitution (exhaustion armed above AND the step opted into mode: 'default') — computed once,
  // function-scoped (not inside the `if (bypassDispatch)` block below, which closes long before
  // D5's Step-6 envelope build reads this local) so it survives to every downstream read site.
  const settledByDefault =
    exhaustion !== null && stepDef?.validation_exhaustion?.mode === 'default';
  let attemptsUsed = 0;
  const allEvidence: EvidenceSnapshot[] = [];
  let currentWarn: string | undefined;

  // issue #220: once exhaustion is armed by an earlier Step 2b/2c/enforce-gate rejection, bypass
  // the ENTIRE dispatch loop below AND the retry-wrap block that follows it — claimStep's own
  // under-lock re-check (STATE_STEP_NOT_ELIGIBLE) is the safety net that cleanly aborts
  // terminalization if a concurrent valid submission or abandon beat this invocation to the claim
  // (see the claim's own catch above). Without this bypass, a hand-built max_attempts:0 definition
  // would wrap VALIDATION_EXHAUSTED into STEP_RETRY_EXHAUSTED, destroying the discriminator.
  const bypassDispatch = exhaustion !== null;

  if (!bypassDispatch) {
    for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
      // SITE (a) — issue #140, loop-top, BEFORE attemptsUsed is assigned: attempt 1 ALWAYS
      // proceeds regardless of capMs (the `attemptNum > 1` conjunct) — this guard exists solely for
      // the clock-anomaly window between `capStart` above and here (a suspend/resume or NTP forward
      // jump), never to gate the very first attempt.
      if (capMs !== undefined && attemptNum > 1 && remainingMs() <= 0) {
        capExhausted = true;
        break;
      }
      attemptsUsed = attemptNum;
      const startedAt = new Date();
      let attemptOutput: Record<string, unknown> = {};
      let attemptError: WorkflowError | null = null;
      let resolvedParams: Record<string, unknown> | undefined;

      // Per-attempt effective timeout (issue #140): uniform full-clip to whatever cap budget
      // remains. Clip floor `max(0, remainingMs())` ensures a clock anomaly (see SITE (a) above)
      // never passes a negative ms to withTimeout. capMs undefined ⇒ effectiveMs === timeoutMs,
      // byte-identical to pre-#140 behavior (every non-retry-configured, or unopted-uncapped-by-
      // total_timeout_seconds-being-absent-pre-amendment, auto step). `clippedToMs` records the
      // per-attempt evidence value ONLY when the cap actually reduced the bound below the step's
      // own declared/default timeout — never on an uncapped or not-yet-biting attempt.
      const effectiveMs =
        timeoutMs !== undefined
          ? capMs !== undefined
            ? Math.min(timeoutMs, Math.max(0, remainingMs()))
            : timeoutMs
          : undefined;
      const clippedToMs =
        capMs !== undefined && effectiveMs !== undefined && effectiveMs < timeoutMs!
          ? effectiveMs
          : undefined;

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
          effectiveMs !== undefined
            ? await withTimeout((signal) => makeCall(signal), effectiveMs, options.command)
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

          // issue #279 (increment 1, PR-B): the migrated path — a store declaring settleStep
          // settles this abort atomically against FRESH state (not `pendingRun`, which may be
          // stale relative to a concurrent sibling settle). Dormancy: an undeclaring store falls
          // through to the byte-identical legacy path below (I16/#169 fail-closed dormancy).
          if (store.settleStep !== undefined) {
            const abortClaimToken = pendingRun.claims?.[options.command]?.token;
            const delta: SettleStepDelta = {
              kind: 'settle_step',
              step: options.command,
              outcome: 'abort',
              ...(abortClaimToken !== undefined ? { claimToken: abortClaimToken } : {}),
              evidence: [abortEvidence],
              abort: { stepId: options.command, abortMessage },
            };
            let result: SettlementResult;
            try {
              result = await store.settleStep(options.runId, delta, definition);
            } catch (err) {
              // THROWN infra errors (lock exhaustion, run-not-found, I/O) — the complete-site's
              // existing catch shape, replicated at all three migrated sites.
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
            if (!result.applied) {
              if (result.reason === 'already_settled') {
                return buildAlreadySettledEnvelope(
                  store,
                  definition,
                  options,
                  { ...result, reason: 'already_settled' },
                  traceWarnings,
                );
              }
              return buildSettlementRefusalEnvelope(
                options,
                definition,
                result,
                [abortEvidence],
                traceWarnings,
              );
            }
            // applied: true — abort is UNCONDITIONALLY terminal (transitioned is always true here;
            // isTerminal(fresh) was already refused above inside applySettlement).
            let finalRun = result.run;
            let drainWarnings: string[] = [];
            const reArmWarnings = computeReArmWarnings(
              pendingRun.finalizer_ledger,
              result.run.finalizer_ledger,
            );
            try {
              const drainOutcome = await drainFinalizers(
                store,
                definition,
                options.registry,
                options.runId,
              );
              finalRun = drainOutcome.run;
              drainWarnings = drainOutcome.warnings;
            } catch (err) {
              // A drain failure is NEVER the step's own failure — the abort already committed.
              drainWarnings = [
                `post-commit finalizer drain failed: ${err instanceof Error ? err.message : String(err)}`,
              ];
            }
            return {
              command: options.command,
              run_id: options.runId,
              run_version: finalRun.version,
              status: 'ok',
              data: {},
              evidence: [abortEvidence],
              warnings: mergeWarnings(traceWarnings, ...reArmWarnings, ...drainWarnings),
              errors: [],
              context_hint: `Handler step '${options.command}' aborted the run: ${abortMessage}`,
              run_phase: finalRun.run_phase,
              next_actions: [],
            };
          }

          // --- Legacy path (dormancy fallback — byte-identical to pre-#279 behavior) ---
          const withHandlerSkipped: RunRecord = {
            ...pendingRun,
            in_progress_steps: pendingRun.in_progress_steps.filter((s) => s !== options.command),
            // Delete the claim clock in the SAME mutation that removes the step (issue #101).
            claims: omitClaim(pendingRun.claims, options.command),
            evidence: [...pendingRun.evidence, abortEvidence],
            skipped_steps: [...pendingRun.skipped_steps, options.command],
          };
          // #111: merge is load-bearing — it preserves any cascade details propagateSkips derives
          // for OTHER now-unreachable steps alongside this step's own handler_abort tag.
          const handlerAbortPropagated = propagateSkips(withHandlerSkipped, definition);
          const withAllSkipped: RunRecord = {
            ...withHandlerSkipped,
            skipped_steps: handlerAbortPropagated.skipped,
            skip_details: {
              ...handlerAbortPropagated.details,
              [options.command]: { kind: 'handler_abort' },
            },
          };
          const abortDraft: RunRecord = {
            ...withAllSkipped,
            terminal_state: true,
            // issue #367: the seal fields live in the SAME object literal as the terminal flip.
            sealed_by: { arm: 'handler_abort', step: options.command },
            terminal_reason: `Handler '${options.command}' aborted the run: ${abortMessage}`,
            aborted_at: {
              step_id: options.command,
              abort_message: abortMessage,
            },
          };
          // NEW: a handler-abort now drains the abort/always finalizers before sealing
          // (previously it sealed-and-returned immediately). Single seal write below.
          const abortedRun = await buildFinalizedSeal(
            definition,
            abortDraft,
            'abort',
            options.registry,
          );
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
            // Issue #140: was hardcoded `[]` — now threads traceWarnings (e.g. the programmatic
            // on_timeout/idempotent gate advisory above) so it survives this settle path too.
            // Issue #279 (increment 1, PR-B): + the ONE dormancy advisory (I16) — this IS the
            // legacy path (store.settleStep undeclared).
            warnings: mergeWarnings(traceWarnings, DORMANCY_ADVISORY),
            errors: [],
            context_hint: `Handler step '${options.command}' aborted the run: ${abortMessage}`,
            run_phase: (persistedAbortRun ?? abortedRun).run_phase,
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
      const profileData =
        profile !== undefined ? definition.resolved_profiles?.[profile] : undefined;
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
          // issue #220: success-settle stamp — a free diagnostic proving this step needed N prior
          // rejections before finally succeeding ("succeeded after N rejections"). Only stamped on
          // a SUCCESS settle. `run` here is the Step-1 read, so this reflects rejections accrued
          // in PRIOR invocations only — a rejection in THIS invocation never reaches this call site
          // (countRejection only runs from the Step 2b/2c catch, which always either returns or
          // falls through toward terminalization, never toward dispatch).
          ...(attemptError === null && (run.validation_rejections?.[options.command] ?? 0) > 0
            ? { validation_rejections: run.validation_rejections![options.command] }
            : {}),
          // issue #236: the attempt's structured_output disclosure. External-agent stamp [Rv6 +
          // R2-3]: a step that DECLARED structured_output but arrives with no
          // options.stepMeta.structuredOutput at all was driven by something other than
          // run-agent (e.g. an external agent calling execute_step over MCP directly) — realm
          // cannot know whether strict was honored, so it says so rather than staying silent.
          ...(stepDef?.structured_output !== undefined
            ? {
                structured_output: options.stepMeta?.structuredOutput ?? {
                  requested: true,
                  sent: false,
                  downgrade_reason: 'external_agent',
                },
              }
            : {}),
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
        // issue #140: PER-ATTEMPT value (may be smaller than the outer effectiveTimeoutSeconds once
        // the cap starts clipping) — byte-identical to the pre-#140 outer value whenever capMs is
        // undefined or hasn't bitten yet.
        ...(effectiveMs !== undefined ? { effectiveTimeoutSeconds: effectiveMs / 1000 } : {}),
        ...(clippedToMs !== undefined ? { clippedToMs } : {}),
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
      // SITE (b) — issue #140, post-attempt, AFTER dispatchError is set, BEFORE willRetry: the
      // primary capExhausted setter (site (a) above only catches the loop-top clock-anomaly window;
      // site (c) below re-checks once more right before an actual sleep). Fires on ANY dispatch
      // error once the cap is spent, not just STEP_TIMEOUT — the cap bounds the step's total
      // budget, regardless of which error exhausted it.
      if (capMs !== undefined && remainingMs() <= 0) {
        capExhausted = true;
      }
      const willRetry =
        (retryConfig !== undefined && attemptError.retryable && attemptNum < maxAttempts) ||
        // issue #140 (AMENDED): a STEP_TIMEOUT may ALSO retry in place when the step opted in via
        // `retry.on_timeout: true` AND attested `idempotent: true` (the concurrency-safety gate).
        // ALL SIX conjuncts are required; `capMs !== undefined` enforces opted⇒capped
        // structurally — this disjunct is inert off the enforced auto class even for a hand-built
        // definition bypassing the loader's E1 gate on a non-auto step, since capMs is undefined
        // there (shouldEnforceTimeout false ⇒ enforceTimeout false ⇒ capMs undefined) — see R11 in
        // the design record.
        (attemptError.code === 'STEP_TIMEOUT' &&
          capMs !== undefined &&
          retryConfig?.on_timeout === true &&
          stepDef!.idempotent === true &&
          !capExhausted &&
          attemptNum < maxAttempts);
      if (willRetry) {
        const baseBackoff = computeBackoff(retryConfig!, attemptNum);
        const retryAfterMs =
          attemptError instanceof WorkflowError && attemptError.retry_after !== undefined
            ? attemptError.retry_after * 1000
            : 0;
        const waitMs = Math.max(baseBackoff, retryAfterMs);
        // SITE (c) — issue #140, sleep guard, BEFORE every backoff/retry_after sleep (`>=`: an
        // exact-fit sleep is doomed too — never sleep into a wall). dispatchError already holds the
        // ACTUAL last error (e.g. a 429 with retry_after in its details); the post-loop wrap gate
        // below decides whether/how to wrap it — this site only decides whether to sleep at all.
        if (capMs !== undefined && sleepWouldExceedCap(Date.now() - capStart, waitMs, capMs)) {
          capExhausted = true;
          break;
        }
        await delayMs(waitMs);
      } else {
        break;
      }
    }
  } // end issue #220 `if (!bypassDispatch)` — the dispatch loop

  if (bypassDispatch && settledByDefault) {
    // issue #220 PR-2 (D4): declared fail-open. The step opted into `validation_exhaustion.mode:
    // 'default'` and its schema-rejection budget is exhausted — SETTLE the step SUCCESSFULLY with
    // the declared `default_output` instead of terminalizing. `dispatchError` stays `null` here
    // (deliberately NOT set) so every existing downstream success path runs UNMODIFIED: Step 5
    // (dispatch-failure handling) is skipped, Step 5b's gate fires for `human_confirmed` steps on
    // the default_output preview (pin z falls out of this structurally — D7), and Step 6's
    // complete-settle records the step in `completed_steps`. Step 6 does NOT read the `output`
    // local at all — the step's durable output travels via the EVIDENCE SNAPSHOT's
    // `output_summary` (what `buildEvidenceByStep`/eligibility read for downstream steps) — so
    // this branch does exactly two things and no more: (1) set `output` for the envelope/gate
    // preview; (2) push ONE synthesized SUCCESS evidence snapshot mirroring the dispatch-loop's
    // own success `captureEvidence` call (the same one PR-1's FAILURE snapshot above was modeled
    // on, for the success shape instead).
    const defaultOutput = stepDef!.validation_exhaustion!.default_output as Record<string, unknown>;
    output = defaultOutput;
    const settledAt = new Date();
    const defaultProfile = stepDef?.agent_profile;
    const defaultProfileData =
      defaultProfile !== undefined ? definition.resolved_profiles?.[defaultProfile] : undefined;
    const defaultSnap: EvidenceSnapshot = captureEvidence({
      stepId: options.command,
      startedAt: settledAt,
      completedAt: settledAt,
      input: effectiveInput,
      output: defaultOutput,
      diagnostics: {
        input_token_estimate: inputTokenEstimate,
        precondition_trace: preconditionTrace,
        settled_by_default: true,
        validation_rejections: exhaustion!.details['rejections'] as number,
        // issue #236: same disclosure/external-agent-stamp rule as the real dispatch-loop
        // capture above.
        ...(stepDef?.structured_output !== undefined
          ? {
              structured_output: options.stepMeta?.structuredOutput ?? {
                requested: true,
                sent: false,
                downgrade_reason: 'external_agent',
              },
            }
          : {}),
      },
      ...(defaultProfileData !== undefined
        ? { agentProfile: defaultProfile!, agentProfileHash: defaultProfileData.content_hash }
        : {}),
      ...(options.stepMeta?.toolCalls !== undefined
        ? { toolCalls: options.stepMeta.toolCalls }
        : {}),
      ...(debugOutput !== undefined ? { debugOutput } : {}),
      // Gate trace to agent steps only — drop silently for auto/adapter/handler steps. Mirrors
      // the real dispatch-loop capture's own trace-spread conjunct exactly.
      ...(stepDef?.execution === 'agent' && (options.trace !== undefined || walEntries.length > 0)
        ? preNormalizedTrace !== undefined
          ? { normalizedTrace: preNormalizedTrace }
          : { trace: options.trace ?? [] }
        : {}),
    });
    allEvidence.push(defaultSnap);
    // Human-readable disclosure (record §4 — the fourth default-settle disclosure element the
    // record enumerates) + the store-honesty advisory (§5c nuance 1: `countWarnings` are normally
    // delivered ONLY on counted-rejection RETURN envelopes and DROPPED on the fall-through
    // terminalization path — deliberately re-threaded here, for the default-settle success
    // envelope only, so an undeclared-but-persisting store's advisory is not silently lost).
    traceWarnings.push(
      `Step '${options.command}' settled with its declared default_output after ` +
        `${exhaustion!.details['rejections'] as number} schema rejection(s) ` +
        `(validation_exhaustion.mode: 'default')`,
    );
    traceWarnings.push(...countWarnings);
  } else if (bypassDispatch) {
    // issue #220: terminalize. `dispatchError` is PRE-SET to the minted VALIDATION_EXHAUSTED error
    // HERE, BEFORE the retry-wrap block below — that block's own `!bypassDispatch` guard is what
    // then keeps it from being wrapped: without dispatchError being non-null at this exact point,
    // a hand-built `max_attempts: 0` definition's retry-wrap condition
    // (`attemptsUsed(0) === maxAttempts(0)`) would trivially hold and wrap the terminal code into
    // STEP_RETRY_EXHAUSTED, robbing Step 5 of the discriminator it needs. ONE synthesized evidence
    // snapshot mirrors the real dispatch-loop capture at its own `captureEvidence` call site
    // VERBATIM — including the normalizedTrace/trace spread — so the WAL delete at Step 5 never
    // destroys adopted post-claim lines unrecorded (issue #185 Finding 2 would otherwise be
    // reintroduced inside this feature).
    dispatchError = exhaustion;
    const exhaustedAt = new Date();
    // issue #220 correction (deliverable 1 — snapshot completeness): these two derivation lines
    // replicate the dispatch-loop's own `profile`/`profileData` consts VERBATIM (that block's
    // own locals are out of scope here, but `stepDef`/`definition` — the two inputs they're
    // derived from — are both still in scope at this bypass block).
    const exhaustedProfile = stepDef?.agent_profile;
    const exhaustedProfileData =
      exhaustedProfile !== undefined ? definition.resolved_profiles?.[exhaustedProfile] : undefined;
    const exhaustedSnap: EvidenceSnapshot = captureEvidence({
      stepId: options.command,
      startedAt: exhaustedAt,
      completedAt: exhaustedAt,
      input: effectiveInput,
      output: {},
      error: exhaustion!.message,
      diagnostics: {
        input_token_estimate: inputTokenEstimate,
        precondition_trace: preconditionTrace,
        validation_rejections: exhaustion!.details['rejections'] as number,
        // issue #236: same disclosure/external-agent-stamp rule as the real dispatch-loop
        // capture above.
        ...(stepDef?.structured_output !== undefined
          ? {
              structured_output: options.stepMeta?.structuredOutput ?? {
                requested: true,
                sent: false,
                downgrade_reason: 'external_agent',
              },
            }
          : {}),
      },
      ...(exhaustedProfileData !== undefined
        ? { agentProfile: exhaustedProfile!, agentProfileHash: exhaustedProfileData.content_hash }
        : {}),
      ...(options.stepMeta?.toolCalls !== undefined
        ? { toolCalls: options.stepMeta.toolCalls }
        : {}),
      ...(debugOutput !== undefined ? { debugOutput } : {}),
      // Gate trace to agent steps only — drop silently for auto/adapter/handler steps. Mirrors
      // the real dispatch-loop capture's own trace-spread conjunct exactly (execution-loop.ts's
      // per-attempt captureEvidence call, further above).
      ...(stepDef?.execution === 'agent' && (options.trace !== undefined || walEntries.length > 0)
        ? preNormalizedTrace !== undefined
          ? { normalizedTrace: preNormalizedTrace }
          : { trace: options.trace ?? [] }
        : {}),
    });
    allEvidence.push(exhaustedSnap);
  }

  if (
    !bypassDispatch &&
    dispatchError !== null &&
    retryConfig !== undefined &&
    (attemptsUsed === maxAttempts || capExhausted)
  ) {
    const lastError = dispatchError;
    // issue #140: stamp the discriminator on the LAST evidence snapshot regardless of whether the
    // #134 carve-out below actually wraps dispatchError — the carve-out's recoverable settle path
    // (Step 5) never wraps, so this evidence stamp is the ONLY durable record of *why* the step
    // stopped retrying in that case. `exhausted_by: 'total_timeout'` wins the both-true tie (a
    // step whose LAST attempt both used its final slot and drained the cap is reported as
    // cap-caused — the more actionable of the two labels for an operator).
    const lastSnap = allEvidence[allEvidence.length - 1];
    if (lastSnap !== undefined) {
      lastSnap.exhausted_by = capExhausted ? 'total_timeout' : 'attempts';
    }
    // #134: do NOT wrap a recoverable-incapability error (a max_attempts:1 not-registered failure
    // hits attemptsUsed === maxAttempts). The STEP_RETRY_EXHAUSTED wrap discards the inner code, which
    // would rob Step 5 of the discriminator it needs to settle recoverably. Leave dispatchError as the
    // original not-registered error; all other codes wrap unchanged. This carve-out guards BOTH
    // disjuncts above (attempts-exhaustion and cap-exhaustion alike) — a capped-but-not-registered
    // step never wraps into STEP_RETRY_EXHAUSTED either.
    const isRecoverableIncapability =
      lastError instanceof WorkflowError &&
      (lastError.code === 'ENGINE_HANDLER_NOT_REGISTERED' ||
        lastError.code === 'ENGINE_ADAPTER_NOT_REGISTERED');
    if (!isRecoverableIncapability) {
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
            exhausted_by: capExhausted ? 'total_timeout' : 'attempts',
            ...(lastError.retry_after !== undefined ? { retry_after: lastError.retry_after } : {}),
          },
        },
      );
    }
  }

  // Step 5: Handle dispatch failure — move step to failed_steps.
  if (dispatchError !== null) {
    // #134 recoverable-incapability settle: a NOT-REGISTERED handler/adapter means THIS runner cannot
    // execute the step, but a correctly-provisioned runner can. Terminal-burning it into failed_steps
    // would make it permanently un-reclaimable. Instead settle RECOVERABLY: drop it from in_progress and
    // omit its claim (same mutation), do NOT add it to failed_steps, do NOT seal the run, record a
    // capability_blocks marker for diagnostics, and let it fall back to eligible so a capable runner
    // reclaims it. Genuine ran-and-threw / service-not-found / adapter-runtime failures keep their
    // ENGINE_*_FAILED codes and fall through to the terminal path below unchanged.
    const recoverableCode =
      dispatchError instanceof WorkflowError &&
      (dispatchError.code === 'ENGINE_HANDLER_NOT_REGISTERED' ||
        dispatchError.code === 'ENGINE_ADAPTER_NOT_REGISTERED')
        ? dispatchError.code
        : undefined;
    if (recoverableCode !== undefined) {
      const requirement = requirementForStep(options.command, stepDef!, definition);
      const blockedDraft: RunRecord = {
        ...pendingRun,
        in_progress_steps: pendingRun.in_progress_steps.filter((s) => s !== options.command),
        // Delete the claim clock in the SAME mutation that removes the step (issue #101).
        claims: omitClaim(pendingRun.claims, options.command),
        evidence: [...pendingRun.evidence, ...allEvidence],
        capability_blocks: {
          ...pendingRun.capability_blocks,
          [options.command]: {
            requirement:
              requirement !== undefined
                ? { kind: requirement.kind, name: requirement.name }
                : {
                    kind:
                      recoverableCode === 'ENGINE_HANDLER_NOT_REGISTERED' ? 'handler' : 'adapter',
                    name: 'unknown',
                  },
            code: recoverableCode,
            at: new Date().toISOString(),
          },
        },
      };
      // Non-terminal: recompute the phase so the store-fail fallback below is correct too
      // (on the happy path store.update recomputes it identically via deriveRunPhase).
      const blockedRun: RunRecord = { ...blockedDraft, run_phase: deriveRunPhase(blockedDraft) };

      // issue #279 (increment 2, PR-D, Deliverable 1d): the migrated path — settles this release
      // atomically against FRESH state via the store's own settleStep. This site NEVER calls the
      // shared buildSettlementRefusalEnvelope: regardless of write outcome (applied / NOOP
      // already_released / any OTHER refusal / a thrown infra error), the RETURNED envelope is
      // ALWAYS this SAME capability-block report — only whether the internal capability_blocks
      // marker got durably persisted varies, disclosed via blockStoreWarning. Dormancy: an
      // undeclaring store falls through to the byte-identical legacy path below (I16/#169
      // fail-closed dormancy).
      let persistedBlockedRun: RunRecord | undefined;
      let blockStoreWarning: string | undefined;
      let dormancyWarning: string | undefined;
      if (store.settleStep !== undefined) {
        const releaseClaimToken = pendingRun.claims?.[options.command]?.token;
        const delta: ReleaseStepDelta = {
          kind: 'release_step',
          step: options.command,
          ...(releaseClaimToken !== undefined ? { claimToken: releaseClaimToken } : {}),
          capabilityBlock: {
            requirement:
              requirement !== undefined
                ? { kind: requirement.kind, name: requirement.name }
                : {
                    kind:
                      recoverableCode === 'ENGINE_HANDLER_NOT_REGISTERED' ? 'handler' : 'adapter',
                    name: 'unknown',
                  },
            code: recoverableCode,
          },
          // The current :2490 append — legacy parity; the compensating un-claim's own :679
          // audit-line channel belongs to Deliverable 1e ONLY.
          evidence: allEvidence,
        };
        try {
          const releaseResult = await store.settleStep(options.runId, delta, definition);
          persistedBlockedRun = releaseResult.run;
          // applied / NOOP already_released ⇒ the block envelope exactly as today (NOOP merges
          // silently — no extra warning). ANY OTHER refusal ⇒ the same block envelope + a typed
          // warning (never STATE_CLAIM_LOST framing) — the claim survives for reclaim either way.
          if (!releaseResult.applied && releaseResult.reason !== 'already_released') {
            blockStoreWarning = `capability block not persisted: ${releaseResult.reason}`;
          }
        } catch (storeErr) {
          blockStoreWarning = `Failed to persist capability block: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`;
        }
      } else {
        // --- Legacy path (dormancy fallback — byte-identical to pre-#279 behavior) ---
        try {
          persistedBlockedRun = await store.update(blockedRun);
        } catch (storeErr) {
          blockStoreWarning = `Failed to persist capability block: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`;
        }
        // issue #279 (increment 2, PR-D): + the ONE dormancy advisory (I16) — this IS the legacy
        // path (store.settleStep undeclared).
        dormancyWarning = DORMANCY_ADVISORY;
      }
      // issue #207 PR-2 (D3 §5): NO WAL delete belongs on this capability-block settle path — the
      // prior try/catch here was removed, not just gated. Contract-consistency hygiene, not a
      // functional fix: capability-block is reachable ONLY for `execution: 'auto'` steps
      // (ENGINE_HANDLER_NOT_REGISTERED/ENGINE_ADAPTER_NOT_REGISTERED mint only in the
      // auto-dispatch branches), and a WAL only ever exists for `execution: 'agent'` steps
      // (`append_trace` refuses non-agent steps) — DISJOINT populations; there is no in-repo
      // blocked-path WAL to clean up. A custom embedder whose dispatcher throws NOT_REGISTERED
      // for an agent step would leave WAL residue reaped at purge (an enumerated, accepted
      // residue class — D3 §8 residual 6), never silently destroyed here.

      // Non-terminal 'stop' → 'report_to_user' via the existing mapping: a human must provision the
      // runner (or re-run on a capable one); no further progress is possible on THIS runner.
      const blockedAction = resolvePostDispatchAgentAction(dispatchError, false);
      let blockedNextActions: NextAction[] = [];
      if (blockedAction !== 'stop' && blockStoreWarning === undefined) {
        try {
          blockedNextActions = buildNextActions(definition, persistedBlockedRun ?? blockedRun);
        } catch {
          // buildNextActions can throw for unresolvable template references; fall back to [].
        }
      }
      const reqLabel =
        requirement !== undefined
          ? `${requirement.kind} '${requirement.name}'`
          : recoverableCode === 'ENGINE_HANDLER_NOT_REGISTERED'
            ? 'handler'
            : 'adapter';
      return {
        command: options.command,
        run_id: options.runId,
        run_version: (persistedBlockedRun ?? blockedRun).version,
        status: 'error',
        data: {},
        evidence: allEvidence,
        warnings: mergeWarnings(traceWarnings, blockStoreWarning, dormancyWarning),
        errors: [dispatchError.message],
        agent_action: blockedAction,
        error_code: recoverableCode,
        context_hint: `Step '${options.command}' is blocked: its ${reqLabel} is not registered in this runner. The run is NOT terminated — the step remains eligible, so a runner that provides this ${requirement?.kind ?? 'capability'} can execute it. Provision this runner (or re-run on a capable one), then follow next_actions.`,
        run_phase: (persistedBlockedRun ?? blockedRun).run_phase,
        next_actions: blockedNextActions,
      };
    }

    // issue #279 (increment 1, PR-B): the migrated path — settles this failure atomically against
    // FRESH state via the store's own settleStep. Dormancy: an undeclaring store falls through to
    // the byte-identical legacy path below (I16/#169 fail-closed dormancy).
    if (store.settleStep !== undefined) {
      const failClaimToken = pendingRun.claims?.[options.command]?.token;
      const delta: SettleStepDelta = {
        kind: 'settle_step',
        step: options.command,
        outcome: 'fail',
        ...(failClaimToken !== undefined ? { claimToken: failClaimToken } : {}),
        evidence: allEvidence,
        failureMessage: dispatchError.message,
      };
      let result: SettlementResult;
      try {
        result = await store.settleStep(options.runId, delta, definition);
      } catch (err) {
        // THROWN infra errors — the same catch shape replicated at all three migrated sites.
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
      if (!result.applied) {
        if (result.reason === 'already_settled') {
          return buildAlreadySettledEnvelope(
            store,
            definition,
            options,
            { ...result, reason: 'already_settled' },
            traceWarnings,
          );
        }
        // WAL/sealFenced gates become result.applied (BU-12): claim_lost ⇒ the WAL SURVIVES
        // (reclaim's drain owns it) — no WAL cleanup attempted on ANY refusal.
        return buildSettlementRefusalEnvelope(
          options,
          definition,
          result,
          allEvidence,
          traceWarnings,
        );
      }

      let finalRun = result.run;
      let drainWarnings: string[] = [];
      const reArmWarnings = result.transitioned
        ? computeReArmWarnings(pendingRun.finalizer_ledger, result.run.finalizer_ledger)
        : [];
      if (result.transitioned) {
        try {
          const drainOutcome = await drainFinalizers(
            store,
            definition,
            options.registry,
            options.runId,
          );
          finalRun = drainOutcome.run;
          drainWarnings = drainOutcome.warnings;
        } catch (err) {
          drainWarnings = [
            `post-commit finalizer drain failed: ${err instanceof Error ? err.message : String(err)}`,
          ];
        }
      }

      // WAL cleanup — placement stays post-commit (unchanged), now gated on result.applied
      // (BU-12) rather than a separate persistedRun-defined check (the settle already committed
      // by the time we reach here, so there is no "did the persist succeed" ambiguity to gate on).
      let migratedWalCleanupWarning: string | undefined;
      {
        let performPlainDelete = true;
        if (
          adoptionPartition !== undefined &&
          adoptionPartition.preserved_foreign > 0 &&
          options.traceBufferStore !== undefined &&
          storeDeclaresSeal(options.traceBufferStore)
        ) {
          try {
            const sealResult = await options.traceBufferStore.sealFenced!(
              options.runId,
              options.command,
              buildSettleSealGuard(store, options.runId, options.command),
            );
            if (sealResult.sealed) {
              performPlainDelete = false;
              migratedWalCleanupWarning =
                `${adoptionPartition.preserved_foreign} foreign line(s) preserved (sealed) — ` +
                'retrieve via `realm run export`';
            } else if (sealResult.reason === 'capped') {
              migratedWalCleanupWarning =
                'preservation cap reached — foreign lines destroyed, not preserved';
            } else {
              performPlainDelete = false;
            }
          } catch (err) {
            performPlainDelete = false;
            migratedWalCleanupWarning = `Failed to seal trace buffer after step failure: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        if (performPlainDelete) {
          try {
            await options.traceBufferStore?.delete(options.runId, options.command);
          } catch (walErr) {
            migratedWalCleanupWarning = `Failed to clean up trace buffer after step failure: ${walErr instanceof Error ? walErr.message : String(walErr)}`;
          }
        }
      }

      const migratedEffectiveAction = resolvePostDispatchAgentAction(
        dispatchError,
        finalRun.terminal_state,
      );
      let migratedNextActions: NextAction[] = [];
      if (migratedEffectiveAction !== 'stop') {
        try {
          migratedNextActions = buildNextActions(definition, finalRun);
        } catch {
          // buildNextActions can throw for unresolvable template references; fall back to [].
        }
      }
      const migratedContextHint =
        migratedEffectiveAction === 'stop'
          ? `Step '${options.command}' failed. Run is terminated.`
          : migratedEffectiveAction === 'wait_and_proceed'
            ? `Step '${options.command}' was rate-limited. Wait ${dispatchError.retry_after !== undefined ? `${dispatchError.retry_after} second(s)` : 'a moment'} then follow next_actions — no human intervention required.`
            : migratedEffectiveAction === 'wait_for_human'
              ? `Step '${options.command}' failed due to external service unavailability. Wait for service recovery, then proceed with the steps in next_actions.`
              : `Step '${options.command}' failed. ${result.transitioned ? 'Run is terminated.' : 'Recovery steps are available in next_actions.'}`;

      return {
        command: options.command,
        run_id: options.runId,
        run_version: finalRun.version,
        status: 'error',
        data: {},
        evidence: allEvidence,
        warnings: mergeWarnings(
          traceWarnings,
          migratedWalCleanupWarning,
          ...reArmWarnings,
          ...drainWarnings,
        ),
        errors: [dispatchError.message],
        agent_action: migratedEffectiveAction,
        error_code: dispatchError.code,
        ...(Object.keys(dispatchError.details).length > 0
          ? { error_details: dispatchError.details }
          : {}),
        ...(dispatchError.retry_after !== undefined
          ? { retry_after: dispatchError.retry_after }
          : {}),
        context_hint: migratedContextHint,
        run_phase: finalRun.run_phase,
        next_actions: migratedNextActions,
      };
    }

    // --- Legacy path (dormancy fallback — byte-identical to pre-#279 behavior) ---
    // Pure in-memory derivations — no I/O, no try required.
    const afterFail: RunRecord = {
      ...pendingRun,
      in_progress_steps: pendingRun.in_progress_steps.filter((s) => s !== options.command),
      // Delete the claim clock in the SAME mutation that removes the step (issue #101).
      claims: omitClaim(pendingRun.claims, options.command),
      failed_steps: [...pendingRun.failed_steps, options.command],
    };
    // Propagate skips: mark steps whose trigger_rule can never be satisfied after this failure.
    const failPropagated = propagateSkips(afterFail, definition);
    const withSkippedFail: RunRecord = {
      ...afterFail,
      skipped_steps: failPropagated.skipped,
      skip_details: failPropagated.details,
    };
    // A run is terminal when all steps are settled OR when no step will ever become
    // eligible again (safety net for when-condition edge cases not covered by propagateSkips).
    // Guard steps are not returned by findEligibleSteps, so check them separately.
    const isComplete =
      isWorkflowComplete(withSkippedFail, definition) ||
      (withSkippedFail.in_progress_steps.length === 0 &&
        findEligibleSteps(definition, withSkippedFail).length === 0 &&
        findEligibleGuardSteps(definition, withSkippedFail).length === 0);
    // Hoisted so the #373 message walk below reads the SAME evidence the record will carry —
    // `withSkippedFail` does not yet include this attempt's snapshots.
    const failEvidence = [...pendingRun.evidence, ...allEvidence];
    // issue #373 — twin of settlement.ts's fail seal; both layers must emit byte-identical
    // sentences for identical inputs. Single-failure shape unchanged (this site has never had the
    // `?? 'unknown error'` fallback — `dispatchError.message` is always a string).
    const failCause =
      new Set(withSkippedFail.failed_steps).size > 1
        ? renderFailCause(
            withSkippedFail.failed_steps,
            failureMessagesWithOverlay(failEvidence, options.command, dispatchError.message),
          )
        : `Step '${options.command}' failed: ${dispatchError.message}`;
    // issue #367: seal fields staged FIRST in the SAME object literal, and a stale prior seal
    // never survives either fork. #373's `failCause` (computed above) is untouched — the arm sits
    // BESIDE the rendered sentence, never inside it. Validation exhaustion is deliberately NOT a
    // distinct arm: a VALIDATION_EXHAUSTED failure seals 'step_failure' like any other terminal
    // step failure, and the distinction lives in defaulted_steps/diagnostics.
    const { sealed_by: _priorFailSeal, ...withSkippedFailBase } = withSkippedFail;
    const failDraft: RunRecord = isComplete
      ? {
          ...withSkippedFailBase,
          terminal_state: true,
          sealed_by: { arm: 'step_failure', step: options.command },
          evidence: failEvidence,
          terminal_reason: failCause,
        }
      : {
          ...withSkippedFailBase,
          terminal_state: false,
          evidence: failEvidence,
        };
    // On the terminal transition, drain the fail/always finalizers before the single seal.
    // Non-terminal failures (recovery steps remain) run no finalizers.
    const failedRun: RunRecord = isComplete
      ? await buildFinalizedSeal(definition, failDraft, 'fail', options.registry)
      : failDraft;

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
    // issue #207 PR-2 (D3 §5): gate the WAL cleanup on the preceding store.update having actually
    // SUCCEEDED (persistedRun defined) — a failed persist leaves the step in_progress with its
    // trace already read into an evidence write that never landed anywhere durable; the WAL is
    // the SOLE remaining evidence copy until reclaim recovers the wedge (#186 posture). Reclaim's
    // own drain (reclaim-step.ts) warns with the destroyed entry count when it eventually clears
    // this same buffer.
    //
    // issue #197 PR-2 (deliverable 1f): when this step's post-claim read found foreign (preserved,
    // not adopted) lines AND the store declares `seal`, retire the WAL to a sealed artifact
    // instead of destroying it — `preserved_foreign === 0` (the overwhelming common case, and the
    // ONLY case on a non-seal-declaring store, since carriage requires seal by the ladder) takes
    // the exact same plain `delete()` this always has, below, byte-identical.
    if (persistedRun !== undefined) {
      let performPlainDelete = true;
      if (
        adoptionPartition !== undefined &&
        adoptionPartition.preserved_foreign > 0 &&
        options.traceBufferStore !== undefined &&
        storeDeclaresSeal(options.traceBufferStore)
      ) {
        try {
          const sealResult = await options.traceBufferStore.sealFenced!(
            options.runId,
            options.command,
            buildSettleSealGuard(store, options.runId, options.command),
          );
          if (sealResult.sealed) {
            performPlainDelete = false;
            walCleanupWarning =
              `${adoptionPartition.preserved_foreign} foreign line(s) preserved (sealed) — ` +
              'retrieve via `realm run export`';
          } else if (sealResult.reason === 'capped') {
            // Fall back to the SAME plain delete below (loud + bounded, never a silent eviction
            // of an already-sealed artifact to make room) — the destroyed-count warning names
            // exactly what happened; performPlainDelete stays true.
            walCleanupWarning = 'preservation cap reached — foreign lines destroyed, not preserved';
          } else {
            // 'absent' — the live WAL vanished between the post-claim read and this seal attempt
            // (e.g. a concurrent purge/reclaim) — nothing left to delete either; residue-not-loss.
            performPlainDelete = false;
          }
        } catch (err) {
          // A THROW (lock contention, genuine I/O failure) ⇒ warn + SKIP the delete
          // (residue-not-loss; the fence refuses further appends; purge reaps).
          performPlainDelete = false;
          walCleanupWarning = `Failed to seal trace buffer after step failure: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (performPlainDelete) {
        try {
          // Delete WAL after run state is written for failure — entries are now in evidence.
          await options.traceBufferStore?.delete(options.runId, options.command);
        } catch (walErr) {
          walCleanupWarning = `Failed to clean up trace buffer after step failure: ${walErr instanceof Error ? walErr.message : String(walErr)}`;
        }
      }
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
      // Issue #279 (increment 1, PR-B): + the ONE dormancy advisory (I16) — this IS the legacy
      // path (store.settleStep undeclared).
      warnings: mergeWarnings(
        traceWarnings,
        storeCleanupWarning ?? walCleanupWarning,
        DORMANCY_ADVISORY,
      ),
      errors: [dispatchError.message],
      agent_action: effectiveAction,
      // issue #140 (D3 §2, discriminator OBSERVABLE): additive-optional — lets a caller
      // discriminate `STEP_RETRY_EXHAUSTED`'s `exhausted_by` (or any other terminal code) without
      // parsing `errors[0]`'s message text. Mirrors the errorEnvelope()/buildPreExecutionErrorEnvelope
      // pattern used elsewhere in this file.
      error_code: dispatchError.code,
      ...(Object.keys(dispatchError.details).length > 0
        ? { error_details: dispatchError.details }
        : {}),
      ...(dispatchError.retry_after !== undefined
        ? { retry_after: dispatchError.retry_after }
        : {}),
      context_hint: contextHint,
      run_phase: (persistedRun ?? failedRun).run_phase,
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
      // issue #220 §4c (PR-3, D4): widened to admit a `$`-leading reference (e.g.
      // `{{ $settlement.step.field }}`) so a typo'd $settlement path in a gate message is
      // DETECTED as an unresolved placeholder here, not silently left unmatched by this regex
      // (renderTemplate itself already leaves an unresolved ref's placeholder text verbatim in
      // `raw` — this is purely a detection-side widening, no change to render behavior).
      const unresolved = [...raw.matchAll(/\{\{\s*([\w.$-]+)\s*\}\}/g)].map((m) => m[1]);
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
    const openedAt = new Date();

    // issue #291 (mint-time freeze, [F2]): the gate's OWN enforce/notify clock fields, frozen
    // into the record HERE — never re-read from the definition by any later enactment/
    // notification/read-side surface (the definition-drift-livelock cure). `expires_at` derives
    // from THIS `openedAt` instant, never a second `new Date()` call. `reminder_max` defaults to
    // 3 at mint when `reminder_seconds` is declared and the author gave no explicit value — so
    // every later reader can treat the frozen field as authoritative without re-applying a
    // default itself.
    const expiresAt =
      gateConfig?.timeout_seconds !== undefined
        ? new Date(openedAt.getTime() + gateConfig.timeout_seconds * 1000).toISOString()
        : undefined;

    // The PendingGate object is built EXACTLY as before, regardless of which path commits it below
    // (issue #279, increment 2, PR-D, Deliverable 1a — the migrated `open_gate` delta carries this
    // SAME object verbatim; the legacy fallback writes it via `store.update` unchanged).
    const pendingGate: PendingGate = {
      gate_id,
      step_name,
      preview: output,
      choices,
      opened_at: openedAt.toISOString(),
      ...(gateConfig?.owner !== undefined ? { owner: gateConfig.owner } : {}),
      ...(resolvedGateMessage !== undefined ? { resolved_message: resolvedGateMessage } : {}),
      ...(gateConfig?.resolution_messages !== undefined
        ? { resolution_messages: gateConfig.resolution_messages }
        : {}),
      // issue #291: the mint-frozen enforce clock.
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      ...(gateConfig?.on_expiry !== undefined ? { on_expiry: gateConfig.on_expiry } : {}),
      ...(gateConfig?.default_choice !== undefined
        ? { default_choice: gateConfig.default_choice }
        : {}),
      // issue #291: the mint-frozen notify clock (standalone-legal — independent of expiresAt).
      ...(gateConfig?.reminder_seconds !== undefined
        ? {
            reminder_seconds: gateConfig.reminder_seconds,
            reminder_max: gateConfig.reminder_max ?? 3,
          }
        : {}),
    };

    // issue #291 ([F-A2-6]): computed ONCE for the whole gate-open envelope (migrated + legacy
    // both read it) — the absolute first-due notify-clock timestamp, when reminder_seconds was
    // declared.
    const gateOpenDueState = computeGateDueState(pendingGate, openedAt);

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

    function buildGateNextAction(id: string, gateChoices: string[], forStep: string): NextAction {
      return {
        instruction: {
          tool: 'submit_human_response',
          params: { run_id: options.runId, gate_id: id },
          call_with: {
            run_id: options.runId,
            gate_id: id,
            choice: `<${gateChoices.join('|')}>`,
          },
        },
        human_readable: `Human review required for step '${forStep}'. Present gate.display to the user, wait for their choice from gate.response_spec.choices, then call submit_human_response.`,
        orientation: `Run is paused at gate '${id}'. Available choices: ${gateChoices.join(', ')}.`,
      };
    }

    // issue #279 (increment 2, PR-D, Deliverable 1a): the migrated path — opens this gate
    // atomically against FRESH state via the store's own settleStep. Dormancy: an undeclaring
    // store falls through to the byte-identical legacy path below (I16/#169 fail-closed dormancy).
    if (store.settleStep !== undefined) {
      const openClaimToken = pendingRun.claims?.[options.command]?.token;
      const delta: OpenGateDelta = {
        kind: 'open_gate',
        step: options.command,
        ...(openClaimToken !== undefined ? { claimToken: openClaimToken } : {}),
        pendingGate,
        evidence: allEvidence,
      };
      let result: SettlementResult;
      try {
        result = await store.settleStep(options.runId, delta, definition);
      } catch (err) {
        // THROWN infra errors — the same catch shape replicated at every migrated site.
        if (err instanceof WorkflowError) {
          return makeErrorEnvelope(
            options,
            pendingRun,
            err,
            definition,
            traceWarnings.length > 0 ? traceWarnings : undefined,
          );
        }
        const internal = new WorkflowError('Failed to open gate', {
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

      if (!result.applied) {
        if (result.reason === 'already_settled') {
          // Ok-shaped NOOP — buildAlreadySettledEnvelope's SHAPE but WITHOUT its drain clause:
          // gate-open NEVER drains (design record §6 row 1 — the crashed-drain recovery paths are
          // the resolution site's own NOOP drain and the drain verb).
          const noopRun = result.run;
          const noopNextActions = noopRun.terminal_state
            ? []
            : buildNextActions(definition, noopRun);
          return {
            command: options.command,
            run_id: options.runId,
            run_version: noopRun.version,
            status: 'ok',
            data: {},
            evidence: [],
            warnings: [...traceWarnings],
            errors: [],
            context_hint: `Step '${options.command}' was already settled (a duplicate/retried attempt) — no action was taken.`,
            run_phase: noopRun.run_phase,
            next_actions: noopNextActions,
          };
        }
        if (result.reason === 'already_open') {
          // D-1: the LIVE gate wins — rendered VERBATIM (this delta's own rebuilt gate is
          // discarded). Calm, confirm_required (the gate genuinely IS still open) — never
          // report_to_user (no `agent_action` set, matching the fresh-open confirm_required shape).
          const liveGate = result.gate!;
          const liveGateDueState = computeGateDueState(liveGate, new Date());
          return {
            command: options.command,
            run_id: options.runId,
            run_version: result.run.version,
            status: 'confirm_required',
            data: liveGate.preview,
            evidence: [],
            warnings: [...traceWarnings],
            errors: [],
            context_hint: `Run is already paused at gate '${liveGate.gate_id}'. Available choices: ${liveGate.choices.join(', ')}.`,
            run_phase: result.run.run_phase,
            next_actions: [
              buildGateNextAction(liveGate.gate_id, liveGate.choices, liveGate.step_name),
            ],
            gate: {
              gate_id: liveGate.gate_id,
              step_name: liveGate.step_name,
              preview: liveGate.preview,
              choices: liveGate.choices,
              ...(liveGate.resolved_message !== undefined
                ? { display: liveGate.resolved_message }
                : {}),
              response_spec: { choices: liveGate.choices },
              ...(liveGate.expires_at !== undefined ? { expires_at: liveGate.expires_at } : {}),
              ...(liveGateDueState.next_reminder_due_at !== undefined
                ? { first_reminder_due_at: liveGateDueState.next_reminder_due_at }
                : {}),
            },
          };
        }
        return buildSettlementRefusalEnvelope(
          options,
          definition,
          result,
          allEvidence,
          traceWarnings,
          'open_gate',
        );
      }

      // applied: true — never terminalizes (design record §4.1); build confirm_required off
      // result.run.
      const gateRun = result.run;
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
        run_phase: gateRun.run_phase,
        next_actions: [buildGateNextAction(gate_id, choices, step_name)],
        gate: {
          gate_id,
          step_name,
          preview: output,
          choices,
          ...(resolvedGateDisplay !== undefined ? { display: resolvedGateDisplay } : {}),
          ...(resolvedGateInstructions !== undefined
            ? { agent_hint: resolvedGateInstructions }
            : {}),
          response_spec: { choices },
          ...(pendingGate.expires_at !== undefined ? { expires_at: pendingGate.expires_at } : {}),
          ...(gateOpenDueState.next_reminder_due_at !== undefined
            ? { first_reminder_due_at: gateOpenDueState.next_reminder_due_at }
            : {}),
        },
      };
    }

    // --- Legacy path (dormancy fallback — byte-identical to pre-#279 behavior) ---
    let gateRun: RunRecord;
    try {
      gateRun = await store.update({
        ...pendingRun,
        // Step stays in in_progress_steps while gate is open — moved to completed on submit.
        evidence: [...pendingRun.evidence, ...allEvidence],
        pending_gate: pendingGate,
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

    return {
      command: options.command,
      run_id: options.runId,
      run_version: gateRun.version,
      status: 'confirm_required',
      data: output,
      evidence: allEvidence,
      warnings: mergeWarnings(traceWarnings, DORMANCY_ADVISORY),
      errors: [],
      context_hint: `Run is paused at gate '${gate_id}'. Available choices: ${choices.join(', ')}.`,
      run_phase: gateRun.run_phase,
      next_actions: [buildGateNextAction(gate_id, choices, step_name)],
      gate: {
        gate_id,
        step_name,
        preview: output,
        choices,
        ...(resolvedGateDisplay !== undefined ? { display: resolvedGateDisplay } : {}),
        ...(resolvedGateInstructions !== undefined ? { agent_hint: resolvedGateInstructions } : {}),
        response_spec: { choices },
        ...(pendingGate.expires_at !== undefined ? { expires_at: pendingGate.expires_at } : {}),
        ...(gateOpenDueState.next_reminder_due_at !== undefined
          ? { first_reminder_due_at: gateOpenDueState.next_reminder_due_at }
          : {}),
      },
    };
  }

  // Step 6: Move step from in_progress to completed, compute terminal state.
  // issue #279 (increment 1, PR-B): the migrated path — settles this completion atomically
  // against FRESH state via the store's own settleStep. Dormancy: an undeclaring store falls
  // through to the byte-identical legacy path below (I16/#169 fail-closed dormancy).
  if (store.settleStep !== undefined) {
    const completeClaimToken = pendingRun.claims?.[options.command]?.token;
    const delta: SettleStepDelta = {
      kind: 'settle_step',
      step: options.command,
      outcome: 'complete',
      ...(completeClaimToken !== undefined ? { claimToken: completeClaimToken } : {}),
      evidence: allEvidence,
    };
    let result: SettlementResult;
    try {
      result = await store.settleStep(options.runId, delta, definition);
    } catch (err) {
      // THROWN infra errors — the same catch shape replicated at all three migrated sites.
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
    if (!result.applied) {
      if (result.reason === 'already_settled') {
        return buildAlreadySettledEnvelope(
          store,
          definition,
          options,
          { ...result, reason: 'already_settled' },
          traceWarnings,
        );
      }
      // WAL/sealFenced gates become result.applied (BU-12): claim_lost ⇒ the WAL SURVIVES.
      return buildSettlementRefusalEnvelope(
        options,
        definition,
        result,
        allEvidence,
        traceWarnings,
      );
    }

    let finalRun = result.run;
    let drainWarnings: string[] = [];
    const reArmWarnings = result.transitioned
      ? computeReArmWarnings(pendingRun.finalizer_ledger, result.run.finalizer_ledger)
      : [];
    if (result.transitioned) {
      try {
        const drainOutcome = await drainFinalizers(
          store,
          definition,
          options.registry,
          options.runId,
        );
        finalRun = drainOutcome.run;
        drainWarnings = drainOutcome.warnings;
      } catch (err) {
        drainWarnings = [
          `post-commit finalizer drain failed: ${err instanceof Error ? err.message : String(err)}`,
        ];
      }
    }

    // WAL cleanup — placement stays post-commit (unchanged), gated on result.applied (BU-12).
    let migratedSuccessWalCleanupWarning: string | undefined;
    {
      let performPlainDelete = true;
      if (
        adoptionPartition !== undefined &&
        adoptionPartition.preserved_foreign > 0 &&
        options.traceBufferStore !== undefined &&
        storeDeclaresSeal(options.traceBufferStore)
      ) {
        try {
          const sealResult = await options.traceBufferStore.sealFenced!(
            options.runId,
            options.command,
            buildSettleSealGuard(store, options.runId, options.command),
          );
          if (sealResult.sealed) {
            performPlainDelete = false;
            migratedSuccessWalCleanupWarning =
              `${adoptionPartition.preserved_foreign} foreign line(s) preserved (sealed) — ` +
              'retrieve via `realm run export`';
          } else if (sealResult.reason === 'capped') {
            migratedSuccessWalCleanupWarning =
              'preservation cap reached — foreign lines destroyed, not preserved';
          } else {
            performPlainDelete = false;
          }
        } catch (err) {
          performPlainDelete = false;
          migratedSuccessWalCleanupWarning = `Failed to seal trace buffer after step completion: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (performPlainDelete) {
        try {
          await options.traceBufferStore?.delete(options.runId, options.command);
        } catch (err) {
          migratedSuccessWalCleanupWarning = `Failed to clean up trace buffer after step completion: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    const migratedDefaultedStepsDurabilityWarning =
      finalRun.defaulted_steps !== undefined &&
      finalRun.defaulted_steps.length > 0 &&
      !persistsField(store, 'defaulted_steps')
        ? 'run-level defaultedness marker (defaulted_steps) not durable on this store'
        : undefined;

    const migratedNextActions = finalRun.terminal_state
      ? []
      : buildNextActions(definition, finalRun);
    const migratedOrientation = finalRun.terminal_state
      ? `Run completed (phase: '${finalRun.run_phase}'). Call get_run_state with run_id '${options.runId}' to retrieve the full evidence record.`
      : migratedNextActions.length > 0
        ? `Step '${options.command}' completed. ${migratedNextActions.length} step(s) now available.`
        : `Step '${options.command}' completed. Waiting for other steps to complete.`;

    return {
      command: options.command,
      run_id: options.runId,
      run_version: finalRun.version,
      status: 'ok',
      data: output,
      evidence: allEvidence,
      warnings: mergeWarnings(
        traceWarnings,
        currentWarn,
        migratedSuccessWalCleanupWarning,
        migratedDefaultedStepsDurabilityWarning,
        ...reArmWarnings,
        ...drainWarnings,
      ),
      errors: [],
      context_hint: migratedOrientation,
      run_phase: finalRun.run_phase,
      next_actions: migratedNextActions,
      ...(carriageActive && adoptionPartition !== undefined
        ? {
            adopted_own: adoptionPartition.adopted_own,
            adopted_anonymous: adoptionPartition.adopted_anonymous,
            preserved_foreign: adoptionPartition.preserved_foreign,
          }
        : {}),
      ...(settledByDefault ? { settled_by_default: true } : {}),
      ...(finalRun.defaulted_steps?.length ? { defaulted_steps: finalRun.defaulted_steps } : {}),
    };
  }

  // --- Legacy path (dormancy fallback — byte-identical to pre-#279 behavior) ---
  const afterComplete: RunRecord = {
    ...pendingRun,
    in_progress_steps: pendingRun.in_progress_steps.filter((s) => s !== options.command),
    // Delete the claim clock in the SAME mutation that removes the step (issue #101).
    claims: omitClaim(pendingRun.claims, options.command),
    completed_steps: [...pendingRun.completed_steps, options.command],
    evidence: [...pendingRun.evidence, ...allEvidence],
  };
  // Propagate skips: completing this step may make some downstream steps permanently ineligible
  // (e.g. all_failed steps whose dep just succeeded, one_failed steps whose last unfailed dep just completed).
  const completePropagated = propagateSkips(afterComplete, definition);
  const withSkippedComplete: RunRecord = {
    ...afterComplete,
    skipped_steps: completePropagated.skipped,
    skip_details: completePropagated.details,
  };
  // A run is terminal when all steps are settled OR when no step will ever become
  // eligible again (safety net for when-condition routing not fully covered by propagateSkips).
  // Guard steps are not returned by findEligibleSteps, so check them separately.
  const isComplete =
    isWorkflowComplete(withSkippedComplete, definition) ||
    (withSkippedComplete.in_progress_steps.length === 0 &&
      findEligibleSteps(definition, withSkippedComplete).length === 0 &&
      findEligibleGuardSteps(definition, withSkippedComplete).length === 0);
  // issue #367: seal fields staged first in the SAME object literal; stale prior seal stripped.
  const { sealed_by: _priorCompleteSeal, ...withSkippedCompleteBase } = withSkippedComplete;
  const completeDraft: RunRecord = isComplete
    ? {
        ...withSkippedCompleteBase,
        terminal_state: true,
        sealed_by: { arm: 'complete', step: options.command },
        terminal_reason: `Workflow completed.`,
      }
    : { ...withSkippedCompleteBase, terminal_state: false };
  // On the terminal transition, drain the complete/always finalizers before the single seal.
  // issue #220 PR-2 (D6): stamp defaulted_steps onto the SEALED terminal record only — the
  // non-terminal branch (`completeDraft`) is never stamped (FM-5 guard: it must never leak onto a
  // record a later FAIL seal inherits).
  const finalRun: RunRecord = isComplete
    ? stampDefaultedSteps(
        await buildFinalizedSeal(definition, completeDraft, 'complete', options.registry),
      )
    : completeDraft;
  // issue #220 PR-2 (D6 write-site consumer): when the stamped seal record's defaulted_steps is
  // non-empty but this store doesn't declare it durable, disclose the gap explicitly rather than
  // silently losing the run-level marker on round-trip.
  const defaultedStepsDurabilityWarning =
    finalRun.defaulted_steps !== undefined &&
    finalRun.defaulted_steps.length > 0 &&
    !persistsField(store, 'defaulted_steps')
      ? 'run-level defaultedness marker (defaulted_steps) not durable on this store'
      : undefined;

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

  // Delete WAL after successful run update — entries are now in evidence. issue #207 PR-2 (D3
  // §5, clause (a) of the unified deletion contract): wrapped in try/catch-to-warning — the
  // settlement already committed and is durably visible, so a cleanup failure here (e.g. lock
  // contention) must degrade to a warning, never surface as though the STEP itself failed (this
  // was previously unwrapped and would have thrown straight out of executeStep).
  //
  // issue #197 PR-2 (deliverable 1f): same seal-vs-delete decision as the failure-settle site
  // above — see its comment for the full outcome table. preserved_foreign === 0 (the common case,
  // and the ONLY case on a non-seal-declaring store) takes the exact same plain delete() this
  // always has, byte-identical.
  let successWalCleanupWarning: string | undefined;
  {
    let performPlainDelete = true;
    if (
      adoptionPartition !== undefined &&
      adoptionPartition.preserved_foreign > 0 &&
      options.traceBufferStore !== undefined &&
      storeDeclaresSeal(options.traceBufferStore)
    ) {
      try {
        const sealResult = await options.traceBufferStore.sealFenced!(
          options.runId,
          options.command,
          buildSettleSealGuard(store, options.runId, options.command),
        );
        if (sealResult.sealed) {
          performPlainDelete = false;
          successWalCleanupWarning =
            `${adoptionPartition.preserved_foreign} foreign line(s) preserved (sealed) — ` +
            'retrieve via `realm run export`';
        } else if (sealResult.reason === 'capped') {
          successWalCleanupWarning =
            'preservation cap reached — foreign lines destroyed, not preserved';
        } else {
          // 'absent' — residue-not-loss; nothing left to delete either.
          performPlainDelete = false;
        }
      } catch (err) {
        performPlainDelete = false;
        successWalCleanupWarning = `Failed to seal trace buffer after step completion: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (performPlainDelete) {
      try {
        await options.traceBufferStore?.delete(options.runId, options.command);
      } catch (err) {
        successWalCleanupWarning = `Failed to clean up trace buffer after step completion: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
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
    // Issue #279 (increment 1, PR-B): + the ONE dormancy advisory (I16) — this IS the legacy
    // path (store.settleStep undeclared).
    warnings: mergeWarnings(
      traceWarnings,
      currentWarn,
      successWalCleanupWarning,
      defaultedStepsDurabilityWarning,
      DORMANCY_ADVISORY,
    ),
    errors: [],
    context_hint: orientation,
    run_phase: savedRun.run_phase,
    next_actions: nextActions,
    // issue #197 PR-2 (deliverable 2e): additive per-partition counts, SET BY THE ENGINE (never
    // the MCP tool layer, which strips data/evidence and never sees per-line nonces). Gated on
    // `carriageActive` (store CAPABILITY), not on whether a nonce happened to be provided this
    // call — "absent for bare-floor stores" means incapable, not merely unused-this-time.
    ...(carriageActive && adoptionPartition !== undefined
      ? {
          adopted_own: adoptionPartition.adopted_own,
          adopted_anonymous: adoptionPartition.adopted_anonymous,
          preserved_foreign: adoptionPartition.preserved_foreign,
        }
      : {}),
    // issue #220 PR-2 (D5/D6): settled_by_default set true on EXACTLY this success envelope, when
    // THIS invocation settled via the declared default_output substitution. defaulted_steps read
    // off `finalRun` — the STAMPED PRE-PERSIST seal record — never off the round-tripped
    // `savedRun`, since a non-persisting store would silently drop the field from that round-trip
    // and the qualifier must state the run's TRUE defaultedness.
    ...(settledByDefault ? { settled_by_default: true } : {}),
    ...(finalRun.defaulted_steps?.length ? { defaulted_steps: finalRun.defaulted_steps } : {}),
  };
}

/**
 * Submits a human response for a gate-waiting run.
 * Validates the gate_id and choice, then moves the step to completed_steps.
 */
/** Finds the settled step name for a resolved gate matching `gateId` (issue #279, increment 2,
 *  PR-D) — a LOCAL mirror of settlement.ts's own `findSettledGateEntry` (not imported: this file
 *  touches settlement.ts ONLY for Deliverable 3's cancel-trail `gate_id` addition). Used to recover
 *  a reliable step name off `result.run.settled` for the `already_settled`/`gate_choice_conflict`
 *  envelopes, since the caller's own pre-read may already be stale by the time either of those
 *  fires (the gate could have resolved before this call's own Step-1 read). */
function findGateStepName(run: RunRecord, gateId: string): string | undefined {
  for (const [step, entry] of Object.entries(run.settled ?? {})) {
    if (entry.outcome === 'gate' && entry.token === gateId) return step;
  }
  return undefined;
}

/** Builds the gate_response evidence snapshot (issue #279, increment 2, PR-D, Deliverable 1b) —
 *  the SAME shape submitHumanResponse's legacy path has always built (mirrors execution-loop.ts's
 *  own pre-PR-D Step 5), extracted so both the migrated and legacy paths construct it identically.
 *  `respondedBy`, when supplied, populates the snapshot's own `responded_by` field (design record
 *  D-5) in addition to the delta's own field. */
function buildGateResponseSnapshot(
  gate: PendingGate,
  choice: string,
  respondedAt: Date,
  respondedBy: string | undefined,
): EvidenceSnapshot {
  const gateEvidence = captureEvidence({
    stepId: gate.step_name,
    startedAt: new Date(gate.opened_at),
    completedAt: respondedAt,
    input: { choice },
    output: { ...gate.preview, choice },
  });
  return {
    ...gateEvidence,
    kind: 'gate_response' as const,
    ...(gate.resolved_message !== undefined ? { gate_message: gate.resolved_message } : {}),
    ...(respondedBy !== undefined ? { responded_by: respondedBy } : {}),
  };
}

/** Renders a millisecond duration as a compact human-readable string ("3m", "2h 15m", "1d 4h") —
 *  issue #291 [F8] overdue-delta disclosure. Local to this file (core has no CLI dependency);
 *  mirrors the CLI's own `formatGateAge` shape but is independently maintained — no cross-package
 *  import for a two-branch formatter. */
function formatOverdueDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
  return `${totalDays}d ${totalHours % 24}h`;
}

/**
 * issue #291 ([F3] shape c / [F8] / [F12]): composes the honest envelope for a late gate response
 * that lost the race to the enforce clock — called AFTER an `expire_gate` settleStep attempt,
 * regardless of whether THIS call enacted it (`applied: true`) or a racing enactment point already
 * had (`applied: false, reason: 'already_settled'` — F1's arms make both paths land on the SAME
 * committed disposition, read from `finalRun`). `finalRun` must be the state that actually reflects
 * the enactment (either `expireResult.run` directly). Drains post-commit finalizers when the
 * enactment itself transitioned the run (F7 — submit's existing transitioned-drain plumbing,
 * extended to the expire result); a store lacking `settleStep`'s companion `drainFinalizers`
 * capability is not a concern here — `drainFinalizers` works off any `RunStore`.
 */
async function composeExpiredGateEnvelope(
  store: RunStore,
  definition: WorkflowDefinition,
  registry: ExtensionRegistry | undefined,
  originalGateId: string,
  originalChoice: string,
  overdueMs: number,
  expireResult: SettlementResult,
): Promise<ResponseEnvelope> {
  let finalRun = expireResult.run;
  let drainWarnings: string[] = [];
  if (expireResult.applied && expireResult.transitioned) {
    try {
      const drainOutcome = await drainFinalizers(store, definition, registry, finalRun.id);
      finalRun = drainOutcome.run;
      drainWarnings = drainOutcome.warnings;
    } catch (err) {
      drainWarnings = [
        `post-commit finalizer drain failed: ${err instanceof Error ? err.message : String(err)}`,
      ];
    }
  }
  const overdueLabel = formatOverdueDuration(Math.max(0, overdueMs));

  // settle_default disposition: a 'gate' settled entry bearing this gateId, resolved_by:'timeout'.
  const settledEntry = Object.entries(finalRun.settled ?? {}).find(
    ([, e]) => e.outcome === 'gate' && e.token === originalGateId && e.resolved_by === 'timeout',
  );
  if (settledEntry !== undefined) {
    const [stepName, entry] = settledEntry;
    const enactedDisclosure = `gate '${originalGateId}' expired ${overdueLabel} ago and was enacted (settle_default: '${entry.choice}') before this response arrived — enacted_via: submit.`;
    if (entry.choice === originalChoice) {
      // [F12]'s own pinned string — same choice, still honestly not "your" recorded response.
      return {
        command: stepName,
        run_id: finalRun.id,
        run_version: finalRun.version,
        status: 'ok',
        data: {},
        evidence: [],
        warnings: mergeWarnings([], enactedDisclosure, ...drainWarnings),
        errors: [],
        context_hint:
          'the outcome matches your choice, but it was settled by timeout; your response was not recorded.',
        run_phase: finalRun.run_phase,
        next_actions: finalRun.terminal_state ? [] : buildNextActions(definition, finalRun),
      };
    }
    const err = new WorkflowError(
      `Gate '${originalGateId}' was settled by timeout with choice '${entry.choice}' — your choice '${originalChoice}' was not recorded.`,
      {
        code: 'STATE_BLOCKED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: {
          runId: finalRun.id,
          gateId: originalGateId,
          winning_choice: entry.choice,
          resolved_by: 'timeout',
        },
      },
    );
    const envelope = errorEnvelope(
      stepName,
      finalRun.id,
      finalRun.version,
      err,
      err.message,
      finalRun.run_phase,
    );
    return { ...envelope, warnings: mergeWarnings([], enactedDisclosure, ...drainWarnings) };
  }

  // abort disposition: a skip_details entry kind 'gate_expired' bearing this gateId.
  const abortEntry = Object.entries(finalRun.skip_details ?? {}).find(
    ([, d]) => d.kind === 'gate_expired' && d.gate_id === originalGateId,
  );
  if (abortEntry !== undefined) {
    const [stepName] = abortEntry;
    const enactedDisclosure = `gate '${originalGateId}' expired ${overdueLabel} ago and was enacted (abort) before this response arrived — enacted_via: submit.`;
    const err = new WorkflowError(
      `Gate '${originalGateId}' on '${stepName}' expired and the run aborted per the ` +
        `workflow's declared on_expiry — your choice was NOT recorded.`,
      {
        code: 'STATE_RUN_TERMINAL',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId: finalRun.id, gateId: originalGateId, step_name: stepName },
      },
    );
    const envelope = errorEnvelope(
      stepName,
      finalRun.id,
      finalRun.version,
      err,
      err.message,
      finalRun.run_phase,
    );
    return { ...envelope, warnings: mergeWarnings([], enactedDisclosure, ...drainWarnings) };
  }

  // issue #319: rare-by-construction, not unreachable. Reachable ONLY in the migrated-path race
  // window where a concurrent writer terminalized the run BETWEEN the F3 gate_expired_pending
  // refusal and this caller's own expire delta being applied — neither search above finds a
  // matching entry because the concurrent settlement recorded a DIFFERENT gate/step, never this
  // one (the #317-correction discriminator: this cell is proven reachable only with a terminal
  // `finalRun`, since the legacy snapshot path answers both searches from one snapshot and can
  // never fall through to here). The honest answer is a terminal disclosure, not an engine fault
  // — never attribute the outcome to THIS gate's expiry (no matched entry exists to attribute it
  // to), and never claim "expired" at all, since nothing here witnessed this gate expiring.
  const err = new WorkflowError(
    `Gate '${originalGateId}': the run reached a terminal outcome concurrently — your choice ` +
      `was NOT recorded. 'realm resume' clears a stale pending gate on a resumable run, or ` +
      `'realm run purge' removes the record entirely.`,
    {
      code: 'STATE_RUN_TERMINAL',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { runId: finalRun.id, gateId: originalGateId },
    },
  );
  return errorEnvelope(
    'submit_gate',
    finalRun.id,
    finalRun.version,
    err,
    err.message,
    finalRun.run_phase,
  );
}

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

  // issue #291: injectable clock, hoisted here so BOTH the migrated and legacy paths below use
  // the SAME instant for their expiry checks.
  const now = options.now ?? new Date();

  // issue #279 (increment 2, PR-D, Deliverable 1b): the migrated path — the four legacy
  // verify-arms below (1a-4) become settle_gate's OWN predicate arms; this branch skips them
  // entirely and settles atomically against FRESH state via the store's own settleStep. Dormancy:
  // an undeclaring store falls through to the byte-identical legacy path below (I16/#169
  // fail-closed dormancy).
  if (store.settleStep !== undefined) {
    const respondedAt = now;
    // Evidence rule (design record §6 lens-3 S2): built from the PRE-READ `pending_gate` IFF it
    // matches options.gateId — else `[]` (the arm can never APPLY against a non-matching fresh
    // read either, so an empty evidence array is inert there; a matching pre-read is guaranteed
    // fresh enough to be correct on `applied: true`, since gate_id is a per-attempt-minted UUID
    // that can never "come back" once resolved/absent).
    const gateResponseEvidence: EvidenceSnapshot[] =
      run.pending_gate !== undefined && run.pending_gate.gate_id === options.gateId
        ? [
            buildGateResponseSnapshot(
              run.pending_gate,
              options.choice,
              respondedAt,
              options.respondedBy,
            ),
          ]
        : [];
    const delta: SettleGateDelta = {
      kind: 'settle_gate',
      gateId: options.gateId,
      choice: options.choice,
      ...(options.respondedBy !== undefined ? { respondedBy: options.respondedBy } : {}),
      evidence: gateResponseEvidence,
    };

    let result: SettlementResult;
    try {
      // issue #291 ([F3]): the injectable `now` reaches applySettleGate's write-free
      // gate_expired_pending arm through this SAME options.now plumbing.
      result = await store.settleStep(options.runId, delta, definition, { now });
    } catch (err) {
      // Thrown infra errors keep the SAME shape as the legacy path's own final-persist catch,
      // below (design record §6: "thrown infra errors ALSO keep the :3563-3581 shape").
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
        run.pending_gate?.step_name ?? 'submit_gate',
        options.runId,
        run.version,
        e,
        `Failed to persist gate response.`,
        run.run_phase,
      );
    }

    if (!result.applied) {
      switch (result.reason) {
        case 'gate_expired_pending': {
          // issue #291 ([F3] shape c): the live gate has already expired unresolved — issue the
          // caller-composed expire_gate settleStep ([F1]'s arms make this idempotent even under a
          // race with another enactment point) and compose the honest late-response envelope from
          // whatever the enactment result actually committed.
          const overdueMs =
            run.pending_gate?.expires_at !== undefined
              ? now.getTime() - new Date(run.pending_gate.expires_at).getTime()
              : 0;
          const expireDelta: ExpireGateDelta = { kind: 'expire_gate', gateId: options.gateId };
          let expireResult: SettlementResult;
          try {
            expireResult = await store.settleStep(options.runId, expireDelta, definition, {
              now,
            });
          } catch (err) {
            const e =
              err instanceof WorkflowError
                ? err
                : new WorkflowError("Failed to enact the gate's expiry", {
                    code: 'ENGINE_STORE_FAILED',
                    category: 'ENGINE',
                    agentAction: 'stop',
                    retryable: false,
                  });
            return errorEnvelope(
              run.pending_gate?.step_name ?? 'submit_gate',
              options.runId,
              result.run.version,
              e,
              "Failed to enact the gate's expiry.",
              result.run.run_phase,
            );
          }
          return composeExpiredGateEnvelope(
            store,
            definition,
            options.registry,
            options.gateId,
            options.choice,
            overdueMs,
            expireResult,
          );
        }
        case 'already_settled': {
          // Calm ok envelope stating the resolution already committed (same choice) — never
          // report_to_user. Drain: on already_settled ∧ pending ledger entries non-empty — hand-
          // rolled here (buildAlreadySettledEnvelope is ExecuteStepOptions-shaped, not reusable at
          // this call site) — recovers a crashed-drain RESOLVE on a duplicate submit (design record
          // §6 row 2, the buildAlreadySettledEnvelope drain-on-NOOP pattern reused verbatim).
          const stepName = findGateStepName(result.run, options.gateId) ?? 'submit_gate';
          let noopRun = result.run;
          let noopDrainWarnings: string[] = [];
          const hasPending = Object.values(noopRun.finalizer_ledger ?? {}).some(
            (e) => e.status === 'pending',
          );
          if (hasPending) {
            try {
              const drainOutcome = await drainFinalizers(
                store,
                definition,
                options.registry,
                options.runId,
              );
              noopRun = drainOutcome.run;
              noopDrainWarnings = drainOutcome.warnings;
            } catch (err) {
              noopDrainWarnings = [
                `post-commit finalizer drain failed: ${err instanceof Error ? err.message : String(err)}`,
              ];
            }
          }
          return {
            command: stepName,
            run_id: options.runId,
            run_version: noopRun.version,
            status: 'ok',
            data: {},
            evidence: [],
            warnings: mergeWarnings([], ...noopDrainWarnings),
            errors: [],
            context_hint: `Gate '${options.gateId}' was already resolved with choice '${options.choice}' — no action was taken.`,
            run_phase: noopRun.run_phase,
            next_actions: noopRun.terminal_state ? [] : buildNextActions(definition, noopRun),
          };
        }
        case 'gate_choice_conflict': {
          const stepName = findGateStepName(result.run, options.gateId);
          const err = new WorkflowError(
            `Gate '${options.gateId}' was already resolved with choice '${result.winningChoice}' ` +
              `— your choice '${options.choice}' was not recorded.`,
            {
              code: 'STATE_BLOCKED',
              category: 'STATE',
              agentAction: 'report_to_user',
              retryable: false,
              details: {
                runId: options.runId,
                gateId: options.gateId,
                winning_choice: result.winningChoice,
              },
            },
          );
          return errorEnvelope(
            stepName ?? 'submit_gate',
            options.runId,
            result.run.version,
            err,
            err.message,
            result.run.run_phase,
          );
        }
        case 'choice_not_eligible': {
          // VALIDATION_INPUT_SCHEMA envelope — parity with the legacy path's own step 4 (below).
          const stepName = result.run.pending_gate!.step_name; // the arm only reaches this check
          // when fresh.pending_gate.gate_id === gateId, so this is reliably the live gate's step.
          const expected = (result.choices ?? []).join(', ');
          const err = new WorkflowError(
            `Choice '${options.choice}' is not valid. Expected one of: ${expected}`,
            {
              code: 'VALIDATION_INPUT_SCHEMA',
              category: 'VALIDATION',
              agentAction: 'report_to_user',
              retryable: false,
            },
          );
          return errorEnvelope(
            stepName,
            options.runId,
            result.run.version,
            err,
            `Invalid choice '${options.choice}' for gate '${stepName}'.`,
            result.run.run_phase,
          );
        }
        case 'gate_mismatch': {
          const err = new WorkflowError(
            `Gate '${options.gateId}' is not the open gate and matches no committed resolution.`,
            {
              code: 'STATE_BLOCKED',
              category: 'STATE',
              agentAction: 'report_to_user',
              retryable: false,
              details: { runId: options.runId, gateId: options.gateId },
            },
          );
          return errorEnvelope(
            'submit_gate',
            options.runId,
            result.run.version,
            err,
            err.message,
            result.run.run_phase,
          );
        }
        case 'run_terminal': {
          // Composed cancelled-predicate (design record §5 D-4/§11 N10): any gate_cancelled_by_abort
          // skip detail ⇒ the cancelled variant ("your choice was NOT recorded" + cause) — bound by
          // gate_id equality once that field is populated (PR-D+), else by presence alone (pre-PR-D
          // records, N10). No match ⇒ the zombie/grandfathered variant + the resume-clears/purge
          // pointer.
          const cancelEntry = Object.entries(result.run.skip_details ?? {}).find(
            ([, d]) => d.kind === 'gate_cancelled_by_abort',
          );
          const cancelDetail = cancelEntry?.[1] as
            { kind: 'gate_cancelled_by_abort'; gate_id?: string } | undefined;
          const isCancelledMatch =
            cancelEntry !== undefined &&
            (cancelDetail!.gate_id === undefined || cancelDetail!.gate_id === options.gateId);
          if (isCancelledMatch) {
            const [cancelledStep] = cancelEntry!;
            const abortedBy = result.run.aborted_at?.step_id;
            const err = new WorkflowError(
              `Gate '${options.gateId}' on '${cancelledStep}' was cancelled when ` +
                `'${abortedBy ?? 'another step'}' aborted the run — your choice was NOT recorded.`,
              {
                code: 'STATE_RUN_TERMINAL',
                category: 'STATE',
                agentAction: 'report_to_user',
                retryable: false,
                details: {
                  runId: options.runId,
                  run_phase: result.run.run_phase,
                  gate_id: options.gateId,
                  step_name: cancelledStep,
                  ...(abortedBy !== undefined ? { aborted_by: abortedBy } : {}),
                },
              },
            );
            return errorEnvelope(
              cancelledStep,
              options.runId,
              result.run.version,
              err,
              err.message,
              result.run.run_phase,
            );
          }
          // Zombie/grandfathered variant — the #282 class: a terminal record may still carry a
          // stale pending_gate (never cleared), which is the best-effort step label here.
          const zombieStep = result.run.pending_gate?.step_name ?? 'submit_gate';
          const err = new WorkflowError(
            `Run '${options.runId}' is terminal; cannot submit a gate response — 'realm resume' ` +
              `clears a stale pending gate on a resumable run, or 'realm run purge' removes the ` +
              `record entirely.`,
            {
              code: 'STATE_RUN_TERMINAL',
              category: 'STATE',
              agentAction: 'report_to_user',
              retryable: false,
              details: { runId: options.runId, run_phase: result.run.run_phase },
            },
          );
          return errorEnvelope(
            zombieStep,
            options.runId,
            result.run.version,
            err,
            err.message,
            result.run.run_phase,
          );
        }
        default:
          // gate_open_wait/already_open/already_released/choice_not_eligible's siblings and every
          // other kind's own reason are unreachable here — settle_gate never returns them (design
          // record §7).
          throw new Error(
            `submitHumanResponse: unreachable settle_gate refusal reason '${result.reason}'`,
          );
      }
    }

    // applied: true. Reliable step name: the pre-read's pending_gate.step_name (guaranteed
    // correct whenever `applied` is true — see the evidence-rule comment above).
    const resolvedGateStepName = run.pending_gate!.step_name;

    // Drain: on transitioned OR (already_settled ∧ pending ledger entries non-empty) — hand-rolled
    // (buildAlreadySettledEnvelope is ExecuteStepOptions-shaped, not reusable here). `applied:
    // true` never reaches the already_settled leg, so only the `transitioned` disjunct applies at
    // THIS call site (design record §6 row 2).
    let finalRun = result.run;
    let drainWarnings: string[] = [];
    if (result.transitioned) {
      try {
        const drainOutcome = await drainFinalizers(
          store,
          definition,
          options.registry,
          options.runId,
        );
        finalRun = drainOutcome.run;
        drainWarnings = drainOutcome.warnings;
      } catch (err) {
        drainWarnings = [
          `post-commit finalizer drain failed: ${err instanceof Error ? err.message : String(err)}`,
        ];
      }
    }

    // Convergence hint (design record D-2 N8 narrowing, pedestal steal — must not drop): after a
    // committed RESOLVE, when a guard is thereby eligible, append one line per eligible guard.
    // findEligibleGuardSteps self-filters terminal runs (returns [] there), so this is inert on a
    // gate-completion terminal transition.
    const convergenceHints = findEligibleGuardSteps(definition, finalRun).map(
      (name) => `guard '${name}' now eligible — converges at the next drive`,
    );

    const defaultedStepsDurabilityWarning =
      finalRun.defaulted_steps !== undefined &&
      finalRun.defaulted_steps.length > 0 &&
      !persistsField(store, 'defaulted_steps')
        ? 'run-level defaultedness marker (defaulted_steps) not durable on this store'
        : undefined;

    const migratedNextActions = finalRun.terminal_state
      ? []
      : buildNextActions(definition, finalRun);
    const migratedOrientation = finalRun.terminal_state
      ? `Run completed (phase: '${finalRun.run_phase}'). Call get_run_state with run_id '${options.runId}' to retrieve the full evidence record.`
      : `Gate '${resolvedGateStepName}' resolved with choice '${options.choice}'. ${migratedNextActions.length} step(s) now available.`;

    return {
      command: resolvedGateStepName,
      run_id: options.runId,
      run_version: finalRun.version,
      status: 'ok',
      data: { ...run.pending_gate!.preview, choice: options.choice },
      evidence: [],
      warnings: mergeWarnings(convergenceHints, ...drainWarnings, defaultedStepsDurabilityWarning),
      errors: [],
      context_hint: migratedOrientation,
      run_phase: finalRun.run_phase,
      next_actions: migratedNextActions,
      ...(finalRun.defaulted_steps?.length ? { defaulted_steps: finalRun.defaulted_steps } : {}),
    };
  }

  // --- Legacy path (dormancy fallback — byte-identical to pre-#279 behavior) ---

  // 1a. Defensive terminal guard (mirrors #91/#95): a late gate response must never re-drive a
  // run that has already reached a terminal phase.
  if (run.terminal_state) {
    return errorEnvelope(
      'submit_gate',
      options.runId,
      run.version,
      new WorkflowError(`Run '${options.runId}' is terminal; cannot submit a gate response.`, {
        code: 'STATE_RUN_TERMINAL',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { runId: options.runId, run_phase: run.run_phase },
      }),
      `Run is terminal (${run.run_phase}); cannot submit a gate response.`,
    );
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

  // 3.5. issue #291 ([F4] legacy-store expiry — the ONE enactment point F4 explicitly gives a
  // legacy-CAS fallback, since it already owns one): the gate has expired AND has an enactable
  // disposition (on_expiry frozen — a finding-only gate, expires_at with no on_expiry, is
  // excluded exactly like applySettleGate's own F3 gating, so a finding-only gate's human
  // response resolves normally below, however overdue). Enacted via the SAME pure
  // `applySettlement` transform this store's declaring siblings use through `settleStep` — this
  // store has no `settleStep` of its own, so the result is persisted through the version-CAS
  // `store.update()` this legacy path already owns. A CAS-mismatch (a genuine race) surfaces as
  // an honest error, matching this path's existing no-retry risk profile everywhere else.
  if (
    run.pending_gate.expires_at !== undefined &&
    run.pending_gate.on_expiry !== undefined &&
    now.getTime() >= new Date(run.pending_gate.expires_at).getTime()
  ) {
    const overdueMs = now.getTime() - new Date(run.pending_gate.expires_at).getTime();
    const expireOutcome = applySettlement(
      run,
      { kind: 'expire_gate', gateId: options.gateId },
      definition,
      { now },
    );
    if (!expireOutcome.applied) {
      // In-contract for this snapshot-based path: the local `run` might already reflect a prior
      // enactment (e.g. a same-process retry) — already_settled composes the honest envelope the
      // same way the migrated path's race leg does, reading disposition off `expireOutcome.run`
      // (the very snapshot the refusal matched against).
      return composeExpiredGateEnvelope(
        store,
        definition,
        options.registry,
        options.gateId,
        options.choice,
        overdueMs,
        expireOutcome,
      );
    }
    let persistedExpiry: RunRecord;
    try {
      persistedExpiry = await store.update(expireOutcome.run);
    } catch (err) {
      const e =
        err instanceof WorkflowError
          ? err
          : new WorkflowError("Failed to persist the gate's expiry", {
              code: 'ENGINE_STORE_FAILED',
              category: 'ENGINE',
              agentAction: 'stop',
              retryable: false,
            });
      return errorEnvelope(
        run.pending_gate.step_name,
        options.runId,
        run.version,
        e,
        "Failed to enact the gate's expiry.",
        run.run_phase,
      );
    }
    return composeExpiredGateEnvelope(
      store,
      definition,
      options.registry,
      options.gateId,
      options.choice,
      overdueMs,
      { ...expireOutcome, run: persistedExpiry },
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

  // issue #367: `sealed_by` joins the strip list — this write re-derives the run's liveness from
  // scratch, so a stale seal (a grandfathered/mixed-fleet record) must not survive it. The
  // explicit `terminal_state: false` below keeps the strip inside the store boundary's ORPHANED
  // exemption: a strip site flips non-terminal in the SAME write.
  const { pending_gate: _pg, terminal_reason: _tr, sealed_by: _sb, ...rest } = run;
  const afterGate: RunRecord = {
    ...rest,
    in_progress_steps: rest.in_progress_steps.filter((s) => s !== gateStepName),
    // Delete the claim clock in the SAME mutation that removes the step (issue #101).
    claims: omitClaim(rest.claims, gateStepName),
    completed_steps: [...rest.completed_steps, gateStepName],
    evidence: [...rest.evidence, gateSnapshot],
  };
  // Propagate skips in case resolving the gate completes a dep that makes
  // some downstream trigger_rules permanently unsatisfiable.
  const gatePropagated = propagateSkips(afterGate, definition);
  const withSkippedGate: RunRecord = {
    ...afterGate,
    skipped_steps: gatePropagated.skipped,
    skip_details: gatePropagated.details,
  };
  // A run is terminal when all steps are settled OR when no step will ever become
  // eligible again (safety net for when-condition routing not fully covered by propagateSkips).
  // Guard steps are not returned by findEligibleSteps, so check them separately.
  const isComplete =
    isWorkflowComplete(withSkippedGate, definition) ||
    (withSkippedGate.in_progress_steps.length === 0 &&
      findEligibleSteps(definition, withSkippedGate).length === 0 &&
      findEligibleGuardSteps(definition, withSkippedGate).length === 0);
  // issue #367: seal fields staged first (the prior seal was already stripped at the `afterGate`
  // construction above, so this fork starts clean by construction).
  const gateDraft: RunRecord = isComplete
    ? {
        ...withSkippedGate,
        terminal_state: true,
        sealed_by: { arm: 'gate_resolution_complete', step: gateStepName },
        terminal_reason: `Workflow completed.`,
      }
    : { ...withSkippedGate, terminal_state: false };
  // On the gate-completion terminal transition, drain complete/always finalizers before seal.
  // issue #220 PR-2 (D6): stamp defaulted_steps onto the SEALED terminal record only (never the
  // non-terminal `gateDraft` — the FM-5 guard).
  const finalRun: RunRecord = isComplete
    ? stampDefaultedSteps(
        await buildFinalizedSeal(definition, gateDraft, 'complete', options.registry),
      )
    : gateDraft;
  // issue #220 PR-2 (D6 write-site consumer): see the Step-6 twin above.
  const defaultedStepsDurabilityWarning =
    finalRun.defaulted_steps !== undefined &&
    finalRun.defaulted_steps.length > 0 &&
    !persistsField(store, 'defaulted_steps')
      ? 'run-level defaultedness marker (defaulted_steps) not durable on this store'
      : undefined;

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
      run.run_phase,
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
    // issue #220 PR-2 (D5): submitHumanResponse is a SEPARATE function with no D4
    // `settledByDefault` local in scope — it does NOT set the per-settle `settled_by_default`
    // envelope flag (do NOT add an evidence scan to recompute it). Its disclosure surface is the
    // run-level `defaulted_steps` marker below, plus whatever the gate-open envelope already
    // warned the human with.
    // issue #279 (increment 2, PR-D): + the ONE dormancy advisory (I16) — this IS the legacy path
    // (store.settleStep undeclared).
    warnings: mergeWarnings([], defaultedStepsDurabilityWarning, DORMANCY_ADVISORY),
    errors: [],
    context_hint: orientation,
    run_phase: savedRun.run_phase,
    next_actions: nextActions,
    ...(finalRun.defaulted_steps?.length ? { defaulted_steps: finalRun.defaulted_steps } : {}),
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
      // issue #373 correction: the path is the DIAGNOSTIC, and it used to live only in
      // `output_summary` + a transient seal-time overlay — so the post-drain re-render, which
      // rebuilds the cause from evidence alone, replaced it with the generic condition text.
      // Carrying it here makes every downstream read of this failure lossless. Sole production
      // mint: the settlement delta reuses this exact snapshot via `guardOwnEvidence`.
      //
      // The path goes FIRST because the per-message cap slices from the head: with the path last,
      // a long enough condition pushed it off the tail and the diagnostic vanished again. Honest
      // bound: a pathological PATH over ~230 chars still truncates itself, which is accepted —
      // head-first truncation keeps its prefix, and the prefix is the orienting part. ASCII
      // parenthetical, not an em dash, for the same reason the truncation marker is ASCII (logs,
      // terminals, a Postgres text column) — and a cut-off parenthetical reads as obviously partial.
      error: `Guard resolution error: unresolvable path '${outcome.unresolvable_path}' (condition: ${outcome.condition})`,
    });

    const withFailed: RunRecord = {
      ...run,
      evidence: [...run.evidence, evidenceEntry],
      failed_steps: [...run.failed_steps, stepName],
    };
    const resolutionErrorPropagated = propagateSkips(withFailed, definition);
    const withSkipped: RunRecord = {
      ...withFailed,
      skipped_steps: resolutionErrorPropagated.skipped,
      skip_details: resolutionErrorPropagated.details,
    };
    // issue #373 — twin of settlement.ts's guard seal. The overlay is DEFENSIVE once evidence
    // carries the path (issue #373 correction, the `error` above); kept against caller-shaped
    // evidence that arrives without it.
    const guardPath = `unresolvable path '${outcome.unresolvable_path}'`;
    return {
      ...withSkipped,
      terminal_state: true,
      // issue #367: the arm sits BESIDE #373's rendered sentence, never inside it.
      sealed_by: { arm: 'guard_resolution_error', step: stepName },
      terminal_reason:
        new Set(withSkipped.failed_steps).size > 1
          ? renderFailCause(
              withSkipped.failed_steps,
              failureMessagesWithOverlay(withSkipped.evidence, stepName, guardPath),
            )
          : `Guard step '${stepName}' failed: ${guardPath}`,
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
    const guardPassPropagated = propagateSkips(withCompleted, definition);
    const withSkipped: RunRecord = {
      ...withCompleted,
      skipped_steps: guardPassPropagated.skipped,
      skip_details: guardPassPropagated.details,
    };
    const isComplete =
      isWorkflowComplete(withSkipped, definition) ||
      (withSkipped.in_progress_steps.length === 0 &&
        findEligibleSteps(definition, withSkipped).length === 0 &&
        findEligibleGuardSteps(definition, withSkipped).length === 0);
    // issue #367: the stamp lives INSIDE the isComplete arm ONLY — a non-terminal guard pass must
    // never carry a seal.
    return isComplete
      ? {
          ...withSkipped,
          terminal_state: true,
          sealed_by: { arm: 'guard_pass_complete', step: stepName },
          terminal_reason: 'Workflow completed.',
        }
      : { ...withSkipped, terminal_state: false };
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
  // Propagate skips for any downstream steps that can no longer fire. The merge below is
  // load-bearing (issue #111) — it preserves any cascade details for OTHER now-unreachable
  // steps alongside this guard's own guard_abort tag.
  const guardAbortPropagated = propagateSkips(withGuardSkipped, definition);
  const withAllSkipped: RunRecord = {
    ...withGuardSkipped,
    skipped_steps: guardAbortPropagated.skipped,
    skip_details: { ...guardAbortPropagated.details, [stepName]: { kind: 'guard_abort' } },
  };
  return {
    ...withAllSkipped,
    terminal_state: true,
    // issue #367: same object literal as the terminal flip. terminal_reason stays ABSENT here (a
    // guard abort is the one reason-less seal) — the phase now derives from the arm, and
    // `aborted_at` is asserted congruent rather than consulted.
    sealed_by: { arm: 'guard_abort', step: stepName },
    aborted_at: {
      step_id: stepName,
      conditions: outcome.conditions,
      ...(stepDef.abort_message !== undefined ? { abort_message: stepDef.abort_message } : {}),
    },
  };
}

/**
 * Drains the finalizers matching a run's terminal `outcome` and returns the FINALIZED
 * RunRecord — the workflow-level try/catch/finally at the seal. Modeled on
 * executeGuardStep, but it does NOT persist: the caller performs the run's single seal
 * `store.update` with its own error/WAL/envelope handling.
 *
 * Selection & order:
 *  - Group A (rank 0): `on_outcome` contains `outcome` (the specific catch/complete arm).
 *  - Group B (rank 1): `on_outcome` contains `'always'` but NOT `outcome` (the `finally` arm;
 *    a finalizer listing both runs once, in Group A).
 *  - Each group in declaration order (`Object.entries`); Group A then Group B (`always` last).
 *  - Idempotent at-most-once: any finalizer already in completed/failed_steps is skipped
 *    (resume / re-drive safety).
 *
 * Each finalizer runs its handler via `callHandler` (never `claimStep`), wrapped in
 * `withTimeout` honoring `timeout_seconds` (default `DRAIN_CEILING_SECONDS`). Success →
 * evidence + completed_steps; thrown error / STEP_TIMEOUT / handler `{ abort }` → evidence
 * marked failed + failed_steps, NON-FATAL (the drain continues). A finalizer NEVER mutates
 * `aborted_at`, `terminal_state`, `skipped_steps`, or emits next_actions, and never changes the
 * sealed OUTCOME — the terminal marks come from `sealDraft` and `deriveRunPhase` precedence keeps
 * the phase. issue #373: a finalizer whose OWN failure grows `failed_steps` on a fail-class seal
 * DOES re-render `terminal_reason`, so the one-line cause keeps agreeing with the record.
 */
async function buildFinalizedSeal(
  definition: WorkflowDefinition,
  sealDraft: RunRecord,
  outcome: 'complete' | 'fail' | 'abort',
  registry: ExtensionRegistry | undefined,
): Promise<RunRecord> {
  // Zero-finalizer fast path: no finalizer steps declared ⇒ return the seal draft
  // completely untouched (byte-identical to the pre-finalizer engine — the damage rail).
  const hasFinalizers = Object.values(definition.steps).some((s) => s.execution === 'finalizer');
  if (!hasFinalizers) return sealDraft;

  // issue #279 (increment 1, PR-A extraction): the grouping/ordering logic itself now lives in
  // settlement.ts's selectFinalizers, shared with `mintFresh` — this call passes the SAME inputs
  // the inline loop used to compute over, so the returned name list is byte-identical to what
  // `[...groupA, ...groupB]` produced before the extraction.
  // issue #302 (chokepoint 2 of 2): derive the full effective trigger set from sealDraft — the
  // legacy seal path for a non-declaring external store (the dormancy fallback).
  const settled = new Set([...sealDraft.completed_steps, ...sealDraft.failed_steps]);
  const selected = selectFinalizers(
    definition,
    settled,
    deriveEffectiveTriggers(outcome, sealDraft),
  );

  // issue #367: the draft already carries sealed_by (every caller stamps at construction), so the
  // fast path above can never bypass the stamp.
  // issue #373: the post-drain re-render fires only if the drain ACTUALLY appended a failure.
  // The legacy seal is reached on every fail-class outcome, including one where every finalizer
  // succeeds — re-rendering there would rebuild the sentence without the seal site's in-hand
  // overlay (the guard sites' unresolvable-path text) and silently drop it.
  const failedBeforeDrain = sealDraft.failed_steps.length;
  let record = sealDraft;
  for (const name of selected) {
    const step = definition.steps[name]!;
    const now = new Date();
    const evidenceByStep = buildEvidenceByStep(record);
    const timeoutMs = (step.timeout_seconds ?? DRAIN_CEILING_SECONDS) * 1000;
    // Minimal per-finalizer dispatch options: handler-only, no input (input_map prohibited),
    // no agent dispatcher path. callHandler resolves the handler from the injected registry.
    const options: ExecuteStepOptions = {
      runId: record.id,
      command: name,
      input: {},
      dispatcher: async () => ({}),
      ...(registry !== undefined ? { registry } : {}),
    };
    try {
      const result = await withTimeout(
        (signal) => callHandler(step, options, record, evidenceByStep, signal),
        timeoutMs,
        name,
      );
      if (result.kind === 'abort') {
        // A finalizer handler returning { abort } is a recorded NON-FATAL failure — it must never
        // mutate aborted_at or the sealed OUTCOME. (issue #373: it does join `failed_steps`, and
        // the post-drain re-render below folds it into the one-line cause — that reports the
        // outcome faithfully, it does not change it.)
        record = {
          ...record,
          evidence: [
            ...record.evidence,
            captureEvidence({
              stepId: name,
              startedAt: now,
              completedAt: new Date(),
              input: {},
              output: { aborted: true, abort_message: result.message },
              error: `Finalizer '${name}' returned abort: ${result.message}`,
            }),
          ],
          failed_steps: [...record.failed_steps, name],
        };
      } else {
        record = {
          ...record,
          evidence: [
            ...record.evidence,
            captureEvidence({
              stepId: name,
              startedAt: now,
              completedAt: new Date(),
              input: {},
              output: result.output,
              ...(result.kind === 'warn' ? { warn: result.message } : {}),
            }),
          ],
          completed_steps: [...record.completed_steps, name],
        };
      }
    } catch (err) {
      // Thrown handler error OR STEP_TIMEOUT → recorded failed, drain continues (non-fatal).
      const message = err instanceof Error ? err.message : String(err);
      record = {
        ...record,
        evidence: [
          ...record.evidence,
          captureEvidence({
            stepId: name,
            startedAt: now,
            completedAt: new Date(),
            input: {},
            output: {},
            error: `Finalizer '${name}' failed: ${message}`,
          }),
        ],
        failed_steps: [...record.failed_steps, name],
      };
    }
  }

  // issue #367: `sealed_by` is INHERITED from sealDraft, never re-derived here — a finalizer never
  // changes which arm sealed the run, and re-deriving from `outcome` would re-couple the arm to
  // mintOutcome, the exact coupling the recorded fact exists to break. `sealDraft` is terminal at
  // every call site (all of them sit inside an isComplete/abort branch), so this narrow is total;
  // it throws rather than fabricating an arm if a future caller violates that.
  if (sealDraft.terminal_state !== true) {
    throw new Error('buildFinalizedSeal called with a non-terminal sealDraft');
  }
  // Conditional spread, NOT `sealed_by: sealDraft.sealed_by`: under the flat optional plus
  // exactOptionalPropertyTypes the unconditional form does not compile. An unstamped draft passes
  // through honest-absent, and refusing it is the store boundary's job.
  const drained: RunRecord = {
    ...record,
    terminal_state: true,
    ...(sealDraft.sealed_by !== undefined ? { sealed_by: sealDraft.sealed_by } : {}),
  };
  // issue #367: SEAL_MARKERS_AGREE — transform-scoped assertion on the record THIS function
  // produces (the second of the two transform homes; never universal).
  assertSealMarkersAgree(drained);
  // Twin of applyMarkFinalizer's failed-arm re-render. `deriveRunPhase`, not `outcome`: an aborted
  // run whose finalizer also failed keeps its abort sentence (aborted_at wins), and a
  // complete-outcome run keeps the complete-seal literal untouched.
  if (
    record.failed_steps.length > failedBeforeDrain &&
    deriveRunPhase(drained) === 'failed' &&
    new Set(record.failed_steps).size > 1
  ) {
    return {
      ...drained,
      terminal_reason: renderFailCause(
        record.failed_steps,
        failureMessagesFromEvidence(record.evidence),
      ),
    };
  }
  return drained;
}

/** Every currently-`'pending'` finalizer in `run`'s ledger, ascending by rank — the order the
 *  drain loop below consumes (design record §6). */
function pendingByRank(run: RunRecord): string[] {
  return Object.entries(run.finalizer_ledger ?? {})
    .filter(([, e]) => e.status === 'pending')
    .sort(([, a], [, b]) => a.rank - b.rank)
    .map(([name]) => name);
}

/** Bounded retry count for `mark_finalizer` on a thrown `STATE_RUN_BUSY` (design record §6: "bounded
 *  retry on thrown STATE_RUN_BUSY"). Small and fixed — lock contention self-heals quickly; this is
 *  not a backoff schedule, just enough attempts to ride out a transient contender. */
const DRAIN_MARK_BUSY_RETRIES = 3;

/**
 * Post-commit finalizer drain (design record §6, D2, issue #279 increment 1 PR-B). Drains the
 * LOWEST-ranked pending finalizer, re-reading the record returned by the LAST settle/lease/mark at
 * every step — NEVER a pass-start snapshot (the DRAIN_REREADS_LEDGER pin: a snapshot taken once at
 * the top of this function would go stale the instant the first lease/mark commits, silently
 * reintroducing exactly the kind of pre-commit assumption #279 exists to eliminate).
 *
 * Lives here (not in settlement.ts) so the module-private `withTimeout`/`callHandler` — already
 * proven by `buildFinalizedSeal` above — are reused without exporting them; `settlement.ts` stays
 * pure/no-I/O (design record §7 CS-purity).
 *
 * Registry pre-check: an absent handler leaves the entry pending and discloses why, rather than
 * burning it (leasing it, failing the call, and marking it 'failed' would destroy the "recoverable
 * on a capable runner" property a still-pending entry carries). Rank-monotonic: a pass HALTS at the
 * first entry it cannot lease/execute, so a lower-ranked absent-handler or held-lease entry
 * withholds every higher-ranked (later) finalizer behind it (R11) — this is deliberate: rank order
 * is a DELIVERY order guarantee, not just a preference.
 *
 * `not_eligible` at lease OR mark time is a contract violation (an unknown finalizer id — mintFresh
 * only ever mints real workflow finalizer names) and aborts the pass LOUD (throws), distinct from
 * `ledger_not_pending` at lease time, which ADVANCES (someone else already resolved it). A
 * non-BUSY infra throw from `mark_finalizer` also aborts loud, with the remaining-pending list in
 * the message. The executed-but-not-recorded warning (three reasons: `lease_lost`,
 * `ledger_not_pending`-AFTER-execution, `run_not_terminal`) halts the pass rather than continuing —
 * each of those three reasons refuses the mark WITHOUT mutating the ledger entry's `'pending'`
 * status, so continuing would re-select the SAME entry next iteration (an infinite loop); halting
 * is the only forward-progress-safe response until an operator or a later terminal edge resolves it.
 */
export async function drainFinalizers(
  store: RunStore,
  definition: WorkflowDefinition,
  registry: ExtensionRegistry | undefined,
  runId: string,
): Promise<{ run: RunRecord; warnings: string[] }> {
  // .bind(store): a bare `store.settleStep` reference loses its `this` binding — the store's own
  // method body (e.g. JsonFileStore's `this.ensureDir()`/`this.filePath()`) would throw on
  // `this === undefined` once called through the detached reference below.
  const settleStep = store.settleStep?.bind(store);
  if (settleStep === undefined) {
    // Defensive — every caller only invokes this once it has already confirmed the store
    // declares settleStep. A fresh read is still the correct degenerate response.
    return { run: await store.get(runId), warnings: [] };
  }
  const warnings: string[] = [];
  let run = await store.get(runId);

  for (;;) {
    const pending = pendingByRank(run);
    if (pending.length === 0) break;
    const finalizerName = pending[0]!;
    const stepDef = definition.steps[finalizerName];
    const handlerName = stepDef?.handler;
    const handler = handlerName !== undefined ? registry?.getHandler(handlerName) : undefined;

    // Registry pre-check — never burn an absent handler; rank-monotonic HALT (R11).
    if (stepDef === undefined || handlerName === undefined || handler === undefined) {
      warnings.push(
        `finalizer '${finalizerName}' left pending — handler not available on this surface`,
      );
      break;
    }

    const leaseToken = crypto.randomUUID();
    const leaseSeconds = stepDef.timeout_seconds ?? DRAIN_CEILING_SECONDS;
    const leaseResult: SettlementResult = await settleStep(
      runId,
      { kind: 'lease_finalizer', finalizer: finalizerName, leaseToken, leaseSeconds },
      definition,
    );
    if (!leaseResult.applied) {
      if (leaseResult.reason === 'lease_held' || leaseResult.reason === 'rank_blocked') {
        run = leaseResult.run;
        break; // HALT the pass — a peer holds this lease, or a lower rank is still pending.
      }
      if (leaseResult.reason === 'ledger_not_pending') {
        run = leaseResult.run;
        continue; // ADVANCE — a peer already resolved this entry.
      }
      // not_eligible — unknown finalizer id; a contract violation (mintFresh never mints one).
      throw new Error(
        `drainFinalizers: lease refused '${leaseResult.reason}' for finalizer '${finalizerName}' ` +
          `on run '${runId}' — remaining pending: ${pendingByRank(leaseResult.run).join(', ')}`,
      );
    }
    run = leaseResult.run;

    // callHandler under withTimeout, OUTSIDE any critical section (the store's CS ends the
    // instant the lease-apply write above returned).
    const startedAt = new Date();
    const evidenceByStep = buildEvidenceByStep(run);
    const callOptions: ExecuteStepOptions = {
      runId,
      command: finalizerName,
      input: {},
      dispatcher: async () => ({}),
      ...(registry !== undefined ? { registry } : {}),
    };
    let markResult: MarkFinalizerResult;
    let evidenceSnapshot: EvidenceSnapshot;
    try {
      const callResult = await withTimeout(
        (signal) => callHandler(stepDef, callOptions, run, evidenceByStep, signal),
        leaseSeconds * 1000,
        finalizerName,
      );
      if (callResult.kind === 'abort') {
        markResult = 'failed';
        evidenceSnapshot = captureEvidence({
          stepId: finalizerName,
          startedAt,
          completedAt: new Date(),
          input: {},
          output: { aborted: true, abort_message: callResult.message },
          error: `Finalizer '${finalizerName}' returned abort: ${callResult.message}`,
        });
      } else {
        markResult = 'completed';
        evidenceSnapshot = captureEvidence({
          stepId: finalizerName,
          startedAt,
          completedAt: new Date(),
          input: {},
          output: callResult.output,
          ...(callResult.kind === 'warn' ? { warn: callResult.message } : {}),
        });
      }
    } catch (err) {
      markResult = 'failed';
      const message = err instanceof Error ? err.message : String(err);
      evidenceSnapshot = captureEvidence({
        stepId: finalizerName,
        startedAt,
        completedAt: new Date(),
        input: {},
        output: {},
        error: `Finalizer '${finalizerName}' failed: ${message}`,
      });
    }

    // mark_finalizer — same lease token; bounded retry on a THROWN STATE_RUN_BUSY only.
    let markOutcome: SettlementResult | undefined;
    for (let attempt = 1; attempt <= DRAIN_MARK_BUSY_RETRIES; attempt++) {
      try {
        markOutcome = await settleStep(
          runId,
          {
            kind: 'mark_finalizer',
            finalizer: finalizerName,
            leaseToken,
            result: markResult,
            evidence: evidenceSnapshot,
          },
          definition,
        );
        break;
      } catch (err) {
        const isBusy = err instanceof WorkflowError && err.code === 'STATE_RUN_BUSY';
        if (isBusy && attempt < DRAIN_MARK_BUSY_RETRIES) continue;
        // Non-BUSY infra throw (or BUSY exhausted) ⇒ abort the pass loud, remaining-pending named.
        throw new Error(
          `drainFinalizers: mark_finalizer failed for '${finalizerName}' on run '${runId}' — ` +
            `remaining pending: ${pendingByRank(run).join(', ')}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
    /* istanbul ignore next -- the for-loop above always either assigns markOutcome or throws */
    if (markOutcome === undefined) {
      throw new Error(
        `drainFinalizers: mark_finalizer produced no outcome for '${finalizerName}' on run '${runId}'`,
      );
    }
    if (!markOutcome.applied) {
      if (markOutcome.reason === 'not_eligible') {
        throw new Error(
          `drainFinalizers: mark refused 'not_eligible' for finalizer '${finalizerName}' on run ` +
            `'${runId}' — contract violation (mintFresh never mints an unknown id)`,
        );
      }
      // lease_lost / ledger_not_pending(-after-execution) / run_not_terminal: the handler DID
      // execute, but the outcome could not be durably recorded — the three-reason
      // executed-but-not-recorded warning (design record §6). Halt: none of these three mutate
      // the entry's 'pending' status, so continuing would re-select the SAME entry forever.
      run = markOutcome.run;
      warnings.push(
        `finalizer '${finalizerName}' executed but its outcome may not have been recorded ` +
          `(${markOutcome.reason}) — it may re-execute at the next terminal edge`,
      );
      break;
    }
    run = markOutcome.run;
    // result:'failed' is settled too (a recorded terminal outcome for this finalizer) — the loop
    // continues to the next rank regardless of markResult.
  }

  return { run, warnings };
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
  /**
   * issue #197 PR-2 (chain-replacement disposition, accepted): a settled DEPTH-0 step (typically
   * an agent step — never itself recorded in `chainedSteps`, which is auto-steps-only, feeding
   * the VISIBLE `chained_auto_steps` list) whose own envelope is about to be discarded in favor
   * of a deeper auto step's envelope would otherwise silently lose its OWN warnings (seal
   * outcome / half-minted / missing-carriage-leg advisories) — this separate accumulator exists
   * ONLY to carry those forward; it never touches `chainedSteps`'/`chained_auto_steps`'s shape.
   * The three NEW adoption counts on that depth-0 envelope are NOT similarly rescued — they
   * persist authoritatively in the settled step's own `trace_summary` regardless (see
   * `ResponseEnvelope.adopted_own`'s own doc) — only the warnings are a load-bearing rescue.
   */
  depth0Warnings: string[],
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
  // issue #279 (increment 2, PR-D, Deliverable 1c): non-abort settled_outcome_divergence warnings
  // ADVANCE the chain but must still surface somewhere — carried here and merged into whichever
  // envelope eventually returns (the guardsRan rebuild below, or a migrated terminal return).
  const guardWarnings: string[] = [];
  let guardEligible = findEligibleGuardSteps(definition, run);
  while (guardEligible.length > 0) {
    const guardName = guardEligible[0]!;
    const guardStepDef = definition.steps[guardName]!;

    // Execute inline (pure in-memory; returns updated RunRecord). executeGuardStep stays PURE and
    // UNTOUCHED (design record §1) — both the migrated and legacy paths below call it identically.
    const guardResult = await executeGuardStep(guardName, guardStepDef, definition, run);

    // Capture the guard's OWN evidence (its last entry) BEFORE the finalizer drain appends
    // finalizer evidence — the terminal return below surfaces only the guard's evidence.
    const guardOwnEvidence = guardResult.evidence.slice(-1);

    // issue #279 (increment 2, PR-D, Deliverable 1c): the migrated path — settles this guard's
    // evaluated outcome atomically against FRESH state via the store's own settleStep. Dormancy:
    // an undeclaring store falls through to the byte-identical legacy path below (I16/#169
    // fail-closed dormancy).
    if (store.settleStep !== undefined) {
      // Extraction rule (design record §2, normative): reverse-classify guardResult's SEALED
      // output by MEMBERSHIP — NEVER the terminal_state ternary below (wrong for a non-terminal
      // pass, which never sets terminal_state at all).
      const guardSettleOutcome: 'pass' | 'resolution_error' | 'abort' =
        guardResult.aborted_at !== undefined
          ? 'abort'
          : guardResult.failed_steps.includes(guardName)
            ? 'resolution_error'
            : 'pass'; // the only remaining membership — completed_steps.includes(guardName)

      let resolutionError: { condition: string; unresolvable_path: string } | undefined;
      if (guardSettleOutcome === 'resolution_error') {
        // Rails-compliant re-derivation (normative): normalize abort_unless to string[] (the
        // executeGuardStep :3632-3635 shape) and re-run evaluateGuardConditions against the SAME
        // pre-seal `run` passed to executeGuardStep — pure + deterministic, so this reproduces the
        // discarded internal result byte-for-byte.
        const conditions = Array.isArray(guardStepDef.abort_unless)
          ? guardStepDef.abort_unless
          : [guardStepDef.abort_unless!];
        const reEvaluated = evaluateGuardConditions(conditions, buildEvidenceByStep(run));
        if (reEvaluated.kind === 'resolution_error') {
          resolutionError = {
            condition: reEvaluated.condition,
            unresolvable_path: reEvaluated.unresolvable_path,
          };
        }
      }

      const delta: SettleGuardDelta = {
        kind: 'settle_guard',
        step: guardName,
        outcome: guardSettleOutcome,
        evidence: guardOwnEvidence[0]!,
        ...(resolutionError !== undefined ? { resolutionError } : {}),
        ...(guardSettleOutcome === 'abort'
          ? {
              abort: {
                conditions: guardResult.aborted_at!.conditions ?? [],
                ...(guardResult.aborted_at!.abort_message !== undefined
                  ? { abort_message: guardResult.aborted_at!.abort_message }
                  : {}),
              },
            }
          : {}),
        // evaluatedAtVersion (design record §2, lane-B steal 2): the chain's OWN evaluation
        // snapshot — this iteration's pre-settle `run.version`.
        evaluatedAtVersion: run.version,
      };

      let guardSettleResult: SettlementResult;
      try {
        guardSettleResult = await store.settleStep(options.runId, delta, definition);
      } catch (storeErr) {
        // Thrown infra errors — the same persist-failure envelope shape the legacy path's own
        // store.update catch (below) has always returned.
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
          run_phase: run.run_phase,
          next_actions: [],
        };
      }

      if (!guardSettleResult.applied) {
        // Chain-consumption table (design record §6, adjudicated):
        if (
          guardSettleResult.reason === 'already_settled' ||
          guardSettleResult.reason === 'gate_open_wait' ||
          (guardSettleResult.reason === 'settled_outcome_divergence' &&
            guardSettleOutcome !== 'abort')
        ) {
          // already_settled / gate_open_wait ⇒ ADVANCE, threading result.run (findEligibleGuardSteps
          // self-filters both a now-settled guard and an open gate, so the loop naturally converges).
          // settled_outcome_divergence on a NON-abort attempt ⇒ ADVANCE + a warning line.
          if (guardSettleResult.reason === 'settled_outcome_divergence') {
            guardWarnings.push(
              `guard '${guardName}' outcome diverged from a concurrent settle` +
                (guardSettleResult.persisted !== undefined
                  ? ` (persisted: '${guardSettleResult.persisted}')`
                  : '') +
                ' — chain advanced on the persisted outcome.',
            );
          }
          if (guardSettleResult.reason !== 'gate_open_wait') {
            // "quiet" end-of-pass for gate_open_wait only — nothing was decided, so nothing is
            // recorded; already_settled/divergence DID decide something (elsewhere), so it is.
            chainedSteps.push({ step: guardName, run_phase: guardSettleResult.run.run_phase });
          }
          run = guardSettleResult.run;
          // Drain: on already_settled ∧ pending ledger entries non-empty (design record §6, "same
          // clause" as the transitioned leg below) — recovers a crashed-drain RESOLVE that a
          // sibling's own settle committed but never drained.
          if (guardSettleResult.reason === 'already_settled') {
            const hasPending = Object.values(run.finalizer_ledger ?? {}).some(
              (e) => e.status === 'pending',
            );
            if (hasPending) {
              try {
                const drainOutcome = await drainFinalizers(
                  store,
                  definition,
                  options.registry,
                  options.runId,
                );
                run = drainOutcome.run;
                if (drainOutcome.warnings.length > 0) guardWarnings.push(...drainOutcome.warnings);
              } catch (err) {
                guardWarnings.push(
                  `post-commit finalizer drain failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }
          guardEligible = findEligibleGuardSteps(definition, run);
          continue;
        }
        if (guardSettleResult.reason === 'settled_outcome_divergence') {
          // ABORT leg only ⇒ report_to_user + chain-RETURN (design record §6/§7) — this attempt's
          // abort was never recorded.
          const err = new WorkflowError(
            `Guard step '${guardName}' was already settled` +
              (guardSettleResult.persisted !== undefined
                ? ` (persisted: '${guardSettleResult.persisted}')`
                : '') +
              ` by a different attempt — your abort was NOT recorded.`,
            {
              code: 'STATE_STEP_ALREADY_SETTLED',
              category: 'STATE',
              agentAction: 'report_to_user',
              retryable: false,
              details: {
                runId: options.runId,
                step: guardName,
                reason: guardSettleResult.reason,
                ...(guardSettleResult.persisted !== undefined
                  ? { persisted: guardSettleResult.persisted }
                  : {}),
              },
            },
          );
          return {
            command: options.command,
            run_id: options.runId,
            run_version: guardSettleResult.run.version,
            status: 'error',
            data: {},
            evidence: [],
            warnings: [],
            errors: [err.message],
            error_code: err.code,
            ...(Object.keys(err.details).length > 0 ? { error_details: err.details } : {}),
            agent_action: 'report_to_user',
            context_hint: err.message,
            run_phase: guardSettleResult.run.run_phase,
            next_actions: [],
          };
        }
        if (guardSettleResult.reason === 'run_terminal') {
          // Terminal by OTHER (a sibling settle raced this guard's own evaluation) — INLINE
          // construction, parity with the entry-terminal envelope (executeChain's own early
          // return).
          return {
            command: options.command,
            run_id: options.runId,
            run_version: guardSettleResult.run.version,
            status: 'ok',
            data: {},
            evidence: [],
            warnings: [],
            errors: [],
            agent_action: 'stop' as const,
            context_hint: `Run '${options.runId}' is already terminal (${guardSettleResult.run.run_phase}); guard '${guardName}' was not evaluated.`,
            run_phase: guardSettleResult.run.run_phase,
            next_actions: [],
          };
        }
        // gate_mismatch/choice_not_eligible/already_open/already_released and every other kind's
        // own reason are unreachable here — settle_guard never returns them (design record §7).
        throw new Error(
          `executeChainInternal: unreachable settle_guard refusal reason '${guardSettleResult.reason}'`,
        );
      }

      // applied: true.
      chainedSteps.push({ step: guardName, run_phase: guardSettleResult.run.run_phase });

      if (guardSettleResult.transitioned) {
        // Drain IMMEDIATELY after a transitioned settle result, BEFORE building the in-loop
        // terminal envelope (design record §6/R5 — a post-loop drain would be dead code on this
        // leg: this function RETURNS before ever reaching a post-loop point).
        let finalGuardRun = guardSettleResult.run;
        let guardDrainWarnings: string[];
        try {
          const drainOutcome = await drainFinalizers(
            store,
            definition,
            options.registry,
            options.runId,
          );
          finalGuardRun = drainOutcome.run;
          guardDrainWarnings = drainOutcome.warnings;
        } catch (err) {
          guardDrainWarnings = [
            `post-commit finalizer drain failed: ${err instanceof Error ? err.message : String(err)}`,
          ];
        }
        const migratedContextHint =
          guardSettleOutcome === 'abort'
            ? `Guard step '${guardName}' aborted the run.`
            : guardSettleOutcome === 'resolution_error'
              ? `Guard step '${guardName}' failed with a resolution error. Run is terminated.`
              : `Guard step '${guardName}' passed and completed the run.`;
        return {
          command: options.command,
          run_id: options.runId,
          run_version: finalGuardRun.version,
          status: 'ok',
          data: {},
          evidence: guardOwnEvidence,
          warnings: mergeWarnings(guardWarnings, ...guardDrainWarnings),
          errors: [],
          context_hint: migratedContextHint,
          run_phase: finalGuardRun.run_phase,
          next_actions: [],
          ...(finalGuardRun.defaulted_steps?.length
            ? { defaulted_steps: finalGuardRun.defaulted_steps }
            : {}),
        };
      }

      // Non-terminal pass — continue the chain.
      run = guardSettleResult.run;
      guardEligible = findEligibleGuardSteps(definition, run);
      continue;
    }

    // --- Legacy path (dormancy fallback — byte-identical to pre-#279 behavior) ---

    // Blocking fix #1: classify the terminal outcome by the SEALED record, not aborted_at
    // alone. executeGuardStep sets terminal_state in THREE cases — abort (aborted_at set),
    // resolution-error (failed, no aborted_at), and a PASS that completes the run
    // (terminal_reason 'Workflow completed.', no aborted_at). `aborted_at ? 'abort' : 'fail'`
    // would wrongly run the catch finalizers on that success. When terminal, drain the
    // matching finalizers before the single seal write; non-terminal guard passes persist as-is.
    const guardProse: 'complete' | 'fail' | 'abort' | undefined = guardResult.terminal_state
      ? guardResult.aborted_at !== undefined
        ? 'abort'
        : guardResult.terminal_reason === 'Workflow completed.'
          ? 'complete'
          : 'fail'
      : undefined;
    // issue #367: this classifier stays the PRODUCER of guardOutcome (it feeds buildFinalizedSeal,
    // so a wrong answer here silently drains the wrong finalizers — the executed harm). It now
    // prefers the RECORDED arm, keeps the prose branch as the fallback for an unstamped record,
    // and throws if the two disagree: a future writer gap here is loud, never a silent loss.
    const guardArmOutcome =
      guardResult.terminal_state && guardResult.sealed_by !== undefined
        ? armToOutcome(guardResult.sealed_by.arm)
        : undefined;
    if (guardArmOutcome === 'abandon') {
      throw new Error(`guard seal on '${guardName}' produced a non-guard arm`);
    }
    if (
      guardArmOutcome !== undefined &&
      guardProse !== undefined &&
      guardArmOutcome !== guardProse
    ) {
      throw new Error(
        `sealed_by.arm (${guardArmOutcome}) disagrees with the prose classifier (${guardProse}) ` +
          `on guard '${guardName}'`,
      );
    }
    const guardOutcome: 'complete' | 'fail' | 'abort' | undefined = guardArmOutcome ?? guardProse;
    // issue #220 PR-2 (D6): stamp defaulted_steps ONLY on the 'complete' seal — a guard that FAILS
    // or ABORTS the run does not get the qualifier (the FM-5 guard: never on a non-complete
    // terminal, and never on the non-terminal `guardResult` passthrough).
    const guardSealed =
      guardOutcome === 'complete'
        ? stampDefaultedSteps(
            await buildFinalizedSeal(definition, guardResult, guardOutcome, options.registry),
          )
        : guardOutcome !== undefined
          ? await buildFinalizedSeal(definition, guardResult, guardOutcome, options.registry)
          : guardResult;
    // issue #220 PR-2 (D6 write-site consumer): see the Step-6 twin above.
    const guardDefaultedStepsDurabilityWarning =
      guardSealed.defaulted_steps !== undefined &&
      guardSealed.defaulted_steps.length > 0 &&
      !persistsField(store, 'defaulted_steps')
        ? 'run-level defaultedness marker (defaulted_steps) not durable on this store'
        : undefined;

    // Persist the guard step result.
    let persistedGuardRun: RunRecord;
    try {
      persistedGuardRun = await store.update(guardSealed);
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
        run_phase: run.run_phase,
        next_actions: [],
      };
    }

    // Record in chained_auto_steps for visibility.
    chainedSteps.push({ step: guardName, run_phase: persistedGuardRun.run_phase });

    if (persistedGuardRun.terminal_state) {
      // Run is terminal via this guard. Adjacent pre-existing bug fixed: a PASSING guard that
      // COMPLETES the run was mislabeled "failed with a resolution error" — describe each of
      // the three terminal outcomes correctly (classified by guardOutcome, not aborted_at alone).
      const contextHint =
        guardOutcome === 'abort'
          ? `Guard step '${guardName}' aborted the run.`
          : guardOutcome === 'complete'
            ? `Guard step '${guardName}' passed and completed the run.`
            : `Guard step '${guardName}' failed with a resolution error. Run is terminated.`;
      return {
        command: options.command,
        run_id: options.runId,
        run_version: persistedGuardRun.version,
        status: 'ok',
        data: {},
        // The guard's own evidence entry, captured before the finalizer drain appended any.
        evidence: guardOwnEvidence,
        // issue #279 (increment 2, PR-D): + the ONE dormancy advisory (I16) — this IS the legacy
        // path (store.settleStep undeclared).
        warnings: mergeWarnings([], guardDefaultedStepsDurabilityWarning, DORMANCY_ADVISORY),
        errors: [],
        context_hint: contextHint,
        run_phase: persistedGuardRun.run_phase,
        next_actions: [],
        // issue #220 PR-2 (D6): read off `guardSealed` — the stamped PRE-PERSIST record — never
        // the round-tripped `persistedGuardRun`, so a non-persisting store can't silently drop it.
        ...(guardSealed.defaulted_steps?.length
          ? { defaulted_steps: guardSealed.defaulted_steps }
          : {}),
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
      // issue #279 (increment 2, PR-D): non-abort settled_outcome_divergence warnings accumulated
      // during the guard loop above (the ADVANCE leg) must reach whichever envelope returns —
      // this rebuild is the first point after the loop `result` is touched again.
      ...(guardWarnings.length > 0
        ? { warnings: mergeWarnings(result.warnings, ...guardWarnings) }
        : {}),
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

  // issue #197 PR-2 (chain-replacement disposition): THIS step's own result is about to be
  // discarded in favor of the recursive call's — capture its warnings now, before that happens.
  // Every step past depth 0 in this recursion is guaranteed 'auto' (nextAutoStep's own filter),
  // so depth === 0 is the ONLY case where a non-auto (agent) step's warnings would otherwise be
  // lost here (an 'auto' depth-0 step's warnings are already captured above via `chainedSteps`,
  // so this would double them — the `depth === 0` guard is exact, not merely conservative:
  // `chainedSteps` only records 'auto' steps, so a depth-0 'auto' step's warnings are recorded
  // there, never here, avoiding any double-count).
  if (
    depth === 0 &&
    definition.steps[options.command]?.execution !== 'auto' &&
    result.warnings.length > 0
  ) {
    depth0Warnings.push(...result.warnings);
  }

  return executeChainInternal(
    store,
    definition,
    { ...options, command: nextAutoStep, input: {} },
    depth + 1,
    chainedSteps,
    depth0Warnings,
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
  // Defense-in-depth: never drive a run that is already terminal. The eligibility guard
  // (findEligibleSteps) makes this unreachable in normal operation, but guarding the chain
  // boundary protects every executeChain caller regardless of how it reached here. Placed in the
  // public wrapper so it fires exactly once at entry; recursive depth>0 calls and runs that become
  // terminal mid-chain are covered by the existing mid-chain check in executeChainInternal.
  let entryRun: RunRecord | undefined;
  try {
    entryRun = await store.get(options.runId);
  } catch (err) {
    // issue #183: the store layer no longer conflates absence with unreachability — store.get()
    // now throws a typed I/O error (rather than mapping it to STATE_RUN_NOT_FOUND) when the run
    // record exists but can't actually be read. Swallow ONLY the expected "doesn't exist" case
    // and fall through to the normal path (which re-attempts the read and surfaces its own
    // properly-typed ENGINE_STORE_FAILED); re-throw everything else immediately rather than
    // silently treating a real I/O failure as "the run doesn't exist."
    if (err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND') {
      entryRun = undefined;
    } else {
      throw err;
    }
  }
  // issue #279 (increment 2, PR-C — D-3 leg v): keyed on terminal_state, never the persisted
  // run_phase — a grandfathered terminal-with-stale-gate record (the #282 class) must still be
  // recognized as terminal here.
  if (entryRun !== undefined && entryRun.terminal_state === true) {
    // Derive-for-message (D-3 leg v): render the TRUE (derived) phase, never the possibly-stale
    // persisted one.
    const derivedPhase = deriveRunPhase(entryRun);
    return {
      command: options.command,
      run_id: options.runId,
      run_version: entryRun.version,
      status: 'ok',
      data: {},
      evidence: [],
      warnings: [],
      errors: [],
      agent_action: 'stop' as const,
      context_hint: `Run '${options.runId}' is already terminal (${derivedPhase}); no steps executed.`,
      run_phase: derivedPhase,
      next_actions: [],
    };
  }

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
  // issue #197 PR-2 (chain-replacement disposition) — see executeChainInternal's own doc on this
  // parameter for the full contract.
  const depth0Warnings: string[] = [];
  const result = await executeChainInternal(
    store,
    definition,
    effectiveOptions,
    0,
    chained,
    depth0Warnings,
  );
  const chainWarnings = [...depth0Warnings, ...chained.flatMap((s) => s.warnings ?? [])];
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
