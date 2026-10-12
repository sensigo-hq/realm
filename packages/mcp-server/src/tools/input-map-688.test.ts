// input-map-688.test.ts — issue #688 over a real MCP client (`createRealmMcpServer`, in-memory
// transport), on a server holding the workflow's handler — what `realm mcp --project` loads from a
// workflow's `extensions:`. A step that consumes its `input_map` is judged on what the map builds:
// `get_run_state` offers it, and its own refusal says `report_to_user` and carries the way out.
//
// Beside each assertion: (a) what turns it red; (b) what it prints on failure (the reply's hint,
// action and offered tools, the handler's input) — never an environment.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  executeStep,
  loadWorkflowFromString,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

type Reply = Record<string, unknown>;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')).includes(flat(sentence)),
    `${page} no longer says: ${sentence}`,
  ).toBe(true);
}

/** A server whose registry has the handler `h`, which records the input it receives. */
async function connect() {
  const seen: unknown[] = [];
  const registry = new ExtensionRegistry();
  registry.register('handler', 'h', {
    id: 'h',
    execute: async (input: { params: Record<string, unknown> }) => {
      seen.push(input.params);
      return { data: { got: input.params } };
    },
  } as never);
  const dir = await mkdtemp(join(tmpdir(), 'realm-688-mcp-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({ runStore, workflowStore, registry });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'input-map-688', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  return { call, runStore, workflowStore, registry, seen };
}

const tools = (r: Reply): string[] =>
  ((r['next_actions'] as Array<{ instruction?: { tool?: string } }>) ?? []).map(
    (n) => n.instruction?.tool ?? '',
  );

/** The issue's shape (b): an agent step, then a handler step mapping its output. */
const SHAPE_B = [
  'id: mcp688b',
  'name: mcp688b',
  'version: 1',
  'steps:',
  '  summarize:',
  '    description: Sum.',
  '    execution: agent',
  '  publish:',
  '    description: Pub.',
  '    execution: auto',
  '    handler: h',
  '    depends_on: [summarize]',
  '    input_map:',
  '      text: context.resources.summarize.summary',
  '    input_schema:',
  '      type: object',
  '      required: [text]',
  '',
].join('\n');

/** The issue's shape (a): a handler step mapping run.params. */
const SHAPE_A = [
  'id: mcp688a',
  'name: mcp688a',
  'version: 1',
  'steps:',
  '  x:',
  '    description: X.',
  '    execution: auto',
  '    handler: h',
  '    input_map:',
  '      n: run.params.num',
  '    input_schema:',
  '      type: object',
  '      required: [n]',
  '',
].join('\n');

describe('#688 over MCP — the view, and a refusal’s reply', () => {
  it('cell 2: get_run_state offers advance_run for the mapped step once its input is there', async () => {
    const { call, runStore, workflowStore, registry } = await connect();
    const definition = loadWorkflowFromString(SHAPE_B);
    await workflowStore.register(definition);
    const runId = (await call('start_run', { workflow_id: 'mcp688b', params: {} }))[
      'run_id'
    ] as string;
    // The agent step is answered by core's `executeStep`, which runs that step alone: an
    // `execute_step` over MCP would chain the mapped step at once, and the view would have nothing
    // left to show.
    await executeStep(runStore, definition, {
      runId,
      command: 'summarize',
      input: { summary: 'hi' },
      dispatcher: async (_name, input) => ({ ...input }),
      registry,
    });
    const state = await call('get_run_state', { run_id: runId });
    // (a) red when the view checks the engine's input `{}` (the step is refused `input_schema`, and
    //     `advance_run` is not offered); (b) prints the offered tools and `engine_runnable`.
    expect({ tools: tools(state), engine: state['engine_runnable'] }).toEqual({
      tools: ['advance_run'],
      engine: [{ step: 'publish', runnable_here: true }],
    });
  });

  it('cell 4 (b): execute_step on the mapped step whose built input lacks `text` — report_to_user, and the way out in the hint', async () => {
    claim(
      'docs/reference/mcp/tools.md',
      "A step that builds its input with an `input_map` (one with a `handler` or a `uses_service`) has its schema check what the map builds, and its way is `For '<step>', correct its input_map or its input_schema and register the workflow again; …`, with `start a run with params that fit, or ` before `correct` when the key its schema refuses is built from `run.params`.",
    );
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      'For a step that builds its input with an `input_map` (one with a `handler` or a `uses_service`), its schema checks what the map builds: a corrected `input_map` or `input_schema`, or a new run with params that fit when the key its schema refuses is built from `run.params`.',
    );
    const { call, workflowStore, seen } = await connect();
    await workflowStore.register(loadWorkflowFromString(SHAPE_B));
    const runId = (await call('start_run', { workflow_id: 'mcp688b', params: {} }))[
      'run_id'
    ] as string;
    await call('execute_step', { run_id: runId, command: 'summarize', params: { other: 'x' } });
    const r = await call('execute_step', {
      run_id: runId,
      command: 'publish',
      params: { text: 'typed' },
    });
    // (a) red when the caller's `{text: 'typed'}` is what is checked (the handler then runs on the
    //     mapped input), when the reply says `provide_input`, or when its hint lacks the way out;
    //     `status` red when the refusal is not an `error` reply; `details` red when the refusal is
    //     counted as an agent step's (`rejections` and `threshold` join `errors`); `missing` red
    //     when the rule broken is not the map's missing `text`; (b) prints the reply's status, code,
    //     action, whole hint, `error_details` keys and the missing property, and the handler's input
    //     — also when the reply has no `error_details` (the step ran), instead of a TypeError.
    const details = r['error_details'] as
      { errors?: Array<{ params?: { missingProperty?: string } }> } | undefined;
    expect({
      status: r['status'],
      code: r['error_code'],
      action: r['agent_action'],
      hint: r['context_hint'],
      details: details === undefined ? details : Object.keys(details),
      missing: details?.errors?.[0]?.params?.missingProperty,
      received: seen,
    }).toEqual({
      status: 'error',
      code: 'VALIDATION_INPUT_SCHEMA',
      action: 'report_to_user',
      hint: "Error during 'publish'. Run phase: 'running'. For 'publish', correct its input_map or its input_schema and register the workflow again; then, after a fix, call advance_run; or end the run with abandon_run.",
      details: ['errors'],
      missing: 'text',
      received: [],
    });
  });

  it('cell 4 (a): params without `num` — the way out offers a new run with params that fit first', async () => {
    const { call, workflowStore } = await connect();
    await workflowStore.register(loadWorkflowFromString(SHAPE_A));
    const runId = (await call('start_run', { workflow_id: 'mcp688a', params: { other: 1 } }))[
      'run_id'
    ] as string;
    const r = await call('execute_step', { run_id: runId, command: 'x', params: {} });
    // (a) red when the refusal offers the input_schema-only fix, or no new run; (b) prints the
    //     reply's action and whole hint.
    expect({ action: r['agent_action'], hint: r['context_hint'] }).toEqual({
      action: 'report_to_user',
      hint: "Error during 'x'. Run phase: 'running'. For 'x', start a run with params that fit, or correct its input_map or its input_schema and register the workflow again; then, after a fix, call advance_run; or end the run with abandon_run.",
    });
  });

  it('cell 5 (control): the way out appears only when nothing else can run', async () => {
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      loadWorkflowFromString(
        SHAPE_B.replace('id: mcp688b', 'id: mcp688c').replace('name: mcp688b', 'name: mcp688c') +
          ['  review:', '    description: Rev.', '    execution: agent', ''].join('\n'),
      ),
    );
    const runId = (await call('start_run', { workflow_id: 'mcp688c', params: {} }))[
      'run_id'
    ] as string;
    await call('execute_step', { run_id: runId, command: 'summarize', params: { other: 'x' } });
    const first = await call('execute_step', { run_id: runId, command: 'publish', params: {} });
    // (a) red when the way out is appended while `review` can still run (the mapped refusal
    //     skipping the "nothing else can run" check), or the reply stops offering `review`;
    //     (b) prints the action, the whole hint and the offered tools.
    expect({
      action: first['agent_action'],
      hint: first['context_hint'],
      tools: tools(first),
    }).toEqual({
      action: 'report_to_user',
      hint: "Error during 'publish'. Run phase: 'running'.",
      tools: ['execute_step'],
    });
    await call('execute_step', { run_id: runId, command: 'review', params: {} });
    const again = await call('execute_step', { run_id: runId, command: 'publish', params: {} });
    const way =
      "For 'publish', correct its input_map or its input_schema and register the workflow again; then, after a fix, call advance_run; or end the run with abandon_run.";
    const hint = String(again['context_hint']);
    // (a) red when, with `review` done and nothing else able to run, the hint lacks the way out;
    //     (b) prints the hint's ending, and the whole hint in the message.
    expect(hint.slice(Math.max(0, hint.length - way.length)), `the whole hint: ${hint}`).toBe(way);
  });

  it('cell 6: a uses_service step whose input_map builds no `path` — report_to_user, and the way out', async () => {
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      loadWorkflowFromString(
        [
          'id: mcp688s',
          'name: mcp688s',
          'version: 1',
          'services:',
          '  files:',
          '    adapter: filesystem',
          '    trust: engine_delivered',
          'steps:',
          '  read_note:',
          '    description: Read.',
          '    execution: auto',
          '    uses_service: files',
          '    operation: read',
          '    input_map:',
          '      path: run.params.path',
          '    input_schema:',
          '      type: object',
          '      required: [path]',
          '',
        ].join('\n'),
      ),
    );
    const runId = (await call('start_run', { workflow_id: 'mcp688s', params: {} }))[
      'run_id'
    ] as string;
    const r = await call('execute_step', {
      run_id: runId,
      command: 'read_note',
      params: { path: 'note.txt' },
    });
    // (a) red when a `uses_service` step is not judged on what its map builds (the caller's
    //     `path` passes the schema and the read fails, or the step stops empty), or the reply
    //     lacks `report_to_user` or the way out; `status`, `code` and `details` red when the
    //     refusal is not the input-schema error with its rules — the hint is built from the run's
    //     view, not from the reply's code, so it cannot catch that; (b) prints the status, code,
    //     action, whole hint and `error_details` keys.
    const details = r['error_details'] as object | undefined;
    expect({
      status: r['status'],
      code: r['error_code'],
      action: r['agent_action'],
      hint: r['context_hint'],
      details: details === undefined ? details : Object.keys(details),
    }).toEqual({
      status: 'error',
      code: 'VALIDATION_INPUT_SCHEMA',
      action: 'report_to_user',
      hint: "Error during 'read_note'. Run phase: 'running'. For 'read_note', start a run with params that fit, or correct its input_map or its input_schema and register the workflow again; then, after a fix, call advance_run; or end the run with abandon_run.",
      details: ['errors'],
    });
  });

  it('cell 7: two refused mapped steps — the way out gives each refused step its own way, then the run’s', async () => {
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      loadWorkflowFromString(
        [
          'id: mcp688t',
          'name: mcp688t',
          'version: 1',
          'steps:',
          '  summarize:',
          '    description: Sum.',
          '    execution: agent',
          '  p1:',
          '    description: P1.',
          '    execution: auto',
          '    handler: h',
          '    depends_on: [summarize]',
          '    input_map:',
          '      text: context.resources.summarize.summary',
          '    input_schema:',
          '      type: object',
          '      required: [text]',
          '  p2:',
          '    description: P2.',
          '    execution: auto',
          '    handler: h',
          '    depends_on: [summarize]',
          '    input_map:',
          '      t: run.params.t',
          '    input_schema:',
          '      type: object',
          '      required: [t]',
          '',
        ].join('\n'),
      ),
    );
    const runId = (await call('start_run', { workflow_id: 'mcp688t', params: {} }))[
      'run_id'
    ] as string;
    await call('execute_step', { run_id: runId, command: 'summarize', params: { other: 'x' } });
    const r = await call('execute_step', { run_id: runId, command: 'p1', params: {} });
    // (a) red when the way out names only the step called, or drops a refused step's own way
    //     (`p2`'s new run with params that fit); (b) prints the action and the whole hint.
    expect({ action: r['agent_action'], hint: r['context_hint'] }).toEqual({
      action: 'report_to_user',
      hint: "Error during 'p1'. Run phase: 'running'. For 'p1', correct its input_map or its input_schema and register the workflow again; for 'p2', start a run with params that fit, or correct its input_map or its input_schema and register the workflow again; then, after a fix, call advance_run; or end the run with abandon_run.",
    });
  });
});

