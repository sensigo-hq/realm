// run-agent.test.ts — Tests for runAgent() and MCP tool dispatch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { runAgent } from './run-agent.js';
import type { AgentDeps } from './run-agent.js';
import type {
  WorkflowDefinition,
  ToolCallRecord,
  TraceBufferStore,
  RunRecord,
} from '@sensigo/realm';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  ExtensionRegistry,
  findEligibleSteps,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { LlmProvider, ToolCapableLlmProvider } from './providers/llm-provider.js';
import type { McpClient, McpTool } from './mcp/mcp-extensions.js';
import { agentCommand } from '../commands/agent.js';

// ---------------------------------------------------------------------------
// MCP tools integration tests
// ---------------------------------------------------------------------------

const mcpWorkflow: WorkflowDefinition = {
  id: 'mcp-wf',
  name: 'MCP Workflow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  mcp_servers: [{ id: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-github'] }],
  steps: {
    research: {
      description: 'Research step with tools',
      execution: 'agent',
      tools: ['github:get_pull_request'],
      max_tool_calls: 5,
      tool_timeout: 10,
      input_schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
};

function makeMockMcpClient(overrides: Partial<McpClient> = {}): McpClient & {
  capturedServerId: string[];
  capturedToolName: string[];
  disconnectCount: number;
} {
  const capturedServerId: string[] = [];
  const capturedToolName: string[] = [];
  let disconnectCount = 0;
  return {
    async connect() {},
    async getTools(serverId: string, allowList: string[]): Promise<McpTool[]> {
      return allowList.map((name) => ({
        name,
        description: `Tool ${name}`,
        inputSchema: { type: 'object' },
      }));
    },
    async call(serverId: string, toolName: string, _args: Record<string, unknown>) {
      capturedServerId.push(serverId);
      capturedToolName.push(toolName);
      return { result: 'ok' };
    },
    async disconnect() {
      disconnectCount++;
    },
    capturedServerId,
    capturedToolName,
    get disconnectCount() {
      return disconnectCount;
    },
    ...overrides,
  };
}

function makeWorkflowStore(def?: WorkflowDefinition) {
  return {
    async register() {},
    async get() {
      if (def) return def;
      throw new Error('not used');
    },
    async list() {
      return def ? [def] : [];
    },
  };
}

describe('runAgent — MCP tools integration', () => {
  // issue #413: the loader's new error tells authors "each tool call is capped at tool_timeout
  // seconds (default 30)". The per-CALL cap is already pinned by execution in the provider suites
  // (openai-provider.test.ts's tool-timeout cell and its anthropic twin); what nothing pinned is
  // the DEFAULT travelling from an absent key to the provider. A message that states a number is
  // a claim, and this is the only cell that would notice it drifting.
  it('an absent tool_timeout reaches the provider as the documented 30-second default', async () => {
    const mockClient = makeMockMcpClient();
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi.fn().mockResolvedValue({ output: { summary: 'done' }, toolCalls: [] });
    })();
    // The shared fixture declares `tool_timeout: 10`, which would have pinned the FIXTURE rather
    // than the default — caught by asserting 30000 and seeing 10000. This copy drops the key.
    const research = { ...mcpWorkflow.steps['research']! };
    delete research.tool_timeout;
    const noTimeoutWorkflow: WorkflowDefinition = {
      ...mcpWorkflow,
      steps: { research },
    };
    const deps: AgentDeps = {
      store: new InMemoryStore(),
      workflowStore: makeWorkflowStore(noTimeoutWorkflow),
      provider,
      registry: createDefaultRegistry(),
      mcpClientFactory: () => mockClient,
    };

    await runAgent(deps, { definition: noTimeoutWorkflow, params: {} });

    const options = (provider.callStepWithTools as ReturnType<typeof vi.fn>).mock.calls[0]![3] as {
      toolTimeoutMs: number;
    };
    expect(options.toolTimeoutMs).toBe(30_000);
  });

  it('tool calls dispatched to the correct server and tool name', async () => {
    const mockClient = makeMockMcpClient();
    const toolCalls: ToolCallRecord[] = [
      {
        tool: 'get_pull_request',
        server_id: 'github',
        args: { pr: 1 },
        result: 'PR data',
        duration_ms: 50,
      },
    ];
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi.fn().mockResolvedValue({ output: { summary: 'done' }, toolCalls });
    })();
    const store = new InMemoryStore();
    const deps: AgentDeps = {
      store,
      workflowStore: makeWorkflowStore(mcpWorkflow),
      provider,
      registry: createDefaultRegistry(),
      mcpClientFactory: () => mockClient,
    };

    await runAgent(deps, { definition: mcpWorkflow, params: {} });

    expect(provider.callStepWithTools).toHaveBeenCalledOnce();
    const [, toolDefs] = (provider.callStepWithTools as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      Array<{ id: string; serverId: string; name: string }>,
    ];
    expect(toolDefs).toHaveLength(1);
    expect(toolDefs[0]!.id).toBe('github:get_pull_request');
    expect(toolDefs[0]!.serverId).toBe('github');
    expect(toolDefs[0]!.name).toBe('get_pull_request');
  });

  it('toolCalls appear in the run evidence snapshot after the step completes', async () => {
    const mockClient = makeMockMcpClient();
    const toolCalls: ToolCallRecord[] = [
      {
        tool: 'get_pull_request',
        server_id: 'github',
        args: { pr: 42 },
        result: 'PR body',
        duration_ms: 100,
      },
    ];
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi.fn().mockResolvedValue({ output: { summary: 'analysed' }, toolCalls });
    })();
    const store = new InMemoryStore();
    const deps: AgentDeps = {
      store,
      workflowStore: makeWorkflowStore(mcpWorkflow),
      provider,
      registry: createDefaultRegistry(),
      mcpClientFactory: () => mockClient,
    };

    await runAgent(deps, { definition: mcpWorkflow, params: {} });

    const runs = await store.list();
    const run = runs[0]!;
    const snap = run.evidence.find((e) => e.step_id === 'research');
    expect(snap).toBeDefined();
    expect(snap!.tool_calls).toHaveLength(1);
    expect(snap!.tool_calls![0]!.tool).toBe('get_pull_request');
    expect(snap!.tool_calls![0]!.server_id).toBe('github');
  });

  it('disconnect() called on normal completion', async () => {
    const mockClient = makeMockMcpClient();
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi.fn().mockResolvedValue({ output: { summary: 'done' }, toolCalls: [] });
    })();
    const store = new InMemoryStore();
    const deps: AgentDeps = {
      store,
      workflowStore: makeWorkflowStore(mcpWorkflow),
      provider,
      registry: createDefaultRegistry(),
      mcpClientFactory: () => mockClient,
    };

    const result = await runAgent(deps, { definition: mcpWorkflow, params: {} });

    expect(result).toBe('completed');
    expect(mockClient.disconnectCount).toBe(1);
  });

  it('disconnect() called on step failure (callStepWithTools throws)', async () => {
    const mockClient = makeMockMcpClient();
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi.fn().mockRejectedValue(new Error('LLM crashed'));
    })();
    const store = new InMemoryStore();
    const deps: AgentDeps = {
      store,
      workflowStore: makeWorkflowStore(mcpWorkflow),
      provider,
      registry: createDefaultRegistry(),
      mcpClientFactory: () => mockClient,
    };

    const result = await runAgent(deps, { definition: mcpWorkflow, params: {} });

    expect(result).toBe('failed');
    expect(mockClient.disconnectCount).toBe(1);
  });

  it('returns failed when a declared tool is not found in the MCP server', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockClient = makeMockMcpClient({
      // getTools returns nothing — simulating a server that does not know the tool
      async getTools(): Promise<McpTool[]> {
        return [];
      },
    });
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi.fn();
    })();
    const store = new InMemoryStore();
    const deps: AgentDeps = {
      store,
      workflowStore: makeWorkflowStore(mcpWorkflow),
      provider,
      registry: createDefaultRegistry(),
      mcpClientFactory: () => mockClient,
    };

    const result = await runAgent(deps, { definition: mcpWorkflow, params: {} });

    expect(result).toBe('failed');
    expect(mockClient.disconnectCount).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('get_pull_request'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('research'));
    errorSpy.mockRestore();
  });

  it('returns failed when two servers expose the same bare tool name (MCP_TOOL_NAME_COLLISION)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // server1 and server2 both expose a tool with bare name 'get_file'
    const mockClient = makeMockMcpClient({
      async getTools(serverId: string, allowList: string[]): Promise<McpTool[]> {
        return allowList.map((name) => ({
          name,
          description: `Tool ${name} from ${serverId}`,
          inputSchema: { type: 'object' },
        }));
      },
    });
    const collisionWorkflow: WorkflowDefinition = {
      id: 'collision-wf',
      name: 'Collision Workflow',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      mcp_servers: [
        { id: 'server1', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-server1'] },
        { id: 'server2', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-server2'] },
      ],
      steps: {
        analyse: {
          description: 'Step that uses conflicting tool names',
          execution: 'agent',
          tools: ['server1:get_file', 'server2:get_file'],
          max_tool_calls: 5,
          tool_timeout: 10,
          input_schema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
            required: ['summary'],
          },
        },
      },
    };
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi.fn();
    })();
    const store = new InMemoryStore();
    const deps: AgentDeps = {
      store,
      workflowStore: makeWorkflowStore(collisionWorkflow),
      provider,
      registry: createDefaultRegistry(),
      mcpClientFactory: () => mockClient,
    };

    const result = await runAgent(deps, { definition: collisionWorkflow, params: {} });

    expect(result).toBe('failed');
    expect(provider.callStepWithTools).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('get_file'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('server1'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('server2'));
    errorSpy.mockRestore();
  });

  it('--run-id attaches to a persisted run and drives it to completion', async () => {
    // Create the run first using the normal path.
    const store = new InMemoryStore();
    const { run: initialRecord } = await store.create({
      workflowId: 'agent-only',
      workflowVersion: 1,
      params: {},
    });
    const runId = initialRecord.id;

    const simpleWorkflow: WorkflowDefinition = {
      id: 'agent-only',
      name: 'Agent Only',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        summarize: {
          description: 'Summarize',
          execution: 'agent',
          input_schema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
            required: ['summary'],
          },
        },
      },
    };

    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ summary: 'all good' });
    })();
    const deps: AgentDeps = {
      store,
      workflowStore: makeWorkflowStore(simpleWorkflow),
      provider,
      registry: createDefaultRegistry(),
    };

    const result = await runAgent(deps, {
      existingRunId: runId,
      definition: simpleWorkflow,
      params: {},
    });

    expect(result).toBe('completed');
    const run = await store.get(runId);
    expect(run.terminal_state).toBe(true);
    expect(run.run_phase).toBe('completed');
  });

  it('--run-id on a terminal run throws error containing run id and terminal state', async () => {
    const store = new InMemoryStore();
    const { run: initialRecord } = await store.create({
      workflowId: 'agent-only',
      workflowVersion: 1,
      params: {},
    });
    const runId = initialRecord.id;

    // Force the run into terminal state by completing it manually.
    const simpleWorkflow: WorkflowDefinition = {
      id: 'agent-only',
      name: 'Agent Only',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        summarize: {
          description: 'Summarize',
          execution: 'agent',
          input_schema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
            required: ['summary'],
          },
        },
      },
    };
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ summary: 'done' });
    })();
    const deps: AgentDeps = {
      store,
      workflowStore: makeWorkflowStore(simpleWorkflow),
      provider,
      registry: createDefaultRegistry(),
    };
    // First run to completion
    await runAgent(deps, { existingRunId: runId, definition: simpleWorkflow, params: {} });

    // Now try to attach again — run is terminal
    await expect(
      runAgent(deps, { existingRunId: runId, definition: simpleWorkflow, params: {} }),
    ).rejects.toThrow(runId);
  });

  it('existingRunId and workflowPath are mutually exclusive — throws immediately', async () => {
    const store = new InMemoryStore();
    const deps: AgentDeps = {
      store,
      workflowStore: makeWorkflowStore(),
      provider: new (class extends LlmProvider {
        callStep = vi.fn();
      })(),
      registry: createDefaultRegistry(),
    };

    await expect(
      runAgent(deps, {
        existingRunId: 'some-run-id',
        workflowPath: '/some/path',
        params: {},
      }),
    ).rejects.toThrow('mutually exclusive');
  });
});

describe('runAgent — wedge detection on attach (#101, detect-only)', () => {
  const wedgeWf: WorkflowDefinition = {
    id: 'wedge-wf',
    name: 'Wedge WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { review: { description: 'Agent step', execution: 'agent', depends_on: [] } },
  };

  it('prints the claim state + reclaim remediation before exiting on a wedged run (no execution)', async () => {
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: 'wedge-wf', workflowVersion: 1, params: {} });
    // Wedge it: `review` claimed but never settled (unknown-age), and it is the only step, so
    // findEligibleSteps returns [] on attach → the wedge branch fires before the break.
    await store.update({
      ...run,
      in_progress_steps: ['review'],
      claims: { review: { deadline: null } },
    });

    const provider = new (class extends LlmProvider {
      callStep = vi.fn();
    })();
    const deps: AgentDeps = {
      store,
      workflowStore: makeWorkflowStore(wedgeWf),
      provider,
      registry: createDefaultRegistry(),
    };

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runAgent(deps, { definition: wedgeWf, existingRunId: run.id, params: {} });
    const out = logSpy.mock.calls.flat().join('\n');
    logSpy.mockRestore();

    expect(out).toContain('wedged');
    expect(out).toContain('review: claim_unknown_age');
    expect(out).toContain(`realm run reclaim ${run.id} --step review --force`);
    expect(provider.callStep).not.toHaveBeenCalled(); // detect-only — attach does NOT execute
  });
});

