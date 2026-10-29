// pending.ts — what a run owes, read from its record (issue #625 PR-2a).
//
// ONE place says which agent steps are ready, which guards are pending, which `auto` steps the
// engine could run, and — when engine work is owed — what it owes (`owed`, the `advance` way's list).
// Pure: no I/O, never throws. The ways (`ways.ts`) are composed from this view; #729 PR-0 moved every
// instruction and way sentence out of it — the doors word the ways.
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import { classifyStepTrust, buildTrustRefusal } from '../types/workflow-definition.js';
import type { RunRecord, PendingGate } from '../types/run-record.js';
import type { ExtensionRegistry } from '../extensions/registry.js';
import type { ExtensionIdentityEntry } from '../types/extension-identity.js';
import { extensionIdentityDiffers, lastExecutionIdentity } from '../types/extension-identity.js';
import { WorkflowError } from '../types/workflow-error.js';
import {
  findEligibleSteps,
  findEligibleGuardSteps,
  buildEvidenceByStep,
  deriveRunPhase,
} from './eligibility.js';
import { RESUMABLE_PHASES } from './lifecycle.js';
import { escapedBoundedValue } from '../utils/redaction.js';
import { NAMES_SHOWN, listWords, quotedNames } from '../utils/list-words.js';
import { shellWord } from '../utils/shell-word.js';
import { checkPreconditions, preconditionHint, preconditionRefusal } from './precondition.js';
import { validateInputSchema } from '../validation/input-schema.js';
import {
  describeValidationProblems,
  renderProblemsSentence,
  validationFactsOfError,
} from '../validation/validation-problems.js';
import { consumesInputMap, resolveInputMap } from './input-map.js';
import { capabilityRefusalWords, requirementForStep } from './capability.js';
import { isPastDeadline } from './instants.js';
import { readDrivenBy, type Attributed, type ActorAbsent } from './holder.js';

/** The checks that refuse a step before it is claimed, in the order `executeStep` runs them. */
export const PRE_CLAIM_REFUSALS = ['trust', 'precondition', 'input_schema', 'capability'] as const;
export type PreClaimRefusal = (typeof PRE_CLAIM_REFUSALS)[number];

/**
 * The checks of {@link checkPreClaim} that read no input (decision C82): an agent step's input is the
 * agent's own answer, which does not exist until the agent answers, so the run's view judges an
 * eligible AGENT step by these members alone — never by its input schema. (A capability requirement
 * belongs to `auto` steps only.)
 */
export const AGENT_PRE_CLAIM_REFUSALS = ['trust', 'precondition'] as const;
export type AgentPreClaimRefusal = (typeof AGENT_PRE_CLAIM_REFUSALS)[number];

/**
 * What a capability refusal was judged from (decision C41): `registry` — the caller's own registry
 * lacks the handler or adapter; `marker` — the caller passed no registry, so the run's own
 * `capability_blocks` marker (what the runner that last attempted the step lacked) is the fact.
 */
export const CAPABILITY_BASES = ['registry', 'marker'] as const;
export type CapabilityBasis = (typeof CAPABILITY_BASES)[number];

/** A refusal before the claim. `error` / `hint` carry what `executeStep` returns. */
export interface PreClaimRefused {
  refused_by: PreClaimRefusal;
  refusal: string;
  /** capability only: what the refusal was judged from (decision C41). */
  basis?: CapabilityBasis;
  /**
   * capability only (#872 (a)): the handler or adapter refused — this registry's requirement, or
   * the one the run's marker records (`basis: 'marker'`).
   */
  requirement?: { kind: 'handler' | 'adapter'; name: string };
  /** trust and input_schema: the error `executeStep` returns, unchanged. */
  error?: WorkflowError;
  /** precondition: the reply's hint. */
  hint?: string;
  /**
   * precondition (#729 PR-0, E1 (b)): the failed expression and the value it read, the value through
   * the ONE escaped, bounded value renderer — the facts a door renders the refusal's suggestion from.
   */
  precondition?: PreconditionFacts;
}

/** issue #729 PR-0 (E1 (b)): a failed precondition — its expression and the value read, escaped and bounded. */
export interface PreconditionFacts {
  expression: string;
  value: string;
}

function stepOrder(definition: WorkflowDefinition): Map<string, number> {
  return new Map(Object.keys(definition.steps).map((name, index) => [name, index]));
}

/**
 * The write-free checks `executeStep` runs before it claims a step — trust, precondition, input
 * schema — plus the capability check the dispatch makes (`requirementForStep` + `registry.has`,
 * the same pure functions `capability.ts` keeps for the pre-flight). Pure; never throws.
 * With no registry, a step that needs a handler or adapter is `{ unknown: 'capability' }`.
 * `members` (default: every check, in this order) runs only the checks it names — the run's view
 * passes {@link AGENT_PRE_CLAIM_REFUSALS} for an agent step (decision C82), whose `input` it never
 * reads.
 *
 * The input schema checks the input the step will receive (issue #688): for a step that consumes
 * its `input_map` ({@link consumesInputMap}), what the map builds from the run — never `input` —
 * and its refusal says `report_to_user`, since no input a caller sends changes it; for any other
 * step, `input`. When the map cannot be resolved (a corrupted stored map, issue #287's runtime
 * mirror), the input-schema check is skipped and the dispatch fails the step with the map's own
 * defect; a corrupted map whose ENGINE input the schema refused used to be refused here instead.
 */
export function checkPreClaim(args: {
  definition: WorkflowDefinition;
  run: RunRecord;
  step: string;
  input: Record<string, unknown>;
  registry?: ExtensionRegistry;
  members?: readonly PreClaimRefusal[];
  /**
   * #729 PR-0 (D3 A-2's G5-7; T-13): who supplies `input` — the engine (`executeEngineStep` and
   * every loop that runs a step through it) or a caller. An input the engine built is never the
   * caller's to provide, so its refusal says `report_to_user`. Default `caller`.
   */
  inputBy?: 'engine' | 'caller';
}): PreClaimRefused | { unknown: 'capability' } | undefined {
  const { definition, run, step, input, registry, members, inputBy = 'caller' } = args;
  const asked = (member: PreClaimRefusal): boolean =>
    members === undefined || members.includes(member);
  const stepDef: StepDefinition | undefined = definition.steps[step];
  let stage: PreClaimRefusal = 'trust';
  try {
    if (asked('trust') && classifyStepTrust(stepDef?.execution, stepDef?.trust) === 'refuse') {
      // decision C49: the view's `refusal` is #508's read-time voice (`finding`) — a step not yet
      // dispatched, shown beside other steps that run — while the `error` `executeStep` returns
      // stays the dispatch voice, so its reply is byte-identical.
      const refusal = buildTrustRefusal({
        kind: stepDef!.execution,
        value: stepDef!.trust,
        step,
        surface: 'finding',
      });
      const message = buildTrustRefusal({
        kind: stepDef!.execution,
        value: stepDef!.trust,
        step,
        surface: 'dispatch',
      });
      return {
        refused_by: 'trust',
        refusal,
        error: new WorkflowError(message, {
          code: 'VALIDATION_TRUST_VALUE',
          category: 'VALIDATION',
          agentAction: 'report_to_user',
          retryable: false,
          stepId: step,
        }),
      };
    }
    stage = 'precondition';
    if (asked('precondition')) {
      if (stepDef?.preconditions !== undefined && stepDef.preconditions.length > 0) {
        const failed = checkPreconditions(stepDef.preconditions, buildEvidenceByStep(run));
        if (failed !== null) {
          const hint = preconditionHint(step);
          // F5 (review A2-3): the view's `refusal` reaches `realm run inspect`, `realm run advance`,
          // `realm agent`, every reply hint, `get_run_state` and the `realm listen` log, so the value a
          // step's output gave is rendered through the escaped, bounded value renderer — one line, no
          // terminal escape, never a line that reads as one of the screen's own. #729 PR-0 (E1 (b)):
          // the reply's suggestion too — the byte-identical raw form ends here.
          const value = escapedBoundedValue(failed.resolved_value);
          const refusal = preconditionRefusal(hint, failed.expression, value);
          return {
            refused_by: 'precondition',
            refusal,
            hint,
            precondition: { expression: failed.expression, value },
          };
        }
      }
    }
    stage = 'input_schema';
    if (asked('input_schema') && stepDef?.input_schema !== undefined) {
      // issue #688: a step that consumes its map receives what the map builds — that is checked. A
      // map that cannot be resolved skips the check; the dispatch then fails the step naming it.
      const mapped = consumesInputMap(stepDef);
      let checked: Record<string, unknown> | undefined = input;
      if (mapped) {
        try {
          checked = resolveInputMap(stepDef.input_map, input, run);
        } catch {
          checked = undefined;
        }
      }
      if (checked !== undefined) {
        try {
          validateInputSchema(checked, stepDef.input_schema, step);
        } catch (err) {
          if (err instanceof WorkflowError) {
            // decision C37: the refusal names the field and what it must be (the first validation
            // message). `error` is the engine's own error — `executeStep` returns it — unchanged,
            // except that for an input no caller sends it says `report_to_user`: a mapped input
            // (issue #688), or one the engine built (#729 PR-0, G5-7) — minted here, once
            // (Amendment 12: the reply's action word is the error's).
            const error =
              mapped || inputBy === 'engine'
                ? new WorkflowError(err.message, {
                    code: err.code,
                    category: err.category,
                    agentAction: 'report_to_user',
                    retryable: err.retryable,
                    details: err.details,
                    // issue #759 (Part D.1): the refusal's list is its typed facts — the re-mint
                    // keeps them, or the reply loses every problem.
                    ...(err.facts !== undefined ? { facts: err.facts } : {}),
                    ...(err.stepId !== undefined ? { stepId: err.stepId } : {}),
                  })
                : err;
            return {
              refused_by: 'input_schema',
              refusal: withValidationProblems(error),
              error,
            };
          }
          throw err;
        }
      }
    }
    stage = 'capability';
    if (asked('capability') && stepDef !== undefined) {
      const requirement = requirementForStep(step, stepDef, definition);
      if (requirement !== undefined) {
        // decision C33: the freshest fact the caller has — its registry when it passes one; else
        // the run's own `capability_blocks` marker for this step (history: what the runner that
        // last attempted it lacked); else unknown.
        if (registry === undefined) {
          const marker = run.capability_blocks?.[step];
          if (marker === undefined) return { unknown: 'capability' };
          const { kind, name } = marker.requirement;
          return {
            refused_by: 'capability',
            refusal: capabilityRefusalWords(kind, name, 'marker'),
            basis: 'marker',
            requirement: { kind, name },
          };
        }
        if (!registry.has(requirement.kind, requirement.name)) {
          return {
            refused_by: 'capability',
            refusal: capabilityRefusalWords(requirement.kind, requirement.name, 'registry'),
            basis: 'registry',
            requirement: { kind: requirement.kind, name: requirement.name },
          };
        }
      }
    }
    return undefined;
  } catch (err) {
    // Total by contract: a check that throws is reported as its refusal, never thrown.
    const refusal = err instanceof Error ? err.message : String(err);
    // The thrown error rides along so `executeStep` keeps returning what it returned before.
    return stage === 'input_schema' && err instanceof Error
      ? { refused_by: stage, refusal, error: err as WorkflowError }
      : { refused_by: stage, refusal };
  }
}

/**
 * `Invalid input for step 'x': 'n' must be number; 'm' must be string; and 3 more` — the engine's
 * message, then EVERY validation problem with the field it names (decision C37; issue #759), up to
 * `VALIDATION_PROBLEMS_SHOWN`, and how many more. A property the schema does not allow is named
 * itself, from the validator's own detail: `'<p>' is not allowed` (decision C42). The first clause
 * is the one this function wrote before #759, byte for byte. Total: an error with no usable detail
 * keeps the engine's message alone. Never a submitted value — Ajv's `message` names only the rule,
 * and an extra property's detail is its NAME.
 */
function withValidationProblems(err: WorkflowError): string {
  const facts = validationFactsOfError(err);
  const sentence = renderProblemsSentence(
    describeValidationProblems(facts?.errors ?? [], 'c37', facts?.error_count),
  );
  return sentence === '' ? err.message : `${err.message}: ${sentence}`;
}

/**
 * The input of a step the ENGINE runs (decision C2): the run's recorded `params` when the step has
 * no `depends_on`, else `{}`. Record-derived, so a run created by any door advances the same way.
 */
export function engineStepInput(
  definition: WorkflowDefinition,
  run: RunRecord,
  step: string,
): Record<string, unknown> {
  const deps = definition.steps[step]?.depends_on ?? [];
  return deps.length === 0 ? { ...run.params } : {};
}

/**
 * One `auto` step the engine could run, judged for the caller's registry. The same shape names an
 * eligible agent step the run refuses before its claim (`PendingView.agent_refused`, decision C82):
 * `runnable_here: false`, `refused_by` (`trust` or `precondition`), `refusal`.
 */
export interface EngineRunnable {
  step: string;
  runnable_here: boolean | 'unknown';
  refused_by?: PreClaimRefusal;
  refusal?: string;
  /**
   * Present exactly when `refused_by` is `capability` (decision C41): `registry` — the caller's
   * own registry lacks the handler or adapter; `marker` — the caller passed none, and the run's
   * record says the runner that last attempted the step lacked it.
   */
  basis?: CapabilityBasis;
  /**
   * Present exactly when `refused_by` is `capability` (#872 (a)): the handler or adapter refused,
   * as data — the registry's requirement, or the marker's — so a caller groups the steps without
   * reading `refusal`.
   */
  requirement?: { kind: 'handler' | 'adapter'; name: string };
  /** precondition only (#729 PR-0, E1 (b)): the failed expression and the value it read. */
  precondition?: PreconditionFacts;
}

export interface PendingView {
  /** The eligible agent steps the run offers, in definition order (each a `run_step` way). */
  agent_steps: string[];
  /**
   * The eligible agent steps the run refuses before their claim — a failed precondition, or a
   * `trust` value it refuses (decision C82) — in definition order. Never in `agent_steps`: no
   * surface offers them and no driver picks them.
   */
  agent_refused: EngineRunnable[];
  pending_guards: string[];
  engine_runnable: EngineRunnable[];
  /**
   * Every step that cannot run — the `agent_refused` entries and the refused `engine_runnable`
   * entries — in definition order, as `describePending` composes it. Read it through
   * {@link stepsThatCannotRun}.
   */
  cannot_run: EngineRunnable[];
  /**
   * Present only when `describePending` was given `now` (decision C95): the run's open question has
   * expired and declares `on_expiry`, so carrying out that declared default or abort is owed engine
   * work — the act is `advance_run`, whose first move carries it out. Absent for a question with no
   * `on_expiry` (a finding only, never touched), one not yet expired, and every call with no `now`.
   */
  expiry_due?: DueExpiry;
  /**
   * issue #729 PR-0 (D2 §6: `PendingView.owed`): what the engine owes — a due expiry first (decision
   * C95), then each owed step (guards, then every `auto` step not refused) — the `advance` way's
   * `owed`. Empty when nothing is owed: then no `advance` way is offered (R26, Amendment 13 Q11).
   */
  owed: ({ step: string } | { expiry: DueExpiry })[];
  /**
   * The question the run waits on (decision C103): present whenever the run is open and its record
   * holds an open question (`pending_gate`), with or without `now`. Its answer is the `respond` way;
   * a reply offers it while the question can be answered ({@link answerableQuestion}).
   */
  open_question?: OpenQuestion;
  /**
   * Decision C211 (walk c14 W2-2): the steps that wait for the open question's answer — eligible by
   * their dependencies, but held while a question is open (gate serialization: no step is eligible
   * while a gate is open). Present only with an answerable question ({@link answerableQuestion})
   * and at least one such step; in definition order. Worded by each door from the `respond` way's `holds`.
   */
  waiting_on_answer?: string[];
}

/** An open question (decision C103): the step that asks it, its gate, and the choices it takes. */
export interface OpenQuestion {
  step: string;
  gate_id: string;
  choices: string[];
}

/** The open question of an open run, read from its record (decision C103); none on a sealed run. */
export function openQuestionOf(
  run: Pick<RunRecord, 'terminal_state' | 'pending_gate'>,
): OpenQuestion | undefined {
  const gate = run.pending_gate;
  if (run.terminal_state || gate === undefined) return undefined;
  return { step: gate.step_name, gate_id: gate.gate_id, choices: [...gate.choices] };
}

/**
 * The question a caller can answer now (decision C103): the view's open question, unless its time is
 * up and it declares `on_expiry` (`expiry_due`) — then carrying that out is owed instead, and an
 * answer would not be recorded.
 */
export function answerableQuestion(pending: PendingView): OpenQuestion | undefined {
  return pending.expiry_due === undefined ? pending.open_question : undefined;
}

/** `the question on step '<s>' (choices: a, b)` — an open question, as every line names it. */
export function openQuestionWords(question: OpenQuestion): string {
  return `the question on step '${question.step}' (choices: ${question.choices.join(', ')})`;
}

/** An open question whose time is up and whose `on_expiry` the engine can carry out (decision C95). */
export interface DueExpiry {
  gate_id: string;
  step: string;
  on_expiry: 'settle_default' | 'abort';
}

/**
 * Whether `gate` has expired at `now` with an `on_expiry` the engine can carry out (decision C95) —
 * the ONE predicate `enactExpiredGateIfDue` and the run's view read, in the same form as the
 * settlement's own `not_expired` refusal (`!(now < expires_at)`), so the view never offers an
 * expiry the enactment would refuse as premature. Pure.
 */
export function dueExpiry(gate: PendingGate | undefined, now: Date): DueExpiry | undefined {
  if (gate === undefined || gate.expires_at === undefined || gate.on_expiry === undefined) {
    return undefined;
  }
  // #729 PR-0 (A2): the one due test of a stored deadline.
  if (!isPastDeadline(gate.expires_at, now)) return undefined;
  return { gate_id: gate.gate_id, step: gate.step_name, on_expiry: gate.on_expiry };
}

/** `the expired question on '<step>' (its declared <on_expiry>)` — the owed expiry, as every line names it. */
export function dueExpiryWords(expiry: DueExpiry): string {
  return `the expired question on '${expiry.step}' (its declared ${expiry.on_expiry})`;
}

/**
 * The steps a caller can call now (decision C94): the agent steps the view offers and the `auto`
 * steps it does not refuse, in definition order — never a step refused before its claim (C13, C82),
 * never a guard. A refusal's `blocked_reason.eligible_steps`.
 */
