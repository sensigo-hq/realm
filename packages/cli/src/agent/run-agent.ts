// run-agent.ts — Core agent loop logic, decoupled from the Commander handler for testability.
// Exports runAgent(), AgentDeps, AgentRunOptions, and AgentRunResult.
// All Slack-specific gate notification logic lives in slack-gate-notifier.ts.
import { join } from 'node:path';
import {
  loadWorkflowFromFile,
  findEligibleSteps,
  classifyInProgressClaims,
  executeChain,
  buildNextActions,
  findCapabilityBlockedSteps,
  unmetCapabilities,
  capabilityWarning,
  buildFailedAttemptRecord,
  WorkflowError,
  DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
  assessStructuredOutputEligibility,
  renderIneligibleMessage,
  type RunStore,
  type WorkflowDefinition,
  type StepDefinition,
  type PendingGate,
  type ExtensionRegistry,
  type McpServerConfig,
  type ToolCallRecord,
  type TraceBufferStore,
  type StructuredOutputMeta,
} from '@sensigo/realm';
import type { RunRecord, WorkflowRegistrar } from '@sensigo/realm';
import type { LlmProvider } from './providers/llm-provider.js';
import {
  sanitizeError,
  setAdditionalRedactionValues,
  renderValidationSummaryEntry,
} from './providers/agent-utils.js';
import { isToolCapable } from './providers/llm-provider.js';
import type { McpClient, ToolDefinition, ToolExecutor } from './mcp/mcp-extensions.js';
import { McpClient as McpClientImpl } from './mcp/mcp-client.js';
import { scheduleGateExpiryTimer } from './gate/gate-expiry-timer.js';
import { recordDriveFailure, buildEntry } from './drive-failure.js';

