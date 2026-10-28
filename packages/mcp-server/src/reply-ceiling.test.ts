// reply-ceiling.test.ts — #872 (b1): the reply ceiling's one composer law (`toolContentOf`'s fit
// loop) and the plans it runs — the envelope's (`next_actions` beyond the first, riding every
// envelope reply under `REPLY_PLAN`) and get_run_state's (its steps' detail, its skip details, the
// lists it acts on later, `next_actions`, then `params`). Synthetic replies through the real walk,
// unless the cell says a real handler. Beside each: (a) what turns it red; (b) what it prints on
// failure — keys, counts and sizes, never a value.
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  compileDisclosure,
  discloseReply,
  type ClassTable,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';
import { handleStartRun, START_RUN_TABLE } from './tools/start-run.js';
import {
  ENVELOPE_PLAN,
  MCP_ENVELOPE_TABLE,
  PERSON_BLOCK,
  REPLY_CEILING_CHARS,
  REPLY_PLAN,
  replyPlanOf,
  toolContentOf,
  type ReplyPlan,
} from './render-reply.js';
import { sseJsonStringify } from './sse-json.js';
import { RUN_STATE_PLAN, RUN_STATE_SUMMARY_TABLE } from './tools/get-run-state.js';
import { WORKFLOW_PROTOCOL_TABLE } from './tools/get-workflow-protocol.js';

const set = compileDisclosure([], {
  declared: 'resolved',
  audience: 'agent',
  environment: 'swept',
}).set;
const disclosureOf = (table: ClassTable) => ({ set, audience: 'agent' as const, table });

/** The agent's text block, parsed. */
const shownOf = (
  reply: Record<string, unknown> | string,
  table: ClassTable,
  plan?: ReplyPlan,
): { text: string; json: Record<string, unknown> } => {
  const text = toolContentOf(reply as Record<string, unknown>, disclosureOf(table), plan)
    .content[0]!.text;
  return { text, json: JSON.parse(text) as Record<string, unknown> };
};

/** The walked reply's size, as the composer measures it (M, the reply before any line). */
const sizeOf = (reply: Record<string, unknown>, table: ClassTable): number =>
  sseJsonStringify(discloseReply(reply, set, 'agent', table)).length;

/** A plan that counts its calls, delegating to `plan` (its own keys forwarded — correction 1, C3). */
const spied = (plan: ReplyPlan) => {
  const next = vi.fn(
    (r: Readonly<Record<string, unknown>>, s: Readonly<Record<string, unknown>>, o: number) =>
      plan.next(r, s, o),
  );
  return { plan: { keys: plan.keys, next } as ReplyPlan, next };
};

/** One step's detail in a run state's `steps`, about `size` characters when shown. */
const stepView = (i: number, size: number) => ({
  attempts: [{ attempt: 1, status: 'success', note: 'n'.repeat(Math.max(0, size - 90)) }],
  index: i,
});

/** A run state's head: what every get_run_state reply carries. */
const runState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  run_id: 'r-872',
  workflow_id: 'w-872',
  run_phase: 'running',
  terminal_state: false,
  completed_steps: [],
  in_progress_steps: [],
  failed_steps: [],
  skipped_steps: [],
  evidence_count: 0,
  last_step: null,
  created_at: '2026-10-28T00:00:00.000Z',
  updated_at: '2026-10-28T00:00:00.000Z',
  params: { a: 1 },
  next_actions: [],
  next_actions_status: 'ok',
  ...over,
});

const steps = (n: number, size: number) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`s${String(i).padStart(3, '0')}`, stepView(i, size)]),
  );

/** An agent step's next action, about `size` characters when shown. */
const action = (i: number, size: number) => ({
  instruction: { tool: 'execute_step', params: { run_id: 'r-872', command: `a${i}` } },
  human_readable: `Run step 'a${i}'. ${'h'.repeat(Math.max(0, size - 140))}`,
});

// correction 1 (C3): the overflow line's four arms, word for word.
const TEXT_LEAD = (m: number) =>
  `This reply was ${m.toLocaleString('en-US')} characters, past the 40,000-character ceiling; it is sent whole.`;
const GUARD_LEAD = (m: number, wayOut = '') =>
  `This reply was ${m.toLocaleString('en-US')} characters before this line, past the 40,000-character ceiling; nothing in this reply is shortened.${wayOut}`;
