// run-agent.ts — Core agent loop logic, decoupled from the Commander handler for testability.
// Exports runAgent(), AgentDeps, AgentRunOptions, and AgentRunResult.
// All Slack-specific gate notification logic lives in slack-gate-notifier.ts.
import { join } from 'node:path';
import { constants as osConstants } from 'node:os';
import {
  loadWorkflowFromFile,
  executeChain,
  advanceRun,
  executeEngineStep,
  describePending,
  stepsThatCannotRun,
  cannotGoOnHere,
  describeClaimHolder,
  composeWaysAt,
  sentenceEnd,
  deriveRunPhase as derivePhaseOf,
  findCapabilityBlockedSteps,
  unmetCapabilities,
  capabilityWarning,
  buildFailedAttemptRecord,
  WorkflowError,
  DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
  assessStructuredOutputEligibility,
  renderIneligibleMessage,
  pendingCleanupLine,
  classifyStop,
  isRaceStop,
  judgedSnapshotOf,
  leaseFactOf,
  type NotRecordedKind,
  type RunStore,
  type WorkflowDefinition,
  type StepDefinition,
  type PendingGate,
  type EvidenceSnapshot,
  composeQuestionView,
  discloseGate,
  renderDisplay,
  displayPaths,
  stripSpanMarks,
  type DisclosureAudience,
  type QuestionView,
  markersIn,
  inboundMarkerWarning,
  discloseValue,
  type ExtensionRegistry,
  type McpServerConfig,
  type ToolCallRecord,
  type TraceBufferStore,
  type StructuredOutputMeta,
  moreOf,
  renderProblemsLines,
  validationListOf,
  persistsField,
  startIdentityEntry,
  takeBackStep,
  automaticTakebacksOf,
  AUTOMATIC_TAKEBACKS_PER_STEP,
  claimStepForDrive,
  releaseDriveClaim,
  type LeaseHold,
  closeModelAttempts,
} from '@sensigo/realm';
import type {
  RunRecord,
  WorkflowRegistrar,
  UsageRecord,
  Attributed,
  DriveFailureRecord,
  ErrorCategory,
  EngineReply,
  Snapshot,
} from '@sensigo/realm';
import type { EarlierRuns } from './earlier-runs.js';
import type { StepCacheChoices } from './step-cache-choices.js';
import type { LlmProvider } from './providers/llm-provider.js';
import {
  sanitizeError,
  discloseForAgent,
  discloseForAgentSplit,
  setAdditionalRedactionValues,
  deriveLlmClock,
  safeErrorText,
  safeExplainFailure,
  appendRequests,
  attachRecordedReference,
  type RecordedPredecessor,
  mintRequestIds,
  agentDisclosureSet,
  type LlmClock,
  deriveRetryCap,
  makeModelRetryPolicy,
  modelAttemptsOf,
  tryModelRequest,
  type ModelRetryPolicy,
  decideModelFailure,
  type ModelFailureMember,
} from './providers/agent-utils.js';
import {
  appendModelTexts,
  carriedTexts,
  failureModelTextOf,
  joinFailedCall,
  joinModelTexts,
  modelTextOf,
  type StepModelTexts,
} from './providers/model-text.js';
import { isToolCapable } from './providers/llm-provider.js';
import type { McpClient, ToolDefinition, ToolExecutor } from './mcp/mcp-extensions.js';
import { McpClient as McpClientImpl } from './mcp/mcp-client.js';
import { scheduleGateExpiryTimer } from './gate/gate-expiry-timer.js';
import {
  cannotRunClause,
  cannotRunEntries,
  cannotRunWayOut,
  cliCommandOf,
  heldEntriesOf,
  stopReasons,
  writerHost,
} from '../commands/ways-renderer.js';
import {
  PLAIN,
  RUN_PHASE_WORDS,
  exitProcess,
  questionSpan,
  recordWalk,
  stdoutAudience,
  writerCtx,
  writerMode,
  writerSetFor,
} from '../output/writer.js';
import {
  cutWayLine,
  questionDeadlineLine,
  terminalRespondLines,
  viewSetFor,
} from '../lib/holder-render.js';
import {
  recordDriveFailure,
  buildEntry,
  MESSAGE_CAP,
  stampRequestProvider,
} from './drive-failure.js';
import { promptCacheStartLine, type ResolvedPromptCache } from './prompt-cache.js';
import { terminalRunRefusal } from './run-attach.js';
import {
  answerNotRecordedLine,
  describeProgram,
  goOnLine,
  inFlightLine,
  NO_SNAPSHOT,
  noDriverTakeBackLine,
  outcomeNotRecordedLine,
  takeBackAtCapLine,
  takenBackLine,
  takeBackAnswer,
  takenBackNotLandedLine,
  takenBackNotRunLine,
  takenFirstLine,
  endedWhileHeldLine,
  giveBackLine,
  giveBackThrownLine,
  leaseUnavailableLine,
  type GiveBackCause,
  takenLine,
  waitingLine,
  resumeLine,
} from '../lib/holder-render.js';

export type AgentRunResult = 'completed' | 'failed';

/** issue #625 PR-2a (D6.2): how often the loop re-reads a run whose only work is in flight elsewhere. */
export const IN_FLIGHT_POLL_MS = 1000;
/** issue #625 PR-2a (D6.2): how long the loop watches an unchanged record before naming reclaim. */
export const IN_FLIGHT_WATCH_MS = 60000;

/**
 * issue #401 chokepoint 4's wedge record for a validation rejection — ONE mint, used by the
 * dispositions and by the drive's exit for an engine step refused on its input before its claim
 * (issue #625 PR-2a, decision C31), so the two can never record the wedge differently.
 */
function validationWedgeEntry(
  step: string,
  provider: string,
  errors: readonly string[],
  attemptStartedAt: number,
  // #715 (b) (02 §D.2; census class `event`): the run store's clock, read by the caller.
  at: Date,
): DriveFailureRecord {
  return {
    at: at.toISOString(),
    step,
    provider,
    error_class: 'validation_rejected',
    message: sanitizeError(errors.join(', ')).slice(0, MESSAGE_CAP),
    elapsed_ms: Math.max(0, Math.round(performance.now() - attemptStartedAt)),
  };
}

/**
 * #715 (b) (04 §A, census class `outside`): a failed-attempt record's own stamp — a log line's
 * time, read from the host's clock and compared with nothing on the run record. Its own function, so
 * the class law (no `outside` read in a function that reads a run's instants) holds by construction.
 */
function sidecarStamp(): string {
  return new Date().toISOString();
}

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Caching 3-M (piece A-1b): the first request of the last call in a stored list of requests — the
 *  list's last plain object with a string `request_start` and `request_in_call` 0; `undefined` when
 *  the list holds none (a list recorded before `request_in_call` existed holds none). */
function lastCallOpenerIn(requests: unknown): UsageRecord | undefined {
  if (!Array.isArray(requests)) return undefined;
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    const entry: unknown = requests[i];
    if (
      isRecordObject(entry) &&
      typeof entry['request_start'] === 'string' &&
      entry['request_in_call'] === 0
    ) {
      return entry as unknown as UsageRecord;
    }
  }
  return undefined;
}

/** Caching 3-M (piece C3): a step's recorded request, and the agent profile's hash on the evidence
 *  entry that held it. A request found on a `drive_failures` entry has no hash: that entry holds none. */
export interface RecordedRequest {
  readonly request: UsageRecord;
  readonly agent_profile_hash?: string;
}

/**
 * Caching 3-M (piece A-1) — the first request of `step`'s last call on the record it is given (piece
 * A-1b; no store read): the predecessor of the step's first request in a drive
 * (`attachRecordedReference`), on this run's record or, piece C2, on an earlier run's. Two candidates:
 * the last call's first
 * request in the step's latest evidence entry whose `diagnostics.cache.requests` holds one (a plain
 * object with a string `request_start` and `request_in_call` 0; index `e` in `evidence`), and the
 * same for the step's latest drive-failure entry and its `usage`. An entry whose list holds none
 * (recorded before `request_in_call` existed) is not a candidate. They are ordered by the record's
 * own order, never by clocks: the failure is the later one when its `evidence_count` (the run's
 * evidence count, read in the write that appended it) is greater than `e`. A drive-failure entry
 * without `evidence_count` (written before #715 (b)) is not a candidate. Entries that are not plain
 * objects are skipped; it never throws. Piece C3: the answer also holds the `agent_profile_hash` of
 * the evidence entry that held the request, read off that entry and no other.
 */
export function lastRecordedRequest(
  run: RunRecord | undefined,
  step: string,
): RecordedRequest | undefined {
  if (!isRecordObject(run)) return undefined;
  let fromEvidence: RecordedRequest | undefined;
  let evidenceIndex = -1;
  const evidence: unknown = run.evidence;
  if (Array.isArray(evidence)) {
    for (let i = evidence.length - 1; i >= 0; i -= 1) {
      const entry: unknown = evidence[i];
      if (!isRecordObject(entry) || entry['step_id'] !== step) continue;
      const diagnostics = entry['diagnostics'];
      const cache = isRecordObject(diagnostics) ? diagnostics['cache'] : undefined;
      const opener = lastCallOpenerIn(isRecordObject(cache) ? cache['requests'] : undefined);
      if (opener === undefined) continue;
      const hash = entry['agent_profile_hash'];
      fromEvidence = {
        request: opener,
        ...(typeof hash === 'string' ? { agent_profile_hash: hash } : {}),
      };
      evidenceIndex = i;
      break;
    }
  }
  let fromFailure: RecordedRequest | undefined;
  let failureCount = -1;
  const failures: unknown = isRecordObject(run.drive_failures)
    ? run.drive_failures.entries
    : undefined;
  if (Array.isArray(failures)) {
    for (let i = failures.length - 1; i >= 0; i -= 1) {
      const entry: unknown = failures[i];
      if (!isRecordObject(entry) || entry['step'] !== step) continue;
      const count = entry['evidence_count'];
      if (typeof count !== 'number') continue;
      const opener = lastCallOpenerIn(entry['usage']);
      if (opener === undefined) continue;
      fromFailure = { request: opener };
      failureCount = count;
      break;
    }
  }
  if (fromFailure === undefined) return fromEvidence;
  if (fromEvidence === undefined) return fromFailure;
  return failureCount > evidenceIndex ? fromFailure : fromEvidence;
}

export interface AgentDeps {
  store: RunStore;
  /**
   * Caching 3-M (piece C2): what `realm agent` read of the workflow's earlier runs before the drive.
   * Absent: no read was made or it failed, and no step's first request gets a copy from another run.
   */
  earlierRuns?: EarlierRuns;
  /**
   * Caching 3-M (piece D-2): under `auto`, each agent step's cache choice for this drive, chosen by
   * `realm agent` before it (`chooseStepCaches`). Every call of a step passes its choice, repair
   * attempts included. Absent, or a step it does not name: the call carries none (`CallCacheChoice`).
   */
  stepCacheChoices?: StepCacheChoices;
  workflowStore: WorkflowRegistrar;
  provider: LlmProvider;
  /**
   * Issue #313: the provenance identity for a third-party `--provider-module` provider, which
   * cannot declare a `providerId` capability of its own. Typed as the template literal so the
   * evidence field's union (which includes `module:${string}`) typechecks end-to-end with no
   * casts. In-repo providers leave this unset — their own capabilities() answer wins.
   */
  providerId?: `module:${string}`;
  registry: ExtensionRegistry;
  /**
   * When set, called for every pending gate. The handler is responsible for notifying
   * the relevant channel and blocking until the gate resolves.
   * Omit for terminal-only fallback (choices printed to terminal + store polling).
   */
  /**
   * #625 A1b-2 (the one-note rule): it resolves to `true` when it printed a line that says how the
   * run ended (its own answer's ending, a late answer's, its own timer's), so the drive's `Ended:`
   * line does not say it again.
   */
  gateHandler?: (runId: string, gate: PendingGate) => Promise<boolean | void>;
  /**
   * Factory for creating an McpClient instance. Injected by tests for mock isolation.
   * Defaults to constructing a real McpClient when absent.
   */
  mcpClientFactory?: (servers: McpServerConfig[], signal?: AbortSignal) => McpClient;
  /**
   * REAL manifest-secret VALUES (values only, from the loaded extensions result) fed to
   * the provider-loop redaction pass — dotenv-sourced values are absent from process.env
   * and would otherwise pass tool results/traces unredacted. Never persisted.
   */
  redactionValues?: readonly string[];
  /**
   * Trace-buffer WAL store (issue #207 PR-2, D3 §5) — threaded straight into every `executeChain`
   * call below. Without this, `realm agent`'s driver never adopted/fenced a step's streamed
   * `append_trace` WAL content at all (the mixed-wiring gap D3 identifies: CLI executors passed
   * no `traceBufferStore`, so acknowledged appends were neither adopted nor refused when a CLI
   * runner settled). Opened in `agent.ts` from the home, beside the run store. Optional so
   * an existing caller that omits it keeps today's behavior exactly (no trace adoption at all).
   */
  traceBufferStore?: TraceBufferStore;
  /**
   * #729 CW-5a: the folder the store's lease port keeps its claim leases in (`claimLeasesFolder` of
   * the home, from `@sensigo/realm-store-sqlite`), named when a lease cannot be taken there. Optional:
   * without it the line names no folder.
   */
  leaseFolder?: string;
  /**
   * Issue #625 (the holder slice): the program this driver runs in — its name, how that name is
   * known, and its channel (`agent`). Written as `holder` on the claim of every step the driver
   * takes, as `driven_by` on those steps' evidence, and on the cleanup steps its timer drains. A
   * label for people and replies; never compared. Absent ⇒ none recorded.
   */
  driver?: Attributed;
  /**
   * Mint a FRESH `writer_nonce` (UUIDv4) per step-attempt (issue #197 PR-2) — resolved once in
   * `agent.ts` from `--mint-writer-nonce` OR'd with the `REALM_REQUIRE_WRITER_NONCE` strict-flip
   * (design §8: the strict posture force-enables minting even without the flag). Default `false`/
   * absent ⇒ today's byte-identical ⊥ (bare) behavior. Never a caller-fixed value — a fresh
   * `crypto.randomUUID()` is minted independently for EVERY step-attempt in the loop below.
   */
  mintWriterNonce?: boolean;
  /**
   * Budget for issue #217's in-drive schema-feedback repair loop: how many times the drive
   * re-prompts an `execution: 'agent'` step after its output/input is rejected by
   * output_schema/input_schema validation, appending the validator's errors to the prompt.
   * Threaded exactly like `mintWriterNonce` above (agent.ts's `--schema-retries` flag → both
   * runAgent call sites → this field). Default `2` when omitted (mirrors the CLI flag's own
   * default) — `0` disables the loop entirely, reproducing today's single-attempt behavior
   * byte-for-byte.
   */
  schemaRetries?: number;
  /**
   * issue #401 — the fallback per-ATTEMPT ceiling for model requests, in seconds. Threaded from
   * `realm agent --llm-timeout` through both runAgent call sites. A step's own
   * `llm_timeout_seconds` WINS; this fills in for every step that did not author one (the
   * `--schema-retries` precedent). Absent ⇒ 600 (ten minutes), which is what the SDKs already
   * used as their own default request timeout — so the default drive behaves as it did, except
   * that the bound is now realm's, is attributed when it fires, and covers retries too.
   */
  llmTimeoutSeconds?: number;
  /**
   * Issue #676 — the flags this drive was started with (the model flags, `--extensions-module`,
   * `--project`, a non-default `--schema-retries`, `--llm-timeout`, `--mint-writer-nonce`; see
   * `buildReattachFlags`), already quoted for a shell. The in-drive "re-attach" line repeats them,
   * so following it continues the same drive: realm has no default model, and a step blocked on a
   * missing handler is usually fixed through `--extensions-module`. Set by `realm agent`. Absent (a
   * host that calls `runAgent` itself) ⇒ the line prints `--provider <provider> --model <model>`
   * for the operator to fill in.
   */
  reattachFlags?: string;
  /**
   * Issue #600 PR 2 — the caching setting `realm agent` resolved for this drive (`--prompt-cache`,
   * or the runner's default), with where it came from and which runner chose it. The provider was
   * built with the same setting; this copy is what the drive's start line names. Absent for a
   * `--provider-module` run and for a host that calls `runAgent` itself: the start line then says
   * what the provider asks for without saying where the setting came from.
   */
  promptCache?: ResolvedPromptCache;
  /**
   * Gap 1, unit A1: whether each model call's text is kept on the step's evidence entry. `false`
   * (`--no-record-model-text`) keeps none, and the entry says recording was switched off. Absent ⇒
   * kept.
   */
  recordModelText?: boolean;
}

/**
 * Dormant strict posture (issue #197 PR-2, design §6 — the #169→#170 template): read PER CALL,
 * never cached at module load (a test flips the env var mid-process). "on" = set to any
 * non-empty value other than `'0'`/`'false'`. A strict-flip force-enables minting even without
 * `--mint-writer-nonce` (design §8).
 */
function shouldMintWriterNonce(deps: Pick<AgentDeps, 'mintWriterNonce'>): boolean {
  const v = process.env['REALM_REQUIRE_WRITER_NONCE'];
  const required = v !== undefined && v !== '' && v !== '0' && v !== 'false';
  return deps.mintWriterNonce === true || required;
}

/**
 * decision C189: whether this drive's own engine call for the agent step `step` recorded the drive's
 * answer — read off that call's reply, on every reply branch, never off the line the drive prints:
 * - a reply that a step the engine ran AFTER `step` produced (`stopped_step` names another step:
 *   `step`'s own call returned `ok`, so it settled) — a question that step opened, a step that cannot
 *   run here, a refusal or failure of that step;
 * - the question the answer opened on `step` itself (`confirm_required` carrying the answer's own
 *   evidence entry: the write that opens the gate records it), or an `ok` reply carrying evidence;
 * and never: an `ok` or `confirm_required` reply with no evidence (the run had ended, `step` was
 * already settled, or another call's question was already open: nothing was written), nor a refusal
 * or failure of `step` itself. An `error` that names no step (an error of the chain itself) says
 * nothing about `step`, and is not counted; the drive stops on it with exit code 1 and prints no
 * `Result` line, the one reader of the answer.
 *
 * @internal Exported for testing only.
 */
export function answerRecordedByCall(
  reply: Pick<EngineReply, 'status' | 'evidence' | 'stopped_step'>,
  step: string,
): boolean {
  if (reply.stopped_step !== undefined && reply.stopped_step !== step) return true;
  return (
    (reply.status === 'ok' || reply.status === 'confirm_required') && reply.evidence.length > 0
  );
}

export interface AgentRunOptions {
  /** Path to workflow.yaml file. Required when definition is not provided. */
  workflowPath?: string;
  /** Inline workflow definition — bypasses loadWorkflowFromFile when provided. */
  definition?: WorkflowDefinition;
  /**
   * Attach to an existing run instead of creating a new one.
   * When set, runAgent() skips deps.store.create() and uses this ID directly.
   * Mutually exclusive with workflowPath — runAgent() throws if both are set.
   */
  existingRunId?: string;
  params: Record<string, unknown>;
  /** Poll interval in ms for the terminal-only fallback. Defaults to 3000. Lower values are useful in tests. */
  pollIntervalMs?: number;
  /**
   * issue #625 PR-2a (D6.2): with nothing eligible and a step in flight, the loop re-reads the
   * record every `inFlightPollMs` (default {@link IN_FLIGHT_POLL_MS}) and re-enters on any change;
   * after `inFlightWatchMs` (default {@link IN_FLIGHT_WATCH_MS}) with no change it names the
   * reclaim command and exits. Injectable for tests.
   */
  inFlightPollMs?: number;
  inFlightWatchMs?: number;
  /**
   * When true, persist the workflow definition to ~/.realm/workflows/ so that
   * `realm run inspect` and `realm run list` can resolve it by ID.
   * Defaults to false — realm agent does not register workflows as a side effect.
   */
  register?: boolean;
}

