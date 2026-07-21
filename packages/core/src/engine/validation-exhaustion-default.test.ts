// Tests for issue #220 PR-2 — declared fail-open (`validation_exhaustion.mode: 'default'`).
// Letter labels match the design record's §5 pin set (g, r, z) for mechanical diffing against
// mutation probes. PR-1's counting/terminalization tests live in validation-exhaustion.test.ts —
// this file is scoped to the NEW default-settle mechanism only.
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
import { WorkflowError } from '../types/workflow-error.js';
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import type { LoadBearingRunRecordField } from '../store/store-interface.js';

const echoDispatcher: StepDispatcher = async (_step, input) => ({ ...input });

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['category'],
  properties: { category: { type: 'string' } },
};
const DEFAULT_OUTPUT = { category: 'fallback' };
const INVALID_OUTPUT = {}; // missing 'category' — fails output_schema
const VALID_OUTPUT = { category: 'ok' };

/** Single-step agent workflow, mode: 'default' pre-wired. */
function makeDefaultDef(
  stepOverrides: Partial<StepDefinition> = {},
  extraSteps: Record<string, StepDefinition> = {},
): WorkflowDefinition {
  return {
    id: 'vx-default-wf',
    name: 'VX Default WF',
    version: 1,
    steps: {
      draft: {
        description: 'Draft',
        execution: 'agent',
        output_schema: OUTPUT_SCHEMA,
        validation_exhaustion: { mode: 'default', default_output: DEFAULT_OUTPUT },
        ...stepOverrides,
      },
      ...extraSteps,
    },
  };
}

