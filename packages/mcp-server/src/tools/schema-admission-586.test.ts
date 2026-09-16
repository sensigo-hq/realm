/**
 * Issue #586 — the MCP half: `start_run` and `start_run_batch` apply a declared `params_schema`
 * before any run is created, and `create_workflow` refuses a malformed step `input_schema` at its
 * own admission door.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { WorkflowError } from '@sensigo/realm';
import { handleStartRun } from './start-run.js';
import { handleStartRunBatch } from './start-run-batch.js';
import { handleCreateWorkflow } from './create-workflow.js';

const workflow: WorkflowDefinition = {
  id: 'sa',
  name: 'SA',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  params_schema: {
    type: 'object',
    properties: { ticket_id: { type: 'string' } },
    required: ['ticket_id'],
  } as never,
  steps: { a: { description: 'a', execution: 'agent' } },
};

describe('#586 params_schema on the MCP run-creation surfaces', () => {
  let runDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-586-run-'));
    const wfDir = await mkdtemp(join(tmpdir(), 'realm-586-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(wfDir);
    await workflowStore.register(workflow);
  });

  const runCount = async (): Promise<number> =>
    (await readdir(runDir)).filter((f) => f.endsWith('.json')).length;

  it('start_run refuses violating params with VALIDATION_INPUT_SCHEMA and creates NO run', async () => {
    await expect(
      handleStartRun({ workflow_id: 'sa', params: { ticket_id: 42 } }, { runStore, workflowStore }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_INPUT_SCHEMA',
      message: "Invalid params for workflow 'sa': /ticket_id must be string",
    });
    expect(await runCount()).toBe(0);
  });

  it('start_run refuses a MISSING required param at the root', async () => {
    await expect(
      handleStartRun({ workflow_id: 'sa', params: {} }, { runStore, workflowStore }),
    ).rejects.toThrow("Invalid params for workflow 'sa': (root) must have required property");
    expect(await runCount()).toBe(0);
  });

  it('start_run refuses BEFORE the registry resolve — a throwing provider is never reached', async () => {
    // The refusal must not depend on a registryProvider succeeding: the window between the params
    // and `runStore.create` spans the resolve, and a params problem is the operator's problem.
    let resolved = false;
    await expect(
      handleStartRun({ workflow_id: 'sa', params: { ticket_id: 42 } }, {
        runStore,
        workflowStore,
        registryProvider: () => {
          resolved = true;
          throw new WorkflowError('provider exploded', {
            code: 'ENGINE_INTERNAL',
            category: 'ENGINE',
            agentAction: 'stop',
            retryable: false,
          });
        },
      } as never),
    ).rejects.toThrow('Invalid params for workflow');
    expect(resolved).toBe(false);
    expect(await runCount()).toBe(0);
  });

  it('control: conforming params create a run', async () => {
    const result = await handleStartRun(
      { workflow_id: 'sa', params: { ticket_id: 't-1' } },
      { runStore, workflowStore },
    );
    expect(result).toBeDefined();
    expect(await runCount()).toBe(1);
  });

  it('start_run_batch reports the item with the bracketed index and the params voice', async () => {
    // The batch throws VALIDATION_BATCH_ITEMS and carries the per-item rows on `details`.
    let failures: Array<{ index: number; reason: string }>;
    try {
      await handleStartRunBatch(
        { workflow_id: 'sa', items: [{ params: { ticket_id: 42 } }] },
        { runStore, workflowStore },
      );
      throw new Error('expected the batch to refuse');
    } catch (err) {
      const details = (err as WorkflowError).details as {
        failures?: Array<{ index: number; reason: string }>;
      };
      failures = details.failures ?? [];
    }
    expect(failures).toHaveLength(1);
    expect(failures[0]!.index).toBe(0);
    expect(failures[0]!.reason).toBe(
      "item[0]: Invalid params for workflow 'sa': /ticket_id must be string",
    );
    // The old text named a step that never existed: `Invalid input for step 'item[0]'`.
    expect(failures[0]!.reason).not.toContain('Invalid input for step');
  });
});

describe('#586 create_workflow — its own admission door', () => {
  let stores: { runStore: JsonFileStore; workflowStore: JsonWorkflowStore };
  let workflowDir: string;

  beforeEach(async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'realm-586-cw-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-586-cw-wf-'));
    stores = {
      runStore: new JsonFileStore(runDir),
      workflowStore: new JsonWorkflowStore(workflowDir),
    };
  });

  it('a malformed input_schema on a NON-strict step is refused — nothing registered, no run', async () => {
    // The placement proof: the compile sits ABOVE the `structured_output !== 'strict'` continue,
    // so it covers every step kind. Below it, this exact call would have registered.
    const result = await handleCreateWorkflow(
      {
        steps: [{ id: 'a', description: 'a', input_schema: { type: 'banana' } as never }],
      } as never,
      stores,
    );
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).toContain(
      "Step 'a': 'input_schema' is not a valid JSON Schema —",
    );
    expect(JSON.stringify(result)).toContain(
      'Every execute_step submission to this step would be rejected with that error at run time',
    );
    // The agent reads its OWN key, not Ajv's `data` root (walk #5, T5) — the same pointer rewrite
    // every other door applies.
    expect(JSON.stringify(result)).toContain(
      "'type' must be one of array, boolean, integer, null, number, object, string ('type: banana' here). Every execute_step",
    );
    expect(JSON.stringify(result)).toContain("; set 'type' to one of those values.");
    expect(JSON.stringify(result)).not.toContain('data/type');
    expect(await readdir(workflowDir)).toEqual([]);
  });

  it('a dangling $ref on a step input_schema is refused in the same sentence the loader mints', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [
          { id: 'a', description: 'a', input_schema: { $ref: '#/definitions/nope' } as never },
        ],
      } as never,
      stores,
    );
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).toContain(
      "'$ref' points at a definition this block does not have ('$ref: #/definitions/nope' here). Every execute_step",
    );
    // Alone at the block root → the remove act is the whole block (walk #20's YAML-null class).
    expect(JSON.stringify(result)).toContain(
      "; add that definition, or remove the 'input_schema' block.",
    );
    expect(JSON.stringify(result)).not.toContain("can't resolve reference");
    expect(await readdir(workflowDir)).toEqual([]);
  });

  it("a STRICT-CLASS input_schema (unknown keyword) opens 'is refused by realm's validator' at this door", async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [{ id: 'a', description: 'a', input_schema: { type: 'object', foo: 1 } as never }],
      } as never,
      stores,
    );
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).toContain(
      "Step 'a': 'input_schema' is refused by realm's validator — strict mode: unknown keyword: \\\"foo\\\". Every execute_step",
    );
    expect(JSON.stringify(result)).not.toContain('is not a valid JSON Schema');
    expect(await readdir(workflowDir)).toEqual([]);
  });

  it('the STRICT twin is refused by the same check, before the eligibility walk', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [
          {
            id: 'a',
            description: 'a',
            structured_output: 'strict',
            input_schema: { type: 'banana' } as never,
          },
        ],
      } as never,
      stores,
    );
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).toContain("'input_schema' is not a valid JSON Schema");
    // NOT the eligibility verdict — the compile refused the block before anything read it.
    expect(JSON.stringify(result)).not.toContain('missing_additional_properties');
    expect(await readdir(workflowDir)).toEqual([]);
  });

  // The consequence sentence has ONE home (core's SCHEMA_KEY_CONSEQUENCE): this door consumes it,
  // never re-types it. Source-text witness — a second copy is how walk #17's fold reached the
  // loader and not this door until the cell above went red.
  it('witness: create_workflow does not hand-type the consequence sentence', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'create-workflow.ts'),
      'utf8',
    );
    expect(src).not.toContain('execute_step submission');
    expect(src).toContain('SCHEMA_KEY_CONSEQUENCE.input_schema');
  });

  it('control: a VALID input_schema on a non-strict step still registers', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [{ id: 'a', description: 'a', input_schema: { type: 'object' } as never }],
      } as never,
      stores,
    );
    expect(result.status).toBe('ok');
  });
});
