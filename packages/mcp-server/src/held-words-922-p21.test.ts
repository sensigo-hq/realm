// held-words-922-p21.test.ts — #922 P2-1 (prompt fix-922-p2-1-held-words.md, checks 1–10): every
// sentence an agent reads about a held step says that step's state, from core's one held-words table
// (`HELD_WORDS`, R13). An agent is told to wait only for a step that can still finish; freeing a live
// step always comes with the "runs twice" warning (B, b7f72a42); nothing says a program died (rule 10).
//
// `get_run_state` has no `context_hint`, so the agent's sentence is read from `advance_run`'s reply
// ("Run '<id>': nothing ran." + the sentence) and from `execute_step`'s. The runs are real: an
// in-memory store on a settable clock, claims written as a store writes them. This file is NOT
// `docs-922-p2.test.ts`: only #922 P2-2 creates that one (it releases P1a's cell).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  HELD_WORDS,
  InMemoryTraceBufferStore,
  LEASE_NOT_KNOWN_HERE,
  leaseCheckCondition,
  leaseCheckPhrase,
  reclaimConditionWords,
  type HeldState,
  type UncheckedLease,
  type HeldWordsState,
  type WayOn,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';
import { generateProtocol } from './protocol/generator.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

const START = new Date('2030-01-01T12:00:00.000Z');
const plus = (ms: number): string => new Date(START.getTime() + ms).toISOString();
const SINCE = plus(-3_600_000);
const PAST = plus(-60_000);
const AHEAD = plus(60_000);

type Reply = Record<string, unknown>;
type Claim = { deadline: string | null; since?: string } | 'no_record';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'reference');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
/** A docs sentence this file's cell executes (guardrail 9): red when the page no longer says it. */
const claim = (page: string, sentence: string): void =>
  expect(
    flat(readFileSync(join(DOCS, page), 'utf8')).includes(sentence),
    `${page} no longer says: ${sentence}`,
  ).toBe(true);

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

const agent = () => ({
  description: 'An agent step.',
  execution: 'agent' as const,
  depends_on: [],
});

/** A route that renders a person's ways as commands, as `realm mcp` injects one. */
const ROUTE = {
  render: (way: WayOn) => (way.verb === 'reclaim' ? `RECLAIM ${way.step}` : null),
  source: { kind: 'default' as const, ref: 'held-words-922-p21' },
};

async function door(def: WorkflowDefinition, opts: { keepsClaims?: boolean } = {}) {
  const clock = settableClock(START);
  const runStore = new InMemoryStore({ clock });
  if (opts.keepsClaims === false) {
    Object.defineProperty(runStore, 'persistsClaims', { value: false });
  }
  const h = await makeTempHome();
  handles.push(h);
  await h.stores.workflowStore.register(def);
  const server = createRealmMcpServer({
    gateAnswers: 'permitted',
    runStore,
    workflowStore: h.stores.workflowStore,
    traceBufferStore: new InMemoryTraceBufferStore(runStore),
    failedAttemptStore: h.stores.failedAttemptStore,
    operatorRoute: ROUTE,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'held-words-922-p21', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<{ json: Reply; person?: string }> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string; annotations?: { audience?: string[] } }>;
    };
    const person = raw.content.find((c) => c.annotations?.audience?.includes('user'))?.text;
    return {
      json: JSON.parse(raw.content[0]!.text) as Reply,
      ...(person !== undefined ? { person } : {}),
    };
  };
  const start = async (): Promise<string> =>
    (await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} })).record.id;
  /** The steps held elsewhere, each with its claim as a store writes it (or none on record). */
  const hold = async (runId: string, claims: Record<string, Claim>): Promise<void> => {
    const { record } = await runStore.get(runId);
    const written: Record<string, unknown> = { ...record.claims };
    for (const [step, c] of Object.entries(claims)) {
      if (c !== 'no_record') written[step] = { token: `other-${step}`, ...c };
    }
    await runStore.update({
      ...record,
      in_progress_steps: [...new Set([...record.in_progress_steps, ...Object.keys(claims)])],
      claims: written as NonNullable<typeof record.claims>,
    });
  };
  const hint = async (runId: string): Promise<string> =>
    String((await call('advance_run', { run_id: runId })).json['context_hint']);
  return { call, clock, start, hold, hint };
}

