// anthropic-auto-prices-898.test.ts — issue #898: the Anthropic provider's `auto` choice with measured
// gaps is PENDING until `settleAutoChoice` prices it from the runner's price file (S7), and the
// factory returns `settleAuto` exactly for such a provider (S8). The SDK is mocked: no real call is
// made. Beside each: (a) the change that turns it red; (b) what it prints when it fails — which reader
// ran unsettled, the provider, the setting and the gaps; never a key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoPriceInput } from '@sensigo/realm';
import { ANTHROPIC_CACHE_TIERS, AnthropicProvider } from './anthropic-provider.js';
import { resolveProvider, type PromptCacheRequest } from './llm-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

type Block = { type: string; [key: string]: unknown };
const reply = (content: Block[]) => ({
  model: 'claude-test-1',
  content,
  usage: {
    input_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 1,
  },
});
const VALID: Block = { type: 'text', text: '{"answer":"done"}' };
const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const LOOKUP: ToolDefinition = {
  id: 'srv:lookup',
  serverId: 'srv',
  name: 'lookup',
  description: 'Look a thing up',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
};
const EXECUTOR = async () => ({ content: [{ type: 'text', text: 'ok' }] });

const PENDING =
  'AnthropicProvider: the auto cache choice is not settled; call settleAutoChoice first';
/** A listen-started `auto` with measured gaps: the choice is pending. */
const pending = (gaps_s = [420, 720]): AnthropicProvider =>
  new AnthropicProvider('claude-x', {
    promptCache: {
      value: 'auto',
      source: 'runner_default',
      by: 'realm listen',
      auto: { basis: 'listen_trigger_gaps', gaps_s },
    },
  });
/** Today's Anthropic ratios on a 3-dollar input. */
const FULL: AutoPriceInput = {
  rates: { input: 3, output: 15, cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 },
};

