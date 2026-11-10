// llm-provider.ts — LLM provider interface and factory function for realm agent.
import { brandClass } from '@sensigo/realm';
import type {
  AutoPriceInput,
  CacheAuto,
  CacheAutoPrices,
  CacheChoice,
  CacheRequestSource,
  PromptCacheSetting,
  RequestEndpoint,
  StructuredOutputMeta,
  UsageRecord,
} from '@sensigo/realm';
import { REALM_CLI_BRAND } from '../../brand.js';
import type { ToolDefinition, ToolExecutor, StepWithToolsResult } from '../mcp/mcp-extensions.js';
import type { LlmClock } from './agent-utils.js';
import type { RequestAdapter } from './request-layout.js';
import type { CacheDiagnosticsSetting } from '../prompt-cache.js';

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
  /**
   * Issue #600 — what this provider instance asks its service to cache on each request it marks:
   * a single-shot request, and every main turn of a tool step: `'off'` (nothing), or
   * `{ lifetime_s }` (the cache lifetime asked for, in whole seconds — the lifetime unit: the one
   * choice the provider resolved, `auto` included). Caching 3-B: `'provider'` — the service caches
   * by its own rules, which Realm cannot set; Realm may send it a hint (OpenAI's cache key). Absent
   * means Realm asks this provider for nothing. The Anthropic provider declares `'off'` or a
   * lifetime; the OpenAI providers declare `'provider'`, except (#896) the `openai` provider on a
   * GPT-5.6-or-later model at OpenAI's own address ({@link openAiExplicitCacheModel}), which declares
   * `{ lifetime_s: 1800 }`, or `'off'` under `off`; a provider module may declare any of the three
   * (the start line says what it reads, and that `--prompt-cache` does not reach a module).
   */
  promptCache?: 'off' | 'provider' | { lifetime_s: number };
  /**
   * Caching 3-B (D1) — which kind of endpoint this instance sends to, resolved once from the SDK
   * client a request would go through (so `--base-url`, `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`
   * all count): `default` for the provider's own address, `custom` for any other. The built-in
   * providers declare it; a provider module may leave it out.
   */
  endpoint?: RequestEndpoint;
}

/**
 * Issue #600 PR 2 — the cache setting a runner hands the Anthropic provider: the value, where it came
 * from, which runner chose it (`realm agent`, `realm listen`) and — the lifetime unit — when the value
 * is `auto`, on what basis the provider chooses for a call that carries no choice of its own
 * (`no_measurement`).
 */
export interface PromptCacheRequest {
  value: PromptCacheSetting;
  source: CacheRequestSource;
  by: string;
  auto?: CacheAuto;
}

/**
 * Caching 3-M (D-1): one provider call's own cache choice, and what it was chosen on (the record's
 * `cache_auto`). Every request of the call sends and records by it.
 */
export interface CallCacheChoice {
  choice: CacheChoice;
  auto: CacheAuto;
}

/**
 * Caching 3-M (D-2) — a built-in provider's `auto` rule, for one agent step at a time: `choose` is the
 * provider's own rule over one step's gaps (`chooseAutoLifetime` or `chooseAutoOneLifetime`, with its
 * prior), callable any number of times and changing no state; `toolStep` is what a step with tools
 * asks for, absent where a tool step is not part of the provider's choice (OpenAI).
 */
export interface AutoStepRule {
  choose(
    gapsS: readonly number[],
    prices: AutoPriceInput,
  ): { choice: CacheChoice; prices?: CacheAutoPrices };
  toolStep?: CacheChoice;
}

/**
 * Issue #600 PR 2 (B4) — which kind of endpoint a request went to, from the SDK client it went
 * through: `custom` when the client's `baseURL` is a string other than the SDK's own default
 * address, `default` when it is that address, nothing when the client has no string `baseURL`. So
 * `--base-url`, `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` all count. The address is never kept.
 */
export function endpointOf(client: unknown, defaultBaseUrl: string): RequestEndpoint | undefined {
  if (typeof client !== 'object' || client === null) return undefined;
  const base = (client as { baseURL?: unknown }).baseURL;
  if (typeof base !== 'string') return undefined;
  return base === defaultBaseUrl ? 'default' : 'custom';
}

