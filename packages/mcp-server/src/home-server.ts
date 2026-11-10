// home-server.ts — issue #616 PR-2c c10b-3a: the library's home entry, `@sensigo/realm-mcp/home`. A
// host that wants Realm's own store calls `createRealmMcpServerOnHome` and gets a server over the
// SQLite home, opened once for the process through this package's one door (`home.ts`). A host that
// injects its own stores calls `createRealmMcpServer` from the package's index, which reaches neither
// this module nor the store package, so it loads no SQLite: that is why this is a separate entry and
// `index.ts` never imports it. This is the one place in the package that hands the four stores to
// the factory; the `realm-mcp` program comes through here too.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openMcpHome } from './home.js';
import { createRealmMcpServer, type RealmMcpServerOptions } from './server.js';

/** What `createRealmMcpServerOnHome` takes: the home, and every option of the server but its stores. */
export type HomeServerOptions = { home?: string } & Omit<
  RealmMcpServerOptions,
  'runStore' | 'workflowStore' | 'traceBufferStore' | 'failedAttemptStore'
>;

/**
 * Opens the Realm home and builds the MCP server over its store.
 *
 * - The home is `options.home`, or `~/.realm`; it is created when it is empty.
 * - The returned `close()` is synchronous and closes the home. The home's handle is SHARED by every
 *   caller in this process that opened it, so a close ends it for all of them. A later call opens
 *   the home anew.
 * - Every refusal of the open is the store's own typed error, as a rejected promise.
 * - A refusal while building the server is also a rejected promise, and it leaves the home open:
 *   the handle is shared, so this function cannot know it is the only holder.
 */
export async function createRealmMcpServerOnHome(
  options: HomeServerOptions = {},
): Promise<{ server: McpServer; close(): void }> {
  const { home, ...rest } = options;
  const realmHome = await openMcpHome(home !== undefined ? { home } : {});
  const server = createRealmMcpServer({
    ...rest,
    runStore: realmHome.runStore,
    workflowStore: realmHome.workflowStore,
    traceBufferStore: realmHome.traceBufferStore,
    failedAttemptStore: realmHome.failedAttemptStore,
  });
  return { server, close: () => realmHome.close() };
}
