// execute-step tool — executes a named step in a workflow run.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  executeChain,
  WorkflowError,
  buildPreExecutionErrorEnvelope,
  buildFailedAttemptRecord,
  serializeFailedAttemptLine,
  type StepDispatcher,
  type ResponseEnvelope,
  type AgentTraceEntry,
  type FailedAttemptStore,
} from '@sensigo/realm';
import type { HandleRunStores } from './start-run.js';
import { sseJsonStringify } from '../sse-json.js';

/**
 * Pre-claim validation rejections carry one of these error codes (claimStep runs strictly after all
 * three schema gates, so they never reach failed_steps[] / never bump version — a write-free path).
 * Failed agent attempts on these codes are surfaced as stderr telemetry below.
 */
const VALIDATION_TELEMETRY_CODES = new Set([
  'VALIDATION_INPUT_SCHEMA',
  'VALIDATION_OUTPUT_SCHEMA',
  'VALIDATION_TRACE_SCHEMA',
]);

/**
 * Best-effort, metadata-only telemetry for a failed agent-step validation attempt. On a (pre-strip)
 * validation rejection it fans the same record out to two INDEPENDENT sinks: an ephemeral stderr line
 * (P2) and a durable per-run sidecar (P3, when a store is wired). Each sink is separately guarded so a
 * throw in one cannot suppress the other; the whole thing never throws and never alters the
 * execute_step response.
 */
async function emitFailedAttemptTelemetry(
  args: {
    run_id: string;
    command: string;
    params?: Record<string, unknown>;
    trace?: AgentTraceEntry[] | undefined;
  },
  workflowId: string,
  result: ResponseEnvelope,
  failedAttemptStore?: FailedAttemptStore,
): Promise<void> {
  // Build the shared metadata-only record once (bail both sinks if it can't be built).
  let record: ReturnType<typeof buildFailedAttemptRecord>;
  try {
    if (result.status !== 'error') return;
    const code = result.error_code;
    if (code === undefined || !VALIDATION_TELEMETRY_CODES.has(code)) return;
    const ajvErrors = result.error_details?.['errors'];
    record = buildFailedAttemptRecord({
      run_id: args.run_id,
      workflow_id: workflowId,
      step_id: args.command,
      ts: new Date().toISOString(),
      error_code: code,
      ajv_errors: Array.isArray(ajvErrors) ? ajvErrors : [],
      params: args.params ?? {},
      trace_entry_count: args.trace?.length ?? 0,
    });
  } catch {
    return;
  }

  // Sink 1 (P2): ephemeral stderr line — keeps the `event` tag. Independent best-effort.
  try {
    console.error(
      serializeFailedAttemptLine({ event: 'agent_step_attempt_failed', ...record }).line,
    );
  } catch {
    // never let a stderr failure suppress the sidecar append
  }

  // Sink 2 (P3): durable sidecar — the file IS the event stream, so the line OMITS the `event` tag.
  // Independent best-effort; the store's append already swallows its own I/O errors.
  if (failedAttemptStore !== undefined) {
    try {
      const serialized = serializeFailedAttemptLine({ ...record });
      // Fold the truncation flag into the persisted record when the serializer had to reduce.
      const line = serialized.truncated
        ? serializeFailedAttemptLine({ ...record, truncated: true }).line
        : serialized.line;
      await failedAttemptStore.append(args.run_id, line);
    } catch {
      // never let a sidecar failure suppress the stderr emit (already done) or the response
    }
  }
}

/** Zod schema for a single agent trace entry submitted to execute_step or append_trace. */
export const traceEntrySchema = z.object({
  event: z.string(),
  timestamp: z.string().optional(),
  data: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

// For agent steps, the agent's params represent their work output. The dispatcher
// passes them through as the step output recorded in evidence.
const makeParamsDispatcher =
  (params: Record<string, unknown>): StepDispatcher =>
  async () =>
    params;

/**
 * Business logic for the execute_step tool.
 * Validates eligibility, claims the step, and records the agent's params as step output.
 */
export async function handleExecuteStep(
  args: {
    run_id: string;
    command: string;
    params?: Record<string, unknown>;
    trace?: AgentTraceEntry[] | undefined;
  },
  stores?: HandleRunStores,
): Promise<ResponseEnvelope> {
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  const run = await runStore.get(args.run_id);
  const definition = await workflowStore.get(run.workflow_id);
  const params = args.params ?? {};

  const result = await executeChain(runStore, definition, {
    runId: args.run_id,
    command: args.command,
    input: params,
    dispatcher: makeParamsDispatcher(params),
    ...(stores?.registry !== undefined ? { registry: stores.registry } : {}),
    ...(stores?.secrets !== undefined ? { secrets: stores.secrets } : {}),
    // trace is a top-level execute_step field — never embedded in params.
    ...(args.trace !== undefined ? { trace: args.trace } : {}),
    // Pass WAL buffer store so execution loop can merge and clean up the WAL.
    ...(stores?.traceBufferStore !== undefined
      ? { traceBufferStore: stores.traceBufferStore }
      : {}),
  });

  // P2/P3 observability: on a pre-claim validation rejection, fan a metadata-only record out to the
  // ephemeral stderr line (P2) and the durable per-run sidecar (P3, when wired). Reads the pre-strip
  // envelope; awaited but best-effort — it never throws and never alters the response.
  await emitFailedAttemptTelemetry(args, run.workflow_id, result, stores?.failedAttemptStore);

  return result;
}

/**
 * MCP-layer wrapper around handleExecuteStep.
 * Returns the tool content format used by the MCP server (content array with text JSON).
 * Exported for direct testing of the MCP response shape.
 */
export async function handleExecuteStepTool(
  args: {
    run_id: string;
    command: string;
    params?: Record<string, unknown>;
    trace?: AgentTraceEntry[] | undefined;
  },
  stores?: HandleRunStores,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const result = await handleExecuteStep(args, stores);
    return {
      content: [
        {
          type: 'text' as const,
          text: sseJsonStringify({ ...result, data: {}, evidence: [] }),
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
        ? `Workflow definition for run '${args.run_id}' not found.`
        : workflowErr.code === 'STATE_RUN_NOT_FOUND'
          ? `Run '${args.run_id}' not found.`
          : `An error occurred before step '${args.command}' could begin.`;
    const envelope: ResponseEnvelope = buildPreExecutionErrorEnvelope(
      args.command,
      args.run_id,
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
}

/** Registers the execute_step MCP tool on the server. */
export function registerExecuteStep(
  server: McpServer,
  opts?: {
    registry?: import('@sensigo/realm').ExtensionRegistry;
    secrets?: Record<string, string>;
    traceBufferStore?: import('@sensigo/realm').TraceBufferStore;
    failedAttemptStore?: FailedAttemptStore;
  },
): void {
  server.tool(
    'execute_step',
    'Execute a workflow step. For agent steps, pass your output in params.',
    {
      run_id: z.string(),
      command: z.string(),
      params: z.record(z.unknown()).optional().default({}),
      trace: z.array(traceEntrySchema).optional(),
    },
    async (args) => {
      return handleExecuteStepTool(args, opts);
    },
  );
}
