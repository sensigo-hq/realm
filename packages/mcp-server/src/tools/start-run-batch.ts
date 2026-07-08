// start-run-batch tool — atomically enqueues multiple runs of the same workflow.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  WorkflowError,
  buildPreExecutionErrorEnvelope,
  validateInputSchema,
  hashParams,
  unmetCapabilities,
  capabilityWarning,
  createDefaultRegistry,
  type ResponseEnvelope,
  type RunPhase,
} from '@sensigo/realm';
import type { HandleRunStores } from './start-run.js';
import { sseJsonStringify } from '../sse-json.js';

/** Lightweight structured telemetry. stderr is safe under the MCP stdio/SSE transport. */
function logBatchDedup(fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event: 'idempotency_dedup', ...fields }));
}

export interface StartRunBatchResult {
  started: Array<{
    run_id: string;
    idempotency_key?: string;
    params: Record<string, unknown>;
    /** True when an existing run matched the idempotency key (inverse of the store's `created`). */
    deduped: boolean;
    /** Derived phase of the run at enqueue time — identical field name to the single-run path. */
    run_phase: RunPhase;
    /** Present only for a terminal matched run. */
    terminal_reason?: string;
    /** Observational warnings (active-match / param-mismatch) — identical field name to the single-run path. */
    warnings: string[];
  }>;
  /**
   * Items rejected by the idempotency policy (`on_terminal_match: 'reject'` / `on_live_match: 'fail'`).
   * Carries the original item index so callers can correlate back to `items[]`. A rejected item does
   * NOT abort the batch — successful items still appear in `started[]`.
   */
  failed: Array<{
    index: number;
    idempotency_key?: string;
    params: Record<string, unknown>;
    error: string;
    error_code?: string;
  }>;
}

export async function handleStartRunBatch(
  args: {
    workflow_id: string;
    items: Array<{ params: Record<string, unknown>; idempotency_key?: string | undefined }>;
    parent_run_id?: string | undefined;
    max_items?: number | undefined;
    on_terminal_match?: 'reuse' | 'reject' | 'rerun_if_failed' | 'rerun' | undefined;
    on_live_match?: 'use_existing' | 'fail' | undefined;
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

  // Resolved BEFORE any runStore.create — a throwing registryProvider (broken project extensions) must
  // fail the batch with NO runs created (fail-fast gate). Provider wins over the construction-time
  // registry. Captured (not just awaited) so the #134 pre-flight can inspect the same effective registry.
  const registry =
    stores?.registryProvider !== undefined
      ? await stores.registryProvider(definition)
      : stores?.registry;

  // #134 pre-flight (WARN-only, never refuse): capability gaps are workflow-invariant, so compute ONCE
  // and attach to every item. Caveated — a batch item may ultimately be driven by a DIFFERENT runner
  // than the one whose registry we see at creation time. The `?? createDefaultRegistry()` fallback is the
  // HARD invariant that stops a filesystem-only workflow from false-warning when no registry is supplied.
  const capabilityWarnings = unmetCapabilities(definition, registry ?? createDefaultRegistry()).map(
    (req) =>
      `${capabilityWarning(req)} (Based on the creation-time registry; the driving runner may differ.)`,
  );

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
  const failed: StartRunBatchResult['failed'] = [];
  let dedupHits = 0;
  for (let i = 0; i < args.items.length; i++) {
    const item = args.items[i]!;
    let run;
    let created;
    try {
      ({ run, created } = await runStore.create({
        workflowId: definition.id,
        workflowVersion: definition.version,
        params: item.params,
        ...(item.idempotency_key !== undefined ? { idempotencyKey: item.idempotency_key } : {}),
        ...(args.parent_run_id !== undefined ? { parentRunId: args.parent_run_id } : {}),
        ...(args.on_terminal_match !== undefined
          ? { onTerminalMatch: args.on_terminal_match }
          : {}),
        ...(args.on_live_match !== undefined ? { onLiveMatch: args.on_live_match } : {}),
      }));
    } catch (err) {
      // A policy rejection (`reject` / `fail`) must NOT sink the batch — record and continue.
      const we = err instanceof WorkflowError ? err : undefined;
      failed.push({
        index: i,
        ...(item.idempotency_key !== undefined ? { idempotency_key: item.idempotency_key } : {}),
        params: item.params,
        error: err instanceof Error ? err.message : String(err),
        ...(we !== undefined ? { error_code: we.code } : {}),
      });
      continue;
    }

    // The store reports `created`; the batch surfaces its inverse, `deduped`, per item.
    const deduped = !created;
    if (deduped) dedupHits++;

    const warnings: string[] = [...capabilityWarnings];
    if (deduped) {
      if (run.run_phase === 'running' || run.run_phase === 'gate_waiting') {
        warnings.push(`Idempotency key matched a run still in phase '${run.run_phase}'.`);
      }
      if (
        item.idempotency_key !== undefined &&
        hashParams(item.params) !== hashParams(run.params)
      ) {
        warnings.push(
          `Idempotency key matched an existing run created with different params; the original run is returned unchanged (params not updated).`,
        );
      }
    }

    started.push({
      run_id: run.id,
      ...(item.idempotency_key !== undefined ? { idempotency_key: item.idempotency_key } : {}),
      params: item.params,
      deduped,
      run_phase: run.run_phase,
      ...(run.terminal_reason !== undefined ? { terminal_reason: run.terminal_reason } : {}),
      warnings,
    });
  }
  if (dedupHits > 0) {
    logBatchDedup({
      tool: 'start_run_batch',
      workflow_id: definition.id,
      dedup_hits: dedupHits,
      total: args.items.length,
    });
  }
  return { started, failed };
}

export function registerStartRunBatch(server: McpServer, opts?: HandleRunStores): void {
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
      on_terminal_match: z.enum(['reuse', 'reject', 'rerun_if_failed', 'rerun']).optional(),
      on_live_match: z.enum(['use_existing', 'fail']).optional(),
    },
    async (args) => {
      try {
        const result = await handleStartRunBatch(args, opts);
        return {
          content: [
            {
              type: 'text' as const,
              text: sseJsonStringify(result),
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
              text: sseJsonStringify(envelope),
            },
          ],
        };
      }
    },
  );
}
