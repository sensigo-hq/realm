// @sensigo/realm/internal — the internal entry (CP-1 PR 3): every export line of the package, which
// the main entry (`index.ts`) re-exports whole, so the two entries cannot drift and a class is
// one object whichever entry imports it. Until 1.0 every name is importable from either entry;
// from 1.0 on, the names Realm does not promise live only here. A new export line goes here.
// @sensigo/realm — core workflow execution engine
export * from './types/run-record.js';
export * from './types/response-envelope.js';
export * from './types/workflow-error.js';
export { resolvePreExecutionAgentAction } from './engine/error-resolution.js';
export * from './types/workflow-definition.js';
export * from './store/store-interface.js';
// #729, the claim window, CW-1: the claim lease's port, its answers and its closed reason lists.
export * from './store/lease-port.js';
// #597 D1a: the outbound ledger's port, its request check and its pure state machine.
export * from './store/outbound-ledger.js';
// R1.3 callback A1a: the callback store's port (door side), its request check and its row.
export * from './store/callback-store.js';
// R1.3 callback A2: the callback store's signing keys, their request check, fingerprint and deciders.
export * from './store/callback-keys.js';
// #729, the claim window, CW-1b: the facts a store's lease port found, and their one reader.
export { leaseFactsOf, leaseFactOf, NO_LEASE_FACTS, LeaseFactsClass } from './store/lease-facts.js';
export type { LeaseFacts, Unleased } from './store/lease-facts.js';
export { persistsField } from './store/store-fidelity.js';
export { JsonFileStore } from './store/json-file-store.js';
export type {
  ReconcileSummary,
  RunListing,
  UnreadableRunFileEntry,
} from './store/json-file-store.js';
// issue #719: a damaged stored JSON file — its facts (the typed `facts` of its error, keyed on
// `scope` since #729 PR-0) and their ONE reader, the ONE composer of its message, the error one such
// file gives (exported so no caller restates core's retry rule, #729 PR-0) and the one a decision
// over every run fails closed with and its reader, the scope predicate of every workflow-scoped
// read, how a file-held id is shown, the side files a run keeps beside it and their kinds.
export {
  describeStoredFileFault,
  renderUnreadableStoredFile,
  unreadableRunFileError,
  unreadableRunFilesError,
  unreadableFactsOf,
  unreadableRunFilesOf,
  damagedFileConcerns,
  isCopyOfReadableRun,
  displayId,
  RUN_ID_LENGTH,
  TRACE_BUFFER_FILE_PREFIX,
  SEALED_TRACE_FILE_PREFIX,
  TRACE_FILE_SUFFIX,
  SIDE_FILE_KINDS,
} from './store/run-file.js';
export type {
  UnreadableFileFacts,
  UnreadableRunFilesFacts,
  StoredFileClass,
  SideFileKind,
  WorkflowCopyFault,
} from './store/run-file.js';
// issue #719: the one check that a value is a run record (admission's `run`, the store's reader).
export { isRunRecordShape } from './types/run-record-shape.js';
export type {
  PerRunArtifactStore,
  ArtifactDeletionReport,
} from './store/per-run-artifact-store.js';
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
// Gap 1, unit A2a: the rule a store's `update` applies to a drive failure's stored model text.
export { driveFailureTextLoss, type DriveFailureTextLoss } from './store/drive-failure-texts.js';
// Gap 2, unit (i-a): what a failed model request needs before it can succeed.
export { classifyModelFailure, type ModelFailureFacts } from './engine/model-failure.js';
// Gap 2, unit (i-b): the drive's own uses (internal): the closure its drive-failure write shares
// with the evidence entry's, and an agent step's retry wait and the schedule its derived cap sums.
export { closeModelAttempts, failedRequestSends } from './engine/model-failure.js';
export { modelRetryWaitMs, modelRetryScheduleMs } from './engine/backoff.js';
export { decideIdempotencyPolicy } from './store/idempotency-policy.js';
export type { IdempotencyDecision } from './store/idempotency-policy.js';
export { executeStep } from './engine/execution-loop.js';
// Issue #625 PR-2a (F1): the one duration formatter — `<n>s` under a minute, then `<m>m`, `<h>h <m>m`,
// `<d>d <h>h`.
// #729 PR-6a (B3): `instantText` — the one instant formatter the outcome composer writes times with.
export { formatDuration, formatInstantWords, instantText } from './utils/duration.js';
// Issue #625 PR-2a (F6): the one POSIX shell quoter for a value a printed command carries.
export { shellWord, quotedCommand } from './utils/shell-word.js';
/**
 * Issue #625 holder slice (PR-H): the vocabulary and the pure functions for who took a step and how a
 * caller proves it was handed the reply that opened a question. Core reads no environment and no OS
 * fact; hosts read theirs and call `composeProgramIdentity`.
 */
export {
  BY_SOURCE_CLASSES,
  // #625 PR-2b, the actor unit: how a program's name is known, in words — the one copy.
  BY_SOURCE_WORDS,
  RECORDED_BY_SOURCE_WORDS,
  ACTOR_ABSENT_CAUSES,
  GATE_PROOFS,
  GATE_PROOF_CAUSES,
  CLAIM_PROOF_ABSENT_CAUSES,
  // #625 PR-2b A2a: D-8's reasons.
  NOT_CARRIED_ON_REASONS,
  // #603 A3b: why an answer's view names no account, or no admission.
  ACCOUNT_ABSENT_CAUSES,
  ADMITTED_BY_ABSENT_CAUSES,
  NAME_MAX_LENGTH,
  NAME_CAP_MARKER,
  NAME_REFUSAL_REASONS,
  boundStated,
  boundStatedName,
  identityRefusalLine,
  validateDriver,
  composeProgramIdentity,
  readStoredName,
  // #729 PR-6a (B2 (2), B4): the one classification of a stated name, and its one quoting.
  readStatedAnswerer,
  quoteStatedName,
  UNSHOWABLE_NAME,
  readAttributed,
  readDrivenBy,
  readGateClaimVerdict,
  describeClaimHolder,
  judgeGateProof,
  composeGateClaimSentence,
} from './engine/holder.js';
export type {
  BySourceClass,
  Attributed,
  ActorAbsentCause,
  ActorAbsent,
  ClaimHolderAbsentCause,
  GateProof,
  GateProofCause,
  GateClaimVerdict,
  ClaimProofAbsentCause,
  AccountAbsentCause,
  AdmittedByAbsentCause,
  ProgramIdentityFacts,
} from './engine/holder.js';
/**
 * Issue #600 PR 1a — exported so a RENDERER can pin the sentence it prints against the classifier
 * that produces the state, instead of hard-coding a state word beside a sentence. Without it the
 * cli's render table and this function can drift apart and the render cells then describe
 * (read x write x state) triples production can never mint — a mutation of this function left the
 * whole cli suite green.
 */
