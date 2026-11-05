// openai-endpoint-3b.test.ts — caching 3-B, Part D (D1, B3; D4, B10): "OpenAI's own endpoint" is ONE
// value, resolved once from the real SDK client (no network: building a client sends nothing), so
// `OPENAI_BASE_URL` counts as `--base-url` does; and the start line's words for a provider that
// caches by its own rules, one cell per branch. Each cell names (a) the change that turns it red and
// (b) what it prints: the endpoint values and the lines.
import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { resolveProvider, type PromptCacheRequest } from './llm-provider.js';
import { OPENAI_DEFAULT_BASE_URL } from './openai-provider.js';
import { promptCacheStartLine, type ResolvedPromptCache } from '../prompt-cache.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const AZURE = 'https://example-resource.openai.azure.com/openai/v1';
const RUNNER: PromptCacheRequest & ResolvedPromptCache = {
  value: 'auto',
  source: 'runner_default',
  by: 'realm agent',
};
async function endpointFor(baseUrl: string | undefined, envBase: string | undefined) {
  vi.stubEnv('OPENAI_API_KEY', 'sk-fake-not-a-key');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('OPENAI_BASE_URL', envBase ?? '');
  if (envBase === undefined) delete process.env['OPENAI_BASE_URL'];
  const { provider } = await resolveProvider({
    provider: 'openai',
    model: 'gpt-x',
    baseUrl,
    promptCache: RUNNER,
  });
  return provider.capabilities().endpoint;
}

describe('caching 3-B D1 — the endpoint, from the client the requests would go through', () => {
  it('a real SDK client built with no base URL resolves to OpenAI’s default address', () => {
    vi.stubEnv('OPENAI_BASE_URL', '');
    delete process.env['OPENAI_BASE_URL'];
    // (a) red when the SDK's default changes from the constant Realm compares with (every request
    //     would then read as custom); (b) prints both addresses.
    expect(new OpenAI({ apiKey: 'sk-fake-not-a-key' }).baseURL).toBe(OPENAI_DEFAULT_BASE_URL);
  });

  it('an Azure address is custom whether given by --base-url or by OPENAI_BASE_URL; none is default', async () => {
    // (a) red when the endpoint is read from the flag (or from jsonMode), which misses
    //     OPENAI_BASE_URL; (b) prints the three values.
    expect({
      flag: await endpointFor(AZURE, undefined),
      env: await endpointFor(undefined, AZURE),
      none: await endpointFor(undefined, undefined),
    }).toEqual({ flag: 'custom', env: 'custom', none: 'default' });
  });

  it('the o1 route reads OPENAI_BASE_URL too (it takes no --base-url)', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-fake-not-a-key');
    vi.stubEnv('OPENAI_BASE_URL', AZURE);
    const { provider } = await resolveProvider({
      provider: 'openai',
      model: 'o1-mini',
      promptCache: RUNNER,
    });
    // (a) red when the o1 provider is built without the resolved endpoint; (b) prints it.
    expect(provider.capabilities().endpoint).toBe('custom');
  });
});

const caps = (endpoint: 'default' | 'custom') => ({
  promptCache: 'provider' as const,
  providerId: 'openai' as const,
  jsonMode: endpoint === 'default',
  endpoint,
});
const line = (endpoint: 'default' | 'custom', promptCache: ResolvedPromptCache | undefined) =>
  promptCacheStartLine({
    caps: caps(endpoint),
    promptCache,
    moduleProviderId: undefined,
    definition: { steps: {} },
  });
const stated = (value: ResolvedPromptCache['value']): ResolvedPromptCache => ({
  value,
  source: 'stated',
  by: 'realm agent',
});

describe('caching 3-B D4 — the start line of a provider that caches by its own rules, per branch', () => {
  const KEY_LINE =
    "Caching: OpenAI caches by its own rules; Realm sends a cache key that helps repeated steps reach the same cache (OpenAI treats it as a hint). Realm cannot set OpenAI's lifetime or turn its caching off.";
  const CUSTOM_KEY_LINE =
    "Caching: this endpoint caches by its own rules; Realm sends a cache key that helps repeated steps reach the same cache (this endpoint treats it as a hint). Realm cannot set this endpoint's lifetime or turn its caching off.";
  it('each branch prints its words', () => {
    // (a) red when a branch is put back to its old words ("Realm asks OpenAI for no caching"), or a
    //     branch's condition is dropped; (b) prints every line.
    expect({
      ownDefault: line('default', RUNNER),
      ownLong: line('default', stated('long')),
      ownOff: line('default', stated('off')),
      customDefault: line('custom', RUNNER),
      customShort: line('custom', stated('short')),
      customAuto: line('custom', stated('auto')),
      customOff: line('custom', stated('off')),
      module: promptCacheStartLine({
        caps: { promptCache: 'provider', jsonMode: false },
        promptCache: undefined,
        moduleProviderId: 'module:mine.js',
        definition: { steps: {} },
      }),
    }).toEqual({
      ownDefault: KEY_LINE,
      ownLong: `${KEY_LINE} --prompt-cache long sets no lifetime on OpenAI.`,
      ownOff:
        "Caching: off; Realm sends OpenAI no cache key. OpenAI's own caching, if any, applies.",
      customDefault:
        'Caching: this endpoint caches by its own rules; Realm sends it no cache key (state --prompt-cache to send one).',
      customShort: `${CUSTOM_KEY_LINE} --prompt-cache short sets no lifetime on this endpoint.`,
      customAuto: CUSTOM_KEY_LINE,
      customOff:
        'Caching: off; Realm sends this endpoint no cache key. Its own caching, if any, applies.',
      module: 'Caching: this provider caches by its own rules.',
    });
  });
});
