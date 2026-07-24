// append-trace.ts — append_trace MCP tool for incremental mid-step trace ingestion.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  WorkflowError,
  buildPreExecutionErrorEnvelope,
  isTerminalPhase,
  storeDeclaresNonceCarriage,
  type AppendResult,
  type TraceBufferStore,
  type AgentTraceEntry,
  type ResponseEnvelope,
  type RunStore,
  type RunRecord,
} from '@sensigo/realm';
import {
  traceEntrySchema,
  validateWriterNonceShape,
  isWriterNonceRequired,
  writerNonceRequiredError,
} from './execute-step.js';
import { sseJsonStringify } from '../sse-json.js';

export interface HandleAppendTraceStores {
  /** Any `RunStore` implementation (issue #188, PR-1 — was `JsonFileStore`-only). */
  runStore?: RunStore;
  workflowStore?: JsonWorkflowStore;
  traceBufferStore?: TraceBufferStore;
}

export type AppendTraceOkResult = { status: 'ok' } & AppendResult & {
    /**
     * Advisory only, never a gate (#119). May carry the unfenced-store caveat (issue #207 PR-2,
     * present only when the configured `traceBufferStore` does NOT declare the fenced trio),
     * the not-persisted caveat (issue #197 PR-2, present only when a `writer_nonce` was supplied
     * but the store doesn't declare `writer_nonce_carriage`), and/or the capacity early-warning
     * (issue #208, present once the post-append fill ratio crosses `CAPACITY_WARNING_THRESHOLD`
     * — see `capacityWarning`, below). Absent entirely (`undefined`, never `[]`) when none apply.
     */
    warnings?: string[];
    /**
     * Downgrade detector (issue #197 PR-2, design §6, RFC 7507-shaped): `true` iff a
     * `writer_nonce` was BOTH supplied on this call AND actually carried by the configured store.
     * Absent (never `false`) when no nonce was supplied, OR when one was supplied but the store
     * silently cannot carry it (see the not-persisted warning above instead) — an old client that
     * never looks at this field is unaffected either way; a minting client can detect the silent
     * demotion by its absence.
     */
    writer_nonce_applied?: true;
  };

/**
 * Fill-ratio threshold (issue #208) at which `append_trace` starts advising the calling agent
 * that this step's trace buffer is approaching `BUFFER_FULL` — a concrete instantiation of the
 * issue's own "e.g. 80%" motivation. Advisory only (#119): never gates, never changes `status`.
 * Chosen at 0.8 as the balance point: early enough that an agent can still act (trim tracing
 * verbosity, or call `execute_step` to finalize the step) before the ceiling is hit, but late
 * enough that it doesn't nag on every ordinary append.
 */
const CAPACITY_WARNING_THRESHOLD = 0.8;

/**
 * Pure, store-agnostic capacity-warning helper (issue #208, AC 1/3/4; re-homed on both bounds by
 * issue #197 PR-2) — every `AppendResult` already carries `buffer_count`/`limit_count`/
 * `buffer_bytes`/`limit_bytes` (WRITER scope) regardless of which `TraceBufferStore`
 * implementation produced it, so this needs no store-specific knowledge at all. When a carriage
 * store ALSO returns the additive `file_*` fields (whole-FILE scope, all writers combined —
 * `BUFFER_BACKSTOP_*`, 2× the per-writer ceiling), this checks that bound too — naive porting
 * would arithmetically lose a tier (0.8×400 > 200, so a single writer could never trip the file
 * bound before its own writer bound already fired, silently making the file check dead code for
 * exactly the common case it must still cover for multi-writer traffic).
 *
 * Returns `undefined` strictly below `CAPACITY_WARNING_THRESHOLD` on EITHER bound; AT OR ABOVE it
 * on the MORE PRESSING one (`>=`, deliberately not `>` — hitting the threshold exactly still
 * warns) returns ONE deterministic message naming that scope, whichever dimension (entries or
 * bytes) within it is closer to its own ceiling, the actual numbers and percentage, and the
 * issue's own actionable guidance.
 *
 * Byte-identity note (issue #197 PR-2): for a SINGLE writer (all-bare traffic, or any carriage
 * store with only one active writer on this key), the file-scope ratio is ALWAYS EXACTLY HALF the
 * writer-scope ratio (file limit = 2× writer limit, same numerator) — so the writer-scope branch
 * below is provably always the one that fires, reproducing the EXACT pre-#197 message text. The
 * shipped #208 tests (which drive `InMemoryTraceBufferStore` — ALWAYS `file_*`-present since
 * PR-1) exercise precisely this provably-writer-scope-wins path; this claim is verified by running
 * those tests, not merely by this proof (see the PR-2 report's mutation-probe (f) transcript).
 */
