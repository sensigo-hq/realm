// Types for the ResponseEnvelope returned by every step execution.
import type { EvidenceSnapshot, RunPhase, SealArm } from './run-record.js';
import type { AgentAction, ErrorCode } from './workflow-error.js';
import type { LoaderWarning } from '../workflow/diagnostics.js';
import type { ActorAbsent, Attributed, GateClaimVerdict } from '../engine/holder.js';

export interface NextAction {
  instruction: {
    tool: string;
    params: Record<string, unknown>;
    /**
     * Ready-to-use flat argument object for calling the tool.
     * Agent-supplied params appear as placeholder strings (e.g. "<YOUR_PARAMS>", "<approve|reject>").
     * Copy this object, replace the placeholder(s), and call the tool.
     */
    call_with: Record<string, unknown>;
  } | null;
  human_readable: string;
  /** Current state orientation — describes what state the run is in and what just happened. */
  orientation: string;
  /** The step's declared input schema — use this to structure the params argument of your execute_step call. */
  input_schema?: Record<string, unknown>;
  /** Template-resolved step prompt, delivered to the agent at step entry. */
  prompt?: string;
}

export type RunStatus = 'ok' | 'error' | 'blocked' | 'confirm_required';

export interface BlockedReason {
  /** Step names currently eligible for execution. */
  eligible_steps: string[];
  suggestion?: string;
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
  /**
   * Holder slice (PR-H): the claim token of the call that opened this question — the proof a caller
   * of its answer may pass back (as `claim_token`) to show that the answer comes from the
   * conversation that opened it. Present only on the two replies whose own call minted the claim,
   * and only when the store minted a token. It is the ONE surface that carries a claim's token
   * (also inside the answer instruction, both renderings). Not a secret: it guards against
   * accidents and races, not malice — anyone who can read the store can read it, and realm has no
   * authentication. Passing it back changes nothing about whether the answer is recorded.
   */
  claim_token?: string;
}

export interface ResponseEnvelope {
  command: string;
  run_id: string;
  /** Integer version of the run record at time of response. For observability only — not required as input to any tool. */
  run_version: number;
  /**
   * Chain progress status.
   * - 'ok': the chain made forward progress; follow next_actions for what to do next.
   *   Does NOT imply the original requested step succeeded — a recovery path also returns 'ok' with a warning.
   * - 'error': unrecoverable failure; agent_action tells you how to respond.
   * - 'blocked': wrong step for current state; next_actions redirects.
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
   * Additional structured context from the WorkflowError. Only present when
   * error_code is set and the error carries non-empty details.
   */
  error_details?: Record<string, unknown>;
  agent_action?: AgentAction;
  /**
   * When present and agent_action is 'wait_and_proceed', the number of seconds
   * the consumer should wait before following next_actions. Not set for other
   * agent_action values.
   */
  retry_after?: number;
  /** Current state orientation. Always populated — describes what just happened and what state the run is in. */
  context_hint: string;
  /**
   * Derived phase of the run at the time of this response. Present whenever a run is loaded
   * (sourced from `run.run_phase`); absent only on pre-execution error envelopes where no run
   * could be loaded (`buildPreExecutionErrorEnvelope` / `errorEnvelope`).
   */
  run_phase?: RunPhase;
  /** Steps available for execution. Empty array means terminal or blocked — check status and run_phase. */
  next_actions: NextAction[];
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
