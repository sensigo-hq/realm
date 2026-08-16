// llm-provider.ts — LLM provider interface and factory function for realm agent.
import type { StructuredOutputMeta } from '@sensigo/realm';
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
  /**
   * Whether this provider READS `ToolDefinition.strict` and places per-tool strict on the wire
   * (issue #311's per-tool grammar-constrained tool arguments).
   *
   * Additive-optional and CONSERVATIVE BY DEFAULT: absent reads as false, so the base
   * `capabilities()` below, every existing override, and every third-party `--provider-module`
   * provider are all correctly reported as non-consumers without touching them. Only a provider
   * that actually threads the marker onto its request may declare `true`.
   *
   * This is load-bearing for evidence honesty, not just dispatch: `tool_args.strict_sent` claims
   * realm placed strict on the request handed to the SDK, so run-agent must not mark tools (or
   * record them as sent) for a provider whose wire builder ignores the marker entirely.
   */
  toolArgsStrict?: boolean;
  /**
   * Issue #313: which provider this instance IS. In-repo providers declare it; third-party
   * `--provider-module` providers omit it (agent.ts supplies a `module:<basename>` identity for
   * those through `AgentDeps` instead).
   *
   * Two consumers: run-agent selects the eligibility RULE PROFILE from it (`'openai'` ⇒ the
   * OpenAI profile, everything else ⇒ Anthropic), and it is minted into evidence as the
   * attempt's provider provenance.
   */
  providerId?: 'anthropic' | 'openai' | 'openai-reasoning';
  /**
   * Issue #313: an ENDPOINT-scoped reason this provider instance must not be sent strict at all,
   * even for a schema that passes eligibility. Set by `OpenAIProvider` when it is pointed at an
   * OpenAI-compatible endpoint (`--base-url`) without the author's `--strict-base-url`
   * attestation: compat endpoints vary from full grammar enforcement (vLLM, llama.cpp) to
   * accepting the field and ignoring it, and no capability-discovery API exists to tell them
   * apart. Fail-safe default-off, author opt-in.
   *
   * Read by BOTH dimensions (step output and, from the follow-up PR, tool arguments), which is
   * why it is endpoint-scoped rather than named per-dimension.
   */
  strictGate?: 'compat_endpoint';
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

  /**
   * Issue #236 — the structured_output-aware entry point run-agent's callStep site calls for
   * every agent step. DEFAULT-IMPLEMENTED here (never abstract): every third-party
   * `--provider-module` that only implements `callStep` inherits a disclosed no-op BY
   * CONSTRUCTION — `{ output }`, no `meta` — WITHOUT needing to know this method exists (the
   * `instanceof` check at agent.ts is unaffected; a plugin author never has to override this).
   *
   * OVERRIDES (issue #313 — this paragraph replaces the #236 rail that once forbade an OpenAI
   * override; that rail is formally OVERTURNED on the record by the #313 design record, which is
   * the designed special-casing #236 deliberately deferred). `AnthropicProvider` and
   * `OpenAIProvider` both override this method today — each honours `opts.structuredOutputStrict`
   * through its OWN API's mechanism (Anthropic: a `strict` submit tool; OpenAI: Chat Completions
   * `response_format: json_schema`), which is exactly why a single shared implementation was never
   * possible. A provider that does NOT override still inherits the honest no-op above, and
   * run-agent's synthesis rule reports that as `provider_unsupported`.
   */
  async callStepWithMeta(
    prompt: string,
    inputSchema?: Record<string, unknown>,
    agentProfileInstructions?: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    opts?: { structuredOutputStrict?: boolean },
  ): Promise<{ output: Record<string, unknown>; meta?: StructuredOutputMeta }> {
    const output = await this.callStep(prompt, inputSchema, agentProfileInstructions);
    return { output };
  }

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
  /**
   * issue #217 provider contract: every executor invocation MUST produce an entry in
   * `toolCalls`, including failed/timed-out calls — the drive's schema-repair gate relies on
   * `toolCalls.length === 0 ⇒ executor never invoked`. A custom `--provider-module` that violates
   * this (e.g. swallows a failed call without recording it) is a trusted-injector residual — the
   * repair gate would then wrongly treat a tool-using attempt as tool-free and repair it (cross-
   * ref #224).
   */
  abstract callStepWithTools(
    prompt: string,
    tools: ToolDefinition[],
    executor: ToolExecutor,
    options: {
      /**
       * The EFFECTIVE-OUTPUT schema (`output_schema ?? input_schema`, resolved by the caller) —
       * a MISNOMER kept for backward compatibility: it feeds the SUBMIT TOOL and the SYSTEM
       * PROMPT only (never the in-conversation AJV correction below). Do NOT repoint this at the
       * raw `input_schema` — see `validationInputSchema`/`validationOutputSchema` below for the
       * two fields the correction loop actually consumes.
       */
      inputSchema?: Record<string, unknown>;
      /**
       * issue #224 (D2): the step's RAW `input_schema`, separate from the effective-output
       * `inputSchema` above. Consumed ONLY by the in-conversation `validateAgentSubmission`
       * correction loop — never feeds the submit tool or the system prompt. Additive-optional: a
       * `--provider-module` plugin that ignores this field simply doesn't in-conversation-correct
       * against it (backward-compatible).
       */
      validationInputSchema?: Record<string, unknown>;
      /**
       * issue #224 (D2): the step's RAW `output_schema`, separate from the effective-output
       * `inputSchema` above. Consumed ONLY by the in-conversation `validateAgentSubmission`
       * correction loop — never feeds the submit tool or the system prompt. Additive-optional,
       * same backward-compatibility posture as `validationInputSchema`.
       */
      validationOutputSchema?: Record<string, unknown>;
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
  /** Issue #313: the author's attestation that the `--base-url` endpoint genuinely enforces
   *  strict. Only meaningful together with `--base-url` on the OpenAI provider. */
  strictBaseUrlFlag?: boolean,
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
      // issue #313 (dead-config cell 4): this branch has always DROPPED --base-url silently —
      // the o1 provider takes neither it nor the strict attestation. Silently ignoring an
      // explicit flag is exactly the class the #291 F10 precedent says to warn about.
      if (baseUrlFlag !== undefined || strictBaseUrlFlag === true) {
        const dropped = [
          ...(baseUrlFlag !== undefined ? ['--base-url'] : []),
          ...(strictBaseUrlFlag === true ? ['--strict-base-url'] : []),
        ].join(' and ');
        console.error(
          `  ⚠ ${dropped} ${baseUrlFlag !== undefined && strictBaseUrlFlag === true ? 'are' : 'is'} ignored for the o1 model family — ` +
            `these models use a dedicated provider that always talks to the native OpenAI endpoint.`,
        );
      }
      const { OpenAIReasoningProvider } = await import('./openai-reasoning-provider.js');
      return new OpenAIReasoningProvider(modelFlag);
    }
    const { OpenAIProvider } = await import('./openai-provider.js');
    return new OpenAIProvider(modelFlag ?? 'gpt-4o', baseUrlFlag, strictBaseUrlFlag === true);
  } else {
    const { AnthropicProvider } = await import('./anthropic-provider.js');
    return new AnthropicProvider(modelFlag ?? 'claude-sonnet-4-5');
  }
}
