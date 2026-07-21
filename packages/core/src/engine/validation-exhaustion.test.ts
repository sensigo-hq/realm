// Tests for issue #220 PR-1 — bounded validation-rejection exhaustion (countRejection +
// VALIDATION_EXHAUSTED terminalization). Letter labels match the implementation prompt's pin
// set / design record §5 letter map exactly, for mechanical diffing against mutation probes.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep, DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD } from './execution-loop.js';
import type { StepDispatcher } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { InMemoryTraceBufferStore } from '../store/trace-buffer-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';
import type { RunStore, LoadBearingRunRecordField } from '../store/store-interface.js';

const echoDispatcher: StepDispatcher = async (_step, input) => ({ ...input });

/** Single-step agent workflow, output_schema requiring `category`. */
function makeDef(
  stepOverrides: Partial<StepDefinition> = {},
  extraSteps: Record<string, StepDefinition> = {},
): WorkflowDefinition {
  return {
    id: 'vx-wf',
    name: 'VX WF',
    version: 1,
    steps: {
      draft: {
        description: 'Draft',
        execution: 'agent',
        output_schema: {
          type: 'object',
          required: ['category'],
          properties: { category: { type: 'string' } },
        },
        ...stepOverrides,
      },
      ...extraSteps,
    },
  };
}

const INVALID_OUTPUT = {}; // missing 'category' — fails output_schema
const VALID_OUTPUT = { category: 'ok' };

