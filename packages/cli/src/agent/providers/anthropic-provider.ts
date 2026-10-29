// anthropic-provider.ts — Anthropic LLM provider implementation for realm agent.
// Requires @anthropic-ai/sdk >= 0.20.0 as an optional peer dependency (npm install @anthropic-ai/sdk).
import {
  WorkflowError,
  validateAgentSubmission,
  chooseCacheLifetime,
  normalizeCacheAuto,
  type CacheAutoBasis,
  type CacheChoice,
  type CacheRequestSource,
  type CacheTiers,
  type JsonSchema,
  type PromptCacheSetting,
  type StructuredOutputMeta,
  type UsageRecord,
} from '@sensigo/realm';
import {
  ToolCapableLlmProvider,
  ANTHROPIC_MODELS_URL,
  endpointOf,
  responseModel,
  type ProviderCapabilities,
  type CallStepWithMetaResult,
} from './llm-provider.js';
import type {
  ToolCallRecord,
  ToolDefinition,
  ToolExecutor,
  StepWithToolsResult,
} from '../mcp/mcp-extensions.js';
import {
  classBError,
  sanitizeError,
  serializeToolResult,
  parseNamespacedId,
  extractJsonObject,
  rejectAfter,
  buildSystemPrompt,
  renderSubmissionProblems,
  extractHttpStatus,
  driveCreate,
  makeCountingFetch,
  MAX_RETRIES,
  type LlmClock,
  type WireCounters,
  attachBilledUsage,
  passedSnippet,
} from './agent-utils.js';
import { SUBMIT_TOOL_NAME, buildSubmitTool } from './request-layout.js';

/**
 * Returns the maximum output tokens for the given Anthropic model.
 * The Anthropic Messages API requires max_tokens — this must always produce a valid value.
 * Source: https://docs.anthropic.com/en/docs/about-claude/models/all-models
 *
 * Issue #309 fix (ratified per design-d4-final.md's ADDENDUM, the audit's 3.5-cap correction):
 * the PRE-#309 regex (`claude-(3[-.]5|[a-z]+-4)`) was stale in a dangerous direction — it gave
 * the claude-3.5 family's OWN hard output cap (8192; 16384 would 400 every call) to EVERY 4.x
 * model too (claude-sonnet-4-5, claude-opus-4-1, …), silently under-budgeting them. Three
 * buckets now, ordered most-specific-first:
 *   1. claude-3.5 family (`claude-3-5-*` / `claude-3.5-*`) ⇒ 8192 — its OWN hard cap.
 *   2. Bare legacy claude-3 generation (claude-3-opus/-sonnet/-haiku, NOT 3.5) ⇒ 4096 — original,
 *      unchanged fallback.
 *   3. Everything else — 3.7, every 4.x/5.x model, and any UNKNOWN future model id — ⇒ 16384.
 *      Fail-forward (the stale-classifier lesson, #312 is the durable fix: an unrecognized model
 *      id is treated as AT LEAST as capable as today's models, never less; 16384 is
 *      non-streaming-safe and current models think by default, so 4096 would starve
 *      thinking+output on anything not explicitly bucketed above).
 */
export function resolveMaxTokens(model: string): number {
  if (/claude-3[-.]5/i.test(model)) return 8192;
  if (/claude-3-(opus|sonnet|haiku)(-|$)/i.test(model)) return 4096;
  return 16384;
}

/**
 * The Anthropic SDK's own non-streaming coherence threshold. A single non-streaming request asking
 * for more output tokens than this can legitimately outrun a ten-minute budget, and the SDK would
 * rather you stream than have the request die on a timeout it cannot distinguish from a hang.
 */
export const MAX_NONSTREAMING_TOKENS = 21_333;

/**
 * Issue #600 PR 2 (B4) — the Anthropic SDK's own default address (`@anthropic-ai/sdk` 0.120.0,
 * `client.js:96`): a request through a client whose `baseURL` is anything else went to a custom
 * endpoint.
 */
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * Issue #600 (the lifetime unit) — Anthropic's cache prices and lifetimes, as multiples of its input
 * price, for `chooseCacheLifetime` (core holds no price and names no provider; the adapter declares
 * them). The lifetimes are Anthropic's two: 5 minutes (the default, sent without a `ttl`) and 1 hour
 * (sent with `ttl: '1h'`). The writes are Anthropic's published 1.25× and 2× of input (vendored doc
 * `plans/issue-558/axes/sources/framework-decisions/anthropic-prompt-caching.md:259-260`). Reads cost
 * 0.025× to 0.1× by model, and the choice barely moves across that range, so the highest is used —
 * the provider's rules, not a per-model table.
 */
export const ANTHROPIC_CACHE_TIERS: CacheTiers = {
  read: 0.1,
  short: { lifetime_s: 300, write: 1.25 },
  long: { lifetime_s: 3600, write: 2 },
};

/**
 * Issue #899 — the one `cache_control` shape a request's markers carry: `short` sends no `ttl` (the
 * provider's default lifetime, 5 minutes); `long` sends `ttl: '1h'`. Both markers of a request come
 * from here, so they cannot disagree.
 */
