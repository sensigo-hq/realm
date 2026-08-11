// submit-expiry-wins.test.ts — issue #291, SUBMIT_EXPIRY_WINS law family: a late
// submitHumanResponse call against an expired-unresolved gate is honestly composed against
// whatever the enforce clock actually enacted — on BOTH the migrated (settleStep-declaring) and
// legacy (CAS-only) store paths.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep, submitHumanResponse } from './execution-loop.js';
import type {
  RunStore,
  CreateRunOptions,
  LoadBearingRunRecordField,
} from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';

/** Non-declaring store double — settleStep genuinely absent (own-property masking), forcing
 *  submitHumanResponse's LEGACY CAS path. Mirrors dormancy-suite-279.test.ts's own precedent. */
class NonDeclaringStoreDouble implements RunStore {
  readonly persistsClaims: boolean;
  readonly persistedRunRecordFields?: ReadonlySet<LoadBearingRunRecordField>;
  constructor(private readonly inner: JsonFileStore) {
    this.persistsClaims = inner.persistsClaims;
    this.persistedRunRecordFields = inner.persistedRunRecordFields;
  }
  create(options: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }> {
    return this.inner.create(options);
  }
  get(runId: string): Promise<RunRecord> {
    return this.inner.get(runId);
  }
  update(record: RunRecord): Promise<RunRecord> {
    return this.inner.update(record);
  }
  list(workflowId?: string): Promise<RunRecord[]> {
    return this.inner.list(workflowId);
  }
  claimStep(runId: string, stepName: string, definition: WorkflowDefinition): Promise<RunRecord> {
    return this.inner.claimStep(runId, stepName, definition);
  }
  // settleStep intentionally OMITTED.
}

const echoDispatcher: StepDispatcher = async (_name, input) => ({ ...input });

