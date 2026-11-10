// step-cache-choices-3m.test.ts — caching 3-M piece D-2 in process: under `--prompt-cache auto`, each
// agent step's lifetime is chosen from its own gaps in the workflow's earlier runs
// (`chooseStepCaches`, the function `realm agent` calls), and `runAgent` passes the step's choice on
// every one of its calls. The earlier runs sit on the real SQLite store (`openCliHome` on a scratch
// home); the requests go through the REAL Anthropic adapter to the in-test stand-in, or through a
// provider double that records what each call was handed. No real measured gaps exist on record
// (C3M7-21): every gap here is constructed, set back from the host's clock in the rhythm of the real
// case each cell names. Every value is a fake. Each assertion names (a) the change that turns it red
// and (b) what it prints when it fails: steps, gaps, choices and the record's facts, never a prompt.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  type RunRecord,
  type UsageRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { inspectRun } from '../commands/inspect.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';
import { readEarlierRuns, type EarlierRuns } from './earlier-runs.js';
import { runAgent } from './run-agent.js';
import { chooseStepCaches, type StepCacheChoices } from './step-cache-choices.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import { LlmProvider, type CallCacheChoice } from './providers/llm-provider.js';
import { startAnthropicStub, type AnthropicStub } from './test-support/anthropic-stub.js';
import type { McpClient, McpTool } from './mcp/mcp-extensions.js';

const PRICES_FULL = JSON.stringify({
  version: 1,
  currency: 'USD',
  models: {
    'claude-x': {
      prices: [
        {
          per_million_tokens: {
            input: 3,
            output: 15,
            cache_read: 0.3,
            cache_write_5m: 3.75,
            cache_write_1h: 6,
          },
        },
      ],
    },
  },
});

const workflow = (id: string, steps: Record<string, unknown>, extra = {}): WorkflowDefinition =>
  ({
    id,
    name: 'auto per step 3-M',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
    ...extra,
  }) as unknown as WorkflowDefinition;
const step = (extra: Record<string, unknown> = {}) => ({
  description: 'Answer.',
  execution: 'agent',
  ...extra,
});
const RHYTHMS = workflow('d2-rhythms', { a: step(), b: step({ depends_on: ['a'] }) });
const TOOLS = workflow(
  'd2-tools',
  { classify: step({ tools: ['srv:t'] }) },
  { mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-srv'] }] },
);

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
const registrarOf = (def: WorkflowDefinition) => ({
  async register() {},
  async get() {
    return def;
  },
  async list() {
    return [def];
  },
});

/** An instant `s` seconds before now, as a request's start is stored. */
const ago = (s: number): string => new Date(Date.now() - s * 1000).toISOString();

let root: string;
let pricesFile: string;
/** The stand-in for a step without tools (it answers at once), and one for a tool step (a tool
 *  call first, then the answer). */
let stub: AnthropicStub;
let toolStub: AnthropicStub;
const homes: TempHome[] = [];
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'realm-3m-d2-'));
  pricesFile = join(root, 'prices.json');
  writeFileSync(pricesFile, PRICES_FULL);
  stub = await startAnthropicStub({ finalContent: { summary: 'ok' } });
  toolStub = await startAnthropicStub({
    finalContent: { summary: 'ok' },
    firstToolCall: { match: /t/, arguments: {} },
  });
});
afterAll(async () => {
  await stub.close();
  await toolStub.close();
  rmSync(root, { recursive: true, force: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const h of homes.splice(0)) await h.cleanup();
});

/** A scratch home with `def` registered. */
async function homeFor(def: WorkflowDefinition): Promise<TempHome> {
  const h = await makeTempHome();
  homes.push(h);
  await h.home.workflowStore.register(def);
  return h;
}

/** An earlier run of `def` on the store, each named step's request started at its instant. */
async function seedEarlier(h: TempHome, def: WorkflowDefinition, starts: Record<string, string>) {
  const store = h.home.runStore;
  const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  const evidence = Object.entries(starts).map(([stepId, start]) => ({
    step_id: stepId,
    started_at: record.created_at,
    completed_at: record.created_at,
    duration_ms: 1,
    input_summary: {},
    output_summary: {},
    status: 'success',
    evidence_hash: 'a'.repeat(40),
    diagnostics: {
      input_token_estimate: 1,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [{ request_index: 0, request_in_call: 0, request_start: start }],
      },
    },
  }));
  await store.update({
    ...record,
    completed_steps: Object.keys(starts),
    evidence,
  } as unknown as RunRecord);
}

