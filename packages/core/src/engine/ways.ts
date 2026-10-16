// ways.ts — issue #729 PR-0 (PR0-CONTRACT §1–§4; DESIGN-D2 §3, D3 A-1…A-7, D4 P-2…P-10, T-1…T-22):
// what a caller can do next with a run, as DATA, judged once in core and rendered per door.
//
// A way (`WayOn`) is one act a party can take on a run — answer its open question, run a step, have
// the engine carry out what it owes, read it, end it, register its workflow again. A way that cannot
// be taken now is `Unavailable`, with a closed code, its typed facts and the remedies (themselves
// ways) that lead on. The engine composes both lists from ONE snapshot (`composeWaysOn`), admits a
// call by the same judges (`admitWay`, R26: offer = admission), and narrows them for the door that
// renders them (`narrowForDoor`, the only place a way's parties are minted). Renderers — MCP's
// `renderReply`, the CLI's `CLI_COMMANDS`, the library's `LIBRARY_WORDS` — turn ways into words;
// nothing here composes a host's words.
//
// Every vocabulary below is closed in core and published open (an unknown verb falls back to
// `inspect`). A member enters with its PRODUCER (the membership rule): PR-0 produces the six verbs
// and the codes listed; #627 W, V-1 and #729 PR-1…PR-7 add theirs.
import type {
  EvidenceSnapshot,
  PendingGate,
  RunPhase,
  RunRecord,
  SupplierAbsentCause,
  SupplierRole,
} from '../types/run-record.js';
import type { AgentAction, ErrorCode } from '../types/workflow-error.js';
import type { WorkflowDefinition, ContextWrapperFormat } from '../types/workflow-definition.js';
import type { ExtensionRegistry } from '../extensions/registry.js';
import { stampOf, writtenSnapshot, type Basis, type Snapshot } from './snapshot.js';
import { renderTemplate } from './render-template.js';
import { buildEvidenceByStep, deriveRunPhase, findEligibleSteps } from './eligibility.js';
import {
  checkPreClaim,
  describePending,
  offeredResumeWay,
  type DueExpiry,
  type EngineRunnable,
  type PendingView,
  type PreconditionFacts,
} from './pending.js';
import { requirementForStep } from './capability.js';
import { consumesInputMap, newRunCanChangeInput, refusedInputField } from './input-map.js';

// ─── Parties and slots ──────────────────────────────────────────────────────────────────────────

/** Who can take a way (PR0-CONTRACT §1): the operator, the agent, the person a question is asked of. */
export const PARTIES = ['operator', 'agent', 'asked_person'] as const;
export type Party = (typeof PARTIES)[number];

/** A value the caller picks from a closed set (D1 spine 1): printed by each door's own rule (T-7). */
export type Slot<T> = { readonly one_of: readonly T[] };

// ─── Conditions ─────────────────────────────────────────────────────────────────────────────────

/**
 * A condition a way is offered with (PR0-CONTRACT §1, D2 D-4): offered with condition c, it is
 * admitted only when c is met (D3 A-4). PR-0's one member: `enactor_has` — the step needs a handler or
 * an adapter, and whether this program has it is judged from its `basis`: `marker` (the run's own
 * `capability_blocks` record: the program that last attempted the step lacked it), `unjudged` (an
 * observer passed no registry — C33: a read surface never executes project code), `load_failed` (this
 * program's project code failed to load).
 *
 * W adds `client_prompt`; PR-1 adds `confirm_after_preview`, `erases_operator_ending`,
 * `override_claim_unknown_age` — each with its producer, never reserved here.
 */
export type Cond =
  | {
      code: 'enactor_has';
      kind: 'handler' | 'adapter';
      name: string;
      basis: 'marker' | 'unjudged' | 'load_failed';
    }
  /**
   * #627 W (Part B, §5.2 row 3): the MCP door's fallback — a client that shows no forms keeps the
   * answer tool, marked so the app asks the person to approve each call. The CLIENT discharges it,
   * outside Realm: no argument discharges it (it is in no `ArgSpec.discharges` list — discharge is
   * declared on the argument, the one home, PR0-CONTRACT Amendment 17 item 9), and admission never
   * waits on it, since Realm cannot see the prompt (cell 31). Its `tag` names the outside discharger.
   */
  | { code: 'client_prompt'; tag: CondTag };

/**
 * #627 W: who discharges a condition outside Realm (`client`: the MCP client's own approval
 * prompt). Beside {@link Cond}, never on {@link CODE_TAGS}, which tags UNAVAILABLE codes.
 * OFFER_EQUALS_ADMISSION compares offer and admission over conditions Realm judges, so it leaves a
 * `client`-tagged condition out of the compared set.
 */
export const COND_TAGS = ['client'] as const;
export type CondTag = (typeof COND_TAGS)[number];

// ─── The ways ───────────────────────────────────────────────────────────────────────────────────

/**
 * PR-0's verbs (option B) and #627 W's `present` (Amendment 2): PR-1 adds resume/drain/purge, PR-2
 * reclaim/validate/export, PR-7 start.
 */
export const WAY_VERBS = [
  'respond',
  'run_step',
  'advance',
  'inspect',
  'abandon',
  'register',
  'present',
] as const;
export type WayVerb = (typeof WAY_VERBS)[number];

/**
 * The PROGRESS verbs (D3 A-1): a way that moves the run on. Only these are callable entries of an
 * agent's `next_actions`, and only these count as callable in `agentActionOf` (D-8); `inspect` and
 * `abandon` render outside the list, `register` is an operator's.
 */
export const PROGRESS_VERBS = [
  'respond',
  'run_step',
  'advance',
] as const satisfies readonly WayVerb[];
export type ProgressVerb = (typeof PROGRESS_VERBS)[number];

interface Base<V extends WayVerb> {
  readonly verb: V;
  readonly conditions: readonly Cond[];
}

/**
 * What a `run_step` way says about its step (D1 spine 3, 4): the step's kind, its description, the
 * prompt the agent reads (template-resolved), the input schema an agent step's answer must fit, and —
 * a fact kept as data until #516 decides its meaning — the step's handler.
 */
export interface StepBrief {
  execution: 'agent' | 'auto';
  description: string;
  prompt?: string;
  input_schema?: Record<string, unknown>;
  handler?: string;
}

/** Answer the run's open question (PR0-CONTRACT §1). */
export type RespondWay = Base<'respond'> & {
  run_id: string;
  gate_id: string;
  step: string;
  choice: Slot<string>;
  expires_at?: string;
  on_expiry?: 'settle_default' | 'abort';
  /** The steps the question holds (decision C211): eligible by their dependencies, held while open. */
  holds: readonly string[];
  /** Whether the reply that carries this way also carries the question's `gate` (the opening reply and the already-open reply) or names the question alone. */
  presented: 'with_gate' | 'alone';
  owner?: string;
  /**
   * The ONLY carrier of a claim's token (A-17): set only on the reply whose own call opened the
   * question, and only when the store minted a token. The answer passes it back as `claim_token`.
   */
  proof?: { claim_token: string };
};

/** Run one step: an agent step's answer, or (the operator's lever, T-17) an engine step's input. */
export type RunStepWay = Base<'run_step'> & { run_id: string; step: string; brief: StepBrief };

/** Have the engine carry out what it owes (#625 PR-2a's act): a due expiry first, then steps. */
export type AdvanceWay = Base<'advance'> & {
  run_id: string;
  owed: readonly ({ step: string } | { expiry: DueExpiry })[];
};

/** Read the run's record. */
export type InspectWay = Base<'inspect'> & { run_id: string };

/** End the run. */
export type AbandonWay = Base<'abandon'> & { run_id: string };

/**
 * Register the run's workflow again (D3 A-10): no JUDGE — on MCP an elsewhere entry. `path` only
 * when the registry knows the file (T-21: the unreadable, invalid and legacy copies carry it).
 */
export type RegisterWay = Base<'register'> & {
  workflow_id: string;
  run_id?: string;
  path?: string;
};

/**
 * #627 W (Amendment 2): show the open question again, as a form in the agent's own call — the MCP
 * door's `present_question`. The agent cannot answer through it: the person's accept records the
 * answer. No `step`: a renderer reads the step from the reply it already holds.
 */
export type PresentWay = Base<'present'> & { run_id: string; gate_id: string };

/** One way on, discriminated on `verb` (PR0-CONTRACT §1). */
export type WayOn =
  RespondWay | RunStepWay | AdvanceWay | InspectWay | AbandonWay | RegisterWay | PresentWay;

/** The way of one verb. */
export type WayOf<V extends WayVerb> = Extract<WayOn, { verb: V }>;

// ─── Who can take each verb ─────────────────────────────────────────────────────────────────────

/**
 * The parties each verb is for (D3 A-1) — the only authored source; a way's own `for` is minted only
 * inside {@link narrowForDoor} as this ∩ the parties the door serves.
 */
export const WAY_PARTIES: { readonly [V in WayVerb]: readonly Party[] } = {
  respond: ['asked_person', 'agent', 'operator'],
  run_step: ['agent', 'operator'],
  advance: ['agent', 'operator'],
  inspect: ['operator', 'agent'],
  abandon: ['operator', 'agent'],
  register: ['operator'],
  // #627 W: only the agent asks again (Amendment 2); the person answers through the form itself.
  present: ['agent'],
};

// ─── Why a way is not available ─────────────────────────────────────────────────────────────────

/**
 * How a code is judged (D3 A-4): on the loaded snapshot, on the caller's input, by the store at write
 * time, or by the door. OFFER_EQUALS_ADMISSION (R26) holds over the snapshot codes.
 */
export const CODE_TAGS = ['snapshot', 'input', 'write', 'door'] as const;
export type CodeTag = (typeof CODE_TAGS)[number];

/**
 * PR-0's codes (PR0-CONTRACT §1, T-1, T-21, A-5, A-7), each with its tag and the verbs it applies to.
 * One S7 law per code (rule 19): its cell in `ways.test.ts`. No member is reserved (Amendment 8).
 */
export const UNAVAILABLE_CODES = {
  // respond
  // #627 W: `present` shares respond's snapshot codes (Amendment 5), named here by verb.
  run_ended: { tag: 'snapshot', verbs: ['respond', 'run_step', 'advance', 'abandon', 'present'] },
  question_settled: { tag: 'snapshot', verbs: ['respond', 'present'] },
  question_due: { tag: 'snapshot', verbs: ['respond', 'run_step', 'advance', 'present'] },
  question_past_deadline: { tag: 'write', verbs: ['respond'] },
  gate_not_open: { tag: 'input', verbs: ['respond', 'present'] },
  // run_step / advance
  not_a_step: { tag: 'input', verbs: ['run_step'] },
  step_settled: { tag: 'snapshot', verbs: ['run_step'] },
  question_open: { tag: 'snapshot', verbs: ['run_step', 'advance', 'abandon'] },
  gated_step: { tag: 'snapshot', verbs: ['run_step'] },
  held_elsewhere: { tag: 'snapshot', verbs: ['run_step', 'advance'] },
  upstream_cannot_run: { tag: 'snapshot', verbs: ['run_step'] },
  deps_unsettled: { tag: 'snapshot', verbs: ['run_step'] },
  not_eligible: { tag: 'snapshot', verbs: ['run_step', 'advance'] },
  claim_removed: { tag: 'write', verbs: ['run_step'] },
  refused_before_claim: { tag: 'snapshot', verbs: ['run_step', 'advance'] },
  capability_missing: { tag: 'snapshot', verbs: ['run_step', 'advance'] },
  step_engine_decided: { tag: 'snapshot', verbs: ['run_step'] },
  enactor_load_failed: { tag: 'snapshot', verbs: ['run_step', 'advance'] },
  definition_absent: {
    tag: 'snapshot',
    verbs: ['respond', 'run_step', 'advance', 'abandon', 'present'],
  },
  // admission's input code (P-5)
  argument_out_of_contract: {
    tag: 'input',
    verbs: ['respond', 'run_step', 'advance', 'inspect', 'abandon', 'present'],
  },
  // the door's
  door_cannot_enact: {
    tag: 'door',
    verbs: ['respond', 'run_step', 'advance', 'inspect', 'abandon', 'register', 'present'],
  },
  // #627 W's door codes (§5.2, §5.2b; Amendments 2, 3): judged by the door from its own facts.
  // `no_form_here`: this door sends no form for the question (every row of §5.2's table but
  // `asked` with forms, and the library door); `form_open`: a form for it is open on this server;
  // `asks_exhausted`: the asks after the first are spent here; `door_withholds_answers`: the door
  // removed the agent's `respond` (the conservation law).
  no_form_here: { tag: 'door', verbs: ['present'] },
  form_open: { tag: 'door', verbs: ['present'] },
  asks_exhausted: { tag: 'door', verbs: ['present'] },
  door_withholds_answers: { tag: 'door', verbs: ['respond'] },
} as const satisfies Record<string, { tag: CodeTag; verbs: readonly WayVerb[] }>;
export type UnavailableCode = keyof typeof UNAVAILABLE_CODES;