describe('#688 correction — the docs say what a mapped step called by name is told', () => {
  // Beside each: (a) red when the page no longer holds the words (the docs flip); (b) prints them.
  it('item 1: error-codes.md, the paragraph after the three-case table — a mapped auto step is the exception', () => {
    // Executed by cells 4 (b) and 6: the refusal says `report_to_user`, not `provide_input`.
    claim(
      'docs/reference/error-codes.md',
      "An `auto` step that builds its input with `input_map` (one with a `handler` or a `uses_service`) is the exception: its schema checks what the map builds, not the caller's input, so the reply says `report_to_user`.",
    );
  });

  it('item 2: error-codes.md, the VALIDATION_INPUT_SCHEMA row names the input the map builds', () => {
    // Executed by cells 4 (b) and 6: the code is `VALIDATION_INPUT_SCHEMA` for the built input.
    claim(
      'docs/reference/error-codes.md',
      "An answer does not fit the step's `input_schema`, or the input an `auto` step with a `handler` or a `uses_service` builds with its `input_map` does not fit it,",
    );
  });

  it('item 3: tools.md, the execute_step outcome row for a mapped auto step', () => {
    // Executed by cells 4 (b) (status, code, action, `error_details` = `errors` only, the way out),
    // 5 (the way out only when nothing else can run) and 6 (a `uses_service` step).
    claim(
      'docs/reference/mcp/tools.md',
      '| You called an `auto` step that builds its input with `input_map` (one with a `handler` or a `uses_service`), and what the map builds does not fit its schema | `error` | `error_code: "VALIDATION_INPUT_SCHEMA"`, `agent_action: "report_to_user"`, and in `error_details` the rules broken, without `rejections` or `threshold`. When nothing else can run, `context_hint` ends with the way out: each refused step\'s own way, then the run\'s, as for [`advance_run`](#advance_run). |',
    );
  });

  it('item 4: tools.md, the by-name refusal paragraph — the mapped exception', () => {
    // Executed by cells 4 (b), 5 and 6: `report_to_user`, and the way out when nothing else can run.
    claim(
      'docs/reference/mcp/tools.md',
      "An input its schema refuses is the caller's own input, and that reply is unchanged, except for an `auto` step that builds its input with `input_map` (one with a `handler` or a `uses_service`): its schema checks what the map builds, not the caller's input, so the reply says `report_to_user`, and when nothing else can run its `context_hint` ends with the way out, each refused step's own way first.",
    );
  });
});