export { deriveCacheDetail } from './engine/execution-loop.js';
// #625 A1a: `own_act`'s opening — its words for a step, and the one composer the doors apply.
export { stepCompletedWords, openWithOwnAct } from './engine/execution-loop.js';
// issue #600 PR 2 (A3): the names a request record carries, bounded where the record is written.
export { boundRequestFacts, normalizeResponseId } from './engine/request-facts.js';
export { abandonRun, ABANDON_KILL_ADVISORY } from './engine/abandon-run.js';
export {
  buildFailedAttemptRecord,
  moreOf,
  serializeFailedAttemptLine,
} from './observability/failed-attempt-record.js';
export type {
  BuildFailedAttemptInput,
  FailedAttemptRecord,
  ValidationErrorSummaryEntry,
} from './observability/failed-attempt-record.js';
export {
  JsonFileFailedAttemptStore,
  FAILED_ATTEMPT_SIDECAR_MAX_BYTES,
} from './store/failed-attempt-store.js';
export type { FailedAttemptStore, FailedAttemptReadResult } from './store/failed-attempt-store.js';
// #616 B1: the store interfaces the CLI kept, owned by the core so another package can implement
// them (the CLI's file and in-memory stores implement them).
export type { DedupStore } from './store/dedup-store.js';
export type { ReplayStore, ReplayRecord, ReplayStepResult } from './store/replay-store.js';
export type { StepDispatcher, ExecuteStepOptions } from './engine/execution-loop.js';
export {
  submitHumanResponse,
  executeChain,
  buildPreExecutionErrorEnvelope,
  DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
  raceClausesOf,
  // #627 W: how a question was settled, read from the record (the form path's reply after a wait).
  outcomeOf,
} from './engine/execution-loop.js';
export type { SubmitGateOptions, ExecuteChainOptions } from './engine/execution-loop.js';
// Issue #625 (PR-1, PR-2a). `advanceRun` runs what the engine owes on a run (settle eligible
// guards, then run its eligible auto steps); `start_run`, `advance_run`, `realm run advance` and the
// `realm agent` loop call it. The rest is the
// ONE mint of what a settlement write's guards mean on a reply and on a screen: the ending reader
// and its printed lines for a surface holding a settlement result (`realm run drain --expired`,
// the gate-expiry timer), and the composer for a surface that speaks after an answer
// (`realm run respond`, the Slack gate notifier, the terminal run prompt).
export {
  advanceRun,
  guardEndingOf,
  describeGuardEndingLines,
  describeGuardLines,
  describeEndedBy,
  guardPassedLine,
  describeAnswerEnding,
  finalizerOutcomeLines,
  lateAnswerOutcome,
  expiryCarriedOutLine,
  // issue #729 PR-0 (T-2): the expiry receipt, and its one line.
  expiryReceiptOf,
  expiryReceiptLine,
  runReadError,
  terminalAnswerRefusalMessage,
  // #729 PR-6a (B5): the way out of an ended run, the sentence a refusal on it ends with.
  endedRunWayOutOf,
  withResumeOffer,
  endedRunWaysSentence,
  // #625 A1b-1: the one "said once" rule — whether a reply about an ended run says how it ended.
  saysHowItEnded,
  pendingGateQuestion,
} from './engine/execution-loop.js';
export type {
  AdvanceRunOptions,
  AdvanceCaller,
  StepCaller,
  EngineStepCaller,
  ChainCaller,
  AnswerCaller,
  EnactedVia,
  ExecuteEngineStepOptions,
  GuardEnding,
} from './engine/execution-loop.js';
export { bareStepOutput, executeEngineStep, guardEndingOfRun } from './engine/execution-loop.js';
// F4: where an evidence entry's output came from — the source, or why it has none (`OUTPUT_SOURCES`, the
// vocabulary, is exported with the run record's types).
export {
  OUTPUT_SOURCE_ABSENT_CAUSES,
  isBareAutoStep,
  callsHostDispatcher,
  outputSourceOf,
} from './engine/output-source.js';
export type { OutputSourceAbsentCause } from './engine/output-source.js';
// issue #729 PR-0: the ways on — one vocabulary judged once in core (PR0-CONTRACT §1–§4): the verbs,
// the parties, the codes and their facts, the one input contract per verb, the composer, the one
// admission, the narrowing for a door, the one derivation of an agent's action word, and (T-1) the
// one vocabulary for "another program got there first" every loop reads.
export {
  PARTIES,
  WAY_VERBS,
  PROGRESS_VERBS,
  WAY_PARTIES,
  CODE_TAGS,
  UNAVAILABLE_CODES,
  DEFINITION_ABSENCES,
  NO_REMEDY_CAUSES,
  ARGS,
  DOOR_SERVES,
  REPLY_KINDS,
  STOP_KINDS,
  composeWaysOn,
  composeWaysAt,
  respondWayOfGate,
  admitWay,
  narrowForDoor,
  agentActionOf,
  agentRenderedList,
  stepBrief,
  basisOf,
  waysStoreOf,
  classifyStop,
  isRaceStop,
  stopAbout,
  renderDefinitionAbsent,
  readSupplier,
  // Q1 (#592) unit a: a failed step's words, as its entry records them.
  readFailureWords,
  cannotGoOnFrom,
  cannotGoOnUntilCorrected,
  LIBRARY_WORDS,
  withLibraryWords,
  libraryCannotRunWords,
  // #872 (a): the one bounded renderer of a cannot-run entry's parts, and the hand-back hint's
  // grouped summary (door-neutral: the MCP door adds its pointer).
  cannotRunParts,
  cannotRunSummary,
  // #627 W: the door's gate answers, the condition its fallback carries, `present`.
  COND_TAGS,
  GATE_ANSWERS_VALUES,
  answersRowOf,
  presentDoorVerdict,
  presentWayOfGate,
  doorWithholdsAnswers,
  // #922: a held step's state (at composition, and from a composed entry), and the one table of a
  // reclaim condition's words.
  heldStateAt,
  heldStateOf,
  heldIsPast,
  heldIsAhead,
  reclaimConditionWords,
  // #922 P2-1 (R13): the one table of a held step's words, by its state, and its readers.
  HELD_WORDS,
  heldWordsStateOf,
  heldRerunOf,
  heldAgentWords,
  // #922: the fact a reclaim refusal states (each door renders its act).
  reclaimRefusalWords,
  // #729 CW-4a: the one table of what a claim's lease check found when it could not answer.
  uncheckedLeaseOf,
  leaseCheckPhrase,
  leaseCheckCondition,
  LEASE_NOT_KNOWN_HERE,
  // #729 CW-4b: the one clause of what a claim's lease check found, for the holder lines.
  leaseClause,
  // Q1 (#592) d1b correction 1: every code a reply's enactor basis can name.
  LOAD_ERROR_CODES,
} from './engine/ways.js';
export type { UncheckedLease, LeaseWordsInput } from './engine/ways.js';
export type { FailureWordField, FailureWordsAbsentCause, FailureWordsRead } from './engine/ways.js';
export type {
  Party,
  Slot,
  Cond,
  WayVerb,
  ProgressVerb,
  StepBrief,
  RespondWay,
  RunStepWay,
  AdvanceWay,
  InspectWay,
  AbandonWay,
  RegisterWay,
  PresentWay,
  ReclaimWay,
  HeldState,
  HeldWordsState,
  WayOn,
  WayOf,
  CodeTag,
  UnavailableCode,
  RefusedCheck,
  DefinitionAbsence,
  LoadErrorCode,
  FactsByCode,
  FactsOf,
  NoRemedy,
  Unavailable,
  ArgSpec,
  RouteId,
  Source,
  DoorPolicy,
  CondTag,
  GateAnswers,
  DoorAnswers,
  DoorFormFacts,
  AnswersRow,
  ForWay,
  Narrowed,
  WayRenderer,
  PartialWayRenderer,
  LibraryHost,
  ReplyKind,
  RenderedList,
  WaysContext,
  ComposedWays,
  WayInput,
  Admission,
  HaltStop,
  HaltStopKind,
  NotRecordedKind,
  RaceStop,
  RaceStopKind,
  StopClassification,
  StopKind,
  StopRecord,
  StopReply,
} from './engine/ways.js';
// #627 W (§5.8): how a gate answer arrived — the one reading, and the form's evidence.
export {
  answerViaOf,
  // #603 A3b: the one reader of the account a channel reported for an answer.
  answerAccountOf,
  answerArrivalOf,
  principalOf,
  shownViewEvidence,
  MCP_FORM_RENDERER,
} from './engine/answer-facts.js';
export type { AnswerArrival } from './engine/answer-facts.js';
// #627 W (F31): author text an agent reads — the label W-t1 forwards it under, the load note W-l1.
export {
  ANSWER_TOOL_NAMES,
  AUTHOR_TEXT_LABEL,
  AUTHOR_RULES_LABEL,
  answerToolNamedIn,
  authorTextNote,
} from './workflow/author-text.js';
export type { AnswerToolName } from './workflow/author-text.js';
// issue #729 PR-0 (D3 A-9; #715 D6-16/17/18/59): one record and the reading it is judged at.
// #715 (b) (Amendment 4): the accessor only — the attach function stays internal to core.
export {
  loadSnapshot,
  writtenSnapshot,
  stampOf,
  judgedSnapshotOf,
  listedSnapshotOf,
  // Q1 (#592) d1b: every kind an enactor basis can name.
  ENACTOR_KINDS,
} from './engine/snapshot.js';
export type {
  Snapshot,
  ListedSnapshot,
  Stamp,
  Basis,
  EnactorBasis,
  DefinitionBasis,
} from './engine/snapshot.js';
// Gap 1, unit A0: the one way Realm lists runs without their model calls' texts.
export { scanListedRuns } from './store/listed-scan.js';
// Issue #625 PR-2a (decisions C133, C151): the words each engine entry's `caller` takes.
export { ENTRY_CALLERS } from './engine/callers.js';
// Issue #688: whether a step receives what its input_map builds, and what a refusal of that input names.
export {
  consumesInputMap,
  refusedInputField,
  newRunCanChangeInput,
  type InputMapStep,
} from './engine/input-map.js';
// Issue #625 (PR-2a): what a run owes, read from its record. #729 PR-0: the instructions and way
// sentences these once composed are the doors' (MCP `renderReply`, the CLI's `CLI_COMMANDS`).
export {
  PRE_CLAIM_REFUSALS,
  AGENT_PRE_CLAIM_REFUSALS,
  CAPABILITY_BASES,
  checkPreClaim,
  engineStepInput,
  describePending,
  stepsThatCannotRun,
  owedNames,
  owedList,
  owedWords,
  cannotGoOnHere,
  resumeWay,
  // F2: what a surface may OFFER to `realm run resume` (an engine failure only).
  offeredResumeWay,
  // #625 A1b-1: the one ending composer — how an ended run ended, from its record only; A1b-2: the
  // way out of an abandoned run, read by the CLI's surfaces from here.
  runEndingOf,
  // #625 PR-2b, the actor unit: `realm run inspect`'s `Ended by:` line, minted beside the sentences.
  endedByLine,
  NEW_RUN_SENTENCE,
  oneOf,
  waitingOnAnswer,
  pendingCleanupWay,
  pendingCleanupLine,
  pendingCleanupSentence,
  heldLeaseWords,
  withFullStop,
  endsWithCommand,
  sentenceEnd,
  ADVANCE_OWED,
  composeNextActionsStatusWord,
  // Q1 (#592) d1: every `next_actions_status` word, as a list (its type moved here from the MCP
  // server).
  NEXT_ACTIONS_STATUS,
  PROGRAM_FITS,
  judgeProgramFit,
  describeRunDriver,
  dueExpiry,
  dueExpiryWords,
  callableSteps,
  // decision C103: the open question.
  openQuestionOf,
  answerableQuestion,
  openQuestionWords,
} from './engine/pending.js';
export type {
  PreClaimRefusal,
  AgentPreClaimRefusal,
  PreClaimRefused,
  PreconditionFacts,
  CapabilityBasis,
  EngineRunnable,
  PendingView,
  ProgramFit,
  DueExpiry,
  OpenQuestion,
  RunEnding,
  NextActionsStatus,
} from './engine/pending.js';
export {
  findEligibleSteps,
  isWorkflowComplete,
  deriveRunPhase,
  // #616 PR-1a unit 2b: the stamp a stored phase index carries (design d4-frozen-r3 §3).
  runPhaseDerivationFingerprint,
  buildEvidenceByStep,
  buildSettlementNamespace,
  propagateSkips,
  isStepSettledOrInFlight,
  // issue #367 — the recorded seal fact: the arm mappings (engine-owned total functions), the
  // permanent legacy read oracle and its coherence-comparator sibling, the run-level bypass-writer
  // chokepoint, and the two transform-scoped congruence assertions.
  armToPhase,
  armToOutcome,
  armMarker,
  classifyLegacySeal,
  classifyForCoherence,
  sealRunLevel,
  assertSealMarkersAgree,
  assertSealOutcomeCoherent,
} from './engine/eligibility.js';

