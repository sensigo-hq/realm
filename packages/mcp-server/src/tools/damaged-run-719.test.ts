// damaged-run-719.test.ts — issue #719 (B2): every MCP tool that meets a run file the JSON store
// cannot read gives that file's own code, and a message naming the file — never its text. Over a
// real MCP client, on a real JSON store in a temp folder.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
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

async function connect(bad: string, mode?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-719-mcp-'));
  dirs.push(dir);
  const runsDir = join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, 'bad.json'), bad);
  if (mode !== undefined) await chmod(join(runsDir, 'bad.json'), mode);
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

/** Each class an MCP reply must carry (issue #719, C5): its bytes (and mode), its code, its agent
 *  action and its fault sentence's ending. A legacy file carries the key, so `start_run`'s new key
 *  is refused by it too (a readable object carrying the key). */
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const CLASSES: Array<[string, string, number | undefined, string, string, string]> = [
  ['parse', '{ not json', undefined, 'RESOURCE_FORMAT_INVALID', 'stop', 'is not JSON.'],
  [
    'legacy',
    '{"id":"bad","state":"running","idempotency_key":"k-719"}',
    undefined,
    'STATE_LEGACY_FORMAT',
    'report_to_user',
    'is in the format of an earlier Realm.',
  ],
  ...(asRoot
    ? []
    : ([
        ['unreadable', '{}', 0o000, 'ENGINE_STORE_FAILED', 'stop', 'cannot be read (EACCES).'],
      ] as Array<[string, string, number | undefined, string, string, string]>)),
];

describe('issue #719 — the MCP tools on a run file that cannot be read', () => {
  it.each(
    CLASSES.flatMap(([cls, bytes, mode, code, action, fault]) =>
      TOOLS.map(([tool, args]) => [tool, cls, args, bytes, mode, code, action, fault] as const),
    ),
  )(
    '%s on a %s file: its code, its agent action, the file named',
    async (tool, _cls, args, bytes, mode, code, action, fault) => {
      const { call, path } = await connect(bytes, mode);
      const reply = JSON.parse(await call(tool, args)) as Record<string, unknown>;
      // (a) red when the tool answers ENGINE_INTERNAL or no code, another code or agent action for
      //     the class, or loses the path; (b) prints the status, the code, the action and whether
      //     the first error names the file.
      expect({
        status: reply['status'],
        error_code: reply['error_code'],
        agent_action: reply['agent_action'],
        names: ((reply['errors'] as string[] | undefined)?.[0] ?? '').includes(
          `The run file '${path}' ${fault}`,
        ),
      }).toEqual({ status: 'error', error_code: code, agent_action: action, names: true });
    },
  );

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
