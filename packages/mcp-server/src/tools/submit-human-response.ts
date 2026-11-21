// submit-human-response tool — advances a gate-waiting run with a human choice.
import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  capText,
  submitHumanResponse,
  type EngineReply,
  judgedSnapshotOf,
  endedRunWaysSentence,
  runEndingOf,
  pendingCleanupSentence,
  pendingCleanupWay,
  TERMINAL_PHASES,
  WorkflowError,
  boundStatedName,
  identityRefusalLine,
  buildPreExecutionErrorEnvelope,
  getWorkflowForRun,
  saysHowItEnded,
} from '@sensigo/realm';
import { formCallOf, mcpHostOf, principalOfStores, type HandleRunStores } from './start-run.js';
import type { FormCall } from '../form-path.js';
import { FORM_WAIT_SECONDS_DEFAULT } from '../door.js';
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
  statesNoName,
} from '../render-reply.js';
import { assertToolStores, markServedByTool, registryRole } from './assert-tool-stores.js';
import {
  assertRegistryLine,
  ExtensionRegistry as RealmExtensionRegistry,
  runReadError,
} from '@sensigo/realm';
import { boundedLines, boundedRefusal, moreUnknownKeys } from './refusal-format.js';
import { ASSISTANT_DOOR_WORDS, renderOutcome } from '../form-path.js';