/** The Anthropic adapter as `realm agent` builds it under `auto`, against the stand-in. */
function anthropic(
  by: 'realm agent' | 'realm listen',
  at: AnthropicStub = stub,
): AnthropicProvider {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-d2-0000');
  vi.stubEnv('ANTHROPIC_BASE_URL', at.baseUrl);
  return new AnthropicProvider('claude-x', {
    promptCache: {
      value: 'auto',
      source: 'runner_default',
      by,
      auto:
        by === 'realm agent'
          ? { basis: 'no_measurement' }
          : { basis: 'listen_trigger_gaps', gaps_s: [] },
    },
    endpoint: 'default',
  });
}

/** One drive of `def` with the choices, through `runAgent`; returns the run and what was sent. */
async function drive(
  h: TempHome,
  def: WorkflowDefinition,
  provider: LlmProvider,
  stepCacheChoices: StepCacheChoices,
  at: AnthropicStub = stub,
) {
  const store = h.home.runStore;
  const before = new Set(await runIds(store));
  const sentBefore = at.requests.length;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await runAgent(
    {
      store,
      workflowStore: registrarOf(def),
      provider,
      registry: createDefaultRegistry(),
      mcpClientFactory: () => client,
      stepCacheChoices,
    },
    { definition: def, params: {} },
  );
  const id = (await runIds(store)).find((r) => !before.has(r))!;
  return { run: (await store.get(id)).record, sent: at.requests.slice(sentBefore) };
}

/** What a body asked to cache: each `system` block's marker, or `plain` for unmarked text. */
const systemMarks = (body: Record<string, unknown>) => {
  const system = body['system'];
  return Array.isArray(system)
    ? (system as Array<Record<string, unknown>>).map((b) => b['cache_control'] ?? null)
    : 'plain';
};
const requestsOf = (run: RunRecord, stepId: string): UsageRecord[] =>
  run.evidence.filter((e) => e.step_id === stepId).at(-1)?.diagnostics?.cache?.requests ?? [];
const asked = (r: UsageRecord | undefined) => ({
  requested: r?.cache_requested,
  lifetime: r?.cache_lifetime_s,
  auto: r?.cache_auto,
});

describe('caching 3-M D-2 — check 2: two steps, two rhythms', () => {
  // The real case: one workflow whose first step runs on every trigger, about every 20 minutes, and
  // whose second runs on some triggers only, about every 3 hours. Constructed gaps; the price file at
  // Anthropic's rates (a 20-minute gap is read under 1 hour; a 3-hour one is written every time).
  it('each step asks what its own gaps pay for: A one hour, B nothing; each records its own gaps', async () => {
    const h = await homeFor(RHYTHMS);
    for (const k of [3, 2, 1])
      await seedEarlier(h, RHYTHMS, { a: ago(k * 1200), b: ago(k * 10800) });
    const provider = anthropic('realm agent');
    const { choices } = await chooseStepCaches({
      definition: RHYTHMS,
      earlierRuns: await readEarlierRuns(h.home.runStore, RHYTHMS, undefined),
      rule: provider.autoStepRule()!,
      settleAuto: undefined,
      economicsPath: pricesFile,
      model: 'claude-x',
    });
    const { run, sent } = await drive(h, RHYTHMS, provider, choices);
    const [a, b] = [requestsOf(run, 'a')[0], requestsOf(run, 'b')[0]];
    const lastWithin = (r: UsageRecord | undefined, gap: number): boolean => {
      const last = r?.cache_auto?.gaps_s?.at(-1) ?? -1;
      return last >= gap && last <= gap + 5;
    };
    // (a) red when the workflow's gaps are used for both steps (B is then read under 1 hour, or A
    //     goes off), or when the choice is not passed to the step's call (both ask the instance's 5
    //     minutes); (b) prints each body's markers, each record's ask, and whether each last gap is
    //     the host's reading within 5 seconds.
    expect({
      bodies: sent.map(systemMarks),
      a: asked(a),
      b: asked(b),
      lastGaps: [lastWithin(a, 1200), lastWithin(b, 10800)],
    }).toEqual({
      bodies: [[{ type: 'ephemeral', ttl: '1h' }], 'plain'],
      a: {
        requested: 'lifetime',
        lifetime: 3600,
        auto: {
          basis: 'step_gaps',
          gaps_s: [1200, 1200, expect.any(Number)],
          prices: { from: 'economics' },
        },
      },
      b: {
        requested: 'off',
        lifetime: undefined,
        auto: {
          basis: 'step_gaps',
          gaps_s: [10800, 10800, expect.any(Number)],
          prices: { from: 'economics' },
        },
      },
      lastGaps: [true, true],
    });
  }, 60_000);
});