describe('runAgent — traceBufferStore threading (issue #207 PR-2, mixed-wiring gap)', () => {
  const walWf: WorkflowDefinition = {
    id: 'wal-thread-wf',
    name: 'WAL Thread WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      summarize: {
        description: 'Summarize',
        execution: 'agent',
        input_schema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
      },
    },
  };

  it('deps.traceBufferStore threads all the way into executeChain — a pre-seeded WAL entry is adopted into evidence (was silently dropped pre-#207)', async () => {
    const store = new InMemoryStore();
    const { run: initialRecord } = await store.create({
      workflowId: 'wal-thread-wf',
      workflowVersion: 1,
      params: {},
    });
    const runId = initialRecord.id;

    const { InMemoryTraceBufferStore } = await import('@sensigo/realm');
    const traceBufferStore = new InMemoryTraceBufferStore();
    await traceBufferStore.append(runId, 'summarize', [{ event: 'streamed_before_execute' }]);

    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ summary: 'all good' });
    })();
    const deps: AgentDeps = {
      store,
      workflowStore: makeWorkflowStore(walWf),
      provider,
      registry: createDefaultRegistry(),
      traceBufferStore,
    };

    const result = await runAgent(deps, {
      existingRunId: runId,
      definition: walWf,
      params: {},
    });

    expect(result).toBe('completed');
    const run = await store.get(runId);
    const evidence = run.evidence.find((e) => e.step_id === 'summarize');
    expect(evidence?.trace?.some((t) => t.event === 'streamed_before_execute')).toBe(true);
    // The WAL was adopted then cleared on settlement — not left as orphaned residue.
    expect(await traceBufferStore.read(runId, 'summarize')).toHaveLength(0);
  });

  it('omitting deps.traceBufferStore is unchanged — no trace adoption, no error (backward compatible)', async () => {
    const store = new InMemoryStore();
    const { run: initialRecord } = await store.create({
      workflowId: 'wal-thread-wf',
      workflowVersion: 1,
      params: {},
    });
    const runId = initialRecord.id;

    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ summary: 'all good' });
    })();
    const deps: AgentDeps = {
      store,
      workflowStore: makeWorkflowStore(walWf),
      provider,
      registry: createDefaultRegistry(),
      // traceBufferStore intentionally omitted.
    };

    const result = await runAgent(deps, {
      existingRunId: runId,
      definition: walWf,
      params: {},
    });

    expect(result).toBe('completed');
  });
});

