// Gap 1, unit A1 — the providers' model call texts, and the one path that keeps them. Each provider
// pushes a request's text beside its usage record; run-agent joins each to its request's id and
// keeps it through one canonical form, the mask, the cut and the dedupe. These cells drive the real
// providers against mocked SDKs (each body deep-copied the moment it is sent, as
// anthropic-provider-tools-cache-899.test.ts does), then keep the texts through the same calls
// run-agent makes: `mintRequestIds`, `joinModelTexts`, `modelTextOf`.
//
// Each cell names the break that turns it red (prompts/gap1-a1-model-text-record.md) and prints
// counts, flags and the fake texts only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelText, UsageRecord } from '@sensigo/realm';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { OpenAIReasoningProvider } from './openai-reasoning-provider.js';
import { mintRequestIds, setAdditionalRedactionValues } from './agent-utils.js';
import {
  MODEL_TEXT_CAP_BYTES,
  anthropicAnsweredText,
  joinModelTexts,
  modelTextOf,
  type ModelTextReport,
} from './model-text.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

const anthropicCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: anthropicCreate } };
  }),
}));
const openaiCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: openaiCreate } } };
  }),
}));

type Block = { type: string; [key: string]: unknown };
type Body = { system?: unknown; messages: Array<Record<string, unknown>>; tools?: unknown };

/** Each request body as it was sent, deep-copied at the call. */
let sent: Body[] = [];
let script: unknown[] = [];

beforeEach(() => {
  sent = [];
  script = [];
  for (const create of [anthropicCreate, openaiCreate]) {
    create.mockReset();
    create.mockImplementation(async (body: Body) => {
      sent.push(structuredClone(body));
      const next = script.shift();
      if (next === undefined) throw new Error('the test scripted no further reply');
      return next;
    });
  }
});
afterEach(() => setAdditionalRedactionValues([]));

const USAGE = { input_tokens: 10, output_tokens: 1 };
const reply = (content: Block[]) => ({ model: 'claude-test-1', content, usage: USAGE });
const text = (t: string): Block => ({ type: 'text', text: t });
const toolUse = (id: string): Block => ({ type: 'tool_use', id, name: 'lookup', input: {} });
const VALID = text('{"answer":"done"}');
const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const lookupTool = (name = 'lookup'): ToolDefinition => ({
  id: `srv:${name}`,
  serverId: 'srv',
  name,
  description: `Look a thing up (${name})`,
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
});
/** Each tool call answers with its own text, so two tool results are two texts. */
let toolCalls = 0;
const EXECUTOR = async () => ({ content: [{ type: 'text', text: `result ${++toolCalls}` }] });

type Recorded = Extract<ModelText, { recorded: true }>;

/** What run-agent keeps of one provider call: its usage minted, its texts joined, then kept. */
function kept(result: { usage?: UsageRecord[]; modelText?: ModelTextReport[] }): Recorded {
  const minted = mintRequestIds(result.usage ?? []);
  const record = modelTextOf(joinModelTexts(minted, result.modelText), true);
  if (record?.recorded !== true) throw new Error(`no texts were kept: ${JSON.stringify(record)}`);
  return record;
}

/** A request's sent texts, rebuilt from its numbers. */
const rebuilt = (record: Recorded, index: number) =>
  record.requests[index]!.sent.map((n) => record.messages[n]!);

