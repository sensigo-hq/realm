// inspect-cost-view.test.ts — issue #600 PR 1b (D7): the whole render surface this PR rewrote —
// the figure-form table on both contexts, #611's two new segments, every failure entry, the
// multi-attempt reshape keyed on execution-entry count, the absence sentences, `included in the
// prompt`'s truth rule, and the ONE composed view rendered identically on both surfaces.
import { declared } from '../test-support/declared.js';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { inspectRun } from './inspect.js';
import { handleGetRunState } from '@sensigo/realm-mcp/dist/tools/get-run-state.js';
import type {
  RunStore,
  RunRecord,
  WorkflowRegistrar,
  WorkflowDefinition,
  EvidenceSnapshot,
  StepDiagnostics,
  UsageRecord,
  DriveFailureRecord,
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
  return declared({
    persistsClaims: true,
    get: async () => run,
    create: async () => ({ run, created: true }),
    update: async () => run,
    list: async () => [run],
    claimStep: async () => {
      throw new Error('claimStep is not used by inspect');
    },
  });
}

function makeWorkflowStore(def?: WorkflowDefinition): WorkflowRegistrar {
  if (def !== undefined) {
    return declared({ register: async () => {}, get: async () => def, list: async () => [def] });
  }
  return declared({
    register: async () => {},
    get: async () => {
      throw new Error('Workflow not found');
    },
    list: async () => [],
  });
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

const renderFailure = async (
  usage: UsageRecord[] | undefined,
  errorClass: DriveFailureRecord['error_class'] = 'other',
): Promise<string> => {
  const entry: DriveFailureRecord = {
    at: '2024-01-01T00:04:00.000Z',
    step: 'step_one',
    provider: 'anthropic',
    error_class: errorClass,
    message: 'boom',
    elapsed_ms: 100,
    ...(usage !== undefined ? { usage } : {}),
  };
  const run = makeRun([], {
    terminal_state: false,
    run_phase: 'running',
    drive_failures: { first_failed_at: entry.at, total: 1, entries: [entry] },
  });
  return inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
};

const req = (overrides: Partial<UsageRecord> = {}, index = 0): UsageRecord => ({
  request_index: index,
  request_start: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

// =========================================================================================
// The figure-form table, both contexts.
// =========================================================================================
describe('#600 PR 1b — step-line prompt figure forms', () => {
  it.each<[string, UsageRecord[], string]>([
    ['single', [req({ prompt_tokens: 500 })], '500 prompt tokens (measured, first request)'],
    [
      'one-of-many',
      [req({}, 0), req({ prompt_tokens: 500 }, 1)],
      '500 prompt tokens (measured, request 2 of 2)',
    ],
    [
      'full',
      [req({ prompt_tokens: 200 }, 0), req({ prompt_tokens: 300 }, 1)],
      '500 prompt tokens (measured, totals across 2 requests)',
    ],
    [
      'partial',
      [req({ prompt_tokens: 100 }, 0), req({ prompt_tokens: 100 }, 1), req({}, 2)],
      'at least 200 prompt tokens (measured, 2 of 3 requests reported a prompt)',
    ],
  ])('%s', async (_label, requests, expected) => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: { state: 'engaged', basis: 'provider_reported', requests },
    });
    expect(out).toContain(expected);
  });

  it('none — no request reported a prompt', async () => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ cache_read_input_tokens: 5 })],
      },
    });
    expect(out).toContain('| prompt not reported |');
  });
});

describe('#600 PR 1b (#611) — step-line OUTPUT figure forms (new on this line)', () => {
  it.each<[string, UsageRecord[], string]>([
    ['single', [req({ output_tokens: 40 })], '40 output tokens'],
    [
      'full',
      [req({ output_tokens: 10 }, 0), req({ output_tokens: 30 }, 1)],
      '40 output tokens (totals across 2 requests)',
    ],
    [
      'partial',
      [req({ output_tokens: 10 }, 0), req({}, 1)],
      'at least 10 output tokens (1 of 2 requests reported output)',
    ],
  ])('%s', async (_label, requests, expected) => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: { state: 'engaged', basis: 'provider_reported', requests },
    });
    expect(out).toContain(expected);
    expect(out).not.toContain('output tokens (measured');
  });

  it('none — a request was made, none reported output', async () => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 5 })],
      },
    });
    expect(out).toContain('| output not reported |');
  });

  it('no segment at all when requests is empty', async () => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: { state: 'unobservable', basis: 'unobservable', requests: [] },
    });
    expect(out).not.toContain('output');
  });
});

