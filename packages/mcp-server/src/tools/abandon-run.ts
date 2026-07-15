// abandon-run tool — explicitly abandons a non-terminal run (stamps the authoritative marker).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonFileStore,
  WorkflowError,
  abandonRun,
  resolvePreExecutionAgentAction,
  type RunPhase,
  type RunStore,
} from '@sensigo/realm';
import { sseJsonStringify } from '../sse-json.js';

export interface HandleAbandonRunStores {
  /** Any `RunStore` implementation (issue #188, PR-1 — was `JsonFileStore`-only). */
  runStore?: RunStore;
}

export interface AbandonRunSummary {
  run_id: string;
  run_phase: RunPhase;
  terminal_state: boolean;
  terminal_reason: string | undefined;
}

/**
 * Business logic for the abandon_run tool. Abandons a non-terminal run via the shared core
 * primitive and returns a minimal state summary.
 */
export async function handleAbandonRun(
  args: { run_id: string; reason?: string | undefined },
  stores?: HandleAbandonRunStores,
): Promise<AbandonRunSummary> {
  const runStore = stores?.runStore ?? new JsonFileStore();
  const run = await abandonRun(runStore, args.run_id, args.reason);
  return {
    run_id: run.id,
    run_phase: run.run_phase,
    terminal_state: run.terminal_state,
    terminal_reason: run.terminal_reason,
  };
}

/** Registers the abandon_run MCP tool on the server. */
export function registerAbandonRun(server: McpServer, opts?: HandleAbandonRunStores): void {
  server.tool(
    'abandon_run',
    'Abandon a non-terminal workflow run (marks it terminal with phase "abandoned"). Refuses runs waiting on a human gate (resolve via submit_human_response) and already-terminal runs.',
    { run_id: z.string(), reason: z.string().optional() },
    async (args) => {
      try {
        const result = await handleAbandonRun(args, opts);
        return { content: [{ type: 'text' as const, text: sseJsonStringify(result) }] };
      } catch (err) {
        const agentAction =
          err instanceof WorkflowError ? resolvePreExecutionAgentAction(err) : 'report_to_user';
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof WorkflowError ? err.code : undefined;
        const contextHint =
          code === 'STATE_RUN_NOT_FOUND'
            ? `Run '${args.run_id}' not found.`
            : code === 'STATE_RUN_TERMINAL'
              ? `Run '${args.run_id}' is already terminal; nothing to abandon.`
              : code === 'STATE_TRANSITION_DENIED'
                ? `Run '${args.run_id}' is waiting on a human gate; resolve it before abandoning.`
                : `An error occurred while abandoning the run.`;
        return {
          content: [
            {
              type: 'text' as const,
              text: sseJsonStringify({
                command: 'abandon_run',
                run_id: args.run_id,
                status: 'error',
                data: {},
                evidence: [],
                warnings: [],
                errors: [message],
                ...(code !== undefined ? { error_code: code } : {}),
                agent_action: agentAction,
                context_hint: contextHint,
                next_actions: [],
              }),
            },
          ],
        };
      }
    },
  );
}
