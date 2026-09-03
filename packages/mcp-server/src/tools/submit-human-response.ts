// submit-human-response tool — advances a gate-waiting run with a human choice.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  submitHumanResponse,
  WorkflowError,
  buildPreExecutionErrorEnvelope,
  getWorkflowForRun,
  type ResponseEnvelope,
} from '@sensigo/realm';
import type { HandleRunStores } from './start-run.js';
import { sseJsonStringify } from '../sse-json.js';

/**
 * Business logic for the submit_human_response tool.
 * Validates the gate_id and choice, then advances the run past the gate.
 */
export async function handleSubmitHumanResponse(
  args: { run_id: string; gate_id: string; choice: string; responded_by?: string | undefined },
  stores?: HandleRunStores,
): Promise<ResponseEnvelope> {
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  const run = await runStore.get(args.run_id);
  // issue #456: code-keyed one-time-register remedy. Verb "retry" — deliberately neutral: the
  // register command in the sentence is for the human this agent's report_to_user relays to.
  const definition = await getWorkflowForRun(workflowStore, run, { retryVerb: 'retry' });

  // Per-definition registry (project extensions) — awaited before the call (fail-fast),
  // provider wins over `registry`. Mirrors execute-step.ts. Threaded into submitHumanResponse
  // so that resolving a gate which COMPLETES the run fires its finalizers with project handlers.
  const registry =
    stores?.registryProvider !== undefined
      ? await stores.registryProvider(definition)
      : stores?.registry;

  return submitHumanResponse(runStore, definition, {
    runId: args.run_id,
    gateId: args.gate_id,
    choice: args.choice,
    ...(registry !== undefined ? { registry } : {}),
    // issue #279 (increment 2, PR-D; design record D-5): pass-through only, never validated.
    ...(args.responded_by !== undefined ? { respondedBy: args.responded_by } : {}),
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
      // issue #279 (increment 2, PR-D; design record D-5): unenforced attribution passthrough —
      // pass-through only, never validated.
      responded_by: z.string().optional(),
    },
    async (args) => {
      try {
        const result = await handleSubmitHumanResponse(args, opts);
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
              text: sseJsonStringify(envelope),
            },
          ],
        };
      }
    },
  );
}
