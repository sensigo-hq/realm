// anthropic-provider-tools-cache-899.test.ts — issue #899: a tool-using step asks Anthropic to
// cache at every turn. Every main turn of `callStepWithTools` marks `system` and the last block of
// the last message (a COPY: history is never written), at the drive's one lifetime; the final
// extraction carries no marker and records no ask; `off` sends what it sent before.
//
// The SDK is mocked. Each request body is deep-copied the moment it is sent (the thinking-binding
// test's practice), so a later in-place write can neither hide nor fake a marker. Each assertion
// names (a) the change that turns it red and (b) what it prints when it fails: counts, marker
// positions, key lists and setting names only — never a prompt's text, a header or a key.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

const mockCreate = vi.fn();
let baseURL: string | undefined;
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { ...(baseURL !== undefined ? { baseURL } : {}), messages: { create: mockCreate } };
  }),
}));

type Block = { type: string; [key: string]: unknown };
type Message = { role: string; content: unknown; [key: string]: unknown };
type Body = {
  system?: unknown;
  messages: Message[];
  tools?: unknown;
  tool_choice?: unknown;
  [key: string]: unknown;
};
type Reply = { model?: string; content: Block[]; usage?: Record<string, number> };

/** What each request carried, deep-copied at call time. */
let sent: Body[] = [];
/** The replies the model gives, in order; an Error entry is thrown instead of returned. */
let script: Array<Reply | Error> = [];

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockImplementation(async (body: Body) => {
    sent.push(structuredClone(body));
    const next = script.shift();
    if (next === undefined) throw new Error('the test scripted no further reply');
    if (next instanceof Error) throw next;
    return next;
  });
  sent = [];
  script = [];
  baseURL = undefined;
});

const USAGE = {
  input_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 1,
};
const reply = (content: Block[]): Reply => ({ model: 'claude-test-1', content, usage: USAGE });
const toolUse = (id: string): Block => ({ type: 'tool_use', id, name: 'lookup', input: {} });
const text = (t: string): Block => ({ type: 'text', text: t });
const thinking = (signature: string): Block => ({
  type: 'thinking',
  thinking: 'reasoning',
  signature,
});
const submit = (input: Record<string, unknown>): Block => ({
  type: 'tool_use',
  id: 'toolu_submit',
  name: '__realm_submit__',
  input,
});
const VALID = text('{"answer":"done"}');

function lookupTool(opts?: { strict?: boolean }): ToolDefinition {
  return {
    id: 'srv:lookup',
    serverId: 'srv',
    name: 'lookup',
    description: 'Look a thing up',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    ...(opts?.strict === true ? { strict: true } : {}),
  };
}
const EXECUTOR = async () => ({ content: [{ type: 'text', text: 'ok' }] });
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
};

type Setting = ConstructorParameters<typeof AnthropicProvider>[1];
const stated = (value: 'short' | 'long' | 'off'): Setting => ({
  promptCache: { value, source: 'stated', by: 'realm agent' },
});
const SHAPE = {
  short: { type: 'ephemeral' },
  long: { type: 'ephemeral', ttl: '1h' },
} as const;

/** How many `cache_control` keys the body carries, anywhere. */
const count = (body: Body): number => (JSON.stringify(body).match(/"cache_control"/g) ?? []).length;

/** Where the body's markers sit: `system.<i>`, `<message>` (on the message object),
 *  `<message>.<block>`, or `<message>.<block>.content` (inside a block's content). */
function markedAt(body: Body): string[] {
  const at: string[] = [];
  if (Array.isArray(body.system)) {
    body.system.forEach((b: Block, i) => {
      if ('cache_control' in b) at.push(`system.${i}`);
    });
  }
  body.messages.forEach((m, mi) => {
    if ('cache_control' in m) at.push(`${mi}`);
    if (!Array.isArray(m.content)) return;
    (m.content as Block[]).forEach((b, bi) => {
      if ('cache_control' in b) at.push(`${mi}.${bi}`);
      if (JSON.stringify(b['content'] ?? null).includes('cache_control'))
        at.push(`${mi}.${bi}.content`);
    });
  });
  return at;
}

/** The position the one message marker should sit at: the last block of the last message. */
function lastBlockAt(body: Body): string {
  const mi = body.messages.length - 1;
  const content = body.messages[mi]!.content;
  return `${mi}.${Array.isArray(content) ? content.length - 1 : 0}`;
}

