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
import { findEligibleSteps, findEligibleGuardSteps, buildEvidenceByStep } from './eligibility.js';
import { checkPreconditions } from './precondition.js';
import { validateInputSchema } from '../validation/input-schema.js';
import { requirementForStep } from './capability.js';
import { readDrivenBy, type Attributed, type ActorAbsent } from './holder.js';
import { buildAgentActions } from './execution-loop.js';

/** The checks that refuse a step before it is claimed, in the order `executeStep` runs them. */
export const PRE_CLAIM_REFUSALS = ['trust', 'precondition', 'input_schema', 'capability'] as const;
export type PreClaimRefusal = (typeof PRE_CLAIM_REFUSALS)[number];

/** A refusal before the claim. `error` / `hint` + `suggestion` carry what `executeStep` returns. */
export interface PreClaimRefused {
  refused_by: PreClaimRefusal;
  refusal: string;
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
 */
export function checkPreClaim(args: {
  definition: WorkflowDefinition;
  run: RunRecord;
  step: string;
  input: Record<string, unknown>;
  registry?: ExtensionRegistry;
}): PreClaimRefused | { unknown: 'capability' } | undefined {
  const { definition, run, step, input, registry } = args;
  const stepDef: StepDefinition | undefined = definition.steps[step];
  let stage: PreClaimRefusal = 'trust';
  try {
    if (classifyStepTrust(stepDef?.execution, stepDef?.trust) === 'refuse') {
      const message = buildTrustRefusal({
        kind: stepDef!.execution,
        value: stepDef!.trust,
        step,
        surface: 'dispatch',
      });
      return {
        refused_by: 'trust',
        refusal: message,
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
    if (stepDef?.preconditions !== undefined && stepDef.preconditions.length > 0) {
      const failed = checkPreconditions(stepDef.preconditions, buildEvidenceByStep(run));
      if (failed !== null) {
        const hint = `Precondition failed for step '${step}'.`;
        const suggestion = `Precondition failed: '${failed.expression}'. Resolved value: ${String(failed.resolved_value)}.`;
        return { refused_by: 'precondition', refusal: `${hint} ${suggestion}`, hint, suggestion };
      }
    }
    stage = 'input_schema';
    if (stepDef?.input_schema !== undefined) {
      try {
        validateInputSchema(input, stepDef.input_schema, step);
      } catch (err) {
        if (err instanceof WorkflowError) {
          return { refused_by: 'input_schema', refusal: err.message, error: err };
        }
        throw err;
      }
    }
    stage = 'capability';
    if (stepDef !== undefined) {
      const requirement = requirementForStep(step, stepDef, definition);
      if (requirement !== undefined) {
        if (registry === undefined) return { unknown: 'capability' };
        if (!registry.has(requirement.kind, requirement.name)) {
          return {
            refused_by: 'capability',
            refusal: `${requirement.kind} '${requirement.name}' is not registered here`,
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

/** One `auto` step the engine could run, judged for the caller's registry. */
export interface EngineRunnable {
  step: string;
  runnable_here: boolean | 'unknown';
  refused_by?: PreClaimRefusal;
  refusal?: string;
}

export interface PendingView {
  agent_actions: NextAction[];
  /** The agent steps `agent_actions` stands for, in the same order. */
  agent_steps: string[];
  pending_guards: string[];
  engine_runnable: EngineRunnable[];
  act?: NextAction;
}

const quoteList = (names: readonly string[]): string => names.map((n) => `'${n}'`).join(', ');

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
 * What the run owes, from the record, the definition and (when present) the registry. Pure.
 * A terminal run, or a run with an open gate, owes nothing.
 */
export function describePending(
  definition: WorkflowDefinition,
  run: RunRecord,
  registry?: ExtensionRegistry,
): PendingView {
  if (run.terminal_state || run.pending_gate !== undefined) {
    return { agent_actions: [], agent_steps: [], pending_guards: [], engine_runnable: [] };
  }
  const order = stepOrder(definition);
  const eligible = [...findEligibleSteps(definition, run)].sort(
    (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
  );
  const { actions: agent_actions, steps: agent_steps } = buildAgentActions(definition, run);
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
      };
    });
  const view: PendingView = { agent_actions, agent_steps, pending_guards, engine_runnable };
  const names = owedNames(view);
  if (names.length > 0) {
    const list = quoteList(names);
    view.act = {
      instruction: {
        tool: 'advance_run',
        params: { run_id: run.id },
        call_with: { run_id: run.id },
      },
      human_readable: `Call advance_run to run the steps the engine owes: ${list}. It runs them with this server's extensions and environment.`,
      orientation: `Run is active. Engine work is owed: ${list}.`,
    };
  }
  return view;
}

/** The `next_actions_status` word for a run whose only next work is the engine's. */
export const ADVANCE_OWED = 'advance_owed' as const;

/** `advance_owed` exactly when the act is present and no agent action is. */
export function composeNextActionsStatusWord(
  pending: PendingView,
): typeof ADVANCE_OWED | undefined {
  return pending.act !== undefined && pending.agent_actions.length === 0 ? ADVANCE_OWED : undefined;
}

/** The one sentence after `Step 'X' completed.` / `Gate 'G' resolved with choice 'c'.` */
export function describeNext(pending: PendingView): string {
  let sentence = '';
  if (pending.agent_steps.length > 0) {
    sentence += ` Ready for the agent: ${quoteList(pending.agent_steps)}.`;
  }
  if (pending.act !== undefined) {
    sentence += ` Owed to the engine: ${owedList(pending)} — call advance_run.`;
  }
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

/** The newest evidence entry that names its driver, and how many newer entries name none. */
export function describeRunDriver(run: RunRecord): {
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
    newer++;
  }
  return { driver: { by: null, absent_cause: 'driver_not_recorded' }, newer_without_driver: 0 };
}
