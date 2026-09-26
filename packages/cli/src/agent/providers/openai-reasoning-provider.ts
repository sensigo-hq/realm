// openai-reasoning-provider.ts — OpenAI reasoning model provider (o1-series) for realm agent.
// Extends LlmProvider (not ToolCapableLlmProvider) — o1-series models do not support the tools parameter.
import type { UsageRecord } from '@sensigo/realm';
import {
  LlmProvider,
  type ProviderCapabilities,
  type CallStepWithMetaResult,
} from './llm-provider.js';
import {
  buildSystemPrompt,
  extractJsonObject,
  sanitizeError,
  driveCreate,
  makeCountingFetch,
  MAX_RETRIES,
  type LlmClock,
  type WireCounters,
  attachBilledUsage,
} from './agent-utils.js';

/**
 * issue #600 PR 1a — the response's `usage` block, typed LOCALLY (same discipline as the other two
 * providers; `bounded` is `Promise<any>` here too since `rawCreate` was already `Promise<unknown>`
 * — the third erasure D1 names for this provider was the RETURN type, not this shape).
 */
export interface OpenAiReasoningUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

function toUsageRecord(
  index: number,
  requestStart: string,
  u: OpenAiReasoningUsage | undefined,
): UsageRecord {
  const num = (v: number | undefined): number | undefined =>
    typeof v === 'number' ? v : undefined;
  const promptTokens = num(u?.prompt_tokens);
  const cachedTokens = num(u?.prompt_tokens_details?.cached_tokens);
  const cacheWriteTokens = num(u?.prompt_tokens_details?.cache_write_tokens);
  return {
    request_index: index,
    request_start: requestStart,
    ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
    ...(promptTokens !== undefined && cachedTokens !== undefined
      ? { uncached_input_tokens: promptTokens - cachedTokens }
      : {}),
    ...(cachedTokens !== undefined ? { cache_read_input_tokens: cachedTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cache_write_tokens: cacheWriteTokens } : {}),
    ...(num(u?.completion_tokens) !== undefined ? { output_tokens: u!.completion_tokens! } : {}),
  };
}

function readOpenAiReasoningUsage(response: unknown): OpenAiReasoningUsage | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const u = (response as { usage?: unknown }).usage;
  if (typeof u !== 'object' || u === null) return undefined;
  return u as OpenAiReasoningUsage;
}

/**
 * Short alias so `rawCreate` fits on ONE line — the issue-#401 source rail greps providers for
 * `.create(` and requires `rawCreate =` on the SAME line; a wrapped call would make the rail stop
 * matching, and a source-text guard that stops matching does not fail, it stops guarding (the
 * #189 purge-guard lesson).
 */
type Rec = Record<string, unknown>;

/**
 * Returns the max_completion_tokens for the given OpenAI reasoning model.
 * For o1-series models this covers both reasoning tokens and visible output.
 * Source: https://platform.openai.com/docs/models
 */
function resolveMaxCompletionTokens(model: string): number {
  if (/^o1-mini/i.test(model)) return 65536;
  // o1, o1-preview, and any other o1 variant default to 32768.
  return 32768;
}

/**
 * OpenAI reasoning model provider for realm agent.
 * Handles the o1-series (o1, o1-mini, o1-preview), which differ from standard chat completions:
 * - No `response_format` parameter (JSON enforced via system prompt + retry).
 * - System prompt content is folded into the first user message — the safe
 *   universal approach for the full o1 lineage. (o1 originally rejected the
 *   system role; later versions accept it as a developer role, but prepending
 *   to the user message works uniformly across all revisions.)
 * - Tool calling is not supported — this class extends LlmProvider, not
 *   ToolCapableLlmProvider, so `isToolCapable` returns false for these instances.
 *   o3 and later support tools and route to OpenAIProvider instead.
 */
export class OpenAIReasoningProvider extends LlmProvider {
  private readonly model: string;

  constructor(model: string) {
    super();
    this.model = model;
  }

  /**
   * Issue #313: DECLARATION ONLY. `jsonMode` keeps the base value (this provider enforces JSON
   * through the prompt), and `providerId` exists so evidence names the provider honestly and so
   * the eligibility profile resolves explicitly rather than by accident. No `response_format`
   * work here: the o1 family's structured-output support is deliberately out of scope (#351).
   */
  capabilities(): ProviderCapabilities {
    return { jsonMode: false, providerId: 'openai-reasoning' };
  }

