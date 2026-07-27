// start-run tool — creates a new run and chains through initial auto steps.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  executeChain,
  buildNextActions,
  findEligibleSteps,
  hashParams,
  WorkflowError,
  buildPreExecutionErrorEnvelope,
  unmetCapabilities,
  capabilityWarning,
  createDefaultRegistry,
  deriveRunPhase,
  type StepDispatcher,
  type ResponseEnvelope,
  type RunStore,
  type TraceBufferStore,
  type FailedAttemptStore,
  ExtensionRegistry,
} from '@sensigo/realm';
import { sseJsonStringify } from '../sse-json.js';

/** Lightweight structured telemetry. stderr is safe under the MCP stdio/SSE transport. */
function logDedup(fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event: 'idempotency_dedup', ...fields }));
}

/**
 * Structural (not nominal) shape of `FailedAttemptStore`'s public surface, derived via `Pick` so a
 * duck-typed cloud-backed object can satisfy it too — the concrete `FailedAttemptStore` class has
 * a private `runsDir` field, so a plain object literal implementing these methods could never be
 * assignable to the class type itself (issue #188, PR-1: the co-location injection seam). Used
 * anywhere a `FailedAttemptStore`-like store is threaded through as an injectable option.
 */
export type FailedAttemptStoreLike = Pick<
  FailedAttemptStore,
  'append' | 'read' | 'deleteAllForRun' | 'listOrphans'
>;

export interface HandleRunStores {
  /** Run store. Any `RunStore` implementation (issue #188, PR-1 — was `JsonFileStore`-only). */
  runStore?: RunStore;
  workflowStore?: JsonWorkflowStore;
  /** Extension registry for resolving service adapters and step handlers. */
  registry?: ExtensionRegistry;
  /**
   * Per-definition registry resolution (project extensions). Awaited BEFORE `runStore.create`
   * (a throwing provider means no run is created) and before execution in execute_step.
   * Wins over `registry` when both are supplied.
   */
  registryProvider?: (
    definition: import('@sensigo/realm').WorkflowDefinition,
  ) => Promise<ExtensionRegistry>;
  /** Trace buffer store for incremental WAL-based trace ingestion (B-lite). */
  traceBufferStore?: TraceBufferStore;
  /** Durable per-run sidecar for failed agent-attempt telemetry (observability P3). */
  failedAttemptStore?: FailedAttemptStoreLike;
}

// Fallback dispatcher for agent steps and auto steps without a registry entry.
const passthroughDispatcher: StepDispatcher = async () => ({});

/**
 * Business logic for the start_run tool.
 * Creates a run and immediately chains through any leading auto steps.
 */
