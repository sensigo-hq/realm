// issue #759 — the engine's refusal carries every problem: the typed facts with the countdown (Part
// C), the exhaustion bag (Part C), the re-mint of an engine-built input (Part D.1), core's reply
// reader on real replies (Part D.2), the loader's `default_output` line (Part D.4(c)), and the
// end-to-end that gave the issue its name (AC6). Every reply here is the real engine's. A failure
// prints codes, counts and key names — never a submitted value.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep, DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD } from './execution-loop.js';
import type { StepDispatcher } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { WorkflowError, type ValidationErrorFacts } from '../types/workflow-error.js';
import type {
  WorkflowDefinition,
  StepDefinition,
  JsonSchema,
} from '../types/workflow-definition.js';
import { validationListOf } from '../validation/validation-problems.js';
import { loadWorkflowFromString } from '../workflow/yaml-loader.js';
import { agentActionFor } from '../test-support/ways-view.js';

const echo: StepDispatcher = async (_name, input) => ({ ...input });

async function freshStore(): Promise<JsonFileStore> {
  return new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-759-')));
}

function def(steps: Record<string, StepDefinition>): WorkflowDefinition {
  return { id: 'refusal-759', name: 'R', version: 1, steps } as WorkflowDefinition;
}

/** A schema requiring `n` string fields f01…fNN — `{}` breaks exactly `n` rules. */
const requiring = (n: number): JsonSchema => ({
  type: 'object',
  required: Array.from({ length: n }, (_, i) => `f${String(i + 1).padStart(2, '0')}`),
  properties: Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`f${String(i + 1).padStart(2, '0')}`, { type: 'string' }]),
  ),
});

const factsOf = (reply: { error?: { facts?: unknown } }) =>
  reply.error?.facts as ValidationErrorFacts | undefined;

