// settlement.ts — types for the atomic RunStore.settleStep operation (issue #279).
// Normative spec: plans/issue-279/design-d4-increment1.md §1/§2/§3/§7 (increment 1) +
// plans/issue-279/design-d5-increment2.md §2/§3/§7 (increment 2, PR-C — this file's own gate/
// guard/release additions). Read both records in full before touching this file — they are the
// specification; this file's JSDoc cross-references them but does not restate the
// predicate/transform pseudocode.
//
// PR-A shipped `settle_step`/`lease_finalizer`/`mark_finalizer`, dormant. PR-B migrated the three
// seal sites to use them (shipped in v0.32.0 — three engine call sites + drainFinalizers
// construct `settle_step`/`lease_finalizer`/`mark_finalizer` deltas today; the old "dormant until
// PR-B" framing below is stale, corrected here). PR-C (this file's current increment) adds four
// MORE delta kinds — `open_gate`, `settle_gate`, `settle_guard`, `release_step` — but stays
// engine-inert for them: no engine or MCP call site constructs one yet (enforced by a source-text
// guard, deleted when PR-D migrates the five remaining legacy write sites).
import type { EvidenceSnapshot, PendingGate, SealArm } from './run-record.js';
import type { ExtensionIdentityEntry } from './extension-identity.js';
import type { Attributed, GateClaimVerdict } from '../engine/holder.js';

/** The three outcomes a `settle_step` delta's caller can report for the step being settled —
 *  mirrors the THREE seal call sites (:2560 complete, :2220 fail, :1784 handler-abort) this
 *  increment's transform is bound to by line (design record §3). */
export type SettleStepOutcome = 'complete' | 'fail' | 'abort';

/**
 * A step settlement intent — the caller reports what a claimed step's dispatcher/handler produced;
 * `applySettlement` (settlement.ts, the pure transform) decides whether it applies against fresh
 * state. `claimToken` is compared against `fresh.claims[step].token` via absent≡absent
 * `tokensEqual` (record §2) — omit it only for a caller that genuinely has no fencing token yet
 * (pre-token-adoption; #197's grandfathered-claims precedent).
 *
 * `abort` is REQUIRED in practice when `outcome === 'abort'` (handler-abort only — see the design
 * record §1's OUT list: guard aborts stay on the legacy CAS path through increment 2+, so this
 * delta shape never needs to carry `conditions`, unlike `RunRecord.aborted_at`'s guard-abort
 * variant). `applySettlement` throws a plain contract-violation `Error` (never a `WorkflowError` —
 * this is a caller-programming-error path, not a runtime predicate outcome) if `outcome==='abort'`
 * and `abort` is missing; every real caller always supplies both together.
 */
export interface SettleStepDelta {
  kind: 'settle_step';
  step: string;
  outcome: SettleStepOutcome;
  /** Omit only for a token-less legacy caller — compared via absent≡absent `tokensEqual`. */
  claimToken?: string;
  /** Appended verbatim to `fresh.evidence` — the caller's already-built evidence for this settle
   *  (mirrors `allEvidence` at every legacy seal call site; may be empty). */
  evidence: EvidenceSnapshot[];
  /** Used to mint `terminal_reason` ONLY on the terminal edge for a `fail` outcome (mirrors
   *  execution-loop.ts's `Step '<step>' failed: <message>` wording exactly); a non-terminal fail
   *  never reads this. Absent falls back to a generic message — this field exists for a caller
   *  that HAS a specific dispatch error message, not as a required contract. */
  failureMessage?: string;
  /** REQUIRED when `outcome === 'abort'` (see the interface doc above) — the exact payload stamped
   *  into `RunRecord.aborted_at` (`stepId` → `step_id`, `abortMessage` → `abort_message`). */
  abort?: {
    stepId: string;
    abortMessage: string;
  };
}

/** Result a `mark_finalizer` delta reports for one finalizer's handler outcome — mirrors
 *  `finalizer_ledger[name].status`'s two live-outcome values (`pending`/`voided` are never a
 *  mark-delta's OWN result; they are prior/other-path states the predicate reads, never writes
 *  via this delta). */
