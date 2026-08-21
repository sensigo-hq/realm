// run-health.ts — typed run-health classification with honest per-surface reporting (issue #221).
//
// classifyRunHealth is the SINGLE shared predicate the three READ surfaces — get_run_state,
// `realm run list --stuck`, and `realm run inspect` — derive from, so none of them can silently
// drift from another about what "wedged" or "idle" means (the issue's own AC-4: "all... surfaces
// derive from ONE shared predicate — no drift"). Pure, read-only, definition-optional,
// `now`-injectable (deterministic tests, no fake timers, no real sleeps).
//
// `realm run reclaim` is NOT a fourth consumer of this function (record §2, fold B2) — it answers
// a different question (settled vs. no-active-claim on an already-touched step, not health
// findings on an in-progress/parked run) via its own independent discriminator,
// `classifyNoActiveClaim` in reclaim-step.ts, which reads the same underlying record facts
// (settle-set membership, capability_blocks, reclaim-audit evidence) without calling this
// function at all.
//
// Branch-conditioning table (design record §1, fold B1 — the detectors are CALL-SITE-conditioned,
// not internal to any one detector):
//   1. issue #279 (increment 1, PR-B), design record §6 — this guard is NARROWED (explicitly
//      authorized): `terminal ∧ no pending finalizer_ledger entries ⇒ []`. Pendings are checked
//      BEFORE the terminal short-circuit — a terminal run with an undrained finalizer gets EXACTLY
//      the new `terminal_pending_finalizer` finding(s) and NOTHING else (no claim/capability/idle
//      finding may leak through on a terminal run; the narrowed guard still suppresses them once
//      the pending check clears). A terminal run with a fully-drained (or finalizer-free) ledger
//      still returns [] exactly as before — including a terminal+claimed guard-abort record (a
//      claim can still be `in_progress_steps` at the instant a guard aborts the run) — nothing
//      further to report — **and the run did not complete while carrying `failed_steps` (item 6,
//      below); that class is narrower still, checked in the same branch.**
//   2. Claim findings: `classifyInProgressClaims(run, now)` entries with `state !== 'healthy' &&
//      step !== run.pending_gate?.step_name`. The open-gate claim is always `{deadline: null}` ⇒
//      `claim_unknown_age` — excluding it is what keeps a healthy gate_waiting run at ZERO
//      findings (the B1 negative pin); without the exclusion EVERY healthy gated run would flag.
//      `kind` is keyed by PHASE, not by the claim's own state: `run_phase === 'gate_waiting'` ⇒
//      `wedged_gate_sibling`, else `stale_claim` — so a `claim_unknown_age` claim on a `running`
//      run still gets `kind: 'stale_claim'` per this table (the more precise distinction survives
//      in `reason`, which mirrors the claim's own state string verbatim — single-sourced, never
//      reinvented). Subsumes list.ts's pre-#221 `wedgedNonGatedClaims` (deleted there; see the
//      source-text negative pin in list.test.ts).
//   3. Capability findings: `findCapabilityBlockedSteps(run)` ⇒ `capability_block`. That function's
//      own eligibility cross-check already self-suppresses a stale marker whose step has since
//      settled, so no extra suppression is needed here.
//   4. `never_claimed_idle` (the #221 class): `run_phase === 'running' && in_progress_steps.length
//      === 0 && (now − updated_at) >= idleThresholdMs`. Age-gated by DEFAULT_IDLE_THRESHOLD_MS
//      (24h, engine-minted per the K8s/Prometheus convention that detection never REQUIRES an
//      operator-supplied threshold) unless the caller overrides. `since`, `idle_ms`, and
//      `evidence.idle_threshold_ms` are REQUIRED on this finding (pinned by the boundary +
//      invariant tests) — the threshold rides the finding's own evidence so a reader never has to
//      go find it elsewhere. `opts.definition`, when supplied, additionally adds
//      `evidence.eligible_steps` (Temporal's list-cheap/describe-rich split); a definition-free
//      caller still classifies correctly on age alone.
//   5. issue #279 (increment 2, PR-D, design record §9) — THREE new finding classes surfacing the
//      #282 class and its adjacent gate-corruption/liveness classes:
//        - `terminal_with_stale_gate`: `run.terminal_state && run.pending_gate !== undefined` — a
//          grandfathered #282-class record (checked INSIDE branch 1, above the `pendingFindings`
//          return, since a terminal run never reaches branches 2-4). Pointer to `realm run purge`.
//        - `gate_corruption` (G-2): a `settled` entry with `outcome === 'gate'` whose `token`
//          equals `run.pending_gate.gate_id` — the both-match corruption N9 names (fail-safe
//          NOOP-not-RESOLVE pinned in settlement.ts, but `pending_gate` then never clears itself).
//          Checked in BOTH the terminal branch (1) and the non-terminal path — a live pending_gate
//          can coexist with either. Exits: settle_step abort or purge.
//        - `resolved_gate_with_eligible_guard` (N8's surface): `opts.definition` supplied AND
//          `findEligibleGuardSteps(definition, run)` non-empty — that function ALREADY self-filters
//          both a terminal run and an open gate (eligibility.ts), so this is checked unconditionally
//          in the non-terminal path with no extra gating needed. Disclosed consequence (list.ts is
//          frozen and passes no `definition` — this finding never surfaces there; ACCEPTABLE, not a
//          list.ts defect).
//   6. issue #302 (disclosure gaps) — `completed_with_failed_steps`: `run.terminal_state === true`
//      ∧ `deriveRunPhase(run) === 'completed'` ∧ `run.failed_steps.length > 0` — checked inside
//      branch 1, above its `pendingFindings.length > 0` return. A completed seal carrying
//      `failed_steps` is DESIGNED recovery behavior (eligibility.ts:62-66: trigger_rule routes
//      around the failure and the run still reaches `terminal_reason: 'Workflow completed.'`), not
//      an error — informational only, never `report_to_user`. Deliberately keyed on the DERIVED
//      phase (never the persisted `run_phase` field, and never re-derived as the byte-equivalent
//      direct `terminal_reason === 'Workflow completed.'` check) — the disposal rule (D-3, above)
//      applies here exactly as it does everywhere else in this module: control flow keys on
//      `terminal_state`/marker fields/DERIVED phase, never on a persisted label. Finalizer
//      self-failures (F4: a finalizer's OWN failure grows `failed_steps` after the mint) are
//      included by name, undiscriminated from a domain-step failure — this is honest raw data, not
//      a judgment about WHICH failure kind produced the completed-with-failures seal. That
//      inclusion is what separates this finding from the MINT-time
//      `completed_with_failed_steps` finalizer trigger (settlement.ts `deriveEffectiveTriggers`),
//      which tests the same shape but tests it before any finalizer has run: a post-mint
//      finalizer self-failure is visible HERE and was never visible THERE. Tracked at #374 (P5).
//
// Honest-admission rule (Celery-corrected, record §1): `never_claimed_idle`'s reason text NEVER
// claims rejection — "parked with no claimed step, idle", never "rejected" or "stuck". Rescoped
// (issue #220): the two COUNTED validation-rejection codes (VALIDATION_INPUT_SCHEMA/
// VALIDATION_OUTPUT_SCHEMA) are now record-carried since #220 (`RunRecord.validation_rejections`)
// — but this function still does not render that count; surfacing it is #219's future enrichment
// slot, not this one's. A TRACE-rejection count (VALIDATION_TRACE_SCHEMA, uncounted v1 — see
// execution-loop.ts's countRejection doc) still requires sidecar evidence this function
// structurally cannot see (classification here is write-free by construction).
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { classifyInProgressClaims } from './claim-liveness.js';
import { findCapabilityBlockedSteps } from './capability.js';
import { findEligibleSteps, findEligibleGuardSteps, deriveRunPhase } from './eligibility.js';

