// fence-predicate.test.ts — the fence's refusals as a literal table (issue #616 PR-0).
//
// Every refusal `evaluateFence` can throw, field by field: class, message, code, category,
// agentAction, retryable, details. Each member row is the error the former guard on `60a21eb`
// threw for the same state (checked against those guards when this table was written); the
// ENGINE_INTERNAL rows — a fence that is not a predicate, a wrong or extra field, a step fence with
// no step — are new with issue #616 PR-0, and so is the refusal both reader-backed stores throw at
// construction with no run reader (`fenceReaderMissingError`, the last block). A change to any
// message, flag or detail fails here: the published contract's FENCE_DATA cells compare a store's
// refusal with `evaluateFence`'s own, and the stores' construction cells compare with
// `fenceReaderMissingError`'s, so neither can see such a change.
import { describe, it, expect } from 'vitest';
import type { RunRecord } from '../types/run-record.js';
import { WorkflowError } from '../types/workflow-error.js';
import {
  checkFenceWithReader,
  evaluateFence,
  fenceReaderMissingError,
  readRunForFence,
  FENCE_PREDICATE_KINDS,
  isStepScopedFence,
  type FencePredicate,
  type FenceRunReader,
} from './fence-predicate.js';

const RUN_ID = 'run-1';
const STEP_ID = 'step-a';

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RUN_ID,
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 7,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    ...overrides,
  } as RunRecord;
}

/** Sealed as complete, but its persisted phase still says `running` — so the table shows the
 *  refusal reports the DERIVED phase beside the persisted one. */
const TERMINAL = run({
  terminal_state: true,
  sealed_by: { arm: 'complete' },
  terminal_reason: 'Workflow completed.',
  run_phase: 'running',
  version: 8,
} as Partial<RunRecord>);

function describeRefusal(err: unknown): Record<string, unknown> {
  if (err instanceof WorkflowError) {
    return {
      class: 'WorkflowError',
      message: err.message,
      code: err.code,
      category: err.category,
      agentAction: err.agentAction,
      retryable: err.retryable,
      details: err.details,
    };
  }
  if (err instanceof Error) return { class: err.constructor.name, message: err.message };
  return { thrown: String(err) };
}

function refusalOf(fence: unknown, record: RunRecord | null, stepId?: string): unknown {
  try {
    // Deliberately untyped: several rows pass what a plain-JavaScript caller could.
    evaluateFence(fence as FencePredicate, record, RUN_ID, stepId as string);
  } catch (err) {
    return describeRefusal(err);
  }
  return 'no refusal';
}

const NOT_ELIGIBLE = {
  class: 'WorkflowError',
  code: 'STATE_STEP_NOT_ELIGIBLE',
  category: 'STATE',
  agentAction: 'report_to_user',
  retryable: false,
};

const NOT_FOUND = {
  class: 'WorkflowError',
  message: 'Run not found: run-1',
  code: 'STATE_RUN_NOT_FOUND',
  category: 'STATE',
  agentAction: 'report_to_user',
  retryable: false,
  details: { runId: 'run-1' },
};

const NOT_A_FENCE_TAIL =
  '. A fenced trace-buffer method takes a FencePredicate — an object whose kind is one of ' +
  'step_open_for_trace, run_absent, run_absent_or_terminal, run_at_version, step_not_in_progress.';

const ENGINE_INTERNAL = {
  class: 'WorkflowError',
  code: 'ENGINE_INTERNAL',
  category: 'ENGINE',
  agentAction: 'stop',
  retryable: false,
  details: {},
};