const NOT_DECLARED = 'It is not declared idempotent, so running it again may repeat its effects.';
const nothingRan = (runId: string): string => `Run '${runId}': nothing ran. No step is ready: `;
/** The elsewhere entry a reply lists for a step's reclaim way. */
const elsewhereOf = (r: Reply, step: string): string | undefined =>
  (r['elsewhere'] as Array<{ verb: string; step?: string; human_readable: string }>).find(
    (e) => e.verb === 'reclaim' && e.step === step,
  )?.human_readable;

describe('#922 P2-1 — check 1, the bug’s words: a run whose only blocker is a held step past its deadline', () => {
  it('advance_run says the deadline passed and to tell the user, never "wait"; get_run_state’s elsewhere and person block lead with the past line', async () => {
    claim(
      'mcp/tools.md',
      "every step it waits on is held by a claim whose deadline has passed, or whose lease no program held when it was checked (`report_to_user`; `No step is ready: '<step>' was claimed and its deadline passed at <time>; no result is recorded for it. Tell the user: a person can free it.`, or, for a lease no program held, `No step is ready: '<step>' was claimed, and no program held the claim's lease when it was checked; no result is recorded for it. Tell the user: a person can free it.`, then, for a step not declared idempotent, `It is not declared idempotent, so running it again may repeat its effects.`)",
    );
    claim(
      'mcp/tools.md',
      'as `report_to_user` (nothing can be called and the run is open: a step cannot run, or every step it waits on is held by a claim whose deadline has passed, or whose lease no program held when it was checked)',
    );
    claim(
      'mcp/run-state-and-health.md',
      'Or every step it waits on is held by a claim whose deadline has passed, or whose lease no program held when it was checked (`report_to_user`): no result is recorded for them, and a person can free each one (both added after version 0.50.0).',
    );
    claim(
      'mcp/run-state-and-health.md',
      'else `report_to_user` (a step cannot run, or every step it waits on is held by a claim whose deadline has passed, or whose lease no program held when it was checked).',
    );
    // Correction 1 (RV-02): the version notes of P2-1's sentences, in each page's own form.
    claim(
      'mcp/tools.md',
      "the `agent_action` words after version 0.47.0; a held step whose deadline has passed, and each held step's state, after version 0.50.0.",
    );
    claim(
      'mcp/run-state-and-health.md',
      'Added after version 0.47.0; a held step whose deadline has passed after version 0.50.0.',
    );
    const d = await door(workflow('p21-c1', { a: agent() }));
    const runId = await d.start();
    await d.hold(runId, { a: { deadline: PAST, since: SINCE } });
    const advanced = (await d.call('advance_run', { run_id: runId })).json;
    const state = await d.call('get_run_state', { run_id: runId });
    const words = `'a' was claimed and its deadline passed at ${PAST}; no result is recorded for it. Tell the user: a person can free it. ${NOT_DECLARED}`;
    // (a) red when the held branch is the old one ("in flight elsewhere — wait for it"), or the
    //     past state reads as another; (b) prints the hint, the action and the two operator lines.
    expect({
      hint: advanced['context_hint'],
      saysWait: /wait/i.test(String(advanced['context_hint'])),
      action: advanced['agent_action'],
      until: advanced['until'] ?? null,
      elsewhere: elsewhereOf(state.json, 'a'),
      person: state.person,
    }).toEqual({
      hint: `${nothingRan(runId)}${words}`,
      saysWait: false,
      action: 'report_to_user',
      until: null,
      elsewhere: `An operator can free step 'a', outside this conversation. Its deadline passed at ${PAST}; no result is recorded for it. ${NOT_DECLARED}`,
      person: `An operator can free step 'a', outside this conversation. Its deadline passed at ${PAST}; no result is recorded for it. ${NOT_DECLARED} The operator's command: RECLAIM a`,
    });
  });
});

