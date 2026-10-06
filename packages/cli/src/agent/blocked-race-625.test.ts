// blocked-race-625.test.ts — issue #625 PR-2a, fold round 13, decision C85: `realm agent`'s `blocked`
// arm, after its re-read of the record. A `blocked` reply that is not "taken" goes back to the loop
// top when the fresh record has an open gate or has ended: the loop top waits at the gate, or prints
// the run-ended line — as it did before C82 (5). Any other `blocked` reply still stops the drive
// (the "precondition fails on the engine's own read" cell in agent-refused-625.test.ts).
//
// The two moments, each reached by a hook that runs inside the model call (`during`):
// - a gate: another process answers a sibling agent step whose answer opens a gate, while this
//   drive's model answers `ask`. The engine then refuses `ask` (a waiting gate holds the run) with a
//   `blocked` "not eligible" reply.
// - the run's end: `executeChain` reads the record first and answers `ok` "already terminal" for a
//   run that ended before that read (decision C86's case, homed in PR-2b). A `blocked` reply on an
//   ended run comes only from an end between `executeChain`'s read and `executeStep`'s; the hook
//   arms a one-shot store read that ends the run right after `executeChain`'s read returns.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  abandonRun,
  createDefaultRegistry,
  executeStep,
  submitHumanResponse,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type PendingGate,
  type RunRecord,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';

const agent = (extra: Partial<StepDefinition> = {}, depends_on: string[] = []): StepDefinition =>
  ({ description: 'An agent step.', execution: 'agent', depends_on, ...extra }) as StepDefinition;

function wf(steps: Record<string, StepDefinition>): WorkflowDefinition {
  return {
    id: 'c85-wf',
    name: 'c85',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  };
}

/** An InMemoryStore whose next `get` can run one hook after it read the record (a one-shot window). */
class WindowStore extends InMemoryStore {
  private afterNextGet: ((runId: string) => Promise<void>) | undefined;
  armAfterNextGet(hook: (runId: string) => Promise<void>): void {
    this.afterNextGet = hook;
  }
  override async get(runId: string): Promise<RunRecord> {
    const record = await super.get(runId);
    const hook = this.afterNextGet;
    if (hook !== undefined) {
      this.afterNextGet = undefined;
      await hook(runId);
    }
    return record;
  }
}

interface Drive {
  result: string;
  lines: string[];
  calls: number;
  store: WindowStore;
  runId: string;
  gates: string[];
}

async function drive(
  def: WorkflowDefinition,
  during: (store: WindowStore, call: number) => Promise<void>,
  answerGate?: (store: WindowStore, runId: string, gate: PendingGate) => Promise<void>,
): Promise<Drive> {
  const store = new WindowStore();
  let calls = 0;
  const gates: string[] = [];
  const provider = new (class extends LlmProvider {
    async callStep(): Promise<Record<string, unknown>> {
      calls += 1;
      await during(store, calls);
      return {};
    }
  })();
  const lines: string[] = [];
  for (const kind of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
      lines.push(`${kind}: ${a.join(' ')}`);
    });
  }
  let result: string;
  try {
    result = await runAgent(
      {
        store,
        workflowStore: {
          async register() {},
          async get() {
            return def;
          },
          async list() {
            return [def];
          },
        },
        provider,
        registry: createDefaultRegistry(),
        ...(answerGate !== undefined
          ? {
              gateHandler: async (runId: string, gate: PendingGate) => {
                gates.push(gate.step_name);
                await answerGate(store, runId, gate);
              },
            }
          : {}),
      },
      { definition: def, params: {}, inFlightPollMs: 5, inFlightWatchMs: 20 },
    );
  } finally {
    vi.restoreAllMocks();
  }
  const runId = (await store.list())[0]!.id;
  return {
    result,
    lines: lines.map((l) => l.split(runId).join('<run>')),
    calls,
    store,
    runId,
    gates,
  };
}

describe('#625 PR-2a, C85 — a blocked reply on a run another process moved to a gate or ended goes back to the loop top', () => {
  it('a gate another process opened while the model answered: the drive reaches the gate, no ✗, not failed', async () => {
    // `review` (an agent step whose answer opens a gate) beside `ask`. The drive picks `ask`; while
    // its model answers, another process answers `review`, and the gate opens.
    const def = wf({
      ask: agent(),
      review: agent({ trust: 'human_confirmed' } as Partial<StepDefinition>),
    });
    const d = await drive(
      def,
      async (store, call) => {
        if (call !== 1) return;
        const runId = (await store.list())[0]!.id;
        const r = await executeStep(store, def, {
          runId,
          command: 'review',
          input: { verdict: 'fine' },
          dispatcher: async (_s, input) => ({ ...input }),
        });
        expect(r.status).toBe('confirm_required');
      },
      async (store, runId, gate) => {
        const r = await submitHumanResponse(store, def, {
          runId,
          gateId: gate.gate_id,
          choice: gate.choices[0]!,
        });
        expect(r.status).toBe('ok');
      },
    );
    // (a) the gate conjunct dropped → the blocked arm prints `✗ Step 'ask' is not eligible in the
    // current run state.` and the drive ends `failed`. (b) prints the result, the gates reached and
    // every ✗ line.
    expect({
      result: d.result,
      calls: d.calls,
      gates: d.gates,
      crosses: d.lines.filter((l) => l.includes('✗')),
    }).toEqual({ result: 'completed', calls: 2, gates: ['review'], crosses: [] });
    // the gate line the loop top prints, after the refused attempt and before `ask` is driven again
    const gateLine = d.lines.findIndex((l) => l.startsWith('log: \n⏸  Gate: review | ID: '));
    const firstAsk = d.lines.indexOf('log: \n→ [agent] ask');
    const secondAsk = d.lines.indexOf('log: \n→ [agent] ask', firstAsk + 1);
    expect(firstAsk >= 0 && gateLine > firstAsk && secondAsk > gateLine).toBe(true);
    const run = await d.store.get(d.runId);
    expect(run.completed_steps.slice().sort()).toEqual(['ask', 'review']);
  });

  it('a run another process ended between the engine’s two reads: the run-ended line, no ✗ <hint>', async () => {
    // `more` keeps the run live after `ask`. While the model answers `ask`, the hook arms the store:
    // the next read (executeChain's own) returns the live record, then the run is abandoned, so
    // executeStep's read finds it ended and replies `blocked` "not eligible".
    const def = wf({ ask: agent(), more: agent({}, ['ask']) });
    const d = await drive(def, async (store, call) => {
      if (call !== 1) return;
      store.armAfterNextGet(async (runId) => {
        await abandonRun(store, runId, 'ended elsewhere');
      });
    });
    // (a) the terminal conjunct dropped → the blocked arm prints `✗ Step 'ask' is not eligible in
    // the current run state.` (the reply's hint) and returns before the run-ended line. (b) prints the
    // result and the screen's last two lines.
    expect({
      result: d.result,
      calls: d.calls,
      tail: d.lines.slice(-2),
      crosses: d.lines.filter((l) => l.includes('✗')),
    }).toEqual({
      result: 'failed',
      calls: 1,
      tail: ['log:   An agent step.', 'error: \nRun ended in phase: abandoned'],
      crosses: [],
    });
    const run = await d.store.get(d.runId);
    expect(run.terminal_state).toBe(true);
    expect(run.completed_steps).toEqual([]);
  });
});