// issue #367 — the L2 store-boundary enforcement, shared by both in-repo stores (InMemoryStore in
// @sensigo/realm-testing imports it from here).
export { assertSealIntegrity } from './store/seal-integrity.js';
// The unified writer partition (issue #197 PR-2) — the ONE authoritative adoption predicate;
// see trace-adoption.ts's own module doc for the full contract.
export { adoptsLine, partitionBufferedEntries } from './engine/trace-adoption.js';
export type { BufferedEntryPartition } from './engine/trace-adoption.js';
// The shared default-settled-step derivation (issue #232) — the ONE authoritative scan of
// `evidence[].diagnostics.settled_by_default`; see defaulted-steps.ts's own module doc.
export { deriveDefaultedSteps, isModelFailureDefault } from './engine/defaulted-steps.js';
// Atomic settlement (issue #279, increment 1, PR-A) — the pure transform + finalizer selection.
// DORMANT: no engine/mcp call site constructs a SettlementDelta or calls settleStep in this
// release (enforced by an in-repo source-text guard — see its own test for the exact scope).
export {
  applySettlement,
  selectFinalizers,
  RECLAIM_REFUSES_GATE_STEP,
} from './engine/settlement.js';
export { applyResume } from './engine/apply-resume.js';
export type { ApplyResumeResult, ApplyResumeVoidedFinalizer } from './engine/apply-resume.js';
export { drainFinalizers } from './engine/execution-loop.js';
export type {
  SettlementDelta,
  SettleStepDelta,
  SettleStepOutcome,
  LeaseFinalizerDelta,
  MarkFinalizerDelta,
  MarkFinalizerResult,
  SettlementResult,
  SettlementRefusalReason,
  SettlementNoopReason,
  // #715 (b) (D-20, D-21): the opening gate without its instants, and the run-level seal delta.
  OpeningGate,
  SealRunDelta,
} from './types/settlement.js';
export {
  TERMINAL_PHASES,
  RESUMABLE_PHASES,
  WAITING_PHASES,
  isTerminalPhase,
  TERMINAL_STATES,
  RESUMABLE_STATES,
  WAITING_STATES,
  isTerminalState,
  DRAIN_LEASE_MAX,
} from './engine/lifecycle.js';
export {
  computeClaimDeadline,
  classifyClaim,
  classifyInProgressClaims,
  isIdleForCleanup,
  omitClaim,
  DEFAULT_STEP_TIMEOUT_SECONDS,
  DEFAULT_EXECUTION_TIMEOUT_SECONDS,
  RECLAIM_MARGIN_SECONDS,
  RECLAIM_FLOOR_SECONDS,
  shouldEnforceTimeout,
  worstCaseScheduleSeconds,
  resolveCapMs,
  // Q1 (#592) d1: every claim state, as a list.
  CLAIM_STATES,
  // Q1 (#592) f2: a claim's deadline with its cause, and every cause.
  claimDeadlineOf,
  CLAIM_DEADLINE_ABSENT_CAUSES,
} from './engine/claim-liveness.js';
export type {
  ClaimState,
  InProgressClaimInfo,
  ClaimDeadlineAbsent,
} from './engine/claim-liveness.js';
export { reclaimStep } from './engine/reclaim-step.js';
export type { ReclaimResult, ReclaimOutcome, ReclaimStepOptions } from './engine/reclaim-step.js';
// #729, the claim window (CW-3b): the automatic take-back, internal (`realm agent`'s watch
// calls it).
export {
  takeBackStep,
  automaticTakebacksOf,
  AUTOMATIC_TAKEBACKS_PER_STEP,
  TAKE_BACK_NOT_TAKEN_REASONS,
} from './engine/reclaim-step.js';
export type {
  TakeBackStepOptions,
  TakeBackOutcome,
  TakeBackNotTakenReason,
} from './engine/reclaim-step.js';
// #729, the claim window (CW-2a): a drive takes a step's claim under its lease, and gives it back.
export { claimStepForDrive, releaseDriveClaim } from './engine/drive-claim.js';
export type {
  ClaimStepForDriveOptions,
  DriveClaim,
  ReleaseDriveClaimOptions,
  DriveRelease,
} from './engine/drive-claim.js';
export {
  classifyRunHealth,
  DEFAULT_IDLE_THRESHOLD_MS,
  // Q1 (#592) unit f1: the owed_undriven finding's default age threshold.
  DEFAULT_OWED_THRESHOLD_MS,
  // #715 (b) (02 §D.1, Amendment 7): every kind, the kinds that never select a run for --stuck, and
  // the stamped-ahead finding on its own.
  RUN_HEALTH_KINDS,
  RUN_HEALTH_STUCK_EXCLUDED,
  recordStampedAheadOf,
} from './engine/run-health.js';
export type { RunHealthFinding } from './engine/run-health.js';
export {
  computeGateDueState,
  reminderScheduleOf,
  reminderScheduleWords,
  REMINDER_BASIS_CLAUSE,
  // #597 D1a: may a reminder or the escalation go out, and is a reminder the final one.
  isFinalReminder,
  reminderEligibility,
} from './engine/gate-timing.js';
export type { ReminderSchedule, ReminderOccurrence } from './engine/gate-timing.js';
// #597 D3a: one place for "which reminder is due": the question post's anchor and the whole grid.
export { dueReminderWork, reminderAnchorOf, SAME_LINE_WINDOW_MS } from './engine/reminder-due.js';
export type { ReminderItem, ReminderSettings } from './engine/reminder-due.js';
// issue #729 PR-0 (D4 P-8, A-15): the one parser of stored instants and the one due test of a
// stored deadline; ε, the one clock-skew constant.
export {
  readInstant,
  parseStamp,
  isPastDeadline,
  overdueOf,
  recordStampedAheadSentence,
  CLOCK_SKEW_EPSILON_MS,
  INSTANT_CLASSES,
} from './engine/instants.js';
export type { InstantClass, InstantReading } from './engine/instants.js';
// issue #715 (a) (D5 §1.1, §2.1; D6-3, D6-4, D6-6, D6-7, D6-14, D6-35): the clock a run store holds,
// the one place a store takes its reading for a write, and the per-key floor on that reading.
export {
  createSystemClock,
  systemClock,
  markTestClock,
  clockBasis,
  setClockErrorSink,
  clockErrorSink,
  CLOCK_READ_CLASSES,
  type ClockReadClass,
} from './utils/clock.js';
export type { Clock } from './utils/clock.js';
// #715 (b) (D-17): a read's raw reading (taken BEFORE the load) and the floor by a record's own stamp.
// #616 PR-1a unit 2: `foldReading`, the pure second half of `takeReading`.
export {
  takeReading,
  takeRawReading,
  floorAtRecord,
  floorAtHolder,
  foldReading,
} from './store/take-reading.js';
// #616 PR-1a unit 2: the key-holder ordering and the version conflict every run store shares.
export { compareCanonical, pickCanonical, versionConflictError } from './store/key-holder.js';
export type { KeyHolderFields } from './store/key-holder.js';
// #616 PR-1a unit 6: the SQLite store's schema, as data (the store package creates a file from it).
export {
  REALM_STORE_SCHEMA,
  REALM_STORE_SCHEMA_VERSION,
  REALM_STORE_APPLICATION_ID,
  REALM_STORE_PAGE_SIZE,
  WRITE_ONCE_RUN_FIELDS,
} from './store/store-schema.js';
export type { WriteOnceRunField } from './store/store-schema.js';
// #616 PR-1a unit 6c: every schema version the store knows, and the step into each (the ladder runs them).
export { REALM_STORE_VERSIONS } from './store/store-schema-versions.js';
export type { StoreSchemaVersion, StoreSchemaVersions } from './store/store-schema-versions.js';
// issue #715 (a) (D6-1, D6-54): a test location's clock file. For `@sensigo/realm-testing`, not for
// hosts: a lint rule (static imports) and a source scan (the names as text, in any import form;
// `lint-test-location-715.test.ts`; it reads the `.ts` and `.mjs` files of the four packages' `src`
// folders and skips `*.test.ts`) keep `writeTestClockFile`, `fileClock` and `readTestClockFile` out
// of production code (D6-52); the file store's own `resolveStoreClock` is the one reader. #616 PR-1a
// unit 2: `resolveRootClock`, the same read for a store's root folder, kept out the same way.
export {
  TEST_CLOCK_FILE_NAME,
  testClockFilePath,
  writeTestClockFile,
  readTestClockFile,
  fileClock,
  resolveRootClock,
} from './store/test-clock-file.js';
// #715 (b) (02 §C.1, D6-53): whether a store's clock is a test location's — for the hosts, which say
// so once per process on stderr.
export { isTestLocationClock } from './store/test-clock-file.js';
// #715 (b) (02 §C.3, D6-53): a store at a test location says so once per process, on its first read.
export { withTestClockNotice, testClockNoticeLine } from './store/test-clock-notice.js';
// issue #616 PR-2a (i): realm's home (`~/.realm`), the one place that asks the system for it.
export { realmHomePath } from './store/realm-home.js';
// Gap 1, unit B: the reader of a stored `model_text` for `realm run inspect --verbose`, beside the
// step-view composer and never part of it (its views reach get_run_state; the texts must not).
export { evidenceModelTextView, failureModelTextView } from './engine/model-text-view.js';
export type {
  ModelTextView,
  ModelTextMessageView,
  ModelTextToolListView,
  ModelTextRequestView,
  ModelTextRequestCheck,
  ModelTextCheckOutcome,
  ModelTextMark,
} from './engine/model-text-view.js';
// issue #600 PR 1b: one cost view per step, derived once and rendered by inspect + get_run_state.
export {
  composeCostView,
  composeStepViews,
  composeDriveFailureCosts,
  composeRunCost,
  COST_UNRECORDED_CAUSES,
  isAnswerEntry,
  // Q1 (#592) d1b correction 1: every reason a cache miss's provider can give (beside the cache
  // misses' other lists, CACHE_MISS_CAUSES and CACHE_MISS_RULES).
  PROVIDER_MISS_REASONS,
} from './engine/step-view.js';
export type {
  CostFigure,
  CostView,
  CostModels,
  CostCacheRequested,
  CacheRequestedEntry,
  CostEndpoints,
  CostCacheHead,
  CostCacheFieldsRefused,
  CostMiss,
  CostUnrecordedCause,
  AttemptView,
  AnswerView,
  StepView,
  DriveFailureCost,
  Money,
  MoneySource,
  MoneySourceTotal,
  RunCost,
} from './engine/step-view.js';
// Q1 (#592) unit b: a run's failures, read from the record — one composer, shown by get_run_state's
// `failures[]` and by `realm run inspect` under `Failed:`.
export { composeFailures, composeFailureOfEntry } from './engine/failure-view.js';
// Q1 (#592) d1b: the words a failure's `unknown` and `absent` can hold.
export { FAILURE_UNKNOWN_WORDS, FAILURE_ABSENT_CAUSES } from './engine/failure-view.js';
export type { FailureView } from './engine/failure-view.js';
// caching 3-M A-2b1: the words a cost view's misses carry (the functions stay inside core).
export {
  CACHE_MISS_CAUSES,
  CACHE_LIFETIME_SOURCES,
  // Q1 (#592) d1b: the rule a request is judged by (the list existed, on no entry), and where its
  // predecessor is.
  CACHE_MISS_RULES,
  PREDECESSOR_FROM_WORDS,
} from './engine/cache-misses.js';
export type {
  CacheMissCause,
  CacheMissRule,
  CachePredecessorPlace,
  CacheLifetimeSource,
} from './engine/cache-misses.js';
// issue #600 caching PR P: the runner's economics file (format v1), its evaluator, and the port a
// host prices through — money is derived at read, never stored.
export {
  CACHE_ECONOMICS_JSON_SCHEMA,
  parseCacheEconomics,
  priceFromEconomics,
  selectEconomicsRates,
  matchModel,
  minCacheableTokensFor,
} from './economics/cache-economics.js';
export type {
  CacheEconomics,
  CacheEconomicsModel,
  CacheEconomicsPrice,
  CacheEconomicsRates,
  CacheEconomicsTier,
} from './economics/cache-economics.js';
// issue #600 caching PR 5: at admission, each agent step's fixed part — its size, what it shares,
// and whether it can cache against a stated minimum.
export {
  cacheVerdict,
  describeCacheability,
  isSizeBlock,
  DEFAULT_CHARS_PER_TOKEN_HIGH,
  DEFAULT_CHARS_PER_TOKEN_LOW,
} from './economics/cacheability.js';
export type {
  CacheBlock,
  CacheSizeBlock,
  CacheLayoutBlock,
  CacheBlockSegment,
  CacheVerdict,
  CacheNotJudgedCause,
  CacheabilityStepInput,
  CacheabilityOptions,
  CacheShare,
  CacheabilityStep,
} from './economics/cacheability.js';
export {
  NOT_PRICED_CAUSES,
  priceRequest,
  // Q1 (#592) d1b: every class of source a priced request can name.
  PRICE_SOURCE_CLASSES,
} from './economics/price-source.js';
export type {
  NotPricedCause,
  PriceInput,
  PriceResult,
  PriceSource,
  PriceUsage,
  PricedBy,
} from './economics/price-source.js';
export type { GateDueState } from './engine/gate-timing.js';
export {
  requirementForStep,
  unmetCapabilities,
  findCapabilityBlockedSteps,
  capabilityWarning,
  // #872 (a): the one spelling of a capability refusal (correction 1, C2: its home is this leaf).
  capabilityRefusalWords,
} from './engine/capability.js';
export type { Requirement, CapabilityBlockInfo } from './engine/capability.js';
export {
  evaluatePrecondition,
  checkPreconditions,
  evaluateAllPreconditions,
  preconditionHint,
  preconditionRefusal,
} from './engine/precondition.js';
export type { PreconditionResult } from './engine/precondition.js';
export type { StepDiagnostics } from './types/run-record.js';
// issue #600 PR 1a (D4): CACHE_STATES/CACHE_BASES/CacheState/CacheBasis/UsageRecord/StepCacheDetail
// are already re-exported here via the top-of-file `export * from './types/run-record.js'` — the
// wildcard is the export; this comment exists so a reader checking D4's requirement finds it. Issue
// #600 PR 2's vocabularies — PROMPT_CACHE_SETTINGS, CACHE_REQUESTS, CACHE_REQUEST_SOURCES,
// REQUEST_ENDPOINTS, REQUEST_FACT_ABSENT_CAUSES and their types — and the lifetime unit's
// CACHE_AUTO_BASES are re-exported the same way, beside CACHE_STATES; so is CACHE_REQUESTERS, the
// runners' words in `cache_requested_by`, beside CACHE_REQUESTS.
// issue #600 (the lifetime unit): which cache lifetime `--prompt-cache auto` asks for — pure. Issue
// #898: priced from the runner's price file (`chooseAutoLifetime`), else the owner's fallback.
export {
  AUTO_GAPS_KEPT,
  AUTO_LIFETIME_MARGIN,
  CACHE_GAP_MAX_S,
  chooseCacheLifetime,
  chooseAutoLifetime,
  chooseAutoOneLifetime,
  keptCacheGaps,
  normalizeCacheAuto,
  stepCacheGaps,
} from './economics/cache-lifetime.js';
export type {
  CacheTier,
  CacheTiers,
  CacheChoice,
  CacheLifetimes,
  AutoPriceInput,
} from './economics/cache-lifetime.js';
export { VERSION } from './version.js';
// The release mark (issue #620 PR-B): every class a realm package exports carries one, so copies of
// the same release recognise each other's objects.
export { RELEASE_LINE_KEY, createRealmBrand, brandClass, REALM_BRAND } from './brand.js';
export type { RealmBrand } from './brand.js';
// Which copy an object came from (issue #620 PR-C): the descriptions and refusals realm prints when
// an object crosses realm versions, and the release-line check on every store a host hands realm.
export {
  releaseLineOf,
  declareReleaseLine,
  describeUnrecognised,
  assertReleaseLine,
  assertRegistryLine,
  releaseLineError,
  describeThrown,
  describeForeignProvider,
  unbrandedClause,
  describeUnrecognisedForContract,
  engineReleaseLine,
  releaseLineAdvisoryMessage,
} from './release-line.js';
export type { Unrecognised, RealmClass, ReleaseLineFacts } from './release-line.js';
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
export { codeTextOf } from './extensions/code-text.js';
export { createDefaultRegistry } from './extensions/default-registry.js';
export {
  BUILT_IN_REQUIREMENTS,
  isBuiltInRequirement,
  // #828 unit 2b: whether an entry replaces a built-in, the one rule (the CLI loader reads it in unit 4).
  replacesBuiltIn,
} from './extensions/built-in-requirements.js';
// #828 unit 2b: where a registry entry's code came from.
export type { CodeSource, ProjectSource } from './types/code-source.js';
export type { ExtensionManifest, ExtensionModuleRef } from './extensions/manifest.js';
export {
  validateDeploymentManifest,
  parseDeploymentManifest,
  collectManifestSecretRefs,
  manifestSecretsBlockHash,
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
  ExtensionIdentityLockfile,
  ExtensionIdentityModule,
  ExtensionIdentityTree,
  ExtensionIdentitySignals,
} from './types/extension-identity.js';
export {
  extensionIdentityDiffers,
  // #828 unit 1 (PR B): the lockfile's comparison, for the drift readers' words.
  extensionLockfileDiffers,
  // #729 PR-3 correction 5 (J-5): the creators' start entry and the drift readers' baseline.
  startIdentityEntry,
  lastExecutionIdentity,
} from './types/extension-identity.js';

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
export {
  validateInputSchema,
  validateRunParams,
  isStrictModeRefusal,
  describeSchemaFailure,
  composeSchemaFailure,
  renderAuthoredValue,
  knownSchemaKeywords,
  compileSchema,
  validateOutputSchema,
  validateAgentSubmission,
  isAsyncSchemaRefusal,
  asyncSchemaValidity,
} from './validation/input-schema.js';
export type {
  RawValidationError,
  AgentSubmissionValidation,
  SchemaFailure,
} from './validation/input-schema.js';
// issue #759: a refused answer names every problem — one list, one cap, one count, two renderings.
export {
  VALIDATION_PROBLEMS_SHOWN,
  describeValidationProblems,
  renderMore,
  renderProblemsSentence,
  renderProblemsLines,
  validationListOf,
  whitelistValidationRow,
} from './validation/validation-problems.js';
export type {
  ValidationProblem,
  ValidationProblems,
  FieldWords,
} from './validation/validation-problems.js';

