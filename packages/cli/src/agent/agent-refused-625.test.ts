// agent-refused-625.test.ts — issue #625 PR-2a, decision C82 in `realm agent`: an agent step the
// run refuses before its claim (a failed precondition, or a `trust` value the engine refuses) is never
// picked, so no model is asked to answer it — before C82 the drive called the model on every pass of
// an unbounded loop, printing `✓ → running` each time (round 11: 11,576 calls in 20 s on `c8ea7e97`).
// The step is named once, and the drive ends on the cannot-go-on exit: one closing line, `failed`
// (exit 1). Head and chained, each with a control.
//
// C82 (5): the drive's `blocked` arm never prints `✓`. A step another process took between this
// drive's read and the engine's own read (the step is then "not eligible" but in flight, done or
// failed on the record) is said as taken (D3.2); any other `blocked` reply prints its own hint and the
// drive stops.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  executeStep,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';

const agent = (extra: Partial<StepDefinition> = {}, depends_on: string[] = []): StepDefinition =>
  ({ description: 'An agent step.', execution: 'agent', depends_on, ...extra }) as StepDefinition;

function wf(steps: Record<string, StepDefinition>): WorkflowDefinition {
  return {
    id: 'c82-wf',
    name: 'c82',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  };
}

const PRE: Partial<StepDefinition> = { preconditions: ['run.params.ok == true'] };
const TRUST = { trust: 'bogus_value' } as unknown as Partial<StepDefinition>;
const HEADER = ['log: \nRealm Agent — c82 v1', 'log: Run ID: <run>\n'];
const PRE_LINE =
  "log: • Step 'ask' cannot run (precondition): Precondition failed for step 'ask'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.";
const TRUST_LINE =
  "log: • Step 'ask' cannot run (trust): 'trust: \"bogus_value\"' is not a recognized value — the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE). Accepts auto, human_confirmed, human_reviewed — correct the value and 'realm workflow register <path>'.";
// decision C179 (round 23): for the agent step whose answer the model gave, the line says the
// answer was not recorded (it said `not run here`, the line an engine step another process took gets).
const TAKEN_IN_FLIGHT =
  "log: • Step 'ask' was taken by a program whose name was not recorded at <since>; this drive's answer was not recorded.";
const stopLine = (check: string, step = 'ask'): string =>
  `error: \n✗ The drive stops: nothing else can run, and '${step}' cannot run (${check}). Run <run> stays open (phase 'running'): correct the workflow, register it again, then realm run advance <run>; or end it: realm run abandon <run>.`;

interface Drive {
  result: string;
  lines: string[];
  calls: number;
  runId: string;
  store: InMemoryStore;
}

/** One `realm agent` drive; `answer` is what the counting provider returns, `during` runs inside each call. */
async function drive(
  def: WorkflowDefinition,
  answer: Record<string, unknown> = {},
  during?: (store: InMemoryStore) => Promise<void>,
): Promise<Drive> {
  const store = new InMemoryStore();
  let calls = 0;
  const provider = new (class extends LlmProvider {
    async callStep(): Promise<Record<string, unknown>> {
      calls += 1;
      if (during !== undefined) await during(store);
      return answer;
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
      },
      { definition: def, params: {}, inFlightPollMs: 5, inFlightWatchMs: 20 },
    );
  } finally {
    vi.restoreAllMocks();
  }
  const runId = (await store.list())[0]!.id;
  return { result, lines: lines.map((l) => l.split(runId).join('<run>')), calls, runId, store };
}