/** Issue #600 PR 2 — the model a response named, when it named one as a string. */
export function responseModel(response: unknown): string | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const model = (response as { model?: unknown }).model;
  return typeof model === 'string' ? model : undefined;
}

/**
 * Abstract base class for LLM providers used by realm agent.
 * Extend this class to implement a custom provider.
 */
/**
 * issue #600 PR 1a — what `callStepWithMeta` returns. `usage` is a SIBLING of `meta`, never nested
 * inside it: a provider that reports usage without structured-output meta is expressible, and the
 * no-plan arm can destructure `{ output, usage }` without ever reading `meta`.
 *
 * The base default implementation below returns `{ output }` only, so a third-party
 * `--provider-module` inherits `usage: undefined` BY CONSTRUCTION — a type-level fact, not a
 * runtime check.
 */
export interface CallStepWithMetaResult {
  output: Record<string, unknown>;
  meta?: StructuredOutputMeta;
  /** One entry per WIRE REQUEST this step made, in wire order. Absent ⇒ nothing was observed. */
  usage?: UsageRecord[];
}

export abstract class LlmProvider {
  /** Call the LLM with a step prompt and return a JSON object. */
  abstract callStep(
    prompt: string,
    inputSchema?: Record<string, unknown>,
    agentProfileInstructions?: string,
    /**
     * Issue #401 — the per-create clock for this step. Optional, and an implementation with
     * fewer parameters stays assignable, so a `--provider-module` provider that ignores it keeps
     * working: it gets the drive-failure RECORD without getting the bound.
     */
    opts?: { llmClock?: LlmClock },
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
    opts?: {
      structuredOutputStrict?: boolean;
      llmClock?: LlmClock;
      /**
       * Caching 3-B (C2): where the stable start of `prompt` ends, in its UTF-16 code units — the
       * part that repeats between runs, which a provider may cache (Anthropic marks it as its own
       * block; OpenAI derives its cache key from it). `prompt` is always sent whole: a provider that
       * ignores this option sends what it always sent. Absent when Realm found no split.
       */
      cachePrefixChars?: number;
      /**
       * Caching 3-M (D-1): this call's own cache choice. A provider that ignores it sends what it
       * always sent. Absent: the provider's own choice, as ever.
       */
      cacheChoice?: CallCacheChoice;
    },
  ): Promise<CallStepWithMetaResult> {
    // issue #401: the clock is PASSED THROUGH here. This base delegation is the route every
    // provider that does NOT override this method takes for a step declaring `structured_output:
    // strict` — both in-repo providers override it, so in practice this serves third-party ones.
    // Dropping the clock here would leave that whole class of drives unbounded, silently.
    const output = await this.callStep(prompt, inputSchema, agentProfileInstructions, {
      ...(opts?.llmClock !== undefined ? { llmClock: opts.llmClock } : {}),
    });
    return { output };
  }

  /** Returns the capability set for this provider instance. */
  capabilities(): ProviderCapabilities {
    return { jsonMode: false };
  }

  /**
   * Issue #676 — optional, and public (`LlmProvider` is published as `@sensigo/realm-cli/agent`).
   * Given an error this provider's own call threw, returns ONE plain sentence explaining it when
   * the provider recognises it (for example: Anthropic answering that it has no model by the name
   * given), and `undefined` otherwise. `realm agent` prints the sentence on its own line under the
   * step's failure line; the error itself, and what the run records about it, stay unchanged.
   *
   * Recognise the error from its own fields, never by `instanceof` (an SDK may be loaded more
   * than once) and never by a pattern over the whole message. It must not throw: realm calls it
   * through a guard and ignores a throw, a non-string, an empty string or one of only spaces.
   */
  explainFailure?(err: unknown): string | undefined;
}

brandClass(LlmProvider, Symbol.for('@sensigo/realm-cli/LlmProvider'), REALM_CLI_BRAND);

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
      /** Issue #401 — the per-create clock for this step's model requests. */
      llmClock?: LlmClock;
      /**
       * Caching 3-B (C2): as `callStepWithMeta`'s. On a tool step it is used only to derive
       * OpenAI's cache key; Anthropic's tool loop keeps #899's marking and does not split.
       */
      cachePrefixChars?: number;
      /** Caching 3-M (D-1): as `callStepWithMeta`'s; OpenAI's tool path does not read it. */
      cacheChoice?: CallCacheChoice;
    },
  ): Promise<StepWithToolsResult>;
}

