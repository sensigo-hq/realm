// form-path.ts — #627 W (§5.2, §5.2b): the question sent to the person as a form in the chat app
// (MCP form elicitation), under `asked` in a session whose client shows forms. ONE function sends a
// form (`sendQuestionForm` — the later wrap point, rule 9); the reply after the wait is composed from
// a FRESH read of the run, never from the reply that preceded the wait.
//
// The wait is Realm's, bounded by the call's own budget (the cap minus the time this tool call has
// already spent, from the monotonic clock) and, for a gate that declares `on_expiry`, by the time left
// until its stored deadline (read through core's one instant reader, `readInstant`, at a fresh
// snapshot's reading). A gate whose deadline only reports its expiry waits the budget alone (correction
// 2, 1.1). Only an `accept` holding one of the frozen choices, for the question that is still open, is
// an answer; every other outcome — decline, cancel, a JSON-RPC error, Realm's own timer — records
// nothing, and says how the form ended (1.4).
import {
  composeWaysOn,
  deriveRunPhase,
  dueExpiry,
  loadSnapshot,
  outcomeOf,
  pendingGateQuestion,
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
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
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
  // `relatedRequestId` (correction 1, B9): the tool call's own request id, so a stateful-HTTP embedder's
  // form rides that call's stream (the SDK's HTTP transport drops a request with none when no GET
  // stream is open).
  options: { signal: AbortSignal; timeout: number; relatedRequestId?: string | number },
) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>;

/** One tool call's own facts: the client's cancel signal, when the call started (monotonic ms), and
 *  the call's JSON-RPC request id. */
