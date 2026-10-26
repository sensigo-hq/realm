// submit-human-response tool — advances a gate-waiting run with a human choice.
import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonWorkflowStore,
  JsonFileStore,
  submitHumanResponse,
  endedRunWaysSentence,
  pendingCleanupSentence,
  pendingCleanupWay,
  TERMINAL_PHASES,
  WorkflowError,
  boundStatedName,
  identityRefusalLine,
  buildPreExecutionErrorEnvelope,
  getWorkflowForRun,
} from '@sensigo/realm';
import { mcpHostOf, principalOfStores, type HandleRunStores } from './start-run.js';
import { toolMeta } from '../tool-annotations.js';
import {
  disclosureOfTool,
  mcpReplyOf,
  renderReply,
  safeTool,
  toolContentOf,
  withHintTail,
  MCP_ENVELOPE_TABLE,
  type McpEnvelope,
  type WithDoorDisclosure,
  type WithPersonBlock,
  replySubject,
  setForSubject,
} from '../render-reply.js';
import { assertToolStores, markServedByTool, registryRole } from './assert-tool-stores.js';
import {
  assertRegistryLine,
  ExtensionRegistry as RealmExtensionRegistry,
  runReadError,
} from '@sensigo/realm';
import { boundedLines, boundedRefusal, moreUnknownKeys } from './refusal-format.js';

/** The answer tool's description where the agent keeps it under `offered`. */
export const SUBMIT_HUMAN_RESPONSE_DESCRIPTION =
  "Advance a gate-waiting run by submitting the human's choice.";

/**
 * #627 W (F30, W-g1 in the tool's own words): the description on `asked`'s fallback — a client that
 * shows no forms is asked to have the person approve each call. A tool description names no step, so
 * W-g1's "at step '⟨s⟩'" reads "at the gate" (W-p2's words).
 */
export const SUBMIT_HUMAN_RESPONSE_FALLBACK_DESCRIPTION = `${SUBMIT_HUMAN_RESPONSE_DESCRIPTION} Your client may ask the user to approve this call (Claude Code does in interactive sessions and refuses it in headless runs; other clients may not ask). If the call is refused, the run keeps waiting at the gate: tell the user so.`;

/** #627 W (F30): the `_meta` key that asks a client to have its user approve each call. */
export const REQUIRES_USER_INTERACTION_META = {
  'anthropic/requiresUserInteraction': true,
} as const;

/** The arguments this tool takes. Anything else is named in the reply's `warnings`, not dropped. */
const KNOWN_ARGS = ['run_id', 'gate_id', 'choice', 'responded_by', 'claim_token'] as const;

/**
 * Near misses for the one argument whose absence changes what a reply says. The house `closestKey`
 * (threshold 2) cannot reach `token` or `claimToken` from `claim_token`, so the map is explicit.
 */
const NEAR_MISSES: Readonly<Record<string, (typeof KNOWN_ARGS)[number]>> = {
  claimToken: 'claim_token',
  token: 'claim_token',
};

/**
 * Issue #625 (holder slice): one warning per argument this tool does not take, naming the near miss
 * when there is one. `server.tool` strips unknown keys before the handler runs, so a misnamed
 * `claimToken` used to vanish without a word and the answer read as "no claim_token passed".
 */
export function unknownKeyWarnings(args: Record<string, unknown>): string[] {
  const unknown = Object.keys(args).filter(
    (key) => !(KNOWN_ARGS as readonly string[]).includes(key),
  );
  // The zod 4 unit's reply bounds (M3): the near misses first — the line that names `claim_token`
  // must survive the bound — then the rest in the order sent; the first ten, then the count.
  const isNear = (key: string): boolean => Object.hasOwn(NEAR_MISSES, key);
  return boundedLines(
    [...unknown.filter(isNear), ...unknown.filter((key) => !isNear(key))],
    (key) => {
      const near = NEAR_MISSES[key];
      return near !== undefined
        ? `submit_human_response: unknown argument '${key}' was ignored — did you mean '${near}'?`
        : `submit_human_response: unknown argument '${key}' was ignored.`;
    },
    moreUnknownKeys,
  );
}

/**
 * The tool's input schema. Pass-through: `registerTool` hands the handler every key, where
 * `server.tool` strips them first (the form `create_workflow` already uses and documents).
 *
 * `claim_token` has NO minimum length on purpose: with `.min(1)` the SDK would refuse an empty
 * token with `MCP error -32602` and the answer would not be recorded — the damage this argument
 * must never do. The engine judges an empty string as a wrong value (`mismatch`) and records the
 * answer.
 */
