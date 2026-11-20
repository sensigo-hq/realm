// Gap 1, unit A2b — a failed drive writes the text of its model calls on its drive-failure entry:
// the answered requests whose usage is on the entry and, when the last request got no answer, that
// request as sent, masked, within one 64 KB budget per entry, or a marker. These cells drive the real
// `runAgent` against the real `InMemoryStore`, with the real providers over scripted SDKs (each body
// deep-copied when it is sent, as A1's cells do) or with provider modules, and read the entry back.
//
// Each cell names the break that turns it red (prompts/gap1-a2b-failed-drive-capture.md) and prints
// the entry's field, counts and the fake texts only. No real key is used.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  type DriveFailureModelText,
  type DriveFailureRecord,
  type ModelText,
  type RunRecord,
  type Snapshot,
  type UsageRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent, type AgentDeps } from './run-agent.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import { LlmProvider, type CallStepWithMetaResult } from './providers/llm-provider.js';
import { setAdditionalRedactionValues } from './providers/agent-utils.js';
import {
  MODEL_TEXT_CAP_BYTES,
  anthropicSentText,
  budgetFailureText,
  carriedTexts,
  failureModelTextOf,
  joinFailedCall,
  openAiSentText,
  type ModelTextReport,
} from './providers/model-text.js';
import { buildEntry } from './drive-failure.js';
import type { McpClient, McpTool } from './mcp/mcp-extensions.js';

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
/** A scripted answer, a throw, or a send that never answers. */
const HANG = Symbol('hang');
type Scripted = unknown;
const throws = (err: unknown) => ({ [THROW]: err });
const THROW = Symbol('throw');

/** Each request body as it was sent, deep-copied at the call. */
let sent: Body[] = [];
let script: Scripted[] = [];

