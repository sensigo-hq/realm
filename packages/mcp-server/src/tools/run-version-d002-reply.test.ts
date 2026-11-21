// run-version-d002-reply.test.ts — Q1 (#592) unit e1, check 4 (prompt q1-e1-run-version-deprecation.md):
// a deprecation never changes a reply. `run-version-d002-base-reply.json` is the MCP client's raw
// result of `execute_step` on a run id that does not exist, rendered by the BASE (main 6d914daf) and
// committed there before the change; this cell renders the same call on the branch and compares the
// two, the reply's text byte for byte.
//
// (a) red when the call's reply differs from the base's in any byte (a warning appended to it, a
//     field added, dropped or changed); (b) prints both.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const handles: TempHome[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.cleanup();
});

describe('Q1 (#592) unit e1 — check 4: the reply is byte-for-byte the base’s', () => {
  it("execute_step on a run id that does not exist: the client's raw result equals the base's committed fixture", async () => {
    const h = await makeTempHome();
    handles.push(h);
    const server = createRealmMcpServer({ ...h.stores, gateAnswers: 'permitted' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'd002-fixture', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const raw = await client.callTool({
      name: 'execute_step',
      arguments: { run_id: 'no-such-run', command: 'a', params: {} },
    });
    await client.close();
    const base = JSON.parse(
      readFileSync(new URL('./run-version-d002-base-reply.json', import.meta.url), 'utf8'),
    ) as { content: Array<{ text: string }> };
    expect(raw).toEqual(base);
    expect((raw as { content: Array<{ text: string }> }).content[0]!.text).toBe(
      base.content[0]!.text,
    );
  });
});
