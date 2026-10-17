// async-schema-runtime.test.ts — a definition stored with a root `$async` (written directly with
// `JsonWorkflowStore.register`, bypassing the loader, as an earlier version stored it) is refused at
// its first check of each kind, over a real in-process MCP client, and the server stays up; the
// two remedies work; and a program embedding the engine (a child process per kind) is refused
// without a rejection left unawaited. What a failing cell prints: statuses, codes, agent actions,
// booleans and exit codes — never a value.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  JsonFileStore,
  JsonWorkflowStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  asyncSchemaValidity,
  type WorkflowDefinition,
  type StepDefinition,
} from '@sensigo/realm';
import { createRealmMcpServer } from '../server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
type Reply = Record<string, unknown>;

async function connect() {
  const base = await mkdtemp(join(tmpdir(), 'realm-async-runtime-'));
  const runStore = new JsonFileStore(join(base, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(base, 'wf'));
  const registry = createDefaultRegistry();
  registry.register('handler', 'h', { id: 'h', execute: async () => ({ data: { ok: true } }) });
  const server = createRealmMcpServer({ runStore, workflowStore, registry });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'async-schema-runtime', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  return { call, runStore, workflowStore };
}

const ASYNC = {
  $async: true,
  type: 'object',
  required: ['x'],
  properties: { x: { type: 'number' } },
};
const def = (
  id: string,
  steps: Record<string, Partial<StepDefinition>>,
  extra: Partial<WorkflowDefinition> = {},
): WorkflowDefinition =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
    ...extra,
  }) as WorkflowDefinition;
const agent = (extra: Partial<StepDefinition> = {}): Partial<StepDefinition> => ({
  description: 'a',
  execution: 'agent',
  ...extra,
});
/** The run-time message's three parts (the validity, the consequence for this check, the remedy). */
const runTimeForm = (text: string) => ({
  validity: text.includes(asyncSchemaValidity(true)),
  cannotRun: text.includes(', so this check cannot run'),
  remedy: text.includes('Remove `$async` from the schema and register the workflow again'),
});
const ALL = { validity: true, cannotRun: true, remedy: true };
const firstError = (r: Reply) => String(((r['errors'] as string[] | undefined) ?? [])[0]);