const REFUSALS: Array<{
  label: string;
  fence: unknown;
  record: RunRecord | null;
  stepId?: string;
  expected: Record<string, unknown>;
}> = [
  {
    label: 'step_open_for_trace × the run is absent (reports the version the caller saw)',
    fence: { kind: 'step_open_for_trace', run_version: 5 },
    record: null,
    stepId: STEP_ID,
    expected: {
      ...NOT_ELIGIBLE,
      message: 'Run not found at write time — trace entries can no longer be adopted.',
      details: { step_id: 'step-a', step_state: 'run_not_found', run_version: 5 },
    },
  },
  {
    label: 'step_open_for_trace × the run is terminal (the derived phase and the persisted one)',
    fence: { kind: 'step_open_for_trace', run_version: 5 },
    record: TERMINAL,
    stepId: STEP_ID,
    expected: {
      ...NOT_ELIGIBLE,
      message: 'Run is terminal — trace entries can no longer be adopted by any step.',
      details: {
        step_id: 'step-a',
        step_state: 'run_terminal',
        run_version: 8,
        run_phase: 'completed',
        persisted_run_phase: 'running',
      },
    },
  },
  {
    label: 'step_open_for_trace × the step completed',
    fence: { kind: 'step_open_for_trace', run_version: 5 },
    record: run({ completed_steps: [STEP_ID] }),
    stepId: STEP_ID,
    expected: {
      ...NOT_ELIGIBLE,
      message: "Step 'step-a' has already completed.",
      details: { step_id: 'step-a', step_state: 'completed', run_version: 7 },
    },
  },
  {
    label: 'step_open_for_trace × the step failed',
    fence: { kind: 'step_open_for_trace', run_version: 5 },
    record: run({ failed_steps: [STEP_ID] }),
    stepId: STEP_ID,
    expected: {
      ...NOT_ELIGIBLE,
      message: "Step 'step-a' has already failed.",
      details: { step_id: 'step-a', step_state: 'failed', run_version: 7 },
    },
  },
  {
    label: 'step_open_for_trace × the step was skipped',
    fence: { kind: 'step_open_for_trace', run_version: 5 },
    record: run({ skipped_steps: [STEP_ID] }),
    stepId: STEP_ID,
    expected: {
      ...NOT_ELIGIBLE,
      message: "Step 'step-a' was skipped.",
      details: { step_id: 'step-a', step_state: 'skipped', run_version: 7 },
    },
  },
  {
    label: 'step_open_for_trace × the step is in progress (the one resolvable state)',
    fence: { kind: 'step_open_for_trace', run_version: 5 },
    record: run({ in_progress_steps: [STEP_ID] }),
    stepId: STEP_ID,
    expected: {
      ...NOT_ELIGIBLE,
      agentAction: 'resolve_precondition',
      message: "Step 'step-a' is currently being executed by execute_step.",
      details: { step_id: 'step-a', step_state: 'in_progress', run_version: 7 },
    },
  },
  {
    label: 'run_absent × the run exists again',
    fence: { kind: 'run_absent' },
    record: run(),
    expected: {
      class: 'WorkflowError',
      message: "Run 'run-1' exists again — no longer an orphan",
      code: 'STATE_RUN_RESURRECTED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { runId: 'run-1' },
    },
  },
  {
    label: 'run_absent_or_terminal × the run is live again (the reason purge prints)',
    fence: { kind: 'run_absent_or_terminal' },
    record: run(),
    expected: {
      class: 'WorkflowError',
      message: "Run 'run-1' is no longer terminal — refusing to purge its trace buffer",
      code: 'STATE_RUN_BUSY',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: true,
      details: {
        runId: 'run-1',
        reason:
          "run 'run-1' is no longer terminal (resumed since selection) — refusing to purge its trace buffer",
      },
    },
  },
  {
    label: 'run_at_version × the run moved on',
    fence: { kind: 'run_at_version', version: 6 },
    record: run(),
    expected: {
      class: 'ReclaimVersionChanged',
      message:
        "reclaim's version fence refused: run 'run-1' changed since the reclaim decision " +
        '(expected version 6, observed 7)',
    },
  },
  {
    label: 'run_at_version × the run moved back to an older version',
    fence: { kind: 'run_at_version', version: 9 },
    record: run(),
    expected: {
      class: 'ReclaimVersionChanged',
      message:
        "reclaim's version fence refused: run 'run-1' changed since the reclaim decision " +
        '(expected version 9, observed 7)',
    },
  },
  {
    label: 'run_at_version × the run is absent',
    fence: { kind: 'run_at_version', version: 6 },
    record: null,
    expected: NOT_FOUND,
  },
  {
    label: 'step_not_in_progress × the step is still in progress',
    fence: { kind: 'step_not_in_progress' },
    record: run({ in_progress_steps: [STEP_ID] }),
    stepId: STEP_ID,
    expected: {
      class: 'WorkflowError',
      message:
        "Refusing to seal trace buffer for run 'run-1' step 'step-a': the step is still " +
        'in_progress (the settling update has not yet landed) — residue-not-loss, the live WAL ' +
        'is left intact.',
      code: 'STATE_STEP_PENDING',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: true,
      details: {},
    },
  },
  {
    label: 'step_not_in_progress × the run is absent',
    fence: { kind: 'step_not_in_progress' },
    record: null,
    stepId: STEP_ID,
    expected: NOT_FOUND,
  },
  {
    label: 'not a fence: a function (the guard callback these methods took before)',
    fence: () => undefined,
    record: run(),
    stepId: STEP_ID,
    expected: {
      ...ENGINE_INTERNAL,
      message: `Not a fence predicate: got a function${NOT_A_FENCE_TAIL}`,
    },
  },
  {
    label: 'not a fence: null',
    fence: null,
    record: run(),
    stepId: STEP_ID,
    expected: { ...ENGINE_INTERNAL, message: `Not a fence predicate: got null${NOT_A_FENCE_TAIL}` },
  },
  {
    label: 'not a fence: an unknown kind',
    fence: { kind: 'step_open' },
    record: run(),
    stepId: STEP_ID,
    expected: {
      ...ENGINE_INTERNAL,
      message: `Not a fence predicate: got an object with kind 'step_open'${NOT_A_FENCE_TAIL}`,
    },
  },
  {
    label: 'not a fence: an object with no kind',
    fence: {},
    record: run(),
    stepId: STEP_ID,
    expected: {
      ...ENGINE_INTERNAL,
      message: `Not a fence predicate: got an object with no kind${NOT_A_FENCE_TAIL}`,
    },
  },
  {
    label: 'not a fence: undefined (the fence left out)',
    fence: undefined,
    record: run(),
    stepId: STEP_ID,
    expected: {
      ...ENGINE_INTERNAL,
      message: `Not a fence predicate: got undefined${NOT_A_FENCE_TAIL}`,
    },
  },
  {
    label: 'not a fence: a number',
    fence: 7,
    record: run(),
    stepId: STEP_ID,
    expected: {
      ...ENGINE_INTERNAL,
      message: `Not a fence predicate: got a number${NOT_A_FENCE_TAIL}`,
    },
  },
  {
    label: 'not a fence: an object with a non-string kind',
    fence: { kind: 7 },
    record: run(),
    stepId: STEP_ID,
    expected: {
      ...ENGINE_INTERNAL,
      message: `Not a fence predicate: got an object with a non-string kind${NOT_A_FENCE_TAIL}`,
    },
  },
  {
    label: 'a step member with no step: step_not_in_progress (the run-wide method)',
    fence: { kind: 'step_not_in_progress' },
    record: run(),
    expected: {
      ...ENGINE_INTERNAL,
      message:
        "A 'step_not_in_progress' fence conditions one step, and no step was given: pass it to a " +
        "per-step operation (appendFenced, deleteFenced, sealFenced) with that step's id — the " +
        'run-wide deleteAllForRunFenced takes no step.',
    },
  },
  {
    label: 'a step member with no step: step_open_for_trace',
    fence: { kind: 'step_open_for_trace', run_version: 5 },
    record: run(),
    expected: {
      ...ENGINE_INTERNAL,
      message:
        "A 'step_open_for_trace' fence conditions one step, and no step was given: pass it to a " +
        "per-step operation (appendFenced, deleteFenced, sealFenced) with that step's id — the " +
        'run-wide deleteAllForRunFenced takes no step.',
    },
  },
  {
    label: 'a wrong field: a step_id (a fence never names its target)',
    fence: { kind: 'step_open_for_trace', run_version: 5, step_id: 'step-b' },
    record: run(),
    stepId: STEP_ID,
    expected: {
      ...ENGINE_INTERNAL,
      message:
        "Invalid 'step_open_for_trace' fence: it has a 'step_id' field — a fence never names its " +
        "target; the step is the fenced method's own.",
    },
  },
  {
    label: 'a wrong field: an unexpected field on a member that takes none',
    fence: { kind: 'run_absent', version: 3 },
    record: run(),
    expected: {
      ...ENGINE_INTERNAL,
      message: "Invalid 'run_absent' fence: it has an unexpected 'version' field.",
    },
  },
  {
    label: 'a wrong field: a missing version',
    fence: { kind: 'run_at_version' },
    record: run(),
    expected: {
      ...ENGINE_INTERNAL,
      message: "Invalid 'run_at_version' fence: version must be a non-negative integer (got none).",
    },
  },
  {
    label: 'a wrong field: a version given as a string',
    fence: { kind: 'run_at_version', version: '7' },
    record: run(),
    expected: {
      ...ENGINE_INTERNAL,
      message: "Invalid 'run_at_version' fence: version must be a non-negative integer (got '7').",
    },
  },
  {
    label: 'a wrong field: a negative run_version',
    fence: { kind: 'step_open_for_trace', run_version: -1 },
    record: run(),
    stepId: STEP_ID,
    expected: {
      ...ENGINE_INTERNAL,
      message:
        "Invalid 'step_open_for_trace' fence: run_version must be a non-negative integer (got -1).",
    },
  },
  {
    label: 'a wrong field: a version that is not an integer',
    fence: { kind: 'run_at_version', version: 1.5 },
    record: run(),
    expected: {
      ...ENGINE_INTERNAL,
      message: "Invalid 'run_at_version' fence: version must be a non-negative integer (got 1.5).",
    },
  },
  {
    label: 'a wrong field: a run_version of NaN',
    fence: { kind: 'step_open_for_trace', run_version: NaN },
    record: run(),
    stepId: STEP_ID,
    expected: {
      ...ENGINE_INTERNAL,
      message:
        "Invalid 'step_open_for_trace' fence: run_version must be a non-negative integer (got NaN).",
    },
  },
  {
    label: 'a wrong field: a version given as null',
    fence: { kind: 'run_at_version', version: null },
    record: run(),
    expected: {
      ...ENGINE_INTERNAL,
      message: "Invalid 'run_at_version' fence: version must be a non-negative integer (got null).",
    },
  },
  {
    label: 'a wrong field: a version given as an object',
    fence: { kind: 'run_at_version', version: {} },
    record: run(),
    expected: {
      ...ENGINE_INTERNAL,
      message:
        "Invalid 'run_at_version' fence: version must be a non-negative integer (got an object).",
    },
  },
  {
    label: 'a wrong field: a version given as an array',
    fence: { kind: 'run_at_version', version: [3] },
    record: run(),
    expected: {
      ...ENGINE_INTERNAL,
      message:
        "Invalid 'run_at_version' fence: version must be a non-negative integer (got an array).",
    },
  },
  {
    label: 'a wrong field: a version given as a boolean',
    fence: { kind: 'run_at_version', version: true },
    record: run(),
    expected: {
      ...ENGINE_INTERNAL,
      message:
        "Invalid 'run_at_version' fence: version must be a non-negative integer (got a boolean).",
    },
  },
];