/** Every marker's `cache_control` value, in order. */
function shapes(body: Body): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    for (const [k, x] of Object.entries(v)) {
      if (k === 'cache_control') out.push(x);
      else walk(x);
    }
  };
  walk(body);
  return out;
}

/** Five tool calls, then a valid answer: six main turns; the budget of 8 is never used up. */
async function sixMainTurns(setting: Setting): Promise<void> {
  script = [...[1, 2, 3, 4, 5].map((n) => reply([toolUse(`toolu_${n}`)])), reply([VALID])];
  await new AnthropicProvider('claude-x', setting).callStepWithTools(
    'prompt',
    [lookupTool()],
    EXECUTOR,
    { inputSchema: SCHEMA, maxToolCalls: 8 },
  );
}

/** Two tool calls use up the budget of 2, then the final extraction answers with the submit tool. */
/** #898: a provider whose `auto` choice is pending (gaps given) is settled at today's Anthropic
 *  ratios, which choose as the shipped multiples did; its records gain `prices`. */
function built(setting: Setting): AnthropicProvider {
  const provider = new AnthropicProvider('claude-x', setting);
  if (provider.isAutoChoicePending())
    provider.settleAutoChoice({
      rates: { input: 3, output: 15, cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 },
    });
  return provider;
}

async function budgetUsedUp(setting: Setting) {
  script = [
    reply([toolUse('toolu_1')]),
    reply([toolUse('toolu_2')]),
    reply([submit({ answer: 'x' })]),
  ];
  return built(setting).callStepWithTools('prompt', [lookupTool()], EXECUTOR, {
    inputSchema: SCHEMA,
    maxToolCalls: 2,
  });
}

const kindOf = (body: Body): 'main' | 'final' =>
  body.tool_choice !== undefined ? 'final' : 'main';

