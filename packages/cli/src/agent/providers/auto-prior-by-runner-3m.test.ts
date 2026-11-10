// auto-prior-by-runner-3m.test.ts — caching 3-M piece D-3, check 5: an `auto` provider is never
// pending. Built as `realm agent` builds it (`resolvePromptCache` under `auto` gives
// `{ basis: 'no_measurement' }` for both runners), it answers `capabilities()` at once, with no settle,
// with the prior its runner (`by`) chooses: 5 minutes for `realm agent`, 1 hour for `realm listen`, 5
// minutes for a host that names no runner, and OpenAI's 30 minutes in the explicit set. Each row is a
// real case: an operator's drive, a drive `realm listen` started, a host that passes a setting without
// `by` (a provider module's host, written in JavaScript), and GPT-5.6 at OpenAI's own address. (a) Red
// when the prior is keyed on the basis (both runners' basis is `no_measurement`: the `realm listen`
// row goes to 300), or on `by === 'realm agent'` (the row with no `by` goes to 3600), or when
// `capabilities()` throws for want of a settle; (b) prints each row's lifetime, or the error.
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import type { LlmProvider, PromptCacheRequest } from './llm-provider.js';

const AUTO = {
  value: 'auto',
  source: 'runner_default',
  auto: { basis: 'no_measurement' },
} as const;

/** The lifetime `capabilities()` gives, its word when it gives none, or the error it throws. */
function lifetime(build: () => LlmProvider): number | string {
  try {
    const promptCache = build().capabilities().promptCache;
    return typeof promptCache === 'object' ? promptCache.lifetime_s : String(promptCache);
  } catch (e) {
    return String(e);
  }
}

describe('caching 3-M D-3 check 5 — auto is never pending: the prior, by runner', () => {
  it.each<[string, () => LlmProvider, number]>([
    [
      'Anthropic, a drive realm agent started → 5 minutes',
      () => new AnthropicProvider('claude-x', { promptCache: { ...AUTO, by: 'realm agent' } }),
      300,
    ],
    [
      'Anthropic, a drive realm listen started → 1 hour',
      () => new AnthropicProvider('claude-x', { promptCache: { ...AUTO, by: 'realm listen' } }),
      3600,
    ],
    [
      'Anthropic, a host that names no runner → 5 minutes',
      () =>
        new AnthropicProvider('claude-x', {
          promptCache: { ...AUTO } as unknown as PromptCacheRequest,
        }),
      300,
    ],
    [
      'OpenAI GPT-5.6 at its own address, a drive realm agent started → 30 minutes',
      () =>
        new OpenAIProvider('gpt-5.6-luna', undefined, false, {
          endpoint: 'default',
          promptCache: { ...AUTO, by: 'realm agent' },
        }),
      1800,
    ],
  ])('%s', (_case, build, expected) => {
    expect(lifetime(build)).toBe(expected);
  });
});