export type MarkFinalizerResult = 'completed' | 'failed';

/**
 * Acquire (or re-acquire, same-token) the lease on one PENDING finalizer ledger entry — the
 * drain loop's mint-before-execute step. `leaseToken` is CALLER-MINTED (uuid; design record §3's
 * lens-1 F3a note: unlike every other fence in the system, this one is acquirer-minted by
 * necessity — there is no prior claim record to read a token off of for a finalizer).
 */
export interface LeaseFinalizerDelta {
  kind: 'lease_finalizer';
  finalizer: string;
  leaseToken: string;
  /** Requested lease duration in seconds (typically the finalizer's own `timeout_seconds`);
   *  clamped to {@link DRAIN_LEASE_MAX} by the transform — see lifecycle.ts. */
  leaseSeconds: number;
}

/**
 * Record a finalizer handler's outcome against the lease that authorized running it.
 * `evidence` is the ONE evidence snapshot for this finalizer's execution (mirrors
 * the one-entry-per-finalizer-per-drain-pass cardinality the deleted `buildFinalizedSeal` had) — singular,
 * not an array, unlike `SettleStepDelta.evidence`.
 */
export interface MarkFinalizerDelta {
  kind: 'mark_finalizer';
  finalizer: string;
  leaseToken: string;
  result: MarkFinalizerResult;
  evidence: EvidenceSnapshot;
}

/**
 * The gate an `open_gate` delta opens, WITHOUT its instants (#715 (b), D-20; D5 §2.4, D6-12): the
 * caller builds everything a {@link PendingGate} holds (gate_id, choices, preview, the frozen
 * enforce/notify fields) except `opened_at` and `expires_at`, which the transform mints from the
 * write's one reading `at` — so no gate is ever born expired.
 */
export type OpeningGate = Omit<PendingGate, 'opened_at' | 'expires_at'>;

/**
 * Opens a human gate on a claimed step (issue #279, increment 2, PR-C; design record
 * `design-d5-increment2.md` §2/§3 `openGateArms`). #715 (b) (D-20, D6-12): the delta carries
 * DURATIONS, never instants — `pendingGate` is the gate without `opened_at`/`expires_at`, and
 * `timeoutSeconds` its declared timeout; the transform writes `opened_at = at` and, when
 * `timeoutSeconds` is given, `expires_at = at + timeoutSeconds`. Everything else in `pendingGate` is
 * carried verbatim. This is the OPENING kind only: a restore (none exists) carries the full
 * `PendingGate` with its frozen instants in its own delta kind. `claimToken` is compared the same
 * absent≡absent way `SettleStepDelta.claimToken` is.
 */
export interface OpenGateDelta {
  kind: 'open_gate';
  step: string;
  claimToken?: string;
  pendingGate: OpeningGate;
  /** The gate's declared `timeout_seconds`; absent ⇒ the gate has no `expires_at`. */
  timeoutSeconds?: number;
  evidence: EvidenceSnapshot[];
}

/**
 * Resolves an open gate with a human's choice (issue #279, increment 2, PR-C; design record §2/§3
 * `settleGateArms`). Fenced by `gateId` ONLY — zero claim arms (§3's own note: "fence = gateId
 * ONLY (L20)"), since a gate's authority is bearer-gateId-credentialed (D-5: RECORDED, not
 * enforced — `respondedBy` below is an evidence passthrough, read by no arm).
 */
export interface SettleGateDelta {
  kind: 'settle_gate';
  gateId: string;
  choice: string;
  /** Unenforced attribution passthrough (design record D-5, pedestal fold) — flows into the
   *  gate_response evidence snapshot the migrated caller (PR-D) builds; no arm in this file ever
   *  reads it. Omit when the caller has no attribution to record. */
  respondedBy?: string;
  /**
   * issue #625 (holder slice): the claim token the answer's caller passed back, if any. JUDGED
   * inside the answer's write (`judgeGateProof`) and reported on the result's `gateClaim` and on the
   * answer's evidence entry — it NEVER decides whether the answer applies (the answer is decided by
   * `gateId` alone). Only "not passed" is absent: an empty string is a wrong value, not no value.
   */
  claimToken?: string;
  evidence: EvidenceSnapshot[];
}

