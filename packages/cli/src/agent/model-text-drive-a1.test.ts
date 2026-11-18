// Gap 1, unit A1 — a drive keeps each answered model call's text on the step's evidence entry. These
// cells drive `runAgent` against the repository's fake model servers (the real SDKs, over HTTP), and
// against provider modules (`--provider-module`), and read the run back from the store: the texts,
// the marker when recording is off or a module reports none, the join to each request's usage
// record, and where a text never goes.
//
// Each cell names the break that turns it red (prompts/gap1-a1-model-text-record.md) and prints
// counts, flags and the fake texts only.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  ExtensionRegistry,
  type EvidenceSnapshot,
  type ModelText,
  type RunRecord,
  type UsageRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { startOpenAiStub } from './test-support/openai-stub.js';
import { startAnthropicStub } from './test-support/anthropic-stub.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import {
  LlmProvider,
  ToolCapableLlmProvider,
  type CallStepWithMetaResult,
} from './providers/llm-provider.js';
import type { McpClient, McpTool, StepWithToolsResult } from './mcp/mcp-extensions.js';
import type { ModelTextReport } from './providers/model-text.js';
import { runAgent, type AgentDeps } from './run-agent.js';
import { agentCommand, buildReattachFlags } from '../commands/agent.js';
import { listenCommand, makeAgentSpawner } from '../commands/listen.js';

const SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
};
const PROMPT = 'Summarise the change in one line.';
const definition = {
  id: 'model-text-a1',
  name: 'Model text A1',
  version: 1,
  schema_version: 1,
  steps: {
    ask: { description: PROMPT, execution: 'agent', depends_on: [], input_schema: SCHEMA },
  },
} as unknown as WorkflowDefinition;

/** Drives the one step with `provider` and returns the run as the store keeps it. */
async function drive(
  provider: LlmProvider,
  extra: Partial<AgentDeps> = {},
): Promise<{ result: string; run: RunRecord }> {
  const store = new InMemoryStore();
  const { record } = await store.create({
    workflowId: definition.id,
    workflowVersion: 1,
    params: {},
  });
  const result = await runAgent(
    {
      store,
      workflowStore: {
        register: async () => {},
        get: async () => definition,
        list: async () => [],
      },
      provider,
      registry: new ExtensionRegistry(),
      ...extra,
    } as unknown as AgentDeps,
    { existingRunId: record.id, definition, params: {} },
  );
  return { result, run: (await store.get(record.id)).record };
}

/** The step's entries that carry a model call's usage. */
const entriesOf = (run: RunRecord): EvidenceSnapshot[] =>
  run.evidence.filter((e) => e.step_id === 'ask' && e.diagnostics?.cache !== undefined);

/** Every usage record the run holds, on its evidence and its failed drives. */
const usageRecordsOf = (run: RunRecord): UsageRecord[] => [
  ...run.evidence.flatMap((e) => e.diagnostics?.cache?.requests ?? []),
  ...(run.drive_failures?.entries ?? []).flatMap((f) => f.usage ?? []),
];

