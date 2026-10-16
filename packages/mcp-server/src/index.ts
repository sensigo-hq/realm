// @sensigo/realm-mcp — MCP server for AI agent connections
export { createRealmMcpServer, createDefaultRegistry } from './server.js';
export type { RealmMcpServerOptions } from './server.js';
export { generateProtocol } from './protocol/generator.js';
export type { WorkflowProtocol, ProtocolStep } from './protocol/generator.js';
// issue #107: exported so the operator run-purge CLI command (packages/cli) can construct one
// and register it as a PerRunArtifactStore alongside JsonFileStore/FailedAttemptStore.
export { JsonTraceBufferStore } from './json-trace-buffer-store.js';
export { VERSION } from './version.js';
// issue #600 caching PR P: the one loader of a host's prices (the economics file and the price list).
export { loadPriceSource } from './price-source.js';
// #627 W: the gate-answers value a server runs with (for an embedder's log), the bins' readings of
// the two settings with their refusal texts, the form's named constants, and the door's route words.
export {
  effectiveGateAnswers,
  judgeGateAnswers,
  judgeFormWait,
  alsoSetClause,
  GATE_ANSWERS_ENV,
  FORM_WAIT_ENV,
  FORM_WAIT_SECONDS_DEFAULT,
  FORM_WAIT_SECONDS_MIN,
  FORM_WAIT_SECONDS_MAX,
  FORM_WAIT_FLOOR_SECONDS,
  FORM_ASKS_AFTER_FIRST,
  FORM_SETTLE_POLL_MS,
} from './door.js';
export type {
  GateAnswersSetting,
  GateAnswersInput,
  FormWaitSetting,
  FormWaitInput,
} from './door.js';
export { routePhraseOf, renderOutcome } from './form-path.js';
