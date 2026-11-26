// CP-2, check 11: the floor's validator is compiled once per process, when the first get_run_state
// result needs it — never on tools/list or another tool's call — and the wire schema is built once and
// shared by every server. Its own file: vitest runs each file in a fresh process (forks + isolate), so
// nothing compiled before this file starts.
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRealmMcpServer } from '../server.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';
import { runStateWireCompilesForTests, runStateWireSchema } from './run-state-wire.js';

const homes: TempHome[] = [];
const clients: Client[] = [];
afterAll(async () => {
  for (const c of clients) await c.close();
  for (const h of homes) await h.cleanup();
});
async function connect(server: McpServer): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cp2-compile', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  clients.push(client);
  return client;
}

describe('CP-2 — 11. compiled once per process', () => {
  it('two servers, each listing its tools and answering one get_run_state call: one compile, at the first result', async () => {
    // (a) red when the validator compiles per server, at registration, on tools/list or on another
    //     tool's call; (b) prints the count after each step.
    const home = await makeTempHome();
    homes.push(home);
    const counts: Record<string, number> = {};
    const first = await connect(createRealmMcpServer({ ...home.stores }));
    const second = await connect(createRealmMcpServer({ ...home.stores }));
    const wire = runStateWireSchema();
    counts['two servers built'] = runStateWireCompilesForTests();
    await first.listTools();
    await second.listTools();
    counts['both listed'] = runStateWireCompilesForTests();
    await first.callTool({ name: 'list_workflows', arguments: {} });
    counts['another tool called'] = runStateWireCompilesForTests();
    await first.callTool({ name: 'get_run_state', arguments: { run_id: 'no-such-run' } });
    counts['first get_run_state'] = runStateWireCompilesForTests();
    await second.callTool({ name: 'get_run_state', arguments: { run_id: 'no-such-run' } });
    counts['second server, get_run_state'] = runStateWireCompilesForTests();
    expect({ counts, shared: runStateWireSchema() === wire }).toStrictEqual({
      counts: {
        'two servers built': 0,
        'both listed': 0,
        'another tool called': 0,
        'first get_run_state': 1,
        'second server, get_run_state': 1,
      },
      shared: true,
    });
  });
});
