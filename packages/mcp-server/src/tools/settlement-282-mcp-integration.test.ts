// settlement-282-mcp-integration.test.ts — MCP integration pins for the #282 class closure (issue
// #279, increment 2, PR-C — design record §8, "MCP"). Hand-rolled RunStore doubles per the
// get-run-state-run-health.test.ts precedent — only `.get()` (and, for the fenced case, a
// call-counted variant) is ever exercised.
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonWorkflowStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  InMemoryTraceBufferStore,
  WorkflowError,
} from '@sensigo/realm';
import type { RunRecord, RunStore, WorkflowDefinition } from '@sensigo/realm';
import { handleAppendTrace } from './append-trace.js';
import { handleGetRunState } from './get-run-state.js';
import { handleStartRun } from './start-run.js';
import { handleStartRunBatch } from './start-run-batch.js';

const def: WorkflowDefinition = {
  id: 'wf-282-mcp',
  name: '#282 MCP integration fixture',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    a: { description: 'a', execution: 'agent', depends_on: [] },
    b: { description: 'b', execution: 'agent', depends_on: [] },
  },
};

function makeGrandfathered(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'g1',
    workflow_id: def.id,
    workflow_version: 1,
    completed_steps: ['a', 'b'],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'gate_waiting', // STALE — the record is actually terminal
    version: 1,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: true,
    terminal_reason: 'Workflow completed.',
    pending_gate: {
      gate_id: 'stale',
      step_name: 'a',
      preview: {},
      choices: ['approve', 'reject'],
      opened_at: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

function makeStaticStore(run: RunRecord): RunStore {
  return {
    persistsClaims: true,
    async get() {
      return run;
    },
    async create() {
      return { run, created: true };
    },
    async update(r) {
      return r;
    },
    async list() {
      return [run];
    },
    async claimStep() {
      return run;
    },
  };
}

describe('APPEND_TRACE_TERMINAL_KEYED (issue #279, increment 2, PR-C)', () => {
  it('a G record (terminal, stale persisted phase) is refused at the pre-CS check — keyed on terminal_state, not run_phase', async () => {
    const workflowDir = await mkdtemp(join(tmpdir(), 'realm-282-append-trace-wf-'));
    await writeFile(join(workflowDir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
    const workflowStore = new JsonWorkflowStore(workflowDir);
    const runStore = makeStaticStore(makeGrandfathered());
    const traceBufferStore = new InMemoryTraceBufferStore();

    await expect(
      handleAppendTrace(
        { run_id: 'g1', step_id: 'a', entries: [{ event: 'x' }] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toMatchObject({ code: 'STATE_STEP_NOT_ELIGIBLE' });
  });

  it("a two-phase store (LIVE at the pre-CS get, G at the fenced guard's own re-check) is ALSO refused — proving the guard's own keying, not just the pre-CS one", async () => {
    const workflowDir = await mkdtemp(join(tmpdir(), 'realm-282-append-trace-wf-2-'));
    await writeFile(join(workflowDir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
    const workflowStore = new JsonWorkflowStore(workflowDir);

    const live = makeGrandfathered({
      terminal_state: false,
      terminal_reason: undefined,
      pending_gate: undefined,
      completed_steps: [],
      run_phase: 'running',
    });
    const grandfathered = makeGrandfathered();
    let getCallCount = 0;
    const runStore: RunStore = {
      persistsClaims: true,
      async get(runId: string) {
        getCallCount += 1;
        if (runId !== 'g1')
          throw new WorkflowError('not found', {
            code: 'STATE_RUN_NOT_FOUND',
            category: 'STATE',
            agentAction: 'report_to_user',
            retryable: false,
          });
        // First call: the pre-CS check (live). Second+ call: the fenced guard's OWN re-check —
        // simulates a concurrent settle terminalizing the run (into a #282-shaped stale record)
        // between the pre-CS read and the physical write.
        return getCallCount === 1 ? live : grandfathered;
      },
      async create() {
        return { run: live, created: true };
      },
      async update(r) {
        return r;
      },
      async list() {
        return [live];
      },
      async claimStep() {
        return live;
      },
    };
    const traceBufferStore = new InMemoryTraceBufferStore();

    await expect(
      handleAppendTrace(
        { run_id: 'g1', step_id: 'a', entries: [{ event: 'x' }] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toMatchObject({ code: 'STATE_STEP_NOT_ELIGIBLE' });
    expect(getCallCount).toBeGreaterThanOrEqual(2); // the pre-CS read AND the guard's own re-check
  });
});

describe('get_run_state suppression (issue #279, increment 2, PR-C)', () => {
  it('a G record reports the DERIVED phase, and pending_gate is suppressed (absent) on the terminal record', async () => {
    const runStore = makeStaticStore(makeGrandfathered());
    const summary = await handleGetRunState({ run_id: 'g1' }, { runStore });
    expect(summary.run_phase).toBe('completed');
    expect(summary.pending_gate).toBeUndefined();
  });
});

describe('start_run / start_run_batch — reuse-envelope pins (issue #279, increment 2, PR-C)', () => {
  it('start_run, deduped onto a G record, reports "completed" — never "gate_waiting" — in both the envelope and the context_hint', async () => {
    const workflowDir = await mkdtemp(join(tmpdir(), 'realm-282-start-run-wf-'));
    await writeFile(join(workflowDir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
    const workflowStore = new JsonWorkflowStore(workflowDir);
    const g = makeGrandfathered();
    const runStore: RunStore = {
      persistsClaims: true,
      async get() {
        return g;
      },
      async create() {
        return { run: g, created: false }; // deduped — the idempotent-match path
      },
      async update(r) {
        return r;
      },
      async list() {
        return [g];
      },
      async claimStep() {
        return g;
      },
    };

    const result = await handleStartRun(
      { workflow_id: def.id, idempotency_key: 'k1' },
      { runStore, workflowStore },
    );
    expect(result.deduped).toBe(true);
    expect(result.run_phase).toBe('completed');
    expect(JSON.stringify(result)).not.toContain('gate_waiting');
  });

  it('start_run_batch, deduped onto a G record, reports "completed" in the item\'s run_phase — never "gate_waiting"', async () => {
    const workflowDir = await mkdtemp(join(tmpdir(), 'realm-282-start-run-batch-wf-'));
    await writeFile(join(workflowDir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
    const workflowStore = new JsonWorkflowStore(workflowDir);
    const g = makeGrandfathered();
    const runStore: RunStore = {
      persistsClaims: true,
      async get() {
        return g;
      },
      async create() {
        return { run: g, created: false };
      },
      async update(r) {
        return r;
      },
      async list() {
        return [g];
      },
      async claimStep() {
        return g;
      },
    };

    const result = await handleStartRunBatch(
      { workflow_id: def.id, items: [{ params: {}, idempotency_key: 'k1' }] },
      { runStore, workflowStore },
    );
    expect(result.started[0]?.deduped).toBe(true);
    expect(result.started[0]?.run_phase).toBe('completed');
    expect(JSON.stringify(result)).not.toContain('gate_waiting');
  });
});
