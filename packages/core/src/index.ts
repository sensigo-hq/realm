// @sensigo/realm — core workflow execution engine
export * from './types/run-record.js';
export * from './types/response-envelope.js';
export * from './types/workflow-error.js';
export { resolvePreExecutionAgentAction } from './engine/error-resolution.js';
export * from './types/workflow-definition.js';
export * from './store/store-interface.js';
export { JsonFileStore } from './store/json-file-store.js';
export { executeStep } from './engine/execution-loop.js';
export type { StepDispatcher, ExecuteStepOptions } from './engine/execution-loop.js';
export {
  submitHumanResponse,
  executeChain,
  buildNextActions,
  buildPreExecutionErrorEnvelope,
} from './engine/execution-loop.js';
export type { SubmitGateOptions, ExecuteChainOptions } from './engine/execution-loop.js';
export {
  findEligibleSteps,
  isWorkflowComplete,
  deriveRunPhase,
  buildEvidenceByStep,
  propagateSkips,
} from './engine/eligibility.js';
export {
  TERMINAL_PHASES,
  RESUMABLE_PHASES,
  WAITING_PHASES,
  isTerminalPhase,
  TERMINAL_STATES,
  RESUMABLE_STATES,
  WAITING_STATES,
  isTerminalState,
} from './engine/lifecycle.js';
export {
  evaluatePrecondition,
  checkPreconditions,
  evaluateAllPreconditions,
} from './engine/precondition.js';
export type { PreconditionResult } from './engine/precondition.js';
export type { StepDiagnostics } from './types/run-record.js';
export const VERSION = '0.6.3';
export type { ToolCallRecord, McpServerConfig } from './types/mcp-types.js';

// Extensions
export type { ServiceAdapter, ServiceResponse } from './extensions/service-adapter.js';
export type {
  StepHandler,
  StepHandlerInputs,
  StepContext,
  StepHandlerResult,
} from './extensions/step-handler.js';
export type { Processor, ProcessorInput, ProcessorOutput } from './extensions/processor.js';
export { ExtensionRegistry } from './extensions/registry.js';
export { createDefaultRegistry } from './extensions/default-registry.js';

// Evidence
export { captureEvidence } from './evidence/snapshot.js';
export type { CaptureEvidenceParams } from './evidence/snapshot.js';

// Adapters
export { GenericHttpAdapter } from './adapters/http-adapter.js';
export type { HttpAdapterConfig } from './adapters/http-adapter.js';
export { FileSystemAdapter } from './adapters/file-adapter.js';
export { GitHubAdapter } from './adapters/github-adapter.js';
export type { GitHubAdapterConfig } from './adapters/github-adapter.js';
export { SlackAdapter } from './adapters/slack-adapter.js';
export type { SlackAdapterConfig } from './adapters/slack-adapter.js';
export { GorgiasAdapter } from './adapters/gorgias-adapter.js';
export type { GorgiasAdapterConfig } from './adapters/gorgias-adapter.js';
export { ShopifyAdapter } from './adapters/shopify-adapter.js';
export type {
  ShopifyAdapterConfig,
  NormalizedOrder as ShopifyNormalizedOrder,
} from './adapters/shopify-adapter.js';
export { ParcelPanelAdapter } from './adapters/parcelpanel-adapter.js';
export type {
  ParcelPanelAdapterConfig,
  ParcelPanelShipment,
  ParcelPanelOrderBody,
} from './adapters/parcelpanel-adapter.js';
export { AirtableAdapter } from './adapters/airtable-adapter.js';
export type { AirtableAdapterConfig } from './adapters/airtable-adapter.js';
export { NotionAdapter } from './adapters/notion-adapter.js';
export type { NotionAdapterConfig } from './adapters/notion-adapter.js';

// Trace policy
export { TRACE_POLICY_VERSION, TRACE_POLICY, TRACE_POLICY_HASH } from './engine/trace-policy.js';
export type { TracePolicyDescriptor, TracePolicyVersion } from './engine/trace-policy.js';

// Validation
export { validateInputSchema } from './validation/input-schema.js';

// Config
export { loadSecrets, resolveSecret } from './config/secrets.js';

// Workflow
export {
  loadWorkflowFromFile,
  loadWorkflowFromString,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from './workflow/yaml-loader.js';
export { JsonWorkflowStore } from './workflow/registrar.js';
export type { WorkflowRegistrar } from './workflow/registrar.js';

// Handler primitives
export { resolveResource } from './handlers/primitives/resolve-resource.js';
export { walkField } from './handlers/primitives/walk-field.js';
export { partitionBySubstring } from './handlers/primitives/partition-by-substring.js';
export { countResults } from './handlers/primitives/count-results.js';
export { compareStrings } from './handlers/primitives/compare-strings.js';

// Trace buffer store (B-lite)
export type { TraceBufferStore, BufferedEntry, AppendResult } from './store/trace-buffer-store.js';
export {
  InMemoryTraceBufferStore,
  normalizeEntryForBuffer,
  BUFFER_LIMIT_COUNT,
  BUFFER_LIMIT_BYTES,
  FINAL_LIMIT_ENTRIES,
  FINAL_LIMIT_BYTES,
} from './store/trace-buffer-store.js';
