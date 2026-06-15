// get-workflow-protocol tool — returns the agent protocol for a workflow.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { JsonWorkflowStore, WorkflowError } from '@sensigo/realm';
import { sseJsonStringify } from '../sse-json.js';
import { generateProtocol, type WorkflowProtocol } from '../protocol/generator.js';
import type { HandleStores } from './list-workflows.js';

/**
 * Business logic for the get_workflow_protocol tool.
 * Returns the full agent protocol for the specified workflow.
 */
export async function handleGetWorkflowProtocol(
  args: { workflow_id: string },
  stores?: HandleStores,
): Promise<WorkflowProtocol> {
  const store = stores?.workflowStore ?? new JsonWorkflowStore();
  const definition = await store.get(args.workflow_id);
  return generateProtocol(definition);
}

/** Registers the get_workflow_protocol MCP tool on the server. */
export function registerGetWorkflowProtocol(server: McpServer, opts?: HandleStores): void {
  server.tool(
    'get_workflow_protocol',
    'Get the full agent protocol briefing for a registered workflow.',
    { workflow_id: z.string() },
    async (args) => {
      try {
        const result = await handleGetWorkflowProtocol(args, opts);
        return { content: [{ type: 'text' as const, text: sseJsonStringify(result) }] };
      } catch (err) {
        const message = err instanceof WorkflowError ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
