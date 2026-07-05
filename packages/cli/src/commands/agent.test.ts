// Tests for runAgent(), resolveProvider(), and the agentCommand CLI guards.
// Uses InMemoryStore and MockLlmProvider to run the agent loop without real I/O.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  submitHumanResponse,
} from '@sensigo/realm';
import type { WorkflowDefinition, WorkflowRegistrar, PendingGate } from '@sensigo/realm';
import { runAgent } from '../agent/run-agent.js';
import type { AgentDeps, AgentRunOptions } from '../agent/run-agent.js';
import { LlmProvider } from '../agent/providers/llm-provider.js';
import { resolveProvider } from '../agent/providers/llm-provider.js';
import { agentCommand } from './agent.js';

// ---------------------------------------------------------------------------
// MockLlmProvider — queue-based: returns responses in order of callStep() calls.
// ---------------------------------------------------------------------------

class MockLlmProvider extends LlmProvider {
  readonly callCount: { value: number } = { value: 0 };
  private readonly responses: Array<Record<string, unknown> | Error>;

  constructor(responses: Array<Record<string, unknown> | Error>) {
    super();
    this.responses = responses;
  }

  async callStep(
    _prompt: string,
    _schema?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = this.responses[this.callCount.value++];
    if (response instanceof Error) throw response;
    return response ?? {};
  }
}

// ---------------------------------------------------------------------------
// Stub WorkflowRegistrar — no-op register, not needed for test assertions.
// ---------------------------------------------------------------------------