describe('#600 PR 1b — step-line cache read/write clause forms (unchanged shapes, sourced from the view)', () => {
  it.each<[string, number | undefined, string]>([['full', undefined, 'read 500']])(
    'read %s',
    async (_label, _unused, expected) => {
      const out = await render({
        input_token_estimate: 1,
        precondition_trace: [],
        cache: {
          state: 'engaged',
          basis: 'provider_reported',
          requests: [req({ cache_read_input_tokens: 500 })],
        },
      });
      expect(out).toContain(expected);
    },
  );

  it('partial', async () => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ cache_read_input_tokens: 500 }, 0), req({}, 1)],
      },
    });
    expect(out).toContain('read at least 500 (1 of 2 requests reported a read)');
  });

  it('absent', async () => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: {
        state: 'write_only',
        basis: 'provider_reported',
        requests: [req({ cache_creation_input_tokens: 5 })],
      },
    });
    expect(out).toContain('read not reported');
  });
});

describe('#600 PR 1b — failure-line prompt/output/cache figure forms', () => {
  it.each<[string, UsageRecord[], string]>([
    ['prompt single', [req({ prompt_tokens: 500 })], '500 prompt tokens'],
    [
      'prompt full (multi-request)',
      [req({ prompt_tokens: 200 }, 0), req({ prompt_tokens: 300 }, 1)],
      '500 prompt tokens (totals across 2 requests)',
    ],
    [
      'prompt one-of-many collapses to PARTIAL (never "request i of n") on this line',
      [req({ prompt_tokens: 500 }, 0), req({}, 1)],
      'at least 500 prompt tokens (1 of 2 requests reported a prompt)',
    ],
    ['output single', [req({ output_tokens: 40 })], '40 output tokens'],
    [
      'output full',
      [req({ output_tokens: 10 }, 0), req({ output_tokens: 30 }, 1)],
      '40 output tokens (totals across 2 requests)',
    ],
    [
      'cache full — cache read R, wrote W, label-first, no "totals across" of its own',
      [req({ cache_read_input_tokens: 500, cache_creation_input_tokens: 80 })],
      'cache read 500, wrote 80',
    ],
    [
      'cache partial',
      [req({ cache_read_input_tokens: 500 }, 0), req({}, 1)],
      'cache read at least 500 (1 of 2 requests reported a read), wrote not reported',
    ],
  ])('%s', async (_label, usage, expected) => {
    const out = await renderFailure(usage);
    expect(out).toContain(expected);
  });

  it('none — prompt not reported', async () => {
    const out = await renderFailure([req({ cache_read_input_tokens: 5 })]);
    expect(out).toContain('prompt not reported');
  });

  it('#611 — cache is NEW on the failure line: neither side present reads "cache not reported"', async () => {
    const out = await renderFailure([req({ prompt_tokens: 5 })]);
    expect(out).toContain('cache not reported');
  });

  it('the uncached fallback on the failure line: bare single form gains its own parenthesis', async () => {
    const out = await renderFailure([req({ uncached_input_tokens: 60 })]);
    expect(out).toContain('60 uncached input tokens (whole prompt not reported)');
  });
});