const FLOOR_LEAD = (m: number, n: number) =>
  `This reply was ${m.toLocaleString('en-US')} characters before this line, past the 40,000-character ceiling; cutting everything this reply can cut would still leave ${n.toLocaleString('en-US')}. Nothing was cut; tell the user.`;
const FIELD_LEAD = (m: number, field: string, n: number) =>
  `This reply was ${m.toLocaleString('en-US')} characters before this line, past the 40,000-character ceiling: ${field} alone is ${n.toLocaleString('en-US')}. No list was shortened for it.`;

describe('#872 (b1) B1 — the composer: one fit loop, the overflow line', () => {
  it('(i) a reply that fits is sent as it is: the plan is never asked', () => {
    const { plan, next } = spied(RUN_STATE_PLAN);
    const reply = runState({ steps: steps(5, 300) });
    const { text } = shownOf(reply, RUN_STATE_SUMMARY_TABLE, plan);
    // (a) red when the loop shrinks a reply that fits; (b) prints the call count and the size.
    expect({
      calls: next.mock.calls.length,
      same: text === sseJsonStringify(discloseReply(reply, set, 'agent', RUN_STATE_SUMMARY_TABLE)),
    }).toEqual({ calls: 0, same: true });
  });

  it('(ii) ~150 settled steps (~44 K): one cut fits it — steps_more the exact rest, next_cursor the last shown id', () => {
    const { plan, next } = spied(RUN_STATE_PLAN);
    const reply = runState({ steps: steps(150, 290) });
    const before = sizeOf(reply, RUN_STATE_SUMMARY_TABLE);
    const { text, json } = shownOf(reply, RUN_STATE_SUMMARY_TABLE, plan);
    const kept = Object.keys(json['steps'] as Record<string, unknown>);
    // (a) red when the cut overshoots or undershoots the ceiling, the count or the cursor is wrong,
    //     or a second cut was needed; (b) prints the sizes, the counts, the cursor and the calls.
    expect({
      before: before > REPLY_CEILING_CHARS,
      fits: text.length <= REPLY_CEILING_CHARS,
      more: json['steps_more'],
      cursor: json['next_cursor'],
      calls: next.mock.calls.length,
    }).toEqual({
      before: true,
      fits: true,
      more: 150 - kept.length,
      cursor: kept.at(-1),
      calls: 1,
    });
  });

  it('(iii) the fan-out shape: next_actions ~466 K, steps ~14 K → steps intact, next_actions cut with its exact count, one cut', () => {
    const { plan, next } = spied(RUN_STATE_PLAN);
    const reply = runState({
      steps: steps(48, 290),
      next_actions: Array.from({ length: 466 }, (_, i) => action(i, 1000)),
    });
    const { text, json } = shownOf(reply, RUN_STATE_SUMMARY_TABLE, plan);
    const shown = (json['next_actions'] as unknown[]).length;
    // (a) red when phase 1 picks a list that cannot close the gap alone (steps halved first); (b)
    //     prints the counts, the size and the calls.
    expect({
      steps: Object.keys(json['steps'] as Record<string, unknown>).length,
      stepsMore: json['steps_more'],
      fits: text.length <= REPLY_CEILING_CHARS,
      more: json['next_actions_more'],
      calls: next.mock.calls.length,
    }).toEqual({ steps: 48, stepsMore: undefined, fits: true, more: 466 - shown, calls: 1 });
  });

  it('(iv, viii) a 39 K prompt and five 1 K lists: every list at its floor is still over — the UNCUT reply and the floor arm, M and N measured', () => {
    const list = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ step: `l${i}`, note: 'x'.repeat(150) }));
    const reply = runState({
      next_actions: [{ ...action(0, 200), prompt: 'p'.repeat(39_000) }, action(1, 300)],
      steps: steps(5, 220),
      skip_details: Object.fromEntries(list(5).map((e) => [e.step, e])),
      engine_runnable: list(5),
      agent_refused: list(5),
      capability_blocks: list(5),
      params: { p: 'q'.repeat(900) },
    });
    const m = sizeOf(reply, RUN_STATE_SUMMARY_TABLE);
    // N: every list at its floor, measured on a copy built here (not by the plan under test).
    const floor = {
      ...reply,
      next_actions: (reply['next_actions'] as unknown[]).slice(0, 1),
      next_actions_more: 1,
      steps: Object.fromEntries(Object.entries(reply['steps'] as object).slice(0, 1)),
      steps_more: 4,
      next_cursor: 's000',
      skip_details: Object.fromEntries(Object.entries(reply['skip_details'] as object).slice(0, 1)),
      skip_details_more: 4,
      engine_runnable: (reply['engine_runnable'] as unknown[]).slice(0, 1),
      engine_runnable_more: 4,
      agent_refused: (reply['agent_refused'] as unknown[]).slice(0, 1),
      agent_refused_more: 4,
      capability_blocks: (reply['capability_blocks'] as unknown[]).slice(0, 1),
      capability_blocks_more: 4,
      params: { omitted: true, chars: JSON.stringify(reply['params']).length },
    };
    const n = sizeOf(floor, RUN_STATE_SUMMARY_TABLE);
    const { json } = shownOf(reply, RUN_STATE_SUMMARY_TABLE, RUN_STATE_PLAN);
    // (a) red when the floor-cut reply is sent, a list is cut, or M or N is not what was measured;
    //     (b) prints the sizes and every list's count.
    expect({
      over: n > REPLY_CEILING_CHARS,
      line: (json['warnings'] as string[])[0],
      counts: ['next_actions', 'engine_runnable', 'agent_refused', 'capability_blocks'].map(
        (k) => (json[k] as unknown[]).length,
      ),
      steps: Object.keys(json['steps'] as object).length,
      params: json['params'],
      marks: Object.keys(json).filter((k) => k.endsWith('_more') || k === 'next_cursor'),
    }).toEqual({
      over: true,
      line: FLOOR_LEAD(m, n),
      counts: [2, 5, 5, 5],
      steps: 5,
      params: reply['params'],
      marks: [],
    });
  });

  it('(v) a 41 K text reply gets the text arm as its first line', () => {
    const body = 't'.repeat(41_000);
    const text = toolContentOf(body, disclosureOf({})).content[0]!.text;
    // (a) red when a text reply over the ceiling leaves without its line, or with another arm's
    //     words; (b) prints the first line.
    expect(text.split('\n')[0]).toBe(TEXT_LEAD(41_000));
    expect(text.slice(text.indexOf('\n') + 1)).toBe(body);
  });

  it('(vi) phase 1 never picks a list whose cuttable size is 0 (one item); the next list that can close the gap is cut', () => {
    const plan = replyPlanOf([
      { kind: 'list', key: 'one', moreKey: 'one_more' },
      { kind: 'list', key: 'many', moreKey: 'many_more' },
    ]);
    const reply = {
      one: ['x'.repeat(30_000)],
      many: Array.from({ length: 40 }, () => 'y'.repeat(1_000)),
    };
    const shown = discloseReply(reply, set, 'agent', { one: 'fact', many: 'fact' });
    const cut = plan.next(reply, shown, 20_000)!;
    // (a) red when phase 1 picks a one-item list (nothing to shed); (b) prints the keys and counts.
    expect({
      one: (cut['one'] as unknown[]).length,
      oneMore: cut['one_more'],
      manyMore: typeof cut['many_more'],
    }).toEqual({
      one: 1,
      oneMore: undefined,
      manyMore: 'number',
    });
  });

  it('(vii, viii) the field arm on each carrier it reaches — prompt and input_schema on the envelope and on get_run_state, gate on the envelope; the LARGEST part wins', () => {
    const big = 'f'.repeat(40_100);
    const envelope = (first: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      command: 'execute_step',
      run_id: 'r-872',
      run_version: 1,
      status: 'ok',
      data: {},
      evidence: [],
      warnings: [],
      context_hint: 'Ready.',
      next_actions: [first, action(1, 400), action(2, 400)],
      [REPLY_PLAN]: ENVELOPE_PLAN,
      ...extra,
    });
    const schema = { type: 'object', properties: { x: { description: big } } };
    const cases: Array<[string, Record<string, unknown>, ClassTable, string]> = [
      [
        'envelope prompt',
        envelope({ ...action(0, 200), prompt: big }),
        MCP_ENVELOPE_TABLE,
        'next_actions[0].prompt',
      ],
      [
        'envelope input_schema',
        envelope({ ...action(0, 200), input_schema: schema }),
        MCP_ENVELOPE_TABLE,
        'next_actions[0].input_schema',
      ],
      [
        'envelope gate',
        envelope(action(0, 200), {
          gate: { gate_id: 'g', step_name: 's', choices: ['y'], display: big },
        }),
        MCP_ENVELOPE_TABLE,
        'gate',
      ],
      [
        // correction 1 (C3): the gate object is larger in place than the prompt, so it is named.
        'envelope prompt beside gate (the larger part)',
        envelope(
          { ...action(0, 200), prompt: big },
          { gate: { gate_id: 'g', step_name: 's', choices: ['y'], display: big } },
        ),
        MCP_ENVELOPE_TABLE,
        'gate',
      ],
      [
        'run state prompt',
        runState({ next_actions: [{ ...action(0, 200), prompt: big }, action(1, 400)] }),
        RUN_STATE_SUMMARY_TABLE,
        'next_actions[0].prompt',
      ],
      [
        'run state input_schema',
        runState({ next_actions: [{ ...action(0, 200), input_schema: schema }, action(1, 400)] }),
        RUN_STATE_SUMMARY_TABLE,
        'next_actions[0].input_schema',
      ],
    ];
    const got = cases.map(([name, reply, table, field]) => {
      const shown = discloseReply(reply, set, 'agent', table) as Record<string, unknown>;
      const m = sseJsonStringify(shown).length;
      const first = (shown['next_actions'] as Array<Record<string, unknown>>)[0]!;
      const value =
        field === 'gate' ? shown['gate'] : first[field.slice('next_actions[0].'.length)];
      const depth = field === 'gate' ? 1 : 3;
      const text = sseJsonStringify(value);
      const n = text.length + (text.split('\n').length - 1) * 2 * depth;
      const plan = table === RUN_STATE_SUMMARY_TABLE ? RUN_STATE_PLAN : undefined;
      const json = shownOf(reply, table, plan).json;
      return {
        name,
        line: (json['warnings'] as string[])[0] === FIELD_LEAD(m, field, n),
        uncut:
          (json['next_actions'] as unknown[]).length ===
          (reply['next_actions'] as unknown[]).length,
      };
    });
    // (a) red when an arm's words, its M or N, or its field are wrong, a smaller part is named
    //     before the largest, or a list is cut for a field no cut can shorten; (b) prints each
    //     case's booleans.
    expect(got).toEqual(cases.map(([name]) => ({ name, line: true, uncut: true })));
  });

  it('(ix) the person block is read once from the original: a cut reply keeps it unchanged as the second block', () => {
    const person = 'An operator answers with: realm run respond r-872 --choice approve';
    const reply = {
      command: 'start_run',
      run_id: 'r-872',
      run_version: 1,
      status: 'ok',
      data: {},
      evidence: [],
      warnings: [],
      context_hint: 'Ready.',
      next_actions: Array.from({ length: 80 }, (_, i) => action(i, 1000)),
      [REPLY_PLAN]: ENVELOPE_PLAN,
      [PERSON_BLOCK]: person,
    };
    const result = toolContentOf(reply, disclosureOf(MCP_ENVELOPE_TABLE));
    const json = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    // (a) red when the block is read from a cut copy or lost; (b) prints the block and the count.
    expect({
      cut: typeof json['next_actions_more'],
      blocks: result.content.length,
      person: result.content[1]?.text,
    }).toEqual({
      cut: 'number',
      blocks: 2,
      person,
    });
  });

  it('(x) a reply with no warnings key gets one created for the line, as its FIRST key — get_run_state (the field arm) and the protocol (the guard arm)', () => {
    const run = runState({ next_actions: [{ ...action(0, 200), prompt: 'f'.repeat(40_100) }] });
    const protocol = {
      workflow_id: 'w',
      name: 'w',
      steps: Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, description: 'd'.repeat(800) })),
      agent_steps_summary: [],
      rules: [],
      error_handling: '',
      quick_start: '',
    };
    const r = shownOf(run, RUN_STATE_SUMMARY_TABLE, RUN_STATE_PLAN).json;
    const p = shownOf(protocol, WORKFLOW_PROTOCOL_TABLE).json;
    const pm = sizeOf(protocol, WORKFLOW_PROTOCOL_TABLE);
    // (a) red when the line needs a warnings key the reply does not have, the created key is not
    //     first, or the protocol's line is not the guard arm; (b) prints the keys and the line.
    expect({
      run: 'warnings' in run === false && Array.isArray(r['warnings']),
      firstKeys: [Object.keys(r)[0], Object.keys(p)[0]],
      protocol: (p['warnings'] as string[])[0],
      steps: (p['steps'] as unknown[]).length,
      marks: Object.keys(p).filter((k) => k.endsWith('_more') || k === 'next_cursor'),
    }).toEqual({
      run: true,
      firstKeys: ['warnings', 'warnings'],
      protocol: GUARD_LEAD(pm),
      steps: 60,
      marks: [],
    });
  });
});

