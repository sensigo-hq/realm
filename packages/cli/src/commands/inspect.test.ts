// Tests for inspectRun business logic.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    get: async () => run,
    create: async () => run,
    update: async () => run,
    list: async () => [run],
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
          started_at: new Date().toISOString(),
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
          started_at: new Date().toISOString(),
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
          started_at: new Date().toISOString(),
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
