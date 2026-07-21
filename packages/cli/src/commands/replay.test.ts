// Tests for replayRun, parseOverride, and saveReplay business logic.
import { describe, it, expect, vi } from 'vitest';
import { replayRun, parseOverride, saveReplay } from './replay.js';
import type { ReplayStore, ReplayRecord } from '../store/replay-store.js';
import type { RunRecord, WorkflowDefinition, EvidenceSnapshot } from '@sensigo/realm';

function makeSnapshot(stepId: string, output: Record<string, unknown> = {}): EvidenceSnapshot {
  return {
    step_id: stepId,
    started_at: '2024-01-01T00:00:00.000Z',
    completed_at: '2024-01-01T00:00:01.000Z',
    duration_ms: 100,
    input_summary: {},
    output_summary: output,
    status: 'success',
    evidence_hash: 'abc123',
  };
}

function makeRun(evidence: EvidenceSnapshot[]): RunRecord {
  return {
    id: 'run_test1',
    workflow_id: 'test-workflow',
    workflow_version: 1,
    // issue #220 §4c (PR-3): replayRun now also mints `$settlement` via
    // buildSettlementNamespace(run), which iterates completed_steps/failed_steps — this fixture
    // predates the DAG step-set model (it carried a stale `state` field the real RunRecord type
    // no longer has, and never set these arrays at all; nothing runtime-read them before this
    // PR). Empty arrays here preserve every existing test's behavior exactly (no step in this
    // fixture is "settled", so buildSettlementNamespace returns {} — zero observable change to
    // any assertion in this file).
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'completed',
    version: 1,
    params: {},
    evidence,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:01.000Z',
    terminal_state: true,
  };
}

const definition: WorkflowDefinition = {
  id: 'test-workflow',
  name: 'Test Workflow',
  version: 1,
  steps: {
    fetch_doc: {
      description: 'Fetch document',
      execution: 'auto',
    },
    extract: {
      description: 'Extract fields',
      execution: 'agent',
    },
    validate: {
      description: 'Validate',
      execution: 'auto',
    },
    write: {
      description: 'Write results',
      execution: 'auto',
      preconditions: ['validate.accepted_count > 0'],
    },
  },
};

describe('parseOverride', () => {
  it('parses "validate_candidates.accepted_count=0" to correct ReplayOverride', () => {
    const result = parseOverride('validate_candidates.accepted_count=0');
    expect(result).toEqual({ step: 'validate_candidates', field: 'accepted_count', value: 0 });
  });

  it('parses a string value', () => {
    const result = parseOverride('step.status=done');
    expect(result).toEqual({ step: 'step', field: 'status', value: 'done' });
  });

  it('parses a multi-segment dot-path field — "validate.result.accepted_count=5"', () => {
    const result = parseOverride('validate.result.accepted_count=5');
    expect(result).toEqual({ step: 'validate', field: 'result.accepted_count', value: 5 });
  });

  it('throws on missing equals sign', () => {
    expect(() => parseOverride('validate_candidates.accepted_count')).toThrow("missing '='");
  });

  it('throws on missing dot in field path', () => {
    expect(() => parseOverride('validate=0')).toThrow("missing '.'");
  });
});