// =========================================================================================
// Every drive-failure entry renders (was: only the last).
// =========================================================================================
describe('#600 PR 1b — every drive_failures entry renders, oldest first', () => {
  it('three entries, three usage lines, in order', async () => {
    const entries: DriveFailureRecord[] = [
      {
        at: '2024-01-01T00:00:00.000Z',
        step: 's1',
        provider: 'anthropic',
        error_class: 'other',
        message: 'first',
        elapsed_ms: 1,
        usage: [req({ prompt_tokens: 100 })],
      },
      {
        at: '2024-01-01T00:01:00.000Z',
        step: 's2',
        provider: 'anthropic',
        error_class: 'other',
        message: 'second',
        elapsed_ms: 1,
        usage: [req({ prompt_tokens: 200 })],
      },
      {
        at: '2024-01-01T00:02:00.000Z',
        step: 's3',
        provider: 'anthropic',
        error_class: 'other',
        message: 'third',
        elapsed_ms: 1,
        usage: [req({ prompt_tokens: 300 })],
      },
    ];
    const run = makeRun([], {
      terminal_state: false,
      run_phase: 'running',
      drive_failures: { first_failed_at: entries[0]!.at, total: 3, entries },
    });
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    const iFirst = out.indexOf('first');
    const iSecond = out.indexOf('second');
    const iThird = out.indexOf('third');
    expect(iFirst).toBeGreaterThan(-1);
    expect(iSecond).toBeGreaterThan(iFirst);
    expect(iThird).toBeGreaterThan(iSecond);
    expect(out).toContain('100 prompt tokens');
    expect(out).toContain('200 prompt tokens');
    expect(out).toContain('300 prompt tokens');
  });

  it('the four-space usage indent under EVERY failure line', async () => {
    const entries: DriveFailureRecord[] = [
      {
        at: '2024-01-01T00:00:00.000Z',
        step: 's1',
        provider: 'a',
        error_class: 'other',
        message: 'm1',
        elapsed_ms: 1,
        usage: [req({ prompt_tokens: 1 })],
      },
      {
        at: '2024-01-01T00:01:00.000Z',
        step: 's2',
        provider: 'a',
        error_class: 'other',
        message: 'm2',
        elapsed_ms: 1,
        usage: [req({ prompt_tokens: 2 })],
      },
    ];
    const run = makeRun([], {
      terminal_state: false,
      run_phase: 'running',
      drive_failures: { first_failed_at: entries[0]!.at, total: 2, entries },
    });
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    const usageLines = out.split('\n').filter((l) => l.includes('usage:'));
    expect(usageLines).toHaveLength(2);
    for (const l of usageLines) expect(l.startsWith('    usage:')).toBe(true);
  });
});

// =========================================================================================
// Multi-attempt reshape: keyed on execution-entry count, `attempt` ignored.
// =========================================================================================
describe('#600 PR 1b — multi-attempt keyed on execution-entry COUNT, never the `attempt` field', () => {
  it('a resumed agent step: two execution entries, no `attempt` field at all', async () => {
    const early = makeSnapshot('step_one', {
      status: 'error',
      agent_profile: 'reviewer',
      diagnostics: {
        input_token_estimate: 1,
        precondition_trace: [],
        cache: {
          state: 'engaged',
          basis: 'provider_reported',
          requests: [req({ prompt_tokens: 111 })],
        },
      },
    });
    const last = makeSnapshot('step_one', {
      status: 'success',
      agent_profile: 'reviewer',
      tool_calls: [{ server_id: 's', tool: 't', duration_ms: 5, args: {}, result: null }],
      diagnostics: {
        input_token_estimate: 1,
        precondition_trace: [],
        cache: {
          state: 'engaged',
          basis: 'provider_reported',
          requests: [req({ prompt_tokens: 222 })],
        },
      },
    });
    const run = makeRun([early, last]);
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    // Runs colourless under vitest, so plain substrings suffice — no ANSI to strip.
    expect(out).toContain('(attempt 2/2)  success');
    expect(out).toContain('[profile: reviewer]');
    expect(out).toContain('Tool calls (1):');
    const plain = out;
    const idxAttempt1 = plain.indexOf('attempt 1/2: 111 prompt tokens');
    const idxDiag = plain.indexOf('Diagnostics (attempt 2/2):');
    expect(idxAttempt1).toBeGreaterThan(-1);
    expect(idxDiag).toBeGreaterThan(idxAttempt1);
  });
});

