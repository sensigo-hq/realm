// start-run-batch tool — atomically enqueues multiple runs of the same workflow.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  WorkflowError,
  buildPreExecutionErrorEnvelope,
  validateRunParams,
  isAsyncSchemaRefusal,
  hashParams,
  unmetCapabilities,
  capabilityWarning,
  createDefaultRegistry,
  deriveRunPhase,
  type RunPhase,
  type DisclosureClass,
  persistsField,
  startIdentityEntry,
} from '@sensigo/realm';
import { composeToolWays, handBackHint, mcpHostOf, type HandleRunStores } from './start-run.js';
import {
  mcpReplyOf,
  renderReply,
  renderWaysOf,
  safeTool,
  toolContentOf,
  disclosureOfTool,
  MCP_ENVELOPE_TABLE,
  NEXT_ACTION_TABLE,
  type McpNextAction,
  type WithDoorDisclosure,
  replySubject,
  setForSubject,
  SAFE_TOOL_CONSTANT_RUNLESS,
} from '../render-reply.js';
import { toolMeta } from '../tool-annotations.js';
import { assertToolStores, markServedByTool, registryRole } from './assert-tool-stores.js';
import { assertRegistryLine, ExtensionRegistry as RealmExtensionRegistry } from '@sensigo/realm';

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
    /**
     * issue #625 PR-2a: what this run owes first — its agent steps, then the `advance_run` act when
     * engine work is owed (`buildNextActions`). No step runs in this tool; empty for a terminal run.
     */
    next_actions: McpNextAction[];
    /**
     * issue #625 PR-2a (decision C65): the sentence `start_run`'s reply would carry for this run on
     * which nothing ran — `Run '<id>' created …` or `Matched existing run …`, then what comes next,
     * the way out included when the run cannot go on (`handBackHint`, one composer).
     */
    context_hint: string;
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

type Started = StartRunBatchResult['started'][number];
type Failed = StartRunBatchResult['failed'][number];

/**
 * #729 PR-3 (M-1): the batch's class table. Each run's params are values; a matched run's stored
 * params come back to the caller that holds its key, at the agent tier (the premise: the same key
 * means the same caller, RECORD 01 #15).
 */
export const START_RUN_BATCH_TABLE = {
  started: {
    nested: {
      run_id: 'fact',
      idempotency_key: 'value',
      params: 'value',
      deduped: 'fact',
      run_phase: 'fact',
      terminal_reason: 'bounded',
      warnings: 'bounded',
      next_actions: { nested: NEXT_ACTION_TABLE },
      context_hint: 'bounded',
    } satisfies Record<keyof Started, DisclosureClass>,
  },
  failed: {
    nested: {
      index: 'fact',
      idempotency_key: 'value',
      params: 'value',
      error: 'bounded',
      error_code: 'fact',
    } satisfies Record<keyof Failed, DisclosureClass>,
  },
} as const satisfies Record<keyof StartRunBatchResult, DisclosureClass>;

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
  assertToolStores(stores, 'handleStartRunBatch');
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
  // issue #620 PR-C: the registry rule — refused only on proof (another realm version), before any
  // write. Covers the provider's result and the construction-time registry alike.
  assertRegistryLine(
    registry,
    registryRole(stores, 'start_run_batch', 'handleStartRunBatch'),
    RealmExtensionRegistry,
  );

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
        // issue #586: `validateRunParams`, not `validateInputSchema` — the old call minted
        // `Invalid input for step 'item[0]'`, which named a step that does not exist and a check
        // that was never run. The item index stays on the structured `index` field AND keeps its
        // old bracketed spelling at the head of the reason, so a flat render still says which
        // item and nothing that grepped `item[0]` in a log loses it.
        validateRunParams(args.items[i]!.params, definition.params_schema, definition.id);
      } catch (err) {
        // A params_schema that cannot be checked at all is the workflow's fault, not an item's:
        // the typed refusal ends the call as start_run's does, never "N item(s) failed".
        if (isAsyncSchemaRefusal(err)) throw err;
        if (err instanceof WorkflowError) {
          failures.push({ index: i, reason: `item[${i}]: ${err.message}` });
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
        // #729 PR-3 correction 5 (J-5): each run is born with the serving program's identity.
        ...(startIdentityEntry(registry) !== undefined &&
        persistsField(runStore, 'extension_identity')
          ? { extensionIdentity: [startIdentityEntry(registry)!] }
          : {}),
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
    // issue #279 (increment 2, PR-C — D-3 leg vi): the start_run_batch REUSE surface — a deduped
    // match can hit a GRANDFATHERED terminal-with-stale-gate record (the #282 class).
    const derivedPhase = deriveRunPhase(run);
    if (deduped) {
      // Keyed on terminal_state, never the persisted run_phase.
      if (!run.terminal_state) {
        warnings.push(`Idempotency key matched a run still in phase '${derivedPhase}'.`);
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

    // decision C117: one clock for the entry's ways and its hint. #729 PR-0: the ways composed by
    // core, rendered by the MCP door (next_actions, and on a live run the sentence of what comes next).
    const now = new Date();
    const rendered = renderWaysOf(
      composeToolWays(runStore, definition, run, registry, now),
      mcpHostOf(stores),
    );
    started.push({
      run_id: run.id,
      ...(item.idempotency_key !== undefined ? { idempotency_key: item.idempotency_key } : {}),
      params: item.params,
      deduped,
      run_phase: derivedPhase,
      ...(run.terminal_reason !== undefined ? { terminal_reason: run.terminal_reason } : {}),
      warnings,
      next_actions: rendered.next_actions,
      context_hint: `${handBackHint({ run, current: run, definition, deduped })}${run.terminal_state ? '' : rendered.next_sentence}`,
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

export function registerStartRunBatch(
  server: McpServer,
  opts?: HandleRunStores & WithDoorDisclosure,
): void {
  markServedByTool(opts);
  const door = disclosureOfTool(opts);
  server.registerTool(
    'start_run_batch',
    {
      ...toolMeta('start_run_batch'),
      description:
        "Atomically enqueue multiple runs of the same workflow. No step runs; each started entry's next_actions names its first call. All items are validated before any run is created. If idempotency keys are provided, duplicate runs are returned instead of created.",
      inputSchema: {
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
    },
    safeTool(
      async (args) => {
        const result = await handleStartRunBatch(args, opts);
        return toolContentOf(
          { ...result },
          {
            set: await setForSubject(
              door,
              await replySubject(opts, { workflowId: args.workflow_id }),
            ),
            audience: 'agent',
            table: START_RUN_BATCH_TABLE,
          },
        );
      },
      async (err, args) => {
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
        const rendered = renderReply(
          buildPreExecutionErrorEnvelope('start_run_batch', '', 0, workflowErr, contextHint),
          mcpHostOf(opts),
        );
        return toolContentOf(mcpReplyOf(rendered), {
          set: await setForSubject(
            door,
            await replySubject(opts, { workflowId: args.workflow_id }),
          ),
          audience: 'agent',
          table: MCP_ENVELOPE_TABLE,
        });
      },
      SAFE_TOOL_CONSTANT_RUNLESS,
    ),
  );
}