/** How many keys holding a model call's text `value` carries, at any depth. */
const textKeys = (value: unknown): number =>
  (JSON.stringify(value ?? null).match(/"(model_text|modelText)"/g) ?? []).length;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) {
    saved[name] = process.env[name];
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** The system text an Anthropic request sent: a string, or its text blocks joined. */
const systemOf = (system: unknown): string =>
  typeof system === 'string'
    ? system
    : (system as Array<{ text: string }>).map((block) => block.text).join('');

describe('gap 1, unit A1 — an answered call keeps its text', () => {
  it('check 1 (OpenAI): a single-shot call keeps the system text, the prompt and the reply, under its request id', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-test-model-text-a1-0000';
    const stub = await startOpenAiStub({ finalContent: { summary: 'one line' } });
    try {
      const { result, run } = await drive(new OpenAIProvider('gpt-x', stub.baseUrl));
      const [entry] = entriesOf(run);
      const text = entry?.model_text as Extract<ModelText, { recorded: true }> | undefined;
      const wire = stub.requests[0]!.messages as Array<{ role: string; content: string }>;
      // (1) red when the request's id is not copied onto its text (the step then records
      //     `provider_did_not_report`), or a text differs from what the wire carried; (2) prints
      //     the record's messages, its request and the usage record's id.
      expect({
        result,
        recorded: text?.recorded,
        messages: text?.messages,
        requests: text?.requests,
        usageIds: entry?.diagnostics?.cache?.requests.map((r) => r.request_id),
        textKeysOnUsage: textKeys(usageRecordsOf(run)),
      }).toEqual({
        result: 'completed',
        recorded: true,
        messages: [
          { role: 'system', text: wire[0]!.content },
          { role: 'user', text: PROMPT },
          { role: 'assistant', text: '{"summary":"one line"}' },
        ],
        requests: [
          {
            request_id: entry?.diagnostics?.cache?.requests[0]?.request_id,
            sent: [0, 1],
            reply: [2],
          },
        ],
        usageIds: [expect.any(String)],
        textKeysOnUsage: 0,
      });
      // The instrument: the wire's system text is the step's, with its schema.
      expect(wire[0]!.role).toBe('system');
      expect(wire[0]!.content).toContain(JSON.stringify(SCHEMA));
    } finally {
      await stub.close();
    }
  }, 30_000);

  it('check 1 (Anthropic): a single-shot call keeps the system text, the prompt, its tool list and the reply, under its request id', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-model-text-a1-0000';
    const stub = await startAnthropicStub({ finalContent: { summary: 'one line' } });
    process.env['ANTHROPIC_BASE_URL'] = stub.baseUrl;
    try {
      const { result, run } = await drive(new AnthropicProvider('claude-x'));
      const [entry] = entriesOf(run);
      const text = entry?.model_text as Extract<ModelText, { recorded: true }> | undefined;
      const wire = stub.requests[0] as { system: unknown; tools: unknown };
      // (1) red when the id is not copied (the marker instead), or a text differs from the wire's;
      //     (2) prints the record's messages, tools and request, and the usage record's id.
      expect({
        result,
        messages: text?.messages,
        tools: text?.tools,
        requests: text?.requests,
      }).toEqual({
        result: 'completed',
        messages: [
          { role: 'system', text: systemOf(wire.system) },
          { role: 'user', text: PROMPT },
          { role: 'assistant', text: '{"summary":"one line"}' },
        ],
        tools: [{ json: JSON.stringify(wire.tools) }],
        requests: [
          {
            request_id: entry?.diagnostics?.cache?.requests[0]?.request_id,
            sent: [0, 1],
            tools: 0,
            reply: [2],
          },
        ],
      });
      expect(typeof text?.requests[0]?.request_id).toBe('string');
    } finally {
      await stub.close();
    }
  }, 30_000);
});

/** A provider module: answers `summary`, with one usage record, and reports what it is given. */
class ModuleProvider extends LlmProvider {
  calls = 0;
  constructor(
    private readonly report: (call: number) => ModelTextReport[] | undefined,
    private readonly answer: (call: number) => Record<string, unknown> = () => ({
      summary: 'from a module',
    }),
    private readonly failOn?: number,
  ) {
    super();
  }
  async callStep(): Promise<Record<string, unknown>> {
    return { summary: 'from a module' };
  }
  override async callStepWithMeta(): Promise<CallStepWithMetaResult> {
    const call = ++this.calls;
    const usage = [
      {
        request_index: 0,
        request_start: '2026-01-01T00:00:00.000Z',
        model: 'module-model',
        prompt_tokens: 1,
        output_tokens: 1,
      } as UsageRecord,
    ];
    if (call === this.failOn) {
      throw Object.assign(new Error('the module call failed on purpose'), {
        driveCall: { usage },
      });
    }
    const modelText = this.report(call);
    return { output: this.answer(call), usage, ...(modelText !== undefined ? { modelText } : {}) };
  }
}

const SECRET = 'FAKE-a1-module-secret-0000';
const readable = (replyText: string): ModelTextReport => ({
  sent: [
    { role: 'system', content: 'module system' },
    { role: 'user', content: 'module prompt' },
  ],
  reply: [{ role: 'assistant', content: replyText }],
});