describe('#600 PR 1b — the three absence sentences', () => {
  it('tool_calling_step', async () => {
    const run = makeRun([
      makeSnapshot('step_one', {
        tool_calls: [],
        diagnostics: { input_token_estimate: 1, precondition_trace: [] },
      }),
    ]);
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(out).toContain('cost: not recorded — tool-calling steps do not record usage yet');
  });

  it('not_measured_by_realm', async () => {
    const run = makeRun([
      makeSnapshot('step_one', {
        diagnostics: { input_token_estimate: 1, precondition_trace: [] },
      }),
    ]);
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(out).toContain(
      'cost: not recorded — realm has no usage figures for this attempt (for example: an outside ' +
        'agent over MCP made it, a person typed its answer at a realm workflow run prompt, or ' +
        'realm 0.45.0 or earlier recorded it)',
    );
  });

  it('cost_unreadable', async () => {
    const run = makeRun([
      makeSnapshot('step_one', {
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: {
            state: 'unobservable',
            basis: 'unobservable',
            requests: 'nope' as unknown as UsageRecord[],
          },
        },
      }),
    ]);
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(out).toContain('cost: unreadable — the recorded usage is not a list');
  });

  it('a handler step (no cache, no tool_calls, no agent signal) prints NO absence sentence at all', async () => {
    const run = makeRun([
      makeSnapshot('step_one', {
        diagnostics: { input_token_estimate: 1, precondition_trace: [] },
      }),
    ]);
    const def: WorkflowDefinition = {
      id: 'test-workflow',
      name: 'x',
      version: 1,
      steps: { step_one: { description: 'x', execution: 'auto' } },
    };
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(def));
    expect(out).not.toContain('cost:');
  });
});

// =========================================================================================
// `included in the prompt` — true only when it is true.
// =========================================================================================
describe('#600 PR 1b — `included in the prompt`', () => {
  it('TRUE beside a full prompt figure on the STEP line', async () => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 500, cache_read_input_tokens: 400 })],
      },
    });
    expect(out).toContain(
      'cache: read 400, wrote not reported (included in the prompt; provider-reported, 1 request)',
    );
  });

  it('TRUE beside a full prompt figure on the FAILURE line', async () => {
    const out = await renderFailure([req({ prompt_tokens: 500, cache_read_input_tokens: 400 })]);
    expect(out).toContain('cache read 400, wrote not reported (included in the prompt)');
  });

  it('FALSE beside a PARTIAL prompt figure', async () => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 500, cache_read_input_tokens: 400 }, 0), req({}, 1)],
      },
    });
    expect(out).not.toContain('included in the prompt');
  });

  it('FALSE beside a ONE-OF-MANY prompt figure', async () => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [
          req({ cache_read_input_tokens: 100 }, 0),
          req({ prompt_tokens: 500, cache_read_input_tokens: 400 }, 1),
        ],
      },
    });
    expect(out).not.toContain('included in the prompt');
  });

  it('FALSE beside the uncached fallback', async () => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: {
        state: 'partially_observed',
        basis: 'provider_reported',
        requests: [req({ uncached_input_tokens: 40, cache_read_input_tokens: 400 })],
      },
    });
    expect(out).not.toContain('included in the prompt');
  });

  it('FALSE on the never_engaged branch (two zeros — noise)', async () => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: {
        state: 'never_engaged',
        basis: 'provider_reported',
        requests: [
          req({ prompt_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
        ],
      },
    });
    expect(out).not.toContain('included in the prompt');
  });

  it('FALSE with no prompt figure shown at all', async () => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ cache_read_input_tokens: 400 })],
      },
    });
    expect(out).not.toContain('included in the prompt');
  });

  it('ABSENT on the "not reported by the provider" sentence (no number to attach to)', async () => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 500 })],
      },
    });
    expect(out).toContain('cache: not reported by the provider');
    expect(out).not.toContain('included in the prompt');
  });

  it('ABSENT on the failure line\'s "cache not reported" sentence', async () => {
    const out = await renderFailure([req({ prompt_tokens: 500 })]);
    expect(out).toContain('cache not reported');
    expect(out).not.toContain('included in the prompt');
  });
});

