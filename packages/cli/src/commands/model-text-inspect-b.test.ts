// Gap 1, unit B — `realm run inspect --verbose` shows each model call's text under each attempt and
// each drive failure, says why there is none, and checks each request's system text, prompt and tool
// list against the hashes Realm kept when it sent it. These cells drive the real `runAgent` against
// the real `InMemoryStore`, with the real providers over scripted SDKs (as A1's and A2b's cells do),
// change a stored record where a cell needs a record no drive writes (an edit after the run, an older
// record, another program's value), and read the real `inspectRun` output.
//
// Each cell names the break that turns it red (prompts/gap1-b-readers.md, checks 1–10) and prints
// the lines it compares. No real key is used; every value is fake.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  executeStep,
  type EvidenceSnapshot,
  type ModelText,
  type RunRecord,
  type RunStore,
  type UsageRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleGetRunState } from '@sensigo/realm-mcp/dist/tools/get-run-state.js';
import { runAgent, type AgentDeps } from '../agent/run-agent.js';
import { readEarlierRuns } from '../agent/earlier-runs.js';
import { AnthropicProvider } from '../agent/providers/anthropic-provider.js';
import { OpenAIProvider } from '../agent/providers/openai-provider.js';
import { OpenAIReasoningProvider } from '../agent/providers/openai-reasoning-provider.js';
import { LlmProvider, type CallStepWithMetaResult } from '../agent/providers/llm-provider.js';
import type { McpClient, McpTool } from '../agent/mcp/mcp-extensions.js';
import {
  addDeclaredValues,
  installWriter,
  noteDeclaredStanding,
  withholdUnlessAccepted,
  writerCtx,
  writerTestSeams,
} from '../output/writer.js';
import { declared } from '../test-support/declared.js';
import {
  snap,
  doubleClock,
  noSettle,
  neverPurges,
  scanning,
} from '../test-support/snapshot-double.js';
import { inspectRun } from './inspect.js';

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

type Body = Record<string, unknown> & { messages: Array<Record<string, unknown>> };
const THROW = Symbol('throw');
const throws = (err: unknown) => ({ [THROW]: err });
const dropped = () =>
  throws(Object.assign(new Error('the connection dropped'), { code: 'ECONNRESET' }));

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
      if (typeof next === 'object' && next !== null && THROW in next) {
        throw (next as Record<symbol, unknown>)[THROW];
      }
      return next;
    });
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  writerTestSeams.reset();
  vi.restoreAllMocks();
});

const PROMPT = 'Answer the question in one word.';
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
};
const ANSWER = '{"answer":"done"}';
const KB = 1024;
const SECRET = 'FAKE-gap1b-secret-value-0000';
const USAGE = { input_tokens: 10, output_tokens: 1 };
type Block = { type: string; [key: string]: unknown };
const reply = (content: Block[]) => ({ model: 'claude-test-1', content, usage: USAGE });
const text = (t: string): Block => ({ type: 'text', text: t });
const toolUse = (id: string): Block => ({ type: 'tool_use', id, name: 'lookup', input: {} });
const openAiReply = (content: string) => ({
  model: 'gpt-test-1',
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 1 },
});
const openAiToolCall = (n: number) => ({
  model: 'gpt-test-1',
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: `c${n}`, type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 1 },
});

const workflow = (
  id: string,
  step: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): WorkflowDefinition =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { ask: { description: PROMPT, execution: 'agent', output_schema: SCHEMA, ...step } },
    ...extra,
  }) as unknown as WorkflowDefinition;
const SERVERS = {
  mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-srv'] }],
};
const BARE = workflow('b-bare', {});
const TOOLS = workflow('b-tools', { tools: ['srv:lookup'] }, SERVERS);
/** A step under the agent profile `p`, whose text is `content`. */
const profiled = (id: string, content: string, step: Record<string, unknown> = {}) =>
  workflow(
    id,
    { agent_profile: 'p', ...step },
    {
      resolved_profiles: { p: { content, content_hash: 'a'.repeat(64) } },
    },
  );

/** A tool server whose one tool answers `result`. */
const serverAnswering = (result: string): McpClient => ({
  async connect() {},
  async getTools(_serverId: string, allowList: string[]): Promise<McpTool[]> {
    return allowList.map((name) => ({
      name,
      description: 'Look a thing up',
      inputSchema: { type: 'object' },
    }));
  },
  async call() {
    return { result };
  },
  async disconnect() {},
});

const registrar = (def: WorkflowDefinition) =>
  declared({ register: async () => {}, get: async () => def, list: async () => [def] });

interface Driven {
  run: RunRecord;
  store: RunStore;
  def: WorkflowDefinition;
}

/** Drives `def` with `provider` on a new run and returns the run as stored. */
async function drive(
  def: WorkflowDefinition,
  provider: LlmProvider,
  extra: Partial<AgentDeps> & { store?: InMemoryStore; params?: Record<string, unknown> } = {},
): Promise<Driven> {
  const { store: given, params = {}, ...deps } = extra;
  const store = given ?? new InMemoryStore();
  const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params });
  await runAgent(
    {
      store,
      workflowStore: registrar(def),
      provider,
      registry: createDefaultRegistry(),
      mcpClientFactory: () => serverAnswering('a fake tool result'),
      ...deps,
    } as unknown as AgentDeps,
    { existingRunId: record.id, definition: def, params },
  ).catch((err: unknown) => err);
  return { run: (await store.get(record.id)).record, store, def };
}

/** `inspect`'s output for the driven run, `--verbose` unless told otherwise. */
const inspect = (d: Driven, verbose = true): Promise<string> =>
  inspectRun(d.run.id, d.store, registrar(d.def) as never, verbose ? { verbose: true } : undefined);

