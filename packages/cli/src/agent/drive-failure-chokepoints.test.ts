// drive-failure-chokepoints.test.ts — the four places a failed drive gets written down (#401).
//
// Chokepoint (3) is the one that mattered most in review: a run created, then dying in MCP init
// before any step ran, used to leave a record that looked perfectly healthy for 24 hours. Nothing
// in the suite pinned those throws, so the cells below ARE the contract — including the re-throw,
// which `runAgent`'s callers depend on.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { ExtensionRegistry } from '@sensigo/realm';
import type { WorkflowDefinition, RunRecord } from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import type { AgentDeps } from './run-agent.js';

/**
 * Extends the real base class rather than shaping an object literal: the base supplies
 * `capabilities()` and the rest of the contract, and a hand-rolled double silently misses them.
 */
class TestProvider extends LlmProvider {
  readonly calls = { value: 0 };
  constructor(private readonly behaviour: unknown = { summary: 'ok' }) {
    super();
  }
  async callStep(): Promise<Record<string, unknown>> {
    this.calls.value++;
    if (this.behaviour instanceof Error) throw this.behaviour;
    return this.behaviour as Record<string, unknown>;
  }
}

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
    provider: new TestProvider(),
    registry: new ExtensionRegistry(),
    ...over,
  } as unknown as AgentDeps;
}

/** A workflow whose step references a server the workflow never declares. */
const UNDECLARED_SERVER_WF = {
  id: 'undeclared-wf',
  name: 'Undeclared',
  version: 1,
  schema_version: 1,
  mcp_servers: [{ id: 'declared', transport: 'stdio', command: 'node', args: [] }],
  steps: {
    ask: {
      description: 'Ask',
      execution: 'agent',
      depends_on: [],
      tools: ['ghost:do_thing'],
      input_schema: { type: 'object', properties: { summary: { type: 'string' } } },
    },
  },
} as unknown as WorkflowDefinition;

async function onlyRun(store: InMemoryStore): Promise<RunRecord> {
  const runs = await store.list();
  return store.get(runs[0]!.id);
}

describe('#401 chokepoint (3) — the last-resort catch', () => {
  it('3a — an undeclared-server reference RE-THROWS and still records the failure', async () => {
    // The class-killer. Built with an inline definition because the loader refuses this shape at
    // load time since #390 — which is exactly why the throw survives only on this path.
    //
    // The placement mutant (narrowing the try to the `while` loop) reds this cell: the MCP-init
    // throw happens before the loop is ever entered.
    const store = new InMemoryStore();
    const deps = makeDeps({ store });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runAgent(deps, { definition: UNDECLARED_SERVER_WF, params: {} })).rejects.toThrow(
      "references unknown MCP server 'ghost'",
    );

    const run = await onlyRun(store);
    expect(run.drive_failures?.entries).toHaveLength(1);
    const entry = run.drive_failures!.entries[0]!;
    expect(entry.error_class).toBe('other');
    // '' is EXPECTED here: nothing had been selected yet when this threw.
    expect(entry.step).toBe('');
    expect(entry.message).toContain('unknown MCP server');
    vi.restoreAllMocks();
  });

  it('3b — a tool-declaring workflow on a non-tool-capable provider re-throws AND records', async () => {
    // Nothing else in the suite pins this throw, so this cell is its whole contract.
    const store = new InMemoryStore();
    const wf = {
      ...UNDECLARED_SERVER_WF,
      id: 'tool-incapable-wf',
      steps: {
        ask: {
          ...(UNDECLARED_SERVER_WF.steps['ask'] as unknown as Record<string, unknown>),
          tools: ['declared:do_thing'],
        },
      },
    } as unknown as WorkflowDefinition;
    const deps = makeDeps({
      store,
      mcpClientFactory: () =>
        ({
          connect: async () => {},
          disconnect: async () => {},
          listTools: async () => [],
        }) as never,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runAgent(deps, { definition: wf, params: {} })).rejects.toThrow(
      'does not support tool calling',
    );

    const run = await onlyRun(store);
    expect(run.drive_failures?.entries).toHaveLength(1);
    expect(run.drive_failures!.entries[0]!.step).toBe('');
    vi.restoreAllMocks();
  });
});

describe('#401 chokepoint (2) — the LLM call', () => {
  it('records the failure with the STEP name, and returns failed without retrying', async () => {
    const store = new InMemoryStore();
    const provider = new TestProvider(new Error('provider exploded'));
    const deps = makeDeps({ store, provider });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const wf = {
      id: 'simple-wf',
      name: 'Simple',
      version: 1,
      schema_version: 1,
      steps: {
        classify: {
          description: 'Classify',
          execution: 'agent',
          depends_on: [],
          input_schema: { type: 'object', properties: { summary: { type: 'string' } } },
        },
      },
    } as unknown as WorkflowDefinition;

    const result = await runAgent(deps, { definition: wf, params: {} });
    expect(result).toBe('failed');
    expect(provider.calls.value).toBe(1);

    const run = await onlyRun(store);
    const entry = run.drive_failures!.entries[0]!;
    expect(entry.step).toBe('classify');
    expect(entry.message).toContain('provider exploded');
    expect(entry.provider.length).toBeGreaterThan(0);
    vi.restoreAllMocks();
  });
});
