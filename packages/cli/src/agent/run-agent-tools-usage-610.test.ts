// run-agent-tools-usage-610.test.ts — issue #610 at the driver: `realm agent` records what a tool-
// using step's requests cost — on its evidence when it succeeds, on the drive-failure record when it
// fails (an earlier #217 repair attempt's requests in front), on the validation wedge, and never
// twice. Driven through the real `runAgent` with a scripted provider double and the real
// `executeChain`; the reader cells render the record the drive wrote. Every value is a fake. Each
// assertion names (a) the change that turns it red and (b) what it prints when it fails: counts,
// indexes, states and rendered lines only.
import { describe, it, expect, vi } from 'vitest';
import { runAgent } from './run-agent.js';
import type { RunRecord, UsageRecord, WorkflowDefinition } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { ToolCapableLlmProvider } from './providers/llm-provider.js';
import type { McpClient, McpTool, StepWithToolsResult } from './mcp/mcp-extensions.js';
import { inspectRun } from '../commands/inspect.js';
import type { PriceSource } from '@sensigo/realm';

/** One request record, distinct by its start and its counts (the driver's double-count key). */
const rec = (i: number, prompt: number): UsageRecord => ({
  request_index: i,
  request_start: `2026-10-27T10:00:0${i}.000Z`,
  prompt_tokens: prompt,
  output_tokens: prompt / 10,
  model: 'claude-test-1',
});

type Turn =
  | { output: Record<string, unknown>; toolCalls?: number; usage?: UsageRecord[] }
  | { throw: true; usage?: UsageRecord[] };

/** A tool-capable provider double: each call answers the next turn (the last repeats). */
function providerOf(turns: Turn[]) {
  let call = 0;
  const provider = new (class extends ToolCapableLlmProvider {
    capabilities() {
      return { jsonMode: false };
    }
    callStep = vi.fn();
    callStepWithTools = vi.fn(async (): Promise<StepWithToolsResult> => {
      const t = turns[Math.min(call, turns.length - 1)]!;
      call += 1;
      if ('throw' in t) {
        const err = new Error('the model service went away');
        if (t.usage !== undefined) Object.assign(err, { driveCall: { usage: t.usage } });
        throw err;
      }
      return {
        output: t.output,
        toolCalls: Array.from({ length: t.toolCalls ?? 0 }, () => ({
          server_id: 'srv',
          tool: 't',
          args: {},
          result: 'ok',
          duration_ms: 1,
        })),
        ...(t.usage !== undefined ? { usage: t.usage } : {}),
      };
    });
  })();
  return provider;
}

const client: McpClient = {
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

/** One tools step `classify`; `extra` adds to it, `after` adds steps after it. */
function workflow(
  extra: Record<string, unknown> = {},
  after: Record<string, unknown> = {},
): WorkflowDefinition {
  return {
    id: 'tools-usage-610',
    name: 'tools usage',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-srv'] }],
    steps: {
      classify: {
        description: 'Classify',
        execution: 'agent',
        tools: ['srv:t'],
        output_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['category'],
          properties: { category: { type: 'string' } },
        },
        ...extra,
      },
      ...after,
    },
  } as unknown as WorkflowDefinition;
}

async function drive(def: WorkflowDefinition, turns: Turn[]) {
  const store = new InMemoryStore();
  const workflowStore = {
    async register() {},
    async get() {
      return def;
    },
    async list() {
      return [def];
    },
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runAgent(
      {
        store,
        workflowStore,
        provider: providerOf(turns),
        registry: createDefaultRegistry(),
        mcpClientFactory: () => client,
      },
      { definition: def, params: {} },
    );
  } finally {
    vi.restoreAllMocks();
  }
  const run = (await store.list())[0]! as RunRecord;
  const stepEntry = run.evidence.filter((e) => e.step_id === 'classify').at(-1);
  return { store, workflowStore, run, stepEntry };
}

const indexesOf = (u: UsageRecord[] | undefined) => (u ?? []).map((r) => r.request_index);
const promptsOf = (u: UsageRecord[] | undefined) => (u ?? []).map((r) => r.prompt_tokens);

