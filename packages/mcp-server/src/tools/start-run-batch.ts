// start-run-batch tool — atomically enqueues a list of child runs from a fan-out step.
// Semantics: all-or-nothing. All items are validated before any run is created.
// Each item may supply an idempotency_key; the store deduplicates by (workflow_id, key).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { JsonWorkflowStore, JsonFileStore, WorkflowError } from '@sensigo/realm';
import type { HandleRunStores } from './start-run.js';

export interface BatchItem {
  workflow_id: string;
  params?: Record<string, unknown> | undefined;
  idempotency_key?: string | undefined;
}

export interface StartRunBatchResult {
  started: Array<{ run_id: string; workflow_id: string; idempotency_key?: string }>;
  parent_run_id?: string;
}

/**
 * Business logic for the start_run_batch tool.
 * Validates all items first, then enqueues them atomically (all-or-nothing).
 */
export async function handleStartRunBatch(
  args: {
    items: BatchItem[];
    parent_run_id?: string | undefined;
    max_fan_out?: number | undefined;
  },
  stores?: HandleRunStores,
): Promise<StartRunBatchResult> {
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();

  const { items, parent_run_id } = args;

  if (items.length === 0) {
    throw new WorkflowError('start_run_batch requires at least one item', {
      code: 'VALIDATION_BATCH_ITEMS',
      category: 'VALIDATION',
      agentAction: 'provide_input',
      retryable: false,
    });
  }

  const effectiveMaxFanOut = args.max_fan_out;
  if (effectiveMaxFanOut !== undefined && items.length > effectiveMaxFanOut) {
    throw new WorkflowError(
      `start_run_batch received ${items.length} items but max_fan_out is ${effectiveMaxFanOut}. ` +
        `Reduce the batch to at most ${effectiveMaxFanOut} items.`,
      {
        code: 'VALIDATION_BATCH_TOO_LARGE',
        category: 'VALIDATION',
        agentAction: 'provide_input',
        retryable: false,
      },
    );
  }

  // Phase 1: validate all items — resolve each workflow definition.
  // Collect all failures before throwing so the caller can fix everything at once.
  const validationErrors: string[] = [];
  const definitions: Awaited<ReturnType<typeof workflowStore.get>>[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    try {
      const def = await workflowStore.get(item.workflow_id);
      definitions.push(def);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      validationErrors.push(`Item ${i} (workflow_id: '${item.workflow_id}'): ${msg}`);
      definitions.push(null as never); // placeholder — never used if errors exist
    }
  }

  if (validationErrors.length > 0) {
    throw new WorkflowError(
      `start_run_batch validation failed for ${validationErrors.length} item(s):\n` +
        validationErrors.join('\n'),
      {
        code: 'VALIDATION_BATCH_ITEMS',
        category: 'VALIDATION',
        agentAction: 'provide_input',
        retryable: false,
      },
    );
  }

  // Phase 2: enqueue all runs — all validations passed.
  const started: StartRunBatchResult['started'] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const definition = definitions[i]!;

    const run = await runStore.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: item.params ?? {},
      ...(item.idempotency_key !== undefined ? { idempotencyKey: item.idempotency_key } : {}),
      ...(parent_run_id !== undefined ? { parentRunId: parent_run_id } : {}),
    });

    started.push({
      run_id: run.id,
      workflow_id: definition.id,
      ...(item.idempotency_key !== undefined ? { idempotency_key: item.idempotency_key } : {}),
    });
  }

  return {
    started,
    ...(parent_run_id !== undefined ? { parent_run_id } : {}),
  };
}

/** Registers the start_run_batch MCP tool on the server. */
export function registerStartRunBatch(server: McpServer, opts?: HandleRunStores): void {
  const batchItemSchema = z.object({
    workflow_id: z.string(),
    params: z.record(z.unknown()).optional(),
    idempotency_key: z.string().optional(),
  });

  server.tool(
    'start_run_batch',
    'Atomically enqueue multiple child workflow runs. All items are validated before any run is created (all-or-nothing). ' +
      'Each item may include an idempotency_key for safe re-runs. ' +
      'Pass the current run_id as parent_run_id to link child runs for observability.',
    {
      items: z.array(batchItemSchema).min(1),
      parent_run_id: z.string().optional(),
      max_fan_out: z.number().int().positive().optional(),
    },
    async (args) => {
      try {
        const result = await handleStartRunBatch(args, opts);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'ok',
                  command: 'start_run_batch',
                  runs_started: result.started.length,
                  ...result,
                },
                null,
                2,
              ),
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
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'error',
                  command: 'start_run_batch',
                  agent_action: workflowErr.agentAction,
                  errors: [workflowErr.message],
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
