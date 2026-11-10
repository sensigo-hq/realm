// prompt-cache.ts — issue #600 PR 2 (C1): the `--prompt-cache` flag's parsing, the setting a drive
// asks for, and the count of steps it could apply to. The flag and its words live here, at the
// transport; core keeps the vocabularies and stores classes, never the flag's words.
import { InvalidArgumentError } from 'commander';
import {
  AUTO_LIFETIME_MARGIN,
  CACHE_GAP_MAX_S,
  PROMPT_CACHE_SETTINGS,
  type CacheAuto,
  type CacheAutoPricesView,
  type CacheRequestSource,
  type PromptCacheSetting,
  type WorkflowDefinition,
} from '@sensigo/realm';
import type { ProviderCapabilities } from './providers/llm-provider.js';
import { ANTHROPIC_CACHE_TIERS } from './providers/anthropic-provider.js';
import { OPENAI_EXPLICIT_LIFETIME_S } from './providers/openai-provider.js';

/**
 * Commander argParser for `--prompt-cache`, used by `realm agent` and `realm listen` (the
 * `parseProvider` idiom). Exactly the four words; anything else, `OFF`, the empty string and the old
 * `5m` / `1h` included, is refused.
 */
export function parsePromptCache(value: string): PromptCacheSetting {
  if ((PROMPT_CACHE_SETTINGS as readonly string[]).includes(value)) {
    return value as PromptCacheSetting;
  }
  throw new InvalidArgumentError('--prompt-cache must be auto, short, long or off.');
}

/** Caching 3-M (B2b): what an operator can state with `--cache-diagnostics`. */
export type CacheDiagnosticsSetting = 'on' | 'off';

/**
 * Commander argParser for `--cache-diagnostics`, used by `realm agent` and `realm listen` beside
 * {@link parsePromptCache}. Exactly the two words; anything else, `ON`, `true` and the empty string
 * included, is refused. No Commander default: an unstated flag stays unstated.
 */
export function parseCacheDiagnostics(value: string): CacheDiagnosticsSetting {
  if (value === 'on' || value === 'off') return value;
  throw new InvalidArgumentError('--cache-diagnostics must be on or off.');
}

/**
 * The workflow's agent steps (`execution: 'agent'`), split by path: `singleShot` sends its
 * instructions in one request (no tools, or an empty list — `run-agent.ts`'s path test), and
 * `withTools` calls tools. The drive's start line reads both counts, and `realm agent`'s refusal
 * of a setting with nothing to apply to reads their sum.
 */
export function cacheableStepCounts(definition: Pick<WorkflowDefinition, 'steps'>): {
  singleShot: number;
  withTools: number;
} {
  let singleShot = 0;
  let withTools = 0;
  for (const step of Object.values(definition.steps)) {
    if (step.execution !== 'agent') continue;
    if (step.tools !== undefined && step.tools.length > 0) withTools += 1;
    else singleShot += 1;
  }
  return { singleShot, withTools };
}

/**
 * The setting a drive asks Anthropic for (caching 3-B: and by which an OpenAI drive sends its cache
 * key, or not), where it came from, which runner chose it and — when the
 * setting is `auto` — on what basis the adapter chooses (`UsageRecord.cache_auto`). Issue #898: after
 * a settle, `realm agent` adds `auto.prices` from its outcome for the start line.
 */
export interface ResolvedPromptCache {
  value: PromptCacheSetting;
  source: CacheRequestSource;
  by: 'realm agent' | 'realm listen';
  auto?: CacheAuto;
}

/** `--cache-gaps`' words: one to five whole numbers of at most six digits, comma-separated. */
const CACHE_GAPS_PATTERN = /^\d{1,6}(,\d{1,6}){0,4}$/;

/**
 * The setting a `realm agent` drive asks for (issue #600, the lifetime unit). `value` is the stated
 * flag, else `auto`; `source` says which (`stated`, `runner_default`); `by` is the runner (a drive
 * marked `--spawned-by-listen` is `realm listen`'s). Under `auto`:
 * - a drive `realm agent` starts on its own has no measurement: `{ basis: 'no_measurement' }`;
 * - a drive listen starts with no `--cache-gaps` (its workflow's first trigger):
 *   `{ basis: 'listen_trigger_gaps', gaps_s: [] }`;
 * - with a readable `--cache-gaps` (one to five whole seconds, each at most 604 800):
 *   `{ basis: 'listen_trigger_gaps', gaps_s }`;
 * - anything else: `{ basis: 'listen_gaps_unreadable' }`.
 * Pure. Never throws: a value listen passes can never stop a run.
 */
