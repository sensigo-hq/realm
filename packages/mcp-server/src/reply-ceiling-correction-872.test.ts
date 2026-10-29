// reply-ceiling-correction-872.test.ts — #872 (b1) correction 1: the composer's fit made true.
// AC2 (C2): phase 1 keeps the LARGEST count that fits. AC3 (C3): the overflow line — one arm per
// reply, the first that holds (text, guard, field, floor), each true of its reply, and `warnings` the
// first key. HC4 (H4): get_run_state's run lists in its plan, in C1's order. HC6 (H6): the envelope's
// lists in its plan, and `blocked_reason.eligible_steps` bounded by construction. Synthetic replies
// through the real walk unless a cell says the door. Beside each: (a) the change that turns it red;
// (b) what it prints on failure — keys, counts, sizes and lines, never a value.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  JsonFileStore,
  JsonWorkflowStore,
  WorkflowError,
  buildPreExecutionErrorEnvelope,
  compileDisclosure,
  discloseReply,
  type ClassTable,
  type EvidenceSnapshot,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';
import {
  ENVELOPE_PLAN,
  MCP_ENVELOPE_TABLE,
  REPLY_CEILING_CHARS,
  REPLY_PLAN,
  renderReply,
  replyPlanOf,
  toolContentOf,
  type ReplyPlan,
} from './render-reply.js';
import { sseJsonStringify } from './sse-json.js';
import { RUN_STATE_PLAN, RUN_STATE_SUMMARY_TABLE } from './tools/get-run-state.js';

const set = compileDisclosure([], {
  declared: 'resolved',
  audience: 'agent',
  environment: 'swept',
}).set;
const disclosureOf = (table: ClassTable) => ({ set, audience: 'agent' as const, table });
type Reply = Record<string, unknown>;

/** The agent's text block, parsed. */
const shownOf = (
  reply: Reply | string,
  table: ClassTable,
  plan?: ReplyPlan,
): { text: string; json: Reply } => {
  const text = toolContentOf(reply as Reply, disclosureOf(table), plan).content[0]!.text;
  return { text, json: JSON.parse(text) as Reply };
};

/** The walked reply. */
const walked = (reply: Reply, table: ClassTable): Reply =>
  discloseReply(reply, set, 'agent', table) as Reply;

/** The walked reply's size (M, the reply before any line). */
const sizeOf = (reply: Reply, table: ClassTable): number =>
  sseJsonStringify(walked(reply, table)).length;

/** A value's size where it sits: at `depth` (2 spaces each) — measured here, not by the composer. */
const inPlace = (value: unknown, depth: number): number => {
  const text = sseJsonStringify(value);
  return text.length + (text.split('\n').length - 1) * 2 * depth;
};

const C = REPLY_CEILING_CHARS;
const n = (x: number) => x.toLocaleString('en-US');
const GUARD_LEAD = (m: number, wayOut = '') =>
  `This reply was ${n(m)} characters before this line, past the 40,000-character ceiling; nothing in this reply is shortened.${wayOut}`;
// correction 2 (C): the field and floor arms send the floor-cut reply; N is its size before the line.
const LEAST =
  'Everything Realm can shorten in it is cut to its least (each list to one item, with the count of the rest)';
const FIELD_LEAD = (m: number, field: string, size: number, floor: number) =>
  `This reply was ${n(m)} characters, past the 40,000-character ceiling: ${field} alone is ${n(size)}. ${LEAST}; without this line it is now ${n(floor)}.`;
const FLOOR_LEAD = (m: number, floor: number) =>
  `This reply was ${n(m)} characters, past the 40,000-character ceiling. ${LEAST}; without this line it is now ${n(floor)}. Tell the user.`;

/** A run state's head: what every get_run_state reply carries. */
const runState = (over: Reply = {}): Reply => ({
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

/** One step's detail in a run state's `steps`, about `size` characters when shown. */
const stepView = (i: number, size: number) => ({
  attempts: [{ attempt: 1, status: 'success', note: 'n'.repeat(Math.max(0, size - 90)) }],
  index: i,
});
const steps = (count: number, size: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`s${String(i).padStart(3, '0')}`, stepView(i, size)]),
  );

