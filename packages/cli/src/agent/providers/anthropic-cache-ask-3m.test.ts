// anthropic-cache-ask-3m.test.ts — caching 3-M piece B2a: the Anthropic provider can ask why a
// request's cache read fell short, when it is told to and only at Anthropic's own address. The
// real cases: a drive on an account that may not ask (a HIPAA organisation) gets a 400 on the
// question and must still run its step; a strict step's 400 may be about its schema, or about the
// question; a request that asks to cache nothing must not leave a fingerprint at Anthropic.
//
// The SDK is mocked: a per-send 400 cannot be scripted on the stub, whose failure answers every
// request (the body reaching the wire is pinned on the stub, `anthropic-cache-ask-wire-3m.test.ts`).
// There are two send paths, single-shot and tool turns: a rule added on one path only turns that
// path's row red. On a failure a cell prints each request's question (`none`, null or the id, all
// test values) or the body's keys, never prompt text. Each assertion carries (1) the break that
// turns it red and (2) what it prints.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

type Body = Record<string, unknown>;
type Options = NonNullable<ConstructorParameters<typeof AnthropicProvider>[1]>;

/** A real-shaped answer id: `msg_01` and 22 base62 characters (A3MB1-10). */
const msgId = (n: number): string => `msg_01${String(n).padStart(22, 'A')}`;
/** An id that fails the check: another provider's. */
const FOREIGN_ID = 'chatcmpl-9fakeNotAnthropic';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x'],
  properties: { x: { type: 'string' } },
};
const tool = (strict = false): ToolDefinition => ({
  id: 'srv:lookup',
  serverId: 'srv',
  name: 'lookup',
  description: 'A tool',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  ...(strict ? { strict: true } : {}),
});
const EXECUTOR = async () => ({ content: [{ type: 'text', text: 'ok' }] });

/** The SDK's public error contract as the provider duck-types it. */
const httpError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { status });
/** A captured 400 for a refused strict schema (premise-probe-raw.md), verbatim. */
const CAPTURED_400_SCHEMA =
  "tools.0.custom: For 'object' type, 'additionalProperties' must be explicitly set to false";
const REFUSED = 'a 400 that says nothing of the question';

const textAnswer = (id: unknown, text = '{"x":"a"}') => ({
  id,
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
});
const toolCallAnswer = (id: unknown) => ({
  id,
  content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }],
  stop_reason: 'tool_use',
});
const submitAnswer = (id: unknown) => ({
  id,
  content: [{ type: 'tool_use', id: 'submit1', name: '__realm_submit__', input: { x: 'a' } }],
  stop_reason: 'tool_use',
});

/** A provider at Anthropic's own address, asking to cache, told to ask. */
const asking = (over: Options = {}): AnthropicProvider =>
  new AnthropicProvider('claude-x', {
    endpoint: 'default',
    promptCache: { value: 'short' },
    cacheDiagnostics: true,
    ...over,
  });
/** `auto` on a drive `realm listen` started: with no call option it asks its prior, 1 hour. */
const autoListen = (): AnthropicProvider =>
  asking({
    promptCache: {
      value: 'auto',
      source: 'runner_default',
      by: 'realm listen',
      auto: { basis: 'no_measurement' },
    },
  });

const body = (i: number): Body => mockCreate.mock.calls[i]![0] as Body;
/** Per request: `none` for no question, else what it names (`null`, or the id). */
const questions = (): unknown[] =>
  mockCreate.mock.calls.map(([b]) =>
    'diagnostics' in (b as Body)
      ? (b as { diagnostics: { previous_message_id: unknown } }).diagnostics.previous_message_id
      : 'none',
  );
const strictOf = (i: number): unknown[] =>
  ((body(i)['tools'] ?? []) as Array<{ strict?: boolean }>).map((t) => t.strict === true);
const failure = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => 'resolved',
    (err: unknown) => (err as { status?: unknown }).status ?? String(err),
  );

