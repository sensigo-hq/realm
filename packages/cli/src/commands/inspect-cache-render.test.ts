// inspect-cache-render.test.ts — issue #600 PR 1a (D6): how StepDiagnostics.cache reads on
// `realm run inspect`, and (D2) that the render never assumes a fixed request count.
//
// Reuses the fixture shape from inspect.test.ts (makeSnapshot/makeRun/makeRunStore/
// makeWorkflowStore) locally, following this package's own convention (drive-failure-render.test.ts
// does the same beside drive-failure-disclosure-parity.test.ts rather than importing across test
// files).
import { describe, it, expect } from 'vitest';
import { inspectRun } from './inspect.js';
import type {
  RunStore,
  RunRecord,
  WorkflowRegistrar,
  WorkflowDefinition,
  EvidenceSnapshot,
  StepDiagnostics,
  UsageRecord,
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
  steps: { step_one: { description: 'First step', execution: 'agent' } },
};

const render = async (diag: StepDiagnostics): Promise<string> => {
  const run = makeRun([makeSnapshot('step_one', { diagnostics: diag })]);
  return inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
};

const req = (overrides: Partial<UsageRecord> = {}, index = 0): UsageRecord => ({
  request_index: index,
  request_start: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

describe('issue #600 PR 1a (D6) inspect — StepDiagnostics.cache, five branches', () => {
  it('cache ABSENT — no cache segment at all (no model call happened)', async () => {
    const out = await render({ input_token_estimate: 10, precondition_trace: [] });
    expect(out).not.toContain('cache:');
    expect(out).not.toContain('prompt tokens (measured');
  });

  it('unobservable, ZERO requests known — no request count is fabricated', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: { state: 'unobservable', basis: 'unobservable', requests: [] },
    });
    expect(out).toContain('cache: not reported by the provider');
    expect(out).not.toContain('(0 requests)');
  });

  it('unobservable, but a request WAS made — says so, with the honest count', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: { state: 'unobservable', basis: 'unobservable', requests: [req()] },
    });
    expect(out).toContain('cache: not reported by the provider (1 request)');
  });

  it('never_engaged — provenance from `basis`, never a hardcoded literal', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'never_engaged',
        basis: 'provider_reported',
        requests: [req({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })],
      },
    });
    expect(out).toContain('cache: not engaged, provider-reported 0 (1 request)');
  });

  it('write_only — read 0, wrote > 0, single request', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'write_only',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 1200, cache_creation_input_tokens: 1150 })],
      },
    });
    expect(out).toContain('cache: read 0, wrote 1150 (provider-reported, 1 request)');
    // No judgement — a write-only step is a fact, not an accusation (D6 rule 4).
    expect(out).not.toMatch(/wasted|unnecessary|should|inefficient/i);
  });

  it('engaged — read AND write both present', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [
          req({
            prompt_tokens: 1200,
            cache_read_input_tokens: 1150,
            cache_creation_input_tokens: 0,
          }),
        ],
      },
    });
    expect(out).toContain('cache: read 1150, wrote 0 (provider-reported, 1 request)');
  });

  it('the measured prompt size is LABELLED separately from the ~N-token estimate', async () => {
    const out = await render({
      input_token_estimate: 300,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 1200, cache_read_input_tokens: 1150 })],
      },
    });
    expect(out).toContain('~300 tokens (estimate)');
    expect(out).toContain('1200 prompt tokens (measured, first request)');
  });

  it("a WARM and a COLD call of the SAME prompt report the SAME measured number (D6's acceptance test)", async () => {
    const cold = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'write_only',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 1200, cache_creation_input_tokens: 1150 })],
      },
    });
    const warm = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 1200, cache_read_input_tokens: 1150 })],
      },
    });
    expect(cold).toContain('1200 prompt tokens (measured, first request)');
    expect(warm).toContain('1200 prompt tokens (measured, first request)');
    // The falsity this rejects: reading the provider's raw remainder term instead would report
    // 0 on the warm call beside a cache read of 1150 — the number would SHRINK as caching
    // succeeded. Both calls of the SAME prompt report 1200, unconditionally.
  });
});

describe("issue #600 PR 1a (D2) inspect — the render is COUNT-AGNOSTIC, never 'expect 2 or 3'", () => {
  it('FIVE requests: prompt from the FIRST only, counters SUMMED across all five, in wire order', async () => {
    const requests: UsageRecord[] = [
      req({ prompt_tokens: 1200, cache_creation_input_tokens: 1150 }, 0),
      req({ prompt_tokens: 1210, cache_read_input_tokens: 1150 }, 1),
      req({ prompt_tokens: 1210, cache_read_input_tokens: 1150 }, 2),
      req({ prompt_tokens: 1210, cache_write_tokens: 40 }, 3),
      req({ prompt_tokens: 1210, cache_read_input_tokens: 1190 }, 4),
    ];
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: { state: 'engaged', basis: 'provider_reported', requests },
    });
    expect(out).toContain('1200 prompt tokens (measured, first request)');
    // wrote = 1150 (request 0) + 40 (request 3) = 1190; read = 1150 + 1150 + 1190 = 3490.
    expect(out).toContain(
      'cache: read 3490, wrote 1190 (provider-reported, totals across 5 requests)',
    );
  });

  it('the same derivation over ONE request never says "totals across"', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 1200, cache_read_input_tokens: 1150 })],
      },
    });
    expect(out).toContain('(provider-reported, 1 request)');
    expect(out).not.toContain('totals across');
  });
});
