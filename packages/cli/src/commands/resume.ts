// resume command — removes a step from failed_steps so it can be re-executed.
//
// issue #279 (increment 1, PR-B): the write itself is now the core-owned pure `applyResume`
// transform (design record §5) — this file's job narrows to the FOUR CLI refusals that must run
// BEFORE it (structural aborted_at guard, a finalizer `--from` target, an unexpired drain lease,
// and the three-way claim classification), then a single atomic `store.update()` of whatever
// `applyResume` computed (its own version-CAS is the whole atomicity story — see that module's
// doc). issue #281 rides here too: applyResume strips `abandoned_at` alongside `terminal_reason`.
import { Command } from 'commander';
import type { RunStore, WorkflowRegistrar, ApplyResumeVoidedFinalizer } from '@sensigo/realm';

// issue #279 (increment 1, PR-B): NO top-level VALUE import from `@sensigo/realm` — JsonFileStore's
// default runsDir is computed at module-load time (`homedir()`), so a top-level value import here
// would freeze it before any test/caller can override `$HOME` (the abandon.ts precedent). Every
// value this file needs is loaded dynamically inside `resumeRun` itself (cached after the first
// call — cheap on every subsequent one).
//
// issue #285 (2026-08-13): the capture is now fixed at the root — `JsonFileStore`'s (and
// `JsonFileReplayStore`'s) default directory resolves `homedir()` at CONSTRUCTION time, not module
// load (drain.ts's own header carries the full account). A top-level value import here would no
// longer freeze anything. The dynamic-import pattern above stays as-is regardless — not worth the
// churn to unwind for a hazard that no longer exists.

export interface ResumeOptions {
  /** Overrides the claim_unknown_age refusal (§5.4) — the ONLY refusal `--force` can bypass. A
   *  healthy claim and an unexpired drain lease are NEVER force-bypassable. */
  force?: boolean;
}

/**
 * Removes `stepName` from `failed_steps` so the DAG engine can re-evaluate its eligibility on the
 * next execute-step call — via the core `applyResume` transform (design record §5), after the
 * four CLI refusals below all clear.
 *
 * @param runId         The run to resume.
 * @param stepName      The failed step to re-enable.
 * @param runStore      Store holding run records.
 * @param workflowStore Registrar for workflow definitions.
 * @param opts          `force` overrides ONLY the claim_unknown_age refusal.
 * @returns             The finalizers this resume voided (empty on the common no-pendings case).
 */
