// Tests for listRuns business logic.
import { describe, it, expect } from 'vitest';
import { listRuns, formatGateAge } from './list.js';
import type { RunStore, RunRecord } from '@sensigo/realm';

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-abc123',
    workflow_id: 'test-workflow',
    workflow_version: 1,
    run_phase: 'completed',
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    version: 2,
    params: {},
    evidence: [],
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:01:00.000Z',
    terminal_state: true,
    ...overrides,
  };
}

function makeStore(runs: RunRecord[]): RunStore {
  return {
    get: async () => runs[0]!,
    create: async () => runs[0]!,
    update: async () => runs[0]!,
    list: async (workflowId?: string) =>
      workflowId !== undefined ? runs.filter((r) => r.workflow_id === workflowId) : runs,
  };
}

describe('listRuns', () => {
  it('returns a no-runs message when the store is empty', async () => {
    const result = await listRuns(undefined, makeStore([]));
    expect(result).toContain('No runs found');
  });

  it('includes workflow-specific message when filter returns nothing', async () => {
    const result = await listRuns('missing-workflow', makeStore([]));
    expect(result).toContain("No runs found for workflow 'missing-workflow'");
  });

  it('includes run id, workflow id, version, and state', async () => {
    const run = makeRun();
    const result = await listRuns(undefined, makeStore([run]));
    expect(result).toContain('run-abc123');
    expect(result).toContain('test-workflow');
    expect(result).toContain('v1');
    expect(result).toContain('completed');
  });

  it('includes the step count (excluding gate_response entries)', async () => {
    const run = makeRun({
      evidence: [
        {
          step_id: 'step_one',
          kind: 'execution',
          started_at: '',
          completed_at: '',
          duration_ms: 1,
          input_summary: {},
          output_summary: {},
          status: 'success',
          evidence_hash: 'x',
        },
        {
          step_id: 'step_one',
          kind: 'gate_response',
          started_at: '',
          completed_at: '',
          duration_ms: 1,
          input_summary: {},
          output_summary: {},
          status: 'success',
          evidence_hash: 'y',
        },
      ],
    });
    const result = await listRuns(undefined, makeStore([run]));
    expect(result).toContain('1 step(s)');
  });

  it('sorts runs by updated_at descending', async () => {
    const older = makeRun({
      id: 'run-old',
      updated_at: '2024-01-01T00:00:00.000Z',
      workflow_id: 'wf',
      workflow_version: 1,
    });
    const newer = makeRun({
      id: 'run-new',
      updated_at: '2024-06-01T00:00:00.000Z',
      workflow_id: 'wf',
      workflow_version: 1,
    });
    const result = await listRuns(undefined, makeStore([older, newer]));
    expect(result.indexOf('run-new')).toBeLessThan(result.indexOf('run-old'));
  });

  it('counts retried steps as one step', async () => {
    const run = makeRun({
      evidence: [
        {
          step_id: 'step_one',
          kind: 'execution',
          started_at: '',
          completed_at: '',
          duration_ms: 1,
          input_summary: {},
          output_summary: {},
          status: 'error',
          evidence_hash: 'a',
        },
        {
          step_id: 'step_one',
          kind: 'execution',
          started_at: '',
          completed_at: '',
          duration_ms: 1,
          input_summary: {},
          output_summary: {},
          status: 'success',
          evidence_hash: 'b',
        },
        {
          step_id: 'step_two',
          kind: 'execution',
          started_at: '',
          completed_at: '',
          duration_ms: 1,
          input_summary: {},
          output_summary: {},
          status: 'success',
          evidence_hash: 'c',
        },
      ],
    });
    const result = await listRuns(undefined, makeStore([run]));
    expect(result).toContain('2 step(s)');
  });

  it('filters by workflowId when provided', async () => {
    const a = makeRun({ id: 'run-a', workflow_id: 'wf-a' });
    const b = makeRun({ id: 'run-b', workflow_id: 'wf-b' });
    const result = await listRuns('wf-a', makeStore([a, b]));
    expect(result).toContain('run-a');
    expect(result).not.toContain('run-b');
  });

  // --stuck diagnostic (0.10.0)
  it('--stuck shows only running runs with no claimed step', async () => {
    const stuck = makeRun({
      id: 'run-stuck',
      run_phase: 'running',
      terminal_state: false,
      in_progress_steps: [],
    });
    const active = makeRun({
      id: 'run-active',
      run_phase: 'running',
      terminal_state: false,
      in_progress_steps: ['step_a'],
      // A HEALTHY in-flight claim (a live runner) — not stuck under the #101 3-state model.
      claims: { step_a: { deadline: new Date(Date.now() + 3_600_000).toISOString() } },
    });
    const done = makeRun({ id: 'run-done', run_phase: 'completed', terminal_state: true });
    const result = await listRuns(undefined, makeStore([stuck, active, done]), undefined, true);
    expect(result).toContain('run-stuck');
    expect(result).not.toContain('run-active'); // has a HEALTHY claimed step (live runner)
    expect(result).not.toContain('run-done'); // terminal
    expect(result).toContain('idle:'); // idle age shown
  });

  it('--stuck returns a no-stuck-runs message when none match', async () => {
    const active = makeRun({
      id: 'run-active',
      run_phase: 'running',
      terminal_state: false,
      in_progress_steps: ['step_a'],
      // HEALTHY in-flight claim → not stuck under the #101 3-state model.
      claims: { step_a: { deadline: new Date(Date.now() + 3_600_000).toISOString() } },
    });
    const result = await listRuns(undefined, makeStore([active]), undefined, true);
    expect(result).toContain('No stuck runs found');
  });

  it('--stuck flags a claimed-but-idle run with a STALE claim, labeled with its state (#101)', async () => {
    const wedge = makeRun({
      id: 'run-wedge',
      run_phase: 'running',
      terminal_state: false,
      in_progress_steps: ['step_a'],
      claims: { step_a: { deadline: new Date(Date.now() - 60_000).toISOString() } },
    });
    const result = await listRuns(undefined, makeStore([wedge]), undefined, true);
    expect(result).toContain('run-wedge');
    expect(result).toContain('step_a=claim_stale');
  });

  it('--stuck flags a claimed-but-idle run with an UNKNOWN-AGE claim (#101)', async () => {
    const wedge = makeRun({
      id: 'run-wedge2',
      run_phase: 'running',
      terminal_state: false,
      in_progress_steps: ['step_a'],
      claims: { step_a: { deadline: null } },
    });
    const result = await listRuns(undefined, makeStore([wedge]), undefined, true);
    expect(result).toContain('run-wedge2');
    expect(result).toContain('step_a=claim_unknown_age');
  });

  // #101 gate/fan-out correction: a wedged NON-gated sibling on a gate_waiting run must surface.
  it('--stuck flags a gate_waiting run with a STALE non-gated sibling; does NOT label the gated step', async () => {
    const wedge = makeRun({
      id: 'run-gatewedge',
      run_phase: 'gate_waiting',
      terminal_state: false,
      in_progress_steps: ['gated', 'branch_b'],
      claims: {
        gated: { deadline: new Date(Date.now() - 60_000).toISOString() }, // gated step, even if stale...
        branch_b: { deadline: new Date(Date.now() - 60_000).toISOString() },
      },
      pending_gate: {
        gate_id: 'g1',
        step_name: 'gated',
        choices: ['approve'],
        opened_at: new Date().toISOString(),
        preview: {},
      },
    });
    const result = await listRuns(undefined, makeStore([wedge]), undefined, true);
    expect(result).toContain('run-gatewedge');
    expect(result).toContain('branch_b=claim_stale');
    expect(result).not.toContain('gated=claim_stale'); // the open-gate step is never a wedge
  });

  it('--stuck flags a gate_waiting run with an UNKNOWN-AGE non-gated sibling', async () => {
    const wedge = makeRun({
      id: 'run-gatewedge2',
      run_phase: 'gate_waiting',
      terminal_state: false,
      in_progress_steps: ['gated', 'branch_b'],
      claims: { gated: { deadline: null }, branch_b: { deadline: null } },
      pending_gate: {
        gate_id: 'g1',
        step_name: 'gated',
        choices: ['approve'],
        opened_at: new Date().toISOString(),
        preview: {},
      },
    });
    const result = await listRuns(undefined, makeStore([wedge]), undefined, true);
    expect(result).toContain('run-gatewedge2');
    expect(result).toContain('branch_b=claim_unknown_age');
    expect(result).not.toContain('gated=');
  });

  it('--stuck does NOT flag a gate_waiting run whose only in-progress claim is the gated step', async () => {
    const plainGate = makeRun({
      id: 'run-plaingate',
      run_phase: 'gate_waiting',
      terminal_state: false,
      in_progress_steps: ['gated'],
      claims: { gated: { deadline: new Date(Date.now() - 60_000).toISOString() } },
      pending_gate: {
        gate_id: 'g1',
        step_name: 'gated',
        choices: ['approve'],
        opened_at: new Date().toISOString(),
        preview: {},
      },
    });
    const result = await listRuns(undefined, makeStore([plainGate]), undefined, true);
    expect(result).toContain('No stuck runs found');
  });

  // #134 fan-out fix — a capability-blocked step behind a HEALTHY in-progress sibling.
  it('--stuck flags a capability-blocked step even behind a healthy in-progress sibling (fan-out fix)', async () => {
    const blocked = makeRun({
      id: 'run-capblock',
      run_phase: 'running',
      terminal_state: false,
      in_progress_steps: ['sibling'], // a live sibling — the plain claim check would read this 'ok'
      claims: { sibling: { deadline: new Date(Date.now() + 3_600_000).toISOString() } },
      capability_blocks: {
        enrich: {
          requirement: { kind: 'adapter', name: 'shopify' },
          code: 'ENGINE_ADAPTER_NOT_REGISTERED',
          at: new Date().toISOString(),
        },
      },
    });
    const result = await listRuns(undefined, makeStore([blocked]), undefined, true);
    expect(result).toContain('run-capblock');
    expect(result).toContain("enrich: needs adapter 'shopify'"); // names the missing requirement
  });

  it('--stuck does NOT flag a terminal run whose capability block step has since settled', async () => {
    const settled = makeRun({
      id: 'run-capdone',
      run_phase: 'completed',
      terminal_state: true,
      completed_steps: ['enrich'],
      capability_blocks: {
        enrich: {
          requirement: { kind: 'adapter', name: 'shopify' },
          code: 'ENGINE_ADAPTER_NOT_REGISTERED',
          at: new Date().toISOString(),
        },
      },
    });
    const result = await listRuns(undefined, makeStore([settled]), undefined, true);
    expect(result).toContain('No stuck runs found');
  });
});

