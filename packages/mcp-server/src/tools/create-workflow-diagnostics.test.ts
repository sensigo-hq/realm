// create_workflow structured diagnostics tests (issue #169): an unknown step key surfaces as
// BOTH a rendered string in envelope.warnings (unchanged field, non-breaking) AND a structured
// LoaderWarning in the new envelope.diagnostics field (the agent-native value — a framework can
// self-correct on code/key/did_you_mean instead of parsing text). The workflow is still created
// either way; create_workflow never rejects on an unknown step key.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, DEFAULT_POLICY } from '@sensigo/realm';
import { handleCreateWorkflow, type CreateWorkflowArgs } from './create-workflow.js';

describe('create_workflow — structured diagnostics (issue #169)', () => {
  let runDir: string;
  let workflowDir: string;
  let stores: { runStore: JsonFileStore; workflowStore: JsonWorkflowStore };

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-cw-diag-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-cw-diag-wf-'));
    stores = {
      runStore: new JsonFileStore(runDir),
      workflowStore: new JsonWorkflowStore(workflowDir),
    };
  });

  it('an unknown step key is created anyway, and appears in both warnings and diagnostics', async () => {
    const args = {
      steps: [
        {
          id: 'step-a',
          description: 'Do something',
          dependson: ['nowhere'], // typo for depends_on — not a declared CreateWorkflowStep field
        },
      ],
    } as unknown as CreateWorkflowArgs;

    const result = await handleCreateWorkflow(args, stores);

    expect(result.status).toBe('ok');
    // The workflow was still created — an unknown step key never blocks create_workflow.
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(Object.keys(def.steps)).toHaveLength(1);

    // envelope.warnings (unchanged string[] field) carries the rendered text.
    expect(result.warnings.some((w) => w.includes("unknown key 'dependson'"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("did you mean 'depends_on'?"))).toBe(true);

    // envelope.diagnostics (new, additive-optional) carries the structured LoaderWarning.
    expect(result.diagnostics).toBeDefined();
    const diag = result.diagnostics!.find((d) => d.key === 'dependson');
    expect(diag).toBeDefined();
    expect(diag!.code).toBe('UNKNOWN_CREATE_WORKFLOW_KEY');
    expect(diag!.did_you_mean).toBe('depends_on');
    expect(diag!.step).toBe('step-a');
  });

  it('a step with only declared fields produces no diagnostics', async () => {
    const result = await handleCreateWorkflow(
      { steps: [{ id: 'step-a', description: 'Do something' }] },
      stores,
    );
    expect(result.status).toBe('ok');
    expect(result.diagnostics ?? []).toEqual([]);
  });

  it('a far/unrelated unknown key ("produces_state") gets no did_you_mean suggestion', async () => {
    const args = {
      steps: [
        {
          id: 'step-a',
          description: 'Do something',
          produces_state: 'done',
        },
      ],
    } as unknown as CreateWorkflowArgs;

    const result = await handleCreateWorkflow(args, stores);
    expect(result.status).toBe('ok');
    const diag = result.diagnostics!.find((d) => d.key === 'produces_state');
    expect(diag).toBeDefined();
    expect(diag!.did_you_mean).toBeUndefined();
  });

  it('create_workflow diagnostics carry NO source position — there is no source to point into (issue #392)', async () => {
    // Not an omission and not a gap to fill later: create_workflow builds a definition from
    // structured arguments. No YAML text exists anywhere in this path, so a line number would
    // have to be invented, and inventing one is the exact failure the position work is built to
    // avoid. Absence here is the correct and permanent answer.
    const args = {
      steps: [{ id: 'step-a', description: 'Do something', dependson: ['x'] }],
    } as unknown as CreateWorkflowArgs;

    const result = await handleCreateWorkflow(args, stores);

    const diag = result.diagnostics!.find((d) => d.key === 'dependson');
    expect(diag).toBeDefined();
    expect(diag!.line).toBeUndefined();
    expect(diag!.column).toBeUndefined();
    expect(diag!.endLine).toBeUndefined();
    expect(diag!.endColumn).toBeUndefined();
    // And the prose says nothing about a line either.
    expect(diag!.message).not.toContain('(line');
  });

  it('UNKNOWN_CREATE_WORKFLOW_KEY still warns (never refuses) even when UNKNOWN_STEP_KEY is flipped to error (issue #170 leniency proof)', async () => {
    const original = DEFAULT_POLICY.UNKNOWN_STEP_KEY;
    DEFAULT_POLICY.UNKNOWN_STEP_KEY = 'error';
    try {
      const args = {
        steps: [{ id: 'step-a', description: 'Do something', dependson: ['x'] }],
      } as unknown as CreateWorkflowArgs;

      const result = await handleCreateWorkflow(args, stores);

      // create_workflow is UNCHANGED by the loader's UNKNOWN_STEP_KEY flip — it uses a distinct
      // code (UNKNOWN_CREATE_WORKFLOW_KEY) that #170 never touches, so the workflow is still
      // created and the response is still 'ok', not a refusal.
      expect(result.status).toBe('ok');
      expect(result.diagnostics!.some((d) => d.code === 'UNKNOWN_CREATE_WORKFLOW_KEY')).toBe(true);
    } finally {
      DEFAULT_POLICY.UNKNOWN_STEP_KEY = original;
    }
  });
});