/**
 * Default age threshold for the `never_claimed_idle` finding (issue #221) — 24 hours. Engine-
 * minted so detection never REQUIRES an operator-supplied threshold; callers (surfaces) may
 * override via `opts.idleThresholdMs`. This constant is THE resolution point for every surface —
 * only `realm run list --stuck` exposes an observer override (`--older-than`); get_run_state and
 * inspect take no override by design (agents don't tune detectors).
 */
export const DEFAULT_IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * A single, typed run-health observation (issue #221) — the shared vocabulary every surface
 * renders from.
 */
export interface RunHealthFinding {
  kind:
    | 'never_claimed_idle'
    | 'stale_claim'
    | 'wedged_gate_sibling'
    | 'capability_block'
    | 'terminal_pending_finalizer'
    // issue #279 (increment 2, PR-D, design record §9) — the #282 class + its adjacent classes.
    | 'terminal_with_stale_gate'
    | 'gate_corruption'
    | 'resolved_gate_with_eligible_guard'
    // issue #302 (disclosure gaps) — a completed seal that still carries failed_steps (designed
    // recovery behavior; see item 6 in the branch-conditioning table above).
    | 'completed_with_failed_steps'
    // issue #291: a live gate whose frozen enforce clock has expired but nothing has enacted it
    // yet — the "awaiting a drive" window the feature's own read-side finding names. NEVER a
    // reminder-overdue signal (the B1 negative pin: the notify clock has zero settlement
    // authority, so a reminder-overdue gate stays HEALTHY — see the module doc's honest-
    // admission rule).
    | 'gate_expired_awaiting_drive'
    // issue #316: one or more steps that DECLARED `structured_output: 'strict'` ran without it —
    // a degraded-assurance disclosure (outputs were still validated post-hoc, L1), never an
    // error. Excludes `external_agent`-attributed downgrades (an MCP-driven run's synthesized
    // stamp is never realm's own doing to report on) — see `findStructuredOutputDowngrades`.
    // issue #311: for a strict step that also declares tools this fires on EVERY run by design
    // (permanent `unsupported_context_tools` baseline for the OUTPUT dimension) — read the
    // reason list, not the finding's presence. See the detector's own scope notes.
    | 'structured_output_downgraded';
  /** The affected step, when the finding is step-scoped. Absent for `never_claimed_idle` — a
   *  run-level observation (no step is claimed at all). */
  step?: string;
  /** Programmatic-identifier style, stable, single-sourced from the underlying detector (e.g. the
   *  claim's own liveness state, or the capability block's own error code) — never a freshly
   *  invented sentence per finding. */
  reason: string;
  /** Age anchor (ISO timestamp) — the reader computes human-readable age from this; it is never
   *  pre-formatted here. `updated_at` for `never_claimed_idle`; the capability block's own `at`
   *  for `capability_block`. Absent for claim findings (no reliable claim-start timestamp is
   *  tracked anywhere in the run record — only a deadline, which is carried in `evidence`
   *  instead). REQUIRED for kind `never_claimed_idle`. */
  since?: string;
  /** Milliseconds idle, computed from `opts.now`. REQUIRED (together with `since`) for kind
   *  `never_claimed_idle`; absent otherwise. */
  idle_ms?: number;
  /** Kind-specific supporting data — label-sufficient for every surface to render without
   *  reaching back into the run record: claim findings carry `{state, deadline}`; capability
   *  findings carry `{requirement, code}`; `never_claimed_idle` carries `{idle_threshold_ms}` and,
   *  when `opts.definition` was supplied, `{eligible_steps}`. */
  evidence?: Record<string, unknown>;
}

/**
 * G-2-corruption detector (issue #279, increment 2, PR-D, design record §9/N9): a `settled` entry
 * recording a resolved gate (`outcome === 'gate'`) whose `token` equals the run's OWN live
 * `pending_gate.gate_id` — the both-match corruption `settleGateArms`'s lookup-first ordering
 * fail-safes against (NOOP, never RESOLVE — settlement.ts), but which then leaves `pending_gate`
 * permanently unclearable by normal means (exits: `settle_step` abort, or `realm run purge`).
 * Out-of-contract producer only (a real store honoring `settleStep`'s own atomicity can never
 * produce this); a run-health finding is the detection surface. Checked from BOTH branches of
 * {@link classifyRunHealth} (a live pending_gate can coexist with this corruption whether or not
 * the run has separately gone terminal).
 */
function findGateCorruption(run: RunRecord): RunHealthFinding | undefined {
  if (run.pending_gate === undefined) return undefined;
  const gateId = run.pending_gate.gate_id;
  for (const [step, entry] of Object.entries(run.settled ?? {})) {
    if (entry.outcome === 'gate' && entry.token === gateId) {
      return {
        kind: 'gate_corruption',
        step,
        reason:
          'settled gate entry coexists with a live pending_gate bearing the same gate_id — ' +
          'store history divergent',
        evidence: { gate_id: gateId },
      };
    }
  }
  return undefined;
}

/**
 * issue #316: `structured_output_downgraded` — ONE aggregated finding per run (the #304 shape:
 * one finding carrying the list, never one per step), covering every `EvidenceSnapshot` in
 * `run.evidence` whose `diagnostics.structured_output.downgrade_reason` is present and is NOT
 * `'external_agent'`. That exclusion is LOAD-BEARING, not belt-and-braces: the three synthesized
 * stamps execution-loop.ts mints when a declared step arrives with no `stepMeta.structuredOutput`
 * at all (an external agent driving `execute_step` over MCP directly) all set
 * `sent: false, downgrade_reason: 'external_agent'` — without this exclusion, EVERY MCP-driven
 * declared run would fire this finding regardless of whether strict was ever actually attempted.
 *
 * Dedup'd per step: a step retried N times with the SAME reason across attempts contributes that
 * reason once; a step that saw DIFFERENT reasons across distinct attempts (e.g. `api_rejected_schema`
 * on attempt 1, `service_unavailable` on a retry) lists every distinct reason it saw, in
 * first-seen order — never conflated into one bucket, never silently dropped to "the last one".
 * Checked from BOTH branches of {@link classifyRunHealth}, mirroring {@link findGateCorruption}'s
 * own dual-branch pattern — a live run's evidence and a terminal run's evidence are read exactly
 * the same way; only WHERE the caller is standing differs.
 *
 * THREE scope notes an operator needs before reading this finding:
 *
 * 1. EXPECTED FIRE, not an anomaly. Every run of a step that declares `structured_output: strict`
 *    AND declares tools now fires this finding with `unsupported_context_tools`, on every run,
 *    permanently — that step's OUTPUT is produced on the tools path, which has no
 *    grammar-constrained submit call. It is a true statement about the output dimension, and it
 *    is a baseline, not a regression signal. Do not tune alerting on the finding's mere presence
 *    for such steps; look at the reason list.
 * 2. The finding is OUTPUT-dimension-first. The tool-ARGUMENTS dimension contributes exactly one
 *    marked literal, `tool_args:api_rejected_schema` (see the loop below). A tools step can be
 *    running strict successfully on most of its tools while this finding reports
 *    `unsupported_context_tools` — those are not in contradiction. Per-tool detail is deliberately
 *    NOT surfaced here (it belongs to `realm run inspect`/`export`); MCP pollers see this narrow
 *    finding only.
 * 3. (issue #313) A SECOND expected-fire baseline: a strict-declared step driven through an
 *    OpenAI-COMPATIBLE endpoint (`--base-url`) without the `--strict-base-url` attestation fires
 *    this finding on every run with `compat_endpoint`. Realm declined to send strict rather than
 *    send it into an endpoint that might accept and ignore it — a deliberate choice, correctly
 *    reported. Baseline, not regression; the operator remedy is either `--strict-base-url` (if
 *    the endpoint genuinely enforces strict) or a native endpoint. Note this is INCLUDED while
 *    `external_agent` is excluded, and the distinction is epistemic, not cosmetic: realm cannot
 *    KNOW what an external driver did, whereas compat is realm's own decision — the same footing
 *    as `unsupported_context_tools`, which is also included.
 */
function findStructuredOutputDowngrades(run: RunRecord): RunHealthFinding | undefined {
  const reasonsByStep = new Map<string, Set<string>>();
  for (const entry of run.evidence) {
    const meta = entry.diagnostics?.structured_output;
    if (meta === undefined) continue;
    if (meta.downgrade_reason !== undefined && meta.downgrade_reason !== 'external_agent') {
      const reasons = reasonsByStep.get(entry.step_id) ?? new Set<string>();
      reasons.add(meta.downgrade_reason);
      reasonsByStep.set(entry.step_id, reasons);
    }
    // issue #311 — the NARROW tool-arguments widening. Only ONE class from the tool-args
    // dimension is admitted: `api_rejected_schema`, the event where the API actively REJECTED a
    // strict tool schema realm had assessed as eligible. That is the trigger #346 watches for,
    // and it is the only tool-args outcome an operator can act on. Everything else in
    // `tool_args.reasons` (`budget_excluded`, the eligibility verdict codes, the 503 labels) is
    // routine, expected, and would drown the finding — it stays visible via inspect/export.
    //
    // The literal is DIMENSION-MARKED (`tool_args:` prefix) so it can never be confused with the
    // step-OUTPUT reason of the same name, and so the #346 trigger greps cleanly against the
    // permanent `unsupported_context_tools` baseline every opted-in tools step now carries.
    for (const tool of meta.tool_args?.tools ?? []) {
      if (!(tool.reasons ?? []).includes('api_rejected_schema')) continue;
      const reasons = reasonsByStep.get(entry.step_id) ?? new Set<string>();
      reasons.add('tool_args:api_rejected_schema');
      reasonsByStep.set(entry.step_id, reasons);
    }
  }
  if (reasonsByStep.size === 0) return undefined;

  const steps = [...reasonsByStep.entries()].map(([step, reasons]) => ({
    step,
    reasons: [...reasons],
  }));
  const stepSummaries = steps.map((s) => `${s.step}: ${s.reasons.join(', ')}`);
  return {
    kind: 'structured_output_downgraded',
    reason:
      `${steps.length} step(s) requested strict structured output but ran without it ` +
      `(${stepSummaries.join('; ')}) — outputs were validated post-hoc (L1), not grammar-constrained`,
    evidence: { steps },
  };
}

/**
 * Classifies a run's health into zero or more typed findings. Pure, read-only, definition-
 * optional, `now`-injectable. See the module doc above for the full branch-conditioning table
 * (design record §1, fold B1) and the honest-admission rule.
 */
export function classifyRunHealth(
  run: RunRecord,
  opts?: { now?: Date; idleThresholdMs?: number; definition?: WorkflowDefinition },
): RunHealthFinding[] {
  const now = opts?.now ?? new Date();

  // Branch 1 — NARROWED first guard (issue #279, increment 1, PR-B, design record §6, explicitly
  // authorized): checked BEFORE the terminal short-circuit. A terminal run with a still-'pending'
  // finalizer_ledger entry gets EXACTLY these findings and returns immediately — no claim,
  // capability, or idle finding may leak through on a terminal run.
  if (run.terminal_state) {
    const pendingFindings: RunHealthFinding[] = [];
    for (const [name, entry] of Object.entries(run.finalizer_ledger ?? {})) {
      if (entry.status !== 'pending') continue;
      const isLeased = entry.lease_token !== undefined && entry.lease_deadline !== undefined;
      const leaseExpired = isLeased && new Date(entry.lease_deadline!).getTime() <= now.getTime();
      const reason = !isLeased ? 'never_leased' : leaseExpired ? 'lease_expired' : 'lease_held';
      pendingFindings.push({
        kind: 'terminal_pending_finalizer',
        step: name,
        reason,
        evidence: {
          rank: entry.rank,
          ...(entry.lease_deadline !== undefined ? { lease_deadline: entry.lease_deadline } : {}),
        },
      });
    }
    // issue #279 (increment 2, PR-D, design record §9): terminal-with-stale-gate — the #282
    // class's own surface. A terminal record that STILL carries a pending_gate is a grandfathered
    // (or mixed-fleet old-binary-written) record; purge is the disposal path.
    if (run.pending_gate !== undefined) {
      pendingFindings.push({
        kind: 'terminal_with_stale_gate',
        step: run.pending_gate.step_name,
        reason:
          'run is terminal but still carries a pending_gate (a grandfathered #282-class record)',
        evidence: { gate_id: run.pending_gate.gate_id },
      });
    }
    // G-2-corruption: checked here too — a terminal record can carry the same both-match
    // corruption a live run can (N9).
    const terminalGateCorruption = findGateCorruption(run);
    if (terminalGateCorruption !== undefined) pendingFindings.push(terminalGateCorruption);
    // issue #302 (disclosure gaps, item 6 above): a completed seal that still carries failed_steps
    // — designed recovery behavior, informational only. Keyed on the DERIVED phase (never the
    // persisted run_phase field, never the byte-equivalent direct terminal_reason check).
    if (deriveRunPhase(run) === 'completed' && run.failed_steps.length > 0) {
      pendingFindings.push({
        kind: 'completed_with_failed_steps',
        reason:
          `completed with ${run.failed_steps.length} failed step(s): ${run.failed_steps.join(', ')} ` +
          `— fail-triggered finalizers do not run on a completed seal unless the workflow opts ` +
          `into the 'completed_with_failed_steps' trigger`,
        evidence: { failed_steps: run.failed_steps },
      });
    }
    // issue #316: structured_output_downgraded on the terminal path — the run is sealed, but its
    // permanent evidence still records any strict-downgrade that happened before it sealed. This
    // is the ONLY surface a downgrade on a run's final step reaches (get_run_state hard-zeroes
    // run_health on a terminal run, the frozen #279-R3 guard below — see the module doc).
    const terminalDowngrade = findStructuredOutputDowngrades(run);
    if (terminalDowngrade !== undefined) pendingFindings.push(terminalDowngrade);
    if (pendingFindings.length > 0) return pendingFindings;
    // terminal ∧ no pending ledger entries ∧ not completed-with-failed-steps ∧ no recorded
    // structured-output downgrade ⇒ [] (byte-identical to pre-#279 behavior for every OTHER class
    // of terminal record).
    return [];
  }

  const idleThresholdMs = opts?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const findings: RunHealthFinding[] = [];

  // Branch 2 — claim findings (subsumes list.ts's pre-#221 wedgedNonGatedClaims).
  for (const c of classifyInProgressClaims(run, now)) {
    if (c.state === 'healthy') continue;
    if (c.step === run.pending_gate?.step_name) continue; // the open-gate claim is never a wedge
    findings.push({
      kind: run.run_phase === 'gate_waiting' ? 'wedged_gate_sibling' : 'stale_claim',
      step: c.step,
      reason: c.state,
      evidence: { state: c.state, deadline: c.deadline },
    });
  }

  // Branch 3 — capability findings (findCapabilityBlockedSteps already self-suppresses a stale
  // marker whose step has since settled, via its own eligibility cross-check).
  for (const b of findCapabilityBlockedSteps(run)) {
    findings.push({
      kind: 'capability_block',
      step: b.step,
      reason: b.code,
      since: b.at,
      evidence: { requirement: b.requirement, code: b.code },
    });
  }

  // issue #279 (increment 2, PR-D, design record §9): G-2-corruption on the non-terminal path too
  // — a live pending_gate can coexist with the same both-match corruption a terminal record can.
  const gateCorruption = findGateCorruption(run);
  if (gateCorruption !== undefined) findings.push(gateCorruption);

  // issue #316: structured_output_downgraded on the live path too — this is the run-health
  // watchdog scenario the issue was filed for: a poller sees the downgrade WHILE the run is still
  // in flight, via get_run_state's run_health + its warning line, without waiting for a terminal
  // seal (which, per the module doc, get_run_state never surfaces run_health for at all).
  const structuredOutputDowngrade = findStructuredOutputDowngrades(run);
  if (structuredOutputDowngrade !== undefined) findings.push(structuredOutputDowngrade);

  // issue #291: gate_expired_awaiting_drive — record-fields-only (never the definition), fires
  // for BOTH an enactable gate AND a finding-only one (expires_at present, on_expiry absent) —
  // the finding-only payload names its own disposition as 'finding_only' rather than omitting
  // the finding entirely (a finding-only gate is STILL awaiting a human drive; the operator
  // should still see it). Unreachable on a terminal record by construction (the terminal branch,
  // above, returns before this line is ever reached).
  if (
    run.pending_gate !== undefined &&
    run.pending_gate.expires_at !== undefined &&
    now.getTime() >= new Date(run.pending_gate.expires_at).getTime()
  ) {
    const overdueMs = now.getTime() - new Date(run.pending_gate.expires_at).getTime();
    findings.push({
      kind: 'gate_expired_awaiting_drive',
      step: run.pending_gate.step_name,
      reason:
        run.pending_gate.on_expiry !== undefined
          ? `gate expired — awaiting enactment of the declared ${run.pending_gate.on_expiry}`
          : 'gate expired — finding-only (no on_expiry declared), awaiting a human response',
      evidence: {
        gate_id: run.pending_gate.gate_id,
        expires_at: run.pending_gate.expires_at,
        overdue_ms: overdueMs,
        disposition: run.pending_gate.on_expiry ?? 'finding_only',
      },
    });
  }

  // issue #279 (increment 2, PR-D, design record §9, N8's surface): resolved-gate-with-eligible-
  // guard. findEligibleGuardSteps ALREADY self-filters both a terminal run and an open gate
  // (eligibility.ts), so no extra gating is needed beyond requiring a definition.
  if (opts?.definition !== undefined) {
    for (const guardName of findEligibleGuardSteps(opts.definition, run)) {
      findings.push({
        kind: 'resolved_gate_with_eligible_guard',
        step: guardName,
        reason: `gate resolved; guard '${guardName}' awaits the next drive`,
      });
    }
  }

  // Branch 4 — never_claimed_idle (the #221 class). since/idle_ms/evidence.idle_threshold_ms are
  // REQUIRED on this finding.
  if (
    run.run_phase === 'running' &&
    run.in_progress_steps.length === 0 &&
    now.getTime() - new Date(run.updated_at).getTime() >= idleThresholdMs
  ) {
    findings.push({
      kind: 'never_claimed_idle',
      reason: 'parked with no claimed step, idle',
      since: run.updated_at,
      idle_ms: now.getTime() - new Date(run.updated_at).getTime(),
      evidence: {
        idle_threshold_ms: idleThresholdMs,
        ...(opts?.definition !== undefined
          ? { eligible_steps: findEligibleSteps(opts.definition, run) }
          : {}),
      },
    });
  }

  return findings;
}
