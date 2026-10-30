// inspect-cost-view.test.ts — issue #600 PR 1b (D7): the whole render surface this PR rewrote —
// the figure-form table on both contexts, #611's two new segments, every failure entry, the
// multi-attempt reshape keyed on execution-entry count, the absence sentences, `included in the
// prompt`'s truth rule, and the ONE composed view rendered identically on both surfaces.
import { declared } from '../test-support/declared.js';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { inspectRun, inspectPriceSource } from './inspect.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  PriceSource,
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
    expect(out).toContain(
      'cost: not recorded — tool-calling step with no recorded usage (realm 0.48.0 or earlier recorded none)',
    );
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
      "; asked for 5 minutes (the provider's default lifetime; realm agent's default)",
      '; asked for 1 hour (sent as 1 hour; stated on realm listen)',
      '; asked for 90 seconds (sent as 90 seconds; stated)',
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
      'asked for 5 minutes (the provider\'s default lifetime; unrecognized source "x\\u001b")',
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
    expect(unsent).toContain(
      '; asked for 5 minutes (whether Realm sent it is not recorded; stated)',
    );
  });

  // Cell 11 (the lifetime unit): the auto clause, one row per basis, then the `off` an auto chose,
  // then a record whose `cache_auto` is not one the record keeps (no clause). #898: a record with
  // kept gaps and no `prices` predates priced auto, so its clause ends `price source not recorded`. (a) red when inspect
  // drops the auto clause, renders it outside the parentheses, or prints a malformed one; (b)
  // prints each line's ask (test values only).
  it('the auto clause per basis, and the off auto chose; a malformed cache_auto adds nothing', async () => {
    const ask = async (extra: Partial<UsageRecord>) => {
      const l = await stepLine([req(extra)]);
      return l.slice(l.indexOf('(1 request)') + '(1 request)'.length);
    };
    const byListen = {
      cache_requested_source: 'runner_default',
      cache_requested_by: 'realm listen',
    } as const;
    expect([
      await ask(
        lifetime(3600, {
          cache_ttl_sent: true,
          ...byListen,
          cache_auto: { basis: 'listen_trigger_gaps', gaps_s: [420, 720] },
        }),
      ),
      await ask(
        lifetime(3600, {
          cache_ttl_sent: true,
          ...byListen,
          cache_auto: { basis: 'listen_trigger_gaps', gaps_s: [] },
        }),
      ),
      await ask(
        lifetime(3600, {
          cache_ttl_sent: true,
          ...byListen,
          cache_auto: { basis: 'listen_gaps_unreadable' },
        }),
      ),
      await ask(
        lifetime(300, {
          cache_ttl_sent: false,
          cache_requested_source: 'runner_default',
          cache_requested_by: 'realm agent',
          cache_auto: { basis: 'no_measurement' },
        }),
      ),
      await ask({
        cache_requested: 'off',
        ...byListen,
        cache_auto: { basis: 'listen_trigger_gaps', gaps_s: [7200] },
      }),
      await ask({
        cache_requested: 'off',
        ...byListen,
        cache_auto: { basis: 'listen_trigger_gaps', gaps_s: [7200, 7200, 7200] },
      }),
      await ask(
        lifetime(300, {
          cache_ttl_sent: false,
          cache_requested_source: 'runner_default',
          cache_requested_by: 'realm agent',
          cache_auto: { basis: 'guessed' } as never,
        }),
      ),
    ]).toEqual([
      "; asked for 1 hour (sent as 1 hour; realm listen's default; auto: the last 2 gaps between this workflow's triggers were about 7 minutes and 12 minutes; price source not recorded (this request was recorded before Realm priced auto from the price file))",
      "; asked for 1 hour (sent as 1 hour; realm listen's default; auto: no earlier trigger of this workflow since realm listen started)",
      "; asked for 1 hour (sent as 1 hour; realm listen's default; auto: realm listen's measurement could not be read)",
      "; asked for 5 minutes (the provider's default lifetime; realm agent's default; auto: a drive realm agent starts on its own has no trigger history)",
      "; asked for no caching (realm listen's default; auto: the last gap between this workflow's triggers was about 2 hours; price source not recorded (this request was recorded before Realm priced auto from the price file))",
      "; asked for no caching (realm listen's default; auto: the last 3 gaps between this workflow's triggers were about 2 hours, 2 hours and 2 hours; price source not recorded (this request was recorded before Realm priced auto from the price file))",
      "; asked for 5 minutes (the provider's default lifetime; realm agent's default)",
    ]);
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
      "; asked for 1 hour (sent as 1 hour; realm listen's default), then asked for no caching (stated on realm agent) (recorded by 2 of 3 requests)",
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
      '70 of the tokens written were kept for 5 minutes, not the 1 hour asked',
      '30 of the tokens written were kept for 1 hour, not the 5 minutes asked',
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
      "    usage: 1 request billed before the throw — 5 prompt tokens, output not reported, cache not reported; model claude-x-20260101; asked for 5 minutes (the provider's default lifetime; realm agent's default)",
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
      "attempt 1/2: 111 prompt tokens (measured, first request) | output not reported | model model-a | cache: not reported by the provider (1 request); asked for 1 hour (sent as 1 hour; realm listen's default)",
      "Diagnostics (attempt 2/2): ~1 tokens (estimate, step input) | 222 prompt tokens (measured, first request) | output not reported | model model-b | no preconditions | cache: not reported by the provider (1 request); asked for 5 minutes (the provider's default lifetime; stated on realm agent)",
    ]);
  });
});

// =========================================================================================
// issue #600 caching PR P (G10, G11, G14): the money on the cost lines, the run's cost line, and
// the ride-along. The injected source reads its answer from the model's name — `kind|total|cf` —
// so each form is set by its fixture: `e-dated`/`e-current` price from the economics file at the
// call's date / at the current price, `list` from genai-prices 0.1.12 (with its note on a custom
// endpoint), `list-as` as anthropic's claude-x, `unknown` is not priced. On a failing CI host each
// cell prints the rendered line: test values only.
// =========================================================================================
const NAMED: PriceSource = {
  price(input) {
    const [kind, total, cf] = input.model.split('|');
    if (kind === 'unknown') return { not_priced: 'model_unknown' };
    const priced = { total: Number(total), uncached_counterfactual: Number(cf ?? total) };
    if (kind === 'e-dated' || kind === 'e-current') {
      return {
        priced,
        priced_by: {
          source_class: 'economics',
          source_ref: '/srv/prices.yaml',
          matched_model: input.model,
          date_basis: kind === 'e-dated' ? 'dated' : 'current',
        },
      };
    }
    return {
      priced,
      priced_by: {
        source_class: 'price_list',
        source_ref: '@pydantic/genai-prices',
        version: '0.1.12',
        matched_model: kind === 'list-as' ? 'claude-x' : input.model,
        matched_provider: 'anthropic',
        ...(kind === 'list-as' ? { equals_ids: [input.model] } : {}),
        date_basis: 'current',
        ...(input.endpoint === 'custom'
          ? { endpoint_note: 'list price, your endpoint may bill differently' }
          : {}),
      },
    };
  },
};
const fixedSource = (result: ReturnType<PriceSource['price']>): PriceSource => ({
  price: () => result,
});
const m = (model: string, extra: Partial<UsageRecord> = {}, index = 0): UsageRecord =>
  req({ model, prompt_tokens: 10, output_tokens: 1, ...extra }, index);
const pricedRender = async (
  requests: UsageRecord[],
  source: PriceSource = NAMED,
): Promise<string> => {
  const run = makeRun([
    makeSnapshot('step_one', {
      diagnostics: {
        input_token_estimate: 1,
        precondition_trace: [],
        cache: { state: 'engaged', basis: 'provider_reported', requests },
      },
    }),
  ]);
  return inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef), {
    priceSource: source,
  });
};
const stepMoney = (out: string): string => {
  const line = out.split('\n').find((l) => l.includes('Diagnostics: ')) ?? '';
  const at =
    line.indexOf(' | $') >= 0
      ? line.indexOf(' | $')
      : line.indexOf(' | ≥ $') >= 0
        ? line.indexOf(' | ≥ $')
        : line.indexOf(' | not priced');
  return at >= 0 ? line.slice(at) : '(no money segment)';
};

describe('#600 caching PR P — the money on the step line (G10)', () => {
  // One cell per form. (a) red when the form changes; (b) prints the segment.
  it('the forms: economics at the call’s date; the list with its note on a custom endpoint; partial; not priced (×3)', async () => {
    expect([
      stepMoney(await pricedRender([m('e-dated|0.0412|0.0412')])),
      stepMoney(await pricedRender([m('list|0.0412|0.0412', { endpoint: 'custom' })])),
      stepMoney(
        await pricedRender([
          m('e-dated|0.02|0.02', {}, 0),
          m('e-dated|0.02129|0.02129', {}, 1),
          req({ prompt_tokens: 1, output_tokens: 1 }, 2),
        ]),
      ),
      stepMoney(await pricedRender([m('x')], fixedSource({ not_priced: 'no_price_source' }))),
      stepMoney(
        await pricedRender(
          [m('x')],
          fixedSource({
            not_priced: 'economics_unreachable',
            detail: "the run's workflow copy records no deployment root",
          }),
        ),
      ),
      stepMoney(
        await pricedRender(
          [m('x')],
          fixedSource({
            not_priced: 'economics_unreadable',
            detail: "'/srv/p.yaml': economics/version: must be equal to constant",
          }),
        ),
      ),
    ]).toEqual([
      " | $0.0412 (your economics file; at the call's date)",
      ' | $0.0412 (genai-prices 0.1.12; current price; list price, your endpoint may bill differently)',
      " | ≥ $0.0412 (your economics file; at the call's date; 2 of 3 requests priced; 1 not priced: model not recorded)",
      ' | not priced (no price source: add prices in runner.cache.economics, or install @pydantic/genai-prices beside realm)',
      " | not priced (economics unreachable: the run's workflow copy records no deployment root)",
      " | not priced (your economics file: '/srv/p.yaml': economics/version: must be equal to constant)",
    ]);
  });

  // (a) red when the net's sign is flipped, or the clause is printed for a zero net; (b) prints it.
  it('caching saved, caching cost more, nothing for a zero net', async () => {
    expect([
      stepMoney(await pricedRender([m('e-current|0.0307|0.0412')])),
      stepMoney(await pricedRender([m('e-current|0.0412|0.0381')])),
      stepMoney(await pricedRender([m('e-current|0.0412|0.0412')])),
    ]).toEqual([
      ' | $0.0307 (your economics file; current price); caching saved $0.0105',
      ' | $0.0412 (your economics file; current price); caching cost $0.0031 more',
      ' | $0.0412 (your economics file; current price)',
    ]);
  });

  // (a) red when a lower bound is rounded up, trailing zeros are kept, or $1 and above loses its
  // two decimals; (b) prints the segments.
  it('precision: three significant figures below $1, trailing zeros dropped; two decimals above; ≥ floored; $0', async () => {
    expect([
      stepMoney(await pricedRender([m('e-current|0.0031')])),
      stepMoney(await pricedRender([m('e-current|0.041')])),
      stepMoney(await pricedRender([m('e-current|1.2345')])),
      stepMoney(await pricedRender([m('e-current|0')])),
      stepMoney(await pricedRender([m('e-current|0.04129', {}, 0), m('unknown', {}, 1)])),
    ]).toEqual([
      ' | $0.0031 (your economics file; current price)',
      ' | $0.041 (your economics file; current price)',
      ' | $1.23 (your economics file; current price)',
      ' | $0 (your economics file; current price)',
      ' | ≥ $0.0412 (your economics file; current price; 1 of 2 requests priced; 1 not priced: no price for this model: add it to your economics file)',
    ]);
  });

  // (a) red when the date basis is a constant; (b) prints the three renders.
  it("the three date bases: at the call's date, current price, N at the call's date, M current", async () => {
    const two = await pricedRender([m('e-dated|0.01', {}, 0), m('e-dated|0.01', {}, 1)], {
      price(input) {
        const r = NAMED.price(input);
        return 'priced' in r && input.at === 'mixed'
          ? { ...r, priced_by: { ...r.priced_by, date_basis: 'current' } }
          : r;
      },
    });
    const mixed = await pricedRender(
      [
        m('e-dated|0.01', {}, 0),
        m('e-dated|0.01', { request_start: '2024-01-01T00:00:01.000Z' }, 1),
      ],
      {
        price(input) {
          const r = NAMED.price(input);
          return 'priced' in r && input.at.endsWith(':01.000Z')
            ? { ...r, priced_by: { ...r.priced_by, date_basis: 'current' } }
            : r;
        },
      },
    );
    expect([
      stepMoney(two),
      stepMoney(await pricedRender([m('e-current|0.01')])),
      stepMoney(mixed),
    ]).toEqual([
      " | $0.02 (your economics file; at the call's date)",
      ' | $0.01 (your economics file; current price)',
      " | $0.02 (your economics file; 1 at the call's date, 1 current)",
    ]);
  });

  it('priced as the list matched: the provider and the model, when the model differs from the recorded one', async () => {
    expect(stepMoney(await pricedRender([m('list-as|0.01')]))).toBe(
      " | $0.01 (genai-prices 0.1.12; current price; priced as anthropic's claude-x)",
    );
  });

  // (a) red when a record with no model prints a segment; (b) prints the line.
  it('a record from 0.47.0 or earlier (no model): no money segment, the line as before', async () => {
    expect(stepMoney(await pricedRender([req({ prompt_tokens: 10, output_tokens: 1 })]))).toBe(
      '(no money segment)',
    );
  });

  // (a) red when the gateway reason is printed on a default endpoint; (b) prints both lines' tails.
  it('the gateway reason of the nothing-cached clause only when a request went to a custom endpoint', async () => {
    const asked = (endpoint: 'default' | 'custom'): UsageRecord =>
      req({
        model: 'e-current|0.01',
        prompt_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_requested: 'lifetime',
        cache_lifetime_s: 300,
        cache_ttl_sent: false,
        endpoint,
      });
    const line = async (endpoint: 'default' | 'custom'): Promise<boolean> =>
      (await pricedRender([asked(endpoint)])).includes(
        "the cached part may be shorter than the model's minimum, or the endpoint dropped the request to cache",
      );
    expect([await line('custom'), await line('default')]).toEqual([true, false]);
  });

  // One cell per producing branch. (a) red when the shared helper is not called on that line;
  // (b) prints the line.
  it('the earlier-attempt line and the failed-drive line carry the same money segment', async () => {
    const attempt = (status: 'error' | 'success', model: string): EvidenceSnapshot =>
      makeSnapshot('step_one', {
        status,
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: { state: 'engaged', basis: 'provider_reported', requests: [m(model)] },
        },
      });
    const run = makeRun(
      [attempt('error', 'e-current|0.05'), attempt('success', 'e-current|0.073')],
      {
        terminal_state: false,
        run_phase: 'running',
        drive_failures: {
          first_failed_at: 'a',
          total: 1,
          entries: [
            {
              at: '2024-01-01T00:04:00.000Z',
              step: 'step_one',
              provider: 'anthropic',
              error_class: 'other',
              message: 'boom',
              elapsed_ms: 1,
              usage: [m('e-current|0.002')],
            },
          ],
        },
      },
    );
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef), {
      priceSource: NAMED,
    });
    const lines = out.split('\n');
    expect([
      lines
        .find((l) => l.includes('attempt 1/2: '))
        ?.endsWith(' | $0.05 (your economics file; current price)'),
      lines
        .find((l) => l.startsWith('    usage: '))
        ?.endsWith(' | $0.002 (your economics file; current price)'),
      lines
        .find((l) => l.includes('1. step_one'))
        ?.includes(' — $0.123 across 2 attempts (your economics file)'),
    ]).toEqual([true, true, true]);
  });

  // issue #600 caching PR P correction (C3): a figure two sources priced keeps every part a
  // one-source figure carries. (a) red when the mixed form returns before the date basis and the
  // notes; (b) prints the segment.
  it('mixed sources: the counts per source, then the date basis, priced as and the notes', async () => {
    expect(
      stepMoney(
        await pricedRender([
          m('e-dated|0.01', {}, 0),
          m('list-as|0.01', { endpoint: 'custom' }, 1),
        ]),
      ),
    ).toBe(
      " | $0.02 (prices from: your economics file (1), genai-prices 0.1.12 (1); 1 at the call's date, 1 current; priced as anthropic's claude-x; list price, your endpoint may bill differently)",
    );
  });

  // issue #600 caching PR P correction (C4): a step whose earlier attempt has no usage figures — its
  // total leaves that attempt out. (a) red when the header's `≥` ignores such an attempt; (b) prints
  // the header's total.
  it("the step header's total is a lower bound when one of its attempts has no usage figures", async () => {
    const run = makeRun([
      makeSnapshot('step_one', { status: 'error', agent_profile: 'p' }),
      makeSnapshot('step_one', {
        status: 'success',
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: {
            state: 'engaged',
            basis: 'provider_reported',
            requests: [m('e-current|0.25')],
          },
        },
      }),
    ]);
    const out = await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef), {
      priceSource: NAMED,
    });
    const header = out.split('\n').find((l) => l.includes('1. step_one')) ?? '';
    expect(header.slice(header.indexOf(' — '))).toBe(
      ' — ≥ $0.25 across 2 attempts (your economics file)',
    );
  });
});