// Workflow
export {
  loadWorkflowFromFile,
  loadWorkflowFromString,
  loadWorkflowFromFileWithDiagnostics,
  loadWorkflowFromStringWithDiagnostics,
  resolveAgentProfiles,
  findTrustRoot,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  SCHEMA_KEY_CONSEQUENCE,
  DEFAULT_GATE_CHOICES,
  gateChoicesOf,
} from './workflow/yaml-loader.js';
export { JsonWorkflowStore } from './workflow/registrar.js';
export type { WorkflowRegistrar } from './workflow/registrar.js';
export { getWorkflowForRun, definitionAbsenceOf } from './workflow/registrar.js';
// #616 PR-2c c5a: the registry's diagnostic listing — its entry arms, the one function the hosts list
// a registrar through, and the id arm's entry builder (the SQLite registry's).
export { listWorkflowsDiagnosed, unreadableById } from './workflow/registrar.js';
export type {
  // #616 PR-2c c5b: the capped read's answer, and the registrar type Realm's homes carry.
  CappedRead,
  RealmWorkflowRegistrar,
  RegistryListing,
  UnreadableRegistryEntry,
  UnreadableFileEntry,
  UnreadableIdEntry,
  FileUnreadableClass,
  IdUnreadableClass,
} from './workflow/registrar.js';
// #616 B2: the one judge of a registered copy, and the refusals of a copy that has no file, with the
// words a copy with a file gets.
export {
  classifyRegisteredCopy,
  workflowNotFoundError,
  legacyCopyError,
  newerCopyError,
  storedCopyFaultError,
} from './workflow/registrar.js';
export type { RegisteredCopyVerdict, DamagedCopyFault } from './workflow/registrar.js';
// issue #729 PR-0: the skeleton of an input schema — the MCP renderer's `call_with` for a step's way.
export { generateSchemaSkeleton } from './utils/schema-skeleton.js';
// issue #729 PR-0 (E1 (b), (d)): the ONE escaped, bounded value renderer — a value read from a run or
// stored text from elsewhere, printed as one line with no terminal escape (the doors use it).
export { escapedBoundedValue } from './utils/redaction.js';
// Q1 (#592) d1b: the receipt's states and causes, as lists.
export { DECLARED_STATES, DECLARED_CAUSES, ENVIRONMENT_STATES } from './utils/redaction.js';
// #729 PR-3: the disclosure law — one law for every exit, applied at the door (RECORD 01 #1–#8).
export {
  REDACTED_MARKER,
  NOT_CHECKED_MARKER,
  LIVE_CLAIM_MARKER,
  REDACTED_EMAIL_MARKER,
  DISCLOSURE_FLOORS,
  NOT_SECRET_ENV,
  REALM_SETTING_VARIABLES,
  REALM_CREDENTIAL_VARIABLES,
  notKeptMarker,
  boundWhole,
  // #872 (b1): the one bounded renderer of a name or a reason an MCP reply echoes (500 characters).
  capText,
  tierFor,
  compileDisclosure,
  emptyDisclosureSet,
  buildDisclosureSet,
  environmentEntries,
  notSecretNames,
  notSecretIntersection,
  weakestDeclared,
  withDeclaredStanding,
  unmaskableWarning,
  isCredentialName,
  disclose,
  discloseSplit,
  discloseSplitSize,
  markersIn,
  inboundMarkerWarning,
} from './utils/redaction.js';
// Caching 3-B (A5, D4.6-12): the describer's one narrow way to a step's rendered prompt and its
// stable boundary; `renderTemplate` and `loadWorkflowContext` stay off this index.
export { renderStepPromptWithBoundary } from './engine/step-prompt-boundary.js';
export type { StableBoundary } from './engine/render-template.js';
// #872 (b1) correction 1 (H1): the one producer of a bounded list in words.
export { listWords, quotedNames, NAMES_SHOWN } from './utils/list-words.js';
export type {
  DisclosureAudience,
  DisclosureTier,
  DeclaredState,
  DeclaredCause,
  EnvironmentState,
  EnvironmentCause,
  DisclosureEntry,
  DisclosureSet,
  DeclaredStanding,
  HiddenCounts,
  Disclosed,
  DisclosedSplit,
  DisclosedSplitSize,
} from './utils/redaction.js';
export {
  discloseByTable,
  discloseLeaf,
  discloseValue,
  disclosureReceipt,
  shapeOf,
  CYCLE_SHAPE,
  DISCLOSURE_MAX_DEPTH,
  WITHHELD_WORDS,
  withheldCauseOf,
  withheldQuestion,
  // Q1 (#592) d1b: every word a receipt's `question` can hold.
  DISCLOSURE_QUESTIONS,
} from './utils/disclosure-walk.js';
export type {
  DisclosureClass,
  NestedClass,
  MapClass,
  ChosenClass,
  ClassTable,
  DisclosureTally,
  WalkOptions,
  WithheldCause,
  DisclosureReceipt,
  FactProducer,
  FactProducers,
  KeysOfUnion,
} from './utils/disclosure-walk.js';
export {
  PENDING_GATE_TABLE,
  GATE_INFO_TABLE,
  RUN_RECORD_TABLE,
  FIXED_TERMINAL_REASONS,
  TERMINAL_REASON_ROW,
  EVIDENCE_TABLE,
  STEP_DIAGNOSTICS_TABLE,
  USAGE_RECORD_TABLE,
  OUTBOUND_VIEW_TABLE,
  CALLBACK_VIEW_TABLE,
  discloseGate,
  discloseRecord,
  discloseReply,
} from './utils/disclosure-tables.js';
export type { ShownGate } from './utils/disclosure-tables.js';
// #729 PR-4: the ONE question composer — minted once at gate open (stripped, masked, then cut to the
// view budget under a complete set), composed at read over PR-3's disclosed gate — the digest of the
// frozen view, and the asked person's notice with its one duration producer.
export {
  composeQuestionView,
  mintQuestionView,
  viewDigest,
  VIEW_BUDGET,
  CUT_SENTENCE,
  endsWithCutSentence,
  renderDisplay,
  displayPaths,
  stripSpanMarks,
} from './engine/question-view.js';
export type { QuestionView } from './engine/question-view.js';
export { composePersonNotice, durationWords } from './engine/person-notice.js';
// #603 A3a: the one rule of who may answer a question (the settling write and the Slack door).
export { judgeAnswerer } from './engine/answerer.js';
export type { AnswererQuestion, AnswererVerdict } from './engine/answerer.js';
export type { PersonNotice, PersonNoticeEvent } from './engine/person-notice.js';
// decision C183 (issue #760, correction H2): the ONE spelling of a control character a terminal line
// shows — the CLI's printers and the `check_quotes` warning share it.
export { controlEscape } from './utils/redaction.js';
// issue #558 PR-T — the classification table, its builders and the listing cap. The CLI's
// `--stuck` probe closure mints the SAME errors `get()` does, so a corrupt or unreadable copy
// speaks with one voice on every surface.
export {
  probeClassToError,
  parseFailureError,
  probeClassOf,
  repairActFor,
  // #819 follow-up 2 (R2): the way on at a gate whose workflow cannot be read (04 §5)
  gateRepairOf,
  PROBE_FAILURE_CLASSES,
  STUCK_DEFINITION_PARSE_CAP_BYTES,
} from './workflow/registrar.js';
export type {
  ProbeResult,
  ProbeFailureClass,
  WorkflowCopyParseFault,
} from './workflow/registrar.js';
export {
  GUARD_PROHIBITED_STEP_KEYS,
  FINALIZER_PROHIBITED_STEP_KEYS,
} from './workflow/yaml-loader.js';

