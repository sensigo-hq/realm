// provider-conformance.test.ts — issue #313: the structural guarantee behind
// `ProviderCapabilities.toolArgsStrict`.
//
// The capability is a PROMISE about the wire: run-agent marks tools and records
// `tool_args[].strict_sent: true` for any provider declaring it. Issue #350 exists because that
// promise was once made by a provider whose wire builder ignored the marker entirely — evidence
// claimed strict was placed on a request that carried none. The guard that shipped there closed
// the instance; THIS suite closes the class, in both directions:
//
//   - every DECLARER must provably place its own strict shape on the wire, for the marked tool
//     and not for an unmarked sibling; and
//   - every provider in the source tree must appear in the table below, so a provider added to
//     the factory cannot quietly skip the check.
import { describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';
import type { LlmProvider, ToolCapableLlmProvider } from './llm-provider.js';
import { isToolCapable } from './llm-provider.js';

// Both SDKs are optional peer dependencies, so each is mocked and each provider's captured
// request is read through its own SDK's call shape.
const anthropicCreate = vi.fn();
const openaiCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: anthropicCreate } };
  }),
}));
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: openaiCreate } } };
  }),
}));

function tool(name: string, opts?: { strict?: boolean }): ToolDefinition {
  return {
    id: `srv:${name}`,
    serverId: 'srv',
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    ...(opts?.strict === true ? { strict: true } : {}),
  };
}

/**
 * One row per in-repo provider. `strictOnWire` reads the provider's OWN wire dialect out of the
 * captured request and answers "did THIS tool carry strict?" — the shapes differ deliberately
 * (Anthropic puts it on the tool object, OpenAI inside `function`), which is exactly why a
 * shared implementation was never possible and why each declarer needs its own row.
 */
interface Row {
  /** Must match the provider's source file name, for the exhaustiveness guard below. */
  sourceFile: string;
  make: () => Promise<LlmProvider>;
  /** Absent ⇒ this provider is not tool-capable; the row asserts the declaration half only. */
  drive?: (p: ToolCapableLlmProvider, tools: ToolDefinition[]) => Promise<void>;
  strictOnWire?: (toolName: string) => boolean;
}

const ROWS: Row[] = [
  {
    sourceFile: 'anthropic-provider.ts',
    make: async () => {
      const { AnthropicProvider } = await import('./anthropic-provider.js');
      anthropicCreate.mockReset();
      anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
      return new AnthropicProvider('claude-sonnet-4-5');
    },
    drive: async (p, tools) => {
      await p.callStepWithTools('prompt', tools, async () => ({}), {});
    },
    strictOnWire: (toolName) => {
      const sent = (anthropicCreate.mock.calls[0]![0].tools ?? []) as Array<{
        name: string;
        strict?: boolean;
      }>;
      return sent.find((t) => t.name === toolName)?.strict === true;
    },
  },
  {
    sourceFile: 'openai-provider.ts',
    make: async () => {
      const { OpenAIProvider } = await import('./openai-provider.js');
      openaiCreate.mockReset();
      openaiCreate.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }],
      });
      return new OpenAIProvider('gpt-4o');
    },
    drive: async (p, tools) => {
      await p.callStepWithTools('prompt', tools, async () => ({}), {});
    },
    strictOnWire: (toolName) => {
      const sent = (openaiCreate.mock.calls[0]![0].tools ?? []) as Array<{
        function: { name: string; strict?: boolean };
      }>;
      return sent.find((t) => t.function.name === toolName)?.function.strict === true;
    },
  },
  {
    sourceFile: 'openai-reasoning-provider.ts',
    make: async () => {
      const { OpenAIReasoningProvider } = await import('./openai-reasoning-provider.js');
      return new OpenAIReasoningProvider('o1-mini');
    },
    // No `drive`: this provider is not tool-capable, so there is no wire to capture. Its row
    // asserts the declaration half only — that it does NOT claim the capability.
  },
];

