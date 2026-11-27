// caller-limits-625-u2.test.ts — #625 named keys unit 2a (the library): a server built with `limits`
// refuses a call outside them before the tool does anything, names the caller and the limit, and
// tells a caller limited to some workflows nothing about runs it may not reach. Through a real server
// on a temp home (in-memory transport; the SDK's client, which checks get_run_state's
// structuredContent against its listed outputSchema). The names are fictional.
// Beside each cell: (a) the break that turns it red; (b) what it prints on failure.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  compileDisclosure,
  workflowNotFoundError,
  writeTestClockFile,
  type DisclosureSet,
  type RegistryListing,
  type RunRecord,
  type RunStore,
  type WorkflowDefinition,
  type WorkflowRegistrar,
} from '@sensigo/realm';
import { plantRegistryRow } from '@sensigo/realm-store-sqlite/test-support';
import { createRealmMcpServer, type RealmMcpServerOptions } from '../server.js';
import { READING_TOOLS } from '../tool-annotations.js';
import { sseJsonStringify } from '../sse-json.js';
import { declared } from '../test-support/declared.js';
import { makeTempHome, runCount, seedRun, type TempHome } from '../test-support/temp-home.js';
import { withinLimits } from './caller-limits.js';

type Json = Record<string, unknown>;
interface Result {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Json;
  isError?: boolean;
}
type Call = (tool: string, args: Json) => Promise<Result>;

const BUDGET = 120_000;
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';
const flow = (id: string): WorkflowDefinition =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { a: { description: 'A step.', execution: 'agent', depends_on: [] } },
  }) as never;
const MINE = flow('nk2-mine');
const OTHER = flow('nk2-other');
const run = (id: string, workflow_id: string): RunRecord =>
  ({
    id,
    workflow_id,
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 2,
    params: {},
    evidence: [],
    created_at: T0,
    updated_at: T1,
    terminal_state: false,
  }) as never;

/** Each tool `realm serve` offers, with valid arguments naming MINE or the run `runId`. */
const ARGS = (runId: string): Record<string, Json> => ({
  list_workflows: {},
  get_workflow_protocol: { workflow_id: MINE.id },
  start_run: { workflow_id: MINE.id },
  start_run_batch: { workflow_id: MINE.id, items: [{ params: {} }] },
  execute_step: { run_id: runId, command: 'a', params: {} },
  advance_run: { run_id: runId },
  submit_human_response: { run_id: runId, gate_id: 'gate-none', choice: 'yes' },
  get_run_state: { run_id: runId },
  abandon_run: { run_id: runId },
  create_workflow: { steps: [{ id: 's1', description: 'Do it.' }] },
  append_trace: { run_id: runId, step_id: 'a', entries: [] },
});
const TOOLS = Object.keys(ARGS(''));
const RUN_TOOLS = [
  'execute_step',
  'advance_run',
  'submit_human_response',
  'get_run_state',
  'abandon_run',
  'append_trace',
];
const ASK = "Ask the server's operator for a key that allows it.";

let root: string;
let home: TempHome;
const clients: Client[] = [];
let seq = 0;
/** A fresh run of `workflow`, seeded now: each cell gets its own, so a served call changes no other. */
async function fresh(workflow: WorkflowDefinition, on: TempHome = home): Promise<string> {
  const id = `nk2-run-${String(++seq).padStart(4, '0')}`;
  await seedRun(on.stores.runStore, run(id, workflow.id));
  return id;
}

async function connect(
  extra: Partial<RealmMcpServerOptions> = {},
  on: TempHome = home,
  capabilities: ConstructorParameters<typeof Client>[1] = {},
): Promise<Call> {
  const server = createRealmMcpServer({ ...on.stores, gateAnswers: 'permitted', ...extra });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'nk2', version: '0' }, capabilities);
  await Promise.all([server.connect(st), client.connect(ct)]);
  // The client then checks get_run_state's structuredContent against the listed schema.
  await client.listTools();
  clients.push(client);
  return async (tool, args) => (await client.callTool({ name: tool, arguments: args })) as Result;
}

const textOf = (r: Result): string => r.content[0]!.text;
const bodyOf = (r: Result): Json => JSON.parse(textOf(r)) as Json;
/** A call the limits let through: its reply is the tool's own (whatever the tool said). */
const served = (r: Result): boolean => !textOf(r).includes('CALL_OUTSIDE_LIMITS');
/** The refusal's fields, as the cells compare them. */
function refusalOf(r: Result): Json | string {
  if (served(r)) return 'served';
  const b = bodyOf(r);
  return {
    status: b['status'],
    error_code: b['error_code'],
    errors: b['errors'],
    context_hint: b['context_hint'],
    agent_action: b['agent_action'],
    isError: r.isError,
  };
}
const refused = (sentence: string): Json => ({
  status: 'error',
  error_code: 'CALL_OUTSIDE_LIMITS',
  errors: [sentence],
  context_hint: sentence,
  agent_action: 'report_to_user',
  isError: undefined,
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'realm-nk2-'));
  await writeTestClockFile(root, new Date('2026-01-01T00:10:00.000Z'));
  home = await makeTempHome({ home: root });
  for (const d of [MINE, OTHER]) await home.stores.workflowStore.register(d);
}, BUDGET);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  for (const c of clients.splice(0)) await c.close();
  await home.cleanup();
}, BUDGET);

describe('check 1 (library level) — each tool under a tool limit', () => {
  it(
    'a readOnly caller is served the three reading tools and refused the other eight, each with the reading-tools sentence',
    async () => {
      const call = await connect({ limits: { caller: 'dash', readOnly: true } });
      const table: Record<string, unknown> = {};
      for (const tool of TOOLS)
        table[tool] = refusalOf(await call(tool, ARGS(await fresh(MINE))[tool]!));
      const reading = ['list_workflows', 'get_workflow_protocol', 'get_run_state'];
      const sentence = (tool: string) =>
        `Key 'dash' may not call ${tool}: it may call only the reading tools (list_workflows, get_workflow_protocol, get_run_state). ${ASK}`;
      // (a) red when the shared check is skipped in a tool (that row reads 'served'), or when a reading
      //     tool is refused; (b) prints the whole table, one row per tool.
      expect(table).toStrictEqual(
        Object.fromEntries(
          TOOLS.map((t) => [t, reading.includes(t) ? 'served' : refused(sentence(t))]),
        ),
      );
    },
    BUDGET,
  );

  it(
    'a caller allowed two tools that do not read is served those two and refused the other nine, the reading tools among them',
    async () => {
      const allowed = ['start_run', 'abandon_run'];
      const call = await connect({ limits: { caller: 'ci-runner', tools: allowed } });
      const table: Record<string, unknown> = {};
      for (const tool of TOOLS)
        table[tool] = refusalOf(await call(tool, ARGS(await fresh(MINE))[tool]!));
      const sentence = (tool: string) =>
        `Key 'ci-runner' may not call ${tool}: it may call only start_run, abandon_run. ${ASK}`;
      // (a) red when the shared check is skipped in a tool; (b) prints the whole table.
      expect(table).toStrictEqual(
        Object.fromEntries(
          TOOLS.map((t) => [t, allowed.includes(t) ? 'served' : refused(sentence(t))]),
        ),
      );
    },
    BUDGET,
  );

  it(
    "get_run_state's refusal is an ordinary result that carries its twin, which fits the refusal arm the client checks",
    async () => {
      const call = await connect({ limits: { caller: 'ci-runner', tools: ['start_run'] } });
      const r = await call('get_run_state', { run_id: await fresh(MINE) });
      // (a) red when the refusal is sent without `floor` (the SDK client then throws "Structured
      //     content does not match" or "Output validation error"); (b) prints the carriers.
      expect({
        isError: r.isError,
        twinIsText: sseJsonStringify(r.structuredContent) === textOf(r),
        code: r.structuredContent?.['error_code'],
      }).toStrictEqual({ isError: undefined, twinIsText: true, code: 'CALL_OUTSIDE_LIMITS' });
    },
    BUDGET,
  );

  it(
    'every tool stays listed for a limited caller',
    async () => {
      const server = createRealmMcpServer({
        ...home.stores,
        gateAnswers: 'permitted',
        limits: { caller: 'dash', readOnly: true },
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'nk2', version: '0' });
      await Promise.all([server.connect(st), client.connect(ct)]);
      clients.push(client);
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      // (a) red when a refused tool is hidden from tools/list; (b) prints the listed names.
      expect(names).toStrictEqual([...TOOLS].sort());
    },
    BUDGET,
  );
});