describe('runAgent — capability recovery (#134)', () => {
  const handlerWorkflow: WorkflowDefinition = {
    id: 'handler-agent',
    name: 'Handler Agent',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { enrich: { description: 'Enrich', execution: 'auto', handler: 'enricher' } },
  };
  const stubProvider = new (class extends LlmProvider {
    callStep = vi.fn();
  })();

  it('not-registered handler → capability-aware guidance (not ✗ Step failed), then RECOVERS on re-attach with a fixed registry', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new InMemoryStore();
    const { run } = await store.create({
      workflowId: 'handler-agent',
      workflowVersion: 1,
      params: {},
    });

    // 1) Broken runner (empty registry) → the auto step blocks recoverably; guidance, not a bare fail.
    const broken = await runAgent(
      {
        store,
        workflowStore: makeWorkflowStore(handlerWorkflow),
        provider: stubProvider,
        registry: new ExtensionRegistry(),
      },
      { existingRunId: run.id, definition: handlerWorkflow, params: {} },
    );
    expect(broken).toBe('failed'); // no 'blocked' AgentRunResult variant, by design
    const printed = errorSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('is blocked');
    expect(printed).toContain("handler 'enricher'");
    expect(printed).toContain('re-attach');
    expect(printed).not.toContain('✗ Step');
    const afterBlock = await store.get(run.id);
    expect(afterBlock.terminal_state).toBe(false); // NOT terminal-burned
    expect(afterBlock.failed_steps).not.toContain('enrich');
    expect(afterBlock.capability_blocks?.['enrich']).toBeDefined();
    errorSpy.mockRestore();

    // 2) Fixed runner re-attaches and drives the SAME run to completion (recovery proof).
    const good = new ExtensionRegistry();
    good.register('handler', 'enricher', {
      id: 'enricher',
      execute: async () => ({ data: { enriched: true } }),
    });
    const recovered = await runAgent(
      {
        store,
        workflowStore: makeWorkflowStore(handlerWorkflow),
        provider: stubProvider,
        registry: good,
      },
      { existingRunId: run.id, definition: handlerWorkflow, params: {} },
    );
    expect(recovered).toBe('completed');
    const done = await store.get(run.id);
    expect(done.terminal_state).toBe(true);
    expect(done.completed_steps).toContain('enrich');
  });
});

describe('runAgent — effective output schema routing (#robust-anthropic-provider Part 1, mandate test 2)', () => {
  // A step declaring ONLY output_schema (no input_schema) — mirrors assess_message_actionability /
  // classify_intent. Before Part 1 the provider received `undefined` for its schema argument;
  // reverting run-agent.ts's `stepDef.output_schema ?? ...` precedence (Part 1) makes these strand
  // on `undefined` again — see reports/robust-anthropic-provider.md for the by-value mutation-probe.
  const outputSchema = {
    type: 'object',
    properties: { category: { type: 'string' } },
    required: ['category'],
  };

  it('callStep path: the provider receives output_schema as its schema argument', async () => {
    const def: WorkflowDefinition = {
      id: 'output-only-callstep-wf',
      name: 'Output Only',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        classify: { description: 'Classify', execution: 'agent', output_schema: outputSchema },
      },
    };
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ category: 'billing' });
    })();

    const result = await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('completed');
    expect(provider.callStep).toHaveBeenCalledTimes(1);
    // Second positional arg is the schema — today (pre-Part-1) this would be `undefined`.
    expect(provider.callStep.mock.calls[0]?.[1]).toEqual(outputSchema);
  });

  it('callStepWithTools path: the provider receives output_schema in options.inputSchema', async () => {
    const def: WorkflowDefinition = {
      id: 'output-only-tools-wf',
      name: 'Output Only (tools)',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      mcp_servers: [
        { id: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-github'] },
      ],
      steps: {
        classify: {
          description: 'Classify',
          execution: 'agent',
          tools: ['github:get_pull_request'],
          // input_schema is required alongside `tools` (loader constraint) — output_schema is the
          // ENGINE-validated schema and must take precedence over it once routed (Part 1).
          input_schema: { type: 'object', properties: { note: { type: 'string' } } },
          output_schema: outputSchema,
        },
      },
    };
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi
        .fn()
        .mockResolvedValue({ output: { category: 'billing' }, toolCalls: [] });
    })();
    const mockClient = makeMockMcpClient();

    const result = await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
        mcpClientFactory: () => mockClient,
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('completed');
    expect(provider.callStepWithTools).toHaveBeenCalledTimes(1);
    const optsArg = provider.callStepWithTools.mock.calls[0]?.[3] as { inputSchema?: unknown };
    // output_schema wins over input_schema — the effective schema fed to the provider.
    expect(optsArg.inputSchema).toEqual(outputSchema);
  });
});

// ---------------------------------------------------------------------------
// issue #217 — in-drive schema-feedback repair loop
// ---------------------------------------------------------------------------

/** A single agent step, `execution: 'agent'`, description 'Draft' — schema declared via override. */
function agentWorkflow(
  overrides: Partial<WorkflowDefinition['steps'][string]> = {},
): WorkflowDefinition {
  return {
    id: 'repair-wf',
    name: 'Repair WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      draft: {
        description: 'Draft',
        execution: 'agent',
        ...overrides,
      },
    },
  };
}

/** A single tools-path agent step declaring both input_schema (loader-required alongside `tools`)
 *  and output_schema (the schema actually exercised by these tests). */
function toolsWorkflow(): WorkflowDefinition {
  return {
    id: 'tools-repair-wf',
    name: 'Tools Repair WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    mcp_servers: [{ id: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-github'] }],
    steps: {
      draft: {
        description: 'Draft',
        execution: 'agent',
        tools: ['github:get_pull_request'],
        input_schema: { type: 'object', properties: { note: { type: 'string' } } },
        output_schema: {
          type: 'object',
          properties: { category: { type: 'string', enum: ['ok'] } },
          required: ['category'],
        },
      },
    },
  };
}

