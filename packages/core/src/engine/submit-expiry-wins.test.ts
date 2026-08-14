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

// gate-timeout-291 correction, Leg 1: pins execution-loop.ts:4012's OWN gate_id equality inside
// composeExpiredGateEnvelope — a SEPARATE, independent re-check of the freshly-enacted record,
// not the settlement.ts-level terminal-split equality (already pinned elsewhere). Migrated-only
// (JsonFileStore, declares settleStep): this race needs store.settleStep's own internal fresh
// re-read for the "run went terminal via an unrelated cause in the window between our
// gate_expired_pending refusal and our own expire_gate call" scenario to be constructible — the
// LEGACY path calls applySettlement directly against the ALREADY-read `run` snapshot from step 1
// (never re-reading), so the exact same snapshot answers both "is it expired" and "is it
// terminal now" — this specific race is structurally unreachable there.
//
// Companion positive case (same gate_id ⇒ the expired/aborted variant) is ALREADY directly
// pinned above: the "abort cell" test (line 160) submits against `gate.gate_id` itself and
// asserts the "expired and the run aborted ... your choice was NOT recorded" message — the
// SAME code path, discriminator intact, matching id.
describe('submitHumanResponse — composeExpiredGateEnvelope gate_id discrimination (correction, Leg 1)', () => {
  /** Wraps a real JsonFileStore; on the caller's OWN `expire_gate` settleStep call (issued after
   *  a gate_expired_pending refusal), first injects an UNRELATED concurrent write — the run goes
   *  terminal via a DIFFERENT gate's expiry-abort at a DIFFERENT step, leaving only a STALE
   *  gate_expired skip_details entry for that other gate_id — before delegating to the real
   *  settleStep, which re-reads fresh and sees the injected state. Simulates the race without
   *  real concurrency: a single sequential call, one injected write at the one point that matters. */
  class InjectUnrelatedTerminalRace implements RunStore {
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
    async settleStep(
      runId: string,
      delta: Parameters<NonNullable<RunStore['settleStep']>>[1],
      definition: WorkflowDefinition,
      opts?: Parameters<NonNullable<RunStore['settleStep']>>[3],
    ) {
      if (delta.kind === 'expire_gate') {
        const current = await this.inner.get(runId);
        await this.inner.update({
          ...current,
          pending_gate: undefined,
          terminal_state: true,
          terminal_reason:
            "Gate 'other-step' expired and the run aborted per the workflow's declared on_expiry.",
          aborted_at: {
            step_id: 'other-step',
            abort_message:
              "Gate expired (timeout_seconds elapsed with no human response); on_expiry: 'abort'.",
          },
          skip_details: {
            ...current.skip_details,
            'other-step': { kind: 'gate_expired' as const, gate_id: 'unrelated-gate-A' },
          },
        });
      }
      return this.inner.settleStep!(runId, delta, definition, opts);
    }
  }

  it('a late response for a DIFFERENT stale gate on a run whose gate expired-aborted gets the honest zombie/engine-internal answer, NEVER the false "your gate expired" attribution', async () => {
    await withDir(async (dir) => {
      const store = new InjectUnrelatedTerminalRace(new JsonFileStore(dir));
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
        gateId: gate.gate_id, // THIS gate — never 'unrelated-gate-A', the injected stale entry.
        choice: 'approve',
        now: future,
      });

      expect(envelope.status).toBe('error');
      // The ACTUAL, correct answer (discriminator intact): composeExpiredGateEnvelope's search
      // for THIS gate finds neither a settled entry nor a matching skip_details entry (only the
      // unrelated one exists) — this used to fall through to the generic "Unreachable in-contract"
      // ENGINE_INTERNAL fallback (honest, but illegible — it implied an engine fault where the
      // truth is a benign concurrent settlement). issue #319: the fallback is now an HONEST
      // terminal disclosure, mirroring the abort-sibling/zombie STATE_RUN_TERMINAL cells —
      // never a normal refusal, never an engine fault, and never a false attribution.
      expect(envelope.error_code).toBe('STATE_RUN_TERMINAL');
      // issue #332 item 7: positive agent_action pin for the #319 fallback cell — errorEnvelope
      // maps it verbatim (execution-loop.ts:885, no translation on this path), so this is the
      // exact `agentAction: 'report_to_user'` set at the fallback's mint site.
      expect(envelope.agent_action).toBe('report_to_user');
      expect(envelope.errors.join(' ')).toContain(
        'the run reached a terminal outcome concurrently',
      );
      expect(envelope.errors.join(' ')).toContain('your choice was NOT recorded');
      // The house resume/purge pointer (verbatim from the zombie/#282-class cell) — the same
      // guidance an operator gets on the OTHER terminal-submit refusal path, so the honest answer
      // here isn't a dead end.
      expect(envelope.errors.join(' ')).toContain(
        "'realm resume' clears a stale pending gate on a resumable run",
      );
      expect(envelope.errors.join(' ')).toContain("'realm run purge' removes the record entirely");
      // The false attribution the mutant produces instead: reports THIS gate as the one that
      // expired and aborted, quoting the UNRELATED step's name — never true.
      expect(envelope.errors.join(' ')).not.toContain('expired and the run aborted');
      // issue #319 discrimination pin: no BARE "expired" anywhere in the envelope's errors — not
      // merely the false-attribution PHRASE. Word-scoped, not phrase-scoped, deliberately: the
      // OLD ENGINE_INTERNAL message ("Gate 'X' expired, but its enacted disposition could not be
      // determined…") contains bare "expired" WITHOUT the attribution phrase, so a phrase-only
      // pin would not catch a reversion to it — only this bare-word pin does.
      expect(envelope.errors.join(' ')).not.toMatch(/expired/);
      expect(envelope.command).not.toBe('other-step');
    });
  });
});
