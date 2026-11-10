// drive-failure-fence-715b.test.ts — issue #715 (b) 02 §D.2: the write that appends a failed drive's
// entry records what the run held at that write — its evidence count and its open question's id — so
// the `drive_failing` finding can tell whether anything was recorded since without comparing stamps.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it, vi } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  type EvidenceSnapshot,
  type RunRecord,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { recordDriveFailure } from './drive-failure.js';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { runsOf } from '../test-support/temp-home.js';

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

describe('#715 (b) §D.2 — a drive failure’s instant is the store’s clock (census class `event`)', () => {
  it('a provider that throws: the run’s drive_failures entry is stamped at the store’s reading (2030), not the host’s', async () => {
    // (a) red when the drive stamps the entry with `new Date()` (today: the host's clock); (b) prints
    //     the entry's `at` and the first failure's.
    const def = {
      id: 'drive-at-715b',
      name: 'drive-at-715b',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { draft: { description: 'Draft.', execution: 'agent' as const, depends_on: [] } },
    };
    const clock = settableClock(new Date('2030-01-01T00:00:00.000Z'));
    const store = new InMemoryStore({ clock });
    const provider = new (class extends LlmProvider {
      callStep = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));
    })();
    for (const kind of ['log', 'error', 'warn'] as const)
      vi.spyOn(console, kind).mockImplementation(() => {});
    try {
      await runAgent(
        {
          store,
          workflowStore: {
            async register() {},
            async get() {
              return def;
            },
            async list() {
              return [def];
            },
          },
          provider,
          registry: createDefaultRegistry(),
        },
        { definition: def, params: {} },
      );
    } finally {
      vi.restoreAllMocks();
    }
    const runs = (await runsOf(store)).map((s) => s.record as RunRecord);
    const field = runs[0]?.drive_failures;
    expect({ at: field?.entries[0]?.at, first: field?.first_failed_at }).toEqual({
      at: '2030-01-01T00:00:00.000Z',
      first: '2030-01-01T00:00:00.000Z',
    });
  });
});
