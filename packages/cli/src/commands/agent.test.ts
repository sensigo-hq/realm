// Tests for runAgent(), resolveProvider(), and the agentCommand CLI guards.
// Uses InMemoryStore and MockLlmProvider to run the agent loop without real I/O.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import {
  serializeToolResult,
  setAdditionalRedactionValues,
} from '../agent/providers/agent-utils.js';

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

// `store` is excluded from the override type so the declared `store: InMemoryStore` return stays
// honest: every call site takes the InMemoryStore built here (no caller overrides it), and a
// `Partial<AgentDeps>` override would widen it back to the bare `RunStore` interface.
function makeDeps(
  overrides: Omit<Partial<AgentDeps>, 'store'> = {},
): AgentDeps & { store: InMemoryStore } {
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

  // issue #401: the two cells that used to live here pinned the outer `attempt < 2` retry loop —
  // "retries once then fails" and "succeeds on the second attempt". That loop is RETIRED, and its
  // retirement is the point of the change: a silent second attempt is precisely what made a
  // failing drive invisible. The first failure was swallowed, the second exited, and the run
  // record said nothing either way.
  it('RETIREMENT — one failure means ONE provider call, an immediate failure, and a recorded entry', async () => {
    const provider = new MockLlmProvider([new Error('transient error')]);
    const deps = makeDeps({ provider });
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m));
    });

    try {
      const result = await runAgent(deps, makeOptions({ definition: agentOnlyWorkflow }));

      expect(result).toBe('failed');
      // Exactly ONE — the retry that used to rescue this is gone. Re-attaching is the retry now.
      expect(provider.callCount.value).toBe(1);

      // The failure is RECORDED, which is the whole reason the retry could be retired.
      const runs = await deps.store.list();
      const run = await deps.store.get(runs[0]!.id);
      expect(run.drive_failures?.entries).toHaveLength(1);
      expect(run.drive_failures?.total).toBe(1);
      expect(run.drive_failures?.entries[0]?.message).toContain('transient error');

      // The printed line now carries the step AND the provider's message — the retired line said
      // only "failed after 2 attempts", which told an operator neither.
      const printed = errors.join('\n');
      expect(printed).toContain('LLM call failed');
      expect(printed).toContain('transient error');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('RETIREMENT — the retired loop leaves no trace in the source', async () => {
    // Source assertion (the census idiom): the old line is unreachable AND unwritten. A comment
    // describing the retirement is fine; the emitted string is not.
    const src = await readFile(
      join(fileURLToPath(new URL('.', import.meta.url)), '..', 'agent', 'run-agent.ts'),
      'utf8',
    );
    expect(src).not.toContain('failed after 2 attempts');
    expect(src).not.toContain('attempt < 2');
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
describe('resolveProvider — issue #313 dead-config cells 3 and 4', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'test-key';
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = saved;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------------------------
  // The FLAG-TRAVEL pin pair. Everything else about --strict-base-url is pinned on a REJECTION
  // path (anthropic throws, o1 drops it) or by constructing OpenAIProvider directly. Neither
  // touches the leg that makes the feature work: the flag actually reaching the constructor
  // through resolveProvider. Without these two cells, replacing `strictBaseUrlFlag === true`
  // with `false` at that call site kills the whole feature silently — every other test stays
  // green, and strict is never sent to any attested endpoint again.
  //
  // A direct-ctor cell cannot substitute: it bypasses the seam under test.
  // -------------------------------------------------------------------------------------------
  it('flag-travel (i): --strict-base-url ARRIVES at the provider — an attested compat endpoint carries NO strictGate', async () => {
    const p = await resolveProvider('openai', 'gpt-4o', 'https://compat.example.com', true);
    // Deep-equal, so a strictGate surviving the attestation reds here.
    expect(p.capabilities()).toEqual({
      jsonMode: false,
      providerId: 'openai',
      toolArgsStrict: true,
    });
  });

  it('flag-travel (ii): the discriminating counterpart — the SAME call without the attestation IS gated', async () => {
    const explicitFalse = await resolveProvider(
      'openai',
      'gpt-4o',
      'https://compat.example.com',
      false,
    );
    expect(explicitFalse.capabilities()).toEqual({
      jsonMode: false,
      providerId: 'openai',
      toolArgsStrict: true,
      strictGate: 'compat_endpoint',
    });
    // …and omitted entirely (the CLI passes nothing when the flag is absent).
    const omitted = await resolveProvider('openai', 'gpt-4o', 'https://compat.example.com');
    expect(omitted.capabilities()).toEqual({
      jsonMode: false,
      providerId: 'openai',
      toolArgsStrict: true,
      strictGate: 'compat_endpoint',
    });
  });

  it('dead-config 3: --strict-base-url with --provider anthropic is dead — anthropic already REFUSES --base-url, and the flag alone changes nothing', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    try {
      // The pre-existing hard refusal still governs the combination that CAN be expressed.
      await expect(
        resolveProvider('anthropic', 'claude-sonnet-4-5', 'https://x.example.com', true),
      ).rejects.toThrow('--base-url is only supported with --provider openai');
      // Flag alone: no --base-url to attest about, so the Anthropic provider is built normally
      // and the attestation is inert (the CLI layer is what warns — cell 1).
      const p = await resolveProvider('anthropic', 'claude-sonnet-4-5', undefined, true);
      expect(p.capabilities().providerId).toBe('anthropic');
      expect(p.capabilities().strictGate).toBeUndefined();
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });

  it('dead-config 4: the o1 branch DROPS --base-url/--strict-base-url and now says so (it silently ignored them before)', async () => {
    const p = await resolveProvider('openai', 'o1-mini', 'https://compat.example.com', true);
    expect(p.capabilities().providerId).toBe('openai-reasoning');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('ignored for the o1 model family'),
    );
    const printed = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    expect(printed).toContain('--base-url');
    expect(printed).toContain('--strict-base-url');
  });

  it('the o1 branch stays SILENT when neither flag was supplied', async () => {
    await resolveProvider('openai', 'o1-mini', undefined, false);
    expect(console.error).not.toHaveBeenCalled();
  });
});

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

  // issue #425 — the family split at `realm agent`. This catch wraps the ENTIRE drive, so its
  // else-arm carries provider failures, store errors and everything else a run can hit: the
  // control cell below is what makes the split a split rather than a blanket prefix drop.
  it('a loader refusal prints verbatim, with no doubled "invalid"', async () => {
    // The provider-key guard runs BEFORE the workflow is loaded, so without this the cell never
    // reaches the catch under test (verified: it exits on "requires an LLM API key" instead).
    const savedKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'test-key';
    const dir = mkdtempSync(join(tmpdir(), 'realm-agent-voice-'));
    const file = join(dir, 'workflow.yaml');
    writeFileSync(
      file,
      `id: agent-voice
name: Agent Voice
version: 1
steps:
  a:
    description: a
    execution: agent
    timeout_seconds: 60
`,
      'utf8',
    );

    await agentCommand.parseAsync(['node', 'realm', '--workflow', file]).catch(() => {});

    const errored = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(errored).toContain("Invalid workflow: Step 'a': 'timeout_seconds' is not valid");
    expect(errored).not.toContain('Error: Invalid workflow');
    rmSync(dir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = savedKey;
  });

  it('a NON-loader failure keeps its prefix — the whole drive rides this arm', async () => {
    const savedKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'test-key';
    const dir = mkdtempSync(join(tmpdir(), 'realm-agent-voice-missing-'));
    await agentCommand
      .parseAsync(['node', 'realm', '--workflow', join(dir, 'no-such-file.yaml')])
      .catch(() => {});

    const errored = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(errored).toMatch(/^Error: /m);
    expect(errored).not.toContain('Invalid workflow');
    rmSync(dir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = savedKey;
  });

  // issue #313 — the four dead-config cells. Silently accepting a flag that changes nothing is
  // the class the #291 F10 precedent says to warn about: the author believes they configured
  // something. Cell 2 is an exit-1 ERROR (a genuine conflict); cells 1/3/4 are warns.
  it('dead-config 1: --strict-base-url WITHOUT --base-url warns (it attests about a compat endpoint that was never configured)', async () => {
    const saved = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'test-key';
    try {
      await agentCommand
        .parseAsync(['node', 'realm', '--workflow', 'nope/none.yaml', '--strict-base-url'])
        .catch(() => {});
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--strict-base-url has no effect without --base-url'),
      );
    } finally {
      if (saved === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = saved;
    }
  });

  it('dead-config 2: --strict-base-url joins the --provider-module cannot-combine ERROR', async () => {
    await agentCommand
      .parseAsync([
        'node',
        'realm',
        '--workflow',
        'some/path',
        '--provider-module',
        './p.js',
        '--strict-base-url',
      ])
      .catch(() => {});
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('--provider-module cannot be combined'),
    );
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

describe('manifest-secret redaction threading (fix holder)', () => {
  afterEach(() => setAdditionalRedactionValues([]));

  class EchoingProvider extends LlmProvider {
    async callStep(): Promise<Record<string, unknown>> {
      // Simulates the provider-loop serialization site: a tool result echoing a
      // manifest-bound secret is serialized through serializeToolResult and the
      // serialized form lands in the step output persisted to evidence.
      return { summary: serializeToolResult('upstream said: manifest-bound-secret-abc123') };
    }
  }

  it('runAgent threads deps.redactionValues into the redaction pass BEFORE the provider runs', async () => {
    const deps = makeDeps({
      provider: new EchoingProvider(),
      redactionValues: Object.freeze(['manifest-bound-secret-abc123']),
    });
    const result = await runAgent(deps, { definition: agentOnlyWorkflow, params: {} });
    expect(result).toBe('completed');
    const runs = await deps.store.list();
    const evidence = runs[0]!.evidence.find((e) => e.step_id === 'summarize')!;
    const persisted = JSON.stringify(evidence.output_summary);
    expect(persisted).toContain('[REDACTED]');
    expect(persisted).not.toContain('manifest-bound-secret-abc123');
  });
});

// =================================================================================================
// issue #465 — the extensions sentence at `realm agent`
// =================================================================================================

describe('agentCommand — `Error loading extensions:` (issue #465)', () => {
  // A THROWING exit spy, unlike the guards describe's no-op — deliberately. Under a no-op exit the
  // new catch COMPLETES, `loaded` stays undefined, the very next statement throws `TypeError:
  // Cannot read properties of undefined (reading 'notifiers')` into the outer #425 catch, which
  // prints `Error: Cannot read properties…` — and this cell's negative conjunct would red on a mock
  // artifact, not on production behavior. With the throw, the outer catch re-renders the sentinel
  // as `Error: process.exit` instead — expected, and harmless to both conjuncts.
  let home: string;
  let originalHome: string | undefined;
  let savedKey: string | undefined;

  beforeEach(() => {
    // Scratch $HOME for the store handles the action constructs before loading (the #285 idiom).
    home = mkdtempSync(join(tmpdir(), 'realm-agent-ext-home-'));
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    // The provider-key guard runs BEFORE the workflow is loaded (the #425 cells' precondition);
    // a fake key reaches the load without the provider exploding.
    savedKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'test-key';
    vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    if (savedKey === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = savedKey;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('C6 a module that cannot be resolved reports `Error loading extensions:`, not a bare `Error:`', async () => {
    // Red-first on main: the ⚠ ignored line (agent's warnings already print — the core's lenient
    // load) then `Error: Cannot resolve extension module …` — the outer #425 catch's bare prefix.
    // run, validate, register and watch all say which stage failed; agent now does too. (test,
    // respond and drain still print the bare form — issue #466, not this PR.)
    const proj = mkdtempSync(join(tmpdir(), 'realm-agent-ext-'));
    const wfDir = join(proj, 'workflows', 'wf');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    const file = join(wfDir, 'workflow.yaml');
    writeFileSync(
      file,
      `id: agent-ext
name: Agent Ext
version: 1
extensions: ../../dist/does-not-exist.js
steps:
  a:
    description: a
    execution: agent
`,
      'utf8',
    );

    await expect(agentCommand.parseAsync(['node', 'realm', '--workflow', file])).rejects.toThrow(
      'process.exit',
    );

    expect(process.exit).toHaveBeenCalledWith(1);
    const errored = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n');
    expect(errored).toMatch(
      /^Error loading extensions: Cannot resolve extension module '\.\.\/\.\.\/dist\/does-not-exist\.js' of workflow 'agent-ext'/m,
    );
    expect(errored).not.toMatch(/^Error: Cannot/m);
    rmSync(proj, { recursive: true, force: true });
  });
});
