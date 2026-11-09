// earlier-runs-3m.test.ts — caching 3-M piece C2: a step's first request, when its own run holds
// nothing earlier for the step, carries a copy of the same step's request from the most recent earlier
// run of the workflow. Driven through the real `runAgent` on the real SQLite store (`openCliHome` on a
// scratch home), with a scripted provider double returning the capture's shape. No two-run capture
// exists: each cell pairs real shapes by construction. Every value is a fake. Each assertion names
// (a) the change that turns it red and (b) what it prints when it fails: ids, steps, `from` and
// instants, never a prompt's text.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord, UsageRecord, WorkflowDefinition } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import { settableClock, type SettableClock } from '@sensigo/realm-testing';
import { handleGetRunState } from '@sensigo/realm-mcp/dist/tools/get-run-state.js';
import { inspectRun } from '../commands/inspect.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';
import { readEarlierRuns, type EarlierRuns } from './earlier-runs.js';
import { runAgent } from './run-agent.js';
import { ToolCapableLlmProvider } from './providers/llm-provider.js';
import type { McpClient, McpTool, StepWithToolsResult } from './mcp/mcp-extensions.js';

const DAY_MS = 86_400_000;
const PROMPT_HEAD = 'c'.repeat(64);

/** A single-shot request as Anthropic's adapter returns it (`cache-reference-3m.test.ts`'s `billed`). */
const billed = (start: string, read = 500, write = 1500): UsageRecord => ({
  request_index: 0,
  request_start: start,
  prompt_tokens: 20 + read + write,
  uncached_input_tokens: 20,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: 7,
  cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 },
  model: 'claude-test-20260101',
  cache_requested: 'lifetime',
  cache_lifetime_s: 300,
  cache_ttl_sent: false,
  cache_requested_source: 'runner_default',
  cache_requested_by: 'realm agent',
  endpoint: 'default',
  cache_split_offered: true,
  prefix_sha256: PROMPT_HEAD,
  prefix_chars: 4000,
  prefix_parts: { system: 'b'.repeat(64), prompt: PROMPT_HEAD },
  cache_marked: ['system', 'prompt'],
  request_strict_sent: false,
});

/** A tool step's first turn: Anthropic's adapter marks the conversation, which holds the run's input. */
const toolTurn = (start: string, read: number, write: number): UsageRecord => ({
  ...billed(start, read, write),
  prefix_parts: { tools: 'a'.repeat(64), system: 'b'.repeat(64), prompt: PROMPT_HEAD },
  cache_marked: ['system', 'conversation'],
});

/** What a `reference` to `stored` holds: its copied fields, read off the stored request. */
const referenceTo = (stored: UsageRecord) => ({
  from: 'earlier_run',
  request_start: stored.request_start,
  request_id: stored.request_id,
  provider: stored.provider,
  model: stored.model,
  endpoint: stored.endpoint,
  cache_requested: stored.cache_requested,
  cache_read_input_tokens: stored.cache_read_input_tokens,
  cache_creation_input_tokens: stored.cache_creation_input_tokens,
  cache_creation: stored.cache_creation,
  cache_lifetime_s: stored.cache_lifetime_s,
  cache_ttl_sent: stored.cache_ttl_sent,
  prefix_chars: stored.prefix_chars,
  prefix_parts: stored.prefix_parts,
  cache_marked: stored.cache_marked,
  request_strict_sent: stored.request_strict_sent,
});

type Call =
  | { output: Record<string, unknown>; usage?: UsageRecord[] }
  | { throw: true; usage?: UsageRecord[] };

const ok = (...usage: UsageRecord[]): Call => ({ output: { status: 'OK' }, usage });
const noUsage: Call = { output: { status: 'OK' } };

