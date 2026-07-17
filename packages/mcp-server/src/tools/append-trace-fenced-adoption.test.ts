// Behavioral spy tests for append_trace's fenced-trio adoption (issue #207 PR-2, D3 §2).
//
// Confirms the actual DISPATCH behavior, not just outcomes: capability-present routes through
// appendFenced (never raw append) for non-empty entries, with no advisory; capability-absent
// routes through raw append with the envelope advisory present; empty entries always use the raw
// unlocked path regardless of capability (D3 §2: unchanged, no advisory either way).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  InMemoryTraceBufferStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type {
  WorkflowDefinition,
  AppendResult,
  BufferedEntry,
  AgentTraceEntry,
  TraceBufferStore,
} from '@sensigo/realm';
import { handleAppendTrace, resetUnfencedTraceStoreWarnings } from './append-trace.js';

function makeWorkflowDef(): WorkflowDefinition {
  return {
    id: 'append-trace-spy-wf',
    name: 'Append Trace Spy Test Workflow',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      'step-auto': { description: 'Auto step', execution: 'auto', depends_on: [] },
      'step-agent': { description: 'Agent step', execution: 'agent', depends_on: ['step-auto'] },
    },
  };
}

/** Minimal legacy-only TraceBufferStore stub (issue #207 PR-2): implements ONLY the four legacy
 *  methods — no fenced trio declared at all, so `typeof store.appendFenced === 'function'` is
 *  false and append_trace's capability-absent branch is exercised. Call-counted for the spy
 *  assertions below (deliberately simple — not a conformance-grade store). */
class LegacyOnlyTraceBufferStore {
  appendCalls = 0;
  private buffers = new Map<string, BufferedEntry[]>();

  async append(runId: string, stepId: string, entries: AgentTraceEntry[]): Promise<AppendResult> {
    this.appendCalls++;
    const k = `${runId}:${stepId}`;
    const existing = this.buffers.get(k) ?? [];
    const updated = [...existing, ...entries.map((e) => ({ ...e, _internalTs: 0 }))];
    this.buffers.set(k, updated);
    return {
      buffer_count: updated.length,
      buffer_bytes: 0,
      limit_count: 200,
      limit_bytes: 100 * 1024,
      final_limit_entries: 100,
      final_limit_bytes: 50 * 1024,
    };
  }

  async read(runId: string, stepId: string): Promise<BufferedEntry[]> {
    return this.buffers.get(`${runId}:${stepId}`) ?? [];
  }

  async delete(runId: string, stepId: string): Promise<void> {
    this.buffers.delete(`${runId}:${stepId}`);
  }

  async deleteAllForRun(runId: string): Promise<void> {
    for (const k of [...this.buffers.keys()]) {
      if (k.startsWith(`${runId}:`)) this.buffers.delete(k);
    }
  }

  async readAllForRun(runId: string): Promise<Record<string, unknown[]>> {
    const result: Record<string, unknown[]> = {};
    for (const [k, v] of this.buffers.entries()) {
      if (k.startsWith(`${runId}:`)) result[k.slice(runId.length + 1)] = v;
    }
    return result;
  }
}

describe('append_trace fenced-trio adoption — behavioral spy (issue #207 PR-2)', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-append-trace-spy-runs-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-append-trace-spy-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    const def = makeWorkflowDef();
    await writeFile(join(workflowDir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
    resetUnfencedTraceStoreWarnings();
  });

  it('capability present + non-empty entries: appendFenced exactly once, raw append never, no advisory', async () => {
    const { run } = await runStore.create({
      workflowId: 'append-trace-spy-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    const appendFencedSpy = vi.spyOn(traceBufferStore, 'appendFenced');
    const appendSpy = vi.spyOn(traceBufferStore, 'append');

    const result = await handleAppendTrace(
      { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'x' }] },
      { runStore, workflowStore, traceBufferStore },
    );

    expect(appendFencedSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('ok');
    expect(result.warnings).toBeUndefined();
  });

  it('empty entries: raw append exactly once regardless of capability (capability present)', async () => {
    const { run } = await runStore.create({
      workflowId: 'append-trace-spy-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new InMemoryTraceBufferStore();
    const appendFencedSpy = vi.spyOn(traceBufferStore, 'appendFenced');
    const appendSpy = vi.spyOn(traceBufferStore, 'append');

    const result = await handleAppendTrace(
      { run_id: run.id, step_id: 'step-agent', entries: [] },
      { runStore, workflowStore, traceBufferStore },
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendFencedSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('ok');
    expect(result.warnings).toBeUndefined();
  });

  it('empty entries: raw append exactly once regardless of capability (capability absent)', async () => {
    const { run } = await runStore.create({
      workflowId: 'append-trace-spy-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new LegacyOnlyTraceBufferStore();

    const result = await handleAppendTrace(
      { run_id: run.id, step_id: 'step-agent', entries: [] },
      {
        runStore,
        workflowStore,
        traceBufferStore: traceBufferStore as unknown as TraceBufferStore,
      },
    );

    expect(traceBufferStore.appendCalls).toBe(1);
    expect(result.status).toBe('ok');
    // Empty-entries probe never advises, even capability-absent (D3 §2: unchanged either way).
    expect(result.warnings).toBeUndefined();
  });

  it('capability absent + non-empty entries: raw append exactly once, envelope advisory present', async () => {
    const { run } = await runStore.create({
      workflowId: 'append-trace-spy-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new LegacyOnlyTraceBufferStore();

    const result = await handleAppendTrace(
      { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'x' }] },
      {
        runStore,
        workflowStore,
        traceBufferStore: traceBufferStore as unknown as TraceBufferStore,
      },
    );

    expect(traceBufferStore.appendCalls).toBe(1);
    expect(result.status).toBe('ok');
    expect(result.warnings).toEqual([
      'this store does not fence trace appends against concurrent settlement; entries ' +
        'acknowledged here may not be adopted',
    ]);
  });

  it('capability-absent console.warn is deduped per store constructor name across calls', async () => {
    const { run } = await runStore.create({
      workflowId: 'append-trace-spy-wf',
      workflowVersion: 1,
      params: {},
    });
    const traceBufferStore = new LegacyOnlyTraceBufferStore();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await handleAppendTrace(
        { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'x' }] },
        {
          runStore,
          workflowStore,
          traceBufferStore: traceBufferStore as unknown as TraceBufferStore,
        },
      );
      await handleAppendTrace(
        { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'y' }] },
        {
          runStore,
          workflowStore,
          traceBufferStore: traceBufferStore as unknown as TraceBufferStore,
        },
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
