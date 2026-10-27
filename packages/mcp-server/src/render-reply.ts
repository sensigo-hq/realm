// render-reply.ts — issue #729 PR-0 (PR0-CONTRACT §5; D2 §5, D3 A-1, A-2, A-17, D4 P-2, P-6): the MCP
// door's ONE renderer. It turns the engine's reply (`EngineReply`: the ways as data) into what an
// agent reads over MCP (`McpEnvelope`): `next_actions` from the progress ways the door serves the
// agent, an `also` list (reading and ending the run — never counted as callable), `elsewhere`
// entries for the ways only an operator can take, `agent_action` from core's one derivation, the
// pace of a wait, and the words of what comes next. The ways themselves (`ways`, `unavailable`,
// `error.remedy`) are rendered, never published (Amendment 5).
//
// The renderer law (PR0-CONTRACT §5, A-27): a way's entry is rendered from that way, its basis stamp
// and the host's static settings — never a record, view, definition, registry, clock or snapshot.
// The import census and a source-text ban on the clock witness it.
import {
  agentActionOf,
  agentRenderedList,
  cannotGoOnUntilCorrected,
  doorWithholdsAnswers,
  generateSchemaSkeleton,
  narrowForDoor,
  raceClausesOf,
  withFullStop,
  answersRowOf,
  AUTHOR_TEXT_LABEL,
  DOOR_SERVES,
  PROGRESS_VERBS,
  TERMINAL_PHASES,
  WAY_PARTIES,
  type AgentAction,
  type Basis,
  type DoorAnswers,
  type DoorFormFacts,
  type DoorPolicy,
  type EngineReply,
  type ForWay,
  type GateInfo,
  type Narrowed,
  type ProgressVerb,
  type RegisterWay,
  type RenderedList,
  type RespondWay,
  type Source,
  type Unavailable,
  type WayOf,
  type WayOn,
  type WayRenderer,
  type WayVerb,
} from '@sensigo/realm';
import {
  buildDisclosureSet,
  disclose,
  discloseReply,
  weakestDeclared,
  withDeclaredStanding,
  EVIDENCE_TABLE,
  GATE_INFO_TABLE,
  type ClassTable,
  type DisclosureClass,
  type DisclosureSet,
  type RunRecord,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { sseJsonStringify } from './sse-json.js';
import type {
  DriveFailureCost,
  EngineRunnable,
  FactProducers,
  Money,
  Outcome,
  PreconditionFacts,
  RunHealthFinding,
} from '@sensigo/realm';
import type { WorkflowProtocol } from './protocol/generator.js';
import type { ABANDON_RUN_TABLE, AbandonRunSummary } from './tools/abandon-run.js';
import type { APPEND_TRACE_TABLE, AppendTraceOkResult } from './tools/append-trace.js';
import type {
  DRIVE_FAILURE_COST_TABLE,
  ENGINE_RUNNABLE_TABLE,
  MONEY_TABLE,
  NOT_PRICED_TABLE,
  PRECONDITION_FACTS_TABLE,
  RUN_STATE_SUMMARY_TABLE,
  RunStateSummary,
} from './tools/get-run-state.js';
import type { WORKFLOW_PROTOCOL_TABLE } from './tools/get-workflow-protocol.js';
import type {
  LIST_WORKFLOWS_TABLE,
  ListWorkflowsResult,
  UnreadableWorkflowEntry,
} from './tools/list-workflows.js';
import type { START_RUN_BATCH_TABLE, StartRunBatchResult } from './tools/start-run-batch.js';
import type { START_RUN_TABLE, StartRunReply } from './tools/start-run.js';
import type { ELICIT_TABLE } from './server.js';
import type { ElicitFn } from './form-path.js';

// ─── What the agent reads ────────────────────────────────────────────────────────────────────────

/** One callable instruction: the tool, its parameters, and a ready-to-use argument object. */
export interface McpInstruction {
  tool: string;
  params: Record<string, unknown>;
  /**
   * Ready-to-use flat argument object for calling the tool. Agent-supplied params appear as
   * placeholder strings (e.g. "<YOUR_PARAMS>", "<approve|reject>"). Copy this object, replace the
   * placeholder(s), and call the tool.
   */
  call_with: Record<string, unknown>;
}

/**
 * #627 W (the await entry): a question this door hands to the person — what it is, never a way to
 * answer it (no claim token, no tool). Built from the `respond` way minus its `proof`.
 */
export interface McpAwaiting {
  run_id: string;
  gate_id: string;
  step: string;
  choices: string[];
  /** The question's stored deadline, when it has one. */
  expires_at?: string;
}

/** One entry of `next_actions` (a progress way the agent can take) or of `also`. */
export interface McpNextAction {
  instruction: McpInstruction | null;
  /**
   * #627 W: set instead of `instruction` (which is `null`) on an await entry — a question the person
   * answers outside this conversation. Its text says what to tell the user and how to pace.
   */
  awaiting?: McpAwaiting;
  human_readable: string;
  /** Current state orientation — what state the run is in. */
  orientation: string;
  /** The step's declared input schema — use this to structure the params of your execute_step call. */
  input_schema?: Record<string, unknown>;
  /** Template-resolved step prompt, delivered to the agent at step entry. */
  prompt?: string;
}

/** A way the agent may read about but never counts as a next step: reading the run, ending it (A-1). */
export interface McpAlsoEntry extends McpNextAction {
  verb: 'inspect' | 'abandon';
}

/**
 * A way this door cannot enact (D2 §5; the conservation law): its verb, its step, the party that can
 * take it, and why — never a command (P-6: an operator's command is rendered only in the block
 * addressed to the person, and only when the launching door injected an operator route).
 */
export interface McpElsewhereEntry {
  verb: WayVerb;
  step?: string;
  instruction: null;
  for: 'operator';
  reason: 'door_cannot_enact';
  human_readable: string;
}

/**
 * What an MCP tool replies (PR0-CONTRACT §2, Amendment 9): the engine's reply minus the ways — which
 * are rendered — plus the rendered fields. Published as data: `basis`, `outcome`, `races`,
 * `expiry`, `poll_after_ms` and `until` (on an `await` reply), `error.about`, and `error_details`
 * (the code's typed facts where it has them, else the untyped `details`, Amendment 11). Never
 * published: `ways`, `unavailable`, `error.remedy`, `intrinsic_action`, `reply_kind`, `refusal`,
 * `names_next`.
 */
export type McpEnvelope = Omit<
  EngineReply,
  | 'ways'
  | 'unavailable'
  | 'error'
  | 'intrinsic_action'
  | 'reply_kind'
  | 'refusal'
  | 'names_next'
  | 'blocked_reason'
  | 'gate'
> & {
  next_actions: McpNextAction[];
  agent_action?: AgentAction;
  /** issue #729 PR-0 (A-1): reading and ending the run — never counted as a next step. */
  also?: McpAlsoEntry[];
  /** issue #729 PR-0 (D2 §5): ways only an operator can take, with why — never a command. */
  elsewhere?: McpElsewhereEntry[];
  /** issue #729 PR-0 (P-2): on every `await` reply — call get_run_state no sooner than this. */
  poll_after_ms?: number;
  /** issue #729 PR-0 (P-2): on an `await` reply, the deadline the record states for the blocker. */
  until?: string;
  /** issue #729 PR-0 (T-1): the step a stop is about, when not the call's own. */
  error?: { about: string };
  blocked_reason?: { eligible_steps: string[]; suggestion?: string };
  gate?: GateInfo;
  /** #627 W (W-e1): set on the reply Realm held back — repeating the call is never the remedy. */
  retryable?: false;
};

// ─── The host ───────────────────────────────────────────────────────────────────────────────────

/**
 * An operator route a launching program injects (D2 §5, P-6): `realm mcp` and `realm serve` hand the
 * CLI's renderer, so the person block can name the command an operator runs; the standalone
 * `realm-mcp` bin injects none.
 */
export interface OperatorRoute {
  /** Renders an operator's way as the command that enacts it, or `null` when no command does. */
  render: (way: WayOn, basis: Basis | undefined) => string | null;
  source: Source;
}

/** The MCP door's static settings. */
export interface McpHost {
  operatorRoute?: OperatorRoute;
  /**
   * #627 W: this server's gate answers — the effective value with its source, and whether this
   * session's client shows forms. Absent ⇒ the door narrows as PR-0 did (the agent's `respond` kept).
   */
  answers?: DoorAnswers;
  /**
   * #627 W (§5.2b): what this server process has sent for a question (`sent_here`, the come-back
   * count, the asks left) — per gate, never on the run record. Read by `narrowForDoor` to judge
   * `present`, and by the await entry's words.
   */
  formFacts?: (gateId: string) => DoorFormFacts | undefined;
  /**
   * #627 W (correction 1, E4): the run version this call read before it acted, when the tool knows
   * it (a read). W-e1 says "it changed nothing" only when the reply's version is still that one.
   */
  readVersion?: number;
  /**
   * #819 correction 1 (02 W1): set by {@link renderReply} when the reply's own `gate` carries no
   * `display` — a gate with no message whose step has no prompt — so no entry tells the agent to
   * show a field the reply does not have.
   */
  replyGateWithoutDisplay?: true;
}

/** P-2: how long an agent waits before reading the run again, on every `await` reply (a constant). */
export const MCP_POLL_AFTER_MS = 30_000;

/** The MCP door's policy (A-3, A-23, P-10): it serves the agent and the person a question is asked of. */
export function mcpDoorPolicy(host: McpHost): DoorPolicy {
  return {
    door: 'mcp',
    serves: DOOR_SERVES.mcp,
    route: 'mcp',
    source: { kind: 'default', ref: 'the MCP door' },
    ...(host.operatorRoute !== undefined
      ? { operator_route: { renderer: 'cli', source: host.operatorRoute.source } }
      : {}),
    ...(host.answers !== undefined ? { answers: host.answers } : {}),
  };
}

// ─── The words of one way ───────────────────────────────────────────────────────────────────────

/**
 * Where the question's text is, for a reply that carries no `gate` object (decision C125): the
 * opening reply's `gate.display` is the gate's message — else the step's prompt — and of the two,
 * only the message is kept on the record.
 */
const QUESTION_TEXT_WHERE =
  "The question's text, when its gate declares a message, is get_run_state's pending_gate.resolved_message.";

/**
 * The token, for a reply that carries no `gate` object (decision C134): such a reply never carries
 * the claim token (only the opening reply does), so its instruction says who passes one back.
 */
const OPENER_PASSES_TOKEN =
  'The conversation that opened the question passes back the claim_token it was given then, when it was given one.';

/** decision C207: where one advance call stops, said after several owed items. */
const OWED_UNTIL = ' until a step opens a question, fails or ends the run';

const quoteList = (names: readonly string[]): string => names.map((n) => `'${n}'`).join(', ');

/** The owed work of an `advance` way, as every line names it: a due expiry first, then each step. */
function owedItems(way: WayOf<'advance'>): string[] {
  return way.owed.map((o) =>
    'expiry' in o
      ? `the expired question on '${o.expiry.step}' (its declared ${o.expiry.on_expiry})`
      : `'${o.step}'`,
  );
}

/**
 * The MCP door's words for each verb (PR0-CONTRACT §5, Amendment 4): the instruction an agent
 * calls, from the way alone. `register` is an operator's way — on MCP never an instruction (`null`;
 * it is rendered as an elsewhere entry).
 */
export const MCP_WAYS: WayRenderer<McpNextAction, McpHost> = {
  respond: (way) => {
    // A-17: `proof` is the one carrier of a claim's token — passed back as `claim_token`, and only
    // on the reply whose own call opened the question.
    const token = way.proof !== undefined ? { claim_token: way.proof.claim_token } : {};
    const choices = way.choice.one_of;
    const entry: McpNextAction = {
      instruction: {
        tool: 'submit_human_response',
        params: { run_id: way.run_id, gate_id: way.gate_id, ...token },
        call_with: {
          run_id: way.run_id,
          gate_id: way.gate_id,
          choice: `<${choices.join('|')}>`,
          ...token,
        },
      },
      human_readable:
        way.presented === 'with_gate'
          ? `Human review required for step '${way.step}'. Present gate.display to the user, wait for their choice from gate.response_spec.choices, then call submit_human_response${
              way.proof !== undefined
                ? ' with call_with, passing claim_token back unchanged — it shows that this answer comes from the conversation that opened the question.'
                : '.'
            }`
          : `Human review required for step '${way.step}'. Ask the user to choose one of: ${choices.join(', ')}, then call submit_human_response with their choice. ${QUESTION_TEXT_WHERE} ${OPENER_PASSES_TOKEN}`,
      // #729 PR-0 (Part B, W-CENSUS-06): the choices are the way's data; no prose repeats them.
      orientation: `Run is paused at gate '${way.gate_id}'.`,
    };
    // #627 W (F30, §5.2 row 3): on the fallback the client is asked to have the person approve the
    // call (the `client_prompt` condition); the entry says what a refusal leaves (W-g1).
    return way.conditions.some((c) => c.code === 'client_prompt')
      ? { ...entry, human_readable: `${entry.human_readable} ${approvalGuidance(way.step)}` }
      : entry;
  },
  run_step: (way) => {
    const brief = way.brief;
    return {
      // #516: a handler-bearing step's handler is a fact kept as data; until #516 decides its
      // meaning, its entry names the handler as the tool, as before PR-0.
      instruction:
        brief.handler !== undefined
          ? { tool: brief.handler, params: {}, call_with: {} }
          : {
              tool: 'execute_step',
              params: { run_id: way.run_id, command: way.step },
              call_with: {
                run_id: way.run_id,
                command: way.step,
                params:
                  brief.input_schema !== undefined
                    ? generateSchemaSkeleton(brief.input_schema)
                    : {},
              },
            },
      ...(brief.input_schema !== undefined ? { input_schema: brief.input_schema } : {}),
      human_readable: `Execute step '${way.step}': ${brief.description}`,
      orientation: `Run is active. Next step ready: '${way.step}'.`,
      ...(brief.prompt !== undefined ? { prompt: brief.prompt } : {}),
    };
  },
  advance: (way) => {
    const items = owedItems(way);
    const expiry = way.owed.find((o) => 'expiry' in o);
    const instruction: McpInstruction = {
      tool: 'advance_run',
      params: { run_id: way.run_id },
      call_with: { run_id: way.run_id },
    };
    if (expiry !== undefined) {
      const words = items[0]!;
      return {
        instruction,
        human_readable: `Call advance_run to carry out ${words}, then run what it leaves owed${OWED_UNTIL}. It runs with this server's extensions and environment.`,
        orientation: `Run is active. Engine work is owed: ${words}.`,
      };
    }
    const one = items.length === 1;
    return {
      instruction,
      human_readable: `Call advance_run to run ${one ? 'the step' : 'the steps'} the engine owes: ${items.join(', ')}. It runs ${one ? 'it' : 'them'} with this server's extensions and environment${one ? '' : OWED_UNTIL}.`,
      orientation: `Run is active. Engine work is owed: ${items.join(', ')}.`,
    };
  },
  inspect: (way) => ({
    instruction: {
      tool: 'get_run_state',
      params: { run_id: way.run_id },
      call_with: { run_id: way.run_id },
    },
    human_readable: `Read the run's record: call get_run_state with run_id '${way.run_id}'.`,
    orientation: 'Reading the run changes nothing.',
  }),
  abandon: (way) => ({
    instruction: {
      tool: 'abandon_run',
      params: { run_id: way.run_id },
      call_with: { run_id: way.run_id, reason: '<why the run ends>' },
    },
    human_readable: `End the run: call abandon_run with run_id '${way.run_id}' — only when the user asks to end it.`,
    orientation: 'Ending the run is final.',
  }),
  // An operator's way: never an agent's instruction on this door (A-10; an elsewhere entry).
  register: () => null,
  // #627 W (§5.2b): show the waiting question again, as a form in the user's app — offered only on
  // the `asked`-with-forms row (`narrowForDoor`'s door verdict). Its words are the tool's own (W-q1).
  present: (way) => ({
    instruction: {
      tool: 'present_question',
      params: { run_id: way.run_id, gate_id: way.gate_id },
      call_with: { run_id: way.run_id, gate_id: way.gate_id },
    },
    human_readable: PRESENT_QUESTION_DESCRIPTION,
    orientation: `Run is paused at gate '${way.gate_id}'.`,
  }),
};

/** #627 W (W-q1): `present_question`'s description, and the words of its call entry. */
export const PRESENT_QUESTION_DESCRIPTION =
  "Send the waiting question to the user's app as a form. Call it when the question has not been sent in this session yet, or when the user asks to see it again. You cannot answer the question yourself.";

/**
 * #627 W (W-g1): the approval prompt's guidance on the fallback — the client may ask the person to
 * approve the answer call, and a refused call leaves the run waiting.
 */
export function approvalGuidance(step: string): string {
  return `Your client may ask the user to approve this call (Claude Code does in interactive sessions and refuses it in headless runs; other clients may not ask). If the call is refused, the run keeps waiting at step '${step}': tell the user so.`;
}

/** #627 W (W-a3): the orientation of a question answered outside this conversation. */
function handedOffOrientation(way: Pick<RespondWay, 'gate_id' | 'step'>): string {
  return `Run is paused at gate '${way.gate_id}' on step '${way.step}', waiting for an answer outside this conversation.`;
}

/** #627 W: the await entry's pacing clause; its time clause iff the question has a deadline (cell 15). */
function pacingClause(way: Pick<RespondWay, 'expires_at'>): string {
  return `Check again no sooner than poll_after_ms${way.expires_at !== undefined ? '; when until passes, tell the user' : ''}.`;
}

/** `1 time`, `2 times`. */
const times = (n: number): string => `${n} ${n === 1 ? 'time' : 'times'}`;

/**
 * #627 W: the await entry — a question this door hands to the person (its `respond` serves the asked
 * person, never the agent). Under `asked` with forms it says what this server SENT (W-a1f, from the
 * door's facts, never what the person saw); under `withheld`, W-a1 on a reply that carries the
 * question's `gate`, else W-a2. No text names a tool that answers, or a person; no claim token.
 */
function awaitEntryOf(way: RespondWay, host: McpHost): McpNextAction {
  const awaiting: McpAwaiting = {
    run_id: way.run_id,
    gate_id: way.gate_id,
    step: way.step,
    choices: [...way.choice.one_of],
    ...(way.expires_at !== undefined ? { expires_at: way.expires_at } : {}),
  };
  const pacing = pacingClause(way);
  let words: string;
  if (answersRowOf(host.answers) === 'asked_forms') {
    const facts = host.formFacts?.(way.gate_id);
    const sent = facts?.sent_here ?? 'never';
    if (sent === 'never') {
      words = `The question on step '${way.step}' of run ${way.run_id} has not been sent to the user in this session. Call present_question to send it to their app as a form. An answer given in this chat is not recorded.`;
    } else if (sent === 'open') {
      words = `A form for the question on step '${way.step}' of run ${way.run_id} was sent to the user's app, and Realm is waiting for the answer. It may not be on their screen. An answer given in this chat is not recorded.`;
    } else {
      const left = facts?.asks_left ?? 0;
      const again =
        left > 0
          ? ` If the user wants to answer, call present_question (${left} left in this session).`
          : '';
      words = `The form for step '${way.step}' of run ${way.run_id} ended without an answer ${times(facts?.came_back ?? 0)}.${again} An answer given in this chat is not recorded.`;
    }
  } else {
    // #819 (T1): where the question's text is, by whether the gate declares a message — never "where
    // they answer it", which Slack and `realm agent` do not show; no answer way is named (K1).
    // #819 correction 1: (02 W1) a reply whose gate carries no display is told what has no text;
    // (W2) the words say what the record holds, not what the definition declares.
    const show =
      way.presented === 'with_gate' && host.replyGateWithoutDisplay !== true
        ? 'Show the user gate.display and tell them it is waiting for their answer'
        : way.has_message === true
          ? "Show the user the question: get_run_state's pending_gate.resolved_message, and tell them it is waiting for their answer outside this conversation"
          : `get_run_state carries no question text for this gate: tell the user the run is waiting at step '${way.step}' for their answer, outside this conversation`;
    // #819 (T2): the start line's "the agent tells the user the run id" is asked for here; #819
    // correction 1 (02 W3): a Slack thread's answer needs no run id — a terminal's does. #819
    // follow-up 2 (reader B's M2): "may", and no place named (K1: no text naming an answer way).
    words = `The question on step '${way.step}' of run ${way.run_id} is answered outside this conversation. ${show}; an answer they give here is not recorded. Give the user this run id (${way.run_id}); they may need it to answer.`;
  }
  return {
    instruction: null,
    awaiting,
    human_readable: `${words} ${pacing}`,
    orientation: handedOffOrientation(way),
  };
}

/** One way, by its verb's renderer. */
function renderWay(way: WayOn, basis: Basis | undefined, host: McpHost): McpNextAction | null {
  const render = MCP_WAYS[way.verb] as (
    w: WayOn,
    b: Basis | undefined,
    h: McpHost,
  ) => McpNextAction | null;
  return render(way, basis, host);
}

/** The words of an elsewhere entry: the operator's way and why this door cannot enact it. */
function elsewhereWords(entry: Unavailable, host: McpHost): string {
  const way = entry.remedy[0];
  if (way?.verb === 'register') return registerWords(way, host);
  if (way?.verb === 'run_step') {
    // PR0-CONTRACT Amendment 14 (Q12): a fact, never a schedule.
    return `'${way.step}' takes its input from an operator, checked against its input_schema; no realm command supplies it.`;
  }
  return `An operator can take this way (${entry.verb}), outside this conversation.`;
}

/**
 * Correction 2 (3.1, 3.2): a `register` way's words — the operator's repair, outside this
 * conversation. A copy that cannot be used is named as such, never as a file to register from. On a
 * door that hands questions to the person, the question then waits for an answer outside this
 * conversation too.
 */
function registerWords(way: RegisterWay, host: McpHost): string {
  const repair =
    way.path !== undefined
      ? `Workflow '${way.workflow_id}''s registered copy (${way.path}) cannot be used; an operator repairs it, outside this conversation.`
      : `An operator registers workflow '${way.workflow_id}' again, outside this conversation.`;
  if (!doorWithholdsAnswers(mcpDoorPolicy(host))) return repair;
  return way.path !== undefined
    ? `${repair} Once the copy is repaired, the question waits for an answer outside this conversation.`
    : `${repair} Once it is registered, the question waits for an answer outside this conversation.`;
}

// ─── The lists a reply renders ──────────────────────────────────────────────────────────────────

const isProgress = (w: ForWay): w is ForWay & { verb: ProgressVerb } =>
  (PROGRESS_VERBS as readonly string[]).includes(w.verb);
const forAgent = (w: ForWay): boolean => w.for.includes('agent');

/** The progress ways this door serves the agent, in `next_actions` order: steps, the answer, the act. */
function agentProgressWays(narrowed: Narrowed | undefined): ForWay[] {
  const ways = (narrowed?.ways ?? []).filter((w) => isProgress(w) && forAgent(w));
  const rank = (w: ForWay): number => (w.verb === 'run_step' ? 0 : w.verb === 'respond' ? 1 : 2);
  return [...ways].sort((a, b) => rank(a) - rank(b));
}

/**
 * #627 W: the questions this door hands to the person — a `respond` whose `for` holds the asked
 * person and not the agent (§5.2's rows 2 and 4). Each renders as an await entry.
 */
function handedOffWays(narrowed: Narrowed | undefined): (ForWay & RespondWay)[] {
  return (narrowed?.ways ?? []).filter(
    (w): w is ForWay & RespondWay =>
      w.verb === 'respond' && !forAgent(w) && w.for.includes('asked_person'),
  );
}

/** #627 W: the `present` ways the door offers the agent (only on the `asked`-with-forms row). */
function presentWays(narrowed: Narrowed | undefined): ForWay[] {
  return (narrowed?.ways ?? []).filter((w) => w.verb === 'present' && forAgent(w));
}

/**
 * `next_actions`: the agent's progress entries in their order — steps, the answer, the act — with
 * #627 W's await entry (a handed-off question) in the answer's place and its `present_question`
 * entry right after it.
 */
function nextActionsOf(
  narrowed: Narrowed | undefined,
  basis: Basis | undefined,
  host: McpHost,
): McpNextAction[] {
  const progress = agentProgressWays(narrowed);
  const entries: { rank: number; entry: McpNextAction | null }[] = [
    ...progress.map((w) => ({
      rank: w.verb === 'run_step' ? 0 : w.verb === 'respond' ? 1 : 3,
      entry: renderWay(w, basis, host),
    })),
    ...handedOffWays(narrowed).map((w) => ({ rank: 1, entry: awaitEntryOf(w, host) })),
    ...presentWays(narrowed).map((w) => ({ rank: 2, entry: renderWay(w, basis, host) })),
  ];
  return entries
    .sort((a, b) => a.rank - b.rank)
    .map((e) => e.entry)
    .filter((e): e is McpNextAction => e !== null);
}

/** The narrowed ways of a reply, or none when it judged none. */
function narrowReply(reply: EngineReply, host: McpHost): Narrowed | undefined {
  if (reply.basis === undefined) return undefined;
  return narrowForDoor(
    { ways: reply.ways, unavailable: reply.unavailable, basis: reply.basis },
    mcpDoorPolicy(host),
    host.formFacts,
  );
}

/** What the door rendered, as D-8 reads it (A-2 rows 4–6; T-22's tail) — core's one reading. */
function renderedListOf(
  reply: EngineReply,
  narrowed: Narrowed | undefined,
  _progress: readonly ForWay[],
): RenderedList {
  // The run has ended when the reply says so, or when its ways do (every verb listed `run_ended`) —
  // a read (`get_run_state`) renders ways with no reply phase of its own.
  const ended =
    (reply.run_phase !== undefined && TERMINAL_PHASES.has(reply.run_phase)) ||
    reply.unavailable.some((u) => u.code === 'run_ended');
  return agentRenderedList(narrowed ?? { ways: [], unavailable: [] }, ended);
}

/**
 * P-2: the deadline the record states for what an `await` waits on (the earliest), if any — a step
 * held elsewhere, and (#627 W) a question handed to the person, by its stored deadline.
 */
function untilOf(narrowed: Narrowed | undefined): string | undefined {
  const stated = [
    ...(narrowed?.unavailable ?? [])
      .filter((u) => u.code === 'held_elsewhere' && u.clears_at !== undefined)
      .map((u) => u.clears_at!),
    ...handedOffWays(narrowed)
      .filter((w) => w.expires_at !== undefined)
      .map((w) => w.expires_at!),
  ].sort();
  return stated[0];
}

// ─── The words of what comes next (Table rows 20–29; decisions C34, C51, C57, C94, C205) ────────

/** A run_step entry for a step that cannot run (C82): refused before its claim, or a capability. */
function cannotRunEntries(narrowed: Narrowed | undefined): Unavailable[] {
  return (narrowed?.unavailable ?? []).filter(
    (u) =>
      u.verb === 'run_step' &&
      (u.code === 'refused_before_claim' || u.code === 'capability_missing'),
  );
}

/** `'<s>' cannot run (<check>): <refusal>` — one step that cannot run (C36, C41, C53). */
function cannotRunClause(entry: Unavailable): string {
  if (entry.code === 'capability_missing') {
    const { kind, name } = entry.facts.requirement;
    return entry.facts.basis === 'marker'
      ? `'${entry.facts.step}' could not run (capability): ${kind} '${name}' was not registered in the runner that last attempted it`
      : `'${entry.facts.step}' cannot run here (capability): ${kind} '${name}' is not registered here — load the missing extension, or run the step on a runner that has it`;
  }
  if (entry.code === 'refused_before_claim') {
    return `'${entry.facts.step}' cannot run (${entry.facts.check}): ${entry.facts.refusal}`;
  }
  return `'${entry.step ?? ''}' cannot run`;
}

/**
 * One refused step's own way out (F15, T-13, T-20 (v)), from its entry: a trust or precondition
 * refusal is corrected in the workflow; an input refusal is corrected in its schema (or its map),
 * and — when a run with other params could change the input — a new run with params that fit,
 * naming the param the map reads.
 */
function refusedStepWay(entry: Unavailable & { code: 'refused_before_claim' }): string {
  if (entry.facts.check !== 'input_schema') return 'correct the workflow and register it again';
  const start =
    entry.no_remedy?.cause === 'operator_command_untyped' && entry.no_remedy.command === 'start';
  const param = entry.facts.param !== undefined ? ` (its param '${entry.facts.param}')` : '';
  const lever = entry.remedy.some((w) => w.verb === 'run_step');
  if (!lever) {
    // the step consumes its input_map (#688): no caller input reaches it.
    return `${start ? `start a run with params that fit${param}, or ` : ''}correct its input_map or its input_schema and register the workflow again`;
  }
  return start
    ? `start a run with params that fit${param}, or correct its input_schema and register the workflow again`
    : 'the engine gives it no input, so correct its input_schema and register the workflow again';
}

/** When the run cannot go on until its workflow is corrected (C44, C51, C82): core's one predicate. */
function cannotGoOnWithRefusal(narrowed: Narrowed | undefined, ended: boolean): boolean {
  return !ended && narrowed !== undefined && cannotGoOnUntilCorrected(narrowed);
}

/**
 * The way out for a caller that speaks the tools (C51, C57): each refused step's own way, then the
 * run's. T-20 (i): when a way is a new run with params that fit, the run's way says that THIS run
 * stays open — advanced after a fix — or how to end it ("then, after a fix, call advance_run" read
 * as if it applied to the old run); otherwise the words are as before.
 */
function wayOutWords(narrowed: Narrowed): string {
  const refused = cannotRunEntries(narrowed).filter(
    (u): u is Unavailable & { code: 'refused_before_claim' } => u.code === 'refused_before_claim',
  );
  if (refused.every((u) => u.facts.check !== 'input_schema')) {
    return 'Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.';
  }
  const ways = refused.map((u) => `for '${u.facts.step}', ${refusedStepWay(u)}`).join('; ');
  const newRun = refused.some(
    (u) => u.no_remedy?.cause === 'operator_command_untyped' && u.no_remedy.command === 'start',
  );
  const run = newRun
    ? 'this run stays open — after a fix, call advance_run on it; or end it with abandon_run.'
    : 'then, after a fix, call advance_run; or end the run with abandon_run.';
  return `${ways.charAt(0).toUpperCase()}${ways.slice(1)}; ${run}`;
}

/**
 * The sentence of what comes next (decisions C34, C82, C103, C205, C207, C211): the open question
 * and the steps it holds, the agent's steps, the engine's owed work, each step that cannot run, and
 * — when the run cannot go on until its workflow is corrected — the way out; else, a step in flight
 * elsewhere (wait, then read the run), or that no step is ready.
 */
function nextSentence(narrowed: Narrowed | undefined, ended: boolean): string {
  const progress = agentProgressWays(narrowed);
  let sentence = '';
  const respond = progress.find((w): w is ForWay & WayOf<'respond'> => w.verb === 'respond');
  if (respond !== undefined) {
    const waiting = respond.holds;
    const waitingWords =
      waiting.length === 0
        ? ''
        : `; ${quoteList(waiting)} ${waiting.length === 1 ? 'waits' : 'wait'} for its answer`;
    sentence += ` Waiting on the question on step '${respond.step}' (choices: ${respond.choice.one_of.join(', ')}) — answer it with submit_human_response${waitingWords}.`;
  }
  // #627 W: a question handed to the person is waited on, never answered here (W-a3's words).
  const handedOff = respond === undefined ? handedOffWays(narrowed)[0] : undefined;
  if (handedOff !== undefined) sentence += ` ${handedOffOrientation(handedOff)}`;
  const steps = progress.filter((w): w is ForWay & WayOf<'run_step'> => w.verb === 'run_step');
  if (steps.length > 0) sentence += ` Ready for the agent: ${quoteList(steps.map((w) => w.step))}.`;
  const advance = progress.find((w): w is ForWay & WayOf<'advance'> => w.verb === 'advance');
  if (advance !== undefined) {
    const items = owedItems(advance);
    const expiry = advance.owed.find(
      (o): o is { expiry: { on_expiry: string } } & typeof o => 'expiry' in o,
    );
    const runs =
      expiry !== undefined
        ? 'expiry' in expiry && expiry.expiry.on_expiry === 'settle_default'
          ? `; then it runs what that leaves owed${OWED_UNTIL}`
          : ''
        : items.length === 1
          ? ''
          : `; it runs them${OWED_UNTIL}`;
    sentence += ` Owed to the engine: ${items.join(', ')} — call advance_run${runs}.`;
  }
  for (const entry of cannotRunEntries(narrowed))
    sentence += ` ${withFullStop(cannotRunClause(entry))}`;
  if (cannotGoOnWithRefusal(narrowed, ended) && narrowed !== undefined) {
    sentence += ` ${wayOutWords(narrowed)}`;
  }
  if (sentence.length > 0) return sentence;
  const held = (narrowed?.unavailable ?? [])
    .filter((u) => u.verb === 'run_step' && u.code === 'held_elsewhere')
    .map((u) => u.step!);
  if (held.length > 0) {
    const one = held.length === 1;
    return ` No step is ready: ${quoteList(held)} ${one ? 'is' : 'are'} in flight elsewhere — wait for ${one ? 'it' : 'them'}, then call get_run_state.`;
  }
  return ' No step is ready.';
}

/**
 * The way clause of a by-name refusal whose reason names a question (C104), joined to core's reason
 * inside its sentence as before PR-0 (`… — answer it with submit_human_response.`); empty for every
 * other reason (what comes next follows as the next sentence).
 */
function withRefusalWayClause(
  hint: string,
  refusal: Unavailable,
  narrowed: Narrowed | undefined,
): string {
  // Amendment 16: a clause names the chain's END only when the agent can call it — never a way the
  // reply lists as unavailable (guardrail 7: the claim never exceeds its guard).
  const clause =
    (refusal.code === 'gated_step' || refusal.code === 'question_open') &&
    callableForAgent(narrowed, 'respond')
      ? ' — answer it with submit_human_response'
      : refusal.code === 'question_due' && callableForAgent(narrowed, 'advance')
        ? ' — call advance_run to carry it out'
        : '';
  return clause !== '' && hint.endsWith('.') ? `${hint.slice(0, -1)}${clause}.` : hint;
}

/** Whether the door rendered a way of this verb callable by the agent. */
function callableForAgent(narrowed: Narrowed | undefined, verb: ProgressVerb): boolean {
  return (narrowed?.ways ?? []).some((w) => w.verb === verb && w.for.includes('agent'));
}

/** The tail of an answer refused for its gate id (C118): the open question, or its due expiry. */
function gateMismatchTail(refusal: Unavailable, narrowed: Narrowed | undefined): string {
  const open = refusal.code === 'gate_not_open' ? refusal.facts.open_gate : undefined;
  if (open === undefined) return ' No question is open on this run.';
  const due = (narrowed?.unavailable ?? []).find(
    (u): u is Unavailable & { code: 'question_due' } =>
      u.verb === 'respond' && u.code === 'question_due',
  );
  if (due !== undefined) {
    // Amendment 16: advance is named only when the agent can call it (a failed load lists it).
    const act = callableForAgent(narrowed, 'advance')
      ? ` — call advance_run to carry out its declared ${due.facts.on_expiry}`
      : '';
    return ` The question on step '${due.facts.step}' (gate '${due.facts.gate_id}') can no longer be answered: its time is up${act}.`;
  }
  const answer = callableForAgent(narrowed, 'respond') ? ' — answer it as next_actions says' : '';
  return ` The open question is on step '${open.step}' (gate '${open.gate_id}')${answer}.`;
}

/**
 * The sentence an error's remedy adds (an answer, reading the run, the act). #627 W: a `respond`
 * remedy is narrowed by the door's one predicate — where the door hands questions to the person, it
 * is waited on (W-a3), never answered with a tool.
 */
function remedyWords(remedy: readonly WayOn[], replyRunId: string, host: McpHost): string {
  const handedOff = doorWithholdsAnswers(mcpDoorPolicy(host));
  return remedy
    .map((way) => {
      switch (way.verb) {
        case 'respond':
          return handedOff
            ? ` ${handedOffOrientation(way)}`
            : ` Answer it: submit_human_response {run_id: '${way.run_id}', gate_id: '${way.gate_id}', choice: <one of: ${way.choice.one_of.join(', ')}>}.`;
        case 'advance':
          return ` Call advance_run with run_id '${way.run_id}'.`;
        case 'inspect':
          return way.run_id === replyRunId ? '' : ` Read run '${way.run_id}' with get_run_state.`;
        case 'register':
          return ` ${registerWords(way, host)}`;
        default:
          return '';
      }
    })
    .join('');
}

/** The reply's `context_hint`: what happened (core's), then the door's words of what comes next. */
function hintOf(
  reply: EngineReply,
  narrowed: Narrowed | undefined,
  ended: boolean,
  host: McpHost,
): string {
  let hint = reply.context_hint;
  const refusal = reply.refusal;
  if (refusal !== undefined && refusal.code === 'gate_not_open') {
    return hint + gateMismatchTail(refusal, narrowed);
  }
  if (refusal !== undefined && reply.status === 'blocked' && reply.names_next === true) {
    // decision C104: the refusal's own way, then — unless the run ended or a question is open —
    // what comes next, without repeating "No step is ready".
    hint = withRefusalWayClause(hint, refusal, narrowed);
    const question =
      (narrowed?.ways ?? []).some((w) => w.verb === 'respond') ||
      (narrowed?.unavailable ?? []).some((u) => u.verb === 'respond');
    const tail = ended || question ? '' : nextSentence(narrowed, ended);
    return tail.startsWith(' No step is ready') ? hint : hint + tail;
  }
  if (
    refusal !== undefined &&
    refusal.code === 'refused_before_claim' &&
    refusal.step === reply.command &&
    cannotGoOnWithRefusal(narrowed, ended) &&
    narrowed !== undefined
  ) {
    // C66, #688: a by-name refusal the caller cannot change ends with the person's way out. #729 Q3
    // correction 1 (the architect's ruling, Amendment 16's chain law): an input refusal's own
    // `run_step` lever would withhold it only when THIS caller may take that lever. At this door it
    // never may: the operator's lever rides `elsewhere`, never the agent's ways, so no input refusal
    // withholds the way out here and the assistant is always told the end of the chain. (#729 PR-3
    // ride-along: the sub-clause that tested for an agent-side lever could never hold, and is gone.)
    hint += ` ${wayOutWords(narrowed)}`;
  }
  if (reply.names_next === true) {
    const next = ended
      ? ` Call get_run_state with run_id '${reply.run_id}' to retrieve the full evidence record.`
      : nextSentence(narrowed, ended);
    // decision C25: a loop's race clauses end the hint, after what comes next — as before PR-0.
    const races = raceClausesOf(reply.races ?? []);
    hint =
      races !== '' && hint.endsWith(races)
        ? `${hint.slice(0, hint.length - races.length)}${next}${races}`
        : hint + next;
  }
  if (reply.status === 'error' && refusal === undefined && reply.error !== undefined) {
    hint += remedyWords(reply.error.remedy, reply.run_id, host);
  }
  // issue #729 (the Q3 unit, C1; R3): a step this program lacks the code for failed at its dispatch —
  // core says what is so (blocked, not terminated); the way out is this door's, in its one producer
  // of the capability words (the words `advance_run`'s reply prints for the same step).
  if (reply.status === 'error' && reply.stopped_step !== undefined) {
    const blocked = reply.unavailable.find(
      (u) =>
        u.verb === 'run_step' && u.step === reply.stopped_step && u.code === 'capability_missing',
    );
    if (blocked !== undefined) hint += ` ${cannotRunClause(blocked)}.`;
  }
  return hint;
}

/** `blocked_reason.suggestion` (C94, C104, C136, C149), from the refusal and the rendered list. */
function suggestionOf(
  reply: EngineReply,
  progress: readonly ForWay[],
  narrowed: Narrowed | undefined,
): string {
  const refusal = reply.refusal;
  if (refusal?.code === 'refused_before_claim' && refusal.facts.precondition !== undefined) {
    // E1 (b): the value read, through the one escaped, bounded value renderer.
    const p = refusal.facts.precondition;
    return `Precondition failed: '${p.expression}'. Resolved value: ${p.value}.`;
  }
  if (reply.error_code === 'STATE_STEP_ALREADY_CLAIMED') {
    return 'Step is already in progress. Wait for it to complete.';
  }
  const handedOff = handedOffWays(narrowed)[0];
  if (progress.length === 0 && handedOff !== undefined && presentWays(narrowed).length === 0) {
    // #627 W (W-a5): only the await entry remains.
    return `Nothing can be called now: the question on step '${handedOff.step}' is answered outside this conversation, as next_actions says.`;
  }
  if (progress.length === 0) return 'No other step can be called now.';
  if (progress.some((w) => w.verb === 'respond')) {
    return 'Answer the open question first, as next_actions says.';
  }
  const steps = progress.some((w) => w.verb === 'run_step');
  if (!steps) return 'Call advance_run, as next_actions says.';
  if (progress.some((w) => w.verb === 'advance')) {
    return 'Call one of the steps indicated in next_actions, or advance_run, instead.';
  }
  return 'Call one of the steps indicated in next_actions instead.';
}

/** The wire's `error_details` (Amendments 9, 11): the code's typed facts where it has them, else `details`. */
function errorDetailsOf(reply: EngineReply): Record<string, unknown> | undefined {
  if (reply.error?.facts !== undefined)
    return reply.error.facts as unknown as Record<string, unknown>;
  return reply.error_details;
}

// ─── The one composition ────────────────────────────────────────────────────────────────────────

/** What `renderReply` returns: the envelope, and the block addressed to the person, when there is one. */
export interface RenderedReply {
  envelope: McpEnvelope;
  /** P-6: the text of the content block addressed to the person (`audience: ["user"]`). */
  person?: string;
}

/**
 * The MCP door's ONE composition of a reply (PR0-CONTRACT §5): `next_actions` from the progress ways
 * whose `for` holds the agent; `also` (reading, ending the run); `elsewhere` entries for the ways
 * this door cannot enact; `agent_action` by core's ordered table (D-8); `poll_after_ms`/`until` on an
 * `await` reply (P-2); `blocked_reason.suggestion` and the way sentence from the rendered list; and
 * the person block with an operator's commands, only when the launching door injected an operator
 * route (P-6). One egress assertion at the exit: no claim token outside the opening reply's answer.
 */
export function renderReply(reply: EngineReply, hostIn: McpHost): RenderedReply {
  // #819 correction 1 (02 W1): whether the reply's own question has text to show
  const host: McpHost =
    reply.gate !== undefined && reply.gate.display === undefined
      ? { ...hostIn, replyGateWithoutDisplay: true }
      : hostIn;
  const narrowed = narrowReply(reply, host);
  const progress = agentProgressWays(narrowed);
  const next_actions = nextActionsOf(narrowed, reply.basis, host);
  // #627 W: an await entry is paced wherever it renders — on a `confirm_required` reply too, whose
  // `agent_action` D-8 leaves unset (its text tells the agent to wait poll_after_ms).
  const awaits = handedOffWays(narrowed).length > 0;
  const also = (narrowed?.ways ?? [])
    .filter((w) => (w.verb === 'inspect' || w.verb === 'abandon') && forAgent(w))
    .map((w) => ({ verb: w.verb as 'inspect' | 'abandon', ...renderWay(w, reply.basis, host)! }));
  const elsewhereEntries = (narrowed?.unavailable ?? []).filter(
    (u) => u.code === 'door_cannot_enact',
  );
  const elsewhere: McpElsewhereEntry[] = elsewhereEntries.map((u) => ({
    verb: u.verb,
    ...(u.step !== undefined ? { step: u.step } : {}),
    instruction: null,
    for: 'operator',
    reason: 'door_cannot_enact',
    human_readable: elsewhereWords(u, host),
  }));
  const ended = reply.run_phase !== undefined && TERMINAL_PHASES.has(reply.run_phase);
  const rendered = renderedListOf(reply, narrowed, progress);
  const agentAction = agentActionOf(reply.intrinsic_action, reply.reply_kind, rendered);
  const paced = agentAction === 'await' || awaits;
  const until = paced ? untilOf(narrowed) : undefined;
  const details = errorDetailsOf(reply);
  const {
    ways: _ways,
    unavailable: _unavailable,
    error,
    intrinsic_action: _intrinsic,
    reply_kind: _kind,
    refusal: _refusal,
    names_next: _next,
    blocked_reason,
    error_details: _details,
    gate,
    ...rest
  } = reply;
  const envelope: McpEnvelope = {
    ...rest,
    ...(details !== undefined ? { error_details: details } : {}),
    ...(agentAction !== undefined ? { agent_action: agentAction } : {}),
    context_hint: hintOf(reply, narrowed, ended, host),
    next_actions,
    ...(also.length > 0 ? { also } : {}),
    ...(elsewhere.length > 0 ? { elsewhere } : {}),
    ...(paced ? { poll_after_ms: MCP_POLL_AFTER_MS } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(error?.about !== undefined ? { error: { about: error.about } } : {}),
    ...(blocked_reason !== undefined
      ? {
          blocked_reason: {
            eligible_steps: blocked_reason.eligible_steps,
            suggestion: suggestionOf(reply, progress, narrowed),
          },
        }
      : {}),
    ...(gate !== undefined ? { gate: withAuthorLabel(gate) } : {}),
  };
  if (tokenStrayed(envelope, narrowed)) return heldBackReply(reply, host);
  const person = personBlockOf(elsewhereEntries, reply.basis, host);
  return { envelope, ...(person !== undefined ? { person } : {}) };
}

/**
 * #627 W (F31, W-t1): the gate's `agent_hint` is the workflow author's text (the gated step's
 * `instructions`), forwarded marked as the author's under every answers value.
 */
function withAuthorLabel(gate: GateInfo): GateInfo {
  return gate.agent_hint !== undefined
    ? { ...gate, agent_hint: `${AUTHOR_TEXT_LABEL} ${gate.agent_hint}` }
    : gate;
}

/**
 * #627 W (W-e1, W-e2): the reply Realm returns in place of one that would have carried a claim token
 * it never sends — the egress assertion's outcome, no longer a throw. It says whether the call wrote
 * only where the reply shows it: a `respond` way with `proof` is carried only by the reply whose own
 * call opened the question (a write, at `run_version`); otherwise it claims neither. The log line
 * names the tool and the run, never the token.
 */
function heldBackReply(reply: EngineReply, host: McpHost): RenderedReply {
  const opened = reply.ways.some((w) => w.verb === 'respond' && w.proof !== undefined);
  // Correction 1 (E4): W-e1's two arms — the opening reply's write, or a read whose version is
  // unchanged; otherwise neither is claimed.
  const wrote = opened
    ? ` and changed the run (version ${reply.run_version})`
    : host.readVersion !== undefined && host.readVersion === reply.run_version
      ? '; it changed nothing'
      : '';
  // Correction 1 (E4): the clause by row — "a question this session cannot answer" only where the
  // door withholds answers; elsewhere the token strayed outside the opening reply's answer.
  const withholds = doorWithholdsAnswers(mcpDoorPolicy(host));
  const where = withholds
    ? 'for a question this session cannot answer, which this server never sends'
    : 'outside the answer instruction of the reply that opened the question';
  console.error(
    `realm: held back a ${reply.command} reply for run ${reply.run_id}: it carried a claim_token ${withholds ? 'on a handed-off question' : 'outside the answer instruction of the reply that opened the question'}. This is a bug in Realm or in the program embedding it; please report it with this line.`,
  );
  return {
    envelope: {
      command: reply.command,
      run_id: reply.run_id,
      run_version: reply.run_version,
      status: 'error',
      data: {},
      evidence: [],
      warnings: [],
      errors: [],
      error_code: 'ENGINE_INTERNAL',
      agent_action: 'report_to_user',
      retryable: false,
      context_hint: `Realm held back this reply: it carried a claim token ${where}. The call itself ran${wrote}. This is a fault in Realm or in the program that embeds it, and it was logged. Do not repeat this call: tell the user, and call get_run_state to see where the run stands.`,
      next_actions: [],
    },
  };
}

/**
 * P-6: the block addressed to the person — each operator way with the command that enacts it, from
 * the injected operator route. None without a route, and none when no way has a command.
 */
function personBlockOf(
  entries: readonly Unavailable[],
  basis: Basis | undefined,
  host: McpHost,
): string | undefined {
  const route = host.operatorRoute;
  if (route === undefined) return undefined;
  const lines = entries
    .map((u) => {
      const way = u.remedy[0];
      if (way === undefined || !WAY_PARTIES[way.verb].includes('operator')) return undefined;
      const command = route.render(way, basis);
      return command === null
        ? undefined
        : `${elsewhereWords(u, host)} The operator's command: ${command}`;
    })
    .filter((line): line is string => line !== undefined);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * A-17's egress assertion, as it checks: a claim token is never in the gate object, never on an
 * `also` entry, and — on a reply whose own call did not open the question for the agent — never on
 * any `next_actions` entry. On the opening reply (a `respond` way with its `proof`, for the agent) it
 * does not check which `next_actions` entry carries the token (correction 2, 8.6 (b)). The opening
 * reply is read from the NARROWED ways: on a row that hands the question to the person (#627 W) the
 * agent has no `respond`, so there is no opening reply and any carrier strays (W's guard). True when
 * a token strayed; the reply is then held back (W-e1).
 *
 * Correction 1 (E5): the two carriers W had added beside PR-0's are gone — an await entry never
 * copies `proof` (`awaitEntryOf`), and only a `respond` way carries one, so neither could fire.
 * Exported for the cell that pins the narrowed opening on a constructed envelope.
 */
export function tokenStrayed(envelope: McpEnvelope, narrowed: Narrowed | undefined): boolean {
  const opening = (narrowed?.ways ?? []).some(
    (w) => w.verb === 'respond' && w.proof !== undefined && forAgent(w),
  );
  const carries = (a: McpNextAction): boolean =>
    a.instruction !== null && 'claim_token' in a.instruction.params;
  const carriers = envelope.next_actions.filter(carries);
  return (
    (envelope.gate !== undefined && 'claim_token' in (envelope.gate as object)) ||
    (envelope.also ?? []).some(carries) ||
    (!opening && carriers.length > 0)
  );
}

// ─── Replies that are not an engine reply ───────────────────────────────────────────────────────

/** The rendered `next_actions`, `also` and `elsewhere` of one composition, for a view that is not a reply. */
export function renderWaysOf(
  composed: Pick<EngineReply, 'ways' | 'unavailable' | 'basis'>,
  host: McpHost,
): {
  narrowed: Narrowed | undefined;
  next_actions: McpNextAction[];
  also: McpAlsoEntry[];
  elsewhere: McpElsewhereEntry[];
  rendered: RenderedList;
  until?: string;
  person?: string;
  next_sentence: string;
} {
  const reply = {
    ...composed,
    command: 'get_run_state',
    run_id: '',
    run_version: 0,
    status: 'ok',
    reply_kind: 'ok',
    data: {},
    evidence: [],
    warnings: [],
    errors: [],
    context_hint: '',
  } as EngineReply;
  const narrowed = narrowReply(reply, host);
  const progress = agentProgressWays(narrowed);
  const next_actions = nextActionsOf(narrowed, composed.basis, host);
  const also = (narrowed?.ways ?? [])
    .filter((w) => (w.verb === 'inspect' || w.verb === 'abandon') && forAgent(w))
    .map((w) => ({
      verb: w.verb as 'inspect' | 'abandon',
      ...renderWay(w, composed.basis, host)!,
    }));
  const elsewhereEntries = (narrowed?.unavailable ?? []).filter(
    (u) => u.code === 'door_cannot_enact',
  );
  const elsewhere: McpElsewhereEntry[] = elsewhereEntries.map((u) => ({
    verb: u.verb,
    ...(u.step !== undefined ? { step: u.step } : {}),
    instruction: null,
    for: 'operator',
    reason: 'door_cannot_enact',
    human_readable: elsewhereWords(u, host),
  }));
  const rendered = renderedListOf(reply, narrowed, progress);
  const until = untilOf(narrowed);
  const person = personBlockOf(elsewhereEntries, composed.basis, host);
  return {
    narrowed,
    next_actions,
    also,
    elsewhere,
    rendered,
    ...(until !== undefined ? { until } : {}),
    ...(person !== undefined ? { person } : {}),
    next_sentence: nextSentence(narrowed, false),
  };
}

/**
 * P-6: the person block rides a handler's reply under this symbol — never serialized (JSON ignores
 * symbol keys), so a handler can return the envelope and its tool wrapper still finds the block.
 */
export const PERSON_BLOCK: unique symbol = Symbol('realm.mcp.person_block');

/** A handler's reply: the envelope, and the person block when there is one. */
export type WithPersonBlock<T> = T & { [PERSON_BLOCK]?: string };

/** The envelope of a rendered reply, carrying its person block under {@link PERSON_BLOCK}. */
/**
 * A rendered reply with sentences a tool adds after the door's own next sentence (decisions C205,
 * C211: the ended run's ways back in; `start_run`'s supersede sentence) — the order the reply had
 * before #729 PR-0, when the next sentence was core's and these followed it.
 */
export function withHintTail(rendered: RenderedReply, tail: string): RenderedReply {
  if (tail === '') return rendered;
  const hint = rendered.envelope.context_hint;
  return {
    ...rendered,
    envelope: {
      ...rendered.envelope,
      context_hint: hint.length > 0 ? `${hint}${tail}` : tail.trimStart(),
    },
  };
}

export function mcpReplyOf(rendered: RenderedReply): WithPersonBlock<McpEnvelope> {
  return rendered.person !== undefined
    ? { ...rendered.envelope, [PERSON_BLOCK]: rendered.person }
    : rendered.envelope;
}

// ─── The disclosure step (#729 PR-3; RECORD 01 #9, #10; D3/03) ──────────────────────────────────
//
// Every reply leaves through {@link toolContentOf}, which walks it by its class table with the
// reply's disclosure set, adds the `disclosure` receipt and serializes it: the LAST transformation.
// Every reshaping (`withHintTail`, the spreads, abandon's respread) happens before it. The library's
// `handle*` results stay raw (D9): only this door masks.

/** How a reply field reaches the agent (#729 PR-0, A-13): the envelope table's second column. */
export type ReplyRoute =
  | { mcp: 'published' }
  | { mcp: 'rendered'; into: readonly string[] }
  | { mcp: 'withheld'; reason: string };

/** One row of the envelope table: the field's disclosure class, and its route where PR-0 gave one. */
export interface EnvelopeRow {
  readonly class: DisclosureClass;
  readonly route?: ReplyRoute;
}

export const NEXT_ACTION_TABLE = {
  instruction: 'fact',
  // #627 W: an await entry's facts — the run, the gate, the step, its choices, its deadline.
  awaiting: 'fact',
  human_readable: 'fact',
  orientation: 'fact',
  input_schema: 'fact',
  // The template-resolved step prompt carries the run's values (D1 §3.3: the brief, every tier).
  prompt: 'value',
} as const satisfies Record<keyof McpNextAction, DisclosureClass>;

export const ALSO_TABLE = {
  ...NEXT_ACTION_TABLE,
  verb: 'fact',
} as const satisfies Record<keyof McpAlsoEntry, DisclosureClass>;

/** #729 PR-3 correction 2 (G4): who settled a question. A name the answerer gave is their own text,
 *  not a word from a closed set: a diagnostic copy. */
export const OUTCOME_BY_TABLE = {
  kind: 'fact',
  name: 'bounded',
  basis: 'fact',
  cause: 'fact',
  step: 'fact',
} as const satisfies Record<keyof Merged<Outcome['by']>, DisclosureClass>;

/** G4: a question's outcome, field by field: realm's words, the author's choice and step, times. */
export const OUTCOME_TABLE = {
  choice: 'fact',
  by: { nested: OUTCOME_BY_TABLE },
  at: 'fact',
  step: 'fact',
  expiry: 'fact',
  attempted: 'fact',
  via: 'fact',
} as const satisfies Record<keyof Outcome, DisclosureClass>;

/** The MCP envelope's rows: what the agent reads, field by field. */
export const MCP_ENVELOPE_ROWS = {
  command: { class: 'fact' },
  run_id: { class: 'fact' },
  run_version: { class: 'fact' },
  status: { class: 'fact' },
  data: { class: 'value' },
  evidence: { class: { nested: EVIDENCE_TABLE } },
  warnings: { class: 'bounded' },
  diagnostics: { class: 'bounded' },
  errors: { class: 'bounded' },
  error_code: { class: 'fact' },
  error_details: { class: 'bounded' },
  retry_after: { class: 'fact' },
  // #627 W: a refusal that a retry cannot fix says so (`false`).
  retryable: { class: 'fact' },
  context_hint: { class: 'bounded' },
  run_phase: { class: 'fact' },
  basis: { class: 'fact', route: { mcp: 'published' } },
  outcome: { class: { nested: OUTCOME_TABLE }, route: { mcp: 'published' } },
  races: { class: 'fact', route: { mcp: 'published' } },
  expiry: { class: 'fact', route: { mcp: 'published' } },
  chained_auto_steps: { class: 'fact' },
  adopted_own: { class: 'fact' },
  adopted_anonymous: { class: 'fact' },
  preserved_foreign: { class: 'fact' },
  settled_by_default: { class: 'fact' },
  defaulted_steps: { class: 'fact' },
  guards: { class: 'fact' },
  ended_by: { class: { nested: { arm: 'fact', step: 'fact', reason: 'bounded' } } },
  stopped_step: { class: 'fact' },
  answer_recorded: { class: 'fact' },
  gate_claim: { class: 'fact' },
  next_actions: { class: { nested: NEXT_ACTION_TABLE } },
  agent_action: { class: 'fact' },
  also: { class: { nested: ALSO_TABLE } },
  elsewhere: { class: 'fact' },
  poll_after_ms: { class: 'fact' },
  until: { class: 'fact' },
  // `about` published as `error.about`; the remedy worded into the hint; typed facts as error_details.
  error: {
    class: 'fact',
    route: { mcp: 'rendered', into: ['error', 'context_hint', 'error_details'] },
  },
  blocked_reason: { class: { nested: { eligible_steps: 'fact', suggestion: 'bounded' } } },
  gate: { class: { nested: GATE_INFO_TABLE } },
} as const satisfies Record<keyof McpEnvelope, EnvelopeRow>;

/** The class column of a rows table, its literal classes kept in the type (F5). */
export type ClassColumn<Rows extends Record<string, EnvelopeRow>> = {
  readonly [K in keyof Rows]: Rows[K]['class'];
};

/** A class table from rows. */
function classColumn<Rows extends Record<string, EnvelopeRow>>(rows: Rows): ClassColumn<Rows> {
  return Object.fromEntries(
    Object.entries(rows).map(([key, row]) => [key, row.class]),
  ) as ClassColumn<Rows>;
}

/** The MCP envelope's class table (RECORD 01 #6). */
export const MCP_ENVELOPE_TABLE = classColumn(MCP_ENVELOPE_ROWS) satisfies Record<
  keyof McpEnvelope,
  DisclosureClass
>;

/** What the door masks a reply with. `audience` is always `agent` here (RECORD 05 "audiences"). */
export interface ToolDisclosure {
  set: DisclosureSet;
  audience: 'agent';
  table: ClassTable;
}

/** One reply's tool result. */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string; annotations?: { audience: ['user'] } }>;
  isError?: boolean;
};

/**
 * The MCP tool result for one reply (P-6): the reply walked by its table for the agent, with its
 * `disclosure` receipt, as JSON — and, when it carries one, a second content block addressed to the
 * person (`audience: ["user"]`) with an operator's commands. The person block is read FIRST, from
 * the reply as given, and is emitted as its own block: it holds facts (commands), never a value.
 *
 * A string reply (a tool's plain-text error) is disclosed with every tier and sent as text; it has
 * no field to carry a receipt.
 */
export function toolContentOf(
  reply: string | WithPersonBlock<Record<string, unknown>> | WithPersonBlock<McpEnvelope>,
  disclosure: ToolDisclosure,
): ToolResult {
  if (typeof reply === 'string') {
    return {
      content: [{ type: 'text' as const, text: disclose(reply, disclosure.set, 'all').text }],
    };
  }
  const person = reply[PERSON_BLOCK];
  const shown = discloseReply(reply, disclosure.set, disclosure.audience, disclosure.table);
  return {
    content: [
      { type: 'text' as const, text: sseJsonStringify(shown) },
      ...(person !== undefined
        ? [{ type: 'text' as const, text: person, annotations: { audience: ['user'] as ['user'] } }]
        : []),
    ],
  };
}

/**
 * The door's disclosure for a reply (M-3): the set for what the reply is about, built per reply. The
 * door passes the definition, and the run when there is one (D-11): the provider reports that
 * project's declared state and cause; the declared members stay the process-wide union.
 */
export interface DoorDisclosure {
  setFor(definition: WorkflowDefinition | undefined, run?: RunRecord): Promise<DisclosureSet>;
}

/** The option every tool registration reads its disclosure from. */
export interface WithDoorDisclosure {
  doorDisclosure?: DoorDisclosure;
}

/** The environment's set for the agent, with no declared part, for `cause`. */
export function environmentSet(
  cause: 'embedder_none' | 'load_failed',
  notSecret?: readonly string[],
): DisclosureSet {
  return buildDisclosureSet({
    env: process.env,
    cwd: process.cwd(),
    declared: {},
    declaredState: 'unknown',
    declaredCause: cause,
    audience: 'agent',
    ...(notSecret !== undefined ? { notSecret } : {}),
  }).set;
}

/**
 * The door's disclosure from a host's options: its provider's set per reply; with no provider, the
 * environment's set read per reply, cause `embedder_none`; a provider that throws gives the
 * environment's set with cause `load_failed`, and the throw is logged through the masked stderr.
 */
export function doorDisclosureOf(options?: {
  disclosureProvider?: (
    definition: WorkflowDefinition | undefined,
    run?: RunRecord,
  ) => Promise<DisclosureSet>;
  disclosure?: { notSecret?: string[] };
}): DoorDisclosure {
  const notSecret = options?.disclosure?.notSecret;
  const provider = options?.disclosureProvider;
  return {
    async setFor(definition, run) {
      if (provider === undefined) return environmentSet('embedder_none', notSecret);
      try {
        return await provider(definition, run);
      } catch (err) {
        logMasked(`realm-mcp: the disclosure provider failed: ${String(err)}`);
        return environmentSet('load_failed', notSecret);
      }
    },
  };
}

/** What a reply is about (D-11): its workflow, and its run when the call names one. */
export interface ReplySubject {
  definition?: WorkflowDefinition;
  run?: RunRecord;
}

/**
 * F11: reads, after the call, what its reply is about — the run the call named and its workflow, or
 * the workflow it named. Best effort: a read that fails leaves the part out (the provider then
 * reports what it can), and never changes the reply.
 */
export async function replySubject(
  stores:
    | { runStore?: RunStore; workflowStore?: { get(id: string): Promise<WorkflowDefinition> } }
    | undefined,
  ids: { runId?: string | undefined; workflowId?: string | undefined },
): Promise<ReplySubject> {
  let run: RunRecord | undefined;
  if (ids.runId !== undefined && stores?.runStore !== undefined) {
    run = await stores.runStore.get(ids.runId).catch(() => undefined);
  }
  const workflowId = ids.workflowId ?? run?.workflow_id;
  let definition: WorkflowDefinition | undefined;
  if (workflowId !== undefined && stores?.workflowStore !== undefined) {
    definition = await stores.workflowStore.get(workflowId).catch(() => undefined);
  }
  return {
    ...(definition !== undefined ? { definition } : {}),
    ...(run !== undefined ? { run } : {}),
  };
}

/** The set for a subject. */
export async function setForSubject(
  door: DoorDisclosure,
  subject: ReplySubject,
): Promise<DisclosureSet> {
  return door.setFor(subject.definition, subject.run);
}

/**
 * F11 (D-11): the set for a reply covering several workflows (`list_workflows`): the members of the
 * set for no one workflow (the process-wide union), with the weakest declared standing of the
 * workflows' own (core's `weakestDeclared`).
 */
export async function setForWorkflows(
  door: DoorDisclosure,
  definitions: readonly WorkflowDefinition[],
): Promise<DisclosureSet> {
  // The workflows' own reads first: each may add its manifest's declared values to the union, and
  // the base is taken after them, so a fresh process's first list hides what they added (G5).
  const sets = await Promise.all(definitions.map((d) => door.setFor(d)));
  const base = await door.setFor(undefined);
  if (definitions.length === 0) return base;
  return withDeclaredStanding(
    base,
    weakestDeclared(
      sets.map((set) => ({
        declared: set.declared,
        ...(set.declaredCause !== undefined ? { declaredCause: set.declaredCause } : {}),
      })),
    ),
  );
}

/** The disclosure a tool registration uses: its host's, or the default. */
export function disclosureOfTool(opts: WithDoorDisclosure | undefined): DoorDisclosure {
  return opts?.doorDisclosure ?? doorDisclosureOf();
}

/** Writes one line to stderr, masked with the environment's set for a log (never a raw error). */
export function logMasked(text: string): void {
  try {
    const set = buildDisclosureSet({
      env: process.env,
      cwd: process.cwd(),
      declared: {},
      declaredState: 'unknown',
      declaredCause: 'embedder_none',
      audience: 'log',
    }).set;
    process.stderr.write(`${disclose(text, set, 'all').text}\n`);
  } catch {
    process.stderr.write('realm-mcp: an error could not be logged.\n');
  }
}

/** The reply when a tool's own error path throws (M-2). It names no value. Worded per tool (F34): a
 *  tool that names a run points at `get_run_state`; a runless tool and `get_run_state` itself do not. */
export const SAFE_TOOL_CONSTANT =
  'Realm could not compose a reply to this call. The error was logged on the server; call get_run_state to read the run.';
/** The constant for a tool with no run, and for `get_run_state`. */
export const SAFE_TOOL_CONSTANT_RUNLESS =
  'Realm could not compose a reply to this call. The error was logged on the server; try the call again.';

/**
 * Every tool's handler (M-2): the body, then on a throw its `onError`; when `onError` throws too,
 * a constant text, and the error is logged through the masked stderr. No raw error text escapes.
 */
export function safeTool<A extends unknown[]>(
  body: (...args: A) => Promise<ToolResult>,
  onError: (err: unknown, ...args: A) => Promise<ToolResult> | ToolResult,
  constant: string = SAFE_TOOL_CONSTANT,
): (...args: A) => Promise<ToolResult> {
  return async (...args: A) => {
    try {
      return await body(...args);
    } catch (err) {
      try {
        return await onError(err, ...args);
      } catch (inner) {
        // F34: the error's text is read inside its own guard — an error whose text cannot be read
        // must not escape to the SDK, which would send its raw message to the client.
        let described: string;
        try {
          described = String(inner);
        } catch {
          described = 'an error whose text could not be read';
        }
        logMasked(`realm-mcp: a tool's error path failed: ${described}`);
        return { content: [{ type: 'text' as const, text: constant }], isError: true };
      }
    }
  };
}

// ── F5 (the door's half): what produces each `fact` row that can hold a string ─────────────────
// Compile-forced beside the tables, under core's `FactProducers`: a `fact` row over text with no
// producer here fails the compile, and so does an entry for a row that is not such a row. Keyed on
// `MCP_ENVELOPE_ROWS`, and covering every table in `tools/` (imported for their types only).

/** The keys of every member of a union, each with the union of its types. */
type Merged<U> = {
  [K in U extends unknown ? keyof U : never]: U extends unknown
    ? K extends keyof U
      ? U[K]
      : never
    : never;
};

export const DOOR_FACTS = {
  envelope: {
    command: 'author_literal',
    run_id: 'id',
    status: 'enum',
    error_code: 'enum',
    run_phase: 'enum',
    basis: 'enum',
    races: 'enum',
    expiry: 'enum',
    chained_auto_steps: 'author_literal',
    defaulted_steps: 'author_literal',
    guards: 'author_literal',
    stopped_step: 'author_literal',
    gate_claim: 'id',
    agent_action: 'enum',
    elsewhere: 'enum',
    until: 'time',
    error: 'enum',
  } satisfies FactProducers<typeof MCP_ENVELOPE_TABLE, McpEnvelope>,
  // #729 PR-3 correction 2 (G4): start_run's reply is the envelope plus the run it reran.
  start_run: {
    command: 'author_literal',
    run_id: 'id',
    status: 'enum',
    error_code: 'enum',
    run_phase: 'enum',
    basis: 'enum',
    races: 'enum',
    expiry: 'enum',
    chained_auto_steps: 'author_literal',
    defaulted_steps: 'author_literal',
    guards: 'author_literal',
    stopped_step: 'author_literal',
    gate_claim: 'id',
    agent_action: 'enum',
    elsewhere: 'enum',
    until: 'time',
    error: 'enum',
    rerun_of: 'id',
  } satisfies FactProducers<typeof START_RUN_TABLE, StartRunReply>,
  outcome: {
    choice: 'author_literal',
    at: 'time',
    step: 'author_literal',
    expiry: 'time',
    via: 'enum',
  } satisfies FactProducers<typeof OUTCOME_TABLE, Outcome>,
  outcome_by: {
    kind: 'enum',
    basis: 'enum',
    cause: 'enum',
    step: 'author_literal',
  } satisfies FactProducers<typeof OUTCOME_BY_TABLE, Merged<Outcome['by']>>,
  next_action: {
    instruction: 'command_span',
    awaiting: 'id',
    human_readable: 'author_literal',
    orientation: 'author_literal',
    input_schema: 'author_literal',
  } satisfies FactProducers<typeof NEXT_ACTION_TABLE, McpNextAction>,
  also: {
    instruction: 'command_span',
    awaiting: 'id',
    human_readable: 'author_literal',
    orientation: 'author_literal',
    input_schema: 'author_literal',
    verb: 'enum',
  } satisfies FactProducers<typeof ALSO_TABLE, McpAlsoEntry>,
  ended_by: { arm: 'enum', step: 'author_literal' } satisfies FactProducers<
    (typeof MCP_ENVELOPE_ROWS)['ended_by']['class']['nested'],
    NonNullable<McpEnvelope['ended_by']>
  >,
  blocked_reason: { eligible_steps: 'author_literal' } satisfies FactProducers<
    (typeof MCP_ENVELOPE_ROWS)['blocked_reason']['class']['nested'],
    NonNullable<McpEnvelope['blocked_reason']>
  >,
  abandon_run: {
    run_id: 'id',
    run_phase: 'enum',
    note: 'enum',
  } satisfies FactProducers<typeof ABANDON_RUN_TABLE, AbandonRunSummary>,
  append_trace: { status: 'enum' } satisfies FactProducers<
    typeof APPEND_TRACE_TABLE,
    AppendTraceOkResult
  >,
  run_state: {
    run_id: 'id',
    workflow_id: 'author_literal',
    run_phase: 'enum',
    rerun_of: 'id',
    sealed_by_arm: 'enum',
    sealed_by_step: 'author_literal',
    completed_steps: 'author_literal',
    in_progress_steps: 'author_literal',
    failed_steps: 'author_literal',
    skipped_steps: 'author_literal',
    last_step: 'author_literal',
    created_at: 'time',
    updated_at: 'time',
    next_actions_status: 'enum',
    agent_action: 'enum',
    until: 'time',
    elsewhere: 'enum',
    basis: 'enum',
    stuck_claims: 'author_literal',
    step_claims: 'author_literal',
    capability_blocks: 'author_literal',
    defaulted_steps: 'author_literal',
    pending_guards: 'author_literal',
    resumable: 'command_span',
    cleanup_pending: 'command_span',
    waiting_on_answer: 'author_literal',
  } satisfies FactProducers<typeof RUN_STATE_SUMMARY_TABLE, RunStateSummary>,
  run_health: {
    kind: 'enum',
    step: 'author_literal',
    since: 'time',
  } satisfies FactProducers<
    (typeof RUN_STATE_SUMMARY_TABLE)['run_health']['nested'],
    RunHealthFinding
  >,
  sealed_by_adjudicated: { by: 'id', at: 'time', previous_arm: 'enum' } satisfies FactProducers<
    (typeof RUN_STATE_SUMMARY_TABLE)['sealed_by_adjudicated']['nested'],
    NonNullable<RunStateSummary['sealed_by_adjudicated']>
  >,
  engine_runnable: {
    step: 'author_literal',
    runnable_here: 'enum',
    refused_by: 'enum',
    basis: 'enum',
  } satisfies FactProducers<typeof ENGINE_RUNNABLE_TABLE, EngineRunnable>,
  precondition: { expression: 'author_literal' } satisfies FactProducers<
    typeof PRECONDITION_FACTS_TABLE,
    PreconditionFacts
  >,
  money: {
    sources: 'path_fact',
    source_totals: 'path_fact',
  } satisfies FactProducers<typeof MONEY_TABLE, Money>,
  not_priced: { cause: 'enum' } satisfies FactProducers<
    typeof NOT_PRICED_TABLE,
    NonNullable<Money['not_priced']>[number]
  >,
  drive_failure_cost: {
    at: 'time',
    step: 'author_literal',
    error_class: 'enum',
  } satisfies FactProducers<typeof DRIVE_FAILURE_COST_TABLE, DriveFailureCost>,
  workflow_protocol: {
    workflow_id: 'author_literal',
    name: 'author_literal',
    description: 'author_literal',
    params_schema: 'author_literal',
    steps: 'author_literal',
    agent_steps_summary: 'author_literal',
    rules: 'enum',
    error_handling: 'enum',
    quick_start: 'command_span',
  } satisfies FactProducers<typeof WORKFLOW_PROTOCOL_TABLE, WorkflowProtocol>,
  list_workflows: {
    status: 'enum',
    workflows: 'author_literal',
    hint: 'enum',
    error_code: 'enum',
    error_details: 'path_fact',
    agent_action: 'enum',
  } satisfies FactProducers<typeof LIST_WORKFLOWS_TABLE, Merged<ListWorkflowsResult>>,
  list_workflows_unreadable: {
    file: 'path_fact',
    class: 'enum',
    errno: 'enum',
    repair: 'command_span',
  } satisfies FactProducers<
    (typeof LIST_WORKFLOWS_TABLE)['unreadable']['nested'],
    UnreadableWorkflowEntry
  >,
  start_run_batch_started: {
    run_id: 'id',
    run_phase: 'enum',
  } satisfies FactProducers<
    (typeof START_RUN_BATCH_TABLE)['started']['nested'],
    StartRunBatchResult['started'][number]
  >,
  start_run_batch_failed: { error_code: 'enum' } satisfies FactProducers<
    (typeof START_RUN_BATCH_TABLE)['failed']['nested'],
    StartRunBatchResult['failed'][number]
  >,
  elicit: { mode: 'enum', requestedSchema: 'author_literal' } satisfies FactProducers<
    typeof ELICIT_TABLE,
    Parameters<ElicitFn>[0]
  >,
} as const;
