// ended-run-refusal.test.ts — #744 follow-up E1: the refusal `realm agent --run-id` gives a run
// that has ended. Both carriers throw it — the pre-attach check (`resolveRunAttach`) and the agent
// loop (`runAgent`). #729 PR-0 (E1 (d), (e), (j)): it is the run-a-step family's `run_ended` — "Run
// <id> has already ended (<phase>)", the phase worked out from the record (PHASE_IS_GENERATED), then
// who ended it from the record; Realm's sentence ends with Realm's stop; a recorded reason is stored
// text, printed on its own line after `Reason:` through the one escaped, bounded value renderer,
// with no stop added (a completed run's reason restates its phase and is not printed); the cleanup
// steps left pending end their own line with the command, no stop after it. Every cell asserts the
// whole message.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { declared } from '../test-support/declared.js';
import { resolveRunAttach, terminalRunRefusal } from './run-attach.js';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import type { loadProjectExtensions } from '../extensions/load-project-extensions.js';

const DEFINITION: WorkflowDefinition = {
  id: 'ended-wf',
  name: 'Ended WF',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { s1: { description: 'step', execution: 'agent', depends_on: [] } },
  origin: 'human',
};

/**
 * A run ended by `end`. The record is changed in place on the object `store.get` returns, as
 * `run-attach.test.ts` does: a fresh-object terminal write is refused STATE_SEAL_UNSTAMPED.
 */
async function endedRun(store: InMemoryStore, end: (run: RunRecord) => void): Promise<string> {
  const { run } = await store.create({ workflowId: DEFINITION.id, workflowVersion: 1, params: {} });
  const record = await store.get(run.id);
  end(record);
  await store.update(record);
  return run.id;
}

/** The pre-attach carrier: the refusal is thrown before any extension code loads. */
const attach = (store: InMemoryStore, runId: string) =>
  resolveRunAttach(runId, {
    store,
    workflowStore: declared({ get: async () => DEFINITION }),
    loadExtensions: vi.fn() as unknown as typeof loadProjectExtensions,
  });

/** The agent-loop carrier: `runAgent` with `existingRunId` and the definition. */
const agent = (store: InMemoryStore, runId: string) =>
  runAgent(
    {
      store,
      workflowStore: {
        async register() {},
        async get() {
          return DEFINITION;
        },
        async list() {
          return [DEFINITION];
        },
      },
      provider: new (class extends LlmProvider {
        callStep = vi.fn();
      })(),
      registry: createDefaultRegistry(),
    },
    { definition: DEFINITION, existingRunId: runId, params: {} },
  );

const completed = (run: RunRecord): void => {
  run.terminal_state = true;
  run.terminal_reason = 'Workflow completed.';
};

// (a) red when the refusal adds a stop to stored text or after a command, renders the stored phase,
//     or a carrier's message differs from the other's; (b) prints the whole message.
describe('E1 — the ended-run refusal, one mark, on both carriers', () => {
  it('E1 R1: a completed run, through the pre-attach check', async () => {
    const store = new InMemoryStore();
    const runId = await endedRun(store, completed);
    await expect(attach(store, runId)).rejects.toHaveProperty(
      'message',
      `Run ${runId} has already ended (completed).`,
    );
  });

  it('E1 R1-agent: the same run, through the agent loop — the same message', async () => {
    const store = new InMemoryStore();
    const runId = await endedRun(store, completed);
    await expect(agent(store, runId)).rejects.toHaveProperty(
      'message',
      `Run ${runId} has already ended (completed).`,
    );
  });

  it('E1 R2: a completed run with a pending finalizer keeps the drain hint after one stop', async () => {
    const store = new InMemoryStore();
    const runId = await endedRun(store, (run) => {
      completed(run);
      run.finalizer_ledger = { fin: { status: 'pending', rank: 0 } };
    });
    await expect(attach(store, runId)).rejects.toHaveProperty(
      'message',
      `Run ${runId} has already ended (completed).\n1 cleanup step is not yet delivered — to deliver it: realm run drain ${runId}`,
    );
  });

  it('E1 R3: a reason is stored text — after its label, as written, no stop added', async () => {
    const store = new InMemoryStore();
    const runId = await endedRun(store, (run) => {
      run.terminal_state = true;
      run.terminal_reason = 'spawn_failed';
    });
    await expect(attach(store, runId)).rejects.toHaveProperty(
      'message',
      `Run ${runId} has already ended (failed).\nReason: "spawn_failed"`,
    );
  });

  // The store writes `run_phase` as derived on every update (`in-memory-store.ts:141-144`), so R4
  // cannot tell a stored phase from a derived one; R8 pins the derivation.
  it('E1 R4: no recorded reason — the phase', async () => {
    const store = new InMemoryStore();
    const runId = await endedRun(store, (run) => {
      run.terminal_state = true;
      run.aborted_at = { step_id: 's1' };
    });
    await expect(attach(store, runId)).rejects.toHaveProperty(
      'message',
      `Run ${runId} has already ended (aborted).`,
    );
  });

  it('E1 R8: the mint renders the phase worked out from the record, never a stale stored one', () => {
    const rec = {
      id: 'r1',
      workflow_id: DEFINITION.id,
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
      terminal_state: true,
      aborted_at: { step_id: 's1' },
    } as RunRecord;
    expect(terminalRunRefusal('r1', rec).message).toBe('Run r1 has already ended (aborted).');
  });

  it('E1 R6: a reason that ends with a question mark is printed as written — no stop added; who ended the run from the record', async () => {
    const store = new InMemoryStore();
    const runId = await endedRun(store, (run) => {
      run.terminal_state = true;
      run.terminal_reason = 'Held?';
    });
    await expect(attach(store, runId)).rejects.toHaveProperty(
      'message',
      `Run ${runId} has already ended (abandoned): an operator ended it.\nReason: "Held?"`,
    );
  });
});
