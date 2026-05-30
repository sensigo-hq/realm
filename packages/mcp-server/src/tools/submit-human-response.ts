// submit-human-response tool — advances a gate-waiting run with a human choice.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  submitHumanResponse,
  WorkflowError,
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
        const agentAction = err instanceof WorkflowError ? err.agentAction : 'report_to_user';
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  command: 'submit_human_response',
                  run_id: args.run_id,
                  run_version: 0,
                  status: 'error',
                  data: {},
                  evidence: [],
                  warnings: [],
                  errors: [message],
                  agent_action: agentAction,
                  context_hint: `Error submitting response for run '${args.run_id}'.`,
                  next_actions: [],
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