/**
 * The code a failed load of a program's project code carries (A-5; Amendment 16, Q19): the error's
 * catalogue code, or `uncoded` — the loader throws plain errors too, and no catalogue code is minted
 * for them (a reader is never sent to the catalogue for a code that is not there).
 */
export type LoadErrorCode = ErrorCode | 'uncoded';

/** The checks that refuse a step before its claim (#625 PR-2a's `checkPreClaim`, minus capability). */
export type RefusedCheck = 'trust' | 'precondition' | 'input_schema';

/** How a `definition_absent` arose (A-5, T-21: `getWorkflowForRun`'s arms). */
export const DEFINITION_ABSENCES = [
  'agent_copy_gone',
  'not_registered',
  'unreadable',
  'format_invalid',
  'legacy',
  'not_read',
  // #627 W (W-r2): the stored copy was written by a LATER Realm (the mirror of `legacy`).
  'newer',
] as const;
export type DefinitionAbsence = (typeof DEFINITION_ABSENCES)[number];

/** The typed facts of each code (PR0-CONTRACT §1: `FactsOf<C>` typed per code). */
export interface FactsByCode {
  run_ended: { phase: RunPhase };
  question_settled: { gate_id: string };
  question_due: {
    gate_id: string;
    step: string;
    expires_at: string;
    on_expiry: 'settle_default' | 'abort';
  };
  question_past_deadline: { gate_id: string; step: string; expires_at: string };
  gate_not_open: { gate_id: string; open_gate?: { gate_id: string; step: string } };
  not_a_step: { step: string; workflow_id: string };
  step_settled: { step: string; outcome: 'completed' | 'failed' | 'skipped' };
  question_open: {
    step: string;
    gate_id: string;
    question_step: string;
    choices: readonly string[];
  };
  gated_step: { step: string; gate_id: string; choices: readonly string[] };
  /** T-11: the claim's deadline, or that its age is unknown — never a liveness word (rule 10). */
  held_elsewhere: { step: string; deadline: string | { absent: 'unknown_age' } };
  upstream_cannot_run: { step: string; upstream: readonly string[] };
  deps_unsettled: { step: string; deps: readonly string[] };
  /** Amendment 13 (Q11): `advance` with nothing owed is `{ reason: 'nothing_owed' }`. */
  not_eligible: { step: string } | { reason: 'nothing_owed' };
  claim_removed: { step: string };
  refused_before_claim: {
    step: string;
    check: RefusedCheck;
    /** The engine's own sentence of why (the view's `refusal`): the step's own refusal, not a way. */
    refusal: string;
    /** T-20 (v): for an input refused by a map that reads the run's params, the param the map reads. */
    param?: string;
    /** `precondition` only (E1 (b)): the failed expression and the value it read, escaped and bounded. */
    precondition?: PreconditionFacts;
  };
  /** Amendment 13 (Q9): shaped as run-health's (C46: a caller whose registry has it is not blocked). */
  capability_missing: {
    step: string;
    requirement: { kind: 'handler' | 'adapter'; name: string };
    basis: 'registry' | 'marker';
  };
  step_engine_decided: { step: string; execution: 'guard' | 'finalizer' | 'auto' };
  /** Amendment 16 (Q19): the loader's code, or `uncoded` for a throw that carries none. */
  enactor_load_failed: { error_code: LoadErrorCode };
  definition_absent: {
    workflow_id: string;
    cause: DefinitionAbsence;
    path?: string;
    /** #627 W: `newer` only — the definition format the copy states, and the latest this version reads. */
    format?: { schema_version: number; reads_up_to: number };
  };
  argument_out_of_contract: { arg: string };
  /**
   * The door cannot enact the way for some party (the conservation law). `engine_step` (T-13,
   * Amendment 13 Q4): an engine step's input is never the agent's, so the agent is removed from a
   * `run_step` way on a step that is not an agent step.
   */
  door_cannot_enact: { door: string; reason?: 'engine_step' };
  /** #627 W: the question this door sends no form for. */
  no_form_here: { gate_id: string };
  /** #627 W: a form for the question is open on this server; the call re-judges it (R26). */
  form_open: { gate_id: string };
  /** #627 W: how many times this server has sent the question's form (the first and the asks). */
  asks_exhausted: { gate_id: string; sent: number };
  /** #627 W: the party the door removed from the question's `respond` (the conservation law). */
  door_withholds_answers: { party: 'agent' };
}
export type FactsOf<C extends UnavailableCode> = FactsByCode[C];

/**
 * The ONE composer of a `definition_absent` entry's reason (D3 A-5, D4 T-21; C2: data in) — what is
 * so, never a way on: the registrar's not-registered message and every door's rendering of the entry
 * say it in these words. A cause with no file says why no path exists.
 */
export function renderDefinitionAbsent(facts: FactsOf<'definition_absent'>): string {
  const id = `'${facts.workflow_id}'`;
  const at = facts.path !== undefined ? ` (${facts.path})` : '';
  switch (facts.cause) {
    case 'not_registered':
      return `Workflow ${id} is not registered in this workflow store, and the store does not know the file it came from, so no path to it is recorded`;
    case 'agent_copy_gone':
      return `Workflow ${id} was created by an agent (create_workflow) and its stored copy is gone; there is no source file to register`;
    case 'unreadable':
      return `The stored copy of workflow ${id}${at} cannot be read`;
    case 'format_invalid':
      return `The stored copy of workflow ${id}${at} is not a valid workflow`;
    case 'legacy':
      return `The stored copy of workflow ${id}${at} is in a format this version no longer reads`;
    case 'not_read':
      return `The definition of workflow ${id} was not read`;
    case 'newer':
      // #627 W (W-r2's words, as a reason — what is so, never a way on).
      return `Workflow ${id}${at} was registered by a later version of Realm${
        facts.format !== undefined
          ? ` (definition format ${facts.format.schema_version}; this version reads up to ${facts.format.reads_up_to})`
          : ''
      }, so this version would ignore requirements it cannot read`;
  }
}

/**
 * Why a refusal carries no OFFERED remedy (REFUSAL_ENDS_IN_AN_ACT: a refusal carries at least one
 * offered remedy or names why none exists — T-5, T-12; Amendment 13, Q5: named by FACT, never by
 * schedule; Amendment 15: the law is answered per code). `operator_command_untyped`: the way on is
 * an operator's command no typed way exists for yet (an ended run's resume, drain or purge — T-5; a
 * new run — T-12); the CLI has the command. `requires_other_program`: the step needs a handler or
 * adapter this program does not have. `another_program_holds_it`: another call holds the step (T-11's
 * facts carry its deadline or `unknown_age`; the wait is the act — `agent_action` `await`).
 * `already_settled`: nothing is left to do about this step or question. `engine_runs_it_when_owed`:
 * a guard or cleanup step, and the engine owes nothing now.
 */
export const NO_REMEDY_CAUSES = [
  'operator_command_untyped',
  'requires_other_program',
  'another_program_holds_it',
  'already_settled',
  'engine_runs_it_when_owed',
] as const;
export type NoRemedy =
  | { cause: 'operator_command_untyped'; command: 'resume' | 'drain' | 'purge' | 'start' }
  | { cause: 'requires_other_program'; requirement: { kind: 'handler' | 'adapter'; name: string } }
  | { cause: 'another_program_holds_it' }
  | { cause: 'already_settled' }
  | { cause: 'engine_runs_it_when_owed' };

/** Amendment 15: another call holds the step — the wait is the act. */
const HELD: NoRemedy = { cause: 'another_program_holds_it' };

/** A way that cannot be taken now (PR0-CONTRACT §1). */
export type Unavailable = {
  [C in UnavailableCode]: {
    verb: WayVerb;
    step?: string;
    code: C;
    facts: FactsOf<C>;
    /** A deadline the RECORD states when the code clears; never a prediction (rule 10). */
    clears_at?: string;
    /** Every remedy is itself judged (P-4, REMEDY_IS_JUDGED). */
    remedy: readonly WayOn[];
    no_remedy?: NoRemedy;
  };
}[UnavailableCode];

// ─── The one input contract per verb (P-5) ──────────────────────────────────────────────────────

/** One argument of a verb: its type, whether it is required, the conditions it discharges. */
export interface ArgSpec {
  type: 'string' | 'object' | 'boolean';
  required: boolean;
  discharges: readonly Cond['code'][];
}

/**
 * Each verb's arguments (D4 P-5) — the contract every door's schema structurally equals (the
 * door-schema witness). `ARGS.respond` carries no route and no channel-check field (#627 I3): the
 * route is door-side. `run_step`'s `params` is the step's input, checked against its `input_schema`
 * (INPUT_IN_CONTRACT_ADMITTED). `register`'s arguments are the CLI's own (no JUDGE, A-10).
 */
export const ARGS: { readonly [V in WayVerb]: Readonly<Record<string, ArgSpec>> } = {
  respond: {
    run_id: { type: 'string', required: true, discharges: [] },
    gate_id: { type: 'string', required: true, discharges: [] },
    choice: { type: 'string', required: true, discharges: [] },
    claim_token: { type: 'string', required: false, discharges: [] },
    responded_by: { type: 'string', required: false, discharges: [] },
  },
  run_step: {
    run_id: { type: 'string', required: true, discharges: [] },
    command: { type: 'string', required: true, discharges: [] },
    params: { type: 'object', required: false, discharges: [] },
  },
  advance: {
    run_id: { type: 'string', required: true, discharges: [] },
  },
  inspect: {
    run_id: { type: 'string', required: true, discharges: [] },
  },
  abandon: {
    run_id: { type: 'string', required: true, discharges: [] },
    reason: { type: 'string', required: false, discharges: [] },
  },
  register: {
    path: { type: 'string', required: true, discharges: [] },
  },
  // #627 W (Amendment 2): the run and its open gate; the door-schema witness makes
  // `present_question`'s input exactly these.
  present: {
    run_id: { type: 'string', required: true, discharges: [] },
    gate_id: { type: 'string', required: true, discharges: [] },
  },
};

// ─── The door and the narrowing (A-3, P-10) ─────────────────────────────────────────────────────

/** A door's route (A-23): the route this door records answers as. Data; equality only. */
export type RouteId = string;

/**
 * Where a door setting came from (P-10). PR-0's kinds, and #627 W's `negotiated` (Amendment 10): its
 * only producer is `answers.forms.source`, with `ref` naming the client's `initialize` capability.
 */
export type Source = {
  kind: 'flag' | 'env' | 'option' | 'config' | 'default' | 'negotiated';
  ref: string;
};

/**
 * #627 W (§5.1, F21): how the MCP door handles gate answers. `asked` (the default): the question goes
 * to the person in the chat app's own form, and the agent gets no answer tool — or, in a client that
 * shows no forms, keeps it with the app's approval prompt (F30); `offered` (opt-in): today's answer
 * tool; `withheld`: no answer way at all. The most restrictive value wins: `withheld` > `asked` >
 * `offered`.
 */
export const GATE_ANSWERS_VALUES = ['asked', 'offered', 'withheld'] as const;
export type GateAnswers = (typeof GATE_ANSWERS_VALUES)[number];

/**
 * #627 W: the door's gate-answers setting, as `narrowForDoor` reads it — the value and where it came
 * from, and whether this session's client shows forms (`forms.source.kind: 'negotiated'`, `ref`
 * naming its `initialize` capability; on stateless HTTP always `false` until the SDK 2.x move).
 */
export interface DoorAnswers {
  value: GateAnswers;
  source: Source;
  forms: { shown: boolean; source: Source };
}

