// own-act-a1a.test.ts — issue #625 PR-2b (A1a), check 9: `realm agent` prints an agent step's own
// ✓ when the chain it ran goes on, and the chained steps' `→ [auto]` lines, as its advance path does.
//
// Before A1a, when the model's answer for an agent step was recorded and Realm then ran the next
// auto step by itself, the screen said nothing about that step until the chain ended — and a chain
// that stopped printed no ✓ for the agent step at all. Now the agent step's ✓ comes when the first
// chained step starts, each chained step has its `→ [auto]` line, a step another process took has
// the taken line (never a ✓ under it), and the agent step's billed model calls stay its own.
//
// Driven in-process through the real `runAgent`, a real engine and an `InMemoryStore`. Every
// assertion carries (a) the change that turns it red and (b) what it prints.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import {
  advanceRun,
  createDefaultRegistry,
  submitHumanResponse,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type ExtensionRegistry,
  type PendingGate,
  type RunRecord,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { runsOf } from '../test-support/temp-home.js';

const RACER = { by: 'racer-b', by_source: 'stated', channel: 'test' } as const;

/** `ask` (the model's step) → `compute` (an auto step) → `more` (whatever follows). */
function wf(id: string, more: WorkflowDefinition['steps'], handler = 'h'): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
      compute: { description: 'Compute.', execution: 'auto', depends_on: ['ask'], handler },
      ...more,
    },
  } as WorkflowDefinition;
}

function registry(): ExtensionRegistry {
  const r = createDefaultRegistry();
  r.register('handler', 'h', { id: 'h', execute: async () => ({ data: { computed: true } }) });
  return r;
}

/** A provider whose one call for a step bills 1234 prompt tokens. */
function billingProvider() {
  return new (class extends LlmProvider {
    callStep = vi.fn();
    async callStepWithMeta() {
      return {
        output: { answer: 42 },
        usage: [
          {
            request_index: 0,
            request_start: '2026-09-27T00:00:00.000Z',
            prompt_tokens: 1234,
            output_tokens: 56,
          },
        ],
      } as never;
    }
  })();
}

/** One drive of a fresh run of `def`; the screen's lines, `<kind>: <text>`, the run id put as `<run>`. */
async function drive(
  def: WorkflowDefinition,
  opts: {
    store?: (inner: InMemoryStore, def: WorkflowDefinition) => RunStore;
    gateHandler?: (store: RunStore) => (runId: string, gate: PendingGate) => Promise<void>;
  } = {},
) {
  const inner = new InMemoryStore({ leases: createLeaseDouble() });
  const store = opts.store?.(inner, def) ?? inner;
  const lines: string[] = [];
  for (const kind of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
      lines.push(`${kind}: ${a.join(' ')}`);
    });
  }
  let result: unknown;
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
        provider: billingProvider(),
        registry: registry(),
        ...(opts.gateHandler !== undefined ? { gateHandler: opts.gateHandler(inner) } : {}),
      },
      { definition: def, params: {}, inFlightPollMs: 5, inFlightWatchMs: 20 },
    );
  } catch (e) {
    result = `threw: ${String((e as Error).message)}`;
  } finally {
    vi.restoreAllMocks();
  }
  const run = (await runsOf(inner)).map((s) => s.record)[0]!;
  return {
    result,
    run,
    lines: lines.flatMap((l) => l.split(run.id).join('<run>').split('\n')).filter((l) => l !== ''),
  };
}

/** The lines from `→ [agent] ask` up to (not including) `until`'s first line after it. */
function after(lines: string[], until?: (l: string) => boolean): string[] {
  const at = lines.findIndex((l) => l.endsWith('→ [agent] ask'));
  const rest = lines.slice(at);
  const end = until === undefined ? -1 : rest.findIndex((l, i) => i > 0 && until(l));
  return end === -1 ? rest : rest.slice(0, end);
}

const TICK = 'log:   ✓ → running';

