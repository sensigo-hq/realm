// async-schema-create.test.ts — `create_workflow` refuses a step `input_schema` whose root carries
// a truthy `$async`, in its own clauses (the validity, the consequence, the remedy), over a real
// in-process MCP client: nothing is registered and no run is created; the same workflow without
// `$async` is created. What a failing cell prints: the reply's status, booleans per clause, counts.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  JsonFileStore,
  JsonWorkflowStore,
  SCHEMA_KEY_CONSEQUENCE,
  asyncSchemaValidity,
} from '@sensigo/realm';
import { createRealmMcpServer } from '../server.js';

type Reply = Record<string, unknown>;

async function connect() {
  const base = await mkdtemp(join(tmpdir(), 'realm-async-create-'));
  const runStore = new JsonFileStore(join(base, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(base, 'wf'));
  const server = createRealmMcpServer({ runStore, workflowStore });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'async-schema-create', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  return { call, runStore, workflowStore };
}

const step = (input_schema: Record<string, unknown>) => ({
  id: 'ask',
  description: 'Ask.',
  input_schema,
});
const ASYNC = { $async: true, type: 'object', required: ['x'] };
const GENERIC = ['is not a valid JSON Schema', 'fix the schema', 'so this check cannot run'];

describe('create_workflow refuses a step input_schema whose root carries a truthy $async', () => {
  it('3a/3b. refused in its own clauses: nothing registered, no run created', async () => {
    const { call, runStore } = await connect();
    const before = (await call('list_workflows', {}))['workflows'] as unknown[] | undefined;
    const reply = await call('create_workflow', { steps: [step(ASYNC)] });
    const first = String(((reply['errors'] as string[] | undefined) ?? [])[0]);
    const after = (await call('list_workflows', {}))['workflows'] as unknown[] | undefined;
    // (a) red when the detection is removed (the reply is ok, a run is created) or when this
    //     door's own arm is removed (the generic phrases appear); (b) prints the status, the
    //     agent action, booleans per clause, the generic phrases found and the counts.
    expect({
      status: reply['status'],
      agentAction: reply['agent_action'],
      validity: first.includes(asyncSchemaValidity(true)),
      consequence: first.includes(SCHEMA_KEY_CONSEQUENCE.input_schema),
      remedy: first.includes('remove `$async` from the schema'),
      generic: GENERIC.filter((g) => first.includes(g)),
      workflowsAdded: (after?.length ?? 0) - (before?.length ?? 0),
      runs: (await runStore.list()).length,
    }).toEqual({
      status: 'error',
      agentAction: 'provide_input',
      validity: true,
      consequence: true,
      remedy: true,
      generic: [],
      workflowsAdded: 0,
      runs: 0,
    });
  });

  it('3d. "create it again": input schemas that differ only in content get two different ids, each ok', async () => {
    const { call } = await connect();
    const one = await call('create_workflow', {
      steps: [step({ type: 'object', required: ['x'] })],
    });
    const two = await call('create_workflow', {
      steps: [step({ type: 'object', required: ['y'] })],
    });
    const idOf = (r: Reply) => (r['data'] as { workflow_id?: string } | undefined)?.workflow_id;
    // (a) red when the id's hash leaves out the steps (the two get one id, and the second
    //     overwrites the first); (b) prints the two statuses and whether the ids differ. Pins the
    //     run-time message's "create it again without `$async`, start a new run on it": a
    //     workflow created again is a new workflow, its old run stays on the old one.
    expect({
      one: one['status'],
      two: two['status'],
      bothIds: idOf(one) !== undefined && idOf(two) !== undefined,
      differ: idOf(one) !== idOf(two),
    }).toEqual({ one: 'ok', two: 'ok', bothIds: true, differ: true });
  });

  it('3c. the remedy works: the same workflow without $async is created', async () => {
    const { call } = await connect();
    const { $async: _dropped, ...fixed } = ASYNC;
    const reply = await call('create_workflow', { steps: [step(fixed)] });
    // (a) red when a schema without `$async` is refused too; (b) prints the status.
    expect(reply['status']).toBe('ok');
  });
});