export function resolvePromptCache(input: {
  flag: PromptCacheSetting | undefined;
  spawnedByListen: boolean;
  cacheGaps: string | undefined;
}): ResolvedPromptCache {
  const by = input.spawnedByListen ? 'realm listen' : 'realm agent';
  const value = input.flag ?? 'auto';
  const source: CacheRequestSource = input.flag !== undefined ? 'stated' : 'runner_default';
  if (value !== 'auto') return { value, source, by };
  return { value, source, by, auto: autoBasis(input.spawnedByListen, input.cacheGaps) };
}

/** What `auto` reads, from the drive's start (B2). */
function autoBasis(spawnedByListen: boolean, cacheGaps: string | undefined): CacheAuto {
  if (!spawnedByListen) return { basis: 'no_measurement' };
  if (cacheGaps === undefined) return { basis: 'listen_trigger_gaps', gaps_s: [] };
  if (CACHE_GAPS_PATTERN.test(cacheGaps)) {
    const gaps = cacheGaps.split(',').map(Number);
    if (gaps.every((g) => g <= CACHE_GAP_MAX_S)) {
      return { basis: 'listen_trigger_gaps', gaps_s: gaps };
    }
  }
  return { basis: 'listen_gaps_unreadable' };
}

/** `1 hour`, `N hours`; else `1 minute`, `N minutes`; else `1 second`, `N seconds` — exact. */
export function lifetimeText(s: number): string {
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (s > 0 && s % 3600 === 0) return unit(s / 3600, 'hour');
  if (s > 0 && s % 60 === 0) return unit(s / 60, 'minute');
  return unit(s, 'second');
}

/** The measured gaps in words, rounded: `about 7 minutes and 12 minutes`. */
export function gapsText(gaps: readonly number[]): string {
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const words = gaps.map((s) =>
    s < 90
      ? unit(s, 'second')
      : s < 5_400
        ? unit(Math.round(s / 60), 'minute')
        : unit(Math.round(s / 3600), 'hour'),
  );
  const joined =
    words.length <= 1
      ? (words[0] ?? '')
      : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `about ${joined}`;
}

/** What `auto` chose on, in words (the start line, `realm run inspect`). */
export function autoEvidence(auto: Pick<CacheAuto, 'basis' | 'gaps_s'>): string {
  switch (auto.basis) {
    // Caching 3-M (D-2): a choice made for one step.
    case 'step_gaps': {
      const gaps = auto.gaps_s ?? [];
      if (gaps.length === 0)
        return 'Realm found no earlier request of this step from the last 7 days';
      const n = gaps.length;
      return `the last ${n === 1 ? 'gap' : `${n} gaps`} between this step's runs ${n === 1 ? 'was' : 'were'} ${gapsText(gaps)}`;
    }
    case 'step_gaps_unreadable':
      return "Realm could not read this workflow's earlier runs";
    case 'tool_step':
      return 'a step that calls tools reuses its own turns, so auto does not choose for it';
    case 'no_measurement':
      return 'a drive realm agent starts on its own has no trigger history';
    case 'listen_gaps_unreadable':
      return "realm listen's measurement could not be read";
    case 'listen_trigger_gaps': {
      const gaps = auto.gaps_s ?? [];
      if (gaps.length === 0)
        return 'no earlier trigger of this workflow since realm listen started';
      const n = gaps.length;
      return `the last ${n === 1 ? 'gap' : `${n} gaps`} between this workflow's triggers ${n === 1 ? 'was' : 'were'} ${gapsText(gaps)}`;
    }
  }
}

/** Issue #898 — the long lifetime in words (`1 hour`), from the provider's constant. */
export function autoLongText(): string {
  return lifetimeText(ANTHROPIC_CACHE_TIERS.long.lifetime_s);
}

/**
 * Issue #898 — the fallback's window in words (`54 minutes`): a gap under it is read under the long
 * lifetime ({@link AUTO_LIFETIME_MARGIN} × the long lifetime).
 */
export function autoFallbackWindowText(): string {
  return lifetimeText(AUTO_LIFETIME_MARGIN * ANTHROPIC_CACHE_TIERS.long.lifetime_s);
}

/**
 * #896 unit B — the lifetime an `auto` fallback asks for, by the provider that answered: OpenAI's one
 * lifetime (30 minutes) for `openai`, else Anthropic's long one (1 hour; also when none is known),
 * for every runner (the owner's rule, `chooseAutoLifetime`).
 */