/** An agent step's next action, about `size` characters when shown. */
const action = (i: number, size: number) => ({
  instruction: { tool: 'execute_step', params: { run_id: 'r-872', command: `a${i}` } },
  human_readable: `Run step 'a${i}'. ${'h'.repeat(Math.max(0, size - 140))}`,
});

/** An envelope reply as a tool hands it to the composer, carrying the envelope's plan. */
const envelope = (over: Reply = {}): Reply => ({
  command: 'execute_step',
  run_id: 'r-872',
  run_version: 1,
  status: 'ok',
  data: {},
  evidence: [],
  context_hint: 'Ready.',
  next_actions: [action(0, 300)],
  [REPLY_PLAN]: ENVELOPE_PLAN,
  ...over,
});

const firstKey = (json: Reply) => Object.keys(json)[0];

// ─── AC2: the largest count that fits ────────────────────────────────────────────────────────────

describe('#872 (b1) correction 1 AC2 (C2) — phase 1 keeps the largest count that fits', () => {
  it('the B1 (iii) shape (next_actions ~466 K, steps ~14 K): the kept count fits, and one more would not', () => {
    const reply = runState({
      steps: steps(48, 290),
      next_actions: Array.from({ length: 466 }, (_, i) => action(i, 1000)),
    });
    const { text, json } = shownOf(reply, RUN_STATE_SUMMARY_TABLE, RUN_STATE_PLAN);
    const k = (json['next_actions'] as unknown[]).length;
    const plusOne = {
      ...reply,
      next_actions: (reply['next_actions'] as unknown[]).slice(0, k + 1),
      next_actions_more: 466 - k - 1,
    };
    // (a) red when a smaller count is kept (halving: one more would still fit), or the kept count
    //     does not fit; (b) prints the count, the sizes and the count left out.
    expect({
      fits: text.length <= C,
      more: json['next_actions_more'],
      plusOneOver: sizeOf(plusOne, RUN_STATE_SUMMARY_TABLE) > C,
      steps: Object.keys(json['steps'] as object).length,
    }).toEqual({ fits: true, more: 466 - k, plusOneOver: true, steps: 48 });
  });
});

// ─── AC3: the overflow line ──────────────────────────────────────────────────────────────────────

