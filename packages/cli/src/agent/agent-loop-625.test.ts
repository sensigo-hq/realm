// agent-loop-625.test.ts — issue #625 PR-2a, the `realm agent` loop: D6.1 (a lost claim is said as a
// past-tense fact, never `✓ → running`), D6.2 (nothing eligible with a step in flight: watch, then
// name reclaim — "its runner likely died" only past a deadline), and D4.2/L7 (the engine's work runs
// at the loop top through advanceRun; an engine step that fails is named and no model call follows).
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
  type RunStore,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import type { AgentDeps } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';

const workflowStore = (def: WorkflowDefinition) => ({
  async register() {},
  async get() {
    return def;
  },
  async list() {
    return [def];
  },
});

const agentOnly: WorkflowDefinition = {
  id: 'loop-wf',
  name: 'loop',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { review: { description: 'Review.', execution: 'agent', depends_on: [] } },
};

describe('#625 PR-2a — the realm agent loop', () => {
  it('D6.1: a step another process took is said as a fact (holder, since) — never "✓ → running"', async () => {
    const store = new InMemoryStore();
    const { run } = await store.create({
      workflowId: agentOnly.id,
      workflowVersion: 1,
      params: {},
    });
    // Another process takes `review` between this loop's pick and its claim.
    const realClaim = store.claimStep.bind(store);
    let first = true;
    (store as unknown as RunStore).claimStep = async (
      ...args: Parameters<RunStore['claimStep']>
    ) => {
      if (first) {
        first = false;
        await realClaim(args[0], args[1], args[2], {
          by: 'other@host',
          by_source: 'derived',
          channel: 'agent',
        });
      }
      return realClaim(...args);
    };
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ ok: true });
    })();
    const deps: AgentDeps = {
      store,
      workflowStore: workflowStore(agentOnly),
      provider,
      registry: createDefaultRegistry(),
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runAgent(deps, {
      definition: agentOnly,
      existingRunId: run.id,
      params: {},
      inFlightPollMs: 5,
      inFlightWatchMs: 30,
    });
    const out = logSpy.mock.calls.flat().join('\n');
    vi.restoreAllMocks();
    const since = (await store.get(run.id)).claims?.['review']?.since;
    expect(out).toContain(
      `• Step 'review' was taken by other@host (from the OS user, via agent) at ${since}; not run here.`,
    );
    expect(out).not.toContain('✓ → running');
  });

  it('D6.2: a healthy claim in flight — the loop watches and re-enters on change, then exits naming reclaim', async () => {
    const store = new InMemoryStore();
    const { run } = await store.create({
      workflowId: agentOnly.id,
      workflowVersion: 1,
      params: {},
    });
    await store.claimStep(run.id, 'review', agentOnly, {
      by: 'other@host',
      by_source: 'derived',
      channel: 'agent',
    });
    const provider = new (class extends LlmProvider {
      callStep = vi.fn();
    })();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runAgent(
      {
        store,
        workflowStore: workflowStore(agentOnly),
        provider,
        registry: createDefaultRegistry(),
      },
      {
        definition: agentOnly,
        existingRunId: run.id,
        params: {},
        inFlightPollMs: 5,
        inFlightWatchMs: 30,
      },
    );
    const out = logSpy.mock.calls.flat().join('\n');
    const err = errorSpy.mock.calls.flat().join('\n');
    vi.restoreAllMocks();
    expect(result).toBe('failed');
    expect(out).toContain("• Step 'review' has been in flight since ");
    expect(out).toContain('(taken by other@host (from the OS user, via agent))');
    expect(out).toContain(
      `If the program that took it is gone: realm run reclaim ${run.id} --step review --force`,
    );
    expect(out).not.toContain('likely died');
    // Never a bare "Run ended in phase: running" with nothing named before it.
    expect(err).toContain('Run ended in phase: running');
    expect(provider.callStep).not.toHaveBeenCalled();
  });

  it('L7: an owed auto step that fails at the loop top is named; no model call follows', async () => {
    const def: WorkflowDefinition = {
      id: 'loop-fail-wf',
      name: 'loop fail',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        boom: { description: 'Boom.', execution: 'auto', depends_on: [], handler: 'boom' },
        review: { description: 'Review.', execution: 'agent', depends_on: [] },
      },
    };
    const registry = createDefaultRegistry();
    registry.register('handler', 'boom', {
      id: 'boom',
      execute: async () => {
        throw new Error('handler blew up');
      },
    });
    const store = new InMemoryStore();
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({});
    })();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runAgent(
      { store, workflowStore: workflowStore(def), provider, registry },
      { definition: def, params: {} },
    );
    const out = logSpy.mock.calls.flat().join('\n');
    const err = errorSpy.mock.calls.flat().join('\n');
    vi.restoreAllMocks();
    expect(result).toBe('failed');
    expect(out).toContain('→ [auto] boom');
    expect(err).toContain("✗ Step 'boom' failed:");
    expect(provider.callStep).not.toHaveBeenCalled();
  });
});
