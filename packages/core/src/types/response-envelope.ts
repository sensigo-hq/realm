// Types for the EngineReply returned by every engine entry (issue #729 PR-0: the core reply; the MCP
// envelope is rendered from it by `renderReply`, the CLI's lines by `CLI_COMMANDS`).
import type { EvidenceSnapshot, RunPhase, SealArm } from './run-record.js';
import type { AgentAction, ErrorCode, ErrorFacts } from './workflow-error.js';
import type { LoaderWarning } from '../workflow/diagnostics.js';
import type { ActorAbsent, Attributed, GateClaimVerdict } from '../engine/holder.js';
import type { RaceStopKind, ReplyKind, Unavailable, WayOn } from '../engine/ways.js';
import type { Basis } from '../engine/snapshot.js';
import type { EnactedVia } from '../engine/execution-loop.js';

export type RunStatus = 'ok' | 'error' | 'blocked' | 'confirm_required';

export interface BlockedReason {
  /**
   * The steps that can be called now: the agent steps the run's view offers and the `auto` steps
   * it does not refuse — never a step refused before its claim (issue #625 PR-2a, decision C94).
   * (#729 PR-0: the suggestion is the door's, rendered from its list of ways.)
   */
  eligible_steps: string[];
}

export interface GateInfo {
  gate_id: string;
  step_name: string;
  preview: Record<string, unknown>;
  choices: string[];
  /** Template-resolved display content for this gate step — present to the human verbatim before asking for their choice. */
  display?: string;
  /** Agent-facing instructions for this gate step — how the agent should present the gate to the human. */
  agent_hint?: string;
  /** Structured response specification — the choices the human may select. */
  response_spec?: { choices: string[] };
  /**
   * Issue #291 ([F-A2-6]): the mint-frozen enforce-clock deadline, verbatim from
   * `PendingGate.expires_at` — present iff the step declared `gate.timeout_seconds`. Disclosure-
   * positive: a caller can see the deadline at the exact moment the gate opens, without a
   * separate `get_run_state` round-trip.
   */
  expires_at?: string;
  /**
   * Issue #291 ([F-A2-6]): the absolute timestamp of the FIRST notify-clock occurrence
   * (`opened_at + reminder_seconds`), present iff the step declared `gate.reminder_seconds`.
   * Computed at open time — a gate is never overdue for its own first reminder at the instant it
   * opens, so this is always a future instant here (later read surfaces — `realm run list`/
   * `get_run_state`/`inspect` — recompute the NEXT-undelivered occurrence at read time via the
   * same `computeGateDueState` derivation, which may differ from this snapshot).
   */
  first_reminder_due_at?: string;
}

/**
 * issue #729 PR-0 (PR0-CONTRACT §2, A-16, P-3, Amendment 6): what an answer that was NOT recorded
 * met — the choice that was recorded instead and how (`answer` by a person, `timeout` by the
 * question's expiry), or the gate cancelled when a step ended the run (`engine`, no choice: a
 * cancelled gate chose nothing). `at` is the winning entry's `completed_at`; `by.name` comes from
 * `responded_by`, always `basis: 'stated'` — realm never claims who was on the other end. `step` and
 * `expiry` are the question's, from the call's snapshot taken before any wait; `attempted` says
 * whether THIS call tried to answer. Data in PR-0; W's `renderOutcome` renders it.
 */
export interface Outcome {
  choice?: string;
  by:
    | { kind: 'answer'; name?: string; basis: 'stated' }
    | { kind: 'timeout' }
    | {
        kind: 'engine';
        cause: 'gate_cancelled_by_abort';
        step: string;
        name?: string;
        basis?: 'stated';
      };
  at?: string;
  step: string;
  /** The question's stored deadline, as an absolute time (display, never a judgement). */
  expiry?: string;
  attempted: boolean;
  /**
   * #627 W (cell 29): how the winning entry arrived — its route as its door declared it, else the
   * record's own absence (`settled_by_expiry`, `recorded_without_route`, `route_not_declared`); one
   * vocabulary for the reply and the record. Absent on `engine` (no answer entry won).
   */
  via?: string | { absent: 'settled_by_expiry' | 'recorded_without_route' | 'route_not_declared' };
}

/** issue #729 PR-0 (T-3): one race a loop met — the step, the T-1 kind, whether this call's code ran. */
export interface RaceEntry {
  step: string;
  kind: RaceStopKind;
  ran_here: boolean;
}

