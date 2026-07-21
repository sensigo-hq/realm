// @sensigo/realm-mcp — MCP server for AI agent connections
export { createRealmMcpServer, createDefaultRegistry } from './server.js';
export type { RealmMcpServerOptions } from './server.js';
export { generateProtocol } from './protocol/generator.js';
export type { WorkflowProtocol, ProtocolStep } from './protocol/generator.js';
// issue #107: exported so the operator run-purge CLI command (packages/cli) can construct one
// and register it as a PerRunArtifactStore alongside JsonFileStore/FailedAttemptStore.
export { JsonTraceBufferStore } from './json-trace-buffer-store.js';
export const VERSION = '0.30.0';
