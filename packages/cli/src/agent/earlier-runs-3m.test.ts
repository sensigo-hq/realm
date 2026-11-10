// earlier-runs-3m.test.ts — caching 3-M piece C2: a step's first request, when its own run holds
// nothing earlier for the step, carries a copy of the same step's request from the most recent earlier
// run of the workflow. Driven through the real `runAgent` on the real SQLite store (`openCliHome` on a
// scratch home), with a scripted provider double returning the capture's shape. No two-run capture
// exists: each cell pairs real shapes by construction. Every value is a fake. Each assertion names
// (a) the change that turns it red and (b) what it prints when it fails: ids, steps, `from` and
// instants, never a prompt's text. Piece C3's cells are at the end: the reference says when the
// step's agent profile changed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord, UsageRecord, WorkflowDefinition } from '@sensigo/realm';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  applyResume,
  createDefaultRegistry,
} from '@sensigo/realm';
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

/**
 * A read store whose every row has `list` damaged: real pages, with the step lists replaced. The other
 * two are empty so the read reaches the damaged one: a row an earlier list already names the step in
 * never reads the later lists, so nothing there can throw.
 */
function withDamagedRows(h: TempHome, list: string, value: unknown): ReadStore {
  const store = h.home.runStore;
  return {
    clock: store.clock,
    get: (id: string) => store.get(id),
    scan: async function* (filter: never, options: never) {
      for await (const page of store.scan(filter, options) as AsyncIterable<{
        items: { kind: string; run?: object }[];
      }>) {
        yield {
          ...page,
          items: page.items.map((item) =>
            item.kind === 'run'
              ? {
                  ...item,
                  run: {
                    ...item.run,
                    completed_steps: [],
                    failed_steps: [],
                    in_progress_steps: [],
                    [list]: value,
                  },
                }
              : item,
          ),
        };
      }
    },
  } as unknown as ReadStore;
}

const DAMAGED_ROWS = ['completed_steps', 'failed_steps', 'in_progress_steps'].flatMap(
  (list): [string, string, unknown][] => [
    [list, 'a number', 7],
    [list, 'an object', { draft: true }],
  ],
);

describe('caching 3-M C2 correction 1 — a damaged row never stops a drive', () => {
  // A row of the workflow whose step list is not an array: only a hand-edited store file makes one,
  // and it would otherwise stop every drive of the workflow for as long as it sits in the window.
  it.each(DAMAGED_ROWS)(
    'check 1: `%s` is %s → no data, and the drive completes with no copy',
    async (list, _shape, value) => {
      const t = await open();
      await drive(t, SINGLE, [ok(billed(START(0)))]);
      await t.tick();
      const damaged = withDamagedRows(t.h, list, value);
      const data = await readEarlierRuns(damaged, SINGLE, undefined);
      const final = await drive(t, SINGLE, [ok(billed(START(10)))], { readStore: damaged });
      // (a) red when the guard is back around the scan alone (the read throws in the step filter, or
      //     the sort); (b) prints the data, the steps completed and the copy's source.
      expect({
        data,
        completed: final.completed_steps,
        copy: copyOf(requestsOf(final, 'draft')[0]),
      }).toEqual({ data: undefined, completed: ['draft'], copy: copied(undefined) });
    },
  );
});

