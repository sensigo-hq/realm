// held-reply-922.test.ts — #922 P1a (prompt fix-922-p1-reclaim-way.md items 1, 3, 4; checks 1–4, 13),
// through the MCP door an agent is served: an agent is told to wait only for a held step that can still
// finish, a held step's past deadline never becomes `until`, and `elsewhere` and the person block show
// at most NAMES_SHOWN reclaim ways, past → unknown → ahead, then one line naming the rest.
//
// The runs are real: an in-memory store on a settable clock, claims written as a store writes them,
// read back through `get_run_state` and `advance_run`. Every assertion carries (a) the change that
// turns it red and (b) what it prints on failure: tool names, action words, steps and booleans.
import { describe, it, expect, afterEach } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  InMemoryTraceBufferStore,
  type WayOn,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

const START = new Date('2030-01-01T12:00:00.000Z');
const plus = (ms: number): string => new Date(START.getTime() + ms).toISOString();
const SINCE = plus(-3_600_000);

type Reply = Record<string, unknown>;
type Claim = { deadline: string | null; since?: string } | 'no_record';

const handles: TempHome[] = [];
afterEach(async () => {
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

function workflow(id: string, steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  } as WorkflowDefinition;
}

const agent = (depends_on: string[] = []) => ({
  description: 'An agent step.',
  execution: 'agent' as const,
  depends_on,
});

/** A route that renders a person's ways as commands, as `realm mcp` injects one. */
const ROUTE = {
  render: (way: WayOn) =>
    way.verb === 'reclaim'
      ? `RECLAIM ${way.step}`
      : way.verb === 'inspect'
        ? `INSPECT ${way.run_id}`
        : null,
  source: { kind: 'default' as const, ref: 'held-reply-922' },
};

async function door(
  def: WorkflowDefinition,
  opts: {
    gateAnswers?: 'permitted' | 'withheld';
    registry?: ExtensionRegistry;
    route?: boolean;
  } = {},
) {
  const clock = settableClock(START);
  const runStore = new InMemoryStore({ clock });
  const h = await makeTempHome();
  handles.push(h);
  await h.stores.workflowStore.register(def);
  const server = createRealmMcpServer({
    gateAnswers: opts.gateAnswers ?? 'permitted',
    runStore,
    workflowStore: h.stores.workflowStore,
    traceBufferStore: new InMemoryTraceBufferStore(runStore),
    failedAttemptStore: h.stores.failedAttemptStore,
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
    ...(opts.route === true ? { operatorRoute: ROUTE } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'held-reply-922', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (
    name: string,
    args: Reply,
  ): Promise<{ json: Reply; text: string; person?: string }> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string; annotations?: { audience?: string[] } }>;
    };
    const text = raw.content[0]!.text;
    const person = raw.content.find((c) => c.annotations?.audience?.includes('user'))?.text;
    return { json: JSON.parse(text) as Reply, text, ...(person !== undefined ? { person } : {}) };
  };
  const start = async (): Promise<string> =>
    (await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} })).record.id;
  /** The steps held elsewhere, each with its claim as a store writes it (or none on record). */
  const hold = async (runId: string, claims: Record<string, Claim>): Promise<void> => {
    const { record } = await runStore.get(runId);
    const written: Record<string, unknown> = { ...record.claims };
    for (const [step, claim] of Object.entries(claims)) {
      if (claim !== 'no_record') written[step] = { token: `other-${step}`, ...claim };
    }
    await runStore.update({
      ...record,
      in_progress_steps: [...new Set([...record.in_progress_steps, ...Object.keys(claims)])],
      claims: written as typeof record.claims,
    });
  };
  return { call, runStore, clock, start, hold };
}

/** What the reply rule decided, in one line: the action, `until`, and the tools callable. */
const verdict = (r: Reply) => ({
  action: r['agent_action'],
  until: r['until'] ?? null,
  tools: ((r['next_actions'] as Array<{ instruction?: { tool?: string } | null }>) ?? []).map(
    (n) => n.instruction?.tool ?? 'await',
  ),
});

