// get-run-state tool — returns the current state summary of a run.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SEAL_ARMS,
  JsonFileStore,
  JsonWorkflowStore,
  WorkflowError,
  resolvePreExecutionAgentAction,
  buildNextActions,
  findEligibleSteps,
  classifyInProgressClaims,
  findCapabilityBlockedSteps,
  classifyRunHealth,
  persistsField,
  deriveDefaultedSteps,
  deriveRunPhase,
  type RunPhase,
  type NextAction,
  type ClaimState,
  type SkipDetail,
  type RunStore,
  type WorkflowDefinition,
  type RunHealthFinding,
} from '@sensigo/realm';
import { sseJsonStringify } from '../sse-json.js';

export interface HandleRunStateStores {
  /** Any `RunStore` implementation (issue #188, PR-1 — was `JsonFileStore`-only). */
  runStore?: RunStore;
  /**
   * Optional workflow store used to compute `next_actions`. When absent (or the workflow is not
   * registered), `next_actions_status` is `'workflow_unresolved'`. Intentionally NOT defaulted to a
   * fresh JsonWorkflowStore so the function stays hermetic for tests/programmatic callers.
   */
  workflowStore?: JsonWorkflowStore;
}

/**
 * Diagnostic classification of `next_actions`:
 * - `ok` — next_actions reflects what to do next (may be empty for a healthy run with only
 *   downstream auto work that hasn't been triggered).
 * - `auto_pending` — eligible steps exist but are all `auto` (buildNextActions drops them); the run
 *   is making engine-side progress, not awaiting the agent.
 * - `awaiting_human` — a human gate is open.
 * - `workflow_unresolved` — no workflow store provided, or the workflow is not registered.
 * - `skipped_terminal` — the run is terminal; nothing to do.
 * - `claim_stale` — a non-terminal run has an in-progress claim past its deadline (a likely-dead
 *   runner / the after-claim wedge, issue #101). Surfaced even when a healthy sibling is in flight.
 * - `claim_unknown_age` — a non-terminal run's only in-progress claims have no deadline (agent /
 *   finalizer-bearing / legacy) and there is nothing else to do — detect-only, human-judged.
 * - `blocked_on_capability` — a non-terminal run has a step parked by a not-registered handler/adapter
 *   (issue #134): the step settled recoverably and is eligible again, awaiting a runner that provides
 *   the missing capability. Computed definition-free, so it also refines the `workflow_unresolved` path.
 *   Outranks `claim_stale` (a more specific, actionable diagnosis); ranks below `awaiting_human`.
 */
export type NextActionsStatus =
  | 'ok'
  | 'auto_pending'
  | 'awaiting_human'
  | 'workflow_unresolved'
  | 'skipped_terminal'
  | 'claim_stale'
  | 'claim_unknown_age'
  | 'blocked_on_capability';

