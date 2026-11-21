// run-version-d002-once.test.ts — Q1 (#592) unit e1, check 3 (prompt q1-e1-run-version-deprecation.md):
// REALM-D002 is said once per process. Its own file, WITHOUT the said-set mock of
// run-version-d002.test.ts: core's said-set is the product's, so two members of the set in a row
// print one line.
//
// (a) red when each refusal says it again (no said-set), or neither says it; (b) prints the lines.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const handles: TempHome[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of handles.splice(0)) await h.cleanup();
});

describe('Q1 (#592) unit e1 — check 3: once per process', () => {
  it('two members of the set in a row (execute_step, then advance_run, each on a run id that does not exist): one line', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
    const h = await makeTempHome();
    handles.push(h);
    const server = createRealmMcpServer({ ...h.stores, gateAnswers: 'permitted' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'd002-once', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    await client.callTool({
      name: 'execute_step',
      arguments: { run_id: 'no-such-run', command: 'a', params: {} },
    });
    await client.callTool({ name: 'advance_run', arguments: { run_id: 'no-such-run' } });
    await client.close();
    const lines = stderr.flatMap((c) => c.split('\n')).filter((l) => l.includes('REALM-D002'));
    expect(lines.length).toBe(1);
  });
});