describe('gap 1, unit A1 — a provider module, and the switch', () => {
  it('check 7: a module that reports no texts, or not one per request, or one Realm cannot read, gives provider_did_not_report; one that reports is kept masked', async () => {
    const markerOf = async (report: () => ModelTextReport[] | undefined, extra = {}) =>
      entriesOf((await drive(new ModuleProvider(report), extra)).run)[0]?.model_text;
    const reported = (await markerOf(() => [readable(`holds ${SECRET}`)], {
      redactionValues: [SECRET],
    })) as Extract<ModelText, { recorded: true }> | undefined;
    // (1) red when a module that reports nothing leaves no marker (the field absent), or a module's
    //     text is kept unmasked; (2) prints each case's field.
    expect({
      none: await markerOf(() => undefined),
      twoForOne: await markerOf(() => [readable('a'), readable('b')]),
      unreadable: await markerOf(() => [
        { sent: [{ role: 'robot', content: 'x' }], reply: [] } as ModelTextReport,
      ]),
      offWins: await markerOf(() => undefined, { recordModelText: false }),
      reportedReply: reported?.messages[2],
    }).toEqual({
      none: { recorded: false, why: 'provider_did_not_report' },
      twoForOne: { recorded: false, why: 'provider_did_not_report' },
      unreadable: { recorded: false, why: 'provider_did_not_report' },
      offWins: { recorded: false, why: 'switched_off' },
      reportedReply: { role: 'assistant', text: 'holds [REDACTED]', hidden: 1 },
    });
  }, 30_000);

  it('check 8: a drive that fails after an answered call writes a drive-failure entry with no text key, and no usage record carries one', async () => {
    // Call 1 answers with an output the schema refuses (the #217 repair), call 2 throws.
    const provider = new ModuleProvider(
      () => [readable('{"wrong":1}')],
      () => ({ wrong: 1 }),
      2,
    );
    const { result, run } = await drive(provider, { schemaRetries: 1 });
    const failure = run.drive_failures?.entries[0];
    // (1) red when a text is put on a usage record (it then rides the failure's usage); (2) prints
    //     the result, the calls, the failure's usage count and the text keys counted.
    expect({
      result,
      calls: provider.calls,
      failureUsage: failure?.usage?.length,
      textKeysOnFailures: textKeys(run.drive_failures),
      textKeysOnUsage: textKeys(usageRecordsOf(run)),
    }).toEqual({
      result: 'failed',
      calls: 2,
      failureUsage: 2,
      textKeysOnFailures: 0,
      textKeysOnUsage: 0,
    });
  }, 30_000);

  it('check 6: --no-record-model-text gives the marker; realm listen passes it to its drives; the re-attach command repeats it', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-test-model-text-a1-0000';
    const stub = await startOpenAiStub({ finalContent: { summary: 'one line' } });
    let field: unknown;
    try {
      const { run } = await drive(new OpenAIProvider('gpt-x', stub.baseUrl), {
        recordModelText: false,
      });
      field = entriesOf(run)[0]?.model_text;
    } finally {
      await stub.close();
    }
    const argv: string[][] = [];
    const spawn = ((_cmd: string, args: string[]) => {
      argv.push(args);
      const child = Object.assign(new EventEmitter(), { pid: 7, unref: () => {} });
      setImmediate(() => child.emit('spawn'));
      return child;
    }) as never;
    const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
    await makeAgentSpawner({ model: 'm', recordModelText: false }, silent, spawn)('run-1', '.');
    await makeAgentSpawner({ model: 'm' }, silent, spawn)('run-2', '.');
    // (1) red when the flag is not passed through (listen's drives, or the re-attach command), or
    //     the drive keeps texts with it set; (2) prints the field, both argvs and both flag lists.
    expect({
      field,
      listenOff: argv[0]!.includes('--no-record-model-text'),
      listenOn: argv[1]!.includes('--no-record-model-text'),
      reattachOff: buildReattachFlags({ model: 'm', recordModelText: false }),
      reattachOn: buildReattachFlags({ model: 'm', recordModelText: true }),
    }).toEqual({
      field: { recorded: false, why: 'switched_off' },
      listenOff: true,
      listenOn: false,
      reattachOff: '--model m --no-record-model-text',
      reattachOn: '--model m',
    });
  }, 30_000);
});

