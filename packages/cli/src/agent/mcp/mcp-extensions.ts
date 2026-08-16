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
  /**
   * Issue #311: attach `strict: true` to THIS tool on the wire. Additive-optional; absent (the
   * default) is today's behaviour byte-identical.
   *
   * The SELECTION decision lives entirely in run-agent (per-tool eligibility verdict + the
   * declared-order budget walk) and rides down per tool here, rather than as a name list in the
   * options object, so the marker can never drift out of sync with the tools array it describes.
   * A provider that ignores this field simply sends every tool unconstrained.
   */
  strict?: boolean;
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
   * Issue #236: additive, present only on the tools-path leg.
   *
   * Issue #311 truth-fix: the original note here claimed this "is never populated by
   * AnthropicProvider in v1" because "G6 makes every tools-bearing step ineligible for strict
   * end-to-end". That premise died with #311's Phase-A gate change — strict is now genuinely
   * reachable on a tools-bearing step, applied to TOOL-CALL ARGUMENTS. This field still carries
   * the step-OUTPUT meta only; the tool-arguments story is assembled by run-agent from the
   * per-tool verdicts plus `toolArgsStrictDrop` below.
   */
  structuredOutput?: StructuredOutputMeta;
  /**
   * Issue #311: what the WIRE did to strict during this call, when a live 400/503 forced realm to
   * drop it part-way through the attempt. Absent when nothing was dropped.
   *
   * The provider reports only what it observed (status class + captured message + how many
   * strict-decorated requests had already returned 200); it never assembles evidence. run-agent
   * owns the `tool_args` block, because only it knows the declared tool order, each tool's
   * eligibility verdict, and which tools the budget walk selected.
   */
  toolArgsStrictDrop?: {
    /** Status-derived label ONLY — never parsed out of the message body. */
    reason: 'api_rejected_schema' | 'grammar_unavailable' | 'service_unavailable';
    /** The raw API error text, verbatim, for the operator to compare against Anthropic's own. */
    api_message?: string;
    /** Strict-decorated requests that returned 200 before the drop; 0 = the first one was rejected. */
    strict_turns_before_drop: number;
  };
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