/**
 * Records a guard step's evaluated outcome (issue #279, increment 2, PR-C; design record §2/§3
 * `settleGuardArms`). Guards are never claimed (`eligibility.ts:418` — `findEligibleGuardSteps`
 * has no claim concept), so this delta carries no `claimToken` at all — fence = ⊥. `evidence` is
 * SINGULAR (the `MarkFinalizerDelta` precedent — one guard evaluation, one evidence snapshot),
 * unlike `SettleStepDelta.evidence`'s array.
 *
 * `resolutionError` is REQUIRED when `outcome === 'resolution_error'`; `abort` is REQUIRED when
 * `outcome === 'abort'` — a violation of either throws a plain contract-violation `Error` in the
 * transform (the `settlement.ts:228-234` precedent), never a `WorkflowError` (a caller-programming
 * error, not a predicate outcome).
 */
export interface SettleGuardDelta {
  kind: 'settle_guard';
  step: string;
  outcome: 'pass' | 'resolution_error' | 'abort';
  evidence: EvidenceSnapshot;
  /** REQUIRED iff `outcome === 'resolution_error'` — feeds the terminal_reason string minted at
   *  execution-loop.ts:3671 ("Guard step '<s>' failed: unresolvable path '<p>'").
   *
   *  `cause` (issue #625): set ONLY when the guard could not be evaluated at all — its `when` or
   *  its `abort_unless` threw — so there is no unresolvable path to name. When present, the seal
   *  sentence reads "Guard step '<s>' failed: <cause>" instead of the path sentence. */
  resolutionError?: { condition: string; unresolvable_path: string; cause?: string };
  /** REQUIRED iff `outcome === 'abort'` — mirrors `RunRecord.aborted_at`'s shipped shape
   *  (`run-record.ts:426-430`, the `GuardConditionResult` object array — NOT `string[]`; a
   *  record defect in an earlier design draft, corrected at the PR-C prompt audit). `step_id` on
   *  the eventual `aborted_at` payload is always `delta.step` — never carried separately here. */
  abort?: {
    conditions: Array<{ condition: string; resolved_value: unknown; passed: boolean }>;
    abort_message?: string;
  };
  /** Forensic-only provenance (design record §2, lane-B steal 2 — the K8s `observedGeneration`
   *  analogue): the run version this guard's conditions were evaluated AGAINST, so a stale-
   *  predicate refusal is self-explaining (evaluated-at vs refused-at). Read by no arm. */
  evaluatedAtVersion?: number;
}

/**
 * Enacts a gate's frozen enforce-clock disposition once it has expired unresolved (issue #291;
 * design record `plans/issue-291/design-d2.md` [F1]/[F2]/[F3] `applyExpireGate`). Fenced by
 * `gateId` ONLY — same fencing shape as {@link SettleGateDelta} (a gate's authority is
 * bearer-gateId-credentialed) — so a stale/duplicate expire attempt for a gate that has since
 * been superseded (resolved by a human, or already expired by a racing enactment point) NOOPs or
 * refuses rather than silently expiring the WRONG (newer) gate. Carries no caller-supplied
 * `evidence`, unlike every other delta kind: the disposition (and therefore the evidence shape)
 * is decided INSIDE `applyExpireGate` itself by reading the frozen `PendingGate` fields — the
 * `applyAbortEdge` cancel-gate precedent (settlement.ts) for a transform building its own
 * evidence via `captureEvidence` rather than a caller-supplied array.
 */
export interface ExpireGateDelta {
  kind: 'expire_gate';
  gateId: string;
}