export type AgentRunResult = 'completed' | 'failed';

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
            'Use --provider openai with a standard chat model (e.g. gpt-4o), or --provider anthropic.',
        );
      }
    }

    try {
      while (!currentRun.terminal_state) {
        // --- Gate handling ---
        if (currentRun.pending_gate !== undefined) {
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
                `   ${label}: realm run respond ${runId} --gate ${gate.gate_id} --choice ${choice}`,
              );
            }
            // issue #291 (Deliverable 4e, Amendment 4): the ATTENDING-PROCESS enactment timer —
            // this IS "the non-Slack agent poll loop" the design names as its own timer host. A
            // no-op for a finding-only/non-expiring gate.
            const clearExpiryTimer = scheduleGateExpiryTimer(runId, gate, {
              store: deps.store,
              definition,
              registry: deps.registry,
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

        // --- Step execution ---
        const eligible = findEligibleSteps(definition, currentRun);
        if (eligible.length === 0) {
          // Detect-only wedge surfacing (issue #101): before exiting on "nothing eligible", check
          // whether the run is an after-claim wedge (an in-progress claim that is stale or
          // unknown-age). If so, print the claim state(s) + the exact reclaim remediation so the
          // operator is never silently parked. Phase 1 attach does NOT auto-reclaim.
          if (currentRun.in_progress_steps.length > 0) {
            const wedged = classifyInProgressClaims(currentRun).filter(
              (c) => c.state !== 'healthy',
            );
            if (wedged.length > 0) {
              console.log(
                `\n   ⚠ Run '${runId}' is wedged — a claimed step never settled (its runner likely died):`,
              );
              for (const c of wedged) {
                console.log(`     • ${c.step}: ${c.state}`);
                console.log(
                  `       recover with: realm run reclaim ${runId} --step ${c.step} --force`,
                );
              }
              console.log(
                `   (reclaim re-drives the step; its side effects may repeat — see 'realm run reclaim ${runId}' for a dry-run.)`,
              );
            }
          }
          break;
        }

        const stepName = eligible[0]!;
        // issue #401: never cleared. A throw AFTER this step settles mints with this step's name,
        // and conjunct (iv) of the drive_failing predicate then suppresses the finding — because
        // progress DID happen. Chosen, not incidental.
        currentStepName = stepName;
        const stepDef: StepDefinition = definition.steps[stepName]!;

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
        let result: Awaited<ReturnType<typeof executeChain>>;
        let repairsUsed = 0;
        let lastRejection: { kind: 'output' | 'input'; summary: string } | undefined;

        for (;;) {
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
            const nextActions = buildNextActions(definition, currentRun);
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
                console.error(
                  `\n✗ Step '${stepName}' (tools) failed: ${err instanceof Error ? err.message : String(err)}`,
                );
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
                  const { output, meta } = await deps.provider.callStepWithMeta(
                    promptForAttempt,
                    inputSchema,
                    agentProfileInstructions,
                    { structuredOutputStrict: structuredOutputPlan.send },
                  );
                  stepInput = output;
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
                  stepInput = await deps.provider.callStep(
                    promptForAttempt,
                    inputSchema,
                    agentProfileInstructions,
                  );
                }
              } catch (err) {
                // The catch-side sticky-arming block that used to live here is DELETED as dead
                // code: this catch returns 'failed' immediately, the sticky map is
                // per-invocation, and nothing later reads it. The SUCCESS-path arming site
                // above is the one that serves the #217 repair loop, and it is untouched.
                console.error(
                  `\n✗ Step '${stepName}' LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
                );
                await recordDriveFailure(
                  deps.store,
                  runId,
                  buildEntry(err, stepName, providerForEvidence ?? 'unknown', attemptStartedAt),
                );
                return 'failed';
              }
            }
          } else {
            // Auto step — the engine dispatches to the service adapter directly.
            console.log(`→ [auto] ${stepName}`);
            stepInput = {};
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
            input: stepInput,
            dispatcher: async () => stepInput,
            registry: deps.registry,
            ...(deps.traceBufferStore !== undefined
              ? { traceBufferStore: deps.traceBufferStore }
              : {}),
            // issue #236: stepMeta now ALSO passes when structuredOutput exists (previously only
            // passed when toolCalls existed) — the two are independent, either alone must thread.
            ...(toolCallsForMeta !== undefined || structuredOutputMetaForStep !== undefined
              ? {
                  stepMeta: {
                    ...(toolCallsForMeta !== undefined ? { toolCalls: toolCallsForMeta } : {}),
                    ...(structuredOutputMetaForStep !== undefined
                      ? { structuredOutput: structuredOutputMetaForStep }
                      : {}),
                  },
                }
              : {}),
            // issue #197 PR-2: a FRESH nonce per step-attempt — resolved per call, never cached, so
            // the strict-flip (checked inside shouldMintWriterNonce) is honored even if the env var
            // changes mid-process (tests flip it). Also fresh per issue #217 repair attempt, since
            // this call sits inside the repair loop.
            ...(shouldMintWriterNonce(deps) ? { writerNonce: crypto.randomUUID() } : {}),
          });

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

        if (result.status === 'error') {
          // #134: a NOT-REGISTERED handler/adapter settles RECOVERABLY — the run is NOT failed, the step
          // is parked awaiting a capable runner. Detect structurally via error_code (not message text) and
          // print capability-aware guidance instead of a bare `✗ Step failed`. The return stays 'failed'
          // (no 'blocked' AgentRunResult variant, by design) — the distinction lives in the message.
          // issue #401: a capability block mints NO drive-failure entry — the `capability_block`
          // finding already owns this disclosure, and two findings for one fact is noise.
          const isCapabilityBlock =
            result.error_code === 'ENGINE_HANDLER_NOT_REGISTERED' ||
            result.error_code === 'ENGINE_ADAPTER_NOT_REGISTERED';
          // issue #217: append the repair count ONLY when at least one repair actually ran — never
          // "after 0 schema-repair attempts".
          const repairSuffix =
            repairsUsed > 0 ? ` after ${repairsUsed} schema-repair attempts` : '';
          if (isCapabilityBlock) {
            currentRun = await deps.store.get(runId);
            const block = findCapabilityBlockedSteps(currentRun).find((b) => b.step === stepName);
            const need =
              block !== undefined
                ? `${block.requirement.kind} '${block.requirement.name}'`
                : result.error_code === 'ENGINE_HANDLER_NOT_REGISTERED'
                  ? 'the missing handler'
                  : 'the missing adapter';
            console.error(
              `\n⚠ Step '${stepName}' is blocked: ${need} is not registered in this runner. ` +
                `The run is NOT failed — add ${need} and re-attach (\`realm agent --run-id ${runId}\`).`,
            );
          } else {
            console.error(
              `\n✗ Step '${stepName}' failed: ${result.errors.join(', ')}${repairSuffix}`,
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
            // tools-path rejection, a concurrent writer's version bump, `schemaRetries: 0`, an
            // AUTO step — arrives here with `repairsUsed === 0` and wedges just the same.
            //
            // Applies to ALL execution kinds. An auto step's validation exit is write-free and
            // pre-claim, which wedges the run identically to an agent step's.
            if (
              result.error_code === 'VALIDATION_OUTPUT_SCHEMA' ||
              result.error_code === 'VALIDATION_INPUT_SCHEMA'
            ) {
              await recordDriveFailure(deps.store, runId, {
                at: new Date().toISOString(),
                step: stepName,
                provider: providerForEvidence ?? 'unknown',
                error_class: 'validation_rejected',
                // The literal mirrors drive-failure.ts's MESSAGE_CAP; exporting the constant is
                // deferred, so the two are kept in step by this cross-reference rather than by
                // the type system.
                message: sanitizeError(result.errors.join(', ')).slice(0, 500),
                elapsed_ms: Date.now() - attemptStartedAt,
              });
            }
          }
          return 'failed';
        }

        if (result.status === 'confirm_required') {
          // Gate will be handled at the top of the next iteration.
          currentRun = await deps.store.get(runId);
          continue;
        }

        currentRun = await deps.store.get(runId);
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
    await recordDriveFailure(deps.store, runId, {
      ...buildEntry(err, currentStepName ?? '', providerForEvidence ?? 'unknown', attemptStartedAt),
    });
    // RE-THROWS, never returns: `runAgent`'s public contract is that these propagate, and
    // commands/agent.ts stays the console floor for anything that happens before a run exists.
    throw err;
  }

  if (currentRun.run_phase === 'completed') {
    console.log(`\nRun complete: ${runId}`);

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
      console.log(`\nResult (${lastAgentEvidence.step_id}):`);
      const stepDef = definition.steps[lastAgentEvidence.step_id];
      const formatted =
        stepDef?.display !== undefined
          ? renderDisplay(stepDef.display, lastAgentEvidence.output_summary)
          : formatOutputForTerminal(lastAgentEvidence.output_summary);
      console.log(formatted);
    }

    return 'completed';
  }

  console.error(`\nRun ended in phase: ${currentRun.run_phase}`);
  return 'failed';
}