describe('#610 — realm agent records a tool-using step’s requests', () => {
  it('D1: a step that succeeds with 3 requests — its evidence carries all 3, through executeChain', async () => {
    const { stepEntry } = await drive(workflow(), [
      {
        output: { category: 'billing' },
        toolCalls: 1,
        usage: [rec(0, 100), rec(1, 200), rec(2, 300)],
      },
    ]);
    const requests = stepEntry?.diagnostics?.cache?.requests;
    // (a) red when the success path does not append the tools result's usage; (b) prints the
    //     indexes and prompt tokens.
    expect({ indexes: indexesOf(requests), prompt: promptsOf(requests) }).toEqual({
      indexes: [0, 1, 2],
      prompt: [100, 200, 300],
    });
  });

  it('D2: a step repaired by #217 (attempt 1: no tool calls, invalid output, 2 requests) whose attempt 2 throws after 1 — the failure record holds 3, attempt 1’s first', async () => {
    const { run } = await drive(workflow(), [
      { output: {}, usage: [rec(0, 100), rec(1, 200)] },
      { throw: true, usage: [rec(0, 300)] },
    ]);
    const usage = run.drive_failures?.entries.at(-1)?.usage;
    // (a) red when the tools catch does not put the earlier attempt's requests in front; (b)
    //     prints the indexes and prompt tokens.
    expect({ indexes: indexesOf(usage), prompt: promptsOf(usage) }).toEqual({
      indexes: [0, 1, 2],
      prompt: [100, 200, 300],
    });
  });

  it('D2b: attempt 1 reported no usage and attempt 2 threw bare — the failure record has NO usage field, never an empty list', async () => {
    const { run } = await drive(workflow(), [{ output: {} }, { throw: true }]);
    const entry = run.drive_failures?.entries.at(-1);
    // (a) red when the catch drops `usageForStep.length > 0` (an empty `usage` appears); (b) prints
    //     whether `usage` is present and its length.
    expect({
      recorded: entry !== undefined,
      hasUsage: entry !== undefined && 'usage' in entry,
    }).toEqual({ recorded: true, hasUsage: false });
  });

  it('D3: a provider whose callStepWithTools reports no usage — the entry says `unobservable`, never `tool_calling_step`', async () => {
    const { stepEntry, store, workflowStore, run } = await drive(workflow(), [
      { output: { category: 'billing' }, toolCalls: 1 },
    ]);
    const out = await inspectRun(run.id, store, workflowStore as never);
    // (a) red when the success path appends only when the provider reported (no `cache`: the step
    //     reads as a tool-calling step that recorded nothing); (b) prints the state and a boolean.
    expect({
      state: stepEntry?.diagnostics?.cache?.state,
      toolCallingLine: out.includes('cost: not recorded — tool-calling'),
    }).toEqual({ state: 'unobservable', toolCallingLine: false });
  });

  it('D4: the validation wedge — 1 tool call, invalid output (no repair), 2 requests — carries both, and inspect says what they billed before the rejection', async () => {
    const { run, store, workflowStore } = await drive(workflow(), [
      { output: {}, toolCalls: 1, usage: [rec(0, 100), rec(1, 200)] },
    ]);
    const entry = run.drive_failures?.entries.at(-1);
    const out = await inspectRun(run.id, store, workflowStore as never);
    // (a) red when the success path does not append the tools result's usage (the wedge then
    //     carries none); (b) prints the class, the indexes and whether the line is there.
    expect({
      errorClass: entry?.error_class,
      indexes: indexesOf(entry?.usage),
      line: out.includes('usage: 2 requests billed before the output was rejected'),
    }).toEqual({ errorClass: 'validation_rejected', indexes: [0, 1], line: true });
  });

  it('D5: no double count — the #220 default-settle snapshot carries the step’s requests, and the wedge a later step’s input refusal causes does not carry them again', async () => {
    const def = workflow(
      {
        validation_exhaustion: {
          threshold: 1,
          mode: 'default',
          default_output: { category: 'other' },
        },
      },
      {
        after: {
          description: 'After',
          execution: 'auto',
          depends_on: ['classify'],
          // Refused on its input inside the same chain: the rejection belongs to a step
          // executeChain ran AFTER the driven one, which had already saved with its calls.
          input_schema: {
            type: 'object',
            required: ['done'],
            properties: { done: { type: 'boolean' } },
          },
        },
      },
    );
    const { run } = await drive(def, [
      { output: {}, toolCalls: 1, usage: [rec(0, 100), rec(1, 200)] },
    ]);
    const onEvidence = run.evidence.flatMap((e) => e.diagnostics?.cache?.requests ?? []).length;
    const onFailures = (run.drive_failures?.entries ?? []).flatMap((e) => e.usage ?? []).length;
    // (a) red when the wedge skips `callsAlreadyRecorded` (each request counted twice); (b) prints
    //     the counts on the evidence and on the failure records.
    expect({ onEvidence, onFailures, wedges: run.drive_failures?.entries.length ?? 0 }).toEqual({
      onEvidence: 2,
      onFailures: 0,
      wedges: 1,
    });
  });
});

describe('#610 — the readers show the record a drive wrote', () => {
  it('V1′: the step D1’s drive recorded renders measured, totals across its 3 requests, and no `cost: not recorded` line', async () => {
    const { run, store, workflowStore } = await drive(workflow(), [
      {
        output: { category: 'billing' },
        toolCalls: 1,
        usage: [rec(0, 100), rec(1, 200), rec(2, 300)],
      },
    ]);
    const out = await inspectRun(run.id, store, workflowStore as never);
    // (a) red when the drive's records lose the step's usage; (b) prints two booleans.
    expect({
      measured: out.includes('totals across 3 requests'),
      notRecorded: out.includes('cost: not recorded'),
    }).toEqual({ measured: true, notRecorded: false });
  });

  it('V4: a priced run — the run’s `Cost:` line counts the tools step’s requests and does not call it not measured', async () => {
    const { run, store, workflowStore } = await drive(workflow(), [
      { output: { category: 'billing' }, toolCalls: 1, usage: [rec(0, 100), rec(1, 200)] },
    ]);
    const prices: PriceSource = {
      price: () => ({
        priced: { total: 0.01, uncached_counterfactual: 0.01 },
        priced_by: {
          source_class: 'economics',
          source_ref: '/srv/prices.yaml',
          matched_model: 'claude-test-1',
          date_basis: 'dated',
        },
      }),
    };
    const out = await inspectRun(run.id, store, workflowStore as never, { priceSource: prices });
    const costLine = out.split('\n').find((l) => l.trimStart().startsWith('Cost: ')) ?? '(none)';
    // (a) red when the drive's records lose the step's usage (the line then says the attempt was
    //     not measured, or prices none); (b) prints the `Cost:` line.
    expect(
      {
        counted: costLine.includes('2 of 2 requests priced'),
        notMeasured: costLine.includes('not measured'),
      },
      costLine,
    ).toEqual({ counted: true, notMeasured: false });
  });
});
