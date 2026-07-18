// @sensigo/realm — core workflow execution engine
export * from './types/run-record.js';
export * from './types/response-envelope.js';
export * from './types/workflow-error.js';
export { resolvePreExecutionAgentAction } from './engine/error-resolution.js';
export * from './types/workflow-definition.js';
export * from './store/store-interface.js';
export { persistsField } from './store/store-fidelity.js';
export { JsonFileStore } from './store/json-file-store.js';
export type { ReconcileSummary } from './store/json-file-store.js';
export type { PerRunArtifactStore } from './store/per-run-artifact-store.js';
export type { OrphanSweepableStore, OrphanArtifact } from './store/orphan-sweepable-store.js';
export { atomicWriteFile } from './store/atomic-write.js';
export {
  deleteIfExists,
  readIfExists,
  statIfExists,
  FsIoError,
  isRetryableArtifactErrno,
  artifactDeleteFailedError,
  toArtifactDeleteFailedError,
  errnoCode,
  linkNoClobberThenUnlink,
} from './store/fs-io.js';
export type { ArtifactDeleteFailure } from './store/fs-io.js';
export { hashParams, canonicalJson } from './store/params-hash.js';
export { decideIdempotencyPolicy } from './store/idempotency-policy.js';
export type { IdempotencyDecision } from './store/idempotency-policy.js';
export { executeStep } from './engine/execution-loop.js';
export { abandonRun } from './engine/abandon-run.js';
export {
  buildFailedAttemptRecord,
  serializeFailedAttemptLine,
} from './observability/failed-attempt-record.js';
export type {
  BuildFailedAttemptInput,
  FailedAttemptRecord,
  ValidationErrorSummaryEntry,
} from './observability/failed-attempt-record.js';
export {
  FailedAttemptStore,
  FAILED_ATTEMPT_SIDECAR_MAX_BYTES,
} from './store/failed-attempt-store.js';
export type { FailedAttemptReadResult } from './store/failed-attempt-store.js';
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
  isStepSettledOrInFlight,
} from './engine/eligibility.js';
// The unified writer partition (issue #197 PR-2) — the ONE authoritative adoption predicate;
// see trace-adoption.ts's own module doc for the full contract.
export { adoptsLine, partitionBufferedEntries } from './engine/trace-adoption.js';
export type { BufferedEntryPartition } from './engine/trace-adoption.js';
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
  computeClaimDeadline,
  classifyClaim,
  classifyInProgressClaims,
  omitClaim,
  DEFAULT_STEP_TIMEOUT_SECONDS,
  DEFAULT_EXECUTION_TIMEOUT_SECONDS,
  RECLAIM_MARGIN_SECONDS,
  RECLAIM_FLOOR_SECONDS,
  shouldEnforceTimeout,
} from './engine/claim-liveness.js';
export type { ClaimState, InProgressClaimInfo } from './engine/claim-liveness.js';
export { reclaimStep } from './engine/reclaim-step.js';
export type { ReclaimResult, ReclaimOutcome, ReclaimStepOptions } from './engine/reclaim-step.js';
export {
  requirementForStep,
  unmetCapabilities,
  findCapabilityBlockedSteps,
  capabilityWarning,
} from './engine/capability.js';
export type { Requirement, CapabilityBlockInfo } from './engine/capability.js';
export {
  evaluatePrecondition,
  checkPreconditions,
  evaluateAllPreconditions,
} from './engine/precondition.js';
export type { PreconditionResult } from './engine/precondition.js';
export type { StepDiagnostics } from './types/run-record.js';
export const VERSION = '0.26.0';
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
export type { ExtensionManifest, ExtensionModuleRef } from './extensions/manifest.js';
export {
  validateDeploymentManifest,
  collectManifestSecretRefs,
  DEPLOYMENT_MANIFEST_JSON_SCHEMA,
} from './manifest/deployment-manifest.js';
export type {
  DeploymentManifest,
  ManifestEntry,
  ManifestSecretsConfig,
  SlackGateNotifierConfig,
  ExtensionFactory,
  ExtensionFactoryContext,
} from './manifest/deployment-manifest.js';
export {
  scanSecretString,
  stringHasSecretRefs,
  interpolateSecretString,
  interpolateConfigTree,
  findSecretRefSites,
} from './manifest/secret-refs.js';
export type { SecretRefSite, SecretScanResult } from './manifest/secret-refs.js';
export type {
  ExtensionIdentityEntry,
  ExtensionIdentityModule,
  ExtensionIdentityTree,
  ExtensionIdentitySignals,
} from './types/extension-identity.js';
export { extensionIdentityDiffers } from './types/extension-identity.js';

