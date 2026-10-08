// docs-pages-625-guides.test.ts — issue #625 PR-2a, decision C174 (round 22), pin lane E2: the
// guides, the other reference pages and the core and MCP READMEs. Each sentence on those pages that
// says what an MCP tool or a library function does, and that #625 PR-2a added or changed, is quoted
// here (read from the repository, whitespace folded) and the case it states is driven over a real
// MCP client (`createRealmMcpServer`, in-memory transport) or on the library, so neither the page
// nor the behaviour can change alone. An example reply is compared line by line with its IDs put in
// place.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  advanceRun,
  createDefaultRegistry,
  executeChain,
  executeEngineStep,
  executeStep,
  loadWorkflowFromString,
  submitHumanResponse,
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

/** The lines of the page's first fenced block that holds `marker`. */
function block(page: string, marker: string): string[] {
  const text = readFileSync(join(ROOT, page), 'utf8');
  const blocks = text.split(/^```[a-z]*\n/m).filter((_, i) => i % 2 === 1);
  const found = blocks.find((b) => b.includes(marker));
  if (found === undefined) throw new Error(`${page} has no block with: ${marker}`);
  return found
    .replace(/\n```[\s\S]*$/, '')
    .split('\n')
    .filter((l) => l !== '');
}

type Reply = Record<string, unknown>;

async function connect(registry?: ExtensionRegistry) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-pages-625-e2-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    ...(registry !== undefined ? { registry } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docs-pages-625-e2', version: '0' });
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
  return { call, client, runStore, workflowStore };
}

const tools = (r: Reply): string[] =>
  ((r['next_actions'] as Array<{ instruction?: { tool?: string } }>) ?? []).map(
    (n) => n.instruction?.tool ?? '',
  );
const nextCall = (r: Reply): string => {
  const n = (r['next_actions'] as Array<{ instruction: { tool: string; params: Reply } }>)[0]!;
  return `${n.instruction.tool} ${String(n.instruction.params['command'])}`;
};

const wf = (lines: string[]): WorkflowDefinition =>
  loadWorkflowFromString([...lines, ''].join('\n'));