/** A provider double: each model call, tools or single-shot, answers the next scripted call. */
function scripted(calls: Call[]) {
  let n = 0;
  const next = (): Call => {
    const call = calls[n];
    n += 1;
    if (call === undefined) throw new Error(`unscripted call ${String(n)}`);
    return call;
  };
  const thrown = (usage: UsageRecord[] | undefined): Error => {
    const err = new Error('the model service went away');
    if (usage !== undefined) Object.assign(err, { driveCall: { usage } });
    return err;
  };
  return new (class extends ToolCapableLlmProvider {
    capabilities() {
      return { jsonMode: false, providerId: 'anthropic' as const };
    }
    callStep = vi.fn();
    async callStepWithMeta() {
      const call = next();
      if ('throw' in call) throw thrown(call.usage);
      return { output: call.output, ...(call.usage !== undefined ? { usage: call.usage } : {}) };
    }
    async callStepWithTools(): Promise<StepWithToolsResult> {
      const call = next();
      if ('throw' in call) throw thrown(call.usage);
      return {
        output: call.output,
        toolCalls: [],
        ...(call.usage !== undefined ? { usage: call.usage } : {}),
      };
    }
  })();
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

const STATUS_SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['OK'] } },
  required: ['status'],
};

const agentStep = (extra: Record<string, unknown> = {}) => ({
  description: 'Draft',
  execution: 'agent',
  output_schema: STATUS_SCHEMA,
  ...extra,
});

const workflow = (id: string, steps: Record<string, unknown>, extra = {}): WorkflowDefinition =>
  ({
    id,
    name: 'earlier runs 3-M',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
    ...extra,
  }) as unknown as WorkflowDefinition;

const SINGLE = workflow('earlier-3m-single', { draft: agentStep() });
const TWO_STEPS = workflow('earlier-3m-two', {
  first: agentStep(),
  second: agentStep({ depends_on: ['first'] }),
});
const TOOLS = workflow(
  'earlier-3m-tools',
  {
    classify: {
      description: 'Classify',
      execution: 'agent',
      tools: ['srv:t'],
      output_schema: STATUS_SCHEMA,
    },
  },
  { mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-srv'] }] },
);
/** A step that settles failed at its first rejected answer (the #220 threshold of 1, `fail`). */
const FAILS_AT_ONCE = workflow('earlier-3m-single', {
  draft: agentStep({ validation_exhaustion: { threshold: 1, mode: 'fail' } }),
});
/** The step waits for a person after its answer: its request is on its evidence entry. */
const AT_A_GATE = workflow('earlier-3m-single', {
  draft: agentStep({ trust: 'human_confirmed' }),
});

type ReadStore = Parameters<typeof readEarlierRuns>[0];

interface Harness {
  h: TempHome;
  clock: SettableClock;
  tick: () => Promise<void>;
}

const opened: TempHome[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of opened.splice(0)) await h.cleanup();
});

async function open(): Promise<Harness> {
  const clock = settableClock('2026-11-08T12:00:00.000Z');
  const h = await makeTempHome({ clock });
  opened.push(h);
  return { h, clock, tick: () => clock.advance(1000) };
}

const registrarOf = (def: WorkflowDefinition) => ({
  async register() {},
  async get() {
    return def;
  },
  async list() {
    return [def];
  },
});

interface DriveOptions {
  runId?: string;
  /** The store the read is made on, when a cell watches or fails it. */
  readStore?: ReadStore;
  /** The run stops at its gate: the handler throws, as when a notifier cannot reach anyone. */
  gateThrows?: boolean;
}

/** One drive of `def`: the read, then `runAgent` with what it found (as `realm agent` does). */
async function drive(
  { h }: Harness,
  def: WorkflowDefinition,
  calls: Call[],
  options: DriveOptions = {},
): Promise<RunRecord> {
  const store = h.home.runStore;
  const before = new Set(await runIds(store));
  const earlierRuns = await readEarlierRuns(options.readStore ?? store, def, options.runId);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await runAgent(
      {
        store,
        workflowStore: registrarOf(def),
        provider: scripted(calls),
        registry: createDefaultRegistry(),
        mcpClientFactory: () => client,
        ...(earlierRuns !== undefined ? { earlierRuns } : {}),
        ...(options.gateThrows === true
          ? {
              gateHandler: async () => {
                throw new Error('no one can be reached');
              },
            }
          : {}),
      },
      {
        definition: def,
        params: {},
        ...(options.runId !== undefined ? { existingRunId: options.runId } : {}),
      },
    ).catch(() => undefined);
  } finally {
    vi.restoreAllMocks();
  }
  const id = options.runId ?? (await runIds(store)).find((r) => !before.has(r))!;
  return (await store.get(id)).record;
}