function cacheControlFor(choice: Exclude<CacheChoice, 'off'>): Record<string, string> {
  return choice === 'long' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

/**
 * Issue #600 PR 2 (B1) — a request's `system`: the plain string when nothing is asked
 * to be cached (byte-for-byte the request before caching), else one text block whose
 * `cache_control` marks the whole fixed part — the profile, Realm's instructions and the schema —
 * as the part to cache. `short` sends no `ttl` (the provider's default lifetime, 5 minutes); `long`
 * sends `ttl: '1h'` — byte-identical to the two bodies sent before the lifetime unit. The tool
 * loop's main turns call it too (issue #899); its final extraction does not.
 */
function systemWithCache(
  systemPrompt: string,
  choice: CacheChoice,
): string | Array<{ type: 'text'; text: string; cache_control: Record<string, string> }> {
  if (choice === 'off') return systemPrompt;
  return [{ type: 'text', text: systemPrompt, cache_control: cacheControlFor(choice) }];
}

/**
 * Issue #899 — a main turn's `messages` with a cache marker on the last block of the last message,
 * so the next turn can read the conversation so far. Built as a COPY at three levels: a new array, a
 * new last-message object, and new content — a string becomes one marked text block; an array
 * becomes a new array whose last block is a shallow copy carrying `cache_control` (on a
 * `tool_result` block the key sits on the block itself, never inside its `content`). Nothing in
 * `messages` is written: it is `history` itself, or a new array whose other elements ARE history's
 * objects, and a marker written in place would pile up turn after turn (Anthropic refuses a fifth).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function markLastMessage(messages: readonly any[], cacheControl: Record<string, string>): any[] {
  if (messages.length === 0) return [...messages];
  const last = messages[messages.length - 1];
  const content: unknown = last.content;
  const marked =
    typeof content === 'string'
      ? [{ type: 'text', text: content, cache_control: cacheControl }]
      : Array.isArray(content) && content.length > 0
        ? [
            ...content.slice(0, -1),
            { ...(content[content.length - 1] as object), cache_control: cacheControl },
          ]
        : content;
  return [...messages.slice(0, -1), { ...last, content: marked }];
}

/**
 * issue #401 — realm re-imposes the SDK's rule, because realm's own `timeout` DISABLES it.
 * The SDK runs that check only when `!stream && timeout == null` (messages.js:29-33): the moment
 * realm passes an explicit per-attempt timeout, the guard silently stops running. Re-imposing it
 * here keeps behaviour identical to the pre-#401 client instead of trading a loud refusal for a
 * confusing abort — so it fires ONLY when a clock was threaded (no clock ⇒ no realm timeout ⇒ the
 * SDK's own guard is still live and will raise this itself).
 *
 * STREAMING FORK: realm's Anthropic path never sets `stream: true` on any request, so in practice
 * this is unconditional. If a streaming path is ever added it must NOT call this — the rule is
 * about non-streaming requests only, and inheriting it would refuse a request that is perfectly
 * legal when streamed.
 *
 * Realm re-imposes the RATIO rule ONLY. The SDK additionally carries per-model
 * MODEL_NONSTREAMING_TOKENS caps; those are deliberately not duplicated — a per-model table
 * copied into a client goes stale on the next model release and starts refusing requests the
 * server would have served.
 */
export function assertMaxTokensCoherent(maxTokens: number, clock: LlmClock | undefined): void {
  if (clock === undefined) return;
  if (maxTokens > MAX_NONSTREAMING_TOKENS) {
    throw new Error(
      `max_tokens ${maxTokens} exceeds the non-streaming limit of ${MAX_NONSTREAMING_TOKENS} — ` +
        'a request this large must be streamed. Lower max_tokens for this model.',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// issue #236 — the fallback ladder. Any 400/503 on a request that carried `strict: true` drops
// strict, discloses, and retries ONCE; any other status propagates untouched (the arm keys on
// HTTP status ∧ strict-sent, NEVER on message text — design §4 [Rv5]).
// ---------------------------------------------------------------------------------------------

/** The captured grammar-compilation-unavailable text (premise-probe-raw.md's own canonical mock
 *  — the label match keys on THIS string only, never a broader "any 503" heuristic). A stale/
 *  non-matching message degrades to the generic `service_unavailable` label (fail-safe). */
const GRAMMAR_UNAVAILABLE_TEXT = 'Grammar compilation is temporarily unavailable';

// Issue #313: `extractHttpStatus` now lives in agent-utils.ts, shared with the OpenAI ladder —
// a pure move, zero behaviour change. `extractErrorMessage` deliberately stays local.

function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Thrown when the ladder's OWN drop-strict retry ALSO fails — design §4 [R2-7]: (a) carries the
 * `structuredOutput` meta so a catch site can still disclose the downgrade even though no result
 * was ever produced (run-agent's sticky map is armed from this on failure paths too), (b) sets
 * the ORIGINAL (retry) error as `cause`, (c) adopts that error's own message verbatim — run-agent
 * prints `err.message` directly at its two LLM-call catch sites, so this must describe what
 * ACTUALLY failed (the retry's real error), never a generic wrapper string.
 */
export class StructuredOutputLadderError extends Error {
  readonly structuredOutput: StructuredOutputMeta;
  constructor(
    message: string,
    structuredOutput: StructuredOutputMeta,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StructuredOutputLadderError';
    this.structuredOutput = structuredOutput;
  }
}

/** Per-`callStepInternal`-invocation ladder state — STICKY within the call: once a downgrade
 *  happens, every LATER `client.messages.create` in the SAME invocation (e.g. the non-JSON-retry
 *  leg) goes out without strict too, never re-attempting it. */
interface LadderState {
  strict: boolean;
  meta: StructuredOutputMeta | undefined;
}

/**
 * Wraps ONE `client.messages.create` call with the strict fallback ladder. `buildOpts(strict)`
 * must build the FULL request options for that boolean — called fresh on every attempt so a
 * downgrade takes effect immediately. Non-strict calls (state.strict already false, OR strict was
 * never requested for this invocation) pass straight through with no ladder engagement at all —
 * byte-identical to pre-#236 behavior.
 */
/**
 * Short alias so every `rawCreate` below fits on ONE line. The source rail for issue #401 greps
 * providers for `.create(` and requires `rawCreate =` on the SAME line; a call that prettier
 * wraps would make the rail stop matching — and a source-text guard that stops matching does not
 * fail, it stops guarding (the #189 purge-guard lesson).
 */
type Rec = Record<string, unknown>;

/**
 * issue #600 PR 1a — the response's usage block, typed LOCALLY. The Anthropic client is `any` on
 * this path (`client: any` below), so `.usage` is reachable but untyped; this narrows it without
 * loosening anything that is currently typed. Mirrors the SDK's own `Usage`
 * (`@anthropic-ai/sdk/resources/messages/messages.d.ts:2861`): both cache counters are
 * `number | null`, and `null` means NOTHING WAS OBSERVED — never a zero.
 */
export interface AnthropicUsage {
  /** The SDK's real `Usage.input_tokens` is `number` (never optional/nullable) — typed optional
   *  here only because this path is reached through an untyped `any` response. */
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  /** The per-TTL write split (`CacheCreation`, `:954-963`) — BOTH counters, not a discriminator. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
}

/**
 * issue #600 PR 1a — one wire request's usage, mapped onto the record's ENGINE fields. EVERY field
 * is omitted when the provider did not report it; a `null` counter (Anthropic's "nothing observed")
 * is an ABSENCE, never a `0`.
 *
 * Anthropic's `input_tokens` is "tokens after the last cache breakpoint that aren't cached" — it
 * maps onto `uncached_input_tokens`, NEVER onto `prompt_tokens` (D2). The provider's own docs state
 * the sum twice (vendored at
 * `plans/issue-558/axes/sources/framework-decisions/anthropic-prompt-caching.md:686` and `:3212`):
 * `total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens` — the
 * three terms are disjoint. `input_tokens` is a required `number` on the real response type
 * (`messages.d.ts:2881`); the cache counters are REQUIRED KEYS whose value may be `null`. A `null`
 * is an ABSENCE, not a zero: the total is WITHHELD rather than computed with a `0` substituted for
 * the missing term — a three-term sum with one term unknown has no value, only a guess. On a
 * conforming response that branch is unreachable, because an unused counter reports a measured `0`
 * (the FAQ's own worked example — `:3218`), so the withholding is there for a non-conforming
 * third-party shape.
 */
function toUsageRecord(
  index: number,
  requestStart: string,
  u: AnthropicUsage | undefined,
  // issue #600 PR 2 (B3): what realm asked for and where it sent the request; spread in as given.
  facts: Partial<UsageRecord> = {},
): UsageRecord {
  const num = (v: number | null | undefined): number | undefined =>
    typeof v === 'number' ? v : undefined;
  const creation = u?.cache_creation;
  const split = {
    ...(num(creation?.ephemeral_5m_input_tokens) !== undefined
      ? { ephemeral_5m_input_tokens: creation!.ephemeral_5m_input_tokens! }
      : {}),
    ...(num(creation?.ephemeral_1h_input_tokens) !== undefined
      ? { ephemeral_1h_input_tokens: creation!.ephemeral_1h_input_tokens! }
      : {}),
  };
  const uncachedInputTokens = num(u?.input_tokens);
  const cacheReadInputTokens = num(u?.cache_read_input_tokens);
  const cacheCreationInputTokens = num(u?.cache_creation_input_tokens);
  // prompt_tokens is the disjoint three-term sum the provider's own SDK documents ("Total input
  // tokens in a request is the summation of `input_tokens`, `cache_creation_input_tokens`, and
  // `cache_read_input_tokens`"). It is therefore computable ONLY when all three terms were
  // reported. Treating an unreported cache counter as a 0 contribution would make the TOTAL a
  // lower bound while every surface still labelled it `measured` — the record's own rule ("The
  // token counters and `cache_creation` are what THE PROVIDER REPORTED: an absent one was not
  // reported, and none is ever defaulted to `0`") applied at the stored field and broken at the
  // number derived from it. An explicit 0 IS a report, so
  // this only withholds the total when a counter is genuinely missing; `uncached_input_tokens`
  // below is still recorded, so nothing the provider did report is lost.
  const promptTokens =
    uncachedInputTokens !== undefined &&
    cacheReadInputTokens !== undefined &&
    cacheCreationInputTokens !== undefined
      ? uncachedInputTokens + cacheReadInputTokens + cacheCreationInputTokens
      : undefined;
  return {
    request_index: index,
    request_start: requestStart,
    ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
    ...(uncachedInputTokens !== undefined ? { uncached_input_tokens: uncachedInputTokens } : {}),
    ...(num(u?.output_tokens) !== undefined ? { output_tokens: u!.output_tokens! } : {}),
    ...(cacheCreationInputTokens !== undefined
      ? { cache_creation_input_tokens: cacheCreationInputTokens }
      : {}),
    ...(cacheReadInputTokens !== undefined
      ? { cache_read_input_tokens: cacheReadInputTokens }
      : {}),
    ...(Object.keys(split).length > 0 ? { cache_creation: split } : {}),
    ...facts,
  };
}

/** Reads the usage block off a response of unknown shape. Absent stays absent. */
export function readAnthropicUsage(response: unknown): AnthropicUsage | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const u = (response as { usage?: unknown }).usage;
  if (typeof u !== 'object' || u === null) return undefined;
  return u as AnthropicUsage;
}

async function createMessageWithLadder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  buildOpts: (strict: boolean) => Record<string, unknown>,
  state: LadderState,
  // issue #401: the per-create ceiling and the wire counters. Absent for a caller that has no
  // clock (a bare unit test) — driveCreate is then bypassed and behaviour is as before.
  clock?: LlmClock,
  counters?: WireCounters,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  // ONE signature fits every create site: the body, plus the per-create options driveCreate adds.
  const rawCreate = (b: Rec, o: Rec): Promise<unknown> => client.messages.create(b, o);
  const bounded = (body: Rec): Promise<unknown> =>
    clock !== undefined && counters !== undefined
      ? driveCreate(rawCreate, body, clock, counters)
      : rawCreate(body, {});

  if (!state.strict) {
    return bounded(buildOpts(false));
  }
  try {
    const response = await bounded(buildOpts(true));
    state.meta = { requested: true, sent: true };
    return response;
  } catch (err) {
    const status = extractHttpStatus(err);
    if (status !== 400 && status !== 503) throw err; // unrelated failure — never engage the ladder
    const api_message = extractErrorMessage(err);
    const downgrade_reason: NonNullable<StructuredOutputMeta['downgrade_reason']> =
      status === 400
        ? 'api_rejected_schema'
        : api_message.includes(GRAMMAR_UNAVAILABLE_TEXT)
          ? 'grammar_unavailable'
          : 'service_unavailable';
    state.strict = false; // sticky for the rest of THIS invocation
    try {
      const response = await bounded(buildOpts(false));
      state.meta = { requested: true, sent: false, downgrade_reason, api_message };
      return response;
    } catch (retryErr) {
      throw new StructuredOutputLadderError(
        extractErrorMessage(retryErr),
        { requested: true, sent: false, downgrade_reason, api_message },
        { cause: retryErr },
      );
    }
  }
}

/**
 * Anthropic LLM provider for realm agent.
 * Uses the Messages API and extracts JSON from the first text content block.
 * Retries once if the model returns non-JSON content.
 */
export class AnthropicProvider extends ToolCapableLlmProvider {
  /** Issue #600 PR 2 — what this instance asks to cache, and where that came from. */
  private readonly promptCache: {
    value: PromptCacheSetting;
    source?: CacheRequestSource;
    by?: string;
    auto?: { basis: CacheAutoBasis; gaps_s?: number[] };
  };
  /** Issue #600 (the lifetime unit) — the ONE choice this instance asks for, resolved at build. */
  private readonly cacheChoice: CacheChoice;

  /**
   * `promptCache` (issue #600): what it asks to cache on each request it marks: a single-shot
   * request, and every main turn of a tool step. Without it the provider asks for nothing (`off`) —
   * the request is byte-for-byte the one before caching. `off`, `short`
   * and `long` ask for that; `auto` asks for what `chooseCacheLifetime` chooses from `auto.gaps_s`
   * and {@link ANTHROPIC_CACHE_TIERS}, with the short lifetime as the prior for a drive with no
   * measurement and the long one for a drive `realm listen` started.
   */
  constructor(
    private readonly model: string,
    opts?: {
      promptCache?: {
        value: PromptCacheSetting;
        source?: CacheRequestSource;
        by?: string;
        auto?: { basis: CacheAutoBasis; gaps_s?: number[] };
      };
    },
  ) {
    super();
    this.promptCache = opts?.promptCache ?? { value: 'off' };
    const { value, auto } = this.promptCache;
    this.cacheChoice =
      value === 'auto'
        ? chooseCacheLifetime(
            auto?.gaps_s,
            ANTHROPIC_CACHE_TIERS,
            auto === undefined || auto.basis === 'no_measurement' ? 'short' : 'long',
          )
        : value;
  }

  /**
   * Issue #311 (capability guard). AnthropicProvider is the ONLY provider that reads
   * `ToolDefinition.strict` and threads it onto the request (see the `anthropicTools.push` in
   * `callStepWithTools`). Declaring `toolArgsStrict` here is what authorizes run-agent to mark
   * tools and to record `strict_sent: true` in evidence — a provider whose wire builder ignores
   * the marker must never produce that claim.
   *
   * `jsonMode` keeps the base value: this provider constrains output via the submit TOOL, never
   * via a `response_format` json_object mode.
   */
  capabilities(): ProviderCapabilities {
    // issue #600 PR 2 (B2): what it asks to cache on each request it marks: a single-shot request,
    // and every main turn of a tool step; always — `off` included;
    // the lifetime unit: the one resolved choice, as `'off'` or its lifetime in seconds.
    return {
      jsonMode: false,
      toolArgsStrict: true,
      providerId: 'anthropic',
      promptCache:
        this.cacheChoice === 'off'
          ? 'off'
          : { lifetime_s: ANTHROPIC_CACHE_TIERS[this.cacheChoice].lifetime_s },
    };
  }

  /**
   * Issue #600 PR 2 (B3) — what realm asked for on each request it marks: a single-shot request,
   * and every main turn of a tool step; and where it sent it:
   * the response's `model`, the ask (`lifetime` with its seconds and whether the lifetime was sent,
   * or `off`), its source and runner when given, the endpoint, and that Anthropic reports a
   * lifetime split. Never `provider`: `realm agent` stamps that. The lifetime unit: when the setting
   * is `auto`, also `cache_auto` — the basis of the choice and the gaps it read (`no_measurement`
   * when none was given) — whatever it chose, `off` included.
   */
  private requestFacts(response: unknown, client: unknown): Partial<UsageRecord> {
    const { value, source, by, auto } = this.promptCache;
    const choice = this.cacheChoice;
    const model = responseModel(response);
    const endpoint = endpointOf(client, ANTHROPIC_DEFAULT_BASE_URL);
    const cacheAuto =
      value === 'auto' ? normalizeCacheAuto(auto ?? { basis: 'no_measurement' }) : undefined;
    return {
      ...(model !== undefined ? { model } : {}),
      ...(choice === 'off'
        ? { cache_requested: 'off' as const }
        : {
            cache_requested: 'lifetime' as const,
            cache_lifetime_s: ANTHROPIC_CACHE_TIERS[choice].lifetime_s,
            cache_ttl_sent: choice === 'long',
          }),
      ...(source !== undefined ? { cache_requested_source: source } : {}),
      ...(by !== undefined ? { cache_requested_by: by } : {}),
      ...(cacheAuto !== undefined ? { cache_auto: cacheAuto } : {}),
      ...(endpoint !== undefined ? { endpoint } : {}),
      cache_split_offered: true,
    };
  }

  /**
   * Issue #610 — what the tool loop's FINAL EXTRACTION records about itself: the response's
   * `model`, the endpoint, and that Anthropic reports a lifetime split. No cache ask: that request
   * carries no cache marker (issue #899), so any ask written here would be false. The main turns
   * record {@link requestFacts}. Never `provider`: `realm agent` stamps that.
   */
  private toolsRequestFacts(response: unknown, client: unknown): Partial<UsageRecord> {
    const model = responseModel(response);
    const endpoint = endpointOf(client, ANTHROPIC_DEFAULT_BASE_URL);
    return {
      ...(model !== undefined ? { model } : {}),
      ...(endpoint !== undefined ? { endpoint } : {}),
      cache_split_offered: true,
    };
  }

  /**
   * Issue #676 — one sentence for the one error this provider explains: Anthropic answering that
   * it has no model by the name this provider was built with. The body says only `model: <id>`,
   * captured on 2026-10-04:
   *   404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-5"},…}
   * Read from the error's own fields (`status`, and `error` = the parsed body) — never
   * `instanceof` (the SDK may be loaded more than once) and never a pattern over the whole
   * message. The model is compared for EQUALITY: a prefix test would let a provider for
   * `claude-sonnet-4-5` claim a message naming `claude-sonnet-4-5-20250929`. Any other error, and
   * any read that throws, gives `undefined`.
   */
  override explainFailure(err: unknown): string | undefined {
    try {
      if (err === null || typeof err !== 'object') return undefined;
      const e = err as { status?: unknown; error?: unknown };
      if (e.status !== 404) return undefined;
      const body = e.error;
      if (body === null || typeof body !== 'object') return undefined;
      const inner = (body as { error?: unknown }).error as
        { type?: unknown; message?: unknown } | null | undefined;
      if (inner === null || typeof inner !== 'object') return undefined;
      if (inner.type !== 'not_found_error') return undefined;
      if (inner.message !== 'model: ' + this.model) return undefined;
      return (
        `Anthropic offers no model named ${this.model} to this API key. Check the name given to --model; ` +
        `current models are listed at ${ANTHROPIC_MODELS_URL} and retired ones at ` +
        'https://platform.claude.com/docs/en/about-claude/model-deprecations.'
      );
    } catch {
      return undefined;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(clock: LlmClock | undefined, counters: WireCounters): Promise<any> {
    // Dynamically import @anthropic-ai/sdk to keep it an optional peer dependency.
    // See openai-provider.ts for an explanation of the 'string' cast technique.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;
    try {
      const moduleId: string = '@anthropic-ai/sdk';
      mod = await import(moduleId);
    } catch {
      // issue #401: THROW, never exit. A `process.exit` here killed the process before any
      // catch could record why the drive failed — the run then read healthy for 24 hours.
      // The message is preserved exactly; the payload lets the chokepoint classify it as
      // `sdk_missing` rather than a shapeless `other`.
      const err = new Error(
        'realm agent requires the @anthropic-ai/sdk package. Run: npm install @anthropic-ai/sdk',
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).driveCall = { error_class: 'sdk_missing', attempts_sdk: 0, elapsed_ms: 0 };
      throw err;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (mod.default as new (opts: Record<string, unknown>) => any)({
      apiKey: process.env['ANTHROPIC_API_KEY'],
      // issue #401: realm's own bound on every model request. `timeout` is the PER-ATTEMPT
      // ceiling the SDK enforces; `maxRetries` is stated explicitly because the ceiling formula
      // in deriveLlmClock multiplies by it (A4-5) — realm's arithmetic must not be hostage to an
      // SDK default that could change. `fetch` counts the wire attempts and observes the
      // rate-limit headers so a fired bound can say WHY (never honored — R-4).
      ...(clock?.declaredPerAttemptMs !== undefined ? { timeout: clock.declaredPerAttemptMs } : {}),
      maxRetries: MAX_RETRIES,
      fetch: makeCountingFetch(counters),
    });
  }

  /**
   * Shared body for `callStep`/`callStepWithMeta` (issue #236). `strictRequested` is `undefined`
   * for `callStep`'s own byte-identical-behavior contract (no ladder state is even constructed);
   * `true`/`false` for `callStepWithMeta`. Returns `meta` only when strict was ever requested for
   * THIS invocation — a step that never opted in gets no `structuredOutput` meta at all.
   */
  private async callStepInternal(
    prompt: string,
    inputSchema: Record<string, unknown> | undefined,
    agentProfileInstructions: string | undefined,
    strictRequested: boolean | undefined,
    clock?: LlmClock,
    // issue #600 PR 1a (D9): the accumulator is owned by the ENTRY POINT so one `catch` there sees
    // everything billed, whatever throws below. Defaulted, so any other caller still works.
    billed?: UsageRecord[],
  ): Promise<CallStepWithMetaResult> {
    // issue #401: counters are PER-INVOCATION, minted beside the client they count for. A
    // module-global would attribute one step's wire attempts to another's failure.
    const counters: WireCounters = { attempts: 0 };
    const client = await this.getClient(clock, counters);
    assertMaxTokensCoherent(resolveMaxTokens(this.model), clock);
    const state: LadderState = { strict: strictRequested === true, meta: undefined };

    // P0: offer a schema-typed __realm_submit__ tool at tool_choice:'auto' (never forced — see the
    // module-level SUBMIT_TOOL_NAME comment) when a schema is available; a tool_use.input arrives
    // pre-parsed, so this eliminates the fenced/prefaced-JSON parse-failure class by construction.
    // Without a schema there is nothing to type the tool with, so no tool is offered — falls straight
    // to the P1 extractor below. `hasSchema` — NOT `strict` — governs buildSystemPrompt: the O8
    // honesty mechanism depends on the original schema staying model-visible regardless of strict
    // (design §4, pinned by test — buildSystemPrompt is byte-invariant under strict).
    const hasSchema = inputSchema !== undefined;
    const systemPrompt = buildSystemPrompt(
      inputSchema,
      agentProfileInstructions,
      /* structuredToolOffered */ hasSchema,
    );

    interface CallResult {
      toolInput?: Record<string, unknown>;
      text: string;
      stopReason?: string;
      /** issue #600 PR 1a — what THIS wire request cost, as the provider reported it. */
      usage?: AnthropicUsage;
    }

    // issue #600 PR 1a: ONE entry per WIRE REQUEST, in wire order. The provider owns the loop, so
    // the provider accumulates — a single usage object for a step that bills 1-21 requests is a
    // false number by construction.
    const requests: UsageRecord[] = billed ?? [];
    const makeRequest = async (userContent: string): Promise<CallResult> => {
      const requestStart = new Date().toISOString();
      const buildOpts = (strict: boolean): Record<string, unknown> => {
        const submitTool = hasSchema
          ? buildSubmitTool(inputSchema!, strict ? { strict: true } : undefined)
          : undefined;
        const opts: Record<string, unknown> = {
          model: this.model,
          max_tokens: resolveMaxTokens(this.model),
          system: systemWithCache(systemPrompt, this.cacheChoice),
          messages: [{ role: 'user', content: userContent }],
        };
        if (submitTool !== undefined) {
          opts['tools'] = [submitTool];
          opts['tool_choice'] = { type: 'auto' };
        }
        return opts;
      };
      const response = await createMessageWithLadder(client, buildOpts, state, clock, counters);
      const blocks = response.content as Array<{
        type: string;
        text?: string;
        name?: string;
        input?: unknown;
      }>;
      const toolUse = blocks.find((b) => b.type === 'tool_use' && b.name === SUBMIT_TOOL_NAME);
      const textBlock = blocks.find((b) => b.type === 'text');
      const usage = readAnthropicUsage(response);
      requests.push(
        toUsageRecord(requests.length, requestStart, usage, this.requestFacts(response, client)),
      );
      return {
        ...(toolUse !== undefined ? { toolInput: toolUse.input as Record<string, unknown> } : {}),
        text: textBlock?.text ?? '',
        ...(typeof response.stop_reason === 'string' ? { stopReason: response.stop_reason } : {}),
        ...(usage !== undefined ? { usage } : {}),
      };
    };

    // If the model called the tool, its input is ALREADY a parsed object — no parse step, done.
    // Otherwise fall back to the robust extractor (P1) on the text answer.
    const extract = (result: CallResult): Record<string, unknown> | null =>
      result.toolInput ?? extractJsonObject(result.text);

    // issue #236: submission_channel — the standing dodge detector (design record R-B). Set on
    // whichever result actually produced the returned output.
    const withChannel = (
      output: Record<string, unknown>,
      viaTool: boolean,
    ): CallStepWithMetaResult => {
      // issue #600 PR 1a: `usage` rides beside `meta`, never inside it — a step that reports usage
      // and no structured-output meta is expressible.
      const usage = requests.length > 0 ? { usage: requests } : {};
      if (state.meta === undefined) return { output, ...usage };
      return {
        output,
        meta: { ...state.meta, submission_channel: viaTool ? 'tool' : 'text' },
        ...usage,
      };
    };

    const first = await makeRequest(prompt);
    const firstParsed = extract(first);
    if (firstParsed !== null) return withChannel(firstParsed, first.toolInput !== undefined);

    // Retry once with an explicit reminder to return JSON (preserves today's retry shape).
    const retryPrompt = `${prompt}\n\nYour previous response was not valid JSON. Respond with a JSON object only.`;
    const retry = await makeRequest(retryPrompt);
    const retryParsed = extract(retry);
    if (retryParsed !== null) return withChannel(retryParsed, retry.toolInput !== undefined);

    // issue #600 PR 1a (D9) — both throws below happen AFTER two billed, completed requests (the
    // first generation and this retry); attaching the accumulated `requests[]` here is the only
    // way that money is ever recorded — a drive that throws was, until this PR, indistinguishable
    // from a drive that spent nothing at all.
    // Guard: a response cut short by the token budget must never silently return a partial object —
    // give a clear, distinct error rather than the generic "non-JSON content" message.
    if (retry.stopReason === 'max_tokens') {
      const err = new WorkflowError(
        sanitizeError(
          'Anthropic response was truncated (max_tokens) before a usable JSON object was produced.',
        ),
        { code: 'ENGINE_STEP_FAILED', category: 'ENGINE', agentAction: 'stop', retryable: false },
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).driveCall = { usage: requests };
      throw err;
    }
    {
      const err = new WorkflowError(
        sanitizeError(
          `Anthropic returned non-JSON content after retry: ${passedSnippet(retry.text)}`,
        ),
        { code: 'ENGINE_STEP_FAILED', category: 'ENGINE', agentAction: 'stop', retryable: false },
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).driveCall = { usage: requests };
      throw err;
    }
  }

  async callStep(
    prompt: string,
    inputSchema?: Record<string, unknown>,
    agentProfileInstructions?: string,
    opts?: { llmClock?: LlmClock },
  ): Promise<Record<string, unknown>> {
    const billed: UsageRecord[] = [];
    try {
      const { output } = await this.callStepInternal(
        prompt,
        inputSchema,
        agentProfileInstructions,
        undefined,
        opts?.llmClock,
        billed,
      );
      return output;
    } catch (err) {
      attachBilledUsage(err, billed);
      throw err;
    }
  }

  /** issue #236 override — the only provider in this codebase that actually honors
   *  `opts.structuredOutputStrict`; the base class's default just wraps `callStep`. */
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
        opts?.structuredOutputStrict === true,
        opts?.llmClock,
        billed,
      );
    } catch (err) {
      attachBilledUsage(err, billed);
      throw err;
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
      validationInputSchema?: Record<string, unknown>;
      validationOutputSchema?: Record<string, unknown>;
      maxToolCalls?: number;
      maxFanOut?: number;
      toolTimeoutMs?: number;
      agentProfileInstructions?: string;
      llmClock?: LlmClock;
    },
  ): Promise<StepWithToolsResult> {
    // issue #610: the accumulator is owned by the ENTRY POINT, as `callStep`'s is. One catch here
    // sees every request that got an answer, whatever throws below: a wire error on a later turn,
    // an unknown tool name, or a final answer that does not parse.
    const requests: UsageRecord[] = [];
    try {
      const result = await this.callStepWithToolsInternal(
        prompt,
        tools,
        executor,
        options,
        requests,
      );
      return requests.length > 0 ? { ...result, usage: requests } : result;
    } catch (err) {
      attachBilledUsage(err, requests);
      throw err;
    }
  }

  /** The tool loop. Issue #610 put it behind the entry point above, which owns `requests`. */
  private async callStepWithToolsInternal(
    prompt: string,
    tools: ToolDefinition[],
    executor: ToolExecutor,
    options: Parameters<AnthropicProvider['callStepWithTools']>[3],
    requests: UsageRecord[],
  ): Promise<StepWithToolsResult> {
    const clock = options.llmClock;
    // issue #401: per-invocation, minted beside the client below (never a module global).
    const counters: WireCounters = { attempts: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;
    try {
      const moduleId: string = '@anthropic-ai/sdk';
      mod = await import(moduleId);
    } catch {
      // issue #401: THROW, never exit. A `process.exit` here killed the process before any
      // catch could record why the drive failed — the run then read healthy for 24 hours.
      // The message is preserved exactly; the payload lets the chokepoint classify it as
      // `sdk_missing` rather than a shapeless `other`.
      const err = new Error(
        'realm agent requires the @anthropic-ai/sdk package. Run: npm install @anthropic-ai/sdk',
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).driveCall = { error_class: 'sdk_missing', attempts_sdk: 0, elapsed_ms: 0 };
      throw err;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new (mod.default as new (opts: Record<string, unknown>) => any)({
      apiKey: process.env['ANTHROPIC_API_KEY'],
      // issue #401: realm's own bound on every model request. `timeout` is the PER-ATTEMPT
      // ceiling the SDK enforces; `maxRetries` is stated explicitly because the ceiling formula
      // in deriveLlmClock multiplies by it (A4-5) — realm's arithmetic must not be hostage to an
      // SDK default that could change. `fetch` counts the wire attempts and observes the
      // rate-limit headers so a fired bound can say WHY (never honored — R-4).
      ...(clock?.declaredPerAttemptMs !== undefined ? { timeout: clock.declaredPerAttemptMs } : {}),
      maxRetries: MAX_RETRIES,
      fetch: makeCountingFetch(counters),
    });
    assertMaxTokensCoherent(resolveMaxTokens(this.model), clock);

    // ONE signature fits every create site on this path (issue #401): body + the per-create
    // options driveCreate adds (the abort signal). Bypassed when no clock was threaded — a
    // direct caller of this provider gets the record, never the bound (record R-14).
    const rawCreate = (b: Rec, o: Rec): Promise<unknown> => client.messages.create(b, o);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = (body: Rec): Promise<any> =>
      clock !== undefined ? driveCreate(rawCreate, body, clock, counters) : rawCreate(body, {});
    // issue #610: the ONE point every request of this loop goes through, and the one place it is
    // recorded. The record is pushed the instant the answer arrives, before any code reads it: a
    // throw while reading must not lose what was billed. A request that fails on the wire has no
    // record, as on the single-shot path. Issue #899: `facts` is what that request records about
    // itself — a main turn what it asked to cache, the final extraction no ask.
    const bounded = async (
      body: Rec,
      facts: (response: unknown, client: unknown) => Partial<UsageRecord>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<any> => {
      const requestStart = new Date().toISOString();
      const response = await send(body);
      requests.push(
        toUsageRecord(
          requests.length,
          requestStart,
          readAnthropicUsage(response),
          facts(response, client),
        ),
      );
      return response;
    };

    // toolIdMap: bareName → namespaced id, used to recover routing key from LLM responses.
    // Collision guard: two MCP servers may not expose the same bare tool name in the same step.
    const toolIdMap = new Map<string, string>();
    const anthropicTools: Array<{
      name: string;
      description: string;
      input_schema: Record<string, unknown>;
      strict?: boolean; // issue #311 — per-tool, set only for run-agent-selected tools
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
        // issue #311: per-tool strict, same spread SHAPE as buildSubmitTool's own `strict` option
        // — the key only ever appears when run-agent selected this tool, so a non-selected tool's
        // wire entry stays byte-identical to today's.
        ...(tool.strict === true ? { strict: true } : {}),
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
    /** Attaches `correctionCount` to a result only when at least one correction happened, plus
     *  (issue #311) the tool-args drop facts when the ladder below dropped strict mid-attempt.
     *  This is the single result chokepoint for `callStepWithTools` — every successful return
     *  goes through it, so neither field can be forgotten on a new exit path. */
    const withCorrectionCount = (result: StepWithToolsResult): StepWithToolsResult => ({
      ...result,
      ...(correction_count > 0 ? { correctionCount: correction_count } : {}),
      ...(toolArgsStrictDrop !== undefined ? { toolArgsStrictDrop } : {}),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history: any[] = [{ role: 'user', content: prompt }];

    // -----------------------------------------------------------------------------------------
    // issue #677 — a thinking block travels only with the list of tools its turn was made under.
    //
    // Anthropic binds every `thinking` block to the `tools` of the request that produced it. A
    // later request that carries the block in its history under a DIFFERENT `tools` list is
    // refused (the live text, verbatim):
    //   400 invalid_request_error — messages.1.content.0: Invalid `signature` in `thinking`
    //   block. The block is bound to a different conversation. Remove the block, or set
    //   `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires
    //   the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header. The
    //   `tools` list differs from the one this block was created with.
    // This path changes the list in two places: the final extraction (only the answer tool, or
    // none) and every main turn after the #311 drop (the same tools without `strict`). On a model
    // that thinks by default (Claude Sonnet 5.5; realm sends no `thinking` field) both failed as
    // soon as an earlier turn thought.
    //
    // The rule: every assistant turn is tagged with the KEY of the request that produced it, and
    // a request leaves out the `thinking` and `redacted_thinking` blocks of every assistant turn
    // tagged with a different key. The key is the `tools` list ONLY — a changed `tool_choice`
    // with the same tools keeps the block valid (live check T5) — and the rule is PER TURN: after
    // a drop, a turn made under the stripped list keeps its thinking (T7). The beta setting the
    // error offers ("drop_block") is not used: it is a beta, and it needs a `thinking` field realm
    // sends on no request today, which would change every request.
    // -----------------------------------------------------------------------------------------

    /** The key of a request: the exact `tools` value placed on it, or `null` when it sends no
     *  `tools` key. `tool_choice`, the system prompt and `max_tokens` are deliberately not in it. */
    const requestToolsKey = (requestTools: unknown): string => JSON.stringify(requestTools ?? null);

    /** Each assistant message object → the key of the request that produced it. Keyed by the
     *  message OBJECT, so the history itself carries no extra field and is never rewritten. */
    const assistantTurnKeys = new WeakMap<object, string>();

    /** The ONE place an assistant turn enters the history (both the tool-use and the correction
     *  branch go through it): pushes the turn with the model's own content array and records the
     *  key of the request that produced it. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pushAssistantTurn = (content: any, key: string): void => {
      const turn = { role: 'assistant', content };
      assistantTurnKeys.set(turn, key);
      history.push(turn);
    };

    const isThinkingBlock = (block: unknown): boolean => {
      if (block === null || typeof block !== 'object') return false;
      const type = (block as { type?: unknown }).type;
      return type === 'thinking' || type === 'redacted_thinking';
    };

    /** An assistant turn whose thinking must stay out of a request with this key: it was made
     *  under a different list (an assistant turn with no recorded key cannot happen — every push
     *  goes through `pushAssistantTurn` — and would be treated as made under a different list)
     *  and it actually carries a thinking block. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const thinkingToLeaveOut = (message: any, key: string): boolean =>
      message !== null &&
      typeof message === 'object' &&
      message.role === 'assistant' &&
      assistantTurnKeys.get(message) !== key &&
      Array.isArray(message.content) &&
      message.content.some(isThinkingBlock);

    /**
     * The `messages` of a request with this key. When no turn needs a block removed — every main
     * turn of a step with no #311 drop, every step whose model never thought — it is the `history`
     * array ITSELF, exactly as before this change. Otherwise it is a new array: each affected
     * assistant turn is a new object `{ ...turn, content: <a filtered copy> }` and every other
     * element is the same object as in `history`. The history, its messages and their content
     * arrays are never modified (the #311 rule below: objects already handed to the SDK must not
     * be rewritten afterwards). A turn left with no blocks is sent as `content: []` — Anthropic
     * accepts it (T6); the turn is never dropped and no text is invented.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messagesFor = (key: string): any[] => {
      if (!history.some((message) => thinkingToLeaveOut(message, key))) return history;
      return history.map((message) =>
        thinkingToLeaveOut(message, key)
          ? {
              ...message,
              content: (message.content as unknown[]).filter((block) => !isThinkingBlock(block)),
            }
          : message,
      );
    };

    /** A main turn's request body and its key. The `tools` value is decided first so the key is
     *  the exact list this request sends (after a #311 drop, the stripped copies). */
    const buildMainCallOpts = (): { body: Record<string, unknown>; key: string } => {
      let requestTools: unknown;
      if (anthropicTools.length > 0) {
        // issue #311: once strict has been dropped, every later turn sends STRIPPED COPIES rather
        // than the mutated originals. Mutating the shared objects in place would retroactively
        // rewrite the request objects already handed to the SDK for earlier turns — an aliasing
        // hazard, and it makes the wire history unreadable (a request that genuinely carried
        // strict would appear never to have). Pre-drop — which includes every step that never
        // opted in — the original array is passed exactly as before, with no copy.
        requestTools = toolArgsStrictStripped
          ? anthropicTools.map(({ strict: _strict, ...rest }) => rest)
          : anthropicTools;
      }
      const key = requestToolsKey(requestTools);
      // The property order is today's (model, max_tokens, system, messages, tools), so a request
      // that needs nothing removed is byte-for-byte what it was before issue #677.
      // Issue #899: unless the choice is `off`, the turn asks to cache `system` and the
      // conversation so far — a marker on a COPY of the last message, never on `history`.
      const choice = this.cacheChoice;
      const opts: Record<string, unknown> = {
        model: this.model,
        max_tokens: resolveMaxTokens(this.model),
        system: systemWithCache(system, choice),
        messages:
          choice === 'off'
            ? messagesFor(key)
            : markLastMessage(messagesFor(key), cacheControlFor(choice)),
      };
      if (requestTools !== undefined) opts['tools'] = requestTools;
      return { body: opts, key };
    };

    // -----------------------------------------------------------------------------------------
    // issue #311 — the tool-arguments fallback ladder. ONE wrap point on the main agentic loop's
    // only `messages.create`, which covers every turn of the loop including the #224
    // in-conversation correction turns.
    //
    // Deliberately SEPARATE from the #236 ladder above (which owns the step-OUTPUT dimension on
    // the callStep/callStepWithMeta path): the two dimensions fail independently, and the
    // stickiness rules differ (see below). Status-only, exactly like #236 — the arm keys on HTTP
    // status ∧ strict-carried, NEVER on message text.
    // -----------------------------------------------------------------------------------------
    let toolArgsStrictActive = anthropicTools.some((t) => t.strict === true);
    let toolArgsStrictStripped = false;
    let strictTurnsBeforeDrop = 0;
    let toolArgsStrictDrop: StepWithToolsResult['toolArgsStrictDrop'];

    /** Stops sending strict for the REST of this invocation (the immediate retry included). */
    const dropToolArgsStrict = (): void => {
      toolArgsStrictActive = false;
      toolArgsStrictStripped = true;
    };

    /** Returns the response together with the key of the request that produced it (issue #677):
     *  after a #311 drop that is the RETRY's key — the stripped list — not the first attempt's. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createMainTurn = async (): Promise<{ response: any; key: string }> => {
      const carriedStrict = toolArgsStrictActive;
      try {
        const request = buildMainCallOpts();
        const response = await bounded(request.body, (response, client) =>
          this.requestFacts(response, client),
        );
        // Only a strict-DECORATED request that came back 200 counts toward the disclosed
        // "turns before drop" — that is exactly what the number claims.
        if (carriedStrict) strictTurnsBeforeDrop += 1;
        return { response, key: request.key };
      } catch (err) {
        // A turn that carried NO strict is none of this ladder's business: its 400 is a real
        // failure of the request itself and must propagate untouched, never be re-attributed to
        // structured output.
        if (!carriedStrict) throw err;
        const status = extractHttpStatus(err);
        if (status !== 400 && status !== 503) throw err; // unrelated failure — never engage
        const api_message = extractErrorMessage(err);
        const reason =
          status === 400
            ? 'api_rejected_schema'
            : api_message.includes(GRAMMAR_UNAVAILABLE_TEXT)
              ? 'grammar_unavailable'
              : 'service_unavailable';
        // Recorded BEFORE the drop so `strict_turns_before_drop` reports the 200s that preceded
        // this rejection (0 = the first strict-carrying turn of the attempt was rejected).
        toolArgsStrictDrop = {
          reason,
          api_message,
          strict_turns_before_drop: strictTurnsBeforeDrop,
        };
        dropToolArgsStrict();
        // Retry the SAME turn once, unconstrained. A failure here is a genuine call failure and
        // propagates — realm does not swallow it behind the ladder. The retry builds its own
        // `messages` from its own key (issue #677): the stripped list is a different list, so the
        // thinking of the turns made while strict was on stays out of it.
        const retry = buildMainCallOpts();
        return {
          response: await bounded(retry.body, (response, client) =>
            this.requestFacts(response, client),
          ),
          key: retry.key,
        };
      }
    };

    // Forces a final answer: offers the __realm_submit__ tool at tool_choice:'auto' when a schema is
    // available (mirrors callStep's P0 mechanism — tool_use.input arrives pre-parsed, no parse step);
    // otherwise forces a plain text answer (tool_choice:'none', no tools array — can't type a tool
    // without a schema) and falls to the P1 extractor. Does NOT push to history — callers must ensure
    // history ends with a valid user turn. NOT restructuring the agentic loop / MCP tools array —
    // this synthetic tool only ever appears on this ONE isolated extraction call.
    const performFinalExtraction = async (): Promise<StepWithToolsResult> => {
      // issue #236 + #311: buildSubmitTool's `strict` option is never threaded here — BY DESIGN
      // now, no longer by construction.
      //
      // The old reasoning was that G6 made every tools-bearing step ineligible for strict, so a
      // `true` could never reach this path at all. #311 killed that premise: a tools-bearing step
      // CAN now be strict-declared, and its tools do carry strict on the wire. What #311 does NOT
      // change is this call: the final extraction asks the model for the STEP'S OUTPUT, which on
      // the tools fork is deliberately never grammar-constrained (that is precisely what the
      // step-level `unsupported_context_tools` disclosure reports). Constraining it here would
      // make that disclosure a lie.
      //
      // The old "no end-to-end pin is possible here — do not add one" instruction is therefore
      // obsolete and is REPLACED: the pin is now both possible and required (test plan pin 15 —
      // on an opted-in tools step, this call's opts never contain `strict`).
      const finalSubmitTool =
        options.inputSchema !== undefined ? buildSubmitTool(options.inputSchema) : undefined;
      // issue #677: this request offers only the answer tool, or no tools at all — a different
      // list from the step's own — so the thinking of the earlier turns stays out of it (see
      // `messagesFor`). With no tools on either side the key matches and the thinking is kept.
      const finalTools = finalSubmitTool !== undefined ? [finalSubmitTool] : undefined;
      const finalOpts: Record<string, unknown> = {
        model: this.model,
        max_tokens: resolveMaxTokens(this.model),
        system,
        messages: messagesFor(requestToolsKey(finalTools)),
      };
      if (finalTools !== undefined) {
        finalOpts['tools'] = finalTools;
        finalOpts['tool_choice'] = { type: 'auto' };
      } else {
        finalOpts['tool_choice'] = { type: 'none' };
        // NO tools array — enforces text-only response
        // NO response_format — Anthropic's structured-output mechanism is strict TOOL USE
        // (issue #236's `structured_output: 'strict'`, wired through buildSubmitTool's `strict`
        // option above), not an `output_config.format` request parameter — deliberately not
        // used here (banked, design record R-P).
      }
      // Issue #899: no cache marker and no ask — nothing after this request could read its write.
      const final = await bounded(finalOpts, this.toolsRequestFacts);
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
        sanitizeError(`max_tool_calls reached; final extraction failed: ${passedSnippet(text)}`),
        {
          code: 'ENGINE_STEP_FAILED',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: false,
        },
      );
    };

    while (true) {
      // `turnKey` is the key of the request that produced this response (issue #677).
      const { response, key: turnKey } = await createMainTurn();
      const toolUseBlocks = (
        response.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>
      ).filter((b) => b.type === 'tool_use');

      if (toolUseBlocks.length > 0) {
        pushAssistantTurn(response.content, turnKey);

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
          const start = performance.now();

          let resultContent: string;
          let record: ToolCallRecord;

          try {
            const rawResult = await Promise.race([
              executor(originalId, args),
              rejectAfter(options.toolTimeoutMs ?? 30000),
            ]);
            const serialized = serializeToolResult(rawResult);
            // issue #345: a call that RETURNED with `isError: true` failed politely — Class B. The
            // record gains `error` so it stops reading as a success; `result` keeps the full
            // serialized payload (evidence is never discarded) and `resultContent` — what the
            // MODEL sees — is byte-untouched, because how the model is told is a conversation
            // decision this fix has no business changing.
            const classB = classBError(rawResult);
            record = {
              server_id: serverId,
              tool: toolName,
              args,
              result: serialized,
              duration_ms: Math.max(0, Math.round(performance.now() - start)),
              ...(classB !== undefined ? { error: classB } : {}),
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
              duration_ms: Math.max(0, Math.round(performance.now() - start)),
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
            ? renderSubmissionProblems(verdict)
            : 'no valid JSON object could be extracted from the response';
        console.error(`  ⚠ output rejected (in-conversation); correcting (${correction_count})`);
        pushAssistantTurn(response.content, turnKey);
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