describe('#922 P2-1 — check 2, S-1: in every ahead unit, "can free" appears if and only if "runs twice" does', () => {
  it('the agent clause (one, and a group), the by-name hint, the elsewhere entry and the person-block line', async () => {
    claim(
      'mcp/tools.md',
      "or, while its deadline is ahead, `'<step>' is held; its deadline is ahead (<time>). Wait for it. A person can free it, but if its program is still running, the step runs twice.`",
    );
    const d = await door(workflow('p21-c2', { a: agent() }));
    const one = await d.start();
    await d.hold(one, { a: { deadline: AHEAD, since: SINCE } });
    const d2 = await door(workflow('p21-c2b', { a: agent(), b: agent() }));
    const two = await d2.start();
    await d2.hold(two, {
      a: { deadline: AHEAD, since: SINCE },
      b: { deadline: plus(30_000), since: SINCE },
    });
    const byName = (await d.call('execute_step', { run_id: one, command: 'a', params: {} })).json;
    const state = await d.call('get_run_state', { run_id: one });
    const units = {
      agentOne: (await d.hint(one)).slice(nothingRan(one).length),
      agentGroup: (await d2.hint(two)).slice(nothingRan(two).length),
      byName: String(byName['context_hint']),
      elsewhere: elsewhereOf(state.json, 'a') ?? '',
      person: (state.person ?? '').split('\n').find((l) => l.includes("step 'a'")) ?? '',
    };
    const both = (u: string) => ({ canFree: /can free/i.test(u), runsTwice: /runs twice/.test(u) });
    // (a) red when either half is dropped from any ahead unit; (b) prints each unit's two facts.
    expect(Object.fromEntries(Object.entries(units).map(([k, u]) => [k, both(u)]))).toEqual({
      agentOne: { canFree: true, runsTwice: true },
      agentGroup: { canFree: true, runsTwice: true },
      byName: { canFree: true, runsTwice: true },
      elsewhere: { canFree: true, runsTwice: true },
      person: { canFree: true, runsTwice: true },
    });
    // The words themselves (a: red when a word changes; b: prints them).
    expect([units.agentOne, units.agentGroup, units.byName]).toEqual([
      `'a' is held; its deadline is ahead (${AHEAD}). Wait for it. A person can free it, but if its program is still running, the step runs twice.`,
      `'a', 'b' are held; their deadlines are ahead (the earliest at ${plus(30_000)}). Wait for them. A person can free them, but if a program is still running, its step runs twice.`,
      `Step 'a' cannot be called now: it is held; its deadline is ahead (${AHEAD}) — a person can free it, but if its program is still running, the step runs twice.`,
    ]);
  });
});

