// Correction (0.10.0): createRealmMcpServer() with no options must still let get_run_state compute
// next_actions — i.e. the factory defaults a workflowStore (parity with the `realm mcp` path).
// JsonFileStore/JsonWorkflowStore compute their default dirs at module load, so $HOME is set BEFORE
// the first `@sensigo/realm` / server import (no static realm imports here; load them lazily).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client';

describe('createRealmMcpServer — default workflowStore enables get_run_state next_actions', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'realm-srv-default-'));
    await mkdir(join(home, '.realm', 'runs'), { recursive: true });
    await mkdir(join(home, '.realm', 'workflows'), { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it('option-less server resolves next_actions (not workflow_unresolved)', async () => {
    const { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } =
      await import('@sensigo/realm');

    // Seed a workflow + a running run into the default ($HOME) dirs the factory will also use.
    const workflowStore = new JsonWorkflowStore();
    await workflowStore.register({
      id: 'agentflow',
      name: 'Agent First',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { review: { description: 'Agent step', execution: 'agent', depends_on: [] } },
    });
    const runStore = new JsonFileStore();
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
    });

    // Build the server with NO options — it must default the workflowStore internally.
    const { createRealmMcpServer } = await import('../server.js');
    const server = createRealmMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0' });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'get_run_state', arguments: { run_id: run.id } });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const state = JSON.parse(text) as Record<string, unknown>;
    await client.close();

    // An eligible agent step is pending → 'ok' with non-empty next_actions (NOT 'workflow_unresolved').
    expect(state['next_actions_status']).toBe('ok');
    expect((state['next_actions'] as unknown[]).length).toBeGreaterThan(0);
  }, 20000);
});