function fallbackLifetimeS(provider: string | undefined): number {
  return provider === 'openai' ? OPENAI_EXPLICIT_LIFETIME_S : ANTHROPIC_CACHE_TIERS.long.lifetime_s;
}

/**
 * Issue #898 — where `auto`'s choice took its prices, in words: the start line, `realm run inspect`
 * and every other render. `asked` is the lifetime asked, in seconds, or `'off'`; a fallback's words
 * end by what that ask was, and (#896 unit B) by the window of the provider that answered
 * (`provider`: 27 minutes for `openai`, else 54). Total: never throws, for any `asked` a stored
 * record can hold.
 */
export function autoPricesText(
  prices: CacheAutoPricesView,
  asked: number | 'off',
  provider?: string,
): string {
  const short = lifetimeText(ANTHROPIC_CACHE_TIERS.short.lifetime_s);
  const fallbackS = fallbackLifetimeS(provider);
  const tail =
    asked === fallbackS
      ? `, so ${lifetimeText(fallbackS)} without prices`
      : asked === 'off'
        ? `, and no gap was under ${lifetimeText(AUTO_LIFETIME_MARGIN * fallbackS)}, so no caching`
        : '';
  switch (prices.from) {
    case 'economics':
      if (prices.excluded?.[0] === 'long') {
        return `priced from your price file without ${autoLongText()}: it has no cache_write_1h rate for this model`;
      }
      if (prices.excluded?.[0] === 'short') {
        return `priced from your price file without ${short}: it has no cache_write_5m rate for this model`;
      }
      return 'priced from your price file';
    case 'not_recorded':
      return 'price source not recorded (this request was recorded before Realm priced auto from the price file)';
    case 'none':
      switch (prices.cause) {
        case 'no_file':
          return `no price file (runner.cache.economics is not set)${tail}`;
        case 'economics_unreachable':
          return `the price file could not be read${tail}`;
        case 'economics_unreadable':
          return `the price file is not a valid price file${tail}`;
        case 'model_unknown':
          return `the price file does not price this model${tail}`;
        case 'input_zero':
          return `the price file prices input at 0 for this model${tail}`;
        case 'rate_missing':
          return `the price file has no ${(prices.missing ?? []).join(' or ')} rate for this model${tail}`;
      }
  }
}

/**
 * The reason clause of the start line (`R`): where the setting came from, and what `auto` read —
 * and (#898) where its prices came from, after the evidence. `asked` is what the provider asks;
 * `provider` (#896 unit B) names whose fallback window the price words give.
 */
function reasonText(
  promptCache: ResolvedPromptCache,
  asked: number | 'off',
  provider?: string,
): string {
  const v = promptCache.value;
  const listen = promptCache.by === 'realm listen';
  if (v !== 'auto') {
    // eslint-disable-next-line no-restricted-syntax -- prose naming the setting's source, not a command to copy (#729 PR-3, L-2).
    return listen ? `set by realm listen --prompt-cache ${v}` : `set by --prompt-cache ${v}`;
  }
  const prices = promptCache.auto?.prices;
  const evidence =
    `auto: ${autoEvidence(promptCache.auto ?? { basis: 'no_measurement' })}; ` +
    (prices !== undefined ? `${autoPricesText(prices, asked, provider)}; ` : '');
  if (promptCache.source === 'stated') {
    return (
      evidence + (listen ? 'set by realm listen --prompt-cache auto' : 'set by --prompt-cache auto')
    );
  }
  return (
    evidence +
    (listen
      ? "realm listen's default; change it with realm listen --prompt-cache"
      : "realm agent's default; turn it off with --prompt-cache off")
  );
}

/** A module's declared lifetime the start line can read: a whole number of seconds, 1 to 7 days. */
function readableLifetime(asked: unknown): asked is { lifetime_s: number } {
  if (asked === null || typeof asked !== 'object') return false;
  const s = (asked as { lifetime_s?: unknown }).lifetime_s;
  return Number.isInteger(s) && (s as number) >= 1 && (s as number) <= CACHE_GAP_MAX_S;
}

