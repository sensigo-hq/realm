// Tests for inspectRun business logic.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRun } from './inspect.js';
import { computeExtensionIdentity, sha256HexOf } from '../extensions/extension-identity.js';
import type {
  RunStore,
  RunRecord,
  WorkflowRegistrar,
  WorkflowDefinition,
  EvidenceSnapshot,
  StepDiagnostics,
  ExtensionIdentityEntry,
} from '@sensigo/realm';

function makeSnapshot(stepId: string, overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    step_id: stepId,
    started_at: '2024-01-01T00:00:00.000Z',
    completed_at: '2024-01-01T00:00:01.000Z',
    duration_ms: 1000,
    input_summary: {},
    output_summary: {},
    status: 'success',
    evidence_hash: 'abc123def456789012345678901234567890abcd',
    ...overrides,
  };
}

function makeRun(evidence: EvidenceSnapshot[] = [], overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run_test1',
    workflow_id: 'test-workflow',
    workflow_version: 1,
    run_phase: 'completed',
    // issue #279 (increment 2, PR-C — the #282 class closure): paired with the default
    // run_phase:'completed' above so a fixture DERIVES the same phase it declares —
    // `inspect.ts` now derives, never trusts, the persisted field.
    terminal_reason: 'Workflow completed.',
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    version: 1,
    params: {},
    evidence,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:01.000Z',
    terminal_state: true,
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

function makeWorkflowStore(def?: WorkflowDefinition): WorkflowRegistrar {
  if (def !== undefined) {
    return {
      register: async () => {},
      get: async () => def,
      list: async () => [def],
    };
  }
  return {
    register: async () => {},
    get: async () => {
      throw new Error('Workflow not found');
    },
    list: async () => [],
  };
}

const basicDef: WorkflowDefinition = {
  id: 'test-workflow',
  name: 'Test Workflow',
  version: 1,
  steps: {
    step_one: {
      description: 'First step',
      execution: 'agent',
    },
  },
};

describe('inspectRun — the seal fact (issue #367)', () => {
  it("renders the arm, and the step ONLY where the step is the arm's deterministic identity", async () => {
    // A guard IS the step that sealed the run — naming it is the whole diagnostic.
    const guarded = makeRun([], {
      run_phase: 'aborted',
      terminal_state: true,
      aborted_at: { step_id: 'g' },
      sealed_by: { arm: 'guard_abort', step: 'g' },
    });
    // A guard abort is the one reason-less seal — drop the factory's default so the fixture is
    // the shape the real writer produces.
    delete (guarded as { terminal_reason?: string }).terminal_reason;
    const out = await inspectRun('run_test1', makeRunStore(guarded), makeWorkflowStore(basicDef));
    expect(out).toContain('Sealed by: guard_abort (g)');
  });

  it('does NOT render the step for a multi-failure step_failure seal — that step is a settle-order artifact', async () => {
    // The step on a `step_failure` seal is whichever one settled LAST, which is exactly the
    // instability issue #373 removed from the cause line. Printed one line above that culprit-free
    // Cause, it would read as the culprit and undo the fix. The RECORD still carries it.
    const multi = makeRun([], {
      run_phase: 'failed',
      terminal_state: true,
      failed_steps: ['alpha', 'beta'],
      sealed_by: { arm: 'step_failure', step: 'beta' },
      terminal_reason: '2 steps failed: alpha ("boom"), beta ("bang").',
    });
    const out = await inspectRun('run_test1', makeRunStore(multi), makeWorkflowStore(basicDef));
    expect(out).toContain('Sealed by: step_failure');
    expect(out).not.toContain('Sealed by: step_failure (beta)');
    // The cause line IS rendered — first time inspect has ever shown it.
    expect(out).toContain('Cause: 2 steps failed: alpha ("boom"), beta ("bang").');
  });

  it('renders an unrecognised arm rather than hiding it', async () => {
    const future = makeRun([], {
      // The cast is the point: a foreign arm arrives from disk or from a newer binary, and the
      // type system cannot stop it — so the surface must not pretend the run is unsealed.
      sealed_by: { arm: 'from_the_future' } as unknown as NonNullable<RunRecord['sealed_by']>,
    });
    const out = await inspectRun('run_test1', makeRunStore(future), makeWorkflowStore(basicDef));
    expect(out).toContain("unrecognized arm 'from_the_future'");
  });
});

describe('inspectRun — the ruling (issue #367 PR-5)', () => {
  const RULED = {
    arm: 'guard_abort' as const,
    step: 'g',
    adjudicated: {
      by: 'mihai',
      at: '2026-08-21T00:00:00.000Z',
      previous_arm: 'complete' as const,
      reason: 'the guard is what stopped this run',
    },
  };

  /** Renders a terminal run carrying `sealed_by`, through the real renderer. */
  async function render(sealedBy: NonNullable<RunRecord['sealed_by']>): Promise<string> {
    const run = makeRun([], {
      run_phase: 'aborted',
      terminal_state: true,
      aborted_at: { step_id: 'g' },
      sealed_by: sealedBy,
    });
    return inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
  }

  it('renders who ruled, when, what the arm was before — and the reason verbatim', async () => {
    const out = await render(RULED);
    expect(out).toContain(
      'Ruled: mihai at 2026-08-21T00:00:00.000Z (was complete) — the guard is what stopped this run',
    );
  });

  it('renders a ruling that carries no reason, without a dangling dash', async () => {
    // `reason` is optional in the contract, so the renderer must not assume it. A trailing ' — '
    // with nothing after it reads like the reason was lost in transit.
    const { reason: _reason, ...noReason } = RULED.adjudicated;
    const out = await render({ ...RULED, adjudicated: noReason });
    expect(out).toContain('Ruled: mihai at 2026-08-21T00:00:00.000Z (was complete)');
    expect(out).not.toContain('(was complete) —');
  });

  it('says "first stamp" for a null previous_arm — never "unclassifiable"', async () => {
    // The boundary lawfully admits a null first-stamp on ANY already-terminal unstamped record,
    // including ones whose prose classifies perfectly well. Calling it unclassifiable would be a
    // claim wider than the condition that produced it.
    const out = await render({
      ...RULED,
      adjudicated: { ...RULED.adjudicated, previous_arm: null },
    });
    expect(out).toContain(
      'Ruled: mihai at 2026-08-21T00:00:00.000Z (first stamp — no prior arm existed)',
    );
    expect(out).not.toContain('unclassifiable');
  });

  it('marks a classifier-recovered seal, after the step and before any ruling', async () => {
    const out = await render({ arm: 'guard_abort', step: 'g', classified: true });
    expect(out).toContain('Sealed by: guard_abort (g) (recovered by classifier)');
  });

  it('renders NEITHER marker when the seal carries no ruling and no classifier flag', async () => {
    // The control for "additive-only": a plain seal renders exactly what it rendered before PR-5.
    const out = await render({ arm: 'guard_abort', step: 'g' });
    expect(out).toContain('Sealed by: guard_abort (g)');
    expect(out).not.toContain('Ruled:');
    expect(out).not.toContain('recovered by classifier');
  });

  it('renders a ruling on an unrecognised arm — the ruling is data here, never re-validated', async () => {
    // The two fallbacks compose: inspect must not swallow a ruling just because it cannot name the
    // arm the ruling produced.
    const out = await render({
      arm: 'from_the_future',
      adjudicated: RULED.adjudicated,
    } as unknown as NonNullable<RunRecord['sealed_by']>);
    expect(out).toContain("unrecognized arm 'from_the_future'");
    expect(out).toContain('Ruled: mihai at 2026-08-21T00:00:00.000Z (was complete)');
  });
});

describe('inspectRun', () => {
  it('shows run ID, workflow ID, state, and evidence steps for a completed run', async () => {
    const run = makeRun([makeSnapshot('step_one')]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('Run: run_test1');
    expect(result).toContain('test-workflow');
    expect(result).toContain('completed');
    expect(result).toContain('step_one');
    expect(result).toContain('Evidence (1 steps)');
  });

  it('shows retry attempts grouped when a step has multiple evidence snapshots with attempt', async () => {
    const snap1 = makeSnapshot('step_one', { attempt: 1, status: 'error' });
    const snap2 = makeSnapshot('step_one', { attempt: 2, status: 'success' });
    const run = makeRun([snap1, snap2]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('(attempt 1/2)');
    expect(result).toContain('(attempt 2/2)');
  });

  it('shows diagnostics line when diagnostics is present on a snapshot', async () => {
    const diag: StepDiagnostics = {
      input_token_estimate: 32,
      precondition_trace: [],
    };
    const snap = makeSnapshot('step_one', { diagnostics: diag });
    const run = makeRun([snap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('Diagnostics:');
    expect(result).toContain('~32 tokens');
    expect(result).toContain('no preconditions');
  });

  it('handles missing workflow definition gracefully (warning line, no crash)', async () => {
    const run = makeRun([makeSnapshot('step_one')]);
    const workflowStore = makeWorkflowStore(); // no def — will throw
    const result = await inspectRun('run_test1', makeRunStore(run), workflowStore);
    expect(result).toContain('workflow definition not found');
    expect(result).toContain('step_one');
    expect(result).toContain('Evidence (1 steps)');
  });

  it('surfaces gate_message on gate_response evidence entries', async () => {
    const snap = makeSnapshot('confirm_update', {
      kind: 'gate_response',
      gate_message: 'Confirm update',
      input_summary: { choice: 'send' },
      output_summary: { draft: 'hello', choice: 'send' },
    });
    const run = makeRun([snap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('Message:  "Confirm update"');
    expect(result).toContain('Choice:   send');
    expect(result).toContain('gate_response');
  });

  it('omits Message: line when gate_message is absent on a gate_response entry', async () => {
    const snap = makeSnapshot('confirm_update', {
      kind: 'gate_response',
      input_summary: { choice: 'reject' },
      output_summary: { draft: 'hello', choice: 'reject' },
    });
    const run = makeRun([snap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).not.toContain('Message:');
    expect(result).toContain('Choice:   reject');
    expect(result).toContain('gate_response');
  });

  it('renders tool_calls summary line for each call when tool_calls is present', async () => {
    const snap = makeSnapshot('research', {
      tool_calls: [
        {
          tool: 'get_pull_request',
          server_id: 'github',
          args: { pr: 42 },
          result: 'PR body',
          duration_ms: 87,
        },
      ],
    });
    const run = makeRun([snap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('[github:get_pull_request]  87ms');
    expect(result).toContain('Tool calls (1)');
  });

  it('renders verbose tool args and result when verbose is true', async () => {
    const snap = makeSnapshot('research', {
      tool_calls: [
        {
          tool: 'get_pull_request',
          server_id: 'github',
          args: { pr: 42 },
          result: '{"title":"Fix bug"}',
          duration_ms: 87,
        },
      ],
    });
    const run = makeRun([snap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef), {
      verbose: true,
    });
    expect(result).toContain('args:');
    expect(result).toContain('result:');
    expect(result).toContain('{"title":"Fix bug"}');
  });

  it('omits args and result when verbose is false (default)', async () => {
    const snap = makeSnapshot('research', {
      tool_calls: [
        {
          tool: 'get_pull_request',
          server_id: 'github',
          args: { pr: 42 },
          result: '{"title":"Fix bug"}',
          duration_ms: 50,
        },
      ],
    });
    const run = makeRun([snap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).not.toContain('args:');
    expect(result).not.toContain('result:');
  });

  it('renders "Tools declared, none called" when tool_calls is an empty array', async () => {
    const snap = makeSnapshot('research', { tool_calls: [] });
    const run = makeRun([snap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('Tools declared, none called');
  });

  it('renders nothing for tool_calls when tool_calls is absent (old evidence records)', async () => {
    const snap = makeSnapshot('research'); // no tool_calls field
    const run = makeRun([snap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).not.toContain('Tool calls');
    expect(result).not.toContain('Tools declared');
    expect(result).toContain('research');
  });

  it('renders trace summary line when trace is present on evidence snapshot', async () => {
    const snap = makeSnapshot('research', {
      trace: [
        { seq: 1, event: 'search_called', data: { query: 'hello' } },
        { seq: 2, event: 'search_returned', data: { count: 3 } },
      ],
      trace_digest: 'abc123',
      trace_summary: {
        submitted_entries: 2,
        stored_entries: 2,
        discarded_entries: 0,
        discarded_reserved_event_entries: 0,
        discarded_overflow_entries: 0,
        truncated: false,
      },
    });
    const run = makeRun([snap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('Trace:  2 entries (not hashed).');
    expect(result).not.toContain('⚠ Trace truncated');
  });

  it('renders truncation warning when trace_summary.truncated is true', async () => {
    const snap = makeSnapshot('research', {
      trace: Array.from({ length: 101 }, (_, i) => ({ seq: i + 1, event: `ev_${i}` })),
      trace_digest: 'def456',
      trace_summary: {
        submitted_entries: 107,
        stored_entries: 101,
        discarded_entries: 7, // 2 reserved + 5 overflow
        discarded_reserved_event_entries: 2,
        discarded_overflow_entries: 5,
        truncated: true,
        truncation_reason: 'count_limit' as const,
      },
    });
    const run = makeRun([snap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('Trace:  101 entries (not hashed).');
    // Warning must report total discarded (7), not overflow-only (5).
    expect(result).toContain('⚠ Trace truncated (count_limit): 101 stored, 7 discarded.');
    expect(result).not.toContain('5 discarded');
  });

  // ─── run-level trace aggregation (A2) ──────────────────────────────────

  it('run-level trace summary appears when at least one step has a trace', async () => {
    const snap1 = makeSnapshot('step_a', {
      trace: [
        { seq: 1, event: 'read_file' },
        { seq: 2, event: 'read_file' },
        { seq: 3, event: 'write_result' },
      ],
      trace_summary: {
        submitted_entries: 3,
        stored_entries: 3,
        discarded_entries: 0,
        discarded_reserved_event_entries: 0,
        discarded_overflow_entries: 0,
        truncated: false,
      },
    });
    const snap2 = makeSnapshot('step_b', {
      trace: [{ seq: 1, event: 'read_file' }],
      trace_summary: {
        submitted_entries: 1,
        stored_entries: 1,
        discarded_entries: 0,
        discarded_reserved_event_entries: 0,
        discarded_overflow_entries: 0,
        truncated: false,
      },
    });
    const run = makeRun([snap1, snap2]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));

    expect(result).toContain('Trace Summary:');
    expect(result).toContain('steps_with_trace:        2');
    expect(result).toContain('steps_with_trace_unique: 2');
    expect(result).toContain('stored_entries_total:   4');
    expect(result).toContain('discarded_entries_total:0');
    expect(result).toContain('truncated_steps:        0');
    expect(result).toContain('top_events:');
    // read_file appears 3 times, write_result once — read_file should be first
    expect(result).toContain('read_file (3)');
    expect(result).toContain('write_result (1)');
  });

  it('run-level trace summary: top_events excludes trace.truncated sentinel', async () => {
    const snap = makeSnapshot('step_a', {
      trace: [
        { seq: 1, event: 'my_event' },
        { seq: 2, event: 'trace.truncated', data: { reason: 'count_limit' } },
      ],
      trace_summary: {
        submitted_entries: 110,
        stored_entries: 2,
        discarded_entries: 9,
        discarded_reserved_event_entries: 0,
        discarded_overflow_entries: 9,
        truncated: true,
        truncation_reason: 'count_limit' as const,
      },
    });
    const run = makeRun([snap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));

    expect(result).toContain('Trace Summary:');
    expect(result).toContain('top_events:');
    expect(result).toContain('my_event (1)');
    // Sentinel must not appear in top_events
    expect(result).not.toContain('trace.truncated (');
  });

  it('run-level trace summary: truncated_steps counts correctly', async () => {
    const truncatedSnap = makeSnapshot('step_a', {
      trace: [{ seq: 1, event: 'ev' }],
      trace_summary: {
        submitted_entries: 105,
        stored_entries: 1,
        discarded_entries: 4,
        discarded_reserved_event_entries: 0,
        discarded_overflow_entries: 4,
        truncated: true,
        truncation_reason: 'count_limit' as const,
      },
    });
    const normalSnap = makeSnapshot('step_b', {
      trace: [{ seq: 1, event: 'ok_event' }],
      trace_summary: {
        submitted_entries: 1,
        stored_entries: 1,
        discarded_entries: 0,
        discarded_reserved_event_entries: 0,
        discarded_overflow_entries: 0,
        truncated: false,
      },
    });
    const run = makeRun([truncatedSnap, normalSnap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));

    expect(result).toContain('truncated_steps:        1');
  });

  it('run-level trace summary is absent when no step has a trace', async () => {
    const snap = makeSnapshot('step_one'); // no trace field
    const run = makeRun([snap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));

    expect(result).not.toContain('Trace Summary:');
  });

  it('run-level trace summary: top_events shows at most 5 events', async () => {
    const trace = Array.from({ length: 10 }, (_, i) => ({
      seq: i + 1,
      event: `event_${i}`,
    }));
    const snap = makeSnapshot('step_a', {
      trace,
      trace_summary: {
        submitted_entries: 10,
        stored_entries: 10,
        discarded_entries: 0,
        discarded_reserved_event_entries: 0,
        discarded_overflow_entries: 0,
        truncated: false,
      },
    });
    const run = makeRun([snap]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));

    // Count how many "event_N (1)" entries appear in the top_events line
    const match = result.match(/top_events:\s+(.+)/);
    expect(match).not.toBeNull();
    const topEventsLine = match![1]!;
    const count = (topEventsLine.match(/\(\d+\)/g) ?? []).length;
    expect(count).toBeLessThanOrEqual(5);
  });

  it('run-level trace summary: steps_with_trace counts snapshots, steps_with_trace_unique counts distinct step IDs', async () => {
    const traceSummaryBase = {
      submitted_entries: 1,
      stored_entries: 1,
      discarded_entries: 0,
      discarded_reserved_event_entries: 0,
      discarded_overflow_entries: 0,
      truncated: false,
    };
    // step_a appears twice (retry scenario), step_b appears once — 3 snapshots, 2 distinct steps
    const snap1 = makeSnapshot('step_a', {
      trace: [{ seq: 1, event: 'tool_call' }],
      trace_summary: traceSummaryBase,
      attempt: 1,
    });
    const snap2 = makeSnapshot('step_a', {
      trace: [{ seq: 1, event: 'tool_call' }],
      trace_summary: traceSummaryBase,
      attempt: 2,
    });
    const snap3 = makeSnapshot('step_b', {
      trace: [{ seq: 1, event: 'search' }],
      trace_summary: traceSummaryBase,
    });
    const run = makeRun([snap1, snap2, snap3]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));

    expect(result).toContain('Trace Summary:');
    expect(result).toContain('steps_with_trace:        3');
    expect(result).toContain('steps_with_trace_unique: 2');
  });
});

describe('inspectRun — extension identity (drift evidence)', () => {
  it('renders the identity history with the exact coverage sentence, flags, and signals', async () => {
    const entry: ExtensionIdentityEntry = {
      captured_at: '2026-07-05T10:00:00.000Z',
      pid: 777,
      modules: [
        {
          declared: '../../dist/registry.js',
          resolved: '/proj/dist/registry.js',
          entry_hash: 'aa11bb22',
          format: 'esm',
        },
      ],
      tree: {
        roots: ['/proj/dist'],
        rules: 'dir_tree_v1: test-rules',
        file_count: 3,
        total_bytes: 999,
        tree_hash: 'cc33dd44',
        truncated: false,
      },
      signals: { package_version: '2.0.0', git_head: 'feedface' },
      coverage: 'dir_tree_v1',
    };
    const overrideErrorEntry: ExtensionIdentityEntry = {
      captured_at: '2026-07-05T11:00:00.000Z',
      modules: [],
      tree: {
        roots: [],
        rules: 'dir_tree_v1: test-rules',
        file_count: 0,
        total_bytes: 0,
        tree_hash: '',
        truncated: false,
      },
      coverage: 'dir_tree_v1',
      override_active: true,
      error: 'extension load failed: boom',
    };
    const run = makeRun([], { extension_identity: [entry, overrideErrorEntry] });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));

    expect(result).toContain('Extension Identity (2 entries):');
    expect(result).toContain('captured 2026-07-05T10:00:00.000Z (pid 777)');
    expect(result).toContain('module: ../../dist/registry.js -> /proj/dist/registry.js (esm)');
    expect(result).toContain('entry_hash aa11bb22');
    expect(result).toContain('tree: 3 files, 999 bytes');
    expect(result).toContain('tree_hash cc33dd44');
    expect(result).toContain('signals: package_version 2.0.0, git_head feedface');
    // The fixed coverage sentence, exact:
    expect(result).toContain(
      'covers files under /proj/dist matching dir_tree_v1: test-rules; imports outside these roots, node_modules, and runtime dynamic imports are NOT covered.',
    );
    expect(result).toContain('[override]');
    expect(result).toContain('[error]');
    expect(result).toContain('error: extension load failed: boom');
  });

  it('renders nothing extra for runs without identity history', async () => {
    const run = makeRun([]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).not.toContain('Extension Identity');
  });

  it('--check-drift recomputes the LAST entry against current disk: same, then DIFFERS after edit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-inspect-drift-'));
    try {
      const entryFile = join(dir, 'registry.js');
      writeFileSync(entryFile, 'export default {};', 'utf8');
      writeFileSync(join(dir, 'helper.js'), 'export const x = 1;', 'utf8');
      const identity = computeExtensionIdentity([
        { declared: './registry.js', resolved: entryFile, format: 'esm' },
      ]);
      const run = makeRun([], { extension_identity: [identity] });

      const same = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef), {
        checkDrift: true,
      });
      expect(same).toContain('Drift check');
      expect(same).toContain(`module ${entryFile}: same`);
      expect(same).toContain('tree: same');

      writeFileSync(join(dir, 'helper.js'), 'export const x = 2;', 'utf8');
      const treeDrift = await inspectRun(
        'run_test1',
        makeRunStore(run),
        makeWorkflowStore(basicDef),
        { checkDrift: true },
      );
      expect(treeDrift).toContain(`module ${entryFile}: same`);
      expect(treeDrift).toContain('tree: DIFFERS');

      rmSync(entryFile);
      const missing = await inspectRun(
        'run_test1',
        makeRunStore(run),
        makeWorkflowStore(basicDef),
        { checkDrift: true },
      );
      expect(missing).toContain(`module ${entryFile}: MISSING`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--check-drift on an unknown rules version prints the explicit cannot-compare', async () => {
    const entry: ExtensionIdentityEntry = {
      captured_at: '2026-07-05T10:00:00.000Z',
      modules: [],
      tree: {
        roots: [],
        rules: 'dir_tree_v9: future',
        file_count: 0,
        total_bytes: 0,
        tree_hash: 'x',
        truncated: false,
      },
      coverage: 'dir_tree_v1',
    };
    const run = makeRun([], { extension_identity: [entry] });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef), {
      checkDrift: true,
    });
    expect(result).toContain("cannot compare (unknown rules 'dir_tree_v9: future')");
  });

  it('--check-drift with no recorded identity says so', async () => {
    const run = makeRun([]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef), {
      checkDrift: true,
    });
    expect(result).toContain('no extension identity recorded for this run');
  });
});

describe('--check-drift manifest hash (v0.14 hardening)', () => {
  it('same / DIFFERS / MISSING for the recorded manifest; line omitted when no manifest was recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-inspect-manifest-'));
    try {
      const entryFile = join(dir, 'registry.js');
      writeFileSync(entryFile, 'export default {};', 'utf8');
      const manifestPath = join(dir, 'realm.yaml');
      writeFileSync(manifestPath, 'version: 1\n', 'utf8');
      const identity = computeExtensionIdentity(
        [{ declared: './registry.js', resolved: entryFile, format: 'esm' }],
        {
          manifest: {
            path: manifestPath,
            content_hash: sha256HexOf(readFileSync(manifestPath)),
          },
        },
      );
      const run = makeRun([], { extension_identity: [identity] });

      const same = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef), {
        checkDrift: true,
      });
      expect(same).toContain(`manifest ${manifestPath}: same`);

      writeFileSync(manifestPath, 'version: 1\nadapters: {}\n', 'utf8');
      const differs = await inspectRun(
        'run_test1',
        makeRunStore(run),
        makeWorkflowStore(basicDef),
        { checkDrift: true },
      );
      expect(differs).toContain(`manifest ${manifestPath}: DIFFERS (recorded `);

      rmSync(manifestPath);
      const missing = await inspectRun(
        'run_test1',
        makeRunStore(run),
        makeWorkflowStore(basicDef),
        { checkDrift: true },
      );
      expect(missing).toContain(`manifest ${manifestPath}: MISSING`);

      // Older entries without a recorded manifest → no manifest line at all.
      const legacyIdentity = computeExtensionIdentity([
        { declared: './registry.js', resolved: entryFile, format: 'esm' },
      ]);
      const legacyRun = makeRun([], { extension_identity: [legacyIdentity] });
      const legacy = await inspectRun(
        'run_test1',
        makeRunStore(legacyRun),
        makeWorkflowStore(basicDef),
        { checkDrift: true },
      );
      expect(legacy).not.toContain('manifest ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('inspectRun — skip_details surfacing (issue #111)', () => {
  it('renders a when_false reason inline for a skipped step', async () => {
    const run = makeRun([], {
      skipped_steps: ['route_billing'],
      skip_details: {
        route_billing: {
          kind: 'when_false',
          expression: 'classify.category == billing',
          leaves: [
            {
              leaf: 'classify.category == billing',
              lhs_present: true,
              resolved_value: 'bug',
              passed: false,
            },
          ],
        },
      },
    });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('Skipped: route_billing');
    expect(result).toContain(
      'route_billing: when_false: classify.category == billing [lhs → "bug"]',
    );
  });

  it('renders a trigger_rule_unsatisfiable reason inline for a skipped step', async () => {
    const run = makeRun([], {
      skipped_steps: ['b'],
      skip_details: {
        b: {
          kind: 'trigger_rule_unsatisfiable',
          rule: 'all_success',
          blocking_deps: [{ dep: 'a', state: 'failed' }],
        },
      },
    });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('b: trigger_rule_unsatisfiable: all_success, dep a failed');
  });

  it('renders "skipped (reason unavailable)" for a skipped step with no detail (legacy run)', async () => {
    const run = makeRun([], { skipped_steps: ['legacy_step'] }); // no skip_details at all
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('legacy_step: skipped (reason unavailable)');
  });

  it('renders nothing extra when there are no skipped steps', async () => {
    const run = makeRun([]);
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('Skipped: (none)');
    expect(result).not.toContain('reason unavailable');
  });
});

describe('run_health rendering (issue #221)', () => {
  it('renders a run_health finding after the Updated line', async () => {
    const run = makeRun([], {
      run_phase: 'running',
      terminal_state: false,
      in_progress_steps: ['step_a'],
      claims: { step_a: { deadline: new Date(Date.now() - 60_000).toISOString() } },
    });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    const updatedIdx = result.indexOf('Updated:');
    const runHealthIdx = result.indexOf('Run Health');
    expect(updatedIdx).toBeGreaterThan(-1);
    expect(runHealthIdx).toBeGreaterThan(updatedIdx); // renders AFTER the Updated line
    expect(result).toContain('stale_claim');
    expect(result).toContain('[step_a]');
  });

  it('tolerates a missing workflow definition when rendering run_health', async () => {
    const run = makeRun([], {
      run_phase: 'running',
      terminal_state: false,
      in_progress_steps: ['step_a'],
      claims: { step_a: { deadline: new Date(Date.now() - 60_000).toISOString() } },
    });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(undefined));
    expect(result).toContain('workflow definition not found');
    expect(result).toContain('Run Health');
    expect(result).toContain('stale_claim');
  });

  it('renders nothing extra when there are no run_health findings', async () => {
    const run = makeRun([], { run_phase: 'completed', terminal_state: true });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).not.toContain('Run Health');
  });

  // issue #221 correction — novel probe N1 (threshold-coherence, S1): inspect takes NO
  // idleThresholdMs override by design (agents don't tune detectors). inspect's fixtures above are
  // all stale_claim (no idle_threshold_ms in their evidence at all), so the object-shaped pin
  // get-run-state-run-health.test.ts uses is unconstructible here — a source-text pin plus a
  // behavioral bracket around the DEFAULT threshold is the honest substitute.
  it('source-text pin: inspect.ts never references idleThresholdMs (no override by design)', () => {
    const source = readFileSync(fileURLToPath(new URL('./inspect.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('idleThresholdMs');
  });

  it('behavioral bracket: a claimless running run idle 2h holds (no Run Health); idle 25h fires (never_claimed_idle)', async () => {
    const young = makeRun([], {
      run_phase: 'running',
      terminal_state: false,
      in_progress_steps: [],
      updated_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    const youngResult = await inspectRun(
      'run_test1',
      makeRunStore(young),
      makeWorkflowStore(basicDef),
    );
    expect(youngResult).not.toContain('Run Health');

    const old = makeRun([], {
      run_phase: 'running',
      terminal_state: false,
      in_progress_steps: [],
      updated_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
    });
    const oldResult = await inspectRun('run_test1', makeRunStore(old), makeWorkflowStore(basicDef));
    expect(oldResult).toContain('never_claimed_idle');
  });

  it('never_claimed_idle appends the humanized idle duration (issue #221 correction — the reason text no longer dead-ends "…, idle" with nothing after it)', async () => {
    const run = makeRun([], {
      run_phase: 'running',
      terminal_state: false,
      in_progress_steps: [],
      updated_at: new Date(Date.now() - (25 * 60 + 5) * 60_000).toISOString(), // 25h 5m ago
    });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    // formatGateAge renders 25h5m-ago as "1d 1h" — the reason text must not just say "idle" bare.
    expect(result).toContain('parked with no claimed step, idle 1d 1h');
    expect(result).not.toContain('idle\n'); // never a bare dead-end
  });
});

describe('defaulted-steps rendering (issue #232)', () => {
  function defaultSettledSnapshot(stepId: string): EvidenceSnapshot {
    return makeSnapshot(stepId, {
      diagnostics: { input_token_estimate: 1, precondition_trace: [], settled_by_default: true },
    });
  }

  it('AC-1 failure path: a FAILED run that default-settled a step earlier ⇒ shows the Defaulted line, grouped right after Skipped', async () => {
    const run = makeRun(
      [defaultSettledSnapshot('draft'), makeSnapshot('finish', { status: 'error' })],
      { run_phase: 'failed', failed_steps: ['finish'], terminal_state: true },
    );
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('Defaulted (settled by default): draft');
    const skippedIdx = result.indexOf('Skipped:');
    const defaultedIdx = result.indexOf('Defaulted (settled by default)');
    const createdIdx = result.indexOf('Created:');
    expect(skippedIdx).toBeGreaterThan(-1);
    expect(defaultedIdx).toBeGreaterThan(skippedIdx); // grouped right after the Skipped block
    expect(defaultedIdx).toBeLessThan(createdIdx);
  });

  it('AC-1 abort path: an ABORTED run that default-settled a step earlier ⇒ shows the Defaulted line', async () => {
    const run = makeRun([defaultSettledSnapshot('draft')], {
      run_phase: 'aborted',
      terminal_state: true,
    });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('Defaulted (settled by default): draft');
  });

  it('multi-default and dedup: joins distinct step names, comma-separated, first-occurrence order', async () => {
    const run = makeRun(
      [
        defaultSettledSnapshot('first'),
        makeSnapshot('untouched'),
        defaultSettledSnapshot('second'),
        defaultSettledSnapshot('first'), // duplicate step_id — must not double-list
      ],
      { run_phase: 'failed', terminal_state: true },
    );
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).toContain('Defaulted (settled by default): first, second');
  });

  it('AC-3 negative: renders nothing extra when there are no default-settled steps', async () => {
    const run = makeRun([makeSnapshot('draft')], { run_phase: 'completed', terminal_state: true });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).not.toContain('Defaulted');
  });

  it('AC-3 negative, empty evidence: renders nothing extra', async () => {
    const run = makeRun([], { run_phase: 'completed', terminal_state: true });
    const result = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(result).not.toContain('Defaulted');
  });
});