export function callableSteps(definition: WorkflowDefinition, pending: PendingView): string[] {
  const order = stepOrder(definition);
  return [
    ...pending.agent_steps,
    ...pending.engine_runnable.filter((e) => e.runnable_here !== false).map((e) => e.step),
  ].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/**
 * Every step that cannot run, agent and engine, in definition order (decision C82): the one list
 * every consumer reads — the cannot-go-on predicates and lines, the next sentence, `realm run
 * inspect`'s `Cannot run` lines, the drivers' picks and stop lines, the fixture runner's stall and
 * skip set, and the by-name way out. An entry's `refused_by` says which check refuses it.
 */
export function stepsThatCannotRun(pending: PendingView): EngineRunnable[] {
  return pending.cannot_run;
}

/** #872 (b1) correction 1 (H2): names in a sentence — at most ten, then how many more (H1's producer). */
const quoteList = (names: readonly string[]): string => quotedNames(names, NAMES_SHOWN);

/**
 * Decision C37: `text.` — a full stop only when the text does not already end a sentence, judged by
 * its last character alone: a Unicode `Sentence_Terminal` (in ASCII exactly `.`, `?` and `!`; also
 * `。`, `？`, `！` and the other scripts' sentence ends) or `…`, which Unicode does not class as
 * terminal but which ends a truncated text. A closing quote or bracket after an end mark is not
 * looked through: text alone cannot tell a quote that closes a sentence (`said "stop."`) from one
 * that closes a literal Realm quoted (`must match pattern "^https?"`, which needs its stop), so a
 * sentence that ends inside a quote or bracket gets a second mark.
 */
/**
 * #729 PR-3: the text as a reader sees it. The CLI writer marks a command a reader copies as a span
 * (U+E000, a kind and a tag, U+E001, the text, U+E002) and prints only the text; the sentence rules
 * below read through those marks, so a line that ends with a marked command still ends with it.
 */
function visibleText(text: string): string {
  return text.replace(/\uE000[^\uE001\uE002]*\uE001|\uE002/g, '');
}

export function withFullStop(text: string): string {
  return /[\p{Sentence_Terminal}…]$/u.test(visibleText(text)) ? text : `${text}.`;
}

/**
 * Decision C212: whether the text ends with a command a reader pastes — its last clause, from the
 * last `realm ` that starts a word, is `realm <group> <command>` followed only by a positional
 * argument, `--flags`, a flag's value and `<placeholders>` (`<one of: a, b>` is one). A command
 * followed by words (`realm run advance <id> runs them …`) does not end the text.
 */
export function endsWithCommand(marked: string): boolean {
  const text = visibleText(marked);
  const start = text.lastIndexOf('realm ');
  if (start < 0 || (start > 0 && text[start - 1] !== ' ')) return false;
  // F6: a token is a POSIX word — quoted with '…' (as `shellWord` writes it), with backslash escapes —
  // or a `<one of: …>` placeholder whose members are quoted words, kept as ONE token (a quoted member
  // may hold `>`, such as the choice `yes>`).
  const tokens =
    text.slice(start).match(/<(?:[^>'\\]|\\.|'[^']*')*>|(?:[^\s'\\]|\\.|'[^']*')+/g) ?? [];
  const [, group, name, ...rest] = tokens;
  if (group === undefined) return false;
  // `realm agent` takes flags only; `realm run|workflow <command>` one positional, then flags.
  let i = 0;
  if (group !== 'agent') {
    if (name === undefined || !/^[a-z][a-z-]*$/.test(name)) return false;
    if (rest[0] !== undefined && !rest[0].startsWith('--')) i = 1;
  } else if (name !== undefined) {
    rest.unshift(name);
  }
  while (i < rest.length) {
    const token = rest[i]!;
    if (!/^--[a-z][a-z-]*$/.test(token)) return false;
    const value = rest[i + 1];
    i += value !== undefined && !value.startsWith('--') ? 2 : 1;
  }
  return true;
}

/**
 * Decision C212, the one rule: no printed command is followed by punctuation a paste would carry.
 * A sentence that ends with a command ({@link endsWithCommand}) ends with it, with no full stop;
 * any other sentence gets one ({@link withFullStop}). Every line composer whose sentence can end
 * with a command ends it here.
 */
export function sentenceEnd(text: string): string {
  return endsWithCommand(text) ? text : withFullStop(text);
}

/**
 * When nothing can run from here (decisions C64, C82): no question is open, no act, no agent step
 * ready, nothing in flight — and a step cannot run ({@link stepsThatCannotRun}: an engine step for
 * any check, an agent step refused before its claim). A capability refusal counts: another runner
 * may run that step, but nothing here can. {@link cannotRunWayOutApplies} is this state with a
 * refusal before the claim among the steps.
 */
export function cannotGoOnHere(run: RunRecord, pending: PendingView): boolean {
  return (
    !run.terminal_state &&
    run.pending_gate === undefined &&
    pending.owed.length === 0 &&
    pending.agent_steps.length === 0 &&
    run.in_progress_steps.length === 0 &&
    stepsThatCannotRun(pending).length > 0
  );
}

/**
 * The failed steps `realm run resume --from` takes, and the command that names them (decisions
 * C202, C204) — by the resume command's own checks (`resume.ts`): the run has not been aborted, its
 * phase is `failed` or `abandoned`, and the step is listed as failed, is still in the workflow and
 * is not a cleanup step (`resume --from` refuses a finalizer). One step → `--from <step>`; several →
 * `--from <one of: a, b>`. `undefined` when it takes none. The FACT of what `realm run resume`
 * takes (F2): `realm run purge`'s preview and `realm run inspect`'s `Resumable:` line read it. No
 * surface OFFERS it from here — every offer reads {@link offeredResumeWay}.
 */
export function resumeWay(
  run: Pick<
    RunRecord,
    | 'id'
    | 'pending_gate'
    | 'terminal_state'
    | 'failed_steps'
    | 'terminal_reason'
    | 'aborted_at'
    | 'abandoned_at'
    | 'sealed_by'
  >,
  workflow: { readonly steps: Readonly<Record<string, { execution?: string } | undefined>> },
): { steps: string[]; command: string } | undefined {
  if (run.aborted_at !== undefined || !RESUMABLE_PHASES.has(deriveRunPhase(run))) return undefined;
  const steps = [...new Set(run.failed_steps)].filter((step) => {
    const kind = workflow.steps[step];
    return kind !== undefined && kind.execution !== 'finalizer';
  });
  if (steps.length === 0) return undefined;
  // #872 (b1) correction 1 (H2): the placeholder holds the first ten steps, then how many more.
  return { steps, command: `realm run resume ${run.id} --from ${oneOf(steps, NAMES_SHOWN)}` };
}

/**
 * The failed steps a surface may OFFER to `realm run resume` (F2; framework A1-B2, axis 8 — R8 over
 * R7): {@link resumeWay}, the fact, only when the run's DERIVED phase is `failed` (an engine failure
 * ended it); `undefined` for every other run. A run an operator ended (`abandoned`) is never offered
 * the undo: resuming it erases the operator's ending and its reason and records no one and no
 * reason for the undo, so until a signed reversal exists no surface offers it; the operator's own
 * read surfaces name it, with that warning. Keyed on the derived phase, so a legacy abandoned
 * record with no `sealed_by` is covered. Every offer reads it: the refusal of an answer to an ended
 * run, an answer's reply, the ended-run replies of `execute_step`, `advance_run` and `start_run`,
 * the CLI's and Slack's answer lines, `get_run_state`'s `resumable`, `realm run advance` and the
 * `Resume:` hand-back of `realm workflow run` and `realm agent`.
 */
export function offeredResumeWay(
  run: Parameters<typeof resumeWay>[0],
  workflow: Parameters<typeof resumeWay>[1],
): { steps: string[]; command: string } | undefined {
  return deriveRunPhase(run) === 'failed' ? resumeWay(run, workflow) : undefined;
}

/**
 * F2: what a surface says, in the resume offer's place, about a run an operator ended (derived phase
 * `abandoned`): that an operator ended it, its reason (`terminal_reason`, free text, through the
 * escaped, bounded value renderer — one line, no terminal escape), and that a new run is the way to
 * run the work again — `an operator ended this run, with the reason "<reason>"; to run the work
 * again, start a new run` (`with no reason recorded` when there is none). `undefined` for any other
 * run. A clause: {@link operatorEndingSentence} is it as a sentence.
 */
export function operatorEndingClause(
  run: Pick<RunRecord, 'terminal_reason'> & Parameters<typeof deriveRunPhase>[0],
): string | undefined {
  if (deriveRunPhase(run) !== 'abandoned') return undefined;
  const reason =
    run.terminal_reason === undefined
      ? 'with no reason recorded'
      : `with the reason ${escapedBoundedValue(run.terminal_reason)}`;
  return `an operator ended this run, ${reason}; to run the work again, start a new run`;
}

/**
 * F2: {@link operatorEndingClause} as a sentence — `An operator ended this run, with the reason
 * "<reason>"; to run the work again, start a new run.` — the one sentence every offer site says in
 * the resume offer's place for a run an operator ended (the CLI hand-backs print it as a line of
 * their own). `undefined` for any other run.
 */
export function operatorEndingSentence(
  run: Parameters<typeof operatorEndingClause>[0],
): string | undefined {
  const clause = operatorEndingClause(run);
  return clause === undefined ? undefined : `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

/**
 * The placeholder a printed command gives for a value that is one of several (decision C206): the
 * value itself when there is one, else `<one of: a, b>` — a placeholder bash and sh refuse to run
 * as typed (a syntax error, so nothing runs), never `a|b`, which a shell runs as a pipe. F6: each
 * value through {@link shellWord}, the one quoter — the one value as a shell word, and EACH member of
 * the placeholder too, so no member can run even if the placeholder is mis-pasted. The one form for
 * `--from` ({@link resumeWay}) and `--choice` ({@link respondCommand}).
 */
export function oneOf(values: readonly string[], shown?: number): string {
  if (values.length === 1) return shellWord(values[0]!);
  // #872 (b1) correction 1 (H2): with `shown`, the first `shown` values, then how many more — inside
  // the placeholder (`<one of: a, b, … and 990 more>`), still one token a shell refuses as typed.
  const words = values.map(shellWord);
  return `<one of: ${shown === undefined ? words.join(', ') : listWords(words, shown)}>`;
}

/**
 * Decision C211 (walk c14 W2-2): the steps an open question holds — eligible by their dependencies
 * once its gate is set aside, its own step excluded, in definition order. Empty for a run with no
 * open question or one that has ended.
 */
export function waitingOnAnswer(definition: WorkflowDefinition, run: RunRecord): string[] {
  const gate = run.pending_gate;
  if (run.terminal_state || gate === undefined) return [];
  const order = stepOrder(definition);
  const { pending_gate: _held, ...withoutGate } = run;
  return findEligibleSteps(definition, withoutGate)
    .filter((step) => step !== gate.step_name)
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/**
 * Decision C211 (walk c14 W3-4): the cleanup steps a run that has ended left `pending` (its
 * ledger's pending entries, in rank order) and the command that runs them — `realm run drain <id>
 * --force`, which runs each with the code it loads, when that code has the handler. `undefined`
 * for a run that has not ended, or has none pending.
 *
 * F12 (review G3-1, G7-13; framework §0 rule 10, R14): judged at the call's `now`, a pending step
 * under another drainer's lease that has not passed is `held_until` its deadline (the latest such
 * deadline, when several are held): the command runs nothing until then — `drainFinalizers` halts at
 * a held lease. What the record shows, and nothing more: realm cannot tell whether that drainer is
 * still running.
 */
export function pendingCleanupWay(
  run: Pick<RunRecord, 'id' | 'terminal_state' | 'finalizer_ledger'>,
  now: Date,
): { steps: string[]; command: string; held_until?: string } | undefined {
  if (!run.terminal_state) return undefined;
  const pending = Object.entries(run.finalizer_ledger ?? {})
    .filter(([, entry]) => entry.status === 'pending')
    .sort(([, a], [, b]) => a.rank - b.rank);
  if (pending.length === 0) return undefined;
  const held = pending
    .map(([, entry]) => entry)
    .filter(
      (entry) =>
        entry.lease_token !== undefined &&
        entry.lease_deadline !== undefined &&
        new Date(entry.lease_deadline).getTime() > now.getTime(),
    )
    .map((entry) => entry.lease_deadline!)
    .sort();
  return {
    steps: pending.map(([name]) => name),
    command: `realm run drain ${run.id} --force`,
    ...(held.length > 0 ? { held_until: held[held.length - 1]! } : {}),
  };
}

/**
 * F12: the words for a cleanup step under another drainer's lease that has not passed — what the
 * record shows (the lease and its deadline), never that the drainer is alive or dead.
 */
export function heldLeaseWords(until: string): string {
  return `held by another drainer's lease until ${until} (realm cannot tell whether it is still running)`;
}

/**
 * The CLI's line for {@link pendingCleanupWay} (decisions C211, C212 — the command ends it):
 * `Cleanup step left pending: 'tidy' — to run it with code that has its handler: realm run drain
 * <id> --force`; F12, under another drainer's lease that has not passed: `Cleanup step left
 * pending: 'tidy' — held by another drainer's lease until <t> (realm cannot tell whether it is still
 * running) — after <t>: realm run drain <id> --force`. `undefined` when none is pending.
 */
export function pendingCleanupLine(
  run: Pick<RunRecord, 'id' | 'terminal_state' | 'finalizer_ledger'>,
  now: Date,
): string | undefined {
  const way = pendingCleanupWay(run, now);
  if (way === undefined) return undefined;
  const one = way.steps.length === 1;
  const head = `Cleanup ${one ? 'step' : 'steps'} left pending: ${quoteList(way.steps)} — `;
  if (way.held_until !== undefined) {
    return `${head}${heldLeaseWords(way.held_until)} — after ${way.held_until}: ${way.command}`;
  }
  return (
    `${head}to run ` +
    `${one ? 'it with code that has its handler' : 'them with code that has their handlers'}: ${way.command}`
  );
}

/**
 * The tools' sentence for {@link pendingCleanupWay} (decision C211): ` Cleanup step left pending:
 * 'tidy' — 'realm run drain <id> --force' runs it with code that has its handler.`; F12, under
 * another drainer's lease that has not passed, ` Cleanup step left pending: 'tidy' — held by another
 * drainer's lease until <t> (realm cannot tell whether it is still running) — after <t>, 'realm run
 * drain <id> --force' runs it with code that has its handler.` Empty when none is pending.
 */
export function pendingCleanupSentence(
  run: Pick<RunRecord, 'id' | 'terminal_state' | 'finalizer_ledger'>,
  now: Date,
): string {
  const way = pendingCleanupWay(run, now);
  if (way === undefined) return '';
  const one = way.steps.length === 1;
  const held =
    way.held_until === undefined
      ? ''
      : `${heldLeaseWords(way.held_until)} — after ${way.held_until}, `;
  return (
    ` Cleanup ${one ? 'step' : 'steps'} left pending: ${quoteList(way.steps)} — ${held}'${way.command}' ` +
    `runs ${one ? 'it with code that has its handler' : 'them with code that has their handlers'}.`
  );
}

/** The names the act stands for: guards first, then every `auto` step not refused. */
export function owedNames(pending: PendingView): string[] {
  return [
    ...pending.pending_guards,
    ...pending.engine_runnable.filter((e) => e.runnable_here !== false).map((e) => e.step),
  ];
}

/** The owed work as every surface names it: a due expiry first (decision C95), then each step quoted. */
function owedItems(pending: PendingView): string[] {
  return [
    ...(pending.expiry_due !== undefined ? [dueExpiryWords(pending.expiry_due)] : []),
    ...owedNames(pending).map((n) => `'${n}'`),
  ];
}

/** `'a', 'b'` — the owed work as every surface prints it (a due expiry by its words, decision C95). */
export function owedList(pending: PendingView): string {
  return owedItems(pending).join(', ');
}

/** decision C207: where one advance call stops, said after several owed items ({@link owedWords}). */
const OWED_UNTIL = ' until a step opens a question, fails or ends the run';

/**
 * The words that agree with how many steps are owed (decision C37): `the step` / `the steps`, and
 * `it` / `them` — so no surface says "runs them" of one step. `until` (decision C207) is what one
 * advance call does with several, measured on the engine's loop (`advanceLoop`): it runs the owed
 * steps one at a time, and any the run owes after them, and stops at the first step that opens a
 * question, fails or ends the run — so a line that names several owed items never reads as a
 * promise that all of them run: ` until a step opens a question, fails or ends the run`. Empty for
 * one item (the call runs it, or stops at it).
 */
export function owedWords(pending: PendingView): { steps: string; them: string; until: string } {
  return owedItems(pending).length === 1
    ? { steps: 'the step', them: 'it', until: '' }
    : { steps: 'the steps', them: 'them', until: OWED_UNTIL };
}

/**
 * What the run owes, from the record, the definition and (when present) the registry, at `now`.
 * Pure. A terminal run owes nothing; so does a run with an open gate — except a question whose time
 * is up at `now` and that declares `on_expiry` (decision C95): carrying it out is owed engine work
 * (`expiry_due`, the `advance_run` act), and the question can no longer be answered. The clock is
 * required (decision C117): a view built without one assumed no question had expired, and offered
 * an answer that could not be recorded. Each caller passes its own clock — its `now` option, or
 * `new Date()` at an entry point that has none.
 * An eligible agent step is judged by the checks that read no input
 * ({@link AGENT_PRE_CLAIM_REFUSALS}, decision C82): one the run refuses is listed in
 * `agent_refused`, never in `agent_steps` or `agent_actions`.
 */
export function describePending(
  definition: WorkflowDefinition,
  run: RunRecord,
  registry: ExtensionRegistry | undefined,
  now: Date,
): PendingView {
  if (run.terminal_state || run.pending_gate !== undefined) {
    const question = openQuestionOf(run);
    const empty: PendingView = {
      agent_steps: [],
      agent_refused: [],
      pending_guards: [],
      engine_runnable: [],
      cannot_run: [],
      owed: [],
      ...(question !== undefined ? { open_question: question } : {}),
    };
    const expiry = run.terminal_state ? undefined : dueExpiry(run.pending_gate, now);
    if (expiry === undefined) {
      // decision C211: the steps the answer lets go on, named while the question holds them.
      const waiting = question === undefined ? [] : waitingOnAnswer(definition, run);
      return waiting.length > 0 ? { ...empty, waiting_on_answer: waiting } : empty;
    }
    // decision C95: carrying out the expired question's declared default or abort is owed first.
    return { ...empty, expiry_due: expiry, owed: [{ expiry }] };
  }
  const order = stepOrder(definition);
  const eligible = [...findEligibleSteps(definition, run)].sort(
    (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
  );
  // issue #625 PR-2a: an `auto` step is never an agent's step — the engine runs it.
  const offered = eligible.filter((name) => definition.steps[name]?.execution === 'agent');
  const agent_steps: string[] = [];
  const agent_refused: EngineRunnable[] = [];
  for (const step of offered) {
    const verdict = checkPreClaim({
      definition,
      run,
      step,
      // read by none of the members asked for: an agent step's input is the agent's answer
      input: {},
      members: AGENT_PRE_CLAIM_REFUSALS,
    });
    if (verdict !== undefined && 'refused_by' in verdict) {
      agent_refused.push({
        step,
        runnable_here: false,
        refused_by: verdict.refused_by,
        refusal: verdict.refusal,
        ...(verdict.precondition !== undefined ? { precondition: verdict.precondition } : {}),
      });
      continue;
    }
    agent_steps.push(step);
  }
  const pending_guards = findEligibleGuardSteps(definition, run);
  const engine_runnable: EngineRunnable[] = eligible
    .filter((name) => definition.steps[name]?.execution === 'auto')
    .map((step) => {
      const verdict = checkPreClaim({
        definition,
        run,
        step,
        input: engineStepInput(definition, run, step),
        ...(registry !== undefined ? { registry } : {}),
      });
      if (verdict === undefined) return { step, runnable_here: true };
      if ('unknown' in verdict) return { step, runnable_here: 'unknown' as const };
      return {
        step,
        runnable_here: false,
        refused_by: verdict.refused_by,
        refusal: verdict.refusal,
        ...(verdict.basis !== undefined ? { basis: verdict.basis } : {}),
        ...(verdict.requirement !== undefined ? { requirement: verdict.requirement } : {}),
        ...(verdict.precondition !== undefined ? { precondition: verdict.precondition } : {}),
      };
    });
  const cannot_run = [
    ...agent_refused,
    ...engine_runnable.filter((e) => e.runnable_here === false),
  ].sort((a, b) => (order.get(a.step) ?? 0) - (order.get(b.step) ?? 0));
  const view: PendingView = {
    agent_steps,
    agent_refused,
    pending_guards,
    engine_runnable,
    cannot_run,
    owed: [],
  };
  view.owed = owedNames(view).map((step) => ({ step }));
  return view;
}

/** The `next_actions_status` word for a run whose only next work is the engine's. */
export const ADVANCE_OWED = 'advance_owed' as const;

/**
 * `advance_owed` exactly when the engine owes work and no agent step is ready. When every owed engine
 * step is refused and no agent step is ready nothing is owed: the status is `ok`, and
 * `engine_runnable` and `agent_refused` say why.
 */
export function composeNextActionsStatusWord(
  pending: PendingView,
): typeof ADVANCE_OWED | undefined {
  return pending.owed.length > 0 && pending.agent_steps.length === 0 ? ADVANCE_OWED : undefined;
}

/** How this program's project code compares with what the run last recorded (holder D-8). */
export const PROGRAM_FITS = ['same', 'differs', 'not_comparable', 'none'] as const;
export type ProgramFit = (typeof PROGRAM_FITS)[number];

/** D-8's table: the run's LAST recorded code identity against this program's. */
export function judgeProgramFit(
  run: RunRecord,
  registryIdentity: ExtensionIdentityEntry | undefined,
): ProgramFit {
  // #729 PR-3 correction 5 (J-5): the last EXECUTION entry; a start entry is not a baseline.
  const recorded = lastExecutionIdentity(run.extension_identity);
  if (recorded === undefined && registryIdentity === undefined) return 'none';
  if (recorded === undefined || registryIdentity === undefined) return 'not_comparable';
  if (recorded.error !== undefined || registryIdentity.error !== undefined) return 'not_comparable';
  if (
    recorded.tree.rules !== registryIdentity.tree.rules ||
    recorded.tree.truncated === true ||
    registryIdentity.tree.truncated === true
  ) {
    return 'not_comparable';
  }
  return extensionIdentityDiffers(recorded, registryIdentity) ? 'differs' : 'same';
}

/**
 * The newest evidence entry that names its driver, and how many NEWER entries of the kinds the holder
 * slice stamps with `driven_by` name none (decision C21). Only a step's own execution entry and a
 * cleanup step's entry name the program that drove a step; the entry the engine writes for a guard
 * never does, and a person's answer (`kind: 'gate_response'`) names, since #627 W, the program that
 * RECORDED it — so neither is ever this reading's driver, nor counted. The definition is what tells a
 * guard's entry from a step's: an entry carries no marker of its own.
 */
export function describeRunDriver(
  run: RunRecord,
  definition: WorkflowDefinition,
): {
  driver: Attributed | ActorAbsent;
  step?: string;
  at?: string;
  newer_without_driver: number;
} {
  let newer = 0;
  for (let i = run.evidence.length - 1; i >= 0; i--) {
    const entry = run.evidence[i]!;
    // #627 W (§5.8): an answer's entry now names the program that RECORDED it (`driven_by`), which
    // is not the program that drives the run's steps — so an answer is still never this line's
    // driver, as before W (when answers carried no `driven_by`). `realm run inspect` names who
    // recorded an answer on its `Answer:` line.
    if (entry.kind === 'gate_response') continue;
    const read = readDrivenBy(entry);
    if (read.by !== null) {
      return {
        driver: read,
        step: entry.step_id,
        at: entry.completed_at,
        newer_without_driver: newer,
      };
    }
    const canCarry = definition.steps[entry.step_id]?.execution !== 'guard';
    if (canCarry) newer++;
  }
  return { driver: { by: null, absent_cause: 'driver_not_recorded' }, newer_without_driver: 0 };
}
