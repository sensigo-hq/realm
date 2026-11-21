// retries-drive-g2ib.test.ts — gap 2, unit (i-b): `retry` on an agent step under `realm agent`, at
// the drive: what the run's record keeps (the settle evidence, the drive-failure entry), the check
// before a re-send, a tool the model already called, provider modules, and inspect's lines. Realm's
// real Anthropic provider and SDK drive each step over a scripted `fetch`; fake keys only.
//
// Every cell carries (a) the break that turns it red and (b) what it prints.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  abandonRun,
  createDefaultRegistry,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent, type AgentDeps } from './run-agent.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import {
  LlmProvider,
  ToolCapableLlmProvider,
  type CallStepWithMetaResult,
  type ProviderCapabilities,
} from './providers/llm-provider.js';
import type { LlmClock } from './providers/agent-utils.js';
import type { McpClient, McpTool, StepWithToolsResult } from './mcp/mcp-extensions.js';
import { inspectRun } from '../commands/inspect.js';

type Wire = (init: RequestInit | undefined) => Response | Promise<Response>;
let script: Wire[] = [];
let bodies: Array<Record<string, unknown>> = [];
/** Run before each wire try's answer, with the try's number (from 1). */
let onWire: ((n: number) => Promise<void>) | undefined;
let lines: string[] = [];

beforeEach(() => {
  script = [];
  bodies = [];
  onWire = undefined;
  lines = [];
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-fake-g2ib-drive-0000');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      await onWire?.(bodies.length);
      const next = script.shift();
      if (next === undefined) throw new Error('the test scripted no further answer');
      return next(init);
    }),
  );
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const keep = (...a: unknown[]) => lines.push(a.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const JSONH = { 'content-type': 'application/json' };
const reply =
  (content: unknown[], stop = 'end_turn'): Wire =>
  () =>
    new Response(
      JSON.stringify({
        id: 'msg_fake_g2ib_drive',
        type: 'message',
        role: 'assistant',
        model: 'claude-test-1',
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: JSONH },
    );
const answer = (): Wire => reply([{ type: 'text', text: '{"answer":"ok"}' }]);
const fail =
  (status: number, type = 'api_error', message = 'overloaded (fake)'): Wire =>
  () =>
    new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
      status,
      headers: JSONH,
    });

const workflow = (id: string, step: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      s: { description: 'Answer with JSON.', execution: 'agent', ...step },
    },
    ...extra,
  }) as unknown as WorkflowDefinition;
const FAST = { max_attempts: 2, backoff: 'fixed', base_delay_ms: 1 };

let toolRuns = 0;
const mcpClient: McpClient = {
  async connect() {},
  async getTools(_serverId: string, allowList: string[]): Promise<McpTool[]> {
    return allowList.map((name) => ({
      name,
      description: 'Look a thing up',
      inputSchema: { type: 'object' },
    }));
  },
  async call() {
    toolRuns += 1;
    return { result: 'a fake tool result' };
  },
  async disconnect() {},
};
const TOOLS_EXTRA = {
  mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-srv'] }],
};

async function drive(
  def: WorkflowDefinition,
  provider: LlmProvider,
  extra: Partial<AgentDeps> & { store?: InMemoryStore } = {},
): Promise<{ result: unknown; run: RunRecord; store: InMemoryStore }> {
  const store = extra.store ?? new InMemoryStore({ leases: createLeaseDouble() });
  const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  runIdOf = record.id;
  storeOf = store;
  const result = await runAgent(
    {
      store,
      workflowStore: { register: async () => {}, get: async () => def, list: async () => [def] },
      provider,
      registry: createDefaultRegistry(),
      mcpClientFactory: () => mcpClient,
      ...extra,
    } as unknown as AgentDeps,
    { existingRunId: record.id, definition: def, params: {} },
  ).catch((err: unknown) => err);
  return { result, run: (await store.get(record.id)).record, store };
}
let runIdOf = '';
let storeOf: InMemoryStore | undefined;
const lastFailure = (run: RunRecord) =>
  run.drive_failures?.entries[run.drive_failures.entries.length - 1];