export interface FormCall {
  signal?: AbortSignal;
  started: number;
  requestId?: string | number;
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

/**
 * How a form ended without an answer (correction 2, 1.4): `stopped` — Realm's own timer withdrew it;
 * `closed` — the client returned `decline` or `cancel`; `not_a_choice` — an `accept` holding a value
 * that is not one of the choices, or none; `ended` — a JSON-RPC error, or the client ended the
 * request; `not_written` — the person's accepted answer could not be written (1.4b).
 */
export type FormEndCause = 'stopped' | 'closed' | 'not_a_choice' | 'ended' | 'not_written';

/** What `sendQuestionForm` did. */
export type FormResult =
  /** No form was sent: `not_open` — the question is not open; `due` — its declared expiry is owed;
   *  `budget` — the call's budget is below the floor; `cancelled` — the call was already cancelled;
   *  `taken` — a form for it is open, it was already sent (a first send only), or no asks are left. */
  | { kind: 'not_sent'; why: 'not_open' | 'due' | 'budget' | 'cancelled' | 'taken' }
  /** An answer came back and was submitted: the answer's own reply — recorded, or not
   *  ({@link formAnswerRecorded}). `until`: the deadline that ends the question, only when its gate
   *  declares `on_expiry`. */
  | {
      kind: 'answered';
      reply: EngineReply;
      step: string;
      gate_id: string;
      expires_at?: string;
      until?: string;
    }
  /** The form ended without an answer, and how (`cause`); `waited_s` when Realm's own timer ended
   *  it; `until` as above. */
  | {
      kind: 'came_back';
      step: string;
      gate_id: string;
      cause: FormEndCause;
      expires_at?: string;
      until?: string;
      waited_s?: number;
    };

/**
 * Correction 2 (1.5): the ONE predicate for "the form's answer was recorded" — the answer's own reply
 * is neither an error nor a refusal, no expiry turned it away, and no other answer had settled the
 * question first. Anything else counts as the form coming back.
 */
export function formAnswerRecorded(reply: EngineReply): boolean {
  return (
    reply.status !== 'error' &&
    reply.status !== 'blocked' &&
    reply.answer_recorded !== false &&
    reply.outcome === undefined
  );
}

/** The SDK's own check of a form's content against its schema (an `accept` with no choice, or one not
 *  in the list): `McpError(InvalidParams, "Elicitation response content does not match requested
 *  schema: …")`, thrown by SDK 1.31's `elicitInput`. */
function isContentRefusal(err: unknown): boolean {
  return (
    err instanceof McpError &&
    err.code === ErrorCode.InvalidParams &&
    err.message.includes('does not match requested schema')
  );
}

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
  // Correction 2 (1.1): "due" is core's one predicate (`dueExpiry`: the gate declares `on_expiry` and
  // its time is up) — a due question opens no form, the next write carries out its expiry. Only such
  // a gate's deadline bounds the wait; a gate whose deadline only reports its expiry keeps waiting for
  // a person, so its form is sent and waits the budget alone, before or after its deadline.
  const deadline =
    gate.on_expiry !== undefined && gate.expires_at !== undefined ? gate.expires_at : undefined;
  let leftMs: number | undefined;
  if (deadline !== undefined) {
    if (dueExpiry(gate, snap.at) !== undefined) return { kind: 'not_sent', why: 'due' };
    const read = readInstant(deadline, 'deadline', snap.at);
    if ('absent' in read) {
      console.error(
        `realm: the question on step '${gate.step_name}' of run ${runId} has a deadline this version cannot read; its form waits the cap alone (${deps.door.formWait.seconds} s).`,
      );
    } else {
      leftMs = read.ms - snap.at.getTime();
    }
  }
  const budgetMs = capMs - (deps.door.monotonicNow() - call.started);
  if (budgetMs < FORM_WAIT_FLOOR_SECONDS * 1000) return { kind: 'not_sent', why: 'budget' };
  // Correction 1 (B8): a call its client has already cancelled gets no form.
  if (call.signal?.aborted === true) return { kind: 'not_sent', why: 'cancelled' };
  if (!deps.door.claimSend(gateId, firstOnly)) return { kind: 'not_sent', why: 'taken' };
  // ── the form is now marked open: from here every path closes it ──────────────────────────────
  const timeout = Math.max(1, Math.floor(Math.min(budgetMs, leftMs ?? budgetMs)));
  const until = deadline !== undefined ? { until: deadline } : {};
  const request = {
    run_id: runId,
    gate_id: gate.gate_id,
    choices: [...gate.choices],
    shown_text: questionText(deps.definition, snap.record),
  };
  // Correction 1 (B11): Realm owns the form's timer. Each withdrawal aborts with its own plain reason,
  // which the SDK sends the client as the cancel's `reason`; the SDK's own timeout is set above
  // Realm's (never left unset — its default is 60 s), so Realm's timer is the one that ends the wait.
  // Correction 2 (1.2): the timer's reason is chosen when it is armed — "the question's time ran out"
  // only when the deadline of a gate that declares `on_expiry` is the nearer bound; else Realm stopped
  // waiting and the question is still open.
  const timerReason =
    leftMs !== undefined && leftMs < budgetMs ? WITHDRAWN.timeout : WITHDRAWN.stopped;
  const withdraw = new AbortController();
  // Correction 2 (1.3): once the form came back, nothing withdraws it — a poll read already in flight,
  // the timer and the call's listener each check `settled` first (the SDK keeps its own listener on
  // `withdraw.signal` after a response, so an abort then would still send a cancel).
  let settled = false;
  const withdrawWith = (reason: string): void => {
    if (!settled) withdraw.abort(reason);
  };
  const onCancel = (): void => withdrawWith(WITHDRAWN.cancelled);
  call.signal?.addEventListener('abort', onCancel, { once: true });
  const timer = setTimeout(() => withdrawWith(timerReason), timeout);
  // The settle poll (a host timer; no stored instant compared): the form is withdrawn once the
  // question is gone — a settle deletes `pending_gate`, and so does an abort's gate cancel — worded by
  // the record it read (correction 2, 1.3).
  const poll = setInterval(() => {
    deps.runStore
      .get(runId)
      .then((record: RunRecord) => {
        if (record.terminal_state) withdrawWith(WITHDRAWN.ended);
        else if (record.pending_gate?.gate_id !== gateId) withdrawWith(WITHDRAWN.settled);
      })
      .catch(() => undefined);
  }, FORM_SETTLE_POLL_MS);
  const stopWatching = (): void => {
    settled = true;
    clearTimeout(timer);
    clearInterval(poll);
    call.signal?.removeEventListener('abort', onCancel);
  };
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
        {
          signal: withdraw.signal,
          timeout: timeout + SDK_TIMEOUT_MARGIN_MS,
          ...(call.requestId !== undefined ? { relatedRequestId: call.requestId } : {}),
        },
      );
    } catch (err) {
      stopWatching();
      // A JSON-RPC error (the SDK's own check of the content, a client's own failure), a withdrawn
      // form, or Realm's own timer: a non-answer, by its cause. Realm's timer is the withdrawal its
      // own timer made, with either of its two reasons.
      const reason: unknown = withdraw.signal.aborted ? withdraw.signal.reason : undefined;
      const timedOut = reason === WITHDRAWN.timeout || reason === WITHDRAWN.stopped;
      return {
        kind: 'came_back',
        step: gate.step_name,
        gate_id: gateId,
        cause: timedOut ? 'stopped' : isContentRefusal(err) ? 'not_a_choice' : 'ended',
        ...(gate.expires_at !== undefined ? { expires_at: gate.expires_at } : {}),
        ...until,
        ...(timedOut ? { waited_s: Math.round(timeout / 1000) } : {}),
      };
    }
    stopWatching();
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
        cause: result.action !== 'accept' ? 'closed' : 'not_a_choice',
        ...(gate.expires_at !== undefined ? { expires_at: gate.expires_at } : {}),
        ...until,
      };
    }
    // The fence is the engine's write (correction 1, B4): the answer is submitted for the REQUEST
    // STATE's gate — the gate this form was sent for — never a gate re-read after the wait, which would
    // let a stale form answer a NEW question. The engine refuses it when that gate is no longer open.
    // No claim token: the binding is the request state.
    const evidence = shownViewEvidence(gate, MCP_FORM_RENDERER);
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
    // Correction 1 (B5): answered only when the reply RECORDED it; else the form came back.
    answered = formAnswerRecorded(reply);
    return {
      kind: 'answered',
      reply,
      step: gate.step_name,
      gate_id: gateId,
      ...(gate.expires_at !== undefined ? { expires_at: gate.expires_at } : {}),
      ...until,
    };
  } finally {
    // The backstop: every path above has already stopped watching once the form came back.
    stopWatching();
    deps.door.closeSend(gateId, answered);
  }
}