/**
 * The stored run changed by `change`, as an edit after the run, an older record or another program
 * would leave it, on a store that hands out exactly that copy (the store refuses a write that drops
 * a text, and the driven run stays as it was).
 */
async function edit(d: Driven, change: (run: RunRecord) => void): Promise<Driven> {
  const run = structuredClone((await d.store.get(d.run.id)).record);
  change(run);
  return { ...d, run, store: storeOf(run) };
}

/** A run store that hands out exactly `run` (no version moves), for byte-for-byte comparisons. */
function storeOf(run: RunRecord): RunStore {
  return declared({
    persistsClaims: true,
    clock: doubleClock,
    settleStep: noSettle,
    get: async () => snap(run),
    create: async () => ({ ...snap(run), created: true }),
    update: async () => snap(run),
    scan: scanning(() => [run]),
    ...neverPurges,
    claimStep: async () => {
      throw new Error('claimStep is not used by inspect');
    },
  }) as unknown as RunStore;
}

type Recorded = Extract<ModelText, { recorded: true }>;
/** The step's last entry that records a model call. */
const entryOf = (run: RunRecord, step = 'ask'): EvidenceSnapshot =>
  run.evidence.filter((e) => e.step_id === step && e.diagnostics?.cache !== undefined).at(-1)!;
const textOf = (e: EvidenceSnapshot): Recorded => e.model_text as Recorded;
const requestsOf = (e: EvidenceSnapshot): UsageRecord[] => e.diagnostics?.cache?.requests ?? [];
const failureOf = (run: RunRecord) => run.drive_failures?.entries.at(-1);

const trimmed = (out: string): string[] => out.split('\n').map((l) => l.trim());
const checksOf = (out: string): string[] =>
  trimmed(out).filter(
    (l) => l.startsWith('Checked against what was sent:') || l.startsWith('Not checked:'),
  );
