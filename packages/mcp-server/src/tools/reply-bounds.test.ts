// reply-bounds.test.ts — the zod 4 unit's reply bounds (07): in `warnings`, a reply's list of
// unknown keys, of steps the runner cannot serve, or of inbound markers names the first ten, then
// the count — `create_workflow`'s unknown keys (and its `diagnostics`), `advance_run`'s and `submit_human_response`'s unknown keys,
// `start_run`'s capability pre-flight on its three composition paths, `start_run_batch`'s, and the
// inbound-marker line on `execute_step`; and the docs sentences that say so. Through the real door
// (an in-process client). Every value is a fake. Each assertion names (a) the change that turns it
// red and (b) what it prints: counts, lines, lengths and booleans — never a whole list, an
// environment or a key.
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const flat = (t: string) => t.replace(/\s+/g, ' ');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

type Reply = Record<string, unknown>;

async function connect() {
  const dir = await mkdtemp(join(tmpdir(), 'realm-reply-bounds-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({ runStore, workflowStore });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'reply-bounds', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    const text = raw.content[0]!.text;
    try {
      return { ...(JSON.parse(text) as Reply), _length: text.length };
    } catch {
      return { _text: text, _length: text.length };
    }
  };
  /** A workflow of three agent steps `s0`…`s2`, and a fresh run of it. */
  const agentRun = async () => {
    const wf = await call('create_workflow', {
      steps: [0, 1, 2].map((i) => ({ id: `s${i}`, description: `step ${i}` })),
    });
    const wid = (wf['data'] as { workflow_id: string }).workflow_id;
    return (await call('start_run', { workflow_id: wid }))['run_id'] as string;
  };
  return { call, dir, workflowStore, agentRun };
}

const keys = (n: number, prefix = 'zz') =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, 1]));
const list = (v: unknown) => (v ?? []) as string[];
/** The key each unknown-key line names, in order (the count line names none). */
const keyOf = (line: string) => /unknown (?:key|argument) '([^']+)'/.exec(line)?.[1] ?? line;

/** `n` auto handler steps `h0`… no runner serves (a definition registered through the store). */
function unmetDef(id: string, n: number, after: string[] = []): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `h${i}`,
      { description: `h${i}`, execution: 'auto', handler: `nope${i}`, depends_on: after },
    ]),
  );
}
const definition = (id: string, steps: Record<string, unknown>, extra: object = {}) =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
    ...extra,
  }) as unknown as WorkflowDefinition;
const preflight = (i: number) =>
  `Step 'h${i}' needs handler 'nope${i}', which is not registered in this runner. If reached it will block recoverably (not fail) until a runner that provides this handler executes it — load the missing extension or run on a capable runner.`;

describe('the reply bounds: create_workflow’s unknown keys (M1, M1′)', () => {
  it('cell 1: ten keys are ten lines; eleven are ten and the count; 40,000 are eleven', async () => {
    const { call } = await connect();
    const steps = [{ id: 'a', description: 'a' }];
    const ten = list((await call('create_workflow', { steps, ...keys(10) }))['warnings']);
    const eleven = list((await call('create_workflow', { steps, ...keys(11) }))['warnings']);
    const big = await call('create_workflow', { steps, ...keys(40_000) });
    const w = list(big['warnings']);
    // (a) red when the three sweeps' lines are spread whole again (40,000 lines), or the count line
    //     appears at ten; (b) prints the keys named, the count lines and the counts.
    expect({
      ten: ten.map(keyOf),
      tenLine: ten[0],
      eleven: eleven.map(keyOf),
      big: { status: big['status'], count: w.length, last: w.at(-1) },
    }).toEqual({
      ten: Array.from({ length: 10 }, (_, i) => `zz${i}`),
      tenLine: expect.stringMatching(
        /^⚠ workflow 'dynamic-[0-9a-f]+': unknown key 'zz0' — ignored \(not a recognized create_workflow field\)\.$/,
      ),
      eleven: [
        ...Array.from({ length: 10 }, (_, i) => `zz${i}`),
        'and 1 more unknown key was ignored (11 in all)',
      ],
      big: {
        status: 'ok',
        count: 11,
        last: 'and 39990 more unknown keys were ignored (40000 in all)',
      },
    });
  });

  it('cell 1b: the three sweeps make ONE list, in sweep order (top-level, metadata, the steps)', async () => {
    const { call } = await connect();
    const r = await call('create_workflow', {
      steps: [{ id: 'a', description: 'a', ...keys(4, 'sk') }],
      metadata: keys(4, 'mk'),
      ...keys(4, 'tk'),
    });
    // (a) red when each sweep is bounded alone (twelve lines, no count line) or the order moves;
    //     (b) prints the keys named.
    expect(list(r['warnings']).map(keyOf)).toEqual([
      'tk0',
      'tk1',
      'tk2',
      'tk3',
      'mk0',
      'mk1',
      'mk2',
      'mk3',
      'sk0',
      'sk1',
      'and 2 more unknown keys were ignored (12 in all)',
    ]);
  });

  it('cell 2: `diagnostics` keeps the ten entries the warnings name; the reply stays small', async () => {
    const { call } = await connect();
    const r = await call('create_workflow', {
      steps: [{ id: 'a', description: 'a' }],
      ...keys(40_000),
    });
    const diagnostics = (r['diagnostics'] ?? []) as Array<{ key?: string }>;
    // (a) red when `diagnostics` carries every entry (40,000, 8 MB); (b) prints the count, the
    //     keys, and the reply's length check.
    expect({
      count: diagnostics.length,
      keys: diagnostics.map((d) => d.key),
      sameAsWarnings:
        JSON.stringify(diagnostics.map((d) => d.key)) ===
        JSON.stringify(list(r['warnings']).slice(0, 10).map(keyOf)),
      under8000: (r['_length'] as number) < 8000,
    }).toEqual({
      count: 10,
      keys: Array.from({ length: 10 }, (_, i) => `zz${i}`),
      sameAsWarnings: true,
      under8000: true,
    });
  });
});