describe('#922 P2-1 — check 3, each other state on advance_run’s reply', () => {
  it('unknown age, unreadable, no claim record, not stamped, and a store that keeps no claims — one step, and (correction 1, RD-11) two', async () => {
    claim(
      'mcp/tools.md',
      "`'<step>' has been held since <time> by a claim with no deadline; wait for it. If its program has stopped, a person can free it.`",
    );
    claim(
      'mcp/tools.md',
      'or as `await` (a held step that can still finish, or a question handed to the person)',
    );
    claim(
      'run-record-and-export.md',
      // Q1 (#592) f2: the row now says why a deadline is null.
      "| `deadline` | When the claim's time runs out, or `null` when Realm set no time limit for the step; `deadline_absent` then says why.",
    );
    const words = async (claims: Record<string, Claim>, keepsClaims = true) => {
      const d = await door(
        workflow(
          `p21-c3-${Math.random().toString(36).slice(2)}`,
          Object.fromEntries(Object.keys(claims).map((s) => [s, agent()])),
        ),
        {
          keepsClaims,
        },
      );
      const runId = await d.start();
      await d.hold(runId, claims);
      const r = (await d.call('advance_run', { run_id: runId })).json;
      return {
        hint: String(r['context_hint']).slice(nothingRan(runId).length),
        action: r['agent_action'],
      };
    };
    // (a) red when one state reads as another, or the no-claims store says "a person can free";
    //     (b) prints each state's words and action.
    expect({
      unknown: await words({ a: { deadline: null, since: SINCE } }),
      unreadable: await words({ a: { deadline: 'not-a-time', since: SINCE } }),
      noRecord: await words({ a: 'no_record' }),
      notStamped: await words({ a: { deadline: null } }),
      noClaimsStore: await words({ a: 'no_record' }, false),
      // Correction 1 (RD-11): the plural of each, through advance_run; the longest-held instant is
      // the second step's, so a first-member pick is caught.
      unreadableTwo: await words({
        a: { deadline: 'not-a-time', since: SINCE },
        b: { deadline: 'not-a-time-either', since: plus(-7_200_000) },
      }),
      noRecordTwo: await words({ a: 'no_record', b: 'no_record' }),
      noClaimsStoreTwo: await words({ a: 'no_record', b: 'no_record' }, false),
    }).toEqual({
      unknown: {
        hint: `'a' has been held since ${SINCE} by a claim with no deadline; wait for it. If its program has stopped, a person can free it.`,
        action: 'await',
      },
      unreadable: {
        hint: `'a' has been held since ${SINCE} by a claim whose deadline cannot be read; wait for it. If its program has stopped, a person can free it.`,
        action: 'await',
      },
      noRecord: {
        hint: "'a' is held, since an unknown time, with no claim record; wait for it. If its program has stopped, a person can free it.",
        action: 'await',
      },
      notStamped: {
        hint: "'a' has been held since an unknown time by a claim with no deadline; wait for it. If its program has stopped, a person can free it.",
        action: 'await',
      },
      noClaimsStore: {
        hint: "'a' is held; this store keeps no claim records, so a person cannot free it with reclaim. Wait for it.",
        action: 'await',
      },
      unreadableTwo: {
        hint: `'a', 'b' have been held, the longest since ${plus(-7_200_000)}, by claims whose deadlines cannot be read; wait for them. If their programs have stopped, a person can free them.`,
        action: 'await',
      },
      noRecordTwo: {
        hint: "'a', 'b' are held, since an unknown time, with no claim record; wait for them. If their programs have stopped, a person can free them.",
        action: 'await',
      },
      noClaimsStoreTwo: {
        hint: "'a', 'b' are held; this store keeps no claim records, so a person cannot free them with reclaim. Wait for them.",
        action: 'await',
      },
    });
  });
});

describe('#922 P2-1 — check 4, a mix of ahead and past on advance_run’s reply', () => {
  it('both groups, the past one first; agent_action stays await (GROUNDING: P1a’s)', async () => {
    claim(
      'mcp/tools.md',
      "`No step is ready: ` and each held step's state when a step is held by another call (one clause for each group of steps in the same state, the steps whose deadline passed first: `'<step>' was claimed and its deadline passed at <time>; no result is recorded for it. Tell the user: a person can free it.`, then, for a step not declared idempotent, `It is not declared idempotent, so running it again may repeat its effects.`; added after version 0.50.0).",
    );
    claim(
      'mcp/run-state-and-health.md',
      '`await` when it waits only on held steps and one of them can still finish (its deadline is ahead, or it has none that can be read)',
    );
    const d = await door(workflow('p21-c4', { q: agent(), p: agent() }));
    const runId = await d.start();
    await d.hold(runId, {
      q: { deadline: AHEAD, since: SINCE },
      p: { deadline: PAST, since: SINCE },
    });
    const r = (await d.call('advance_run', { run_id: runId })).json;
    // (a) red when the order is ahead → past; (b) prints the hint and the action.
    expect([r['context_hint'], r['agent_action']]).toEqual([
      `${nothingRan(runId)}'p' was claimed and its deadline passed at ${PAST}; no result is recorded for it. Tell the user: a person can free it. ${NOT_DECLARED} 'q' is held; its deadline is ahead (${AHEAD}). Wait for it. A person can free it, but if its program is still running, the step runs twice.`,
      'await',
    ]);
  });
});

