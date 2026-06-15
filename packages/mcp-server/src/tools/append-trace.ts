// append-trace.ts — append_trace MCP tool for incremental mid-step trace ingestion.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  WorkflowError,
  buildPreExecutionErrorEnvelope,
  type AppendResult,
  type TraceBufferStore,
  type AgentTraceEntry,
  type ResponseEnvelope,
} from '@sensigo/realm';
import { traceEntrySchema } from './execute-step.js';
import { sseJsonStringify } from '../sse-json.js';

export interface HandleAppendTraceStores {
  runStore?: JsonFileStore;
  workflowStore?: JsonWorkflowStore;
  traceBufferStore?: TraceBufferStore;
}

export type AppendTraceOkResult = { status: 'ok' } & AppendResult;

/**
 * Business logic for the append_trace tool.
 * Buffers trace entries to the WAL for (runId, stepId). Entries are merged with
 * any entries submitted at execute_step finalization.
 *
 * Throws WorkflowError for all error conditions. Callers (typically
 * registerAppendTrace) catch and convert to ResponseEnvelope.
 */
export async function handleAppendTrace(
  args: {
    run_id: string;
    step_id: string;
    entries: AgentTraceEntry[];
  },
  stores?: HandleAppendTraceStores,
): Promise<AppendTraceOkResult> {
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  const traceBufferStore = stores?.traceBufferStore;

  // 1. Load the run. Throws STATE_RUN_NOT_FOUND if missing.
  const run = await runStore.get(args.run_id);

  // 2. Load the workflow definition.
  const definition = await workflowStore.get(run.workflow_id);

  // 3. Find the step in the definition.
  const stepDef = definition.steps[args.step_id];
  if (stepDef === undefined) {
    throw new WorkflowError(`Step '${args.step_id}' not found in workflow '${run.workflow_id}'.`, {
      code: 'STEP_NOT_FOUND',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { step_id: args.step_id, workflow_id: run.workflow_id, run_version: run.version },
    });
  }

  // 4. Check step type — only agent steps support append_trace.
  if (stepDef.execution !== 'agent') {
    throw new WorkflowError(
      `Step '${args.step_id}' is not an agent step (execution: '${stepDef.execution}').`,
      {
        code: 'STATE_STEP_NOT_ELIGIBLE',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { step_id: args.step_id, step_type: stepDef.execution, run_version: run.version },
      },
    );
  }

  // 5. Check step eligibility — must not be completed, failed, or in-progress.
  if (run.completed_steps.includes(args.step_id) || run.failed_steps.includes(args.step_id)) {
    throw new WorkflowError(
      `Step '${args.step_id}' has already been claimed (completed or failed).`,
      {
        code: 'STATE_STEP_NOT_ELIGIBLE',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { step_id: args.step_id, step_state: 'already_claimed', run_version: run.version },
      },
    );
  }
  if (run.in_progress_steps.includes(args.step_id)) {
    throw new WorkflowError(`Step '${args.step_id}' is currently being executed by execute_step.`, {
      code: 'STATE_STEP_NOT_ELIGIBLE',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { step_id: args.step_id, step_state: 'in_progress', run_version: run.version },
    });
  }

  // Steps 6 + 7: Require buffer store for any append_trace operation.
  if (traceBufferStore === undefined) {
    throw new WorkflowError('No trace buffer store configured', {
      code: 'ENGINE_INTERNAL',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    });
  }

  // 6. Empty entries — return current buffer state without writing.
  if (args.entries.length === 0) {
    const result = await traceBufferStore.append(args.run_id, args.step_id, []);
    return { status: 'ok', ...result };
  }

  // 7. Append entries to the buffer.
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
          content: [{ type: 'text' as const, text: sseJsonStringify(result) }],
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
        const runVersion =
          typeof workflowErr.details['run_version'] === 'number'
            ? workflowErr.details['run_version']
            : 0;
        const contextHint =
          workflowErr.code === 'STATE_RUN_NOT_FOUND'
            ? `Run '${args.run_id}' not found.`
            : workflowErr.code === 'STEP_NOT_FOUND'
              ? `Step '${args.step_id}' not found in the workflow.`
              : workflowErr.code === 'STATE_STEP_NOT_ELIGIBLE'
                ? `Step '${args.step_id}' is not eligible for trace buffering.`
                : workflowErr.code === 'BUFFER_FULL'
                  ? `Trace buffer is full for step '${args.step_id}'.`
                  : `An error occurred during append_trace for run '${args.run_id}'.`;
        const envelope: ResponseEnvelope = buildPreExecutionErrorEnvelope(
          'append_trace',
          args.run_id,
          runVersion,
          workflowErr,
          contextHint,
        );
        return {
          content: [{ type: 'text' as const, text: sseJsonStringify(envelope) }],
        };
      }
    },
  );
}