// =========================================================================================
// Multi-attempt order + the bare single-entry label.
// =========================================================================================
describe('#600 PR 1b — the multi-attempt line order, and the bare label on a single-entry step', () => {
  it("earlier attempt lines, then the labelled Diagnostics line, then the last entry's absence line", async () => {
    const early = makeSnapshot('step_one', {
      status: 'error',
      diagnostics: {
        input_token_estimate: 1,
        precondition_trace: [],
        cache: {
          state: 'engaged',
          basis: 'provider_reported',
          requests: [req({ prompt_tokens: 1 })],
        },
      },
    });
    const last = makeSnapshot('step_one', {
      status: 'success',
      tool_calls: [],
      diagnostics: { input_token_estimate: 1, precondition_trace: [] },
    });
    const run = makeRun([early, last]);
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    const plain = out;
    const lines = plain.split('\n');
    const iAttempt = lines.findIndex((l) => l.includes('attempt 1/2:'));
    const iDiag = lines.findIndex((l) => l.includes('Diagnostics (attempt 2/2):'));
    const iAbsence = lines.findIndex((l) => l.includes('cost: not recorded — tool-calling'));
    expect(iAttempt).toBeGreaterThan(-1);
    expect(iDiag).toBeGreaterThan(iAttempt);
    expect(iAbsence).toBeGreaterThan(iDiag);
  });

  it('a single-entry step keeps the bare "Diagnostics:" label', async () => {
    const run = makeRun([
      makeSnapshot('step_one', {
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: {
            state: 'engaged',
            basis: 'provider_reported',
            requests: [req({ prompt_tokens: 1 })],
          },
        },
      }),
    ]);
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(out).toContain('Diagnostics: ~1 tokens');
    expect(out).not.toContain('Diagnostics (attempt');
  });
});

// =========================================================================================
// gate_response rendering: unchanged single branch, and the new multi-attempt block.
// =========================================================================================
describe('#600 PR 1b — gate_response rendering', () => {
  it("the unchanged single-entry render: a gate_response that ran BEFORE the step's own execution entry hides it (P4, byte pinned)", async () => {
    const gate = makeSnapshot('gated_step', {
      kind: 'gate_response',
      input_summary: { choice: 'approve' },
      output_summary: { choice: 'approve' },
      gate_message: 'Proceed?',
    });
    const execution = makeSnapshot('gated_step', {
      kind: 'execution',
      diagnostics: { input_token_estimate: 1, precondition_trace: [] },
    });
    const run = makeRun([gate, execution]);
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    const plain = out;
    // issue #625: the choice prints once, on the `Answer:` line.
    expect(plain).toContain('Answer: approve');
    expect(plain).not.toContain('Choice:');
    expect(plain).toContain('Message:  "Proceed?"');
    // The execution entry's own Diagnostics line never appears — this is the KNOWN, unchanged P4
    // defect (a separately homed issue), pinned rather than fixed here.
    expect(plain).not.toContain('Diagnostics');
  });

  it('the multi-attempt gate_response block: renders AFTER, no header of its own', async () => {
    const e1 = makeSnapshot('gated_step', {
      kind: 'execution',
      status: 'error',
      diagnostics: { input_token_estimate: 1, precondition_trace: [] },
    });
    const e2 = makeSnapshot('gated_step', {
      kind: 'execution',
      status: 'success',
      diagnostics: { input_token_estimate: 1, precondition_trace: [] },
    });
    const gate = makeSnapshot('gated_step', {
      kind: 'gate_response',
      input_summary: { choice: 'approve' },
      output_summary: { choice: 'approve' },
      gate_message: 'Proceed?',
    });
    const run = makeRun([e1, e2, gate]);
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    const plain = out;
    expect(plain).toContain('(attempt 1/2)');
    expect(plain).toContain('(attempt 2/2)');
    // issue #625: the choice prints once, on the `Answer:` line.
    expect(plain).toContain('Answer: approve');
    expect(plain).not.toContain('Choice:');
    expect(plain).toContain('Message:  "Proceed?"');
    // No SECOND numbered header line ("  N. gated_step") for the gate block.
    const headerCount = (plain.match(/\d+\. gated_step/g) ?? []).length;
    expect(headerCount).toBe(1);
  });
});

