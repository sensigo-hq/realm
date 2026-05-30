// get-run-state tool — returns the current state summary of a run.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { JsonFileStore, WorkflowError, type RunPhase } from '@sensigo/realm';

export interface HandleRunStateStores {
  runStore?: JsonFileStore;
}

export interface RunStateSummary {
  run_id: string;
  workflow_id: string;
  run_phase: RunPhase;
  terminal_state: boolean;
  completed_steps: string[];
  in_progress_steps: string[];
  failed_steps: string[];
  skipped_steps: string[];
  pending_gate: import('@sensigo/realm').PendingGate | undefined;
  evidence_count: number;
  last_step: string | null;
  created_at: string;
  updated_at: string;
  params: Record<string, unknown>;
}

/**
 * Business logic for the get_run_state tool.
 * Returns a structured summary of the run without the full evidence array.
 */
export async function handleGetRunState(
  args: { run_id: string },
  stores?: HandleRunStateStores,
): Promise<RunStateSummary> {
  const runStore = stores?.runStore ?? new JsonFileStore();
  const run = await runStore.get(args.run_id);

  return {
    run_id: run.id,
    workflow_id: run.workflow_id,
    run_phase: run.run_phase,
    terminal_state: run.terminal_state,
    completed_steps: run.completed_steps,
    in_progress_steps: run.in_progress_steps,
    failed_steps: run.failed_steps,
    skipped_steps: run.skipped_steps,
    pending_gate: run.pending_gate,
    evidence_count: run.evidence.length,
    last_step: run.evidence.at(-1)?.step_id ?? null,
    created_at: run.created_at,
    updated_at: run.updated_at,
    params: run.params,
  };
}

/** Registers the get_run_state MCP tool on the server. */
export function registerGetRunState(server: McpServer, opts?: HandleRunStateStores): void {
  server.tool(
    'get_run_state',
    'Get the current state summary of a workflow run.',
    { run_id: z.string() },
    async (args) => {
      try {
        const result = await handleGetRunState(args, opts);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const agentAction = err instanceof WorkflowError ? err.agentAction : 'report_to_user';
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  command: 'get_run_state',
                  run_id: args.run_id,
                  status: 'error',
                  data: {},
                  evidence: [],
                  warnings: [],
                  errors: [message],
                  agent_action: agentAction,
                  context_hint: `Error retrieving state for run '${args.run_id}'.`,
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
