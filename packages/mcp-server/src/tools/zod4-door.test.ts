// zod4-door.test.ts — the zod 4 unit (GHSA-mrhx-c7xc-m3w5; #324): through the real door (an
// in-process client, the SDK's full path: the element count, then zod, then the handler) — the five
// array bounds and the whole-call element cap (Z3), every refusal text an agent reads (Z4, pinned
// exactly from the new build), `tools/list` whole (Z5), the zod 4 path (`_zod`) on every exported
// schema, the acceptance controls (Z6), no input value in any text (axis 14), and the docs sentences
// that state them (Z8). Every value is a fake. Each assertion names (a) the change that turns it red
// and (b) what it prints: texts, code points, counts and booleans, never an environment or a key.
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUFFER_LIMIT_COUNT,
  FINAL_LIMIT_ENTRIES,
  JsonFileStore,
  JsonWorkflowStore,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer, MAX_TOOL_INPUT_ELEMENTS } from '../server.js';
import {
  createWorkflowArgsSchema,
  MAX_CREATE_WORKFLOW_PREDECESSORS,
  MAX_WORKFLOW_STEPS,
  metadataSchema,
  stepSchema,
} from './create-workflow.js';
import { advanceRunArgsSchema } from './advance-run.js';
import { submitHumanResponseArgsSchema } from './submit-human-response.js';
import { traceEntrySchema } from './execute-step.js';
import { presentQuestionArgsShape } from './present-question.js';
import { MAX_BATCH_ITEMS } from './start-run-batch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const flat = (t: string) => t.replace(/\s+/g, ' ');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

type Reply = Record<string, unknown>;

/** A door with temp stores; `forms` opens a second session under `asked` whose client shows forms
 *  (the one session where `present_question` is listed). */
async function connect() {
  const dir = await mkdtemp(join(tmpdir(), 'realm-zod4-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({ runStore, workflowStore });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'zod4', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const forms = createRealmMcpServer({
    runStore: new JsonFileStore(join(dir, 'runs2')),
    workflowStore: new JsonWorkflowStore(join(dir, 'wf2')),
    gateAnswers: 'asked',
  });
  const [ct2, st2] = InMemoryTransport.createLinkedPair();
  const client2 = new Client(
    { name: 'zod4-forms', version: '0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  await Promise.all([forms.connect(st2), client2.connect(ct2)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await (name === 'present_question' ? client2 : client).callTool({
      name,
      arguments: args,
    })) as { content: Array<{ text: string }>; isError?: boolean };
    const text = raw.content[0]!.text;
    try {
      return JSON.parse(text) as Reply;
    } catch {
      return { _text: text, _isError: raw.isError === true };
    }
  };
  return { call, client, client2, runStore, workflowStore };
}

const V = 'MCP error -32602: Input validation error: Invalid arguments for tool ';
const step = (extra: Record<string, unknown> = {}) => ({ id: 'a', description: 'b', ...extra });
const steps = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, description: 'd' }));
const names = (n: number) => Array.from({ length: n }, (_, i) => `x${i}`);
const entries = (n: number) => Array.from({ length: n }, () => ({ event: 'e' }));
const items = (n: number) => Array.from({ length: n }, () => ({ params: {} }));