/** The error a call threw, as its message, or `none`. */
async function thrown(call: () => unknown): Promise<string> {
  try {
    await call();
    return 'none';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

beforeEach(() => {
  mockCreate.mockReset();
});

describe('#898 S7 — a pending auto choice is read only once settled', () => {
  // (a) red when the accessor's throw is removed (each reader then reads the pending marker); (b)
  //     prints, per reader, what it threw, and how many requests reached the SDK.
  it("capabilities(), the request facts, a single-shot request and a tool step's main turn each throw the named error while the choice is pending", async () => {
    const provider = pending();
    const facts = (provider as unknown as { requestFacts(r: unknown, c: unknown): unknown })
      .requestFacts;
    const readers = {
      capabilities: await thrown(() => provider.capabilities()),
      requestFacts: await thrown(() => facts.call(provider, {}, {})),
      singleShot: await thrown(() => provider.callStep('prompt', SCHEMA)),
      toolMainTurn: await thrown(() =>
        provider.callStepWithTools('prompt', [LOOKUP], EXECUTOR, { inputSchema: SCHEMA }),
      ),
    };
    expect({ readers, requestsSent: mockCreate.mock.calls.length }).toEqual({
      readers: {
        capabilities: PENDING,
        requestFacts: PENDING,
        singleShot: PENDING,
        toolMainTurn: PENDING,
      },
      requestsSent: 0,
    });
  });

  // (a) red when a second settle, or a settle with nothing pending, is accepted; (b) prints what
  //     each threw.
  it('settleAutoChoice throws on a second call, and when nothing is pending (short; auto with no kept gap)', async () => {
    const twice = pending();
    twice.settleAutoChoice(FULL);
    const settledShort = new AnthropicProvider('claude-x', {
      promptCache: { value: 'short', source: 'stated', by: 'realm agent' },
    });
    const noGap = pending([]);
    expect({
      second: await thrown(() => twice.settleAutoChoice(FULL)),
      short: await thrown(() => settledShort.settleAutoChoice(FULL)),
      noGap: await thrown(() => noGap.settleAutoChoice(FULL)),
      pendingAfter: [
        twice.isAutoChoicePending(),
        settledShort.isAutoChoicePending(),
        noGap.isAutoChoicePending(),
      ],
    }).toEqual({
      second: expect.stringContaining('no auto cache choice is pending'),
      short: expect.stringContaining('no auto cache choice is pending'),
      noGap: expect.stringContaining('no auto cache choice is pending'),
      pendingAfter: [false, false, false],
    });
  });

  // (a) red when the outcome's `prices` does not reach the record, or reaches the tool step's last
  //     request; (b) prints the records' `cache_auto` and their key lists.
  it("after the settle, every request record's cache_auto.prices is the outcome's, and the tool step's last request records no cache_auto", async () => {
    const single = pending([10, 600, 7200]);
    const outcome = single.settleAutoChoice({
      rates: { input: 3, output: 15, cache_read: 0.3, cache_write_5m: 3.75 },
    });
    mockCreate.mockResolvedValueOnce(reply([VALID]));
    const one = await single.callStepWithMeta('prompt', SCHEMA);

    const tools = pending([420]);
    tools.settleAutoChoice({ cause: 'no_file' });
    mockCreate
      .mockResolvedValueOnce(
        reply([{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }]),
      )
      .mockResolvedValueOnce(
        reply([{ type: 'tool_use', id: 'toolu_2', name: 'lookup', input: {} }]),
      )
      .mockResolvedValueOnce(
        reply([
          {
            type: 'tool_use',
            id: 'toolu_submit',
            name: '__realm_submit__',
            input: { answer: 'x' },
          },
        ]),
      );
    const loop = await tools.callStepWithTools('prompt', [LOOKUP], EXECUTOR, {
      inputSchema: SCHEMA,
      maxToolCalls: 2,
    });
    const autoOf = (records: unknown): unknown[] =>
      ((records ?? []) as Array<Record<string, unknown>>).map((r) => r['cache_auto']);
    expect({
      outcome,
      single: autoOf(one.usage),
      tools: autoOf(loop.usage),
    }).toEqual({
      outcome: {
        choice: 'short',
        prices: { from: 'economics', excluded: ['long'], missing: ['cache_write_1h'] },
      },
      single: [
        {
          basis: 'listen_trigger_gaps',
          gaps_s: [10, 600, 7200],
          prices: { from: 'economics', excluded: ['long'], missing: ['cache_write_1h'] },
        },
      ],
      tools: [
        { basis: 'listen_trigger_gaps', gaps_s: [420], prices: { from: 'none', cause: 'no_file' } },
        { basis: 'listen_trigger_gaps', gaps_s: [420], prices: { from: 'none', cause: 'no_file' } },
        undefined,
      ],
    });
  });
});

describe('#898 S8 — resolveProvider returns settleAuto exactly for Anthropic, auto and kept gaps', () => {
  let saved: { openai: string | undefined; anthropic: string | undefined };
  beforeEach(() => {
    saved = { openai: process.env['OPENAI_API_KEY'], anthropic: process.env['ANTHROPIC_API_KEY'] };
    process.env['OPENAI_API_KEY'] = 'k-898';
    process.env['ANTHROPIC_API_KEY'] = 'k-898';
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    if (saved.openai === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = saved.openai;
    if (saved.anthropic === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = saved.anthropic;
    vi.restoreAllMocks();
  });

  const cache = (value: PromptCacheRequest['value'], gaps_s?: number[]): PromptCacheRequest => ({
    value,
    source: 'runner_default',
    by: 'realm listen',
    ...(value === 'auto'
      ? { auto: { basis: 'listen_trigger_gaps' as const, gaps_s: gaps_s ?? [] } }
      : {}),
  });

  // (a) red when settleAuto is always returned, or never; (b) prints the provider, the setting, the
  //     gaps and whether settleAuto came back.
  it('present for anthropic + auto + gaps [420]; absent for openai, for off, short and long, and for auto with no kept gap', async () => {
    const cases: Array<[string, 'openai' | 'anthropic', string, PromptCacheRequest]> = [
      ['anthropic auto [420]', 'anthropic', 'claude-x', cache('auto', [420])],
      ['openai auto [420]', 'openai', 'gpt-x', cache('auto', [420])],
      ['anthropic off', 'anthropic', 'claude-x', cache('off')],
      ['anthropic short', 'anthropic', 'claude-x', cache('short')],
      ['anthropic long', 'anthropic', 'claude-x', cache('long')],
      ['anthropic auto []', 'anthropic', 'claude-x', cache('auto', [])],
    ];
    const got = await Promise.all(
      cases.map(async ([name, provider, model, promptCache]) => {
        const r = await resolveProvider({ provider, model, promptCache });
        return [name, r.settleAuto !== undefined, r.provider.constructor.name] as const;
      }),
    );
    expect(got).toEqual([
      ['anthropic auto [420]', true, 'AnthropicProvider'],
      ['openai auto [420]', false, 'OpenAIProvider'],
      ['anthropic off', false, 'AnthropicProvider'],
      ['anthropic short', false, 'AnthropicProvider'],
      ['anthropic long', false, 'AnthropicProvider'],
      ['anthropic auto []', false, 'AnthropicProvider'],
    ]);
  });
});

describe('#898 B.1 — the provider ships its lifetimes, never a price', () => {
  // (a) red when a read or write multiple returns to the constant; (b) prints the constant.
  it('ANTHROPIC_CACHE_TIERS holds the two lifetimes and nothing else', () => {
    expect(ANTHROPIC_CACHE_TIERS).toEqual({
      short: { lifetime_s: 300 },
      long: { lifetime_s: 3600 },
    });
  });
});
