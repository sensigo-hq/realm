// anthropic-provider.ts — Anthropic LLM provider implementation for realm agent.
// Requires @anthropic-ai/sdk >= 0.20.0 as an optional peer dependency (npm install @anthropic-ai/sdk).
import { WorkflowError, validateAgentSubmission, type JsonSchema } from '@sensigo/realm';
import { ToolCapableLlmProvider } from './llm-provider.js';
import type {
  ToolCallRecord,
  ToolDefinition,
  ToolExecutor,
  StepWithToolsResult,
} from '../mcp/mcp-extensions.js';
import {
  sanitizeError,
  serializeToolResult,
  parseNamespacedId,
  extractJsonObject,
  rejectAfter,
  buildSystemPrompt,
  summarizeAgentValidationErrors,
  renderValidationSummaryEntry,
} from './agent-utils.js';

/** The tool offered at `tool_choice:'auto'` so the model can return structured output directly —
 * `tool_use.input` arrives pre-parsed, eliminating the fenced/prefaced-JSON parse-failure class by
 * construction. `auto` (never forced) preserves reason-then-answer: a workflow whose output schema
 * declares a reasoning field LAST must not have the model rationalize post-hoc (see the design
 * decision in prompts/robust-anthropic-provider.md). Not pushed into tool_call_records anywhere it's
 * used — it's an extraction mechanism, not an agent-chosen tool. */
const SUBMIT_TOOL_NAME = '__realm_submit__';

function buildSubmitTool(schema: Record<string, unknown>): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
} {
  return {
    name: SUBMIT_TOOL_NAME,
    description: 'Return your final result for this step as structured data.',
    input_schema: schema,
  };
}

/**
 * Returns the maximum output tokens for the given Anthropic model.
 * The Anthropic Messages API requires max_tokens — this must always produce a valid value.
 * Source: https://docs.anthropic.com/en/docs/about-claude/models/all-models
 */
function resolveMaxTokens(model: string): number {
  // claude-3.5 and claude-4 families support 8192 output tokens.
  // Matches: claude-3-5-*, claude-3.5-*, claude-<name>-4-*, etc.
  if (/claude-(3[-.]5|[a-z]+-4)/i.test(model)) return 8192;
  return 4096; // safe fallback for claude-3 and any unrecognised model
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

  async callStep(
    prompt: string,
    inputSchema?: Record<string, unknown>,
    agentProfileInstructions?: string,
  ): Promise<Record<string, unknown>> {
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
    const client = new (mod.default as new (opts: Record<string, unknown>) => any)({
      apiKey: process.env['ANTHROPIC_API_KEY'],
    });

    // P0: offer a schema-typed __realm_submit__ tool at tool_choice:'auto' (never forced — see the
    // module-level SUBMIT_TOOL_NAME comment) when a schema is available; a tool_use.input arrives
    // pre-parsed, so this eliminates the fenced/prefaced-JSON parse-failure class by construction.
    // Without a schema there is nothing to type the tool with, so no tool is offered — falls straight
    // to the P1 extractor below.
    const submitTool = inputSchema !== undefined ? buildSubmitTool(inputSchema) : undefined;
    const systemPrompt = buildSystemPrompt(
      inputSchema,
      agentProfileInstructions,
      /* structuredToolOffered */ submitTool !== undefined,
    );

    interface CallResult {
      toolInput?: Record<string, unknown>;
      text: string;
      stopReason?: string;
    }

    const makeRequest = async (userContent: string): Promise<CallResult> => {
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
      const response = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client.messages.create as (opts: Record<string, unknown>) => Promise<any>)(opts);
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

    const first = await makeRequest(prompt);
    const firstParsed = extract(first);
    if (firstParsed !== null) return firstParsed;

    // Retry once with an explicit reminder to return JSON (preserves today's retry shape).
    const retryPrompt = `${prompt}\n\nYour previous response was not valid JSON. Respond with a JSON object only.`;
    const retry = await makeRequest(retryPrompt);
    const retryParsed = extract(retry);
    if (retryParsed !== null) return retryParsed;

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
    /** Attaches `correctionCount` to a result only when at least one correction happened. */
    const withCorrectionCount = (result: StepWithToolsResult): StepWithToolsResult =>
      correction_count > 0 ? { ...result, correctionCount: correction_count } : result;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history: any[] = [{ role: 'user', content: prompt }];

    const buildMainCallOpts = (): Record<string, unknown> => {
      const opts: Record<string, unknown> = {
        model: this.model,
        max_tokens: resolveMaxTokens(this.model),
        system,
        messages: history,
      };
      if (anthropicTools.length > 0) opts['tools'] = anthropicTools;
      return opts;
    };

    // Forces a final answer: offers the __realm_submit__ tool at tool_choice:'auto' when a schema is
    // available (mirrors callStep's P0 mechanism — tool_use.input arrives pre-parsed, no parse step);
    // otherwise forces a plain text answer (tool_choice:'none', no tools array — can't type a tool
    // without a schema) and falls to the P1 extractor. Does NOT push to history — callers must ensure
    // history ends with a valid user turn. NOT restructuring the agentic loop / MCP tools array —
    // this synthetic tool only ever appears on this ONE isolated extraction call.
    const performFinalExtraction = async (): Promise<StepWithToolsResult> => {
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
        // NO response_format — not a valid Anthropic parameter
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
      const response = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client.messages.create as (opts: Record<string, unknown>) => Promise<any>)(
        buildMainCallOpts(),
      );
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
            record = {
              server_id: serverId,
              tool: toolName,
              args,
              result: serialized,
              duration_ms: Date.now() - start,
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