brandClass(
  ToolCapableLlmProvider,
  Symbol.for('@sensigo/realm-cli/ToolCapableLlmProvider'),
  REALM_CLI_BRAND,
);

/**
 * Returns true if the provider supports the agentic tool-calling loop.
 */
export function isToolCapable(provider: LlmProvider): provider is ToolCapableLlmProvider {
  return provider instanceof ToolCapableLlmProvider;
}

export type ProviderName = 'openai' | 'anthropic';

/** Where Anthropic lists its current models (issue #676; answered 200 on 2026-10-04). */
export const ANTHROPIC_MODELS_URL = 'https://platform.claude.com/docs/en/models/overview';
/** Where OpenAI lists its models (issue #676; answered 200 on 2026-10-04). */
export const OPENAI_MODELS_URL = 'https://developers.openai.com/api/docs/models';

/**
 * Issue #676: whether a flag or an API key was really given — a value with something other than
 * whitespace in it. The ONE rule for both keys and `--model`: an empty key used to count as set
 * (`!== undefined`), so a message saying a key "is set" could be false, and `--model
 * "$REALM_MODEL"` with the variable unset sent `"model":""` to the provider.
 */
export function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/** The two API keys realm's built-in providers read, as found in the environment. */
export interface ProviderKeys {
  OPENAI_API_KEY: string | undefined;
  ANTHROPIC_API_KEY: string | undefined;
}

/**
 * Issue #676: the one place realm reads the two API keys for choosing a provider. `realm agent`
 * reads them through this (its command file reads no environment variable), and so does
 * `resolveProvider`.
 */
export function readProviderKeys(): ProviderKeys {
  return {
    OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
    ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
  };
}

/** The flags `checkProviderFlags` judges, and the two keys (from `readProviderKeys()`). */
export interface ProviderFlags {
  provider: ProviderName | undefined;
  model: string | undefined;
  baseUrl: string | undefined;
  env: ProviderKeys;
}

/** `checkProviderFlags`' answer: the provider and model to build, or the refusal's message. */
export type ProviderFlagsCheck =
  { ok: true; provider: ProviderName; model: string } | { ok: false; message: string };

const NO_DEFAULT_MODEL = '--model is required: realm has no default model.';

/**
 * Issue #600 caching PR 5 — which built-in request shape a provider and model take: the o1 rule in
 * one place. o1, o1-mini and o1-preview take the reasoning shape (no tool support, the system prompt
 * folded into the user message); o3, o3-mini and o4-mini support the standard Chat Completions API
 * including function calling, so they take OpenAI's. `resolveProvider` builds the provider it names;
 * `realm workflow validate` describes that provider's request.
 */
export function chooseAdapter(provider: ProviderName, model: string): RequestAdapter {
  if (provider === 'anthropic') return 'anthropic';
  return /^o1(-|$)/i.test(model) ? 'openai-reasoning' : 'openai';
}

/**
 * Issue #676 — checks the model flags of a built-in provider and chooses the provider, before
 * anything is created. Pure: it reads only its argument. The ONE place these refusal sentences
 * are written; `realm agent` adds the closing sentence that says what happened to the run, and
 * `resolveProvider` throws the bare message.
 *
 * Realm has no default model. The owner's reason: "we should not have a default model in realm
 * because models change frequently." A default written into a release keeps pointing at a model
 * after the provider retires it.
 *
 * Order: no key at all (naming the named provider's key when `--provider` was given) → the
 * provider (named, or chosen from the keys: OpenAI when both are set) → the named provider's own
 * key → `--base-url` with Anthropic → the model.
 */
