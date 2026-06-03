// llm-provider.ts — LLM provider interface and factory function for realm agent.
import type { ToolDefinition, ToolExecutor, StepWithToolsResult } from '../mcp/mcp-extensions.js';

/**
 * Describes the optional feature set that an LLM provider supports.
 * Custom providers can override {@link LlmProvider.capabilities} to declare
 * features beyond the universal baseline.
 */
export interface ProviderCapabilities {
  /**
   * Whether this provider sends `response_format: { type: 'json_object' }` in API requests.
   * When false, JSON compliance is enforced through system prompt instruction and retry only.
   * This is the universal baseline — all providers work without json_object mode.
   */
  jsonMode: boolean;
}

/**
 * Abstract base class for LLM providers used by realm agent.
 * Extend this class to implement a custom provider.
 */
export abstract class LlmProvider {
  /** Call the LLM with a step prompt and return a JSON object. */
  abstract callStep(
    prompt: string,
    inputSchema?: Record<string, unknown>,
    agentProfileInstructions?: string,
  ): Promise<Record<string, unknown>>;

  /** Returns the capability set for this provider instance. */
  capabilities(): ProviderCapabilities {
    return { jsonMode: false };
  }
}

/**
 * Extended abstract class for providers that support the agentic tool-calling loop.
 * Extend this class if your provider can drive tool-enabled workflow steps.
 */
export abstract class ToolCapableLlmProvider extends LlmProvider {
  abstract callStepWithTools(
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
  ): Promise<StepWithToolsResult>;
}

/**
 * Returns true if the provider supports the agentic tool-calling loop.
 */
export function isToolCapable(provider: LlmProvider): provider is ToolCapableLlmProvider {
  return provider instanceof ToolCapableLlmProvider;
}

export type ProviderName = 'openai' | 'anthropic';

/**
 * Resolves the correct LLM provider from environment and CLI flags.
 * Throws if no API key is found or the specified package is not installed.
 */
export async function resolveProvider(
  providerFlag: ProviderName | undefined,
  modelFlag: string | undefined,
  baseUrlFlag?: string,
): Promise<LlmProvider> {
  const hasOpenAI = process.env['OPENAI_API_KEY'] !== undefined;
  const hasAnthropic = process.env['ANTHROPIC_API_KEY'] !== undefined;

  if (!hasOpenAI && !hasAnthropic) {
    throw new Error(
      'realm agent requires an LLM API key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.',
    );
  }

  const provider = providerFlag ?? (hasOpenAI ? 'openai' : 'anthropic');

  if (baseUrlFlag !== undefined && provider === 'anthropic') {
    throw new Error(
      '--base-url is only supported with --provider openai (or OpenAI-compatible endpoints). ' +
        'For Anthropic, configure the endpoint via the ANTHROPIC_BASE_URL environment variable.',
    );
  }

  if (provider === 'openai') {
    // Match o1, o1-mini, o1-preview — the o1 generation requires the special-case
    // provider (no tool support, system prompt folded into user message).
    // o3, o3-mini, and o4-mini support the standard Chat Completions API including
    // function calling, so they route to OpenAIProvider.
    const REASONING_MODELS = /^o1(-|$)/i;
    if (modelFlag !== undefined && REASONING_MODELS.test(modelFlag)) {
      const { OpenAIReasoningProvider } = await import('./openai-reasoning-provider.js');
      return new OpenAIReasoningProvider(modelFlag);
    }
    const { OpenAIProvider } = await import('./openai-provider.js');
    return new OpenAIProvider(modelFlag ?? 'gpt-4o', baseUrlFlag);
  } else {
    const { AnthropicProvider } = await import('./anthropic-provider.js');
    return new AnthropicProvider(modelFlag ?? 'claude-sonnet-4-5');
  }
}