/**
 * A trace-buffer store whose `read()` always throws a generic (non-WorkflowError) — reproduces a
 * genuinely PRE-claim, non-validation ENGINE_STORE_FAILED envelope (test 7). execution-loop.ts
 * reads the WAL before claimStep for an agent step, so this failure occurs before any run-record
 * version bump — cleanly isolating conjunct (ii) from the run_version-based conjunct (vi): a
 * POST-claim non-validation failure (e.g. a settle-time `store.update()` throw) would ALSO
 * independently fail (vi) (its envelope's run_version differs from the pre-claim baseline,
 * confirmed empirically), which would mask conjunct (ii) in probe (a).
 */
const throwingTraceBufferStore = {
  read: async () => {
    throw new Error('simulated trace-buffer read failure');
  },
} as unknown as TraceBufferStore;

/**
 * issue #217 correction, deliverable 3a — concurrency witness store. Simulates a concurrent
 * EXTERNAL writer (a second drive, a gate `respond`, a parallel-step settle) bumping the run's
 * version WHILE a repair attempt is in flight. `armed` is flipped externally by the test's
 * console.error spy the instant the FIRST 'repairing' line prints. The very NEXT `get(runId)`
 * call — from ANY caller sharing this store instance (the drive's own per-attempt baseline read
 * under the fix, or the engine's internal pre-claim read either way) — performs exactly ONE
 * `super.update({...await super.get(runId)})` (a genuine version bump, no other field touched)
 * BEFORE returning the (now-bumped) record, modeling a real external write racing in. Bumps only
 * once (`bumped` latches), so later `get()` calls just pass through.
 */
class ConcurrentWriterStore extends InMemoryStore {
  armed = false;
  private bumped = false;
  override async get(runId: string): Promise<RunRecord> {
    if (this.armed && !this.bumped) {
      this.bumped = true;
      const current = await super.get(runId);
      await super.update({ ...current });
    }
    return super.get(runId);
  }
}