export function checkProviderFlags(flags: ProviderFlags): ProviderFlagsCheck {
  const hasOpenAI = hasText(flags.env.OPENAI_API_KEY);
  const hasAnthropic = hasText(flags.env.ANTHROPIC_API_KEY);

  if (!hasOpenAI && !hasAnthropic) {
    // A named provider needs its own key; telling that operator "OPENAI_API_KEY or
    // ANTHROPIC_API_KEY" would send half of them to the next refusal.
    if (flags.provider !== undefined) {
      const key = flags.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
      return {
        ok: false,
        // eslint-disable-next-line no-restricted-syntax -- prose naming the program, not a command to copy (#729 PR-3, L-2).
        message: `realm agent requires an LLM API key: --provider ${flags.provider} was given, and ${key} is not set or is empty. Set ${key}.`,
      };
    }
    return {
      ok: false,
      message: 'realm agent requires an LLM API key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.',
    };
  }

  const provider: ProviderName = flags.provider ?? (hasOpenAI ? 'openai' : 'anthropic');

  // A provider chosen from the keys always has its key; only a named one can lack it. The other
  // key is set, or the check above would have refused.
  if (provider === 'anthropic' && !hasAnthropic) {
    return {
      ok: false,
      message:
        '--provider anthropic was given, but ANTHROPIC_API_KEY is not set or is empty (only OPENAI_API_KEY is set). ' +
        'Set ANTHROPIC_API_KEY, or use --provider openai with an OpenAI model.',
    };
  }
  if (provider === 'openai' && !hasOpenAI) {
    return {
      ok: false,
      message:
        '--provider openai was given, but OPENAI_API_KEY is not set or is empty (only ANTHROPIC_API_KEY is set). ' +
        'Set OPENAI_API_KEY, or use --provider anthropic with an Anthropic model.',
    };
  }

  if (flags.baseUrl !== undefined && provider === 'anthropic') {
    return {
      ok: false,
      message:
        '--base-url is only supported with --provider openai (or OpenAI-compatible endpoints). ' +
        'For Anthropic, configure the endpoint via the ANTHROPIC_BASE_URL environment variable.',
    };
  }

  const model = flags.model;
  if (!hasText(model)) {
    return { ok: false, message: missingModelMessage(flags, provider, hasOpenAI, hasAnthropic) };
  }

  return { ok: true, provider, model };
}

/** The `--model is required` sentence for the case at hand; see `checkProviderFlags`. */
function missingModelMessage(
  flags: ProviderFlags,
  provider: ProviderName,
  hasOpenAI: boolean,
  hasAnthropic: boolean,
): string {
  if (flags.baseUrl !== undefined) {
    return `${NO_DEFAULT_MODEL} Name the model the service at --base-url offers.`;
  }
  if (flags.provider === 'anthropic') {
    return `${NO_DEFAULT_MODEL} Name an Anthropic model; Anthropic lists them at ${ANTHROPIC_MODELS_URL}.`;
  }
  if (flags.provider === 'openai') {
    return `${NO_DEFAULT_MODEL} Name an OpenAI model; OpenAI lists them at ${OPENAI_MODELS_URL}.`;
  }
  if (hasOpenAI && hasAnthropic) {
    return (
      `${NO_DEFAULT_MODEL} Both OPENAI_API_KEY and ANTHROPIC_API_KEY are set, so the provider is OpenAI; ` +
      `name one of its models (OpenAI lists them at ${OPENAI_MODELS_URL}), or choose Anthropic with --provider anthropic.`
    );
  }
  if (provider === 'anthropic') {
    return (
      `${NO_DEFAULT_MODEL} ANTHROPIC_API_KEY is set, so the provider is Anthropic; ` +
      `name one of its models (Anthropic lists them at ${ANTHROPIC_MODELS_URL}).`
    );
  }
  return (
    `${NO_DEFAULT_MODEL} OPENAI_API_KEY is set, so the provider is OpenAI; ` +
    `name one of its models (OpenAI lists them at ${OPENAI_MODELS_URL}).`
  );
}

/**
 * Issue #676 — the whole line `realm listen` prints, `Error: ` included, when it was started
 * without `--model`. Listen passes the model to every `realm agent` it starts, and each of those
 * refuses without one. It checks no API key: each child runs in the workflow's folder and adds
 * that folder's `.env` to its environment only for keys listen's own environment does not set,
 * unless `DOTENV_CONFIG_OVERRIDE` reaches it (with `DOTENV_CONFIG_PATH` set to a full path, that
 * file instead; #748).
 */