function defWithGate(
  gate: NonNullable<WorkflowDefinition['steps'][string]['gate']>,
): WorkflowDefinition {
  return {
    id: 'submit-expiry-wf',
    name: 'Submit Expiry Wins',
    version: 1,
    steps: {
      approve: {
        description: 'Approve',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate,
      },
    },
  };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'realm-submit-expiry-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.each([
  ['migrated (JsonFileStore, declares settleStep)', (dir: string) => new JsonFileStore(dir)],
  [
    'legacy (non-declaring, CAS-only)',
    (dir: string) => new NonDeclaringStoreDouble(new JsonFileStore(dir)),
  ],
] as const)('submitHumanResponse — SUBMIT_EXPIRY_WINS — %s', (_label, makeStore) => {
  it('same-choice cell: the F12-pinned string, status ok, choice NOT double-attributed to the human', async () => {
    await withDir(async (dir) => {
      const store = makeStore(dir);
      const def = defWithGate({
        timeout_seconds: 1,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await executeStep(store, def, {
        runId: run.id,
        command: 'approve',
        input: {},
        dispatcher: echoDispatcher,
      });
      const gate = (await store.get(run.id)).pending_gate!;
      const future = new Date(new Date(gate.expires_at!).getTime() + 1000);

      const envelope = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: gate.gate_id,
        choice: 'approve', // matches the frozen default_choice
        now: future,
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.context_hint).toBe(
        'the outcome matches your choice, but it was settled by timeout; your response was not recorded.',
      );
      expect(envelope.warnings?.some((w) => w.includes('enacted_via: submit'))).toBe(true);

      const finalRun = await store.get(run.id);
      expect(finalRun.settled?.['approve']).toMatchObject({
        outcome: 'gate',
        choice: 'approve',
        resolved_by: 'timeout',
      });
      const snapshot = finalRun.evidence.find((e) => e.kind === 'gate_response');
      expect(snapshot?.responded_by).toBe('timeout');
      expect(snapshot?.resolution).toBe('expired_default');
    });
  });

  it('conflict cell: a DIFFERENT late choice gets an honest refusal naming the timeout-settled winner', async () => {
    await withDir(async (dir) => {
      const store = makeStore(dir);
      const def = defWithGate({
        choices: ['approve', 'reject'],
        timeout_seconds: 1,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await executeStep(store, def, {
        runId: run.id,
        command: 'approve',
        input: {},
        dispatcher: echoDispatcher,
      });
      const gate = (await store.get(run.id)).pending_gate!;
      const future = new Date(new Date(gate.expires_at!).getTime() + 1000);

      const envelope = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: gate.gate_id,
        choice: 'reject', // conflicts with the frozen default_choice
        now: future,
      });

      expect(envelope.status).toBe('error');
      expect(envelope.errors.join(' ')).toContain(
        "was settled by timeout with choice 'approve' — your choice 'reject' was not recorded",
      );
    });
  });

  it('abort cell: the THIRD discriminated run_terminal variant — "expired ... aborted ... NOT recorded"', async () => {
    await withDir(async (dir) => {
      const store = makeStore(dir);
      const def = defWithGate({ timeout_seconds: 1, on_expiry: 'abort' });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await executeStep(store, def, {
        runId: run.id,
        command: 'approve',
        input: {},
        dispatcher: echoDispatcher,
      });
      const gate = (await store.get(run.id)).pending_gate!;
      const future = new Date(new Date(gate.expires_at!).getTime() + 1000);

      const envelope = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: gate.gate_id,
        choice: 'approve',
        now: future,
      });

      expect(envelope.status).toBe('error');
      expect(envelope.error_code).toBe('STATE_RUN_TERMINAL');
      expect(envelope.errors.join(' ')).toContain('expired and the run aborted');
      expect(envelope.errors.join(' ')).toContain('your choice was NOT recorded');

      const finalRun = await store.get(run.id);
      expect(finalRun.terminal_state).toBe(true);
      expect(finalRun.skip_details?.['approve']).toEqual({
        kind: 'gate_expired',
        gate_id: gate.gate_id,
      });
      // Never the false gate_cancelled_by_abort attribution.
      expect(finalRun.skip_details?.['approve']).not.toMatchObject({
        kind: 'gate_cancelled_by_abort',
      });
    });
  });

  it('finding-only mode: a late response ALWAYS resolves normally — never refused, however overdue', async () => {
    await withDir(async (dir) => {
      const store = makeStore(dir);
      const def = defWithGate({ timeout_seconds: 1 }); // no on_expiry — finding-only
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await executeStep(store, def, {
        runId: run.id,
        command: 'approve',
        input: {},
        dispatcher: echoDispatcher,
      });
      const gate = (await store.get(run.id)).pending_gate!;
      const wayLate = new Date(new Date(gate.expires_at!).getTime() + 999_999_000);

      const envelope = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: gate.gate_id,
        choice: 'approve',
        now: wayLate,
      });

      expect(envelope.status).toBe('ok');
      const finalRun = await store.get(run.id);
      // Path-agnostic: the migrated path writes a `.settled` entry, the legacy path never has
      // one at all (pre-#279 shape) — both agree the step genuinely, humanly completed.
      expect(finalRun.completed_steps).toContain('approve');
      expect(finalRun.pending_gate).toBeUndefined();
      if (finalRun.settled?.['approve'] !== undefined) {
        expect(finalRun.settled['approve'].resolved_by).toBeUndefined(); // a REAL human resolved it
      }
    });
  });

  it('a response BEFORE expiry resolves normally, unaffected by a future expires_at', async () => {
    await withDir(async (dir) => {
      const store = makeStore(dir);
      const def = defWithGate({
        timeout_seconds: 600,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await executeStep(store, def, {
        runId: run.id,
        command: 'approve',
        input: {},
        dispatcher: echoDispatcher,
      });
      const gate = (await store.get(run.id)).pending_gate!;

      const envelope = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: gate.gate_id,
        choice: 'approve',
      });
      expect(envelope.status).toBe('ok');
      const finalRun = await store.get(run.id);
      expect(finalRun.settled?.['approve']?.resolved_by).toBeUndefined();
    });
  });
});