// Step-key consumption registry (issue #417 PR-2; #517 the drive-flip — the two loop-pattern
// exports are gone with the loops themselves, replaced by the mint surface)
export {
  STEP_KEY_REGISTRY,
  TRACKED_RESIDUALS,
  MINT_WITNESS_PATTERN,
  CONSUMED_HOME,
  SURFACE_NAME,
  prohibitedKeysFor,
  consumedKindsFor,
  normalizeSource,
  countWitnessMatches,
} from './workflow/step-key-registry.js';
export type {
  StepKeyCell,
  StepKeyVia,
  StepKeyWitness,
  ConsumedHome,
} from './workflow/step-key-registry.js';

// Diagnostics — structured loader-warning channel (issue #169)
export {
  DEFAULT_POLICY,
  resolveSeverity,
  findUnknownKeys,
  renderLoaderWarning,
  EXTENSION_KEY_PREFIX,
  RESERVED_EXTENSION_PREFIX,
  isExtensionKey,
} from './workflow/diagnostics.js';
export type { WarningCode, LoaderWarning } from './workflow/diagnostics.js';
// fix 1, unit 1: the `input_map` paths `validate` lists as not checked (its `--json` `not_checked`).
export type { LoaderNote, NotCheckedPath } from './workflow/input-map-paths.js';
export type { NotCheckedWhy } from './workflow/path-resolver.js';

// Structured output eligibility — the L0 prevention layer (issue #236)
export {
  assessStructuredOutputEligibility,
  renderIneligibleMessage,
  STRICT_SUPPORTED_KEYWORDS,
} from './workflow/structured-output-eligibility.js';
export type {
  StructuredOutputVerdict,
  StructuredOutputReason,
  StructuredOutputCaveat,
} from './workflow/structured-output-eligibility.js';

// Handler primitives
export { resolveResource } from './handlers/primitives/resolve-resource.js';
export { walkField } from './handlers/primitives/walk-field.js';
export { partitionBySubstring } from './handlers/primitives/partition-by-substring.js';
export { countResults } from './handlers/primitives/count-results.js';
export { compareStrings } from './handlers/primitives/compare-strings.js';
export {
  locateQuote,
  QUOTE_STATES,
  DEFAULT_MIN_PART_CHARS,
  MIN_PART_CHARS_LEAST,
} from './handlers/primitives/locate-quote.js';
export type { QuoteCheck, QuoteState, QuoteSpan } from './handlers/primitives/locate-quote.js';

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
export { normalizeEntryForBuffer } from './engine/trace-normalizer.js';
export {
  InMemoryTraceBufferStore,
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

// The trace buffer's fence as data (issue #616 PR-0)
export type {
  FencePredicate,
  FencePredicateKind,
  StepScopedFencePredicate,
  RunScopedFencePredicate,
  FenceRunReader,
  StepEligibilityState,
  StepMembershipState,
} from './store/fence-predicate.js';
export {
  FENCE_PREDICATE_KINDS,
  FENCE_REQUIRES_RUN,
  FENCE_TARGETS_STEP,
  isStepScopedFence,
  assertFencePredicate,
  evaluateFence,
  readRunForFence,
  checkFenceWithReader,
  isFenceRunReader,
  fenceReaderMissingError,
  stepStateOf,
  stepNotEligibleError,
  runNotFoundError,
  ReclaimVersionChanged,
  noLongerTerminalReason,
} from './store/fence-predicate.js';
// #627 W (§5.9): the separation check's evidence, typed once (the CLI measures it).
export {
  SEPARATION_MODES,
  SEPARATION_BASES,
  SEPARATION_CONDITIONS,
  PREVENTS_CONDITIONS,
  separationModeOf,
  separationPrevents,
  separationGaps,
  valueMeasuredWithheld,
  // #790 (D13, D14, D11): the ways to the service user, read; condition 2; the claim's clauses.
  SWITCH_PATHS,
  SWITCH_OUTCOMES,
  SWITCH_WHOSE,
  SWITCH_CACHES,
  mostPermissive,
  switchPathsCondition,
  switchClausesOf,
} from './engine/separation.js';
export type {
  SeparationMode,
  SeparationBasis,
  SeparationCondition,
  ConditionReading,
  SeparationEvidence,
  SeparationGap,
  SwitchPath,
  SwitchOutcome,
  SwitchWhose,
  SwitchCache,
  SwitchPathReading,
  SwitchClause,
} from './engine/separation.js';
// #627 W (§5.1, §5.2b): the MCP door's two process settings, judged once (the server and the bins).
export {
  judgeGateAnswers,
  judgeFormWait,
  formWaitInert,
  alsoSetClause,
  GATE_ANSWERS_ENV,
  FORM_WAIT_ENV,
  FORM_WAIT_SECONDS_DEFAULT,
  FORM_WAIT_SECONDS_MIN,
  FORM_WAIT_SECONDS_MAX,
} from './engine/gate-answers-setting.js';
export type {
  GateAnswersSetting,
  GateAnswersInput,
  FormWaitSetting,
  FormWaitInput,
} from './engine/gate-answers-setting.js';
// Gap 2, unit (iv-b1): the MCP door's failure-text setting, judged once (the server and the bins),
// and a run's failure words as get_run_state shows them under `hidden`.
export {
  judgeFailureText,
  FAILURE_TEXT_ENV,
  FAILURE_TEXT_VALUES,
} from './engine/failure-text-setting.js';
export type {
  FailureText,
  FailureTextSetting,
  FailureTextInput,
} from './engine/failure-text-setting.js';
export {
  failureTextShape,
  terminalReasonHidingFailureText,
  abortMessageHidingFailureText,
  // Gap 2, unit (iv-b2a): the reader of core's failure-text mark on an engine reply.
  failureTextMarkOf,
  // Gap 2, unit (iv-b2b): the mark on a thrown error that is a failure's words (the CLI loader's),
  // Realm's own providers, and the one rule the MCP door applies to a provider's throw.
  noteFailureWords,
  carriesFailureWords,
  noteRealmProvider,
  isFailureWordsThrow,
} from './engine/failure-text.js';
export type { FailureTextMark } from './engine/failure-text.js';

// CP-W: the deprecation channel's data — the table, its validator, the line, and the ids said in
// this process. Data only; the CLI and the MCP server print.
export {
  DEPRECATIONS,
  validateDeprecations,
  deprecationLine,
  markSaid,
  saidIds,
  seedSaid,
} from './deprecations/deprecations.js';
export type { DeprecationEntry } from './deprecations/deprecations.js';

// CP-1 PR 1: the types public declarations reference that were not exported (a user could not name
// them), and the two the public set brings in: each is tagged `@public` at its declaration.
export { KIND } from './utils/redaction.js';
export type { MemberKind } from './utils/redaction.js';
export { STORED_FILE_CLASSES } from './store/run-file.js';
export type { Base } from './engine/ways.js';
export type { ClassifiableRun } from './engine/eligibility.js';
export type { ClassifyRunHealthOptions } from './engine/run-health.js';
export type { DeclaredNames } from './workflow/name-check.js';
export type {
  ExpireGateDelta,
  OpenGateDelta,
  ReleaseStepDelta,
  SettleGateDelta,
  SettleGuardDelta,
} from './types/settlement.js';
export type { RateLimiter } from './adapters/rate-limiter.js';
export type { RunRecordFieldProblem } from './types/run-record-shape.js';
export type { StepMeta } from './engine/execution-loop.js';
export type { StepScopedKind } from './store/fence-predicate.js';