const workflowStoreOf = (def: WorkflowDefinition) =>
  ({ get: async () => def, register: async () => {}, list: async () => [def] }) as never;

describe('gap 2, unit (i-b) — check 2 at the drive, and Words 8: a step that succeeds after a failed try', () => {
  it('the settle evidence keeps the one failed try, and inspect lists it as Failed tries', async () => {
    const def = workflow('g2ib-settle', { retry: FAST });
    script = [fail(503), answer()];
    const { run, store } = await drive(def, new AnthropicProvider('claude-test-1'));
    const entry = run.evidence.find((e) => e.step_id === 's');
    const shown = await inspectRun(run.id, store, workflowStoreOf(def));
    // (a) red when the settle's StepMeta leaves the tries out, or inspect prints no line;
    //     (b) prints the entry's tries, the failures and inspect's line.
    expect({
      phase: run.run_phase,
      tries: entry?.model_attempts,
      failures: run.drive_failures?.entries.length ?? 0,
      line: shown.split('\n').filter((l) => l.includes('Failed tries:')),
    }).toEqual({
      phase: 'completed',
      tries: [
        {
          request: 0,
          kind: 'transient',
          error_class: 'api_status',
          status: 503,
          wait_ms: 1,
          retry_after_ms: null,
        },
      ],
      failures: 0,
      line: ['     Failed tries: 1 (transient 503)'],
    });
  });

  it('a step without retry writes no model_attempts, after the same 503 the client retried', async () => {
    const def = workflow('g2ib-none', {});
    script = [fail(503), answer()];
    const { run } = await drive(def, new AnthropicProvider('claude-test-1'));
    // (a) red when a step without retry records tries; (b) prints the entry's keys.
    expect({
      phase: run.run_phase,
      wire: bodies.length,
      keys: Object.keys(run.evidence.find((e) => e.step_id === 's') ?? {}),
    }).toEqual({
      phase: 'completed',
      wire: 2,
      keys: expect.not.arrayContaining(['model_attempts']),
    });
  }, 10_000);
});

describe('gap 2, unit (i-b) — check 9 at the drive: every try fails', () => {
  it('the drive stops, the run stays open, the drive-failure entry keeps 2 closed tries, and nothing was written between the tries', async () => {
    const def = workflow('g2ib-all-fail', { retry: FAST });
    script = [fail(503), fail(503)];
    const versions: number[] = [];
    onWire = async () => {
      versions.push((await storeOf!.get(runIdOf)).record.version);
    };
    const { run, store } = await drive(def, new AnthropicProvider('claude-test-1'));
    const entry = lastFailure(run);
    const shown = await inspectRun(run.id, store, workflowStoreOf(def));
    // (a) red when a try writes to the run (the version moves between the tries), or the entry
    //     leaves the tries out; (b) prints the versions, the entry's tries and inspect's lines.
    expect({
      wire: bodies.length,
      sameVersion: new Set(versions).size,
      open: run.terminal_state,
      tries: entry?.model_attempts,
      attemptsSdk: entry?.attempts_sdk,
      line: shown.split('\n').filter((l) => l.includes('Failed tries:') || l.includes('(attempt')),
    }).toEqual({
      wire: 2,
      sameVersion: 1,
      open: false,
      tries: [
        {
          request: 0,
          kind: 'transient',
          error_class: 'api_status',
          status: 503,
          wait_ms: 1,
          retry_after_ms: null,
        },
        {
          request: 0,
          kind: 'transient',
          error_class: 'api_status',
          status: 503,
          wait_ms: null,
          retry_after_ms: null,
          exhausted_by: 'attempts',
        },
      ],
      attemptsSdk: 1,
      line: [
        // The recorded ceiling is the request's derived cap: 2 × 600 s + the 1 ms wait + 60 s.
        // The step declares no llm_timeout_seconds and the drive no --llm-timeout, so the cap's
        // per-attempt term is the 600 s default (red when the cap loses it: 60001ms).
        expect.stringMatching(/\(status 503\) \(ceiling 1260001ms\) \(attempt 2\)$/),
        '    Failed tries: 2 (transient 503, transient 503)',
      ],
    });
  });
});

