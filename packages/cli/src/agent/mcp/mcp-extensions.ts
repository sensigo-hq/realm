// MCP extensions — CLI-internal MCP types: McpTool, ToolDefinition, ToolExecutor,
// StepWithToolsResult, McpClient. Also re-exports ToolCallRecord and McpServerConfig
// from @sensigo/realm for use within the CLI package.
import type { ToolCallRecord, McpServerConfig, StructuredOutputMeta } from '@sensigo/realm';
export type { ToolCallRecord, McpServerConfig };

// MCP-native tool shape returned by the server's tool list
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Tool definition passed to the provider — MCP shape plus routing metadata.
export interface ToolDefinition {
  id: string; // namespaced routing key: "server_id:tool_name" — use for executor() calls ONLY, never for LLM wire format
  serverId: string; // "github" — used to route call to correct McpClient server
  name: string; // bare tool name as declared by the MCP server — use this for LLM API wire format
  description: string;
  inputSchema: Record<string, unknown>;
}

// Executor function — implemented in run-agent.ts, passed into the provider
export type ToolExecutor = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

// Return type of callStepWithTools
export interface StepWithToolsResult {
  output: Record<string, unknown>;
  toolCalls: ToolCallRecord[]; // empty array = tools declared but none called
  // (distinct from callStep which returns no toolCalls at all)
  /**
   * issue #224 (D6, [audit F2]): number of in-conversation schema corrections this call performed
   * (0 or absent = none). Corrections consume the SHARED `maxToolCalls` budget invisibly (no
   * `toolCalls` entry) — this field is the inspection surface for that cost. Deliberately NOT
   * threaded into `stepMeta` (a CORE type, execution-loop.ts) — this is a cli-local
   * observability field only.
   */
  correctionCount?: number;
  /**
   * Issue #236: additive, present only on the tools-path leg the design's by-construction-only
   * coverage note describes (G6 makes every tools-bearing step ineligible for strict end-to-end,
   * so this is never populated by AnthropicProvider in v1 — the field exists so a FUTURE
   * provider/version can populate it without another interface change).
   */
  structuredOutput?: StructuredOutputMeta;
}

// McpClient interface — implemented in mcp-client.ts
export interface McpClient {
  /**
   * Lazily connects to a server on first call. Idempotent.
   * stdio failures throw WorkflowError(MCP_CONNECTION_FAILED, stop).
   */
  connect(serverId: string): Promise<void>;
  /**
   * Returns tools from the specified server, filtered to the allow-list.
   * Triggers lazy-connect on first call — the subprocess may spawn here.
   */
  getTools(serverId: string, allowList: string[]): Promise<McpTool[]>;
  /** Execute a tool on the specified server. */
  call(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
  /**
   * Shut down all server connections. Idempotent — safe to call multiple times.
   * Must be called in finally blocks.
   * If constructed with an AbortSignal, also called automatically on abort.
   */
  disconnect(): Promise<void>;
}
