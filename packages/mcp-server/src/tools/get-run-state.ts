// get-run-state tool — returns the current state summary of a run.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonFileStore,
  JsonWorkflowStore,
  WorkflowError,
  resolvePreExecutionAgentAction,
  buildNextActions,
  findEligibleSteps,
  classifyInProgressClaims,
  type RunPhase,
  type NextAction,
  type ClaimState,
} from '@sensigo/realm';
import { sseJsonStringify } from '../sse-json.js';

export interface HandleRunStateStores {
  runStore?: JsonFileStore;
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
 */
export type NextActionsStatus =
  | 'ok'
  | 'auto_pending'
  | 'awaiting_human'
  | 'workflow_unresolved'
  | 'skipped_terminal'
  | 'claim_stale'
  | 'claim_unknown_age';

export interface RunStateSummary {
  run_id: string;
  workflow_id: string;
  run_phase: RunPhase;
  terminal_state: boolean;
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

  // Compute next_actions + diagnostic status (read-only). Precedence:
  // terminal → skipped_terminal; gate open → awaiting_human; no/unresolved workflow →
  // workflow_unresolved; else buildNextActions/findEligibleSteps → ok | auto_pending.
  let nextActions: NextAction[] = [];
  let nextActionsStatus: NextActionsStatus;
  if (run.terminal_state) {
    nextActionsStatus = 'skipped_terminal';
  } else if (run.pending_gate !== undefined) {
    nextActionsStatus = 'awaiting_human';
  } else {
    const definition =
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

  return {
    run_id: run.id,
    workflow_id: run.workflow_id,
    run_phase: run.run_phase,
    terminal_state: run.terminal_state,
    completed_steps: run.completed_steps,
    in_progress_steps: run.in_progress_steps,
    failed_steps: run.failed_steps,
    skipped_steps: run.skipped_steps,
    pending_gate: run.pending_gate,
    evidence_count: run.evidence.length,
    last_step: run.evidence.at(-1)?.step_id ?? null,
    created_at: run.created_at,
    updated_at: run.updated_at,
    params: run.params,
    ...(run.aborted_at !== undefined ? { abort_context: run.aborted_at } : {}),
    next_actions: nextActions,
    next_actions_status: nextActionsStatus,
    ...(stuckClaims.length > 0 ? { stuck_claims: stuckClaims } : {}),
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
