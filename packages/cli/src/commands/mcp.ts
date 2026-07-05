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
    const workflowStore = new JsonWorkflowStore();
    // SECURITY (recorded decision): unlike serve/agent/run there is NO cwd default here —
    // an MCP client opening a cloned repo must not cause its realm.yaml to resolve secrets
    // and import code. Do not "improve" this.
    const server = createRealmMcpServer({
      workflowStore,
      registryProvider: makeRegistryProvider(options.extensionsModule, options.project),
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });
