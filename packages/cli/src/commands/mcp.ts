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
    "Extensions module that REPLACES every workflow's declared 'extensions' modules (repair/override)",
  )
  .action(async (options: { extensionsModule?: string }) => {
    const workflowStore = new JsonWorkflowStore();
    const server = createRealmMcpServer({
      workflowStore,
      registryProvider: makeRegistryProvider(options.extensionsModule),
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });
