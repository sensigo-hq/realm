// run-agent.ts — Core agent loop logic, decoupled from the Commander handler for testability.
// Exports runAgent(), AgentDeps, AgentRunOptions, and AgentRunResult.
// All Slack-specific gate notification logic lives in slack-gate-notifier.ts.
import { join } from 'node:path';
import {
  loadWorkflowFromFile,
  classifyInProgressClaims,
  executeChain,
  advanceRun,
  executeEngineStep,
  describePending,
  stepsThatCannotRun,
  cannotGoOnHere,
  describeClaimHolder,
  cannotRunClause,
  cannotRunWayOut,
  buildNextActions,
  findCapabilityBlockedSteps,
  unmetCapabilities,
  capabilityWarning,
  buildFailedAttemptRecord,
  WorkflowError,
  DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
  assessStructuredOutputEligibility,
  renderIneligibleMessage,
  pendingCleanupLine,
  classifyStop,
  isRaceStop,
  type NotRecordedKind,
  type RunStore,
  type WorkflowDefinition,
  type StepDefinition,
  type PendingGate,
  type ExtensionRegistry,
  type McpServerConfig,
  type ToolCallRecord,
  type TraceBufferStore,
  type StructuredOutputMeta,
  shellWord,
} from '@sensigo/realm';
import type {
  RunRecord,
  WorkflowRegistrar,
  UsageRecord,
  Attributed,
  DriveFailureRecord,
  ErrorCategory,
  ResponseEnvelope,
} from '@sensigo/realm';
import type { LlmProvider } from './providers/llm-provider.js';
import {
  sanitizeError,
  setAdditionalRedactionValues,
  renderValidationSummaryEntry,
  deriveLlmClock,
  safeErrorText,
  safeExplainFailure,
  appendRequests,
  type LlmClock,
} from './providers/agent-utils.js';
import { isToolCapable } from './providers/llm-provider.js';
import type { McpClient, ToolDefinition, ToolExecutor } from './mcp/mcp-extensions.js';
import { McpClient as McpClientImpl } from './mcp/mcp-client.js';
import { scheduleGateExpiryTimer } from './gate/gate-expiry-timer.js';
import { stoppedReasons } from '../commands/run-advance.js';
import { recordDriveFailure, buildEntry, MESSAGE_CAP } from './drive-failure.js';
import {
  answerNotRecordedLine,
  describeProgram,
  goOnLine,
  inFlightLine,
  outcomeNotRecordedLine,
  takenLine,
  waitingLine,
  resumeLine,
} from '../lib/holder-render.js';

export type AgentRunResult = 'completed' | 'failed';

/** issue #625 PR-2a (D6.2): how often the loop re-reads a run whose only work is in flight elsewhere. */
export const IN_FLIGHT_POLL_MS = 1000;
/** issue #625 PR-2a (D6.2): how long the loop watches an unchanged record before naming reclaim. */
export const IN_FLIGHT_WATCH_MS = 60000;

/**
 * issue #401 chokepoint 4's wedge record for a validation rejection — ONE mint, used by the
 * dispositions and by the drive's exit for an engine step refused on its input before its claim
 * (issue #625 PR-2a, decision C31), so the two can never record the wedge differently.
 */
function validationWedgeEntry(
  step: string,
  provider: string,
  errors: readonly string[],
  attemptStartedAt: number,
): DriveFailureRecord {
  return {
    at: new Date().toISOString(),
    step,
    provider,
    error_class: 'validation_rejected',
    message: sanitizeError(errors.join(', ')).slice(0, MESSAGE_CAP),
    elapsed_ms: Date.now() - attemptStartedAt,
  };
}

export interface AgentDeps {
  store: RunStore;
  workflowStore: WorkflowRegistrar;
  provider: LlmProvider;
  /**
   * Issue #313: the provenance identity for a third-party `--provider-module` provider, which
   * cannot declare a `providerId` capability of its own. Typed as the template literal so the
   * evidence field's union (which includes `module:${string}`) typechecks end-to-end with no
   * casts. In-repo providers leave this unset — their own capabilities() answer wins.
   */
  providerId?: `module:${string}`;
  registry: ExtensionRegistry;
  /**
   * When set, called for every pending gate. The handler is responsible for notifying
   * the relevant channel and blocking until the gate resolves.
   * Omit for terminal-only fallback (choices printed to terminal + store polling).
   */
  gateHandler?: (runId: string, gate: PendingGate) => Promise<void>;
  /**
   * Factory for creating an McpClient instance. Injected by tests for mock isolation.
   * Defaults to constructing a real McpClient when absent.
   */
  mcpClientFactory?: (servers: McpServerConfig[], signal?: AbortSignal) => McpClient;
  /**
   * REAL manifest-secret VALUES (values only, from the loaded extensions result) fed to
   * the provider-loop redaction pass — dotenv-sourced values are absent from process.env
   * and would otherwise pass tool results/traces unredacted. Never persisted.
   */
  redactionValues?: readonly string[];
  /**
   * Trace-buffer WAL store (issue #207 PR-2, D3 §5) — threaded straight into every `executeChain`
   * call below. Without this, `realm agent`'s driver never adopted/fenced a step's streamed
   * `append_trace` WAL content at all (the mixed-wiring gap D3 identifies: CLI executors passed
   * no `traceBufferStore`, so acknowledged appends were neither adopted nor refused when a CLI
   * runner settled). Constructed in `agent.ts`, beside the concrete `JsonFileStore`. Optional so
   * an existing caller that omits it keeps today's behavior exactly (no trace adoption at all).
   */
  traceBufferStore?: TraceBufferStore;
  /**
   * Issue #625 (the holder slice): the program this driver runs in — its name, how that name is
   * known, and its channel (`agent`). Written as `holder` on the claim of every step the driver
   * takes, as `driven_by` on those steps' evidence, and on the cleanup steps its timer drains. A
   * label for people and replies; never compared. Absent ⇒ none recorded.
   */
  driver?: Attributed;
  /**
   * Mint a FRESH `writer_nonce` (UUIDv4) per step-attempt (issue #197 PR-2) — resolved once in
   * `agent.ts` from `--mint-writer-nonce` OR'd with the `REALM_REQUIRE_WRITER_NONCE` strict-flip
   * (design §8: the strict posture force-enables minting even without the flag). Default `false`/
   * absent ⇒ today's byte-identical ⊥ (bare) behavior. Never a caller-fixed value — a fresh
   * `crypto.randomUUID()` is minted independently for EVERY step-attempt in the loop below.
   */
  mintWriterNonce?: boolean;
  /**
   * Budget for issue #217's in-drive schema-feedback repair loop: how many times the drive
   * re-prompts an `execution: 'agent'` step after its output/input is rejected by
   * output_schema/input_schema validation, appending the validator's errors to the prompt.
   * Threaded exactly like `mintWriterNonce` above (agent.ts's `--schema-retries` flag → both
   * runAgent call sites → this field). Default `2` when omitted (mirrors the CLI flag's own
   * default) — `0` disables the loop entirely, reproducing today's single-attempt behavior
   * byte-for-byte.
   */
  schemaRetries?: number;
  /**
   * issue #401 — the fallback per-ATTEMPT ceiling for model requests, in seconds. Threaded from
   * `realm agent --llm-timeout` through both runAgent call sites. A step's own
   * `llm_timeout_seconds` WINS; this fills in for every step that did not author one (the
   * `--schema-retries` precedent). Absent ⇒ 600 (ten minutes), which is what the SDKs already
   * used as their own default request timeout — so the default drive behaves as it did, except
   * that the bound is now realm's, is attributed when it fires, and covers retries too.
   */
  llmTimeoutSeconds?: number;
  /**
   * Issue #676 — the flags this drive was started with (the model flags, `--extensions-module`,
   * `--project`, a non-default `--schema-retries`, `--llm-timeout`, `--mint-writer-nonce`; see
   * `buildReattachFlags`), already quoted for a shell. The in-drive "re-attach" line repeats them,
   * so following it continues the same drive: realm has no default model, and a step blocked on a
   * missing handler is usually fixed through `--extensions-module`. Set by `realm agent`. Absent (a
   * host that calls `runAgent` itself) ⇒ the line prints `--provider <provider> --model <model>`
   * for the operator to fill in.
   */
  reattachFlags?: string;
}

/**
 * Dormant strict posture (issue #197 PR-2, design §6 — the #169→#170 template): read PER CALL,
 * never cached at module load (a test flips the env var mid-process). "on" = set to any
 * non-empty value other than `'0'`/`'false'`. A strict-flip force-enables minting even without
 * `--mint-writer-nonce` (design §8).
 */
function shouldMintWriterNonce(deps: Pick<AgentDeps, 'mintWriterNonce'>): boolean {
  const v = process.env['REALM_REQUIRE_WRITER_NONCE'];
  const required = v !== undefined && v !== '' && v !== '0' && v !== 'false';
  return deps.mintWriterNonce === true || required;
}

/**
 * decision C189: whether this drive's own engine call for the agent step `step` recorded the drive's
 * answer — read off that call's reply, on every reply branch, never off the line the drive prints:
 * - a reply that a step the engine ran AFTER `step` produced (`stopped_step` names another step:
 *   `step`'s own call returned `ok`, so it settled) — a question that step opened, a step that cannot
 *   run here, a refusal or failure of that step;
 * - the question the answer opened on `step` itself (`confirm_required` carrying the answer's own
 *   evidence entry: the write that opens the gate records it), or an `ok` reply carrying evidence;
 * and never: an `ok` or `confirm_required` reply with no evidence (the run had ended, `step` was
 * already settled, or another call's question was already open: nothing was written), nor a refusal
 * or failure of `step` itself. An `error` that names no step (an error of the chain itself) says
 * nothing about `step`, and is not counted; the drive stops on it with exit code 1 and prints no
 * `Result` line, the one reader of the answer.
 *
 * @internal Exported for testing only.
 */
export function answerRecordedByCall(
  reply: Pick<ResponseEnvelope, 'status' | 'evidence' | 'stopped_step'>,
  step: string,
): boolean {
  if (reply.stopped_step !== undefined && reply.stopped_step !== step) return true;
  return (
    (reply.status === 'ok' || reply.status === 'confirm_required') && reply.evidence.length > 0
  );
}

export interface AgentRunOptions {
  /** Path to workflow.yaml file. Required when definition is not provided. */
  workflowPath?: string;
  /** Inline workflow definition — bypasses loadWorkflowFromFile when provided. */
  definition?: WorkflowDefinition;
  /**
   * Attach to an existing run instead of creating a new one.
   * When set, runAgent() skips deps.store.create() and uses this ID directly.
   * Mutually exclusive with workflowPath — runAgent() throws if both are set.
   */
  existingRunId?: string;
  params: Record<string, unknown>;
  /** Poll interval in ms for the terminal-only fallback. Defaults to 3000. Lower values are useful in tests. */
  pollIntervalMs?: number;
  /**
   * issue #625 PR-2a (D6.2): with nothing eligible and a step in flight, the loop re-reads the
   * record every `inFlightPollMs` (default {@link IN_FLIGHT_POLL_MS}) and re-enters on any change;
   * after `inFlightWatchMs` (default {@link IN_FLIGHT_WATCH_MS}) with no change it names the
   * reclaim command and exits. Injectable for tests.
   */
  inFlightPollMs?: number;
  inFlightWatchMs?: number;
  /**
   * When true, persist the workflow definition to ~/.realm/workflows/ so that
   * `realm run inspect` and `realm run list` can resolve it by ID.
   * Defaults to false — realm agent does not register workflows as a side effect.
   */
  register?: boolean;
}

/**
 * Renders a display template against a flat vars object.
 * Syntax: {{ field }} or {{ nested.field }} — plain dot-path interpolation, no filters.
 * Missing paths render as empty string.
 */
function renderDisplay(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const parts = expr.trim().split('.');
    let val: unknown = vars;
    for (const part of parts) {
      if (typeof val !== 'object' || val === null) {
        val = undefined;
        break;
      }
      val = (val as Record<string, unknown>)[part];
    }
    return val === undefined ? '' : typeof val === 'string' ? val : JSON.stringify(val);
  });
}

/**
 * Formats a step output object as human-readable plain text for the terminal.
 * Renders `headline` and `message` string fields directly; falls back to JSON.
 */
function formatOutputForTerminal(output: Record<string, unknown>): string {
  const headline = typeof output['headline'] === 'string' ? output['headline'] : undefined;
  const message = typeof output['message'] === 'string' ? output['message'] : undefined;

  if (headline !== undefined || message !== undefined) {
    const parts: string[] = [];
    if (headline !== undefined) parts.push(headline);
    if (message !== undefined) parts.push(message);
    return parts.join('\n\n');
  }

  if (Object.keys(output).length === 0) {
    return '(no output)';
  }

  return JSON.stringify(output, null, 2);
}

async function pollUntilGateResolved(
  store: RunStore,
  runId: string,
  gateId: string,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  console.log('   Waiting for approval...');
  for (;;) {
    if (signal?.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      if (signal !== undefined) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }
    });
    if (signal?.aborted) break;
    const run = await store.get(runId);
    if (run.terminal_state) break;
    if (run.pending_gate === undefined || run.pending_gate.gate_id !== gateId) break;
  }
}

/**
 * Runs a workflow to completion using the provided dependencies.
 * Returns 'completed' when the run finishes normally; 'failed' otherwise.
 * Throws on setup failures (e.g. workflow file not found, provider error).
 */