describe('provider conformance — toolArgsStrict is a promise about the wire (issue #313)', () => {
  for (const row of ROWS) {
    it(`${row.sourceFile}: declaring toolArgsStrict ⇒ the marker provably reaches the wire (and non-declaring ⇒ no claim)`, async () => {
      const provider = await row.make();
      const declares = provider.capabilities().toolArgsStrict === true;

      if (!declares) {
        // The declaration half. A non-declarer must also not be silently tool-capable-with-a-wire
        // that consumes the marker — if it ever gains one, it must declare and get a `drive` row.
        expect(row.drive).toBeUndefined();
        expect(isToolCapable(provider)).toBe(false);
        return;
      }

      expect(isToolCapable(provider)).toBe(true);
      expect(row.drive).toBeDefined();
      expect(row.strictOnWire).toBeDefined();

      await row.drive!(provider as ToolCapableLlmProvider, [
        tool('marked', { strict: true }),
        tool('unmarked'),
      ]);

      // The promise, both directions: the marked tool carries this provider's strict shape, and
      // the unmarked sibling does not (mixing marked with unmarked in one request is legal).
      expect(row.strictOnWire!('marked')).toBe(true);
      expect(row.strictOnWire!('unmarked')).toBe(false);
    });
  }

  // -----------------------------------------------------------------------------------------
  // Exhaustiveness — the #107 WIRED/EXCLUDED house pattern.
  // -----------------------------------------------------------------------------------------
  it('every provider source file has a table row (a new provider cannot skip the conformance check)', () => {
    // The base class + factory, deliberately excluded: it defines the capability contract rather
    // than implementing one. Any OTHER file matching the glob must be represented above.
    const EXCLUDED = ['llm-provider.ts'];
    const providersDir = dirname(fileURLToPath(import.meta.url));
    const found = readdirSync(providersDir)
      .filter((f) => f.endsWith('-provider.ts') && !f.endsWith('.test.ts'))
      .filter((f) => !EXCLUDED.includes(f));
    const covered = ROWS.map((r) => r.sourceFile);

    expect(found.length).toBeGreaterThan(0); // the glob itself must not silently match nothing
    expect([...found].sort()).toEqual([...covered].sort());
    // Guard the guard: the excluded entry must actually exist, so a rename cannot turn the
    // exclusion into a silent free pass.
    for (const excluded of EXCLUDED) {
      expect(readdirSync(providersDir)).toContain(excluded);
    }
    void join; // (path helper retained for readability of the dir resolution above)
  });
});