// Evidence
export { captureEvidence } from './evidence/snapshot.js';
export type { CaptureEvidenceParams } from './evidence/snapshot.js';

// Adapters
export { GenericHttpAdapter } from './adapters/http-adapter.js';
export type { HttpAdapterConfig } from './adapters/http-adapter.js';
export { FileSystemAdapter } from './adapters/file-adapter.js';
export { MockAdapter } from './adapters/mock-adapter.js';
export { GitHubAdapter } from './adapters/github-adapter.js';
export type { GitHubAdapterConfig } from './adapters/github-adapter.js';
export { SlackAdapter } from './adapters/slack-adapter.js';
export type { SlackAdapterConfig } from './adapters/slack-adapter.js';
export { GorgiasAdapter } from './adapters/gorgias-adapter.js';
export type { GorgiasAdapterConfig } from './adapters/gorgias-adapter.js';
export { ShopifyAdapter } from './adapters/shopify-adapter.js';
export type { ShopifyAdapterConfig } from './adapters/shopify-adapter.js';
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

// Workflow
export {
  loadWorkflowFromFile,
  loadWorkflowFromString,
  loadWorkflowFromFileWithDiagnostics,
  loadWorkflowFromStringWithDiagnostics,
  findTrustRoot,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from './workflow/yaml-loader.js';
export { JsonWorkflowStore } from './workflow/registrar.js';
export type { WorkflowRegistrar } from './workflow/registrar.js';

// Diagnostics — structured loader-warning channel (issue #169)
export {
  DEFAULT_POLICY,
  resolveSeverity,
  findUnknownKeys,
  renderLoaderWarning,
} from './workflow/diagnostics.js';
export type { WarningCode, LoaderWarning } from './workflow/diagnostics.js';

// Handler primitives
export { resolveResource } from './handlers/primitives/resolve-resource.js';
export { walkField } from './handlers/primitives/walk-field.js';
export { partitionBySubstring } from './handlers/primitives/partition-by-substring.js';
export { countResults } from './handlers/primitives/count-results.js';
export { compareStrings } from './handlers/primitives/compare-strings.js';

// Trace buffer store (B-lite)
export type {
  TraceBufferStore,
  BufferedEntry,
  AppendResult,
  AppendOptions,
  TraceCapability,
  SealResult,
  SealedWalLine,
  SealedArtifact,
  BufferFullDetails,
} from './store/trace-buffer-store.js';
export {
  InMemoryTraceBufferStore,
  normalizeEntryForBuffer,
  BUFFER_LIMIT_COUNT,
  BUFFER_LIMIT_BYTES,
  FINAL_LIMIT_ENTRIES,
  FINAL_LIMIT_BYTES,
  BUFFER_BACKSTOP_COUNT,
  BUFFER_BACKSTOP_BYTES,
  SEALED_ARTIFACTS_LIMIT_PER_STEP,
  storeDeclaresSeal,
  storeDeclaresNonceCarriage,
  validateTraceCapabilities,
  checkBufferBudget,
  bufferFullError,
  flattenWalBatches,
} from './store/trace-buffer-store.js';