function makeWorkflowStore(): WorkflowRegistrar {
  return {
    async register() {},
    async get() {
      throw new Error('not used in these tests');
    },
    async list() {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Workflow definitions used across tests.
// ---------------------------------------------------------------------------

const agentOnlyWorkflow: WorkflowDefinition = {
  id: 'agent-only',
  name: 'Agent Only',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    summarize: {
      description: 'Summarize the input',
      execution: 'agent',
      input_schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
};

const gateWorkflow: WorkflowDefinition = {
  id: 'gate-wf',
  name: 'Gate Workflow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    agent_step: {
      description: 'Agent step before the gate',
      execution: 'agent',
    },
    gate_step: {
      description: 'Human approval gate',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: ['agent_step'],
      gate: { choices: ['approve'] },
    },
  },
};

const errorWorkflow: WorkflowDefinition = {
  id: 'error-wf',
  name: 'Error Workflow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  // No services section — 'broken' service will not resolve.
  steps: {
    broken_step: {
      description: 'Step that calls a missing service',
      execution: 'auto',
      uses_service: 'broken',
      service_method: 'fetch',
      operation: 'anything',
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<AgentDeps> = {}): AgentDeps & { store: InMemoryStore } {
  const store = new InMemoryStore();
  return {
    store,
    workflowStore: makeWorkflowStore(),
    provider: new MockLlmProvider([]),
    registry: createDefaultRegistry(),
    ...overrides,
  };
}

function makeOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return { params: {}, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAgent', () => {
  it('returns completed when all agent steps resolve', async () => {
    const deps = makeDeps({ provider: new MockLlmProvider([{ summary: 'all good' }]) });

    const result = await runAgent(deps, makeOptions({ definition: agentOnlyWorkflow }));

    expect(result).toBe('completed');
  });

  it('retries the LLM call once then returns failed when both attempts throw', async () => {
    const provider = new MockLlmProvider([new Error('bad JSON'), new Error('bad JSON again')]);
    const deps = makeDeps({ provider });

    const result = await runAgent(deps, makeOptions({ definition: agentOnlyWorkflow }));

    expect(result).toBe('failed');
    expect(provider.callCount.value).toBe(2);
  });

  it('succeeds when the LLM call fails on the first attempt but succeeds on the second', async () => {
    const provider = new MockLlmProvider([new Error('transient error'), { summary: 'recovered' }]);
    const deps = makeDeps({ provider });

    const result = await runAgent(deps, makeOptions({ definition: agentOnlyWorkflow }));

    expect(result).toBe('completed');
    expect(provider.callCount.value).toBe(2);
  });

  it('pauses at a gate and continues after the gateHandler resolves it', async () => {
    const provider = new MockLlmProvider([{ output: 'step done' }]);
    const gateHandler = vi.fn().mockImplementation(async (runId: string, gate: PendingGate) => {
      const run = await deps.store.get(runId);
      await submitHumanResponse(deps.store, gateWorkflow, {
        runId,
        gateId: gate.gate_id,
        choice: 'approve',
      });
      void run; // keep TS happy
    });
    const deps = makeDeps({ provider, gateHandler });

    const result = await runAgent(deps, makeOptions({ definition: gateWorkflow }));

    expect(result).toBe('completed');
    expect(gateHandler).toHaveBeenCalledOnce();
  });

  it('returns failed when executeChain returns status: error', async () => {
    const deps = makeDeps();

    const result = await runAgent(deps, makeOptions({ definition: errorWorkflow }));

    expect(result).toBe('failed');
  });

  it('throws when the workflow file does not exist', async () => {
    const deps = makeDeps();

    await expect(
      runAgent(deps, makeOptions({ workflowPath: '/nonexistent/path/workflow.yaml' })),
    ).rejects.toThrow();
  });
});

describe('resolveProvider', () => {
  let savedOpenAI: string | undefined;
  let savedAnthropic: string | undefined;

  beforeEach(() => {
    savedOpenAI = process.env['OPENAI_API_KEY'];
    savedAnthropic = process.env['ANTHROPIC_API_KEY'];
  });

  afterEach(() => {
    // Restore original values so local developers with real keys are unaffected.
    if (savedOpenAI === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = savedOpenAI;
    }
    if (savedAnthropic === undefined) {
      delete process.env['ANTHROPIC_API_KEY'];
    } else {
      process.env['ANTHROPIC_API_KEY'] = savedAnthropic;
    }
  });

  it('throws when neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set', async () => {
    delete process.env['OPENAI_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];

    await expect(resolveProvider(undefined, undefined)).rejects.toThrow(
      'realm agent requires an LLM API key',
    );
  });

  it('throws when --base-url is set and provider resolves to anthropic (explicit flag)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    delete process.env['OPENAI_API_KEY'];

    await expect(
      resolveProvider('anthropic', undefined, 'https://api.example.com'),
    ).rejects.toThrow('--base-url is only supported with --provider openai');
  });

  it('throws when --base-url is set and anthropic is auto-detected (no openai key)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    delete process.env['OPENAI_API_KEY'];

    await expect(resolveProvider(undefined, undefined, 'https://api.example.com')).rejects.toThrow(
      '--base-url is only supported with --provider openai',
    );
  });

  it('does not throw when --base-url is set with --provider openai', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    delete process.env['ANTHROPIC_API_KEY'];

    // The guard must not fire — resolveProvider returns successfully for openai + base-url.
    const provider = await resolveProvider('openai', undefined, 'https://api.deepseek.com');
    expect(provider).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('agentCommand CLI guards', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits with 1 and prints error when neither --workflow nor --run-id is provided', async () => {
    await agentCommand.parseAsync(['node', 'realm']).catch(() => {});
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--workflow or --run-id'));
  });

  it('exits with 1 and prints error when both --workflow and --run-id are provided', async () => {
    await agentCommand
      .parseAsync(['node', 'realm', '--workflow', 'some/path', '--run-id', 'run_abc'])
      .catch(() => {});
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('mutually exclusive'));
  });

  it('exits with 1 and prints error when --params is used with --run-id', async () => {
    await agentCommand
      .parseAsync(['node', 'realm', '--run-id', 'run_abc', '--params', '{"key":"val"}'])
      .catch(() => {});
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('--params cannot be used with --run-id'),
    );
  });
});
