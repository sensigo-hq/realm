// form-path.ts — #627 W (§5.2, §5.2b): the question sent to the person as a form in the chat app
// (MCP form elicitation), under `asked` in a session whose client shows forms. ONE function sends a
// form (`sendQuestionForm` — the later wrap point, rule 9); the reply after the wait is composed from
// a FRESH read of the run, never from the reply that preceded the wait.
//
// The wait is Realm's, bounded twice: the time left until the question's stored deadline (read
// through core's one instant reader, `readInstant`, at a fresh snapshot's reading) and the call's own
// budget (the cap minus the time this tool call has already spent, from the monotonic clock). Only an
// `accept` holding one of the frozen choices, for the question that is still open, is an answer;
// every other outcome — decline, cancel, a JSON-RPC error, Realm's own timeout — records nothing.
import {
  composeWaysOn,
  deriveRunPhase,
  loadSnapshot,
  outcomeOf,
  readInstant,
  shownViewEvidence,
  submitHumanResponse,
  MCP_FORM_RENDERER,
  type Attributed,
  type EngineReply,
  type ExtensionRegistry,
  type Outcome,
  type PendingGate,
  type Principal,
  type RunRecord,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { FORM_SETTLE_POLL_MS, FORM_WAIT_FLOOR_SECONDS, type McpDoor } from './door.js';

/** How a form is sent: the server's `elicitInput`, bound (stdio only). */
export type ElicitFn = (
  params: {
    mode: 'form';
    message: string;
    requestedSchema: {
      type: 'object';
      properties: Record<string, { type: 'string'; title: string; enum: string[] }>;
      required: string[];
    };
  },
  options: { signal: AbortSignal; timeout: number },
) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>;

/** One tool call's own facts: the client's cancel signal and when the call started (monotonic ms). */
export interface FormCall {
  signal?: AbortSignal;
  started: number;
}

/** What sending a form needs: the door, its send function, the stores and the answer's facts. */
export interface FormDeps {
  door: McpDoor;
  elicit: ElicitFn;
  runStore: RunStore;
  definition: WorkflowDefinition;
  registry?: ExtensionRegistry;
  driver?: Attributed;
  principal: Principal;
}

/** The one required field of the form (W-f1). */
const ANSWER_FIELD = 'choice';

/** What `sendQuestionForm` did. */
export type FormResult =
  /** No form was sent: the question is not open, it is due, the call's budget is below the floor,
   *  a form for it is open, it was already sent (a first send only), or no asks are left. */
  | { kind: 'not_sent'; why: 'not_open' | 'due' | 'budget' | 'taken' }
  /** An answer came back and was submitted: the answer's own reply (recorded, or not — `outcome`). */
  | { kind: 'answered'; reply: EngineReply; step: string; expires_at?: string }
  /** The form came back without an answer; `waited_s` when Realm's own timeout ended it. */
  | { kind: 'came_back'; step: string; gate_id: string; expires_at?: string; waited_s?: number };

/**
 * #627 W: the ONE function that sends a question's form. `firstOnly`: the automatic send of
 * `start_run` / `execute_step` / `advance_run` — only a question this process has never sent;
 * `present_question` sends again while asks remain. The due check, the budget floor and
 * check-and-mark are one synchronous step after the fresh read, in that order (§5.2b), so two
 * concurrent calls on one question send one form and no question is left marked open unsent.
 */
export async function sendQuestionForm(
  deps: FormDeps,
  runId: string,
  gateId: string,
  call: FormCall,
  firstOnly: boolean,
): Promise<FormResult> {
  const snap = await loadSnapshot(deps.runStore, runId);
  const gate = snap.record.pending_gate;
  if (snap.record.terminal_state || gate === undefined || gate.gate_id !== gateId) {
    return { kind: 'not_sent', why: 'not_open' };
  }
  const capMs = deps.door.formWait.seconds * 1000;
  // ── one synchronous step: the due check, the budget floor, check-and-mark ──────────────────────
  let leftMs: number | undefined;
  if (gate.expires_at !== undefined) {
    const read = readInstant(gate.expires_at, 'deadline', snap.at);
    if ('absent' in read) {
      console.error(
        `realm: the question on step '${gate.step_name}' of run ${runId} has a deadline this version cannot read; its form waits the cap alone (${deps.door.formWait.seconds} s).`,
      );
    } else {
      leftMs = read.ms - snap.at.getTime();
      // A due question opens no form: the next write carries out its expiry.
      if (leftMs <= 0) return { kind: 'not_sent', why: 'due' };
    }
  }
  const budgetMs = capMs - (deps.door.monotonicNow() - call.started);
  if (budgetMs < FORM_WAIT_FLOOR_SECONDS * 1000) return { kind: 'not_sent', why: 'budget' };
  if (!deps.door.claimSend(gateId, firstOnly)) return { kind: 'not_sent', why: 'taken' };
  // ── the form is now marked open: from here every path closes it ──────────────────────────────
  const timeout = Math.max(1, Math.floor(Math.min(budgetMs, leftMs ?? budgetMs)));
  const request = {
    run_id: runId,
    gate_id: gate.gate_id,
    choices: [...gate.choices],
    shown_text: questionText(gate),
  };
  const withdraw = new AbortController();
  const onCancel = (): void => withdraw.abort();
  call.signal?.addEventListener('abort', onCancel, { once: true });
  // The settle poll (a host timer; no stored instant compared): the form is withdrawn once the
  // question is gone — a settle deletes `pending_gate`, and so does an abort's gate cancel.
  const poll = setInterval(() => {
    deps.runStore
      .get(runId)
      .then((record: RunRecord) => {
        if (record.pending_gate?.gate_id !== gateId) withdraw.abort();
      })
      .catch(() => undefined);
  }, FORM_SETTLE_POLL_MS);
  let answered = false;
  try {
    let result: Awaited<ReturnType<ElicitFn>>;
    try {
      result = await deps.elicit(
        {
          mode: 'form',
          message: request.shown_text,
          requestedSchema: {
            type: 'object',
            properties: {
              [ANSWER_FIELD]: { type: 'string', title: 'Your answer', enum: request.choices },
            },
            required: [ANSWER_FIELD],
          },
        },
        { signal: withdraw.signal, timeout },
      );
    } catch (err) {
      // A JSON-RPC error (the SDK's InvalidParams on `{}`, a client's own failure), a withdrawn form,
      // or Realm's own timeout: a non-answer. The SDK rejects a withdrawn request with the same code
      // as a timeout, so only a wait this call did not withdraw is Realm's timeout.
      const timedOut = !withdraw.signal.aborted && isTimeout(err);
      return {
        kind: 'came_back',
        step: gate.step_name,
        gate_id: gateId,
        ...(gate.expires_at !== undefined ? { expires_at: gate.expires_at } : {}),
        ...(timedOut ? { waited_s: Math.round(timeout / 1000) } : {}),
      };
    }
    const choice = result.content?.[ANSWER_FIELD];
    if (
      result.action !== 'accept' ||
      typeof choice !== 'string' ||
      !request.choices.includes(choice)
    ) {
      return {
        kind: 'came_back',
        step: gate.step_name,
        gate_id: gateId,
        ...(gate.expires_at !== undefined ? { expires_at: gate.expires_at } : {}),
      };
    }
    // The gate-id fence: the evidence is the question as sent, checked against this call's request
    // state before anything is recorded. No claim token: the binding is the request state.
    const evidence = shownViewEvidence(gate, MCP_FORM_RENDERER);
    if (evidence.gate_id !== request.gate_id) {
      return { kind: 'came_back', step: gate.step_name, gate_id: gateId };
    }
    answered = true;
    const reply = await submitHumanResponse(deps.runStore, deps.definition, {
      runId,
      gateId: request.gate_id,
      choice,
      route: evidence.route,
      shown: evidence.shown,
      principal: deps.principal,
      ...(deps.registry !== undefined ? { registry: deps.registry } : {}),
      ...(deps.driver !== undefined ? { driver: deps.driver } : {}),
    });
    return {
      kind: 'answered',
      reply,
      step: gate.step_name,
      ...(gate.expires_at !== undefined ? { expires_at: gate.expires_at } : {}),
    };
  } finally {
    clearInterval(poll);
    call.signal?.removeEventListener('abort', onCancel);
    deps.door.closeSend(gateId, answered);
  }
}

/** The form's message: the frozen question — the gate's resolved message, else a plain line. */
function questionText(gate: PendingGate): string {
  return (
    gate.resolved_message ?? `The question on step '${gate.step_name}' is waiting for your answer.`
  );
}

/** Whether a failed elicitation ended on Realm's own timeout (the SDK's RequestTimeout, -32001). */
function isTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === -32001;
}

/** #627 W (W-i10, MCP's copy of the door's route words): how a route is named to the agent. */
export function routePhraseOf(route: string): string {
  switch (route) {
    case 'mcp_form':
      return "the user's app, as a form";
    case 'mcp':
      return "Realm's MCP answer tool";
    case 'cli':
      return 'a terminal (realm run respond)';
    default:
      return `route '${route}'`;
  }
}

/**
 * #627 W (W-f3): how a question was settled, in one sentence per `by.kind` — "Not recorded:" when
 * this call's form was accepted (it tried to answer), "Meanwhile," when it did not. The stated name is
 * delimited, and labelled as stated; a route absence is its own whole template.
 */
export function renderOutcome(outcome: Outcome): string {
  const lead = outcome.attempted ? 'Not recorded:' : 'Meanwhile,';
  const q = `the question on step '${outcome.step}'`;
  const by = outcome.by;
  if (
    by.kind === 'timeout' ||
    (typeof outcome.via === 'object' && outcome.via.absent === 'settled_by_expiry')
  ) {
    return outcome.choice !== undefined
      ? `${lead} ${q} reached its time limit, and the run took the default ${outcome.choice}.`
      : `${lead} ${q} reached its time limit, and the run ended as aborted.`;
  }
  if (by.kind === 'engine') {
    return `${lead} ${q} was closed because step '${by.step}' aborted the run.`;
  }
  const choice = outcome.choice ?? '';
  const name = by.name !== undefined ? `, by "${by.name}" (as stated)` : '';
  const via = outcome.via;
  if (typeof via === 'object' && via.absent === 'route_not_declared') {
    return `${lead} ${q} was answered — ${choice}${name}, through a route its program did not declare.`;
  }
  if (typeof via === 'object' && via.absent === 'recorded_without_route') {
    return `${lead} ${q} was answered — ${choice}${name}; how the answer arrived was not recorded.`;
  }
  const route = typeof via === 'string' ? `, through ${routePhraseOf(via)}` : '';
  return `${lead} ${q} was answered — ${choice}${name}${route}.`;
}