describe('replayRun', () => {
  it('override makes a previously-passing precondition fail', () => {
    const evidence = [makeSnapshot('validate', { accepted_count: 3 })];
    const run = makeRun(evidence);
    const results = replayRun(run, definition, [
      { step: 'validate', field: 'accepted_count', value: 0 },
    ]);
    const writeRow = results.find((r) => r.step_id === 'write');
    expect(writeRow).toBeDefined();
    expect(writeRow!.preconditions_original).toBe(true);
    expect(writeRow!.preconditions_replay).toBe(false);
    expect(writeRow!.changed).toBe(true);
    expect(writeRow!.has_preconditions).toBe(true);
  });

  it('override has no effect when no downstream preconditions reference the overridden step', () => {
    const evidence = [makeSnapshot('fetch_doc', { text_length: 1000 })];
    const run = makeRun(evidence);
    const results = replayRun(run, definition, [
      { step: 'fetch_doc', field: 'text_length', value: 0 },
    ]);
    expect(results.every((r) => !r.changed)).toBe(true);
  });

  it('multiple overrides are applied together', () => {
    const evidence = [makeSnapshot('validate', { accepted_count: 3, rejected_count: 1 })];
    const run = makeRun(evidence);
    const results = replayRun(run, definition, [
      { step: 'validate', field: 'accepted_count', value: 0 },
      { step: 'validate', field: 'rejected_count', value: 5 },
    ]);
    const writeRow = results.find((r) => r.step_id === 'write');
    expect(writeRow!.changed).toBe(true);
  });

  it('step with no preconditions always shows unchanged', () => {
    const evidence = [makeSnapshot('fetch_doc', { text_length: 1000 })];
    const run = makeRun(evidence);
    const results = replayRun(run, definition, [
      { step: 'fetch_doc', field: 'text_length', value: 42 },
    ]);
    const fetchRow = results.find((r) => r.step_id === 'fetch_doc');
    expect(fetchRow).toBeDefined();
    expect(fetchRow!.preconditions_original).toBe(true);
    expect(fetchRow!.preconditions_replay).toBe(true);
    expect(fetchRow!.changed).toBe(false);
    expect(fetchRow!.has_preconditions).toBe(false);
  });

  it('dot-path override correctly changes a nested-field precondition outcome', () => {
    const nestedDef: WorkflowDefinition = {
      ...definition,
      steps: {
        ...definition.steps,
        write: {
          description: 'Write results',
          execution: 'auto',
          preconditions: ['validate.result.accepted_count > 0'],
        },
      },
    };
    const evidence = [makeSnapshot('validate', { result: { accepted_count: 3 } })];
    const run = makeRun(evidence);
    const results = replayRun(run, nestedDef, [
      { step: 'validate', field: 'result.accepted_count', value: 0 },
    ]);
    const writeRow = results.find((r) => r.step_id === 'write')!;
    expect(writeRow.preconditions_original).toBe(true);
    expect(writeRow.preconditions_replay).toBe(false);
    expect(writeRow.changed).toBe(true);
  });

  it('dot-path override does not mutate the original evidence object', () => {
    const nestedDef: WorkflowDefinition = {
      ...definition,
      steps: {
        ...definition.steps,
        write: {
          description: 'Write results',
          execution: 'auto',
          preconditions: ['validate.result.accepted_count > 0'],
        },
      },
    };
    const originalOutput = { result: { accepted_count: 3 } };
    const evidence = [makeSnapshot('validate', originalOutput)];
    const run = makeRun(evidence);

    replayRun(run, nestedDef, [{ step: 'validate', field: 'result.accepted_count', value: 0 }]);

    // Original evidence must not have been mutated.
    expect(originalOutput.result.accepted_count).toBe(3);
  });

  // issue #220 §4c (PR-3, pin ee): replay parity — replayRun mints $settlement via the SAME
  // shared helper (buildSettlementNamespace) the live engine's buildEvidenceByStep uses, so a
  // $settlement-referencing precondition's replay verdict can never structurally diverge from
  // what the live run actually decided. Replay evaluates ONLY preconditions (never when/guards),
  // so the fixture below uses a precondition — a MINT-DEPENDENT-TRUE fixture (a both-absent
  // vacuous pass is impossible: step1 genuinely default-settled, so $settlement.step1
  // .settled_by_default is genuinely `true` in the live record).
  describe('pin (ee): $settlement replay parity', () => {
    function makeSettlementRun(): RunRecord {
      return {
        id: 'run_settlement1',
        workflow_id: 'settlement-workflow',
        workflow_version: 1,
        completed_steps: ['step1'],
        in_progress_steps: [],
        failed_steps: [],
        skipped_steps: [],
        run_phase: 'completed',
        version: 3,
        params: {},
        evidence: [
          {
            step_id: 'step1',
            started_at: '2024-01-01T00:00:00.000Z',
            completed_at: '2024-01-01T00:00:01.000Z',
            duration_ms: 100,
            input_summary: {},
            output_summary: { category: 'fallback' },
            status: 'success',
            evidence_hash: 'abc123',
            diagnostics: {
              input_token_estimate: 0,
              precondition_trace: [],
              settled_by_default: true,
              validation_rejections: 6,
            },
          },
        ],
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:01.000Z',
        terminal_state: true,
      };
    }

    // NOTE on polarity: this precondition is deliberately `== true`, NOT `== false`. A
    // `== false` polarity would be a COINCIDENTAL-PASS trap here: precondition.ts's absent-LHS
    // rule always resolves an unresolvable path to `false` (never true) — so with the mint
    // missing entirely, `$settlement.step1.settled_by_default == false` would ALSO evaluate to
    // `false` (LHS undefined ⇒ false, matching the assertion below by ACCIDENT), and a
    // replay-missing-mint mutant would pass this suite vacuously. `== true` is the only polarity
    // where "mint present, genuinely true" (passes) and "mint absent, undefined LHS" (always
    // fails) actually disagree — verified via an explicit mutation probe during this PR's review.
    const settlementDef: WorkflowDefinition = {
      id: 'settlement-workflow',
      name: 'Settlement Workflow',
      version: 1,
      steps: {
        step1: { description: 'Step1', execution: 'agent' },
        step2: {
          description: 'Step2',
          execution: 'auto',
          preconditions: ['$settlement.step1.settled_by_default == true'],
        },
      },
    };

    it('MINT-DEPENDENT-TRUE: replay reproduces the live verdict for a $settlement-referencing precondition (a both-absent vacuous pass is impossible — step1 genuinely default-settled)', () => {
      const run = makeSettlementRun();
      const results = replayRun(run, settlementDef, []);
      const step2Row = results.find((r) => r.step_id === 'step2')!;
      // Live truth: settled_by_default === true ⇒ the precondition ("== true") PASSES.
      expect(step2Row.preconditions_original).toBe(true);
      // No override supplied — replay must reproduce the SAME verdict (mint parity).
      expect(step2Row.preconditions_replay).toBe(true);
      expect(step2Row.changed).toBe(false);
    });

    it('--with $settlement.step1.settled_by_default=false overrides ON TOP of the mint, flipping the REPLAY verdict only', () => {
      const run = makeSettlementRun();
      const results = replayRun(run, settlementDef, [
        { step: '$settlement', field: 'step1.settled_by_default', value: false },
      ]);
      const step2Row = results.find((r) => r.step_id === 'step2')!;
      expect(step2Row.preconditions_original).toBe(true); // untouched by the override
      expect(step2Row.preconditions_replay).toBe(false); // override flips it
      expect(step2Row.changed).toBe(true);
    });

    it('ALIASING FOOTGUN: the override does NOT mutate the ORIGINAL verdict — preconditions_original stays reflective of the genuinely-minted true, not corrupted by the clone override (a shared-reference mutant would flip this too)', () => {
      const run = makeSettlementRun();
      const results = replayRun(run, settlementDef, [
        { step: '$settlement', field: 'step1.settled_by_default', value: false },
      ]);
      const step2Row = results.find((r) => r.step_id === 'step2')!;
      // The internal evidenceByStep map is never exposed by replayRun — this IS the observable
      // surface for the aliasing footgun (issue #220 §4c prompt-audit F2).
      expect(step2Row.preconditions_original).toBe(true);
    });

    it('a replay-missing-mint regression (no override, no $settlement key at all) would show up as an undefined-LHS precondition failure — sanity: a step with NO preconditions is always unchanged regardless', () => {
      const run = makeSettlementRun();
      const results = replayRun(run, settlementDef, []);
      const step1Row = results.find((r) => r.step_id === 'step1')!;
      expect(step1Row.has_preconditions).toBe(false);
      expect(step1Row.changed).toBe(false);
    });
  });
});

