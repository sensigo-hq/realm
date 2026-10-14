// prompt-cache.ts — issue #600 PR 2 (C1): the `--prompt-cache` flag's parsing, the setting a drive
// asks for, and the count of steps it could apply to. The flag and its words live here, at the
// transport; core keeps the vocabularies and stores classes, never the flag's words.
import { InvalidArgumentError } from 'commander';
import {
  PROMPT_CACHE_SETTINGS,
  type CacheRequestSource,
  type PromptCacheSetting,
  type WorkflowDefinition,
} from '@sensigo/realm';
import type { ProviderCapabilities } from './providers/llm-provider.js';

/**
 * Commander argParser for `--prompt-cache`, used by `realm agent` and `realm listen` (the
 * `parseProvider` idiom). Exactly the three words; anything else, `OFF` and the empty string
 * included, is refused.
 */
export function parsePromptCache(value: string): PromptCacheSetting {
  if ((PROMPT_CACHE_SETTINGS as readonly string[]).includes(value)) {
    return value as PromptCacheSetting;
  }
  throw new InvalidArgumentError('--prompt-cache must be off, 5m or 1h.');
}

/**
 * The workflow's agent steps (`execution: 'agent'`), split by path: `singleShot` sends its
 * instructions in one request (no tools, or an empty list — `run-agent.ts`'s path test), and
 * `withTools` calls tools. The drive's start line and `realm agent`'s refusal of a setting with
 * nothing to apply to both read this one function.
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

/** The setting a drive asks Anthropic for, where it came from, and which runner chose it. */
export interface ResolvedPromptCache {
  value: PromptCacheSetting;
  source: CacheRequestSource;
  by: 'realm agent' | 'realm listen';
}

/**
 * The setting a `realm agent` drive asks for. A stated flag wins; otherwise the runner's default:
 * 5 minutes for a drive an operator starts, 1 hour for one `realm listen` starts (its child is
 * marked `--spawned-by-listen`). Pure.
 */
export function resolvePromptCache(input: {
  flag: PromptCacheSetting | undefined;
  spawnedByListen: boolean;
}): ResolvedPromptCache {
  const by = input.spawnedByListen ? 'realm listen' : 'realm agent';
  if (input.flag !== undefined) return { value: input.flag, source: 'stated', by };
  return { value: input.spawnedByListen ? '1h' : '5m', source: 'runner_default', by };
}

/** The `<source>` text of the start line: where the setting came from. */
function sourceText(promptCache: ResolvedPromptCache): string {
  const v = promptCache.value;
  if (promptCache.source === 'stated') {
    return promptCache.by === 'realm listen'
      ? `set by realm listen --prompt-cache ${v}`
      : `set by --prompt-cache ${v}`;
  }
  return promptCache.by === 'realm listen'
    ? "realm listen's default; change it with realm listen --prompt-cache"
    : "realm agent's default; turn it off with --prompt-cache off";
}

/**
 * Issue #600 PR 2 (D1) — the drive's start line, printed after `Run ID:`: what this drive asks the
 * provider to cache, and why. The first form that matches wins:
 * - F1, a provider module that declares `promptCache`: its own setting, which the flag does not reach;
 * - F2, a provider without the capability: Realm asks it for no caching (and a `realm listen` child
 *   given the flag says that listen's flag applies only to Anthropic);
 * - F3, `off`;
 * - F4a / F4b, on, but no agent step sends its instructions in one request;
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
    const what = asked === 'off' ? 'no caching' : asked;
    return `Caching: your provider module asks for ${what} by its own setting; --prompt-cache does not apply to provider modules.`;
  }
  if (asked === undefined) {
    const notice =
      promptCache?.by === 'realm listen' && promptCache.source === 'stated'
        ? ` realm listen --prompt-cache ${promptCache.value} applies only to Anthropic.`
        : '';
    return `Caching: Realm asks ${providerName(caps, 'this provider')} for no caching; any caching it does is its own.${notice}`;
  }
  const source = promptCache === undefined ? '' : ` (${sourceText(promptCache)})`;
  if (asked === 'off') return `Caching: off; Anthropic is asked to cache nothing${source}.`;
  const counts = cacheableStepCounts(input.definition);
  if (counts.singleShot === 0) {
    return counts.withTools > 0
      ? 'Caching: no step is cached; every agent step in this workflow calls tools, and steps that call tools are not cached yet.'
      : 'Caching: no step is cached; this workflow has no agent step.';
  }
  const tools = counts.withTools > 0 ? ' Steps that call tools are not cached yet.' : '';
  return `Caching: Anthropic is asked to cache each step's fixed instructions for ${asked}${source}.${tools}`;
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
