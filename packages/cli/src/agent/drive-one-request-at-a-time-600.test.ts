// drive-one-request-at-a-time-600.test.ts — issue #600, caching PR 5's docs follow-up (C-4). The cache-lines
// page says: "One `realm agent` drive takes the ready steps one after the other, so it sends these two in
// turn, the second after the first response. Two drives running at once (…) can send them together."
// Both halves run here on a workflow whose two agent steps are ready at once (neither depends on the
// other), with a provider that holds every reply until the test releases it. The harness is
// agent-loop-625.test.ts's: an InMemoryStore, a workflowStore, an LlmProvider subclass, runAgent. On a
// failing host a cell prints the call count at each point: never a prompt text.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import type { AgentDeps } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';

const twoReady: WorkflowDefinition = {
  id: 'two-ready',
  name: 'two ready',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    review_a: { description: 'Review A.', execution: 'agent', depends_on: [] },
    review_b: { description: 'Review B.', execution: 'agent', depends_on: [] },
  },
};

const workflowStore = (def: WorkflowDefinition) => ({
  async register() {},
  async get() {
    return def;
  },
  async list() {
    return [def];
  },
});

/** A provider that holds each reply until the test releases it, until `releaseAll()`; after that it
 *  answers at once. `calls` counts the requests made. */
class HeldProvider extends LlmProvider {
  calls = 0;
  private holding = true;
  private readonly waiting: Array<() => void> = [];
  async callStep(): Promise<Record<string, unknown>> {
    this.calls += 1;
    if (this.holding) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    return { ok: true };
  }
  /** Releases the oldest held reply. */
  release(): void {
    this.waiting.shift()?.();
  }
  /** Releases every held reply and stops holding. */
  releaseAll(): void {
    this.holding = false;
    while (this.waiting.length > 0) this.release();
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until `ready()` holds (at most 10 s), then a settle: time for a call the drive should not make. */
async function until(ready: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!ready() && Date.now() < end) await wait(10);
  await wait(300);
}

const depsFor = (store: InMemoryStore, provider: LlmProvider): AgentDeps => ({
  store,
  workflowStore: workflowStore(twoReady),
  provider,
  registry: createDefaultRegistry(),
});

describe('C-4: one realm agent drive sends two ready steps in turn; two drives can overlap', () => {
  // ARM 1. (a) red when one drive sends the second step's request before the first reply is back (two
  // calls while the first is held), or never sends it; (b) prints the call count at each point.
  it('one drive: while the first reply is held the provider has been called once; the second call follows its release', async () => {
    const store = new InMemoryStore();
    const { run } = await store.create({
      workflowId: twoReady.id,
      workflowVersion: 1,
      params: {},
    });
    const provider = new HeldProvider();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const drive = runAgent(depsFor(store, provider), {
        definition: twoReady,
        existingRunId: run.id,
        params: {},
        inFlightPollMs: 5,
        inFlightWatchMs: 5_000,
      });
      await until(() => provider.calls >= 1);
      const whileFirstHeld = provider.calls;
      provider.release();
      await until(() => provider.calls >= 2);
      const afterFirstReleased = provider.calls;
      provider.releaseAll();
      const result = await drive;
      const completed = [...(await store.get(run.id)).completed_steps].sort();
      expect({
        whileFirstHeld,
        afterFirstReleased,
        total: provider.calls,
        result,
        completed,
      }).toEqual({
        whileFirstHeld: 1,
        afterFirstReleased: 2,
        total: 2,
        result: 'completed',
        completed: ['review_a', 'review_b'],
      });
    } finally {
      vi.restoreAllMocks();
    }
  }, 30_000);

  // ARM 2, the control: the cell can see an overlap. Two drives at once on ONE run whose two steps are
  // both ready, each drive's reply held: both requests are in flight together before either is
  // released, and both drives finish. (a) red when the two drives cannot have both requests in flight
  // (the harness would then not tell an overlap from a sequence); (b) prints each drive's call count.
  it('two drives at once: both requests are in flight before either reply is released', async () => {
    const store = new InMemoryStore();
    const { run } = await store.create({
      workflowId: twoReady.id,
      workflowVersion: 1,
      params: {},
    });
    const first = new HeldProvider();
    const second = new HeldProvider();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const options = {
        definition: twoReady,
        existingRunId: run.id,
        params: {},
        inFlightPollMs: 5,
        inFlightWatchMs: 5_000,
      };
      const drives = [
        runAgent(depsFor(store, first), options),
        runAgent(depsFor(store, second), options),
      ];
      await until(() => first.calls + second.calls >= 2);
      const inFlight = [first.calls, second.calls];
      first.releaseAll();
      second.releaseAll();
      const results = await Promise.all(drives);
      const completed = [...(await store.get(run.id)).completed_steps].sort();
      expect(
        { inFlight, results, completed },
        `calls after release: ${String(first.calls)}, ${String(second.calls)}`,
      ).toEqual({
        inFlight: [1, 1],
        results: ['completed', 'completed'],
        completed: ['review_a', 'review_b'],
      });
    } finally {
      vi.restoreAllMocks();
    }
  }, 30_000);
});