describe('a definition stored with a root $async is refused at its first check of each kind', () => {
  it('4. input, agent step: an error reply with the run-time form; nothing accepted; the server still answers', async () => {
    const { call, workflowStore } = await connect();
    await workflowStore.register(def('in-agent', { a: agent({ input_schema: ASYNC as never }) }));
    const started = await call('start_run', { workflow_id: 'in-agent' });
    const reply = await call('execute_step', {
      run_id: started['run_id'],
      command: 'a',
      params: {},
    });
    const later = await call('get_run_state', { run_id: started['run_id'] });
    // (a) red when the detection is removed (the reply is ok — the input accepted unchecked — or
    //     the server dies); (b) prints the status, code, agent action, booleans and the steps.
    expect({
      status: reply['status'],
      code: reply['error_code'],
      agentAction: reply['agent_action'],
      ...runTimeForm(firstError(reply)),
      laterPhase: later['run_phase'],
      completed: later['completed_steps'],
    }).toEqual({
      status: 'error',
      code: 'VALIDATION_WORKFLOW_SCHEMA',
      agentAction: 'stop',
      ...ALL,
      laterPhase: 'running',
      completed: [],
    });
  });

  it('4. input, engine-supplied (mapped): the agent’s step completes, the next cannot run, report_to_user, with the run-time form', async () => {
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      def('in-engine', {
        a: agent(),
        b: {
          description: 'b',
          execution: 'auto',
          depends_on: ['a'],
          handler: 'h',
          input_map: { x: 'context.resources.a.x' },
          input_schema: ASYNC as never,
        },
      }),
    );
    const started = await call('start_run', { workflow_id: 'in-engine' });
    const reply = await call('execute_step', {
      run_id: started['run_id'],
      command: 'a',
      params: { x: 'nope' },
    });
    const hint = String(reply['context_hint']);
    const later = await call('get_run_state', { run_id: started['run_id'] });
    // (a) red when the detection is removed (b runs on input its schema never checked); (b) prints
    //     the status, agent action, booleans and the steps.
    expect({
      status: reply['status'],
      agentAction: reply['agent_action'],
      cannotRunLine: hint.includes("'b' cannot run (input_schema): "),
      ...runTimeForm(hint),
      completed: later['completed_steps'],
    }).toEqual({
      status: 'ok',
      agentAction: 'report_to_user',
      cannotRunLine: true,
      ...ALL,
      completed: ['a'],
    });
  });

  it.each([
    ['output', agent({ output_schema: ASYNC as never }), undefined],
    [
      'trace, enforce',
      agent({
        trace_schema: { $async: true, type: 'array' } as never,
        trace_validation_mode: 'enforce',
      }),
      [{ seq: 1, event: 'e' }],
    ],
  ] as const)('4. %s: an error reply with the run-time form', async (kind, a, trace) => {
    const { call, workflowStore } = await connect();
    const id = `k-${kind.replace(/[^a-z]/g, '')}`;
    await workflowStore.register(def(id, { a }));
    const started = await call('start_run', { workflow_id: id });
    const reply = await call('execute_step', {
      run_id: started['run_id'],
      command: 'a',
      params: {},
      ...(trace !== undefined ? { trace } : {}),
    });
    // (a) red when the detection is removed; (b) prints the status, code, agent action, booleans.
    expect({
      status: reply['status'],
      code: reply['error_code'],
      agentAction: reply['agent_action'],
      ...runTimeForm(firstError(reply)),
    }).toEqual({
      status: 'error',
      code: 'VALIDATION_WORKFLOW_SCHEMA',
      agentAction: 'stop',
      ...ALL,
    });
  });

  it('4. trace, warn: the step proceeds, and its warnings carry the $async warning', async () => {
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      def('tr-warn', { a: agent({ trace_schema: { $async: true, type: 'array' } as never }) }),
    );
    const started = await call('start_run', { workflow_id: 'tr-warn' });
    const reply = await call('execute_step', {
      run_id: started['run_id'],
      command: 'a',
      params: {},
      trace: [{ seq: 1, event: 'e' }],
    });
    const warnings = (reply['warnings'] as string[] | undefined) ?? [];
    const warning = warnings.find((w) =>
      w.startsWith("Trace schema for step 'a' was not checked: "),
    );
    // (a) red when the detection is removed (an asynchronous check runs), the warn arm throws, or
    //     the warning carries the run-time form's remedy (retry, abandon) instead of its own; (b)
    //     prints the status and booleans.
    expect({
      status: reply['status'],
      warned: warning !== undefined,
      ownRemedy: String(warning).endsWith(
        "Remove `$async` from the trace schema and register the workflow again; this step's " +
          'trace was kept unchecked.',
      ),
      runTimeRemedy: /retry|abandon/.test(String(warning)),
    }).toEqual({ status: 'ok', warned: true, ownRemedy: true, runTimeRemedy: false });
  });

  it('4. params: start_run is refused, no run was created', async () => {
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(def('par', { a: agent() }, { params_schema: ASYNC as never }));
    const reply = await call('start_run', { workflow_id: 'par', params: {} });
    const message = firstError(reply);
    // (a) red when the detection is removed (a run is created, its params unchecked); (b) prints
    //     the status, code, booleans and the run count.
    expect({
      status: reply['status'],
      code: reply['error_code'],
      validity: message.includes(asyncSchemaValidity(true)),
      noRun: message.includes('No run was created'),
      runs: (await runStore.list()).length,
    }).toEqual({
      status: 'error',
      code: 'VALIDATION_WORKFLOW_SCHEMA',
      validity: true,
      noRun: true,
      runs: 0,
    });
  });

  it('4. params, start_run_batch: the typed refusal, never "N item(s) failed schema validation"', async () => {
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(
      def('par-batch', { a: agent() }, { params_schema: ASYNC as never }),
    );
    const reply = await call('start_run_batch', {
      workflow_id: 'par-batch',
      items: [{ params: {} }, { params: { x: 1 } }],
    });
    const message = firstError(reply);
    // (a) red when the batch loop's rethrow is removed (VALIDATION_BATCH_ITEMS, provide_input,
    //     "2 item(s) failed schema validation"); (b) prints the status, code, agent action and
    //     booleans. The run count pins the message's claim "No run was created": it is green
    //     before the fix too, by design (the misnamed refusal also creates none).
    expect({
      status: reply['status'],
      code: reply['error_code'],
      agentAction: reply['agent_action'],
      paramsForm: message.startsWith("Workflow 'par-batch' declares a params_schema with "),
      validity: message.includes(asyncSchemaValidity(true)),
      noRunSaid: message.includes('No run was created'),
      itemsFailed: message.includes('item(s) failed'),
      runs: (await runStore.list()).length,
    }).toEqual({
      status: 'error',
      code: 'VALIDATION_WORKFLOW_SCHEMA',
      agentAction: 'stop',
      paramsForm: true,
      validity: true,
      noRunSaid: true,
      itemsFailed: false,
      runs: 0,
    });
  });

  it('4. the remedies: registered again without $async under the same id, the refused call is accepted; a refused run can be abandoned', async () => {
    const { call, workflowStore } = await connect();
    await workflowStore.register(def('heal', { a: agent({ input_schema: ASYNC as never }) }));
    const started = await call('start_run', { workflow_id: 'heal' });
    const refused = await call('execute_step', {
      run_id: started['run_id'],
      command: 'a',
      params: { x: 1 },
    });
    const { $async: _dropped, ...fixed } = ASYNC;
    await workflowStore.register(def('heal', { a: agent({ input_schema: fixed as never }) }));
    const retried = await call('execute_step', {
      run_id: started['run_id'],
      command: 'a',
      params: { x: 1 },
    });
    await workflowStore.register(def('stuck', { a: agent({ input_schema: ASYNC as never }) }));
    const other = await call('start_run', { workflow_id: 'stuck' });
    await call('execute_step', { run_id: other['run_id'], command: 'a', params: { x: 1 } });
    const abandoned = await call('abandon_run', { run_id: other['run_id'] });
    // (a) red when a definition registered again under its id is not read by the run, or a refused
    //     run cannot be abandoned; (b) prints the two statuses and the abandoned run's phase. The
    //     abandon half pins the message's claim ("… and abandon this one"): abandon_run works on
    //     any running run, so that half is green before the fix too, by design.
    expect({
      refused: refused['status'],
      retried: retried['status'],
      // abandon_run's reply has its own shape (no `status`): its phase says the run ended.
      abandonedPhase: abandoned['run_phase'],
    }).toEqual({ refused: 'error', retried: 'ok', abandonedPhase: 'abandoned' });
  });

  it('4. the library, one child process per kind: each refused, none leaves a rejection unawaited', () => {
    const lines = ['input', 'output', 'trace-warn', 'trace-enforce', 'params'].map((kind) => {
      const r = spawnSync(process.execPath, [join(HERE, 'async-schema-runtime-child.mjs'), kind], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { kind, code: r.status, out: r.stdout.trim() };
    });
    // (a) red when the detection is removed (a child exits 3 on the unawaited rejection, or prints
    //     an accepted verdict); (b) prints each kind's exit code and its one line.
    expect(lines).toEqual([
      { kind: 'input', code: 0, out: 'error VALIDATION_WORKFLOW_SCHEMA' },
      { kind: 'output', code: 0, out: 'error VALIDATION_WORKFLOW_SCHEMA' },
      { kind: 'trace-warn', code: 0, out: 'ok - warned=true' },
      { kind: 'trace-enforce', code: 0, out: 'error VALIDATION_WORKFLOW_SCHEMA' },
      { kind: 'params', code: 0, out: 'VALIDATION_WORKFLOW_SCHEMA' },
    ]);
  }, 120_000);
});