function capacityWarning(result: AppendResult): string | undefined {
  const writerCountRatio = result.buffer_count / result.limit_count;
  const writerBytesRatio = result.buffer_bytes / result.limit_bytes;
  const writerRatio = Math.max(writerCountRatio, writerBytesRatio);

  const hasFileScope =
    result.file_count !== undefined &&
    result.file_limit_count !== undefined &&
    result.file_bytes !== undefined &&
    result.file_limit_bytes !== undefined;
  const fileCountRatio = hasFileScope ? result.file_count! / result.file_limit_count! : 0;
  const fileBytesRatio = hasFileScope ? result.file_bytes! / result.file_limit_bytes! : 0;
  const fileRatio = hasFileScope ? Math.max(fileCountRatio, fileBytesRatio) : 0;

  const ratio = Math.max(writerRatio, fileRatio);
  if (ratio < CAPACITY_WARNING_THRESHOLD) return undefined;

  if (hasFileScope && fileRatio >= writerRatio) {
    const binding = fileCountRatio >= fileBytesRatio ? 'entries' : 'bytes';
    const detail =
      binding === 'entries'
        ? `${result.file_count}/${result.file_limit_count} entries (${Math.round(fileCountRatio * 100)}%)`
        : `${result.file_bytes}/${result.file_limit_bytes} bytes (${Math.round(fileBytesRatio * 100)}%)`;
    return (
      `trace buffer for this step (whole-file, all writers combined) is at ${detail} of ` +
      'capacity, approaching the limit — reduce tracing verbosity or call execute_step to ' +
      'finalize the step before further appends are refused with BUFFER_FULL'
    );
  }

  const binding = writerCountRatio >= writerBytesRatio ? 'entries' : 'bytes';
  const detail =
    binding === 'entries'
      ? `${result.buffer_count}/${result.limit_count} entries (${Math.round(writerCountRatio * 100)}%)`
      : `${result.buffer_bytes}/${result.limit_bytes} bytes (${Math.round(writerBytesRatio * 100)}%)`;

  return (
    `trace buffer for this step is at ${detail} of capacity, approaching the limit — reduce ` +
    'tracing verbosity or call execute_step to finalize the step before further appends are ' +
    'refused with BUFFER_FULL'
  );
}

/** The specific settled/in-flight state for a step, or `undefined` if none apply — the granular
 *  counterpart to `isStepSettledOrInFlight` (issue #207 PR-2). `append_trace`'s refusal detail
 *  must name WHICH state applies: agent guidance differs by state (`in_progress` invites a retry
 *  once `execute_step` finishes; `completed`/`failed`/`skipped` are permanent). Checked in a fixed
 *  priority order, reused identically pre-CS and inside the `appendFenced` guard so both paths
 *  agree on the same taxonomy. */
function stepStateOf(
  run: RunRecord,
  stepId: string,
): 'completed' | 'failed' | 'skipped' | 'in_progress' | undefined {
  if (run.completed_steps.includes(stepId)) return 'completed';
  if (run.failed_steps.includes(stepId)) return 'failed';
  if (run.skipped_steps.includes(stepId)) return 'skipped';
  if (run.in_progress_steps.includes(stepId)) return 'in_progress';
  return undefined;
}