describe('issue #759 — the refusal on the engine reply', () => {
  it("an agent step's counted rejection: the countdown rides the typed facts with the ten rows and the total; no `error_details` (red: write the count into `details`)", async () => {
    const store = await freshStore();
    const d = def({
      extract: { description: 'E', execution: 'agent', output_schema: requiring(13) },
    });
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const reply = await executeStep(store, d, {
      runId: run.id,
      command: 'extract',
      input: {},
      dispatcher: echo,
    });
    const facts = factsOf(reply);
    expect({
      code: reply.error_code,
      rows: facts?.errors.length,
      total: facts?.error_count,
      rejections: facts?.rejections,
      threshold: facts?.threshold,
      errorDetails: reply.error_details,
    }).toEqual({
      code: 'VALIDATION_OUTPUT_SCHEMA',
      rows: 10,
      total: 13,
      rejections: 1,
      threshold: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
      errorDetails: undefined,
    });
  });

  it('an engine-built input is not counted: its facts carry the rows and the total, no countdown', async () => {
    const store = await freshStore();
    const d = def({ x: { description: 'X', execution: 'auto', input_schema: requiring(3) } });
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const reply = await executeStep(store, d, {
      runId: run.id,
      command: 'x',
      input: {},
      dispatcher: echo,
    });
    expect(factsOf(reply)).toEqual({
      errors: expect.any(Array),
      error_count: 3,
    });
    expect(factsOf(reply)?.errors).toHaveLength(3);
  });

  it('six refusals of a 13-problem answer exhaust the step: the bag keeps the last ten rows and the total (reds: uncapped rows; no count)', async () => {
    const store = await freshStore();
    const d = def({
      extract: { description: 'E', execution: 'agent', output_schema: requiring(13) },
    });
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    let reply = await executeStep(store, d, {
      runId: run.id,
      command: 'extract',
      input: {},
      dispatcher: echo,
    });
    for (let i = 1; i < DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD; i += 1) {
      reply = await executeStep(store, d, {
        runId: run.id,
        command: 'extract',
        input: {},
        dispatcher: echo,
      });
    }
    expect({
      code: reply.error_code,
      rows: (reply.error_details?.['last_ajv_errors'] as unknown[] | undefined)?.length,
      total: reply.error_details?.['last_error_count'],
      rejections: reply.error_details?.['rejections'],
      list: validationListOf(reply) && {
        rows: validationListOf(reply)!.errors.length,
        total: validationListOf(reply)!.error_count,
      },
    }).toEqual({
      code: 'VALIDATION_EXHAUSTED',
      rows: 10,
      total: 13,
      rejections: 6,
      list: { rows: 10, total: 13 },
    });
  });

  it("an input_map-built refusal's reply keeps the typed facts with EVERY problem through the re-mint (red: drop the copy)", async () => {
    const store = await freshStore();
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', { id: 'h', execute: async () => ({ data: {} }) } as never);
    const d = def({
      x: {
        description: 'X',
        execution: 'auto',
        handler: 'h',
        input_map: { a: 'run.params.a', b: 'run.params.b' },
        input_schema: {
          type: 'object',
          required: ['a', 'b'],
          properties: { a: { type: 'number' }, b: { type: 'number' } },
        },
      },
    });
    const { run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: { a: 'one', b: 'two' },
    });
    const reply = await executeStep(store, d, {
      runId: run.id,
      command: 'x',
      input: {},
      dispatcher: echo,
      registry,
    });
    expect({
      code: reply.error_code,
      action: agentActionFor(reply),
      paths: factsOf(reply)?.errors.map((e) => e.instancePath),
      total: factsOf(reply)?.error_count,
      list: validationListOf(reply)?.error_count,
    }).toEqual({
      code: 'VALIDATION_INPUT_SCHEMA',
      action: 'report_to_user',
      paths: ['/a', '/b'],
      total: 2,
      list: 2,
    });
  });

  it("the loader's `default_output` refusal names every rule it breaks in the pointer words (reds: the string `undefined`; the raw JSON of the rows)", () => {
    let message = '';
    try {
      loadWorkflowFromString(`
id: vx-759-wf
name: VX 759
version: 1
steps:
  draft:
    description: Draft
    execution: agent
    output_schema:
      type: object
      required: [category, score]
      properties:
        category: { type: string }
    validation_exhaustion:
      mode: default
      default_output: { category: 1 }
`);
    } catch (err) {
      if (!(err instanceof WorkflowError)) throw err;
      message = err.message;
    }
    expect(message).toContain(
      "'validation_exhaustion.default_output' does not validate against the step's own 'output_schema': (root) must have required property 'score'; /category must be string",
    );
  });
});

describe('issue #759 — AC6: the end-to-end that gave the issue its name', () => {
  it('an agent that fixes what the refusal names settles a nine-field step after ONE refusal; the count is 1 and the threshold untouched (red: `allErrors` off — one problem per refusal, exhausted at the sixth)', async () => {
    const store = await freshStore();
    const d = def({
      extract: { description: 'E', execution: 'agent', output_schema: requiring(9) },
    });
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const answer: Record<string, unknown> = {};
    const named: number[] = [];
    let last = '';
    for (let round = 1; round <= 9; round += 1) {
      const reply = await executeStep(store, d, {
        runId: run.id,
        command: 'extract',
        input: { ...answer },
        dispatcher: echo,
      });
      last = reply.error_code ?? reply.status;
      if (reply.status !== 'error' || reply.error_code !== 'VALIDATION_OUTPUT_SCHEMA') break;
      const list = validationListOf(reply)?.errors ?? [];
      named.push(list.length);
      // the agent fixes exactly what it was told
      for (const row of list as Array<{ params?: { missingProperty?: string } }>) {
        const field = row.params?.missingProperty;
        if (field !== undefined) answer[field] = 'v';
      }
    }
    const after = await store.get(run.id);
    expect({
      namedPerRefusal: named,
      last,
      rejections: after.validation_rejections?.['extract'],
      completed: after.completed_steps.includes('extract'),
      threshold: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
    }).toEqual({
      namedPerRefusal: [9],
      last: 'ok',
      rejections: 1,
      completed: true,
      threshold: 6,
    });
  });
});