export function listenModelRefusal(provider: ProviderName | undefined): string {
  const lead =
    '--model is required: realm has no default model, and realm listen starts realm agent';
  if (provider === 'anthropic') {
    return (
      `Error: ${lead} --provider anthropic for every run. ` +
      `Name an Anthropic model; Anthropic lists them at ${ANTHROPIC_MODELS_URL}. Nothing was started.`
    );
  }
  if (provider === 'openai') {
    return (
      `Error: ${lead} --provider openai for every run. ` +
      `Name an OpenAI model; OpenAI lists them at ${OPENAI_MODELS_URL}. Nothing was started.`
    );
  }
  return (
    `Error: ${lead} for every run. ` +
    'Each one picks its provider from the API key it finds (OpenAI when both are set; choose one with --provider). ' +
    `Anthropic lists its models at ${ANTHROPIC_MODELS_URL}; OpenAI at ${OPENAI_MODELS_URL}. Nothing was started.`
  );
}

/**
 * Caching 3-B (D1, B3; D4.6-8) — "the provider's own endpoint" as ONE value, resolved once: build
 * one client of the SDK with the same `apiKey` and `baseURL` options the per-call clients use and
 * read its resolved address (`endpointOf`). The SDK also reads `OPENAI_BASE_URL` /
 * `ANTHROPIC_BASE_URL`, so this is right where `--base-url` alone is not. A client without a string
 * `baseURL` is only built by a test double (the real SDK always resolves one): `undefined` reads as
 * `default`. When the SDK cannot be loaded, the flag decides (`--base-url` ⇒ `custom`) and the
 * per-call import reports the missing package as it always has (`sdk_missing`).
 */
async function resolvedEndpoint(
  moduleId: string,
  baseUrl: string | undefined,
  defaultBaseUrl: string,
): Promise<RequestEndpoint> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  try {
    mod = await import(moduleId);
  } catch {
    return baseUrl === undefined ? 'default' : 'custom';
  }
  const apiKey =
    moduleId === 'openai' ? process.env['OPENAI_API_KEY'] : process.env['ANTHROPIC_API_KEY'];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new (mod.default as new (opts: Record<string, unknown>) => any)({
      apiKey,
      ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
    });
    return endpointOf(client, defaultBaseUrl) ?? 'default';
  } catch {
    return baseUrl === undefined ? 'default' : 'custom';
  }
}

/**
 * #896 — whether OpenAI accepts its explicit cache controls (`prompt_cache_options`, a content
 * part's `prompt_cache_breakpoint`) from this model, by name, compared without regard to case:
 * `gpt-5.<minor ≥ 6>` and `gpt-<major ≥ 6>[.<minor>]`, each then the end or `-…` (GPT-5.6 and later:
 * OpenAI charges for writes and accepts the fields; gpt-5.5 refuses both with a 400, measured), and
 * `ft:<base>:…` judged by its base (LiteLLM's rule). Not `gpt-5`, `gpt-5.1`–`gpt-5.5`, `gpt-4o`,
 * `gpt-4.1`, `gpt-oss-…`, `chatgpt-…`, the o-series, nor `ft:` of those. Applied only by the `openai`
 * provider, only at OpenAI's own address.
 */
export function openAiExplicitCacheModel(model: string): boolean {
  const name = model.toLowerCase();
  const base = name.startsWith('ft:') ? (name.slice(3).split(':')[0] ?? '') : name;
  const m = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(base);
  if (m === null) return false;
  const major = Number(m[1]);
  return major >= 6 || (major === 5 && m[2] !== undefined && Number(m[2]) >= 6);
}

/**
 * Caching 3-B (MA 1's wording list, 2026-11-05) — the endpoint an OpenAI drive started with no
 * `--base-url` resolves, read the way {@link resolveProvider} reads it (so `OPENAI_BASE_URL` counts):
 * what each `realm agent` that `realm listen` starts will use. Nothing is sent.
 */