// =========================================================================================
// The source-text census.
// =========================================================================================
describe('#600 PR 1b — source-text census', () => {
  it('inspect.ts contains none of reportedFigure, firstReported, whichRequest, and its only .reduce( lines are the two Trace Summary lines', () => {
    const src = readFileSync(new URL('./inspect.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('reportedFigure');
    expect(src).not.toContain('firstReported');
    expect(src).not.toContain('whichRequest');
    const reduceLines = src.split('\n').filter((l) => l.includes('.reduce('));
    expect(reduceLines).toHaveLength(2);
    for (const l of reduceLines) expect(l).toContain('allSnaps.reduce(');
  });
});

// =========================================================================================
// ONE record, rendered on BOTH surfaces, agreeing.
// =========================================================================================
describe('#600 PR 1b — one composed record agrees on inspect and get_run_state', () => {
  it('the same values, the same reported/of', async () => {
    const run = makeRun([
      makeSnapshot('step_one', {
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: {
            state: 'engaged',
            basis: 'provider_reported',
            requests: [
              req({ prompt_tokens: 777 }, 0),
              req({ prompt_tokens: 999, cache_read_input_tokens: 111 }, 1),
            ],
          },
        },
      }),
    ]);
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    expect(out).toContain('1776 prompt tokens (measured, totals across 2 requests)');

    const summary = await handleGetRunState(
      { run_id: 'run_test1', include_steps: true },
      { runStore: makeRunStore(run), workflowStore: makeWorkflowStore(basicDef) as never },
    );
    const figure = summary.steps!['step_one']!.attempts[0]!.cost!.prompt!;
    expect(figure).toEqual({ value: 1776, reported: 2, of: 2 });
  });
});

// =========================================================================================
// issue #600 PR 2 (D3, G25): the request facts on the three cost lines, through one composer.
// On a failing CI host each cell prints the rendered line: test values only.
// =========================================================================================
describe('#600 PR 2 — the model and the ask on the cost lines', () => {
  /** The step's `Diagnostics:` line for these requests, without its label. */
  const stepLine = async (
    requests: UsageRecord[],
    state: 'engaged' | 'write_only' | 'never_engaged' = 'engaged',
  ): Promise<string> => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: { state, basis: 'provider_reported', requests },
    });
    const line = out.split('\n').find((l) => l.includes('Diagnostics: '));
    return line === undefined
      ? `(no Diagnostics line in: ${out})`
      : line.split('Diagnostics: ')[1]!;
  };
  /** The failed drive's `usage:` line for these requests. */
  const failureLine = async (usage: UsageRecord[]): Promise<string> => {
    const out = await renderFailure(usage);
    return out.split('\n').find((l) => l.startsWith('    usage: ')) ?? `(no usage line in: ${out})`;
  };
  const lifetime = (
    s: number | undefined,
    extra: Partial<UsageRecord> = {},
  ): Partial<UsageRecord> => ({
    cache_requested: 'lifetime',
    ...(s !== undefined ? { cache_lifetime_s: s } : {}),
    ...extra,
  });

  // guard: a request with none of PR 2's fields prints exactly what 0.47.0 printed (the line is
  // byte-identical; the A5 absence is withheld). Green on the base by design.
  it('guard: a record without the request facts prints the line it printed before', async () => {
    expect(
      await stepLine(
        [
          req({
            prompt_tokens: 100,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 40,
          }),
        ],
        'write_only',
      ),
    ).toBe(
      '~1 tokens (estimate, step input) | 100 prompt tokens (measured, first request) | 5 output tokens | no preconditions | cache: read 0, wrote 40 (included in the prompt; provider-reported, 1 request)',
    );
  });

  it('model: one name for every request; several; named by some of the requests', async () => {
    expect(await stepLine([req({ prompt_tokens: 1, model: 'claude-x-20260101' })])).toContain(
      '| 1 prompt tokens (measured, first request) | output not reported | model claude-x-20260101 | no preconditions |',
    );
    expect(
      await stepLine([
        req({ model: 'a-1' }, 0),
        req({ model: 'b-2' }, 1),
        req({ model: 'a-1' }, 2),
      ]),
    ).toContain('| models a-1, b-2 (the requests used different models) |');
    expect(await stepLine([req({ model: 'a-1' }, 0), req({}, 1)])).toContain(
      '| model a-1 (named by 1 of 2 requests) |',
    );
  });

  // (a) red when quotedForTerminal is removed (the quote marks go); (b) prints the line.
  it('a name that needs it is quoted, a quote mark escaped', async () => {
    expect(await stepLine([req({ model: 'my "model"' })])).toContain('| model "my \\"model\\"" |');
  });

  it('the ask, per kind: a lifetime, off, the provider’s rules', async () => {
    const asks = await Promise.all([
      stepLine([
        req(
          lifetime(300, {
            cache_ttl_sent: false,
            cache_requested_source: 'runner_default',
            cache_requested_by: 'realm agent',
          }),
        ),
      ]),
      stepLine([
        req(
          lifetime(3600, {
            cache_ttl_sent: true,
            cache_requested_source: 'stated',
            cache_requested_by: 'realm listen',
          }),
        ),
      ]),
      stepLine([req(lifetime(90, { cache_ttl_sent: true, cache_requested_source: 'stated' }))]),
      stepLine([
        req({
          cache_requested: 'off',
          cache_requested_source: 'stated',
          cache_requested_by: 'realm agent',
        }),
      ]),
      stepLine([req({ cache_requested: 'provider_rules' })]),
    ]);
    expect(asks.map((l) => l.slice(l.indexOf('(1 request)') + '(1 request)'.length))).toEqual([
      "; asked for 5m (the provider's default lifetime; realm agent's default)",
      '; asked for 1h (sent as 1h; stated on realm listen)',
      '; asked for 90s (sent as 90s; stated)',
      '; asked for no caching (stated on realm agent)',
      "; asked for nothing (the provider's own caching, if any, applies)",
    ]);
  });

  // (a) red when quotedForTerminal is removed (the control byte would reach the terminal raw);
  // (b) prints the line.
  it('an unknown ask, an unknown source, a lifetime that is not valid, and one not stated', async () => {
    const lines = await Promise.all([
      stepLine([req({ cache_requested: 'weird\u0007' as never })]),
      stepLine([
        req(lifetime(300, { cache_ttl_sent: false, cache_requested_source: 'x\u001b' as never })),
      ]),
      ...[0, 604_801, 1.5, -1].map((s) => stepLine([req(lifetime(s, { cache_ttl_sent: false }))])),
      stepLine([req(lifetime(undefined))]),
    ]);
    const asks = lines.map((l) => l.slice(l.indexOf('; asked') + 2));
    expect(asks).toEqual([
      'asked: unrecognized "weird\\u0007"',
      'asked for 5m (the provider\'s default lifetime; unrecognized source "x\\u001b")',
      'asked for a lifetime: unrecognized lifetime',
      'asked for a lifetime: unrecognized lifetime',
      'asked for a lifetime: unrecognized lifetime',
      'asked for a lifetime: unrecognized lifetime',
      'asked for a lifetime the record does not state',
    ]);
    // No control byte reaches the terminal raw.
    // eslint-disable-next-line no-control-regex
    expect(lines.join('')).not.toMatch(/[\u0000-\u001f]/);
  });

  it('<src>: each row; <sent>: absent', async () => {
    const src = async (extra: Partial<UsageRecord>) => {
      const l = await stepLine([req(lifetime(300, { cache_ttl_sent: false, ...extra }))]);
      return l.slice(l.indexOf('lifetime; ') + 'lifetime; '.length, -1);
    };
    expect([
      await src({ cache_requested_source: 'stated', cache_requested_by: 'ci-bot' }),
      await src({ cache_requested_source: 'runner_default', cache_requested_by: 'ci-bot' }),
      await src({ cache_requested_source: 'stated' }),
      await src({ cache_requested_source: 'runner_default' }),
      await src({}),
    ]).toEqual([
      'stated on ci-bot',
      "ci-bot's default",
      'stated',
      "a runner's default",
      'source not recorded',
    ]);
    const unsent = await stepLine([req(lifetime(300, { cache_requested_source: 'stated' }))]);
    expect(unsent).toContain('; asked for 5m (whether Realm sent it is not recorded; stated)');
  });

  it('several asks are joined by ", then"; recorded by some of the requests', async () => {
    const l = await stepLine([
      req(
        lifetime(3600, {
          cache_ttl_sent: true,
          cache_requested_source: 'runner_default',
          cache_requested_by: 'realm listen',
        }),
        0,
      ),
      req(
        {
          cache_requested: 'off',
          cache_requested_source: 'stated',
          cache_requested_by: 'realm agent',
        },
        1,
      ),
      req({}, 2),
    ]);
    expect(l).toContain(
      "; asked for 1h (sent as 1h; realm listen's default), then asked for no caching (stated on realm agent) (recorded by 2 of 3 requests)",
    );
  });

  // (a) red when the mismatch clause never fires; (b) prints the line.
  it('the lifetime-mismatch clause, both ways', async () => {
    const asked1h = await stepLine([
      req(
        lifetime(3600, {
          cache_ttl_sent: true,
          cache_creation_input_tokens: 70,
          cache_creation: { ephemeral_5m_input_tokens: 70, ephemeral_1h_input_tokens: 0 },
        }),
      ),
    ]);
    const asked5m = await stepLine([
      req(
        lifetime(300, {
          cache_ttl_sent: false,
          cache_creation_input_tokens: 30,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 30 },
        }),
      ),
    ]);
    const matched = await stepLine([
      req(
        lifetime(3600, {
          cache_ttl_sent: true,
          cache_creation_input_tokens: 70,
          cache_creation: { ephemeral_1h_input_tokens: 70 },
        }),
      ),
    ]);
    expect(
      [asked1h, asked5m, matched].map(
        (l) => /; (\d+ of the tokens written[^;]*)$/.exec(l)?.[1] ?? 'none',
      ),
    ).toEqual([
      '70 of the tokens written were kept for 5m, not the 1h asked',
      '30 of the tokens written were kept for 1h, not the 5m asked',
      'none',
    ]);
  });

  // (a) red when the nothing-cached clause never fires; (b) prints the line.
  it('the nothing-cached clause: a lifetime asked, every request reporting 0 read and 0 written', async () => {
    const zero = await stepLine(
      [
        req(
          lifetime(300, {
            cache_ttl_sent: false,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          }),
        ),
      ],
      'never_engaged',
    );
    expect(zero).toMatch(
      /; nothing was written or read: the cached part may be shorter than the model's minimum$/,
    );
    // Not when a request did not report both, nor when nothing was asked.
    const silent = await stepLine([
      req(lifetime(300, { cache_ttl_sent: false, cache_read_input_tokens: 0 })),
    ]);
    const off = await stepLine(
      [req({ cache_requested: 'off', cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })],
      'never_engaged',
    );
    expect([silent, off].map((l) => l.includes('nothing was written or read'))).toEqual([
      false,
      false,
    ]);
  });

  // (a) red when the failure line does not use the shared composer; (b) prints the line.
  it('the failed-drive line: the model, then the ask, as the step line says them', async () => {
    expect(
      await failureLine([
        req({
          prompt_tokens: 5,
          model: 'claude-x-20260101',
          ...lifetime(300, {
            cache_ttl_sent: false,
            cache_requested_source: 'runner_default',
            cache_requested_by: 'realm agent',
          }),
        }),
      ]),
    ).toBe(
      "    usage: 1 request billed before the throw — 5 prompt tokens, output not reported, cache not reported; model claude-x-20260101; asked for 5m (the provider's default lifetime; realm agent's default)",
    );
  });

  // (a) red when the earlier attempt's line does not use the shared composer; (b) prints the lines.
  it("a two-attempt step: each attempt's line carries its own model and ask", async () => {
    const attempt = (status: 'error' | 'success', request: UsageRecord) =>
      makeSnapshot('step_one', {
        status,
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: { state: 'engaged', basis: 'provider_reported', requests: [request] },
        },
      });
    const run = makeRun([
      attempt(
        'error',
        req({
          prompt_tokens: 111,
          model: 'model-a',
          ...lifetime(3600, {
            cache_ttl_sent: true,
            cache_requested_source: 'runner_default',
            cache_requested_by: 'realm listen',
          }),
        }),
      ),
      attempt(
        'success',
        req({
          prompt_tokens: 222,
          model: 'model-b',
          ...lifetime(300, {
            cache_ttl_sent: false,
            cache_requested_source: 'stated',
            cache_requested_by: 'realm agent',
          }),
        }),
      ),
    ]);
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
    const first = out.split('\n').find((l) => l.includes('attempt 1/2: '));
    const last = out.split('\n').find((l) => l.includes('Diagnostics (attempt 2/2): '));
    expect([first?.trim(), last?.trim()]).toEqual([
      "attempt 1/2: 111 prompt tokens (measured, first request) | output not reported | model model-a | cache: not reported by the provider (1 request); asked for 1h (sent as 1h; realm listen's default)",
      "Diagnostics (attempt 2/2): ~1 tokens (estimate, step input) | 222 prompt tokens (measured, first request) | output not reported | model model-b | no preconditions | cache: not reported by the provider (1 request); asked for 5m (the provider's default lifetime; stated on realm agent)",
    ]);
  });
});
