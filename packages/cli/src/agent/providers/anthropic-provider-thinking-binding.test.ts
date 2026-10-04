// anthropic-provider-thinking-binding.test.ts — issue #677: a thinking block travels only with the
// list of tools its turn was made under.
//
// Anthropic binds every `thinking` / `redacted_thinking` block to the `tools` of the request that
// produced it, and refuses a later request that carries the block under a different `tools` list.
// The SDK mock below ENFORCES that rule — a model of the API built from the live checks (#677
// registry T2–T7): the key of a request is `JSON.stringify(body.tools ?? null)`; `tool_choice`,
// the system prompt and `max_tokens` are not part of it (T5); the binding is per turn (T7); an
// assistant turn sent as `content: []` is accepted (T6). No real API calls are made.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';
import type { LlmClock } from './agent-utils.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

type Block = { type: string; [key: string]: unknown };
type Message = { role: string; content: unknown };
type Body = { messages: Message[]; tools?: unknown; tool_choice?: unknown; [key: string]: unknown };
type Reply = { content: Block[]; stop_reason?: string };

/** The live 400 (#677 registry T2), verbatim. */
const BINDING_400 =
  '400 invalid_request_error — messages.1.content.0: Invalid `signature` in `thinking` block. ' +
  'The block is bound to a different conversation. Remove the block, or set ' +
  '`thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the ' +
  '`thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header. The `tools` list ' +
  'differs from the one this block was created with.';

/** What each request carried, deep-copied at call time: `messages` is a shared array that later
 *  pushes grow, so reading `mock.calls` afterwards does not show what was sent. */
let sent: Body[] = [];
/** The replies the model gives, in order; an Error entry is thrown instead of returned. */
let script: Array<Reply | Error> = [];
/** Each thinking block (by its id) → the key of the request whose reply issued it. */
let issuedUnder = new Map<string, string>();

/** A thinking block's identity: `thinking` by its signature, `redacted_thinking` by its data. */
function blockId(block: unknown): string | undefined {
  if (block === null || typeof block !== 'object') return undefined;
  const b = block as Block;
  if (b.type === 'thinking') return `thinking:${String(b['signature'])}`;
  if (b.type === 'redacted_thinking') return `redacted_thinking:${String(b['data'])}`;
  return undefined;
}

const requestKey = (body: Body): string => JSON.stringify(body.tools ?? null);

/** The API model: refuses any thinking block sent under a key other than the one it was issued
 *  under; otherwise returns the next scripted reply and records the blocks it issues. */
async function apiModel(body: Body): Promise<Reply> {
  sent.push(structuredClone(body));
  const key = requestKey(body);
  for (const message of body.messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const id = blockId(block);
      if (id === undefined) continue;
      const issued = issuedUnder.get(id);
      if (issued !== key) {
        throw Object.assign(
          new Error(
            `${BINDING_400}\n${id} was issued under ${issued ?? '(never issued)'} and sent under ${key}`,
          ),
          { status: 400 },
        );
      }
    }
  }
  const next = script.shift();
  if (next === undefined) throw new Error('the test scripted no further reply');
  if (next instanceof Error) throw next;
  for (const block of next.content) {
    const id = blockId(block);
    if (id !== undefined) issuedUnder.set(id, key);
  }
  return next;
}

function reset(): void {
  mockCreate.mockReset();
  mockCreate.mockImplementation((body: Body) => apiModel(body));
  sent = [];
  script = [];
  issuedUnder = new Map();
}

const thinking = (signature: string): Block => ({
  type: 'thinking',
  thinking: 'reasoning',
  signature,
});
const redacted = (data: string): Block => ({ type: 'redacted_thinking', data });
const text = (t: string): Block => ({ type: 'text', text: t });
const toolUse = (id: string): Block => ({ type: 'tool_use', id, name: 'lookup', input: {} });
const submit = (input: Record<string, unknown>): Block => ({
  type: 'tool_use',
  id: 'toolu_submit',
  name: '__realm_submit__',
  input,
});

/** The step's one tool; `strict` is opt-in exactly as run-agent sets it (#311). */
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

const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const NOOP_EXECUTOR = async (): Promise<Record<string, unknown>> => ({});
const CLOCK: LlmClock = { ceilingMs: 60_000, declaredPerAttemptMs: 30_000 };
const withClock = (clock?: LlmClock): { llmClock?: LlmClock } =>
  clock !== undefined ? { llmClock: clock } : {};

const provider = (): AnthropicProvider => new AnthropicProvider('claude-sonnet-5-5');

/** Every thinking block the request's assistant turns carry, by id, in order. */
function thinkingIds(body: Body): string[] {
  const ids: string[] = [];
  for (const message of body.messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const id = blockId(block);
      if (id !== undefined) ids.push(id);
    }
  }
  return ids;
}

const toolsOf = (body: Body): Array<{ name: string; strict?: boolean }> =>
  (body.tools ?? []) as Array<{ name: string; strict?: boolean }>;

/** The body handed to the SDK on call N — the live object, not the copy. */
const bodyOf = (i: number): Body => (mockCreate.mock.calls[i] as [Body])[0];

/** Cell 1's scenario: the tool budget runs out after two thinking turns, a schema exists. */
async function budgetAfterThinking(clock?: LlmClock): Promise<void> {
  script = [
    { content: [thinking('sig-1'), text('Let me look.'), toolUse('toolu_1')] },
    { content: [thinking('sig-2'), toolUse('toolu_2')] },
    { content: [submit({ answer: 'done' })] },
  ];
  const result = await provider().callStepWithTools('prompt', [lookupTool()], NOOP_EXECUTOR, {
    inputSchema: SCHEMA,
    maxToolCalls: 2,
    ...withClock(clock),
  });
  expect(result.output).toEqual({ answer: 'done' });
  expect(sent).toHaveLength(3);
  // Control half: a main request under the same list keeps the earlier turn's thinking.
  expect(thinkingIds(sent[1]!)).toEqual(['thinking:sig-1']);
  // The extraction offers only the answer tool — a different list — and carries no thinking.
  expect(toolsOf(sent[2]!).map((t) => t.name)).toEqual(['__realm_submit__']);
  expect(thinkingIds(sent[2]!)).toEqual([]);
}

/** Cell 4's scenario: the #311 drop happens after a thinking turn. */
async function strictDropAfterThinking(clock?: LlmClock): Promise<void> {
  script = [
    { content: [thinking('sig-1'), toolUse('toolu_1')] },
    Object.assign(new Error('tools.0.custom: grammar is not compilable'), { status: 400 }),
    { content: [thinking('sig-2'), toolUse('toolu_2')] },
    { content: [text('{"answer":"done"}')] },
  ];
  const result = await provider().callStepWithTools(
    'prompt',
    [lookupTool({ strict: true })],
    NOOP_EXECUTOR,
    { ...withClock(clock) },
  );
  expect(sent).toHaveLength(4);
  // Turn 2's first attempt is under the strict list, the list turn 1 was made under.
  expect(toolsOf(sent[1]!)[0]).toHaveProperty('strict', true);
  expect(thinkingIds(sent[1]!)).toContain('thinking:sig-1');
  // The retry sends the stripped list, so turn 1's thinking stays out of it.
  expect(toolsOf(sent[2]!)[0]).not.toHaveProperty('strict');
  expect(thinkingIds(sent[2]!)).not.toContain('thinking:sig-1');
  // Turn 3 is under the stripped list too: the retry's thinking stays, turn 1's does not (T7).
  expect(thinkingIds(sent[3]!)).toContain('thinking:sig-2');
  expect(thinkingIds(sent[3]!)).not.toContain('thinking:sig-1');
  expect(result.toolArgsStrictDrop?.reason).toBe('api_rejected_schema');
}

describe('AnthropicProvider.callStepWithTools — thinking stays with its list of tools (issue #677)', () => {
  beforeEach(() => {
    reset();
  });

  it('cell 1 — tool budget exhausted after thinking turns (schema): the extraction carries no thinking', async () => {
    await budgetAfterThinking();
  });

  it('cell 2 — tool budget exhausted (no schema): the extraction sends no tools, tool_choice none, no thinking', async () => {
    script = [
      { content: [thinking('sig-1'), toolUse('toolu_1')] },
      { content: [text('{"answer":"done"}')] },
    ];
    const result = await provider().callStepWithTools('prompt', [lookupTool()], NOOP_EXECUTOR, {
      maxToolCalls: 1,
    });
    expect(result.output).toEqual({ answer: 'done' });
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toHaveProperty('tools');
    expect(sent[1]!.tool_choice).toEqual({ type: 'none' });
    expect(thinkingIds(sent[1]!)).toEqual([]);
  });

  it('cell 3 — correction budget exhausted: the extraction carries no thinking, the correction turn keeps its text', async () => {
    script = [
      { content: [thinking('sig-1'), text('not json')] },
      { content: [submit({ answer: 'done' })] },
    ];
    const result = await provider().callStepWithTools('prompt', [lookupTool()], NOOP_EXECUTOR, {
      inputSchema: SCHEMA,
      maxToolCalls: 1,
    });
    expect(result.output).toEqual({ answer: 'done' });
    expect(sent).toHaveLength(2);
    expect(thinkingIds(sent[1]!)).toEqual([]);
    expect(sent[1]!.messages[1]).toEqual({ role: 'assistant', content: [text('not json')] });
  });

  it('cell 4 — a #311 strict drop after a thinking turn: the retry and the later turns leave turn 1 thinking out', async () => {
    await strictDropAfterThinking();
  });

  it('cell 5 — control: no drop, three thinking turns — every main request carries every block, one shared messages array', async () => {
    const r1: Reply = { content: [thinking('sig-1'), toolUse('toolu_1')] };
    const r2: Reply = { content: [thinking('sig-2'), toolUse('toolu_2')] };
    const r3: Reply = { content: [redacted('enc-1'), toolUse('toolu_3')] };
    script = [r1, r2, r3, { content: [text('{"answer":"done"}')] }];
    await provider().callStepWithTools('prompt', [lookupTool()], NOOP_EXECUTOR, {});
    expect(sent).toHaveLength(4);
    expect(sent[1]!.messages[1]!.content).toEqual(r1.content);
    expect(sent[2]!.messages[1]!.content).toEqual(r1.content);
    expect(sent[2]!.messages[3]!.content).toEqual(r2.content);
    expect(sent[3]!.messages[1]!.content).toEqual(r1.content);
    expect(sent[3]!.messages[3]!.content).toEqual(r2.content);
    expect(sent[3]!.messages[5]!.content).toEqual(r3.content);
    for (const i of [1, 2, 3]) expect(bodyOf(i).messages).toBe(bodyOf(0).messages);
  });

  it('cell 6 — control: a correction turn with thinking, then a main turn under the same list keeps that thinking', async () => {
    script = [
      { content: [thinking('sig-1'), text('not json')] },
      { content: [text('{"answer":"done"}')] },
    ];
    const result = await provider().callStepWithTools('prompt', [lookupTool()], NOOP_EXECUTOR, {});
    expect(result.output).toEqual({ answer: 'done' });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.messages[1]).toEqual({
      role: 'assistant',
      content: [thinking('sig-1'), text('not json')],
    });
  });

  it('cell 7 — redacted_thinking: the extraction carries neither kind of block', async () => {
    script = [
      { content: [thinking('sig-1'), redacted('enc-1'), toolUse('toolu_1')] },
      { content: [submit({ answer: 'done' })] },
    ];
    const result = await provider().callStepWithTools('prompt', [lookupTool()], NOOP_EXECUTOR, {
      inputSchema: SCHEMA,
      maxToolCalls: 1,
    });
    expect(result.output).toEqual({ answer: 'done' });
    expect(thinkingIds(sent[1]!)).toEqual([]);
    expect(sent[1]!.messages[1]!.content).toEqual([toolUse('toolu_1')]);
  });

  it('cell 8 — a step with no tools: the extraction KEEPS the thinking with no schema (same key) and removes it with one', async () => {
    // Keep half (a control): no tools on either side, only tool_choice differs (T5).
    script = [
      { content: [thinking('sig-1'), text('not json')] },
      { content: [text('{"answer":"done"}')] },
    ];
    const kept = await provider().callStepWithTools('prompt', [], NOOP_EXECUTOR, {
      maxToolCalls: 1,
    });
    expect(kept.output).toEqual({ answer: 'done' });
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toHaveProperty('tools');
    expect(sent[1]).not.toHaveProperty('tools');
    expect(sent[1]!.tool_choice).toEqual({ type: 'none' });
    expect(thinkingIds(sent[1]!)).toEqual(['thinking:sig-1']);

    // Remove half: with a schema the extraction offers the answer tool — a different list.
    reset();
    script = [
      { content: [thinking('sig-2'), text('not json')] },
      { content: [submit({ answer: 'done' })] },
    ];
    const removed = await provider().callStepWithTools('prompt', [], NOOP_EXECUTOR, {
      inputSchema: SCHEMA,
      maxToolCalls: 1,
    });
    expect(removed.output).toEqual({ answer: 'done' });
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toHaveProperty('tools');
    expect(toolsOf(sent[1]!).map((t) => t.name)).toEqual(['__realm_submit__']);
    expect(thinkingIds(sent[1]!)).toEqual([]);
  });

  it('cell 9 — guard: the history is never changed (the reply content array and the shared history keep their thinking)', async () => {
    const r1: Reply = { content: [thinking('sig-1'), text('Let me look.'), toolUse('toolu_1')] };
    script = [r1, { content: [submit({ answer: 'done' })] }];
    // The call's own outcome is cells 1 and 7's business; this cell must reach its assertions
    // whether the call succeeds or is refused.
    await provider()
      .callStepWithTools('prompt', [lookupTool()], NOOP_EXECUTOR, {
        inputSchema: SCHEMA,
        maxToolCalls: 1,
      })
      .catch(() => undefined);
    const asReturned = [thinking('sig-1'), text('Let me look.'), toolUse('toolu_1')];
    expect(r1.content).toEqual(asReturned);
    const shared = bodyOf(0).messages;
    expect(shared[1]).toEqual({ role: 'assistant', content: asReturned });
    expect(shared[1]!.content).toBe(r1.content);
  });

  it('cell 10 — a thinking-only turn at the correction path last slot is sent as content: [] (T6)', async () => {
    script = [
      { content: [thinking('sig-1')], stop_reason: 'max_tokens' },
      { content: [submit({ answer: 'done' })] },
    ];
    const result = await provider().callStepWithTools('prompt', [lookupTool()], NOOP_EXECUTOR, {
      inputSchema: SCHEMA,
      maxToolCalls: 1,
    });
    expect(result.output).toEqual({ answer: 'done' });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.messages).toHaveLength(3);
    expect(sent[1]!.messages[1]).toEqual({ role: 'assistant', content: [] });
  });

  it('cell 11 — production shape: cells 1 and 4 again under a clock (the body goes through driveCreate)', async () => {
    await budgetAfterThinking(CLOCK);
    reset();
    await strictDropAfterThinking(CLOCK);
  });

  it("cell 12 — source check: anthropic-provider.ts has exactly one role: 'assistant' literal outside comments (the helper)", () => {
    const source = readFileSync(
      fileURLToPath(new URL('./anthropic-provider.ts', import.meta.url)),
      'utf8',
    );
    const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);
    const hits: string[] = [];
    source.split('\n').forEach((line, i) => {
      if (!isComment(line) && line.includes("role: 'assistant'")) {
        hits.push(`${String(i + 1)}: ${line.trim()}`);
      }
    });
    expect(
      hits,
      `expected exactly one \`role: 'assistant'\` literal (the push helper); found:\n${hits.join('\n')}`,
    ).toHaveLength(1);
  });
});
