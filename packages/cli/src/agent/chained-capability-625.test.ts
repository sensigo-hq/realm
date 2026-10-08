// chained-capability-625.test.ts — issue #625 PR-2a, decision C64 (the census): `realm agent` reaches
// "cannot go on here" through the chain after an agent step — the agent step completes, and the
// chain's next step needs a handler this runner lacks. The reply is the chained step's block. Before
// this, the block was printed against the AGENT step (`⚠ Step 'ask' is blocked: the missing handler
// …` — measured on `d2f0b3cf` and on round 7's head): the wrong step, and the need unnamed. The reply
// is now held as the loop top holds its own (decision C23): the next pass names the blocked step
// once, the drive goes on with any ready agent step, and the exit names the blocked step and what it
// needs.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { readFileSync as readDoc625 } from 'node:fs';
import { join as joinDoc625, dirname as dirDoc625 } from 'node:path';
import { fileURLToPath as urlDoc625 } from 'node:url';

/** C174: (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claimDoc625(page: string, sentence: string): void {
  const text = readDoc625(
    joinDoc625(dirDoc625(urlDoc625(import.meta.url)), '../../../..', page),
    'utf8',
  );
  expect(text.replace(/\s+/g, ' '), `${page} no longer says: ${sentence}`).toContain(
    sentence.replace(/\s+/g, ' '),
  );
}

const BLOCKED_LINE =
  "log: • Step 'compute' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it";
const EXIT_LINE =
  "error: \n⚠ Step 'compute' is blocked: handler 'missing_h' is not registered in this runner. The run is NOT failed — add handler 'missing_h' and re-attach (`realm agent --run-id <run> --provider <provider> --model <model>`).";

function fixture(secondAgentStep: boolean): WorkflowDefinition {
  return {
    id: 'c64-chain-cap',
    name: 'c64 chain cap',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
      compute: {
        description: 'Compute.',
        execution: 'auto',
        depends_on: ['ask'],
        handler: 'missing_h',
      },
      ...(secondAgentStep
        ? { ask2: { description: 'Ask 2.', execution: 'agent' as const, depends_on: ['ask'] } }
        : {}),
    },
  };
}

async function drive(secondAgentStep: boolean) {
  const def = fixture(secondAgentStep);
  const store = new InMemoryStore();
  const provider = new (class extends LlmProvider {
    callStep = vi.fn().mockResolvedValue({});
  })();
  const lines: string[] = [];
  for (const kind of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
      lines.push(`${kind}: ${a.join(' ')}`);
    });
  }
  const result = await runAgent(
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
  vi.restoreAllMocks();
  const runId = (await store.list())[0]!.id;
  return {
    result,
    lines: lines.map((l) => l.split(runId).join('<run>')),
    calls: provider.callStep.mock.calls.length,
    run: await store.get(runId),
  };
}

describe('#625 PR-2a, C64 — realm agent: a chained step this runner lacks the code for', () => {
  it('the agent step is said as completed, the blocked step is named once, and the exit names the blocked step and its handler', async () => {
    const d = await drive(false);
    expect(d.result).toBe('failed');
    expect(d.run.completed_steps).toEqual(['ask']);
    expect(Object.keys(d.run.capability_blocks ?? {})).toEqual(['compute']);
    const at = d.lines.indexOf('log: \n→ [agent] ask');
    expect(at).toBeGreaterThan(-1);
    expect(d.lines.slice(at + 2)).toEqual(['log:   ✓ → running', BLOCKED_LINE, EXIT_LINE]);
    expect(d.lines.join('\n')).not.toContain("Step 'ask' is blocked");
  });

  it('control: a second agent step is ready — the drive goes on with it after naming the blocked step, then stops on the blocked step', async () => {
    const d = await drive(true);
    expect(d.result).toBe('failed');
    expect(d.calls).toBe(2);
    expect(d.run.completed_steps).toEqual(['ask', 'ask2']);
    const named = d.lines.indexOf(BLOCKED_LINE);
    expect(named).toBeGreaterThan(-1);
    expect(d.lines.indexOf('log: \n→ [agent] ask2')).toBeGreaterThan(named);
    expect(d.lines.filter((l) => l === BLOCKED_LINE)).toHaveLength(1);
    expect(d.lines.at(-1)).toBe(EXIT_LINE);
  });
});

describe('#625 PR-2a, C174 — realm-agent.md: when a drive attempts a step whose handler is missing', () => {
  it('the first drive of a run attempts it as soon as it is owed, before a ready agent step; once the block is on the record, a later drive only when nothing else is left', async () => {
    claimDoc625(
      'docs/reference/cli/realm-agent.md',
      "A step whose handler or adapter is missing is attempted once by each drive (`→ [auto] <step>`), and each attempt is recorded in the run's `capability_blocks`: the first drive of a run attempts it as soon as it is owed, before any agent step that is ready; a later drive, once the run's record holds the block, attempts it only when it has nothing else to run;",
    );
    const def: WorkflowDefinition = {
      id: 'c174-first-drive',
      name: 'c174 first drive',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        fetch: { description: 'Fetch.', execution: 'auto', depends_on: [], handler: 'missing_h' },
        classify: { description: 'Classify.', execution: 'agent', depends_on: [] },
      },
    };
    const store = new InMemoryStore();
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({});
    })();
    const lines: string[] = [];
    for (const kind of ['log', 'error', 'warn'] as const) {
      vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
        lines.push(`${kind}: ${a.join(' ')}`);
      });
    }
    const deps = {
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
    };
    await runAgent(deps, { definition: def, params: {}, inFlightPollMs: 5, inFlightWatchMs: 20 });
    vi.restoreAllMocks();
    // An agent step's line begins with a blank line (`\n→ [agent] …`).
    const order = lines.filter((l) => /^log: \n?→ \[/.test(l)).map((l) => l.replace('\n', ''));
    const runId = (await store.list())[0]!.id;
    // (a) red when the first drive runs the ready agent step before attempting the blocked step;
    //     (b) prints the step lines.
    expect(order.slice(0, 2)).toEqual(['log: → [auto] fetch', 'log: → [agent] classify']);
    expect(Object.keys((await store.get(runId)).capability_blocks ?? {})).toEqual(['fetch']);
  });
});
