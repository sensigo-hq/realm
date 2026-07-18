// execute-step tool — executes a named step in a workflow run.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  executeChain,
  WorkflowError,
  buildPreExecutionErrorEnvelope,
  buildFailedAttemptRecord,
  serializeFailedAttemptLine,
  type StepDispatcher,
  type ResponseEnvelope,
  type AgentTraceEntry,
} from '@sensigo/realm';
import type { HandleRunStores, FailedAttemptStoreLike } from './start-run.js';
import { sseJsonStringify } from '../sse-json.js';

/** Maximum `writer_nonce` length (issue #197 PR-2, design §6). */
const WRITER_NONCE_MAX_LENGTH = 128;

/** Actionable guidance appended to every writer_nonce-related refusal (issue #197 PR-2). */
export const WRITER_NONCE_GUIDANCE =
  'writer_nonce must be a non-empty string, ≤128 chars, no leading/trailing whitespace; ' +
  'recommended: a fresh UUIDv4 per step-attempt.';

/**
 * Validates a caller-submitted `writer_nonce`'s SHAPE (issue #197 PR-2, design §6) — throws a
 * typed `WorkflowError` on any violation, never a bare zod/SDK error (the zod schema itself
 * accepts any string, deliberately UNBOUNDED, so every shape violation routes through this ONE
 * check). Shared by `append_trace` and `execute_step` — the shape rule lives in exactly one
 * place; each tool's OWN refusal taxonomy is otherwise free to differ.
 */
export function validateWriterNonceShape(nonce: string): void {
  let reason: string | undefined;
  if (nonce.length === 0) {
    reason = 'must not be empty';
  } else if (nonce !== nonce.trim()) {
    reason = 'must not have leading or trailing whitespace';
  } else if (nonce.length > WRITER_NONCE_MAX_LENGTH) {
    reason = `must be ≤${WRITER_NONCE_MAX_LENGTH} characters`;
  }
  if (reason === undefined) return;
  throw new WorkflowError(`Invalid writer_nonce: ${reason}. ${WRITER_NONCE_GUIDANCE}`, {
    code: 'VALIDATION_EMPTY_VALUE',
    category: 'VALIDATION',
    agentAction: 'provide_input',
    retryable: false,
  });
}

/**
 * Dormant strict posture (issue #197 PR-2, design §6 — the #169→#170 template): read PER CALL,
 * NEVER cached at module load (a test flips the env var mid-process). "on" = set to any
 * non-empty value other than `'0'`/`'false'`. Default (unset) ⇒ zero behavior change anywhere.
 */