describe('#625 PR-2a, C82 — realm agent never picks an agent step refused before its claim', () => {
  it('head, precondition: no model call; the step named once; the cannot-go-on exit (failed)', async () => {
    const d = await drive(wf({ ask: agent(PRE) }));
    // (a) red when the pick ignores `agent_refused` (the model is called) or the exit reads engine
    // steps only; (b) prints the result, the call count and the screen.
    expect({ result: d.result, calls: d.calls, lines: d.lines }).toEqual({
      result: 'failed',
      calls: 0,
      lines: [...HEADER, PRE_LINE, stopLine('precondition')],
    });
    expect((await d.store.get(d.runId)).evidence).toEqual([]);
  });

  it('head, trust: no model call; the step named once; the cannot-go-on exit (failed)', async () => {
    const d = await drive(wf({ ask: agent(TRUST) }));
    expect({ result: d.result, calls: d.calls, lines: d.lines }).toEqual({
      result: 'failed',
      calls: 0,
      lines: [...HEADER, TRUST_LINE, stopLine('trust')],
    });
  });

  it('CONTROL — head, no precondition: one model call, the run completes', async () => {
    const d = await drive(wf({ ask: agent() }));
    expect({ result: d.result, calls: d.calls }).toEqual({ result: 'completed', calls: 1 });
  });

  it('chained: the step before runs (one call), the refused agent step after it is named and never called', async () => {
    const d = await drive(
      wf({ first: agent(), ask: agent({ preconditions: ['first.ok == true'] }, ['first']) }),
      { ok: false },
    );
    expect({ result: d.result, calls: d.calls, tail: d.lines.slice(-2) }).toEqual({
      result: 'failed',
      calls: 1,
      tail: [
        "log: • Step 'ask' cannot run (precondition): Precondition failed for step 'ask'. Precondition failed: 'first.ok == true'. Resolved value: false.",
        stopLine('precondition'),
      ],
    });
    expect((await d.store.get(d.runId)).completed_steps).toEqual(['first']);
  });

  it('CONTROL — chained, the precondition passes: two calls, the run completes', async () => {
    const d = await drive(
      wf({ first: agent(), ask: agent({ preconditions: ['first.ok == true'] }, ['first']) }),
      { ok: true },
    );
    expect({ result: d.result, calls: d.calls }).toEqual({ result: 'completed', calls: 2 });
  });

  it('beside a ready agent step: the ready one runs, the refused one is named once, then the exit', async () => {
    const d = await drive(wf({ ask: agent(PRE), ok: agent() }));
    expect({ result: d.result, calls: d.calls }).toEqual({ result: 'failed', calls: 1 });
    expect(d.lines.filter((l) => l === PRE_LINE)).toHaveLength(1);
    expect(d.lines.at(-1)).toBe(stopLine('precondition'));
    expect((await d.store.get(d.runId)).completed_steps).toEqual(['ok']);
  });
});

describe('#625 PR-2a, C82 (4) — the cannot-go-on exit, never while a step is in flight elsewhere', () => {
  it('a refused agent step whose precondition reads a step another program is running: the drive waits, then runs it', async () => {
    // `ask` reads `a`'s answer; another program is running `a` when the drive starts. Stopping with
    // "nothing else can run … correct the workflow" would be false: `a` completes with `ok: true`.
    const def = wf({ a: agent(), ask: agent({ preconditions: ['a.ok == true'] }) });
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const other = executeStep(store, def, {
      runId: run.id,
      command: 'a',
      input: {},
      dispatcher: async () => {
        await released;
        return { ok: true };
      },
    });
    while (!(await store.get(run.id)).in_progress_steps.includes('a')) {
      await new Promise((r) => setTimeout(r, 2));
    }
    let calls = 0;
    const provider = new (class extends LlmProvider {
      async callStep(): Promise<Record<string, unknown>> {
        calls += 1;
        return {};
      }
    })();
    const lines: string[] = [];
    for (const kind of ['log', 'error', 'warn'] as const) {
      vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
        lines.push(`${kind}: ${a.join(' ')}`);
      });
    }
    setTimeout(release, 60);
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
        },
        {
          definition: def,
          params: {},
          existingRunId: run.id,
          inFlightPollMs: 5,
          inFlightWatchMs: 5000,
        },
      );
    } finally {
      vi.restoreAllMocks();
    }
    expect((await other).status).toBe('ok');
    // (a) red when the exit fires with a step in flight (the drive stops on 'ask' with the false
    // "nothing else can run" and never calls the model); (b) prints the result, the calls, the stop.
    expect({
      result,
      calls,
      stopped: lines.filter((l) => l.includes('The drive stops')),
      completed: (await store.get(run.id)).completed_steps,
    }).toEqual({ result: 'completed', calls: 1, stopped: [], completed: ['a', 'ask'] });
  });
});

