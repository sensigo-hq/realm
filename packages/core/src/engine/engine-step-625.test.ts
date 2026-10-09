// engine-step-625.test.ts — issue #625 PR-2a, fold round 13.
//
// C83: `executeEngineStep` (a public core export) runs ONLY steps whose `execution` is `'auto'`.
// An agent step, a guard or a finalizer named to it is refused before anything is read or written:
// it throws a `WorkflowError` (`ENGINE_INTERNAL`) that names the step and its kind, and the run
// record is unchanged. Before C83 it ran an agent step as a bare `auto` step: `ok`, the step in
// `completed_steps`, and its dependency's output recorded as the agent's answer, with no model asked.
//
// C84: an agent step settled by its declared `validation_exhaustion` default after two answers its
// schema refused, then its bare `auto` dependent: the dependent records the DEFAULT (its one
// dependency's recorded output, `output_source: 'dependency'`) — never the refused answer, which
// 0.46.0 recorded (the chain handed the caller's input to the dependent).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { mkdtemp as mkdtempP, rm as rmP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeChain, executeEngineStep, executeStep } from './execution-loop.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { StepDispatcher } from './execution-loop.js';
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import { readFileSync as readDoc625 } from 'node:fs';
import { join as joinDoc625, dirname as dirDoc625 } from 'node:path';
import { fileURLToPath as urlDoc625 } from 'node:url';

/** C174: (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claimDoc625(page: string, sentence: string): void {
  const text = readDoc625(
    joinDoc625(dirDoc625(urlDoc625(import.meta.url)), '../../../..', page),
    'utf8',
  );
  expect(text.replace(/\s+/g, ' '), `${page} no longer says: ${sentence}`).toContain(
    sentence.replace(/\s+/g, ' '),
  );
}

async function withStore<T>(fn: (store: JsonFileStore) => Promise<T>): Promise<T> {
  const dir = await mkdtempP(join(tmpdir(), 'realm-engine-step-625-'));
  try {
    return await fn(new JsonFileStore(dir));
  } finally {
    await rmP(dir, { recursive: true, force: true });
  }
}

function def(steps: Record<string, StepDefinition>): WorkflowDefinition {
  return { id: 'engine-step-wf', name: 'EngineStep', version: 1, steps } as WorkflowDefinition;
}

const REFUSAL = (step: string, kind: string): string =>
  `executeEngineStep runs only 'auto' steps: step '${step}' has execution '${kind}', and the engine does not run it this way. Nothing was read or written.`;

/** Calls executeEngineStep and returns what it threw (or `undefined` with the reply it returned). */
async function refusalOf(
  store: JsonFileStore,
  d: WorkflowDefinition,
  runId: string,
  step: string,
): Promise<{ thrown: unknown; reply: unknown }> {
  const run = await store.get(runId);
  try {
    const reply = await executeEngineStep(store, d, { runId, step, run });
    return { thrown: undefined, reply };
  } catch (err) {
    return { thrown: err, reply: undefined };
  }
}

describe('#625 PR-2a, C83 — executeEngineStep runs only auto steps', () => {
  const agentDef = def({
    prep: { description: 'Prep.', execution: 'auto', depends_on: [] } as StepDefinition,
    ask: { description: 'Ask.', execution: 'agent', depends_on: ['prep'] } as StepDefinition,
  });

  it('an agent step (eligible, after its dependency ran) is refused with a throw; the record is unchanged', async () => {
    await withStore(async (store) => {
      const { run } = await store.create({
        workflowId: agentDef.id,
        workflowVersion: 1,
        params: { topic: 'x' },
      });
      const prep = await executeEngineStep(store, agentDef, {
        runId: run.id,
        step: 'prep',
        run: await store.get(run.id),
      });
      // (a) prep's own run breaks: a regression of the control below. (b) prints the reply status.
      expect(prep.status).toBe('ok');
      const before = await store.get(run.id);
      const { thrown, reply } = await refusalOf(store, agentDef, run.id, 'ask');
      // (a) C83's refusal removed → the agent step runs as a bare auto step: no throw, `ok`.
      // (b) prints the reply that came back instead of a throw.
      expect(reply).toBeUndefined();
      expect(thrown).toBeInstanceOf(WorkflowError);
      const err = thrown as WorkflowError;
      expect(err.message).toBe(REFUSAL('ask', 'agent'));
      expect(err.code).toBe('ENGINE_INTERNAL');
      expect(err.agentAction).toBe('stop');
      expect(err.retryable).toBe(false);
      expect(err.stepId).toBe('ask');
      expect(err.details).toEqual({ step: 'ask', execution: 'agent' });
      const after = await store.get(run.id);
      // (a) the refusal placed after a write (or removed) → the record moves. (b) prints the diff.
      expect(after.version).toBe(before.version);
      expect(after.completed_steps).toEqual(['prep']);
      expect(after.evidence).toEqual(before.evidence);
      expect(after).toEqual(before);
    });
  });

  it('a guard step is refused the same way; the record is unchanged', async () => {
    await withStore(async (store) => {
      const d = def({
        step_a: { description: 'a', execution: 'agent', depends_on: [] } as StepDefinition,
        guard_b: {
          description: 'g',
          execution: 'guard',
          depends_on: ['step_a'],
          abort_unless: ["step_a.status == 'open'"],
        } as StepDefinition,
      });
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const before = await store.get(run.id);
      const { thrown, reply } = await refusalOf(store, d, run.id, 'guard_b');
      // (a) the refusal removed → executeStep's own reply comes back. (b) prints that reply.
      expect(reply).toBeUndefined();
      expect(thrown).toBeInstanceOf(WorkflowError);
      expect((thrown as WorkflowError).message).toBe(REFUSAL('guard_b', 'guard'));
      expect((thrown as WorkflowError).code).toBe('ENGINE_INTERNAL');
      const after = await store.get(run.id);
      expect(after.version).toBe(before.version);
      expect(after.completed_steps).toEqual([]);
      expect(after.evidence).toEqual([]);
      expect(after).toEqual(before);
    });
  });

  it('a finalizer step is refused the same way; the record is unchanged', async () => {
    await withStore(async (store) => {
      const d = def({
        work: { description: 'w', execution: 'auto', depends_on: [] } as StepDefinition,
        fin: { description: 'f', execution: 'finalizer', on_outcome: 'always' } as StepDefinition,
      });
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const before = await store.get(run.id);
      const { thrown, reply } = await refusalOf(store, d, run.id, 'fin');
      // (a) the refusal removed → executeStep's own reply comes back. (b) prints that reply.
      expect(reply).toBeUndefined();
      expect(thrown).toBeInstanceOf(WorkflowError);
      expect((thrown as WorkflowError).message).toBe(REFUSAL('fin', 'finalizer'));
      expect((thrown as WorkflowError).code).toBe('ENGINE_INTERNAL');
      const after = await store.get(run.id);
      expect(after.version).toBe(before.version);
      expect(after.completed_steps).toEqual([]);
      expect(after.evidence).toEqual([]);
      expect(after).toEqual(before);
    });
  });

  it('a step with no `execution` (a definition built without the loader) is refused too, said as such', async () => {
    await withStore(async (store) => {
      const d = def({
        odd: { description: 'No execution key.', depends_on: [] } as unknown as StepDefinition,
      });
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const before = await store.get(run.id);
      const { thrown } = await refusalOf(store, d, run.id, 'odd');
      // (a) the "no execution" arm dropped → the message says "execution 'undefined'". (b) prints it.
      expect((thrown as WorkflowError).message).toBe(
        "executeEngineStep runs only 'auto' steps: step 'odd' has no execution, and the engine does not run it this way. Nothing was read or written.",
      );
      expect((thrown as WorkflowError).details).toEqual({ step: 'odd', execution: null });
      expect(await store.get(run.id)).toEqual(before);
    });
  });

  it('CONTROL — an auto step runs as before: ok, completed, its bare output from the run params', async () => {
    claimDoc625(
      'docs/reference/run-record-and-export.md',
      "| `output_source` | text | No | On a bare `auto` step's entry only, where its output came from: `driven_step` (the output the caller that named the step gave), `dependency` (its one `depends_on` step's output), `run_params` (the run's params; it has no `depends_on`) or `none` (nothing to copy, so `{}`: the engine ran a step that depends on several steps, or whose one dependency has no successful entry).",
    );
    await withStore(async (store) => {
      const { run } = await store.create({
        workflowId: agentDef.id,
        workflowVersion: 1,
        params: { topic: 'x' },
      });
      const { thrown, reply } = await refusalOf(store, agentDef, run.id, 'prep');
      // (a) the refusal widened to auto steps → it throws. (b) prints the thrown error.
      expect(thrown).toBeUndefined();
      expect((reply as { status: string }).status).toBe('ok');
      const after = await store.get(run.id);
      expect(after.completed_steps).toEqual(['prep']);
      const entry = after.evidence.find((e) => e.step_id === 'prep');
      expect(entry?.output_summary).toEqual({ topic: 'x' });
      expect(entry?.output_source).toBe('run_params');
    });
  });

  it('CONTROL — a gate step (execution: auto) runs as before: the gate opens', async () => {
    await withStore(async (store) => {
      const d = def({
        confirm: {
          description: 'Confirm.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
        } as StepDefinition,
      });
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const { thrown, reply } = await refusalOf(store, d, run.id, 'confirm');
      // (a) the refusal keyed on "has a gate" or on trust → it throws. (b) prints the error.
      expect(thrown).toBeUndefined();
      expect((reply as { status: string }).status).toBe('confirm_required');
      const after = await store.get(run.id);
      expect(after.pending_gate?.step_name).toBe('confirm');
    });
  });

  it("CONTROL — a step the definition does not have keeps executeStep's own refusal", async () => {
    await withStore(async (store) => {
      const { run } = await store.create({
        workflowId: agentDef.id,
        workflowVersion: 1,
        params: { topic: 'x' },
      });
      const viaEngine = await refusalOf(store, agentDef, run.id, 'nope');
      // (a) the refusal widened to unknown names → it throws. (b) prints the error.
      expect(viaEngine.thrown).toBeUndefined();
      const direct = await executeStep(store, agentDef, {
        runId: run.id,
        command: 'nope',
        input: {},
        dispatcher: async () => ({}),
      });
      const r = viaEngine.reply as { status: string; error_code?: string; context_hint: string };
      expect({ status: r.status, error_code: r.error_code, context_hint: r.context_hint }).toEqual({
        status: direct.status,
        error_code: direct.error_code,
        context_hint: direct.context_hint,
      });
    });
  });
});