/**
 * issue #729 PR-0 (T-2; A.3 #5 "names the enactor and the lag"): an expired question's declared
 * `on_expiry`, carried out — by this call or by another. `overdue` is read through `readInstant`:
 * the lag, or `{ absent: 'unparseable_stamp' }`; a question not yet due never reaches a receipt.
 */
export interface ExpiryReceipt {
  gate_id: string;
  step: string;
  on_expiry: 'settle_default' | 'abort';
  choice?: string;
  enacted_via: EnactedVia;
  by_this_call: boolean;
  expired_at: string;
  overdue: { ms: number } | { absent: 'unparseable_stamp' };
}

/**
 * issue #729 PR-0 (PR0-CONTRACT §2): the typed part of an error reply — the ways that lead on from
 * it (`remedy`, every one judged), the step a stop is about when it is not the call's own (`about`,
 * T-1), and the typed facts of its code (`facts`, Amendment 7). The untyped remainder stays in
 * `error_details` until its code's unit types it (Amendment 11).
 */
export interface ReplyError {
  remedy: WayOn[];
  about?: string;
  facts?: ErrorFacts;
}

/**
 * issue #729 PR-0: the reply of every engine entry (PR0-CONTRACT §2) — today's envelope minus the
 * door's words (`next_actions`, `agent_action`, `blocked_reason.suggestion`, the way clause,
 * `gate.claim_token`), plus the ways as data: what can be done next (`ways`), what cannot and why
 * (`unavailable`), what they were judged on (`basis`), and the typed receipts. Ways are never stored:
 * a replayed request returns its first verdict with fresh ways. Each door renders it — MCP's
 * `renderReply`, the CLI's `CLI_COMMANDS`; the library carries it as it is.
 */