export function isWriterNonceRequired(): boolean {
  const v = process.env['REALM_REQUIRE_WRITER_NONCE'];
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

/** Refusal for `isWriterNonceRequired()` ⇒ true and a bare (agent-step) call (issue #197 PR-2). */
export function writerNonceRequiredError(stepId: string, runVersion: number): WorkflowError {
  return new WorkflowError(
    'This deployment requires writer_nonce for agent steps (REALM_REQUIRE_WRITER_NONCE is set) ' +
      `— step '${stepId}' was called without one. ${WRITER_NONCE_GUIDANCE}`,
    {
      code: 'VALIDATION_EMPTY_VALUE',
      category: 'VALIDATION',
      agentAction: 'provide_input',
      retryable: false,
      details: { step_id: stepId, run_version: runVersion },
    },
  );
}

/**
 * Pre-claim validation rejections carry one of these error codes (claimStep runs strictly after all
 * three schema gates, so they never reach failed_steps[] / never bump version — a write-free path).
 * Failed agent attempts on these codes are surfaced as stderr telemetry below.
 */
const VALIDATION_TELEMETRY_CODES = new Set([
  'VALIDATION_INPUT_SCHEMA',
  'VALIDATION_OUTPUT_SCHEMA',
  'VALIDATION_TRACE_SCHEMA',
]);

/**
 * Best-effort, metadata-only telemetry for a failed agent-step validation attempt. On a (pre-strip)
 * validation rejection it fans the same record out to two INDEPENDENT sinks: an ephemeral stderr line
 * (P2) and a durable per-run sidecar (P3, when a store is wired). Each sink is separately guarded so a
 * throw in one cannot suppress the other; the whole thing never throws and never alters the
 * execute_step response.
 */
async function emitFailedAttemptTelemetry(
  args: {
    run_id: string;
    command: string;
    params?: Record<string, unknown>;
    trace?: AgentTraceEntry[] | undefined;
  },
  workflowId: string,
  result: ResponseEnvelope,
  failedAttemptStore?: FailedAttemptStoreLike,
): Promise<void> {
  // Build the shared metadata-only record once (bail both sinks if it can't be built).
  let record: ReturnType<typeof buildFailedAttemptRecord>;
  try {
    if (result.status !== 'error') return;
    const code = result.error_code;
    if (code === undefined || !VALIDATION_TELEMETRY_CODES.has(code)) return;
    const ajvErrors = result.error_details?.['errors'];
    record = buildFailedAttemptRecord({
      run_id: args.run_id,
      workflow_id: workflowId,
      step_id: args.command,
      ts: new Date().toISOString(),
      error_code: code,
      ajv_errors: Array.isArray(ajvErrors) ? ajvErrors : [],
      params: args.params ?? {},
      trace_entry_count: args.trace?.length ?? 0,
    });
  } catch {
    return;
  }

  // Sink 1 (P2): ephemeral stderr line — keeps the `event` tag. Independent best-effort.
  try {
    console.error(
      serializeFailedAttemptLine({ event: 'agent_step_attempt_failed', ...record }).line,
    );
  } catch {
    // never let a stderr failure suppress the sidecar append
  }

  // Sink 2 (P3): durable sidecar — the file IS the event stream, so the line OMITS the `event` tag.
  // Independent best-effort; the store's append already swallows its own I/O errors.
  if (failedAttemptStore !== undefined) {
    try {
      const serialized = serializeFailedAttemptLine({ ...record });
      // Fold the truncation flag into the persisted record when the serializer had to reduce.
      const line = serialized.truncated
        ? serializeFailedAttemptLine({ ...record, truncated: true }).line
        : serialized.line;
      await failedAttemptStore.append(args.run_id, line);
    } catch {
      // never let a sidecar failure suppress the stderr emit (already done) or the response
    }
  }
}

/** Zod schema for a single agent trace entry submitted to execute_step or append_trace. */
export const traceEntrySchema = z.object({
  event: z.string(),
  timestamp: z.string().optional(),
  data: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

// For agent steps, the agent's params represent their work output. The dispatcher
// passes them through as the step output recorded in evidence.
const makeParamsDispatcher =
  (params: Record<string, unknown>): StepDispatcher =>
  async () =>
    params;

/**
 * Business logic for the execute_step tool.
 * Validates eligibility, claims the step, and records the agent's params as step output.
 */
export async function handleExecuteStep(
  args: {
    run_id: string;
    command: string;
    params?: Record<string, unknown>;
    trace?: AgentTraceEntry[] | undefined;
    writer_nonce?: string | undefined;
  },
  stores?: HandleRunStores,
): Promise<ResponseEnvelope> {
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  const run = await runStore.get(args.run_id);
  const definition = await workflowStore.get(run.workflow_id);
  const params = args.params ?? {};
  const stepDef = definition.steps[args.command];

  // issue #197 PR-2 (design §6): shape-validate BEFORE anything else — routes every violation
  // through ONE typed refusal, never a bare zod/SDK error.
  if (args.writer_nonce !== undefined) {
    validateWriterNonceShape(args.writer_nonce);
  }

  // A writer_nonce PRESENT on a non-agent step is refused (design §6) — mirrors append_trace's
  // own non-agent taxonomy (STATE_STEP_NOT_ELIGIBLE + step_type detail). A BARE execute_step call
  // on a non-agent step stays byte-identical — auto/handler steps legally execute through this
  // tool, and this check only fires when a nonce was actually supplied.
  if (args.writer_nonce !== undefined && stepDef !== undefined && stepDef.execution !== 'agent') {
    throw new WorkflowError(
      `Step '${args.command}' is not an agent step (execution: '${stepDef.execution}') — ` +
        'writer_nonce is only meaningful on agent steps.',
      {
        code: 'STATE_STEP_NOT_ELIGIBLE',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { step_id: args.command, step_type: stepDef.execution, run_version: run.version },
      },
    );
  }

  // issue #197 PR-2 (design §6, dormant strict posture — default off, zero behavior change):
  // agent steps only — an auto/handler step's execute_step call never carries a caller-chosen
  // writer_nonce in the first place.
  if (
    isWriterNonceRequired() &&
    stepDef?.execution === 'agent' &&
    args.writer_nonce === undefined
  ) {
    throw writerNonceRequiredError(args.command, run.version);
  }

  // Per-definition registry (project extensions) — awaited before execution; a throwing
  // provider fails the tool call before any step is claimed. Provider wins over `registry`.
  const registry =
    stores?.registryProvider !== undefined
      ? await stores.registryProvider(definition)
      : stores?.registry;

  const result = await executeChain(runStore, definition, {
    runId: args.run_id,
    command: args.command,
    input: params,
    dispatcher: makeParamsDispatcher(params),
    ...(registry !== undefined ? { registry } : {}),
    // trace is a top-level execute_step field — never embedded in params.
    ...(args.trace !== undefined ? { trace: args.trace } : {}),
    // Pass WAL buffer store so execution loop can merge and clean up the WAL.
    ...(stores?.traceBufferStore !== undefined
      ? { traceBufferStore: stores.traceBufferStore }
      : {}),
    ...(args.writer_nonce !== undefined ? { writerNonce: args.writer_nonce } : {}),
  });

  // P2/P3 observability: on a pre-claim validation rejection, fan a metadata-only record out to the
  // ephemeral stderr line (P2) and the durable per-run sidecar (P3, when wired). Reads the pre-strip
  // envelope; awaited but best-effort — it never throws and never alters the response.
  await emitFailedAttemptTelemetry(args, run.workflow_id, result, stores?.failedAttemptStore);

  return result;
}

/**
 * MCP-layer wrapper around handleExecuteStep.
 * Returns the tool content format used by the MCP server (content array with text JSON).
 * Exported for direct testing of the MCP response shape.
 */
export async function handleExecuteStepTool(
  args: {
    run_id: string;
    command: string;
    params?: Record<string, unknown>;
    trace?: AgentTraceEntry[] | undefined;
    writer_nonce?: string | undefined;
  },
  stores?: HandleRunStores,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const result = await handleExecuteStep(args, stores);
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
          : `An error occurred before step '${args.command}' could begin.`;
    const envelope: ResponseEnvelope = buildPreExecutionErrorEnvelope(
      args.command,
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
}

/** Registers the execute_step MCP tool on the server. */
export function registerExecuteStep(server: McpServer, opts?: HandleRunStores): void {
  server.tool(
    'execute_step',
    [
      'Execute a workflow step. For agent steps, pass your output in params.',
      'Optional: writer_nonce — mint a fresh UUIDv4 per step-attempt (same value on every',
      "append_trace call for this attempt, a NEW one next attempt) to get this step's own",
      'buffered trace lines faithfully attributed instead of the honest-but-unattributed floor.',
      'Mint on BOTH append_trace and execute_step for this attempt, or neither — a guessable or',
      'reused nonce is worse than omitting one (it lets residue be adopted with no caveat, or',
      'silently folds a crashed attempt into this one).',
    ].join(' '),
    {
      run_id: z.string(),
      command: z.string(),
      params: z.record(z.unknown()).optional().default({}),
      trace: z.array(traceEntrySchema).optional(),
      // issue #197 PR-2 (design §6): UNBOUNDED at the zod layer — every shape violation
      // (empty/whitespace/too-long) routes through validateWriterNonceShape to ONE typed realm
      // envelope refusal, never a bare zod/SDK error.
      writer_nonce: z.string().optional(),
    },
    async (args) => {
      return handleExecuteStepTool(args, opts);
    },
  );
}