/** The full `append_trace` refusal taxonomy (issue #207 PR-2): every reason a trace append can be
 *  refused, pre-CS or from inside the `appendFenced` guard, is one of these six — always code
 *  `STATE_STEP_NOT_ELIGIBLE`, distinguished by `details.step_state`. `in_progress` is the only
 *  RESOLVABLE state (the claim will eventually settle) so it alone gets `agentAction:
 *  'resolve_precondition'` — matching `claimStep`'s own `STATE_STEP_ALREADY_CLAIMED` precedent
 *  (the same state must never yield two different agent actions depending on which tool observed
 *  it). The other five are permanent from this call's perspective and stay `report_to_user`. */
type StepEligibilityState =
  'completed' | 'failed' | 'skipped' | 'in_progress' | 'run_terminal' | 'run_not_found';

function stepNotEligibleError(
  stepId: string,
  runVersion: number,
  stepState: StepEligibilityState,
  extraDetails?: Record<string, unknown>,
): WorkflowError {
  const messages: Record<StepEligibilityState, string> = {
    completed: `Step '${stepId}' has already completed.`,
    failed: `Step '${stepId}' has already failed.`,
    skipped: `Step '${stepId}' was skipped.`,
    in_progress: `Step '${stepId}' is currently being executed by execute_step.`,
    run_terminal: `Run is terminal — trace entries can no longer be adopted by any step.`,
    run_not_found: `Run not found at write time — trace entries can no longer be adopted.`,
  };
  return new WorkflowError(messages[stepState], {
    code: 'STATE_STEP_NOT_ELIGIBLE',
    category: 'STATE',
    agentAction: stepState === 'in_progress' ? 'resolve_precondition' : 'report_to_user',
    retryable: false,
    details: { step_id: stepId, step_state: stepState, run_version: runVersion, ...extraDetails },
  });
}

/** Store-constructor names already warned about lacking the fenced trio (issue #207 PR-2) —
 *  module-level so a long-lived process warns once per store type, not once per call. Exported
 *  ONLY for test isolation (`resetUnfencedTraceStoreWarnings`) — production code never calls it. */
const warnedUnfencedStoreNames = new Set<string>();

/** Test-only reset hook (issue #207 PR-2): clears the dedup set so a test can assert the
 *  console.warn fires fresh, independent of any earlier test's use of a same-named store class. */
export function resetUnfencedTraceStoreWarnings(): void {
  warnedUnfencedStoreNames.clear();
}

/**
 * Builds the ok envelope's warnings + `writer_nonce_applied` marker (issue #197 PR-2) — shared by
 * all three append call sites (empty-probe, fenced, unfenced) so this logic lives in exactly one
 * place. `extraWarnings` carries whatever warnings that SPECIFIC call site already has (e.g. the
 * unfenced-store caveat) — capacity and not-persisted are always appended AFTER, matching each
 * call site's own pre-existing ordering convention.
 */