describe('#922 P1a — check 1, the bug: a run whose only blocker is a held step past its deadline', () => {
  it('get_run_state: report_to_user, no until — judged at the reading of the record (snap.at)', async () => {
    const d = await door(workflow('held-922-c1', { a: agent() }));
    const runId = await d.start();
    await d.hold(runId, { a: { deadline: plus(-60_000), since: SINCE } });
    const r = (await d.call('get_run_state', { run_id: runId })).json;
    // (a) red when clears_at is set for a past deadline (the agent is then told to wait, paced at the
    //     floor, for a step whose claim already lapsed — the 0.49.0 reply); (b) prints the verdict.
    expect(verdict(r)).toEqual({ action: 'report_to_user', until: null, tools: [] });
  });

  it('the same claim one minute before its deadline: await, until the deadline', async () => {
    const d = await door(workflow('held-922-c1b', { a: agent() }));
    const runId = await d.start();
    await d.hold(runId, { a: { deadline: plus(60_000), since: SINCE } });
    const r = (await d.call('get_run_state', { run_id: runId })).json;
    // (a) red when a live claim stops being a wait; (b) prints the verdict.
    expect(verdict(r)).toEqual({ action: 'await', until: plus(60_000), tools: [] });
  });
});

describe('#922 P1a — check 2, the mixes (the reply rule: await iff some wait and every blocker a wait or past)', () => {
  it('a live hold beside a step this server cannot run (capability_missing): report_to_user', async () => {
    const def = workflow('held-922-c2a', {
      a: agent(),
      h: { description: 'h', execution: 'auto', depends_on: [], handler: 'not-here' },
    });
    const d = await door(def, { registry: new ExtensionRegistry() });
    const runId = await d.start();
    await d.hold(runId, { a: { deadline: plus(60_000), since: SINCE } });
    const r = (await d.call('get_run_state', { run_id: runId })).json;
    // (a) red when `every` is dropped (some wait ⇒ await): the agent would wait for a run only a
    //     person can unblock; (b) prints the verdict.
    expect(verdict(r)).toEqual({ action: 'report_to_user', until: null, tools: [] });
  });

  it('a live hold beside a hold past its deadline: await, until the live deadline', async () => {
    const d = await door(workflow('held-922-c2b', { a: agent(), b: agent() }));
    const runId = await d.start();
    await d.hold(runId, {
      a: { deadline: plus(60_000), since: SINCE },
      b: { deadline: plus(-60_000), since: SINCE },
    });
    const r = (await d.call('get_run_state', { run_id: runId })).json;
    // (a) red when the past hold blocks the wait (report_to_user) or its deadline becomes until;
    //     (b) prints the verdict.
    expect(verdict(r)).toEqual({ action: 'await', until: plus(60_000), tools: [] });
  });

  it('every hold past its deadline: report_to_user', async () => {
    const d = await door(workflow('held-922-c2c', { a: agent(), b: agent() }));
    const runId = await d.start();
    await d.hold(runId, {
      a: { deadline: plus(-60_000), since: SINCE },
      b: { deadline: plus(-120_000), since: SINCE },
    });
    const r = (await d.call('get_run_state', { run_id: runId })).json;
    // (a) red when a past hold counts as a wait; (b) prints the verdict.
    expect(verdict(r)).toEqual({ action: 'report_to_user', until: null, tools: [] });
  });

  it('a step in progress with no claim record waits (it is not past), with no until', async () => {
    const d = await door(workflow('held-922-c2d', { a: agent() }));
    const runId = await d.start();
    await d.hold(runId, { a: 'no_record' });
    const r = (await d.call('get_run_state', { run_id: runId })).json;
    // (a) red when no_claim_record is read as past (report_to_user); (b) prints the verdict.
    expect(verdict(r)).toEqual({ action: 'await', until: null, tools: [] });
  });
});

describe('#922 P1a — check 3, the long loop (m-B): a step that runs past a sibling’s deadline', () => {
  it('advance_run runs an auto step for 60 s while a sibling’s claim lapses: the final reply’s until is never past', async () => {
    const registry = new ExtensionRegistry();
    // the store's clock, set once the door exists: the handler moves it while the step runs
    const clock: { current?: { advance(ms: number): Promise<void> } } = {};
    registry.register('handler', 'slow', {
      id: 'slow',
      execute: async () => {
        await clock.current!.advance(60_000);
        return { data: {} };
      },
    });
    const def = workflow('held-922-c3', {
      s: agent(),
      h: { description: 'h', execution: 'auto', depends_on: [], handler: 'slow' },
    });
    const d = await door(def, { registry });
    clock.current = d.clock;
    const runId = await d.start();
    await d.hold(runId, { s: { deadline: plus(30_000), since: SINCE } });
    const r = (await d.call('advance_run', { run_id: runId })).json;
    const asOf = Date.parse(String((r['basis'] as { as_of: string }).as_of));
    // (a) red when until is computed before the loop (from the reading before `h` ran, when `s`'s
    //     deadline was 30 s ahead); (b) prints the action, until and whether it is past as_of.
    expect({
      ran: asOf >= START.getTime() + 60_000,
      action: r['agent_action'],
      until: r['until'] ?? null,
      untilPast: typeof r['until'] === 'string' ? Date.parse(r['until']) < asOf : false,
    }).toEqual({ ran: true, action: 'report_to_user', until: null, untilPast: false });
  });
});

