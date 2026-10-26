// abandon-run tool — explicitly abandons a non-terminal run (stamps the authoritative marker).
import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ABANDON_KILL_ADVISORY,
  JsonFileStore,
  WorkflowError,
  abandonRun,
  buildPreExecutionErrorEnvelope,
  type DisclosureClass,
  type RunPhase,
  type RunStore,
} from '@sensigo/realm';
import {
  disclosureOfTool,
  renderReply,
  safeTool,
  toolContentOf,
  MCP_ENVELOPE_TABLE,
  type WithDoorDisclosure,
  replySubject,
  setForSubject,
} from '../render-reply.js';
import { toolMeta } from '../tool-annotations.js';
import { mcpHostOf } from './start-run.js';
import type { McpDoor } from '../door.js';
import { assertToolStores } from './assert-tool-stores.js';

export interface HandleAbandonRunStores {
  /** Any `RunStore` implementation (issue #188, PR-1 — was `JsonFileStore`-only). */
  runStore?: RunStore;
  /**
   * #627 W: this server's door — a refusal at an open question is worded by its answers row (no
   * answer tool is named where the door hands questions to the person).
   */
  door?: McpDoor;
}

/** The tool's description where the agent keeps an answer tool (`offered`, and `asked`'s fallback). */
export const ABANDON_RUN_DESCRIPTION =
  'Abandon a non-terminal workflow run (marks it terminal with phase "abandoned"). Refuses runs waiting on a human gate (resolve via submit_human_response) and already-terminal runs.';

/**
 * #627 W (W-c8): the description where no answer tool is listed — `withheld`, and `asked` in a
 * session whose client shows forms. It names no answer tool.
 */
export const ABANDON_RUN_DESCRIPTION_NO_ANSWER_TOOL =
  'Abandon a non-terminal workflow run (marks it terminal with phase "abandoned"). Refuses runs waiting on a human gate and runs that have already ended.';

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

/** #729 PR-3 (M-1): the summary's class table. The terminal reason is a diagnostic copy. */
export const ABANDON_RUN_TABLE = {
  run_id: 'fact',
  run_phase: 'fact',
  terminal_state: 'fact',
  terminal_reason: 'bounded',
  note: 'fact',
} as const satisfies Record<keyof AbandonRunSummary, DisclosureClass>;

/** issue #558 PR-C: ONE mint, homed in core (`ABANDON_KILL_ADVISORY`) and shared byte-identically
 *  with `realm run abandon`'s third line — both packages depend on `@sensigo/realm`, so the two
 *  surfaces cannot drift (the #444/#508 one-mint rule). This alias keeps the local name. */
const ABANDON_ADVISORY = ABANDON_KILL_ADVISORY;

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
  assertToolStores(stores, 'handleAbandonRun');
  const runStore = stores?.runStore ?? new JsonFileStore();
  // issue #367: read first, so the response can say whether THIS call changed anything. Core's
  // `abandonRun` is idempotent — a second abandon returns the stored record untouched — and the
  // response used to be byte-identical either way, leaving an operator unable to tell a no-op from
  // a kill. Exact for the sequential case; if another writer abandons between these two lines this
  // call reports a fresh abandon for someone else's write, which is a rare and one-way misread of
  // WHOSE write it was, never of the run's state.
  const before = await runStore.get(args.run_id);
  const alreadyAbandoned = before.abandoned_at !== undefined;
  // issue #558 PR-C: the reason names THIS surface's verb; core's default is the neutral fallback.
  const run = await abandonRun(runStore, args.run_id, args.reason ?? 'Abandoned via abandon_run');
  /* eslint-disable-next-line no-restricted-syntax --
   * issue #367 (part 2), AUTHORIZED: an envelope ECHO of the stored record, not a writer. The
   * write itself happened inside `abandonRun`, through the `sealRunLevel` chokepoint.
   */
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

/**
 * Registers the abandon_run MCP tool on the server, and returns it: the server sets its description
 * per session (#627 W, W-c8).
 */
export function registerAbandonRun(
  server: McpServer,
  opts?: HandleAbandonRunStores & WithDoorDisclosure,
): RegisteredTool {
  const door = disclosureOfTool(opts);
  return server.registerTool(
    'abandon_run',
    {
      ...toolMeta('abandon_run'),
      description: ABANDON_RUN_DESCRIPTION,
      inputSchema: { run_id: z.string(), reason: z.string().optional() },
    },
    safeTool(
      async (args) => {
        const result = await handleAbandonRun(args, opts);
        const set = await setForSubject(door, await replySubject(opts, { runId: args.run_id }));
        return toolContentOf({ ...result }, { set, audience: 'agent', table: ABANDON_RUN_TABLE });
      },
      async (err, args) => {
        const workflowErr =
          err instanceof WorkflowError
            ? err
            : new WorkflowError(err instanceof Error ? err.message : String(err), {
                code: 'ENGINE_INTERNAL',
                category: 'ENGINE',
                agentAction: 'report_to_user',
                retryable: false,
              });
        const code = err instanceof WorkflowError ? err.code : undefined;
        // #729 PR-0 (Table rows 39, 40): core's refusal states the fact; its way on — the open
        // question's answer, or reading an ended run — is the error's typed remedy, which the one
        // renderer words (the `details` re-parse is gone).
        const contextHint =
          code === 'STATE_RUN_NOT_FOUND'
            ? `Run '${args.run_id}' not found.`
            : code === 'STATE_RUN_TERMINAL'
              ? `Run '${args.run_id}' is already terminal; nothing to abandon.`
              : code === 'STATE_TRANSITION_DENIED'
                ? `The run is waiting on a human gate, so it cannot be abandoned yet.`
                : `An error occurred while abandoning the run.`;
        // #627 W: the door's answers row words the refusal's remedy. No operator route is passed, and
        // none is needed (correction 2, 8.6 (f)): a route renders only an elsewhere entry's command,
        // and an error reply built here lists no way, so it would print nothing.
        const rendered = renderReply(
          buildPreExecutionErrorEnvelope('abandon_run', args.run_id, 0, workflowErr, contextHint),
          mcpHostOf(opts?.door !== undefined ? { door: opts.door } : undefined),
        );
        // This reply's field set is as before PR-0: no run was read (no version), the refusal's
        // untyped `details` are not published here, and an untyped throw names no code. A code's
        // TYPED facts (a damaged run file's, #719) are published as `error_details`, as on every
        // other MCP door — the one carrier (Amendments 9, 11; #729 PR-0 correction, C3).
        const {
          run_version: _version,
          error_details: details,
          error_code: _code,
          ...envelope
        } = rendered.envelope;
        return toolContentOf(
          {
            ...envelope,
            ...(code !== undefined ? { error_code: code } : {}),
            ...(workflowErr.facts !== undefined && details !== undefined
              ? { error_details: details }
              : {}),
          },
          {
            set: await setForSubject(door, await replySubject(opts, { runId: args.run_id })),
            audience: 'agent',
            table: MCP_ENVELOPE_TABLE,
          },
        );
      },
    ),
  );
}
