// resolve-provider-676.test.ts — issue #676: realm has no default model.
//
// `checkProviderFlags` is the one place the refusal sentences are written; `resolveProvider`
// throws its message, and `realm agent` adds the closing sentence (pinned through the built CLI in
// commands/no-default-model-676.test.ts). `listenModelRefusal` is `realm listen`'s whole line.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkProviderFlags,
  listenModelRefusal,
  resolveProvider,
  type ProviderFlags,
} from './llm-provider.js';

const ANTHROPIC_LIST = 'https://platform.claude.com/docs/en/models/overview';
const OPENAI_LIST = 'https://developers.openai.com/api/docs/models';
const LEAD = '--model is required: realm has no default model.';

const MSG = {
  baseUrl: `${LEAD} Name the model the service at --base-url offers.`,
  namedAnthropic: `${LEAD} Name an Anthropic model; Anthropic lists them at ${ANTHROPIC_LIST}.`,
  namedOpenai: `${LEAD} Name an OpenAI model; OpenAI lists them at ${OPENAI_LIST}.`,
  onlyAnthropic:
    `${LEAD} ANTHROPIC_API_KEY is set, so the provider is Anthropic; name one of its models ` +
    `(Anthropic lists them at ${ANTHROPIC_LIST}).`,
  onlyOpenai:
    `${LEAD} OPENAI_API_KEY is set, so the provider is OpenAI; name one of its models ` +
    `(OpenAI lists them at ${OPENAI_LIST}).`,
  bothKeys:
    `${LEAD} Both OPENAI_API_KEY and ANTHROPIC_API_KEY are set, so the provider is OpenAI; name one ` +
    `of its models (OpenAI lists them at ${OPENAI_LIST}), or choose Anthropic with --provider anthropic.`,
  anthropicKeyMissing:
    '--provider anthropic was given, but ANTHROPIC_API_KEY is not set or is empty (only OPENAI_API_KEY is set). ' +
    'Set ANTHROPIC_API_KEY, or use --provider openai with an OpenAI model.',
  openaiKeyMissing:
    '--provider openai was given, but OPENAI_API_KEY is not set or is empty (only ANTHROPIC_API_KEY is set). ' +
    'Set OPENAI_API_KEY, or use --provider anthropic with an Anthropic model.',
  noKey: 'realm agent requires an LLM API key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.',
  baseUrlAnthropic:
    '--base-url is only supported with --provider openai (or OpenAI-compatible endpoints). ' +
    'For Anthropic, configure the endpoint via the ANTHROPIC_BASE_URL environment variable.',
};

const OPENAI = { OPENAI_API_KEY: 'k-openai', ANTHROPIC_API_KEY: undefined };
const ANTHROPIC = { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: 'k-anthropic' };
const BOTH = { OPENAI_API_KEY: 'k-openai', ANTHROPIC_API_KEY: 'k-anthropic' };

function flags(overrides: Partial<ProviderFlags> & Pick<ProviderFlags, 'env'>): ProviderFlags {
  return { provider: undefined, model: undefined, baseUrl: undefined, ...overrides };
}