/**
 * Releases a claim without settling the step (issue #279, increment 2, PR-C; design record §2/§3
 * `releaseStepArms`) — the shared shape behind BOTH the capability-block release
 * (execution-loop.ts:2453-2529) and the compensating un-claim (execution-loop.ts:1607-1635).
 * NEVER terminal, writes NO `settled` entry — the step returns to eligible.
 */
export interface ReleaseStepDelta {
  kind: 'release_step';
  step: string;
  claimToken?: string;
  /** Optional-additive capability-block marker merge (execution-loop.ts:2461-2475 semantics). */
  capabilityBlock?: { requirement: { kind: 'handler' | 'adapter'; name: string }; code: string };
  /** Optional-additive evidence append (execution-loop.ts:679 semantics — the compensating
   *  un-claim's own audit snapshot). Absent for a capability-block release, which appends its
   *  evidence via `allEvidence` at the migrated call site instead (PR-D concern). */
  evidence?: EvidenceSnapshot[];
}

/**
 * Seals a run at the RUN level (#715 (b), D-21; D6-46, D6-56, D6-65, D6-66, D6-67): abandon, cleanup,
 * a webhook spawn failure, an extension load failure. The transform seals through `sealRunLevel` with
 * the write's one reading as every seal-tier instant (`abandoned_at`).
 *
 * - `expected_version` is the version the writer judged the run at: a stored record whose version
 *   differs is REFUSED `moved` (the transform returns it; the store THROWS it as
 *   `STATE_SNAPSHOT_MISMATCH`, exactly as `update()` does — D6-65).
 * - a record already terminal returns `already_terminal` with the fresh record.
 * - `release_claims` clears `claims` AND `in_progress_steps` in the same write (D6-66).
 * - `identity_entry` is appended to `extension_identity` verbatim — its `captured_at` is outside
 *   class, minted before any store, and never folded into the reading (D6-67).
 */
export interface SealRunDelta {
  kind: 'seal_run';
  arm: SealArm;
  reason: string;
  expected_version: number;
  release_claims: boolean;
  identity_entry?: ExtensionIdentityEntry;
}

/**
 * The delta kinds `RunStore.settleStep` accepts (design record §1/§2). A concrete discriminated
 * union — no structural intersections, no duck-typing.
 *
 * **Union-openness contract (issue #279, increment 2, PR-C — design record §2, angles fold 1):**
 * this union is OPEN — kinds may be added in future minors (e.g. the increment-3 per-gate-timeout
 * candidate on the design record's residuals list). A RE-IMPLEMENTING store (a multi-statement
 * backend, e.g. a future Postgres store's `settleStepForTenant`) MUST refuse-loud (throw a
 * contract-violation error) on an unrecognized `kind` — NEVER default-arm it. Silently applying an
 * unrecognized kind's fields under a generic/default case is actively dangerous: `SettleGateDelta`
 * has no `step` field at all, so a default-arm implementation reading `delta.step` would silently
 * mis-write (write `undefined` as a step name) rather than crash where the bug is introduced.
 */
export type SettlementDelta =
  | SettleStepDelta
  | LeaseFinalizerDelta
  | MarkFinalizerDelta
  | OpenGateDelta
  | SettleGateDelta
  | SettleGuardDelta
  | ReleaseStepDelta
  | ExpireGateDelta
  | SealRunDelta;

/**
 * Every refusal/noop literal `applySettlement`/`settleStep` can RETURN as `SettlementResult.reason`
 * (design record §7, the full table MINUS `drain_pending`) — `drain_pending` is the PR-B purge
 * guard's own THROWN `STATE_RUN_BUSY` builder reason, never a `settleStep` return value, so it is
 * deliberately excluded from this type (a `settleStep` implementation must never construct it).
 */
