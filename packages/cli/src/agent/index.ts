// Public agent interface surface for @sensigo/realm-cli/agent.
// Custom provider authors implement LlmProvider or ToolCapableLlmProvider against these types.
export { LlmProvider, ToolCapableLlmProvider } from './providers/llm-provider.js';
export type { ProviderCapabilities } from './providers/llm-provider.js';
// Gap 1, unit A1: what a provider reports of each answered request, so Realm keeps its text.
export type { ModelTextReport } from './providers/model-text.js';
export type {
  ToolExecutor,
  StepWithToolsResult,
  ToolCallRecord,
  McpServerConfig,
} from './mcp/mcp-extensions.js';