describe('gap 2, unit (i-b) — check 6: before a re-send, the drive is asked', () => {
  const WAIT = { max_attempts: 2, backoff: 'fixed', base_delay_ms: 200 };

  it('another drive took the step back during the wait: nothing is re-sent', async () => {
    const def = workflow('g2ib-reclaimed', { retry: WAIT });
    script = [fail(503), answer()];
    onWire = async (n) => {
      if (n !== 1) return;
      // The claim now names another drive's lease, as after a take-back by another program.
      const { record } = await storeOf!.get(runIdOf);
      const claim = record.claims?.['s'];
      await storeOf!.update({
        ...record,
        claims: { ...record.claims, s: { ...claim!, lease: { id: 'another-drive-lease' } } },
      } as RunRecord);
    };
    await drive(def, new AnthropicProvider('claude-test-1'));
    // (a) red when the check is removed (the request is sent again); (b) prints the wire count.
    expect(bodies.length).toBe(1);
  });

  it('the run ended during the wait, on a store without leases: nothing is re-sent', async () => {
    const def = workflow('g2ib-ended', { retry: WAIT });
    script = [fail(503), answer()];
    onWire = async (n) => {
      if (n === 1) await abandonRun(storeOf!, runIdOf, 'ended by the test');
    };
    await drive(def, new AnthropicProvider('claude-test-1'), { store: new InMemoryStore() });
    // (a) red when the check is removed; (b) prints the wire count.
    expect(bodies.length).toBe(1);
  });

  it('a stop signal during the wait: nothing is re-sent', async () => {
    const def = workflow('g2ib-signal', { retry: WAIT });
    script = [fail(503), answer()];
    const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const others = SIGNALS.map((s) => [s, process.listeners(s)] as const);
    for (const s of SIGNALS) process.removeAllListeners(s);
    const exits: unknown[] = [];
    // The drive's re-raise and its exit fallback are recorded, never carried out.
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code);
      return undefined as never;
    }) as typeof process.exit);
    onWire = async (n) => {
      if (n === 1) setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 20);
    };
    try {
      void drive(def, new AnthropicProvider('claude-test-1'));
      const until = Date.now() + 5000;
      while (exits.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 400));
      // (a) red when the check is removed (the request is sent again after the signal);
      //     (b) prints the wire count and the exits.
      expect({ wire: bodies.length, exited: exits.length > 0 }).toEqual({ wire: 1, exited: true });
    } finally {
      vi.restoreAllMocks();
      for (const [s, listeners] of others) for (const l of listeners) process.on(s, l);
    }
  });
});

describe('gap 2, unit (i-b) — check 7: a tool the model already called never runs again', () => {
  it('request 2 fails, then succeeds: the tool called before it ran once', async () => {
    toolRuns = 0;
    const def = workflow('g2ib-tools', { retry: FAST, tools: ['srv:lookup'] }, TOOLS_EXTRA);
    script = [
      reply([{ type: 'tool_use', id: 'toolu_fake_1', name: 'lookup', input: {} }], 'tool_use'),
      fail(503),
      answer(),
    ];
    const { run } = await drive(def, new AnthropicProvider('claude-test-1'));
    // (a) red when the try is made around the provider's whole call (the tool then runs twice);
    //     (b) prints the tool runs, the wire count and the tries.
    expect({
      phase: run.run_phase,
      toolRuns,
      wire: bodies.length,
      tries: run.evidence.find((e) => e.step_id === 's')?.model_attempts?.map((t) => t.request),
    }).toEqual({ phase: 'completed', toolRuns: 1, wire: 3, tries: [1] });
  });
});