export const submitHumanResponseArgsSchema = z
  .object({
    run_id: z.string(),
    gate_id: z.string(),
    choice: z.string(),
    responded_by: z
      .string()
      .optional()
      .describe(
        'Who made the choice, as the caller states it — not verified. At most 200 characters, no control characters.',
      ),
    claim_token: z
      .string()
      .optional()
      .describe(
        'The claim_token in the answer instruction of the reply that opened this question (its next_actions entry). Pass it back unchanged; it shows this answer comes from the conversation that opened the question. Never required.',
      ),
  })
  .loose();

/**
 * Business logic for the submit_human_response tool.
 * Validates the gate_id and choice, then advances the run past the gate.
 */
export async function handleSubmitHumanResponse(
  args: {
    run_id: string;
    gate_id: string;
    choice: string;
    responded_by?: string | undefined;
    claim_token?: string | undefined;
  },
  stores?: HandleRunStores,
): Promise<WithPersonBlock<McpEnvelope>> {
  // issue #620 PR-C + the admission order (framework v1.27 §4): what the host handed in is checked
  // first, then what this caller sent.
  assertToolStores(stores, 'handleSubmitHumanResponse');
  // Issue #625: `responded_by` is bounded exactly as `realm run respond --by` is — refused before
  // anything is read or written, so nothing is recorded (#604's `responded_by` member: one helper
  // guards both doors).
  // The checked name (spaces at either end removed) is what is passed on and stored.
  let respondedBy: string | undefined;
  if (args.responded_by !== undefined) {
    try {
      respondedBy = boundStatedName(args.responded_by, 'responded_by');
    } catch (err) {
      throw new WorkflowError(identityRefusalLine('responded_by', err, 'nothing was recorded'), {
        code: 'VALIDATION_ACTOR_INVALID',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        retryable: false,
        details: err instanceof WorkflowError ? err.details : {},
      });
    }
  }
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  // decision C172: a run that cannot be read is answered as the library answers it — the store's own
  // WorkflowError (issue #719: a damaged JSON-store run file is RESOURCE_FORMAT_INVALID,
  // STATE_LEGACY_FORMAT or ENGINE_STORE_FAILED, naming the file and its way out), or, for an
  // untyped throw, ENGINE_STORE_FAILED naming its cause — never ENGINE_INTERNAL.
  const run = await runStore.get(args.run_id).catch((err: unknown) => {
    throw runReadError(err);
  });
  // issue #456: code-keyed one-time-register remedy. Verb "retry" — deliberately neutral: the
  // register command in the sentence is for the human this agent's report_to_user relays to.
  const definition = await getWorkflowForRun(workflowStore, run, {
    retryVerb: 'retry',
    verb: 'retry',
  });

  // Per-definition registry (project extensions) — awaited before the call (fail-fast),
  // provider wins over `registry`. Mirrors execute-step.ts. Threaded into submitHumanResponse
  // so that resolving a gate which COMPLETES the run fires its finalizers with project handlers.
  const registry =
    stores?.registryProvider !== undefined
      ? await stores.registryProvider(definition)
      : stores?.registry;
  // issue #620 PR-C: the registry rule — refused only on proof (another realm version), before any
  // write. Covers the provider's result and the construction-time registry alike.
  assertRegistryLine(
    registry,
    registryRole(stores, 'submit_human_response', 'handleSubmitHumanResponse'),
    RealmExtensionRegistry,
  );

  const reply = await submitHumanResponse(runStore, definition, {
    runId: args.run_id,
    gateId: args.gate_id,
    choice: args.choice,
    // decision C151: an expiry this late answer carries out names the tool.
    caller: 'submit_human_response',
    ...(registry !== undefined ? { registry } : {}),
    // issue #279 (increment 2, PR-D; design record D-5): stored as checked above (spaces at either
    // end removed); never verified.
    ...(respondedBy !== undefined ? { respondedBy } : {}),
    // issue #625: judged inside the answer's write, never a reason to refuse it.
    ...(args.claim_token !== undefined ? { claimToken: args.claim_token } : {}),
    ...(stores?.driver !== undefined ? { driver: stores.driver } : {}),
    // #627 W (§5.8): the door declares its own route and the transport's principal — never values a
    // tool caller sends (a `principal` argument is ignored, as every unknown argument is) — and, on
    // `asked`'s fallback, that the client was asked to have the person approve the call.
    route: 'mcp',
    principal: principalOfStores(stores),
    ...(onFallback(stores) ? { clientPromptRequested: true } : {}),
  });
  // decision C211 (walk c14 W3-4's class): an answer that ended the run with cleanup steps left
  // pending says the command that runs them (the reply carries the resume offer already).
  const host = mcpHostOf(stores);
  if (reply.run_phase === undefined || !TERMINAL_PHASES.has(reply.run_phase)) {
    return mcpReplyOf(renderReply(reply, host));
  }
  const ended = await runStore.get(args.run_id).catch(() => undefined);
  if (ended === undefined) return mcpReplyOf(renderReply(reply, host));
  // #729 PR-0: the ended run's ways back in follow the door's own sentence of what comes next, as
  // before PR-0 (withPendingCleanup's rule, kept whole): the cleanup sentence once — never when the
  // hint already names its command (F11) — and, when core's hint ends with the resume offer, the
  // offer after it, so its command ends the hint (F6). Both are said after the door's sentence.
  const now = new Date();
  const cleanup = pendingCleanupSentence(ended, now);
  const cleanupWay = pendingCleanupWay(ended, now);
  const named = cleanupWay !== undefined && reply.context_hint.includes(`'${cleanupWay.command}'`);
  const offer = endedRunWaysSentence(ended, definition, now).slice(cleanup.length);
  const hint = reply.context_hint;
  const moved = offer !== '' && hint.endsWith(offer);
  const own = moved ? { ...reply, context_hint: hint.slice(0, hint.length - offer.length) } : reply;
  const tail = `${named ? '' : cleanup}${moved ? offer : ''}`;
  return mcpReplyOf(withHintTail(renderReply(own, host), tail));
}

