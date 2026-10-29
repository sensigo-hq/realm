// @sensigo/realm-testing — testing utilities for Realm workflows

// Store
export { InMemoryStore } from './store/in-memory-store.js';
export {
  perRunArtifactStoreContract,
  ARTIFACT_STORE_LAWS,
} from './store/per-run-artifact-store-contract.js';
export type {
  ArtifactStoreLaw,
  ArtifactStoreContractCase,
  PerRunArtifactStoreContractAdapter,
} from './store/per-run-artifact-store-contract.js';
export {
  runStoreFidelityContract,
  RUN_STORE_FIDELITY_LAWS,
} from './store/run-store-fidelity-contract.js';
// issue #620 PR-C: keeping a store's release-line declaration true.
export { storeReleaseLineLaw } from './store/store-release-line-law.js';
export type {
  RunStoreFidelityLaw,
  RunStoreFidelityContractCase,
  RunStoreFidelityContractAdapter,
} from './store/run-store-fidelity-contract.js';
export {
  fencedTraceBufferContract,
  FENCED_TRACE_BUFFER_LAWS,
} from './store/fenced-trace-buffer-contract.js';
export { createFenceRunSource, fenceTestRun } from './store/fence-run-source.js';
export type {
  FenceRunSource,
  FenceRunControl,
  FenceRunPark,
  ParkedRead,
} from './store/fence-run-source.js';
export type {
  FencedTraceBufferLaw,
  FencedTraceBufferContractCase,
  FencedTraceBufferContractAdapter,
} from './store/fenced-trace-buffer-contract.js';
export {
  settlementContract,
  defaultSettlementFixture,
  SETTLEMENT_LAWS,
} from './store/settlement-contract.js';
export type {
  SettlementLaw,
  SettlementContractCase,
  SettlementContractAdapter,
  SettlementFixture,
} from './store/settlement-contract.js';

// issue #715 (a) (D6-36): the store's time laws, as their own family.
export { storeClockContract, STORE_CLOCK_LAWS } from './store/store-clock-contract.js';
export type {
  StoreClockLaw,
  StoreRoute,
  StoreClockContractAdapter,
  StoreClockContractCase,
} from './store/store-clock-contract.js';

// Clocks and test locations (issue #715 (a); D5 §6, D6-1, D6-20, D6-54)
export { settableClock, steppingClock, countingClock } from './clock/settable-clock.js';
export type { SettableClock, SettableClockOptions } from './clock/settable-clock.js';
export { createTestLocation } from './clock/test-location.js';
export type { TestLocation } from './clock/test-location.js';

// Fixtures
export {
  loadFixtureFromFile,
  loadFixtureFromString,
  loadFixturesFromDir,
} from './fixtures/fixture-loader.js';
export type { TestFixture, MockOperations } from './fixtures/fixture-loader.js';

// Mocks
export { MockServiceRecorder } from './mocks/mock-service.js';
export type { RecordedCall } from './mocks/mock-service.js';
export { createAgentDispatcher } from './mocks/mock-agent.js';
export { createGateResponder } from './mocks/mock-gate.js';

// Assertions
export {
  assertFinalState,
  assertStepSucceeded,
  assertStepFailed,
  assertStepOutput,
  assertEvidenceHash,
} from './assertions/evidence.js';

// Unit test helpers
export { testStepHandler } from './helpers/test-step-handler.js';
export { testProcessor } from './helpers/test-processor.js';
export { testAdapter } from './helpers/test-adapter.js';

// Runner
export { runFixtureTests } from './runner/test-runner.js';
export type { TestResult, RunFixtureTestsOptions } from './runner/test-runner.js';

// Servers
export { startGitHubMockServer } from './servers/github-mock-server.js';
export type { GitHubMockServerHandle } from './servers/github-mock-server.js';

export { VERSION } from './version.js';
