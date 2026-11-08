// principal-627.test.ts — #627 W, cell 25 through the real doors (§5.8's table): `realm mcp` (stdio)
// records `door_authenticates_no_principal`; `realm serve` with its token records `shared_token`, and
// in dev mode `door_authentication_disabled`. The CLI door's `not_a_server_door` and the library's
// `principal_not_passed` are pinned in answer-record-627 and w-627. Also the CLI renderer's `present`
// arm (null: no realm command shows a chat app's form).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// recorded principal — never the token.
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  advanceRun,
  loadWorkflowFromString,
  presentWayOfGate,
  type RunStore,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpMcpServer } from './serve.js';
import { CLI_COMMANDS, NO_DRIVE_FLAGS } from './ways-renderer.js';
import { openCliHome } from '../lib/home.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

const YAML = [
  'id: pr627',
  'name: pr627',
  'version: 1',
  'steps:',
  '  q:',
  '    description: Ask.',
  '    execution: auto',
  '    trust: human_confirmed',
  '    gate:',
  '      choices: [approve, reject]',
  '  after:',
  '    description: After.',
  '    execution: agent',
  '    depends_on: [q]',
].join('\n');

/** A HOME with the workflow registered and a run opened at its question. */
async function opened(h: TempHome) {
  const def = loadWorkflowFromString(YAML);
  await h.home.workflowStore.register(def);
  const store = h.home.runStore;
  const { record: run } = await store.create({
    workflowId: def.id,
    workflowVersion: 1,
    params: {},
  });
  await advanceRun(store, def, { runId: run.id });
  return { store, runId: run.id, gateId: (await store.get(run.id)).record.pending_gate!.gate_id };
}

const principalOf = async (store: RunStore, runId: string) =>
  (await store.get(runId)).record.evidence.find((e) => e.kind === 'gate_response')?.principal;

describe('#627 W — cell 25: the principal each door stamps', () => {
  const homes: TempHome[] = [];
  afterEach(async () => {
    for (const t of homes.splice(0)) await t.cleanup();
  });

  it('realm mcp (stdio): door_authenticates_no_principal', async () => {
    const h = await makeTempHome();
    homes.push(h);
    const home = h.root;
    const { store, runId, gateId } = await opened(h);
    const client = new Client({ name: 'pr-627', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'mcp'],
        env: { PATH: process.env['PATH'] ?? '', HOME: home },
        stderr: 'pipe',
      }),
    );
    try {
      await client.callTool({
        name: 'submit_human_response',
        arguments: { run_id: runId, gate_id: gateId, choice: 'approve' },
      });
    } finally {
      await client.close();
    }
    // (a) red when realm mcp passes no principal (principal_not_passed) or invents one; (b) prints it.
    expect(await principalOf(store, runId)).toEqual({ absent: 'door_authenticates_no_principal' });
  }, 60_000);

  it.each([
    ['with its token', false, { kind: 'shared_token' }],
    ['in dev mode', true, { absent: 'door_authentication_disabled' }],
  ] as const)(
    'realm serve %s',
    async (_label, devMode, expected) => {
      const h = await makeTempHome();
      homes.push(h);
      const home = h.root;
      const { store, runId, gateId } = await opened(h);
      const token = 'test-token-not-a-secret';
      // #616 PR-2a (iii): the starter takes all four stores or none — the four of this HOME's home.
      const realmHome = await openCliHome({ home: join(home, '.realm') });
      const server = await startHttpMcpServer({
        port: 0,
        host: '127.0.0.1',
        devMode,
        token,
        workflowStore: realmHome.workflowStore,
        runStore: realmHome.runStore,
        traceBufferStore: realmHome.traceBufferStore,
        failedAttemptStore: realmHome.failedAttemptStore,
      });
      // #616 PR-2a (iii): the per-request server takes the four stores above, all on this HOME's
      // home (it read the run store from HOME's default before); HOME is still pointed at it.
      const previous = process.env['HOME'];
      process.env['HOME'] = home;
      try {
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        const client = new Client({ name: 'pr-627-http', version: '0' });
        // The SDK's own transport type does not satisfy `exactOptionalPropertyTypes` (the
        // `onclose` mismatch serve.ts notes too); the runtime object is the client transport.
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }) as unknown as Parameters<typeof client.connect>[0],
        );
        try {
          await client.callTool({
            name: 'submit_human_response',
            arguments: { run_id: runId, gate_id: gateId, choice: 'approve' },
          });
        } finally {
          await client.close();
        }
      } finally {
        process.env['HOME'] = previous;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      // (a) red when serve stamps no principal, or shows the shared token as an identity; (b) prints it.
      expect(await principalOf(store, runId)).toEqual(expected);
    },
    60_000,
  );
});

describe('#627 W — the CLI door’s present arm', () => {
  it('returns null: no realm command shows a question as a chat app’s form', () => {
    // (a) red when the CLI renders a command for present; (b) prints what it rendered.
    expect(
      CLI_COMMANDS.present(presentWayOfGate('r', 'g') as never, undefined, NO_DRIVE_FLAGS),
    ).toBeNull();
  });
});
