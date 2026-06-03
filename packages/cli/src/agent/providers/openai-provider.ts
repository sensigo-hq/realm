// openai-provider.ts — OpenAI LLM provider implementation for realm agent.
// Requires openai >= 4.0.0 as an optional peer dependency (npm install openai).
import { WorkflowError } from '@sensigo/realm';
import { ToolCapableLlmProvider, type ProviderCapabilities } from './llm-provider.js';
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
 * OpenAI LLM provider for realm agent.
 * Uses the Chat Completions API. Sends `response_format: json_object` on native
 * OpenAI endpoints; falls back to prompt-only JSON enforcement on compat endpoints
 * behind `--base-url`. Retries once if the model returns non-JSON content.
 */
export class OpenAIProvider extends ToolCapableLlmProvider {
  private readonly model: string;
  private readonly baseUrl: string | undefined;

  constructor(model: string, baseUrl?: string) {
    super();
    this.model = model;
    this.baseUrl = baseUrl;
  }

  /**
   * Native OpenAI endpoints have a well-defined, tested capability surface that includes
   * json_object mode. Custom compat endpoints behind --base-url do not guarantee this feature.
   * Default to prompt-only enforcement for any unknown endpoint.
   */
  capabilities(): ProviderCapabilities {
    return { jsonMode: this.baseUrl === undefined };
  }

  async callStep(
    prompt: string,
    inputSchema?: Record<string, unknown>,
    agentProfileInstructions?: string,
  ): Promise<Record<string, unknown>> {
    // Dynamically import openai to keep it an optional peer dependency.
    // Assigning the module specifier to a typed variable via 'string' makes TS
    // treat it as Promise<any>, bypassing static module resolution at build time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;
    try {
      const moduleId: string = 'openai';
      mod = await import(moduleId);
    } catch {
      console.error('realm agent requires the openai package. Run: npm install openai');
      process.exit(1);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new (mod.default as new (opts: Record<string, unknown>) => any)({
      apiKey: process.env['OPENAI_API_KEY'],
      ...(this.baseUrl !== undefined ? { baseURL: this.baseUrl } : {}),
    });

    const systemPrompt = buildSystemPrompt(inputSchema, agentProfileInstructions);
    type Message = { role: 'system' | 'user' | 'assistant'; content: string };
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ];

    const makeRequest = async (msgs: Message[]): Promise<string> => {
      const opts: Record<string, unknown> = {
        model: this.model,
        messages: msgs,
      };
      if (this.capabilities().jsonMode) {
        opts['response_format'] = { type: 'json_object' };
      }
      const response = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client.chat.completions.create as (opts: Record<string, unknown>) => Promise<any>)(opts);
      return (response.choices[0]?.message?.content as string | undefined) ?? '';
    };

