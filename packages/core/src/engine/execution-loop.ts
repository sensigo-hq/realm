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
} from '../types/run-record.js';
import type { ToolCallRecord } from '../types/mcp-types.js';
import { extensionIdentityDiffers } from '../types/extension-identity.js';
import type { ResponseEnvelope, NextAction } from '../types/response-envelope.js';
import { WorkflowError } from '../types/workflow-error.js';
import type {
  WorkflowDefinition,
  StepDefinition,
  FinalizerTrigger,
  ContextWrapperFormat,
  InputMapNode,
  LiteralNode,
} from '../types/workflow-definition.js';
import type { RunStore } from '../store/store-interface.js';
import { persistsField } from '../store/store-fidelity.js';
import type { TraceBufferStore, BufferedEntry } from '../store/trace-buffer-store.js';
import { storeDeclaresSeal, storeDeclaresNonceCarriage } from '../store/trace-buffer-store.js';
import { partitionBufferedEntries, type BufferedEntryPartition } from './trace-adoption.js';
import { captureEvidence } from '../evidence/snapshot.js';
import {
  validateInputSchema,
  validateOutputSchema,
  validateTraceSchema,
} from '../validation/input-schema.js';
import { normalizeTrace } from './trace-normalizer.js';
import type { NormalizeTraceResult } from './trace-normalizer.js';
import { TERMINAL_PHASES, isTerminalPhase, DRAIN_CEILING_SECONDS } from './lifecycle.js';
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
   */
  stepMeta?: { toolCalls?: ToolCallRecord[] };
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
  const auditEvidence = captureEvidence({
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

  // Step 2d: PRE-claim WAL read — issue #185 Fix 2: this read serves the enforce-gate ONLY.
  // Schema validation stays pre-claim so an invalid trace still doesn't consume a claim. The
  // trace actually CAPTURED into evidence is built from a fresh POST-claim re-read further below
  // (once the claim below freezes appends) — see that block's comment for why: a concurrent
  // append_trace landing in the narrow window between this read and the claim would otherwise
  // never be adopted, then be silently destroyed when the WAL is deleted at settlement (issue
  // #185 Finding 2). A rare line landing in exactly that window bypasses THIS enforce check —
  // documented, accepted (see the post-claim block).
  //
  // walEntries is declared at this outer scope because it is REASSIGNED to the post-claim read
  // below and referenced at the captureEvidence call site further down this function.
  const traceWarnings: string[] = [];
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
            return makeErrorEnvelope(options, run, err as WorkflowError, definition);
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
          run_phase: freshRun.run_phase,
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
      try {
        await store.update(buildCompensatingUnclaim(pendingRun, options.command, new Date()));
      } catch {
        // CAS mismatch (someone else already resolved the claim) or any other failure to even
        // un-claim: stop immediately, leave the claim exactly as it is — never retry here.
      }
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
        traceWarnings.length > 0 ? traceWarnings : undefined,
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
  let attemptsUsed = 0;
  const allEvidence: EvidenceSnapshot[] = [];
  let currentWarn: string | undefined;

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
          warnings: mergeWarnings(traceWarnings),
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

  if (
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

      let persistedBlockedRun: RunRecord | undefined;
      let blockStoreWarning: string | undefined;
      try {
        persistedBlockedRun = await store.update(blockedRun);
      } catch (storeErr) {
        blockStoreWarning = `Failed to persist capability block: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`;
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
        warnings: mergeWarnings(traceWarnings, blockStoreWarning),
        errors: [dispatchError.message],
        agent_action: blockedAction,
        error_code: recoverableCode,
        context_hint: `Step '${options.command}' is blocked: its ${reqLabel} is not registered in this runner. The run is NOT terminated — the step remains eligible, so a runner that provides this ${requirement?.kind ?? 'capability'} can execute it. Provision this runner (or re-run on a capable one), then follow next_actions.`,
        run_phase: (persistedBlockedRun ?? blockedRun).run_phase,
        next_actions: blockedNextActions,
      };
    }

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
    const failDraft: RunRecord = {
      ...withSkippedFail,
      evidence: [...pendingRun.evidence, ...allEvidence],
      terminal_state: isComplete,
      ...(isComplete
        ? { terminal_reason: `Step '${options.command}' failed: ${dispatchError.message}` }
        : {}),
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
      warnings: mergeWarnings(traceWarnings, storeCleanupWarning ?? walCleanupWarning),
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
      run_phase: gateRun.run_phase,
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
  const completeDraft: RunRecord = {
    ...withSkippedComplete,
    terminal_state: isComplete,
    ...(isComplete ? { terminal_reason: `Workflow completed.` } : {}),
  };
  // On the terminal transition, drain the complete/always finalizers before the single seal.
  const finalRun: RunRecord = isComplete
    ? await buildFinalizedSeal(definition, completeDraft, 'complete', options.registry)
    : completeDraft;

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
    warnings: mergeWarnings(traceWarnings, currentWarn, successWalCleanupWarning),
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
  const gateDraft: RunRecord = {
    ...withSkippedGate,
    terminal_state: isComplete,
    ...(isComplete ? { terminal_reason: `Workflow completed.` } : {}),
  };
  // On the gate-completion terminal transition, drain complete/always finalizers before seal.
  const finalRun: RunRecord = isComplete
    ? await buildFinalizedSeal(definition, gateDraft, 'complete', options.registry)
    : gateDraft;

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
    warnings: [],
    errors: [],
    context_hint: orientation,
    run_phase: savedRun.run_phase,
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
    const resolutionErrorPropagated = propagateSkips(withFailed, definition);
    const withSkipped: RunRecord = {
      ...withFailed,
      skipped_steps: resolutionErrorPropagated.skipped,
      skip_details: resolutionErrorPropagated.details,
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
    aborted_at: {
      step_id: stepName,
      conditions: outcome.conditions,
      ...(stepDef.abort_message !== undefined ? { abort_message: stepDef.abort_message } : {}),
    },
  };
}

/** Normalizes a finalizer's `on_outcome` to a set of triggers. */
function finalizerTriggers(stepDef: StepDefinition): Set<FinalizerTrigger> {
  const raw = stepDef.on_outcome;
  if (raw === undefined) return new Set();
  return new Set(Array.isArray(raw) ? raw : [raw]);
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
 * `aborted_at`, `terminal_reason`, `terminal_state`, `skipped_steps`, or emits next_actions —
 * the terminal marks come from `sealDraft` and `deriveRunPhase` precedence keeps the phase.
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

  const settled = new Set([...sealDraft.completed_steps, ...sealDraft.failed_steps]);
  const groupA: Array<[string, StepDefinition]> = [];
  const groupB: Array<[string, StepDefinition]> = [];
  for (const [name, step] of Object.entries(definition.steps)) {
    if (step.execution !== 'finalizer') continue;
    if (settled.has(name)) continue; // at-most-once per run (resume / re-drive safety)
    const triggers = finalizerTriggers(step);
    if (triggers.has(outcome)) groupA.push([name, step]);
    else if (triggers.has('always')) groupB.push([name, step]);
  }

  let record = sealDraft;
  for (const [name, step] of [...groupA, ...groupB]) {
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
        // A finalizer handler returning { abort } is a recorded NON-FATAL failure — it must
        // never mutate aborted_at/terminal_reason (that would corrupt the sealed outcome).
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

  return { ...record, terminal_state: true };
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
  let guardEligible = findEligibleGuardSteps(definition, run);
  while (guardEligible.length > 0) {
    const guardName = guardEligible[0]!;
    const guardStepDef = definition.steps[guardName]!;

    // Execute inline (pure in-memory; returns updated RunRecord).
    const guardResult = await executeGuardStep(guardName, guardStepDef, definition, run);

    // Capture the guard's OWN evidence (its last entry) BEFORE the finalizer drain appends
    // finalizer evidence — the terminal return below surfaces only the guard's evidence.
    const guardOwnEvidence = guardResult.evidence.slice(-1);

    // Blocking fix #1: classify the terminal outcome by the SEALED record, not aborted_at
    // alone. executeGuardStep sets terminal_state in THREE cases — abort (aborted_at set),
    // resolution-error (failed, no aborted_at), and a PASS that completes the run
    // (terminal_reason 'Workflow completed.', no aborted_at). `aborted_at ? 'abort' : 'fail'`
    // would wrongly run the catch finalizers on that success. When terminal, drain the
    // matching finalizers before the single seal write; non-terminal guard passes persist as-is.
    const guardOutcome: 'complete' | 'fail' | 'abort' | undefined = guardResult.terminal_state
      ? guardResult.aborted_at !== undefined
        ? 'abort'
        : guardResult.terminal_reason === 'Workflow completed.'
          ? 'complete'
          : 'fail'
      : undefined;
    const guardSealed =
      guardOutcome !== undefined
        ? await buildFinalizedSeal(definition, guardResult, guardOutcome, options.registry)
        : guardResult;

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
        warnings: [],
        errors: [],
        context_hint: contextHint,
        run_phase: persistedGuardRun.run_phase,
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
  if (entryRun !== undefined && isTerminalPhase(entryRun.run_phase)) {
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
      context_hint: `Run '${options.runId}' is already terminal (${entryRun.run_phase}); no steps executed.`,
      run_phase: entryRun.run_phase,
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