export async function handleStartRun(
  args: {
    workflow_id: string;
    params?: Record<string, unknown>;
    idempotency_key?: string | undefined;
    on_terminal_match?: 'reuse' | 'reject' | 'rerun_if_failed' | 'rerun' | undefined;
    on_live_match?: 'use_existing' | 'fail' | undefined;
  },
  stores?: HandleRunStores,
): Promise<ResponseEnvelope & { deduped: boolean }> {
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  const definition = await workflowStore.get(args.workflow_id);
  const params = args.params ?? {};

  // Resolve the effective registry BEFORE run creation — a throwing registryProvider must
  // fail this tool call with NO run created. Provider wins over construction-time registry.
  const registry =
    stores?.registryProvider !== undefined
      ? await stores.registryProvider(definition)
      : stores?.registry;

  const { run, created } = await runStore.create({
    workflowId: definition.id,
    workflowVersion: definition.version,
    params,
    ...(args.idempotency_key !== undefined ? { idempotencyKey: args.idempotency_key } : {}),
    ...(args.on_terminal_match !== undefined ? { onTerminalMatch: args.on_terminal_match } : {}),
    ...(args.on_live_match !== undefined ? { onLiveMatch: args.on_live_match } : {}),
  });
  // The store reports `created`; the tool surfaces its inverse, `deduped`.
  const deduped = !created;
  // issue #279 (increment 2, PR-C — D-3 leg vi): the start_run REUSE surfaces — a deduped match
  // can hit a GRANDFATHERED terminal-with-stale-gate record (the #282 class), never a freshly
  // created one, so this is where the persisted `run_phase` can actually be stale.
  const derivedPhase = deriveRunPhase(run);

  // #134 pre-flight (WARN-only, never refuse): if the effective registry can't satisfy the workflow's
  // auto-step handlers/adapters, warn so the operator can provision before a step blocks recoverably.
  // The `?? createDefaultRegistry()` fallback is a HARD invariant — it mirrors the dispatch sites, so a
  // filesystem-only workflow with no supplied registry does not false-warn.
  const warnings: string[] = unmetCapabilities(definition, registry ?? createDefaultRegistry()).map(
    capabilityWarning,
  );
  if (deduped) {
    // Observational only — a legitimate same-caller retry also hits an active run. Keyed on
    // terminal_state, never the persisted run_phase.
    if (!run.terminal_state) {
      warnings.push(`Idempotency key matched a run still in phase '${derivedPhase}'.`);
    }
    // PR 1 warns on a key↔payload mismatch; PR 2 may make this policy.
    if (args.idempotency_key !== undefined && hashParams(params) !== hashParams(run.params)) {
      warnings.push(
        `Idempotency key matched an existing run created with different params; the original run is returned unchanged (params not updated).`,
      );
    }
    // issue #279 (increment 1, PR-B), design record §6: pending-drain is DISCLOSURE ONLY here —
    // it never feeds decideIdempotencyPolicy's own decision (that pure function's domain is
    // unchanged); a 'reuse' match on a terminal run with undelivered finalizers just gets one
    // extra advisory line pointing at the recovery verb.
    const pendingFinalizerCount = Object.values(run.finalizer_ledger ?? {}).filter(
      (e) => e.status === 'pending',
    ).length;
    if (run.terminal_state && pendingFinalizerCount > 0) {
      warnings.push(
        `completion recorded; ${pendingFinalizerCount} finalizer(s) not yet delivered — realm run drain ${run.id}`,
      );
    }
    logDedup({
      tool: 'start_run',
      workflow_id: definition.id,
      run_id: run.id,
      run_phase: derivedPhase,
    });
  }

  const eligible = findEligibleSteps(definition, run);
  const firstAutoStep = eligible.find((name) => definition.steps[name]?.execution === 'auto');

  if (firstAutoStep !== undefined) {
    const result = await executeChain(runStore, definition, {
      runId: run.id,
      command: firstAutoStep,
      input: params,
      dispatcher: passthroughDispatcher,
      ...(registry !== undefined ? { registry } : {}),
    });
    // Source run_phase from the final run so the spread can't drop it.
    const finalRun = await runStore.get(run.id).catch(() => run);
    return {
      ...result,
      run_id: run.id,
      data: {},
      evidence: [],
      run_phase: finalRun.run_phase,
      warnings: [...result.warnings, ...warnings],
      deduped,
    };
  }

  const nextActions = buildNextActions(definition, run);
  return {
    command: 'start_run',
    run_id: run.id,
    run_version: run.version,
    status: 'ok',
    data: {},
    evidence: [],
    warnings,
    errors: [],
    context_hint: deduped
      ? `Matched existing run '${run.id}' (idempotent) in phase '${derivedPhase}'; no new run created.`
      : `Run '${run.id}' created for workflow '${definition.id}'.`,
    run_phase: derivedPhase,
    deduped,
    next_actions: nextActions,
  };
}

/** Registers the start_run MCP tool on the server. */
export function registerStartRun(server: McpServer, opts?: HandleRunStores): void {
  server.tool(
    'start_run',
    'Create a new workflow run and chain through initial auto steps.',
    {
      workflow_id: z.string(),
      params: z.record(z.unknown()).optional().default({}),
      idempotency_key: z.string().optional(),
      on_terminal_match: z.enum(['reuse', 'reject', 'rerun_if_failed', 'rerun']).optional(),
      on_live_match: z.enum(['use_existing', 'fail']).optional(),
    },
    async (args) => {
      try {
        const result = await handleStartRun(args, opts);
        // Override command to 'start_run': MCP callers invoked start_run, not
        // the first auto step that executeChain may have executed.
        return {
          content: [
            {
              type: 'text' as const,
              text: sseJsonStringify({ ...result, command: 'start_run' }),
            },
          ],
        };
      } catch (err) {
        const workflowErr =
          err instanceof WorkflowError
            ? err
            : new WorkflowError(err instanceof Error ? err.message : String(err), {
                code: 'ENGINE_INTERNAL',
                category: 'ENGINE',
                agentAction: 'stop',
                retryable: false,
              });
        const contextHint =
          workflowErr.code === 'STATE_WORKFLOW_NOT_FOUND'
            ? `Workflow '${args.workflow_id}' not found.`
            : `An error occurred before the run could be started.`;
        const envelope: ResponseEnvelope = buildPreExecutionErrorEnvelope(
          'start_run',
          '',
          0,
          workflowErr,
          contextHint,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: sseJsonStringify(envelope),
            },
          ],
        };
      }
    },
  );
}
