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
  generateSchemaSkeleton,
  narrowForDoor,
  raceClausesOf,
  withFullStop,
  DOOR_SERVES,
  PROGRESS_VERBS,
  TERMINAL_PHASES,
  WAY_PARTIES,
  type AgentAction,
  type Basis,
  type DoorPolicy,
  type EngineReply,
  type ForWay,
  type GateInfo,
  type Narrowed,
  type ProgressVerb,
  type RenderedList,
  type Source,
  type Unavailable,
  type WayOf,
  type WayOn,
  type WayRenderer,
  type WayVerb,
} from '@sensigo/realm';

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

/** One entry of `next_actions` (a progress way the agent can take) or of `also`. */
export interface McpNextAction {
  instruction: McpInstruction | null;
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
    return {
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
};

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
function elsewhereWords(entry: Unavailable): string {
  const way = entry.remedy[0];
  if (way?.verb === 'register') {
    return `An operator registers workflow '${way.workflow_id}' again${way.path !== undefined ? ` from ${way.path}` : ''}, outside this conversation.`;
  }
  if (way?.verb === 'run_step') {
    // PR0-CONTRACT Amendment 14 (Q12): a fact, never a schedule.
    return `'${way.step}' takes its input from an operator, checked against its input_schema; no realm command supplies it.`;
  }
  return `An operator can take this way (${entry.verb}), outside this conversation.`;
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

/** The narrowed ways of a reply, or none when it judged none. */
function narrowReply(reply: EngineReply, host: McpHost): Narrowed | undefined {
  if (reply.basis === undefined) return undefined;
  return narrowForDoor(
    { ways: reply.ways, unavailable: reply.unavailable, basis: reply.basis },
    mcpDoorPolicy(host),
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

/** P-2: the deadline the record states for what an `await` waits on (the earliest), if any. */
function untilOf(narrowed: Narrowed | undefined): string | undefined {
  const stated = (narrowed?.unavailable ?? [])
    .filter((u) => u.code === 'held_elsewhere' && u.clears_at !== undefined)
    .map((u) => u.clears_at!)
    .sort();
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

/** The sentence an error's remedy adds (an answer, reading the run, the act). */
function remedyWords(remedy: readonly WayOn[], replyRunId: string): string {
  return remedy
    .map((way) => {
      switch (way.verb) {
        case 'respond':
          return ` Answer it: submit_human_response {run_id: '${way.run_id}', gate_id: '${way.gate_id}', choice: <one of: ${way.choice.one_of.join(', ')}>}.`;
        case 'advance':
          return ` Call advance_run with run_id '${way.run_id}'.`;
        case 'inspect':
          return way.run_id === replyRunId ? '' : ` Read run '${way.run_id}' with get_run_state.`;
        default:
          return '';
      }
    })
    .join('');
}

/** The reply's `context_hint`: what happened (core's), then the door's words of what comes next. */
function hintOf(reply: EngineReply, narrowed: Narrowed | undefined, ended: boolean): string {
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
    (refusal.facts.check !== 'input_schema' ||
      !refusal.remedy.some(
        (w) =>
          w.verb === 'run_step' &&
          (narrowed?.ways ?? []).some(
            (n) => n.verb === 'run_step' && n.step === w.step && forAgent(n),
          ),
      )) &&
    cannotGoOnWithRefusal(narrowed, ended) &&
    narrowed !== undefined
  ) {
    // C66, #688: a by-name refusal the caller cannot change ends with the person's way out. #729 Q3
    // correction 1 (the architect's ruling, Amendment 16's chain law): an input refusal's own
    // `run_step` lever withholds it only when THIS caller may take that lever — at this door the
    // operator's lever rides `elsewhere`, never the agent's ways, so the assistant is told the end of
    // the chain.
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
    hint += remedyWords(reply.error.remedy, reply.run_id);
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
function suggestionOf(reply: EngineReply, progress: readonly ForWay[]): string {
  const refusal = reply.refusal;
  if (refusal?.code === 'refused_before_claim' && refusal.facts.precondition !== undefined) {
    // E1 (b): the value read, through the one escaped, bounded value renderer.
    const p = refusal.facts.precondition;
    return `Precondition failed: '${p.expression}'. Resolved value: ${p.value}.`;
  }
  if (reply.error_code === 'STATE_STEP_ALREADY_CLAIMED') {
    return 'Step is already in progress. Wait for it to complete.';
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
export function renderReply(reply: EngineReply, host: McpHost = {}): RenderedReply {
  const narrowed = narrowReply(reply, host);
  const progress = agentProgressWays(narrowed);
  const next_actions = progress
    .map((w) => renderWay(w, reply.basis, host))
    .filter((e): e is McpNextAction => e !== null);
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
    human_readable: elsewhereWords(u),
  }));
  const ended = reply.run_phase !== undefined && TERMINAL_PHASES.has(reply.run_phase);
  const rendered = renderedListOf(reply, narrowed, progress);
  const agentAction = agentActionOf(reply.intrinsic_action, reply.reply_kind, rendered);
  const until = agentAction === 'await' ? untilOf(narrowed) : undefined;
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
    context_hint: hintOf(reply, narrowed, ended),
    next_actions,
    ...(also.length > 0 ? { also } : {}),
    ...(elsewhere.length > 0 ? { elsewhere } : {}),
    ...(agentAction === 'await' ? { poll_after_ms: MCP_POLL_AFTER_MS } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(error?.about !== undefined ? { error: { about: error.about } } : {}),
    ...(blocked_reason !== undefined
      ? {
          blocked_reason: {
            eligible_steps: blocked_reason.eligible_steps,
            suggestion: suggestionOf(reply, progress),
          },
        }
      : {}),
    ...(gate !== undefined ? { gate } : {}),
  };
  assertTokenEgress(envelope, reply);
  const person = personBlockOf(elsewhereEntries, reply.basis, host);
  return { envelope, ...(person !== undefined ? { person } : {}) };
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
        : `${elsewhereWords(u)} The operator's command: ${command}`;
    })
    .filter((line): line is string => line !== undefined);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * A-17's egress assertion: a claim token leaves this door only inside the `submit_human_response`
 * instruction of the reply whose own call opened the question (its `respond` way's `proof`) — never
 * in the gate object, never on any other entry.
 */
function assertTokenEgress(envelope: McpEnvelope, reply: EngineReply): void {
  const opening = reply.ways.some((w) => w.verb === 'respond' && w.proof !== undefined);
  const carriers = envelope.next_actions.filter(
    (a) => a.instruction !== null && 'claim_token' in a.instruction.params,
  );
  const stray =
    (envelope.gate !== undefined && 'claim_token' in (envelope.gate as object)) ||
    (envelope.also ?? []).some(
      (a) => a.instruction !== null && 'claim_token' in a.instruction.params,
    ) ||
    (!opening && carriers.length > 0);
  if (stray) {
    throw new Error(
      "renderReply: a claim token reached the wire outside the opening reply's answer",
    );
  }
}

// ─── Replies that are not an engine reply ───────────────────────────────────────────────────────

/** The rendered `next_actions`, `also` and `elsewhere` of one composition, for a view that is not a reply. */
export function renderWaysOf(
  composed: Pick<EngineReply, 'ways' | 'unavailable' | 'basis'>,
  host: McpHost = {},
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
  const next_actions = progress
    .map((w) => renderWay(w, composed.basis, host))
    .filter((e): e is McpNextAction => e !== null);
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
    human_readable: elsewhereWords(u),
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

/**
 * The MCP tool result for one reply (P-6): the reply as JSON, and — when it carries one — a second
 * content block addressed to the person (`audience: ["user"]`) with an operator's commands.
 */
export function toolContentOf(
  reply: WithPersonBlock<Record<string, unknown>> | WithPersonBlock<McpEnvelope>,
  serialize: (value: unknown) => string,
): {
  content: Array<{ type: 'text'; text: string; annotations?: { audience: ['user'] } }>;
} {
  const person = reply[PERSON_BLOCK];
  return {
    content: [
      { type: 'text' as const, text: serialize(reply) },
      ...(person !== undefined
        ? [{ type: 'text' as const, text: person, annotations: { audience: ['user'] as ['user'] } }]
        : []),
    ],
  };
}