  /**
   * issue #600 PR 1a (D1a) — the shared body, matching the other two providers'
   * `callStepInternal`. `callStep`'s public signature stays untouched (constraint 2) — it calls
   * this and discards `usage` by construction.
   */
  private async callStepInternal(
    prompt: string,
    inputSchema?: Record<string, unknown>,
    agentProfileInstructions?: string,
    callOpts?: { llmClock?: LlmClock },
    // issue #600 PR 1a (D9): owned by the entry point so one `catch` there sees everything billed.
    billed?: UsageRecord[],
  ): Promise<{ output: Record<string, unknown>; usage?: UsageRecord[] }> {
    const clock = callOpts?.llmClock;
    // issue #401: per-invocation counters, minted beside the client they count for.
    const counters: WireCounters = { attempts: 0 };
    // Dynamically import openai to keep it an optional peer dependency.
    // Assigning the module specifier to a typed variable via 'string' makes TS
    // treat it as Promise<any>, bypassing static module resolution at build time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;
    try {
      const moduleId: string = 'openai';
      mod = await import(moduleId);
    } catch {
      // issue #401: THROW, never exit. A `process.exit` here killed the process before any
      // catch could record why the drive failed — the run then read healthy for 24 hours.
      // The message is preserved exactly; the payload lets the chokepoint classify it as
      // `sdk_missing` rather than a shapeless `other`.
      const err = new Error('realm agent requires the openai package. Run: npm install openai');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).driveCall = { error_class: 'sdk_missing', attempts_sdk: 0, elapsed_ms: 0 };
      throw err;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new (mod.default as new (opts: Record<string, unknown>) => any)({
      apiKey: process.env['OPENAI_API_KEY'],
      // issue #401: realm's own bound (see the twin comment in anthropic-provider.ts).
      ...(clock?.declaredPerAttemptMs !== undefined ? { timeout: clock.declaredPerAttemptMs } : {}),
      maxRetries: MAX_RETRIES,
      fetch: makeCountingFetch(counters),
    });

    const rawCreate = (b: Rec, o: Rec): Promise<unknown> => client.chat.completions.create(b, o);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bounded = (body: Rec): Promise<any> =>
      clock !== undefined ? driveCreate(rawCreate, body, clock, counters) : rawCreate(body, {});

    // Fold system prompt into the user message — safe for all o1-series API revisions.
    const systemPrompt = buildSystemPrompt(inputSchema, agentProfileInstructions);
    const userContent = `${systemPrompt}\n\n${prompt}`;

    type Message = { role: 'user' | 'assistant'; content: string };
    const messages: Message[] = [{ role: 'user', content: userContent }];

    // issue #600 PR 1a: ONE entry per WIRE REQUEST, in wire order.
    const requests: UsageRecord[] = billed ?? [];
    const makeRequest = async (msgs: Message[]): Promise<string> => {
      const requestStart = new Date().toISOString();
      const response = await bounded({
        model: this.model,
        max_completion_tokens: resolveMaxCompletionTokens(this.model),
        messages: msgs,
      });
      requests.push(
        toUsageRecord(requests.length, requestStart, readOpenAiReasoningUsage(response)),
      );
      return (response.choices[0]?.message?.content as string | undefined) ?? '';
    };

    const content = await makeRequest(messages);
    const parsed = extractJsonObject(content);
    if (parsed !== null) return { output: parsed, usage: requests };
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
    if (retryParsed !== null) return { output: retryParsed, usage: requests };
    // issue #600 PR 1a (D9): two billed, completed requests preceded this throw.
    const err = new Error(
      sanitizeError(`OpenAI returned non-JSON content after retry: ${retry.slice(0, 200)}`),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).driveCall = { usage: requests };
    throw err;
  }

  async callStep(
    prompt: string,
    inputSchema?: Record<string, unknown>,
    agentProfileInstructions?: string,
    callOpts?: { llmClock?: LlmClock },
  ): Promise<Record<string, unknown>> {
    const billed: UsageRecord[] = [];
    try {
      const { output } = await this.callStepInternal(
        prompt,
        inputSchema,
        agentProfileInstructions,
        callOpts,
        billed,
      );
      return output;
    } catch (err) {
      attachBilledUsage(err, billed);
      throw err;
    }
  }

  /**
   * issue #600 PR 1a (D1a/D1b) — this provider previously had NO override at all, so it inherited
   * the base default, which routes through the PUBLIC `callStep` and returns `{ output }` — usage
   * was computed and dropped at that boundary for every step, structured_output-declared or not
   * (the o1 family never supports structured_output — #351 — so this override always takes the
   * bare shape). Now it calls its own private internal directly.
   */
  override async callStepWithMeta(
    prompt: string,
    inputSchema?: Record<string, unknown>,
    agentProfileInstructions?: string,
    opts?: { structuredOutputStrict?: boolean; llmClock?: LlmClock },
  ): Promise<CallStepWithMetaResult> {
    const billed: UsageRecord[] = [];
    try {
      return await this.callStepInternal(
        prompt,
        inputSchema,
        agentProfileInstructions,
        { ...(opts?.llmClock !== undefined ? { llmClock: opts.llmClock } : {}) },
        billed,
      );
    } catch (err) {
      attachBilledUsage(err, billed);
      throw err;
    }
  }
}
