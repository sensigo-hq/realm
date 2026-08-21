// anthropic-provider.ts — Anthropic LLM provider implementation for realm agent.
// Requires @anthropic-ai/sdk >= 0.20.0 as an optional peer dependency (npm install @anthropic-ai/sdk).
import {
  WorkflowError,
  validateAgentSubmission,
  type JsonSchema,
  type StructuredOutputMeta,
} from '@sensigo/realm';
import { ToolCapableLlmProvider, type ProviderCapabilities } from './llm-provider.js';
import type {
  ToolCallRecord,
  ToolDefinition,
  ToolExecutor,
  StepWithToolsResult,
} from '../mcp/mcp-extensions.js';
import {
  classBError,
  sanitizeError,
  serializeToolResult,
  parseNamespacedId,
  extractJsonObject,
  rejectAfter,
  buildSystemPrompt,
  summarizeAgentValidationErrors,
  renderValidationSummaryEntry,
  extractHttpStatus,
} from './agent-utils.js';

/** The tool offered at `tool_choice:'auto'` so the model can return structured output directly —
 * `tool_use.input` arrives pre-parsed, eliminating the fenced/prefaced-JSON parse-failure class by
 * construction. `auto` (never forced) preserves reason-then-answer: a workflow whose output schema
 * declares a reasoning field LAST must not have the model rationalize post-hoc (see the design
 * decision in prompts/robust-anthropic-provider.md). Not pushed into tool_call_records anywhere it's
 * used — it's an extraction mechanism, not an agent-chosen tool. */
const SUBMIT_TOOL_NAME = '__realm_submit__';

/**
 * Issue #236: `strict` is a NEW sanctioned option, threaded from run-agent through both call
 * sites of this builder (the main `callStep`/`callStepWithMeta` call AND `performFinalExtraction`
 * — design §4 [CG]). Default absent = today's behavior byte-identical: the key is only ever
 * added to the returned object when the caller explicitly opts in.
 */
function buildSubmitTool(
  schema: Record<string, unknown>,
  opts?: { strict?: boolean },
): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
} {
  return {
    name: SUBMIT_TOOL_NAME,
    description: 'Return your final result for this step as structured data.',
    input_schema: schema,
    ...(opts?.strict === true ? { strict: true } : {}),
  };
}

/**
 * Returns the maximum output tokens for the given Anthropic model.
 * The Anthropic Messages API requires max_tokens — this must always produce a valid value.
 * Source: https://docs.anthropic.com/en/docs/about-claude/models/all-models
 *
 * Issue #309 fix (ratified per design-d4-final.md's ADDENDUM, the audit's 3.5-cap correction):
 * the PRE-#309 regex (`claude-(3[-.]5|[a-z]+-4)`) was stale in a dangerous direction — it gave
 * the claude-3.5 family's OWN hard output cap (8192; 16384 would 400 every call) to EVERY 4.x
 * model too (claude-sonnet-4-5, claude-opus-4-1, …), silently under-budgeting them. Three
 * buckets now, ordered most-specific-first:
 *   1. claude-3.5 family (`claude-3-5-*` / `claude-3.5-*`) ⇒ 8192 — its OWN hard cap.
 *   2. Bare legacy claude-3 generation (claude-3-opus/-sonnet/-haiku, NOT 3.5) ⇒ 4096 — original,
 *      unchanged fallback.
 *   3. Everything else — 3.7, every 4.x/5.x model, and any UNKNOWN future model id — ⇒ 16384.
 *      Fail-forward (the stale-classifier lesson, #312 is the durable fix: an unrecognized model
 *      id is treated as AT LEAST as capable as today's models, never less; 16384 is
 *      non-streaming-safe and current models think by default, so 4096 would starve
 *      thinking+output on anything not explicitly bucketed above).
 */
function resolveMaxTokens(model: string): number {
  if (/claude-3[-.]5/i.test(model)) return 8192;
  if (/claude-3-(opus|sonnet|haiku)(-|$)/i.test(model)) return 4096;
  return 16384;
}