/** The step's requests on its latest evidence entry. */
const requestsOf = (run: RunRecord, step: string): UsageRecord[] =>
  run.evidence.filter((e) => e.step_id === step).at(-1)?.diagnostics?.cache?.requests ?? [];

/** A request's identity and source: what most checks compare. */
const copyOf = (r: UsageRecord | undefined) => ({
  from: r?.reference?.from,
  request_start: r?.reference?.request_start,
  request_id: r?.reference?.request_id,
});
const copied = (r: UsageRecord | undefined) =>
  r === undefined
    ? { from: undefined, request_start: undefined, request_id: undefined }
    : { from: 'earlier_run', request_start: r.request_start, request_id: r.request_id };

/** A read store that records each `get` and each `scan`, and can shrink the page. */
function watched(h: TempHome, pageSize?: number) {
  const store = h.home.runStore;
  const gets: string[] = [];
  let scans = 0;
  const readStore = {
    clock: store.clock,
    get: (id: string) => {
      gets.push(id);
      return store.get(id);
    },
    scan: (filter: never, options: { pageSize: number }) => {
      scans += 1;
      return store.scan(filter, {
        ...options,
        ...(pageSize !== undefined ? { pageSize } : {}),
        projection: 'row',
      });
    },
  } as unknown as ReadStore;
  return { readStore, gets, scans: () => scans };
}

const START = (minute: number): string =>
  `2026-11-08T10:${String(minute).padStart(2, '0')}:00.000Z`;

describe('caching 3-M C2 — the earlier run', () => {
  // The real case: most steps make one request per run. Pairs two real shapes by construction.
  it('check 1: the second run’s first request carries the first run’s request, `from: earlier_run`; the first run’s carries none', async () => {
    const t = await open();
    const first = await drive(t, SINGLE, [ok(billed(START(0)))]);
    await t.tick();
    const second = await drive(t, SINGLE, [ok(billed(START(10)))]);
    const before = requestsOf(first, 'draft')[0]!;
    // (a) red when `runAgent` ignores the data; (b) prints both references.
    expect({
      first: before.reference,
      second: requestsOf(second, 'draft')[0]?.reference,
    }).toEqual({ first: undefined, second: referenceTo(before) });
  });

  // A later request of the step carries no copy: a repair's second call.
  it('check 1: a repair in that drive — the second call’s request carries no copy', async () => {
    const t = await open();
    const first = await drive(t, SINGLE, [ok(billed(START(0)))]);
    await t.tick();
    const second = await drive(t, SINGLE, [
      { output: { status: 'BAD' }, usage: [billed(START(10))] },
      ok(billed(START(11))),
    ]);
    const [opener, repair] = requestsOf(second, 'draft');
    // (a) red when the copy is given without looking at the step's requests of this drive; (b)
    //     prints each request's source and the copied id.
    expect({ opener: copyOf(opener), repair: copyOf(repair) }).toEqual({
      opener: copied(requestsOf(first, 'draft')[0]),
      repair: copied(undefined),
    });
  });

  // A re-attached run whose earlier drive recorded the step, with an earlier run also on the store.
  it('check 3: this run’s own earlier drive wins over an earlier run', async () => {
    const t = await open();
    await drive(t, SINGLE, [ok(billed(START(0)))]);
    await t.tick();
    const failed = await drive(t, SINGLE, [{ throw: true, usage: [billed(START(5))] }]);
    await t.tick();
    const again = await drive(t, SINGLE, [ok(billed(START(10)))], { runId: failed.id });
    const own = requestsOf(again, 'draft')[0]?.reference;
    // (a) red when the order is swapped (the earlier run is preferred); (b) prints the source and
    //     the start the copy holds.
    expect({ from: own?.from, request_start: own?.request_start }).toEqual({
      from: 'run',
      request_start: START(5),
    });
  });
});

/** Puts one row on the store and answers the request the final drive should copy (none: undefined). */
type Row = (t: Harness) => Promise<UsageRecord | undefined>;