/**
 * #729 PR-3 correction 3 (C3): the preview's fields a display template renders — each `{{ path }}`'s
 * value at its path, in fresh objects (the stored preview is never written). A path under another
 * rendered path is that path's already. Fix 1, piece 3b: the paths are core's `displayPaths`, the
 * placeholders `renderDisplay` renders, so a filtered placeholder's field is projected by its path.
 */
function displayedFields(
  template: string,
  preview: Record<string, unknown>,
): Record<string, unknown> {
  const paths = displayPaths(template);
  const covered = (path: string[]): boolean =>
    paths.some((other) => other.length < path.length && other.every((part, i) => part === path[i]));
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    if (covered(path)) continue;
    let value: unknown = preview;
    for (const part of path) {
      value =
        typeof value === 'object' && value !== null && Object.hasOwn(value, part)
          ? (value as Record<string, unknown>)[part]
          : undefined;
    }
    if (value === undefined) continue;
    let at = out;
    for (const part of path.slice(0, -1)) {
      const next = Object.hasOwn(at, part) ? at[part] : undefined;
      if (typeof next !== 'object' || next === null) {
        const fresh: Record<string, unknown> = {};
        Object.defineProperty(at, part, { value: fresh, enumerable: true, writable: true });
        at = fresh;
      } else at = next as Record<string, unknown>;
    }
    Object.defineProperty(at, path.at(-1)!, { value, enumerable: true, writable: true });
  }
  return out;
}

/**
 * #729 PR-4 (03 #6): the gate as this drive's print shows it, composed by core's ONE composer. The gate
 * is projected to the fields the print shows (C3) — the question when it has one, the preview (with a
 * `display`, only the fields it renders), the facts the composer reads (`opened_at` keeps the gate's
 * own table) — then disclosed ONCE for this stream's audience (a broadcast in log mode), the walk's
 * hides and shapes joining the drive's `Disclosure:` line (F10). Nothing the print leaves out is
 * walked or counted.
 */
function gateViewForPrint(gate: PendingGate, display?: string): QuestionView {
  const audience = printAudience();
  const printed: PendingGate = {
    gate_id: gate.gate_id,
    step_name: gate.step_name,
    choices: gate.choices,
    opened_at: gate.opened_at,
    preview: display !== undefined ? displayedFields(display, gate.preview) : gate.preview,
    ...(gate.resolved_message !== undefined ? { resolved_message: gate.resolved_message } : {}),
  };
  return composeQuestionView(
    discloseGate(stripSpanMarks(printed), viewSetFor(audience), audience, { onTally: recordWalk }),
    display,
  );
}

/** The audience this drive's prints are shown to: a broadcast in log mode; else stdout's. */
function printAudience(): DisclosureAudience {
  return writerMode() === 'broadcast' ? 'broadcast' : (stdoutAudience() ?? 'private');
}

/**
 * #729 PR-3; fix 1, piece 3b: a step's output as this drive's result line shows it — disclosed for
 * the print's audience in every writer mode (its shapes in log mode), as the gate print does. So
 * `display` values are masked before any filter runs; the walk's hides and shapes join the
 * drive's tally.
 */
function outputForLog(output: Record<string, unknown>): Record<string, unknown> {
  const audience = printAudience();
  const walked = discloseValue(stripSpanMarks(output), viewSetFor(audience), audience);
  recordWalk(walked.tally);
  return walked.value as Record<string, unknown>;
}

/**
 * Formats a step output object as human-readable plain text for the terminal.
 * Renders `headline` and `message` string fields directly; falls back to JSON.
 */
function formatOutputForTerminal(output: Record<string, unknown>): string {
  const headline = typeof output['headline'] === 'string' ? output['headline'] : undefined;
  const message = typeof output['message'] === 'string' ? output['message'] : undefined;

  if (headline !== undefined || message !== undefined) {
    const parts: string[] = [];
    if (headline !== undefined) parts.push(headline);
    if (message !== undefined) parts.push(message);
    return parts.join('\n\n');
  }

  if (Object.keys(output).length === 0) {
    return '(no output)';
  }

  return JSON.stringify(output, null, 2);
}

async function pollUntilGateResolved(
  store: RunStore,
  runId: string,
  gateId: string,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  console.log('   Waiting for approval...');
  for (;;) {
    if (signal?.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      if (signal !== undefined) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }
    });
    if (signal?.aborted) break;
    const { record: run } = await store.get(runId);
    if (run.terminal_state) break;
    if (run.pending_gate === undefined || run.pending_gate.gate_id !== gateId) break;
  }
}

/**
 * Gap 2, unit (ii-b2), Words 6b: the line for a call that failed the step through `modelFailure` and
 * that the engine refused (its store failed at the save): the failure is not on the record, so this
 * drive wrote it as a drive failure.
 */
function memberNotSettledLine(
  step: string,
  reply: { error_code?: string | undefined; errors: readonly string[] },
): string {
  return `• Step '${step}': the engine did not record its failure (${reply.error_code}: ${reply.errors.join(', ')}); this drive recorded it as a drive failure.`;
}

/**
 * Gap 2, unit (ii-b2): which outcome sentence a reply that recorded no failure for `step` takes, read
 * from the record as core's classifier reads a settle race: another program holds the step, it
 * settled, the run ended, or the claim was removed.
 */
function notRecordedKindOf(record: RunRecord, step: string): NotRecordedKind {
  const ended = record.terminal_state === true;
  if (!ended && record.in_progress_steps.includes(step)) return 'held_elsewhere';
  if (record.completed_steps.includes(step) || record.failed_steps.includes(step))
    return 'step_settled';
  return ended ? 'run_ended' : 'claim_removed';
}

/**
 * Runs a workflow to completion using the provided dependencies.
 * Returns 'completed' when the run finishes normally; 'failed' otherwise.
 * Throws on setup failures (e.g. workflow file not found, provider error).
 */