// ---------------------------------------------------------------------------------------------
// issue #236 — the fallback ladder. Any 400/503 on a request that carried `strict: true` drops
// strict, discloses, and retries ONCE; any other status propagates untouched (the arm keys on
// HTTP status ∧ strict-sent, NEVER on message text — design §4 [Rv5]).
// ---------------------------------------------------------------------------------------------

/** The captured grammar-compilation-unavailable text (premise-probe-raw.md's own canonical mock
 *  — the label match keys on THIS string only, never a broader "any 503" heuristic). A stale/
 *  non-matching message degrades to the generic `service_unavailable` label (fail-safe). */
const GRAMMAR_UNAVAILABLE_TEXT = 'Grammar compilation is temporarily unavailable';

// Issue #313: `extractHttpStatus` now lives in agent-utils.ts, shared with the OpenAI ladder —
// a pure move, zero behaviour change. `extractErrorMessage` deliberately stays local.

function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Thrown when the ladder's OWN drop-strict retry ALSO fails — design §4 [R2-7]: (a) carries the
 * `structuredOutput` meta so a catch site can still disclose the downgrade even though no result
 * was ever produced (run-agent's sticky map is armed from this on failure paths too), (b) sets
 * the ORIGINAL (retry) error as `cause`, (c) adopts that error's own message verbatim — run-agent
 * prints `err.message` directly at its two LLM-call catch sites, so this must describe what
 * ACTUALLY failed (the retry's real error), never a generic wrapper string.
 */
export class StructuredOutputLadderError extends Error {
  readonly structuredOutput: StructuredOutputMeta;
  constructor(
    message: string,
    structuredOutput: StructuredOutputMeta,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StructuredOutputLadderError';
    this.structuredOutput = structuredOutput;
  }
}

/** Per-`callStepInternal`-invocation ladder state — STICKY within the call: once a downgrade
 *  happens, every LATER `client.messages.create` in the SAME invocation (e.g. the non-JSON-retry
 *  leg) goes out without strict too, never re-attempting it. */
interface LadderState {
  strict: boolean;
  meta: StructuredOutputMeta | undefined;
}

/**
 * Wraps ONE `client.messages.create` call with the strict fallback ladder. `buildOpts(strict)`
 * must build the FULL request options for that boolean — called fresh on every attempt so a
 * downgrade takes effect immediately. Non-strict calls (state.strict already false, OR strict was
 * never requested for this invocation) pass straight through with no ladder engagement at all —
 * byte-identical to pre-#236 behavior.
 */
async function createMessageWithLadder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  buildOpts: (strict: boolean) => Record<string, unknown>,
  state: LadderState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  if (!state.strict) {
    return (client.messages.create as (opts: Record<string, unknown>) => Promise<unknown>)(
      buildOpts(false),
    );
  }
  try {
    const response = await (
      client.messages.create as (opts: Record<string, unknown>) => Promise<unknown>
    )(buildOpts(true));
    state.meta = { requested: true, sent: true };
    return response;
  } catch (err) {
    const status = extractHttpStatus(err);
    if (status !== 400 && status !== 503) throw err; // unrelated failure — never engage the ladder
    const api_message = extractErrorMessage(err);
    const downgrade_reason: NonNullable<StructuredOutputMeta['downgrade_reason']> =
      status === 400
        ? 'api_rejected_schema'
        : api_message.includes(GRAMMAR_UNAVAILABLE_TEXT)
          ? 'grammar_unavailable'
          : 'service_unavailable';
    state.strict = false; // sticky for the rest of THIS invocation
    try {
      const response = await (
        client.messages.create as (opts: Record<string, unknown>) => Promise<unknown>
      )(buildOpts(false));
      state.meta = { requested: true, sent: false, downgrade_reason, api_message };
      return response;
    } catch (retryErr) {
      throw new StructuredOutputLadderError(
        extractErrorMessage(retryErr),
        { requested: true, sent: false, downgrade_reason, api_message },
        { cause: retryErr },
      );
    }
  }
}

/**
 * Anthropic LLM provider for realm agent.
 * Uses the Messages API and extracts JSON from the first text content block.
 * Retries once if the model returns non-JSON content.
 */
export class AnthropicProvider extends ToolCapableLlmProvider {
  constructor(private readonly model: string) {
    super();
  }

  /**
   * Issue #311 (capability guard). AnthropicProvider is the ONLY provider that reads
   * `ToolDefinition.strict` and threads it onto the request (see the `anthropicTools.push` in
   * `callStepWithTools`). Declaring `toolArgsStrict` here is what authorizes run-agent to mark
   * tools and to record `strict_sent: true` in evidence — a provider whose wire builder ignores
   * the marker must never produce that claim.
   *
   * `jsonMode` keeps the base value: this provider constrains output via the submit TOOL, never
   * via a `response_format` json_object mode.
   */
  capabilities(): ProviderCapabilities {
    return { jsonMode: false, toolArgsStrict: true, providerId: 'anthropic' };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    // Dynamically import @anthropic-ai/sdk to keep it an optional peer dependency.
    // See openai-provider.ts for an explanation of the 'string' cast technique.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;
    try {
      const moduleId: string = '@anthropic-ai/sdk';
      mod = await import(moduleId);
    } catch {
      console.error(
        'realm agent requires the @anthropic-ai/sdk package. Run: npm install @anthropic-ai/sdk',
      );
      process.exit(1);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (mod.default as new (opts: Record<string, unknown>) => any)({
      apiKey: process.env['ANTHROPIC_API_KEY'],
    });
  }

  /**
   * Shared body for `callStep`/`callStepWithMeta` (issue #236). `strictRequested` is `undefined`
   * for `callStep`'s own byte-identical-behavior contract (no ladder state is even constructed);
   * `true`/`false` for `callStepWithMeta`. Returns `meta` only when strict was ever requested for
   * THIS invocation — a step that never opted in gets no `structuredOutput` meta at all.
   */
  private async callStepInternal(
    prompt: string,
    inputSchema: Record<string, unknown> | undefined,
    agentProfileInstructions: string | undefined,
    strictRequested: boolean | undefined,
  ): Promise<{ output: Record<string, unknown>; meta?: StructuredOutputMeta }> {
    const client = await this.getClient();
    const state: LadderState = { strict: strictRequested === true, meta: undefined };

    // P0: offer a schema-typed __realm_submit__ tool at tool_choice:'auto' (never forced — see the
    // module-level SUBMIT_TOOL_NAME comment) when a schema is available; a tool_use.input arrives
    // pre-parsed, so this eliminates the fenced/prefaced-JSON parse-failure class by construction.
    // Without a schema there is nothing to type the tool with, so no tool is offered — falls straight
    // to the P1 extractor below. `hasSchema` — NOT `strict` — governs buildSystemPrompt: the O8
    // honesty mechanism depends on the original schema staying model-visible regardless of strict
    // (design §4, pinned by test — buildSystemPrompt is byte-invariant under strict).
    const hasSchema = inputSchema !== undefined;
    const systemPrompt = buildSystemPrompt(
      inputSchema,
      agentProfileInstructions,
      /* structuredToolOffered */ hasSchema,
    );

    interface CallResult {
      toolInput?: Record<string, unknown>;
      text: string;
      stopReason?: string;
    }

    const makeRequest = async (userContent: string): Promise<CallResult> => {
      const buildOpts = (strict: boolean): Record<string, unknown> => {
        const submitTool = hasSchema
          ? buildSubmitTool(inputSchema!, strict ? { strict: true } : undefined)
          : undefined;
        const opts: Record<string, unknown> = {
          model: this.model,
          max_tokens: resolveMaxTokens(this.model),
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
        };
        if (submitTool !== undefined) {
          opts['tools'] = [submitTool];
          opts['tool_choice'] = { type: 'auto' };
        }
        return opts;
      };
      const response = await createMessageWithLadder(client, buildOpts, state);
      const blocks = response.content as Array<{
        type: string;
        text?: string;
        name?: string;
        input?: unknown;
      }>;
      const toolUse = blocks.find((b) => b.type === 'tool_use' && b.name === SUBMIT_TOOL_NAME);
      const textBlock = blocks.find((b) => b.type === 'text');
      return {
        ...(toolUse !== undefined ? { toolInput: toolUse.input as Record<string, unknown> } : {}),
        text: textBlock?.text ?? '',
        ...(typeof response.stop_reason === 'string' ? { stopReason: response.stop_reason } : {}),
      };
    };

    // If the model called the tool, its input is ALREADY a parsed object — no parse step, done.
    // Otherwise fall back to the robust extractor (P1) on the text answer.
    const extract = (result: CallResult): Record<string, unknown> | null =>
      result.toolInput ?? extractJsonObject(result.text);

    // issue #236: submission_channel — the standing dodge detector (design record R-B). Set on
    // whichever result actually produced the returned output.
    const withChannel = (
      output: Record<string, unknown>,
      viaTool: boolean,
    ): { output: Record<string, unknown>; meta?: StructuredOutputMeta } => {
      if (state.meta === undefined) return { output };
      return {
        output,
        meta: { ...state.meta, submission_channel: viaTool ? 'tool' : 'text' },
      };
    };

    const first = await makeRequest(prompt);
    const firstParsed = extract(first);
    if (firstParsed !== null) return withChannel(firstParsed, first.toolInput !== undefined);

    // Retry once with an explicit reminder to return JSON (preserves today's retry shape).
    const retryPrompt = `${prompt}\n\nYour previous response was not valid JSON. Respond with a JSON object only.`;
    const retry = await makeRequest(retryPrompt);
    const retryParsed = extract(retry);
    if (retryParsed !== null) return withChannel(retryParsed, retry.toolInput !== undefined);

    // Guard: a response cut short by the token budget must never silently return a partial object —
    // give a clear, distinct error rather than the generic "non-JSON content" message.
    if (retry.stopReason === 'max_tokens') {
      throw new WorkflowError(
        sanitizeError(
          'Anthropic response was truncated (max_tokens) before a usable JSON object was produced.',
        ),
        { code: 'ENGINE_STEP_FAILED', category: 'ENGINE', agentAction: 'stop', retryable: false },
      );
    }
    throw new WorkflowError(
      sanitizeError(`Anthropic returned non-JSON content after retry: ${retry.text.slice(0, 200)}`),
      { code: 'ENGINE_STEP_FAILED', category: 'ENGINE', agentAction: 'stop', retryable: false },
    );
  }

  async callStep(
    prompt: string,
    inputSchema?: Record<string, unknown>,
    agentProfileInstructions?: string,
  ): Promise<Record<string, unknown>> {
    const { output } = await this.callStepInternal(
      prompt,
      inputSchema,
      agentProfileInstructions,
      undefined,
    );
    return output;
  }

  /** issue #236 override — the only provider in this codebase that actually honors
   *  `opts.structuredOutputStrict`; the base class's default just wraps `callStep`. */
  override async callStepWithMeta(
    prompt: string,
    inputSchema?: Record<string, unknown>,
    agentProfileInstructions?: string,
    opts?: { structuredOutputStrict?: boolean },
  ): Promise<{ output: Record<string, unknown>; meta?: StructuredOutputMeta }> {
    return this.callStepInternal(
      prompt,
      inputSchema,
      agentProfileInstructions,
      opts?.structuredOutputStrict === true,
    );
  }

  /**
   * Agentic loop for tool-capable steps. Executes tool calls serially (V1 constraint).
   * All tool results for one turn are accumulated into a single user message with an array
   * of tool_result blocks — the Anthropic API rejects interleaved assistant/user turns.
   */
  async callStepWithTools(
    prompt: string,
    tools: ToolDefinition[],
    executor: ToolExecutor,
    options: {
      inputSchema?: Record<string, unknown>;
      validationInputSchema?: Record<string, unknown>;
      validationOutputSchema?: Record<string, unknown>;
      maxToolCalls?: number;
      maxFanOut?: number;
      toolTimeoutMs?: number;
      agentProfileInstructions?: string;
    },
  ): Promise<StepWithToolsResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;
    try {
      const moduleId: string = '@anthropic-ai/sdk';
      mod = await import(moduleId);
    } catch {
      console.error(
        'realm agent requires the @anthropic-ai/sdk package. Run: npm install @anthropic-ai/sdk',
      );
      process.exit(1);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new (mod.default as new (opts: Record<string, unknown>) => any)({
      apiKey: process.env['ANTHROPIC_API_KEY'],
    });

    // toolIdMap: bareName → namespaced id, used to recover routing key from LLM responses.
    // Collision guard: two MCP servers may not expose the same bare tool name in the same step.
    const toolIdMap = new Map<string, string>();
    const anthropicTools: Array<{
      name: string;
      description: string;
      input_schema: Record<string, unknown>;
      strict?: boolean; // issue #311 — per-tool, set only for run-agent-selected tools
    }> = [];
    for (const tool of tools) {
      if (toolIdMap.has(tool.name)) {
        throw new Error(
          `invariant: duplicate bare tool name '${tool.name}' in toolIdMap — this should have been caught at toolDefs assembly in run-agent.ts`,
        );
      }
      toolIdMap.set(tool.name, tool.id);
      anthropicTools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema, // note: input_schema, not parameters
        // issue #311: per-tool strict, same spread SHAPE as buildSubmitTool's own `strict` option
        // — the key only ever appears when run-agent selected this tool, so a non-selected tool's
        // wire entry stays byte-identical to today's.
        ...(tool.strict === true ? { strict: true } : {}),
      });
    }

    const maxCalls = options.maxToolCalls ?? 20;
    const maxFanOut = options.maxFanOut;
    let fan_out_count = 0;
    let fan_out_budget_exhausted = false;
    let tool_call_count = 0;
    // issue #224 (D6): in-conversation schema corrections draw on the SAME shared `maxToolCalls`
    // budget as tool calls (deliberate — see the design record's shared-budget rationale), with
    // ZERO `tool_call_records` entry each, so a step can starve its own tool budget invisibly.
    // This counter + the per-correction stderr breadcrumb below are the chosen mitigation
    // (visibility, not budget separation).
    let correction_count = 0;
    const tool_call_records: ToolCallRecord[] = [];
    const system = buildSystemPrompt(options.inputSchema, options.agentProfileInstructions);
    /** Attaches `correctionCount` to a result only when at least one correction happened, plus
     *  (issue #311) the tool-args drop facts when the ladder below dropped strict mid-attempt.
     *  This is the single result chokepoint for `callStepWithTools` — every successful return
     *  goes through it, so neither field can be forgotten on a new exit path. */
    const withCorrectionCount = (result: StepWithToolsResult): StepWithToolsResult => ({
      ...result,
      ...(correction_count > 0 ? { correctionCount: correction_count } : {}),
      ...(toolArgsStrictDrop !== undefined ? { toolArgsStrictDrop } : {}),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history: any[] = [{ role: 'user', content: prompt }];

    const buildMainCallOpts = (): Record<string, unknown> => {
      const opts: Record<string, unknown> = {
        model: this.model,
        max_tokens: resolveMaxTokens(this.model),
        system,
        messages: history,
      };
      if (anthropicTools.length > 0) {
        // issue #311: once strict has been dropped, every later turn sends STRIPPED COPIES rather
        // than the mutated originals. Mutating the shared objects in place would retroactively
        // rewrite the request objects already handed to the SDK for earlier turns — an aliasing
        // hazard, and it makes the wire history unreadable (a request that genuinely carried
        // strict would appear never to have). Pre-drop — which includes every step that never
        // opted in — the original array is passed exactly as before, with no copy.
        opts['tools'] = toolArgsStrictStripped
          ? anthropicTools.map(({ strict: _strict, ...rest }) => rest)
          : anthropicTools;
      }
      return opts;
    };

    // -----------------------------------------------------------------------------------------
    // issue #311 — the tool-arguments fallback ladder. ONE wrap point on the main agentic loop's
    // only `messages.create`, which covers every turn of the loop including the #224
    // in-conversation correction turns.
    //
    // Deliberately SEPARATE from the #236 ladder above (which owns the step-OUTPUT dimension on
    // the callStep/callStepWithMeta path): the two dimensions fail independently, and the
    // stickiness rules differ (see below). Status-only, exactly like #236 — the arm keys on HTTP
    // status ∧ strict-carried, NEVER on message text.
    // -----------------------------------------------------------------------------------------
    let toolArgsStrictActive = anthropicTools.some((t) => t.strict === true);
    let toolArgsStrictStripped = false;
    let strictTurnsBeforeDrop = 0;
    let toolArgsStrictDrop: StepWithToolsResult['toolArgsStrictDrop'];

    /** Stops sending strict for the REST of this invocation (the immediate retry included). */
    const dropToolArgsStrict = (): void => {
      toolArgsStrictActive = false;
      toolArgsStrictStripped = true;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createMainTurn = async (): Promise<any> => {
      const carriedStrict = toolArgsStrictActive;
      try {
        const response = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client.messages.create as (opts: Record<string, unknown>) => Promise<any>)(
          buildMainCallOpts(),
        );
        // Only a strict-DECORATED request that came back 200 counts toward the disclosed
        // "turns before drop" — that is exactly what the number claims.
        if (carriedStrict) strictTurnsBeforeDrop += 1;
        return response;
      } catch (err) {
        // A turn that carried NO strict is none of this ladder's business: its 400 is a real
        // failure of the request itself and must propagate untouched, never be re-attributed to
        // structured output.
        if (!carriedStrict) throw err;
        const status = extractHttpStatus(err);
        if (status !== 400 && status !== 503) throw err; // unrelated failure — never engage
        const api_message = extractErrorMessage(err);
        const reason =
          status === 400
            ? 'api_rejected_schema'
            : api_message.includes(GRAMMAR_UNAVAILABLE_TEXT)
              ? 'grammar_unavailable'
              : 'service_unavailable';
        // Recorded BEFORE the drop so `strict_turns_before_drop` reports the 200s that preceded
        // this rejection (0 = the first strict-carrying turn of the attempt was rejected).
        toolArgsStrictDrop = {
          reason,
          api_message,
          strict_turns_before_drop: strictTurnsBeforeDrop,
        };
        dropToolArgsStrict();
        // Retry the SAME turn once, unconstrained. A failure here is a genuine call failure and
        // propagates — realm does not swallow it behind the ladder.
        return await // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client.messages.create as (opts: Record<string, unknown>) => Promise<any>)(
          buildMainCallOpts(),
        );
      }
    };

    // Forces a final answer: offers the __realm_submit__ tool at tool_choice:'auto' when a schema is
    // available (mirrors callStep's P0 mechanism — tool_use.input arrives pre-parsed, no parse step);
    // otherwise forces a plain text answer (tool_choice:'none', no tools array — can't type a tool
    // without a schema) and falls to the P1 extractor. Does NOT push to history — callers must ensure
    // history ends with a valid user turn. NOT restructuring the agentic loop / MCP tools array —
    // this synthetic tool only ever appears on this ONE isolated extraction call.
    const performFinalExtraction = async (): Promise<StepWithToolsResult> => {
      // issue #236 + #311: buildSubmitTool's `strict` option is never threaded here — BY DESIGN
      // now, no longer by construction.
      //
      // The old reasoning was that G6 made every tools-bearing step ineligible for strict, so a
      // `true` could never reach this path at all. #311 killed that premise: a tools-bearing step
      // CAN now be strict-declared, and its tools do carry strict on the wire. What #311 does NOT
      // change is this call: the final extraction asks the model for the STEP'S OUTPUT, which on
      // the tools fork is deliberately never grammar-constrained (that is precisely what the
      // step-level `unsupported_context_tools` disclosure reports). Constraining it here would
      // make that disclosure a lie.
      //
      // The old "no end-to-end pin is possible here — do not add one" instruction is therefore
      // obsolete and is REPLACED: the pin is now both possible and required (test plan pin 15 —
      // on an opted-in tools step, this call's opts never contain `strict`).
      const finalSubmitTool =
        options.inputSchema !== undefined ? buildSubmitTool(options.inputSchema) : undefined;
      const finalOpts: Record<string, unknown> = {
        model: this.model,
        max_tokens: resolveMaxTokens(this.model),
        system,
        messages: history,
      };
      if (finalSubmitTool !== undefined) {
        finalOpts['tools'] = [finalSubmitTool];
        finalOpts['tool_choice'] = { type: 'auto' };
      } else {
        finalOpts['tool_choice'] = { type: 'none' };
        // NO tools array — enforces text-only response
        // NO response_format — Anthropic's structured-output mechanism is strict TOOL USE
        // (issue #236's `structured_output: 'strict'`, wired through buildSubmitTool's `strict`
        // option above), not an `output_config.format` request parameter — deliberately not
        // used here (banked, design record R-P).
      }
      const final = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client.messages.create as (opts: Record<string, unknown>) => Promise<any>)(finalOpts);
      const blocks = final.content as Array<{
        type: string;
        text?: string;
        name?: string;
        input?: unknown;
      }>;
      // Extraction mechanism, not an agent-chosen tool — deliberately NOT pushed into
      // tool_call_records (would pollute stepMeta.toolCalls, run-agent.ts:487).
      const toolUse = blocks.find((b) => b.type === 'tool_use' && b.name === SUBMIT_TOOL_NAME);
      // issue #224 (D4, §4 budget-exhaustion terminal): RETURN the best-effort output here
      // UNCONDITIONALLY — never gate this return on schema conformance. A still-invalid output
      // routes back through the engine's Step 2c `countRejection` (execution-loop.ts), so issue
      // #220 counts the rejection and terminalizes at threshold (or default-substitutes, for a
      // `mode:'default'` step). Throwing here instead — which is what would happen if this were
      // gated on validateAgentSubmission — is caught at run-agent.ts:579-584, which returns
      // 'failed' WITHOUT ever calling executeChain: the run record is never counted, never
      // sealed, and a re-attach re-executes every tool call from scratch. Only a genuine
      // PARSE failure (no usable object at all — the throw below) is a distinct class that must
      // still throw. This was already Anthropic's behavior before #224 (never gated on schema
      // here) — #224 UNIFIES OpenAI onto the same posture (see openai-provider.ts).
      if (toolUse !== undefined) {
        return withCorrectionCount({
          output: toolUse.input as Record<string, unknown>,
          toolCalls: tool_call_records,
        });
      }
      const textBlock = blocks.find((b) => b.type === 'text');
      const text = textBlock?.text ?? '';
      const parsed = extractJsonObject(text);
      if (parsed !== null) {
        return withCorrectionCount({ output: parsed, toolCalls: tool_call_records });
      }
      // Parse failure — a DISTINCT class from schema-invalid (no usable object could be
      // extracted at all) — this is the ONE case that still throws.
      throw new WorkflowError(
        sanitizeError(`max_tool_calls reached; final extraction failed: ${text.slice(0, 200)}`),
        {
          code: 'ENGINE_STEP_FAILED',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: false,
        },
      );
    };

    while (true) {
      const response = await createMainTurn();
      const toolUseBlocks = (
        response.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>
      ).filter((b) => b.type === 'tool_use');

      if (toolUseBlocks.length > 0) {
        history.push({ role: 'assistant', content: response.content });

        const anthropic_result_blocks: Array<{
          type: 'tool_result';
          tool_use_id: string;
          content: string;
        }> = [];
        let budget_exhausted_mid_batch = false;

        for (const block of toolUseBlocks) {
          const llmToolCallId = block.id!; // captured verbatim — "toolu_01abc..."

          if (tool_call_count >= maxCalls || fan_out_budget_exhausted) {
            // Budget exhausted — must still answer every id in the assistant message.
            anthropic_result_blocks.push({
              type: 'tool_result',
              tool_use_id: llmToolCallId,
              content: 'Error: tool call budget exhausted',
            });
            budget_exhausted_mid_batch = true;
            continue;
          }

          const originalId = toolIdMap.get(block.name!)!;
          const { serverId, toolName } = parseNamespacedId(originalId);
          const args = (block.input ?? {}) as Record<string, unknown>;
          const start = Date.now();

          let resultContent: string;
          let record: ToolCallRecord;

          try {
            const rawResult = await Promise.race([
              executor(originalId, args),
              rejectAfter(options.toolTimeoutMs ?? 30000),
            ]);
            const serialized = serializeToolResult(rawResult);
            // issue #345: a call that RETURNED with `isError: true` failed politely — Class B. The
            // record gains `error` so it stops reading as a success; `result` keeps the full
            // serialized payload (evidence is never discarded) and `resultContent` — what the
            // MODEL sees — is byte-untouched, because how the model is told is a conversation
            // decision this fix has no business changing.
            const classB = classBError(rawResult);
            record = {
              server_id: serverId,
              tool: toolName,
              args,
              result: serialized,
              duration_ms: Date.now() - start,
              ...(classB !== undefined ? { error: classB } : {}),
            };
            resultContent = serialized;
          } catch (err) {
            const sanitized = sanitizeError(err);
            const content = sanitized.length > 0 ? `Error: ${sanitized}` : 'Error: (redacted)';
            record = {
              server_id: serverId,
              tool: toolName,
              args,
              result: null,
              duration_ms: Date.now() - start,
              error: sanitized,
            };
            resultContent = content;
          }

          tool_call_records.push(record);
          tool_call_count++;
          if (
            maxFanOut !== undefined &&
            (toolName === 'start_run' || toolName === 'start_run_batch')
          ) {
            fan_out_count++;
            if (fan_out_count >= maxFanOut) {
              fan_out_budget_exhausted = true;
              budget_exhausted_mid_batch = true;
            }
          }
          anthropic_result_blocks.push({
            type: 'tool_result',
            tool_use_id: llmToolCallId,
            content: resultContent,
          });
        }

        const exhausted = budget_exhausted_mid_batch || tool_call_count >= maxCalls;

        if (exhausted) {
          // Merge tool results and extraction prompt into a single user message to avoid
          // consecutive user messages, which the Anthropic API rejects with 400.
          history.push({
            role: 'user',
            content: [
              ...anthropic_result_blocks,
              {
                type: 'text' as const,
                text: 'You have reached the maximum number of tool calls. Produce your final JSON answer now using only what you have already gathered. No further tool calls will be executed.',
              },
            ],
          });
          return performFinalExtraction();
        }

        // Normal continuation — single user message with all tool_result blocks.
        history.push({ role: 'user', content: anthropic_result_blocks });
      } else {
        // No tool calls — attempt to parse the final answer. extractJsonObject (P1) parses a
        // fenced text answer immediately instead of nudging the model up to maxCalls.
        // issue #224 (D4, the primary edit): the required-keys-only `validateSchema` pre-check is
        // REPLACED with the full-AJV `validateAgentSubmission` (core) — right-keys-wrong-type/
        // enum/nested-shape output is now caught and corrected IN-CONVERSATION (tool results
        // retained, nothing re-executes), instead of passing through to die at the engine's drive.
        const textBlock = (response.content as Array<{ type: string; text?: string }>).find(
          (b) => b.type === 'text',
        );
        const text = textBlock?.text ?? '';
        const parsed = extractJsonObject(text);
        const verdict =
          parsed !== null
            ? validateAgentSubmission(
                parsed,
                {
                  ...(options.validationInputSchema !== undefined
                    ? { inputSchema: options.validationInputSchema as JsonSchema }
                    : {}),
                  ...(options.validationOutputSchema !== undefined
                    ? { outputSchema: options.validationOutputSchema as JsonSchema }
                    : {}),
                },
                'callStepWithTools',
              )
            : undefined;
        if (parsed !== null && verdict?.valid === true) {
          return withCorrectionCount({ output: parsed, toolCalls: tool_call_records });
        }
        // Invalid (schema-invalid OR unparseable) — append a leak-safe correction and keep
        // looping. D5: names/paths/keywords + expected types + enum/const allowedValues, NEVER
        // the offending value (ajv 8.18.0's default `message` embeds no offending value for any
        // AC-2 keyword). D6: one breadcrumb per correction — corrections consume the SHARED
        // maxToolCalls budget invisibly (no tool_call_records entry), so this is the mitigation.
        correction_count++;
        const summary =
          verdict !== undefined
            ? summarizeAgentValidationErrors(verdict.rawErrors)
                .map(renderValidationSummaryEntry)
                .join('\n')
            : 'no valid JSON object could be extracted from the response';
        console.error(`  ⚠ output rejected (in-conversation); correcting (${correction_count})`);
        history.push({ role: 'assistant', content: response.content });
        history.push({
          role: 'user',
          content: `Your response did not match the required JSON schema: ${summary}. Try again.`,
        });
        tool_call_count++; // schema correction consumes a slot
        if (tool_call_count >= maxCalls) {
          return performFinalExtraction();
        }
      }
    }
  }
}
