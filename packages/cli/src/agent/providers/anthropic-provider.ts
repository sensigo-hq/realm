// anthropic-provider.ts — Anthropic LLM provider implementation for realm agent.
// Requires @anthropic-ai/sdk >= 0.20.0 as an optional peer dependency (npm install @anthropic-ai/sdk).
import { WorkflowError } from '@sensigo/realm';
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
  validateSchema,
  rejectAfter,
  buildSystemPrompt,
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
    const tool_call_records: ToolCallRecord[] = [];
    const system = buildSystemPrompt(options.inputSchema, options.agentProfileInstructions);

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
      if (toolUse !== undefined) {
        return {
          output: toolUse.input as Record<string, unknown>,
          toolCalls: tool_call_records,
        };
      }
      const textBlock = blocks.find((b) => b.type === 'text');
      const text = textBlock?.text ?? '';
      const parsed = extractJsonObject(text);
      if (parsed !== null) {
        return { output: parsed, toolCalls: tool_call_records };
      }
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
        // No tool calls — attempt to parse the final answer. extractJsonObject (P1) parses a fenced
        // text answer immediately instead of nudging the model up to maxCalls; validateSchema stays
        // the cheap required-keys pre-check for this correction loop (NOT the engine's Ajv validator).
        const textBlock = (response.content as Array<{ type: string; text?: string }>).find(
          (b) => b.type === 'text',
        );
        const text = textBlock?.text ?? '';
        const parsed = extractJsonObject(text);
        if (parsed && validateSchema(parsed, options.inputSchema)) {
          return { output: parsed, toolCalls: tool_call_records };
        }
        // Schema mismatch — append correction and keep looping.
        history.push({ role: 'assistant', content: response.content });
        history.push({
          role: 'user',
          content: 'Your response did not match the required JSON schema. Try again.',
        });
        tool_call_count++; // schema correction consumes a slot
        if (tool_call_count >= maxCalls) {
          return performFinalExtraction();
        }
      }
    }
  }
}