describe('#872 (b1) correction 1 AC3 (C3) — the overflow line: one arm per reply, true in every case', () => {
  it('TEXT: a 40,000-character text reply is sent as it is; 40,001 gets the text arm as its own first line, the text whole after it', () => {
    const at = toolContentOf('t'.repeat(C), disclosureOf({})).content[0]!.text;
    const over = toolContentOf('t'.repeat(C + 1), disclosureOf({})).content[0]!.text;
    // (a) red when a reply at the ceiling gets a line, one over it leaves without, or another arm's
    //     words are used; (b) prints the sizes and the first line.
    expect({
      at: at.length,
      first: over.split('\n')[0],
      rest: over.slice(over.indexOf('\n') + 1).length,
    }).toEqual({
      at: C,
      first: `This reply was ${n(C + 1)} characters, past the 40,000-character ceiling; it is sent whole.`,
      rest: C + 1,
    });
  });

  it('GUARD: a plan-less error reply (the shape get_run_state’s error path hands the composer) → the guard arm, warnings created as its first key', () => {
    const rendered = renderReply(
      buildPreExecutionErrorEnvelope(
        'get_run_state',
        'r-872',
        0,
        new WorkflowError('e'.repeat(41_000), {
          code: 'ENGINE_INTERNAL',
          category: 'ENGINE',
          agentAction: 'report_to_user',
          retryable: false,
        }),
        'An error occurred while loading run state.',
      ),
      {},
    );
    const reply = { ...rendered.envelope };
    const m = sizeOf(reply, MCP_ENVELOPE_TABLE);
    const { json } = shownOf(reply, MCP_ENVELOPE_TABLE);
    // (a) red when a plan-less reply gets the floor arm (N = M, #916's false claim), the field arm,
    //     or no line; (b) prints the first key and the line.
    expect({
      planless: REPLY_PLAN in reply,
      first: firstKey(json),
      line: (json['warnings'] as string[])[0],
    }).toEqual({ planless: false, first: 'warnings', line: GUARD_LEAD(m) });
  });

  it('FIELD: context_hint, pending_gate and next_actions[0].human_readable — each named when it alone is over, the floor-cut reply sent (correction 2, C)', () => {
    const big = 'f'.repeat(40_100);
    const cases: Array<[string, Reply, ClassTable, string, (shown: Reply) => number]> = [
      [
        'context_hint',
        envelope({ context_hint: big, next_actions: [action(0, 300), action(1, 300)] }),
        MCP_ENVELOPE_TABLE,
        'context_hint',
        (shown) => inPlace(shown['context_hint'], 1),
      ],
      [
        'pending_gate',
        runState({
          pending_gate: {
            gate_id: 'g',
            step_name: 's',
            choices: ['y', 'n'],
            opened_at: '2026-10-28T00:00:00.000Z',
            resolved_message: big,
          },
          next_actions: [action(0, 300), action(1, 300)],
        }),
        RUN_STATE_SUMMARY_TABLE,
        'pending_gate',
        (shown) => inPlace(shown['pending_gate'], 1),
      ],
      [
        'next_actions[0].human_readable',
        envelope({
          next_actions: [{ ...action(0, 300), human_readable: big }, action(1, 300)],
        }),
        MCP_ENVELOPE_TABLE,
        'next_actions[0].human_readable',
        (shown) => inPlace((shown['next_actions'] as Reply[])[0]!['human_readable'], 3),
      ],
    ];
    const got = cases.map(([name, reply, table, field, size]) => {
      const shown = walked(reply, table);
      const m = sseJsonStringify(shown).length;
      // N: the floor-cut reply, built here — `next_actions` at one item with its count (a run
      // state's `params: { a: 1 }` stays: omitting it would add characters).
      const floor = sizeOf(
        {
          ...reply,
          next_actions: (reply['next_actions'] as unknown[]).slice(0, 1),
          next_actions_more: 1,
        },
        table,
      );
      const plan = table === RUN_STATE_SUMMARY_TABLE ? RUN_STATE_PLAN : undefined;
      const { json } = shownOf(reply, table, plan);
      return {
        name,
        line: (json['warnings'] as string[])[0] === FIELD_LEAD(m, field, size(shown), floor),
        first: firstKey(json),
        floored: [(json['next_actions'] as unknown[]).length, json['next_actions_more']],
      };
    });
    // (a) red when only #916's three fixed fields are measured (no line names these parts), the
    //     uncut reply is sent (correction 1), or the key is not first; (b) prints each case.
    expect(got).toEqual(
      cases.map(([name]) => ({ name, line: true, first: 'warnings', floored: [1, 1] })),
    );
  });

  it('FIELD (the door): a 1,000-item batch failing params_schema — VALIDATION_BATCH_ITEMS names error_details; nothing in it can be cut, so the floor-cut reply is the whole one (N = M)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-ac3-872-'));
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    await workflowStore.register({
      id: 'ac3-batch',
      name: 'ac3-batch',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      params_schema: {
        type: 'object',
        required: ['ticket'],
        properties: { ticket: { type: 'integer' } },
      },
      steps: { s: { description: 'S.', execution: 'agent', depends_on: [] } },
    } as WorkflowDefinition);
    const server = createRealmMcpServer({
      runStore: new JsonFileStore(join(dir, 'runs')),
      workflowStore,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'ac3-872', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const raw = (await client.callTool({
      name: 'start_run_batch',
      arguments: {
        workflow_id: 'ac3-batch',
        items: Array.from({ length: 1000 }, () => ({ params: {} })),
        max_items: 1000,
      },
    })) as { content: Array<{ text: string }> };
    const json = JSON.parse(raw.content[0]!.text) as Reply;
    // M: the reply without the line — the error envelope always carries `warnings` (empty here).
    const { warnings, ...rest } = json;
    const m = sseJsonStringify({ ...rest, warnings: (warnings as string[]).slice(1) }).length;
    // (a) red when the floor arm claims what one item per list would leave (#916: N 146,462 while
    //     error_details is the part over), the line is missing, or a part is cut; (b) prints the
    //     code, the line and the counts' keys.
    expect({
      code: json['error_code'],
      first: firstKey(json),
      line: (warnings as string[])[0],
      cut: Object.keys(json).filter((k) => k.endsWith('_more')),
    }).toEqual({
      code: 'VALIDATION_BATCH_ITEMS',
      first: 'warnings',
      line: FIELD_LEAD(m, 'error_details', inPlace(json['error_details'], 1), m),
      cut: [],
    });
  });

  it('FIELD: the LARGEST of two oversized parts is named (pending_gate beside context_hint); on a tie, the first in key order', () => {
    const reply = runState({
      context_hint: 'c'.repeat(40_500),
      pending_gate: {
        gate_id: 'g',
        step_name: 's',
        choices: ['y'],
        opened_at: '2026-10-28T00:00:00.000Z',
        resolved_message: 'q'.repeat(44_000),
      },
    });
    const shown = walked(reply, { ...RUN_STATE_SUMMARY_TABLE, context_hint: 'bounded' });
    const big = shownOf(
      reply,
      { ...RUN_STATE_SUMMARY_TABLE, context_hint: 'bounded' },
      RUN_STATE_PLAN,
    ).json;
    const tiePlan = replyPlanOf([{ kind: 'list', key: 'l', moreKey: 'l_more' }]);
    const tie = { a: 'x'.repeat(41_000), b: 'y'.repeat(41_000), l: ['1', '2'] };
    const tieJson = shownOf(tie, { a: 'fact', b: 'fact', l: 'fact' }, tiePlan).json;
    // The run state has nothing to cut (N = M). The tie's floor floors `l`, a list of two short
    // ids, which GROWS by its marker: N > M, pinned as reality (correction 2, C's verify-first; the
    // plan's floors stay as they are).
    const tieTable = { a: 'fact', b: 'fact', l: 'fact' } as const;
    const tieM = sseJsonStringify(walked(tie, tieTable)).length;
    const tieN = sseJsonStringify(walked({ ...tie, l: ['1'], l_more: 1 }, tieTable)).length;
    // (a) red when the first oversized part is named instead of the largest, a tie goes to the
    //     later key, or the uncut reply is sent; (b) prints the two lines and the tie's sizes.
    expect({
      big: (big['warnings'] as string[])[0],
      tie: (tieJson['warnings'] as string[])[0],
      tieGrows: [tieM, tieN, tieN > tieM],
    }).toEqual({
      big: FIELD_LEAD(
        sseJsonStringify(shown).length,
        'pending_gate',
        inPlace(shown['pending_gate'], 1),
        sseJsonStringify(shown).length,
      ),
      tie: FIELD_LEAD(tieM, 'a', inPlace(tie.a, 1), tieN),
      tieGrows: [tieM, tieN, true],
    });
  });

  it('FIELD: a 60,000-character params is the plan’s part — omitted, never named; the reply fits', () => {
    const params = { blob: 'P872'.repeat(15_000) };
    const { text, json } = shownOf(runState({ params }), RUN_STATE_SUMMARY_TABLE, RUN_STATE_PLAN);
    // (a) red when an omit part counts as a part the plan does not cut (the field arm names params
    //     and sends it whole); (b) prints the size, the warnings and the omitted form.
    expect({
      fits: text.length <= C,
      warnings: json['warnings'],
      params: json['params'],
    }).toEqual({
      fits: true,
      warnings: undefined,
      params: { omitted: true, chars: JSON.stringify(params).length },
    });
  });

  it('FIELD: a key whose value is undefined is not in the reply and never a part — the plan runs and the reply fits', () => {
    const { text, json } = shownOf(
      runState({ pending_gate: undefined, steps: steps(150, 290) }),
      RUN_STATE_SUMMARY_TABLE,
      RUN_STATE_PLAN,
    );
    // (a) red when an undefined value is measured (the composer throws, and the tool's error reply is
    //     sent instead); (b) prints the size and the marks.
    expect({ fits: text.length <= C, more: typeof json['steps_more'] }).toEqual({
      fits: true,
      more: 'number',
    });
  });

  it('FLOOR: parts no plan cuts, each under the ceiling but together over it at the floor — the floor arm, the floor-cut reply sent, N recomputed', () => {
    const reply = envelope({
      context_hint: 'c'.repeat(25_000),
      error_details: { note: 'd'.repeat(25_000) },
      next_actions: Array.from({ length: 6 }, (_, i) => action(i, 1_000)),
      warnings: ['an existing warning', 'a second one'],
    });
    const m = sizeOf(reply, MCP_ENVELOPE_TABLE);
    // N: every planned list at its floor, built here (not by the plan under test).
    const floorReply = {
      ...reply,
      next_actions: (reply['next_actions'] as unknown[]).slice(0, 1),
      next_actions_more: 5,
    };
    const floor = sizeOf(floorReply, MCP_ENVELOPE_TABLE);
    const { json } = shownOf(reply, MCP_ENVELOPE_TABLE);
    const keys = Object.keys(json);
    // (a) red when N is M (#916's guard-only false claim), the uncut reply is sent (correction 1),
    //     or the existing warnings move or reorder; (b) prints the line, the counts and the keys.
    expect({
      over: floor > C,
      line: (json['warnings'] as string[])[0],
      warnings: (json['warnings'] as string[]).slice(1),
      actions: [(json['next_actions'] as unknown[]).length, json['next_actions_more']],
      keys: [keys[0], keys.slice(1).join(',')],
    }).toEqual({
      over: true,
      line: FLOOR_LEAD(m, floor),
      warnings: ['an existing warning', 'a second one'],
      actions: [1, 5],
      keys: [
        'warnings',
        Object.keys(walked(floorReply, MCP_ENVELOPE_TABLE))
          .filter((k) => k !== 'warnings')
          .join(','),
      ],
    });
  });
});