/** The step's earlier requests, as C2's read hands them over: one every `every` seconds. */
const rhythm = (stepId: string, every: number): EarlierRuns =>
  new Map([
    [
      stepId,
      [1, 2, 3].map((k) => ({
        run_id: `r${String(k)}`,
        request: { request_index: 0, request_start: ago(k * every) } as UsageRecord,
      })),
    ],
  ]);

describe('caching 3-M D-2 — check 5: a step with tools', () => {
  // The real case: a step that calls tools, run every 3 hours or every 20 minutes, started by
  // `realm agent` or by `realm listen`. Its own turns reuse the entry, so it always asks 5 minutes.
  it.each<[string, number, 'realm agent' | 'realm listen']>([
    ['gaps of 3 hours, realm agent', 10800, 'realm agent'],
    ['gaps of 20 minutes, realm agent', 1200, 'realm agent'],
    ['gaps of 3 hours, realm listen', 10800, 'realm listen'],
    ['gaps of 20 minutes, realm listen', 1200, 'realm listen'],
  ])(
    '%s: every main turn asks five minutes and records tool_step',
    async (_case, every, by) => {
      const h = await homeFor(TOOLS);
      const provider = anthropic(by, toolStub);
      const { choices } = await chooseStepCaches({
        definition: TOOLS,
        earlierRuns: rhythm('classify', every),
        rule: provider.autoStepRule()!,
        settleAuto: undefined,
        economicsPath: pricesFile,
        model: 'claude-x',
      });
      const { run, sent } = await drive(h, TOOLS, provider, choices, toolStub);
      // (a) red when the tool step is run through the rule (3 hours goes off, 20 minutes goes to 1
      //     hour) or the choice does not reach the tool path; (b) prints each request's ask and each
      //     body's markers. The stand-in answers a tool turn, then the step: two main turns.
      expect({
        turns: requestsOf(run, 'classify').map(asked),
        marks: sent.map(systemMarks),
      }).toEqual({
        turns: [
          { requested: 'lifetime', lifetime: 300, auto: { basis: 'tool_step' } },
          { requested: 'lifetime', lifetime: 300, auto: { basis: 'tool_step' } },
        ],
        marks: [[{ type: 'ephemeral' }], [{ type: 'ephemeral' }]],
      });
    },
    60_000,
  );
});

describe('caching 3-M D-2 — check 7 (a tool step): the read failed', () => {
  // The real case: the read of the workflow's earlier runs failed, and the step calls tools.
  it('a step with tools still asks five minutes, recorded tool_step', async () => {
    const { choices } = await chooseStepCaches({
      definition: TOOLS,
      earlierRuns: undefined,
      rule: anthropic('realm listen').autoStepRule()!,
      settleAuto: undefined,
      economicsPath: pricesFile,
      model: 'claude-x',
    });
    // (a) red when the failed read is tested before the step's tools (it records
    //     step_gaps_unreadable and asks the listen prior); (b) prints the choice.
    expect(choices.get('classify')).toEqual({ choice: 'short', auto: { basis: 'tool_step' } });
  });
});

const STATUS_SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['OK'] } },
  required: ['status'],
};
/** A provider double: records the choice each call was handed; answers wrong once, then right. */
class Recording extends LlmProvider {
  readonly seen: Array<CallCacheChoice | undefined> = [];
  private readonly answers: Array<Record<string, unknown>> = [
    { status: 'WRONG' },
    { status: 'OK' },
  ];
  async callStep(): Promise<Record<string, unknown>> {
    throw new Error('not reached: runAgent calls callStepWithMeta');
  }
  override async callStepWithMeta(
    _prompt: string,
    _schema?: Record<string, unknown>,
    _profile?: string,
    opts?: { cacheChoice?: CallCacheChoice },
  ) {
    this.seen.push(opts?.cacheChoice);
    return { output: this.answers.shift() ?? { status: 'OK' } };
  }
}

