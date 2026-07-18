// get-workflow-protocol tool — returns the agent protocol for a workflow.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { JsonWorkflowStore, WorkflowError } from '@sensigo/realm';
import { sseJsonStringify } from '../sse-json.js';
import { generateProtocol, type WorkflowProtocol } from '../protocol/generator.js';
import type { HandleStores } from './list-workflows.js';

/**
 * Issue #197 PR-2 (design §6): one brief affordance line teaching cooperating agents to mint
 * `writer_nonce` — consistent with `append_trace`'s own opt-in posture (an affordance, never a
 * requirement). Appended to `rules` here (in the TOOL layer) rather than in
 * `protocol/generator.ts` itself, since that module is off this PR's touch list — this keeps the
 * generator's own output byte-identical for any OTHER consumer that calls it directly.
 */
const WRITER_NONCE_PROTOCOL_RULE =
  'Optional: mint a fresh UUIDv4 writer_nonce per step-attempt (the same value on every ' +
  'append_trace call for that attempt, a new one next attempt, on BOTH append_trace and ' +
  'execute_step or neither) to get your own buffered trace lines faithfully attributed instead ' +
  'of the honest-but-unattributed floor.';

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
  const protocol = generateProtocol(definition);
  return { ...protocol, rules: [...protocol.rules, WRITER_NONCE_PROTOCOL_RULE] };
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
