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
import { LlmProvider, ToolCapableLlmProvider } from './providers/llm-provider.js';
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

// =================================================================================================
// issue #401 — cell 3c: chokepoint (3)'s DOWNSTREAM extent
//
// 3a proves the try opens early enough to catch an MCP-init throw. This proves it stays open
// across the drive loop, and that the mint carries the CURRENT step rather than the empty string.
// Mutants: hardcoding `''` at the last-resort mint, or deleting the `currentStepName = stepName`
// assignment at step selection, reds exactly this cell — 3a and 3b both EXPECT `''`, so neither
// would notice.
// =================================================================================================
describe('#401 chokepoint (3) — the mid-loop throw carries the current step', () => {
  it('3c — a store read failing mid-drive records the SELECTED step, never the empty string', async () => {
    const store = new InMemoryStore();
    const original = store.get.bind(store);
    const wf = {
      id: 'midloop-wf',
      name: 'Mid Loop',
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

    const { run: created } = await store.create({
      workflowId: 'midloop-wf',
      workflowVersion: 1,
      params: {},
    });

    // Throws once, on the per-attempt version read — which only happens after a step has been
    // selected. Counted rather than armed by name because the reads before it (attach, then
    // eligibility) are what make the step name exist at all. The fence's OWN re-read must still
    // succeed, or the entry degrades to the console lostLine and there is nothing to assert.
    let reads = 0;
    store.get = async (id: string) => {
      reads++;
      if (reads === 3) throw new Error('store read exploded mid-loop');
      return original(id);
    };

    const deps = makeDeps({ store });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runAgent(deps, { existingRunId: created.id, definition: wf, params: {} }),
    ).rejects.toThrow('store read exploded mid-loop');

    store.get = original;
    const run = await store.get(created.id);
    expect(run.drive_failures?.entries).toHaveLength(1);
    expect(run.drive_failures!.entries[0]!.step).toBe('classify');
    vi.restoreAllMocks();
  });
});

// =================================================================================================
// issue #401 chokepoint (1) — the TOOLS catch records
//
// Deleting the mint at chokepoint (1) survived the entire suite before this cell. Distinct from
// the tools VALIDATION cell below: this is the catch, that is the disposition table.
// =================================================================================================
class ToolProvider extends ToolCapableLlmProvider {
  // Extends the tool-capable BASE deliberately: `isToolCapable` is an `instanceof` check, not a
  // capability flag, so a hand-shaped object with the right methods is still rejected.
  readonly calls = { value: 0 };
  constructor(
    private readonly behaviour: unknown,
    private readonly toolCalls: unknown[] = [],
  ) {
    super();
  }
  async callStep(): Promise<Record<string, unknown>> {
    return {};
  }
  async callStepWithTools(): Promise<never> {
    this.calls.value++;
    if (this.behaviour instanceof Error) throw this.behaviour;
    return { output: this.behaviour, toolCalls: this.toolCalls } as never;
  }
}

/** An MCP client double that exposes exactly the tools it is given. */
function toolClient(names: string[]) {
  return () =>
    ({
      connect: async () => {},
      disconnect: async () => {},
      getTools: async () =>
        names.map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object', properties: {} },
        })),
    }) as never;
}

const TOOLS_WF = {
  id: 'tools-wf',
  name: 'Tools WF',
  version: 1,
  schema_version: 1,
  mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'node', args: [] }],
  steps: {
    ask: {
      description: 'Ask',
      execution: 'agent',
      depends_on: [],
      tools: ['srv:op'],
      output_schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
} as unknown as WorkflowDefinition;

describe('#401 chokepoint (1) — the tools catch', () => {
  it('a throwing tools call is recorded WITH the step name, and the printed line carries the message', async () => {
    const store = new InMemoryStore();
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m));
    });

    const deps = makeDeps({
      store,
      provider: new ToolProvider(new Error('tools call exploded')),
      mcpClientFactory: toolClient(['op']),
    });

    const result = await runAgent(deps, { definition: TOOLS_WF, params: {} });
    expect(result).toBe('failed');

    const run = await onlyRun(store);
    expect(run.drive_failures?.entries).toHaveLength(1);
    expect(run.drive_failures!.entries[0]!.step).toBe('ask');
    expect(run.drive_failures!.entries[0]!.message).toContain('tools call exploded');

    const printed = errors.join('\n');
    expect(printed).toContain("✗ Step 'ask' (tools) failed:");
    expect(printed).toContain('tools call exploded');
    vi.restoreAllMocks();
  });
});