describe('#625 A1a, check 9 — realm agent: the agent step’s ✓ and the chain’s lines', () => {
  it('an agent step, then an auto step, then a gate: ✓ when the auto step starts, its → [auto] line, the stop at the gate as today', async () => {
    const def = wf('a1a-agent-gate', {
      confirm: {
        description: 'Confirm.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: ['compute'],
        gate: { choices: ['approve', 'reject'] },
      },
    });
    const d = await drive(def, {
      gateHandler: (store) => async (runId, gate) => {
        await submitHumanResponse(store, def, { runId, gateId: gate.gate_id, choice: 'approve' });
      },
    });
    // (a) red when only `onStep` is forwarded without the marker (a ✓ missing, or one printed after
    //     the chain stops), or a → [auto] line is missing; (b) prints the screen from the agent step
    //     to the gate. Each started step's ✓ comes when the next step starts, as on the advance path;
    //     the chain stops at the gate with no ✓ for the gate's step, as today.
    expect(after(d.lines, (l) => l.startsWith('⏸'))).toEqual([
      '→ [agent] ask',
      'log:   Ask.',
      TICK,
      'log: → [auto] compute',
      TICK,
      'log: → [auto] confirm',
      'log: ',
    ]);
    expect({ completed: d.run.completed_steps, result: d.result }).toEqual({
      completed: ['ask', 'compute', 'confirm'],
      result: 'completed',
    });
  });

  it('a chained capability block: one ✓ then → [auto] compute, no second ✓', async () => {
    const def = wf('a1a-agent-cap', {}, 'missing_h');
    const d = await drive(def);
    const seen = after(d.lines);
    // (a) red when the C64 arm prints a ✓ for the agent step after the chained step started (a
    //     second ✓), or the → [auto] line is missing; (b) prints the screen.
    expect({
      ticks: seen.filter((l) => l === TICK).length,
      tickThenAuto: seen.indexOf('log: → [auto] compute') === seen.indexOf(TICK) + 1,
      result: d.result,
    }).toEqual({ ticks: 1, tickThenAuto: true, result: 'failed' });
  });

  it('a chained step another process took: the taken line, no ✓ under it', async () => {
    const def = wf('a1a-agent-taken', {
      done: { description: 'Done.', execution: 'agent', depends_on: ['compute'] },
    });
    let fired = false;
    const d = await drive(def, {
      store: (inner, d) =>
        new Proxy(inner, {
          get(target, prop) {
            if (prop === 'claimStep') {
              return async (...a: Parameters<InMemoryStore['claimStep']>) => {
                if (a[1] === 'compute' && !fired) {
                  fired = true;
                  // Another program runs `compute` first.
                  await advanceRun(inner, d, { runId: a[0], registry: registry(), driver: RACER });
                }
                return target.claimStep(...a);
              };
            }
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
          },
        }) as unknown as RunStore,
    });
    // (a) red when `onTaken` is not forwarded (no taken line, and a ✓ for `compute` after it) or a
    //     ✓ follows the taken line; (b) prints the screen from the agent step to `done`.
    expect(after(d.lines, (l) => l.endsWith('→ [agent] done'))).toEqual([
      '→ [agent] ask',
      'log:   Ask.',
      TICK,
      'log: → [auto] compute',
      "log: • Step 'compute' was taken by another process, whose claim is no longer on the record; not run here.",
      'log: ',
    ]);
    expect(d.result).toBe('completed');
  });

  it('a throw mid-chain: the agent step’s billed calls are recorded once, on the agent step', async () => {
    // A store that keeps no workflow-context snapshot (each step re-takes it) and whose second
    // snapshot write — the chained `compute`'s — throws: unguarded in the engine, the throw escapes
    // `executeChain` and reaches the drive's last-resort catch.
    const def = {
      ...wf('a1a-agent-throw', {}),
      workflow_context: { doc: { source: { path: '/nonexistent/realm-a1a-context.md' } } },
    } as WorkflowDefinition;
    let writes = 0;
    const d = await drive(def, {
      store: (inner) =>
        new Proxy(inner, {
          get(target, prop) {
            if (prop === 'update') {
              return async (record: RunRecord) => {
                if (record.workflow_context_snapshots === undefined) return target.update(record);
                writes += 1;
                if (writes >= 2) throw new Error('snapshot write failed');
                const { workflow_context_snapshots: _dropped, ...rest } = record;
                return target.update(rest as RunRecord);
              };
            }
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
          },
        }) as unknown as RunStore,
    });
    const entry = d.run.drive_failures?.entries.at(-1);
    // (a) red when the chained step's `onStep` moves the step the drive attaches calls to (the
    //     entry then names `compute` and carries the agent step's calls a second time); (b) prints
    //     the drive's end, the steps, the agent step's requests and the entry.
    expect({
      result: d.result,
      completed: d.run.completed_steps,
      askRequests: d.run.evidence.find((e) => e.step_id === 'ask')?.diagnostics?.cache?.requests
        ?.length,
      entryStep: entry?.step,
      entryUsage: entry?.usage,
    }).toEqual({
      result: 'threw: snapshot write failed',
      completed: ['ask'],
      askRequests: 1,
      entryStep: 'ask',
      entryUsage: undefined,
    });
  });
});
