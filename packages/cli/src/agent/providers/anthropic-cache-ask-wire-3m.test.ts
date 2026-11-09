// anthropic-cache-ask-wire-3m.test.ts — caching 3-M piece B2a: the question reaches the wire as the
// request's last top-level key. It drives the REAL SDK against the in-process stub on 127.0.0.1,
// whose requests are parsed from what arrived; a direct constructor reads `default` for the stub's
// address (A3MB2A-10). The stand-in key is a dummy. The rest of the ask's rules run on a mocked SDK
// (`anthropic-cache-ask-3m.test.ts`), because the stub's failure answers every request.
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';
import { startAnthropicStub } from '../test-support/anthropic-stub.js';

const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x'],
  properties: { x: { type: 'string' } },
};

describe('caching 3-M B2a — the question on the wire', () => {
  // Real case: a schema step at Anthropic's own address, told to ask: Anthropic reads a top-level
  // `diagnostics` object (PR3A-01). (1) red when the key goes in before `tools` or is nested;
  // (2) prints the body's keys and the key's value (null, a test value), never prompt text.
  it('1 (a) a schema step: the last key is diagnostics, with previous_message_id null, after tools and tool_choice', async () => {
    const stub = await startAnthropicStub({ finalContent: { x: 'a' } });
    try {
      process.env['ANTHROPIC_BASE_URL'] = stub.baseUrl;
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-dummy-3m-b2a-0000';
      await new AnthropicProvider('claude-x', {
        endpoint: 'default',
        promptCache: { value: 'short' },
        cacheDiagnostics: true,
      }).callStepWithMeta('prompt', SCHEMA);
      const body = stub.requests[0] as Record<string, unknown>;
      const keys = Object.keys(body);
      expect({
        last: keys.at(-1),
        afterTools: keys.indexOf('diagnostics') > keys.indexOf('tool_choice'),
        hasTools: keys.includes('tools') && keys.includes('tool_choice'),
        diagnostics: body['diagnostics'],
      }).toEqual({
        last: 'diagnostics',
        afterTools: true,
        hasTools: true,
        diagnostics: { previous_message_id: null },
      });
    } finally {
      await stub.close();
    }
  });
});
