// drive-failure-fence-715b.test.ts — issue #715 (b) 02 §D.2: the write that appends a failed drive's
// entry records what the run held at that write — its evidence count and its open question's id — so
// the `drive_failing` finding can tell whether anything was recorded since without comparing stamps.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import type { EvidenceSnapshot, RunRecord } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { recordDriveFailure } from './drive-failure.js';

const T = '2026-10-30T10:00:00.000Z';

describe('#715 (b) §D.2 — a failed drive records its fence in the write that appends it', () => {
  it('the entry carries the run’s evidence count and open question at that write; without a question, no gate_id', async () => {
    // (a) red when the write appends the entry without its fence; (b) prints both entries' fences.
    const store = new InMemoryStore();
    const evidence: EvidenceSnapshot = {
      step_id: 'a',
      started_at: T,
      completed_at: T,
      duration_ms: 0,
      input_summary: {},
      output_summary: {},
      status: 'success',
      evidence_hash: 'h',
    };
    const { record } = await store.create({ workflowId: 'w', workflowVersion: 1, params: {} });
    const entry = {
      at: T,
      step: 'draft',
      provider: 'anthropic',
      error_class: 'api_status' as const,
      message: 'rate limited',
      elapsed_ms: 10,
    };
    await recordDriveFailure(store, record.id, entry);
    const { record: once } = await store.get(record.id);
    await store.update({
      ...once,
      evidence: [evidence],
      pending_gate: { gate_id: 'g-fence', step_name: 'draft' },
    } as unknown as RunRecord);
    await recordDriveFailure(store, record.id, entry);
    const { record: twice } = await store.get(record.id);
    const fences = (twice.drive_failures?.entries ?? []).map((e) => ({
      evidence_count: e.evidence_count,
      gate_id: e.gate_id,
    }));
    expect(fences).toEqual([
      { evidence_count: 0, gate_id: undefined },
      { evidence_count: 1, gate_id: 'g-fence' },
    ]);
  });
});