describe('#625 PR-2a, C84 — a bare dependent of a step settled by its declared default records the default', () => {
  const echo: StepDispatcher = async (_name, input) => ({ ...input });
  const d = def({
    classify: {
      description: 'Classify the ticket.',
      execution: 'agent',
      depends_on: [],
      output_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['category'],
        properties: { category: { type: 'string', enum: ['billing', 'technical', 'other'] } },
      },
      validation_exhaustion: {
        threshold: 2,
        mode: 'default',
        default_output: { category: 'other' },
      },
    } as StepDefinition,
    route: {
      description: 'Route the ticket.',
      execution: 'auto',
      depends_on: ['classify'],
    } as StepDefinition,
  });

  it('two refused answers through executeChain, then the bare dependent: the default, from the dependency', async () => {
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const refused = { category: 'refunds' };
      const first = await executeChain(store, d, {
        runId: run.id,
        command: 'classify',
        input: refused,
        dispatcher: echo,
      });
      // (a) the threshold or the schema changed → the first answer settles. (b) prints the reply.
      expect(first.status).toBe('error');
      expect(first.error_code).toBe('VALIDATION_OUTPUT_SCHEMA');
      const second = await executeChain(store, d, {
        runId: run.id,
        command: 'classify',
        input: refused,
        dispatcher: echo,
      });
      expect(second.status).toBe('ok');
      const after = await store.get(run.id);
      expect(after.completed_steps).toEqual(['classify', 'route']);
      expect(after.defaulted_steps).toEqual(['classify']);
      const route = after.evidence.find((e) => e.step_id === 'route');
      // (a) the bare step's output read from the dependency's INPUT (the refused answer), or from the
      // caller's input → `{"category":"refunds"}`. (b) prints the recorded output.
      expect(route?.output_summary).toEqual({ category: 'other' });
      expect(route?.output_source).toBe('dependency');
      // the refused answer appears nowhere in the dependent's entry (0.46.0 recorded it there)
      expect(JSON.stringify(route)).not.toContain('refunds');
    });
  });
});