/** The older, ordinary run a row's newer run should give way to. */
async function olderRun(t: Harness): Promise<UsageRecord> {
  const run = await drive(t, SINGLE, [ok(billed(START(0)))]);
  await t.tick();
  return requestsOf(run, 'draft')[0]!;
}

const WHICH_RUN: [string, Row][] = [
  [
    // Break: the read opens only the workflow's newest run, whatever it holds.
    'the newest run never reached the step → the next run',
    async (t) => {
      const older = await olderRun(t);
      await t.h.home.runStore.create({
        workflowId: SINGLE.id,
        workflowVersion: 1,
        params: {},
      });
      return older;
    },
  ],
  [
    // Break: only the newest row naming the step is opened.
    "a run whose list names the step but holds no request (an MCP agent's) → the next run",
    async (t) => {
      const older = await olderRun(t);
      await drive(t, SINGLE, [noUsage]);
      return older;
    },
  ],
  [
    // Break: the scan's `workflow` filter dropped.
    "another workflow's newer run → not used",
    async (t) => {
      const older = await olderRun(t);
      await drive(t, workflow('earlier-3m-other', { draft: agentStep() }), [ok(billed(START(30)))]);
      return older;
    },
  ],
  [
    // Break: the scan's `updated_since` filter dropped.
    'a run updated more than 7 days ago → not used',
    async (t) => {
      await drive(t, SINGLE, [ok(billed(START(0)))]);
      await t.clock.advance(7 * DAY_MS + 1);
      return undefined;
    },
  ],
  [
    // Break: the window one millisecond shorter.
    'a run updated exactly 7 days ago, at the window’s edge → used',
    async (t) => {
      const run = await drive(t, SINGLE, [ok(billed(START(0)))]);
      await t.clock.advance(7 * DAY_MS);
      return requestsOf(run, 'draft')[0];
    },
  ],
  [
    // Break: the rule stops requiring `request_in_call` 0. An imported record, or one written before
    // the field existed, has none, so nothing says which request opened the step's last call.
    'an imported run with no `request_in_call` → not a candidate',
    async (t) => {
      const older = await olderRun(t);
      const store = t.h.home.runStore;
      const donor = await drive(t, workflow('earlier-3m-donor', { draft: agentStep() }), [
        ok(billed(START(30))),
      ]);
      const entry = donor.evidence.find((e) => e.step_id === 'draft')!;
      const { record } = await store.create({
        workflowId: SINGLE.id,
        workflowVersion: 1,
        params: {},
      });
      const { request_in_call: _gone, ...stripped } = entry.diagnostics!.cache!.requests![0]!;
      await store.update({
        ...record,
        completed_steps: ['draft'],
        evidence: [
          {
            ...entry,
            diagnostics: {
              ...entry.diagnostics,
              cache: { ...entry.diagnostics!.cache!, requests: [stripped as UsageRecord] },
            },
          },
        ],
      } as RunRecord);
      return older;
    },
  ],
  [
    // Break: the list filter removed, so the run is opened and its failed drive's request taken. The
    // call came before any claim, no list names the step, and a row carries no `drive_failures`.
    'a run whose model call threw (no list names the step), with an older completed run → the older',
    async (t) => {
      const older = await olderRun(t);
      await drive(t, SINGLE, [{ throw: true, usage: [billed(START(30))] }]);
      return older;
    },
  ],
  [
    // Break: `failed_steps` not read.
    'a step settled failed (its request on the evidence entry) → used',
    async (t) => {
      const run = await drive(t, FAILS_AT_ONCE, [
        { output: { status: 'BAD' }, usage: [billed(START(0))] },
      ]);
      expect(run.failed_steps).toEqual(['draft']);
      return requestsOf(run, 'draft')[0];
    },
  ],
  [
    // Break: `in_progress_steps` not read. Only that list names a step waiting at a person's gate.
    'a run waiting at a gate on the step → used',
    async (t) => {
      const run = await drive(t, AT_A_GATE, [ok(billed(START(0)))], { gateThrows: true });
      expect({ inProgress: run.in_progress_steps, completed: run.completed_steps }).toEqual({
        inProgress: ['draft'],
        completed: [],
      });
      return requestsOf(run, 'draft')[0];
    },
  ],
  [
    // Break: the found requests kept in the rows' order, updated last first.
    'two overlapping runs, the one updated last started earlier → the later `request_start`',
    async (t) => {
      const later = await drive(t, SINGLE, [ok(billed(START(20)))]);
      await t.tick();
      await drive(t, SINGLE, [ok(billed(START(5)))]);
      return requestsOf(later, 'draft')[0];
    },
  ],
  [
    // Break: the rows sorted oldest-updated first.
    'two requests with the same start → the run updated last',
    async (t) => {
      await drive(t, SINGLE, [ok(billed(START(20)))]);
      await t.tick();
      const last = await drive(t, SINGLE, [ok(billed(START(20)))]);
      return requestsOf(last, 'draft')[0];
    },
  ],
];