// =========================================================================
// issue #600 PR 2 — `ProviderCapabilities.promptCache` is a promise about the wire too: a provider
// declaring a lifetime places `cache_control` on each request it marks: a single-shot request, and
// every main turn of a tool step; one declaring `off` or nothing places none. On a failing CI host each cell prints the setting and whether the
// request carried the marker: no environment, header or key.
// =========================================================================
describe('provider conformance — promptCache is a promise about the wire (issue #600 PR 2)', () => {
  const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const settings = ['off', 'short', 'long'] as const;

  // G5′ (issue #899, in place of G5). Three main turns, then the final extraction (the tool budget
  // of 3 is used up). (a) red when the main turns are not marked (the short and long half) or when
  // the `off` guard is dropped (the off half); (b) prints the setting, the request count, each
  // request's kind and the indexes of the requests that carried the marker. Each body is read the
  // moment it is sent, so a later write cannot hide or fake a marker.
  it("G5′ — the tool loop's main turns carry cache_control under short and long, its final extraction none; under off no request does", async () => {
    const { AnthropicProvider } = await import('./anthropic-provider.js');
    const cases = [
      { value: 'short', marked: [0, 1, 2] },
      { value: 'long', marked: [0, 1, 2] },
      { value: 'off', marked: [] },
    ] as const;
    for (const c of cases) {
      const sent: string[] = [];
      anthropicCreate.mockReset();
      anthropicCreate.mockImplementation(async (body: unknown) => {
        sent.push(JSON.stringify(body));
        return sent.length <= 3
          ? { content: [{ type: 'tool_use', id: `toolu_${sent.length}`, name: 'a', input: {} }] }
          : { content: [{ type: 'text', text: '{"ok":true}' }] };
      });
      const p = new AnthropicProvider('claude-sonnet-4-5', {
        promptCache: { value: c.value, source: 'stated', by: 'realm agent' },
      });
      await p.callStepWithTools('prompt', [tool('a')], async () => ({}), {
        inputSchema: SCHEMA,
        maxToolCalls: 3,
      });
      const kinds = sent.map((body) =>
        (JSON.parse(body) as { tool_choice?: unknown }).tool_choice !== undefined
          ? 'final'
          : 'main',
      );
      const marked = sent.flatMap((body, i) => (body.includes('cache_control') ? [i] : []));
      expect({ value: c.value, requests: sent.length, kinds, marked }).toEqual({
        value: c.value,
        requests: 4,
        kinds: ['main', 'main', 'main', 'final'],
        marked: [...c.marked],
      });
    }
  });

  // G6. (a) red when the capability declares a lifetime while the request is built without it
  // (the constructor's value ignored); (b) prints, per provider and setting, the declaration and
  // whether the single-shot request carried the marker.
  it("G6 — capabilities().promptCache !== 'off' iff the single-shot request carries cache_control", async () => {
    const { AnthropicProvider } = await import('./anthropic-provider.js');
    const { OpenAIProvider } = await import('./openai-provider.js');
    const { OpenAIReasoningProvider } = await import('./openai-reasoning-provider.js');
    const cells: Array<{ name: string; make: () => LlmProvider; sent: () => unknown }> = [
      ...settings.map((value) => ({
        name: `anthropic ${value}`,
        make: () =>
          new AnthropicProvider('claude-sonnet-4-5', {
            promptCache: { value, source: 'stated' as const, by: 'realm agent' },
          }),
        sent: () => anthropicCreate.mock.calls[0]![0],
      })),
      // The lifetime unit: `auto` keeps the promise for what it chose — off, and a lifetime.
      {
        name: 'anthropic auto (chose off)',
        // #898: gaps make the choice pending; settled at today's Anthropic ratios it is off, as
        // the shipped multiples chose.
        make: () => {
          const p = new AnthropicProvider('claude-sonnet-4-5', {
            promptCache: {
              value: 'auto',
              source: 'stated',
              by: 'realm agent',
              auto: { basis: 'listen_trigger_gaps', gaps_s: [7200, 7200, 7200] },
            },
          });
          p.settleAutoChoice({
            rates: {
              input: 3,
              output: 15,
              cache_read: 0.3,
              cache_write_5m: 3.75,
              cache_write_1h: 6,
            },
          });
          return p;
        },
        sent: () => anthropicCreate.mock.calls[0]![0],
      },
      {
        name: 'anthropic auto (chose short)',
        make: () =>
          new AnthropicProvider('claude-sonnet-4-5', {
            promptCache: {
              value: 'auto',
              source: 'stated',
              by: 'realm agent',
              auto: { basis: 'no_measurement' },
            },
          }),
        sent: () => anthropicCreate.mock.calls[0]![0],
      },
      {
        name: 'openai',
        make: () => new OpenAIProvider('gpt-4o'),
        sent: () => openaiCreate.mock.calls[0]![0],
      },
      {
        name: 'openai-reasoning',
        make: () => new OpenAIReasoningProvider('o1-mini'),
        sent: () => openaiCreate.mock.calls[0]![0],
      },
    ];
    const seen: Array<{ name: string; declared: boolean; onWire: boolean }> = [];
    for (const cell of cells) {
      anthropicCreate.mockReset();
      anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
      openaiCreate.mockReset();
      openaiCreate.mockResolvedValue({ choices: [{ message: { content: '{"ok":true}' } }] });
      const p = cell.make();
      await p.callStepWithMeta('prompt', SCHEMA);
      const asked = p.capabilities().promptCache;
      seen.push({
        name: cell.name,
        declared: asked !== undefined && asked !== 'off',
        onWire: JSON.stringify(cell.sent()).includes('cache_control'),
      });
    }
    expect(seen.map((c) => [c.name, c.declared === c.onWire])).toEqual(
      seen.map((c) => [c.name, true]),
    );
    // Non-vacuity: the cells include a declarer that does place the marker.
    expect(seen.filter((c) => c.declared && c.onWire).map((c) => c.name)).toEqual([
      'anthropic short',
      'anthropic long',
      'anthropic auto (chose short)',
    ]);
  });
});
