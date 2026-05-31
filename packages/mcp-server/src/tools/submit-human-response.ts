// submit-human-response tool — advances a gate-waiting run with a human choice.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  submitHumanResponse,
  WorkflowError,
  buildPreExecutionErrorEnvelope,
  type ResponseEnvelope,
} from '@sensigo/realm';
import type { HandleRunStores } from './start-run.js';

/**
 * Business logic for the submit_human_response tool.
 * Validates the gate_id and choice, then advances the run past the gate.
 */
export async function handleSubmitHumanResponse(
  args: { run_id: string; gate_id: string; choice: string },
  stores?: HandleRunStores,
): Promise<ResponseEnvelope> {
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  const run = await runStore.get(args.run_id);
  const definition = await workflowStore.get(run.workflow_id);

  return submitHumanResponse(runStore, definition, {
    runId: args.run_id,
    gateId: args.gate_id,
    choice: args.choice,
  });
}

/** Registers the submit_human_response MCP tool on the server. */
export function registerSubmitHumanResponse(server: McpServer, opts?: HandleRunStores): void {
  server.tool(
    'submit_human_response',
    "Advance a gate-waiting run by submitting the human's choice.",
    {
      run_id: z.string(),
      gate_id: z.string(),
      choice: z.string(),
    },
    async (args) => {
      try {
        const result = await handleSubmitHumanResponse(args, opts);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...result, data: {}, evidence: [] }, null, 2),
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
              : `An error occurred before gate response could be submitted.`;
        const envelope: ResponseEnvelope = buildPreExecutionErrorEnvelope(
          'submit_human_response',
          args.run_id,
          0,
          workflowErr,
          contextHint,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(envelope, null, 2),
            },
          ],
        };
      }
    },
  );
}