describe('caching 3-M C2 — check 4: which run', () => {
  it.each(WHICH_RUN)('%s', async (_name, row) => {
    const t = await open();
    const expected = await row(t);
    const final = await drive(t, SINGLE, [ok(billed(START(40)))]);
    // (a) red on the break named beside the row; (b) prints the copy's source, start and id against
    //     the expected ones.
    expect(copyOf(requestsOf(final, 'draft')[0])).toEqual(copied(expected));
  });
});

describe('caching 3-M C2 — check 5: the bound', () => {
  it('a step named by 10 rows → at most 6 `get`s', async () => {
    const t = await open();
    for (let i = 0; i < 10; i += 1) {
      await drive(t, SINGLE, [ok(billed(START(i)))]);
      await t.tick();
    }
    const w = watched(t.h);
    const found = await readEarlierRuns(w.readStore, SINGLE, undefined);
    // (a) red when the rows are not bounded; (b) prints the number of reads and of requests found.
    expect({ gets: w.gets.length, found: found?.get('draft')?.length }).toEqual({
      gets: 6,
      found: 6,
    });
  });

  it('two steps naming the same runs → each run `get` once, one `scan`', async () => {
    const t = await open();
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const run = await drive(t, TWO_STEPS, [
        ok(billed(START(i * 2))),
        ok(billed(START(i * 2 + 1))),
      ]);
      ids.push(run.id);
      await t.tick();
    }
    const w = watched(t.h);
    await readEarlierRuns(w.readStore, TWO_STEPS, undefined);
    // (a) red on a scan per step, or a `get` per step; (b) prints the scans and the ids read.
    expect({ scans: w.scans(), gets: [...w.gets].sort() }).toEqual({
      scans: 1,
      gets: [...ids].sort(),
    });
  });

  it('every page is read', async () => {
    const t = await open();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await drive(t, SINGLE, [ok(billed(START(i)))])).id);
      await t.tick();
    }
    const w = watched(t.h, 1);
    await readEarlierRuns(w.readStore, SINGLE, undefined);
    // Run ids are random, so which run a first page holds is not fixed: every id read is what shows
    // every page was. (a) red when only the first page is read; (b) prints the ids read.
    expect([...w.gets].sort()).toEqual([...ids].sort());
  });

  it('on `--run-id` of a multi-step run re-attached for its next step, the read never opens that run', async () => {
    const t = await open();
    const other = await drive(t, TWO_STEPS, [ok(billed(START(0))), ok(billed(START(1)))]);
    await t.tick();
    // Its first step completed, its next step's model call threw: the run is the newest naming `first`.
    const own = await drive(t, TWO_STEPS, [
      ok(billed(START(5))),
      { throw: true, usage: [billed(START(6))] },
    ]);
    await t.tick();
    const w = watched(t.h);
    await readEarlierRuns(w.readStore, TWO_STEPS, own.id);
    // (a) red when the own run is not excluded; (b) prints the ids read.
    expect(w.gets).toEqual([other.id]);
  });
});