export async function runAgent(deps: AgentDeps, options: AgentRunOptions): Promise<AgentRunResult> {
  if (options.existingRunId !== undefined && options.workflowPath !== undefined) {
    throw new Error('existingRunId and workflowPath are mutually exclusive');
  }

  // Manifest-secret redaction (values only, set ONCE per run): tool results and
  // tool-execution errors serialized by the provider loop get these values masked
  // alongside process.env values.
  setAdditionalRedactionValues(deps.redactionValues ?? []);

  // issue #217: resolved once per run (not per call, unlike shouldMintWriterNonce — there is no
  // env-var strict-flip counterpart here). `0` disables the repair loop entirely.
  const schemaRetries = deps.schemaRetries ?? 2;

  // issue #401 — the per-ATTEMPT ceiling in seconds, before the per-step key overrides it.
  // 600s is the SDKs' own default request timeout, so an unconfigured drive keeps today's
  // per-attempt patience; what changes is that the bound is realm's, it also covers the SDK's
  // internal retries, and a fired bound says which lever to raise.
  const fallbackLlmTimeoutSeconds = deps.llmTimeoutSeconds ?? 600;

  // issue #236 — sticky downgrade (design §4 [Rv8]): per step, homed HERE (run-agent scope,
  // beside the verdict) — survives BOTH remaining loops (the provider ladder ⊂ the #217 repair
  // loop; the 2-attempt callStep wrapper that used to sit between them was retired by issue #401,
  // because silently retrying is what made a failing drive invisible). Once armed for a step,
  // every LATER attempt for that SAME
  // step name (across repair iterations, across a re-attach) never re-sends strict — it goes
  // straight to the ORIGINAL downgrade_reason/api_message. Never cleared for the run's lifetime
  // (R-Q: a non-grammar 503 disables prevention for the whole drive session — accepted, the
  // `service_unavailable` labeling makes it auditable).
  const structuredOutputSticky = new Map<
    string,
    {
      downgrade_reason: NonNullable<StructuredOutputMeta['downgrade_reason']>;
      api_message?: string;
    }
  >();

  // issue #311 — the TOOL-ARGUMENTS sticky map. Deliberately PARALLEL to (never merged with)
  // `structuredOutputSticky` above: the two dimensions fail independently, and merging them would
  // let a step-output downgrade silently disable tool-args strict (or vice versa). Nothing reads
  // this map except the tools path, and nothing reads that map except the non-tools path.
  //
  // Same key (step name) and same invocation scope. The ARMING RULE differs by design (D3 §5,
  // the named R10 divergence from #236's accepted R-Q residual): only a 400
  // (`api_rejected_schema`) arms this map, because a rejected schema will be rejected identically
  // on every later attempt — retrying it is pure waste. A 503 does NOT arm it: overload is
  // transient, and letting it disable tool-args strict for the rest of the drive session would
  // trade a momentary blip for a session-long silent capability loss.
  const toolArgsSticky = new Map<string, { reason: string; api_message?: string }>();

  // issue #313 — read the provider's capabilities ONCE for the whole drive (they are constant
  // per instance) and derive the three facts every dimension needs from them.
  const caps = deps.provider.capabilities();
  // Evidence provenance: an in-repo provider names itself; a third-party module cannot, so
  // agent.ts supplies `module:<basename>` instead. Undefined only if neither applies.
  const providerForEvidence = caps.providerId ?? deps.providerId;
  // Which provider's strict RULES to assess schemas against. Module providers fall to the
  // Anthropic profile — realm cannot know a module's dialect — and the `provider` field above is
  // what makes that assumption visible if the module in fact targets a different API.
  const profile = caps.providerId === 'openai' ? ('openai' as const) : ('anthropic' as const);
  // issue #313 (D-3 precedence rule 1): the endpoint gate is only MEANINGFUL for a provider that
  // could otherwise place the marker on the wire. A gate on a non-consuming provider says nothing
  // extra — `provider_unsupported` is already the whole truth there — so it is resolved to
  // undefined rather than allowed to compete with that literal.
  // Does this provider actually place per-tool strict on the wire? Read from the same one-shot
  // `caps` as the rest of the drive-level facts (issue #350's guard; hoisted here in #313 so the
  // gate below can be derived from it — same value, one read instead of one per step). Both
  // in-repo tool-capable providers declare it; third-party modules do not.
  const strictCapable = caps.toolArgsStrict === true;
  const gate = strictCapable ? caps.strictGate : undefined;

  // Load or use provided definition.
  const definition: WorkflowDefinition =
    options.definition !== undefined
      ? options.definition
      : loadWorkflowFromFile(
          options.workflowPath!.endsWith('.yaml') || options.workflowPath!.endsWith('.yml')
            ? options.workflowPath!
            : join(options.workflowPath!, 'workflow.yaml'),
        );

  // Register only when explicitly requested (--register flag).
  // By default realm agent does not write to ~/.realm/workflows/ as a side effect.
  if (options.register === true) {
    await deps.workflowStore.register(definition);
  }

  let runId: string;
  // Declared without an initialiser and narrowed by `currentRun === undefined` below: the attach
  // path always assigns it, and keying the moved re-read on the value rather than on the option
  // is what keeps control-flow analysis satisfied.
  let currentRun: RunRecord | undefined;
  // decision C179: the agent steps this drive answered — the `Result` line names the program that
  // gave any other answer. Decision C189: filled from each engine call's reply (`answerRecordedByCall`).
  const answeredHere = new Set<string>();
  // decision C179: the drive stopped on a step another process holds (the 60s watch ended unchanged).
  let stoppedOnInFlight = false;

  if (options.existingRunId !== undefined) {
    // --run-id path: attach to existing run
    currentRun = await deps.store.get(options.existingRunId);
    if (currentRun.terminal_state) {
      // issue #279 (increment 1, PR-B), design record §6: point at the recovery verb when the
      // terminal run this attach targeted still carries an undelivered finalizer.
      const pendingFinalizerCount = Object.values(currentRun.finalizer_ledger ?? {}).filter(
        (e) => e.status === 'pending',
      ).length;
      const drainHint =
        pendingFinalizerCount > 0
          ? ` ${pendingFinalizerCount} finalizer(s) not yet delivered — realm run drain ${options.existingRunId}.`
          : '';
      throw new Error(
        `Run ${options.existingRunId} is already in terminal state: ${currentRun.terminal_reason ?? currentRun.run_phase}.${drainHint}`,
      );
    }
    runId = options.existingRunId;
    // in_progress_steps on attach: handled by engine's existing eligibility logic — no restart needed
  } else {
    // Normal path: create new run
    const { run: initialRecord } = await deps.store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: options.params,
    });
    runId = initialRecord.id;
  }

  // ═══ issue #401, CHOKEPOINT (3) — the last-resort catch opens HERE ═══
  //
  // It opens the moment `runId` exists and not before: everything above is pre-run, so a throw
  // there has no record to attach itself to and the console is the only honest floor. Everything
  // BELOW is a failed drive attempt on a real run, and every one of them used to vanish.
  //
  // The MCP-init block moved inside deliberately — its unknown-server and tool-incapable throws
  // are exactly the "run created, then died before any step ran" case that read healthy for 24
  // hours.
  let currentStepName: string | undefined;
  // issue #600: at FUNCTION scope so the last-resort catch below can see what the current step
  // billed. Both are reset where each step begins (inside the step loop). `stepUsageSaved` turns
  // true only once the step's repair loop has ended — `executeChain` returned for its final
  // attempt — so from then on the step's calls live on its record and are never attached twice.
  let usageForStep: UsageRecord[] | undefined;
  let stepUsageSaved = false;
  // #600: whether the driven step's calls are ALREADY on its record. Chokepoints 3 and 4 attach
  // `usageForStep` to a drive-failure entry; when the failure belongs to a step `executeChain` ran
  // AFTER the driven step saved, those calls are already on that step's evidence, and attaching them
  // again would count them twice. Keyed on CONTENT (the step's first billed request appearing on one
  // of its entries), never on a count or a version: the step's own claim moves the version while its
  // calls stay unsaved, and other writers add entries for the step that carry none of its calls (a
  // reclaim's audit line, a compensating un-claim, another driver's save). A failed re-read answers
  // `false`, so the calls are attached: the store is failing, and the entry likely will not land.
  const sameRequest = (a: UsageRecord, b: UsageRecord): boolean =>
    a.request_start === b.request_start &&
    a.prompt_tokens === b.prompt_tokens &&
    a.output_tokens === b.output_tokens;
  const callsAlreadyRecorded = async (
    step: string,
    calls: readonly UsageRecord[],
  ): Promise<boolean> => {
    const first = calls[0];
    if (first === undefined) return false;
    return deps.store.get(runId).then(
      (r) =>
        r.evidence.some(
          (e) =>
            e.step_id === step &&
            (e.diagnostics?.cache?.requests ?? []).some((q) => sameRequest(q, first)),
        ),
      () => false,
    );
  };
  // decision C205: a drive that stops on a run that ended with a failed step `realm run resume`
  // takes gives the way back in — the line `realm workflow run` gives (`  Resume:    …`).
  // decision C211 (walk c14 W3-4's class): and cleanup steps the ending left pending — the command
  // that runs them.
  const printResumeLine = async (): Promise<void> => {
    const ended = await deps.store.get(runId).catch(() => undefined);
    const line = ended === undefined ? undefined : resumeLine(ended, definition);
    if (line !== undefined) console.error(line);
    const cleanup = ended === undefined ? undefined : pendingCleanupLine(ended, new Date());
    if (cleanup !== undefined) console.error(cleanup);
  };
  let attemptStartedAt = Date.now();
  try {
    if (currentRun === undefined) {
      currentRun = await deps.store.get(runId);

      // #134 pre-flight (WARN-only, never refuse): warn at CREATE only. The attach path (--run-id)
      // above is N-A — it re-drives an EXISTING run, where recoverable-settle + the A5 surfaces
      // already handle a capability block. `deps.registry` is always a real registry, so the
      // `?? createDefaultRegistry()` invariant holds structurally.
      for (const req of unmetCapabilities(definition, deps.registry)) {
        console.warn(`⚠ ${capabilityWarning(req)}`);
      }
    }

    console.log(`\nRealm Agent — ${definition.name} v${definition.version}`);
    console.log(`Run ID: ${runId}\n`);

    // Initialise MCP client if any steps declare tools.
    let mcpClient: McpClient | undefined;
    if (definition.mcp_servers !== undefined && definition.mcp_servers.length > 0) {
      const serverIds = new Set(definition.mcp_servers.map((s) => s.id));
      for (const step of Object.values(definition.steps)) {
        for (const toolEntry of step.tools ?? []) {
          const serverId = toolEntry.split(':')[0] ?? '';
          if (!serverIds.has(serverId)) {
            throw new Error(`Step tool '${toolEntry}' references unknown MCP server '${serverId}'`);
          }
        }
      }
      mcpClient = (deps.mcpClientFactory ?? ((s, sig) => new McpClientImpl(s, sig)))(
        definition.mcp_servers,
        undefined, // AbortSignal not threaded into runAgent — disconnect() is in finally
      );
      if (!isToolCapable(deps.provider)) {
        throw new Error(
          'This workflow uses MCP tool-enabled steps, but the configured LLM provider does not support tool calling. ' +
            'Reasoning models (o1-series) and custom non-tool providers cannot run tool-enabled steps. ' +
            'Use a model that supports tool calling, with --provider openai or --provider anthropic.',
        );
      }
    }

    try {
      // issue #625 PR-2a (decisions C17, C23): an engine step that cannot run HERE — refused before
      // its claim, or capability-blocked — is named once per drive.
      const reportedRefusals = new Set<string>();
      // decision C182: the claims the drive has said it waits on (step and claim), each said once.
      const waitingSaid = new Set<string>();
      // decision C23: a capability block's reply from the loop-top `advanceRun`, held per step — it is
      // this drive's exit only when nothing else can run.
      const heldCapabilityReplies = new Map<string, Awaited<ReturnType<typeof advanceRun>>>();
      const keepsClaims = deps.store.persistsClaims === true;

      // decision C159: the questions whose due expiry this drive has handed to `advanceRun` — each
      // once, so a question the call could not carry out is announced (and timed) as before.
      const expiryAttempted = new Set<string>();
      while (!currentRun.terminal_state) {
        // --- Gate handling ---
        // decision C159: a question whose time is up and whose `on_expiry` the engine carries out is
        // never announced as live (no `Waiting for approval…`, no `--choice` commands an answer could
        // no longer be recorded through): the engine's work below — `advanceRun` — carries the
        // expiry out first and prints its line.
        const dueExpiry =
          currentRun.pending_gate !== undefined &&
          !expiryAttempted.has(currentRun.pending_gate.gate_id) &&
          describePending(definition, currentRun, deps.registry, new Date()).expiry_due !==
            undefined;
        if (dueExpiry) expiryAttempted.add(currentRun.pending_gate!.gate_id);
        if (currentRun.pending_gate !== undefined && !dueExpiry) {
          const gate = currentRun.pending_gate;

          console.log(`\n⏸  Gate: ${gate.step_name} | ID: ${gate.gate_id}`);
          const gateStepDef = definition.steps[gate.step_name];
          const gateText =
            gate.resolved_message ??
            (gateStepDef?.display !== undefined
              ? renderDisplay(gateStepDef.display, gate.preview)
              : formatOutputForTerminal(gate.preview));
          const indented = gateText
            .trimEnd()
            .split('\n')
            .map((l) => `   ${l}`)
            .join('\n');
          console.log('\n' + indented + '\n');

          if (deps.gateHandler !== undefined) {
            await deps.gateHandler(runId, gate);
          } else {
            // Terminal fallback: print each choice as a command and poll.
            for (const choice of gate.choices) {
              const label = choice.charAt(0).toUpperCase() + choice.slice(1);
              console.log(
                `   ${label}: realm run respond ${runId} --gate ${gate.gate_id} --choice ${shellWord(choice)}`,
              );
            }
            // issue #291 (Deliverable 4e, Amendment 4): the ATTENDING-PROCESS enactment timer —
            // this IS "the non-Slack agent poll loop" the design names as its own timer host. A
            // no-op for a finding-only/non-expiring gate.
            const clearExpiryTimer = scheduleGateExpiryTimer(runId, gate, {
              store: deps.store,
              definition,
              registry: deps.registry,
              ...(deps.driver !== undefined ? { driver: deps.driver } : {}),
            });
            try {
              await pollUntilGateResolved(
                deps.store,
                runId,
                gate.gate_id,
                options.pollIntervalMs ?? 3000,
              );
            } finally {
              clearExpiryTimer();
            }
          }

          currentRun = await deps.store.get(runId);
          continue;
        }

        // --- The engine's work first (issue #625 PR-2a, D4.2) ---
        // Guards, then every runnable `auto` step, through the ONE core call every driver uses. The
        // loop below never names an `auto` step itself.
        let engineStep: string | undefined;
        // The step `advanceRun` started last and has not yet been seen to complete: its `✓ → <phase>`
        // line is printed when the next step starts, or after the call returns `ok` — the same line
        // the agent path prints for a step it completes (`realm agent`'s documented screen).
        let startedNotDone: string | undefined;
        const advanced = await advanceRun(deps.store, definition, {
          runId,
          caller: 'agent',
          // decision C159: the line that says this call carried out an expired question, first.
          onExpiry: (line) => console.log(`⚠ ${line}`),
          registry: deps.registry,
          ...(deps.traceBufferStore !== undefined
            ? { traceBufferStore: deps.traceBufferStore }
            : {}),
          ...(deps.driver !== undefined ? { driver: deps.driver } : {}),
          onStep: (step) => {
            if (startedNotDone !== undefined) console.log('  ✓ → running');
            startedNotDone = step;
            console.log(`→ [auto] ${step}`);
            // issue #401: a throw from here on mints with this engine step's name, and its
            // elapsed time is measured from this step's start.
            currentStepName = step;
            attemptStartedAt = Date.now();
            engineStep = step;
          },
          // D6.1: another process took an engine step — the same past-tense line as for an agent
          // step; `advanceRun` re-reads and continues.
          onTaken: (step, record) => {
            startedNotDone = undefined;
            console.log(takenLine(step, describeClaimHolder(record.claims?.[step], keepsClaims)));
          },
          // F7: an engine step this call ran whose outcome another program's act kept from being
          // recorded — the race is core's to name, and its loop goes on; the line is the one
          // `realm run advance` prints, never `✓` and never `✗ … failed`.
          onNotRecorded: (step, kind, record) => {
            startedNotDone = undefined;
            console.log(outcomeNotRecordedLine(kind, record, step, keepsClaims));
          },
        });
        if (advanced.status === 'confirm_required') {
          currentRun = await deps.store.get(runId);
          continue;
        }
        // A non-`ok` reply from an engine step goes into the dispositions below (decision C15):
        // the step name and the reply are set as the agent path sets them, and nothing is moved.
        let engineReply: typeof advanced | undefined;
        if (advanced.status !== 'ok') {
          if (engineStep === undefined) {
            // A refusal before any step ran (a guard refusal, a store failure): today's failed exit.
            console.error(`\n✗ ${advanced.errors.join(', ') || advanced.context_hint}`);
            await printResumeLine();
            return 'failed';
          }
          // F7: core's classifier names the stop (a race never reaches here — core's loop goes on).
          const advancedStop = classifyStop(advanced, engineStep, await deps.store.get(runId));
          if (advancedStop?.kind === 'capability') {
            // decision C23: a capability block is an engine step that cannot run HERE, the same class
            // as a refusal before the claim. Held, not sent to the dispositions at once: the attempt
            // wrote its marker, so the view below names the step, and the loop goes on with the
            // ready agent steps.
            heldCapabilityReplies.set(engineStep, advanced);
          } else {
            engineReply = advanced;
          }
        }
        if (engineReply === undefined) {
          currentRun = await deps.store.get(runId);
          if (advanced.status === 'ok' && startedNotDone !== undefined) {
            console.log(`  ✓ → ${currentRun.run_phase}`);
          }
          if (currentRun.terminal_state) break;
          if (currentRun.pending_gate !== undefined) continue;
          // decisions C17, C23, C82: a step that cannot run — an engine step refused before its claim
          // or capability-blocked, or an agent step refused before its claim — is named once per
          // drive, and the loop goes on with the ready agent steps. The words are core's
          // (decision C36).
          for (const e of stepsThatCannotRun(
            describePending(definition, currentRun, deps.registry, new Date()),
          )) {
            if (!reportedRefusals.has(e.step)) {
              reportedRefusals.add(e.step);
              console.log(`• Step ${cannotRunClause(e)}`);
            }
          }
        }

        // --- Step execution: agent steps only ---
        // decision C82: the agent steps the run's view offers — an agent step it refuses before its
        // claim (trust, precondition) is never picked, so no model is asked to answer it.
        const eligible =
          engineReply !== undefined
            ? []
            : describePending(definition, currentRun, deps.registry, new Date()).agent_steps;
        if (engineReply === undefined && eligible.length === 0) {
          // decisions C23, C31, C64, C82: the run cannot go on from here (`cannotGoOnHere`: no agent
          // step is ready, no engine step can run, nothing is in flight elsewhere — a step another
          // program holds may still change what can run — and a step cannot run): the drive stops
          // on the FIRST such step (definition order). With a step in flight it watches below.
          const view = describePending(definition, currentRun, deps.registry, new Date());
          const cannotRun = stepsThatCannotRun(view);
          if (cannotGoOnHere(currentRun, view)) {
            const stop = cannotRun[0]!;
            const first = stop.step;
            if (definition.steps[first]?.execution === 'agent') {
              // decision C82: an agent step refused before its claim (trust, precondition) — the
              // view's verdict on this record, and nothing is called: the step's input would be a
              // model's answer, the call its refusal rules out. Nothing is recorded, as for an engine
              // step refused for trust or precondition. (`cannotGoOnHere` holds only on a run that is
              // still open, so the way out is said of an open run — F7 (e).)
              console.error(
                `\n✗ The drive stops: nothing else can run, and '${first}' cannot run (${stop.refused_by}). ` +
                  cannotRunWayOut(currentRun, definition, view),
              );
              return 'failed';
            }
            const preClaim = stop.refused_by !== 'capability';
            // capability (decision C23): the block's own exit — the capability block this drive
            // holds for the step, otherwise one attempt after the claim (`→ [auto]`, then the block's
            // `⚠ … re-attach` line). A refusal before the claim (decision C31) takes no attempt line
            // and never enters the dispositions: the engine's refusal is read with one write-free call.
            let exitReply = preClaim ? undefined : heldCapabilityReplies.get(first);
            if (exitReply === undefined) {
              if (!preClaim) console.log(`→ [auto] ${first}`);
              currentStepName = first;
              attemptStartedAt = Date.now();
              exitReply = await executeEngineStep(deps.store, definition, {
                runId,
                step: first,
                // decision C151: an expiry this call carries out names `realm agent`.
                caller: 'agent',
                run: currentRun,
                registry: deps.registry,
                ...(deps.traceBufferStore !== undefined
                  ? { traceBufferStore: deps.traceBufferStore }
                  : {}),
                ...(deps.driver !== undefined ? { driver: deps.driver } : {}),
              });
            }
            // F7: the reply read by core's classifier against the record as it is now — a race
            // (another program took the step, ran it, ended the run, or opened a question, in the
            // moment between the view and this call) is not this drive's stop: it goes on, and its
            // own end and question checks speak.
            currentRun = await deps.store.get(runId);
            const exitStop = classifyStop(exitReply, first, currentRun);
            if (isRaceStop(exitStop)) {
              if (exitStop.kind === 'taken' && !exitStop.ran_here) {
                console.log(
                  takenLine(first, describeClaimHolder(currentRun.claims?.[first], keepsClaims)),
                );
              } else if (exitStop.ran_here) {
                console.log(
                  outcomeNotRecordedLine(
                    exitStop.kind as NotRecordedKind,
                    currentRun,
                    first,
                    keepsClaims,
                  ),
                );
              }
              continue;
            }
            const refusedBeforeClaim =
              preClaim &&
              (exitReply.error_code === 'VALIDATION_TRUST_VALUE' ||
                exitReply.error_code === 'VALIDATION_INPUT_SCHEMA' ||
                exitReply.status === 'blocked');
            if (refusedBeforeClaim) {
              // decision C31: the drive failure, recorded exactly as chokepoint 4 records it — an input
              // schema refusal wedges the run with nothing on its record, so it is `validation_rejected`
              // with the engine's own message and the step; trust and precondition record nothing, as
              // before #625. No model call was made, so no usage rides along.
              if (exitReply.error_code === 'VALIDATION_INPUT_SCHEMA') {
                await recordDriveFailure(
                  deps.store,
                  runId,
                  validationWedgeEntry(
                    first,
                    providerForEvidence ?? 'unknown',
                    exitReply.errors,
                    attemptStartedAt,
                  ),
                );
              }
              currentRun = await deps.store.get(runId);
              // F7 (e): the way out is said only of a run that is still open — a run another program
              // ended meanwhile goes to the drive's own end check.
              if (currentRun.terminal_state) continue;
              // decision C44: the way out is to correct the workflow and register it again (the run
              // picks up the corrected definition), then advance — or to end the run.
              console.error(
                `\n✗ The drive stops: nothing else can run, and '${first}' cannot run (${stop.refused_by}). ` +
                  cannotRunWayOut(
                    currentRun,
                    definition,
                    describePending(definition, currentRun, deps.registry, new Date()),
                  ),
              );
              return 'failed';
            }
            if (exitReply.status === 'error') {
              engineReply = exitReply;
              engineStep = first;
            } else {
              // The step became runnable between the view and the attempt, and ran: go on.
              continue;
            }
          }
        }
        if (engineReply === undefined && eligible.length === 0) {
          // issue #625 PR-2a (D6.2): a step in flight elsewhere (the open gate's own step is not "in
          // flight" — it holds a claim while it waits) — watch the record and re-enter on any change.
          const inFlight = currentRun.in_progress_steps.filter(
            (step) => step !== currentRun!.pending_gate?.step_name,
          );
          if (inFlight.length > 0) {
            const pollMs = options.inFlightPollMs ?? IN_FLIGHT_POLL_MS;
            const watchMs = options.inFlightWatchMs ?? IN_FLIGHT_WATCH_MS;
            // decision C182: what the drive waits for and who holds it, said once for each claim it
            // waits on — `realm workflow run`'s line.
            for (const step of inFlight) {
              const claim = currentRun.claims?.[step];
              const key = `${step}\u0000${claim?.token ?? claim?.since ?? ''}`;
              if (waitingSaid.has(key)) continue;
              waitingSaid.add(key);
              console.log(waitingLine(step, describeClaimHolder(claim, keepsClaims), watchMs));
            }
            const startVersion = currentRun.version;
            const watchStarted = Date.now();
            let changed = false;
            while (Date.now() - watchStarted < watchMs) {
              await new Promise((resolve) => setTimeout(resolve, pollMs));
              const fresh = await deps.store.get(runId);
              if (fresh.version !== startVersion) {
                currentRun = fresh;
                changed = true;
                break;
              }
            }
            if (changed) continue;
            const states = new Map(
              classifyInProgressClaims(currentRun).map((c) => [c.step, c.state]),
            );
            for (const step of inFlight) {
              const described = describeClaimHolder(currentRun.claims?.[step], keepsClaims);
              const stale = states.get(step) === 'claim_stale';
              console.log(inFlightLine(runId, step, described, stale, watchMs));
            }
            // decision C195: the way on once the program holding the step is done with it — this
            // drive again, with the flags it was started with (`realm workflow run`'s hand-back,
            // C188, gives `realm run advance` the same way).
            console.log(
              goOnLine(
                inFlight,
                `realm agent --run-id ${runId} ${deps.reattachFlags ?? '--provider <provider> --model <model>'}`,
              ),
            );
            // decision C179: the drive stops on the step another process holds; the run did not end,
            // so no `Run ended in phase` line follows.
            stoppedOnInFlight = true;
          }
          break;
        }

        const stepName =
          engineReply !== undefined && engineStep !== undefined ? engineStep : eligible[0]!;
        // issue #401: never cleared. A throw AFTER this step settles mints with this step's name,
        // and conjunct (iv) of the drive_failing predicate then suppresses the finding — because
        // progress DID happen. Chosen, not incidental.
        currentStepName = stepName;
        const stepDef: StepDefinition = definition.steps[stepName]!;

        // issue #401 — the clock for THIS step's model requests. The step's own authored key
        // WINS; the CLI flag fills in for a step that never authored one; 600s if neither
        // (the --schema-retries precedent, exactly). `deriveLlmClock` turns the per-ATTEMPT
        // seconds into the whole-create ceiling — per-attempt × (retries + 1), plus the SDK's
        // own worst-case backoff sleeping, plus a download allowance for a slow response body.
        //
        // The SOURCE is computed here, once, and travels with the clock. Two disclosures depend
        // on it and nothing else does: whether the recorded `declared_per_attempt_ms` exists at
        // all — a fallback nobody chose is not a declaration, so it is omitted rather than
        // reported as one — and which lever a fired ceiling names, since telling someone to raise
        // a flag their own step key overrides sends them to change something inert.
        const perAttemptSource: NonNullable<LlmClock['perAttemptSource']> =
          stepDef.llm_timeout_seconds !== undefined
            ? 'step'
            : deps.llmTimeoutSeconds !== undefined
              ? 'flag'
              : 'default';
        const derivedClock = deriveLlmClock(
          (stepDef.llm_timeout_seconds ?? fallbackLlmTimeoutSeconds) * 1000,
        );
        const llmClock: LlmClock = {
          ceilingMs: derivedClock.ceilingMs,
          perAttemptSource,
          ...(perAttemptSource !== 'default' && derivedClock.declaredPerAttemptMs !== undefined
            ? { declaredPerAttemptMs: derivedClock.declaredPerAttemptMs }
            : {}),
        };

        // issue #217: the in-drive schema-feedback repair loop. `stepInput`/`toolCallsForMeta`/
        // `result` are re-assigned on every attempt inside the `for` loop below; `repairsUsed`/
        // `lastRejection` persist ACROSS attempts within this one step, and are fresh (0/undefined)
        // for every new step. The loop body is exactly the former single-pass step-execution region
        // (the agent/auto branch bodies + the executeChain call) — an auto step's
        // `execution !== 'agent'` means the repair gate's conjunct (iii) can never hold for it, so
        // it structurally can never iterate more than once: the loop is a no-op wrapper for every
        // pre-existing (non-repair) case.
        let stepInput: Record<string, unknown> = {};
        let toolCallsForMeta: ToolCallRecord[] | undefined;
        // issue #236: the resolved structuredOutput meta for THIS attempt's callStep call — reset
        // every iteration alongside toolCallsForMeta, threaded into stepMeta below.
        let structuredOutputMetaForStep: StructuredOutputMeta | undefined;
        // issue #600 PR 1a — what the provider said this step's wire requests cost.
        usageForStep = undefined;
        stepUsageSaved = false;
        let result: Awaited<ReturnType<typeof executeChain>>;
        let repairsUsed = 0;
        let lastRejection: { kind: 'output' | 'input'; summary: string } | undefined;

        for (;;) {
          if (engineReply !== undefined) {
            // An engine step `advanceRun` ran at the loop top: its reply takes the dispositions
            // below, exactly as this step's own reply would (decision C15). No model call.
            result = engineReply;
            break;
          }
          // issue #401: re-stamped per repair attempt, so `elapsed_ms` measures THIS attempt
          // rather than the whole step.
          attemptStartedAt = Date.now();
          toolCallsForMeta = undefined;
          structuredOutputMetaForStep = undefined;
          // issue #217 conjunct (vi) ground truth — captured FRESH at the top of EVERY attempt
          // (including the first), never once per step: a per-step capture is stale across the
          // whole provider LLM call, so any concurrent writer (a second drive, a gate `respond`, a
          // parallel-step settle) landing during that call would silently forfeit a legitimate
          // repair. See the repair-gate comment below for the full discriminator rationale. Cost:
          // one extra store read per attempt — accepted.
          const versionBeforeAttempt = (await deps.store.get(runId)).version;

          if (stepDef.execution === 'agent') {
            // Resolve template-expanded prompt via buildNextActions so {{ context.resources.* }}
            // references are substituted before the LLM call. Pure w.r.t. `definition`/`currentRun`,
            // both unchanged across repair attempts — a rejected attempt no longer leaves
            // `currentRun` itself stale relative to what's persisted (issue #220: countRejection DOES
            // persist a bounded rejection counter on a counted rejection — "nothing is ever
            // persisted on a rejected attempt" is FALSE as of #220), but `currentRun`/`definition`
            // are still safe to recompute per iteration here regardless, since neither is read from
            // again until the NEXT step (this step's own next_actions/prompt derivation never
            // consults `validation_rejections`).
            const nextActions = buildNextActions(definition, currentRun, undefined, new Date());
            const nextAction =
              nextActions.find(
                (a) =>
                  a.instruction !== null &&
                  (a.instruction.call_with['command'] as string | undefined) === stepName,
              ) ?? nextActions[0];

            // PRISTINE original prompt — never mutated across repair attempts. The prompt actually
            // sent to the provider (`promptForAttempt` below) is always derived FRESH from this,
            // plus at most the LATEST rejection's feedback — never accumulated, never stale.
            const prompt = nextAction?.prompt ?? stepDef.description;
            const promptForAttempt =
              lastRejection !== undefined
                ? `${prompt}\n\nYour previous output was rejected by the ${lastRejection.kind} schema validator:\n${lastRejection.summary}\nEmit corrected JSON only, matching the schema exactly.`
                : prompt;
            // #robust-anthropic-provider Part 1: route the schema the ENGINE validates output against
            // (output_schema, execution-loop.ts validateOutputSchema) ahead of the execute_step-param
            // schema (input_schema / nextAction.input_schema) the provider was fed until now. Both-
            // declared-and-divergent degrades to a clean recoverable VALIDATION_*_SCHEMA error downstream,
            // not a parse-strand — see the Part 6 loader warning for the authoring-time signal.
            const inputSchema =
              (stepDef.output_schema as Record<string, unknown> | undefined) ??
              (nextAction?.input_schema as Record<string, unknown> | undefined) ??
              (stepDef.input_schema as Record<string, unknown> | undefined);
            const agentProfileInstructions =
              stepDef.agent_profile !== undefined
                ? definition.resolved_profiles?.[stepDef.agent_profile]?.content
                : undefined;

            // issue #236: compute the Phase-B verdict ONCE per attempt-cycle, on the EXACT resolved
            // `inputSchema` local above — never re-derived from `stepDef` (design §2, Rv11). Only
            // steps that DECLARED structured_output ever get a plan at all — an undeclared step's
            // call site below is completely untouched (byte-identical for the non-opted majority).
            let structuredOutputPlan:
              | { send: boolean; ineligibleMeta?: StructuredOutputMeta; caveats?: string[] }
              | undefined;
            if (stepDef.structured_output === 'strict') {
              const sticky = structuredOutputSticky.get(stepName);
              if (sticky !== undefined) {
                // A prior attempt for this step already downgraded — never re-attempt strict.
                structuredOutputPlan = {
                  send: false,
                  ineligibleMeta: { requested: true, sent: false, ...sticky },
                };
              } else if (caps.strictGate !== undefined) {
                // issue #313: an ENDPOINT-scoped refusal, checked AFTER sticky and BEFORE the
                // verdict. Two consequences, both deliberate: the schema is never assessed (its
                // eligibility is irrelevant when strict cannot be sent at all), and this arm sits
                // structurally outside the sticky-arming path, so a compat endpoint can never arm
                // sticky — nothing was attempted, so there is nothing to remember.
                structuredOutputPlan = {
                  send: false,
                  ineligibleMeta: {
                    requested: true,
                    sent: false,
                    downgrade_reason: caps.strictGate,
                  },
                };
              } else {
                const verdict = assessStructuredOutputEligibility({
                  schema: inputSchema,
                  tools: false,
                  profile,
                });
                // issue #313 — the remediation nudge. The plan below discards `reasons`, so this
                // is the only place they still exist. Printed once per step (`repairsUsed === 0`),
                // for ineligible AND caveated verdicts, on stderr: an author who opted into strict
                // and silently did not get it is exactly who needs to know why.
                if (repairsUsed === 0 && verdict.verdict !== 'eligible') {
                  const findings =
                    verdict.verdict === 'ineligible' ? verdict.reasons : verdict.caveats;
                  console.error(
                    `  ⚠ Step '${stepName}': structured_output: strict — ${renderIneligibleMessage(findings)}`,
                  );
                }
                if (verdict.verdict === 'ineligible') {
                  structuredOutputPlan = {
                    send: false,
                    ineligibleMeta: {
                      requested: true,
                      sent: false,
                      downgrade_reason: 'gate_ineligible',
                    },
                  };
                } else if (verdict.verdict === 'eligible_with_caveats') {
                  structuredOutputPlan = {
                    send: true,
                    caveats: verdict.caveats.map((c) => c.code),
                  };
                } else {
                  structuredOutputPlan = { send: true };
                }
              }
            }

            if (repairsUsed === 0) {
              const descPreview = stepDef.description.slice(0, 80);
              console.log(`\n→ [agent] ${stepName}`);
              console.log(`  ${descPreview}${stepDef.description.length > 80 ? '…' : ''}`);

              // issue #220 deliverable 7 — drive-time coherence warn: once per step (gated on the
              // same `repairsUsed === 0` this banner uses), warn when the repair budget itself
              // (schemaRetries + 1 attempts) exceeds the engine's own exhaustion threshold for this
              // step — operator intent would be silently truncated mid-loop (the drive keeps
              // repairing past the point the engine terminalizes the step with VALIDATION_EXHAUSTED).
              const exhaustionThreshold =
                stepDef.validation_exhaustion?.threshold ?? DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD;
              if (schemaRetries + 1 > exhaustionThreshold) {
                console.error(
                  `  ⚠ --schema-retries ${schemaRetries} (repair budget ${schemaRetries + 1} attempts) ` +
                    `exceeds step '${stepName}''s validation-exhaustion threshold ` +
                    `(${exhaustionThreshold}) — the engine will terminalize this step before the ` +
                    `repair loop's own budget is exhausted.`,
                );
              }
            }

            if (stepDef.tools && stepDef.tools.length > 0 && mcpClient) {
              // Tools path: build tool definitions, call callStepWithTools. Rebuilt every attempt
              // (issue #217) — safe: repair only ever follows a ZERO-toolCall attempt, so no budget
              // was spent and nothing can duplicate.
              const byServer = new Map<string, string[]>();
              for (const entry of stepDef.tools) {
                const [serverId, toolName] = entry.split(':') as [string, string];
                if (!byServer.has(serverId)) byServer.set(serverId, []);
                byServer.get(serverId)!.push(toolName);
              }

              let toolsResult;
              // issue #311: hoisted so the evidence assembly below the try/catch can read them.
              const toolArgsEntries: NonNullable<StructuredOutputMeta['tool_args']>['tools'] = [];
              try {
                const toolDefs: ToolDefinition[] = [];
                const barenameOwner = new Map<string, string>(); // bareName → serverId of first registration
                for (const [serverId, allowList] of byServer) {
                  const mcpTools = await mcpClient.getTools(serverId, allowList);

                  const returnedNames = new Set(mcpTools.map((t) => t.name));
                  for (const name of allowList) {
                    if (!returnedNames.has(name)) {
                      throw new WorkflowError(
                        `Step '${stepName}' declares tool '${serverId}:${name}' which is not exposed by MCP server '${serverId}'. ` +
                          `Check the tool name against the server's published tool list.`,
                        {
                          code: 'MCP_TOOL_NOT_FOUND',
                          category: 'ENGINE',
                          agentAction: 'stop',
                          retryable: false,
                        },
                      );
                    }
                  }

                  for (const mcpTool of mcpTools) {
                    const firstOwner = barenameOwner.get(mcpTool.name);
                    if (firstOwner !== undefined) {
                      throw new WorkflowError(
                        `Tool name collision in step '${stepName}': '${mcpTool.name}' is exposed by both '${firstOwner}' and '${serverId}'. ` +
                          `Tool names must be unique across all connected servers within a step.`,
                        {
                          code: 'MCP_TOOL_NAME_COLLISION',
                          category: 'ENGINE',
                          agentAction: 'stop',
                          retryable: false,
                        },
                      );
                    }
                    barenameOwner.set(mcpTool.name, serverId);
                    toolDefs.push({
                      id: `${serverId}:${mcpTool.name}`,
                      serverId,
                      name: mcpTool.name,
                      description: mcpTool.description,
                      inputSchema: mcpTool.inputSchema,
                    });
                  }
                }

                // ---------------------------------------------------------------------------
                // issue #311 — per-tool strict selection. Gated on TWO things:
                //   1. the step's own strict declaration — a step that never opted in takes none of
                //      this, so its `toolDefs` array (contents AND order) reaches the provider
                //      byte-identical to pre-#311; and
                //   2. the PROVIDER's `toolArgsStrict` capability. Marking tools is only
                //      meaningful for a provider that actually reads `ToolDefinition.strict` and
                //      threads it onto the request. BOTH in-repo tool-capable providers now do
                //      (Anthropic on the tool object, OpenAI inside `function`); a third-party
                //      `--provider-module` that does not would otherwise get `strict_sent: true`
                //      evidence against a wire carrying nothing — the falsity this guard exists to
                //      prevent. Conservative by default: an absent capability reads as false, so
                //      such modules are safe without declaring anything, and the conformance suite
                //      holds each declarer to actually placing it on the wire.
                // ---------------------------------------------------------------------------
                if (stepDef.structured_output === 'strict' && !strictCapable) {
                  // The provider cannot consume the marker. Do NOT re-sort (the wire keeps its
                  // as-built server order — the pre-#311 shape for these providers), do NOT mark,
                  // and deliberately do NOT run the eligibility walk: those verdicts encode the
                  // ANTHROPIC strict profile, so reporting their reasons/caveats for a provider
                  // that could never send strict anyway would be misleading precision.
                  //
                  // Evidence still lands, and it is the honest version: one entry per DECLARED
                  // tool, in DECLARED order (the run-record contract), each saying plainly that
                  // strict was requested and not sent because this provider does not support it.
                  // The entries are built from a SORTED COPY — the wire array itself must stay in
                  // as-built order, so entry order and wire order legitimately differ here.
                  const declaredIndex = new Map(stepDef.tools.map((id, i) => [id, i]));
                  const declaredOrder = [...toolDefs].sort(
                    (a, b) =>
                      (declaredIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                      (declaredIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
                  );
                  for (const tool of declaredOrder) {
                    toolArgsEntries.push({
                      name: tool.name,
                      strict_requested: true,
                      strict_sent: false,
                      reasons: ['provider_unsupported'],
                    });
                  }
                } else if (stepDef.structured_output === 'strict' && gate !== undefined) {
                  // issue #313 — the ENDPOINT gate, on the tools dimension. Ordered AFTER the
                  // capability arm on purpose (D-3 precedence): a provider that cannot consume the
                  // marker reports `provider_unsupported` even when it also carries a gate, because
                  // "this provider never sends strict" is the more fundamental fact and the two
                  // literals must never conflate.
                  //
                  // Same shape as the arm above — declared-order entries from a sorted copy, wire
                  // untouched, no walk — because the reason is likewise endpoint-level, not
                  // per-schema: assessing tools here would report eligibility findings about
                  // schemas that were never going to be sent strict at all.
                  const declaredIndex = new Map(stepDef.tools.map((id, i) => [id, i]));
                  const declaredOrder = [...toolDefs].sort(
                    (a, b) =>
                      (declaredIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                      (declaredIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
                  );
                  for (const tool of declaredOrder) {
                    toolArgsEntries.push({
                      name: tool.name,
                      strict_requested: true,
                      strict_sent: false,
                      reasons: ['compat_endpoint'],
                    });
                  }
                } else if (stepDef.structured_output === 'strict') {
                  // Re-sort into the author's DECLARED order. The assembly above walks server by
                  // server, so the wire order otherwise depends on MCP server grouping and each
                  // server's own listing order — neither of which the author controls. The budget
                  // walk below is order-sensitive (it is greedy), so "which tools got strict" must
                  // be a function of something the author can see and reorder: their own list.
                  const declaredIndex = new Map(stepDef.tools.map((id, i) => [id, i]));
                  toolDefs.sort(
                    (a, b) =>
                      (declaredIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                      (declaredIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
                  );

                  const sticky = toolArgsSticky.get(stepName);
                  // The API's own per-request limits. NOTE: the 20 here is the strict-tool cap and
                  // has nothing to do with `maxToolCalls`'s unrelated default of 20 — never conflate.
                  const MAX_STRICT_TOOLS = 20;
                  const MAX_SUMMED_OPTIONALS = 24;
                  let strictCount = 0;
                  let optionalSum = 0;

                  for (const tool of toolDefs) {
                    const verdict = assessStructuredOutputEligibility({
                      schema: tool.inputSchema,
                      tools: false,
                      subject: 'tool_args',
                      profile,
                    });
                    const caveats =
                      verdict.verdict === 'ineligible'
                        ? (verdict.caveats ?? []).map((c) => c.code)
                        : verdict.verdict === 'eligible_with_caveats'
                          ? verdict.caveats.map((c) => c.code)
                          : [];
                    const entry: (typeof toolArgsEntries)[number] = {
                      name: tool.name,
                      strict_requested: true,
                      strict_sent: false,
                      ...(caveats.length > 0 ? { caveats } : {}),
                    };

                    if (verdict.verdict === 'ineligible') {
                      // Ineligible tools consume ZERO budget: the API's 24-optional sum spans the
                      // schemas strict is actually ATTACHED to, so charging a tool that never gets
                      // strict would starve later, eligible tools for no reason.
                      entry.reasons = verdict.reasons.map((r) => r.code);
                    } else if (sticky !== undefined) {
                      // A previous attempt for this step took a live 400. Re-sending the same
                      // schemas would earn the same rejection, so this attempt starts unconstrained
                      // and every eligible tool reports the ORIGINAL reason verbatim.
                      entry.reasons = [sticky.reason];
                    } else if (profile === 'openai') {
                      // issue #313: NO budget walk under the OpenAI profile. Anthropic publishes a
                      // 20-strict-tool and 24-summed-optional per-request budget; OpenAI publishes
                      // NEITHER (executed: 128 strict tools in one request ⇒ 200, and the only
                      // ceiling found is the generic 128-element tools ARRAY cap, which authoring
                      // hits long before this walk would). So every eligible tool is marked, and
                      // `budget_excluded` is never minted under this profile — inventing a budget
                      // here would withhold strict for a limit that does not exist.
                      tool.strict = true;
                      entry.strict_sent = true;
                    } else {
                      // Greedy-skip in declared order, INCLUSIVE boundaries (landing exactly on a
                      // limit fits). A tool that doesn't fit is SKIPPED and the walk CONTINUES —
                      // stopping at the first miss would let one fat schema disable strict for
                      // every tool behind it.
                      const optionals = verdict.optional_count ?? 0;
                      if (
                        strictCount + 1 <= MAX_STRICT_TOOLS &&
                        optionalSum + optionals <= MAX_SUMMED_OPTIONALS
                      ) {
                        tool.strict = true;
                        entry.strict_sent = true;
                        strictCount += 1;
                        optionalSum += optionals;
                      } else {
                        entry.reasons = ['budget_excluded'];
                      }
                    }
                    toolArgsEntries.push(entry);
                  }
                }

                const baseExecutor: ToolExecutor = async (namespacedName, args) => {
                  const [serverId, toolName] = namespacedName.split(':') as [string, string];
                  return mcpClient!.call(serverId, toolName, args);
                };

                // Wrap the executor to enforce max_fan_out when set.
                // Counts calls to start_run and start_run_batch (regardless of server prefix).
                let fanOutCallCount = 0;
                const maxFanOut = stepDef.max_fan_out;
                const executor: ToolExecutor = async (namespacedName, args) => {
                  const toolName = namespacedName.includes(':')
                    ? namespacedName.split(':')[1]!
                    : namespacedName;
                  if (toolName === 'start_run' || toolName === 'start_run_batch') {
                    fanOutCallCount += 1;
                    if (maxFanOut !== undefined && fanOutCallCount > maxFanOut) {
                      throw new WorkflowError(
                        `max_fan_out of ${maxFanOut} reached for step '${stepName}'. ` +
                          `No further start_run or start_run_batch calls are permitted in this step.`,
                        {
                          code: 'VALIDATION_BATCH_TOO_LARGE',
                          category: 'VALIDATION',
                          agentAction: 'provide_input',
                          retryable: false,
                        },
                      );
                    }
                  }
                  return baseExecutor(namespacedName, args);
                };

                if (!isToolCapable(deps.provider)) {
                  throw new Error(
                    'invariant: provider lost tool capability between startup and step execution',
                  );
                }
                // #robust-anthropic-provider Part 1: same output-over-input precedence as the callStep
                // path above. This EFFECTIVE-OUTPUT schema still feeds ONLY the submit tool + system
                // prompt (unchanged) — issue #224 [gate] SCHEMA-ROUTING PIN: do NOT repoint it at the
                // newly-separated raw schemas below.
                const toolsEffectiveOutputSchema =
                  (stepDef.output_schema as Record<string, unknown> | undefined) ??
                  (stepDef.input_schema as Record<string, unknown> | undefined);
                toolsResult = await deps.provider.callStepWithTools(
                  promptForAttempt,
                  toolDefs,
                  executor,
                  {
                    llmClock,
                    ...(toolsEffectiveOutputSchema !== undefined
                      ? { inputSchema: toolsEffectiveOutputSchema }
                      : {}),
                    // issue #224 (D2): the RAW schemas, separate from the effective-output schema
                    // above — consumed ONLY by the in-conversation validateAgentSubmission
                    // correction loop (never the submit tool / system prompt).
                    ...(stepDef.input_schema !== undefined
                      ? {
                          validationInputSchema: stepDef.input_schema as Record<string, unknown>,
                        }
                      : {}),
                    ...(stepDef.output_schema !== undefined
                      ? {
                          validationOutputSchema: stepDef.output_schema as Record<string, unknown>,
                        }
                      : {}),
                    maxToolCalls: stepDef.max_tool_calls ?? 20,
                    ...(stepDef.max_fan_out !== undefined
                      ? { maxFanOut: stepDef.max_fan_out }
                      : {}),
                    toolTimeoutMs: (stepDef.tool_timeout ?? 30) * 1000,
                    ...(agentProfileInstructions !== undefined ? { agentProfileInstructions } : {}),
                  },
                );
              } catch (err) {
                console.error(`\n✗ Step '${stepName}' (tools) failed: ${safeErrorText(err)}`);
                // issue #676: the provider's own one-sentence explanation, when it has one.
                const explainedTools = safeExplainFailure(deps.provider, err);
                if (explainedTools !== undefined) console.error(`  ${explainedTools}`);
                // issue #401, CHOKEPOINT (1): recorded AFTER the original line, never instead of
                // it. Returns rather than throws, which is what makes double-minting structurally
                // impossible — the last-resort catch below never sees this path.
                await recordDriveFailure(
                  deps.store,
                  runId,
                  buildEntry(err, stepName, providerForEvidence ?? 'unknown', attemptStartedAt),
                );
                return 'failed';
              }
              stepInput = toolsResult.output;
              toolCallsForMeta = toolsResult.toolCalls;
              // issue #332 item 6: the tools path never consumes structuredOutputPlan (there is no
              // grammar-constrained call here — callStepWithTools has no strict concept at all), so
              // a strict-DECLARED, tools-bearing step used to leave structuredOutputMetaForStep
              // undefined — falling through to execution-loop.ts's synthesized `external_agent`
              // stamp, which claims "realm made no request at all". That's a misattribution: realm's
              // OWN agent DID drive this step, via the tools path, which structurally cannot honor
              // strict. Mint the honest, distinct reason here instead of letting the engine
              // synthesize the wrong one.
              //
              // NOT a ladder outcome — deliberately does NOT touch structuredOutputSticky. Sticky
              // exists to remember a LIVE downgrade across repair-loop attempts for the SAME step
              // (armed only at the live-downgrade sites below, :698-702/:736-740 in the non-tools
              // branch); this is a per-step STRUCTURAL fact (declares `tools`) that is identical on
              // every attempt and needs no memory across attempts.
              if (stepDef.structured_output === 'strict') {
                structuredOutputMetaForStep = {
                  requested: true,
                  sent: false,
                  downgrade_reason: 'unsupported_context_tools',
                };
              }

              // issue #311 — the TOOL-ARGUMENTS evidence block. COEXISTS with the #332 mint above,
              // which is left exactly as it was: that mint states the OUTPUT-dimension truth (this
              // step's own answer was not grammar-constrained), and it stays true no matter how many
              // tools carried strict. This block adds the independent per-tool story.
              if (stepDef.structured_output === 'strict' && toolArgsEntries.length > 0) {
                // The drop machinery is capability-gated too. On the capability-false arm strict was
                // never attached, so there is nothing to drop: a (misbehaving or future) provider
                // reporting one must not be able to mint a `dropped_mid_attempt` record, flip any
                // entry, or arm the sticky map — the run-record contract says that record is absent
                // on an attempt that never attached strict.
                // issue #313 extends the #350 conjunct with the gate: on a gated endpoint strict
                // was never attached either, so a reported drop must not mint a record here.
                const drop =
                  strictCapable && gate === undefined ? toolsResult.toolArgsStrictDrop : undefined;
                if (drop !== undefined) {
                  // DROP TRUTH: flip ONLY the entries strict was actually attached to. An entry that
                  // was ineligible or budget-excluded never carried strict, so the drop says nothing
                  // about it — overwriting its reasons here would erase why it was really skipped.
                  for (const entry of toolArgsEntries) {
                    if (!entry.strict_sent) continue;
                    entry.strict_sent = false; // `strict_sent` = FINAL posture of the attempt
                    entry.reasons = [drop.reason];
                  }
                }
                structuredOutputMetaForStep = {
                  ...structuredOutputMetaForStep,
                  requested: true,
                  tool_args: {
                    tools: toolArgsEntries,
                    // PER-ATTEMPT, and absent on a sticky attempt by construction: a sticky attempt
                    // never attaches strict, so the provider has nothing to drop and reports no
                    // drop. `api_message` lives here, never on the step-level meta.
                    ...(drop !== undefined ? { dropped_mid_attempt: drop } : {}),
                  },
                };
                // Arm the tool-args sticky on a 400 ONLY (see the map's own comment for why a 503
                // deliberately does not arm it).
                if (drop?.reason === 'api_rejected_schema' && !toolArgsSticky.has(stepName)) {
                  toolArgsSticky.set(stepName, {
                    reason: drop.reason,
                    ...(drop.api_message !== undefined ? { api_message: drop.api_message } : {}),
                  });
                }
              }
            } else {
              // issue #401: the outer two-attempt retry loop is RETIRED. It silently rescued
              // transient failures by calling again — which is exactly why a failing drive left
              // no trace: the first failure was swallowed and the second one exited. A single
              // attempt now, with the failure RECORDED; re-attaching is the retry.
              try {
                if (structuredOutputPlan !== undefined) {
                  // issue #236: the declared-step path — always call callStepWithMeta so the
                  // synthesis rule (design §5 [R2-3]) can distinguish a genuinely-absent meta
                  // (third-party provider ⇒ provider_unsupported) from a gate/sticky decision
                  // that never even attempted a call.
                  const { output, meta, usage } = await deps.provider.callStepWithMeta(
                    promptForAttempt,
                    inputSchema,
                    agentProfileInstructions,
                    { structuredOutputStrict: structuredOutputPlan.send, llmClock },
                  );
                  stepInput = output;
                  // issue #600 PR 1a: `?? []` is load-bearing. A model call HAPPENED, so the
                  // record must say `unobservable`, not stay silent. A provider that reports
                  // nothing (the base default, any third-party module) would otherwise leave
                  // `cache` absent — and absent means nothing was recorded, which a handler step
                  // and a tool-calling step (issue #610) also produce; see StepDiagnostics.cache.
                  // Repair calls now accumulate: each #217 repair pass appends its requests, so a
                  // repaired step records every call it paid for, in wire order.
                  usageForStep = appendRequests(usageForStep, usage ?? []);
                  if (structuredOutputPlan.ineligibleMeta !== undefined) {
                    // Gate-ineligible or sticky — strict was never attempted this call at all.
                    structuredOutputMetaForStep = structuredOutputPlan.ineligibleMeta;
                  } else if (meta !== undefined) {
                    structuredOutputMetaForStep = {
                      ...meta,
                      ...(structuredOutputPlan.caveats !== undefined
                        ? { caveats: structuredOutputPlan.caveats }
                        : {}),
                    };
                    // Arm sticky the FIRST time THIS step downgrades (never re-arm from a
                    // gate_ineligible meta — that's not a live-API downgrade to remember).
                    if (
                      meta.sent === false &&
                      meta.downgrade_reason !== undefined &&
                      meta.downgrade_reason !== 'gate_ineligible' &&
                      !structuredOutputSticky.has(stepName)
                    ) {
                      structuredOutputSticky.set(stepName, {
                        downgrade_reason: meta.downgrade_reason,
                        ...(meta.api_message !== undefined
                          ? { api_message: meta.api_message }
                          : {}),
                      });
                    }
                  } else {
                    // The base LlmProvider default returned no meta at all — a third-party
                    // provider that never overrides callStepWithMeta.
                    structuredOutputMetaForStep = {
                      requested: true,
                      sent: false,
                      downgrade_reason: 'provider_unsupported',
                    };
                  }
                } else {
                  // issue #600 PR 1a (A3): the bare arm is re-routed through callStepWithMeta so a
                  // step that declares NO structured_output still reports what its wire requests
                  // cost. The request is byte-identical — this method's only extra input is
                  // `structuredOutputStrict`, which is not passed here. `meta` is DELIBERATELY not
                  // destructured: a third-party provider that overrides callStepWithMeta must not
                  // be able to stamp a structured_output disclosure on a step that declared none.
                  const { output, usage } = await deps.provider.callStepWithMeta(
                    promptForAttempt,
                    inputSchema,
                    agentProfileInstructions,
                    { llmClock },
                  );
                  stepInput = output;
                  // issue #600 PR 1a: `?? []` is load-bearing. A model call HAPPENED, so the
                  // record must say `unobservable`, not stay silent. A provider that reports
                  // nothing (the base default, any third-party module) would otherwise leave
                  // `cache` absent — and absent means nothing was recorded, which a handler step
                  // and a tool-calling step (issue #610) also produce; see StepDiagnostics.cache.
                  // Repair calls now accumulate: each #217 repair pass appends its requests, so a
                  // repaired step records every call it paid for, in wire order.
                  usageForStep = appendRequests(usageForStep, usage ?? []);
                }
              } catch (err) {
                // The catch-side sticky-arming block that used to live here is DELETED as dead
                // code: this catch returns 'failed' immediately, the sticky map is
                // per-invocation, and nothing later reads it. The SUCCESS-path arming site
                // above is the one that serves the #217 repair loop, and it is untouched.
                console.error(`\n✗ Step '${stepName}' LLM call failed: ${safeErrorText(err)}`);
                // issue #676: the provider's own one-sentence explanation, when it has one.
                const explained = safeExplainFailure(deps.provider, err);
                if (explained !== undefined) console.error(`  ${explained}`);
                // issue #600: `buildEntry` sees only the THROWING call's own `driveCall.usage`, so
                // the calls this step's earlier schema-repair passes already billed are put in
                // front of it (wire order). `err` itself is never mutated.
                const entry = buildEntry(
                  err,
                  stepName,
                  providerForEvidence ?? 'unknown',
                  attemptStartedAt,
                );
                if (usageForStep !== undefined && usageForStep.length > 0) {
                  entry.usage = appendRequests(usageForStep, entry.usage);
                }
                await recordDriveFailure(deps.store, runId, entry);
                return 'failed';
              }
            }
          }

          // issue #313 — the PROVENANCE chokepoint. Every path above that mints a
          // `structuredOutputMetaForStep` (gate, sticky, compat, live ladder, tools mint, the
          // provider_unsupported synthesis) funnels through here, so stamping the provider once at
          // this single point covers them all and cannot be forgotten on a new arm. The engine's
          // OWN synthesized `external_agent` stamps never pass through here and therefore carry no
          // provider — correctly, since realm did not drive those attempts.
          if (structuredOutputMetaForStep !== undefined && providerForEvidence !== undefined) {
            structuredOutputMetaForStep = {
              ...structuredOutputMetaForStep,
              provider: providerForEvidence,
            };
          }

          result = await executeChain(deps.store, definition, {
            runId,
            command: stepName,
            // decision C151: an expiry this call carries out names `realm agent`.
            caller: 'agent',
            input: stepInput,
            dispatcher: async () => stepInput,
            registry: deps.registry,
            ...(deps.traceBufferStore !== undefined
              ? { traceBufferStore: deps.traceBufferStore }
              : {}),
            // issue #625 (holder slice): the program this driver runs in — the claim's `holder`,
            // the evidence's `driven_by`. After `traceBufferStore`, as at every host call site.
            ...(deps.driver !== undefined ? { driver: deps.driver } : {}),
            // issue #236: stepMeta now ALSO passes when structuredOutput exists (previously only
            // passed when toolCalls existed) — the two are independent, either alone must thread.
            // issue #600 PR 1a: `usage` is the THIRD independent member. A cs1-shaped step (no
            // tools, no structured output) passed NO stepMeta at all before this, so its usage was
            // computed and dropped right here at the boundary.
            ...(toolCallsForMeta !== undefined ||
            structuredOutputMetaForStep !== undefined ||
            usageForStep !== undefined
              ? {
                  stepMeta: {
                    ...(toolCallsForMeta !== undefined ? { toolCalls: toolCallsForMeta } : {}),
                    ...(structuredOutputMetaForStep !== undefined
                      ? { structuredOutput: structuredOutputMetaForStep }
                      : {}),
                    ...(usageForStep !== undefined ? { usage: usageForStep } : {}),
                  },
                }
              : {}),
            // issue #197 PR-2: a FRESH nonce per step-attempt — resolved per call, never cached, so
            // the strict-flip (checked inside shouldMintWriterNonce) is honored even if the env var
            // changes mid-process (tests flip it). Also fresh per issue #217 repair attempt, since
            // this call sits inside the repair loop.
            ...(shouldMintWriterNonce(deps) ? { writerNonce: crypto.randomUUID() } : {}),
          });

          // The follow-up to #625 PR-2a round 20's finding 3: `executeChain` answers a run it cannot read
          // with an error reply that names no run phase (no run was read) where it used to throw. The
          // drive's store is failing, as when a read of the drive's own throws: it is raised here,
          // inside the attempt, so the last-resort catch (chokepoint 3) records the step's billed calls
          // (nothing was saved) and the failure propagates — the drive's exit 4, as before. A run that
          // no longer exists keeps its reply and the step's failure line, as before.
          if (
            result.status === 'error' &&
            result.run_phase === undefined &&
            result.error_code !== undefined &&
            result.error_code !== 'STATE_RUN_NOT_FOUND'
          ) {
            throw new WorkflowError(result.errors.join(', '), {
              code: result.error_code,
              category: result.error_code.split('_')[0] as ErrorCategory,
              agentAction: result.agent_action ?? 'stop',
              retryable: false,
              stepId: stepName,
            });
          }

          // issue #217: the in-drive schema-feedback repair gate. Fires ONLY when ALL SIX conjuncts
          // hold — see plans/issue-217/design-v2.md §Mechanism for the rationale on (i)-(v).
          //
          // Conjunct (vi) — CORRECTED from the design record's literal `result.command === stepName`
          // (flagged as a divergence in the implementation report): the record's premise was that
          // executeChain "returns the DEEPER step's own envelope" on a chain-replacement error,
          // citing execution-loop.ts:2855-2859/:3015 (executeChainInternal's recursive early-return,
          // which DOES set `command` to the deeper step). But run-agent.ts calls the PUBLIC
          // `executeChain` wrapper, not executeChainInternal directly — and that wrapper
          // unconditionally overwrites the returned envelope's `command` back to the TOP-LEVEL
          // requested command on every call (execution-loop.ts:3094, `command: options.command`),
          // confirmed empirically against the built engine. So `result.command` always equals
          // `stepName` here and can never discriminate a deeper chained step's error from this step's
          // own — the literal conjunct is vacuously true and provides zero protection.
          //
          // The corrected, structurally-sound discriminator: a pre-claim validation rejection is
          // write-free (no run-record version bump — see execute-step.ts:77-80 / execution-loop.ts's
          // Step 2b/2c, both before claimStep). So if `result.run_version` has advanced past
          // `versionBeforeAttempt` (captured fresh at the top of each repair attempt), something
          // committed to the run BEFORE this error occurred — e.g. THIS step's own claim+settle,
          // followed by a DEEPER chained step's pre-claim rejection — so the error cannot be this
          // step's own output/input. A concurrent external writer bumping the run mid-attempt also
          // lands here — the gate then fails CLOSED (repair forfeited, today's failure path). See
          // run-agent.test.ts's "chained-auto no-false-repair" and concurrent-writer tests.
          //
          // issue #220 (SHIPPED): countRejection now persists a bounded rejection counter via a
          // real CAS write on a counted rejection — rejected attempts are NO LONGER write-free w.r.t.
          // the run record. What keeps this conjunct sound anyway is bump-and-report: the write's
          // return value is discarded, and the rejection's own ENVELOPE keeps reporting the
          // PRE-write version (the Step-1 `run`), so `result.run_version` still equals
          // `versionBeforeAttempt` here across repairs 2..N. Pin (a) (bump-and-report) guards this
          // invariant — see execution-loop.ts's countRejection for the mechanism, and
          // packages/core/src/engine/validation-exhaustion.test.ts's pin (a) for the pin.
          if (
            result.status === 'error' &&
            (result.error_code === 'VALIDATION_OUTPUT_SCHEMA' ||
              result.error_code === 'VALIDATION_INPUT_SCHEMA') &&
            stepDef.execution === 'agent' &&
            (toolCallsForMeta === undefined || toolCallsForMeta.length === 0) &&
            repairsUsed < schemaRetries &&
            // issue #401: a duplicate attached writer's version bump forfeits the repair BY
            // DESIGN (record R-3). The error-code-keyed mint below still records the wedge
            // truthfully, so forfeiting a repair never costs the operator the visibility.
            result.run_version === versionBeforeAttempt
          ) {
            repairsUsed++;
            const record = buildFailedAttemptRecord({
              run_id: runId,
              workflow_id: definition.id,
              step_id: stepName,
              ts: new Date().toISOString(),
              error_code: result.error_code,
              ajv_errors: (result.error_details?.['errors'] as unknown[]) ?? [],
              params: stepInput,
              trace_entry_count: 0,
            });
            lastRejection = {
              kind: result.error_code === 'VALIDATION_OUTPUT_SCHEMA' ? 'output' : 'input',
              summary: record.validation_error_summary.map(renderValidationSummaryEntry).join('\n'),
            };
            console.error(
              `  ⚠ output rejected (${result.error_code}); repairing (attempt ${repairsUsed}/${schemaRetries})`,
            );
            continue;
          }

          break;
        }
        // issue #600: set AFTER the repair loop, never inside it. A rejected attempt's
        // `executeChain` saves nothing, so a flag set there would claim a save that never
        // happened and a throw on the next attempt would lose every billed call.
        stepUsageSaved = true;
        // decision C189: the answers this drive gave, from what its own engine call recorded — on
        // every reply branch below (the `✓` line, a question the answer opened, any other).
        if (engineReply === undefined && answerRecordedByCall(result, stepName)) {
          answeredHere.add(stepName);
        }

        // F7: an error reply read by core's classifier against the record as it is now.
        const errorRecord = result.status === 'error' ? await deps.store.get(runId) : undefined;
        const resultStop =
          errorRecord === undefined ? undefined : classifyStop(result, stepName, errorRecord);
        // #134: a NOT-REGISTERED handler or adapter, detected structurally (core's classifier, never
        // the message text) — the dispositions below, or the hold just after.
        const isCapabilityBlock = resultStop?.kind === 'capability';

        // decision C64 (the census): the chain after an agent step can reach an engine step that
        // cannot run here (capability). The agent step completed and the reply is the chained step's
        // block. Held instead of sent to the block below, as the loop top holds its own (decision
        // C23): the next pass names the blocked step once, the drive goes on with any ready agent
        // step, and its exit names the blocked step and what it needs. Keyed on `stopped_step`
        // (decision C73): the reply names the step it belongs to, so a value other than this step
        // means the engine ran that step after this one (and this one settled) — no record is read
        // to guess it.
        if (
          engineReply === undefined &&
          isCapabilityBlock &&
          result.stopped_step !== undefined &&
          result.stopped_step !== stepName
        ) {
          heldCapabilityReplies.set(result.stopped_step, result);
          currentRun = await deps.store.get(runId);
          console.log(`  ✓ → ${currentRun.run_phase}`);
          continue;
        }

        // Round 24's finding (C179's sentence made true), F7: the drive's own call for its agent step
        // was refused because another program got there first — read by core's classifier against
        // the record as it is now. Its settle of the answer was refused (`ran_here`: another process
        // settled the step, took it over, removed its claim — as `realm run reclaim --force` removes
        // it — or ended the run): the answer was not recorded, said as C179's line in the
        // classifier's kind, never `✗ … failed`. A claim refused because the run ended, a question
        // opened, or the step stopped being eligible (the claim's own re-check) ran nothing: as a
        // `blocked` reply does (decision C85), the drive goes on and its own end and question checks
        // speak. `stopped_step` names this step only on its own call's refusal: the same code from a
        // guard of the chain (a concurrent settle that diverged from its abort) names no step, and
        // keeps the stop below — this drive's answer was recorded there.
        if (engineReply === undefined && errorRecord !== undefined && isRaceStop(resultStop)) {
          currentRun = errorRecord;
          if (resultStop.ran_here || resultStop.kind === 'run_ended') {
            console.log(
              answerNotRecordedLine(
                currentRun,
                stepName,
                keepsClaims,
                resultStop.kind as NotRecordedKind,
              ),
            );
          }
          continue;
        }

        if (result.status === 'error') {
          // #134: a NOT-REGISTERED handler/adapter settles RECOVERABLY — the run is NOT failed, the step
          // is parked awaiting a capable runner. Detect structurally via error_code (not message text) and
          // print capability-aware guidance instead of a bare `✗ Step failed`. The return stays 'failed'
          // (no 'blocked' AgentRunResult variant, by design) — the distinction lives in the message.
          // issue #401: a capability block mints NO drive-failure entry — the `capability_block`
          // finding already owns this disclosure, and two findings for one fact is noise.
          // issue #217: append the repair count ONLY when at least one repair actually ran — never
          // "after 0 schema-repair attempts".
          //
          // issue #676 (review): `stopped_step` names the step whose own reply this is. When it is
          // not this step, the engine ran it AFTER this one (this step then settled, so its repairs,
          // if any, succeeded). The lines and the drive-failure entry below name the step that stopped.
          const laterStep =
            result.stopped_step !== undefined && result.stopped_step !== stepName
              ? result.stopped_step
              : undefined;
          const stoppedStep = laterStep ?? stepName;
          const ranAfter =
            laterStep !== undefined ? ` (run by the engine after '${stepName}' finished)` : '';
          const repairSuffix =
            repairsUsed > 0 && laterStep === undefined
              ? ` after ${repairsUsed} schema-repair attempts`
              : '';
          if (isCapabilityBlock) {
            currentRun = await deps.store.get(runId);
            const block = findCapabilityBlockedSteps(currentRun).find(
              (b) => b.step === stoppedStep,
            );
            const need =
              block !== undefined
                ? `${block.requirement.kind} '${block.requirement.name}'`
                : result.error_code === 'ENGINE_HANDLER_NOT_REGISTERED'
                  ? 'the missing handler'
                  : 'the missing adapter';
            console.error(
              `\n⚠ Step '${stoppedStep}'${ranAfter} is blocked: ${need} is not registered in this runner. ` +
                `The run is NOT failed — add ${need} and re-attach (\`realm agent --run-id ${runId} ${deps.reattachFlags ?? '--provider <provider> --model <model>'}\`).`,
            );
          } else {
            console.error(
              `\n✗ Step '${stoppedStep}'${ranAfter} failed: ${result.errors.join(', ')}${repairSuffix}`,
            );
            // ═══ issue #401, CHOKEPOINT (4) — the disposition table, KEYED ON ERROR CODE ═══
            //
            // A validation rejection that reaches here has WEDGED the run: it settles nothing, so
            // there is no seal to carry the news and no evidence to read. Every OTHER
            // non-capability code SETTLES THE STEP — `failed_steps` plus the step's evidence are
            // the visibility, so recording those would duplicate a fact the run already tells.
            // (Not "either seals or is capability-owned": non-sealing envelopes exist, and a
            // settled step on a still-live run is the common case.)
            //
            // Deliberately NOT keyed on `repairsUsed`: every bypass of the repair gate — a
            // tools-path rejection, a concurrent writer's version bump, `schemaRetries: 0` —
            // arrives here with `repairsUsed === 0` and wedges just the same.
            //
            // An auto step refused on its input before its claim no longer arrives here (issue #625
            // PR-2a, decision C31): the drive's exit for a step that cannot run records that wedge
            // itself, with the same fields, before this block.
            if (
              result.error_code === 'VALIDATION_OUTPUT_SCHEMA' ||
              result.error_code === 'VALIDATION_INPUT_SCHEMA'
            ) {
              await recordDriveFailure(deps.store, runId, {
                ...validationWedgeEntry(
                  stoppedStep,
                  providerForEvidence ?? 'unknown',
                  result.errors,
                  attemptStartedAt,
                ),
                // issue #600: a wedge carries every call of the exhausted repair budget. Nothing is
                // attached when no call reported usage — the same rule as `attachBilledUsage`. Nor
                // when the rejection belongs to a step `executeChain` ran AFTER this one: this step
                // then saved first, with its calls, and attaching them here would count them twice.
                ...(usageForStep !== undefined &&
                usageForStep.length > 0 &&
                !(await callsAlreadyRecorded(stepName, usageForStep))
                  ? { usage: usageForStep }
                  : {}),
              });
            }
          }
          await printResumeLine();
          return 'failed';
        }

        if (result.status === 'confirm_required') {
          // Gate will be handled at the top of the next iteration.
          currentRun = await deps.store.get(runId);
          continue;
        }

        currentRun = await deps.store.get(runId);
        // decision C179: the run ended before this drive's answer reached the engine — the call ran
        // nothing (`executeChain`'s reply for a run that has ended), so the answer was not recorded:
        // said, with who ran the step when another process did, never `✓`.
        if (
          engineReply === undefined &&
          result.status === 'ok' &&
          result.agent_action === 'stop' &&
          result.evidence.length === 0
        ) {
          const line = answerNotRecordedLine(currentRun, stepName, keepsClaims);
          if (line !== undefined) console.log(line);
          continue;
        }
        if (result.status === 'blocked') {
          // A `blocked` reply is never `✓` (decision C82 (5)). Which step it belongs to is the reply's
          // own `stopped_step` (decision C74): this step's, or a step the engine ran after it.
          const blockedStep = result.stopped_step ?? stepName;
          // F7: core's classifier reads the reply against the record re-read above.
          const blockedStop = classifyStop(result, blockedStep, currentRun);
          if (blockedStop?.kind === 'taken') {
            // issue #625 PR-2a (D6.1, D3.2): another process took the step — on the claim, or between
            // this drive's read and the engine's (the step is then "not eligible", but in flight,
            // done or failed on the record) — say who and when, as past-tense facts read off its
            // claim, never `✓ → running`; then re-read and continue. Decision C179: for the agent
            // step this drive's model answered, the line says the answer was not recorded, and names
            // the program that ran the step once it settled.
            console.log(
              engineReply === undefined && blockedStep === stepName
                ? (answerNotRecordedLine(currentRun, blockedStep, keepsClaims) ??
                    takenLine(
                      blockedStep,
                      describeClaimHolder(currentRun.claims?.[blockedStep], keepsClaims),
                    ))
                : takenLine(
                    blockedStep,
                    describeClaimHolder(currentRun.claims?.[blockedStep], keepsClaims),
                  ),
            );
            continue;
          }
          // decision C85: the step stopped being eligible because, in the same moment, another
          // process opened a gate or ended the run. The loop top handles both — it waits at the gate,
          // or prints the run-ended line — as it did before C82 (5).
          if (blockedStop?.kind === 'run_ended' || blockedStop?.kind === 'question_opened') {
            // decision C179: a run that ended in that moment did not record this drive's answer —
            // said, as when `executeChain` finds the run ended.
            if (
              engineReply === undefined &&
              blockedStep === stepName &&
              currentRun.terminal_state
            ) {
              const line = answerNotRecordedLine(currentRun, stepName, keepsClaims);
              if (line !== undefined) console.log(line);
            }
            continue;
          }
          // decision C82 (5): any other `blocked` reply — the step's precondition failed on the
          // engine's own read, or the step stopped being eligible for another reason, after this drive
          // read the record — prints the reply's own hint, and the drive stops. Kept a stop on
          // purpose (C85): going back to the loop top on a reply the run's view does not explain
          // could bring back the unbounded, billed loop C82 removed.
          console.error(`\n✗ ${result.context_hint}`);
          await printResumeLine();
          return 'failed';
        }
        console.log(`  ✓ → ${currentRun.run_phase}`);
      }
    } finally {
      if (mcpClient) {
        await mcpClient.disconnect();
      }
    }
  } catch (err) {
    // ═══ issue #401, CHOKEPOINT (3) — the last-resort catch ═══
    //
    // Sees everything the inner chokepoints did not already RETURN from: the MCP-init throws, a
    // store read failing mid-loop, a gate handler throwing, an engine throw out of executeChain,
    // a disconnect failing. Each one used to leave the run looking untouched.
    //
    // Classified through the SHARED classifier rather than hardcoded to 'other': an error that
    // carries a payload deserves its real class no matter which catch happens to see it.
    //
    // `step: ''` is EXPECTED for anything thrown before a step was selected.
    const entry = buildEntry(
      err,
      currentStepName ?? '',
      providerForEvidence ?? 'unknown',
      attemptStartedAt,
    );
    // issue #600: a throw that escaped before the current step's evidence was saved takes the
    // step's billed calls with it. Once the repair loop has ended (`stepUsageSaved`), `executeChain`
    // has returned, so nothing it ran can throw here. But while it runs it CAN throw after the
    // driven step saved: a step it ran afterwards, on a store that does not persist
    // `workflow_context_snapshots`, re-takes the snapshot, and that write is unguarded. So a throw
    // inside the loop does not prove "nothing was saved": attach the calls only when they are not
    // already on the step's record.
    if (
      currentStepName !== undefined &&
      !stepUsageSaved &&
      usageForStep !== undefined &&
      usageForStep.length > 0 &&
      !(await callsAlreadyRecorded(currentStepName, usageForStep))
    ) {
      entry.usage = appendRequests(usageForStep, entry.usage);
    }
    await recordDriveFailure(deps.store, runId, entry);
    // RE-THROWS, never returns: `runAgent`'s public contract is that these propagate, and
    // commands/agent.ts stays the console floor for anything that happens before a run exists.
    throw err;
  }

  if (currentRun.run_phase === 'completed') {
    console.log(`\nRun complete: ${runId}`);
    // decision C211: cleanup steps the ending left pending — the command that runs them.
    const cleanup = pendingCleanupLine(currentRun, new Date());
    if (cleanup !== undefined) console.log(cleanup);

    // Print the last agent step's output so the result is visible without
    // a separate `realm run inspect` call.
    const lastAgentEvidence = [...currentRun.evidence]
      .reverse()
      .find(
        (snapshot) =>
          snapshot.status === 'success' &&
          snapshot.kind !== 'gate_response' &&
          definition.steps[snapshot.step_id]?.execution === 'agent',
      );
    if (lastAgentEvidence !== undefined) {
      // decision C179: an answer this drive did not give is said to be another program's.
      const givenElsewhere = answeredHere.has(lastAgentEvidence.step_id)
        ? ''
        : ` — given by ${lastAgentEvidence.driven_by !== undefined ? describeProgram(lastAgentEvidence.driven_by) : 'another process'}, not by this drive`;
      console.log(`\nResult (${lastAgentEvidence.step_id})${givenElsewhere}:`);
      const stepDef = definition.steps[lastAgentEvidence.step_id];
      const formatted =
        stepDef?.display !== undefined
          ? renderDisplay(stepDef.display, lastAgentEvidence.output_summary)
          : formatOutputForTerminal(lastAgentEvidence.output_summary);
      console.log(formatted);
    }

    return 'completed';
  }

  if (stoppedOnInFlight) return 'failed';
  // F16 (review G1-R3): a run that has not ended is never said to have ended. The drive stops with
  // nothing ready — said in the view's words (`realm run advance`'s stop reasons), with the ways on
  // that hold: inspect, or end it.
  if (!currentRun.terminal_state) {
    const reasons = stoppedReasons(
      runId,
      currentRun,
      describePending(definition, currentRun, deps.registry, new Date()),
    );
    console.error(
      `\n✗ The drive stops: ${reasons.join('; ')}. Run ${runId} stays open (phase '${currentRun.run_phase}'): see realm run inspect ${runId} — or end it: realm run abandon ${runId}`,
    );
    return 'failed';
  }
  console.error(`\nRun ended in phase: ${currentRun.run_phase}`);
  await printResumeLine();
  return 'failed';
}