export interface EngineReply {
  command: string;
  run_id: string;
  /** Integer version of the run record at time of response. For observability only — not required as input to any tool. */
  run_version: number;
  /**
   * Chain progress status.
   * - 'ok': the chain made forward progress; `ways` says what can be done next.
   *   Does NOT imply the original requested step succeeded — a recovery path also returns 'ok' with a warning.
   * - 'error': unrecoverable failure; `intrinsic_action` is the error's own action word.
   * - 'blocked': wrong step for current state; `ways` says what can be done instead.
   * - 'confirm_required': a human gate is open; gate carries the display content.
   */
  status: RunStatus;
  data: Record<string, unknown>;
  /** Audit trail of step executions in this response. For debugging and CLI inspection only. */
  evidence: EvidenceSnapshot[];
  warnings: string[];
  /**
   * Structured, code-tagged counterparts to `warnings` above (issue #169) — additive-optional,
   * non-breaking. Only `create_workflow` populates this today; every other envelope producer
   * omits it. Lets an agent self-correct on `code`/`key`/`did_you_mean` instead of parsing text.
   */
  diagnostics?: LoaderWarning[];
  errors: string[];
  /**
   * The canonical error code from the WorkflowError that produced this envelope.
   * Only present when status === 'error'.
   */
  error_code?: ErrorCode;
  /**
   * Additional structured context. On an error: the WorkflowError's details, present when
   * error_code is set and the error carries non-empty details. On a late answer that names the
   * choice the question's expiry recorded (`status: 'ok'`, `answer_recorded: false`, decision
   * C185): `runId`, `gateId`, `winning_choice` and `resolved_by: 'timeout'` — the fields the
   * refusal of another choice carries.
   */
  error_details?: Record<string, unknown>;
  /** issue #729 PR-0: the typed part of an error — its remedies, the step it is about, its facts. */
  error?: ReplyError;
  /**
   * issue #729 PR-0 (D2 D-8 row 1; Amendment 12): the reply's OWN action word, the input of the one
   * derivation `agentActionOf` — on an error reply the `WorkflowError.agentAction`, set once where
   * the reply is composed; on an `ok` reply only `stop`, at the three ended-run anchors. Never on the
   * MCP wire: `agent_action` is the door's derived word.
   */
  intrinsic_action?: AgentAction;
  /** issue #729 PR-0 (D2 D-8): the kind of reply this is, as the one derivation of `agent_action` reads it. */
  reply_kind: ReplyKind;
  /**
   * When present and the error's action is 'wait_and_proceed', the number of seconds the consumer
   * should wait before going on. Not set otherwise.
   */
  retry_after?: number;
  /**
   * Current state orientation. Always populated — says what just happened and what state the run is
   * in, and nothing more (issue #729 PR-0: the ways on are the door's to word).
   */
  context_hint: string;
  /**
   * Derived phase of the run at the time of this response. Present whenever a run is loaded
   * (sourced from `run.run_phase`); absent only on pre-execution error envelopes where no run
   * could be loaded (`buildPreExecutionErrorEnvelope` / `errorEnvelope`).
   */
  run_phase?: RunPhase;
  /** issue #729 PR-0: what can be done next, as data (PR0-CONTRACT §1). Never stored. */
  ways: WayOn[];
  /** issue #729 PR-0: what cannot be done now, each with its code, facts and remedies. */
  unavailable: Unavailable[];
  /** issue #729 PR-0: what the ways were judged on; absent on a reply that loaded no run. */
  basis?: Basis;
  /** issue #729 PR-0 (A-16, P-3): what an answer that was not recorded met. */
  outcome?: Outcome;
  /** issue #729 PR-0 (T-3): the races a loop met. */
  races?: RaceEntry[];
  /** issue #729 PR-0 (T-2): an expired question's declared `on_expiry`, carried out. */
  expiry?: ExpiryReceipt;
  /**
   * issue #729 PR-0 (D3 A-6): this call's own refusal — the verdict of the one admission
   * (`admitWay`) on the way the call asked for: its code, typed facts and remedies (each a judged
   * way). On a reply that refuses the step or the answer its caller named; absent otherwise.
   */
  refusal?: Unavailable;
  /**
   * issue #729 PR-0 (decisions C34, C51, C57; Table rows 20–26): set on a reply whose moment says
   * what comes next — a step's reply, an answer's reply, a refusal, a start, a call where nothing
   * ran. `context_hint` says only what happened; a door that words the ways adds its sentence of
   * what comes next after it on such a reply (MCP's `renderReply`). Data about the reply, never words.
   */
  names_next?: true;
  blocked_reason?: BlockedReason;
  gate?: GateInfo;
  /**
   * Names and run_phase values of auto steps that ran silently as part of an executeChain call.
   * Only present when at least one auto step was chained. Useful for debugging and orientation
   * after start_run or after an agent step that triggers subsequent auto steps.
   */
  chained_auto_steps?: Array<{ step: string; run_phase: string; branched_via?: string }>;
  /**
   * Per-partition adoption counts (issue #197 PR-2, design §6) — mirrors the settled step's own
   * `trace_summary.attributed_lines_adopted` / `buffered_lines_adopted` / `foreign_lines_preserved`
   * (see run-record.ts) at the moment the adoption partition actually ran. SET BY THE ENGINE at
   * envelope build (the MCP tool layer strips `data`/`evidence` before returning and never itself
   * sees per-line nonces). Present ONLY when the adoption partition ran for the step this envelope
   * settles — absent for a bare-floor store (no `writer_nonce_carriage`), a non-agent step, or an
   * error/blocked envelope. **Chain-replacement disposition (issue #197 PR-2):** when a settled
   * agent step's `executeChain` call continues into a subsequently-eligible auto step, the
   * RETURNED envelope is that deeper step's own — these three counts may be ABSENT there (they
   * persist authoritatively in the settled step's own `trace_summary` regardless of what this
   * envelope reports); the accompanying warnings (seal outcome / half-minted advisory / missing
   * carriage leg) are re-surfaced into the returned envelope's `warnings` via the existing
   * chain-wide warning re-accumulation even when these counts are not.
   */
  adopted_own?: number;
  /** @see adopted_own — the ⊥ (bare) counterpart; mirrors `trace_summary.buffered_lines_adopted`. */
  adopted_anonymous?: number;
  /** @see adopted_own — mirrors `trace_summary.foreign_lines_preserved`. */
  preserved_foreign?: number;
  /**
   * Issue #220 PR-2 (declared fail-open, pin g). `true` ONLY on the terminal success envelope of
   * the step that just settled via its declared `validation_exhaustion.default_output`
   * substitution (mirrors the settling evidence snapshot's `diagnostics.settled_by_default`).
   * SURVIVES the MCP tool wrapper's strip (`execute-step.ts`/`submit-human-response.ts` only strip
   * `data`+`evidence`, every other top-level field passes through — the #197 partition-fields
   * precedent). Absent (never `false`) on every other envelope, INCLUDING the `confirm_required`
   * gate-open envelope for a `human_confirmed` step at exhaustion (the step is not yet settled
   * there — see the gate's own `warnings` for the disclosure) and `submitHumanResponse`'s envelope
   * (a separate function with no access to the settling snapshot; see `defaulted_steps` below for
   * that surface's disclosure instead).
   */
  settled_by_default?: boolean;
  /**
   * Issue #220 PR-2 (run-level disclosure, pin r). Mirrors `RunRecord.defaulted_steps` — present
   * only on a TERMINAL `complete` envelope whose sealed run record carries a non-empty
   * `defaulted_steps` (read off the stamped pre-persist seal record, never the round-tripped
   * persisted record, so a non-persisting store can't silently drop it from this envelope too).
   */
  defaulted_steps?: string[];
  /**
   * Issue #625. The guards the write behind this reply settled, in the order they were settled —
   * a store's own `settleStep` settles, in the same write as an answer, an expired gate or a
   * finished step, every guard that write makes eligible. Absent when it settled none.
   *
   * After `start_run` / `execute_step` the same guards are also listed in `chained_auto_steps`;
   * after an answer (`submit_human_response`) this field is where they appear.
   */
  guards?: Array<{ step: string; outcome: 'pass' | 'abort' | 'resolution_error' }>;
  /**
   * Issue #625. Present when one of `guards` ENDED the run in that write: the sealing guard's own
   * arm and step — never the gate's or the named step's.
   *
   * `reason` is the guard's authored `abort_message` on an abort (absent when the author wrote
   * none); on a resolution error the guard's own recorded evidence `error`; absent on a pass that
   * completed the run.
   *
   * The reply's `status` is unchanged by this field: an answer that was recorded stays `ok` even
   * when the guard it unlocked aborted the run — the answer succeeded; the ending is its own fact.
   */
  ended_by?: { arm: SealArm; step: string; reason?: string };
  /**
   * Issue #676 (review, decisions C73/C74 in #625's record): the step this call stopped at. Present
   * on every non-`ok` reply — `error`, `blocked` or `confirm_required` — that a step's own call
   * produced; the reply's `status`, `errors` and `error_code` are that call's. This includes the
   * refusals a step's call makes before the step does anything (the run not found, the step not
   * eligible). It names:
   * - the step the call named (`command`), when that step stopped the call; or
   * - a step the engine ran AFTER it: `command`'s own call returned `ok`, so it settled; or,
   * - after MCP `start_run` (whose `command` is the tool's name), the `auto` step the engine was
   *   running when the call stopped;
   * - after `advanceRun` / MCP `advance_run` (whose `command` is no step), the `auto` step it ran
   *   that stopped the call (issue #625 PR-2a).
   *
   * Absent on every `ok` reply and on an error of the chain itself (a guard's settlement that could
   * not be written, or that a different attempt had already settled — those errors name their guard
   * in their own text). A refusal thrown before any step is called (the release-line and driver
   * checks) is not a reply. An `auto` step the engine refuses before its claim (issue #625 PR-2a,
   * decision C13) is never run by the chain, so it stops no call: the reply is `ok` and names it in
   * its `context_hint`.
   *
   * Read it before naming the step a non-`ok` reply belongs to: `command` names what the caller
   * asked for, not the step that stopped. When it differs from `command`, the engine ran it after
   * the step that was called.
   */
  stopped_step?: string;
  /**
   * Issue #625. `false` on a reply to an answer the gate's expiry beat: the gate was settled by
   * its timeout (or the run was aborted by it) before this answer could be recorded, so the
   * choice in this call was NOT recorded — including when it matches the choice the expiry
   * enacted, where `status` is still `ok`. Absent on every other reply; never `true`. Read this
   * field, not the reply's prose, to tell a late answer from a recorded one.
   */
  answer_recorded?: false;
  /**
   * Holder slice (PR-H): present on the `ok` reply of every answer to a gate. `proof` says whether
   * the caller passed back the `claim_token` of the reply that opened the question
   * (`matched` · `absent` · `mismatch`), could not be checked (`unverifiable`, with its `cause`) or
   * arrived after the question was settled (`spent`); `opened_by` names the PROGRAM through which
   * the question was opened, in the past tense, with how its name is known. It changes nothing
   * about the answer: the answer is decided by the gate id alone. A refused reply carries none.
   */
  gate_claim?: {
    proof: GateClaimVerdict['proof'];
    cause?: 'no_claim' | 'claim_has_no_token' | 'store_keeps_no_claims' | 'answered' | 'expired';
    opened_by: Attributed | ActorAbsent;
  };
}
