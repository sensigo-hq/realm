// bounded-sentences-872.test.ts — #872 (b1) correction 1, Part H through the door (an in-memory MCP
// client): the parts no plan cuts that grow with the run are bounded by construction. HC2 (H2):
// names in a sentence — at most ten, then how many more. HC3 (H3): steps refused the same way share
// one clause (and one way), at most ten groups. HC5 (H5): `run_health` — ten findings of a kind,
// `run_health_more`, evidence lists bounded. HC7 (H7): `resumable.steps` and a failed drive's
// `usage`. Beside each: (a) the change that turns it red; (b) what it prints on failure — sentences
// (the names are fake), counts and keys, never a value.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp as mkdtempAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  JsonFileStore,
  JsonWorkflowStore,
  compileDisclosure,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';
import { toolContentOf } from '../render-reply.js';
import { handleGetRunState, RUN_STATE_SUMMARY_TABLE } from './get-run-state.js';

type Reply = Record<string, unknown>;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const flat = (t: string) => t.replace(/\s+/g, ' ');
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

async function door(definitions: WorkflowDefinition[], registry?: ExtensionRegistry) {
  const dir = await mkdtempAsync(join(tmpdir(), 'realm-hb-872-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  for (const d of definitions) await workflowStore.register(d);
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    ...(registry !== undefined ? { registry } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hb-872', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
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
const named = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);
const quoted = (ids: readonly string[]) => ids.map((s) => `'${s}'`).join(', ');
const hint = (r: Reply) => String(r['context_hint']);

// ─── HC2: names in a sentence ────────────────────────────────────────────────────────────────────

describe('#872 (b1) correction 1 HC2 (H2) — names in the MCP sentences: at most ten, then how many more', () => {
  it('"Ready for the agent" at 11 agent steps', async () => {
    const ids = named('a', 11);
    const { call } = await door([
      wf(
        'hc2-ready',
        Object.fromEntries(ids.map((s) => [s, { description: 'A.', execution: 'agent' }])),
      ),
    ]);
    const r = await call('start_run', { workflow_id: 'hc2-ready' });
    // (a) red when the bound is removed at this site (eleven names); (b) prints the hint.
    expect(hint(r)).toContain(`Ready for the agent: ${quoted(ids.slice(0, 10))} and 1 more.`);
  });

  /** A gate fan-out: `count` steps, each a person's decision (auto, human_confirmed, a gate). */
  const gates = (id: string, count: number) =>
    wf(
      id,
      Object.fromEntries(
        named('g', count).map((s) => [
          s,
          {
            description: 'A person decides.',
            execution: 'auto',
            trust: 'human_confirmed',
            gate: { choices: ['approve', 'reject'] },
          },
        ]),
      ),
    );

  it('"… wait for its answer" at 11 steps held by the open question', async () => {
    const { call } = await door([gates('hc2-wait', 12)]);
    const started = await call('start_run', { workflow_id: 'hc2-wait' });
    const r = await call('advance_run', { run_id: started['run_id'] });
    const held = named('g', 12).slice(1);
    // (a) red when the bound is removed at this site; (b) prints the hint.
    expect(hint(r)).toContain(`; ${quoted(held.slice(0, 10))} and 1 more wait for its answer.`);
  });

  it('"Owed to the engine" and the advance entry’s two fields at 11 owed steps (after one answer)', async () => {
    const { call, runStore } = await door([gates('hc2-owed', 12)]);
    const started = await call('start_run', { workflow_id: 'hc2-owed' });
    const runId = String(started['run_id']);
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'approve',
    });
    const owed = named('g', 12).slice(1);
    const entry = (r['next_actions'] as Reply[]).find(
      (a) => (a['instruction'] as Reply | null)?.['tool'] === 'advance_run',
    )!;
    const words = `${quoted(owed.slice(0, 10))} and 1 more`;
    // (a) red when the bound is removed at a site (eleven names in the hint, the entry's
    //     human_readable or its orientation); (b) prints the three texts.
    expect({
      hint: hint(r).includes(`Owed to the engine: ${words} — call advance_run`),
      human: String(entry['human_readable']).includes(`the steps the engine owes: ${words}.`),
      orientation: entry['orientation'],
    }).toEqual({
      hint: true,
      human: true,
      orientation: `Run is active. Engine work is owed: ${words}.`,
    });
  });

  it('"in flight elsewhere": one held step → "is … it"; eleven → "are … and 1 more … them"', async () => {
    const lead = (k: number) => named('h', k);
    const { call, runStore } = await door([
      wf(
        'hc2-held-1',
        Object.fromEntries(lead(1).map((s) => [s, { description: 'H.', execution: 'agent' }])),
      ),
      wf(
        'hc2-held-11',
        Object.fromEntries(lead(11).map((s) => [s, { description: 'H.', execution: 'agent' }])),
      ),
    ]);
    const hold = async (workflowId: string, ids: readonly string[]) => {
      const { run } = await runStore.create({ workflowId, workflowVersion: 1, params: {} });
      const current = await runStore.get(run.id);
      const until = new Date(Date.now() + 3_600_000).toISOString();
      await runStore.update({
        ...current,
        in_progress_steps: [...ids],
        claims: Object.fromEntries(ids.map((s) => [s, { deadline: until, token: `t-${s}` }])),
      } as RunRecord);
      return hint(await call('advance_run', { run_id: run.id }));
    };
    const one = await hold('hc2-held-1', lead(1));
    const eleven = await hold('hc2-held-11', lead(11));
    // (a) red when the bound is removed, or the verb and pronoun follow the names shown instead of
    //     the total; (b) prints the two sentences' ends.
    expect({
      one: one.includes(
        "No step is ready: 'h00' is in flight elsewhere — wait for it, then call get_run_state.",
      ),
      eleven: eleven.includes(
        `No step is ready: ${quoted(lead(11).slice(0, 10))} and 1 more are in flight elsewhere — wait for them, then call get_run_state.`,
      ),
    }).toEqual({ one: true, eleven: true });
  });
});

// ─── HC3: refusal clauses grouped ────────────────────────────────────────────────────────────────

/** `count` auto steps with `precondition(i)`; the run's params make each fail. */
const refused = (
  id: string,
  ids: readonly string[],
  precondition: (i: number, s: string) => string,
) =>
  wf(
    id,
    Object.fromEntries(
      ids.map((s, i) => [
        s,
        { description: 'P.', execution: 'auto', handler: 'h', preconditions: [precondition(i, s)] },
      ]),
    ),
  );
const handled = () => {
  const registry = new ExtensionRegistry();
  registry.register('handler', 'h', { id: 'h', execute: async () => ({ data: {} }) });
  return registry;
};

describe('#872 (b1) correction 1 HC3 (H3) — steps refused the same way share one clause', () => {
  it('100 steps refused by one precondition → one clause, the others named; the page says so', async () => {
    const ids = named('p', 100);
    const { call } = await door(
      [refused('hc3-one', ids, () => "run.params.go == 'yes'")],
      handled(),
    );
    const r = await call('start_run', { workflow_id: 'hc3-one', params: { go: 'no' } });
    const clauses = hint(r).match(/cannot run \(precondition\)/g) ?? [];
    // (a) red when each step keeps its own clause (100 clauses), or the also-names change; (b)
    //     prints the count of clauses and the group's tail.
    expect({
      clauses: clauses.length,
      also: hint(r).includes(" (also 'p01', 'p02' and 97 more)."),
      first: hint(r).includes(
        "'p00' cannot run (precondition): Precondition failed for step 'p00'.",
      ),
    }).toEqual({ clauses: 1, also: true, first: true });
    // The ten clauses and the counting sentence: the cell '12 distinct clauses → ten, …' below
    // (correction 2, D).
    claim(
      'docs/reference/mcp/tools.md',
      "and each step that cannot run (`'<step>' cannot run (<check>): <why>.` — steps refused the same way share one clause, naming two of the others and counting the rest; after ten such clauses, one sentence counts the steps of any others, names three of them (one: `1 more step`), and points to `get_run_state`) — an `auto` step,",
    );
    claim(
      'docs/reference/mcp/tools.md',
      "and each step that cannot run (`'<step>' cannot run (<check>): <why>.` — steps refused the same way share one clause, naming two of the others and counting the rest; after ten such clauses, one sentence counts the steps of any others, names three of them (one: `1 more step`), and points to `get_run_state` — or `cannot run here (capability)`",
    );
  });

  it('two expressions → two clauses; two steps whose preconditions name their OWN ids → two clauses', async () => {
    const { call } = await door(
      [
        refused('hc3-two', named('q', 4), (i) =>
          i < 2 ? "run.params.go == 'yes'" : 'run.params.n == 1',
        ),
        refused('hc3-own', ['approve', 'reject'], (_i, s) => `run.params.action == '${s}'`),
      ],
      handled(),
    );
    const two = hint(
      await call('start_run', { workflow_id: 'hc3-two', params: { go: 'no', n: 2 } }),
    );
    const own = hint(
      await call('start_run', { workflow_id: 'hc3-own', params: { action: 'hold' } }),
    );
    // (a) red when clauses are grouped by check alone (one clause), or the step's own id is masked
    //     everywhere in the text (a replace-all makes 'approve' and 'reject' one key); (b) prints the
    //     clause counts.
    expect({
      two: (two.match(/cannot run \(precondition\)/g) ?? []).length,
      own: (own.match(/cannot run \(precondition\)/g) ?? []).length,
      ownNamed: [own.includes("'approve' cannot run"), own.includes("'reject' cannot run")],
    }).toEqual({ two: 2, own: 2, ownNamed: [true, true] });
  });

  it('12 distinct clauses → ten, then "2 more steps cannot run: …"; 11 → "1 more step cannot run: …"', async () => {
    const twelve = named('d', 12);
    const eleven = named('e', 11);
    const { call } = await door(
      [
        refused('hc3-twelve', twelve, (i) => `run.params.n == ${i + 100}`),
        refused('hc3-eleven', eleven, (i) => `run.params.n == ${i + 100}`),
      ],
      handled(),
    );
    const a = hint(await call('start_run', { workflow_id: 'hc3-twelve', params: { n: 1 } }));
    const b = hint(await call('start_run', { workflow_id: 'hc3-eleven', params: { n: 1 } }));
    // (a) red when the groups are not bounded at ten, or the count's noun ignores one; (b) prints
    //     the clause counts and the closing sentences' presence.
    expect({
      a: (a.match(/cannot run \(precondition\)/g) ?? []).length,
      aMore: a.includes(
        " 2 more steps cannot run: 'd10', 'd11'. See engine_runnable and agent_refused in get_run_state.",
      ),
      b: (b.match(/cannot run \(precondition\)/g) ?? []).length,
      bMore: b.includes(
        " 1 more step cannot run: 'e10'. See engine_runnable and agent_refused in get_run_state.",
      ),
    }).toEqual({ a: 10, aMore: true, b: 10, bMore: true });
  });

  it('input refusals: the producer’s own step id masked — one clause; their ways shared — one way; execute_step’s error hint too', async () => {
    const ids = named('i', 3);
    const definition = wf(
      'hc3-input',
      Object.fromEntries(
        ids.map((s) => [
          s,
          {
            description: 'I.',
            execution: 'auto',
            handler: 'h',
            input_schema: {
              type: 'object',
              required: ['x'],
              properties: { x: { type: 'string' } },
            },
          },
        ]),
      ),
    );
    const { call } = await door([definition], handled());
    const started = await call('start_run', { workflow_id: 'hc3-input', params: {} });
    const byName = await call('execute_step', {
      run_id: started['run_id'],
      command: 'i00',
      params: {},
    });
    const way =
      "For 'i00', 'i01', 'i02', start a run with params that fit, or correct its input_schema and register the workflow again; this run stays open";
    // (a) red when the masking misses the producer's lead (three clauses), the ways are said once
    //     per step, or the error hint keeps one way per step; (b) prints the counts and booleans.
    expect({
      clauses: (hint(started).match(/cannot run \(input_schema\)/g) ?? []).length,
      also: hint(started).includes(" (also 'i01', 'i02')."),
      way: hint(started).includes(way),
      errorWay: [byName['status'], hint(byName).includes(way)],
    }).toEqual({ clauses: 1, also: true, way: true, errorWay: ['error', true] });
  });
});

// ─── HC5: run_health ─────────────────────────────────────────────────────────────────────────────

const withheld = compileDisclosure([], {
  declared: 'unknown',
  cause: 'load_failed',
  audience: 'agent',
  environment: 'swept',
}).set;
const resolved = compileDisclosure([], {
  declared: 'resolved',
  audience: 'agent',
  environment: 'swept',
}).set;

describe('#872 (b1) correction 1 HC5 (H5) — run_health: ten findings of a kind, the rest counted; evidence lists bounded', () => {
  it('12 capability_block findings → ten, run_health_more { capability_block: 2 }; the warning counts 12; values withheld, the count still a number', async () => {
    const ids = named('c', 12);
    const { runStore, workflowStore } = await door([
      wf(
        'hc5-cap',
        Object.fromEntries(
          ids.map((s) => [s, { description: 'C.', execution: 'auto', handler: 'missing' }]),
        ),
      ),
    ]);
    const { run } = await runStore.create({
      workflowId: 'hc5-cap',
      workflowVersion: 1,
      params: {},
    });
    const current = await runStore.get(run.id);
    await runStore.update({
      ...current,
      capability_blocks: Object.fromEntries(
        ids.map((s) => [
          s,
          {
            requirement: { kind: 'handler', name: 'missing' },
            code: 'ENGINE_HANDLER_NOT_FOUND',
            at: '2026-10-28T00:00:00.000Z',
          },
        ]),
      ),
    } as RunRecord);
    const reply = await handleGetRunState(
      { run_id: run.id },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    const show = (set: typeof resolved) =>
      JSON.parse(
        toolContentOf({ ...reply }, { set, audience: 'agent', table: RUN_STATE_SUMMARY_TABLE })
          .content[0]!.text,
      ) as Reply;
    const shown = show(resolved);
    const hidden = show(withheld);
    const kinds = (shown['run_health'] as Reply[]).map((f) => f['kind']);
    // (a) red when the bound is removed (twelve findings), the count is lost, the warning counts the
    //     shown findings, or `run_health_more`'s row is removed (withheld: ‹…›); (b) prints the
    //     counts, the warning and the withheld count.
    expect({
      capability: kinds.filter((k) => k === 'capability_block').length,
      more: shown['run_health_more'],
      warning: (shown['warnings'] as string[]).some((w) =>
        w.startsWith(
          `this run has ${(reply.run_health?.length ?? 0) + 2} active run-health finding(s)`,
        ),
      ),
      withheld: hidden['run_health_more'],
    }).toEqual({
      capability: 10,
      more: { capability_block: 2 },
      warning: true,
      withheld: { capability_block: 2 },
    });
  });

  it('an evidence list at 11 (cannot_go_on’s refused) → ten, refused_more 1 beside it; values withheld, a number', async () => {
    const ids = named('r', 11);
    const { runStore, workflowStore } = await door([
      refused('hc5-evidence', ids, () => "run.params.go == 'yes'"),
    ]);
    const { run } = await runStore.create({
      workflowId: 'hc5-evidence',
      workflowVersion: 1,
      params: { go: 'no' },
    });
    const reply = await handleGetRunState(
      { run_id: run.id },
      { runStore, workflowStore, registry: handled() },
    );
    const show = (set: typeof resolved) =>
      JSON.parse(
        toolContentOf({ ...reply }, { set, audience: 'agent', table: RUN_STATE_SUMMARY_TABLE })
          .content[0]!.text,
      ) as Reply;
    const finding = (json: Reply) =>
      (json['run_health'] as Reply[]).find((f) => f['kind'] === 'cannot_go_on')![
        'evidence'
      ] as Reply;
    const shown = finding(show(resolved));
    // (a) red when the evidence bound is removed (eleven entries), or the count's row is removed
    //     (withheld: ‹number›); (b) prints the counts and the keys.
    expect({
      refused: (shown['refused'] as unknown[]).length,
      keys: Object.keys(shown),
      more: shown['refused_more'],
      withheld: finding(show(withheld))['refused_more'],
    }).toEqual({ refused: 10, keys: ['refused', 'refused_more'], more: 1, withheld: 1 });
  });
});

// ─── HC7: resumable and a failed drive's usage ───────────────────────────────────────────────────

describe('#872 (b1) correction 1 HC7 (H7) — resumable.steps and a failed drive’s usage', () => {
  it('11 failed steps: resumable.steps ten, steps_more 1, the command’s placeholder ten and "and 1 more"', async () => {
    const ids = named('f', 11);
    const registry = new ExtensionRegistry();
    registry.register('handler', 'boom', {
      id: 'boom',
      execute: async () => {
        throw new Error('fake failure');
      },
    });
    const { call } = await door(
      [
        wf(
          'hc7-fail',
          Object.fromEntries(
            ids.map((s) => [s, { description: 'F.', execution: 'auto', handler: 'boom' }]),
          ),
        ),
      ],
      registry,
    );
    const started = await call('start_run', { workflow_id: 'hc7-fail' });
    const runId = String(started['run_id']);
    for (let i = 0; i < 20; i += 1) {
      const state = await call('get_run_state', { run_id: runId });
      if (state['terminal_state'] === true) break;
      await call('advance_run', { run_id: runId });
    }
    const state = await call('get_run_state', { run_id: runId });
    const resumable = state['resumable'] as Reply;
    // (a) red when the bound is removed (eleven steps; the placeholder whole); (b) prints the
    //     phase, the counts and the command.
    expect({
      phase: state['run_phase'],
      steps: resumable['steps'],
      more: resumable['steps_more'],
      command: resumable['command'],
    }).toEqual({
      phase: 'failed',
      steps: ids.slice(0, 10),
      more: 1,
      command: `realm run resume ${runId} --from <one of: ${ids.slice(0, 10).join(', ')} and 1 more>`,
    });
  }, 60_000);

  it('a failed drive with five billed requests → three, usage_more 2; values withheld, a number', async () => {
    const { runStore, workflowStore } = await door([
      wf('hc7-usage', { s: { description: 'S.', execution: 'agent' } }),
    ]);
    const { run } = await runStore.create({
      workflowId: 'hc7-usage',
      workflowVersion: 1,
      params: {},
    });
    const current = await runStore.get(run.id);
    const usage = Array.from({ length: 5 }, (_, i) => ({
      request_index: i,
      request_start: '2026-10-28T00:00:00.000Z',
      prompt_tokens: 10,
      output_tokens: 1,
    }));
    await runStore.update({
      ...current,
      drive_failures: {
        first_failed_at: '2026-10-28T00:00:00.000Z',
        total: 1,
        entries: [
          {
            at: '2026-10-28T00:00:00.000Z',
            step: 's',
            provider: 'fake',
            error_class: 'other',
            message: 'm',
            elapsed_ms: 1,
            usage,
          },
        ],
      },
    } as RunRecord);
    const reply = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    const entryOf = (set: typeof resolved) =>
      (
        (
          JSON.parse(
            toolContentOf({ ...reply }, { set, audience: 'agent', table: RUN_STATE_SUMMARY_TABLE })
              .content[0]!.text,
          ) as Reply
        )['drive_failures'] as { entries: Reply[] }
      ).entries[0]!;
    const shown = entryOf(resolved);
    // (a) red when the bound is removed (five records), or `usage_more`'s row is removed
    //     (withheld: ‹number›); (b) prints the counts.
    expect({
      usage: (shown['usage'] as unknown[]).length,
      more: shown['usage_more'],
      withheld: entryOf(withheld)['usage_more'],
    }).toEqual({ usage: 3, more: 2, withheld: 2 });
  });
});