describe('#625 PR-2a, C82 (5) — the drive’s blocked arm never prints ✓', () => {
  it('a precondition that fails on the engine’s own read (after this drive read the record): the reply’s hint, and the drive stops', async () => {
    // The step passes the view when the drive picks it; while the model answers, its precondition
    // stops holding (here: the definition the engine reads changes — any change after the drive's
    // read reaches the same reply), so the engine refuses it before its claim.
    const def = wf({ ask: agent() });
    const d = await drive(def, {}, async () => {
      def.steps['ask']!.preconditions = ['nothing.ok == true'];
    });
    // (a) red when the arm prints `✓ → running` (and the loop goes on); (b) prints the screen.
    expect({ result: d.result, calls: d.calls, tail: d.lines.slice(-2) }).toEqual({
      result: 'failed',
      calls: 1,
      tail: ['log:   An agent step.', "error: \n✗ Precondition failed for step 'ask'."],
    });
    expect(d.lines.filter((l) => l.includes('✓'))).toEqual([]);
  });

  it('a step another process took between this drive’s read and the engine’s: said as taken, never ✓', async () => {
    // `more` keeps the run live after `ask` settles (on a run the other process ENDED, the engine's
    // reply is `ok` "already terminal; no steps executed" — not a blocked reply; see the report).
    const def = wf({ ask: agent(), more: agent({}, ['ask']) });
    let once = false;
    const d = await drive(def, {}, async (store) => {
      // Another process completes `ask` while this drive's model answers (the first call only).
      if (once) return;
      once = true;
      const runId = (await store.list())[0]!.id;
      const r = await executeStep(store, def, {
        runId,
        command: 'ask',
        input: {},
        dispatcher: async () => ({ by: 'other' }),
      });
      expect(r.status).toBe('ok');
    });
    // (a) red when the not-eligible reply of a taken step prints `✓` or stops the drive; (b) prints
    // the result and the lines after the attempt.
    const after = d.lines.slice(d.lines.indexOf('log: \n→ [agent] ask') + 2);
    expect({ result: d.result, calls: d.calls, taken: after[0], next: after[1] }).toEqual({
      result: 'completed',
      calls: 2,
      taken:
        "log: • Step 'ask' was taken by another process, whose claim is no longer on the record, and completed; this drive's answer was not recorded.",
      next: 'log: \n→ [agent] more',
    });
    expect(d.lines.filter((l) => l.startsWith('log:   ✓')).length).toBe(1);
  });

  it('the member "in flight": another process claimed the step and has not settled it — said as taken, never ✓', async () => {
    const def = wf({ ask: agent(), more: agent({}, ['ask']) });
    let once = false;
    const d = await drive(def, {}, async (store) => {
      if (once) return;
      once = true;
      const runId = (await store.list())[0]!.id;
      await store.claimStep(runId, 'ask', def);
    });
    // (a) red when the in-flight member is dropped (the reply then prints its hint and stops);
    // (b) prints the line after the attempt and the result.
    const after = d.lines.slice(d.lines.indexOf('log: \n→ [agent] ask') + 2);
    expect({
      result: d.result,
      calls: d.calls,
      taken: after[0]?.replace(/ at \S+Z;/, ' at <since>;'),
    }).toEqual({
      result: 'failed',
      calls: 1,
      taken: TAKEN_IN_FLIGHT,
    });
    expect(d.lines.filter((l) => l.includes('✓'))).toEqual([]);
  });

  it('the member "failed": another process ran the step and it failed — said as taken, never ✓', async () => {
    // `side` keeps the run live after `ask` fails.
    const def = wf({ ask: agent(), side: agent() });
    let once = false;
    const d = await drive(def, {}, async (store) => {
      if (once) return;
      once = true;
      const runId = (await store.list())[0]!.id;
      const r = await executeStep(store, def, {
        runId,
        command: 'ask',
        input: {},
        dispatcher: async () => {
          throw new Error('the other process failed');
        },
      });
      expect(r.status).toBe('error');
    });
    const after = d.lines.slice(d.lines.indexOf('log: \n→ [agent] ask') + 2);
    expect({ calls: d.calls, taken: after[0], next: after[1] }).toEqual({
      calls: 2,
      taken:
        "log: • Step 'ask' was taken by another process, whose claim is no longer on the record, and failed; this drive's answer was not recorded.",
      next: 'log: \n→ [agent] side',
    });
    expect((await d.store.get(d.runId)).failed_steps).toEqual(['ask']);
  });
});
