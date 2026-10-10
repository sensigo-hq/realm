// docs-pages-625-run-state.test.ts — issue #625 PR-2a, decision C174 (round 22), pin lane B:
// every sentence of `docs/reference/mcp/run-state-and-health.md` about behaviour #625 PR-2a adds or
// changes is quoted here word for word (read from the repository, whitespace folded) and its case
// is driven on the real code — the MCP server through a real client (`createRealmMcpServer`,
// in-memory transport), the library where the page speaks of a program that embeds the engine, and
// the built `realm` CLI as a child process (fresh HOME) where it speaks of `realm run inspect`,
// `realm run list --stuck` or `realm run resume` — so neither the page nor the behaviour can change
// alone. An example output block is compared line by line, its run and gate IDs put in place.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  loadWorkflowFromString,
  submitHumanResponse,
  type RunStore,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';
import { handleGetRunState } from './get-run-state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(ROOT, 'packages/cli/dist/index.js');
const PAGE = 'docs/reference/mcp/run-state-and-health.md';
const flat = (t: string) => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** The lines of the page's first fenced block that holds `marker`. */
function block(page: string, marker: string): string[] {
  const text = readFileSync(join(ROOT, page), 'utf8');
  const blocks = text.split(/^```[a-z]*\n/m).filter((_, i) => i % 2 === 1);
  const found = blocks.find((b) => b.includes(marker));
  if (found === undefined) throw new Error(`${page} has no block with: ${marker}`);
  return found.replace(/\n```[\s\S]*$/, '').split('\n');
}

type Reply = Record<string, unknown>;

/** A server over a real client. `home` puts its stores where the `realm` CLI reads them. */
async function connect(opts: { registry?: ExtensionRegistry; home?: string } = {}) {
  const base = opts.home ?? (await mkdtemp(join(tmpdir(), 'realm-pin-b-625-')));
  const runsDir = opts.home !== undefined ? join(base, '.realm', 'runs') : join(base, 'runs');
  const wfDir = opts.home !== undefined ? join(base, '.realm', 'workflows') : join(base, 'wf');
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(wfDir, { recursive: true });
  const runStore = new JsonFileStore(runsDir);
  const workflowStore = new JsonWorkflowStore(wfDir);
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docs-pages-625-run-state', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    const text = raw.content[0]!.text;
    try {
      return JSON.parse(text) as Reply;
    } catch {
      return { _text: text };
    }
  };
  return { call, runStore, workflowStore, base, runsDir, wfDir };
}

/** The built `realm`, with a fresh HOME. */
function realm(home: string, args: string[]): { code: number | null; out: string[] } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: home,
    env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => l !== '') };
}

const tools = (r: Reply): string[] =>
  ((r['next_actions'] as Array<{ instruction?: { tool?: string } }>) ?? []).map(
    (n) => n.instruction?.tool ?? '',
  );
const commands = (r: Reply): string[] =>
  (
    (r['next_actions'] as Array<{ instruction?: { call_with?: Record<string, unknown> } }>) ?? []
  ).map((n) => String(n.instruction?.call_with?.['command'] ?? ''));
const kinds = (r: Reply): string[] =>
  ((r['run_health'] as Array<{ kind: string }> | undefined) ?? []).map((f) => f.kind);

const yaml = (lines: string[]): WorkflowDefinition =>
  loadWorkflowFromString(lines.join('\n') + '\n');
function def(id: string, steps: Record<string, Partial<StepDefinition>>): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: steps as Record<string, StepDefinition>,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A registry that has the handler `order_total`. */
function withOrderTotal(): ExtensionRegistry {
  const registry = createDefaultRegistry();
  registry.register('handler', 'order_total', {
    async execute() {
      return { data: { total: 50 } };
    },
  } as never);
  return registry;
}

const WAY_OUT =
  'Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.';

const BOGUS_TRUST = 'bogus_value' as unknown as NonNullable<StepDefinition['trust']>;

