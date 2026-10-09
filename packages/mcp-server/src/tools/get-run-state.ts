// get-run-state tool — returns the current state summary of a run.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type DriveFailuresField,
  SEAL_ARMS,
  JsonFileStore,
  JsonWorkflowStore,
  WorkflowError,
  getWorkflowForRun,
  resolvePreExecutionAgentAction,
  buildNextActions,
  classifyInProgressClaims,
  findCapabilityBlockedSteps,
  classifyRunHealth,
  persistsField,
  deriveDefaultedSteps,
  deriveRunPhase,
  describeClaimHolder,
  composeStepViews,
  composeDriveFailureCosts,
  describePending,
  composeNextActionsStatusWord,
  dueExpiry,
  answerAction,
  openQuestionOf,
  offeredResumeWay,
  pendingCleanupWay,
  waitingOnAnswer as waitingOnAnswerOf,
  assertRegistryLine,
  ExtensionRegistry,
  type ADVANCE_OWED,
  type EngineRunnable,
  type RunPhase,
  type NextAction,
  type ClaimState,
  type SkipDetail,
  type RunStore,
  type WorkflowDefinition,
  type RunHealthFinding,
  type StepView,
  type DriveFailureCost,
  type Attributed,
  type ActorAbsent,
  runReadError,
} from '@sensigo/realm';
import { sseJsonStringify } from '../sse-json.js';
import {
  assertToolStores,
  isReleaseLineRefusal,
  markServedByTool,
  registryRole,
} from './assert-tool-stores.js';

/** issue #558 PR-T — the store's own classification, passed through to classifyRunHealth. */
function toDefinitionError(err: unknown): { code: string; message: string; class?: string } {
  // Narrowed with `instanceof` — never duck-typed on `err.code` (house rule).
  if (err instanceof WorkflowError) {
    const cls = (err.details as Record<string, unknown> | undefined)?.['class'];
    return {
      code: err.code,
      message: err.message,
      ...(typeof cls === 'string' ? { class: cls } : {}),
    };
  }
  // The class slot is a word on every surface (review fold C15 — the CLI's closure says
  // `unknown` for the same escape).
  return {
    code: 'ENGINE_INTERNAL',
    message: err instanceof Error ? err.message : String(err),
    class: 'unknown',
  };
}

export interface HandleRunStateStores {
  /** Any `RunStore` implementation (issue #188, PR-1 — was `JsonFileStore`-only). */
  runStore?: RunStore;
  /**
   * Optional workflow store used to compute `next_actions`. When absent (or the workflow is not
   * registered), `next_actions_status` is `'workflow_unresolved'`. Intentionally NOT defaulted to a
   * fresh JsonWorkflowStore so the function stays hermetic for tests/programmatic callers.
   */
  workflowStore?: JsonWorkflowStore;
  /**
   * issue #625 PR-2a (decision C8): the server's registry, so the run's view can judge the
   * capability check (`describePending`). Absent ⇒ the capability check is `'unknown'` and the act
   * stays offered.
   */
  registry?: ExtensionRegistry;
  /** Per-definition registry resolution; wins over `registry`. A failure falls back to none. */
  registryProvider?: (definition: WorkflowDefinition) => Promise<ExtensionRegistry>;
}

/**
 * Diagnostic classification of `next_actions`:
 * - `ok` — next_actions reflects what to do next (agent steps, then the `advance_run` act when
 *   engine work is also owed); empty when nothing can run here (`engine_runnable` and
 *   `agent_refused` name each refused step and why).
 * - `advance_owed` — the only next work is the engine's: a guard is pending or an `auto` step can
 *   run, and no agent step is ready — or the open question's time is up and it declares
 *   `on_expiry`, which `advance_run` carries out first (decision C95). `next_actions` holds the one
 *   act, `advance_run` — call it. (issue #625 PR-2a; replaces `auto_pending`, which told the caller
 *   the opposite.)
 * - `awaiting_human` — a human gate is open, and has not expired with a declared `on_expiry`.
 * - `workflow_unresolved` — no workflow store provided, or the workflow is not registered.
 * - `skipped_terminal` — the run is terminal; nothing to do.
 * - `claim_stale` — a non-terminal run has an in-progress claim past its deadline (a likely-dead
 *   runner / the after-claim wedge, issue #101). Surfaced even when a healthy sibling is in flight.
 * - `claim_unknown_age` — a non-terminal run's only in-progress claims have no deadline (agent /
 *   finalizer-bearing / legacy) and there is nothing else to do — detect-only, human-judged.
 * - `blocked_on_capability` — an owed step needs a handler or an adapter that this server does not
 *   have (issue #134), and nothing else is owed to the engine: the view, judged with this server's
 *   registry — or, when it has none, with the run's own `capability_blocks` marker — refuses the
 *   step for capability and offers no act (issue #625 PR-2a, decision C33). A server that HAS the
 *   handler reports `advance_owed` instead; the old marker stays visible in `capability_blocks`.
 *   Without the definition the marker alone decides, so it also refines `workflow_unresolved`.
 *   Outranks `claim_stale` (a more specific, actionable diagnosis); ranks below `awaiting_human`.
 */