describe('#922 P2-1 — check 5, the cap: 100 held steps on advance_run’s reply', () => {
  it('one clause per group, ten names then "and N more", each group’s instant by its rule', async () => {
    const names = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);
    const past = names('p', 40);
    const unknown = names('u', 30);
    const ahead = names('h', 30);
    const steps = Object.fromEntries([...past, ...unknown, ...ahead].map((s) => [s, agent()]));
    const d = await door(workflow('p21-c5', steps));
    const runId = await d.start();
    // The earliest instant of each group is its LAST member's, so a first-member pick is caught.
    const claims: Record<string, Claim> = {};
    past.forEach((s, i) => (claims[s] = { deadline: plus(-60_000 - i * 1_000), since: SINCE }));
    unknown.forEach((s, i) => (claims[s] = { deadline: null, since: plus(-60_000 - i * 1_000) }));
    ahead.forEach((s, i) => (claims[s] = { deadline: plus(600_000 - i * 1_000), since: SINCE }));
    await d.hold(runId, claims);
    const raw = (await d.call('advance_run', { run_id: runId })).json;
    const hint = String(raw['context_hint']);
    const count = (re: RegExp) => (hint.match(re) ?? []).length;
    const quoted = (xs: string[]) => xs.map((s) => `'${s}'`).join(', ');
    // (a) red when groups merge or split, the cap is lifted, or a group's instant is not its
    //     earliest; (b) prints the counts and which group sentences are found.
    expect({
      pastClauses: count(/were claimed and their deadlines passed/g),
      unknownClauses: count(/have been held, the longest since/g),
      aheadClauses: count(/are held; their deadlines are ahead/g),
      past: hint.includes(
        `${quoted(past.slice(0, 10))} and 30 more were claimed and their deadlines passed, the earliest at ${plus(-60_000 - 39_000)};`,
      ),
      unknown: hint.includes(
        `${quoted(unknown.slice(0, 10))} and 20 more have been held, the longest since ${plus(-60_000 - 29_000)}, by claims with no deadline;`,
      ),
      ahead: hint.includes(
        `${quoted(ahead.slice(0, 10))} and 20 more are held; their deadlines are ahead (the earliest at ${plus(600_000 - 29_000)}).`,
      ),
      rerun: hint.includes(
        'They are not declared idempotent, so running them again may repeat their effects.',
      ),
      // GROUNDING (P1a's): the reply fits under the 40,000 ceiling with no plan cut.
      fits: JSON.stringify(raw).length < 40_000,
    }).toEqual({
      pastClauses: 1,
      unknownClauses: 1,
      aheadClauses: 1,
      past: true,
      unknown: true,
      ahead: true,
      rerun: true,
      fits: true,
    });
  });
});