function buildAppendOkResult(
  result: AppendResult,
  writerNonce: string | undefined,
  carriageActive: boolean,
  extraWarnings: string[],
): AppendTraceOkResult {
  const warnings = [...extraWarnings];
  const capacity = capacityWarning(result);
  if (capacity !== undefined) warnings.push(capacity);
  if (writerNonce !== undefined && !carriageActive) {
    warnings.push('writer_nonce not persisted: attribution unavailable on this store');
  }
  return {
    status: 'ok',
    ...result,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(writerNonce !== undefined && carriageActive ? { writer_nonce_applied: true as const } : {}),
  };
}

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
    writer_nonce?: string | undefined;
  },
  stores?: HandleAppendTraceStores,
): Promise<AppendTraceOkResult> {
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  const traceBufferStore = stores?.traceBufferStore;

  // 1. Load the run. Throws STATE_RUN_NOT_FOUND if missing.
  const run = await runStore.get(args.run_id);

  // 1b. issue #187: reject a terminal run BEFORE any step guard or WAL write. A WAL appended to
  // a completed/failed/abandoned/aborted run is always unreadable residue — the step it names
  // will never finalize again, so nothing will ever adopt or delete it. This is the one orphan
  // source correct purge ordering structurally can't reach (a WAL born after purge's snapshot
  // but before the run-file unlink) — refusing it here means it is never created in the first
  // place. A terminal run is permanent, so this is agentAction: 'report_to_user' (NOT
  // provide_input/retryable — retrying can't un-terminate a run).
  if (isTerminalPhase(run.run_phase)) {
    throw new WorkflowError(
      `Run '${args.run_id}' is terminal (phase: '${run.run_phase}') — trace entries can no longer be adopted by any step.`,
      {
        code: 'STATE_STEP_NOT_ELIGIBLE',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
        details: {
          step_id: args.step_id,
          step_state: 'run_terminal',
          run_phase: run.run_phase,
          run_version: run.version,
        },
      },
    );
  }

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

  // 5. Pre-CS fast-fail eligibility check (issue #207 PR-2): granular step_state values aligned
  // to the guard taxonomy (stepStateOf/stepNotEligibleError, above) — 'skipped' is a NEW check
  // (the latent omission D3 identified: a skipped step could previously still accept a trace
  // append). Race-invariant: step existence and execution === 'agent' were already closed over
  // above: this check only reads the four step-membership arrays off the SAME pre-CS `run` load.
  const preCsState = stepStateOf(run, args.step_id);
  if (preCsState !== undefined) {
    throw stepNotEligibleError(args.step_id, run.version, preCsState);
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

  // issue #197 PR-2 (design §6): shape-validate BEFORE anything else touches the store — routes
  // every violation through ONE typed refusal, never a bare zod/SDK error.
  if (args.writer_nonce !== undefined) {
    validateWriterNonceShape(args.writer_nonce);
  }

  // issue #197 PR-2 (design §6, dormant strict posture — default off, zero behavior change):
  // non-agent steps already refused above (step 4), before this check ever runs.
  if (isWriterNonceRequired() && args.writer_nonce === undefined) {
    throw writerNonceRequiredError(args.step_id, run.version);
  }

  // issue #197 PR-2 (FLAG_GATING, design §3 activation gate): a nonce is carried ONLY when this
  // store genuinely declares writer_nonce_carriage — a non-declaring store must NEVER receive the
  // nonce argument at all (never merely ignore it silently inside the store call).
  const carriageActive = storeDeclaresNonceCarriage(traceBufferStore);
  const nonceOptions =
    args.writer_nonce !== undefined && carriageActive
      ? { writerNonce: args.writer_nonce }
      : undefined;

  // 6. Empty entries — return current buffer state without writing. Stays on the raw unlocked
  // path UNCONDITIONALLY (issue #207 PR-2, D3 §2) — writes nothing, so there is no settlement
  // race to fence against and no unfenced-store advisory to add here, regardless of what the
  // store declares. The CAPACITY warning (issue #208) still applies: this is the natural
  // read-your-capacity call — an agent probing at 85% full should see it just as a real append
  // would show it. issue #197 PR-2: the probe passes the nonce too (writer-scope numbers for the
  // probing writer specifically, not the whole file).
  if (args.entries.length === 0) {
    const result = await traceBufferStore.append(args.run_id, args.step_id, [], nonceOptions);
    return buildAppendOkResult(result, args.writer_nonce, carriageActive, []);
  }

  // 7. Append entries to the buffer.
  if (typeof traceBufferStore.appendFenced === 'function') {
    // Capability present (issue #207 PR-2): guard = ONE fresh lock-free runStore.get,
    // re-verifying the exact same premise the pre-CS check above already established, but at
    // write time — this is what closes append-trace.ts's Window A (D3 problem statement): a
    // concurrent execute_step claiming/settling the step between the pre-CS load and the
    // physical write. The guard performs exactly one store read and nothing else, per the fenced
    // trio's own contract.
    const appendFenced = traceBufferStore.appendFenced.bind(traceBufferStore);
    const guard = async (): Promise<void> => {
      let freshRun: RunRecord;
      try {
        freshRun = await runStore.get(args.run_id);
      } catch (err) {
        if (err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND') {
          throw stepNotEligibleError(args.step_id, run.version, 'run_not_found');
        }
        // Any other failure propagates UNWRAPPED, per the fenced trio's own guard contract —
        // never assume every guard failure fits this tool's own eligibility taxonomy.
        throw err;
      }
      if (isTerminalPhase(freshRun.run_phase)) {
        throw stepNotEligibleError(args.step_id, freshRun.version, 'run_terminal', {
          run_phase: freshRun.run_phase,
        });
      }
      const freshState = stepStateOf(freshRun, args.step_id);
      if (freshState !== undefined) {
        throw stepNotEligibleError(args.step_id, freshRun.version, freshState);
      }
    };
    const result = await appendFenced(args.run_id, args.step_id, args.entries, guard, nonceOptions);
    return buildAppendOkResult(result, args.writer_nonce, carriageActive, []);
  }

  // Capability absent (issue #207 PR-2): legacy unfenced append() — Window A stays open for this
  // store. Deduped console.warn (once per store constructor name, not once per call) plus an
  // envelope advisory on every success response — advisory only, never gates (#119); this branch
  // is unreachable once the store declares the trio.
  const storeName = traceBufferStore.constructor.name;
  if (!warnedUnfencedStoreNames.has(storeName)) {
    warnedUnfencedStoreNames.add(storeName);
    console.warn(
      `[append_trace] trace buffer store '${storeName}' does not declare the fenced trio (issue ` +
        '#207) — appended entries are not fenced against a concurrent settlement and may end up ' +
        'neither adopted nor refused. See the response envelope\'s "warnings" field for the ' +
        'same caveat on every affected call.',
    );
  }
  // issue #197 PR-2: an unfenced store can never satisfy the ladder (carriage requires seal
  // requires the fenced trio) — carriageActive is always false on this branch, so nonceOptions is
  // always undefined here and the not-persisted warning fires whenever a nonce was supplied.
  const result = await traceBufferStore.append(
    args.run_id,
    args.step_id,
    args.entries,
    nonceOptions,
  );
  // issue #208: capacity SECOND, after the pre-existing unfenced-store advisory — both (and the
  // #197 not-persisted caveat) may be present at once; each is an independent fact.
  return buildAppendOkResult(result, args.writer_nonce, carriageActive, [
    'this store does not fence trace appends against concurrent settlement; entries ' +
      'acknowledged here may not be adopted',
  ]);
}

/** Registers the append_trace MCP tool on the server. */
export function registerAppendTrace(server: McpServer, opts?: HandleAppendTraceStores): void {
  server.tool(
    'append_trace',
    [
      'Submit trace entries incrementally during an agent step, before calling execute_step.',
      'Entries are buffered and merged with any entries submitted at execute_step finalization.',
      'Delivery is best-effort: entries are durable after this call returns but are not canonical until execute_step completes.',
      'Only valid for agent steps that have not yet been claimed (before execute_step is called).',
      'Optional: writer_nonce — mint a fresh UUIDv4 per step-attempt (the SAME value on every',
      "append_trace call for this attempt, a NEW one next attempt) to get this attempt's own",
      'lines faithfully attributed instead of the honest-but-unattributed floor. Mint on BOTH',
      'append_trace and execute_step for this attempt, or neither — a guessable or reused nonce',
      'is worse than omitting one (it lets residue be adopted with no caveat, or silently folds a',
      'crashed attempt into this one).',
    ].join(' '),
    {
      run_id: z.string(),
      step_id: z.string(),
      entries: z.array(traceEntrySchema),
      // issue #197 PR-2 (design §6): UNBOUNDED at the zod layer — every shape violation
      // (empty/whitespace/too-long) routes through validateWriterNonceShape to ONE typed realm
      // envelope refusal, never a bare zod/SDK error.
      writer_nonce: z.string().optional(),
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