/**
 * #627 W (§5.2b; Amendment 4): what this door has SENT for one question, per server process — never
 * what the person saw, and never on the run record. `sent_here`: no form sent here, one open now, or
 * every one sent came back; `came_back`: how many came back without an answer; `asks_left`: how many
 * more times the agent may ask (`present_question`) in this process.
 */
export interface DoorFormFacts {
  sent_here: 'never' | 'open' | 'closed';
  came_back: number;
  asks_left: number;
  /** How many times this server has sent the question's form, the first included. */
  sent: number;
}

/**
 * One door's policy (PR0-CONTRACT §4). `serves` is a VALUE per door instance, never per session.
 * `operator_route` is set by the program that launched the door when it can render an operator's
 * command (`realm mcp` and `realm serve` inject the CLI's; the standalone `realm-mcp` bin does not).
 * W adds `answers`.
 */
export interface DoorPolicy {
  door: string;
  serves: readonly Party[];
  route: RouteId;
  source: Source;
  operator_route?: { renderer: 'cli'; source: Source };
  /**
   * #627 W: the door's gate answers (the MCP door's alone). Absent ⇒ the door narrows as PR-0 did:
   * the agent's `respond` kept, `present` judged `no_form_here`.
   */
  answers?: DoorAnswers;
}

/** The default parties each door serves (A-3). */
export const DOOR_SERVES = {
  mcp: ['agent', 'asked_person'],
  cli: ['operator', 'asked_person'],
  library: ['agent', 'operator'],
} as const satisfies Record<string, readonly Party[]>;

/** A way with the parties this door serves it to — minted only by {@link narrowForDoor}. */
export type ForWay = WayOn & { readonly for: readonly Party[] };

/**
 * What a door may render (D2 D-1): the ways it serves, with their parties; everything the door
 * removed, with why (the conservation law); the basis. Built only by {@link narrowForDoor} — the cast
 * check `scripts/check-narrowed.mjs` finds no `as Narrowed` outside it.
 */
export interface Narrowed {
  readonly ways: readonly ForWay[];
  readonly unavailable: readonly (Unavailable & { readonly party?: Party })[];
  readonly basis: Basis;
  readonly door: { name: string; source: Source };
}

/**
 * A door's renderer table, keyed by verb (PR0-CONTRACT §5, Amendment 4): exhaustive over
 * {@link WayVerb}, so every verb a later PR adds is a compile-time decision in every table. An entry
 * takes ONE way, its basis stamp and the host's static settings — never a record, view, definition,
 * registry, clock or snapshot (the renderer law; the import census and the `Date` ban witness it).
 * A door that never renders a verb returns `null`, with its reason in a comment.
 */
export type WayRenderer<Out, Host> = {
  readonly [V in WayVerb]: (way: WayOf<V>, basis: Basis | undefined, host: Host) => Out | null;
};

/** Whether a way is a `run_step` on a step that is not an agent step (T-13: never the agent's). */
function isEngineStepWay(way: WayOn): boolean {
  return way.verb === 'run_step' && way.brief.execution !== 'agent';
}

/**
 * A way's parties at a door (A-3): WAY_PARTIES[verb] ∩ serves — minus `agent` on a `run_step` way
 * whose step is engine-decided (T-13; Amendment 13, Q4).
 */
function partiesAt(way: WayOn, serves: readonly Party[], row?: AnswersRow): Party[] {
  return WAY_PARTIES[way.verb].filter(
    (party) =>
      serves.includes(party) &&
      !(party === 'agent' && isEngineStepWay(way)) &&
      // #627 W, §5.2 rows 2 and 4: the door withholds the agent's answer.
      !(party === 'agent' && way.verb === 'respond' && withholdsAnswers(row)),
  );
}

/**
 * #627 W: which row of §5.2's table a door's answers setting puts it on — `offered`; `asked` with a
 * client that shows forms; `asked` without (F30's fallback); `withheld`. `undefined` for a door with
 * no answers setting (the CLI, the library): it narrows as PR-0 did.
 */
export type AnswersRow = 'offered' | 'asked_forms' | 'fallback' | 'withheld';
export function answersRowOf(answers: DoorAnswers | undefined): AnswersRow | undefined {
  if (answers === undefined) return undefined;
  if (answers.value === 'offered') return 'offered';
  if (answers.value === 'withheld') return 'withheld';
  return answers.forms.shown ? 'asked_forms' : 'fallback';
}

/** #627 W: the rows where the door removes the agent's `respond` (§5.2's rows 2 and 4). */
function withholdsAnswers(row: AnswersRow | undefined): boolean {
  return row === 'asked_forms' || row === 'withheld';
}

/**
 * #627 W: whether this door hands every question to the person — it serves the agent and its answers
 * row removes the agent from every `respond` (§5.2's rows 2 and 4). The ONE predicate a door reads
 * for a `respond` it renders outside a narrowed list (an error's remedy), so its words agree with
 * {@link narrowForDoor}'s.
 */
export function doorWithholdsAnswers(policy: DoorPolicy): boolean {
  return policy.serves.includes('agent') && withholdsAnswers(answersRowOf(policy.answers));
}

/** #627 W, §5.2 row 3: the fallback's condition — the client asks the person; Realm cannot see it. */
const CLIENT_PROMPT: Cond = { code: 'client_prompt', tag: 'client' };

/**
 * #627 W (§5.2b; Amendment 2): the door's verdict on showing the question again — the ONE predicate
 * the offer (`narrowForDoor`) and the call (the MCP door's `present_question`, R26) both read. The
 * snapshot's codes (the gate open, not due, the definition found) are core's, judged before this;
 * this judges the door's own: a form here at all (`no_form_here`), one already open (`form_open`),
 * asks left (`asks_exhausted`).
 */
export function presentDoorVerdict(
  answers: DoorAnswers | undefined,
  gateId: string,
  facts: DoorFormFacts | undefined,
):
  | { offered: true }
  | { code: 'no_form_here'; facts: FactsOf<'no_form_here'> }
  | { code: 'form_open'; facts: FactsOf<'form_open'> }
  | { code: 'asks_exhausted'; facts: FactsOf<'asks_exhausted'> } {
  if (answersRowOf(answers) !== 'asked_forms')
    return { code: 'no_form_here', facts: { gate_id: gateId } };
  if (facts?.sent_here === 'open') return { code: 'form_open', facts: { gate_id: gateId } };
  if (facts !== undefined && facts.asks_left <= 0) {
    return { code: 'asks_exhausted', facts: { gate_id: gateId, sent: facts.sent } };
  }
  return { offered: true };
}

/**
 * Narrows the ways for one door (D2 D-1, D3 A-3): each way's `for` = its verb's parties ∩ the parties
 * the door serves, minted here and nowhere else; a way whose `for` is empty is listed in
 * `unavailable` with `door_cannot_enact` (per verb); every remedy is narrowed by the same law. The
 * conservation law: every way a door removes is listed, with why.
 *
 * #627 W: a door with an answers setting applies §5.2's four-row table exactly. `offered`: the
 * agent's `respond` kept. `asked` with forms and `withheld`: the agent removed from every `respond`
 * — top-level and nested in a remedy — and each listed once per question as `door_withholds_answers`
 * with party `agent`; the asked person's `respond` stays (its `for` never empties, so it never
 * becomes `door_cannot_enact`). `asked` without forms: kept, with the `client_prompt` condition.
 * `present`, composed by core as `no_form_here` at an open question, is re-judged by the door's own
 * facts (`formFacts`, per gate) on the `asked`-with-forms row only.
 */
export function narrowForDoor(
  composed: { ways: readonly WayOn[]; unavailable: readonly Unavailable[]; basis: Basis },
  policy: DoorPolicy,
  formFacts?: (gateId: string) => DoorFormFacts | undefined,
): Narrowed {
  const row = answersRowOf(policy.answers);
  const ways: ForWay[] = [];
  const removed: (Unavailable & { party?: Party })[] = [];
  const withheld = new Map<string, Unavailable & { party?: Party }>();
  const narrow = (way: WayOn): ForWay => {
    const narrowed = withParties(way, policy.serves, row);
    if (way.verb === 'respond' && withholdsAnswers(row) && policy.serves.includes('agent')) {
      if (!withheld.has(way.gate_id)) {
        withheld.set(way.gate_id, {
          verb: 'respond',
          step: way.step,
          code: 'door_withholds_answers',
          facts: { party: 'agent' },
          remedy: [narrowed],
        });
      }
    }
    return narrowed;
  };
  for (const way of composed.ways) {
    const forParties = partiesAt(way, policy.serves, row);
    // Amendment 13 (Q4): the agent, served here, removed from an engine step's run_step — listed.
    if (isEngineStepWay(way) && policy.serves.includes('agent')) {
      removed.push({ ...doorCannotEnact(way, policy, 'engine_step'), party: 'agent' });
    }
    if (forParties.length > 0) {
      ways.push(narrow(way));
    } else if (!(isEngineStepWay(way) && policy.serves.includes('agent'))) {
      removed.push(doorCannotEnact(way, policy));
    }
  }
  const unavailable: (Unavailable & { party?: Party })[] = [];
  for (const entry of composed.unavailable) {
    if (entry.verb === 'present' && entry.code === 'no_form_here') {
      // #627 W: the door re-judges its own code — on `asked` with forms, from its form facts.
      const verdict = presentDoorVerdict(
        policy.answers,
        entry.facts.gate_id,
        formFacts?.(entry.facts.gate_id),
      );
      if ('offered' in verdict) {
        const respond = entry.remedy.find((w): w is RespondWay => w.verb === 'respond');
        if (respond !== undefined) {
          ways.push(narrow(presentWayOfGate(respond.run_id, entry.facts.gate_id)));
          continue;
        }
      } else if (verdict.code !== 'no_form_here') {
        unavailable.push({
          ...entry,
          code: verdict.code,
          facts: verdict.facts,
          remedy: entry.remedy.map(narrow),
        } as Unavailable);
        continue;
      }
    }
    unavailable.push({ ...entry, remedy: entry.remedy.map(narrow) } as Unavailable);
  }
  return {
    ways,
    unavailable: [...unavailable, ...removed, ...withheld.values()],
    basis: composed.basis,
    door: { name: policy.door, source: policy.source },
  };
}

/** A remedy narrowed for a door: its parties, minted by the same law — and #627 W's row. */
function withParties(way: WayOn, serves: readonly Party[], row?: AnswersRow): ForWay {
  const forParties = partiesAt(way, serves, row);
  if (way.verb === 'respond' && row === 'fallback' && forParties.includes('agent')) {
    // #627 W, §5.2 row 3: kept for the agent with the client's approval prompt (F30).
    return { ...way, conditions: [...way.conditions, CLIENT_PROMPT], for: forParties };
  }
  return { ...way, for: forParties };
}

/** The entry a door lists for a way it cannot enact (the conservation law). */
function doorCannotEnact(way: WayOn, policy: DoorPolicy, reason?: 'engine_step'): Unavailable {
  return {
    verb: way.verb,
    ...('step' in way && typeof way.step === 'string' ? { step: way.step } : {}),
    code: 'door_cannot_enact',
    facts: { door: policy.door, ...(reason !== undefined ? { reason } : {}) },
    remedy: [way],
  };
}

// ─── agent_action (D2 D-8, D3 A-2, D4 T-22) ─────────────────────────────────────────────────────

/** The kinds of reply `agentActionOf` distinguishes (D2 D-8). */
export const REPLY_KINDS = ['ok', 'confirm_required', 'refusal', 'blocked', 'error'] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

/**
 * What the door rendered, as `agentActionOf` reads it: the progress ways it rendered callable for the
 * agent, whether the run has ended, and why nothing is callable when nothing is (the blockers).
 */
export interface RenderedList {
  /** The progress ways the door rendered as callable entries for the agent. */
  readonly callable: readonly ProgressVerb[];
  readonly run_ended: boolean;
  /**
   * T-22 / A-2 row 4's tail: true when the only blockers are a step held elsewhere or a question this
   * door hands off to a person (an await entry) — the run waits on someone else.
   */
  readonly only_waits_on_others: boolean;
}

/**
 * What a door that serves the agent rendered, as {@link agentActionOf} reads it (D-8's third input):
 * the progress ways whose `for` holds the agent (callable), whether the run has ended, and whether
 * the only blockers wait on others — a step held elsewhere (T-22's `await`). Computed from the
 * narrowed ways alone.
 */
