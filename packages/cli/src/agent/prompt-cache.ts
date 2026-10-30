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
 * The setting a drive asks Anthropic for, where it came from, which runner chose it and — when the
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
 * Issue #898 — where `auto`'s choice took its prices, in words: the start line, `realm run inspect`
 * and every other render. `asked` is the lifetime asked, in seconds, or `'off'`; a fallback's words
 * end by what that ask was. Total: never throws, for any `asked` a stored record can hold.
 */
export function autoPricesText(prices: CacheAutoPricesView, asked: number | 'off'): string {
  const short = lifetimeText(ANTHROPIC_CACHE_TIERS.short.lifetime_s);
  const longS = ANTHROPIC_CACHE_TIERS.long.lifetime_s;
  const tail =
    asked === longS
      ? `, so ${autoLongText()} without prices`
      : asked === 'off'
        ? `, and no gap was under ${autoFallbackWindowText()}, so no caching`
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
 * and (#898) where its prices came from, after the evidence. `asked` is what the provider asks.
 */
function reasonText(promptCache: ResolvedPromptCache, asked: number | 'off'): string {
  const v = promptCache.value;
  const listen = promptCache.by === 'realm listen';
  if (v !== 'auto') {
    // eslint-disable-next-line no-restricted-syntax -- prose naming the setting's source, not a command to copy (#729 PR-3, L-2).
    return listen ? `set by realm listen --prompt-cache ${v}` : `set by --prompt-cache ${v}`;
  }
  const prices = promptCache.auto?.prices;
  const evidence =
    `auto: ${autoEvidence(promptCache.auto ?? { basis: 'no_measurement' })}; ` +
    (prices !== undefined ? `${autoPricesText(prices, asked)}; ` : '');
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
 *   (`'off'`, a readable `{ lifetime_s }`, or a value Realm cannot read);
 * - F2, a provider without the capability: Realm asks it for no caching (and a `realm listen` child
 *   given the flag says that listen's flag applies only to Anthropic);
 * - F3, `off`;
 * - F4b, on, but the workflow has no agent step;
 * - F5, on, with the steps it applies to.
 * `promptCache` is absent for a provider module and for a host that calls `runAgent` itself; then
 * F3 and F5 leave out their parenthetical.
 */
export function promptCacheStartLine(input: {
  caps: Pick<ProviderCapabilities, 'promptCache' | 'providerId' | 'jsonMode'>;
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
    if (readableLifetime(asked)) {
      return `Caching: your provider module asks for ${lifetimeText(asked.lifetime_s)} by its own setting${tail}`;
    }
    return `Caching: your provider module declares a caching setting Realm cannot read${tail}`;
  }
  if (asked === undefined) {
    const notice =
      promptCache?.by === 'realm listen' && promptCache.source === 'stated'
        ? // eslint-disable-next-line no-restricted-syntax -- prose naming the setting, not a command to copy (#729 PR-3, L-2).
          ` realm listen --prompt-cache ${promptCache.value} applies only to Anthropic.`
        : '';
    return `Caching: Realm asks ${providerName(caps, 'this provider')} for no caching; any caching it does is its own.${notice}`;
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
  return `Caching: Anthropic is asked to cache each step's fixed instructions for ${lifetimeText(asked.lifetime_s)}${source}.${tools}`;
}

/**
 * The name `realm agent` gives a provider that Realm asks for no caching: `OpenAI` for the o1
 * provider and for the OpenAI provider on its native endpoint, `this endpoint` for the OpenAI
 * provider on a `--base-url` endpoint, and `fallback` otherwise. The start line (F2) and the
 * refusal of a setting the provider cannot apply both use it.
 */
export function providerName(
  caps: Pick<ProviderCapabilities, 'providerId' | 'jsonMode'>,
  fallback: string,
): string {
  if (caps.providerId === 'openai-reasoning') return 'OpenAI';
  if (caps.providerId === 'openai') return caps.jsonMode ? 'OpenAI' : 'this endpoint';
  return fallback;
}