// ─── HC4: the run's lists in get_run_state's plan ────────────────────────────────────────────────

describe('#872 (b1) correction 1 HC4 (H4) — get_run_state’s run lists are cut over the ceiling, in C1’s order, each with its exact count', () => {
  const H4 = [
    'defaulted_steps',
    'skipped_steps',
    'completed_steps',
    'waiting_on_answer',
    'pending_guards',
    'step_claims',
    'stuck_claims',
    'in_progress_steps',
    'failed_steps',
  ] as const;
  const id = (k: string, i: number) =>
    `${k.slice(0, 6)}_${String(i).padStart(4, '0')}_${'i'.repeat(80)}`;
  const lists = (count: number): Reply =>
    Object.fromEntries(
      H4.map((k) => [
        k,
        Array.from({ length: count }, (_, i) =>
          k === 'step_claims'
            ? { step: id(k, i), holder: { by: null, absent_cause: 'not_recorded' } }
            : k === 'stuck_claims'
              ? { step: id(k, i), state: 'claim_unknown_age' }
              : id(k, i),
        ),
      ]),
    );

  it('nine lists of ~40 K each: phase 2 floors them in C1’s order, the last one is cut to the largest count that fits; every count exact', () => {
    const reply = runState(lists(400));
    const { text, json } = shownOf(reply, RUN_STATE_SUMMARY_TABLE, RUN_STATE_PLAN);
    const kept = H4.map((k) => (json[k] as unknown[]).length);
    // (a) red when one of the nine is not in the plan (never cut, the reply over), the order is not
    //     C1's (a later list floored before an earlier one), or a count is not exact; (b) prints the
    //     kept counts and the counts left out.
    expect({
      fits: text.length <= C,
      floored: kept.slice(0, 8),
      lastCut: kept[8]! > 1 && kept[8]! < 400,
      exact: H4.map((k, i) => kept[i]! + (json[`${k}_more`] as number)),
    }).toEqual({
      fits: true,
      floored: [1, 1, 1, 1, 1, 1, 1, 1],
      lastCut: true,
      exact: H4.map(() => 400),
    });
  });

  it('under the ceiling: every list whole, no count', () => {
    const reply = runState(lists(20));
    const { json } = shownOf(reply, RUN_STATE_SUMMARY_TABLE, RUN_STATE_PLAN);
    // (a) red when a list is cut although the reply fits; (b) prints the counts and the marks.
    expect({
      kept: H4.map((k) => (json[k] as unknown[]).length),
      marks: Object.keys(json).filter((k) => k.endsWith('_more')),
    }).toEqual({ kept: H4.map(() => 20), marks: [] });
  });
});

