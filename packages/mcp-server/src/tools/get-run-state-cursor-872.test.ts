// get-run-state-cursor-872.test.ts — #872 (b1) A2/A3: `get_run_state`'s `step_names` (the named
// steps' detail) and `cursor` (the next page of the asked steps, after the reply ceiling cut them),
// its two refusals (`VALIDATION_CURSOR`), the unknown-name lines, and "asked" read once by every gate.
// The runs' evidence is written straight to the store (as the store contract does): a step's place
// is its first entry's place. Beside each: (a) what turns it red; (b) what it prints on failure —
// step names, counts, codes and sizes, never a value.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  type EvidenceSnapshot,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../index.js';
import { REPLY_CEILING_CHARS } from '../render-reply.js';
import { handleGetRunState } from './get-run-state.js';
import { declared } from '../test-support/declared.js';
import type { RunRecord, RunStore } from '@sensigo/realm';

type Reply = Record<string, unknown>;

/** A workflow of `n` agent steps, `s000`, `s001`, … (none depends on another). */
const fan = (n: number): WorkflowDefinition =>
  ({
    id: `fan-${n}`,
    name: 'fan',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        `s${String(i).padStart(3, '0')}`,
        { description: 'S.', execution: 'agent', depends_on: [] },
      ]),
    ),
  }) as WorkflowDefinition;

const entry = (step_id: string): EvidenceSnapshot => ({
  step_id,
  started_at: '2026-10-28T00:00:00.000Z',
  completed_at: '2026-10-28T00:00:01.000Z',
  duration_ms: 1,
  input_summary: {},
  output_summary: {},
  status: 'success',
  evidence_hash: `h-${step_id}`,
});

async function setup(n: number) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-cursor-872-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const def = fan(n);
  await workflowStore.register(def);
  const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  /** Writes one evidence entry per name, in order (a name already written is a re-attempt). */
  const attempt = async (...names: string[]) => {
    const current = await runStore.get(run.id);
    await runStore.update({
      ...current,
      evidence: [...current.evidence, ...names.map(entry)],
      completed_steps: [...new Set([...current.completed_steps, ...names])],
    });
  };
  const read = async (args: Record<string, unknown>): Promise<Reply> =>
    (await handleGetRunState(
      { run_id: run.id, ...args },
      { runStore, workflowStore },
    )) as unknown as Reply;
  const server = createRealmMcpServer({ runStore, workflowStore });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cursor-872', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (args: Record<string, unknown>): Promise<{ text: string; reply: Reply }> => {
    const raw = (await client.callTool({
      name: 'get_run_state',
      arguments: { run_id: run.id, ...args },
    })) as { content: Array<{ text: string }> };
    return { text: raw.content[0]!.text, reply: JSON.parse(raw.content[0]!.text) as Reply };
  };
  return { runId: run.id, attempt, read, call };
}

const ids = (r: Reply): string[] => Object.keys((r['steps'] as Record<string, unknown>) ?? {});

