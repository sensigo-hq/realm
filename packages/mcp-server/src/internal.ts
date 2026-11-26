// @sensigo/realm-mcp/internal — the internal entry (CP-1 PR 3): every export line of the package, which
// the main entry (`index.ts`) re-exports whole, so the two entries cannot drift and a class is
// one object whichever entry imports it. Until 1.0 every name is importable from either entry;
// from 1.0 on, the names Realm does not promise live only here. A new export line goes here.
// @sensigo/realm-mcp — MCP server for AI agent connections
export { createRealmMcpServer, createDefaultRegistry } from './server.js';
// #627 W correction 2 (4.1): the programs' words — one home for `realm mcp`, `realm serve` and
// `realm-mcp`.
export {
  checkValueLine,
  DEV_MODE_ANSWER_WARNING,
  failureTextBinRefusal,
  failureTextCheckLine,
  failureTextStartLine,
  formWaitBinRefusal,
  formWaitInertRefusal,
  formWaitNoFormsRefusal,
  gateAnswersBinRefusal,
  gateAnswersConnectLine,
  gateAnswersStartLine,
  offeredGivenToProgram,
  OFFERED_DEPRECATION_ID,
  readBinDoorSettings,
  type BinDoorFlags,
  type BinName,
} from './bin-settings.js';
export type { RealmMcpServerOptions } from './server.js';
export { generateProtocol } from './protocol/generator.js';
export type { WorkflowProtocol, ProtocolStep } from './protocol/generator.js';
// issue #107: exported so the operator run-purge CLI command (packages/cli) can construct one
// and register it as a PerRunArtifactStore alongside JsonFileStore/JsonFileFailedAttemptStore.
export { JsonTraceBufferStore } from './json-trace-buffer-store.js';
export { VERSION } from './version.js';
// issue #600 caching PR P: the one loader of a host's prices (the economics file and the price list).
export { loadPriceSource, readCacheEconomics } from './price-source.js';
// #828 unit 2b: a host's own module's source, for `ExtensionRegistry.register`.
export { projectSourceOf } from './project-source.js';
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
// #729 PR-6a (B1): the one sentence-maker, and the words the assistant's doors pass it.
export {
  routePhraseOf,
  renderOutcome,
  ASSISTANT_DOOR_WORDS,
  // #603 A3b: the one "by" part, and the account's label by route.
  answerByPart,
  accountLabelOf,
} from './form-path.js';

// CP-1 PR 1: the types public declarations reference that were not exported (a user could not name
// them): each is tagged `@public` at its declaration.
export type { FailedAttemptStoreLike } from './tools/start-run.js';
export type { LockRetries, TraceBufferLockProfile } from './json-trace-buffer-store.js';
export type { OperatorRoute } from './render-reply.js';