    const content = await makeRequest(messages);
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Retry once with an explicit reminder to return JSON.
      const retryMessages: Message[] = [
        ...messages,
        { role: 'assistant', content },
        {
          role: 'user',
          content: 'Your previous response was not valid JSON. Respond with a JSON object only.',
        },
      ];
      const retry = await makeRequest(retryMessages);
      try {
        return JSON.parse(retry) as Record<string, unknown>;
      } catch {
        throw new Error(`OpenAI returned non-JSON content after retry: ${retry.slice(0, 200)}`);
      }
    }
  }

  /**
   * Agentic loop for tool-capable steps. Executes tool calls serially (V1 constraint)
   * until the model returns a final JSON answer or the tool call budget is exhausted.
   */
  async callStepWithTools(
    prompt: string,
    tools: ToolDefinition[],
    executor: ToolExecutor,
    options: {
      inputSchema?: Record<string, unknown>;
      maxToolCalls?: number;
      toolTimeoutMs?: number;
      agentProfileInstructions?: string;
    },
  ): Promise<StepWithToolsResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;
    try {
      const moduleId: string = 'openai';
      mod = await import(moduleId);
    } catch {
      console.error('realm agent requires the openai package. Run: npm install openai');
      process.exit(1);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new (mod.default as new (opts: Record<string, unknown>) => any)({
      apiKey: process.env['OPENAI_API_KEY'],
      ...(this.baseUrl !== undefined ? { baseURL: this.baseUrl } : {}),
    });

    const responseFormat = this.capabilities().jsonMode
      ? ({ type: 'json_object' } as const)
      : undefined;

    // toolIdMap: bareName → namespaced id, used to recover routing key from LLM responses.
    // Collision guard: two MCP servers may not expose the same bare tool name in the same step.
    const toolIdMap = new Map<string, string>();
    const openaiTools: Array<{
      type: 'function';
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }> = [];
    for (const tool of tools) {
      if (toolIdMap.has(tool.name)) {
        throw new Error(
          `invariant: duplicate bare tool name '${tool.name}' in toolIdMap — this should have been caught at toolDefs assembly in run-agent.ts`,
        );
      }
      toolIdMap.set(tool.name, tool.id);
      openaiTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      });
    }

    const maxCalls = options.maxToolCalls ?? 20;
    let tool_call_count = 0;
    const tool_call_records: ToolCallRecord[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history: any[] = [
      {
        role: 'system',
        content: buildSystemPrompt(options.inputSchema, options.agentProfileInstructions),
      },
      { role: 'user', content: prompt },
    ];

    const buildMainCallOpts = (): Record<string, unknown> => {
      const opts: Record<string, unknown> = { model: this.model, messages: history };
      if (openaiTools.length > 0) opts['tools'] = openaiTools;
      if (responseFormat !== undefined) opts['response_format'] = responseFormat;
      return opts;
    };

    const buildFinalCallOpts = (): Record<string, unknown> => {
      const opts: Record<string, unknown> = { model: this.model, messages: history };
      if (responseFormat !== undefined) opts['response_format'] = responseFormat;
      return opts;
    };

    // Injects the over-budget message and calls the API without tools to produce a final answer.
    const performFinalExtraction = async (): Promise<StepWithToolsResult> => {
      history.push({
        role: 'user',
        content:
          'You have reached the maximum number of tool calls. Produce your final JSON answer now using only what you have already gathered. No further tool calls will be executed.',
      });
      const final = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client.chat.completions.create as (opts: Record<string, unknown>) => Promise<any>)(
        buildFinalCallOpts(),
      );
      const text: string = (final.choices[0].message.content as string | null) ?? '';
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
      (client.chat.completions.create as (opts: Record<string, unknown>) => Promise<any>)(
        buildMainCallOpts(),
      );
      const message = response.choices[0].message as {
        content: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };

      if (message.tool_calls?.length) {
        const batch = message.tool_calls;
        history.push(message);
        let budget_exhausted_mid_batch = false;

        for (const tool of batch) {
          const llmToolCallId = tool.id; // captured verbatim — API returns 400 if echoed incorrectly

          if (tool_call_count >= maxCalls) {
            // Budget exhausted — must still answer every id in the assistant message.
            history.push({
              role: 'tool',
              tool_call_id: llmToolCallId,
              content: 'Error: tool call budget exhausted',
            });
            budget_exhausted_mid_batch = true;
            continue;
          }

          const originalId = toolIdMap.get(tool.function.name)!;
          const { serverId, toolName } = parseNamespacedId(originalId);
          const args = JSON.parse(tool.function.arguments || '{}') as Record<string, unknown>;
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
          history.push({ role: 'tool', tool_call_id: llmToolCallId, content: resultContent });
        }

        if (budget_exhausted_mid_batch || tool_call_count >= maxCalls) {
          return performFinalExtraction();
        }
      } else {
        // No tool calls — attempt to parse the final answer.
        const text: string = (message.content as string | null) ?? '';
        const parsed = tryParseJson(text);
        if (parsed && validateSchema(parsed, options.inputSchema)) {
          return { output: parsed, toolCalls: tool_call_records };
        }
        // Schema mismatch — append correction message and continue the loop.
        history.push({ role: 'assistant', content: text });
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