describe('issue #220 PR-1 — bounded validation-rejection exhaustion', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-vx-test-'));
    store = new JsonFileStore(dir);
  });

  it('(a) bump-and-report: a counted, non-terminal rejection reports the PRE-write version, and the count IS persisted', async () => {
    const def = makeDef();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const versionBefore = run.version;

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: INVALID_OUTPUT,
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error_code).toBe('VALIDATION_OUTPUT_SCHEMA');
    expect(envelope.run_version).toBe(versionBefore); // bump-and-report

    const after = await store.get(run.id);
    expect(after.version).toBe(versionBefore + 1); // the CAS write DID actually happen
    expect(after.validation_rejections?.['draft']).toBe(1);
    expect(after.terminal_state).toBe(false);
  });

  it('(b) valid-always-wins: persisted count already AT threshold, then a VALID submission ⇒ success settle, never exhaustion', async () => {
    const def = makeDef();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD },
    });

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: VALID_OUTPUT,
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('ok');
    const after = await store.get(run.id);
    expect(after.completed_steps).toContain('draft');
    expect(after.terminal_state).toBe(true); // single-step workflow
    expect(after.failed_steps).not.toContain('draft');
  });

  it("(c) exactly-one-terminalizer: the winner terminalizes with VALIDATION_EXHAUSTED; a concurrent loser's retry lands after the winner's count-write and before its claim ⇒ the loser gets the ALREADY_CLAIMED-class blocked envelope, never a second terminal settle", async () => {
    // --- winner: a real, straightforward invocation reaching threshold ---
    const def = makeDef();
    const { run: winnerRun } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...winnerRun,
      validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
    });
    const winnerEnvelope = await executeStep(store, def, {
      runId: winnerRun.id,
      command: 'draft',
      input: INVALID_OUTPUT,
      dispatcher: echoDispatcher,
    });
    expect(winnerEnvelope.status).toBe('error');
    expect(winnerEnvelope.error_code).toBe('VALIDATION_EXHAUSTED');
    const winnerAfter = await store.get(winnerRun.id);
    expect(winnerAfter.terminal_state).toBe(true);
    expect(winnerAfter.failed_steps).toContain('draft');

    // --- loser: a scripted store reproducing the EXACT race (reclaim-step.test.ts precedent) ---
    // getIdx 0 → Step 1's read (STALE: count = threshold-1, unclaimed).
    // update 0 → the FIRST CAS (keyed on the stale snapshot) → MISMATCH (winner already wrote).
    // getIdx 1 → the retry's read: lands AFTER the winner's count-write, BEFORE the winner's claim
    //            (count = threshold, still unclaimed, not terminal, no pending_gate).
    // update 1 → the retry's OWN CAS → succeeds (this is the loser's own re-increment).
    // getIdx 2 → the claim-catch's own fresh re-read (after claimStep throws) — reuses the last
    //            scripted record (array exhausted, held at its last entry).
    // claimStep → throws STATE_STEP_ALREADY_CLAIMED (the winner claimed first).
    const base: RunRecord = {
      id: 'loser-run',
      workflow_id: def.id,
      workflow_version: 1,
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      run_phase: 'running',
      version: 10,
      params: {},
      evidence: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      terminal_state: false,
    };
    const staleSnapshot: RunRecord = {
      ...base,
      validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
    };
    const midSnapshot: RunRecord = {
      ...base,
      version: 11,
      validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD },
    };
    let getIdx = 0;
    let updateIdx = 0;
    const records = [staleSnapshot, midSnapshot];
    const loserStore = {
      get: async () => records[Math.min(getIdx++, records.length - 1)]!,
      update: async (rec: RunRecord) => {
        const idx = updateIdx++;
        if (idx === 0) {
          throw new WorkflowError('Version conflict', {
            code: 'STATE_SNAPSHOT_MISMATCH',
            category: 'STATE',
            agentAction: 'report_to_user',
            retryable: true,
          });
        }
        return { ...rec, version: rec.version + 1 };
      },
      claimStep: async (runId: string, stepName: string) => {
        throw new WorkflowError(`Step '${stepName}' is already claimed`, {
          code: 'STATE_STEP_ALREADY_CLAIMED',
          category: 'STATE',
          agentAction: 'resolve_precondition',
          retryable: false,
          details: { runId, stepName },
        });
      },
    } as unknown as RunStore;

    const loserEnvelope = await executeStep(loserStore, def, {
      runId: 'loser-run',
      command: 'draft',
      input: INVALID_OUTPUT,
      dispatcher: echoDispatcher,
    });

    expect(loserEnvelope.status).toBe('blocked');
    expect(loserEnvelope.context_hint).toContain('already claimed');
    expect(updateIdx).toBe(2); // first CAS (mismatch) + retry CAS (succeeded) — never a third write
  });

  it("(d) enforce-gate yield: an exhausting call under trace_validation_mode enforce with an invalid trace terminalizes (no pre-claim VALIDATION_TRACE_SCHEMA return); a non-exhausting invalid-trace call still returns today's VALIDATION_TRACE_SCHEMA rejection", async () => {
    const def = makeDef({
      trace_schema: {
        type: 'array',
        items: { type: 'object', properties: { event: { enum: ['required_event_name'] } } },
      },
      trace_validation_mode: 'enforce',
    });
    const invalidTrace = [{ event: 'thinking' }]; // violates the `event` enum above

    // Non-exhausting: valid output, but the enforce-mode trace schema check fails.
    const { run: freshRun } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    const nonExhausting = await executeStep(store, def, {
      runId: freshRun.id,
      command: 'draft',
      input: VALID_OUTPUT,
      trace: invalidTrace,
      dispatcher: echoDispatcher,
    });
    expect(nonExhausting.status).toBe('error');
    expect(nonExhausting.error_code).toBe('VALIDATION_TRACE_SCHEMA');
    const afterNonExhausting = await store.get(freshRun.id);
    expect(afterNonExhausting.in_progress_steps).not.toContain('draft'); // never claimed

    // Exhausting: count at threshold-1, invalid OUTPUT (arms exhaustion via 2c) AND an invalid
    // trace (would fail the enforce gate on its own) — the enforce-gate must YIELD, not return.
    const { run: hotRun } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...hotRun,
      validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
    });
    const exhausting = await executeStep(store, def, {
      runId: hotRun.id,
      command: 'draft',
      input: INVALID_OUTPUT,
      trace: invalidTrace,
      dispatcher: echoDispatcher,
    });
    expect(exhausting.status).toBe('error');
    expect(exhausting.error_code).toBe('VALIDATION_EXHAUSTED');
    const afterExhausting = await store.get(hotRun.id);
    expect(afterExhausting.terminal_state).toBe(true);
    expect(afterExhausting.failed_steps).toContain('draft');
  });

  it('(e) synthesized-snapshot trace carriage: an exhausting call with a submitted trace carries the normalized trace on the failure evidence', async () => {
    const def = makeDef();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
    });

    const toolCalls = [
      {
        server_id: 'github',
        tool: 'get_pull_request',
        args: { pr: 1 },
        result: 'PR data',
        duration_ms: 50,
      },
    ];
    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: INVALID_OUTPUT,
      trace: [{ event: 'thinking', data: { note: 'considering' } }],
      dispatcher: echoDispatcher,
      stepMeta: { toolCalls },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error_code).toBe('VALIDATION_EXHAUSTED');
    const after = await store.get(run.id);
    const exhaustedEvidence = after.evidence.find(
      (e) => e.step_id === 'draft' && e.status === 'error',
    );
    expect(exhaustedEvidence).toBeDefined();
    expect(exhaustedEvidence?.trace).toBeDefined();
    expect(exhaustedEvidence?.trace?.length).toBe(1);
    expect(exhaustedEvidence?.trace?.[0]?.event).toBe('thinking');
    expect(exhaustedEvidence?.diagnostics?.validation_rejections).toBe(
      DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
    );
    // issue #220 correction, deliverable 1/verification (d) — snapshot completeness: an
    // exhausted step must not silently drop agent-supplied toolCalls.
    expect(exhaustedEvidence?.tool_calls).toHaveLength(1);
    expect(exhaustedEvidence?.tool_calls?.[0]?.tool).toBe('get_pull_request');
  });

  it('(e) correction — WAL-variant: an exhausting call with a BARE WAL line (no options.trace at all) still carries the WAL-originated line on the failure evidence — the discriminating witness a submitted-trace-only fixture cannot provide', async () => {
    const def = makeDef();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
    });
    // The test-(o) store wiring (declares writer_nonce_carriage), but appended BARE (no nonce
    // option) and called with NO writerNonce — a nonced/mismatched config would instead route
    // the line to preserved-foreign/attributed, not bare-adoption, which is what this test needs
    // to discriminate (see deliverable 2's own note on this).
    const traceBufferStore = new InMemoryTraceBufferStore();
    await traceBufferStore.append(run.id, 'draft', [{ event: 'wal-thinking' }]);

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: INVALID_OUTPUT,
      // Deliberately NO `trace:` — the WAL line is the ONLY source of trace content here.
      dispatcher: echoDispatcher,
      traceBufferStore,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error_code).toBe('VALIDATION_EXHAUSTED');
    const after = await store.get(run.id);
    const exhaustedEvidence = after.evidence.find(
      (e) => e.step_id === 'draft' && e.status === 'error',
    );
    expect(exhaustedEvidence).toBeDefined();
    expect(exhaustedEvidence?.trace).toBeDefined();
    expect(exhaustedEvidence?.trace?.length).toBe(1);
    expect(exhaustedEvidence?.trace?.[0]?.event).toBe('wal-thinking');
    // Set only on the bare-adoption path (#185/#197) — a second, independent witness of the
    // same fact.
    expect(exhaustedEvidence?.trace_summary?.buffered_lines_adopted).toBeGreaterThanOrEqual(1);
  });

  it('(f) wrap-block guard: a hand-built max_attempts:0 definition (bypassing the loader) still terminalizes as VALIDATION_EXHAUSTED, never wrapped into STEP_RETRY_EXHAUSTED', async () => {
    const def = makeDef({
      retry: { max_attempts: 0, backoff: 'fixed', base_delay_ms: 0 },
    });
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
    });

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: INVALID_OUTPUT,
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error_code).toBe('VALIDATION_EXHAUSTED');
    expect(envelope.error_code).not.toBe('STEP_RETRY_EXHAUSTED');
    // issue #220 correction, deliverable 3 — agent_action honesty pin: this run is
    // single-step-terminal, so Step 5's `resolvePostDispatchAgentAction(dispatchError, true)`
    // returns 'stop' UNCONDITIONALLY (error-resolution.ts:31 — the terminal branch never even
    // reads `dispatchError.agentAction`). This pin guards that TERMINAL-TRANSLATION behavior (an
    // exhausted run correctly tells the agent to stop) — NOT the mint's own `agentAction: 'stop'`
    // field, which is observationally inert on this specific path (see the mint-site comment in
    // execution-loop.ts). A mint-site mutant will NOT redden this assertion; only a mutation to
    // the terminal-branch translation itself will.
    expect(envelope.agent_action).toBe('stop');
  });

  it('(j) success-settle stamp: reject twice then succeed ⇒ the settle evidence carries diagnostics.validation_rejections === 2', async () => {
    const def = makeDef();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: INVALID_OUTPUT,
      dispatcher: echoDispatcher,
    });
    await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: INVALID_OUTPUT,
      dispatcher: echoDispatcher,
    });
    const success = await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: VALID_OUTPUT,
      dispatcher: echoDispatcher,
    });

    expect(success.status).toBe('ok');
    const after = await store.get(run.id);
    const settleEvidence = after.evidence.find(
      (e) => e.step_id === 'draft' && e.status === 'success',
    );
    expect(settleEvidence?.diagnostics?.validation_rejections).toBe(2);
    expect(after.validation_rejections?.['draft']).toBe(2); // count itself is NEVER reset
  });

  it("(k) store honesty advisory: a store not declaring 'validation_rejections' draws the softened durability warning on a counted rejection", async () => {
    class UndeclaredFieldStore extends JsonFileStore {
      override readonly persistedRunRecordFields: ReadonlySet<LoadBearingRunRecordField> = new Set([
        'capability_blocks',
        'workflow_context_snapshots',
        'extension_identity',
      ]); // deliberately mirrors the pre-#220 3-member set — validation_rejections NOT declared
    }
    const undeclaredStore = new UndeclaredFieldStore(dir);
    const def = makeDef();
    const { run } = await undeclaredStore.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(undeclaredStore, def, {
      runId: run.id,
      command: 'draft',
      input: INVALID_OUTPUT,
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.warnings?.join(' ')).toContain(
      'rejection counting not declared durable on this store',
    );
  });

  it('(l) countdown with a PER-STEP THRESHOLD OVERRIDE: rejections 1, 2 with threshold: 2 ⇒ the SECOND rejection terminalizes at the OVERRIDE value, not the hardcoded default', async () => {
    const def = makeDef({ validation_exhaustion: { threshold: 2 } });
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    const first = await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: INVALID_OUTPUT,
      dispatcher: echoDispatcher,
    });
    expect(first.status).toBe('error');
    expect(first.error_code).toBe('VALIDATION_OUTPUT_SCHEMA');
    expect(first.error_details?.['rejections']).toBe(1);
    expect(first.error_details?.['threshold']).toBe(2);

    const second = await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: INVALID_OUTPUT,
      dispatcher: echoDispatcher,
    });
    expect(second.status).toBe('error');
    expect(second.error_code).toBe('VALIDATION_EXHAUSTED');
    expect(second.error_details?.['rejections']).toBe(2);
    expect(second.error_details?.['threshold']).toBe(2);
  });

  it('(m) CAS-swallow: a forced double-CAS-failure produces the not-persisted warning, still delivers the envelope, and the FOLLOWING rejection re-converges the persisted count', async () => {
    // A wrapper whose get() bumps the real store on EVERY call as a side effect (but returns the
    // pre-bump snapshot) — this forces BOTH the first CAS (keyed on Step 1's snapshot) AND the
    // retry's own CAS (keyed on the retry's own snapshot) to lose to a "concurrent" writer.
    class DoubleFailureStore extends JsonFileStore {
      override async get(runId: string): Promise<RunRecord> {
        const rec = await super.get(runId);
        await super.update({ ...rec });
        return rec;
      }
    }
    const doubleFailureStore = new DoubleFailureStore(dir);
    const def = makeDef();
    const { run } = await doubleFailureStore.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(doubleFailureStore, def, {
      runId: run.id,
      command: 'draft',
      input: INVALID_OUTPUT,
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error_code).toBe('VALIDATION_OUTPUT_SCHEMA'); // never exhausted — nothing persisted
    expect(envelope.warnings?.join(' ')).toContain('rejection count not persisted');

    // The double-failure attempt left the real stored count untouched (both its writes lost).
    const afterDoubleFailure = await store.get(run.id);
    expect(afterDoubleFailure.validation_rejections?.['draft'] ?? 0).toBe(0);

    // The FOLLOWING rejection, against a plain (non-double-failing) store, re-converges: it
    // starts counting from the REAL stored value (0), not from the swallowed attempt's "1".
    const following = await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: INVALID_OUTPUT,
      dispatcher: echoDispatcher,
    });
    expect(following.error_details?.['rejections']).toBe(1);
    const afterFollowing = await store.get(run.id);
    expect(afterFollowing.validation_rejections?.['draft']).toBe(1);
  });

  it("(n) never-reset across steps: A rejects 3× → B settles → A rejects 3× more ⇒ VALIDATION_EXHAUSTED on A's 6th rejection (settled steps simply leave the eligible set — they never reset another step's counter)", async () => {
    const def: WorkflowDefinition = {
      id: 'vx-two-step-wf',
      name: 'VX Two Step',
      version: 1,
      steps: {
        A: {
          description: 'A',
          execution: 'agent',
          output_schema: {
            type: 'object',
            required: ['category'],
            properties: { category: { type: 'string' } },
          },
        },
        B: { description: 'B', execution: 'auto' },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    for (let i = 0; i < 3; i++) {
      const r = await executeStep(store, def, {
        runId: run.id,
        command: 'A',
        input: INVALID_OUTPUT,
        dispatcher: echoDispatcher,
      });
      expect(r.status).toBe('error');
      expect(r.error_code).toBe('VALIDATION_OUTPUT_SCHEMA');
    }

    const bResult = await executeStep(store, def, {
      runId: run.id,
      command: 'B',
      input: {},
      dispatcher: echoDispatcher,
    });
    expect(bResult.status).toBe('ok');
    const afterB = await store.get(run.id);
    expect(afterB.completed_steps).toContain('B');
    expect(afterB.validation_rejections?.['A']).toBe(3); // B settling never touched A's counter

    let last;
    for (let i = 0; i < 3; i++) {
      last = await executeStep(store, def, {
        runId: run.id,
        command: 'A',
        input: INVALID_OUTPUT,
        dispatcher: echoDispatcher,
      });
    }
    expect(last?.status).toBe('error');
    expect(last?.error_code).toBe('VALIDATION_EXHAUSTED');
    const final = await store.get(run.id);
    expect(final.validation_rejections?.['A']).toBe(6);
    expect(final.terminal_state).toBe(true);
  });

  it('(o) pooled-across-writers: two distinct writer nonces alternate rejections ⇒ terminalizes at the pooled threshold (never per-nonce-partitioned)', async () => {
    const def = makeDef();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    // Declares writer_nonce_carriage so effectiveClaimantNonce genuinely differs between the two
    // nonces at the adoption layer — countRejection itself never reads nonce at all, but wiring
    // real nonce differentiation is what makes a per-nonce-keying mutant visible (undefined≡
    // undefined would otherwise mask it).
    const traceBufferStore = new InMemoryTraceBufferStore();

    let last;
    for (let i = 0; i < DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD; i++) {
      last = await executeStep(store, def, {
        runId: run.id,
        command: 'draft',
        input: INVALID_OUTPUT,
        dispatcher: echoDispatcher,
        traceBufferStore,
        writerNonce: i % 2 === 0 ? 'nonce-A' : 'nonce-B',
      });
    }

    expect(last?.status).toBe('error');
    expect(last?.error_code).toBe('VALIDATION_EXHAUSTED');
    const after = await store.get(run.id);
    expect(after.validation_rejections?.['draft']).toBe(DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD);
  });

  it('(p) both-schemas single increment: input+output schemas both declared, an input-invalid threshold call increments EXACTLY once and details.last_error carries the 2b (input-schema) code', async () => {
    const def = makeDef({
      input_schema: {
        type: 'object',
        required: ['x'],
        properties: { x: { type: 'string' } },
      },
      // output_schema (required: category) inherited from makeDef's base
    });
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      validation_rejections: { draft: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
    });

    // Missing BOTH 'x' (input_schema) and 'category' (output_schema) — 2b fails first.
    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: {},
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error_code).toBe('VALIDATION_EXHAUSTED');
    const lastAjvErrors = envelope.error_details?.['last_ajv_errors'] as
      | Array<{ instancePath?: string }>
      | undefined;
    // The 2b (input-schema) ajv error set is about the MISSING 'x' — never mentions 'category'.
    expect(JSON.stringify(lastAjvErrors)).not.toContain('category');
    const after = await store.get(run.id);
    expect(after.validation_rejections?.['draft']).toBe(DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD); // exactly ONE increment, not two
  });

  describe('(q) retry-countability, TWO-WITNESS', () => {
    it('(q1) abandon-mid-count ⇒ NO post-terminal write (the CAS-failure retry drops and swallows once the fresh record is terminal)', async () => {
      const def = makeDef();
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      class AbandonMidCountStore extends JsonFileStore {
        private triggered = false;
        override async get(runId: string): Promise<RunRecord> {
          const rec = await super.get(runId);
          if (!this.triggered) {
            this.triggered = true;
            // Simulate a concurrent abandon landing between Step 1's read and countRejection's
            // first CAS — the CAS below will be keyed on this STALE (pre-abandon) snapshot.
            await super.update({
              ...rec,
              terminal_state: true,
              terminal_reason: 'abandoned mid-count (test)',
            });
          }
          return rec;
        }
      }
      const abandonStore = new AbandonMidCountStore(dir);

      const envelope = await executeStep(abandonStore, def, {
        runId: run.id,
        command: 'draft',
        input: INVALID_OUTPUT,
        dispatcher: echoDispatcher,
      });

      expect(envelope.status).toBe('error');
      expect(envelope.error_code).toBe('VALIDATION_OUTPUT_SCHEMA'); // never exhausted — dropped
      const after = await store.get(run.id);
      expect(after.terminal_state).toBe(true); // the abandon itself persisted
      expect(after.validation_rejections?.['draft'] ?? 0).toBe(0); // NO post-terminal count write
    });

    it('(q2) a concurrent VALID claim landing between the first-CAS-failure and the retry ⇒ the retry performs NO write, and the valid settle SUCCEEDS untouched', async () => {
      // TWO-STEP workflow (deliberate — discriminates the ELIGIBILITY conjunct from the
      // terminal_state conjunct): 'other' has no dependency on 'draft' and stays pending after
      // 'draft' settles, so the RUN itself never goes terminal — only 'draft' itself becomes
      // ineligible (already settled). A single-step fixture would make BOTH conjuncts trip
      // together (the lone step settling always terminates a single-step run), masking whichever
      // one a mutant dropped.
      const def = makeDef({}, { other: { description: 'Other', execution: 'auto' } });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      let validSettleEnvelope: Awaited<ReturnType<typeof executeStep>> | undefined;
      class ConcurrentValidSettleStore extends JsonFileStore {
        private triggered = false;
        constructor(
          runsDir: string,
          private def: WorkflowDefinition,
        ) {
          super(runsDir);
        }
        override async get(runId: string): Promise<RunRecord> {
          const rec = await super.get(runId);
          if (!this.triggered) {
            this.triggered = true;
            // A genuinely CONCURRENT valid submission settles the step for real, between THIS
            // read (Step 1's snapshot) and countRejection's first CAS — which will therefore be
            // keyed on a now-stale version and fail.
            validSettleEnvelope = await executeStep(this, this.def, {
              runId,
              command: 'draft',
              input: VALID_OUTPUT,
              dispatcher: echoDispatcher,
            });
          }
          return rec;
        }
      }
      const concurrentStore = new ConcurrentValidSettleStore(dir, def);

      const rejectingEnvelope = await executeStep(concurrentStore, def, {
        runId: run.id,
        command: 'draft',
        input: INVALID_OUTPUT,
        dispatcher: echoDispatcher,
      });

      expect(validSettleEnvelope?.status).toBe('ok');
      expect(rejectingEnvelope.status).toBe('error');
      expect(rejectingEnvelope.error_code).toBe('VALIDATION_OUTPUT_SCHEMA'); // never exhausted
      const after = await store.get(run.id);
      expect(after.completed_steps).toContain('draft'); // the valid settle's own success
      expect(after.validation_rejections?.['draft'] ?? 0).toBe(0); // retry performed NO write
    });
  });

  it('(u) trace-exclusion negative: threshold+1 enforce-mode TRACE rejections never count, and the step stays claimable', async () => {
    const def = makeDef({
      trace_schema: {
        type: 'array',
        items: { type: 'object', properties: { event: { enum: ['required_event_name'] } } },
      },
      trace_validation_mode: 'enforce',
    });
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const invalidTrace = [{ event: 'thinking' }];

    for (let i = 0; i < DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD + 1; i++) {
      const r = await executeStep(store, def, {
        runId: run.id,
        command: 'draft',
        input: VALID_OUTPUT,
        trace: invalidTrace,
        dispatcher: echoDispatcher,
      });
      expect(r.status).toBe('error');
      expect(r.error_code).toBe('VALIDATION_TRACE_SCHEMA');
    }

    const after = await store.get(run.id);
    expect(after.validation_rejections?.['draft']).toBeUndefined(); // never counted
    expect(after.in_progress_steps).not.toContain('draft'); // still claimable

    // Prove it's still genuinely claimable: a valid submission (with a schema-conformant trace)
    // succeeds outright — never exhausted, confirming the prior threshold+1 rejections left
    // zero durable trace.
    const success = await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: VALID_OUTPUT,
      trace: [{ event: 'required_event_name' }],
      dispatcher: echoDispatcher,
    });
    expect(success.status).toBe('ok');
  });

  it('(v) auto-step-exclusion negative: an auto step with repeated INPUT_SCHEMA rejections is never counted', async () => {
    const def: WorkflowDefinition = {
      id: 'vx-auto-wf',
      name: 'VX Auto',
      version: 1,
      steps: {
        work: {
          description: 'Work',
          execution: 'auto',
          handler: 'noop',
          input_schema: {
            type: 'object',
            required: ['x'],
            properties: { x: { type: 'string' } },
          },
        },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    for (let i = 0; i < DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD + 1; i++) {
      const r = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: echoDispatcher,
      });
      expect(r.status).toBe('error');
      expect(r.error_code).toBe('VALIDATION_INPUT_SCHEMA');
    }

    const after = await store.get(run.id);
    expect(after.validation_rejections?.['work']).toBeUndefined();
    expect(after.in_progress_steps).not.toContain('work');
  });

  it('(w) INPUT_SCHEMA-only exhaustion positive: an agent step with ONLY input_schema (no output_schema) still terminalizes on repeated input rejections', async () => {
    const def: WorkflowDefinition = {
      id: 'vx-input-only-wf',
      name: 'VX Input Only',
      version: 1,
      steps: {
        draft: {
          description: 'Draft',
          execution: 'agent',
          input_schema: {
            type: 'object',
            required: ['x'],
            properties: { x: { type: 'string' } },
          },
        },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let last;
    for (let i = 0; i < DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD; i++) {
      last = await executeStep(store, def, {
        runId: run.id,
        command: 'draft',
        input: {},
        dispatcher: echoDispatcher,
      });
    }

    expect(last?.status).toBe('error');
    expect(last?.error_code).toBe('VALIDATION_EXHAUSTED');
    const after = await store.get(run.id);
    expect(after.validation_rejections?.['draft']).toBe(DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD);
    expect(after.terminal_state).toBe(true);
  });
});
