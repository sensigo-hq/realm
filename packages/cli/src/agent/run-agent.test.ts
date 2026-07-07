// run-agent.test.ts — Tests for runAgent() and MCP tool dispatch.
import { describe, it, expect, vi } from 'vitest';
import { runAgent } from './run-agent.js';
import type { AgentDeps } from './run-agent.js';
import type { WorkflowDefinition, ToolCallRecord } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { LlmProvider, ToolCapableLlmProvider } from './providers/llm-provider.js';
import type { McpClient, McpTool } from './mcp/mcp-extensions.js';

// ---------------------------------------------------------------------------
// MCP tools integration tests
// ---------------------------------------------------------------------------

const mcpWorkflow: WorkflowDefinition = {
  id: 'mcp-wf',
  name: 'MCP Workflow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  mcp_servers: [{ id: 'github', command: 'npx', args: ['-y', 'mcp-github'] }],
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
  it('tool calls dispatched to the correct server and tool name', async () => {
    const mockClient = makeMockMcpClient();
    const toolCalls: ToolCallRecord[] = [
      {
        tool: 'get_pull_request',
        server_id: 'github',
        args: { pr: 1 },
        result: 'PR data',
        duration_ms: 50,
        started_at: new Date().toISOString(),
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
        started_at: new Date().toISOString(),
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
        { id: 'server1', command: 'npx', args: ['-y', 'mcp-server1'] },
        { id: 'server2', command: 'npx', args: ['-y', 'mcp-server2'] },
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
      provider: { callStep: vi.fn() },
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
