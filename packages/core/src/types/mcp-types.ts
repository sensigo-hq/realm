// ToolCallRecord and McpServerConfig live in core because they are referenced by core types
// (EvidenceSnapshot, ExecuteChainOptions, WorkflowDefinition). Defining them in cli would
// create a circular import: core → cli → core.

export interface ToolCallRecord {
  server_id: string; // "github" — MCP server ID from mcp_servers[].id
  tool: string; // bare tool name: "get_pull_request" (NOT namespaced)
  args: Record<string, unknown>;
  result: string | null; // sanitized serialized payload for any call that RETURNED (success OR a Class-B isError result); null ONLY when the call THREW (Class A)
  duration_ms: number; // Date.now() before and after executor()
  error?: string; // present iff the call failed, in either class — Class A: the sanitized thrown message; Class B: the extracted text of the isError result (issue #345)
}

export interface McpServerConfig {
  id: string;
  transport: 'stdio'; // 'http' added when HTTP transport lands
  command?: string; // command to spawn
  args?: string[];
  /** Values support "${VAR}" expansion from process.env at connect time */
  env?: Record<string, string>;
}