const requestLinesOf = (out: string): string[] =>
  trimmed(out).filter((l) => /^Request \d+ \(/.test(l));
const headingsOf = (out: string): string[] =>
  trimmed(out).filter((l) => l.startsWith('Model text:'));
const messageHeadsOf = (out: string): string[] =>
  trimmed(out).filter((l) => /^(Message|Tool list) \d+ · /.test(l));
const count = (out: string, needle: string): number => out.split(needle).length - 1;

const ALL_THREE =
  'Checked against what was sent: system text matches, prompt matches, tool list matches.';
const BOTH = 'Checked against what was sent: system text matches, prompt matches.';
const NO_HASHES = 'Not checked: no hashes on the record for this request.';

describe('gap 1, unit B — check 1: the texts of a tool loop', () => {
  it('a 3-turn tool loop prints 3 requests, each shared message once, each request’s numbers and its reply', async () => {
    script = [reply([toolUse('toolu_1')]), reply([toolUse('toolu_2')]), reply([text(ANSWER)])];
    const d = await drive(TOOLS, new AnthropicProvider('claude-x'));
    const out = await inspect(d);
    const ids = requestsOf(entryOf(d.run)).map((r) => r.request_id);
    // Break: a request's sent list printed from another request. Prints the lines compared.
    expect({
      headings: headingsOf(out),
      requests: requestLinesOf(out),
      heads: messageHeadsOf(out).map((l) => l.replace(/ · \d+ bytes.*/, '')),
      systemPrinted: count(out, 'You are an AI agent executing a step'),
      promptPrinted: count(out, PROMPT),
      toolListPrinted: count(out, '[{"name":"lookup"'),
      replies: trimmed(out).filter((l) => l.startsWith('{"type":"tool_use"')),
      checks: checksOf(out),
    }).toEqual({
      headings: ['Model text: 3 requests'],
      requests: [
        `Request 1 (${ids[0]}): sent 1, 2; reply 3; tool list 1`,
        `Request 2 (${ids[1]}): sent 1, 2, 3, 4; reply 5; tool list 1`,
        `Request 3 (${ids[2]}): sent 1, 2, 3, 4, 5, 6; reply 7; tool list 1`,
      ],
      heads: [
        'Message 1 · system',
        'Message 2 · user',
        'Message 3 · assistant',
        'Message 4 · user',
        'Message 5 · assistant',
        'Message 6 · user',
        'Message 7 · assistant',
        'Tool list 1',
      ],
      systemPrinted: 1,
      promptPrinted: 1,
      toolListPrinted: 1,
      replies: [
        '{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}',
        '{"type":"tool_use","id":"toolu_2","name":"lookup","input":{}}',
      ],
      checks: [ALL_THREE, ALL_THREE, ALL_THREE],
    });
  }, 30_000);
});

describe('gap 1, unit B — check 2: every attempt', () => {
  it('a step with two attempts prints each attempt’s texts under that attempt', async () => {
    const store = new InMemoryStore();
    script = [reply([text('{"answer":"first"}')])];
    const first = await drive(BARE, new AnthropicProvider('claude-x'), { store });
    script = [reply([text('{"answer":"second"}')])];
    const second = await drive(BARE, new AnthropicProvider('claude-x'), { store });
    const earlier = { ...entryOf(first.run), status: 'error' as const };
    const d = await edit(second, (run) => {
      run.evidence = [earlier, ...run.evidence];
    });
    const out = await inspect(d);
    const lines = trimmed(out);
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    const id1 = requestsOf(entryOf(first.run))[0]!.request_id;
    const id2 = requestsOf(entryOf(second.run))[0]!.request_id;
    const order = [
      at('(attempt 1/2)'),
      at(`Request 1 (${id1})`),
      at('{"answer":"first"}'),
      at('(attempt 2/2)'),
      at(`Request 1 (${id2})`),
    ];
    // Break: only the last attempt's texts. Prints the line indexes and the headings.
    expect({
      order,
      inOrder: order.every((n, i) => n > -1 && (i === 0 || n > order[i - 1]!)),
      headings: headingsOf(out),
    }).toEqual({
      order: expect.any(Array),
      inOrder: true,
      headings: ['Model text: 1 request', 'Model text: 1 request'],
    });
  }, 30_000);
});

/**
 * The two providers whose requests carry Realm's hashes as sent, and what each check line ends with:
 * Anthropic offers its answer tool on every request, so its requests carry a tool list.
 */
const PROVIDERS: Array<[string, () => LlmProvider, (answer: string) => unknown, string]> = [
  [
    'Anthropic',
    () => new AnthropicProvider('claude-x'),
    (a) => reply([text(a)]),
    ', tool list matches',
  ],
  ['OpenAI', () => new OpenAIProvider('gpt-x'), (a) => openAiReply(a), ''],
];
/** The check line with `parts`, and `tail` (the tool list's outcome, where there is one). */
const line = (parts: string, tail: string) => `Checked against what was sent: ${parts}${tail}.`;
const TEMPLATED = 'Classify this {{ run.params.x }} now.';
const HEAD = 'Classify this '.length;

describe('gap 1, unit B — check 3: the check, Anthropic and OpenAI', () => {
  for (const [name, provider, answer, tail] of PROVIDERS) {
    it(`${name}: a step with only a description, a prompt with no run value, a templated prompt, and a template that starts with a value`, async () => {
      const outcome = async (def: WorkflowDefinition, params: Record<string, unknown> = {}) => {
        script = [answer(ANSWER)];
        return checksOf(await inspect(await drive(def, provider(), { params })));
      };
      // Breaks: every request with prefix_chars printed as `first <n> characters match` (the
      // unvalued prompt); a head agreement printed as `matches`, or the whole prompt hashed instead
      // of its head (the templated prompt); the empty head compared as a head (`first 0 characters
      // match`). Prints each check line.
      expect({
        description: await outcome(BARE),
        unvalued: await outcome(workflow('b-unvalued', { prompt: 'Name one colour.' })),
        templated: await outcome(workflow('b-templated', { prompt: TEMPLATED }), { x: 'ticket' }),
        startsWithValue: await outcome(
          workflow('b-value-first', { prompt: '{{ run.params.x }} is the input.' }),
          { x: 'ticket' },
        ),
      }).toEqual({
        description: [line('system text matches, prompt matches', tail)],
        unvalued: [line('system text matches, prompt matches', tail)],
        templated: [line(`system text matches, prompt first ${HEAD} characters match`, tail)],
        startsWithValue: [
          line('system text matches, prompt not checked (only its empty start was hashed)', tail),
        ],
      });
    }, 30_000);

    it(`${name}: a templated prompt edited after its head, cut after its head, and cut with its head edited`, async () => {
      script = [answer(ANSWER)];
      const d = await drive(workflow('b-templated', { prompt: TEMPLATED }), provider(), {
        params: { x: 'ticket' },
      });
      const tailEdited = await edit(d, (run) => {
        textOf(entryOf(run)).messages[1]!.text = 'Classify this EDITED TAIL, not what was sent.';
      });
      script = [answer(ANSWER)];
      const cut = await drive(workflow('b-templated', { prompt: TEMPLATED }), provider(), {
        params: { x: 'x'.repeat(70 * KB) },
      });
      const cutPrompt = textOf(entryOf(cut.run)).messages[1]!;
      const headEdited = await edit(cut, (run) => {
        const m = textOf(entryOf(run)).messages[1]!;
        m.text = `K${m.text.slice(1)}`;
      });
      const first = line(`system text matches, prompt first ${HEAD} characters match`, tail);
      // Breaks: a head disagreement after a later cut printed as `not checkable (cut)` (the cut
      // prompt with its head edited); the whole prompt hashed (the edited tail). Prints each line.
      expect({
        tailEdited: checksOf(await inspect(tailEdited)),
        cutKept: cutPrompt.cut !== undefined,
        cut: checksOf(await inspect(cut)),
        headEdited: checksOf(await inspect(headEdited)),
      }).toEqual({
        tailEdited: [first],
        cutKept: true,
        cut: [first],
        headEdited: [line('system text matches, prompt differs', tail)],
      });
    }, 30_000);

    it(`${name}: a system text edited after the run, one with a secret value replaced, and a cut one`, async () => {
      script = [answer(ANSWER)];
      const edited = await edit(await drive(BARE, provider()), (run) => {
        textOf(entryOf(run)).messages[0]!.text += ' Edited after the run.';
      });
      script = [answer(ANSWER)];
      const masked = await drive(
        profiled('b-masked', `Keep the key ${SECRET} private.`),
        provider(),
        {
          redactionValues: [SECRET],
        },
      );
      script = [answer(ANSWER)];
      const cut = await drive(profiled('b-cut', 'P'.repeat(70 * KB)), provider());
      // Break: a disagreement on a masked text printed as `differs`. Prints each line and the mark.
      expect({
        edited: checksOf(await inspect(edited)),
        maskedHidden: textOf(entryOf(masked.run)).messages[0]!.hidden,
        masked: checksOf(await inspect(masked)),
        cut: checksOf(await inspect(cut)),
      }).toEqual({
        edited: [line('system text differs, prompt matches', tail)],
        maskedHidden: 1,
        masked: [line('system text not checkable (secret values replaced), prompt matches', tail)],
        cut: [line('system text not checkable (cut), prompt matches', tail)],
      });
    }, 30_000);
  }

  it('OpenAI: a tool loop’s tool list matches', async () => {
    script = [openAiToolCall(1), openAiReply(ANSWER)];
    const d = await drive(TOOLS, new OpenAIProvider('gpt-x'));
    const out = await inspect(d);
    // Break: the tool list compared with another request's. Prints the lines.
    expect({ requests: requestLinesOf(out).length, checks: checksOf(out) }).toEqual({
      requests: 2,
      checks: [ALL_THREE, ALL_THREE],
    });
  }, 30_000);

  it('Anthropic: the tool loop’s final extraction has no hashes', async () => {
    script = [reply([toolUse('toolu_1')]), reply([text(ANSWER)])];
    const d = await drive(
      workflow('b-final', { tools: ['srv:lookup'], max_tool_calls: 1 }, SERVERS),
      new AnthropicProvider('claude-x'),
    );
    const out = await inspect(d);
    // Break: a request with no hashes given a check of its parts. Prints the lines.
    expect({
      hashes: requestsOf(entryOf(d.run)).map((r) => r.prefix_parts !== undefined),
      checks: checksOf(out),
    }).toEqual({ hashes: [true, false], checks: [ALL_THREE, NO_HASHES] });
  }, 30_000);

  it('a run of the workflow after its profile changed: its first request’s reference holds the old hashes, and its own match', async () => {
    const store = new InMemoryStore();
    const before = profiled('b-redriven', 'Write plainly.');
    const after = profiled('b-redriven', 'Write in full sentences.');
    script = [reply([text(ANSWER)])];
    await drive(before, new AnthropicProvider('claude-x'), { store });
    const earlierRuns = await readEarlierRuns(store, after, undefined);
    script = [reply([text(ANSWER)])];
    const d = await drive(after, new AnthropicProvider('claude-x'), {
      store,
      ...(earlierRuns !== undefined ? { earlierRuns } : {}),
    });
    const first = requestsOf(entryOf(d.run))[0]!;
    // Break: `reference.prefix_parts` read (the system text then differs). Prints the reference's
    // source, whether its system hash differs from the request's own, and the check line.
    expect({
      from: first.reference?.from,
      referenceDiffers:
        first.reference?.prefix_parts?.system !== undefined &&
        first.reference.prefix_parts.system !== first.prefix_parts?.system,
      checks: checksOf(await inspect(d)),
    }).toEqual({ from: 'earlier_run', referenceDiffers: true, checks: [ALL_THREE] });
  }, 30_000);
});

describe('gap 1, unit B — check 4: the check, the reasoning provider', () => {
  it('both parts match, also with a profile holding a blank line; a masked profile secret leaves the prompt compared', async () => {
    const outcome = async (
      def: WorkflowDefinition,
      extra: { redactionValues?: string[] } = {},
      params = {},
    ) => {
      script = [openAiReply(ANSWER)];
      const d = await drive(def, new OpenAIReasoningProvider('o-test'), { ...extra, params });
      return {
        roles: textOf(entryOf(d.run)).messages.map((m) => m.role),
        checks: checksOf(await inspect(d)),
      };
    };
    // Breaks: a split at the first blank line (the profile's own); the prompt's outcome taken from
    // the system text's (the masked profile). Prints the roles kept and each check line.
    expect({
      bare: await outcome(BARE),
      blankLine: await outcome(profiled('b-r-blank', 'Line one.\n\nLine two.')),
      templated: await outcome(
        profiled('b-r-tpl', 'Line one.\n\nLine two.', { prompt: TEMPLATED }),
        {},
        { x: 'ticket' },
      ),
      masked: await outcome(profiled('b-r-masked', `Keep ${SECRET} here.\n\nAnd more.`), {
        redactionValues: [SECRET],
      }),
    }).toEqual({
      bare: { roles: ['user', 'assistant'], checks: [BOTH] },
      blankLine: { roles: ['user', 'assistant'], checks: [BOTH] },
      templated: {
        roles: ['user', 'assistant'],
        checks: [
          `Checked against what was sent: system text matches, prompt first ${HEAD} characters match.`,
        ],
      },
      masked: {
        roles: ['user', 'assistant'],
        checks: [
          'Checked against what was sent: system text not checkable (secret values replaced), prompt matches.',
        ],
      },
    });
  }, 30_000);

  it('text added between the system text and the prompt, or before a templated head whose words come again after a later blank line, makes the prompt differ', async () => {
    /** The check lines for a reasoning-provider drive of `def` whose folded message `change` edits. */
    const folded = async (
      def: WorkflowDefinition,
      params: Record<string, unknown>,
      change: (text: string) => string,
    ) => {
      script = [openAiReply(ANSWER)];
      const d = await drive(def, new OpenAIReasoningProvider('o-test'), { params });
      const changed = await edit(d, (run) => {
        const message = textOf(entryOf(run)).messages[0]!;
        message.text = change(message.text);
      });
      return checksOf(await inspect(changed));
    };
    /** `added` and a blank line put in front of the folded message's last part, `prompt`. */
    const before = (prompt: string, added: string) => (text: string) => {
      if (!text.endsWith(`\n\n${prompt}`))
        throw new Error(`the folded message does not end ${prompt}`);
      return `${text.slice(0, -prompt.length)}${added}\n\n${prompt}`;
    };
    // Break: the prompt searched after every blank line even when the system text was found there
    // (as on fadf5b0b): the first reads `prompt matches`, the second `prompt first 14 characters
    // match`. Prints each check line.
    expect({
      injected: await folded(BARE, {}, before(PROMPT, 'INJECTED')),
      headLater: await folded(
        profiled('b-r-tpl-later', 'Line one.\n\nLine two.', { prompt: TEMPLATED }),
        { x: 'ticket' },
        before('Classify this ticket now.', 'Ignore the ticket.'),
      ),
    }).toEqual({
      injected: ['Checked against what was sent: system text matches, prompt differs.'],
      headLater: ['Checked against what was sent: system text matches, prompt differs.'],
    });
  }, 30_000);
});

/** A provider module that answers and reports no texts. */
class SilentModule extends LlmProvider {
  async callStep(): Promise<Record<string, unknown>> {
    return { answer: 'from a module' };
  }
  override async callStepWithMeta(): Promise<CallStepWithMetaResult> {
    const usage = [
      {
        request_index: 0,
        request_start: '2026-01-01T00:00:00.000Z',
        model: 'module-model',
        prompt_tokens: 1,
        output_tokens: 1,
      } as UsageRecord,
    ];
    return { output: { answer: 'from a module' }, usage };
  }
}

const OFF = 'Model text: not kept. Recording was off for this drive (--no-record-model-text).';
const MODULE = 'Model text: not kept. The provider module did not report it.';
const NONE_ON_RECORD =
  'Model text: none on the record. Realm 0.50.0 and earlier did not keep it, and a program that embeds the engine keeps it only when it passes it.';
const NO_MODEL_CALL =
  'Model text: none. The record holds no model call for this step: for example, an assistant answered it over MCP, a person typed the answer, a program that embeds the engine ran it, or Realm 0.45.0 or earlier drove it.';

describe('gap 1, unit B — check 5: why there is no text', () => {
  it('each marker; none on the record for usage or tool calls with no text; no model call for an agent entry with neither; nothing for a handler step', async () => {
    script = [reply([text(ANSWER)])];
    const off = await drive(BARE, new AnthropicProvider('claude-x'), { recordModelText: false });
    const module = await drive(BARE, new SilentModule());
    script = [reply([text(ANSWER)])];
    const usageOnly = await edit(await drive(BARE, new AnthropicProvider('claude-x')), (run) => {
      delete entryOf(run).model_text;
    });
    script = [reply([toolUse('toolu_1')]), reply([text(ANSWER)])];
    const tools = await drive(TOOLS, new AnthropicProvider('claude-x'));
    const toolCallsOnly = await edit(tools, (run) => {
      const e = entryOf(run);
      delete e.model_text;
      delete e.diagnostics!.cache;
    });
    script = [reply([text(ANSWER)])];
    const neither = await edit(await drive(BARE, new AnthropicProvider('claude-x')), (run) => {
      const e = entryOf(run);
      delete e.model_text;
      delete e.tool_calls;
      delete e.diagnostics!.cache;
    });
    const handlerDef = {
      id: 'b-handler',
      name: 'b-handler',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { fetch: { description: 'Fetch.', execution: 'auto', depends_on: [] } },
    } as unknown as WorkflowDefinition;
    const store = new InMemoryStore();
    const { record } = await store.create({
      workflowId: handlerDef.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, handlerDef, {
      runId: record.id,
      command: 'fetch',
      input: {},
      dispatcher: async () => ({ fetched: true }),
    });
    const handler: Driven = { run: (await store.get(record.id)).record, store, def: handlerDef };
    // Breaks: an entry with usage given the "no model call" line; `tool_calls` ignored. Prints each
    // entry's model-text lines.
    expect({
      off: headingsOf(await inspect(off)),
      module: headingsOf(await inspect(module)),
      usageOnly: headingsOf(await inspect(usageOnly)),
      toolCallsOnly: headingsOf(await inspect(toolCallsOnly)),
      neither: headingsOf(await inspect(neither)),
      handlerEntries: handler.run.evidence.length,
      handler: headingsOf(await inspect(handler)),
    }).toEqual({
      off: [OFF],
      module: [MODULE],
      usageOnly: [NONE_ON_RECORD],
      toolCallsOnly: [NONE_ON_RECORD],
      neither: [NO_MODEL_CALL],
      handlerEntries: 1,
      handler: [],
    });
  }, 30_000);
});

const PRE_CLAIM = {
  id: 'b-pre-claim',
  name: 'b pre-claim',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    x: {
      description: 'X',
      execution: 'auto',
      depends_on: [],
      input_schema: {
        type: 'object',
        required: ['must'],
        properties: { must: { type: 'string' } },
      },
    },
    review: { description: 'Review.', execution: 'agent', depends_on: ['x'] },
  },
} as unknown as WorkflowDefinition;

describe('gap 1, unit B — check 6: drive failures', () => {
  it('an unanswered request, a left-out message and its count; requests: []; a marker; no field', async () => {
    const big = 'R'.repeat(40 * KB);
    script = [reply([toolUse('toolu_1')]), reply([toolUse('toolu_2')]), dropped()];
    const failed = await drive(TOOLS, new AnthropicProvider('claude-x'), {
      mcpClientFactory: () => serverAnswering(big),
    });
    const failure = failureOf(failed.run)!;
    const ids = (failure.usage ?? []).map((u) => u.request_id);
    const out = await inspect(failed);
    const lines = trimmed(out);
    const failureLines = lines.slice(
      lines.findIndex((l) => l.startsWith('Model text: 3 requests')),
    );
    const pre = await drive(PRE_CLAIM, new AnthropicProvider('claude-x'));
    const preOff = await drive(PRE_CLAIM, new AnthropicProvider('claude-x'), {
      recordModelText: false,
    });
    const noField = await edit(pre, (run) => {
      delete failureOf(run)!.model_text;
    });
    // Break: the unanswered request printed with a reply. Prints the failure's lines (the left-out
    // message's head and the count line) and each other failure's line.
    expect({
      requests: requestLinesOf(out),
      checks: checksOf(out),
      leftOut: failureLines.filter((l) => l.includes('left out to fit 64 KB')),
      dropped: (failure.model_text as { dropped_messages?: number }).dropped_messages,
      none: headingsOf(await inspect(pre)),
      marker: headingsOf(await inspect(preOff)),
      noField: headingsOf(await inspect(noField)),
    }).toEqual({
      requests: [
        `Request 1 (${ids[0]}): sent 1, 2; reply 3; tool list 1`,
        `Request 2 (${ids[1]}): sent 1, 2, 3, 4; reply 5; tool list 1`,
        'Request 3 (got no answer): sent 1, 2, 3, 4, 5, 6; tool list 1',
      ],
      checks: [ALL_THREE, ALL_THREE, NO_HASHES],
      leftOut: [
        expect.stringMatching(/^Message 4 · user · 0 bytes · left out to fit 64 KB \(\d+ bytes\)$/),
        '1 message left out to fit 64 KB.',
      ],
      dropped: 1,
      none: [
        "Model text: none for this failure. It came before any model request, or its step's requests are on the step's own entry.",
      ],
      marker: [OFF],
      noField: [
        'Model text: none on the record for this failure. Realm 0.50.0 and earlier did not keep it, and only realm agent and realm listen write it.',
      ],
    });
  }, 30_000);

  it('the marks beside a size, in order (left out, cut, secret values replaced), and a left-out text not printed', async () => {
    const d = await embedded({
      recorded: true,
      messages: [
        {
          role: 'system',
          text: 'S'.repeat(10),
          cut: { kept_bytes: 10, full_bytes: 20 },
          hidden: 2,
        },
        { role: 'user', text: '', cut: { kept_bytes: 0, full_bytes: 30 } },
        { role: 'assistant', text: '{"answer":"x"}', hidden: 1 },
      ],
      tools: [],
      requests: [{ request_id: 'req-marks-1', sent: [0, 1], reply: [2] }],
    });
    const lines = trimmed(await inspect(d));
    const at = lines.findIndex((l) => l.startsWith('Message 2 · user'));
    script = [reply([text(ANSWER)])];
    const cutMasked = await drive(
      profiled('b-cut-masked', `Keep the key ${SECRET} private. ${'P'.repeat(70 * KB)}`),
      new AnthropicProvider('claude-x'),
      { redactionValues: [SECRET] },
    );
    const out = await inspect(cutMasked);
    // Breaks: the marks in another order (secret values before the cut); a left-out text printed.
    // Prints the message heads, the line after the left-out one, and the cut-and-masked check.
    expect({
      heads: messageHeadsOf(lines.join('\n')),
      afterLeftOut: lines[at + 1],
      cutMasked: messageHeadsOf(out)[0]!.replace(/\d+ bytes/g, 'N bytes'),
      check: checksOf(out),
    }).toEqual({
      heads: [
        'Message 1 · system · 10 bytes · cut: kept 10 bytes of 20 bytes · 2 known secret values replaced by [REDACTED]',
        'Message 2 · user · 0 bytes · left out to fit 64 KB (30 bytes)',
        'Message 3 · assistant · 14 bytes · 1 known secret value replaced by [REDACTED]',
      ],
      afterLeftOut:
        'Message 3 · assistant · 14 bytes · 1 known secret value replaced by [REDACTED]',
      cutMasked:
        'Message 1 · system · N bytes · cut: kept N bytes of N bytes · 1 known secret value replaced by [REDACTED]',
      check: [
        'Checked against what was sent: system text not checkable (cut), prompt matches, tool list matches.',
      ],
    });
  }, 30_000);
});

/** A run of BARE whose one entry holds `modelText` as a program that embeds the engine passed it. */
async function embedded(modelText: unknown): Promise<Driven> {
  const store = new InMemoryStore();
  const { record } = await store.create({ workflowId: BARE.id, workflowVersion: 1, params: {} });
  await executeStep(store, BARE, {
    runId: record.id,
    command: 'ask',
    input: { answer: 'x' },
    dispatcher: async (_command, input) => input,
    stepMeta: { modelText: modelText as ModelText },
  });
  return { run: (await store.get(record.id)).record, store, def: BARE };
}
const EMBEDDED: Recorded = {
  recorded: true,
  messages: [
    { role: 'system', text: 'An embedder system text.' },
    { role: 'user', text: `Use the key ${SECRET} for the lookup.` },
    { role: 'assistant', text: '{"answer":"x"}' },
  ],
  tools: [],
  requests: [{ request_id: 'req-embedded-1', sent: [0, 1], reply: [2] }],
};

describe('gap 1, unit B — check 7: the mask at print', () => {
  it('a fake declared value an embedder stored unmasked prints masked; a shape under broadcast; type and size while values are withheld', async () => {
    const d = await embedded(EMBEDDED);
    const raw = JSON.stringify(d.run);
    installWriter('default');
    addDeclaredValues({ GAP1B_KEY: SECRET });
    const masked = writerTestSeams.visible(await inspect(d));
    writerTestSeams.reset();
    installWriter('broadcast');
    const broadcast = writerTestSeams.visible(await inspect(d));
    writerTestSeams.reset();
    installWriter('default');
    noteDeclaredStanding('gap1b-test', { declared: 'partial', declaredCause: 'manifest_changed' });
    withholdUnlessAccepted(false);
    const withheld = writerTestSeams.visible(await inspect(d));
    const promptLine = (out: string) => {
      const lines = trimmed(out);
      return lines[lines.findIndex((l) => l.startsWith('Message 2 · user')) + 1];
    };
    // Break: the text printed inside the writer's verified command span (`writerCtx().cmd()`),
    // which prints as built. Prints the prompt's line on each audience; never the value.
    expect({
      storedUnmasked: raw.includes(SECRET),
      leaked: [masked, broadcast, withheld].map((o) => o.includes(SECRET)),
      masked: promptLine(masked),
      broadcast: promptLine(broadcast),
      withheld: promptLine(withheld),
    }).toEqual({
      storedUnmasked: true,
      leaked: [false, false, false],
      masked: 'Use the key [REDACTED] for the lookup.',
      broadcast: '‹string, 56 characters›',
      withheld: '‹string, 56 characters›',
    });
  }, 30_000);

  it('while values are withheld, a reply holding \\r\\n or an ANSI sequence prints the shape of the stored text; on the plain path, escaped and masked', async () => {
    script = [reply([text(ANSWER)])];
    const driven = await drive(BARE, new AnthropicProvider('claude-x'));
    const STORED = { crlf: `first\r\n${SECRET}`, ansi: `A\u001b[2A${SECRET}` };
    const withReply = (stored: string) =>
      edit(driven, (run) => {
        textOf(entryOf(run)).messages[2]!.text = stored;
      });
    const runs = { crlf: await withReply(STORED.crlf), ansi: await withReply(STORED.ansi) };
    /** The `n` lines under the reply's head. */
    const replyLines = (out: string, n: number) => {
      const lines = trimmed(out);
      const at = lines.findIndex((l) => l.startsWith('Message 3 · assistant'));
      return lines.slice(at + 1, at + 1 + n);
    };
    installWriter('default');
    addDeclaredValues({ GAP1B_KEY: SECRET });
    const plain = {
      crlf: writerTestSeams.visible(await inspect(runs.crlf)),
      ansi: writerTestSeams.visible(await inspect(runs.ansi)),
    };
    noteDeclaredStanding('gap1b-test', { declared: 'partial', declaredCause: 'manifest_changed' });
    withholdUnlessAccepted(false);
    const withheld = {
      crlf: writerTestSeams.visible(await inspect(runs.crlf)),
      ansi: writerTestSeams.visible(await inspect(runs.ansi)),
    };
    const outs = [plain.crlf, plain.ansi, withheld.crlf, withheld.ansi];
    // Break: the escape before the value path (as on fadf5b0b): the shapes then count the escaped
    // text, 36 and 38 characters. Prints the reply's lines on each path and the writer's own shape of
    // each stored text.
    expect({
      withheld: { crlf: replyLines(withheld.crlf, 1), ansi: replyLines(withheld.ansi, 1) },
      valuePath: { crlf: writerCtx().value(STORED.crlf), ansi: writerCtx().value(STORED.ansi) },
      plain: { crlf: replyLines(plain.crlf, 2), ansi: replyLines(plain.ansi, 1) },
      raw: outs.some((o) => ['\r', '\u001b'].some((c) => o.includes(c))),
      leaked: outs.some((o) => o.includes(SECRET)),
    }).toEqual({
      withheld: { crlf: ['‹string, 35 characters›'], ansi: ['‹string, 33 characters›'] },
      valuePath: { crlf: '‹string, 35 characters›', ansi: '‹string, 33 characters›' },
      plain: { crlf: ['first\\r', '[REDACTED]'], ansi: ['A\\u001b[2A[REDACTED]'] },
      raw: false,
      leaked: false,
    });
  }, 30_000);
});

describe('gap 1, unit B — check 8: control characters', () => {
  it('a stored reply holding an ANSI cursor sequence, a C1 control and U+2028 prints them escaped; \\n and \\t stay', async () => {
    script = [reply([text(ANSWER)])];
    const d = await edit(await drive(BARE, new AnthropicProvider('claude-x')), (run) => {
      textOf(entryOf(run)).messages[2]!.text = 'A\u001b[2AB\u009bC\u2028D\nE\tF';
    });
    const out = await inspect(d);
    const lines = trimmed(out);
    const at = lines.findIndex((l) => l.startsWith('Message 3 · assistant'));
    // Break: the escape removed. Prints the two reply lines.
    expect({
      raw: ['\u001b', '\u009b', '\u2028'].some((c) => out.includes(c)),
      reply: lines.slice(at + 1, at + 3),
    }).toEqual({ raw: false, reply: ['A\\u001b[2AB\\u009bC\\u2028D', 'E\tF'] });
  }, 30_000);
});

describe('gap 1, unit B — check 9: any stored shape', () => {
  it('a model_text outside the type prints `could not be read`, and inspect returns', async () => {
    const valid = (): Recorded => structuredClone(EMBEDDED);
    const shapes: Record<string, unknown> = {
      indexPastMessages: { ...valid(), requests: [{ request_id: 'r', sent: [5], reply: [] }] },
      messagesNotArray: { ...valid(), messages: 'no' },
      aString: 'not a model text',
      unknownWhy: { recorded: false, why: 'mystery' },
      unknownRole: { ...valid(), messages: [{ role: 'robot', text: 'x' }] },
      textNotString: { ...valid(), messages: [{ role: 'user', text: 7 }] },
      negativeCut: {
        ...valid(),
        messages: [{ role: 'user', text: 'x', cut: { kept_bytes: -1, full_bytes: 9 } }],
      },
      hiddenNotInteger: { ...valid(), messages: [{ role: 'user', text: 'x', hidden: 1.5 }] },
      droppedNegative: { ...valid(), dropped_messages: -2 },
      requestIdNumber: { ...valid(), requests: [{ request_id: 5, sent: [], reply: [] }] },
      toolsMissing: { recorded: true, messages: [], requests: [] },
      toolJsonNotString: { ...valid(), tools: [{ json: {} }] },
    };
    const seen: Record<string, string[]> = {};
    for (const [name, shape] of Object.entries(shapes)) {
      seen[name] = headingsOf(await inspect(await embedded(shape)));
    }
    // Break: no guard (the value read as the type says). Prints each shape's lines.
    expect(seen).toEqual(
      Object.fromEntries(
        Object.keys(shapes).map((n) => [n, ['Model text: could not be read on the record.']]),
      ),
    );
  }, 60_000);

  it('an entry with requests: [] prints its heading with 0; an empty sent or reply list prints `none`; a null id with a reply prints `no id`', async () => {
    const d0 = await embedded({ ...EMBEDDED, requests: [] });
    const d1 = await embedded({
      ...EMBEDDED,
      requests: [
        { request_id: null, sent: [], reply: [2] },
        { request_id: 'req-x', sent: [0], reply: [] },
        { request_id: null, sent: [0, 1], reply: null },
      ],
    });
    const out1 = await inspect(d1);
    // Prints the lines.
    expect({
      zero: headingsOf(await inspect(d0)),
      requests: requestLinesOf(out1),
      checks: checksOf(out1),
    }).toEqual({
      zero: ['Model text: 0 requests'],
      requests: [
        'Request 1 (no id): sent none; reply 3',
        'Request 2 (req-x): sent 1; reply none',
        'Request 3 (got no answer): sent 1, 2',
      ],
      checks: [NO_HASHES, NO_HASHES, NO_HASHES],
    });
  }, 30_000);
});

/** `record` with every `model_text` taken out, as the base's reader sees it (it reads none). */
function withoutTexts(record: RunRecord): RunRecord {
  const copy = structuredClone(record);
  for (const e of copy.evidence) delete e.model_text;
  for (const f of copy.drive_failures?.entries ?? []) delete f.model_text;
  return copy;
}

describe('gap 1, unit B — check 10: get_run_state and the output without --verbose', () => {
  it('get_run_state with include_steps, and inspect without --verbose, are the same byte for byte with the texts and without them', async () => {
    script = [reply([toolUse('toolu_1')]), reply([text(ANSWER)])];
    const ok = await drive(TOOLS, new AnthropicProvider('claude-x'));
    script = [reply([toolUse('toolu_1')]), dropped()];
    const failed = await drive(TOOLS, new AnthropicProvider('claude-x'));
    const compare = async (d: Driven) => {
      const def = registrar(d.def) as never;
      // `as_of` is the moment of the read, so it is left out of the comparison.
      const state = async (r: RunRecord) =>
        JSON.stringify(
          await handleGetRunState(
            { run_id: r.id, include_steps: true },
            { runStore: storeOf(r), workflowStore: def },
          ),
        ).replace(/"as_of":"[^"]*"/g, '"as_of":"…"');
      const plain = (r: RunRecord) => inspectRun(r.id, storeOf(r), def);
      const bare = withoutTexts(d.run);
      const withTexts = await plain(d.run);
      return {
        holdsTexts: JSON.stringify(d.run).includes('"model_text"'),
        state: (await state(d.run)) === (await state(bare)),
        plain: withTexts === (await plain(bare)),
        noLine: !withTexts.includes('Model text'),
      };
    };
    // Breaks: a field added to AttemptView (get_run_state then differs); a model-text line printed
    // without --verbose. Prints the comparisons.
    const same = { holdsTexts: true, state: true, plain: true, noLine: true };
    expect({ ok: await compare(ok), failed: await compare(failed) }).toEqual({
      ok: same,
      failed: same,
    });
  }, 30_000);
});

describe('gap 1, unit B — check 11: the page’s example is what inspect prints', () => {
  it('realm-run-reading.md’s `--verbose` model-text example, from the same run', async () => {
    const def = {
      id: 'triage',
      name: 'triage',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        classify: {
          description: 'Classify the ticket.',
          execution: 'agent',
          prompt: 'Classify this ticket: {{ run.params.ticket }}',
          input_schema: {
            type: 'object',
            properties: { category: { type: 'string' }, urgent: { type: 'boolean' } },
            required: ['category', 'urgent'],
          },
        },
      },
    } as unknown as WorkflowDefinition;
    script = [openAiReply('{"category":"billing","urgent":true}')];
    const d = await drive(def, new OpenAIProvider('gpt-5.5'), {
      params: { ticket: 'The customer was charged twice this month.' },
    });
    const out = await inspect(d);
    const lines = out.split('\n');
    // This run is driven in-process and records no driver, so inspect prints no `Taken by:` line
    // for it; the comparison starts at `Model text:`, as before. The page's `Taken by:` line, which
    // a `realm agent` drive prints, is pinned word for word by docs-gap1-b.test.ts.
    const from = lines.findIndex((l) => l.trim().startsWith('Model text:'));
    // The request's id is new on each run: the page's is compared with it set aside.
    const id = /\((\S+)\): sent/.exec(lines[from + 1] ?? '')?.[1] ?? '';
    const page = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../docs/reference/cli/realm-run-reading.md',
      ),
      'utf8',
    ).replace(/Request 1 \([0-9a-f-]{36}\)/, 'Request 1 (ID)');
    const shown = lines.slice(from).map((l) => l.replace(`(${id})`, '(ID)'));
    // (a) red when inspect's lines change and the page still shows the old ones; (b) prints each
    //     printed line the page lacks.
    expect({
      printed: shown.length,
      missing: shown.filter((l) => !page.includes(`${l}\n`)),
    }).toEqual({ printed: 11, missing: [] });
  }, 30_000);
});
