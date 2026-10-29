// reply-ceiling-correction-2-872.test.ts — #872 (b1) correction 2, through the door (an in-memory
// MCP client on a server with registered definitions). A (A1–A3): the asked steps are cut LAST —
// every earlier part that can still shed goes first. C (C1, C2): when nothing can make a planned
// reply fit, the FLOOR-CUT reply is sent, with the field or floor line. D (D1): the input refusals'
// ways — ten, then a count. Beside each: (a) the change that turns it red; (b) what it prints on
// failure — sizes, counts, step and key names, never a value.
//
// M (the uncut walked reply's size) is measured on the reply each tool hands the composer: the
// composer is wrapped below to record what it was given and what it returned, and is otherwise the
// real one.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  JsonFileStore,
  JsonWorkflowStore,
  discloseReply,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';
import {
  REPLY_CEILING_CHARS,
  REPLY_PLAN,
  type ReplyPlan,
  type ToolDisclosure,
} from './render-reply.js';
import { sseJsonStringify } from './sse-json.js';

type Reply = Record<string, unknown>;
type Handed = { reply: unknown; disclosure: ToolDisclosure; plan?: ReplyPlan; text: string };
type Sent = { size: number; json: Reply; text: string };

/** What each tool handed the composer, and the text it returned. */
const handed = vi.hoisted(() => [] as Handed[]);
vi.mock('./render-reply.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./render-reply.js')>();
  return {
    ...real,
    toolContentOf: (...args: Parameters<typeof real.toolContentOf>) => {
      const result = real.toolContentOf(...args);
      handed.push({
        reply: args[0],
        disclosure: args[1],
        ...(args[2] !== undefined ? { plan: args[2] } : {}),
        text: result.content[0]!.text,
      });
      return result;
    },
  };
});

const C = REPLY_CEILING_CHARS;
const n = (x: number) => x.toLocaleString('en-US');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const flat = (t: string) => t.replace(/\s+/g, ' ');
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const LEAST =
  'Everything Realm can shorten in it is cut to its least (each list to one item, with the count of the rest)';
const FIELD_LEAD = (m: number, field: string, p: number, floor: number) =>
  `This reply was ${n(m)} characters, past the 40,000-character ceiling: ${field} alone is ${n(p)}. ${LEAST}; without this line it is now ${n(floor)}.`;
const FLOOR_LEAD = (m: number, floor: number) =>
  `This reply was ${n(m)} characters, past the 40,000-character ceiling. ${LEAST}; without this line it is now ${n(floor)}. Tell the user.`;

/** A value's size where it sits: at `depth` (2 spaces each) — measured here, not by the composer. */
const inPlace = (value: unknown, depth: number): number => {
  const text = sseJsonStringify(value);
  return text.length + (text.split('\n').length - 1) * 2 * depth;
};
const countOf = (list: unknown): number | undefined =>
  Array.isArray(list)
    ? list.length
    : list !== null && typeof list === 'object'
      ? Object.keys(list).length
      : undefined;

async function door(definitions: WorkflowDefinition[], registry?: ExtensionRegistry) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-c2-872-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  for (const d of definitions) await workflowStore.register(d);
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    ...(registry !== undefined ? { registry } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c2-872', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<Sent> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    const text = raw.content[0]!.text;
    return { size: text.length, json: JSON.parse(text) as Reply, text };
  };
  return { call };
}

const wf = (id: string, stepsOf: Record<string, unknown>): WorkflowDefinition =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: stepsOf,
  }) as WorkflowDefinition;