describe('#899 — every main turn of a tool step is marked, on a copy', () => {
  // M1. (a) red under a hand-made break that marks history's last message in place instead of the
  // copy (the markers pile up: 3 on turn 2, 6 on turn 6); (b) prints, per request, the marker count
  // and where the markers sit.
  for (const value of ['short', 'long'] as const) {
    it(`M1 (${value}) — two markers on every main turn: system's one block and the last message's last block`, async () => {
      await sixMainTurns(stated(value));
      expect(sent.map(kindOf)).toEqual(['main', 'main', 'main', 'main', 'main', 'main']);
      expect(sent.map((b) => ({ count: count(b), at: markedAt(b) }))).toEqual(
        sent.map((b) => ({ count: 2, at: ['system.0', lastBlockAt(b)] })),
      );
      // (a) red when the two markers carry different shapes, or `ttl` is sent under `short`;
      // (b) prints the shapes per request.
      expect(sent.map(shapes)).toEqual(sent.map(() => [SHAPE[value], SHAPE[value]]));
      // (a) red when `system` is not the one marked block; (b) prints its block count per request.
      expect(sent.map((b) => (Array.isArray(b.system) ? b.system.length : 'plain'))).toEqual(
        sent.map(() => 1),
      );
    });
  }

  // M2, the copy rule per level. (a) red under each of three hand-made breaks, each run once: the
  // marker written (a) on the last message object in place, (b) on its content array in place,
  // (c) on its last block in place — each leaves a stray marker on an earlier message of the next
  // request; (b) prints request index, message index and block index of each stray marker.
  it('M2 — no message other than the last carries cache_control, in any request', async () => {
    await sixMainTurns(stated('short'));
    const strays = sent.flatMap((b, ri) =>
      markedAt(b)
        .filter((p) => !p.startsWith('system.') && p !== lastBlockAt(b))
        .map((p) => `request ${ri}: ${p}`),
    );
    expect({ requests: sent.length, strays }).toEqual({ requests: 6, strays: [] });
  });

  // M3, `off` unchanged. (a) red when the `off` guard is dropped (whatever the choice is marked);
  // (b) prints the setting, and per request the marker count, the system's form and the first
  // message's content form.
  for (const [name, setting] of [
    ['off', stated('off')],
    ['no promptCache', undefined],
  ] as const) {
    it(`M3 (${name}) — no cache_control anywhere; system a plain string; the prompt still a string`, async () => {
      await sixMainTurns(setting);
      expect({
        setting: name,
        requests: sent.map((b) => ({
          count: count(b),
          system: typeof b.system,
          prompt: typeof b.messages[0]!.content,
        })),
      }).toEqual({
        setting: name,
        requests: sent.map(() => ({ count: 0, system: 'string', prompt: 'string' })),
      });
    });
  }

  // M4, the marked block per message kind. (a) red under a hand-made break that marks the FIRST
  // block of an array; (b) prints each request's last-message blocks, `*` on the marked one.
  it('M4 — the prompt string, a two-call tool result, and the #224 correction each get one marked last block', async () => {
    script = [
      reply([toolUse('toolu_1'), toolUse('toolu_2')]),
      reply([text('not json')]),
      reply([VALID]),
    ];
    await new AnthropicProvider('claude-x', stated('long')).callStepWithTools(
      'prompt',
      [lookupTool()],
      EXECUTOR,
      { inputSchema: SCHEMA, maxToolCalls: 8 },
    );
    const view = (b: Body): string[] => {
      const content = b.messages[b.messages.length - 1]!.content;
      return Array.isArray(content)
        ? (content as Block[]).map((x) => `${x.type}${'cache_control' in x ? '*' : ''}`)
        : ['string'];
    };
    expect(sent.map(view)).toEqual([['text*'], ['tool_result', 'tool_result*'], ['text*']]);
    // Turn 1: the prompt string as one marked text block. (a) red when the text is changed or the
    // shape differs; (b) prints the block's keys.
    const first = (sent[0]!.messages[0]!.content as Block[])[0]!;
    expect(Object.keys(first), 'turn 1 block keys').toEqual(['type', 'text', 'cache_control']);
    expect(first['text'] === 'prompt' && first['cache_control'], 'turn 1 block').toEqual(
      SHAPE.long,
    );
    // Turn 2: the marked tool_result is the unmarked one plus the key on the block itself; its
    // `content` is unchanged. Request 3 carries the same message unmarked (history's own object).
    // (a) red when the key goes inside `content`, or the block is otherwise changed; (b) prints
    // whether each part matches.
    const marked = (sent[1]!.messages[2]!.content as Block[])[1]!;
    const unmarked = (sent[2]!.messages[2]!.content as Block[])[1]!;
    const { cache_control, ...rest } = marked;
    expect({
      sameBlock: JSON.stringify(rest) === JSON.stringify(unmarked),
      shape: cache_control,
      contentIsString: typeof marked['content'] === 'string',
    }).toEqual({ sameBlock: true, shape: SHAPE.long, contentIsString: true });
    // Turn 3: the correction string as one marked text block. (a) red when it stays a string or
    // its text changes; (b) prints the keys and whether the text is the correction.
    const correction = (sent[2]!.messages[4]!.content as Block[])[0]!;
    expect({
      keys: Object.keys(correction),
      isCorrection: String(correction['text']).startsWith(
        'Your response did not match the required JSON schema:',
      ),
    }).toEqual({ keys: ['type', 'text', 'cache_control'], isCorrection: true });
  });

  // M5. (a) red under a hand-made break that routes the final extraction through the marker;
  // (b) prints, per request, its kind, its marker count and its system's form.
  it('M5 — the final extraction carries no cache_control and a plain system; every main turn 2', async () => {
    await budgetUsedUp(stated('short'));
    expect(sent.map((b) => [kindOf(b), count(b), typeof b.system])).toEqual([
      ['main', 2, 'object'],
      ['main', 2, 'object'],
      ['final', 0, 'string'],
    ]);
  });

  // M6, the #311 retry and `messagesFor`'s new-array branch: assistant turns carry thinking, so after
  // the strict drop every request takes the branch that builds a new array of history's own objects.
  // (a) red under a hand-made break that, ONLY when `messagesFor` returned a new array, writes the
  // marker on that array's last message in place (its elements ARE history's objects, so the marker
  // is still there in the next request); (b) prints, per request, the marker count and where the
  // markers sit.
  it('M6 — the strict-carrying turn, its #311 retry and every later turn carry exactly 2; no stale marker survives', async () => {
    script = [
      reply([thinking('sig-1'), toolUse('toolu_1')]),
      Object.assign(new Error('tools.0.custom: grammar is not compilable'), { status: 400 }),
      reply([thinking('sig-2'), toolUse('toolu_2')]),
      reply([thinking('sig-3'), toolUse('toolu_3')]),
      reply([VALID]),
    ];
    const result = await new AnthropicProvider('claude-x', stated('short')).callStepWithTools(
      'prompt',
      [lookupTool({ strict: true })],
      EXECUTOR,
      { inputSchema: SCHEMA, maxToolCalls: 8 },
    );
    expect(result.toolArgsStrictDrop?.reason).toBe('api_rejected_schema');
    expect(sent.map((b) => ({ count: count(b), at: markedAt(b) }))).toEqual(
      sent.map((b) => ({ count: 2, at: ['system.0', lastBlockAt(b)] })),
    );
    // The branch was taken: turn 1's thinking is left out of every request after the drop.
    // (a) red when the drive no longer reaches the new-array branch; (b) prints, per request,
    // whether turn 1's thinking was sent.
    expect(sent.map((b) => JSON.stringify(b.messages).includes('sig-1'))).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('#899 — what each request of the tool loop records', () => {
  const ASK_KEYS = [
    'cache_requested',
    'cache_lifetime_s',
    'cache_ttl_sent',
    'cache_requested_source',
    'cache_requested_by',
    'cache_auto',
  ] as const;
  const keysOf = (r: Record<string, unknown>): string => JSON.stringify(Object.keys(r));
  const records = (result: { usage?: unknown }): Array<Record<string, unknown>> =>
    (result.usage ?? []) as Array<Record<string, unknown>>;
  /** The single-shot request's record for the same setting and endpoint: what `requestFacts` writes. */
  async function singleShotFor(setting: Setting): Promise<Record<string, unknown>> {
    script = [reply([VALID])];
    const r = await built(setting).callStepWithMeta('prompt');
    sent = [];
    return records(r)[0]!;
  }

  // M7, per conjunct. (a) red under a hand-made break that passes `toolsRequestFacts` for the main
  // turns (every main-turn key assertion), and under one that passes `requestFacts` for the final
  // extraction (every final absence); (b) prints the record's key list.
  for (const [name, setting, keys] of [
    ['long, stated by realm agent', stated('long'), ASK_KEYS.filter((k) => k !== 'cache_auto')],
    [
      'auto with gaps, realm listen',
      {
        promptCache: {
          value: 'auto',
          source: 'runner_default',
          by: 'realm listen',
          auto: { basis: 'listen_trigger_gaps', gaps_s: [420] },
        },
      } as Setting,
      ASK_KEYS,
    ],
  ] as const) {
    it(`M7 (${name}) — main turns record the ask as requestFacts does; the final extraction records none`, async () => {
      baseURL = 'http://127.0.0.1:9';
      const single = await singleShotFor(setting);
      const result = await budgetUsedUp(setting);
      const recs = records(result);
      expect(recs.length, 'records').toBe(3);
      for (const rec of recs.slice(0, 2)) {
        for (const key of keys) {
          // One assertion per key: present, and equal to the single-shot record's value.
          expect([key in rec, rec[key]], `${key} on a main turn: ${keysOf(rec)}`).toEqual([
            true,
            single[key],
          ]);
        }
      }
      const final = recs[2]!;
      for (const key of ASK_KEYS) {
        expect(key in final, `${key} on the final extraction: ${keysOf(final)}`).toBe(false);
      }
      expect(final['model'], keysOf(final)).toBe('claude-test-1');
      expect(final['endpoint'], keysOf(final)).toBe('custom');
      expect(final['cache_split_offered'], keysOf(final)).toBe(true);
      // Under `auto`, M1's two markers hold too (M1 drives only `short` and `long`). (a) red when
      // `auto`'s choice is not carried to the main turns; (b) prints kind and count per request.
      expect(sent.map((b) => [kindOf(b), count(b)])).toEqual([
        ['main', 2],
        ['main', 2],
        ['final', 0],
      ]);
    });
  }

  // M7 under `off` (M13's `off` row reads this). (a) red under the same two breaks; (b) prints the
  // record's key list.
  it("M7 (off) — main turns record cache_requested 'off'; the final extraction records no cache_requested", async () => {
    const recs = records(await budgetUsedUp(stated('off')));
    expect(recs.length, 'records').toBe(3);
    for (const rec of recs.slice(0, 2)) {
      expect(rec['cache_requested'], keysOf(rec)).toBe('off');
    }
    expect('cache_requested' in recs[2]!, keysOf(recs[2]!)).toBe(false);
  });
});