export type SettlementRefusalReason =
  // ok-shaped NOOPs (⊂ this type — see SettlementNoopReason below)
  | 'already_settled'
  | 'already_leased'
  | 'already_marked'
  | 'already_released'
  | 'already_open'
  // settle_step refusals
  | 'already_settled_by_other'
  | 'settled_outcome_divergence'
  | 'run_terminal'
  | 'claim_lost'
  | 'gate_mismatch'
  // lease_finalizer / mark_finalizer refusals (result-enum only — drain-loop consumed, never
  // thrown as a WorkflowError; design record §7)
  | 'run_not_terminal'
  | 'ledger_not_pending'
  | 'lease_held'
  | 'lease_lost'
  | 'rank_blocked'
  | 'not_eligible'
  // issue #279, increment 2 (PR-C — design record §2/§7): open_gate/settle_gate/settle_guard
  // refusals.
  | 'gate_choice_conflict'
  | 'choice_not_eligible'
  | 'gate_open_wait'
  // issue #291 (design record [F1]/[F3]): expire_gate refusals. (#715 (b): the settle_gate F3
  // write-free `gate_expired_pending` refusal is gone — a late answer's expiry is enacted in the
  // same write, see `lateAnswer` on the applied result.)
  /** expire_gate only: the store's reading is before `fresh.pending_gate.expires_at` — the
   *  enactment attempt is premature (verified by the arm at the reading the store took from its own
   *  clock, `applySettlement`'s `at`; since #715 (b) no caller passes a time). */
  | 'not_expired'
  /** expire_gate only: the gate's `expires_at` is present (so an expire delta was constructed
   *  at all) but `on_expiry` is absent — finding-only mode. Arm-level refusal, before APPLY;
   *  never enacted, only ever disclosed. */
  | 'no_disposition'
  // #715 (b) (D-21): seal_run refusals.
  /** seal_run only: the stored version differs from the delta's `expected_version` — the run moved
   *  between the writer's read and its seal. The transform RETURNS it; the store THROWS it as
   *  `STATE_SNAPSHOT_MISMATCH` (D6-65), as `update()` does. */
  | 'moved'
  /** seal_run only: the run is already terminal; nothing is written. */
  | 'already_terminal';

/**
 * The ok-shaped NOOP subset of {@link SettlementRefusalReason} (design record §7: "ok-shaped
 * NOOP" — envelope-calm, `context_hint` never `report_to_user`, I15). L1's "routine same-run
 * fan-out produces ZERO refusals" acceptance sentence is stated against the NON-noop subset: a
 * same-token retry landing as one of these is an idempotent no-op, never counted as a refusal.
 * L13/L21 discriminate on this sub-union explicitly. `already_released` (release_step) and
 * `already_open` (open_gate) joined in increment 2, PR-C — design record §2/§7.
 */
export type SettlementNoopReason =
  'already_settled' | 'already_leased' | 'already_marked' | 'already_released' | 'already_open';

/**
 * Result of applying one {@link SettlementDelta} against fresh state (design record §2, normative
 * — final-gate F5).
 *
 * `run` on `applied: true` is the AS-APPLIED TRANSFORM OUTPUT — pre-serialization, pre-fidelity-
 * filtering — and must NEVER be a re-read of what the store persisted. This is the #220 disclosure
 * invariant's own precedent (execution-loop.ts:2723-2729: the complete-seal envelope reads
 * `defaulted_steps`/`settled_by_default` off the STAMPED PRE-PERSIST record, never the round-
 * tripped one) generalized to every settlement result: a lossy store's round-trip would otherwise
 * silently break disclosure exactly where it matters. Every `settleStep` implementation MUST
 * return the transform's own output object here, not a subsequent `get()`/re-read.
 *
 * `run` on `applied: false` is FRESH STATE — the very state the predicate refused/no-opped
 * against — with NO write performed (version unchanged).
 */
