// Tests for append_trace's capacity early-warning (issue #208).
//
// AC 3: covered entirely against InMemoryTraceBufferStore (store-agnostic by construction — the
// helper reads only AppendResult's already-returned fields, never store internals). AC 4 (works
// identically regardless of which store is injected) is exercised by the "unfenced store" test
// using a second, independent store stub — both stores produce the same warning shape from the
// same fill ratios.
//
// Crossing scenarios deliberately loop appending one entry at a time (rather than hand-computing
// an exact seed count) and stop the moment `warnings` first appears — this is fully deterministic
// (no randomness, no timing dependence: the same entry-generator always crosses at the same
// iteration) while avoiding brittle hand-arithmetic over JSON.stringify's exact byte overhead.
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  InMemoryTraceBufferStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  BUFFER_LIMIT_COUNT,
} from '@sensigo/realm';
import type {
  WorkflowDefinition,
  AppendResult,
  BufferedEntry,
  AgentTraceEntry,
  TraceBufferStore,
} from '@sensigo/realm';
import { handleAppendTrace } from './append-trace.js';

function makeWorkflowDef(): WorkflowDefinition {
  return {
    id: 'append-trace-capacity-wf',
    name: 'Append Trace Capacity Test Workflow',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      'step-agent': { description: 'Agent step', execution: 'agent', depends_on: [] },
    },
  };
}

/** A tiny entry — negligible bytes, so repeated appends drive the COUNT ratio toward its ceiling
 *  long before the BYTES ratio moves at all. */
function tinyEntry(seed: number): AgentTraceEntry {
  return { event: `e${seed}` };
}

/** A large-data entry — 20 keys (MAX_DATA_KEYS) of 500 chars each (MAX_STRING_VALUE), so the
 *  normalizer never caps/distorts it — each one contributes ~10KB, driving the BYTES ratio toward
 *  its ceiling in a handful of appends while the COUNT ratio (denominator 200) stays negligible. */
function bigDataEntry(seed: number): AgentTraceEntry {
  const data: Record<string, string> = {};
  for (let i = 0; i < 20; i++) {
    data[`k${i}`] = `${seed}-` + 'x'.repeat(495);
  }
  return { event: `big${seed}`, data };
}

/** Minimal legacy-only TraceBufferStore stub (no fenced trio declared) — exercises the
 *  capability-absent branch, mirroring append-trace-fenced-adoption.test.ts's own local stub
 *  (each test file keeps its own, per this repo's established per-file-stub convention). */
class LegacyOnlyTraceBufferStore {
  private buffers = new Map<string, BufferedEntry[]>();

