// settlement.ts — types for the atomic RunStore.settleStep operation (issue #279, increment 1).
// Normative spec: plans/issue-279/design-d4-increment1.md §1/§2/§3/§7 (read that record in full
// before touching this file — it is the specification; this file's JSDoc cross-references it but
// does not restate the predicate/transform pseudocode).
//
// PR-A scope: these types exist so the store operation + the pure transform + the TCK can be
// built and forced — the ENGINE never constructs a SettlementDelta or calls settleStep in this
// PR (see the source-text guard in index.ts's own test coverage). PR-B migrates the three seal
// sites to use them.
import type { EvidenceSnapshot } from './run-record.js';

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
 * `buildFinalizedSeal`'s existing one-entry-per-finalizer-per-drain-pass cardinality) — singular,
 * not an array, unlike `SettleStepDelta.evidence`.
 */
export interface MarkFinalizerDelta {
  kind: 'mark_finalizer';
  finalizer: string;
  leaseToken: string;
  result: MarkFinalizerResult;
  evidence: EvidenceSnapshot;
}

/** The three delta kinds `RunStore.settleStep` accepts (design record §1). A concrete discriminated
 *  union — no structural intersections, no duck-typing. */
export type SettlementDelta = SettleStepDelta | LeaseFinalizerDelta | MarkFinalizerDelta;

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
  | 'not_eligible';

/**
 * The ok-shaped NOOP subset of {@link SettlementRefusalReason} (design record §7: "ok-shaped
 * NOOP" — envelope-calm, `context_hint` never `report_to_user`, I15). L1's "routine same-run
 * fan-out produces ZERO refusals" acceptance sentence is stated against the NON-noop subset: a
 * same-token retry landing as one of these three is an idempotent no-op, never counted as a
 * refusal. L13/L21 discriminate on this sub-union explicitly.
 */
export type SettlementNoopReason = 'already_settled' | 'already_leased' | 'already_marked';

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
      /** Whether THIS apply caused the terminal false→true edge (settle_step only — a
       *  lease/mark delta's `isTerminal(fresh)` precondition means the run was already terminal
       *  both before and after, so it is always `false` for those two kinds). */
      transitioned: boolean;
      /** The current pending finalizer set on `run.finalizer_ledger`, by ascending `rank` —
       *  a convenience snapshot so a caller can decide whether to invoke the drain verb without
       *  re-scanning the ledger itself (design record §6: the drain loop's OWN pass always
       *  re-reads the ledger from the latest settle/lease/mark result directly, never trusting a
       *  cached list across iterations — this field is that first read). */
      pendingFinalizers: readonly string[];
    }
  | {
      applied: false;
      reason: SettlementRefusalReason;
      run: import('./run-record.js').RunRecord;
    };
