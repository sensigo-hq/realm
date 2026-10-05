// get-run-state-steps.test.ts — issue #600 PR 1b (D7): `include_steps`'s own behaviour on
// `get_run_state` — the opt-in gate, the isolation from the status path, and the two populations
// (a live run, a terminal run) that reach the view through different definition sources.
import { declared } from '../test-support/declared.js';
import { describe, it, expect } from 'vitest';
import { WorkflowError } from '@sensigo/realm';
import type {
  RunRecord,
  RunStore,
  WorkflowRegistrar,
  WorkflowDefinition,
  JsonWorkflowStore,
} from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';

function makeStore(run: RunRecord): RunStore {
  return declared({
    persistsClaims: true,
    get: async () => run,
    create: async () => {
      throw new Error('not exercised');
    },
    update: async () => {
      throw new Error('not exercised');
    },
    list: async () => {
      throw new Error('not exercised');
    },
    claimStep: async () => {
      throw new Error('not exercised');
    },
  } as unknown as RunStore);
}

function makeBase(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 1,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    ...overrides,
  } as unknown as RunRecord;
}

// `HandleRunStateStores.workflowStore` is typed as the CONCRETE `JsonWorkflowStore` class, which
// (via private fields) is nominal — a structural fake needs the cast every other call site in this
// file also uses, matching the house convention for a `WorkflowRegistrar`-shaped double.
const notFound = (): JsonWorkflowStore =>
  declared({
    register: async () => {},
    list: async () => [],
    get: async () => {
      throw new WorkflowError('Workflow not found: wf', {
        code: 'STATE_WORKFLOW_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    },
  } as unknown as JsonWorkflowStore);

function makeCountingWorkflowStore(): { store: JsonWorkflowStore; calls: () => number } {
  let n = 0;
  const store: WorkflowRegistrar = declared({
    register: async () => {},
    list: async () => [],
    get: async () => {
      n += 1;
      throw new WorkflowError('Workflow not found: wf', {
        code: 'STATE_WORKFLOW_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    },
  });
  return { store: store as unknown as JsonWorkflowStore, calls: () => n };
}

const agentEntry = {
  step_id: 'agent_step',
  status: 'success' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  duration_ms: 1,
  input_summary: {},
  output_summary: {},
  evidence_hash: 'h',
  agent_profile: 'reviewer',
  diagnostics: { input_token_estimate: 1, precondition_trace: [] },
};

describe('#600 PR 1b (D7) — get_run_state include_steps', () => {
  it('default response has no steps or drive_failure_costs keys', async () => {
    const run = makeBase({
      evidence: [agentEntry],
      drive_failures: {
        first_failed_at: 'x',
        total: 1,
        entries: [
          { at: 'x', step: 's', provider: 'a', error_class: 'other', message: 'm', elapsed_ms: 1 },
        ],
      },
    } as never);
    const summary = await handleGetRunState(
      { run_id: 'r1' },
      { runStore: makeStore(run), workflowStore: notFound() },
    );
    expect('steps' in summary).toBe(false);
    expect('drive_failure_costs' in summary).toBe(false);
  });

  it("each drive_failure_costs element carries the entry's error_class", async () => {
    const run = makeBase({
      drive_failures: {
        first_failed_at: 'x',
        total: 1,
        entries: [
          {
            at: 'x',
            step: 's',
            provider: 'a',
            error_class: 'connection_timeout',
            message: 'm',
            elapsed_ms: 1,
            usage: [{ request_index: 0, request_start: 'x', prompt_tokens: 5 }],
          },
        ],
      },
    } as never);
    const summary = await handleGetRunState(
      { run_id: 'r1', include_steps: true },
      { runStore: makeStore(run), workflowStore: notFound() },
    );
    expect(summary.drive_failure_costs![0]!.error_class).toBe('connection_timeout');
  });

  it('a LIVE non-gate run whose status-path resolution FAILED: the view never retries the registrar, and an agent step still classifies via agent_profile', async () => {
    const { store, calls } = makeCountingWorkflowStore();
    const run = makeBase({ evidence: [agentEntry] });
    const summary = await handleGetRunState(
      { run_id: 'r1', include_steps: true },
      { runStore: makeStore(run), workflowStore: store },
    );
    // The status path's OWN call already failed and set definitionError — the view must not call
    // the registrar a second time.
    expect(calls()).toBe(1);
    expect(summary.steps!['agent_step']!.attempts[0]!.cost_unrecorded).toBe(
      'not_measured_by_realm',
    );
    // And the status-path failure is untouched by the view's existence.
    expect(summary.next_actions_status).toBe('workflow_unresolved');
  });

  it("include_steps on a LIVE run: the view reuses the status path's OWN resolved definition", async () => {
    const definition: WorkflowDefinition = {
      id: 'wf',
      name: 'wf',
      version: 1,
      steps: { auto_step: { description: 'x', execution: 'auto' } },
    } as WorkflowDefinition;
    const workflowStore = declared({
      register: async () => {},
      list: async () => [definition],
      get: async () => definition,
    } as unknown as JsonWorkflowStore);
    const run = makeBase({
      evidence: [
        {
          step_id: 'auto_step',
          status: 'success',
          started_at: 'x',
          completed_at: 'y',
          duration_ms: 1,
          input_summary: {},
          output_summary: {},
          evidence_hash: 'h',
          diagnostics: {
            input_token_estimate: 1,
            precondition_trace: [],
            cache: {
              state: 'engaged',
              basis: 'provider_reported',
              requests: [{ request_index: 0, request_start: 'x', prompt_tokens: 42 }],
            },
          },
        },
      ] as never,
    });
    const summary = await handleGetRunState(
      { run_id: 'r1', include_steps: true },
      { runStore: makeStore(run), workflowStore },
    );
    expect(summary.steps!['auto_step']!.attempts[0]!.cost!.prompt!.value).toBe(42);
  });

  it('include_steps on a TERMINAL run: the status path never resolved a definition, so the view resolves its OWN, via terminalOk', async () => {
    const definition: WorkflowDefinition = {
      id: 'wf',
      name: 'wf',
      version: 1,
      steps: { agent_step: { description: 'x', execution: 'agent' } },
    } as WorkflowDefinition;
    const workflowStore = declared({
      register: async () => {},
      list: async () => [definition],
      get: async () => definition,
    } as unknown as JsonWorkflowStore);
    const run = makeBase({
      terminal_state: true,
      run_phase: 'completed',
      evidence: [
        {
          step_id: 'agent_step',
          status: 'success',
          started_at: 'x',
          completed_at: 'y',
          duration_ms: 1,
          input_summary: {},
          output_summary: {},
          evidence_hash: 'h',
          diagnostics: { input_token_estimate: 1, precondition_trace: [] },
        },
      ] as never,
    });
    // On a terminal run the status path's `if (run.terminal_state)` branch returns immediately,
    // never calling getWorkflowForRun at all — so `definition` is undefined going into the view.
    const summary = await handleGetRunState(
      { run_id: 'r1', include_steps: true },
      { runStore: makeStore(run), workflowStore },
    );
    expect(summary.steps!['agent_step']!.attempts[0]!.cost_unrecorded).toBe(
      'not_measured_by_realm',
    );
    // Without a definition the step is classified via `agent_profile` (absent here) OR, since the
    // definition names it 'agent', via the definition — proving the view's OWN terminalOk call
    // reached the SAME registrar entry the status path (skipped_terminal) never touched.
  });

  it('a definition-resolution failure under include_steps, on a GATE-WAITING run, leaves run_health and next_actions_status IDENTICAL to the same call without include_steps', async () => {
    const run = makeBase({
      pending_gate: {
        step_name: 'g',
        gate_id: 'gate-1',
        choices: ['yes', 'no'],
        opened_at: '2026-01-01T00:00:00.000Z',
      },
    } as never);
    const without = await handleGetRunState(
      { run_id: 'r1' },
      { runStore: makeStore(run), workflowStore: notFound() },
    );
    const withView = await handleGetRunState(
      { run_id: 'r1', include_steps: true },
      { runStore: makeStore(run), workflowStore: notFound() },
    );
    expect(withView.run_health).toEqual(without.run_health);
    expect(withView.next_actions_status).toBe(without.next_actions_status);
    expect(withView.next_actions_status).toBe('awaiting_human');
    // The view's own failure is silent — no steps key at all (no evidence in this fixture, so
    // composeStepViews returns {} regardless; the isolation is what this cell actually pins).
    expect('steps' in withView).toBe(false);
  });
});