export interface RunStateSummary {
  run_id: string;
  workflow_id: string;
  run_phase: RunPhase;
  terminal_state: boolean;
  /**
   * The run's own terminal-seal reason string, verbatim (issue #302 — disclosure gaps), e.g.
   * `'Workflow completed.'`. Present only when the underlying `RunRecord.terminal_reason` is set —
   * absent on a live (non-terminal) run, never a synthesized/default string. This is what
   * `deriveRunPhase`'s LEGACY leg keys the `'completed'` phase on — on a stamped record the arm
   * derives and this string is read by nobody (issue #367) — so an MCP
   * consumer that wants to distinguish "completed cleanly" from "completed with failed_steps
   * carried" (issue #302's `completed_with_failed_steps` run-health class — CLI-only; this run's
   * own `get_run_state` terminal guard below stays byte-untouched, see `run_health`'s own doc)
   * now has the raw signal to combine with `failed_steps` and the derived `run_phase` itself,
   * without needing the run-health surface this response deliberately does not inherit.
   */
  terminal_reason?: string;
  /**
   * Issue #367: WHICH arm of the engine sealed this run — the recorded fact, not a re-reading of
   * the prose. Present on any terminal run written since #367, and absent on the legacy population
   * (where `run_phase` is recovered by the read-path classifier instead). Normally absent on a
   * live run — with ONE honest exception: an ORPHANED stamp awaiting self-heal, which an old
   * binary's resume produces by flipping the run live while keeping the seal. Such a record
   * renders an arm beside `run_phase: 'running'`, and that IS the truth about it; the derivation
   * deliberately ignores the stamp there, and the next settle write strips it. An arm this binary
   * does not recognise renders as `unrecognized arm '<value>'` rather than being omitted, so a
   * newer writer's record is never silently reported as unsealed.
   *
   * Prefer this over parsing `terminal_reason`: the prose is for people.
   */
  sealed_by_arm?: string;
  completed_steps: string[];
  in_progress_steps: string[];
  failed_steps: string[];
  skipped_steps: string[];
  pending_gate: import('@sensigo/realm').PendingGate | undefined;
  evidence_count: number;
  last_step: string | null;
  created_at: string;
  updated_at: string;
  params: Record<string, unknown>;
  abort_context?: {
    step_id: string;
    conditions?: Array<{ condition: string; resolved_value: unknown; passed: boolean }>;
    abort_message?: string;
  };
  /**
   * Eligible agent/handler steps for this run. Empty unless `next_actions_status` is `'ok'` —
   * except a `claim_stale` status may accompany still-actionable steps when a dead claim coexists
   * with eligible work mid-fan-out (the dead claim overrides the status but does not hide the work).
   */
  next_actions: NextAction[];
  /** Diagnostic classification — distinguishes a genuinely-stuck run from "nothing pending". */
  next_actions_status: NextActionsStatus;
  /**
   * Advisory (issue #101): non-healthy in-progress claims that are NOT the open-gate step —
   * present on any non-terminal run whenever such claims exist. This surfaces an after-claim wedge
   * even when the aggregate `next_actions_status` cannot show it: notably a `gate_waiting` run
   * (status stays `awaiting_human`) that carries a crashed sibling claim on another fan-out branch.
   * The `pending_gate` step is never included (it is legitimately pinned while its gate is open).
   */
  stuck_claims?: Array<{ step: string; state: ClaimState }>;
  /**
   * Advisory (issue #134): steps parked by a not-registered handler/adapter that are still eligible —
   * present on any non-terminal run whenever such markers exist. Definition-free (via
   * `findCapabilityBlockedSteps`), so it surfaces even on the `workflow_unresolved` path and behind a
   * healthy in-progress sibling. May coexist with `stuck_claims` on a fan-out run. Names the missing
   * requirement so an operator (or a pure-MCP consumer, via `execute_step` on the named step) can recover.
   */
  capability_blocks?: Array<{
    step: string;
    requirement: { kind: 'handler' | 'adapter'; name: string };
    code: string;
  }>;
  /**
   * Reason detail for each skipped step (issue #111) — present only when non-empty. Additive:
   * `skipped_steps` above stays the authoritative set; a skipped step may still lack an entry
   * here (a legacy run, or a skip family not yet carrying a detail).
   */
  skip_details?: Record<string, SkipDetail>;
  /**
   * Typed run-health findings (issue #221) — present only when non-empty. Computed by
   * `classifyRunHealth`, the SAME shared predicate the three READ surfaces (`get_run_state`,
   * `realm run list --stuck`, `realm run inspect`) derive from, so none of them can silently drift
   * from another about what "wedged" or "idle" means. (`realm run reclaim` reads the SAME
   * underlying record facts — settle sets, capability_blocks, reclaim-audit evidence — via its
   * own independent discriminator, `classifyNoActiveClaim`; it does not call this function.) This
   * is the CANONICAL SUPERSET of `stuck_claims`/`capability_blocks` above — those two legacy
   * arrays are KEPT for backward compatibility (existing consumers), but a new consumer should
   * prefer `run_health`. Never alters `next_actions_status` (fine-maps-to-coarse, never the
   * reverse — the systemd invariant): a wedge is surfaced here even when the aggregate status
   * cannot show it (notably a `gate_waiting` run, whose status MUST stay `awaiting_human`).
   */
  run_health?: RunHealthFinding[];
  /**
   * Names of steps that settled via their declared `validation_exhaustion.default_output`
   * substitution (issue #232) — present only when non-empty. Derived on demand from
   * `evidence[].diagnostics.settled_by_default` via the SAME shared `deriveDefaultedSteps` helper
   * `RunRecord.defaulted_steps` itself is stamped from (issue #220 PR-2), so this field is exact
   * (AC-2) and — for a `'complete'` run — identical to the persisted field (AC-4). Unlike the
   * persisted field, this is computed UNIFORMLY regardless of how the run sealed (complete,
   * failed, or aborted): a run that default-settles a step and then fails still surfaces it here,
   * closing the failure-path disclosure gap `defaulted_steps`'s complete-only stamping leaves.
   */
  defaulted_steps?: string[];
  /**
   * Advisory diagnostics for this response (issue #119: WARN-never-gate — never a throw, never a
   * behavior change). Independent sources, any subset may be present:
   *  - Store-fidelity caveats (issue #188): the configured run store does NOT declare it persists
   *    a load-bearing field this response depends on (`capability_blocks`) or the per-claim
   *    liveness clock (`claims`, via `persistsClaims`) — so a field reading absent/empty may be a
   *    store limitation rather than genuine absence (absence ≡ Unknown, never healthy-false).
   *  - A run-health presence line (issue #221): fires whenever `run_health` above is non-empty, so
   *    a consumer reading only `warnings` (not `run_health`) still learns something needs
   *    attention.
   */
  warnings?: string[];
}