export async function runAgent(deps: AgentDeps, options: AgentRunOptions): Promise<AgentRunResult> {
  if (options.existingRunId !== undefined && options.workflowPath !== undefined) {
    throw new Error('existingRunId and workflowPath are mutually exclusive');
  }

  // Manifest-secret redaction (values only, set ONCE per run): tool results and
  // tool-execution errors serialized by the provider loop get these values masked
  // alongside process.env values.
  setAdditionalRedactionValues(deps.redactionValues ?? []);

  // issue #217: resolved once per run (not per call, unlike shouldMintWriterNonce — there is no
  // env-var strict-flip counterpart here). `0` disables the repair loop entirely.
  const schemaRetries = deps.schemaRetries ?? 2;

  // issue #401 — the per-ATTEMPT ceiling in seconds, before the per-step key overrides it.
  // 600s is the SDKs' own default request timeout, so an unconfigured drive keeps today's
  // per-attempt patience; what changes is that the bound is realm's, it also covers the SDK's
  // internal retries, and a fired bound says which lever to raise.
  const fallbackLlmTimeoutSeconds = deps.llmTimeoutSeconds ?? 600;

  // issue #236 — sticky downgrade (design §4 [Rv8]): per step, homed HERE (run-agent scope,
  // beside the verdict) — survives BOTH remaining loops (the provider ladder ⊂ the #217 repair
  // loop; the 2-attempt callStep wrapper that used to sit between them was retired by issue #401,
  // because silently retrying is what made a failing drive invisible). Once armed for a step,
  // every LATER attempt for that SAME
  // step name (across repair iterations, across a re-attach) never re-sends strict — it goes
  // straight to the ORIGINAL downgrade_reason/api_message. Never cleared for the run's lifetime
  // (R-Q: a non-grammar 503 disables prevention for the whole drive session — accepted, the
  // `service_unavailable` labeling makes it auditable).
  const structuredOutputSticky = new Map<
    string,
    {
      downgrade_reason: NonNullable<StructuredOutputMeta['downgrade_reason']>;
      api_message?: string;
    }
  >();

  // issue #311 — the TOOL-ARGUMENTS sticky map. Deliberately PARALLEL to (never merged with)
  // `structuredOutputSticky` above: the two dimensions fail independently, and merging them would
  // let a step-output downgrade silently disable tool-args strict (or vice versa). Nothing reads
  // this map except the tools path, and nothing reads that map except the non-tools path.
  //
  // Same key (step name) and same invocation scope. The ARMING RULE differs by design (D3 §5,
  // the named R10 divergence from #236's accepted R-Q residual): only a 400
  // (`api_rejected_schema`) arms this map, because a rejected schema will be rejected identically
  // on every later attempt — retrying it is pure waste. A 503 does NOT arm it: overload is
  // transient, and letting it disable tool-args strict for the rest of the drive session would
  // trade a momentary blip for a session-long silent capability loss.
  const toolArgsSticky = new Map<string, { reason: string; api_message?: string }>();

  // issue #313 — read the provider's capabilities ONCE for the whole drive (they are constant
  // per instance) and derive the three facts every dimension needs from them.
  const caps = deps.provider.capabilities();
  // Evidence provenance: the drive's own word. For a third-party module agent.ts supplies
  // `module:<basename>`, and it wins over any `providerId` the module declares, so a module's word
  // never names (or prices) its requests; an in-repo provider has none and names itself. Undefined
  // only if neither applies.
  const providerForEvidence = deps.providerId ?? caps.providerId;
  // Which provider's strict RULES to assess schemas against. Module providers fall to the
  // Anthropic profile — realm cannot know a module's dialect — and a module's declared `providerId`
  // still picks the profile (`openai` → OpenAI's rules) but no longer appears on its records, which
  // read `module:<file>`.
  const profile = caps.providerId === 'openai' ? ('openai' as const) : ('anthropic' as const);
  // issue #313 (D-3 precedence rule 1): the endpoint gate is only MEANINGFUL for a provider that
  // could otherwise place the marker on the wire. A gate on a non-consuming provider says nothing
  // extra — `provider_unsupported` is already the whole truth there — so it is resolved to
  // undefined rather than allowed to compete with that literal.
  // Does this provider actually place per-tool strict on the wire? Read from the same one-shot
  // `caps` as the rest of the drive-level facts (issue #350's guard; hoisted here in #313 so the
  // gate below can be derived from it — same value, one read instead of one per step). Both
  // in-repo tool-capable providers declare it; third-party modules do not.
  const strictCapable = caps.toolArgsStrict === true;
  const gate = strictCapable ? caps.strictGate : undefined;

  // Load or use provided definition.
  const definition: WorkflowDefinition =
    options.definition !== undefined
      ? options.definition
      : loadWorkflowFromFile(
          options.workflowPath!.endsWith('.yaml') || options.workflowPath!.endsWith('.yml')
            ? options.workflowPath!
            : join(options.workflowPath!, 'workflow.yaml'),
        );

  // Register only when explicitly requested (--register flag).
  // By default realm agent does not write to ~/.realm/workflows/ as a side effect.
  if (options.register === true) {
    await deps.workflowStore.register(definition);
  }

  let runId: string;
  // #729 CW-1b part 2: the snapshot the drive holds, with its lease facts. Unset until the first
  // read, and tested by `currentSnap === undefined` below: the attach path always sets it, and
  // keying the moved re-read on the value rather than on the option keeps control-flow analysis
  // satisfied. `currentRun` and `currentAt` are set only through `hold`, which refreshes both.
  let currentSnap!: Snapshot;
  let currentRun!: RunRecord;
  // #715 (b) (D6-17, D6-19): the reading `currentRun` was read at — every judgement of it is made at
  // that instant, never at a fresh clock read.
  let currentAt!: Date;
  const hold = (next: Snapshot): void => {
    currentSnap = next;
    currentRun = next.record;
    currentAt = next.at;
  };
  // decision C179: the agent steps this drive answered — the `Result` line names the program that
  // gave any other answer. Decision C189: filled from each engine call's reply (`answerRecordedByCall`).
  const answeredHere = new Set<string>();
  // decision C179: the drive stopped on a step another process holds (the 60s watch ended unchanged,
  // or, #729 CW-5b, every step it watched is one only a person can free, at the take-back cap).
  let stoppedOnInFlight = false;

  if (options.existingRunId !== undefined) {
    // --run-id path: attach to existing run
    hold(await deps.store.get(options.existingRunId));
    if (currentRun.terminal_state) {
      // issue #279 (increment 1, PR-B), design record §6: point at the recovery verb when the
      // terminal run this attach targeted still carries an undelivered finalizer — the one mint
      // `resolveRunAttach` throws too.
      throw terminalRunRefusal(options.existingRunId, currentRun);
    }
    runId = options.existingRunId;
    // in_progress_steps on attach: handled by engine's existing eligibility logic — no restart needed
  } else {
    // Normal path: create new run
    const { record: initialRecord } = await deps.store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: options.params,
      // #729 PR-3 correction 5 (J-5): the run is born with this program's identity, the manifest
      // reference included (a never-executed run still names its manifest).
      ...(startIdentityEntry(deps.registry) !== undefined &&
      persistsField(deps.store, 'extension_identity')
        ? { extensionIdentity: [startIdentityEntry(deps.registry)!] }
        : {}),
    });
    runId = initialRecord.id;
  }

  // ═══ issue #401, CHOKEPOINT (3) — the last-resort catch opens HERE ═══
  //
  // It opens the moment `runId` exists and not before: everything above is pre-run, so a throw
  // there has no record to attach itself to and the console is the only honest floor. Everything
  // BELOW is a failed drive attempt on a real run, and every one of them used to vanish.
  //
  // The MCP-init block moved inside deliberately — its unknown-server and tool-incapable throws
  // are exactly the "run created, then died before any step ran" case that read healthy for 24
  // hours.
  let currentStepName: string | undefined;
  // issue #600: at FUNCTION scope so the last-resort catch below can see what the current step
  // billed. Both are reset where each step begins (inside the step loop). `stepUsageSaved` turns
  // true only once the step's repair loop has ended — `executeChain` returned for its final
  // attempt — so from then on the step's calls live on its record and are never attached twice.
  let usageForStep: UsageRecord[] | undefined;
  // Gap 1, unit A1: the texts of the step's calls, gathered where `usageForStep` gathers their usage.
  let textsForStep: StepModelTexts | undefined;
  // Gap 2, unit (i-b): the current step's retry policy, which records its failed model tries
  // (`undefined` for a step without `retry`); reset where each step begins.
  let retryForStep: ModelRetryPolicy | undefined;
  // Gap 2, unit (i-b), Words 2: the steps whose `retry` this drive has said it cannot apply.
  const retryNotApplied = new Set<string>();
  // Gap 2, unit (i-b): the step's failed tries as an entry keeps them, closed as the evidence entry's
  // are; `undefined` when it recorded none (a step without `retry` records none).
  const triesOf = (policy: ModelRetryPolicy | undefined) => {
    const tries = policy === undefined ? [] : modelAttemptsOf(policy);
    return tries.length > 0 ? closeModelAttempts(tries) : undefined;
  };
  // Gap 1, unit A2b: a drive-failure entry's `model_text`, from the texts of exactly the requests
  // its usage lists (and any unanswered one): `undefined` when no model request belongs to it.
  const failureText = (texts: StepModelTexts | undefined) =>
    failureModelTextOf(texts, deps.recordModelText !== false);
  // Gap 1, unit A2b: at a provider-call catch, the failing call's texts (joined to `callUsage`, the
  // call's own requests on the entry, their ids minted there) after the step's earlier calls, which
  // ride along whenever their usage does (`usageForStep` non-empty). A call that carries no texts
  // is a module provider's (`provider_did_not_report`) once the provider was called, and no model
  // request at all before (an MCP start, a tool-name refusal).
  const failedCallTexts = (
    err: unknown,
    callUsage: readonly UsageRecord[] | undefined,
    providerCalled: boolean,
  ): StepModelTexts | undefined => {
    const carried = carriedTexts(err);
    const call: StepModelTexts | undefined =
      carried !== undefined
        ? joinFailedCall(callUsage ?? [], carried)
        : providerCalled
          ? { reported: false }
          : undefined;
    const earlier =
      usageForStep !== undefined && usageForStep.length > 0 ? textsForStep : undefined;
    if (earlier === undefined) return call;
    return call === undefined ? earlier : appendModelTexts(earlier, call);
  };
  let stepUsageSaved = false;
  // #600: whether the driven step's calls are ALREADY on its record. Chokepoints 3 and 4 attach
  // `usageForStep` to a drive-failure entry; when the failure belongs to a step `executeChain` ran
  // AFTER the driven step saved, those calls are already on that step's evidence, and attaching them
  // again would count them twice. Keyed on the RECORD'S CONTENT (the step's first billed request
  // appearing on one of its entries), never on a count or a version: the step's own claim moves the
  // version while its calls stay unsaved, and other writers add entries for the step that carry none
  // of its calls (a reclaim's audit line, a compensating un-claim, another driver's save). The part
  // of the content compared is the request's own identity (#715 (R), D6-28): the `request_id` realm
  // minted with the request and stored with it — never its start time and token counts, which two
  // different requests can share. Absent on either side ⇒ not the same request: a stored record
  // without the id was written by an earlier process, so it is never this process's in-memory
  // request, and there is no fallback to the old content rule. A failed re-read answers `false`, so
  // the calls are attached: the store is failing, and the entry likely will not land.
  const sameRequest = (a: UsageRecord, b: UsageRecord): boolean =>
    a.request_id !== undefined && b.request_id !== undefined && a.request_id === b.request_id;
  const callsAlreadyRecorded = async (
    step: string,
    calls: readonly UsageRecord[],
  ): Promise<boolean> => {
    const first = calls[0];
    if (first === undefined) return false;
    return deps.store.get(runId).then(
      ({ record: r }) =>
        r.evidence.some(
          (e) =>
            e.step_id === step &&
            (e.diagnostics?.cache?.requests ?? []).some((q) => sameRequest(q, first)),
        ),
      () => false,
    );
  };
  // Caching 3-M (piece A-1): the predecessor of the driven step's first request in this drive, with
  // where it was found — the first request of the step's last call on the run's record (piece A-1b),
  // read from `currentRun` as held at that moment (no store read; at a step's first call it is the
  // snapshot the engine judged its last reply on); when the record holds none, piece C2, the latest
  // of the step's requests read from the workflow's earlier runs before the drive. Consulted only
  // while the step holds no request of this drive (`usageForStep` empty). Piece C3: with the two
  // agent-profile hashes the copy compares, the earlier one from the entry that held the request.
  const recordedBefore = (step: string): RecordedPredecessor | undefined => {
    if (usageForStep !== undefined && usageForStep.length > 0) return undefined;
    const own = lastRecordedRequest(currentRun, step);
    const found = own ?? deps.earlierRuns?.get(step)?.[0];
    if (found === undefined) return undefined;
    const profile = definition.steps[step]?.agent_profile;
    const current =
      profile !== undefined ? definition.resolved_profiles?.[profile]?.content_hash : undefined;
    return {
      request: found.request,
      from: own !== undefined ? 'run' : 'earlier_run',
      ...(found.agent_profile_hash !== undefined
        ? { earlier_profile_hash: found.agent_profile_hash }
        : {}),
      ...(current !== undefined ? { current_profile_hash: current } : {}),
    };
  };
  // decision C205: a drive that stops on a run that ended with a failed step `realm run resume`
  // takes gives the way back in — the line `realm workflow run` gives (`  Resume:    …`).
  // decision C211 (walk c14 W3-4's class): and cleanup steps the ending left pending — the command
  // that runs them.
  // #715 (b) (D6-17, Amendment 4): judged on the snapshot the drive holds when it stops — the one the
  // engine judged its last reply on, or the drive's own last read — never a second load. None (a
  // reply that loaded no run): no line about the record.
  // #625 A1b-2 (the owner's one-note rule): "have I already printed how this run ended?" — set by
  // every line this drive prints that says it (the `✗` line of the step that ended the run, the ⏰
  // line of the timer whose write ended it, the ⚠ line of an `on_expiry: abort` this drive's call
  // carried out, the gate handler's lines for its own answer). The stop's `Ended:` line says the
  // ending only while it is unset.
  let endingSaid = false;
  const printResumeLine = (endedSnap: Snapshot | undefined): void => {
    const ended = endedSnap?.record;
    // #729 PR-3 (L-2): the writer's context only inside the print call.
    if (ended !== undefined && resumeLine(ended, definition, PLAIN, endingSaid) !== undefined) {
      console.error(resumeLine(ended, definition, writerCtx(), endingSaid));
      // #729 CW-5a: its `Ended:` line said how an ended run ended.
      if (ended.terminal_state === true) endingSaid = true;
    }
    const cleanup =
      endedSnap === undefined ? undefined : pendingCleanupLine(endedSnap.record, endedSnap.at);
    if (cleanup !== undefined) console.error(cleanup);
  };
  // #715 (b) (D6-17, Amendment 4): the lines this drive prints after an engine call are judged on the
  // snapshot the engine judged its reply on — it REPLACES the held snapshot; the run is never read
  // again for them. A reply that carries none loaded no run or could not write it (always an error
  // reply): `false`, and the caller says the engine's own words and stops.
  /** #729 CW-5a: a reply whose claim this drive gave back, and the record the give-back answered. */
  let gaveBackFor: { reply: EngineReply; snapshot: Snapshot } | undefined = undefined;
  const judgedOf = (reply: EngineReply): Snapshot | undefined =>
    gaveBackFor?.reply === reply ? gaveBackFor.snapshot : judgedSnapshotOf(reply);
  const holdJudged = (reply: EngineReply): boolean => {
    const judged = judgedOf(reply);
    if (judged === undefined) return false;
    hold(judged);
    return true;
  };
  const stopOnEngineWords = (reply: EngineReply): 'failed' => {
    console.error(`\n✗ ${reply.errors.join(', ') || reply.context_hint}`);
    return 'failed';
  };
  // issue #715 (a) (D6-23): a start mark on the monotonic clock — only ever subtracted from another,
  // so a wall-clock step cannot shorten or lengthen a recorded `elapsed_ms`.
  let attemptStartedAt = performance.now();
  // #729 CW-5b: the held entry of `step` on `snap`, for the lines that end with what frees it.
  const heldEntryAt = (snap: Snapshot, step: string) =>
    heldEntriesOf(
      composeWaysAt(snap.record, snap.at, {
        definition,
        registry: deps.registry,
        persistsClaims: deps.store.persistsClaims === true,
        lease_facts: snap.lease_facts,
      }),
    ).find((e) => e.facts.step === step);
  // #729 CW-5a: the agent step this drive holds under a lease while its model and tools run (one at
  // a time), and why it gives the claim back if it stops without saving the step.
  let held: { step: string; hold: LeaseHold; cause: GiveBackCause } | undefined = undefined;
  /** The give-back of the hold now open, shared by the signal handler and the `finally`. */
  let givingBack: Promise<Snapshot | undefined> | undefined = undefined;
  /** The signal that stopped the drive, recorded before any await; from then on it ends by it. */
  let stopCause: NodeJS.Signals | undefined = undefined;
  /**
   * The held step's own save in flight, which a signal waits for: settled once that save is done (the
   * chain's first callback, or `executeChain`'s return), never waiting for the steps the chain runs
   * after it (correction 1).
   */
  let saving: Promise<void> | undefined = undefined;
  let endSave: () => void = () => {};
  /** Correction 1: how long a signal waits for that save, inside the relay's 10 s SIGKILL. */
  const SAVE_WAIT_MS = 5_000;
  /** CW-5b's line (i), per step, until this drive's claim of that step answers. */
  const pendingTakeBack = new Map<string, ReturnType<typeof describeClaimHolder>>();
  /** A claim refused on the record's version: a second refusal there stops the drive (C85's bound). */
  let lastRefusal: { step: string; version: number } | undefined = undefined;
  const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  /**
   * A drive failure's entry (#401), except once a signal stopped the drive: its give-back says why.
   * Q1 (#592) unit c: what the write did is returned, and ignored here.
   */
  const recordFailure = (entry: Parameters<typeof recordDriveFailure>[2]): Promise<unknown> =>
    stopCause === undefined ? recordDriveFailure(deps.store, runId, entry) : Promise.resolve();
  const namesHeldLease = (record: RunRecord, h: NonNullable<typeof held>): boolean =>
    record.in_progress_steps.includes(h.step) && record.claims?.[h.step]?.lease?.id === h.hold.id;
  /** A snapshot whose record no longer has this drive's claim on `step`: judged as no program's. */
  const withoutOwnClaim = (snap: Snapshot, step: string): Snapshot => {
    const { [step]: _own, ...others } = snap.record.claims ?? {};
    return {
      ...snap,
      record: {
        ...snap.record,
        in_progress_steps: snap.record.in_progress_steps.filter((s) => s !== step),
        claims: others,
      },
    };
  };
  /** Closes the hold, with the newest record (its file is kept while that record names it). */
  const closeHold = (record: RunRecord | undefined): void => {
    const h = held;
    if (h === undefined) return;
    held = undefined;
    for (const signal of SIGNALS) process.removeListener(signal, onSignal);
    h.hold.close(record);
  };
  /**
   * Gives the held step's claim back by the record (`releaseDriveClaim` reads the run itself), closes
   * the hold with the record it answers, and says what happened — once per hold.
   */
  const giveBack = (): Promise<Snapshot | undefined> => {
    const h = held;
    if (givingBack !== undefined || h === undefined)
      return givingBack ?? Promise.resolve(undefined);
    givingBack = (async () => {
      let answer: Awaited<ReturnType<typeof releaseDriveClaim>>;
      try {
        answer = await releaseDriveClaim(deps.store, runId, h.step, { definition, hold: h.hold });
      } catch (err) {
        // The claim stays, its lease held by no program once this drive ends.
        closeHold(undefined);
        const reason = err instanceof WorkflowError ? err.code : 'the store failed';
        const atCap =
          automaticTakebacksOf(currentRun, h.step).automatic >= AUTOMATIC_TAKEBACKS_PER_STEP;
        const fresh = atCap ? await deps.store.get(runId).catch(() => undefined) : undefined;
        console.log(
          giveBackThrownLine(
            h.step,
            reason,
            atCap
              ? { held: fresh !== undefined ? heldEntryAt(fresh, h.step) : undefined, runId }
              : undefined,
            writerCtx(),
          ),
        );
        return undefined;
      }
      const record = answer.snapshot.record;
      closeHold(record);
      if (answer.kind === 'released') {
        console.log(giveBackLine(h.step, { kind: 'released', cause: stopCause ?? h.cause }));
      } else if (
        answer.kind === 'not_ours' &&
        (record.completed_steps.includes(h.step) || record.failed_steps.includes(h.step))
      ) {
        // The step has a settled entry (this drive's save, which a signal waited for, or another
        // program's): nothing was given back, and nothing is said.
      } else if (record.terminal_state === true) {
        // Item 3: nothing can be written to an ended run; its ending is said once on this screen.
        if (!endingSaid) console.log(endedWhileHeldLine(h.step, record, writerCtx()));
        endingSaid = true;
      } else {
        const newest = record.evidence.filter((e) => e.step_id === h.step).at(-1);
        const byReclaim =
          answer.kind === 'not_ours' && newest?.output_summary?.['reclaimed'] === true;
        console.log(giveBackLine(h.step, { kind: 'removed', byReclaim }));
      }
      return answer.snapshot;
    })();
    return givingBack;
  };
  /** After a stop cause: the main flow waits for the give-back, then for the handler to end it. */
  const halt = async (): Promise<never> => {
    await givingBack;
    return new Promise<never>(() => {
      setInterval(() => {}, 1 << 30);
    });
  };
  /** Removes the drive's listeners and dies by `signal`, as the relay does. */
  const raiseAgain = (signal: NodeJS.Signals): void => {
    for (const s of SIGNALS) process.removeListener(s, onSignal);
    process.kill(process.pid, signal);
    // Reached only if the signal did not end this process.
    setTimeout(() => exitProcess(128 + (osConstants.signals[signal] ?? 0)), 1000);
  };
  /**
   * SIGINT, SIGTERM, SIGHUP while the drive holds a step: give the claim back by the record (after the
   * held step's own save in flight, at most SAVE_WAIT_MS), then die by the same signal, so a shell
   * sees it. A second signal of the same kind ends the drive at once, with no give-back: the claim
   * then keeps a lease no program holds, which the next drive takes back once.
   */
  function onSignal(signal: NodeJS.Signals): void {
    if (stopCause !== undefined) {
      if (signal === stopCause) raiseAgain(signal);
      return;
    }
    stopCause = signal;
    void (async () => {
      const inFlight = saving;
      if (inFlight !== undefined) {
        let bound: NodeJS.Timeout | undefined;
        await Promise.race([
          inFlight,
          new Promise<void>((resolve) => (bound = setTimeout(resolve, SAVE_WAIT_MS))),
        ]);
        clearTimeout(bound);
      }
      // `releaseDriveClaim` reads the run: a step its save settled gives nothing back, and no line.
      await giveBack();
      raiseAgain(signal);
    })();
  }
  try {
    if (currentSnap === undefined) {
      hold(await deps.store.get(runId));

      // #134 pre-flight (WARN-only, never refuse): warn at CREATE only. The attach path (--run-id)
      // above is N-A — it re-drives an EXISTING run, where recoverable-settle + the A5 surfaces
      // already handle a capability block. `deps.registry` is always a real registry, so the
      // `?? createDefaultRegistry()` invariant holds structurally.
      for (const req of unmetCapabilities(definition, deps.registry)) {
        console.warn(`⚠ ${capabilityWarning(req)}`);
      }
    }

    console.log(`\nRealm Agent — ${definition.name} v${definition.version}`);
    console.log(`Run ID: ${runId}`);
    // issue #600 PR 2 (D1): what this drive asks the provider to cache, and why.
    console.log(
      promptCacheStartLine({
        caps,
        promptCache: deps.promptCache,
        moduleProviderId: deps.providerId,
        definition,
      }),
    );
    console.log('');

    // Initialise MCP client if any steps declare tools.
    let mcpClient: McpClient | undefined;
    if (definition.mcp_servers !== undefined && definition.mcp_servers.length > 0) {
      const serverIds = new Set(definition.mcp_servers.map((s) => s.id));
      for (const step of Object.values(definition.steps)) {
        for (const toolEntry of step.tools ?? []) {
          const serverId = toolEntry.split(':')[0] ?? '';
          if (!serverIds.has(serverId)) {
            throw new Error(`Step tool '${toolEntry}' references unknown MCP server '${serverId}'`);
          }
        }
      }
      mcpClient = (deps.mcpClientFactory ?? ((s, sig) => new McpClientImpl(s, sig)))(
        definition.mcp_servers,
        undefined, // AbortSignal not threaded into runAgent — disconnect() is in finally
      );
      if (!isToolCapable(deps.provider)) {
        throw new Error(
          'This workflow uses MCP tool-enabled steps, but the configured LLM provider does not support tool calling. ' +
            'Reasoning models (o1-series) and custom non-tool providers cannot run tool-enabled steps. ' +
            'Use a model that supports tool calling, with --provider openai or --provider anthropic.',
        );
      }
    }

    try {
      // issue #625 PR-2a (decisions C17, C23): an engine step that cannot run HERE — refused before
      // its claim, or capability-blocked — is named once per drive.
      const reportedRefusals = new Set<string>();
      // decision C182: the claims the drive has said it waits on (step and claim), each said once.
      const waitingSaid = new Set<string>();
      // decision C23: a capability block's reply from the loop-top `advanceRun`, held per step — it is
      // this drive's exit only when nothing else can run.
      const heldCapabilityReplies = new Map<string, Awaited<ReturnType<typeof advanceRun>>>();
      const keepsClaims = deps.store.persistsClaims === true;
      // #729 CW-5b: the claims whose lease no program held that this drive has said it cannot take
      // back — with no program name, or at the cap (`capSaid`, which only a person frees) — each said
      // once, in place of its waiting line.
      const takeBackSaid = new Set<string>();
      const capSaid = new Set<string>();
      /**
       * #729 CW-5b: the watch's take-back of `step`, judged on the read the drive holds. An agent step
       * whose claim names a lease that read found not held, and that carries a token, is taken back
       * once (`takeBackStep`, under this drive's name; the function's own fresh read decides). The
       * answer: `'loop'` — back to the loop's top (the step was taken back, someone else took it, or
       * the run ended); `'capped'` — only a person can free it, and its line is said; `'watch'` — keep
       * watching it, as before.
       */
      const takeBackMove = async (
        step: string,
        watchMs: number,
      ): Promise<'watch' | 'loop' | 'capped'> => {
        const read = currentSnap;
        const claim = read.record.claims?.[step];
        // #729 CW-5c: the one answer the doors' `realm agent` sentence reads too. Not an agent step,
        // an ended run, or no claim with a token: watched.
        const answer = takeBackAnswer(read.record, definition, step, leaseFactOf(read, claim));
        const token = claim?.token;
        if (
          answer.kind === 'not_an_agent_step' ||
          answer.kind === 'run_ended' ||
          answer.kind === 'not_claimed' ||
          claim === undefined ||
          token === undefined
        )
          return 'watch';
        const key = `${step}\u0000${token}`;
        if (capSaid.has(key)) return 'capped';
        const described = describeClaimHolder(claim, keepsClaims, leaseFactOf(read, claim));
        if (answer.kind === 'lease_not_free') return 'watch';
        const atCap = (
          last: ReturnType<typeof automaticTakebacksOf>['last'],
          snap: Snapshot,
        ): 'capped' => {
          capSaid.add(key);
          waitingSaid.add(key);
          console.log(
            takeBackAtCapLine(step, described, last!, heldEntryAt(snap, step), writerCtx()),
          );
          return 'capped';
        };
        if (deps.driver === undefined) {
          // No program name: nothing is taken back (its audit entry names its taker). The cap is read
          // once per claim, so the line names no REALM_OPERATOR advice where it would not help.
          if (takeBackSaid.has(key)) return 'watch';
          takeBackSaid.add(key);
          if (answer.kind === 'at_cap') return atCap(answer.last, read);
          waitingSaid.add(key);
          console.log(noDriverTakeBackLine(step, described, watchMs, writerCtx()));
          return 'watch';
        }
        let outcome: Awaited<ReturnType<typeof takeBackStep>>;
        try {
          outcome = await takeBackStep(deps.store, runId, step, {
            expectToken: token,
            drivenBy: deps.driver,
            ...(deps.traceBufferStore !== undefined
              ? { traceBufferStore: deps.traceBufferStore }
              : {}),
          });
        } catch (err) {
          if (!(err instanceof WorkflowError) || err.code !== 'STATE_SNAPSHOT_MISMATCH') throw err;
          // The function's second race (the record moved under both its writes): the loop's top
          // judges the run again, on a fresh read.
          hold(await deps.store.get(runId));
          return 'loop';
        }
        if (outcome.kind === 'taken_back') {
          // #729 CW-5a: line (i) waits for this drive's own claim of the step (its answer decides it).
          pendingTakeBack.set(step, described);
          hold(outcome.snapshot);
          return 'loop';
        }
        if (
          outcome.kind === 'changed' ||
          (outcome.kind === 'not_taken' && outcome.reason === 'not_in_progress')
        ) {
          // Someone else took the step between this drive's read and the function's own. #729 PR-3
          // (L-2): the writer's context only inside the print call.
          if (takenFirstLine(step, read.record, outcome.snapshot, keepsClaims) !== undefined)
            console.log(
              takenFirstLine(step, read.record, outcome.snapshot, keepsClaims, writerCtx()),
            );
          hold(outcome.snapshot);
          return 'loop';
        }
        if (outcome.reason === 'run_ended') {
          hold(outcome.snapshot);
          return 'loop';
        }
        if (outcome.reason === 'at_cap') {
          return atCap(automaticTakebacksOf(outcome.snapshot.record, step).last, outcome.snapshot);
        }
        // The lease held, absent or unknown on the function's own read, an open question, or a
        // claim with no lease: watched as before.
        return 'watch';
      };

      // decision C159: the questions whose due expiry this drive has handed to `advanceRun` — each
      // once, so a question the call could not carry out is announced (and timed) as before.
      const expiryAttempted = new Set<string>();
      while (!currentRun.terminal_state) {
        // --- Gate handling ---
        // decision C159: a question whose time is up and whose `on_expiry` the engine carries out is
        // never announced as live (no `Waiting for approval…`, no `--choice` commands an answer could
        // no longer be recorded through): the engine's work below — `advanceRun` — carries the
        // expiry out first and prints its line.
        const dueExpiry =
          currentRun.pending_gate !== undefined &&
          !expiryAttempted.has(currentRun.pending_gate.gate_id) &&
          describePending(definition, currentSnap, deps.registry).expiry_due !== undefined;
        if (dueExpiry) expiryAttempted.add(currentRun.pending_gate!.gate_id);
        if (currentRun.pending_gate !== undefined && !dueExpiry) {
          const gate = currentRun.pending_gate;

          console.log(`\n⏸  Gate: ${gate.step_name} | ID: ${gate.gate_id}`);
          // #715 (b) (03 §B.2 E, D6-72 (b)): the question's deadline, at the held snapshot's reading.
          const deadlineLine = questionDeadlineLine(gate, currentAt!);
          if (deadlineLine !== undefined) console.log(deadlineLine);
          const gateStepDef = definition.steps[gate.step_name];
          // #729 PR-4 (03 #6): the view core's composer returns — the question at the declared tier
          // in a question span, a blank line, the preview (`display` honoured); with no message the
          // preview alone is the body ((f)). A cut view names the way to the whole output under it.
          const indent = (text: string): string =>
            text
              .trimEnd()
              .split('\n')
              .map((l) => `   ${l}`)
              .join('\n');
          const view = gateViewForPrint(gate, gateStepDef?.display);
          const shownBody =
            view.question_text !== ''
              ? questionSpan(indent(view.question_text)) +
                (view.preview_text !== '' ? '\n\n' + indent(view.preview_text) : '')
              : indent(view.preview_text);
          console.log('\n' + shownBody + '\n');
          if (view.cut !== undefined) console.log(`   ${cutWayLine(runId, writerCtx())}\n`);

          if (deps.gateHandler !== undefined) {
            if ((await deps.gateHandler(runId, gate)) === true) endingSaid = true;
          } else {
            // Terminal fallback: print each choice as a command and poll. #729 PR-0 (Part C): the
            // answer commands are the CLI renderer's, from the gate's `respond` way.
            // #729 PR-3 (L-2): the writer's context only inside the print call.
            // #729 PR-4: the lines are shared with the Slack notifier's fallback (one rendering).
            terminalRespondLines(runId, gate).forEach((_, i) =>
              console.log(terminalRespondLines(runId, gate, writerCtx())[i]),
            );
            // issue #291 (Deliverable 4e, Amendment 4): the ATTENDING-PROCESS enactment timer —
            // this IS "the non-Slack agent poll loop" the design names as its own timer host. A
            // no-op for a finding-only/non-expiring gate.
            const clearExpiryTimer = scheduleGateExpiryTimer(runId, gate, {
              store: deps.store,
              definition,
              registry: deps.registry,
              ...(deps.driver !== undefined ? { driver: deps.driver } : {}),
              onEndingSaid: () => {
                endingSaid = true;
              },
            });
            try {
              await pollUntilGateResolved(
                deps.store,
                runId,
                gate.gate_id,
                options.pollIntervalMs ?? 3000,
              );
            } finally {
              clearExpiryTimer();
            }
          }

          hold(await deps.store.get(runId));
          continue;
        }

        // --- The engine's work first (issue #625 PR-2a, D4.2) ---
        // Guards, then every runnable `auto` step, through the ONE core call every driver uses. The
        // loop below never names an `auto` step itself.
        let engineStep: string | undefined;
        // The step `advanceRun` started last and has not yet been seen to complete: its `✓ → <phase>`
        // line is printed when the next step starts, or after the call returns `ok` — the same line
        // the agent path prints for a step it completes (`realm agent`'s documented screen).
        let startedNotDone: string | undefined;
        const advanced = await advanceRun(deps.store, definition, {
          runId,
          caller: 'agent',
          // #729 PR-4 (01): a question this call opens is minted with the writer's private set.
          ...((set) => (set !== undefined ? { disclosure: set } : {}))(writerSetFor('private')),
          // decision C159: the line that says this call carried out an expired question, first.
          onExpiry: (line) => console.log(`⚠ ${line}`),
          registry: deps.registry,
          ...(deps.traceBufferStore !== undefined
            ? { traceBufferStore: deps.traceBufferStore }
            : {}),
          ...(deps.driver !== undefined ? { driver: deps.driver } : {}),
          onStep: (step) => {
            // #729 PR-3 correction 6 (C6-2): the phase is realm's word, printed through the span.
            if (startedNotDone !== undefined)
              console.log(`  ✓ → ${writerCtx().word('running', RUN_PHASE_WORDS)}`);
            startedNotDone = step;
            console.log(`→ [auto] ${step}`);
            // issue #401: a throw from here on mints with this engine step's name, and its
            // elapsed time is measured from this step's start.
            currentStepName = step;
            attemptStartedAt = performance.now();
            engineStep = step;
          },
          // D6.1: another process took an engine step — the same past-tense line as for an agent
          // step; `advanceRun` re-reads and continues.
          // #729 CW-1b part 2: the re-read snapshot core passes, its lease fact read for the claim.
          onTaken: (step, record, snapshot: Pick<Snapshot, 'lease_facts'> = NO_SNAPSHOT) => {
            startedNotDone = undefined;
            console.log(
              takenLine(
                step,
                describeClaimHolder(
                  record.claims?.[step],
                  keepsClaims,
                  leaseFactOf(snapshot, record.claims?.[step]),
                ),
                writerCtx(),
              ),
            );
          },
          // F7: an engine step this call ran whose outcome another program's act kept from being
          // recorded — the race is core's to name, and its loop goes on; the line is the one
          // `realm run advance` prints, never `✓` and never `✗ … failed`.
          onNotRecorded: (
            step,
            kind,
            record,
            snapshot: Pick<Snapshot, 'lease_facts'> = NO_SNAPSHOT,
          ) => {
            startedNotDone = undefined;
            console.log(
              outcomeNotRecordedLine(kind, record, step, keepsClaims, writerCtx(), snapshot),
            );
          },
        });
        // #625 A1b-2: the ⚠ line of an expiry this call carried out said the run ended when that
        // expiry's write ended it — an `on_expiry: abort`, or a default whose guard then ended the
        // run (its sentence is on that line). The call then ran no step after it.
        if (
          advanced.expiry !== undefined &&
          engineStep === undefined &&
          (advanced.chained_auto_steps ?? []).length === 0 &&
          judgedSnapshotOf(advanced)?.record.terminal_state === true
        )
          endingSaid = true;
        if (advanced.status === 'confirm_required') {
          if (!holdJudged(advanced)) return stopOnEngineWords(advanced);
          continue;
        }
        // A non-`ok` reply from an engine step goes into the dispositions below (decision C15):
        // the step name and the reply are set as the agent path sets them, and nothing is moved.
        let engineReply: typeof advanced | undefined;
        if (advanced.status !== 'ok') {
          if (engineStep === undefined) {
            // A refusal before any step ran (a guard refusal, a store failure): today's failed exit.
            console.error(`\n✗ ${advanced.errors.join(', ') || advanced.context_hint}`);
            // #625 A1b-2: a refusal that ended the run (a guard's resolution error) said how.
            if (judgedSnapshotOf(advanced)?.record.terminal_state === true) endingSaid = true;
            printResumeLine(judgedSnapshotOf(advanced));
            return 'failed';
          }
          // F7: core's classifier names the stop (a race never reaches here — core's loop goes on),
          // on the record the engine judged its reply on (#715 (b), Amendment 4); a reply with none
          // goes to the dispositions as it is.
          const advancedJudged = judgedSnapshotOf(advanced);
          const advancedStop =
            advancedJudged === undefined
              ? undefined
              : classifyStop(advanced, engineStep, advancedJudged.record);
          if (advancedStop?.kind === 'capability_missing') {
            // decision C23: a capability block is an engine step that cannot run HERE, the same class
            // as a refusal before the claim. Held, not sent to the dispositions at once: the attempt
            // wrote its marker, so the view below names the step, and the loop goes on with the
            // ready agent steps.
            heldCapabilityReplies.set(engineStep, advanced);
          } else {
            engineReply = advanced;
          }
        }
        if (engineReply === undefined) {
          if (!holdJudged(advanced)) return stopOnEngineWords(advanced);
          if (advanced.status === 'ok' && startedNotDone !== undefined) {
            console.log(`  ✓ → ${writerCtx().word(currentRun.run_phase, RUN_PHASE_WORDS)}`);
          }
          if (currentRun.terminal_state) break;
          if (currentRun.pending_gate !== undefined) continue;
          // decisions C17, C23, C82: a step that cannot run — an engine step refused before its claim
          // or capability-blocked, or an agent step refused before its claim — is named once per
          // drive, and the loop goes on with the ready agent steps. The words are core's
          // (decision C36).
          for (const e of cannotRunEntries(
            composeWaysAt(currentRun, currentAt!, {
              definition,
              registry: deps.registry,
              persistsClaims: keepsClaims,
              lease_facts: currentSnap.lease_facts,
            }),
          )) {
            const step = e.step ?? '';
            if (!reportedRefusals.has(step)) {
              reportedRefusals.add(step);
              console.log(`• Step ${cannotRunClause(e, writerCtx())}`);
            }
          }
        }

        // --- Step execution: agent steps only ---
        // decision C82: the agent steps the run's view offers — an agent step it refuses before its
        // claim (trust, precondition) is never picked, so no model is asked to answer it.
        const eligible =
          engineReply !== undefined
            ? []
            : describePending(definition, currentSnap, deps.registry).agent_steps;
        if (engineReply === undefined && eligible.length === 0) {
          // decisions C23, C31, C64, C82: the run cannot go on from here (`cannotGoOnHere`: no agent
          // step is ready, no engine step can run, nothing is in flight elsewhere — a step another
          // program holds may still change what can run — and a step cannot run): the drive stops
          // on the FIRST such step (definition order). With a step in flight it watches below.
          const view = describePending(definition, currentSnap, deps.registry);
          const cannotRun = stepsThatCannotRun(view);
          if (cannotGoOnHere(currentRun, view)) {
            const stop = cannotRun[0]!;
            const first = stop.step;
            if (definition.steps[first]?.execution === 'agent') {
              // decision C82: an agent step refused before its claim (trust, precondition) — the
              // view's verdict on this record, and nothing is called: the step's input would be a
              // model's answer, the call its refusal rules out. Nothing is recorded, as for an engine
              // step refused for trust or precondition. (`cannotGoOnHere` holds only on a run that is
              // still open, so the way out is said of an open run — F7 (e).)
              console.error(
                `\n✗ The drive stops: nothing else can run, and '${first}' cannot run (${stop.refused_by}). ` +
                  cannotRunWayOut(
                    composeWaysAt(currentRun, currentAt!, {
                      definition,
                      registry: deps.registry,
                      persistsClaims: keepsClaims,
                      lease_facts: currentSnap.lease_facts,
                    }),
                    runId,
                    derivePhaseOf(currentRun),
                    writerCtx(),
                  ),
              );
              return 'failed';
            }
            const preClaim = stop.refused_by !== 'capability';
            // capability (decision C23): the block's own exit — the capability block this drive
            // holds for the step, otherwise one attempt after the claim (`→ [auto]`, then the block's
            // `⚠ … re-attach` line). A refusal before the claim (decision C31) takes no attempt line
            // and never enters the dispositions: the engine's refusal is read with one write-free call.
            let exitReply = preClaim ? undefined : heldCapabilityReplies.get(first);
            if (exitReply === undefined) {
              if (!preClaim) console.log(`→ [auto] ${first}`);
              currentStepName = first;
              attemptStartedAt = performance.now();
              exitReply = await executeEngineStep(deps.store, definition, {
                runId,
                step: first,
                // #729 PR-4 (01): a question this call opens is minted with the writer's private set.
                ...((set) => (set !== undefined ? { disclosure: set } : {}))(
                  writerSetFor('private'),
                ),
                // decision C151: an expiry this call carries out names `realm agent`.
                caller: 'agent',
                run: currentRun,
                registry: deps.registry,
                ...(deps.traceBufferStore !== undefined
                  ? { traceBufferStore: deps.traceBufferStore }
                  : {}),
                ...(deps.driver !== undefined ? { driver: deps.driver } : {}),
              });
            }
            // F7: the reply read by core's classifier against the record as it is now — a race
            // (another program took the step, ran it, ended the run, or opened a question, in the
            // moment between the view and this call) is not this drive's stop: it goes on, and its
            // own end and question checks speak.
            hold(await deps.store.get(runId));
            const exitStop = classifyStop(exitReply, first, currentRun);
            if (isRaceStop(exitStop)) {
              if (exitStop.kind === 'held_elsewhere' && !exitStop.ran_here) {
                console.log(
                  takenLine(
                    first,
                    describeClaimHolder(
                      currentRun.claims?.[first],
                      keepsClaims,
                      leaseFactOf(currentSnap, currentRun.claims?.[first]),
                    ),
                    writerCtx(),
                  ),
                );
              } else if (exitStop.ran_here) {
                console.log(
                  outcomeNotRecordedLine(
                    exitStop.kind as NotRecordedKind,
                    currentRun,
                    first,
                    keepsClaims,
                    writerCtx(),
                    currentSnap,
                  ),
                );
              }
              continue;
            }
            const refusedBeforeClaim =
              preClaim &&
              (exitReply.error_code === 'VALIDATION_TRUST_VALUE' ||
                exitReply.error_code === 'VALIDATION_INPUT_SCHEMA' ||
                exitReply.status === 'blocked');
            if (refusedBeforeClaim) {
              // decision C31: the drive failure, recorded exactly as chokepoint 4 records it — an input
              // schema refusal wedges the run with nothing on its record, so it is `validation_rejected`
              // with the engine's own message and the step; trust and precondition record nothing, as
              // before #625. No model call was made, so no usage rides along.
              if (exitReply.error_code === 'VALIDATION_INPUT_SCHEMA') {
                await recordDriveFailure(deps.store, runId, {
                  ...validationWedgeEntry(
                    first,
                    providerForEvidence ?? 'unknown',
                    exitReply.errors,
                    attemptStartedAt,
                    deps.store.clock.now(),
                  ),
                  // Gap 1, unit A2b: no model request belongs to it (or the switch's marker).
                  model_text: failureText(undefined),
                });
              }
              hold(await deps.store.get(runId));
              // F7 (e): the way out is said only of a run that is still open — a run another program
              // ended meanwhile goes to the drive's own end check.
              if (currentRun.terminal_state) continue;
              // decision C44: the way out is to correct the workflow and register it again (the run
              // picks up the corrected definition), then advance — or to end the run.
              console.error(
                `\n✗ The drive stops: nothing else can run, and '${first}' cannot run (${stop.refused_by}). ` +
                  cannotRunWayOut(
                    composeWaysAt(currentRun, currentAt!, {
                      definition,
                      registry: deps.registry,
                      persistsClaims: keepsClaims,
                      lease_facts: currentSnap.lease_facts,
                    }),
                    runId,
                    derivePhaseOf(currentRun),
                    writerCtx(),
                  ),
              );
              return 'failed';
            }
            if (exitReply.status === 'error') {
              engineReply = exitReply;
              engineStep = first;
            } else {
              // The step became runnable between the view and the attempt, and ran: go on.
              continue;
            }
          }
        }
        if (engineReply === undefined && eligible.length === 0) {
          // issue #625 PR-2a (D6.2): a step in flight elsewhere (the open gate's own step is not "in
          // flight" — it holds a claim while it waits) — watch the record and re-enter on any change.
          const inFlight = currentRun.in_progress_steps.filter(
            (step) => step !== currentRun!.pending_gate?.step_name,
          );
          if (inFlight.length > 0) {
            const pollMs = options.inFlightPollMs ?? IN_FLIGHT_POLL_MS;
            const watchMs = options.inFlightWatchMs ?? IN_FLIGHT_WATCH_MS;
            // #729 CW-5b: the steps only a person can free now (said at the cap); the watch goes on
            // while another step is still watched.
            const capped = new Set<string>();
            const watching = (): boolean => inFlight.some((step) => !capped.has(step));
            // #729 CW-5b: the take-back check of every watched step on the read the drive holds —
            // `true` when one goes back to the loop's top.
            const checkTakeBacks = async (): Promise<boolean> => {
              for (const step of inFlight) {
                if (capped.has(step)) continue;
                const move = await takeBackMove(step, watchMs);
                if (move === 'loop') return true;
                if (move === 'capped') capped.add(step);
              }
              return false;
            };
            // decision C182: what the drive waits for and who holds it, said once for each claim it
            // waits on — `realm workflow run`'s line. #729 CW-5b: each step's take-back check first,
            // on the same read.
            let back = false;
            for (const step of inFlight) {
              const move = await takeBackMove(step, watchMs);
              if (move === 'loop') {
                back = true;
                break;
              }
              if (move === 'capped') {
                capped.add(step);
                continue;
              }
              const claim = currentRun.claims?.[step];
              const key = `${step}\u0000${claim?.token ?? claim?.since ?? ''}`;
              if (waitingSaid.has(key)) continue;
              waitingSaid.add(key);
              console.log(
                waitingLine(
                  step,
                  describeClaimHolder(claim, keepsClaims, leaseFactOf(currentSnap, claim)),
                  watchMs,
                  writerCtx(),
                ),
              );
            }
            if (back) continue;
            const startVersion = currentRun.version;
            const watchStarted = performance.now();
            let changed = false;
            while (watching() && performance.now() - watchStarted < watchMs) {
              await new Promise((resolve) => setTimeout(resolve, pollMs));
              // #715 (b) (D6-19): every poll REPLACES the held snapshot, changed or not — the same
              // record at a newer reading, so a claim's staleness is judged at the latest one.
              hold(await deps.store.get(runId));
              if (currentRun.version !== startVersion) {
                changed = true;
                break;
              }
              // #729 CW-5b: a lease no program holds any more is seen on the poll that reads it.
              if (await checkTakeBacks()) {
                back = true;
                break;
              }
            }
            if (changed || back) continue;
            // #922 P2-2: each held step's state and what frees it, from the ways composed at the
            // watch's last reading.
            const held = heldEntriesOf(
              composeWaysAt(currentRun, currentAt, {
                definition,
                registry: deps.registry,
                persistsClaims: keepsClaims,
                lease_facts: currentSnap.lease_facts,
              }),
            );
            for (const entry of held) {
              // #729 CW-5b: a step said at the cap — its line already said what frees it.
              if (capped.has(entry.facts.step)) continue;
              const claim = currentRun.claims?.[entry.facts.step];
              const described = describeClaimHolder(
                claim,
                keepsClaims,
                leaseFactOf(currentSnap, claim),
              );
              console.log(inFlightLine(entry, described, watchMs, writerCtx()));
            }
            // decision C195: the way on once the program holding the step is done with it — this
            // drive again, with the flags it was started with (`realm workflow run`'s hand-back,
            // C188, gives `realm run advance` the same way).
            console.log(
              goOnLine(
                held,
                runId,
                writerCtx().cmd(
                  `realm agent --run-id ${runId} ${deps.reattachFlags ?? '--provider <provider> --model <model>'}`,
                ),
                writerCtx(),
              ),
            );
            // decision C179: the drive stops on the step another process holds; the run did not end,
            // so no `Run ended in phase` line follows.
            stoppedOnInFlight = true;
          }
          break;
        }

        const stepName =
          engineReply !== undefined && engineStep !== undefined ? engineStep : eligible[0]!;
        // issue #401: never cleared. A throw AFTER this step settles mints with this step's name,
        // and conjunct (iv) of the drive_failing predicate then suppresses the finding — because
        // progress DID happen. Chosen, not incidental.
        currentStepName = stepName;
        // #625 A1a: the step this drive started last and has not yet been seen to complete — this
        // step, then each step its `executeChain` call runs after it (the advanceRun path's
        // `startedNotDone`). A `✓` is printed only for a step this program finished.
        let chainStartedNotDone: string | undefined = stepName;
        const stepDef: StepDefinition = definition.steps[stepName]!;

        // issue #401 — the clock for THIS step's model requests. The step's own authored key
        // WINS; the CLI flag fills in for a step that never authored one; 600s if neither
        // (the --schema-retries precedent, exactly). `deriveLlmClock` turns the per-ATTEMPT
        // seconds into the whole-create ceiling — per-attempt × (retries + 1), plus the SDK's
        // own worst-case backoff sleeping, plus a download allowance for a slow response body.
        //
        // The SOURCE is computed here, once, and travels with the clock. Two disclosures depend
        // on it and nothing else does: whether the recorded `declared_per_attempt_ms` exists at
        // all — a fallback nobody chose is not a declaration, so it is omitted rather than
        // reported as one — and which lever a fired ceiling names, since telling someone to raise
        // a flag their own step key overrides sends them to change something inert.
        const perAttemptSource: NonNullable<LlmClock['perAttemptSource']> =
          stepDef.llm_timeout_seconds !== undefined
            ? 'step'
            : deps.llmTimeoutSeconds !== undefined
              ? 'flag'
              : 'default';
        const derivedClock = deriveLlmClock(
          (stepDef.llm_timeout_seconds ?? fallbackLlmTimeoutSeconds) * 1000,
        );
        // Gap 2, unit (i-b): an agent step that declares `retry` is tried again as it says. Realm's
        // own providers follow the policy on the clock inside each model request; a provider
        // module that declares `handlesRetries` gets it too and follows it itself. A module that
        // does not: a step without tools has its whole call tried again here, and a step with tools
        // is not tried again (once per drive, a line says so). Before each re-send after a wait the
        // policy asks the drive: no stop cause, and the step's claim still names this drive's lease
        // (on a store with no leases: the run unfinished and the step unsettled).
        const retryBlock = stepDef.execution === 'agent' ? stepDef.retry : undefined;
        const fromModule = deps.providerId !== undefined;
        const stepHasTools = (stepDef.tools?.length ?? 0) > 0;
        retryForStep =
          retryBlock === undefined
            ? undefined
            : makeModelRetryPolicy({
                retry: retryBlock,
                // The per-attempt timeout the try's own timer uses (the step's, the flag's, or
                // the 600 s default), read once above.
                ...deriveRetryCap(retryBlock, derivedClock.declaredPerAttemptMs),
                mayResend: async () => {
                  if (stopCause !== undefined) return false;
                  const { record } = await deps.store.get(runId);
                  if (held !== undefined && held.step === stepName) {
                    return (
                      record.in_progress_steps.includes(stepName) &&
                      record.claims?.[stepName]?.lease?.id === held.hold.id
                    );
                  }
                  return (
                    !record.terminal_state &&
                    !record.completed_steps.includes(stepName) &&
                    !record.failed_steps.includes(stepName) &&
                    !record.skipped_steps.includes(stepName)
                  );
                },
              });
        const stepRetry = retryForStep;
        const moduleRetries = fromModule && caps.handlesRetries !== true;
        if (stepRetry !== undefined && moduleRetries && stepHasTools) {
          if (!retryNotApplied.has(stepName)) {
            retryNotApplied.add(stepName);
            console.log(
              `• Step '${stepName}': 'retry' is not applied: provider module '${deps.providerId!.slice('module:'.length)}' does not say it handles retries, and a step with tools is never sent again whole.`,
            );
          }
        }
        // The module's whole call, tried again here (a step without tools, the module silent).
        const wholeCallRetry =
          stepRetry !== undefined && moduleRetries && !stepHasTools ? stepRetry : undefined;
        // Gap 2, unit (ii-b2): what this step's failed model request becomes, read by both provider
        // catches. A step that declares `on_model_failure: fail` takes #1300's decision, and fails
        // through `executeChain`'s `modelFailure` when it says `fail`; any other step, and any
        // `give_back`, is given back as before (`undefined`).
        const modelFailureOf = (
          err: unknown,
          entry: DriveFailureRecord,
          providerCalled: boolean,
        ): ModelFailureMember | undefined => {
          if (stepDef.on_model_failure !== 'fail') return undefined;
          const decision = decideModelFailure({
            err,
            entry,
            providerCalled,
            retry: retryBlock,
            tries: entry.model_attempts,
            provider: !fromModule
              ? 'realm'
              : caps.handlesRetries === true
                ? 'module_handles_retries'
                : 'module',
            hasTools: stepHasTools,
          });
          return decision.outcome === 'fail' ? decision.modelFailure : undefined;
        };
        const llmClock: LlmClock = {
          ceilingMs: derivedClock.ceilingMs,
          perAttemptSource,
          ...(perAttemptSource !== 'default' && derivedClock.declaredPerAttemptMs !== undefined
            ? { declaredPerAttemptMs: derivedClock.declaredPerAttemptMs }
            : {}),
          ...(stepRetry !== undefined && !moduleRetries ? { retry: stepRetry } : {}),
        };

        // issue #217: the in-drive schema-feedback repair loop. `stepInput`/`toolCallsForMeta`/
        // `result` are re-assigned on every attempt inside the `for` loop below; `repairsUsed`/
        // `lastRejection` persist ACROSS attempts within this one step, and are fresh (0/undefined)
        // for every new step. The loop body is exactly the former single-pass step-execution region
        // (the agent/auto branch bodies + the executeChain call) — an auto step's
        // `execution !== 'agent'` means the repair gate's conjunct (iii) can never hold for it, so
        // it structurally can never iterate more than once: the loop is a no-op wrapper for every
        // pre-existing (non-repair) case.
        let stepInput: Record<string, unknown> = {};
        let toolCallsForMeta: ToolCallRecord[] | undefined;
        // issue #236: the resolved structuredOutput meta for THIS attempt's callStep call — reset
        // every iteration alongside toolCallsForMeta, threaded into stepMeta below.
        let structuredOutputMetaForStep: StructuredOutputMeta | undefined;
        // issue #600 PR 1a — what the provider said this step's wire requests cost.
        usageForStep = undefined;
        textsForStep = undefined;
        stepUsageSaved = false;
        let result: Awaited<ReturnType<typeof executeChain>>;
        // Gap 2, unit (ii-b2): the call that fails the step through `modelFailure`, with the
        // drive-failure entry its catch built (written only when the reply records no failure).
        let member: { modelFailure: ModelFailureMember; entry: DriveFailureRecord } | undefined;
        let memberRefusalSaid = false;
        let repairsUsed = 0;
        let lastRejection: { kind: 'output' | 'input'; summary: string } | undefined;

        // #729 CW-5a: the agent step's claim, under a lease, before its model is called. The brief
        // below is composed from the read before the claim, which the drive keeps on every attempt.
        if (engineReply === undefined) {
          if (stopCause !== undefined) await halt();
          // A hold a `continue` left open is given back first (no path is known to leave one).
          if (held !== undefined) await giveBack();
          givingBack = undefined;
          const claim = await claimStepForDrive(deps.store, runId, stepName, {
            definition,
            registry: deps.registry,
            ...(deps.driver !== undefined ? { driver: deps.driver } : {}),
          });
          const pending = pendingTakeBack.get(stepName);
          if (claim.kind === 'held_by' || claim.kind === 'claimed')
            pendingTakeBack.delete(stepName);
          if (claim.kind === 'claimed') {
            held = { step: stepName, hold: claim.hold, cause: 'error' };
            for (const signal of SIGNALS) process.on(signal, onSignal);
            if (pending !== undefined) console.log(takenBackLine(stepName, pending, writerCtx()));
          } else if (claim.kind === 'held_by') {
            // CW-5b's watch, as for a step in flight elsewhere (the loop's top finds it held).
            if (pending !== undefined)
              console.log(takenBackNotLandedLine(stepName, pending, claim, writerCtx()));
            hold(await deps.store.get(runId));
            continue;
          } else if (claim.kind === 'not_eligible') {
            hold(await deps.store.get(runId));
            continue;
          } else if (claim.kind === 'refused') {
            hold(await deps.store.get(runId));
            const again =
              lastRefusal?.step === stepName && lastRefusal.version === currentRun.version;
            lastRefusal = { step: stepName, version: currentRun.version };
            if (!again) continue;
            console.error(`\n✗ The drive stops: '${stepName}' cannot run (${claim.code}).`);
            return 'failed';
          } else if (claim.kind === 'lease_unavailable') {
            console.error(
              leaseUnavailableLine(stepName, claim.reason, deps.leaseFolder, writerCtx()),
            );
            return 'failed';
          } else if (claim.kind !== 'unleased_store') {
            // An answer a later release of the engine adds (the union is open): a refusal.
            const kind = (claim as { kind: string }).kind;
            console.error(
              `\n✗ The drive stops: claiming '${stepName}' answered '${kind}', which this drive does not know.`,
            );
            return 'failed';
          }
        }

        for (;;) {
          if (engineReply !== undefined) {
            // An engine step `advanceRun` ran at the loop top: its reply takes the dispositions
            // below, exactly as this step's own reply would (decision C15). No model call.
            result = engineReply;
            break;
          }
          // #729 CW-5a correction 1: from a signal's stop cause on, no model call (a repair attempt's
          // included): the drive waits for its handler to end it.
          if (stopCause !== undefined) await halt();
          // issue #401: re-stamped per repair attempt, so `elapsed_ms` measures THIS attempt
          // rather than the whole step.
          attemptStartedAt = performance.now();
          toolCallsForMeta = undefined;
          structuredOutputMetaForStep = undefined;
          // issue #217 conjunct (vi) ground truth — captured FRESH at the top of EVERY attempt
          // (including the first), never once per step: a per-step capture is stale across the
          // whole provider LLM call, so any concurrent writer (a second drive, a gate `respond`, a
          // parallel-step settle) landing during that call would silently forfeit a legitimate
          // repair. See the repair-gate comment below for the full discriminator rationale. Cost:
          // one extra store read per attempt — accepted.
          const versionBeforeAttempt = (await deps.store.get(runId)).record.version;

          if (stepDef.execution === 'agent') {
            // Resolve template-expanded prompt via buildNextActions so {{ context.resources.* }}
            // references are substituted before the LLM call. Pure w.r.t. `definition`/`currentRun`,
            // both unchanged across repair attempts — a rejected attempt no longer leaves
            // `currentRun` itself stale relative to what's persisted (issue #220: countRejection DOES
            // persist a bounded rejection counter on a counted rejection — "nothing is ever
            // persisted on a rejected attempt" is FALSE as of #220), but `currentRun`/`definition`
            // are still safe to recompute per iteration here regardless, since neither is read from
            // again until the NEXT step (this step's own next_actions/prompt derivation never
            // consults `validation_rejections`).
            // #729 PR-0: the step's brief (its template-filled prompt) from the run's ways — core's one
            // composer, no registry read (an observer), as before.
            const stepWays = composeWaysAt(currentRun, currentAt!, {
              definition,
              persistsClaims: deps.store.persistsClaims === true,
              lease_facts: currentSnap.lease_facts,
              // The filter-mask fix (B2): the prompt bound for the model masks each value before
              // its filters, with the agent set the provider edge masks with (tier `all`).
              disclosure: agentDisclosureSet(),
            }).ways.filter((w) => w.verb === 'run_step');
            const nextAction = (
              stepWays.find((w) => w.verb === 'run_step' && w.step === stepName) ?? stepWays[0]
            )?.brief;

            // PRISTINE original prompt — never mutated across repair attempts. The prompt actually
            // sent to the provider (`promptForAttempt` below) is always derived FRESH from this,
            // plus at most the LATEST rejection's feedback — never accumulated, never stale.
            const prompt = nextAction?.prompt ?? stepDef.description;
            // The prompt is the step's template filled with run params and stored step results,
            // plus any rejection feedback. #729 PR-3 (L-5): the provider edge — core's law for the
            // agent audience, once, before any of the three provider calls below sends it; no span
            // mark leaves with it.
            const rawForAttempt =
              lastRejection !== undefined
                ? `${prompt}\n\nYour previous output was rejected by the ${lastRejection.kind} schema validator:\n${lastRejection.summary}\nEmit corrected JSON only, matching the schema exactly.`
                : prompt;
            const promptForAttempt = discloseForAgent(rawForAttempt);
            // Caching 3-B (C2): the stable start of the brief's prompt, cut once from the same text.
            // The feedback is appended after the prompt, so a repair attempt sends the same head.
            // `promptForAttempt` is sent unchanged (the law makes it head + tail).
            const split =
              nextAction?.prompt !== undefined && nextAction.stable_prefix !== undefined
                ? discloseForAgentSplit(rawForAttempt, nextAction.stable_prefix.chars)
                : undefined;
            const cachePrefix = split !== undefined ? { cachePrefixChars: split.head.length } : {};
            // Caching 3-M (D-2): the step's cache choice for this drive, on each of its calls.
            const stepCacheChoice = deps.stepCacheChoices?.get(stepName);
            const stepCache = stepCacheChoice !== undefined ? { cacheChoice: stepCacheChoice } : {};
            // #robust-anthropic-provider Part 1: route the schema the ENGINE validates output against
            // (output_schema, execution-loop.ts validateOutputSchema) ahead of the execute_step-param
            // schema (input_schema / nextAction.input_schema) the provider was fed until now. Both-
            // declared-and-divergent degrades to a clean recoverable VALIDATION_*_SCHEMA error downstream,
            // not a parse-strand — see the Part 6 loader warning for the authoring-time signal.
            const inputSchema =
              (stepDef.output_schema as Record<string, unknown> | undefined) ??
              (nextAction?.input_schema as Record<string, unknown> | undefined) ??
              (stepDef.input_schema as Record<string, unknown> | undefined);
            const agentProfileInstructions =
              stepDef.agent_profile !== undefined
                ? definition.resolved_profiles?.[stepDef.agent_profile]?.content
                : undefined;

            // issue #236: compute the Phase-B verdict ONCE per attempt-cycle, on the EXACT resolved
            // `inputSchema` local above — never re-derived from `stepDef` (design §2, Rv11). Only
            // steps that DECLARED structured_output ever get a plan at all — an undeclared step's
            // call site below is completely untouched (byte-identical for the non-opted majority).
            let structuredOutputPlan:
              | { send: boolean; ineligibleMeta?: StructuredOutputMeta; caveats?: string[] }
              | undefined;
            if (stepDef.structured_output === 'strict') {
              const sticky = structuredOutputSticky.get(stepName);
              if (sticky !== undefined) {
                // A prior attempt for this step already downgraded — never re-attempt strict.
                structuredOutputPlan = {
                  send: false,
                  ineligibleMeta: { requested: true, sent: false, ...sticky },
                };
              } else if (caps.strictGate !== undefined) {
                // issue #313: an ENDPOINT-scoped refusal, checked AFTER sticky and BEFORE the
                // verdict. Two consequences, both deliberate: the schema is never assessed (its
                // eligibility is irrelevant when strict cannot be sent at all), and this arm sits
                // structurally outside the sticky-arming path, so a compat endpoint can never arm
                // sticky — nothing was attempted, so there is nothing to remember.
                structuredOutputPlan = {
                  send: false,
                  ineligibleMeta: {
                    requested: true,
                    sent: false,
                    downgrade_reason: caps.strictGate,
                  },
                };
              } else {
                const verdict = assessStructuredOutputEligibility({
                  schema: inputSchema,
                  tools: false,
                  profile,
                });
                // issue #313 — the remediation nudge. The plan below discards `reasons`, so this
                // is the only place they still exist. Printed once per step (`repairsUsed === 0`),
                // for ineligible AND caveated verdicts, on stderr: an author who opted into strict
                // and silently did not get it is exactly who needs to know why.
                if (repairsUsed === 0 && verdict.verdict !== 'eligible') {
                  const findings =
                    verdict.verdict === 'ineligible' ? verdict.reasons : verdict.caveats;
                  console.error(
                    `  ⚠ Step '${stepName}': structured_output: strict — ${renderIneligibleMessage(findings)}`,
                  );
                }
                if (verdict.verdict === 'ineligible') {
                  structuredOutputPlan = {
                    send: false,
                    ineligibleMeta: {
                      requested: true,
                      sent: false,
                      downgrade_reason: 'gate_ineligible',
                    },
                  };
                } else if (verdict.verdict === 'eligible_with_caveats') {
                  structuredOutputPlan = {
                    send: true,
                    caveats: verdict.caveats.map((c) => c.code),
                  };
                } else {
                  structuredOutputPlan = { send: true };
                }
              }
            }

            if (repairsUsed === 0) {
              const descPreview = stepDef.description.slice(0, 80);
              console.log(`\n→ [agent] ${stepName}`);
              console.log(`  ${descPreview}${stepDef.description.length > 80 ? '…' : ''}`);

              // issue #220 deliverable 7 — drive-time coherence warn: once per step (gated on the
              // same `repairsUsed === 0` this banner uses), warn when the repair budget itself
              // (schemaRetries + 1 attempts) exceeds the engine's own exhaustion threshold for this
              // step — operator intent would be silently truncated mid-loop (the drive keeps
              // repairing past the point the engine terminalizes the step with VALIDATION_EXHAUSTED).
              const exhaustionThreshold =
                stepDef.validation_exhaustion?.threshold ?? DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD;
              if (schemaRetries + 1 > exhaustionThreshold) {
                console.error(
                  `  ⚠ --schema-retries ${schemaRetries} (repair budget ${schemaRetries + 1} attempts) ` +
                    `exceeds step '${stepName}''s validation-exhaustion threshold ` +
                    `(${exhaustionThreshold}) — the engine will terminalize this step before the ` +
                    `repair loop's own budget is exhausted.`,
                );
              }
            }

            // Gap 2, unit (ii-b2): `toolsStep` — a failure taking `modelFailure` leaves the tools
            // path from its catch, past the reads of the tools result, for the call below.
            toolsStep: if (stepDef.tools && stepDef.tools.length > 0 && mcpClient) {
              // Tools path: build tool definitions, call callStepWithTools. Rebuilt every attempt
              // (issue #217) — safe: repair only ever follows a ZERO-toolCall attempt, so no budget
              // was spent and nothing can duplicate.
              const byServer = new Map<string, string[]>();
              for (const entry of stepDef.tools) {
                const [serverId, toolName] = entry.split(':') as [string, string];
                if (!byServer.has(serverId)) byServer.set(serverId, []);
                byServer.get(serverId)!.push(toolName);
              }

              let toolsResult;
              // issue #311: hoisted so the evidence assembly below the try/catch can read them.
              const toolArgsEntries: NonNullable<StructuredOutputMeta['tool_args']>['tools'] = [];
              // Gap 1, unit A2b: whether the throw below is the provider call's (a module provider's
              // call that carries no texts is `provider_did_not_report`) or came before it.
              let toolsProviderCalled = false;
              try {
                const toolDefs: ToolDefinition[] = [];
                const barenameOwner = new Map<string, string>(); // bareName → serverId of first registration
                for (const [serverId, allowList] of byServer) {
                  const mcpTools = await mcpClient.getTools(serverId, allowList);

                  const returnedNames = new Set(mcpTools.map((t) => t.name));
                  for (const name of allowList) {
                    if (!returnedNames.has(name)) {
                      throw new WorkflowError(
                        `Step '${stepName}' declares tool '${serverId}:${name}' which is not exposed by MCP server '${serverId}'. ` +
                          `Check the tool name against the server's published tool list.`,
                        {
                          code: 'MCP_TOOL_NOT_FOUND',
                          category: 'ENGINE',
                          agentAction: 'stop',
                          retryable: false,
                        },
                      );
                    }
                  }

                  for (const mcpTool of mcpTools) {
                    const firstOwner = barenameOwner.get(mcpTool.name);
                    if (firstOwner !== undefined) {
                      throw new WorkflowError(
                        `Tool name collision in step '${stepName}': '${mcpTool.name}' is exposed by both '${firstOwner}' and '${serverId}'. ` +
                          `Tool names must be unique across all connected servers within a step.`,
                        {
                          code: 'MCP_TOOL_NAME_COLLISION',
                          category: 'ENGINE',
                          agentAction: 'stop',
                          retryable: false,
                        },
                      );
                    }
                    barenameOwner.set(mcpTool.name, serverId);
                    toolDefs.push({
                      id: `${serverId}:${mcpTool.name}`,
                      serverId,
                      name: mcpTool.name,
                      description: mcpTool.description,
                      inputSchema: mcpTool.inputSchema,
                    });
                  }
                }

                // ---------------------------------------------------------------------------
                // issue #311 — per-tool strict selection. Gated on TWO things:
                //   1. the step's own strict declaration — a step that never opted in takes none of
                //      this, so its `toolDefs` array (contents AND order) reaches the provider
                //      byte-identical to pre-#311; and
                //   2. the PROVIDER's `toolArgsStrict` capability. Marking tools is only
                //      meaningful for a provider that actually reads `ToolDefinition.strict` and
                //      threads it onto the request. BOTH in-repo tool-capable providers now do
                //      (Anthropic on the tool object, OpenAI inside `function`); a third-party
                //      `--provider-module` that does not would otherwise get `strict_sent: true`
                //      evidence against a wire carrying nothing — the falsity this guard exists to
                //      prevent. Conservative by default: an absent capability reads as false, so
                //      such modules are safe without declaring anything, and the conformance suite
                //      holds each declarer to actually placing it on the wire.
                // ---------------------------------------------------------------------------
                if (stepDef.structured_output === 'strict' && !strictCapable) {
                  // The provider cannot consume the marker. Do NOT re-sort (the wire keeps its
                  // as-built server order — the pre-#311 shape for these providers), do NOT mark,
                  // and deliberately do NOT run the eligibility walk: those verdicts encode the
                  // ANTHROPIC strict profile, so reporting their reasons/caveats for a provider
                  // that could never send strict anyway would be misleading precision.
                  //
                  // Evidence still lands, and it is the honest version: one entry per DECLARED
                  // tool, in DECLARED order (the run-record contract), each saying plainly that
                  // strict was requested and not sent because this provider does not support it.
                  // The entries are built from a SORTED COPY — the wire array itself must stay in
                  // as-built order, so entry order and wire order legitimately differ here.
                  const declaredIndex = new Map(stepDef.tools.map((id, i) => [id, i]));
                  const declaredOrder = [...toolDefs].sort(
                    (a, b) =>
                      (declaredIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                      (declaredIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
                  );
                  for (const tool of declaredOrder) {
                    toolArgsEntries.push({
                      name: tool.name,
                      strict_requested: true,
                      strict_sent: false,
                      reasons: ['provider_unsupported'],
                    });
                  }
                } else if (stepDef.structured_output === 'strict' && gate !== undefined) {
                  // issue #313 — the ENDPOINT gate, on the tools dimension. Ordered AFTER the
                  // capability arm on purpose (D-3 precedence): a provider that cannot consume the
                  // marker reports `provider_unsupported` even when it also carries a gate, because
                  // "this provider never sends strict" is the more fundamental fact and the two
                  // literals must never conflate.
                  //
                  // Same shape as the arm above — declared-order entries from a sorted copy, wire
                  // untouched, no walk — because the reason is likewise endpoint-level, not
                  // per-schema: assessing tools here would report eligibility findings about
                  // schemas that were never going to be sent strict at all.
                  const declaredIndex = new Map(stepDef.tools.map((id, i) => [id, i]));
                  const declaredOrder = [...toolDefs].sort(
                    (a, b) =>
                      (declaredIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                      (declaredIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
                  );
                  for (const tool of declaredOrder) {
                    toolArgsEntries.push({
                      name: tool.name,
                      strict_requested: true,
                      strict_sent: false,
                      reasons: ['compat_endpoint'],
                    });
                  }
                } else if (stepDef.structured_output === 'strict') {
                  // Re-sort into the author's DECLARED order. The assembly above walks server by
                  // server, so the wire order otherwise depends on MCP server grouping and each
                  // server's own listing order — neither of which the author controls. The budget
                  // walk below is order-sensitive (it is greedy), so "which tools got strict" must
                  // be a function of something the author can see and reorder: their own list.
                  const declaredIndex = new Map(stepDef.tools.map((id, i) => [id, i]));
                  toolDefs.sort(
                    (a, b) =>
                      (declaredIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                      (declaredIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
                  );

                  const sticky = toolArgsSticky.get(stepName);
                  // The API's own per-request limits. NOTE: the 20 here is the strict-tool cap and
                  // has nothing to do with `maxToolCalls`'s unrelated default of 20 — never conflate.
                  const MAX_STRICT_TOOLS = 20;
                  const MAX_SUMMED_OPTIONALS = 24;
                  let strictCount = 0;
                  let optionalSum = 0;

                  for (const tool of toolDefs) {
                    const verdict = assessStructuredOutputEligibility({
                      schema: tool.inputSchema,
                      tools: false,
                      subject: 'tool_args',
                      profile,
                    });
                    const caveats =
                      verdict.verdict === 'ineligible'
                        ? (verdict.caveats ?? []).map((c) => c.code)
                        : verdict.verdict === 'eligible_with_caveats'
                          ? verdict.caveats.map((c) => c.code)
                          : [];
                    const entry: (typeof toolArgsEntries)[number] = {
                      name: tool.name,
                      strict_requested: true,
                      strict_sent: false,
                      ...(caveats.length > 0 ? { caveats } : {}),
                    };

                    if (verdict.verdict === 'ineligible') {
                      // Ineligible tools consume ZERO budget: the API's 24-optional sum spans the
                      // schemas strict is actually ATTACHED to, so charging a tool that never gets
                      // strict would starve later, eligible tools for no reason.
                      entry.reasons = verdict.reasons.map((r) => r.code);
                    } else if (sticky !== undefined) {
                      // A previous attempt for this step took a live 400. Re-sending the same
                      // schemas would earn the same rejection, so this attempt starts unconstrained
                      // and every eligible tool reports the ORIGINAL reason verbatim.
                      entry.reasons = [sticky.reason];
                    } else if (profile === 'openai') {
                      // issue #313: NO budget walk under the OpenAI profile. Anthropic publishes a
                      // 20-strict-tool and 24-summed-optional per-request budget; OpenAI publishes
                      // NEITHER (executed: 128 strict tools in one request ⇒ 200, and the only
                      // ceiling found is the generic 128-element tools ARRAY cap, which authoring
                      // hits long before this walk would). So every eligible tool is marked, and
                      // `budget_excluded` is never minted under this profile — inventing a budget
                      // here would withhold strict for a limit that does not exist.
                      tool.strict = true;
                      entry.strict_sent = true;
                    } else {
                      // Greedy-skip in declared order, INCLUSIVE boundaries (landing exactly on a
                      // limit fits). A tool that doesn't fit is SKIPPED and the walk CONTINUES —
                      // stopping at the first miss would let one fat schema disable strict for
                      // every tool behind it.
                      const optionals = verdict.optional_count ?? 0;
                      if (
                        strictCount + 1 <= MAX_STRICT_TOOLS &&
                        optionalSum + optionals <= MAX_SUMMED_OPTIONALS
                      ) {
                        tool.strict = true;
                        entry.strict_sent = true;
                        strictCount += 1;
                        optionalSum += optionals;
                      } else {
                        entry.reasons = ['budget_excluded'];
                      }
                    }
                    toolArgsEntries.push(entry);
                  }
                }

                const baseExecutor: ToolExecutor = async (namespacedName, args) => {
                  const [serverId, toolName] = namespacedName.split(':') as [string, string];
                  return mcpClient!.call(serverId, toolName, args);
                };

                // Wrap the executor to enforce max_fan_out when set.
                // Counts calls to start_run and start_run_batch (regardless of server prefix).
                let fanOutCallCount = 0;
                const maxFanOut = stepDef.max_fan_out;
                const executor: ToolExecutor = async (namespacedName, args) => {
                  const toolName = namespacedName.includes(':')
                    ? namespacedName.split(':')[1]!
                    : namespacedName;
                  if (toolName === 'start_run' || toolName === 'start_run_batch') {
                    fanOutCallCount += 1;
                    if (maxFanOut !== undefined && fanOutCallCount > maxFanOut) {
                      throw new WorkflowError(
                        `max_fan_out of ${maxFanOut} reached for step '${stepName}'. ` +
                          `No further start_run or start_run_batch calls are permitted in this step.`,
                        {
                          code: 'VALIDATION_BATCH_TOO_LARGE',
                          category: 'VALIDATION',
                          agentAction: 'provide_input',
                          retryable: false,
                        },
                      );
                    }
                  }
                  return baseExecutor(namespacedName, args);
                };

                if (!isToolCapable(deps.provider)) {
                  throw new Error(
                    'invariant: provider lost tool capability between startup and step execution',
                  );
                }
                // #robust-anthropic-provider Part 1: same output-over-input precedence as the callStep
                // path above. This EFFECTIVE-OUTPUT schema still feeds ONLY the submit tool + system
                // prompt (unchanged) — issue #224 [gate] SCHEMA-ROUTING PIN: do NOT repoint it at the
                // newly-separated raw schemas below.
                const toolsEffectiveOutputSchema =
                  (stepDef.output_schema as Record<string, unknown> | undefined) ??
                  (stepDef.input_schema as Record<string, unknown> | undefined);
                // Gap 1, unit A2b: from here on a throw is the provider call's.
                toolsProviderCalled = true;
                toolsResult = await deps.provider.callStepWithTools(
                  promptForAttempt,
                  toolDefs,
                  executor,
                  {
                    llmClock,
                    ...(toolsEffectiveOutputSchema !== undefined
                      ? { inputSchema: toolsEffectiveOutputSchema }
                      : {}),
                    // issue #224 (D2): the RAW schemas, separate from the effective-output schema
                    // above — consumed ONLY by the in-conversation validateAgentSubmission
                    // correction loop (never the submit tool / system prompt).
                    ...(stepDef.input_schema !== undefined
                      ? {
                          validationInputSchema: stepDef.input_schema as Record<string, unknown>,
                        }
                      : {}),
                    ...(stepDef.output_schema !== undefined
                      ? {
                          validationOutputSchema: stepDef.output_schema as Record<string, unknown>,
                        }
                      : {}),
                    maxToolCalls: stepDef.max_tool_calls ?? 20,
                    ...(stepDef.max_fan_out !== undefined
                      ? { maxFanOut: stepDef.max_fan_out }
                      : {}),
                    toolTimeoutMs: (stepDef.tool_timeout ?? 30) * 1000,
                    ...(agentProfileInstructions !== undefined ? { agentProfileInstructions } : {}),
                    ...cachePrefix,
                    ...stepCache,
                  },
                );
              } catch (err) {
                console.error(`\n✗ Step '${stepName}' (tools) failed: ${safeErrorText(err)}`);
                // issue #676: the provider's own one-sentence explanation, when it has one.
                const explainedTools = safeExplainFailure(deps.provider, err);
                if (explainedTools !== undefined) console.error(`  ${explainedTools}`);
                // issue #401, CHOKEPOINT (1): recorded AFTER the original line, never instead of
                // it. Returns rather than throws, which is what makes double-minting structurally
                // impossible — the last-resort catch below never sees this path.
                // issue #610: as the single-shot catch does, the calls this step's earlier #217
                // repair attempts already billed go in front of the throwing call's own (wire
                // order). `err` itself is never mutated.
                const entry = buildEntry(
                  err,
                  stepName,
                  providerForEvidence ?? 'unknown',
                  attemptStartedAt,
                  deps.store.clock.now(),
                );
                // Caching 3-M (piece A-1): the throwing call's first request, when it is the step's
                // first in the drive, takes the copy of its predecessor (`recordedBefore`).
                if (Array.isArray(entry.usage)) {
                  entry.usage = attachRecordedReference(
                    usageForStep,
                    entry.usage,
                    recordedBefore(stepName),
                  );
                }
                // Gap 1, unit A2b: the texts of the requests this entry's usage lists, and any
                // unanswered one, joined before the step's earlier calls are put in front.
                const toolsTexts = failedCallTexts(err, entry.usage, toolsProviderCalled);
                entry.model_text = failureText(toolsTexts);
                if (usageForStep !== undefined && usageForStep.length > 0) {
                  entry.usage = appendRequests(usageForStep, entry.usage);
                }
                // Gap 2, unit (i-b): the step's failed model tries, closed as on its evidence.
                const toolsTries = triesOf(retryForStep);
                if (toolsTries !== undefined) entry.model_attempts = toolsTries;
                // Gap 2, unit (ii-b2): `fail` settles the step through `executeChain` below, with
                // this entry's texts, usage (ids minted once, by `buildEntry`) and tries.
                const toolsFailure = modelFailureOf(err, entry, toolsProviderCalled);
                if (toolsFailure !== undefined) {
                  member = { modelFailure: toolsFailure, entry };
                  usageForStep = entry.usage;
                  textsForStep = toolsTexts;
                  stepInput = {};
                  break toolsStep;
                }
                await recordFailure(entry);
                if (held !== undefined) held.cause = 'step_failed';
                return 'failed';
              }
              stepInput = toolsResult.output;
              // issue #610: `?? []` is load-bearing, as on the single-shot paths. A model call
              // HAPPENED, so the record must say `unobservable`, not stay silent. A provider that
              // reports nothing (a third-party module) would otherwise leave `cache` absent. Each
              // #217 repair pass appends its requests, so a repaired step records every call it
              // paid for, in wire order.
              // Caching 3-M (piece A-1): after the mint, the step's first request in the drive takes
              // the copy of its predecessor, when one was found (`recordedBefore`).
              // Gap 1, unit A1: each id copied onto its request's text before the append.
              const mintedTools = mintRequestIds(toolsResult.usage ?? []);
              textsForStep = appendModelTexts(
                textsForStep,
                joinModelTexts(mintedTools, toolsResult.modelText),
              );
              usageForStep = appendRequests(
                usageForStep,
                attachRecordedReference(usageForStep, mintedTools, recordedBefore(stepName)),
              );
              toolCallsForMeta = toolsResult.toolCalls;
              // issue #332 item 6: the tools path never consumes structuredOutputPlan (there is no
              // grammar-constrained OUTPUT call here — the tools path's strict is #311's per-tool
              // argument strict), so a strict-DECLARED, tools-bearing step used to leave
              // structuredOutputMetaForStep undefined — falling through to execution-loop.ts's
              // synthesized `external_agent` stamp, which claims "realm made no request at all".
              // That's a misattribution: realm's OWN agent DID drive this step, via the tools path,
              // which structurally cannot honor strict. Mint the honest, distinct reason here
              // instead of letting the engine synthesize the wrong one.
              //
              // NOT a ladder outcome — deliberately does NOT touch structuredOutputSticky. Sticky
              // exists to remember a LIVE downgrade across repair-loop attempts for the SAME step
              // (armed only at the live-downgrade sites below, :698-702/:736-740 in the non-tools
              // branch); this is a per-step STRUCTURAL fact (declares `tools`) that is identical on
              // every attempt and needs no memory across attempts.
              if (stepDef.structured_output === 'strict') {
                structuredOutputMetaForStep = {
                  requested: true,
                  sent: false,
                  downgrade_reason: 'unsupported_context_tools',
                };
              }

              // issue #311 — the TOOL-ARGUMENTS evidence block. COEXISTS with the #332 mint above,
              // which is left exactly as it was: that mint states the OUTPUT-dimension truth (this
              // step's own answer was not grammar-constrained), and it stays true no matter how many
              // tools carried strict. This block adds the independent per-tool story.
              if (stepDef.structured_output === 'strict' && toolArgsEntries.length > 0) {
                // The drop machinery is capability-gated too. On the capability-false arm strict was
                // never attached, so there is nothing to drop: a (misbehaving or future) provider
                // reporting one must not be able to mint a `dropped_mid_attempt` record, flip any
                // entry, or arm the sticky map — the run-record contract says that record is absent
                // on an attempt that never attached strict.
                // issue #313 extends the #350 conjunct with the gate: on a gated endpoint strict
                // was never attached either, so a reported drop must not mint a record here.
                const drop =
                  strictCapable && gate === undefined ? toolsResult.toolArgsStrictDrop : undefined;
                if (drop !== undefined) {
                  // DROP TRUTH: flip ONLY the entries strict was actually attached to. An entry that
                  // was ineligible or budget-excluded never carried strict, so the drop says nothing
                  // about it — overwriting its reasons here would erase why it was really skipped.
                  for (const entry of toolArgsEntries) {
                    if (!entry.strict_sent) continue;
                    entry.strict_sent = false; // `strict_sent` = FINAL posture of the attempt
                    entry.reasons = [drop.reason];
                  }
                }
                structuredOutputMetaForStep = {
                  ...structuredOutputMetaForStep,
                  requested: true,
                  tool_args: {
                    tools: toolArgsEntries,
                    // PER-ATTEMPT, and absent on a sticky attempt by construction: a sticky attempt
                    // never attaches strict, so the provider has nothing to drop and reports no
                    // drop. `api_message` lives here, never on the step-level meta.
                    ...(drop !== undefined ? { dropped_mid_attempt: drop } : {}),
                  },
                };
                // Arm the tool-args sticky on a 400 ONLY (see the map's own comment for why a 503
                // deliberately does not arm it).
                if (drop?.reason === 'api_rejected_schema' && !toolArgsSticky.has(stepName)) {
                  toolArgsSticky.set(stepName, {
                    reason: drop.reason,
                    ...(drop.api_message !== undefined ? { api_message: drop.api_message } : {}),
                  });
                }
              }
            } else {
              // issue #401: the outer two-attempt retry loop is RETIRED. It silently rescued
              // transient failures by calling again — which is exactly why a failing drive left
              // no trace: the first failure was swallowed and the second one exited. A single
              // attempt now, with the failure RECORDED; re-attaching is the retry.
              // Gap 1, unit A2b: whether the throw below is the provider call's, as on the tools path.
              let bareProviderCalled = false;
              try {
                if (structuredOutputPlan !== undefined) {
                  // issue #236: the declared-step path — always call callStepWithMeta so the
                  // synthesis rule (design §5 [R2-3]) can distinguish a genuinely-absent meta
                  // (third-party provider ⇒ provider_unsupported) from a gate/sticky decision
                  // that never even attempted a call.
                  // Gap 1, unit A2b: from here on a throw is the provider call's.
                  bareProviderCalled = true;
                  const callOnce = () =>
                    deps.provider.callStepWithMeta(
                      promptForAttempt,
                      inputSchema,
                      agentProfileInstructions,
                      {
                        structuredOutputStrict: structuredOutputPlan.send,
                        llmClock,
                        ...cachePrefix,
                        ...stepCache,
                      },
                    );
                  const { output, meta, usage, modelText } =
                    wholeCallRetry !== undefined
                      ? await tryModelRequest(wholeCallRetry, {}, llmClock, callOnce)
                      : await callOnce();
                  stepInput = output;
                  // issue #600 PR 1a: `?? []` is load-bearing. A model call HAPPENED, so the
                  // record must say `unobservable`, not stay silent. A provider that reports
                  // nothing (the base default, any third-party module) would otherwise leave
                  // `cache` absent — and absent means nothing was recorded, which a handler step
                  // also produces; see StepDiagnostics.cache.
                  // Repair calls now accumulate: each #217 repair pass appends its requests, so a
                  // repaired step records every call it paid for, in wire order.
                  // Caching 3-M (piece A-1): the first request's predecessor, as at S1.
                  // Gap 1, unit A1: each id copied onto its request's text before the append.
                  const minted = mintRequestIds(usage ?? []);
                  textsForStep = appendModelTexts(textsForStep, joinModelTexts(minted, modelText));
                  usageForStep = appendRequests(
                    usageForStep,
                    attachRecordedReference(usageForStep, minted, recordedBefore(stepName)),
                  );
                  if (structuredOutputPlan.ineligibleMeta !== undefined) {
                    // Gate-ineligible or sticky — strict was never attempted this call at all.
                    structuredOutputMetaForStep = structuredOutputPlan.ineligibleMeta;
                  } else if (meta !== undefined) {
                    structuredOutputMetaForStep = {
                      ...meta,
                      ...(structuredOutputPlan.caveats !== undefined
                        ? { caveats: structuredOutputPlan.caveats }
                        : {}),
                    };
                    // Arm sticky the FIRST time THIS step downgrades (never re-arm from a
                    // gate_ineligible meta — that's not a live-API downgrade to remember).
                    if (
                      meta.sent === false &&
                      meta.downgrade_reason !== undefined &&
                      meta.downgrade_reason !== 'gate_ineligible' &&
                      !structuredOutputSticky.has(stepName)
                    ) {
                      structuredOutputSticky.set(stepName, {
                        downgrade_reason: meta.downgrade_reason,
                        ...(meta.api_message !== undefined
                          ? { api_message: meta.api_message }
                          : {}),
                      });
                    }
                  } else {
                    // The base LlmProvider default returned no meta at all — a third-party
                    // provider that never overrides callStepWithMeta.
                    structuredOutputMetaForStep = {
                      requested: true,
                      sent: false,
                      downgrade_reason: 'provider_unsupported',
                    };
                  }
                } else {
                  // issue #600 PR 1a (A3): the bare arm is re-routed through callStepWithMeta so a
                  // step that declares NO structured_output still reports what its wire requests
                  // cost. The request is byte-identical — this method's only extra input is
                  // `structuredOutputStrict`, which is not passed here. `meta` is DELIBERATELY not
                  // destructured: a third-party provider that overrides callStepWithMeta must not
                  // be able to stamp a structured_output disclosure on a step that declared none.
                  // Gap 1, unit A2b: from here on a throw is the provider call's.
                  bareProviderCalled = true;
                  const callOnce = () =>
                    deps.provider.callStepWithMeta(
                      promptForAttempt,
                      inputSchema,
                      agentProfileInstructions,
                      { llmClock, ...cachePrefix, ...stepCache },
                    );
                  const { output, usage, modelText } =
                    wholeCallRetry !== undefined
                      ? await tryModelRequest(wholeCallRetry, {}, llmClock, callOnce)
                      : await callOnce();
                  stepInput = output;
                  // issue #600 PR 1a: `?? []` is load-bearing. A model call HAPPENED, so the
                  // record must say `unobservable`, not stay silent. A provider that reports
                  // nothing (the base default, any third-party module) would otherwise leave
                  // `cache` absent — and absent means nothing was recorded, which a handler step
                  // also produces; see StepDiagnostics.cache.
                  // Repair calls now accumulate: each #217 repair pass appends its requests, so a
                  // repaired step records every call it paid for, in wire order.
                  // Caching 3-M (piece A-1): the first request's predecessor, as at S1.
                  // Gap 1, unit A1: each id copied onto its request's text before the append.
                  const minted = mintRequestIds(usage ?? []);
                  textsForStep = appendModelTexts(textsForStep, joinModelTexts(minted, modelText));
                  usageForStep = appendRequests(
                    usageForStep,
                    attachRecordedReference(usageForStep, minted, recordedBefore(stepName)),
                  );
                }
              } catch (err) {
                // The catch-side sticky-arming block that used to live here is DELETED as dead
                // code: this catch returns 'failed' immediately, the sticky map is
                // per-invocation, and nothing later reads it. The SUCCESS-path arming site
                // above is the one that serves the #217 repair loop, and it is untouched.
                console.error(`\n✗ Step '${stepName}' LLM call failed: ${safeErrorText(err)}`);
                // issue #676: the provider's own one-sentence explanation, when it has one.
                const explained = safeExplainFailure(deps.provider, err);
                if (explained !== undefined) console.error(`  ${explained}`);
                // issue #600: `buildEntry` sees only the THROWING call's own `driveCall.usage`, so
                // the calls this step's earlier schema-repair passes already billed are put in
                // front of it (wire order). `err` itself is never mutated.
                const entry = buildEntry(
                  err,
                  stepName,
                  providerForEvidence ?? 'unknown',
                  attemptStartedAt,
                  deps.store.clock.now(),
                );
                // Caching 3-M (piece A-1): the throwing call's first request, when it is the step's
                // first in the drive, takes the copy of its predecessor (`recordedBefore`).
                if (Array.isArray(entry.usage)) {
                  entry.usage = attachRecordedReference(
                    usageForStep,
                    entry.usage,
                    recordedBefore(stepName),
                  );
                }
                // Gap 1, unit A2b: as at chokepoint (1).
                const bareTexts = failedCallTexts(err, entry.usage, bareProviderCalled);
                entry.model_text = failureText(bareTexts);
                if (usageForStep !== undefined && usageForStep.length > 0) {
                  entry.usage = appendRequests(usageForStep, entry.usage);
                }
                // Gap 2, unit (i-b): the step's failed model tries, closed as on its evidence.
                const bareTries = triesOf(retryForStep);
                if (bareTries !== undefined) entry.model_attempts = bareTries;
                // Gap 2, unit (ii-b2): as on the tools path; the call below follows this catch.
                const bareFailure = modelFailureOf(err, entry, bareProviderCalled);
                if (bareFailure === undefined) {
                  await recordFailure(entry);
                  if (held !== undefined) held.cause = 'step_failed';
                  return 'failed';
                }
                member = { modelFailure: bareFailure, entry };
                usageForStep = entry.usage;
                textsForStep = bareTexts;
                stepInput = {};
              }
            }
          }

          // issue #313 — the PROVENANCE chokepoint. Every path above that mints a
          // `structuredOutputMetaForStep` (gate, sticky, compat, live ladder, tools mint, the
          // provider_unsupported synthesis) funnels through here, so stamping the provider once at
          // this single point covers them all and cannot be forgotten on a new arm. The engine's
          // OWN synthesized `external_agent` stamps never pass through here and therefore carry no
          // provider — correctly, since realm did not drive those attempts.
          if (structuredOutputMetaForStep !== undefined && providerForEvidence !== undefined) {
            structuredOutputMetaForStep = {
              ...structuredOutputMetaForStep,
              provider: providerForEvidence,
            };
          }

          // #729 PR-3 (D1 D5): the model was shown masked text; an answer that sends a marker back is
          // recorded as sent — and said so.
          const sentBack = markersIn(stepInput);
          if (sentBack.length > 0) console.warn(`  ⚠ ${inboundMarkerWarning(sentBack)}`);
          // #729 CW-5a correction 1: from a signal's stop cause on, no save either (once the handler
          // has given the claim back, a save would take the step again, under no claim of this drive).
          if (stopCause !== undefined) await halt();
          // #625 A1a: re-seeded for each call, each repair attempt included.
          chainStartedNotDone = stepName;
          // #729 CW-5a: the held step's own save in flight, which a signal waits for. It settles at
          // the chain's first callback (the step's save is done before the chain runs anything after
          // it), at the call's return, or from the outer `finally` when the call throws.
          saving = new Promise<void>((resolve) => (endSave = resolve));
          result = await executeChain(deps.store, definition, {
            runId,
            command: stepName,
            // #729 CW-5a: saved under the claim this drive holds.
            ...(held !== undefined && held.step === stepName
              ? { heldClaim: { hold: held.hold } }
              : {}),
            // #625 A1a: the steps the chain runs after this one, printed as the advanceRun path
            // prints them. `currentStepName` and `attemptStartedAt` stay this step's: chokepoint 3
            // attaches this step's billed calls by them.
            onStep: (step) => {
              endSave();
              if (chainStartedNotDone !== undefined)
                console.log(`  ✓ → ${writerCtx().word('running', RUN_PHASE_WORDS)}`);
              chainStartedNotDone = step;
              console.log(`→ [auto] ${step}`);
            },
            onTaken: (step, record, snapshot: Pick<Snapshot, 'lease_facts'> = NO_SNAPSHOT) => {
              endSave();
              chainStartedNotDone = undefined;
              console.log(
                takenLine(
                  step,
                  describeClaimHolder(
                    record.claims?.[step],
                    keepsClaims,
                    leaseFactOf(snapshot, record.claims?.[step]),
                  ),
                  writerCtx(),
                ),
              );
            },
            onNotRecorded: (
              step,
              kind,
              record,
              snapshot: Pick<Snapshot, 'lease_facts'> = NO_SNAPSHOT,
            ) => {
              endSave();
              chainStartedNotDone = undefined;
              console.log(
                outcomeNotRecordedLine(kind, record, step, keepsClaims, writerCtx(), snapshot),
              );
            },
            // #729 PR-4 (01): a question this call opens is minted with the writer's private set.
            ...((set) => (set !== undefined ? { disclosure: set } : {}))(writerSetFor('private')),
            // decision C151: an expiry this call carries out names `realm agent`.
            caller: 'agent',
            input: stepInput,
            // Gap 2, unit (ii-b2): the step fails through its model request's failure.
            ...(member !== undefined ? { modelFailure: member.modelFailure } : {}),
            // #729 PR-3 (RECORD 01 #15): the input the ENGINE passes — `_debug` stripped (recorded
            // apart as `debug_output`) — never the closed-over one (same key = same caller).
            dispatcher: async (_command, input) => input,
            registry: deps.registry,
            ...(deps.traceBufferStore !== undefined
              ? { traceBufferStore: deps.traceBufferStore }
              : {}),
            // issue #625 (holder slice): the program this driver runs in — the claim's `holder`,
            // the evidence's `driven_by`. After `traceBufferStore`, as at every host call site.
            ...(deps.driver !== undefined ? { driver: deps.driver } : {}),
            // issue #236: stepMeta now ALSO passes when structuredOutput exists (previously only
            // passed when toolCalls existed) — the two are independent, either alone must thread.
            // issue #600 PR 1a: `usage` is the THIRD independent member. A cs1-shaped step (no
            // tools, no structured output) passed NO stepMeta at all before this, so its usage was
            // computed and dropped right here at the boundary.
            // Gap 2, unit (ii-b2): texts alone too (an unbilled failure under `modelFailure` keeps
            // its unanswered request); a successful call's texts come with its usage.
            ...(toolCallsForMeta !== undefined ||
            structuredOutputMetaForStep !== undefined ||
            usageForStep !== undefined ||
            textsForStep !== undefined ||
            triesOf(retryForStep) !== undefined
              ? {
                  stepMeta: {
                    // Gap 2, unit (i-b): the step's failed model tries, when a try failed.
                    ...((modelAttempts) => (modelAttempts !== undefined ? { modelAttempts } : {}))(
                      triesOf(retryForStep),
                    ),
                    // Gap 1, unit A1: the texts of the calls whose usage is below, or the marker.
                    ...((modelText) => (modelText !== undefined ? { modelText } : {}))(
                      modelTextOf(textsForStep, deps.recordModelText !== false),
                    ),
                    ...(toolCallsForMeta !== undefined ? { toolCalls: toolCallsForMeta } : {}),
                    ...(structuredOutputMetaForStep !== undefined
                      ? { structuredOutput: structuredOutputMetaForStep }
                      : {}),
                    // issue #600 PR 2 (C4): each request carries the provider that served it,
                    // stamped here from the drive's one provenance source, over anything an
                    // adapter or a provider module wrote.
                    ...(usageForStep !== undefined
                      ? { usage: stampRequestProvider(usageForStep, providerForEvidence) }
                      : {}),
                  },
                }
              : {}),
            // issue #197 PR-2: a FRESH nonce per step-attempt — resolved per call, never cached, so
            // the strict-flip (checked inside shouldMintWriterNonce) is honored even if the env var
            // changes mid-process (tests flip it). Also fresh per issue #217 repair attempt, since
            // this call sits inside the repair loop.
            ...(shouldMintWriterNonce(deps) ? { writerNonce: crypto.randomUUID() } : {}),
          });
          endSave();
          saving = undefined;

          // The follow-up to #625 PR-2a round 20's finding 3: `executeChain` answers a run it cannot read
          // with an error reply that names no run phase (no run was read) where it used to throw. The
          // drive's store is failing, as when a read of the drive's own throws: it is raised here,
          // inside the attempt, so the last-resort catch (chokepoint 3) records the step's billed calls
          // (nothing was saved) and the failure propagates — the drive's exit 4, as before. A run that
          // no longer exists keeps its reply and the step's failure line, as before.
          if (
            result.status === 'error' &&
            result.run_phase === undefined &&
            result.error_code !== undefined &&
            result.error_code !== 'STATE_RUN_NOT_FOUND'
          ) {
            throw new WorkflowError(result.errors.join(', '), {
              code: result.error_code,
              category: result.error_code.split('_')[0] as ErrorCategory,
              agentAction: result.intrinsic_action ?? 'stop',
              retryable: false,
              stepId: stepName,
            });
          }

          // issue #217: the in-drive schema-feedback repair gate. Fires ONLY when ALL SIX conjuncts
          // hold — see plans/issue-217/design-v2.md §Mechanism for the rationale on (i)-(v).
          //
          // Conjunct (vi) — CORRECTED from the design record's literal `result.command === stepName`
          // (flagged as a divergence in the implementation report): the record's premise was that
          // executeChain "returns the DEEPER step's own envelope" on a chain-replacement error,
          // citing execution-loop.ts:2855-2859/:3015 (executeChainInternal's recursive early-return,
          // which DOES set `command` to the deeper step). But run-agent.ts calls the PUBLIC
          // `executeChain` wrapper, not executeChainInternal directly — and that wrapper
          // unconditionally overwrites the returned envelope's `command` back to the TOP-LEVEL
          // requested command on every call (execution-loop.ts:3094, `command: options.command`),
          // confirmed empirically against the built engine. So `result.command` always equals
          // `stepName` here and can never discriminate a deeper chained step's error from this step's
          // own — the literal conjunct is vacuously true and provides zero protection.
          //
          // The corrected, structurally-sound discriminator: a pre-claim validation rejection is
          // write-free (no run-record version bump — see execute-step.ts:77-80 / execution-loop.ts's
          // Step 2b/2c, both before claimStep). So if `result.run_version` has advanced past
          // `versionBeforeAttempt` (captured fresh at the top of each repair attempt), something
          // committed to the run BEFORE this error occurred — e.g. THIS step's own claim+settle,
          // followed by a DEEPER chained step's pre-claim rejection — so the error cannot be this
          // step's own output/input. A concurrent external writer bumping the run mid-attempt also
          // lands here — the gate then fails CLOSED (repair forfeited, today's failure path). See
          // run-agent.test.ts's "chained-auto no-false-repair" and concurrent-writer tests.
          //
          // issue #220 (SHIPPED): countRejection now persists a bounded rejection counter via a
          // real CAS write on a counted rejection — rejected attempts are NO LONGER write-free w.r.t.
          // the run record. What keeps this conjunct sound anyway is bump-and-report: the write's
          // return value is discarded, and the rejection's own ENVELOPE keeps reporting the
          // PRE-write version (the Step-1 `run`), so `result.run_version` still equals
          // `versionBeforeAttempt` here across repairs 2..N. Pin (a) (bump-and-report) guards this
          // invariant — see execution-loop.ts's countRejection for the mechanism, and
          // packages/core/src/engine/validation-exhaustion.test.ts's pin (a) for the pin.
          if (
            result.status === 'error' &&
            (result.error_code === 'VALIDATION_OUTPUT_SCHEMA' ||
              result.error_code === 'VALIDATION_INPUT_SCHEMA') &&
            stepDef.execution === 'agent' &&
            (toolCallsForMeta === undefined || toolCallsForMeta.length === 0) &&
            repairsUsed < schemaRetries &&
            member === undefined &&
            // issue #401: a duplicate attached writer's version bump forfeits the repair BY
            // DESIGN (record R-3). The error-code-keyed mint below still records the wedge
            // truthfully, so forfeiting a repair never costs the operator the visibility.
            result.run_version === versionBeforeAttempt
          ) {
            repairsUsed++;
            // issue #759 (Part D.2): the refusal's list and its total, through core's one reader
            // (the two validation codes carry them as typed `error.facts`, not `error_details`).
            const list = validationListOf(result);
            const record = buildFailedAttemptRecord({
              run_id: runId,
              workflow_id: definition.id,
              step_id: stepName,
              ts: sidecarStamp(),
              error_code: result.error_code,
              ajv_errors: list !== undefined ? [...list.errors] : [],
              ...(list?.error_count !== undefined ? { error_count: list.error_count } : {}),
              params: stepInput,
              trace_entry_count: 0,
            });
            lastRejection = {
              kind: result.error_code === 'VALIDATION_OUTPUT_SCHEMA' ? 'output' : 'input',
              // issue #759 (Part F): the LINES of the record's list, then `and N more` as read.
              summary: renderProblemsLines(
                record.validation_error_summary,
                moreOf(record) ?? 0,
              ).join('\n'),
            };
            console.error(
              `  ⚠ output rejected (${result.error_code}); repairing (attempt ${repairsUsed}/${schemaRetries})`,
            );
            continue;
          }

          break;
        }
        // #729 CW-5a: after the repair loop's last reply, the hold closes with that reply's record when
        // it no longer names the lease on the step (the save released it, or another program's act
        // removed it), or the run ended (nothing can be written there). Still named: given back.
        if (held !== undefined && held.step === stepName) {
          if (stopCause !== undefined) await halt();
          const judged = judgedSnapshotOf(result);
          if (judged === undefined) {
            // A reply that loaded no run: the `finally` gives back by the record.
          } else if (
            !namesHeldLease(judged.record, held) ||
            judged.record.terminal_state === true
          ) {
            const own = namesHeldLease(judged.record, held);
            closeHold(judged.record);
            // An ended run keeps this drive's claim (nothing can be written to it): the reply is
            // judged without it, so no line names this drive as the step's holder.
            if (own) gaveBackFor = { reply: result, snapshot: withoutOwnClaim(judged, stepName) };
          } else {
            held.cause = 'engine_refused';
            // Not a validation wedge (a precondition the save refused, a question opened on another
            // step): given back now, and the reply judged on the record the give-back answered, where
            // the step is no longer this drive's. A wedge is given back by the `finally`, after its
            // drive-failure entry (chokepoint 4).
            const wedge =
              result.status === 'error' &&
              (result.error_code === 'VALIDATION_OUTPUT_SCHEMA' ||
                result.error_code === 'VALIDATION_INPUT_SCHEMA');
            if (!wedge) {
              // Gap 2, unit (ii-b2): the engine refused the failure's save (its store failed): said
              // before the give-back line, and the catch's entry is written below.
              if (member !== undefined && result.status === 'error') {
                console.error(memberNotSettledLine(stepName, result));
                memberRefusalSaid = true;
              }
              const released = await giveBack();
              // Correction 1: a give-back that threw leaves the claim, held by no program once this
              // drive ends; the reply is judged without it, as for an ended run, so no line names
              // this drive as the step's holder and the drive does not wait on itself.
              gaveBackFor = {
                reply: result,
                snapshot: released ?? withoutOwnClaim(judged, stepName),
              };
              // A question open on another step refused the save (open_gate's `gate_mismatch`, "wait
              // for its resolution"): the drive waits at that question (the loop's top), then runs the
              // step again, as when its claim was refused there before CW-5a.
              if (
                result.status === 'error' &&
                result.error_code === 'STATE_BLOCKED' &&
                released?.record.pending_gate !== undefined
              ) {
                hold(released);
                continue;
              }
            }
          }
        }
        // issue #600: set AFTER the repair loop, never inside it. A rejected attempt's
        // `executeChain` saves nothing, so a flag set there would claim a save that never
        // happened and a throw on the next attempt would lose every billed call.
        stepUsageSaved = true;
        // decision C189: the answers this drive gave, from what its own engine call recorded — on
        // every reply branch below (the `✓` line, a question the answer opened, any other).
        if (engineReply === undefined && answerRecordedByCall(result, stepName)) {
          answeredHere.add(stepName);
        }

        // F7: an error reply read by core's classifier against the record the engine judged it on
        // (#715 (b), Amendment 4: never a second load; none when the reply loaded no run).
        const errorSnapshot = result.status === 'error' ? judgedOf(result) : undefined;
        const errorRecord = errorSnapshot?.record;
        const resultStop =
          errorRecord === undefined ? undefined : classifyStop(result, stepName, errorRecord);
        // #134: a NOT-REGISTERED handler or adapter, detected structurally (core's classifier, never
        // the message text) — the dispositions below, or the hold just after.
        const isCapabilityBlock = resultStop?.kind === 'capability_missing';

        // Gap 2, unit (ii-b2): the reply to a call that failed the step through `modelFailure`. When
        // it records this step as failed, the failure has its one home there (the settle released
        // the claim): the bullet line in place of the give-back. Any other reply records no failure,
        // so the catch's drive-failure entry is written, its line says what happened instead, and
        // the drive stops, as the catch would have.
        if (member !== undefined) {
          if (
            result.status === 'error' &&
            resultStop?.kind === 'failed' &&
            result.stopped_step === stepName
          ) {
            console.error(
              `• Step '${stepName}' failed (${result.error_code}): its model request failed, and the step has on_model_failure: fail.`,
            );
            if (errorSnapshot?.record.terminal_state === true) endingSaid = true;
            printResumeLine(errorSnapshot);
            return 'failed';
          }
          await recordFailure(member.entry);
          if (result.status === 'error' && resultStop?.kind === 'refused') {
            if (!memberRefusalSaid) console.error(memberNotSettledLine(stepName, result));
          } else {
            const judged = judgedOf(result)?.record ?? currentRun;
            console.log(
              outcomeNotRecordedLine(
                notRecordedKindOf(judged, stepName),
                judged,
                stepName,
                keepsClaims,
                writerCtx(),
                judgedOf(result) ?? currentSnap,
              ),
            );
          }
          return 'failed';
        }

        // decision C64 (the census): the chain after an agent step can reach an engine step that
        // cannot run here (capability). The agent step completed and the reply is the chained step's
        // block. Held instead of sent to the block below, as the loop top holds its own (decision
        // C23): the next pass names the blocked step once, the drive goes on with any ready agent
        // step, and its exit names the blocked step and what it needs. Keyed on `stopped_step`
        // (decision C73): the reply names the step it belongs to, so a value other than this step
        // means the engine ran that step after this one (and this one settled) — no record is read
        // to guess it.
        if (
          engineReply === undefined &&
          isCapabilityBlock &&
          result.stopped_step !== undefined &&
          result.stopped_step !== stepName
        ) {
          heldCapabilityReplies.set(result.stopped_step, result);
          hold(errorSnapshot!);
          // #625 A1a: this step's `✓` only while no chained step started (its `onStep` printed it
          // then); the blocked step was attempted, never finished.
          if (chainStartedNotDone === stepName) {
            console.log(`  ✓ → ${writerCtx().word(currentRun.run_phase, RUN_PHASE_WORDS)}`);
          }
          chainStartedNotDone = undefined;
          continue;
        }

        // Round 24's finding (C179's sentence made true), F7: the drive's own call for its agent step
        // was refused because another program got there first — read by core's classifier against
        // the record as it is now. Its settle of the answer was refused (`ran_here`: another process
        // settled the step, took it over, removed its claim — as `realm run reclaim --force` removes
        // it — or ended the run): the answer was not recorded, said as C179's line in the
        // classifier's kind, never `✗ … failed`. A claim refused because the run ended, a question
        // opened, or the step stopped being eligible (the claim's own re-check) ran nothing: as a
        // `blocked` reply does (decision C85), the drive goes on and its own end and question checks
        // speak. `stopped_step` names this step only on its own call's refusal: the same code from a
        // guard of the chain (a concurrent settle that diverged from its abort) names no step, and
        // keeps the stop below — this drive's answer was recorded there.
        if (engineReply === undefined && errorRecord !== undefined && isRaceStop(resultStop)) {
          hold(errorSnapshot!);
          if (resultStop.ran_here || resultStop.kind === 'run_ended') {
            console.log(
              answerNotRecordedLine(
                currentRun,
                stepName,
                keepsClaims,
                resultStop.kind as NotRecordedKind,
                writerCtx(),
                currentSnap,
              ),
            );
          }
          continue;
        }

        if (result.status === 'error') {
          // #134: a NOT-REGISTERED handler/adapter settles RECOVERABLY — the run is NOT failed, the step
          // is parked awaiting a capable runner. Detect structurally via error_code (not message text) and
          // print capability-aware guidance instead of a bare `✗ Step failed`. The return stays 'failed'
          // (no 'blocked' AgentRunResult variant, by design) — the distinction lives in the message.
          // issue #401: a capability block mints NO drive-failure entry — the `capability_block`
          // finding already owns this disclosure, and two findings for one fact is noise.
          // issue #217: append the repair count ONLY when at least one repair actually ran — never
          // "after 0 schema-repair attempts".
          //
          // issue #676 (review): `stopped_step` names the step whose own reply this is. When it is
          // not this step, the engine ran it AFTER this one (this step then settled, so its repairs,
          // if any, succeeded). The lines and the drive-failure entry below name the step that stopped.
          const laterStep =
            result.stopped_step !== undefined && result.stopped_step !== stepName
              ? result.stopped_step
              : undefined;
          const stoppedStep = laterStep ?? stepName;
          const ranAfter =
            laterStep !== undefined ? ` (run by the engine after '${stepName}' finished)` : '';
          const repairSuffix =
            repairsUsed > 0 && laterStep === undefined
              ? ` after ${repairsUsed} schema-repair attempts`
              : '';
          if (isCapabilityBlock) {
            hold(errorSnapshot!);
            const block = findCapabilityBlockedSteps(currentRun).find(
              (b) => b.step === stoppedStep,
            );
            const need =
              block !== undefined
                ? `${block.requirement.kind} '${block.requirement.name}'`
                : result.error_code === 'ENGINE_HANDLER_NOT_REGISTERED'
                  ? 'the missing handler'
                  : 'the missing adapter';
            console.error(
              `\n⚠ Step '${stoppedStep}'${ranAfter} is blocked: ${need} is not registered in this runner. ` +
                `The run is NOT ${writerCtx().word('failed', RUN_PHASE_WORDS)} — add ${need} and re-attach (\`${writerCtx().cmd(`realm agent --run-id ${runId} ${deps.reattachFlags ?? '--provider <provider> --model <model>'}`)}\`).`,
            );
          } else {
            console.error(
              `\n✗ Step '${stoppedStep}'${ranAfter} failed: ${result.errors.join(', ')}${repairSuffix}`,
            );
            // #625 A1b-2: the `✗` line of the step whose failure ended the run says how it ended.
            if (errorSnapshot?.record.terminal_state === true) endingSaid = true;
            // ═══ issue #401, CHOKEPOINT (4) — the disposition table, KEYED ON ERROR CODE ═══
            //
            // A validation rejection that reaches here has WEDGED the run: it settles nothing, so
            // there is no seal to carry the news and no evidence to read. Every OTHER
            // non-capability code SETTLES THE STEP — `failed_steps` plus the step's evidence are
            // the visibility, so recording those would duplicate a fact the run already tells.
            // (Not "either seals or is capability-owned": non-sealing envelopes exist, and a
            // settled step on a still-live run is the common case.)
            //
            // Deliberately NOT keyed on `repairsUsed`: every bypass of the repair gate — a
            // tools-path rejection, a concurrent writer's version bump, `schemaRetries: 0` —
            // arrives here with `repairsUsed === 0` and wedges just the same.
            //
            // An auto step refused on its input before its claim no longer arrives here (issue #625
            // PR-2a, decision C31): the drive's exit for a step that cannot run records that wedge
            // itself, with the same fields, before this block.
            if (
              result.error_code === 'VALIDATION_OUTPUT_SCHEMA' ||
              result.error_code === 'VALIDATION_INPUT_SCHEMA'
            ) {
              // issue #600: a wedge carries every call of the exhausted repair budget. Nothing is
              // attached when no call reported usage — the same rule as `attachBilledUsage`. Nor
              // when the rejection belongs to a step `executeChain` ran AFTER this one: this step
              // then saved first, with its calls, and attaching them here would count them twice.
              // Gap 1, unit A2b: the guard is asked once, and its one answer decides the usage and
              // the texts alike; a step that saved keeps its texts on its evidence entry only.
              const callsSaved =
                usageForStep !== undefined &&
                usageForStep.length > 0 &&
                (await callsAlreadyRecorded(stepName, usageForStep));
              // Gap 2, unit (i-b), correction 1: the step's failed model tries ride along under the
              // same answer, and only on the step's own wedge: a step's tries are on one record.
              const wedgeTries =
                !callsSaved && laterStep === undefined ? triesOf(retryForStep) : undefined;
              await recordFailure({
                ...validationWedgeEntry(
                  stoppedStep,
                  providerForEvidence ?? 'unknown',
                  result.errors,
                  attemptStartedAt,
                  deps.store.clock.now(),
                ),
                ...(usageForStep !== undefined && usageForStep.length > 0 && !callsSaved
                  ? { usage: usageForStep }
                  : {}),
                model_text: failureText(callsSaved ? undefined : textsForStep),
                ...(wedgeTries !== undefined ? { model_attempts: wedgeTries } : {}),
              });
            }
          }
          printResumeLine(errorSnapshot);
          return 'failed';
        }

        if (result.status === 'confirm_required') {
          // Gate will be handled at the top of the next iteration.
          if (!holdJudged(result)) return stopOnEngineWords(result);
          continue;
        }

        if (!holdJudged(result)) return stopOnEngineWords(result);
        // decision C179: the run ended before this drive's answer reached the engine — the call ran
        // nothing (`executeChain`'s reply for a run that has ended), so the answer was not recorded:
        // said, with who ran the step when another process did, never `✓`.
        if (
          engineReply === undefined &&
          result.status === 'ok' &&
          // #729 PR-0 (D-8 row 2): `stop` on an `ok` reply only where the run has ended.
          result.intrinsic_action === 'stop' &&
          result.evidence.length === 0
        ) {
          if (
            answerNotRecordedLine(
              currentRun,
              stepName,
              keepsClaims,
              undefined,
              PLAIN,
              currentSnap,
            ) !== undefined
          )
            console.log(
              answerNotRecordedLine(
                currentRun,
                stepName,
                keepsClaims,
                undefined,
                writerCtx(),
                currentSnap,
              ),
            );
          continue;
        }
        if (result.status === 'blocked') {
          // A `blocked` reply is never `✓` (decision C82 (5)). Which step it belongs to is the reply's
          // own `stopped_step` (decision C74): this step's, or a step the engine ran after it.
          const blockedStep = result.stopped_step ?? stepName;
          // F7: core's classifier reads the reply against the record the engine judged it on (held
          // above, #715 (b)).
          const blockedStop = classifyStop(result, blockedStep, currentRun);
          if (blockedStop?.kind === 'held_elsewhere') {
            // issue #625 PR-2a (D6.1, D3.2): another process took the step — on the claim, or between
            // this drive's read and the engine's (the step is then "not eligible", but in flight,
            // done or failed on the record) — say who and when, as past-tense facts read off its
            // claim, never `✓ → running`; then re-read and continue. Decision C179: for the agent
            // step this drive's model answered, the line says the answer was not recorded, and names
            // the program that ran the step once it settled.
            console.log(
              engineReply === undefined && blockedStep === stepName
                ? (answerNotRecordedLine(
                    currentRun,
                    blockedStep,
                    keepsClaims,
                    undefined,
                    writerCtx(),
                    currentSnap,
                  ) ??
                    takenLine(
                      blockedStep,
                      describeClaimHolder(
                        currentRun.claims?.[blockedStep],
                        keepsClaims,
                        leaseFactOf(currentSnap, currentRun.claims?.[blockedStep]),
                      ),
                      writerCtx(),
                    ))
                : takenLine(
                    blockedStep,
                    describeClaimHolder(
                      currentRun.claims?.[blockedStep],
                      keepsClaims,
                      leaseFactOf(currentSnap, currentRun.claims?.[blockedStep]),
                    ),
                    writerCtx(),
                  ),
            );
            continue;
          }
          // decision C85: the step stopped being eligible because, in the same moment, another
          // process opened a gate or ended the run. The loop top handles both — it waits at the gate,
          // or prints the run-ended line — as it did before C82 (5).
          if (blockedStop?.kind === 'run_ended' || blockedStop?.kind === 'question_open') {
            // decision C179: a run that ended in that moment did not record this drive's answer —
            // said, as when `executeChain` finds the run ended.
            if (
              engineReply === undefined &&
              blockedStep === stepName &&
              currentRun.terminal_state
            ) {
              if (
                answerNotRecordedLine(
                  currentRun,
                  stepName,
                  keepsClaims,
                  undefined,
                  PLAIN,
                  currentSnap,
                ) !== undefined
              )
                console.log(
                  answerNotRecordedLine(
                    currentRun,
                    stepName,
                    keepsClaims,
                    undefined,
                    writerCtx(),
                    currentSnap,
                  ),
                );
            }
            continue;
          }
          // decision C82 (5): any other `blocked` reply — the step's precondition failed on the
          // engine's own read, or the step stopped being eligible for another reason, after this drive
          // read the record — prints the reply's own hint, and the drive stops. Kept a stop on
          // purpose (C85): going back to the loop top on a reply the run's view does not explain
          // could bring back the unbounded, billed loop C82 removed.
          console.error(`\n✗ ${result.context_hint}`);
          printResumeLine(currentSnap);
          return 'failed';
        }
        // #625 A1a: for the step started last, when this program finished it — none after a step
        // another process took.
        if (chainStartedNotDone !== undefined) {
          console.log(`  ✓ → ${writerCtx().word(currentRun.run_phase, RUN_PHASE_WORDS)}`);
        }
      }
    } finally {
      if (mcpClient) {
        await mcpClient.disconnect();
      }
    }
  } catch (err) {
    // ═══ issue #401, CHOKEPOINT (3) — the last-resort catch ═══
    //
    // Sees everything the inner chokepoints did not already RETURN from: the MCP-init throws, a
    // store read failing mid-loop, a gate handler throwing, an engine throw out of executeChain,
    // a disconnect failing. Each one used to leave the run looking untouched.
    //
    // Classified through the SHARED classifier rather than hardcoded to 'other': an error that
    // carries a payload deserves its real class no matter which catch happens to see it.
    //
    // `step: ''` is EXPECTED for anything thrown before a step was selected.
    const entry = buildEntry(
      err,
      currentStepName ?? '',
      providerForEvidence ?? 'unknown',
      attemptStartedAt,
      deps.store.clock.now(),
    );
    // issue #600: a throw that escaped before the current step's evidence was saved takes the
    // step's billed calls with it. Once the repair loop has ended (`stepUsageSaved`), `executeChain`
    // has returned, so nothing it ran can throw here. But while it runs it CAN throw after the
    // driven step saved: a step it ran afterwards, on a store that does not persist
    // `workflow_context_snapshots`, re-takes the snapshot, and that write is unguarded. So a throw
    // inside the loop does not prove "nothing was saved": attach the calls only when they are not
    // already on the step's record.
    // Gap 1, unit A2b: the guard is asked once; its one answer decides the usage and the texts. The
    // step's texts ride along exactly when its calls do; a step whose calls are on its record, or a
    // throw before any step, has no model request on this entry.
    const owned = currentStepName !== undefined && !stepUsageSaved;
    const callsSaved =
      owned &&
      currentStepName !== undefined &&
      usageForStep !== undefined &&
      usageForStep.length > 0 &&
      (await callsAlreadyRecorded(currentStepName, usageForStep));
    if (owned && usageForStep !== undefined && usageForStep.length > 0 && !callsSaved) {
      entry.usage = appendRequests(usageForStep, entry.usage);
    }
    entry.model_text = failureText(owned && !callsSaved ? textsForStep : undefined);
    // Gap 2, unit (i-b): the step's failed model tries ride along exactly when its calls do.
    const lastTries = owned && !callsSaved ? triesOf(retryForStep) : undefined;
    if (lastTries !== undefined) entry.model_attempts = lastTries;
    await recordFailure(entry);
    // RE-THROWS, never returns: `runAgent`'s public contract is that these propagate, and
    // commands/agent.ts stays the console floor for anything that happens before a run exists.
    throw err;
  } finally {
    // #729 CW-5a: after chokepoint 3's entry, on every return and throw: a hold still open is given
    // back by the record. After a signal, the handler gives back and ends the process.
    endSave();
    if (stopCause !== undefined) await halt();
    if (held !== undefined) await giveBack();
    for (const [step, described] of pendingTakeBack)
      console.log(takenBackNotRunLine(step, described, writerCtx()));
    pendingTakeBack.clear();
  }

  if (currentRun.run_phase === 'completed') {
    console.log(`\nRun complete: ${runId}`);
    // decision C211: cleanup steps the ending left pending — the command that runs them.
    const cleanup = pendingCleanupLine(currentRun, currentAt!);
    if (cleanup !== undefined) console.log(cleanup);

    // Print the last agent step's output so the result is visible without
    // a separate `realm run inspect` call.
    const lastAgentEvidence = [...currentRun.evidence]
      .reverse()
      .find(
        (snapshot) =>
          snapshot.status === 'success' &&
          snapshot.kind !== 'gate_response' &&
          definition.steps[snapshot.step_id]?.execution === 'agent',
      );
    if (lastAgentEvidence !== undefined) {
      // decision C179: an answer this drive did not give is said to be another program's.
      const drivenBy = lastAgentEvidence.driven_by;
      const elsewhere = !answeredHere.has(lastAgentEvidence.step_id);
      console.log(
        `\nResult (${lastAgentEvidence.step_id})${
          elsewhere
            ? ` — given by ${drivenBy !== undefined ? describeProgram(drivenBy, writerCtx()) : 'another process'}, not by this drive`
            : ''
        }:`,
      );
      const stepDef = definition.steps[lastAgentEvidence.step_id];
      // #729 PR-3 (RECORD 05 "shaped sites"): in log mode, the step's output as its shapes. (The
      // shown entry is bound to `lastAgentEvidence` inside: the step-key registry's
      // `display × agent` witness reads this render site by its spelling.)
      const formatted = ((lastAgentEvidence: EvidenceSnapshot): string =>
        stepDef?.display !== undefined
          ? renderDisplay(stepDef.display, lastAgentEvidence.output_summary)
          : formatOutputForTerminal(lastAgentEvidence.output_summary))({
        ...lastAgentEvidence,
        output_summary: outputForLog(lastAgentEvidence.output_summary),
      });
      console.log(formatted);
    }

    return 'completed';
  }

  if (stoppedOnInFlight) return 'failed';
  // F16 (review G1-R3): a run that has not ended is never said to have ended. The drive stops with
  // nothing ready — said in the view's words (`realm run advance`'s stop reasons), with the ways on
  // that hold: inspect, or end it.
  if (!currentRun.terminal_state) {
    // #729 PR-0 (A-10, T-14): the stop reasons are the CLI renderer's, from the run's ways; E1 (a):
    // a reason that ends with a command is never followed by punctuation — each reason a line.
    const stopWays = composeWaysAt(currentRun, currentAt!, {
      definition,
      registry: deps.registry,
      persistsClaims: deps.store.persistsClaims === true,
      lease_facts: currentSnap.lease_facts,
    });
    const inspectWay = stopWays.ways.find((w) => w.verb === 'inspect');
    const abandonWay = stopWays.ways.find((w) => w.verb === 'abandon');
    // #729 PR-3 (L-2): the writer's context only inside the print call.
    console.error(
      `\n✗ The drive stops — run ${runId} stays open (phase '${writerCtx().word(currentRun.run_phase, RUN_PHASE_WORDS)}'):\n` +
        stopReasons(stopWays, runId, derivePhaseOf(currentRun), writerCtx())
          .map((reason) => `  ${sentenceEnd(reason)}`)
          .join('\n') +
        (inspectWay !== undefined
          ? `\n  To read it: ${cliCommandOf(inspectWay, undefined, writerHost())}`
          : '') +
        (abandonWay !== undefined
          ? `\n  To end it: ${cliCommandOf(abandonWay, undefined, writerHost())}`
          : ''),
    );
    return 'failed';
  }
  console.error(`\nRun ended in phase: ${writerCtx().word(currentRun.run_phase, RUN_PHASE_WORDS)}`);
  printResumeLine(currentSnap);
  return 'failed';
}
