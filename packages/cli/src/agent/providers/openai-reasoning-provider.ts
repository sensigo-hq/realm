// openai-reasoning-provider.ts — OpenAI reasoning model provider (o1-series) for realm agent.
// Extends LlmProvider (not ToolCapableLlmProvider) — o1-series models do not support the tools parameter.
import { LlmProvider } from './llm-provider.js';
import { buildSystemPrompt } from './agent-utils.js';

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

  async callStep(
    prompt: string,
    inputSchema?: Record<string, unknown>,
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
    });

    // Fold system prompt into the user message — safe for all o1-series API revisions.
    const systemPrompt = buildSystemPrompt(inputSchema);
    const userContent = `${systemPrompt}\n\n${prompt}`;

    type Message = { role: 'user' | 'assistant'; content: string };
    const messages: Message[] = [{ role: 'user', content: userContent }];

    const makeRequest = async (msgs: Message[]): Promise<string> => {
      const response = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client.chat.completions.create as (opts: Record<string, unknown>) => Promise<any>)({
        model: this.model,
        max_completion_tokens: resolveMaxCompletionTokens(this.model),
        messages: msgs,
      });
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
}
