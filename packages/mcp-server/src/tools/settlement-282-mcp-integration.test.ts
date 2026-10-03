// settlement-282-mcp-integration.test.ts — MCP integration pins for the #282 class closure (issue
// #279, increment 2, PR-C — design record §8, "MCP"). Hand-rolled RunStore doubles per the
// get-run-state-run-health.test.ts precedent — only `.get()` (and, for the fenced case, a
// call-counted variant) is ever exercised.
import { declared } from '../test-support/declared.js';
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
    // Correction (MA review of reports/atomic-settle-279-pr-c.md): a THIRD step that stays
    // VIRGIN on the grandfathered fixture below — not in completed_steps/failed_steps/
    // skipped_steps/in_progress_steps, not the pending_gate's step_name. `stepStateOf` returns
    // `undefined` for it, so the terminal_state check is the ONLY thing that can refuse it —
    // unlike step 'a' (already in completed_steps), which let a reverted terminal-state check
    // hide behind stepStateOf's OWN (unrelated) 'completed' refusal, same code, vacuous pin.
    c: { description: 'c', execution: 'agent', depends_on: [] },
  },
};

function makeGrandfathered(
  // issue #337: the "LIVE at the pre-CS get" call site erases BOTH terminal_reason and
  // pending_gate to simulate a genuinely-live run reusing this fixture's shape — widen only these
  // two fields to admit explicit undefined (see the identical fold in
  // settlement-282-cli-integration.test.ts's makeGrandfatheredFixture for the full rationale).
  overrides: Partial<Omit<RunRecord, 'terminal_reason' | 'pending_gate'>> & {
    terminal_reason?: string | undefined;
    pending_gate?: RunRecord['pending_gate'] | undefined;
  } = {},
): RunRecord {
  const {
    terminal_reason: terminalReasonOverride,
    pending_gate: pendingGateOverride,
    ...rest
  } = overrides;
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
    ...(terminalReasonOverride !== undefined
      ? { terminal_reason: terminalReasonOverride }
      : 'terminal_reason' in overrides
        ? {}
        : { terminal_reason: 'Workflow completed.' }),
    ...(pendingGateOverride !== undefined
      ? { pending_gate: pendingGateOverride }
      : 'pending_gate' in overrides
        ? {}
        : {
            pending_gate: {
              gate_id: 'stale',
              step_name: 'a',
              preview: {},
              choices: ['approve', 'reject'],
              opened_at: '2026-01-01T00:00:00.000Z',
            },
          }),
    ...rest,
  };
}

function makeStaticStore(run: RunRecord): RunStore {
  return declared({
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
  });
}

