// list-workflows tool — returns all registered workflows.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { JsonWorkflowStore } from '@sensigo/realm';
import { sseJsonStringify } from '../sse-json.js';

export interface HandleStores {
  workflowStore?: JsonWorkflowStore;
}

/**
 * Business logic for the list_workflows tool.
 * Returns a summary of all registered workflows.
 */
export async function handleListWorkflows(
  stores?: HandleStores,
): Promise<{ workflows: Array<{ id: string; name: string; version: number }>; hint: string }> {
  const store = stores?.workflowStore ?? new JsonWorkflowStore();
  const workflows = await store.list();
  return {
    workflows: workflows.map((w) => ({ id: w.id, name: w.name, version: w.version })),
    hint: 'Call get_workflow_protocol with a workflow_id before calling start_run. If no workflow matches your task, use create_workflow to define and start your own plan.',
  };
}

/** Registers the list_workflows MCP tool on the server. */
export function registerListWorkflows(server: McpServer, opts?: HandleStores): void {
  server.tool('list_workflows', 'List all registered Realm workflows.', async () => {
    const result = await handleListWorkflows(opts);
    return { content: [{ type: 'text' as const, text: sseJsonStringify(result) }] };
  });
}