describe('#922 P2-1 — check 6, by name: execute_step on a held step, for each state', () => {
  it('core’s reason, then its state’s clause; the reply ends there', async () => {
    const byName = async (claims: Record<string, Claim>, keepsClaims = true) => {
      const d = await door(
        workflow(`p21-c6-${Math.random().toString(36).slice(2)}`, { a: agent() }),
        {
          keepsClaims,
        },
      );
      const runId = await d.start();
      await d.hold(runId, claims);
      return String(
        (await d.call('execute_step', { run_id: runId, command: 'a', params: {} })).json[
          'context_hint'
        ],
      );
    };
    const at = "Step 'a' cannot be called now: ";
    // (a) red when the old reason comes back, or the opening is dropped (the state is then said
    //     twice: the reason, then the agent's sentence); (b) prints each hint.
    expect({
      ahead: await byName({ a: { deadline: AHEAD, since: SINCE } }),
      past: await byName({ a: { deadline: PAST, since: SINCE } }),
      unknown: await byName({ a: { deadline: null, since: SINCE } }),
      unreadable: await byName({ a: { deadline: 'not-a-time', since: SINCE } }),
      noRecord: await byName({ a: 'no_record' }),
      noClaimsStore: await byName({ a: 'no_record' }, false),
    }).toEqual({
      ahead: `${at}it is held; its deadline is ahead (${AHEAD}) — a person can free it, but if its program is still running, the step runs twice.`,
      past: `${at}it was claimed and its deadline passed at ${PAST}; no result is recorded for it — a person can free it. ${NOT_DECLARED}`,
      unknown: `${at}it is held by a claim with no deadline — if its program has stopped, a person can free it.`,
      unreadable: `${at}it is held by a claim whose deadline cannot be read — if its program has stopped, a person can free it.`,
      noRecord: `${at}it is held, with no claim record — if its program has stopped, a person can free it.`,
      noClaimsStore: `${at}it is held, with no claim record — this store keeps no claim records, so a person cannot free it with reclaim.`,
    });
  });
});

describe('#922 P2-1 — check 7, the long loop (walk WK-07)', () => {
  it('a step completing after a sibling’s deadline says "Step \'<x>\' completed." and the past words, never "Waiting for other steps to complete."', async () => {
    const d = await door(workflow('p21-c7', { a: agent(), b: agent() }));
    const runId = await d.start();
    await d.hold(runId, { b: { deadline: AHEAD, since: SINCE } });
    await d.clock.set(new Date(START.getTime() + 120_000));
    const r = (await d.call('execute_step', { run_id: runId, command: 'a', params: {} })).json;
    // (a) red when the completed step's reply leaves `names_next` unset with a held step (core's
    //     "Waiting for other steps to complete."); (b) prints the hint.
    expect(r['context_hint']).toBe(
      `Step 'a' completed. No step is ready: 'b' was claimed and its deadline passed at ${AHEAD}; no result is recorded for it. Tell the user: a person can free it. ${NOT_DECLARED}`,
    );
  });
});

describe('#922 P2-1 — check 8, walk O1: the past line on an elsewhere entry and a person-block line', () => {
  it('a past entry leads its condition words with the line; ahead and unknown entries are as before', async () => {
    claim('glossary.md', 'To free a held step, so that it can be run again.');
    claim(
      'glossary.md',
      'A claim whose deadline has passed: no result is recorded for its step, and the step can be reclaimed.',
    );
    const d = await door(workflow('p21-c8', { p: agent(), h: agent(), u: agent() }));
    const runId = await d.start();
    await d.hold(runId, {
      p: { deadline: PAST, since: SINCE },
      h: { deadline: AHEAD, since: SINCE },
      u: { deadline: null, since: SINCE },
    });
    const state = await d.call('get_run_state', { run_id: runId });
    const line = (step: string) =>
      (state.person ?? '').split('\n').find((l) => l.includes(`step '${step}'`));
    const pastLine = `Its deadline passed at ${PAST}; no result is recorded for it.`;
    // (a) red when the past line is removed, or put on an entry whose deadline is ahead or unknown;
    //     (b) prints each entry and line.
    expect({
      p: elsewhereOf(state.json, 'p'),
      pLine: line('p'),
      h: elsewhereOf(state.json, 'h')?.includes('deadline passed'),
      u: elsewhereOf(state.json, 'u')?.includes('deadline passed'),
    }).toEqual({
      p: `An operator can free step 'p', outside this conversation. ${pastLine} ${NOT_DECLARED}`,
      pLine: `An operator can free step 'p', outside this conversation. ${pastLine} ${NOT_DECLARED} The operator's command: RECLAIM p`,
      h: false,
      u: false,
    });
  });
});