describe('gap 1, unit A1 — the Anthropic tool loop', () => {
  it('check 2: a 3-turn tool loop at short stores each tool result once; a reply and its re-sent copy are one message', async () => {
    script = [reply([toolUse('toolu_1')]), reply([toolUse('toolu_2')]), reply([VALID])];
    const provider = new AnthropicProvider('claude-x', {
      promptCache: { value: 'short', source: 'stated', by: 'realm agent' },
    });
    const result = await provider.callStepWithTools('prompt', [lookupTool()], EXECUTOR, {
      inputSchema: SCHEMA,
      maxToolCalls: 8,
    });
    const record = kept(result);
    const holding = (needle: string) => record.messages.filter((m) => m.text.includes(needle));
    // The instrument: the turn-2 tool result went out marked, the turn-3 copy unmarked.
    const marked = JSON.stringify(sent[1]!.messages[2]).includes('cache_control');
    const unmarked = !JSON.stringify(sent[2]!.messages[2]).includes('cache_control');
    // (1) red when the canonical function keeps `cache_control` (each tool result is stored twice);
    //     (2) prints the counts, the instrument and each request's numbers.
    expect({
      marked,
      unmarked,
      requests: record.requests.length,
      firstResult: holding('"tool_use_id":"toolu_1"').length,
      secondResult: holding('"tool_use_id":"toolu_2"').length,
      prompts: record.messages.filter((m) => m.role === 'user' && m.text === 'prompt').length,
      systems: record.messages.filter((m) => m.role === 'system').length,
      replyIsResent: record.requests[0]!.reply![0] === record.requests[1]!.sent[2],
      messages: record.messages.length,
      numbers: record.requests.map((r) => ({ sent: r.sent, reply: r.reply })),
    }).toEqual({
      marked: true,
      unmarked: true,
      requests: 3,
      firstResult: 1,
      secondResult: 1,
      prompts: 1,
      systems: 1,
      replyIsResent: true,
      messages: 7,
      numbers: [
        { sent: [0, 1], reply: [2] },
        { sent: [0, 1, 2, 3], reply: [4] },
        { sent: [0, 1, 2, 3, 4, 5], reply: [6] },
      ],
    });
  });

  it('check 5: the tool list is stored once, and each request names it by number', async () => {
    script = [reply([toolUse('toolu_1')]), reply([toolUse('toolu_2')]), reply([VALID])];
    const result = await new AnthropicProvider('claude-x').callStepWithTools(
      'prompt',
      [lookupTool()],
      EXECUTOR,
      { inputSchema: SCHEMA, maxToolCalls: 8 },
    );
    const record = kept(result);
    // (1) red when each request keeps its own copy (three lists); (2) prints the lists' count, each
    //     request's number, and whether the one list is the request's tools as sent.
    expect({
      lists: record.tools.length,
      named: record.requests.map((r) => r.tools),
      asSent: record.tools[0]?.json === JSON.stringify(sent[0]!.tools),
    }).toEqual({ lists: 1, named: [0, 0, 0], asSent: true });
  });

  it('check 10: a thinking part keeps its text without its signature, and a redacted one only its type', async () => {
    script = [
      reply([
        { type: 'thinking', thinking: 'reasoning', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'enc-1' },
        toolUse('toolu_1'),
      ]),
      reply([VALID]),
    ];
    const result = await new AnthropicProvider('claude-x').callStepWithTools(
      'prompt',
      [lookupTool()],
      EXECUTOR,
      { inputSchema: SCHEMA, maxToolCalls: 8 },
    );
    const record = kept(result);
    const first = record.messages[record.requests[0]!.reply![0]!]!.text;
    // (1) red when thinking parts are dropped (or kept whole, signature and data with them);
    //     (2) prints the reply's stored text.
    expect(first).toBe(
      '{"type":"thinking","thinking":"reasoning"}{"type":"redacted_thinking"}' +
        '{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}',
    );
  });
});

describe('gap 1, unit A1 — the OpenAI tool loop', () => {
  /** An independent rendering of an OpenAI message, by the design's words. */
  const expected = (m: Record<string, unknown>): { role: unknown; text: string } => {
    if (m['role'] === 'tool') {
      return {
        role: 'tool',
        text: JSON.stringify({
          type: 'tool_result',
          tool_call_id: m['tool_call_id'],
          content: m['content'],
        }),
      };
    }
    const calls = (m['tool_calls'] ?? []) as Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
    return {
      role: m['role'],
      text:
        (typeof m['content'] === 'string' ? m['content'] : '') +
        calls
          .map((c) =>
            JSON.stringify({
              type: 'tool_call',
              id: c.id,
              name: c.function.name,
              input: c.function.arguments,
            }),
          )
          .join(''),
    };
  };
  const callTo = (name: string, n: number) => ({
    model: 'gpt-test-1',
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: `c${n}`, type: 'function', function: { name, arguments: `{"n":${n}}` } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 1 },
  });

  it('check 9: a 3-turn loop with two different tool calls stores two assistant messages, each with its call, and every request is rebuilt exactly from its sent', async () => {
    script = [
      callTo('t', 1),
      callTo('u', 2),
      {
        model: 'gpt-test-1',
        choices: [{ message: { role: 'assistant', content: '{"answer":"done"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      },
    ];
    const result = await new OpenAIProvider('gpt-x').callStepWithTools(
      'prompt',
      [lookupTool('t'), lookupTool('u')],
      EXECUTOR,
      { inputSchema: SCHEMA, maxToolCalls: 8 },
    );
    const record = kept(result);
    const withCalls = record.messages.filter(
      (m) => m.role === 'assistant' && m.text.includes('"type":"tool_call"'),
    );
    // (1) red when the canonical function drops `tool_calls` (the two calls become one empty
    //     assistant message, and no request is rebuilt); (2) prints the calls kept and, per
    //     request, whether it is rebuilt.
    expect({
      requests: record.requests.length,
      callMessages: withCalls.map((m) => m.text),
      rebuilt: sent.map(
        (body, i) =>
          JSON.stringify(rebuilt(record, i).map(({ role, text: t }) => ({ role, text: t }))) ===
          JSON.stringify(body.messages.map(expected)),
      ),
    }).toEqual({
      requests: 3,
      callMessages: [
        '{"type":"tool_call","id":"c1","name":"t","input":"{\\"n\\":1}"}',
        '{"type":"tool_call","id":"c2","name":"u","input":"{\\"n\\":2}"}',
      ],
      rebuilt: [true, true, true],
    });
  });
});

describe('gap 1, unit A1 — mask, then cut, then each distinct text once', () => {
  /** One request, sending `sentText` as its one user message and answered with `replyText`. */
  const one = (sentText: string, replyText: string): ModelTextReport =>
    anthropicAnsweredText(
      { messages: [{ role: 'user', content: sentText }] },
      { content: [text(replyText)] },
    );
  const keep = (...reports: ModelTextReport[]): Recorded => {
    const usage = reports.map(
      (_, i) => ({ request_index: i, request_start: '2026-01-01T00:00:00.000Z' }) as UsageRecord,
    );
    return kept({ usage, modelText: reports });
  };
  const SECRET = 'FAKE-a1-declared-secret-0000';

  it("check 3 (i): a reply holding a declared secret's fake value is stored with [REDACTED], and hidden counts it", () => {
    setAdditionalRedactionValues([SECRET]);
    const record = keep(one('the prompt', `the answer holds ${SECRET} once`));
    const answer = record.messages[record.requests[0]!.reply![0]!]!;
    // (1) red when the reply is kept unmasked; (2) prints the stored reply.
    expect(answer).toEqual({
      role: 'assistant',
      text: 'the answer holds [REDACTED] once',
      hidden: 1,
    });
  });

  it('check 3 (ii): a 70 KB text is cut at 64 KB on a code-point boundary, and cut says so', () => {
    // 65,535 ASCII bytes, then 4-byte characters: the cut cannot keep the first one whole.
    const long = 'a'.repeat(MODEL_TEXT_CAP_BYTES - 1) + '\u{1F600}'.repeat(1200);
    const record = keep(one(long, 'ok'));
    const stored = record.messages[0]!;
    // (1) red when the cut splits a code point (a lone surrogate, or bytes past the cap);
    //     (2) prints the kept length, the last code unit and the cut.
    expect({
      keptBytes: Buffer.byteLength(stored.text, 'utf8'),
      lastUnit: stored.text.charCodeAt(stored.text.length - 1).toString(16),
      cut: stored.cut,
    }).toEqual({
      keptBytes: MODEL_TEXT_CAP_BYTES - 1,
      lastUnit: '61',
      cut: { kept_bytes: MODEL_TEXT_CAP_BYTES - 1, full_bytes: Buffer.byteLength(long, 'utf8') },
    });
  });

  it('check 3 (iii): a fake secret placed across the 64 KB mark is masked before the cut', () => {
    setAdditionalRedactionValues([SECRET]);
    const across = 'a'.repeat(MODEL_TEXT_CAP_BYTES - 5) + SECRET + 'b'.repeat(10_000);
    const record = keep(one(across, 'ok'));
    const stored = record.messages[0]!;
    // (1) red when the cut is made before the mask (the kept text ends with the secret's start);
    //     (2) prints the kept text's last 12 characters, whether it holds the secret's start, and
    //     the counts.
    expect({
      end: stored.text.slice(-12),
      holdsTheStart: stored.text.includes(SECRET.slice(0, 5)),
      hidden: stored.hidden,
      cut: stored.cut !== undefined,
    }).toEqual({ end: 'aaaaaaa[REDA', holdsTheStart: false, hidden: 1, cut: true });
  });

  it('check 4: two texts that share their first 64 KB are stored as two', () => {
    const head = 'c'.repeat(MODEL_TEXT_CAP_BYTES);
    const record = keep(one(`${head} first`, 'ok'), one(`${head} second`, 'ok'));
    const users = record.messages.filter((m) => m.role === 'user');
    // (1) red when the duplicate is found by the cut text (the two become one); (2) prints the
    //     count and each request's number.
    expect({ users: users.length, sent: record.requests.map((r) => r.sent) }).toEqual({
      users: 2,
      sent: [[0], [2]],
    });
  });
});

describe('gap 1, unit A1 — the single-shot send points', () => {
  const answer = {
    model: 'gpt-test-1',
    choices: [{ message: { role: 'assistant', content: '{"answer":"done"}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 1 },
  };

  it("check 1 (OpenAI's strict send): a request sent with strict keeps the system text, the prompt and the reply", async () => {
    script = [answer];
    const result = await new OpenAIProvider('gpt-x').callStepWithMeta('prompt', SCHEMA, undefined, {
      structuredOutputStrict: true,
    });
    const record = kept(result);
    const wire = sent[0]!.messages as Array<{ role: string; content: string }>;
    // (1) red when the strict send point pushes no text beside its usage record (no texts are kept);
    //     (2) prints the record's messages and whether the request was sent with strict.
    expect({
      strict: JSON.stringify(sent[0]).includes('"strict":true'),
      messages: record.messages,
      requests: record.requests.map((r) => ({ sent: r.sent, reply: r.reply })),
    }).toEqual({
      strict: true,
      messages: [
        { role: 'system', text: wire[0]!.content },
        { role: 'user', text: 'prompt' },
        { role: 'assistant', text: '{"answer":"done"}' },
      ],
      requests: [{ sent: [0, 1], reply: [2] }],
    });
  });

  it('check 1 (the reasoning provider): its one user message, the system text folded in, is kept as sent', async () => {
    script = [answer];
    const result = await new OpenAIReasoningProvider('o1-x').callStepWithMeta('prompt', SCHEMA);
    const record = kept(result);
    const wire = sent[0]!.messages as Array<{ role: string; content: string }>;
    // (1) red when the reasoning provider pushes no text beside its usage record; (2) prints the
    //     record's messages and the wire's message count.
    expect({
      wireMessages: wire.length,
      folded: wire[0]!.content.endsWith('\n\nprompt'),
      messages: record.messages,
    }).toEqual({
      wireMessages: 1,
      folded: true,
      messages: [
        { role: 'user', text: wire[0]!.content },
        { role: 'assistant', text: '{"answer":"done"}' },
      ],
    });
  });
});