/**
 * Issue #600 PR 2 (D1) — the drive's start line, printed after `Run ID:`: what this drive asks the
 * provider to cache, and why (the lifetime unit: the duration in words, and what `auto` read). The
 * first form that matches wins:
 * - F1, a provider module that declares `promptCache`: its own setting, which the flag does not reach
 *   (`'off'`, `'provider'` — it caches by its own rules —, a readable `{ lifetime_s }`, or a value
 *   Realm cannot read);
 * - caching 3-B (D4), a provider that caches by its own rules (`'provider'`: the OpenAI providers):
 *   whether Realm sends it the cache key, by the endpoint and the setting;
 * - #896, the `openai` provider on GPT-5.6 or later at OpenAI's own address (a lifetime or `'off'`);
 * - F2, a provider without the capability: Realm asks it for no caching;
 * - F3, `off`;
 * - F4b, on, but the workflow has no agent step;
 * - F5, on, with the steps it applies to.
 * `promptCache` is absent for a provider module and for a host that calls `runAgent` itself; then
 * F3 and F5 leave out their parenthetical.
 */
export function promptCacheStartLine(input: {
  caps: Pick<ProviderCapabilities, 'promptCache' | 'providerId' | 'jsonMode' | 'endpoint'>;
  promptCache: ResolvedPromptCache | undefined;
  moduleProviderId: string | undefined;
  definition: Pick<WorkflowDefinition, 'steps'>;
}): string {
  const { caps, promptCache } = input;
  const asked = caps.promptCache;
  if (input.moduleProviderId !== undefined && asked !== undefined) {
    const tail = '; --prompt-cache does not apply to provider modules.';
    if (asked === 'off')
      return `Caching: your provider module asks for no caching by its own setting${tail}`;
    // caching 3-B (D3): a module may declare that its service caches by its own rules.
    if (asked === 'provider') return 'Caching: this provider caches by its own rules.';
    if (readableLifetime(asked)) {
      return `Caching: your provider module asks for ${lifetimeText(asked.lifetime_s)} by its own setting${tail}`;
    }
    return `Caching: your provider module declares a caching setting Realm cannot read${tail}`;
  }
  // caching 3-B (D4, B10): the OpenAI providers — OpenAI caches by its own rules, and Realm sends a
  // cache key (a hint) on OpenAI's own endpoint under every setting but `off`, and on a custom
  // endpoint only for a setting the operator stated. A `realm listen` child says the same words.
  if (asked === 'provider') return providerCachingLine(caps, promptCache);
  // #896: the `openai` provider on GPT-5.6 or later at OpenAI's own address asks for 30 minutes, or
  // for nothing under `off` (its capability is a lifetime or `'off'` only there).
  if (caps.providerId === 'openai' && asked !== undefined) {
    return openAiExplicitLine(asked, promptCache, input.definition);
  }
  if (asked === undefined) {
    // F2: a provider without the capability (a provider module or a host's own provider).
    return `Caching: Realm asks ${providerName(caps, 'this provider')} for no caching; any caching it does is its own.`;
  }
  const source =
    promptCache === undefined
      ? ''
      : ` (${reasonText(promptCache, asked === 'off' ? 'off' : asked.lifetime_s)})`;
  if (asked === 'off') return `Caching: off; Anthropic is asked to cache nothing${source}.`;
  const counts = cacheableStepCounts(input.definition);
  if (counts.singleShot + counts.withTools === 0) {
    return 'Caching: no step is cached; this workflow has no agent step.';
  }
  const tools =
    counts.withTools > 0
      ? ' On a step that calls tools, it is also asked to cache the conversation so far, at each turn.'
      : '';
  return `Caching: Anthropic is asked to cache each step's fixed instructions and the stable start of its prompt for ${lifetimeText(asked.lifetime_s)}${source}.${tools}`;
}

/**
 * #896 — the start line of the `openai` provider in the explicit set (GPT-5.6 and later at OpenAI's
 * own address). In order:
 * - a stated `off`: the off line, whatever the steps (unit A's);
 * - no agent step: the off line when `auto` chose no caching (Anthropic's order), else no step is
 *   cached;
 * - every agent step calls tools: those are left to OpenAI's own caching, the key still sent —
 *   whatever `auto` chose, since a tool step is not part of the choice (unit A's reason);
 * - `auto` chose no caching: the off line;
 * - otherwise the 30-minute ask.
 * The last two add a sentence on tool steps when one calls tools, and give Anthropic's reason
 * (unit B: `auto`'s evidence and price words, OpenAI's window). With no setting given (a host
 * calling `runAgent`), no parenthetical.
 */