beforeEach(() => {
  sent = [];
  script = [];
  for (const create of [anthropicCreate, openaiCreate]) {
    create.mockReset();
    create.mockImplementation(async (body: Body) => {
      sent.push(structuredClone(body));
      const next = script.shift();
      if (next === undefined) throw new Error('the test scripted no further reply');
      if (next === HANG) return new Promise(() => undefined);
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
  vi.restoreAllMocks();
  setAdditionalRedactionValues([]);
});

const PROMPT = 'Answer the question in one word.';
const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const USAGE = { input_tokens: 10, output_tokens: 1 };
type Block = { type: string; [key: string]: unknown };
const reply = (content: Block[]) => ({ model: 'claude-test-1', content, usage: USAGE });
const text = (t: string): Block => ({ type: 'text', text: t });
const toolUse = (id: string): Block => ({ type: 'tool_use', id, name: 'lookup', input: {} });
const dropped = () =>
  throws(Object.assign(new Error('the connection dropped'), { code: 'ECONNRESET' }));

const workflow = (
  id: string,
  step: Record<string, unknown>,
  extra: Partial<WorkflowDefinition> = {},
): WorkflowDefinition =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { ask: { description: PROMPT, execution: 'agent', output_schema: SCHEMA, ...step } },
    ...extra,
  }) as unknown as WorkflowDefinition;
const BARE = workflow('a2b-bare', {});
const TOOLS = workflow('a2b-tools', { tools: ['srv:lookup'] }, {
  mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-srv'] }],
} as unknown as Partial<WorkflowDefinition>);

const mcpClient: McpClient = {
  async connect() {},
  async getTools(_serverId: string, allowList: string[]): Promise<McpTool[]> {
    return allowList.map((name) => ({
      name,
      description: 'Look a thing up',
      inputSchema: { type: 'object' },
    }));
  },
  async call() {
    return { result: 'a fake tool result' };
  },
  async disconnect() {},
};

/** Drives `def` with `provider` on a new run and returns the outcome and the run as stored. */
async function drive(
  def: WorkflowDefinition,
  provider: LlmProvider,
  extra: Partial<AgentDeps> & { store?: InMemoryStore } = {},
): Promise<{ result: unknown; run: RunRecord }> {
  // #729 CW-5a: the store has the lease double, as every CLI drive's store has a lease port.
  const store = extra.store ?? new InMemoryStore({ leases: createLeaseDouble() });
  const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  const result = await runAgent(
    {
      store,
      workflowStore: { register: async () => {}, get: async () => def, list: async () => [def] },
      provider,
      registry: createDefaultRegistry(),
      mcpClientFactory: () => mcpClient,
      ...extra,
    } as unknown as AgentDeps,
    { existingRunId: record.id, definition: def, params: {} },
  ).catch((err: unknown) => err);
  return { result, run: (await store.get(record.id)).record };
}

type Recorded = Extract<DriveFailureModelText, { recorded: true }>;
const lastFailure = (run: RunRecord): DriveFailureRecord | undefined =>
  run.drive_failures?.entries[run.drive_failures.entries.length - 1];
const recordedOf = (entry: DriveFailureRecord | undefined): Recorded => {
  const t = entry?.model_text;
  if (t?.recorded !== true) throw new Error(`the entry kept no texts: ${JSON.stringify(t)}`);
  return t;
};
/** A request's sent texts, rebuilt from its numbers. */
const sentTexts = (t: Recorded, i: number) => t.requests[i]!.sent.map((n) => t.messages[n]!.text);
/** What a report's sent messages read as, in the canonical form (A1's function, through the report). */
const canonicalSent = (report: ModelTextReport) =>
  (report.sent as Array<{ content: string }>).map((m) => m.content);
const idsOf = (entry: DriveFailureRecord | undefined) =>
  (entry?.usage ?? []).map((u) => u.request_id);

describe('gap 1, unit A2b — a request that got no answer', () => {
  it('check 1 (Anthropic and OpenAI): a single call with no answer keeps one request, as sent, with no id and no reply', async () => {
    script = [dropped()];
    const anthropic = await drive(BARE, new AnthropicProvider('claude-x'));
    const aBody = sent[0]!;
    script = [dropped()];
    sent = [];
    const openai = await drive(BARE, new OpenAIProvider('gpt-x'));
    const oBody = sent[0]!;
    const shape = (entry: DriveFailureRecord | undefined) => {
      const t = recordedOf(entry);
      return {
        requests: t.requests,
        sentTexts: sentTexts(t, 0),
        tools: t.requests[0]?.tools !== undefined ? t.tools[t.requests[0].tools]!.json : undefined,
        usage: entry?.usage,
      };
    };
    // (1) red when the unanswered request's text is not carried (the entry then holds no request);
    //     (2) prints each entry's requests, texts and usage.
    expect({
      anthropic: shape(lastFailure(anthropic.run)),
      openai: shape(lastFailure(openai.run)),
    }).toEqual({
      anthropic: {
        requests: [{ request_id: null, sent: [0, 1], tools: 0, reply: null }],
        sentTexts: canonicalSent(anthropicSentText(aBody)),
        tools: JSON.stringify(aBody['tools']),
        usage: undefined,
      },
      openai: {
        requests: [{ request_id: null, sent: [0, 1], reply: null }],
        sentTexts: canonicalSent(openAiSentText(oBody)),
        tools: undefined,
        usage: undefined,
      },
    });
  }, 30_000);

  it('check 2: a tool loop failing on turn 3 keeps turns 1–2 under the entry’s usage ids, then turn 3; shared messages once', async () => {
    script = [reply([toolUse('toolu_1')]), reply([toolUse('toolu_2')]), dropped()];
    const { run } = await drive(TOOLS, new AnthropicProvider('claude-x'));
    const entry = lastFailure(run);
    const t = recordedOf(entry);
    // (1) red when the texts are joined before the ids are minted (they then cannot be joined);
    //     (2) prints the requests, the usage ids and how often the prompt is kept.
    expect({
      requests: t.requests,
      ids: idsOf(entry),
      promptKept: t.messages.filter((m) => m.text === PROMPT).length,
      lastSent: sentTexts(t, 2),
    }).toEqual({
      requests: [
        { request_id: idsOf(entry)[0], sent: [0, 1], tools: 0, reply: [2] },
        { request_id: idsOf(entry)[1], sent: [0, 1, 2, 3], tools: 0, reply: [4] },
        { request_id: null, sent: [0, 1, 2, 3, 4, 5], tools: 0, reply: null },
      ],
      ids: [expect.any(String), expect.any(String)],
      promptKept: 1,
      lastSent: canonicalSent(anthropicSentText(sent[2]!)),
    });
  }, 30_000);

  it('check 3: a throw after the last answer (Anthropic, not JSON after the retry) keeps both answered requests, and none unanswered', async () => {
    script = [reply([text('not json')]), reply([text('still not json')])];
    const { run } = await drive(BARE, new AnthropicProvider('claude-x'));
    const entry = lastFailure(run);
    const t = recordedOf(entry);
    // (1) red when the last request sent is recorded as unanswered; (2) prints the requests and ids.
    expect({
      requests: t.requests.map((r) => ({ id: r.request_id, reply: r.reply })),
      ids: idsOf(entry),
      replies: t.requests.map((r) => (r.reply ?? []).map((n) => t.messages[n]!.text)),
    }).toEqual({
      requests: [
        { id: idsOf(entry)[0], reply: [2] },
        { id: idsOf(entry)[1], reply: [4] },
      ],
      ids: [expect.any(String), expect.any(String)],
      replies: [['not json'], ['still not json']],
    });
  }, 30_000);

  it('check 4: strict 400, then the drop-retry hits the budget ceiling: aborted_by_budget, and the unanswered body is the drop-retry’s', async () => {
    script = [throws(Object.assign(new Error('bad schema'), { status: 400 })), HANG];
    const provider = new AnthropicProvider('claude-x');
    const err = await provider
      .callStepWithMeta(PROMPT, SCHEMA, undefined, {
        structuredOutputStrict: true,
        llmClock: { ceilingMs: 40, declaredPerAttemptMs: 15 },
      })
      .catch((e: unknown) => e);
    // The entry as the provider-call catch builds it: the class from the error as it reached the
    // catch, the texts the error carries joined to the entry's usage.
    const entry = buildEntry(err, 'ask', 'anthropic', performance.now(), new Date());
    const carried = carriedTexts(err);
    const t = failureModelTextOf(
      carried !== undefined ? joinFailedCall(entry.usage ?? [], carried) : { reported: false },
      true,
    ) as Recorded;
    // (1) red when the carrier wraps the error in a payload that hides its cause's class, or keeps
    //     the first failed body; (2) prints the class, the requests and which body the tools are.
    expect({
      class: entry.error_class,
      requests: t.requests,
      toolsAreTheRetry: t.tools[0]?.json === JSON.stringify(sent[1]!['tools']),
      retryDiffers: JSON.stringify(sent[0]!['tools']) !== JSON.stringify(sent[1]!['tools']),
    }).toEqual({
      class: 'aborted_by_budget',
      requests: [{ request_id: null, sent: [0, 1], tools: 0, reply: null }],
      toolsAreTheRetry: true,
      retryDiffers: true,
    });
  }, 30_000);

  it('check 5: a #217 repair call that fails after an answered one keeps the answered call with its id, then the failed one', async () => {
    script = [reply([text('{"wrong":1}')]), dropped()];
    const { run } = await drive(BARE, new AnthropicProvider('claude-x'), { schemaRetries: 1 });
    const entry = lastFailure(run);
    const t = recordedOf(entry);
    // (1) red when the step's earlier calls are not joined at that catch; (2) prints the requests.
    expect({
      requests: t.requests.map((r) => ({
        id: r.request_id,
        reply: r.reply === null ? null : r.reply.length,
      })),
      ids: idsOf(entry),
      failedSent: sentTexts(t, 1),
    }).toEqual({
      requests: [
        { id: idsOf(entry)[0], reply: 1 },
        { id: null, reply: null },
      ],
      ids: [expect.any(String)],
      failedSent: canonicalSent(anthropicSentText(sent[1]!)),
    });
  }, 30_000);
});

// Provider modules that report texts, for the writers that carry the step's answered calls.
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['OK'] } },
  required: ['status'],
};
const ONE_STEP = {
  id: 'a2b-one',
  name: 'a2b one',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { draft: { description: 'Draft', execution: 'agent', output_schema: OUTPUT_SCHEMA } },
} as WorkflowDefinition;
const usageRecord = (): UsageRecord =>
  ({
    request_index: 0,
    request_start: '2026-01-01T00:00:00.000Z',
    prompt_tokens: 1,
    output_tokens: 1,
  }) as UsageRecord;
