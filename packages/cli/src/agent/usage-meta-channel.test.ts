// usage-meta-channel.test.ts — issue #600 PR 1a (D1b): the re-route that makes the whole PR
// non-vacuous on cs1, plus the composition hazard it creates and the fixed absence rule (D5).
//
// D1b's own text: "Without this, the PR measures nothing on the workload that motivates it." cs1
// declares `structured_output` in ZERO files, so every one of its steps takes the arm this section
// pins — a step declaring nothing must still report what its wire requests cost.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { ExtensionRegistry } from '@sensigo/realm';
import type { WorkflowDefinition, RunRecord } from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import type { CallStepWithMetaResult } from './providers/llm-provider.js';
import type { AgentDeps } from './run-agent.js';

function makeDeps(over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    store: new InMemoryStore(),
    workflowStore: {
      register: async () => {},
      get: async () => {
        throw new Error('not registered');
      },
      list: async () => [],
    },
    registry: new ExtensionRegistry(),
    ...over,
  } as unknown as AgentDeps;
}

const CS1_SHAPED_WF = {
  id: 'cs1-shaped-wf',
  name: 'CS1 shaped',
  version: 1,
  schema_version: 1,
  steps: {
    // No tools, no structured_output — declares nothing, exactly the population D1b names.
    classify: {
      description: 'Classify',
      execution: 'agent',
      depends_on: [],
      input_schema: { type: 'object', properties: { summary: { type: 'string' } } },
    },
  },
} as unknown as WorkflowDefinition;

async function onlyRun(store: InMemoryStore): Promise<RunRecord> {
  const runs = await store.list();
  return store.get(runs[0]!.id);
}

describe('issue #600 PR 1a (D1b) — GREEN: on this branch, the same arm is re-routed, and usage reaches the persisted record', () => {
  class UsageReportingProvider extends LlmProvider {
    readonly calls = { callStep: 0, callStepWithMeta: 0 };
    async callStep(): Promise<Record<string, unknown>> {
      this.calls.callStep++;
      // callStep's return type structurally cannot carry usage — proving this method alone
      // could never satisfy the feature, independent of whether it is ever invoked.
      return { category: 'ok' };
    }
    override async callStepWithMeta(): Promise<CallStepWithMetaResult> {
      this.calls.callStepWithMeta++;
      return {
        output: { category: 'ok' },
        usage: [
          {
            request_index: 0,
            request_start: '2026-01-01T00:00:00.000Z',
            prompt_tokens: 500,
            cache_read_input_tokens: 400,
            output_tokens: 20,
          },
        ],
      };
    }
  }

  it('the driver calls ONLY callStepWithMeta for the undeclared arm — callStep is never invoked directly', async () => {
    const store = new InMemoryStore();
    const provider = new UsageReportingProvider();
    const deps = makeDeps({ store, provider });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runAgent(deps, { definition: CS1_SHAPED_WF, params: {} });
    expect(result).toBe('completed');
    expect(provider.calls.callStepWithMeta).toBe(1);
    expect(provider.calls.callStep).toBe(0);
    vi.restoreAllMocks();
  });

  it('the reported usage reaches the persisted step diagnostics as an ENGAGED cache — the whole point of the re-route', async () => {
    const store = new InMemoryStore();
    const provider = new UsageReportingProvider();
    const deps = makeDeps({ store, provider });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runAgent(deps, { definition: CS1_SHAPED_WF, params: {} });
    const run = await onlyRun(store);
    const snap = run.evidence.find((e) => e.step_id === 'classify');
    expect(snap?.diagnostics?.cache).toBeDefined();
    expect(snap!.diagnostics!.cache!.state).toBe('engaged');
    expect(snap!.diagnostics!.cache!.requests[0]!.prompt_tokens).toBe(500);
    vi.restoreAllMocks();
  });
});

describe('issue #600 PR 1a (D1b) — the composition hazard: an undeclared step must never leak structured_output meta from an overriding provider', () => {
  class MisbehavingProvider extends LlmProvider {
    override async callStepWithMeta(): Promise<CallStepWithMetaResult> {
      // A provider that ALSO stamps meta on every call, regardless of what was asked — the exact
      // shape a third-party override could get wrong.
      return {
        output: { category: 'ok' },
        meta: { requested: true, sent: true },
        usage: [{ request_index: 0, request_start: '2026-01-01T00:00:00.000Z', prompt_tokens: 10 }],
      };
    }
    async callStep(): Promise<Record<string, unknown>> {
      return { category: 'ok' };
    }
  }

  it("an undeclared step's persisted diagnostics carry no structured_output stamp, even though the provider returned one", async () => {
    const store = new InMemoryStore();
    const provider = new MisbehavingProvider();
    const deps = makeDeps({ store, provider });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runAgent(deps, { definition: CS1_SHAPED_WF, params: {} });
    const run = await onlyRun(store);
    const snap = run.evidence.find((e) => e.step_id === 'classify');
    // usage still travels — the hazard is specifically about `meta`, not about the whole channel.
    expect(snap?.diagnostics?.cache).toBeDefined();
    expect(snap?.diagnostics?.structured_output).toBeUndefined();
    vi.restoreAllMocks();
  });
});

describe('issue #600 PR 1a (D5) — red-first: a real third-party --provider-module reporting nothing', () => {
  class SilentThirdPartyProvider extends LlmProvider {
    async callStep(): Promise<Record<string, unknown>> {
      return { category: 'ok' };
    }
    // Deliberately NO callStepWithMeta override — the exact shape of a real module that only
    // implements the abstract method, inheriting the base class's default.
  }

  it("BEFORE the `usage ?? []` fix, this provider's step would carry NO cache field at all — indistinguishable from a handler step that never called a model", async () => {
    // Structural: the base default (llm-provider.ts) returns `{ output }` with usage OMITTED
    // entirely, never `usage: []` — pinned generically, not per-provider, as constraint 2 requires.
    const bare = await new SilentThirdPartyProvider().callStepWithMeta('p');
    expect('usage' in bare).toBe(false);
  });

  it("AFTER the fix: run-agent's `usage ?? []` turns that omission into an explicit empty array — cache is PRESENT as unobservable, not absent", async () => {
    const store = new InMemoryStore();
    const provider = new SilentThirdPartyProvider();
    const deps = makeDeps({ store, provider });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runAgent(deps, { definition: CS1_SHAPED_WF, params: {} });
    const run = await onlyRun(store);
    const snap = run.evidence.find((e) => e.step_id === 'classify');
    // A model call HAPPENED (the base default did call callStep internally) — the record must
    // say so, distinct from a handler step where `cache` is absent because no call was ever made.
    expect(snap?.diagnostics?.cache).toBeDefined();
    expect(snap!.diagnostics!.cache!.state).toBe('unobservable');
    expect(snap!.diagnostics!.cache!.requests).toEqual([]);
    vi.restoreAllMocks();
  });
});