describe("#600 caching PR P — the run's cost line (G10)", () => {
  const costLine = async (
    run: RunRecord,
    source: PriceSource = NAMED,
  ): Promise<string | undefined> =>
    (
      await inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef), {
        priceSource: source,
      })
    )
      .split('\n')
      .find((l) => l.startsWith('Cost: '));
  const entry = (
    model: string,
    index: number,
    overrides: Partial<EvidenceSnapshot> = {},
  ): EvidenceSnapshot =>
    makeSnapshot(`s${index}`, {
      diagnostics: {
        input_token_estimate: 1,
        precondition_trace: [],
        cache: { state: 'engaged', basis: 'provider_reported', requests: [m(model)] },
      },
      ...overrides,
    });

  // (a) red when the figure is not floored as a lower bound, a left-out part is not named, or the
  // mixed sources are not counted; (b) prints the line.
  it('every request priced; a lower bound naming what it leaves out; mixed sources', async () => {
    const full = makeRun([entry('e-current|1', 0), entry('e-current|0.23', 1)]);
    const leftOut = makeRun(
      [
        entry('e-current|1.239', 0),
        makeSnapshot('t', {
          tool_calls: [],
          diagnostics: { input_token_estimate: 1, precondition_trace: [] },
        }),
        makeSnapshot('t2', {
          tool_calls: [],
          diagnostics: { input_token_estimate: 1, precondition_trace: [] },
        }),
      ],
      {
        drive_failures: {
          first_failed_at: 'a',
          total: 2,
          entries: [
            {
              at: 'a',
              step: 's0',
              provider: 'p',
              error_class: 'other',
              message: 'm',
              elapsed_ms: 1,
            },
          ],
        },
      },
    );
    const mixed = makeRun([entry('e-current|1', 0), entry('list|0.5', 1), entry('list|0.5', 2)]);
    expect([await costLine(full), await costLine(leftOut), await costLine(mixed)]).toEqual([
      'Cost: $1.23 (your economics file; current price; 2 of 2 requests priced)',
      'Cost: ≥ $1.23 (your economics file; current price; 1 of 1 requests priced; 2 tool-calling attempts not measured; 1 failed drive without usage figures; 1 failed drive not on the record)',
      'Cost: $2.00 (prices from: your economics file (1), genai-prices 0.1.12 (2); current price; 3 of 3 requests priced)',
    ]);
  });

  // issue #600 caching PR P correction (C1): an attempt realm has no usage figures for is a part the
  // figure leaves out, named in the attempt line's own words. The only left-out part here, with a
  // total whose fourth significant figure is not zero, so the floor is asserted. (a) red when
  // `not_measured_by_realm` is not in the lower bound, or is named in other words; (b) prints the
  // line.
  it('one attempt realm has no usage figures for, alone: a lower bound, floored, naming it', async () => {
    const run = makeRun([entry('e-current|1.239', 0), makeSnapshot('c', { agent_profile: 'p' })]);
    expect(await costLine(run)).toBe(
      'Cost: ≥ $1.23 (your economics file; current price; 1 of 1 requests priced; 1 attempt realm has no usage figures for)',
    );
  });

  // issue #600 caching PR P, the last correction (L3): the run line is a full figure — its date
  // basis and its signed net, both arms. (a) red when the run line drops the date basis, or does
  // not print what caching saved or cost; (b) prints both lines.
  it('the date basis and the net on the run line: caching saved, and caching cost more', async () => {
    const saved = makeRun([entry('e-dated|0.0307|0.0412', 0)]);
    const costMore = makeRun([entry('e-dated|0.0412|0.0307', 0)]);
    expect([await costLine(saved), await costLine(costMore)]).toEqual([
      "Cost: $0.0307 (your economics file; at the call's date; 1 of 1 requests priced); caching saved $0.0105",
      "Cost: $0.0412 (your economics file; at the call's date; 1 of 1 requests priced); caching cost $0.0105 more",
    ]);
  });

  // issue #600 caching PR P, the last correction (L3): a list figure from a custom endpoint carries
  // its note on the run line too. (a) red when the run line drops the date basis or the endpoint
  // note; (b) prints the line.
  it('a list figure through a custom endpoint: the run line names its basis and its note', async () => {
    const run = makeRun([
      makeSnapshot('s0', {
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: {
            state: 'engaged',
            basis: 'provider_reported',
            requests: [m('list|0.0412|0.0412', { endpoint: 'custom' })],
          },
        },
      }),
    ]);
    expect(await costLine(run)).toBe(
      'Cost: $0.0412 (genai-prices 0.1.12; current price; list price, your endpoint may bill differently; 1 of 1 requests priced)',
    );
  });

  // issue #600 caching PR P, the last correction (L5): a failed drive on the record with no usage
  // figures may have billed (a request that failed on the wire, a tools-step drive), and realm has
  // nothing to price for it — a part the run figure leaves out. (a) red when it does not make the
  // figure a lower bound, or is not named; (b) prints the line.
  it('a failed drive on the record with no usage figures: a lower bound, naming it', async () => {
    const run = makeRun([entry('e-current|1', 0)], {
      drive_failures: {
        first_failed_at: 'a',
        total: 1,
        entries: [
          { at: 'a', step: 's0', provider: 'p', error_class: 'other', message: 'm', elapsed_ms: 1 },
        ],
      },
    });
    expect(await costLine(run)).toBe(
      'Cost: ≥ $1.00 (your economics file; current price; 1 of 1 requests priced; 1 failed drive without usage figures)',
    );
  });

  it('a run from 0.47.0 or earlier (no model anywhere): no cost line', async () => {
    const old = makeRun([
      makeSnapshot('s', {
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: {
            state: 'engaged',
            basis: 'provider_reported',
            requests: [req({ prompt_tokens: 1, output_tokens: 1 })],
          },
        },
      }),
    ]);
    expect(await costLine(old)).toBeUndefined();
  });
});

