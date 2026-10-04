// realm mcp — starts the global Realm MCP server.
// Serves all workflows registered via `realm workflow register`.
// Workflows that declare `extensions:` get their project extension modules resolved
// per-definition via the registryProvider (process-lifetime cache — restart to pick up
// module content changes).
import { Command } from 'commander';
import { JsonWorkflowStore } from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { makeRegistryProvider } from '../extensions/load-project-extensions.js';
import { resolveProgramIdentity } from '../lib/program-identity.js';
import { hostRefusalLine } from '../lib/host-refusal-line.js';

/**
 * Starts the Realm MCP server using the global workflow store (~/.realm/workflows/).
 * All workflows registered via `realm workflow register` are immediately available.
 * Built-in adapters (FileSystemAdapter etc.) are included automatically; per-workflow
 * project extensions load through the registryProvider.
 */
export const mcpCommand = new Command('mcp')
  .description('Start the Realm MCP server (serves all registered workflows via stdio)')
  .option(
    '--extensions-module <path>',
    "CODE override: module that REPLACES every workflow's declared 'extensions' modules (repair tool)",
  )
  .option(
    '--project <dir>',
    'CONFIG anchor: deployment root whose realm.yaml applies to definitions without a stored trust_root. NO default: the mcp stdio cwd is CLIENT-controlled, so the manifest loads ONLY when --project is typed by the operator (in the MCP client config).',
  )
  .action(async (options: { extensionsModule?: string; project?: string }) => {
    // issue #625 (holder slice): this program's name, made once, before the transport opens. A name
    // that cannot be used prints one line to stderr and exits 1 — a stdio server prints nothing on
    // stdout before the client's first message, and this does not either.
    const driver = resolveProgramIdentity('mcp-stdio');
    const workflowStore = new JsonWorkflowStore();
    // SECURITY (recorded decision): unlike serve/agent/run there is NO cwd default here —
    // an MCP client opening a cloned repo must not cause its realm.yaml to resolve secrets
    // and import code. Do not "improve" this.
    // issue #620 PR-C: a construction refusal (a store or registry from another realm) is printed
    // as one line and the command exits 1 — never Node's uncaught-exception stack. A release-line
    // refusal here means this command's own install is split: `hostRefusalLine` says so.
    let server: ReturnType<typeof createRealmMcpServer>;
    try {
      server = createRealmMcpServer({
        workflowStore,
        registryProvider: makeRegistryProvider(options.extensionsModule, options.project),
        ...(driver !== undefined ? { driver } : {}),
      });
    } catch (err) {
      console.error(hostRefusalLine('mcp', err));
      process.exit(1);
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });
