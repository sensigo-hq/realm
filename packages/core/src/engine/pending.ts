// pending.ts — what a run owes, read from its record (issue #625 PR-2a).
//
// ONE place says which agent steps are ready, which guards are pending, and which `auto` steps the
// engine could run — and, when engine work is owed, the ONE act that runs it (`advance_run`). Pure:
// no I/O, never throws. Every read surface and every reply whose writer loads the definition reads
// this, so a run whose next step belongs to the engine is never left without a named call.
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import { classifyStepTrust, buildTrustRefusal } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';
import type { NextAction } from '../types/response-envelope.js';
import type { ExtensionRegistry } from '../extensions/registry.js';
import type { ExtensionIdentityEntry } from '../types/extension-identity.js';
import { extensionIdentityDiffers } from '../types/extension-identity.js';
import { WorkflowError } from '../types/workflow-error.js';
import {
  findEligibleSteps,
  findEligibleGuardSteps,
  buildEvidenceByStep,
  deriveRunPhase,
} from './eligibility.js';
import { checkPreconditions } from './precondition.js';
import { validateInputSchema } from '../validation/input-schema.js';
import { requirementForStep } from './capability.js';
import { readDrivenBy, type Attributed, type ActorAbsent } from './holder.js';
import { buildAgentActions } from './execution-loop.js';

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

/** A refusal before the claim. `error` / `hint` + `suggestion` carry what `executeStep` returns. */
export interface PreClaimRefused {
  refused_by: PreClaimRefusal;
  refusal: string;
  /** capability only: what the refusal was judged from (decision C41). */
  basis?: CapabilityBasis;
  /** trust and input_schema: the error `executeStep` returns, unchanged. */
  error?: WorkflowError;
  /** precondition: the reply's hint and suggestion, unchanged. */
  hint?: string;
  suggestion?: string;
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
 */
export function checkPreClaim(args: {
  definition: WorkflowDefinition;
  run: RunRecord;
  step: string;
  input: Record<string, unknown>;
  registry?: ExtensionRegistry;
  members?: readonly PreClaimRefusal[];
}): PreClaimRefused | { unknown: 'capability' } | undefined {
  const { definition, run, step, input, registry, members } = args;
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
          const hint = `Precondition failed for step '${step}'.`;
          const suggestion = `Precondition failed: '${failed.expression}'. Resolved value: ${String(failed.resolved_value)}.`;
          return { refused_by: 'precondition', refusal: `${hint} ${suggestion}`, hint, suggestion };
        }
      }
    }
    stage = 'input_schema';
    if (asked('input_schema') && stepDef?.input_schema !== undefined) {
      try {
        validateInputSchema(input, stepDef.input_schema, step);
      } catch (err) {
        if (err instanceof WorkflowError) {
          // decision C37: the refusal names the field and what it must be (the first validation
          // message). `error` is the engine's own error, unchanged — `executeStep` returns it.
          return {
            refused_by: 'input_schema',
            refusal: withFirstValidationMessage(err),
            error: err,
          };
        }
        throw err;
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
          return {
            refused_by: 'capability',
            refusal: `${marker.requirement.kind} '${marker.requirement.name}' was not registered in the runner that last attempted it`,
            basis: 'marker',
          };
        }
        if (!registry.has(requirement.kind, requirement.name)) {
          return {
            refused_by: 'capability',
            refusal: `${requirement.kind} '${requirement.name}' is not registered here`,
            basis: 'registry',
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
 * `Invalid input for step 'x': 'n' must be number` — the engine's message, then the FIRST validation
 * message with the field it names (decision C37). A property the schema does not allow is named
 * itself, from the validator's own detail: `'<p>' is not allowed` (decision C42). Total: an error
 * with no usable detail keeps the engine's message alone. Never a submitted value — Ajv's `message`
 * names only the rule, and an extra property's detail is its NAME.
 */
function withFirstValidationMessage(err: WorkflowError): string {
  const errors = (err.details as { errors?: unknown } | undefined)?.errors;
  const first = Array.isArray(errors)
    ? (errors[0] as Record<string, unknown> | undefined)
    : undefined;
  const message = typeof first?.['message'] === 'string' ? first['message'] : undefined;
  if (message === undefined) return err.message;
  const path = typeof first?.['instancePath'] === 'string' ? first['instancePath'] : '';
  const segments = path === '' ? [] : path.slice(1).split('/');
  const extra = (first?.['params'] as Record<string, unknown> | undefined)?.['additionalProperty'];
  if (first?.['keyword'] === 'additionalProperties' && typeof extra === 'string') {
    return `${err.message}: '${[...segments, extra].join('.')}' is not allowed`;
  }
  const field = segments.length === 0 ? 'the input' : `'${segments.join('.')}'`;
  return `${err.message}: ${field} ${message}`;
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
}

export interface PendingView {
  agent_actions: NextAction[];
  /** The agent steps `agent_actions` stands for, in the same order. */
  agent_steps: string[];
  /**
   * The eligible agent steps the run refuses before their claim — a failed precondition, or a
   * `trust` value it refuses (decision C82) — in definition order. Never in `agent_steps` or
   * `agent_actions`: no surface offers them and no driver picks them.
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
  act?: NextAction;
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

const quoteList = (names: readonly string[]): string => names.map((n) => `'${n}'`).join(', ');

/** `text.` — a full stop only when the text does not already end with one (decision C37). */
export function withFullStop(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

/**
 * The words for an engine step that cannot run (decision C36): `cannot run here (capability)` — the
 * caller's own registry lacks the handler or adapter, and a runner with it could run the step — and
 * `cannot run (<check>)` for trust, precondition and input schema, which refuse it everywhere. A
 * capability refusal judged from the run's marker, with no registry consulted, is past tense: `could
 * not run (capability)` (decision C41). Every surface prints these words.
 */
export function cannotRunWords(entry: EngineRunnable): string {
  if (entry.refused_by === 'capability') {
    return entry.basis === 'marker' ? 'could not run (capability)' : 'cannot run here (capability)';
  }
  return `cannot run (${entry.refused_by ?? 'unknown'})`;
}

/**
 * `'<s>' cannot run (<check>): <refusal>` — one engine step that cannot run, as every line names it.
 * A capability refusal judged from the caller's own registry ends with its way out (decision C53):
 * load the missing extension, or run the step on a runner that has it.
 */
export function cannotRunClause(entry: EngineRunnable): string {
  const clause = `'${entry.step}' ${cannotRunWords(entry)}: ${entry.refusal ?? ''}`;
  return entry.refused_by === 'capability' && entry.basis === 'registry'
    ? `${clause} — load the missing extension, or run the step on a runner that has it`
    : clause;
}

/**
 * The one way out for a run that stops on an engine step refused before its claim — trust,
 * precondition or input schema (decision C44): the fix (correct the workflow, register it again —
 * the run picks up the corrected definition — then advance) and the alternative (abandon). The
 * drive's stop line and `realm run advance` print it.
 */
export function cannotRunWayOut(run: RunRecord): string {
  return (
    `Run ${run.id} stays open (phase '${deriveRunPhase(run)}'): correct the workflow, register it ` +
    `again, then realm run advance ${run.id}; or end it: realm run abandon ${run.id}.`
  );
}

/**
 * The same way out for a caller that speaks the tools (decisions C51, C57): every reply whose next
 * sentence {@link describeNext} composes — a step's reply, an answer's reply, `start_run`'s
 * creation reply and `advance_run`'s nothing-ran reply — ends with it under
 * {@link cannotRunWayOutApplies}, as `realm run advance` prints {@link cannotRunWayOut} under the
 * same condition.
 */
export function cannotRunWayOutTools(): string {
  return 'Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.';
}

/**
 * When the run cannot go on until its workflow is corrected (decisions C44, C51, C82): nothing else
 * is ready — no act, no agent step, nothing in flight, no question open — and a step is refused
 * before its claim: an engine step for trust, precondition or input schema, or an agent step for
 * trust or precondition. A capability refusal is not one: another runner can run that step.
 */
export function cannotRunWayOutApplies(run: RunRecord, pending: PendingView): boolean {
  return (
    cannotGoOnHere(run, pending) &&
    stepsThatCannotRun(pending).some((e) => e.refused_by !== 'capability')
  );
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
    pending.act === undefined &&
    pending.agent_steps.length === 0 &&
    run.in_progress_steps.length === 0 &&
    stepsThatCannotRun(pending).length > 0
  );
}

/**
 * The way out of a capability refusal judged from the run's record, with no registry consulted
 * (decision C53): run the step from a program that has the extension. `realm run inspect`'s
 * past-tense line and every line {@link cannotGoOnLines} composes end with it.
 */
export function capabilityMarkerWayOut(runId: string): string {
  return ` — from a program that has it: realm run advance ${runId}`;
}

/**
 * What an operator surface prints when the run cannot go on from here ({@link cannotGoOnHere};
 * decisions C62, C64, C82): one line per step that cannot run ({@link stepsThatCannotRun}, an agent
 * step refused before its claim included) — `'<s>' cannot run (<check>): <refusal>.`, a capability
 * refusal with its own way out — then the way out of the run:
 * {@link cannotRunWayOut} when a step is refused before its claim (correct the workflow), otherwise
 * the alternative to running the step elsewhere (abandon). Empty in every other state. `realm run
 * respond`, `realm run drain`, `realm run resume` and `realm listen`'s sweeper print these lines;
 * none composes its own.
 */
export function cannotGoOnLines(run: RunRecord, pending: PendingView): string[] {
  if (!cannotGoOnHere(run, pending)) return [];
  const lines = stepsThatCannotRun(pending).map((e) =>
    withFullStop(cannotRunClause(e) + (e.basis === 'marker' ? capabilityMarkerWayOut(run.id) : '')),
  );
  lines.push(
    cannotRunWayOutApplies(run, pending)
      ? cannotRunWayOut(run)
      : `To end the run instead: realm run abandon ${run.id}.`,
  );
  return lines;
}

/** The names the act stands for: guards first, then every `auto` step not refused. */
export function owedNames(pending: PendingView): string[] {
  return [
    ...pending.pending_guards,
    ...pending.engine_runnable.filter((e) => e.runnable_here !== false).map((e) => e.step),
  ];
}

/** `'a', 'b'` — the owed names as every surface prints them. */
export function owedList(pending: PendingView): string {
  return quoteList(owedNames(pending));
}

/**
 * The words that agree with how many steps are owed (decision C37): `the step` / `the steps`, and
 * `it` / `them` — so no surface says "runs them" of one step.
 */
export function owedWords(pending: PendingView): { steps: string; them: string } {
  return owedNames(pending).length === 1
    ? { steps: 'the step', them: 'it' }
    : { steps: 'the steps', them: 'them' };
}

/**
 * What the run owes, from the record, the definition and (when present) the registry. Pure.
 * A terminal run, or a run with an open gate, owes nothing. An eligible agent step is judged by the
 * checks that read no input ({@link AGENT_PRE_CLAIM_REFUSALS}, decision C82): one the run refuses is
 * listed in `agent_refused`, never in `agent_steps` or `agent_actions`.
 */
export function describePending(
  definition: WorkflowDefinition,
  run: RunRecord,
  registry?: ExtensionRegistry,
): PendingView {
  if (run.terminal_state || run.pending_gate !== undefined) {
    return {
      agent_actions: [],
      agent_steps: [],
      agent_refused: [],
      pending_guards: [],
      engine_runnable: [],
      cannot_run: [],
    };
  }
  const order = stepOrder(definition);
  const eligible = [...findEligibleSteps(definition, run)].sort(
    (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
  );
  const offered = buildAgentActions(definition, run);
  const agent_actions: NextAction[] = [];
  const agent_steps: string[] = [];
  const agent_refused: EngineRunnable[] = [];
  offered.steps.forEach((step, index) => {
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
      });
      return;
    }
    agent_actions.push(offered.actions[index]!);
    agent_steps.push(step);
  });
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
      };
    });
  const cannot_run = [
    ...agent_refused,
    ...engine_runnable.filter((e) => e.runnable_here === false),
  ].sort((a, b) => (order.get(a.step) ?? 0) - (order.get(b.step) ?? 0));
  const view: PendingView = {
    agent_actions,
    agent_steps,
    agent_refused,
    pending_guards,
    engine_runnable,
    cannot_run,
  };
  const names = owedNames(view);
  if (names.length > 0) {
    const list = quoteList(names);
    const { steps, them } = owedWords(view);
    view.act = {
      instruction: {
        tool: 'advance_run',
        params: { run_id: run.id },
        call_with: { run_id: run.id },
      },
      human_readable: `Call advance_run to run ${steps} the engine owes: ${list}. It runs ${them} with this server's extensions and environment.`,
      orientation: `Run is active. Engine work is owed: ${list}.`,
    };
  }
  return view;
}

