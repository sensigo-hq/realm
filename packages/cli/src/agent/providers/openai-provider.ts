// openai-provider.ts — OpenAI LLM provider implementation for realm agent.
// Requires openai >= 4.0.0 as an optional peer dependency (npm install openai).
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
  sanitizeError,
  serializeToolResult,
  parseNamespacedId,
  extractJsonObject,
  rejectAfter,
  buildSystemPrompt,
  summarizeAgentValidationErrors,
  renderValidationSummaryEntry,
  extractHttpStatus,
  extractApiErrorFields,
} from './agent-utils.js';

/**
 * Issue #313: the schema name OpenAI requires on `response_format.json_schema`. Must match
 * `[a-zA-Z0-9_-]{1,64}`; it is an identifier for the schema, never shown to the model as content.
 */
const JSON_SCHEMA_NAME = 'realm_step_output';

/**
 * Issue #313 — the OpenAI analog of the Anthropic ladder's error: thrown when the drop-strict
 * RETRY also fails, carrying the meta so run-agent's no-result arm can still arm sticky and
 * disclose the downgrade for an attempt that produced no output at all. run-agent reads
 * `.structuredOutput` duck-typed, so this deliberately does not import the Anthropic class —
 * the two provider modules stay independently loadable (each SDK is an optional peer dep).
 */
export class OpenAIStructuredOutputLadderError extends Error {
  readonly structuredOutput: StructuredOutputMeta;
  constructor(
    message: string,
    structuredOutput: StructuredOutputMeta,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OpenAIStructuredOutputLadderError';
    this.structuredOutput = structuredOutput;
  }
}

/**
 * OpenAI LLM provider for realm agent.
 * Uses the Chat Completions API. Sends `response_format: json_object` on native
 * OpenAI endpoints; falls back to prompt-only JSON enforcement on compat endpoints
 * behind `--base-url`. Retries once if the model returns non-JSON content.
 */
export class OpenAIProvider extends ToolCapableLlmProvider {
  private readonly model: string;
  private readonly baseUrl: string | undefined;
  private readonly strictBaseUrl: boolean;

  constructor(model: string, baseUrl?: string, strictBaseUrl = false) {
    super();
    this.model = model;
    this.baseUrl = baseUrl;
    this.strictBaseUrl = strictBaseUrl;
  }

  /**
   * Native OpenAI endpoints have a well-defined, tested capability surface that includes
   * json_object mode. Custom compat endpoints behind --base-url do not guarantee this feature.
   * Default to prompt-only enforcement for any unknown endpoint.
   *
   * Issue #313: `strictGate` is set on a compat endpoint UNLESS the author attested via
   * `--strict-base-url`. Compat endpoints range from full grammar enforcement (vLLM,
   * llama.cpp, LM Studio) to accepting `response_format` and quietly ignoring it, and no
   * capability-discovery API exists — so realm defaults to not sending strict there and
   * discloses `compat_endpoint` rather than risk a silent non-enforcement.
   *
   * NOTE: `toolArgsStrict` is deliberately NOT declared yet — this provider's tools wire builder
   * still ignores the per-tool marker, so declaring it would resurrect exactly the falsity the
   * #350 capability guard fixed. It flips in the tool-args PR, together with the wire support.
   */
  capabilities(): ProviderCapabilities {
    return {
      jsonMode: this.baseUrl === undefined,
      providerId: 'openai',
      ...(this.baseUrl !== undefined && !this.strictBaseUrl
        ? { strictGate: 'compat_endpoint' as const }
        : {}),
    };
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
    const parsed = extractJsonObject(content);
    if (parsed !== null) return parsed;
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
    const retryParsed = extractJsonObject(retry);
    if (retryParsed !== null) return retryParsed;
    throw new Error(
      sanitizeError(`OpenAI returned non-JSON content after retry: ${retry.slice(0, 200)}`),
    );
  }

  /**
   * Issue #313 — the structured_output-aware entry point (the #236 rail against an OpenAI
   * override is formally overturned; see llm-provider.ts).
   *
   * Two paths, deliberately disjoint:
   *
   * - Strict NOT requested (a gate-ineligible, sticky, or compat-gated attempt, where run-agent
   *   already holds the meta it will record): delegate to `callStep` VERBATIM. The json_object
   *   path is therefore byte-identical to pre-#313 by construction, not by careful copying.
   * - Strict requested: Chat Completions `response_format: json_schema` with `strict: true`
   *   ALWAYS explicit. Omitting `strict` is NOT a neutral default — probe P1 executed it: an
   *   omitted flag yields 200 with the schema unenforced, i.e. a silent non-enforcement mode.
   *
   * The ladder is status-keyed, never message-keyed: a 400 on a strict-carrying request drops
   * strict and retries the turn once; a second 400 throws an error CARRYING the meta. Anything
   * else — 5xx, transport, timeouts — propagates untouched and never drops or sticks, because
   * OpenAI has no 503-grammar analog and a slow first strict call (schema compilation) must be
   * retried as transport, never recorded as a schema failure.
   */
  async callStepWithMeta(
    prompt: string,
    inputSchema?: Record<string, unknown>,
    agentProfileInstructions?: string,
    opts?: { structuredOutputStrict?: boolean },
  ): Promise<{ output: Record<string, unknown>; meta?: StructuredOutputMeta }> {
    if (opts?.structuredOutputStrict !== true || inputSchema === undefined) {
      return { output: await this.callStep(prompt, inputSchema, agentProfileInstructions) };
    }

    // Dynamically import openai to keep it an optional peer dependency (same `moduleId` idiom as
    // callStep — the indirection is what keeps the import out of static resolution).
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
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ];