describe('check 2 — each tool inside and outside a workflow limit', () => {
  const key = { caller: 'ci-runner', workflows: [MINE.id] };
  const useSentence = (id: string) =>
    `Key 'ci-runner' may not use workflow '${id}': it may reach only the workflows ${MINE.id}. ${ASK}`;
  const runSentence = (id: string) =>
    `Key 'ci-runner' may not reach run '${id}': it may reach only the runs of the workflows ${MINE.id}. ${ASK}`;

  it(
    'the tools that name a workflow: served inside the list; outside it refused, and no run is made',
    async () => {
      const call = await connect({ limits: key });
      const rows: Record<string, unknown> = {};
      for (const tool of ['get_workflow_protocol', 'start_run', 'start_run_batch']) {
        const inside = ARGS('')[tool]!;
        const outside = { ...inside, workflow_id: OTHER.id };
        const before = await runCount(home.stores.runStore);
        const out = refusalOf(await call(tool, outside));
        const made = (await runCount(home.stores.runStore)) - before;
        rows[tool] = { inside: refusalOf(await call(tool, inside)), outside: out, made };
      }
      // (a) red when the workflow check is skipped in a tool (its outside cell reads 'served', and for
      //     the two that start runs `made` is 1), or when it runs after the run is made; (b) prints
      //     the rows.
      expect(rows).toStrictEqual({
        get_workflow_protocol: {
          inside: 'served',
          outside: refused(useSentence(OTHER.id)),
          made: 0,
        },
        start_run: { inside: 'served', outside: refused(useSentence(OTHER.id)), made: 0 },
        start_run_batch: { inside: 'served', outside: refused(useSentence(OTHER.id)), made: 0 },
      });
    },
    BUDGET,
  );

  it(
    "a batch on the key's workflow whose parent_run_id is another workflow's run is refused by the run rule, and starts no run",
    async () => {
      const call = await connect({ limits: key });
      const parent = await fresh(OTHER);
      const before = await runCount(home.stores.runStore);
      const r = await call('start_run_batch', {
        ...ARGS('')['start_run_batch'],
        parent_run_id: parent,
      });
      // (a) red when the batch's parent run is not checked; (b) prints the refusal and the count.
      expect({
        r: refusalOf(r),
        made: (await runCount(home.stores.runStore)) - before,
      }).toStrictEqual({
        r: refused(runSentence(parent)),
        made: 0,
      });
    },
    BUDGET,
  );

  it(
    "the tools that name a run: served for a run of the key's workflow, refused for another workflow's run, which is left as it was",
    async () => {
      const call = await connect({ limits: key });
      const rows: Record<string, unknown> = {};
      for (const tool of RUN_TOOLS) {
        const outside = await fresh(OTHER);
        const before = JSON.stringify((await home.stores.runStore.get(outside)).record);
        const out = refusalOf(await call(tool, ARGS(outside)[tool]!));
        const after = JSON.stringify((await home.stores.runStore.get(outside)).record);
        rows[tool] = {
          inside: refusalOf(await call(tool, ARGS(await fresh(MINE))[tool]!)),
          outside: out,
          untouched: after === before,
        };
      }
      // (a) red when the run check is skipped in a tool; (b) prints the rows.
      expect(rows).toStrictEqual(
        Object.fromEntries(
          RUN_TOOLS.map((t) => [
            t,
            {
              inside: 'served',
              outside: expect.objectContaining({ error_code: 'CALL_OUTSIDE_LIMITS' }),
              untouched: true,
            },
          ]),
        ),
      );
      // The sentence, on one of them (each run tool's refusal is the same function's).
      const one = await fresh(OTHER);
      expect(refusalOf(await call('abandon_run', { run_id: one }))).toStrictEqual(
        refused(runSentence(one)),
      );
    },
    BUDGET,
  );

  it(
    'create_workflow is refused before anything is registered or started',
    async () => {
      const call = await connect({ limits: key });
      const workflowsBefore = (await home.stores.workflowStore.list()).length;
      const runsBefore = await runCount(home.stores.runStore);
      const r = await call('create_workflow', ARGS('')['create_workflow']!);
      // (a) red when the create check is skipped, or placed after the handler (a workflow registered
      //     and a run started); (b) prints the refusal and both counts.
      expect({
        r: refusalOf(r),
        workflows: (await home.stores.workflowStore.list()).length - workflowsBefore,
        runs: (await runCount(home.stores.runStore)) - runsBefore,
      }).toStrictEqual({
        r: refused(
          `Key 'ci-runner' may not create workflows: it may reach only the workflows ${MINE.id}. ${ASK}`,
        ),
        workflows: 0,
        runs: 0,
      });
    },
    BUDGET,
  );

  it(
    'present_question (a server that sends forms) follows the run rule and the tool rule',
    async () => {
      const forms = { capabilities: { elicitation: { form: {} } } };
      const byRun = await connect({ gateAnswers: 'asked', limits: key }, home, forms);
      const outside = await fresh(OTHER);
      const readOnly = await connect(
        { gateAnswers: 'asked', limits: { caller: 'dash', readOnly: true } },
        home,
        forms,
      );
      const mine = await fresh(MINE);
      // (a) red when the check is skipped in present_question; (b) prints both refusals.
      expect({
        byRun: refusalOf(await byRun('present_question', { run_id: outside, gate_id: 'g' })),
        byTool: refusalOf(await readOnly('present_question', { run_id: mine, gate_id: 'g' })),
      }).toStrictEqual({
        byRun: refused(runSentence(outside)),
        byTool: refused(
          `Key 'dash' may not call present_question: it may call only the reading tools (list_workflows, get_workflow_protocol, get_run_state). ${ASK}`,
        ),
      });
    },
    BUDGET,
  );
});