const ids = (prefix: string, count: number, width: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(width, '0')}`);

/** fan300: 300 agent steps, as crown-872's (the walk kit's `fan300`). */
const fan300 = () =>
  wf(
    'fan300',
    Object.fromEntries(
      ids('f', 300, 3).map((s) => [s, { description: 'Answer this step.', execution: 'agent' }]),
    ),
  );

type Call = Awaited<ReturnType<typeof door>>['call'];

/** Every page of `get_run_state` for `base`, following `next_cursor` (at most 50 pages). */
async function pagesOf(call: Call, runId: string, base: Reply) {
  const pages: Sent[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await call('get_run_state', {
      run_id: runId,
      ...base,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    pages.push(page);
    cursor = page.json['next_cursor'] as string | undefined;
    if (cursor === undefined) break;
  }
  const seen = pages.flatMap((p) => Object.keys((p.json['steps'] as object) ?? {}));
  return {
    calls: pages.length,
    seen,
    sizes: pages.map((p) => p.size),
    perPage: pages.map((p) => Object.keys((p.json['steps'] as object) ?? {}).length),
    pages,
  };
}

/**
 * The reply the composer was handed for the text `sent`: its walk's size (M), whether the walk has
 * `warnings` (so N can be measured on the sent reply without the line), and every list its plan
 * holds with more than one item — the counts the floor-cut reply must state.
 */
function handedFor(sent: Sent) {
  const entry = handed.find((h) => h.text === sent.text)!;
  const reply = entry.reply as Reply & { [REPLY_PLAN]?: ReplyPlan };
  const plan = entry.plan ?? reply[REPLY_PLAN];
  const walked = discloseReply(
    reply,
    entry.disclosure.set,
    entry.disclosure.audience,
    entry.disclosure.table,
  ) as Reply;
  const lists = Object.fromEntries(
    Object.entries(walked)
      .filter(([k, v]) => plan?.keys.includes(`${k}_more`) === true && (countOf(v) ?? 0) > 1)
      .map(([k, v]) => [k, countOf(v)!]),
  );
  return { m: sseJsonStringify(walked).length, hadWarnings: 'warnings' in walked, lists };
}

/** N: the sent reply without its line (and without `warnings` when the walk had none). */
function floorSizeOf(json: Reply, hadWarnings: boolean): number {
  const { warnings, ...rest } = json;
  const others = (warnings as unknown[]).slice(1);
  return sseJsonStringify(hadWarnings ? { warnings: others, ...rest } : rest).length;
}

/** Each list the floor-cut reply holds: [items kept, its `_more`]. */
const floored = (json: Reply, lists: Record<string, number>) =>
  Object.fromEntries(Object.keys(lists).map((k) => [k, [countOf(json[k]), json[`${k}_more`]]]));
const atFloor = (lists: Record<string, number>) =>
  Object.fromEntries(Object.entries(lists).map(([k, count]) => [k, [1, count - 1]]));

// ─── A: the asked steps are cut last ─────────────────────────────────────────────────────────────

describe('#872 (b1) correction 2 (A) — the asked steps are cut LAST: every earlier part that can shed goes first', () => {
  it('A1: fan300, 150 settled, a 36,000-character params — every settled step read in at most 2 calls, with include_steps and with step_names; every reply at or under the ceiling', async () => {
    const { call } = await door([fan300()]);
    const runId = String(
      (
        await call('start_run', {
          workflow_id: 'fan300',
          params: { blob: 'k'.repeat(36_000) },
        })
      ).json['run_id'],
    );
    const settled = ids('f', 150, 3);
    for (const s of settled) {
      await call('execute_step', { run_id: runId, command: s, params: { done: true } });
    }
    const include = await pagesOf(call, runId, { include_steps: true });
    const names = await pagesOf(call, runId, { step_names: settled });
    const read = (r: typeof include) => ({
      calls: r.calls <= 2,
      seen: r.seen.length === 150 && new Set(r.seen).size === 150,
      fit: r.sizes.every((s) => s <= C),
    });
    // (a) red when the payload rule is removed (correction 1's phase 1 cuts `steps` while params
    //     goes whole: 13 calls, 872-WA-04), a page passes the ceiling, or a settled step is missed;
    //     (b) prints the calls, the steps per page and the sizes.
    expect({
      include: { ...read(include), perPage: include.perPage, sizes: include.sizes },
      names: { ...read(names), perPage: names.perPage, sizes: names.sizes },
    }).toEqual({
      include: {
        calls: true,
        seen: true,
        fit: true,
        perPage: include.perPage,
        sizes: include.sizes,
      },
      names: { calls: true, seen: true, fit: true, perPage: names.perPage, sizes: names.sizes },
    });
  }, 180_000);

  it('A2: 150 settled agent steps beside 100 auto steps whose handlers are missing (WA-04’s run), params {} — the settled steps read in at most 2 calls; params {} is never omitted', async () => {
    const agents = ids('f', 150, 3);
    const autos = ids('a', 100, 3);
    const { call } = await door(
      [
        wf('mixer', {
          ...Object.fromEntries(
            agents.map((s) => [s, { description: 'Answer this step.', execution: 'agent' }]),
          ),
          ...Object.fromEntries(
            autos.map((s, i) => [
              s,
              {
                description: 'Auto step.',
                execution: 'auto',
                handler: `h_missing_${i}`,
                depends_on: ['f149'],
              },
            ]),
          ),
        }),
      ],
      new ExtensionRegistry(),
    );
    const runId = String(
      (await call('start_run', { workflow_id: 'mixer', params: {} })).json['run_id'],
    );
    for (const s of agents) {
      await call('execute_step', { run_id: runId, command: s, params: { done: true } });
    }
    const include = await pagesOf(call, runId, { include_steps: true });
    const first = include.pages[0]!.json;
    // (a) red when the payload rule is removed (`steps` cut while `engine_runnable` goes whole:
    //     4 calls, 872-WA-04), a settled step is missed, or `params: {}` is omitted (omitting it
    //     adds characters — "when that is shorter"); (b) prints the calls, the steps per page, the
    //     sizes, the first page's counts and each page's params.
    expect({
      calls: include.calls <= 2,
      settled: agents.every((s) => include.seen.includes(s)),
      fit: include.sizes.every((s) => s <= C),
      perPage: include.perPage,
      sizes: include.sizes,
      firstCounts: [first['engine_runnable_more'], first['completed_steps_more']],
      params: include.pages.map((p) => JSON.stringify(p.json['params'])),
    }).toEqual({
      calls: true,
      settled: true,
      fit: true,
      perPage: include.perPage,
      sizes: include.sizes,
      firstCounts: [first['engine_runnable_more'], first['completed_steps_more']],
      params: include.pages.map(() => '{}'),
    });
  }, 180_000);

  it('A3: an earlier list that alone closes the gap (WA-03) — next_actions cut to the largest count that fits; completed_steps and the 22 asked steps whole', async () => {
    const { call } = await door([fan300()]);
    const runId = String(
      (await call('start_run', { workflow_id: 'fan300', params: {} })).json['run_id'],
    );
    const settled = ids('f', 150, 3);
    for (const s of settled) {
      await call('execute_step', { run_id: runId, command: s, params: { done: true } });
    }
    const { size, json } = await call('get_run_state', {
      run_id: runId,
      step_names: settled.slice(0, 22),
    });
    // (a) red when `payload` also marks next_actions (completed_steps is then floored first), the
    //     steps are cut, or next_actions keeps fewer than fit; (b) prints the size and the counts.
    // Verify-first: 62 + 88 on this in-memory server (the walk saw 61 + 89 through `realm mcp`,
    // whose replies carry a few more characters — 872-WA-03); pinned as measured here.
    expect({
      fits: size <= C,
      completed: [(json['completed_steps'] as unknown[]).length, json['completed_steps_more']],
      actions: [(json['next_actions'] as unknown[]).length, json['next_actions_more']],
      steps: [Object.keys(json['steps'] as object).length, json['steps_more'], json['next_cursor']],
    }).toEqual({
      fits: true,
      completed: [150, undefined],
      actions: [62, 88],
      steps: [22, undefined, undefined],
    });
  }, 180_000);
});

// ─── C: the floor-cut reply when nothing can make a planned reply fit ────────────────────────────

describe('#872 (b1) correction 2 (C) — the field and floor arms send the FLOOR-CUT reply', () => {
  it('C1 (the field arm): 1,000 agent steps, the first a 41,000-character prompt, 60,000 characters of params — start_run, get_run_state and execute_step (on another step) each send the floor-cut reply; M, P and N exact; every list at one item with its count; params omitted on get_run_state', async () => {
    handed.length = 0;
    const steps = ids('s', 1000, 4);
    const { call } = await door([
      wf(
        'fbig1000',
        Object.fromEntries(
          steps.map((s, i) => [
            s,
            {
              description: 'Answer this step.',
              execution: 'agent',
              ...(i === 0 ? { prompt: 'P'.repeat(41_000) } : {}),
            },
          ]),
        ),
      ),
    ]);
    const started = await call('start_run', {
      workflow_id: 'fbig1000',
      params: { blob: 'x'.repeat(60_000) },
    });
    const runId = String(started.json['run_id']);
    const state = await call('get_run_state', { run_id: runId });
    const executed = await call('execute_step', {
      run_id: runId,
      command: 's0001',
      params: { done: true },
    });
    const field = 'next_actions[0].prompt';
    const got = Object.fromEntries(
      (
        [
          ['start_run', started],
          ['get_run_state', state],
          ['execute_step', executed],
        ] as const
      ).map(([tool, sent]) => {
        const { m, hadWarnings, lists } = handedFor(sent);
        const actions = sent.json['next_actions'] as Array<Record<string, unknown>>;
        const p = inPlace(actions[0]!['prompt'], 3);
        const floor = floorSizeOf(sent.json, hadWarnings);
        return [
          tool,
          {
            line: (sent.json['warnings'] as string[])[0] === FIELD_LEAD(m, field, p, floor),
            first: Object.keys(sent.json)[0],
            sizes: { m, p, floor, sent: sent.size },
            lists: floored(sent.json, lists),
            expected: atFloor(lists),
            params: JSON.stringify(sent.json['params'])?.slice(0, 40),
          },
        ];
      }),
    );
    // (a) red when the uncut reply is sent (correction 1: about 577,000, 872-WA-10), a list is not
    //     at its floor, M, P or N is not the measured size, or params goes whole; (b) prints, per
    //     tool, the sizes, each list's kept items and count, and params' omitted form (a size).
    const shape = (tool: keyof typeof got) => ({
      line: got[tool]!.line,
      first: got[tool]!.first,
      lists: got[tool]!.lists,
      floorUnder: got[tool]!.sizes.floor < 45_000,
      p: got[tool]!.sizes.p,
      params: got[tool]!.params,
    });
    expect({
      start_run: shape('start_run'),
      get_run_state: shape('get_run_state'),
      execute_step: shape('execute_step'),
      sizes: [got['start_run']!.sizes, got['get_run_state']!.sizes, got['execute_step']!.sizes],
    }).toEqual({
      start_run: {
        line: true,
        first: 'warnings',
        lists: got['start_run']!.expected,
        floorUnder: true,
        p: 41_002,
        params: undefined,
      },
      get_run_state: {
        line: true,
        first: 'warnings',
        lists: got['get_run_state']!.expected,
        floorUnder: true,
        p: 41_002,
        params: '{"omitted":true,"chars":60011}',
      },
      execute_step: {
        line: true,
        first: 'warnings',
        lists: got['execute_step']!.expected,
        floorUnder: true,
        p: 41_002,
        params: undefined,
      },
      sizes: [got['start_run']!.sizes, got['get_run_state']!.sizes, got['execute_step']!.sizes],
    });
    // The lists the floor cuts, by name (verify-first: next_actions on each, 1,000 then 999).
    expect([
      got['start_run']!.expected,
      got['get_run_state']!.expected,
      got['execute_step']!.expected,
    ]).toEqual([
      { next_actions: [1, 999] },
      { next_actions: [1, 999] },
      { next_actions: [1, 998] },
    ]);
  }, 180_000);

  it('C2 (the floor arm): 30 parallel agent steps with 39,000-character prompts — start_run sends the floor-cut reply with the floor line; M and N exact', async () => {
    handed.length = 0;
    const steps = ids('p', 30, 2);
    const { call } = await door([
      wf(
        'f30x39k',
        Object.fromEntries(
          steps.map((s) => [
            s,
            { description: 'Answer this step.', execution: 'agent', prompt: 'Q'.repeat(39_000) },
          ]),
        ),
      ),
    ]);
    const sent = await call('start_run', { workflow_id: 'f30x39k', params: {} });
    const { m, hadWarnings, lists } = handedFor(sent);
    const floor = floorSizeOf(sent.json, hadWarnings);
    // (a) red when the uncut reply is sent (correction 1: 1,186,331, 872-WA-11), the arm is not
    //     the floor's, or N is not the floor-cut reply's size; (b) prints the sizes and the lists.
    expect({
      line: (sent.json['warnings'] as string[])[0] === FLOOR_LEAD(m, floor),
      first: Object.keys(sent.json)[0],
      lists: floored(sent.json, lists),
      sizes: { m, floor, sent: sent.size, floorOver: floor > C },
    }).toEqual({
      line: true,
      first: 'warnings',
      lists: { next_actions: [1, 29] },
      sizes: { m, floor, sent: sent.size, floorOver: true },
    });
  }, 180_000);
});

// ─── D: the input refusals' ways — ten, then a count ─────────────────────────────────────────────

describe('#872 (b1) correction 2 (D) — the ways for steps refused for their input: ten, then a count', () => {
  it('D1: 11 steps whose input_map reads its own run parameter — ten ways, then "for 1 more step, see engine_runnable and agent_refused in get_run_state"; tools.md says so', async () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', { id: 'h', execute: async () => ({ data: {} }) });
    const steps = ids('x', 11, 2);
    const { call } = await door(
      [
        wf(
          'd1-ways',
          Object.fromEntries(
            steps.map((s, i) => [
              s,
              {
                description: 'Mapped step.',
                execution: 'auto',
                handler: 'h',
                input_map: { n: `run.params.q${String(i).padStart(2, '0')}` },
                input_schema: { type: 'object', required: ['n'] },
              },
            ]),
          ),
        ),
      ],
      registry,
    );
    const started = (await call('start_run', { workflow_id: 'd1-ways', params: {} })).json;
    const advanced = (await call('advance_run', { run_id: started['run_id'] })).json;
    const ways = (hint: string) => ({
      ways: steps.map((s, i) =>
        hint
          .toLowerCase()
          .includes(
            `for '${s}', start a run with params that fit (its param 'q${String(i).padStart(2, '0')}'), or correct its input_map or its input_schema and register the workflow again`,
          ),
      ),
      tail: hint.includes(
        '; for 1 more step, see engine_runnable and agent_refused in get_run_state; ',
      ),
    });
    // (a) red when the tail is removed (the 11th step's way silently dropped), or the ways are not
    //     bounded at ten; (b) prints which steps' ways are present and the tail's presence.
    const expected = { ways: steps.map((_, i) => i < 10), tail: true };
    expect({
      start_run: ways(String(started['context_hint'])),
      advance_run: ways(String(advanced['context_hint'])),
    }).toEqual({ start_run: expected, advance_run: expected });
    claim(
      'docs/reference/mcp/tools.md',
      "When one is refused for its input, steps whose way is the same share it — at most ten ways, each naming three steps and how many more, then `for <k> more steps, see engine_runnable and agent_refused in get_run_state` — then the run's once:",
    );
    claim(
      'docs/reference/mcp/tools.md',
      'and, for steps refused for their input, one way for each group of steps that share it — at most ten, then a count.',
    );
  }, 60_000);
});