describe('gap 1, unit A1 — the words (check 13)', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const flat = (text: string): string => text.replace(/\s+/g, ' ');
  const HELP =
    "--no-record-model-text Do not keep the text of each model call on the run's record. The step notes that recording was off.";

  it('the flag help on realm agent and realm listen, and the CHANGELOG lines', () => {
    const log = flat(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'));
    const unreleased = log.slice(log.indexOf('## [Unreleased]'), log.indexOf('## [0.'));
    // (1) red when a sentence is missing or reworded; (2) prints each check.
    expect({
      agent: flat(agentCommand.helpInformation()).includes(HELP),
      listen: flat(listenCommand.helpInformation()).includes(HELP),
      added: unreleased.includes(
        '- `EvidenceSnapshot.model_text` (optional): the text of each model call Realm sends and receives under `realm agent` and `realm listen`, masked, each text capped at 64 KB, on by default; `realm agent --no-record-model-text` and `realm listen --no-record-model-text` turn it off.',
      ),
      rows: unreleased.includes(
        "- In the library, `EvidenceSnapshot` gains `model_text`, a `ModelText`: the texts of each model call of the attempt, or a marker saying why there are none. `StepMeta` gains `modelText`, which the engine writes on the attempt's entry as `model_text`.",
      ),
    }).toEqual({ agent: true, listen: true, added: true, rows: true });
  });
});

/** A tool-capable provider module: its tool path and its strict path each answer with one usage
 *  record and that request's text. */
class ToolModule extends ToolCapableLlmProvider {
  async callStep(): Promise<Record<string, unknown>> {
    return { summary: 'from a module' };
  }
  override async callStepWithMeta(): Promise<CallStepWithMetaResult> {
    return {
      output: { summary: 'strict answer' },
      meta: { requested: true, sent: true },
      usage: [usageRecord()],
      modelText: [readable('{"summary":"strict answer"}')],
    };
  }
  async callStepWithTools(): Promise<StepWithToolsResult> {
    return {
      output: { summary: 'tool answer' },
      toolCalls: [],
      usage: [usageRecord()],
      modelText: [readable('{"summary":"tool answer"}')],
    };
  }
}
const usageRecord = (): UsageRecord =>
  ({
    request_index: 0,
    request_start: '2026-01-01T00:00:00.000Z',
    model: 'module-model',
    prompt_tokens: 1,
    output_tokens: 1,
  }) as UsageRecord;
const mcpClient: McpClient = {
  async connect() {},
  async getTools(_serverId: string, allowList: string[]): Promise<McpTool[]> {
    return allowList.map((name) => ({
      name,
      description: 'A tool',
      inputSchema: { type: 'object' },
    }));
  },
  async call() {
    return { result: 'ok' };
  },
  async disconnect() {},
};

describe('gap 1, unit A1 — the tool path and the strict path join each text to its request', () => {
  /** The step's one entry's field and the id of its one usage record, after a drive of `step`. */
  const joined = async (step: Record<string, unknown>, extra: Partial<WorkflowDefinition> = {}) => {
    const def = {
      ...definition,
      ...extra,
      steps: { ask: { ...definition.steps['ask'], ...step } },
    } as unknown as WorkflowDefinition;
    const store = new InMemoryStore();
    const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const result = await runAgent(
      {
        store,
        workflowStore: { register: async () => {}, get: async () => def, list: async () => [] },
        provider: new ToolModule(),
        registry: new ExtensionRegistry(),
        mcpClientFactory: () => mcpClient,
      } as unknown as AgentDeps,
      { existingRunId: record.id, definition: def, params: {} },
    );
    const entry = entriesOf((await store.get(record.id)).record)[0];
    const text = entry?.model_text as Extract<ModelText, { recorded: true }> | undefined;
    return {
      result,
      recorded: text?.recorded,
      idsMatch:
        typeof text?.requests[0]?.request_id === 'string' &&
        text.requests[0].request_id === entry?.diagnostics?.cache?.requests[0]?.request_id,
      reply: text?.messages[2]?.text,
    };
  };

  it('check 1 (the tool path and the strict path): each kept text carries its request id', async () => {
    const tools = await joined({ tools: ['srv:t'] }, {
      mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-srv'] }],
    } as unknown as Partial<WorkflowDefinition>);
    const strict = await joined({ structured_output: 'strict' });
    // (1) red when the tool path's or the strict path's id is not copied onto its text (that path
    //     then records `provider_did_not_report`); (2) prints each drive's result and field.
    expect({ tools, strict }).toEqual({
      tools: {
        result: 'completed',
        recorded: true,
        idsMatch: true,
        reply: '{"summary":"tool answer"}',
      },
      strict: {
        result: 'completed',
        recorded: true,
        idsMatch: true,
        reply: '{"summary":"strict answer"}',
      },
    });
  }, 30_000);
});