/** The answer tool's description: the server lists the tool under `permitted` only. */
export const SUBMIT_HUMAN_RESPONSE_DESCRIPTION =
  "Advance a gate-waiting run by submitting the human's choice.";

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
        ? `submit_human_response: unknown argument '${capText(key)}' was ignored — did you mean '${near}'?`
        : `submit_human_response: unknown argument '${capText(key)}' was ignored.`;
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
        'The claim_token in the answer instruction of the reply that opened this question (its next_actions entry). Pass it back unchanged; it shows this answer comes from the conversation that opened the question, and with it, the steps after the answer run in this call. Never required.',
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
  stores: HandleRunStores,
  /** #625 PR-2b A2a: the tool call's start, on the door's clock — the carry-on's time runs from it. */
  call?: FormCall,
): Promise<WithPersonBlock<McpEnvelope>> {
  // issue #620 PR-C + the admission order (framework v1.27 §4): what the host handed in is checked
  // first, then what this caller sent.
  assertToolStores(stores, 'handleSubmitHumanResponse', ['runStore', 'workflowStore']);
  // Issue #625: `responded_by` is bounded exactly as `realm run respond --by` is — refused before
  // anything is read or written, so nothing is recorded (#604's `responded_by` member: one helper
  // guards both doors).
  // The checked name (spaces at either end removed) is what is passed on and stored.
  let respondedBy: string | undefined;
  if (args.responded_by !== undefined) {
    try {
      respondedBy = boundStatedName(args.responded_by, 'responded_by');
      // #603 A3b (G5): the instruction's placeholder copied (wrapped whole in `<` `>`) names no one.
      if (statesNoName(respondedBy)) respondedBy = undefined;
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
  const workflowStore = stores.workflowStore;
  const runStore = stores.runStore;
  // decision C172: a run that cannot be read is answered as the library answers it — the store's own
  // WorkflowError (issue #719: a damaged JSON-store run file is RESOURCE_FORMAT_INVALID,
  // STATE_LEGACY_FORMAT or ENGINE_STORE_FAILED, naming the file and its way out), or, for an
  // untyped throw, ENGINE_STORE_FAILED naming its cause — never ENGINE_INTERNAL.
  const { record: run } = await runStore.get(args.run_id).catch((err: unknown) => {
    throw runReadError(err);
  });
  // issue #456: code-keyed one-time-register remedy. Verb "retry" — deliberately neutral: the
  // register command in the sentence is for the human this agent's report_to_user relays to.
  const definition = await getWorkflowForRun(workflowStore, run, {
    retryVerb: 'retry',
    verb: 'retry',
  });
  // The filter-mask fix (Amendment 1): the door's set for the reply's ways (a `run_step` way's prompt
  // masks each value before its filters), from the run and workflow this call read — no store read.
  const waysDisclosure = await disclosureOfTool(stores).setFor(definition, run);

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

  const engineReply = await submitHumanResponse(runStore, definition, {
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
    // tool caller sends (a `principal` argument is ignored, as every unknown argument is). The
    // gate-answers default (2026-11-14): no door asks a client to have the person approve the call any
    // more, so `client_prompt_requested` is never written from here.
    route: 'mcp',
    principal: principalOfStores(stores),
    disclosure: waysDisclosure,
    // #625 PR-2b A2a: an answer that carries the run on runs its steps as advance_run would — with
    // this server's trace buffer store — and starts none later than 240 seconds after this call
    // began: the form wait's default, whose setting is refused under `permitted`, the one setting
    // that lists this tool. Measured on the door's monotonic clock; a step that has started runs to
    // its end.
    ...(stores?.traceBufferStore !== undefined
      ? { traceBufferStore: stores.traceBufferStore }
      : {}),
    ...answerBudgetOf(stores, call),
  });
  const reply = withOutcomeWords(engineReply);
  // decision C211 (walk c14 W3-4's class): an answer that ended the run with cleanup steps left
  // pending says the command that runs them (the reply carries the resume offer already).
  const host = mcpHostOf(stores);
  if (reply.run_phase === undefined || !TERMINAL_PHASES.has(reply.run_phase)) {
    return mcpReplyOf(renderReply(reply, host));
  }
  // #715 (b) (D6-17, Amendment 4): the snapshot the engine judged its reply on — never a second load;
  // a reply that carries none gets no sentence about the ended run.
  const endedSnap = judgedSnapshotOf(reply);
  // #625 A1b-1 (correction 1): an answer refused or repeated because an earlier answer settled the
  // question carries that answer's outcome — who answered, not how the run ended; on a run that has
  // ended, how it ended comes first, once. Its reply is a copy the outcome words made, so the record
  // is the one the engine judged its own reply on.
  const earlier = reply.outcome?.by.kind === 'answer' ? judgedSnapshotOf(engineReply) : undefined;
  const ending = earlier === undefined ? undefined : runEndingOf(earlier.record, definition);
  const endingTail = ending === undefined ? '' : ` ${ending.sentence}`;
  if (endedSnap === undefined)
    return mcpReplyOf(withHintTail(renderReply(reply, host), endingTail));
  const ended = endedSnap.record;
  // #625 PR-2b A2a correction 1 (C205): a reply that carried the run on is the continuation's, so its
  // ended-run tail is advance_run's — how the run ended when someone else ended it, the cleanup step
  // left pending, and the way back in, each said once. Core's hint holds none of them: its resume
  // offer rides only the answer's own reply, composed while the run was still open.
  if (engineReply.gate_claim?.carried_on === true) {
    return mcpReplyOf(
      withHintTail(
        renderReply(reply, host),
        endedRunWaysSentence(ended, definition, endedSnap.at, saysHowItEnded(engineReply, ended)),
      ),
    );
  }
  // #729 PR-0: the ended run's ways back in follow the door's own sentence of what comes next, as
  // before PR-0 (withPendingCleanup's rule, kept whole): the cleanup sentence once — never when the
  // hint already names its command (F11) — and, when core's hint ends with the resume offer, the
  // offer after it, so its command ends the hint (F6). Both are said after the door's sentence.
  // #715 (b): every statement about the ended run is judged at its snapshot's reading.
  const now = endedSnap.at;
  const cleanup = pendingCleanupSentence(ended, now);
  const cleanupWay = pendingCleanupWay(ended, now);
  const named = cleanupWay !== undefined && reply.context_hint.includes(`'${cleanupWay.command}'`);
  const offer = endedRunWaysSentence(ended, definition, now).slice(cleanup.length);
  const hint = reply.context_hint;
  const moved = offer !== '' && hint.endsWith(offer);
  const own = moved ? { ...reply, context_hint: hint.slice(0, hint.length - offer.length) } : reply;
  // An answer that did not carry the run on: core's refusal of an answer to an ended run already says
  // how it ended (A1b-1), so the tail never says it again.
  const tail = `${endingTail}${named ? '' : cleanup}${moved ? offer : ''}`;
  return mcpReplyOf(withHintTail(renderReply(own, host), tail));
}

/**
 * #625 PR-2b A2a: the answer's carry-on budget — the answer tool's cap, 240 seconds
 * (`FORM_WAIT_SECONDS_DEFAULT`), less what this call has spent since its start, on the door's clock.
 * None when the call's start is unknown (a direct handler call with no door).
 */
function answerBudgetOf(
  stores: HandleRunStores,
  call: FormCall | undefined,
): { budget?: { remainingMs: () => number } } {
  const door = stores?.door;
  if (call === undefined || door === undefined) return {};
  const capMs = FORM_WAIT_SECONDS_DEFAULT * 1000;
  return { budget: { remainingMs: () => capMs - (door.monotonicNow() - call.started) } };
}

/**
 * #729 PR-6a (B7): an answer that was not recorded, in the assistant's words, through the one
 * sentence-maker (`renderOutcome`, {@link ASSISTANT_DOOR_WORDS}):
 * - beaten by another person's answer: with a different choice the refusal's `errors[0]` and the
 *   head of `context_hint` are the sentence (the door's sentence of what the run owes follows it,
 *   as before); with the same choice `context_hint` is the sentence — and `answer_recorded` stays
 *   unset, which means the question's expiry beat the answer;
 * - after an `on_expiry: abort` another call carried out (no `expiry` receipt: this call did not):
 *   `errors[0]` is the sentence; `context_hint` keeps the way out of the ended run.
 * Every other reply is returned as it is (its time-limit words are core's, as before).
 */
function withOutcomeWords(reply: EngineReply): EngineReply {
  const outcome = reply.outcome;
  if (outcome === undefined) return reply;
  if (outcome.by.kind === 'answer' && reply.answer_recorded !== false) {
    const sentence = renderOutcome(outcome, ASSISTANT_DOOR_WORDS);
    return reply.status === 'error'
      ? { ...reply, errors: [sentence, ...reply.errors.slice(1)], context_hint: sentence }
      : { ...reply, context_hint: sentence };
  }
  if (
    outcome.by.kind === 'timeout' &&
    outcome.choice === undefined &&
    reply.answer_recorded === false &&
    reply.expiry === undefined &&
    reply.status === 'error'
  ) {
    const sentence = renderOutcome(outcome, ASSISTANT_DOOR_WORDS);
    return { ...reply, errors: [sentence, ...reply.errors.slice(1)] };
  }
  return reply;
}

/**
 * Registers the submit_human_response MCP tool on the server, and returns it. The server registers it
 * under `permitted` only (§5.2's table; the gate-answers default, 2026-11-14).
 */
export function registerSubmitHumanResponse(
  server: McpServer,
  opts: HandleRunStores & WithDoorDisclosure,
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
      description: SUBMIT_HUMAN_RESPONSE_DESCRIPTION,
      inputSchema: boundedRefusal(submitHumanResponseArgsSchema),
    },
    safeTool(
      async (rawArgs, extra) => {
        const args = rawArgs as z.infer<typeof submitHumanResponseArgsSchema>;
        // #625 PR-2b A2a: the call's start, taken first — the carry-on's 240 seconds run from it.
        const result = await handleSubmitHumanResponse(args, opts, formCallOf(opts, extra));
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