/** The W-f2 sentence: the form came back without an answer; the question still waits. */
function cameBackSentence(
  result: Extract<FormResult, { kind: 'came_back' }>,
  door: McpDoor,
): string {
  const waited =
    result.waited_s !== undefined ? ` (Realm stopped waiting after ${result.waited_s} s)` : '';
  const until = result.expires_at !== undefined ? ` until ${result.expires_at}` : '';
  const left = door.formFacts(result.gate_id).asks_left;
  const again =
    left > 0 ? ` To show it again, call present_question (${left} left in this session).` : '';
  return `Not recorded: the form came back without an answer${waited}. The question on step '${result.step}' is still waiting${until}.${again}`;
}

/**
 * The reply after a form's wait (§5.2b): the answer's own reply when one was submitted (W-f3 when it
 * was not recorded); else, from a FRESH read, one of four branches — the run ended (the run's own
 * ended reply), the question due (its `advance` way), the question settled or cancelled meanwhile
 * (W-f3, "Meanwhile,"), or still open (W-f2, the await entry in its "closed" form). `before` is the
 * reply that preceded the wait: its command and its warnings stay.
 */
export async function replyAfterForm(
  before: EngineReply,
  result: Exclude<FormResult, { kind: 'not_sent' }>,
  deps: FormDeps,
): Promise<EngineReply> {
  if (result.kind === 'answered') {
    const reply = { ...result.reply, command: before.command };
    if (reply.outcome !== undefined) {
      // The form was accepted and its answer was not recorded: what settled the question.
      return {
        ...reply,
        context_hint: renderOutcome({ ...reply.outcome, attempted: true }),
        ...(reply.run_phase !== undefined && reply.run_phase !== 'completed'
          ? { names_next: true as const }
          : {}),
      };
    }
    return reply;
  }
  const snap = await loadSnapshot(deps.runStore, before.run_id);
  const record = snap.record;
  const ways = composeWaysOn(snap, {
    definition: { ok: deps.definition },
    enactor:
      deps.registry !== undefined
        ? { kind: 'this_program', registry: deps.registry }
        : { kind: 'observer' },
    store: { persistsClaims: deps.runStore.persistsClaims === true },
  });
  const base: EngineReply = {
    command: before.command,
    run_id: before.run_id,
    run_version: record.version,
    status: 'ok',
    reply_kind: 'ok',
    data: {},
    evidence: [],
    warnings: before.warnings,
    errors: [],
    context_hint: '',
    run_phase: deriveRunPhase(record),
    ...ways,
  };
  if (record.terminal_state) {
    return {
      ...base,
      intrinsic_action: 'stop',
      context_hint: `Run '${record.id}' ended while the form was open (phase '${deriveRunPhase(record)}').`,
      names_next: true,
    };
  }
  const gate = record.pending_gate;
  if (gate === undefined || gate.gate_id !== result.gate_id) {
    const outcome = outcomeOf(record, result.step, result.expires_at, false);
    return {
      ...base,
      context_hint:
        outcome !== undefined
          ? renderOutcome(outcome)
          : `Meanwhile, the question on step '${result.step}' was closed.`,
      names_next: true,
    };
  }
  if (ways.unavailable.some((u) => u.verb === 'respond' && u.code === 'question_due')) {
    return { ...base, context_hint: before.context_hint, names_next: true };
  }
  return {
    ...base,
    status: before.status,
    reply_kind: before.reply_kind,
    ...(before.gate !== undefined && before.gate.gate_id === gate.gate_id
      ? { gate: before.gate }
      : {}),
    // W-f2 alone: the await entry ("came back") says the rest; no next sentence repeats it.
    context_hint: cameBackSentence(result, deps.door),
  };
}

/**
 * The automatic send (§5.2b's closed list: `start_run` when it creates the run, `execute_step` and
 * `advance_run`): when the reply carries an open question this process has never sent, on a door
 * whose answers row is `asked` with forms, send its form and return the reply after the wait; else
 * the reply as it is.
 */
export async function withQuestionForm(
  reply: EngineReply,
  deps: FormDeps | undefined,
  call: FormCall | undefined,
): Promise<EngineReply> {
  if (deps === undefined || call === undefined) return reply;
  const answers = deps.door.answers();
  if (answers.value !== 'asked' || !answers.forms.shown) return reply;
  const respond = reply.ways.find((w) => w.verb === 'respond');
  if (respond === undefined || respond.verb !== 'respond') return reply;
  if (deps.door.formFacts(respond.gate_id).sent > 0) return reply;
  const result = await sendQuestionForm(deps, reply.run_id, respond.gate_id, call, true);
  if (result.kind === 'not_sent') return reply;
  return replyAfterForm(reply, result, deps);
}
