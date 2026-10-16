// by-name-way-out-625.test.ts — issue #625 PR-2a, decision C66: `execute_step` called BY NAME on an
// `auto` step the engine refuses before its claim. For a failed precondition or an invalid `trust`
// the cause is the record or the workflow, which the caller cannot change: when the run cannot go on
// until its workflow is corrected, the reply's `context_hint` ends with the way out in the tools'
// words — core's `cannotRunWayOutTools()` — and in every other state the reply is byte-identical to
// the step's own refusal. An input-schema refusal of an `auto` step is judged on the input the
// engine builds, never the caller's (#729 Q3 correction 1): when the run cannot go on, it too ends
// with the step's own way out. Whole-message pins.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleExecuteStep } from './execute-step.js';

const WAY_OUT =
  'Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.';

/** `compute` (auto, shaped by `check`), with an agent step beside it when `withAgent`. */
function def(id: string, check: Partial<StepDefinition>, withAgent: boolean): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      ...(withAgent
        ? { summarize: { description: 'Summarize.', execution: 'agent' as const, depends_on: [] } }
        : {}),
      compute: {
        description: 'Compute.',
        execution: 'auto',
        depends_on: [],
        ...check,
      } as StepDefinition,
    },
  };
}

const PRECONDITION: Partial<StepDefinition> = { preconditions: ['run.params.ok == true'] };
const TRUST = { trust: 'human_confirm' } as unknown as Partial<StepDefinition>;
/** An invalid `trust` value's own refusal hint (the errors carry the four-clause refusal). */
const TRUST_HINT = "Error during 'compute'. Run phase: 'running'.";
const INPUT: Partial<StepDefinition> = {
  input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
};

describe('#625 PR-2a, C66 — execute_step by name on a step refused before its claim', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-by-name-625-'));
    runStore = new JsonFileStore(join(dir, 'runs'));
    workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  });

  async function callCompute(d: WorkflowDefinition, params?: Record<string, unknown>) {
    await workflowStore.register(d);
    const { run } = await runStore.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    return handleExecuteStep(
      { run_id: run.id, command: 'compute', ...(params !== undefined ? { params } : {}) },
      { runStore, workflowStore },
    );
  }

  it('precondition, nothing else can run: the refusal, then the way out', async () => {
    const reply = await callCompute(def('bn-pre', PRECONDITION, false));
    // (a) red when the way out is dropped or composed outside core; (b) prints status and hint.
    expect({ status: reply.status, hint: reply.context_hint }).toEqual({
      status: 'blocked',
      hint: `Precondition failed for step 'compute'. ${WAY_OUT}`,
    });
  });

  it('CONTROL — precondition, an agent step is ready: the refusal byte-identical', async () => {
    const reply = await callCompute(def('bn-pre-ready', PRECONDITION, true));
    // (a) red when the way out is added outside the cannot-go-on state; (b) prints status and hint.
    expect({ status: reply.status, hint: reply.context_hint }).toEqual({
      status: 'blocked',
      hint: "Precondition failed for step 'compute'.",
    });
  });

  it('trust, nothing else can run: the refusal, then the way out', async () => {
    const reply = await callCompute(def('bn-trust', TRUST, false));
    // (a) red when the trust member is left out; (b) prints status, code and hint.
    expect({
      status: reply.status,
      error_code: reply.error_code,
      hint: reply.context_hint,
    }).toEqual({
      status: 'error',
      error_code: 'VALIDATION_TRUST_VALUE',
      hint: `${TRUST_HINT} ${WAY_OUT}`,
    });
  });

  it('CONTROL — trust, an agent step is ready: the refusal byte-identical', async () => {
    const reply = await callCompute(def('bn-trust-ready', TRUST, true));
    // (a) red when the way out is added outside the cannot-go-on state; (b) prints the hint.
    expect({ error_code: reply.error_code, hint: reply.context_hint }).toEqual({
      error_code: 'VALIDATION_TRUST_VALUE',
      hint: TRUST_HINT,
    });
  });

  // pre-Q3c1 title: 'input_schema, nothing else can run: the refusal unchanged (the input is the
  // caller’s own)'
  it('input_schema, nothing else can run: refused on the engine’s input, the hint ends with the step’s own way out (#729 Q3 correction 1)', async () => {
    // The caller's params FIT (`n` is a number) while the engine's input (the run's `{}`) does not,
    // so a check that judged the caller's input would let the call past this refusal.
    const reply = await callCompute(def('bn-input', INPUT, false), { n: 5 });
    // (a) red when the refusal judges the caller's input (#729 Q3 correction 1, C1a) or drops the way
    //     out (C1b, the architect's ruling (A) in render-reply's hintOf); (b) prints status, code and
    //     hint.
    expect({
      status: reply.status,
      error_code: reply.error_code,
      hint: reply.context_hint,
    }).toEqual({
      status: 'error',
      error_code: 'VALIDATION_INPUT_SCHEMA',
      hint: "Error during 'compute'. Run phase: 'running'. For 'compute', start a run with params that fit, or correct its input_schema and register the workflow again; this run stays open — after a fix, call advance_run on it; or end it with abandon_run.",
    });
  });
});
