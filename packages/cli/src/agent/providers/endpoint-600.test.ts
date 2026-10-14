// endpoint-600.test.ts — issue #600 PR 2 (B4): `endpoint` is decided from the SDK client a request
// went through, against each SDK's own default address. These cells use the REAL SDKs: G10b only
// constructs clients (no network), and the G10 routes the mocked provider files cannot express —
// the environment variable and `--base-url` — drive a provider against an in-process stand-in on
// 127.0.0.1. Each stand-in key is a dummy. On a failing CI host a cell prints the constant, the
// client's address field, or the recorded `endpoint`: never an environment, a header or a key.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AnthropicProvider, ANTHROPIC_DEFAULT_BASE_URL } from './anthropic-provider.js';
import { OpenAIProvider, OPENAI_DEFAULT_BASE_URL } from './openai-provider.js';
import { OpenAIReasoningProvider } from './openai-reasoning-provider.js';
import { startAnthropicStub } from '../test-support/anthropic-stub.js';
import { startOpenAiStub } from '../test-support/openai-stub.js';

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('the SDK default addresses (issue #600 PR 2, G10b)', () => {
  // (a) red when either constant differs from its SDK's own default by one character; (b) prints
  // the constant and the client's `baseURL`.
  it('each constant is the address a client built with no baseURL, and no environment variable, uses', () => {
    delete process.env['ANTHROPIC_BASE_URL'];
    delete process.env['OPENAI_BASE_URL'];
    const anthropic = new Anthropic({ apiKey: 'dummy-600' });
    const openai = new OpenAI({ apiKey: 'dummy-600' });
    expect({ anthropic: anthropic.baseURL, openai: openai.baseURL }).toEqual({
      anthropic: ANTHROPIC_DEFAULT_BASE_URL,
      openai: OPENAI_DEFAULT_BASE_URL,
    });
  });

  // (a) red when the o1 provider keeps its own copy of the address instead of importing OpenAI's;
  // (b) prints whether the import is there and the literal addresses its source holds.
  it("the o1 provider imports OpenAI's constant and keeps no copy of the address", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'openai-reasoning-provider.ts'), 'utf8');
    expect({
      imports: /import \{ OPENAI_DEFAULT_BASE_URL \} from '\.\/openai-provider\.js';/.test(source),
      literals: source.match(/https:\/\/api\.openai\.com[^'"`\s]*/g) ?? [],
    }).toEqual({ imports: true, literals: [] });
  });
});

describe('endpoint through the real SDKs (issue #600 PR 2, G10)', () => {
  const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['x'],
    properties: { x: { type: 'string' } },
  };

  // (a) red when endpoint is always 'default'; (b) prints the recorded endpoint and whether the
  // stored request holds any part of the address.
  it("Anthropic through ANTHROPIC_BASE_URL: 'custom', and no part of the address is stored", async () => {
    const stub = await startAnthropicStub({ finalContent: { x: 'a' } });
    try {
      process.env['ANTHROPIC_BASE_URL'] = stub.baseUrl;
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-dummy-600-0000';
      const provider = new AnthropicProvider('claude-x', {
        promptCache: { value: '5m', source: 'stated', by: 'realm agent' },
      });
      const { usage } = await provider.callStepWithMeta('prompt', SCHEMA);
      const stored = JSON.stringify(usage);
      expect({
        endpoint: usage![0]!.endpoint,
        address: stored.includes('127.0.0.1'),
        port: stored.includes(new URL(stub.baseUrl).port),
      }).toEqual({ endpoint: 'custom', address: false, port: false });
      // The real SDK put the marker on the wire.
      expect(
        (stub.requests[0]!['system'] as Array<{ cache_control: unknown }>)[0]!.cache_control,
      ).toEqual({ type: 'ephemeral' });
    } finally {
      await stub.close();
    }
  });

  // (a) red when endpoint is always 'default'; (b) prints the recorded endpoints.
  it("OpenAI through --base-url and through OPENAI_BASE_URL, and o1 through OPENAI_BASE_URL: 'custom'", async () => {
    const stub = await startOpenAiStub({ finalContent: { x: 'a' } });
    try {
      process.env['OPENAI_API_KEY'] = 'sk-dummy-600-0000';
      delete process.env['OPENAI_BASE_URL'];
      const flag = await new OpenAIProvider('gpt-x', stub.baseUrl).callStepWithMeta(
        'prompt',
        SCHEMA,
      );
      process.env['OPENAI_BASE_URL'] = stub.baseUrl;
      const env = await new OpenAIProvider('gpt-x').callStepWithMeta('prompt', SCHEMA);
      const o1 = await new OpenAIReasoningProvider('o1-x').callStepWithMeta('prompt', SCHEMA);
      const stored = JSON.stringify([flag.usage, env.usage, o1.usage]);
      expect({
        flag: flag.usage![0]!.endpoint,
        env: env.usage![0]!.endpoint,
        o1: o1.usage![0]!.endpoint,
        address: stored.includes('127.0.0.1'),
      }).toEqual({ flag: 'custom', env: 'custom', o1: 'custom', address: false });
    } finally {
      await stub.close();
    }
  });
});