export function agentRenderedList(
  narrowed: { readonly ways: readonly ForWay[]; readonly unavailable: readonly Unavailable[] },
  runEnded: boolean,
): RenderedList {
  const callable = narrowed.ways
    .filter(
      (w) => (PROGRESS_VERBS as readonly string[]).includes(w.verb) && w.for.includes('agent'),
    )
    .map((w) => w.verb as ProgressVerb);
  const blockers = narrowed.unavailable.filter(
    (u) => (PROGRESS_VERBS as readonly string[]).includes(u.verb) && u.code !== 'door_cannot_enact',
  );
  // #627 W: a question this door hands off to a person (its `respond` serves the asked person, not
  // the agent — an await entry) waits on someone else: its own entries — the door's removal, the
  // steps it holds, the question's step — are waits, as a step held elsewhere is.
  const handedOff = new Set(
    narrowed.ways
      .filter(
        (w): w is ForWay & RespondWay =>
          w.verb === 'respond' && !w.for.includes('agent') && w.for.includes('asked_person'),
      )
      .map((w) => w.gate_id),
  );
  const waitsOnOthers = (u: Unavailable): boolean => {
    if (u.code === 'held_elsewhere') return true;
    if (u.code === 'door_withholds_answers') return true;
    if (u.code === 'question_open' || u.code === 'gated_step') {
      return handedOff.has(u.facts.gate_id);
    }
    return false;
  };
  return {
    callable,
    run_ended: runEnded,
    only_waits_on_others: blockers.length > 0 && blockers.every(waitsOnOthers),
  };
}

/**
 * The ONE derivation of an agent's `agent_action` (D2 D-8 as D3 A-2's ORDERED table, with D4 T-22):
 *
 * 1. `intrinsic` is the reply's own action word (`EngineReply.intrinsic_action`): an error reply's
 *    `WorkflowError.agentAction`, or `stop` on an `ok` reply at the three ended-run anchors.
 * 2. `ok` / `confirm_required`: none — EXCEPT an intrinsic `stop` passes (C154); and (T-22) an `ok`
 *    reply on a run that has not ended, whose rendered list holds no callable progress way, takes row
 *    4's TAIL: `await` when the only blockers wait on others, `report_to_user` otherwise.
 * 3. An intrinsic `stop`, `provide_input`, `wait_and_proceed` or `wait_for_service` passes through.
 * 4. A blocked or pre-claim refusal reply: `stop` if the run has ended; else `resolve_precondition`
 *    iff a callable progress way is rendered; else `await` if the only blockers wait on others; else
 *    `report_to_user`.
 * 5. An error with intrinsic `resolve_precondition` survives only if a callable progress way is
 *    rendered; else `report_to_user`.
 * 6. Any other intrinsic (`report_to_user`, including the two gate-mismatch errors' fixed one) passes.
 */
export function agentActionOf(
  intrinsic: AgentAction | undefined,
  kind: ReplyKind,
  rendered: RenderedList,
): AgentAction | undefined {
  const callable = rendered.callable.length > 0;
  const tail = (): AgentAction => (rendered.only_waits_on_others ? 'await' : 'report_to_user');
  if (kind === 'ok' || kind === 'confirm_required') {
    if (intrinsic === 'stop') return 'stop';
    if (kind === 'ok' && !rendered.run_ended && !callable) return tail();
    return undefined;
  }
  if (
    intrinsic === 'stop' ||
    intrinsic === 'provide_input' ||
    intrinsic === 'wait_and_proceed' ||
    intrinsic === 'wait_for_service'
  ) {
    return intrinsic;
  }
  if (kind === 'blocked' || kind === 'refusal') {
    if (rendered.run_ended) return 'stop';
    if (callable) return 'resolve_precondition';
    return tail();
  }
  if (intrinsic === 'resolve_precondition')
    return callable ? 'resolve_precondition' : 'report_to_user';
  return intrinsic;
}

// ─── One vocabulary for "another program got there first" (T-1) ────────────────────────────────

/**
 * The kinds of stop a loop meets on a step it picked or ran (T-1: the way codes, one spelling). The
 * first six are races — another program got there first, and the loop goes on with what is left:
 * `held_elsewhere` (another program holds the step, or ran it before this call claimed it),
 * `step_settled` (another program settled the step this call ran), `run_ended`, `claim_removed` (the
 * claim this call held was removed and nobody settled the step: it is owed again), `question_open`,
 * `not_eligible` (the claim's own re-check refused it, and the record shows nothing more). The last
 * three stop the loop: `capability_missing` (this program lacks the step's handler or adapter), and
 * the error kinds `failed` (the record lists the step the reply is about as failed) and `refused`.
 */
export const STOP_KINDS = [
  'held_elsewhere',
  'step_settled',
  'run_ended',
  'claim_removed',
  'question_open',
  'not_eligible',
  'capability_missing',
  'failed',
  'refused',
] as const;
export type StopKind = (typeof STOP_KINDS)[number];

/** The three kinds that stop a loop: what is left does not run. */
export type HaltStopKind = Extract<StopKind, 'capability_missing' | 'failed' | 'refused'>;

/** The six race kinds: another program got there first, and the loop goes on with what is left. */
export type RaceStopKind = Exclude<StopKind, HaltStopKind>;

/**
 * A race: its kind, and whether this call's handler ran and its outcome was not recorded
 * (`ran_here` — true only when the step's own settle was refused: `held_elsewhere`, `step_settled`,
 * `run_ended` or `claim_removed` from `STATE_STEP_ALREADY_SETTLED`, `STATE_CLAIM_LOST` or
 * `STATE_RUN_TERMINAL`).
 */
export interface RaceStop {
  kind: RaceStopKind;
  ran_here: boolean;
}

/** A stop that ends the loop. */
export interface HaltStop {
  kind: HaltStopKind;
}

/** What {@link classifyStop} returns. */
export type StopClassification = RaceStop | HaltStop;

/** The four kinds of a race in which this call's handler ran (`ran_here: true`). */
export type NotRecordedKind = Extract<
  RaceStopKind,
  'held_elsewhere' | 'step_settled' | 'run_ended' | 'claim_removed'
>;

/** Whether `stop` is a race: the loop goes on with what is left. */
export function isRaceStop(stop: StopClassification | undefined): stop is RaceStop {
  return stop !== undefined && 'ran_here' in stop;
}

/** The parts of a reply the classifier reads (T-1: the stop's step is the typed `about`). */
export interface StopReply {
  status: 'ok' | 'error' | 'blocked' | 'confirm_required';
  error_code?: string;
  stopped_step?: string;
  error?: { about?: string };
}

/** The parts of the re-read record the classifier reads. */
export interface StopRecord {
  terminal_state?: boolean;
  pending_gate?: unknown;
  in_progress_steps: readonly string[];
  completed_steps: readonly string[];
  failed_steps: readonly string[];
}

/**
 * The step a refusal is about (T-1): the reply's `stopped_step` (the step whose own reply it is),
 * else the error's typed `about` (a guard of the chain whose settle was refused names no
 * `stopped_step`). `undefined` when it names none.
 */
export function stopAbout(reply: StopReply): string | undefined {
  return reply.stopped_step ?? reply.error?.about;
}

/** The codes of a settle refused because another program acted after this call's claim. */
const SETTLE_RACE_CODES: ReadonlySet<string> = new Set([
  'STATE_STEP_ALREADY_SETTLED',
  'STATE_CLAIM_LOST',
  'STATE_RUN_TERMINAL',
]);

/** The codes of a step this program lacks the code for. */
const CAPABILITY_CODES: ReadonlySet<string> = new Set([
  'ENGINE_HANDLER_NOT_REGISTERED',
  'ENGINE_ADAPTER_NOT_REGISTERED',
]);

/**
 * What kind of stop a loop met on a step it picked or ran (`step`), from the reply and the record
 * RE-READ after it — asked only by a loop (core's advance loop, `realm run advance`, `realm agent`,
 * `realm workflow run`), never of a direct `execute_step` call's own reply, which is the reply.
 * First matching row wins:
 *
 * 1. `blocked`, `STATE_STEP_ALREADY_CLAIMED` → `held_elsewhere`.
 * 2. `blocked` with no code, about `step` (not eligible on the engine's own read, or a failed
 *    precondition): the step in flight, completed or failed → `held_elsewhere`; else the run ended →
 *    `run_ended`; else a question is open → `question_open`; else none (a precondition block —
 *    hosts render it as before).
 * 3. `error`, `STATE_STEP_ALREADY_SETTLED`, `STATE_CLAIM_LOST` or `STATE_RUN_TERMINAL`, about `step`
 *    (`ran_here`): the run not ended and the step in progress → `held_elsewhere`; else the step
 *    settled → `step_settled`; else the run ended → `run_ended`; else → `claim_removed`.
 * 4. `error`, `STATE_STEP_NOT_ELIGIBLE`, about `step` (the claim's re-check): the run ended →
 *    `run_ended`; else a question is open → `question_open`; else → `not_eligible`.
 * 5. `error`, `ENGINE_HANDLER_NOT_REGISTERED` or `ENGINE_ADAPTER_NOT_REGISTERED` →
 *    `capability_missing`.
 * 6. Any other `error`: the record lists the step it is about ({@link stopAbout}) as failed →
 *    `failed`; else → `refused`.
 *
 * `undefined` for any other reply (`ok`, `confirm_required`, a `blocked` reply rows 1–2 do not take).
 */
export function classifyStop(
  reply: StopReply,
  step: string | undefined,
  record: StopRecord,
): StopClassification | undefined {
  const about = stopAbout(reply);
  const ended = record.terminal_state === true;
  const question = !ended && record.pending_gate !== undefined;
  const settled = (s: string) =>
    record.completed_steps.includes(s) || record.failed_steps.includes(s);
  if (reply.status === 'blocked') {
    if (reply.error_code === 'STATE_STEP_ALREADY_CLAIMED')
      return { kind: 'held_elsewhere', ran_here: false };
    if (reply.error_code !== undefined || step === undefined || about !== step) return undefined;
    if (record.in_progress_steps.includes(step) || settled(step)) {
      return { kind: 'held_elsewhere', ran_here: false };
    }
    if (ended) return { kind: 'run_ended', ran_here: false };
    if (question) return { kind: 'question_open', ran_here: false };
    return undefined;
  }
  if (reply.status !== 'error') return undefined;
  const code = reply.error_code;
  if (
    code !== undefined &&
    SETTLE_RACE_CODES.has(code) &&
    step !== undefined &&
    reply.stopped_step === step
  ) {
    if (!ended && record.in_progress_steps.includes(step))
      return { kind: 'held_elsewhere', ran_here: true };
    if (settled(step)) return { kind: 'step_settled', ran_here: true };
    if (ended) return { kind: 'run_ended', ran_here: true };
    return { kind: 'claim_removed', ran_here: true };
  }
  if (code === 'STATE_STEP_NOT_ELIGIBLE' && step !== undefined && reply.stopped_step === step) {
    if (ended) return { kind: 'run_ended', ran_here: false };
    if (question) return { kind: 'question_open', ran_here: false };
    return { kind: 'not_eligible', ran_here: false };
  }
  if (code !== undefined && CAPABILITY_CODES.has(code)) return { kind: 'capability_missing' };
  if (about !== undefined && record.failed_steps.includes(about)) return { kind: 'failed' };
  return { kind: 'refused' };
}

// ─── The composer, the judges and the one admission (PR0-CONTRACT §3; D2 §4; D3 A-4…A-7) ─────────

/**
 * What the judges read besides the snapshot (D2 D-9): the run's definition (or why it is absent), the
 * enactor (this program with its registry, an observer that passed none, or a program whose project
 * code failed to load), and whether the store persists claims (absent ⇒ false, fail closed).
 * `opening_token` is the claim token of the call that OPENED the run's question — passed only by the
 * reply of that call (A-17: `proof` rides only the opening reply). `presented` says whether the
 * reply carries the question's `gate` object.
 */
export interface WaysContext {
  definition:
    | { ok: WorkflowDefinition }
    | {
        absent: DefinitionAbsence;
        workflow_id: string;
        path?: string;
        /** #627 W: `newer` only (W-r2). */
        format?: { schema_version: number; reads_up_to: number };
      };
  enactor:
    | { kind: 'this_program'; registry: ExtensionRegistry }
    | { kind: 'observer' }
    | { kind: 'load_failed'; error_code: LoadErrorCode };
  store: { persistsClaims?: boolean };
  opening_token?: string;
  presented?: 'with_gate' | 'alone';
  /**
   * issue #729 (the Q3 unit): the party whose call this is, when the DOOR knows it (the MCP
   * `execute_step` handler: `'agent'`); absent = the program itself — an embedder, the CLI, the
   * engine — and that absence IS their identity on this axis: no judge treats absence as a party.
   */
  party?: Party;
}

/** The ways on, the ways not available, and what they were judged on. */
export interface ComposedWays {
  ways: WayOn[];
  unavailable: Unavailable[];
  basis: Basis;
}

/** The run's brief of one step (D1 spine 4): what a `run_step` way carries — no registry read. */
export function stepBrief(definition: WorkflowDefinition, run: RunRecord, step: string): StepBrief {
  const def = definition.steps[step];
  const execution = def?.execution === 'agent' ? 'agent' : 'auto';
  const prompt =
    def?.prompt !== undefined
      ? renderTemplate(def.prompt, {
          evidenceByStep: buildEvidenceByStep(run),
          runParams: run.params,
          ...(run.workflow_context_snapshots !== undefined
            ? {
                workflowContext: {
                  snapshots: run.workflow_context_snapshots,
                  wrapper: (definition.context_wrapper ?? 'xml') as ContextWrapperFormat,
                },
              }
            : {}),
        })
      : undefined;
  return {
    execution,
    description: def?.description ?? '',
    ...(prompt !== undefined ? { prompt } : {}),
    ...(execution === 'agent' && def?.input_schema !== undefined
      ? { input_schema: def.input_schema as Record<string, unknown> }
      : {}),
    ...(def?.handler !== undefined ? { handler: def.handler } : {}),
  };
}

/** The basis of a composition (D2 D-9): the snapshot's stamp, the enactor's kind, store and definition. */
export function basisOf(snap: Snapshot, ctx: WaysContext): Basis {
  return {
    ...stampOf(snap),
    enactor:
      ctx.enactor.kind === 'load_failed'
        ? { kind: 'load_failed', error_code: ctx.enactor.error_code }
        : { kind: ctx.enactor.kind },
    store: { persists_claims: ctx.store.persistsClaims === true },
    definition:
      'ok' in ctx.definition
        ? { workflow_id: ctx.definition.ok.id }
        : { absent: ctx.definition.absent },
  };
}

/** The registry the view is judged with: this program's, or none (an observer, or a failed load). */
function registryOf(ctx: WaysContext): ExtensionRegistry | undefined {
  return ctx.enactor.kind === 'this_program' ? ctx.enactor.registry : undefined;
}

/**
 * The operator command an ended run's way on would be — no typed way exists for it yet (T-5;
 * Amendment 13 Q5; Amendment 16 (e): the command mirrors the ending's own prose, `endedRunWayOut`,
 * per ending kind, in its order): `drain` when cleanup steps are left pending; `start` for a run an
 * operator ended ("to run the work again, start a new run"); `resume` when the run failed on a step
 * resume takes; `start` for a completed run (a new run is the way); else `purge` — an aborted run, or
 * a failed one resume takes none of (the prose names the purge preview).
 */
function endedRunCommand(
  run: RunRecord,
  definition: WorkflowDefinition | undefined,
): 'drain' | 'resume' | 'purge' | 'start' {
  if (Object.values(run.finalizer_ledger ?? {}).some((entry) => entry.status === 'pending')) {
    return 'drain';
  }
  const phase = deriveRunPhase(run);
  if (phase === 'abandoned') return 'start';
  if (definition !== undefined && offeredResumeWay(run, definition) !== undefined) return 'resume';
  if (phase === 'completed') return 'start';
  return 'purge';
}

/**
 * The `respond` way of one open gate, from the record alone (decision C103): the gate's id, step,
 * choices and deadline. `holds` is empty — the steps a question holds are read through the
 * definition (`waitingOnAnswer`), which this reads none of. The way a refusal's remedy names, and the
 * way of a host that reads no definition; the composer (`composeWaysOn`) builds the full one.
 */
export function respondWayOfGate(
  runId: string,
  gate: Pick<PendingGate, 'gate_id' | 'step_name' | 'choices' | 'expires_at' | 'on_expiry'>,
): RespondWay {
  return {
    verb: 'respond',
    conditions: [],
    run_id: runId,
    gate_id: gate.gate_id,
    step: gate.step_name,
    choice: { one_of: [...gate.choices] },
    ...(gate.expires_at !== undefined ? { expires_at: gate.expires_at } : {}),
    ...(gate.on_expiry !== undefined ? { on_expiry: gate.on_expiry } : {}),
    holds: [],
    presented: 'alone',
  };
}

/**
 * #627 W (Amendment 2): the `present` way of one open gate — show its question again, as a form. The
 * door offers it (`narrowForDoor`, the `asked`-with-forms row); core composes it as `no_form_here`.
 */
export function presentWayOfGate(runId: string, gateId: string): PresentWay {
  return { verb: 'present', conditions: [], run_id: runId, gate_id: gateId };
}

/** The respond way of the run's open question, from the view (decision C103). */
function respondWayOf(
  run: RunRecord,
  pending: PendingView,
  ctx: WaysContext,
): RespondWay | undefined {
  const question = pending.open_question;
  const gate = run.pending_gate;
  if (question === undefined || gate === undefined) return undefined;
  return {
    verb: 'respond',
    conditions: [],
    run_id: run.id,
    gate_id: question.gate_id,
    step: question.step,
    choice: { one_of: [...question.choices] },
    ...(gate.expires_at !== undefined ? { expires_at: gate.expires_at } : {}),
    ...(gate.on_expiry !== undefined ? { on_expiry: gate.on_expiry } : {}),
    holds: [...(pending.waiting_on_answer ?? [])],
    presented: ctx.presented ?? 'alone',
    ...(ctx.opening_token !== undefined ? { proof: { claim_token: ctx.opening_token } } : {}),
  };
}

/**
 * The respond way as a REMEDY: the same way without its `proof`. A remedy points at the way; the
 * claim's token rides the listed way alone (A-17's one carrier), so it is never repeated.
 */
function asRemedy(respond: RespondWay): RespondWay {
  const { proof: _proof, ...rest } = respond;
  return rest;
}

/** The advance way of what the engine owes, from the view (decision C95: a due expiry first). */
function advanceWayOf(
  run: RunRecord,
  pending: PendingView,
  definition: WorkflowDefinition,
): AdvanceWay | undefined {
  const owed = [...pending.owed];
  if (owed.length === 0) return undefined;
  // C33: a step judged with no registry is offered on the condition that the enactor has its code.
  const conditions: Cond[] = pending.engine_runnable
    .filter((entry) => entry.runnable_here === 'unknown')
    .flatMap((entry) => {
      const def = definition.steps[entry.step];
      const requirement =
        def !== undefined ? requirementForStep(entry.step, def, definition) : undefined;
      return requirement === undefined
        ? []
        : [
            {
              code: 'enactor_has' as const,
              kind: requirement.kind,
              name: requirement.name,
              basis: 'unjudged' as const,
            },
          ];
    });
  return { verb: 'advance', conditions, run_id: run.id, owed };
}

/** A register way for the run's workflow (A-10, T-21). */
function registerWayOf(workflowId: string, runId: string, path?: string): RegisterWay {
  return {
    verb: 'register',
    conditions: [],
    workflow_id: workflowId,
    run_id: runId,
    ...(path !== undefined ? { path } : {}),
  };
}

/**
 * T-20 (v): the run param a refused input comes from — for a step that consumes its `input_map`,
 * the `run.params.<path>` its refused key reads (`run.params.t` → `t`). `undefined` otherwise.
 */
function refusedParamOf(
  def: WorkflowDefinition['steps'][string],
  run: RunRecord,
): string | undefined {
  if (!consumesInputMap(def)) return undefined;
  const field = refusedInputField(def, run);
  if (field === undefined) return undefined;
  const node = (def.input_map as Record<string, unknown>)[field];
  if (typeof node !== 'string') return undefined;
  const path = node.trim();
  return path.startsWith('run.params.') ? path.slice('run.params.'.length) : undefined;
}

/** The claim deadline of a step held elsewhere (T-11): its deadline, or that its age is unknown. */
function heldDeadline(run: RunRecord, step: string): string | { absent: 'unknown_age' } {
  const deadline = run.claims?.[step]?.deadline;
  return typeof deadline === 'string' ? deadline : { absent: 'unknown_age' };
}

/**
 * The `Unavailable` entry of one step the view refuses before its claim or cannot run here (C82):
 * trust, precondition, input schema — remedy `[register]`, plus (T-17) the operator's `run_step`
 * lever for an engine step refused for its input that does not consume its `input_map`, and (T-12)
 * a new run named as an untyped command when a run with other params could change the input; or a
 * capability this program lacks (Amendment 13 Q9) — no way on here.
 */
function refusedEntry(
  entry: EngineRunnable,
  run: RunRecord,
  definition: WorkflowDefinition,
): Unavailable {
  const def = definition.steps[entry.step];
  if (entry.refused_by === 'capability') {
    const requirement =
      def !== undefined ? requirementForStep(entry.step, def, definition) : undefined;
    const req = requirement ?? { kind: 'handler' as const, name: '' };
    return {
      verb: 'run_step',
      step: entry.step,
      code: 'capability_missing',
      facts: {
        step: entry.step,
        requirement: { kind: req.kind, name: req.name },
        basis: entry.basis === 'marker' ? 'marker' : 'registry',
      },
      remedy: [],
      no_remedy: {
        cause: 'requires_other_program',
        requirement: { kind: req.kind, name: req.name },
      },
    };
  }
  const check: RefusedCheck = entry.refused_by ?? 'trust';
  const remedy: WayOn[] = [registerWayOf(definition.id, run.id)];
  const engineStep = def !== undefined && def.execution !== 'agent';
  if (check === 'input_schema' && engineStep && def !== undefined && !consumesInputMap(def)) {
    remedy.push({
      verb: 'run_step',
      conditions: [],
      run_id: run.id,
      step: entry.step,
      brief: stepBrief(definition, run, entry.step),
    });
  }
  const param =
    check === 'input_schema' && def !== undefined ? refusedParamOf(def, run) : undefined;
  const startPossible =
    check === 'input_schema' && engineStep && def !== undefined && newRunCanChangeInput(def, run);
  return {
    verb: 'run_step',
    step: entry.step,
    code: 'refused_before_claim',
    facts: {
      step: entry.step,
      check,
      refusal: entry.refusal ?? '',
      ...(param !== undefined ? { param } : {}),
      ...(entry.precondition !== undefined ? { precondition: entry.precondition } : {}),
    },
    remedy,
    ...(startPossible
      ? { no_remedy: { cause: 'operator_command_untyped' as const, command: 'start' as const } }
      : {}),
  };
}

/**
 * Composes the ways on and the ways not available from ONE snapshot (PR0-CONTRACT §3, D2 §4): the
 * candidates of every verb, judged; then one linking pass (P-4, REMEDY_IS_JUDGED) — a remedy that is
 * neither offered nor listed is judged and placed. Pure; never throws.
 */
export function composeWaysOn(snap: Snapshot, ctx: WaysContext): ComposedWays {
  const run = snap.record;
  const basis = basisOf(snap, ctx);
  const ways: WayOn[] = [];
  const unavailable: Unavailable[] = [];
  const inspect: InspectWay = { verb: 'inspect', conditions: [], run_id: run.id };
  ways.push(inspect);

  if (!('ok' in ctx.definition)) {
    // A-5, T-21: a way that reads the definition is offered only when it can be found.
    const register = registerWayOf(ctx.definition.workflow_id, run.id, ctx.definition.path);
    const facts: FactsOf<'definition_absent'> = {
      workflow_id: ctx.definition.workflow_id,
      cause: ctx.definition.absent,
      ...(ctx.definition.path !== undefined ? { path: ctx.definition.path } : {}),
      ...(ctx.definition.format !== undefined ? { format: ctx.definition.format } : {}),
    };
    ways.push(register);
    if (run.terminal_state) {
      const ended = { phase: deriveRunPhase(run) };
      const noRemedy = {
        cause: 'operator_command_untyped' as const,
        command: endedRunCommand(run, undefined),
      };
      for (const verb of ['advance', 'abandon'] as const) {
        unavailable.push({
          verb,
          code: 'run_ended',
          facts: ended,
          remedy: [],
          no_remedy: noRemedy,
        });
      }
      return { ways, unavailable, basis };
    }
    for (const verb of ['advance', 'run_step'] as const) {
      unavailable.push({ verb, code: 'definition_absent', facts, remedy: [register] });
    }
    // abandon reads no definition: offered, unless a question is open (then the answer is the way
    // on, and it too waits on the definition — listed above, so the remedy is judged).
    const gate = run.pending_gate;
    if (gate !== undefined) {
      const respond: RespondWay = {
        ...respondWayOfGate(run.id, gate),
        presented: ctx.presented ?? 'alone',
      };
      unavailable.push({
        verb: 'respond',
        step: gate.step_name,
        code: 'definition_absent',
        facts,
        remedy: [register],
      });
      // #627 W (Amendment 5): `present` shares respond's snapshot code.
      unavailable.push({
        verb: 'present',
        step: gate.step_name,
        code: 'definition_absent',
        facts,
        remedy: [register],
      });
      unavailable.push({
        verb: 'abandon',
        code: 'question_open',
        facts: {
          step: gate.step_name,
          gate_id: gate.gate_id,
          question_step: gate.step_name,
          choices: [...gate.choices],
        },
        remedy: [respond],
      });
    } else {
      ways.push({ verb: 'abandon', conditions: [], run_id: run.id });
    }
    return { ways, unavailable, basis };
  }

  const definition = ctx.definition.ok;
  if (run.terminal_state) {
    // The run has ended: only reading it is offered; the operator's commands are untyped (T-5;
    // Amendment 15: no progress way answers an ended run — its act is the operator's command).
    const facts = { phase: deriveRunPhase(run) };
    const noRemedy = {
      cause: 'operator_command_untyped' as const,
      command: endedRunCommand(run, definition),
    };
    for (const verb of ['advance', 'abandon'] as const) {
      unavailable.push({ verb, code: 'run_ended', facts, remedy: [], no_remedy: noRemedy });
    }
    return { ways, unavailable, basis };
  }

  const pending = describePending(definition, run, registryOf(ctx), snap.at);
  const respond = respondWayOf(run, pending, ctx);

  // respond — the open question, unless its time is up and it declares on_expiry (C95, Q6).
  if (respond !== undefined) {
    if (pending.expiry_due !== undefined) {
      const advance = advanceWayOf(run, pending, definition);
      const due: Unavailable = {
        verb: 'respond',
        step: respond.step,
        code: 'question_due',
        facts: {
          gate_id: pending.expiry_due.gate_id,
          step: pending.expiry_due.step,
          expires_at: run.pending_gate!.expires_at!,
          on_expiry: pending.expiry_due.on_expiry,
        },
        remedy: advance !== undefined ? [advance] : [],
      };
      // #627 W (Amendment 5): `present` shares respond's snapshot code — its time is up.
      unavailable.push(due, { ...due, verb: 'present' } as Unavailable);
    } else {
      ways.push(respond);
      // #627 W: core sends no form, so `present` is `no_form_here`; the MCP door re-judges it.
      unavailable.push({
        verb: 'present',
        step: respond.step,
        code: 'no_form_here',
        facts: { gate_id: respond.gate_id },
        remedy: [asRemedy(respond)],
      });
    }
  }

  // run_step — every agent step the view offers; every step it refuses (C82); the steps the open
  // question holds (Q7: question_open); every step held elsewhere (T-11).
  const enactorFailed = ctx.enactor.kind === 'load_failed';
  for (const step of pending.agent_steps) {
    if (enactorFailed) continue;
    ways.push({
      verb: 'run_step',
      conditions: [],
      run_id: run.id,
      step,
      brief: stepBrief(definition, run, step),
    });
  }
  for (const entry of pending.cannot_run) unavailable.push(refusedEntry(entry, run, definition));
  if (respond !== undefined && pending.expiry_due === undefined) {
    for (const step of pending.waiting_on_answer ?? []) {
      unavailable.push({
        verb: 'run_step',
        step,
        code: 'question_open',
        facts: {
          step,
          gate_id: respond.gate_id,
          question_step: respond.step,
          choices: respond.choice.one_of,
        },
        remedy: [asRemedy(respond)],
      });
    }
  }
  const held = run.in_progress_steps.filter((step) => step !== run.pending_gate?.step_name);
  for (const step of held) {
    const deadline = heldDeadline(run, step);
    unavailable.push({
      verb: 'run_step',
      step,
      code: 'held_elsewhere',
      facts: { step, deadline },
      ...(typeof deadline === 'string' ? { clears_at: deadline } : {}),
      remedy: [],
      no_remedy: HELD,
    });
  }

  // advance — offered iff something is owed (Amendment 13 Q11); otherwise the most specific why.
  const advance = advanceWayOf(run, pending, definition);
  if (enactorFailed) {
    // A-5: a program whose project code failed to load runs nothing.
    for (const verb of ['advance', 'run_step'] as const) {
      unavailable.push({
        verb,
        code: 'enactor_load_failed',
        facts: { error_code: (ctx.enactor as { error_code: LoadErrorCode }).error_code },
        // Amendment 15: exempt — its facts name the error (A-5).
        remedy: [],
      });
    }
  } else if (advance !== undefined) {
    ways.push(advance);
  } else {
    unavailable.push(advanceUnavailable(run, definition, pending, respond, held, ways));
  }

  // abandon — refused while a question is open (`abandon-run.ts`), remedy [respond]; at a question
  // whose time is up the answer is not offered, and `advance` (carrying out its expiry) closes it.
  if (run.pending_gate !== undefined && respond !== undefined) {
    const answerable = pending.expiry_due === undefined;
    unavailable.push({
      verb: 'abandon',
      code: 'question_open',
      facts: {
        step: respond.step,
        gate_id: respond.gate_id,
        question_step: respond.step,
        choices: respond.choice.one_of,
      },
      remedy:
        answerable || advance === undefined || enactorFailed ? [asRemedy(respond)] : [advance],
    });
  } else {
    ways.push({ verb: 'abandon', conditions: [], run_id: run.id });
  }

  linkRemedies(ways, unavailable);
  return { ways, unavailable, basis };
}

/**
 * The ways of a record a caller already holds (a host that read the run, or wrote it), judged at the
 * caller's reading — `composeWaysOn` on the snapshot the record and that reading make. The judges
 * read the definition, this program's registry (an observer when none is passed: C33) and whether
 * the store keeps claims.
 */
export function composeWaysAt(
  record: RunRecord,
  at: Date,
  input: { definition: WorkflowDefinition; registry?: ExtensionRegistry; persistsClaims?: boolean },
): ComposedWays {
  return composeWaysOn(writtenSnapshot(record, at), {
    definition: { ok: input.definition },
    enactor:
      input.registry !== undefined
        ? { kind: 'this_program', registry: input.registry }
        : { kind: 'observer' },
    store: { persistsClaims: input.persistsClaims === true },
  });
}

/**
 * Why `advance` is not offered on an open run that owes nothing (Amendment 13 Q11), the most specific
 * code first: the open question (remedy `[respond]`); a step held elsewhere; a step refused before
 * its claim or one this program cannot run; else `not_eligible { reason: 'nothing_owed' }`, whose
 * remedies are the run_step ways offered (the agent's steps are the way on).
 */
function advanceUnavailable(
  run: RunRecord,
  definition: WorkflowDefinition,
  pending: PendingView,
  respond: RespondWay | undefined,
  held: readonly string[],
  ways: readonly WayOn[],
): Unavailable {
  if (respond !== undefined) {
    return {
      verb: 'advance',
      code: 'question_open',
      facts: {
        step: respond.step,
        gate_id: respond.gate_id,
        question_step: respond.step,
        choices: respond.choice.one_of,
      },
      remedy: [asRemedy(respond)],
    };
  }
  const offeredSteps = ways.filter((w): w is RunStepWay => w.verb === 'run_step');
  if (offeredSteps.length === 0 && held.length > 0) {
    const step = held[0]!;
    const deadline = heldDeadline(run, step);
    return {
      verb: 'advance',
      step,
      code: 'held_elsewhere',
      facts: { step, deadline },
      ...(typeof deadline === 'string' ? { clears_at: deadline } : {}),
      remedy: [],
      no_remedy: HELD,
    };
  }
  // A step that cannot run: advance is refused with that step's own entry — its check, its
  // remedies (correct the workflow; the operator's lever; a new run only where one can help).
  const refused = pending.cannot_run.find((e) => e.refused_by !== 'capability');
  if (offeredSteps.length === 0 && refused !== undefined) {
    return { ...refusedEntry(refused, run, definition), verb: 'advance' };
  }
  const missing = pending.cannot_run.find((e) => e.refused_by === 'capability');
  if (offeredSteps.length === 0 && missing !== undefined) {
    const entry = refusedEntry(missing, run, definition);
    return { ...entry, verb: 'advance' };
  }
  // Amendment 15: the agent's steps are the way on; else nothing is left to do.
  return {
    verb: 'advance',
    code: 'not_eligible',
    facts: { reason: 'nothing_owed' },
    remedy: offeredSteps,
    ...(offeredSteps.length === 0 ? { no_remedy: { cause: 'already_settled' as const } } : {}),
  };
}

/**
 * The identity of a way, for linking: its verb and its target. An engine step's `run_step` is the
 * operator's lever (T-17) — a way of its own, distinct from the engine running that step.
 */
function wayKey(way: WayOn): string {
  switch (way.verb) {
    case 'respond':
      return `respond:${way.gate_id}`;
    case 'run_step':
      return way.brief.execution === 'agent'
        ? `run_step:${way.step}`
        : `run_step:${way.step}:lever`;
    case 'register':
      return `register:${way.workflow_id}`;
    default:
      return way.verb;
  }
}

/** The identity of a listed entry, in {@link wayKey}'s terms. */
function listedKey(u: Unavailable): string {
  if (u.verb === 'respond') {
    const gate =
      'gate_id' in u.facts && typeof u.facts.gate_id === 'string' ? u.facts.gate_id : undefined;
    return gate !== undefined ? `respond:${gate}` : 'respond';
  }
  return u.step !== undefined ? `${u.verb}:${u.step}` : u.verb;
}

/**
 * The linking pass (P-4, REMEDY_IS_JUDGED): every remedy is offered or listed. A `register` remedy is
 * offered (it has no JUDGE, A-10); an operator's `run_step` lever (T-17) is offered for the operator
 * (the narrowing keeps it from the agent, Q4); any other remedy is already judged by its verb above.
 */
function linkRemedies(ways: WayOn[], unavailable: readonly Unavailable[]): void {
  const offered = new Set(ways.map(wayKey));
  const listed = new Set(unavailable.map(listedKey));
  for (const entry of unavailable) {
    for (const remedy of entry.remedy) {
      const key = wayKey(remedy);
      if (offered.has(key) || listed.has(key)) continue;
      if (
        remedy.verb === 'register' ||
        (remedy.verb === 'run_step' && remedy.brief.execution !== 'agent')
      ) {
        ways.push(remedy);
        offered.add(key);
      }
    }
  }
}

/** What a caller asked for, by verb (the arguments `ARGS[verb]` checks). */
export type WayInput = Readonly<Record<string, unknown>>;

/** Admitted, or why not. */
export type Admission = { ok: true } | Unavailable;

/**
 * The input code (P-5): an argument outside the verb's contract — an unknown argument, a required one
 * missing, or one of the wrong type. `undefined` when the input fits `ARGS[verb]`.
 */
function argumentOutOfContract(verb: WayVerb, input: WayInput): Unavailable | undefined {
  const spec = ARGS[verb];
  for (const [arg, value] of Object.entries(input)) {
    const rule = spec[arg];
    if (rule === undefined) return outOfContract(verb, arg);
    if (value === undefined) continue;
    const ok =
      rule.type === 'object'
        ? typeof value === 'object' && value !== null && !Array.isArray(value)
        : typeof value === rule.type;
    if (!ok) return outOfContract(verb, arg);
  }
  for (const [arg, rule] of Object.entries(spec)) {
    if (rule.required && input[arg] === undefined) return outOfContract(verb, arg);
  }
  return undefined;
}

function outOfContract(verb: WayVerb, arg: string): Unavailable {
  return { verb, code: 'argument_out_of_contract', facts: { arg }, remedy: [] };
}

/** The listed entry for a verb and target in a composition, if any. */
function listed(composed: ComposedWays, verb: WayVerb, step?: string): Unavailable | undefined {
  return composed.unavailable.find(
    (u) => u.verb === verb && (step === undefined || u.step === step),
  );
}

/**
 * Why a step named by a caller cannot be run now (PR0-CONTRACT §1's run_step codes, in the order of
 * #625's `notCallableReason`; Amendment 13 Q7: its own question vs another's are two codes; A-7: a
 * guard or cleanup step is the engine's). `undefined` when the step is eligible — its pre-claim
 * checks and its claim then decide.
 */
function judgeStepByName(
  snap: Snapshot,
  definition: WorkflowDefinition,
  pending: PendingView,
  composed: ComposedWays,
  step: string,
): Unavailable | undefined {
  const run = snap.record;
  const remedy = composed.ways.filter((w) =>
    (PROGRESS_VERBS as readonly string[]).includes(w.verb),
  );
  const def = definition.steps[step];
  if (def === undefined) {
    return {
      verb: 'run_step',
      step,
      code: 'not_a_step',
      facts: { step, workflow_id: definition.id },
      remedy,
    };
  }
  if (run.terminal_state) {
    return {
      verb: 'run_step',
      step,
      code: 'run_ended',
      facts: { phase: deriveRunPhase(run) },
      remedy: [],
      no_remedy: { cause: 'operator_command_untyped', command: endedRunCommand(run, definition) },
    };
  }
  const outcome = run.completed_steps.includes(step)
    ? 'completed'
    : run.failed_steps.includes(step)
      ? 'failed'
      : run.skipped_steps.includes(step)
        ? 'skipped'
        : undefined;
  if (outcome !== undefined) {
    return {
      verb: 'run_step',
      step,
      code: 'step_settled',
      facts: { step, outcome },
      remedy: [],
      no_remedy: { cause: 'already_settled' },
    };
  }
  if (def.execution === 'guard' || def.execution === 'finalizer') {
    const advance = composed.ways.filter((w) => w.verb === 'advance');
    return {
      verb: 'run_step',
      step,
      code: 'step_engine_decided',
      facts: { step, execution: def.execution },
      remedy: advance,
      ...(advance.length === 0
        ? { no_remedy: { cause: 'engine_runs_it_when_owed' as const } }
        : {}),
    };
  }
  const gate = run.pending_gate;
  if (pending.expiry_due !== undefined) {
    const due = listed(composed, 'respond');
    return {
      verb: 'run_step',
      step,
      code: 'question_due',
      facts: {
        gate_id: pending.expiry_due.gate_id,
        step: pending.expiry_due.step,
        expires_at: gate?.expires_at ?? '',
        on_expiry: pending.expiry_due.on_expiry,
      },
      remedy: due?.remedy ?? [],
    };
  }
  const question = pending.open_question;
  if (question !== undefined) {
    const respond = composed.ways.filter((w) => w.verb === 'respond');
    return question.step === step
      ? {
          verb: 'run_step',
          step,
          code: 'gated_step',
          facts: { step, gate_id: question.gate_id, choices: [...question.choices] },
          remedy: respond,
        }
      : {
          verb: 'run_step',
          step,
          code: 'question_open',
          facts: {
            step,
            gate_id: question.gate_id,
            question_step: question.step,
            choices: [...question.choices],
          },
          remedy: respond,
        };
  }
  if (run.in_progress_steps.includes(step)) {
    const deadline = heldDeadline(run, step);
    return {
      verb: 'run_step',
      step,
      code: 'held_elsewhere',
      facts: { step, deadline },
      ...(typeof deadline === 'string' ? { clears_at: deadline } : {}),
      remedy: [],
      no_remedy: HELD,
    };
  }
  const settled = new Set([...run.completed_steps, ...run.failed_steps, ...run.skipped_steps]);
  const unsettled = (name: string): string[] =>
    (definition.steps[name]?.depends_on ?? []).filter((d) => !settled.has(d));
  const above: string[] = [];
  const queue = unsettled(step);
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (above.includes(next)) continue;
    above.push(next);
    queue.push(...unsettled(next));
  }
  const cannot = pending.cannot_run.map((e) => e.step).filter((s) => above.includes(s));
  if (cannot.length > 0) {
    // Amendment 15: the fix is upstream (T-20 (v)) — the upstream steps' own entries' act.
    return {
      verb: 'run_step',
      step,
      code: 'upstream_cannot_run',
      facts: { step, upstream: cannot },
      ...(entriesAct(cannot, composed) ?? { remedy: [] }),
    };
  }
  const direct = unsettled(step);
  if (direct.length > 0) {
    // Amendment 15: the ways on its direct dependencies, else their entries' act (upstream's rule);
    // a dependency that is itself waiting leads to the ways on the steps above it.
    return {
      verb: 'run_step',
      step,
      code: 'deps_unsettled',
      facts: { step, deps: direct },
      ...(waysOnSteps(direct, composed) ??
        entriesAct(direct, composed) ??
        waysOnSteps(above, composed) ??
        entriesAct(above, composed) ?? { remedy: [] }),
    };
  }
  const eligible = findEligibleSteps(definition, run);
  if (!eligible.includes(step)) {
    // Amendment 15: the progress ways, else the stuck steps' own act (T-22's run), else nothing is
    // left to do.
    const stuck = composed.unavailable
      .filter(
        (u) =>
          u.verb === 'run_step' &&
          (u.code === 'refused_before_claim' || u.code === 'capability_missing'),
      )
      .map((u) => u.step!);
    return {
      verb: 'run_step',
      step,
      code: 'not_eligible',
      facts: { step },
      ...(remedy.length > 0
        ? { remedy }
        : (entriesAct(stuck, composed) ?? {
            remedy: [],
            no_remedy: { cause: 'already_settled' as const },
          })),
    };
  }
  return undefined;
}

/** A refusal's act (Amendment 15): its remedies, and why none is offered when that is named. */
type Act = { remedy: WayOn[]; no_remedy?: NoRemedy };

/**
 * The ways on some steps (Amendment 15's `deps_unsettled` row): a `run_step` on one of them that is
 * offered, an `advance` that owes one of them. `undefined` when none is offered.
 */
function waysOnSteps(steps: readonly string[], composed: ComposedWays): Act | undefined {
  const ways = composed.ways.filter(
    (w) =>
      (w.verb === 'run_step' && steps.includes(w.step)) ||
      (w.verb === 'advance' && w.owed.some((o) => 'step' in o && steps.includes(o.step))),
  );
  return ways.length > 0 ? { remedy: ways } : undefined;
}

/**
 * The act of some steps' own entries (Amendment 15's upstream rule): their remedies, deduplicated, and
 * the first why-absent among them. `undefined` when none of them is listed with an act.
 */
function entriesAct(steps: readonly string[], composed: ComposedWays): Act | undefined {
  const entries = composed.unavailable.filter(
    (u) => u.verb === 'run_step' && u.step !== undefined && steps.includes(u.step),
  );
  const remedy: WayOn[] = [];
  for (const way of entries.flatMap((u) => u.remedy)) {
    if (!remedy.some((w) => wayKey(w) === wayKey(way))) remedy.push(way);
  }
  const why = entries.find((u) => u.no_remedy !== undefined)?.no_remedy;
  if (remedy.length === 0 && why === undefined) return undefined;
  return { remedy, ...(why !== undefined ? { no_remedy: why } : {}) };
}

/**
 * Why an answer to `gateId` is not admitted (PR0-CONTRACT §1's respond codes): the run has ended
 * (`run_ended`, remedy `[inspect]`, no typed way on — T-5); the gate was settled already
 * (`question_settled`); the gate is not the open one (`gate_not_open`, input-tagged — its remedy
 * the open question's answer, or what carries out its expiry when its time is up, else `[inspect]`);
 * the open gate itself, offered, admits; listed (its time is up, or the definition cannot be read),
 * its entry.
 */
function judgeRespond(
  snap: Snapshot,
  ctx: WaysContext,
  composed: ComposedWays,
  gateId: string,
): Admission {
  const run = snap.record;
  const inspect = composed.ways.filter((w) => w.verb === 'inspect');
  if (run.terminal_state) {
    return {
      verb: 'respond',
      code: 'run_ended',
      facts: { phase: deriveRunPhase(run) },
      remedy: [],
      no_remedy: {
        cause: 'operator_command_untyped',
        command: endedRunCommand(run, 'ok' in ctx.definition ? ctx.definition.ok : undefined),
      },
    };
  }
  const gate = run.pending_gate;
  if (gate !== undefined && gate.gate_id === gateId) {
    if (composed.ways.some((w) => w.verb === 'respond' && w.gate_id === gateId))
      return { ok: true };
    const entry = listed(composed, 'respond');
    if (entry !== undefined) return entry;
  }
  const settled = Object.values(run.settled ?? {}).some(
    (e) => e.outcome === 'gate' && e.token === gateId,
  );
  if (settled) {
    // Amendment 15: the progress ways, else nothing is left to do about it (`outcome` says how).
    const progress = composed.ways.filter((w) =>
      (PROGRESS_VERBS as readonly string[]).includes(w.verb),
    );
    return {
      verb: 'respond',
      code: 'question_settled',
      facts: { gate_id: gateId },
      remedy: progress,
      ...(progress.length === 0 ? { no_remedy: { cause: 'already_settled' as const } } : {}),
    };
  }
  const answer = composed.ways.filter((w) => w.verb === 'respond');
  const due = listed(composed, 'respond');
  return {
    verb: 'respond',
    ...(gate !== undefined ? { step: gate.step_name } : {}),
    code: 'gate_not_open',
    facts: {
      gate_id: gateId,
      ...(gate !== undefined ? { open_gate: { gate_id: gate.gate_id, step: gate.step_name } } : {}),
    },
    remedy:
      answer.length > 0
        ? answer
        : due !== undefined && due.remedy.length > 0
          ? due.remedy
          : inspect,
  };
}

/**
 * #627 W: may the agent be shown the question on gate `gateId` again (Amendment 15's acts, `present`
 * in place of `respond`)? On the snapshot: the run ended → `run_ended` (the operator's command, per
 * its ending); the open gate → its listed `present` entry — `no_form_here` (core sends no form; the
 * MCP door re-judges its own code, `presentDoorVerdict`), `question_due` (`[advance]`) or
 * `definition_absent`; a settled gate → `question_settled` (the progress ways, else
 * `already_settled`); else → `gate_not_open` (`[present <the open gate>]` when one is open, else
 * `[inspect]`). `question_past_deadline` is WRITE-tagged and `present` performs no settle, so it is
 * none of `present`'s codes.
 */
function judgePresent(
  snap: Snapshot,
  ctx: WaysContext,
  composed: ComposedWays,
  gateId: string,
): Admission {
  const run = snap.record;
  if (run.terminal_state) {
    return {
      verb: 'present',
      code: 'run_ended',
      facts: { phase: deriveRunPhase(run) },
      remedy: [],
      no_remedy: {
        cause: 'operator_command_untyped',
        command: endedRunCommand(run, 'ok' in ctx.definition ? ctx.definition.ok : undefined),
      },
    };
  }
  const gate = run.pending_gate;
  if (gate !== undefined && gate.gate_id === gateId) {
    const entry = listed(composed, 'present');
    if (entry !== undefined) return entry;
  }
  const settled = Object.values(run.settled ?? {}).some(
    (e) => e.outcome === 'gate' && e.token === gateId,
  );
  if (settled) {
    const progress = composed.ways.filter((w) =>
      (PROGRESS_VERBS as readonly string[]).includes(w.verb),
    );
    return {
      verb: 'present',
      code: 'question_settled',
      facts: { gate_id: gateId },
      remedy: progress,
      ...(progress.length === 0 ? { no_remedy: { cause: 'already_settled' as const } } : {}),
    };
  }
  const inspect = composed.ways.filter((w) => w.verb === 'inspect');
  return {
    verb: 'present',
    ...(gate !== undefined ? { step: gate.step_name } : {}),
    code: 'gate_not_open',
    facts: {
      gate_id: gateId,
      ...(gate !== undefined ? { open_gate: { gate_id: gate.gate_id, step: gate.step_name } } : {}),
    },
    remedy: gate !== undefined ? [presentWayOfGate(run.id, gate.gate_id)] : inspect,
  };
}