    const buildOpts = (strict: boolean): Record<string, unknown> => ({
      model: this.model,
      messages,
      ...(strict
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: JSON_SCHEMA_NAME, strict: true, schema: inputSchema },
            },
          }
        : this.capabilities().jsonMode
          ? { response_format: { type: 'json_object' } }
          : {}),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const create = (o: Record<string, unknown>): Promise<any> =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client.chat.completions.create as (x: Record<string, unknown>) => Promise<any>)(o);

    /** Reads the answer, honouring the refusal field as an L1-class escape. */
    const readContent = (response: {
      choices?: Array<{ message?: { content?: string; refusal?: string | null } }>;
    }): Record<string, unknown> => {
      const message = response.choices?.[0]?.message;
      const refusal = message?.refusal;
      if (typeof refusal === 'string' && refusal.length > 0) {
        // A refusal is a well-formed API response, not a transport failure: surface it the same
        // way a non-JSON answer surfaces, so the existing validation/reask layer handles it.
        throw new Error(sanitizeError(`OpenAI refused the request: ${refusal.slice(0, 200)}`));
      }
      const parsed = extractJsonObject(message?.content ?? '');
      if (parsed !== null) return parsed;
      throw new Error(
        sanitizeError(
          `OpenAI returned non-JSON content under strict decoding: ${(message?.content ?? '').slice(0, 200)}`,
        ),
      );
    };

    try {
      const response = await create(buildOpts(true));
      return { output: readContent(response), meta: { requested: true, sent: true } };
    } catch (err) {
      const status = extractHttpStatus(err);
      // 5xx / transport / timeout: NEVER a downgrade and never sticky — the schema is not what
      // failed. Propagates so the caller's own retry treats it as the transport error it is.
      if (status !== 400) throw err;
      const api_message = err instanceof Error ? err.message : String(err);
      const meta: StructuredOutputMeta = {
        requested: true,
        sent: false,
        downgrade_reason: 'api_rejected_schema',
        api_message,
        ...extractApiErrorFields(err),
      };
      try {
        const retry = await create(buildOpts(false));
        return { output: readContent(retry), meta };
      } catch (retryErr) {
        throw new OpenAIStructuredOutputLadderError(
          retryErr instanceof Error ? retryErr.message : String(retryErr),
          meta,
          { cause: retryErr },
        );
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
    /** Attaches `correctionCount` to a result only when at least one correction happened. */
    const withCorrectionCount = (result: StepWithToolsResult): StepWithToolsResult =>
      correction_count > 0 ? { ...result, correctionCount: correction_count } : result;

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
      const parsed = extractJsonObject(text);
      // issue #224 (D4, §4 budget-exhaustion terminal): RETURN the best-effort output
      // UNCONDITIONALLY here — never gate this return on schema conformance (this UNIFIES OpenAI
      // onto Anthropic's pre-existing posture; see anthropic-provider.ts's twin comment for the
      // full #220-terminalization rationale). A still-invalid output routes back through the
      // engine's Step 2c `countRejection`, so issue #220 counts the rejection and terminalizes at
      // threshold (or default-substitutes for a `mode:'default'` step) — throwing here instead
      // would be caught at run-agent.ts:579-584 and return 'failed' WITHOUT ever calling
      // executeChain, leaving the run record uncounted and re-executing every tool call on
      // re-attach. Only a genuine PARSE failure (no usable object at all) still throws.
      if (parsed !== null) {
        return withCorrectionCount({ output: parsed, toolCalls: tool_call_records });
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

          if (tool_call_count >= maxCalls || fan_out_budget_exhausted) {
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
          history.push({ role: 'tool', tool_call_id: llmToolCallId, content: resultContent });
        }

        if (budget_exhausted_mid_batch || tool_call_count >= maxCalls) {
          return performFinalExtraction();
        }
      } else {
        // No tool calls — attempt to parse the final answer.
        // issue #224 (D4, the primary edit): the required-keys-only `validateSchema` pre-check is
        // REPLACED with the full-AJV `validateAgentSubmission` (core) — right-keys-wrong-type/
        // enum/nested-shape output is now caught and corrected IN-CONVERSATION (tool results
        // retained, nothing re-executes), instead of passing through to die at the engine's drive.
        const text: string = (message.content as string | null) ?? '';
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
        // the offending value. D6: one breadcrumb per correction.
        correction_count++;
        const summary =
          verdict !== undefined
            ? summarizeAgentValidationErrors(verdict.rawErrors)
                .map(renderValidationSummaryEntry)
                .join('\n')
            : 'no valid JSON object could be extracted from the response';
        console.error(`  ⚠ output rejected (in-conversation); correcting (${correction_count})`);
        history.push({ role: 'assistant', content: text });
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
