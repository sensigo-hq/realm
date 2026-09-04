// inspect-gate-expiry-render.test.ts — issue #291, Deliverable 7: `realm run inspect`'s new
// "Gate:" line — opened age + EXPIRED marker + reminder due/overdue, off the shared
// computeGateDueState derivation. The EXPIRED FACT itself is independently disclosed via the
// generic run_health finding render loop (gate_expired_awaiting_drive) — both are checked here.
import { describe, it, expect } from 'vitest';
import { inspectRun } from './inspect.js';
import type {
  RunStore,
  RunRecord,
  WorkflowRegistrar,
  WorkflowDefinition,
  PendingGate,
} from '@sensigo/realm';

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run_test1',
    workflow_id: 'test-workflow',
    workflow_version: 1,
    run_phase: 'gate_waiting',
    completed_steps: [],
    in_progress_steps: ['approve'],
    failed_steps: [],
    skipped_steps: [],
    version: 1,
    params: {},
    evidence: [],
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:01.000Z',
    terminal_state: false,
    claims: { approve: { deadline: null } },
    ...overrides,
  };
}

function makeGate(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    gate_id: 'gate-1',
    step_name: 'approve',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: new Date(Date.now() - 3_600_000).toISOString(),
    ...overrides,
  };
}

function makeRunStore(run: RunRecord): RunStore {
  return {
    persistsClaims: true,
    get: async () => run,
    create: async () => ({ run, created: true }),
    update: async () => run,
    list: async () => [run],
    // inspect.ts (the sole consumer under test here) never claims a step — this mock never needs
    // a real implementation, only a type-complete stub.
    claimStep: async () => {
      throw new Error('claimStep is not used by inspect');
    },
  };
}

const basicDef: WorkflowDefinition = {
  id: 'test-workflow',
  name: 'Test Workflow',
  version: 1,
  steps: { approve: { description: 'a', execution: 'auto', trust: 'human_confirmed' } },
};

function makeWorkflowStore(def: WorkflowDefinition = basicDef): WorkflowRegistrar {
  return { register: async () => {}, get: async () => def, list: async () => [def] };
}

describe('inspectRun — Gate: line (issue #291)', () => {
  it('a plain open gate (no timeout/reminder) renders the base Gate: line, no EXPIRED/reminder text', async () => {
    const run = makeRun({ pending_gate: makeGate() });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore());
    expect(result).toContain('Gate: approve (gate gate-1, opened');
    expect(result).not.toContain('EXPIRED');
    expect(result).not.toContain('reminder');
  });

  it('the Gate line carries the gate id — the argument `realm run respond` requires', async () => {
    // issue #406: `--stuck` now points a finding_only gate at `realm run respond`, and that verb
    // takes `--gate <gate-id>`. Neither `list` nor `inspect` printed the id, so the remedy could
    // not be completed from the surfaces a stuck operator has — the drive-time surfaces that DO
    // print it are exactly the ones a stuck run no longer has.
    const run = makeRun({ pending_gate: makeGate() });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore());
    expect(result).toContain('gate gate-1');
  });

  it("the Choices line carries the gate's choices — the other argument `respond` requires", async () => {
    // issue #406's remedy loop, second half. `realm run respond` takes --gate AND --choice; the
    // id arrived with the Gate line, and without this the choice was a documented guess (the
    // refusal lists the valid ones on a wrong try). Both now come from one read.
    //
    // The render reads `run.pending_gate.choices`, which is the SAME source both validation
    // sites read — so what is printed is what respond will accept, with no drift surface.
    const run = makeRun({ pending_gate: makeGate({ choices: ['approve', 'reject'] }) });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore());
    expect(result).toContain('Choices: approve, reject');
  });

  it('an EMPTY choices array renders no Choices line at all', async () => {
    // Reachable for a GRANDFATHERED registered copy (issue #433: the authored form — a fresh
    // `gate.choices: []` — is a load error now; a copy registered BEFORE #433 shipped can still
    // carry the empty array and keeps running). Not fixture armor: this render cell's own
    // construction (makeRun/makeGate) bypasses the loader entirely, exactly the shape a
    // grandfathered copy takes at read time. Printing an empty "Choices:" would advertise a menu
    // with nothing on it. That such a gate is human-unresolvable at all is the pre-#433 wedge —
    // closed at load time for newly-authored workflows, open only for the grandfathered
    // population — not this render's to fix.
    const run = makeRun({ pending_gate: makeGate({ choices: [] }) });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore());
    expect(result).toContain('Gate: approve');
    expect(result).not.toContain('Choices:');
  });

  it('an expired gate renders the EXPIRED marker on the Gate: line', async () => {
    const run = makeRun({
      pending_gate: makeGate({ expires_at: new Date(Date.now() - 300_000).toISOString() }),
    });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore());
    expect(result).toMatch(/Gate: approve.*EXPIRED \d+m ago/);
  });

  it('an expired, enactable gate ALSO surfaces via the run_health gate_expired_awaiting_drive finding', async () => {
    const run = makeRun({
      pending_gate: makeGate({
        expires_at: new Date(Date.now() - 300_000).toISOString(),
        on_expiry: 'abort',
      }),
    });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore());
    expect(result).toContain('gate_expired_awaiting_drive');
    expect(result).toContain('[approve]');
  });

  it('a gate with a frozen reminder shows "reminder due in"', async () => {
    const run = makeRun({
      pending_gate: makeGate({
        opened_at: new Date(Date.now() - 10_000).toISOString(),
        reminder_seconds: 3600,
      }),
    });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore());
    expect(result).toContain('reminder due in');
  });

  it('no Gate: line at all for a non-gated run', async () => {
    const run = makeRun({
      run_phase: 'completed',
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      completed_steps: ['approve'],
      in_progress_steps: [],
    });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore());
    expect(result).not.toContain('Gate:');
    // The Choices line is as absent as its parent — it lives inside the same gate block.
    expect(result).not.toContain('Choices:');
  });
});
