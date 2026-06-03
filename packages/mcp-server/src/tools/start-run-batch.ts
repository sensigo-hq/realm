// start-run-batch tool — atomically enqueues multiple runs of the same workflow.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  WorkflowError,
  buildPreExecutionErrorEnvelope,
  validateInputSchema,
  type ResponseEnvelope,
} from '@sensigo/realm';
import type { HandleRunStores } from './start-run.js';

export interface StartRunBatchResult {
  started: Array<{
    run_id: string;
    idempotency_key?: string;
    params: Record<string, unknown>;
  }>;
}

export async function handleStartRunBatch(
  args: {
    workflow_id: string;
    items: Array<{ params: Record<string, unknown>; idempotency_key?: string | undefined }>;
    parent_run_id?: string | undefined;
    max_items?: number | undefined;
  },
  stores?: HandleRunStores,
): Promise<StartRunBatchResult> {
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();

  const cap = args.max_items ?? 100;
  if (args.items.length > cap) {
    throw new WorkflowError(
      `start_run_batch: ${args.items.length} items exceeds max_items limit of ${cap}`,
      {
        code: 'VALIDATION_BATCH_TOO_LARGE',
        category: 'VALIDATION',
        agentAction: 'provide_input',
        retryable: false,
        details: { count: args.items.length, max_items: cap },
      },
    );
  }

  const definition = await workflowStore.get(args.workflow_id);

  if (definition.params_schema !== undefined) {
    const failures: Array<{ index: number; reason: string }> = [];
    for (let i = 0; i < args.items.length; i++) {
      try {
        validateInputSchema(args.items[i]!.params, definition.params_schema, `item[${i}]`);
      } catch (err) {
        if (err instanceof WorkflowError) {
          failures.push({ index: i, reason: err.message });
        }
      }
    }
    if (failures.length > 0) {
      throw new WorkflowError(
        `start_run_batch: ${failures.length} item(s) failed schema validation`,
        {
          code: 'VALIDATION_BATCH_ITEMS',
          category: 'VALIDATION',
          agentAction: 'provide_input',
          retryable: false,
          details: { failures },
        },
      );
    }
  }

  const started: StartRunBatchResult['started'] = [];
  for (const item of args.items) {
    const run = await runStore.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: item.params,
      ...(item.idempotency_key !== undefined ? { idempotencyKey: item.idempotency_key } : {}),
      ...(args.parent_run_id !== undefined ? { parentRunId: args.parent_run_id } : {}),
    });
    started.push({
      run_id: run.id,
      ...(item.idempotency_key !== undefined ? { idempotency_key: item.idempotency_key } : {}),
      params: item.params,
    });
  }
  return { started };
}

export function registerStartRunBatch(
  server: McpServer,
  opts?: {
    registry?: import('@sensigo/realm').ExtensionRegistry;
    secrets?: Record<string, string>;
  },
): void {
  server.tool(
    'start_run_batch',
    'Atomically enqueue multiple runs of the same workflow. All items are validated before any run is created. If idempotency keys are provided, duplicate runs are returned instead of created.',
    {
      workflow_id: z.string(),
      items: z.array(
        z.object({
          params: z.record(z.unknown()),
          idempotency_key: z.string().optional(),
        }),
      ),
      parent_run_id: z.string().optional(),
      max_items: z.number().int().positive().optional(),
    },
    async (args) => {
      try {
        const result = await handleStartRunBatch(args, opts);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
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
            ? `Workflow '${args.workflow_id}' not found.`
            : workflowErr.code === 'VALIDATION_BATCH_TOO_LARGE'
              ? `Batch exceeds max_items limit.`
              : workflowErr.code === 'VALIDATION_BATCH_ITEMS'
                ? `One or more items failed schema validation. No runs were created.`
                : `An error occurred before any runs were created.`;
        const envelope: ResponseEnvelope = buildPreExecutionErrorEnvelope(
          'start_run_batch',
          '',
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