function openAiExplicitLine(
  asked: 'off' | { lifetime_s: number },
  promptCache: ResolvedPromptCache | undefined,
  definition: Pick<WorkflowDefinition, 'steps'>,
): string {
  const source = promptCache === undefined ? '' : ` (${openAiReasonText(promptCache)})`;
  const offLine = 'Caching: off; OpenAI is asked to cache nothing';
  if (asked === 'off' && promptCache?.value !== 'auto') return `${offLine}${source}.`;
  const reason =
    promptCache === undefined
      ? ''
      : ` (${reasonText(promptCache, asked === 'off' ? 'off' : asked.lifetime_s, 'openai')})`;
  const counts = cacheableStepCounts(definition);
  if (counts.singleShot + counts.withTools === 0) {
    return asked === 'off'
      ? `${offLine}${reason}.`
      : 'Caching: no step is cached; this workflow has no agent step.';
  }
  const leftToOpenAi = "OpenAI's own caching, which reuses each turn at the next";
  if (counts.singleShot === 0) {
    return `Caching: every agent step calls tools, so each is left to ${leftToOpenAi}; Realm sends a cache key${source}.`;
  }
  const tools = counts.withTools > 0 ? ` A step that calls tools is left to ${leftToOpenAi}.` : '';
  if (asked === 'off') return `${offLine}${reason}.${tools}`;
  return `Caching: OpenAI is asked to cache each step's fixed instructions and the stable start of its prompt for ${lifetimeText(asked.lifetime_s)}, the one lifetime Realm can ask OpenAI for${reason}.${tools}`;
}

/**
 * #896 unit A — the reason clause of the OpenAI line on a workflow whose every agent step calls
 * tools, and of a stated `off`: where the setting came from. Those steps are not part of `auto`'s
 * choice, so it names only who set it.
 */
function openAiReasonText(promptCache: ResolvedPromptCache): string {
  const v = promptCache.value;
  const listen = promptCache.by === 'realm listen';
  if (v !== 'auto' || promptCache.source === 'stated') {
    // eslint-disable-next-line no-restricted-syntax -- prose naming the setting's source, not a command to copy (#729 PR-3, L-2).
    return listen ? `set by realm listen --prompt-cache ${v}` : `set by --prompt-cache ${v}`;
  }
  return listen
    ? "auto, realm listen's default; change it with realm listen --prompt-cache"
    : "auto, realm agent's default; turn it off with --prompt-cache off";
}

/**
 * The name the start line gives a provider: for the OpenAI providers, `OpenAI` on OpenAI's own
 * endpoint and `this endpoint` on a custom one — read from the endpoint resolved once from the SDK
 * client (caching 3-B, D1), so `OPENAI_BASE_URL` counts as `--base-url` does; `fallback` otherwise.
 */
export function providerName(
  caps: Pick<ProviderCapabilities, 'providerId' | 'endpoint'>,
  fallback: string,
): string {
  if (caps.providerId === 'openai' || caps.providerId === 'openai-reasoning') {
    return caps.endpoint === 'custom' ? 'this endpoint' : 'OpenAI';
  }
  return fallback;
}

/**
 * Caching 3-B (D4, B10) — the start line of a provider that caches by its own rules (`'provider'`):
 * - the OpenAI providers on OpenAI's own endpoint: the key is sent under every setting but `off`;
 *   a stated `short` or `long` adds that it sets no lifetime there;
 * - on a custom endpoint: the key only for a stated setting other than `off`;
 * - `off`: no key, the service's own caching, if any, applies.
 */
function providerCachingLine(
  caps: Pick<ProviderCapabilities, 'providerId' | 'endpoint'>,
  promptCache: ResolvedPromptCache | undefined,
): string {
  const custom = caps.endpoint === 'custom';
  const name = providerName(caps, 'this provider');
  const value = promptCache?.value;
  const stated = promptCache?.source === 'stated';
  if (value === 'off') {
    return custom
      ? 'Caching: off; Realm sends this endpoint no cache key. Its own caching, if any, applies.'
      : "Caching: off; Realm sends OpenAI no cache key. OpenAI's own caching, if any, applies.";
  }
  if (custom && !stated) {
    return 'Caching: this endpoint caches by its own rules; Realm sends it no cache key (state --prompt-cache to send one).';
  }
  const line = `Caching: ${name} caches by its own rules; Realm sends a cache key that helps repeated steps reach the same cache (${name} treats it as a hint). Realm cannot set ${name}'s lifetime or turn its caching off.`;
  return stated && (value === 'short' || value === 'long')
    ? `${line} --prompt-cache ${value} sets no lifetime on ${name}.`
    : line;
}
