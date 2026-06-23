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
  type StepDispatcher,
  type ResponseEnvelope,
  type TraceBufferStore,
  ExtensionRegistry,
} from '@sensigo/realm';
import { sseJsonStringify } from '../sse-json.js';

/** Lightweight structured telemetry. stderr is safe under the MCP stdio/SSE transport. */
function logDedup(fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event: 'idempotency_dedup', ...fields }));
}

export interface HandleRunStores {
  runStore?: JsonFileStore;
  workflowStore?: JsonWorkflowStore;
  /** Extension registry for resolving service adapters and step handlers. */
  registry?: ExtensionRegistry;
  /** Resolved secrets for use by service adapters. */
  secrets?: Record<string, string>;
  /** Trace buffer store for incremental WAL-based trace ingestion (B-lite). */
  traceBufferStore?: TraceBufferStore;
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
  },
  stores?: HandleRunStores,
): Promise<ResponseEnvelope & { deduped: boolean }> {
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  const definition = await workflowStore.get(args.workflow_id);
  const params = args.params ?? {};

  const { run, created } = await runStore.create({
    workflowId: definition.id,
    workflowVersion: definition.version,
    params,
    ...(args.idempotency_key !== undefined ? { idempotencyKey: args.idempotency_key } : {}),
  });
  // The store reports `created`; the tool surfaces its inverse, `deduped`.
  const deduped = !created;

  const warnings: string[] = [];
  if (deduped) {
    // Observational only — a legitimate same-caller retry also hits an active run.
    if (run.run_phase === 'running' || run.run_phase === 'gate_waiting') {
      warnings.push(`Idempotency key matched a run still in phase '${run.run_phase}'.`);
    }
    // PR 1 warns on a key↔payload mismatch; PR 2 may make this policy.
    if (args.idempotency_key !== undefined && hashParams(params) !== hashParams(run.params)) {
      warnings.push(
        `Idempotency key matched an existing run created with different params; the original run is returned unchanged (params not updated).`,
      );
    }
    logDedup({
      tool: 'start_run',
      workflow_id: definition.id,
      run_id: run.id,
      run_phase: run.run_phase,
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
      ...(stores?.registry !== undefined ? { registry: stores.registry } : {}),
      ...(stores?.secrets !== undefined ? { secrets: stores.secrets } : {}),
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
      ? `Matched existing run '${run.id}' (idempotent) in phase '${run.run_phase}'; no new run created.`
      : `Run '${run.id}' created for workflow '${definition.id}'.`,
    run_phase: run.run_phase,
    deduped,
    next_actions: nextActions,
  };
}

/** Registers the start_run MCP tool on the server. */
export function registerStartRun(
  server: McpServer,
  opts?: {
    registry?: import('@sensigo/realm').ExtensionRegistry;
    secrets?: Record<string, string>;
  },
): void {
  server.tool(
    'start_run',
    'Create a new workflow run and chain through initial auto steps.',
    {
      workflow_id: z.string(),
      params: z.record(z.unknown()).optional().default({}),
      idempotency_key: z.string().optional(),
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
