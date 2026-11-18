// ending-a1b2-agent.test.ts — issue #625 PR-2b (A1b-2), check 3 on `realm agent`: the drive says how
// the run ended exactly once — the owner's one-note rule. Its stop's `Ended:` line says the ending
// only when no line it printed already said it: the ⏰ line of the timer whose write ended the run,
// the ⚠ line of an `on_expiry: abort` the drive's own call carried out (verify-first's added setter,
// P2B-A1B2-MA2-07), the Slack notifier's lines for its own answer. A guard the engine's work settled
// prints only `✓ → aborted`, so there `Ended:` says it. The `realm workflow run` cells are in
// `../commands/ending-a1b2.test.ts`.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  submitHumanResponse,
  type ExtensionRegistry,
  type PendingGate,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { handleBidirectionalGate } from './gate/slack-gate-notifier.js';
import { startSlackGateServer } from './gate/slack-gate-server.js';
import type { SlackGateEvent } from './gate/slack-gate-server.js';
import { slackResponse } from './test-support/slack-response.js';
import { writerTestSeams } from '../output/writer.js';

vi.mock('./gate/slack-gate-server.js', () => ({
  startSlackGateServer: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./gate/slack-socket-client.js', () => ({
  connectSocketMode: vi.fn().mockReturnValue({ close: vi.fn() }),
}));

const shown = (a: unknown): string => writerTestSeams.visible(String(a));
const workflowStore = (def: WorkflowDefinition) => ({
  async register() {},
  async get() {
    return def;
  },
  async list() {
    return [def];
  },
});
const provider = () =>
  new (class extends LlmProvider {
    callStep = vi.fn(async () => ({}));
  })();

/** Every console line, in order. */
let out: string[];
beforeEach(() => {
  out = [];
  for (const m of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      out.push(...a.map(shown).join(' ').split('\n'));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const endedLines = (): string[] => out.filter((l) => l.startsWith('  Ended:'));

/** gate `approve` [→ guard `check`, aborting unless approved] → agent step `fin`. */
function gated(guard: boolean, gate: Record<string, unknown> = {}): WorkflowDefinition {
  return {
    id: guard ? 'a1b2-agent-guard' : 'a1b2-agent-gate',
    name: 'a1b2 agent',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      approve: {
        description: 'Approve.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'], ...gate },
      },
      ...(guard
        ? {
            check: {
              description: 'Check.',
              execution: 'guard' as const,
              depends_on: ['approve'],
              abort_unless: ["approve.choice == 'approve'"],
              abort_message: 'Not approved.',
            },
          }
        : {}),
      fin: { description: 'Fin.', execution: 'agent', depends_on: [guard ? 'check' : 'approve'] },
    },
  } as WorkflowDefinition;
}

const T = Date.parse('2030-01-01T00:00:00.000Z');
/** A run of `def` at its question, opened at T with a 1 s time limit whose expiry aborts (or as given). */
async function atExpiringQuestion(
  store: RunStore,
  def: WorkflowDefinition,
  expiry: Record<string, unknown> = { on_expiry: 'abort' },
): Promise<string> {
  const { record: run } = await store.create({
    workflowId: def.id,
    workflowVersion: 1,
    params: {},
  });
  const gate: PendingGate = {
    gate_id: 'g1',
    step_name: 'approve',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: new Date(T).toISOString(),
    expires_at: new Date(T + 1000).toISOString(),
    ...expiry,
  } as PendingGate;
  await store.update({
    ...run,
    in_progress_steps: ['approve'],
    claims: { approve: { deadline: null } },
    pending_gate: gate,
  } as never);
  return run.id;
}

