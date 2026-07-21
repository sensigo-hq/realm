// Integration tests for issue #220 §4c (PR-3) — the `$settlement` evaluation-root namespace,
// exercised through the REAL engine (executeStep/executeChain/submitHumanResponse), as opposed to
// eligibility.test.ts's direct unit tests of buildSettlementNamespace/buildEvidenceByStep.
// Letter labels match the design record's §5 pin set (aa, bb, ff) for mechanical diffing against
// mutation probes.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeStep,
  executeChain,
  submitHumanResponse,
  DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
} from './execution-loop.js';
import type { StepDispatcher } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const echoDispatcher: StepDispatcher = async (_step, input) => ({ ...input });

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['category'],
  properties: { category: { type: 'string' } },
};
const DEFAULT_OUTPUT = { category: 'fallback' };
const INVALID_OUTPUT = {}; // missing 'category' — fails output_schema
const VALID_OUTPUT = { category: 'ok' };

describe('issue #220 §4c (PR-3) — $settlement namespace, end-to-end', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-settlement-test-'));
    store = new JsonFileStore(dir);
  });

  describe('(aa) when-branch flips eligibility on $settlement', () => {
    const def: WorkflowDefinition = {
      id: 'settlement-aa-wf',
      name: 'Settlement AA',
      version: 1,
      steps: {
        step1: {
          description: 'Step1',
          execution: 'agent',
          output_schema: OUTPUT_SCHEMA,
          validation_exhaustion: { mode: 'default', default_output: DEFAULT_OUTPUT },
        },
        step2: {
          description: 'Step2 — eligible only when step1 did NOT default-settle',
          execution: 'auto',
          depends_on: ['step1'],
          when: ['$settlement.step1.settled_by_default == false'],
        },
      },
    };

    it('step1 settles NORMALLY (its own valid output) ⇒ $settlement.step1.settled_by_default === false ⇒ step2 becomes ELIGIBLE', async () => {
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await executeStep(store, def, {
        runId: run.id,
        command: 'step1',
        input: VALID_OUTPUT,
        dispatcher: echoDispatcher,
      });
      const step2Envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'step2',
        input: {},
        dispatcher: echoDispatcher,
      });
      expect(step2Envelope.status).toBe('ok');
      const after = await store.get(run.id);
      expect(after.completed_steps).toContain('step2');
    });

    it('step1 DEFAULT-settles (exhaustion) ⇒ $settlement.step1.settled_by_default === true ⇒ step2 is NEVER eligible (skipped)', async () => {
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await store.update({
        ...run,
        validation_rejections: { step1: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
      });
      await executeStep(store, def, {
        runId: run.id,
        command: 'step1',
        input: INVALID_OUTPUT,
        dispatcher: echoDispatcher,
      });
      // step2 is not eligible — a direct executeStep call on it must be 'blocked'.
      const step2Envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'step2',
        input: {},
        dispatcher: echoDispatcher,
      });
      expect(step2Envelope.status).toBe('blocked');
      const after = await store.get(run.id);
      expect(after.completed_steps).not.toContain('step2');
      // propagateSkips: once step1 is settled and step2's when is false, step2 is provably
      // never-eligible and gets skipped (surfacing the run as complete).
      expect(after.skipped_steps).toContain('step2');
      expect(after.terminal_state).toBe(true);
    });
  });

  it('THE gate-response inversion, end-to-end: a human_confirmed × mode:default step default-settles via submitHumanResponse; a downstream step reading $settlement.<step>.settled_by_default sees TRUE, not the gate_response-erased false', async () => {
    const def: WorkflowDefinition = {
      id: 'settlement-gate-inversion-wf',
      name: 'Settlement Gate Inversion',
      version: 1,
      steps: {
        step1: {
          description: 'Step1 — human_confirmed default-settle',
          execution: 'agent',
          trust: 'human_confirmed',
          output_schema: OUTPUT_SCHEMA,
          validation_exhaustion: { mode: 'default', default_output: DEFAULT_OUTPUT },
        },
        step2: {
          description: 'Step2 — reads $settlement.step1 AFTER the gate resolves',
          execution: 'auto',
          depends_on: ['step1'],
          when: ['$settlement.step1.settled_by_default == true'],
        },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      validation_rejections: { step1: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
    });
    const gateEnvelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step1',
      input: INVALID_OUTPUT,
      dispatcher: echoDispatcher,
    });
    expect(gateEnvelope.status).toBe('confirm_required');

    await submitHumanResponse(store, def, {
      runId: run.id,
      gateId: gateEnvelope.gate!.gate_id,
      choice: 'approve',
    });

    // step2's evidence-chain for step1 now has [execution snap (settled_by_default:true),
    // gate_response snap (no diagnostics)] — chronologically the gate_response is LAST. Reading
    // "the last snapshot" naively would materialize false and step2 would never become eligible.
    const step2Envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step2',
      input: {},
      dispatcher: echoDispatcher,
    });
    expect(step2Envelope.status).toBe('ok');
    const after = await store.get(run.id);
    expect(after.completed_steps).toContain('step2');
  });

  it('(ff) a typoed $settlement field on `when` traces lhs_present:false (never silently truthy/falsy without a trace) and the step is skipped', async () => {
    const def: WorkflowDefinition = {
      id: 'settlement-ff-typo-wf',
      name: 'Settlement FF Typo',
      version: 1,
      steps: {
        step1: {
          description: 'Step1',
          execution: 'agent',
          output_schema: OUTPUT_SCHEMA,
        },
        step2: {
          description: 'Step2 — typo in the FIELD segment (not the dep segment)',
          execution: 'auto',
          depends_on: ['step1'],
          when: ['$settlement.step1.bogus_field == true'],
        },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeStep(store, def, {
      runId: run.id,
      command: 'step1',
      input: VALID_OUTPUT,
      dispatcher: echoDispatcher,
    });
    const after = await store.get(run.id);
    expect(after.skipped_steps).toContain('step2');
    const detail = after.skip_details?.['step2'];
    if (detail?.kind !== 'when_false') throw new Error('expected when_false detail');
    expect(detail.leaves[0]).toMatchObject({ lhs_present: false, passed: false });
  });

  it('(bb) guard abort_unless blocks (aborts) the run when the dep default-settled', async () => {
    const def: WorkflowDefinition = {
      id: 'settlement-bb-wf',
      name: 'Settlement BB',
      version: 1,
      steps: {
        step1: {
          description: 'Step1',
          execution: 'agent',
          output_schema: OUTPUT_SCHEMA,
          validation_exhaustion: { mode: 'default', default_output: DEFAULT_OUTPUT },
        },
        guard_step: {
          description: 'Guard — aborts unless step1 settled on its own (not via default)',
          execution: 'guard',
          depends_on: ['step1'],
          abort_unless: ['$settlement.step1.settled_by_default == false'],
        },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      validation_rejections: { step1: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
    });
    await executeChain(store, def, {
      runId: run.id,
      command: 'step1',
      input: INVALID_OUTPUT,
      dispatcher: echoDispatcher,
    });
    const after = await store.get(run.id);
    expect(after.run_phase).toBe('aborted');
    expect(after.terminal_state).toBe(true);
    expect(after.aborted_at?.step_id).toBe('guard_step');
  });

  it('(bb) negative: the SAME guard PASSES when step1 settles on its own (not via default)', async () => {
    const def: WorkflowDefinition = {
      id: 'settlement-bb-neg-wf',
      name: 'Settlement BB Negative',
      version: 1,
      steps: {
        step1: {
          description: 'Step1',
          execution: 'agent',
          output_schema: OUTPUT_SCHEMA,
          validation_exhaustion: { mode: 'default', default_output: DEFAULT_OUTPUT },
        },
        guard_step: {
          description: 'Guard — aborts unless step1 settled on its own (not via default)',
          execution: 'guard',
          depends_on: ['step1'],
          abort_unless: ['$settlement.step1.settled_by_default == false'],
        },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeChain(store, def, {
      runId: run.id,
      command: 'step1',
      input: VALID_OUTPUT,
      dispatcher: echoDispatcher,
    });
    const after = await store.get(run.id);
    expect(after.run_phase).not.toBe('aborted');
    expect(after.completed_steps).toContain('guard_step');
  });
});