export async function resolveOpenAiEndpoint(): Promise<RequestEndpoint> {
  const { OPENAI_DEFAULT_BASE_URL } = await import('./openai-provider.js');
  return resolvedEndpoint('openai', undefined, OPENAI_DEFAULT_BASE_URL);
}

/**
 * Resolves the correct LLM provider from environment and CLI flags.
 *
 * Throws when no API key is set, when a named provider's own key is not set, when `--base-url` is
 * given for Anthropic, and when no model is given: realm has no default model (issue #676 — the
 * owner's reason: "we should not have a default model in realm because models change
 * frequently"). The checks and their messages are `checkProviderFlags`'; this throws its message.
 * Also throws when the provider's SDK package is not installed.
 *
 * Returns the provider and (caching 3-M D-2), under `auto`, `autoRule` for a provider that takes a
 * lifetime (Anthropic; OpenAI in the explicit set: GPT-5.6 and later at OpenAI's own address), so
 * `realm agent` can choose for each step. No provider's `auto` choice is ever pending (D-3).
 */
export async function resolveProvider(options: {
  provider: ProviderName | undefined;
  model: string | undefined;
  baseUrl?: string | undefined;
  /** Issue #313: the author's attestation that the `--base-url` endpoint genuinely enforces
   *  strict. Only meaningful together with `--base-url` on the OpenAI provider. */
  strictBaseUrl?: boolean | undefined;
  /** Issue #600 PR 2: the cache setting and its origin. Caching 3-B: every built-in provider takes
   *  it — Anthropic asks for a lifetime by it; the OpenAI providers decide by it whether to send the
   *  cache key. */
  promptCache: PromptCacheRequest;
  /** Caching 3-M (B2b): `--cache-diagnostics`, only when stated. Anthropic asks unless it is `off`;
   *  the provider itself gates the address and the call's choice. Other providers take no option. */
  cacheDiagnostics?: CacheDiagnosticsSetting | undefined;
}): Promise<{
  provider: LlmProvider;
  autoRule?: AutoStepRule;
}> {
  const providerFlag = options.provider;
  const modelFlag = options.model;
  const baseUrlFlag = options.baseUrl;
  const strictBaseUrlFlag = options.strictBaseUrl;
  const checked = checkProviderFlags({
    provider: providerFlag,
    model: modelFlag,
    baseUrl: baseUrlFlag,
    env: readProviderKeys(),
  });
  if (!checked.ok) throw new Error(checked.message);
  const { provider, model } = checked;

  if (provider === 'openai') {
    if (chooseAdapter(provider, model) === 'openai-reasoning') {
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
      const { OPENAI_DEFAULT_BASE_URL } = await import('./openai-provider.js');
      // The o1 provider never takes --base-url; its client still reads OPENAI_BASE_URL.
      const endpoint = await resolvedEndpoint('openai', undefined, OPENAI_DEFAULT_BASE_URL);
      return {
        provider: new OpenAIReasoningProvider(model, {
          endpoint,
          promptCache: options.promptCache,
        }),
      };
    }
    const { OpenAIProvider, OPENAI_DEFAULT_BASE_URL } = await import('./openai-provider.js');
    const endpoint = await resolvedEndpoint('openai', baseUrlFlag, OPENAI_DEFAULT_BASE_URL);
    const openai = new OpenAIProvider(model, baseUrlFlag, strictBaseUrlFlag === true, {
      endpoint,
      promptCache: options.promptCache,
    });
    const openaiRule = openai.autoStepRule();
    return { provider: openai, ...(openaiRule !== undefined ? { autoRule: openaiRule } : {}) };
  } else {
    const { AnthropicProvider, ANTHROPIC_DEFAULT_BASE_URL } =
      await import('./anthropic-provider.js');
    const endpoint = await resolvedEndpoint(
      '@anthropic-ai/sdk',
      undefined,
      ANTHROPIC_DEFAULT_BASE_URL,
    );
    const anthropic = new AnthropicProvider(model, {
      promptCache: options.promptCache,
      endpoint,
      cacheDiagnostics: options.cacheDiagnostics !== 'off',
    });
    const anthropicRule = anthropic.autoStepRule();
    return {
      provider: anthropic,
      ...(anthropicRule !== undefined ? { autoRule: anthropicRule } : {}),
    };
  }
}
