// @sensigo/realm-mcp — MCP server for AI agent connections
export { createRealmMcpServer, createDefaultRegistry } from './server.js';
export type { RealmMcpServerOptions } from './server.js';
export { generateProtocol } from './protocol/generator.js';
export type { WorkflowProtocol, ProtocolStep } from './protocol/generator.js';
export const VERSION = '0.1.0';