/** Correction 1 (B11): why a form was withdrawn — the cancel's `reason` the client is sent. Correction
 *  2 (1.2): `timeout` only when the deadline of a gate that declares `on_expiry` ended the wait;
 *  `stopped` when Realm's own wait ran out first; `ended` when the run ended. */
export const WITHDRAWN = {
  timeout: "the question's time ran out",
  stopped: 'Realm stopped waiting for this answer; the question is still open',
  settled: 'the question was settled elsewhere',
  ended: 'the run ended',
  cancelled: 'the call was cancelled',
} as const;

/** How far the SDK's own timeout sits above Realm's timer (so Realm's ends the wait). */
export const SDK_TIMEOUT_MARGIN_MS = 5000;

/** The form's message (correction 2, 2.1): the question through core's ONE composer,
 *  `pendingGateQuestion` — the gate's message, else its step's prompt rendered with what the step had
 *  when the gate opened — else a plain line. A prompt that cannot be rendered never throws here. */
function questionText(definition: WorkflowDefinition, record: RunRecord): string {
  const gate = record.pending_gate as PendingGate;
  try {
    const question = pendingGateQuestion(definition, record);
    if (question !== undefined) return question;
  } catch {
    // a prompt the registered definition can no longer render: the plain line
  }
  return `The question on step '${gate.step_name}' is waiting for your answer.`;
}

/**
 * #627 W (W-i10): how a route is named to the AGENT, in the reply after a form (W-f3). The operator's
 * table is the CLI's own (inspect, `holder-render.ts`): only there does the `cli` route name its
 * command — an agent is never told how to answer a gate from a terminal (correction 1, A1).
 */