export async function resumeRun(
  runId: string,
  stepName: string,
  runStore: RunStore,
  workflowStore: WorkflowRegistrar,
  opts: ResumeOptions = {},
): Promise<{ voided: ApplyResumeVoidedFinalizer[]; disclosures: string[] }> {
  const {
    WorkflowError,
    applyResume,
    RESUMABLE_PHASES,
    classifyClaim,
    DRAIN_LEASE_MAX,
    deriveRunPhase,
  } = await import('@sensigo/realm');
  const run = await runStore.get(runId);

  // §5.1 — structural, phase-independent (RESUME_REFUSES_ABORTED pin): an aborted run is never
  // resumable, checked directly against aborted_at rather than relying on RESUMABLE_PHASES
  // excluding 'aborted' as a side effect. Checked FIRST and independently of the phase check below
  // — deriveRunPhase(:34-42) always derives phase 'aborted' whenever aborted_at is set (the two
  // can never diverge through any real store write today), so this ordering is what makes the
  // explicit, by-name business rule ("abort ⇒ never resumable") the one that actually fires,
  // rather than silently riding on RESUMABLE_PHASES's exclusion as an unstated implementation
  // detail a future phase-set change could break.
  if (run.aborted_at !== undefined) {
    throw new WorkflowError(
      `Run ${runId} was aborted (step '${run.aborted_at.step_id}') — aborted runs are never ` +
        `resumable.`,
      {
        code: 'STATE_TRANSITION_DENIED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      },
    );
  }

  // issue #279 (increment 2, PR-C — D-3 leg iv): derive, never trust the persisted run_phase — a
  // grandfathered terminal-with-stale-gate record (the #282 class) must be admitted here on its
  // TRUE (derived) phase, not whatever was last persisted.
  if (!RESUMABLE_PHASES.has(deriveRunPhase(run))) {
    throw new WorkflowError(
      `Run ${runId} is in phase '${run.run_phase}', which is not resumable.`,
      {
        code: 'STATE_TRANSITION_DENIED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      },
    );
  }

  const workflow = await workflowStore.get(run.workflow_id);

  const targetStep = workflow.steps[stepName];
  if (targetStep === undefined) {
    throw new WorkflowError(`Step '${stepName}' not found in workflow '${run.workflow_id}'.`, {
      code: 'STEP_NOT_FOUND',
      category: 'ENGINE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  // §5.2 — a finalizer `--from` target is refused (finalizers settle via the drain verb, not
  // resume — resuming one would bypass the ledger's own lease/mark discipline entirely).
  if (targetStep.execution === 'finalizer') {
    throw new WorkflowError(
      `Step '${stepName}' is a finalizer — finalizers cannot be resumed via --from. Use ` +
        `'realm run drain ${runId}' or '--void ${stepName}' instead.`,
      {
        code: 'STATE_TRANSITION_DENIED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      },
    );
  }

  if (!run.failed_steps.includes(stepName)) {
    throw new WorkflowError(`Step '${stepName}' is not in failed_steps for run '${runId}'.`, {
      code: 'STATE_TRANSITION_DENIED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }

  const now = new Date();

  // §5.3 — any pending finalizer ledger entry with an UNEXPIRED lease refuses: a drainer is
  // executing RIGHT NOW. Bounded by the §3 clamp (DRAIN_LEASE_MAX) — the wait is short by
  // construction, so there is deliberately NO --force bypass (final-gate F10a).
  for (const [name, entry] of Object.entries(run.finalizer_ledger ?? {})) {
    if (entry.status !== 'pending') continue;
    if (entry.lease_token === undefined || entry.lease_deadline === undefined) continue;
    if (new Date(entry.lease_deadline).getTime() <= now.getTime()) continue; // expired — not held
    throw new WorkflowError(
      `Run ${runId} has an active drain lease on finalizer '${name}' (expires ` +
        `${entry.lease_deadline}) — a drainer is executing NOW. Wait for the lease to expire ` +
        `(bounded — leases are clamped to ${DRAIN_LEASE_MAX}s) and retry. Not force-bypassable.`,
      {
        code: 'STATE_TRANSITION_DENIED',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: true,
        details: { runId, finalizer: name, lease_deadline: entry.lease_deadline },
      },
    );
  }

  // §5.4 — claims: classifyClaim three-way. healthy ⇒ refuse (no override); claim_unknown_age ⇒
  // refuse UNLESS --force; stale/absent ⇒ released inside applyResume, no refusal here.
  for (const step of run.in_progress_steps) {
    const claim = run.claims?.[step];
    if (claim === undefined) continue; // absent — released inside applyResume
    const state = classifyClaim(claim, now);
    if (state === 'healthy') {
      throw new WorkflowError(
        `Step '${step}' has a HEALTHY claim (deadline ${claim.deadline}) — a live runner is ` +
          `presumed on it. Resume refuses to disturb live work.`,
        {
          code: 'STATE_TRANSITION_DENIED',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: true,
          details: { runId, step },
        },
      );
    }
    if (state === 'claim_unknown_age' && opts.force !== true) {
      throw new WorkflowError(
        `Step '${step}' has an unknown-age claim (no reliable deadline) — its liveness cannot ` +
          `be verified. Re-run with --force to override (only after confirming the runner is ` +
          `actually dead).`,
        {
          code: 'STATE_TRANSITION_DENIED',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
          details: { runId, step },
        },
      );
    }
    // claim_stale, or claim_unknown_age with --force: falls through — applyResume releases it.
  }

  const { run: resumedRun, voided, disclosures } = applyResume(run, stepName, workflow);
  await runStore.update(resumedRun);
  return { voided, disclosures };
}

export const resumeCommand = new Command('resume')
  .description('Remove a step from failed_steps so it can be re-executed')
  .argument('<run-id>', 'ID of the run to resume')
  .requiredOption('--from <step>', 'Name of the failed step to re-enable')
  .option(
    '--force',
    'Override the claim_unknown_age refusal ONLY (never a healthy claim or an unexpired drain lease)',
  )
  .action(async (runId: string, opts: { from: string; force?: boolean }) => {
    const { JsonFileStore, JsonWorkflowStore } = await import('@sensigo/realm');
    const runStore = new JsonFileStore();
    const workflowStore = new JsonWorkflowStore();
    try {
      const { voided, disclosures } = await resumeRun(runId, opts.from, runStore, workflowStore, {
        ...(opts.force !== undefined ? { force: opts.force } : {}),
      });
      console.log(
        `Resumed run '${runId}': step '${opts.from}' re-enabled and run reset to 'running'.\n` +
          `Drive it with: realm agent --run-id ${runId}`,
      );
      for (const { disclosure } of voided) {
        console.log(`  ⚠ ${disclosure}`);
      }
      // issue #279 (increment 2, PR-C — D-3 leg ii): a stripped zombie gate, printed AFTER the
      // voided-finalizer lines (same `⚠` loop convention).
      for (const disclosure of disclosures) {
        console.log(`  ⚠ ${disclosure}`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
