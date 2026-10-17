// present-question tool — #627 W (§5.2b, verb `present`): send a waiting question to the user's app
// as a form, in the agent's own call. Listed only in a session whose client shows forms, under
// `asked` (§5.2's row 2). The call RE-JUDGES the offer (R26): core's admission on a fresh snapshot
// (the run, the question, its time), then the door's own verdict on this process's form facts (a form
// open here, asks left) — the same predicate the offer was judged by, so a form opened in between
// refuses with the same code, never a success.
import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  JsonFileStore,
  JsonWorkflowStore,
  WorkflowError,
  admitWay,
  assertRegistryLine,
  buildPreExecutionErrorEnvelope,
  composeWaysOn,
  deriveRunPhase,
  getWorkflowForRun,
  loadSnapshot,
  presentDoorVerdict,
  renderDefinitionAbsent,
  runReadError,
  ExtensionRegistry as RealmExtensionRegistry,
  type EngineReply,
  type Unavailable,
  type WaysContext,
} from '@sensigo/realm';
import { formCallOf, formDepsOf, mcpHostOf, type HandleRunStores } from './start-run.js';
import { replyAfterForm, sendQuestionForm, type FormCall } from '../form-path.js';
import {
  mcpReplyOf,
  renderReply,
  toolContentOf,
  PRESENT_QUESTION_DESCRIPTION,
  type McpEnvelope,
  type WithPersonBlock,
} from '../render-reply.js';
import { sseJsonStringify } from '../sse-json.js';
import { toolMeta } from '../tool-annotations.js';
import { assertToolStores, markServedByTool, registryRole } from './assert-tool-stores.js';

/** The tool's input: exactly `ARGS[present]` (`{ run_id, gate_id }`; the door-schema witness). */
export const presentQuestionArgsShape = { run_id: z.string(), gate_id: z.string() };

/** The words of a refusal: what is so about the question, per code. */
function refusalHint(
  entry: Unavailable,
  runId: string,
  gateId: string,
  gate: { step: string; expires_at?: string } | undefined,
): string {
  const step = gate?.step ?? '';
  switch (entry.code) {
    case 'run_ended':
      return `Run '${runId}' has ended (${entry.facts.phase}); its question is no longer open.`;
    case 'question_settled':
      return `The question on gate '${entry.facts.gate_id}' is already settled.`;
    case 'question_due':
      return `The question on step '${entry.facts.step}' (gate '${entry.facts.gate_id}') can no longer be answered: its time is up.`;
    case 'gate_not_open':
      return `No question with gate '${entry.facts.gate_id}' is open on run '${runId}'.`;
    case 'definition_absent':
      return `${renderDefinitionAbsent(entry.facts)}.`;
    case 'form_open':
      return `A form for the question on step '${step}' of run ${runId} was sent to the user's app, and Realm is waiting for the answer. It may not be on their screen. An answer given in this chat is not recorded.`;
    case 'asks_exhausted':
      // W-q2.
      return `The form for step '${step}' has been sent ${entry.facts.sent} times from this server and will not be sent again from here. The user can still answer it outside this conversation${gate?.expires_at !== undefined ? ` until ${gate.expires_at}` : ''}.`;
    case 'no_form_here':
      return `This session's client shows no forms, so the question on gate '${entry.facts.gate_id}' is not sent as a form here.`;
    default:
      return `The question on gate '${gateId}' cannot be shown again now.`;
  }
}

/**
 * Business logic for present_question: judge the call on a fresh snapshot, then the door's facts;
 * when admitted, send the form (`sendQuestionForm`, the one function) and return the reply after the
 * wait; else the refusal, with the run's ways.
 */
