// bounded-echoes-872.test.ts — #872 (b1) A5: an echoed name or reason over 500 characters is named by
// its length (I4: `‹N characters, not kept›`), never quoted whole — `abandon_run`'s and
// `get_run_state`'s `terminal_reason`, `create_workflow`'s unknown-key line and its
// `diagnostics[i].key`, `advance_run`'s and `submit_human_response`'s `unknown argument` lines.
// Through a real server (in-memory transport). Beside each: (a) what turns it red; (b) what it prints
// on failure — the lines (the names are fake) and booleans.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../index.js';

type Reply = Record<string, unknown>;
const GATED = {
  id: 'echoes-872',
  name: 'echoes',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    draft: {
      description: 'Draft.',
      execution: 'agent',
      depends_on: [],
      trust: 'human_confirmed',
      gate: { choices: ['send', 'discard'] },
    },
    after: { description: 'After.', execution: 'agent', depends_on: ['draft'] },
  },
} as unknown as WorkflowDefinition;

async function connect() {
  const dir = await mkdtemp(join(tmpdir(), 'realm-echoes-872-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register(GATED);
  const server = createRealmMcpServer({ runStore, workflowStore });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'echoes-872', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  return { call };
}

const KEY = 'k'.padEnd(1000, 'z');
const MARK_1000 = '‹1000 characters, not kept›';

describe('#872 (b1) B8 — bounded echoes', () => {
  it('a 600-character abandon reason → the marker in abandon_run’s reply and in get_run_state’s', async () => {
    const { call } = await connect();
    const runId = String((await call('start_run', { workflow_id: GATED.id }))['run_id']);
    const abandoned = await call('abandon_run', { run_id: runId, reason: 'r'.padEnd(600, 'x') });
    const state = await call('get_run_state', { run_id: runId });
    // (a) red when a reply echoes the reason whole; (b) prints both reasons.
    expect([abandoned['terminal_reason'], state['terminal_reason']]).toEqual([
      '‹600 characters, not kept›',
      '‹600 characters, not kept›',
    ]);
  });

  it('a 1,000-character unknown key → the marker in create_workflow’s line and in diagnostics[i].key', async () => {
    const { call } = await connect();
    const r = await call('create_workflow', {
      steps: [{ id: 'a', description: 'A.', [KEY]: 1 }],
    });
    const lines = (r['warnings'] as string[]).filter((w) => w.includes('unknown key'));
    const keys = ((r['diagnostics'] as Array<{ key?: string }>) ?? []).map((d) => d.key);
    // (a) red when the key is quoted whole in the line or the diagnostic; (b) prints them.
    expect({
      line: lines.length === 1 && lines[0]!.includes(`unknown key '${MARK_1000}'`),
      whole: lines.some((l) => l.includes(KEY)),
      keys,
    }).toEqual({ line: true, whole: false, keys: [MARK_1000] });
  });

  it('advance_run’s and submit_human_response’s `unknown argument` lines name a 1,000-character key by its length', async () => {
    const { call } = await connect();
    const runId = String((await call('start_run', { workflow_id: GATED.id }))['run_id']);
    const advanced = await call('advance_run', { run_id: runId, [KEY]: 1 });
    const opened = await call('execute_step', { run_id: runId, command: 'draft', params: {} });
    const gateId = (opened['gate'] as { gate_id: string }).gate_id;
    const answered = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'send',
      [KEY]: 1,
    });
    // (a) red when either tool quotes the key whole; (b) prints the first warning of each.
    expect([(advanced['warnings'] as string[])[0], (answered['warnings'] as string[])[0]]).toEqual([
      `advance_run: unknown argument '${MARK_1000}' was ignored.`,
      `submit_human_response: unknown argument '${MARK_1000}' was ignored.`,
    ]);
  });
});