describe('the reply bounds: advance_run and submit_human_response (M2, M3)', () => {
  it('cell 3: `advance_run` — eleven unknown keys are ten and the count; 20,000 stay eleven', async () => {
    const { call, agentRun } = await connect();
    const ten = await call('advance_run', { run_id: await agentRun(), ...keys(10) });
    const eleven = await call('advance_run', { run_id: await agentRun(), ...keys(11) });
    const big = await call('advance_run', { run_id: await agentRun(), ...keys(20_000) });
    const unknownLines = (r: Reply) =>
      list(r['warnings']).filter((l) =>
        !l.startsWith('advance_run:') ? /^and \d+ more unknown/.test(l) : true,
      );
    // (a) red when the renderer lists every key (20,000 lines, 1.2 MB), or a count line appears at
    //     ten; (b) prints the lines' keys, the counts and the length check.
    expect({
      ten: unknownLines(ten).map(keyOf),
      eleven: unknownLines(eleven).map(keyOf),
      one: unknownLines(eleven)[0],
      big: { count: unknownLines(big).length, last: unknownLines(big).at(-1) },
      under6000: (big['_length'] as number) < 6000,
    }).toEqual({
      ten: Array.from({ length: 10 }, (_, i) => `zz${i}`),
      eleven: [
        ...Array.from({ length: 10 }, (_, i) => `zz${i}`),
        'and 1 more unknown key was ignored (11 in all)',
      ],
      one: "advance_run: unknown argument 'zz0' was ignored.",
      big: { count: 11, last: 'and 19990 more unknown keys were ignored (20000 in all)' },
      under6000: true,
    });
  });

  it('cell 4: `submit_human_response` — the bound on the error reply, and the near miss first', async () => {
    const { call, agentRun } = await connect();
    const answer = { gate_id: 'g', choice: 'approve' };
    const ten = list(
      (await call('submit_human_response', { run_id: await agentRun(), ...answer, ...keys(10) }))[
        'warnings'
      ],
    );
    const eleven = await call('submit_human_response', {
      run_id: await agentRun(),
      ...answer,
      ...keys(11),
    });
    const big = await call('submit_human_response', {
      run_id: await agentRun(),
      ...answer,
      ...keys(20_000),
      claimToken: 'FAKE-claim',
    });
    const w = list(big['warnings']);
    // (a) red when the renderer lists every key (20,001 lines), the near miss is not moved first
    //     (it falls outside the ten), or a count line appears at ten; (b) prints the status, the keys
    //     named, the first line and the count line — never the near miss's value.
    expect({
      ten: {
        count: ten.filter((l) => l.startsWith('submit_human_response:')).length,
        countLine: ten.some((l) => l.startsWith('and ')),
      },
      status: eleven['status'],
      eleven: list(eleven['warnings']).slice(0, 11).map(keyOf),
      first: w[0],
      count: w.filter((l) => l.startsWith('submit_human_response:')).length,
      countLine: w.find((l) => l.startsWith('and ')),
    }).toEqual({
      ten: { count: 10, countLine: false },
      status: 'error',
      eleven: [
        ...Array.from({ length: 10 }, (_, i) => `zz${i}`),
        'and 1 more unknown key was ignored (11 in all)',
      ],
      first:
        "submit_human_response: unknown argument 'claimToken' was ignored — did you mean 'claim_token'?",
      count: 10,
      countLine: 'and 19991 more unknown keys were ignored (20001 in all)',
    });
  });
});