// ─── B2: a cut changes nothing but the cut list ──────────────────────────────────────────────────

/** `n` agent steps with a 1,500-character prompt each — their next actions pass the ceiling. */
const agents = (n: number, depends_on: string[] = []) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `a${String(i).padStart(2, '0')}`,
      {
        description: 'A.',
        execution: 'agent',
        depends_on,
        prompt: `Do ${i}. ${'p'.repeat(1_500)}`,
      },
    ]),
  );
const wf = (id: string, steps: Record<string, unknown>): WorkflowDefinition =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  }) as WorkflowDefinition;
const ROOTS = wf('b2-roots', agents(40));
const AFTER_HEAD = wf('b2-head', {
  head: { description: 'H.', execution: 'auto', depends_on: [] },
  ...agents(40, ['head']),
});
const AFTER_FIRST = wf('b2-first', {
  first: { description: 'F.', execution: 'agent', depends_on: [] },
  ...agents(40, ['first']),
});

async function door() {
  const dir = await mkdtemp(join(tmpdir(), 'realm-b2-872-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  for (const d of [ROOTS, AFTER_HEAD, AFTER_FIRST]) await workflowStore.register(d);
  const server = createRealmMcpServer({ runStore, workflowStore });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'b2-872', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return {
      size: raw.content[0]!.text.length,
      reply: JSON.parse(raw.content[0]!.text) as Record<string, unknown>,
    };
  };
  return { call, runStore, workflowStore };
}

/** Every key of the uncut walk but the cut list, compared byte for byte with the cut reply's. */
const besidesTheCut = (uncut: Record<string, unknown>, cut: Record<string, unknown>) =>
  Object.keys(uncut)
    .filter((k) => k !== 'next_actions')
    .filter((k) => JSON.stringify(cut[k]) !== JSON.stringify(uncut[k]));

describe('#872 (b1) B2 — a cut changes nothing but the cut list', () => {
  it('start_run (both paths, through the door): cut — deduped and command as the tool set them; REPLY_PLAN rides both spreads', async () => {
    const { call, runStore, workflowStore } = await door();
    const handBack = await call('start_run', { workflow_id: ROOTS.id });
    const afterStep = await call('start_run', { workflow_id: AFTER_HEAD.id });
    const lib = [
      await handleStartRun({ workflow_id: ROOTS.id }, { runStore, workflowStore }),
      await handleStartRun({ workflow_id: AFTER_HEAD.id }, { runStore, workflowStore }),
    ];
    // (a) red when a plan restores the envelope it closed over (deduped gone, command back to the
    //     engine's), the cut is missed, or the plan does not ride a spread; (b) prints the fields.
    expect(
      [handBack, afterStep].map(({ size, reply }) => ({
        fits: size <= REPLY_CEILING_CHARS,
        cut: typeof reply['next_actions_more'],
        deduped: reply['deduped'],
        command: reply['command'],
      })),
    ).toEqual([
      { fits: true, cut: 'number', deduped: false, command: 'start_run' },
      { fits: true, cut: 'number', deduped: false, command: 'start_run' },
    ]);
    expect(lib.map((r) => REPLY_PLAN in r)).toEqual([true, true]);
  });

  it('start_run (the reply the tool hands its composer): every key but next_actions byte-identical to the uncut walk; the first entry whole; the count exact', async () => {
    const { runStore, workflowStore } = await door();
    for (const id of [ROOTS.id, AFTER_HEAD.id]) {
      const reply = {
        ...(await handleStartRun({ workflow_id: id }, { runStore, workflowStore })),
        command: 'start_run',
      };
      const uncut = discloseReply(reply, set, 'agent', START_RUN_TABLE) as Record<string, unknown>;
      const cut = JSON.parse(
        toolContentOf(reply, disclosureOf(START_RUN_TABLE)).content[0]!.text,
      ) as Record<string, unknown>;
      const before = uncut['next_actions'] as unknown[];
      const after = cut['next_actions'] as unknown[];
      // (a) red when any other key changes, the first entry is cut, or the count is wrong; (b)
      //     prints the differing keys and the counts.
      expect({
        differ: besidesTheCut(uncut, cut).filter((k) => k !== 'next_actions_more'),
        first: JSON.stringify(after[0]) === JSON.stringify(before[0]),
        more: cut['next_actions_more'],
      }).toEqual({ differ: [], first: true, more: before.length - after.length });
    }
  });

  it('execute_step (through the door): data {} and evidence [] as the tool set them, the cut made', async () => {
    const { call, runStore } = await door();
    const { run } = await runStore.create({
      workflowId: AFTER_FIRST.id,
      workflowVersion: 1,
      params: {},
    });
    const { size, reply } = await call('execute_step', {
      run_id: run.id,
      command: 'first',
      params: {},
    });
    // (a) red when a plan restores the engine's data or evidence, or the cut is missed; (b) prints them.
    expect({
      fits: size <= REPLY_CEILING_CHARS,
      cut: typeof reply['next_actions_more'],
      data: reply['data'],
      evidence: reply['evidence'],
    }).toEqual({
      fits: true,
      cut: 'number',
      data: {},
      evidence: [],
    });
  });

  it('advance_run (through the door): continued_by, data {} and evidence [] as the tool set them, the cut made', async () => {
    const { call, runStore } = await door();
    const { run } = await runStore.create({
      workflowId: AFTER_HEAD.id,
      workflowVersion: 1,
      params: {},
    });
    const { size, reply } = await call('advance_run', { run_id: run.id });
    // (a) red when a plan drops continued_by or restores data or evidence; (b) prints them.
    expect({
      fits: size <= REPLY_CEILING_CHARS,
      cut: typeof reply['next_actions_more'],
      continued: 'continued_by' in reply,
      data: reply['data'],
      evidence: reply['evidence'],
    }).toEqual({
      fits: true,
      cut: 'number',
      continued: true,
      data: {},
      evidence: [],
    });
  });

  it('create_workflow (its reply as the tool hands it, inflated past the ceiling — through the door its next_actions hold one step): data.workflow_id, warnings and diagnostics kept', async () => {
    const reply = {
      command: 'create_workflow',
      run_id: 'r-872',
      run_version: 1,
      status: 'ok',
      data: { workflow_id: 'wf-872' },
      evidence: [],
      warnings: ['unknown key line', 'caveat line'],
      diagnostics: [{ code: 'UNKNOWN_KEY', key: 'k' }],
      context_hint: 'Created.',
      next_actions: Array.from({ length: 80 }, (_, i) => action(i, 1_000)),
      [REPLY_PLAN]: ENVELOPE_PLAN,
    };
    const uncut = discloseReply(reply, set, 'agent', MCP_ENVELOPE_TABLE) as Record<string, unknown>;
    const cut = JSON.parse(
      toolContentOf(reply, disclosureOf(MCP_ENVELOPE_TABLE)).content[0]!.text,
    ) as Record<string, unknown>;
    // (a) red when a cut touches data, warnings or diagnostics; (b) prints the differing keys.
    expect({
      differ: besidesTheCut(uncut, cut).filter((k) => k !== 'next_actions_more'),
      cut: typeof cut['next_actions_more'],
    }).toEqual({
      differ: [],
      cut: 'number',
    });
  });
});

// ─── B3: guard-only in (b1) ──────────────────────────────────────────────────────────────────────

describe('#872 (b1) B3 — guard-only: the protocol, the batch and list_workflows shorten nothing (the guard arm)', () => {
  /** The line's M: the reply without the line, as it was walked (`hadKey`: its `warnings` was there). */
  const withoutLine = (json: Record<string, unknown>, hadKey = false) => {
    const { warnings, ...rest } = json;
    const others = (warnings as string[]).slice(1);
    return sseJsonStringify(others.length > 0 || hadKey ? { ...rest, warnings: others } : rest)
      .length;
  };
  const marks = (json: Record<string, unknown>) =>
    Object.keys(json).filter((k) => k.endsWith('_more') || k === 'next_cursor');

  it('get_workflow_protocol on a 117-step definition (~300 K): every step, today’s bytes plus the guard arm', async () => {
    const { call, workflowStore } = await door();
    const big = wf(
      'b3-protocol',
      Object.fromEntries(
        Array.from({ length: 117 }, (_, i) => [
          `p${String(i).padStart(3, '0')}`,
          { description: `Step ${i}. ${'d'.repeat(2_500)}`, execution: 'agent', depends_on: [] },
        ]),
      ),
    );
    await workflowStore.register(big);
    const { reply } = await call('get_workflow_protocol', { workflow_id: big.id });
    const m = withoutLine(reply);
    // (a) red when a plan is given to the protocol (steps missing, a marker added) or the line is
    //     missing or wrong; (b) prints the counts, the marks and the line.
    expect({
      steps: (reply['steps'] as unknown[]).length,
      marks: marks(reply),
      over: m > REPLY_CEILING_CHARS,
      line: (reply['warnings'] as string[])[0],
      first: Object.keys(reply)[0],
    }).toEqual({
      steps: 117,
      marks: [],
      over: true,
      line: GUARD_LEAD(m),
      first: 'warnings',
    });
  });

  it('start_run_batch with 1,000 items: every item, the guard arm with the batch’s way out in a new top-level warnings, its first key', async () => {
    const { call } = await door();
    const { reply } = await call('start_run_batch', {
      workflow_id: ROOTS.id,
      items: Array.from({ length: 1000 }, () => ({ params: {} })),
      max_items: 1000,
    });
    const m = withoutLine(reply);
    // (a) red when the batch is cut, the line is missing, its way out is dropped, or the key is not
    //     first; (b) prints the counts and the line.
    expect({
      started: (reply['started'] as unknown[]).length,
      marks: marks(reply),
      line: (reply['warnings'] as string[])[0],
      first: Object.keys(reply)[0],
    }).toEqual({
      started: 1000,
      marks: [],
      line: GUARD_LEAD(m, ' Send fewer items per call.'),
      first: 'warnings',
    });
  }, 120_000);

  it('list_workflows with a registry past the ceiling: every workflow, the guard arm first in its warnings, its existing key moved first', async () => {
    const { call, workflowStore } = await door();
    for (let i = 0; i < 700; i += 1) {
      await workflowStore.register(
        wf(`b3-list-${String(i).padStart(4, '0')}-${'n'.repeat(40)}`, {
          s: { description: 'S.', execution: 'agent', depends_on: [] },
        }),
      );
    }
    const { reply } = await call('list_workflows', {});
    // list_workflows always carries warnings (empty here): the line joins it in place.
    const m = withoutLine(reply, true);
    // (a) red when the list is cut, the line is missing, or the existing key stays where it was;
    //     (b) prints the counts and the line.
    expect({
      listed: (reply['workflows'] as unknown[]).length >= 700,
      marks: marks(reply),
      line: (reply['warnings'] as string[])[0],
      first: Object.keys(reply)[0],
    }).toEqual({
      listed: true,
      marks: [],
      line: GUARD_LEAD(m),
      first: 'warnings',
    });
  }, 120_000);
});

// ─── B5: get_run_state's plan order ──────────────────────────────────────────────────────────────

describe("#872 (b1) B5 — get_run_state's plan: the order (correction 1, C1: steps last), the exact counts, params before steps", () => {
  const list = (n: number, size: number) =>
    Array.from({ length: n }, (_, i) => ({
      step: `e${String(i).padStart(3, '0')}`,
      note: 'x'.repeat(size),
    }));
  const marksOf = (json: Record<string, unknown>) =>
    Object.fromEntries(
      Object.keys(json)
        .filter((k) => k.endsWith('_more') || k === 'next_cursor')
        .map((k) => [k, json[k]]),
    );

  it('only steps can close the gap → only steps are cut', () => {
    const json = shownOf(
      runState({ steps: steps(160, 290), engine_runnable: list(20, 200) }),
      RUN_STATE_SUMMARY_TABLE,
      RUN_STATE_PLAN,
    ).json;
    // (a) red when a later list is cut too; (b) prints the marks.
    expect(Object.keys(marksOf(json)).sort()).toEqual(['next_cursor', 'steps_more']);
  });

  it('steps and an act-on-later list can each close it → the act-on-later list is cut, steps stay whole (C1: steps last)', () => {
    // Each list alone is under the ceiling and can close the gap alone (~30 K + ~28 K).
    const json = shownOf(
      runState({ steps: steps(90, 290), engine_runnable: list(120, 200) }),
      RUN_STATE_SUMMARY_TABLE,
      RUN_STATE_PLAN,
    ).json;
    const kept = (json['engine_runnable'] as unknown[]).length;
    // (a) red when steps are cut before a list the agent acts on later (#916's order); (b) prints
    //     the marks and counts.
    expect({ marks: marksOf(json), steps: Object.keys(json['steps'] as object).length }).toEqual({
      marks: { engine_runnable_more: 120 - kept },
      steps: 90,
    });
  });

  it('params: omitted in phase 1 before steps — steps could close the gap too, and stay whole; no byte of params kept', () => {
    // params (~30 K) and steps (~30 K) can each close the gap alone; params comes first.
    const params = { blob: 'P872'.repeat(7_500) };
    const reply = runState({ steps: steps(90, 290), engine_runnable: list(10, 200), params });
    const { text, json } = shownOf(reply, RUN_STATE_SUMMARY_TABLE, RUN_STATE_PLAN);
    // (a) red when steps are cut before params (#916's order), params is kept out of phase 1, or a
    //     prefix is kept; (b) prints the marks, the omitted form and a boolean.
    expect({
      marks: marksOf(json),
      params: json['params'],
      steps: Object.keys(json['steps'] as object).length,
      leaked: text.includes('P872P872'),
    }).toEqual({
      marks: {},
      params: { omitted: true, chars: JSON.stringify(params).length },
      steps: 90,
      leaked: false,
    });
  });

  it('phase 2 floors in C1’s order — the run’s lists, skip details, the act-on-later lists, next_actions, then params (45 K), and steps (~49 K) last; every count exact', () => {
    // Neither params nor steps can close the gap alone, even with every list before them at its
    // floor (each is over 40,000 with the head, the floors and the other): phase 2 reaches params.
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `d${String(i).padStart(3, '0')}-${'i'.repeat(36)}`);
    const reply = runState({
      completed_steps: ids(60),
      skip_details: Object.fromEntries(list(30, 200).map((e) => [e.step, e])),
      engine_runnable: list(30, 200),
      agent_refused: list(30, 200),
      capability_blocks: list(30, 200),
      next_actions: Array.from({ length: 10 }, (_, i) => action(i, 600)),
      params: { blob: 'q'.repeat(45_000) },
      steps: steps(150, 290),
    });
    const { text, json } = shownOf(reply, RUN_STATE_SUMMARY_TABLE, RUN_STATE_PLAN);
    const count = (k: string) =>
      Array.isArray(json[k])
        ? (json[k] as unknown[]).length
        : Object.keys(json[k] as object).length;
    // (a) red when params is omitted before a list ahead of it is at its floor, steps are cut before
    //     params, a list stops at more than one item, or a count is not exact; (b) prints the marks,
    //     the counts and the size.
    expect({
      fits: text.length <= REPLY_CEILING_CHARS,
      params: json['params'],
      floors: [
        'completed_steps',
        'skip_details',
        'engine_runnable',
        'agent_refused',
        'capability_blocks',
        'next_actions',
      ].map((k) => [count(k), json[`${k}_more`]]),
      steps: count('steps') + (json['steps_more'] as number),
      cursor: json['next_cursor'] === Object.keys(json['steps'] as object).at(-1),
    }).toEqual({
      fits: true,
      params: { omitted: true, chars: JSON.stringify(reply['params']).length },
      floors: [
        [1, 59],
        [1, 29],
        [1, 29],
        [1, 29],
        [1, 29],
        [1, 9],
      ],
      steps: 150,
      cursor: true,
    });
  });
});