describe('#600 caching PR P — the ride-along: stored words escaped (G11)', () => {
  // (a) red when quotedForTerminal is removed at that site; (b) prints the cache segment.
  it.each([
    ['basis', { state: 'engaged', basis: 'x\u001by' }, 'unrecognized basis "x\\u001by"'],
    ['state', { state: 'x\u001by', basis: 'provider_reported' }, 'unrecognized state "x\\u001by"'],
  ])('unrecognized %s: a control byte is escaped', async (_label, cache, expected) => {
    const out = await render({
      input_token_estimate: 1,
      precondition_trace: [],
      cache: {
        ...cache,
        requests: [req({ cache_read_input_tokens: 1, cache_creation_input_tokens: 0 })],
      } as never,
    });
    expect([out.includes(expected), out.includes('\u001b')]).toEqual([true, false]);
  });
});

describe('#600 caching PR P — the prices realm run inspect builds (G14)', () => {
  // (a) red when the reason strings are swapped, or a missing realm.yaml is taken as unreadable;
  // (b) prints the money segments.
  it('no deployment root, an invalid realm.yaml, and an absent realm.yaml (the installed list only)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-inspect-prices-'));
    try {
      const render = async (definition: WorkflowDefinition): Promise<string> =>
        stepMoney(
          await inspectRun(
            'run_test1',
            makeRunStore(
              makeRun([
                makeSnapshot('step_one', {
                  diagnostics: {
                    input_token_estimate: 1,
                    precondition_trace: [],
                    cache: {
                      state: 'engaged',
                      basis: 'provider_reported',
                      requests: [
                        req({
                          model: 'claude-sonnet-5-5',
                          prompt_tokens: 10000,
                          output_tokens: 0,
                          cache_split_offered: true,
                        }),
                      ],
                    },
                  },
                }),
              ]),
            ),
            makeWorkflowStore(definition),
            { priceSourceFor: inspectPriceSource },
          ),
        );
      const noRoot = await render(basicDef);
      writeFileSync(join(dir, 'realm.yaml'), 'version: 1\nfoo: 1\n', 'utf8');
      const invalid = await render({ ...basicDef, trust_root: dir });
      rmSync(join(dir, 'realm.yaml'));
      const absent = await render({ ...basicDef, trust_root: dir });
      expect([noRoot, invalid, absent]).toEqual([
        " | not priced (economics unreachable: the run's workflow copy records no deployment root)",
        ` | not priced (economics unreachable: '${join(dir, 'realm.yaml')}' is invalid: manifest: unknown key 'foo')`,
        ' | $0.02 (genai-prices 0.1.12; current price)',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