describe('#922 P1a — check 4 (#1167): a run waiting on a question, beside a hold past its deadline', () => {
  const def = workflow('held-922-c4', {
    q: {
      description: 'q',
      execution: 'auto',
      depends_on: [],
      trust: 'human_confirmed',
      gate: { choices: ['approve', 'reject'] },
    },
    s: agent(),
  });

  for (const answers of ['permitted', 'withheld'] as const) {
    it(`--gate-answers ${answers}: the question drives the run, the past hold never becomes until`, async () => {
      const d = await door(def, { gateAnswers: answers });
      const runId = await d.start();
      await d.call('advance_run', { run_id: runId });
      await d.hold(runId, { s: { deadline: plus(-60_000), since: SINCE } });
      const r = (await d.call('get_run_state', { run_id: runId })).json;
      // (a) red when the past hold changes what the question decides: under `withheld` the agent
      //     waits on the person's answer (the hold past its deadline is no blocker of its own), under
      //     `permitted` it answers; (b) prints the verdict.
      expect(verdict(r)).toEqual(
        answers === 'permitted'
          ? { action: undefined, until: null, tools: ['submit_human_response'] }
          : { action: 'await', until: null, tools: ['await'] },
      );
    });
  }
});

/** The lists get_run_state's reply plan (RUN_STATE_PLAN) cuts to fit the ceiling, each leaving
 *  `<list>_more`. */
const PLAN_LISTS = [
  'defaulted_steps',
  'skipped_steps',
  'completed_steps',
  'skip_details',
  'waiting_on_answer',
  'pending_guards',
  'step_claims',
  'stuck_claims',
  'in_progress_steps',
  'failed_steps',
  'engine_runnable',
  'agent_refused',
  'capability_blocks',
  'next_actions',
  'steps',
];

describe('#922 P1a — check 13, the bound: 100 held steps', () => {
  it('the reply fits under 40,000 characters with nothing cut; 10 reclaim ways past → unknown → ahead, then the line naming the rest', async () => {
    const steps: WorkflowDefinition['steps'] = {};
    const claims: Record<string, Claim> = {};
    for (let i = 0; i < 100; i += 1) {
      const name = `step_${String(i).padStart(3, '0')}`;
      steps[name] = agent();
      // 40 ahead, 30 with no deadline, 30 past — composed past first
      claims[name] =
        i < 40
          ? { deadline: plus(60_000 + i * 1000), since: SINCE }
          : i < 70
            ? { deadline: null, since: SINCE }
            : { deadline: plus(-60_000 - i * 1000), since: SINCE };
    }
    const d = await door(workflow('held-922-c13', steps), { route: true });
    const runId = await d.start();
    await d.hold(runId, claims);
    const { json, text, person } = await d.call('get_run_state', { run_id: runId });
    const elsewhere =
      (json['elsewhere'] as Array<{ verb: string; step?: string; human_readable: string }>) ?? [];
    const reclaims = elsewhere.filter((e) => e.verb === 'reclaim');
    const personLines = (person ?? '').split('\n');
    // (a) red when the bound is removed (100 reclaim entries and 100 person lines), the order is
    //     lost, the rest is not named, or the reply is cut to fit; (b) prints the sizes, the steps
    //     shown and the closing lines.
    expect({
      fits: text.length < 40_000,
      // the lists RUN_STATE_PLAN cuts to fit (run_health's own ten-per-kind bound is not a cut)
      cut: Object.keys(json).filter(
        (k) => k.endsWith('_more') && PLAN_LISTS.includes(k.slice(0, -'_more'.length)),
      ),
      params: json['params'],
      inProgress: (json['in_progress_steps'] as unknown[]).length,
      reclaimSteps: reclaims.map((e) => e.step),
      tail: elsewhere.at(-1),
      personReclaims: personLines.filter((l) => l.includes('RECLAIM ')).length,
      personTail: personLines.at(-1),
    }).toEqual({
      fits: true,
      cut: [],
      params: {},
      inProgress: 100,
      reclaimSteps: [
        'step_070',
        'step_071',
        'step_072',
        'step_073',
        'step_074',
        'step_075',
        'step_076',
        'step_077',
        'step_078',
        'step_079',
      ],
      tail: {
        verb: 'inspect',
        instruction: null,
        for: 'operator',
        reason: 'door_cannot_enact',
        human_readable: 'and 90 more held steps — get_run_state lists them.',
      },
      personReclaims: 10,
      personTail: `and 90 more held steps — INSPECT ${runId} lists them.`,
    });
  });
});
