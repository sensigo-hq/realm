// execute-step tool — executes a named step in a workflow run.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  executeChain,
  type StepDispatcher,
  type ResponseEnvelope,
  type AgentTraceEntry,
} from '@sensigo/realm';
import type { HandleRunStores } from './start-run.js';

/** Zod schema for a single agent trace entry submitted to execute_step. */
const traceEntrySchema = z.object({
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

  return executeChain(runStore, definition, {
    runId: args.run_id,
    command: args.command,
    input: params,
    dispatcher: makeParamsDispatcher(params),
    ...(stores?.registry !== undefined ? { registry: stores.registry } : {}),
    ...(stores?.secrets !== undefined ? { secrets: stores.secrets } : {}),
    // trace is a top-level execute_step field — never embedded in params.
    ...(args.trace !== undefined ? { trace: args.trace } : {}),
  });
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
          text: JSON.stringify({ ...result, data: {}, evidence: [] }, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              command: args.command,
              run_id: args.run_id,
              run_version: 0,
              status: 'error',
              data: {},
              evidence: [],
              warnings: [],
              errors: [message],
              agent_action: 'stop',
              context_hint: `Error executing step '${args.command}' for run '${args.run_id}'.`,
              next_actions: [],
            },
            null,
            2,
          ),
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
