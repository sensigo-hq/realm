#!/usr/bin/env node
// realm-mcp — MCP server exposing the Realm workflow engine to AI agents.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ExtensionRegistry,
  JsonWorkflowStore,
  JsonFileStore,
  createDefaultRegistry,
} from '@sensigo/realm';
import { JsonTraceBufferStore } from './json-trace-buffer-store.js';
import { registerListWorkflows } from './tools/list-workflows.js';
import { registerGetWorkflowProtocol } from './tools/get-workflow-protocol.js';
import { registerStartRun } from './tools/start-run.js';
import { registerExecuteStep } from './tools/execute-step.js';
import { registerSubmitHumanResponse } from './tools/submit-human-response.js';
import { registerGetRunState } from './tools/get-run-state.js';
import { registerCreateWorkflow } from './tools/create-workflow.js';
import { registerAppendTrace } from './tools/append-trace.js';
import { registerStartRunBatch } from './tools/start-run-batch.js';

export interface RealmMcpServerOptions {
  /** Extension registry for resolving service adapters and step handlers at runtime. */
  registry?: ExtensionRegistry;
  /** Resolved secrets to pass to adapter configs (e.g. API tokens). */
  secrets?: Record<string, string>;
  /** Pre-populated workflow store. When provided, tools use this instead of creating
   *  a new JsonWorkflowStore() pointing at ~/.realm/workflows/. */
  workflowStore?: JsonWorkflowStore;
  /** Run store. When provided, tools use this instead of creating a new JsonFileStore(). */
  runStore?: JsonFileStore;
}

/**
 * Returns an ExtensionRegistry pre-populated with Realm's built-in adapters.
 * `FileSystemAdapter` is registered under the name `'filesystem'`.
 *
 * Use this as a starting point when you need to add your own handlers or adapters on top:
 * ```ts
 * const registry = createDefaultRegistry();
 * registry.register('handler', 'my_handler', myHandler);
 * const server = createRealmMcpServer({ workflowStore, registry });
 * ```
 *
 * When no registry is passed to `createRealmMcpServer`, the engine uses built-in adapters
 * automatically — you only need this if you are adding custom extensions.
 */
export { createDefaultRegistry };

/**
 * Creates and configures the Realm MCP server with all 9 workflow tools.
 *
 * When no `registry` is provided, `FileSystemAdapter` is pre-registered automatically
 * under the name `filesystem`. Pass a custom `registry` to add your own handlers and
 * adapters — when you do, include `FileSystemAdapter` explicitly if your workflows use it,
 * or start from `createDefaultRegistry()` and add your extensions on top.
 */
export function createRealmMcpServer(options?: RealmMcpServerOptions): McpServer {
  const server = new McpServer({
    name: 'realm',
    version: '0.6.4',
  });

  // When no registry is provided, use the default registry that pre-registers built-in
  // adapters. When a registry is provided, the caller is responsible for its contents.
  const effectiveRegistry = options?.registry ?? createDefaultRegistry();

  const effectiveOptions: RealmMcpServerOptions = { ...options, registry: effectiveRegistry };

  // Shared trace buffer store: one instance used by both append_trace and execute_step so
  // WAL entries written by append_trace are visible when execute_step finalizes the step.
  const effectiveRunStore = options?.runStore ?? new JsonFileStore();
  const traceBufferStore = new JsonTraceBufferStore(effectiveRunStore.runsDirPath);

  registerListWorkflows(server, effectiveOptions);
  registerGetWorkflowProtocol(server, effectiveOptions);
  registerStartRun(server, effectiveOptions);
  registerStartRunBatch(server, effectiveOptions);
  registerExecuteStep(server, { ...effectiveOptions, traceBufferStore });
  registerSubmitHumanResponse(server, effectiveOptions);
  registerGetRunState(server, effectiveOptions);
  registerCreateWorkflow(server, effectiveOptions);
  registerAppendTrace(server, {
    runStore: effectiveRunStore,
    ...(options?.workflowStore !== undefined ? { workflowStore: options.workflowStore } : {}),
    traceBufferStore,
  });

  return server;
}

// Entry point: start the MCP server on stdio when run directly.
if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  const server = createRealmMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