/** One of the two send paths: a provider call, an answer that goes on, and one that ends it. */
interface Path {
  readonly name: string;
  run(provider: AnthropicProvider): Promise<unknown>;
  goesOn(id: unknown): unknown;
  ends(id: unknown): unknown;
}
const SINGLE_SHOT: Path = {
  name: 'single-shot',
  run: (provider) => provider.callStepWithMeta('prompt', SCHEMA),
  goesOn: (id) => textAnswer(id, 'not json'), // the JSON retry follows
  ends: (id) => textAnswer(id),
};
const TOOL_TURNS: Path = {
  name: 'tool turns',
  run: (provider) => provider.callStepWithTools('prompt', [tool()], EXECUTOR, {}),
  goesOn: (id) => toolCallAnswer(id), // the next turn follows
  ends: (id) => textAnswer(id),
};
const PATHS: Path[] = [SINGLE_SHOT, TOOL_TURNS];
/** A strict step on each path, and how the provider call reads it. */
const strictRun = {
  'single-shot': (p: AnthropicProvider) =>
    p.callStepWithMeta('prompt', SCHEMA, undefined, { structuredOutputStrict: true }),
  'tool turns': (p: AnthropicProvider) => p.callStepWithTools('prompt', [tool(true)], EXECUTOR, {}),
};

beforeEach(() => {
  mockCreate.mockReset();
});

describe('caching 3-M B2a — the question on the request', () => {
  // Real case: a build that has no flag yet (B2b adds it). (1) red when the key goes out regardless
  // of the option. (2) prints each request's question.
  it.each(PATHS)('1 (b) option absent ($name): no request carries the question', async (path) => {
    mockCreate.mockResolvedValueOnce(path.ends(msgId(1)));
    await path.run(
      new AnthropicProvider('claude-x', { endpoint: 'default', promptCache: { value: 'short' } }),
    );
    expect(questions()).toEqual(['none']);
  });

  // Real case: ANTHROPIC_BASE_URL set to a gateway, which may not accept the field. (1) red when
  // the address is not tested. (2) prints the status the call failed with and each question.
  it.each(PATHS)(
    '1 (c) a custom endpoint ($name): no question, and a 400 is not probed',
    async (path) => {
      mockCreate.mockRejectedValueOnce(httpError(400, REFUSED));
      const failed = await failure(path.run(asking({ endpoint: 'custom' })));
      expect({ failed, questions: questions() }).toEqual({ failed: 400, questions: ['none'] });
    },
  );

  // Real case: a drive that caches nothing is never judged, so a fingerprint would serve nothing.
  // A stated `off` (a call's own `off` is D-1's check 5). (1) red when the ask does not read the
  // choice, or reads the setting (`auto`). (2) prints the failure and each question.
  describe.each(PATHS)('1 (d) a settled choice of off ($name)', (path) => {
    it.each([['--prompt-cache off', () => asking({ promptCache: { value: 'off' } })]] as const)(
      '%s: no question, and a 400 is not probed',
      async (_name, make) => {
        mockCreate.mockRejectedValueOnce(httpError(400, REFUSED));
        const failed = await failure(path.run(make()));
        expect({ failed, questions: questions() }).toEqual({ failed: 400, questions: ['none'] });
      },
    );

    it('auto on a drive realm listen started (its 1 hour): the question goes out', async () => {
      mockCreate.mockResolvedValueOnce(path.ends(msgId(1)));
      await path.run(autoListen());
      expect(questions()).toEqual([null]);
    });
  });
});

describe('caching 3-M B2a — which answer a request names', () => {
  // Real case: a tool step's turns, each following the answer before it. (1) red when every turn
  // names the first turn's id. (2) prints each question.
  it('2 (a) a tool step: turn 0 sends null, each later turn names the answer before it', async () => {
    mockCreate
      .mockResolvedValueOnce(toolCallAnswer(msgId(1)))
      .mockResolvedValueOnce(toolCallAnswer(msgId(2)))
      .mockResolvedValueOnce(textAnswer(msgId(3)));
    await TOOL_TURNS.run(asking());
    expect(questions()).toEqual([null, msgId(1), msgId(2)]);
  });

  // Real case: the model answers with no JSON and the step asks once more. (1) red when the JSON
  // retry sends null again. (2) prints each question.
  it("2 (b) a single-shot step's JSON retry names the first answer", async () => {
    mockCreate
      .mockResolvedValueOnce(textAnswer(msgId(1), 'not json'))
      .mockResolvedValueOnce(textAnswer(msgId(2)));
    await SINGLE_SHOT.run(asking());
    expect(questions()).toEqual([null, msgId(1)]);
  });

  // Real case: a gateway-style or malformed id must never reach the wire. (1) red when the id is
  // not checked (the adapter's own call of the normaliser, owed from B1). (2) prints each question.
  it.each(PATHS)(
    '2 (c) an answer whose id fails the check ($name): the next sends null',
    async (path) => {
      mockCreate
        .mockResolvedValueOnce(path.goesOn(FOREIGN_ID))
        .mockResolvedValueOnce(path.ends(msgId(2)));
      await path.run(asking());
      expect(questions()).toEqual([null, null]);
    },
  );

  // Real case: the final extraction asks to cache nothing and is never judged. (1) red when it asks.
  // (2) prints each question, and the failure.
  it('2 (d) the final extraction carries no question, and its 400 is not probed', async () => {
    const final = () =>
      asking().callStepWithTools('prompt', [tool()], EXECUTOR, {
        maxToolCalls: 1,
        inputSchema: SCHEMA,
      });
    mockCreate
      .mockResolvedValueOnce(toolCallAnswer(msgId(1)))
      .mockResolvedValueOnce(submitAnswer(msgId(2)));
    await final();
    expect(questions()).toEqual([null, 'none']);

    mockCreate.mockReset();
    mockCreate
      .mockResolvedValueOnce(toolCallAnswer(msgId(1)))
      .mockRejectedValueOnce(httpError(400, REFUSED));
    const failed = await failure(final());
    expect({ failed, questions: questions() }).toEqual({ failed: 400, questions: [null, 'none'] });
  });

  // Real case: a drive with several steps on one provider (§D4.13: a call never names an earlier
  // call's message). (1) red when the last id is kept on the instance. (2) prints each question.
  it.each(PATHS)(
    "2 (e) two calls on one provider ($name): the second's first request sends null",
    async (path) => {
      mockCreate
        .mockResolvedValueOnce(path.ends(msgId(1)))
        .mockResolvedValueOnce(path.ends(msgId(2)));
      const provider = asking();
      await path.run(provider);
      await path.run(provider);
      expect(questions()).toEqual([null, null]);
    },
  );
});

describe('caching 3-M B2a — a strict retry inside a request', () => {
  // Real case: a strict step whose schema Anthropic refuses at a later turn: the question is probed
  // first, then #311 retries. The retry names what the refused send would have named, and the next
  // turn names the retry's answer. (1) red when the id is taken in `send` only. (2) prints each
  // question.
  it('3 a tool step: turn 1 refused, probed and retried by #311; the next turn names the retry', async () => {
    mockCreate
      .mockResolvedValueOnce(toolCallAnswer(msgId(1)))
      .mockRejectedValueOnce(httpError(400, CAPTURED_400_SCHEMA))
      .mockRejectedValueOnce(httpError(400, CAPTURED_400_SCHEMA))
      .mockResolvedValueOnce(toolCallAnswer(msgId(2)))
      .mockResolvedValueOnce(textAnswer(msgId(3)));
    await strictRun['tool turns'](asking());
    expect(questions()).toEqual([null, msgId(1), 'none', msgId(1), msgId(2)]);
  });

  // The same on a single-shot step. (1) red when the JSON retry sends null, the #236 retry's answer
  // not taken. (2) prints each question.
  it("3 a single-shot step: the JSON retry names the #236 retry's answer", async () => {
    mockCreate
      .mockRejectedValueOnce(httpError(400, CAPTURED_400_SCHEMA))
      .mockRejectedValueOnce(httpError(400, CAPTURED_400_SCHEMA))
      .mockResolvedValueOnce(textAnswer(msgId(2), 'not json'))
      .mockResolvedValueOnce(textAnswer(msgId(3)));
    await strictRun['single-shot'](asking());
    expect(questions()).toEqual([null, 'none', null, msgId(2)]);
  });
});

describe('caching 3-M B2a — a refused question', () => {
  // Real case: an account that may not ask (HIPAA readiness: its 400's text is not captured, HB3-20).
  // The step still runs, and the drive stops asking. (1) red when the rule reads the message (the
  // second row). (2) prints each question.
  describe.each(PATHS)('4 (a) a first 400 re-sent without the question ($name)', (path) => {
    it.each([
      ['a text naming the field', 'diagnostics: Extra inputs are not permitted'],
      ['a text that does not', 'This feature is not available to your organization'],
    ])('%s: the re-send answers, and no later request of the drive asks', async (_name, text) => {
      mockCreate
        .mockRejectedValueOnce(httpError(400, text))
        .mockResolvedValueOnce(path.goesOn(msgId(1)))
        .mockResolvedValueOnce(path.ends(msgId(2)))
        .mockResolvedValueOnce(path.ends(msgId(3)));
      const provider = asking();
      await path.run(provider);
      await path.run(provider);
      expect(questions()).toEqual([null, 'none', 'none', 'none']);
    });
  });

  // Real case: a refused question on a strict step must not read as a refused schema. (1) red when
  // the probe sits after the strict ladder, or the re-send drops strict. (2) prints the meta or the
  // drop, each question and which requests carried strict.
  it('4 (b) a strict single-shot step: the re-send answers, still strict, and nothing reads as a schema refusal', async () => {
    mockCreate
      .mockRejectedValueOnce(httpError(400, REFUSED))
      .mockResolvedValueOnce(submitAnswer(msgId(1)));
    const result = await strictRun['single-shot'](asking());
    expect({
      meta: result.meta,
      questions: questions(),
      strict: [strictOf(0), strictOf(1)],
    }).toEqual({
      meta: { requested: true, sent: true, submission_channel: 'tool' },
      questions: [null, 'none'],
      strict: [[true], [true]],
    });
  });

  it('4 (b) a strict tool step: the re-send answers, strict is not dropped, and the next turn carries it', async () => {
    mockCreate
      .mockRejectedValueOnce(httpError(400, REFUSED))
      .mockResolvedValueOnce(toolCallAnswer(msgId(1)))
      .mockResolvedValueOnce(textAnswer(msgId(2)));
    const result = await strictRun['tool turns'](asking());
    expect({
      drop: result.toolArgsStrictDrop,
      questions: questions(),
      strict: [strictOf(0), strictOf(1), strictOf(2)],
    }).toEqual({
      drop: undefined,
      questions: [null, 'none', 'none'],
      strict: [[true], [true], [true]],
    });
  });

  // Real case: a strict schema Anthropic really refuses. The probe fails the same way, the strict
  // ladder runs as today and its retry still asks; the drive's one probe is spent. (1) red when the
  // probe sits after the ladder (the order), or the spent flag is per call (the later step probed).
  // (2) prints each question and which requests carried strict.
  describe.each(PATHS)('4 (c) a 400 about a strict schema ($name)', (path) => {
    it('the probe carries strict and no question, the ladder retries asking, and a later 400 is not probed', async () => {
      const provider = asking();
      mockCreate
        .mockRejectedValueOnce(httpError(400, CAPTURED_400_SCHEMA))
        .mockRejectedValueOnce(httpError(400, CAPTURED_400_SCHEMA))
        .mockResolvedValueOnce(path.ends(msgId(1)))
        .mockRejectedValueOnce(httpError(400, REFUSED));
      await strictRun[path.name as keyof typeof strictRun](provider);
      const failed = await failure(path.run(provider));
      expect({
        failed,
        questions: questions(),
        strict: [strictOf(0), strictOf(1), strictOf(2)],
      }).toEqual({
        failed: 400,
        questions: [null, 'none', null, null],
        strict: [[true], [true], [false]],
      });
    });
  });

  // Real case: an overloaded API. A 503 or a 429 is not the question's fault. (1) red when any
  // status is probed, or any failure spends the probe. (2) prints the failure and each question.
  describe.each(PATHS)('4 (d) a failure that is not a 400 ($name)', (path) => {
    it.each([503, 429])(
      '%i: no probe, and a later 400 in the drive is still probed',
      async (status) => {
        const provider = asking();
        mockCreate
          .mockRejectedValueOnce(httpError(status, 'overloaded'))
          .mockRejectedValueOnce(httpError(400, REFUSED))
          .mockResolvedValueOnce(path.ends(msgId(1)));
        const failed = await failure(path.run(provider));
        await path.run(provider);
        expect({ failed, questions: questions() }).toEqual({
          failed: status,
          questions: [null, null, 'none'],
        });
      },
    );
  });

  // Real case: the re-send is the same request without the question: the same cache markers, the
  // same tools. (1) red when the re-send is built without the markers. (2) prints the two bodies'
  // keys, and whether the rest is equal.
  it.each(PATHS)(
    '4 (e) the re-send ($name) differs from the first send by the question alone',
    async (path) => {
      mockCreate
        .mockRejectedValueOnce(httpError(400, REFUSED))
        .mockResolvedValueOnce(path.ends(msgId(1)));
      await path.run(asking());
      const { diagnostics: _asked, ...rest } = body(0);
      expect({
        keys: Object.keys(body(1)),
        marked: JSON.stringify(body(1)['system']).includes('cache_control'),
        same: JSON.stringify(body(1)) === JSON.stringify(rest),
      }).toEqual({ keys: Object.keys(rest), marked: true, same: true });
    },
  );
});
