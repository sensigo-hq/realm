// damaged-run-719.test.ts — issue #719 (B2): every MCP tool that meets a run file the JSON store
// cannot read gives that file's own code, and a message naming the file — never its text. Over a
// real MCP client, on a real JSON store in a temp folder.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { createRealmMcpServer } from '../server.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function connect(bad: string) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-719-mcp-'));
  dirs.push(dir);
  const runsDir = join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, 'bad.json'), bad);
  const runStore = new JsonFileStore(runsDir);
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register({
    id: 'w',
    name: 'w',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { a: { description: 'A.', execution: 'agent' } },
  } as WorkflowDefinition);
  const server = createRealmMcpServer({ runStore, workflowStore });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'damaged-run-719', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return raw.content[0]!.text;
  };
  return { call, path: join(runsDir, 'bad.json') };
}

/** Each tool that reads a run, and how it is called on the damaged run `bad`. */
const TOOLS: Array<[string, Record<string, unknown>]> = [
  ['get_run_state', { run_id: 'bad' }],
  ['execute_step', { run_id: 'bad', command: 'a', params: {} }],
  ['advance_run', { run_id: 'bad' }],
  ['submit_human_response', { run_id: 'bad', gate_id: 'g', choice: 'approve' }],
  ['append_trace', { run_id: 'bad', step_id: 'a', entries: [] }],
  ['abandon_run', { run_id: 'bad' }],
  // A new idempotency key while a file that might hold it cannot be read (B4).
  ['start_run', { workflow_id: 'w', params: {}, idempotency_key: 'k-719' }],
];

describe('issue #719 — the MCP tools on a run file that cannot be read', () => {
  it.each(TOOLS)('%s: the file’s code, the file named', async (tool, args) => {
    const { call, path } = await connect('{ not json');
    const reply = JSON.parse(await call(tool, args)) as Record<string, unknown>;
    // (a) red when the tool answers ENGINE_STORE_FAILED, ENGINE_INTERNAL or no code, or loses the
    //     path; (b) prints the status, the code and whether the first error names the file.
    expect({
      status: reply['status'],
      error_code: reply['error_code'],
      names: ((reply['errors'] as string[] | undefined)?.[0] ?? '').includes(
        `The run file '${path}' is not JSON.`,
      ),
    }).toEqual({ status: 'error', error_code: 'RESOURCE_FORMAT_INVALID', names: true });
  });

  it('start_run_batch: the failed item carries the file’s code and names the file', async () => {
    const { call, path } = await connect('{ not json');
    const reply = JSON.parse(
      await call('start_run_batch', {
        workflow_id: 'w',
        items: [{ params: {}, idempotency_key: 'k-719' }],
      }),
    ) as { failed?: Array<{ error_code?: string; error?: string }> };
    const item = reply.failed?.[0];
    // (b) prints the item's code and whether its error names the file.
    expect({
      error_code: item?.error_code,
      names: (item?.error ?? '').includes(`The run file '${path}' is not JSON.`),
    }).toEqual({ error_code: 'RESOURCE_FORMAT_INVALID', names: true });
  });

  it('the leak cell (MCP reply): a fault AT a token never reaches the reply', async () => {
    const { call } = await connect('{"params":{"token": ghp_FAKE719}}');
    const text = await call('get_run_state', { run_id: 'bad' });
    const leaked = text.includes('ghp_FAKE7');
    // (a) red when the parser's text reaches the reply; (b) prints a boolean only.
    expect(leaked).toBe(false);
  });
});