  async append(runId: string, stepId: string, entries: AgentTraceEntry[]): Promise<AppendResult> {
    const k = `${runId}:${stepId}`;
    const existing = this.buffers.get(k) ?? [];
    const updated = [...existing, ...entries.map((e) => ({ ...e, _internalTs: 0 }))];
    this.buffers.set(k, updated);
    return {
      buffer_count: updated.length,
      buffer_bytes: Buffer.byteLength(JSON.stringify(updated)),
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

describe('append_trace capacity early-warning (issue #208)', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  async function setup(): Promise<{ runId: string }> {
    runDir = await mkdtemp(join(tmpdir(), 'realm-capacity-warn-runs-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-capacity-warn-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    const def = makeWorkflowDef();
    await writeFile(join(workflowDir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
    const { run } = await runStore.create({
      workflowId: 'append-trace-capacity-wf',
      workflowVersion: 1,
      params: {},
    });
    return { runId: run.id };
  }

  // 1. Below threshold -> no warnings field at all (fenced store).
  it('below threshold: no warnings field (fenced store)', async () => {
    const { runId } = await setup();
    const traceBufferStore = new InMemoryTraceBufferStore();

    const result = await handleAppendTrace(
      { run_id: runId, step_id: 'step-agent', entries: [{ event: 'tiny' }] },
      { runStore, workflowStore, traceBufferStore },
    );

    expect(result.status).toBe('ok');
    expect(result.warnings).toBeUndefined();
  });

  // 2. Count-driven crossing.
  it('count-driven crossing: warning present, names entries as the binding dimension, correct numbers', async () => {
    const { runId } = await setup();
    const traceBufferStore = new InMemoryTraceBufferStore();

    let result: Awaited<ReturnType<typeof handleAppendTrace>> | undefined;
    let seed = 0;
    do {
      result = await handleAppendTrace(
        { run_id: runId, step_id: 'step-agent', entries: [tinyEntry(seed++)] },
        { runStore, workflowStore, traceBufferStore },
      );
    } while (result.warnings === undefined && seed < BUFFER_LIMIT_COUNT);

    expect(seed).toBeLessThan(BUFFER_LIMIT_COUNT); // sanity: it actually crossed
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    const [warning] = result.warnings!;
    expect(warning).toContain('entries');
    expect(warning).toContain(`${result.buffer_count}/${result.limit_count}`);
    expect(warning).not.toMatch(/\d+\/\d+ bytes/); // bytes is NOT the binding dimension here
    // Well under the bytes ceiling — tiny entries never move the bytes ratio meaningfully.
    expect(result.buffer_bytes / result.limit_bytes).toBeLessThan(0.5);
  });

  // 3. Bytes-driven crossing.
  it('bytes-driven crossing: entries low, bytes >= 80% -> warning present, names bytes', async () => {
    const { runId } = await setup();
    const traceBufferStore = new InMemoryTraceBufferStore();

    let result: Awaited<ReturnType<typeof handleAppendTrace>> | undefined;
    let seed = 0;
    do {
      result = await handleAppendTrace(
        { run_id: runId, step_id: 'step-agent', entries: [bigDataEntry(seed++)] },
        { runStore, workflowStore, traceBufferStore },
      );
    } while (result.warnings === undefined && seed < 30);

    expect(seed).toBeLessThan(30); // sanity: it actually crossed, well before the count ceiling
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    const [warning] = result.warnings!;
    expect(warning).toContain('bytes');
    expect(warning).toContain(`${result.buffer_bytes}/${result.limit_bytes}`);
    expect(warning).not.toMatch(/\d+\/\d+ entries/); // entries is NOT the binding dimension here
    // Entries count stays a small fraction of the count ceiling (200) — proves this crossing is
    // genuinely bytes-driven, not count-driven.
    expect(result.buffer_count).toBeLessThan(BUFFER_LIMIT_COUNT * 0.2);
  });

  // 4. Unfenced store at >= 80%: BOTH warnings present, in the specified order.
  it('unfenced store at >= 80%: both the unfenced-store advisory AND the capacity warning are present, in order', async () => {
    const { runId } = await setup();
    const traceBufferStore = new LegacyOnlyTraceBufferStore();

    let result: Awaited<ReturnType<typeof handleAppendTrace>> | undefined;
    let seed = 0;
    do {
      result = await handleAppendTrace(
        { run_id: runId, step_id: 'step-agent', entries: [tinyEntry(seed++)] },
        {
          runStore,
          workflowStore,
          traceBufferStore: traceBufferStore as unknown as TraceBufferStore,
        },
      );
    } while (result.warnings!.length < 2 && seed < BUFFER_LIMIT_COUNT);

    expect(seed).toBeLessThan(BUFFER_LIMIT_COUNT);
    expect(result.warnings).toHaveLength(2);
    // Order: unfenced-store advisory FIRST, capacity SECOND.
    expect(result.warnings![0]).toContain('does not fence trace appends');
    expect(result.warnings![1]).toContain('entries');
  });

  // 5. Empty-entries probe.
  it('empty-entries probe against a buffer already >= 80%: warning present', async () => {
    const { runId } = await setup();
    const traceBufferStore = new InMemoryTraceBufferStore();

    let seeded: Awaited<ReturnType<typeof handleAppendTrace>> | undefined;
    let seed = 0;
    do {
      seeded = await handleAppendTrace(
        { run_id: runId, step_id: 'step-agent', entries: [tinyEntry(seed++)] },
        { runStore, workflowStore, traceBufferStore },
      );
    } while (seeded.warnings === undefined && seed < BUFFER_LIMIT_COUNT);
    expect(seeded.warnings).toBeDefined(); // sanity: the seed actually crossed

    const probe = await handleAppendTrace(
      { run_id: runId, step_id: 'step-agent', entries: [] },
      { runStore, workflowStore, traceBufferStore },
    );

    expect(probe.warnings).toBeDefined();
    expect(probe.warnings).toHaveLength(1);
    expect(probe.warnings![0]).toContain('entries');
  });

  it('empty-entries probe against a small buffer: no warnings', async () => {
    const { runId } = await setup();
    const traceBufferStore = new InMemoryTraceBufferStore();
    await handleAppendTrace(
      { run_id: runId, step_id: 'step-agent', entries: [tinyEntry(0)] },
      { runStore, workflowStore, traceBufferStore },
    );

    const probe = await handleAppendTrace(
      { run_id: runId, step_id: 'step-agent', entries: [] },
      { runStore, workflowStore, traceBufferStore },
    );

    expect(probe.warnings).toBeUndefined();
  });

  // 6. Boundary: exactly at the threshold.
  it('boundary: exactly at the 80% threshold (160/200 entries) -> warning present (>=, not >)', async () => {
    const { runId } = await setup();
    const traceBufferStore = new InMemoryTraceBufferStore();

    // Seed 159 directly (bypassing the tool — InMemoryTraceBufferStore.append applies the exact
    // same normalization the tool's own call would), then the 160th via the tool — landing at
    // EXACTLY 160/200 = 0.8. 160/200 and the literal 0.8 round to the identical IEEE754 double
    // (both are the nearest representable value to the mathematical 4/5), so this genuinely
    // exercises the boundary, not an approximation of it.
    const seedEntries = Array.from({ length: 159 }, (_, i) => tinyEntry(i));
    await traceBufferStore.append(runId, 'step-agent', seedEntries);

    const result = await handleAppendTrace(
      { run_id: runId, step_id: 'step-agent', entries: [tinyEntry(159)] },
      { runStore, workflowStore, traceBufferStore },
    );

    expect(result.buffer_count).toBe(160);
    expect(result.buffer_count / result.limit_count).toBe(0.8); // exact boundary, asserted explicitly
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain('160/200 entries');
  });
});