describe('#625 PR-2a, C174 lane E2 — guides, reference pages and READMEs: MCP replies and the library', () => {
  it('agent-created-workflows.md: create_workflow’s reply and the refusal of a step called too early, line by line', async () => {
    const page = 'docs/guides/agent-created-workflows.md';
    const plan = JSON.parse(block(page, '"task_description"').join('\n')) as Reply;
    const { call } = await connect();
    const c = await call('create_workflow', plan);
    const runId = c['run_id'] as string;
    // (a) red when the reply's lines are not the page's (the run ID aside) — its status, the
    //     workflow ID made from the plan, the sentence that names the ready step, or the next
    //     call; (b) prints both.
    expect([
      `status: ${String(c['status'])}`,
      `workflow_id: ${String((c['data'] as Reply)['workflow_id'])}`,
      `run_id: ${runId}`,
      String(c['context_hint']),
      `next: ${nextCall(c)}`,
    ]).toEqual(
      block(page, 'status: ok').map((l) =>
        l.replaceAll('4fe4f2e3-14b4-4f9c-9e8c-b96052cb8ed9', runId),
      ),
    );
    const g = await call('execute_step', { run_id: runId, command: 'group', params: {} });
    // (a) red when the refusal is not the page's: its status, its reason, or the step it says is
    //     ready; (b) prints both.
    expect([
      `status: ${String(g['status'])}`,
      String(g['context_hint']),
      `eligible_steps: ${((g['blocked_reason'] as Reply)['eligible_steps'] as string[]).join(', ')}`,
    ]).toEqual(block(page, 'status: blocked'));
  });

  it('call-a-service.md: without realm.yaml the step that uses the adapter is blocked and the run waits; execute_step is refused with the page’s line', async () => {
    const page = 'docs/guides/call-a-service.md';
    claim(
      page,
      'If `realm.yaml` is missing, a step that uses the adapter is blocked, and the run waits.',
    );
    const shown = block(page, "Adapter 'github' for service 'github' is not registered.")[0]!;
    // No realm.yaml: the server has only the built-in adapters, as `realm mcp` in a folder without one.
    const { call, workflowStore } = await connect(createDefaultRegistry());
    await workflowStore.register(
      wf([
        'id: issues',
        'name: issues',
        'version: 1',
        'services:',
        '  github:',
        '    adapter: github',
        '    trust: engine_delivered',
        'steps:',
        '  open:',
        '    description: Open an issue.',
        '    execution: auto',
        '    uses_service: github',
        '    operation: create_issue',
      ]),
    );
    const s = await call('start_run', { workflow_id: 'issues' });
    const runId = s['run_id'] as string;
    const r = await call('execute_step', { run_id: runId, command: 'open', params: {} });
    const state = await call('get_run_state', { run_id: runId });
    // (a) red when the step is not reported blocked, the run fails or ends, or the refusal's line
    //     is not the page's (up to its `…`); (b) prints what each said.
    expect({
      blocked: String(r['context_hint']).startsWith("Step 'open' is blocked: "),
      phase: state['run_phase'],
      terminal: state['terminal_state'],
      failed: state['failed_steps'],
      refusal: String((r['errors'] as string[])[0]).startsWith(shown.replace(' …', '')),
    }).toEqual({ blocked: true, phase: 'running', terminal: false, failed: [], refusal: true });
  });

  it('connect-an-mcp-client.md, glossary.md, packages/mcp-server/README.md: the server has 11 tools, advance_run among them, each in the guide’s table', async () => {
    claim(
      'docs/guides/connect-an-mcp-client.md',
      'The assistant now has eleven tools (`advance_run` was added after version 0.46.0, which has ten):',
    );
    claim(
      'docs/reference/glossary.md',
      'Realm is an MCP server with 11 tools (10 in version 0.46.0).',
    );
    claim(
      'packages/mcp-server/README.md',
      'Creates the MCP server with all 11 tools pre-registered.',
    );
    const { client } = await connect();
    const listed = (await client.listTools()).tools.map((t) => t.name);
    const guide = readFileSync(join(ROOT, 'docs/guides/connect-an-mcp-client.md'), 'utf8');
    const rows = [...guide.matchAll(/^\| `([a-z_]+)` +\|/gm)].map((m) => m[1]!);
    // (a) red when a tool is added or removed without the pages, or the guide's table differs
    //     from the server's list; (b) prints both.
    expect([listed.length, listed.includes('advance_run'), [...rows].sort()]).toEqual([
      11,
      true,
      [...listed].sort(),
    ]);
  });

  it('connect-an-mcp-client.md: advance_run runs the guards and automatic steps a run owes, when next_actions names it', async () => {
    claim(
      'docs/guides/connect-an-mcp-client.md',
      '| `advance_run` | Runs the guards and automatic steps a run owes (when named). |',
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf([
        'id: owes',
        'name: owes',
        'version: 1',
        'steps:',
        '  read:',
        '    description: Read the order.',
        '    execution: auto',
        '  check:',
        '    description: Go on only for a live order.',
        '    execution: guard',
        '    depends_on: [read]',
        '    abort_unless: ["read.live == true"]',
        '  ship:',
        '    description: Ship.',
        '    execution: auto',
        '    depends_on: [check]',
      ]),
    );
    // A batch run runs no step: it owes the engine `read`, the guard `check` and `ship`.
    const batch = await call('start_run_batch', {
      workflow_id: 'owes',
      items: [{ params: { live: true } }],
    });
    const entry = (batch['started'] as Array<{ run_id: string; next_actions: unknown[] }>)[0]!;
    const r = await call('advance_run', { run_id: entry.run_id });
    const state = await call('get_run_state', { run_id: entry.run_id });
    // (a) red when advance_run is not named, or leaves the guard or an automatic step unrun;
    //     (b) prints what each said.
    expect({
      named: tools({ next_actions: entry.next_actions }),
      ran: (r['chained_auto_steps'] as Array<{ step: string }>).map((c) => c.step),
      phase: r['run_phase'],
      completed: state['completed_steps'],
    }).toEqual({
      named: ['advance_run'],
      ran: ['read', 'check', 'ship'],
      phase: 'completed',
      completed: ['read', 'check', 'ship'],
    });
  });

  it('connect-an-mcp-client.md: after a gate is answered, the auto steps that follow do not start by themselves', async () => {
    claim(
      'docs/guides/connect-an-mcp-client.md',
      'The `auto` steps that follow do not start by themselves.',
    );
    const { call, workflowStore, runStore } = await connect();
    await workflowStore.register(
      wf([
        'id: ann',
        'name: ann',
        'version: 1',
        'steps:',
        '  review:',
        '    description: Review.',
        '    execution: auto',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [send, discard]',
        '  send:',
        '    description: Send.',
        '    execution: auto',
        '    depends_on: [review]',
      ]),
    );
    const runId = (await call('start_run', { workflow_id: 'ann' }))['run_id'] as string;
    const gateId = (await runStore.get(runId)).pending_gate!.gate_id;
    const r = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'send',
    });
    const after = await runStore.get(runId);
    // (a) red when the answer's call runs `send` itself; (b) prints the reply and the steps.
    expect([r['run_phase'], after.completed_steps, after.in_progress_steps]).toEqual([
      'running',
      ['review'],
      [],
    ]);
  });

  it('human-gates.md: a step behind the open gate is refused with the question it waits on, and next_actions holds the answer', async () => {
    const page = 'docs/guides/human-gates.md';
    claim(page, 'Its `next_actions` holds that answer, `submit_human_response`.');
    const text = readFileSync(join(ROOT, page), 'utf8');
    const yaml = text.slice(
      text.indexOf('```yaml\n') + 8,
      text.indexOf('\n```', text.indexOf('```yaml\n')),
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(loadWorkflowFromString(yaml));
    const runId = (await call('start_run', { workflow_id: 'announce' }))['run_id'] as string;
    const opened = await call('execute_step', {
      run_id: runId,
      command: 'draft',
      params: { subject: 'Office closed Friday', body: 'The office is closed this Friday.' },
    });
    expect(opened['status'], 'fixture: the draft opens the gate').toBe('confirm_required');
    const r = await call('execute_step', { run_id: runId, command: 'send', params: {} });
    // (a) red when the refusal is not the page's two lines, or next_actions holds anything but
    //     the answer; (b) prints both.
    expect([`status: ${String(r['status'])}`, String(r['context_hint'])]).toEqual(
      block(page, "Step 'send' cannot be called now:"),
    );
    expect(tools(r)).toEqual(['submit_human_response']);
  });

  it('idempotency-and-batches.md: a repeat with the same key returns the run and says what comes next, as the first reply did', async () => {
    const page = 'docs/guides/idempotency-and-batches.md';
    claim(
      page,
      "The caller can carry on with that run as if it had started it: the reply also says what comes next for it, as the first one did (here, `sync`'s first step, `fetch`, is ready for the assistant).",
    );
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf([
        'id: sync',
        'name: sync',
        'version: 1',
        'steps:',
        '  fetch:',
        '    description: Fetch.',
        '    execution: agent',
      ]),
    );
    const args = { workflow_id: 'sync', params: {}, idempotency_key: 'order-4417' };
    const first = await call('start_run', args);
    const again = await call('start_run', args);
    const runId = first['run_id'] as string;
    // (a) red when the repeat's lines are not the page's (the run ID aside); (b) prints both.
    expect([
      `status: ${String(again['status'])}`,
      `deduped: ${String(again['deduped'])}`,
      `run_id: ${String(again['run_id'])}`,
      String(again['context_hint']),
    ]).toEqual(
      block(page, 'deduped: true').map((l) =>
        l.replaceAll('6c48086c-cb0f-47ea-9c33-6279fe42ffdc', runId),
      ),
    );
    // (a) red when the repeat's next call is not the first reply's (`fetch`); (b) prints both.
    expect([nextCall(again), again['next_actions']]).toEqual([
      'execute_step fetch',
      first['next_actions'],
    ]);
  });

  it('step-handlers.md: a handler that is not registered — the block is in start_run’s warnings and in the hint of advance_run and execute_step when they attempt the step', async () => {
    const page = 'docs/guides/step-handlers.md';
    claim(
      page,
      "- **`Step 'total' is blocked: its handler 'order_totl' is not registered in this runner.`** (on the MCP reply of the call that attempted the step: its `context_hint` for `advance_run` and `execute_step`, its `warnings` for `start_run`; `realm agent` prints `⚠ Step 'total' is blocked: handler 'order_totl' is not registered in this runner. The run is NOT failed — add handler 'order_totl' and re-attach (…)`).",
    );
    claim(page, 'The `handler` name on the step does not match a key in your `handlers` map.');
    const sentence =
      "Step 'total' is blocked: its handler 'order_totl' is not registered in this runner.";
    // The `handlers` map has `order_total`; the step names `order_totl`.
    const registry = createDefaultRegistry();
    registry.register('handler', 'order_total', {
      async execute() {
        return { data: { total: 50 } };
      },
    } as never);
    const { call, workflowStore, runStore } = await connect(registry);
    await workflowStore.register(
      wf([
        'id: price',
        'name: price',
        'version: 1',
        'steps:',
        '  total:',
        '    description: Work out the order total.',
        '    execution: auto',
        '    handler: order_totl',
        '  confirm:',
        '    description: Say whether the total looks right.',
        '    execution: agent',
        '    depends_on: [total]',
      ]),
    );
    const s = await call('start_run', { workflow_id: 'price', params: { quantity: 4 } });
    const e = await call('execute_step', {
      run_id: s['run_id'] as string,
      command: 'total',
      params: {},
    });
    // advance_run attempts the step on a run nothing has attempted it on yet (a batch run).
    const batch = await call('start_run_batch', {
      workflow_id: 'price',
      items: [{ params: { quantity: 4 } }],
    });
    const batchId = (batch['started'] as Array<{ run_id: string }>)[0]!.run_id;
    const a = await call('advance_run', { run_id: batchId });
    const record = await runStore.get(s['run_id'] as string);
    // (a) red when start_run refuses or leaves the block out of warnings, a hint leaves it out,
    //     or the run is failed; (b) prints what each said.
    expect({
      start: [s['status'], ((s['warnings'] as string[]) ?? []).some((w) => w.startsWith(sentence))],
      execute: String(e['context_hint']).startsWith(sentence),
      advance: String(a['context_hint']).startsWith(sentence),
      phase: [record.run_phase, record.failed_steps],
    }).toEqual({
      start: ['ok', true],
      execute: true,
      advance: true,
      phase: ['running', []],
    });
  });

  it('step-fields.md: a guard is never called by name — execute_step on it is refused, ready or decided', async () => {
    claim('docs/reference/workflow/step-fields.md', 'A guard is never called by name.');
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf([
        'id: gname',
        'name: gname',
        'version: 1',
        'steps:',
        '  read:',
        '    description: Read.',
        '    execution: auto',
        '  check:',
        '    description: Check.',
        '    execution: guard',
        '    depends_on: [read]',
        '    abort_unless: ["read.live == true"]',
        '  ship:',
        '    description: Ship.',
        '    execution: agent',
        '    depends_on: [check]',
      ]),
    );
    // Ready and not yet decided: a batch run, after `read` has run by name.
    const batch = await call('start_run_batch', {
      workflow_id: 'gname',
      items: [{ params: { live: true } }],
    });
    const id = (batch['started'] as Array<{ run_id: string }>)[0]!.run_id;
    const ready = await call('execute_step', { run_id: id, command: 'check', params: {} });
    // Decided: start_run runs `read`, and the write that makes the guard ready decides it.
    const s = await call('start_run', { workflow_id: 'gname', params: { live: true } });
    const decided = await call('execute_step', {
      run_id: s['run_id'] as string,
      command: 'check',
      params: {},
    });
    // (a) red when execute_step decides or runs the guard; (b) prints both replies.
    expect([
      [
        ready['status'],
        String(ready['context_hint']).startsWith("Step 'check' cannot be called now:"),
      ],
      [
        decided['status'],
        String(decided['context_hint']).startsWith("Step 'check' cannot be called now:"),
      ],
    ]).toEqual([
      ['blocked', true],
      ['blocked', true],
    ]);
  });

  it('top-level-fields.md: the opening instruction without protocol, and the five standard rules', async () => {
    const page = 'docs/reference/workflow/top-level-fields.md';
    claim(page, 'and the five standard rules are:');
    const opening = block(page, "Call start_run with workflow_id 'review-note'.")[0]!;
    const rules = block(page, 'Follow the next_action instruction');
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf([
        'id: review-note',
        'name: review-note',
        'version: 1',
        'steps:',
        '  a:',
        '    description: A.',
        '    execution: agent',
      ]),
    );
    const p = await call('get_workflow_protocol', { workflow_id: 'review-note' });
    // (a) red when the opening instruction or the five rules are not the page's; (b) prints both.
    expect([p['quick_start'], (p['rules'] as string[]).slice(0, 5)]).toEqual([opening, rules]);
    expect(rules).toHaveLength(5);
  });

  it('top-level-fields.md: rules replaces the five standard rules; two rules about concurrent attempts follow yours', async () => {
    const page = 'docs/reference/workflow/top-level-fields.md';
    claim(
      page,
      '| `rules` | list of strings | Replaces the five standard rules. Two rules about concurrent attempts are always added after yours. |',
    );
    const standard = block(page, 'Follow the next_action instruction');
    const { call, workflowStore } = await connect();
    await workflowStore.register(
      wf([
        'id: own-rules',
        'name: own-rules',
        'version: 1',
        'protocol:',
        '  rules:',
        '    - Never state a fact that is not in the note.',
        'steps:',
        '  a:',
        '    description: A.',
        '    execution: agent',
      ]),
    );
    const got = (await call('get_workflow_protocol', { workflow_id: 'own-rules' }))[
      'rules'
    ] as string[];
    // (a) red when a standard rule survives, the workflow's rule is not first, or the two added
    //     rules are not there; (b) prints the rules.
    expect({
      first: got[0],
      count: got.length,
      standardLeft: got.filter((r) => standard.includes(r)),
      attempts: got.slice(1).every((r) => /attempt/.test(r)),
    }).toEqual({
      first: 'Never state a fact that is not in the note.',
      count: 3,
      standardLeft: [],
      attempts: true,
    });
  });

  it('run-record-and-export.md: output_source — on a bare auto step’s entry only, from the four sources', async () => {
    claim(
      'docs/reference/run-record-and-export.md',
      "| `output_source` | text | No | On a bare `auto` step's entry only, where its output came from: `driven_step` (the output the caller that named the step gave), `dependency` (its one `depends_on` step's output), `run_params` (the run's params; it has no `depends_on`) or `none` (`{}`).",
    );
    const registry = createDefaultRegistry();
    registry.register('handler', 'count', {
      async execute() {
        return { data: { n: 1 } };
      },
    } as never);
    const { call, workflowStore, runStore } = await connect(registry);
    await workflowStore.register(
      wf([
        'id: sources',
        'name: sources',
        'version: 1',
        'steps:',
        '  a:',
        '    description: A.',
        '    execution: agent',
        '  b:',
        '    description: B.',
        '    execution: agent',
        '  from_params:',
        '    description: From the params.',
        '    execution: auto',
        '  from_dep:',
        '    description: From its dependency.',
        '    execution: auto',
        '    depends_on: [a]',
        '  from_none:',
        '    description: Two dependencies.',
        '    execution: auto',
        '    depends_on: [a, b]',
        '  counted:',
        '    description: A handler step.',
        '    execution: auto',
        '    handler: count',
      ]),
    );
    // A batch run runs no step, so the caller can name the bare `from_params` itself.
    const batch = await call('start_run_batch', {
      workflow_id: 'sources',
      items: [{ params: { p: 1 } }],
    });
    const named = (batch['started'] as Array<{ run_id: string }>)[0]!.run_id;
    await call('execute_step', { run_id: named, command: 'from_params', params: { given: 2 } });
    // start_run runs the owed bare steps itself; the answers to `a` and `b` let the engine run the rest.
    const s = await call('start_run', { workflow_id: 'sources', params: { p: 1 } });
    const runId = s['run_id'] as string;
    await call('execute_step', { run_id: runId, command: 'a', params: { fromA: 3 } });
    await call('execute_step', { run_id: runId, command: 'b', params: { fromB: 4 } });
    const of = (rec: { evidence: ReadonlyArray<object> }) =>
      Object.fromEntries(
        (rec.evidence as Array<Record<string, unknown>>).map((e) => [
          e['step_id'],
          [e['output_source'] ?? null, e['output_summary']],
        ]),
      );
    // (a) red when a source is recorded wrong, its output is not the one the page names, or an
    //     agent or handler step's entry carries the field; (b) prints the entries.
    expect([of(await runStore.get(named))['from_params'], of(await runStore.get(runId))]).toEqual([
      ['driven_step', { given: 2 }],
      {
        from_params: ['run_params', { p: 1 }],
        counted: [null, { n: 1 }],
        a: [null, { fromA: 3 }],
        from_dep: ['dependency', { fromA: 3 }],
        b: [null, { fromB: 4 }],
        from_none: ['none', {}],
      },
    ]);
  });

  it('error-codes.md: 87 codes defined — 72 raised, 15 that nothing raises', () => {
    claim(
      'docs/reference/error-codes.md',
      'This page lists all 87 codes that Realm defines: the 72 it raises, with when each is raised and what it tells the caller to do, and the 15 that nothing raises.',
    );
    const types = readFileSync(join(ROOT, 'packages/core/src/types/workflow-error.ts'), 'utf8');
    const lines = types.slice(types.indexOf('export type ErrorCode')).split('\n');
    const end = lines.findIndex((l) => /^\s*\| '[A-Z0-9_]+';/.test(l));
    const defined = lines
      .slice(0, end + 1)
      .map((l) => /^\s*\| '([A-Z0-9_]+)'/.exec(l)?.[1])
      .filter((c): c is string => c !== undefined);
    const text = readFileSync(join(ROOT, 'docs/reference/error-codes.md'), 'utf8');
    const raisedPart = text.slice(
      text.indexOf('## The codes Realm raises'),
      text.indexOf('## The codes nothing raises'),
    );
    const listedRaised = [...raisedPart.matchAll(/^\| `([A-Z0-9_]+)` +\|/gm)].map((m) => m[1]!);
    const listedUnraised = block('docs/reference/error-codes.md', 'NETWORK_TIMEOUT, ')
      .join(' ')
      .split(/[,\s]+/)
      .filter((c) => c !== '');
    // Realm's own code, every file but tests and the type itself: where a code is written in it.
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== 'node_modules' && name !== 'test-support') walk(path);
        } else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) {
          if (!path.endsWith(join('types', 'workflow-error.ts')))
            sources.push(readFileSync(path, 'utf8'));
        }
      }
    };
    for (const pkg of readdirSync(join(ROOT, 'packages'))) {
      const src = join(ROOT, 'packages', pkg, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // a package with no src
      }
    }
    const written = (code: string) => sources.some((s) => s.includes(`'${code}'`));
    // (a) red when a code is added to the type without the page, the page's two lists stop
    //     covering the type, a code the page says nothing raises is written in Realm's code, or a
    //     code it says is raised is written nowhere; (b) prints the counts and the strays.
    expect({
      defined: defined.length,
      raised: listedRaised.length,
      unraised: listedUnraised.length,
      cover: [...listedRaised, ...listedUnraised].sort(),
      unraisedWritten: listedUnraised.filter(written),
      raisedNowhere: listedRaised.filter((c) => !written(c)),
    }).toEqual({
      defined: 87,
      raised: 72,
      unraised: 15,
      cover: [...defined].sort(),
      unraisedWritten: [],
      raisedNowhere: [],
    });
  });

  it('error-codes.md: VALIDATION_CALLER_INVALID — each of the five functions given a caller not its own; nothing read or written', async () => {
    const page = 'docs/reference/error-codes.md';
    claim(
      page,
      "A program passed `advanceRun`, `executeStep`, `executeChain`, `submitHumanResponse` or `executeEngineStep` a `caller` that is not one of that function's own words (see [Core library](core-library.md)).",
    );
    claim(page, 'Nothing was read or written. Added after version 0.46.0.');
    const dir = await mkdtemp(join(tmpdir(), 'realm-pages-625-e2-lib-'));
    const store = new JsonFileStore(dir);
    const def = wf([
      'id: lib',
      'name: lib',
      'version: 1',
      'steps:',
      '  a:',
      '    description: A.',
      '    execution: agent',
      '  go:',
      '    description: Go.',
      '    execution: auto',
      '    depends_on: [a]',
    ]);
    const { run } = await store.create({ workflowId: 'lib', workflowVersion: 1, params: {} });
    const before = JSON.stringify(await store.get(run.id));
    const bad = { caller: 'not-a-caller' } as never;
    const dispatcher = async () => ({});
    // A run that does not exist: had the call read the store, it would say STATE_RUN_NOT_FOUND.
    const calls: Array<[string, (runId: string) => Promise<unknown>]> = [
      ['advanceRun', (runId) => advanceRun(store, def, { runId, ...(bad as object) })],
      [
        'executeStep',
        (runId) =>
          executeStep(store, def, {
            runId,
            command: 'a',
            input: {},
            dispatcher,
            ...(bad as object),
          }),
      ],
      [
        'executeChain',
        (runId) =>
          executeChain(store, def, {
            runId,
            command: 'a',
            input: {},
            dispatcher,
            ...(bad as object),
          }),
      ],
      [
        'submitHumanResponse',
        (runId) =>
          submitHumanResponse(store, def, { runId, gateId: 'g', choice: 'x', ...(bad as object) }),
      ],
      [
        'executeEngineStep',
        async (runId) =>
          executeEngineStep(store, def, {
            runId,
            step: 'go',
            run: await store.get(run.id),
            ...(bad as object),
          }),
      ],
    ];
    const codes: Record<string, unknown[]> = {};
    for (const [name, fn] of calls) {
      const outcome: unknown[] = [];
      for (const runId of [run.id, 'no-such-run-625-e2']) {
        try {
          const r = (await fn(runId)) as { error_code?: string };
          outcome.push(`replied ${String(r.error_code)}`);
        } catch (err) {
          outcome.push((err as { code?: string }).code);
        }
      }
      codes[name] = outcome;
    }
    const allRefused = ['VALIDATION_CALLER_INVALID', 'VALIDATION_CALLER_INVALID'];
    // (a) red when a function accepts a word not its own, raises another code, reads the store
    //     first (STATE_RUN_NOT_FOUND on the missing run) or writes the record; (b) prints each.
    expect([codes, JSON.stringify(await store.get(run.id)) === before]).toEqual([
      {
        advanceRun: allRefused,
        executeStep: allRefused,
        executeChain: allRefused,
        submitHumanResponse: allRefused,
        executeEngineStep: allRefused,
      },
      true,
    ]);
  });

  it('packages/core/README.md: next_actions[0] names the next step; when it names advance_run, call advanceRun — repeat until next_actions is empty', async () => {
    claim(
      'packages/core/README.md',
      '// response.next_actions[0] carries the next step to execute; when it names advance_run, call advanceRun —\n// repeat until next_actions is empty',
    );
    const dir = await mkdtemp(join(tmpdir(), 'realm-pages-625-e2-readme-'));
    const store = new JsonFileStore(dir);
    const def = wf([
      'id: readme',
      'name: readme',
      'version: 1',
      'steps:',
      '  my_step:',
      '    description: Answer.',
      '    execution: agent',
      '  publish:',
      '    description: Publish.',
      '    execution: auto',
      '    depends_on: [my_step]',
      '  last:',
      '    description: Last.',
      '    execution: agent',
      '    depends_on: [publish]',
    ]);
    // A program's own run: nothing runs the engine's step until advanceRun is called.
    const { run } = await store.create({
      workflowId: def.id,
      workflowVersion: def.version,
      params: { input: 'hello' },
    });
    const seen: string[] = [];
    let response = (await executeStep(store, def, {
      runId: run.id,
      command: 'my_step',
      input: { answer: 'done' },
      dispatcher: async (_stepName, stepInput) => stepInput,
    })) as { next_actions: Array<{ instruction?: { tool?: string; params?: Reply } }> };
    for (let i = 0; i < 5 && response.next_actions.length > 0; i++) {
      const next = response.next_actions[0]!.instruction!;
      seen.push(next.tool === 'advance_run' ? 'advance_run' : String(next.params?.['command']));
      response = (
        next.tool === 'advance_run'
          ? await advanceRun(store, def, { runId: run.id })
          : await executeStep(store, def, {
              runId: run.id,
              command: String(next.params?.['command']),
              input: {},
              dispatcher: async (_stepName, stepInput) => stepInput,
            })
      ) as typeof response;
    }
    // (a) red when next_actions[0] does not name advance_run while the engine owes `publish`, or
    //     the loop does not end the run with next_actions empty; (b) prints the calls made.
    expect([seen, (await store.get(run.id)).run_phase, response.next_actions]).toEqual([
      ['advance_run', 'last'],
      'completed',
      [],
    ]);
  });
});
