// get-run-state-steps.test.ts — issue #600 PR 1b (D7): `include_steps`'s own behaviour on
// `get_run_state` — the opt-in gate, the isolation from the status path, and the two populations
// (a live run, a terminal run) that reach the view through different definition sources.
import { declared } from '../test-support/declared.js';
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JsonFileStore, WorkflowError } from '@sensigo/realm';
import type {
  RunRecord,
  RunStore,
  WorkflowRegistrar,
  WorkflowDefinition,
  JsonWorkflowStore,
} from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';
import { loadPriceSource } from '../price-source.js';
import { createRealmMcpServer } from '../server.js';

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

// issue #600 caching PR P (G12): `get_run_state` carries what `realm run inspect` prints — the money
// per attempt, the endpoints, a step's total across its attempts and the run's cost — unrounded.
// On a failing CI host each cell prints the reply's money: causes, source names and test figures.
describe('#600 caching PR P (G12) — get_run_state money', () => {
  const definition: WorkflowDefinition = {
    id: 'wf',
    name: 'wf',
    version: 1,
    steps: { auto_step: { description: 'x', execution: 'auto' } },
  } as WorkflowDefinition;
  const workflowStore = (): JsonWorkflowStore =>
    declared({
      register: async () => {},
      list: async () => [definition],
      get: async () => definition,
    } as unknown as JsonWorkflowStore);
  const attempt = (
    status: 'error' | 'success',
    request: Record<string, unknown>,
  ): Record<string, unknown> => ({
    step_id: 'auto_step',
    status,
    started_at: '2026-10-01T00:00:00.000Z',
    completed_at: '2026-10-01T00:00:01.000Z',
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
        requests: [{ request_index: 0, request_start: '2026-10-01T00:00:00.000Z', ...request }],
      },
    },
  });
  // Two attempts of one step on a custom endpoint: 12,345 prompt / 678 out, then 1,000 / 10.
  const run = (model = 'claude-x', extra: Record<string, unknown> = {}): RunRecord =>
    makeBase({
      evidence: [
        attempt('error', {
          model,
          prompt_tokens: 12345,
          output_tokens: 678,
          endpoint: 'custom',
          ...extra,
        }),
        attempt('success', { model, prompt_tokens: 1000, output_tokens: 10, ...extra }),
      ] as never,
    });
  const ECONOMICS = [
    'version: 1',
    'currency: USD',
    'models:',
    '  claude-x:',
    '    prices:',
    '      - per_million_tokens: { input: 3, output: 15 }',
    '',
  ].join('\n');
  const notInstalled = (): Promise<unknown> =>
    Promise.reject(Object.assign(new Error('not installed'), { code: 'ERR_MODULE_NOT_FOUND' }));

  // (a) red when the provider's source is not passed to the composers (no money, no total, no
  // run_cost); red when a figure is rounded (0.047205 would read 0.0472); (b) prints the figures.
  it('money, endpoints, a step total and run_cost through a real priceSourceProvider, unrounded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-g12-'));
    try {
      const economicsPath = join(dir, 'economics.yaml');
      writeFileSync(economicsPath, ECONOMICS, 'utf8');
      const summary = await handleGetRunState(
        { run_id: 'r1', include_steps: true },
        {
          runStore: makeStore(run()),
          workflowStore: workflowStore(),
          priceSourceProvider: () => loadPriceSource({ economicsPath, importList: notInstalled }),
        },
      );
      const view = summary.steps!['auto_step']!;
      const first = view.attempts[0]!.cost!;
      expect([
        first.money?.total,
        first.money?.uncached_counterfactual,
        first.money?.sources.map((s) => [s.source_class, s.source_ref, s.matched_model]),
        first.endpoints,
        view.total?.total,
        view.total?.priced,
        summary.run_cost?.total.total,
        summary.run_cost?.total.of,
        summary.run_cost?.unmeasured,
        summary.run_cost?.failed_drives_not_on_record,
      ]).toEqual([
        (12345 * 3 + 678 * 15) / 1e6,
        (12345 * 3 + 678 * 15) / 1e6,
        [['economics', economicsPath, 'claude-x']],
        { custom: 1, of: 1 },
        (12345 * 3 + 678 * 15) / 1e6 + (1000 * 3 + 10 * 15) / 1e6,
        2,
        (12345 * 3 + 678 * 15) / 1e6 + (1000 * 3 + 10 * 15) / 1e6,
        2,
        { tool_calling_step: 0, not_measured_by_realm: 0, cost_unreadable: 0 },
        0,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // (a) red when handleGetRunState defaults a source itself (the request is then priced); (b) prints
  // the money.
  it('handleGetRunState with no priceSourceProvider defaults nothing: every request is no_price_source', async () => {
    const summary = await handleGetRunState(
      { run_id: 'r1', include_steps: true },
      { runStore: makeStore(run()), workflowStore: workflowStore() },
    );
    const money = summary.steps!['auto_step']!.attempts[0]!.cost!.money;
    expect([money?.priced, money?.not_priced]).toEqual([
      0,
      [{ cause: 'no_price_source', count: 1 }],
    ]);
  });

  // (a) red when createRealmMcpServer passes no default (no_price_source), or the default carries
  // no note; (b) prints the reply's sources. The installed list (a devDependency here) prices
  // claude-sonnet-5-5.
  it("createRealmMcpServer with no provider: the installed list only, every figure saying 'no economics file is configured on this server'", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-g12-server-'));
    const record = run('claude-sonnet-5-5', { provider: 'anthropic' });
    writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record), 'utf8');
    const server = createRealmMcpServer({
      runStore: new JsonFileStore(dir),
      workflowStore: workflowStore(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'g12', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const raw = (await client.callTool({
        name: 'get_run_state',
        arguments: { run_id: 'r1', include_steps: true },
      })) as { content: Array<{ text: string }> };
      const reply = JSON.parse(raw.content[0]!.text) as {
        run_cost?: {
          total: {
            priced: number;
            of: number;
            sources: Array<Record<string, unknown>>;
            source_totals: Array<Record<string, unknown>>;
          };
        };
      };
      // The custom-endpoint attempt's figure also carries the list's endpoint note, so the one list
      // version reads as two sources and one source total.
      const note = 'no economics file is configured on this server';
      expect([
        reply.run_cost?.total.priced,
        reply.run_cost?.total.of,
        reply.run_cost?.total.sources.map((s) => [
          s['source_class'],
          s['version'],
          s['source_note'],
          s['endpoint_note'] ?? 'none',
        ]),
        reply.run_cost?.total.source_totals.map((t) => [t['version'], t['count']]),
      ]).toEqual([
        2,
        2,
        [
          ['price_list', '0.1.12', note, 'list price, your endpoint may bill differently'],
          ['price_list', '0.1.12', note, 'none'],
        ],
        [['0.1.12', 2]],
      ]);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
