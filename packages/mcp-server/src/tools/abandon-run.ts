// abandon-run tool — explicitly abandons a non-terminal run (stamps the authoritative marker).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonFileStore,
  WorkflowError,
  abandonRun,
  resolvePreExecutionAgentAction,
  type RunPhase,
  type RunStore,
} from '@sensigo/realm';
import { sseJsonStringify } from '../sse-json.js';

export interface HandleAbandonRunStores {
  /** Any `RunStore` implementation (issue #188, PR-1 — was `JsonFileStore`-only). */
  runStore?: RunStore;
}

export interface AbandonRunSummary {
  run_id: string;
  run_phase: RunPhase;
  terminal_state: boolean;
  terminal_reason: string | undefined;
  /**
   * Unconditional advisory (issue #222 — the documented/advised abandon contract): abandon is,
   * and stays, a kill — declared finalizers never run on this path (that behavior does NOT
   * change; see `docs/reference/yaml-schema.md`'s `execution: finalizer` section and
   * `finalizer.test.ts`'s kill-contract pin). Present on every success response, not gated on any
   * condition (definition-blind, zero lookup — core `abandonRun` itself is untouched and returns
   * only a `RunRecord`; this field is built HERE, never persisted into the run record).
   */
  note: string;
}

const ABANDON_ADVISORY =
  'abandon is a kill — declared finalizers (if any) did NOT run; ' +
  "'abort' is the graceful path.";

/** issue #367: prefixed to the note when this call found the run ALREADY abandoned. */
const ABANDON_NO_OP_NOTE = 'already abandoned (no change this call).';

/**
 * Business logic for the abandon_run tool. Abandons a non-terminal run via the shared core
 * primitive and returns a minimal state summary.
 */
export async function handleAbandonRun(
  args: { run_id: string; reason?: string | undefined },
  stores?: HandleAbandonRunStores,
): Promise<AbandonRunSummary> {
  const runStore = stores?.runStore ?? new JsonFileStore();
  // issue #367: read first, so the response can say whether THIS call changed anything. Core's
  // `abandonRun` is idempotent — a second abandon returns the stored record untouched — and the
  // response used to be byte-identical either way, leaving an operator unable to tell a no-op from
  // a kill. Exact for the sequential case; if another writer abandons between these two lines this
  // call reports a fresh abandon for someone else's write, which is a rare and one-way misread of
  // WHOSE write it was, never of the run's state.
  const before = await runStore.get(args.run_id);
  const alreadyAbandoned = before.abandoned_at !== undefined;
  const run = await abandonRun(runStore, args.run_id, args.reason);
  return {
    run_id: run.id,
    // `run_phase` here is the PERSISTED value, which is correct on both paths: every record
    // returned by `abandonRun` comes out of a store write tail, which derives it (issue #367's
    // disposal rule — read this comment before copying the pattern anywhere that lacks that
    // guarantee).
    run_phase: run.run_phase,
    terminal_state: run.terminal_state,
    terminal_reason: run.terminal_reason,
    note: alreadyAbandoned ? `${ABANDON_NO_OP_NOTE} ${ABANDON_ADVISORY}` : ABANDON_ADVISORY,
  };
}

/** Registers the abandon_run MCP tool on the server. */
export function registerAbandonRun(server: McpServer, opts?: HandleAbandonRunStores): void {
  server.tool(
    'abandon_run',
    'Abandon a non-terminal workflow run (marks it terminal with phase "abandoned"). Refuses runs waiting on a human gate (resolve via submit_human_response) and already-terminal runs.',
    { run_id: z.string(), reason: z.string().optional() },
    async (args) => {
      try {
        const result = await handleAbandonRun(args, opts);
        return { content: [{ type: 'text' as const, text: sseJsonStringify(result) }] };
      } catch (err) {
        const agentAction =
          err instanceof WorkflowError ? resolvePreExecutionAgentAction(err) : 'report_to_user';
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof WorkflowError ? err.code : undefined;
        const contextHint =
          code === 'STATE_RUN_NOT_FOUND'
            ? `Run '${args.run_id}' not found.`
            : code === 'STATE_RUN_TERMINAL'
              ? `Run '${args.run_id}' is already terminal; nothing to abandon.`
              : code === 'STATE_TRANSITION_DENIED'
                ? `Run '${args.run_id}' is waiting on a human gate; resolve it before abandoning.`
                : `An error occurred while abandoning the run.`;
        return {
          content: [
            {
              type: 'text' as const,
              text: sseJsonStringify({
                command: 'abandon_run',
                run_id: args.run_id,
                status: 'error',
                data: {},
                evidence: [],
                warnings: [],
                errors: [message],
                ...(code !== undefined ? { error_code: code } : {}),
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