export async function handlePresentQuestion(
  args: { run_id: string; gate_id: string },
  stores?: HandleRunStores,
  call?: FormCall,
): Promise<WithPersonBlock<McpEnvelope>> {
  assertToolStores(stores, 'handlePresentQuestion');
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  const snap = await loadSnapshot(runStore, args.run_id).catch((err: unknown) => {
    throw runReadError(err);
  });
  const run = snap.record;
  const definition = await getWorkflowForRun(workflowStore, run, {
    retryVerb: 'retry',
    verb: 'retry',
  });
  const registry =
    stores?.registryProvider !== undefined
      ? await stores.registryProvider(definition)
      : stores?.registry;
  assertRegistryLine(
    registry,
    registryRole(stores, 'present_question', 'handlePresentQuestion'),
    RealmExtensionRegistry,
  );
  const ctx: WaysContext = {
    definition: { ok: definition },
    enactor: registry !== undefined ? { kind: 'this_program', registry } : { kind: 'observer' },
    store: { persistsClaims: runStore.persistsClaims === true },
  };
  const open = run.pending_gate;
  const gate =
    open !== undefined && open.gate_id === args.gate_id
      ? {
          step: open.step_name,
          ...(open.expires_at !== undefined ? { expires_at: open.expires_at } : {}),
        }
      : undefined;
  const judged = (): Unavailable | undefined => {
    const admission = admitWay('present', snap, ctx, {
      run_id: args.run_id,
      gate_id: args.gate_id,
    });
    if ('ok' in admission) return undefined;
    if (admission.code !== 'no_form_here') return admission;
    // The door's own verdict — the predicate `narrowForDoor` offered `present` by.
    const verdict = presentDoorVerdict(
      stores?.door?.answers(),
      args.gate_id,
      stores?.door?.formFacts(args.gate_id),
    );
    return 'offered' in verdict
      ? undefined
      : ({ ...admission, code: verdict.code, facts: verdict.facts } as Unavailable);
  };
  const base: EngineReply = {
    command: 'present_question',
    run_id: run.id,
    run_version: run.version,
    status: 'ok',
    reply_kind: 'ok',
    data: {},
    evidence: [],
    warnings: [],
    errors: [],
    context_hint: '',
    run_phase: deriveRunPhase(run),
    ...composeWaysOn(snap, ctx),
  };
  const refuse = (entry: Unavailable): EngineReply => ({
    ...base,
    status: 'blocked',
    reply_kind: 'refusal',
    refusal: entry,
    context_hint: refusalHint(entry, run.id, args.gate_id, gate),
    names_next: true,
  });
  // Correction 1 (E4): this call writes the run only when the person accepts a form; W-e1 may say "it
  // changed nothing" exactly when the reply's version is still the one read here.
  const host = { ...mcpHostOf(stores), readVersion: snap.record.version };
  const refusal = judged();
  if (refusal !== undefined) return mcpReplyOf(renderReply(refuse(refusal), host));
  const deps = formDepsOf(stores, runStore, definition, registry);
  if (deps === undefined || call === undefined) {
    // No way to send a form on this server (a door built without one): the door's own code.
    const respond = base.ways.filter((w) => w.verb === 'respond');
    return mcpReplyOf(
      renderReply(
        refuse({
          verb: 'present',
          code: 'no_form_here',
          facts: { gate_id: args.gate_id },
          remedy: respond,
        }),
        host,
      ),
    );
  }
  const result = await sendQuestionForm(deps, args.run_id, args.gate_id, call, false);
  if (result.kind === 'not_sent') {
    // Re-judged at the call (R26): what changed since the offer — a form opened here, the asks
    // spent, the question due or gone — on a fresh snapshot. The budget floor alone leaves the
    // question "never sent here".
    const fresh = await loadSnapshot(runStore, args.run_id);
    const again = admitWay('present', fresh, ctx, { run_id: args.run_id, gate_id: args.gate_id });
    const entry: Unavailable | undefined =
      'ok' in again
        ? undefined
        : again.code !== 'no_form_here'
          ? again
          : (() => {
              const verdict = presentDoorVerdict(
                deps.door.answers(),
                args.gate_id,
                deps.door.formFacts(args.gate_id),
              );
              return 'offered' in verdict
                ? undefined
                : ({ ...again, code: verdict.code, facts: verdict.facts } as Unavailable);
            })();
    return mcpReplyOf(renderReply(entry !== undefined ? refuse(entry) : base, host));
  }
  return mcpReplyOf(renderReply(await replyAfterForm(base, result, deps), host));
}

/** Registers the present_question MCP tool on the server, and returns it (listed per session). */
export function registerPresentQuestion(server: McpServer, opts?: HandleRunStores): RegisteredTool {
  markServedByTool(opts);
  return server.registerTool(
    'present_question',
    {
      ...toolMeta('present_question'),
      description: PRESENT_QUESTION_DESCRIPTION,
      inputSchema: presentQuestionArgsShape,
    },
    async (args, extra) => {
      const call = formCallOf(opts, extra);
      try {
        const result = await handlePresentQuestion(args, opts, call);
        return toolContentOf({ ...result, data: {}, evidence: [] }, sseJsonStringify);
      } catch (err) {
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
          workflowErr.code === 'STATE_RUN_NOT_FOUND'
            ? `Run '${args.run_id}' not found.`
            : 'An error occurred before the question could be shown.';
        const rendered = renderReply(
          buildPreExecutionErrorEnvelope(
            'present_question',
            args.run_id,
            0,
            workflowErr,
            contextHint,
          ),
          mcpHostOf(opts),
        );
        return toolContentOf(mcpReplyOf(rendered), sseJsonStringify);
      }
    },
  );
}
