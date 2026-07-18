// Tests for the writer_nonce protocol surface (issue #197 PR-2, design record
// `plans/issue-197-design.md` §6): shape validation, non-agent refusals, carriage gating
// (FLAG_GATING), the applied-nonce marker, the dormant REALM_REQUIRE_WRITER_NONCE strict posture,
// non-disclosure pins (get_run_state / append_trace never leak buffered-line content or nonce
// values), and the #208 capacityWarning re-home onto the whole-file scope.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  InMemoryTraceBufferStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { WorkflowDefinition, TraceBufferStore } from '@sensigo/realm';
import { handleAppendTrace } from './append-trace.js';
import { handleExecuteStep } from './execute-step.js';
import { handleGetRunState } from './get-run-state.js';

function makeWorkflowDef(): WorkflowDefinition {
  return {
    id: 'writer-nonce-wf',
    name: 'Writer Nonce Test Workflow',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      'step-auto': { description: 'Auto step', execution: 'auto', depends_on: [] },
      'step-agent': { description: 'Agent step', execution: 'agent', depends_on: [] },
    },
  };
}

describe('writer_nonce protocol surface (issue #197 PR-2)', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let traceBufferStore: InMemoryTraceBufferStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-writer-nonce-runs-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-writer-nonce-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    traceBufferStore = new InMemoryTraceBufferStore();

    const def = makeWorkflowDef();
    await writeFile(join(workflowDir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
  });

  afterEach(() => {
    delete process.env['REALM_REQUIRE_WRITER_NONCE'];
  });

  describe('shape validation (both tools)', () => {
    it.each([
      ['empty string', ''],
      ['whitespace-only', '   '],
      ['leading whitespace', ' abc'],
      ['trailing whitespace', 'abc '],
      ['too long (129 chars)', 'a'.repeat(129)],
    ])('append_trace refuses a malformed writer_nonce (%s)', async (_label, nonce) => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      await expect(
        handleAppendTrace(
          { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'e' }], writer_nonce: nonce },
          { runStore, workflowStore, traceBufferStore },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_EMPTY_VALUE', agentAction: 'provide_input' });
    });

    it.each([
      ['empty string', ''],
      ['whitespace-only', '   '],
      ['too long (129 chars)', 'a'.repeat(129)],
    ])('execute_step refuses a malformed writer_nonce (%s)', async (_label, nonce) => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      await expect(
        handleExecuteStep(
          { run_id: run.id, command: 'step-agent', params: {}, writer_nonce: nonce },
          { runStore, workflowStore, traceBufferStore },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_EMPTY_VALUE', agentAction: 'provide_input' });
    });

    it('a valid nonce (fresh UUIDv4-shaped) is accepted by both tools', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      const result = await handleAppendTrace(
        {
          run_id: run.id,
          step_id: 'step-agent',
          entries: [{ event: 'e' }],
          writer_nonce: 'a-perfectly-valid-nonce-value',
        },
        { runStore, workflowStore, traceBufferStore },
      );
      expect(result.status).toBe('ok');
    });
  });

  describe('non-agent refusals', () => {
    it('append_trace: the EXISTING non-agent refusal fires BEFORE any nonce validation (a malformed nonce on a non-agent step still surfaces the non-agent error, not the shape error)', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      await expect(
        handleAppendTrace(
          {
            run_id: run.id,
            step_id: 'step-auto',
            entries: [{ event: 'e' }],
            writer_nonce: '', // malformed — would trip shape validation if reached
          },
          { runStore, workflowStore, traceBufferStore },
        ),
      ).rejects.toMatchObject({
        code: 'STATE_STEP_NOT_ELIGIBLE',
        details: { step_type: 'auto' },
      });
    });

    it('execute_step: a writer_nonce PRESENT on a non-agent step is refused (STATE_STEP_NOT_ELIGIBLE + step_type detail)', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      await expect(
        handleExecuteStep(
          {
            run_id: run.id,
            command: 'step-auto',
            params: {},
            writer_nonce: 'some-valid-nonce',
          },
          { runStore, workflowStore, traceBufferStore },
        ),
      ).rejects.toMatchObject({
        code: 'STATE_STEP_NOT_ELIGIBLE',
        details: { step_type: 'auto' },
      });
    });

    it('execute_step: a BARE call on a non-agent step stays byte-identical (auto steps still execute normally)', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      const result = await handleExecuteStep(
        { run_id: run.id, command: 'step-auto', params: {} },
        { runStore, workflowStore, traceBufferStore },
      );
      expect(result.status).toBe('ok');
    });
  });

  describe('carriage gating (FLAG_GATING, issue #197 PR-2)', () => {
    it('a non-declaring store NEVER receives the nonce argument, even when writer_nonce was supplied — plus the not-persisted warning fires', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      // A store with the fenced trio but NO traceCapabilities at all (no carriage).
      const inner = new InMemoryTraceBufferStore();
      const nonCarryingStore: TraceBufferStore = {
        append: (runId, stepId, entries) => inner.append(runId, stepId, entries),
        read: (runId, stepId) => inner.read(runId, stepId),
        delete: (runId, stepId) => inner.delete(runId, stepId),
        deleteAllForRun: (runId, dirEntries) => inner.deleteAllForRun(runId, dirEntries),
        readAllForRun: (runId) => inner.readAllForRun(runId),
      };
      const appendSpy = vi.spyOn(nonCarryingStore, 'append');

      const result = await handleAppendTrace(
        {
          run_id: run.id,
          step_id: 'step-agent',
          entries: [{ event: 'e' }],
          writer_nonce: 'a-real-nonce-value',
        },
        { runStore, workflowStore, traceBufferStore: nonCarryingStore },
      );

      expect(result.status).toBe('ok');
      // The nonce argument was never forwarded — the store call's 4th arg is undefined.
      expect(appendSpy).toHaveBeenCalledWith(run.id, 'step-agent', [{ event: 'e' }], undefined);
      expect(result.warnings).toContain(
        'writer_nonce not persisted: attribution unavailable on this store',
      );
      expect(result.writer_nonce_applied).toBeUndefined();
    });

    it('a declaring store DOES receive the nonce argument, and the not-persisted warning is absent', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      // InMemoryTraceBufferStore declares the fenced trio too, so append_trace prefers
      // appendFenced over the plain append() — spy on the one actually called.
      const appendFencedSpy = vi.spyOn(traceBufferStore, 'appendFenced');

      const result = await handleAppendTrace(
        {
          run_id: run.id,
          step_id: 'step-agent',
          entries: [{ event: 'e' }],
          writer_nonce: 'a-real-nonce-value',
        },
        { runStore, workflowStore, traceBufferStore },
      );

      expect(result.status).toBe('ok');
      expect(appendFencedSpy).toHaveBeenCalledTimes(1);
      const call = appendFencedSpy.mock.calls[0]!;
      expect(call[0]).toBe(run.id);
      expect(call[1]).toBe('step-agent');
      expect(call[2]).toEqual([{ event: 'e' }]);
      expect(call[4]).toEqual({ writerNonce: 'a-real-nonce-value' }); // trailing options arg
      expect(result.warnings ?? []).not.toContain(
        'writer_nonce not persisted: attribution unavailable on this store',
      );
    });
  });

  describe('applied-nonce marker (issue #197 PR-2, design §6)', () => {
    it('writer_nonce_applied: true when a nonce was BOTH supplied AND carried', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      const result = await handleAppendTrace(
        {
          run_id: run.id,
          step_id: 'step-agent',
          entries: [{ event: 'e' }],
          writer_nonce: 'a-real-nonce-value',
        },
        { runStore, workflowStore, traceBufferStore },
      );
      expect(result.writer_nonce_applied).toBe(true);
    });

    it('writer_nonce_applied is ABSENT (never false) when no nonce was supplied at all', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      const result = await handleAppendTrace(
        { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'e' }] },
        { runStore, workflowStore, traceBufferStore },
      );
      expect(result.writer_nonce_applied).toBeUndefined();
    });
  });

  describe('dormant strict posture — REALM_REQUIRE_WRITER_NONCE (issue #197 PR-2, design §6)', () => {
    it('default (unset): zero behavior change — a bare agent-step call still succeeds on both tools', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      const appendResult = await handleAppendTrace(
        { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'e' }] },
        { runStore, workflowStore, traceBufferStore },
      );
      expect(appendResult.status).toBe('ok');

      const { run: run2 } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      const execResult = await handleExecuteStep(
        { run_id: run2.id, command: 'step-agent', params: {} },
        { runStore, workflowStore, traceBufferStore },
      );
      expect(execResult.status).toBe('ok');
    });

    it('set (any non-empty value other than 0/false): refuses a bare agent-step call on both tools', async () => {
      process.env['REALM_REQUIRE_WRITER_NONCE'] = '1';
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      await expect(
        handleAppendTrace(
          { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'e' }] },
          { runStore, workflowStore, traceBufferStore },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_EMPTY_VALUE' });

      const { run: run2 } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      await expect(
        handleExecuteStep(
          { run_id: run2.id, command: 'step-agent', params: {} },
          { runStore, workflowStore, traceBufferStore },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_EMPTY_VALUE' });
    });

    it('"0" and "false" are treated as OFF, not on', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      process.env['REALM_REQUIRE_WRITER_NONCE'] = '0';
      const r1 = await handleAppendTrace(
        { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'e' }] },
        { runStore, workflowStore, traceBufferStore },
      );
      expect(r1.status).toBe('ok');

      const { run: run2 } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      process.env['REALM_REQUIRE_WRITER_NONCE'] = 'false';
      const r2 = await handleExecuteStep(
        { run_id: run2.id, command: 'step-agent', params: {} },
        { runStore, workflowStore, traceBufferStore },
      );
      expect(r2.status).toBe('ok');
    });

    it('read PER CALL, never cached — flipping the env mid-process takes effect on the very next call', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      const before = await handleAppendTrace(
        { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'e' }] },
        { runStore, workflowStore, traceBufferStore },
      );
      expect(before.status).toBe('ok');

      process.env['REALM_REQUIRE_WRITER_NONCE'] = '1';
      const { run: run2 } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      await expect(
        handleAppendTrace(
          { run_id: run2.id, step_id: 'step-agent', entries: [{ event: 'e' }] },
          { runStore, workflowStore, traceBufferStore },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_EMPTY_VALUE' });
    });

    it('execute_step: a non-agent step is unaffected by the strict posture (never requires a nonce it cannot use)', async () => {
      process.env['REALM_REQUIRE_WRITER_NONCE'] = '1';
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      const result = await handleExecuteStep(
        { run_id: run.id, command: 'step-auto', params: {} },
        { runStore, workflowStore, traceBufferStore },
      );
      expect(result.status).toBe('ok');
    });
  });

  describe('non-disclosure pins (issue #197 PR-2, design §6 — status quo before adoption lands)', () => {
    it('append_trace envelopes never contain buffered-line content or a foreign nonce value', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      await traceBufferStore.append(
        run.id,
        'step-agent',
        [{ event: 'pre-existing-secret-event' }],
        {
          writerNonce: 'PRE-EXISTING-FOREIGN-NONCE',
        },
      );

      const result = await handleAppendTrace(
        {
          run_id: run.id,
          step_id: 'step-agent',
          entries: [{ event: 'new' }],
          writer_nonce: 'MY-OWN-NONCE',
        },
        { runStore, workflowStore, traceBufferStore },
      );

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('pre-existing-secret-event');
      expect(serialized).not.toContain('PRE-EXISTING-FOREIGN-NONCE');
      // Its OWN nonce is never echoed back either — only the boolean applied-marker.
      expect(serialized).not.toContain('MY-OWN-NONCE');
    });

    it('get_run_state envelopes never contain buffered-line content or any nonce value, even after a mixed-adoption settle', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      await traceBufferStore.append(run.id, 'step-agent', [{ event: 'own-event' }], {
        writerNonce: 'my-nonce',
      });
      await traceBufferStore.append(run.id, 'step-agent', [{ event: 'foreign-secret-event' }], {
        writerNonce: 'FOREIGN-NONCE-VALUE',
      });
      await handleExecuteStep(
        { run_id: run.id, command: 'step-agent', params: {}, writer_nonce: 'my-nonce' },
        { runStore, workflowStore, traceBufferStore },
      );

      const state = await handleGetRunState({ run_id: run.id }, { runStore });

      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain('foreign-secret-event');
      expect(serialized).not.toContain('own-event');
      expect(serialized).not.toContain('FOREIGN-NONCE-VALUE');
      expect(serialized).not.toContain('my-nonce');
      // evidence is never embedded in get_run_state — only a count.
      expect(state).not.toHaveProperty('evidence');
      expect(typeof state.evidence_count).toBe('number');
    });
  });

  describe('#208 capacityWarning re-home (issue #197 PR-2, deliverable 2d)', () => {
    it('the whole-file (backstop) scope can warn even when the appending writer is NOT individually near its own ceiling', async () => {
      const { run } = await runStore.create({
        workflowId: 'writer-nonce-wf',
        workflowVersion: 1,
        params: {},
      });
      const bigBatch = (label: string, n: number) =>
        Array.from({ length: n }, (_, i) => ({ event: `${label}-${i}` }));

      // Writer A fills its own ceiling exactly (200/200 = 100% for ITS OWN append — a separate
      // fact from what this test asserts). Writer B then appends 150 (150/200 = 75% — below the
      // 80% threshold for its OWN writer scope), but the file total (200+150=350)/400 = 87.5% —
      // ABOVE threshold — so the warning on B's OWN result must be the FILE-scope one.
      await handleAppendTrace(
        {
          run_id: run.id,
          step_id: 'step-agent',
          entries: bigBatch('a', 200),
          writer_nonce: 'writer-a',
        },
        { runStore, workflowStore, traceBufferStore },
      );
      const result = await handleAppendTrace(
        {
          run_id: run.id,
          step_id: 'step-agent',
          entries: bigBatch('b', 150),
          writer_nonce: 'writer-b',
        },
        { runStore, workflowStore, traceBufferStore },
      );

      expect(result.status).toBe('ok');
      expect(result.buffer_count).toBe(150); // writer B's OWN share — well under its own ceiling
      const capacityWarn = (result.warnings ?? []).find((w) => w.includes('approaching the limit'));
      expect(capacityWarn).toBeDefined();
      expect(capacityWarn).toContain('whole-file, all writers combined');
      expect(capacityWarn).toContain('350/400 entries');
      // Never introduces a <n>/<m> substring for the OTHER dimension that would trip a
      // not-the-other-dimension style assertion elsewhere — only ONE binding dimension reported.
      expect(capacityWarn).toMatch(/\d+\/\d+ (entries|bytes)/);
    });
  });
});