describe('listRuns statusFilter', () => {
  it('returns only gate_waiting runs when statusFilter is gate_waiting', async () => {
    const waiting = makeRun({
      id: 'run-waiting',
      run_phase: 'gate_waiting',
      terminal_state: false,
      pending_gate: {
        gate_id: 'g1',
        step_name: 'human_review',
        preview: {},
        choices: ['approve'],
        opened_at: '2024-01-01T00:00:00.000Z',
      },
    });
    const completed = makeRun({ id: 'run-done', run_phase: 'completed' });
    const result = await listRuns(undefined, makeStore([waiting, completed]), 'gate_waiting');
    expect(result).toContain('run-waiting');
    expect(result).not.toContain('run-done');
  });

  it('returns only completed runs when statusFilter is completed', async () => {
    const waiting = makeRun({
      id: 'run-waiting',
      run_phase: 'gate_waiting',
      terminal_state: false,
    });
    const completed = makeRun({ id: 'run-done', run_phase: 'completed' });
    const result = await listRuns(undefined, makeStore([waiting, completed]), 'completed');
    expect(result).toContain('run-done');
    expect(result).not.toContain('run-waiting');
  });

  it('returns all runs when statusFilter is omitted', async () => {
    const a = makeRun({ id: 'run-a', run_phase: 'running', terminal_state: false });
    const b = makeRun({ id: 'run-b', run_phase: 'completed' });
    const result = await listRuns(undefined, makeStore([a, b]));
    expect(result).toContain('run-a');
    expect(result).toContain('run-b');
  });

  it('gate_waiting row includes gate step name and formatted age', async () => {
    const openedAt = new Date(Date.now() - 25 * 60 * 1000).toISOString(); // 25 minutes ago
    const waiting = makeRun({
      id: 'run-gate',
      run_phase: 'gate_waiting',
      terminal_state: false,
      pending_gate: {
        gate_id: 'g2',
        step_name: 'human_review',
        preview: {},
        choices: ['approve'],
        opened_at: openedAt,
      },
    });
    const result = await listRuns(undefined, makeStore([waiting]), 'gate_waiting');
    expect(result).toContain('human_review');
    expect(result).toContain('25m');
  });
});

describe('formatGateAge', () => {
  it('formats elapsed time under 60 minutes as Xm', () => {
    const openedAt = new Date(0).toISOString();
    const now = new Date(42 * 60 * 1000); // 42 minutes later
    expect(formatGateAge(openedAt, now)).toBe('42m');
  });

  it('formats elapsed time under 24 hours as Xh Ym', () => {
    const openedAt = new Date(0).toISOString();
    const now = new Date((2 * 60 + 15) * 60 * 1000); // 2h 15m later
    expect(formatGateAge(openedAt, now)).toBe('2h 15m');
  });

  it('formats elapsed time 24 hours or more as Xd Yh', () => {
    const openedAt = new Date(0).toISOString();
    const now = new Date((3 * 24 * 60 + 5 * 60) * 60 * 1000); // 3d 5h later
    expect(formatGateAge(openedAt, now)).toBe('3d 5h');
  });
});
