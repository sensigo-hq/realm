import { describe, it, expect } from 'vitest';
import type { RunRecord, EvidenceSnapshot } from './run-record.js';

describe('RunRecord', () => {
  it('accepts a valid run record', () => {
    const record: RunRecord = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      workflow_id: 'test-workflow',
      workflow_version: 1,
      version: 0,
      params: { input: 'value' },
      evidence: [],
      created_at: '2026-04-01T00:00:00.000Z',
      updated_at: '2026-04-01T00:00:00.000Z',
      terminal_state: false,
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      run_phase: 'running',
    };
    expect(record.id).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(record.evidence).toHaveLength(0);
    expect(record.terminal_state).toBe(false);
  });

  it('accepts an EvidenceSnapshot', () => {
    const snapshot: EvidenceSnapshot = {
      step_id: 'step-one',
      started_at: '2026-04-01T00:00:00.000Z',
      completed_at: '2026-04-01T00:00:01.000Z',
      duration_ms: 1000,
      input_summary: { key: 'val' },
      output_summary: { result: true },
      status: 'success',
      evidence_hash: 'abc123',
    };
    expect(snapshot.status).toBe('success');
    expect(snapshot.error).toBeUndefined();
  });

  it('round-trips through JSON serialization', () => {
    const record: RunRecord = {
      id: 'run-1',
      workflow_id: 'wf',
      workflow_version: 1,
      version: 0,
      params: {},
      evidence: [],
      created_at: '2026-04-01T00:00:00.000Z',
      updated_at: '2026-04-01T00:00:00.000Z',
      terminal_state: false,
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      run_phase: 'running',
    };
    const parsed: RunRecord = JSON.parse(JSON.stringify(record)) as RunRecord;
    expect(parsed).toEqual(record);
  });
});
