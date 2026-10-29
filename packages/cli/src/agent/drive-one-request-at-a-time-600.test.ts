// drive-one-request-at-a-time-600.test.ts — issue #600, caching PR 5's docs follow-up (C-4) and its
// correction 1. The cache-lines page says: "One `realm agent` drive takes the ready steps one after the
// other, so it sends these two in turn, the second after the first response. Runs started together (for
// example by `realm listen`) each have their own drive, and each sends its own steps in turn. But the
// runs overlap: the first step of two such runs goes out at the same moment, …" Both halves run here, on
// a workflow whose two agent steps are ready at once (neither depends on the other), with a provider
// that holds every reply until the test releases it and labels each call by its step. The harness is
// agent-loop-625.test.ts's: an InMemoryStore, a workflowStore, an LlmProvider subclass, runAgent. On a
// failing host a cell prints each provider's call count and call labels at each point: never a prompt
// text.
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
 *  answers at once. `calls` counts the requests made; `labels` names each request's step, found from
 *  its prompt (the step's description): `review_a`, `review_b`, or `?` for neither. */
class HeldProvider extends LlmProvider {
  calls = 0;
  readonly labels: string[] = [];
  private holding = true;
  private readonly waiting: Array<() => void> = [];
  async callStep(prompt: string): Promise<Record<string, unknown>> {
    this.calls += 1;
    this.labels.push(
      prompt.includes('Review A.') ? 'review_a' : prompt.includes('Review B.') ? 'review_b' : '?',
    );
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

describe('C-4: one realm agent drive sends two ready steps in turn; runs started together overlap on their first step', () => {
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
      expect(
        {
          whileFirstHeld,
          afterFirstReleased,
          total: provider.calls,
          result,
          completed,
        },
        `labels: ${provider.labels.join(', ')}`,
      ).toEqual({
        whileFirstHeld: 1,
        afterFirstReleased: 2,
        total: 2,
        result: 'completed',
        completed: ['review_a', 'review_b'],
      });
    } finally {
      provider.releaseAll();
      vi.restoreAllMocks();
    }
  }, 30_000);

  // ARM 2 — two RUNS started together, as `realm listen` starts them: one drive per run. It pins the
  // FIRST step only; later steps are not claimed. (a) red when the two drives cannot have both requests
  // in flight (a module-level lock around the provider call: point (i) shows [1, 0]), when a drive
  // sends its second step before its own first reply (point (i) shows two calls on one provider), or
  // when the instrument counts after the reply; (b) prints, per point, each provider's call count and
  // labels, and the runs' completed_steps.
  it('two runs started together: their first steps are in flight together; each run sends its second step only after its own first reply', async () => {
    const store = new InMemoryStore();
    const runs = [
      (await store.create({ workflowId: twoReady.id, workflowVersion: 1, params: {} })).run,
      (await store.create({ workflowId: twoReady.id, workflowVersion: 1, params: {} })).run,
    ];
    const providers = [new HeldProvider(), new HeldProvider()];
    const point = () => providers.map((p) => ({ calls: p.calls, labels: [...p.labels] }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const drives = runs.map((run, i) =>
        runAgent(depsFor(store, providers[i]!), {
          definition: twoReady,
          existingRunId: run.id,
          params: {},
          inFlightPollMs: 5,
          inFlightWatchMs: 5_000,
        }),
      );
      // (i) both first replies held.
      await until(() => providers[0]!.calls + providers[1]!.calls >= 2);
      const bothFirstHeld = point();
      // (ii) only the first provider's first reply released.
      providers[0]!.release();
      await until(() => providers[0]!.calls >= 2);
      const firstReleased = point();
      // (iii) everything released.
      for (const p of providers) p.releaseAll();
      const results = await Promise.all(drives);
      const completed = await Promise.all(
        runs.map(async (run) => [...(await store.get(run.id)).completed_steps].sort()),
      );
      expect({ bothFirstHeld, firstReleased, results, completed }).toEqual({
        bothFirstHeld: [
          { calls: 1, labels: ['review_a'] },
          { calls: 1, labels: ['review_a'] },
        ],
        firstReleased: [
          { calls: 2, labels: ['review_a', 'review_b'] },
          { calls: 1, labels: ['review_a'] },
        ],
        results: ['completed', 'completed'],
        completed: [
          ['review_a', 'review_b'],
          ['review_a', 'review_b'],
        ],
      });
    } finally {
      for (const p of providers) p.releaseAll();
      vi.restoreAllMocks();
    }
  }, 30_000);
});
