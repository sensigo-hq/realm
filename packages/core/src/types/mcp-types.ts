// ToolCallRecord and McpServerConfig live in core because they are referenced by core types
// (EvidenceSnapshot, ExecuteChainOptions, WorkflowDefinition). Defining them in cli would
// create a circular import: core → cli → core.

/**
 * One call an agent step made to an MCP server's tool, as the record keeps it: the server, the
 * tool, its arguments, its result or error, and how long it took (`EvidenceSnapshot.tool_calls`).
 * @public
 */
export interface ToolCallRecord {
  server_id: string; // "github" — MCP server ID from mcp_servers[].id
  tool: string; // bare tool name: "get_pull_request" (NOT namespaced)
  args: Record<string, unknown>;
  result: string | null; // sanitized serialized payload for any call that RETURNED (success OR a Class-B isError result); null ONLY when the call THREW (Class A)
  duration_ms: number; // performance.now() before and after executor(), rounded, never below 0
  error?: string; // present iff the call failed, in either class — Class A: the sanitized thrown message; Class B: the extracted text of the isError result (issue #345)
}

/**
 * An MCP server a workflow's tool-enabled steps may call: its id and the command that starts it
 * (`WorkflowDefinition.mcp_servers`).
 * @public
 */
export interface McpServerConfig {
  id: string;
  transport: 'stdio'; // 'http' added when HTTP transport lands
  command?: string; // command to spawn
  args?: string[];
  /** Values support "${VAR}" expansion from process.env at connect time */
  env?: Record<string, string>;
}
