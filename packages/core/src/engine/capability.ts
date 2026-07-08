// capability.ts — pure capability-requirement derivation and detection (issue #134).
//
// A "capability requirement" is the handler or adapter an `execution: auto` step needs the executing
// runner's registry to provide. This module has three pure functions and no I/O:
//   - requirementForStep  : the single requirement a step imposes (mirrors dispatch precedence)
//   - unmetCapabilities   : Part B pre-flight — requirements the registry can't satisfy (WARN input)
//   - findCapabilityBlockedSteps : Part A recovery — steps parked by a mid-run not-registered failure
//
// Keeping this logic pure and centralized guarantees the pre-flight warning and the mid-run settle
// reason about capability the SAME way the dispatcher does, so a warning and a block can never disagree.
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';
import type { ExtensionRegistry } from '../extensions/registry.js';

/** The single handler/adapter an auto step requires. `step` is the step name (StepDefinition carries none). */
export interface Requirement {
  step: string;
  kind: 'handler' | 'adapter';
  name: string;
}

/**
 * The capability requirement a step imposes on the executing registry, or `undefined` if it imposes none.
 *
 * Mirrors the dispatch precedence in the execution loop EXACTLY (uses_service → adapter; else handler),
 * and ONLY for `execution: 'auto'` steps — agent/guard/finalizer steps and the built-in agent dispatcher
 * impose no registry requirement. For an adapter step whose service is absent from `definition.services`,
 * returns `undefined`: that is a workflow-authoring bug surfaced elsewhere (service-not-found), not a
 * capability gap the runner can fix by registering an adapter.
 */
export function requirementForStep(
  step: string,
  stepDef: StepDefinition,
  definition: WorkflowDefinition,
): Requirement | undefined {
  if (stepDef.execution !== 'auto') return undefined;
  if (stepDef.uses_service !== undefined) {
    const service = definition.services?.[stepDef.uses_service];
    if (service === undefined) return undefined;
    return { step, kind: 'adapter', name: service.adapter };
  }
  if (stepDef.handler !== undefined) {
    return { step, kind: 'handler', name: stepDef.handler };
  }
  return undefined;
}

/**
 * Part B pre-flight: the auto-step requirements the given registry CANNOT satisfy. Pure — `registry.has`
 * is a Map lookup, no dispatch. Callers WARN on a non-empty result at run creation; they never REFUSE
 * (a run can be created against one runner and executed by a differently-provisioned one — see #134).
 */
export function unmetCapabilities(
  definition: WorkflowDefinition,
  registry: ExtensionRegistry,
): Requirement[] {
  const unmet: Requirement[] = [];
  for (const [step, stepDef] of Object.entries(definition.steps)) {
    const requirement = requirementForStep(step, stepDef, definition);
    if (requirement !== undefined && !registry.has(requirement.kind, requirement.name)) {
      unmet.push(requirement);
    }
  }
  return unmet;
}

/**
 * Advisory warning line for one unmet capability — shared by every run-creating path (#134) so the
 * pre-flight warning phrasing can never drift between start_run, start_run_batch, CLI run, and the
 * run-agent create path. Advisory ONLY: names the gap and its recoverable consequence; never a refusal.
 */
export function capabilityWarning(requirement: Requirement): string {
  return (
    `Step '${requirement.step}' needs ${requirement.kind} '${requirement.name}', which is not ` +
    `registered in this runner. If reached it will block recoverably (not fail) until a runner that ` +
    `provides this ${requirement.kind} executes it — load the missing extension or run on a capable runner.`
  );
}

/** A capability-blocked step surfaced by {@link findCapabilityBlockedSteps}. */
export interface CapabilityBlockInfo {
  step: string;
  requirement: { kind: 'handler' | 'adapter'; name: string };
  code: string;
  at: string;
}

/**
 * Part A recovery detection: steps parked by a mid-run not-registered failure that are STILL eligible.
 *
 * Definition-free by design — reads only `capability_blocks` and the four step sets. A marker is reported
 * only when its step is eligible-but-unclaimed (∉ completed ∪ in_progress ∪ failed ∪ skipped). This
 * cross-check makes a stale marker self-suppress: if the step has since completed (or been claimed) on a
 * correctly-provisioned runner, its marker is silently ignored, so CLEARING the marker on recovery is
 * hygiene, not correctness. Returns [] for legacy/capability-clean records (no `capability_blocks`).
 */
export function findCapabilityBlockedSteps(run: RunRecord): CapabilityBlockInfo[] {
  const blocks = run.capability_blocks;
  if (blocks === undefined) return [];
  const settled = new Set<string>([
    ...run.completed_steps,
    ...run.in_progress_steps,
    ...run.failed_steps,
    ...run.skipped_steps,
  ]);
  const blocked: CapabilityBlockInfo[] = [];
  for (const [step, block] of Object.entries(blocks)) {
    if (settled.has(step)) continue;
    blocked.push({ step, requirement: block.requirement, code: block.code, at: block.at });
  }
  return blocked;
}