describe('runAgent — schema-feedback repair loop (issue #217)', () => {
  it('test 1: repair-success — 2 provider calls; attempt-2 prompt carries the summary, never the raw AJV leak (enum.allowedValues)', async () => {
    const def = agentWorkflow({
      output_schema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['SENTINEL_ALLOWED_ZZZ'] } },
        required: ['status'],
      },
    });
    const provider = new (class extends LlmProvider {
      callStep = vi
        .fn()
        .mockResolvedValueOnce({ status: 'WRONG_VALUE_MARKER_XYZ' })
        .mockResolvedValueOnce({ status: 'SENTINEL_ALLOWED_ZZZ' });
    })();

    const result = await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('completed');
    expect(provider.callStep).toHaveBeenCalledTimes(2);
    const secondPrompt = provider.callStep.mock.calls[1]?.[0] as string;
    // (i) carries the enum failure message.
    expect(secondPrompt).toContain('must be equal to one of the allowed values');
    // (ii) never leaks the allowed value — the raw AJV array would via params.allowedValues.
    expect(secondPrompt).not.toContain('SENTINEL_ALLOWED_ZZZ');
    // (iii) never leaks a sentinel from a VALUE position of the invalid output either (future-
    // proofing — non-verbose Ajv never echoes data values, so (ii) is the real discriminator).
    expect(secondPrompt).not.toContain('WRONG_VALUE_MARKER_XYZ');
  });

  it('test 1b: positive visibility witness — the per-repair stderr line is actually emitted (every existing assertion up to now only checked its ABSENCE on non-repair paths)', async () => {
    const def = agentWorkflow({
      output_schema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['SENTINEL_ALLOWED_ZZZ'] } },
        required: ['status'],
      },
    });
    const provider = new (class extends LlmProvider {
      callStep = vi
        .fn()
        .mockResolvedValueOnce({ status: 'WRONG_VALUE_MARKER_XYZ' })
        .mockResolvedValueOnce({ status: 'SENTINEL_ALLOWED_ZZZ' });
    })();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('completed');
    // Exactly one repair happens (1 rejection, then valid) — exactly one console.error call on
    // this clean success path (no other error branch is reachable here).
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      '⚠ output rejected (VALIDATION_OUTPUT_SCHEMA); repairing (attempt 1/2)',
    );
    errorSpy.mockRestore();
  });

  it('test 2: LATEST-only feedback — attempt-3 prompt carries ONLY rejection-2, never rejection-1, and exactly one feedback-block header', async () => {
    const schema = {
      type: 'object',
      properties: { alpha: { type: 'string' }, beta: { type: 'number' } },
      required: ['alpha', 'beta'],
    };
    const def = agentWorkflow({ output_schema: schema });
    const provider = new (class extends LlmProvider {
      callStep = vi
        .fn()
        .mockResolvedValueOnce({ beta: 5 }) // rejection 1: required-miss on 'alpha'
        .mockResolvedValueOnce({ alpha: 'x', beta: 'not-a-number' }) // rejection 2: type-miss at /beta
        .mockResolvedValueOnce({ alpha: 'x', beta: 5 }); // valid
    })();

    const result = await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('completed');
    expect(provider.callStep).toHaveBeenCalledTimes(3);
    const thirdPrompt = provider.callStep.mock.calls[2]?.[0] as string;
    expect(thirdPrompt).toContain('/beta'); // rejection-2-unique marker present
    expect(thirdPrompt).not.toContain("'alpha'"); // rejection-1-unique marker absent
    const headerMatches = thirdPrompt.match(/rejected by the output schema validator:/g) ?? [];
    expect(headerMatches).toHaveLength(1); // exactly one feedback-block header
  });

  it('test 3 REPLACEMENT (issue #220 SHIPPED): persistent rejection across TWO FULL default drives (3 attempts/drive × 2 = 6 = the default exhaustion threshold) terminalizes with VALIDATION_EXHAUSTED — the fixture declares NO validation_exhaustion key at all, pinning AUTO-ENROLLMENT at the default threshold (a default-mode-off mutant reds; deleted-and-replaced per the design record, not reddened — the original #220-pending pin predicted exactly this break)', async () => {
    const schema = {
      type: 'object',
      properties: { alpha: { type: 'string' } },
      required: ['alpha'],
    };
    const def = agentWorkflow({ output_schema: schema }); // NO validation_exhaustion key
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({}); // always invalid — missing 'alpha' every time
    })();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new InMemoryStore();
    const { run } = await store.create({
      workflowId: def.id,
      workflowVersion: def.version,
      params: {},
    });

    // Drive 1: 1 + 2 repairs = 3 attempts (rejections 1-3 of the default threshold of 6).
    const result1 = await runAgent(
      { store, workflowStore: makeWorkflowStore(def), provider, registry: createDefaultRegistry() },
      { existingRunId: run.id, definition: def, params: {} },
    );
    expect(result1).toBe('failed');
    const afterDrive1 = await store.get(run.id);
    expect(afterDrive1.terminal_state).toBe(false); // 3 < 6 — not yet at threshold
    expect(afterDrive1.validation_rejections?.['draft']).toBe(3);
    expect(findEligibleSteps(def, afterDrive1)).toContain('draft'); // still re-drivable

    // Drive 2: 3 MORE attempts (rejections 4-6) — the 6th reaches the default threshold and
    // terminalizes the step with VALIDATION_EXHAUSTED instead of returning control at attempt 3.
    const result2 = await runAgent(
      { store, workflowStore: makeWorkflowStore(def), provider, registry: createDefaultRegistry() },
      { existingRunId: run.id, definition: def, params: {} },
    );
    expect(result2).toBe('failed');
    expect(provider.callStep).toHaveBeenCalledTimes(6);

    const after = await store.get(run.id);
    expect(after.terminal_state).toBe(true);
    expect(after.run_phase).toBe('failed');
    expect(after.failed_steps).toContain('draft');
    expect(after.validation_rejections?.['draft']).toBe(6);
    errorSpy.mockRestore();
  });

  it("issue #220 deliverable 7 — coherence warn (pin (i)): schemaRetries exceeding the effective exhaustion threshold prints one stderr warning at the step's first attempt; the defaults (schemaRetries=2, threshold=6) print none", async () => {
    const schema = {
      type: 'object',
      properties: { alpha: { type: 'string' } },
      required: ['alpha'],
    };

    // Case 1: schemaRetries 7 (budget 8 attempts) vs a per-step threshold of 6 ⇒ warns.
    const defLowThreshold = agentWorkflow({
      output_schema: schema,
      validation_exhaustion: { threshold: 6 },
    });
    const providerAlwaysValid = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ alpha: 'x' });
    })();
    const errorSpyWarn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(defLowThreshold),
        provider: providerAlwaysValid,
        registry: createDefaultRegistry(),
        schemaRetries: 7,
      },
      { definition: defLowThreshold, params: {} },
    );
    const printedWarn = errorSpyWarn.mock.calls.flat().join('\n');
    expect(printedWarn).toContain('--schema-retries');
    expect(printedWarn).toContain('validation-exhaustion threshold');
    errorSpyWarn.mockRestore();

    // Case 2: defaults (schemaRetries=2, threshold=6 via DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD)
    // ⇒ no warning (2 + 1 = 3 ≤ 6).
    const defDefault = agentWorkflow({ output_schema: schema });
    const errorSpyNoWarn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(defDefault),
        provider: providerAlwaysValid,
        registry: createDefaultRegistry(),
      },
      { definition: defDefault, params: {} },
    );
    const printedNoWarn = errorSpyNoWarn.mock.calls.flat().join('\n');
    expect(printedNoWarn).not.toContain('validation-exhaustion threshold');
    errorSpyNoWarn.mockRestore();
  });

  it('issue #220 pin (h) — mid-loop truncation fails closed: a per-step threshold of 2 with the default schemaRetries (2) terminalizes at attempt 2 with the DISTINCT VALIDATION_EXHAUSTED code, and the repair loop breaks there — no repair is attempted on it', async () => {
    const schema = {
      type: 'object',
      properties: { alpha: { type: 'string' } },
      required: ['alpha'],
    };
    const def = agentWorkflow({
      output_schema: schema,
      validation_exhaustion: { threshold: 2 },
    });
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({}); // always invalid — missing 'alpha' every time
    })();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new InMemoryStore();

    const result = await runAgent(
      { store, workflowStore: makeWorkflowStore(def), provider, registry: createDefaultRegistry() },
      { definition: def, params: {} },
    );

    expect(result).toBe('failed');
    // Attempt 1 rejects at count 1 (< threshold 2) — an ORDINARY repairable VALIDATION_OUTPUT_SCHEMA,
    // so the gate legitimately repairs once. Attempt 2 rejects at count 2 (=== threshold) —
    // terminalizes as VALIDATION_EXHAUSTED, a DISTINCT code the repair gate's own conjunct
    // (error_code ∈ {VALIDATION_OUTPUT_SCHEMA, VALIDATION_INPUT_SCHEMA}) never matches, so the
    // loop breaks THERE instead of attempting a 3rd repair on an already-terminalized step. Only
    // 2 provider calls total — NOT schemaRetries+1 (3) — and only ONE "repairing" line, not two.
    expect(provider.callStep).toHaveBeenCalledTimes(2);
    const printed = errorSpy.mock.calls.flat().join('\n');
    expect(printed.match(/repairing/g) ?? []).toHaveLength(1); // exactly one repair, not a second
    expect(printed).toContain('after 1 schema-repair attempts'); // never "after 2"
    errorSpy.mockRestore();
  });

  it('test 3a: concurrent-writer repair-survival — a run-version bump from an external writer landing mid-attempt does not silently forfeit a legitimate repair (per-attempt baseline)', async () => {
    const schema = {
      type: 'object',
      properties: { alpha: { type: 'string' } },
      required: ['alpha'],
    };
    const def = agentWorkflow({ output_schema: schema });
    const store = new ConcurrentWriterStore();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const line = typeof args[0] === 'string' ? args[0] : '';
      if (line.includes('repairing')) {
        store.armed = true;
      }
    });
    const provider = new (class extends LlmProvider {
      callStep = vi
        .fn()
        .mockResolvedValueOnce({}) // rejection 1: missing 'alpha'
        .mockResolvedValueOnce({}) // rejection 2: still missing 'alpha' (post-bump attempt)
        .mockResolvedValueOnce({ alpha: 'x' }); // valid
    })();

    const result = await runAgent(
      { store, workflowStore: makeWorkflowStore(def), provider, registry: createDefaultRegistry() },
      { definition: def, params: {} },
    );

    // Under the shipped per-STEP capture this survives only 2 calls (repair 2 is falsely
    // forfeited — see the report's red-on-shipped transcript). Under the per-ATTEMPT fix, the
    // attempt-2 loop-top baseline get absorbs the external bump, so repair 2 fires and the drive
    // completes.
    expect(result).toBe('completed');
    expect(provider.callStep).toHaveBeenCalledTimes(3);
    errorSpy.mockRestore();
  });

  it('test 4: VALIDATION_INPUT_SCHEMA variant — repair fires for an agent step declaring only input_schema', async () => {
    const schema = {
      type: 'object',
      properties: { alpha: { type: 'string' } },
      required: ['alpha'],
    };
    const def = agentWorkflow({ input_schema: schema });
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ alpha: 'x' });
    })();

    const result = await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('completed');
    expect(provider.callStep).toHaveBeenCalledTimes(2);
    const secondPrompt = provider.callStep.mock.calls[1]?.[0] as string;
    expect(secondPrompt).toContain('rejected by the input schema validator');
  });

  it('test 5: auto-step never repairs — exactly one executeChain submission (one auto-banner print), no repair message', async () => {
    const def: WorkflowDefinition = {
      id: 'auto-repair-wf',
      name: 'Auto Repair WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        finalize: {
          description: 'Finalize',
          execution: 'auto',
          input_schema: {
            type: 'object',
            properties: { alpha: { type: 'string' } },
            required: ['alpha'],
          },
        },
      },
    };
    const provider = new (class extends LlmProvider {
      callStep = vi.fn();
    })();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('failed');
    expect(provider.callStep).not.toHaveBeenCalled();
    const autoLines = logSpy.mock.calls
      .flat()
      .filter((l) => typeof l === 'string' && l.includes('→ [auto] finalize'));
    expect(autoLines).toHaveLength(1);
    const printed = errorSpy.mock.calls.flat().join('\n');
    expect(printed).not.toContain('repairing');
    expect(printed).not.toContain('schema-repair');

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('test 6a: --schema-retries 0 — exactly 1 provider call, byte-identical today-behavior (no repair)', async () => {
    const schema = {
      type: 'object',
      properties: { alpha: { type: 'string' } },
      required: ['alpha'],
    };
    const def = agentWorkflow({ output_schema: schema });
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({}); // always invalid
    })();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
        schemaRetries: 0,
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('failed');
    expect(provider.callStep).toHaveBeenCalledTimes(1);
    const printed = errorSpy.mock.calls.flat().join('\n');
    expect(printed).not.toContain('schema-repair');
    errorSpy.mockRestore();
  });

  describe('test 6b: --schema-retries argParser', () => {
    beforeEach(() => {
      vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("rejects a non-numeric value loudly ('abc')", async () => {
      await agentCommand
        .parseAsync(['node', 'realm', '--workflow', 'x', '--schema-retries', 'abc'])
        .catch(() => {});
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("rejects a negative value loudly ('-1')", async () => {
      await agentCommand
        .parseAsync(['node', 'realm', '--workflow', 'x', '--schema-retries', '-1'])
        .catch(() => {});
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('the parseArg itself throws InvalidArgumentError for non-numeric/negative input, and defaults to the numeric 2', () => {
      const opt = agentCommand.options.find((o) => o.long === '--schema-retries')!;
      expect(() => opt.parseArg!('abc', undefined)).toThrow(InvalidArgumentError);
      expect(() => opt.parseArg!('-1', undefined)).toThrow(InvalidArgumentError);
      expect(opt.parseArg!('5', undefined)).toBe(5);
      // issue #217 correction: `agentCommand.opts()` reads the SHARED singleton's last-parsed
      // state, which the two parseAsync sub-tests above already mutated (order-coupled) — read
      // the Option's own static `defaultValue` instead, which is set once at Command construction
      // and never mutated by parsing.
      expect(opt.defaultValue).toBe(2);
    });
  });

  it('test 7: non-validation error on an agent step ⇒ no repair (exactly 1 provider call)', async () => {
    const def = agentWorkflow(); // no schema at all — any output would settle
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ anything: true });
    })();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
        traceBufferStore: throwingTraceBufferStore,
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('failed');
    expect(provider.callStep).toHaveBeenCalledTimes(1);
    const printed = errorSpy.mock.calls.flat().join('\n');
    expect(printed).not.toContain('repairing');
    expect(printed).not.toContain('schema-repair');
    errorSpy.mockRestore();
  });

  it('test 8a: tools path, zero toolCalls on the invalid attempt ⇒ repair fires and succeeds', async () => {
    const def = toolsWorkflow();
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi
        .fn()
        .mockResolvedValueOnce({ output: { category: 'WRONG' }, toolCalls: [] })
        .mockResolvedValueOnce({ output: { category: 'ok' }, toolCalls: [] });
    })();
    const mockClient = makeMockMcpClient();

    const result = await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
        mcpClientFactory: () => mockClient,
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('completed');
    expect(provider.callStepWithTools).toHaveBeenCalledTimes(2);
  });

  it("test 8b: tools path, toolCalls>0 on the invalid attempt ⇒ NO repair (today's failure path)", async () => {
    const def = toolsWorkflow();
    const toolCalls: ToolCallRecord[] = [
      {
        tool: 'get_pull_request',
        server_id: 'github',
        args: {},
        result: 'x',
        duration_ms: 1,
      },
    ];
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi.fn().mockResolvedValue({ output: { category: 'WRONG' }, toolCalls });
    })();
    const mockClient = makeMockMcpClient();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
        mcpClientFactory: () => mockClient,
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('failed');
    expect(provider.callStepWithTools).toHaveBeenCalledTimes(1);
    const printed = errorSpy.mock.calls.flat().join('\n');
    expect(printed).not.toContain('schema-repair');
    errorSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // issue #224 D4(b) — the provider RETURNING a still-invalid output (its own in-conversation
  // correction having been exhausted, per D4's budget-terminal fix) must still be COUNTED by the
  // engine's Step 2c countRejection (issue #220), even though run-agent's OWN #217 repair loop
  // declines to retry (toolCalls.length > 0). Per [audit F4]: assert on RUN-RECORD state, not on
  // runAgent's return value (which stays 'failed' either way — a #220 terminalization IS an error
  // envelope).
  // ---------------------------------------------------------------------------
  it("D4(b): tools-path — a still-invalid RETURNED output (post-#224 provider posture) increments validation_rejections via the engine's countRejection", async () => {
    const def = toolsWorkflow();
    const toolCalls: ToolCallRecord[] = [
      {
        tool: 'get_pull_request',
        server_id: 'github',
        args: {},
        result: 'x',
        duration_ms: 1,
      },
    ];
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi.fn().mockResolvedValue({ output: { category: 'WRONG' }, toolCalls });
    })();
    const mockClient = makeMockMcpClient();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new InMemoryStore();
    const { run } = await store.create({
      workflowId: def.id,
      workflowVersion: def.version,
      params: {},
    });

    const result = await runAgent(
      {
        store,
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
        mcpClientFactory: () => mockClient,
      },
      { existingRunId: run.id, definition: def, params: {} },
    );

    expect(result).toBe('failed'); // unchanged — a #220 rejection/terminalization is still an error envelope
    const after = await store.get(run.id);
    expect(after.validation_rejections?.['draft']).toBe(1); // COUNTED — proves Step 2c engaged
    errorSpy.mockRestore();
  });

  it("D4(b) mutation-probe comparison: a THROWN provider error (the pre-#224 posture) is NEVER counted — validation_rejections stays unset, because run-agent's catch block returns 'failed' without ever reaching executeChain", async () => {
    const def = toolsWorkflow();
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi
        .fn()
        .mockRejectedValue(new Error('max_tool_calls reached; schema-invalid'));
    })();
    const mockClient = makeMockMcpClient();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new InMemoryStore();
    const { run } = await store.create({
      workflowId: def.id,
      workflowVersion: def.version,
      params: {},
    });

    const result = await runAgent(
      {
        store,
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
        mcpClientFactory: () => mockClient,
      },
      { existingRunId: run.id, definition: def, params: {} },
    );

    expect(result).toBe('failed');
    const after = await store.get(run.id);
    expect(after.validation_rejections?.['draft']).toBeUndefined(); // uncounted — never claimed/settled
    expect(after.terminal_state).toBe(false); // not even a #220 terminalization — the run was never touched
    errorSpy.mockRestore();
  });

  it('test 10: chained-auto no-false-repair — an agent step chaining into an auto step with a required-prop input_schema does not falsely repair the already-settled agent step', async () => {
    const def: WorkflowDefinition = {
      id: 'chained-auto-wf',
      name: 'Chained Auto WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        draft: { description: 'Draft', execution: 'agent' },
        finalize: {
          description: 'Finalize',
          execution: 'auto',
          depends_on: ['draft'],
          input_schema: {
            type: 'object',
            properties: { alpha: { type: 'string' } },
            required: ['alpha'],
          },
        },
      },
    };
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ ok: true });
    })();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runAgent(
      {
        store: new InMemoryStore(),
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('failed');
    expect(provider.callStep).toHaveBeenCalledTimes(1);
    const printed = errorSpy.mock.calls.flat().join('\n');
    expect(printed).not.toContain('repairing');
    expect(printed).not.toContain('schema-repair');
    errorSpy.mockRestore();
  });
});