/**
 * Business logic for the get_run_state tool.
 * Returns a structured summary of the run without the full evidence array.
 */
export async function handleGetRunState(
  args: { run_id: string },
  stores?: HandleRunStateStores,
): Promise<RunStateSummary> {
  const runStore = stores?.runStore ?? new JsonFileStore();
  const run = await runStore.get(args.run_id);

  // #134 capability-block detection — definition-free (reads capability_blocks + the four step sets),
  // computed once and used both to refine the status (below) and as the advisory array (in the return).
  // Terminal guard mirrors stuck_claims: a sealed run surfaces nothing to do.
  const capabilityBlocks = run.terminal_state ? [] : findCapabilityBlockedSteps(run);

  // issue #188 field-fidelity gate: capability_blocks read above is only trustworthy if the
  // configured store actually persists it — a store that silently drops it makes a genuinely
  // blocked step look identical to "no blocks" ([] either way). Advisory only: this NEVER changes
  // capabilityBlocks/nextActionsStatus above, it only tells the consumer the read may be a store
  // limitation rather than a real absence.
  const warnings: string[] = [];
  if (!persistsField(runStore, 'capability_blocks')) {
    warnings.push(
      "this run store does not persist 'capability_blocks' — capability-block state is " +
        'unavailable and not authoritative (an empty result may mean "no blocks" or "this ' +
        'store cannot report blocks at all").',
    );
  }
  // issue #221: same pattern, for the per-claim liveness clock — NOT a LoadBearingRunRecordField
  // (persistsField would be the wrong gate; `claims` is keyed off the store's own `persistsClaims`
  // boolean instead, per RunStore's own contract). Absence ≡ Unknown, never healthy-false: a store
  // that cannot report claim liveness makes stale_claim/wedged_gate_sibling findings (and the
  // legacy stuck_claims array) unavailable, not falsely empty.
  if (runStore.persistsClaims !== true) {
    warnings.push(
      "this run store does not persist 'claims' — claim-liveness state is unavailable and not " +
        'authoritative (an empty result may mean "no wedge" or "this store cannot report claim ' +
        'liveness at all").',
    );
  }

  // Compute next_actions + diagnostic status (read-only). Precedence:
  // terminal → skipped_terminal; gate open → awaiting_human; no/unresolved workflow →
  // workflow_unresolved; else buildNextActions/findEligibleSteps → ok | auto_pending.
  // `definition` is hoisted (issue #221) so classifyRunHealth below can reuse it when resolved —
  // scoping/resolution logic here is otherwise UNCHANGED.
  let nextActions: NextAction[] = [];
  let nextActionsStatus: NextActionsStatus;
  let definition: WorkflowDefinition | undefined;
  if (run.terminal_state) {
    nextActionsStatus = 'skipped_terminal';
  } else if (run.pending_gate !== undefined) {
    nextActionsStatus = 'awaiting_human';
  } else {
    definition =
      stores?.workflowStore !== undefined
        ? await stores.workflowStore.get(run.workflow_id).catch(() => undefined)
        : undefined;
    if (definition === undefined) {
      nextActionsStatus = 'workflow_unresolved';
    } else {
      const na = buildNextActions(definition, run);
      const eligible = findEligibleSteps(definition, run);
      if (na.length > 0) {
        nextActions = na;
        nextActionsStatus = 'ok';
      } else if (eligible.length > 0) {
        // Eligible steps exist but are all auto (buildNextActions drops them).
        nextActionsStatus = 'auto_pending';
      } else {
        nextActionsStatus = 'ok';
      }
    }

    // Wedge detection (issue #101) — definition-free (reads the stored per-claim deadline), so it
    // also refines the `workflow_unresolved` path. Carves the wedge states OUT of the
    // 'ok'/'auto_pending'/'workflow_unresolved' fall-through:
    //  - a `claim_stale` claim (past deadline → likely-dead runner) is surfaced even mid-fan-out;
    //  - when only unknown-age claims remain and there is nothing else to do, surface
    //    `claim_unknown_age` (detect-only). A `healthy` in-flight claim (a live runner) stays 'ok'.
    if (run.in_progress_steps.length > 0) {
      const claimStates = classifyInProgressClaims(run).map((c) => c.state);
      if (claimStates.includes('claim_stale')) {
        nextActionsStatus = 'claim_stale';
      } else if (nextActions.length === 0 && !claimStates.includes('healthy')) {
        nextActionsStatus = 'claim_unknown_age';
      }
    }

    // #134 capability block outranks the claim-wedge states (a missing capability is a more specific,
    // actionable diagnosis than a stale/unknown-age claim) but ranks below `awaiting_human` — the gate
    // path returns above without entering this else block, so it wins naturally.
    if (capabilityBlocks.length > 0) {
      nextActionsStatus = 'blocked_on_capability';
    }
  }

  // Advisory wedge surfacing (issue #101), computed UNIFORMLY for every non-terminal path (gate,
  // workflow_unresolved, running) — definition-free. It never alters next_actions_status: on the
  // gate path the status MUST stay `awaiting_human` (drivers key on it), but a crashed non-gated
  // sibling claim on another fan-out branch is still surfaced here. The open-gate step is excluded.
  const stuckClaims = run.terminal_state
    ? []
    : classifyInProgressClaims(run)
        .filter((c) => c.state !== 'healthy' && c.step !== run.pending_gate?.step_name)
        .map((c) => ({ step: c.step, state: c.state }));

  // issue #221: the SAME shared classifyRunHealth predicate the three READ surfaces (get_run_state,
  // list --stuck, inspect) derive from — computed definition-aware when the workflow resolved
  // above (adds eligible_steps evidence to any never_claimed_idle finding), definition-free
  // otherwise (gate / workflow_unresolved paths). Terminal guard mirrors stuck_claims/
  // capability_blocks: a sealed run surfaces nothing. `next_actions_status` above is computed and
  // finalized BEFORE this line runs — nothing below this point may write back to it.
  const runHealth: RunHealthFinding[] = run.terminal_state
    ? []
    : classifyRunHealth(run, definition !== undefined ? { definition } : {});
  if (runHealth.length > 0) {
    warnings.push(
      `this run has ${runHealth.length} active run-health finding(s) — see 'run_health' for detail.`,
    );
  }

  // issue #232: read-time derivation (approach 2, DECIDED) — computed UNIFORMLY for every run
  // regardless of terminal state or seal outcome (no guard here, unlike stampDefaultedSteps'
  // complete-only stamping), via the SAME shared helper that stamping itself now calls.
  const defaultedSteps = deriveDefaultedSteps(run.evidence);

  return {
    run_id: run.id,
    workflow_id: run.workflow_id,
    // issue #279 (increment 2, PR-C — D-3 leg vi): render the DERIVED phase, never the persisted
    // one — a grandfathered terminal-with-stale-gate record (the #282 class) must never report
    // itself as still 'gate_waiting'.
    run_phase: deriveRunPhase(run),
    terminal_state: run.terminal_state,
    completed_steps: run.completed_steps,
    in_progress_steps: run.in_progress_steps,
    failed_steps: run.failed_steps,
    skipped_steps: run.skipped_steps,
    // Suppress a stale/leftover pending_gate on a terminal record (the #282 class) — never
    // surface a gate that no longer means anything live.
    pending_gate: run.terminal_state ? undefined : run.pending_gate,
    evidence_count: run.evidence.length,
    last_step: run.evidence.at(-1)?.step_id ?? null,
    created_at: run.created_at,
    updated_at: run.updated_at,
    params: run.params,
    ...(run.terminal_reason !== undefined ? { terminal_reason: run.terminal_reason } : {}),
    // issue #367: an unrecognised arm is DISCLOSED, never dropped — omitting it would report a
    // sealed run as unsealed, which is the false attestation this whole change exists to end.
    ...(run.sealed_by !== undefined
      ? {
          sealed_by_arm: (SEAL_ARMS as readonly string[]).includes(run.sealed_by.arm)
            ? run.sealed_by.arm
            : `unrecognized arm '${run.sealed_by.arm}'`,
        }
      : {}),
    ...(run.aborted_at !== undefined ? { abort_context: run.aborted_at } : {}),
    next_actions: nextActions,
    next_actions_status: nextActionsStatus,
    ...(stuckClaims.length > 0 ? { stuck_claims: stuckClaims } : {}),
    ...(capabilityBlocks.length > 0
      ? {
          capability_blocks: capabilityBlocks.map((b) => ({
            step: b.step,
            requirement: b.requirement,
            code: b.code,
          })),
        }
      : {}),
    ...(run.skip_details !== undefined && Object.keys(run.skip_details).length > 0
      ? { skip_details: run.skip_details }
      : {}),
    ...(runHealth.length > 0 ? { run_health: runHealth } : {}),
    ...(defaultedSteps.length > 0 ? { defaulted_steps: defaultedSteps } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Registers the get_run_state MCP tool on the server. */
export function registerGetRunState(server: McpServer, opts?: HandleRunStateStores): void {
  server.tool(
    'get_run_state',
    'Get the current state summary of a workflow run.',
    { run_id: z.string() },
    async (args) => {
      try {
        const result = await handleGetRunState(args, opts);
        return { content: [{ type: 'text' as const, text: sseJsonStringify(result) }] };
      } catch (err) {
        const agentAction =
          err instanceof WorkflowError ? resolvePreExecutionAgentAction(err) : 'report_to_user';
        const message = err instanceof Error ? err.message : String(err);
        const contextHint =
          err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND'
            ? `Run '${args.run_id}' not found.`
            : `An error occurred while loading run state.`;
        return {
          content: [
            {
              type: 'text' as const,
              text: sseJsonStringify({
                command: 'get_run_state',
                run_id: args.run_id,
                status: 'error',
                data: {},
                evidence: [],
                warnings: [],
                errors: [message],
                agent_action: agentAction,
                context_hint: contextHint,
                next_actions: [],
              }),
            },
          ],
        };
      }
    },
  );
}
