// Tests for deriveDefaultedSteps — the shared default-settled-step derivation (issue #232).
import { describe, it, expect } from 'vitest';
import { deriveDefaultedSteps } from './defaulted-steps.js';
import type { EvidenceSnapshot } from '../types/run-record.js';

function makeSnapshot(stepId: string, overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    step_id: stepId,
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    duration_ms: 1,
    input_summary: {},
    output_summary: {},
    status: 'success',
    evidence_hash: 'x',
    ...overrides,
  };
}

describe('deriveDefaultedSteps (issue #232)', () => {
  it('empty evidence → []', () => {
    expect(deriveDefaultedSteps([])).toEqual([]);
  });

  it('no default-settled entries → []', () => {
    const evidence = [
      makeSnapshot('a'),
      makeSnapshot('b', { diagnostics: { input_token_estimate: 1, precondition_trace: [] } }),
    ];
    expect(deriveDefaultedSteps(evidence)).toEqual([]);
  });

  it('one default-settled step → [step]', () => {
    const evidence = [
      makeSnapshot('draft', {
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          settled_by_default: true,
        },
      }),
    ];
    expect(deriveDefaultedSteps(evidence)).toEqual(['draft']);
  });

  it('multiple distinct default-settled steps → all present, in evidence declaration order', () => {
    const evidence = [
      makeSnapshot('first', {
        diagnostics: { input_token_estimate: 1, precondition_trace: [], settled_by_default: true },
      }),
      makeSnapshot('middle'), // not settled — excluded
      makeSnapshot('second', {
        diagnostics: { input_token_estimate: 1, precondition_trace: [], settled_by_default: true },
      }),
    ];
    expect(deriveDefaultedSteps(evidence)).toEqual(['first', 'second']);
  });

  it('dedups a step appearing in multiple settled snapshots — first-occurrence order, once only', () => {
    const evidence = [
      makeSnapshot('other'),
      makeSnapshot('draft', {
        diagnostics: { input_token_estimate: 1, precondition_trace: [], settled_by_default: true },
      }),
      makeSnapshot('draft', {
        // a second snapshot for the SAME step_id (e.g. a later evidence entry that also happens
        // to carry the diagnostic) must not duplicate the entry — deduped, first occurrence kept.
        diagnostics: { input_token_estimate: 2, precondition_trace: [], settled_by_default: true },
      }),
    ];
    expect(deriveDefaultedSteps(evidence)).toEqual(['draft']);
  });

  it('settled_by_default: false is excluded (never treated as truthy)', () => {
    const evidence = [
      makeSnapshot('draft', {
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          settled_by_default: false,
        },
      }),
    ];
    expect(deriveDefaultedSteps(evidence)).toEqual([]);
  });

  it('a snapshot with no diagnostics object at all is excluded, never throws (optional chaining)', () => {
    const evidence = [makeSnapshot('draft')]; // diagnostics undefined
    expect(() => deriveDefaultedSteps(evidence)).not.toThrow();
    expect(deriveDefaultedSteps(evidence)).toEqual([]);
  });

  it('a gate_response snapshot (no settled_by_default diagnostic) is excluded — no special-casing needed', () => {
    const evidence = [
      makeSnapshot('human_review', {
        kind: 'gate_response',
        input_summary: { choice: 'approve' },
        output_summary: { choice: 'approve' },
      }),
    ];
    expect(deriveDefaultedSteps(evidence)).toEqual([]);
  });
});