/** The `next_actions_status` word for a run whose only next work is the engine's. */
export const ADVANCE_OWED = 'advance_owed' as const;

/**
 * `advance_owed` exactly when the act is present and no agent step is ready. When every owed engine
 * step is refused and no agent step is ready there is no act: the status is `ok`, and
 * `engine_runnable` and `agent_refused` say why.
 */
export function composeNextActionsStatusWord(
  pending: PendingView,
): typeof ADVANCE_OWED | undefined {
  return pending.act !== undefined && pending.agent_steps.length === 0 ? ADVANCE_OWED : undefined;
}

/**
 * The one sentence after `Step 'X' completed.` / `Gate 'G' resolved with choice 'c'.`, after
 * `start_run`'s `Run '<id>' created …`, and after the nothing-ran reply's `nothing ran.`: the agent
 * steps ready, the engine's owed work, then each step that cannot run (decisions C34, C82 — an agent
 * step refused before its claim is named here, never as ready);
 * ` No step is ready.` only when nothing else is said. When the run cannot go on until its workflow
 * is corrected ({@link cannotRunWayOutApplies}), it ends with the way out in the tools' words
 * (decision C57): every reply that says what comes next says it, from one place.
 */
export function describeNext(pending: PendingView, run: RunRecord): string {
  let sentence = '';
  if (pending.agent_steps.length > 0) {
    sentence += ` Ready for the agent: ${quoteList(pending.agent_steps)}.`;
  }
  if (pending.act !== undefined) {
    sentence += ` Owed to the engine: ${owedList(pending)} — call advance_run.`;
  }
  for (const entry of stepsThatCannotRun(pending)) {
    sentence += ` ${withFullStop(cannotRunClause(entry))}`;
  }
  if (cannotRunWayOutApplies(run, pending)) sentence += ` ${cannotRunWayOutTools()}`;
  return sentence.length > 0 ? sentence : ' No step is ready.';
}

/** How this program's project code compares with what the run last recorded (holder D-8). */
export const PROGRAM_FITS = ['same', 'differs', 'not_comparable', 'none'] as const;
export type ProgramFit = (typeof PROGRAM_FITS)[number];

/** D-8's table: the run's LAST recorded code identity against this program's. */
export function judgeProgramFit(
  run: RunRecord,
  registryIdentity: ExtensionIdentityEntry | undefined,
): ProgramFit {
  const recorded = run.extension_identity?.at(-1);
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
 * cleanup step's entry can carry `driven_by`; a person's answer (`kind: 'gate_response'`) and the
 * entry the engine writes for a guard never do, so they are never counted. The definition is what
 * tells a guard's entry from a step's: an entry carries no marker of its own.
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
    const read = readDrivenBy(entry);
    if (read.by !== null) {
      return {
        driver: read,
        step: entry.step_id,
        at: entry.completed_at,
        newer_without_driver: newer,
      };
    }
    const canCarry =
      entry.kind !== 'gate_response' && definition.steps[entry.step_id]?.execution !== 'guard';
    if (canCarry) newer++;
  }
  return { driver: { by: null, absent_cause: 'driver_not_recorded' }, newer_without_driver: 0 };
}