const report = (n: number): ModelTextReport => ({
  sent: [{ role: 'user', content: `module prompt ${n}` }],
  reply: [{ role: 'assistant', content: `module reply ${n}` }],
});
/** A module provider: each call answers `outputs[i]` with one request and its text, or throws. */
class TextModule extends LlmProvider {
  calls = 0;
  constructor(
    private readonly outputs: Array<string | 'throw'>,
    private readonly texts = true,
  ) {
    super();
  }
  async callStep(): Promise<Record<string, unknown>> {
    return { status: 'OK' };
  }
  override async callStepWithMeta(): Promise<CallStepWithMetaResult> {
    const n = this.calls++;
    const out = this.outputs[n];
    if (out === undefined) throw new Error(`unscripted module call ${n + 1}`);
    if (out === 'throw') throw new Error('the module call failed on purpose');
    return {
      output: { status: out },
      usage: [usageRecord()],
      ...(this.texts ? { modelText: [report(n + 1)] } : {}),
    };
  }
}

describe('gap 1, unit A2b — the writers that carry the step’s answered calls', () => {
  it('check 6: chokepoint 3 before the step saved keeps the step’s answered requests, under the entry’s ids', async () => {
    // As repair-loop-usage's cell 5: the second read executeChain's own body makes throws, so the
    // step's second attempt never saves.
    class FaultStore extends InMemoryStore {
      private wrapperReads = 0;
      override async get(runId: string): Promise<Snapshot> {
        const caller = (new Error().stack ?? '').split('\n')[2] ?? '';
        if (/\bat executeChainBody \(/.test(caller)) {
          this.wrapperReads += 1;
          if (this.wrapperReads === 2) throw new Error('read failed');
        }
        return super.get(runId);
      }
    }
    const { result, run } = await drive(ONE_STEP, new TextModule(['BAD', 'OK']), {
      store: new FaultStore(),
    });
    const entry = lastFailure(run);
    const t = recordedOf(entry);
    // (1) red when that writer writes `requests: []`; (2) prints the requests and the usage ids.
    expect({
      threw: (result as Error).message,
      requests: t.requests.map((r) => r.request_id),
      ids: idsOf(entry),
      replies: t.requests.map((r) => t.messages[r.reply![0]!]!.text),
    }).toEqual({
      // Pinned as the real code says it: the engine wraps the store's failure.
      threw: 'Failed to load run from store: read failed',
      requests: idsOf(entry),
      ids: [expect.any(String), expect.any(String)],
      replies: ['module reply 1', 'module reply 2'],
    });
  }, 30_000);

  it('check 7 (no text twice, in one executeChain): a step that saved, then a step run after it throws: the failure has requests: [], and the texts are on the evidence entry only', async () => {
    // As chained-usage's chokepoint-3 cell: a store that drops `workflow_context_snapshots` (so each
    // step re-takes the snapshot) and throws on the second snapshot write, the chained `finish`'s,
    // after `draft` saved with its call. The throw leaves `executeChain` and reaches chokepoint 3,
    // whose "already recorded" guard answers once for the usage and the texts.
    // Pinned as the real code goes (CR-IAA2B-07): since #625 PR-2a a chained step refused on its
    // input is refused before its claim and recorded at the drive's exit, and a chained auto step's
    // output schema is not enforced, so this is where a failure after a save is written.
    const def = {
      id: 'a2b-chained-throw',
      name: 'a2b chained throw',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      workflow_context: { doc: { source: { path: '/nonexistent/realm-a2b-context.md' } } },
      steps: {
        draft: { description: 'Draft', execution: 'agent', output_schema: OUTPUT_SCHEMA },
        finish: {
          description: 'Finish',
          execution: 'auto',
          handler: 'finish_handler',
          depends_on: ['draft'],
        },
      },
    } as unknown as WorkflowDefinition;
    class SnapshotFailingStore extends InMemoryStore {
      private snapshotWrites = 0;
      override async update(record: RunRecord): Promise<Snapshot> {
        if (record.workflow_context_snapshots === undefined) return super.update(record);
        this.snapshotWrites += 1;
        if (this.snapshotWrites >= 2) throw new Error('snapshot write failed');
        const { workflow_context_snapshots: _dropped, ...rest } = record;
        void _dropped;
        return super.update(rest as RunRecord);
      }
    }
    const registry = createDefaultRegistry();
    registry.register('handler', 'finish_handler', {
      id: 'finish_handler',
      execute: async () => ({ data: { finished: true } }),
    });
    const { result, run } = await drive(def, new TextModule(['OK']), {
      registry,
      store: new SnapshotFailingStore(),
    });
    const evidence = run.evidence.find((e) => e.step_id === 'draft')?.model_text as
      Extract<ModelText, { recorded: true }> | undefined;
    // (1) red when the texts are attached without the "already recorded" guard; (2) prints both.
    expect({
      threw: (result as Error).message,
      completed: run.completed_steps,
      failure: lastFailure(run)?.model_text,
      failureUsage: lastFailure(run)?.usage,
      evidenceRequests: evidence?.requests.length,
    }).toEqual({
      threw: 'snapshot write failed',
      completed: ['draft'],
      failure: { recorded: true, messages: [], tools: [], requests: [] },
      failureUsage: undefined,
      evidenceRequests: 1,
    });
  }, 30_000);

  it('check 7 (no text twice, at the wedge after the repair budget): a chained step’s adapter refuses after the agent step saved: the failure has requests: [] and no usage, and the texts and usage are on the evidence entry only', async () => {
    // Correction 1 (CR-RDA2B-08): the agent step answers a relative path; the chained auto step
    // reads it through the built-in `filesystem` adapter, which refuses it with
    // VALIDATION_INPUT_SCHEMA ("path must be absolute") inside the same `executeChain`. The engine's
    // reply then reaches run-agent's wedge after the repair budget, whose "already recorded" guard
    // answers once for the usage and the texts.
    const def = {
      id: 'a2b-chained-adapter',
      name: 'a2b chained adapter',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      services: { files: { adapter: 'filesystem', trust: 'engine_delivered' } },
      steps: {
        draft: {
          description: 'Draft',
          execution: 'agent',
          output_schema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
        read: {
          description: 'Read',
          execution: 'auto',
          uses_service: 'files',
          operation: 'read',
          input_map: { path: 'context.resources.draft.path' },
          depends_on: ['draft'],
        },
        // An independent agent step still to run, so the run stays open when `read` fails and
        // the wedge's entry is written (a drive-failure entry is never written on an ended run).
        later: { description: 'Later', execution: 'agent' },
      },
    } as unknown as WorkflowDefinition;
    const provider = new (class extends LlmProvider {
      async callStep(): Promise<Record<string, unknown>> {
        return { path: 'notes.md' };
      }
      override async callStepWithMeta(): Promise<CallStepWithMetaResult> {
        return { output: { path: 'notes.md' }, usage: [usageRecord()], modelText: [report(1)] };
      }
    })();
    const { run } = await drive(def, provider);
    const failure = lastFailure(run);
    const draft = run.evidence.find((e) => e.step_id === 'draft');
    const evidenceText = draft?.model_text as Extract<ModelText, { recorded: true }> | undefined;
    // (1) red when the texts, or the usage, are attached at that wedge without the guard; (2)
    //     prints the failure and where the texts and usage are.
    expect({
      completed: run.completed_steps,
      failure: {
        step: failure?.step,
        class: failure?.error_class,
        message: failure?.message,
        model_text: failure?.model_text,
        usage: failure?.usage,
      },
      evidence: {
        requests: evidenceText?.requests.length,
        usage: draft?.diagnostics?.cache?.requests?.length,
      },
    }).toEqual({
      completed: ['draft'],
      failure: {
        step: 'read',
        class: 'validation_rejected',
        message: expect.stringContaining('path must be absolute'),
        model_text: { recorded: true, messages: [], tools: [], requests: [] },
        usage: undefined,
      },
      evidence: { requests: 1, usage: 1 },
    });
  }, 30_000);

  it('check 8: the wedge after the repair budget keeps its answered requests, under the entry’s ids', async () => {
    const { run } = await drive(ONE_STEP, new TextModule(['BAD', 'BAD', 'BAD']), {
      schemaRetries: 2,
    });
    const entry = lastFailure(run);
    const t = recordedOf(entry);
    // (1) red when that writer leaves the field out; (2) prints the class, the requests and ids.
    expect({
      class: entry?.error_class,
      requests: t.requests.map((r) => r.request_id),
      ids: idsOf(entry),
    }).toEqual({
      class: 'validation_rejected',
      requests: idsOf(entry),
      ids: [expect.any(String), expect.any(String), expect.any(String)],
    });
  }, 30_000);
});

// The budget, on texts as `modelTextOf` builds them (masked, each cut at 64 KB by A1).
const KB = 1024;
const fill = (char: string, bytes: number) => char.repeat(bytes);
const msg = (role: 'system' | 'user' | 'assistant' | 'tool', bytes: number, char: string) => ({
  role,
  text: fill(char, bytes),
});
const keptBytes = (t: Recorded) =>
  [...t.messages.map((m) => m.text), ...t.tools.map((x) => x.json)].reduce(
    (sum, s) => sum + Buffer.byteLength(s, 'utf8'),
    0,
  );

describe('gap 1, unit A2b — the 64 KB budget', () => {
  it('check 9 (over 64 KB): the failed request’s system text, prompt and tool list first, then the newest other messages; left-out slots marked; no index points at nothing', () => {
    // A #217 repair call that got no answer after an answered one: its prompt (B) is not the entry's
    // first prompt (A), so keeping the entry's first prompt instead is told apart. After the failed
    // request's system text, prompt and tool list, 37 KB are left: the newest other message (5,
    // 15 KB) and the next (2, 20 KB) fit, the older prompt A (1, 20 KB) then does not; oldest first
    // would keep A and leave 2 out. Message 3 is a text A1 had cut (its full size 200,000 bytes).
    const text: Extract<ModelText, { recorded: true }> = {
      recorded: true,
      messages: [
        msg('system', 4 * KB, 's'),
        msg('user', 20 * KB, 'a'),
        msg('assistant', 20 * KB, 'r'),
        {
          role: 'tool',
          text: fill('t', 64 * KB),
          cut: { kept_bytes: 64 * KB, full_bytes: 200_000 },
        },
        msg('user', 20 * KB, 'b'),
        msg('user', 15 * KB, 'n'),
      ],
      tools: [{ json: fill('j', 3 * KB) }],
      requests: [
        { request_id: 'r-1', sent: [0, 1, 3], tools: 0, reply: [2] },
        { request_id: null, sent: [0, 4, 5], tools: 0, reply: null },
      ],
    };
    const kept = budgetFailureText(text) as Recorded;
    const state = kept.messages.map((m) =>
      m.text === ''
        ? `out:${m.cut?.full_bytes}`
        : m.cut
          ? `cut:${m.cut.kept_bytes}/${m.cut.full_bytes}`
          : 'whole',
    );
    // (1) red when the others are kept oldest first, the entry's first prompt is kept instead of the
    //     failed request's, or a left-out slot's full size is its kept size; (2) prints each slot.
    expect({
      state,
      tools: kept.tools.map((x) => (x.json === '' ? 'out' : 'whole')),
      dropped: kept.dropped_messages,
      withinCap: keptBytes(kept) <= MODEL_TEXT_CAP_BYTES,
      indexesValid: kept.requests.every(
        (r) =>
          [...r.sent, ...(r.reply ?? [])].every((n) => kept.messages[n] !== undefined) &&
          (r.tools === undefined || kept.tools[r.tools] !== undefined),
      ),
    }).toEqual({
      state: ['whole', `out:${20 * KB}`, 'whole', 'out:200000', 'whole', 'whole'],
      tools: ['whole'],
      dropped: 2,
      withinCap: true,
      indexesValid: true,
    });
  });

  it('check 9 (a throw after the last answer): a 60 KB reply is kept, cut, before the prompt; a 2 KB reply is kept whole and the 61 KB prompt cut', () => {
    const answered = (replyBytes: number, promptBytes: number, systemBytes: number) =>
      budgetFailureText({
        recorded: true,
        messages: [
          msg('system', systemBytes, 's'),
          msg('user', promptBytes, 'p'),
          msg('assistant', replyBytes, 'r'),
        ],
        tools: [{ json: fill('j', 3 * KB) }],
        requests: [{ request_id: 'r-1', sent: [0, 1], tools: 0, reply: [2] }],
      }) as Recorded;
    const big = answered(60 * KB, 20 * KB, 5 * KB);
    const small = answered(2 * KB, 61 * KB, 4 * KB);
    // (1) red when the reply is left to step 3, or the prompt is kept before the reply; (2) prints
    //     each slot's kept size and full size.
    const sizes = (t: Recorded) => [
      ...t.messages.map((m) => [
        m.cut?.kept_bytes ?? Buffer.byteLength(m.text),
        m.cut?.full_bytes ?? null,
      ]),
      ...t.tools.map((x) => [
        x.cut?.kept_bytes ?? Buffer.byteLength(x.json),
        x.cut?.full_bytes ?? null,
      ]),
    ];
    expect({ big: sizes(big), small: sizes(small) }).toEqual({
      big: [
        [5 * KB, null],
        [0, 20 * KB],
        [64 * KB - 5 * KB, 60 * KB],
        [0, 3 * KB],
      ],
      small: [
        [4 * KB, null],
        [64 * KB - 4 * KB - 2 * KB, 61 * KB],
        [2 * KB, null],
        [0, 3 * KB],
      ],
    });
  });

  it('check 9 (through the writer): a failed call over 64 KB keeps at most 64 KB, its prompt cut and marked with its full size', async () => {
    const big = workflow('a2b-big', { description: `${PROMPT} ${fill('x', 70 * KB)}` });
    script = [dropped()];
    const { run } = await drive(big, new AnthropicProvider('claude-x'));
    const t = recordedOf(lastFailure(run));
    const prompt = t.messages[t.requests[0]!.sent[1]!]!;
    expect({
      withinCap: keptBytes(t) <= MODEL_TEXT_CAP_BYTES,
      promptCut: prompt.cut !== undefined && prompt.cut.full_bytes > prompt.cut.kept_bytes,
      fullIsTheWhole:
        prompt.cut?.full_bytes ===
        Buffer.byteLength(canonicalSent(anthropicSentText(sent[0]!))[1]!),
    }).toEqual({ withinCap: true, promptCut: true, fullIsTheWhole: true });
  }, 30_000);
});

const SECRET = 'FAKE-a2b-secret-value-0000';

describe('gap 1, unit A2b — the mask', () => {
  it('check 10: a fake secret in the agent profile (the system text, sent as written) is kept as [REDACTED]', async () => {
    const def = workflow('a2b-profile', { agent_profile: 'p' }, {
      resolved_profiles: { p: { content: `Keep the key ${SECRET} private.`, content_hash: 'h' } },
    } as unknown as Partial<WorkflowDefinition>);
    script = [dropped()];
    const { run } = await drive(def, new AnthropicProvider('claude-x'), {
      redactionValues: [SECRET],
    });
    const t = recordedOf(lastFailure(run));
    const system = t.messages[t.requests[0]!.sent[0]!]!;
    // (1) red when that text is kept without the mask; (2) prints whether the secret was sent and kept.
    expect({
      sentAsWritten: JSON.stringify(sent[0]!['system']).includes(SECRET),
      kept: JSON.stringify(t).includes(SECRET),
      redacted: system.text.includes('[REDACTED]'),
      hidden: system.hidden,
    }).toEqual({ sentAsWritten: true, kept: false, redacted: true, hidden: 1 });
  }, 30_000);

  it('check 10: a fake secret across the budget’s cut in the tool list is masked whole: no start of it is kept', () => {
    setAdditionalRedactionValues([SECRET]);
    const system = fill('s', 1000);
    const prompt = fill('p', 1000);
    // The tool list's JSON opens with `[{"description":"`; the secret starts 10 bytes before the point
    // where what is left of the budget ends, so a cut made before the mask would keep its start.
    const opening = '[{"description":"';
    const room = MODEL_TEXT_CAP_BYTES - system.length - prompt.length;
    const tools = [
      { description: `${fill('a', room - 10 - opening.length)}${SECRET}${fill('b', 4 * KB)}` },
    ];
    const t = failureModelTextOf(
      joinFailedCall([], {
        answered: [],
        unanswered: {
          sent: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          tools,
          reply: [],
        },
      }),
      true,
    ) as Recorded;
    // (1) red when the tool list is cut before it is masked; (2) prints whether any start was kept.
    expect({
      startKept: [6, 10, 16].some((n) => t.tools[0]!.json.includes(SECRET.slice(0, n))),
      cut: t.tools[0]!.cut !== undefined,
    }).toEqual({ startKept: false, cut: true });
  });
});

describe('gap 1, unit A2b — the writers with no model request, and the markers', () => {
  const PRE_CLAIM = {
    id: 'a2b-pre-claim',
    name: 'a2b pre-claim',
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

  it('check 11: the pre-claim wedge keeps recorded: true with no requests, and the switch’s marker when it is off', async () => {
    const on = await drive(PRE_CLAIM, new TextModule([]));
    const off = await drive(PRE_CLAIM, new TextModule([]), { recordModelText: false });
    // (1) red when that writer leaves the field out; (2) prints both entries' field.
    expect({
      on: { class: lastFailure(on.run)?.error_class, text: lastFailure(on.run)?.model_text },
      off: lastFailure(off.run)?.model_text,
    }).toEqual({
      on: {
        class: 'validation_rejected',
        text: { recorded: true, messages: [], tools: [], requests: [] },
      },
      off: { recorded: false, why: 'switched_off' },
    });
  }, 30_000);

  it('check 11: a module provider whose call throws with no texts gives provider_did_not_report, on its first call too; with the switch off, its marker wins', async () => {
    const first = await drive(ONE_STEP, new TextModule(['throw']));
    const later = await drive(ONE_STEP, new TextModule(['BAD', 'throw'], false), {
      schemaRetries: 1,
    });
    const off = await drive(ONE_STEP, new TextModule(['throw']), { recordModelText: false });
    // (1) red when such a failure is written with no marker; (2) prints each entry's field.
    expect({
      first: lastFailure(first.run)?.model_text,
      later: lastFailure(later.run)?.model_text,
      off: lastFailure(off.run)?.model_text,
    }).toEqual({
      first: { recorded: false, why: 'provider_did_not_report' },
      later: { recorded: false, why: 'provider_did_not_report' },
      off: { recorded: false, why: 'switched_off' },
    });
  }, 30_000);
});

describe('gap 1, unit A2b — the words (check 13)', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const flat = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

  it('the CHANGELOG lines, the drive_failures row and the field’s description', () => {
    const log = flat('CHANGELOG.md');
    const unreleased = log.slice(log.indexOf('## [Unreleased]'), log.indexOf('## [0.'));
    const source = flat('packages/core/src/types/run-record.ts').replace(/ \* /g, ' ');
    // (1) red when a line or row is missing or reworded; (2) prints each check.
    expect({
      // Gap 1, unit B: gap 1's two Added lines became one, which names the failure's texts.
      added: unreleased.includes(
        "- **The text of each model call is kept on the run's record** (gap 1). Under `realm agent` and `realm listen`, each model request a step makes that gets an answer keeps the text Realm sent, its tool list and the reply, on the step's evidence entry (`model_text`). A drive that fails keeps, on its drive-failure entry, the requests its failure covers, including a last request that got no answer. Known secret values are replaced by `[REDACTED]`. Each text is cut at 64 KB, and a failure keeps at most 64 KB in all, each cut marked with the text's full size. `realm run inspect --verbose` prints the texts under each step and failure, says why there are none, and checks each request's system text, tool list and prompt against the hashes Realm kept when it sent it (for a prompt built from a template, its text up to the first value the run fills in). On by default; `realm agent --no-record-model-text` or `realm listen --no-record-model-text` turns it off. `get_run_state` never shows the texts, and a listing of runs leaves them out.",
      ),
      a2aLine: unreleased.includes(
        '- In the library, `DriveFailureRecord` gains an optional `model_text`, a `DriveFailureModelText`. Stores list runs',
      ),
      notYet: unreleased.includes('which Realm does not write yet'),
      row: flat('docs/reference/run-record-and-export.md').includes(
        "| `model_text` | No | The text of the model requests this failure covers, kept by `realm agent` and `realm listen`: the answered requests whose `usage` is on this entry and, when the last request got no answer, that request as sent (its `request_id` and `reply` are `null`). The shape is the evidence entry's `model_text`, plus `dropped_messages`. Known secret values are replaced by `[REDACTED]`. The entry keeps at most 64 KB of text: first the system text and the prompt of the request that failed, or the last request's system text, its reply and then its prompt, then that request's tool list, then the newest other messages. A text left out keeps its place, empty, with a `cut` that gives its full size, and `dropped_messages` counts the messages left out. `requests: []` means no model request belongs to this entry: the drive failed before any, or the step's requests are on its evidence entry. A marker says why there are none: `switched_off` or `provider_did_not_report`. `get_run_state` never shows it. Added after version 0.50.0. |",
      ),
      field: source.includes(
        'Gap 1, unit A2: the text of the model requests this failure covers ({@link DriveFailureModelText}), or a marker saying why there is none. `realm agent` and `realm listen` write it on every drive-failure entry they write. `get_run_state` never shows it, and a listing of runs leaves it out.',
      ),
    }).toEqual({ added: true, a2aLine: true, notYet: false, row: true, field: true });
  });
});