export type NextActionsStatus =
  | 'ok'
  | typeof ADVANCE_OWED
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
   * Issue #558 PR-C: the id of the terminal run this run SUPERSEDED under the same idempotency key
   * (`on_terminal_match: 'rerun' | 'rerun_if_failed'`). Absent for a first run and for a `reuse`.
   * Stamped by the store at creation; never caller-settable.
   */
  rerun_of?: string;
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
  /**
   * Issue #367: an operator's RULING on this run's arm, verbatim — who ruled, when, which arm it
   * replaced (`null` when the ruling was a first stamp of a record that had none), and their
   * stated reason. Never summarised and never truncated: a ruling is provenance, and half a
   * provenance record is worse than none.
   *
   * `by` is a recorded CLAIM of identity, not a verified one — there is no auth model behind it.
   * Absent when the run carries no ruling.
   */
  sealed_by_adjudicated?: {
    by: string;
    at: string;
    previous_arm: string | null;
    reason?: string;
  };
  /**
   * Issue #367: present iff this arm was RECOVERED by the classifier (the migration vehicle)
   * rather than asserted by the writer that sealed the run. Absent otherwise — never `false`.
   */
  sealed_by_classified?: true;
  /**
   * Issue #367: the step whose settlement sealed the run — emitted ONLY for arms where that step
   * is the seal's deterministic identity (`guard_*`, `gate_*`, `handler_abort`), mirroring the
   * same fork `realm run inspect` applies.
   *
   * For `complete` and `step_failure` the recorded step is whichever one happened to settle LAST,
   * a scheduling artifact — and this surface's consumers are agents, the readers most likely to
   * take a named step as THE culprit. That is precisely the misreading issue #373 exists to
   * prevent, so the key is absent there. The record still carries it; `export` still ships it.
   */
  sealed_by_step?: string;

  /**
   * Failed drive attempts for this run (issue #401), carried verbatim. Absent — never null — when
   * the run has had none.
   */
  drive_failures?: DriveFailuresField;
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
   * Issue #625 (the holder slice): who took each in-progress step — the host PROGRAM, how its name
   * is known, and the channel — or why there is no name (`holder_not_recorded`, `pre_lease_claim`,
   * `store_keeps_no_claims`, `name_unreadable`). `since` is when the claim was taken. Present on
   * any non-terminal run with an in-progress step. A step waiting on a person's answer names the
   * program through which the question was OPENED, and says nothing about anyone working on it now
   * (liveness is #592's). Never carries the claim's token.
   */
  step_claims?: Array<{ step: string; holder: Attributed | ActorAbsent; since?: string }>;
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
  /**
   * Issue #600 PR 1b — one composed cost view per step (`step-view.ts`), present iff
   * `include_steps` was asked AND non-empty. Carried on terminal runs too — the same rule as
   * `drive_failures`. See `composeStepViews`'s own doc for the derivation.
   */
  steps?: Record<string, StepView>;
  /**
   * Issue #600 PR 1b (#611) — one cost per `drive_failures` entry, in the same order, present iff
   * `include_steps` was asked AND `drive_failures` is present. Lines up 1:1 with
   * `drive_failures.entries` — see `composeDriveFailureCosts`'s own doc.
   */
  drive_failure_costs?: DriveFailureCost[];
  /** issue #625 PR-2a: guards the engine owes (a call to `advance_run` settles them); absent when none. */
  pending_guards?: string[];
  /**
   * issue #625 PR-2a: each eligible `auto` step the engine could run, judged for this server's
   * registry — `runnable_here` false names the check that refuses it (`refused_by`, `refusal`);
   * a capability refusal also says what it was judged from (`basis`: `registry` — this server's
   * registry lacks it; `marker` — no registry, the run's own record; decision C41);
   * `'unknown'` when the server has no registry to judge the capability check. Absent when none.
   */
  engine_runnable?: EngineRunnable[];
  /**
   * issue #625 PR-2a (decision C82): each eligible agent step the run refuses before its claim — a
   * failed precondition, or a `trust` value it refuses — in definition order, shaped as
   * `engine_runnable`'s refused entries (`step`, `runnable_here: false`, `refused_by`, `refusal`).
   * Such a step is never in `next_actions`. Absent when none.
   */
  agent_refused?: EngineRunnable[];
  /**
   * issue #625 PR-2a (decision C211): on a run an engine failure ended (phase `failed`), the failed
   * steps `realm run resume --from` takes and the command that makes them runnable again (core's
   * `offeredResumeWay`, F2 — never a cleanup step, never a run an operator ended: its
   * `terminal_reason` and `sealed_by_arm` say who ended it and why). Absent when it takes none, or
   * the run's workflow cannot be read.
   */
  resumable?: { steps: string[]; command: string };
  /**
   * issue #625 PR-2a (decision C211): on a run that has ended, the cleanup steps its ending left
   * `pending`, in the order the engine runs them, and the command that runs them (`realm run drain
   * <id> --force`, with code that has their handlers). Absent when none is pending.
   */
  cleanup_pending?: { steps: string[]; command: string };
  /**
   * issue #625 PR-2a (decision C211): at an open question, the steps it holds — eligible by their
   * dependencies, they go on after the answer. Absent when none waits, or the run's workflow cannot
   * be read.
   */
  waiting_on_answer?: string[];
}

