// issue #553 — the ONLY place the context-dependent admission checks are spelled.
//
// Every check `register` runs that a workflow's text alone cannot answer needs a piece of the
// source tree: agent-profile resolution needs the workflow's directory, the project-extensions
// pass (modules, manifest, config_schema) needs the trust root. `validate --registered` audits a
// STORED copy, whose tree may be gone — so per member it either SUPPLIES the recorded context
// and runs the check, or DECLARES the check not run, naming why. The human line and the
// `checks_not_run` JSON field are both derived from this constant; nothing is hand-typed.
//
// A context-dependent check that is not a row here cannot be declared not-run, and a check that
// stays inline in the file loader cannot be supplied a recorded path: admission-context.test.ts
// reads the loader's source and refuses both shapes.
import type { WorkflowDefinition } from '@sensigo/realm';

/** The recorded-path field a check needs; also the vocabulary of the not-run reason. */
export type AdmissionContextNeed = 'source_dir' | 'trust_root';

export interface ContextDependentCheck {
  readonly id: string;
  readonly needs: AdmissionContextNeed;
  /** The human line's name for the check. */
  readonly label: string;
  /**
   * The CALL token the file loader's post-parse block must contain for this member — the named
   * exported resolver `validate --registered` calls with the recorded path. `undefined` for a
   * check that runs outside the core loader (the CLI's extensions pass).
   */
  readonly witness: string | undefined;
  /** Does this stored copy even carry the shape the check governs? */
  readonly applies: (definition: WorkflowDefinition) => boolean;
}

export const CONTEXT_DEPENDENT_CHECKS = [
  {
    id: 'agent_profile_resolution',
    needs: 'source_dir',
    label: 'agent-profile file resolution',
    witness: 'resolveAgentProfiles(definition, workflowDir)',
    applies: (d: WorkflowDefinition) =>
      Object.values(d.steps).some((s) => s.agent_profile !== undefined),
  },
  {
    id: 'project_extensions',
    needs: 'trust_root',
    label: 'project extensions (modules, manifest, config_schema)',
    witness: undefined,
    // ALWAYS applies: register's extensions pass is unconditional, and an extension-free
    // workflow IS refused by an invalid manifest at its trust root (executed). Whether a
    // manifest governs the copy is unknowable once the tree is gone — exactly what "not run"
    // says.
    applies: () => true,
  },
] as const satisfies readonly ContextDependentCheck[];

export type ContextDependentCheckId = (typeof CONTEXT_DEPENDENT_CHECKS)[number]['id'];

/** One `checks_not_run` entry: the member and why it could not run. */
export interface CheckNotRun {
  readonly id: ContextDependentCheckId;
  readonly reason: string;
}

/**
 * The reason vocabulary — three shapes, keyed on the member's `needs` and, when the path was
 * never recorded at all, on the record's `origin` (issue #524-class message-claim-truth
 * correction — a #553 self-catch, not #524's own issue). "registered before v0.14" is true for
 * a FILE-registered copy that predates `source_dir`/`trust_root` stamping — but a `create_workflow`
 * copy (`origin: 'agent'`) never goes through the file loader and never records a source tree AT
 * ALL, whatever version created it: `create-workflow.ts` stamps `origin: 'agent'` and nothing
 * else path-shaped.
 */
export function notRunReason(
  needs: AdmissionContextNeed,
  recorded: string | undefined,
  origin: string | undefined,
): string {
  if (recorded !== undefined) return `${needs} ${recorded} no longer exists`;
  if (origin === 'agent') {
    return `no ${needs} recorded (created by create_workflow, which registers without a source tree)`;
  }
  return `no ${needs} recorded (registered before v0.14)`;
}

/**
 * The always-on disclosure line for `validate --registered`:
 *   `N check(s) not run: <label> (<reason>)[; <label> (<reason>)]`
 * Each member renders beside its OWN reason, `; `-joined in member order — reasons are NEVER
 * deduplicated (issue #553 correction C6): two members that happen to share a reason text (e.g.
 * both "registered before v0.14") still each print their own label-and-reason pair, because
 * collapsing them into one shared parenthetical reads as a single combined cause rather than two
 * independent skips.
 * Empty input → empty string (the caller prints nothing: every check ran).
 */
export function renderChecksNotRunLine(notRun: readonly CheckNotRun[]): string {
  if (notRun.length === 0) return '';
  const parts = notRun.map((n) => {
    const label = CONTEXT_DEPENDENT_CHECKS.find((c) => c.id === n.id)?.label ?? n.id;
    return `${label} (${n.reason})`;
  });
  return `${notRun.length} ${notRun.length === 1 ? 'check' : 'checks'} not run: ${parts.join('; ')}`;
}