/** A 503 the way an SDK error carries it. */
const status503 = () => Object.assign(new Error('overloaded (fake module)'), { status: 503 });

class Module extends LlmProvider {
  calls = 0;
  clocks: Array<LlmClock | undefined> = [];
  constructor(
    private readonly script: Array<'fail' | 'ok'>,
    private readonly caps: Partial<ProviderCapabilities> = {},
  ) {
    super();
  }
  override capabilities(): ProviderCapabilities {
    return { jsonMode: false, ...this.caps };
  }
  async callStep(): Promise<Record<string, unknown>> {
    throw new Error('not used');
  }
  override async callStepWithMeta(
    _p: string,
    _s?: Record<string, unknown>,
    _i?: string,
    opts?: { llmClock?: LlmClock },
  ): Promise<CallStepWithMetaResult> {
    this.calls += 1;
    this.clocks.push(opts?.llmClock);
    if (this.script.shift() === 'fail') throw status503();
    return { output: { answer: 'ok' }, usage: [] };
  }
}
class ToolsModule extends ToolCapableLlmProvider {
  calls = 0;
  override capabilities(): ProviderCapabilities {
    return { jsonMode: false };
  }
  async callStep(): Promise<Record<string, unknown>> {
    throw new Error('not used');
  }
  async callStepWithTools(): Promise<StepWithToolsResult> {
    this.calls += 1;
    throw status503();
  }
}
const MODULE = { providerId: 'module:my-provider.mjs' as const };

describe('gap 2, unit (i-b) — check 11: provider modules', () => {
  it('(a) a module that says it handles retries gets the policy, the cap and the check, and Realm does not loop', async () => {
    const mod = new Module(['fail', 'ok'], { handlesRetries: true });
    const { run } = await drive(workflow('g2ib-module-a', { retry: FAST }), mod, MODULE);
    const policy = mod.clocks[0]?.retry;
    // (a) red when Realm loops for such a module, or passes no policy; (b) prints the calls and
    //     what the clock carried.
    expect({
      calls: mod.calls,
      open: !run.terminal_state,
      retry: policy?.retry,
      capSource: policy?.capSource,
      check: typeof policy?.mayResend,
    }).toEqual({ calls: 1, open: true, retry: FAST, capSource: 'derived', check: 'function' });
  });

  it('(b) a step without tools, the module silent: Realm tries its whole call again', async () => {
    const mod = new Module(['fail', 'ok']);
    const { run } = await drive(workflow('g2ib-module-b', { retry: FAST }), mod, MODULE);
    // (a) red when Realm does not try the module's call again; (b) prints the calls and the tries.
    expect({
      calls: mod.calls,
      phase: run.run_phase,
      retryOnClock: mod.clocks[0]?.retry !== undefined,
      tries: run.evidence.find((e) => e.step_id === 's')?.model_attempts?.map((t) => t.status),
    }).toEqual({ calls: 2, phase: 'completed', retryOnClock: false, tries: [503] });
  });

  it("(c) a step with tools, the module silent: no tries, and Words 2's line once", async () => {
    const mod = new ToolsModule();
    await drive(
      workflow('g2ib-module-c', { retry: FAST, tools: ['srv:lookup'] }, TOOLS_EXTRA),
      mod,
      MODULE,
    );
    // (a) red when the line is missing or printed twice, or the call is tried again; (b) prints
    //     the calls and the lines.
    expect({
      calls: mod.calls,
      line: lines.filter((l) => l.includes("'retry' is not applied")),
    }).toEqual({
      calls: 1,
      line: [
        "• Step 's': 'retry' is not applied: provider module 'my-provider.mjs' does not say it handles retries, and a step with tools is never sent again whole.",
      ],
    });
  });
});