describe('the reply bounds: the capability pre-flight (M4, M5)', () => {
  it('cell 5a: `start_run`, the block path — the block line, then ten and the count', async () => {
    const { call, workflowStore } = await connect();
    await workflowStore.register(definition('cap11', unmetDef('cap11', 11)));
    await workflowStore.register(definition('cap12', unmetDef('cap12', 12)));
    await workflowStore.register(definition('cap1000', unmetDef('cap1000', 1000)));
    const eleven = list((await call('start_run', { workflow_id: 'cap11' }))['warnings']);
    const twelve = list((await call('start_run', { workflow_id: 'cap12' }))['warnings']);
    const big = list((await call('start_run', { workflow_id: 'cap1000' }))['warnings']);
    // (a) red when the block path lists every requirement (1,000 lines), the blocked step's own
    //     line is not dropped first, or a count line appears at ten; (b) prints the counts and the
    //     lines that carry the decision.
    expect({
      eleven: {
        count: eleven.length,
        last: eleven[9],
        blockLine: eleven[10]?.startsWith("Step 'h0' is blocked"),
        countLine: eleven.some((l) => l.startsWith('and ')),
      },
      count: twelve.length,
      first: twelve[0],
      countLine: twelve[10],
      blockLine: twelve.at(-1)?.startsWith("Step 'h0' is blocked"),
      h0Preflight: twelve.includes(preflight(0)),
      big: { count: big.length, countLine: big[10] },
    }).toEqual({
      eleven: { count: 11, last: preflight(10), blockLine: true, countLine: false },
      count: 12,
      first: preflight(1),
      countLine: 'and 1 more step needs a handler or adapter this runner lacks (11 in all)',
      blockLine: true,
      h0Preflight: false,
      big: {
        count: 12,
        countLine: 'and 989 more steps need a handler or adapter this runner lacks (999 in all)',
      },
    });
  });

  it('cell 5b: `start_run`, the ran path — a served step ran, the list bounded', async () => {
    const { call, dir, workflowStore } = await connect();
    const file = join(dir, 'article.txt');
    await writeFile(file, 'FAKE article text\n');
    await workflowStore.register(
      definition(
        'ran12',
        {
          f0: {
            description: 'read',
            execution: 'auto',
            depends_on: [],
            uses_service: 'articles',
            operation: 'read',
            input_map: { path: 'run.params.path' },
          },
          a: { description: 'agent', execution: 'agent', depends_on: ['f0'] },
          ...unmetDef('ran12', 12, ['a']),
        },
        { services: { articles: { adapter: 'filesystem', trust: 'engine_delivered' } } },
      ),
    );
    const r = await call('start_run', { workflow_id: 'ran12', params: { path: file } });
    const w = list(r['warnings']);
    // (a) red when the ran path spreads the list whole (12 lines, no count line); (b) prints the
    //     status, whether the served step ran, the count and the count line.
    expect({
      status: r['status'],
      ran: JSON.stringify(r['chained_auto_steps'] ?? '').includes('f0'),
      count: w.length,
      countLine: w[10],
    }).toEqual({
      status: 'ok',
      ran: true,
      count: 11,
      countLine: 'and 2 more steps need a handler or adapter this runner lacks (12 in all)',
    });
  });

  it('cell 5c: `start_run`, the deduped path — the second call’s list bounded too', async () => {
    const { call, workflowStore } = await connect();
    await workflowStore.register(definition('dup12', unmetDef('dup12', 12)));
    const args = { workflow_id: 'dup12', idempotency_key: 'FAKE-key-1' };
    await call('start_run', args);
    const again = await call('start_run', args);
    const w = list(again['warnings']);
    // (a) red when the deduped reply lists every requirement (12 + the match line); (b) prints the
    //     deduped flag, the count, the count line and the match line.
    expect({
      deduped: again['deduped'],
      count: w.length,
      countLine: w[10],
      matchLine: w[11]?.startsWith('Idempotency key matched a run still in phase'),
    }).toEqual({
      deduped: true,
      count: 12,
      countLine: 'and 2 more steps need a handler or adapter this runner lacks (12 in all)',
      matchLine: true,
    });
  });

  it('cell 6: `start_run_batch` — the list bounded once, each item eleven lines', async () => {
    const { call, workflowStore } = await connect();
    await workflowStore.register(definition('batch10', unmetDef('batch10', 10)));
    await workflowStore.register(definition('batch12', unmetDef('batch12', 12)));
    const ten = ((
      await call('start_run_batch', {
        workflow_id: 'batch10',
        items: [{ params: {} }, { params: {} }, { params: {} }],
      })
    )['started'] ?? []) as Array<{ warnings?: string[] }>;
    const r = await call('start_run_batch', {
      workflow_id: 'batch12',
      items: [{ params: {} }, { params: {} }, { params: {} }],
    });
    const started = (r['started'] ?? []) as Array<{ warnings?: string[] }>;
    // (a) red when the batch's list is not bounded (12 lines an item), or a count line appears at
    //     ten; (b) prints each item's count and count line, and the first line.
    expect({
      ten: ten.map((s) => ({
        count: list(s.warnings).length,
        countLine: list(s.warnings).some((l) => l.startsWith('and ')),
      })),
      items: started.map((s) => ({
        count: list(s.warnings).length,
        countLine: list(s.warnings)[10],
      })),
      first: list(started[0]?.warnings)[0],
    }).toEqual({
      ten: [0, 1, 2].map(() => ({ count: 10, countLine: false })),
      items: [0, 1, 2].map(() => ({
        count: 11,
        countLine: 'and 2 more steps need a handler or adapter this runner lacks (12 in all)',
      })),
      first: `${preflight(0)} (Based on the creation-time registry; the driving runner may differ.)`,
    });
  });
});