describe('caching 3-M C2 — check 6: a read that fails never stops a drive', () => {
  it('the scan throws → no data, and the drive completes with no copy', async () => {
    const t = await open();
    await drive(t, SINGLE, [ok(billed(START(0)))]);
    await t.tick();
    const store = t.h.home.runStore;
    const failing = {
      clock: store.clock,
      get: (id: string) => store.get(id),
      // eslint-disable-next-line require-yield -- a scan that fails on its first page
      scan: async function* () {
        throw new Error('the store went away');
      },
    } as unknown as ReadStore;
    const data: EarlierRuns | undefined = await readEarlierRuns(failing, SINGLE, undefined);
    const final = await drive(t, SINGLE, [ok(billed(START(10)))], { readStore: failing });
    // (a) red when the guard is removed (the drive never starts), or a failed read answers an empty
    //     result, which would mean "no earlier runs"; (b) prints the data, the phase and the copy.
    expect({
      data,
      completed: final.completed_steps,
      copy: copyOf(requestsOf(final, 'draft')[0]),
    }).toEqual({ data: undefined, completed: ['draft'], copy: copied(undefined) });
  });

  it('one `get` throws → that run is skipped, and the drive copies the other run', async () => {
    const t = await open();
    const other = await drive(t, SINGLE, [ok(billed(START(0)))]);
    await t.tick();
    await drive(t, SINGLE, [ok(billed(START(5)))]);
    await t.tick();
    const store = t.h.home.runStore;
    let failed = false;
    const failing = {
      clock: store.clock,
      scan: (filter: never, options: never) => store.scan(filter, options),
      // The newest run is opened first: a run purged between the scan and this read.
      get: (id: string) => {
        if (!failed) {
          failed = true;
          return Promise.reject(new Error('STATE_RUN_NOT_FOUND'));
        }
        return store.get(id);
      },
    } as unknown as ReadStore;
    const final = await drive(t, SINGLE, [ok(billed(START(10)))], { readStore: failing });
    // (a) red when the guard is removed; (b) prints the phase and the copy.
    expect({
      completed: final.completed_steps,
      copy: copyOf(requestsOf(final, 'draft')[0]),
    }).toEqual({ completed: ['draft'], copy: copied(requestsOf(other, 'draft')[0]) });
  });
});

describe('caching 3-M C2 — what the operator sees', () => {
  // Check 1's two drives, forty minutes apart, the first writing 4,019 tokens for 5 minutes.
  it('check 8: `realm run inspect` names the earlier run, and `get_run_state` says where the predecessor was', async () => {
    const t = await open();
    await drive(t, SINGLE, [ok(billed(START(0), 0, 4019))]);
    await t.tick();
    const second = await drive(t, SINGLE, [ok(billed(START(40), 0, 4019))]);
    const { workflowStore } = t.h.home;
    await workflowStore.register(SINGLE);
    const out = await inspectRun(second.id, t.h.home.runStore, workflowStore);
    const line = out.split('\n').find((l) => l.includes('cache miss:'));
    const summary = await handleGetRunState(
      { run_id: second.id, include_steps: true },
      { runStore: t.h.home.runStore, workflowStore },
    );
    // (a) red when the reference is written `from: 'run'` (the line says "an earlier drive's
    //     request", and the place `reference`); (b) prints the line and the place.
    expect({
      line: line?.trim(),
      place: summary.steps!['draft']!.attempts[0]!.cost!.misses![0]!.derived.predecessor,
    }).toEqual({
      line: "cache miss: request 1 of 1 read 0 of 4019 expected tokens — possibly expired: it started 40 minutes after an earlier run's request, longer than the 5 minutes the provider granted",
      place: { from: 'earlier_run' },
    });
  });

  // A tool step's conversation holds the run's own input, so a new input always reads less.
  it('check 9: a tool step’s second run carries the copy, and no miss line, though it read less', async () => {
    const t = await open();
    await drive(t, TOOLS, [{ output: { status: 'OK' }, usage: [toolTurn(START(0), 0, 4019)] }]);
    await t.tick();
    const second = await drive(t, TOOLS, [
      { output: { status: 'OK' }, usage: [toolTurn(START(2), 0, 4019)] },
    ]);
    const out = await inspectRun(second.id, t.h.home.runStore, registrarOf(TOOLS) as never);
    // (a) red when C1's rule is bypassed (a miss line appears); (b) prints the copy's source and the
    //     miss lines.
    expect({
      from: requestsOf(second, 'classify')[0]?.reference?.from,
      missLines: out.split('\n').filter((l) => l.includes('cache miss:')),
    }).toEqual({ from: 'earlier_run', missLines: [] });
  });
});