describe('caching 3-M D-2 — check 9: every call of the step', () => {
  const CHOICE: CallCacheChoice = {
    choice: 'long',
    auto: { basis: 'step_gaps', gaps_s: [1200], prices: { from: 'economics' } },
  };
  // The real case: the step's first answer does not fit its schema, so Realm asks again in the same
  // drive (a repair attempt). Both calls must ask what the step chose.
  it.each<[string, Record<string, unknown>]>([
    ['a step without structured_output', {}],
    ['a step with structured_output: strict', { structured_output: 'strict' }],
  ])(
    '%s: the repair attempt carries the step’s choice',
    async (_case, extra) => {
      const def = workflow('d2-repair', {
        draft: step({ output_schema: STATUS_SCHEMA, ...extra }),
      });
      const h = await homeFor(def);
      const provider = new Recording();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await runAgent(
        {
          store: h.home.runStore,
          workflowStore: registrarOf(def),
          provider,
          registry: createDefaultRegistry(),
          schemaRetries: 2,
          stepCacheChoices: new Map([['draft', CHOICE]]),
        },
        { definition: def, params: {} },
      );
      // (a) red when only the first attempt's call passes the choice, or when one of the two
      //     single-shot arms leaves it out (that arm's row); (b) prints what each call was handed.
      expect(provider.seen).toEqual([CHOICE, CHOICE]);
    },
    30_000,
  );
});

describe('caching 3-M D-2 — check 11: the words', () => {
  /** A stored request of `auto`, as the Anthropic adapter records it. */
  const ask = (
    by: string,
    lifetime: number | 'off',
    cacheAuto: unknown,
  ): Record<string, unknown> => ({
    request_index: 0,
    request_in_call: 0,
    request_start: ago(1),
    provider: 'anthropic',
    ...(lifetime === 'off'
      ? { cache_requested: 'off' }
      : {
          cache_requested: 'lifetime',
          cache_lifetime_s: lifetime,
          cache_ttl_sent: lifetime === 3600,
        }),
    cache_requested_source: 'runner_default',
    cache_requested_by: by,
    cache_auto: cacheAuto,
  });
  const LISTEN = "realm listen's default";
  const AGENT = "realm agent's default";
  // The real case each names: what `realm run inspect` says of a step's ask, read off a record on the
  // real store.
  it.each<[string, Record<string, unknown>, string]>([
    [
      'step_gaps, one gap',
      ask('realm listen', 3600, {
        basis: 'step_gaps',
        gaps_s: [1200],
        prices: { from: 'economics' },
      }),
      `asked for 1 hour (sent as 1 hour; ${LISTEN}; auto: the last gap between this step's runs was about 20 minutes; priced from your price file)`,
    ],
    [
      'step_gaps, three gaps',
      ask('realm listen', 3600, {
        basis: 'step_gaps',
        gaps_s: [1200, 1200, 1200],
        prices: { from: 'economics' },
      }),
      `asked for 1 hour (sent as 1 hour; ${LISTEN}; auto: the last 3 gaps between this step's runs were about 20 minutes, 20 minutes and 20 minutes; priced from your price file)`,
    ],
    [
      'step_gaps, no gap',
      ask('realm agent', 300, { basis: 'step_gaps', gaps_s: [] }),
      `asked for 5 minutes (the provider's default lifetime; ${AGENT}; auto: Realm found no earlier request of this step from the last 7 days)`,
    ],
    [
      'step_gaps_unreadable',
      ask('realm listen', 3600, { basis: 'step_gaps_unreadable' }),
      `asked for 1 hour (sent as 1 hour; ${LISTEN}; auto: Realm could not read this workflow's earlier runs)`,
    ],
    [
      'tool_step',
      ask('realm listen', 300, { basis: 'tool_step' }),
      `asked for 5 minutes (the provider's default lifetime; ${LISTEN}; auto: a step that calls tools reuses its own turns, so auto does not choose for it)`,
    ],
    [
      'realm agent, no price file, a gap of 20 minutes',
      ask('realm agent', 'off', {
        basis: 'step_gaps',
        gaps_s: [1200],
        prices: { from: 'none', cause: 'no_file' },
      }),
      `asked for no caching (${AGENT}; auto: the last gap between this step's runs was about 20 minutes; no price file (runner.cache.economics is not set), and no gap was under 270 seconds, so no caching)`,
    ],
    [
      'realm agent, no price file, a gap of 2 minutes',
      ask('realm agent', 300, {
        basis: 'step_gaps',
        gaps_s: [120],
        prices: { from: 'none', cause: 'no_file' },
      }),
      `asked for 5 minutes (the provider's default lifetime; ${AGENT}; auto: the last gap between this step's runs was about 2 minutes; no price file (runner.cache.economics is not set), so 5 minutes without prices)`,
    ],
  ])('%s', async (_case, request, words) => {
    const def = workflow('d2-words', { ask: step() });
    const h = await homeFor(def);
    const { record } = await h.home.runStore.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    await h.home.runStore.update({
      ...record,
      completed_steps: ['ask'],
      evidence: [
        {
          step_id: 'ask',
          started_at: record.created_at,
          completed_at: record.created_at,
          duration_ms: 1,
          input_summary: {},
          output_summary: {},
          status: 'success',
          evidence_hash: 'a'.repeat(40),
          diagnostics: {
            input_token_estimate: 1,
            precondition_trace: [],
            cache: { state: 'engaged', basis: 'provider_reported', requests: [request] },
          },
        },
      ],
    } as unknown as RunRecord);
    const out = await inspectRun(record.id, h.home.runStore, registrarOf(def) as never);
    // (a) red when two of the switch's arms are swapped, or when the fallback's words do not read the
    //     drive's prior from `by` (a drive realm agent started then says 54 minutes, or leaves out the
    //     5-minute tail); (b) prints the inspect line.
    const line = out.split('\n').find((l) => l.includes('asked for')) ?? '';
    expect(line.slice(line.indexOf('asked for'))).toBe(words);
  });
});