describe('the reply bounds: the inbound-marker line on execute_step (M6, the door)', () => {
  it('cell 7: 40,000 distinct markers in `params` — one sentence under 1,500 characters', async () => {
    const { call, agentRun } = await connect();
    const run = await agentRun();
    const params = Object.fromEntries(
      Array.from({ length: 40_000 }, (_, i) => [`m${i}`, `[REDACTED]#${i}`]),
    );
    const r = await call('execute_step', { run_id: run, command: 's0', params });
    const w0 = list(r['warnings'])[0] ?? '';
    // (a) red when the sentence names every marker (789 KB); (b) prints the status, the length
    //     check and the count clause.
    expect({
      status: r['status'],
      short: w0.length < 1500,
      count: /, and \d+ more markers \(\d+ in all\)/.exec(w0)?.[0],
    }).toEqual({ status: 'ok', short: true, count: ', and 39990 more markers (40000 in all)' });
  });
});

describe('the reply bounds: the docs (each sentence with its cell)', () => {
  const TOOLS = 'docs/reference/mcp/tools.md';
  const CL = 'CHANGELOG.md';
  it('tools.md: the unknown keys, `diagnostics`, `create_workflow`’s fields, and the Limits sentence (cells 1–7)', () => {
    claim(
      TOOLS,
      '`create_workflow`, `submit_human_response` and `advance_run` are the exceptions: each names what it ignored, in `warnings`. The first ten are named, then the count.',
    );
    claim(
      TOOLS,
      'The first ten of what was ignored in the request, one entry each; `warnings` carries the count.',
    );
    claim(
      TOOLS,
      'Fields it does not take are left out; the first ten are named in `warnings` and `diagnostics`, and the count is in `warnings`.',
    );
    claim(
      TOOLS,
      "In `warnings`, a reply's list of unknown keys, of steps that need a handler or adapter the runner lacks, of inbound markers, or of numbers JSON cannot carry names the first ten, then the count.",
    );
  });

  it('the CHANGELOG: the six surfaces, `diagnostics`, and the CLI’s marker warning (cells 1–7; core’s M6 cell)', () => {
    claim(
      CL,
      "In `warnings`, a reply's list of unknown keys, of steps that need a handler or adapter the runner lacks, of inbound markers, or of numbers JSON cannot carry names the first ten, then the count: `create_workflow`'s, `advance_run`'s and `submit_human_response`'s unknown keys (`and 1 more unknown key was ignored (11 in all)`; a near miss of `claim_token` is named first), `start_run`'s and `start_run_batch`'s steps that need a handler or adapter the runner lacks, and `execute_step`'s inbound markers.",
    );
    claim(
      CL,
      "`create_workflow`'s `diagnostics` keeps the first ten entries (the count is in `warnings`).",
    );
    claim(
      CL,
      "The CLI's inbound-marker warning (`realm run`, `realm agent`) names the first ten markers too.",
    );
  });
});
