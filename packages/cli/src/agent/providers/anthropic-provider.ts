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
  tryParseJson,
  validateSchema,
  rejectAfter,
  buildSystemPrompt,
} from './agent-utils.js';

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

    const systemPrompt = buildSystemPrompt(inputSchema);

    const makeRequest = async (userContent: string): Promise<string> => {
      const response = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client.messages.create as (opts: Record<string, unknown>) => Promise<any>)({
        model: this.model,
        max_tokens: resolveMaxTokens(this.model),
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      });
      const block = (response.content as unknown[]).find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (b: any) => (b as { type?: string }).type === 'text',
      ) as { text?: string } | undefined;
      return block?.text ?? '';
    };

    const content = await makeRequest(prompt);
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Retry once with an explicit reminder to return JSON.
      const retryPrompt = `${prompt}\n\nYour previous response was not valid JSON. Respond with a JSON object only.`;
      const retry = await makeRequest(retryPrompt);
      try {
        return JSON.parse(retry) as Record<string, unknown>;
      } catch {
        throw new Error(`Anthropic returned non-JSON content after retry: ${retry.slice(0, 200)}`);
      }
    }
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
      toolTimeoutMs?: number;
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
    let tool_call_count = 0;
    const tool_call_records: ToolCallRecord[] = [];
    const system = buildSystemPrompt(options.inputSchema);

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

    // Calls the API with tool_choice: none and no tools array to force a plain text answer.
    // Does NOT push to history — callers must ensure history ends with a valid user turn.
    const performFinalExtraction = async (): Promise<StepWithToolsResult> => {
      const final = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client.messages.create as (opts: Record<string, unknown>) => Promise<any>)({
        model: this.model,
        max_tokens: resolveMaxTokens(this.model),
        system,
        messages: history,
        tool_choice: { type: 'none' },
        // NO tools array — enforces text-only response
        // NO response_format — not a valid Anthropic parameter
      });
      const textBlock = (final.content as Array<{ type: string; text?: string }>).find(
        (b) => b.type === 'text',
      );
      const text = textBlock?.text ?? '';
      const parsed = tryParseJson(text);
      if (parsed && validateSchema(parsed, options.inputSchema)) {
        return { output: parsed, toolCalls: tool_call_records };
      }
      throw new WorkflowError('max_tool_calls reached; final extraction failed', {
        code: 'ENGINE_STEP_FAILED',
        category: 'ENGINE',
        agentAction: 'stop',
        retryable: false,
      });
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

          if (tool_call_count >= maxCalls) {
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
        // No tool calls — attempt to parse the final answer.
        const textBlock = (response.content as Array<{ type: string; text?: string }>).find(
          (b) => b.type === 'text',
        );
        const text = textBlock?.text ?? '';
        const parsed = tryParseJson(text);
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
