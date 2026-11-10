// home-server.test.ts — issue #616 PR-2c c10b-3a: the library's home entry, `@sensigo/realm-mcp/home`,
// and law (E) of the packaging laws: exactly one published package exports the opener.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openMcpHome } from './home.js';
import { createRealmMcpServerOnHome } from './home-server.js';

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** A `.realm` path under a fresh temp folder; nothing exists at it yet. */
function freshHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'realm-home-server-616-'));
  roots.push(root);
  return join(root, '.realm');
}

async function clientOf(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'home-server-616', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

/** The `status` of one `list_workflows` reply, over a client that is then closed. */
async function listWorkflowsStatus(server: McpServer): Promise<unknown> {
  const client = await clientOf(server);
  const raw = (await client.callTool({ name: 'list_workflows', arguments: {} })) as {
    content: Array<{ text: string }>;
  };
  await client.close();
  return (JSON.parse(raw.content[0]!.text) as { status?: unknown }).status;
}

/** How many tools a client of this server is listed. */
async function toolCount(server: McpServer): Promise<number> {
  const client = await clientOf(server);
  const { tools } = await client.listTools();
  await client.close();
  return tools.length;
}

describe('#616 PR-2c c10b-3a — createRealmMcpServerOnHome', () => {
  it('a fresh home: the store and its four fences are made, and a tool call answers ok', async () => {
    const home = freshHome();
    const { server, close } = await createRealmMcpServerOnHome({ home });
    closers.push(close);
    const status = await listWorkflowsStatus(server);
    const names = readdirSync(home)
      .filter((name) => !name.endsWith('-wal') && !name.endsWith('-shm'))
      .sort();
    // (a) red when the entry stops opening the home it was given, or the server it returns cannot
    //     serve a call on it; (b) prints the folder's names and the reply's status.
    expect({ names, status }).toEqual({
      names: ['dedup', 'realm.db', 'replays', 'runs', 'workflows'],
      status: 'ok',
    });
  });

  it('close() ends the shared handle: a later call opens the home anew, and it serves', async () => {
    const home = freshHome();
    const first = await createRealmMcpServerOnHome({ home });
    closers.push(first.close);
    const held = await openMcpHome({ home });
    const sameBeforeClose = (await openMcpHome({ home })).runStore === held.runStore;
    first.close();
    const second = await createRealmMcpServerOnHome({ home });
    closers.push(second.close);
    const afterClose = await openMcpHome({ home });
    const status = await listWorkflowsStatus(second.server);
    // (a) red when `close` is not the door's (the handle survives and the stores are the old ones),
    //     or the entry opens some other handle than the door's; (b) prints which held and the status.
    expect({
      sameBeforeClose,
      sameAfterClose: afterClose.runStore === held.runStore,
      status,
    }).toEqual({ sameBeforeClose: true, sameAfterClose: false, status: 'ok' });
  });

  it('a home holding the old JSON folders is refused with the store’s own error, and nothing is made', async () => {
    const home = freshHome();
    mkdirSync(join(home, 'runs'), { recursive: true });
    const err = await createRealmMcpServerOnHome({ home }).catch((e: unknown) => e);
    // (a) red when the entry maps, swallows or wraps the door's refusal, or the home gains a file;
    //     (b) prints the error's code and the folder's names.
    expect({ code: (err as { code?: unknown }).code, names: readdirSync(home) }).toEqual({
      code: 'STATE_HOME_HOLDS_LEGACY_STORE',
      names: ['runs'],
    });
  });

  it('the rest of the options reach the server: gateAnswers withheld lists one tool fewer', async () => {
    const withheld = await createRealmMcpServerOnHome({
      home: freshHome(),
      gateAnswers: 'withheld',
    });
    closers.push(withheld.close);
    const plain = await createRealmMcpServerOnHome({ home: freshHome() });
    closers.push(plain.close);
    // (a) red when the entry drops the options beside `home`; (b) prints both counts.
    expect({
      withheld: await toolCount(withheld.server),
      plain: await toolCount(plain.server),
    }).toEqual({ withheld: 10, plain: 11 });
  });
});

describe('#616 PR-2c c10b-3a — law (E): exactly one published package exports the opener', () => {
  const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const entry = (name: string): string =>
    readFileSync(join(PACKAGES, name, 'src', 'index.ts'), 'utf8');

  it('the store package’s entry exports openRealmHome; no other entry names it, the door or the home entry', () => {
    const others = ['core', 'cli', 'mcp-server', 'testing'].map((name) => {
      const text = entry(name);
      return {
        name,
        opener: /\bopenRealmHome\b/.test(text),
        storePackage: /realm-store-sqlite/.test(text),
        door: /\bopenMcpHome\b|\.\/home\.js/.test(text),
        homeEntry: /\bcreateRealmMcpServerOnHome\b|home-server/.test(text),
      };
    });
    const none = { opener: false, storePackage: false, door: false, homeEntry: false };
    // (a) red when a second entry re-exports the opener, or any entry but the store's reaches the
    //     store package (an `export *` names no symbol, so the package's name is what is judged), the
    //     door or the home entry; (b) prints what each entry names.
    expect(others).toEqual(
      ['core', 'cli', 'mcp-server', 'testing'].map((name) => ({ name, ...none })),
    );
    // (a) red when the store package stops exporting the opener; (b) prints whether it does.
    expect(/export\s*\{[^}]*\bopenRealmHome\b[^}]*\}/.test(entry('store-sqlite'))).toBe(true);
  });

  it('the home entry is reachable only through the package’s ./home subpath', () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGES, 'mcp-server', 'package.json'), 'utf8'),
    ) as {
      exports: Record<string, unknown>;
    };
    // (a) red when the subpath is renamed or points at another file (the map is what a host sees);
    //     (b) prints the entry the map holds.
    expect(manifest.exports['./home']).toEqual({
      import: './dist/home-server.js',
      types: './dist/home-server.d.ts',
    });
    // (a) red when the module the map names is not in the source tree; (b) prints its path.
    expect(existsSync(join(PACKAGES, 'mcp-server', 'src', 'home-server.ts'))).toBe(true);
  });
});