const PASSES: Array<{
  label: string;
  fence: FencePredicate;
  record: RunRecord | null;
  stepId?: string;
}> = [
  {
    label: 'step_open_for_trace × a live run with the step in no set',
    fence: { kind: 'step_open_for_trace', run_version: 5 },
    record: run(),
    stepId: STEP_ID,
  },
  { label: 'run_absent × the run is absent', fence: { kind: 'run_absent' }, record: null },
  {
    label: 'run_absent_or_terminal × the run is absent',
    fence: { kind: 'run_absent_or_terminal' },
    record: null,
  },
  {
    label: 'run_absent_or_terminal × the run is terminal',
    fence: { kind: 'run_absent_or_terminal' },
    record: TERMINAL,
  },
  {
    label: 'run_at_version × the run is at that version',
    fence: { kind: 'run_at_version', version: 7 },
    record: run(),
  },
  {
    label: 'step_not_in_progress × the step has left in_progress_steps',
    fence: { kind: 'step_not_in_progress' },
    record: run({ completed_steps: [STEP_ID] }),
    stepId: STEP_ID,
  },
];

describe('evaluateFence — every refusal, field by field (issue #616 PR-0)', () => {
  for (const row of REFUSALS) {
    it(`refuses: ${row.label}`, () => {
      expect(refusalOf(row.fence, row.record, row.stepId)).toEqual(row.expected);
    });
  }

  for (const row of PASSES) {
    it(`passes: ${row.label}`, () => {
      expect(refusalOf(row.fence, row.record, row.stepId)).toBe('no refusal');
    });
  }

  it('a step member is evaluated against the step it is given, never another', () => {
    // The step the fence is evaluated against is the fenced method's own: a completed OTHER step
    // does not refuse, the given step does.
    const record = run({ completed_steps: ['step-b'] });
    expect(refusalOf({ kind: 'step_open_for_trace', run_version: 5 }, record, STEP_ID)).toBe(
      'no refusal',
    );
    expect(refusalOf({ kind: 'step_open_for_trace', run_version: 5 }, record, 'step-b')).toEqual({
      ...NOT_ELIGIBLE,
      message: "Step 'step-b' has already completed.",
      details: { step_id: 'step-b', step_state: 'completed', run_version: 7 },
    });
  });

  it('isStepScopedFence is true for exactly the two step members', () => {
    expect(
      FENCE_PREDICATE_KINDS.filter((kind) => isStepScopedFence({ kind } as FencePredicate)),
    ).toEqual(['step_open_for_trace', 'step_not_in_progress']);
  });

  it('FENCE_PREDICATE_KINDS names the five members in declaration order', () => {
    expect(FENCE_PREDICATE_KINDS).toEqual([
      'step_open_for_trace',
      'run_absent',
      'run_absent_or_terminal',
      'run_at_version',
      'step_not_in_progress',
    ]);
  });
});

describe('readRunForFence — the reader’s own "run not found" (FENCE_REQUIRES_RUN)', () => {
  // A reader whose not-found is shaped differently from core's `runNotFoundError`, so the two
  // treatments below can be told apart.
  const readerNotFound = new WorkflowError('the other store has no run-1', {
    code: 'STATE_RUN_NOT_FOUND',
    category: 'STATE',
    agentAction: 'stop',
    retryable: false,
    details: { store: 'other' },
  });
  const goneReader: FenceRunReader = {
    get: async () => {
      throw readerNotFound;
    },
  };

  it('the two members that require the run let the reader’s own error through, unchanged', async () => {
    for (const fence of [
      { kind: 'run_at_version', version: 1 },
      { kind: 'step_not_in_progress' },
    ] satisfies FencePredicate[]) {
      await expect(readRunForFence(goneReader, RUN_ID, fence), fence.kind).rejects.toBe(
        readerNotFound,
      );
    }
  });

  it('the three members that tolerate absence read it as "no run"', async () => {
    for (const fence of [
      { kind: 'step_open_for_trace', run_version: 1 },
      { kind: 'run_absent' },
      { kind: 'run_absent_or_terminal' },
    ] satisfies FencePredicate[]) {
      await expect(readRunForFence(goneReader, RUN_ID, fence), fence.kind).resolves.toBeNull();
    }
  });

  it('any other read failure propagates unchanged, for every member', async () => {
    const readFailure = new Error('EACCES reading run-1');
    const failingReader: FenceRunReader = {
      get: async () => {
        throw readFailure;
      },
    };
    for (const fence of [
      { kind: 'step_open_for_trace', run_version: 1 },
      { kind: 'run_absent' },
      { kind: 'run_absent_or_terminal' },
      { kind: 'run_at_version', version: 1 },
      { kind: 'step_not_in_progress' },
    ] satisfies FencePredicate[]) {
      await expect(readRunForFence(failingReader, RUN_ID, fence), fence.kind).rejects.toBe(
        readFailure,
      );
    }
  });
});