/**
 * Business logic for the get_run_state tool.
 * Returns a structured summary of the run without the full evidence array.
 */
export async function handleGetRunState(
  args: { run_id: string; include_steps?: boolean | undefined },
  stores?: HandleRunStateStores,
): Promise<RunStateSummary> {
  assertToolStores(stores, 'handleGetRunState');
  const runStore = stores?.runStore ?? new JsonFileStore();
  // decision C172: a run that cannot be read is answered as the library answers it — the store's own
  // WorkflowError, or ENGINE_STORE_FAILED naming its cause.
  const run = await runStore.get(args.run_id).catch((err: unknown) => {
    throw runReadError(err);
  });

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
  // terminal → skipped_terminal; gate open → awaiting_human — unless its time is up and it declares
  // `on_expiry` (decision C95: carrying that out is owed engine work, read through the view below);
  // no/unresolved workflow → workflow_unresolved; else describePending → ok | advance_owed (issue
  // #625 PR-2a).
  const now = new Date();
  // `definition` is hoisted (issue #221) so classifyRunHealth below can reuse it when resolved —
  // scoping/resolution logic here is otherwise UNCHANGED.
  let nextActions: NextAction[] = [];
  let nextActionsStatus: NextActionsStatus;
  let definition: WorkflowDefinition | undefined;
  // issue #558 PR-T — the failure the definition read produced, when it produced one.
  let definitionError: { code: string; message: string; class?: string } | undefined;
  let pending: ReturnType<typeof describePending> | undefined;
  // decision C46: the registry the view judged with, passed to the run-health classifier too.
  let registry: ExtensionRegistry | undefined;
  // decision C211 (the architect's addendum; walk c14 W2-2): the read names what the record's lists
  // do not show — on a run that has ended, the failed steps `realm run resume` takes (`resumable`,
  // core's `offeredResumeWay`, F2: an engine failure only) and the cleanup steps left pending
  // (`cleanup_pending`); at an open question,
  // the steps it holds (`waiting_on_answer`). Each read of the workflow is best-effort: a workflow
  // that cannot be read leaves that field out.
  const readWorkflow = async (): Promise<WorkflowDefinition | undefined> =>
    stores?.workflowStore === undefined
      ? undefined
      : await stores.workflowStore.get(run.workflow_id).catch(() => undefined);
  let resumable: { steps: string[]; command: string } | undefined;
  let waitingOnAnswer: string[] = [];
  const cleanupPending = pendingCleanupWay(run);
  if (run.terminal_state) {
    nextActionsStatus = 'skipped_terminal';
    const ended = await readWorkflow();
    // F2: offered only for an engine failure — a run an operator ended carries its ending as data
    // (`terminal_reason`, `sealed_by_arm`), never the undo.
    resumable = ended === undefined ? undefined : offeredResumeWay(run, ended);
  } else if (run.pending_gate !== undefined && dueExpiry(run.pending_gate, now) === undefined) {
    nextActionsStatus = 'awaiting_human';
    // decision C103: the question is named by its answer — core's one composer, never with the claim
    // token (only the reply that opened the question carries it). Read from the record alone: no
    // definition is needed to answer a question.
    const question = openQuestionOf(run);
    if (question !== undefined) nextActions = [answerAction(run.id, question)];
    const held = await readWorkflow();
    waitingOnAnswer = held === undefined ? [] : waitingOnAnswerOf(held, run);
  } else {
    definition =
      stores?.workflowStore !== undefined
        ? await getWorkflowForRun(stores.workflowStore, run, {
            // R12 (walk 2): through the ONE composer, as every other surface — the raw store
            // sentence left this finding, the one an agent polls, with no way out and no repair.
            retryVerb: 'retry',
            verb: 'retry',
          }).catch((err: unknown) => {
            // issue #620 PR-C: a release-line refusal is a hand-off fault, not a definition fault.
            if (isReleaseLineRefusal(err)) throw err;
            // issue #558 PR-T — KEEP the failure: it feeds the `definition_unresolvable` finding
            // below instead of being discarded. Live runs only: the terminal guard at the
            // classify call is the pre-existing frozen R3 guard (#331), untouched here.
            definitionError = toDefinitionError(err);
            return undefined;
          })
        : undefined;
    if (definition === undefined) {
      nextActionsStatus = 'workflow_unresolved';
    } else {
      // issue #625 PR-2a (decision C8): the registry the server resolves for every other tool, so
      // the capability check is judged; a failure falls back to none (`'unknown'`), except a
      // release-line refusal, which every registry-resolving tool raises.
      try {
        registry =
          stores?.registryProvider !== undefined
            ? await stores.registryProvider(definition)
            : stores?.registry;
        assertRegistryLine(
          registry,
          registryRole(stores, 'get_run_state', 'handleGetRunState'),
          ExtensionRegistry,
        );
      } catch (err) {
        if (isReleaseLineRefusal(err)) throw err;
        registry = undefined;
      }
      pending = describePending(definition, run, registry, now);
      nextActions = buildNextActions(definition, run, registry, now);
      nextActionsStatus = composeNextActionsStatusWord(pending) ?? 'ok';
    }

    // Wedge detection (issue #101) — definition-free (reads the stored per-claim deadline), so it
    // also refines the `workflow_unresolved` path. Carves the wedge states OUT of the
    // ok / advance_owed / workflow_unresolved fall-through:
    //  - a `claim_stale` claim (past deadline → likely-dead runner) is surfaced even mid-fan-out;
    //  - when only unknown-age claims remain and there is nothing else to do, surface
    //    `claim_unknown_age` (detect-only). A `healthy` in-flight claim (a live runner) stays 'ok'.
    if (run.in_progress_steps.length > 0) {
      // The open question's own step holds a claim while it waits (decision C95 reaches this block
      // with a question open, when its time is up): it is not work in flight, as `stuck_claims`
      // below says too.
      const claimStates = classifyInProgressClaims(run)
        .filter((c) => c.step !== run.pending_gate?.step_name)
        .map((c) => c.state);
      if (claimStates.includes('claim_stale')) {
        nextActionsStatus = 'claim_stale';
      } else if (nextActions.length === 0 && !claimStates.includes('healthy')) {
        nextActionsStatus = 'claim_unknown_age';
      }
    }

    // #134 capability block outranks the claim-wedge states (a missing capability is a more specific,
    // actionable diagnosis than a stale/unknown-age claim) but ranks below `awaiting_human` — the gate
    // path returns above without entering this else block, so it wins naturally.
    //
    // issue #625 PR-2a (decision C33): with the definition, the status reads the VIEW — this
    // server's registry, or the run's marker when it has none — so a server that can run the step
    // says `advance_owed`, and one that cannot says `blocked_on_capability` before any attempt.
    // It is reported exactly when the view refuses an owed step for capability and offers no act.
    // Without the definition there is no view; the marker is then the only fact (the #134 rule).
    const blockedOnCapability =
      pending !== undefined
        ? pending.act === undefined &&
          pending.engine_runnable.some((e) => e.refused_by === 'capability')
        : capabilityBlocks.length > 0;
    if (blockedOnCapability) {
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

  // issue #625 (holder slice): who took each in-progress step, read off the claim by the one reader.
  // Terminal guard as stuck_claims: a sealed run surfaces nothing to do. Never the claim's token.
  const stepClaims: Array<{ step: string; holder: Attributed | ActorAbsent; since?: string }> =
    run.terminal_state
      ? []
      : run.in_progress_steps.map((step) => {
          const described = describeClaimHolder(
            run.claims?.[step],
            runStore.persistsClaims === true,
          );
          const since = described.since !== undefined ? { since: described.since } : {};
          return 'holder' in described
            ? { step, holder: described.holder, ...since }
            : { step, holder: { by: null, absent_cause: described.absent_cause }, ...since };
        });

  // issue #600 PR 1b: the definition for the per-step cost view, resolved INDEPENDENTLY of the
  // status path above. A `definitionError` there must never suppress the view (the status path's
  // failure and the view's are different questions), and a view-resolution failure must never
  // leak into `definitionError`/`run_health`/`next_actions_status` — this block's `.catch` discards
  // its error unconditionally. Placed BEFORE `classifyRunHealth`: placed after it, a leak into
  // `definitionError` would change nothing observable, making the isolation untestable (mutant (i)
  // would be equivalent). Never called unless asked (`include_steps`) — a poll that does not ask
  // pays no extra registrar call, and a status-path failure already tried (`definitionError` set)
  // is not retried a second time — the view simply goes on without a definition.
  let viewDefinition: WorkflowDefinition | undefined = definition;
  if (
    args.include_steps === true &&
    viewDefinition === undefined &&
    definitionError === undefined &&
    stores?.workflowStore !== undefined
  ) {
    viewDefinition = await getWorkflowForRun(stores.workflowStore, run, {
      retryVerb: 'retry',
      verb: 'retry',
      terminalOk: true,
    }).catch((err: unknown) => {
      // issue #620 PR-C: never discard a release-line refusal.
      if (isReleaseLineRefusal(err)) throw err;
      return undefined;
    });
  }

  // issue #221: the SAME shared classifyRunHealth predicate the three READ surfaces (get_run_state,
  // list --stuck, inspect) derive from — computed definition-aware when the workflow resolved
  // above (adds eligible_steps evidence to any never_claimed_idle finding), definition-free
  // otherwise (gate / workflow_unresolved paths). Terminal guard mirrors stuck_claims/
  // capability_blocks: a sealed run surfaces nothing. `next_actions_status` above is computed and
  // finalized BEFORE this line runs — nothing below this point may write back to it.
  const runHealth: RunHealthFinding[] = run.terminal_state
    ? []
    : classifyRunHealth(run, {
        ...(definition !== undefined ? { definition } : {}),
        ...(definitionError !== undefined ? { definitionError } : {}),
        // issue #625 PR-2a (decision C46): a server that can run a step is not told the step is
        // blocked by another runner's old capability marker.
        ...(registry !== undefined ? { registry } : {}),
      });
  if (runHealth.length > 0) {
    warnings.push(
      `this run has ${runHealth.length} active run-health finding(s) — see 'run_health' for detail.`,
    );
  }

  // issue #232: read-time derivation (approach 2, DECIDED) — computed UNIFORMLY for every run
  // regardless of terminal state or seal outcome (no guard here, unlike stampDefaultedSteps'
  // complete-only stamping), via the SAME shared helper that stamping itself now calls.
  const defaultedSteps = deriveDefaultedSteps(run.evidence);

  /* eslint-disable-next-line no-restricted-syntax --
   * issue #367 (part 2), AUTHORIZED: this is an envelope ECHO of a stored value, not a writer.
   * Nothing here reaches a store — the object is the MCP response shape.
   */
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
    // issue #558 PR-C: the supersede link — the ONE explicit route onto this surface (there is no
    // `keyof RunRecord` disclosure registry to join, so the cell below is the parity guard).
    ...(run.rerun_of !== undefined ? { rerun_of: run.rerun_of } : {}),
    // issue #367: an unrecognised arm is DISCLOSED, never dropped — omitting it would report a
    // sealed run as unsealed, which is the false attestation this whole change exists to end.
    ...(run.sealed_by !== undefined
      ? {
          sealed_by_arm: (SEAL_ARMS as readonly string[]).includes(run.sealed_by.arm)
            ? run.sealed_by.arm
            : `unrecognized arm '${run.sealed_by.arm}'`,
          // issue #367 (part 5): the ruling, the classifier marker, and the step — each key ABSENT
          // when its field is absent, never null (walk-never-ran is not the same as no value).
          ...(run.sealed_by.adjudicated !== undefined
            ? { sealed_by_adjudicated: run.sealed_by.adjudicated }
            : {}),
          ...(run.sealed_by.classified === true ? { sealed_by_classified: true as const } : {}),
          // The deterministic-arm fork, identical to inspect's — see the field's own doc for why
          // a settle-order step must not reach an agent as if it were the culprit.
          ...(run.sealed_by.step !== undefined &&
          (run.sealed_by.arm.startsWith('guard_') ||
            run.sealed_by.arm.startsWith('gate_') ||
            run.sealed_by.arm === 'handler_abort')
            ? { sealed_by_step: run.sealed_by.step }
            : {}),
        }
      : {}),
    // issue #401: failed drive attempts, verbatim and additively — absent, never null, so an
    // agent can tell "no failures" from "this surface does not report them".
    ...(run.drive_failures !== undefined ? { drive_failures: run.drive_failures } : {}),
    ...(run.aborted_at !== undefined ? { abort_context: run.aborted_at } : {}),
    next_actions: nextActions,
    next_actions_status: nextActionsStatus,
    ...(stuckClaims.length > 0 ? { stuck_claims: stuckClaims } : {}),
    ...(stepClaims.length > 0 ? { step_claims: stepClaims } : {}),
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
    // issue #600 PR 1b: `steps`/`drive_failure_costs`, present iff asked. `steps` is additionally
    // gated non-empty (composeStepViews returns `{}` for a step-free run); `drive_failure_costs`
    // is gated on `drive_failures` itself, never on its own emptiness (an empty array is still the
    // honest answer for a run whose drive_failures.entries carry no usage — the field's PRESENCE
    // is what "asked and there IS a drive_failures" means).
    ...(args.include_steps === true
      ? (() => {
          const steps = composeStepViews(
            run,
            viewDefinition !== undefined ? { definition: viewDefinition } : {},
          );
          return Object.keys(steps).length > 0 ? { steps } : {};
        })()
      : {}),
    ...(args.include_steps === true && run.drive_failures !== undefined
      ? { drive_failure_costs: composeDriveFailureCosts(run) }
      : {}),
    ...(pending !== undefined && pending.pending_guards.length > 0
      ? { pending_guards: pending.pending_guards }
      : {}),
    ...(pending !== undefined && pending.engine_runnable.length > 0
      ? { engine_runnable: pending.engine_runnable }
      : {}),
    ...(pending !== undefined && pending.agent_refused.length > 0
      ? { agent_refused: pending.agent_refused }
      : {}),
    ...(resumable !== undefined ? { resumable } : {}),
    ...(cleanupPending !== undefined ? { cleanup_pending: cleanupPending } : {}),
    ...(waitingOnAnswer.length > 0 ? { waiting_on_answer: waitingOnAnswer } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Registers the get_run_state MCP tool on the server. */
export function registerGetRunState(server: McpServer, opts?: HandleRunStateStores): void {
  markServedByTool(opts);
  server.tool(
    'get_run_state',
    'Get the current state summary of a workflow run. Pass include_steps: true for each ' +
      "step's model-call cost per attempt.",
    { run_id: z.string(), include_steps: z.boolean().optional() },
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
                // issue #625 PR-2a: the code and details, as every other tool's error reply — a
                // release-line refusal from the registry this tool now resolves names its role there.
                ...(err instanceof WorkflowError ? { error_code: err.code } : {}),
                ...(err instanceof WorkflowError && Object.keys(err.details).length > 0
                  ? { error_details: err.details }
                  : {}),
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