describe("check 2 — list_workflows lists, names and counts only the key's workflows", () => {
  const COUNT_ONE = "1 registered workflow copy could not be read — see 'unreadable'.";

  it(
    "the SQLite registry: a copy that cannot be read is named only when it is the key's",
    async () => {
      const h = await makeTempHome();
      for (const d of [MINE, OTHER]) await h.stores.workflowStore.register(d);
      await plantRegistryRow(h.path, { id: 'nk2-bad', text: '{ not json' });
      // One text plants once per home: the second is another text that is not JSON.
      await plantRegistryRow(h.path, { id: 'nk2-junk', text: '{ also not json' });
      try {
        const limited = bodyOf(
          await (
            await connect({ limits: { caller: 'ci-runner', workflows: [MINE.id, 'nk2-bad'] } }, h)
          )('list_workflows', {}),
        );
        const all = bodyOf(await (await connect({}, h))('list_workflows', {}));
        // (a) red when the list, the unreadable copies or the counts are not filtered; (b) prints both.
        expect({
          ids: (limited['workflows'] as Json[]).map((w) => w['id']),
          unreadable: (limited['unreadable'] as Json[]).map((u) => u['workflow_id']),
          warnings: limited['warnings'],
          counted: String(limited['hint']).startsWith('1 registered workflow copy'),
          all: (all['unreadable'] as Json[]).length,
        }).toStrictEqual({
          ids: [MINE.id],
          unreadable: ['nk2-bad'],
          warnings: [COUNT_ONE],
          counted: true,
          all: 2,
        });
      } finally {
        await h.cleanup();
      }
    },
    BUDGET,
  );

  it(
    "a registry of files: a copy is the key's by its file name less .json; one whose workflow cannot be told is left out",
    async () => {
      const entry = (file: string) => ({
        file,
        class: 'parse' as const,
        reason: `${file} is not JSON`,
      });
      const listing: RegistryListing = {
        workflows: [MINE, OTHER],
        unreadable: [entry('nk2-bad.json'), entry('nk2-junk.json'), entry('stray-file')],
        mismatched: [],
      };
      const registrar: WorkflowRegistrar = declared({
        register: async () => {},
        get: async (id: string) => {
          const d = [MINE, OTHER].find((x) => x.id === id);
          if (d === undefined) throw workflowNotFoundError(id);
          return d;
        },
        list: async () => [MINE, OTHER],
        listWithDiagnostics: async () => listing,
      });
      const reply = bodyOf(
        await (
          await connect({
            workflowStore: registrar,
            limits: { caller: 'ci-runner', workflows: [MINE.id, 'nk2-bad'] },
          })
        )('list_workflows', {}),
      );
      // (a) red when file entries are not filtered by name; (b) prints the listed ids and files.
      expect({
        ids: (reply['workflows'] as Json[]).map((w) => w['id']),
        files: (reply['unreadable'] as Json[]).map((u) => u['file']),
        warnings: reply['warnings'],
      }).toStrictEqual({ ids: [MINE.id], files: ['nk2-bad.json'], warnings: [COUNT_ONE] });
    },
    BUDGET,
  );

  it(
    'the healthy hint leaves out create_workflow for a caller that cannot call it',
    async () => {
      const hint = async (limits?: RealmMcpServerOptions['limits']) =>
        bodyOf(await (await connect(limits !== undefined ? { limits } : {}))('list_workflows', {}))[
          'hint'
        ];
      const short = 'Call get_workflow_protocol with a workflow_id before calling start_run.';
      const full = `${short} If no workflow matches your task, use create_workflow to define and start your own plan.`;
      // (a) red when the sentence is kept for a caller that cannot create, or dropped for one that can;
      //     (b) prints the four hints.
      expect({
        none: await hint(),
        workflows: await hint({ caller: 'k', workflows: [MINE.id] }),
        readOnly: await hint({ caller: 'k', readOnly: true }),
        tools: await hint({ caller: 'k', tools: ['list_workflows', 'create_workflow'] }),
      }).toStrictEqual({ none: full, workflows: short, readOnly: short, tools: full });
    },
    BUDGET,
  );

  it(
    "the receipt covers only the key's workflows",
    async () => {
      const call = (limits?: RealmMcpServerOptions['limits']) =>
        connect({ disclosureProvider: bySubject, ...(limits !== undefined ? { limits } : {}) });
      const receipt = async (c: Call) =>
        (bodyOf(await c('list_workflows', {}))['disclosure'] as Json)['declared'];
      // (a) red when the receipt is built over every workflow (the other one's `unknown` wins);
      //     (b) prints both receipts.
      expect({
        all: await receipt(await call()),
        limited: await receipt(await call({ caller: 'k', workflows: [MINE.id] })),
      }).toStrictEqual({ all: 'unknown', limited: 'resolved' });
    },
    BUDGET,
  );
});