describe('checkFenceWithReader — a malformed fence never costs a read', () => {
  it('refuses before the reader is called', async () => {
    let reads = 0;
    const countingReader: FenceRunReader = {
      get: async () => {
        reads += 1;
        return run();
      },
    };
    for (const [label, fence, stepId] of [
      ['a function', () => undefined, STEP_ID],
      ['null', null, STEP_ID],
      ['an unknown kind', { kind: 'step_open' }, STEP_ID],
      ['step_not_in_progress with no step', { kind: 'step_not_in_progress' }, undefined],
      [
        'step_open_for_trace with no step',
        { kind: 'step_open_for_trace', run_version: 1 },
        undefined,
      ],
      ['a step_id field', { kind: 'step_open_for_trace', run_version: 1, step_id: 'x' }, STEP_ID],
      ['a missing version', { kind: 'run_at_version' }, undefined],
    ] as Array<[string, unknown, string | undefined]>) {
      await expect(
        // Deliberately untyped: each is what a plain-JavaScript caller could pass.
        checkFenceWithReader(countingReader, RUN_ID, fence as FencePredicate, stepId as string),
        label,
      ).rejects.toMatchObject({ code: 'ENGINE_INTERNAL' });
    }
    expect(reads).toBe(0);
  });
});

describe('fenceReaderMissingError — the refusal at construction, field by field', () => {
  it('names the store and says what to construct it with', () => {
    for (const storeName of ['JsonTraceBufferStore', 'InMemoryTraceBufferStore']) {
      expect(describeRefusal(fenceReaderMissingError(storeName)), storeName).toEqual({
        ...ENGINE_INTERNAL,
        message:
          `${storeName} was constructed without a run reader, so it cannot evaluate a fence ` +
          'predicate — construct it with the run store the fenced write must be checked against.',
      });
    }
  });
});