describe('APPEND_TRACE_TERMINAL_KEYED (issue #279, increment 2, PR-C)', () => {
  it("a G record (terminal, stale persisted phase) is refused at the pre-CS check — keyed on terminal_state, not run_phase, on a VIRGIN step ('c') so stepStateOf cannot mask a reverted check", async () => {
    const workflowDir = await mkdtemp(join(tmpdir(), 'realm-282-append-trace-wf-'));
    await writeFile(join(workflowDir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
    const workflowStore = new JsonWorkflowStore(workflowDir);
    const runStore = makeStaticStore(makeGrandfathered());
    const traceBufferStore = new InMemoryTraceBufferStore(runStore);

    // Correction: empty entries — the pre-CS checks (terminal_state, then stepStateOf) are the
    // ONLY check on this path (issue #279 D3 §2's "raw unlocked path UNCONDITIONALLY" for the
    // empty-probe case never evaluates the fence). A non-empty append on this SAME static
    // (always-terminal) store would ALSO get caught by the fence's own independent terminal_state
    // re-check (`step_open_for_trace`, evaluated by core's `evaluateFence`) — masking a revert of
    // the pre-CS terminal check alone (step 1b of `handleAppendTrace`) behind an unrelated,
    // differently-sited pass. Empty entries isolates the pre-CS check.
    await expect(
      handleAppendTrace(
        { run_id: 'g1', step_id: 'c', entries: [] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toMatchObject({
      code: 'STATE_STEP_NOT_ELIGIBLE',
      details: { step_state: 'run_terminal' },
    });
  });

  it("a two-phase store (LIVE at the pre-CS get, G at the fence's own re-check) is ALSO refused — proving the fence's own keying, not just the pre-CS one", async () => {
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
    const runStore: RunStore = declared({
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
        // First call: the pre-CS check (live). Second+ call: the fence's OWN re-check —
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
    });
    const traceBufferStore = new InMemoryTraceBufferStore(runStore);

    // step 'c' is virgin on BOTH `live` and `grandfathered` (neither's completed/failed/skipped/
    // in_progress arrays name it, and the pending_gate's step_name is 'a') — so stepStateOf
    // returns undefined at every read, and the ONLY thing that can refuse this call at all is the
    // fence's OWN terminal_state re-check (`step_open_for_trace`, in core's `evaluateFence`) or the
    // pre-CS terminal check (step 1b of `handleAppendTrace` — which never fires here, since the
    // pre-CS read sees `live`, not `grandfathered`).
    await expect(
      handleAppendTrace(
        { run_id: 'g1', step_id: 'c', entries: [{ event: 'x' }] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toMatchObject({
      code: 'STATE_STEP_NOT_ELIGIBLE',
      details: {
        step_state: 'run_terminal',
        // Pins the fence's OWN derive-for-message (not just its terminal_state check): the
        // fence's fresh read sees the GRANDFATHERED record, so the derived phase must be
        // 'completed' (from terminal_reason) while the persisted one stays the stale 'gate_waiting'.
        run_phase: 'completed',
        persisted_run_phase: 'gate_waiting',
      },
    });
    expect(getCallCount).toBeGreaterThanOrEqual(2); // the pre-CS read AND the fence's own re-check
  });

  // issue #616 PR-0 — when the run is gone by the fence's own re-check there is no run to read a
  // version from, so the refusal reports the version the pre-CS read saw (the fence's
  // `run_version`, set by handleAppendTrace from that read).
  it("a run that vanishes between the pre-CS read and the fence's re-check is refused run_not_found, reporting the version the pre-CS read saw", async () => {
    const workflowDir = await mkdtemp(join(tmpdir(), 'realm-282-append-trace-wf-3-'));
    await writeFile(join(workflowDir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
    const workflowStore = new JsonWorkflowStore(workflowDir);

    const live = makeGrandfathered({
      terminal_state: false,
      terminal_reason: undefined,
      pending_gate: undefined,
      completed_steps: [],
      run_phase: 'running',
      version: 4,
    });
    let getCallCount = 0;
    const runStore: RunStore = declared({
      persistsClaims: true,
      async get() {
        getCallCount += 1;
        // First call: the pre-CS check sees the live run. Second+ call: the fence's own
        // re-check finds it gone — a concurrent purge landing between the two reads.
        if (getCallCount === 1) return live;
        throw new WorkflowError('not found', {
          code: 'STATE_RUN_NOT_FOUND',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
        });
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
    });
    const traceBufferStore = new InMemoryTraceBufferStore(runStore);

    await expect(
      handleAppendTrace(
        { run_id: 'g1', step_id: 'c', entries: [{ event: 'x' }] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toMatchObject({
      code: 'STATE_STEP_NOT_ELIGIBLE',
      details: { step_id: 'c', step_state: 'run_not_found', run_version: 4 },
    });
    expect(getCallCount).toBe(2);
    expect(await traceBufferStore.read('g1', 'c')).toEqual([]);
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
    const runStore: RunStore = declared({
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
    });

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
    const runStore: RunStore = declared({
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
    });

    const result = await handleStartRunBatch(
      { workflow_id: def.id, items: [{ params: {}, idempotency_key: 'k1' }] },
      { runStore, workflowStore },
    );
    expect(result.started[0]?.deduped).toBe(true);
    expect(result.started[0]?.run_phase).toBe('completed');
    expect(JSON.stringify(result)).not.toContain('gate_waiting');
  });
});
