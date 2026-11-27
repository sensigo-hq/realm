// remember-doors-g3u1a.test.ts — gap 3, unit 1a, checks 2 and 3 (the MCP door): a step's
// `remember:` stamped by the engine, whatever door drives it. Under `realm mcp` (the real server in
// process over `InMemoryTransport`), `start_run` drives a handler writer and `execute_step` settles an
// agent step answered by the test's own client; the stamps are read from the store, because MCP
// replies carry no evidence entries. A stamp that remembered nothing warns in `execute_step`'s reply.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints. Fake values only.
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  type EvidenceSnapshot,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { createRealmMcpServer } from './server.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

const homes: TempHome[] = [];
afterEach(async () => {
  for (const h of homes.splice(0).reverse()) await h.cleanup();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const def = {
  id: 'g3u1a-doors',
  name: 'g3u1a-doors',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    normalize_email: { description: 'N.', execution: 'auto', handler: 'norm', depends_on: [] },
    record_offer: {
      description: 'R.',
      execution: 'auto',
      handler: 'offer',
      depends_on: ['normalize_email'],
      remember: {
        as: 'offers',
        key: { customer_email: 'context.resources.normalize_email.email' },
        value: { rung: 'context.resources.record_offer.rung' },
        keep_days: 90,
      },
    },
    collect: {
      description: 'C.',
      execution: 'agent',
      depends_on: ['record_offer'],
      remember: { as: 'asks', key: { ticket: 'context.resources.collect.ticket' }, keep_days: 7 },
    },
  },
} as unknown as WorkflowDefinition;

type Reply = { run_id?: string; status?: string; warnings?: string[]; evidence?: unknown[] };

async function world() {
  const h = await makeTempHome();
  homes.push(h);
  await h.stores.workflowStore.register(def);
  const registry = new ExtensionRegistry();
  registry.register('handler', 'norm', {
    id: 'norm',
    execute: async () => ({ data: { email: 'a@example.test' } }),
  } as never);
  registry.register('handler', 'offer', {
    id: 'offer',
    execute: async () => ({ data: { rung: 2 } }),
  } as never);
  const runStore = new InMemoryStore();
  const server = createRealmMcpServer({ ...h.stores, runStore: runStore as RunStore, registry });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'remember-doors-g3u1a', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text?: string }>;
    };
    return JSON.parse(raw.content[0]?.text ?? '{}') as Reply;
  };
  const entry = async (runId: string, step: string): Promise<EvidenceSnapshot> =>
    (await runStore.get(runId)).record.evidence.filter((e) => e.step_id === step).at(-1)!;
  return { call, entry };
}
const expiryOf = (e: EvidenceSnapshot, days: number): string =>
  new Date(Date.parse(e.completed_at) + days * DAY_MS).toISOString();

describe('gap 3 (1a), check 2 — the MCP door', () => {
  it('start_run drives the handler writer: its entry holds the stamp, read from the store', async () => {
    const { call, entry } = await world();
    const started = await call('start_run', { workflow_id: def.id, params: {} });
    const written = await entry(started.run_id!, 'record_offer');
    // (a) red when the stamp is computed in a door's code instead of the engine; (b) prints it.
    expect(written.remembered).toEqual({
      as: 'offers',
      key: { customer_email: 'a@example.test' },
      value: { rung: 2 },
      expires_at: expiryOf(written, 90),
    });
  });

  it('execute_step on an agent step answered by the client: its entry holds the stamp, and the reply carries no entries', async () => {
    const { call, entry } = await world();
    const started = await call('start_run', { workflow_id: def.id, params: {} });
    const reply = await call('execute_step', {
      run_id: started.run_id,
      command: 'collect',
      params: { ticket: 'T-1' },
    });
    const written = await entry(started.run_id!, 'collect');
    // (a) red when the door's settle misses the stamp; (b) prints the stamp and the reply's parts.
    expect({
      stamp: written.remembered,
      evidence: reply.evidence,
      warned: (reply.warnings ?? []).filter((w) => w.includes('remembered')),
    }).toEqual({
      stamp: { as: 'asks', key: { ticket: 'T-1' }, expires_at: expiryOf(written, 7) },
      evidence: [],
      warned: [],
    });
  });
});

describe('gap 3 (1a), check 3 — the MCP reply warns', () => {
  it("execute_step on a key_absent writer: the reply's warnings carry Words 9", async () => {
    const { call, entry } = await world();
    const started = await call('start_run', { workflow_id: def.id, params: {} });
    const reply = await call('execute_step', {
      run_id: started.run_id,
      command: 'collect',
      params: {},
    });
    // (a) red when the warning is left out of the success reply; (b) prints the warnings and stamp.
    expect({
      warnings: reply.warnings,
      stamp: (await entry(started.run_id!, 'collect')).remembered,
    }).toEqual({
      warnings: ["Step 'collect' remembered nothing in 'asks': its key 'ticket' was not there."],
      stamp: { as: 'asks', not_remembered: 'key_absent', key_name: 'ticket' },
    });
  });
});