/**
 * The one admission (D3 A-6; R26): is this call — `verb` with `input` — admitted on this snapshot?
 * The caller's arguments first (P-5's input code), then the verb's judge on the snapshot: what
 * `composeWaysOn` offers is admitted, what it lists is refused with that entry, and a step named by
 * a caller is judged by name. Runs as the first statement after an entry's load; the store's
 * transform repeats the write-time checks on the locked copy (`claim_removed`,
 * `question_past_deadline`).
 *
 * Amendment 13 (Q3 HELD for the owner): an eligible `auto` step a caller names is admitted as today —
 * never offered (`advance` is the act) — and listed in PR-0's report.
 */
export function admitWay(
  verb: WayVerb,
  snap: Snapshot,
  ctx: WaysContext,
  input: WayInput,
): Admission {
  const contract = argumentOutOfContract(verb, input);
  if (contract !== undefined) return withSameWay(contract, verb, input, composeWaysOn(snap, ctx));
  if (verb === 'inspect' || verb === 'register') return { ok: true };
  return judgeAdmission(verb, snap, ctx, input, composeWaysOn(snap, ctx));
}

/**
 * Amendment 15: an argument outside the verb's contract — the way's offer did not fail, the input
 * did — leads on to the SAME way re-offered, its arguments `ARGS[verb]` (INPUT_IN_CONTRACT_ADMITTED):
 * the offered ways of the verb, narrowed to the call's target when it named one that is offered.
 * When the verb offers none, the verb's own listed entry says what does lead on (its remedies, its
 * why); failing that, `advance`'s — offered, or listed with its own — which every open run has.
 */
function withSameWay(
  contract: Unavailable,
  verb: WayVerb,
  input: WayInput,
  composed: ComposedWays,
): Unavailable {
  const ofVerb = composed.ways.filter((w) => w.verb === verb);
  const target = ofVerb.filter((w) =>
    w.verb === 'respond'
      ? w.gate_id === input['gate_id']
      : w.verb === 'run_step'
        ? w.step === input['command']
        : false,
  );
  const same = target.length > 0 ? target : ofVerb;
  if (same.length > 0) return { ...contract, remedy: same };
  const entry = listed(composed, verb) ?? listed(composed, 'advance');
  const advance = composed.ways.filter((w) => w.verb === 'advance');
  if (entry === undefined) return { ...contract, remedy: advance };
  return {
    ...contract,
    remedy: entry.remedy,
    ...(entry.no_remedy !== undefined ? { no_remedy: entry.no_remedy } : {}),
  };
}

/** {@link admitWay}'s verdict on a call whose arguments fit, judged on the composition. */
function judgeAdmission(
  verb: WayVerb,
  snap: Snapshot,
  ctx: WaysContext,
  input: WayInput,
  composed: ComposedWays,
): Admission {
  if (verb === 'advance' || verb === 'abandon') {
    if (composed.ways.some((w) => w.verb === verb)) return { ok: true };
    return (
      listed(composed, verb) ?? {
        verb,
        code: 'not_eligible',
        facts: { reason: 'nothing_owed' },
        remedy: [],
        no_remedy: { cause: 'already_settled' },
      }
    );
  }
  if (verb === 'respond') {
    return judgeRespond(snap, ctx, composed, String(input['gate_id']));
  }
  if (verb === 'present') {
    return judgePresent(snap, ctx, composed, String(input['gate_id']));
  }
  // run_step
  const step = String(input['command']);
  if (
    composed.ways.some(
      (w) => w.verb === 'run_step' && w.step === step && w.brief.execution === 'agent',
    )
  ) {
    return { ok: true };
  }
  if (!('ok' in ctx.definition)) return listed(composed, 'run_step')!;
  if (ctx.enactor.kind === 'load_failed') {
    return composed.unavailable.find(
      (u) => u.verb === 'run_step' && u.code === 'enactor_load_failed',
    )!;
  }
  const definition = ctx.definition.ok;
  const pending = describePending(definition, snap.record, registryOf(ctx), snap.at);
  const byName = judgeStepByName(snap, definition, pending, composed, step);
  if (byName !== undefined) return byName;
  const refused = composed.unavailable.find(
    (u) => u.verb === 'run_step' && u.step === step && u.code !== 'door_cannot_enact',
  );
  // issue #729 (the Q3 unit; R26, T-13, PR-2a's "advance is the act"): an AGENT's by-name call on an
  // eligible engine step is the engine's — refused and told to advance, before T-17's lever (the
  // lever is never the agent's). Only the agent party: an absent party is the program itself.
  if (ctx.party === 'agent' && definition.steps[step]?.execution === 'auto') {
    // the step's own fault first: a pre-claim refusal names why the workflow is wrong (tools.md:306)
    if (refused?.code === 'refused_before_claim') return refused;
    const advance = composed.ways.filter((w) => w.verb === 'advance');
    if (advance.length > 0) {
      return {
        verb: 'run_step',
        step,
        code: 'step_engine_decided',
        facts: { step, execution: 'auto' },
        remedy: advance,
      };
    }
    // Amendment 16's chain: `advance` not offered — its LISTED entry says what leads on (a capability
    // this program lacks: `no_remedy: requires_other_program`); only with no listed entry is the
    // cause the engine's own.
    const entry = listed(composed, 'advance');
    return {
      verb: 'run_step',
      step,
      code: 'step_engine_decided',
      facts: { step, execution: 'auto' },
      remedy: entry?.remedy ?? [],
      // the listed entry's own why when it has one (a remedy that leads on needs none);
      // the engine's cause only with no listed entry at all
      ...(entry === undefined
        ? { no_remedy: { cause: 'engine_runs_it_when_owed' as const } }
        : entry.no_remedy !== undefined
          ? { no_remedy: entry.no_remedy }
          : {}),
    };
  }
  // T-17's lever (INPUT_IN_CONTRACT_ADMITTED, D4 P-5): an engine step refused for its input, whose
  // lever is offered, is admitted with input that fits its input_schema — judged by the same
  // pre-claim checks the dispatch runs (`checkPreClaim`; a capability stays the dispatch's, C4).
  const params = input['params'];
  if (
    refused?.code === 'refused_before_claim' &&
    refused.facts.check === 'input_schema' &&
    typeof params === 'object' &&
    params !== null &&
    composed.ways.some(
      (w) => w.verb === 'run_step' && w.step === step && w.brief.execution !== 'agent',
    )
  ) {
    const verdict = checkPreClaim({
      definition,
      run: snap.record,
      step,
      input: params as Record<string, unknown>,
    });
    if (verdict === undefined || !('refused_by' in verdict)) return { ok: true };
  }
  return refused ?? { ok: true };
}

// ─── Who supplied an entry's input (T-17 (ii)) ──────────────────────────────────────────────────

/**
 * The supplier of an evidence entry's input or output (#729 PR-0, T-17 (ii); §5 E1 (ii)): its
 * recorded role, or why it names none — `engine_input` for an entry whose input the engine built
 * (any step that is not an agent step), `not_recorded` for an agent step's entry written before the
 * field.
 */
export function readSupplier(
  entry: Pick<EvidenceSnapshot, 'supplied_by' | 'step_id' | 'kind'>,
  definition: Pick<WorkflowDefinition, 'steps'> | undefined,
): { role: SupplierRole } | { absent: SupplierAbsentCause } {
  if (entry.supplied_by !== undefined) return { role: entry.supplied_by };
  const agentStep = definition?.steps[entry.step_id]?.execution === 'agent';
  return { absent: agentStep && entry.kind !== 'gate_response' ? 'not_recorded' : 'engine_input' };
}

// ─── When a run cannot go on (C44, C64, C82) — read from a composition ──────────────────────────

/**
 * When nothing can go on from here (decisions C64, C82), read from a composition's ways: the run
 * has not ended, no question is open or due, nothing is owed, no agent step is offered, nothing is
 * held elsewhere — and a step cannot run (refused before its claim, or a capability). Every door
 * reads this one predicate.
 */
export function cannotGoOnFrom(composed: {
  readonly ways: readonly WayOn[];
  readonly unavailable: readonly Unavailable[];
}): boolean {
  if (composed.unavailable.some((u) => u.code === 'run_ended')) return false;
  if (composed.ways.some((w) => w.verb === 'respond' || w.verb === 'advance')) return false;
  if (composed.ways.some((w) => w.verb === 'run_step' && w.brief.execution === 'agent')) {
    return false;
  }
  if (composed.unavailable.some((u) => u.verb === 'respond' || u.code === 'held_elsewhere')) {
    return false;
  }
  return composed.unavailable.some(
    (u) =>
      u.verb === 'run_step' &&
      (u.code === 'refused_before_claim' || u.code === 'capability_missing'),
  );
}

/**
 * When the run cannot go on until its workflow is corrected (decisions C44, C51): it cannot go on
 * from here ({@link cannotGoOnFrom}) and a step is refused before its claim — a capability refusal
 * is not one: another runner can run that step.
 */
export function cannotGoOnUntilCorrected(composed: {
  readonly ways: readonly WayOn[];
  readonly unavailable: readonly Unavailable[];
}): boolean {
  return (
    cannotGoOnFrom(composed) &&
    composed.unavailable.some((u) => u.verb === 'run_step' && u.code === 'refused_before_claim')
  );
}

// ─── The library door's words (PR0-CONTRACT §5) ─────────────────────────────────────────────────

/** The library door's static settings: none yet — an embedder decides what to show. */
export type LibraryHost = Readonly<Record<string, never>>;

/**
 * The library door's words for each way (PR0-CONTRACT §5): what an embedder calls to take it — the
 * library's own functions, never a CLI command or an MCP tool. Applied by embedders to a reply's
 * `ways`; never imported by core's composers (the witness reads that). A way's words come from the
 * way alone (the renderer law).
 */
export const LIBRARY_WORDS: WayRenderer<string, LibraryHost> = {
  respond: (way) =>
    `answer the question on step '${way.step}' (gate '${way.gate_id}') with submitHumanResponse, choosing one of: ${way.choice.one_of.join(', ')}`,
  run_step: (way) =>
    way.brief.execution === 'agent'
      ? `run step '${way.step}' with executeStep, passing its answer as the input`
      : // T-17's lever (PR0-CONTRACT Amendment 14): the library is where an operator's input is supplied.
        `supply step '${way.step}''s input with executeStep — an operator's input, checked against its input_schema`,
  advance: (way) =>
    `run what the engine owes (${way.owed.map((o) => ('expiry' in o ? `the expired question on '${o.expiry.step}'` : `'${o.step}'`)).join(', ')}) with advanceRun`,
  inspect: (way) => `read run '${way.run_id}' from its store`,
  abandon: (way) => `end run '${way.run_id}' with abandonRun`,
  register: (way) =>
    `register workflow '${way.workflow_id}' again${way.path !== undefined ? ` from ${way.path}` : ' from its file'}`,
  // #627 W (Amendment 4): the library sends no form; a library reply lists `present` as
  // `unavailable` (`no_form_here`), so this entry renders only a way a door offered.
  present: (way) =>
    `the question on gate '${way.gate_id}' of run '${way.run_id}' is shown again only by an MCP server whose client shows forms (present_question)`,
};

/**
 * The library door's words for why a step cannot run (C36, C41, C53) — `'<s>' cannot run
 * (<check>): <refusal>`; a capability this program lacks says so with its way out, one judged from
 * the run's marker is past tense. `undefined` for an entry that is not a step that cannot run.
 */
export function libraryCannotRunWords(entry: Unavailable): string | undefined {
  if (entry.code === 'capability_missing') {
    const { kind, name } = entry.facts.requirement;
    return entry.facts.basis === 'marker'
      ? `'${entry.facts.step}' could not run (capability): ${kind} '${name}' was not registered in the runner that last attempted it`
      : `'${entry.facts.step}' cannot run here (capability): ${kind} '${name}' is not registered here — load the missing extension, or run the step on a runner that has it`;
  }
  if (entry.code === 'refused_before_claim') {
    return `'${entry.facts.step}' cannot run (${entry.facts.check}): ${entry.facts.refusal}`;
  }
  return undefined;
}
