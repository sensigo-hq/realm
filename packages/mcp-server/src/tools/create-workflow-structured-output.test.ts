// create_workflow structured_output tests (issue #236, Deliverable 2 — the 4-touch-point wiring).
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore } from '@sensigo/realm';
import { handleCreateWorkflow, type CreateWorkflowArgs } from './create-workflow.js';

describe('create_workflow — structured_output (issue #236)', () => {
  let runDir: string;
  let workflowDir: string;
  let stores: { runStore: JsonFileStore; workflowStore: JsonWorkflowStore };

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-cw-so-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-cw-so-wf-'));
    stores = {
      runStore: new JsonFileStore(runDir),
      workflowStore: new JsonWorkflowStore(workflowDir),
    };
  });

  it('an eligible schema is created, and the registered definition carries structured_output (touch point 3: the copy loop)', async () => {
    const args: CreateWorkflowArgs = {
      steps: [
        {
          id: 'classify',
          description: 'Classify the ticket',
          structured_output: 'strict',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['category'],
            properties: { category: { type: 'string' } },
          },
        },
      ],
    };
    const result = await handleCreateWorkflow(args, stores);
    expect(result.status).toBe('ok');
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.steps['classify']!.structured_output).toBe('strict');
  });

  it('an ineligible schema is REJECTED pre-register — no workflow is created, no run is started (touch point: validateArgs joins PRE-register)', async () => {
    const args: CreateWorkflowArgs = {
      steps: [
        {
          id: 'classify',
          description: 'Classify the ticket',
          structured_output: 'strict',
          input_schema: {
            type: 'object',
            // additionalProperties: false deliberately OMITTED — G1 ineligible
            required: ['category'],
            properties: { category: { type: 'string' } },
          },
        },
      ],
    };
    const result = await handleCreateWorkflow(args, stores);
    expect(result.status).toBe('error');
    expect(result.errors.some((e) => e.includes('not eligible'))).toBe(true);
    expect(result.errors.some((e) => e.includes('additionalProperties: false'))).toBe(true);
    expect(result.run_id).toBe('');

    // Register/start_run never reached — nothing was created.
    const list = await stores.workflowStore.list();
    expect(list).toHaveLength(0);
  });

  it('an eligible_with_caveats schema is created, and its caveat renders into envelope.warnings (never a WarningCode)', async () => {
    const args: CreateWorkflowArgs = {
      steps: [
        {
          id: 'classify',
          description: 'Classify the ticket',
          structured_output: 'strict',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['category'],
            properties: { category: { type: 'string', pattern: '^[a-z]+$' } },
          },
        },
      ],
    };
    const result = await handleCreateWorkflow(args, stores);
    expect(result.status).toBe('ok');
    expect(
      result.warnings.some((w) => w.includes('classify') && w.includes('structured_output')),
    ).toBe(true);
    // Never disclosed as a structured LoaderWarning diagnostic — this is a render-only caveat,
    // not a WarningCode-bearing diagnostic.
    expect((result.diagnostics ?? []).some((d) => d.code === 'structured_output')).toBe(false);
  });

  it('a step with no structured_output key is entirely unaffected — no gate, no caveat, no field on the registered definition', async () => {
    const args: CreateWorkflowArgs = {
      steps: [{ id: 'plain', description: 'A plain step' }],
    };
    const result = await handleCreateWorkflow(args, stores);
    expect(result.status).toBe('ok');
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.steps['plain']!.structured_output).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('structured_output'))).toBe(false);
  });
});