/** A provider whose set depends on the subject, as the CLI's does: OTHER's project cannot be read. */
async function bySubject(definition: WorkflowDefinition | undefined): Promise<DisclosureSet> {
  return definition?.id === OTHER.id
    ? compileDisclosure([], {
        declared: 'unknown',
        cause: 'load_failed',
        audience: 'agent',
        environment: 'swept',
      }).set
    : compileDisclosure([], { declared: 'resolved', audience: 'agent', environment: 'swept' }).set;
}

describe('check 3 (library level) — no existence oracle', () => {
  /** The run store, with `get` throwing a disk error for the ids in `failing`. */
  function failingReads(store: RunStore, failing: Set<string>): RunStore {
    return new Proxy(store, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === 'get') {
          return async (id: string) => {
            if (failing.has(id))
              throw Object.assign(new Error(`EIO reading ${id}`), { code: 'EIO' });
            return target.get(id);
          };
        }
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  it(
    'for each run tool, a missing run, a run of another workflow whose project cannot be read, and a run that cannot be read give the same reply bytes',
    async () => {
      const failing = new Set<string>();
      const call = await connect({
        runStore: failingReads(home.stores.runStore, failing),
        disclosureProvider: bySubject,
        limits: { caller: 'ci-runner', workflows: [MINE.id] },
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const bytes = (r: Result) => JSON.stringify(r);
      const rows: Record<string, unknown> = {};
      for (const tool of RUN_TOOLS) {
        const id = `nk2-oracle-${tool}`;
        const missing = bytes(await call(tool, ARGS(id)[tool]!));
        await seedRun(home.stores.runStore, run(id, OTHER.id));
        const other = bytes(await call(tool, ARGS(id)[tool]!));
        failing.add(id);
        const unreadable = bytes(await call(tool, ARGS(id)[tool]!));
        rows[tool] = { other: other === missing, unreadable: unreadable === missing };
      }
      const logged = stderr.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('to check key'));
      // (a) red when the refusal is rendered with the run's subject (the other workflow's `unknown`
      //     reaches the receipt), or when the read error gets its own words; (b) prints the rows and
      //     the count of masked log lines (one per read error).
      expect({ rows, logged: logged.length }).toStrictEqual({
        rows: Object.fromEntries(RUN_TOOLS.map((t) => [t, { other: true, unreadable: true }])),
        logged: RUN_TOOLS.length,
      });
    },
    BUDGET,
  );
});

describe('check 4 — callers with no limits are unchanged', () => {
  it('with no limits the check is the handler itself', () => {
    const handler = async () => ({ content: [] });
    // (a) red when a default limit is applied (a wrapper is returned); (b) prints a boolean.
    expect(withinLimits('start_run', {}, handler)).toBe(handler);
  });

  it(
    'a server with no limits serves every workflow and run, and a missing run keeps its not-found reply',
    async () => {
      const call = await connect();
      const r = await call('abandon_run', { run_id: 'nk2-nothing-here' });
      // (a) red when a default limit is applied; (b) prints the cells.
      expect({
        start: served(await call('start_run', { workflow_id: OTHER.id })),
        read: served(await call('get_run_state', { run_id: await fresh(OTHER) })),
        missing: bodyOf(r)['context_hint'],
      }).toStrictEqual({ start: true, read: true, missing: "Run 'nk2-nothing-here' not found." });
    },
    BUDGET,
  );
});

describe('check 5 — a malformed limits option is refused when the server is built', () => {
  const build = (limits: unknown) => () =>
    createRealmMcpServer({ ...home.stores, limits } as unknown as RealmMcpServerOptions);
  const words = (problem: string) =>
    `createRealmMcpServer: the limits option ${problem}. Refused when the server is built: a limit that is not understood could limit nothing. Fix the option.`;
  const tools =
    'list_workflows, get_workflow_protocol, get_run_state, start_run, start_run_batch, execute_step, advance_run, append_trace, abandon_run, create_workflow, submit_human_response, present_question';
  const CELLS: Array<[string, unknown, string]> = [
    ['not an object', 'tenant-a', 'is not an object'],
    ['null', null, 'is not an object'],
    ['a list', [], 'is not an object'],
    [
      'an unknown member (a typo)',
      { caller: 'k', workflow: ['x'] },
      'has an unknown member "workflow" (its members are caller, readOnly, tools and workflows)',
    ],
    ['an empty object', {}, 'has no caller: caller must be a non-empty string'],
    [
      'an empty caller',
      { caller: '', readOnly: true },
      'has no caller: caller must be a non-empty string',
    ],
    ['no limit', { caller: 'k' }, 'names no limit: give readOnly, tools or workflows'],
    ['readOnly false', { caller: 'k', readOnly: false }, 'has a readOnly that is not true'],
    [
      'readOnly beside tools',
      { caller: 'k', readOnly: true, tools: ['start_run'] },
      'has both readOnly and tools',
    ],
    [
      'tools as a string',
      { caller: 'k', tools: 'start_run_batch' },
      'has a tools member that is not a list',
    ],
    ['an empty tools list', { caller: 'k', tools: [] }, 'has an empty tools list'],
    [
      'a tool item that is not a string',
      { caller: 'k', tools: ['start_run', 3] },
      'has a tools item that is not a non-empty string',
    ],
    [
      'an unknown tool',
      { caller: 'k', tools: ['start_runs'] },
      `names the tool "start_runs", which is not a Realm tool (its tools: ${tools})`,
    ],
    [
      "a name from the object's prototype",
      { caller: 'k', tools: ['constructor'] },
      `names the tool "constructor", which is not a Realm tool (its tools: ${tools})`,
    ],
    ['an empty workflows list', { caller: 'k', workflows: [] }, 'has an empty workflows list'],
    [
      'an empty workflow item',
      { caller: 'k', workflows: ['x', ''] },
      'has a workflows item that is not a non-empty string',
    ],
  ];
  for (const [what, limits, problem] of CELLS) {
    it(`${what}: throws its named error`, () => {
      // (a) red when the build-time check is dropped, or this clause of it; (b) prints the thrown text.
      expect(build(limits)).toThrow(words(problem));
    });
  }

  it('a tool this server does not register still builds (submit_human_response under asked)', () => {
    // (a) red when "known" means "registered here"; (b) prints the throw, if any.
    expect(() =>
      createRealmMcpServer({
        ...home.stores,
        gateAnswers: 'asked',
        limits: { caller: 'k', tools: ['submit_human_response'] },
      }),
    ).not.toThrow();
  });
});

describe('check 8 — the reading tools', () => {
  it('the exported list is exactly the three reading tools, in the annotations order', () => {
    // (a) red when a tool is added to the list (it would widen every read-only key); (b) prints it.
    expect(READING_TOOLS).toStrictEqual([
      'list_workflows',
      'get_workflow_protocol',
      'get_run_state',
    ]);
  });
});
