// agent-loop-pins-625.test.ts — issue #625 PR-2a: the realm agent loop's remaining words. A claim
// PAST its deadline is the only one said to have a dead runner; an engine step refused before its
// claim (a precondition) is named and no model call follows.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
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

describe('#625 PR-2a — realm agent loop words', () => {
  it('a claim past its deadline: "its runner likely died" is said, with the reclaim command', async () => {
    const def: WorkflowDefinition = {
      id: 'stale-wf',
      name: 'stale',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { review: { description: 'R', execution: 'agent', depends_on: [] } },
    };
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      in_progress_steps: ['review'],
      claims: {
        review: {
          deadline: '2000-01-01T00:00:00.000Z',
          token: 't',
          since: '1999-12-31T23:59:00.000Z',
        },
      },
    });
    const provider = new (class extends LlmProvider {
      callStep = vi.fn();
    })();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runAgent(
      { store, workflowStore: workflowStore(def), provider, registry: createDefaultRegistry() },
      {
        definition: def,
        existingRunId: run.id,
        params: {},
        inFlightPollMs: 5,
        inFlightWatchMs: 20,
      },
    );
    const out = logSpy.mock.calls.flat().join('\n');
    vi.restoreAllMocks();
    expect(out).toContain(
      `• Step 'review' has been in flight since 1999-12-31T23:59:00.000Z (taken by no program name was recorded on this claim); the record has not changed for 0s. Its claim is past its deadline (its runner likely died). If the program that took it is gone: realm run reclaim ${run.id} --step review --force`,
    );
  });

  it('an engine step refused before its claim (precondition): named, no model call', async () => {
    const def: WorkflowDefinition = {
      id: 'refused-wf',
      name: 'refused',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        x: {
          description: 'X',
          execution: 'auto',
          depends_on: [],
          preconditions: ['nothing.ok == true'],
        },
        review: { description: 'R', execution: 'agent', depends_on: [] },
      },
    };
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({});
    })();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: workflowStore(def),
        provider,
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );
    const err = errorSpy.mock.calls.flat().join('\n');
    vi.restoreAllMocks();
    expect(result).toBe('failed');
    expect(err).toContain(
      "✗ Step 'x' cannot run here (precondition): Precondition failed for step 'x'. Precondition failed: 'nothing.ok == true'. Resolved value: undefined.",
    );
    expect(provider.callStep).not.toHaveBeenCalled();
  });
});