describe('the zod 4 unit: through the door', () => {
  /** A workflow of one agent step `s1`, registered through the door, and a fresh run of it. */
  async function oneStep(call: (n: string, a: Record<string, unknown>) => Promise<Reply>) {
    const wf = await call('create_workflow', { steps: [{ id: 's1', description: 'd' }] });
    const wid = (wf['data'] as { workflow_id: string }).workflow_id;
    const fresh = async () => (await call('start_run', { workflow_id: wid }))['run_id'] as string;
    return { wid, fresh };
  }

  it('C1 `steps` and `depends_on`: N+1 refused before the handler with the exact text (no workflow registered), N accepted', async () => {
    const { call, workflowStore } = await connect();
    const workflows = async () => (await workflowStore.list()).length;
    const w0 = await workflows();
    const stepsOver = await call('create_workflow', { steps: steps(MAX_WORKFLOW_STEPS + 1) });
    const dependsOver = await call('create_workflow', {
      steps: [step({ depends_on: names(MAX_CREATE_WORKFLOW_PREDECESSORS + 1) })],
    });
    const w1 = await workflows();
    const stepsAt = await call('create_workflow', { steps: steps(MAX_WORKFLOW_STEPS) });
    const dependsAt = await call('create_workflow', {
      steps: [step({ depends_on: names(MAX_CREATE_WORKFLOW_PREDECESSORS) })],
    });
    // (a) red when `steps`' or `depends_on`'s `.max` is gone (its N+1 call reaches the handler, which
    //     registers a workflow or replies in realm's words), or N stops being accepted; (b) prints the
    //     texts, the workflow count and the states.
    expect({
      stepsOver: stepsOver['_text'],
      dependsOver: dependsOver['_text'],
      noWorkflow: w1 - w0,
      stepsAt: stepsAt['status'],
      // the handler's own reply (it refuses the first step's one name, in realm's words)
      dependsAt: Array.isArray(dependsAt['errors']) && dependsAt['_text'] === undefined,
    }).toEqual({
      stepsOver: `${V}create_workflow: Too big: expected array to have <=200 items at steps`,
      // re-pinned by the final pass (R3): `depends_on` takes one name, and two read realm's words
      dependsOver: `${V}create_workflow: depends_on lists more than one step; create_workflow takes at most one — the step just before this one (steps run in list order) at steps[0].depends_on`,
      noWorkflow: 0,
      stepsAt: 'ok',
      dependsAt: true,
    });
  });

  it('C1 `entries`: N+1 refused before the handler with the exact text (the buffer stays empty), N accepted', async () => {
    const { call } = await connect();
    const { fresh } = await oneStep(call);
    const r1 = await fresh();
    const over = await call('append_trace', {
      run_id: r1,
      step_id: 's1',
      entries: entries(BUFFER_LIMIT_COUNT + 1),
    });
    const afterOver = await call('append_trace', {
      run_id: r1,
      step_id: 's1',
      entries: entries(1),
    });
    const r2 = await fresh();
    const at = await call('append_trace', {
      run_id: r2,
      step_id: 's1',
      entries: entries(BUFFER_LIMIT_COUNT),
    });
    // (a) red when `entries`' `.max` is gone (the N+1 call reaches the handler and fills the buffer),
    //     or N stops being accepted; (b) prints the text and the buffer counts.
    expect({
      over: over['_text'],
      bufferAfterOver: afterOver['buffer_count'],
      at: at['buffer_count'],
    }).toEqual({
      over: `${V}append_trace: Too big: expected array to have <=200 items at entries`,
      bufferAfterOver: 1,
      at: BUFFER_LIMIT_COUNT,
    });
  });

  it('C1 `trace`: N+1 refused before the handler with the exact text (the step has no attempt), N accepted', async () => {
    const { call } = await connect();
    const { fresh } = await oneStep(call);
    const r = await fresh();
    const over = await call('execute_step', {
      run_id: r,
      command: 's1',
      trace: entries(BUFFER_LIMIT_COUNT + 1),
    });
    const state = await call('get_run_state', { run_id: r });
    const at = await call('execute_step', {
      run_id: r,
      command: 's1',
      params: {},
      trace: entries(BUFFER_LIMIT_COUNT),
    });
    // (a) red when `trace`'s `.max` is gone (the N+1 call reaches the handler and settles the step),
    //     or N stops being accepted; (b) prints the text, the step lists and the state.
    expect({
      over: over['_text'],
      noAttempt: [state['completed_steps'], state['in_progress_steps']],
      at: at['status'],
    }).toEqual({
      over: `${V}execute_step: Too big: expected array to have <=200 items at trace`,
      noAttempt: [[], []],
      at: 'ok',
    });
  });

  // A heavy cell: N = 1,000 runs written to the run store; its budget is its own (the config's rule).
  it(
    'C1 `items`: N+1 refused before the handler with the exact text (no run started), N accepted',
    { timeout: 60_000 },
    async () => {
      const { call, runStore } = await connect();
      const { wid } = await oneStep(call);
      const runs = async () => (await runStore.list()).length;
      const n0 = await runs();
      const over = await call('start_run_batch', {
        workflow_id: wid,
        max_items: 5000,
        items: items(MAX_BATCH_ITEMS + 1),
      });
      const n1 = await runs();
      await call('start_run_batch', {
        workflow_id: wid,
        max_items: 5000,
        items: items(MAX_BATCH_ITEMS),
      });
      const n2 = await runs();
      // (a) red when `items`' `.max` is gone (the N+1 call reaches the handler and starts runs), or N
      //     stops being accepted; (b) prints the text and the run counts.
      expect({ over: over['_text'], noRun: n1 - n0, at: n2 - n1 }).toEqual({
        over: `${V}start_run_batch: Too big: expected array to have <=1000 items at items`,
        noRun: 0,
        at: MAX_BATCH_ITEMS,
      });
    },
  );

  it('C1b the early stop is real: 10,000 wrong steps against the exported schema yield ONE issue, the size check', () => {
    const r = createWorkflowArgsSchema.safeParse({ steps: new Array(10_000).fill(1) });
    // The rule for every array schema here (the other four arrays too): the size checks come FIRST,
    // `.max(N)` (or `.min(1).max(N)`) right after `z.array(...)`, never after a `.refine` or a
    // `.transform`: zod 4.6.6+ stops early only on LEADING size checks (`sizeCaps`).
    // (a) red when `.max` stops being a leading check (thousands of issues); (b) prints the count
    //     and the first issue's code.
    expect([r.success, r.error?.issues.length, r.error?.issues[0]?.code]).toEqual([
      false,
      1,
      'too_big',
    ]);
  });

  it('C2 the element cap: more than MAX_TOOL_INPUT_ELEMENTS elements refused before any parameter is checked; fewer accepted', async () => {
    const { call, runStore } = await connect();
    const wf = await call('create_workflow', { steps: [{ id: 's1', description: 'd' }] });
    const wid = (wf['data'] as { workflow_id: string }).workflow_id;
    const n0 = (await runStore.list()).length;
    const over = await call('start_run', {
      workflow_id: wid,
      params: { big: new Array(MAX_TOOL_INPUT_ELEMENTS + 1).fill(0) },
    });
    const n1 = (await runStore.list()).length;
    const under = await call('start_run', {
      workflow_id: wid,
      params: { big: new Array(MAX_TOOL_INPUT_ELEMENTS - 10).fill(0) },
    });
    // (a) red when `maxToolInputElements` leaves the server's options (the big call reaches the
    //     handler and starts a run); (b) prints the text, the run count and the state.
    expect({ over: over['_text'], noRun: n1 - n0, under: under['status'] }).toEqual({
      over: `MCP error -32602: Invalid arguments for tool start_run: arguments contain more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`,
      noRun: 0,
      under: 'ok',
    });
  });

  // C3 — every refusal text an agent reads, pinned exactly (one row per issue kind; the bounds and
  // the element cap are C1 and C2). Kinds: (a) a missing required string, the ten tools with one;
  // (a′) a missing required array; (a″) a nested required field; (a‴) two missing fields, joined by a
  // line break; (b) a wrong type per expected kind; (c) an enum; (d) a literal; (e) a union; (f)
  // `.min(1)`; (h) `.int().positive()`; (i) a record given a string, the five sites; (m) a string
  // array's element, a step that is not an object, `metadata` that is not one.
  const C3: Array<[kind: string, tool: string, args: Record<string, unknown>, text: string]> = [
    ['a', 'abandon_run', {}, 'Invalid input: expected string, received undefined at run_id'],
    ['a', 'advance_run', {}, 'Invalid input: expected string, received undefined at run_id'],
    [
      'a',
      'append_trace',
      { step_id: 's', entries: [] },
      'Invalid input: expected string, received undefined at run_id',
    ],
    [
      'a',
      'execute_step',
      { command: 'c' },
      'Invalid input: expected string, received undefined at run_id',
    ],
    ['a', 'get_run_state', {}, 'Invalid input: expected string, received undefined at run_id'],
    [
      'a',
      'get_workflow_protocol',
      {},
      'Invalid input: expected string, received undefined at workflow_id',
    ],
    [
      'a',
      'present_question',
      { gate_id: 'g' },
      'Invalid input: expected string, received undefined at run_id',
    ],
    [
      'a',
      'start_run_batch',
      { items: [] },
      'Invalid input: expected string, received undefined at workflow_id',
    ],
    ['a', 'start_run', {}, 'Invalid input: expected string, received undefined at workflow_id'],
    [
      'a',
      'submit_human_response',
      { gate_id: 'g', choice: 'c' },
      'Invalid input: expected string, received undefined at run_id',
    ],
    ["a'", 'create_workflow', {}, 'Invalid input: expected array, received undefined at steps'],
    [
      "a''",
      'append_trace',
      { run_id: 'r', step_id: 's', entries: [{}] },
      'Invalid input: expected string, received undefined at entries[0].event',
    ],
    [
      "a'''",
      'present_question',
      {},
      // re-pinned by the final pass (R1 (ii)): two issues read as one summary
      '2 problems in 2 places\nrun_id: expected string\ngate_id: expected string',
    ],
    [
      'b string',
      'get_workflow_protocol',
      { workflow_id: 5 },
      'Invalid input: expected string, received number at workflow_id',
    ],
    [
      'b number',
      'create_workflow',
      { steps: [step({ llm_timeout_seconds: '30' })] },
      'Invalid input: expected number, received string at steps[0].llm_timeout_seconds',
    ],
    [
      'b boolean',
      'get_run_state',
      { run_id: 'r', include_steps: 'yes' },
      'Invalid input: expected boolean, received string at include_steps',
    ],
    [
      'b array',
      'append_trace',
      { run_id: 'r', step_id: 's', entries: 'x' },
      'Invalid input: expected array, received string at entries',
    ],
    [
      'b element',
      'start_run_batch',
      { workflow_id: 'w', items: ['x'] },
      'Invalid input: expected object, received string at items[0]',
    ],
    [
      'b null',
      'get_run_state',
      { run_id: null },
      'Invalid input: expected string, received null at run_id',
    ],
    [
      'c',
      'start_run',
      { workflow_id: 'w', on_terminal_match: 'x' },
      'Invalid option: expected one of "reuse"|"reject"|"rerun_if_failed"|"rerun" at on_terminal_match',
    ],
    [
      'c',
      'start_run',
      { workflow_id: 'w', on_live_match: 'x' },
      'Invalid option: expected one of "use_existing"|"fail" at on_live_match',
    ],
    [
      'c',
      'start_run_batch',
      { workflow_id: 'w', items: [], on_terminal_match: 'x' },
      'Invalid option: expected one of "reuse"|"reject"|"rerun_if_failed"|"rerun" at on_terminal_match',
    ],
    [
      'd',
      'create_workflow',
      { steps: [step({ structured_output: 'loose' })] },
      'Invalid input: expected "strict" at steps[0].structured_output',
    ],
    [
      'e',
      'execute_step',
      { run_id: 'r', command: 'c', trace: [{ event: 'e', data: { k: {} } }] },
      // re-pinned by the final pass (R1 O3): the union's own words
      'expected a string, a number, a boolean or null at trace[0].data.k',
    ],
    ['f', 'create_workflow', { steps: [] }, 'Too small: expected array to have >=1 items at steps'],
    [
      'h positive',
      'start_run_batch',
      { workflow_id: 'w', items: [], max_items: 0 },
      'Too small: expected number to be >0 at max_items',
    ],
    [
      'h int',
      'start_run_batch',
      { workflow_id: 'w', items: [], max_items: 1.5 },
      'Invalid input: expected int, received number at max_items',
    ],
    [
      'i input_schema',
      'create_workflow',
      { steps: [step({ input_schema: 'x' })] },
      'Invalid input: expected record, received string at steps[0].input_schema',
    ],
    [
      'i params',
      'execute_step',
      { run_id: 'r', command: 'c', params: 'x' },
      'Invalid input: expected record, received string at params',
    ],
    [
      'i trace data',
      'execute_step',
      { run_id: 'r', command: 'c', trace: [{ event: 'e', data: 'x' }] },
      'Invalid input: expected record, received string at trace[0].data',
    ],
    [
      'i items params',
      'start_run_batch',
      { workflow_id: 'w', items: [{ params: 'x' }] },
      'Invalid input: expected record, received string at items[0].params',
    ],
    [
      'i params',
      'start_run',
      { workflow_id: 'w', params: 'x' },
      'Invalid input: expected record, received string at params',
    ],
    [
      'm element',
      'create_workflow',
      { steps: [step({ depends_on: [1] })] },
      'Invalid input: expected string, received number at steps[0].depends_on[0]',
    ],
    [
      'm step',
      'create_workflow',
      { steps: ['x'] },
      'Invalid input: expected object, received string at steps[0]',
    ],
    [
      'm metadata',
      'create_workflow',
      { steps: [step()], metadata: 'x' },
      'Invalid input: expected object, received string at metadata',
    ],
  ];

  it('C3 every refusal text an agent reads, exactly, one row per issue kind', async () => {
    const { call } = await connect();
    const differ: string[] = [];
    for (const [kind, tool, args, text] of C3) {
      const r = await call(tool, args);
      if (r['_text'] !== `${V}${tool}: ${text}` || r['_isError'] !== true)
        differ.push(`${kind} ${tool}: ${String(r['_text'] ?? JSON.stringify(r).slice(0, 120))}`);
    }
    // (a) red when a field's schema changes its kind (made optional, `z.unknown()`, an enum widened,
    //     a literal or a union loosened, a check removed) or zod's wording moves; (b) prints each row
    //     whose reply differs, with the text it got.
    expect(differ).toEqual([]);
  });

  it('C4 tools/list: every tool’s inputSchema, whole, as the new build advertises it', async () => {
    const { client, client2 } = await connect();
    const listed: Record<string, unknown> = {};
    for (const t of (await client.listTools()).tools) listed[t.name] = t.inputSchema;
    for (const t of (await client2.listTools()).tools)
      if (!(t.name in listed)) listed[t.name] = t.inputSchema;
    // (a) red when a parameter's `.optional()`, type, bound, description or record form changes, or a
    //     tool is added or removed; (b) prints the differing schema.
    expect(Object.fromEntries(Object.entries(listed).sort())).toEqual(TOOLS_LIST);
  });

  it('C5 every exported schema is a zod 4 schema (`_zod`), the one path the SDK parses with the fixed code', () => {
    const schemas: Record<string, unknown> = {
      stepSchema,
      metadataSchema,
      createWorkflowArgsSchema,
      advanceRunArgsSchema,
      submitHumanResponseArgsSchema,
      traceEntrySchema,
      ...Object.fromEntries(
        Object.entries(presentQuestionArgsShape).map(([k, v]) => [
          `presentQuestionArgsShape.${k}`,
          v,
        ]),
      ),
    };
    // (a) red when a file builds its schemas from `zod/v3` (no `_zod`: the SDK would wrap and parse
    //     them on zod 3's unfixed array path, silently); (b) prints the schemas that lack it.
    expect(
      Object.entries(schemas)
        .filter(([, s]) => !(typeof s === 'object' && s !== null && '_zod' in s))
        .map(([n]) => n),
    ).toEqual([]);
  });

  it('C6 acceptance: each tool with only its required fields passes the schema; no params is `{}`; the allow-lists; `__proto__` never reaches the handler', async () => {
    const { call, runStore, workflowStore } = await connect();
    const required: Array<[string, Record<string, unknown>]> = [
      ['list_workflows', {}],
      ['create_workflow', { steps: [{ id: 's1', description: 'd' }] }],
      ['get_workflow_protocol', { workflow_id: 'w' }],
      ['start_run', { workflow_id: 'w' }],
      ['start_run_batch', { workflow_id: 'w', items: [] }],
      ['execute_step', { run_id: 'r', command: 'c' }],
      ['advance_run', { run_id: 'r' }],
      ['submit_human_response', { run_id: 'r', gate_id: 'g', choice: 'c' }],
      ['get_run_state', { run_id: 'r' }],
      ['abandon_run', { run_id: 'r' }],
      ['append_trace', { run_id: 'r', step_id: 's', entries: [] }],
      ['present_question', { run_id: 'r', gate_id: 'g' }],
    ];
    const refusedBySchema: string[] = [];
    for (const [tool, args] of required) {
      const r = await call(tool, args);
      if (typeof r['_text'] === 'string' && (r['_text'] as string).includes('Invalid arguments'))
        refusedBySchema.push(`${tool}: ${r['_text'] as string}`);
    }
    const wf = await call('create_workflow', { steps: [{ id: 's1', description: 'd' }] });
    const wid = (wf['data'] as { workflow_id: string }).workflow_id;
    const noParams = await call('start_run', { workflow_id: wid });
    const state = await call('get_run_state', { run_id: noParams['run_id'] as string });
    // `__proto__` as JSON delivers it: an OWN key, at the top level, inside a step, and in a record
    const polluted = JSON.parse(
      '{"steps":[{"id":"p1","description":"d","__proto__":{"polluted":true}}],"__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    const pwf = await call('create_workflow', polluted);
    const pid = (pwf['data'] as { workflow_id: string }).workflow_id;
    const stored = JSON.stringify(await workflowStore.get(pid));
    const prun = await call(
      'start_run',
      JSON.parse(`{"workflow_id":"${wid}","params":{"__proto__":{"polluted":true}}}`) as Record<
        string,
        unknown
      >,
    );
    const run = await runStore.get(prun['run_id'] as string);
    // (a) red when a required-only call is refused by the schema (a bare `z.unknown()` field: zod 4
    //     refuses a missing key), `params` stops defaulting to `{}`, a declared field leaves the
    //     schema without the allow-list (or the reverse), or `__proto__` reaches the handler or the
    //     prototype; (b) prints the refusals, the params, the key lists and booleans.
    expect({
      refusedBySchema,
      params: state['params'],
      top: Object.keys(createWorkflowArgsSchema.shape),
      step: Object.keys(stepSchema.shape),
      metadata: Object.keys(metadataSchema.shape),
      protoWorkflow: [pwf['status'], stored.includes('polluted')],
      // the final pass (A2): the sweep says nothing of `__proto__` (zod drops it before the handler)
      protoWarnings: pwf['warnings'],
      protoRun: [
        prun['status'],
        Object.prototype.hasOwnProperty.call(run.params ?? {}, '__proto__'),
      ],
      prototype: ({} as Record<string, unknown>)['polluted'],
    }).toEqual({
      refusedBySchema: [],
      params: {},
      top: ['steps', 'metadata', 'extensions'],
      step: [
        'id',
        'description',
        'depends_on',
        'input_schema',
        'llm_timeout_seconds',
        'structured_output',
      ],
      metadata: ['name', 'description', 'task_description', 'model', 'agent'],
      protoWorkflow: ['ok', false],
      protoWarnings: [],
      protoRun: ['ok', false],
      prototype: undefined,
    });
  });

  it('C6 (iii) `execute_step` without `params` is accepted and the step records `{}` (an acceptance control)', async () => {
    const { call, runStore } = await connect();
    const wf = await call('create_workflow', { steps: [{ id: 's1', description: 'd' }] });
    const wid = (wf['data'] as { workflow_id: string }).workflow_id;
    const run = await call('start_run', { workflow_id: wid });
    const reply = await call('execute_step', { run_id: run['run_id'] as string, command: 's1' });
    const record = await runStore.get(run['run_id'] as string);
    // An ACCEPTANCE control, not a test of zod's `.default({})`: the handler also falls back to `{}`
    // (`execute-step.ts`: `args.params ?? {}`), so removing the schema's default alone leaves this
    // green (run once, logged); the default itself is pinned by C4 (`"default": {}` in `tools/list`).
    // (a) red when `execute_step` without `params` stops being accepted, or the step stops recording
    //     `{}`; (b) prints the state and the step's recorded output.
    expect([reply['status'], record.evidence.at(-1)?.output_summary]).toEqual(['ok', {}]);
  });

  it('C7 no refusal text shows the value it refused', async () => {
    const { call } = await connect();
    const live = await call('start_run', { workflow_id: 'w', on_live_match: 'CANARY-zod4-value' });
    const steps = await call('get_run_state', { run_id: 'r', include_steps: 'CANARY-zod4-str' });
    // (a) red when an error message interpolates the input (a custom `error:` on the enum, or a
    //     wording that echoes the value); (b) prints the two texts' booleans.
    expect({
      liveNames: (live['_text'] as string).includes('expected one of'),
      liveValue: (live['_text'] as string).includes('CANARY-zod4-value'),
      stepsNames: (steps['_text'] as string).includes('expected boolean, received string'),
      stepsValue: (steps['_text'] as string).includes('CANARY-zod4-str'),
    }).toEqual({ liveNames: true, liveValue: false, stepsNames: true, stepsValue: false });
  });
});

describe('the zod 4 unit: the docs (each sentence with its cell)', () => {
  const TOOLS = 'docs/reference/mcp/tools.md';
  const GUIDE = 'docs/guides/agent-created-workflows.md';

  it('tools.md, "Calling a tool": the example refusal is the text the door returns', async () => {
    claim(
      TOOLS,
      '`MCP error -32602: Input validation error: Invalid arguments for tool execute_step: Invalid input: expected string, received undefined at command`.',
    );
    const { call } = await connect();
    // (a) red when the example drifts from the door's text; (b) prints the text.
    expect((await call('execute_step', { run_id: 'r' }))['_text']).toBe(
      `${V}execute_step: Invalid input: expected string, received undefined at command`,
    );
  });

  it('tools.md, the Limits bullet: its numbers are the code’s constants (C1, C2 run them), its texts the door’s', async () => {
    claim(
      TOOLS,
      `**Limits.** One call's arguments may hold at most ${MAX_TOOL_INPUT_ELEMENTS.toLocaleString('en-US')} array elements and object members, counted together at every depth; a larger call is refused before any parameter is checked, with \`MCP error -32602: Invalid arguments for tool start_run: arguments contain more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements\`.`,
    );
    claim(
      TOOLS,
      `\`create_workflow\` takes at most ${MAX_WORKFLOW_STEPS} steps, each with one \`depends_on\` — the step just before it; \`start_run_batch\` at most ${MAX_BATCH_ITEMS.toLocaleString('en-US')} items; \`append_trace\` and \`execute_step\` at most ${BUFFER_LIMIT_COUNT} trace entries in one call, the trace buffer's \`limit_count\`.`,
    );
    // The final pass (A2): the number is core's constant; the cut itself is executed by core's
    // trace-normalizer.test.ts "stores at most 100 entries, then appends sentinel".
    claim(
      TOOLS,
      `Of an \`execute_step\` trace the engine keeps the first ${FINAL_LIMIT_ENTRIES} and marks the cut with \`trace.truncated\`.`,
    );
    claim(
      TOOLS,
      'A longer list is refused before any of its items is checked, with, for example, `MCP error -32602: Input validation error: Invalid arguments for tool create_workflow: Too big: expected array to have <=200 items at steps`. The parameters are checked with zod 4.6.7 or later.',
    );
    claim(
      TOOLS,
      '| `max_items` | whole number | No | The largest batch accepted. Default 100. `items` holds at most 1,000, whatever this is. |',
    );
    const pkg = JSON.parse(
      await readFile(join(ROOT, 'packages/mcp-server/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    // (a) red when the declared zod range drops below 4.6.7; (b) prints it.
    expect(pkg.dependencies['zod']).toBe('^4.6.7');
  });

  it('agent-created-workflows.md: the two rows on steps are the texts the door returns (C3 f, C1)', async () => {
    claim(GUIDE, '| No steps | `Too small: expected array to have >=1 items at steps` |');
    claim(
      GUIDE,
      '| More than 200 steps | `Too big: expected array to have <=200 items at steps` |',
    );
    const { call } = await connect();
    // (a) red when a row drifts from the door's text; (b) prints the two texts.
    expect([
      (await call('create_workflow', { steps: [] }))['_text'],
      (await call('create_workflow', { steps: steps(201) }))['_text'],
    ]).toEqual([
      `${V}create_workflow: Too small: expected array to have >=1 items at steps`,
      `${V}create_workflow: Too big: expected array to have <=200 items at steps`,
    ]);
  });
});

describe('the zod 4 unit: the CHANGELOG bullet (each sentence with its cell)', () => {
  it('its bounds and cap text are the code’s constants (C1, C2 run them); each wording pair’s new text is a C3 row’s', () => {
    const CL = 'CHANGELOG.md';
    claim(
      CL,
      `one call's arguments hold at most ${MAX_TOOL_INPUT_ELEMENTS.toLocaleString('en-US')} array elements and object members, counted together; a larger call is refused before any parameter is checked, with \`Invalid arguments for tool start_run: arguments contain more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements\`;`,
    );
    claim(
      CL,
      `\`create_workflow\` takes at most ${MAX_WORKFLOW_STEPS} steps, each with one \`depends_on\` — the step just before it; \`start_run_batch\` at most ${MAX_BATCH_ITEMS.toLocaleString('en-US')} items; \`append_trace\` and \`execute_step\` at most ${BUFFER_LIMIT_COUNT} trace entries in one call. A longer list is refused with \`Too big: expected array to have <=200 items at steps\`.`,
    );
    // The wording list's new texts: C3's rows (a), (b), (c), (d), (f), (i), (h) run each one.
    claim(
      CL,
      '`Required` → `Invalid input: expected string, received undefined`; `Expected string, received number` → `Invalid input: expected string, received number`; `Invalid enum value. Expected \'a\' | \'b\', received \'c\'` → `Invalid option: expected one of "a"|"b"`; `Invalid literal value, expected "strict"` → `Invalid input: expected "strict"`; `Array must contain at least 1 element(s)` → `Too small: expected array to have >=1 items`; `Expected object, received string` (a record) → `Invalid input: expected record, received string`; `Number must be greater than 0` → `Too small: expected number to be >0`; `Expected integer, received float` → `Invalid input: expected int, received number`.',
    );
    // The unreleased SDK bullet's quoted refusal: C3 row (a).
    claim(
      CL,
      'the refusal names each missing parameter (`Invalid input: expected string, received undefined at run_id`).',
    );
  });
});

/** C4: `tools/list` on the new build (run first, then pinned). */
const TOOLS_LIST: Record<string, unknown> = {
  abandon_run: {
    type: 'object',
    properties: {
      run_id: {
        type: 'string',
      },
      reason: {
        type: 'string',
      },
    },
    required: ['run_id'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  advance_run: {
    type: 'object',
    properties: {
      run_id: {
        type: 'string',
      },
    },
    required: ['run_id'],
    $schema: 'http://json-schema.org/draft-07/schema#',
    additionalProperties: {},
  },
  append_trace: {
    type: 'object',
    properties: {
      run_id: {
        type: 'string',
      },
      step_id: {
        type: 'string',
      },
      entries: {
        maxItems: 200,
        type: 'array',
        items: {
          type: 'object',
          properties: {
            event: {
              type: 'string',
            },
            timestamp: {
              type: 'string',
            },
            data: {
              type: 'object',
              propertyNames: {
                type: 'string',
              },
              additionalProperties: {
                type: ['string', 'number', 'boolean', 'null'],
              },
            },
          },
          required: ['event'],
        },
      },
      writer_nonce: {
        type: 'string',
      },
    },
    required: ['run_id', 'step_id', 'entries'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  create_workflow: {
    type: 'object',
    properties: {
      steps: {
        minItems: 1,
        maxItems: 200,
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
            },
            description: {
              type: 'string',
            },
            depends_on: {
              maxItems: 1,
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                'Optional. At most one name: the step listed just before this one. create_workflow runs steps one at a time in list order, so each step already waits for every step above it.',
            },
            input_schema: {
              type: 'object',
              propertyNames: {
                type: 'string',
              },
              additionalProperties: {},
            },
            llm_timeout_seconds: {
              type: 'number',
            },
            structured_output: {
              type: 'string',
              const: 'strict',
            },
          },
          required: ['id', 'description'],
          additionalProperties: {},
          description:
            'A single workflow step. Valid fields: id, description, depends_on, input_schema, llm_timeout_seconds (positive integer seconds; the PER-ATTEMPT ceiling on this step\'s model request), structured_output (the literal "strict" — opts into constrained decoding; rejected pre-register if the input_schema is ineligible). Any other field is dropped and returned as a warning — do not invent step fields.',
        },
      },
      metadata: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
          },
          description: {
            type: 'string',
          },
          task_description: {
            type: 'string',
          },
          model: {
            type: 'string',
          },
          agent: {
            type: 'string',
          },
        },
        additionalProperties: {},
      },
      extensions: {},
    },
    required: ['steps'],
    $schema: 'http://json-schema.org/draft-07/schema#',
    additionalProperties: {},
  },
  execute_step: {
    type: 'object',
    properties: {
      run_id: {
        type: 'string',
      },
      command: {
        type: 'string',
      },
      params: {
        default: {},
        type: 'object',
        propertyNames: {
          type: 'string',
        },
        additionalProperties: {},
      },
      trace: {
        maxItems: 200,
        type: 'array',
        items: {
          type: 'object',
          properties: {
            event: {
              type: 'string',
            },
            timestamp: {
              type: 'string',
            },
            data: {
              type: 'object',
              propertyNames: {
                type: 'string',
              },
              additionalProperties: {
                type: ['string', 'number', 'boolean', 'null'],
              },
            },
          },
          required: ['event'],
        },
      },
      writer_nonce: {
        type: 'string',
      },
    },
    required: ['run_id', 'command'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_run_state: {
    type: 'object',
    properties: {
      run_id: {
        type: 'string',
      },
      include_steps: {
        type: 'boolean',
      },
    },
    required: ['run_id'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_workflow_protocol: {
    type: 'object',
    properties: {
      workflow_id: {
        type: 'string',
      },
    },
    required: ['workflow_id'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  list_workflows: {
    type: 'object',
    properties: {},
  },
  present_question: {
    type: 'object',
    properties: {
      run_id: {
        type: 'string',
      },
      gate_id: {
        type: 'string',
      },
    },
    required: ['run_id', 'gate_id'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  start_run: {
    type: 'object',
    properties: {
      workflow_id: {
        type: 'string',
      },
      params: {
        default: {},
        type: 'object',
        propertyNames: {
          type: 'string',
        },
        additionalProperties: {},
      },
      idempotency_key: {
        type: 'string',
      },
      on_terminal_match: {
        type: 'string',
        enum: ['reuse', 'reject', 'rerun_if_failed', 'rerun'],
      },
      on_live_match: {
        type: 'string',
        enum: ['use_existing', 'fail'],
      },
    },
    required: ['workflow_id'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  start_run_batch: {
    type: 'object',
    properties: {
      workflow_id: {
        type: 'string',
      },
      items: {
        maxItems: 1000,
        type: 'array',
        items: {
          type: 'object',
          properties: {
            params: {
              type: 'object',
              propertyNames: {
                type: 'string',
              },
              additionalProperties: {},
            },
            idempotency_key: {
              type: 'string',
            },
          },
          required: ['params'],
        },
      },
      parent_run_id: {
        type: 'string',
      },
      max_items: {
        type: 'integer',
        exclusiveMinimum: 0,
        maximum: 9007199254740991,
      },
      on_terminal_match: {
        type: 'string',
        enum: ['reuse', 'reject', 'rerun_if_failed', 'rerun'],
      },
      on_live_match: {
        type: 'string',
        enum: ['use_existing', 'fail'],
      },
    },
    required: ['workflow_id', 'items'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  submit_human_response: {
    type: 'object',
    properties: {
      run_id: {
        type: 'string',
      },
      gate_id: {
        type: 'string',
      },
      choice: {
        type: 'string',
      },
      responded_by: {
        description:
          'Who made the choice, as the caller states it — not verified. At most 200 characters, no control characters.',
        type: 'string',
      },
      claim_token: {
        description:
          'The claim_token in the answer instruction of the reply that opened this question (its next_actions entry). Pass it back unchanged; it shows this answer comes from the conversation that opened the question. Never required.',
        type: 'string',
      },
    },
    required: ['run_id', 'gate_id', 'choice'],
    $schema: 'http://json-schema.org/draft-07/schema#',
    additionalProperties: {},
  },
};
