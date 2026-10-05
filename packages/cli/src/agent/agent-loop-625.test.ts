// agent-loop-625.test.ts — issue #625 PR-2a, the `realm agent` loop: D6.1 (a lost claim is said as a
// past-tense fact, never `✓ → running`), D6.2 (nothing eligible with a step in flight: watch, then
// name reclaim — "its runner likely died" only past a deadline), and D4.2/L7 (the engine's work runs
// at the loop top through advanceRun; an engine step that fails is named and no model call follows).
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  submitHumanResponse,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
  type RunStore,
  type PendingGate,
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
    expect(out).toContain(
      ', taken by other@host (from the OS user, via agent); the record has not changed',
    );
    expect(out).toContain(
      `If the program that took it is gone: realm run reclaim ${run.id} --step review --force`,
    );
    expect(out).not.toContain('likely died');
    // Never a bare "Run ended in phase: running" with nothing named before it.
    expect(err).toContain('Run ended in phase: running');
    expect(provider.callStep).not.toHaveBeenCalled();
  });

  it('the screen keeps `✓ → <phase>` under each auto step the loop top ran, as realm-agent.md documents', async () => {
    const def: WorkflowDefinition = {
      id: 'loop-check-wf',
      name: 'loop check',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        a: { description: 'A.', execution: 'auto', depends_on: [] },
        b: { description: 'B.', execution: 'auto', depends_on: ['a'] },
        review: { description: 'Review.', execution: 'agent', depends_on: ['b'] },
        c: { description: 'C.', execution: 'auto', depends_on: ['review'] },
      },
    };
    const store = new InMemoryStore();
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({});
    })();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runAgent(
      { store, workflowStore: workflowStore(def), provider, registry: createDefaultRegistry() },
      { definition: def, params: {} },
    );
    const out = logSpy.mock.calls.flat().filter((l) => typeof l === 'string' && /→/.test(l));
    vi.restoreAllMocks();
    expect(result).toBe('completed');
    expect(out).toEqual([
      '→ [auto] a',
      '  ✓ → running',
      '→ [auto] b',
      '  ✓ → running',
      '\n→ [agent] review',
      // `c` runs inside the agent step's own call (executeChain's loop), silently, as before #625.
      '  ✓ → completed',
    ]);
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

  it('L7 / D6.1: an ENGINE step another process took is said with the same line, and the loop goes on', async () => {
    const def: WorkflowDefinition = {
      id: 'engine-taken-wf',
      name: 'engine taken',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        x: { description: 'X', execution: 'auto', depends_on: [] },
        review: { description: 'Review.', execution: 'agent', depends_on: [] },
      },
    };
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const realClaim = store.claimStep.bind(store);
    let first = true;
    (store as unknown as RunStore).claimStep = async (
      ...args: Parameters<RunStore['claimStep']>
    ) => {
      if (first && args[1] === 'x') {
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
      callStep = vi.fn().mockResolvedValue({});
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
        inFlightWatchMs: 30,
      },
    );
    const out = logSpy.mock.calls.flat().join('\n');
    vi.restoreAllMocks();
    const since = (await store.get(run.id)).claims?.['x']?.since;
    expect(out).toContain('→ [auto] x');
    expect(out).toContain(
      `• Step 'x' was taken by other@host (from the OS user, via agent) at ${since}; not run here.`,
    );
    // The loop went on to the ready agent step.
    expect(provider.callStep).toHaveBeenCalledTimes(1);
    expect((await store.get(run.id)).completed_steps).toEqual(['review']);
  });

  it('D6.1, the eligibility path: a step another process claimed before executeStep read the record gets the same line, never `✓ → running`', async () => {
    const def: WorkflowDefinition = {
      id: 'engine-taken-elig-wf',
      name: 'engine taken (eligibility)',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        x: { description: 'X', execution: 'auto', depends_on: [] },
        review: { description: 'Review.', execution: 'agent', depends_on: [] },
      },
    };
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    // The other process claims `x` between the loop's pick (`→ [auto] x` is printed) and
    // executeStep's own read of the record — so executeStep finds `x` not eligible, and never
    // reaches its claim.
    const realGet = store.get.bind(store);
    let armed = false;
    (store as unknown as RunStore).get = async (id: string) => {
      if (armed) {
        armed = false;
        await store.claimStep(id, 'x', def, {
          by: 'other@host',
          by_source: 'derived',
          channel: 'agent',
        });
      }
      return realGet(id);
    };
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({});
    })();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      const line = a.join(' ');
      if (line === '→ [auto] x') armed = true;
      lines.push(line);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runAgent(
      { store, workflowStore: workflowStore(def), provider, registry: createDefaultRegistry() },
      {
        definition: def,
        existingRunId: run.id,
        params: {},
        inFlightPollMs: 5,
        inFlightWatchMs: 30,
      },
    );
    vi.restoreAllMocks();
    const since = (await store.get(run.id)).claims?.['x']?.since;
    const at = lines.indexOf('→ [auto] x');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toBe(
      `• Step 'x' was taken by other@host (from the OS user, via agent) at ${since}; not run here.`,
    );
    // The step did not run here: its line is the taken line, and the one `✓ → running` printed is
    // the agent step's, after its own `→ [agent] review`.
    expect(lines.filter((l) => l === '  ✓ → running')).toHaveLength(1);
    expect(lines.indexOf('  ✓ → running')).toBeGreaterThan(lines.indexOf('→ [agent] review'));
    // The loop went on to the ready agent step.
    expect(provider.callStep).toHaveBeenCalledTimes(1);
    expect((await store.get(run.id)).completed_steps).toEqual(['review']);
  });

  it('L7: an engine step that is capability-blocked at the loop top is named; no model call follows', async () => {
    const def: WorkflowDefinition = {
      id: 'loop-cap-wf',
      name: 'loop cap',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        x: { description: 'X', execution: 'auto', depends_on: [], handler: 'missing_h' },
        review: { description: 'Review.', execution: 'agent', depends_on: ['x'] },
      },
    };
    const store = new InMemoryStore();
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({});
    })();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runAgent(
      { store, workflowStore: workflowStore(def), provider, registry: createDefaultRegistry() },
      { definition: def, params: {} },
    );
    const err = errorSpy.mock.calls.flat().join('\n');
    vi.restoreAllMocks();
    expect(result).toBe('failed');
    const runId = (await store.list())[0]!.id;
    expect(err).toContain(
      `⚠ Step 'x' is blocked: handler 'missing_h' is not registered in this runner. The run is NOT failed — add handler 'missing_h' and re-attach (\`realm agent --run-id ${runId}\`).`,
    );
    expect(provider.callStep).not.toHaveBeenCalled();
  });

  it('L7: an engine step whose settle write throws at the loop top is named; no model call follows', async () => {
    const def: WorkflowDefinition = {
      id: 'loop-throw-wf',
      name: 'loop throw',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        x: { description: 'X', execution: 'auto', depends_on: [] },
        review: { description: 'Review.', execution: 'agent', depends_on: ['x'] },
      },
    };
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    // The step's own settle write throws (not a WorkflowError): the throw leaves advanceRun.
    const realSettle = store.settleStep!.bind(store);
    (store as unknown as RunStore).settleStep = async (
      ...args: Parameters<NonNullable<RunStore['settleStep']>>
    ) => {
      if (args[1].kind === 'settle_step' && args[1].step === 'x') throw new Error('disk gone');
      return realSettle(...args);
    };
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({});
    })();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let outcome: string;
    try {
      outcome = await runAgent(
        { store, workflowStore: workflowStore(def), provider, registry: createDefaultRegistry() },
        { definition: def, existingRunId: run.id, params: {} },
      );
    } catch (err) {
      outcome = `threw: ${(err as Error).message}`;
    }
    const out = logSpy.mock.calls.flat().join('\n');
    const err = errorSpy.mock.calls.flat().join('\n');
    vi.restoreAllMocks();
    expect(out).toContain('→ [auto] x');
    // executeStep turns the throw into the step's error reply, which takes today's disposition.
    expect(outcome).toBe('failed');
    expect(err).toContain("✗ Step 'x' failed:");
    expect(provider.callStep).not.toHaveBeenCalled();
  });

  it("L7: an engine step that THROWS at the loop top (its snapshot write) is the drive failure's step; no model call follows", async () => {
    // A store that drops `workflow_context_snapshots` on write, so each step re-takes the snapshot,
    // and whose snapshot write throws: the one write the engine leaves unguarded, so the throw
    // leaves `advanceRun` and reaches the driver's last-resort catch (chokepoint 3).
    const def: WorkflowDefinition = {
      id: 'loop-snapshot-throw-wf',
      name: 'loop snapshot throw',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      workflow_context: { doc: { source: { path: '/nonexistent/realm-625-loop-top.md' } } },
      steps: {
        x: { description: 'X', execution: 'auto', depends_on: [] },
        review: { description: 'Review.', execution: 'agent', depends_on: ['x'] },
      },
    } as WorkflowDefinition;
    const inner = new InMemoryStore();
    const { run } = await inner.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          return async (record: Parameters<RunStore['update']>[0]) => {
            if (record.workflow_context_snapshots !== undefined) {
              throw new Error('snapshot write failed');
            }
            return target.update(record);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as unknown as RunStore;
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({});
    })();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      runAgent(
        { store, workflowStore: workflowStore(def), provider, registry: createDefaultRegistry() },
        { definition: def, existingRunId: run.id, params: {} },
      ),
    ).rejects.toThrow('snapshot write failed');
    const out = logSpy.mock.calls.flat().join('\n');
    vi.restoreAllMocks();
    expect(out).toContain('→ [auto] x');
    expect((await inner.get(run.id)).drive_failures?.entries.at(-1)?.step).toBe('x');
    expect(provider.callStep).not.toHaveBeenCalled();
  });

  const gated = (guard: boolean): WorkflowDefinition => ({
    id: guard ? 'attended-guard-wf' : 'attended-auto-wf',
    name: 'attended',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      confirm: {
        description: 'Confirm',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'] },
      },
      ...(guard
        ? {
            check: {
              description: 'Check',
              execution: 'guard' as const,
              depends_on: ['confirm'],
              abort_unless: ["confirm.choice == 'approve'"],
            },
            after: { description: 'After', execution: 'auto' as const, depends_on: ['check'] },
          }
        : { after: { description: 'After', execution: 'auto' as const, depends_on: ['confirm'] } }),
      finish: { description: 'Finish.', execution: 'agent', depends_on: ['after'] },
    },
  });

  for (const guard of [false, true]) {
    it(`L7 attended: gate→${guard ? 'guard→auto' : 'auto'} — the agent answers, advances and finishes`, async () => {
      const def = gated(guard);
      const store = new InMemoryStore();
      const provider = new (class extends LlmProvider {
        callStep = vi.fn().mockResolvedValue({ done: true });
      })();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await runAgent(
        {
          store,
          workflowStore: workflowStore(def),
          provider,
          registry: createDefaultRegistry(),
          gateHandler: async (runId: string, gate: PendingGate) => {
            await submitHumanResponse(store, def, {
              runId,
              gateId: gate.gate_id,
              choice: 'approve',
            });
          },
        },
        { definition: def, params: {} },
      );
      const out = logSpy.mock.calls.flat().join('\n');
      const err = errorSpy.mock.calls.flat().join('\n');
      vi.restoreAllMocks();
      expect(err).not.toContain('Run ended in phase: running');
      expect(result).toBe('completed');
      expect(out).toContain('→ [auto] after');
      const done = (await store.list())[0]!;
      expect(done.completed_steps).toEqual(
        guard ? ['confirm', 'check', 'after', 'finish'] : ['confirm', 'after', 'finish'],
      );
    });
  }

  it('L7 two processes attending one run: each step runs once, the run completes, neither exits silently', async () => {
    const def: WorkflowDefinition = {
      id: 'two-process-wf',
      name: 'two process',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        slow: { description: 'Slow', execution: 'auto', depends_on: [], handler: 'slow' },
        review: { description: 'Review.', execution: 'agent', depends_on: ['slow'] },
      },
    };
    const registry = createDefaultRegistry();
    registry.register('handler', 'slow', {
      id: 'slow',
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { data: { ok: true } };
      },
    });
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { reviewed: true };
      });
    })();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const drive = (name: string) =>
      runAgent(
        {
          store,
          workflowStore: workflowStore(def),
          provider,
          registry,
          driver: { by: name, by_source: 'stated', channel: 'agent' },
        },
        {
          definition: def,
          existingRunId: run.id,
          params: {},
          inFlightPollMs: 5,
          inFlightWatchMs: 2000,
        },
      );
    const results = await Promise.all([drive('one'), drive('two')]);
    const out = logSpy.mock.calls.flat().join('\n');
    const err = errorSpy.mock.calls.flat().join('\n');
    vi.restoreAllMocks();
    const done = await store.get(run.id);
    expect(done.terminal_state).toBe(true);
    expect(done.completed_steps).toEqual(['slow', 'review']);
    for (const step of ['slow', 'review']) {
      expect(
        done.evidence.filter((e) => e.step_id === step && e.status === 'success'),
      ).toHaveLength(1);
    }
    expect(results).toEqual(['completed', 'completed']);
    expect(err).not.toContain('Run ended in phase: running');
    // The loser of each race said who took the step.
    expect(out).toMatch(/• Step 'slow' was taken by (one|two) \(as stated, via agent\)/);
  });
});