// =================================================================================================
// issue #401 chokepoint (4) — the error-exit disposition table, KEYED ON ERROR CODE
//
// The table's stated mutant — keying the mint on `repairsUsed > 0` instead of on the error code —
// reddened NOTHING before these cells. Every construction that reaches the table with a rejection
// arrives with `repairsUsed === 0`, which is precisely why the mint must not be keyed on it. That
// mutant reds this cell AND every sibling below; never "exactly this one".
// =================================================================================================
function autoHandlerWorkflow(handlerName: string): WorkflowDefinition {
  return {
    id: 'handler-wf',
    name: 'Handler WF',
    version: 1,
    schema_version: 1,
    steps: { enrich: { description: 'Enrich', execution: 'auto', handler: handlerName } },
  } as unknown as WorkflowDefinition;
}

describe('#401 chokepoint (4) — codes that mint NOTHING', () => {
  it('ENGINE_HANDLER_NOT_REGISTERED ⇒ no entry — the capability_block finding owns this', async () => {
    const store = new InMemoryStore();
    const deps = makeDeps({ store, registry: new ExtensionRegistry() });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runAgent(deps, { definition: autoHandlerWorkflow('enricher'), params: {} });

    const run = await onlyRun(store);
    // Recoverably blocked, not burned — and NOT double-reported: two findings for one fact is noise.
    expect(run.terminal_state).toBe(false);
    expect(run.drive_failures).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('ENGINE_ADAPTER_NOT_REGISTERED ⇒ no entry, for the same reason', async () => {
    const store = new InMemoryStore();
    const wf = {
      id: 'adapter-wf',
      name: 'Adapter WF',
      version: 1,
      schema_version: 1,
      services: { crm: { adapter: 'salesforce', config: {} } },
      steps: {
        push: {
          description: 'Push',
          execution: 'auto',
          uses_service: 'crm',
          service_method: 'create',
          operation: 'lead',
        },
      },
    } as unknown as WorkflowDefinition;
    const deps = makeDeps({ store, registry: new ExtensionRegistry() });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runAgent(deps, { definition: wf, params: {} });

    const run = await onlyRun(store);
    expect(run.terminal_state).toBe(false);
    expect(run.drive_failures).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('EVERY OTHER CODE ⇒ no entry — the step SETTLED, and failed_steps plus evidence carry it', async () => {
    // A registered handler that throws. The observable that matters: the run is NOT terminal (a
    // second, independent step is still eligible) and the step settled — so the visibility already
    // exists and an entry would duplicate it. Two steps deliberately: a single-step construction
    // SEALS the run, and the fence's terminal-skip would then mask a mint-on-everything mutant.
    const store = new InMemoryStore();
    const registry = new ExtensionRegistry();
    registry.register('handler', 'boom', {
      execute: async () => {
        throw new Error('handler exploded');
      },
    } as never);
    const wf = {
      id: 'two-step-wf',
      name: 'Two Step',
      version: 1,
      schema_version: 1,
      steps: {
        first: { description: 'First', execution: 'auto', handler: 'boom' },
        second: { description: 'Second', execution: 'auto', handler: 'boom', depends_on: [] },
      },
    } as unknown as WorkflowDefinition;
    const deps = makeDeps({ store, registry });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runAgent(deps, { definition: wf, params: {} });

    const run = await onlyRun(store);
    expect(run.terminal_state).toBe(false);
    expect(run.drive_failures).toBeUndefined();
    vi.restoreAllMocks();
  });
});

describe('#401 chokepoint (4) — validation rejections DO mint', () => {
  it('a tools-path OUTPUT_SCHEMA rejection with recorded tool calls mints validation_rejected', async () => {
    // The step omits `input_schema` deliberately: Step 2b validates INPUT before Step 2c validates
    // output, so an input schema here would make the code INPUT_SCHEMA and this cell's name a lie.
    // Recorded tool calls defeat the repair gate, so this arrives with repairsUsed === 0.
    const store = new InMemoryStore();
    const deps = makeDeps({
      store,
      provider: new ToolProvider({ wrong: 'shape' }, [
        { server_id: 'srv', tool: 'op', args: {}, result: 'x', duration_ms: 1 },
      ]),
      // The double must EXPOSE the declared tool: an empty list makes the tool-reference check
      // throw first, and the entry then records THAT — observed while building this cell, and a
      // green-for-the-wrong-reason it would otherwise have shipped.
      mcpClientFactory: toolClient(['op']),
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runAgent(deps, { definition: TOOLS_WF, params: {} });

    const run = await onlyRun(store);
    expect(run.drive_failures?.entries).toHaveLength(1);
    expect(run.drive_failures!.entries[0]!.error_class).toBe('validation_rejected');
    expect(run.drive_failures!.entries[0]!.step).toBe('ask');
    vi.restoreAllMocks();
  });

  it('an INPUT_SCHEMA rejection mints too — reached with schemaRetries: 0', async () => {
    const store = new InMemoryStore();
    const wf = {
      id: 'input-validation-wf',
      name: 'Input Validation',
      version: 1,
      schema_version: 1,
      steps: {
        ask: {
          description: 'Ask',
          execution: 'agent',
          depends_on: [],
          input_schema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
            required: ['summary'],
          },
        },
      },
    } as unknown as WorkflowDefinition;
    const deps = makeDeps({
      store,
      provider: new TestProvider({ wrong: 'shape' }),
      schemaRetries: 0,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runAgent(deps, { definition: wf, params: {} });

    const run = await onlyRun(store);
    expect(run.drive_failures?.entries).toHaveLength(1);
    expect(run.drive_failures!.entries[0]!.error_class).toBe('validation_rejected');
    vi.restoreAllMocks();
  });

  it("an AUTO step's validation rejection mints — the wedge is identical to an agent step's", async () => {
    // The schema MUST carry `required`: runAgent passes `{}` for an auto step, and a
    // properties-only schema happily ACCEPTS `{}` — the cell would pass without validating
    // anything. Output validation is agent-only, so this is the INPUT_SCHEMA path.
    const store = new InMemoryStore();
    const registry = new ExtensionRegistry();
    registry.register('handler', 'noop', { execute: async () => ({ ok: true }) } as never);
    const wf = {
      id: 'auto-validation-wf',
      name: 'Auto Validation',
      version: 1,
      schema_version: 1,
      steps: {
        enrich: {
          description: 'Enrich',
          execution: 'auto',
          handler: 'noop',
          input_schema: {
            type: 'object',
            properties: { must_have: { type: 'string' } },
            required: ['must_have'],
          },
        },
      },
    } as unknown as WorkflowDefinition;
    const deps = makeDeps({ store, registry });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runAgent(deps, { definition: wf, params: {} });

    const run = await onlyRun(store);
    expect(run.drive_failures?.entries).toHaveLength(1);
    expect(run.drive_failures!.entries[0]!.error_class).toBe('validation_rejected');
    expect(run.drive_failures!.entries[0]!.step).toBe('enrich');
    vi.restoreAllMocks();
  });

  it('a repair-EXHAUSTED rejection mints (default schemaRetries: 2 ⇒ three rejections)', async () => {
    const store = new InMemoryStore();
    const wf = {
      id: 'exhausted-wf',
      name: 'Exhausted',
      version: 1,
      schema_version: 1,
      steps: {
        ask: {
          description: 'Ask',
          execution: 'agent',
          depends_on: [],
          input_schema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
            required: ['summary'],
          },
        },
      },
    } as unknown as WorkflowDefinition;
    const deps = makeDeps({ store, provider: new TestProvider({ wrong: 'shape' }) });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runAgent(deps, { definition: wf, params: {} });

    const run = await onlyRun(store);
    expect(run.drive_failures?.entries).toHaveLength(1);
    expect(run.drive_failures!.entries[0]!.error_class).toBe('validation_rejected');
    vi.restoreAllMocks();
  });
});