describe('caching 3-M D-2 follow-up — the guards the first cells did not hold', () => {
  // Real case: an operator states `--prompt-cache off` (or short, or long) on OpenAI in the explicit
  // set (GPT-5.6 or later at OpenAI's own address). Nothing may be chosen for a stated setting; the
  // provider's refusal to offer a rule is what keeps `chooseFromPriceFile` from choosing. Can fail:
  // the `value !== 'auto'` half of OpenAI's `autoStepRule` removed (a stated `off` is then given a
  // 30-minute choice and asks OpenAI to cache against the operator's word). Prints the setting.
  const openai = (value: 'auto' | 'off' | 'short' | 'long'): OpenAIProvider =>
    new OpenAIProvider('gpt-5.6-luna', undefined, false, {
      endpoint: 'default',
      promptCache: {
        value,
        source: value === 'auto' ? 'runner_default' : 'stated',
        by: 'realm agent',
        ...(value === 'auto' ? { auto: { basis: 'no_measurement' as const } } : {}),
      },
    });
  it.each(['off', 'short', 'long'] as const)(
    'OpenAI in the explicit set, stated %s: the provider offers no rule',
    (value) => {
      expect({ value, rule: openai(value).autoStepRule() }).toEqual({ value, rule: undefined });
    },
  );
  it('OpenAI in the explicit set under auto offers its rule (the control: the cells above can see a rule)', () => {
    expect(openai('auto').autoStepRule()).toBeDefined();
  });

  // Real case: a workflow author writes `tools: []` on a step (the loader accepts it, A3MD2-14): the
  // step runs single-shot, so it is chosen by its gaps. Can fail: the test `tools.length > 0` read as
  // `tools !== undefined` (the step is recorded `tool_step` and asks five minutes whatever its gaps).
  // Prints the choice.
  it('a step declared with an empty tools list is a step without tools: chosen by its gaps', async () => {
    const def = workflow('d2-empty-tools', { a: step({ tools: [] }) });
    const { choices } = await chooseStepCaches({
      definition: def,
      earlierRuns: rhythm('a', 1200),
      rule: anthropic('realm agent').autoStepRule()!,
      settleAuto: undefined,
      economicsPath: pricesFile,
      model: 'claude-x',
    });
    expect(choices.get('a')).toMatchObject({ choice: 'long', auto: { basis: 'step_gaps' } });
  });

  // Real case: every agent step of the workflow calls tools, an earlier run exists and the price file
  // named is broken. Nothing needs a price, so the file is not read and nothing warns of it. Can fail:
  // `needsPrice` counting a tool step (the file is read and "the price file could not be used" prints
  // about a step that needs no price). The control row: a step without tools on the same broken file
  // does warn, so a silent file would be seen. Prints the warning.
  it.each([
    ['only tool steps: no read, no warning', TOOLS, 'classify', undefined],
    ['a step without tools on the same file: the warning (the control)', RHYTHMS, 'a', 'string'],
  ] as const)('a broken price file, %s', async (_name, def, stepName, expected) => {
    const out = await chooseStepCaches({
      definition: def,
      earlierRuns: rhythm(stepName, 1200),
      rule: anthropic('realm agent').autoStepRule()!,
      settleAuto: undefined,
      economicsPath: join(root, 'no-such-prices.json'),
      model: 'claude-x',
    });
    expect(out.warning === undefined ? undefined : typeof out.warning).toBe(expected);
  });
});
