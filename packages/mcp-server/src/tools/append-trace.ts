// append-trace.ts — append_trace MCP tool for incremental mid-step trace ingestion.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  type AppendResult,
  type TraceBufferStore,
  type AgentTraceEntry,
} from '@sensigo/realm';
import { WorkflowError } from '@sensigo/realm';
import { traceEntrySchema } from './execute-step.js';

export interface HandleAppendTraceStores {
  runStore?: JsonFileStore;
  workflowStore?: JsonWorkflowStore;
  traceBufferStore?: TraceBufferStore;
}

export type AppendTraceResult =
  | ({ status: 'ok' } & AppendResult)
  | { status: 'error'; code: string; message: string; details?: Record<string, unknown> };

/**
 * Business logic for the append_trace tool.
 * Buffers trace entries to the WAL for (runId, stepId). Entries are merged with
 * any entries submitted at execute_step finalization.
 */
export async function handleAppendTrace(
  args: {
    run_id: string;
    step_id: string;
    entries: AgentTraceEntry[];
  },
  stores?: HandleAppendTraceStores,
): Promise<AppendTraceResult> {
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  const traceBufferStore = stores?.traceBufferStore;

  // 1. Load the run.
  let run;
  try {
    run = await runStore.get(args.run_id);
  } catch (err) {
    if (err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND') {
      return {
        status: 'error',
        code: 'STATE_STEP_NOT_ELIGIBLE',
        message: `Run '${args.run_id}' not found.`,
        details: { step_state: 'not_found' },
      };
    }
    throw err;
  }

  // 2. Load the workflow definition.
  const definition = await workflowStore.get(run.workflow_id);

  // 3. Find the step in the definition.
  const stepDef = definition.steps[args.step_id];
  if (stepDef === undefined) {
    return {
      status: 'error',
      code: 'STATE_STEP_NOT_ELIGIBLE',
      message: `Step '${args.step_id}' not found in workflow '${run.workflow_id}'.`,
      details: { step_state: 'not_found' },
    };
  }

  // 4. Check step type — only agent steps support append_trace.
  if (stepDef.execution !== 'agent') {
    return {
      status: 'error',
      code: 'STATE_STEP_NOT_ELIGIBLE',
      message: `Step '${args.step_id}' is not an agent step (execution: '${stepDef.execution}').`,
      details: { step_type: 'not_agent_step' },
    };
  }

  // 5. Check step eligibility — must not be completed, failed, or in-progress.
  if (run.completed_steps.includes(args.step_id) || run.failed_steps.includes(args.step_id)) {
    return {
      status: 'error',
      code: 'STATE_STEP_NOT_ELIGIBLE',
      message: `Step '${args.step_id}' has already been claimed (completed or failed).`,
      details: { step_state: 'already_claimed' },
    };
  }
  if (run.in_progress_steps.includes(args.step_id)) {
    return {
      status: 'error',
      code: 'STATE_STEP_NOT_ELIGIBLE',
      message: `Step '${args.step_id}' is currently being executed by execute_step.`,
      details: { step_state: 'already_claimed' },
    };
  }

  // 6. Empty entries — return current buffer state without writing.
  if (args.entries.length === 0) {
    if (traceBufferStore === undefined) {
      return {
        status: 'ok',
        buffer_count: 0,
        buffer_bytes: 0,
        limit_count: 200,
        limit_bytes: 100 * 1024,
        final_limit_entries: 100,
        final_limit_bytes: 50 * 1024,
      };
    }
    const result = await traceBufferStore.append(args.run_id, args.step_id, []);
    return { status: 'ok', ...result };
  }

  // 7. Append entries to the buffer.
  if (traceBufferStore === undefined) {
    // No buffer store configured — silently succeed (entries will be submitted via execute_step).
    return {
      status: 'ok',
      buffer_count: 0,
      buffer_bytes: 0,
      limit_count: 200,
      limit_bytes: 100 * 1024,
      final_limit_entries: 100,
      final_limit_bytes: 50 * 1024,
    };
  }

  const result = await traceBufferStore.append(args.run_id, args.step_id, args.entries);
  return { status: 'ok', ...result };
}

/** Registers the append_trace MCP tool on the server. */
export function registerAppendTrace(
  server: McpServer,
  opts?: {
    runStore?: JsonFileStore;
    workflowStore?: JsonWorkflowStore;
    traceBufferStore?: TraceBufferStore;
  },
): void {
  server.tool(
    'append_trace',
    [
      'Submit trace entries incrementally during an agent step, before calling execute_step.',
      'Entries are buffered and merged with any entries submitted at execute_step finalization.',
      'Delivery is best-effort: entries are durable after this call returns but are not canonical until execute_step completes.',
      'Only valid for agent steps that have not yet been claimed (before execute_step is called).',
    ].join(' '),
    {
      run_id: z.string(),
      step_id: z.string(),
      entries: z.array(traceEntrySchema),
    },
    async (args) => {
      try {
        const result = await handleAppendTrace(args, opts);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof WorkflowError ? err.code : 'ENGINE_INTERNAL';
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'error',
                  code,
                  message,
                  details: err instanceof WorkflowError ? err.details : undefined,
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