describe('caching 3-M C2 correction 1 — the six rows are those that name the step', () => {
  // A conditional step: reached by few runs, so the workflow's newest rows do not name it.
  it('check 2: a step named only by the 7th and 8th newest rows is found from them', async () => {
    const t = await open();
    const reached: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const run = await drive(t, TWO_STEPS, [
        ok(billed(START(i * 2))),
        ok(billed(START(i * 2 + 1))),
      ]);
      reached.unshift(run.id);
      await t.tick();
    }
    for (let i = 0; i < 6; i += 1) {
      // `second`'s model call throws before any claim, so these six rows name only `first`.
      await drive(t, TWO_STEPS, [
        ok(billed(START(10 + i * 2))),
        { throw: true, usage: [billed(START(11 + i * 2))] },
      ]);
      await t.tick();
    }
    const found = await readEarlierRuns(t.h.home.runStore, TWO_STEPS, undefined);
    // (a) red when the six are taken before the filter (the step gets no copy); (b) prints the run
    //     ids found for the step, latest start first.
    expect(found?.get('second')?.map((r) => r.run_id)).toEqual(reached);
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

const PROFILE_BEFORE = 'e'.repeat(64);
const PROFILE_AFTER = 'f'.repeat(64);
const SETTLES_FAILED = { validation_exhaustion: { threshold: 1, mode: 'fail' } };

/** The single-shot step under a profile of this hash, as the loader stamps it; none: no profile. */
const profiled = (
  hash: string | undefined,
  extra: Record<string, unknown> = {},
): WorkflowDefinition =>
  workflow(
    'earlier-3m-single',
    { draft: agentStep({ ...extra, ...(hash !== undefined ? { agent_profile: 'writer' } : {}) }) },
    hash !== undefined
      ? { resolved_profiles: { writer: { content: 'Write plainly.', content_hash: hash } } }
      : {},
  );

/** The hash on the step's latest evidence entry. */
const evidenceHash = (run: RunRecord): string | undefined =>
  run.evidence.filter((e) => e.step_id === 'draft').at(-1)?.agent_profile_hash;

/** The two hashes' equality, in words: what a failing row prints, never a digest. */
function compared(earlier: string | undefined, current: string | undefined): string {
  if (earlier === undefined && current === undefined) return 'neither known';
  if (earlier === undefined) return 'earlier not known';
  if (current === undefined) return 'this side not known';
  return earlier === current ? 'equal' : 'different';
}

/** What a row's drives left: the final run, the request it must have copied and the two hashes. */
interface ProfileCase {
  final: RunRecord;
  copied: UsageRecord;
  earlier: string | undefined;
  current: string | undefined;
}

/** Two runs of the workflow, the first under `before` and the second under `after`. */
async function twoRuns(
  t: Harness,
  before: string | undefined,
  after: string | undefined,
): Promise<ProfileCase> {
  const first = await drive(t, profiled(before), [ok(billed(START(0)))]);
  await t.tick();
  const final = await drive(t, profiled(after), [ok(billed(START(10)))]);
  return {
    final,
    copied: requestsOf(first, 'draft')[0]!,
    earlier: evidenceHash(first),
    current: after,
  };
}

/** A run whose step settled failed under `hash`, its request on the evidence entry, then resumed. */
async function settledAndResumed(t: Harness, hash: string): Promise<RunRecord> {
  const def = profiled(hash, SETTLES_FAILED);
  const run = await drive(t, def, [{ output: { status: 'BAD' }, usage: [billed(START(0))] }]);
  const store = t.h.home.runStore;
  await store.update(applyResume((await store.get(run.id)).record, 'draft', def).run);
  await t.tick();
  return run;
}

const PROFILE_ROWS: [
  string,
  (t: Harness) => Promise<ProfileCase>,
  { from: string; hashes: string; fact: true | 'absent' },
][] = [
  [
    // The real case. Break: only a re-drive is handled, or the fact is never written.
    'the profile edited between two runs → true',
    (t) => twoRuns(t, PROFILE_BEFORE, PROFILE_AFTER),
    { from: 'earlier_run', hashes: 'different', fact: true },
  ],
  [
    // Break: the comparison dropped, so the fact is always written.
    'the same profile in both runs → no field',
    (t) => twoRuns(t, PROFILE_BEFORE, PROFILE_BEFORE),
    { from: 'earlier_run', hashes: 'equal', fact: 'absent' },
  ],
  [
    // Break: the comparison dropped.
    'a step with no profile → no field',
    (t) => twoRuns(t, undefined, undefined),
    { from: 'earlier_run', hashes: 'neither known', fact: 'absent' },
  ],
  [
    // Break: a missing earlier hash treated as a difference.
    'a step that gained a profile → no field',
    (t) => twoRuns(t, undefined, PROFILE_AFTER),
    { from: 'earlier_run', hashes: 'earlier not known', fact: 'absent' },
  ],
  [
    // Break: a missing hash on this side treated as a difference.
    'a step that lost its profile → no field',
    (t) => twoRuns(t, PROFILE_BEFORE, undefined),
    { from: 'earlier_run', hashes: 'this side not known', fact: 'absent' },
  ],
  [
    // The run holds an evidence entry under the old profile, but the copy comes from the later
    // drive failure, which holds no hash. Breaks: a missing hash treated as a difference; the hash
    // read from the step's latest evidence entry instead of the entry that held the copied request.
    'settled failed under one profile, resumed, its next drive failed under an edited one, driven again under that → no field',
    async (t) => {
      const settled = await settledAndResumed(t, PROFILE_BEFORE);
      const edited = profiled(PROFILE_AFTER, SETTLES_FAILED);
      const failed = await drive(t, edited, [{ throw: true, usage: [billed(START(5))] }], {
        runId: settled.id,
      });
      await t.tick();
      const entry = failed.drive_failures!.entries.at(-1)!;
      return {
        final: await drive(t, edited, [ok(billed(START(10)))], { runId: settled.id }),
        copied: entry.usage![0]!,
        earlier: (entry as unknown as { agent_profile_hash?: string }).agent_profile_hash,
        current: PROFILE_AFTER,
      };
    },
    { from: 'run', hashes: 'earlier not known', fact: 'absent' },
  ],
  [
    // The run's latest evidence entry is under the edited profile but holds no request (that drive
    // made none), so the copy is the older entry's request, made under the old profile. Break: the
    // earlier hash read from the step's latest evidence entry instead of the entry that held the
    // copied request (the two hashes read equal, so the fact is absent).
    'a later evidence entry under an edited profile holds no request; the copy is the older entry’s → true',
    async (t) => {
      const settled = await settledAndResumed(t, PROFILE_BEFORE);
      const edited = profiled(PROFILE_AFTER, SETTLES_FAILED);
      const noRequest = await drive(t, edited, [{ output: { status: 'BAD' } }], {
        runId: settled.id,
      });
      await t.tick();
      const store = t.h.home.runStore;
      await store.update(applyResume((await store.get(noRequest.id)).record, 'draft', edited).run);
      await t.tick();
      return {
        final: await drive(t, edited, [ok(billed(START(10)))], { runId: settled.id }),
        copied: requestsOf(settled, 'draft')[0]!,
        earlier: evidenceHash(settled),
        current: PROFILE_AFTER,
      };
    },
    { from: 'run', hashes: 'different', fact: true },
  ],
  [
    // A re-drive under an edited profile. Break: only `earlier_run` handled.
    'a re-drive of one run whose earlier evidence entry has a different hash → true',
    async (t) => {
      const settled = await settledAndResumed(t, PROFILE_BEFORE);
      return {
        final: await drive(t, profiled(PROFILE_AFTER, SETTLES_FAILED), [ok(billed(START(10)))], {
          runId: settled.id,
        }),
        copied: requestsOf(settled, 'draft')[0]!,
        earlier: evidenceHash(settled),
        current: PROFILE_AFTER,
      };
    },
    { from: 'run', hashes: 'different', fact: true },
  ],
];

describe('caching 3-M C3 — check 1: the reference says when the agent profile changed', () => {
  it.each(PROFILE_ROWS)('%s', async (_name, row, expected) => {
    const t = await open();
    const { final, copied: source, earlier, current } = await row(t);
    const reference = requestsOf(final, 'draft')[0]?.reference;
    // (a) red on the break named beside the row; (b) prints the step, the source, whether the copy
    //     is the expected request, the hashes' equality in words and the fact, never a digest.
    expect({
      step: 'draft',
      from: reference?.from,
      copiedTheRequest: reference?.request_id === source.request_id,
      hashes: compared(earlier, current),
      fact:
        reference !== undefined && Object.hasOwn(reference, 'agent_profile_changed')
          ? reference.agent_profile_changed
          : 'absent',
    }).toEqual({ step: 'draft', copiedTheRequest: true, ...expected });
  });
});

/** Two steps, each under its own profile; `critic` is listed before `writer` in `resolved_profiles`. */
const twoProfiled = (writer: string, critic: string): WorkflowDefinition =>
  workflow(
    'earlier-3m-two-profiles',
    {
      draft: agentStep({ agent_profile: 'writer' }),
      review: agentStep({ agent_profile: 'critic', depends_on: ['draft'] }),
    },
    {
      resolved_profiles: {
        critic: { content: 'Check it.', content_hash: critic },
        writer: { content: 'Write plainly.', content_hash: writer },
      },
    },
  );

const CRITIC_BEFORE = 'a'.repeat(64);
const CRITIC_AFTER = 'b'.repeat(64);

describe('caching 3-M C3 — check 1, two profiles in one workflow: each step compares its own', () => {
  // Real case: a workflow with several profiles, one of them edited between two runs. Can fail: a
  // step's profile looked up from another step's entry of `resolved_profiles` (the first listed, the
  // last, or the wrong name): the edited step reads equal and the unchanged one reads different. Prints
  // the fact of each step.
  it.each([
    [
      'the first step’s profile edited',
      twoProfiled(PROFILE_AFTER, CRITIC_BEFORE),
      { draft: true, review: 'absent' },
    ],
    [
      'the second step’s profile edited',
      twoProfiled(PROFILE_BEFORE, CRITIC_AFTER),
      { draft: 'absent', review: true },
    ],
  ])('%s', async (_name, after, expected) => {
    const t = await open();
    await drive(t, twoProfiled(PROFILE_BEFORE, CRITIC_BEFORE), [
      ok(billed(START(0))),
      ok(billed(START(1))),
    ]);
    await t.tick();
    const final = await drive(t, after, [ok(billed(START(10))), ok(billed(START(11)))]);
    const factOf = (step: string): true | 'absent' => {
      const reference = requestsOf(final, step)[0]?.reference;
      return reference !== undefined && Object.hasOwn(reference, 'agent_profile_changed')
        ? (reference.agent_profile_changed as true)
        : 'absent';
    };
    expect({ draft: factOf('draft'), review: factOf('review') }).toEqual(expected);
  });
});

describe('caching 3-M C3 — check 5: what the operator sees', () => {
  // Two runs of one workflow, the profile edited between them, the second reading less.
  it('`realm run inspect` says the profile changed, and `get_run_state` carries the cause', async () => {
    const t = await open();
    await drive(t, profiled(PROFILE_BEFORE), [ok(billed(START(0), 0, 4019))]);
    await t.tick();
    const edited = profiled(PROFILE_AFTER);
    const second = await drive(t, edited, [
      ok({
        ...billed(START(1), 0, 4019),
        // The double's parts are fixed, so an edited profile moves no digest here; a real provider's
        // `system` digest covers the profile (`buildSystemPrompt`), so it is set to differ.
        prefix_parts: { system: 'd'.repeat(64), prompt: PROMPT_HEAD },
      }),
    ]);
    const { workflowStore } = t.h.home;
    await workflowStore.register(edited);
    const out = await inspectRun(second.id, t.h.home.runStore, workflowStore);
    const summary = await handleGetRunState(
      { run_id: second.id, include_steps: true },
      { runStore: t.h.home.runStore, workflowStore },
    );
    // (a) red when the fact is not written (the line and the cause say `system`); (b) prints the step,
    //     the line and the cause, never a digest.
    expect({
      step: 'draft',
      line: out
        .split('\n')
        .find((l) => l.includes('cache miss:'))
        ?.trim(),
      cause: summary.steps!['draft']!.attempts[0]!.cost!.misses![0]!.derived.cause,
    }).toEqual({
      step: 'draft',
      line: "cache miss: request 1 of 1 read 0 of 4019 expected tokens — the step's agent profile changed since an earlier run's request",
      cause: 'agent_profile',
    });
  });
});