describe('#625 A1b-2 — check 3: realm agent says how the run ended exactly once (the one-note rule)', () => {
  it("check 3 — the engine's work: a guard after an `auto` step aborts (today only `✓ → aborted`): Ended: with the guard's sentence", async () => {
    const def: WorkflowDefinition = {
      id: 'a1b2-agent-chain',
      name: 'chain',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        x: { description: 'X.', execution: 'auto', depends_on: [], handler: 'x' },
        g: {
          description: 'G.',
          execution: 'guard',
          depends_on: ['x'],
          abort_unless: ['x.go == true'],
          abort_message: 'no go',
        },
        b: { description: 'B.', execution: 'agent', depends_on: ['g'] },
      },
    };
    const registry: ExtensionRegistry = createDefaultRegistry();
    registry.register('handler', 'x', {
      id: 'x',
      execute: async () => ({ data: { go: false } }),
    } as never);
    const store = new InMemoryStore();
    await runAgent(
      { store, workflowStore: workflowStore(def), provider: provider(), registry },
      { definition: def, params: {}, pollIntervalMs: 20 },
    );
    // (a) red when the stop says only the phase (the ending said nowhere), or says it twice;
    //     (b) prints every line. The phase line stays, right above it.
    expect(out.slice(-2), out.join('\n')).toEqual([
      'Run ended in phase: aborted',
      `  Ended:     Guard step 'g' aborted the run: "no go".`,
    ]);
    expect(endedLines()).toHaveLength(1);
  });

  it('check 3 — a step the chain runs after this drive’s step fails and ends the run: its ✗ line, then Resume: only', async () => {
    const def: WorkflowDefinition = {
      id: 'a1b2-agent-fail',
      name: 'fail',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        a: { description: 'A.', execution: 'agent', depends_on: [] },
        b: { description: 'B.', execution: 'auto', depends_on: ['a'], handler: 'boom' },
      },
    };
    const registry: ExtensionRegistry = createDefaultRegistry();
    registry.register('handler', 'boom', {
      id: 'boom',
      execute: async () => {
        throw new Error('kaboom');
      },
    } as never);
    const store = new InMemoryStore();
    const { record: run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    await runAgent(
      { store, workflowStore: workflowStore(def), provider: provider(), registry },
      { definition: def, existingRunId: run.id, params: {}, pollIntervalMs: 20 },
    );
    // (a) red when the step's `✗` line does not set the note (the failure said twice); (b) prints
    //     every line.
    expect(
      out.filter((l) => l.startsWith('  Ended:') || l.startsWith('  Resume:')),
      out.join('\n'),
    ).toEqual([`  Resume:    realm run resume ${run.id} --from b`]);
  });

  it('check 3 (A6) — the ⚠ line of an on_expiry abort this drive’s call carried out, then no Ended:', async () => {
    const def = gated(false);
    const store = new InMemoryStore({ clock: settableClock(new Date(T + 5000)) });
    const runId = await atExpiringQuestion(store, def);
    await runAgent(
      {
        store,
        workflowStore: workflowStore(def),
        provider: provider(),
        registry: createDefaultRegistry(),
      },
      { definition: def, existingRunId: runId, params: {}, pollIntervalMs: 20 },
    );
    // (a) red when the ⚠ line does not set the note (the expiry's ending said twice); (b) prints
    //     every line.
    expect(
      {
        warned: out.filter((l) => l.startsWith('⚠') && l.includes('declared abort: the run ended'))
          .length,
        ended: endedLines(),
      },
      out.join('\n'),
    ).toEqual({ warned: 1, ended: [] });
  });

  it('correction 1, check 2 — realm agent --run-id: the ⚠ line of an expired default whose guard then aborts says the ending, then no Ended:', async () => {
    const expiry = { on_expiry: 'settle_default', default_choice: 'reject' };
    const def = gated(true, { timeout_seconds: 1, ...expiry });
    const store = new InMemoryStore({ clock: settableClock(new Date(T + 5000)) });
    const runId = await atExpiringQuestion(store, def, expiry);
    await runAgent(
      {
        store,
        workflowStore: workflowStore(def),
        provider: provider(),
        registry: createDefaultRegistry(),
      },
      { definition: def, existingRunId: runId, params: {}, pollIntervalMs: 20 },
    );
    // (a) red when the ⚠ setter counts an `on_expiry: abort` only (the guard's ending said twice);
    //     (b) prints every line.
    expect(
      {
        warned: out.filter(
          (l) =>
            l.startsWith('⚠') &&
            l.includes("the default choice 'reject' was recorded") &&
            l.includes("Guard step 'check' aborted the run"),
        ).length,
        ended: endedLines(),
      },
      out.join('\n'),
    ).toEqual({ warned: 1, ended: [] });
  });

  it("check 3 — the terminal fallback's ⏰ line ends the run: no Ended:", async () => {
    const def = gated(false);
    const clock = settableClock(new Date(T));
    const store = new InMemoryStore({ clock });
    const runId = await atExpiringQuestion(store, def);
    const drive = runAgent(
      {
        store,
        workflowStore: workflowStore(def),
        provider: provider(),
        registry: createDefaultRegistry(),
      },
      { definition: def, existingRunId: runId, params: {}, pollIntervalMs: 20 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await clock.advance(1500);
    await drive;
    // (a) red when the timer's line does not set the note (the expiry said twice); (b) prints every
    //     line.
    expect(
      {
        timer: out.filter((l) => l.startsWith('⏰') && l.includes('the run ended')).length,
        ended: endedLines(),
      },
      out.join('\n'),
    ).toEqual({ timer: 1, ended: [] });
  });

  describe('the Slack notifier', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      fetchSpy = vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } }));
      vi.stubGlobal('fetch', fetchSpy);
    });

    /** The drive with the Slack notifier as its gate handler; `before` runs once the post is up. */
    async function driveWithSlack(
      def: WorkflowDefinition,
      text: string,
      before?: (store: RunStore, runId: string, gate: PendingGate) => Promise<void>,
      registry: ExtensionRegistry = createDefaultRegistry(),
    ): Promise<boolean | undefined> {
      const store = new InMemoryStore();
      let resolved: boolean | undefined;
      await runAgent(
        {
          store,
          workflowStore: workflowStore(def),
          provider: provider(),
          registry,
          gateHandler: async (runId: string, gate: PendingGate) => {
            let onEvent: ((event: SlackGateEvent) => void) | undefined;
            vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
              onEvent = opts.onEvent;
              return { close: vi.fn() };
            });
            const waiting = handleBidirectionalGate({
              gate,
              runId,
              definition: def,
              store,
              registry,
              provider: provider(),
              slackBotToken: 'xoxb-test',
              slackChannelId: 'C123',
              gateThreadTs: '1234567890.000',
              slackSigningSecret: 'secret',
              slackEventsPort: 3100,
              gateReminderIntervalMs: 999_999,
              gateEscalationThresholdMs: 999_999,
              pollIntervalMs: 50,
            });
            if (before !== undefined) await before(store, runId, gate);
            onEvent?.({
              event_id: 'E1',
              thread_ts: '1234567890.000',
              user: 'U1',
              text,
              ts: '1234567890.001',
            });
            resolved = await waiting;
            return resolved;
          },
        },
        { definition: def, params: {}, pollIntervalMs: 20 },
      );
      return resolved;
    }

    it('check 3 — a Slack answer of its own that ended the run: its lines once, no Ended:', async () => {
      const resolved = await driveWithSlack(gated(true), 'reject');
      // (a) red when the notifier does not resolve `true` after printing the ending, or the drive
      //     ignores it (the guard's sentence said twice); (b) prints every line.
      expect(
        {
          resolved,
          guard: out.filter((l) => l.includes("Guard step 'check' aborted the run")).length,
          ended: endedLines(),
        },
        out.join('\n'),
      ).toEqual({ resolved: true, guard: 1, ended: [] });
    });

    it('correction 1, check 4 — a Slack answer of its own ends the run and its cleanup step runs past the 2 s bound: its lines first, no Ended:', async () => {
      const registry = createDefaultRegistry();
      registry.register('handler', 'release_slow', {
        id: 'release_slow',
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          return { data: {} };
        },
      } as never);
      const def = gated(true);
      def.steps['release'] = {
        description: 'Release.',
        execution: 'finalizer',
        handler: 'release_slow',
        on_outcome: 'always',
      } as never;
      const resolved = await driveWithSlack(def, 'reject', undefined, registry);
      const at = (text: string): number => out.findIndex((l) => l.includes(text));
      // (a) red when the handler returns at the 2 s bound, before its answer's lines (the drive then
      //     says the ending first, and the answer's lines come after its next line); (b) prints every
      //     line.
      expect(
        {
          resolved,
          ended: endedLines(),
          guardBeforeDrive: at("Guard step 'check' aborted the run") < at('Run ended in phase:'),
          cleanupBeforeDrive: at("finalizer 'release': completed") < at('Run ended in phase:'),
        },
        out.join('\n'),
      ).toEqual({ resolved: true, ended: [], guardBeforeDrive: true, cleanupBeforeDrive: true });
    }, 20_000);

    it("correction 1, check 3 — a Slack answer carries out an expired default, and the guard then aborts: the guard's lines once, no Ended:", async () => {
      const def = gated(true, {
        timeout_seconds: 3600,
        on_expiry: 'settle_default',
        default_choice: 'reject',
      });
      // The stored question's time is moved into the past once the post is up; the handler's timer
      // keeps the gate's own deadline (an hour off), so the answer's own call carries the expiry out.
      const resolved = await driveWithSlack(def, 'approve', async (store, runId) => {
        const { record } = await store.get(runId);
        await store.update({
          ...record,
          pending_gate: {
            ...record.pending_gate!,
            opened_at: '2020-01-01T00:00:00.000Z',
            expires_at: '2020-01-01T01:00:00.000Z',
          },
        });
      });
      // (a) red when the answer's lines do not set the note (the guard's ending said twice); (b)
      //     prints every line.
      expect(
        {
          resolved,
          carried: out.filter((l) => l.includes('this agent call first carried out')).length,
          guard: out.filter((l) => l.includes("Guard step 'check' aborted the run")).length,
          ended: endedLines(),
        },
        out.join('\n'),
      ).toEqual({ resolved: true, carried: 1, guard: 1, ended: [] });
    });

    it('check 3 — a Slack answer refused because another answer settled the question and ended the run: Ended: says the ending once', async () => {
      const resolved = await driveWithSlack(gated(true), 'approve', async (store, runId, gate) => {
        await submitHumanResponse(store, gated(true), {
          runId,
          gateId: gate.gate_id,
          choice: 'reject',
        });
      });
      // (a) red when the notifier resolves `true` for a line that does not say the ending (the
      //     ending said nowhere), or the drive's line says it twice; (b) prints every line.
      expect(
        {
          resolved,
          ended: endedLines(),
          sentences: out.filter((l) => l.includes("Guard step 'check' aborted the run")).length,
        },
        out.join('\n'),
      ).toEqual({
        resolved: false,
        ended: [`  Ended:     Guard step 'check' aborted the run: "Not approved.".`],
        sentences: 1,
      });
    });
  });
});