/** The message `resolveProvider` throws (or `undefined` when it does not). */
async function thrownBy(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

describe('resolveProvider — no default model (issue #676)', () => {
  let saved: { openai: string | undefined; anthropic: string | undefined };
  const setKeys = (keys: { OPENAI_API_KEY?: string; ANTHROPIC_API_KEY?: string }): void => {
    delete process.env['OPENAI_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    if (keys.OPENAI_API_KEY !== undefined) process.env['OPENAI_API_KEY'] = keys.OPENAI_API_KEY;
    if (keys.ANTHROPIC_API_KEY !== undefined)
      process.env['ANTHROPIC_API_KEY'] = keys.ANTHROPIC_API_KEY;
  };
  beforeEach(() => {
    saved = {
      openai: process.env['OPENAI_API_KEY'],
      anthropic: process.env['ANTHROPIC_API_KEY'],
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    if (saved.openai === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = saved.openai;
    if (saved.anthropic === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = saved.anthropic;
    vi.restoreAllMocks();
  });

  // ---- the six model refusals ----------------------------------------------------------------
  it('--base-url given, no --model → the --base-url sentence', async () => {
    setKeys({ OPENAI_API_KEY: 'k' });
    expect(
      await thrownBy(() => resolveProvider('openai', undefined, 'https://compat.example')),
    ).toBe(MSG.baseUrl);
  });

  it('--provider anthropic, no --model → name an Anthropic model', async () => {
    setKeys({ ANTHROPIC_API_KEY: 'k' });
    expect(await thrownBy(() => resolveProvider('anthropic', undefined))).toBe(MSG.namedAnthropic);
  });

  it('--provider openai, no --model → name an OpenAI model', async () => {
    setKeys({ OPENAI_API_KEY: 'k' });
    expect(await thrownBy(() => resolveProvider('openai', undefined))).toBe(MSG.namedOpenai);
  });

  it('no --provider, only ANTHROPIC_API_KEY → the provider is Anthropic', async () => {
    setKeys({ ANTHROPIC_API_KEY: 'k' });
    expect(await thrownBy(() => resolveProvider(undefined, undefined))).toBe(MSG.onlyAnthropic);
  });

  it('no --provider, only OPENAI_API_KEY → the provider is OpenAI', async () => {
    setKeys({ OPENAI_API_KEY: 'k' });
    expect(await thrownBy(() => resolveProvider(undefined, undefined))).toBe(MSG.onlyOpenai);
  });

  it('no --provider, both keys → the provider is OpenAI, or choose Anthropic', async () => {
    setKeys({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' });
    expect(await thrownBy(() => resolveProvider(undefined, undefined))).toBe(MSG.bothKeys);
  });

  // ---- a blank --model counts as missing (the same rule as a key) ---------------------------
  it('an empty --model counts as missing', async () => {
    setKeys({ ANTHROPIC_API_KEY: 'k' });
    expect(await thrownBy(() => resolveProvider('anthropic', ''))).toBe(MSG.namedAnthropic);
  });

  it('a --model of only spaces counts as missing', async () => {
    setKeys({ ANTHROPIC_API_KEY: 'k' });
    expect(await thrownBy(() => resolveProvider('anthropic', '   '))).toBe(MSG.namedAnthropic);
  });

  // ---- a key that is empty or holds only spaces counts as not set ----------------------------
  it('an empty ANTHROPIC_API_KEY beside an OpenAI key → the "only OPENAI_API_KEY" message', async () => {
    setKeys({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: '' });
    expect(await thrownBy(() => resolveProvider(undefined, undefined))).toBe(MSG.onlyOpenai);
  });

  it('an ANTHROPIC_API_KEY of only spaces beside an OpenAI key → the "only OPENAI_API_KEY" message', async () => {
    setKeys({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: '   ' });
    expect(await thrownBy(() => resolveProvider(undefined, undefined))).toBe(MSG.onlyOpenai);
  });

  it('both keys empty → the no-key message', async () => {
    setKeys({ OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' });
    expect(await thrownBy(() => resolveProvider(undefined, 'any-model'))).toBe(MSG.noKey);
  });

  // ---- a named provider whose own key is not set ---------------------------------------------
  it('--provider anthropic with only OPENAI_API_KEY → the named-provider key message', async () => {
    setKeys({ OPENAI_API_KEY: 'k' });
    expect(await thrownBy(() => resolveProvider('anthropic', 'claude-x'))).toBe(
      MSG.anthropicKeyMissing,
    );
  });

  it('--provider openai with only ANTHROPIC_API_KEY → the named-provider key message', async () => {
    setKeys({ ANTHROPIC_API_KEY: 'k' });
    expect(await thrownBy(() => resolveProvider('openai', 'gpt-x'))).toBe(MSG.openaiKeyMissing);
  });

  // ---- a given model builds the provider with that model -------------------------------------
  it('with --model given, the Anthropic provider is built with that model', async () => {
    setKeys({ ANTHROPIC_API_KEY: 'k' });
    const p = await resolveProvider(undefined, 'claude-given-676');
    expect(p.capabilities().providerId).toBe('anthropic');
    expect((p as unknown as Record<string, unknown>)['model']).toBe('claude-given-676');
  });

  it('with --model given, the OpenAI provider is built with that model', async () => {
    setKeys({ OPENAI_API_KEY: 'k' });
    const p = await resolveProvider('openai', 'gpt-given-676');
    expect(p.capabilities().providerId).toBe('openai');
    expect((p as unknown as Record<string, unknown>)['model']).toBe('gpt-given-676');
  });

  it('the o1 route is still taken for o1-mini', async () => {
    setKeys({ OPENAI_API_KEY: 'k' });
    const p = await resolveProvider('openai', 'o1-mini');
    expect(p.capabilities().providerId).toBe('openai-reasoning');
  });

  it('source check: llm-provider.ts names neither old default', () => {
    const src = readFileSync(fileURLToPath(new URL('./llm-provider.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain("'gpt-4o'");
    expect(src).not.toContain("'claude-sonnet-4-5'");
  });
});

describe('checkProviderFlags — on its own (issue #676)', () => {
  it('no --model: the six rows', () => {
    expect(
      checkProviderFlags(flags({ env: OPENAI, provider: 'openai', baseUrl: 'https://x' })),
    ).toEqual({ ok: false, message: MSG.baseUrl });
    expect(checkProviderFlags(flags({ env: ANTHROPIC, provider: 'anthropic' }))).toEqual({
      ok: false,
      message: MSG.namedAnthropic,
    });
    expect(checkProviderFlags(flags({ env: OPENAI, provider: 'openai' }))).toEqual({
      ok: false,
      message: MSG.namedOpenai,
    });
    expect(checkProviderFlags(flags({ env: ANTHROPIC }))).toEqual({
      ok: false,
      message: MSG.onlyAnthropic,
    });
    expect(checkProviderFlags(flags({ env: OPENAI }))).toEqual({
      ok: false,
      message: MSG.onlyOpenai,
    });
    expect(checkProviderFlags(flags({ env: BOTH }))).toEqual({ ok: false, message: MSG.bothKeys });
  });

  it('a blank --model counts as missing', () => {
    expect(checkProviderFlags(flags({ env: ANTHROPIC, model: ' \t ' }))).toEqual({
      ok: false,
      message: MSG.onlyAnthropic,
    });
  });

  it('the two named-provider key rows', () => {
    expect(checkProviderFlags(flags({ env: OPENAI, provider: 'anthropic', model: 'm' }))).toEqual({
      ok: false,
      message: MSG.anthropicKeyMissing,
    });
    expect(checkProviderFlags(flags({ env: ANTHROPIC, provider: 'openai', model: 'm' }))).toEqual({
      ok: false,
      message: MSG.openaiKeyMissing,
    });
  });

  it('order: a named provider without its key AND no --model → the key message', () => {
    expect(checkProviderFlags(flags({ env: OPENAI, provider: 'anthropic' }))).toEqual({
      ok: false,
      message: MSG.anthropicKeyMissing,
    });
  });

  it('an empty key counts as not set', () => {
    expect(
      checkProviderFlags(
        flags({ env: { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: 'k' }, model: 'm' }),
      ),
    ).toEqual({ ok: true, provider: 'anthropic', model: 'm' });
  });

  it('a named provider whose key is empty or only spaces → the named-provider key message', () => {
    expect(
      checkProviderFlags(
        flags({
          env: { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: '   ' },
          provider: 'anthropic',
          model: 'm',
        }),
      ),
    ).toEqual({ ok: false, message: MSG.anthropicKeyMissing });
    expect(
      checkProviderFlags(
        flags({
          env: { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: 'k' },
          provider: 'openai',
          model: 'm',
        }),
      ),
    ).toEqual({ ok: false, message: MSG.openaiKeyMissing });
  });

  it('the no-key and --base-url refusals', () => {
    expect(
      checkProviderFlags(
        flags({ env: { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, model: 'm' }),
      ),
    ).toEqual({ ok: false, message: MSG.noKey });
    expect(checkProviderFlags(flags({ env: ANTHROPIC, baseUrl: 'https://x', model: 'm' }))).toEqual(
      { ok: false, message: MSG.baseUrlAnthropic },
    );
  });

  it('flags that pass: the chosen provider and the given model', () => {
    expect(checkProviderFlags(flags({ env: ANTHROPIC, model: 'claude-a' }))).toEqual({
      ok: true,
      provider: 'anthropic',
      model: 'claude-a',
    });
    expect(checkProviderFlags(flags({ env: OPENAI, model: 'gpt-a' }))).toEqual({
      ok: true,
      provider: 'openai',
      model: 'gpt-a',
    });
    expect(checkProviderFlags(flags({ env: BOTH, model: 'gpt-b' }))).toEqual({
      ok: true,
      provider: 'openai',
      model: 'gpt-b',
    });
    expect(
      checkProviderFlags(flags({ env: BOTH, provider: 'anthropic', model: 'claude-b' })),
    ).toEqual({ ok: true, provider: 'anthropic', model: 'claude-b' });
    expect(
      checkProviderFlags(flags({ env: OPENAI, baseUrl: 'https://compat', model: 'deepseek-x' })),
    ).toEqual({ ok: true, provider: 'openai', model: 'deepseek-x' });
  });
});

describe('listenModelRefusal — realm listen without --model (issue #676)', () => {
  it('--provider anthropic', () => {
    expect(listenModelRefusal('anthropic')).toBe(
      'Error: --model is required: realm has no default model, and realm listen starts realm agent --provider anthropic for every run. ' +
        `Name an Anthropic model; Anthropic lists them at ${ANTHROPIC_LIST}. Nothing was started.`,
    );
  });

  it('--provider openai', () => {
    expect(listenModelRefusal('openai')).toBe(
      'Error: --model is required: realm has no default model, and realm listen starts realm agent --provider openai for every run. ' +
        `Name an OpenAI model; OpenAI lists them at ${OPENAI_LIST}. Nothing was started.`,
    );
  });

  it('no --provider', () => {
    expect(listenModelRefusal(undefined)).toBe(
      'Error: --model is required: realm has no default model, and realm listen starts realm agent for every run. ' +
        'Each one picks its provider from the API key it finds (OpenAI when both are set; choose one with --provider). ' +
        `Anthropic lists its models at ${ANTHROPIC_LIST}; OpenAI at ${OPENAI_LIST}. Nothing was started.`,
    );
  });
});