describe('#922 P2-1 — check 9, the protocol texts', () => {
  it('report_to_user and await name the held step past its deadline', () => {
    const text = generateProtocol(workflow('p21-c9', { a: agent() })).error_handling;
    // #729 CW-5a: and the lease's two cases, now every `realm agent` drive's claim names a lease —
    // not held reads as past its deadline (report_to_user), held is waited on: their replies are
    // held-lease-cw3a's cells (a claim taken through claimStepForDrive, as realm agent takes it).
    // (a) red when either text is the old one; (b) prints which is found.
    expect({
      report: text['report_to_user']?.includes(
        'It also comes on an `ok` reply when nothing can be called and only a person can change that: a step cannot run (`context_hint` names it and why, and ends with the way out when the workflow must be corrected), or every step it waits on is held by a claim whose deadline has passed, or whose lease no program held when it was checked (a person can free each one) — tell the user.',
      ),
      await: text['await']?.endsWith(
        "A step whose claim's deadline has passed, or whose claim's lease no program held when it was checked, is never waited on: it never sets until, and when every step a reply waits on is so, the reply says report_to_user. A step whose claim's lease its program held is waited on.",
      ),
    }).toEqual({ report: true, await: true });
  });
});

describe('#922 P2-1 — check 10, rule 10: no liveness verdict', () => {
  const VERDICT = /\b(died|dead|gone|is down)\b/i;
  it('the whole held-words table and the protocol texts', () => {
    const states: HeldWordsState[] = [
      'ahead',
      'past',
      'unknown_age',
      'unreadable',
      'no_claim_record',
      'store_keeps_no_claims',
      // #729 CW-3a: the two lease states
      'lease_held',
      'lease_not_held',
    ];
    const held: HeldState[] = [
      { state: 'ahead', deadline: AHEAD },
      { state: 'past', deadline: PAST },
      { state: 'unknown_age' },
      { state: 'unreadable' },
      { state: 'no_claim_record' },
      { state: 'lease_held' },
      { state: 'lease_not_held' },
    ];
    const table = [
      ...states.flatMap((s) => [
        HELD_WORDS.agent(s, "'a'", false, SINCE),
        HELD_WORDS.agent(s, "'a', 'b'", true, SINCE),
      ]),
      ...states.map((s) => HELD_WORDS.clause(s)),
      ...held.map((s) => HELD_WORDS.reason(s)),
      HELD_WORDS.rerun('not_declared', false),
      HELD_WORDS.rerun('not_declared', true),
      HELD_WORDS.rerun('definition_absent', false),
      HELD_WORDS.rerun('definition_absent', true),
      HELD_WORDS.pastLine(PAST),
    ];
    const protocol = Object.values(
      generateProtocol(workflow('p21-c10', { a: agent() })).error_handling,
    );
    // (a) red when a held sentence or a protocol text says a program died, is dead, gone or down;
    //     (b) prints each such text.
    expect([...table, ...protocol].filter((t) => VERDICT.test(t ?? ''))).toEqual([]);
  });

  it('#729 CW-3a: the lease states’ words — the four tables, the lease_held condition and the not-held line — hold no word of the deny-list', () => {
    // The prompt's deny-list, for the words CW-3a writes for `lease_held` and `lease_not_held` only.
    const DENY =
      /\b(died|dead|alive|live runner|live driver|presumed|probably|likely|unknown age|deadline)\b/i;
    const words = (state: 'lease_held' | 'lease_not_held'): string[] => [
      HELD_WORDS.agent(state, "'a'", false, SINCE),
      HELD_WORDS.agent(state, "'a', 'b'", true, SINCE),
      HELD_WORDS.reason({ state }),
      HELD_WORDS.clause(state),
      HELD_WORDS.cli(state, 'a', SINCE),
    ];
    const held = [...words('lease_held'), reclaimConditionWords({ code: 'lease_held' })!];
    const notHeld = [...words('lease_not_held'), HELD_WORDS.notHeldLine];
    // (a) red when a lease state's words say a program died, is alive, presumed or likely, name an
    //     unknown age or a deadline, or a not-held one says "wait for it"; (b) prints each such text.
    expect({
      deny: [...held, ...notHeld].filter((t) => DENY.test(t)),
      wait: notHeld.filter((t) => /wait for it/i.test(t)),
    }).toEqual({ deny: [], wait: [] });
  });

  it('#729 CW-4a: the lease-check words — the six phrases, their condition form, the fixed sentence and each door’s sentence built from them — hold no word of the deny-list', () => {
    const DENY =
      /\b(died|dead|alive|live runner|live driver|presumed|probably|likely|unknown age|deadline)\b/i;
    const unchecked: UncheckedLease[] = [
      { state: 'absent' },
      ...(['not_checked', 'cannot_open', 'not_a_lease', 'permission', 'io_error'] as const).map(
        (reason) => ({ state: 'unknown' as const, reason }),
      ),
    ];
    const texts = unchecked.flatMap((lease) => [
      leaseCheckPhrase(lease),
      leaseCheckCondition(lease),
      HELD_WORDS.agent('unknown_age', "'a'", false, SINCE, lease),
      HELD_WORDS.agent('unknown_age', "'a', 'b'", true, SINCE, lease),
      `${HELD_WORDS.reason({ state: 'unknown_age' }, lease)}${HELD_WORDS.clause('unknown_age')}`,
      reclaimConditionWords({ code: 'override_claim_unknown_age', state: 'unknown_age' }, lease)!,
    ]);
    // (a) red when one of these says a program died, is alive, presumed or likely, or names an
    //     unknown age or a deadline; (b) prints each such text. None of them is a not-held sentence.
    expect({
      count: texts.length,
      deny: [...texts, LEASE_NOT_KNOWN_HERE].filter((t) => DENY.test(t)),
    }).toEqual({ count: 36, deny: [] });
  });

  it('the definition_absent past sentences, pinned at the table (no reply reaches them: advance_run loads the definition first)', () => {
    // (a) red when the words change; (b) prints them.
    expect([
      HELD_WORDS.rerun('definition_absent', false),
      HELD_WORDS.rerun('definition_absent', true),
    ]).toEqual([
      'Its workflow definition is not available here, so whether running it again is safe is not known.',
      'Their workflow definition is not available here, so whether running them again is safe is not known.',
    ]);
  });

  it('the pages this unit changed say no program died or is gone', () => {
    const pages = [
      'mcp/tools.md',
      'mcp/run-state-and-health.md',
      'glossary.md',
      'run-record-and-export.md',
      'library/run-and-drive-a-run.md',
    ];
    claim('glossary.md', "such as a step whose claim's deadline has passed.");
    claim(
      'mcp/run-state-and-health.md',
      "A step was started, did not finish, and is past its time, or no program held its claim's lease when it was checked (added after version 0.50.0). |",
    );
    // (a) red when one of these pages calls a holder dead or gone again; (b) prints the page and
    //     the matching words.
    expect(
      pages.flatMap((p) =>
        (
          flat(readFileSync(join(DOCS, p), 'utf8')).match(
            /[^.|]*\b(died|dead|gone away|presumed dead)\b[^.|]*/gi,
          ) ?? []
        ).map((m) => `${p}: ${m.trim()}`),
      ),
    ).toEqual([]);
  });
});