// ─── HC6: the envelope's lists, and eligible_steps ───────────────────────────────────────────────

/** A JSON-file store pair and an MCP client on a server with `registry` (when given). */
async function door(registry?: ExtensionRegistry) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-hc6-872-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    ...(registry !== undefined ? { registry } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hc6-872', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<{ size: number; json: Reply }> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return { size: raw.content[0]!.text.length, json: JSON.parse(raw.content[0]!.text) as Reply };
  };
  return { call, runStore, workflowStore };
}

const wf = (id: string, stepsOf: Record<string, unknown>): WorkflowDefinition =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: stepsOf,
  }) as WorkflowDefinition;

/** `count` step ids of 42 characters, as the census's. */
const ids42 = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => `step_${String(i).padStart(4, '0')}_of_the_customer_invoice_fanout_x`,
  );

describe('#872 (b1) correction 1 HC6 (H6) — the envelope’s lists and eligible_steps', () => {
  it('the door: start_run on 450 resolving auto steps — every step runs, chained_auto_steps cut with its exact count, the reply under the ceiling', async () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h_ok', { id: 'h_ok', execute: async () => ({ data: {} }) });
    const { call, workflowStore } = await door(registry);
    const all = ids42(450);
    await workflowStore.register(
      wf(
        'hc6-chain',
        Object.fromEntries(
          all.map((s) => [s, { description: 'Auto step.', execution: 'auto', handler: 'h_ok' }]),
        ),
      ),
    );
    const { size, json } = await call('start_run', { workflow_id: 'hc6-chain' });
    const shown = (json['chained_auto_steps'] as unknown[]).length;
    // (a) red when chained_auto_steps is not in the envelope's plan (the reply sent whole, over the
    //     ceiling); (b) prints the size and the counts.
    expect({
      phase: json['run_phase'],
      fits: size <= C,
      total: shown + (json['chained_auto_steps_more'] as number),
      cut: shown < 450,
    }).toEqual({ phase: 'completed', fits: true, total: 450, cut: true });
  }, 240_000);

  it('the door: the run-completing execute_step with 1,000 defaulted steps — defaulted_steps cut with its exact count, the reply under the ceiling', async () => {
    const { call, runStore, workflowStore } = await door();
    const all = ids42(1001);
    await workflowStore.register(
      wf(
        'hc6-defaulted',
        Object.fromEntries(
          all.map((s) => [s, { description: 'Agent step.', execution: 'agent', depends_on: [] }]),
        ),
      ),
    );
    const { run } = await runStore.create({
      workflowId: 'hc6-defaulted',
      workflowVersion: 1,
      params: {},
    });
    const settled = all.slice(0, 1000);
    const entry = (step_id: string): EvidenceSnapshot => ({
      step_id,
      started_at: '2026-10-28T00:00:00.000Z',
      completed_at: '2026-10-28T00:00:01.000Z',
      duration_ms: 1,
      input_summary: {},
      output_summary: {},
      status: 'success',
      evidence_hash: `h-${step_id}`,
      diagnostics: { input_token_estimate: 0, precondition_trace: [], settled_by_default: true },
    });
    const current = await runStore.get(run.id);
    await runStore.update({
      ...current,
      evidence: settled.map(entry),
      completed_steps: settled,
    });
    const { size, json } = await call('execute_step', {
      run_id: run.id,
      command: all[1000]!,
      params: {},
    });
    const shown = (json['defaulted_steps'] as unknown[]).length;
    // (a) red when defaulted_steps is not in the envelope's plan (51,880 sent whole at 1,000 —
    //     872-CEN-22); (b) prints the size and the counts.
    expect({
      phase: json['run_phase'],
      fits: size <= C,
      total: shown + (json['defaulted_steps_more'] as number),
    }).toEqual({ phase: 'completed', fits: true, total: 1000 });
  }, 120_000);

  it('the door, shape P: one answer settles 1,000 guards — submit_human_response cuts guards with its exact count, the reply under the ceiling', async () => {
    const { call, runStore, workflowStore } = await door();
    const all = ids42(1000);
    await workflowStore.register(
      wf('hc6-guards', {
        g: {
          description: 'A person decides.',
          execution: 'auto',
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
        ...Object.fromEntries(
          all.map((s) => [
            s,
            {
              description: 'Guard.',
              execution: 'guard',
              depends_on: ['g'],
              abort_unless: ["g.choice == 'approve'"],
            },
          ]),
        ),
      }),
    );
    const { json: started } = await call('start_run', { workflow_id: 'hc6-guards' });
    const runId = String(started['run_id']);
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    const { size, json } = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'approve',
    });
    const shown = (json['guards'] as unknown[]).length;
    // (a) red when guards is not in the envelope's plan (97,004 characters in place sent whole —
    //     the verify-first, 872-B1C-11); (b) prints the phase, the size and the counts.
    expect({
      phase: json['run_phase'],
      fits: size <= C,
      total: shown + (json['guards_more'] as number),
      cut: shown < 1000,
    }).toEqual({ phase: 'completed', fits: true, total: 1000, cut: true });
  }, 120_000);

  it('guards (a synthetic envelope: 600 settled guards beside a whole first next action) — cut with its exact count, before next_actions', () => {
    const reply = envelope({
      command: 'submit_human_response',
      guards: ids42(600).map((step) => ({ step, outcome: 'pass' })),
      next_actions: [action(0, 300), action(1, 300)],
    });
    const { text, json } = shownOf(reply, MCP_ENVELOPE_TABLE);
    // (a) red when guards is not in the envelope's plan, or next_actions is cut first; (b) prints
    //     the counts and the size.
    expect({
      fits: text.length <= C,
      total: (json['guards'] as unknown[]).length + (json['guards_more'] as number),
      actions: (json['next_actions'] as unknown[]).length,
    }).toEqual({ fits: true, total: 600, actions: 2 });
  });

  it('the door: execute_step by name on a step not ready, with 11 steps ready — blocked_reason names ten, then eligible_steps_more 1', async () => {
    const { call, workflowStore } = await door();
    const ready = ids42(11);
    await workflowStore.register(
      wf('hc6-eligible', {
        ...Object.fromEntries(
          ready.map((s) => [s, { description: 'Agent step.', execution: 'agent', depends_on: [] }]),
        ),
        later: { description: 'Later.', execution: 'agent', depends_on: [ready[0]!] },
      }),
    );
    const { json: started } = await call('start_run', { workflow_id: 'hc6-eligible' });
    const { json } = await call('execute_step', {
      run_id: started['run_id'],
      command: 'later',
      params: {},
    });
    const blocked = json['blocked_reason'] as Reply;
    // (a) red when the bound is removed (eleven names, no count); (b) prints the status and the
    //     blocked reason's keys and counts.
    expect({
      status: json['status'],
      keys: Object.keys(blocked),
      steps: blocked['eligible_steps'],
      more: blocked['eligible_steps_more'],
    }).toEqual({
      status: 'blocked',
      keys: ['eligible_steps', 'eligible_steps_more', 'suggestion'],
      steps: ready.slice(0, 10),
      more: 1,
    });
  });
});