describe('#625 PR-2a, C174 pin lane B — run-state-and-health.md, from the real server', () => {
  it(
    'the reply at a gate: next_actions and next_actions_status, line by line as the page shows them',
    { timeout: 30_000 },
    async () => {
      const { call, workflowStore } = await connect();
      await workflowStore.register(
        yaml([
          'id: triage',
          'name: triage',
          'version: 1',
          'steps:',
          '  classify:',
          '    description: Classify.',
          '    execution: agent',
          '  draft:',
          '    description: Draft.',
          '    execution: agent',
          '    depends_on: [classify]',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [send, discard]',
        ]),
      );
      const runId = (await call('start_run', { workflow_id: 'triage', params: { ticket: 101 } }))[
        'run_id'
      ] as string;
      await call('execute_step', { run_id: runId, command: 'classify', params: {} });
      await call('execute_step', {
        run_id: runId,
        command: 'draft',
        params: { reply: 'We have refunded the charge.' },
      });
      const state = await call('get_run_state', { run_id: runId });
      const gateId = (state['pending_gate'] as { gate_id: string }).gate_id;
      const shown = block(PAGE, '"run_phase": "gate_waiting"').map((l) =>
        l
          .replaceAll('7da561ee-5987-497d-83a5-1eded6dc9b63', runId)
          .replaceAll('00bb04f5-1bb7-4f38-91c5-14cdb17b3f0e', gateId),
      );
      const from = shown.indexOf('  "next_actions": [');
      const to = shown.indexOf('  "next_actions_status": "awaiting_human"');
      const real = JSON.stringify(
        { next_actions: state['next_actions'], next_actions_status: state['next_actions_status'] },
        null,
        2,
      ).split('\n');
      // (a) red when any line of the reply's next_actions or its status differs from the page's
      //     block (ids put in place); (b) prints both, line by line.
      expect(from).toBeGreaterThan(0);
      expect(real.slice(1, -1)).toEqual(shown.slice(from, to + 1));
    },
  );

  it(
    'engine_runnable: each owed auto step and runnable_here (true, false or "unknown"); when false refused_by (trust, precondition, input_schema, capability), refusal, and basis for capability',
    { timeout: 30_000 },
    async () => {
      claim(
        PAGE,
        '| `engine_runnable` | The run is open and owes `auto` steps | Each such step and `runnable_here` (`true`, `false` or `"unknown"`). When `false`: `refused_by` (`trust`, `precondition`, `input_schema` or `capability`), `refusal`, and for `capability` a `basis` (`registry` or `marker`). Added after version 0.46.0. |',
      );
      const { call, workflowStore, runStore } = await connect();
      const d = def('er', {
        fine: { description: 'Fine.', execution: 'auto' },
        t: { description: 'T.', execution: 'auto', trust: BOGUS_TRUST },
        p: { description: 'P.', execution: 'auto', preconditions: ['run.params.ok == true'] },
        s: {
          description: 'S.',
          execution: 'auto',
          input_schema: { type: 'object', required: ['sku'] },
        },
        c: { description: 'C.', execution: 'auto', handler: 'order_total' },
      });
      await workflowStore.register(d);
      const batch = await call('start_run_batch', { workflow_id: 'er', items: [{ params: {} }] });
      const runId = (batch['started'] as Array<{ run_id: string }>)[0]!.run_id;
      const state = await call('get_run_state', { run_id: runId });
      const entries = state['engine_runnable'] as Array<Record<string, unknown>>;
      // (a) red when an owed auto step is left out, runnable_here is not true/false as stated, a
      //     refused step lacks refused_by/refusal, or a capability refusal lacks its basis;
      //     (b) prints each entry's step, runnable_here, refused_by and basis.
      expect(
        entries.map((e) => [e['step'], e['runnable_here'], e['refused_by'], e['basis']]),
      ).toEqual([
        ['fine', true, undefined, undefined],
        ['t', false, 'trust', undefined],
        ['p', false, 'precondition', undefined],
        ['s', false, 'input_schema', undefined],
        ['c', false, 'capability', 'registry'],
      ]);
      // (a) red when a refused entry has no refusal text; (b) prints the entries.
      expect(
        entries
          .filter((e) => e['runnable_here'] === false)
          .every((e) => typeof e['refusal'] === 'string' && (e['refusal'] as string).length > 0),
      ).toBe(true);
      // "unknown" and basis marker: a caller that passes no extensions (the tool's own handler, as a
      // program embeds it). A fresh run has no marker: the capability check is unknown.
      const fresh = await handleGetRunState({ run_id: runId }, { runStore, workflowStore });
      const c = (fresh.engine_runnable ?? []).find((e) => e.step === 'c');
      // (a) red when a caller with no extensions and no marker gets anything but "unknown";
      //     (b) prints the entry.
      expect(c).toEqual({ step: 'c', runnable_here: 'unknown' });
      // The server (no project extensions) attempts `c` and records the marker.
      await call('advance_run', { run_id: runId });
      const marked = await handleGetRunState({ run_id: runId }, { runStore, workflowStore });
      // (a) red when a marker-judged refusal does not say basis marker; (b) prints the entry.
      expect((marked.engine_runnable ?? []).find((e) => e.step === 'c')).toMatchObject({
        runnable_here: false,
        refused_by: 'capability',
        basis: 'marker',
      });
    },
  );

  it(
    'agent_refused: each ready agent step refused before its claim, in workflow order — step, runnable_here false, refused_by (trust or precondition), refusal — never in next_actions',
    { timeout: 30_000 },
    async () => {
      claim(
        PAGE,
        '| `agent_refused` | The run is open and an agent step that is ready to start is refused before its claim | Each such step, in the order of the workflow: `step`, `runnable_here` (`false`), `refused_by` (`trust` or `precondition`) and `refusal`. Such a step is never in `next_actions`. Added after version 0.46.0. |',
      );
      const { call, workflowStore } = await connect();
      // Workflow order zeta, alpha, mid — not alphabetical, so the order is the workflow's.
      await workflowStore.register(
        def('ar', {
          zeta: { description: 'Z.', execution: 'agent', trust: BOGUS_TRUST },
          alpha: {
            description: 'A.',
            execution: 'agent',
            preconditions: ['run.params.ok == true'],
          },
          mid: { description: 'M.', execution: 'agent' },
        }),
      );
      const runId = (await call('start_run', { workflow_id: 'ar', params: {} }))[
        'run_id'
      ] as string;
      const state = await call('get_run_state', { run_id: runId });
      const refused = state['agent_refused'] as Array<Record<string, unknown>>;
      // (a) red when the order is not the workflow's, an entry has other fields or values, or a
      //     refused step is offered in next_actions; (b) prints the entries and the offered steps.
      expect({
        refused: refused.map((e) => [
          Object.keys(e).sort(),
          e['step'],
          e['runnable_here'],
          e['refused_by'],
        ]),
        offered: commands(state),
      }).toEqual({
        refused: [
          [['refusal', 'refused_by', 'runnable_here', 'step'], 'zeta', false, 'trust'],
          [['refusal', 'refused_by', 'runnable_here', 'step'], 'alpha', false, 'precondition'],
        ],
        offered: ['mid'],
      });
      // (a) red when the refusal is not the check's own words; (b) prints it.
      expect(refused[1]!['refusal']).toBe(
        "Precondition failed for step 'alpha'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.",
      );
    },
  );

  it(
    'pending_guards and advance_owed: a guard ready that no write has decided, an auto step that can run here, an expired question with on_expiry — the one act, advance_run, which carries the expiry out first',
    { timeout: 30_000 },
    async () => {
      claim(
        PAGE,
        '| `pending_guards` | The run is open and a guard is ready that no write has decided | The guards. Added after version 0.46.0. |',
      );
      claim(
        PAGE,
        "| `advance_owed` | The only work that can run is the engine's: a guard is pending or an `auto` step can run here, or an open question's time is up and it declares `on_expiry`, which `advance_run` carries out first. Added after version 0.46.0, which says `auto_pending` and offers no act, and `awaiting_human` for an expired question. | The one act, `advance_run`. |",
      );
      claim(
        PAGE,
        'A guard that is ready and that no write has decided is owed work: the status is `advance_owed` and `next_actions` holds `advance_run` (see `guard_awaiting_settlement` below).',
      );
      const { call, workflowStore } = await connect();
      await workflowStore.register(
        yaml([
          'id: gfirst',
          'name: gfirst',
          'version: 1',
          'steps:',
          '  limit:',
          '    description: Limit.',
          '    execution: guard',
          '    abort_unless: ["run.params.amount <= 1000"]',
          '  work:',
          '    description: Work.',
          '    execution: agent',
          '    depends_on: [limit]',
        ]),
      );
      await workflowStore.register(
        yaml([
          'id: autoonly',
          'name: autoonly',
          'version: 1',
          'steps:',
          '  a:',
          '    description: A.',
          '    execution: auto',
        ]),
      );
      await workflowStore.register(
        yaml([
          'id: expiring',
          'name: expiring',
          'version: 1',
          'steps:',
          '  approve:',
          '    description: Approve.',
          '    execution: auto',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [ship, hold]',
          '      timeout_seconds: 1',
          '      on_expiry: settle_default',
          '      default_choice: hold',
          '  after:',
          '    description: After.',
          '    execution: auto',
          '    depends_on: [approve]',
        ]),
      );
      const first = async (id: string) =>
        (
          (await call('start_run_batch', { workflow_id: id, items: [{ params: {} }] }))[
            'started'
          ] as Array<{ run_id: string }>
        )[0]!.run_id;
      const g = await call('get_run_state', { run_id: await first('gfirst') });
      const a = await call('get_run_state', { run_id: await first('autoonly') });
      const expRun = (await call('start_run', { workflow_id: 'expiring' }))['run_id'] as string;
      const before = await call('get_run_state', { run_id: expRun });
      await sleep(1_100);
      const e = await call('get_run_state', { run_id: expRun });
      // (a) red when a pending guard, a runnable auto step or a due expiry is not advance_owed with
      //     the one act advance_run, or pending_guards does not name the guard; (b) prints each.
      expect({
        guard: [g['next_actions_status'], tools(g), g['pending_guards']],
        auto: [a['next_actions_status'], tools(a), a['pending_guards']],
        expiredBefore: before['next_actions_status'],
        expired: [e['next_actions_status'], tools(e)],
      }).toEqual({
        guard: ['advance_owed', ['advance_run'], ['limit']],
        auto: ['advance_owed', ['advance_run'], undefined],
        expiredBefore: 'awaiting_human',
        expired: ['advance_owed', ['advance_run']],
      });
      const ran = await call('advance_run', { run_id: expRun });
      const after = await call('get_run_state', { run_id: expRun });
      // (a) red when advance_run does not carry the expiry out first (the default choice), then the
      //     step after it; (b) prints the reply's phase and the steps.
      expect([after['pending_gate'], after['completed_steps'], ran['run_phase']]).toEqual([
        undefined,
        ['approve', 'after'],
        'completed',
      ]);
    },
  );

  it(
    'capability_blocks and the capability_block finding: the marker is shown whatever this server has; the finding only when this server lacks the code too; inspect and list --stuck read the record alone; an ended run has no run_health',
    { timeout: 60_000 },
    async () => {
      claim(
        PAGE,
        "| `capability_blocks` | The run is open and records that the program which last attempted a step lacked its code, and the step has not run since | Each such step, what it needs, and the error code: the record's marker, shown whenever the run carries one, whatever this server has. The `capability_block` finding is narrower: `get_run_state` reports it only when this server lacks the code too (see [The 14 findings](#the-14-findings)). Added after version 0.46.0. |",
      );
      claim(
        PAGE,
        "| `get_run_state` | The findings of a run that is open, judged with this server's extensions: a `capability_block` finding only when this server lacks the code too. (added after version 0.46.0) For a run that has ended, `run_health` is absent. |",
      );
      claim(
        PAGE,
        '`get_run_state` leaves the finding out for a step its own server can run (the record stays in `capability_blocks`); `inspect` and `list --stuck` read the record alone.',
      );
      const home = await mkdtemp(join(tmpdir(), 'realm-pin-b-625-home-'));
      const lacking = await connect({ home });
      const having = await connect({ home, registry: withOrderTotal() });
      await lacking.workflowStore.register(
        yaml([
          'id: price',
          'name: price',
          'version: 1',
          'steps:',
          '  total:',
          '    description: Total.',
          '    execution: auto',
          '    handler: order_total',
          '  confirm:',
          '    description: Confirm.',
          '    execution: agent',
          '    depends_on: [total]',
        ]),
      );
      const batch = async () =>
        (
          (
            await lacking.call('start_run_batch', { workflow_id: 'price', items: [{ params: {} }] })
          )['started'] as Array<{ run_id: string }>
        )[0]!.run_id;
      const runId = await batch();
      const unattempted = await lacking.call('get_run_state', { run_id: runId });
      // The server without the handler attempts the step: the run records the marker.
      await lacking.call('advance_run', { run_id: runId });
      const l = await lacking.call('get_run_state', { run_id: runId });
      const h = await having.call('get_run_state', { run_id: runId });
      const marker = [
        {
          step: 'total',
          requirement: { kind: 'handler', name: 'order_total' },
          code: 'ENGINE_HANDLER_NOT_REGISTERED',
        },
      ];
      // (a) red when the marker is shown before any attempt, is not shown to a server that has the
      //     code, or the finding is reported by a server that can run the step (or not by one that
      //     cannot); (b) prints both servers' fields.
      expect({
        unattempted: unattempted['capability_blocks'],
        lacking: [l['capability_blocks'], kinds(l)],
        having: [h['capability_blocks'], kinds(h)],
      }).toEqual({
        unattempted: undefined,
        lacking: [marker, ['capability_block']],
        having: [marker, []],
      });
      // inspect and list --stuck read the record alone.
      const inspected = realm(home, ['run', 'inspect', runId]).out;
      const stuck = realm(home, ['run', 'list', '--stuck']).out;
      // (a) red when inspect or list --stuck leave the finding out; (b) prints their lines.
      expect([
        inspected.some((x) => x.includes('capability_block')),
        stuck.find((x) => x.startsWith(runId)) ?? stuck.join(' / '),
      ]).toEqual([true, expect.stringContaining("total: needs handler 'order_total'")]);
      // The step runs on the server that has it: the run stays open (`confirm` is ready) and the
      // record no longer says the step lacks its code.
      await having.call('advance_run', { run_id: runId });
      const ranOpen = await lacking.call('get_run_state', { run_id: runId });
      // A second run carries the finding while open; once it has ended, run_health is absent.
      const second = await batch();
      await lacking.call('advance_run', { run_id: second });
      const openSecond = await lacking.call('get_run_state', { run_id: second });
      await lacking.call('abandon_run', { run_id: second });
      const ended = await lacking.call('get_run_state', { run_id: second });
      // (a) red when the marker outlives the run of its step on an open run, or run_health is
      //     given for an ended run that carried a finding while open; (b) prints the replies.
      expect({
        ranOpen: [
          ranOpen['terminal_state'],
          ranOpen['completed_steps'],
          ranOpen['capability_blocks'],
        ],
        second: [kinds(openSecond), ended['terminal_state'], 'run_health' in ended],
      }).toEqual({
        ranOpen: [false, ['total'], undefined],
        second: [['capability_block'], true, false],
      });
    },
  );

  it(
    'awaiting_human: a gate open whose time is not up, or that declares no on_expiry — the answer, submit_human_response, without a claim_token',
    { timeout: 30_000 },
    async () => {
      claim(
        PAGE,
        "| `awaiting_human` | A gate is open, and its time is not up — or it declares no `on_expiry`. | The question's answer, `submit_human_response`, without a `claim_token`. Added after version 0.46.0, which leaves it empty. |",
      );
      const { call, workflowStore } = await connect();
      const gated = (id: string, extra: string[]) =>
        yaml([
          `id: ${id}`,
          `name: ${id}`,
          'version: 1',
          'steps:',
          '  approve:',
          '    description: Approve.',
          '    execution: auto',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [ship, hold]',
          ...extra,
        ]);
      await workflowStore.register(
        gated('notup', [
          '      timeout_seconds: 3600',
          '      on_expiry: settle_default',
          '      default_choice: hold',
        ]),
      );
      await workflowStore.register(gated('noexpiry', ['      timeout_seconds: 1']));
      const notUp = await call('get_run_state', {
        run_id: (await call('start_run', { workflow_id: 'notup' }))['run_id'] as string,
      });
      const noExpiryId = (await call('start_run', { workflow_id: 'noexpiry' }))['run_id'] as string;
      await sleep(1_100);
      const past = await call('get_run_state', { run_id: noExpiryId });
      const answer = (r: Reply) => {
        const n = (
          r['next_actions'] as Array<{ instruction: { tool: string; call_with: Reply } }>
        )[0]!;
        return [
          n.instruction.tool,
          'claim_token' in n.instruction.call_with,
          r['next_actions_status'],
        ];
      };
      // (a) red when either open gate is not awaiting_human, its next_actions is not the answer, or
      //     the answer carries a claim_token; (b) prints tool, token presence and status.
      expect([answer(notUp), answer(past), (past['next_actions'] as unknown[]).length]).toEqual([
        ['submit_human_response', false, 'awaiting_human'],
        ['submit_human_response', false, 'awaiting_human'],
        1,
      ]);
    },
  );

  it(
    'blocked_on_capability: an owed step needs code this server lacks and nothing else is owed — judged with the server’s own extensions (an empty set with none); a server that has it says advance_owed; empty, or the ready agent steps',
    { timeout: 30_000 },
    async () => {
      claim(
        PAGE,
        "| `blocked_on_capability` | An owed step needs a handler or an adapter that this server does not have, and nothing else is owed to the engine. A server judges with its own extensions (an empty set when it has no project extensions). A server that has it says `advance_owed`. Judging with the server's own extensions was added after version 0.46.0. | Empty, or the agent steps that are ready. |",
      );
      const home = await mkdtemp(join(tmpdir(), 'realm-pin-b-625-cap-'));
      const plain = await connect({ home });
      const having = await connect({ home, registry: withOrderTotal() });
      const total = { description: 'Total.', execution: 'auto' as const, handler: 'order_total' };
      await plain.workflowStore.register(def('cap1', { total }));
      await plain.workflowStore.register(
        def('cap2', { total, ask: { description: 'Ask.', execution: 'agent' } }),
      );
      await plain.workflowStore.register(
        def('cap3', { total, other: { description: 'Other.', execution: 'auto' } }),
      );
      const batch = async (id: string) =>
        (
          (await plain.call('start_run_batch', { workflow_id: id, items: [{ params: {} }] }))[
            'started'
          ] as Array<{ run_id: string }>
        )[0]!.run_id;
      const r1 = await batch('cap1');
      const s1 = await plain.call('get_run_state', { run_id: r1 });
      const s2 = await plain.call('get_run_state', { run_id: await batch('cap2') });
      const s3 = await plain.call('get_run_state', { run_id: await batch('cap3') });
      const h1 = await having.call('get_run_state', { run_id: r1 });
      // (a) red when a server with no project extensions does not judge the step (before any
      //     attempt: no marker), the status is not blocked_on_capability with empty next_actions or
      //     the ready agent step, another owed step does not make it advance_owed, or a server that
      //     has the handler does not say advance_owed; (b) prints each status and act.
      expect({
        alone: [s1['next_actions_status'], tools(s1), s1['capability_blocks']],
        basis: (s1['engine_runnable'] as Array<Reply>)[0]!['basis'],
        withAgent: [s2['next_actions_status'], commands(s2)],
        withOtherOwed: s3['next_actions_status'],
        serverHasIt: [h1['next_actions_status'], tools(h1)],
      }).toEqual({
        alone: ['blocked_on_capability', [], undefined],
        basis: 'registry',
        withAgent: ['blocked_on_capability', ['ask']],
        withOtherOwed: 'advance_owed',
        serverHasIt: ['advance_owed', ['advance_run']],
      });
    },
  );

  it(
    'ok with an empty next_actions on an open run: a step in flight elsewhere, or every step that could run next cannot — engine_runnable or agent_refused names it',
    { timeout: 30_000 },
    async () => {
      claim(PAGE, '`ok` with an empty `next_actions` on an open run means one of two things.');
      claim(PAGE, 'A step is in flight elsewhere: wait for it.');
      claim(
        PAGE,
        'Or every step that could run next cannot: an `auto` step for an invalid `trust`, a failed precondition or an input its schema refuses — `engine_runnable` names each with `refused_by` and `refusal` — or an agent step for an invalid `trust` or a failed precondition — `agent_refused` names it the same way, and it is never offered in `next_actions` (agent steps added after version 0.46.0).',
      );
      const { call, workflowStore, runStore } = await connect();
      // In flight elsewhere: a program holds the auto step's claim, within its time.
      const flight = def('flight', { x: { description: 'X.', execution: 'auto' } });
      await workflowStore.register(flight);
      const fRun = (
        (await call('start_run_batch', { workflow_id: 'flight', items: [{ params: {} }] }))[
          'started'
        ] as Array<{ run_id: string }>
      )[0]!.run_id;
      await runStore.claimStep(fRun, 'x', flight);
      const inFlight = await call('get_run_state', { run_id: fRun });
      // (a) red when a healthy claim elsewhere is not ok with empty next_actions; (b) prints them.
      expect([
        inFlight['next_actions_status'],
        inFlight['next_actions'],
        inFlight['in_progress_steps'],
      ]).toEqual(['ok', [], ['x']]);
      const cases: Array<
        [string, Partial<StepDefinition>, 'engine_runnable' | 'agent_refused', string]
      > = [
        ['auto-trust', { execution: 'auto', trust: BOGUS_TRUST }, 'engine_runnable', 'trust'],
        [
          'auto-pre',
          { execution: 'auto', preconditions: ['run.params.ok == true'] },
          'engine_runnable',
          'precondition',
        ],
        [
          'auto-schema',
          { execution: 'auto', input_schema: { type: 'object', required: ['sku'] } },
          'engine_runnable',
          'input_schema',
        ],
        ['agent-trust', { execution: 'agent', trust: BOGUS_TRUST }, 'agent_refused', 'trust'],
        [
          'agent-pre',
          { execution: 'agent', preconditions: ['run.params.ok == true'] },
          'agent_refused',
          'precondition',
        ],
      ];
      const seen: unknown[] = [];
      for (const [id, step, field] of cases) {
        await workflowStore.register(def(id, { only: { description: 'Only.', ...step } }));
        const runId = (
          (await call('start_run_batch', { workflow_id: id, items: [{ params: {} }] }))[
            'started'
          ] as Array<{ run_id: string }>
        )[0]!.run_id;
        const s = await call('get_run_state', { run_id: runId });
        const named = ((s[field] as Array<Reply> | undefined) ?? [])[0];
        seen.push([
          s['next_actions_status'],
          s['next_actions'],
          named?.['step'],
          named?.['refused_by'],
          typeof named?.['refusal'],
        ]);
      }
      // (a) red when a step refused for one of the five reasons is offered, the status is not ok, or
      //     its field does not name it with refused_by and refusal; (b) prints each case.
      expect(seen).toEqual(cases.map(([, , , by]) => ['ok', [], 'only', by, 'string']));
    },
  );

  it(
    'the way out: waiting does not help; every reply that says what comes next ends with it; the run picks up the corrected definition, or abandon_run ends it; a handler refusal says basis registry',
    { timeout: 30_000 },
    async () => {
      claim(
        PAGE,
        // F15: the one fix is for a refused `trust` or precondition (this cell's steps).
        'Waiting does not help then: for a refused `trust` or precondition the run cannot go on until the workflow is corrected and registered again (the run picks up the corrected definition), or it is ended with `abandon_run`;',
      );
      claim(
        PAGE,
        "Every reply that says what comes next ends with that way out — the reply of the step or the answer that left the run there, `start_run`'s creation reply, and `advance_run`'s reply, which runs nothing: `Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.`, or, with a step refused for its input, each step's own way and then the run's ([MCP tools](tools.md#advance_run); added after version 0.46.0). A step refused for its handler or adapter also says what it was judged from, in `basis` (added after version 0.46.0): `registry` — the server's own extensions lack it (`refusal`: `handler '<name>' is not registered here`).",
      );
      const { call, workflowStore } = await connect();
      // start_run's creation reply: the head auto step is refused.
      const broken = def('fixme', {
        x: { description: 'X.', execution: 'auto', preconditions: ['run.params.ok == true'] },
      });
      await workflowStore.register(broken);
      const created = await call('start_run', { workflow_id: 'fixme', params: {} });
      const runId = created['run_id'] as string;
      const advanced = await call('advance_run', { run_id: runId });
      const waited = await call('get_run_state', { run_id: runId });
      // The step's reply: `a` completes and leaves `b` refused.
      await workflowStore.register(
        def('afterstep', {
          a: { description: 'A.', execution: 'agent' },
          b: {
            description: 'B.',
            execution: 'agent',
            depends_on: ['a'],
            preconditions: ['run.params.ok == true'],
          },
        }),
      );
      const sRun = (await call('start_run', { workflow_id: 'afterstep', params: {} }))[
        'run_id'
      ] as string;
      const stepped = await call('execute_step', { run_id: sRun, command: 'a', params: {} });
      // The answer's reply: the answer leaves `b` refused.
      await workflowStore.register(
        def('afteranswer', {
          q: {
            description: 'Q.',
            execution: 'agent',
            trust: 'human_confirmed',
            gate: { choices: ['yes', 'no'] },
          },
          b: {
            description: 'B.',
            execution: 'agent',
            depends_on: ['q'],
            preconditions: ['run.params.ok == true'],
          },
        }),
      );
      const aRun = (await call('start_run', { workflow_id: 'afteranswer', params: {} }))[
        'run_id'
      ] as string;
      const opened = await call('execute_step', { run_id: aRun, command: 'q', params: {} });
      const gateId =
        (opened['gate'] as { gate_id: string } | undefined)?.gate_id ??
        ((await call('get_run_state', { run_id: aRun }))['pending_gate'] as { gate_id: string })
          .gate_id;
      const answered = await call('submit_human_response', {
        run_id: aRun,
        gate_id: gateId,
        choice: 'yes',
      });
      const hint = (r: Reply) => String(r['context_hint']);
      // (a) red when any of the four replies does not end with the way out, advance_run runs
      //     something, or waiting changes the run; (b) prints the four hints.
      expect({
        start: hint(created).endsWith(WAY_OUT),
        advance: [hint(advanced).endsWith(WAY_OUT), hint(advanced).includes('nothing ran')],
        step: hint(stepped).endsWith(WAY_OUT),
        answer: hint(answered).endsWith(WAY_OUT),
        waited: [waited['next_actions_status'], waited['completed_steps']],
      }).toEqual({
        start: true,
        advance: [true, true],
        step: true,
        answer: true,
        waited: ['ok', []],
      });
      // Corrected and registered again: the run picks up the corrected definition.
      await workflowStore.register(def('fixme', { x: { description: 'X.', execution: 'auto' } }));
      const fixed = await call('advance_run', { run_id: runId });
      // Or it is ended with abandon_run.
      const ended = await call('abandon_run', { run_id: sRun });
      // (a) red when the corrected definition is not picked up, or abandon_run does not end the run;
      //     (b) prints both phases.
      expect([
        fixed['run_phase'],
        ended['run_phase'] ?? ended['_text'] ?? ended,
        (await call('get_run_state', { run_id: sRun }))['run_phase'],
      ]).toEqual(['completed', 'abandoned', 'abandoned']);
      // basis registry: the server's own extensions lack the handler.
      await workflowStore.register(
        def('nohandler', {
          total: { description: 'T.', execution: 'auto', handler: 'order_total' },
        }),
      );
      const nh = await call('get_run_state', {
        run_id: (await call('start_run', { workflow_id: 'nohandler' }))['run_id'] as string,
      });
      // (a) red when the refusal is not judged from the server's own extensions in those words;
      //     (b) prints the entry.
      expect((nh['engine_runnable'] as Array<Reply>)[0]).toEqual({
        step: 'total',
        runnable_here: false,
        refused_by: 'capability',
        refusal: "handler 'order_total' is not registered here",
        basis: 'registry',
      });
    },
  );

  it(
    'every server judges with its own extensions; only a caller passing none judges by the marker (basis marker, its refusal); with neither, runnable_here "unknown"',
    { timeout: 30_000 },
    async () => {
      claim(
        PAGE,
        'Every server judges this way: one with no project extensions has an empty set of them.',
      );
      claim(
        PAGE,
        "Only a caller that passes no extensions at all — a program that embeds the engine — judges by the run's `capability_blocks` record of the last attempt: `basis` `marker`, `refusal` `handler '<name>' was not registered in the runner that last attempted it`.",
      );
      claim(PAGE, 'With neither, `runnable_here: "unknown"`.');
      // A server given no registry at all, and one given an empty one.
      const home = await mkdtemp(join(tmpdir(), 'realm-pin-b-625-judge-'));
      const none = await connect({ home });
      const empty = await connect({ home, registry: new ExtensionRegistry() });
      const d = def('judge', {
        total: { description: 'T.', execution: 'auto', handler: 'order_total' },
      });
      await none.workflowStore.register(d);
      const runId = (
        (await none.call('start_run_batch', { workflow_id: 'judge', items: [{ params: {} }] }))[
          'started'
        ] as Array<{ run_id: string }>
      )[0]!.run_id;
      const program = () =>
        handleGetRunState(
          { run_id: runId },
          { runStore: none.runStore, workflowStore: none.workflowStore },
        );
      const neither = await program();
      const fromNone = await none.call('get_run_state', { run_id: runId });
      // The marker: the server attempts the step without the handler.
      await none.call('advance_run', { run_id: runId });
      const marked = await program();
      const fromEmpty = await empty.call('get_run_state', { run_id: runId });
      const basis = (r: Reply) => (r['engine_runnable'] as Array<Reply>)[0]!['basis'];
      // (a) red when a server with no project extensions does not judge with an empty set (basis
      //     registry, before any marker), a caller with no extensions does not read the marker in
      //     those words, or with neither it is not "unknown"; (b) prints each entry.
      expect({
        serverNone: basis(fromNone),
        serverEmpty: basis(fromEmpty),
        program: marked.engine_runnable?.[0],
        neither: neither.engine_runnable?.[0],
      }).toEqual({
        serverNone: 'registry',
        serverEmpty: 'registry',
        program: {
          step: 'total',
          runnable_here: false,
          refused_by: 'capability',
          refusal: "handler 'order_total' was not registered in the runner that last attempted it",
          basis: 'marker',
        },
        neither: { step: 'total', runnable_here: 'unknown' },
      });
    },
  );

  it(
    'include_steps answers: choice; answered_by stated, not_stated, name_unreadable or settled_by_expiry; claim_proof',
    { timeout: 30_000 },
    async () => {
      claim(
        PAGE,
        'One entry for each answer to the step\'s gate: `choice`; `answered_by`, which is `{ "by": …, "by_source": "stated" }` (the name the caller gave, not verified) or `{ "by": null, "absent_cause": … }` with `not_stated` (the caller gave no name), `name_unreadable` (a stored name that cannot be shown) or `settled_by_expiry` (the gate\'s expiry wrote its default choice: no answer was recorded in time); and `claim_proof`, the verdict of [the claim token](tools.md#the-claim-token).',
      );
      const { call, workflowStore, runStore } = await connect();
      await workflowStore.register(
        yaml([
          'id: ans',
          'name: ans',
          'version: 1',
          'steps:',
          '  review:',
          '    description: Review.',
          '    execution: agent',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [send, discard]',
        ]),
      );
      await workflowStore.register(
        yaml([
          'id: ansexp',
          'name: ansexp',
          'version: 1',
          'steps:',
          '  review:',
          '    description: Review.',
          '    execution: auto',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [send, discard]',
          '      timeout_seconds: 1',
          '      on_expiry: settle_default',
          '      default_choice: discard',
        ]),
      );
      const answerOne = async (extra: Reply) => {
        const runId = (await call('start_run', { workflow_id: 'ans' }))['run_id'] as string;
        const opened = await call('execute_step', { run_id: runId, command: 'review', params: {} });
        const callWith = (
          opened['next_actions'] as Array<{ instruction: { call_with: Reply } }>
        )[0]!.instruction.call_with;
        await call('submit_human_response', { ...callWith, choice: 'send', ...extra });
        return runId;
      };
      const answersOf = async (runId: string) =>
        (
          (await call('get_run_state', { run_id: runId, include_steps: true }))['steps'] as Record<
            string,
            { answers?: Array<Reply> }
          >
        )['review']!.answers ?? [];
      const named = await answersOf(await answerOne({ responded_by: 'ana' }));
      const unnamed = await answersOf(await answerOne({}));
      // A stored name that cannot be shown: the record's answer entry carries a name that is not text.
      const unreadableRun = await answerOne({ responded_by: 'ana' });
      const rec = await runStore.get(unreadableRun);
      const entry = rec.evidence.find(
        (x) => (x as unknown as Reply)['kind'] === 'gate_response',
      ) as unknown as Reply;
      entry['responded_by'] = { not: 'a name' };
      await runStore.update(rec);
      const unreadable = await answersOf(unreadableRun);
      const expRun = (await call('start_run', { workflow_id: 'ansexp' }))['run_id'] as string;
      await sleep(1_100);
      await call('advance_run', { run_id: expRun });
      const expired = await answersOf(expRun);
      // (a) red when an answer's choice, answered_by or claim_proof is not as the page states for
      //     each of the four answerers; (b) prints the answers.
      expect({
        named: [
          named.length,
          named[0]!['choice'],
          named[0]!['answered_by'],
          'claim_proof' in named[0]!,
        ],
        unnamed: [unnamed[0]!['answered_by'], 'claim_proof' in unnamed[0]!],
        unreadable: unreadable[0]!['answered_by'],
        expired: [expired[0]!['choice'], expired[0]!['answered_by']],
      }).toEqual({
        named: [1, 'send', { by: 'ana', by_source: 'stated' }, true],
        unnamed: [{ by: null, absent_cause: 'not_stated' }, true],
        unreadable: { by: null, absent_cause: 'name_unreadable' },
        expired: ['discard', { by: null, absent_cause: 'settled_by_expiry' }],
      });
    },
  );

  it(
    'wedged_gate_sibling: the status stays awaiting_human until the gate’s time is up when it declares on_expiry; then a step past its time makes it claim_stale',
    { timeout: 30_000 },
    async () => {
      claim(
        PAGE,
        "`next_actions_status` stays `awaiting_human` — until the gate's time is up when it declares `on_expiry`; the status is then worked out as for a run with no gate, so a step past its time makes it `claim_stale` (added after version 0.46.0):",
      );
      const { call, workflowStore, runStore } = await connect();
      const fan = def('fan', {
        approve: {
          description: 'Approve.',
          execution: 'agent',
          trust: 'human_confirmed',
          gate: { choices: ['ship', 'hold'], timeout_seconds: 2, on_expiry: 'abort' },
        },
        fetch: { description: 'Fetch.', execution: 'auto' },
      });
      await workflowStore.register(fan);
      const runId = (
        (await call('start_run_batch', { workflow_id: 'fan', items: [{ params: {} }] }))[
          'started'
        ] as Array<{ run_id: string }>
      )[0]!.run_id;
      // A program takes `fetch`, and its process dies: the claim is past its time.
      await runStore.claimStep(runId, 'fetch', fan);
      await call('execute_step', { run_id: runId, command: 'approve', params: {} });
      const rec = await runStore.get(runId);
      rec.claims = {
        ...rec.claims,
        fetch: { ...rec.claims!['fetch']!, deadline: new Date(Date.now() - 60_000).toISOString() },
      };
      await runStore.update(rec);
      const before = await call('get_run_state', { run_id: runId });
      await sleep(2_100);
      const after = await call('get_run_state', { run_id: runId });
      // (a) red when the status leaves awaiting_human before the time is up, or stays there after it
      //     with a step past its time; (b) prints both statuses and findings.
      expect({
        before: [
          before['next_actions_status'],
          kinds(before),
          before['pending_gate'] !== undefined,
        ],
        after: [after['next_actions_status'], after['pending_gate'] !== undefined],
      }).toEqual({
        before: ['awaiting_human', ['wedged_gate_sibling'], true],
        after: ['claim_stale', true],
      });
    },
  );

  it(
    'guard_awaiting_settlement: ready when the run is created by start_run_batch or a program, when realm run resume opens it again at a failed guard, or in a store that does not settle in one write',
    { timeout: 60_000 },
    async () => {
      claim(
        PAGE,
        'That is a guard that is ready when the run is created by `start_run_batch` or by a program, as here, or when `realm run resume` opens the run again at a failed guard, or a run kept in a store that does not settle in one write.',
      );
      const home = await mkdtemp(join(tmpdir(), 'realm-pin-b-625-guard-'));
      const { call, workflowStore, runStore } = await connect({ home });
      const limit = def('limit', {
        limit: {
          description: 'Limit.',
          execution: 'guard',
          abort_unless: ['run.params.amount <= 1000'],
        },
        work: { description: 'Work.', execution: 'agent', depends_on: ['limit'] },
      });
      await workflowStore.register(limit);
      const finding = async (runId: string) =>
        kinds(await call('get_run_state', { run_id: runId }));
      // start_run_batch.
      const batched = (
        (
          await call('start_run_batch', {
            workflow_id: 'limit',
            items: [{ params: { amount: 5 } }],
          })
        )['started'] as Array<{ run_id: string }>
      )[0]!.run_id;
      // A program.
      const { run: made } = await runStore.create({
        workflowId: 'limit',
        workflowVersion: 1,
        params: { amount: 5 },
      });
      // realm run resume at a failed guard: the guard is decided, and fails, by advance_run; resume
      // opens the run again with the guard ready.
      const failing = def('failing', {
        check: {
          description: 'Check.',
          execution: 'guard',
          abort_unless: ['nothing.here == true'],
        },
        work: { description: 'Work.', execution: 'agent', depends_on: ['check'] },
      });
      await workflowStore.register(failing);
      const fRun = (
        (await call('start_run_batch', { workflow_id: 'failing', items: [{ params: {} }] }))[
          'started'
        ] as Array<{ run_id: string }>
      )[0]!.run_id;
      await call('advance_run', { run_id: fRun });
      const failed = await call('get_run_state', { run_id: fRun });
      const resumed = realm(home, ['run', 'resume', fRun, '--from', 'check']);
      // A store that does not settle in one write: the gate's answer and the guard after it.
      const gateGuard = def('gg', {
        confirm: {
          description: 'Confirm.',
          execution: 'agent',
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
        check: {
          description: 'Check.',
          execution: 'guard',
          depends_on: ['confirm'],
          abort_unless: ["confirm.choice == 'approve'"],
        },
        finish: { description: 'Finish.', execution: 'agent', depends_on: ['check'] },
      });
      await workflowStore.register(gateGuard);
      const gRun = (await call('start_run', { workflow_id: 'gg' }))['run_id'] as string;
      await call('execute_step', { run_id: gRun, command: 'confirm', params: {} });
      const twoWrites = new Proxy(runStore, {
        get(target, prop, receiver) {
          if (prop === 'settleStep') return undefined;
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as unknown as RunStore;
      const gateId = (await runStore.get(gRun)).pending_gate!.gate_id;
      await submitHumanResponse(twoWrites, gateGuard, { runId: gRun, gateId, choice: 'approve' });
      // (a) red when any of the four ways leaves the guard ready without the finding, or the guard
      //     did not fail before the resume; (b) prints each run's findings and the resume's output.
      expect({
        batch: await finding(batched),
        program: await finding(made.id),
        failedBefore: [failed['run_phase'], failed['failed_steps']],
        resume: [resumed.code, await finding(fRun)],
        twoWrites: await finding(gRun),
      }).toEqual({
        batch: ['guard_awaiting_settlement'],
        program: ['guard_awaiting_settlement'],
        failedBefore: ['failed', ['check']],
        resume: [0, ['guard_awaiting_settlement']],
        twoWrites: ['guard_awaiting_settlement'],
      });
    },
  );
});
