// @sensigo/realm-testing — testing utilities for Realm workflows

// Store
export { InMemoryStore } from './store/in-memory-store.js';
export { perRunArtifactStoreContract } from './store/per-run-artifact-store-contract.js';
export type {
  ArtifactStoreLaw,
  ArtifactStoreContractCase,
  PerRunArtifactStoreContractAdapter,
} from './store/per-run-artifact-store-contract.js';
export { runStoreFidelityContract } from './store/run-store-fidelity-contract.js';
export type {
  RunStoreFidelityLaw,
  RunStoreFidelityContractCase,
  RunStoreFidelityContractAdapter,
} from './store/run-store-fidelity-contract.js';
export { fencedTraceBufferContract } from './store/fenced-trace-buffer-contract.js';
export type {
  FencedTraceBufferLaw,
  FencedTraceBufferContractCase,
  FencedTraceBufferContractAdapter,
} from './store/fenced-trace-buffer-contract.js';

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

export const VERSION = '0.27.0';