export type SettlementResult =
  | {
      applied: true;
      run: import('./run-record.js').RunRecord;
      /** Whether THIS apply caused the terminal false→true edge. `settle_step`, `settle_gate`
       *  (resolution-completes), and `settle_guard` (pass-completes) can all terminalize (issue
       *  #279, increment 2, PR-C; design record §2/§4) — a `lease_finalizer`/`mark_finalizer`
       *  delta's `isTerminal(fresh)` precondition means the run was already terminal both before
       *  and after, so it is always `false` for those two kinds; `open_gate`/`release_step` never
       *  terminalize by construction (design record §4.1). */
      transitioned: boolean;
      /** The current pending finalizer set on `run.finalizer_ledger`, by ascending `rank` —
       *  a convenience snapshot so a caller can decide whether to invoke the drain verb without
       *  re-scanning the ledger itself (design record §6: the drain loop's OWN pass always
       *  re-reads the ledger from the latest settle/lease/mark result directly, never trusting a
       *  cached list across iterations — this field is that first read). */
      pendingFinalizers: readonly string[];
      /** issue #625: the guards THIS apply settled after its own delta, in the order they were
       *  settled — present only when `applySettlement` ran with `cascadeGuards` (a store's own
       *  `settleStep`) and at least one guard was eligible after the delta. Absent when none.
       *  `run`, `transitioned` and `pendingFinalizers` describe the record AFTER these guards. */
      guards?: ReadonlyArray<{ step: string; outcome: 'pass' | 'abort' | 'resolution_error' }>;
      /** issue #625 (holder slice): what the answer's caller showed about the question's claim —
       *  present only on a `settle_gate` result (and on the `already_settled` result of an
       *  `expire_gate`/`settle_gate` that found the question settled), never on any other. */
      gateClaim?: GateClaimVerdict & { claim?: { holder?: Attributed; since?: string } };
      /**
       * Present ONLY on the result of a `settle_gate` delta whose gate was DUE at `at`: the answer was NOT
       * recorded (the question's expiry beat it) and the gate's frozen expiry disposition was enacted in
       * THIS write. `applied: true`, `run`, `transitioned`, `pendingFinalizers` and `guards` describe that
       * enactment exactly as an `expire_gate` delta's applied result would. The answer and the expiry
       * share this write's one `at`.
       */
      lateAnswer?: {
        /** The live gate's id (equals the delta's `gateId`). */
        gateId: string;
        /** The choice the late answer carried. */
        choice: string;
        /** The verdict judged when the gate id matched, before the expiry was decided — the same value the write-free refusal carried as `gateClaim`. */
        gateClaim: GateClaimVerdict & { claim?: { holder?: Attributed; since?: string } };
        /** The question's `expires_at` as it stood BEFORE this write (the settled record no longer holds it). */
        expiresAt: string;
      };
    }
  | {
      applied: false;
      reason: SettlementRefusalReason;
      run: import('./run-record.js').RunRecord;
      /** Present ONLY when `reason === 'already_open'` — the LIVE `pending_gate`, rendered
       *  VERBATIM (issue #279, increment 2, PR-C; design record §3 `openGateArms`: "D-1: LIVE
       *  gate wins, rendered VERBATIM"). Read by no other arm; a caller (PR-D) surfaces it as the
       *  NOOP's own data. */
      gate?: PendingGate;
      /** Present ONLY when `reason === 'gate_choice_conflict'` — the choice that already won
       *  (issue #279, increment 2, PR-C; design record §3 `settleGateArms`). */
      winningChoice?: string;
      /** Present ONLY when `reason === 'choice_not_eligible'` — the gate's valid choices (issue
       *  #279, increment 2, PR-C; design record §3 `settleGateArms`). */
      choices?: string[];
      /** Present ONLY when `reason === 'settled_outcome_divergence'` — a human-readable
       *  description of the persisted membership that conflicts with the delta's own outcome
       *  (issue #279, increment 2, PR-C; design record §3 `settleGuardArms`). */
      persisted?: string;
      /** issue #625 (holder slice): the same verdict, on the refusals that carry one
       *  (`already_settled` from either gate arm). `claim`
       *  is present exactly when the gate step had a claim at the read, copying `holder` and
       *  `since` as stored — NEVER the token. */
      gateClaim?: GateClaimVerdict & { claim?: { holder?: Attributed; since?: string } };
      /** Present ONLY when `reason === 'moved'` (#715 (b), `seal_run`): the version the delta
       *  expected, and the version stored. */
      expected?: number;
      stored?: number;
    };
