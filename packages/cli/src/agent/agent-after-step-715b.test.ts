// agent-after-step-715b.test.ts — issue #715 (b) 02 §B.1-B.2 (D6-17) with Amendment 4: what `realm
// agent` prints about the record after an engine call is judged on the snapshot the engine judged
// its reply on (the drive's held snapshot), and the drive judges time at that snapshot's reading:
//   (:618) the resume line after a step that ended the run — another program resumes the run right
//          after the engine's last read of it, and the line still names the failure the reply was judged on;
//   (:698) an open question whose deadline the STORE's clock has passed is carried out — though on
//          the host's clock it is years from due;
//   (:845) the `✓ → <phase>` line after an advance — another program ends the run right after the
//          engine's last read, and the line names the phase the reply was judged on.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  advanceRun,
  applyResume,
  createDefaultRegistry,
  stripSpanMarks,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { runsOf } from '../test-support/temp-home.js';

const workflowStore = (def: WorkflowDefinition) => ({
  async register() {},
  async get() {
    return def;
  },
  async list() {
    return [def];
  },
});

/** Runs the drive on `store`; returns everything it printed, span marks stripped. */
async function drive(
  store: RunStore,
  def: WorkflowDefinition,
  registry: ExtensionRegistry,
  existingRunId?: string,
) {
  const lines: string[] = [];
  for (const kind of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
      lines.push(stripSpanMarks(a.join(' ')));
    });
  }
  const provider = new (class extends LlmProvider {
    callStep = vi.fn().mockResolvedValue({});
  })();
  await runAgent(
    { store, workflowStore: workflowStore(def), provider, registry },
    {
      definition: def,
      params: {},
      ...(existingRunId !== undefined ? { existingRunId } : {}),
      inFlightPollMs: 5,
      inFlightWatchMs: 20,
    },
  );
  vi.restoreAllMocks();
  return lines.join('\n');
}

/** `store` with a hook run right after one call returns, once. */
function after(
  store: InMemoryStore,
  method: 'settleStep' | 'get',
  when: (args: unknown[], out: unknown) => boolean,
  act: (target: InMemoryStore) => Promise<void>,
) {
  let fired = false;
  const wrapped = new Proxy(store, {
    get(target, prop) {
      if (prop === method) {
        return async (...a: unknown[]) => {
          const out = await (target[method] as (...x: unknown[]) => Promise<unknown>).apply(
            target,
            a,
          );
          if (!fired && when(a, out)) {
            fired = true;
            await act(target);
          }
          return out;
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as RunStore;
  return { wrapped, fired: () => fired };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#715 (b) §B.1-B.2 — realm agent judges what it prints on the reply’s snapshot', () => {
  it('(:618) a step whose failure ends the run: the resume line is the failure’s, though another program resumed the run right after the engine’s last read', async () => {
    // (a) red when the drive reads the run again for its resume line (the run is live again there:
    //     no line); (b) prints the drive's lines.
    const def: WorkflowDefinition = {
      id: 'agent-618-715b',
      name: 'agent-618-715b',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { boom: { description: 'Boom.', execution: 'auto', depends_on: [], handler: 'boom' } },
    };
    const registry = createDefaultRegistry();
    registry.register('handler', 'boom', {
      id: 'boom',
      execute: async () => {
        throw new Error('boom');
      },
    });
    const store = new InMemoryStore();
    // Another program resumes the run as the drive prints its failure line — after every read the
    // engine made, before the resume line is composed. Any later read of the run waits for that
    // write, so a drive that read the run again would see it.
    let fired = false;
    let landed: Promise<unknown> | undefined;
    const lines: string[] = [];
    const wrapped = new Proxy(store, {
      get(target, prop) {
        if (prop === 'get') {
          return async (id: string) => {
            if (landed !== undefined) await landed;
            return target.get(id);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as RunStore;
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => lines.push(a.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => lines.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      const line = a.join(' ');
      lines.push(line);
      if (!fired && line.includes("✗ Step 'boom' failed")) {
        fired = true;
        landed = runsOf(store).then((l) =>
          store.update(applyResume(l[0]!.record, 'boom', def).run),
        );
      }
    });
    const provider = new (class extends LlmProvider {
      callStep = vi.fn();
    })();
    await runAgent(
      { store: wrapped, workflowStore: workflowStore(def), provider, registry },
      { definition: def, params: {} },
    );
    vi.restoreAllMocks();
    await landed;
    const { record: now } = await runsOf(store).then((l) => l[0]!);
    const out = lines.join('\n');
    expect(
      {
        fired,
        resumedSince: now.terminal_state === false,
        resumeLine: out.includes('realm run resume'),
      },
      out,
    ).toEqual({ fired: true, resumedSince: true, resumeLine: true });
  });

  it('(:698) a question whose deadline the store’s clock has passed is carried out, though the host’s clock is years before it', async () => {
    // (a) red when the drive judges the open question at the host's clock (it then waits on a
    //     question that is due, and never carries out its expiry); (b) prints the drive's lines.
    const DEADLINE = Date.parse('2031-05-06T07:01:00.000Z');
    const def: WorkflowDefinition = {
      id: 'agent-698-715b',
      name: 'agent-698-715b',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        q: {
          description: 'Q.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve', 'reject'], timeout_seconds: 60, on_expiry: 'abort' },
        },
      },
    };
    const clock = settableClock(new Date(DEADLINE - 60_000));
    const store = new InMemoryStore({ clock });
    const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await advanceRun(store, def, { runId: record.id });
    await clock.set(new Date(DEADLINE + 1_000));
    const out = await drive(store, def, new ExtensionRegistry(), record.id);
    const { record: after } = await store.get(record.id);
    expect(
      { phase: after.run_phase, carriedOut: out.includes('carried out its declared abort') },
      out,
    ).toEqual({ phase: 'aborted', carriedOut: true });
  }, 15_000);

  it('(:845) after an advance, the ✓ line names the phase the reply was judged on, though another program ended the run right after the engine’s last read', async () => {
    // (a) red when the drive reads the run again after the advance (its ✓ line names the interposed
    //     ending); (b) prints the drive's lines.
    const def: WorkflowDefinition = {
      id: 'agent-845-715b',
      name: 'agent-845-715b',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        s: { description: 'S.', execution: 'auto', depends_on: [] },
        review: { description: 'Review.', execution: 'agent', depends_on: ['s'] },
      },
    };
    const store = new InMemoryStore();
    const { wrapped, fired } = after(
      store,
      'get',
      (_a, out) =>
        (out as { record: { completed_steps: string[] } }).record.completed_steps.includes('s'),
      async (target) => {
        const { record } = await runsOf(target).then((l) => l[0]!);
        await target.settleStep(record.id, {
          kind: 'seal_run',
          arm: 'abandon_requested',
          reason: 'ended by another program',
          expected_version: record.version,
          release_claims: true,
        });
      },
    );
    const out = await drive(wrapped, def, createDefaultRegistry());
    expect({ fired: fired(), running: out.includes('  ✓ → running') }, out).toEqual({
      fired: true,
      running: true,
    });
  });
});
