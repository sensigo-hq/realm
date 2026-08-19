// Tests for the resumeRun function — CLI resume command logic.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeRun } from './resume.js';
import {
  JsonFileStore,
  JsonWorkflowStore,
  WorkflowError,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  findEligibleSteps,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';

/** Two-step workflow (step-a → step-b) — used to prove skipped_steps re-derivation on resume. */
const redriveWorkflow: WorkflowDefinition = {
  id: 'resume-redrive-wf',
  name: 'Resume Re-drive Workflow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    'step-a': { description: 'First step', execution: 'agent' },
    'step-b': { description: 'Second step', execution: 'agent', depends_on: ['step-a'] },
  },
};

const testWorkflow: WorkflowDefinition = {
  id: 'resume-test-wf',
  name: 'Resume Test Workflow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    'step-one': {
      description: 'First step',
      execution: 'auto',
    },
  },
};

describe('resumeRun', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-resume-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-resume-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(testWorkflow);
  });

  it('removes the step from failed_steps, re-enabling it for execution', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'resume-test-wf',
      workflowVersion: 1,
      params: {},
    });
    // Simulate a failed run
    await runStore.update({
      ...run,
      run_phase: 'failed',
      failed_steps: ['step-one'],
      terminal_state: true,
      sealed_by: { arm: 'step_failure' },
      terminal_reason: 'Something went wrong',
    });

    await resumeRun(run.id, 'step-one', runStore, workflowStore);

    const updated = await runStore.get(run.id);
    expect(updated.failed_steps).not.toContain('step-one');
  });

  it('throws when the run is in a non-resumable state (completed)', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'resume-test-wf',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
    });

    await expect(resumeRun(run.id, 'step-one', runStore, workflowStore)).rejects.toThrow(
      WorkflowError,
    );

    await expect(resumeRun(run.id, 'step-one', runStore, workflowStore)).rejects.toThrow(
      'is not resumable',
    );
  });

  it('throws when the step name does not exist in the workflow', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'resume-test-wf',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      run_phase: 'failed',
      failed_steps: ['step-one'],
      terminal_state: true,
      sealed_by: { arm: 'step_failure' },
      terminal_reason: 'Something went wrong',
    });

    await expect(resumeRun(run.id, 'nonexistent-step', runStore, workflowStore)).rejects.toThrow(
      WorkflowError,
    );

    await expect(resumeRun(run.id, 'nonexistent-step', runStore, workflowStore)).rejects.toThrow(
      'not found',
    );
  });

  it('re-drives a failed run: resets to running, clears terminal_reason, re-derives skipped_steps, re-enables the step', async () => {
    await workflowStore.register(redriveWorkflow);
    const { run: run } = await runStore.create({
      workflowId: 'resume-redrive-wf',
      workflowVersion: 1,
      params: {},
    });
    // step-a failed → step-b was skipped (all_success can no longer be satisfied) → run terminal failed.
    await runStore.update({
      ...run,
      run_phase: 'failed',
      failed_steps: ['step-a'],
      skipped_steps: ['step-b'],
      terminal_state: true,
      sealed_by: { arm: 'step_failure' },
      terminal_reason: 'step-a failed',
    });

    await resumeRun(run.id, 'step-a', runStore, workflowStore);

    const resumed = await runStore.get(run.id);
    expect(resumed.terminal_state).toBe(false);
    expect(resumed.run_phase).toBe('running');
    expect(resumed.failed_steps).not.toContain('step-a');
    expect(resumed.terminal_reason).toBeUndefined();
    // step-b was skipped only because step-a failed — re-derived away now that step-a is re-enabled.
    expect(resumed.skipped_steps).not.toContain('step-b');
    // The re-enabled step is now eligible (proving the run is genuinely runnable again).
    expect(findEligibleSteps(redriveWorkflow, resumed)).toContain('step-a');
  });

  it('clean-slate recompute (issue #111): a stale skip_details entry does not survive resume for a step that is now re-eligible', async () => {
    await workflowStore.register(redriveWorkflow);
    const { run: run } = await runStore.create({
      workflowId: 'resume-redrive-wf',
      workflowVersion: 1,
      params: {},
    });
    // step-a failed → step-b was skipped (all_success unsatisfiable) with a recorded reason →
    // run terminal failed. This mirrors the real shape execution-loop.ts would have written.
    await runStore.update({
      ...run,
      run_phase: 'failed',
      failed_steps: ['step-a'],
      skipped_steps: ['step-b'],
      skip_details: {
        'step-b': {
          kind: 'trigger_rule_unsatisfiable',
          rule: 'all_success',
          blocking_deps: [{ dep: 'step-a', state: 'failed' }],
        },
      },
      terminal_state: true,
      sealed_by: { arm: 'step_failure' as const },
      terminal_reason: 'step-a failed',
    });

    await resumeRun(run.id, 'step-a', runStore, workflowStore);

    const resumed = await runStore.get(run.id);
    // step-b is re-eligible again — its stale detail must not survive (would otherwise violate
    // Object.keys(skip_details) ⊆ skipped_steps AND show a misleading reason for a live step).
    expect(resumed.skip_details?.['step-b']).toBeUndefined();
    expect(resumed.skipped_steps).not.toContain('step-b');
  });

  // ---------------------------------------------------------------------------
  // issue #279 (increment 1, PR-B) — the four CLI refusals (design record §5).
  // ---------------------------------------------------------------------------

  describe('CLI refusals (issue #279, increment 1, PR-B)', () => {
    it('RESUME_REFUSES_ABORTED — a run with aborted_at set is never resumable, regardless of run_phase', async () => {
      const { run } = await runStore.create({
        workflowId: 'resume-test-wf',
        workflowVersion: 1,
        params: {},
      });
      // A structurally-inconsistent-but-defensive fixture: run_phase says 'failed' (which
      // RESUMABLE_PHASES would normally admit), but aborted_at is ALSO set — proving this refusal
      // is genuinely independent of the phase check, not merely redundant with it.
      await runStore.update({
        ...run,
        run_phase: 'failed',
        failed_steps: ['step-one'],
        terminal_state: true,
        // issue #367: the arm records what actually sealed this run — a handler abort. The stale
        // `run_phase: 'failed'` above is the deliberate lie this fixture is built on, and the arm
        // must not repeat it (the store's coherence check refuses a stamp that contradicts the
        // record's own abort marker).
        sealed_by: { arm: 'handler_abort' as const },
        aborted_at: { step_id: 'step-one', abort_message: 'handler aborted' },
      });

      await expect(resumeRun(run.id, 'step-one', runStore, workflowStore)).rejects.toThrow(
        /aborted runs are never resumable/,
      );
    });

    it('refuses a finalizer --from target — points at the drain verb instead', async () => {
      const finalizerWorkflow: WorkflowDefinition = {
        id: 'resume-finalizer-wf',
        name: 'Resume Finalizer Workflow',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          work: { description: 'w', execution: 'agent' },
          fin: { description: 'f', execution: 'finalizer', on_outcome: 'always' },
        },
      };
      await workflowStore.register(finalizerWorkflow);
      const { run } = await runStore.create({
        workflowId: 'resume-finalizer-wf',
        workflowVersion: 1,
        params: {},
      });
      await runStore.update({
        ...run,
        run_phase: 'failed',
        failed_steps: ['fin'],
        terminal_state: true,
        sealed_by: { arm: 'step_failure' },
      });

      await expect(resumeRun(run.id, 'fin', runStore, workflowStore)).rejects.toThrow(
        /finalizer — finalizers cannot be resumed via --from/,
      );
    });

    it('refuses on an unexpired drain lease — bounded wait, never force-bypassable', async () => {
      const { run } = await runStore.create({
        workflowId: 'resume-test-wf',
        workflowVersion: 1,
        params: {},
      });
      const farFuture = new Date(Date.now() + 60_000).toISOString();
      await runStore.update({
        ...run,
        run_phase: 'failed',
        failed_steps: ['step-one'],
        terminal_state: true,
        sealed_by: { arm: 'step_failure' },
        finalizer_ledger: {
          fin: {
            status: 'pending',
            rank: 0,
            lease_token: 'active-drainer',
            lease_deadline: farFuture,
          },
        },
      });

      await expect(resumeRun(run.id, 'step-one', runStore, workflowStore)).rejects.toThrow(
        /active drain lease/,
      );
      // Not force-bypassable — even --force must still refuse.
      await expect(
        resumeRun(run.id, 'step-one', runStore, workflowStore, { force: true }),
      ).rejects.toThrow(/active drain lease/);
    });

    it('an EXPIRED drain lease does NOT refuse — the finalizer is voided normally', async () => {
      const { run } = await runStore.create({
        workflowId: 'resume-test-wf',
        workflowVersion: 1,
        params: {},
      });
      const past = new Date(Date.now() - 60_000).toISOString();
      await runStore.update({
        ...run,
        run_phase: 'failed',
        failed_steps: ['step-one'],
        terminal_state: true,
        sealed_by: { arm: 'step_failure' },
        finalizer_ledger: {
          fin: { status: 'pending', rank: 0, lease_token: 'dead-drainer', lease_deadline: past },
        },
      });

      const { voided } = await resumeRun(run.id, 'step-one', runStore, workflowStore);
      expect(voided).toHaveLength(1);
      const resumed = await runStore.get(run.id);
      expect(resumed.finalizer_ledger?.['fin']?.status).toBe('voided');
    });

    it('a HEALTHY claim on another in-progress step refuses resume — never force-bypassable', async () => {
      const { run } = await runStore.create({
        workflowId: 'resume-test-wf',
        workflowVersion: 1,
        params: {},
      });
      const farFuture = new Date(Date.now() + 60_000).toISOString();
      await runStore.update({
        ...run,
        run_phase: 'failed',
        failed_steps: ['step-one'],
        terminal_state: true,
        sealed_by: { arm: 'step_failure' },
        in_progress_steps: ['other-step'],
        claims: { 'other-step': { deadline: farFuture, token: 'live-token' } },
      });

      await expect(resumeRun(run.id, 'step-one', runStore, workflowStore)).rejects.toThrow(
        /HEALTHY claim/,
      );
      await expect(
        resumeRun(run.id, 'step-one', runStore, workflowStore, { force: true }),
      ).rejects.toThrow(/HEALTHY claim/);
    });

    it('a claim_unknown_age claim refuses WITHOUT --force, but --force overrides it', async () => {
      const { run } = await runStore.create({
        workflowId: 'resume-test-wf',
        workflowVersion: 1,
        params: {},
      });
      await runStore.update({
        ...run,
        run_phase: 'failed',
        failed_steps: ['step-one'],
        terminal_state: true,
        sealed_by: { arm: 'step_failure' },
        in_progress_steps: ['other-step'],
        claims: { 'other-step': { deadline: null, token: 'unknown-age-token' } },
      });

      await expect(resumeRun(run.id, 'step-one', runStore, workflowStore)).rejects.toThrow(
        /unknown-age claim/,
      );
      // --force overrides — the claim is released inside applyResume.
      await resumeRun(run.id, 'step-one', runStore, workflowStore, { force: true });
      const resumed = await runStore.get(run.id);
      expect(resumed.in_progress_steps).toEqual([]);
      expect(resumed.claims).toEqual({});
    });

    it('a STALE (concrete, past-deadline) claim is released WITHOUT needing --force', async () => {
      const { run } = await runStore.create({
        workflowId: 'resume-test-wf',
        workflowVersion: 1,
        params: {},
      });
      const past = new Date(Date.now() - 60_000).toISOString();
      await runStore.update({
        ...run,
        run_phase: 'failed',
        failed_steps: ['step-one'],
        terminal_state: true,
        sealed_by: { arm: 'step_failure' },
        in_progress_steps: ['other-step'],
        claims: { 'other-step': { deadline: past, token: 'stale-token' } },
      });

      await resumeRun(run.id, 'step-one', runStore, workflowStore);
      const resumed = await runStore.get(run.id);
      expect(resumed.in_progress_steps).toEqual([]);
      expect(resumed.claims).toEqual({});
    });
  });
});