async function driveToExhaustion(
  store: JsonFileStore,
  def: WorkflowDefinition,
  runId: string,
  command = 'draft',
): Promise<Awaited<ReturnType<typeof executeStep>>> {
  const run = await store.get(runId);
  await store.update({
    ...run,
    validation_rejections: { [command]: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
  });
  return executeStep(store, def, {
    runId,
    command,
    input: INVALID_OUTPUT,
    dispatcher: echoDispatcher,
  });
}

describe('issue #220 PR-2 — declared fail-open (validation_exhaustion.mode: default)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-vx-default-test-'));
    store = new JsonFileStore(dir);
  });

  describe('(g) V-D4 end-to-end default-settle', () => {
    it('(i)-(vi): settles successfully with default_output, terminalizes the run, stamps diagnostics, discloses on the envelope, and threads the store-honesty advisory', async () => {
      class UndeclaredFieldStore extends JsonFileStore {
        override readonly persistedRunRecordFields: ReadonlySet<LoadBearingRunRecordField> =
          new Set([
            'capability_blocks',
            'workflow_context_snapshots',
            'extension_identity',
            // deliberately omits 'validation_rejections' — mirrors test (k) in
            // validation-exhaustion.test.ts, to prove the store-honesty advisory rides the
            // default-settle SUCCESS envelope too (§5c nuance 1).
          ]);
      }
      const undeclaredStore = new UndeclaredFieldStore(dir);
      const def = makeDefaultDef();
      const { run } = await undeclaredStore.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await undeclaredStore.update({
        ...run,
        validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
      });

      const envelope = await executeStep(undeclaredStore, def, {
        runId: run.id,
        command: 'draft',
        input: INVALID_OUTPUT,
        dispatcher: echoDispatcher,
      });

      // (i) the step lands in completed_steps with output === default_output.
      expect(envelope.status).toBe('ok');
      const after = await undeclaredStore.get(run.id);
      expect(after.completed_steps).toContain('draft');
      expect(envelope.data).toEqual(DEFAULT_OUTPUT);

      // (ii) the run reaches terminal complete (single-step workflow).
      expect(after.terminal_state).toBe(true);
      expect(after.run_phase).toBe('completed');

      // (iii) the settle evidence carries diagnostics.settled_by_default === true +
      // validation_rejections === <count>.
      const settleEvidence = after.evidence.find(
        (e) => e.step_id === 'draft' && e.status === 'success',
      );
      expect(settleEvidence).toBeDefined();
      expect(settleEvidence?.output_summary).toEqual(DEFAULT_OUTPUT);
      expect(settleEvidence?.diagnostics?.settled_by_default).toBe(true);
      expect(settleEvidence?.diagnostics?.validation_rejections).toBe(
        DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
      );

      // (iv) the success envelope carries top-level settled_by_default === true.
      expect(envelope.settled_by_default).toBe(true);

      // (v) the human-readable default-settle line rides the plain success envelope's warnings.
      expect(envelope.warnings.join(' ')).toContain('settled with its declared default_output');
      expect(envelope.warnings.join(' ')).toContain(
        `after ${DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD} schema rejection`,
      );

      // (vi) the undeclared-but-persisting store's honesty advisory also rides that envelope.
      expect(envelope.warnings.join(' ')).toContain(
        'rejection counting not declared durable on this store',
      );
    });

    it('never sets settled_by_default on a step that succeeds via its OWN valid submission (no exhaustion)', async () => {
      const def = makeDefaultDef();
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'draft',
        input: VALID_OUTPUT,
        dispatcher: echoDispatcher,
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.data).toEqual(VALID_OUTPUT);
      expect(envelope.settled_by_default).toBeUndefined();
      const after = await store.get(run.id);
      const settleEvidence = after.evidence.find(
        (e) => e.step_id === 'draft' && e.status === 'success',
      );
      expect(settleEvidence?.diagnostics?.settled_by_default).toBeUndefined();
    });

    it('never sets settled_by_default even after PRIOR rejections, when the FINAL submission is the agent’s own valid output (not exhaustion-driven)', async () => {
      const def = makeDefaultDef();
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      // One rejection short of the threshold — not yet exhausted.
      await store.update({
        ...run,
        validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 2 },
      });
      await executeStep(store, def, {
        runId: run.id,
        command: 'draft',
        input: INVALID_OUTPUT,
        dispatcher: echoDispatcher,
      });
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'draft',
        input: VALID_OUTPUT,
        dispatcher: echoDispatcher,
      });
      expect(envelope.status).toBe('ok');
      expect(envelope.settled_by_default).toBeUndefined();
    });
  });

  describe('(r) V-D6 run-level disclosure: defaulted_steps', () => {
    it("control: a plain successful step with NO default-settled evidence reaches a terminal COMPLETE seal with defaulted_steps ABSENT (undefined), never an empty array — pins stampDefaultedSteps' byte-identity damage-rail (its `if (steps.length === 0) return sealDraft` early-return)", async () => {
      // Deliberately a workflow with NO `validation_exhaustion` at all — the step submits VALID
      // output on its first attempt (no exhaustion, no default-settle branch ever runs), so the
      // evidence set stampDefaultedSteps scans at the Step-6 'complete' seal contains ZERO
      // `diagnostics.settled_by_default` entries. This is the control the other (r) tests lack:
      // every existing `defaulted_steps).toBeUndefined()` assertion elsewhere in this file is
      // either on a FAIL-sealed record (never wrapped by stampDefaultedSteps at all) or a
      // non-terminal Step-6 envelope (finalRun === the un-stamped completeDraft) — neither one
      // actually calls stampDefaultedSteps with a zero-settled-by-default evidence set. This test
      // does: a mutant that deletes stampDefaultedSteps' empty-check (so it unconditionally
      // returns `{ ...sealDraft, defaulted_steps: steps }` with `steps === []`) would make
      // `after.defaulted_steps` equal `[]` instead of `undefined` here — a plain `toBeUndefined()`
      // catches that (`[]` is defined, and `expect([]).toBeUndefined()` fails).
      const plainDef: WorkflowDefinition = {
        id: 'vx-plain-wf',
        name: 'VX Plain WF',
        version: 1,
        steps: {
          draft: {
            description: 'Draft',
            execution: 'agent',
            output_schema: OUTPUT_SCHEMA,
          },
        },
      };
      const { run } = await store.create({
        workflowId: plainDef.id,
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, plainDef, {
        runId: run.id,
        command: 'draft',
        input: VALID_OUTPUT,
        dispatcher: echoDispatcher,
      });

      expect(envelope.status).toBe('ok');
      const after = await store.get(run.id);
      expect(after.terminal_state).toBe(true); // single-step workflow ⇒ Step-6 DOES seal 'complete'
      expect(envelope.defaulted_steps).toBeUndefined();
      expect(after.defaulted_steps).toBeUndefined(); // NOT [] — stampDefaultedSteps' early-return
    });

    it('(a) a mid-workflow default-settled step with a LATER terminal step ⇒ the terminal ok envelope carries defaulted_steps containing that step', async () => {
      const def = makeDefaultDef({}, { finish: { description: 'Finish', execution: 'auto' } });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const draftEnvelope = await driveToExhaustion(store, def, run.id);
      expect(draftEnvelope.status).toBe('ok');
      // Non-terminal — the qualifier is naturally absent here (§ D6, "on the NON-terminal Step-6
      // return this is naturally absent").
      expect(draftEnvelope.defaulted_steps).toBeUndefined();

      const finishEnvelope = await executeStep(store, def, {
        runId: run.id,
        command: 'finish',
        input: {},
        dispatcher: echoDispatcher,
      });

      expect(finishEnvelope.status).toBe('ok');
      const after = await store.get(run.id);
      expect(after.terminal_state).toBe(true);
      expect(finishEnvelope.defaulted_steps).toEqual(['draft']);
      expect(after.defaulted_steps).toEqual(['draft']); // JsonFileStore persists it too
    });

    it('(b) mode: default on a human_confirmed LAST step ⇒ approval via submitHumanResponse settles AND defaulted_steps is stamped', async () => {
      const def = makeDefaultDef({ trust: 'human_confirmed' });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const gateEnvelope = await driveToExhaustion(store, def, run.id);
      expect(gateEnvelope.status).toBe('confirm_required');

      const result = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: gateEnvelope.gate!.gate_id,
        choice: 'approve',
      });

      expect(result.status).toBe('ok');
      const after = await store.get(run.id);
      expect(after.completed_steps).toContain('draft');
      expect(after.terminal_state).toBe(true);
      expect(result.defaulted_steps).toEqual(['draft']);
      expect(after.defaulted_steps).toEqual(['draft']);
    });

    it('(c) a guard step that COMPLETES the run after a prior default-settle ⇒ stamped', async () => {
      const guardCompleteDef: WorkflowDefinition = makeDefaultDef(
        {},
        {
          guard_done: {
            description: 'Guard that completes the run',
            execution: 'guard',
            depends_on: ['draft'],
            abort_unless: [`draft.category == '${DEFAULT_OUTPUT.category}'`],
          },
        },
      );
      const { run } = await store.create({
        workflowId: guardCompleteDef.id,
        workflowVersion: 1,
        params: {},
      });
      await store.update({
        ...run,
        validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
      });

      const envelope = await executeChain(store, guardCompleteDef, {
        runId: run.id,
        command: 'draft',
        input: INVALID_OUTPUT,
        dispatcher: echoDispatcher,
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.chained_auto_steps?.some((s) => s.step === 'guard_done')).toBe(true);
      const after = await store.get(run.id);
      expect(after.terminal_state).toBe(true);
      expect(after.run_phase).toBe('completed');
      expect(envelope.defaulted_steps).toEqual(['draft']);
      expect(after.defaulted_steps).toEqual(['draft']);
    });

    it('(c) negative: a guard step that ABORTS the run after a prior default-settle does NOT get the qualifier', async () => {
      const guardAbortDef: WorkflowDefinition = makeDefaultDef(
        {},
        {
          guard_abort: {
            description: 'Guard that aborts the run',
            execution: 'guard',
            depends_on: ['draft'],
            abort_unless: [`draft.category == 'never-matches'`],
          },
        },
      );
      const { run } = await store.create({
        workflowId: guardAbortDef.id,
        workflowVersion: 1,
        params: {},
      });
      await store.update({
        ...run,
        validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
      });

      const envelope = await executeChain(store, guardAbortDef, {
        runId: run.id,
        command: 'draft',
        input: INVALID_OUTPUT,
        dispatcher: echoDispatcher,
      });

      expect(envelope.status).toBe('ok');
      const after = await store.get(run.id);
      expect(after.run_phase).toBe('aborted');
      expect(after.terminal_state).toBe(true);
      // The FM-5 guard: an abort seal is never stamped, even though 'draft' genuinely
      // default-settled earlier in this same run.
      expect(envelope.defaulted_steps).toBeUndefined();
      expect(after.defaulted_steps).toBeUndefined();
    });

    it('(e) NEGATIVE (FM-5 guard): a run that default-settles a mid-workflow step and then FAILS a later step ⇒ the fail-sealed record has NO defaulted_steps', async () => {
      const throwingDispatcher: StepDispatcher = async () => {
        throw new WorkflowError('boom', {
          code: 'ENGINE_HANDLER_FAILED',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: false,
        });
      };
      const def = makeDefaultDef({}, { finish: { description: 'Finish', execution: 'auto' } });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const draftEnvelope = await driveToExhaustion(store, def, run.id);
      expect(draftEnvelope.status).toBe('ok');
      // The mid-workflow default-settle's OWN non-terminal Step-6 envelope carries no
      // defaulted_steps qualifier.
      expect(draftEnvelope.defaulted_steps).toBeUndefined();

      const finishEnvelope = await executeStep(store, def, {
        runId: run.id,
        command: 'finish',
        input: {},
        dispatcher: throwingDispatcher,
      });

      expect(finishEnvelope.status).toBe('error');
      const after = await store.get(run.id);
      expect(after.terminal_state).toBe(true);
      expect(after.run_phase).toBe('failed');
      expect(after.failed_steps).toContain('finish');
      // The 'fail'-sealed record has NO defaulted_steps, even though 'draft' genuinely
      // default-settled earlier in this same run (a named residual, not a false statement — the
      // per-step evidence snapshot still carries settled_by_default: true regardless).
      expect(after.defaulted_steps).toBeUndefined();
      const draftSettleEvidence = after.evidence.find(
        (e) => e.step_id === 'draft' && e.status === 'success',
      );
      expect(draftSettleEvidence?.diagnostics?.settled_by_default).toBe(true);
    });
  });

  describe('(z) V-D7 trust-gate × default', () => {
    it('human_confirmed + exhaustion + mode: default ⇒ the gate OPENS on the default_output preview with the disclosure in gate warnings; the step is NOT in completed_steps; settled_by_default is ABSENT', async () => {
      const def = makeDefaultDef({ trust: 'human_confirmed' });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const gateEnvelope = await driveToExhaustion(store, def, run.id);

      expect(gateEnvelope.status).toBe('confirm_required');
      expect(gateEnvelope.gate?.preview).toEqual(DEFAULT_OUTPUT);
      expect(gateEnvelope.data).toEqual(DEFAULT_OUTPUT);
      expect(gateEnvelope.settled_by_default).toBeUndefined();
      expect(gateEnvelope.warnings.join(' ')).toContain('settled with its declared default_output');

      const after = await store.get(run.id);
      expect(after.completed_steps).not.toContain('draft');
      expect(after.pending_gate).toBeDefined();
    });

    it('a reject choice STILL settles the step with the default output (a rejecting human does not un-default)', async () => {
      const def = makeDefaultDef({ trust: 'human_confirmed' });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const gateEnvelope = await driveToExhaustion(store, def, run.id);
      const result = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: gateEnvelope.gate!.gate_id,
        choice: 'reject',
      });

      expect(result.status).toBe('ok');
      expect(result.data['choice']).toBe('reject');
      expect(result.data['category']).toBe(DEFAULT_OUTPUT.category);
      const after = await store.get(run.id);
      expect(after.completed_steps).toContain('draft');
      expect(after.terminal_state).toBe(true);
    });
  });
});