export function routePhraseOf(route: string): string {
  switch (route) {
    case 'mcp_form':
      return "the user's app, as a form";
    case 'mcp':
      return "Realm's MCP answer tool";
    case 'cli':
      return 'a terminal';
    // #819 (item 28): `realm agent`'s Slack thread, its own words — never the fallback.
    case 'slack':
      return 'a Slack thread';
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

/** W-f2's opening, by how the form ended (correction 2, 1.4). */
function formEndedWords(cause: FormEndCause, waitedS: number | undefined): string {
  switch (cause) {
    case 'stopped':
      return `Not recorded: Realm stopped waiting after ${waitedS ?? 0} s and withdrew the form.`;
    case 'closed':
      return 'Not recorded: the person closed the form without answering.';
    case 'not_a_choice':
      return "Not recorded: the form came back with a value that is not one of the question's choices.";
    case 'ended':
      return "Not recorded: the user's app ended the form without an answer.";
    case 'not_written':
      return 'Not recorded: the answer from the form could not be written.';
  }
}

/** The W-f2 sentence: the form ended without an answer, and how; the question still waits — "until
 *  <time>" only for a gate whose deadline ends it (correction 2, 1.1). */
function cameBackSentence(
  result: Pick<
    Extract<FormResult, { kind: 'came_back' }>,
    'step' | 'gate_id' | 'cause' | 'until' | 'waited_s'
  >,
  door: McpDoor,
): string {
  const until = result.until !== undefined ? ` until ${result.until}` : '';
  const left = door.formFacts(result.gate_id).asks_left;
  const again =
    left > 0 ? ` To show it again, call present_question (${left} left in this session).` : '';
  return `${formEndedWords(result.cause, result.waited_s)} The question on step '${result.step}' is still waiting${until}.${again}`;
}

/**
 * The reply after a form's wait (§5.2b): the answer's own reply when one was submitted AND recorded;
 * else, from a FRESH read. An accepted answer that was not recorded (correction 2, 1.4b) never passes
 * on the answer's own refusal, which addresses its caller — here the person's form, not the agent:
 * the question gone or another gate open → what settled it ("Not recorded:", read before the
 * run-ended arm); still open → W-f2, `not_written`. A form that came back: the run ended (the run's
 * own ended reply), the question due (its `advance` way), settled or cancelled meanwhile (W-f3,
 * "Meanwhile,"), or still open (W-f2, by how it ended). `before` is the reply that preceded the wait:
 * its command and its warnings stay.
 */
export async function replyAfterForm(
  before: EngineReply,
  result: Exclude<FormResult, { kind: 'not_sent' }>,
  deps: FormDeps,
): Promise<EngineReply> {
  // Correction 1 (B6): the reply that preceded the wait keeps its warnings (a pre-flight warning).
  const warnings =
    result.kind === 'answered' ? [...before.warnings, ...result.reply.warnings] : before.warnings;
  if (result.kind === 'answered' && formAnswerRecorded(result.reply)) {
    return { ...result.reply, command: before.command, warnings };
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
    warnings,
    errors: [],
    context_hint: '',
    run_phase: deriveRunPhase(record),
    ...ways,
  };
  const gate = record.pending_gate;
  if (result.kind === 'answered') {
    if (gate === undefined || gate.gate_id !== result.gate_id) {
      // What settled the question instead — read before the run-ended arm, so a run the other answer
      // ended still says "Not recorded: …"; its run_phase says it ended.
      const outcome = outcomeOf(record, result.step, result.expires_at, true);
      return {
        ...base,
        ...(record.terminal_state ? { intrinsic_action: 'stop' as const } : {}),
        context_hint:
          outcome !== undefined
            ? renderOutcome(outcome)
            : `Not recorded: the question on step '${result.step}' was closed.`,
        names_next: true,
      };
    }
    return {
      ...base,
      status: before.status,
      reply_kind: before.reply_kind,
      ...(before.gate !== undefined && before.gate.gate_id === gate.gate_id
        ? { gate: before.gate }
        : {}),
      context_hint: cameBackSentence(
        {
          step: result.step,
          gate_id: result.gate_id,
          cause: 'not_written',
          ...(result.until !== undefined ? { until: result.until } : {}),
        },
        deps.door,
      ),
    };
  }
  if (record.terminal_state) {
    return {
      ...base,
      intrinsic_action: 'stop',
      context_hint: `Run '${record.id}' ended while the form was open (phase '${deriveRunPhase(record)}').`,
      names_next: true,
    };
  }
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