/** #627 W: whether this server's door is on `asked`'s fallback (`asked`, and no forms in this session). */
function onFallback(stores: HandleRunStores | undefined): boolean {
  const answers = stores?.door?.answers();
  return answers !== undefined && answers.value === 'asked' && !answers.forms.shown;
}

/**
 * Registers the submit_human_response MCP tool on the server, and returns it. `config`: `offered`
 * (today's tool, annotated) or `fallback` (#627 W, F30: `asked` in a session without forms — the
 * client is asked to have its user approve each call, and the description says what a refusal
 * leaves). The server registers it only on those two rows (§5.2's table).
 */
export function registerSubmitHumanResponse(
  server: McpServer,
  opts?: HandleRunStores & WithDoorDisclosure,
  config: 'offered' | 'fallback' = 'offered',
): RegisteredTool {
  markServedByTool(opts);
  const door = disclosureOfTool(opts);
  // issue #625: `registerTool` with a pass-through schema — `server.tool` strips unknown keys before
  // the handler sees them (see `create-workflow.ts`), so a misnamed `claimToken` would vanish
  // without a word.
  return server.registerTool(
    'submit_human_response',
    {
      ...toolMeta('submit_human_response'),
      description:
        config === 'fallback'
          ? SUBMIT_HUMAN_RESPONSE_FALLBACK_DESCRIPTION
          : SUBMIT_HUMAN_RESPONSE_DESCRIPTION,
      inputSchema: boundedRefusal(submitHumanResponseArgsSchema),
      ...(config === 'fallback' ? { _meta: { ...REQUIRES_USER_INTERACTION_META } } : {}),
    },
    safeTool(
      async (rawArgs) => {
        const args = rawArgs as z.infer<typeof submitHumanResponseArgsSchema>;
        const result = await handleSubmitHumanResponse(args, opts);
        const unknown = unknownKeyWarnings(args as Record<string, unknown>);
        return toolContentOf(
          {
            ...result,
            data: {},
            evidence: [],
            // An unknown argument is named FIRST: a caller that sent `claimToken` reads the
            // did-you-mean before the reply's own "No claim_token was passed" sentence.
            ...(unknown.length > 0 ? { warnings: [...unknown, ...result.warnings] } : {}),
          },
          {
            set: await setForSubject(door, await replySubject(opts, { runId: args.run_id })),
            audience: 'agent',
            table: MCP_ENVELOPE_TABLE,
          },
        );
      },
      async (err, rawArgs) => {
        const args = rawArgs as z.infer<typeof submitHumanResponseArgsSchema>;
        const workflowErr =
          err instanceof WorkflowError
            ? err
            : new WorkflowError(err instanceof Error ? err.message : String(err), {
                code: 'ENGINE_INTERNAL',
                category: 'ENGINE',
                agentAction: 'stop',
                retryable: false,
              });
        const contextHint =
          workflowErr.code === 'STATE_WORKFLOW_NOT_FOUND'
            ? `Workflow definition for run '${args.run_id}' not found.`
            : workflowErr.code === 'STATE_RUN_NOT_FOUND'
              ? `Run '${args.run_id}' not found.`
              : `An error occurred before gate response could be submitted.`;
        const rendered = renderReply(
          buildPreExecutionErrorEnvelope(
            'submit_human_response',
            args.run_id,
            0,
            workflowErr,
            contextHint,
          ),
          mcpHostOf(opts),
        );
        return toolContentOf(mcpReplyOf(rendered), {
          set: await setForSubject(door, await replySubject(opts, { runId: args.run_id })),
          audience: 'agent',
          table: MCP_ENVELOPE_TABLE,
        });
      },
    ),
  );
}