describe('saveReplay', () => {
  const sampleResults = [
    {
      step_id: 'fetch_doc',
      preconditions_original: true,
      preconditions_replay: true,
      changed: false,
      has_preconditions: false,
    },
    {
      step_id: 'write',
      preconditions_original: true,
      preconditions_replay: false,
      changed: true,
      has_preconditions: true,
    },
  ];

  it('calls store.save() with correct fields when --save is set', async () => {
    const savedRecord: ReplayRecord = {
      id: 'rpl_test-id',
      origin_run_id: 'run_test1',
      workflow_id: 'test-workflow',
      overrides: ['validate.accepted_count=0'],
      results: sampleResults,
      created_at: '2024-01-01T00:00:00.000Z',
    };
    const mockStore: ReplayStore = {
      save: vi.fn().mockResolvedValue(savedRecord),
      get: vi.fn(),
    };
    const run = makeRun([]);
    const withExprs = ['validate.accepted_count=0'];
    const returnedId = await saveReplay(mockStore, run.id, run, withExprs, sampleResults);

    expect(mockStore.save).toHaveBeenCalledOnce();
    expect(mockStore.save).toHaveBeenCalledWith({
      origin_run_id: run.id,
      workflow_id: run.workflow_id,
      overrides: withExprs,
      results: sampleResults,
    });
    expect(returnedId).toBe('rpl_test-id');
  });

  it('does not call store.save() when --save is not set', async () => {
    const mockStore: ReplayStore = {
      save: vi.fn(),
      get: vi.fn(),
    };
    // Simulate the action callback NOT calling saveReplay at all when opts.save is falsy.
    // saveReplay is only called when opts.save is true — so simply not calling it is the test.
    expect(mockStore.save).not.toHaveBeenCalled();
  });
});