describe('#872 (b1) B4 — the cursor and step_names', () => {
  it('page by page to the end: nothing repeated, nothing skipped; next_cursor absent on the last page; the empty page has no steps', async () => {
    const s = await setup(400);
    const all = Array.from({ length: 400 }, (_, i) => `s${String(i).padStart(3, '0')}`);
    await s.attempt(...all);
    const pages: string[][] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let guard = 0; guard < 20; guard += 1) {
      const { text, reply } = await s.call({
        include_steps: true,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      sizes.push(text.length);
      pages.push(ids(reply));
      cursor = reply['next_cursor'] as string | undefined;
      if (cursor === undefined) break;
      // (a) red when the cursor is not the last shown id; (b) prints it.
      expect(cursor).toBe(pages.at(-1)!.at(-1));
    }
    const empty = (await s.call({ include_steps: true, cursor: all.at(-1) })).reply;
    // (a) red when a page repeats or skips a step, a page passes the ceiling, the walk needed no
    //     second page, or the empty page carries steps or a cursor; (b) prints counts and sizes.
    expect({
      pages: pages.length > 1,
      seen: pages.flat(),
      fit: sizes.every((n) => n <= REPLY_CEILING_CHARS),
      empty: ['steps' in empty, 'next_cursor' in empty, 'steps_more' in empty],
    }).toEqual({ pages: true, seen: all, fit: true, empty: [false, false, false] });
  });

  it('a step first attempted between pages appears after the cursor; a re-attempted step is not repeated', async () => {
    const s = await setup(6);
    await s.attempt('s000', 's001', 's002');
    const page1 = await s.read({ include_steps: true });
    await s.attempt('s003', 's000');
    const page2 = await s.read({ include_steps: true, cursor: 's002' });
    // (a) red when the cursor's place moves with a re-attempt, or a new step lands before it; (b)
    //     prints both pages' ids.
    expect([ids(page1 as Reply), ids(page2 as Reply)]).toEqual([
      ['s000', 's001', 's002'],
      ['s003'],
    ]);
  });

  it('step_names: the named steps only, in first-attempt order; the cursor’s place is the full order, then the selection — a different selection pages from the same place', async () => {
    const s = await setup(6);
    await s.attempt('s000', 's001', 's002', 's003', 's004', 's005');
    const r = (a: Record<string, unknown>) => s.read(a).then((x) => ids(x as Reply));
    // (a) red when the cursor's place is resolved within the selection (s001 is outside it), or the
    //     selection's order is the names' order; (b) prints the ids.
    expect({
      named: await r({ step_names: ['s004', 's001'] }),
      after: await r({ step_names: ['s000', 's002', 's005'], cursor: 's001' }),
      other: await r({ step_names: ['s003', 's004'], cursor: 's001' }),
    }).toEqual({ named: ['s001', 's004'], after: ['s002', 's005'], other: ['s003', 's004'] });
  });

  it('step_names + the ceiling: the selection is paged within itself', async () => {
    const s = await setup(400);
    const all = Array.from({ length: 400 }, (_, i) => `s${String(i).padStart(3, '0')}`);
    await s.attempt(...all);
    const named = all.filter((_, i) => i % 2 === 0);
    const first = (await s.call({ step_names: named })).reply;
    const second = (await s.call({ step_names: named, cursor: first['next_cursor'] })).reply;
    // (a) red when a page holds a step outside the selection, or the count is not the rest within
    //     it; (b) prints the counts.
    expect({
      inside: [...ids(first), ...ids(second)].every((id) => named.includes(id)),
      more: first['steps_more'],
      rest: named.length - ids(first).length,
      continues: named.indexOf(ids(second)[0]!) === ids(first).length,
    }).toEqual({
      inside: true,
      more: named.length - ids(first).length,
      rest: named.length - ids(first).length,
      continues: true,
    });
  });

  it('an unknown name is named in warnings — ten named, then the count; a 600-character name by its length', async () => {
    const s = await setup(3);
    await s.attempt('s000');
    const one = (await s.read({ step_names: ['s000', 'no_such'] })) as Reply;
    const twelve = (await s.read({
      step_names: Array.from({ length: 12 }, (_, i) => `x${i}`),
    })) as Reply;
    const long = (await s.read({ step_names: ['n'.padEnd(600, 'q')] })) as Reply;
    const lines = (r: Reply) => (r['warnings'] as string[] | undefined) ?? [];
    // (a) red when a line's words change, the list is not bounded, or a long name is quoted whole;
    //     (b) prints the lines (the names are fake).
    expect({
      one: [ids(one), lines(one)],
      twelve: [lines(twelve).length, lines(twelve).at(-1)],
      long: lines(long),
    }).toEqual({
      one: [['s000'], ["'no_such' is not a step this run has attempted"]],
      twelve: [11, 'and 2 more names are not steps this run has attempted (12 in all)'],
      long: ["'‹600 characters, not kept›' is not a step this run has attempted"],
    });
  });

  it('"asked" is one reading: a non-empty step_names reads what include_steps: true reads; step_names: [] is as absent', async () => {
    const s = await setup(3);
    await s.attempt('s000', 's001', 's002');
    const keys = ['steps', 'run_cost', 'drive_failure_costs'];
    const pick = (r: Reply) => Object.fromEntries(keys.filter((k) => k in r).map((k) => [k, r[k]]));
    const all = (await s.read({ include_steps: true })) as Reply;
    const named = (await s.read({ step_names: ['s000', 's001', 's002'] })) as Reply;
    const none = (await s.read({ step_names: [] })) as Reply;
    // (a) red when a gate still reads include_steps alone (the steps' view, the price source or the
    //     run's cost differ, or are absent); (b) prints the keys present.
    expect({
      same: JSON.stringify(pick(named)) === JSON.stringify(pick(all)),
      keys: Object.keys(pick(named)),
      none: Object.keys(pick(none)),
    }).toEqual({
      same: true,
      keys: Object.keys(pick(all)),
      none: [],
    });
    expect(Object.keys(pick(all))).toContain('run_cost');
  });
});

describe('#872 (b1) B4 — "asked" at all five gates, on a run whose status path reads no definition', () => {
  it('a terminal run with drive_failures: step_names naming every step reads what include_steps: true reads — the view’s definition, the prices, steps, drive_failure_costs, run_cost', async () => {
    const def = {
      id: 'ended-872',
      name: 'ended',
      version: 1,
      steps: { s: { description: 'S.', execution: 'agent', depends_on: [] } },
    } as unknown as WorkflowDefinition;
    const run = {
      id: 'r-ended',
      workflow_id: def.id,
      workflow_version: 1,
      completed_steps: ['s'],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      run_phase: 'completed',
      version: 3,
      params: {},
      // No agent_profile on the entry: only the view's definition says the step is an agent's
      // (its attempt then reads `cost_unrecorded: not_measured_by_realm`) — gate 1 made visible.
      evidence: [entry('s')],
      created_at: '2026-10-28T00:00:00.000Z',
      updated_at: '2026-10-28T00:00:01.000Z',
      terminal_state: true,
      drive_failures: {
        first_failed_at: '2026-10-28T00:00:00.000Z',
        total: 1,
        entries: [
          {
            at: '2026-10-28T00:00:00.000Z',
            step: 's',
            provider: 'a',
            error_class: 'other',
            message: 'm',
            elapsed_ms: 1,
          },
        ],
      },
    } as unknown as RunRecord;
    const runStore = declared({
      persistsClaims: true,
      get: async () => run,
    } as unknown as RunStore);
    const workflowStore = declared({
      register: async () => {},
      list: async () => [],
      get: async () => def,
    } as unknown as JsonWorkflowStore);
    const read = async (args: Record<string, unknown>) =>
      (await handleGetRunState(
        { run_id: run.id, ...args },
        { runStore, workflowStore },
      )) as unknown as Reply;
    const keys = ['steps', 'drive_failure_costs', 'run_cost'];
    const pick = (r: Reply) => Object.fromEntries(keys.filter((k) => k in r).map((k) => [k, r[k]]));
    const all = pick(await read({ include_steps: true }));
    const named = pick(await read({ step_names: ['s'] }));
    // (a) red when any of the five gates still reads include_steps alone; (b) prints the keys and
    //     whether the two readings match.
    expect({
      keys: Object.keys(named),
      same: JSON.stringify(named) === JSON.stringify(all),
    }).toEqual({
      keys,
      same: true,
    });
  });
});

describe('#872 (b1) B4/B6 — the refusals: VALIDATION_CURSOR', () => {
  it.each([
    ['include_steps absent', {}],
    ['include_steps: false', { include_steps: false }],
    ['step_names: []', { step_names: [] }],
  ])('a cursor with %s → refused, its words byte-exact', async (_name, args) => {
    const s = await setup(3);
    await s.attempt('s000');
    const { reply } = await s.call({ ...args, cursor: 's000' });
    // (a) red when the refusal is dropped (the cursor ignored), its words, code, action or hint
    //     change; (b) prints the envelope's fields.
    expect({
      status: reply['status'],
      code: reply['error_code'],
      errors: reply['errors'],
      action: reply['agent_action'],
      hint: reply['context_hint'],
    }).toEqual({
      status: 'error',
      code: 'VALIDATION_CURSOR',
      errors: ['cursor pages steps: pass include_steps: true, or step_names, with it.'],
      action: 'provide_input',
      hint: "get_run_state's cursor was refused; call again as errors[0] says.",
    });
  });

  it('a cursor naming no attempted step → refused; a 600-character cursor by its length', async () => {
    const s = await setup(3);
    await s.attempt('s000');
    const short = (await s.call({ include_steps: true, cursor: 's002' })).reply;
    const long = (await s.call({ include_steps: true, cursor: 'c'.padEnd(600, 'z') })).reply;
    // (a) red when an unattempted cursor pages from the start (or the end), or a long one is quoted
    //     whole; (b) prints the codes and the errors (the cursors are fake).
    expect([
      [short['error_code'], short['errors']],
      [long['error_code'], long['errors']],
    ]).toEqual([
      [
        'VALIDATION_CURSOR',
        [
          "cursor 's002' names no step this run has attempted; call again without a cursor to start from the first.",
        ],
      ],
      [
        'VALIDATION_CURSOR',
        [
          "cursor '‹600 characters, not kept›' names no step this run has attempted; call again without a cursor to start from the first.",
        ],
      ],
    ]);
  });
});
